// test/unit/db.test.mjs — tracker/inventory SQLite store (lib/db.mjs).
// openDb() memoises one handle per process, so the second-open (idempotent DDL)
// case runs in a child process against the same file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { openDb } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { ROOT } from '../helpers/extract-inline.mjs';

const TABLES = ['watchlist', 'price_snapshots', 'signals', 'card_cache', 'grading_submissions',
  'inventory_items', 'inventory_valuations', 'sku_counter', 'bulk_batches', 'channel_exports',
  'sealed_items', 'sealed_valuations', 'sealed_barcodes', 'sealed_batches', 'sealed_placements',
  'sealed_locations', 'sealed_location_photos'];

const dbPath = tmpFile('tracker-test.db');
const db = openDb(dbPath);

describe('openDb DDL', () => {
  it('creates every table on a blank file', () => {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    for (const t of TABLES) assert.ok(rows.includes(t), `missing table ${t}`);
  });
  it('runs in WAL mode with a busy timeout', () => {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  });
  it('image_url migration column exists on inventory_items', () => {
    const cols = db.prepare(`PRAGMA table_info(inventory_items)`).all().map((c) => c.name);
    assert.ok(cols.includes('image_url'));
  });
  it('raw-only unique index exists (uq_inv_bulk_identity)', () => {
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((r) => r.name);
    assert.ok(idx.includes('uq_inv_bulk_identity'), idx.join(','));
  });
});

describe('DDL idempotency', () => {
  it('a second process opens the same file cleanly (CREATE IF NOT EXISTS)', () => {
    const r = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--input-type=module',
      '-e', `import { openDb } from ${JSON.stringify('file://' + path.join(ROOT, 'lib', 'db.mjs').replace(/\\/g, '/'))};
             const db = openDb(${JSON.stringify(dbPath)});
             db.prepare('SELECT COUNT(*) c FROM watchlist').get();`,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('sealed_placements backfill migration', () => {
  // A pre-feature sealed_items row has NO placement. On the next boot, migrateSealed must seed exactly
  // one placement mirroring its scalar (location, quantity) — and stay a no-op on later boots. Fresh-DB
  // API tests never hit this branch (they create items through lib/sealed.mjs, which seeds placements),
  // so exercise the real-data path here via a child-process "reboot" (like the DDL idempotency test).
  const reopenAndReadPlacements = () => {
    const r = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--input-type=module',
      '-e', `import { openDb } from ${JSON.stringify('file://' + path.join(ROOT, 'lib', 'db.mjs').replace(/\\/g, '/'))};
             const db = openDb(${JSON.stringify(dbPath)});
             const p = db.prepare("SELECT location, quantity FROM sealed_placements WHERE item_id=(SELECT id FROM sealed_items WHERE sku='BK-SLD-PKM-LEGACY')").all();
             process.stdout.write(JSON.stringify(p));`,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim());
  };
  it('seeds one placement mirroring a legacy item, idempotently across boots', () => {
    db.prepare(`INSERT INTO sealed_items (sku, game, product_type, name, quantity, location)
      VALUES ('BK-SLD-PKM-LEGACY','pokemon','booster_box','Legacy Box', 4, 'Old Shelf')`).run();
    const p1 = reopenAndReadPlacements();
    assert.deepEqual(p1, [{ location: 'Old Shelf', quantity: 4 }], 'one placement seeded from the scalar');
    const p2 = reopenAndReadPlacements();               // second boot: WHERE NOT EXISTS => no duplicate
    assert.equal(p2.length, 1, 'still exactly one placement after a second boot');
  });
});

describe('basic write/read', () => {
  it('watchlist insert round-trips', () => {
    db.prepare(`INSERT INTO watchlist (game, identity_key, name) VALUES ('pokemon','sv4-25','Test Card')`).run();
    const row = db.prepare(`SELECT * FROM watchlist WHERE identity_key='sv4-25'`).get();
    assert.equal(row.name, 'Test Card');
  });
  it('sealed_items insert round-trips (money in cents, product_type/upc set)', () => {
    db.prepare(`INSERT INTO sealed_items (sku, game, product_type, name, set_name, upc, cost_cents, value_cents)
      VALUES ('BK-SLD-PKM-000001','pokemon','booster_box','151 Booster Box','Scarlet & Violet 151','820136488510',35000,39900)`).run();
    const row = db.prepare(`SELECT * FROM sealed_items WHERE sku='BK-SLD-PKM-000001'`).get();
    assert.equal(row.product_type, 'booster_box');
    assert.equal(row.upc, '820136488510');
    assert.equal(row.cost_cents, 35000);
    assert.equal(row.status, 'in_stock');       // column default
    assert.equal(row.condition, 'sealed');       // column default
  });
  it('sealed_barcodes upserts by upc (the local cache primary key)', () => {
    db.prepare(`INSERT INTO sealed_barcodes (upc, name, product_type, source, confidence) VALUES ('820136488510','151 Booster Box','booster_box','manual','manual')`).run();
    const row = db.prepare(`SELECT * FROM sealed_barcodes WHERE upc='820136488510'`).get();
    assert.equal(row.name, '151 Booster Box');
    assert.equal(row.hit_count, 1);              // column default
  });
});
