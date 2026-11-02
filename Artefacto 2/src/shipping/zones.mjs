import { departments, zones } from '../../public/store/uy-geography.js';
import { createDemoState } from './demo.mjs';

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

/** Private dispatch candidates: manual area rates, with no travel/distance or route-cost estimates. */
export async function buildZoneOptions({state,address,now = new Date()}) {
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
  const days = (state.days || []).filter(day => day.enabled === true && calendarDate(day.deliveryDate) && day.deliveryDate >= today)
    .sort((a,b) => a.deliveryDate.localeCompare(b.deliveryDate));
  const options = [], seenDates = new Set();
  for (const day of days) {
    if (options.length === 3) break;
    if (seenDates.has(day.deliveryDate)) continue;
    seenDates.add(day.deliveryDate);
    if (!integer(day.capacity,1,10) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(day.departureTime)) throw new Error('Invalid service day');
    const existing = (state.routes || []).filter(route => route.deliveryDate === day.deliveryDate);
    if (existing.length > 1) throw new Error('Ambiguous service day route');
    const route = existing[0];
    if (route && (!Array.isArray(route.stops) || !integer(route.capacity ?? day.capacity,1,10) || !integer(route.version,0))) throw new Error('Invalid zone dispatch route');
    // Legacy distance routes must never be repurposed to bypass their assignments or capacity.
    if (route?.stops.some(stop => !zonePlace(stop.placeId))) continue;
    const departureAt = route?.departureAt || `${day.deliveryDate}T${day.departureTime}:00-03:00`;
    if (!Number.isFinite(Date.parse(departureAt))) throw new Error('Invalid dispatch departure');
    if (Date.parse(departureAt) <= instant.getTime()) continue;
    const stops = (route?.stops || []).filter(stop => stop.status !== 'cancelled');
    if (stops.some(stop => !['confirmed','held'].includes(stop.status) || !integer(stop.priceMinor))) throw new Error('Invalid zone dispatch stop');
    const capacity = Math.min(day.capacity,route?.capacity ?? day.capacity,10);
    if (stops.length >= capacity) continue;
    const price = {priceMinor:normalPriceMinor,normalPriceMinor,safetyFloorMinor:policy.minimumMinor};
    const promotions = (state.promotions || []).filter(promotion => promotion.active === true
      && promotion.areaId === address.areaId && promotion.deliveryDate === day.deliveryDate);
    const promotion = promotions.length === 1 ? promotions[0] : null;
    if (promotion && integer(promotion.priceMinor,1) && promotion.priceMinor >= policy.minimumMinor && promotion.priceMinor < normalPriceMinor) {
      price.priceMinor = promotion.priceMinor;
      price.promotionId = promotion.id;
      price.promotionVersion = promotion.version;
    }
    const routeId = route?.id ?? null, routeVersion = route?.version ?? 0;
    const candidateRoute = {id:routeId,version:routeVersion,deliveryDate:day.deliveryDate,departureAt,capacity,pricingMode:'zones',
      stops:[...stops.map(stop => ({...stop})),{shipmentId:null,placeId:canonical.placeId,label:canonical.label,priceMinor:price.priceMinor,status:'held'}]};
    options.push({routeId,routeVersion,policyVersion:policy.version,dayVersion:day.version ?? 1,deliveryDate:day.deliveryDate,
      currency:'UYU',...price,candidateRoute,expiresAt:new Date(instant.getTime()+policy.quoteMinutes*60000).toISOString(),
      mode:state.mode === 'demo' ? 'demo' : 'live',pricingMode:'zones'});
  }
  return options;
}
