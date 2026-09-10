// test/unit/stock-ledger.test.mjs — the ledger balances, and says why.
//
// THE INVARIANT: for every stock row, SUM(stock_movements.delta) == quantity. The column is a cache of
// the ledger, exactly as sealed_items.quantity is a cache of sealed_placements, and a cache that can
// disagree with its source without anyone noticing is the state this module exists to end.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { applyMovement, setQuantity, ledgerQty, movementsFor, reconcile, REASONS } from '../../lib/stock-ledger.mjs';

let tmpDir, db;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-ledger-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
});
after(() => { try { db.close(); } catch {} fs.rmSync(tmpDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec('DELETE FROM stock_movements; DELETE FROM inventory_items; DELETE FROM sealed_items; DELETE FROM sealed_placements;');
});

const mkItem = (qty = 0) => db.prepare(
  `INSERT INTO inventory_items (sku, game, name, quantity) VALUES ('AAC-001','pokemon','Pikachu',?)`).run(qty).lastInsertRowid;
const mkSealed = (qty = 0) => db.prepare(
  `INSERT INTO sealed_items (sku, game, product_type, name, quantity) VALUES ('BK-SLD-1','pokemon','booster_box','Box',?)`).run(qty).lastInsertRowid;
const qtyOf = (id) => db.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(id).quantity;

// The invariant, asserted over the WHOLE table rather than one row — a movement filed against the
// wrong id balances its own row and breaks another.
function assertBalanced(msg) {
  assert.deepEqual(reconcile(db), [], msg || 'the cache and the ledger disagree');
}

describe('the ledger is the authority and the column is its cache', () => {
  it('a movement writes both, and they agree', () => {
    const id = mkItem(0);
    const r = applyMovement(db, { kind: 'inventory', itemId: id, delta: 3, reason: 'receive' });
    assert.equal(r.quantity, 3);
    assert.equal(qtyOf(id), 3, 'the cache was not brought forward');
    assert.equal(ledgerQty(db, 'inventory', id), 3);
    assertBalanced();
  });

  it('balances across a receive, a partial sale, the rest of the sale and a cancellation', () => {
    const id = mkItem(0);
    applyMovement(db, { kind: 'inventory', itemId: id, delta: 5, reason: 'receive', refKind: 'po_line', refId: 12 });
    applyMovement(db, { kind: 'inventory', itemId: id, delta: -2, reason: 'sale', refKind: 'order', refId: 'A-1' });
    assert.equal(qtyOf(id), 3);
    applyMovement(db, { kind: 'inventory', itemId: id, delta: -3, reason: 'sale', refKind: 'order', refId: 'A-2' });
    assert.equal(qtyOf(id), 0);
    applyMovement(db, { kind: 'inventory', itemId: id, delta: 3, reason: 'cancel', refKind: 'order', refId: 'A-2' });
    assert.equal(qtyOf(id), 3);
    assertBalanced();
    assert.equal(movementsFor(db, 'inventory', id).length, 4, 'every step left a row');
  });

  it('records qty_after on each movement, so a balance can be read at any point', () => {
    const id = mkItem(0);
    applyMovement(db, { kind: 'inventory', itemId: id, delta: 4, reason: 'receive' });
    applyMovement(db, { kind: 'inventory', itemId: id, delta: -1, reason: 'sale' });
    const rows = movementsFor(db, 'inventory', id).reverse();
    assert.deepEqual(rows.map((r) => r.qty_after), [4, 3]);
  });

  it('carries the sku, so the trail outlives a deleted row', () => {
    const id = mkItem(0);
    applyMovement(db, { kind: 'inventory', itemId: id, delta: 1, reason: 'receive' });
    db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
    const rows = movementsFor(db, 'inventory', id);
    assert.equal(rows.length, 1, 'the movements must survive the row');
    assert.equal(rows[0].sku, 'AAC-001', 'an id that resolves to nothing is not a trail');
  });
});

describe('setQuantity, for callers that know the target rather than the change', () => {
  it('derives the delta and names a reason', () => {
    const id = mkItem(0);
    applyMovement(db, { kind: 'inventory', itemId: id, delta: 2, reason: 'receive' });
    setQuantity(db, { kind: 'inventory', itemId: id, quantity: 5, reason: 'stocktake' });
    assert.equal(qtyOf(id), 5);
    assert.equal(movementsFor(db, 'inventory', id)[0].delta, 3);
    assert.equal(movementsFor(db, 'inventory', id)[0].reason, 'stocktake');
    assertBalanced();
  });

  it('files nothing when the number did not change — a ledger of no-ops is unreadable', () => {
    const id = mkItem(0);
    applyMovement(db, { kind: 'inventory', itemId: id, delta: 2, reason: 'receive' });
    assert.equal(setQuantity(db, { kind: 'inventory', itemId: id, quantity: 2 }), null);
    assert.equal(movementsFor(db, 'inventory', id).length, 1);
  });
});

describe('a cache written from outside the ledger', () => {
  // Any path not yet routed through this module writes quantity directly. Applying a delta to a ledger
  // that never saw those units would drive it negative — sell the only copy of an unrouted row and it
  // lands at -1.
  it('is carried in as a visible correction, not silently absorbed', () => {
    const id = mkItem(4);   // straight INSERT, no movement
    assert.equal(ledgerQty(db, 'inventory', id), 0, 'the fixture is only meaningful with no movements');

    applyMovement(db, { kind: 'inventory', itemId: id, delta: -1, reason: 'sale' });
    assert.equal(qtyOf(id), 3, 'the sale must land at 3, not at -1');
    assertBalanced();

    const rows = movementsFor(db, 'inventory', id).reverse();
    assert.equal(rows[0].reason, 'correction');
    assert.equal(rows[0].delta, 4);
    assert.match(rows[0].note, /the ledger had 0/, 'the correction has to say what it noticed');
    assert.equal(rows[1].reason, 'sale');
  });
});

describe('refusals', () => {
  it('refuses an unknown kind, rather than filing against a table it guessed', () => {
    assert.throws(() => applyMovement(db, { kind: 'widgets', itemId: 1, delta: 1, reason: 'receive' }), /unknown kind/);
  });
  it('refuses an unnamed reason — that is the whole point of the vocabulary', () => {
    const id = mkItem(0);
    assert.throws(() => applyMovement(db, { kind: 'inventory', itemId: id, delta: 1, reason: 'because' }), /unknown reason/);
  });
  it('refuses a movement against a row that is not there', () => {
    assert.throws(() => applyMovement(db, { kind: 'inventory', itemId: 999999, delta: 1, reason: 'receive' }), /no inventory row/);
  });
  it('refuses a fractional delta — stock comes in whole units', () => {
    const id = mkItem(0);
    assert.throws(() => applyMovement(db, { kind: 'inventory', itemId: id, delta: 1.5, reason: 'receive' }), /whole number/);
  });
  it('every reason in the vocabulary is accepted by the CHECK constraint', () => {
    const id = mkItem(0);
    for (const reason of Object.keys(REASONS)) {
      applyMovement(db, { kind: 'inventory', itemId: id, delta: 1, reason });
    }
    assert.equal(qtyOf(id), Object.keys(REASONS).length, 'a reason the schema rejects would have thrown');
  });
});

describe('reconcile reports drift rather than repairing it', () => {
  it('names a row whose cache was written behind the ledger', () => {
    const id = mkItem(0);
    applyMovement(db, { kind: 'inventory', itemId: id, delta: 2, reason: 'receive' });
    db.prepare('UPDATE inventory_items SET quantity = 9 WHERE id = ?').run(id);   // an unrouted writer
    const drift = reconcile(db);
    assert.equal(drift.length, 1);
    assert.deepEqual({ ...drift[0], sku: undefined }, { kind: 'inventory', item_id: id, sku: undefined, cached: 9, ledger: 2, drift: 7 });
    // Report-only: fixing it automatically would destroy the evidence of which path caused it.
    assert.equal(qtyOf(id), 9, 'reconcile must not write');
  });

  it('covers both stock tables', () => {
    const sid = mkSealed(3);
    assert.equal(reconcile(db).length, 1, 'a sealed row inserted without a movement is drift too');
    assert.equal(reconcile(db)[0].kind, 'sealed');
    assert.equal(reconcile(db, { kind: 'inventory' }).length, 0, 'scoping to one kind works');
    applyMovement(db, { kind: 'sealed', itemId: sid, delta: 0, reason: 'correction' });
    assertBalanced('the catch-up should have squared it');
  });
});
