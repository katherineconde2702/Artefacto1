import test from 'node:test';
import assert from 'node:assert/strict';
import { getProduct } from '../src/services/catalog.mjs';
import { recommendSize } from '../src/services/size-recommender.mjs';

test('150 cm y 45 kg recomienda S para el sweater oversized', () => {
  const recommendation = recommendSize(getProduct('soft-knit-sweater'), {
    heightCm: 150,
    weightKg: 45
  });
  assert.equal(recommendation.size, 'S');
  assert.equal(recommendation.metrics.bmi, 20);
  assert.equal(recommendation.fit, 'oversized');
});

test('la configuración inicial de 168 cm y 59 kg recomienda M', () => {
  const recommendation = recommendSize(getProduct('soft-knit-sweater'), {
    heightCm: 168,
    weightKg: 59
  });
  assert.equal(recommendation.size, 'M');
});

test('rechaza medidas fuera del rango adulto configurado', () => {
  assert.throws(
    () => recommendSize(getProduct('soft-knit-sweater'), { heightCm: 120, weightKg: 30 }),
    /mujer adulta/
  );
});

test('la rama de calzado usa centímetros de pie', () => {
  const shoe = { audience: 'adult-women', articleType: 'shoes', targetFit: 'regular' };
  const recommendation = recommendSize(shoe, { footCm: 24.2 });
  assert.equal(recommendation.size, '38');
  assert.equal(recommendation.metrics.footCm, 24.2);
});
