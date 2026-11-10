import {SHIPPING_API,requestJSON,parseUYU,formatUYU,escapeHTML,ZoneSelection,renderZoneSelector} from '../widget/shipping-widget.js';
import {validateDiscountRule} from '../shipping-admin/rules.js';

export function parseZoneRate(values,config,minimumMinor){
  const selection=new ZoneSelection(config);selection.selectDepartment(values.departmentId);
  if(selection.needsNeighborhood)selection.selectArea(values.areaId);
  const destination=selection.destination({allowUnavailable:true});const priceMinor=parseUYU(values.price);
  if(priceMinor<minimumMinor||priceMinor<=0)throw Error('La tarifa debe respetar el mínimo manual del comercio.');
  return {...destination,priceMinor,enabled:Boolean(values.enabled)};
}
export function parseZonePolicy(values,policy){
  const minimumMinor=parseUYU(values.minimumMinor);if(minimumMinor<=0)throw Error('El mínimo manual debe ser positivo.');return {...policy,minimumMinor};
}
export function parseExternalShipment(values,config){
  let destination;
  if(config.pricingMode==='distance'){const inputAddress=String(values.inputAddress||'').trim();if(inputAddress.length<5)throw Error('Ingresá una dirección válida.');destination={inputAddress};}
  else{const selection=new ZoneSelection(config);selection.selectDepartment(values.departmentId);if(selection.needsNeighborhood)selection.selectArea(values.areaId);destination=selection.destination({allowUnavailable:true});}
  return {...destination,deliveryDate:values.deliveryDate,priceMinor:parseUYU(values.price)};
}

export function shipmentDestination(shipment) {
  return shipment.address?.formattedAddress || shipment.address?.inputAddress || shipment.label || shipment.inputAddress || 'Destino no informado';
}

export function renderShipmentActions(shipment,now=Date.now()) {
  const esc=escapeHTML,id=esc(shipment.id),canConfirm=shipment.status==='held'&&Date.parse(shipment.expiresAt)>now;
  if(!['held','confirmed'].includes(shipment.status))return esc(shipment.cancellationReason||'—');
  return `<div class="shipment-actions">${canConfirm?`<button type="button" class="secondary" data-confirm="${id}">Confirmar pedido</button>`:''}<form class="cancel-form" data-cancel="${id}"><input name="reason" placeholder="Motivo" aria-label="Motivo de cancelación" minlength="3" maxlength="300" required><button class="quiet">Cancelar</button></form></div>`;
}

export function renderAuditHistory(events = [],areas=[]) {
  const esc=escapeHTML;
  const operations={zone_rate_save:'Tarifa de zona actualizada',settings_save:'Costos actualizados',promotion_save:'Oferta actualizada',service_day_save:'Día de servicio actualizado',external_create:'Entrega externa creada',reserve:'Reserva creada',confirm:'Envío confirmado',demo_confirm:'Envío demo confirmado',cancel:'Envío cancelado',discount_rule_save:'Descuentos actualizados',delivery_window_save:'Franja actualizada'};
  const entities={zone_rate:'Tarifa de zona',rate_policy:'Costos de envío',promotion:'Oferta',service_day:'Día de entrega',shipment:'Envío',discount_rule:'Regla de agrupación',delivery_window:'Franja de entrega'};
  const actors={'demo-admin':'Administrador demo','commerce-server':'Servidor del comercio','demo-buyer':'Comprador demo','checkout-buyer':'Comprador'};
  const labels={...moneyFields,...numberFields,priceMinor:'Precio',areaId:'Zona',deliveryDate:'Entrega',active:'Oferta activa',departureTime:'Salida',startTime:'Desde',endTime:'Hasta',tiers:'Escalones',capacity:'Cupos',maxDurationSeconds:'Duración máxima',enabled:'Habilitada',status:'Estado'};
  const date=value=>new Intl.DateTimeFormat('es-UY',{timeZone:'America/Montevideo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
  const value=(key,input)=>{
    if(input===null||input===undefined)return '—';
    if(key==='tiers')return Array.isArray(input)?input.map(tier=>`Desde ${tier.minOrders}: ${tier.type==='fixed'?formatUYU(tier.value):`${tier.value/100} %`}`).join('; '):'—';
    if(key.endsWith('Minor')||key==='fuelPriceMinorPerLiter'||key==='laborMinorPerHour')return Number.isSafeInteger(input)?formatUYU(input):'—';
    if(typeof input==='boolean')return input?'Sí':'No';
    if(key==='marginBps')return `${input/100} %`;
    if(key==='maxDurationSeconds')return `${input/60} min`;
    if(['quoteMinutes','holdMinutes','serviceMinutes'].includes(key))return `${input} min`;
    if(key==='deliveryDate')return /^\d{4}-\d{2}-\d{2}$/.test(input)?new Date(`${input}T12:00:00Z`).toLocaleDateString('es-UY',{timeZone:'America/Montevideo'}):'—';
    if(key==='status')return ({held:'Reservado',confirmed:'Confirmado',cancelled:'Cancelado',expired:'Vencido',completed:'Completado'})[input]||'—';
    if(key==='areaId')return areas.find(area=>area.id===input)?.name||input;
    return typeof input==='object'?'—':String(input);
  };
  return `<table><thead><tr><th>Fecha / persona</th><th>Cambio</th><th>Detalle</th></tr></thead><tbody>${events.filter(event=>Object.hasOwn(entities,event.entityType)).slice(0,100).map(event=>{
    const before=event.changes?.before||{},after=event.changes?.after||{};
    const fields=Object.keys(labels).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])&&(before[key]!==undefined||after[key]!==undefined));
    const detail=fields.map(key=>`${esc(labels[key])}: ${esc(value(key,before[key]))} → ${esc(value(key,after[key]))}`).join('<br>')||'Sin cambios de valores.';
    const at=Number.isFinite(Date.parse(event.createdAt))?date(event.createdAt):'Fecha no disponible';
    return `<tr><td>${esc(at)}<br><span title="${esc(event.actor)}">${esc(actors[event.actor]||'Administrador')}</span>${event.mode==='demo'?' · Demo':''}</td><td>${esc(operations[event.operation]||'Cambio registrado')}<br><span title="${esc(event.entityId)}">${esc(entities[event.entityType]||'Registro')}</span></td><td>${detail}</td></tr>`;
  }).join('')||'<tr><td colspan="3">Sin cambios registrados.</td></tr>'}</tbody></table>`;
}

export function createAdminSession(fetcher = globalThis.fetch,{merchantId='',apiBase=SHIPPING_API}={}) {
  let token = ''; let demo = false; let generation = 0;
  const scoped=path=>{
    const url=new URL(path,'http://portal.local');
    if(url.origin!=='http://portal.local'||!url.pathname.startsWith('/')||url.pathname.includes('..'))throw Error('Ruta de administración inválida.');
    if(url.searchParams.has('merchantId')&&url.searchParams.get('merchantId')!==merchantId)throw Error('La sesión pertenece a otro comercio.');
    if(merchantId)url.searchParams.set('merchantId',merchantId);
    return url.pathname+url.search;
  };
  const authorization = ()=>{if(!token)throw Error('Ingresá nuevamente para continuar.');return {Authorization:`Bearer ${token}`};};
  const request = async(path, options={})=>{
    const current=generation;
    try {
      let body=options.body;
      if(body){const parsed=JSON.parse(body);if(parsed.merchantId&&parsed.merchantId!==merchantId)throw Error('La sesión pertenece a otro comercio.');body=JSON.stringify({...parsed,...(merchantId?{merchantId}: {})});}
      const result=await requestJSON(`${apiBase}/admin${scoped(path)}`,{...options,...(body?{body}:{}),headers:{...options.headers,...authorization()}},fetcher);if(current!==generation)throw Error('La sesión cambió. Ingresá nuevamente.');return result;
    }
    catch(error){if(current===generation&&(error.status===401||error.status===403)){generation++;token='';demo=false;}throw error;}
  };
  async function establish(candidate,isDemo,current) {
    if(!candidate || current!==generation)throw Error('La sesión ya no está disponible.');
    try {const overview=await requestJSON(`${apiBase}/admin${scoped('/overview')}`,{headers:{Authorization:`Bearer ${candidate}`}},fetcher);if(current!==generation)throw Error('La sesión fue cerrada.');if(merchantId&&overview.merchant?.id!==merchantId)throw Error('La sesión pertenece a otro comercio.');merchantId||=overview.merchant?.id||'';token=candidate;demo=isDemo;return overview;}
    catch(error){if(current===generation){token='';demo=false;}throw error;}
  }
  return {
    get authenticated(){return Boolean(token);}, get isDemo(){return demo;}, authorization, request,
    logout(){generation++;token='';demo=false;},
    async login(config,email,password) {
      const current=++generation;token='';demo=false;
      if(!config.supabase?.url||!config.supabase?.publishableKey)throw Error('Supabase Auth todavía no está configurado.');
      const auth=await requestJSON(`${config.supabase.url.replace(/\/$/,'')}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:config.supabase.publishableKey},body:JSON.stringify({email,password})},fetcher);
      return establish(auth.access_token,false,current);
    },
    async demo() {
      const current=++generation;token='';demo=false;
      const session=await requestJSON(`${apiBase}/admin/demo-session`,{method:'POST',body:JSON.stringify(merchantId?{merchantId}:{})},fetcher);
      return establish(session.accessToken,true,current);
    }
  };
}

export function parseDiscountForm({areaId,enabled,tiers}){
  return validateDiscountRule({areaId,enabled:Boolean(enabled),tiers:tiers.map(row=>({minOrders:Number(row.minOrders),type:row.type,value:row.type==='fixed'?parseUYU(row.value):parseUYU(row.value)}))});
}
export async function refreshAdminState(session,{isCurrent=()=>true,onState}){
  const state=await session.request('/overview');
  if(!isCurrent()||!session.authenticated)return false;
  onState(state);return true;
}
export function renderPriceExplanation(calculation){
  const c=calculation,esc=escapeHTML;
  if(!c)return '<p>No hay una cotización disponible para esta selección.</p>';
  const tier=c.tier?`Desde ${c.tier.minOrders} pedidos: ${c.tier.type==='fixed'?formatUYU(c.tier.value):`${c.tier.value/100}%`}`:'No se alcanzó un escalón activo';
  const source={base:'Tarifa normal',grouping:'Descuento por agrupación',promotion:'Oferta manual de zona'}[c.source]||'Tarifa calculada';
  return `<dl class="breakdown"><div><dt>Tarifa base</dt><dd>${formatUYU(c.normalPriceMinor)}</dd></div><div><dt>Pedidos coincidentes confirmados</dt><dd>${esc(c.confirmedCount)}</dd></div><div><dt>Escalón alcanzado</dt><dd>${esc(tier)}</dd></div><div><dt>Precio mínimo</dt><dd>${formatUYU(c.safetyFloorMinor)}</dd></div><div><dt>Descuento efectivo</dt><dd>− ${formatUYU(c.discountMinor)}</dd></div><div class="final"><dt>Precio final</dt><dd>${formatUYU(c.priceMinor)}</dd></div></dl><p>${esc(source)}${c.minimumApplied?' · Limitado por el mínimo configurado.':''}</p>`;
}

export function createExternalShipmentIntent(send,createKey=()=>crypto.randomUUID()) {
  let intent=null;
  return {
    invalidate(){intent=null;},
    async submit(payload){
      const fingerprint=JSON.stringify({areaId:payload.areaId,inputAddress:payload.inputAddress,deliveryDate:payload.deliveryDate,priceMinor:payload.priceMinor});
      if(!intent||intent.fingerprint!==fingerprint)intent={fingerprint,key:createKey()};
      const current=intent;
      const result=await send(payload,{headers:{'Idempotency-Key':current.key}});
      if(result!==false&&intent===current)intent=null;
      return result;
    }
  };
}

const moneyFields={minimumMinor:'Mínimo por envío',fuelPriceMinorPerLiter:'Combustible por litro',laborMinorPerHour:'Trabajo por hora',roundingMinor:'Redondeo del precio'};
const numberFields={fuelLitersPer100Km:'Litros cada 100 km',serviceMinutes:'Minutos por parada',marginBps:'Margen (puntos base; 1500 = 15%)',quoteMinutes:'Vigencia cotización (5 minutos, fijo)',holdMinutes:'Vigencia reserva (15 minutos, fijo)'};
export function parsePolicy(values) {
  const policy={};
  for(const key of Object.keys(moneyFields))policy[key]=parseUYU(values[key]);
  for(const key of Object.keys(numberFields)){
    const value=String(values[key]??'').trim();const number=Number(value);
    if(!value||!Number.isFinite(number)||number<0||(key!=='fuelLitersPer100Km'&&!Number.isInteger(number)))throw Error(`Revisá ${numberFields[key]}.`);
    policy[key]=number;
  }
  if(policy.roundingMinor<=0||policy.quoteMinutes<=0||policy.holdMinutes<=0)throw Error('El redondeo y las vigencias deben ser mayores a cero.');
  if(policy.quoteMinutes!==5||policy.holdMinutes!==15)throw Error('Las vigencias están fijadas en 5 minutos para cotizaciones y 15 para reservas.');
  return policy;
}
export function parseServiceDay(values) {
  const capacity=Number(values.capacity);const duration=Number(values.duration);
  const date=new Date(`${values.deliveryDate}T12:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(values.deliveryDate)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==values.deliveryDate||!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.departureTime)||!Number.isInteger(capacity)||capacity<1||capacity>10||!Number.isInteger(duration)||duration<1||duration>240)throw Error('Revisá la fecha, la salida y los límites de cupo y duración.');
  return {deliveryDate:values.deliveryDate,departureTime:values.departureTime,capacity,maxDurationSeconds:duration*60,enabled:Boolean(values.enabled)};
}
