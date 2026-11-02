import { randomBytes, randomUUID } from 'node:crypto';
import { getProduct } from '../services/catalog.mjs';
import { buildOptions, validatePolicy } from './engine.mjs';
import { createDemoState, createDemoProvider } from './demo.mjs';
import { createGoogleProvider } from './google.mjs';
import { createMemoryRepository } from './memory.mjs';
import { createSupabaseRepository } from './supabase.mjs';
import { verifyAdminToken } from './auth.mjs';
import { createContextStore, fingerprint, secretMatches, shippingError } from './context.mjs';
import { departments, zones } from '../../public/store/uy-geography.js';
import { createZoneDemoState, resolveZone, buildZoneOptions } from './zones.mjs';

const fail=(code,status=400)=>{throw shippingError(code,status);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const money=value=>Number.isSafeInteger(value)&&value>0&&value<=1000000000;
const text=value=>typeof value==='string'&&value.trim().length>0;
function idempotencyKey(req) {
  const key=req.headers['idempotency-key'];
  if(typeof key!=='string'||!key.trim()||key.length>128||/[\x00-\x20\x7f]/.test(key))fail('idempotency_required');
  return key;
}
const isLoopback=value=>value==='localhost'||value==='[::1]'||value==='::1'||value==='::ffff:127.0.0.1'||/^127(?:\.(?:\d{1,3})){3}$/.test(value||'');
const localDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Montevideo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value&&value>=localDate();
function keys(value,allowed) {if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('shipping_invalid_request');}
function origin(value) {
  try {const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;return url.origin;}catch{return null;}
}
export function supabaseOrigin(value) {
  const normalized=origin(value);if(!normalized)return null;
  const url=new URL(normalized);return url.protocol==='https:'&&!isLoopback(url.hostname)&&/^[a-z0-9.-]+$/i.test(url.hostname)?normalized:null;
}
function publicKey(value) {
  if(typeof value!=='string'||!value||value.startsWith('sb_secret_'))return null;
  try {if(JSON.parse(Buffer.from(value.split('.')[1]||'','base64url')).role==='service_role')return null;}catch{ /* Modern publishable keys are not JWTs. */ }
  return value;
}
function publicMerchant(merchant) {return {id:merchant.id,name:merchant.name,currency:'UYU',timeZone:merchant.timeZone||'America/Montevideo'};}
const publicAddress=address=>({id:address.id,formattedAddress:address.formattedAddress,areaId:address.areaId,...(address.departmentId?{departmentId:address.departmentId}:{}),confirmed:false,provider:address.provider,...(address.demo?{demo:true}:{})});
const publicQuote=quote=>Object.fromEntries(['id','deliveryDate','priceMinor','normalPriceMinor','currency','expiresAt','promotionId','mode'].filter(key=>quote[key]!==undefined).map(key=>[key,quote[key]]));
const publicReservation=shipment=>Object.fromEntries(['id','checkoutId','quoteId','status','priceMinor','normalPriceMinor','currency','expiresAt','deliveryDate','mode','demo'].filter(key=>shipment[key]!==undefined).map(key=>[key,shipment[key]]));

export function createShippingService({env={},fetchImpl=globalThis.fetch,repository,provider}={}) {
  const mode=env.SHIPPING_MODE==='demo'?'demo':'live';
  const pricingMode=env.SHIPPING_PRICING_MODE??'zones';
  const merchantScope=env.SHIPPING_MERCHANT_ID??'marea';
  const configured=['demo','live'].includes(env.SHIPPING_MODE)&&['zones','distance'].includes(pricingMode);
  const authOrigin=supabaseOrigin(env.SUPABASE_URL), publishableKey=env.SUPABASE_PUBLISHABLE_KEY===env.SUPABASE_SECRET_KEY?null:publicKey(env.SUPABASE_PUBLISHABLE_KEY);
  const allowedOrigins=new Set(String(env.SHIPPING_ALLOWED_ORIGINS||'').split(',').filter(Boolean).map(value=>origin(value.trim())).filter(Boolean));
  let setupError=false;
  try {
    if(configured&&mode==='demo') {repository ||= createMemoryRepository(pricingMode==='zones'?createZoneDemoState():createDemoState());if(pricingMode==='distance')provider ||= createDemoProvider();}
    else if(configured&&mode==='live') {
      if(!text(env.SHIPPING_CHECKOUT_SECRET)||env.SHIPPING_CHECKOUT_SECRET.length<32)fail('shipping_unconfigured',503);
      if(!repository)repository=createSupabaseRepository({url:authOrigin,secretKey:env.SUPABASE_SECRET_KEY,fetchImpl});
      if(pricingMode==='distance'&&!provider)provider=createGoogleProvider({apiKey:env.GOOGLE_MAPS_SERVER_KEY,fetchImpl});
    }
  }catch{setupError=true;}
  const ready=()=>{if(!configured||setupError||!repository||(pricingMode==='distance'&&(!provider||provider.mode!==(mode==='demo'?'demo':'google'))))fail('shipping_unconfigured',503);};
  const contexts=createContextStore({secret:env.SHIPPING_CHECKOUT_SECRET||randomBytes(32).toString('base64url')});
  const addresses=new Map(),quotes=new Map(),sessions=new Map();
  function prune() {
    for(const map of [addresses,quotes,sessions])for(const [id,record]of map)if(Date.parse(record.retainUntil||record.expiresAt)<=Date.now())map.delete(id);
    if(addresses.size+quotes.size+sessions.size>=30000)fail('shipping_busy',503);
  }
  async function snapshot(merchantId='marea') {
    ready();if(typeof merchantId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(merchantId))fail('merchant_not_found',404);
    const state=await repository.snapshot(merchantId,mode);
    if(!object(state)||state.mode!==mode||state.merchant?.id!==merchantId||state.merchant.currency!=='UYU'||!object(state.prices)||!Array.isArray(state.days)||!Array.isArray(state.routes))fail('shipping_unavailable',503);
    if(pricingMode==='zones'&&!Array.isArray(state.zoneRates))fail('shipping_zones_unconfigured',503);
    if(pricingMode==='distance'&&mode==='live'&&(!state.merchant.originPlaceId||state.merchant.originPlaceId.startsWith('demo-')))fail('shipping_unconfigured',503);
    return state;
  }
  function demoAllowed(req) {
    if(mode!=='demo'||env.SHIPPING_DEMO_ADMIN_ENABLED!=='true'||env.NODE_ENV==='production'||!isLoopback(req.socket.remoteAddress))return false;
    let host;try{host=new URL(`http://${req.headers.host}`);}catch{return false;}
    if(!isLoopback(host.hostname)||host.username||host.password||host.pathname!=='/')return false;
    if(req.headers.forwarded||req.headers['x-forwarded-host']||req.headers['x-forwarded-for']||req.headers['x-forwarded-proto'])return false;
    if(!req.headers.origin)return true;
    const own=`${req.socket.encrypted?'https:':'http:'}//${host.host}`, incoming=origin(req.headers.origin);
    return Boolean(incoming&&(incoming===own||allowedOrigins.has(incoming)));
  }
  function bearer(req) {const match=/^Bearer ([^\s]+)$/.exec(req.headers.authorization||'');return match?.[1];}
  function merchantAuthorized(req,merchantId) {
    const token=bearer(req);
    if(!secretMatches(token,env.SHIPPING_MERCHANT_API_KEY))fail('merchant_unauthorized',401);
    if(typeof merchantScope!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(merchantScope))fail('shipping_unconfigured',503);
    if(merchantId!==merchantScope)fail('merchant_forbidden',403);
  }
  async function administrator(req,merchantId) {
    const token=bearer(req);if(!token)fail('admin_unauthorized',401);
    const session=sessions.get(token);
    if(session) {
      if(!demoAllowed(req)||session.merchantId!==merchantId||Date.parse(session.expiresAt)<=Date.now())fail('admin_forbidden',403);
      return {userId:'demo-admin',merchantId,role:'admin'};
    }
    if(token.startsWith('demo.'))fail('admin_unauthorized',401);
    return verifyAdminToken({token,merchantId,url:authOrigin,publishableKey,repository,fetchImpl});
  }
  const mutate=(operation,merchantId,payload={})=>repository.mutate(operation,{...payload,merchantId,mode});
  function checkoutContext(body) {const ctx=contexts.read(body.contextToken);if(ctx.mode!==mode)fail('checkout_forbidden',403);return ctx;}
  function owned(map,id,ctx,type,{checkExpiry=true}={}) {
    const row=map.get(id);if(!row)fail(`${type}_not_found`,404);
    if(row.checkoutId!==ctx.id||row.merchantId!==ctx.merchantId||row.mode!==ctx.mode)fail(`${type}_forbidden`,403);
    if(checkExpiry&&Date.parse(row.expiresAt)<=Date.now())fail(`${type}_expired`,410);
    return row;
  }
  async function resolve(inputAddress) {
    if(pricingMode==='zones') {
      if(typeof inputAddress!=='string'||!zones.some(zone=>zone.id===inputAddress))fail('area_invalid');
      return {...resolveZone(inputAddress),id:randomUUID()};
    }
    if(typeof inputAddress!=='string'||inputAddress.trim().length<5||inputAddress.length>300)fail('address_invalid',422);
    let address;
    try {address=await provider.resolveAddress(inputAddress.trim());}
    catch(error){if(error?.status===422||mode==='demo'&&String(error?.message).startsWith('Seleccione'))fail('address_unverified',422);throw error;}
    if(!address||!text(address.placeId)||!text(address.formattedAddress)||address.provider!==(mode==='demo'?'demo':'google')||mode==='live'&&address.placeId.startsWith('demo-'))fail('address_unverified',422);
    return {...address,inputAddress:inputAddress.trim(),id:randomUUID(),confirmed:false};
  }
  async function options(state,address) {try{return pricingMode==='zones'?await buildZoneOptions({state,address:{...address,confirmed:true}}):await buildOptions({state,address:{...address,confirmed:true},provider});}catch(error){if(error?.status)throw error;fail('shipping_provider_unavailable',503);}}
  async function issueCheckout(body,merchantId) {
    const state=await snapshot(merchantId);
    if(!Array.isArray(body.items)||!body.items.length||body.items.length>24)fail('cart_invalid');
    const seen=new Set();const items=body.items.map(item=>{
      keys(item,['productId','size','quantity']);const product=getProduct(item.productId),unitPriceMinor=state.prices[item.productId];
      if(!product||!product.sizes.includes(item.size)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>99)fail('cart_invalid');
      if(!money(unitPriceMinor))fail('price_unavailable',503);const key=`${item.productId}:${item.size}`;if(seen.has(key))fail('cart_duplicate');seen.add(key);
      return {productId:product.id,size:item.size,quantity:item.quantity,unitPriceMinor,lineTotalMinor:unitPriceMinor*item.quantity};
    });
    const subtotalMinor=items.reduce((sum,item)=>sum+item.lineTotalMinor,0);if(!Number.isSafeInteger(subtotalMinor))fail('cart_invalid');
    const expiresAt=new Date(Date.now()+30*60000).toISOString(),id=randomUUID();
    await mutate('checkout_create',merchantId,{id,cart:items,subtotalMinor,currency:'UYU',expiresAt});
    const contextToken=contexts.issue({id,merchantId,mode,cartHash:fingerprint(items),expiresAt});
    return {contextToken,checkout:{id,items,subtotalMinor,currency:'UYU',expiresAt}};
  }
  return {
    mode,pricingMode,authOrigin,allowedOrigins,demoAllowed,
    async prices() {if(!configured)return null;return (await snapshot()).prices;},
    async config(req,merchantId='marea') {
      let state;try{state=await snapshot(merchantId);}catch(error){if(error.status===404)throw error;}
      const areas=pricingMode==='zones'?zones.map(zone=>({...zone,available:Boolean(state?.zoneRates?.some(rate=>rate.areaId===zone.id&&rate.enabled&&money(rate.priceMinor)))})):(state?.areas||[]).map(({id,name})=>({id,name}));
      return {mode,pricingMode,available:Boolean(state),storefrontAvailable:Boolean(state)&&(mode==='demo'||env.SHIPPING_STOREFRONT_ENABLED==='true'),merchant:state?publicMerchant(state.merchant):{id:merchantId,name:'MAREA',currency:'UYU'},...(pricingMode==='zones'?{departments}:{}),areas,supabase:authOrigin&&publishableKey?{url:authOrigin,publishableKey}:null,demoAdminAvailable:Boolean(state)&&demoAllowed(req)};
    },
    async demoSession(req,body) {
      if(!demoAllowed(req))fail('demo_admin_forbidden',403);
      const merchantId=body.merchantId||'marea';await snapshot(merchantId);prune();const accessToken=`demo.${randomBytes(32).toString('base64url')}`;sessions.set(accessToken,{merchantId,expiresAt:new Date(Date.now()+3600000).toISOString()});return {accessToken};
    },
    async checkout(req,body) {
      ready();keys(body,['merchantId','items','currency']);if(body.currency!==undefined&&body.currency!=='UYU')fail('currency_invalid');
      const requestedMerchantId=body.merchantId??(mode==='live'?merchantScope:'marea');
      if(mode==='live')merchantAuthorized(req,requestedMerchantId);
      return issueCheckout(body,requestedMerchantId);
    },
    async storefrontCheckout(req,body) {
      ready();if(mode!=='demo'&&env.SHIPPING_STOREFRONT_ENABLED!=='true')fail('storefront_disabled',403);
      keys(body,['items','currency']);if(body.currency!==undefined&&body.currency!=='UYU')fail('currency_invalid');
      return issueCheckout(body,merchantScope);
    },
    async address(body) {
      ready();keys(body,pricingMode==='zones'?['contextToken','areaId']:['contextToken','inputAddress']);const ctx=checkoutContext(body);prune();
      const address=await resolve(pricingMode==='zones'?body.areaId:body.inputAddress);addresses.set(address.id,{...address,merchantId:ctx.merchantId,checkoutId:ctx.id,mode,expiresAt:ctx.expiresAt});return {address:publicAddress(address)};
    },
    async quote(body) {
      ready();keys(body,['contextToken','addressId','confirmed']);const ctx=checkoutContext(body);if(body.confirmed!==true)fail('address_confirmation_required');
      const address=owned(addresses,body.addressId,ctx,'address'),state=await snapshot(ctx.merchantId);prune();const results=[];
      for(const option of await options(state,address)) {
        const id=randomUUID(),record=await mutate('quote_create',ctx.merchantId,{...option,id,checkoutId:ctx.id,address:{...address,confirmed:true}});
        quotes.set(id,{...option,...record,id,checkoutId:ctx.id,merchantId:ctx.merchantId,mode,retainUntil:ctx.expiresAt});results.push(publicQuote({...option,...record,id}));
      }
      return {quotes:results};
    },
    async reserve(req,body) {
      ready();keys(body,['contextToken','quoteId']);const ctx=checkoutContext(body),quote=owned(quotes,body.quoteId,ctx,'quote',{checkExpiry:false});
      const reservation=await mutate('reserve',ctx.merchantId,{checkoutId:ctx.id,quoteId:quote.id,expectedVersion:quote.routeVersion,expectedPolicyVersion:quote.policyVersion,idempotencyKey:idempotencyKey(req),bodyHash:fingerprint({checkoutId:ctx.id,quoteId:quote.id})});return {reservation:publicReservation(reservation)};
    },
    async demoConfirm(body,shipmentId) {
      if(mode!=='demo')fail('demo_confirmation_forbidden',403);ready();keys(body,['contextToken']);const ctx=checkoutContext(body);
      const reservation=await mutate('demo_confirm',ctx.merchantId,{shipmentId,checkoutId:ctx.id});return {reservation:publicReservation(reservation)};
    },
    async confirm(req,body,shipmentId) {
      ready();const merchantId=body.merchantId??merchantScope;merchantAuthorized(req,merchantId);keys(body,['merchantId']);await snapshot(merchantId);
      return {shipment:publicReservation(await mutate('confirm',merchantId,{shipmentId,serverAuthorized:true}))};
    },
    async admin(req,body,path,method,query) {
      ready();const merchantId=body?.merchantId||query.get('merchantId')||'marea';const actor=await administrator(req,merchantId),state=await snapshot(merchantId);
      const save=(operation,payload)=>mutate(operation,merchantId,{...payload,actorId:actor.userId});
      if(method==='GET') {
        const auditEvents=(state.auditEvents||[]).slice(0,100);
        if(path==='/admin/audit')return {auditEvents};
        if(path==='/admin/overview')return {merchant:publicMerchant(state.merchant),pricingMode,policy:state.policy,prices:state.prices,...(pricingMode==='zones'?{departments,areas:zones,zoneRates:state.zoneRates}:{areas:(state.areas||[]).map(({id,name})=>({id,name}))}),days:state.days,shipments:state.shipments,promotions:state.promotions,auditEvents};
        if(path==='/admin/zone-rates')return {areas:zones,zoneRates:state.zoneRates||[],minimumMinor:state.policy.minimumMinor};
        const collection={'/admin/settings':['policy',state.policy],'/admin/prices':['prices',state.prices],'/admin/promotions':['promotions',state.promotions],'/admin/service-days':['days',state.days],'/admin/shipments':['shipments',state.shipments]}[path];if(collection)return {[collection[0]]:collection[1]};
      }
      if(path==='/admin/zone-rates'&&method==='PUT') {
        keys(body,['merchantId','areaId','priceMinor','enabled']);
        if(pricingMode!=='zones'||!zones.some(zone=>zone.id===body.areaId)||!money(body.priceMinor)||body.priceMinor<state.policy.minimumMinor||typeof body.enabled!=='boolean')fail('zone_rate_invalid');
        await save('zone_rate_save',{areaId:body.areaId,priceMinor:body.priceMinor,enabled:body.enabled});
        return {zoneRates:(await snapshot(merchantId)).zoneRates};
      }
      if(path==='/admin/settings'&&method==='PUT') {
        const allowed=['minimumMinor','fuelPriceMinorPerLiter','fuelLitersPer100Km','laborMinorPerHour','serviceMinutes','marginBps','roundingMinor','quoteMinutes','holdMinutes'];
        if(!object(body.policy)||Object.keys(body.policy).some(key=>!allowed.includes(key)&&!['id','version'].includes(key)))fail('policy_invalid');
        const policy=Object.fromEntries(allowed.map(key=>[key,body.policy[key]]));try{validatePolicy(policy);}catch{fail('policy_invalid');}return {policy:await save('settings_save',{policy})};
      }
      if(path==='/admin/prices'&&method==='PUT') {
        if(!object(body.prices)||!Object.keys(body.prices).length||Object.entries(body.prices).some(([id,price])=>!getProduct(id)||!money(price)))fail('prices_invalid');
        for(const [productId,priceMinor]of Object.entries(body.prices))await save('price_save',{productId,priceMinor});return {prices:(await snapshot(merchantId)).prices};
      }
      if(path==='/admin/service-days'&&method==='PUT') {
        const day=body.day;keys(day,['deliveryDate','departureTime','capacity','maxDurationSeconds','enabled']);
        if(!validDate(day.deliveryDate)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(day.departureTime)||!Number.isInteger(day.capacity)||day.capacity<1||day.capacity>10||!Number.isInteger(day.maxDurationSeconds)||day.maxDurationSeconds<60||day.maxDurationSeconds>14400||typeof day.enabled!=='boolean'||Date.parse(`${day.deliveryDate}T${day.departureTime}:00-03:00`)<=Date.now())fail('service_day_invalid');
        await save('service_day_save',{day});return {days:(await snapshot(merchantId)).days};
      }
      const promotionMatch=/^\/admin\/promotions(?:\/([^/]+))?$/.exec(path);
      if(promotionMatch&&['POST','PATCH'].includes(method)) {
        const previous=promotionMatch[1]?state.promotions.find(row=>row.id===promotionMatch[1]):null;if(promotionMatch[1]&&!previous)fail('promotion_not_found',404);
        const promotion={...previous,...Object.fromEntries(['areaId','deliveryDate','priceMinor','active'].filter(key=>body[key]!==undefined).map(key=>[key,body[key]]))};if(previous)promotion.id=previous.id;
        if(!state.areas.some(area=>area.id===promotion.areaId)||!validDate(promotion.deliveryDate)||!state.days.some(day=>day.deliveryDate===promotion.deliveryDate&&day.enabled)||!money(promotion.priceMinor)||promotion.priceMinor<state.policy.minimumMinor||typeof promotion.active!=='boolean')fail('promotion_invalid');
        return {promotion:await save('promotion_save',{promotion})};
      }
      if(path==='/admin/shipments'&&method==='POST') {
        const key=idempotencyKey(req);
        const destination=pricingMode==='zones'?body.areaId:body.inputAddress;
        if(pricingMode==='zones'?!zones.some(zone=>zone.id===destination):typeof destination!=='string'||destination.trim().length<5||destination.length>300)fail('address_invalid',422);
        const bodyHash=fingerprint({actorId:actor.userId,merchantId,inputAddress:destination.trim(),deliveryDate:body.deliveryDate,priceMinor:body.priceMinor});
        const replay=await save('external_replay',{idempotencyKey:key,bodyHash});if(replay)return {shipment:replay};
        if(!validDate(body.deliveryDate)||!money(body.priceMinor)||body.priceMinor<state.policy.minimumMinor)fail('external_invalid');
        const address=await resolve(destination);const option=(await options(state,address)).find(option=>option.deliveryDate===body.deliveryDate);if(!option)fail('service_day_unavailable',409);
        if(body.priceMinor<option.safetyFloorMinor)fail('external_price_below_floor',400);
        const shipment={externalOrderRef:`manual-${fingerprint({merchantId,key})}`,address:{...address,confirmed:true},priceMinor:body.priceMinor,deliveryDate:body.deliveryDate};
        return {shipment:await save('external_create',{shipment,idempotencyKey:key,bodyHash,routeId:option.routeId,expectedVersion:option.routeVersion,expectedPolicyVersion:option.policyVersion,expectedDayVersion:option.dayVersion,candidateRoute:option.candidateRoute})};
      }
      const cancellation=/^\/(?:admin\/shipments|shipments)\/([^/]+)(?:\/cancel)?$/.exec(path);
      if(cancellation&&['POST','PATCH'].includes(method)) {
        if(path.startsWith('/admin/')&&body.status!=='cancelled'||typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>300)fail('cancellation_invalid');
        return {shipment:await save('cancel',{shipmentId:cancellation[1],reason:body.reason.trim()})};
      }
      fail('shipping_route_not_found',404);
    }
  };
}
