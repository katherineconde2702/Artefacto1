import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createTryServer } from '../server.mjs';
import { createDemoState, createDemoProvider } from '../src/shipping/demo.mjs';
import { createMemoryRepository } from '../src/shipping/memory.mjs';

const cart = {merchantId:'marea', items:[{productId:'soft-knit-sweater',size:'M',quantity:2}]};
async function app(t, options={}) {
  const env={SHIPPING_MODE:'demo',SHIPPING_PRICING_MODE:'distance',SHIPPING_DEMO_ADMIN_ENABLED:'true',SHIPPING_CHECKOUT_SECRET:'test-only-context-secret-at-least-32-characters',TRY_RATE_LIMIT_MAX:'0',SHIPPING_RATE_LIMIT_MAX:'1000',...options.env};
  const repository=options.repository || createMemoryRepository(createDemoState());
  const server=createTryServer({env,dependencies:{shippingRepository:repository,shippingProvider:options.provider || createDemoProvider(),...options.dependencies}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(path,body,headers={},method=body===undefined?'GET':'POST') {
    return new Promise((resolve,reject)=>{
      const request=httpRequest(`${base}${path.startsWith('/api/')?path:'/api/v1/shipping'+path}`,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers}},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:response.statusCode,data,headers:new Headers(response.headers)});});
      });request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  return {request,base,repository};
}
async function context(request) {const r=await request('/checkouts',cart);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function quote(request,ctx) {
  const resolved=await request('/addresses/resolve',{contextToken:ctx.contextToken,inputAddress:'Pocitos'});assert.equal(resolved.status,200,JSON.stringify(resolved.data));
  const quoted=await request('/quotes',{contextToken:ctx.contextToken,addressId:resolved.data.address.id,confirmed:true});assert.equal(quoted.status,200,JSON.stringify(quoted.data));
  return {address:resolved.data.address,quotes:quoted.data.quotes};
}
async function admin(request) {const r=await request('/admin/demo-session',{merchantId:'marea'});assert.equal(r.status,201,JSON.stringify(r.data));return {Authorization:`Bearer ${r.data.accessToken}`};}

test('zone configuration publishes preloaded Uruguay selectors without Google credentials or a Google origin',async t=>{
  const state=createDemoState();state.merchant.originPlaceId=null;state.zoneRates=[];
  const {request}=await app(t,{env:{SHIPPING_PRICING_MODE:'zones'},repository:createMemoryRepository(state)});
  const result=await request('/config');assert.equal(result.status,200);
  assert.equal(result.data.pricingMode,'zones');assert.equal(result.data.available,true);
  assert.equal(result.data.departments.length,19);
  assert.equal(result.data.departments.find(row=>row.id==='rio-negro').name,'Río Negro');
  assert.equal(result.data.areas.filter(row=>row.kind==='department').length,18);
  assert.equal(result.data.areas.filter(row=>row.departmentId==='montevideo').length,62);
  assert.doesNotMatch(JSON.stringify(result.data),/GOOGLE_MAPS_SERVER_KEY|originPlaceId|secret/);
});

function zoneState() {
  const state=createDemoState();state.merchant.originPlaceId=null;state.routes=[];state.shipments=[];
  state.areas.push({id:'dept-canelones',name:'Canelones',country:'UY',departmentId:'canelones',kind:'department'});
  state.zoneRates=[{areaId:'pocitos',priceMinor:24900,enabled:true,version:1},{areaId:'malvin',priceMinor:24900,enabled:true,version:1},{areaId:'dept-canelones',priceMinor:39900,enabled:true,version:1}];
  return state;
}
async function zoneApp(t,options={}) {
  return app(t,{...options,env:{SHIPPING_PRICING_MODE:'zones',...options.env},repository:options.repository||createMemoryRepository(zoneState())});
}
const storeCart={items:cart.items};
test('storefront checkout is server-scoped and zone quotes reserve the canonical manual tariff',async t=>{
  const {request}=await zoneApp(t);
  assert.equal((await request('/store/checkouts',{...storeCart,merchantId:'other'})).status,400);
  assert.equal((await request('/store/checkouts',{items:[{...cart.items[0],unitPriceMinor:1}]})).status,400);
  const context=await request('/store/checkouts',storeCart);assert.equal(context.status,201,JSON.stringify(context.data));
  assert.equal(context.data.checkout.subtotalMinor,558000);
  const token=context.data.contextToken;
  for(const body of [{areaId:'unknown'},{areaId:'dept-montevideo'},{inputAddress:'Pocitos'}])assert.equal((await request('/addresses/resolve',{contextToken:token,...body})).status,400);
  const dest=await request('/addresses/resolve',{contextToken:token,areaId:'dept-canelones'});assert.equal(dest.status,200);
  assert.equal(dest.data.address.provider,'zones');assert.equal(dest.data.address.departmentId,'canelones');
  assert.doesNotMatch(JSON.stringify(dest.data),/Plaza|Google|placeId/);
  const quotes=await request('/quotes',{contextToken:token,addressId:dest.data.address.id,confirmed:true});assert.equal(quotes.status,200);
  assert.equal(quotes.data.quotes.length,3);assert.equal(quotes.data.quotes[0].priceMinor,39900);
  assert.doesNotMatch(JSON.stringify(quotes.data),/distanceMeters|durationSeconds|candidateRoute|otherStops/);
  const held=await request('/reservations',{contextToken:token,quoteId:quotes.data.quotes[0].id},{'Idempotency-Key':'zone-accepted'});assert.equal(held.status,201);
  assert.equal(held.data.reservation.priceMinor,39900);
});
test('admin can configure zone tariffs while unknown zones and sub-minimum prices fail closed',async t=>{
  const {request,repository}=await zoneApp(t);const access=await admin(request);
  assert.equal((await request('/admin/zone-rates',{areaId:'dept-canelones',priceMinor:45000,enabled:true},{},'PUT')).status,401);
  assert.equal((await request('/admin/zone-rates',{areaId:'unknown',priceMinor:45000,enabled:true},access,'PUT')).status,400);
  assert.equal((await request('/admin/zone-rates',{areaId:'dept-canelones',priceMinor:100,enabled:true},access,'PUT')).status,400);
  const saved=await request('/admin/zone-rates',{areaId:'dept-canelones',priceMinor:45050,enabled:true},access,'PUT');assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(saved.data.zoneRates.find(row=>row.areaId==='dept-canelones').priceMinor,45050);
  const state=await repository.snapshot('marea','demo');assert.equal(state.policy.version,2);
  assert.equal((await request('/admin/overview',undefined,access)).data.pricingMode,'zones');
  const token=(await request('/store/checkouts',storeCart)).data.contextToken;
  const dest=(await request('/addresses/resolve',{contextToken:token,areaId:'centro'})).data.address;
  const unavailable=await request('/quotes',{contextToken:token,addressId:dest.id,confirmed:true});assert.equal(unavailable.status,200);assert.deepEqual(unavailable.data.quotes,[]);
});
test('live zone mode needs no Google key and public storefront is opt-in without disclosing its merchant key',async t=>{
  const calls=[],state={...zoneState(),mode:'live'};
  const env={SHIPPING_MODE:'live',SHIPPING_PRICING_MODE:'zones',SUPABASE_URL:'https://private-demo.supabase.co',SUPABASE_SECRET_KEY:'private-database-canary',SHIPPING_MERCHANT_API_KEY:'private-merchant-canary',SHIPPING_STOREFRONT_ENABLED:'true'};
  const fetchImpl=async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    if(url.endsWith('/shipping_snapshot'))return {ok:true,json:async()=>state};
    if(url.endsWith('/shipping_mutate'))return {ok:true,json:async()=>({id:JSON.parse(options.body).p_payload.id})};
    throw Error('Unexpected outbound destination');
  };
  const {request}=await app(t,{env,dependencies:{shippingRepository:undefined,shippingProvider:undefined,shippingFetch:fetchImpl}});
  const config=await request('/config');assert.equal(config.data.available,true);
  const result=await request('/store/checkouts',storeCart);assert.equal(result.status,201,JSON.stringify(result.data));
  assert.equal((await request('/checkouts',cart)).status,401,'integration endpoint stays private');
  assert.equal((await request('/store/checkouts',{...storeCart,merchantId:'other'})).status,400);
  assert.doesNotMatch(JSON.stringify(result.data),/private-merchant-canary|private-database-canary/);
  assert.ok(calls.every(call=>call.url.startsWith('https://private-demo.supabase.co/rest/v1/rpc/')));
  const off=await app(t,{env:{...env,SHIPPING_STOREFRONT_ENABLED:'false'},dependencies:{shippingRepository:undefined,shippingProvider:undefined,shippingFetch:fetchImpl}});
  assert.equal((await off.request('/store/checkouts',storeCart)).status,403);
});

// Catches discarded cancellation metadata, body actor impersonation and duplicate transition audit.
test('cancellation retains first verified actor/reason/time and admin audit identifies the shipment',async t=>{
  const {request}=await app(t);const access=await admin(request);const ctx=await context(request);const {quotes}=await quote(request,ctx);
  const held=(await request('/reservations',{contextToken:ctx.contextToken,quoteId:quotes[0].id},{'Idempotency-Key':'cancel-audit'})).data.reservation;
  const path=`/admin/shipments/${held.id}`;
  assert.equal((await request(path,{status:'cancelled',reason:'x'},access,'PATCH')).status,400);
  const cancelled=await request(path,{status:'cancelled',reason:'  Pedido del comprador  ',actorId:'forged-user'},access,'PATCH');
  assert.equal(cancelled.status,200);assert.equal(cancelled.data.shipment.cancellationReason,'Pedido del comprador');
  assert.equal(cancelled.data.shipment.cancelledBy,'demo-admin');assert.ok(Number.isFinite(Date.parse(cancelled.data.shipment.cancelledAt)));
  const retry=await request(path,{status:'cancelled',reason:'Otro motivo'},access,'PATCH');assert.deepEqual(retry.data,cancelled.data);
  assert.equal((await request('/admin/audit')).status,401);
  assert.equal((await request('/admin/audit?merchantId=other',undefined,access)).status,403);
  const history=await request('/admin/audit',undefined,access);assert.equal(history.status,200);
  const events=history.data.auditEvents.filter(event=>event.operation==='cancel');assert.equal(events.length,1);
  assert.equal(events[0].entityType,'shipment');assert.equal(events[0].entityId,held.id);assert.equal(events[0].actor,'demo-admin');assert.equal(events[0].mode,'demo');
  assert.deepEqual(events[0].changes,{before:{status:'held'},after:{status:'cancelled'}});
  assert.doesNotMatch(JSON.stringify(events),/Pedido del comprador|Pocitos|contextToken|forged-user|placeId/);
  const overview=(await request('/admin/overview',undefined,access)).data;assert.deepEqual(overview.auditEvents,history.data.auditEvents);
  assert.equal(overview.shipments.find(row=>row.id===held.id).cancellationReason,'Pedido del comprador');
});

test('shipping tariff audit captures allowlisted before/after values in descending bounded merchant history',async t=>{
  const {request,repository}=await zoneApp(t);const access=await admin(request);
  await request('/admin/zone-rates',{areaId:'pocitos',priceMinor:300150,enabled:true},access,'PUT');
  const first=(await request('/admin/audit',undefined,access)).data.auditEvents?.[0];assert.ok(first);
  assert.equal(first.entityType,'zone_rate');assert.equal(first.entityId,'pocitos');assert.equal(first.actor,'demo-admin');
  assert.deepEqual(first.changes,{before:{priceMinor:24900,enabled:true},after:{priceMinor:300150,enabled:true}});
  for(let index=0;index<101;index++)await repository.mutate('zone_rate_save',{merchantId:'marea',mode:'demo',actorId:'demo-admin',areaId:'pocitos',priceMinor:300200+index,enabled:true});
  const events=(await request('/admin/audit',undefined,access)).data.auditEvents;
  assert.equal(events.length,100);assert.equal(events[0].changes.after.priceMinor,300300);assert.equal(events[99].changes.after.priceMinor,300201);
});

// These tests catch shipping dispatch missing, public secrets, and client-controlled totals.
test('shipping config exposes demo capability and public Auth config without private keys',async t=>{
  const {request}=await app(t,{env:{SUPABASE_URL:'https://personal.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_public',SUPABASE_SECRET_KEY:'private-canary',GOOGLE_MAPS_SERVER_KEY:'maps-canary'}});
  const r=await request('/config?merchantId=marea');assert.equal(r.status,200);assert.equal(r.data.mode,'demo');assert.equal(r.data.available,true);assert.equal(r.data.demoAdminAvailable,true);assert.equal(r.data.supabase.publishableKey,'sb_publishable_public');assert.doesNotMatch(JSON.stringify(r.data),/private-canary|maps-canary|originPlaceId/);
});
test('checkout validates catalog sizes and quantities and calculates canonical UYU lines',async t=>{
  const {request}=await app(t);const ctx=await context(request);assert.equal(ctx.checkout.subtotalMinor,558000);assert.equal(ctx.checkout.currency,'UYU');assert.equal(ctx.checkout.items[0].unitPriceMinor,279000);assert.equal(ctx.checkout.items[0].lineTotalMinor,558000);assert.ok(ctx.contextToken);assert.doesNotMatch(ctx.contextToken,/marea|soft-knit/);
  for(const body of [{...cart,currency:'USD'},{...cart,subtotalMinor:1},{...cart,items:[{...cart.items[0],priceMinor:1}]},{...cart,items:[{...cart.items[0],size:'XXL'}]},{...cart,items:[{...cart.items[0],quantity:0}]},{...cart,items:[{...cart.items[0],quantity:1.5}]},{...cart,items:[]},{...cart,merchantId:'other'}]) assert.ok((await request('/checkouts',body)).status>=400);
});
test('signed checkout context rejects tampering and cross-instance replay',async t=>{
  const one=await app(t);const two=await app(t);const ctx=await context(one.request);
  for(const [request,token]of [[one.request,ctx.contextToken.slice(0,-5)+'wrong'],[two.request,ctx.contextToken]])assert.equal((await request('/addresses/resolve',{contextToken:token,inputAddress:'Pocitos'})).status,401);
});
test('confirmed buyer destination produces private-route-free quotes and rejects foreign address ownership',async t=>{
  const {request}=await app(t);const ctx=await context(request);const other=await context(request);const {address,quotes}=await quote(request,ctx);
  assert.equal(quotes.length,3);assert.equal(quotes[0].currency,'UYU');assert.ok(quotes.every(q=>q.priceMinor>0&&q.mode==='demo'));
  assert.doesNotMatch(JSON.stringify(quotes),/candidateRoute|stopPlaceIds|shipmentId|metrics|safetyScenarios|originPlaceId/);
  assert.equal((await request('/quotes',{contextToken:other.contextToken,addressId:address.id,confirmed:true})).status,403);
  assert.equal((await request('/quotes',{contextToken:ctx.contextToken,addressId:address.id,confirmed:false})).status,400);
  assert.ok((await request('/addresses/resolve',{contextToken:ctx.contextToken,inputAddress:'fake arbitrary street'})).status>=400);
});
test('reservation is idempotent, preserves price, and cannot be confirmed by another checkout',async t=>{
  const {request}=await app(t);const ctx=await context(request);const other=await context(request);const {quotes}=await quote(request,ctx);
  const body={contextToken:ctx.contextToken,quoteId:quotes[0].id};const headers={'Idempotency-Key':'checkout-reservation-123'};
  assert.equal((await request('/reservations',body)).status,400);
  const r=await request('/reservations',body,headers);assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.reservation.priceMinor,quotes[0].priceMinor);assert.equal(r.data.reservation.status,'held');
  const replay=await request('/reservations',body,headers);assert.deepEqual(replay.data,r.data);
  assert.equal((await request('/reservations',{...body,quoteId:quotes[1].id},headers)).status,409);
  assert.equal((await request('/reservations',{contextToken:other.contextToken,quoteId:quotes[0].id},{'Idempotency-Key':'other'})).status,403);
  const id=r.data.reservation.id;
  assert.equal((await request(`/reservations/${id}/demo-confirm`,{contextToken:other.contextToken})).status,403);
  assert.equal((await request(`/shipments/${id}/confirm`,{paid:true})).status,401);
  assert.equal((await request(`/shipments/${id}/cancel`,{contextToken:ctx.contextToken,reason:'changed mind'})).status,401);
  const confirmed=await request(`/reservations/${id}/demo-confirm`,{contextToken:ctx.contextToken});assert.equal(confirmed.status,200);assert.equal(confirmed.data.reservation.status,'confirmed');assert.equal(confirmed.data.reservation.demo,true);
  assert.equal((await request(`/reservations/${id}`)).status,404);
});
test('route changes after quoting yield conflict rather than accepting stale capacity',async t=>{
  const {request}=await app(t);const ctx=await context(request);const other=await context(request);const a=await quote(request,ctx);const b=await quote(request,other);
  assert.equal((await request('/reservations',{contextToken:ctx.contextToken,quoteId:a.quotes[0].id},{'Idempotency-Key':'first'})).status,201);
  assert.equal((await request('/reservations',{contextToken:other.contextToken,quoteId:b.quotes[0].id},{'Idempotency-Key':'second'})).status,409);
});
test('demo admin requires explicit opt in, local socket and Host, nonproduction and allowed Origin',async t=>{
  for(const env of [{SHIPPING_DEMO_ADMIN_ENABLED:'false'},{NODE_ENV:'production'}]){const {request}=await app(t,{env});assert.equal((await request('/admin/demo-session',{merchantId:'marea'})).status,403);}
  const {request,base}=await app(t);
  for(const headers of [{Host:'production.example'},{Host:'production.example','X-Forwarded-Host':new URL(base).host,'X-Forwarded-For':'127.0.0.1'},{Origin:'https://evil.example'}])assert.equal((await request('/admin/demo-session',{merchantId:'marea'},headers)).status,403);
  const access=await admin(request);assert.equal((await request('/admin/overview?merchantId=marea',undefined,access)).status,200);
  assert.equal((await request('/admin/overview?merchantId=marea',undefined,{...access,Host:'production.example'})).status,403);
  assert.equal((await request('/admin/overview?merchantId=marea')).status,401);
});
test('shipping administrator cannot read or change garment prices and store checkout keeps its canonical prices',async t=>{
  const {request}=await app(t);const access=await admin(request);
  assert.equal((await request('/admin/prices?merchantId=marea',undefined,access)).status,404);
  const saved=await request('/admin/prices',{merchantId:'marea',prices:{'soft-knit-sweater':300100}},access,'PUT');assert.equal(saved.status,404,JSON.stringify(saved.data));
  const single=await request('/api/v1/products/soft-knit-sweater');assert.equal(single.data.price,2790);assert.equal(single.data.targetFit,'oversized');assert.equal(single.data.sizes.length,4);
  const all=await request('/api/v1/products');assert.equal(all.data.find(p=>p.id==='soft-knit-sweater').price,2790);assert.equal((await context(request)).checkout.subtotalMinor,558000);
});
test('shipping overview and history exclude garment pricing while retaining delivery conditions',async t=>{
  const {request,repository}=await zoneApp(t);const access=await admin(request);
  await repository.mutate('zone_rate_save',{merchantId:'marea',mode:'demo',actorId:'demo-admin',areaId:'pocitos',priceMinor:26000,enabled:true});
  await repository.mutate('price_save',{merchantId:'marea',mode:'demo',actorId:'demo-admin',productId:'soft-knit-sweater',priceMinor:300100});
  const overview=(await request('/admin/overview',undefined,access)).data;
  assert.equal(Object.hasOwn(overview,'prices'),false);
  assert.equal(overview.zoneRates.find(rate=>rate.areaId==='pocitos').priceMinor,26000);
  const audit=(await request('/admin/audit',undefined,access)).data;
  for(const events of [overview.auditEvents,audit.auditEvents]){
    assert.equal(events.length,1);assert.equal(events[0].entityType,'zone_rate');assert.equal(events[0].entityId,'pocitos');
  }
});
test('admin validates policy, service dates and promotional floors and denies merchant impersonation',async t=>{
  const {request}=await app(t);const access=await admin(request);const overview=await request('/admin/overview?merchantId=marea',undefined,access);
  const policy={...overview.data.policy,minimumMinor:16000};assert.equal((await request('/admin/settings',{merchantId:'marea',policy},access,'PUT')).status,200);
  assert.equal((await request('/admin/settings',{merchantId:'marea',policy:{...policy,marginBps:10000}},access,'PUT')).status,400);
  const day=overview.data.days[0];assert.equal((await request('/admin/service-days',{merchantId:'marea',day:{...day,capacity:11}},access,'PUT')).status,400);
  assert.equal((await request('/admin/service-days',{merchantId:'marea',day:{...day,deliveryDate:'2026-02-30'}},access,'PUT')).status,400);
  assert.equal((await request('/admin/promotions',{merchantId:'marea',areaId:'pocitos',deliveryDate:day.deliveryDate,priceMinor:100,active:true},access)).status,400);
  assert.equal((await request('/admin/promotions',{merchantId:'marea',areaId:'pocitos',deliveryDate:day.deliveryDate,priceMinor:16000,active:true},access)).status,201);
  assert.equal((await request('/admin/overview?merchantId=other',undefined,access)).status,403);
});
test('admin external shipment resolves its address and computes a real candidate before accepting first route',async t=>{
  const {request}=await app(t);const access=await admin(request);const state=await request('/admin/overview?merchantId=marea',undefined,access);const body={merchantId:'marea',inputAddress:'Pocitos',deliveryDate:state.data.days[0].deliveryDate,priceMinor:100000};
  const r=await request('/admin/shipments',body,{...access,'Idempotency-Key':'external-first'});assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.shipment.status,'confirmed');assert.equal(r.data.shipment.address.placeId,'demo-pocitos');
  const cancelled=await request(`/admin/shipments/${r.data.shipment.id}`,{merchantId:'marea',status:'cancelled',reason:'Cancelación del comercio'},access,'PATCH');assert.equal(cancelled.status,200);assert.equal(cancelled.data.shipment.status,'cancelled');
  assert.equal((await request('/admin/shipments',{...body,inputAddress:'unverified address'},{...access,'Idempotency-Key':'external-unverified'})).status,422);
});
test('unconfigured live mode fails closed and exposes no simulated availability or admin entry',async t=>{
  const {request}=await app(t,{env:{SHIPPING_MODE:'live'},dependencies:{shippingRepository:undefined,shippingProvider:undefined}});
  const r=await request('/config');assert.equal(r.status,200);assert.equal(r.data.mode,'live');assert.equal(r.data.available,false);assert.equal(r.data.demoAdminAvailable,false);
  assert.equal((await request('/checkouts',cart)).status,503);assert.equal((await request('/admin/demo-session',{merchantId:'marea'})).status,403);
});
test('shipping cost endpoints rate limit independently and allow idempotency preflights',async t=>{
  const {request,base}=await app(t,{env:{SHIPPING_RATE_LIMIT_MAX:'1'}});assert.equal((await request('/checkouts',cart)).status,201);const limited=await request('/checkouts',cart);assert.equal(limited.status,429);assert.ok(limited.data.requestId);
  const preflight=await request('/reservations',undefined,{Origin:base,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Idempotency-Key'},'OPTIONS');assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/Idempotency-Key/i);assert.match(preflight.headers.get('access-control-allow-methods'),/PUT/);
});
test('shipping provider failures are sanitized and carry request identifiers',async t=>{
  const provider={...createDemoProvider(),async resolveAddress(){throw Error('secret-key and private street canary');}};const {request}=await app(t,{provider});const ctx=await context(request);const r=await request('/addresses/resolve',{contextToken:ctx.contextToken,inputAddress:'Pocitos'});assert.equal(r.status,503);assert.ok(r.data.requestId);assert.ok(r.data.code);assert.doesNotMatch(JSON.stringify(r.data),/secret-key|private street/);
});
test('admin HTML permits only configured validated Supabase origin for direct login',async t=>{
  const {request}=await app(t,{env:{SUPABASE_URL:'https://personal.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public'}});const r=await request('/api/../admin/');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/connect-src 'self' https:\/\/personal.supabase.co;/);
  assert.equal((await request('/api/../checkout/')).status,200);
});

test('merchant confirmations require server credential and never accept browser paid flags',async t=>{
  const {request}=await app(t,{env:{SHIPPING_MERCHANT_API_KEY:'test-only-merchant-server-secret'}});const ctx=await context(request);const {quotes}=await quote(request,ctx);const held=await request('/reservations',{contextToken:ctx.contextToken,quoteId:quotes[0].id},{'Idempotency-Key':'merchant-held'});const path=`/shipments/${held.data.reservation.id}/confirm`;
  assert.equal((await request(path,{merchantId:'marea',paid:true,serverAuthorized:true})).status,401);
  const r=await request(path,{merchantId:'marea'},{Authorization:'Bearer test-only-merchant-server-secret'});assert.equal(r.status,200);assert.equal(r.data.shipment.status,'confirmed');assert.equal(r.data.shipment.demo,undefined);
});
test('live storage failures do not reveal provider messages or fall back to static prices',async t=>{
  const repository={async snapshot(){throw Error('secret database private address');}};
  const {request}=await app(t,{env:{SHIPPING_MODE:'live'},repository,provider:{mode:'google'}});
  assert.equal((await request('/config')).data.available,false);
  const result=await request('/api/v1/products');assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result.data),/secret database|private address/);
});
test('live admin verifies Auth and membership on each operation before exposing data',async t=>{
  const state=createDemoState();state.mode='live';state.merchant.originPlaceId='ChIJ-real-merchant-origin';
  let role='admin',authCalls=0,membershipCalls=0;
  const repository={async snapshot(){return structuredClone(state);},async adminContext(userId,merchantId){membershipCalls++;return role?{userId,merchantId,role}:null;}};
  const shippingFetch=async(url,init)=>{assert.equal(url,'https://personal.supabase.co/auth/v1/user');assert.equal(init.headers.Authorization,'Bearer verified-user-access-token');authCalls++;return Response.json({id:'real-user-id'});};
  const {request}=await app(t,{env:{SHIPPING_MODE:'live',SUPABASE_URL:'https://personal.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_public'},repository,provider:{mode:'google'},dependencies:{shippingFetch}});
  const access={Authorization:'Bearer verified-user-access-token'};
  assert.equal((await request('/admin/overview?merchantId=marea',undefined,access)).status,200);
  role=null;assert.equal((await request('/admin/overview?merchantId=marea',undefined,access)).status,403);assert.equal(authCalls,2);assert.equal(membershipCalls,2);
  assert.equal((await request('/admin/demo-session',{merchantId:'marea'})).status,403);
  assert.equal((await request('/reservations/foreign/demo-confirm',{contextToken:'fake'})).status,403);
});
test('unsafe public Auth keys and malformed Supabase URLs never reach config or browser policy',async t=>{
  for(const env of [{SUPABASE_URL:'https://personal.supabase.co/path',SUPABASE_PUBLISHABLE_KEY:'public'},{SUPABASE_URL:'https://personal.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_secret_private'},{SUPABASE_URL:'https://user:password@personal.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public'},{SUPABASE_URL:'https://personal.supabase.co',SUPABASE_PUBLISHABLE_KEY:`header.${Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')}.sig`}]){
    const {request}=await app(t,{env});assert.equal((await request('/config')).data.supabase,null);
  }
});
test('checkout handles expire at their server-side deadline',async()=>{
  const {createContextStore}=await import('../src/shipping/context.mjs');let now=1000;
  const store=createContextStore({secret:'test-only',now:()=>now});const token=store.issue({id:'checkout',expiresAt:new Date(2000).toISOString()});
  assert.equal(store.read(token).id,'checkout');now=2000;assert.throws(()=>store.read(token),error=>error.status===410);
});
test('shipping JSON requests retain existing body size and content type limits',async t=>{
  const {request}=await app(t,{env:{TRY_MAX_JSON_BYTES:'100'}});
  assert.equal((await request('/checkouts',{...cart,padding:'x'.repeat(200)})).status,413);
  assert.equal((await request('/checkouts',cart,{'Content-Type':'text/plain'})).status,415);
});
test('an accepted reservation replays after quote expiry while the checkout remains valid',async t=>{
  const {request}=await app(t);const ctx=await context(request);const {quotes}=await quote(request,ctx);const body={contextToken:ctx.contextToken,quoteId:quotes[0].id},headers={'Idempotency-Key':'expiry-replay'};const original=await request('/reservations',body,headers);assert.equal(original.status,201);
  const clock=Date.now;Date.now=()=>clock()+6*60000;
  try {assert.equal((await request('/addresses/resolve',{contextToken:ctx.contextToken,inputAddress:'Pocitos'})).status,200);const replay=await request('/reservations',body,headers);assert.equal(replay.status,201);assert.deepEqual(replay.data,original.data);assert.equal((await request('/reservations',body,{'Idempotency-Key':'unaccepted-expired-quote'})).status,410);} finally {Date.now=clock;}
});
test('admin Auth lookups on GET are rate limited before an unbounded external call',async t=>{
  const {request}=await app(t,{env:{SHIPPING_RATE_LIMIT_MAX:'2'}});const access=await admin(request);
  assert.equal((await request('/admin/overview',undefined,access)).status,200);
  assert.equal((await request('/admin/overview',undefined,access)).status,429);
});
test('a private server key accidentally reused in public configuration is omitted',async t=>{
  const {request}=await app(t,{env:{SUPABASE_URL:'https://personal.supabase.co',SUPABASE_PUBLISHABLE_KEY:'private-shared-canary',SUPABASE_SECRET_KEY:'private-shared-canary'}});const r=await request('/config');assert.equal(r.data.supabase,null);assert.doesNotMatch(JSON.stringify(r.data),/private-shared-canary/);
});
test('external shipment retries replay the accepted delivery and reject key reuse with changed contents',async t=>{
  let providerUnavailable=false;const real=createDemoProvider();const provider={...real,async resolveAddress(input){if(providerUnavailable)throw Error('Maps unavailable');return real.resolveAddress(input);}};
  const {request}=await app(t,{provider});const access=await admin(request);const overview=await request('/admin/overview',undefined,access);
  const body={merchantId:'marea',inputAddress:'Pocitos',deliveryDate:overview.data.days[0].deliveryDate,priceMinor:100000};const headers={...access,'Idempotency-Key':'external-order-123'};
  assert.equal((await request('/admin/shipments',body,access)).status,400);
  const first=await request('/admin/shipments',body,headers);assert.equal(first.status,201,JSON.stringify(first.data));providerUnavailable=true;
  const replay=await request('/admin/shipments',body,headers);assert.equal(replay.status,201);assert.deepEqual(replay.data,first.data);
  assert.equal((await request('/admin/shipments',{...body,priceMinor:110000},headers)).status,409);
  const updated=await request('/admin/shipments',undefined,access);assert.equal(updated.data.shipments.filter(row=>row.address?.inputAddress==='Pocitos').length,1);
});
test('expired demo credentials never reach real Supabase Auth after their local session was pruned',async t=>{
  let authCalls=0;
  const shippingFetch=async()=>{authCalls++;return Response.json({error:'invalid token'},{status:401});};
  const {request}=await app(t,{env:{SUPABASE_URL:'https://personal.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_public'},dependencies:{shippingFetch}});const expired=await admin(request);
  const clock=Date.now;Date.now=()=>clock()+61*60000;
  try{await admin(request);assert.equal((await request('/admin/overview',undefined,expired)).status,401);assert.equal(authCalls,0);}finally{Date.now=clock;}
});
test('a shipping handler can be injected without replacing TRY routes or public catalog',async t=>{
  const shippingModule={async handle({res,sendJson}){sendJson(res,200,{injected:true});return true;}};
  const {request,base}=await app(t,{dependencies:{shippingModule}});
  assert.equal((await request('/config',undefined,{Origin:base})).data.injected,true);
  assert.equal((await request('/api/v1/products')).status,200);
  assert.equal((await request('/api/health')).data.service,'TRY API');
});
test('rate limited shipping requests close unread uploads without waiting for their body',async t=>{
  const {request,base}=await app(t,{env:{SHIPPING_RATE_LIMIT_MAX:'1'}});assert.equal((await request('/checkouts',cart)).status,201);
  const result=await new Promise((resolve,reject)=>{
    const upload=httpRequest(`${base}/api/v1/shipping/checkouts`,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':'1024'}},response=>{
      response.resume();response.on('end',()=>resolve({status:response.statusCode,connection:response.headers.connection}));
    });t.after(()=>upload.destroy());upload.on('error',reject);upload.write('{');
  });
  assert.equal(result.status,429);assert.equal(result.connection,'close');
});

function twoMerchantRepository() {
  const states=new Map(['marea','other-store'].map(merchantId=>{
    const state=createDemoState();state.mode='live';state.merchant={...state.merchant,id:merchantId,originPlaceId:`ChIJ-${merchantId}-real-origin`};
    state.checkouts=[];state.shipments=[{id:`${merchantId}-known-held`,status:'held',priceMinor:14900,currency:'UYU',mode:'live'}];
    return [merchantId,state];
  }));
  return {
    states,
    async snapshot(merchantId) {const state=states.get(merchantId);if(!state)throw Object.assign(Error('not found'),{status:404});return structuredClone(state);},
    async mutate(operation,payload) {
      const state=states.get(payload.merchantId);if(!state)throw Object.assign(Error('not found'),{status:404});
      if(operation==='checkout_create') {state.checkouts.push(structuredClone(payload));return structuredClone(payload);}
      if(operation==='confirm') {
        const shipment=state.shipments.find(row=>row.id===payload.shipmentId);if(!shipment)throw Object.assign(Error('not found'),{status:404});
        if(payload.serverAuthorized!==true)throw Object.assign(Error('forbidden'),{status:403});shipment.status='confirmed';return structuredClone(shipment);
      }
      throw Error('unexpected controlled repository operation');
    },
    async adminContext(userId,merchantId) {return {userId,merchantId,role:'admin'};}
  };
}
test('a live merchant credential cannot issue checkout contexts for another registered merchant',async t=>{
  const repository=twoMerchantRepository();const {request}=await app(t,{env:{SHIPPING_MODE:'live',SHIPPING_MERCHANT_API_KEY:'test-key-bound-to-marea'},repository,provider:{mode:'google'}});
  const access={Authorization:'Bearer test-key-bound-to-marea'};
  const denied=await request('/checkouts',{...cart,merchantId:'other-store'},access);assert.equal(denied.status,403);assert.equal(repository.states.get('other-store').checkouts.length,0);
  const own=await request('/checkouts',cart,access);assert.equal(own.status,201,JSON.stringify(own.data));assert.equal(own.data.checkout.subtotalMinor,558000);assert.equal(repository.states.get('marea').checkouts.length,1);
});
test('a live merchant credential cannot confirm a known reservation of another merchant',async t=>{
  const repository=twoMerchantRepository();const {request}=await app(t,{env:{SHIPPING_MODE:'live',SHIPPING_MERCHANT_API_KEY:'test-key-bound-to-marea'},repository,provider:{mode:'google'}});const access={Authorization:'Bearer test-key-bound-to-marea'};
  const denied=await request('/shipments/other-store-known-held/confirm',{merchantId:'other-store'},access);assert.equal(denied.status,403);assert.equal(repository.states.get('other-store').shipments[0].status,'held');
  assert.equal((await request('/shipments/other-store-known-held/confirm',{merchantId:'marea'},access)).status,404);
  const own=await request('/shipments/marea-known-held/confirm',{merchantId:'marea'},access);assert.equal(own.status,200);assert.equal(own.data.shipment.status,'confirmed');
});
test('configured merchant scope is the default for server calls without constraining real admin memberships',async t=>{
  const repository=twoMerchantRepository();
  const {request}=await app(t,{env:{SHIPPING_MODE:'live',SHIPPING_MERCHANT_ID:'other-store',SHIPPING_MERCHANT_API_KEY:'test-key-bound-to-other',SUPABASE_URL:'https://personal.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_public'},repository,provider:{mode:'google'},dependencies:{shippingFetch:async()=>Response.json({id:'real-admin-user'})}});
  const access={Authorization:'Bearer test-key-bound-to-other'};
  const created=await request('/checkouts',{items:cart.items},access);assert.equal(created.status,201);assert.equal(repository.states.get('other-store').checkouts.length,1);assert.equal(repository.states.get('marea').checkouts.length,0);
  assert.equal((await request('/checkouts',cart,access)).status,403);
  assert.equal((await request('/shipments/other-store-known-held/confirm',{},access)).status,200);
  assert.equal((await request('/admin/overview?merchantId=marea',undefined,{Authorization:'Bearer separate-real-admin-session'})).status,200);
});
test('B2B credentials bind each generic server order to its own commerce independently of MAREA catalog',async t=>{
  const repository=twoMerchantRepository();const {request}=await app(t,{env:{SHIPPING_MODE:'live',SHIPPING_MERCHANT_API_KEYS:JSON.stringify({'other-store':'personal-other-integration-key'})},repository,provider:{mode:'google'}});
  const body={merchantId:'other-store',items:[{productId:'my-book-not-in-fashion-catalog',quantity:2,unitPriceMinor:15050}]};
  const own=await request('/checkouts',body,{Authorization:'Bearer personal-other-integration-key'});assert.equal(own.status,201,JSON.stringify(own.data));assert.equal(own.data.checkout.subtotalMinor,30100);
  assert.equal((await request('/checkouts',{...body,merchantId:'marea'},{Authorization:'Bearer personal-other-integration-key'})).status,403);
  assert.equal((await request('/checkouts',body,{Authorization:'Bearer wrong-key'})).status,401);
  assert.equal((await request('/store/checkouts',{items:body.items})).status,403);
});
