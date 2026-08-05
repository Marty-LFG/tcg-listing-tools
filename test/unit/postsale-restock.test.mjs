// test/unit/postsale-restock.test.mjs — putting the stock back after a cancellation.
//
// The forward direction (applyStockDecrements) is covered in postsale-decrement.test.mjs. This is its
// inverse, and the cases that matter most are the REFUSALS: a line we cannot put back faithfully, and
// a row somebody has touched since. Getting either of those wrong quietly destroys real stock data.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { decrementInventoryItem, decrementSealedItem, reverseStockForOrder } from '../../lib/postsale.mjs';

let tdb, pdb, tmpDir;
// Mirror what applyStockDecrements writes: the effect and the applied stamp, in one row.
// order_line_items has a real FK to orders, so a line needs a real order behind it — which is the
// point of using the live schema here rather than a stand-in table.
function line(orderId, sku, effect) {
  if (!pdb.prepare('SELECT 1 FROM orders WHERE order_id=?').get(orderId)) {
    const buyerId = pdb.prepare('INSERT INTO buyers (ebay_username) VALUES (?)').run('b-' + orderId).lastInsertRowid;
    pdb.prepare('INSERT INTO orders (order_id, buyer_id) VALUES (?,?)').run(orderId, buyerId);
  }
  return pdb.prepare(`INSERT INTO order_line_items (order_id, sku, stock_applied_at, stock_effect)
                      VALUES (?,?,datetime('now'),?)`)
    .run(orderId, sku, effect ? JSON.stringify(effect) : null).lastInsertRowid;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-restock-'));
  tdb = openDbAt(path.join(tmpDir, 'tracker.db'));
  // The REAL postsale schema, not a hand-written stand-in: stock_effect and stock_reversed_at are the
  // two columns this whole feature adds via migratePostsale, and a fixture that declares them itself
  // would pass identically if that migration were never wired up.
  pdb = openPostsaleDbAt(path.join(tmpDir, 'postsale.db'));
});
after(() => {
  try { tdb.close(); } catch {} try { pdb.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
beforeEach(() => {
  tdb.exec('DELETE FROM inventory_items; DELETE FROM sealed_items; DELETE FROM sealed_placements;');
  pdb.exec('DELETE FROM order_line_items; DELETE FROM postsale_messages; DELETE FROM orders; DELETE FROM buyers;');
});

describe('reverseStockForOrder — singles', () => {
  it('a sold-out slab comes back to the shelf, but NOT back to "listed"', () => {
    const id = tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, channel_status, ebay_listing_id)
                            VALUES ('AAC-012','pokemon','Charizard',1,'listed','active','296111')`).run().lastInsertRowid;
    const dec = decrementInventoryItem(tdb, id, 1, 500000);
    line('10-1-1', 'AAC-012', dec.effect);

    const r = reverseStockForOrder(pdb, '10-1-1', tdb);
    assert.equal(r.reversed, 1);
    assert.deepEqual(r.skipped, []);

    const row = tdb.prepare('SELECT * FROM inventory_items WHERE id=?').get(id);
    assert.equal(row.quantity, 1);
    assert.equal(row.status, 'in_stock');
    // The eBay listing ENDED when it sold and a cancellation does not bring it back — eBay mints a new
    // ItemID when it relists. Restoring 'active' here would point the catalogue at a dead listing.
    assert.equal(row.channel_status, 'ended');
    assert.equal(row.sold_at, null);
    assert.equal(row.sale_price_cents, null);
    // ...and the old listing id is KEPT, because it is the pointer the relist watch follows.
    assert.equal(row.ebay_listing_id, '296111');
    assert.deepEqual(r.relist, [{ kind: 'inventory', item_id: id, sku: 'AAC-012', old_listing_id: '296111' }]);
  });

  it('a partial bulk sale restores the count and leaves the live listing alone', () => {
    const id = tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, channel_status, ebay_listing_id)
                            VALUES ('BULK-1','pokemon','Common',10,'listed','active','296222')`).run().lastInsertRowid;
    const dec = decrementInventoryItem(tdb, id, 3, 99);
    line('10-1-2', 'BULK-1', dec.effect);

    const r = reverseStockForOrder(pdb, '10-1-2', tdb);
    const row = tdb.prepare('SELECT * FROM inventory_items WHERE id=?').get(id);
    assert.equal(row.quantity, 10);
    assert.equal(row.status, 'listed');
    assert.equal(row.channel_status, 'active');   // it never ended, so nothing to restore
    // Nothing ended, so there is no relist to watch for. This guard is why the effect log records
    // whether the line SOLD OUT rather than just how many units moved.
    assert.deepEqual(r.relist, []);
  });

  it('is idempotent — a re-poll cannot restock the same line twice', () => {
    const id = tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status) VALUES ('AAC-013','pokemon','Pika',1,'listed')`).run().lastInsertRowid;
    line('10-1-3', 'AAC-013', decrementInventoryItem(tdb, id, 1, 100).effect);

    assert.equal(reverseStockForOrder(pdb, '10-1-3', tdb).reversed, 1);
    const second = reverseStockForOrder(pdb, '10-1-3', tdb);
    assert.equal(second.considered, 0);
    assert.equal(second.reversed, 0);
    assert.equal(tdb.prepare('SELECT quantity FROM inventory_items WHERE id=?').get(id).quantity, 1);
  });
});

describe('reverseStockForOrder — sealed, through placements', () => {
  it('puts the units back on the shelves they actually came off', () => {
    const id = tdb.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status, channel_status)
                            VALUES ('SEAL-1','pokemon','Booster Box','booster_box',3,'listed','active')`).run().lastInsertRowid;
    tdb.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)`).run(id, 'Shelf A', 2);
    tdb.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)`).run(id, 'Shelf B', 1);

    const dec = decrementSealedItem(tdb, id, 3);          // empties BOTH rows — they get DELETEd
    assert.equal(dec.sold, true);
    assert.equal(tdb.prepare('SELECT COUNT(*) c FROM sealed_placements WHERE item_id=?').get(id).c, 0);
    line('10-2-1', 'SEAL-1', dec.effect);

    reverseStockForOrder(pdb, '10-2-1', tdb);
    // The rows were deleted, so only the recorded LOCATION could put these back correctly. This is the
    // case that makes the effect log worth having at all.
    const places = tdb.prepare('SELECT location, quantity FROM sealed_placements WHERE item_id=? ORDER BY location').all(id)
      .map((p) => ({ location: p.location, quantity: p.quantity }));   // node:sqlite rows are null-prototype
    assert.deepEqual(places, [{ location: 'Shelf A', quantity: 2 }, { location: 'Shelf B', quantity: 1 }]);
    const row = tdb.prepare('SELECT * FROM sealed_items WHERE id=?').get(id);
    assert.equal(row.quantity, 3);
    assert.equal(row.status, 'in_stock');
    assert.equal(row.channel_status, 'ended');
  });

  it('refuses when somebody has restocked the item since the sale', () => {
    const id = tdb.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status) VALUES ('SEAL-2','pokemon','ETB','elite_trainer_box',1,'listed')`).run().lastInsertRowid;
    tdb.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)`).run(id, 'Shelf A', 1);
    line('10-2-2', 'SEAL-2', decrementSealedItem(tdb, id, 1).effect);
    // Somebody has put four of these on the shelf since. Sealed follows the SAME rule as singles: a row
    // that has moved on is a more recent decision than our snapshot, so the reversal declines and hands
    // it to a human. One rule for both kinds is worth more than a cleverer rule for each — the failure
    // mode of guessing here is silently inflated stock, which nobody notices until it oversells.
    tdb.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)`).run(id, 'Shelf A', 4);
    tdb.prepare('UPDATE sealed_items SET quantity=4 WHERE id=?').run(id);

    const r = reverseStockForOrder(pdb, '10-2-2', tdb);
    assert.equal(r.reversed, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].why, /changed after the sale/);
    assert.equal(tdb.prepare('SELECT quantity FROM sealed_items WHERE id=?').get(id).quantity, 4);
  });

  it('merges back into a placement row that survived the sale', () => {
    // A partial draw leaves the shelf's row in place, so the reversal must ADD to it rather than
    // create a second row for the same shelf.
    const id = tdb.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status) VALUES ('SEAL-3','pokemon','Tin','tin',3,'listed')`).run().lastInsertRowid;
    tdb.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)`).run(id, 'Shelf C', 3);
    line('10-2-3', 'SEAL-3', decrementSealedItem(tdb, id, 1).effect);   // 3 → 2, row survives

    const r = reverseStockForOrder(pdb, '10-2-3', tdb);
    assert.equal(r.reversed, 1);
    const places = tdb.prepare('SELECT location, quantity FROM sealed_placements WHERE item_id=?').all(id);
    assert.equal(places.length, 1, 'one shelf, one row');
    assert.equal(places[0].quantity, 3);
    assert.equal(tdb.prepare('SELECT quantity FROM sealed_items WHERE id=?').get(id).quantity, 3);
  });

  it('two lines of the SAME item: the second reverses, the first is handed to a human', () => {
    // Documenting a real edge of the drift rule rather than pretending it does not exist. Each line
    // carries its own before/after snapshot, so reversing them in sequence means the earlier line's
    // "after" no longer matches the row — and the guard refuses instead of guessing.
    //
    // It does not bite in practice: eBay aggregates a same-item purchase into ONE Transaction with
    // QuantityPurchased, so a real order has one line per item. If that ever changes, the refusal is
    // reported loudly rather than silently mis-restocking, which is the right way round to be wrong.
    const id = tdb.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status) VALUES ('SEAL-4','pokemon','Tin','tin',2,'listed')`).run().lastInsertRowid;
    tdb.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)`).run(id, 'Shelf D', 2);
    line('10-2-4', 'SEAL-4', decrementSealedItem(tdb, id, 1).effect);
    line('10-2-4', 'SEAL-4', decrementSealedItem(tdb, id, 1).effect);

    const r = reverseStockForOrder(pdb, '10-2-4', tdb);
    assert.equal(r.reversed, 1);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].why, /changed after the sale/);
  });
});

describe('reverseStockForOrder — the two refusals', () => {
  it('refuses a line with no recorded effect, and NAMES it instead of guessing', () => {
    const id = tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status) VALUES ('OLD-1','pokemon','Legacy',0,'sold')`).run().lastInsertRowid;
    line('10-3-1', 'OLD-1', null);                         // decremented before stock_effect existed

    const r = reverseStockForOrder(pdb, '10-3-1', tdb);
    assert.equal(r.reversed, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].why, /by hand/);
    assert.equal(r.skipped[0].sku, 'OLD-1');
    // Untouched — an invented quantity is worse than an honest "I can't".
    assert.equal(tdb.prepare('SELECT quantity FROM inventory_items WHERE id=?').get(id).quantity, 0);
    // ...and NOT stamped, so a human fixing the data by hand doesn't find it silently marked done.
    assert.equal(pdb.prepare('SELECT stock_reversed_at FROM order_line_items WHERE order_id=?').get('10-3-1').stock_reversed_at, null);
  });

  it('refuses a row that has moved on since the sale', () => {
    const id = tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status) VALUES ('AAC-014','pokemon','Mew',1,'listed')`).run().lastInsertRowid;
    line('10-3-2', 'AAC-014', decrementInventoryItem(tdb, id, 1, 100).effect);
    // Somebody has since re-listed and re-stocked this row. That is a more recent decision than the
    // snapshot, and stamping the snapshot over it would destroy real work.
    tdb.prepare(`UPDATE inventory_items SET quantity=4, status='listed' WHERE id=?`).run(id);

    const r = reverseStockForOrder(pdb, '10-3-2', tdb);
    assert.equal(r.reversed, 0);
    assert.match(r.skipped[0].why, /changed after the sale/);
    assert.equal(tdb.prepare('SELECT quantity FROM inventory_items WHERE id=?').get(id).quantity, 4);
  });

  it('handles a corrupt effect blob the same way as a missing one', () => {
    line('10-3-3', 'X', null);
    pdb.prepare(`UPDATE order_line_items SET stock_effect='{not json' WHERE order_id='10-3-3'`).run();
    const r = reverseStockForOrder(pdb, '10-3-3', tdb);
    assert.equal(r.reversed, 0);
    assert.equal(r.skipped.length, 1);
  });

  it('a line that was never applied is not considered at all', () => {
    line('10-3-4', 'NEVER', null);
    pdb.prepare(`UPDATE order_line_items SET stock_applied_at=NULL WHERE order_id='10-3-4'`).run();
    const r = reverseStockForOrder(pdb, '10-3-4', tdb);
    assert.equal(r.considered, 0);
  });
});
