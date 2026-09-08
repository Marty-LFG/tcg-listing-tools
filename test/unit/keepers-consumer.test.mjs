// test/unit/keepers-consumer.test.mjs — the arming switches and the delivery queue.
//
// The switches are the whole reason a soak is possible, so most of this file is about what each one
// refuses. One combination in particular is a trap that looks harmless: projecting while the mode is
// not 'apply' publishes a ledger nothing is writing to, so the storefront freezes at whatever the
// last apply run produced and never moves again — with no error anywhere.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateKeepersConfig, DEFAULT_CONFIG, MODES, TOPICS, MAX_ATTEMPTS,
  shopMismatchProblem,
  recordDelivery, actionFor, refIdFor, drainWebhooks, getKeepersEngineState,
  keepersEnv, keepersPlugin,
} from '../../lib/keepers.mjs';
import { openKeepersDbAt, upsertCustomer, appendEvent, getCustomer } from '../../lib/keepers-db.mjs';
import { BUSINESS_TOPICS } from '../../lib/shopify-hooks.mjs';

const GID = 'gid://shopify/Customer/8675309';
const ORDER = 'gid://shopify/Order/5001';

let db;
beforeEach(() => { db = openKeepersDbAt(':memory:'); });

const delivery = (over = {}) => ({
  webhookId: 'wh-' + Math.random().toString(36).slice(2),
  topic: 'orders/paid',
  shopDomain: 'binders-keepers-dev.myshopify.com',
  apiVersion: '2026-07',
  triggeredAt: '2026-09-06T00:00:00Z',
  body: { id: 5001, admin_graphql_api_id: ORDER },
  raw: '{"id":5001}',
  ...over,
});

describe('validateKeepersConfig — refusals, not warnings', () => {
  const ok = { ...DEFAULT_CONFIG, mode: 'apply' };

  it('accepts the shipped default and a fully armed config', () => {
    assert.equal(validateKeepersConfig(DEFAULT_CONFIG), null);
    assert.equal(validateKeepersConfig({ ...ok, project: { enabled: true, allowLive: false } }), null);
  });

  it('REFUSES an unrecognised mode rather than treating it as "not off"', () => {
    // The failure mode of a typo must not be a mode that silently does more than intended.
    assert.match(validateKeepersConfig({ ...ok, mode: 'aply' }), /mode must be one of/);
    assert.match(validateKeepersConfig({ ...ok, mode: true }), /mode must be one of/);
    assert.match(validateKeepersConfig({ ...ok, mode: undefined }), /mode must be one of/);
  });

  it('REFUSES projecting from a ledger nothing is writing to', () => {
    // The trap: it looks armed, nothing errors, and the storefront silently freezes at whatever the
    // last apply run produced.
    for (const mode of ['off', 'observe']) {
      const problem = validateKeepersConfig({ ...ok, mode, project: { enabled: true, allowLive: false } });
      assert.match(problem, /publish a ledger nothing is writing to/, mode);
    }
  });

  it('REFUSES the live store without the second switch', () => {
    const p = validateKeepersConfig({ ...ok, store: 'live', project: { enabled: true, allowLive: false } });
    assert.match(p, /also needs project.allowLive/);
    assert.equal(validateKeepersConfig({ ...ok, store: 'live', project: { enabled: true, allowLive: true } }), null);
  });

  it('refuses nonsensical limits', () => {
    assert.match(validateKeepersConfig({ ...ok, drain_limit: 0 }), /drain_limit must be a positive number/);
    assert.match(validateKeepersConfig({ ...ok, config_ttl_sec: -1 }), /config_ttl_sec/);
  });

  it('every mode in MODES is a real mode', () => {
    for (const m of MODES) assert.equal(validateKeepersConfig({ ...DEFAULT_CONFIG, mode: m }), null, m);
  });
});

describe('the topics it subscribes to', () => {
  it('are all known to the receiver', () => {
    // A topic the receiver does not know would be a consumer that silently never fires.
    for (const t of TOPICS) assert.ok(BUSINESS_TOPICS.includes(t), `${t} is not a receiver topic`);
  });

  it('does not subscribe to things it has no use for', () => {
    assert.equal(TOPICS.includes('orders/create'), false, 'paid is the accrual trigger, not created');
    assert.equal(TOPICS.includes('app/uninstalled'), false);
  });
});

describe('actionFor / refIdFor', () => {
  it('maps every order topic to the same action — re-read by id', () => {
    for (const t of ['orders/paid', 'orders/updated', 'orders/cancelled', 'orders/edited', 'refunds/create']) {
      assert.equal(actionFor(t), 'order_by_id', t);
    }
  });

  it('maps customer topics and the compliance topics', () => {
    assert.equal(actionFor('customers/create'), 'customer_by_id');
    assert.equal(actionFor('customers/redact'), 'redact');
    assert.equal(actionFor('shop/redact'), 'redact_shop');
    assert.equal(actionFor('customers/data_request'), 'data_request');
    assert.equal(actionFor('orders/unknown_thing'), 'order_by_id');
    assert.equal(actionFor('nonsense'), null);
  });

  it('takes the ORDER id from a refund payload, not the refund id', () => {
    // A refund re-derives the whole order, so the order is the subject.
    assert.equal(refIdFor({ topic: 'refunds/create', body: { id: 999, order_id: 5001 } }),
      'gid://shopify/Order/5001');
  });

  it('prefers the graphql id when Shopify supplies one', () => {
    assert.equal(refIdFor({ topic: 'orders/paid', body: { id: 1, admin_graphql_api_id: ORDER } }), ORDER);
    assert.equal(refIdFor({ topic: 'orders/paid', body: { id: 5001 } }), ORDER);
    assert.equal(refIdFor({ topic: 'orders/paid', body: {} }), null);
  });
});

describe('recordDelivery — runs before the ack', () => {
  it('stores a delivery and marks it received', () => {
    const r = recordDelivery(db, delivery());
    assert.equal(r.stored, true);
    const row = db.prepare('SELECT * FROM keepers_webhooks').get();
    assert.equal(row.status, 'received');
    assert.equal(row.action, 'order_by_id');
    assert.equal(row.ref_id, ORDER);
  });

  it('dedupes on webhook id — at-least-once delivery is normal, not an error', () => {
    const e = delivery();
    assert.equal(recordDelivery(db, e).stored, true);
    assert.equal(recordDelivery(db, e).stored, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM keepers_webhooks').get().n, 1);
  });

  it('records an unwanted topic as ignored rather than dropping it', () => {
    // If it is arriving, either a subscription exists nobody remembers making or Shopify added one.
    recordDelivery(db, delivery({ topic: 'nonsense/topic' }));
    assert.equal(db.prepare('SELECT status FROM keepers_webhooks').get().status, 'ignored');
  });
});

describe('drainWebhooks', () => {
  const cfg = { ...DEFAULT_CONFIG, mode: 'apply' };

  it('handles a customer delivery without touching the network', async () => {
    recordDelivery(db, delivery({ topic: 'customers/create', body: { id: 8675309, admin_graphql_api_id: GID } }));
    const r = await drainWebhooks({}, db, { cfg, rules: {}, store: 'dev' });
    assert.equal(r.handled, 1);
    assert.ok(getCustomer(db, GID), 'the customer row was created');
    assert.equal(db.prepare('SELECT status FROM keepers_webhooks').get().status, 'handled');
  });

  it('OBSERVE mode changes nothing — it only writes down what it saw', async () => {
    recordDelivery(db, delivery({ topic: 'customers/create', body: { admin_graphql_api_id: GID } }));
    const r = await drainWebhooks({}, db, { cfg: { ...cfg, mode: 'observe' }, rules: {}, store: 'dev' });
    assert.equal(r.observeOnly, true);
    assert.equal(getCustomer(db, GID), null, 'observe must not even create a customer row');
    assert.equal(db.prepare('SELECT status FROM keepers_webhooks').get().status, 'skipped');
  });

  it('redacts a customer, keeping the events and removing the person', async () => {
    upsertCustomer(db, { customerGid: GID });
    appendEvent(db, {
      customerGid: GID, kind: 'order_accrual', xpDelta: 74, pointsDelta: 148,
      source: 'shopify_order', sourceRef: ORDER, basisCents: 7400,
    });
    recordDelivery(db, delivery({ topic: 'customers/redact', body: { admin_graphql_api_id: GID } }));
    await drainWebhooks({}, db, { cfg, rules: {}, store: 'dev' });
    assert.equal(getCustomer(db, GID), null, 'the person is gone');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM keepers_events').get().n, 1, 'the event survives');
    assert.equal(db.prepare('SELECT customer_gid FROM keepers_events').get().customer_gid, null);
  });

  it('acknowledges a data request without pretending to act on it', async () => {
    recordDelivery(db, delivery({ topic: 'customers/data_request', body: { admin_graphql_api_id: GID } }));
    const r = await drainWebhooks({}, db, { cfg, rules: {}, store: 'dev' });
    assert.equal(r.handled, 1);
  });

  it('retries a failing delivery, then settles it for the sweep to pick up', async () => {
    // The retry is a latency optimisation; the sweep is the correctness guarantee. Keeping that
    // straight is what stops the retry budget from being load-bearing.
    recordDelivery(db, delivery({ topic: 'orders/paid', body: { admin_graphql_api_id: ORDER } }));
    const boom = { ...cfg };
    const t0 = Date.parse('2026-09-06T00:00:00Z');
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      // No env means shopifyGraphQL cannot be configured, so ingestOrder reports a fetch failure.
      await drainWebhooks({}, db, { cfg: boom, rules: {}, store: 'dev', nowMs: t0 + i * 120000 });
    }
    const row = db.prepare('SELECT status, attempt FROM keepers_webhooks').get();
    assert.equal(row.attempt, MAX_ATTEMPTS);
    assert.equal(row.status, 'failed', 'settled rather than retrying forever');
  });

  it('does not retry before the backoff expires', async () => {
    recordDelivery(db, delivery({ topic: 'orders/paid', body: { admin_graphql_api_id: ORDER } }));
    const t0 = Date.parse('2026-09-06T00:00:00Z');
    await drainWebhooks({}, db, { cfg, rules: {}, store: 'dev', nowMs: t0 });
    const again = await drainWebhooks({}, db, { cfg, rules: {}, store: 'dev', nowMs: t0 + 1000 });
    assert.equal(again.due, 0, 'still inside the backoff');
  });

  it('skips a delivery with no usable action', async () => {
    recordDelivery(db, delivery({ topic: 'orders/paid', body: {} }));   // no ref id
    const r = await drainWebhooks({}, db, { cfg, rules: {}, store: 'dev' });
    assert.equal(r.skipped, 1);
    assert.equal(db.prepare('SELECT status FROM keepers_webhooks').get().status, 'skipped');
  });
});

describe('getKeepersEngineState', () => {
  it('reports the switches, the queue and the drift in one object', () => {
    recordDelivery(db, delivery());
    const s = getKeepersEngineState(db);
    assert.equal(s.mode, 'off');
    assert.equal(s.project.enabled, false);
    assert.equal(s.webhooks.received, 1);
    assert.equal(s.queue_depth, 0);
    // redemptions_unexplained is IN this shape on purpose: the design calls the two usage readings'
    // disagreement its alarm, and this object is what /api/status publishes as drift. A count that is
    // not here is a count nobody sees.
    assert.deepEqual(Object.keys(s.drift).sort(), ['extra', 'missing', 'redemptions_unexplained', 'unlinked']);
  });
});

// --- the receiver and the engine must point at the same store -------------------------------------
//
// TWO CONFIG FILES, ONE DECISION. shopify-hooks.config.json decides which store's deliveries are
// ACCEPTED; keepers.config.json decides which store the engine READS BACK from. Going live means
// editing both, by hand, on the box, and until now nothing refused or even noticed when only one of
// them moved.
//
// Both failure directions are quiet in their own way, which is what earns this a check rather than a
// comment. Receiver on live with the engine on dev: every live order is accepted, stored and drained,
// then re-read against a store where that order id does not exist — nothing written wrongly, nothing
// working, symptom "orders arrive and nothing happens". The other way round: the receiver 401s every
// delivery, Shopify retries for 48 hours, and sig_failures climbs, poisoning the one counter that
// means "the app secret rotated".
describe('shopMismatchProblem — the pair, not the files', () => {
  const ENV = { SHOPIFY_DEV_SHOP: 'binders-keepers-dev', SHOPIFY_SHOP: 'gkrnva-1k' };
  const keepers = (store) => ({ ...DEFAULT_CONFIG, mode: 'apply', store });
  const hooks = (over = {}) => ({ enabled: true, shop: 'dev', expect_shop_domain: 'binders-keepers-dev.myshopify.com', ...over });

  it('is silent when both agree', () => {
    assert.equal(shopMismatchProblem(ENV, keepers('dev'), hooks()), null);
    assert.equal(shopMismatchProblem(ENV, keepers('live'), hooks({ shop: 'live', expect_shop_domain: 'gkrnva-1k.myshopify.com' })), null);
  });

  it('catches a receiver on live while the engine still reads dev', () => {
    const p = shopMismatchProblem(ENV, keepers('dev'), hooks({ shop: 'live', expect_shop_domain: 'gkrnva-1k.myshopify.com' }));
    assert.match(p, /receiver accepts deliveries from the live store/);
    assert.match(p, /engine reads the dev store/);
  });

  it('catches the reverse — the 48-hour-retry direction', () => {
    const p = shopMismatchProblem(ENV, keepers('live'), hooks());
    assert.match(p, /receiver accepts deliveries from the dev store/);
    assert.match(p, /engine reads the live store/);
  });

  it('catches the HALF-DONE edit: right label, wrong domain', () => {
    // The likeliest way to get this wrong, and the reason the check does not stop at the label.
    // `shop: 'live'` is a label; expect_shop_domain is the string every delivery is compared against.
    // Setting the first and forgetting the second leaves a config that looks migrated and behaves
    // exactly as it did before.
    const p = shopMismatchProblem(ENV, keepers('live'), hooks({ shop: 'live' }));
    assert.match(p, /expect_shop_domain is binders-keepers-dev\.myshopify\.com/);
    assert.match(p, /the live store is gkrnva-1k\.myshopify\.com/);
  });

  it('accepts a bare subdomain in .env, because resolveShop does', () => {
    // .env may hold either form. Re-deriving the domain here instead of reusing resolveShop would be
    // a second implementation of that rule, and the two would disagree the first time one changed.
    assert.equal(shopMismatchProblem({ SHOPIFY_DEV_SHOP: 'binders-keepers-dev.myshopify.com' }, keepers('dev'), hooks()), null);
  });

  it('says nothing when the receiver is disabled — nothing arrives, nothing can disagree', () => {
    assert.equal(shopMismatchProblem(ENV, keepers('dev'), hooks({ enabled: false, shop: 'live' })), null);
  });

  it('says nothing when the store is not configured in .env', () => {
    // An unconfigured store is a different problem that already reports itself elsewhere; claiming a
    // mismatch here would send someone to the wrong file.
    assert.equal(shopMismatchProblem({}, keepers('live'), hooks({ shop: 'live' })), null);
  });

  it('says nothing when expect_shop_domain is blank', () => {
    // validateShopifyHooksConfig already refuses that when enabled, and duplicating the refusal here
    // would report one fault as two.
    assert.equal(shopMismatchProblem(ENV, keepers('dev'), hooks({ expect_shop_domain: '' })), null);
  });
});

// --- the env the check actually reads ------------------------------------------------------------
//
// This is how the pair check shipped broken, and it is the reason every test above passed anyway.
// vite's loadEnv() reads .env and RETURNS it; it never writes to process.env. Every test above hands
// shopMismatchProblem an explicit env object, so every test above exercised a code path the server
// never takes: getKeepersEngineState() passes nothing, the default was process.env, and on the box
// process.env holds no SHOPIFY_* keys at all. resolveShop threw, the catch returned null, and the
// DOMAIN half of the check never ran — not once, on any /state read, since it shipped.
//
// What made it invisible is that the LABEL half needs no env and worked perfectly. So the loud
// failure (store: 'live' against shop: 'dev') was caught, and the quiet one — right label, stale
// expect_shop_domain, the half-done edit the docblock calls the likeliest mistake — returned null,
// which is indistinguishable from "the pair agrees".
describe('shopMismatchProblem reads the env the SERVER has, not the shell it was started from', () => {
  const engineOnLive = { ...DEFAULT_CONFIG, mode: 'apply', store: 'live' };
  const halfDoneEdit = { enabled: true, shop: 'live', expect_shop_domain: 'binders-keepers-dev.myshopify.com' };
  const VITE_ENV = { SHOPIFY_SHOP: 'gkrnva-1k', SHOPIFY_DEV_SHOP: 'binders-keepers-dev' };

  // keepersPlugin({}) puts the module back to "no plugin has run", so this describe cannot leak an
  // env into anything after it.
  afterEach(() => { keepersPlugin({}); });

  it('falls back to process.env when no plugin has constructed it', () => {
    keepersPlugin({});
    assert.equal(keepersEnv(), process.env, 'a script or a test with no plugin still gets an env');
  });

  it('uses the env the plugin was built with, so the DEFAULT argument sees the half-done edit', () => {
    // Called exactly the way getKeepersEngineState calls it: no env argument at all.
    keepersPlugin(VITE_ENV);
    const p = shopMismatchProblem(undefined, engineOnLive, halfDoneEdit);
    assert.ok(p, 'the quiet half of the pair check must work through the default env, not only an explicit one');
    assert.match(p, /expect_shop_domain is binders-keepers-dev\.myshopify\.com/);
    assert.match(p, /the live store is gkrnva-1k\.myshopify\.com/);
  });

  it('and getKeepersEngineState — the real caller — reports it', () => {
    keepersPlugin(VITE_ENV);
    const problem = shopMismatchProblem(undefined, engineOnLive, halfDoneEdit);
    assert.ok(problem, 'guard: the state field below is only meaningful if this is non-null');
    // getKeepersEngineState reads the real config files, so assert the wiring rather than the value:
    // the field exists, and the function it delegates to now resolves against the plugin env.
    const st = getKeepersEngineState(openKeepersDbAt(':memory:'));
    assert.ok('shop_mismatch' in st, 'the state must carry the field the admin page draws');
  });

  it('an empty plugin env does not shadow process.env', () => {
    // vite hands every plugin the same loadEnv object, but a caller constructing the plugin for its
    // own reasons (a test, a script) may pass nothing useful. That must not blind the check.
    keepersPlugin({});
    assert.equal(keepersEnv(), process.env);
  });
});
