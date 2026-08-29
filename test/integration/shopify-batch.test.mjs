// test/integration/shopify-batch.test.mjs — the Shopify BATCH publish path, through the routes.
//
// shopify-publish.test.mjs already covers one card end to end, and the batch calls that same
// runShopifyPublish unchanged. What only this test can catch is the behaviour a batch ADDS:
//   · one bad row never takes the rest of the run with it (GR7)
//   · rows are published ONE AT A TIME — the shelf-label claim is the upsert key, so overlap would
//     silently overwrite a product rather than fail, and nothing downstream would notice
//   · a refusal (never reached the store) is reported differently from a failure (did reach it)
//   · an already-live row is skipped by default and re-pushed under force
//   · the run is audited in channel_exports, and a dry run is NOT
//   · preflight answers without credentials, pins, or a single network call
//
// Same harness shape as shopify-publish.test.mjs: own temp DB, own stubbed fetch, own config path.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDbAt } from '../../lib/db.mjs';
import { seedStockLabels } from '../../lib/inventory.mjs';

// SHOPIFY_SHOP is set here deliberately, and it is what makes the live-guard tests mean anything.
// Without it guardCredentials refuses store=live as not_connected and the guard below is never
// reached — which is the state of a developer box, and NOT the state of the box that trades. ALCSERVER
// carries both shops in its .env, so the tests model that and not the safer accident.
const ENV = {
  SHOPIFY_SHOP: 'gkrnva-1k',
  SHOPIFY_DEV_SHOP: 'binders-keepers-dev',
  SHOPIFY_CLIENT_ID: 'fake-client-id',
  SHOPIFY_CLIENT_SECRET: 'fake-client-secret',
};

// Set before importing lib/shopify.mjs, so its module-level const sees the temp path and the
// operator's real data/shopify.config.json is never touched.
const CONFIG_PATH = path.join(os.tmpdir(), 'tcg-shopify-batch-cfg-' + process.pid + '.json');
process.env.TCG_SHOPIFY_CONFIG = CONFIG_PATH;
const { makeShopifyRouter, shopifyBatchPreflight } = await import('../../lib/shopify.mjs');

let db, tmpDir, server, base, calls, bend, inFlight, maxInFlight;

function resp(status, json) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => (json == null ? '' : JSON.stringify(json)),
  };
}

// Plays Shopify plus the image lab's /build route, which the publish path self-fetches.
// `productSet` is where overlap would show, so the concurrency watermark is taken around it.
async function stub(url, init = {}) {
  const u = String(url);

  if (u.includes('/api/listing-image/build')) {
    calls.push({ op: 'compose' });
    const sku = /sku=([A-Z0-9-]+)/.exec(u)?.[1] || 'AAC-097';
    return resp(200, {
      manifest: {
        sku, alt: 'front',
        images: [{ position: 1, view: 'front', filename: sku + '-1-front.jpg', alt: 'front', contentHash: 'h-front', composeVersion: 'v1', width: 1512, height: 2112, bytes: 16 }],
        social: { view: 'og', filename: sku + '-og.jpg', alt: 'og', contentHash: 'h-og', composeVersion: 'v1', width: 1200, height: 630, bytes: 16 },
      },
      warnings: [],
    });
  }
  if (u.includes('/admin/oauth/access_token')) return resp(200, { access_token: 't', scope: 'write_products', expires_in: 86399 });

  const body = JSON.parse(init.body);
  const q = body.query, v = body.variables;

  if (q.includes('metaobjectUpsert')) {
    calls.push({ op: q.includes('BkIdentityListings') ? 'identityListings' : 'identity' });
    return resp(200, { data: { metaobjectUpsert: { metaobject: { id: 'gid://shopify/Metaobject/9', handle: v.handle.handle }, userErrors: [] } } });
  }
  if (q.includes('productSet')) {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const sku = v.input.variants[0].sku;
      calls.push({ op: 'productSet', sku, variables: v });
      // Yield, so that IF two rows were ever in flight together the watermark would see it. Without
      // an await here a synchronous stub could never expose overlap even if the batch had it.
      await new Promise((r) => setTimeout(r, 1));
      if (bend.productSetFor && bend.productSetFor.has(sku)) {
        return resp(200, { data: { productSet: { userErrors: [{ field: null, message: 'the store said no', code: 'INVALID' }] } } });
      }
      return resp(200, { data: { productSet: { product: {
        id: 'gid://shopify/Product/' + sku, handle: v.input.handle, status: v.input.status,
        variants: { nodes: [{ id: 'gid://shopify/ProductVariant/' + sku, sku, inventoryItem: { id: 'gid://shopify/InventoryItem/' + sku } }] },
      }, userErrors: [] } } });
    } finally { inFlight--; }
  }
  if (q.includes('inventoryItem(id:')) { calls.push({ op: 'readLevel' }); return resp(200, { data: { inventoryItem: { inventoryLevels: { nodes: [] } } } }); }
  if (q.includes('inventoryActivate')) {
    calls.push({ op: 'activate' });
    // bend.inventory models step 3 failing AFTER productSet has already created the product — the
    // shape that makes a naive retry mint a new label.
    if (bend.inventory) return resp(200, { data: { inventoryActivate: { userErrors: [{ field: null, message: bend.inventory }] } } });
    return resp(200, { data: { inventoryActivate: { inventoryLevel: { id: 'gid://shopify/InventoryLevel/1', quantities: [{ name: 'available', quantity: v.available }] }, userErrors: [] } } });
  }
  if (q.includes('publishablePublish')) {
    calls.push({ op: 'publish' });
    if (bend.publish) return resp(200, { data: { publishablePublish: { userErrors: [{ field: null, message: bend.publish }] } } });
    return resp(200, { data: { publishablePublish: { publishable: { availablePublicationsCount: { count: 1 } }, userErrors: [] } } });
  }
  if (q.includes('node(id:')) {
    calls.push({ op: 'verify' });
    return resp(200, { data: {
      location: { id: v.loc, name: 'Shop location', isActive: true, fulfillsOnlineOrders: true, shipsInventory: true },
      publication: { id: v.pub, name: 'Online Store' },
    } });
  }
  throw new Error('unstubbed call: ' + (q || u).slice(0, 90));
}

function seedMediaCache() {
  for (const [h, gid] of [['h-front', 'gid://shopify/MediaImage/1'], ['h-og', 'gid://shopify/MediaImage/2']]) {
    db.prepare(`INSERT INTO shopify_files (content_hash, file_gid, status, ready_at) VALUES (?,?,'ready',datetime('now'))
                ON CONFLICT(content_hash) DO UPDATE SET file_gid = excluded.file_gid, status = 'ready'`).run(h, gid);
  }
}

const CFG = {
  defaultStore: 'dev',
  stores: { dev: { locationGid: 'gid://shopify/Location/1', publicationGid: 'gid://shopify/Publication/2' } },
  publish: { enabled: true, status: 'ACTIVE' },
  sync: { enabled: false },
  collections: {},
};
function writeConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

// One in_stock Pokémon single. `number` varies so each row is its own identity unless told otherwise.
//
// The provisional SKU must be STG- followed by DIGITS. reserveShelfLabel only treats that exact shape
// as staged; anything else (STG-Alpha) is read as a row that already carries its real label, so no
// label is reserved and validateProduct then refuses it on "provisional SKU". Cost me an afternoon.
let stgSeq = 0;
function addItem({ name, number = '58/102', price = 1299, condition = 'Near Mint', status = 'in_stock', game = 'pokemon' } = {}) {
  const sku = 'STG-' + String(++stgSeq).padStart(6, '0');
  const r = db.prepare(`INSERT INTO inventory_items
    (sku, game, identity_key, name, set_name, number, rarity, variant, language, condition, quantity, target_price_cents, image_url, status)
    VALUES (?,?,?,?,'Base Set',?,'Common','Regular','EN',?,1,?,'https://images.pokemontcg.io/base1/58.png',?)`)
    .run(sku, game, 'base1-' + number.replace('/', '-'), name, number, condition, price, status);
  return Number(r.lastInsertRowid);
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-shopify-batch-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
  const route = '/api/shopify';
  const fn = makeShopifyRouter({ env: ENV, db, base: 'http://127.0.0.1:1', fetchImpl: stub });
  server = http.createServer((req, res) => {
    const p = String(req.url).split('?')[0];
    if (p !== route && !p.startsWith(route + '/')) { res.statusCode = 404; return res.end('{}'); }
    req.url = req.url.slice(route.length) || '/';
    fn(req, res, () => { res.statusCode = 404; res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
}, { timeout: 60_000 });

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.unlinkSync(CONFIG_PATH); } catch { /* already gone */ }
});

beforeEach(() => {
  calls = []; bend = {}; inFlight = 0; maxInFlight = 0; stgSeq = 0;
  writeConfig(CFG);
  db.exec('DELETE FROM inventory_items; DELETE FROM shopify_listings; DELETE FROM shopify_files; DELETE FROM sku_counter; DELETE FROM channel_exports;');
  seedStockLabels(db, 294);   // next free label is AAC-097
  seedMediaCache();
});

const API = '/api/shopify';
const post = async (p, body) => {
  const r = await fetch(base + API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* ndjson or empty */ }
  return { status: r.status, json: j, text: t };
};
// The batch answers NDJSON, so the records are parsed per line.
const postStream = async (p, body) => {
  const r = await post(p, body);
  const events = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    status: r.status, events,
    start: (events.find((e) => e.start) || {}).start,
    rows: events.filter((e) => e.row).map((e) => e.row),
    summary: (events.find((e) => e.summary) || {}).summary,
  };
};
const mirror = (sku) => db.prepare('SELECT * FROM shopify_listings WHERE sku = ?').get(sku);

// ---------------------------------------------------------------------------
describe('runShopifyBatchPublish — the happy path', () => {
  it('publishes every row and closes with one summary', async () => {
    const ids = [addItem({ name: 'Alpha', number: '58/102' }), addItem({ name: 'Beta', number: '59/102' })];
    const r = await postStream('/publish/batch', { itemIds: ids });

    assert.equal(r.status, 200, r.text);
    assert.equal(r.start.total, 2);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows.map((x) => x.status), ['published', 'published']);
    assert.equal(r.summary.published, 2);
    assert.equal(r.summary.failed, 0);
    assert.equal(r.summary.skipped, 0);
  });

  it('gives each row its own shelf label, in order', async () => {
    const ids = [addItem({ name: 'Alpha', number: '58/102' }), addItem({ name: 'Beta', number: '59/102' })];
    const r = await postStream('/publish/batch', { itemIds: ids });
    assert.deepEqual(r.rows.map((x) => x.sku), ['AAC-097', 'AAC-098']);
    assert.equal(mirror('AAC-097').state, 'live');
    assert.equal(mirror('AAC-098').state, 'live');
  });

  // The load-bearing one. Two rows in flight at once would peek the same free label, and the second
  // productSet would overwrite the first row's product with no error anywhere — 19 products from 20
  // cards. Nothing else in the suite would catch that, so it is asserted directly.
  it('never has two rows in flight at once', async () => {
    const ids = [1, 2, 3, 4].map((n) => addItem({ name: 'C' + n, number: n + '/102' }));
    await postStream('/publish/batch', { itemIds: ids });
    assert.equal(maxInFlight, 1, 'productSet overlapped — the shelf-label claim is no longer safe');
    assert.equal(calls.filter((c) => c.op === 'productSet').length, 4);
  });

  it('audits the run in channel_exports under the shopify channel', async () => {
    const ids = [addItem({ name: 'Alpha', number: '58/102' })];
    await postStream('/publish/batch', { itemIds: ids });
    const row = db.prepare("SELECT * FROM channel_exports WHERE channel = 'shopify'").get();
    assert.ok(row, 'the run left no audit trail');
    assert.equal(row.marketplace, 'dev');
    assert.deepEqual(JSON.parse(row.item_ids), ids);
    assert.equal(JSON.parse(row.result).published, 1);
  });
});

// ---------------------------------------------------------------------------
describe('one bad row never takes the run with it (GR7)', () => {
  it('keeps going after a row the store refuses, and counts it as failed', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const b = addItem({ name: 'Beta', number: '59/102' });
    const c = addItem({ name: 'Gamma', number: '60/102' });
    bend.productSetFor = new Set(['AAC-098']);   // the second label, i.e. Beta

    const r = await postStream('/publish/batch', { itemIds: [a, b, c] });
    assert.deepEqual(r.rows.map((x) => x.status), ['published', 'failed', 'published']);
    assert.equal(r.summary.published, 2);
    assert.equal(r.summary.failed, 1);
  });

  it('reports a missing stock row without stopping', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const r = await postStream('/publish/batch', { itemIds: [999999, a] });
    assert.equal(r.rows[0].status, 'failed');
    assert.match(r.rows[0].error, /not found/);
    assert.equal(r.rows[1].status, 'published');
    assert.equal(r.summary.published, 1);
  });

  // A row refused locally never reached Shopify; a row that failed at the store did. Collapsing the
  // two would tell an operator to go looking at the store for a problem in their own data.
  it('separates a local refusal from a store failure', async () => {
    const bad = addItem({ name: 'Sealed', number: '61/102', game: 'sealed-thing' });
    const r = await postStream('/publish/batch', { itemIds: [bad] });
    assert.equal(r.rows[0].status, 'refused');
    assert.equal(r.summary.refused, 1);
    assert.equal(r.summary.failed, 0, 'a refusal is not a failure');
    assert.equal(calls.filter((c) => c.op === 'productSet').length, 0, 'a refused row must not reach the store');
  });
});

// ---------------------------------------------------------------------------
describe('already-live rows', () => {
  it('skips a row that is already live, by default', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    await postStream('/publish/batch', { itemIds: [a] });
    calls = [];

    const again = await postStream('/publish/batch', { itemIds: [a] });
    assert.equal(again.rows[0].status, 'skipped');
    assert.equal(again.summary.skipped, 1);
    assert.equal(calls.filter((c) => c.op === 'productSet').length, 0, 'a skip must cost no round trip');
  });

  it('re-pushes the same row under force — productSet upserts, so this is a revise not a duplicate', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    await postStream('/publish/batch', { itemIds: [a] });
    calls = [];

    const again = await postStream('/publish/batch', { itemIds: [a], force: true });
    assert.equal(again.rows[0].status, 'published');
    const sets = calls.filter((c) => c.op === 'productSet');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].sku, 'AAC-097', 'the re-push must reuse the same label, or it is a new product');
  });
});

// ---------------------------------------------------------------------------
describe('the dry run', () => {
  it('reports what would publish, writes no mirror row, and leaves no audit', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const r = await postStream('/publish/batch', { itemIds: [a], dryRun: true });
    assert.equal(r.rows[0].status, 'would_publish');
    assert.equal(mirror('AAC-097'), undefined, 'a dry run must not write a mirror row');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM channel_exports WHERE channel = 'shopify'").get().n, 0,
      'channel_exports records what we SENT, and a dry run sent nothing');
  });

  it('runs even when publishing is disarmed — that is the point of it', async () => {
    writeConfig({ ...CFG, publish: { enabled: false, status: 'ACTIVE' } });
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const dry = await postStream('/publish/batch', { itemIds: [a], dryRun: true });
    assert.equal(dry.rows[0].status, 'would_publish');

    const real = await post('/publish/batch', { itemIds: [a] });
    assert.equal(real.status, 409, 'a disarmed store must refuse a real batch');
  });
});

// ---------------------------------------------------------------------------
describe('preflight', () => {
  it('answers without a single network call', async () => {
    const ids = [addItem({ name: 'Alpha', number: '58/102' }), addItem({ name: 'Beta', number: '59/102' })];
    const r = await post('/publish/preflight', { itemIds: ids });
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 2);
    assert.equal(r.json.publishable, 2);
    assert.equal(calls.length, 0, 'preflight must call nothing');
  });

  it('names the rows that would be refused, and does not count them publishable', async () => {
    const ok = addItem({ name: 'Alpha', number: '58/102' });
    const bad = addItem({ name: 'Sealed', number: '61/102', game: 'sealed-thing' });
    const r = await post('/publish/preflight', { itemIds: [ok, bad] });
    assert.equal(r.json.publishable, 1);
    assert.equal(r.json.refused, 1);
    const row = r.json.rows.find((x) => x.item_id === bad);
    assert.equal(row.ok, false);
    assert.ok(row.errors.length, 'a refused row must say why');
  });

  it('reports a missing stock row rather than throwing', async () => {
    const r = await post('/publish/preflight', { itemIds: [999999] });
    assert.equal(r.status, 200);
    assert.equal(r.json.rows[0].missing, true);
  });

  it('flags already-live rows without refusing them', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    await postStream('/publish/batch', { itemIds: [a] });
    const r = await post('/publish/preflight', { itemIds: [a] });
    assert.equal(r.json.alreadyLive, 1);
    assert.equal(r.json.publishable, 0);
    assert.equal(r.json.rows[0].ok, true, 'already live is not a validation failure');
  });

  // The batch-level check. productHandleFor for an ungraded card is identityHandle + condition code
  // and carries nothing distinguishing one physical copy from another, so N copies of one card in one
  // condition collide on a single handle while carrying N different SKUs as the customId. Every row
  // passes validation on its own; only looking at the batch reveals it. Found on real stock — six
  // Radiant Gardevoirs.
  it('flags rows in the same batch that map to one product handle', async () => {
    const ids = [1, 2, 3].map(() => addItem({ name: 'Radiant Gardevoir', number: '69/196' }));
    const r = await post('/publish/preflight', { itemIds: ids });

    assert.equal(r.json.collisions.length, 1, 'three copies of one card in one condition is one collision');
    const c = r.json.collisions[0];
    assert.equal(c.count, 3);
    assert.deepEqual(c.itemIds.sort((a, b) => a - b), ids.sort((a, b) => a - b));
    // An ERROR, not a warning: a collision that is reported and then published anyway is worse than
    // one never detected, because the run claims three successes while two cards are overwritten.
    for (const row of r.json.rows) {
      assert.equal(row.ok, false, 'a colliding row must not be publishable');
      assert.ok(row.errors.some((e) => /same product handle/.test(e)), 'every colliding row must say so');
      assert.equal(row.collidesWith.length, 2);
    }
    assert.equal(r.json.publishable, 0);
  });

  it('does not flag distinct cards, or one card in different conditions', async () => {
    const ids = [
      addItem({ name: 'Alpha', number: '58/102' }),
      addItem({ name: 'Beta', number: '59/102' }),
      addItem({ name: 'Alpha', number: '58/102', condition: 'Lightly Played' }),
    ];
    const r = await post('/publish/preflight', { itemIds: ids });
    assert.deepEqual(r.json.collisions, [], 'different cards and different conditions are different products');
  });

  // Same reasoning as /preview: this is most useful precisely when the store is misconfigured.
  it('still answers when the store is not pinned', async () => {
    writeConfig({ ...CFG, stores: { dev: { locationGid: '', publicationGid: '' } } });
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const r = await post('/publish/preflight', { itemIds: [a] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.pins.missing.sort(), ['locationGid', 'publicationGid']);
  });
});

// ---------------------------------------------------------------------------
// The live store is opt-in on its own. storeFor() reads ?store= off the query string with no
// allowlist, so without this guard arming publish.enabled for the dev gate also arms live, and the
// only thing between ?store=live and a real product on the real shop is that nobody typed it.
describe('the live store is a separate switch', () => {
  const LIVE_PINNED = {
    ...CFG,
    stores: { ...CFG.stores, live: { locationGid: 'gid://shopify/Location/9', publicationGid: 'gid://shopify/Publication/9' } },
  };

  it('refuses a live batch even when publishing is armed', async () => {
    writeConfig({ ...LIVE_PINNED, publish: { enabled: true, status: 'ACTIVE' } });   // allowLive absent
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const r = await post('/publish/batch?store=live', { itemIds: [a] });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'live_not_allowed');
    assert.equal(calls.length, 0, 'nothing may reach the store');
  });

  it('refuses a live single publish the same way', async () => {
    writeConfig({ ...LIVE_PINNED, publish: { enabled: true, status: 'ACTIVE' } });
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const r = await post('/publish?store=live', { itemId: a });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'live_not_allowed');
  });

  // rebuildIdentity always performs a metaobjectUpsert, so on live it is a real write however invoked.
  it('refuses a live identity rebuild, with no dry-run escape', async () => {
    writeConfig({ ...LIVE_PINNED, publish: { enabled: true, status: 'ACTIVE' } });
    const r = await post('/identity/rebuild?store=live', { handle: 'pokemon-base1-58-base-en' });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'live_not_allowed');
    assert.equal(calls.length, 0);
  });

  it('fails CLOSED — an absent allowLive is not permission', async () => {
    const cfg = { ...LIVE_PINNED, publish: { enabled: true, status: 'ACTIVE' } };
    assert.equal(cfg.publish.allowLive, undefined, 'the key is deliberately absent in this fixture');
    writeConfig(cfg);
    const a = addItem({ name: 'Alpha', number: '58/102' });
    assert.equal((await post('/publish/batch?store=live', { itemIds: [a] })).json.code, 'live_not_allowed');
  });

  it('is not satisfied by a truthy non-true value', async () => {
    writeConfig({ ...LIVE_PINNED, publish: { enabled: true, status: 'ACTIVE', allowLive: 'yes' } });
    const a = addItem({ name: 'Alpha', number: '58/102' });
    assert.equal((await post('/publish/batch?store=live', { itemIds: [a] })).json.code, 'live_not_allowed');
  });

  // A dry run returns before publishProduct's first network call, so it writes nothing anywhere —
  // and "what would live receive" is a fair question to ask without arming anything.
  it('allows a live DRY RUN, which writes nothing', async () => {
    writeConfig({ ...LIVE_PINNED, publish: { enabled: false, status: 'ACTIVE' } });
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const r = await postStream('/publish/batch?store=live', { itemIds: [a], dryRun: true });
    assert.equal(r.rows[0].status, 'would_publish');
    assert.equal(r.summary.store, 'live');
    assert.equal(calls.filter((c) => c.op === 'productSet').length, 0, 'a dry run must not reach the store');
    assert.equal(mirror('AAC-097'), undefined, 'and must not write a mirror row');
  });

  it('lets a live batch through once allowLive is explicitly true', async () => {
    writeConfig({ ...LIVE_PINNED, publish: { enabled: true, status: 'ACTIVE', allowLive: true } });
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const r = await postStream('/publish/batch?store=live', { itemIds: [a] });
    assert.equal(r.rows[0].status, 'published');
    assert.equal(r.summary.store, 'live');
  });

  it('never affects the dev store', async () => {
    writeConfig({ ...CFG, publish: { enabled: true, status: 'ACTIVE' } });   // allowLive absent
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const r = await postStream('/publish/batch', { itemIds: [a] });
    assert.equal(r.rows[0].status, 'published', 'the dev path must be untouched by the live guard');
  });

  // "Disarmed" has to mean disarmed for every route that writes. /identity/rebuild was passing only
  // credentials and the live guard, so with publish.enabled false it still performed a metaobjectUpsert
  // against the store while /publish returned 409.
  it('refuses an identity rebuild while publishing is disarmed', async () => {
    writeConfig({ ...CFG, publish: { enabled: false, status: 'ACTIVE' } });
    const r = await post('/identity/rebuild', { handle: 'pokemon-base1-58-base-en' });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'publish_disabled');
    assert.equal(calls.length, 0, 'nothing may reach the store while disarmed');
  });

  it('allows an identity rebuild once armed', async () => {
    writeConfig({ ...CFG, publish: { enabled: true, status: 'ACTIVE' } });
    const r = await post('/identity/rebuild', { handle: 'pokemon-base1-58-base-en' });
    assert.equal(r.status, 200);
  });

  it('reports allowLive on /config so a client can show it', async () => {
    writeConfig({ ...CFG, publish: { enabled: true, status: 'ACTIVE' } });
    const r = await (async () => { const x = await fetch(base + API + '/config'); return x.json(); })();
    assert.equal(r.allowLive, false);
  });
});

// ---------------------------------------------------------------------------
// The retry path. publishProduct fails at step 3 (inventory) and step 4 (publish) with productGid
// ALREADY SET — the product exists on the store — and runShopifyPublish returns before
// commitShelfLabel, so inventory_items.sku is still STG-*. On the re-run labelTaken sees this row's
// OWN claim row in shopify_listings and reports the label taken, so the retry would take the NEXT
// label. That label is the custom.id productSet upserts on, while `handle` is sent explicitly from
// identity+condition — so a retry under a new label is a CREATE at a handle the orphan already owns.
// Both drivers print "a re-run never duplicates, it upserts" on exactly these rows.
describe('a retry must reuse the label it already claimed', () => {
  it('keeps the same SKU after a failure that already created the product', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });

    bend.inventory = 'the location will not stock this';
    const first = await postStream('/publish/batch', { itemIds: [a] });
    assert.equal(first.rows[0].status, 'failed');
    const m1 = mirror('AAC-097');
    assert.ok(m1 && m1.product_gid, 'the product was created before the failure — that is the premise');
    assert.equal(db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(a).sku.startsWith('STG-'), true,
      'the label was never committed, so the stock row is still provisional');

    bend.inventory = null;
    const second = await postStream('/publish/batch', { itemIds: [a] });
    assert.equal(second.rows[0].status, 'published');
    assert.equal(second.rows[0].sku, 'AAC-097', 'the retry must reuse the claimed label, or it creates a second product');

    const sets = calls.filter((c) => c.op === 'productSet');
    assert.equal(sets[sets.length - 1].sku, 'AAC-097', 'the customId sent on the retry is the upsert key');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM shopify_listings WHERE item_id = ?').get(a).n, 1,
      'one card, one mirror row — a second row means a second product');
  });

  it('does not strand the row when the publish step is what failed', async () => {
    const a = addItem({ name: 'Beta', number: '59/102' });
    bend.publish = 'channel unavailable';
    await postStream('/publish/batch', { itemIds: [a] });
    bend.publish = null;
    const second = await postStream('/publish/batch', { itemIds: [a] });
    assert.equal(second.rows[0].sku, 'AAC-097');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM shopify_listings WHERE item_id = ?').get(a).n, 1);
  });

  // A half-published row is not a fresh row, and the preflight collapsing the mirror to
  // state==='live' loses exactly that distinction.
  it('preflight reports a half-published row rather than calling it publishable', async () => {
    const a = addItem({ name: 'Gamma', number: '60/102' });
    bend.inventory = 'nope';
    await postStream('/publish/batch', { itemIds: [a] });
    bend.inventory = null;

    const pf = await post('/publish/preflight', { itemIds: [a] });
    const row = pf.json.rows[0];
    assert.equal(row.halfPublished, true, 'a row with a product on the store but no successful publish is not fresh');
    assert.ok(row.warnings.some((w) => /already exists/i.test(w)));
  });
});

// ---------------------------------------------------------------------------
describe('a row marked sold must never publish', () => {
  // The harmful shape is sold-at-quantity-1, not sold-at-zero: every manual sold-marking path leaves
  // quantity at its NOT NULL DEFAULT 1, and quantity 0 is only a warning. So a card sold at a show
  // comes back from the preflight clean and publishes ACTIVE, available 1, DENY — a purchasable
  // one-of-one that does not exist (bk-shopify invariant 3).
  it('refuses it in validation, so every caller is covered', async () => {
    const a = addItem({ name: 'Sold Card', number: '61/102', status: 'sold' });
    const pf = await post('/publish/preflight', { itemIds: [a] });
    assert.equal(pf.json.refused, 1);
    assert.equal(pf.json.publishable, 0);
    assert.ok(pf.json.rows[0].errors.some((e) => /sold/i.test(e)));
  });

  it('and the batch refuses it even when asked directly by id', async () => {
    const a = addItem({ name: 'Sold Card', number: '61/102', status: 'sold' });
    const r = await postStream('/publish/batch', { itemIds: [a] });
    assert.equal(r.rows[0].status, 'refused');
    assert.equal(calls.filter((c) => c.op === 'productSet').length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('colliding rows are gated, not merely announced', () => {
  it('refuses every row of a collision rather than publishing them onto one handle', async () => {
    const ids = [1, 2, 3].map(() => addItem({ name: 'Radiant Gardevoir', number: '69/196' }));
    const r = await postStream('/publish/batch', { itemIds: ids });
    assert.equal(r.summary.published, 0, 'none may publish — the last would silently win');
    assert.equal(r.summary.refused, 3);
    assert.equal(calls.filter((c) => c.op === 'productSet').length, 0);
  });

  it('does not count colliding rows as publishable', async () => {
    const ids = [1, 2].map(() => addItem({ name: 'Radiant Gardevoir', number: '69/196' }));
    const pf = await post('/publish/preflight', { itemIds: ids });
    assert.equal(pf.json.publishable, 0);
    assert.equal(pf.json.refused, 2);
  });
});

// ---------------------------------------------------------------------------
// The shape productSet actually accepts. Measured against the real dev store 2026-08-25: the
// identifying metafield MUST be present (Shopify refuses otherwise, to stop the identifier being
// deleted by omission) and MUST NOT carry its `type`, or the entry fails to match the identifier and
// the mutation is refused with METAFIELD_MISMATCH — an error whose wording says the value is absent
// when it is present and correct but for one extra key. The stub cannot re-derive that rule, so it is
// asserted directly on the payload.
describe('the custom.id metafield is sent in the shape productSet accepts', () => {
  it('is present in the metafields array, and carries no type', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    await postStream('/publish/batch', { itemIds: [a] });

    const set = calls.find((c) => c.op === 'productSet');
    assert.ok(set, 'productSet was never called');
    const mfs = set.variables.input.metafields || [];
    const idMf = mfs.find((m) => m.namespace === 'custom' && m.key === 'id');

    assert.ok(idMf, 'omitting it is refused: Shopify will not let the identifier be dropped by omission');
    assert.equal(idMf.value, 'AAC-097');
    assert.ok(!('type' in idMf), 'sending `type` on the identifying metafield is what causes METAFIELD_MISMATCH');
  });

  it('leaves every other metafield carrying its type', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    await postStream('/publish/batch', { itemIds: [a] });
    const mfs = calls.find((c) => c.op === 'productSet').variables.input.metafields || [];
    const others = mfs.filter((m) => !(m.namespace === 'custom' && m.key === 'id'));
    assert.ok(others.length >= 5, 'expected the bkc.* set');
    for (const m of others) assert.ok(m.type, `${m.namespace}.${m.key} lost its type — only the identifier is special`);
  });

  it('sends the identifier and the metafield with the same value', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    await postStream('/publish/batch', { itemIds: [a] });
    const v = calls.find((c) => c.op === 'productSet').variables;
    const idMf = (v.input.metafields || []).find((m) => m.namespace === 'custom' && m.key === 'id');
    assert.deepEqual(
      { namespace: v.identifier.customId.namespace, key: v.identifier.customId.key, value: v.identifier.customId.value },
      { namespace: idMf.namespace, key: idMf.key, value: idMf.value },
      'a divergence here is the other half of METAFIELD_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
describe('the route contract', () => {
  it('refuses an empty batch with a message rather than streaming nothing', async () => {
    const r = await post('/publish/batch', { itemIds: [] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /itemIds/);
  });

  it('deduplicates ids, so a double-clicked row publishes once', async () => {
    const a = addItem({ name: 'Alpha', number: '58/102' });
    const r = await postStream('/publish/batch', { itemIds: [a, a, a] });
    assert.equal(r.start.total, 1);
    assert.equal(calls.filter((c) => c.op === 'productSet').length, 1);
  });
});
