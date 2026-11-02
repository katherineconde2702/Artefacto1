const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const positive = value => Number.isFinite(value) && value > 0;
const roundUp = (value, step) => Math.ceil(value / step) * step;
const dateInMontevideo = date => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Montevideo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);

export function validatePolicy(input) {
  if (!input || !integer(input.minimumMinor,1) || !integer(input.fuelPriceMinorPerLiter,1)
    || !positive(input.fuelLitersPer100Km) || !integer(input.laborMinorPerHour,1)
    || !Number.isFinite(input.serviceMinutes) || input.serviceMinutes < 0
    || !integer(input.marginBps,0,9999) || !integer(input.roundingMinor,1)
    || input.quoteMinutes !== 5 || input.holdMinutes !== 15) {
    throw new Error('Invalid shipping policy');
  }
  return {...input};
}

export function routeCostMinor(metrics, policy) {
  validatePolicy(policy);
  if (!metrics || !Number.isFinite(metrics.distanceMeters) || metrics.distanceMeters < 0
    || !Number.isFinite(metrics.durationSeconds) || metrics.durationSeconds < 0
    || !integer(metrics.stopCount,0,10)) throw new Error('Invalid route metrics');
  const fuel = metrics.distanceMeters / 100000 * policy.fuelLitersPer100Km * policy.fuelPriceMinorPerLiter;
  const labor = (metrics.durationSeconds + metrics.stopCount * policy.serviceMinutes * 60) / 3600 * policy.laborMinorPerHour;
  const cost = Math.ceil(fuel + labor);
  if (!integer(cost)) throw new Error('Route cost exceeds safe currency range');
  return cost;
}

/** Scenarios contain complete route cost and revenue of OTHER confirmed stops that remain. */
export function priceOption({baseCostMinor, insertedCostMinor, safetyScenarios, policy, promotion}) {
  validatePolicy(policy);
  if (!integer(baseCostMinor) || !integer(insertedCostMinor) || !Array.isArray(safetyScenarios) || !safetyScenarios.length) {
    throw new Error('Invalid price inputs');
  }
  const divisor = (10000 - policy.marginBps) / 10000;
  let floor = 0;
  for (const scenario of safetyScenarios) {
    if (!integer(scenario.costMinor) || !integer(scenario.confirmedRevenueMinor)) throw new Error('Invalid safety scenario');
    floor = Math.max(floor, scenario.costMinor / divisor - scenario.confirmedRevenueMinor);
  }
  const safetyFloorMinor = Math.ceil(floor);
  const normalPriceMinor = roundUp(Math.max(policy.minimumMinor, Math.max(0,insertedCostMinor-baseCostMinor)/divisor, safetyFloorMinor), policy.roundingMinor);
  if (!integer(normalPriceMinor,1)) throw new Error('Price exceeds safe currency range');
  const result = {priceMinor:normalPriceMinor,normalPriceMinor,safetyFloorMinor};
  if (promotion && integer(promotion.priceMinor,1) && promotion.priceMinor >= policy.minimumMinor
    && promotion.priceMinor >= safetyFloorMinor && promotion.priceMinor < normalPriceMinor) {
    result.priceMinor = promotion.priceMinor;
    result.promotionId = promotion.id;
    result.promotionVersion = promotion.version;
  }
  return result;
}

/** Private options: candidateRoute and scenarios must never be returned to the buyer. */
export async function buildOptions({state, address, provider, now = new Date()}) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid quote date');
  const policy = validatePolicy(state?.policy);
  const mode = state.mode === 'demo' ? 'demo' : 'live';
  if (!provider || provider.mode !== (mode === 'demo' ? 'demo' : 'google')
    || !address?.confirmed || address.provider !== (mode === 'demo' ? 'demo' : 'google')
    || !address.placeId || !state.merchant?.originPlaceId
    || (mode === 'live' && [address.placeId,state.merchant.originPlaceId].some(id=>id.startsWith('demo-')))) {
    throw new Error('A confirmed address and configured shipping provider are required');
  }
  const today = dateInMontevideo(instant);
  const days = [...(state.days || [])].filter(day=> day.enabled === true && /^\d{4}-\d{2}-\d{2}$/.test(day.deliveryDate) && day.deliveryDate >= today)
    .sort((a,b)=>a.deliveryDate.localeCompare(b.deliveryDate));
  const cache = new Map();
  let requests = 0;
  const deadline = Date.now()+20000;
  async function metricsFor(stops, departureAt) {
    const key = JSON.stringify([departureAt,stops.map(s=>s.placeId)]);
    if (cache.has(key)) return cache.get(key);
    if (++requests > 72 || Date.now() >= deadline) throw new Error('Shipping quote calculation limit exceeded');
    let timer;
    try {
      const metrics = stops.length ? await Promise.race([
        provider.computeRoute({originPlaceId:state.merchant.originPlaceId,stopPlaceIds:stops.map(s=>s.placeId),departureAt}),
        new Promise((_,reject)=> {timer=setTimeout(()=>reject(new Error('Shipping route timeout')),Math.min(8000,deadline-Date.now()));})
      ]) : {distanceMeters:0,durationSeconds:0};
      const full = {...metrics,stopCount:stops.length};
      full.costMinor = routeCostMinor(full, policy);
      full.totalDurationSeconds = full.durationSeconds + full.stopCount*policy.serviceMinutes*60;
      cache.set(key,full);
      return full;
    } finally {clearTimeout(timer);}
  }
  const options = [];
  const seenDates = new Set();
  for (const day of days) {
    if (options.length === 3) break;
    if (seenDates.has(day.deliveryDate)) continue;
    seenDates.add(day.deliveryDate);
    if (!integer(day.capacity,1,10) || !integer(day.maxDurationSeconds,1) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(day.departureTime)) throw new Error('Invalid service day');
    const existing = (state.routes || []).filter(route=>route.deliveryDate===day.deliveryDate);
    // One committed route per service day. Never create a second route to bypass its capacity.
    if (existing.length > 1) throw new Error('Ambiguous service day route');
    const route = existing[0] || {id:null,version:0,deliveryDate:day.deliveryDate,
      departureAt:`${day.deliveryDate}T${day.departureTime}:00-03:00`,capacity:day.capacity,maxDurationSeconds:day.maxDurationSeconds,stops:[]};
    if (!Number.isFinite(Date.parse(route.departureAt))) throw new Error('Invalid route departure');
    if (Date.parse(route.departureAt) <= instant.getTime()) continue;
    const stops = route.stops.filter(s=>s.status!=='cancelled');
    if (stops.some(s=>!['confirmed','held'].includes(s.status) || !s.placeId || !integer(s.priceMinor))) throw new Error('Invalid route stop');
    const capacity = Math.min(day.capacity,route.capacity ?? day.capacity,10);
    const maxDuration = Math.min(day.maxDurationSeconds,route.maxDurationSeconds ?? day.maxDurationSeconds);
    if (stops.length >= capacity) continue;
    const base = await metricsFor(stops,route.departureAt);
    const newStop = {shipmentId:null,placeId:address.placeId,label:address.formattedAddress,priceMinor:0,status:'held'};
    let best;
    for (let at=0;at<=stops.length;at++) {
      const candidate = [...stops.slice(0,at),newStop,...stops.slice(at)];
      const metrics = await metricsFor(candidate,route.departureAt);
      if (metrics.totalDurationSeconds <= maxDuration && (!best || metrics.costMinor < best.metrics.costMinor)) best={stops:candidate,metrics};
    }
    if (!best) continue;
    const revenue = list => list.filter(s=>s.status==='confirmed').reduce((sum,s)=>sum+s.priceMinor,0);
    const safetyScenarios = [{costMinor:best.metrics.costMinor,confirmedRevenueMinor:revenue(stops)}];
    for (let at=0;at<best.stops.length;at++) {
      if (best.stops[at].status !== 'confirmed') continue;
      const remaining = best.stops.filter((_,i)=>i!==at);
      const metrics = await metricsFor(remaining,route.departureAt);
      safetyScenarios.push({costMinor:metrics.costMinor,confirmedRevenueMinor:revenue(remaining)});
    }
    const matches = address.areaId ? (state.promotions || []).filter(p=>p.active === true && p.areaId===address.areaId && p.deliveryDate===day.deliveryDate) : [];
    const price = priceOption({baseCostMinor:base.costMinor,insertedCostMinor:best.metrics.costMinor,safetyScenarios,policy,promotion:matches.length===1?matches[0]:undefined});
    const candidateRoute = {...route,capacity,maxDurationSeconds:maxDuration,stops:best.stops.map(s=>s===newStop?{...s,priceMinor:price.priceMinor}:{...s})};
    options.push({routeId:route.id,routeVersion:route.version,policyVersion:policy.version,dayVersion:day.version ?? 1,deliveryDate:day.deliveryDate,
      currency:'UYU',...price,metrics:best.metrics,safetyScenarios,candidateRoute,
      expiresAt:new Date(instant.getTime()+policy.quoteMinutes*60000).toISOString(),mode});
  }
  return options;
}
