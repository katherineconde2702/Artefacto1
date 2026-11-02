import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../public/store/cart.js').catch(() => ({}));
const memory = () => { const values = new Map(); return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }; };

test('cart preserves product, size and quantity across page instances, without trusting prices', () => {
  assert.equal(typeof module.createCart, 'function', 'cart implementation is available');
  const storage = memory(); const cart = module.createCart(storage);
  cart.add('soft-knit-sweater', 'L', 2); cart.add('soft-knit-sweater', 'L', 1);
  cart.add('soft-knit-sweater', 'M', 1);
  assert.deepEqual(module.createCart(storage).items(), [
    { key: 'soft-knit-sweater:L', productId: 'soft-knit-sweater', size: 'L', quantity: 3 },
    { key: 'soft-knit-sweater:M', productId: 'soft-knit-sweater', size: 'M', quantity: 1 }
  ]);
  cart.update('soft-knit-sweater:L', 0);
  assert.equal(cart.items().length, 1); cart.clear(); assert.deepEqual(cart.items(), []);
});
test('cart rejects fractional, negative, excessive and invalid size quantities', () => {
  assert.equal(typeof module.createCart, 'function'); const cart = module.createCart(memory());
  for (const quantity of [0, -1, 1.5, 100, NaN]) assert.throws(() => cart.add('p', 'M', quantity));
  assert.throws(() => cart.add('p', '', 1));
  cart.add('p', 'M', 1); assert.throws(() => cart.update('p:M', -1));
  assert.equal(cart.items()[0].quantity, 1);
});
test('cart survives corrupt or unavailable storage and discards invalid persisted lines', () => {
  assert.equal(typeof module.createCart, 'function');
  assert.deepEqual(module.createCart({getItem: () => '{oops'}).items(), []);
  const unavailable = module.createCart({getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}});
  unavailable.add('p', 'S', 1); assert.equal(unavailable.items()[0].quantity, 1);
  const cart = module.createCart({getItem: () => JSON.stringify([{productId:'p',size:'S',quantity:2,price:1},{productId:'p',size:'L',quantity:-1}])});
  assert.deepEqual(cart.items(), [{key:'p:S',productId:'p',size:'S',quantity:2}]);
});
