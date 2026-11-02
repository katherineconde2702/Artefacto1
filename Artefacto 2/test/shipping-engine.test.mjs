import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePolicy, routeCostMinor, priceOption, buildOptions } from '../src/shipping/engine.mjs';
import { createDemoState, createDemoProvider } from '../src/shipping/demo.mjs';

const policy = {
  minimumMinor: 14900, fuelPriceMinorPerLiter: 9045, fuelLitersPer100Km: 3,
  laborMinorPerHour: 25000, serviceMinutes: 5, marginBps: 1500,
  roundingMinor: 100, quoteMinutes: 5, holdMinutes: 15, version: 1
};

test('options preserve the service-day version used during route planning', async () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const state = createDemoState(now);
  state.days.forEach((day, index) => { day.version = 7 + index; });
  const provider = createDemoProvider();
  const address = { ...await provider.resolveAddress('Centro'), confirmed: true };
  const options = await buildOptions({ state, address, provider, now, mode: 'demo' });
  assert.deepEqual(options.map(option => option.dayVersion), [7, 8, 9]);
});

// Catches omitting service, dividing kilometers incorrectly, or rounding cost down.
test('cost includes fuel, driving and service in integer UYU minor units', () => {
  assert.equal(routeCostMinor({distanceMeters: 10000, durationSeconds: 1800, stopCount: 2}, policy), 19381);
  assert.equal(routeCostMinor({distanceMeters: 0, durationSeconds: 0, stopCount: 0}, policy), 0);
});

// Catches free shipping policies, invalid margin/divisor, or fractional currency settings.
test('policy rejects unsafe monetary and duration values', () => {
  for (const patch of [{minimumMinor:0}, {marginBps:10000}, {roundingMinor:0},
    {fuelPriceMinorPerLiter:90.45}, {serviceMinutes:-1}, {quoteMinutes:0}, {laborMinorPerHour:Infinity}]) {
    assert.throws(() => validatePolicy({...policy,...patch}));
  }
  assert.equal(validatePolicy(policy).minimumMinor,14900);
  assert.throws(() => routeCostMinor({distanceMeters:-1,durationSeconds:0,stopCount:1},policy));
});

// 17000 / .85 = 20000, while a markup would incorrectly produce 19550.
test('normal price divides by margin and rounds upward after the positive minimum', () => {
  const p = priceOption({baseCostMinor:0,insertedCostMinor:17001,
    safetyScenarios:[{costMinor:17001,confirmedRevenueMinor:0}],policy});
  assert.equal(p.normalPriceMinor,20100);
  assert.equal(p.priceMinor,20100);
  assert.equal(p.safetyFloorMinor,20002);
  assert.equal(priceOption({baseCostMinor:1000,insertedCostMinor:1000,
    safetyScenarios:[{costMinor:1000,confirmedRevenueMinor:10000}],policy}).priceMinor,14900);
});

// Catches only protecting the no-cancellation case or always imposing standalone cost.
test('one supporting delivery cannot subsidize its own cancellation but two can support a lower price', () => {
  const one = priceOption({baseCostMinor:17000,insertedCostMinor:25500,
    safetyScenarios:[{costMinor:25500,confirmedRevenueMinor:40000},
      {costMinor:17000,confirmedRevenueMinor:0}],policy});
  const two = priceOption({baseCostMinor:25500,insertedCostMinor:34000,
    safetyScenarios:[{costMinor:34000,confirmedRevenueMinor:80000},
      {costMinor:25500,confirmedRevenueMinor:40000},
      {costMinor:25500,confirmedRevenueMinor:40000}],policy});
  assert.equal(one.priceMinor,20000);
  assert.equal(two.priceMinor,14900);
});

// Catches clamping a rejected promotion up, zero prices, stacking, or using incremental as offer floor.
test('fixed offers may lower incremental reference only while covering minimum and protected floor', () => {
  const input={baseCostMinor:0,insertedCostMinor:25500,
    safetyScenarios:[{costMinor:25500,confirmedRevenueMinor:16000}],policy};
  const offer=priceOption({...input,promotion:{id:'offer',priceMinor:15000}});
  assert.equal(offer.normalPriceMinor,30000);
  assert.equal(offer.priceMinor,15000);
  assert.equal(offer.promotionId,'offer');
  for(const priceMinor of [0,14000,31000]) {
    const rejected=priceOption({...input,promotion:{id:'offer',priceMinor}});
    assert.equal(rejected.priceMinor,30000);
    assert.equal(rejected.promotionId,undefined);
  }
  assert.throws(()=>priceOption({...input,safetyScenarios:[]}));
});

test('demo fixtures compute future service days in Montevideo and never resolve arbitrary addresses', async () => {
  const now=new Date('2026-11-01T01:00:00Z'); // Still October 31 in Montevideo.
  const state=createDemoState(now);
  assert.equal(state.days[0].deliveryDate,'2026-11-01');
  assert.equal(state.merchant.originPlaceId,'demo-centro');
  assert.equal(state.policy.version,1);
  assert.equal(state.mode,'demo');
  const provider=createDemoProvider();
  const address=await provider.resolveAddress('Pocitos');
  assert.equal(address.placeId,'demo-pocitos');
  assert.equal(address.provider,'demo');
  assert.equal(address.confirmed,false);
  await assert.rejects(provider.resolveAddress('Cualquier calle 123'),/demo/i);
  await assert.rejects(provider.computeRoute({originPlaceId:'real-place',stopPlaceIds:[],departureAt:'2026-11-01T13:00:00Z'}));
});

test('buildOptions returns up to three future dates with protected route candidates and quote expiration', async () => {
  const now=new Date('2026-10-31T15:00:00Z');
  const state=createDemoState(now);
  const provider=createDemoProvider();
  const address={...await provider.resolveAddress('Malvín'),confirmed:true};
  const options=await buildOptions({state,address,provider,now});
  assert.equal(options.length,3);
  assert.equal(options[0].deliveryDate,'2026-11-01');
  assert.equal(options[0].expiresAt,'2026-10-31T15:05:00.000Z');
  for(const option of options) {
    assert.equal(option.currency,'UYU');
    assert.ok(option.priceMinor>=option.safetyFloorMinor);
    assert.ok(option.priceMinor>=14900);
    assert.ok(option.metrics.stopCount>0);
    assert.equal(option.candidateRoute.stops.filter(s=>s.shipmentId===null).length,1);
  }
  assert.deepEqual(await buildOptions({state:{...state,days:[]},address,provider,now}),[]);
  await assert.rejects(buildOptions({state,address:{...address,confirmed:false},provider,now}));
  await assert.rejects(buildOptions({state:{...state,mode:'live'},address,provider,now}));
});

test('route holds occupy capacity without financing and cancelled stops do neither', async () => {
  const now=new Date('2026-10-31T15:00:00Z');
  const provider=createDemoProvider();
  const address={...await provider.resolveAddress('Malvín'),confirmed:true};
  const initial=createDemoState(now);
  const day={...initial.days[0],capacity:2};
  const route={id:'route',version:7,deliveryDate:day.deliveryDate,departureAt:`${day.deliveryDate}T10:00:00-03:00`,
    capacity:2,maxDurationSeconds:14400,stops:[{shipmentId:'one',placeId:'demo-pocitos',status:'held',priceMinor:900000}]};
  const state={...initial,days:[day],routes:[route],promotions:[]};
  const held=(await buildOptions({state,address,provider,now}))[0];
  const confirmed=(await buildOptions({state:{...state,routes:[{...route,stops:[{...route.stops[0],status:'confirmed'}]}]},address,provider,now}))[0];
  // The cancellation of the single confirmed support still leaves standalone cost protection.
  assert.ok(held.priceMinor>=confirmed.priceMinor);
  // 22km + 4300s driving + 600s service = 39998 minor; / .85 rounds to 47100.
  assert.equal(held.priceMinor,47100);
  assert.equal(held.safetyScenarios[0].confirmedRevenueMinor,0);
  assert.equal(confirmed.safetyScenarios.length,2);
  assert.equal(held.routeId,'route');
  assert.equal(held.routeVersion,7);
  assert.deepEqual(route.stops.map(s=>s.shipmentId),['one']);
  const full={...route,stops:[...route.stops,{shipmentId:'two',placeId:'demo-centro',status:'held',priceMinor:0}]};
  assert.deepEqual(await buildOptions({state:{...state,routes:[full]},address,provider,now}),[]);
  const cancelled={...full,stops:full.stops.map(s=>({...s,status:'cancelled'}))};
  assert.equal((await buildOptions({state:{...state,routes:[cancelled]},address,provider,now}))[0].metrics.stopCount,1);
});

test('offers require matching area, date, active state and an unambiguous single promotion', async () => {
  const now=new Date('2026-10-31T15:00:00Z');
  const provider=createDemoProvider();
  const initial=createDemoState(now);
  const address={...await provider.resolveAddress('Malvín'),confirmed:true};
  const day=initial.days[0];
  const state={...initial,days:[day],routes:[{id:'support',version:1,deliveryDate:day.deliveryDate,
    departureAt:`${day.deliveryDate}T10:00:00-03:00`,capacity:10,maxDurationSeconds:14400,
    stops:[{shipmentId:'a',placeId:'demo-pocitos',priceMinor:40000,status:'confirmed'},
      {shipmentId:'b',placeId:'demo-centro',priceMinor:40000,status:'confirmed'}]}],promotions:[]};
  const normal=(await buildOptions({state,address,provider,now}))[0];
  assert.equal(normal.normalPriceMinor,21200);
  assert.deepEqual(normal.candidateRoute.stops.filter(s=>s.shipmentId).map(s=>s.shipmentId),['a','b']);
  const promotion={id:'eligible',areaId:address.areaId,deliveryDate:day.deliveryDate,active:true,priceMinor:15000,version:1};
  assert.equal((await buildOptions({state:{...state,promotions:[promotion]},address,provider,now}))[0].priceMinor,15000);
  const duplicated=(await buildOptions({state:{...state,promotions:[promotion,{...promotion,id:'second'}]},address,provider,now}))[0];
  assert.equal(duplicated.priceMinor,21200);
  assert.equal(duplicated.promotionId,undefined);
  for(const patch of [{areaId:'pocitos'},{deliveryDate:'2026-11-09'},{active:false}]) {
    const promotion={id:'wrong',areaId:address.areaId,deliveryDate:state.days[0].deliveryDate,active:true,priceMinor:100,...patch};
    const option=(await buildOptions({state:{...state,promotions:[promotion]},address,provider,now}))[0];
    assert.equal(option.priceMinor,normal.priceMinor);
    assert.equal(option.promotionId,undefined);
  }
});

test('routes exceeding service duration and providers that fail never yield a fallback quote', async () => {
  const now=new Date('2026-10-31T15:00:00Z');
  const provider=createDemoProvider();
  const initial=createDemoState(now);
  const address={...await provider.resolveAddress('Malvín'),confirmed:true};
  const state={...initial,routes:[],days:[{...initial.days[0],maxDurationSeconds:1}]};
  assert.deepEqual(await buildOptions({state,address,provider,now}),[]);
  // Invalid configuration rejects before any Google call; there is no demo fallback.
  await assert.rejects(buildOptions({state:{...state,merchant:{...state.merchant,originPlaceId:null}},address,provider,now}));
});
