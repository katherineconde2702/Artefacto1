import {formatUYU} from '../store/money.js';
import {selectDeliveryOptions} from '../shipping-admin/rules.js';
export {formatUYU,parseUYU} from '../store/money.js';
export const SHIPPING_API = '/api/v1/shipping';
export function deliveryLabel(quote){return `${quote.deliveryDate}${quote.windowStart&&quote.windowEnd?` · ${quote.windowStart}–${quote.windowEnd}`:''}`;}
export const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export async function requestJSON(url, options = {}, fetcher = globalThis.fetch) {
  const response = await fetcher(url, {...options, headers:{Accept:'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}});
  let payload;
  try { payload = await response.json(); } catch { throw new Error('El servicio no devolvió una respuesta válida.'); }
  if (!response.ok) {const error=new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message || `No se pudo completar la operación (${response.status}).`);error.status=response.status;throw error;}
  return payload;
}
export function validateQuotes(quotes) {
  if (!Array.isArray(quotes) || quotes.some((quote) => !quote.id || quote.currency !== 'UYU' || !Number.isSafeInteger(quote.priceMinor) || quote.priceMinor < 0 || !Number.isFinite(Date.parse(quote.expiresAt)))) throw new Error('La cotización recibida no es válida en UYU.');
  return selectDeliveryOptions(quotes);
}
export class ZoneSelection {
  constructor(config,onChange=()=>{}) {this.config=config;this.onChange=onChange;this.departmentId='';this.areaId='';}
  get needsNeighborhood(){return this.departmentId==='montevideo';}
  get areas(){return (this.config.areas||[]).filter(area=>area.departmentId===this.departmentId);}
  selectDepartment(id){
    if(id&&!(this.config.departments||[]).some(department=>department.id===id))throw Error('Departamento no válido.');
    this.departmentId=id;this.areaId=id&&id!=='montevideo'?(this.areas.find(area=>area.id===`dept-${id}`)?.id||''):'';this.onChange();
  }
  selectArea(id){if(!this.needsNeighborhood||(id&&!this.areas.some(area=>area.id===id)))throw Error('Barrio no válido para el departamento.');this.areaId=id;this.onChange();}
  destination({allowUnavailable=false}={}){
    const area=this.areas.find(area=>area.id===this.areaId);
    if(!area)throw Error('Elegí un departamento y, para Montevideo, un barrio.');
    if(!allowUnavailable&&area.available!==true)throw Error('Esta zona todavía no tiene una tarifa disponible.');
    return {areaId:area.id};
  }
}
export function renderZoneSelector(selection,prefix='destination',{allowUnavailable=false}={}){
  const esc=escapeHTML;const selectedArea=selection.areas.find(area=>area.id===selection.areaId);
  return `<label for="${prefix}-department">Departamento<select id="${prefix}-department" name="departmentId" required><option value="">Elegí un departamento</option>${(selection.config.departments||[]).map(department=>`<option value="${esc(department.id)}" ${selection.departmentId===department.id?'selected':''}>${esc(department.name)}</option>`).join('')}</select></label>${selection.needsNeighborhood?`<label for="${prefix}-area">Barrio de Montevideo<select id="${prefix}-area" name="areaId" required><option value="">Elegí un barrio</option>${selection.areas.map(area=>`<option value="${esc(area.id)}" ${selection.areaId===area.id?'selected':''} ${!allowUnavailable&&area.available!==true?'disabled':''}>${esc(area.name)}${area.available===false?' · Sin tarifa habilitada':''}</option>`).join('')}</select></label>`:selection.departmentId?`<input type="hidden" name="areaId" value="${esc(selection.areaId)}"><p class="note">${esc(selectedArea?.name||'Zona no disponible')}${!allowUnavailable&&selectedArea?.available!==true?' · Sin tarifa habilitada':''}</p>`:''}`;
}
export class ShippingSession {
  constructor(request = (path, body, options = {}) => requestJSON(`${SHIPPING_API}${path}`, {...options,method:'POST', body:JSON.stringify(body)})) {
    this.request = request; this.version = 0; this.contextToken = ''; this.address = null; this.quotes = []; this.selected = null;this.quoted=false;
  }
  invalidateAddress() { this.version++; this.address = null; this.quotes = []; this.selected = null; this.reservationIntent = null;this.quoted=false; }
  setContext(token) { this.invalidateAddress(); this.contextToken = token || ''; }
  async resolve(inputAddress) {
    this.invalidateAddress(); const version = this.version;
    const destination=typeof inputAddress==='object'&&inputAddress!==null?{areaId:inputAddress.areaId}:{inputAddress};
    const result = await this.request('/addresses/resolve', {contextToken:this.contextToken,...destination});
    if (version !== this.version) return false;
    if (!result.address?.id || !result.address.formattedAddress) throw new Error('No pudimos identificar el destino.');
    this.address = result.address; return true;
  }
  async loadQuotes() {
    if (!this.address?.id || !this.contextToken) throw new Error('Confirmá primero tu destino.');
    const version = ++this.version; this.quotes = []; this.selected = null; this.reservationIntent = null;this.quoted=false;
    const result = await this.request('/quotes', {contextToken:this.contextToken,addressId:this.address.id,confirmed:true});
    if (version !== this.version) return false;
    this.quotes = validateQuotes(result.quotes);this.quoted=true; return true;
  }
  select(id) {
    const quote = this.quotes.find((item) => item.id === id);
    if (!quote || Date.parse(quote.expiresAt) <= Date.now()) throw new Error('La cotización venció. Consultá los días nuevamente.');
    if (this.selected?.id !== quote.id) this.reservationIntent = null;
    this.selected = quote; return quote;
  }
  async reserve() {
    const quote = this.selected, contextToken = this.contextToken, version = this.version;
    if (!contextToken || !quote || Date.parse(quote.expiresAt) <= Date.now()) throw new Error('Elegí una cotización vigente para reservar.');
    this.reservationIntent ||= {key:crypto.randomUUID(),quoteId:quote.id,contextToken};
    const result = await this.request('/reservations', {contextToken,quoteId:quote.id}, {headers:{'Idempotency-Key':this.reservationIntent.key}});
    if (version !== this.version || quote !== this.selected || contextToken !== this.contextToken) return false;
    const reservation = result?.reservation;
    if (!reservation?.id || !['held','confirmed'].includes(reservation.status) || reservation.currency !== 'UYU' || reservation.priceMinor !== quote.priceMinor || !Number.isFinite(Date.parse(reservation.expiresAt))) throw new Error('El servicio no devolvió una reserva válida.');
    return result;
  }
}

if (globalThis.HTMLElement && globalThis.customElements && !customElements.get('shipping-widget')) {
  class ShippingWidget extends HTMLElement {
    static observedAttributes = ['context-token', 'api-base', 'merchant-id'];
    constructor() {
      super(); this.attachShadow({mode:'open'}); this.inputAddress = ''; this.busy = false; this.error = ''; this.config = null; this.generation = 0;this.operation=0;
      this.session = new ShippingSession((path, body, options = {}) => requestJSON(`${this.api}${path}`, {...options,method:'POST',body:JSON.stringify(body)}));
    }
    get api() { return this.getAttribute('api-base') || SHIPPING_API; }
    connectedCallback() { this.loadConfig(); }
    disconnectedCallback() { clearTimeout(this.expiryTimer); this.generation++; this.session.invalidateAddress(); }
    attributeChangedCallback(name, oldValue, value) {
      if (oldValue === value) return;
      this.operation++;this.session.setContext(this.getAttribute('context-token')); this.busy = false; this.error = ''; this.emit('invalidated');
      if (this.isConnected && name !== 'context-token') this.loadConfig(); else if (this.isConnected) this.render();
    }
    setContext(token) { this.setAttribute('context-token', token || ''); }
    setCheckoutContext(token) { this.setContext(token); }
    emit(name, detail = {}) { this.dispatchEvent(new CustomEvent(`shipping:${name}`, {detail,bubbles:true,composed:true})); }
    async loadQuotes() {
      if (await this.session.loadQuotes()) this.emit('quoted',{quotes:this.session.quotes,address:this.session.address});
    }
    selectQuote(id) {
      const quote=this.session.select(id);const detail={quote,address:this.session.address};
      this.emit('selected',detail);this.emit('quote-selected',detail);this.render();return quote;
    }
    async reserve() {
      const version=this.session.version,quote=this.session.selected,address=this.session.address;
      try {
        const result=await this.session.reserve();
        if (result) this.emit('reserved',{reservation:result.reservation,quote,address});
        return result;
      } catch(error) {
        if(version===this.session.version)this.emit('error',{message:error.message});
        throw error;
      }
    }
    async loadConfig() {
      const generation = ++this.generation; this.config = null; this.busy = true; this.render();
      try { const config = await requestJSON(`${this.api}/config?merchantId=${encodeURIComponent(this.getAttribute('merchant-id') || 'marea')}`); if (generation === this.generation) this.config = config; }
      catch(error) { if (generation === this.generation) this.error = error.message; }
      finally { if (generation === this.generation) {this.busy = false; this.render();} }
    }
    async run(operation) {
      const operationId=++this.operation;const version = this.session.version; const generation = this.generation; this.busy = true; this.error = ''; this.emit('invalidated'); this.render();
      try { await operation(); }
      catch(error) { if (operationId===this.operation&&generation === this.generation && this.session.version <= version + 1) { this.error = error.message; this.emit('error', {message:error.message}); } }
      finally { if (operationId===this.operation&&generation === this.generation) { this.busy = false; this.render(); } }
    }
    render() {
      clearTimeout(this.expiryTimer);
      const {address,quotes,selected,contextToken} = this.session;
      const lowestPrice = quotes.length ? Math.min(...quotes.map(quote=>quote.priceMinor)) : null;
      const esc = escapeHTML;
      const zonesMode=this.config?.pricingMode!=='distance';
      if(zonesMode&&this.config&&this.zoneSelection?.config!==this.config)this.zoneSelection=new ZoneSelection(this.config,()=>{this.operation++;this.busy=false;this.error='';this.session.invalidateAddress();this.emit('invalidated');this.render();});
      this.shadowRoot.innerHTML = `<style>
        :host{display:block;color:#302e29;font:14px/1.5 Arial,sans-serif}*{box-sizing:border-box}[hidden]{display:none!important}h2{font:normal 29px Georgia,serif;margin:0 0 12px}p{margin:10px 0}.note{color:#656959;font-size:12px}.demo{padding:10px 13px;background:#e9eddc;color:#47533b;border-left:3px solid #697451}.error{color:#8a382d;background:#f7e9e0;padding:12px}label{display:block;margin:12px 0}input[type=text],select{width:100%;padding:13px;border:1px solid #cfc8bc;background:#fffdf8;font:inherit}button{padding:13px 17px;border:1px solid #59634f;background:#59634f;color:white;font:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #a1804d;outline-offset:3px}.options{display:grid;gap:9px;margin:16px 0}.option{padding:14px;border:1px solid #d6d0c5;display:flex;gap:12px;align-items:center;cursor:pointer}.option:has(input:checked){border-color:#59634f;background:#eef0e5}.option strong{margin-left:auto;white-space:nowrap}.address{border:1px solid #d6d0c5;padding:14px}del{font-size:12px;color:#777}fieldset{border:0;padding:0;margin:0}legend{font:normal 21px Georgia,serif}
        .google-attribution{display:inline-block;white-space:nowrap;font:400 14px Arial,sans-serif;color:#5e5e5e;background:#fffdf8}.lowest{display:inline-block;font-size:12px;color:#36442c;background:#e9eddc;padding:2px 6px}
      </style><section aria-busy="${this.busy}"><h2>Tu envío, a tu medida</h2>
      ${this.config?.mode === 'demo' ? `<p class="demo">${zonesMode?'Modo demo · Tarifas manuales de ejemplo por zona. Sin distancias, Maps ni cobro real.':'Modo demo · Direcciones y recorridos simulados. Usá Centro, Pocitos o Malvín. Sin Google Maps ni cobro real.'}</p>` : ''}
      ${this.error ? `<p class="error" role="alert">${esc(this.error)}</p>` : ''}
      ${this.busy ? '<p role="status">Consultando disponibilidad…</p>' : ''}
      ${!this.config ? '<p class="note">Cargando configuración de envíos.</p>' : this.config.available === false ? '<p role="status">Los envíos requieren configuración del comercio. Volvé a intentarlo más tarde.</p>' : !contextToken ? '<p class="note">Agregá prendas a tu bolsa para consultar el envío.</p>' : `
      <form>${zonesMode?renderZoneSelector(this.zoneSelection):`<label for="destination">Dirección de entrega en Montevideo</label><input id="destination" name="destination" type="text" autocomplete="street-address" required minlength="5" maxlength="300" value="${esc(this.inputAddress)}" placeholder="Calle, número y barrio">`}
      <p class="note" id="destination-use">${zonesMode?'Elegí tu zona de Uruguay. Sólo la enviaremos al consultar. La zona no sustituye una dirección completa de entrega.':this.config.mode === 'demo' ? 'Al buscar, usaremos esta dirección sólo en la simulación local.' : 'Al buscar, consultaremos esta dirección con Google Maps para calcular el envío.'}</p>
      <button type="submit" aria-describedby="destination-use" ${this.busy ? 'disabled' : ''}>${zonesMode?'Consultar destino':'Buscar destino'}</button></form>
      ${address ? `<div class="address"><p class="note">${zonesMode?'Revisá la zona antes de continuar':'Revisá la dirección antes de continuar'}</p><p><strong>${esc(address.formattedAddress)}</strong>${this.config.mode === 'live' && address.provider === 'google' ? '<br><span class="google-attribution" translate="no">Google Maps</span>' : ''}</p><button id="confirm" type="button" ${this.busy ? 'disabled' : ''}>${this.session.quoted?'Actualizar días y precios':zonesMode?'Confirmar zona y ver días':'Confirmar destino y ver días'}</button></div>` : ''}
      ${quotes.length ? `<fieldset class="options"><legend>Elegí tu día y horario</legend>${quotes.map((quote) => `<label class="option"><input type="radio" name="delivery" value="${esc(quote.id)}" ${selected?.id === quote.id ? 'checked' : ''}><span>${esc(quote.label || deliveryLabel(quote))}<br><small>${quote.windowStart?'Franja de entrega':esc(quote.deliveryDate)}${quote.promotionId ? ' · Oferta de zona' : ''}</small>${quote.calculation?.source==='grouping'?`<br><small>Ahorrás ${formatUYU(quote.calculation.discountMinor)} por agrupación · ${esc(quote.calculation.confirmedCount)} pedido(s) coincidentes confirmados</small>`:''}${quote.priceMinor === lowestPrice ? '<br><span class="lowest">Menor precio</span>' : ''}</span><strong>${quote.normalPriceMinor > quote.priceMinor ? `<del>${formatUYU(quote.normalPriceMinor)}</del><br>` : ''}${formatUYU(quote.priceMinor)}</strong></label>`).join('')}<p class="note">Precio válido por 5 minutos; el cupo se confirma al reservar. Los descuentos no se acumulan y respetan el mínimo del comercio.</p></fieldset>` : address && !this.busy ? `<p class="note" role="status">${this.session.quoted?'No hay entregas disponibles para esta zona. Podés actualizar los días y precios o elegir otra zona.':'Confirmá el destino para ver los días y precios disponibles.'}</p>` : ''}`}</section>`;
      this.shadowRoot.querySelector('form')?.addEventListener('submit',(event)=>{ event.preventDefault(); if (this.busy) return;try{const destination=zonesMode?this.zoneSelection.destination():this.inputAddress;this.run(()=>this.session.resolve(destination));}catch(error){this.error=error.message;this.render();} });
      this.shadowRoot.querySelector('#destination-department')?.addEventListener('change',event=>this.zoneSelection.selectDepartment(event.target.value));
      this.shadowRoot.querySelector('#destination-area')?.addEventListener('change',event=>this.zoneSelection.selectArea(event.target.value));
      this.shadowRoot.querySelector('#destination')?.addEventListener('input',(event)=>{
        this.inputAddress = event.target.value; this.session.invalidateAddress(); this.emit('invalidated');
        this.shadowRoot.querySelector('.address')?.remove(); this.shadowRoot.querySelector('.options')?.remove();
      });
      this.shadowRoot.querySelector('#confirm')?.addEventListener('click',()=>this.run(()=>this.loadQuotes()));
      this.shadowRoot.querySelectorAll('[name=delivery]').forEach((input)=>input.addEventListener('change',()=>{
        try { this.selectQuote(input.value); }
        catch(error) {this.error=error.message;this.session.selected=null;this.emit('invalidated');this.render();}
      }));
      if (selected) this.expiryTimer = setTimeout(()=>{this.session.quotes=[];this.session.selected=null;this.session.reservationIntent=null;this.error='La cotización venció. Confirmá el destino para consultar otra vez.';this.emit('invalidated');this.render();},Math.max(0,Date.parse(selected.expiresAt)-Date.now()));
    }
  }
  customElements.define('shipping-widget', ShippingWidget);
}
