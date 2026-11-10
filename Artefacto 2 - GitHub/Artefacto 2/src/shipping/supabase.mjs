function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status, statusCode: status });
}

export function createSupabaseRepository({ url, secretKey, fetchImpl = globalThis.fetch } = {}) {
  let base;
  try { base = new URL(url); } catch { throw failure('shipping_unconfigured'); }
  if (base.protocol !== 'https:' || !secretKey || typeof fetchImpl !== 'function') throw failure('shipping_unconfigured');
  base = base.origin;
  async function rpc(name, payload) {
    let response;
    try {
      response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: secretKey, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    } catch { throw failure('shipping_unavailable'); }
    if (!response.ok) {
      let details;
      try { details = await response.json(); } catch { /* Never expose raw upstream text. */ }
      const status = ({ PT400: 400, PT401: 401, PT403: 403, PT404: 404, PT409: 409, PT410: 410, PT422: 422 })[details?.code];
      throw failure(status ? `shipping_${status}` : 'shipping_unavailable', status || 503);
    }
    try { return await response.json(); } catch { throw failure('shipping_unavailable'); }
  }
  return {
    snapshot: (merchantId, mode) => rpc('shipping_snapshot', { p_merchant_id: merchantId, p_mode: mode }),
    mutate: (operation, payload) => rpc('shipping_mutate', { p_operation: operation, p_payload: payload }),
    adminContext: (userId, merchantId) => rpc('shipping_admin_context', { p_user_id: userId, p_merchant_id: merchantId }),
  };
}
