// test/integration/stock-decrement-sweep.test.mjs — applyStockDecrements end to end across a temp
// tracker DB + a temp postsale DB: a matched paid line decrements the listed stock and stamps
// stock_applied_at; an unmatched line is left pending; the sweep is idempotent (no double-decrement);
// and a line belonging to an unpaid, unsettled or cancelled order is never touched at all.
//
// That last group is the reason the query joins `orders`. Stock leaving the shelf is the one effect
// here that cannot be undone by a later poll noticing its mistake — decrementInventoryItem writes
// status='sold' and decrementSealedItem DELETEs placements — so the guard belongs at the write, not
// in whichever caller happens to run the sweep.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { applyStockDecrements } from '../../lib/postsale.mjs';

let tdb, pdb, tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-sweep-'));
  tdb = openDbAt(path.join(tmpDir, 'tracker.db'));
  pdb = openPostsaleDbAt(path.join(tmpDir, 'postsale.db'));
  // A listed slab (SKU + ebay_listing_id populated at publish) and a listed raw lot of 5.
  tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, ebay_listing_id) VALUES ('BK-PKM-000001','pokemon','Charizard',1,'listed','2255001')`).run();
  tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, ebay_listing_id) VALUES ('BK-RAW-PKM-000002','pokemon','Common Lot',5,'listed','2255002')`).run();
  // Two paid orders: one buys the slab (match by ebay_item_id), one buys 2 of the lot (match by SKU),
  // and one line for a card we don't hold (unmatched → stays pending).
  const buyerId = pdb.prepare(`INSERT INTO buyers (ebay_username) VALUES ('buyer-1')`).run().lastInsertRowid;
  const PAID = '2026-08-01T00:00:00.000Z';
  pdb.prepare(`INSERT INTO orders (order_id, buyer_id, order_status, paid_time) VALUES ('ORD-1',?,'Completed',?)`).run(buyerId, PAID);
  pdb.prepare(`INSERT INTO orders (order_id, buyer_id, order_status, paid_time) VALUES ('ORD-2',?,'Completed',?)`).run(buyerId, PAID);
  pdb.prepare(`INSERT INTO order_line_items (order_id, ebay_item_id, sku, quantity, unit_price_cents) VALUES ('ORD-1','2255001',NULL,1,500000)`).run();
  pdb.prepare(`INSERT INTO order_line_items (order_id, ebay_item_id, sku, quantity, unit_price_cents) VALUES ('ORD-2','2255002','BK-RAW-PKM-000002',2,199)`).run();
  pdb.prepare(`INSERT INTO order_line_items (order_id, ebay_item_id, sku, quantity, unit_price_cents) VALUES ('ORD-2','9999999','BK-UNKNOWN',1,100)`).run();

  // Four orders the sweep must refuse, each buying the SAME lot the paid orders matched — so if any
  // one of them were swept, the lot's quantity would visibly drop below the expected 3.
  tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, ebay_listing_id) VALUES ('BK-RAW-PKM-000003','pokemon','Guarded Lot',9,'listed','2255003')`).run();
  const refuse = [
    ['ORD-UNPAID', null, null, null],                  // never paid at all
    ['ORD-PENDING', PAID, 'pending', null],            // PaidTime set, money still in flight
    ['ORD-FAILED', PAID, 'failed', null],              // bounced after PaidTime
    ['ORD-CANCELLED', PAID, 'ok', 'cancelled'],        // paid, then cancelled
  ];
  for (const [id, paid, pay, cancel] of refuse) {
    pdb.prepare(`INSERT INTO orders (order_id, buyer_id, order_status, paid_time, payment_state, cancel_state) VALUES (?,?,'Completed',?,?,?)`)
      .run(id, buyerId, paid, pay, cancel);
    pdb.prepare(`INSERT INTO order_line_items (order_id, ebay_item_id, sku, quantity, unit_price_cents) VALUES (?,'2255003','BK-RAW-PKM-000003',1,199)`).run(id);
  }
});
after(() => { try { tdb.close(); pdb.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

describe('applyStockDecrements', () => {
  it('decrements matched lines (slab sold, lot -2) and leaves the unmatched line pending', () => {
    const r = applyStockDecrements(pdb, tdb);
    assert.equal(r.applied, 2, 'two matched lines applied');
    assert.equal(r.sold, 1, 'the slab sold out');
    // slab → sold
    const slab = tdb.prepare(`SELECT status, quantity, sale_price_cents FROM inventory_items WHERE sku='BK-PKM-000001'`).get();
    assert.equal(slab.status, 'sold');
    assert.equal(slab.quantity, 0);
    assert.equal(slab.sale_price_cents, 500000);
    // lot → 3 left, still listed
    const lot = tdb.prepare(`SELECT status, quantity FROM inventory_items WHERE sku='BK-RAW-PKM-000002'`).get();
    assert.equal(lot.quantity, 3);
    assert.equal(lot.status, 'listed');
    // matched lines stamped; unmatched line + the four refused ones still pending
    assert.equal(pdb.prepare(`SELECT COUNT(*) c FROM order_line_items WHERE stock_applied_at IS NOT NULL`).get().c, 2);
    assert.equal(pdb.prepare(`SELECT COUNT(*) c FROM order_line_items WHERE stock_applied_at IS NULL`).get().c, 5);
  });

  it('NEVER decrements for an unpaid, unsettled, failed or cancelled order', () => {
    // All four bought the same lot. Untouched quantity is the whole assertion: any one of them
    // slipping through the join would show up here as 8 or less.
    const lot = tdb.prepare(`SELECT quantity, status FROM inventory_items WHERE sku='BK-RAW-PKM-000003'`).get();
    assert.equal(lot.quantity, 9, 'no guarded order may move stock');
    assert.equal(lot.status, 'listed');
    const stamped = pdb.prepare(`SELECT COUNT(*) c FROM order_line_items WHERE sku='BK-RAW-PKM-000003' AND stock_applied_at IS NOT NULL`).get().c;
    assert.equal(stamped, 0, 'and none may be marked applied either');
  });

  it('sweeps the moment the money actually lands, and only that one', () => {
    // The other side of the guard: this must be a hold, not a permanent exclusion, or an order that
    // pays after a wobble would never decrement at all.
    pdb.prepare(`UPDATE orders SET paid_time=?, payment_state='ok' WHERE order_id='ORD-PENDING'`).run('2026-08-02T00:00:00.000Z');
    const r = applyStockDecrements(pdb, tdb);
    assert.equal(r.applied, 1, 'exactly the order that settled');
    assert.equal(tdb.prepare(`SELECT quantity FROM inventory_items WHERE sku='BK-RAW-PKM-000003'`).get().quantity, 8);
  });

  it('is idempotent — a second sweep changes nothing', () => {
    const r = applyStockDecrements(pdb, tdb);
    assert.equal(r.applied, 0, 'nothing new applied');
    assert.equal(tdb.prepare(`SELECT quantity FROM inventory_items WHERE sku='BK-RAW-PKM-000002'`).get().quantity, 3, 'lot not double-decremented');
  });
});
