import test from 'node:test';
import assert from 'node:assert/strict';
import {createZoneDemoState,buildZoneOptions,resolveZone} from '../src/shipping/zones.mjs';
import {createMemoryRepository} from '../src/shipping/memory.mjs';
const rules=await import('../public/shipping-admin/rules.js').catch(()=>({}));
const rule={areaId:'*',enabled:true,tiers:[{minOrders:1,type:'fixed',value:5000},{minOrders:2,type:'fixed',value:10000}]};
const now=new Date('2099-01-01T12:00:00Z');
const address={...resolveZone('pocitos'),confirmed:true};
test('shopper gets at most five chronological choices including the nearest and a later cheapest delivery',()=>{
 const candidates=[24900,21900,18900,22900,23900,24900,14900,24900].map((priceMinor,index)=>({id:`day-${index+1}`,deliveryDate:`2099-01-${String(index+2).padStart(2,'0')}`,windowStart:'10:00',priceMinor}));
 const shuffled=[...candidates].reverse(),before=structuredClone(shuffled);
 assert.equal(typeof rules.selectDeliveryOptions,'function');
 assert.deepEqual(rules.selectDeliveryOptions(shuffled).map(row=>row.id),['day-1','day-2','day-3','day-4','day-7']);
 assert.deepEqual(shuffled,before);
 assert.deepEqual(rules.selectDeliveryOptions([]),[]);
 assert.deepEqual(rules.selectDeliveryOptions(candidates.slice(0,3)),candidates.slice(0,3));
 const ties=candidates.map(row=>({...row,priceMinor:24900}));
 assert.deepEqual(rules.selectDeliveryOptions(ties).map(row=>row.id),['day-1','day-2','day-3','day-4','day-5']);
 const varied=[24900,24900,24900,24900,24900,21900,24900,18900,24900,14900].map((priceMinor,index)=>({id:`varied-${index}`,deliveryDate:`2099-02-${String(index+1).padStart(2,'0')}`,priceMinor}));
 const choices=rules.selectDeliveryOptions(varied);assert.equal(choices.length,5);assert.equal(choices[0].id,'varied-0');
 assert.deepEqual([...new Set(choices.map(row=>row.priceMinor))].sort((a,b)=>a-b),[14900,18900,21900,24900]);
});
function fixture(){const state=createZoneDemoState(now);state.policy.minimumMinor=14900;state.days=[];state.windows=[{id:'morning',deliveryDate:'2099-01-02',startTime:'10:00',endTime:'13:00',capacity:3,enabled:true,version:1},{id:'afternoon',deliveryDate:'2099-01-02',startTime:'14:00',endTime:'18:00',capacity:3,enabled:true,version:1}];state.discountRules=[rule];return state;}

test('confirmed matching orders select one configurable tier and never undercut minimum',()=>{
  assert.equal(typeof rules.calculateZonePrice,'function');
  for(const [count,want] of [[0,24900],[1,19900],[2,14900],[8,14900]])assert.equal(rules.calculateZonePrice({baseMinor:24900,minimumMinor:14900,confirmedCount:count,rule}).priceMinor,want);
  const percentage={...rule,tiers:[{minOrders:1,type:'percent',value:2500}]};
  assert.equal(rules.calculateZonePrice({baseMinor:24901,minimumMinor:10000,confirmedCount:1,rule:percentage}).priceMinor,18676);
  assert.equal(rules.calculateZonePrice({baseMinor:24900,minimumMinor:14900,confirmedCount:1,rule,promotion:{priceMinor:17900,id:'offer'}}).source,'promotion');
  assert.equal(rules.calculateZonePrice({baseMinor:24900,minimumMinor:21000,confirmedCount:2,rule,promotion:{priceMinor:14900}}).priceMinor,21000);
});
test('tier editor accepts changing quantities and rejects duplicate thresholds and hidden fields',()=>{
  assert.equal(typeof rules.validateDiscountRule,'function');
  assert.equal(rules.validateDiscountRule({...rule,tiers:[...rule.tiers,{minOrders:5,type:'percent',value:5000}]}).tiers.length,3);
  for(const tiers of [[{minOrders:0,type:'fixed',value:1}],Array(21).fill(rule.tiers[0]),[rule.tiers[0],rule.tiers[0]],[{minOrders:1,type:'percent',value:10001}],[{minOrders:1,type:'fixed',value:1,extra:true}]])assert.throws(()=>rules.validateDiscountRule({...rule,tiers}));
});
test('zone exception replaces global tiers and an explicitly disabled exception gives no discount',()=>{
  assert.equal(typeof rules.chooseDiscountRule,'function');
  const chosen=rules.chooseDiscountRule([rule,{...rule,areaId:'pocitos',enabled:false}],'pocitos');
  assert.equal(rules.calculateZonePrice({baseMinor:24900,minimumMinor:14900,confirmedCount:5,rule:chosen}).priceMinor,24900);
  assert.equal(rules.chooseDiscountRule([rule],'malvin').areaId,'*');
});
test('windows quote independently and count only confirmed same-zone same-window shipments',async()=>{
  const state=fixture();state.routes=[{id:'r',windowId:'morning',deliveryDate:'2099-01-02',version:1,capacity:3,stops:[{shipmentId:'one',placeId:'zone:pocitos',status:'confirmed',priceMinor:24900},{shipmentId:'pending',placeId:'zone:malvin',status:'held',priceMinor:24900}]}];
  const options=await buildZoneOptions({state,address,now});assert.equal(options.length,2);
  assert.equal(options[0].windowId,'morning');assert.equal(options[0].priceMinor,19900);assert.equal(options[0].calculation.confirmedCount,1);
  assert.equal(options[1].windowId,'afternoon');assert.equal(options[1].priceMinor,24900);
});
test('full or closed window is omitted without hiding an available window in the same date',async()=>{
  const state=fixture();state.windows[0].capacity=1;state.routes=[{id:'r',windowId:'morning',deliveryDate:'2099-01-02',version:1,capacity:1,stops:[{shipmentId:'s',placeId:'zone:pocitos',status:'held',priceMinor:24900}]}];
  assert.deepEqual((await buildZoneOptions({state,address,now})).map(row=>row.windowId),['afternoon']);
  state.windows[1].enabled=false;assert.deepEqual(await buildZoneOptions({state,address,now}),[]);
});
test('demo admin persists discount rules with policy version and rejects invalid membership',async()=>{
  const repository=createMemoryRepository(fixture());
  await assert.rejects(repository.mutate('discount_rule_save',{merchantId:'marea',mode:'demo',actorId:'intruder',rule}),error=>error.status===403);
  await repository.mutate('discount_rule_save',{merchantId:'marea',mode:'demo',actorId:'demo-admin',rule});
  const state=await repository.snapshot('marea','demo');assert.equal(state.discountRules.length,1);assert.equal(state.policy.version,2);assert.equal(state.auditEvents[0].operation,'discount_rule_save');
});
test('demo window rejects overlap and a lower capacity than active assignments',async()=>{
  const state=fixture();state.routes=[{id:'r',windowId:'morning',deliveryDate:'2099-01-02',version:1,capacity:3,stops:[{shipmentId:'a',status:'confirmed'},{shipmentId:'b',status:'held'}]}];
  const repository=createMemoryRepository(state);const payload={merchantId:'marea',mode:'demo',actorId:'demo-admin'};
  await assert.rejects(repository.mutate('delivery_window_save',{...payload,window:{...state.windows[0],id:'overlap',startTime:'12:00',endTime:'15:00'}}));
  await assert.rejects(repository.mutate('delivery_window_save',{...payload,window:{...state.windows[0],capacity:1}}));
  await repository.mutate('delivery_window_save',{...payload,window:{...state.windows[0],enabled:false}});
  assert.equal((await repository.snapshot('marea','demo')).windows[0].enabled,false);
});
test('last window place cannot be oversold and accepted price survives policy edits and replay',async()=>{
  const state=fixture();state.windows[0].capacity=1;const repository=createMemoryRepository(state),scope={merchantId:'marea',mode:'demo'};
  const option=(await buildZoneOptions({state,address,now}))[0];
  for(const id of ['a','b']){
    await repository.mutate('checkout_create',{...scope,id,currency:'UYU',subtotalMinor:100000,cart:[{productId:'anything',quantity:1}],expiresAt:'2099-01-03T00:00:00Z'});
    await repository.mutate('quote_create',{...scope,...option,id:'q'+id,checkoutId:id,address});
  }
  const payload={...scope,checkoutId:'a',quoteId:'qa',expectedVersion:0,idempotencyKey:'first',bodyHash:'first'};
  const [first,second]=await Promise.allSettled([repository.mutate('reserve',payload),repository.mutate('reserve',{...payload,checkoutId:'b',quoteId:'qb',idempotencyKey:'second',bodyHash:'second'})]);
  assert.equal(first.status,'fulfilled');assert.equal(second.status,'rejected');assert.equal(first.value.windowId,'morning');assert.equal(first.value.priceMinor,24900);
  await repository.mutate('discount_rule_save',{...scope,actorId:'demo-admin',rule:{...rule,tiers:[{minOrders:1,type:'fixed',value:1000}]}});
  assert.equal((await repository.mutate('reserve',payload)).priceMinor,24900);
  assert.equal((await repository.snapshot('marea','demo')).shipments.length,1);
});
test('explicit B2B demo presets show real grouping differences without injecting live data',async()=>{
 const module=await import('../src/shipping/zones.mjs');assert.equal(typeof module.createB2BDemoState,'function');
 const state=module.createB2BDemoState(now);const options=await buildZoneOptions({state,address,now});
 assert.equal(state.mode,'demo');assert.equal(state.windows.length,6);
 for(const price of [24900,21900,18900,14900])assert.ok(options.some(row=>row.priceMinor===price),`Missing example price ${price}`);
 for(const count of [0,3,5,15])assert.ok(options.some(row=>row.calculation.confirmedCount===count),`Missing example demand ${count}`);
 assert.ok(state.shipments.every(row=>row.demo===true));assert.ok(state.routes.every(route=>route.stops.length<route.capacity));
});
test('withdrawing a manual offer invalidates unaccepted quotes while preserving an accepted replay',async()=>{
 const state=fixture();state.promotions=[{id:'offer',areaId:'pocitos',deliveryDate:'2099-01-02',priceMinor:14900,active:true,version:1}];const repository=createMemoryRepository(state),scope={merchantId:'marea',mode:'demo'};
 const option=(await buildZoneOptions({state,address,now}))[0];assert.equal(option.priceMinor,14900);
 await repository.mutate('checkout_create',{...scope,id:'accepted',currency:'UYU',subtotalMinor:100000,cart:[{}],expiresAt:'2099-01-03T00:00:00Z'});await repository.mutate('quote_create',{...scope,...option,id:'q-accepted',checkoutId:'accepted',address});
  const payload={...scope,checkoutId:'accepted',quoteId:'q-accepted',expectedVersion:0,idempotencyKey:'accepted-offer',bodyHash:'accepted-offer'};const accepted=await repository.mutate('reserve',payload);
 const fresh=(await buildZoneOptions({state:await repository.snapshot('marea','demo'),address,now}))[0];
 await repository.mutate('checkout_create',{...scope,id:'pending',currency:'UYU',subtotalMinor:100000,cart:[{}],expiresAt:'2099-01-03T00:00:00Z'});await repository.mutate('quote_create',{...scope,...fresh,id:'q-pending',checkoutId:'pending',address});
 await repository.mutate('promotion_save',{...scope,actorId:'demo-admin',promotion:{...state.promotions[0],active:false}});
 await assert.rejects(repository.mutate('reserve',{...scope,checkoutId:'pending',quoteId:'q-pending',expectedVersion:1,idempotencyKey:'pending-offer',bodyHash:'pending-offer'}),{code:'policy_changed'});
 assert.deepEqual(await repository.mutate('reserve',payload),accepted);
});
