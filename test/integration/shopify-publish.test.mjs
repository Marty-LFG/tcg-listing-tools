// test/integration/shopify-publish.test.mjs — the Shopify publish path end to end, through the routes.
//
// S6's exit criterion (docs/SHOPIFY_CHANNEL_PLAN.md): without this, `pnpm verify` passes green over a
// path nothing exercises. The unit tests cover each module in isolation; what only an integration test
// can catch is the WIRING — a route that never reaches the orchestrator, a mirror row written with the
// wrong columns, an identity rebuilt from a table that does not yet contain the product, a shelf label
// spent on an attempt that failed.
//
// Deliberately NOT bootServer(): that boots the real dev server with all 30 plugins against the REAL
// tracker.db (openDb() is a process singleton — T18), and this test needs its own database and its own
// fetch. makeShopifyRouter is an exported factory taking { db, fetchImpl } precisely so this is
// possible, and the connect surface below is replicated the same way scan.integration.test.mjs does it.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDbAt } from '../../lib/db.mjs';
import { seedStockLabels } from '../../lib/inventory.mjs';
import { makeShopifyRouter, shopifyPlugin, rebuildIdentity, scrubForAudit } from '../../lib/shopify.mjs';

const ENV = {
  SHOPIFY_DEV_SHOP: 'binders-keepers-dev',
  SHOPIFY_CLIENT_ID: 'fake-client-id',
  SHOPIFY_CLIENT_SECRET: 'fake-client-secret',
};

let db, tmpDir, server, base, itemId, calls, bend;

function resp(status, json) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => (json == null ? '' : JSON.stringify(json)),
  };
}

// Plays Shopify plus the image lab's own /build route, because the publish path self-fetches it.
function stub(url, init = {}) {
  const u = String(url);

  if (u.includes('/api/listing-image/build')) {
    calls.push({ op: 'compose' });
    if (bend.compose) return resp(500, { error: 'compositor unavailable' });
    // The manifest shape buildImageSet returns: ordered gallery + a separate social card.
    return resp(200, {
      manifest: {
        sku: 'AAC-097', alt: 'Pikachu front',
        images: [{ position: 1, view: 'front', filename: 'AAC-097-1-front.jpg', alt: 'Pikachu front', contentHash: 'h-front', composeVersion: 'v1', width: 1512, height: 2112, bytes: 16 }],
        social: { view: 'og', filename: 'AAC-097-og.jpg', alt: 'Pikachu', contentHash: 'h-og', composeVersion: 'v1', width: 1200, height: 630, bytes: 16 },
      },
      warnings: [],
    });
  }
  if (u.includes('/admin/oauth/access_token')) return resp(200, { access_token: 't', scope: 'write_products', expires_in: 86399 });

  const body = JSON.parse(init.body);
  const q = body.query, v = body.variables;

  if (q.includes('stagedUploadsCreate')) {
    calls.push({ op: 'staged' });
    return resp(200, { data: { stagedUploadsCreate: { stagedTargets: [{ url: 'https://storage.example/u', resourceUrl: 'https://storage.example/r/1', parameters: [{ name: 'policy', value: 'P' }, { name: 'signature', value: 'S' }] }], userErrors: [] } } });
  }
  if (u.includes('storage.example')) { calls.push({ op: 'upload' }); return resp(204, null); }
  if (q.includes('fileCreate')) {
    calls.push({ op: 'fileCreate' });
    return resp(200, { data: { fileCreate: { files: [{ id: 'gid://shopify/MediaImage/' + calls.filter((c) => c.op === 'fileCreate').length, fileStatus: 'READY', alt: '' }], userErrors: [] } } });
  }
  if (q.includes('metaobjectUpsert')) {
    calls.push({ op: q.includes('BkIdentityListings') ? 'identityListings' : 'identity', variables: v });
    if (bend.identity) return resp(200, { data: { metaobjectUpsert: { userErrors: [{ field: null, message: bend.identity, code: 'INVALID' }] } } });
    return resp(200, { data: { metaobjectUpsert: { metaobject: { id: 'gid://shopify/Metaobject/9', handle: v.handle.handle }, userErrors: [] } } });
  }
  if (q.includes('productSet')) {
    calls.push({ op: 'productSet', variables: v });
    if (bend.productSet) return resp(200, { data: { productSet: { userErrors: [{ field: null, message: bend.productSet, code: 'INVALID' }] } } });
    return resp(200, { data: { productSet: { product: {
      id: 'gid://shopify/Product/100', handle: v.input.handle, status: v.input.status,
      variants: { nodes: [{ id: 'gid://shopify/ProductVariant/200', sku: v.input.variants[0].sku, inventoryItem: { id: 'gid://shopify/InventoryItem/300' } }] },
    }, userErrors: [] } } });
  }
  if (q.includes('inventoryItem(id:')) { calls.push({ op: 'readLevel' }); return resp(200, { data: { inventoryItem: { inventoryLevels: { nodes: [] } } } }); }
  if (q.includes('inventoryActivate')) {
    calls.push({ op: 'activate' });
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
      location: { id: v.loc, name: 'Shop location', isActive: true, fulfillsOnlineOrders: true, shipsInventory: !bend.locationNotShipping },
      publication: { id: v.pub, name: 'Online Store' },
    } });
  }
  throw new Error('unstubbed call: ' + (q || u).slice(0, 90));
}

// The publish path only stages bytes it can find in the content store, so the media layer is given a
// cache hit instead — this test is about wiring, and shopify-media's own upload dance has 22 unit tests.
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

// The router reads config off disk, so the test writes a real config file and points the module at it
// through the same data/ directory it always uses. Restored in after().
let realConfig = null;
const CONFIG_PATH = path.resolve(process.cwd(), 'data', 'shopify.config.json');
function writeConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

before(async () => {
  if (fs.existsSync(CONFIG_PATH)) realConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-shopify-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));

  const mounts = [];
  // Replicate connect exactly: match the mount by prefix, strip it before the handler sees req.url.
  mounts.push({ route: '/api/shopify', fn: makeShopifyRouter({ env: ENV, db, base: 'http://127.0.0.1:1', fetchImpl: stub }) });
  server = http.createServer((req, res) => {
    const m = mounts.find((x) => { const p = String(req.url).split('?')[0]; return p === x.route || p.startsWith(x.route + '/'); });
    if (!m) { res.statusCode = 404; return res.end('{}'); }
    req.url = req.url.slice(m.route.length) || '/';
    m.fn(req, res, () => { res.statusCode = 404; res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
}, { timeout: 60_000 });

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  if (realConfig != null) fs.writeFileSync(CONFIG_PATH, realConfig); else try { fs.unlinkSync(CONFIG_PATH); } catch { /* was absent */ }
});

beforeEach(() => {
  calls = []; bend = {};
  writeConfig(CFG);
  db.exec('DELETE FROM inventory_items; DELETE FROM shopify_listings; DELETE FROM shopify_files; DELETE FROM sku_counter;');
  seedStockLabels(db, 294);   // next free label is AAC-097
  seedMediaCache();
  const r = db.prepare(`INSERT INTO inventory_items (sku, game, identity_key, name, set_name, number, rarity, variant, language, condition, quantity, target_price_cents, image_url, status)
    VALUES ('STG-000001','pokemon','base1-58','Pikachu','Base Set','58/102','Common','Regular','EN','Near Mint',1,1299,'https://images.pokemontcg.io/base1/58.png','in_stock')`).run();
  itemId = r.lastInsertRowid;
});

const API = '/api/shopify';
const get = async (p) => { const r = await fetch(base + API + p); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: r.status, json: j, text: t }; };
const post = async (p, body) => {
  const r = await fetch(base + API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, json: j, text: t };
};
const ops = () => calls.map((c) => c.op);
const mirror = (sku) => db.prepare('SELECT * FROM shopify_listings WHERE sku = ?').get(sku);
const labelSeq = () => (db.prepare("SELECT seq FROM sku_counter WHERE namespace = 'LABEL'").get() || {}).seq ?? null;

describe('the happy path, all the way through', () => {
  it('publishes: identity, product, inventory, publish — then mirror, label, condition list', async () => {
    const r = await post('/publish', { itemId });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true, r.json.error);
    assert.deepEqual(ops(), ['compose', 'identity', 'productSet', 'readLevel', 'activate', 'publish', 'identityListings']);
  });

  it('writes the mirror row with the ids Shopify actually returned', async () => {
    await post('/publish', { itemId });
    const m = mirror('AAC-097');
    assert.equal(m.state, 'live');
    assert.equal(m.product_gid, 'gid://shopify/Product/100');
    assert.equal(m.variant_gid, 'gid://shopify/ProductVariant/200');
    assert.equal(m.inventory_gid, 'gid://shopify/InventoryItem/300');
    assert.equal(m.identity_gid, 'gid://shopify/Metaobject/9');
    assert.equal(m.identity_handle, 'pokemon-base1-58-base-en');
    assert.equal(m.price_cents, 1299);
    assert.equal(m.available_qty, 1);
    assert.ok(m.published_at, 'published_at is the field that answers "is this really for sale"');
  });

  it('spends the shelf label, and the stock row now carries it', async () => {
    const before = labelSeq();
    await post('/publish', { itemId });
    assert.equal(db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(itemId).sku, 'AAC-097');
    assert.equal(labelSeq(), before + 1);
  });

  it('scrubs the staged-upload signature out of the stored payload', async () => {
    await post('/publish', { itemId });
    const raw = mirror('AAC-097').raw || '';
    assert.ok(!/"signature":"S"/.test(raw) && !/"policy":"P"/.test(raw), 'a short-lived GCS credential was written to the audit column');
  });

  it('rebuilds the condition list from the mirror, as a JSON array of product gids', async () => {
    await post('/publish', { itemId });
    const call = calls.find((c) => c.op === 'identityListings');
    const field = call.variables.metaobject.fields.find((f) => f.key === 'listings');
    assert.deepEqual(JSON.parse(field.value), ['gid://shopify/Product/100'],
      'list.product_reference travels as a JSON-encoded array of gids');
  });

  it('rebuilds AFTER the mirror row exists — otherwise the list omits the card just published', async () => {
    await post('/publish', { itemId });
    const i = ops().indexOf('identityListings');
    assert.ok(i > ops().indexOf('publish'), 'the rebuild read the mirror before the mirror was written');
  });
});

describe('the condition list', () => {
  it('orders siblings best-first and ignores anything not live', async () => {
    const rows = [
      ['AAC-100', 'Heavily Played', 'gid://shopify/Product/4', 'live'],
      ['AAC-101', 'Near Mint', 'gid://shopify/Product/1', 'live'],
      ['AAC-102', 'Moderately Played', 'gid://shopify/Product/3', 'live'],
      ['AAC-103', 'Lightly Played', 'gid://shopify/Product/2', 'live'],
      ['AAC-104', 'Near Mint', 'gid://shopify/Product/99', 'failed'],
    ];
    for (const [sku, condition, gid, state] of rows) {
      const r = db.prepare(`INSERT INTO inventory_items (sku, game, identity_key, name, condition, quantity) VALUES (?,'pokemon','base1-58','Pikachu',?,1)`).run(sku, condition);
      db.prepare(`INSERT INTO shopify_listings (sku, item_id, product_gid, identity_handle, state) VALUES (?,?,?,'ident-x',?)`).run(sku, r.lastInsertRowid, gid, state);
    }
    const out = await rebuildIdentity(ENV, db, { identityHandle: 'ident-x', fetchImpl: stub });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(out.listings, ['gid://shopify/Product/1', 'gid://shopify/Product/2', 'gid://shopify/Product/3', 'gid://shopify/Product/4']);
  });

  it('writes an EMPTY list rather than skipping, so a sold-out identity stops advertising tiles', async () => {
    const out = await rebuildIdentity(ENV, db, { identityHandle: 'nothing-here', fetchImpl: stub });
    assert.equal(out.ok, true);
    assert.deepEqual(out.listings, []);
    const field = calls.at(-1).variables.metaobject.fields.find((f) => f.key === 'listings');
    assert.equal(field.value, '[]');
  });

  it('never touches any field other than listings', async () => {
    await rebuildIdentity(ENV, db, { identityHandle: 'ident-x', fetchImpl: stub });
    const keys = calls.at(-1).variables.metaobject.fields.map((f) => f.key);
    assert.deepEqual(keys, ['listings'], 'a rebuild that resends descriptive fields can overwrite a hand edit');
  });
});

describe('failures leave the ledger honest', () => {
  it('a failed publish is recorded as failed, with the product id, and does NOT spend the label', async () => {
    const before = labelSeq();
    bend.publish = 'no such publication';
    const r = await post('/publish', { itemId });
    assert.equal(r.status, 502, 'something WAS sent, so this is not a 409');
    assert.equal(r.json.ok, false);
    const m = mirror('AAC-097');
    assert.equal(m.state, 'failed');
    assert.equal(m.product_gid, 'gid://shopify/Product/100', 'the product exists and the row must say so');
    assert.equal(m.published_at, null, 'published_at must never be set by a publish that failed');
    assert.equal(labelSeq(), before, 'the label was burned on an attempt that never went live');
    assert.equal(db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(itemId).sku, 'STG-000001');
  });

  it('a failed inventory step never reaches publish', async () => {
    bend.productSet = 'variant sku already in use';
    const r = await post('/publish', { itemId });
    assert.equal(r.json.ok, false);
    assert.ok(!ops().includes('publish'));
  });

  it('a compositor failure stops before anything is sent to Shopify', async () => {
    bend.compose = true;
    const r = await post('/publish', { itemId });
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /compose/);
    assert.deepEqual(ops(), ['compose']);
  });

  it('an identity failure still publishes the card, and warns', async () => {
    bend.identity = 'metaobject definition not found';
    const r = await post('/publish', { itemId });
    assert.equal(r.json.ok, true, 'a correct, priced, photographed card should not be withheld over a grouping field');
    assert.equal(mirror('AAC-097').state, 'live');
    assert.match(r.json.warnings.join(' '), /identity/i);
  });
});

describe('the three switches are three different problems', () => {
  it('publish.enabled false refuses with 409 publish_disabled and sends NOTHING', async () => {
    writeConfig({ ...CFG, publish: { enabled: false } });
    const r = await post('/publish', { itemId });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'publish_disabled');
    assert.deepEqual(ops(), []);
  });

  it('missing pins refuse with 409 not_ready and name which one is missing', async () => {
    writeConfig({ ...CFG, stores: { dev: { locationGid: '', publicationGid: 'gid://shopify/Publication/2' } } });
    const r = await post('/publish', { itemId });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'not_ready');
    assert.deepEqual(r.json.missing, ['locationGid']);
    assert.deepEqual(ops(), []);
  });

  it('a dry run needs no arming, sends nothing, and spends no label', async () => {
    writeConfig({ ...CFG, publish: { enabled: false } });
    const before = labelSeq();
    const r = await post('/publish', { itemId, dryRun: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.dryRun, true);
    assert.deepEqual(ops(), [], 'there is no Shopify dry run — a dry run that wrote would be a publish');
    assert.equal(labelSeq(), before);
  });
});

describe('the local lanes', () => {
  it('/preview builds the real payload while calling nothing at all', async () => {
    const r = await post('/preview', { itemId });
    assert.equal(r.status, 200);
    assert.deepEqual(ops(), []);
    assert.equal(r.json.input.variants[0].sku, 'AAC-097');
    assert.equal(r.json.identifier.customId.value, 'AAC-097');
    assert.equal(r.json.ok, true, r.json.errors.join('; '));
  });

  it('/preview works even when nothing is pinned — that is when you most want to see the payload', async () => {
    writeConfig({ ...CFG, stores: { dev: {} }, publish: { enabled: false } });
    const r = await post('/preview', { itemId });
    assert.equal(r.status, 200);
    assert.equal(r.json.wouldPublishTo.locationGid, null);
  });

  it('/status VERIFIES the pins rather than trusting the file', async () => {
    const r = await get('/status');
    assert.equal(r.json.ready, true, r.json.problems?.join('; '));
    assert.equal(r.json.location.name, 'Shop location');
  });

  it('/status fails a location that cannot hold sellable stock', async () => {
    bend.locationNotShipping = true;
    const r = await get('/status');
    assert.equal(r.json.ready, false);
    assert.match(r.json.problems.join(' '), /cannot hold sellable stock/);
  });

  it('/config never leaks a credential', async () => {
    const r = await get('/config');
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('fake-client-secret') && !r.text.includes('fake-client-id'));
    assert.equal(r.json.shop, 'binders-keepers-dev.myshopify.com');
  });

  it('/config strips the _comment documentation out of the payload', async () => {
    const r = await get('/config');
    assert.ok(!JSON.stringify(r.json.config).includes('_comment'));
  });

  it('an unknown sub-route is a 404 JSON, not an HTML fall-through', async () => {
    const r = await get('/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'unknown_route');
  });

  it('a mirror lookup answers for a published sku and 404s otherwise', async () => {
    await post('/publish', { itemId });
    assert.equal((await get('/listing/AAC-097')).json.mirror.state, 'live');
    assert.equal((await get('/listing/AAC-999')).status, 404);
  });
});

describe('the plugin itself cannot take the dev server down', () => {
  it('mounts exactly one prefix (the connect registration-order trap)', () => {
    const mounts = [];
    shopifyPlugin(ENV).configureServer({ middlewares: { use: (route, fn) => mounts.push({ route, fn }) }, config: { server: { port: 0 } } });
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].route, '/api/shopify');
  });

  it('still MOUNTS when it cannot start, answering 503 rather than vanishing', () => {
    const mounts = [];
    // A server object that throws where the real one is read — the shape of a boot-time surprise.
    shopifyPlugin(ENV).configureServer({
      middlewares: { use: (route, fn) => mounts.push({ route, fn }) },
      get config() { throw new Error('boom'); },
    });
    assert.equal(mounts.length, 1, 'an unmounted route falls through to Vite and answers HTML');
    let status = null, body = '';
    mounts[0].fn({ method: 'GET', url: '/config' }, { setHeader() {}, set statusCode(v) { status = v; }, get statusCode() { return status; }, end(b) { body = b; } });
    assert.equal(status, 503);
    assert.equal(JSON.parse(body).code, 'plugin_failed');
  });
});

describe('scrubForAudit', () => {
  it('redacts the signed upload fields wherever they appear', () => {
    const out = scrubForAudit({ files: [{ id: 'gid://x' }], parameters: [{ policy: 'P', signature: 'S' }], title: 'keep me' });
    assert.equal(out.title, 'keep me');
    assert.equal(out.parameters[0].policy, '[scrubbed]');
    assert.equal(out.parameters[0].signature, '[scrubbed]');
  });
});
