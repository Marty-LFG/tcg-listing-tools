// test/unit/shopify-hooks.test.mjs — the shared Shopify receiver.
//
// No port is bound: requests go through __handleRequestForTest with a fake req/res, so the routing
// table, the refusals and the persist->ack->work order are all testable without a socket.
//
// What is worth testing hardest is what a mistake COSTS. A wrong refusal is a broken feature someone
// notices; a missing refusal is an open endpoint nobody notices. So most of this file is about the
// second kind.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  validateShopifyHooksConfig, registerConsumer, registeredConsumers, subscribedTopics,
  registerProxyHandler, __handleRequestForTest, __resetShopifyHooks, getShopifyHooksState, complianceTopics,
  DEFAULT_CONFIG, KNOWN_TOPICS, BUSINESS_TOPICS, COMPLIANCE_TOPICS,
} from '../../lib/shopify-hooks.mjs';
import { buildSignedString } from '../../lib/keepers-proxy-verify.mjs';

const SECRET = 'shpss_' + 'e'.repeat(32);
const SHOP = 'binders-keepers-dev.myshopify.com';
const ENV = { SHOPIFY_CLIENT_SECRET: SECRET };

// The handler reads its config from disk via config-paths.mjs, which captures CONFIG_DIR at import
// time — and ESM hoists imports above anything a test file assigns to process.env. So the config is
// passed in explicitly instead. That is a seam in the module, not a workaround: it also means these
// tests can never accidentally read (or write) the real data/shopify-hooks.config.json.
function testConfig(over = {}) {
  return { ...DEFAULT_CONFIG, enabled: true, expect_shop_domain: SHOP, ...over };
}
let CFG = testConfig();

// --- fake req/res ---

function fakeReq({ method = 'POST', url = '/shopify/keepers', headers = {}, body = '' } = {}) {
  const req = new EventEmitter();
  req.method = method; req.url = url; req.headers = headers;
  req.destroy = () => {};
  // Emit on the next tick so the handler has attached its listeners first.
  setImmediate(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end'); });
  return req;
}

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, body: null, ended: false, endedAt: 0,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.ended = true; this.endedAt = Date.now(); this.body = b ?? null; if (this._done) this._done(); },
  };
  res.done = new Promise((r) => { res._done = r; });
  return res;
}

const sign = (body, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('base64');

const hookHeaders = (topic, body, over = {}) => ({
  'x-shopify-hmac-sha256': sign(body),
  'x-shopify-topic': topic,
  'x-shopify-shop-domain': SHOP,
  'x-shopify-webhook-id': 'wh-' + Math.random().toString(36).slice(2),
  'x-shopify-triggered-at': '2026-09-06T00:00:00Z',
  'x-shopify-api-version': '2026-07',
  ...over,
});

async function post({ url = '/shopify/keepers', topic = 'orders/paid', body = '{"id":1}', headers } = {}) {
  const res = fakeRes();
  const req = fakeReq({ url, body, headers: headers || hookHeaders(topic, body) });
  await __handleRequestForTest(ENV, req, res, CFG);
  await res.done;
  return res;
}

beforeEach(() => { __resetShopifyHooks(); CFG = testConfig(); });
afterEach(() => { __resetShopifyHooks(); });

describe('validateShopifyHooksConfig — the safety boundary', () => {
  const ok = { ...DEFAULT_CONFIG, enabled: true, expect_shop_domain: SHOP };

  it('accepts the shipped default', () => {
    assert.equal(validateShopifyHooksConfig(ok), null);
  });

  it('refuses a LAN bind unless it is opted into deliberately', () => {
    assert.match(validateShopifyHooksConfig({ ...ok, listen_host: '192.168.4.200' }), /not loopback/);
    assert.equal(validateShopifyHooksConfig({ ...ok, listen_host: '192.168.4.200', allow_lan_bind: true }), null);
  });

  it('refuses 0.0.0.0 even WITH the opt-in', () => {
    // "It worked" is indistinguishable from "it is now on the guest wifi".
    assert.match(validateShopifyHooksConfig({ ...ok, listen_host: '0.0.0.0', allow_lan_bind: true }), /every interface/);
  });

  it('refuses the Vite port and the eBay listener port', () => {
    assert.match(validateShopifyHooksConfig({ ...ok, listen_port: 5273 }), /Vite dev server/);
    assert.match(validateShopifyHooksConfig({ ...ok, listen_port: 5274 }), /eBay notify/);
  });

  it('refuses a path under /api, or a duplicate path', () => {
    // A path collision here is how a tunnel misconfiguration becomes an exposed inventory route.
    assert.match(validateShopifyHooksConfig({ ...ok, webhook_path: '/api/hooks' }), /must not be \/ or under \/api/);
    assert.match(validateShopifyHooksConfig({ ...ok, webhook_path: '/' }), /must not be/);
    assert.match(validateShopifyHooksConfig({ ...ok, proxy_path: ok.webhook_path }), /must differ/);
  });

  it('refuses a ceiling below the floor', () => {
    assert.match(validateShopifyHooksConfig({ ...ok, dispatch: { quiet_ms: 5000, max_wait_ms: 1000, min_gap_ms: 0 } }),
      /ceiling cannot be below the floor/);
  });

  it('refuses being enabled without an expected shop domain', () => {
    // Without it, a delivery from any other store the app is installed on verifies perfectly.
    assert.match(validateShopifyHooksConfig({ ...ok, expect_shop_domain: '' }), /expect_shop_domain is required/);
  });
});

describe('consumers', () => {
  const noop = { name: 'keepers', topics: ['orders/paid'], record: () => ({ stored: true }) };

  it('registers, reports and unregisters', () => {
    const off = registerConsumer(noop);
    assert.deepEqual(registeredConsumers(), [{ name: 'keepers', topics: ['orders/paid'] }]);
    off();
    assert.deepEqual(registeredConsumers(), []);
  });

  it('is idempotent by name, so a settings restart cannot double-register', () => {
    registerConsumer(noop); registerConsumer(noop);
    assert.equal(registeredConsumers().length, 1);
  });

  it('refuses an unknown topic rather than creating a consumer that silently never fires', () => {
    assert.throws(() => registerConsumer({ ...noop, topics: ['orders/pay'] }), /unknown topics: orders\/pay/);
  });

  it('refuses a consumer with no name or no record()', () => {
    assert.throws(() => registerConsumer({ topics: [], record: () => {} }), /needs a name/);
    assert.throws(() => registerConsumer({ name: 'x' }), /needs a record/);
  });

  it('unions topics for the subscription set, subscribing a shared topic once', () => {
    registerConsumer({ name: 'keepers', topics: ['orders/paid', 'refunds/create'], record: () => ({}) });
    registerConsumer({ name: 'stock', topics: ['orders/paid', 'orders/cancelled'], record: () => ({}) });
    const t = subscribedTopics();
    assert.equal(t.filter((x) => x === 'orders/paid').length, 1, 'subscribed once, not twice');
    assert.ok(t.includes('orders/cancelled') && t.includes('refunds/create'));
  });

  it('EXCLUDES the compliance topics from the subscription set', () => {
    // They are not members of Shopify's WebhookSubscriptionTopic enum — verified by introspection
    // against 2026-07 — because they are configured once at the app level rather than per shop.
    // Returning them here would make a reconciliation job fail on every run.
    registerConsumer({ name: 'keepers', topics: ['orders/paid'], record: () => ({}) });
    const t = subscribedTopics();
    for (const c of COMPLIANCE_TOPICS) assert.equal(t.includes(c), false, `${c} is app-level, not subscribable`);
    assert.deepEqual(complianceTopics().sort(), [...COMPLIANCE_TOPICS].sort());
  });
});

describe('routing — three paths, bare 404 on everything else', () => {
  it('404s anything that is not one of the three paths', async () => {
    for (const url of ['/', '/api/inventory', '/api/status', '/shopify', '/shopify/other', '/apps', '/admin']) {
      const res = await post({ url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.body, null, `${url} must have no body`);
    }
  });

  it('405s a GET on the webhook path rather than treating it as a delivery', async () => {
    const res = fakeRes();
    await __handleRequestForTest(ENV, fakeReq({ method: 'GET', url: '/shopify/keepers' }), res, CFG);
    assert.equal(res.statusCode, 405);
  });
});

describe('webhook verification and the ack contract', () => {
  let seen;
  beforeEach(() => {
    seen = [];
    registerConsumer({ name: 'keepers', topics: ['orders/paid'], record: (e) => { seen.push(e); return { stored: true }; } });
  });

  it('accepts a genuine delivery, hands it to the consumer and acks 200', async () => {
    const res = await post();
    assert.equal(res.statusCode, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].topic, 'orders/paid');
    assert.deepEqual(seen[0].body, { id: 1 });
  });

  it('401s a bad signature and records NOTHING', async () => {
    const body = '{"id":1}';
    const res = await post({ headers: hookHeaders('orders/paid', body, { 'x-shopify-hmac-sha256': sign('tampered') }) });
    assert.equal(res.statusCode, 401);
    assert.equal(seen.length, 0);
    assert.equal(getShopifyHooksState().sig_failures, 1);
  });

  it('401s a delivery from a DIFFERENT shop, even though the signature is valid', async () => {
    // Same app on another store signs with the same secret. Only this check stops a stranger's orders
    // being ingested as ours.
    const body = '{"id":1}';
    const res = await post({ headers: hookHeaders('orders/paid', body, { 'x-shopify-shop-domain': 'someone-else.myshopify.com' }) });
    assert.equal(res.statusCode, 401);
    assert.equal(seen.length, 0);
  });

  it('RECORDS the wrong-shop refusal, not just counts it', async () => {
    const body = '{"id":1}';
    await post({ headers: hookHeaders('orders/paid', body, { 'x-shopify-shop-domain': 'someone-else.myshopify.com' }) });
    const st = getShopifyHooksState();
    assert.equal(st.sig_failures, 1);
    assert.ok(st.last_refusal, 'a refusal that leaves no record is a climbing number with no cause');
    assert.equal(st.last_refusal.what, 'webhook');
    assert.equal(st.last_refusal.reason, 'wrong_shop');
    // The detail names BOTH sides. Nothing else in the state does, and "which shop delivered" is the
    // whole question when the two configs have been hand-edited apart on the box.
    assert.match(st.last_refusal.detail, /someone-else/);
    assert.match(st.last_refusal.detail, /binders-keepers-dev\.myshopify\.com/);
  });

  it('tells a rotated secret apart from a wrong shop — the two refusals share one counter', async () => {
    // This is the reason the record exists. sig_failures counts both, so the number alone cannot say
    // whether the fix is "rotate the secret" or "fix the store pair". Before the wrong-shop branch
    // recorded anything, the SECOND refusal here left last_refusal still naming the FIRST — the
    // operator read a stale cause for a live fault. logRejection is no help either: it goes quiet
    // after five, and a real mismatch refuses every delivery.
    const body = '{"id":1}';
    await post({ headers: hookHeaders('orders/paid', body, { 'x-shopify-hmac-sha256': sign('tampered') }) });
    const afterHmac = getShopifyHooksState().last_refusal;
    assert.equal(afterHmac.reason !== 'wrong_shop', true, 'a bad HMAC is not a wrong shop');

    await post({ headers: hookHeaders('orders/paid', body, { 'x-shopify-shop-domain': 'someone-else.myshopify.com' }) });
    const afterShop = getShopifyHooksState().last_refusal;
    assert.equal(getShopifyHooksState().sig_failures, 2, 'both land on the same counter, deliberately');
    assert.equal(afterShop.reason, 'wrong_shop', 'the newer refusal must replace the older cause');
  });

  it('503s when a consumer cannot record — never a silent 200', async () => {
    // Shopify retries a 5xx for 48 hours. Acking something nobody stored loses it for good.
    __resetShopifyHooks(); CFG = testConfig();
    registerConsumer({ name: 'keepers', topics: ['orders/paid'], record: () => { throw new Error('disk gone'); } });
    const res = await post();
    assert.equal(res.statusCode, 503);
  });

  it('acks 200 for a topic no consumer wants, without calling anyone', async () => {
    const res = await post({ topic: 'orders/edited' });
    assert.equal(res.statusCode, 200);
    assert.equal(seen.length, 0);
    assert.equal(getShopifyHooksState().unwanted, 1);
  });

  it('400s a compliance topic delivered on the business path, and vice versa', async () => {
    assert.equal((await post({ topic: 'customers/redact' })).statusCode, 400);
    assert.equal((await post({ url: '/shopify/compliance', topic: 'orders/paid' })).statusCode, 400);
  });

  it('gives compliance topics to EVERY consumer, subscribed or not', async () => {
    // A redaction request is not something a consumer gets to opt out of.
    const res = await post({ url: '/shopify/compliance', topic: 'customers/redact' });
    assert.equal(res.statusCode, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].compliance, true);
  });

  it('400s a delivery with no webhook id or no topic', async () => {
    const body = '{"id":1}';
    assert.equal((await post({ headers: hookHeaders('orders/paid', body, { 'x-shopify-webhook-id': '' }) })).statusCode, 400);
    assert.equal((await post({ headers: hookHeaders('orders/paid', body, { 'x-shopify-topic': '' }) })).statusCode, 400);
  });

  it('still offers an unparseable body, rather than dropping the delivery', async () => {
    const body = 'not json at all';
    const res = await post({ body, headers: hookHeaders('orders/paid', body) });
    assert.equal(res.statusCode, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body, null);
    assert.equal(seen[0].raw, body, 'the raw bytes survive for the audit trail');
  });
});

describe('the app proxy', () => {
  const proxyQuery = (over = {}) => {
    const p = new URLSearchParams({
      shop: SHOP, path_prefix: '/apps/keepers',
      logged_in_customer_id: '8675309',
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...over,
    });
    const sig = crypto.createHmac('sha256', SECRET).update(buildSignedString(p), 'utf8').digest('hex');
    p.set('signature', sig);
    return p.toString();
  };

  const call = async (qs, { method = 'POST' } = {}) => {
    const res = fakeRes();
    await __handleRequestForTest(ENV, fakeReq({ method, url: `/apps/keepers?${qs}`, body: '' }), res, CFG);
    await res.done;
    return res;
  };

  it('503s when nothing is armed, rather than pretending to work', async () => {
    const res = await call(proxyQuery());
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).reason, 'not_armed');
  });

  it('passes a verified request to the handler with the customer gid', async () => {
    let got = null;
    registerProxyHandler((env, ctx) => { got = ctx; return { status: 200, body: { ok: true, xp: 50 } }; });
    const res = await call(proxyQuery());
    assert.equal(res.statusCode, 200);
    assert.equal(got.customerGid, 'gid://shopify/Customer/8675309');
    assert.deepEqual(JSON.parse(res.body), { ok: true, xp: 50 });
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('401s a tampered signature', async () => {
    registerProxyHandler(() => ({ status: 200, body: { ok: true } }));
    const qs = proxyQuery().replace('8675309', '1111111');
    assert.equal((await call(qs)).statusCode, 401);
  });

  it('401s a replayed old link', async () => {
    registerProxyHandler(() => ({ status: 200, body: { ok: true } }));
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await call(proxyQuery({ timestamp: old }));
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).reason, 'stale_timestamp');
  });

  it('REFUSES when logged_in_customer_id is empty, and never falls back', async () => {
    // This is the documented signed-out case AND the symptom of the open Shopify investigation into
    // it going empty for genuinely logged-in customers on new customer accounts. Both land here, and
    // the only acceptable outcome is asking them to tap again.
    let called = false;
    registerProxyHandler(() => { called = true; return { status: 200, body: {} }; });
    const res = await call(proxyQuery({ logged_in_customer_id: '' }));
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).reason, 'not_signed_in');
    assert.match(JSON.parse(res.body).message, /tap again/);
    assert.equal(called, false, 'the handler must never see an unidentified caller');
  });

  it('500s without leaking when the handler throws', async () => {
    registerProxyHandler(() => { throw new Error('boom: secret detail'); });
    const res = await call(proxyQuery());
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).reason, 'handler_failed');
    assert.doesNotMatch(res.body, /secret detail/, 'internal errors must not reach the caller');
  });

  it('routes sub-paths under the proxy path to the same handler', async () => {
    let hits = 0;
    registerProxyHandler(() => { hits++; return { status: 200, body: { ok: true } }; });
    const res = fakeRes();
    await __handleRequestForTest(ENV, fakeReq({ url: `/apps/keepers/checkin?${proxyQuery()}` }), res);
    await res.done;
    assert.equal(hits, 1);
  });
});

describe('topic vocabulary', () => {
  it('has no overlap between business and compliance topics', () => {
    for (const c of COMPLIANCE_TOPICS) assert.equal(BUSINESS_TOPICS.includes(c), false, c);
  });
  it('KNOWN_TOPICS is exactly the union', () => {
    assert.deepEqual([...KNOWN_TOPICS].sort(), [...BUSINESS_TOPICS, ...COMPLIANCE_TOPICS].sort());
  });
});
