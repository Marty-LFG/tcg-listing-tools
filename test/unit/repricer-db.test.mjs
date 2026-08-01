// test/unit/repricer-db.test.mjs — the repricer's separate SQLite store (lib/repricer-db.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openRepricerDb, migrate, getMeta, setMeta, recordChat, SCHEMA_VERSION } from '../../lib/repricer-db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';

const db = openRepricerDb(tmpFile('repricer-test.db'));

describe('openRepricerDb DDL', () => {
  it('creates the repricer tables', () => {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    for (const t of ['price_checks', 'reprice_proposals', 'seen_chats', 'meta'])
      assert.ok(rows.includes(t), `missing table ${t}`);
  });
  it('does NOT create a listings mirror — our live listings live in ebay_seller_listings', () => {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    assert.ok(!rows.includes('listings'), 'a second listings mirror would drift from the one the apply path requires');
  });
  it('stores money as integer cents (GR3)', () => {
    const types = Object.fromEntries(db.prepare('PRAGMA table_info(reprice_proposals)').all().map((r) => [r.name, r.type]));
    assert.equal(types.from_price_cents, 'INTEGER');
    assert.equal(types.to_price_cents, 'INTEGER');
    assert.ok(!('from_price' in types), 'the REAL-dollar column must be gone, not shadowed');
  });
});

describe('meta store', () => {
  it('get/set round-trip, missing key → null-ish', () => {
    assert.ok(getMeta(db, 'nope') == null);
    setMeta(db, 'update_offset', '42');
    assert.equal(String(getMeta(db, 'update_offset')), '42');
    setMeta(db, 'update_offset', '43'); // upsert, not duplicate
    assert.equal(String(getMeta(db, 'update_offset')), '43');
  });
});

describe('recordChat', () => {
  it('stores a seen chat', () => {
    recordChat(db, { id: -1001234, type: 'channel', title: 'Repricer Alerts' });
    const row = db.prepare(`SELECT * FROM seen_chats WHERE id='-1001234'`).get();
    assert.ok(row, 'chat row recorded');
    assert.equal(row.title, 'Repricer Alerts');
  });
});

// --- the migration ------------------------------------------------------------------------------
// The one that matters: an existing database carrying REAL dollars must come out the other side in
// integer cents, with the columns RENAMED. A column that keeps its name and changes its units is how
// you get a 100x price, so the old names must be gone rather than reinterpreted.
describe('migrate v0 -> v1', () => {
  const oldShapeDb = (rows = []) => {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE listings (item_id TEXT PRIMARY KEY, current_price REAL, active INTEGER);
      CREATE INDEX idx_listings_active ON listings(active) WHERE active = 1;
      CREATE TABLE price_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, our_price REAL, verdict TEXT);
      CREATE TABLE reprice_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'reprice', item_id TEXT, title TEXT,
        from_price REAL, to_price REAL, currency TEXT NOT NULL DEFAULT 'AUD', evidence TEXT,
        status TEXT NOT NULL DEFAULT 'pending', telegram_chat_id TEXT, telegram_message_id INTEGER,
        created_at TEXT, expires_at TEXT, decided_by TEXT, decided_at TEXT, applied_at TEXT, error TEXT);`);
    for (const [from, to] of rows) {
      d.prepare('INSERT INTO reprice_proposals (item_id, from_price, to_price, status) VALUES (?,?,?,?)')
        .run('9001', from, to, 'pending');
    }
    return d;
  };

  it('converts REAL dollars to integer cents and drops the old columns', () => {
    const d = oldShapeDb([[2.98, 3.98], [12.0, 18.49]]);
    migrate(d);
    // node:sqlite hands back null-prototype rows, so map to plain pairs before comparing.
    const rows = d.prepare('SELECT from_price_cents, to_price_cents FROM reprice_proposals ORDER BY id')
      .all().map((r) => [r.from_price_cents, r.to_price_cents]);
    assert.deepEqual(rows, [[298, 398], [1200, 1849]]);
    const cols = d.prepare('PRAGMA table_info(reprice_proposals)').all().map((r) => r.name);
    assert.ok(!cols.includes('from_price'), 'the old REAL column must be dropped, not left alongside');
    assert.ok(!cols.includes('to_price'));
  });

  it('rounds the float that motivated the migration', () => {
    // 18.489999999999998 is exactly the shape recommendedFromCluster produces; rounding it out of a
    // REAL is what made expectPriceCents refuse with an unexplained price_moved.
    const d = oldShapeDb([[18.489999999999998, 20.1]]);
    migrate(d);
    const r = d.prepare('SELECT from_price_cents, to_price_cents FROM reprice_proposals').get();
    assert.equal(r.from_price_cents, 1849);
    assert.equal(r.to_price_cents, 2010);
  });

  it('drops the redundant listings mirror and its index', () => {
    const d = oldShapeDb();
    migrate(d);
    const names = d.prepare(`SELECT name FROM sqlite_master`).all().map((r) => r.name);
    assert.ok(!names.includes('listings'));
    assert.ok(!names.includes('idx_listings_active'));
  });

  it('rebuilds an EMPTY price_checks, but keeps a non-empty one aside rather than deleting rows', () => {
    const empty = oldShapeDb();
    migrate(empty);
    assert.ok(!empty.prepare(`SELECT name FROM sqlite_master WHERE name='price_checks'`).get());

    const withRows = oldShapeDb();
    withRows.prepare("INSERT INTO price_checks (item_id, our_price, verdict) VALUES ('9001', 1.5, 'ok')").run();
    migrate(withRows);
    const kept = withRows.prepare(`SELECT name FROM sqlite_master WHERE name='price_checks_v0'`).get();
    assert.ok(kept, 'rows must be preserved, never silently dropped');
    assert.equal(withRows.prepare('SELECT COUNT(*) c FROM price_checks_v0').get().c, 1);
  });

  it('is idempotent — a second run is a no-op', () => {
    const d = oldShapeDb([[2.98, 3.98]]);
    assert.equal(migrate(d).migrated, true);
    assert.equal(migrate(d).migrated, false, 'user_version must stop it running twice');
    assert.equal(d.prepare('SELECT from_price_cents FROM reprice_proposals').get().from_price_cents, 298);
  });

  it('is a clean no-op on a fresh database', () => {
    const d = new DatabaseSync(':memory:');
    assert.doesNotThrow(() => migrate(d));
    assert.equal(d.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION,
      'a fresh database is stamped at the CURRENT version so migrate never re-runs on it');
  });
});
