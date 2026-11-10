import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../public/widget/try-widget.js', import.meta.url), 'utf8');

export const product = {
  id: 'soft-knit-sweater', name: 'Sweater de prueba', audience: 'adult-women',
  articleType: 'clothing', targetFit: 'regular', defaultSize: 'M', sizes: ['S', 'M', 'L'],
  editorialImage: 'https://try.test/catalog-model.jpg', productImage: 'https://try.test/catalog-garment.jpg'
};

export const recommendation = (size = 'M', productId = product.id) => ({
  productId, articleType: 'clothing', targetFit: 'regular',
  recommendation: {
    size, confidence: 'estimated', fit: 'regular',
    metrics: { heightCm: 168, weightKg: 59, bmi: 20.9 }, explanation: 'Referencia de talle.'
  }
});

export const result = (size = 'M', productId = product.id) => ({
  requestId: `request-${size}`, productId, size, targetFit: 'regular',
  imageUrl: `data:image/png;base64,${Buffer.from(`generated-${size}`).toString('base64')}`
});

export const flush = () => new Promise((resolve) => setImmediate(resolve));

// This test-only DOM supports the widget's existing selectors, events and
// attributes. It does not verify browser layout, image loading or modal focus.
class Element extends EventTarget {
  constructor(tagName = '') {
    super();
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.value = '';
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.isConnected = false;
    this.classList = {
      contains: (name) => (this.getAttribute('class') || '').split(/\s+/).includes(name),
      toggle: (name, enabled) => {
        const names = new Set((this.getAttribute('class') || '').split(/\s+/).filter(Boolean));
        if (enabled) names.add(name); else names.delete(name);
        this.setAttribute('class', [...names].join(' '));
      }
    };
    if (tagName === 'template') this.content = this;
  }

  setAttribute(name, value) {
    const previous = this.getAttribute(name);
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    if (name === 'value') this.value = String(value);
    if (this.constructor.observedAttributes?.includes(name)) this.attributeChangedCallback?.(name, previous, String(value));
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }
  get alt() { return this.getAttribute('alt') || ''; }
  set alt(value) { this.setAttribute('alt', value); }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  set innerHTML(html) {
    this.children = [];
    this.text = '';
    const stack = [this];
    for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tagName = token.match(/^<([\w-]+)/)?.[1];
        if (!tagName) continue;
        const child = new Element(tagName);
        for (const match of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
          if (match.index > 1) child.setAttribute(match[1], match[2] ?? '');
        }
        stack.at(-1).append(child);
        if (!['img', 'input', 'br', 'hr', 'meta', 'link'].includes(tagName)) stack.push(child);
      } else {
        stack.at(-1).text = (stack.at(-1).text || '') + token;
      }
    }
  }
  append(child) {
    this.children.push(child);
    child.parent = this;
    if (this.isConnected) {
      child.isConnected = true;
      child.connectedCallback?.();
    }
  }
  attachShadow() { this.shadowRoot = new Element('shadow-root'); return this.shadowRoot; }
  cloneNode() {
    const clone = new Element(this.tagName);
    for (const [name, value] of this.attributes) clone.setAttribute(name, value);
    clone.text = this.text;
    for (const child of this.children) clone.append(child.cloneNode());
    return clone;
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1);
    if (selector.startsWith('[')) {
      const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      return value === undefined ? this.getAttribute(name) !== null : this.getAttribute(name) === value;
    }
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    const matches = [];
    for (const child of this.children) {
      if (parts.length > 1 && child.matches(parts[0])) matches.push(...child.querySelectorAll(parts.slice(1).join(' ')));
      if (parts.length === 1 && selector.split(',').some((part) => child.matches(part))) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

export function createHarness(t) {
  const registry = new Map();
  const body = new Element('body');
  body.isConnected = true;
  const document = {
    body,
    createElement(tagName) {
      const Constructor = registry.get(tagName);
      return Constructor ? new Constructor() : new Element(tagName);
    }
  };
  const window = { document, Event, CustomEvent, File, FormData, AbortController, HTMLElement: Element };
  window.customElements = { get: (name) => registry.get(name), define: (name, Constructor) => registry.set(name, Constructor) };
  const requests = [];
  // Deliberately leave cancellation to the widget: a late server response must
  // remain harmless even if it has already passed the abort boundary.
  window.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    requests.push({
      url: String(url), options, answered: false,
      respond(payload, status = 200) {
        this.answered = true;
        resolve({ ok: status >= 200 && status < 300, json: async () => payload });
      },
      reject(error) { this.answered = true; reject(error); }
    });
  });
  let photoNumber = 0;
  window.URL = class extends URL {
    static createObjectURL() { return `blob:photo-${++photoNumber}`; }
    static revokeObjectURL() {}
  };
  const context = vm.createContext(window);
  vm.runInContext(source.replaceAll('import.meta.url', '"https://try.test/widget/try-widget.js"'), context);
  const widget = window.document.createElement('try-widget');
  t.after(() => widget.disconnectedCallback());
  const query = (selector) => widget.shadowRoot.querySelector(selector);
  const request = (path) => requests.find((entry) => entry.url.endsWith(path) && !entry.answered);
  const photo = (name = 'original.png', contents = 'original-photo') => new window.File([contents], name, { type: 'image/png' });
  const edit = (selector, value) => {
    query(selector).value = value;
    query(selector).dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return { window, widget, query, requests, request, photo, edit };
}

export async function mountWidget(t) {
  const harness = createHarness(t);
  const { window, widget, request } = harness;
  window.document.body.append(widget);
  request(`/api/v1/products/${product.id}`).respond(product);
  await flush();
  request('/api/v1/recommendation').respond(recommendation());
  await flush();
  request('/api/health').respond({ status: 'ok', capabilities: { tryOn: { available: true } } });
  await flush();
  return harness;
}

export function upload(harness, file = harness.photo()) {
  const input = harness.query('#photo');
  input.files = [file];
  input.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  return file;
}

export async function generate(harness, size = 'M') {
  harness.widget.setSize(size);
  const pending = harness.widget.generate();
  harness.request('/api/v1/try-on').respond(result(size));
  await pending;
}

export function readPhoto(harness, file) {
  return file.text();
}
