const DEFAULT_MODEL = 'gpt-image-1.5';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const TIMEOUT_MS = 180_000;

function configuredModel() {
  return process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL;
}

function configuredEndpoint() {
  const base = (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  return `${base}/images/edits`;
}

function publicError(message, status = 503, cause, code = 'image_service_error') {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  error.publicMessage = message;
  error.code = code;
  return error;
}

const measurementLabels = {
  chestCircumference: 'chest circumference',
  bustCircumference: 'bust circumference',
  waistCircumference: 'waist circumference',
  hipCircumference: 'hip circumference',
  bodyLength: 'body length',
  sleeveLength: 'sleeve length',
  inseamLength: 'inseam length'
};

function measuredDimensions(product, size) {
  return Object.entries(product.garmentMeasurementsCm?.[size] || {})
    .filter(([, value]) => Number.isFinite(value) && value > 0);
}

function garmentMeasurements(product, size) {
  const values = measuredDimensions(product, size);
  if (!values.length) return 'SELECTED GARMENT MEASUREMENTS: unavailable. Use the garment reference without inventing measurements.';
  const specifications = values
    .map(([key, value]) => `${value} cm ${measurementLabels[key] || key}`)
    .join(', ');
  return `SELECTED GARMENT MEASUREMENTS: Garment specifications for size ${size}: ${specifications}. These are garment dimensions, not body measurements.`;
}

function referenceSizeComparison(product, size) {
  const referenceSize = product.defaultSize;
  const reference = product.garmentMeasurementsCm?.[referenceSize];
  const comparable = product.sizes.includes(referenceSize)
    ? measuredDimensions(product, size).filter(([key]) => Number.isFinite(reference?.[key]) && reference[key] > 0)
    : [];
  if (!comparable.length) {
    return 'REFERENCE SIZE COMPARISON: No comparable measurements are available; do not invent missing measurements or size differences.';
  }
  const differences = comparable.map(([key, value]) => {
    const difference = Number((value - reference[key]).toFixed(2));
    return `${measurementLabels[key] || key}: ${difference > 0 ? '+' : ''}${difference} cm (${value} cm selected; ${reference[key]} cm reference)`;
  }).join('; ');
  return `REFERENCE SIZE COMPARISON: reference size ${referenceSize} (catalog default, a dimensional reference only). Selected size ${size} minus reference size ${referenceSize}: ${differences}. Apply only these supported differences to the garment; do not assume unlisted dimensions change.`;
}

function editRegion(product) {
  switch (product.category) {
    case 'tops':
      return `replace only the existing upper-body garment with the ${product.name}. Preserve all lower-body clothing`;
    case 'outerwear':
      return `add the ${product.name} as the outer layer over the existing upper-body clothing. Preserve any underlayer that would remain naturally visible and preserve all lower-body clothing`;
    case 'bottoms':
      return 'replace only the existing lower-body garment with the referenced trousers. Preserve the person’s upper-body clothing and shoes';
    case 'dresses':
      return 'replace only the clothing naturally covered from shoulders through the dress hem with the referenced dress. Preserve the person’s head, hair, skin, limbs and shoes';
    default:
      throw publicError(`Categoría de prenda no compatible: ${product.category}.`, 500, undefined, 'unsupported_garment_category');
  }
}

function recommendationContext(product, size, recommendedSize) {
  if (!recommendedSize || !product.sizes.includes(recommendedSize)) {
    return 'SIZE RECOMMENDATION CONTEXT: no recommendation supplied. Use the selected garment measurements, product design fit and original photograph.';
  }
  return `SIZE RECOMMENDATION CONTEXT: recommendation ${recommendedSize} is a height/weight heuristic. It does not establish an ideal fit and must not override requested size ${size}, its measured dimensions, the product design fit or the original photograph.`;
}

function shopperContext(shopperMetrics) {
  const heightCm = Number(shopperMetrics?.heightCm);
  const weightKg = Number(shopperMetrics?.weightKg);
  if (!Number.isFinite(heightCm) || heightCm < 135 || heightCm > 220
    || !Number.isFinite(weightKg) || weightKg < 35 || weightKg > 180) {
    return 'The photographed person in image 1 is the sole source of truth for body shape and proportions.';
  }
  const bmi = Number((weightKg / ((heightCm / 100) ** 2)).toFixed(1));
  return [
    `SHOPPER METRICS: ${heightCm} cm height and ${weightKg} kg weight.`,
    `Calculated BMI ${bmi}; secondary context only for garment scale consistency, not a body description or fit measurement.`,
    'Never infer body circumferences, anatomy, body shape, body composition or a replacement body from BMI, height or weight.',
    'Never scale, stretch, shrink or reposition the person or camera because of these numbers. If the numbers and visible photograph appear inconsistent, the photograph always wins.',
    'Do not infer, average, regenerate or substitute a body from these measurements; image 1 remains the sole source of truth for the person’s visible body shape and proportions.'
  ].join(' ');
}

export function buildOpenAIEditPrompt({ product, size, recommendedSize, shopperMetrics }) {
  return [
    'VIRTUAL TRY-ON IMAGE EDIT. Return one photorealistic image and no text, labels, collage or before-and-after layout.',
    'INPUT ORDER: image 1 is the immutable person photograph and composition reference; image 2 is the exact garment reference.',
    'IDENTITY AND BODY LOCK: preserve the exact identity, face, expression, facial features, hair, skin texture and tone, anatomical body shape, body proportions, anatomy, pose, hand position, leg position and visible footwear from image 1.',
    'Do not infer or modify age, gender expression, ethnicity or appearance from product metadata.',
    shopperContext(shopperMetrics),
    'COMPOSITION LOCK: preserve the exact camera angle, perspective, crop, subject scale, global lighting, background and all already-visible body regions from image 1. Do not outpaint, expand the frame or invent hidden body parts or scenery.',
    `ALLOWED EDIT REGION: ${editRegion(product)}. Outside the new garment silhouette, preserve the original pixels as closely as possible. Permit only physically natural occlusion of existing clothing or skin by the garment; never alter the geometry or texture of the body underneath.`,
    'PRODUCT FIDELITY: reproduce the garment from image 2 faithfully, including exact color, material, knit or weave, pattern scale, neckline, seams, pockets, buttons, closures, hardware, cuffs, hem, construction and any visible branding. Do not invent or omit product details, accessories, layers or styling.',
    `FIT: requested retail size ${size}; intended design fit ${product.targetFit}.`,
    garmentMeasurements(product, size),
    referenceSizeComparison(product, size),
    recommendationContext(product, size, recommendedSize),
    `FIT INTERPRETATION: preserve the product's ${product.targetFit} cut in every size; retail size changes garment dimensions, not its design category. Do not normalize different retail sizes to the same fit. Retail labels alone do not imply tight or loose; use the supplied dimensions and visible photograph for natural garment ease, drape and fabric tension. Do not exaggerate size differences or invent missing body measurements.`,
    "ANATOMY VS GARMENT CONTOUR: the person's anatomy is immutable; the garment's outer contour may change according to its selected dimensions. The original clothing outline is not the person's anatomy and must not force every selected size into the same clothing silhouette.",
    'The size may change only garment boundaries, ease, drape, folds, sleeve length, body length, tension and fabric volume. Any tightness or compression must be represented in the fabric only, never by deforming skin or body contours.',
    'Never slim, widen, lengthen, shorten, retouch, beautify or otherwise reshape the person to make the garment fit.',
    'Preserve the original framing exactly. Do not retouch, stylize or beautify the person or scene. Allow only local shadows and occlusions physically caused by the new garment while preserving the original global illumination.'
  ].join('\n');
}

export function getOpenAIProviderInfo() {
  return {
    id: 'openai',
    model: configuredModel(),
    configured: Boolean(process.env.OPENAI_API_KEY)
  };
}

export async function generateOpenAIVirtualTryOn({ person, garment, product, size, recommendedSize, shopperMetrics }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = configuredModel();
  if (!apiKey) {
    throw publicError('El servicio de prueba virtual todavía no está configurado.', 503, undefined, 'image_service_not_configured');
  }

  const form = new FormData();
  form.append('model', model);
  form.append('image[]', person, person.name || 'person.png');
  form.append('image[]', garment, garment.name || 'garment.png');
  form.append('prompt', buildOpenAIEditPrompt({ product, size, recommendedSize, shopperMetrics }));
  form.append('quality', process.env.OPENAI_IMAGE_QUALITY || 'medium');
  form.append('size', process.env.OPENAI_IMAGE_SIZE || '1024x1536');
  form.append('output_format', 'webp');
  form.append('output_compression', '92');
  form.append('moderation', 'auto');
  if (/^gpt-image-1(?:\.5)?$/.test(model)) form.append('input_fidelity', 'high');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(configuredEndpoint(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') throw publicError('La generación demoró más de lo esperado. Intentá nuevamente.', 504, error, 'image_service_timeout');
    throw publicError('La prueba virtual no está disponible en este momento.', 503, error, 'image_service_unavailable');
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id');
    const upstreamCode = payload?.error?.code || payload?.error?.type || null;
    const cause = new Error(`OpenAI ${response.status}${upstreamCode ? ` ${upstreamCode}` : ''}${requestId ? ` request=${requestId}` : ''}`);
    if ([401, 403].includes(response.status)) {
      throw publicError('La prueba virtual requiere revisar la configuración del servicio.', 503, cause, 'image_service_auth');
    }
    if (response.status === 429) {
      throw publicError('La prueba virtual alcanzó temporalmente su límite de uso. Intentá más tarde.', 429, cause, 'image_service_rate_limited');
    }
    if (response.status >= 500) {
      throw publicError('La prueba virtual no está disponible en este momento.', 503, cause, 'image_service_unavailable');
    }
    throw publicError('No pudimos procesar esta foto. Probá con otra imagen de cuerpo completo.', 422, cause, 'image_request_rejected');
  }

  const base64 = payload?.data?.[0]?.b64_json;
  if (!base64) throw publicError('No pudimos obtener una imagen válida. Intentá nuevamente.', 502, undefined, 'image_result_missing');
  const format = payload.output_format || 'webp';
  return {
    imageUrl: `data:image/${format};base64,${base64}`,
    provider: `OpenAI ${model}`,
    requestedSize: size,
    usage: payload.usage || null
  };
}
