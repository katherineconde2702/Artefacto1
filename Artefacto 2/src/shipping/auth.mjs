const fail = (code, status) => Object.assign(new Error(code), { code, status, statusCode: status });

export async function verifyAdminToken({ token, merchantId, url, publishableKey, repository, fetchImpl = globalThis.fetch } = {}) {
  if (!token || typeof token !== 'string' || /[\r\n]/.test(token)) throw fail('admin_unauthorized', 401);
  let base;
  try { base = new URL(url); } catch { throw fail('shipping_unconfigured', 503); }
  if (base.protocol !== 'https:' || !publishableKey || !repository?.adminContext) throw fail('shipping_unconfigured', 503);
  let response;
  try { response = await fetchImpl(`${base.origin}/auth/v1/user`, { headers: { apikey: publishableKey, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }); }
  catch { throw fail('auth_unavailable', 503); }
  if (!response.ok) throw fail(response.status >= 500 ? 'auth_unavailable' : 'admin_unauthorized', response.status >= 500 ? 503 : 401);
  let user;
  try { user = await response.json(); } catch { throw fail('admin_unauthorized', 401); }
  if (!user?.id || typeof user.id !== 'string') throw fail('admin_unauthorized', 401);
  const context = await repository.adminContext(user.id, merchantId);
  if (!context || context.userId !== user.id || context.merchantId !== merchantId || !['admin', 'owner'].includes(context.role)) throw fail('admin_forbidden', 403);
  return context;
}
