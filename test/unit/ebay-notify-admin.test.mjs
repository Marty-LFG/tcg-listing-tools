// test/unit/ebay-notify-admin.test.mjs — the reconciler's decision-making.
//
// planReconcile is the half worth testing hard: it decides what to create, enable and disable against
// eBay, and every one of those is a real side effect on a live seller account. The calls themselves
// are thin wrappers over ebayRest; the *plan* is where a mistake costs something.
//
// eBay is replaced by an injected stub, so this is offline and deterministic. The scenarios are the
// ones that actually happen: nothing registered yet, everything already correct, the endpoint moved,
// eBay disabled the destination after failed deliveries, and a topic dropped from the config.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planReconcile, reconcile, applyPlan, bestSchemaVersion, destinationHealth,
} from '../../lib/ebay-notify-admin.mjs';

const CFG = {
  public_endpoint: 'https://hooks.example/ebay/notifications',
  destination_name: 'tcg-tools-prod',
  alert_email: 'seller@example.com',
  topics: ['ORDER_CONFIRMATION'],
};

const TOPICS = [
  { topicId: 'ORDER_CONFIRMATION', authorizationScopes: ['x/sell.fulfillment'], filterable: false,
    supportedPayloads: [
      { schemaVersion: '1.0', format: 'JSON', deliveryProtocol: 'HTTPS' },
      { schemaVersion: '1.1', format: 'JSON', deliveryProtocol: 'HTTPS' },
    ] },
  { topicId: 'NEW_MESSAGE', authorizationScopes: ['x/commerce.message'], filterable: false,
    supportedPayloads: [{ schemaVersion: '1.0', format: 'JSON', deliveryProtocol: 'HTTPS' }] },
];

const DEST = (over = {}) => ({
  destinationId: 'd1', name: 'tcg-tools-prod', status: 'ENABLED',
  deliveryConfig: { endpoint: CFG.public_endpoint }, ...over,
});
const SUB = (over = {}) => ({
  subscriptionId: 's1', destinationId: 'd1', topicId: 'ORDER_CONFIRMATION', status: 'ENABLED', ...over,
});

// Stand in for eBay. Injected rather than module-mocked: ES module exports are immutable, so
// mock.method cannot patch them — and an injected seam is what the rest of this repo already uses
// (sweepOpenOrders' fetchOrders, verifyNotification's fetchKey).
function stub({ topics = TOPICS, destinations = [], subscriptions = [], alertEmail = 'seller@example.com', configMissing = false } = {}) {
  const calls = [];
  // The two DIFFERENT ways eBay reports the same missing prerequisite, verbatim from a live probe.
  const CONFIG_404 = { ok: false, httpStatus: 404, usedToken: 'app',
    json: { errors: [{ errorId: 195026, domain: 'API_NOTIFICATION', message: 'Configuration not found.' }] } };
  const NOT_CONFIGURED = { ok: false, httpStatus: 409, usedToken: 'app',
    json: { errors: [{ errorId: 195003, domain: 'API_NOTIFICATION', message: 'Please provide configurations required for notifications. Refer to documentation.' }] } };
  const call = async (env, method, path, body) => {
    calls.push({ method, path, body });
    if (method !== 'GET') return { ok: true, httpStatus: 200, json: { destinationId: 'NEW-D', subscriptionId: 'NEW-S' }, usedToken: 'app' };
    if (path.startsWith('/config')) return configMissing ? CONFIG_404 : { ok: true, httpStatus: 200, json: { alertEmail }, usedToken: 'app' };
    // Until the app config exists eBay refuses the subscription endpoint outright — the real 195003
    // that the first live dry run hit.
    if (path.startsWith('/subscription') && configMissing) return NOT_CONFIGURED;
    const json = path.startsWith('/topic') ? { topics }
      : path.startsWith('/destination') ? { destinations }
        : path.startsWith('/subscription') ? { subscriptions } : {};
    return { ok: true, httpStatus: 200, json, usedToken: 'app' };
  };
  call.calls = calls;
  return call;
}

describe('bestSchemaVersion — read the version from eBay, do not hardcode it', () => {
  it('picks the highest HTTPS/JSON version offered', () => {
    assert.equal(bestSchemaVersion(TOPICS[0]), '1.1', 'ORDER_CONFIRMATION offers 1.0 and 1.1');
    assert.equal(bestSchemaVersion(TOPICS[1]), '1.0', 'NEW_MESSAGE offers only 1.0');
  });
  it('ignores versions offered over a protocol or format we do not use', () => {
    assert.equal(bestSchemaVersion({ supportedPayloads: [
      { schemaVersion: '9.9', format: 'XML', deliveryProtocol: 'HTTPS' },
      { schemaVersion: '2.0', format: 'JSON', deliveryProtocol: 'PUBSUB' },
      { schemaVersion: '1.0', format: 'JSON', deliveryProtocol: 'HTTPS' },
    ] }), '1.0');
  });
  it('falls back rather than throwing on a topic with no payloads', () => {
    assert.equal(bestSchemaVersion({}), '1.0');
    assert.equal(bestSchemaVersion(null), '1.0');
  });
  it('compares numerically, not as strings', () => {
    assert.equal(bestSchemaVersion({ supportedPayloads: [
      { schemaVersion: '1.9', format: 'JSON', deliveryProtocol: 'HTTPS' },
      { schemaVersion: '1.10', format: 'JSON', deliveryProtocol: 'HTTPS' },
    ] }), '1.10', "'1.10' beats '1.9' numerically, though not as a string");
  });
});

describe('planReconcile — nothing registered yet', () => {
  it('plans to create the destination and the subscription, at the right schema version', async () => {
    const p = await planReconcile({}, CFG, { call: stub() });
    assert.equal(p.ok, true);
    assert.equal(p.destination.action, 'create');
    assert.equal(p.destination.endpoint, CFG.public_endpoint);
    assert.deepEqual(p.create, [{ topicId: 'ORDER_CONFIRMATION', schemaVersion: '1.1' }]);
    assert.deepEqual(p.enable, []);
    assert.deepEqual(p.disable, []);
    assert.ok(p.changes > 0);
  });

  it('reads only — a plan must never write', async () => {
    const call = stub();
    await planReconcile({}, CFG, { call });
    assert.deepEqual([...new Set(call.calls.map((c) => c.method))], ['GET'],
      'planning is what you run before you trust it; it cannot have side effects');
  });
});

describe('planReconcile — already correct', () => {
  it('plans nothing at all', async () => {
    const call = stub({ destinations: [DEST()], subscriptions: [SUB({ payload: { schemaVersion: '1.1' } })] });
    const p = await planReconcile({}, CFG, { call });
    assert.equal(p.destination.action, 'reuse');
    assert.deepEqual(p.create, []);
    assert.deepEqual(p.enable, []);
    assert.deepEqual(p.disable, []);
    assert.equal(p.changes, 0, 're-running a correct setup must be a no-op');
    assert.equal(p.ok_already.length, 1);
  });

  it('tolerates a trailing slash difference on the stored endpoint', async () => {
    const call = stub({
      destinations: [DEST({ name: 'x', deliveryConfig: { endpoint: CFG.public_endpoint + '/' } })],
      subscriptions: [SUB()],
    });
    const p = await planReconcile({}, CFG, { call });
    assert.equal(p.updateDestination, false, 'a trailing slash must not read as a moved endpoint');
    assert.equal(p.changes, 0);
  });
});

describe('planReconcile — the destination needs attention', () => {
  it('spots a moved endpoint and plans an update', async () => {
    const call = stub({ destinations: [DEST({ deliveryConfig: { endpoint: 'https://old.example/ebay/notifications' } })] });
    const p = await planReconcile({}, CFG, { call });
    assert.equal(p.updateDestination, true);
    assert.equal(p.destination.action, 'update-endpoint');
  });

  it('spots a destination eBay disabled, and says why that happens', async () => {
    const call = stub({ destinations: [DEST({ status: 'MARKED_DOWN' })] });
    const p = await planReconcile({}, CFG, { call });
    assert.equal(p.updateDestination, true);
    assert.equal(p.destination.action, 're-enable');
    assert.match(p.warnings.join(' '), /disables one that keeps failing/);
  });

  it('matches on endpoint rather than name — the endpoint is what eBay delivers to', async () => {
    const call = stub({
      destinations: [DEST({ destinationId: 'd9', name: 'some-old-label' })],
      subscriptions: [SUB({ destinationId: 'd9' })],
    });
    const p = await planReconcile({}, CFG, { call });
    assert.equal(p.destination.id, 'd9', 'a renamed destination is still the same destination');
    assert.equal(p.changes, 0);
  });
});

describe('planReconcile — subscriptions', () => {
  it('enables one that exists but is disabled, rather than creating a duplicate', async () => {
    const call = stub({ destinations: [DEST()], subscriptions: [SUB({ status: 'DISABLED' })] });
    const p = await planReconcile({}, CFG, { call });
    assert.deepEqual(p.create, [], 'eBay documents one subscription per topic — never create a second');
    assert.deepEqual(p.enable, [{ topicId: 'ORDER_CONFIRMATION', id: 's1', from: 'DISABLED' }]);
  });

  it('disables a topic dropped from the config — and never deletes it', async () => {
    const call = stub({
      destinations: [DEST()],
      subscriptions: [SUB(), SUB({ subscriptionId: 's2', topicId: 'NEW_MESSAGE' })],
    });
    const p = await planReconcile({}, CFG, { call });
    assert.deepEqual(p.disable, [{ topicId: 'NEW_MESSAGE', id: 's2' }]);
    assert.ok(!('delete' in p), 'deleting loses the record, and eBay reuses ids');
  });

  it('ignores subscriptions belonging to someone else’s destination', async () => {
    const call = stub({
      destinations: [DEST()],
      subscriptions: [SUB({ subscriptionId: 'sX', destinationId: 'OTHER', topicId: 'NEW_MESSAGE' })],
    });
    const p = await planReconcile({}, CFG, { call });
    assert.deepEqual(p.disable, [], 'only our own destination is ours to touch');
    assert.deepEqual(p.create, [{ topicId: 'ORDER_CONFIRMATION', schemaVersion: '1.1' }]);
  });

  it('warns rather than plans when a configured topic is not in eBay’s registry', async () => {
    const call = stub();
    const p = await planReconcile({}, { ...CFG, topics: ['ORDER_CONFIRMATION', 'NOT_REAL'] }, { call });
    assert.deepEqual(p.create.map((c) => c.topicId), ['ORDER_CONFIRMATION']);
    assert.match(p.warnings.join(' '), /NOT_REAL is not in eBay's registry/);
  });
});

// This one is written from a real failure. The first live dry run against eBay came back
// "[195003] Please provide configurations required for notifications" from getSubscriptions — which
// reads like a subscription problem and is actually a missing app-level config (the alert email).
// Nothing can be read or created until it exists.
describe('planReconcile — the app config eBay demands first', () => {
  it('recognises BOTH error numbers eBay uses for the same missing config', async () => {
    // 195026 from GET /config (404) and 195003 from GET /subscription (409). Matching only 195003
    // is what made the first live dry runs fail with no explanation attached.
    const call = stub({ configMissing: true });
    const p = await planReconcile({}, CFG, { call });
    assert.equal(p.ok, true);
    assert.deepEqual(p.setConfig, { action: 'create', alertEmail: 'seller@example.com' });
    assert.deepEqual(p.warnings.filter((w) => /unexpectedly/.test(w)), [],
      '195026 is a KNOWN shape — it must not be reported as an unexpected failure');
  });

  it('still plans the write when getConfig fails for a reason we do not recognise', async () => {
    const call = async (env, method, path) => {
      if (path.startsWith('/config')) return { ok: false, httpStatus: 500, json: { errors: [{ errorId: 99999, message: 'boom' }] } };
      return stub()(env, method, path);
    };
    const p = await planReconcile({}, CFG, { call });
    assert.deepEqual(p.setConfig, { action: 'create', alertEmail: 'seller@example.com' });
    assert.match(p.warnings.join(' '), /getConfig failed unexpectedly/, 'an unknown failure must be said out loud, not swallowed');
  });

  it('plans to create the config instead of giving up', async () => {
    const call = stub({ configMissing: true });
    const p = await planReconcile({}, CFG, { call });
    assert.equal(p.ok, true, 'a missing prerequisite we can satisfy is not a reason to abandon the plan');
    assert.deepEqual(p.setConfig, { action: 'create', alertEmail: 'seller@example.com' });
    assert.match(p.warnings.join(' '), /could not be read until the app config exists/);
    assert.deepEqual(p.create, [{ topicId: 'ORDER_CONFIRMATION', schemaVersion: '1.1' }],
      'with no readable subscriptions, planning must assume none exist');
  });

  it('plans to update the config when the stored address differs', async () => {
    const call = stub({ alertEmail: 'old@example.com' });
    const p = await planReconcile({}, CFG, { call });
    assert.deepEqual(p.setConfig, { action: 'update', from: 'old@example.com', alertEmail: 'seller@example.com' });
  });

  it('plans nothing when the address already matches', async () => {
    const p = await planReconcile({}, CFG, { call: stub() });
    assert.equal(p.setConfig, null);
  });

  it('refuses when no alert_email is configured and eBay holds none either', async () => {
    const call = stub({ configMissing: true });
    const p = await planReconcile({}, { ...CFG, alert_email: '' }, { call });
    assert.equal(p.ok, false);
    assert.match(p.errors.join(' '), /alert_email must be set/);
    assert.match(p.errors.join(' '), /195003/, 'name the error so the message is searchable');
  });

  it('sets the config BEFORE the destination — nothing else works until it exists', async () => {
    const ENV = { EBAY_NOTIFY_VERIFICATION_TOKEN: 'v'.repeat(40) };
    const call = stub({ configMissing: true });
    const plan = await planReconcile(ENV, CFG, { call });
    call.calls.length = 0;
    const done = await applyPlan(ENV, CFG, plan, { call });
    assert.deepEqual(done.errors, []);
    const writes = call.calls.filter((c) => c.method !== 'GET');
    assert.equal(writes[0].path, '/config', 'the config is the prerequisite; it goes first');
    assert.equal(writes[0].body.alertEmail, 'seller@example.com');
    assert.equal(writes[1].path, '/destination');
    assert.deepEqual(done.config, { alertEmail: 'seller@example.com' });
  });
});

describe('planReconcile — failure is reported, not thrown', () => {
  it('surfaces an eBay error instead of half-planning', async () => {
    const call = async () => ({ ok: false, httpStatus: 403, usedToken: 'user',
      json: { errors: [{ errorId: 195011, message: 'insufficient scope' }] } });
    const p = await planReconcile({}, CFG, { call });
    assert.equal(p.ok, false);
    assert.match(p.errors.join(' '), /getTopics/);
    assert.deepEqual(p.create, [], 'a plan built on a failed read would be nonsense');
  });
});

describe('reconcile — dry run is the default', () => {
  it('changes nothing, and says so, unless apply is explicitly passed', async () => {
    const call = stub();
    const r = await reconcile({}, CFG, { call });
    assert.equal(r.dry_run, true);
    assert.ok(r.plan, 'the caller must see the diff before anything happens');
    assert.ok(!('applied' in r), 'a dry run must not report having applied anything');
    assert.deepEqual([...new Set(call.calls.map((c) => c.method))], ['GET']);
  });
});

describe('applyPlan — order of operations, and the refusal that matters most', () => {
  const ENV = { EBAY_NOTIFY_VERIFICATION_TOKEN: 'v'.repeat(40) };

  it('refuses outright with no verification token — eBay could not validate the endpoint', async () => {
    const call = stub();
    const plan = await planReconcile({}, CFG, { call });
    const done = await applyPlan({}, CFG, plan, { call });
    assert.match(done.errors.join(' '), /EBAY_NOTIFY_VERIFICATION_TOKEN/);
    assert.equal(done.created_destination, null);
    assert.deepEqual(done.created, [], 'nothing may be created without the token');
  });

  it('creates the destination before any subscription, then enables', async () => {
    const call = stub();
    const plan = await planReconcile(ENV, CFG, { call });
    call.calls.length = 0;
    const done = await applyPlan(ENV, CFG, plan, { call });
    assert.deepEqual(done.errors, []);
    const writes = call.calls.filter((c) => c.method === 'POST').map((c) => c.path);
    assert.equal(writes[0], '/destination', 'nothing can be subscribed before the destination exists');
    assert.equal(writes[1], '/subscription');
    assert.match(writes[2], /\/enable$/);
    assert.equal(done.created_destination.id, 'NEW-D');
    assert.equal(done.enabled.length, 1);
  });

  it('creates the subscription DISABLED, so nothing is live before the challenge passes', async () => {
    const call = stub();
    const plan = await planReconcile(ENV, CFG, { call });
    call.calls.length = 0;
    await applyPlan(ENV, CFG, plan, { call });
    const sub = call.calls.find((c) => c.method === 'POST' && c.path === '/subscription');
    assert.equal(sub.body.status, 'DISABLED');
    assert.equal(sub.body.payload.schemaVersion, '1.1');
    assert.equal(sub.body.payload.deliveryProtocol, 'HTTPS');
  });

  it('stops rather than continuing when the destination cannot be created', async () => {
    const failing = async (env, method, path) => {
      if (method === 'GET') return stub()(env, method, path);
      return { ok: false, httpStatus: 400, json: { errors: [{ errorId: 195020, message: 'endpoint validation failed' }] } };
    };
    const plan = await planReconcile(ENV, CFG, { call: failing });
    const done = await applyPlan(ENV, CFG, plan, { call: failing });
    assert.match(done.errors.join(' '), /createDestination/);
    assert.deepEqual(done.created, [], 'subscribing to a destination that does not exist is nonsense');
  });
});

describe('destinationHealth', () => {
  it('reports the status eBay holds for our endpoint', async () => {
    const call = stub({ destinations: [DEST({ status: 'MARKED_DOWN' })] });
    const h = await destinationHealth({}, CFG, call);
    assert.equal(h.found, true);
    assert.equal(h.status, 'MARKED_DOWN');
  });
  it('says not-found rather than erroring when nothing is registered', async () => {
    const h = await destinationHealth({}, CFG, stub());
    assert.equal(h.ok, true);
    assert.equal(h.found, false);
  });
});
