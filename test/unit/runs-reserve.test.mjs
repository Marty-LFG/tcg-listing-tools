// test/unit/runs-reserve.test.mjs — the reservation ledger (lib/runs-reserve.mjs).
//
// The schema test proves the DATABASE refuses; this one proves the MODULE refuses for the things a
// constraint cannot express — the sealed aggregate (SQLite has no SUM constraint without a trigger),
// the dev/live asymmetries, and the state machine around promotion.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import {
  liveReservation, reservedUnits, onHandUnits, availableUnits, assertNotReserved, channelHoldFor,
  holdForRun, assignToSlot, releaseReservation, consumeReservation, breakReservation, abandonRun,
  devRunHoldings, reservedPoolUnits, blockIfHeld, breakOversoldReservations,
} from '../../lib/runs-reserve.mjs';

const db = openDbAt(tmpFile('runs-reserve.db'));

let n = 0;
const mkInv = (over = {}) => {
  const id = ++n;
  db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, cert_number, channel_status, ebay_listing_id)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(`SKU-${id}`, 'pokemon', over.name ?? `Card ${id}`, over.quantity ?? 1,
      over.status ?? 'in_stock', over.cert_number ?? null, over.channel_status ?? null,
      over.ebay_listing_id ?? null);
  return db.prepare('SELECT id FROM inventory_items WHERE sku = ?').get(`SKU-${id}`).id;
};
const mkSealed = (qty = 10) => {
  const id = ++n;
  db.prepare(`INSERT INTO sealed_items (sku, game, product_type, name, quantity, status)
              VALUES (?,?,?,?,?,'in_stock')`).run(`SLD-${id}`, 'pokemon', 'booster_pack', `Pack ${id}`, qty);
  return db.prepare('SELECT id FROM sealed_items WHERE sku = ?').get(`SLD-${id}`).id;
};
let runN = 0;
function mkRun(mode = 'live', status = 'draft') {
  const k = ++runN;
  const pid = (mode === 'dev' ? 'DEV-E' : 'E') + k;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status)
              VALUES (?,?,?,?,3,?)`).run(pid, k, `Edition ${k}`, mode, status);
  const runId = db.prepare('SELECT id FROM runs WHERE public_id = ?').get(pid).id;
  db.prepare(`INSERT INTO run_slot_specs (run_id, slot, label, kind, qty_per_bundle, max_lines,
              singleton, requires_cert, is_chase_slot, sort_order)
              VALUES (?,'slab','Graded slab','inventory',1,1,1,1,1,0),
                     (?,'packs','Sealed packs','sealed',3,3,0,0,0,1)`).run(runId, runId);
  db.prepare(`INSERT INTO run_bundles (run_id, bundle_no, label) VALUES (?,1,?)`).run(runId, `${pid}-001`);
  const bundleId = db.prepare('SELECT id FROM run_bundles WHERE run_id = ?').get(runId).id;
  return { runId, bundleId, pid };
}

describe('predicates', () => {
  it('reads on-hand from whichever stock table the kind names, and zero once sold', () => {
    assert.equal(onHandUnits(db, 'inventory', mkInv()), 1);
    assert.equal(onHandUnits(db, 'sealed', mkSealed(7)), 7);
    assert.equal(onHandUnits(db, 'inventory', mkInv({ status: 'sold' })), 0);
    assert.equal(onHandUnits(db, 'inventory', 999999), 0);
  });

  it('counts reserved units and never reports negative availability', () => {
    const s = mkSealed(5);
    assert.equal(availableUnits(db, 'sealed', s), 5);
    holdForRun(db, { kind: 'sealed', itemId: s, qty: 3 });
    assert.equal(reservedUnits(db, 'sealed', s), 3);
    assert.equal(availableUnits(db, 'sealed', s), 2);
    // a released hold stops counting
    const r2 = holdForRun(db, { kind: 'sealed', itemId: s, qty: 2 });
    assert.equal(availableUnits(db, 'sealed', s), 0);
    releaseReservation(db, r2.id);
    assert.equal(availableUnits(db, 'sealed', s), 2);
  });

  it('detects a live channel so lockRun can refuse until it is withdrawn', () => {
    const live = mkInv({ channel_status: 'active', ebay_listing_id: '1234' });
    assert.equal(channelHoldFor(db, 'inventory', live), 'ebay_live');
    assert.equal(channelHoldFor(db, 'inventory', mkInv()), null);
    const sh = mkInv();
    db.prepare(`INSERT INTO shopify_listings (sku, kind, item_id, state) VALUES (?,?,?,'live')`)
      .run(`SH-${sh}`, 'inventory', sh);
    assert.equal(channelHoldFor(db, 'inventory', sh), 'shopify_live');
    assert.equal(holdForRun(db, { kind: 'inventory', itemId: sh }).channel_hold, 'shopify_live');
  });
});

describe('assertNotReserved — the guard every publish path calls', () => {
  it('refuses a reserved inventory row, naming where it went', () => {
    const { runId, bundleId } = mkRun();
    const item = mkInv();
    assert.equal(assertNotReserved(db, 'inventory', item), null);
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    const g1 = assertNotReserved(db, 'inventory', item);
    assert.equal(g1.code, 'reserved_for_run');
    assert.match(g1.error, /reserved for run E\d/);
    assignToSlot(db, { reservationId: h.id, bundleId, slot: 'slab' });
    assert.match(assertNotReserved(db, 'inventory', item).error, /bundle E\d-001/);
  });

  it('refuses a hold that belongs to no run yet — flagged at intake, before a run exists', () => {
    const item = mkInv();
    holdForRun(db, { kind: 'inventory', itemId: item, runId: null });
    const g = assertNotReserved(db, 'inventory', item);
    assert.equal(g.code, 'reserved_for_run');
    assert.equal(g.run, null);
    assert.match(g.error, /reserved for a run/);
  });

  it('does NOT refuse sealed — the pool is genuinely shared, so the answer is to shrink not to refuse', () => {
    const s = mkSealed(10);
    holdForRun(db, { kind: 'sealed', itemId: s, qty: 4 });
    assert.equal(assertNotReserved(db, 'sealed', s), null);
    assert.equal(availableUnits(db, 'sealed', s), 6);
  });

  it('stops refusing once released', () => {
    const item = mkInv();
    const h = holdForRun(db, { kind: 'inventory', itemId: item });
    assert.ok(assertNotReserved(db, 'inventory', item));
    releaseReservation(db, h.id, 'plan changed');
    assert.equal(assertNotReserved(db, 'inventory', item), null);
  });
});

describe('holdForRun', () => {
  it('refuses a multi-quantity inventory row rather than splitting it silently', () => {
    const item = mkInv({ quantity: 3 });
    assert.throws(() => holdForRun(db, { kind: 'inventory', itemId: item }), /split it into single rows/);
  });

  it('refuses qty > 1 on inventory, allows it on sealed', () => {
    assert.throws(() => holdForRun(db, { kind: 'inventory', itemId: mkInv(), qty: 2 }), /one physical object/);
    holdForRun(db, { kind: 'sealed', itemId: mkSealed(9), qty: 5 });
  });

  it('enforces the sealed aggregate the database cannot express', () => {
    const s = mkSealed(4);
    holdForRun(db, { kind: 'sealed', itemId: s, qty: 3 });
    assert.throws(() => holdForRun(db, { kind: 'sealed', itemId: s, qty: 2 }), /only 1 .* are free/);
    holdForRun(db, { kind: 'sealed', itemId: s, qty: 1 });
    assert.equal(availableUnits(db, 'sealed', s), 0);
  });

  it('refuses sold stock and unknown ids', () => {
    assert.throws(() => holdForRun(db, { kind: 'inventory', itemId: mkInv({ status: 'sold' }) }), /already sold/);
    assert.throws(() => holdForRun(db, { kind: 'inventory', itemId: 987654 }), /no such inventory item/);
    assert.throws(() => holdForRun(db, { kind: 'nonsense', itemId: 1 }), /bad kind/);
  });

  it('refuses to hold against a run that is no longer editable', () => {
    const { runId } = mkRun('live', 'draft');
    db.prepare(`UPDATE runs SET status='locked_published', run_root='a', header_digest='b',
                locked_at=datetime('now') WHERE id=?`).run(runId);
    assert.throws(() => holdForRun(db, { kind: 'inventory', itemId: mkInv(), runId }), /only be held while it is draft/);
  });

  it('rolls back completely when the transaction fails', () => {
    const item = mkInv();
    holdForRun(db, { kind: 'inventory', itemId: item });
    const before = db.prepare('SELECT count(*) n FROM run_audit').get().n;
    assert.throws(() => holdForRun(db, { kind: 'inventory', itemId: item }));   // unique index
    assert.equal(db.prepare('SELECT count(*) n FROM run_audit').get().n, before, 'audit row survived a rollback');
    assert.equal(reservedUnits(db, 'inventory', item), 1);
  });
});

describe('assignToSlot — promotion is an UPDATE, never a second row', () => {
  it('promotes held-for-runs to a slot without creating another reservation', () => {
    const { runId, bundleId } = mkRun();
    const item = mkInv();
    const h = holdForRun(db, { kind: 'inventory', itemId: item });      // no run yet
    assignToSlot(db, { reservationId: h.id, bundleId, slot: 'slab' });
    const rows = db.prepare('SELECT * FROM run_reservations WHERE item_id = ? AND kind = ?').all(item, 'inventory');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].run_id, runId);
    assert.equal(rows[0].slot, 'slab');
  });

  it('refuses a slot the run does not declare, and a kind mismatch', () => {
    const { bundleId } = mkRun();
    const h = holdForRun(db, { kind: 'inventory', itemId: mkInv() });
    assert.throws(() => assignToSlot(db, { reservationId: h.id, bundleId, slot: 'nope' }), /declares no slot/);
    assert.throws(() => assignToSlot(db, { reservationId: h.id, bundleId, slot: 'packs' }), /takes sealed stock/);
  });

  it('refuses to move a hold belonging to another run', () => {
    const a = mkRun(); const b = mkRun();
    const h = holdForRun(db, { kind: 'inventory', itemId: mkInv(), runId: a.runId });
    assert.throws(() => assignToSlot(db, { reservationId: h.id, bundleId: b.bundleId, slot: 'slab' }),
      /held for a different run/);
  });

  it('refuses once the run has left draft', () => {
    const { runId, bundleId } = mkRun();
    const h = holdForRun(db, { kind: 'inventory', itemId: mkInv(), runId });
    db.prepare(`UPDATE runs SET status='locked_published', run_root='a', header_digest='b',
                locked_at=datetime('now') WHERE id=?`).run(runId);
    assert.throws(() => assignToSlot(db, { reservationId: h.id, bundleId, slot: 'slab' }),
      /no longer editable/);
  });
});

describe('release, break and the committed boundary', () => {
  it('refuses to release a committed reservation — that needs an amendment', () => {
    const { runId } = mkRun();
    const h = holdForRun(db, { kind: 'inventory', itemId: mkInv(), runId });
    db.prepare(`UPDATE run_reservations SET state='committed' WHERE id=?`).run(h.id);
    assert.throws(() => releaseReservation(db, h.id), /needs an amendment/);
  });

  it('records a broken reservation instead of deleting it', () => {
    const { runId } = mkRun();
    const item = mkInv();
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    breakReservation(db, h.id, 'sold on eBay while reserved');
    const row = db.prepare('SELECT state FROM run_reservations WHERE id=?').get(h.id);
    assert.equal(row.state, 'broken');
    // and it no longer blocks, because the item genuinely left
    assert.equal(assertNotReserved(db, 'inventory', item), null);
    assert.equal(db.prepare(`SELECT count(*) n FROM run_audit WHERE action='reservation_broken'`).get().n, 1);
  });
});

describe('dev-run asymmetries', () => {
  it('NEVER decrements real stock for a dev run', async () => {
    const { runId } = mkRun('dev');
    const item = mkInv();
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    db.prepare(`UPDATE run_reservations SET state='committed' WHERE id=?`).run(h.id);
    let called = false;
    const r = await consumeReservation(db, h.id, {
      decrementers: { decrementInventoryItem: () => { called = true; }, decrementSealedItem: () => { called = true; } },
    });
    assert.equal(r.skipped, 'dev_run');
    assert.equal(called, false, 'a dev run reached the decrementer');
    assert.equal(onHandUnits(db, 'inventory', item), 1, 'dev run reduced real stock');
  });

  it('does decrement for a live run, and stores the effect blob a reversal needs', async () => {
    const { runId } = mkRun('live');
    const item = mkInv();
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    db.prepare(`UPDATE run_reservations SET state='committed' WHERE id=?`).run(h.id);
    const r = await consumeReservation(db, h.id, {
      decrementers: {
        decrementInventoryItem: () => ({ ok: true, sold: true, newQty: 0, effect: { v: 1, kind: 'inventory' } }),
        decrementSealedItem: () => { throw new Error('wrong branch'); },
      },
    });
    assert.equal(r.consumed, true);
    const row = db.prepare('SELECT state, stock_effect FROM run_reservations WHERE id=?').get(h.id);
    assert.equal(row.state, 'consumed');
    assert.equal(JSON.parse(row.stock_effect).kind, 'inventory');
  });

  it('abandons a dev run, releasing even committed reservations', () => {
    const { runId, pid } = mkRun('dev');
    const a = holdForRun(db, { kind: 'inventory', itemId: mkInv(), runId });
    const b = holdForRun(db, { kind: 'inventory', itemId: mkInv(), runId });
    db.prepare(`UPDATE run_reservations SET state='committed' WHERE id=?`).run(b.id);
    const out = abandonRun(db, runId, { reason: 'rehearsal done' });
    assert.equal(out.released, 2);
    assert.equal(out.run, pid);
    for (const id of [a.id, b.id]) {
      assert.equal(db.prepare('SELECT state FROM run_reservations WHERE id=?').get(id).state, 'released');
    }
    assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status, 'abandoned');
  });

  it('REFUSES to abandon a live run — there is no unpicking a published manifest', () => {
    const { runId } = mkRun('live');
    assert.throws(() => abandonRun(db, runId), /only for dev rehearsals/);
  });

  // The two consume cases above inject fakes, so neither exercises the lazy import that exists to break
  // the listings -> runs-reserve -> postsale -> listings cycle. If that import is wrong the failure is
  // silent right up until a real pack, so it gets its own case against real placements.
  it('with no injection, reaches the REAL decrementSealedItem and draws placements down', async () => {
    const { runId } = mkRun('live');
    const item = mkSealed(0);
    db.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?),(?,?,?)`)
      .run(item, 'Shelf A', 5, item, 'Shelf B', 2);
    db.prepare('UPDATE sealed_items SET quantity = 7 WHERE id = ?').run(item);

    const h = holdForRun(db, { kind: 'sealed', itemId: item, qty: 6 });
    db.prepare(`UPDATE run_reservations SET state='committed' WHERE id=?`).run(h.id);
    const r = await consumeReservation(db, h.id);                      // no decrementers passed

    assert.equal(r.consumed, true);
    assert.equal(r.newQty, 1, 'seven on hand minus six taken');
    assert.equal(onHandUnits(db, 'sealed', item), 1);
    // The effect blob must name the LOCATIONS, because the placement row is deleted when it empties and
    // the location is then the only thing that could put those units back on the right shelf.
    const eff = JSON.parse(db.prepare('SELECT stock_effect FROM run_reservations WHERE id=?').get(h.id).stock_effect);
    assert.equal(eff.kind, 'sealed');
    assert.deepEqual(eff.placements.map((p) => p.location).sort(), ['Shelf A', 'Shelf B']);
    assert.ok(eff.placements.some((p) => p.deleted), 'the emptied placement was not recorded as deleted');
  });

  it('reports what dev runs are holding, because silent locked stock is the failure mode', () => {
    const rows = devRunHoldings(db);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.run.startsWith('DEV-')));
    assert.ok(rows.every((r) => r.units >= 1));
  });
});

// --- blocking vs encumbering ------------------------------------------------------------------------
//
// THE BUG THIS PINS (caught in review, never shipped): `consumed` was in one state list used for both
// questions. It has to be in the blocking one — a packed card must never be listed again — and it has
// to be OUT of the encumbering one, because consumeReservation has ALREADY decremented the stock table.
// Counting it in both removes the same units twice, so a pool of ten with six packed reports zero
// sellable instead of four, and the shop quietly stops selling stock that is sitting on the shelf.
describe('a consumed reservation blocks, but no longer encumbers', () => {
  it('sealed: the units are gone from stock, so they must not be subtracted a second time', async () => {
    mkRun('live');
    const item = mkSealed(0);
    db.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)`).run(item, 'Shelf C', 10);
    db.prepare('UPDATE sealed_items SET quantity = 10 WHERE id = ?').run(item);

    const h = holdForRun(db, { kind: 'sealed', itemId: item, qty: 6 });
    assert.equal(reservedUnits(db, 'sealed', item), 6, 'an active hold encumbers');
    assert.equal(availableUnits(db, 'sealed', item), 4);

    db.prepare(`UPDATE run_reservations SET state='committed' WHERE id=?`).run(h.id);
    await consumeReservation(db, h.id);

    assert.equal(onHandUnits(db, 'sealed', item), 4, 'the decrement already happened');
    assert.equal(reservedUnits(db, 'sealed', item), 0, 'a consumed hold must NOT encumber — the units left');
    assert.equal(availableUnits(db, 'sealed', item), 4, 'four, not minus two');
  });

  it('inventory: consumed still BLOCKS, so a packed card can never be listed again', () => {
    const { runId, bundleId } = mkRun('live');
    const item = mkInv({ cert_number: 'CERT-CONSUMED' });
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    assignToSlot(db, { reservationId: h.id, bundleId, slot: 'slab' });
    db.prepare(`UPDATE run_reservations SET state='consumed' WHERE id=?`).run(h.id);

    assert.ok(liveReservation(db, 'inventory', item), 'consumed is still a live reservation');
    const refusal = assertNotReserved(db, 'inventory', item);
    assert.equal(refusal && refusal.code, 'reserved_for_run');
  });
});

describe('reservedPoolUnits — the sealed aggregate the listing side actually asks', () => {
  it('sums live holds across every row sharing a pool_sku, and excludes consumed', async () => {
    const { runId } = mkRun('live');
    const pool = 'POOL-TEST-1';
    const a = mkSealed(10), b = mkSealed(10);
    db.prepare('UPDATE sealed_items SET pool_sku = ? WHERE id IN (?,?)').run(pool, a, b);
    db.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?),(?,?,?)`)
      .run(a, 'Shelf D', 10, b, 'Shelf E', 10);

    assert.equal(reservedPoolUnits(db, pool), 0);
    const ha = holdForRun(db, { kind: 'sealed', itemId: a, runId, qty: 3 });
    const hb = holdForRun(db, { kind: 'sealed', itemId: b, runId, qty: 4 });
    assert.equal(reservedPoolUnits(db, pool), 7, 'both rows count towards the pool');

    db.prepare(`UPDATE run_reservations SET state='committed' WHERE id=?`).run(ha.id);
    await consumeReservation(db, ha.id);
    assert.equal(reservedPoolUnits(db, pool), 4, 'the consumed three came off the placements instead');

    releaseReservation(db, hb.id);
    assert.equal(reservedPoolUnits(db, pool), 0);
  });

  it('a pool nobody has reserved reports zero rather than throwing', () => {
    assert.equal(reservedPoolUnits(db, 'POOL-THAT-DOES-NOT-EXIST'), 0);
  });
});

// --- when the shelf loses an argument with the ledger -------------------------------------------
//
// applyStockDecrements is the ONE disposing path that must not refuse. If a reserved slab genuinely
// sold on eBay, the sale is real, and blocking the decrement would leave the shop believing it owns a
// card someone has paid for. It pays for that exemption by telling the run: the reservation flips to
// `broken`, which is never deleted because it IS the incident record, and lockRun refuses while one
// stands.
//
// This existed as an exported function with a unit test and NO PRODUCTION CALLER for a day. The
// invariant suite now asserts the wiring; these assert the rule.
describe('breakOversoldReservations', () => {
  it('inventory: the object is gone, so the reservation is broken — no judgement needed', () => {
    const { runId, bundleId } = mkRun('live');
    const item = mkInv({ cert_number: 'CERT-SOLD-AWAY' });
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    assignToSlot(db, { reservationId: h.id, bundleId, slot: 'slab' });

    // What a real sale leaves behind: quantity 0, status sold. The decrement has ALREADY happened.
    db.prepare("UPDATE inventory_items SET quantity = 0, status = 'sold' WHERE id = ?").run(item);
    const broken = breakOversoldReservations(db, 'inventory', item, 'sold on order 99-TEST');

    assert.equal(broken.length, 1);
    assert.equal(db.prepare('SELECT state FROM run_reservations WHERE id=?').get(h.id).state, 'broken');
    const row = db.prepare("SELECT action, note FROM run_audit WHERE entity_id=? AND action='reservation_broken'").get(h.id);
    assert.ok(row, 'a broken reservation with no audit row is not an incident record');
    assert.match(row.note, /99-TEST/);
  });

  it('inventory: a PARTIAL sale that left the object on the shelf breaks nothing', () => {
    const { runId } = mkRun('live');
    const item = mkInv();
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    assert.deepEqual(breakOversoldReservations(db, 'inventory', item, 'someone else sold'), []);
    assert.equal(db.prepare('SELECT state FROM run_reservations WHERE id=?').get(h.id).state, 'active');
  });

  // The sealed rule, and the reason it needs one: a single sealed row legitimately backs both a run
  // and the shop, so a sale off it is USUALLY fine. Only an oversell is an incident.
  it('sealed: a sale the pool can still cover breaks nothing', () => {
    const { runId } = mkRun('live');
    const item = mkSealed(10);
    const h = holdForRun(db, { kind: 'sealed', itemId: item, runId, qty: 4 });
    db.prepare('UPDATE sealed_items SET quantity = 6 WHERE id = ?').run(item);   // four sold to the shop
    assert.deepEqual(breakOversoldReservations(db, 'sealed', item, 'shop sale'), []);
    assert.equal(db.prepare('SELECT state FROM run_reservations WHERE id=?').get(h.id).state, 'active');
  });

  it('sealed: an OVERSELL breaks the fewest holds that restore the invariant, newest first', () => {
    const { runId } = mkRun('live');
    const item = mkSealed(10);
    const older = holdForRun(db, { kind: 'sealed', itemId: item, qty: 3 });          // held for runs at large
    const newer = holdForRun(db, { kind: 'sealed', itemId: item, runId, qty: 3 });   // held for this run
    assert.equal(reservedUnits(db, 'sealed', item), 6);

    // Eight sold. Two left on the shelf against six promised — four short.
    db.prepare('UPDATE sealed_items SET quantity = 2 WHERE id = ?').run(item);
    const broken = breakOversoldReservations(db, 'sealed', item, 'sold on order 99-TEST');

    // Breaking the newest 3 leaves 3 promised against 2 on hand — still short — so the older one goes
    // too. Both, but in that order, and the note carries how far short it was.
    assert.equal(broken.length, 2);
    assert.deepEqual(broken.map((b) => b.id), [newer.id, older.id],
      'the most recently placed hold is the one least likely to be packed already');
    const note = db.prepare("SELECT note FROM run_audit WHERE entity_id=? AND action='reservation_broken'").get(newer.id).note;
    assert.match(note, /4 unit\(s\) short/);
  });

  it('sealed: stops as soon as the shelf covers what is left, rather than breaking everything', () => {
    const { runId } = mkRun('live');
    const item = mkSealed(10);
    const older = holdForRun(db, { kind: 'sealed', itemId: item, qty: 2 });
    const newer = holdForRun(db, { kind: 'sealed', itemId: item, runId, qty: 3 });
    db.prepare('UPDATE sealed_items SET quantity = 2 WHERE id = ?').run(item);   // 5 promised, 2 on hand

    const broken = breakOversoldReservations(db, 'sealed', item, 'shop oversold');
    assert.deepEqual(broken.map((b) => b.id), [newer.id], 'breaking the newest 3 already restores it');
    assert.equal(db.prepare('SELECT state FROM run_reservations WHERE id=?').get(older.id).state, 'active');
  });
});

// blockIfHeld is the DESTRUCTIVE guard, and it differs from assertNotReserved in exactly one way that
// matters: it refuses for sealed too. Shrinking the sellable quantity answers 'may I list this pool';
// it is no answer at all to 'may I delete the row the run draws its boosters from'.
describe('blockIfHeld — the guard for deleting rather than listing', () => {
  it('refuses a held SEALED row, where assertNotReserved deliberately does not', () => {
    const { runId } = mkRun('live');
    const item = mkSealed(10);
    holdForRun(db, { kind: 'sealed', itemId: item, runId, qty: 3 });

    assert.equal(assertNotReserved(db, 'sealed', item), null, 'listing a shared pool is still fine');
    const blocked = blockIfHeld(db, { kind: 'sealed', itemId: item, action: 'delete' });
    assert.equal(blocked.code, 'reserved_for_run');
    assert.equal(blocked.units_held, 3);
    assert.match(blocked.error, /3 unit\(s\)/);
  });

  it('lets a free row through', () => {
    assert.equal(blockIfHeld(db, { kind: 'sealed', itemId: mkSealed(5), action: 'delete' }), null);
    assert.equal(blockIfHeld(db, { kind: 'inventory', itemId: mkInv(), action: 'delete' }), null);
  });

  it('force PROCEEDS and leaves a record — an override with no trail is just a hole', () => {
    const { runId } = mkRun('live');
    const item = mkInv({ cert_number: 'CERT-FORCED' });
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    assert.ok(blockIfHeld(db, { kind: 'inventory', itemId: item, action: 'delete item' }));
    assert.equal(blockIfHeld(db, { kind: 'inventory', itemId: item, force: true, action: 'delete item' }), null);

    const row = db.prepare("SELECT note FROM run_audit WHERE entity_id=? AND action='reservation_override'").get(item);
    assert.ok(row, 'a forced override must be recorded against the item');
    assert.match(row.note, /delete item forced/);
    // And it does NOT release the hold: forcing past a guard is not the same as changing your mind.
    assert.equal(db.prepare('SELECT state FROM run_reservations WHERE id=?').get(h.id).state, 'active');
  });
});
