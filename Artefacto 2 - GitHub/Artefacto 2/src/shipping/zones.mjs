import { departments, zones } from '../../public/store/uy-geography.js';
import { createDemoState } from './demo.mjs';
import {chooseDiscountRule,calculateZonePrice,validateDeliveryWindow} from '../../public/shipping-admin/rules.js';

const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const zoneById = new Map(zones.map(zone => [zone.id,zone]));
const departmentById = new Map(departments.map(department => [department.id,department]));
const dateInMontevideo = date => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Montevideo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const calendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;
const zonePlace = placeId => typeof placeId === 'string' && placeId.startsWith('zone:') && zoneById.has(placeId.slice(5));

/** Resolves a selected catalog area, not a street address or a verified delivery location. */
export function resolveZone(areaId) {
  const zone = zoneById.get(areaId);
  if (!zone) throw new Error('Unknown shipping zone');
  const department = departmentById.get(zone.departmentId);
  const label = zone.kind === 'department' ? `${department.name}, Uruguay` : `${zone.name}, ${department.name}, Uruguay`;
  return {id:null,areaId:zone.id,departmentId:zone.departmentId,inputAddress:label,formattedAddress:label,label,
    placeId:`zone:${zone.id}`,provider:'zones',confirmed:false};
}

/** Explicitly transient demo fixtures. Example prices are never a source of live commercial rates. */
export function createZoneDemoState(now = new Date()) {
  const state = createDemoState(now);
  state.pricingMode = 'zones';
  state.departments = departments.map(department => ({...department}));
  state.areas = zones.map(zone => ({...zone,country:'UY',demo:true}));
  state.zoneRates = zones.map(zone => ({areaId:zone.id,priceMinor:zone.departmentId === 'montevideo' ? 24900 : 39900,enabled:true,version:1,demo:true}));
  state.routes = [];
  state.shipments = [];
  return state;
}

/** Optional, explicitly local sample operation for the B2B sales demo. */
export function createB2BDemoState(now=new Date()){
  const state=createZoneDemoState(now);state.discountRules=[{areaId:'*',enabled:true,version:1,tiers:[{minOrders:1,type:'fixed',value:5000},{minOrders:2,type:'fixed',value:10000}]}];state.windows=[];state.promotions=[];
  state.days.forEach((day,dayIndex)=>{
    for(const [suffix,startTime,endTime] of [['am','10:00','13:00'],['pm','14:00','18:00']]){
      const id=`demo-${day.deliveryDate}-${suffix}`;state.windows.push({id,deliveryDate:day.deliveryDate,startTime,endTime,capacity:10,enabled:true,version:1});
      if(dayIndex===0)continue;
      const route={id:'route-'+id,windowId:id,deliveryDate:day.deliveryDate,departureAt:`${day.deliveryDate}T${startTime}:00-03:00`,capacity:10,version:dayIndex,stops:[]};
      for(let index=0;index<dayIndex;index++){
        const shipment={id:`example-${id}-${index}`,routeId:route.id,windowId:id,windowStart:startTime,windowEnd:endTime,deliveryDate:day.deliveryDate,status:'confirmed',priceMinor:24900,currency:'UYU',mode:'demo',demo:true,address:{...resolveZone('pocitos'),confirmed:true},externalOrderRef:`EJEMPLO-${id}-${index}`};
        state.shipments.push(shipment);route.stops.push({shipmentId:shipment.id,placeId:'zone:pocitos',label:'Pedido ficticio de demostración',status:'confirmed',priceMinor:24900});
      }
      state.routes.push(route);
    }
  });return state;
}

/** Private dispatch candidates: manual area rates, with no travel/distance or route-cost estimates. */
export async function buildZoneOptions({state,address,now = new Date(),selection=null}) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid quote date');
  const policy = state?.policy;
  if (!policy || !integer(policy.minimumMinor,1) || !integer(policy.version,1)
    || policy.quoteMinutes !== 5 || policy.holdMinutes !== 15) throw new Error('Invalid zone shipping policy');
  if (!address?.confirmed || address.provider !== 'zones' || !zoneById.has(address.areaId)
    || address.placeId !== `zone:${address.areaId}`) throw new Error('A confirmed catalog zone is required');
  const canonical = resolveZone(address.areaId);
  const rates = (state.zoneRates || []).filter(rate => rate.areaId === address.areaId);
  if (rates.length !== 1 || rates[0].enabled !== true || !integer(rates[0].priceMinor,1)) return [];
  const normalPriceMinor = Math.max(policy.minimumMinor,rates[0].priceMinor);
  const today = dateInMontevideo(instant);
  const windows=state.windows||[];
  const windowDates=new Set(windows.map(window=>window.deliveryDate));
  const days = [...(state.days || []).filter(day=>!windowDates.has(day.deliveryDate)),...windows.map(window=>({...validateDeliveryWindow(window),windowId:window.id,departureTime:window.startTime,version:window.version??1}))]
    .filter(day => day.enabled === true && calendarDate(day.deliveryDate) && day.deliveryDate >= today&&(!selection||(selection.windowId?day.windowId===selection.windowId:!day.windowId&&day.deliveryDate===selection.deliveryDate)))
    .sort((a,b) => a.deliveryDate.localeCompare(b.deliveryDate)||a.departureTime.localeCompare(b.departureTime));
  const options = [], seenDates = new Set();
  for (const day of days) {
    if (options.length === (windows.length?100:3)) break;
    const dispatchKey=day.windowId||day.deliveryDate;
    if (seenDates.has(dispatchKey)) continue;
    seenDates.add(dispatchKey);
    const maximum=day.windowId?1000:10;
    if (!integer(day.capacity,1,maximum) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(day.departureTime)) throw new Error('Invalid service day');
    const existing = (state.routes || []).filter(route => route.deliveryDate === day.deliveryDate && (route.windowId||null)===(day.windowId||null));
    if (existing.length > 1) throw new Error('Ambiguous service day route');
    const route = existing[0];
    if (route && (!Array.isArray(route.stops) || !integer(route.capacity ?? day.capacity,1,maximum) || !integer(route.version,0))) throw new Error('Invalid zone dispatch route');
    // Legacy distance routes must never be repurposed to bypass their assignments or capacity.
    if (route?.stops.some(stop => !zonePlace(stop.placeId))) continue;
    const departureAt = route?.departureAt || `${day.deliveryDate}T${day.departureTime}:00-03:00`;
    if (!Number.isFinite(Date.parse(departureAt))) throw new Error('Invalid dispatch departure');
    if (Date.parse(departureAt) <= instant.getTime()) continue;
    const stops = (route?.stops || []).filter(stop => stop.status !== 'cancelled');
    if (stops.some(stop => !['confirmed','held'].includes(stop.status) || !integer(stop.priceMinor))) throw new Error('Invalid zone dispatch stop');
    const capacity = Math.min(day.capacity,route?.capacity ?? day.capacity,maximum);
    if (stops.length >= capacity) continue;
    const promotions = (state.promotions || []).filter(promotion => promotion.active === true
      && promotion.areaId === address.areaId && promotion.deliveryDate === day.deliveryDate);
    const promotion = promotions.length === 1 ? promotions[0] : null;
    const confirmedCount=stops.filter(stop=>stop.status==='confirmed'&&stop.placeId===canonical.placeId).length;
    const calculation=calculateZonePrice({baseMinor:normalPriceMinor,minimumMinor:policy.minimumMinor,confirmedCount,rule:chooseDiscountRule(state.discountRules,address.areaId),promotion});
    const price={priceMinor:calculation.priceMinor,normalPriceMinor,safetyFloorMinor:policy.minimumMinor,...(calculation.promotionId?{promotionId:calculation.promotionId,promotionVersion:calculation.promotionVersion}:{}),calculation};
    const routeId = route?.id ?? null, routeVersion = route?.version ?? 0;
    const windowFields=day.windowId?{windowId:day.windowId,windowStart:day.startTime,windowEnd:day.endTime}:{};
    const candidateRoute = {id:routeId,version:routeVersion,deliveryDate:day.deliveryDate,departureAt,capacity,pricingMode:'zones',...windowFields,
      stops:[...stops.map(stop => ({...stop})),{shipmentId:null,placeId:canonical.placeId,label:canonical.label,priceMinor:price.priceMinor,status:'held'}]};
    options.push({routeId,routeVersion,policyVersion:policy.version,dayVersion:day.version ?? 1,deliveryDate:day.deliveryDate,
      currency:'UYU',...price,...windowFields,candidateRoute,expiresAt:new Date(instant.getTime()+policy.quoteMinutes*60000).toISOString(),
      mode:state.mode === 'demo' ? 'demo' : 'live',pricingMode:'zones'});
  }
  return options;
}
