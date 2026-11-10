import test from 'node:test';
import assert from 'node:assert/strict';
import {createTryServer} from '../server.mjs';
import {createZoneDemoState} from '../src/shipping/zones.mjs';
import {createMemoryRepository} from '../src/shipping/memory.mjs';
async function app(t,initial=createZoneDemoState()){
  const repository=createMemoryRepository(initial);
  const server=createTryServer({env:{SHIPPING_MODE:'demo',SHIPPING_PRICING_MODE:'zones',SHIPPING_DEMO_ADMIN_ENABLED:'true',SHIPPING_MERCHANT_ID:'marea',SHIPPING_RATE_LIMIT_MAX:'1000'},dependencies:{shippingRepository:repository}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(path,body,token,method=body?'POST':'GET',headers={}){
    const response=await fetch(base+'/api/v1/shipping'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};
  }
  const token=(await request('/admin/demo-session',{merchantId:'marea'})).data.accessToken;
  return {request,token,repository,base};
}
const rule={areaId:'*',enabled:true,tiers:[{minOrders:1,type:'fixed',value:5000},{minOrders:2,type:'fixed',value:10000}]};
async function buyerQuote(request,windowId){
 const context=await request('/store/checkouts',{items:[{productId:'soft-knit-sweater',size:'M',quantity:1}]});assert.equal(context.status,201);
 const contextToken=context.data.contextToken;
 const address=await request('/addresses/resolve',{contextToken,areaId:'pocitos'});assert.equal(address.status,200);
 const result=await request('/quotes',{contextToken,addressId:address.data.address.id,confirmed:true});assert.equal(result.status,200);
 const quote=windowId?result.data.quotes.find(row=>row.windowId===windowId):result.data.quotes[0];assert.ok(quote);
 return {contextToken,quote};
}
test('commerce admin confirms a held order so the next cart counts three confirmed orders exactly once',async t=>{
 const {request,token,repository}=await app(t);const deliveryDate=(await repository.snapshot('marea','demo')).days[0].deliveryDate;
 assert.equal((await request('/admin/delivery-windows',{window:{id:'am',deliveryDate,startTime:'10:00',endTime:'13:00',capacity:12,enabled:true}},token,'PUT')).status,200);
 assert.equal((await request('/admin/discount-rules',{rule},token,'PUT')).status,200);
 for(let index=0;index<2;index++)assert.equal((await request('/admin/shipments',{areaId:'pocitos',deliveryDate,windowId:'am',priceMinor:24900},token,'POST',{'Idempotency-Key':`confirmed-example-${index}`})).status,201);
 const first=await buyerQuote(request,'am');assert.equal(first.quote.calculation.confirmedCount,2);
 const held=await request('/reservations',{contextToken:first.contextToken,quoteId:first.quote.id},null,'POST',{'Idempotency-Key':'new-customer'});
 assert.equal(held.status,201);assert.equal(held.data.reservation.status,'held');
 assert.equal((await buyerQuote(request,'am')).quote.calculation.confirmedCount,2);
 const path=`/admin/shipments/${held.data.reservation.id}/confirm`;
 assert.equal((await request(path,{})).status,401);
 assert.equal((await request(path,{merchantId:'another-store'},token)).status,403);
 assert.equal((await request(path,{actorId:'forged',serverAuthorized:true,paid:true},token)).status,400);
 const confirmed=await request(path,{},token);assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
 assert.equal(confirmed.data.shipment.status,'confirmed');assert.equal(confirmed.data.shipment.priceMinor,14900);
 assert.equal((await buyerQuote(request,'am')).quote.calculation.confirmedCount,3);
 assert.equal((await request(path,{},token)).status,200);
 const next=await buyerQuote(request,'am');assert.equal(next.quote.calculation.confirmedCount,3);assert.equal(next.quote.priceMinor,14900);
 const audit=(await request('/admin/audit',undefined,token)).data.auditEvents.filter(event=>event.operation==='confirm'&&event.entityId===held.data.reservation.id);
 assert.equal(audit.length,1);assert.equal(audit[0].actor,'demo-admin');assert.deepEqual(audit[0].changes,{before:{status:'held'},after:{status:'confirmed'}});
});
test('five shopper choices follow current TRAMO rules rates and windows while accepted reservations retain their price',async t=>{
 const initial=createZoneDemoState(),deliveryDate=initial.days[0].deliveryDate;initial.days=[];initial.promotions=[];initial.discountRules=[rule];
 initial.windows=Array.from({length:8},(_,index)=>({id:`w${index}`,deliveryDate,startTime:`${String(index+8).padStart(2,'0')}:00`,endTime:`${String(index+9).padStart(2,'0')}:00`,capacity:20,enabled:true,version:1}));
 initial.routes=[{id:'late-route',windowId:'w6',deliveryDate,departureAt:`${deliveryDate}T14:00:00-03:00`,version:1,capacity:20,stops:[{shipmentId:'seed-a',placeId:'zone:pocitos',status:'confirmed',priceMinor:24900},{shipmentId:'seed-b',placeId:'zone:pocitos',status:'confirmed',priceMinor:24900}]}];
 const {request,token,repository}=await app(t,initial);
 async function cartOptions(){const result=await request('/store/checkouts',{items:[{productId:'soft-knit-sweater',size:'M',quantity:1}]});const contextToken=result.data.contextToken;const address=(await request('/addresses/resolve',{contextToken,areaId:'pocitos'})).data.address;
  const quotes=await request('/quotes',{contextToken,addressId:address.id,confirmed:true});assert.equal(quotes.status,200);assert.equal(quotes.data.quotes.length,5);return {contextToken,quotes:quotes.data.quotes};}
 const first=await cartOptions();assert.deepEqual(first.quotes.map(row=>row.windowId),['w0','w1','w2','w3','w6']);
 const cheapest=first.quotes.find(row=>row.windowId==='w6');assert.equal(cheapest.priceMinor,14900);
 const body={contextToken:first.contextToken,quoteId:cheapest.id},headers={'Idempotency-Key':'accepted-before-tramo-update'};
 const held=await request('/reservations',body,null,'POST',headers);assert.equal(held.status,201);
 assert.equal((await request('/admin/discount-rules',{rule:{...rule,tiers:[{minOrders:3,type:'fixed',value:10000}]}},token,'PUT')).status,200);
 const changedRules=await cartOptions();assert.deepEqual(changedRules.quotes.map(row=>row.windowId),['w0','w1','w2','w3','w4']);assert.ok(changedRules.quotes.every(row=>row.priceMinor===24900));
 assert.equal((await request('/admin/zone-rates',{areaId:'pocitos',priceMinor:29900,enabled:true},token,'PUT')).status,200);
 assert.ok((await cartOptions()).quotes.every(row=>row.priceMinor===29900));
 assert.equal((await request('/admin/delivery-windows',{window:{...initial.windows[0],enabled:false}},token,'PUT')).status,200);
 const closed=await cartOptions();assert.ok(closed.quotes.every(row=>row.windowId!=='w0'));assert.equal(closed.quotes[0].windowId,'w1');
 assert.equal((await request('/reservations',body,null,'POST',headers)).data.reservation.priceMinor,14900);
 assert.equal((await repository.snapshot('marea','demo')).shipments.find(row=>row.id===held.data.reservation.id).priceMinor,14900);
});
test('admin confirmation cannot revive cancelled or expired reservations',async t=>{
 const {request,token}=await app(t);
 const first=await buyerQuote(request);const cancelled=await request('/reservations',{contextToken:first.contextToken,quoteId:first.quote.id},null,'POST',{'Idempotency-Key':'cancel-before-confirm'});assert.equal(cancelled.status,201);
 const cancelledId=cancelled.data.reservation.id;
 assert.equal((await request(`/admin/shipments/${cancelledId}`,{status:'cancelled',reason:'Pedido cancelado'},token,'PATCH')).status,200);
 assert.equal((await request(`/admin/shipments/${cancelledId}/confirm`,{},token)).status,409);
 const second=await buyerQuote(request);const expiring=await request('/reservations',{contextToken:second.contextToken,quoteId:second.quote.id},null,'POST',{'Idempotency-Key':'expire-before-confirm'});assert.equal(expiring.status,201);
 const clock=Date.now;try{Date.now=()=>Date.parse(expiring.data.reservation.expiresAt)+1;
  assert.equal((await request(`/admin/shipments/${expiring.data.reservation.id}/confirm`,{},token)).status,410);
 }finally{Date.now=clock;}
 assert.equal((await request('/admin/shipments/missing/confirm',{},token)).status,404);
});
test('independent portal bootstraps auth without a store catalog and scopes admin requests',async t=>{
  const {request,token}=await app(t);const config=await request('/portal-config');assert.equal(config.status,200);assert.equal(config.data.product,'TRAMO');assert.equal(config.data.demoMerchantId,'marea');assert.equal(config.data.merchant,undefined);
  assert.equal((await request('/admin/discount-rules?merchantId=marea')).status,401);
  assert.equal((await request('/admin/discount-rules?merchantId=other',undefined,token)).status,403);
  assert.equal((await request('/admin/discount-rules?merchantId=marea',undefined,token)).status,200);
});
test('admin saves flexible discount tiers and a disabled zone exception without leaking another commerce',async t=>{
  const {request,token}=await app(t);
  const saved=await request('/admin/discount-rules',{merchantId:'marea',rule},token,'PUT');assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.rule.tiers.length,2);
  assert.equal((await request('/admin/discount-rules',{merchantId:'marea',rule:{...rule,areaId:'unknown'}},token,'PUT')).status,400);
  assert.equal((await request('/admin/discount-rules',{merchantId:'marea',rule:{...rule,tiers:[...rule.tiers,rule.tiers[0]]}},token,'PUT')).status,400);
  const result=await request('/admin/overview?merchantId=marea',undefined,token);assert.equal(result.data.discountRules.length,1);assert.ok(Array.isArray(result.data.windows));
});
test('admin windows and preview govern real shopper quotes with no arbitrary counts',async t=>{
  const {request,token,repository}=await app(t);const state=await repository.snapshot('marea','demo');const deliveryDate=state.days[0].deliveryDate;
  const window={id:'am',deliveryDate,startTime:'10:00',endTime:'13:00',capacity:12,enabled:true};
  assert.equal((await request('/admin/delivery-windows',{merchantId:'marea',window},token,'PUT')).status,200);
  assert.equal((await request('/admin/delivery-windows',{merchantId:'marea',window:{...window,id:'bad',endTime:'09:00'}},token,'PUT')).status,400);
  assert.equal((await request('/admin/discount-rules',{merchantId:'marea',rule},token,'PUT')).status,200);
  const preview=await request('/admin/pricing-preview',{merchantId:'marea',areaId:'pocitos',windowId:'am'},token);assert.equal(preview.status,201,JSON.stringify(preview.data));assert.equal(preview.data.calculation.confirmedCount,0);assert.equal(preview.data.calculation.priceMinor,24900);
  assert.equal((await request('/admin/pricing-preview',{merchantId:'marea',areaId:'pocitos',windowId:'am',confirmedCount:99},token)).status,400);
  const context=(await request('/store/checkouts',{items:[{productId:'soft-knit-sweater',size:'M',quantity:1}]})).data.contextToken;
  const address=(await request('/addresses/resolve',{contextToken:context,areaId:'pocitos'})).data.address;
  const quotes=await request('/quotes',{contextToken:context,addressId:address.id,confirmed:true});const quote=quotes.data.quotes.find(row=>row.windowId==='am');assert.ok(quote);assert.equal(quote.windowStart,'10:00');assert.equal(quote.priceMinor,preview.data.calculation.priceMinor);assert.equal(quote.calculation.source,'base');assert.equal(quote.candidateRoute,undefined);
});
test('admin can close an expired offer even when its old price is below the new minimum',async t=>{
  const {request,token,repository}=await app(t);
  await repository.mutate('promotion_save',{merchantId:'marea',mode:'demo',actorId:'demo-admin',promotion:{id:'old-offer',areaId:'pocitos',deliveryDate:'2020-01-01',priceMinor:100,active:true}});
  const result=await request('/admin/promotions/old-offer',{merchantId:'marea',active:false},token,'PATCH');assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.promotion.active,false);
});
test('legacy departure can be closed or expanded but cannot reduce capacity below assignments',async t=>{
 const initial=createZoneDemoState(),day=initial.days[0];initial.routes=[{id:'legacy',deliveryDate:day.deliveryDate,departureAt:`${day.deliveryDate}T10:00:00-03:00`,version:1,capacity:3,stops:[{shipmentId:'a',placeId:'zone:pocitos',status:'confirmed',priceMinor:24900},{shipmentId:'b',placeId:'zone:pocitos',status:'confirmed',priceMinor:24900}]}];
 const {request,token,repository}=await app(t,initial);const {version,...values}=day;
 assert.equal((await request('/admin/service-days',{merchantId:'marea',day:{...values,capacity:1}},token,'PUT')).status,409);
 assert.equal((await request('/admin/service-days',{merchantId:'marea',day:{...values,capacity:5}},token,'PUT')).status,200);assert.equal((await repository.snapshot('marea','demo')).routes[0].capacity,5);
 assert.equal((await request('/admin/service-days',{merchantId:'marea',day:{...values,enabled:false}},token,'PUT')).status,200);
});
test('admin targets a published window beyond the shopper option limit for preview and external order',async t=>{
 const initial=createZoneDemoState();initial.windows=[];initial.promotions=[];
 for(let day=1;day<=6;day++){const deliveryDate=new Date(Date.now()+day*86400000).toISOString().slice(0,10);for(let hour=0;hour<20;hour++)initial.windows.push({id:`day${day}-${hour}`,deliveryDate,startTime:`${String(hour).padStart(2,'0')}:00`,endTime:`${String(hour).padStart(2,'0')}:30`,capacity:10,enabled:true,version:1});}
 const {request,token}=await app(t,initial),window=initial.windows.at(-1),body={merchantId:'marea',areaId:'pocitos',windowId:window.id,deliveryDate:window.deliveryDate};
 assert.equal((await request('/admin/pricing-preview',body,token)).status,201);
 assert.equal((await request('/admin/shipments',{...body,priceMinor:24900},token,'POST',{'Idempotency-Key':'window-120'})).status,201);
});
