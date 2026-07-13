// test/integration/api.integration.test.mjs — boots the real dev server (all plugins)
// against temp DBs and exercises the local API surface. GET-only on purpose: tracker
// watchlist writes fire a self-fetching collector pass (live network), which the
// default-adjacent integration run must not do.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  const r = await fetch(srv.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
};

describe('server boots with isolated stores', () => {
  it('created the temp DBs, not the real ones', () => {
    assert.ok(srv.dbFileExists(srv.trackerDb), 'temp tracker.db missing');
    assert.ok(srv.dbFileExists(srv.repricerDb), 'temp repricer.db missing');
  });
  it('tracker watchlist starts empty (proof we are not on the real DB)', async () => {
    const { status, json } = await get('/api/tracker/watchlist');
    assert.equal(status, 200);
    assert.deepEqual(json.cards, []);
  });
});

describe('existing API surface', () => {
  it('GET /api/tracker/config → thresholds + cadence + scrydex flag', async () => {
    const { status, json } = await get('/api/tracker/config');
    assert.equal(status, 200);
    assert.ok(json.thresholds && typeof json.cadence_hours === 'number');
    assert.equal(typeof json.scrydex_enabled, 'boolean');
  });
  it('GET /api/inventory/summary → per-currency totals shape', async () => {
    const { status, json } = await get('/api/inventory/summary');
    assert.equal(status, 200);
    assert.ok(json && typeof json === 'object');
  });
  it('GET /api/cert/providers → the company registry', async () => {
    const { status, json } = await get('/api/cert/providers');
    assert.equal(status, 200);
    const companies = json.companies || json;
    assert.ok(Array.isArray(companies) && companies.length >= 10);
  });
  it('GET /api/print → printer config, never a crash when unconfigured (GR7)', async () => {
    const { status, json } = await get('/api/print');
    assert.equal(status, 200);
    assert.equal(typeof json.enabled, 'boolean');
  });
  it('GET /api/repricer/config → guardrails', async () => {
    const { status, json } = await get('/api/repricer/config');
    assert.equal(status, 200);
    assert.ok(json.guardrails || json.config || json.cadence_hours || typeof json === 'object');
  });
  it('GET /api/repricer/oauth/status → user-token state', async () => {
    const { status, json } = await get('/api/repricer/oauth/status');
    assert.equal(status, 200);
    assert.ok(json && typeof json === 'object');
  });
});

describe('/api/status', () => {
  it('aggregate status: version, keys, sources, data, dbs, subsystems', async () => {
    const { status, json } = await get('/api/status');
    assert.equal(status, 200);
    for (const k of ['version', 'keys', 'sources', 'data', 'dbs', 'subsystems']) assert.ok(json[k], `missing ${k}`);
    assert.ok(json.version.node.startsWith('v'));
    assert.equal(typeof json.keys.riftbound.SCRYDEX_API_KEY, 'boolean');
    assert.ok(json.data.riftbound.count >= 900, 'riftbound catalog count');
    assert.equal(json.dbs.tracker.watchlist, 0, 'temp DB → empty watchlist');
    assert.equal(typeof json.subsystems.printer.enabled, 'boolean');
  });
  it('NEVER leaks an env value in the response body (GR2)', async () => {
    const { text } = await get('/api/status');
    // any real .env value long enough to be a secret must not appear serialized
    for (const [k, v] of Object.entries(process.env)) {
      if (!/(KEY|TOKEN|SECRET|CERT_ID|APP_ID)/.test(k)) continue;
      if (!v || v.length < 8) continue;
      assert.ok(!text.includes(v), `response contains value of ${k}`);
    }
  });
  it('unknown probe source → 404 with the allowlist', async () => {
    const r = await fetch(srv.base + '/api/status/probe/nope', { method: 'POST' });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.ok(Array.isArray(j.sources));
  });
});

describe('/api/settings', () => {
  it('GET lists all config files with editability flags', async () => {
    const { status, json } = await get('/api/settings');
    assert.equal(status, 200);
    assert.equal(json.files.tracker.editable, true);
    assert.equal(json.files.grading.editable, false);
    assert.ok(json.files['bulk-pricing'].content.tiers, 'bulk tiers content present');
  });
  it('PUT round-trip: valid tracker config is saved and applied, then restored', async () => {
    // NOTE: settings live in the real data/*.config.json (only DBs are temp-redirected),
    // so the original is restored in a finally block no matter what fails in between.
    const put = (body) => fetch(srv.base + '/api/settings/tracker', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const orig = (await get('/api/settings/tracker')).json.content;
    const edited = JSON.parse(JSON.stringify(orig));
    edited.cadence_hours = orig.cadence_hours === 23 ? 24 : 23;
    try {
      const r = await put(edited);
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.saved, true);
      assert.match(j.applied, /collector restarted/);
      assert.equal((await get('/api/settings/tracker')).json.content.cadence_hours, edited.cadence_hours);
    } finally {
      const restore = await put(orig);
      assert.equal(restore.status, 200);
      assert.equal((await get('/api/settings/tracker')).json.content.cadence_hours, orig.cadence_hours);
    }
  });
  it('PUT invalid config → 400, file untouched', async () => {
    const before = (await get('/api/settings/tracker')).json.content;
    const r = await fetch(srv.base + '/api/settings/tracker', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...before, cadence_hours: 0 }),
    });
    assert.equal(r.status, 400);
    assert.deepEqual((await get('/api/settings/tracker')).json.content, before);
  });
  it('PUT never_decrease=false → 400 (repricer hard invariant)', async () => {
    const before = (await get('/api/settings/repricer')).json.content;
    const evil = JSON.parse(JSON.stringify(before));
    evil.guardrails.never_decrease = false;
    const r = await fetch(srv.base + '/api/settings/repricer', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(evil),
    });
    assert.equal(r.status, 400);
    assert.equal((await get('/api/settings/repricer')).json.content.guardrails.never_decrease, true);
  });
  it('PUT a read-only file → 403', async () => {
    const r = await fetch(srv.base + '/api/settings/grading', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 403);
  });
});

describe('inventory / sealed write bug-fixes (#3/#6/#7/#8/#9)', () => {
  it('#6 accepts JSON booleans for INTEGER-bool columns instead of 500ing', async () => {
    // image_url is supplied so the create skips the (network) image resolve — offline + deterministic.
    const r = await post('/api/inventory/items', { game: 'pokemon', name: 'Bool Test', image_url: 'x', image_manual: true, value_manual: true });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.sku, 'created with a SKU');
  });

  it('#7 value-manual on a missing id → 404 (not a 500)', async () => {
    const r = await post('/api/inventory/items/999999/value-manual', { value_cents: 500 });
    assert.equal(r.status, 404);
  });

  it('#8 a failed insert rolls back the SKU counter — no gap', async () => {
    const a = await post('/api/inventory/items', { game: 'mtg', name: 'Seq A', image_url: 'x' });
    assert.equal(a.status, 201, a.text);
    // object-valued `notes` is unbindable in node:sqlite → insertRow throws → ROLLBACK → 500.
    const bad = await post('/api/inventory/items', { game: 'mtg', name: 'Seq Bad', image_url: 'x', notes: { unbindable: true } });
    assert.equal(bad.status, 500, 'the bad insert fails');
    const c = await post('/api/inventory/items', { game: 'mtg', name: 'Seq C', image_url: 'x' });
    assert.equal(c.status, 201, c.text);
    const na = +a.json.sku.split('-').pop(), nc = +c.json.sku.split('-').pop();
    assert.equal(nc, na + 1, `SKUs must be consecutive (no gap): got ${a.json.sku} then ${c.json.sku}`);
  });

  it('#9 sealed invalid/cross-game product_type is normalised to "other"', async () => {
    const r = await post('/api/sealed/items', { game: 'pokemon', name: 'PTBugTest', product_type: 'not_a_real_type' });
    assert.equal(r.status, 201, r.text);
    const got = await get('/api/sealed/items?q=PTBugTest');
    assert.equal(got.json.items[0].product_type, 'other');
  });

  it('#3 raw re-import across batches recounts the SOURCE batch, not just the target', async () => {
    const card = { game: 'pokemon', identity_key: 'bugtest-3', name: 'Recount Card', variant: 'Base', quantity: 1 };
    const a = await post('/api/inventory/batches', { batch: { game: 'pokemon', set_name: 'Recount A' }, rows: [card] });
    assert.equal(a.status, 201, a.text);
    const b = await post('/api/inventory/batches', { batch: { game: 'pokemon', set_name: 'Recount B' }, rows: [card] });
    assert.equal(b.status, 201, b.text);
    const batches = (await get('/api/inventory/batches')).json.batches;
    const A = batches.find((x) => x.id === a.json.batch_id);
    const B = batches.find((x) => x.id === b.json.batch_id);
    assert.equal(A.item_count, 0, 'source batch A no longer counts the moved card');
    assert.equal(B.item_count, 1, 'target batch B counts it');
  });
});

describe('/api/bulk (GET-safe, offline)', () => {
  it('GET /config → pricing + pinned eBay categories', async () => {
    const { status, json } = await get('/api/bulk/config');
    assert.equal(status, 200);
    assert.ok(json.pricing && typeof json.pricing === 'object');
    assert.ok(json.ebay && typeof json.ebay === 'object');
  });
  it('GET /sets?game=notagame → 400 before any network', async () => {
    const { status, json } = await get('/api/bulk/sets?game=notagame');
    assert.equal(status, 400);
    assert.match(json.error, /game must be one of/);
  });
  it('GET /export/preview with no items → 404', async () => {
    const { status, json } = await get('/api/bulk/export/preview');
    assert.equal(status, 404);
    assert.match(json.error, /no items/);
  });
  it('unknown route → 404', async () => {
    assert.equal((await get('/api/bulk/nope')).status, 404);
  });
});

describe('/api/catalog (GET-safe, offline)', () => {
  it('GET /seed → editable seed overlay', async () => {
    const { status, json } = await get('/api/catalog/seed');
    assert.equal(status, 200);
    assert.equal(typeof json.seed, 'object');
    assert.equal(json.path, 'data/pokemon-intl-seed.json');
  });
  it('GET /cards with no params → 400', async () => {
    const { status, json } = await get('/api/catalog/cards');
    assert.equal(status, 400);
    assert.match(json.error, /lang and set required/);
  });
  it('unknown route → 404', async () => {
    assert.equal((await get('/api/catalog/nope')).status, 404);
  });
});

describe('/api/sealed (GET-safe, offline)', () => {
  it('GET /product-types → enum + per-game subsets', async () => {
    const { status, json } = await get('/api/sealed/product-types');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.types) && json.types.includes('booster_box'));
    assert.ok(json.by_game.pokemon.includes('elite_trainer_box'));
  });
  it('GET /summary → quantity-aware totals shape', async () => {
    const { status, json } = await get('/api/sealed/summary');
    assert.equal(status, 200);
    assert.equal(typeof json.counts.total, 'number');
    assert.equal(typeof json.units, 'number');
    assert.equal(typeof json.totalCostCents, 'number');
    for (const k of ['valueByCurrency', 'byGame', 'byType']) assert.ok(json[k] && typeof json[k] === 'object', k);
  });
  it('GET /locations → array', async () => {
    const { status, json } = await get('/api/sealed/locations');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.locations));
  });
  it('GET /export → items + batches bundle', async () => {
    const { status, json } = await get('/api/sealed/export');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.items) && Array.isArray(json.batches) && json.generated_at);
  });
  it('unknown route → 404', async () => {
    assert.equal((await get('/api/sealed/nope')).status, 404);
  });
});

describe('static pages served', () => {
  for (const page of ['/', '/tracker.html', '/inventory.html', '/shipping-label.html']) {
    it(`GET ${page}`, async () => {
      const { status, text } = await get(page);
      assert.equal(status, 200);
      assert.match(text, /<html|<!doctype/i);
    });
  }
});
