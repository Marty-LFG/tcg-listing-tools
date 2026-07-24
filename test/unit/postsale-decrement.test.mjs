// test/unit/postsale-decrement.test.mjs — the sale→stock decrement (the "update inventory from eBay
// activity" direction). Pure tracker.db writes; guards: a qty-1 slab flips to sold+ended, a bulk lot
// loses N (stays listed), sealed decrements through placements, and it's idempotent.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { decrementInventoryItem, decrementSealedItem } from '../../lib/postsale.mjs';

let db, tmpDir;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-dec-')); db = openDbAt(path.join(tmpDir, 'tracker.db')); });
after(() => { try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(() => { db.exec('DELETE FROM inventory_items; DELETE FROM sealed_items; DELETE FROM sealed_placements;'); });

describe('decrementInventoryItem', () => {
  it('a qty-1 slab sale → sold + ended + sale price recorded', () => {
    const id = db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, channel_status) VALUES ('BK-PKM-1','pokemon','Charizard',1,'listed','active')`).run().lastInsertRowid;
    const r = decrementInventoryItem(db, id, 1, 500000);
    assert.deepEqual({ ok: r.ok, sold: r.sold, newQty: r.newQty }, { ok: true, sold: true, newQty: 0 });
    const row = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    assert.equal(row.status, 'sold');
    assert.equal(row.channel_status, 'ended');
    assert.equal(row.sale_price_cents, 500000);
    assert.ok(row.sold_at);
  });
  it('a bulk lot loses N and stays listed until the last unit', () => {
    const id = db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status) VALUES ('BK-RAW-PKM-1','pokemon','Common',10,'listed')`).run().lastInsertRowid;
    let r = decrementInventoryItem(db, id, 3, 99);
    assert.equal(r.sold, false); assert.equal(r.newQty, 7);
    assert.equal(db.prepare('SELECT status FROM inventory_items WHERE id=?').get(id).status, 'listed');
    r = decrementInventoryItem(db, id, 7, 99);
    assert.equal(r.sold, true); assert.equal(db.prepare('SELECT status FROM inventory_items WHERE id=?').get(id).status, 'sold');
  });
  it('already-sold is a no-op (idempotent)', () => {
    const id = db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status) VALUES ('BK-PKM-2','pokemon','X',0,'sold')`).run().lastInsertRowid;
    assert.deepEqual(decrementInventoryItem(db, id, 1), { ok: true, sold: true, already: true, newQty: 0 });
  });
});

describe('decrementSealedItem', () => {
  it('reduces through placements and re-mirrors quantity/location', () => {
    const id = db.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, location, status) VALUES ('BK-SLD-PKM-1','pokemon','Booster Box','booster_box',3,'Shelf A','listed')`).run().lastInsertRowid;
    db.prepare('INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)').run(id, 'Shelf A', 2);
    db.prepare('INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)').run(id, 'Shelf B', 1);
    const r = decrementSealedItem(db, id, 2);
    assert.equal(r.sold, false); assert.equal(r.newQty, 1);
    const row = db.prepare('SELECT quantity, location, status FROM sealed_items WHERE id=?').get(id);
    assert.equal(row.quantity, 1);
    assert.equal(db.prepare('SELECT COALESCE(SUM(quantity),0) s FROM sealed_placements WHERE item_id=?').get(id).s, 1);
  });
  it('last unit → sold + ended', () => {
    const id = db.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status) VALUES ('BK-SLD-PKM-2','pokemon','ETB','elite_trainer_box',1,'listed')`).run().lastInsertRowid;
    db.prepare('INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)').run(id, 'Shelf C', 1);
    const r = decrementSealedItem(db, id, 1);
    assert.equal(r.sold, true);
    assert.equal(db.prepare('SELECT status, channel_status FROM sealed_items WHERE id=?').get(id).status, 'sold');
  });
  it('falls back to scalar quantity when the item has no placements', () => {
    const id = db.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status) VALUES ('BK-SLD-PKM-3','pokemon','Tin','tin',5,'listed')`).run().lastInsertRowid;
    const r = decrementSealedItem(db, id, 2);
    assert.equal(r.newQty, 3);
  });
});
