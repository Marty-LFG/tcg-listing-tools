// test/integration/keepers-admin.test.mjs — the /api/keepers admin surface, against a real booted
// server and a TEMP ledger.
//
// WHY THIS FILE EXISTS SEPARATELY from api.integration.test.mjs: that file is GET-only on purpose,
// and this one has to POST. Every POST here is either refused for a missing DIAG_TOKEN or refused by
// the mode/store gate — which is the point. The routes that reach Shopify (mint, revoke, sweep, pass,
// economy/refresh) are in the MUTATING list in test/invariants/integration-offline.test.mjs, so this
// file must never drive one to success; it drives them to their REFUSAL and asserts the refusal is
// deliberate rather than incidental.
//
// The refusals asserted below are guaranteed, not lucky:
//   · bootServer blanks DIAG_TOKEN via OFFLINE_ENV, so every gated route 403s.
//   · bootServer points TCG_KEEPERS_DB at a temp file, so nothing here can touch data/keepers.db.
//   · bootServer points TCG_CONFIG_DIR at a temp COPY, so the seeded keepers.config.json is a copy
//     and its mode is the example's, never the box's.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootServer } from '../helpers/boot-server.mjs';

let srv;
before(async () => { srv = await bootServer(); }, { timeout: 60_000 });
after(async () => { await srv?.close(); });

const get = async (p) => {
  const r = await fetch(srv.base + p);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
};
const post = async (p, body) => {
  const r = await fetch(srv.base + p, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
};

describe('the ledger under test is the TEMP one', () => {
  it('bootServer redirected TCG_KEEPERS_DB', () => {
    assert.ok(srv.keepersDb, 'bootServer must expose keepersDb — without the redirect these tests write real customer XP');
    assert.ok(!/[\\/]data[\\/]keepers\.db$/.test(srv.keepersDb), 'the test ledger must not be data/keepers.db');
  });

  it('the plugin created it, and it is empty', async () => {
    await get('/api/keepers/state');           // opening it is what creates the file
    assert.ok(fs.existsSync(srv.keepersDb), 'the temp ledger was never created');
    const { json } = await get('/api/keepers/customers');
    assert.deepEqual(json.rows, [], 'a fresh ledger has no customers — if this has rows we are on the real DB');
  });
});

describe('the read surface', () => {
  it('GET /state — engine plus receiver, on a box that has never run a pass', async () => {
    const { status, json } = await get('/api/keepers/state');
    assert.equal(status, 200);
    assert.ok(['off', 'observe', 'apply'].includes(json.mode), 'mode must be one of the three');
    assert.ok(['dev', 'live'].includes(json.store));
    assert.equal(typeof json.queue_depth, 'number');
    assert.ok(json.drift && typeof json.drift.missing === 'number');
    assert.ok(json.receiver, 'the receiver block is what the Queue tab renders');
  });

  it('GET /config — and it carries the grant vocabulary the form cannot otherwise reach', async () => {
    const { status, json } = await get('/api/keepers/config');
    assert.equal(status, 200);
    assert.ok(json.config, 'the config itself');
    assert.ok(Array.isArray(json.topics) && json.topics.length, 'the subscribed topics');
    // grant() refuses any reason outside GRANT_REASONS, so a page that hardcoded the list would turn
    // a drifted vocabulary into a 400 with no explanation.
    assert.ok(json.grant_reasons && typeof json.grant_reasons === 'object', 'grant_reasons must be served');
    assert.ok(Object.keys(json.grant_reasons).includes('goodwill'));
    assert.equal(typeof json.max_grant, 'number');
  });

  it('GET /webhooks — the queue view, which unlike /observations can show a FAILED delivery', async () => {
    const { status, json } = await get('/api/keepers/webhooks?limit=5');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.rows));
    // The whole reason this route exists rather than reusing /observations.
    const { json: obs } = await get('/api/keepers/observations?limit=5');
    assert.ok(Array.isArray(obs.rows), '/observations still works, it is just not a queue view');
  });

  it('GET /webhooks?status= filters rather than ignoring the parameter', async () => {
    const { status, json } = await get('/api/keepers/webhooks?status=failed');
    assert.equal(status, 200);
    assert.ok(json.rows.every((r) => r.status === 'failed'));
  });

  it('GET /redemptions — a listing endpoint at last; activeCodes only ever returned bare strings', async () => {
    const { status, json } = await get('/api/keepers/redemptions');
    assert.equal(status, 200);
    assert.deepEqual(json.rows, []);
  });

  it('GET /drift — the reconcile view', async () => {
    const { status, json } = await get('/api/keepers/drift');
    assert.equal(status, 200);
    assert.equal(json.clean, true);
    assert.deepEqual(json.counts, { missing: 0, extra: 0, unlinked: 0 });
  });

  it('GET /customers/<unknown> is a 404, not an empty object', async () => {
    const { status } = await get('/api/keepers/customers/' + encodeURIComponent('gid://shopify/Customer/1'));
    assert.equal(status, 404);
  });

  it('an unknown route is a bare 404 JSON, not the page', async () => {
    const { status, json } = await get('/api/keepers/nope');
    assert.equal(status, 404);
    assert.equal(json.error, 'unknown route');
  });
});

describe('the projection route is reachable — the /customers/ prefix does not swallow it', () => {
  // The trap this asserts against: `p.startsWith('/customers/')` matches '<gid>/projection' too, so a
  // projection route registered after it would be read as a customer id ending in '/projection' and
  // answer 404 'unknown customer'. A 503 for an uncached economy proves it reached the right branch.
  it('answers about the ECONOMY, not about an unknown customer', async () => {
    const gid = encodeURIComponent('gid://shopify/Customer/1');
    const { status, json } = await get(`/api/keepers/customers/${gid}/projection`);
    assert.notEqual(json.error, 'unknown customer', 'the prefix branch swallowed the projection route');
    assert.equal(status, 503, 'with no cached economy it must refuse, and say why');
    assert.match(json.error, /economy/i);
  });
});

describe('every mutating route refuses without a diag token', () => {
  // bootServer blanks DIAG_TOKEN through OFFLINE_ENV, so `diagOk` is false for all of them and the
  // refusal is guaranteed rather than incidental — the standard test/invariants/integration-offline
  // .test.mjs asks for.
  const GATED = [
    ['/api/keepers/grant', { customerGid: 'gid://shopify/Customer/1', xp: 10, reason: 'goodwill', idempotencyKey: 'k1' }],
    ['/api/keepers/grant-badge', { customerGid: 'gid://shopify/Customer/1', badgeId: 'first-pull' }],
    ['/api/keepers/checkin', { customerGid: 'gid://shopify/Customer/1' }],
    ['/api/keepers/redemptions', { customerGid: 'gid://shopify/Customer/1', tier: 'tier-500' }],
    ['/api/keepers/redemptions/1/mint', null],
    ['/api/keepers/redemptions/1/revoke', null],
    ['/api/keepers/sweep', null],
    ['/api/keepers/pass', null],
    ['/api/keepers/economy/refresh', null],
  ];

  for (const [path, body] of GATED) {
    it(`POST ${path} → 403`, async () => {
      const { status, json } = await post(path, body);
      assert.equal(status, 403, `${path} must be gated — it mutates`);
      assert.match(String(json.error), /diag token/i);
    });
  }
});

describe('the sweep dry-run flag is not decorative', () => {
  // It used to be read by the route and then dropped: runKeepersSweep did not take an `apply`
  // parameter at all, and sweepOrders defaults apply=true — so every "dry run" ingested orders,
  // advanced the cursor and released held events, under a comment saying DRY-RUN BY DEFAULT.
  it('runKeepersSweep accepts apply and passes it to sweepOrders', async () => {
    const src = fs.readFileSync(new URL('../../lib/keepers.mjs', import.meta.url), 'utf8');
    assert.match(src, /runKeepersSweep\(env, db, \{ nowMs = Date\.now\(\), apply = true \} = \{\}\)/,
      'runKeepersSweep must take apply');
    assert.match(src, /maxPerRun: cfg\.sweep_max_per_run, nowMs, apply,/,
      'apply must reach sweepOrders, or the flag is a seatbelt wired to nothing');
  });

  it('the route echoes which mode it ran in, so a reader cannot mistake one for the other', async () => {
    const src = fs.readFileSync(new URL('../../lib/keepers.mjs', import.meta.url), 'utf8');
    assert.match(src, /send\(200, \{ apply, \.\.\.\(await runKeepersSweep/);
  });
});
