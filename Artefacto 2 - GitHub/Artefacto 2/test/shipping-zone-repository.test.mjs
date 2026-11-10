import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../src/shipping/memory.mjs';

const scope = { merchantId: 'marea', mode: 'demo' };
const admin = { ...scope, actorId: 'demo-admin' };
const initial = () => ({
  merchant: { id: 'marea' },
  policy: { version: 1, minimumMinor: 14900, holdMinutes: 15 },
  prices: {}, areas: [{ id: 'centro', name: 'Centro', departmentId: 'montevideo', kind: 'neighborhood' }, { id: 'dept-canelones', name: 'Canelones', departmentId: 'canelones', kind: 'department' }],
  days: [{ deliveryDate: '2099-01-01', enabled: true, capacity: 10, departureTime: '10:00', maxDurationSeconds: 14400, version: 1 }],
  routes: [], shipments: [], promotions: [],
});
const rate = { areaId: 'centro', priceMinor: 24900, enabled: true };

async function quote(repository, id, policyVersion = 1) {
  await repository.mutate('checkout_create', { ...scope, id: `c-${id}`, cart: [{ productId: 'sweater', quantity: 1 }], subtotalMinor: 279000, currency: 'UYU', expiresAt: '2099-01-02T00:00:00Z' });
  return repository.mutate('quote_create', { ...scope, id, checkoutId: `c-${id}`, routeId: null, routeVersion: 0, dayVersion: 1, policyVersion, deliveryDate: '2099-01-01', priceMinor: 24900, normalPriceMinor: 24900, safetyFloorMinor: 14900, currency: 'UYU', expiresAt: '2099-01-01T00:00:00Z', pricingMode: 'zones', address: { provider: 'zones', areaId: 'centro', placeId: 'zone:centro', inputAddress: 'Centro, Montevideo, Uruguay' }, candidateRoute: { deliveryDate: '2099-01-01', stops: [{ shipmentId: null, placeId: 'zone:centro' }] } });
}
const reservation = id => ({ ...scope, checkoutId: `c-${id}`, quoteId: id, expectedVersion: 0, idempotencyKey: id, bodyHash: `body-${id}` });

// Removing the operation from the admin guard must let an unauthorized edit
// reach the rate state and make these refusals fail.
test('zone tariffs require the verified demo administrator and merchant scope', async () => {
  const repository = createMemoryRepository(initial());
  for (const actorId of [undefined, 'checkout-buyer', 'other-admin']) {
    await assert.rejects(repository.mutate('zone_rate_save', { ...scope, ...rate, actorId, serverAuthorized: true }), { code: 'admin_forbidden', status: 403 });
  }
  await assert.rejects(repository.mutate('zone_rate_save', { ...admin, ...rate, merchantId: 'other' }), { status: 404 });
  await assert.rejects(repository.mutate('zone_rate_save', { ...admin, ...rate, mode: 'live' }), { status: 503 });
  assert.deepEqual((await repository.snapshot('marea', 'demo')).zoneRates, []);
});

// Each literal catches a missing type, range, catalog or minimum validation.
for (const [label, invalid] of [
  ['unknown zone', { areaId: 'invented' }], ['missing zone', { areaId: undefined }],
  ['zero', { priceMinor: 0 }], ['negative', { priceMinor: -1 }],
  ['fraction', { priceMinor: 14900.5 }], ['string amount', { priceMinor: '24900' }],
  ['above maximum', { priceMinor: 1000000001 }], ['below minimum', { priceMinor: 14899 }],
  ['missing enabled', { enabled: undefined }], ['string enabled', { enabled: 'true' }],
]) {
  test(`direct zone tariff write rejects ${label} without changing policy or history`, async () => {
    const repository = createMemoryRepository(initial());
    const before = await repository.snapshot('marea', 'demo');
    await assert.rejects(repository.mutate('zone_rate_save', { ...admin, ...rate, ...invalid }), { code: 'zone_rate_invalid', status: 400 });
    assert.deepEqual(await repository.snapshot('marea', 'demo'), before);
  });
}

test('zone tariff saves version the individual zone and global policy with bounded amounts', async () => {
  const repository = createMemoryRepository(initial());
  assert.deepEqual(await repository.mutate('zone_rate_save', { ...admin, ...rate, priceMinor: 14900 }), { areaId: 'centro', priceMinor: 14900, enabled: true, version: 1 });
  assert.deepEqual(await repository.mutate('zone_rate_save', { ...admin, ...rate, priceMinor: 1000000000, enabled: false }), { areaId: 'centro', priceMinor: 1000000000, enabled: false, version: 2 });
  await repository.mutate('zone_rate_save', { ...admin, areaId: 'dept-canelones', priceMinor: 39900, enabled: true });
  const state = await repository.snapshot('marea', 'demo');
  assert.equal(state.policy.version, 4);
  assert.equal(state.policy.minimumMinor, 14900);
  assert.deepEqual(state.zoneRates, [{ areaId: 'centro', priceMinor: 1000000000, enabled: false, version: 2 }, { areaId: 'dept-canelones', priceMinor: 39900, enabled: true, version: 1 }]);
});

test('zone tariff checks the current minimum after a policy edit even when disabled', async () => {
  const repository = createMemoryRepository(initial());
  await repository.mutate('settings_save', { ...admin, policy: { minimumMinor: 29900 } });
  await assert.rejects(repository.mutate('zone_rate_save', { ...admin, ...rate, enabled: false }), { code: 'zone_rate_invalid', status: 400 });
  assert.deepEqual(await repository.mutate('zone_rate_save', { ...admin, ...rate, priceMinor: 29900 }), { areaId: 'centro', priceMinor: 29900, enabled: true, version: 1 });
});

test('zone tariff edits invalidate outstanding reservations before any route is created', async () => {
  const repository = createMemoryRepository(initial());
  await quote(repository, 'stale');
  await repository.mutate('zone_rate_save', { ...admin, ...rate });
  await assert.rejects(repository.mutate('reserve', reservation('stale')), { code: 'policy_changed', status: 409 });
  const state = await repository.snapshot('marea', 'demo');
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.shipments, []);
});

test('accepted reservation replays and confirms its original price after tariff and minimum edits', async () => {
  const repository = createMemoryRepository(initial());
  await quote(repository, 'accepted');
  const payload = reservation('accepted');
  const accepted = await repository.mutate('reserve', payload);
  await repository.mutate('zone_rate_save', { ...admin, ...rate, priceMinor: 39900 });
  await repository.mutate('settings_save', { ...admin, policy: { minimumMinor: 49900 } });
  assert.deepEqual(await repository.mutate('reserve', payload), accepted);
  const confirmed = await repository.mutate('demo_confirm', { ...scope, checkoutId: 'c-accepted', shipmentId: accepted.id });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.priceMinor, 24900);
  await assert.rejects(repository.mutate('reserve', { ...payload, bodyHash: 'changed' }), { code: 'idempotency_conflict', status: 409 });
  const history = (await repository.snapshot('marea', 'demo')).auditEvents;
  assert.equal(history.filter(row => row.operation === 'reserve').length, 1);
});

test('external accepted conditions replay before tariff version checks', async () => {
  const repository = createMemoryRepository(initial());
  const payload = { ...admin, idempotencyKey: 'external', bodyHash: 'body', routeId: null, expectedVersion: 0, expectedPolicyVersion: 1, expectedDayVersion: 1, candidateRoute: { deliveryDate: '2099-01-01', stops: [{ shipmentId: null, placeId: 'zone:centro' }] }, shipment: { externalOrderRef: 'order-1', priceMinor: 24900, deliveryDate: '2099-01-01', address: { provider: 'zones', areaId: 'centro', placeId: 'zone:centro' } } };
  const accepted = await repository.mutate('external_create', payload);
  await repository.mutate('zone_rate_save', { ...admin, ...rate, enabled: false });
  assert.deepEqual(await repository.mutate('external_create', payload), accepted);
  assert.deepEqual(await repository.mutate('external_replay', payload), accepted);
  await assert.rejects(repository.mutate('external_create', { ...payload, idempotencyKey: 'stale-new', bodyHash: 'new', shipment: { ...payload.shipment, externalOrderRef: 'order-2' } }), { code: 'policy_changed', status: 409 });
});

test('zone audit records only business values and preserves the canonical area identity', async () => {
  const repository = createMemoryRepository(initial());
  const extra = { inputAddress: 'Private doorstep', address: { customerName: 'Private buyer' }, actor: 'forged', version: 100 };
  await repository.mutate('zone_rate_save', { ...admin, ...rate, ...extra });
  await repository.mutate('zone_rate_save', { ...admin, ...rate, priceMinor: 29900, enabled: false, ...extra });
  const state = await repository.snapshot('marea', 'demo');
  const latest = state.auditEvents[0];
  assert.equal(latest.actor, 'demo-admin');
  assert.equal(latest.entityType, 'zone_rate');
  assert.equal(latest.entityId, 'centro');
  assert.deepEqual(latest.changes, { before: { priceMinor: 24900, enabled: true }, after: { priceMinor: 29900, enabled: false } });
  assert.deepEqual(state.auditEvents[1].changes, { before: {}, after: { priceMinor: 24900, enabled: true } });
  assert.equal(JSON.stringify(state.auditEvents).includes('Private'), false);
  assert.deepEqual(state.zoneRates, [{ areaId: 'centro', priceMinor: 29900, enabled: false, version: 2 }]);
  state.zoneRates[0].priceMinor = 1;
  assert.equal((await repository.snapshot('marea', 'demo')).zoneRates[0].priceMinor, 29900);
});
