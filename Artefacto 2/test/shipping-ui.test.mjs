import test from 'node:test';
import assert from 'node:assert/strict';
import {listProducts} from '../src/services/catalog.mjs';
import {createCart} from '../public/store/cart.js';
const ui = await import('../public/widget/shipping-widget.js').catch(() => ({}));
const admin = await import('../public/admin/admin.js').catch(() => ({}));
const checkout = await import('../public/checkout/checkout.js').catch(() => ({}));
const money = await import('../public/store/money.js').catch(() => ({}));
const zoneConfig={pricingMode:'zones',departments:[{id:'montevideo',name:'Montevideo'},{id:'canelones',name:'Canelones'}],areas:[{id:'centro',name:'Centro',departmentId:'montevideo',kind:'neighborhood',available:true},{id:'pocitos',name:'Pocitos',departmentId:'montevideo',kind:'neighborhood',available:false},{id:'dept-canelones',name:'Canelones',departmentId:'canelones',kind:'department',available:true}]};
const quote = {id:'q',deliveryDate:'2026-11-02',label:'Lunes',priceMinor:14900,normalPriceMinor:16000,currency:'UYU',expiresAt:'2099-01-01T00:00:00Z',routeId:'r',routeVersion:1,mode:'demo'};
const response = (body, status = 200) => ({ok:status<400,status,json:async()=>body});

test('catalog supplies six UYU garments with server-side demo prices',()=>{
  const products=listProducts(); assert.equal(products.length,6);
  assert.ok(products.every(product=>product.currency==='UYU'));
  assert.equal(products.find(product=>product.id==='soft-knit-sweater').price,2790);
});
test('zone selection uses API geography and interior departments select one zone without requests',()=>{
  assert.equal(typeof ui.ZoneSelection,'function');let changes=0;
  const selection=new ui.ZoneSelection(zoneConfig,()=>changes++);
  selection.selectDepartment('montevideo');selection.selectArea('centro');assert.deepEqual(selection.destination(),{areaId:'centro'});
  selection.selectDepartment('canelones');assert.equal(selection.areaId,'dept-canelones');assert.equal(selection.needsNeighborhood,false);assert.deepEqual(selection.destination(),{areaId:'dept-canelones'});
  selection.selectDepartment('montevideo');assert.equal(selection.areaId,'');assert.equal(selection.needsNeighborhood,true);assert.throws(()=>selection.destination());assert.equal(changes,4);
});
test('unavailable or unknown zones cannot quote but an admin can configure their tariff',()=>{
  assert.equal(typeof ui.ZoneSelection,'function');const selection=new ui.ZoneSelection(zoneConfig);
  selection.selectDepartment('montevideo');selection.selectArea('pocitos');assert.throws(()=>selection.destination(),/tarifa|disponible/i);
  assert.deepEqual(selection.destination({allowUnavailable:true}),{areaId:'pocitos'});
  assert.throws(()=>selection.selectArea('invented'));assert.throws(()=>selection.selectArea('dept-canelones'));
  assert.equal(typeof admin.parseZoneRate,'function');assert.deepEqual(admin.parseZoneRate({departmentId:'montevideo',areaId:'pocitos',price:'249,50',enabled:'on'},zoneConfig,14900),{areaId:'pocitos',priceMinor:24950,enabled:true});
  assert.throws(()=>admin.parseZoneRate({departmentId:'montevideo',areaId:'pocitos',price:'148',enabled:'on'},zoneConfig,14900));
});
test('zone resolve sends only the area ID and ignores a pending response invalidated by selection',async()=>{
  const requests=[];let finish;const session=new ui.ShippingSession((path,body)=>{requests.push({path,body});return new Promise(resolve=>{finish=resolve;});});
  session.setContext('ctx');const pending=session.resolve({areaId:'centro'});session.invalidateAddress();finish({address:{id:'old',formattedAddress:'Centro',provider:'zones'}});
  await pending;assert.equal(session.address,null);assert.deepEqual(requests,[{path:'/addresses/resolve',body:{contextToken:'ctx',areaId:'centro'}}]);
});
test('zone changes immediately remove quoted price and reject an older quote response',async()=>{
  let finish;const session=new ui.ShippingSession(()=>new Promise(resolve=>{finish=resolve;}));session.setContext('ctx');
  const selection=new ui.ZoneSelection(zoneConfig,()=>session.invalidateAddress());selection.selectDepartment('montevideo');selection.selectArea('centro');session.address={id:'zone-centro'};
  const pending=session.loadQuotes();selection.selectDepartment('canelones');finish({quotes:[quote]});await pending;
  assert.equal(session.address,null);assert.equal(session.selected,null);assert.deepEqual(session.quotes,[]);
});
test('clearing a neighborhood selection invalidates the old destination instead of retaining its price',()=>{
  const session=new ui.ShippingSession();const selection=new ui.ZoneSelection(zoneConfig,()=>session.invalidateAddress());selection.selectDepartment('montevideo');selection.selectArea('centro');
  session.address={id:'centro-address'};session.quotes=[quote];session.select('q');assert.doesNotThrow(()=>selection.selectArea(''));
  assert.equal(session.address,null);assert.equal(session.selected,null);assert.deepEqual(session.quotes,[]);assert.throws(()=>selection.destination());
});
test('MAREA creates a checkout through the server merchant adapter without client authority fields',async()=>{
  assert.equal(typeof checkout.createStoreCheckout,'function');let sent;
  const result=await checkout.createStoreCheckout([{productId:'soft-knit-sweater',size:'M',quantity:1,priceMinor:1,merchantId:'other'}],async(path,options)=>{sent={path,body:JSON.parse(options.body)};return response({contextToken:'fixed-merchant-context',checkout:{currency:'UYU',subtotalMinor:279000,items:[]}});});
  assert.deepEqual(sent,{path:'/api/v1/shipping/store/checkouts',body:{items:[{productId:'soft-knit-sweater',size:'M',quantity:1}]}});assert.equal(result.contextToken,'fixed-merchant-context');
});
test('external zone shipment payload contains its canonical area and preserves retry isolation across changed areas',async()=>{
  assert.equal(typeof admin.parseExternalShipment,'function');
  assert.deepEqual(admin.parseExternalShipment({departmentId:'canelones',areaId:'dept-canelones',deliveryDate:'2026-11-02',price:'399,50'},zoneConfig),{areaId:'dept-canelones',deliveryDate:'2026-11-02',priceMinor:39950});
  assert.deepEqual(admin.parseExternalShipment({inputAddress:' Pocitos ',deliveryDate:'2026-11-02',price:'249'}, {pricingMode:'distance'}),{inputAddress:'Pocitos',deliveryDate:'2026-11-02',priceMinor:24900});
  const keys=[];let sequence=0;const intent=admin.createExternalShipmentIntent(async(payload,options)=>{keys.push(options.headers['Idempotency-Key']);return false;},()=>`key-${++sequence}`);
  await intent.submit({areaId:'centro',deliveryDate:'2026-11-02',priceMinor:24900});await intent.submit({areaId:'dept-canelones',deliveryDate:'2026-11-02',priceMinor:24900});assert.deepEqual(keys,['key-1','key-2']);
});
test('zone policy edits change only the positive manual minimum and zone history shows meaningful tariff changes',()=>{
  assert.equal(typeof admin.parseZonePolicy,'function');assert.deepEqual(admin.parseZonePolicy({minimumMinor:'149,50'},{minimumMinor:14900,quoteMinutes:5,holdMinutes:15}),{minimumMinor:14950,quoteMinutes:5,holdMinutes:15});
  assert.throws(()=>admin.parseZonePolicy({minimumMinor:'0'},{minimumMinor:14900}));
  const html=admin.renderAuditHistory([{operation:'zone_rate_save',entityType:'zone_rate',entityId:'dept-canelones',actor:'demo-admin',createdAt:'2026-11-01T12:00:00Z',changes:{before:{areaId:'dept-canelones',priceMinor:39900,enabled:false},after:{areaId:'dept-canelones',priceMinor:44950,enabled:true}}}],zoneConfig.areas);
  assert.match(html,/Tarifa de zona/);assert.match(html,/UYU 399,00 → UYU 449,50/);assert.match(html,/Habilitada: No → Sí/);
});
test('store product prices preserve admin-supported centesimos at the major-unit API boundary',()=>{
  assert.equal(typeof money.formatProductPrice,'function');
  assert.equal(money.formatProductPrice({price:2790.5,currency:'UYU'}),'UYU 2.790,50');
  assert.equal(money.formatProductPrice({price:2790,currency:'UYU'}),'UYU 2.790,00');
  assert.equal(money.formatProductPrice({price:0.01,currency:'UYU'}),'UYU 0,01');
  assert.throws(()=>money.formatProductPrice({price:2790,currency:'USD'}));
});
test('admin shows the declared delivery destination after temporary Google content is removed',()=>{
  assert.equal(typeof admin.shipmentDestination,'function');
  assert.equal(admin.shipmentDestination({address:{inputAddress:'Pocitos, dirección declarada'}}),'Pocitos, dirección declarada');
  assert.equal(admin.shipmentDestination({address:{formattedAddress:'Destino confirmado',inputAddress:'Original'}}),'Destino confirmado');
  assert.equal(admin.shipmentDestination({label:'Destino demo'}),'Destino demo');
  assert.equal(admin.shipmentDestination({}),'Destino no informado');
});
test('admin history renders target actor time and before/after values as escaped text',()=>{
  assert.equal(typeof admin.renderAuditHistory,'function');
  const html=admin.renderAuditHistory([{id:'1',createdAt:'2026-11-01T10:00:00Z',operation:'price_save',entityType:'product_price',entityId:'sweater<script>',actor:'<actor>',mode:'demo',changes:{before:{priceMinor:279000},after:{priceMinor:300150}}}]);
  assert.match(html,/UYU 2.790,00/);assert.match(html,/UYU 3.001,50/);assert.match(html,/sweater&lt;script&gt;/);assert.match(html,/&lt;actor&gt;/);assert.match(html,/1\/11\/2026/);assert.doesNotMatch(html,/<script>|<actor>|price_save|product_price|priceMinor/);
  assert.match(admin.renderAuditHistory([]),/Sin cambios registrados/);
});
test('history shows only changed Spanish fields with meaningful UYU values and people',()=>{
  const html=admin.renderAuditHistory([{createdAt:'2026-11-01T10:00:00Z',actor:'demo-admin',operation:'settings_save',entityType:'rate_policy',entityId:'current',mode:'demo',changes:{before:{minimumMinor:14900,roundingMinor:100},after:{minimumMinor:15900,roundingMinor:100}}}]);
  assert.match(html,/Administrador demo/);assert.match(html,/Costos actualizados/);assert.match(html,/Mínimo por envío/);assert.match(html,/UYU 149,00 → UYU 159,00/);
  assert.doesNotMatch(html,/Redondeo|minimumMinor|roundingMinor|settings_save|rate_policy|\{"/);
});

const holdClock=()=>{let now=Date.parse('2026-11-01T12:00:00Z');let callback=null;return {now:()=>now,schedule:(fn)=>{callback=fn;return 1;},cancel:()=>{},advance:(minutes)=>{now+=minutes*60000;callback?.();},capture:()=>callback};};
test('reservation deadline returns to quoting and a new hold can be accepted',()=>{
  assert.equal(typeof checkout.ReservationHold,'function');const clock=holdClock();const expired=[];
  const hold=new checkout.ReservationHold({...clock,onExpire:(snapshot)=>expired.push(snapshot)});
  hold.accept({id:'hold-a',expiresAt:'2026-11-01T12:15:00Z'},{contextToken:'cart-a',quote});
  assert.equal(hold.current.reservation.id,'hold-a');clock.advance(15);
  assert.equal(hold.current,null);assert.equal(expired.length,1);assert.equal(expired[0].contextToken,'cart-a');
  hold.accept({id:'hold-b',expiresAt:'2026-11-01T12:30:00Z'},{contextToken:'cart-a',quote:{...quote,id:'q-new'}});
  assert.equal(hold.current.reservation.id,'hold-b');
});
test('authoritative 410 expires the current hold and late failures cannot clear a new cart hold',()=>{
  assert.equal(typeof checkout.ReservationHold,'function');const clock=holdClock();let expired=0;
  const hold=new checkout.ReservationHold({...clock,onExpire:()=>expired++});
  const old=hold.accept({id:'old',expiresAt:'2026-11-01T12:15:00Z'},{contextToken:'cart-a',quote});
  assert.equal(hold.reject(old,{status:410}),true);assert.equal(hold.current,null);assert.equal(expired,1);
  const fresh=hold.accept({id:'fresh',expiresAt:'2026-11-01T12:15:00Z'},{contextToken:'cart-b',quote});
  assert.equal(hold.reject(old,{status:410}),false);assert.equal(hold.current,fresh);assert.equal(expired,1);
});
test('cart invalidation and successful confirmation make old hold timers harmless',()=>{
  assert.equal(typeof checkout.ReservationHold,'function');const clock=holdClock();let expired=0;
  const hold=new checkout.ReservationHold({...clock,onExpire:()=>expired++});
  const first=hold.accept({id:'first',expiresAt:'2026-11-01T12:15:00Z'},{contextToken:'cart-a',quote});const oldTimer=clock.capture();
  hold.reset();assert.equal(hold.confirm(first),false);oldTimer();assert.equal(expired,0);assert.equal(hold.current,null);
  const second=hold.accept({id:'second',expiresAt:'2026-11-01T12:15:00Z'},{contextToken:'cart-b',quote});const confirmedTimer=clock.capture();
  assert.equal(hold.confirm(second),true);clock.advance(16);confirmedTimer();assert.equal(expired,0);assert.equal(hold.current,second);
});
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
test('pending confirmation accepts authoritative success past deadline and clears its cart',async()=>{
  const clock=holdClock();let expired=0;const cart=createCart(null);cart.add('soft-knit-sweater','M',1);
  const hold=new checkout.ReservationHold({...clock,onExpire:()=>expired++});
  assert.equal(typeof hold.confirmRequest,'function');
  const snapshot=hold.accept({id:'reserved',expiresAt:'2026-11-01T12:15:00Z'},{contextToken:'cart-a',quote});
  const request=deferred();const pending=hold.confirmRequest(snapshot,()=>request.promise,()=>cart.clear());
  clock.advance(16);assert.equal(expired,0);assert.equal(hold.current,snapshot);
  request.resolve({reservation:{id:'reserved',status:'confirmed'}});
  assert.equal((await pending).status,'confirmed');assert.deepEqual(cart.items(),[]);assert.equal(expired,0);
});
test('pending confirmation recovers only when server definitively reports expiration',async()=>{
  const clock=holdClock();let expired=0;const hold=new checkout.ReservationHold({...clock,onExpire:()=>expired++});
  assert.equal(typeof hold.confirmRequest,'function');
  const snapshot=hold.accept({id:'reserved',expiresAt:'2026-11-01T12:15:00Z'},{contextToken:'cart-a',quote});
  const request=deferred();const pending=hold.confirmRequest(snapshot,()=>request.promise,()=>assert.fail('expired order must not confirm'));
  clock.advance(16);request.reject(Object.assign(Error('Expired'),{status:410}));
  assert.equal((await pending).status,'expired');assert.equal(hold.current,null);assert.equal(expired,1);
});
test('ambiguous confirmation failure retains the same reservation for retry past deadline',async()=>{
  const clock=holdClock();let expired=0;const hold=new checkout.ReservationHold({...clock,onExpire:()=>expired++});
  assert.equal(typeof hold.confirmRequest,'function');
  const snapshot=hold.accept({id:'reserved',expiresAt:'2026-11-01T12:15:00Z'},{contextToken:'cart-a',quote});
  const request=deferred();const attempts=[];
  const pending=hold.confirmRequest(snapshot,(id,token)=>{attempts.push({id,token});return request.promise;},()=>assert.fail('unknown outcome must not clear cart'));
  clock.advance(16);request.reject(Error('network timeout'));
  assert.equal((await pending).status,'uncertain');assert.equal(hold.current,snapshot);clock.advance(1);assert.equal(expired,0);
  let confirmed=0;const retry=await hold.confirmRequest(snapshot,async(id,token)=>{attempts.push({id,token});return {reservation:{id,status:'confirmed'}};},()=>confirmed++);
  assert.equal(retry.status,'confirmed');assert.equal(confirmed,1);
  assert.deepEqual(attempts,[{id:'reserved',token:'cart-a'},{id:'reserved',token:'cart-a'}]);
});
test('a confirmation response from a replaced cart cannot clear its new selections',async()=>{
  const clock=holdClock();const cart=createCart(null);cart.add('soft-knit-sweater','M',1);
  const hold=new checkout.ReservationHold(clock);assert.equal(typeof hold.confirmRequest,'function');
  const snapshot=hold.accept({id:'reserved',expiresAt:'2026-11-01T12:15:00Z'},{contextToken:'cart-a',quote});
  const request=deferred();const pending=hold.confirmRequest(snapshot,()=>request.promise,()=>cart.clear());
  cart.update('soft-knit-sweater:M',2);hold.reset();request.resolve({reservation:{id:'reserved',status:'confirmed'}});
  assert.equal((await pending).status,'stale');assert.equal(cart.items()[0].quantity,2);
});

test('UYU form values become integer centesimos and invalid amounts never submit', () => {
  assert.equal(typeof ui.parseUYU, 'function');
  assert.equal(ui.parseUYU('149,50'),14950); assert.equal(ui.parseUYU('2500'),250000);
  for (const value of ['', '-1','1.009','Infinity','1e3']) assert.throws(() => ui.parseUYU(value));
});
test('cost policy forms preserve fixed five-minute quotes and fifteen-minute holds',()=>{
  const values={minimumMinor:'149',fuelPriceMinorPerLiter:'90.45',laborMinorPerHour:'250',roundingMinor:'1',fuelLitersPer100Km:'3',serviceMinutes:'5',marginBps:'1500',quoteMinutes:'5',holdMinutes:'15'};
  assert.equal(admin.parsePolicy(values).fuelPriceMinorPerLiter,9045);
  assert.throws(()=>admin.parsePolicy({...values,quoteMinutes:'10'}));
  assert.throws(()=>admin.parsePolicy({...values,holdMinutes:'30'}));
});
test('shipping rejects non UYU quotes and invalid server totals', () => {
  assert.equal(typeof ui.validateQuotes, 'function');
  assert.deepEqual(ui.validateQuotes([quote]), [quote]);
  assert.throws(() => ui.validateQuotes([{...quote,currency:'USD'}]));
  assert.throws(() => ui.validateQuotes([{...quote,priceMinor:-1}]));
  assert.equal(typeof checkout.checkoutTotal, 'function');
  assert.equal(checkout.checkoutTotal({currency:'UYU',subtotalMinor:558000},quote),572900);
  assert.throws(() => checkout.checkoutTotal({currency:'USD',subtotalMinor:1},quote));
});
test('a late quote response cannot restore selection after context changes', async () => {
  assert.equal(typeof ui.ShippingSession, 'function');
  let resolve; const session = new ui.ShippingSession(() => new Promise((done) => {resolve=done;}));
  session.setContext('context-a'); session.address={id:'a'};
  const pending=session.loadQuotes(); session.setContext('context-b');
  resolve({quotes:[quote]}); await pending;
  assert.deepEqual(session.quotes, []); assert.equal(session.selected, null);
});
test('address edits invalidate quoted prices and late geocoding responses', async () => {
  assert.equal(typeof ui.ShippingSession, 'function'); let resolve;
  const session=new ui.ShippingSession(() => new Promise((done)=>{resolve=done;}));
  session.setContext('a'); session.quotes=[quote]; session.select('q');
  const pending=session.resolve('18 de Julio 1000'); session.invalidateAddress();
  resolve({address:{id:'old',formattedAddress:'Old address'}}); await pending;
  assert.equal(session.address,null); assert.equal(session.selected,null); assert.deepEqual(session.quotes,[]);
});
test('API errors expose useful messages without accepting an unsuccessful response', async () => {
  assert.equal(typeof ui.requestJSON, 'function');
  await assert.rejects(ui.requestJSON('/x',{},async()=>response({error:{message:'Sin cupos'}},409)),/Sin cupos/);
});
test('admin authenticates via Supabase then requires backend membership before exposing a session', async () => {
  assert.equal(typeof admin.createAdminSession, 'function'); const calls=[];
  const session=admin.createAdminSession(async(url,options)=>{calls.push({url,options}); return calls.length===1?response({access_token:'private-token'}):response({error:'Sin membresía'},403);});
  await assert.rejects(session.login({supabase:{url:'https://auth.example',publishableKey:'public'}},'a@b.c','password'),/Sin membresía/);
  assert.equal(session.authenticated,false);
  assert.match(calls[0].url,/\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(calls[1].options.headers.Authorization,'Bearer private-token');
  assert.throws(()=>session.authorization());
});
test('demo session is only requested explicitly and logout clears authorization', async () => {
  assert.equal(typeof admin.createAdminSession,'function'); const paths=[];
  const session=admin.createAdminSession(async(path)=>{paths.push(path);return response(path.includes('demo-session')?{accessToken:'demo-secret'}:{merchant:{id:'marea'}});});
  assert.equal(session.authenticated,false); assert.equal(paths.length,0);
  await session.demo(); assert.equal(session.authenticated,true); assert.equal(session.isDemo,true);
  session.logout(); assert.equal(session.authenticated,false); assert.throws(()=>session.authorization());
});
test('admin remains unauthenticated while backend membership is unresolved',async()=>{
  let resolveMembership;let count=0;
  const session=admin.createAdminSession(async()=>++count===1?response({access_token:'pending'}):new Promise(resolve=>{resolveMembership=resolve;}));
  const login=session.login({supabase:{url:'https://auth.example',publishableKey:'pk'}},'a@b.c','p');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.authenticated,false);assert.throws(()=>session.authorization());
  resolveMembership(response({merchant:{id:'marea'}}));await login;assert.equal(session.authenticated,true);
});
test('admin zone-rate response cannot revive protected data after logout',async()=>{
  let attempt=0,finish;const session=admin.createAdminSession(async()=>++attempt===1?response({accessToken:'demo-private'}):attempt===2?response({merchant:{id:'marea'}}):new Promise(resolve=>{finish=resolve;}));
  await session.demo();const pending=session.request('/zone-rates');session.logout();finish(response({zoneRates:[{areaId:'centro',priceMinor:24900,enabled:true,version:1}]}));
  await assert.rejects(pending,/sesión/i);assert.equal(session.authenticated,false);
});
test('service day form rejects calendar rollovers, excessive capacity and zero duration',()=>{
  const valid={deliveryDate:'2026-11-02',departureTime:'10:00',capacity:'10',duration:'240',enabled:'on'};
  assert.deepEqual(admin.parseServiceDay(valid),{deliveryDate:'2026-11-02',departureTime:'10:00',capacity:10,maxDurationSeconds:14400,enabled:true});
  for(const patch of [{deliveryDate:'2026-02-30'},{capacity:'11'},{capacity:'1.5'},{duration:'0'},{departureTime:'25:00'}])assert.throws(()=>admin.parseServiceDay({...valid,...patch}));
});
test('an expired admin request clears the in-memory session',async()=>{
  let count=0;const session=admin.createAdminSession(async()=>response(++count===1?{accessToken:'demo-secret'}:count===2?{merchant:{id:'marea'}}:{error:'Sesión vencida'},count===3?401:200));
  await session.demo();await assert.rejects(session.request('/settings'),/Sesión vencida/);
  assert.equal(session.authenticated,false);assert.throws(()=>session.authorization());
});
test('shipping quote fetch sends the confirmed resolved address and selection refuses expired prices',async()=>{
  const requests=[];const session=new ui.ShippingSession(async(path,body)=>{requests.push({path,body});return path==='/addresses/resolve'?{address:{id:'address-1',formattedAddress:'18 de Julio 1000, Montevideo',provider:'demo'}}:{quotes:[quote]};});
  session.setContext('checkout-private');await session.resolve('18 de Julio 1000');await session.loadQuotes();
  assert.deepEqual(requests,[{path:'/addresses/resolve',body:{contextToken:'checkout-private',inputAddress:'18 de Julio 1000'}},{path:'/quotes',body:{contextToken:'checkout-private',addressId:'address-1',confirmed:true}}]);
  assert.equal(session.select('q').priceMinor,14900);
  session.quotes=[{...quote,expiresAt:'2000-01-01T00:00:00Z'}];assert.throws(()=>session.select('q'),/venció/);
});
test('external shipment retries reuse the idempotency header after transport failure and reset after success',async()=>{
  assert.equal(typeof admin.createExternalShipmentIntent,'function');
  const headers=[];let attempt=0;let sequence=0;
  const intent=admin.createExternalShipmentIntent(async(payload,options)=>{
    headers.push(options.headers);assert.equal(payload.inputAddress,'Pocitos');
    if(++attempt===1)throw Error('network timeout');return true;
  },()=>`intent-${++sequence}`);
  const payload={inputAddress:'Pocitos',deliveryDate:'2026-11-02',priceMinor:14900};
  await assert.rejects(intent.submit(payload),/network timeout/);
  await intent.submit(payload);await intent.submit(payload);
  assert.deepEqual(headers,[{'Idempotency-Key':'intent-1'},{'Idempotency-Key':'intent-1'},{'Idempotency-Key':'intent-2'}]);
});
test('editing an external shipment form creates a new intent while an old response cannot clear it',async()=>{
  assert.equal(typeof admin.createExternalShipmentIntent,'function');
  let sequence=0;const pending=[];const headers=[];
  const intent=admin.createExternalShipmentIntent((payload,options)=>new Promise(resolve=>{pending.push(resolve);headers.push(options.headers);}),()=>`intent-${++sequence}`);
  const first=intent.submit({inputAddress:'Centro',deliveryDate:'2026-11-02',priceMinor:14900});
  intent.invalidate();
  const second=intent.submit({inputAddress:'Pocitos',deliveryDate:'2026-11-02',priceMinor:14900});
  pending[0](true);await first;pending[1](false);await second;
  const retry=intent.submit({inputAddress:'Pocitos',deliveryDate:'2026-11-02',priceMinor:14900});pending[2](true);await retry;
  assert.deepEqual(headers,[{'Idempotency-Key':'intent-1'},{'Idempotency-Key':'intent-2'},{'Idempotency-Key':'intent-2'}]);
});
