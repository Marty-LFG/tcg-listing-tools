// test/unit/repricer-db.test.mjs — the repricer's separate SQLite store (lib/repricer-db.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openRepricerDb, getMeta, setMeta, recordChat } from '../../lib/repricer-db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';

const db = openRepricerDb(tmpFile('repricer-test.db'));

describe('openRepricerDb DDL', () => {
  it('creates the repricer tables', () => {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    for (const t of ['listings', 'price_checks', 'reprice_proposals', 'seen_chats', 'meta'])
      assert.ok(rows.includes(t), `missing table ${t}`);
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
