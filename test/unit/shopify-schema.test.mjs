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
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// THE REBUILDS, against the shape they actually have to run on.
//
// Every other fixture in the suite calls openDbAt on an empty file, which builds the new schema from
// CREATE TABLE — so migrateShopifyStore and migrateShopifyFilesStore hit `if (cols.includes('store'))
// return` on their second line and never execute. The riskiest code in the change (DROP + RENAME on the
// owner's real database, holding 265 stock rows) had zero coverage. These build the OLD schema by hand
// and run the real migration over it.
describe('migrating a database that predates the store column', () => {
  const legacy = (dir) => {
    const p = path.join(dir, 'legacy.db');
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE shopify_listings (
      sku TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'inventory', item_id INTEGER,
      product_gid TEXT, variant_gid TEXT, inventory_gid TEXT, location_gid TEXT, identity_gid TEXT,
      handle TEXT, state TEXT NOT NULL DEFAULT 'pending', published_at TEXT, price_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'AUD', available_qty INTEGER, last_synced_at TEXT, error TEXT,
      raw TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.exec(`CREATE INDEX idx_shopify_listing_item ON shopify_listings(kind, item_id)`);
    raw.exec(`CREATE TABLE shopify_files (
      content_hash TEXT PRIMARY KEY, file_gid TEXT, resource_url TEXT,
      status TEXT NOT NULL DEFAULT 'staged', view TEXT, filename TEXT, width INTEGER, height INTEGER,
      bytes INTEGER, compose_version TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), ready_at TEXT)`);
    raw.exec(`INSERT INTO shopify_listings (sku, item_id, product_gid, handle, state, price_cents, raw)
              VALUES ('AAC-085', 7, 'gid://shopify/Product/1', 'pokemon-x-nm', 'live', 12999, '{"a":1}')`);
    raw.exec(`INSERT INTO shopify_files (content_hash, file_gid, status, view, bytes)
              VALUES ('h-front', 'gid://shopify/MediaImage/1', 'ready', 'front', 16)`);
    raw.close();
    return p;
  };

  it('rebuilds both tables, keeps every row and every value, and stamps them dev', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-legacy-'));
    try {
      const migrated = openDbAt(legacy(dir));
      const l = migrated.prepare('SELECT * FROM shopify_listings').all();
      assert.equal(l.length, 1, 'the rebuild lost a row');
      assert.equal(l[0].store, 'dev', "nothing has ever published to live, so every existing row IS dev");
      // Every value carried across, not just the key ones.
      assert.equal(l[0].sku, 'AAC-085');
      assert.equal(l[0].item_id, 7);
      assert.equal(l[0].product_gid, 'gid://shopify/Product/1');
      assert.equal(l[0].handle, 'pokemon-x-nm');
      assert.equal(l[0].state, 'live');
      assert.equal(l[0].price_cents, 12999);
      assert.equal(l[0].currency, 'AUD');
      assert.equal(l[0].raw, '{"a":1}');
      assert.equal(l[0].identity_handle, null, 'the column added just before the rebuild must survive it');

      const f = migrated.prepare('SELECT * FROM shopify_files').all();
      assert.equal(f.length, 1);
      assert.equal(f[0].store, 'dev');
      assert.equal(f[0].file_gid, 'gid://shopify/MediaImage/1');
      assert.equal(f[0].bytes, 16);
      migrated.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('moves the primary keys and rebuilds the indexes the old table took with it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-legacy-'));
    try {
      const migrated = openDbAt(legacy(dir));
      const pk = (t) => migrated.prepare(`PRAGMA table_info(${t})`).all()
        .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      assert.deepEqual(pk('shopify_listings'), ['sku', 'store']);
      assert.deepEqual(pk('shopify_files'), ['content_hash', 'store']);
      // DROP TABLE takes the old indexes with it; all three must come back, store-first.
      const idx = migrated.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='shopify_listings' AND sql IS NOT NULL`).all();
      assert.equal(idx.length, 3, idx.map((r) => r.name).join(', '));
      for (const r of idx) assert.match(r.sql, /\(\s*store\s*,/, r.name + ' must lead with store');
      migrated.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('is a no-op on a second open, and leaves a live row alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-legacy-'));
    try {
      const p = legacy(dir);
      const first = openDbAt(p);
      first.prepare(`INSERT INTO shopify_listings (sku, store, state) VALUES ('AAC-085','live','pending')`).run();
      first.close();
      const second = openDbAt(p);
      const rows = second.prepare(`SELECT store, state FROM shopify_listings WHERE sku='AAC-085' ORDER BY store`).all();
      assert.deepEqual(rows.map((r) => r.store + '=' + r.state), ['dev=live', 'live=pending'],
        'a second boot re-ran the rebuild and lost the live row');
      second.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
