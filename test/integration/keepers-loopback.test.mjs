// test/integration/keepers-loopback.test.mjs — the whole ingress chain, against a real socket.
//
// This is Stage 1 of the rollout ("inert") proven in CI rather than by hand: the listener binds, the
// route table holds, a genuinely signed delivery is verified and stored by the Keepers consumer, an
// unsigned one leaves no trace, and nothing else on the port is reachable.
//
// Nothing here touches Shopify. The webhook is signed locally with a test secret and posted to
// 127.0.0.1, and the consumer records it — the ingest that would follow needs the Admin API and is
// deliberately not exercised, so this test cannot hang on a network.
//
// Env is set BEFORE the dynamic imports on purpose: lib/config-paths.mjs captures CONFIG_DIR at import
// time, and a static import would be hoisted above the assignment. Same trap that made the first
// version of the receiver's unit tests pass a wrong-shop assertion for the wrong reason.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-keepers-loopback-'));
process.env.TCG_CONFIG_DIR = TMP;
process.env.TCG_KEEPERS_DB = path.join(TMP, 'keepers.db');
process.env.SHOPIFY_CLIENT_SECRET = 'shpss_' + 'f'.repeat(32);

const SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOP = 'binders-keepers-dev.myshopify.com';
// A port nothing else in this repo uses, so a developer running the app locally cannot collide.
const PORT = 5387;
const BASE = `http://127.0.0.1:${PORT}`;

let hooks; let keepers; let db;

before(async () => {
  fs.writeFileSync(path.join(TMP, 'shopify-hooks.config.json'), JSON.stringify({
    enabled: true, listen_host: '127.0.0.1', listen_port: PORT,
    webhook_path: '/shopify/keepers', compliance_path: '/shopify/compliance', proxy_path: '/apps/keepers',
    shop: 'dev', expect_shop_domain: SHOP,
    dispatch: { quiet_ms: 250, max_wait_ms: 1000, min_gap_ms: 0 },
  }));
  // mode 'off' so a delivery is recorded and NOTHING else happens — no Admin API, no ledger write.
  fs.writeFileSync(path.join(TMP, 'keepers.config.json'), JSON.stringify({
    mode: 'off', project: { enabled: false, allowLive: false }, store: 'dev',
    config_ttl_sec: 900, drain_limit: 50, sweep_max_per_run: 500, project_limit: 50, retain_days: 30,
  }));

  hooks = await import('../../lib/shopify-hooks.mjs');
  keepers = await import('../../lib/keepers.mjs');
  const dbm = await import('../../lib/keepers-db.mjs');
  db = dbm.openKeepersDb();

  keepers.registerKeepersConsumer({ SHOPIFY_CLIENT_SECRET: SECRET });
  hooks.startShopifyHooks({ SHOPIFY_CLIENT_SECRET: SECRET });

  // Give the listener a moment to bind before the first request.
  for (let i = 0; i < 40 && !hooks.getShopifyHooksState().listening; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
});

after(() => {
  try { hooks?.stopShopifyHooks(); } catch { /* already down */ }
  try { keepers?.stopKeepersJobs(); } catch { /* never started */ }
});

const sign = (body) => crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64');

async function deliver(body, over = {}) {
  return fetch(`${BASE}/shopify/keepers`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sign(body),
      'x-shopify-topic': 'orders/paid',
      'x-shopify-shop-domain': SHOP,
      'x-shopify-webhook-id': 'wh-' + crypto.randomUUID(),
      'x-shopify-triggered-at': new Date().toISOString(),
      'x-shopify-api-version': '2026-07',
      ...over,
    },
    body,
  });
}

const rows = () => db.prepare('SELECT COUNT(*) n FROM keepers_webhooks').get().n;

describe('the listener binds where it was told to', () => {
  it('is listening on loopback, on its own port', () => {
    const st = hooks.getShopifyHooksState();
    assert.equal(st.listening, true, st.bind_error || 'expected the listener to be up');
    assert.equal(st.host, '127.0.0.1');
    assert.equal(st.port, PORT);
    assert.equal(st.lan_bind, false);
  });

  it('reports the Keepers consumer and the topics it wants', () => {
    const st = hooks.getShopifyHooksState();
    assert.deepEqual(st.consumers.map((c) => c.name), ['keepers']);
    // The union always carries the three mandatory compliance topics.
    for (const t of hooks.COMPLIANCE_TOPICS) assert.ok(st.topics.includes(t), t);
    assert.ok(st.topics.includes('orders/paid'));
  });
});

describe('a genuinely signed delivery', () => {
  it('is verified, stored and acked 200', async () => {
    const before = rows();
    const res = await deliver(JSON.stringify({ id: 5001, admin_graphql_api_id: 'gid://shopify/Order/5001' }));
    assert.equal(res.status, 200);
    assert.equal(rows(), before + 1);
    const row = db.prepare('SELECT * FROM keepers_webhooks ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(row.topic, 'orders/paid');
    assert.equal(row.status, 'received');
    assert.equal(row.ref_id, 'gid://shopify/Order/5001');
  });

  it('is deduped on redelivery — at-least-once is normal, not an error', async () => {
    const body = JSON.stringify({ id: 5002, admin_graphql_api_id: 'gid://shopify/Order/5002' });
    const id = 'wh-' + crypto.randomUUID();
    const first = await deliver(body, { 'x-shopify-webhook-id': id });
    const before = rows();
    const second = await deliver(body, { 'x-shopify-webhook-id': id });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'a duplicate still acks — Shopify must not retry it');
    assert.equal(rows(), before, 'and nothing new is stored');
  });
});

describe('everything that should leave no trace', () => {
  it('401s an unsigned delivery and stores NOTHING', async () => {
    const before = rows();
    const res = await fetch(`${BASE}/shopify/keepers`, {
      method: 'POST',
      headers: { 'x-shopify-topic': 'orders/paid', 'x-shopify-shop-domain': SHOP, 'x-shopify-webhook-id': 'x' },
      body: '{"id":1}',
    });
    assert.equal(res.status, 401);
    assert.equal(rows(), before);
  });

  it('401s a delivery signed for a DIFFERENT shop', async () => {
    const before = rows();
    const res = await deliver('{"id":3}', { 'x-shopify-shop-domain': 'someone-else.myshopify.com' });
    assert.equal(res.status, 401);
    assert.equal(rows(), before);
  });

  it('401s a body that was tampered with after signing', async () => {
    const before = rows();
    const res = await fetch(`${BASE}/shopify/keepers`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': sign('{"id":1}'),
        'x-shopify-topic': 'orders/paid',
        'x-shopify-shop-domain': SHOP,
        'x-shopify-webhook-id': 'wh-' + crypto.randomUUID(),
      },
      body: '{"id":999}',
    });
    assert.equal(res.status, 401);
    assert.equal(rows(), before);
  });
});

describe('nothing else on this port is reachable', () => {
  it('404s every path that is not one of the three, with no body', async () => {
    // This is the isolation invariant proven against a real socket rather than against source text.
    for (const p of ['/', '/api/inventory', '/api/status', '/api/tracker', '/shopify', '/admin', '/apps']) {
      const res = await fetch(BASE + p);
      assert.equal(res.status, 404, p);
      assert.equal(await res.text(), '', `${p} must return no body`);
    }
  });

  it('405s a GET on the webhook path', async () => {
    assert.equal((await fetch(`${BASE}/shopify/keepers`)).status, 405);
  });

  it('serves the proxy path but refuses an unsigned call', async () => {
    const res = await fetch(`${BASE}/apps/keepers/checkin`, { method: 'POST' });
    assert.equal(res.status, 401, 'reachable, but not usable without a signature');
    const body = await res.json();
    assert.equal(body.ok, false);
  });
});

describe('the compliance path', () => {
  it('accepts a redact on its own path and refuses it on the business path', async () => {
    const body = JSON.stringify({ customer: { id: 8675309 }, admin_graphql_api_id: 'gid://shopify/Customer/8675309' });
    const onBusiness = await deliver(body, { 'x-shopify-topic': 'customers/redact' });
    assert.equal(onBusiness.status, 400, 'a compliance topic on the business path is a misconfiguration');

    const res = await fetch(`${BASE}/shopify/compliance`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': sign(body),
        'x-shopify-topic': 'customers/redact',
        'x-shopify-shop-domain': SHOP,
        'x-shopify-webhook-id': 'wh-' + crypto.randomUUID(),
      },
      body,
    });
    assert.equal(res.status, 200);
  });
});

describe('mode off really is off', () => {
  it('records deliveries and appends nothing to the ledger', async () => {
    await deliver(JSON.stringify({ id: 5003, admin_graphql_api_id: 'gid://shopify/Order/5003' }));
    // The dispatch is debounced; give it longer than quiet_ms to prove it stayed inert.
    await new Promise((r) => setTimeout(r, 600));
    const events = db.prepare('SELECT COUNT(*) n FROM keepers_events').get().n;
    const customers = db.prepare('SELECT COUNT(*) n FROM keepers_customers').get().n;
    assert.equal(events, 0, 'mode off must not write a ledger row');
    assert.equal(customers, 0, 'nor a customer row');
    assert.ok(rows() > 0, 'but the deliveries are all recorded, ready for the soak');
  });
});
