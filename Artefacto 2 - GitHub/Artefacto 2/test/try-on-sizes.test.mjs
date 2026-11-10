import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTryServer } from '../server.mjs';
import { buildOpenAIEditPrompt } from '../src/providers/openai.mjs';

test('S, M y L llegan al proveedor por separado con la misma foto y métricas originales', async (t) => {
  const calls = [];
  const server = createTryServer({
    env: {
      HOST: '127.0.0.1', PORT: '0', TRY_ALLOWED_ORIGINS: '',
      TRY_RATE_LIMIT_MAX: '0', TRY_MAX_CONCURRENT_TRY_ON: '2'
    },
    dependencies: {
      getOpenAIProviderInfo: () => ({ id: 'openai', model: 'test', configured: true }),
      generateOpenAIVirtualTryOn: async (input) => {
        calls.push({
          size: input.size,
          person: Buffer.from(await input.person.arrayBuffer()),
          garment: Buffer.from(await input.garment.arrayBuffer()),
          metrics: input.shopperMetrics,
          recommendedSize: input.recommendedSize,
          prompt: buildOpenAIEditPrompt(input)
        });
        return { imageUrl: `data:image/webp;base64,${Buffer.from(input.size).toString('base64')}` };
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const originalPhoto = Buffer.from([0x89, 0x50, 0x4e, 0x47, 10, 20, 30, 40]);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const images = [];

  for (const size of ['S', 'M', 'L']) {
    const form = new FormData();
    form.append('person', new File([originalPhoto], 'original.png', { type: 'image/png' }));
    for (const [key, value] of Object.entries({
      productId: 'soft-knit-sweater', size, heightCm: '150', weightKg: '45',
      recommendedSize: 'XL', consent: 'true', consentVersion: '2026-10-13'
    })) form.append(key, value);
    const response = await fetch(`${baseUrl}/api/v1/try-on`, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.size, size);
    assert.equal(result.productId, 'soft-knit-sweater');
    images.push(result.imageUrl);
  }

  assert.deepEqual(calls.map(({ size }) => size), ['S', 'M', 'L']);
  for (const call of calls) {
    assert.deepEqual(call.person, originalPhoto);
    assert.deepEqual(call.metrics, { heightCm: 150, weightKg: 45 });
    assert.equal(call.recommendedSize, 'S', 'la recomendación no reemplaza el talle elegido');
  }
  assert.equal(new Set(calls.map(({ prompt }) => prompt)).size, 3);
  assert.equal(new Set(calls.map(({ garment }) => garment.toString('base64'))).size, 3);
  assert.equal(new Set(images).size, 3, 'la API devuelve el resultado correspondiente a cada request');
});
