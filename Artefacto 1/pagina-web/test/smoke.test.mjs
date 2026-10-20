import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const required = [
  'public/index.html',
  'public/product/index.html',
  'public/demo/index.html',
  'public/widget/try-widget.js',
  'public/config.js',
  'public/assets/sweater-m.png'
];

for (const file of required) {
  assert.equal((await stat(new URL(`../${file}`, import.meta.url))).isFile(), true, `${file} debe existir`);
}

const config = await readFile(new URL('../public/config.js', import.meta.url), 'utf8');
const widget = await readFile(new URL('../public/widget/try-widget.js', import.meta.url), 'utf8');
const catalog = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const product = await readFile(new URL('../public/product/index.html', import.meta.url), 'utf8');
const demo = await readFile(new URL('../public/demo/index.html', import.meta.url), 'utf8');

assert.match(config, /http:\/\/127\.0\.0\.1:8787/);
assert.match(widget, /TRY_CONFIG/);
assert.match(catalog, /TRY_CONFIG/);
assert.match(product, /TRY_CONFIG/);
assert.match(demo, /TRY_CONFIG/);
assert.doesNotMatch(`${config}\n${widget}\n${catalog}\n${product}\n${demo}`, /sk-[A-Za-z0-9_-]{20,}/);

console.log('Smoke checks OK');
