import test from 'node:test';
import assert from 'node:assert/strict';
import {createZoneDemoState} from '../src/shipping/zones.mjs';
import {zones} from '../public/store/uy-geography.js';
const maps=await import('../public/admin/tariff-map.js').catch(()=>({}));
test('both tariff maps cover the actual shipping zones without inventing a single Montevideo tariff',()=>{
 assert.equal(typeof maps.getTariffRegions,'function');const state=createZoneDemoState();
 const city=maps.getTariffRegions(state,'montevideo'),country=maps.getTariffRegions(state,'uruguay');
 assert.deepEqual(new Set(city.map(row=>row.id)),new Set(zones.filter(row=>row.departmentId==='montevideo').map(row=>row.id)));
 assert.deepEqual(new Set(country.filter(row=>!row.group).map(row=>row.id)),new Set(zones.filter(row=>row.departmentId!=='montevideo').map(row=>row.id)));
 assert.equal(country.find(row=>row.id==='montevideo').group,true);
 assert.equal(country.find(row=>row.id==='dept-canelones').priceMinor,39900);
});
test('tariff colors and prices follow current settings and distinguish disabled and missing rates',()=>{
 assert.equal(typeof maps.getTariffRegions,'function');const state=createZoneDemoState();
 state.zoneRates.find(row=>row.areaId==='malvin').priceMinor=29900;
 state.zoneRates.find(row=>row.areaId==='pocitos').enabled=false;
 state.zoneRates=state.zoneRates.filter(row=>row.areaId!=='centro');
 let rows=maps.getTariffRegions(state,'montevideo');
 assert.equal(rows.find(row=>row.id==='malvin').priceMinor,29900);
 assert.notEqual(rows.find(row=>row.id==='malvin').fill,rows.find(row=>row.id==='buceo').fill);
 assert.equal(rows.find(row=>row.id==='pocitos').status,'disabled');
 assert.equal(rows.find(row=>row.id==='centro').status,'missing');
 state.policy.minimumMinor=34900;rows=maps.getTariffRegions(state,'montevideo');
 assert.equal(rows.find(row=>row.id==='malvin').priceMinor,34900);
 assert.equal(rows.find(row=>row.id==='malvin').configuredMinor,29900);
});
test('map dropdown and labels show current UYU prices and escape commerce names',()=>{
 assert.equal(typeof maps.renderTariffMap,'function');const state=createZoneDemoState();
 state.areas.find(row=>row.id==='malvin').name='<script>Malvín</script>';
 const html=maps.renderTariffMap(state,{scope:'montevideo',selected:'malvin',zoom:1});
 assert.match(html,/id="map-area"/);assert.match(html,/UYU 249/);
 assert.match(html,/&lt;script&gt;Malvín&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.match(html,/data-map-zone="malvin"/);
});
