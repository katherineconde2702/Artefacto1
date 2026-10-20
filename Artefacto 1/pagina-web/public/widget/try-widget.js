const asset = (name) => new URL(`../assets/${name}`, import.meta.url).href;
const publicAsset = (value, fallback) => {
  const url = String(value || '');
  if (url.startsWith('/assets/')) {
    const base = globalThis.TRY_CONFIG?.assetBase || new URL('../', import.meta.url).href;
    return new URL(url.slice(1), base).href;
  }
  return url || asset(fallback);
};

const template = document.createElement('template');
template.innerHTML = `
  <style>
    :host { --try-ink:#292622; --try-muted:#716a62; --try-paper:#fbf8f3; --try-olive:#5f6956; --try-sand:#ead7c2; display:block; color:var(--try-ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    * { box-sizing:border-box; } [hidden] { display:none !important; } button,input { font:inherit; } button { cursor:pointer; } button:focus-visible,input:focus-visible { outline:3px solid rgba(95,105,86,.35); outline-offset:2px; }
    .shell { border:1px solid rgba(95,105,86,.44); background:linear-gradient(135deg,#eff1eb,#fbf9f5 70%); box-shadow:0 12px 28px rgba(62,54,44,.08); }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:15px; border-bottom:1px solid rgba(95,105,86,.2); }
    .brand { display:flex; align-items:center; gap:10px; }.mark { width:32px; height:32px; display:grid; place-items:center; border-radius:50%; color:white; background:var(--try-olive); font-family:Georgia,serif; font-size:18px; }.brand strong,.brand small { display:block; }.brand strong { font-family:Georgia,serif; font-size:20px; font-weight:600; }.brand small,.integrated { color:var(--try-muted); font-size:9px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }.integrated:before { display:inline-block; width:7px; height:7px; margin-right:6px; border-radius:50%; background:var(--try-olive); content:""; }
    main { padding:15px; }.intro { margin:0; color:#5f574f; font-size:12px; line-height:1.45; }.fit { margin-top:5px; color:var(--try-olive); font-size:10px; font-weight:800; text-transform:uppercase; }
    .fields { display:grid; grid-template-columns:1fr 1fr; gap:9px; margin-top:13px; }.field { display:grid; gap:5px; color:var(--try-muted); font-size:9px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }.field input { width:100%; min-height:48px; padding:8px 10px; border:1px solid rgba(41,38,34,.18); color:var(--try-ink); background:rgba(255,255,255,.75); font-family:Georgia,serif; font-size:20px; }
    .recommendation { display:grid; grid-template-columns:1fr auto; gap:12px; align-items:center; margin-top:12px; padding:12px; border:1px solid rgba(183,131,93,.34); background:#fbf2e8; }.recommendation span,.recommendation strong,.recommendation small { display:block; }.recommendation span { color:#936a4c; font-size:8px; font-weight:850; letter-spacing:.12em; text-transform:uppercase; }.recommendation strong { margin-top:3px; font-family:Georgia,serif; font-size:18px; font-weight:600; }.recommendation small { margin-top:3px; color:var(--try-muted); font-size:9px; line-height:1.35; }.size-badge { width:47px; height:47px; display:grid; place-items:center; border-radius:50%; background:var(--try-sand); font-family:Georgia,serif; font-size:22px; }
    .sizes { display:grid; grid-template-columns:repeat(auto-fit,minmax(54px,1fr)); gap:7px; margin-top:11px; }.size { min-height:45px; border:1px solid rgba(41,38,34,.16); color:var(--try-muted); background:rgba(255,255,255,.5); font-family:Georgia,serif; font-size:16px; }.size[aria-pressed="true"] { color:white; border-color:var(--try-ink); background:var(--try-ink); }.size[data-recommended="true"]:after { display:block; color:var(--try-olive); content:"Recomendado"; font-family:Inter,sans-serif; font-size:6px; font-weight:800; text-transform:uppercase; }.size[aria-pressed="true"]:after { color:#dce3d6; }
    .consent { display:flex; gap:8px; align-items:flex-start; margin-top:12px; color:var(--try-muted); font-size:9px; line-height:1.4; }.consent input { width:15px; height:15px; margin:0; accent-color:var(--try-olive); }
    .actions { display:grid; grid-template-columns:1fr auto; gap:8px; margin-top:12px; }.primary,.upload { min-height:44px; display:grid; place-items:center; padding:0 13px; border:1px solid var(--try-olive); font-size:10px; font-weight:850; }.primary { color:white; background:var(--try-olive); }.primary:disabled { cursor:wait; opacity:.65; }.upload { position:relative; color:var(--try-ink); border-color:rgba(41,38,34,.18); background:transparent; }.upload input { position:absolute; width:1px; height:1px; opacity:0; }
    .status { min-height:18px; margin:9px 0 0; color:var(--try-muted); font-size:9px; line-height:1.4; }.status.error { color:#9a352e; }
    .preview { display:grid; grid-template-columns:1fr 1fr; gap:9px; margin-top:8px; }.photo { position:relative; height:250px; overflow:hidden; border:1px solid rgba(41,38,34,.15); background:#eee3d6; }.photo button { width:100%; height:100%; padding:0; border:0; background:transparent; }.photo img { width:100%; height:100%; display:block; object-fit:cover; object-position:50% 34%; }.label { position:absolute; top:8px; left:8px; z-index:1; padding:5px 7px; color:#5e554d; background:rgba(253,251,248,.92); font-size:7px; font-weight:850; letter-spacing:.08em; text-transform:uppercase; pointer-events:none; }.photo:last-child .label { right:8px; left:auto; color:white; background:rgba(41,38,34,.86); }
    dialog { width:min(720px,calc(100% - 28px)); max-height:90vh; padding:0; border:0; background:var(--try-paper); box-shadow:0 25px 70px rgba(0,0,0,.35); } dialog::backdrop { background:rgba(28,25,22,.72); }.dialog-close { position:absolute; top:10px; right:10px; z-index:2; width:34px; height:34px; border:1px solid rgba(41,38,34,.2); border-radius:50%; background:rgba(255,255,255,.92); font-size:21px; }.dialog-image { width:100%; max-height:82vh; display:block; object-fit:contain; background:#eee3d6; }
    @media (max-width:520px) { .preview { grid-template-columns:1fr; }.photo { height:320px; }.actions { grid-template-columns:1fr; }.integrated { display:none; } }
  </style>
  <section class="shell" aria-labelledby="try-widget-title">
    <header><div class="brand"><span class="mark">T</span><span><strong id="try-widget-title">TRY</strong><small>Guía de talle + prueba virtual</small></span></div><span class="integrated">Tu probador</span></header>
    <main>
      <p class="intro">Cargando información del producto…</p><div class="fit"></div>
      <div class="fields"><label class="field clothing">Altura (cm)<input id="height" type="number" min="135" max="220" value="168"></label><label class="field clothing">Peso (kg)<input id="weight" type="number" min="35" max="180" value="59"></label><label class="field footwear" hidden>Largo de pie (cm)<input id="foot" type="number" min="20" max="30" step="0.1" value="24"></label></div>
      <div class="recommendation"><div><span>TRY recomienda</span><strong class="rec-title">Calculando…</strong><small class="rec-copy"></small></div><b class="size-badge">—</b></div>
      <div class="sizes" role="group" aria-label="Comparar talles"></div>
      <label class="consent"><input id="consent" type="checkbox"><span>Autorizo el procesamiento temporal de mi foto para crear esta prueba virtual.</span></label>
      <div class="actions"><button class="primary" type="button">Cargá una foto</button><label class="upload">Elegir foto<input id="photo" type="file" accept="image/png,image/jpeg,image/webp"></label></div>
      <p class="status" aria-live="polite"></p>
      <div class="preview"><div class="photo"><span class="label">Tu foto</span><button type="button" data-image="base" aria-label="Ampliar tu foto"><img class="base-image" alt="Foto cargada para la prueba virtual"></button></div><div class="photo"><span class="label result-label">Vista estimada</span><button type="button" data-image="result" aria-label="Ampliar resultado"><img class="result-image" alt="Resultado de la prueba virtual"></button></div></div>
    </main>
  </section>
  <dialog><button class="dialog-close" type="button" aria-label="Cerrar">×</button><img class="dialog-image" alt="Vista ampliada"></dialog>
`;

class TryWidget extends HTMLElement {
  static observedAttributes = ['product-id', 'api-base'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).append(template.content.cloneNode(true));
    this.state = { product:null, provider:null, selected:null, recommended:null, metricsKey:null, photo:null, photoUrl:null, results:new Map(), controller:null };
  }

  connectedCallback() {
    this.bind();
    this.loadProduct();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (this.isConnected && oldValue !== newValue) this.loadProduct();
  }

  get apiBase() {
    return (
      this.getAttribute('api-base') ||
      globalThis.TRY_CONFIG?.apiBase ||
      'http://127.0.0.1:8787'
    ).replace(/\/$/, '');
  }
  get productId() { return this.getAttribute('product-id') || 'soft-knit-sweater'; }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles:true, composed:true }));
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.shadowRoot.querySelectorAll('#height,#weight,#foot').forEach((input) => input.addEventListener('input', () => this.recommend()));
    this.shadowRoot.querySelector('#photo').addEventListener('change', (event) => this.loadPhoto(event.target.files?.[0]));
    this.shadowRoot.querySelector('.primary').addEventListener('click', () => this.generate());
    this.shadowRoot.querySelectorAll('[data-image]').forEach((button) => button.addEventListener('click', () => this.openImage(button.dataset.image)));
    this.shadowRoot.querySelector('.dialog-close').addEventListener('click', () => this.shadowRoot.querySelector('dialog').close());
  }

  disconnectedCallback() {
    this.state.controller?.abort();
    if (this.state.photoUrl) URL.revokeObjectURL(this.state.photoUrl);
  }

  async loadProduct() {
    try {
      this.state.controller?.abort();
      this.state.results.clear();
      this.state.metricsKey = null;
      const response = await fetch(`${this.apiBase}/api/v1/products/${encodeURIComponent(this.productId)}`);
      const product = await response.json();
      if (!response.ok) throw new Error(product.error || 'Producto no encontrado.');
      this.state.product = product;
      this.state.selected = product.defaultSize;
      this.shadowRoot.querySelector('.intro').textContent = `${product.name}: recomendación para ${product.audience === 'adult-women' ? 'mujeres adultas' : 'el público configurado'}.`;
      this.shadowRoot.querySelector('.fit').textContent = `Fit objetivo: ${product.targetFit}`;
      const shoes = product.articleType === 'shoes';
      this.shadowRoot.querySelectorAll('.clothing').forEach((node) => node.hidden = shoes);
      this.shadowRoot.querySelector('.footwear').hidden = !shoes;
      this.renderSizes();
      this.renderImages();
      await this.recommend();
      await this.loadProviderStatus();
    } catch (error) {
      this.setStatus(error.message, true);
    }
  }

  async loadProviderStatus() {
    try {
      const response = await fetch(`${this.apiBase}/api/health`);
      const payload = await response.json();
      if (!response.ok) return;
      this.state.provider = { configured: Boolean(payload.capabilities?.tryOn?.available) };
      this.shadowRoot.querySelector('.consent span').textContent = 'Autorizo el procesamiento temporal de mi foto para crear esta prueba virtual.';
      if (!this.state.provider.configured) {
        this.setStatus('La prueba virtual no está disponible en este momento. Podés continuar con la recomendación de talle.', true);
      }
    } catch {
      // El endpoint de salud es informativo; el resto del widget puede seguir funcionando.
    }
  }

  async recommend() {
    if (!this.state.product) return;
    try {
      const body = {
        productId: this.productId,
        heightCm: this.shadowRoot.querySelector('#height').value,
        weightKg: this.shadowRoot.querySelector('#weight').value,
        footCm: this.shadowRoot.querySelector('#foot').value
      };
      const metricsKey = JSON.stringify(body);
      const response = await fetch(`${this.apiBase}/api/v1/recommendation`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'No se pudo recomendar un talle.');
      if (this.state.metricsKey && this.state.metricsKey !== metricsKey) {
        this.state.controller?.abort();
        this.state.results.clear();
      }
      this.state.metricsKey = metricsKey;
      this.state.recommended = payload.recommendation.size;
      // A measurement change starts from the recommended size; the shopper can
      // immediately override it with any alternative size below.
      this.state.selected = payload.recommendation.size;
      this.shadowRoot.querySelector('.rec-title').textContent = `Talle ${payload.recommendation.size}`;
      this.shadowRoot.querySelector('.rec-copy').textContent = payload.recommendation.explanation;
      this.shadowRoot.querySelector('.size-badge').textContent = payload.recommendation.size;
      this.renderSizes();
      this.renderImages();
      this.emit('try:recommendation', payload);
    } catch (error) {
      this.setStatus(error.message, true);
    }
  }

  renderSizes() {
    if (!this.state.product) return;
    const container = this.shadowRoot.querySelector('.sizes');
    container.innerHTML = this.state.product.sizes.map((size) => `<button class="size" type="button" data-size="${size}" data-recommended="${size === this.state.recommended}" aria-pressed="${size === this.state.selected}">${size}</button>`).join('');
    container.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => this.setSize(button.dataset.size)));
    const primary = this.shadowRoot.querySelector('.primary');
    primary.textContent = this.state.photo ? `Probar talle ${this.state.selected} con IA` : 'Cargá una foto';
  }

  setSize(size) {
    if (!this.state.product?.sizes.includes(size)) return;
    this.state.selected = size;
    this.renderSizes();
    this.renderImages();
    this.emit('try:size-change', { productId:this.productId, size });
  }

  loadPhoto(file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return this.setStatus('Elegí una foto PNG, JPEG o WebP.', true);
    if (file.size > 10 * 1024 * 1024) return this.setStatus('La foto supera el máximo de 10 MB.', true);
    if (this.state.photoUrl) URL.revokeObjectURL(this.state.photoUrl);
    this.state.controller?.abort();
    this.state.results.clear();
    this.state.photo = file;
    this.state.photoUrl = URL.createObjectURL(file);
    this.renderSizes();
    this.renderImages();
    this.setStatus(this.state.provider && !this.state.provider.configured
      ? 'Foto cargada. La prueba virtual no está disponible en este momento.'
      : 'Foto cargada. Aceptá el consentimiento y generá la prueba virtual.',
    Boolean(this.state.provider && !this.state.provider.configured));
    this.emit('try:photo-loaded', { productId:this.productId, type:file.type, size:file.size });
  }

  renderImages() {
    const base = this.shadowRoot.querySelector('.base-image');
    const result = this.shadowRoot.querySelector('.result-image');
    base.src = this.state.photoUrl || asset('model-base-white.png');
    const generated = this.state.results.get(this.state.selected);
    result.src = generated?.imageUrl || publicAsset(this.state.product?.editorialImage || this.state.product?.productImage, 'editorial-fit-model.png');
    this.shadowRoot.querySelector('.result-label').textContent = generated ? `Talle ${this.state.selected} · prueba virtual` : `Talle ${this.state.selected} · vista estimada`;
  }

  async generate() {
    if (!this.state.photo) return this.shadowRoot.querySelector('#photo').click();
    if (this.state.provider && !this.state.provider.configured) {
      const message = 'La prueba virtual no está disponible en este momento. Podés continuar con la recomendación de talle.';
      this.setStatus(message, true);
      this.emit('try:tryon-error', { productId:this.productId, size:this.state.selected, error:message });
      return;
    }
    if (!this.shadowRoot.querySelector('#consent').checked) return this.setStatus('Aceptá el consentimiento antes de enviar la foto.', true);
    this.state.controller?.abort();
    this.state.controller = new AbortController();
    const button = this.shadowRoot.querySelector('.primary');
    const selectedAtStart = this.state.selected;
    button.disabled = true;
    button.textContent = `Generando talle ${selectedAtStart}…`;
    this.setStatus('Estamos generando tu prueba virtual. Puede demorar unos segundos.');
    this.emit('try:tryon-start', { productId:this.productId, size:selectedAtStart });
    try {
      const form = new FormData();
      form.append('person', this.state.photo, this.state.photo.name);
      form.append('productId', this.productId);
      form.append('size', selectedAtStart);
      form.append('heightCm', this.shadowRoot.querySelector('#height').value);
      form.append('weightKg', this.shadowRoot.querySelector('#weight').value);
      form.append('recommendedSize', this.state.recommended || '');
      form.append('consent', 'true');
      form.append('consentVersion', '2026-10-13');
      const response = await fetch(`${this.apiBase}/api/v1/try-on`, { method:'POST', body:form, signal:this.state.controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'No se pudo generar la prueba virtual.');
      this.state.results.set(selectedAtStart, payload);
      this.renderImages();
      this.setStatus('Tu prueba virtual está lista.');
      this.emit('try:tryon-complete', payload);
    } catch (error) {
      if (error.name !== 'AbortError') {
        this.setStatus(`${error.message} Podés seguir comparando talles con la vista estimada.`, true);
        this.emit('try:tryon-error', { productId:this.productId, size:selectedAtStart, error:error.message });
      }
    } finally {
      button.disabled = false;
      this.renderSizes();
    }
  }

  openImage(which) {
    const source = this.shadowRoot.querySelector(which === 'base' ? '.base-image' : '.result-image');
    const dialog = this.shadowRoot.querySelector('dialog');
    const image = this.shadowRoot.querySelector('.dialog-image');
    image.src = source.src;
    image.alt = source.alt;
    dialog.showModal();
  }

  setStatus(message, error = false) {
    const status = this.shadowRoot.querySelector('.status');
    status.textContent = message;
    status.classList.toggle('error', error);
  }
}

if (!customElements.get('try-widget')) customElements.define('try-widget', TryWidget);
