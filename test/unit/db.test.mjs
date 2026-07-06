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
  'inventory_items', 'inventory_valuations', 'sku_counter', 'bulk_batches', 'channel_exports'];

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

describe('basic write/read', () => {
  it('watchlist insert round-trips', () => {
    db.prepare(`INSERT INTO watchlist (game, identity_key, name) VALUES ('pokemon','sv4-25','Test Card')`).run();
    const row = db.prepare(`SELECT * FROM watchlist WHERE identity_key='sv4-25'`).get();
    assert.equal(row.name, 'Test Card');
  });
});
