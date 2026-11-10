import {readFileSync} from 'node:fs';

const officialAreas = JSON.parse(readFileSync(new URL('./areas.geojson',import.meta.url),'utf8'));
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const realPlaceId = id => typeof id==='string' && id.length>0 && id.length<=512 && !id.startsWith('demo-');
function failure(message, status=503) {
  const error=new Error(message);
  error.status=status;
  error.code=status===422?'SHIPPING_ADDRESS_UNVERIFIED':'SHIPPING_PROVIDER_UNAVAILABLE';
  return error;
}

// Classify strict interior only. A point within 10m of any boundary has no promotional area.
function ringContains(ring, x, y) {
  if (!Array.isArray(ring) || ring.length<4) return false;
  let inside=false;
  const scaleX=111320*Math.cos(y*Math.PI/180),scaleY=111320;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const [ax,ay]=ring[j], [bx,by]=ring[i];
    if (![ax,ay,bx,by].every(Number.isFinite) || Math.abs(ax)>180 || Math.abs(ay)>90) return false;
    const vx=(bx-ax)*scaleX,vy=(by-ay)*scaleY;
    const px=(x-ax)*scaleX,py=(y-ay)*scaleY;
    const length=vx*vx+vy*vy;
    const t=length?Math.max(0,Math.min(1,(px*vx+py*vy)/length)):0;
    if (Math.hypot(px-t*vx,py-t*vy)<=10) return null;
    if ((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax) inside=!inside;
  }
  return inside;
}

function areaAt(areas, longitude, latitude) {
  const entries=Array.isArray(areas)?areas:(areas?.features || []).map(f=>({...f.properties,geometry:f.geometry}));
  const matches=[];
  for(const area of entries) {
    if (area.country!=='UY' || normalize(area.city)!=='montevideo') continue;
    const polygons=area.geometry?.type==='Polygon'?[area.geometry.coordinates]:area.geometry?.type==='MultiPolygon'?area.geometry.coordinates:[];
    for(const polygon of polygons) {
      const outer=ringContains(polygon[0],longitude,latitude);
      if (outer===null) return null;
      if (!outer) continue;
      let hole=false;
      for(const ring of polygon.slice(1)) {
        const classification=ringContains(ring,longitude,latitude);
        if (classification===null) return null;
        if (classification) hole=true;
      }
      if (!hole) {matches.push(area.id);break;}
    }
  }
  return matches.length===1?matches[0]:null;
}

export function createGoogleProvider({apiKey, fetchImpl=globalThis.fetch, areas=officialAreas, timeoutMs=8000}={}) {
  if (typeof apiKey!=='string' || !apiKey.trim() || typeof fetchImpl!=='function'
    || !Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>8000) throw failure('Google Maps configuration is required');
  async function request(url, init={}) {
    const controller=new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async()=>{
          const response=await fetchImpl(url,{...init,signal:controller.signal});
          if(!response.ok) throw failure('Google Maps request failed');
          return await response.json();
        })(),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('Google Maps timeout'));},timeoutMs);})
      ]);
    } catch(error) {
      if (error.code==='SHIPPING_PROVIDER_UNAVAILABLE') throw error;
      throw failure('Google Maps request failed');
    } finally {clearTimeout(timer);}
  }
  return {
    mode:'google',
    async resolveAddress(inputAddress) {
      if (typeof inputAddress!=='string' || inputAddress.trim().length<5 || inputAddress.length>300) throw failure('Enter a complete Montevideo street address',422);
      const url=new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.search=new URLSearchParams({address:inputAddress.trim(),components:'country:UY|locality:Montevideo',language:'es',key:apiKey}).toString();
      const data=await request(url.toString());
      if (!['OK','ZERO_RESULTS'].includes(data.status)) throw failure('Google Maps address service unavailable');
      if (data.status!=='OK' || !Array.isArray(data.results) || data.results.length!==1) throw failure('Address is missing or ambiguous; clarify the street and number',422);
      const result=data.results[0];
      const component=type=>(result.address_components || []).find(c=>c.types?.includes(type));
      const location=result.geometry?.location;
      if (result.partial_match || !realPlaceId(result.place_id) || typeof result.formatted_address!=='string'
        || component('country')?.short_name!=='UY'
        || normalize(component('locality')?.long_name)!=='montevideo'
        || !component('street_number') || !component('route')
        || !result.types?.some(type=>['street_address','premise','subpremise'].includes(type))
        || result.geometry?.location_type!=='ROOFTOP'
        || !Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)
        || location.lat < -35.1 || location.lat > -34.7 || location.lng < -56.5 || location.lng > -55.8) {
        throw failure('Address needs a precise street number in Montevideo',422);
      }
      return {id:null,inputAddress:inputAddress.trim(),formattedAddress:result.formatted_address,placeId:result.place_id,
        areaId:areaAt(areas,location.lng,location.lat),provider:'google',confirmed:false};
    },
    async computeRoute({originPlaceId,stopPlaceIds,departureAt}) {
      if (!realPlaceId(originPlaceId) || !Array.isArray(stopPlaceIds) || !stopPlaceIds.length || stopPlaceIds.length>10
        || stopPlaceIds.some(id=>!realPlaceId(id)) || !Number.isFinite(Date.parse(departureAt))) throw failure('Invalid real route',422);
      const data=await request('https://routes.googleapis.com/directions/v2:computeRoutes',{
        method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':apiKey,'X-Goog-FieldMask':'routes.distanceMeters,routes.duration'},
        body:JSON.stringify({origin:{placeId:originPlaceId},destination:{placeId:originPlaceId},
          intermediates:stopPlaceIds.map(placeId=>({placeId})),travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE',
          departureTime:new Date(departureAt).toISOString(),computeAlternativeRoutes:false,optimizeWaypointOrder:false,languageCode:'es',units:'METRIC'})
      });
      const route=data.routes?.length===1?data.routes[0]:null;
      if (!route || !Number.isSafeInteger(route.distanceMeters) || route.distanceMeters<0
        || typeof route.duration!=='string' || !/^\d+(?:\.\d+)?s$/.test(route.duration)) throw failure('Google Maps returned no reliable route');
      const durationSeconds=Number(route.duration.slice(0,-1));
      if (!Number.isFinite(durationSeconds) || durationSeconds<=0) throw failure('Google Maps returned no reliable route duration');
      return {distanceMeters:route.distanceMeters,durationSeconds};
    }
  };
}
