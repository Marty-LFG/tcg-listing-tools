// test/unit/keepers-reconcile.test.mjs — the correctness guarantee.
//
// The window guard gets the most attention here, because its failure mode is the worst kind: a sweep
// that reports a clean run while reconciling nothing at all, indefinitely, with a green light on
// /api/status the whole time.
//
// sweepOrders' network path is not covered here — it is exercised in the soak, against real
// deliveries, which is the only place its cursor-hold behaviour means anything. What IS covered is
// every decision it makes that does not need Shopify.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  windowFloorProblem, defaultCursor, driftReport,
  ORDER_WINDOW_DAYS, WINDOW_MARGIN_DAYS, CURSOR_KEY, cursorDecision,
} from '../../lib/keepers-reconcile.mjs';
import { openKeepersDbAt, appendEvent, upsertCustomer, getMeta, setMeta } from '../../lib/keepers-db.mjs';

const NOW = Date.parse('2026-09-06T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

describe('windowFloorProblem — the trap that reports green for a year', () => {
  it('is silent for a cursor comfortably inside the window', () => {
    assert.equal(windowFloorProblem(daysAgo(1), { nowMs: NOW }), null);
    assert.equal(windowFloorProblem(daysAgo(30), { nowMs: NOW }), null);
  });

  it('is silent when there is no cursor yet — the first run picks its own start', () => {
    assert.equal(windowFloorProblem(null, { nowMs: NOW }), null);
    assert.equal(windowFloorProblem('', { nowMs: NOW }), null);
  });

  it('WARNS as the cursor nears the edge, before it crosses', () => {
    // A run that starts inside the window and pages slowly can cross it mid-sweep, so the warning
    // has to come early enough to act on.
    const near = windowFloorProblem(daysAgo(ORDER_WINDOW_DAYS - 2), { nowMs: NOW });
    assert.ok(near, 'expected a warning near the edge');
    assert.match(near, /within \d+ days/);
    assert.doesNotMatch(near, /past the/, 'a warning is not a refusal');
  });

  it('REFUSES once the cursor is past the window', () => {
    const past = windowFloorProblem(daysAgo(ORDER_WINDOW_DAYS + 1), { nowMs: NOW });
    assert.match(past, /past the 60-day read_orders window/);
    // The explanation matters as much as the refusal: the next person needs to know that an empty
    // page here is not the same as nothing having changed.
    assert.match(past, /EMPTY page rather than an error/);
    assert.match(past, /read_all_orders/);
  });

  it('rejects a cursor that is not a date rather than treating it as fresh', () => {
    assert.match(windowFloorProblem('yesterday', { nowMs: NOW }), /not a date/);
  });

  it('honours a caller-supplied window, for a store that later gains read_all_orders', () => {
    assert.equal(windowFloorProblem(daysAgo(90), { nowMs: NOW, windowDays: 365, marginDays: 5 }), null);
  });
});

describe('defaultCursor', () => {
  it('starts inside the window with room to spare', () => {
    const c = defaultCursor({ nowMs: NOW });
    assert.equal(windowFloorProblem(c, { nowMs: NOW }), null, 'the default start must not itself warn');
    const ageDays = (NOW - Date.parse(c)) / 86400000;
    assert.ok(ageDays < ORDER_WINDOW_DAYS - WINDOW_MARGIN_DAYS, `default cursor is ${ageDays} days back`);
    assert.ok(ageDays > 0);
  });
});

describe('driftReport', () => {
  const GID = 'gid://shopify/Customer/8675309';
  const ORDER = 'gid://shopify/Order/5001';
  let db;

  const seedOrder = (gid, accrues = 1) => db.prepare(`
    INSERT INTO keepers_orders (order_gid, order_number, customer_gid, channel, accrues)
    VALUES (?,?,?,?,?)
  `).run(gid, '#BK-1', GID, 'Online Store', accrues);

  const seedAccrual = (ref) => appendEvent(db, {
    customerGid: GID, kind: 'order_accrual', xpDelta: 74, pointsDelta: 148,
    source: 'shopify_order', sourceRef: ref, basisCents: 7400,
    rateXpPerDollar: 1, ratePointsPerDollar: 2,
  });

  beforeEach(() => {
    db = openKeepersDbAt(':memory:');
    upsertCustomer(db, { customerGid: GID });
  });

  it('reports clean when every accruing order has its accrual', () => {
    seedOrder(ORDER);
    seedAccrual(ORDER);
    const r = driftReport(db);
    assert.equal(r.clean, true);
    assert.deepEqual(r.counts, { missing: 0, extra: 0, unlinked: 0 });
  });

  it('finds an accruing order with no accrual — the repairable kind', () => {
    // This is a lost webhook. The sweep re-ingests, and the unique index makes that safe even if the
    // webhook lands in the same millisecond.
    seedOrder(ORDER);
    const r = driftReport(db);
    assert.equal(r.counts.missing, 1);
    assert.equal(r.missing[0].order_gid, ORDER);
    assert.equal(r.clean, false);
  });

  it('finds an accrual with no accruing order — and never deletes it', () => {
    // A ledger that silently removes rows is not a ledger. This gets flagged for a human.
    seedAccrual('gid://shopify/Order/ghost');
    const r = driftReport(db);
    assert.equal(r.counts.extra, 1);
    assert.equal(r.extra[0].source_ref, 'gid://shopify/Order/ghost');
    // Prove it is still there after reporting.
    const still = db.prepare('SELECT COUNT(*) n FROM keepers_events WHERE source_ref = ?').get('gid://shopify/Order/ghost');
    assert.equal(still.n, 1);
  });

  it('treats an order that does not accrue as correctly having no accrual', () => {
    // An eBay-channel order is SUPPOSED to have no events. It must not read as drift, or the report
    // becomes noise nobody reads.
    seedOrder('gid://shopify/Order/ebay-1', 0);
    assert.equal(driftReport(db).clean, true);
  });

  it('counts unlinked events so they are visible rather than quietly uncounted', () => {
    appendEvent(db, {
      customerGid: null, kind: 'order_accrual', xpDelta: 10, pointsDelta: 20,
      source: 'shopify_order', sourceRef: 'gid://shopify/Order/guest', basisCents: 1000,
    });
    const r = driftReport(db);
    assert.equal(r.counts.unlinked, 1);
  });

  it('does not count a void or held event as a missing accrual', () => {
    // Only applied accruals count towards the balance, but an accrual ROW existing is what makes the
    // order reconciled — a held one is still recorded.
    seedOrder(ORDER);
    appendEvent(db, {
      customerGid: GID, kind: 'order_accrual', xpDelta: 74, pointsDelta: 148,
      source: 'shopify_order', sourceRef: ORDER, basisCents: 7400, status: 'held',
      holdUntil: '2099-01-01T00:00:00Z',
    });
    assert.equal(driftReport(db).counts.missing, 0);
  });
});

describe('the cursor lives in meta, so a restart resumes rather than restarts', () => {
  it('round-trips', () => {
    const db = openKeepersDbAt(':memory:');
    assert.equal(getMeta(db, CURSOR_KEY), null);
    setMeta(db, CURSOR_KEY, '2026-09-01T00:00:00Z');
    assert.equal(getMeta(db, CURSOR_KEY), '2026-09-01T00:00:00Z');
  });
});

describe('the cursor never moves on a run that wrote nothing', () => {
  // sweepOrders reaches Shopify, so nothing in this suite has ever driven it — which is precisely how
  // the condition stayed `clean && apply` with no mention of the mode for as long as it did. Under
  // observe, ingestOrder returns before writing even the keepers_orders row, yet the timer calls the
  // sweep with apply defaulting to true. Every run advanced the cursor past orders it had chosen not
  // to record, so flipping the mode to 'apply' would silently skip the entire soak window — and
  // driftReport could not report it, because its `missing` query joins from the table observe never
  // wrote. The rule is pure and has three inputs; it is worth enumerating.

  it('observe holds the cursor even on a perfectly clean run', () => {
    const d = cursorDecision({ clean: true, apply: true, observeOnly: true });
    assert.equal(d.advance, false, 'this is the bug: a clean observe run used to advance');
    assert.equal(d.holdReason, 'observe', 'and it must say so, or a held cursor reads as a fault');
  });

  it('a dry run holds it too, and is distinguishable from observe', () => {
    assert.deepEqual(cursorDecision({ clean: true, apply: false, observeOnly: false }),
      { advance: false, holdReason: 'dry_run' });
  });

  it('observe beats dry_run in the explanation — the mode is the reason, not the flag', () => {
    assert.equal(cursorDecision({ clean: true, apply: false, observeOnly: true }).holdReason, 'observe');
  });

  it('only a clean applying run that is not observing may advance', () => {
    assert.deepEqual(cursorDecision({ clean: true, apply: true, observeOnly: false }),
      { advance: true, holdReason: null });
  });

  it('a real fault outranks the mode in the explanation', () => {
    assert.equal(cursorDecision({ clean: false, apply: true, observeOnly: true, failed: true }).holdReason, 'query_failed');
    assert.equal(cursorDecision({ clean: false, apply: true, observeOnly: false, truncated: true }).holdReason, 'truncated');
    assert.equal(cursorDecision({ clean: false, apply: true, observeOnly: false, problems: 3 }).holdReason, 'order_errors');
  });

  it('nothing unclean ever advances, whatever the flags say', () => {
    for (const apply of [true, false]) {
      for (const observeOnly of [true, false]) {
        assert.equal(cursorDecision({ clean: false, apply, observeOnly }).advance, false);
      }
    }
  });
});

describe('and sweepOrders actually USES that decision', () => {
  // The assertions above drive the pure function. Every one of them passed with the call site
  // restored to its pre-fix `clean && apply` — I checked — so on their own they prove the rule is
  // right and nothing whatsoever about the rule being applied. sweepOrders reaches Shopify, so no
  // unit test can drive it; a source assertion is the honest substitute, and it catches precisely the
  // regression the pure tests cannot see.
  const src = fs.readFileSync(new URL('../../lib/keepers-reconcile.mjs', import.meta.url), 'utf8');

  it('the only cursor write in the file is guarded by the decision', () => {
    const writes = src.split(/\r?\n/).filter((l) => l.includes('setMeta(db, CURSOR_KEY'));
    assert.equal(writes.length, 1, 'expected exactly one cursor write, found:\n' + writes.join('\n'));
    assert.ok(writes[0].includes('decision.advance'),
      'the cursor must move only when cursorDecision says so — a second condition here is how the mode came to be ignored');
  });

  it('the pre-fix condition is gone, not merely bypassed', () => {
    assert.ok(!src.includes('if (clean && apply && maxUpdatedAt > cursor)'),
      'the old `clean && apply` guard is back, and it advances the cursor in observe mode');
  });

  it('releasing held events is gated on the mode too, not just on apply', () => {
    // Same class of bug: releaseHeldEvents MUTATES the ledger, so `apply` alone let a store switched
    // back to observe keep promoting held referral awards while claiming to append nothing.
    assert.ok(src.includes('const released = (apply && !observeOnly) ? releaseHeldEvents('),
      'releaseHeldEvents must be gated on the mode as well as the flag');
  });
});
