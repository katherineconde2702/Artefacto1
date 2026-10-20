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
  assert.match(prompt, /Size L is larger than recommended size M/i);
  assert.match(prompt, /116 cm chest circumference/i);
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
