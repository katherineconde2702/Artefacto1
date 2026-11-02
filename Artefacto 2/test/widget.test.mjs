import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHarness, flush, generate, mountWidget, product, readPhoto,
  recommendation, result, upload
} from './helpers/widget.mjs';

test('el botón genera sin casilla y registra el consentimiento de esa acción', async (t) => {
  const h = await mountWidget(t);
  upload(h, h.photo('shopper.png', 'original-for-generation'));
  h.query('.primary').click();
  const request = h.request('/api/v1/try-on');
  assert.ok(request, 'El botón debe generar con la foto elegida sin marcar una casilla');
  assert.equal(h.query('[type="checkbox"]'), null);
  const description = h.query(`#${h.query('.primary').getAttribute('aria-describedby')}`);
  assert.ok(description, 'La acción debe tener una explicación visible del envío de la foto');
  assert.equal(Boolean(description.hidden || description.getAttribute('hidden') !== null), false);
  assert.match(description.textContent, /foto.*proveedor.*IA/i);
  assert.equal(request.options.body.get('consent'), 'true');
  assert.equal(request.options.body.get('consentVersion'), '2026-11-01-generate-action');
  assert.equal(await readPhoto(h, request.options.body.get('person')), 'original-for-generation');
  request.respond(result());
  await flush();
  assert.equal(h.query('.result-image').src, result().imageUrl);
});

test('elegir una foto solo actualiza la vista previa y no envía ninguna solicitud', async (t) => {
  const h = await mountWidget(t);
  const requestsBefore = h.requests.length;
  upload(h);
  await flush();
  assert.equal(h.requests.length, requestsBefore);
  assert.equal(h.query('.base-image').src, 'blob:photo-1');
  assert.equal(h.query('.result-image').getAttribute('src'), null);
});

test('el botón sin foto abre la selección y no inicia una prueba', async (t) => {
  const h = await mountWidget(t);
  let pickerOpened = 0;
  h.query('#photo').addEventListener('click', () => { pickerOpened++; });
  const requestsBefore = h.requests.length;
  h.query('.primary').click();
  await flush();
  assert.equal(pickerOpened, 1);
  assert.equal(h.requests.length, requestsBefore);
  assert.equal(h.query('.result-image').getAttribute('src'), null);
});

for (const [name, contents, type] of [
  ['un formato no admitido', 'not-an-image', 'text/plain'],
  ['una foto de más de 10 MB', new Uint8Array(10 * 1024 * 1024 + 1), 'image/png']
]) {
  test(`se rechaza ${name} antes de enviar una prueba`, async (t) => {
    const h = await mountWidget(t);
    const requestsBefore = h.requests.length;
    upload(h, new h.window.File([contents], 'invalid-photo', { type }));
    assert.equal(h.query('.status').classList.contains('error'), true);
    assert.equal(h.query('.base-image').getAttribute('src'), null);
    h.query('.primary').click();
    await flush();
    assert.equal(h.requests.length, requestsBefore);
    assert.equal(h.query('.result-image').getAttribute('src'), null);
  });
}

test('las medidas inválidas siguen sujetas al rechazo del servidor al generar', async (t) => {
  const h = await mountWidget(t);
  h.edit('#height', '0');
  h.request('/api/v1/recommendation').respond({ error: 'La altura debe estar entre 135 y 220 cm.' }, 400);
  await flush();
  upload(h);
  let completions = 0;
  h.widget.addEventListener('try:tryon-complete', () => { completions++; });
  h.query('.primary').click();
  const request = h.request('/api/v1/try-on');
  assert.ok(request, 'Las medidas se deben enviar al servidor para su validación');
  assert.equal(request.options.body.get('heightCm'), '0');
  request.respond({ error: 'La altura debe estar entre 135 y 220 cm.' }, 400);
  await flush();
  assert.equal(completions, 0);
  assert.equal(h.query('.status').classList.contains('error'), true);
  assert.match(h.query('.status').textContent, /altura.*135.*220/i);
  assert.equal(h.query('.result-image').getAttribute('src'), null);
  assert.equal(h.query('.primary').disabled, false);
});

test('un talle sin generar muestra un estado vacío que no permite ampliar el catálogo', async (t) => {
  const h = await mountWidget(t);
  assert.equal(h.query('.result-image').getAttribute('src'), null);
  assert.equal(h.query('[data-image="result"]').disabled, true);
  assert.match(h.query('.result-label').textContent, /M.*sin generar/i);
  h.widget.openImage('result');
  assert.equal(h.query('dialog').open, false);
});

test('la foto de ejemplo no se puede ampliar como si fuera una foto cargada', async (t) => {
  const h = await mountWidget(t);
  h.widget.openImage('base');
  assert.equal(h.query('[data-image="base"]').disabled, true);
  assert.equal(h.query('dialog').open, false);
});

test('elegir otro talle no inicia una generación y vuelve al estado sin generar', async (t) => {
  const h = await mountWidget(t);
  upload(h);
  await generate(h, 'M');
  h.query('[data-size="L"]').click();
  assert.equal(h.requests.filter((entry) => entry.url.endsWith('/api/v1/try-on')).length, 1);
  assert.equal(h.query('.result-image').getAttribute('src'), null);
  assert.match(h.query('.result-label').textContent, /L.*sin generar/i);
});

test('cada talle conserva su resultado y todas las pruebas envían la foto original', async (t) => {
  const h = await mountWidget(t);
  upload(h, h.photo('shopper.png', 'unchanged-original'));
  await generate(h, 'S');
  await generate(h, 'L');
  const forms = h.requests.filter((entry) => entry.url.endsWith('/api/v1/try-on')).map((entry) => entry.options.body);
  assert.deepEqual(forms.map((form) => form.get('size')), ['S', 'L']);
  assert.deepEqual(forms.map((form) => form.get('productId')), ['soft-knit-sweater', 'soft-knit-sweater']);
  for (const form of forms) {
    assert.equal(form.get('person').name, 'shopper.png');
    assert.equal(await readPhoto(h, form.get('person')), 'unchanged-original');
  }
  h.widget.setSize('S');
  assert.equal(h.query('.result-image').src, result('S').imageUrl);
  h.widget.setSize('L');
  assert.equal(h.query('.result-image').src, result('L').imageUrl);
});

test('una recomendación pendiente respeta el talle que la persona eligió mientras esperaba', async (t) => {
  const h = await mountWidget(t);
  let detail;
  h.widget.addEventListener('try:recommendation', (event) => { detail = event.detail; });
  h.edit('#height', '170');
  const pending = h.request('/api/v1/recommendation');
  h.query('[data-size="L"]').click();
  pending.respond(recommendation('M'));
  await flush();
  assert.equal(h.query('[data-size="L"]').getAttribute('aria-pressed'), 'true');
  assert.equal(detail.selectedSize, 'L');
  assert.equal(detail.recommendation.size, 'M');
});

test('una recomendación vieja no reemplaza la respuesta de las medidas más recientes', async (t) => {
  const h = await mountWidget(t);
  h.edit('#height', '170');
  const older = h.request('/api/v1/recommendation');
  h.edit('#weight', '70');
  const newer = h.requests.filter((entry) => entry.url.endsWith('/api/v1/recommendation')).at(-1);
  newer.respond(recommendation('L'));
  await flush();
  older.respond(recommendation('S'));
  await flush();
  assert.match(h.query('.rec-title').textContent, /L/);
  assert.equal(h.query('[data-size="L"]').getAttribute('aria-pressed'), 'true');
});

test('editar las medidas retira inmediatamente una prueba que usaba los valores anteriores', async (t) => {
  const h = await mountWidget(t);
  upload(h);
  await generate(h);
  h.edit('#weight', '65');
  assert.equal(h.query('.result-image').getAttribute('src'), null);
  assert.equal(h.query('[data-image="result"]').disabled, true);
});

test('una carga de producto anterior no reemplaza el producto que se eligió después', async (t) => {
  const h = createHarness(t);
  h.window.document.body.append(h.widget);
  const older = h.request('/api/v1/products/soft-knit-sweater');
  h.widget.setAttribute('product-id', 'new-product');
  h.request('/api/v1/products/new-product').respond({ ...product, id: 'new-product', name: 'Producto nuevo' });
  await flush();
  h.request('/api/v1/recommendation').respond(recommendation('L', 'new-product'));
  await flush();
  h.request('/api/health').respond({ status: 'ok', capabilities: { tryOn: { available: true } } });
  await flush();
  older.respond(product);
  await flush();
  assert.match(h.query('.intro').textContent, /Producto nuevo/);
  assert.equal(h.query('[data-size="L"]').getAttribute('aria-pressed'), 'true');
});

for (const change of ['photo', 'metrics', 'product']) {
  test(`una generación vieja no reaparece después de cambiar ${change}`, async (t) => {
    const h = await mountWidget(t);
    upload(h);
    let completions = 0;
    h.widget.addEventListener('try:tryon-complete', () => { completions++; });
    const pending = h.widget.generate();
    const older = h.request('/api/v1/try-on');
    if (change === 'photo') upload(h, h.photo('new.png', 'new-photo'));
    if (change === 'metrics') h.edit('#weight', '65');
    if (change === 'product') h.widget.setAttribute('product-id', 'new-product');
    older.respond(result());
    await pending;
    assert.equal(h.query('.result-image').getAttribute('src'), null);
    assert.equal(completions, 0);
  });
}

test('la finalización de una prueba antigua no habilita el botón de una prueba nueva en curso', async (t) => {
  const h = await mountWidget(t);
  upload(h);
  const first = h.widget.generate();
  const older = h.request('/api/v1/try-on');
  upload(h, h.photo('new.png', 'new-photo'));
  const second = h.widget.generate();
  const newer = h.requests.filter((entry) => entry.url.endsWith('/api/v1/try-on')).at(-1);
  older.respond(result());
  await first;
  assert.equal(h.query('.primary').disabled, true);
  assert.match(h.query('.primary').textContent, /Generando.*M/i);
  newer.respond(result());
  await second;
  assert.equal(h.query('.primary').disabled, false);
  assert.equal(h.query('.result-image').src, result().imageUrl);
});

test('cambiar el talle durante la generación mantiene claro qué talle sigue en curso', async (t) => {
  const h = await mountWidget(t);
  upload(h);
  const pending = h.widget.generate();
  h.widget.setSize('L');
  assert.equal(h.query('.primary').disabled, true);
  assert.match(h.query('.primary').textContent, /Generando.*M/i);
  h.request('/api/v1/try-on').respond(result('M'));
  await pending;
  assert.equal(h.query('.result-image').getAttribute('src'), null);
  assert.match(h.query('.result-label').textContent, /L.*sin generar/i);
  assert.match(h.query('.status').textContent, /M/);
  h.widget.setSize('M');
  assert.equal(h.query('.result-image').src, result('M').imageUrl);
});

test('cambiar de talle cierra la ampliación del resultado que ya no está seleccionado', async (t) => {
  const h = await mountWidget(t);
  upload(h);
  await generate(h);
  h.query('[data-image="result"]').click();
  assert.equal(h.query('dialog').open, true);
  h.widget.setSize('L');
  assert.equal(h.query('dialog').open, false);
  assert.equal(h.query('.dialog-image').getAttribute('src'), null);
});

test('cambiar la foto cierra su ampliación anterior y permite ampliar la foto nueva', async (t) => {
  const h = await mountWidget(t);
  upload(h);
  h.widget.openImage('base');
  assert.equal(h.query('dialog').open, true);
  upload(h, h.photo('new.png', 'new-photo'));
  assert.equal(h.query('dialog').open, false);
  h.widget.openImage('base');
  assert.equal(h.query('.dialog-image').src, 'blob:photo-2');
});

test('una respuesta sin imagen no se anuncia ni se muestra como una prueba lista', async (t) => {
  const h = await mountWidget(t);
  upload(h);
  let completions = 0;
  h.widget.addEventListener('try:tryon-complete', () => { completions++; });
  const pending = h.widget.generate();
  h.request('/api/v1/try-on').respond({ ...result(), imageUrl: '' });
  await pending;
  assert.equal(completions, 0);
  assert.equal(h.query('.result-image').getAttribute('src'), null);
  assert.equal(h.query('.status').classList.contains('error'), true);
});

for (const [field, value] of [['size', 'L'], ['productId', 'another-product']]) {
  test(`una respuesta de otro ${field} no se guarda como resultado del talle pedido`, async (t) => {
    const h = await mountWidget(t);
    upload(h);
    let completions = 0;
    h.widget.addEventListener('try:tryon-complete', () => { completions++; });
    const pending = h.widget.generate();
    h.request('/api/v1/try-on').respond({ ...result(), [field]: value });
    await pending;
    assert.equal(completions, 0);
    assert.equal(h.query('.result-image').getAttribute('src'), null);
    assert.equal(h.query('.status').classList.contains('error'), true);
  });
}

test('si falla una generación mientras se ve otro talle el mensaje identifica el talle que falló', async (t) => {
  const h = await mountWidget(t);
  upload(h);
  const pending = h.widget.generate();
  h.widget.setSize('L');
  h.request('/api/v1/try-on').respond({ error: 'El servicio está ocupado.' }, 503);
  await pending;
  assert.match(h.query('.status').textContent, /talle M/);
  assert.equal(h.query('.primary').disabled, false);
  assert.equal(h.query('.result-image').getAttribute('src'), null);
});
