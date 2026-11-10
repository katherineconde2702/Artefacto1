import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../public/store/cart.js';

test('saved garments survive filters and returning to the collection and can be removed',()=>{
  assert.equal(typeof store.createFavorites,'function');
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const favorites=store.createFavorites(storage);
  assert.equal(favorites.toggle('soft-knit-sweater'),true);
  assert.equal(favorites.toggle('ribbed-midi-dress'),true);
  const returning=store.createFavorites(storage);
  assert.equal(returning.has('soft-knit-sweater'),true);
  assert.deepEqual(returning.items(),['soft-knit-sweater','ribbed-midi-dress']);
  assert.equal(returning.toggle('soft-knit-sweater'),false);
  assert.deepEqual(store.createFavorites(storage).items(),['ribbed-midi-dress']);
});
test('saved garments handle unavailable storage and reject malformed identifiers',()=>{
  assert.equal(typeof store.createFavorites,'function');
  const favorites=store.createFavorites({getItem(){throw Error('unavailable');},setItem(){throw Error('unavailable');}});
  assert.equal(favorites.toggle('soft-knit-sweater'),true);
  assert.equal(favorites.has('soft-knit-sweater'),true);
  assert.throws(()=>favorites.toggle('<script>'));
  assert.deepEqual(store.createFavorites({getItem:()=>'{invalid json'}).items(),[]);
});
