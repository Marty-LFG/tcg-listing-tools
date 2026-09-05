// test/unit/shopify-schema.test.mjs — the second-channel schema (lib/db.mjs migrateShopify,
// lib/postsale-db.mjs channel columns). See docs/SHOPIFY_CHANNEL_PLAN.md §4.
//
// The migration runs on every boot against the owner's real data/tracker.db, so the properties that
// matter are: it is additive, it is idempotent, and its backfill can never overwrite an intent a human
// has since edited. Each of those is a test below.
//
// openDbAt / openPostsaleDbAt, never openDb / openPostsaleDb — those are process singletons that ignore
// their path argument after the first call, so a test using them writes to the REAL database.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';

const SHOPIFY_TABLES = ['shopify_listings', 'channel_intent', 'sync_jobs', 'shopify_files'];
const tables = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
const indexes = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((r) => r.name);
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

describe('migrateShopify — tables and indexes', () => {
  const db = openDbAt(tmpFile('shopify-schema.db'));

  it('creates every second-channel table', () => {
    const have = tables(db);
    for (const t of SHOPIFY_TABLES) assert.ok(have.includes(t), `missing table ${t}`);
  });

  it('leaves the eBay tables exactly where they were', () => {
    const have = tables(db);
    for (const t of ['ebay_listings', 'ebay_seller_listings', 'listing_pushes', 'inventory_items']) {
      assert.ok(have.includes(t), `migrateShopify must not disturb ${t}`);
    }
  });

  it('channel_intent is keyed on (sku, channel)', () => {
    const info = db.prepare(`PRAGMA table_info(channel_intent)`).all().filter((c) => c.pk > 0);
    assert.deepEqual(info.sort((a, b) => a.pk - b.pk).map((c) => c.name), ['sku', 'channel']);
  });

  it('shopify_listings is one row per SKU PER STORE', () => {
    // Was `['sku']`. One install reaches both stores (storeFor reads ?store= per request, and
    // guardLiveStore exists precisely so it can), so a single row per SKU meant a live publish
    // UPSERTing over the dev rehearsal's row — and the COALESCE-preserve logic keeping a dev product
    // GID alive when the live attempt failed.
    const info = db.prepare(`PRAGMA table_info(shopify_listings)`).all().filter((c) => c.pk > 0);
    assert.deepEqual(info.sort((a, b) => a.pk - b.pk).map((c) => c.name), ['sku', 'store']);
  });

  it('shopify_listings holds the same SKU on both stores at once', () => {
    // The behaviour the key change exists for: a card rehearsed on dev and published to live is two
    // rows with two product GIDs, not one row that lost the first.
    db.prepare(`INSERT INTO shopify_listings (sku, store, state, product_gid) VALUES (?,?,?,?)`)
      .run('ZZZ-001', 'dev', 'live', 'gid://shopify/Product/dev1');
    db.prepare(`INSERT INTO shopify_listings (sku, store, state, product_gid) VALUES (?,?,?,?)`)
      .run('ZZZ-001', 'live', 'live', 'gid://shopify/Product/live1');
    const rows = db.prepare(`SELECT store, product_gid FROM shopify_listings WHERE sku = ? ORDER BY store`).all('ZZZ-001');
    assert.deepEqual(rows.map((r) => `${r.store}=${r.product_gid}`), [
      'dev=gid://shopify/Product/dev1',
      'live=gid://shopify/Product/live1',
    ]);
    db.prepare(`DELETE FROM shopify_listings WHERE sku = ?`).run('ZZZ-001');
  });

  it('every shopify_listings index leads with store', () => {
    // Every consumer filters on store first; an index that does not lead with it is not the index
    // those queries need.
    const sql = db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='shopify_listings' AND sql IS NOT NULL`).all();
    assert.ok(sql.length >= 3, 'expected the three named shopify_listings indexes');
    for (const r of sql) {
      assert.match(r.sql, /\(\s*store\s*,/, `${r.name} must lead with store: ${r.sql}`);
    }
  });

  it('shopify_listings carries no foreign key on item_id', () => {
    // Deliberate: inventory_items.id and sealed_items.id are INDEPENDENT sequences, so an FK would
    // happily accept a sealed id that also exists in inventory_items and attach the listing to an
    // unrelated card. `kind` is the discriminator instead. Same reasoning as migrateSealedListing.
    const fks = db.prepare(`PRAGMA foreign_key_list(shopify_listings)`).all();
    assert.equal(fks.length, 0, 'item_id must stay FK-free — see the comment in migrateShopify');
  });

  it('adds the missing ebay_listing_id index that applyStockDecrements needs', () => {
    assert.ok(indexes(db).includes('idx_inv_ebay_listing'));
  });

  it('indexes sync_jobs in the order the claim query sorts', () => {
    assert.ok(indexes(db).includes('idx_sync_claim'));
  });

  it('sync_jobs.dedupe_key is unique but nullable', () => {
    db.prepare(`INSERT INTO sync_jobs (kind, channel, sku) VALUES ('ebay.delist','ebay','AAA-001')`).run();
    db.prepare(`INSERT INTO sync_jobs (kind, channel, sku) VALUES ('ebay.delist','ebay','AAA-002')`).run();
    // Two NULL dedupe_keys must coexist — most jobs do not need one.
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM sync_jobs WHERE dedupe_key IS NULL`).get().c, 2);

    db.prepare(`INSERT INTO sync_jobs (kind, channel, sku, dedupe_key) VALUES ('identity.rebuild','local','AAA-003','identity:x')`).run();
    assert.throws(
      () => db.prepare(`INSERT INTO sync_jobs (kind, channel, sku, dedupe_key) VALUES ('identity.rebuild','local','AAA-004','identity:x')`).run(),
      /UNIQUE/i,
      'a duplicate dedupe_key must be refused — that is what collapses redundant enqueues',
    );
  });
});

describe('migrateShopify — the channel_intent backfill', () => {
  it('seeds one eBay intent row per existing listing, and is a no-op on re-run', () => {
    const p = tmpFile('shopify-backfill.db');
    const db = openDbAt(p);

    // An estate that predates the second channel.
    db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity) VALUES ('AAC-085','pokemon','Iono',1)`).run();
    const itemId = db.prepare(`SELECT id FROM inventory_items WHERE sku='AAC-085'`).get().id;
    db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, item_id) VALUES ('AAC-085','EBAY_AU','of-1',?)`).run(itemId);
    db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id) VALUES ('AAC-086','EBAY_AU','of-2')`).run();

    // Second open = the next boot. This is where the backfill actually runs for a pre-existing DB.
    const db2 = openDbAt(p);
    const seeded = db2.prepare(`SELECT sku, channel, mode, price_cents, item_id FROM channel_intent ORDER BY sku`).all();
    assert.equal(seeded.length, 2, 'one intent row per eBay listing');
    assert.deepEqual(seeded.map((r) => r.sku), ['AAC-085', 'AAC-086']);
    assert.ok(seeded.every((r) => r.channel === 'ebay' && r.mode === 'auto'));
    assert.equal(seeded[0].item_id, itemId, 'the tracker id is carried across where the mirror had one');
    assert.equal(seeded[0].price_cents, null, 'null means derive from the base price, not "free"');

    // A human then holds one listing back.
    db2.prepare(`UPDATE channel_intent SET mode='never', hold_reason='high value, one channel only' WHERE sku='AAC-085'`).run();

    // Third boot. The backfill must not resurrect the default over an edited intent — that is exactly
    // the reconcile-clobbers-intent failure the intent/observation split exists to prevent.
    const db3 = openDbAt(p);
    const after = db3.prepare(`SELECT sku, mode, hold_reason FROM channel_intent WHERE sku='AAC-085'`).get();
    assert.equal(after.mode, 'never', 'the backfill overwrote an operator decision');
    assert.equal(after.hold_reason, 'high value, one channel only');
    assert.equal(db3.prepare(`SELECT COUNT(*) c FROM channel_intent`).get().c, 2, 'the backfill duplicated rows');
  });

  it('seeds nothing from an empty eBay estate', () => {
    const db = openDbAt(tmpFile('shopify-backfill-empty.db'));
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM channel_intent`).get().c, 0);
  });
});

describe('postsale channel columns', () => {
  const db = openPostsaleDbAt(tmpFile('shopify-postsale.db'));

  it('orders and order_line_items both carry a channel', () => {
    assert.ok(cols(db, 'orders').includes('channel'));
    assert.ok(cols(db, 'order_line_items').includes('channel'));
  });

  it("defaults to 'ebay', so every pre-existing row and query stays correct", () => {
    db.prepare(`INSERT INTO buyers (ebay_username) VALUES ('someone')`).run();
    const buyerId = db.prepare(`SELECT id FROM buyers WHERE ebay_username='someone'`).get().id;
    db.prepare(`INSERT INTO orders (order_id, buyer_id) VALUES ('12-34567-89012', ?)`).run(buyerId);
    db.prepare(`INSERT INTO order_line_items (order_id, sku) VALUES ('12-34567-89012','AAC-085')`).run();

    assert.equal(db.prepare(`SELECT channel FROM orders WHERE order_id='12-34567-89012'`).get().channel, 'ebay');
    assert.equal(db.prepare(`SELECT channel FROM order_line_items WHERE sku='AAC-085'`).get().channel, 'ebay');
  });

  it('accepts a namespaced Shopify order alongside an eBay one', () => {
    // orders.order_id is a shared TEXT PRIMARY KEY and buyers.ebay_username is NOT NULL UNIQUE, so a
    // Shopify order has to namespace both. This test is the contract the webhook adapter writes to.
    db.prepare(`INSERT INTO buyers (ebay_username) VALUES ('shopify:guest:6123456789')`).run();
    const buyerId = db.prepare(`SELECT id FROM buyers WHERE ebay_username='shopify:guest:6123456789'`).get().id;
    db.prepare(`INSERT INTO orders (order_id, buyer_id, channel) VALUES ('shopify:6123456789', ?, 'shopify')`).run(buyerId);
    db.prepare(`INSERT INTO order_line_items (order_id, sku, channel) VALUES ('shopify:6123456789','AAC-086','shopify')`).run();

    // node:sqlite returns null-prototype rows, so map to plain values before comparing.
    const byChannel = db.prepare(`SELECT channel, COUNT(*) c FROM orders GROUP BY channel ORDER BY channel`)
      .all().map((r) => [r.channel, r.c]);
    assert.deepEqual(byChannel, [['ebay', 1], ['shopify', 1]]);
  });
});
