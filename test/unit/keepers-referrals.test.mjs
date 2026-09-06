// test/unit/keepers-referrals.test.mjs — refer a friend, and the guards.
//
// This is the largest award in the economy (200 XP + 500 points, against 25 for a review), so it is
// the only earn action worth someone's while to attack. And the controls a normal loyalty programme
// would use — same card, same address, same device — are all unavailable here, because the ledger is
// deliberately built never to need PII. So the tests below ARE the anti-abuse story; there is nothing
// else behind them.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHABET, mintCode, normalizeCode, codesMatch, ensureReferralCode, resolveCode,
  hasAccruedOrder, referralsThisMonth, claimProblem, claimReferral, settleDueClaims, voidClaimsForOrder,
} from '../../lib/keepers-referrals.mjs';
import {
  openKeepersDbAt, upsertCustomer, appendEvent, ledgerTotals, releaseHeldEvents, getCustomer,
} from '../../lib/keepers-db.mjs';

const A = 'gid://shopify/Customer/1';   // the referrer
const B = 'gid://shopify/Customer/2';   // the referee
const C = 'gid://shopify/Customer/3';
const ORDER = 'gid://shopify/Order/900';
const NOW = Date.parse('2026-09-06T00:00:00Z');

const RULES = {
  referral_referrer_xp: 200, referral_referrer_points: 500,
  referral_referee_xp: 0, referral_referee_points: 0,
  referral_hold_days: 14, max_referrals_per_month: 10,
};

let db;
beforeEach(() => {
  db = openKeepersDbAt(':memory:');
  for (const g of [A, B, C]) upsertCustomer(db, { customerGid: g });
});

const accrue = (gid, ref) => appendEvent(db, {
  customerGid: gid, kind: 'order_accrual', xpDelta: 50, pointsDelta: 100,
  source: 'shopify_order', sourceRef: ref, basisCents: 5000,
  rateXpPerDollar: 1, ratePointsPerDollar: 2,
});

describe('the code alphabet', () => {
  it('has no I, L, O or U', () => {
    // A code read off a phone at a card show gets typed back with 1 for I and 0 for O. Excluding them
    // means the customer cannot produce a valid-looking code that is not theirs by mistyping.
    for (const bad of ['I', 'L', 'O', 'U']) assert.equal(ALPHABET.includes(bad), false, bad);
    assert.equal(ALPHABET.length, 32, '32 symbols is exactly 5 bits — which is why minting can mask');
  });

  it('mints a typeable, prefixed code', () => {
    const c = mintCode('BK', Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    assert.equal(c, 'BK-0123-4567');
    assert.match(mintCode('BK'), /^BK-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('uses only alphabet symbols, over many mints', () => {
    for (let i = 0; i < 200; i++) {
      const body = mintCode('BK').replace(/^BK-/, '').replace('-', '');
      for (const ch of body) assert.ok(ALPHABET.includes(ch), `${ch} is not in the alphabet`);
    }
  });

  it('is unbiased — masking 5 bits of a byte is uniform because 32 divides 256', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) for (const ch of mintCode('').replace('-', '')) seen.add(ch);
    assert.equal(seen.size, 32, 'every symbol should be reachable');
  });
});

describe('normalizeCode — Crockford decoding, and why it matters', () => {
  it('maps the confusable characters the way someone types them', () => {
    // Without this, a customer reading their own code off a screen and typing O for 0 gets
    // "unknown code" for a code that is theirs, with nothing to tell them what went wrong.
    assert.equal(normalizeCode('BK-7K4M-QXO2'), normalizeCode('BK-7K4M-QX02'));
    assert.equal(normalizeCode('BKIL'), 'BK11');
  });

  it('ignores case, punctuation and spacing', () => {
    assert.equal(normalizeCode(' bk-7k4m-qx92 '), 'BK7K4MQX92');
    assert.equal(normalizeCode('BK 7K4M QX92'), 'BK7K4MQX92');
  });

  it('codesMatch is false for empty input, never vacuously true', () => {
    assert.equal(codesMatch('', ''), false);
    assert.equal(codesMatch(null, undefined), false);
    assert.equal(codesMatch('BK-7K4M-QX92', 'bk7k4mqx92'), true);
  });
});

describe('ensureReferralCode', () => {
  it('mints once and keeps it forever', () => {
    const first = ensureReferralCode(db, A);
    assert.match(first, /^BK-/);
    assert.equal(ensureReferralCode(db, A), first);
    assert.equal(getCustomer(db, A).referral_code, first);
  });

  it('gives different customers different codes', () => {
    assert.notEqual(ensureReferralCode(db, A), ensureReferralCode(db, B));
  });

  it('refuses a customer that does not exist rather than inventing one', () => {
    assert.throws(() => ensureReferralCode(db, 'gid://shopify/Customer/999'), /no customer row/);
  });
});

describe('resolveCode', () => {
  it('finds the owner, however the code was typed', () => {
    const code = ensureReferralCode(db, A);
    assert.equal(resolveCode(db, code), A);
    assert.equal(resolveCode(db, code.toLowerCase().replace(/-/g, '')), A);
    // The O-for-0 case, end to end.
    assert.equal(resolveCode(db, code.replace(/0/g, 'O')), A);
  });

  it('returns null for an unknown or empty code, never a guess', () => {
    assert.equal(resolveCode(db, 'BK-ZZZZ-ZZZZ'), null);
    assert.equal(resolveCode(db, ''), null);
    assert.equal(resolveCode(db, null), null);
  });
});

describe('the guards', () => {
  let code;
  beforeEach(() => { code = ensureReferralCode(db, A); });

  const problem = (over = {}) => claimProblem(db, {
    refereeGid: B, referrerGid: A, orderGid: ORDER, rules: RULES, nowMs: NOW, ...over,
  });

  it('allows a genuine first-order referral', () => {
    assert.equal(problem(), null);
  });

  it('refuses SELF-referral', () => {
    assert.equal(problem({ refereeGid: A }), 'self_referral');
  });

  it('refuses an unknown code', () => {
    assert.equal(problem({ referrerGid: null }), 'unknown_code');
  });

  it('refuses when the referee has ALREADY ORDERED — computed from the ledger', () => {
    // Not from customer.numberOfOrders, which counts cancelled orders: an account could otherwise be
    // "first-ordered" repeatedly by ordering and cancelling.
    accrue(B, 'gid://shopify/Order/800');
    assert.equal(problem(), 'not_first_order');
  });

  it('does not count the qualifying order itself as a prior order', () => {
    // The order that triggers the claim has usually already been accrued by the time we get here.
    accrue(B, ORDER);
    assert.equal(problem(), null);
  });

  it('refuses a second referrer for the same referee, forever', () => {
    claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });
    const other = ensureReferralCode(db, C);
    assert.equal(claimProblem(db, { refereeGid: B, referrerGid: C, orderGid: ORDER, rules: RULES, nowMs: NOW }),
      'already_referred_by_another');
  });

  it('refuses a retry after a REJECTION, so codes cannot be tried until one sticks', () => {
    accrue(B, 'gid://shopify/Order/800');
    const r = claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });
    assert.equal(r.reason, 'not_first_order');
    // The rejection is recorded, and it holds the primary key.
    const row = db.prepare('SELECT status, reject_reason FROM keepers_referral_claims WHERE referee_gid = ?').get(B);
    assert.equal(row.status, 'rejected');
    assert.equal(row.reject_reason, 'not_first_order');
  });

  it('enforces the per-referrer monthly cap', () => {
    const cap = { ...RULES, max_referrals_per_month: 2 };
    for (const g of ['gid://shopify/Customer/10', 'gid://shopify/Customer/11']) {
      upsertCustomer(db, { customerGid: g });
      claimReferral(db, { refereeGid: g, code, orderGid: `o-${g}`, rules: cap, nowMs: NOW });
    }
    assert.equal(claimProblem(db, { refereeGid: B, referrerGid: A, orderGid: ORDER, rules: cap, nowMs: NOW }),
      'referrer_monthly_cap');
    assert.equal(referralsThisMonth(db, A, { nowMs: NOW }), 2);
  });

  it('refuses a referrer with no customer row', () => {
    assert.equal(problem({ referrerGid: 'gid://shopify/Customer/404' }), 'referrer_unknown');
  });
});

describe('claimReferral — the award is HELD, not paid', () => {
  let code;
  beforeEach(() => { code = ensureReferralCode(db, A); });

  it('writes the award immediately but does not count it', () => {
    // Visible in the ledger and the admin from the moment it is earned, countable only after the
    // refund window. Without the hold, buy -> refund -> repeat mints a full award every cycle.
    const r = claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });
    assert.equal(r.ok, true);
    assert.equal(ledgerTotals(db, A).xp, 0, 'earned, not yet countable');
    const ev = db.prepare("SELECT status, hold_until FROM keepers_events WHERE kind='referral_referrer'").get();
    assert.equal(ev.status, 'held');
    assert.equal(ev.hold_until, new Date(NOW + 14 * 86400000).toISOString());
  });

  it('counts once the window passes', () => {
    claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });
    releaseHeldEvents(db, { now: new Date(NOW + 15 * 86400000).toISOString() });
    assert.deepEqual(ledgerTotals(db, A), { xp: 200, points: 500, events: 1 });
  });

  it('pays the referrer only, because the referee amounts are zero', () => {
    claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });
    const referee = db.prepare("SELECT COUNT(*) n FROM keepers_events WHERE kind='referral_referee'").get().n;
    assert.equal(referee, 0, 'a zero award writes no event at all');
  });

  it('pays both when Marty turns on give-10-get-10 — a config change, not a build', () => {
    const twoSided = { ...RULES, referral_referee_xp: 100, referral_referee_points: 250 };
    claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: twoSided, nowMs: NOW });
    releaseHeldEvents(db, { now: new Date(NOW + 15 * 86400000).toISOString() });
    assert.equal(ledgerTotals(db, A).xp, 200);
    assert.equal(ledgerTotals(db, B).xp, 100);
  });

  it('marks both customers dirty so the projection picks them up', () => {
    claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });
    assert.equal(getCustomer(db, A).dirty, 1);
    assert.equal(getCustomer(db, B).dirty, 1);
  });
});

describe('the exploit, closed', () => {
  it('VOIDS a held award when the qualifying order is reversed', () => {
    // buy -> refund -> repeat is the whole exploit. This is where it dies.
    const code = ensureReferralCode(db, A);
    claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });

    const voided = voidClaimsForOrder(db, ORDER);
    assert.equal(voided, 1);

    releaseHeldEvents(db, { now: new Date(NOW + 30 * 86400000).toISOString() });
    assert.equal(ledgerTotals(db, A).xp, 0, 'a voided award never counts, however long you wait');

    const claim = db.prepare('SELECT status, reject_reason FROM keepers_referral_claims WHERE referee_gid = ?').get(B);
    assert.equal(claim.status, 'rejected');
    assert.equal(claim.reject_reason, 'qualifying_order_reversed');
  });

  it('does NOT claw back an award that has already been released', () => {
    // Once earned, it is earned. Taking it back later would punish a referrer for something their
    // friend did weeks afterwards.
    const code = ensureReferralCode(db, A);
    claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });
    releaseHeldEvents(db, { now: new Date(NOW + 15 * 86400000).toISOString() });
    assert.equal(ledgerTotals(db, A).xp, 200);

    assert.equal(voidClaimsForOrder(db, ORDER), 0, 'nothing held to void');
    assert.equal(ledgerTotals(db, A).xp, 200);
  });

  it('and the referee cannot simply be re-referred afterwards', () => {
    const code = ensureReferralCode(db, A);
    claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });
    voidClaimsForOrder(db, ORDER);
    // The claim row survives as rejected, and it holds the primary key.
    const again = claimReferral(db, { refereeGid: B, code, orderGid: 'gid://shopify/Order/901', rules: RULES, nowMs: NOW });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'already_claimed');
  });
});

describe('settleDueClaims', () => {
  it('moves held claims to paid once the window passes, and is idempotent', () => {
    const code = ensureReferralCode(db, A);
    claimReferral(db, { refereeGid: B, code, orderGid: ORDER, rules: RULES, nowMs: NOW });
    assert.equal(settleDueClaims(db, { nowMs: NOW + 1000 }), 0, 'still inside the window');
    assert.equal(settleDueClaims(db, { nowMs: NOW + 15 * 86400000 }), 1);
    assert.equal(settleDueClaims(db, { nowMs: NOW + 30 * 86400000 }), 0, 'nothing left to settle');
  });
});

describe('hasAccruedOrder', () => {
  it('is false for a customer with nothing, true after an accrual', () => {
    assert.equal(hasAccruedOrder(db, B), false);
    accrue(B, ORDER);
    assert.equal(hasAccruedOrder(db, B), true);
    assert.equal(hasAccruedOrder(db, B, { excludeOrderGid: ORDER }), false);
  });
});
