import test from 'node:test';
import assert from 'node:assert/strict';
import { departments, zones } from '../public/store/uy-geography.js';
import { createZoneDemoState, resolveZone, buildZoneOptions } from '../src/shipping/zones.mjs';

const now = new Date('2026-11-01T15:00:00Z');
function fixture(areaId = 'centro') {
  const state = createZoneDemoState(now);
  const address = { ...resolveZone(areaId), confirmed: true };
  return { state, address, buildZoneOptions };
}

// Catches a missing department, an accidental locality, or Montevideo treated as one department-wide rate.
test('the catalog covers the 19 departments and one interior zone per department', async () => {
  assert.deepEqual(departments.map(row => row.name), ['Artigas','Canelones','Cerro Largo','Colonia','Durazno','Flores','Florida','Lavalleja','Maldonado','Montevideo','Paysandú','Río Negro','Rivera','Rocha','Salto','San José','Soriano','Tacuarembó','Treinta y Tres']);
  assert.equal(new Set(zones.map(row => row.id)).size, 80);
  for (const department of departments) {
    const areas = zones.filter(row => row.departmentId === department.id);
    if (department.id === 'montevideo') {
      assert.equal(areas.length, 62);
      assert.ok(areas.every(row => row.kind === 'neighborhood'));
    } else {
      assert.deepEqual(areas, [{ id: `dept-${department.id}`, name: department.name, departmentId: department.id, kind: 'department' }]);
    }
  }
});

// Catches dropping or splitting a grouped official feature, while protecting existing checkout IDs.
test('all 62 official Montevideo neighborhood identifiers remain selectable in Spanish order', async () => {
  const barrios = zones.filter(row => row.departmentId === 'montevideo');
  assert.deepEqual(barrios.map(row => row.id).sort(), [
    'aguada','aires-puros','atahualpa','banados-de-carrasco','barrio-sur','belvedere','brazo-oriental','buceo','capurro-bella-vista','carrasco','carrasco-norte','casabo-pajas-blancas','casavalle','castro-castellanos','centro','cerrito','cerro','ciudad-vieja','colon-centro-y-noroeste','colon-sureste-abayuba','conciliacion','cordon','figurita','flor-de-maronas','ituzaingo','jacinto-vera','jardines-del-hipodromo','la-blanqueada','la-comercial','la-paloma-tomkinson','la-teja','larranaga','las-acacias','las-canteras','lezica-melilla','malvin','malvin-norte','manga','manga-toledo-chico','maronas-parque-guarani','mercado-modelo-y-bolivar','nuevo-paris','palermo','parque-rodo','paso-de-la-arena','paso-de-las-duranas','penarol-lavalleja','piedras-blancas','pocitos','pque-batlle-villa-dolores','prado-nueva-savona','punta-carretas','punta-gorda','punta-rieles-bella-italia','reducto','sayago','tres-cruces','tres-ombues-pblo-victoria','union','villa-espanola','villa-garcia-manga-rural','villa-munoz-retiro'
  ].sort());
  assert.deepEqual(barrios.map(row => row.name), [...barrios.map(row => row.name)].sort((a,b) => a.localeCompare(b,'es')));
  assert.equal(barrios.find(row => row.id === 'malvin').name, 'Malvín');
});

// Catches free text being accepted, interior barrios being invented, or buyer labels overriding catalog labels.
test('zone resolution accepts only catalog IDs and returns canonical area labels', async () => {
  assert.deepEqual(resolveZone('malvin'), { id:null, areaId:'malvin', departmentId:'montevideo', inputAddress:'Malvín, Montevideo, Uruguay', formattedAddress:'Malvín, Montevideo, Uruguay', label:'Malvín, Montevideo, Uruguay', placeId:'zone:malvin', provider:'zones', confirmed:false });
  assert.equal(resolveZone('dept-canelones').formattedAddress, 'Canelones, Uruguay');
  for (const value of ['Canelones', 'canelones', 'dept-montevideo', 'las-piedras', 'centro-canelones', '', null, {areaId:'centro'}]) assert.throws(() => resolveZone(value), /zone/i);
});

// Catches old simulated shipments financing a zone quote, or sample amounts leaking into ordinary live setup.
test('zone demo fixtures have only explicit example tariffs and no old distance routes', async () => {
  const state = createZoneDemoState(new Date('2026-11-01T01:00:00Z'));
  assert.equal(state.mode, 'demo');
  assert.equal(state.pricingMode, 'zones');
  assert.equal(state.areas.length, 80);
  assert.equal(state.departments.length, 19);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.shipments, []);
  assert.equal(state.zoneRates.find(row => row.areaId === 'centro').priceMinor, 24900);
  assert.equal(state.zoneRates.find(row => row.areaId === 'dept-canelones').priceMinor, 39900);
  assert.ok(state.zoneRates.every(row => row.enabled === true && row.version === 1 && row.demo === true));
  assert.equal(state.days[0].deliveryDate, '2026-11-01');
  assert.deepEqual(state.promotions, [{id:'demo-promotion-malvin',areaId:'malvin',deliveryDate:'2026-11-03',priceMinor:14900,active:true,version:1}]);
});

// Catches calculating mileage, rounding a manual amount, or using example costs instead of the configured rate.
test('zone quotes use the fixed integer tariff, preserve versions and contain no travel claims', async () => {
  const { state, address, buildZoneOptions } = await fixture('dept-rio-negro');
  state.mode = 'live';
  delete state.merchant.originPlaceId;
  state.policy.version = 8;
  state.days[0].version = 5;
  state.zoneRates.find(row => row.areaId === 'dept-rio-negro').priceMinor = 39901;
  const options = await buildZoneOptions({state,address,now});
  assert.equal(options.length, 3);
  assert.equal(options[0].priceMinor, 39901);
  assert.equal(options[0].normalPriceMinor, 39901);
  assert.equal(options[0].safetyFloorMinor, 14900);
  assert.equal(options[0].policyVersion, 8);
  assert.equal(options[0].dayVersion, 5);
  assert.equal(options[0].routeVersion, 0);
  assert.equal(options[0].currency, 'UYU');
  assert.equal(options[0].pricingMode, 'zones');
  assert.equal(options[0].mode, 'live');
  assert.equal(options[0].expiresAt, '2026-11-01T15:05:00.000Z');
  for (const option of options) {
    assert.equal(option.metrics, undefined);
    assert.equal(option.safetyScenarios, undefined);
    assert.equal(option.candidateRoute.maxDurationSeconds, undefined);
    assert.deepEqual(option.candidateRoute.stops, [{shipmentId:null,placeId:'zone:dept-rio-negro',label:'Río Negro, Uruguay',priceMinor:39901,status:'held'}]);
  }
});

// Catches disabled/missing/ambiguous rates quoting or malformed currency being silently accepted.
test('unknown, unavailable and invalid zone rates never yield a quote', async () => {
  const { state, address, buildZoneOptions } = await fixture();
  for (const zoneRates of [[], [{areaId:'centro',priceMinor:24900,enabled:false,version:1}], [{areaId:'centro',priceMinor:0,enabled:true,version:1}], [{areaId:'centro',priceMinor:24.9,enabled:true,version:1}], [{areaId:'centro',priceMinor:Infinity,enabled:true,version:1}], [{areaId:'centro',priceMinor:24900,enabled:true,version:1},{areaId:'centro',priceMinor:29900,enabled:true,version:1}]]) {
    assert.deepEqual(await buildZoneOptions({state:{...state,zoneRates},address,now}), []);
  }
  await assert.rejects(buildZoneOptions({state,address:{...address,areaId:'unknown',placeId:'zone:unknown'},now}));
  await assert.rejects(buildZoneOptions({state,address:{...address,confirmed:false},now}));
  await assert.rejects(buildZoneOptions({state,address:{...address,provider:'google'},now}));
  await assert.rejects(buildZoneOptions({state,address:{...address,placeId:'zone:pocitos'},now}));
});

// Catches invalid minimum policies, or a manual tariff bypassing a minimum raised after setup.
test('zone pricing enforces a positive minimum without route-cost policy fields', async () => {
  const { state, address, buildZoneOptions } = await fixture();
  state.policy = {version:2,minimumMinor:30001,quoteMinutes:5,holdMinutes:15};
  assert.equal((await buildZoneOptions({state,address,now}))[0].priceMinor, 30001);
  for (const minimumMinor of [0,-1,1.5,Infinity]) await assert.rejects(buildZoneOptions({state:{...state,policy:{...state.policy,minimumMinor}},address,now}));
});

// Catches applying a promotion to another zone/date, ignoring the minimum, or stacking ambiguous offers.
test('only one active matching date offer may lower a zone tariff at or above the minimum', async () => {
  const { state, address, buildZoneOptions } = await fixture('malvin');
  const options = await buildZoneOptions({state,address,now});
  assert.deepEqual(options.map(row => row.priceMinor), [24900,24900,14900]);
  assert.equal(options[2].promotionId, 'demo-promotion-malvin');
  assert.equal(options[2].promotionVersion, 1);
  const offer = {...state.promotions[0],deliveryDate:state.days[0].deliveryDate,priceMinor:14901};
  assert.equal((await buildZoneOptions({state:{...state,promotions:[offer]},address,now}))[0].priceMinor, 14901);
  for (const patch of [{priceMinor:14899},{priceMinor:24900},{priceMinor:24901},{priceMinor:1.5},{areaId:'centro'},{deliveryDate:'2026-11-15'},{active:false}]) {
    const quoted = (await buildZoneOptions({state:{...state,promotions:[{...offer,...patch}]},address,now}))[0];
    assert.equal(quoted.priceMinor, 24900);
    assert.equal(quoted.promotionId, undefined);
  }
  assert.equal((await buildZoneOptions({state:{...state,promotions:[offer,{...offer,id:'duplicate'}]},address,now}))[0].priceMinor, 24900);
});

// Catches treating held stops as free capacity, retaining cancelled stops, or making price depend on other revenue.
test('zone dispatch capacity counts held and confirmed stops and preserves their accepted amounts', async () => {
  const { state, address, buildZoneOptions } = await fixture();
  const day = {...state.days[0],capacity:3};
  const stops = [{shipmentId:'a',placeId:'zone:pocitos',label:'Pocitos',priceMinor:100000,status:'confirmed'},{shipmentId:'b',placeId:'zone:malvin',label:'Malvín',priceMinor:14900,status:'held'},{shipmentId:'c',placeId:'zone:centro',priceMinor:14900,status:'cancelled'}];
  const route = {id:'zones-route',version:7,deliveryDate:day.deliveryDate,departureAt:`${day.deliveryDate}T10:00:00-03:00`,capacity:3,stops};
  const option = (await buildZoneOptions({state:{...state,days:[day],routes:[route]},address,now}))[0];
  assert.equal(option.priceMinor, 24900);
  assert.equal(option.routeId, 'zones-route');
  assert.equal(option.routeVersion, 7);
  assert.deepEqual(option.candidateRoute.stops.map(row => row.shipmentId), ['a','b',null]);
  assert.deepEqual(option.candidateRoute.stops.slice(0,2).map(row => row.priceMinor), [100000,14900]);
  assert.equal(stops.length, 3);
  assert.deepEqual(await buildZoneOptions({state:{...state,days:[{...day,capacity:2}],routes:[route]},address,now}), []);
});

// Catches old Google/demo routes being reused or a second route bypassing a day's existing assignments.
test('legacy and mixed-provider routes cannot be used for a zone quote', async () => {
  const { state, address, buildZoneOptions } = await fixture();
  const day = state.days[0];
  const route = {id:'old',version:1,deliveryDate:day.deliveryDate,departureAt:`${day.deliveryDate}T10:00:00-03:00`,capacity:10,stops:[]};
  for (const placeIds of [['demo-centro'],['ChIJGoogle'],['zone:centro','demo-pocitos'],['zone:unknown']]) {
    const routes = [{...route,stops:placeIds.map((placeId,i) => ({shipmentId:`old-${i}`,placeId,priceMinor:20000,status:'confirmed'}))}];
    assert.deepEqual(await buildZoneOptions({state:{...state,days:[day],routes},address,now}), []);
  }
  await assert.rejects(buildZoneOptions({state:{...state,days:[day],routes:[route,{...route,id:'second'}]},address,now}));
});

// Catches offering past/departed days, duplicate dates, more than three dates, or capacity above ten.
test('quotes expose at most three distinct future dispatch dates with a maximum of ten places', async () => {
  const { state, address, buildZoneOptions } = await fixture();
  const day = state.days[0];
  state.days = [{...day,deliveryDate:'2026-10-31'}, {...day,deliveryDate:'2026-11-01'}, {...day,deliveryDate:'2026-11-02',enabled:false}, {...day,deliveryDate:'2026-11-03'}, {...day,deliveryDate:'2026-11-03'}, {...day,deliveryDate:'2026-11-04'}, {...day,deliveryDate:'2026-11-05'}, {...day,deliveryDate:'2026-11-06'}];
  assert.deepEqual((await buildZoneOptions({state,address,now})).map(row => row.deliveryDate), ['2026-11-03','2026-11-04','2026-11-05']);
  state.days = [{...day,capacity:11}];
  await assert.rejects(buildZoneOptions({state,address,now}));
  await assert.rejects(buildZoneOptions({state:{...state,days:[day]},address,now:'invalid'}));
});
