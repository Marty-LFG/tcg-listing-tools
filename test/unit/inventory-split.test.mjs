// test/unit/inventory-split.test.mjs — splitting a bulk row into single rows.
//
// WHY IT MATTERS HERE. `holdForRun` refuses a quantity above 1 with "split it into single rows before
// holding it for a run", because a partial reservation against a qty-3 row means the database can no
// longer answer "this exact physical object is in bundle 7" — the entire verification claim of Keeper's
// Runs. That instruction was unfollowable: nothing could split a row, so twenty-five art cards arriving
// as one bulk line had no path into a manifest at all.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { splitInventoryItem } from '../../lib/inventory.mjs';
import { holdForRun } from '../../lib/runs-reserve.mjs';

const db = openDbAt(tmpFile('inventory-split.db'));

let n = 0;
const mk = (over = {}) => {
  const k = ++n;
  db.prepare(`INSERT INTO inventory_items
    (sku, game, name, number, rarity, language, set_name, set_code, quantity, status, ebay_listing_id, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`SP-${k}`, 'pokemon', over.name ?? `Art Card ${k}`, '201', 'Art Rare', 'JA', 'Sample Set',
      over.set_code ?? 'SV1', over.quantity ?? 25, over.status ?? 'in_stock',
      over.ebay_listing_id ?? null, over.notes ?? 'a bulk line');
  return db.prepare('SELECT * FROM inventory_items WHERE sku = ?').get(`SP-${k}`);
};

describe('splitting a bulk row', () => {
  it('turns one row of 25 into twenty-five rows of 1', () => {
    const row = mk({ quantity: 25 });
    const out = splitInventoryItem(db, row.id);
    assert.equal(out.was, 25);
    assert.equal(out.created.length, 24, 'the original is one of the twenty-five');

    const all = [row.id, ...out.created.map((c) => c.id)];
    for (const id of all) {
      assert.equal(db.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(id).quantity, 1);
    }
    assert.equal(new Set(all).size, 25);
  });

  it('KEEPS THE ORIGINAL ROW ID AND SKU, and makes the siblings the copies', () => {
    // Not cosmetic. ebay_listing_id, valuations, batch membership and any published listing all point at
    // that id — minting a fresh row for the original and deleting it would orphan every one of them.
    const row = mk({ quantity: 3 });
    const out = splitInventoryItem(db, row.id);
    assert.equal(out.id, row.id);
    const after = db.prepare('SELECT sku, quantity FROM inventory_items WHERE id = ?').get(row.id);
    assert.equal(after.sku, row.sku);
    assert.equal(after.quantity, 1);
  });

  it('gives every sibling a fresh unique SKU', () => {
    const row = mk({ quantity: 4 });
    const out = splitInventoryItem(db, row.id);
    const skus = [row.sku, ...out.created.map((c) => c.sku)];
    assert.equal(new Set(skus).size, 4);
    for (const c of out.created) assert.notEqual(c.sku, row.sku);
  });

  it('copies the card, including the set code a run will hash', () => {
    const row = mk({ quantity: 2, set_code: 'SV3PT5', name: 'Copied Card' });
    const out = splitInventoryItem(db, row.id);
    const sib = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(out.created[0].id);
    assert.equal(sib.name, 'Copied Card');
    assert.equal(sib.set_code, 'SV3PT5');
    assert.equal(sib.language, 'JA');
    assert.equal(sib.notes, 'a bulk line');
  });

  it('but NEVER copies the eBay listing id', () => {
    // Two rows pointing at one live listing is how a single card gets sold twice.
    const row = mk({ quantity: 3, ebay_listing_id: '1234567890' });
    const out = splitInventoryItem(db, row.id);
    for (const c of out.created) {
      assert.equal(db.prepare('SELECT ebay_listing_id FROM inventory_items WHERE id = ?').get(c.id).ebay_listing_id, null);
    }
    assert.equal(db.prepare('SELECT ebay_listing_id FROM inventory_items WHERE id = ?').get(row.id).ebay_listing_id,
      '1234567890', 'the original keeps its own listing');
  });

  it('refuses a row that is already a single', () => {
    assert.throws(() => splitInventoryItem(db, mk({ quantity: 1 }).id), /already a single row/);
  });

  it('refuses a sold row, because splitting it would invent stock', () => {
    assert.throws(() => splitInventoryItem(db, mk({ quantity: 5, status: 'sold' }).id), /is sold/);
  });

  it('and refuses an item that does not exist', () => {
    assert.throws(() => splitInventoryItem(db, 999999), /no such inventory item/);
  });
});

describe('the instruction holdForRun gives is now followable', () => {
  it('a bulk row is refused, and split, and then accepted', () => {
    // The whole point of the helper, end to end and in the order an operator meets it.
    db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status)
                VALUES ('SPLIT1', 1, 'Split', 'live', 3, 'draft')`).run();
    const runId = db.prepare("SELECT id FROM runs WHERE public_id = 'SPLIT1'").get().id;
    const row = mk({ quantity: 3 });

    assert.throws(() => holdForRun(db, { kind: 'inventory', itemId: row.id, runId }),
      /split it into single rows before holding it for a run/);

    const out = splitInventoryItem(db, row.id);

    const held = holdForRun(db, { kind: 'inventory', itemId: row.id, runId });
    assert.ok(held.id, 'the original now holds');
    const sib = holdForRun(db, { kind: 'inventory', itemId: out.created[0].id, runId });
    assert.ok(sib.id, 'and so does a sibling');
  });
});
