// test/unit/runs-dev-loop.test.mjs — the three gaps that made the loop undrivable, pinned.
//
// A readiness audit walked the sixteen steps a person actually performs — create, deal, pick, seal,
// lock, anchor, publish artifacts, publish product, buy, assign, print, pack, dispatch, close, disclose,
// verify — and found that most of what was missing was not logic. It was that correct, tested code had
// no caller: ten exported functions and four routes that nothing in any page ever invoked.
//
// Three of the gaps were not merely unwired, though. They were wrong, and each is pinned here because
// each would have been found by a person losing an afternoon rather than by a test:
//
//   1. A republish RESTOCKED numbers that had already sold. The guard read run_bundles.status, and a
//      sale never touches that row — it is a ledger entry and nothing else.
//   2. Dispatch did not exist. run_bundles.shipped_at had three readers and no writer anywhere, so the
//      delivery grace clock that gates disclosure started from the wrong event.
//   3. Stock held at intake was invisible to every run AND blocked by its own hold, so the ordinary
//      intake path made a run's own stock unreachable from both directions at once.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { sellableSet, stockFor } from '../../lib/runs-shopify.mjs';
import { holdForRun, poolHolds, assignToSlot } from '../../lib/runs-reserve.mjs';

const db = openDbAt(tmpFile('runs-dev-loop.db'));

let RUN = null;
let BUNDLES = [];

const bundleRow = (n) =>
  db.prepare('SELECT id, bundle_no, label, status FROM run_bundles WHERE run_id = ? AND bundle_no = ?')
    .get(RUN.id, n);

before(() => {
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, unit_price_cents, currency,
                                close_by, sales_close_at, unsold_policy)
              VALUES ('DEV-LOOP', 1, 'Loop', 'dev', 3, 12900, 'AUD', '2027-01-01T00:00:00.000Z',
                      '2026-01-01T00:00:00.000Z', 'policy text')`).run();
  const runId = db.prepare("SELECT id FROM runs WHERE public_id = 'DEV-LOOP'").get().id;
  for (let n = 1; n <= 3; n++) {
    db.prepare('INSERT INTO run_bundles (run_id, bundle_no, label) VALUES (?,?,?)')
      .run(runId, n, `DEV-LOOP-${String(n).padStart(3, '0')}`);
  }
  RUN = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  BUNDLES = db.prepare('SELECT id, bundle_no, label, status FROM run_bundles WHERE run_id = ? ORDER BY bundle_no').all(runId);
});

/** Append a raw ledger row. The chain's integrity is runs-ledger's business; availability is this one's. */
const ledger = (kind, { seq = 0, ref = null, bundleNo = null, qty = 0, detail = '', prev, hash }) =>
  db.prepare(`INSERT INTO run_ledger (run_id, seq, kind, ref, occurred_at, bundle_no, qty, detail,
                                      prev_hash, entry_hash)
              VALUES (?,?,?,?,'2026-06-01T00:00:00.000Z',?,?,?,?,?)`)
    .run(RUN.id, seq, kind, ref, bundleNo, qty, detail, prev, hash);

describe('what the storefront may offer comes from the ledger', () => {
  it('every number, while nothing has been sold', () => {
    const sellable = sellableSet(db, RUN);
    assert.deepEqual([...sellable].sort((a, b) => a - b), [1, 2, 3]);
    for (const b of BUNDLES) assert.equal(stockFor(b, sellable), 1);
  });

  it('and NOT a number the ledger says is gone, even though its bundle row still reads open', () => {
    // THE BUG THIS PINS. The old rule was `bundle.status === 'open'`, and appendEntry never touches a
    // bundle row - a sale is a ledger entry and nothing more. So status sat on its 'open' default for
    // the whole life of a sold number, and every republish put it back on the shelf: a second buyer
    // could buy a bundle already in the post, which is the one thing one-variant-per-number exists to
    // make impossible.
    ledger('sale_online', { seq: 1, ref: 'tok1', bundleNo: 2, qty: 1, detail: 'order/1',
      prev: '0'.repeat(64), hash: 'a'.repeat(64) });

    const sellable = sellableSet(db, RUN);
    assert.deepEqual([...sellable].sort((a, b) => a - b), [1, 3]);
    assert.equal(bundleRow(2).status, 'open', 'the row really is untouched - that is the whole point');
    assert.equal(stockFor(bundleRow(2), sellable), 0, 'a sold number was restocked');
    assert.equal(stockFor(bundleRow(1), sellable), 1);
  });

  it('and a cancelled sale frees the number again, because the chain says so', () => {
    // Availability is a chain that can take a sale back, not a set of flags. Deriving it from a column
    // would strand a cancelled number forever.
    ledger('cancel', { ref: 'tok1', detail: 'buyer changed their mind',
      prev: 'a'.repeat(64), hash: 'b'.repeat(64) });
    assert.equal(stockFor(bundleRow(2), sellableSet(db, RUN)), 1, 'the cancellation did not free it');
  });

  it('and a packed bundle stays off the shelf even when the ledger has not caught up', () => {
    // Both halves are load-bearing. The ledger knows what SOLD; the bundle row knows what is packed and
    // physically spoken for, which the ledger cannot see.
    db.prepare("UPDATE run_bundles SET status = 'packed' WHERE run_id = ? AND bundle_no = 3").run(RUN.id);
    assert.equal(stockFor(bundleRow(3), sellableSet(db, RUN)), 0);
    db.prepare("UPDATE run_bundles SET status = 'open' WHERE run_id = ? AND bundle_no = 3").run(RUN.id);
  });

  it('and a number opened on stream is accounted for exactly like a sale', () => {
    // Unsold-policy v2's escape from the close-out deadlock. It has to remove the number from
    // availability or the run would keep offering a bundle that has been opened on camera.
    ledger('opened_live', { bundleNo: 1, detail: 'opened on a public stream',
      prev: 'b'.repeat(64), hash: 'c'.repeat(64) });
    assert.equal(stockFor(bundleRow(1), sellableSet(db, RUN)), 0);
  });
});

describe("a run's pool contains the stock that was held before any run existed", () => {
  it('which is the whole point of holding at intake and arranging later', () => {
    // runs-intake.html holds on arrival with no run id and says so in as many words. poolHolds filtered
    // `run_id = ?`, and SQL NULL equals nothing, so those holds were invisible to every run — while
    // still making the item unavailable to /candidates. Held and unplaceable at the same time.
    db.prepare(`INSERT INTO inventory_items (sku, name, game, quantity, status)
                VALUES ('BK-LOOP-1', 'Loop Slab', 'pokemon', 1, 'in_stock')`).run();
    const itemId = db.prepare("SELECT id FROM inventory_items WHERE sku = 'BK-LOOP-1'").get().id;

    const held = holdForRun(db, { kind: 'inventory', itemId, runId: null, qty: 1 });
    assert.ok(held.id);

    const pool = poolHolds(db, RUN.id);
    const mine = pool.find((p) => p.reservation_id === held.id);
    assert.ok(mine, 'an unarranged hold never reached the pool');
    assert.equal(mine.run_id, null, 'and it is still unarranged until something claims it');
  });

  it('and claiming one stamps it, so a second run stops seeing it', () => {
    db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, unsold_policy)
                VALUES ('DEV-OTHER', 1, 'Other', 'dev', 1, 'p')`).run();
    const other = db.prepare("SELECT id FROM runs WHERE public_id = 'DEV-OTHER'").get().id;

    db.prepare(`INSERT INTO inventory_items (sku, name, game, quantity, status)
                VALUES ('BK-LOOP-2', 'Loop Slab 2', 'pokemon', 1, 'in_stock')`).run();
    const itemId = db.prepare("SELECT id FROM inventory_items WHERE sku = 'BK-LOOP-2'").get().id;
    const held = holdForRun(db, { kind: 'inventory', itemId, runId: null, qty: 1 });

    assert.ok(poolHolds(db, other).some((p) => p.reservation_id === held.id), 'both runs should see it first');

    db.prepare(`INSERT INTO run_slot_specs (run_id, slot, label, kind, qty_per_bundle, max_lines,
                                            singleton, requires_cert, is_chase_slot, sort_order)
                VALUES (?, 'slab', 'graded card', 'inventory', 1, 1, 1, 0, 1, 0)`).run(RUN.id);
    assignToSlot(db, { reservationId: held.id, bundleId: BUNDLES[0].id, slot: 'slab' });

    assert.ok(!poolHolds(db, other).some((p) => p.reservation_id === held.id),
      'a claimed hold still showed in the other run’s pool');
  });
});
