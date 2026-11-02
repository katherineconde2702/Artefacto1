import test from 'node:test';
import assert from 'node:assert/strict';

// The DOM boundary only captures the component's rendered markup. State,
// requests, public methods and emitted events remain the production widget.
class Element extends EventTarget {
  constructor(){super();this.attributes=new Map();}
  attachShadow(){return this.shadowRoot={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};}
  getAttribute(name){return this.attributes.get(name)||null;}
  setAttribute(name,value){const old=this.getAttribute(name);this.attributes.set(name,value);this.attributeChangedCallback?.(name,old,value);}
}
globalThis.HTMLElement=Element;
let Widget;
globalThis.customElements={get:()=>undefined,define:(name,element)=>{Widget=element;}};
await import('../public/widget/shipping-widget.js');
const expiresAt=new Date(Date.now()+5*60000).toISOString();
const q=(id,priceMinor,date)=>({id,priceMinor,deliveryDate:date,currency:'UYU',expiresAt,mode:'demo'});
const quotes=[q('a',20000,'2098-01-01'),{...q('b',18000,'2098-01-02'),promotionId:'offer'},q('c',15000,'2098-01-03'),q('d',15000,'2098-01-04')];
const ready=()=>{const widget=new Widget();widget.config={available:true,mode:'demo',pricingMode:'distance'};return widget;};
const zones={available:true,mode:'demo',pricingMode:'zones',departments:[{id:'montevideo',name:'Montevideo'},{id:'canelones',name:'Canelones'}],areas:[{id:'centro',name:'Centro',departmentId:'montevideo',kind:'neighborhood',available:true},{id:'pocitos',name:'Pocitos',departmentId:'montevideo',kind:'neighborhood',available:false},{id:'dept-canelones',name:'Canelones',departmentId:'canelones',kind:'department',available:true}]};

test('zone selectors are local until Consultar and department changes reject old results',async()=>{
  const widget=ready();widget.config=zones;widget.setContext('checkout-zone');
  let form,department,area,html='';const requests=[];let finish;
  widget.shadowRoot={get innerHTML(){return html;},set innerHTML(value){html=value;form=new EventTarget();department=new EventTarget();area=new EventTarget();},querySelector:selector=>selector==='form'?form:selector==='#destination-department'?department:selector==='#destination-area'?area:null,querySelectorAll:()=>[]};
  widget.session.request=(path,body)=>{requests.push({path,body});return new Promise(resolve=>{finish=resolve;});};widget.render();
  department.value='montevideo';department.dispatchEvent(new Event('change'));area.value='centro';area.dispatchEvent(new Event('change'));
  assert.equal(requests.length,0);assert.doesNotMatch(widget.shadowRoot.innerHTML,/<input[^>]+type="text"/);assert.doesNotMatch(widget.shadowRoot.innerHTML,/<input[^>]+type="checkbox"/);
  form.dispatchEvent(new Event('submit',{cancelable:true}));assert.deepEqual(requests,[{path:'/addresses/resolve',body:{contextToken:'checkout-zone',areaId:'centro'}}]);
  department.value='canelones';department.dispatchEvent(new Event('change'));finish({address:{id:'old',formattedAddress:'Centro',provider:'zones'}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(widget.session.address,null);assert.equal(widget.session.selected,null);assert.doesNotMatch(widget.shadowRoot.innerHTML,/id="destination-area"/);assert.match(widget.shadowRoot.innerHTML,/Canelones/);
  widget.session.address={id:'zone-canelones',formattedAddress:'Canelones',provider:'zones'};widget.render();
  assert.match(widget.shadowRoot.innerHTML,/Revisá la zona antes de continuar/);assert.match(widget.shadowRoot.innerHTML,/Confirmar zona y ver días/);assert.doesNotMatch(widget.shadowRoot.innerHTML,/Revisá la dirección/);
  widget.disconnectedCallback();
});

// Address edits stay local; submitting the visibly explained action is the
// affirmative request. A removed checkbox must not leave an invisible gate.
test('search submits the entered destination without an authorization checkbox and never on input alone',async()=>{
  const widget=ready();widget.setContext('checkout-local');
  const form=new EventTarget(),input=new EventTarget(),requests=[];
  widget.shadowRoot={innerHTML:'',querySelector:selector=>selector==='form'?form:selector==='#destination'?input:null,querySelectorAll:()=>[]};
  widget.session.request=async(path,body)=>{requests.push({path,body});return {address:{id:'destination-1',formattedAddress:'Pocitos (demo)',provider:'demo'}};};
  widget.render();
  input.value='Pocitos';input.dispatchEvent(new Event('input'));
  assert.equal(requests.length,0,'typing a destination must not send it');
  form.dispatchEvent(new Event('submit',{cancelable:true}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests,[{path:'/addresses/resolve',body:{contextToken:'checkout-local',inputAddress:'Pocitos'}}]);
  assert.equal(widget.session.address.id,'destination-1');
  assert.doesNotMatch(widget.shadowRoot.innerHTML,/<input[^>]+type="checkbox"/);
  assert.match(widget.shadowRoot.innerHTML,/Al buscar[^<]+simulaci/);
  widget.config.mode='live';widget.render();
  assert.match(widget.shadowRoot.innerHTML,/Al buscar[^<]+Google Maps/);
  assert.equal(requests.length,1,'changing the presentation must not send an address');
  widget.disconnectedCallback();
});

// Catches the promised method missing and accepted/rejected/stale reservation events.
test('portable widget publishes quoted/selected/reserved lifecycle and reuses reservation key on retry',async()=>{
  const widget=ready();const events=[];
  for(const name of ['quoted','selected','quote-selected','reserved','error','invalidated'])widget.addEventListener(`shipping:${name}`,event=>events.push({name,detail:event.detail}));
  assert.equal(typeof widget.setCheckoutContext,'function');widget.setCheckoutContext('context-a');
  widget.session.address={id:'address-a',formattedAddress:'Destino simulado',provider:'demo'};
  const requests=[];let failed=true;
  widget.session.request=async(path,body,options)=>{
    requests.push({path,body,options});if(path==='/quotes')return {quotes};
    if(failed){failed=false;throw Error('Sin conexión');}
    return {reservation:{id:'hold-a',quoteId:'c',status:'held',priceMinor:15000,currency:'UYU',expiresAt:'2099-01-01T00:00:00Z'}};
  };
  await widget.loadQuotes();assert.deepEqual(events.find(event=>event.name==='quoted').detail,{quotes,address:widget.session.address});
  widget.selectQuote('c');assert.equal(events.find(event=>event.name==='selected').detail.quote.id,'c');assert.equal(events.find(event=>event.name==='quote-selected').detail.quote.id,'c');
  await assert.rejects(widget.reserve(),/Sin conexión/);assert.equal(events.filter(event=>event.name==='reserved').length,0);assert.equal(events.filter(event=>event.name==='error').length,1);
  const accepted=await widget.reserve();assert.equal(accepted.reservation.id,'hold-a');assert.equal(events.filter(event=>event.name==='reserved').length,1);
  assert.deepEqual(events.find(event=>event.name==='reserved').detail,{reservation:accepted.reservation,quote:quotes[2],address:widget.session.address});
  const attempts=requests.filter(request=>request.path==='/reservations');assert.deepEqual(attempts[0].body,{contextToken:'context-a',quoteId:'c'});
  assert.ok(attempts[0].options.headers['Idempotency-Key']);assert.equal(attempts[0].options.headers['Idempotency-Key'],attempts[1].options.headers['Idempotency-Key']);
  widget.setCheckoutContext('context-b');assert.equal(widget.session.selected,null);
  widget.session.quotes=quotes;widget.selectQuote('c');await widget.reserve();
  assert.notEqual(requests.at(-1).options.headers['Idempotency-Key'],attempts[0].options.headers['Idempotency-Key']);
  widget.disconnectedCallback();
});

test('stale reservation success after destination invalidation cannot publish reserved',async()=>{
  const widget=ready();widget.setContext('context');widget.session.quotes=quotes;widget.selectQuote('a');
  let finish;widget.session.request=()=>new Promise(resolve=>{finish=resolve;});let reserved=0;widget.addEventListener('shipping:reserved',()=>reserved++);
  const pending=widget.reserve();widget.session.invalidateAddress();finish({reservation:{id:'old',status:'held',currency:'UYU',priceMinor:20000,expiresAt:'2099-01-01T00:00:00Z'}});
  assert.equal(await pending,false);assert.equal(reserved,0);widget.disconnectedCallback();
});

// Catches attribution absent/misapplied and promotion confused with actual lowest price.
test('controlled live render attributes only Google address and marks every actual lowest-price tie in date order',()=>{
  const widget=ready();widget.setContext('context');widget.config.mode='live';widget.session.address={id:'live',formattedAddress:'Google <address>',provider:'google'};widget.session.quotes=quotes;
  widget.render();const html=widget.shadowRoot.innerHTML;
  assert.match(html,/<span class="google-attribution" translate="no">Google Maps<\/span>/);
  assert.match(html,/Google &lt;address&gt;/);assert.match(html,/class="address"[^]*google-attribution[^]*id="confirm"/);
  assert.equal((html.match(/Menor precio/g)||[]).length,2);
  assert.ok(html.indexOf('value="a"')<html.indexOf('value="b"')&&html.indexOf('value="b"')<html.indexOf('value="c"'));
  assert.doesNotMatch(html.slice(html.indexOf('value="b"'),html.indexOf('value="c"')),/Menor precio/);
  widget.config.mode='demo';widget.session.address={id:'demo',formattedAddress:'Destino simulado',provider:'demo'};widget.render();
  assert.doesNotMatch(widget.shadowRoot.innerHTML,/<span class="google-attribution"/);assert.match(widget.shadowRoot.innerHTML,/Direcciones y recorridos simulados/);
  widget.disconnectedCallback();
});
