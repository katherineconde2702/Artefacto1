import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGoogleProvider} from '../src/shipping/google.mjs';
const areas=JSON.parse(readFileSync(new URL('../src/shipping/areas.geojson',import.meta.url),'utf8'));
const result=()=>({address_components:[
  {long_name:'1234',short_name:'1234',types:['street_number']},
  {long_name:'Avenida 18 de Julio',short_name:'Av. 18 de Julio',types:['route']},
  {long_name:'Montevideo',short_name:'Montevideo',types:['locality','political']},
  {long_name:'Montevideo',short_name:'Montevideo',types:['administrative_area_level_1','political']},
  {long_name:'Uruguay',short_name:'UY',types:['country','political']}],
  formatted_address:'Av. 18 de Julio 1234, Montevideo, Uruguay',
  geometry:{location:{lat:-34.9059,lng:-56.1908},location_type:'ROOFTOP',viewport:{northeast:{lat:-34.904,lng:-56.189},southwest:{lat:-34.907,lng:-56.192}}},
  place_id:'google-fixture-centro',types:['street_address']});
const response=data=>({ok:true,status:200,json:async()=>data});

// The HTTP boundary is the sole double: the provider's filtering and geometry run for real.
test('geocoding restricts Uruguay and Montevideo, verifies official geometry, and requires buyer confirmation',async()=>{
  let requested;
  const provider=createGoogleProvider({apiKey:'test-key',areas,fetchImpl:async(url,init)=>{
    requested={url:new URL(url),init};return response({status:'OK',results:[result()]});
  }});
  const address=await provider.resolveAddress('18 de Julio 1234');
  assert.equal(requested.url.origin,'https://maps.googleapis.com');
  assert.equal(requested.url.searchParams.get('components'),'country:UY|locality:Montevideo');
  assert.equal(address.areaId,'centro');
  assert.equal(address.provider,'google');
  assert.equal(address.confirmed,false);
  assert.equal(address.placeId,'google-fixture-centro');
  assert.equal(address.geometry,undefined);
  assert.equal(address.address_components,undefined);
});

test('partial, ambiguous, non-Montevideo and imprecise Google results fail closed',async()=>{
  const candidates=[{...result(),partial_match:true},
    {...result(),address_components:result().address_components.map(c=>c.types.includes('country')?{...c,short_name:'AR'}:c)},
    {...result(),address_components:result().address_components.filter(c=>!c.types.includes('locality'))},
    {...result(),geometry:{...result().geometry,location_type:'APPROXIMATE'}},
    {...result(),types:['locality','political']},
    {...result(),place_id:'demo-centro'}];
  for(const candidate of candidates){
    const provider=createGoogleProvider({apiKey:'test-key',areas,fetchImpl:async()=>response({status:'OK',results:[candidate]})});
    await assert.rejects(provider.resolveAddress('18 de Julio 1234'));
  }
  for(const data of [{status:'OK',results:[result(),result()]},{status:'ZERO_RESULTS',results:[]},{status:'REQUEST_DENIED',error_message:'sensitive upstream details'}]){
    const provider=createGoogleProvider({apiKey:'test-key',fetchImpl:async()=>response(data)});
    await assert.rejects(provider.resolveAddress('18 de Julio 1234'),error=>!error.message.includes('sensitive'));
  }
});

test('no geometry or a point on an official area boundary never assigns a promotional neighborhood',async()=>{
  const vertex=areas.features[0].geometry.coordinates[0][0][0];
  const boundary={...result(),geometry:{...result().geometry,location:{lng:vertex[0],lat:vertex[1]}}};
  for(const [configuredAreas,candidate] of [[[],result()],[areas,boundary]]){
    const provider=createGoogleProvider({apiKey:'test-key',areas:configuredAreas,fetchImpl:async()=>response({status:'OK',results:[candidate]})});
    assert.equal((await provider.resolveAddress('18 de Julio 1234')).areaId,null);
  }
});

test('Routes requests a round trip in committed stop order and only distance and duration',async()=>{
  let request;
  const provider=createGoogleProvider({apiKey:'test-key',fetchImpl:async(url,init)=>{
    request={url,init,body:JSON.parse(init.body)};
    return response({routes:[{distanceMeters:12500,duration:'1800.5s'}]});
  }});
  const metrics=await provider.computeRoute({originPlaceId:'merchant-origin',stopPlaceIds:['first-stop','second-stop'],departureAt:'2026-11-01T13:00:00Z'});
  assert.deepEqual(metrics,{distanceMeters:12500,durationSeconds:1800.5});
  assert.equal(request.url,'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.equal(request.init.method,'POST');
  assert.equal(request.init.headers['X-Goog-Api-Key'],'test-key');
  assert.equal(request.init.headers['X-Goog-FieldMask'],'routes.distanceMeters,routes.duration');
  assert.deepEqual(request.body.origin,{placeId:'merchant-origin'});
  assert.deepEqual(request.body.destination,{placeId:'merchant-origin'});
  assert.deepEqual(request.body.intermediates,[{placeId:'first-stop'},{placeId:'second-stop'}]);
  assert.equal(request.body.optimizeWaypointOrder,false);
});

test('missing key, demo ids, malformed routes, HTTP failures and timeout never return invented metrics',async()=>{
  assert.throws(()=>createGoogleProvider({apiKey:''}));
  const input={originPlaceId:'origin',stopPlaceIds:['target'],departureAt:'2026-11-01T13:00:00Z'};
  const invalid=[{routes:[]},{routes:[{distanceMeters:-1,duration:'1s'}]},
    {routes:[{distanceMeters:10,duration:'not-a-duration'}]},{routes:[{distanceMeters:10,duration:'0s'}]}];
  for(const data of invalid){
    const provider=createGoogleProvider({apiKey:'test-key',fetchImpl:async()=>response(data)});
    await assert.rejects(provider.computeRoute(input));
  }
  const provider=createGoogleProvider({apiKey:'test-key',fetchImpl:async()=>({ok:false,status:403})});
  await assert.rejects(provider.computeRoute(input),error=>!error.message.includes('test-key'));
  await assert.rejects(provider.computeRoute({...input,originPlaceId:'demo-centro'}));
  const stalled=createGoogleProvider({apiKey:'test-key',timeoutMs:10,fetchImpl:async()=>new Promise(()=>{})});
  await assert.rejects(stalled.computeRoute(input),/timeout/i);
});
