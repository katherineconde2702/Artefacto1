import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateOpenAIVirtualTryOn } from '../src/providers/openai.mjs';
import { getProduct } from '../src/services/catalog.mjs';

test('el request de imágenes envía el talle elegido en el prompt y la foto original como primera imagen', async (t) => {
  const keys = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_IMAGE_MODEL', 'OPENAI_IMAGE_SIZE', 'OPENAI_IMAGE_QUALITY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
  process.env.OPENAI_IMAGE_MODEL = 'gpt-image-1.5';
  process.env.OPENAI_IMAGE_SIZE = '1024x1536';
  process.env.OPENAI_IMAGE_QUALITY = 'medium';
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, options });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(`result-${sent.length}`).toString('base64') }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  });
  const person = new File(['same-original-photo'], 'original.png', { type: 'image/png' });
  const garment = new File(['garment-reference'], 'sweater.png', { type: 'image/png' });
  const product = getProduct('soft-knit-sweater');
  const prompts = [];

  for (const size of ['S', 'M', 'L']) {
    const result = await generateOpenAIVirtualTryOn({
      person, garment, product, size, recommendedSize: 'S', shopperMetrics: { heightCm: 150, weightKg: 45 }
    });
    assert.equal(result.requestedSize, size);
    assert.match(result.imageUrl, /^data:image\/webp;base64,/);
    const { url, options } = sent.at(-1);
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('model'), 'gpt-image-1.5');
    assert.equal(options.body.get('size'), '1024x1536', 'size de OpenAI es resolución, no talle de ropa');
    assert.equal(options.body.get('input_fidelity'), 'high');
    const images = options.body.getAll('image[]');
    assert.equal(images.length, 2);
    assert.equal(await images[0].text(), 'same-original-photo');
    assert.equal(await images[1].text(), 'garment-reference');
    const prompt = options.body.get('prompt');
    assert.ok(prompt.includes(`requested retail size ${size}`));
    assert.match(prompt, /Calculated BMI 20;/);
    assert.match(prompt, /Never infer body circumferences/);
    prompts.push(prompt);
  }
  assert.equal(sent.length, 3);
  assert.equal(new Set(prompts).size, 3);
});
