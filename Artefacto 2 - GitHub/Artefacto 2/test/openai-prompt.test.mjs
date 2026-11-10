import test from 'node:test';
import assert from 'node:assert/strict';
import { getProduct } from '../src/services/catalog.mjs';
import { buildOpenAIEditPrompt } from '../src/providers/openai.mjs';

test('el prompt fija identidad, cuerpo, métricas y talle en la prenda', () => {
  const prompt = buildOpenAIEditPrompt({
    product: getProduct('soft-knit-sweater'),
    size: 'L',
    recommendedSize: 'M',
    shopperMetrics: { heightCm: 168, weightKg: 59 }
  });

  assert.match(prompt, /168 cm height and 59 kg weight/);
  assert.match(prompt, /sole source of truth/i);
  assert.match(prompt, /Never slim, widen, lengthen, shorten/i);
  assert.match(prompt, /recommendation M.*heuristic/i);
  assert.match(prompt, /116 cm chest circumference/i);
});

test('calcula el IMC con altura y peso y lo limita a contexto secundario', () => {
  const prompt = buildOpenAIEditPrompt({
    product: getProduct('soft-knit-sweater'),
    size: 'S',
    recommendedSize: 'S',
    shopperMetrics: { heightCm: 150, weightKg: 45, bmi: 34 }
  });

  assert.match(prompt, /BMI 20(?:\.0)?\b.*secondary context/i);
  assert.doesNotMatch(prompt, /BMI 34\b/);
  assert.match(prompt, /Never infer body circumferences.*BMI/i);
  assert.match(prompt, /photograph always wins/i);
});

for (const metrics of [
  { heightCm: 0, weightKg: 59 },
  { heightCm: 134, weightKg: 59 },
  { heightCm: 221, weightKg: 59 },
  { heightCm: 168, weightKg: 34 },
  { heightCm: 168, weightKg: 181 },
  { heightCm: 168, weightKg: NaN },
  { heightCm: 168 },
  undefined
]) {
  test(`omite el IMC y las métricas inválidas: ${JSON.stringify(metrics)}`, () => {
    const prompt = buildOpenAIEditPrompt({
      product: getProduct('soft-knit-sweater'), size: 'M', shopperMetrics: metrics
    });

    assert.doesNotMatch(prompt, /SHOPPER METRICS:|BMI \d|NaN|Infinity/);
    assert.match(prompt, /sole source of truth/i);
  });
}

for (const { size, chest, length, sleeve, deltas } of [
  { size: 'S', chest: 100, length: 58, sleeve: 54, deltas: ['-8', '-2', '-1'] },
  { size: 'M', chest: 108, length: 60, sleeve: 55, deltas: ['0', '0', '0'] },
  { size: 'L', chest: 116, length: 62, sleeve: 56, deltas: ['+8', '+2', '+1'] }
]) {
  test(`envía medidas de sweater ${size} y diferencias numéricas contra M del catálogo`, () => {
    const prompt = buildOpenAIEditPrompt({
      product: getProduct('soft-knit-sweater'), size, recommendedSize: 'XL'
    });

    assert.ok(prompt.includes(`${chest} cm chest circumference`));
    assert.ok(prompt.includes(`${length} cm body length`));
    assert.ok(prompt.includes(`${sleeve} cm sleeve length`));
    assert.match(prompt, /reference size M.*catalog default/i);
    for (const [label, delta] of [
      ['chest circumference', deltas[0]], ['body length', deltas[1]], ['sleeve length', deltas[2]]
    ]) {
      assert.ok(prompt.includes(`${label}: ${delta} cm`), `${label} debe tener delta ${delta}`);
    }
  });
}

test('no inventa diferencias cuando faltan medidas comparables', () => {
  const product = {
    ...getProduct('soft-knit-sweater'),
    garmentMeasurementsCm: { S: { chestCircumference: 100 }, M: { bodyLength: 60 } }
  };
  const prompt = buildOpenAIEditPrompt({ product, size: 'S', recommendedSize: 'M' });

  assert.match(prompt, /100 cm chest circumference/i);
  assert.match(prompt, /No comparable measurements.*do not invent/i);
  assert.doesNotMatch(prompt, /chest circumference: [+-]?\d+ cm|body length: [+-]?\d+ cm/);
});

test('el recomendado heurístico no establece calce ideal ni sustituye al talle seleccionado', () => {
  const prompt = buildOpenAIEditPrompt({
    product: getProduct('soft-knit-sweater'), size: 'M', recommendedSize: 'M'
  });

  assert.match(prompt, /recommendation M.*heuristic/i);
  assert.match(prompt, /does not establish an ideal fit/i);
  assert.doesNotMatch(prompt, /recommended size and must express|smaller than recommended|larger than recommended/i);
});

for (const [productId, fit] of [
  ['soft-knit-sweater', 'oversized'], ['fluid-silk-blouse', 'regular'], ['ribbed-midi-dress', 'slim']
]) {
  test(`mantiene el diseño ${fit} sin normalizar sus talles al mismo calce`, () => {
    const prompt = buildOpenAIEditPrompt({ product: getProduct(productId), size: 'S', recommendedSize: 'M' });

    assert.ok(prompt.includes(`intended design fit ${fit}`));
    assert.match(prompt, /Do not normalize different retail sizes to the same fit/i);
    assert.match(prompt, /Retail labels alone do not imply tight or loose/i);
    assert.match(prompt, /Do not exaggerate.*differences/i);
  });
}

test('distingue la anatomía inmutable del contorno exterior variable de la prenda', () => {
  const prompt = buildOpenAIEditPrompt({ product: getProduct('soft-knit-sweater'), size: 'L' });

  assert.match(prompt, /anatomical body shape/i);
  assert.match(prompt, /garment's outer contour may change/i);
  assert.match(prompt, /original clothing outline is not.*anatomy/i);
  assert.match(prompt, /Never slim, widen, lengthen, shorten/i);
  assert.ok(prompt.split('\n').length > 5, 'las instrucciones se separan en secciones legibles');
});

test('el prompt limita la edición a la región correcta de pantalones', () => {
  const prompt = buildOpenAIEditPrompt({
    product: getProduct('wide-leg-trousers'),
    size: 'S',
    recommendedSize: 'M',
    shopperMetrics: { heightCm: 150, weightKg: 45 }
  });

  assert.match(prompt, /replace only the existing lower-body garment/i);
  assert.match(prompt, /Preserve the person’s upper-body clothing/i);
  assert.match(prompt, /68 cm waist circumference/i);
});

test('el prompt de vestido usa el área completa de la prenda', () => {
  const prompt = buildOpenAIEditPrompt({
    product: getProduct('ribbed-midi-dress'),
    size: 'M',
    recommendedSize: 'M',
    shopperMetrics: { heightCm: 165, weightKg: 57 }
  });

  assert.match(prompt, /shoulders through the dress hem/i);
  assert.match(prompt, /84 cm bust circumference/i);
});

test('el prompt de outerwear conserva la capa interior visible', () => {
  const prompt = buildOpenAIEditPrompt({
    product: getProduct('relaxed-linen-blazer'),
    size: 'M',
    recommendedSize: 'M',
    shopperMetrics: { heightCm: 170, weightKg: 62 }
  });

  assert.match(prompt, /as the outer layer over the existing upper-body clothing/i);
  assert.match(prompt, /underlayer that would remain naturally visible/i);
  assert.doesNotMatch(prompt, /The person is an adult woman/i);
  assert.doesNotMatch(prompt, /Keep the result full-body/i);
});

test('una categoría desconocida se rechaza en lugar de editar como top', () => {
  assert.throws(() => buildOpenAIEditPrompt({
    product: { ...getProduct('soft-knit-sweater'), category: 'unknown' },
    size: 'M',
    recommendedSize: 'M',
    shopperMetrics: { heightCm: 168, weightKg: 59 }
  }), /Categoría de prenda no compatible/);
});
