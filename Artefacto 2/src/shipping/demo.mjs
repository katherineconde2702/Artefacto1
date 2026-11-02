// Public neighborhood centers only. Distances/times below are simulated, never Google data.
const places = {
  'demo-centro':{areaId:'centro',name:'Centro',label:'Plaza Cagancha, Centro, Montevideo (demo)'},
  'demo-pocitos':{areaId:'pocitos',name:'Pocitos',label:'Plaza Gomensoro, Pocitos, Montevideo (demo)'},
  'demo-malvin':{areaId:'malvin',name:'Malvín',label:'Plaza de los Olímpicos, Malvín, Montevideo (demo)'}
};
const links = {'demo-centro|demo-pocitos':[6000,1200],'demo-centro|demo-malvin':[11000,2100],'demo-malvin|demo-pocitos':[5000,1000]};
const clean = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();

export function createDemoState(now = new Date()) {
  const local = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Montevideo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const days = Array.from({length:3},(_,index)=>({deliveryDate:new Date(Date.parse(`${local}T12:00:00Z`)+(index+1)*86400000).toISOString().slice(0,10),
    enabled:true,departureTime:'10:00',capacity:10,maxDurationSeconds:14400,version:1}));
  const routes = days.slice(1).map((day,index)=>({id:`demo-route-${index+1}`,deliveryDate:day.deliveryDate,
    departureAt:`${day.deliveryDate}T10:00:00-03:00`,capacity:10,maxDurationSeconds:14400,version:1,
    stops:Array.from({length:index+1},(_,i)=>({shipmentId:`demo-shipment-${index+1}-${i+1}`,placeId:i?'demo-malvin':'demo-pocitos',
      label:places[i?'demo-malvin':'demo-pocitos'].label,priceMinor:40000,status:'confirmed',demo:true}))}));
  return {mode:'demo',merchant:{id:'marea',name:'MAREA',currency:'UYU',originPlaceId:'demo-centro'},
    policy:{id:'demo-policy-1',version:1,minimumMinor:14900,fuelPriceMinorPerLiter:9045,fuelLitersPer100Km:3,laborMinorPerHour:25000,
      serviceMinutes:5,marginBps:1500,roundingMinor:100,quoteMinutes:5,holdMinutes:15},
    prices:{'soft-knit-sweater':279000,'relaxed-linen-blazer':479000,'fluid-silk-blouse':359000,'ribbed-midi-dress':379000,'wide-leg-trousers':319000,'soft-crop-cardigan':259000},
    areas:Object.entries(places).map(([,p])=>({id:p.areaId,name:p.name,country:'UY',city:'Montevideo',demo:true})),
    days,routes,shipments:routes.flatMap(route=>route.stops.map(stop=>({...stop,id:stop.shipmentId,routeId:route.id,deliveryDate:route.deliveryDate,mode:'demo',demo:true}))),
    promotions:[{id:'demo-promotion-malvin',areaId:'malvin',deliveryDate:days[2].deliveryDate,priceMinor:14900,active:true,version:1}]};
}

export function createDemoProvider() {
  return {
    mode:'demo',
    async resolveAddress(inputAddress) {
      const entry=Object.entries(places).find(([id,p])=>[id,p.areaId,p.name,p.label].some(value=>clean(value)===clean(inputAddress)));
      if (!entry) throw new Error('Seleccione Centro, Pocitos o Malvín para la dirección demo');
      const [placeId,place]=entry;
      return {id:null,inputAddress,formattedAddress:place.label,placeId,areaId:place.areaId,provider:'demo',confirmed:false,demo:true};
    },
    async computeRoute({originPlaceId,stopPlaceIds}) {
      if (!places[originPlaceId] || !Array.isArray(stopPlaceIds) || stopPlaceIds.length>10 || stopPlaceIds.some(id=>!places[id])) throw new Error('Invalid demo route');
      let distanceMeters=0,durationSeconds=0;
      const tour=[originPlaceId,...stopPlaceIds,originPlaceId];
      for(let i=1;i<tour.length;i++) {
        if(tour[i]===tour[i-1]) continue;
        const [distance,duration]=links[[tour[i-1],tour[i]].sort().join('|')];
        distanceMeters+=distance;durationSeconds+=duration;
      }
      return {distanceMeters,durationSeconds};
    }
  };
}
