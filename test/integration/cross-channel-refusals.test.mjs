// test/integration/cross-channel-refusals.test.mjs — one channel at a time (audit K1).
//
//   · an eBay publish of a card ACTIVE on the live Shopify store is refused, before any eBay call
//   · a Shopify ACTIVE publish to the live store of a card live on eBay is refused, before any call
//   · a DRAFT, and the dev store, are not refused — that is how the eBay estate sits on live today
//   · allowDualList is per call and is IGNORED for a quantity of one
//   · the batch preflights say so without calling anything
//   · the sealed twins follow the same rule
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { runPublish, batchPreflight } from '../../lib/listings.mjs';
import { runShopifyPublish, shopifyBatchPreflight } from '../../lib/shopify.mjs';
import { publishSealedPool } from '../../lib/sealed-listing.mjs';
import { runSealedShopifyPublish } from '../../lib/sealed-shopify.mjs';
import { markVerified } from '../helpers/verified.mjs';
import { testEbayConfig } from '../helpers/ebay-config.mjs';
import { resp, LOC } from '../helpers/channel-stubs.mjs';

const EBAY_CFG = testEbayConfig({ genericImage: { enabled: false } });
const ENV = { EBAY_REFRESH_TOKEN: 'fake', EBAY_CERT_ID: 'c', SHOPIFY_SHOP: 'bk-live-test', SHOPIFY_DEV_SHOP: 'bk-dev-test', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' };
const shopCfg = (status = 'ACTIVE') => ({
  defaultStore: 'live',
  stores: { live: { locationGid: LOC, publicationGid: 'gid://shopify/Publication/2' }, dev: { locationGid: LOC, publicationGid: 'gid://shopify/Publication/2' } },
  publish: { enabled: true, status, allowLive: true }, sync: { enabled: false }, collections: {},
});
const DIR = tmpDir('tcg-refusals-');
let db, sent;
const realFetch = globalThis.fetch;

// Every channel call is recorded and refused. A refusal test proves itself by sent.length === 0; a
// "not refused" test proves itself by the call having been ATTEMPTED.
const recorder = async (url) => { sent.push(String(url)); return resp(500, { errors: [{ message: 'stub: nothing is answered here' }] }); };

function card(sku, qty = 1) {
  const id = Number(db.prepare(`INSERT INTO inventory_items (sku, game, identity_key, name, set_name, number, rarity, variant, language, condition, quantity, target_price_cents, image_url, status, created_at, updated_at)
    VALUES (?, 'pokemon','base1-58','Pikachu','Base Set','58/102','Common','Regular','EN','Near Mint', ?, 1299,'https://images.pokemontcg.io/base1/58.png','in_stock', datetime('now'), datetime('now'))`).run(sku, qty).lastInsertRowid);
  markVerified(db, 'inventory', id);
  return id;
}
const liveOnShopify = (id, sku, available = 1) => db.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty)
  VALUES (?, 'live', 'inventory', ?, 'gid://shopify/Product/1', 'gid://shopify/InventoryItem/1', ?, 'live', ?)`).run(sku, id, LOC, available);
const liveOnEbay = (id) => db.prepare("UPDATE inventory_items SET ebay_offer_id = 'OF-1', ebay_listing_id = '2255', channel_status = 'active', status = 'listed' WHERE id = ?").run(id);
const row = (id) => db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
// Past the guard, the publish path may throw against a stub that answers nothing — that is fine: the
// only question these tests ask is whether the REFUSAL fired.
const ebayPublish = (opts) => runPublish(ENV, db, EBAY_CFG, () => {}, opts).catch((e) => ({ ok: false, threw: String(e?.message || e) }));

before(() => { db = openDbAt(path.join(DIR, 'tracker.db')); });
after(() => { globalThis.fetch = realFetch; try { db.close(); } catch {} });
beforeEach(() => {
  sent = [];
  globalThis.fetch = recorder;
  db.exec(`DELETE FROM inventory_items; DELETE FROM shopify_listings; DELETE FROM ebay_listings; DELETE FROM ebay_seller_listings;
           DELETE FROM sealed_items; DELETE FROM sealed_placements; DELETE FROM sealed_pools; DELETE FROM stock_verifications;
           DELETE FROM sku_counter; DELETE FROM listing_pushes; DELETE FROM sealed_listing_pushes;`);
});

describe('eBay publish refuses a card live on Shopify', () => {
  it('refuses with live_on_shopify and makes no eBay call at all', async () => {
    const id = card('AAC-300');
    liveOnShopify(id, 'AAC-300');
    const r = await ebayPublish({ itemId: id });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'live_on_shopify', r.error);
    assert.match(r.error, /one-of-one/);
    assert.deepEqual(sent, [], 'refused before images, descriptors or offers');
  });

  it('allowDualList does NOT unlock a one-of-one', async () => {
    const id = card('AAC-301');
    liveOnShopify(id, 'AAC-301');
    const r = await ebayPublish({ itemId: id, allowDualList: true });
    assert.equal(r.code, 'live_on_shopify');
    assert.deepEqual(sent, []);
  });

  it('allowDualList DOES let a multi-quantity item through the guard', async () => {
    const id = card('AAC-302', 3);
    liveOnShopify(id, 'AAC-302', 3);
    const r = await ebayPublish({ itemId: id, allowDualList: true });
    assert.notEqual(r.code, 'live_on_shopify', 'past the guard — whatever happens next is the publish path, not the refusal');
  });

  it('a Shopify DRAFT, or a live product at 0, is not a second channel', async () => {
    const a = card('AAC-303');
    db.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, state, available_qty) VALUES ('AAC-303', 'live', 'inventory', ?, 'unpublished', 1)`).run(a);
    assert.notEqual((await ebayPublish({ itemId: a })).code, 'live_on_shopify');
    const b = card('AAC-304');
    liveOnShopify(b, 'AAC-304', 0);
    assert.notEqual((await ebayPublish({ itemId: b })).code, 'live_on_shopify');
  });

  it('the batch preflight reports it, for free', () => {
    const id = card('AAC-305');
    liveOnShopify(id, 'AAC-305');
    const pf = batchPreflight(db, EBAY_CFG, { itemIds: [id] });
    assert.equal(pf.rows[0].ok, false);
    assert.ok(pf.rows[0].refusals.some((x) => x.code === 'live_on_shopify'), JSON.stringify(pf.rows[0]));
    assert.deepEqual(sent, []);
  });
});

describe('Shopify ACTIVE publish refuses a card live on eBay', () => {
  it('refuses with live_on_ebay on the live store, before any call', async () => {
    const id = card('AAC-310');
    liveOnEbay(id);
    const r = await runShopifyPublish({ env: ENV, db, base: 'http://127.0.0.1:1', cfg: shopCfg('ACTIVE'), item: row(id), store: 'live', fetchImpl: recorder });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'live_on_ebay', r.error);
    assert.deepEqual(sent, []);
  });

  it('a hand-made eBay listing counts as live too', async () => {
    const id = card('AAC-311');
    db.prepare(`INSERT INTO ebay_seller_listings (listing_id, sku, state, created_via, item_id, available_qty) VALUES ('9311', 'AAC-311', 'active', 'manual', ?, 1)`).run(id);
    const r = await runShopifyPublish({ env: ENV, db, base: 'http://127.0.0.1:1', cfg: shopCfg('ACTIVE'), item: row(id), store: 'live', fetchImpl: recorder });
    assert.equal(r.code, 'live_on_ebay');
  });

  it('a DRAFT publish to live, and an ACTIVE publish to dev, are NOT refused', async () => {
    const id = card('AAC-312');
    liveOnEbay(id);
    const draft = await runShopifyPublish({ env: ENV, db, base: 'http://127.0.0.1:1', cfg: shopCfg('DRAFT'), item: row(id), store: 'live', fetchImpl: recorder });
    assert.notEqual(draft.code, 'live_on_ebay');
    assert.ok(sent.length > 0, 'it went past the guard and tried to publish');
    sent = [];
    const dev = await runShopifyPublish({ env: ENV, db, base: 'http://127.0.0.1:1', cfg: shopCfg('ACTIVE'), item: row(id), store: 'dev', fetchImpl: recorder });
    assert.notEqual(dev.code, 'live_on_ebay');
  });

  it('allowDualList passes a multi-quantity item and still refuses a one-of-one', async () => {
    const one = card('AAC-313');
    liveOnEbay(one);
    const r1 = await runShopifyPublish({ env: ENV, db, base: 'http://127.0.0.1:1', cfg: shopCfg(), item: row(one), store: 'live', fetchImpl: recorder, allowDualList: true });
    assert.equal(r1.code, 'live_on_ebay');
    const many = card('AAC-314', 4);
    liveOnEbay(many);
    const r2 = await runShopifyPublish({ env: ENV, db, base: 'http://127.0.0.1:1', cfg: shopCfg(), item: row(many), store: 'live', fetchImpl: recorder, allowDualList: true });
    assert.notEqual(r2.code, 'live_on_ebay');
  });

  it('the batch preflight reports it, and honours dualListIds per row', () => {
    const a = card('AAC-315'); liveOnEbay(a);
    const b = card('AAC-316', 2); liveOnEbay(b);
    const pf = shopifyBatchPreflight(db, shopCfg(), { itemIds: [a, b], store: 'live', dualListIds: [b] });
    const byId = Object.fromEntries(pf.rows.map((x) => [x.item_id, x]));
    assert.equal(byId[a].ok, false);
    assert.equal(byId[a].code, 'live_on_ebay');
    assert.notEqual(byId[b].code, 'live_on_ebay');
  });
});

describe('the sealed twins', () => {
  function pool(sku, units = 2) {
    db.prepare(`INSERT INTO sealed_pools (pool_sku, game, product_type, name, price_cents) VALUES (?, 'pokemon', 'booster_box', 'Booster Box', 16500)`).run(sku);
    const id = Number(db.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status, pool_sku, created_at, updated_at)
      VALUES (?, 'pokemon', 'Booster Box', 'booster_box', ?, 'in_stock', ?, datetime('now'), datetime('now'))`).run(sku + '-1', units, sku).lastInsertRowid);
    db.prepare("INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?, 'Shelf', ?)").run(id, units);
    markVerified(db, 'sealed', id);
    return id;
  }

  it('an eBay pool publish refuses a pool live on Shopify (one box), and allowDualList passes two', async () => {
    pool('POOL-A', 1);
    db.prepare(`INSERT INTO shopify_listings (sku, store, kind, state, available_qty, inventory_gid, location_gid) VALUES ('POOL-A', 'live', 'sealed', 'live', 1, 'gid://shopify/InventoryItem/7', ?)`).run(LOC);
    const r = await publishSealedPool(ENV, db, EBAY_CFG, { poolSku: 'POOL-A', allowDualList: true });
    assert.equal(r.code, 'live_on_shopify');
    assert.deepEqual(sent, []);

    pool('POOL-B', 2);
    db.prepare(`INSERT INTO shopify_listings (sku, store, kind, state, available_qty, inventory_gid, location_gid) VALUES ('POOL-B', 'live', 'sealed', 'live', 2, 'gid://shopify/InventoryItem/8', ?)`).run(LOC);
    const r2 = await publishSealedPool(ENV, db, EBAY_CFG, { poolSku: 'POOL-B', allowDualList: true, dryRun: true });
    assert.notEqual(r2.code, 'live_on_shopify');
  });

  it('a Shopify ACTIVE pool publish refuses a pool live on eBay', async () => {
    pool('POOL-C', 1);
    db.prepare("UPDATE sealed_pools SET ebay_offer_id = 'OF-P', ebay_listing_id = '2299', channel_status = 'active' WHERE pool_sku = 'POOL-C'").run();
    const r = await runSealedShopifyPublish({ env: ENV, db, base: 'http://127.0.0.1:1', cfg: shopCfg(), poolSku: 'POOL-C', store: 'live', fetchImpl: recorder });
    assert.equal(r.code, 'live_on_ebay', r.error);
    assert.deepEqual(sent, []);
  });
});
