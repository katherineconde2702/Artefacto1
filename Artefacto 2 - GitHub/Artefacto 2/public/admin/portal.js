import {SHIPPING_API,requestJSON,formatUYU,parseUYU,escapeHTML,ZoneSelection,renderZoneSelector} from '../widget/shipping-widget.js';
import {createAdminSession,parseZoneRate,parseZonePolicy,parseDiscountForm,renderPriceExplanation,renderAuditHistory,shipmentDestination,renderShipmentActions,createExternalShipmentIntent,parseServiceDay,refreshAdminState} from './admin.js';
import {calculateZonePrice,validateDeliveryWindow} from '../shipping-admin/rules.js';
import {renderTariffMap} from './tariff-map.js';

const $=selector=>document.querySelector(selector),esc=escapeHTML;
let config=null,session=null,state=null,working=false,refreshing=false,view='overview',ruleDraft=[];
let rateMapScope='montevideo',rateMapSelected='',rateMapZoom=1;
const selectors={};
const pages={overview:['Operación','Resumen'],shipments:['Operación','Envíos'],zones:['Configuración','Zonas y tarifas'],discounts:['Configuración','Descuentos'],windows:['Configuración','Franjas y cupos'],offers:['Configuración','Promociones'],history:['Sistema','Historial'],integration:['Sistema','Integración']};
const status=(message,error=false)=>{const node=$('#portal-status');node.textContent=message;node.className='status'+(error?' error':'');};
const amount=value=>(value/100).toFixed(2);
const areaName=id=>id==='*'?'Regla general':state.areas.find(area=>area.id===id)?.name||id;
const checked=value=>value?'checked':'';
const tag=(enabled,yes='Activa',no='Desactivada')=>`<span class="tag ${enabled?'':'off'}">${enabled?yes:no}</span>`;
const table=(headers,rows,empty)=>`<table><thead><tr>${headers.map(label=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${headers.length}">${esc(empty)}</td></tr>`}</tbody></table>`;
function showEditor(form,field){field?.focus({preventScroll:true});form.scrollIntoView({behavior:'smooth',block:'start'});}
function setView(next,refresh=true){view=next;document.querySelectorAll('[data-page]').forEach(node=>node.hidden=node.dataset.page!==view);document.querySelectorAll('[data-view]').forEach(node=>{node.classList.toggle('active',node.dataset.view===view);if(node.dataset.view===view)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');});const [category,title]=pages[view];$('#page-category').textContent=category;$('#page-title').textContent=title;document.title=`${title} · TRAMO`;if(view==='zones'&&state)renderRates();if(refresh&&session?.authenticated)refreshOverview();}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.open)));
$('.identity').addEventListener('click',event=>{if(session?.authenticated){event.preventDefault();setView('overview');}});

function tomorrow(){const date=new Date(Date.now()+86400000);return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Montevideo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
function geometry(){return {...state,areas:state.areas.map(area=>({...area,available:state.zoneRates.some(rate=>rate.areaId===area.id&&rate.enabled)}))};}
function installSelector(name){
 const container=document.querySelector(`[data-zone-selector="${name}"]`),previous=selectors[name];
 const selection=new ZoneSelection(geometry(),()=>{container.innerHTML=renderZoneSelector(selection,name,{allowUnavailable:true});if(name==='rate')fillRate();});selectors[name]=selection;
 container.onchange=event=>{try{if(event.target.name==='departmentId')selection.selectDepartment(event.target.value);if(event.target.name==='areaId')selection.selectArea(event.target.value);}catch(error){status(error.message,true);}};
 if(previous?.departmentId){selection.selectDepartment(previous.departmentId);if(selection.needsNeighborhood&&previous.areaId)selection.selectArea(previous.areaId);}else container.innerHTML=renderZoneSelector(selection,name,{allowUnavailable:true});
}
function chooseArea(name,id){const area=state.areas.find(area=>area.id===id);if(!area)return;selectors[name].selectDepartment(area.departmentId);if(selectors[name].needsNeighborhood)selectors[name].selectArea(id);}
function fillRate(){const form=$('#portal-zone-form'),id=selectors.rate?.areaId,rate=state?.zoneRates.find(rate=>rate.areaId===id);form.elements.price.value=rate?amount(rate.priceMinor):'';form.elements.enabled.checked=rate?.enabled===true;$('#zone-form-title').textContent=id?`Tarifa · ${areaName(id)}`:'Tarifa de zona';const area=state.areas.find(area=>area.id===id);rateMapSelected=area?.id||'';if(area)rateMapScope=area.departmentId==='montevideo'?'montevideo':'uruguay';renderRates();}
function dispatches(){
 const windowDates=new Set(state.windows.map(window=>window.deliveryDate));
 return [...state.windows.filter(window=>window.enabled).map(window=>({key:'window:'+window.id,deliveryDate:window.deliveryDate,windowId:window.id,startTime:window.startTime,label:`${window.deliveryDate} · ${window.startTime}–${window.endTime}`})),...state.days.filter(day=>day.enabled&&!windowDates.has(day.deliveryDate)).map(day=>({key:'day:'+day.deliveryDate,deliveryDate:day.deliveryDate,startTime:day.departureTime,label:`${day.deliveryDate} · Salida ${day.departureTime} (anterior)`}))].filter(row=>Date.parse(`${row.deliveryDate}T${row.startTime}:00-03:00`)>Date.now()).sort((a,b)=>a.label.localeCompare(b.label));
}
function selectedDispatch(form){const row=dispatches().find(row=>row.key===form.elements.dispatch.value);if(!row)throw Error('Elegí una fecha y franja disponible.');return {deliveryDate:row.deliveryDate,...(row.windowId?{windowId:row.windowId}:{})};}
function fillDispatches(){const html='<option value="">Elegí una fecha y franja</option>'+dispatches().map(row=>`<option value="${esc(row.key)}">${esc(row.label)}</option>`).join('');for(const id of ['#portal-preview','#portal-external-form']){const select=$(id).elements.dispatch,previous=select.value;select.innerHTML=html;select.value=previous;}}
function renderRates(){
 const map=$('#portal-rate-map');map.innerHTML=renderTariffMap(state,{scope:rateMapScope,selected:rateMapSelected,zoom:rateMapZoom,labelScale:Math.max(1,760/(map.clientWidth||760))});
 const select=id=>{
  if(id==='montevideo'){rateMapScope='montevideo';rateMapZoom=1;selectors.rate.selectDepartment('montevideo');return;}
  if(!id){selectors.rate.selectDepartment('');return;}
  chooseArea('rate',id);const form=$('#portal-zone-form');showEditor(form,form.elements.price);
 };
 map.querySelector('#map-area').addEventListener('change',event=>select(event.target.value));
 map.querySelectorAll('[data-map-zone]').forEach(region=>{region.addEventListener('click',()=>select(region.dataset.mapZone));region.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();select(region.dataset.mapZone);}});});
 map.querySelectorAll('[data-map-scope]').forEach(button=>button.addEventListener('click',()=>{rateMapScope=button.dataset.mapScope;rateMapZoom=1;selectors.rate.selectDepartment('');}));
 map.querySelectorAll('[data-map-zoom]').forEach(button=>button.addEventListener('click',()=>{const action=button.dataset.mapZoom;rateMapZoom=action==='reset'?1:Math.max(.5,Math.min(4,action==='in'?rateMapZoom*1.5:rateMapZoom/1.5));renderRates();map.querySelector(`[data-map-zoom="${action}"]`)?.focus({preventScroll:true});}));
}
function readTiers(){return [...$('#tier-editor').querySelectorAll('.tier-row')].map(row=>({minOrders:row.querySelector('[name=minOrders]').value,type:row.querySelector('[name=type]').value,value:row.querySelector('[name=value]').value}));}
function renderTiers(tiers){
 ruleDraft=tiers;$('#tier-count').value=tiers.length;
 $('#tier-editor').innerHTML=tiers.map((tier,index)=>`<div class="tier-row"><span class="tier-number" aria-hidden="true">${String(index+1).padStart(2,'0')}</span><label><span class="sr-only">Pedidos mínimos del escalón ${index+1}</span><input name="minOrders" type="number" min="1" max="1000" value="${esc(tier.minOrders)}" required></label><label><span class="sr-only">Tipo de descuento del escalón ${index+1}</span><select name="type"><option value="fixed" ${tier.type==='fixed'?'selected':''}>Importe UYU</option><option value="percent" ${tier.type==='percent'?'selected':''}>Porcentaje %</option></select></label><label><span class="sr-only">Descuento del escalón ${index+1}</span><input name="value" inputmode="decimal" value="${esc(tier.value)}" required></label><button type="button" class="quiet tier-remove" data-remove-tier="${index}" aria-label="Quitar escalón ${index+1}">×</button></div>`).join('');
 $('#tier-editor').querySelectorAll('[data-remove-tier]').forEach(button=>button.addEventListener('click',()=>{const rows=readTiers();rows.splice(Number(button.dataset.removeTier),1);renderTiers(rows);}));
}
function resizeTiers(count){if(!Number.isInteger(count)||count<0||count>20){status('Elegí entre 0 y 20 escalones. Una regla activa necesita al menos uno.',true);return;}const rows=readTiers();while(rows.length<count)rows.push({minOrders:Math.min(1000,Math.max(0,...rows.map(row=>Number(row.minOrders)||0))+1),type:rows.at(-1)?.type||'fixed',value:rows.at(-1)?.value||'50'});renderTiers(rows.slice(0,count));}
function fillRule(){
 const form=$('#portal-rule-form'),areaId=form.elements.areaId.value,rule=state.discountRules.find(rule=>rule.areaId===areaId);form.elements.enabled.checked=rule?.enabled===true;
 $('#rule-form-title').textContent=areaId==='*'?(rule?'Editar regla general':'Configurar regla general'):`${rule?'Editar':'Nueva'} regla · ${areaName(areaId)}`;
 renderTiers(rule?rule.tiers.map(tier=>({...tier,value:amount(tier.value)})):[{minOrders:1,type:'fixed',value:'50'},{minOrders:2,type:'fixed',value:'100'}]);
 $('#rule-inheritance').textContent=areaId==='*'?(rule?'Aplica a las zonas sin una regla propia.':'Sin regla guardada. Activá y guardá para aplicar los escalones.'):rule?(rule.enabled?'Regla propia de esta zona. Reemplaza la general.':'Regla propia desactivada. Esta zona no recibe descuentos automáticos.'):'Hereda la regla general. Guardar crea una excepción para esta zona.';
 $('#simulation-result').replaceChildren();$('#live-preview').replaceChildren();
}
function currentRule(){const form=$('#portal-rule-form');return parseDiscountForm({areaId:form.elements.areaId.value,enabled:form.elements.enabled.checked,tiers:readTiers()});}
function renderRules(preserveDraft=false){
 if(!preserveDraft){const previous=$('#rule-scope').value;$('#rule-scope').innerHTML='<option value="*">Todas las zonas · Regla general</option>'+state.areas.map(area=>`<option value="${esc(area.id)}">${esc(area.name)}</option>`).join('');$('#rule-scope').value=previous||'*';fillRule();}
 $('#portal-rule-list').innerHTML=table(['Aplicación','Escalones','Estado',''],state.discountRules.map(rule=>`<tr><td>${esc(areaName(rule.areaId))}</td><td>${rule.tiers.map(tier=>`Desde ${tier.minOrders}: ${tier.type==='fixed'?formatUYU(tier.value):`${tier.value/100}%`}`).join('<br>')||'Sin escalones'}</td><td>${tag(rule.enabled)}</td><td><button type="button" class="quiet" data-rule="${esc(rule.areaId)}">Editar</button></td></tr>`),'Sin reglas guardadas. No se aplican descuentos automáticos.');
 $('#portal-rule-list').querySelectorAll('[data-rule]').forEach(button=>button.addEventListener('click',()=>{const form=$('#portal-rule-form');form.elements.areaId.value=button.dataset.rule;fillRule();showEditor(form,form.querySelector('[name=minOrders]')||form.elements.enabled);}));
}
function newWindow(){const form=$('#portal-window-form');form.reset();form.elements.id.value=crypto.randomUUID();form.elements.deliveryDate.value=tomorrow();$('#window-form-title').textContent='Nueva franja';}
function renderWindows(){
 $('#portal-window-list').innerHTML=table(['Fecha','Horario','Ocupados / tope','Estado',''],[...state.windows].sort((a,b)=>(a.deliveryDate+a.startTime).localeCompare(b.deliveryDate+b.startTime)).map(window=>{const used=state.windowUsage?.find(row=>row.windowId===window.id)?.occupied||0;return `<tr><td>${esc(window.deliveryDate)}</td><td>${esc(window.startTime)}–${esc(window.endTime)}</td><td>${used} / ${window.capacity}</td><td>${tag(window.enabled,'Abierta','Cerrada')}</td><td><button class="quiet" data-window="${esc(window.id)}">Editar</button></td></tr>`;}),'Todavía no hay franjas configuradas.');
 $('#portal-window-list').querySelectorAll('[data-window]').forEach(button=>button.addEventListener('click',()=>{const window=state.windows.find(row=>row.id===button.dataset.window),form=$('#portal-window-form');for(const key of ['id','deliveryDate','startTime','endTime','capacity'])form.elements[key].value=window[key];form.elements.enabled.checked=window.enabled;$('#window-form-title').textContent='Editar franja';showEditor(form,form.elements.deliveryDate);}));
 const days=state.days.filter(day=>!state.windows.some(window=>window.deliveryDate===day.deliveryDate));
 $('#legacy-days').innerHTML=days.length?`<hr><h3>Salidas sin franja</h3><p class="field-help">Los pedidos asignados conservan su salida.</p>${table(['Fecha','Salida','Cupo','Estado',''],days.map(day=>`<tr><td>${esc(day.deliveryDate)}</td><td>${esc(day.departureTime)}</td><td>${day.capacity}</td><td>${tag(day.enabled,'Habilitada','Cerrada')}</td><td><button class="quiet" data-legacy="${esc(day.deliveryDate)}">Editar</button></td></tr>`),'')}`:'';
 $('#legacy-days').querySelectorAll('[data-legacy]').forEach(button=>button.addEventListener('click',()=>{const day=days.find(day=>day.deliveryDate===button.dataset.legacy),form=$('#portal-legacy-form');for(const key of ['deliveryDate','departureTime','capacity','maxDurationSeconds'])form.elements[key].value=day[key];form.elements.enabled.checked=day.enabled;form.hidden=false;showEditor(form,form.elements.departureTime);}));
 if(!$('#portal-window-form').elements.id.value)newWindow();
 if(state.windows.some(window=>window.id===$('#portal-window-form').elements.id.value))$('#window-form-title').textContent='Editar franja';
}
function renderOffers(){
 $('#portal-offer-list').innerHTML=table(['Zona','Fecha','Precio final','Estado',''],state.promotions.map(offer=>`<tr><td>${esc(areaName(offer.areaId))}</td><td>${esc(offer.deliveryDate)}</td><td>${formatUYU(offer.priceMinor)}</td><td>${tag(offer.active)}</td><td><button class="quiet" data-offer="${esc(offer.id)}">Editar</button></td></tr>`),'No hay ofertas manuales.');
 const form=$('#portal-offer-form'),selected=state.promotions.find(row=>row.id===form.elements.id.value);$('#offer-form-title').textContent=selected?`Editar promoción · ${areaName(selected.areaId)}`:'Nueva promoción';
 $('#portal-offer-list').querySelectorAll('[data-offer]').forEach(button=>button.addEventListener('click',()=>{const offer=state.promotions.find(row=>row.id===button.dataset.offer),form=$('#portal-offer-form');chooseArea('offer',offer.areaId);form.elements.id.value=offer.id;form.elements.deliveryDate.value=offer.deliveryDate;form.elements.price.value=amount(offer.priceMinor);form.elements.active.checked=offer.active;$('#offer-form-title').textContent=`Editar promoción · ${areaName(offer.areaId)}`;showEditor(form,form.elements.price);}));
}
function renderShipments(){
 const names={held:'Reservado',confirmed:'Confirmado',cancelled:'Cancelado',expired:'Vencido',completed:'Completado'};
 $('#portal-shipment-list').innerHTML=table(['Destino / pedido','Fecha y franja','Importe','Estado','Acciones'],[...state.shipments].reverse().map(shipment=>`<tr><td>${esc(shipmentDestination(shipment))}<br><small>${esc(shipment.externalOrderRef||shipment.id)}</small></td><td>${esc(shipment.deliveryDate||'—')}${shipment.windowStart?`<br>${esc(shipment.windowStart)}–${esc(shipment.windowEnd)}`:''}</td><td>${formatUYU(shipment.priceMinor)}</td><td>${esc(names[shipment.status]||shipment.status)}</td><td>${renderShipmentActions(shipment)}</td></tr>`),'Todavía no hay envíos.');
 $('#portal-shipment-list').querySelectorAll('[data-confirm]').forEach(button=>button.addEventListener('click',()=>save(`/shipments/${encodeURIComponent(button.dataset.confirm)}/confirm`,'POST',{})));
 $('#portal-shipment-list').querySelectorAll('[data-cancel]').forEach(form=>form.addEventListener('submit',event=>{event.preventDefault();save(`/shipments/${encodeURIComponent(form.dataset.cancel)}`,'PATCH',{status:'cancelled',reason:form.elements.reason.value.trim()});}));
}
function renderActivity(){
 const titles={zone_rate_save:'Tarifa de zona actualizada',settings_save:'Mínimo y costos actualizados',promotion_save:'Promoción actualizada',service_day_save:'Salida actualizada',external_create:'Envío registrado',reserve:'Cupo reservado',confirm:'Envío confirmado',demo_confirm:'Envío de prueba confirmado',cancel:'Envío cancelado',discount_rule_save:'Regla de descuento actualizada',delivery_window_save:'Franja actualizada'};
 $('#overview-activity').innerHTML=(state.auditEvents||[]).slice(0,5).map(event=>{const zone=state.areas.find(area=>area.id===event.entityId),valid=Number.isFinite(Date.parse(event.createdAt)),date=valid?new Date(event.createdAt).toLocaleDateString('es-UY',{day:'2-digit',month:'short'}):'—';return `<div class="activity-item"><span class="activity-dot" aria-hidden="true"></span><div><strong>${esc(titles[event.operation]||'Configuración actualizada')}</strong><small>${esc(zone?.name||({discount_rule:'Descuentos',delivery_window:'Franjas y cupos',shipment:'Envíos',promotion:'Promociones',rate_policy:'Configuración'}[event.entityType]||'Configuración'))}</small></div><time>${esc(date)}</time></div>`;}).join('')||'<div class="empty-state">Sin actividad registrada.</div>';
}
function render(){
 state.windows||=[];state.discountRules||=[];state.zoneRates||=[];
 $('#portal-login-panel').hidden=true;$('#portal-dashboard').hidden=false;$('#portal-nav').hidden=false;$('#portal-logout').hidden=false;$('#portal-refresh').hidden=false;
 $('#scope-label').textContent=`${state.merchant.name} · ${state.merchant.id}`;$('#merchant-badge').textContent=state.merchant.name;$('#environment-label').textContent=session.isDemo?'Demostración':'En línea';
 renderMetrics();
 for(const name of ['rate','offer','external','preview'])installSelector(name);
 $('#portal-minimum-form').elements.minimum.value=amount(state.policy.minimumMinor);
 renderRates();renderRules();renderWindows();renderOffers();renderShipments();fillDispatches();$('#portal-history').innerHTML=renderAuditHistory(state.auditEvents,state.areas);
 $('#integration-details').innerHTML=`<p>Identificador del comercio</p><code class="integration-code">${esc(state.merchant.id)}</code><p>URL de la API</p><code class="integration-code">${esc(location.origin+SHIPPING_API)}</code><p>Componente para tu página</p><code class="integration-code">${esc(`<shipping-widget api-base="${location.origin+SHIPPING_API}" merchant-id="${state.merchant.id}" context-token="CONTEXTO_CREADO_POR_TU_SERVIDOR"></shipping-widget>`)}</code>`;
 setView(view,false);
 updateReadiness();
 if(state.pricingMode!=='zones')status('Este panel administra tarifas por zona. Configurá SHIPPING_PRICING_MODE=zones para usarlo.',true);
}
function updateReadiness(){$('#b2b-setup-note').hidden=state.b2bReady===true;for(const id of ['portal-rule-form','portal-window-form','portal-preview'])$('#'+id).querySelectorAll('button').forEach(button=>button.disabled=state.b2bReady!==true);}
function renderMetrics(){$('#metrics').innerHTML=[[state.zoneRates.filter(rate=>rate.enabled).length,'Zonas habilitadas'],[state.windows.filter(window=>window.enabled&&Date.parse(`${window.deliveryDate}T${window.startTime}:00-03:00`)>Date.now()).length,'Franjas próximas'],[state.shipments.filter(row=>row.status==='confirmed').length,'Pedidos confirmados'],[formatUYU(state.policy.minimumMinor),'Mínimo por envío']].map(([value,label])=>`<div class="metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join('');renderActivity();}
async function refreshOverview(manual=false){
 if(working||refreshing||!session?.authenticated)return false;refreshing=true;const active=session;$('#portal-refresh').disabled=true;
 try{return await refreshAdminState(active,{isCurrent:()=>session===active&&!working,onState:next=>{
   const reasons=new Map([...document.querySelectorAll('[data-cancel]')].map(form=>[form.dataset.cancel,form.elements.reason.value]));
   state=next;state.windows||=[];state.discountRules||=[];state.zoneRates||=[];renderMetrics();renderRates();renderRules(true);renderWindows();renderOffers();renderShipments();fillDispatches();updateReadiness();$('#portal-history').innerHTML=renderAuditHistory(state.auditEvents,state.areas);
   document.querySelectorAll('[data-cancel]').forEach(form=>{if(reasons.has(form.dataset.cancel))form.elements.reason.value=reasons.get(form.dataset.cancel);});
   if(manual)status('Datos actualizados.');
 }});}catch(error){if(session===active&&!active.authenticated)logout(false);status(error.message,true);return false;}finally{refreshing=false;$('#portal-refresh').disabled=false;}
}
$('#portal-refresh').addEventListener('click',()=>refreshOverview(true));window.addEventListener('focus',()=>refreshOverview());
async function run(action,{refresh=false,message='Cambios guardados.'}={}){
 if(working)return false;working=true;const active=session;$('#portal-dashboard').inert=true;status('Guardando…');
 try{const result=await action();if(refresh){const next=await active.request('/overview');if(session!==active||!active.authenticated)return false;state=next;render();}status(session?.isDemo?'Cambios guardados en la demostración.':message);return result;}
 catch(error){if(!active?.authenticated)logout(false);status(error.message,true);return false;}
 finally{working=false;$('#portal-dashboard').inert=false;}
}
const save=(path,method,body,headers={})=>run(()=>session.request(path,{method,headers,body:JSON.stringify(body)}),{refresh:true});
const externalIntent=createExternalShipmentIntent((body,options)=>save('/shipments','POST',body,options.headers));
function logout(clearMessage=true){session?.logout();session=null;state=null;rateMapSelected='';rateMapScope='montevideo';rateMapZoom=1;$('#portal-login-panel').hidden=false;$('#portal-dashboard').hidden=true;$('#portal-nav').hidden=true;$('#portal-logout').hidden=true;$('#portal-refresh').hidden=true;$('#portal-legacy-form').hidden=true;$('#scope-label').textContent='Panel de comercios';$('#merchant-badge').textContent='Sin sesión';$('#page-category').textContent='Administración';$('#page-title').textContent='Acceso';document.title='TRAMO · Administración';$('#portal-login').reset();document.querySelectorAll('#portal-dashboard form').forEach(form=>form.reset());for(const id of ['metrics','overview-activity','portal-rate-map','portal-rule-list','portal-window-list','portal-offer-list','portal-shipment-list','portal-history','integration-details','simulation-result','live-preview','tier-editor','legacy-days'])$('#'+id).replaceChildren();for(const key of Object.keys(selectors))delete selectors[key];externalIntent.invalidate();view='overview';if(clearMessage)status('Sesión cerrada.');}
$('#portal-logout').addEventListener('click',()=>logout());
async function login(event,demo=false){
 event.preventDefault();if(working)return;working=true;const form=$('#portal-login');status('Verificando tu cuenta y los permisos del comercio…');
 try{const merchantId=demo?config.demoMerchantId:form.elements.merchantId.value.trim();if(!merchantId)throw Error('Ingresá el identificador de tu comercio.');session=createAdminSession(globalThis.fetch,{merchantId});state=demo?await session.demo():await session.login(config,form.elements.email.value,form.elements.password.value);form.elements.password.value='';render();status(session.isDemo?'Demostración · Datos de ejemplo.':'Sesión iniciada.');}
 catch(error){logout(false);status(error.message,true);}finally{working=false;}
}
$('#portal-login').addEventListener('submit',event=>login(event));$('#portal-demo').addEventListener('click',event=>login(event,true));
function formAction(id,action){$(id).addEventListener('submit',event=>{event.preventDefault();if(working)return;try{Promise.resolve(action(event.currentTarget)).catch(error=>status(error.message,true));}catch(error){status(error.message,true);}});}
formAction('#portal-zone-form',form=>save('/zone-rates','PUT',parseZoneRate({...Object.fromEntries(new FormData(form)),enabled:form.elements.enabled.checked},geometry(),state.policy.minimumMinor)));
formAction('#portal-minimum-form',form=>save('/settings','PUT',{policy:parseZonePolicy({minimumMinor:form.elements.minimum.value},state.policy)}));
$('#rule-scope').addEventListener('change',fillRule);$('#tier-count').addEventListener('change',event=>resizeTiers(Number(event.target.value)));$('#add-tier').addEventListener('click',()=>resizeTiers(readTiers().length+1));
formAction('#portal-rule-form',()=>save('/discount-rules','PUT',{rule:currentRule()}));
formAction('#portal-simulator',form=>{const promotion=form.elements.promotion.value.trim();const result=calculateZonePrice({baseMinor:parseUYU(form.elements.base.value),minimumMinor:state.policy.minimumMinor,confirmedCount:Number(form.elements.count.value),rule:currentRule(),promotion:promotion?{priceMinor:parseUYU(promotion),id:'simulation'}:null});$('#simulation-result').innerHTML='<p class="eyebrow">SIMULACIÓN · NO PUBLICADA</p>'+renderPriceExplanation(result);});
formAction('#portal-preview',form=>{const dispatch=selectedDispatch(form),areaId=selectors.preview.destination({allowUnavailable:true}).areaId;run(async()=>{const result=await session.request('/pricing-preview',{method:'POST',body:JSON.stringify({areaId,...dispatch})});$('#live-preview').innerHTML='<p class="eyebrow">CONFIGURACIÓN GUARDADA · DEMANDA ACTUAL</p>'+renderPriceExplanation(result.calculation);return result;},{message:'Cotización vigente consultada. No se creó ninguna reserva.'});});
formAction('#portal-window-form',form=>{const values=Object.fromEntries(new FormData(form));const window=validateDeliveryWindow({...values,capacity:Number(values.capacity),enabled:form.elements.enabled.checked});save('/delivery-windows','PUT',{window});});
formAction('#portal-legacy-form',form=>{const values=Object.fromEntries(new FormData(form));save('/service-days','PUT',{day:parseServiceDay({...values,duration:Number(values.maxDurationSeconds)/60,enabled:form.elements.enabled.checked})});});
$('#new-window').addEventListener('click',()=>{newWindow();const form=$('#portal-window-form');showEditor(form,form.elements.deliveryDate);});
formAction('#portal-offer-form',async form=>{const id=form.elements.id.value;const areaId=selectors.offer.destination({allowUnavailable:true}).areaId;const result=await save(id?`/promotions/${encodeURIComponent(id)}`:'/promotions',id?'PATCH':'POST',{areaId,deliveryDate:form.elements.deliveryDate.value,priceMinor:parseUYU(form.elements.price.value),active:form.elements.active.checked});if(result?.promotion){form.elements.id.value=result.promotion.id;$('#offer-form-title').textContent=`Editar promoción · ${areaName(areaId)}`;}});
$('#new-offer').addEventListener('click',()=>{const form=$('#portal-offer-form');form.reset();form.elements.id.value='';selectors.offer.selectDepartment('');$('#offer-form-title').textContent='Nueva promoción';showEditor(form,form.querySelector('[name=departmentId]'));});
$('#portal-external-form').addEventListener('input',()=>externalIntent.invalidate());$('#portal-external-form').addEventListener('change',()=>externalIntent.invalidate());
formAction('#portal-external-form',form=>externalIntent.submit({...selectors.external.destination({allowUnavailable:true}),...selectedDispatch(form),priceMinor:parseUYU(form.elements.price.value)}));
try{config=await requestJSON(SHIPPING_API+'/portal-config');$('#environment-label').textContent=config.mode==='demo'?'Demostración':'Conectado';$('#portal-demo-entry').hidden=!config.demoAdminAvailable;$('#portal-login-button').disabled=!config.supabase?.url;status(config.demoAdminAvailable?'Demostración disponible.':config.supabase?.url?'Ingresá con la cuenta de tu comercio.':'El acceso de administración no está configurado.');}catch(error){status(error.message,true);$('#portal-login-button').disabled=true;}

let mapResizeFrame;window.addEventListener('resize',()=>{if(!state||view!=='zones')return;cancelAnimationFrame(mapResizeFrame);mapResizeFrame=requestAnimationFrame(()=>{if(state&&view==='zones')renderRates();});});
