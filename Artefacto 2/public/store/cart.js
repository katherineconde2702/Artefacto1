const STORAGE_KEY = 'marea.cart.v1';
const validQuantity = (value, minimum = 1) => Number.isInteger(value) && value >= minimum && value <= 99;
const validIdentity = (productId, size) => typeof productId === 'string' && /^[a-z0-9-]{1,100}$/.test(productId) && ['S', 'M', 'L', 'XL'].includes(size);

export function createCart(storage) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  let lines = [];
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(parsed)) for (const item of parsed) {
      if (!validIdentity(item?.productId, item?.size) || !validQuantity(item.quantity)) continue;
      const key = `${item.productId}:${item.size}`;
      if (!lines.some((line) => line.key === key)) lines.push({key, productId:item.productId, size:item.size, quantity:item.quantity});
    }
  } catch {}
  const persist = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(lines)); } catch {} };
  return {
    items: () => lines.map((item) => ({...item})),
    add(productId, size, quantity = 1) {
      if (!validIdentity(productId, size) || !validQuantity(quantity)) throw new Error('Elegí un talle y una cantidad entre 1 y 99.');
      const key = `${productId}:${size}`; const item = lines.find((line) => line.key === key);
      if (item && !validQuantity(item.quantity + quantity)) throw new Error('Máximo 99 unidades por talle.');
      if (item) item.quantity += quantity; else lines.push({key, productId, size, quantity});
      persist();
    },
    update(key, quantity) {
      if (!validQuantity(quantity, 0)) throw new Error('La cantidad debe ser un entero entre 0 y 99.');
      if (!quantity) lines = lines.filter((item) => item.key !== key);
      else { const item = lines.find((line) => line.key === key); if (item) item.quantity = quantity; }
      persist();
    },
    clear() { lines = []; persist(); }
  };
}

export function mountBagCount(cart = createCart()) {
  const count = cart.items().reduce((sum, item) => sum + item.quantity, 0);
  globalThis.document?.querySelectorAll('.bag-count').forEach((element) => { element.textContent = String(count); });
  return cart;
}
