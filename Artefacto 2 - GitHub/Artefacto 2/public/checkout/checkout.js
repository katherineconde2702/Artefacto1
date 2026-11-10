import {createCart,mountBagCount} from '../store/cart.js';
import {SHIPPING_API,requestJSON,formatUYU,escapeHTML,validateQuotes,deliveryLabel} from '../widget/shipping-widget.js';

export function checkoutTotal(checkout, quote = null) {
  if (checkout?.currency !== 'UYU' || !Number.isSafeInteger(checkout.subtotalMinor) || checkout.subtotalMinor < 0) throw new Error('El comercio debe devolver un subtotal válido en UYU.');
  if (quote) validateQuotes([quote]);
  const total = checkout.subtotalMinor + (quote?.priceMinor || 0);
  if (!Number.isSafeInteger(total)) throw new Error('Total fuera de rango.');
  return total;
}
export function createStoreCheckout(items,fetcher=globalThis.fetch){
  return requestJSON(`${SHIPPING_API}/store/checkouts`,{method:'POST',body:JSON.stringify({items:items.map(({productId,size,quantity})=>({productId,size,quantity}))})},fetcher);
}

export class ReservationHold {
  constructor({now=()=>Date.now(),schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=(timer)=>globalThis.clearTimeout(timer),onExpire=()=>{}}={}) {
    this.now=now;this.schedule=schedule;this.cancel=cancel;this.onExpire=onExpire;this.current=null;this.timer=null;
  }
  reset() {this.cancel(this.timer);this.timer=null;this.current=null;}
  accept(reservation,snapshot) {
    const deadline=Date.parse(reservation?.expiresAt);
    if(!reservation?.id||!Number.isFinite(deadline))throw Error('La reserva no tiene una vigencia válida.');
    this.reset();const current={...snapshot,reservation,deadline,confirmed:false,confirmationPending:false,uncertain:false};this.current=current;
    if(deadline<=this.now()){this.expire(current);return null;}
    this.timer=this.schedule(()=>{if(this.current===current&&!current.confirmed&&this.now()>=deadline)this.expire(current);},deadline-this.now());
    return current;
  }
  expire(snapshot) {
    if(this.current!==snapshot||snapshot.confirmed||snapshot.confirmationPending||snapshot.uncertain)return false;
    this.reset();this.onExpire(snapshot);return true;
  }
  reject(snapshot,error) {
    if(this.current!==snapshot||snapshot.confirmed)return false;
    snapshot.confirmationPending=false;
    if(error.status===410){snapshot.uncertain=false;return this.expire(snapshot);}
    snapshot.uncertain=true;this.cancel(this.timer);this.timer=null;return false;
  }
  confirm(snapshot) {
    if(this.current!==snapshot)return false;
    snapshot.confirmed=true;snapshot.confirmationPending=false;snapshot.uncertain=false;this.cancel(this.timer);this.timer=null;return true;
  }
  async confirmRequest(snapshot,request,onConfirmed) {
    if(this.current!==snapshot||snapshot.confirmed||snapshot.confirmationPending)return {status:'stale'};
    if(!snapshot.uncertain&&this.now()>=snapshot.deadline){this.expire(snapshot);return {status:'expired'};}
    snapshot.confirmationPending=true;this.cancel(this.timer);this.timer=null;
    try{await request(snapshot.reservation.id,snapshot.contextToken);}
    catch(error){
      if(this.current!==snapshot)return {status:'stale'};
      if(this.reject(snapshot,error))return {status:'expired'};
      return {status:'uncertain',error};
    }
    if(!this.confirm(snapshot))return {status:'stale'};
    onConfirmed(snapshot);return {status:'confirmed'};
  }
}

async function initializeCheckout() {
  const cart = mountBagCount(); const $ = (selector) => document.querySelector(selector); const widget=$('shipping-widget');
  let context = null; let selected = null; let version = 0; let selectionRevision = 0; let reserving = false; let reservation = null;
  const status = (text,error=false)=>{ $('#checkout-status').textContent=text; $('#checkout-status').className=`status ${error?'error':''}`; };
  const hold = new ReservationHold({onExpire:(snapshot)=>{
    if(snapshot.version!==version)return;
    const recovery=refresh();const recoveryVersion=version;
    recovery.then(()=>{if(version===recoveryVersion)status('La reserva venció. Confirmá otra vez el destino y elegí un nuevo día de envío.',true);});
  }});
  const totals = ()=>{
    $('#subtotal').textContent=context ? formatUYU(context.checkout.subtotalMinor) : '—';
    $('#shipping-price').textContent=selected ? formatUYU(selected.priceMinor) : 'Elegí un día';
    $('#total').textContent=context ? formatUYU(checkoutTotal(context.checkout, selected)) : '—';
    $('#delivery-choice').textContent=selected ? deliveryLabel(selected) : 'Confirmá un destino y elegí una opción de entrega.';
    $('#reserve').disabled=!context || !selected || reserving || Boolean(reservation);
  };
  const invalidate = ()=>{if(reservation)return;selectionRevision++;selected=null;totals();};
  function renderLines(items, products=[]) {
    $('#cart-lines').innerHTML=items.map((item)=>{
      const product=products.find((product)=>product.id===item.productId); const line=context?.checkout.items.find((line)=>line.productId===item.productId&&line.size===item.size);
      const price=line?.lineTotalMinor ?? (Number.isSafeInteger(line?.unitPriceMinor)?line.unitPriceMinor*item.quantity:null);
      return `<article class="line-item"><img src="${escapeHTML(product?.productImage || '/assets/garment-set.png')}" alt="${escapeHTML(product?.name || 'Prenda MAREA')}"><div><h3>${escapeHTML(product?.name || item.productId)}</h3><span class="hint">Talle ${escapeHTML(item.size)}${price!==null?' · '+formatUYU(price):''}</span><div class="line-controls"><label>Cantidad <input data-key="${escapeHTML(item.key)}" type="number" min="0" max="99" step="1" value="${item.quantity}" aria-label="Cantidad de ${escapeHTML(product?.name || item.productId)} talle ${escapeHTML(item.size)}"></label><button class="text-button" data-remove="${escapeHTML(item.key)}" type="button">Quitar</button></div></div></article>`;
    }).join('');
    $('#cart-lines').querySelectorAll('[data-key]').forEach((input)=>input.addEventListener('change',()=>{try{cart.update(input.dataset.key,Number(input.value));refresh();}catch(error){status(error.message,true);input.value=cart.items().find((line)=>line.key===input.dataset.key)?.quantity || 0;}}));
    $('#cart-lines').querySelectorAll('[data-remove]').forEach((button)=>button.addEventListener('click',()=>{cart.update(button.dataset.remove,0);refresh();}));
  }
  async function refresh() {
    hold.reset();
    const current=++version; context=null; reservation=null; reserving=false; widget.inert=false;widget.closest('.panel').hidden=false; widget.setContext(''); invalidate(); $('#reservation').hidden=true;
    const items=cart.items(); mountBagCount(cart); $('#empty').hidden=items.length>0; $('#checkout-content').hidden=!items.length;
    if (!items.length) { status(''); return; }
    status('Verificando tu selección y sus precios…');
    renderLines(items);
    try {
      const result=await createStoreCheckout(items);
      if (current!==version) return;
      checkoutTotal(result.checkout); if (!result.contextToken || !Array.isArray(result.checkout.items)) throw Error('No se pudo verificar tu bolsa.');
      context=result;
      const catalog=await requestJSON('/api/v1/products'); if(current!==version) return;
      const products=Array.isArray(catalog)?catalog:catalog.products || [];
      renderLines(items, products);
      widget.setContext(result.contextToken); totals(); status('Precios verificados en UYU. Elegí tu destino.');
    } catch(error) { if(current===version){context=null;invalidate();status(error.message,true);} }
  }
  widget.addEventListener('shipping:invalidated',invalidate);
  widget.addEventListener('shipping:quote-selected',(event)=>{if(!context)return;selectionRevision++;selected=event.detail.quote;totals();});
  $('#reserve').addEventListener('click',async()=>{
    if(!context||!selected||reserving||reservation)return;
    if(Date.parse(selected.expiresAt)<=Date.now()){invalidate();status('La cotización venció. Elegí nuevamente tu envío.',true);return;}
    const current=version; const revision=selectionRevision; const token=context.contextToken; const quote=selected;
    reserving=true;totals(); status('Reservando tu cupo de entrega…');
    try {
      const result=await widget.reserve();
      if(!result||current!==version||revision!==selectionRevision)return;
      const received=result.reservation || result;
      const snapshot=hold.accept(received,{version:current,contextToken:token,quote});if(!snapshot)return;
      reservation=received;widget.inert=true;widget.closest('.panel').hidden=true;
      const element=$('#reservation');element.hidden=false;
      element.innerHTML=`<strong>Tu envío está reservado.</strong><p>Entrega: ${escapeHTML(deliveryLabel(quote))}</p><p class="hint">Reserva ${escapeHTML(reservation.id)}${reservation.expiresAt?' · Vence '+escapeHTML(new Date(reservation.expiresAt).toLocaleTimeString('es-UY')):''}</p>${quote.mode==='demo'?'<p class="demo-note">Demo local · Sin pago ni entrega real.</p><button id="demo-confirm" class="secondary wide">Confirmar pedido demo, sin pago</button>':'<p>Tu reserva ocupa un cupo durante 15 minutos. Se suma a los pedidos para descuentos por agrupación cuando el comercio confirma el pedido.</p>'}`;
      status('Cupo reservado. No se realizó ningún cobro.');
      $('#demo-confirm')?.addEventListener('click',async(event)=>{
        if(hold.current!==snapshot)return;
        event.target.disabled=true;
        status('Confirmando el pedido demo…');
        const result=await hold.confirmRequest(snapshot,(id,contextToken)=>requestJSON(`${SHIPPING_API}/reservations/${encodeURIComponent(id)}/demo-confirm`,{method:'POST',body:JSON.stringify({contextToken})}),()=>{
          if(current!==version)return;
          cart.clear();mountBagCount(cart);element.innerHTML='<strong>Pedido demo confirmado.</strong><p>No se realizó ningún cobro. Los datos son temporales y no se hará una entrega real.</p><a href="/" class="secondary">Volver a MAREA</a>';status('Confirmación demo completada.');
        });
        if(result.status==='uncertain'&&current===version&&hold.current===snapshot){
          status('No pudimos verificar la respuesta. El pedido puede haberse confirmado. Reintentá esta misma confirmación para comprobar su estado.',true);
          event.target.disabled=false;event.target.textContent='Reintentar confirmación demo';
        }
      });
    } catch(error) {if(current===version)status(error.message,true);}
    finally {if(current===version){reserving=false;totals();}}
  });
  window.addEventListener('storage',()=>location.reload()); await refresh();
}
if (globalThis.document?.querySelector('shipping-widget')) initializeCheckout();
