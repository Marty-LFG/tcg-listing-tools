// test/integration/shopify-republish-no-raise.test.mjs — a re-publish never RAISES Shopify's quantity.
//
// The defect (audit K1): setAvailableQty wrote the local quantity on every publish, so a card that had
// just sold on Shopify — Shopify at 0, tracker.db still at 1 because the order had not been ingested yet
// — was put straight back on sale by the next re-publish. On a one-of-one that is a second buyer for an
// object that is already in someone's parcel.
//
// Now: a product we have stocked before is never raised without the per-call allowRaise; a first
// publish still stocks it; lowering is always allowed. Through runShopifyPublish, the real orchestrator,
// against a stubbed store whose inventory level the test controls.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { seedStockLabels } from '../../lib/inventory.mjs';
import { runShopifyPublish } from '../../lib/shopify.mjs';
import { markVerified } from '../helpers/verified.mjs';
import { resp } from '../helpers/channel-stubs.mjs';

const ENV = { SHOPIFY_DEV_SHOP: 'binders-keepers-dev', SHOPIFY_CLIENT_ID: 'fake-client-id', SHOPIFY_CLIENT_SECRET: 'fake-client-secret' };
const LOC = 'gid://shopify/Location/1';
const CFG = {
  defaultStore: 'dev',
  stores: { dev: { locationGid: LOC, publicationGid: 'gid://shopify/Publication/2' } },
  publish: { enabled: true, status: 'ACTIVE' }, sync: { enabled: false }, collections: {},
};
const DIR = tmpDir('tcg-noraise-');
let db, calls, level;

// Plays the image lab's /build route plus the store. `level` is what Shopify says is available at our
// location right now (null = not stocked there at all).
async function stub(url, init = {}) {
  const u = String(url);
  if (u.includes('/api/listing-image/build')) {
    return resp(200, { manifest: {
      sku: 'X', alt: 'front', images: [{ position: 1, view: 'front', filename: 'x.jpg', alt: 'front', contentHash: 'h-front', composeVersion: 'v1', width: 1512, height: 2112, bytes: 16 }],
      social: { view: 'og', filename: 'x-og.jpg', alt: 'og', contentHash: 'h-og', composeVersion: 'v1', width: 1200, height: 630, bytes: 16 },
    }, warnings: [] });
  }
  if (u.includes('/admin/oauth/access_token')) return resp(200, { access_token: 't', scope: 'write_products', expires_in: 86399 });
  const { query: q, variables: v } = JSON.parse(init.body);
  if (q.includes('metaobjectUpsert')) { calls.push('identity'); return resp(200, { data: { metaobjectUpsert: { metaobject: { id: 'gid://shopify/Metaobject/9', handle: v.handle.handle }, userErrors: [] } } }); }
  if (q.includes('productSet')) {
    calls.push('productSet');
    return resp(200, { data: { productSet: { product: { id: 'gid://shopify/Product/100', handle: v.input.handle, status: v.input.status,
      variants: { nodes: [{ id: 'gid://shopify/ProductVariant/200', sku: v.input.variants[0].sku, inventoryItem: { id: 'gid://shopify/InventoryItem/300' } }] } }, userErrors: [] } } });
  }
  if (q.includes('inventoryItem(id:')) {
    calls.push('readLevel');
    const nodes = level == null ? [] : [{ location: { id: LOC }, quantities: [{ name: 'available', quantity: level }] }];
    return resp(200, { data: { inventoryItem: { inventoryLevels: { nodes } } } });
  }
  if (q.includes('inventoryActivate')) { calls.push('activate:' + v.available); level = v.available; return resp(200, { data: { inventoryActivate: { inventoryLevel: { id: 'x' }, userErrors: [] } } }); }
  if (q.includes('inventorySetQuantities')) {
    const x = v.input.quantities[0];
    calls.push(`set:${x.changeFromQuantity}->${x.quantity}`);
    level = x.quantity;
    return resp(200, { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { changes: [] }, userErrors: [] } } });
  }
  if (q.includes('publishablePublish')) { calls.push('publish'); return resp(200, { data: { publishablePublish: { publishable: { availablePublicationsCount: { count: 1 } }, userErrors: [] } } }); }
  throw new Error('unstubbed: ' + q.slice(0, 80));
}

function seedCard(sku, qty = 1) {
  const id = Number(db.prepare(`INSERT INTO inventory_items (sku, game, identity_key, name, set_name, number, rarity, variant, language, condition, quantity, target_price_cents, image_url, status)
    VALUES (?, 'pokemon','base1-58','Pikachu','Base Set','58/102','Common','Regular','EN','Near Mint', ?, 1299,'https://images.pokemontcg.io/base1/58.png','in_stock')`).run(sku, qty).lastInsertRowid);
  markVerified(db, 'inventory', id);
  return id;
}
const publish = (itemId, extra = {}) => runShopifyPublish({
  env: ENV, db, base: 'http://127.0.0.1:1', cfg: CFG, item: db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId),
  store: 'dev', fetchImpl: stub, ...extra,
});

before(() => { db = openDbAt(path.join(DIR, 'tracker.db')); });
after(() => { try { db.close(); } catch {} });
beforeEach(() => {
  calls = []; level = null;
  db.exec('DELETE FROM inventory_items; DELETE FROM shopify_listings; DELETE FROM shopify_files; DELETE FROM sku_counter; DELETE FROM stock_verifications;');
  seedStockLabels(db, 294);
  for (const [h, gid] of [['h-front', 'gid://shopify/MediaImage/1'], ['h-og', 'gid://shopify/MediaImage/2']]) {
    db.prepare("INSERT INTO shopify_files (content_hash, store, file_gid, status, ready_at) VALUES (?, 'dev', ?, 'ready', datetime('now'))").run(h, gid);
  }
});

describe('a re-publish after a Shopify sale', () => {
  it('HOLDS Shopify at 0 when the row still says 1 — the sale has not reached us yet', async () => {
    const id = seedCard('AAC-050');
    // Published before: the mirror has recorded a successful stock of 1.
    db.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty)
                VALUES ('AAC-050', 'dev', 'inventory', ?, 'gid://shopify/Product/100', 'gid://shopify/InventoryItem/300', ?, 'live', 1)`).run(id, LOC);
    level = 0;   // it sold on Shopify a minute ago
    const r = await publish(id);
    assert.equal(r.ok, true, r.error);
    assert.ok(!calls.some((c) => c.startsWith('set:')), 'nothing may write a 1 over the sale: ' + calls.join(','));
    assert.equal(level, 0);
    assert.ok(r.warnings.some((w) => /NOT raised/.test(w)), r.warnings.join(' | '));
    assert.equal(db.prepare("SELECT available_qty FROM shopify_listings WHERE store = 'dev' AND sku = 'AAC-050'").get().available_qty, 0,
      'the mirror records what Shopify HOLDS, not what we wanted');
  });

  it('raises only when the owner says the units are back (allowRaise, per call)', async () => {
    const id = seedCard('AAC-051');
    db.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty)
                VALUES ('AAC-051', 'dev', 'inventory', ?, 'gid://shopify/Product/100', 'gid://shopify/InventoryItem/300', ?, 'live', 1)`).run(id, LOC);
    level = 0;
    const r = await publish(id, { allowRaise: true });
    assert.equal(r.ok, true, r.error);
    assert.ok(calls.includes('set:0->1'), calls.join(','));
  });

  it('always LOWERS — a re-publish of a row that sold here brings Shopify down', async () => {
    const id = seedCard('AAC-052', 1);
    db.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty)
                VALUES ('AAC-052', 'dev', 'inventory', ?, 'gid://shopify/Product/100', 'gid://shopify/InventoryItem/300', ?, 'live', 3)`).run(id, LOC);
    level = 3;
    const r = await publish(id);
    assert.equal(r.ok, true, r.error);
    assert.ok(calls.includes('set:3->1'), calls.join(','));
  });

  it('a FIRST publish still stocks the product (productSet leaves it active at 0)', async () => {
    const id = seedCard('STG-000009');
    level = 0;
    const r = await publish(id);
    assert.equal(r.ok, true, r.error);
    assert.ok(calls.includes('set:0->1'), 'a brand-new product has never been stocked by us, so stocking it is not a raise over a sale');
  });

  it('a first publish where the location is not stocked activates at the full quantity', async () => {
    const id = seedCard('STG-000010');
    level = null;
    const r = await publish(id);
    assert.equal(r.ok, true, r.error);
    assert.ok(calls.includes('activate:1'), calls.join(','));
  });
});
