import test from 'node:test';
import assert from 'node:assert/strict';

test('admin identity comes from Auth and verified membership', async () => {
  const { verifyAdminToken } = await import('../src/shipping/auth.mjs');
  const context = await verifyAdminToken({ token: 'user-access-token', merchantId: 'marea', url: 'https://project.supabase.co', publishableKey: 'sb_publishable_test', repository: { adminContext: async (userId, merchantId) => { assert.equal(userId, 'user-1'); assert.equal(merchantId, 'marea'); return { userId, merchantId, role: 'admin' }; } }, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://project.supabase.co/auth/v1/user');
    assert.equal(init.headers.apikey, 'sb_publishable_test');
    assert.equal(init.headers.Authorization, 'Bearer user-access-token');
    return Response.json({ id: 'user-1', role: 'authenticated' });
  } });
  assert.deepEqual(context, { userId: 'user-1', merchantId: 'marea', role: 'admin' });
});

test('invalid tokens and cross-merchant membership fail closed', async () => {
  const { verifyAdminToken } = await import('../src/shipping/auth.mjs');
  const options = { token: 'invalid', merchantId: 'marea', url: 'https://project.supabase.co', publishableKey: 'sb_publishable_test', repository: { adminContext: async () => ({ userId: 'u1', merchantId: 'other', role: 'admin' }) } };
  await assert.rejects(verifyAdminToken({ ...options, fetchImpl: async () => new Response('', { status: 401 }) }), { status: 401 });
  await assert.rejects(verifyAdminToken({ ...options, fetchImpl: async () => Response.json({ id: 'u1' }) }), { status: 403 });
});

test('Auth outages redact tokens and a valid user without membership is forbidden', async () => {
  const { verifyAdminToken } = await import('../src/shipping/auth.mjs');
  const options = { token: 'private-user-token', merchantId: 'marea', url: 'https://project.supabase.co', publishableKey: 'sb_publishable_test', repository: { adminContext: async () => null } };
  await assert.rejects(verifyAdminToken({ ...options, fetchImpl: async () => { throw new Error('private-user-token'); } }), error => error.status === 503 && !String(error).includes('private-user-token'));
  await assert.rejects(verifyAdminToken({ ...options, fetchImpl: async () => Response.json({ id: 'u1' }) }), { status: 403 });
  await assert.rejects(verifyAdminToken({ ...options, token: '' }), { status: 401 });
});
