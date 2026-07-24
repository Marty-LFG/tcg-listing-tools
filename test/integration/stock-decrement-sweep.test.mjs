// test/integration/stock-decrement-sweep.test.mjs — applyStockDecrements end to end across a temp
// tracker DB + a temp postsale DB: a matched paid line decrements the listed stock and stamps
// stock_applied_at; an unmatched line is left pending; the sweep is idempotent (no double-decrement).
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
  pdb.prepare(`INSERT INTO orders (order_id, buyer_id, order_status) VALUES ('ORD-1',?,'Completed')`).run(buyerId);
  pdb.prepare(`INSERT INTO orders (order_id, buyer_id, order_status) VALUES ('ORD-2',?,'Completed')`).run(buyerId);
  pdb.prepare(`INSERT INTO order_line_items (order_id, ebay_item_id, sku, quantity, unit_price_cents) VALUES ('ORD-1','2255001',NULL,1,500000)`).run();
  pdb.prepare(`INSERT INTO order_line_items (order_id, ebay_item_id, sku, quantity, unit_price_cents) VALUES ('ORD-2','2255002','BK-RAW-PKM-000002',2,199)`).run();
  pdb.prepare(`INSERT INTO order_line_items (order_id, ebay_item_id, sku, quantity, unit_price_cents) VALUES ('ORD-2','9999999','BK-UNKNOWN',1,100)`).run();
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
    // matched lines stamped; unmatched line still pending
    assert.equal(pdb.prepare(`SELECT COUNT(*) c FROM order_line_items WHERE stock_applied_at IS NOT NULL`).get().c, 2);
    assert.equal(pdb.prepare(`SELECT COUNT(*) c FROM order_line_items WHERE stock_applied_at IS NULL`).get().c, 1);
  });

  it('is idempotent — a second sweep changes nothing', () => {
    const r = applyStockDecrements(pdb, tdb);
    assert.equal(r.applied, 0, 'nothing new applied');
    assert.equal(tdb.prepare(`SELECT quantity FROM inventory_items WHERE sku='BK-RAW-PKM-000002'`).get().quantity, 3, 'lot not double-decremented');
  });
});
