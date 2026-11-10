import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../public/admin/admin.js';
const response=data=>({ok:true,status:200,json:async()=>data});
test('shipment actions offer confirmation only for an unexpired held reservation',()=>{
 const now=Date.parse('2026-11-10T12:00:00Z'),shipment={id:'hold-1',status:'held',expiresAt:'2026-11-10T12:15:00Z'};
 assert.equal(typeof admin.renderShipmentActions,'function');
 assert.match(admin.renderShipmentActions(shipment,now),/data-confirm="hold-1"/);
 for(const status of ['confirmed','cancelled','completed','expired'])assert.doesNotMatch(admin.renderShipmentActions({...shipment,status},now),/data-confirm=/);
 assert.doesNotMatch(admin.renderShipmentActions(shipment,Date.parse(shipment.expiresAt)),/data-confirm=/);
 assert.doesNotMatch(admin.renderShipmentActions({...shipment,expiresAt:'invalid'},now),/data-confirm=/);
});
test('shipment action identifiers and cancellation text are escaped as data',()=>{
 const html=admin.renderShipmentActions({id:'a"<script>',status:'held',expiresAt:'2099-01-01T00:00:00Z'});
 assert.match(html,/data-confirm="a&quot;&lt;script&gt;"/);assert.match(html,/data-cancel="a&quot;&lt;script&gt;"/);assert.doesNotMatch(html,/<script>/);
 const cancelled=admin.renderShipmentActions({status:'cancelled',cancellationReason:'<script>why</script>'});
 assert.match(cancelled,/&lt;script&gt;why&lt;\/script&gt;/);assert.doesNotMatch(cancelled,/<script>|data-cancel=/);
});
test('independent admin session scopes membership and every request to selected commerce',async()=>{
 const calls=[];const session=admin.createAdminSession(async(url,options)=>{calls.push({url,options});return response(url.includes('auth/v1')?{access_token:'private-token'}:{merchant:{id:'books'}});},{merchantId:'books',apiBase:'/api/v1/shipping'});
 await session.login({supabase:{url:'https://personal.supabase.co',publishableKey:'public'}},'admin@example.org','password');
 await session.request('/discount-rules');
 assert.equal(calls[1].url,'/api/v1/shipping/admin/overview?merchantId=books');assert.equal(calls[2].url,'/api/v1/shipping/admin/discount-rules?merchantId=books');
 await assert.rejects(session.request('/overview?merchantId=other'),/comercio/i);
});
test('dynamic tier form converts UYU and percentages and allows adding/removing thresholds',()=>{
 assert.equal(typeof admin.parseDiscountForm,'function');
 const result=admin.parseDiscountForm({areaId:'*',enabled:true,tiers:[{minOrders:'1',type:'fixed',value:'50,50'},{minOrders:'4',type:'percent',value:'25'}]});
 assert.deepEqual(result.tiers,[{minOrders:1,type:'fixed',value:5050},{minOrders:4,type:'percent',value:2500}]);
 assert.equal(admin.parseDiscountForm({areaId:'pocitos',enabled:false,tiers:[]}).tiers.length,0);
 assert.throws(()=>admin.parseDiscountForm({areaId:'*',enabled:true,tiers:[{minOrders:'1.5',type:'fixed',value:'50'}]}));
});
test('pricing explanation shows actual threshold and minimum without interpreting commerce names as HTML',()=>{
 assert.equal(typeof admin.renderPriceExplanation,'function');
 const html=admin.renderPriceExplanation({normalPriceMinor:24900,confirmedCount:2,tier:{minOrders:2,type:'fixed',value:10000},automaticPriceMinor:14900,safetyFloorMinor:15900,minimumApplied:true,priceMinor:15900,source:'grouping',discountMinor:9000});
 assert.match(html,/249,00/);assert.match(html,/159,00/);assert.match(html,/2/);assert.match(html,/mínimo/i);
});
test('admin history explains changed discount thresholds instead of suppressing nested rule values',()=>{
 const html=admin.renderAuditHistory([{createdAt:'2026-11-05T17:00:00Z',operation:'discount_rule_save',entityType:'discount_rule',actor:'demo-admin',changes:{before:{tiers:[{minOrders:1,type:'fixed',value:5000}]},after:{tiers:[{minOrders:2,type:'percent',value:2500}]}}}]);
 assert.match(html,/Descuentos actualizados/);assert.match(html,/Desde 1/);assert.match(html,/50,00/);assert.match(html,/Desde 2/);assert.match(html,/25 %/);
});
test('read-only refresh delivers current operational data and rejects old sessions',async()=>{
 assert.equal(typeof admin.refreshAdminState,'function');let apply,finish;const session={authenticated:true,request:async()=>({windowUsage:[{windowId:'am',occupied:3}]})};
 assert.equal(await admin.refreshAdminState(session,{isCurrent:()=>true,onState:state=>{apply=state;}}),true);assert.equal(apply.windowUsage[0].occupied,3);
 const pending=admin.refreshAdminState({...session,request:()=>new Promise(resolve=>{finish=resolve;})},{isCurrent:()=>false,onState:()=>{throw Error('stale state rendered');}});finish({windowUsage:[]});assert.equal(await pending,false);
});
