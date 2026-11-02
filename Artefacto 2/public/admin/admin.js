import {SHIPPING_API,requestJSON,parseUYU,formatUYU,escapeHTML,ZoneSelection,renderZoneSelector} from '../widget/shipping-widget.js';

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

export function renderAuditHistory(events = [],areas=[]) {
  const esc=escapeHTML;
  const operations={zone_rate_save:'Tarifa de zona actualizada',settings_save:'Costos actualizados',price_save:'Precio de prenda actualizado',promotion_save:'Oferta actualizada',service_day_save:'Día de servicio actualizado',external_create:'Entrega externa creada',reserve:'Reserva creada',confirm:'Envío confirmado',demo_confirm:'Envío demo confirmado',cancel:'Envío cancelado'};
  const entities={zone_rate:'Tarifa de zona',rate_policy:'Costos de envío',product_price:'Prenda',promotion:'Oferta',service_day:'Día de entrega',shipment:'Envío'};
  const actors={'demo-admin':'Administrador demo','commerce-server':'Servidor del comercio','demo-buyer':'Comprador demo','checkout-buyer':'Comprador'};
  const labels={...moneyFields,...numberFields,priceMinor:'Precio',areaId:'Zona',deliveryDate:'Entrega',active:'Oferta activa',departureTime:'Salida',capacity:'Cupos',maxDurationSeconds:'Duración máxima',enabled:'Habilitada',status:'Estado'};
  const date=value=>new Intl.DateTimeFormat('es-UY',{timeZone:'America/Montevideo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
  const value=(key,input)=>{
    if(input===null||input===undefined)return '—';
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
  return `<table><thead><tr><th>Fecha / persona</th><th>Cambio</th><th>Detalle</th></tr></thead><tbody>${events.slice(0,100).map(event=>{
    const before=event.changes?.before||{},after=event.changes?.after||{};
    const fields=Object.keys(labels).filter(key=>before[key]!==after[key]&&(before[key]!==undefined||after[key]!==undefined));
    const detail=fields.map(key=>`${esc(labels[key])}: ${esc(value(key,before[key]))} → ${esc(value(key,after[key]))}`).join('<br>')||'Sin cambios de valores.';
    const at=Number.isFinite(Date.parse(event.createdAt))?date(event.createdAt):'Fecha no disponible';
    return `<tr><td>${esc(at)}<br><span title="${esc(event.actor)}">${esc(actors[event.actor]||'Administrador')}</span>${event.mode==='demo'?' · Demo':''}</td><td>${esc(operations[event.operation]||'Cambio registrado')}<br><span title="${esc(event.entityId)}">${esc(entities[event.entityType]||'Registro')}</span></td><td>${detail}</td></tr>`;
  }).join('')||'<tr><td colspan="3">Sin cambios registrados.</td></tr>'}</tbody></table>`;
}

export function createAdminSession(fetcher = globalThis.fetch) {
  let token = ''; let demo = false; let generation = 0;
  const authorization = ()=>{if(!token)throw Error('Ingresá nuevamente para continuar.');return {Authorization:`Bearer ${token}`};};
  const request = async(path, options={})=>{
    const current=generation;
    try {const result=await requestJSON(`${SHIPPING_API}/admin${path}`,{...options,headers:{...options.headers,...authorization()}},fetcher);if(current!==generation)throw Error('La sesión cambió. Ingresá nuevamente.');return result;}
    catch(error){if(current===generation&&(error.status===401||error.status===403)){generation++;token='';demo=false;}throw error;}
  };
  async function establish(candidate,isDemo,current) {
    if(!candidate || current!==generation)throw Error('La sesión ya no está disponible.');
    try {const overview=await requestJSON(`${SHIPPING_API}/admin/overview?merchantId=marea`,{headers:{Authorization:`Bearer ${candidate}`}},fetcher);if(current!==generation)throw Error('La sesión fue cerrada.');token=candidate;demo=isDemo;return overview;}
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
      const session=await requestJSON(`${SHIPPING_API}/admin/demo-session`,{method:'POST',body:JSON.stringify({merchantId:'marea'})},fetcher);
      return establish(session.accessToken,true,current);
    }
  };
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

async function initializeAdmin(){
  const $=(selector)=>document.querySelector(selector);const esc=escapeHTML;const session=createAdminSession();let config;let state={};let products=[];let working=false;
  const selectors={};
  const pricingMode=()=>state.pricingMode||config?.pricingMode||'zones';
  const geography=()=>({...config,...state,areas:state.areas||config?.areas||[],departments:state.departments||config?.departments||[]});
  const externalIntent=createExternalShipmentIntent((payload,options)=>save('/shipments','POST',payload,options.headers));
  const status=(message,error=false)=>{$('#admin-status').textContent=message;$('#admin-status').className=`status ${error?'error':''}`;};
  const moneyInput=(key,value,label)=>`<label>${esc(label)} (UYU)<input name="${esc(key)}" type="text" inputmode="decimal" value="${esc((value/100).toFixed(2))}" required></label>`;
  function fillRate(){
    const form=$('#zone-rate-form');const rate=state.zoneRates?.find(rate=>rate.areaId===selectors['zone-rate-form']?.areaId);
    form.elements.price.value=rate?(rate.priceMinor/100).toFixed(2):'';form.elements.enabled.checked=Boolean(rate?.enabled);
  }
  function mountSelector(formId,prefix){
    const form=$(`#${formId}`),container=form.querySelector('[data-zone-selector]');
    if(!selectors[formId])selectors[formId]=new ZoneSelection(geography(),()=>{if(formId==='external-form')externalIntent.invalidate();mountSelector(formId,prefix);if(formId==='zone-rate-form')fillRate();});
    const selection=selectors[formId];selection.config=geography();
    container.innerHTML=renderZoneSelector(selection,prefix,{allowUnavailable:true});
    container.querySelector(`#${prefix}-department`)?.addEventListener('change',event=>selection.selectDepartment(event.target.value));
    container.querySelector(`#${prefix}-area`)?.addEventListener('change',event=>selection.selectArea(event.target.value));
  }
  function render(){
    $('#login-panel').hidden=true;$('#dashboard').hidden=false;
    $('#session-label').textContent=session.isDemo?'DEMO LOCAL · Datos temporales · Sin Supabase real':`${state.merchant?.name || 'MAREA'} · Sesión con membresía verificada`;
    const policy=state.policy||{};
    const zonesMode=pricingMode()==='zones';
    $('#zone-rates').hidden=!zonesMode;$('#zone-rates-link').hidden=!zonesMode;
    $('#admin-intro').textContent=zonesMode?'Tarifas manuales por barrio en Montevideo y por departamento en el interior. Sin cálculo de distancias.':'Costos y ofertas del modo distancia, con rutas verificadas por Google Maps.';
    $('#promotion-hint').textContent=zonesMode?'Una oferta activa por zona y fecha. Siempre respeta el mínimo manual del comercio.':'Una oferta activa por barrio y fecha. Respeta el mínimo y el piso protegido de la ruta.';
    $('#external-hint').textContent=zonesMode?'El envío externo ocupa cupo de despacho. La zona no sustituye el domicilio completo; cancelar requiere un motivo.':'El envío externo confirmado participa de los ingresos de su recorrido. Cancelar requiere un motivo.';
    $('#day-form').elements.duration.closest('label').hidden=zonesMode;$('#day-form').elements.duration.readOnly=zonesMode;
    $('#settings-form').innerHTML=Object.entries(moneyFields).map(([key,label])=>moneyInput(key,policy[key]??0,label)).join('')+Object.entries(numberFields).map(([key,label])=>`<label>${esc(label)}<input name="${key}" type="number" min="0" step="${key==='fuelLitersPer100Km'?'0.1':'1'}" value="${esc(key==='quoteMinutes'?5:key==='holdMinutes'?15:policy[key]??0)}" ${['quoteMinutes','holdMinutes'].includes(key)?'readonly':''} required></label>`).join('')+'<button class="primary form-actions">Guardar costos</button>';
    if(zonesMode){$('#settings-form').innerHTML=moneyInput('minimumMinor',policy.minimumMinor??0,'Mínimo manual por envío')+'<p class="hint form-actions">Las tarifas y ofertas respetan este mínimo. Cotización: 5 minutos; reserva: 15 minutos. No se calculan combustible, kilómetros ni subsidios por otros envíos.</p><button class="primary form-actions">Guardar mínimo</button>';$('#costs h2').textContent='Mínimo manual';}else $('#costs h2').textContent='Un precio sostenible';
    $('#prices-form').innerHTML=products.map((product)=>moneyInput(product.id,state.prices?.[product.id]??Math.round(product.price*100),product.name)).join('')+'<button class="primary">Guardar precios UYU</button>';
    const areas=state.areas || config.areas || [];
    const distanceArea=$('#promotion-form [data-distance-area]');distanceArea.hidden=zonesMode;distanceArea.querySelector('select').disabled=zonesMode;distanceArea.querySelector('select').innerHTML=areas.map(area=>`<option value="${esc(area.id)}">${esc(area.name)}</option>`).join('');
    const distanceDestination=$('#external-form [data-distance-destination]');distanceDestination.hidden=zonesMode;distanceDestination.querySelector('input').disabled=zonesMode;
    for(const [formId,prefix]of [['zone-rate-form','tariff'],['promotion-form','offer'],['external-form','external']]){const container=$(`#${formId} [data-zone-selector]`);container.hidden=!zonesMode;if(zonesMode)mountSelector(formId,prefix);else container.replaceChildren();}
    if(zonesMode){fillRate();$('#zone-rate-list').innerHTML=`<table><thead><tr><th>Zona</th><th>Tarifa UYU</th><th>Estado</th></tr></thead><tbody>${(state.zoneRates||[]).map(rate=>`<tr><td>${esc(areas.find(area=>area.id===rate.areaId)?.name||rate.areaId)}</td><td>${formatUYU(rate.priceMinor)}</td><td>${rate.enabled?'Habilitada':'Deshabilitada'} <button type="button" class="text-button" data-rate="${esc(rate.areaId)}">Editar</button></td></tr>`).join('')||'<tr><td colspan="3">Sin tarifas configuradas. Las zonas sin tarifa habilitada no cotizan.</td></tr>'}</tbody></table>`;}
    $('#promotion-list').innerHTML=`<table><thead><tr><th>Zona / fecha</th><th>Precio</th><th>Estado</th></tr></thead><tbody>${(state.promotions||[]).map((promotion)=>`<tr><td>${esc(areas.find((area)=>area.id===promotion.areaId)?.name||promotion.areaId)}<br>${esc(promotion.deliveryDate)}</td><td>${formatUYU(promotion.priceMinor)}</td><td><button class="text-button" data-promotion="${esc(promotion.id)}">${promotion.active?'Desactivar':'Activar'}</button></td></tr>`).join('')||'<tr><td colspan="3">Sin ofertas todavía.</td></tr>'}</tbody></table>`;
    $('#day-list').innerHTML=`<table><thead><tr><th>Día</th><th>Salida</th><th>Cupos</th><th>Estado</th></tr></thead><tbody>${(state.days||[]).map((day)=>`<tr><td>${esc(day.deliveryDate)}</td><td>${esc(day.departureTime||'10:00')}</td><td>${esc(day.capacity)}</td><td>${day.enabled?'Habilitado':'Cerrado'} <button class="text-button" data-day="${esc(day.deliveryDate)}">Editar</button></td></tr>`).join('')||'<tr><td colspan="4">Sin días configurados.</td></tr>'}</tbody></table>`;
    $('#shipment-list').innerHTML=`<table><thead><tr><th>Envío / destino</th><th>Día</th><th>Importe</th><th>Estado</th><th>Cancelación</th></tr></thead><tbody>${(state.shipments||[]).map((shipment)=>`<tr><td>${esc(shipment.id)}<br>${esc(shipmentDestination(shipment))}</td><td>${esc(shipment.deliveryDate)}</td><td>${formatUYU(shipment.priceMinor??0)}</td><td>${esc(shipment.status)}</td><td>${['cancelled','delivered'].includes(shipment.status)?`${esc(shipment.cancellationReason||shipment.reason||'—')}<br><small>${esc(shipment.cancelledBy)} · ${esc(shipment.cancelledAt)}</small>`:`<form data-cancel="${esc(shipment.id)}" class="stack"><label>Motivo<input name="reason" minlength="3" maxlength="300" required aria-label="Motivo para cancelar ${esc(shipment.id)}"></label><button class="secondary">Cancelar envío</button></form>`}</td></tr>`).join('')||'<tr><td colspan="5">Todavía no hay envíos.</td></tr>'}</tbody></table>`;
    $('#audit-list').innerHTML=renderAuditHistory(state.auditEvents,areas);
    $('#zone-rate-list').querySelectorAll('[data-rate]').forEach(button=>button.addEventListener('click',()=>{const area=areas.find(area=>area.id===button.dataset.rate);if(!area)return;const selection=selectors['zone-rate-form'];selection.selectDepartment(area.departmentId);if(selection.needsNeighborhood)selection.selectArea(area.id);fillRate();$('#zone-rate-form').elements.price.focus();}));
    $('#promotion-list').querySelectorAll('[data-promotion]').forEach((button)=>button.addEventListener('click',()=>{const promotion=state.promotions.find((item)=>item.id===button.dataset.promotion);save(`/promotions/${encodeURIComponent(promotion.id)}`,'PATCH',{...promotion,active:!promotion.active});}));
    $('#day-list').querySelectorAll('[data-day]').forEach((button)=>button.addEventListener('click',()=>{const day=state.days.find((day)=>day.deliveryDate===button.dataset.day);const form=$('#day-form');for(const key of ['deliveryDate','departureTime','capacity'])form.elements[key].value=day[key]??(key==='departureTime'?'10:00':'');form.elements.enabled.checked=day.enabled;form.elements.duration.value=(day.maxDurationSeconds||14400)/60;form.elements.deliveryDate.focus();}));
    $('#shipment-list').querySelectorAll('[data-cancel]').forEach((form)=>form.addEventListener('submit',(event)=>{event.preventDefault();save(`/shipments/${encodeURIComponent(form.dataset.cancel)}`,'PATCH',{status:'cancelled',reason:form.elements.reason.value.trim()});}));
  }
  const unwrap=(result)=>result.state||result;
  async function save(path,method,payload,headers={}){
    if(working)return false;working=true;let saved=false;status('Guardando y verificando los cambios…');
    $('#dashboard').querySelectorAll('button').forEach((button)=>{button.disabled=true;});
    try{await session.request(path,{method,headers,body:JSON.stringify({merchantId:'marea',...payload})});saved=true;state=unwrap(await session.request('/overview?merchantId=marea'));render();status(session.isDemo?'Guardado en datos demo temporales.':'Cambios guardados.');}
    catch(error){status(error.message,true);if(!session.authenticated)showLogin();}
    finally{working=false;$('#dashboard').querySelectorAll('button').forEach((button)=>{button.disabled=false;});}
    return saved;
  }
  function showLogin(){session.logout();$('#dashboard').hidden=true;$('#login-panel').hidden=false;$('#login').reset();$('#shipment-list').replaceChildren();$('#audit-list').replaceChildren();state={};}
  async function login(demo,event){
    event?.preventDefault();if(working)return;working=true;
    $('#login-button').disabled=true;$('#demo-login').disabled=true;status('Verificando la sesión y la membresía…');
    try{state=unwrap(demo?await session.demo():await session.login(config,$('#login').elements.email.value,$('#login').elements.password.value));$('#login').reset();render();status(demo?'Administración demo local. Los cambios son temporales.':'Sesión verificada.');}
    catch(error){showLogin();status(error.message,true);}
    finally{working=false;$('#login-button').disabled=false;$('#demo-login').disabled=false;}
  }
  $('#login').addEventListener('submit',(event)=>login(false,event));$('#demo-login').addEventListener('click',(event)=>login(true,event));$('#logout').addEventListener('click',()=>{showLogin();status('Sesión cerrada.');});
  $('#settings-form').addEventListener('submit',(event)=>{event.preventDefault();try{const values=Object.fromEntries(new FormData(event.currentTarget));save('/settings','PUT',{policy:pricingMode()==='zones'?parseZonePolicy(values,state.policy):parsePolicy(values)});}catch(error){status(error.message,true);}});
  $('#zone-rate-form').addEventListener('submit',event=>{event.preventDefault();try{const values=Object.fromEntries(new FormData(event.currentTarget));save('/zone-rates','PUT',parseZoneRate(values,geography(),state.policy.minimumMinor));}catch(error){status(error.message,true);}});
  $('#prices-form').addEventListener('submit',(event)=>{event.preventDefault();try{const prices={};for(const [id,value]of new FormData(event.currentTarget)){const price=parseUYU(value);if(price<=0)throw Error('Los precios deben ser mayores a cero.');prices[id]=price;}save('/prices','PUT',{prices});}catch(error){status(error.message,true);}});
  $('#promotion-form').addEventListener('submit',(event)=>{event.preventDefault();try{const values=Object.fromEntries(new FormData(event.currentTarget));const areaId=pricingMode()==='zones'?selectors['promotion-form'].destination({allowUnavailable:true}).areaId:values.areaId;save('/promotions','POST',{areaId,deliveryDate:values.deliveryDate,priceMinor:parseUYU(values.price),active:true});}catch(error){status(error.message,true);}});
  $('#day-form').addEventListener('submit',(event)=>{event.preventDefault();try{const day=parseServiceDay(Object.fromEntries(new FormData(event.currentTarget)));save('/service-days','PUT',{day});}catch(error){status(error.message,true);}});
  $('#external-form').addEventListener('input',()=>externalIntent.invalidate());
  $('#external-form').addEventListener('change',()=>externalIntent.invalidate());
  $('#external-form').addEventListener('submit',(event)=>{event.preventDefault();try{const values=Object.fromEntries(new FormData(event.currentTarget));externalIntent.submit(parseExternalShipment(values,{...geography(),pricingMode:pricingMode()})).catch(error=>status(error.message,true));}catch(error){status(error.message,true);}});
  try{config=await requestJSON(`${SHIPPING_API}/config?merchantId=marea`);$('#demo-entry').hidden=!config.demoAdminAvailable;$('#login-button').disabled=!config.supabase?.url;const catalog=await requestJSON('/api/v1/products');products=Array.isArray(catalog)?catalog:catalog.products||[];status(config.demoAdminAvailable?'Elegí una cuenta o abrí la demostración local.':config.supabase?.url?'Ingresá con tu cuenta del comercio.':'Supabase Auth requiere configuración del comercio.');}
  catch(error){status(error.message,true);$('#login-button').disabled=true;}
}
if(globalThis.document?.querySelector('#login-panel'))initializeAdmin();
