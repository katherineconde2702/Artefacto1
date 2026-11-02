import test from 'node:test';
import assert from 'node:assert/strict';

// These boundary tests catch credential forwarding, false success, and missing
// transactional checks. HTTP is the only external dependency replaced here.
test('Supabase RPC uses secret only as apikey and isolates mode', async () => {
  const { createSupabaseRepository } = await import('../src/shipping/supabase.mjs');
  const repository = createSupabaseRepository({ url: 'https://project.supabase.co', secretKey: 'sb_secret_test', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://project.supabase.co/rest/v1/rpc/shipping_snapshot');
    assert.equal(init.headers.apikey, 'sb_secret_test');
    assert.equal(init.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(init.body), { p_merchant_id: 'marea', p_mode: 'demo' });
    return Response.json({ merchant: { id: 'marea' } });
  } });
  assert.deepEqual(await repository.snapshot('marea', 'demo'), { merchant: { id: 'marea' } });
});

test('Supabase rejects configuration and redacts upstream failures', async () => {
  const { createSupabaseRepository } = await import('../src/shipping/supabase.mjs');
  assert.throws(() => createSupabaseRepository({}), { code: 'shipping_unconfigured', status: 503 });
  const repository = createSupabaseRepository({ url: 'https://project.supabase.co', secretKey: 'sb_secret_test', fetchImpl: async () => new Response('sb_secret_test private address', { status: 500 }) });
  await assert.rejects(repository.mutate('reserve', { merchantId: 'marea', mode: 'demo' }), error => error.status === 503 && !String(error).includes('sb_secret_test'));
});

test('Supabase mutation and membership RPCs preserve server contracts and conflict status', async () => {
  const { createSupabaseRepository } = await import('../src/shipping/supabase.mjs');
  const repository = createSupabaseRepository({ url: 'https://project.supabase.co', secretKey: 'sb_secret_test', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/shipping_mutate')) {
      assert.deepEqual(body, { p_operation: 'reserve', p_payload: { merchantId: 'marea', mode: 'live', quoteId: 'q1' } });
      return Response.json({ code: 'PT409', message: 'private detail' }, { status: 409 });
    }
    assert.equal(url, 'https://project.supabase.co/rest/v1/rpc/shipping_admin_context');
    assert.deepEqual(body, { p_user_id: 'u1', p_merchant_id: 'marea' });
    return Response.json({ userId: 'u1', merchantId: 'marea', role: 'owner' });
  } });
  await assert.rejects(repository.mutate('reserve', { merchantId: 'marea', mode: 'live', quoteId: 'q1' }), { status: 409 });
  assert.deepEqual(await repository.adminContext('u1', 'marea'), { userId: 'u1', merchantId: 'marea', role: 'owner' });
});

const initial = () => ({ merchant: { id: 'marea' }, policy: { holdMinutes: 15 }, prices: {}, areas: [], days: [{ deliveryDate: '2099-01-01', enabled: true, capacity: 1, departureTime: '10:00', maxDurationSeconds: 14400 }], routes: [{ id: 'r1', deliveryDate: '2099-01-01', capacity: 1, version: 0, stops: [] }], shipments: [], promotions: [] });
async function prepared(repository, id = 'q1') {
  await repository.mutate('checkout_create', { merchantId: 'marea', mode: 'demo', id: `c-${id}`, cart: [{ productId: 'sweater', quantity: 1 }], subtotalMinor: 279000, currency: 'UYU', expiresAt: '2099-01-01T00:00:00Z' });
  return repository.mutate('quote_create', { merchantId: 'marea', mode: 'demo', id, checkoutId: `c-${id}`, routeId: 'r1', routeVersion: 0, deliveryDate: '2099-01-01', priceMinor: 14900, normalPriceMinor: 15900, safetyFloorMinor: 14900, currency: 'UYU', expiresAt: '2099-01-01T00:00:00Z', address: { placeId: 'demo-a', confirmed: true }, candidateRoute: { id: 'r1', stops: [{ shipmentId: null, placeId: 'demo-a', status: 'held' }] } });
}

test('demo reservation is atomic, idempotent and keeps accepted price', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const repository = createMemoryRepository(initial());
  await prepared(repository);
  await prepared(repository, 'q2');
  const payload = { merchantId: 'marea', mode: 'demo', checkoutId: 'c-q1', quoteId: 'q1', expectedVersion: 0, idempotencyKey: 'retry-1', bodyHash: 'hash-1' };
  const held = await repository.mutate('reserve', payload);
  assert.equal(held.status, 'held');
  assert.equal(held.priceMinor, 14900);
  assert.deepEqual(await repository.mutate('reserve', payload), held);
  await assert.rejects(repository.mutate('reserve', { ...payload, bodyHash: 'changed' }), { status: 409 });
  await assert.rejects(repository.mutate('reserve', { ...payload, checkoutId: 'c-q2', quoteId: 'q2', idempotencyKey: 'retry-2' }), { status: 409 });
  assert.equal((await repository.snapshot('marea', 'demo')).shipments.length, 1);
  await repository.mutate('settings_save', { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', policy: { minimumMinor: 99900 } });
  const confirmed = await repository.mutate('demo_confirm', { merchantId: 'marea', mode: 'demo', shipmentId: held.id, checkoutId: 'c-q1' });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.priceMinor, 14900);
  assert.equal(confirmed.demo, true);
  await repository.mutate('cancel', { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', shipmentId: held.id, reason: 'Cambio solicitado' });
  assert.equal((await repository.snapshot('marea', 'demo')).routes[0].stops.length, 0);
});

test('memory requires explicit demo and admin actor', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const repository = createMemoryRepository(initial());
  await assert.rejects(repository.snapshot('marea', 'live'), { status: 503 });
  await assert.rejects(repository.snapshot('other', 'demo'), { status: 404 });
  await assert.rejects(repository.mutate('settings_save', { merchantId: 'marea', mode: 'demo', policy: {} }), { status: 403 });
});

test('expired hold never confirms and snapshots release its stop', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const repository = createMemoryRepository(initial());
  await prepared(repository);
  const held = await repository.mutate('reserve', { merchantId: 'marea', mode: 'demo', checkoutId: 'c-q1', quoteId: 'q1', expectedVersion: 0, idempotencyKey: 'expiry', bodyHash: 'expiry' });
  const realNow = Date.now;
  Date.now = () => Date.parse(held.expiresAt) + 1;
  try {
    await assert.rejects(repository.mutate('demo_confirm', { merchantId: 'marea', mode: 'demo', checkoutId: 'c-q1', shipmentId: held.id }), { status: 410 });
    const state = await repository.snapshot('marea', 'demo');
    assert.equal(state.shipments[0].status, 'expired');
    assert.equal(state.routes[0].stops.length, 0);
  } finally { Date.now = realNow; }
});

test('settings reject negative money without altering state', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const repository = createMemoryRepository(initial());
  await assert.rejects(repository.mutate('settings_save', { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', policy: { minimumMinor: -1 } }), { status: 400 });
  assert.equal((await repository.snapshot('marea', 'demo')).policy.minimumMinor, undefined);
});

test('new route is coordinated per service day and mode', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const seed = initial(); seed.routes = [];
  const repository = createMemoryRepository(seed);
  await prepared(repository);
  // Persist a quote against a new route, as emitted by the engine.
  await repository.mutate('quote_create', { merchantId: 'marea', mode: 'demo', id: 'q-new', checkoutId: 'c-q1', routeId: null, routeVersion: 0, deliveryDate: '2099-01-01', priceMinor: 14900, currency: 'UYU', expiresAt: '2099-01-01T00:00:00Z', address: { placeId: 'demo-a' }, candidateRoute: { stops: [] } });
  const held = await repository.mutate('reserve', { merchantId: 'marea', mode: 'demo', checkoutId: 'c-q1', quoteId: 'q-new', expectedVersion: 0, idempotencyKey: 'new', bodyHash: 'new' });
  const state = await repository.snapshot('marea', 'demo');
  assert.equal(state.routes.length, 1);
  assert.equal(state.routes[0].id, held.routeId);
  assert.equal(state.routes[0].version, 1);
});

test('accepted route preserves the quoted insertion order and omits temporary Google content', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const seed = initial(); seed.days[0].capacity = 3; seed.routes[0].capacity = 3;
  seed.routes[0].stops = [{ shipmentId: 'existing', placeId: 'demo-b', status: 'confirmed', priceMinor: 14900 }];
  const repository = createMemoryRepository(seed);
  await prepared(repository);
  await repository.mutate('quote_create', { merchantId: 'marea', mode: 'demo', id: 'q-order', checkoutId: 'c-q1', routeId: 'r1', routeVersion: 0, deliveryDate: '2099-01-01', priceMinor: 14900, currency: 'UYU', expiresAt: '2099-01-01T00:00:00Z', address: { placeId: 'demo-a', formattedAddress: 'Temporary Google output', inputAddress: 'Buyer input' }, candidateRoute: { stops: [{ shipmentId: null, placeId: 'demo-a', status: 'held' }, seed.routes[0].stops[0]] } });
  const held = await repository.mutate('reserve', { merchantId: 'marea', mode: 'demo', checkoutId: 'c-q1', quoteId: 'q-order', expectedVersion: 0, idempotencyKey: 'order', bodyHash: 'order' });
  const state = await repository.snapshot('marea', 'demo');
  assert.equal(state.routes[0].stops[0].shipmentId, held.id);
  assert.equal(held.address.formattedAddress, undefined);
  assert.equal(held.address.inputAddress, 'Buyer input');
});

test('verified merchant server can confirm while client actors remain forbidden', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const repository = createMemoryRepository(initial()); await prepared(repository);
  const held = await repository.mutate('reserve', { merchantId: 'marea', mode: 'demo', checkoutId: 'c-q1', quoteId: 'q1', expectedVersion: 0, idempotencyKey: 'merchant-confirm', bodyHash: 'merchant-confirm' });
  await assert.rejects(repository.mutate('confirm', { merchantId: 'marea', mode: 'demo', shipmentId: held.id }), { status: 403 });
  assert.equal((await repository.mutate('confirm', { merchantId: 'marea', mode: 'demo', shipmentId: held.id, serverAuthorized: true })).status, 'confirmed');
  await repository.mutate('confirm', { merchantId: 'marea', mode: 'demo', shipmentId: held.id, serverAuthorized: true });
  const history=(await repository.snapshot('marea','demo')).auditEvents;
  assert.equal(history.filter(event=>event.operation==='reserve').length,1);
  assert.equal(history.filter(event=>event.operation==='confirm').length,1);
  assert.equal(history[0].actor,'commerce-server');assert.equal(history[0].entityId,held.id);
  assert.deepEqual(history[0].changes,{before:{status:'held'},after:{status:'confirmed'}});
});

test('external delivery creates first route atomically and refuses stale policy', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const seed = initial(); seed.routes = []; seed.policy.version = 1;
  const repository = createMemoryRepository(seed);
  const payload = { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', idempotencyKey: 'external-key', bodyHash: 'external-hash', routeId: null, expectedVersion: 0, expectedPolicyVersion: 1, candidateRoute: { deliveryDate: '2099-01-01', departureAt: '2099-01-01T13:00:00Z', stops: [{ shipmentId: null, placeId: 'demo-a', status: 'held' }] }, shipment: { externalOrderRef: 'order-1', priceMinor: 14900, address: { placeId: 'demo-a' } } };
  await assert.rejects(repository.mutate('external_create', { ...payload, expectedPolicyVersion: 0 }), { status: 409 });
  assert.equal((await repository.snapshot('marea', 'demo')).routes.length, 0);
  const shipment = await repository.mutate('external_create', payload);
  assert.equal(shipment.status, 'confirmed');
  assert.equal((await repository.snapshot('marea', 'demo')).routes[0].stops[0].shipmentId, shipment.id);
});

test('external retries replay accepted conditions before stale planning and reject another body', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const seed = initial(); seed.routes = [];
  const repository = createMemoryRepository(seed);
  const payload = { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', idempotencyKey: 'external-retry', bodyHash: 'external-body', routeId: null, expectedVersion: 0, expectedDayVersion: 1, candidateRoute: { deliveryDate: '2099-01-01', departureAt: '2099-01-01T13:00:00Z', stops: [] }, shipment: { externalOrderRef: 'external-retry', priceMinor: 14900, address: { placeId: 'demo-a' } } };
  assert.equal(await repository.mutate('external_replay', payload), null);
  const result = await repository.mutate('external_create', payload);
  assert.deepEqual(await repository.mutate('external_create', payload), result);
  assert.deepEqual(await repository.mutate('external_replay', payload), result);
  await assert.rejects(repository.mutate('external_create', { ...payload, bodyHash: 'other-body' }), { code: 'idempotency_conflict', status: 409 });
  await assert.rejects(repository.mutate('external_replay', { ...payload, actorId: 'untrusted' }), { status: 403 });
  assert.equal((await repository.snapshot('marea', 'demo')).shipments.length, 1);
  const events=(await repository.snapshot('marea','demo')).auditEvents;
  assert.equal(events.length,1);assert.equal(events[0].operation,'external_create');assert.equal(events[0].entityId,result.id);
  assert.deepEqual(events[0].changes,{before:{},after:{status:'confirmed',priceMinor:14900}});
});

for (const existingRoute of [false, true]) {
  test(`service-day edits invalidate ${existingRoute ? 'existing' : 'first'} route quotes and in-flight planning`, async () => {
    const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
    const seed = initial(); if (!existingRoute) seed.routes = [];
    const repository = createMemoryRepository(seed);
    await prepared(repository);
    const stale = { merchantId: 'marea', mode: 'demo', id: 'day-q', checkoutId: 'c-q1', routeId: existingRoute ? 'r1' : null, routeVersion: 0, dayVersion: 1, deliveryDate: '2099-01-01', priceMinor: 14900, currency: 'UYU', expiresAt: '2099-01-01T00:00:00Z', address: { placeId: 'demo-a' }, candidateRoute: { deliveryDate: '2099-01-01', departureAt: '2099-01-01T13:00:00Z', stops: [{ shipmentId: null, placeId: 'demo-a' }] } };
    await repository.mutate('quote_create', stale);
    const day = await repository.mutate('service_day_save', { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', day: { ...seed.days[0], maxDurationSeconds: 60 } });
    assert.equal(day.version, 2);
    await assert.rejects(repository.mutate('reserve', { merchantId: 'marea', mode: 'demo', checkoutId: 'c-q1', quoteId: 'day-q', expectedVersion: 0, idempotencyKey: 'day', bodyHash: 'day' }), { code: 'service_day_changed', status: 409 });
    await assert.rejects(repository.mutate('quote_create', { ...stale, id: 'after-old-snapshot' }), { code: 'service_day_changed', status: 409 });
    await assert.rejects(repository.mutate('external_create', { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', idempotencyKey: 'external-key', bodyHash: 'external-hash', routeId: stale.routeId, expectedVersion: 0, expectedDayVersion: 1, candidateRoute: stale.candidateRoute, shipment: { externalOrderRef: 'stale-day', priceMinor: 14900, address: { placeId: 'demo-a' } } }), { code: 'service_day_changed', status: 409 });
    const state = await repository.snapshot('marea', 'demo');
    assert.equal(state.shipments.length, 0);
    assert.equal(state.routes.length, existingRoute ? 1 : 0);
  });
}

test('service-day departure edits reject assigned routes and update empty routes coherently', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const seed = initial(); seed.routes[0].departureAt = '2099-01-01T13:00:00Z';
  const repository = createMemoryRepository(seed);
  await repository.mutate('service_day_save', { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', day: { ...seed.days[0], departureTime: '11:00' } });
  assert.equal(Date.parse((await repository.snapshot('marea', 'demo')).routes[0].departureAt), Date.parse('2099-01-01T14:00:00Z'));
  const busy = initial(); busy.routes[0].stops.push({ shipmentId: 'assigned', status: 'confirmed' });
  const assignedRepository = createMemoryRepository(busy);
  await assert.rejects(assignedRepository.mutate('service_day_save', { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', day: { ...busy.days[0], departureTime: '11:00' } }), { status: 409 });
  assert.equal((await assignedRepository.snapshot('marea', 'demo')).days[0].departureTime, '10:00');
});

test('reserve and external_create reject departure crossed during the quote lifetime', async () => {
  const { createMemoryRepository } = await import('../src/shipping/memory.mjs');
  const repository = createMemoryRepository(initial());
  const realNow = Date.now; Date.now = () => Date.parse('2099-01-01T13:00:01Z');
  try {
    await assert.rejects(repository.mutate('external_create', { merchantId: 'marea', mode: 'demo', actorId: 'demo-admin', idempotencyKey: 'external-key', bodyHash: 'external-hash', routeId: 'r1', expectedVersion: 0, expectedDayVersion: 1, candidateRoute: { deliveryDate: '2099-01-01', departureAt: '2099-01-01T13:00:00Z', stops: [] }, shipment: { externalOrderRef: 'late', priceMinor: 14900, address: { placeId: 'demo-a' } } }), { code: 'route_departed', status: 409 });
  } finally { Date.now = realNow; }
  // Separate repository gives checkout an expiry after departure as well.
  const validCheckout = createMemoryRepository(initial());
  await validCheckout.mutate('checkout_create', { merchantId: 'marea', mode: 'demo', id: 'late-c', cart: [{}], subtotalMinor: 1, currency: 'UYU', expiresAt: '2099-01-02T00:00:00Z' });
  await validCheckout.mutate('quote_create', { merchantId: 'marea', mode: 'demo', id: 'late-q', checkoutId: 'late-c', routeId: 'r1', routeVersion: 0, dayVersion: 1, deliveryDate: '2099-01-01', priceMinor: 14900, currency: 'UYU', expiresAt: '2099-01-01T13:04:00Z', address: { placeId: 'demo-a' } });
  Date.now = () => Date.parse('2099-01-01T13:00:01Z');
  try {
    await assert.rejects(validCheckout.mutate('reserve', { merchantId: 'marea', mode: 'demo', checkoutId: 'late-c', quoteId: 'late-q', expectedVersion: 0, idempotencyKey: 'late', bodyHash: 'late' }), { code: 'route_departed', status: 409 });
    assert.equal((await validCheckout.snapshot('marea', 'demo')).shipments.length, 0);
  } finally { Date.now = realNow; }
});
