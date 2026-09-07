// test/unit/keepers-refund-reversal.test.mjs — a refund must take back what was actually earned.
//
// THE BUG THIS EXISTS TO PREVENT, found by the stage-4 soak against dev order #1010 rather than by
// any test:
//
//   const want = reversalFor(decision, { refundedCents: r.cents });
//
// `decision.basisCents` is Shopify's currentSubtotalPriceSet, which is ALREADY NET OF REFUNDS. A
// fully refunded order therefore arrives with basis 0, reversalFor returns {0,0} on its `basis <= 0`
// guard, clampReversal can only clamp a want DOWNWARD so it cannot rescue a zero, and the loop
// skips. The order was refunded in full and the customer kept every point of XP.
//
// It survived 4992 tests because the unit coverage for reversalFor hands it a decision whose basis is
// the ORIGINAL amount — true of the function in isolation, and never true of the caller. One of those
// tests even asserts `reversalFor({basisCents: 0, ...}) -> {xp: 0, points: 0}`, which is correct for
// the pure function and is exactly the behaviour that made the caller wrong. A guard that cannot see
// its own call site.
//
// So this file tests the SCORING SOURCE, not the arithmetic: given a ledger, is the right amount
// taken back? Plus source assertions on both call sites, because ingestOrder reaches Shopify and no
// unit test can drive it — the same honest substitute used for the reconcile cursor.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { refundReversal, reversalFor } from '../../lib/keepers-ingest.mjs';
import { openKeepersDbAt, appendEvent, upsertCustomer, orderLedger, clampReversal } from '../../lib/keepers-db.mjs';

const GID = 'gid://shopify/Customer/8675309';
const ORDER = 'gid://shopify/Order/5001';

let db;
beforeEach(() => {
  db = openKeepersDbAt(':memory:');
  upsertCustomer(db, { customerGid: GID, joinedAt: '2026-09-01T00:00:00Z' });
});

/** An order that earned `xp`/`points` on a basis of `basisCents`, exactly as ingest would record it. */
const accrue = ({ basisCents, xp, points }) => appendEvent(db, {
  customerGid: GID, kind: 'order_accrual',
  xpDelta: xp, pointsDelta: points,
  source: 'shopify_order', sourceRef: ORDER,
  basisCents, rateXpPerDollar: 1, ratePointsPerDollar: 2,
  occurredAt: '2026-09-01T00:00:00Z',
});

describe('a refund is scored against the accrual, not against what the order is worth now', () => {
  it('a FULL refund takes back everything that was earned', () => {
    // The headline case. $1.98 earned 1 XP / 3 points; refunding all of it must leave zero.
    accrue({ basisCents: 198, xp: 1, points: 3 });
    const want = refundReversal(orderLedger(db, ORDER), { refundedCents: 198 });
    assert.deepEqual(want, { xp: 1, points: 3 },
      'a fully refunded order must reverse its whole accrual — this returning {0,0} is buy-refund-keep-XP');
  });

  it('a PARTIAL refund takes back its share of the ORIGINAL accrual', () => {
    // $7.96 earned 7 XP / 15 points. Refunding $3.98 is half the ORDER, not all of the remainder.
    accrue({ basisCents: 796, xp: 7, points: 15 });
    const want = refundReversal(orderLedger(db, ORDER), { refundedCents: 398 });
    assert.deepEqual(want, { xp: 3, points: 7 },
      'half the order must reverse half the accrual; dividing by the REMAINING basis reverses all of it');
  });

  it('two partial refunds together cannot take back more than was earned', () => {
    accrue({ basisCents: 796, xp: 7, points: 15 });
    const take = (ref, cents) => {
      const c = clampReversal(db, ORDER, refundReversal(orderLedger(db, ORDER), { refundedCents: cents }));
      appendEvent(db, {
        customerGid: GID, kind: 'order_reversal', xpDelta: c.xpDelta, pointsDelta: c.pointsDelta,
        source: 'shopify_refund', sourceRef: ref, reversesEventId: c.reversesEventId,
      });
      return c;
    };
    const first = take('refund-1', 398);
    const second = take('refund-2', 398);
    const l = orderLedger(db, ORDER);
    assert.equal(-(first.xpDelta + second.xpDelta), 6, 'two halves of 7 floor to 3 each');
    assert.ok(l.reversedXp <= l.accruedXp, 'cumulative reversal exceeded the accrual');
    // ONE XP SURVIVES TWO HALF-REFUNDS, and that is the chosen semantics rather than a slip:
    // reversals are proportional to the ORIGINAL accrual (D-005), and floor(7 x 0.5) twice is 6, not
    // 7. Rounding lands in the customer's favour every time, which is the right direction for it to
    // land. A refund of the whole remaining amount in ONE go still clears the lot — see the full case
    // above — so this residue only appears when a refund is split.
    assert.equal(l.reversibleXp, 1);
  });

  it('an over-refund is capped at the accrual, never negative', () => {
    accrue({ basisCents: 198, xp: 1, points: 3 });
    assert.deepEqual(refundReversal(orderLedger(db, ORDER), { refundedCents: 999999 }), { xp: 1, points: 3 });
  });

  it('an order with no accrual on file reverses nothing', () => {
    // Nothing was earned, so there is nothing to take back. Notably NOT the same code path as the
    // bug: this is an absent accrual, not a present one scored against a stale basis.
    assert.deepEqual(refundReversal(orderLedger(db, ORDER), { refundedCents: 500 }), { xp: 0, points: 0 });
  });

  it('the stored basis is what makes this possible', () => {
    // If orderLedger ever stops carrying basisCents, refundReversal silently returns {0,0} for every
    // refund and the headline bug is back with no other test noticing.
    accrue({ basisCents: 796, xp: 7, points: 15 });
    const l = orderLedger(db, ORDER);
    assert.equal(l.basisCents, 796, 'orderLedger must expose the ORIGINAL accrual basis');
    assert.equal(l.accruedXp, 7);
  });
});

describe('and the call sites actually score from the ledger', () => {
  // ingestOrder reaches Shopify, so no unit test can drive it. These are the honest substitute, and
  // they catch precisely the regression the cases above cannot see: correct arithmetic fed the wrong
  // numbers. Both were verified by restoring the pre-fix expressions — each fails then.
  const src = fs.readFileSync(new URL('../../lib/keepers-ingest.mjs', import.meta.url), 'utf8');

  it('the refund loop scores against orderLedger, not against `decision`', () => {
    assert.ok(src.includes('refundReversal(orderLedger(db, String(orderGid)), { refundedCents: r.cents })'),
      'the refund loop must score the reversal from the stored accrual');
    assert.ok(!src.includes('reversalFor(decision, { refundedCents: r.cents })'),
      'the pre-fix call is back: `decision` carries a basis already net of refunds');
  });

  it('the cancellation branch does too', () => {
    assert.ok(src.includes('clampReversal(db, String(orderGid), { xp: l.accruedXp, points: l.accruedPoints })'),
      'a cancellation must reverse what was accrued, not what the live order is now worth');
    assert.ok(!src.includes('clampReversal(db, String(orderGid), { xp: decision.xp, points: decision.points })'),
      'the pre-fix cancellation is back: a refunded-then-cancelled order would reverse nothing');
  });

  it('reversalFor itself is unchanged — the arithmetic was never the bug', () => {
    // Pinned so a future reader does not "fix" the pure function to paper over a caller that is
    // already correct. Given the original basis it has always been right.
    assert.deepEqual(reversalFor({ basisCents: 7400, xp: 74, points: 148 }, { refundedCents: 3700 }),
      { xp: 37, points: 74 });
  });
});
