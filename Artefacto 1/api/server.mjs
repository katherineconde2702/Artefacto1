import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenAIVirtualTryOn, getOpenAIProviderInfo } from './src/providers/openai.mjs';
import { getProduct, listProducts, toPublicProduct } from './src/services/catalog.mjs';
import { recommendSize } from './src/services/size-recommender.mjs';

const serverFile = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = join(root, 'public');

const KIB = 1024;
const MIB = 1024 * KIB;
const DEFAULT_MAX_PHOTO_BYTES = 10 * MIB;
const DEFAULT_MAX_JSON_BYTES = 64 * KIB;
const DEFAULT_MULTIPART_OVERHEAD_BYTES = 2 * MIB;
const MAX_JSON_BYTES = 1 * MIB;
const MAX_MULTIPART_BYTES = 64 * MIB;
const MAX_PHOTO_BYTES = 50 * MIB;
const canonicalPublicRoot = await realpath(publicRoot);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8'
};

class PublicHttpError extends Error {
  constructor(status, publicMessage, { closeConnection = false, cause, code = 'invalid_request' } = {}) {
    super(publicMessage, cause ? { cause } : undefined);
    this.name = 'PublicHttpError';
    this.status = status;
    this.publicMessage = publicMessage;
    this.closeConnection = closeConnection;
    this.code = code;
  }
}

function integerSetting(env, names, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const name = names.find((candidate) => env[candidate] !== undefined && String(env[candidate]).trim() !== '');
  if (!name) return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

function booleanSetting(value) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

function parseAllowedOrigins(value) {
  const origins = new Set();
  for (const item of String(value || '').split(',')) {
    const candidate = item.trim();
    if (!candidate) continue;
    if (candidate === '*') {
      throw new Error('TRY_ALLOWED_ORIGINS requiere orígenes explícitos; no admite * para la API.');
    }

    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`TRY_ALLOWED_ORIGINS contiene un origen inválido: ${candidate}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || (parsed.pathname !== '/' && parsed.pathname !== '')
      || parsed.search
      || parsed.hash) {
      throw new Error(`TRY_ALLOWED_ORIGINS debe contener orígenes HTTP(S), no URLs completas: ${candidate}`);
    }
    origins.add(parsed.origin);
  }
  return origins;
}

export function loadConfig(env = process.env) {
  if (booleanSetting(env.TRY_TRUST_PROXY)) {
    throw new Error('TRY_TRUST_PROXY no es compatible sin una lista verificable de proxies; aplicá el rate limit del edge o dejalo desactivado.');
  }
  const maxPhotoBytes = integerSetting(env, ['TRY_MAX_PHOTO_BYTES'], DEFAULT_MAX_PHOTO_BYTES, {
    min: 1,
    max: MAX_PHOTO_BYTES
  });
  const maxMultipartBytes = integerSetting(
    env,
    ['TRY_MAX_MULTIPART_BYTES'],
    maxPhotoBytes + DEFAULT_MULTIPART_OVERHEAD_BYTES,
    { min: 1, max: MAX_MULTIPART_BYTES }
  );
  if (maxMultipartBytes <= maxPhotoBytes) {
    throw new Error('TRY_MAX_MULTIPART_BYTES debe ser mayor que TRY_MAX_PHOTO_BYTES para admitir el formulario.');
  }

  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port: integerSetting(env, ['PORT'], 8787, { min: 0, max: 65_535 }),
    maxJsonBytes: integerSetting(env, ['TRY_MAX_JSON_BYTES'], DEFAULT_MAX_JSON_BYTES, {
      min: 1,
      max: MAX_JSON_BYTES
    }),
    maxPhotoBytes,
    maxMultipartBytes,
    bodyTimeoutMs: integerSetting(env, ['TRY_BODY_TIMEOUT_MS'], 30_000, { min: 10, max: 300_000 }),
    maxConcurrentTryOns: integerSetting(
      env,
      ['TRY_MAX_CONCURRENT_TRY_ON', 'TRY_MAX_CONCURRENCY', 'TRY_ON_MAX_CONCURRENCY'],
      2,
      { min: 1, max: 1_000 }
    ),
    rateLimitMax: integerSetting(env, ['TRY_RATE_LIMIT_MAX'], 10, { min: 0, max: 1_000_000 }),
    rateLimitWindowMs: integerSetting(env, ['TRY_RATE_LIMIT_WINDOW_MS'], 60_000, {
      min: 1,
      max: 24 * 60 * 60 * 1_000
    }),
    allowedOrigins: parseAllowedOrigins(env.TRY_ALLOWED_ORIGINS)
  });
}

function appendVary(res, value) {
  const current = String(res.getHeader('Vary') || '');
  const values = new Set(current.split(',').map((item) => item.trim()).filter(Boolean));
  values.add(value);
  res.setHeader('Vary', [...values].join(', '));
}

function setBaseHeaders(res, { api = false } = {}) {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (api) res.setHeader('Cache-Control', 'no-store');
}

function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, headers);
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, body, headers = {}) {
  send(res, status, JSON.stringify(body), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
}

function publicError(res, error, extra = {}) {
  sendJson(res, error.status, { ...extra, error: error.publicMessage });
}

function sendApiError(res, status, requestId, code, error) {
  sendJson(res, status, { requestId, code, error });
}

function closeAfterResponse(req, res) {
  if (res.getHeader('Connection') === 'close') return;
  res.setHeader('Connection', 'close');
  res.once('finish', () => {
    if (!req.complete) req.destroy();
  });
}

function closeIfBodyUnread(req, res) {
  if (!['GET', 'HEAD'].includes(req.method) && !req.complete) closeAfterResponse(req, res);
}

function normalizedOrigin(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    throw new PublicHttpError(400, 'El encabezado Origin no es válido.', { code: 'invalid_origin' });
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || (parsed.pathname !== '/' && parsed.pathname !== '')
      || parsed.search
      || parsed.hash) {
      throw new Error('invalid origin');
    }
    return parsed.origin;
  } catch {
    throw new PublicHttpError(400, 'El encabezado Origin no es válido.', { code: 'invalid_origin' });
  }
}

function requestProtocol(req) {
  return req.socket.encrypted ? 'https:' : 'http:';
}

function isSameOrigin(origin, req) {
  const host = req.headers.host;
  if (!host) return false;
  try {
    const requestOrigin = new URL(`${requestProtocol(req)}//${host}`);
    const localHost = requestOrigin.hostname === 'localhost'
      || requestOrigin.hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/.test(requestOrigin.hostname);
    return localHost && origin === requestOrigin.origin;
  } catch {
    return false;
  }
}

function applyCors(req, res, config, { api }) {
  if (!api) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return true;
  }

  appendVary(res, 'Origin');
  const origin = normalizedOrigin(req.headers.origin);
  if (!origin) return true;
  const allowed = config.allowedOrigins.has(origin)
    || isSameOrigin(origin, req);
  if (!allowed) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-TRY-Session');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, X-Request-Id');
  return true;
}

function parseContentLength(req) {
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  if (Array.isArray(raw) || !/^\d+$/.test(raw)) {
    throw new PublicHttpError(400, 'El encabezado Content-Length no es válido.', {
      closeConnection: true,
      code: 'invalid_content_length'
    });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new PublicHttpError(413, 'La solicitud supera el máximo permitido.', {
      closeConnection: true,
      code: 'payload_too_large'
    });
  }
  return value;
}

async function readRequestBody(req, maxBytes, timeoutMs) {
  const contentLength = parseContentLength(req);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new PublicHttpError(413, 'La solicitud supera el máximo permitido.', {
      closeConnection: true,
      code: 'payload_too_large'
    });
  }

  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      req.off('aborted', onAborted);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const fail = (error, pause = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pause) req.pause();
      rejectBody(error);
    };
    const onAborted = () => fail(new PublicHttpError(400, 'La solicitud quedó incompleta.', {
      closeConnection: true,
      code: 'incomplete_request'
    }));
    const onError = (error) => fail(error);
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        fail(new PublicHttpError(413, 'La solicitud supera el máximo permitido.', {
          closeConnection: true,
          code: 'payload_too_large'
        }), true);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveBody(Buffer.concat(chunks, total));
    };

    req.on('aborted', onAborted);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    timeout = setTimeout(() => {
      fail(new PublicHttpError(408, 'La solicitud demoró más de lo permitido.', {
        closeConnection: true,
        code: 'request_timeout'
      }), true);
    }, timeoutMs);
    timeout.unref();
  });
}

function bufferedWebRequest(req, body) {
  return new Request('http://localhost/', {
    method: req.method,
    headers: req.headers,
    body
  });
}

function isJsonContentType(contentType) {
  const mediaType = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

function createRateLimiter(config) {
  const clients = new Map();
  let operations = 0;

  function clientKey(req) {
    return req.socket.remoteAddress || 'unknown';
  }

  return {
    consume(req, now = Date.now()) {
      if (config.rateLimitMax === 0) return null;
      operations += 1;
      if (operations % 100 === 0) {
        for (const [key, entry] of clients) {
          if (entry.resetAt <= now) clients.delete(key);
        }
      }

      const key = clientKey(req);
      let entry = clients.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + config.rateLimitWindowMs };
        clients.set(key, entry);
      }
      const allowed = entry.count < config.rateLimitMax;
      if (allowed) entry.count += 1;
      return {
        allowed,
        limit: config.rateLimitMax,
        remaining: Math.max(0, config.rateLimitMax - entry.count),
        resetSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1_000))
      };
    }
  };
}

function setRateLimitHeaders(res, result, config) {
  if (!result) return;
  res.setHeader('RateLimit-Limit', result.limit);
  res.setHeader('RateLimit-Remaining', result.remaining);
  res.setHeader('RateLimit-Reset', result.resetSeconds);
  res.setHeader('RateLimit-Policy', `${result.limit};w=${Math.ceil(config.rateLimitWindowMs / 1_000)}`);
}

async function handleRecommendation(req, res, config, requestId) {
  if (!isJsonContentType(req.headers['content-type'])) {
    closeIfBodyUnread(req, res);
    return sendApiError(
      res,
      415,
      requestId,
      'unsupported_media_type',
      'La recomendación requiere application/json.'
    );
  }

  let input;
  try {
    const body = await readRequestBody(req, config.maxJsonBytes, config.bodyTimeoutMs);
    input = await bufferedWebRequest(req, body).json();
  } catch (error) {
    if (error instanceof PublicHttpError) {
      if (error.closeConnection) closeAfterResponse(req, res);
      return sendApiError(res, error.status, requestId, error.code, error.publicMessage);
    }
    return sendApiError(res, 400, requestId, 'invalid_json', 'El cuerpo JSON no es válido.');
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return sendApiError(res, 400, requestId, 'invalid_json', 'El cuerpo JSON no es válido.');
  }
  const product = getProduct(String(input.productId || ''));
  if (!product) return sendApiError(res, 404, requestId, 'product_not_found', 'Producto no encontrado.');

  try {
    return sendJson(res, 200, {
      productId: product.id,
      articleType: product.articleType,
      targetFit: product.targetFit,
      recommendation: recommendSize(product, input)
    });
  } catch {
    return sendApiError(
      res,
      400,
      requestId,
      'invalid_metrics',
      'No se pudo calcular el talle con los datos enviados.'
    );
  }
}

async function handleTryOn(req, res, state, requestId) {
  const { config, dependencies } = state;
  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    closeIfBodyUnread(req, res);
    return sendApiError(
      res,
      415,
      requestId,
      'unsupported_media_type',
      'La prueba virtual requiere multipart/form-data.'
    );
  }

  let form;
  try {
    const body = await readRequestBody(req, config.maxMultipartBytes, config.bodyTimeoutMs);
    form = await bufferedWebRequest(req, body).formData();
  } catch (error) {
    if (error instanceof PublicHttpError) {
      if (error.closeConnection) closeAfterResponse(req, res);
      return sendApiError(
        res,
        error.status,
        requestId,
        error.code,
        error.publicMessage
      );
    }
    console.error(`[try-on:${requestId}] formulario multipart inválido`, error);
    return sendApiError(res, 400, requestId, 'invalid_form', 'El formulario enviado no es válido.');
  }

  const person = form.get('person');
  const productId = String(form.get('productId') || '');
  const size = String(form.get('size') || '').toUpperCase();
  const clientRecommendedSize = String(form.get('recommendedSize') || '').toUpperCase();
  const consentVersion = String(form.get('consentVersion') || '');
  const consent = String(form.get('consent') || '') === 'true';
  const product = getProduct(productId);

  if (!product) return sendApiError(res, 404, requestId, 'product_not_found', 'Producto no encontrado.');
  if (!consent) {
    return sendApiError(
      res,
      400,
      requestId,
      'consent_required',
      'Se requiere consentimiento para procesar la foto.'
    );
  }
  if (!(person instanceof File)) {
    return sendApiError(res, 400, requestId, 'photo_required', 'Falta la foto de cuerpo completo.');
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(person.type)) {
    return sendApiError(res, 415, requestId, 'invalid_photo_type', 'La foto debe ser PNG, JPEG o WebP.');
  }
  if (person.size > config.maxPhotoBytes) {
    return sendApiError(res, 413, requestId, 'photo_too_large', 'La foto supera el máximo permitido.');
  }
  if (!product.sizes.includes(size)) {
    return sendApiError(res, 400, requestId, 'invalid_size', 'El talle no corresponde al producto.');
  }
  if (clientRecommendedSize && !product.sizes.includes(clientRecommendedSize)) {
    return sendApiError(
      res,
      400,
      requestId,
      'invalid_recommended_size',
      'El talle recomendado no corresponde al producto.'
    );
  }
  if (consentVersion.length > 128) {
    return sendApiError(
      res,
      400,
      requestId,
      'invalid_consent_version',
      'La versión del consentimiento no es válida.'
    );
  }

  let recommendedSize;
  let shopperMetrics;
  if (product.articleType === 'clothing') {
    const heightCm = Number(form.get('heightCm'));
    const weightKg = Number(form.get('weightKg'));
    if (!Number.isFinite(heightCm) || heightCm < 135 || heightCm > 220
      || !Number.isFinite(weightKg) || weightKg < 35 || weightKg > 180) {
      return sendApiError(
        res,
        400,
        requestId,
        'invalid_metrics',
        'Ingresá una altura y un peso válidos para generar la prueba virtual.'
      );
    }
    shopperMetrics = { heightCm, weightKg };
    try {
      recommendedSize = recommendSize(product, shopperMetrics).size;
    } catch {
      return sendApiError(
        res,
        400,
        requestId,
        'invalid_metrics',
        'No se pudo calcular el talle con los datos enviados.'
      );
    }
  }

  if (state.activeTryOns >= config.maxConcurrentTryOns) {
    res.setHeader('Retry-After', '1');
    return sendApiError(
      res,
      503,
      requestId,
      'concurrency_limit',
      'El servicio está procesando el máximo de pruebas simultáneas.'
    );
  }

  state.activeTryOns += 1;
  try {
    const garmentAsset = product.garmentAssetsBySize?.[size] || product.garmentAsset;
    const garmentBytes = await readFile(join(publicRoot, 'assets', garmentAsset));
    const garment = new File([garmentBytes], garmentAsset, { type: 'image/png' });
    const result = await dependencies.generateOpenAIVirtualTryOn({
      person,
      garment,
      product,
      size,
      recommendedSize,
      shopperMetrics
    });
    return sendJson(res, 200, {
      requestId,
      productId,
      size,
      targetFit: product.targetFit,
      imageUrl: result.imageUrl
    });
  } catch (error) {
    console.error(`[try-on:${requestId}] proveedor no disponible`, error);
    const status = error?.status === 504 ? 504 : 503;
    const message = status === 504
      ? 'La generación demoró más de lo permitido. Intentá nuevamente.'
      : 'La prueba virtual no está disponible en este momento.';
    return sendApiError(
      res,
      status,
      requestId,
      status === 504 ? 'provider_timeout' : 'provider_unavailable',
      message
    );
  } finally {
    state.activeTryOns -= 1;
  }
}

function decodePathComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PublicHttpError(400, 'La ruta solicitada no es válida.', { code: 'invalid_path' });
  }
}

async function serveStatic(pathname, res) {
  const decodedPath = decodePathComponent(pathname);
  if (decodedPath.includes('\0')) throw new PublicHttpError(400, 'La ruta solicitada no es válida.');
  let relativePath = decodedPath.replace(/^\/+/, '');
  if (!relativePath || decodedPath.endsWith('/')) relativePath = `${relativePath}index.html`;

  const filePath = resolve(publicRoot, relativePath);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    throw new PublicHttpError(403, 'Acceso denegado.');
  }

  try {
    const canonicalFile = await realpath(filePath);
    if (canonicalFile !== canonicalPublicRoot && !canonicalFile.startsWith(`${canonicalPublicRoot}${sep}`)) {
      throw new PublicHttpError(403, 'Acceso denegado.', { code: 'access_denied' });
    }
    const file = await readFile(canonicalFile);
    const extension = extname(filePath).toLowerCase();
    const headers = {
      'Cache-Control': 'no-cache',
      'Content-Type': mimeTypes[extension] || 'application/octet-stream'
    };
    if (extension === '.html') {
      headers['Content-Security-Policy'] = "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'self'; img-src 'self' data: blob:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    }
    return send(res, 200, file, headers);
  } catch (error) {
    if (error instanceof PublicHttpError) throw error;
    return send(res, 404, 'Not found', {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8'
    });
  }
}

function parseRequestUrl(req) {
  try {
    return new URL(req.url || '/', 'http://localhost');
  } catch {
    throw new PublicHttpError(400, 'La URL solicitada no es válida.', { code: 'invalid_url' });
  }
}

async function dispatchRequest(req, res, state) {
  const url = parseRequestUrl(req);
  const pathname = url.pathname;
  const api = pathname.startsWith('/api/');
  const requestId = api ? (res.tryRequestId || randomUUID()) : null;
  res.tryApi = api;
  res.tryRequestId = requestId;
  setBaseHeaders(res, { api });
  if (requestId) res.setHeader('X-Request-Id', requestId);
  decodePathComponent(pathname);

  if (!applyCors(req, res, state.config, { api })) {
    closeIfBodyUnread(req, res);
    return sendApiError(res, 403, requestId, 'origin_not_allowed', 'Origen no autorizado.');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '600');
    return send(res, 204, '');
  }
  if (req.method === 'GET' && pathname === '/api/health') {
    const provider = state.dependencies.getOpenAIProviderInfo();
    return sendJson(res, 200, {
      ok: true,
      service: 'TRY API',
      capabilities: { tryOn: { available: Boolean(provider.configured) } }
    });
  }
  if (req.method === 'GET' && pathname === '/api/v1/products') {
    return sendJson(res, 200, listProducts().map(toPublicProduct));
  }
  if (req.method === 'GET' && pathname.startsWith('/api/v1/products/')) {
    const productId = decodePathComponent(pathname.slice('/api/v1/products/'.length));
    const product = getProduct(productId);
    return product
      ? sendJson(res, 200, toPublicProduct(product))
      : sendApiError(res, 404, requestId, 'product_not_found', 'Producto no encontrado.');
  }
  if (req.method === 'POST' && pathname === '/api/v1/recommendation') {
    return handleRecommendation(req, res, state.config, requestId);
  }
  if (req.method === 'POST' && pathname === '/api/v1/try-on') {
    const rateLimit = state.rateLimiter.consume(req);
    setRateLimitHeaders(res, rateLimit, state.config);
    if (rateLimit && !rateLimit.allowed) {
      res.setHeader('Retry-After', rateLimit.resetSeconds);
      closeIfBodyUnread(req, res);
      return sendApiError(
        res,
        429,
        requestId,
        'rate_limited',
        'Se alcanzó el límite temporal de pruebas virtuales.'
      );
    }
    return handleTryOn(req, res, state, requestId);
  }
  if (api) {
    closeIfBodyUnread(req, res);
    const notFound = req.method === 'GET';
    return sendApiError(
      res,
      notFound ? 404 : 405,
      requestId,
      notFound ? 'route_not_found' : 'method_not_allowed',
      notFound ? 'Ruta no encontrada.' : 'Método no permitido.'
    );
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(pathname, res);
  closeIfBodyUnread(req, res);
  return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
}

function handleUnexpectedError(req, res, error) {
  if (res.writableEnded) return;
  const api = res.tryApi ?? String(req.url || '').startsWith('/api/');
  const requestId = res.tryRequestId || randomUUID();
  if (error instanceof PublicHttpError) {
    if (error.closeConnection) closeAfterResponse(req, res);
    if (api) {
      setBaseHeaders(res, { api: true });
      res.setHeader('X-Request-Id', requestId);
      return sendApiError(res, error.status, requestId, error.code, error.publicMessage);
    }
    setBaseHeaders(res);
    return publicError(res, error);
  }

  console.error(`[request:${requestId}] error no controlado`, error);
  if (res.headersSent) return res.destroy();
  setBaseHeaders(res, { api });
  if (api) {
    res.setHeader('X-Request-Id', requestId);
    return sendApiError(res, 500, requestId, 'internal_error', 'No se pudo procesar la solicitud.');
  }
  return sendJson(res, 500, { error: 'No se pudo procesar la solicitud.' });
}

export function createTryServer({ env = process.env, dependencies = {} } = {}) {
  const config = loadConfig(env);
  const state = {
    activeTryOns: 0,
    config,
    dependencies: {
      generateOpenAIVirtualTryOn,
      getOpenAIProviderInfo,
      ...dependencies
    },
    rateLimiter: null
  };
  state.rateLimiter = createRateLimiter(config);

  return createServer((req, res) => {
    Promise.resolve(dispatchRequest(req, res, state)).catch((error) => {
      handleUnexpectedError(req, res, error);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(serverFile)) {
  const config = loadConfig();
  const server = createTryServer();
  server.listen(config.port, config.host, () => {
    const provider = getOpenAIProviderInfo();
    console.log(`TRY Platform: http://${config.host}:${config.port}`);
    console.log(`IA: ${provider.id}/${provider.model || 'sin modelo'} (${provider.configured ? 'configurada' : 'falta configuración'})`);
  });
}
