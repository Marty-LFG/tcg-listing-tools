// test/unit/keepers-db.test.mjs — the Keepers ledger.
//
// In-memory, so nothing here can reach data/keepers.db.
//
// The tests that matter most are the ones covering behaviour a caller would otherwise have to get
// right by hand every time: idempotency (enforced by the schema, not by a check-then-insert), the
// reversal clamp (which is the only thing standing between a twice-refunded order and a customer
// losing more than they earned), and the deliberate asymmetries — badges never revoked, held events
// not counted, redacted customers losing their events' ownership but not the events.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  openKeepersDbAt, appendEvent, ledgerTotals, ledgerBadges, orderLedger, clampReversal,
  releaseHeldEvents, linkUnlinkedEvents, unlinkedCount, forgetCustomer, upsertCustomer,
  getCustomer, markDirty, getMeta, setMeta, withTransaction, gidToNumeric, numericToGid,
  KINDS, SOURCES,
} from '../../lib/keepers-db.mjs';

const GID = 'gid://shopify/Customer/8675309';
const OTHER = 'gid://shopify/Customer/1111111';
const ORDER = 'gid://shopify/Order/5001';

let db;
beforeEach(() => {
  db = openKeepersDbAt(':memory:');
  upsertCustomer(db, { customerGid: GID, joinedAt: '2026-09-01T00:00:00Z' });
});

const accrue = (over = {}) => appendEvent(db, {
  customerGid: GID, kind: 'order_accrual', xpDelta: 74, pointsDelta: 148,
  source: 'shopify_order', sourceRef: ORDER, basisCents: 7400,
  rateXpPerDollar: 1, ratePointsPerDollar: 2, occurredAt: '2026-09-02T00:00:00Z', ...over,
});

describe('appendEvent — the only door into the ledger', () => {
  it('records an accrual and marks the customer dirty for the projection', () => {
    const r = accrue();
    assert.equal(r.inserted, true);
    assert.ok(r.id > 0);
    assert.equal(getCustomer(db, GID).dirty, 1);
    assert.deepEqual(ledgerTotals(db, GID), { xp: 74, points: 148, events: 1 });
  });

  it('refuses an unknown kind or source rather than filing it somewhere odd', () => {
    assert.throws(() => accrue({ kind: 'order_acrual' }), /unknown kind/);
    assert.throws(() => accrue({ source: 'shopfiy_order' }), /unknown source/);
  });

  it('refuses fractional XP, which would round differently every time it was summed', () => {
    assert.throws(() => accrue({ xpDelta: 7.4 }), /whole numbers/);
    assert.throws(() => accrue({ pointsDelta: 0.5 }), /whole numbers/);
  });

  it('serializes an evidence object, and passes a string through untouched', () => {
    accrue({ evidence: { preorder: true, languages: ['Japanese'] } });
    const row = db.prepare('SELECT evidence FROM keepers_events WHERE source_ref = ?').get(ORDER);
    assert.deepEqual(JSON.parse(row.evidence), { preorder: true, languages: ['Japanese'] });
  });
});

describe('idempotency is in the schema, not the caller', () => {
  it('refuses a second event for the same (source, source_ref, kind)', () => {
    // The webhook and the reconcile sweep can find the same order milliseconds apart. This is the
    // NORMAL case, not an error — a caller treating it as failure burns its retry budget redoing work.
    assert.equal(accrue().inserted, true);
    assert.equal(accrue().inserted, false);
    assert.deepEqual(ledgerTotals(db, GID), { xp: 74, points: 148, events: 1 });
  });

  it('allows a referrer and a referee award to share one source_ref, because kind differs', () => {
    const ref = 'gid://shopify/Order/6001';
    assert.equal(appendEvent(db, { customerGid: GID, kind: 'referral_referrer', xpDelta: 200, pointsDelta: 500, source: 'referral', sourceRef: ref }).inserted, true);
    assert.equal(appendEvent(db, { customerGid: OTHER, kind: 'referral_referee', xpDelta: 0, pointsDelta: 0, source: 'referral', sourceRef: ref }).inserted, true);
  });

  it('does not dedupe derived events, which have no upstream key', () => {
    // source='derive' is excluded from the unique index because badges and levels are computed from
    // the ledger rather than delivered by anything.
    const one = appendEvent(db, { customerGid: GID, kind: 'correction', xpDelta: 1, source: 'derive', sourceRef: 'x' });
    const two = appendEvent(db, { customerGid: GID, kind: 'correction', xpDelta: 1, source: 'derive', sourceRef: 'x' });
    assert.equal(one.inserted, true);
    assert.equal(two.inserted, true);
  });

  it('awards a badge once per customer, and lets a different customer earn the same one', () => {
    const award = (gid) => appendEvent(db, { customerGid: gid, kind: 'badge_award', badgeId: 'first-pull', source: 'derive' });
    assert.equal(award(GID).inserted, true);
    assert.equal(award(GID).inserted, false);
    upsertCustomer(db, { customerGid: OTHER });
    assert.equal(award(OTHER).inserted, true);
    assert.deepEqual(ledgerBadges(db, GID), ['first-pull']);
  });

  it('lets two UNLINKED badge events coexist — the reason that index is separate', () => {
    // SQLite treats NULLs as distinct, so a (customer_gid, badge_id) unique index would silently
    // permit duplicate unlinked rows. The index therefore excludes NULL owners explicitly.
    const a = appendEvent(db, { customerGid: null, kind: 'badge_award', badgeId: 'first-pull', source: 'derive' });
    const b = appendEvent(db, { customerGid: null, kind: 'badge_award', badgeId: 'first-pull', source: 'derive' });
    assert.equal(a.inserted, true);
    assert.equal(b.inserted, true);
  });
});

describe('ledgerTotals — only what has actually been earned', () => {
  it('excludes held and void events', () => {
    accrue();
    appendEvent(db, { customerGid: GID, kind: 'referral_referrer', xpDelta: 200, pointsDelta: 500, source: 'referral', sourceRef: 'r1', status: 'held', holdUntil: '2099-01-01T00:00:00Z' });
    appendEvent(db, { customerGid: GID, kind: 'manual_grant', xpDelta: 999, source: 'admin', sourceRef: 'v1', status: 'void' });
    assert.deepEqual(ledgerTotals(db, GID), { xp: 74, points: 148, events: 1 });
  });

  it('is allowed to go negative — spend points, then refund the order that earned them', () => {
    accrue();
    appendEvent(db, { customerGid: GID, kind: 'redemption_debit', pointsDelta: -500, source: 'redemption', sourceRef: '1' });
    const { points } = ledgerTotals(db, GID);
    assert.equal(points, -352);
    // The PROJECTION clamps at zero; the ledger tells the truth. Conflating the two would hide a
    // shortfall that future accrual is supposed to pay down.
    assert.equal(Math.max(0, points), 0);
  });
});

describe('the reversal clamp', () => {
  it('reverses a refund at the rate stored on the original accrual', () => {
    accrue();
    const c = clampReversal(db, ORDER, { xp: 74, points: 148 });
    assert.deepEqual([c.xpDelta, c.pointsDelta], [-74, -148]);
    assert.equal(c.ledger.rateXpPerDollar, 1);
  });

  it('CANNOT take back more than was earned, however many times it is asked', () => {
    // The real shape of this: an order refunded in two parts and then cancelled. Three events each
    // want to reverse it, and only this sum stops the customer losing three times what they earned.
    accrue();
    const first = clampReversal(db, ORDER, { xp: 50, points: 100 });
    appendEvent(db, { customerGid: GID, kind: 'order_reversal', xpDelta: first.xpDelta, pointsDelta: first.pointsDelta, source: 'shopify_refund', sourceRef: 'refund-1', reversesEventId: first.reversesEventId });

    const second = clampReversal(db, ORDER, { xp: 50, points: 100 });
    assert.deepEqual([second.xpDelta, second.pointsDelta], [-24, -48], 'only the remainder');
    appendEvent(db, { customerGid: GID, kind: 'order_reversal', xpDelta: second.xpDelta, pointsDelta: second.pointsDelta, source: 'shopify_order_cancel', sourceRef: ORDER, reversesEventId: second.reversesEventId });

    const third = clampReversal(db, ORDER, { xp: 999, points: 999 });
    assert.deepEqual([third.xpDelta, third.pointsDelta], [0, 0], 'nothing left to take');
    assert.deepEqual(ledgerTotals(db, GID), { xp: 0, points: 0, events: 3 });
  });

  it('reports zero for an order that never accrued', () => {
    const c = clampReversal(db, 'gid://shopify/Order/nope', { xp: 10, points: 20 });
    assert.deepEqual([c.xpDelta, c.pointsDelta], [0, 0]);
  });

  it('never returns a positive delta, whatever it is asked for', () => {
    accrue();
    for (const ask of [{ xp: -5, points: -5 }, { xp: 0, points: 0 }, { xp: NaN, points: NaN }]) {
      const c = clampReversal(db, ORDER, ask);
      assert.ok(c.xpDelta <= 0 && c.pointsDelta <= 0, JSON.stringify(ask));
    }
  });
});

describe('held events and the referral hold', () => {
  it('does not count a held award until its hold expires', () => {
    appendEvent(db, {
      customerGid: GID, kind: 'referral_referrer', xpDelta: 200, pointsDelta: 500,
      source: 'referral', sourceRef: 'r1', status: 'held', holdUntil: '2026-09-20T00:00:00Z',
    });
    assert.equal(ledgerTotals(db, GID).xp, 0, 'earned, but not yet countable');

    assert.equal(releaseHeldEvents(db, { now: '2026-09-19T00:00:00Z' }), 0, 'still inside the window');
    assert.equal(releaseHeldEvents(db, { now: '2026-09-21T00:00:00Z' }), 1);
    assert.equal(ledgerTotals(db, GID).xp, 200);
  });

  it('releasing marks the customer dirty so the projection picks it up', () => {
    appendEvent(db, { customerGid: GID, kind: 'referral_referrer', xpDelta: 200, source: 'referral', sourceRef: 'r1', status: 'held', holdUntil: '2026-01-01T00:00:00Z' });
    db.prepare('UPDATE keepers_customers SET dirty = 0').run();
    releaseHeldEvents(db, { now: '2026-09-21T00:00:00Z' });
    assert.equal(getCustomer(db, GID).dirty, 1);
  });

  it('is idempotent — a second release pass finds nothing', () => {
    appendEvent(db, { customerGid: GID, kind: 'referral_referrer', xpDelta: 200, source: 'referral', sourceRef: 'r1', status: 'held', holdUntil: '2026-01-01T00:00:00Z' });
    assert.equal(releaseHeldEvents(db, { now: '2026-09-21T00:00:00Z' }), 1);
    assert.equal(releaseHeldEvents(db, { now: '2026-09-21T00:00:00Z' }), 0);
  });
});

describe('unlinked events', () => {
  it('accepts an event with no owner, and links it later without guessing', () => {
    // A guest order, or one whose customer block came back redacted. It is honest for it to sit
    // ownerless; it is not honest to infer an owner from an email we may not even be allowed to read.
    accrue({ customerGid: null });
    assert.equal(unlinkedCount(db), 1);
    assert.equal(ledgerTotals(db, GID).xp, 0);

    assert.equal(linkUnlinkedEvents(db, ORDER, GID), 1);
    assert.equal(unlinkedCount(db), 0);
    assert.equal(ledgerTotals(db, GID).xp, 74);
    assert.equal(getCustomer(db, GID).dirty, 1);
  });

  it('does nothing when there is no owner or no reference to link', () => {
    accrue({ customerGid: null });
    assert.equal(linkUnlinkedEvents(db, ORDER, ''), 0);
    assert.equal(linkUnlinkedEvents(db, '', GID), 0);
    assert.equal(unlinkedCount(db), 1);
  });

  it('does not steal an event that already has an owner', () => {
    accrue();
    assert.equal(linkUnlinkedEvents(db, ORDER, OTHER), 0);
    assert.equal(ledgerTotals(db, GID).xp, 74);
  });
});

describe('upsertCustomer', () => {
  it('writes joined_at once and never rewrites it', () => {
    // The storefront tests joined_at, not xp, to decide whether someone is a Keeper at all — so moving
    // it would restate their history, and a Keeper refunded back to zero must stay a Keeper.
    upsertCustomer(db, { customerGid: GID, joinedAt: '2027-01-01T00:00:00Z' });
    assert.equal(getCustomer(db, GID).joined_at, '2026-09-01T00:00:00Z');
  });

  it('fills joined_at when the first sight had none', () => {
    upsertCustomer(db, { customerGid: OTHER });
    assert.equal(getCustomer(db, OTHER).joined_at, null);
    upsertCustomer(db, { customerGid: OTHER, joinedAt: '2026-09-05T00:00:00Z' });
    assert.equal(getCustomer(db, OTHER).joined_at, '2026-09-05T00:00:00Z');
  });

  it('derives the numeric id and the shopify: handle', () => {
    const c = getCustomer(db, GID);
    assert.equal(c.numeric_id, 8675309);
    assert.equal(c.handle, 'shopify:8675309');
  });

  it('refuses a customer with no gid', () => {
    assert.throws(() => upsertCustomer(db, {}), /needs a customer_gid/);
  });
});

describe('forgetCustomer — the customers/redact handler', () => {
  it('keeps the events and removes the person', () => {
    // Deleting the events instead would silently change every total the business has ever reported.
    accrue();
    appendEvent(db, { customerGid: GID, kind: 'badge_award', badgeId: 'first-pull', source: 'derive' });
    const out = forgetCustomer(db, GID);
    assert.equal(out.customer, 1);
    assert.equal(out.events, 2);
    assert.equal(getCustomer(db, GID), null);
    assert.equal(unlinkedCount(db), 2, 'the events survive, ownerless');
    assert.equal(ledgerTotals(db, GID).events, 0);
  });
});

describe('meta, transactions and gid helpers', () => {
  it('round-trips meta and overwrites on conflict', () => {
    assert.equal(getMeta(db, 'orders_cursor'), null);
    setMeta(db, 'orders_cursor', '2026-09-01T00:00:00Z');
    setMeta(db, 'orders_cursor', '2026-09-02T00:00:00Z');
    assert.equal(getMeta(db, 'orders_cursor'), '2026-09-02T00:00:00Z');
  });

  it('rolls back the whole transaction when the body throws', () => {
    assert.throws(() => withTransaction(db, () => {
      accrue();
      throw new Error('boom');
    }), /boom/);
    assert.deepEqual(ledgerTotals(db, GID), { xp: 0, points: 0, events: 0 });
  });

  it('converts between gid and numeric id', () => {
    assert.equal(gidToNumeric(GID), 8675309);
    assert.equal(numericToGid(8675309), GID);
    assert.equal(gidToNumeric('nonsense'), null);
  });

  it('exposes a readable vocabulary for every kind and source', () => {
    for (const k of Object.keys(KINDS)) assert.equal(typeof KINDS[k], 'string');
    for (const s of Object.keys(SOURCES)) assert.equal(typeof SOURCES[s], 'string');
  });

  it('markDirty is safe on a customer that does not exist', () => {
    assert.doesNotThrow(() => markDirty(db, 'gid://shopify/Customer/999999'));
    assert.doesNotThrow(() => markDirty(db, null));
  });
});
