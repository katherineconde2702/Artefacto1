import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createTryServer, loadConfig } from '../server.mjs';

const baseEnv = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: '0',
  TRY_ALLOWED_ORIGINS: '',
  TRY_MAX_CONCURRENT_TRY_ON: '2',
  TRY_MAX_JSON_BYTES: '4096',
  TRY_MAX_MULTIPART_BYTES: '32768',
  TRY_MAX_PHOTO_BYTES: '1024',
  TRY_RATE_LIMIT_MAX: '0',
  TRY_RATE_LIMIT_WINDOW_MS: '60000',
  TRY_TRUST_PROXY: 'false'
};

async function startServer(t, { env = {}, dependencies = {} } = {}) {
  const server = createTryServer({
    env: { ...baseEnv, ...env },
    dependencies: {
      generateOpenAIVirtualTryOn: async () => ({
        imageUrl: 'data:image/webp;base64,dGVzdA==',
        provider: 'test-provider'
      }),
      getOpenAIProviderInfo: () => ({ id: 'openai', model: 'test', configured: true }),
      ...dependencies
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

function validTryOnForm(overrides = {}) {
  const values = {
    consent: 'true',
    consentVersion: '2026-10',
    heightCm: '165',
    productId: 'soft-knit-sweater',
    recommendedSize: 'L',
    size: 'M',
    weightKg: '60',
    ...overrides
  };
  const form = new FormData();
  form.append('person', new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], { type: 'image/png' }), 'person.png');
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) form.append(key, value);
  }
  return form;
}

function chunkedRequest(url, { headers, chunks }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      const responseChunks = [];
      response.on('data', (chunk) => responseChunks.push(chunk));
      response.on('end', () => resolve({
        body: Buffer.concat(responseChunks).toString('utf8'),
        headers: response.headers,
        status: response.statusCode
      }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function incompleteRequest(url, { headers, initialChunk }) {
  let responseStarted = false;
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(url, { method: 'POST', headers }, (incoming) => {
      responseStarted = true;
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        status: incoming.statusCode
      }));
    });
    request.on('error', (error) => {
      if (!responseStarted) reject(error);
    });
    request.write(initialChunk);
  });
  return { request, response };
}

test('las rutas mal codificadas responden 400 sin derribar el servidor', async (t) => {
  const { baseUrl } = await startServer(t);
  const malformed = await fetch(`${baseUrl}/assets/%E0%A4%A`);
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /ruta/i);

  const malformedApi = await fetch(`${baseUrl}/api/v1/products/%E0%A4%A`);
  assert.equal(malformedApi.status, 400);
  const apiError = await malformedApi.json();
  assert.equal(apiError.code, 'invalid_path');
  assert.match(apiError.requestId, /^[0-9a-f-]{36}$/);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
});

test('el wrapper global sanea fallos inesperados y mantiene el proceso vivo', async (t) => {
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  t.after(() => { console.error = originalConsoleError; });

  const { baseUrl } = await startServer(t, {
    dependencies: {
      getOpenAIProviderInfo: () => { throw new Error('detalle-interno-no-publico'); }
    }
  });
  const failed = await fetch(`${baseUrl}/api/health`);
  assert.equal(failed.status, 500);
  const publicBody = await failed.json();
  assert.equal(publicBody.code, 'internal_error');
  assert.ok(publicBody.requestId);
  assert.doesNotMatch(JSON.stringify(publicBody), /detalle-interno-no-publico/);
  assert.match(logged.join('\n'), /detalle-interno-no-publico/);

  const catalog = await fetch(`${baseUrl}/api/v1/products`);
  assert.equal(catalog.status, 200);
});

test('el límite JSON cuenta bytes recibidos aunque no haya Content-Length', async (t) => {
  const { baseUrl } = await startServer(t, { env: { TRY_MAX_JSON_BYTES: '32' } });
  const response = await chunkedRequest(`${baseUrl}/api/v1/recommendation`, {
    headers: { 'Content-Type': 'application/json' },
    chunks: ['{"productId":"', 'x'.repeat(64), '"}']
  });
  assert.equal(response.status, 413);
  const body = JSON.parse(response.body);
  assert.equal(body.code, 'payload_too_large');
  assert.ok(body.requestId);
  assert.match(body.error, /máximo permitido/i);
});

test('el límite multipart se aplica durante el streaming antes de formData', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { TRY_MAX_MULTIPART_BYTES: '64', TRY_MAX_PHOTO_BYTES: '16' }
  });
  const response = await chunkedRequest(`${baseUrl}/api/v1/try-on`, {
    headers: { 'Content-Type': 'multipart/form-data; boundary=test-boundary' },
    chunks: ['--test-boundary\r\n', 'x'.repeat(100), '\r\n--test-boundary--\r\n']
  });
  assert.equal(response.status, 413);
  const body = JSON.parse(response.body);
  assert.equal(body.code, 'payload_too_large');
  assert.ok(body.requestId);
  assert.match(body.error, /máximo permitido/i);
});

test('CORS refleja sólo allowlist o mismo origen y deja públicos los assets de producto', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { TRY_ALLOWED_ORIGINS: 'https://shop.example, https://checkout.example' }
  });

  const allowed = await fetch(`${baseUrl}/api/v1/products`, {
    headers: { Origin: 'https://shop.example' }
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://shop.example');
  assert.match(allowed.headers.get('vary'), /Origin/i);

  const denied = await fetch(`${baseUrl}/api/v1/products`, {
    headers: { Origin: 'https://attacker.example' }
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.code, 'origin_not_allowed');
  assert.ok(deniedBody.requestId);

  const localDemo = await fetch(`${baseUrl}/api/v1/products`, { headers: { Origin: baseUrl } });
  assert.equal(localDemo.status, 200);
  assert.equal(localDemo.headers.get('access-control-allow-origin'), baseUrl);

  const asset = await fetch(`${baseUrl}/assets/sweater-m.png`, {
    headers: { Origin: 'https://any-store.example' }
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('access-control-allow-origin'), '*');
});

test('X-Forwarded-For no permite evadir el rate limit sin un proxy verificable', async (t) => {
  assert.throws(
    () => loadConfig({ ...baseEnv, TRY_TRUST_PROXY: 'true' }),
    /no es compatible sin una lista verificable/i
  );

  const { baseUrl } = await startServer(t, {
    env: { TRY_RATE_LIMIT_MAX: '1', TRY_RATE_LIMIT_WINDOW_MS: '60000' }
  });
  const first = await fetch(`${baseUrl}/api/v1/try-on`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Forwarded-For': '198.51.100.1' },
    body: 'invalid'
  });
  assert.equal(first.status, 415);

  const second = await fetch(`${baseUrl}/api/v1/try-on`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Forwarded-For': '203.0.113.2' },
    body: 'invalid'
  });
  assert.equal(second.status, 429);
});

test('la API está separada de la tienda y mantiene catálogo, contrato y assets', async (t) => {
  const { baseUrl } = await startServer(t);
  for (const pathname of ['/', '/product/', '/demo/']) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }

  const contract = await fetch(`${baseUrl}/openapi.yaml`);
  assert.equal(contract.status, 200);
  assert.match(contract.headers.get('content-type'), /yaml/);

  const garment = await fetch(`${baseUrl}/assets/sweater-m.png`);
  assert.equal(garment.status, 200);
  assert.equal(garment.headers.get('content-type'), 'image/png');

  const catalog = await fetch(`${baseUrl}/api/v1/products`);
  const products = await catalog.json();
  assert.equal(catalog.status, 200);
  assert.ok(Array.isArray(products));
  assert.ok(products.some((product) => product.id === 'soft-knit-sweater'));
  assert.equal(products[0].garmentAsset, undefined);
});

test('try-on recalcula el talle y no filtra errores del proveedor', async (t) => {
  let received;
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  t.after(() => { console.error = originalConsoleError; });

  const upstreamError = new Error('upstream secret: sk-never-return-this');
  upstreamError.status = 401;
  const { baseUrl } = await startServer(t, {
    dependencies: {
      generateOpenAIVirtualTryOn: async (input) => {
        received = input;
        throw upstreamError;
      }
    }
  });
  const response = await fetch(`${baseUrl}/api/v1/try-on`, {
    method: 'POST',
    body: validTryOnForm({ recommendedSize: 'XL' })
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'provider_unavailable');
  assert.doesNotMatch(JSON.stringify(body), /upstream|sk-never|401/i);
  assert.match(logged.join('\n'), /sk-never-return-this/);
  assert.equal(received.recommendedSize, 'M');
  assert.deepEqual(received.shopperMetrics, { heightCm: 165, weightKg: 60 });
});

test('try-on exige métricas válidas para prendas', async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(`${baseUrl}/api/v1/try-on`, {
    method: 'POST',
    body: validTryOnForm({ heightCm: undefined })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /altura.*peso/i);
});

test('el límite de concurrencia protege la generación', async (t) => {
  let releaseProvider;
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const { baseUrl } = await startServer(t, {
    env: { TRY_MAX_CONCURRENT_TRY_ON: '1' },
    dependencies: {
      generateOpenAIVirtualTryOn: async () => {
        markEntered();
        await providerGate;
        return { imageUrl: 'data:image/webp;base64,dGVzdA==', provider: 'test-provider' };
      }
    }
  });

  const first = fetch(`${baseUrl}/api/v1/try-on`, { method: 'POST', body: validTryOnForm() });
  await entered;
  const second = await fetch(`${baseUrl}/api/v1/try-on`, { method: 'POST', body: validTryOnForm() });
  assert.equal(second.status, 503);
  assert.equal((await second.json()).code, 'concurrency_limit');
  assert.equal(second.headers.get('retry-after'), '1');

  releaseProvider();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.provider, undefined);
  assert.equal(firstBody.warning, undefined);
  assert.equal(firstBody.sizeSimulation, undefined);
});

test('un upload lento vence y no ocupa un cupo de generación', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { TRY_BODY_TIMEOUT_MS: '200', TRY_MAX_CONCURRENT_TRY_ON: '1' }
  });
  const slow = incompleteRequest(`${baseUrl}/api/v1/try-on`, {
    headers: { 'Content-Type': 'multipart/form-data; boundary=slow-boundary' },
    initialChunk: '--slow-boundary\r\nContent-Disposition: form-data; name="person"\r\n\r\n'
  });
  t.after(() => slow.request.destroy());
  await new Promise((resolve) => setTimeout(resolve, 30));

  const fast = await fetch(`${baseUrl}/api/v1/try-on`, { method: 'POST', body: validTryOnForm() });
  assert.equal(fast.status, 200);

  const timedOut = await slow.response;
  assert.equal(timedOut.status, 408);
  assert.equal(JSON.parse(timedOut.body).code, 'request_timeout');
});

test('el rate limit configurable devuelve 429 y Retry-After', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { TRY_RATE_LIMIT_MAX: '1', TRY_RATE_LIMIT_WINDOW_MS: '60000' }
  });
  const first = await fetch(`${baseUrl}/api/v1/try-on`, { method: 'POST', body: validTryOnForm() });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('ratelimit-remaining'), '0');

  const second = await fetch(`${baseUrl}/api/v1/try-on`, { method: 'POST', body: validTryOnForm() });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).code, 'rate_limited');
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
});

test('las respuestas incluyen cabeceras defensivas y no-store para API', async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(`${baseUrl}/api/health`);
  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: true,
    service: 'TRY API',
    capabilities: { tryOn: { available: true } }
  });
  assert.equal(payload.provider, undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(response.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(response.headers.get('x-permitted-cross-domain-policies'), 'none');
});
