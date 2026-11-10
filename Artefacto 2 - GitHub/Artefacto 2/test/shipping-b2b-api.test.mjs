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
