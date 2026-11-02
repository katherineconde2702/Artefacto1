import { randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status, statusCode: status }); };
const adminOperations = new Set(['confirm', 'cancel', 'settings_save', 'promotion_save', 'service_day_save', 'price_save', 'zone_rate_save', 'external_create', 'external_replay']);
const money = amount => Number.isSafeInteger(amount) && amount > 0;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const auditFields = {
  rate_policy: ['minimumMinor','fuelPriceMinorPerLiter','fuelLitersPer100Km','laborMinorPerHour','serviceMinutes','marginBps','roundingMinor','quoteMinutes','holdMinutes'],
  product_price: ['priceMinor'], zone_rate: ['priceMinor','enabled'], promotion: ['areaId','deliveryDate','priceMinor','active'],
  service_day: ['deliveryDate','departureTime','capacity','maxDurationSeconds','enabled'],
  shipment: ['status','priceMinor','deliveryDate'],
};
const acceptedAddress = address => {
  if (!address) return undefined;
  const { formattedAddress, geometry, ...accepted } = address;
  return accepted;
};

// Deliberately transient and demo-only. This repository does not emulate RLS.
export function createMemoryRepository(initialState) {
  let state = clone(initialState);
  state.mode = 'demo';
  state.shipments ||= [];
  state.routes ||= [];
  state.promotions ||= [];
  state.zoneRates ||= [];
  state.auditEvents ||= [];
  state.days = (state.days || []).map(day => ({ ...day, version: day.version ?? 1 }));
  const checkouts = new Map(), quotes = new Map(), replays = new Map();
  function scope(merchantId, mode) {
    if (mode !== 'demo') fail('demo_repository_only', 503);
    if (merchantId !== state.merchant.id) fail('merchant_not_found', 404);
  }
  function releaseExpired(next) {
    for (const shipment of next.shipments) {
      if (shipment.status === 'held' && Date.parse(shipment.expiresAt) <= Date.now()) {
        shipment.status = 'expired';
        const route = next.routes.find(route => route.id === shipment.routeId);
        if (route) { route.stops = route.stops.filter(stop => stop.shipmentId !== shipment.id); route.version++; }
      }
    }
  }
  return {
    async snapshot(merchantId, mode) { scope(merchantId, mode); releaseExpired(state); return clone(state); },
    async adminContext(userId, merchantId) {
      return merchantId === state.merchant.id && userId === 'demo-admin' ? { userId, merchantId, role: 'admin' } : null;
    },
    async mutate(operation, payload) {
      scope(payload.merchantId, payload.mode);
      if (adminOperations.has(operation) && payload.actorId !== 'demo-admin' && !(operation === 'confirm' && payload.serverAuthorized === true)) fail('admin_forbidden', 403);
      const externalKey = `${payload.merchantId}:demo:external_create:${payload.idempotencyKey}`;
      if (['external_create', 'external_replay'].includes(operation)) {
        if (!payload.idempotencyKey || !payload.bodyHash) fail('idempotency_required', 400);
        const previous = replays.get(externalKey);
        if (previous && previous.bodyHash !== payload.bodyHash) fail('idempotency_conflict');
        if (previous || operation === 'external_replay') return previous ? clone(previous.result) : null;
      }
      const next = clone(state);
      releaseExpired(next);
      let result, audit;
      const record = (entityType, entityId, before, after, fields = auditFields[entityType]) => {
        audit = { id:randomUUID(), merchantId:payload.merchantId, mode:'demo', actor:payload.serverAuthorized === true && operation === 'confirm' ? 'commerce-server' : payload.actorId || (operation === 'demo_confirm' ? 'demo-buyer' : 'checkout-buyer'), operation, entityType, entityId, createdAt:new Date().toISOString(), changes:{before:pick(before,fields),after:pick(after,fields)} };
      };
      if (operation === 'checkout_create') {
        if (payload.currency !== 'UYU' || !money(payload.subtotalMinor) || !Array.isArray(payload.cart) || !payload.cart.length || Date.parse(payload.expiresAt) <= Date.now()) fail('checkout_invalid', 400);
        result = { ...clone(payload), id: payload.id || randomUUID() };
        if (checkouts.has(result.id)) fail('checkout_exists');
        checkouts.set(result.id, result);
      } else if (operation === 'quote_create') {
        const checkout = checkouts.get(payload.checkoutId);
        if (!checkout || Date.parse(checkout.expiresAt) <= Date.now()) fail('checkout_expired', 410);
        if (!money(payload.priceMinor) || payload.currency !== 'UYU' || Date.parse(payload.expiresAt) <= Date.now() || payload.priceMinor < (payload.safetyFloorMinor || 1)) fail('quote_invalid', 400);
        const day = next.days.find(day => day.deliveryDate === payload.deliveryDate && day.enabled);
        if (!day || (payload.dayVersion ?? 1) !== day.version) fail('service_day_changed');
        result = { ...clone(payload), dayVersion: payload.dayVersion ?? 1, id: payload.id || randomUUID() };
        if (quotes.has(result.id)) fail('quote_exists');
        quotes.set(result.id, result);
      } else if (operation === 'reserve') {
        if (!payload.idempotencyKey || !payload.bodyHash) fail('idempotency_required', 400);
        const key = `${payload.merchantId}:demo:reserve:${payload.idempotencyKey}`;
        const previous = replays.get(key);
        if (previous) {
          if (previous.bodyHash !== payload.bodyHash) fail('idempotency_conflict');
          return clone(previous.result);
        }
        const quote = quotes.get(payload.quoteId), checkout = checkouts.get(payload.checkoutId);
        if (!quote || !checkout || quote.checkoutId !== checkout.id) fail('quote_not_found', 404);
        if (quote.policyVersion !== undefined && quote.policyVersion !== next.policy.version) fail('policy_changed');
        if (Date.parse(quote.expiresAt) <= Date.now() || Date.parse(checkout.expiresAt) <= Date.now()) fail('quote_expired', 410);
        if (next.shipments.some(shipment => shipment.quoteId === quote.id || shipment.checkoutId === checkout.id)) fail('checkout_reserved');
        const day = next.days.find(day => day.deliveryDate === quote.deliveryDate && day.enabled);
        if (!day) fail('service_day_unavailable');
        if (quote.dayVersion !== day.version) fail('service_day_changed');
        let route = next.routes.find(route => quote.routeId ? route.id === quote.routeId : route.deliveryDate === quote.deliveryDate);
        if (!route) {
          route = { ...clone(quote.candidateRoute), id: randomUUID(), deliveryDate: quote.deliveryDate, departureAt: `${day.deliveryDate}T${day.departureTime}:00-03:00`, version: 0, capacity: day.capacity, maxDurationSeconds: day.maxDurationSeconds, stops: [] };
          next.routes.push(route);
        }
        if (route.version !== payload.expectedVersion || route.version !== quote.routeVersion) fail('route_changed');
        const departureAt = route.departureAt || `${day.deliveryDate}T${day.departureTime}:00-03:00`;
        if (!Number.isFinite(Date.parse(departureAt)) || Date.parse(departureAt) <= Date.now()) fail('route_departed');
        if (route.stops.length >= Math.min(route.capacity, day.capacity, 10)) fail('route_full');
        result = { id: randomUUID(), checkoutId: checkout.id, quoteId: quote.id, routeId: route.id, status: 'held', priceMinor: quote.priceMinor, normalPriceMinor: quote.normalPriceMinor, currency: 'UYU', expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), deliveryDate: quote.deliveryDate, address: acceptedAddress(quote.address), mode: 'demo' };
        const stop = { shipmentId: result.id, placeId: quote.address?.placeId, label: quote.label || 'Entrega', priceMinor: quote.priceMinor, status: 'held' };
        const candidate = quote.candidateRoute?.stops;
        if (candidate?.some(row => row.shipmentId === null)) {
          if (candidate.length !== route.stops.length + 1 || candidate.filter(row => row.shipmentId === null).length !== 1 || route.stops.some(row => !candidate.some(item => item.shipmentId === row.shipmentId))) fail('route_changed');
          route.stops = candidate.map(row => row.shipmentId === null ? stop : route.stops.find(item => item.shipmentId === row.shipmentId));
        } else route.stops.push(stop);
        route.version++;
        next.shipments.push(result);
        record('shipment',result.id,null,result);
        replays.set(key, { bodyHash: payload.bodyHash, result: clone(result) });
      } else if (['confirm', 'demo_confirm', 'cancel'].includes(operation)) {
        result = next.shipments.find(shipment => shipment.id === payload.shipmentId);
        if (!result) fail('shipment_not_found', 404);
        if (operation === 'demo_confirm' && (!payload.checkoutId || payload.checkoutId !== result.checkoutId)) fail('checkout_forbidden', 403);
        if (operation === 'cancel' && (typeof payload.reason !== 'string' || payload.reason.trim().length < 3 || payload.reason.length > 300)) fail('cancellation_invalid',400);
        const target = operation === 'cancel' ? 'cancelled' : 'confirmed';
        if (result.status === 'expired') fail('reservation_expired', 410);
        if (result.status !== target && !(['held', 'confirmed'].includes(result.status) && (target === 'cancelled' || result.status === 'held'))) fail('transition_invalid');
        if (result.status !== target) {
          const before = clone(result);
          result.status = target;
          if (operation === 'cancel') Object.assign(result,{cancellationReason:payload.reason.trim(),cancelledBy:payload.actorId,cancelledAt:new Date().toISOString()});
          if (operation === 'demo_confirm') result.demo = true;
          const route = next.routes.find(route => route.id === result.routeId);
          route.stops = target === 'cancelled' ? route.stops.filter(stop => stop.shipmentId !== result.id) : route.stops.map(stop => stop.shipmentId === result.id ? { ...stop, status: target } : stop);
          route.version++;
          record('shipment',result.id,before,result,['status']);
        }
      } else if (operation === 'settings_save') {
        if (!payload.policy || Object.entries(payload.policy).some(([key, value]) => !['id', 'version'].includes(key) && (!Number.isFinite(value) || value < 0 || (['minimumMinor', 'roundingMinor', 'quoteMinutes', 'holdMinutes'].includes(key) && value <= 0))) || (payload.policy.marginBps !== undefined && payload.policy.marginBps >= 10000)) fail('policy_invalid', 400);
        const before = next.policy;
        next.policy = { ...next.policy, ...clone(payload.policy), version: (next.policy.version || 0) + 1 }; result = next.policy;
        record('rate_policy','current',before,result);
      } else if (operation === 'zone_rate_save') {
        if (typeof payload.areaId !== 'string' || !next.areas.some(area => area.id === payload.areaId) || !money(payload.priceMinor) || payload.priceMinor > 1000000000 || !money(next.policy.minimumMinor) || payload.priceMinor < next.policy.minimumMinor || typeof payload.enabled !== 'boolean') fail('zone_rate_invalid', 400);
        const index = next.zoneRates.findIndex(rate => rate.areaId === payload.areaId);
        const before = next.zoneRates[index];
        result = { areaId: payload.areaId, priceMinor: payload.priceMinor, enabled: payload.enabled, version: (before?.version || 0) + 1 };
        if (index >= 0) next.zoneRates[index] = result; else next.zoneRates.push(result);
        next.policy.version = (next.policy.version || 0) + 1;
        record('zone_rate',payload.areaId,before,result);
      } else if (operation === 'price_save') {
        if (!payload.productId || !money(payload.priceMinor)) fail('price_invalid', 400);
        const before = {priceMinor:next.prices[payload.productId]};
        next.prices[payload.productId] = payload.priceMinor; result = { productId: payload.productId, priceMinor: payload.priceMinor };
        record('product_price',payload.productId,before,result);
      } else if (operation === 'promotion_save' || operation === 'service_day_save') {
        const item = clone(operation === 'promotion_save' ? payload.promotion : payload.day);
        const collection = operation === 'promotion_save' ? next.promotions : next.days;
        if (!item || (operation === 'promotion_save' && !money(item.priceMinor)) || (operation === 'service_day_save' && (!Number.isInteger(item.capacity) || item.capacity < 1 || item.capacity > 10))) fail('settings_invalid', 400);
        if (operation === 'promotion_save') {
          item.id ||= randomUUID(); item.version = (collection.find(row => row.id === item.id)?.version || 0) + 1;
          if (item.active && collection.some(row => row.id !== item.id && row.active && row.areaId === item.areaId && row.deliveryDate === item.deliveryDate)) fail('promotion_conflict');
        }
        const index = collection.findIndex(row => operation === 'promotion_save' ? row.id === item.id : row.deliveryDate === item.deliveryDate);
        if (operation === 'service_day_save') {
          const previous = collection[index];
          item.version = (previous?.version || 0) + 1;
          const route = next.routes.find(route => route.deliveryDate === item.deliveryDate);
          if (route && previous?.departureTime !== item.departureTime && route.stops.some(stop => ['held', 'confirmed'].includes(stop.status))) fail('assigned_departure_immutable');
          if (route && route.stops.length === 0) {
            route.departureAt = `${item.deliveryDate}T${item.departureTime}:00-03:00`;
            route.capacity = item.capacity; route.maxDurationSeconds = item.maxDurationSeconds; route.version++;
          }
        }
        record(operation === 'promotion_save' ? 'promotion' : 'service_day', operation === 'promotion_save' ? item.id : item.deliveryDate,collection[index],item);
        if (index >= 0) collection[index] = item; else collection.push(item);
        result = item;
      } else if (operation === 'external_create') {
        if (payload.expectedPolicyVersion !== undefined && payload.expectedPolicyVersion !== next.policy.version) fail('policy_changed');
        const deliveryDate = payload.candidateRoute?.deliveryDate || payload.shipment?.deliveryDate;
        const day = next.days.find(row => row.deliveryDate === deliveryDate && row.enabled);
        if (!day || (payload.expectedDayVersion ?? 1) !== day.version) fail('service_day_changed');
        let route = next.routes.find(route => payload.routeId ? route.id === payload.routeId : route.deliveryDate === deliveryDate);
        if (!route && day) { route = { ...clone(payload.candidateRoute), id: randomUUID(), departureAt: `${day.deliveryDate}T${day.departureTime}:00-03:00`, version: 0, capacity: day.capacity, maxDurationSeconds: day.maxDurationSeconds, stops: [] }; next.routes.push(route); }
        if (!route || route.version !== payload.expectedVersion || route.stops.length >= Math.min(route.capacity, day?.capacity || route.capacity, 10)) fail('route_changed');
        const departureAt = route.departureAt || `${day.deliveryDate}T${day.departureTime}:00-03:00`;
        if (!Number.isFinite(Date.parse(departureAt)) || Date.parse(departureAt) <= Date.now()) fail('route_departed');
        const shipment = clone(payload.shipment);
        if (!money(shipment?.priceMinor) || !shipment.externalOrderRef || next.shipments.some(row => row.externalOrderRef === shipment.externalOrderRef)) fail('external_invalid', 400);
        result = { ...shipment, address: acceptedAddress(shipment.address), id: randomUUID(), routeId: route.id, status: 'confirmed', mode: 'demo', currency: 'UYU' };
        const stop = { shipmentId: result.id, placeId: result.address?.placeId, priceMinor: result.priceMinor, status: 'confirmed' };
        const candidate = payload.candidateRoute?.stops;
        if (candidate?.some(row => row.shipmentId === null)) {
          if (candidate.length !== route.stops.length + 1 || candidate.filter(row => row.shipmentId === null).length !== 1 || route.stops.some(row => !candidate.some(item => item.shipmentId === row.shipmentId))) fail('route_changed');
          route.stops = candidate.map(row => row.shipmentId === null ? stop : route.stops.find(item => item.shipmentId === row.shipmentId));
        } else route.stops.push(stop);
        route.version++; next.shipments.push(result);
        record('shipment',result.id,null,result);
      } else fail('operation_unknown', 400);
      if (audit) next.auditEvents.unshift(audit);
      next.auditEvents = next.auditEvents.slice(0,100);
      state = next;
      if (operation === 'external_create') replays.set(externalKey, { bodyHash: payload.bodyHash, result: clone(result) });
      return clone(result);
    },
  };
}
