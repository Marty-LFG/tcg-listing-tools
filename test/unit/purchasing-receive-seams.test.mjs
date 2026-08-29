// test/unit/purchasing-receive-seams.test.mjs — the two doors lib/purchasing.mjs is allowed to put
// received stock through, and the invariants that are the reason they exist at all.
//
// The load-bearing one is the sealed placements mirror: sealed_items.quantity is a cached SUM of
// sealed_placements and sealed_items.location its primary spot. A receive that wrote raw INSERTs
// would corrupt that silently — the item still reads fine, it just stops agreeing with the shelf.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { receiveSealed } from '../../lib/sealed.mjs';
import { receiveInventory } from '../../lib/inventory.mjs';
import { tmpDir } from '../helpers/tmp.mjs';

let db;
const dir = tmpDir('tcg-receive-seams-');

before(() => { db = openDbAt(path.join(dir, 'seams.db')); });
after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

const sealedQty = (id) => db.prepare('SELECT quantity, location, cost_cents, acq_fees_cents FROM sealed_items WHERE id=?').get(id);
const placeSum = (id) => db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM sealed_placements WHERE item_id=?').get(id).n;

describe('receiveSealed', () => {
  it('creates a row, mints a BK-SLD sku, and mirrors quantity/location from the placements', () => {
    const r = receiveSealed(db, {
      item: { game: 'pokemon', product_type: 'booster_box', name: 'Surging Sparks Booster Box' },
      placements: [{ location: 'SHELF-A', quantity: 4 }, { location: 'TUB-3', quantity: 2 }],
      costCents: 16840, acqFeesCents: 412, acquiredAt: '2026-08-20', sourceVendor: 'Card Shark AU',
      poLineId: 77,
    });
    assert.equal(r.created, true);
    assert.match(r.sku, /^BK-SLD-PKM-\d{6}$/);
    const row = sealedQty(r.id);
    assert.equal(row.quantity, 6, 'quantity mirrors the SUM of placements');
    assert.equal(placeSum(r.id), 6, 'the placements themselves carry the units');
    assert.equal(row.location, 'SHELF-A', 'location mirrors the FIRST located spot');
    assert.equal(row.cost_cents, 16840);
    assert.equal(row.acq_fees_cents, 412);
    const prov = db.prepare('SELECT po_line_id, source_vendor FROM sealed_items WHERE id=?').get(r.id);
    assert.equal(prov.po_line_id, 77, 'the row points back at the purchase line it came from');
    assert.equal(prov.source_vendor, 'Card Shark AU');
  });

  it('merges a restock into the existing row rather than minting a second sku', () => {
    const first = receiveSealed(db, {
      item: { game: 'pokemon', product_type: 'elite_trainer_box', name: 'Prismatic ETB' },
      placements: [{ location: 'SHELF-B', quantity: 3 }],
      costCents: 10000, acqFeesCents: 500,
    });
    const before = db.prepare('SELECT COUNT(*) n FROM sealed_items').get().n;
    const again = receiveSealed(db, {
      itemId: first.id,
      placements: [{ location: 'SHELF-B', quantity: 2 }, { location: 'TUB-9', quantity: 1 }],
      costCents: 13000, acqFeesCents: 500,
    });
    assert.equal(again.created, false);
    assert.equal(again.sku, first.sku, 'the restock keeps the original sku');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sealed_items').get().n, before, 'no second row');

    const row = sealedQty(first.id);
    assert.equal(row.quantity, 6, '3 held + 3 received');
    assert.equal(placeSum(first.id), 6, 'the mirror still agrees with the placements');
    // SHELF-B bumped rather than duplicated; TUB-9 added.
    const spots = db.prepare('SELECT location, quantity FROM sealed_placements WHERE item_id=? ORDER BY id').all(first.id);
    assert.deepEqual(spots.map((s) => ({ ...s })), [{ location: 'SHELF-B', quantity: 5 }, { location: 'TUB-9', quantity: 1 }]);
    // Weighted average: (10000*3 + 13000*3) / 6 = 11500. Fees are equal, so they do not move.
    assert.equal(row.cost_cents, 11500, 'cost blends to the weighted average, it does not overwrite');
    assert.equal(row.acq_fees_cents, 500);
  });

  it('treats an unknown cost as unknown, not as zero', () => {
    const it1 = receiveSealed(db, {
      item: { game: 'mtg', product_type: 'booster_box', name: 'No-cost box' },
      placements: [{ location: null, quantity: 1 }],
    });
    assert.equal(sealedQty(it1.id).cost_cents, null);
    // An unknown OLD cost adopts the new figure outright — averaging against 0 would halve a known
    // number using an unknown one.
    receiveSealed(db, { itemId: it1.id, placements: [{ location: null, quantity: 1 }], costCents: 9000 });
    assert.equal(sealedQty(it1.id).cost_cents, 9000);
    // An unknown NEW cost leaves the old one alone.
    receiveSealed(db, { itemId: it1.id, placements: [{ location: null, quantity: 1 }] });
    assert.equal(sealedQty(it1.id).cost_cents, 9000);
  });

  it('refuses to receive nothing', () => {
    assert.throws(() => receiveSealed(db, { item: { game: 'pokemon', name: 'x' }, placements: [] }),
      /at least one unit/);
  });

  it('normalises a cross-game product type to other rather than polluting the facet', () => {
    const r = receiveSealed(db, {
      item: { game: 'mtg', product_type: 'elite_trainer_box', name: 'Not an MTG product type' },
      placements: [{ location: null, quantity: 1 }],
    });
    assert.equal(db.prepare('SELECT product_type FROM sealed_items WHERE id=?').get(r.id).product_type, 'other');
  });
});

describe('receiveInventory', () => {
  it('creates a singles row with a location and cost basis', () => {
    const r = receiveInventory(db, {
      item: { game: 'pokemon', name: 'Pikachu', number: '025', set_name: 'SV151', condition: 'Near Mint' },
      quantity: 4, location: 'BINDER-2', costCents: 300, acqFeesCents: 25, poLineId: 91,
    });
    assert.equal(r.created, true);
    const row = db.prepare('SELECT quantity, location, cost_cents, acq_fees_cents, po_line_id FROM inventory_items WHERE id=?').get(r.id);
    assert.deepEqual({ ...row }, { quantity: 4, location: 'BINDER-2', cost_cents: 300, acq_fees_cents: 25, po_line_id: 91 });
  });

  it('merges a restock, blends cost, and does not move stock already on a shelf', () => {
    const first = receiveInventory(db, {
      item: { game: 'mtg', name: 'Lightning Bolt', condition: 'Near Mint' },
      quantity: 2, location: 'BOX-1', costCents: 1000,
    });
    const again = receiveInventory(db, { itemId: first.id, quantity: 2, location: 'BOX-9', costCents: 2000 });
    assert.equal(again.created, false);
    const row = db.prepare('SELECT quantity, location, cost_cents FROM inventory_items WHERE id=?').get(first.id);
    assert.equal(row.quantity, 4);
    assert.equal(row.location, 'BOX-1', 'a restock names where the NEW units went; it must not relocate the old ones');
    assert.equal(row.cost_cents, 1500, 'weighted average of 1000x2 and 2000x2');
  });

  it('adopts a location when the item had none', () => {
    const first = receiveInventory(db, { item: { game: 'mtg', name: 'Homeless card' }, quantity: 1 });
    assert.equal(db.prepare('SELECT location FROM inventory_items WHERE id=?').get(first.id).location, null);
    receiveInventory(db, { itemId: first.id, quantity: 1, location: 'BOX-4' });
    assert.equal(db.prepare('SELECT location FROM inventory_items WHERE id=?').get(first.id).location, 'BOX-4');
  });

  it('refuses an unsupported game', () => {
    assert.throws(() => receiveInventory(db, { item: { game: 'chess', name: 'Rook' }, quantity: 1 }), /game/);
  });
});
