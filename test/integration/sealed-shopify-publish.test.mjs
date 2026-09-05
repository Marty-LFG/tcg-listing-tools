// test/integration/sealed-shopify-publish.test.mjs — a sealed POOL onto the storefront, end to end.
//
// The gate this pins: a pool publishes as ONE product at quantity N — not N products, not one per
// acquisition row — and no sealed row ever reaches the singles lane's mirror lookups, its shelf-label
// counter, or its card identity.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { runSealedShopifyPublish, sealedListingFor } from '../../lib/sealed-shopify.mjs';

let tmpDir, db;
let calls = [];
const bend = {};

const resp = (status, json) => Promise.resolve({
  ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(json)),
});

// One stub for both self-fetches: the compositor on our own port, and Shopify's Admin API.
function stub(url, init = {}) {
  const u = String(url);

  if (u.includes('/api/listing-image/build')) {
    const body = JSON.parse(init.body);
    calls.push({ op: 'compose', targets: body.targets, url: body.url, sku: body.sku });
    if (bend.compose) return resp(500, { error: 'compositor unavailable' });
    return resp(200, {
      manifest: {
        sku: body.sku, alt: 'White Flare Booster Box',
        images: [{ position: 1, view: 'front', filename: 'box-1.jpg', alt: 'box', contentHash: 'h-box', composeVersion: 'v1', width: 1600, height: 1600, bytes: 16 }],
        social: { view: 'og', filename: 'box-og.jpg', alt: 'box', contentHash: 'h-og', composeVersion: 'v1', width: 1200, height: 630, bytes: 16 },
      },
      warnings: [],
    });
  }
  if (u.includes('/admin/oauth/access_token')) return resp(200, { access_token: 't', scope: 'write_products', expires_in: 86399 });

  const body = JSON.parse(init.body);
  const q = body.query, v = body.variables;

  if (/productSet/.test(q)) {
    calls.push({ op: 'productSet', variables: v });
    if (bend.productSet) return resp(200, { data: { productSet: { product: null, userErrors: [{ field: ['input'], message: 'nope' }] } } });
    return resp(200, {
      data: {
        productSet: {
          product: {
            id: 'gid://shopify/Product/70', handle: v.input.handle, status: v.input.status,
            variants: { nodes: [{ id: 'gid://shopify/ProductVariant/71', sku: v.input.variants[0].sku, inventoryItem: { id: 'gid://shopify/InventoryItem/72' } }] },
          },
          userErrors: [],
        },
      },
    });
  }
  if (/inventoryLevels/.test(q)) {
    return resp(200, { data: { inventoryItem: { inventoryLevels: { nodes: [{ location: { id: 'gid://shopify/Location/1' }, quantities: [{ name: 'available', quantity: 0 }] }] } } } });
  }
  if (/inventorySetQuantities/.test(q)) {
    calls.push({ op: 'setQty', variables: v });
    return resp(200, { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: 'g' }, userErrors: [] } } });
  }
  if (/publishablePublish/.test(q)) {
    calls.push({ op: 'publish', variables: v });
    return resp(200, { data: { publishablePublish: { publishable: { availablePublicationsCount: { count: 1 } } }, userErrors: [] } });
  }
  if (/metaobjectUpsert/.test(q)) {
    calls.push({ op: 'identityUpsert', variables: v });
    return resp(200, { data: { metaobjectUpsert: { metaobject: { id: 'gid://shopify/Metaobject/9' }, userErrors: [] } } });
  }
  throw new Error('unstubbed call: ' + (q || u).slice(0, 90));
}

const ENV = { SHOPIFY_DEV_SHOP: 'binders-keepers-dev', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' };
const CFG = {
  defaultStore: 'dev',
  stores: { dev: { locationGid: 'gid://shopify/Location/1', publicationGid: 'gid://shopify/Publication/2' } },
  publish: { enabled: true, status: 'ACTIVE' },
};

function seedPool({ units = 3, price = 18900, productType = 'booster_box', withImage = true } = {}) {
  db.exec(`DELETE FROM sealed_pools; DELETE FROM sealed_items; DELETE FROM sealed_placements;
           DELETE FROM sealed_pool_images; DELETE FROM shopify_listings; DELETE FROM shopify_files;`);
  db.prepare(`INSERT INTO sealed_pools (pool_sku, game, language, set_code, set_name, product_type, name, condition, factory_sealed, pack_count, price_cents)
              VALUES ('BKS-PKM-SV8A-BOX','pokemon','EN','SV8a','White Flare',?,'White Flare Booster Box','sealed',1,36,?)`)
    .run(productType, price);
  // Units live on PLACEMENTS — poolUnits sums them rather than reading the cached mirror, so the
  // fixture has to put them where the real thing looks.
  const it = db.prepare(`INSERT INTO sealed_items (sku, game, product_type, name, quantity, status, pool_sku)
                         VALUES ('BK-SLD-PKM-000001','pokemon',?,'White Flare Booster Box',?, 'in_stock','BKS-PKM-SV8A-BOX')`)
    .run(productType, units);
  db.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,'Shelf A',?)`).run(it.lastInsertRowid, units);
  if (withImage) {
    db.prepare(`INSERT INTO sealed_pool_images (pool_sku, position, kind, source_url) VALUES ('BKS-PKM-SV8A-BOX',1,'catalog','https://cdn.example/box.png')`).run();
  }
  // The frames the compositor stub says it rendered, pre-cached as READY so the media layer reuses
  // them instead of looking for bytes in the content-addressed store. Same device as the singles
  // suite's seedMediaCache, and per store, because a file_gid belongs to one shop.
  const ins = db.prepare(`INSERT INTO shopify_files (content_hash, store, file_gid, status, ready_at)
                          VALUES (?,?,?,'ready',datetime('now'))`);
  for (const [h, n] of [['h-box', 1], ['h-og', 2]]) ins.run(h, 'dev', `gid://shopify/MediaImage/${n}`);
}

const run = (over = {}) => runSealedShopifyPublish({
  env: ENV, db, base: 'http://127.0.0.1:5273', cfg: CFG,
  poolSku: 'BKS-PKM-SV8A-BOX', store: 'dev', fetchImpl: stub, ...over,
});

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-sealed-shopify-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
});
after(() => { try { db.close(); } catch {} fs.rmSync(tmpDir, { recursive: true, force: true }); });
beforeEach(() => { calls = []; for (const k of Object.keys(bend)) delete bend[k]; seedPool(); });

describe('a sealed pool publishes as one product at quantity N', () => {
  it('publishes, and stocks the pool quantity rather than one', async () => {
    const out = await run();
    assert.equal(out.ok, true, out.error);
    assert.equal(out.units, 3);
    const set = calls.find((c) => c.op === 'productSet');
    assert.equal(set.variables.input.variants.length, 1, 'one product, one variant — not one per acquisition');
    assert.equal(set.variables.input.variants[0].sku, 'BKS-PKM-SV8A-BOX', 'the pool SKU is the variant SKU');
    const qty = calls.find((c) => c.op === 'setQty');
    assert.equal(qty.variables.input.quantities[0].quantity, 3);
  });

  it('publishes to the Online Store LAST, so nothing is visible unstocked', async () => {
    await run();
    const order = calls.filter((c) => ['productSet', 'setQty', 'publish'].includes(c.op)).map((c) => c.op);
    assert.deepEqual(order, ['productSet', 'setQty', 'publish']);
  });

  it('never upserts a CARD identity — a booster box has no conditions to group', async () => {
    await run();
    const types = calls.filter((c) => c.op === 'identityUpsert').map((c) => c.variables.handle.type);
    assert.ok(!types.includes('bk_card_identity'), 'a box has no condition ladder to belong to');
  });

  it('joins its SET, so a card from that set can show the box and back', async () => {
    await run();
    const upserts = calls.filter((c) => c.op === 'identityUpsert').map((c) => c.variables);
    const set = upserts.find((v) => v.handle.type === 'bk_set_identity');
    assert.ok(set, 'the box must join its set identity');
    assert.equal(set.handle.handle, 'pokemon-sv8a-en');

    // The GID comes back from that upsert and is spliced into the product as bkc.set — the reference
    // the theme follows. It is conditional on the upsert succeeding, so a store without the definition
    // publishes a product with no bkc.set rather than failing the whole productSet call.
    const input = calls.find((c) => c.op === 'productSet').variables.input;
    const mf = (input.metafields || []).find((m) => m.namespace === 'bkc' && m.key === 'set');
    assert.ok(mf, 'bkc.set was not spliced onto the product');
    assert.equal(mf.type, 'metaobject_reference');

    // And the lists are recomputed whole afterwards, with this box in the sealed one.
    const rebuild = upserts.filter((v) => v.handle.type === 'bk_set_identity').at(-1);
    const sealedField = rebuild.metaobject.fields.find((f) => f.key === 'sealed');
    assert.ok(sealedField, 'the set rebuild must write the sealed list');
    assert.deepEqual(JSON.parse(sealedField.value), ['gid://shopify/Product/70']);
  });

  it('asks the compositor for the SQUARE frame, with the pool image as the source', async () => {
    await run();
    const c = calls.find((x) => x.op === 'compose');
    assert.ok(c.targets.includes('shopify-square'), 'sealed is framed square, not 63:88');
    assert.ok(!c.targets.includes('shopify-card'));
    assert.equal(c.url, 'https://cdn.example/box.png', 'a box has no catalogue art to fall back on');
  });

  it('records a sealed mirror row keyed on the pool SKU, with a NULL item_id', async () => {
    await run();
    const row = sealedListingFor(db, 'BKS-PKM-SV8A-BOX', 'dev');
    assert.equal(row.state, 'live');
    assert.equal(row.kind, 'sealed');
    assert.equal(row.item_id, null, 'sealed_pools has a text primary key — there is no integer to put here');
    assert.equal(row.product_gid, 'gid://shopify/Product/70');
    assert.equal(row.available_qty, 3);
  });

  it('spends no shelf label — the pool SKU is its own namespace for life', async () => {
    await run();
    const seq = db.prepare("SELECT seq FROM sku_counter WHERE namespace = 'LABEL'").get();
    assert.equal(seq, undefined, 'the singles label counter must never be touched by a sealed publish');
  });
});

describe('the sealed lane refuses rather than half-publishing', () => {
  it('refuses a pool with no units on the shelf', async () => {
    seedPool({ units: 0 });
    const out = await run();
    assert.equal(out.ok, false);
    assert.match(out.error, /no units in stock/);
    assert.equal(calls.filter((c) => c.op === 'productSet').length, 0, 'nothing may reach the store');
  });

  it('refuses a product type outside the opened set, before staging any media', async () => {
    seedPool({ productType: 'elite_trainer_box' });
    const out = await run();
    assert.equal(out.ok, false);
    assert.match(out.error, /sealed v1 publishes/);
    assert.equal(calls.filter((c) => c.op === 'compose').length, 0, 'a refused row must not stage permanent files');
  });

  it('refuses a pool with no image, because there is no catalogue art for a box', async () => {
    seedPool({ withImage: false });
    const out = await run();
    assert.equal(out.ok, false);
    assert.match(out.error, /no image/);
  });

  it('records a FAILED mirror row, so a failure is something someone can retry', async () => {
    bend.productSet = true;
    const out = await run();
    assert.equal(out.ok, false);
    const row = sealedListingFor(db, 'BKS-PKM-SV8A-BOX', 'dev');
    assert.equal(row.state, 'failed');
    assert.ok(row.error, 'a failed row with no reason is a row nobody can act on');
  });

  it('a dry run validates and composes but writes nothing to the store or the ledger', async () => {
    const out = await run({ dryRun: true });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.dryRun, true);
    assert.equal(calls.filter((c) => c.op === 'productSet').length, 0);
    assert.equal(sealedListingFor(db, 'BKS-PKM-SV8A-BOX', 'dev'), undefined);
  });
});
