// test/unit/purchasing-gate.test.mjs — the reconciliation gate and the status vocabulary.
//
// The gate is the whole point of "validate the stock against this system": every reason it can refuse
// is a way a delivery could otherwise walk into inventory without anyone having counted it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileGate, STATUSES, TRANSITIONS, DISCREPANCY_CODES, LINE_KINDS } from '../../lib/purchasing.mjs';

const line = (o) => ({
  id: 1, name: 'A box', line_kind: 'unit', target: 'sealed',
  qty_ordered: 6, qty_received: 6, discrepancy: null, placements: [], ...o,
});
const reasons = (lines) => reconcileGate(lines).blocking.map((b) => b.reason);

describe('reconcileGate', () => {
  it('passes a line counted exactly as ordered', () => {
    assert.equal(reconcileGate([line()]).ok, true);
  });

  it('blocks an uncounted line — nothing enters stock unweighed', () => {
    assert.deepEqual(reasons([line({ qty_received: null })]), ['uncounted']);
  });

  it('blocks a mismatch with no reason, and reports both numbers', () => {
    const g = reconcileGate([line({ qty_received: 4 })]);
    assert.equal(g.ok, false);
    assert.equal(g.blocking[0].reason, 'discrepancy_reason_required');
    assert.equal(g.blocking[0].ordered, 6);
    assert.equal(g.blocking[0].counted, 4);
  });

  it('accepts a mismatch once it is explained', () => {
    assert.equal(reconcileGate([line({ qty_received: 4, discrepancy: 'short' })]).ok, true);
  });

  it('accepts an over-shipment, which is still a mismatch worth naming', () => {
    assert.equal(reconcileGate([line({ qty_received: 7, discrepancy: 'over' })]).ok, true);
  });

  it('blocks a split that does not add up — a half-entered split is how stock goes missing', () => {
    const g = reconcileGate([line({ placements: [{ location: 'SHELF-A', quantity: 4 }] })]);
    assert.equal(g.blocking[0].reason, 'placements_mismatch');
    assert.equal(g.blocking[0].placed, 4);
    assert.equal(g.blocking[0].counted, 6);
  });

  it('allows no placements at all — that means "wherever the order says"', () => {
    assert.equal(reconcileGate([line({ placements: [] })]).ok, true);
  });

  it('accepts a split across several spots when it sums to the count', () => {
    assert.equal(reconcileGate([line({
      placements: [{ location: 'SHELF-A', quantity: 4 }, { location: 'TUB-3', quantity: 2 }],
    })]).ok, true);
  });

  it('refuses to split a singles line, because inventory_items has a scalar location', () => {
    const g = reconcileGate([line({
      target: 'inventory',
      placements: [{ location: 'BOX-1', quantity: 3 }, { location: 'BOX-2', quantity: 3 }],
    })]);
    assert.equal(g.blocking[0].reason, 'split_not_supported');
  });

  it('blocks a lot until it says how many items came out', () => {
    assert.deepEqual(reasons([line({ line_kind: 'lot', qty_ordered: 1, qty_received: 1 })]), ['lot_units_required']);
    assert.equal(reconcileGate([line({ line_kind: 'lot', qty_ordered: 1, qty_received: 1, lot_units: 7 })]).ok, true);
  });

  it('does not ask a not-shipped line where to put nothing', () => {
    assert.equal(reconcileGate([line({ qty_received: 0, discrepancy: 'not_shipped' })]).ok, true);
  });

  it('reports every unready line, not just the first', () => {
    const g = reconcileGate([
      line({ id: 1, qty_received: null }),
      line({ id: 2, qty_received: 3 }),
      line({ id: 3 }),
    ]);
    assert.equal(g.blocking.length, 2, 'the operator should see all the work left, not one item at a time');
    assert.deepEqual(g.blocking.map((b) => b.line_id), [1, 2]);
  });
});

describe('the status vocabulary', () => {
  it('every transition target is a real status', () => {
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      assert.ok(STATUSES.includes(from), `${from} is not a status`);
      for (const to of tos) assert.ok(STATUSES.includes(to), `${from} -> ${to} is not a status`);
    }
  });

  it('every status has a transition entry, so nothing is a dead end by omission', () => {
    for (const s of STATUSES) assert.ok(Array.isArray(TRANSITIONS[s]), `${s} has no entry`);
  });

  it('NOTHING transitions into received — only a committed receive can claim stock exists', () => {
    for (const tos of Object.values(TRANSITIONS)) assert.ok(!tos.includes('received'));
  });

  it('closed is terminal', () => {
    assert.deepEqual(TRANSITIONS.closed, []);
  });

  it('a cancelled order can be reopened, because cancelling is sometimes a mistake', () => {
    assert.ok(TRANSITIONS.cancelled.includes('draft'));
  });

  it('the discrepancy codes say whether goods actually arrived', () => {
    assert.equal(DISCREPANCY_CODES.find((c) => c.code === 'not_shipped').affects_stock, false);
    assert.equal(DISCREPANCY_CODES.find((c) => c.code === 'over').affects_stock, true);
    assert.ok(DISCREPANCY_CODES.every((c) => c.code && c.label));
  });

  it('the line kinds are the three shapes an order line can take', () => {
    assert.deepEqual([...LINE_KINDS].sort(), ['grading', 'lot', 'unit']);
  });
});
