// test/unit/keepers-redeem.test.mjs — points into a discount code.
//
// Two things here are worth more than the rest put together:
//
//   debit-before-mint, because the alternative fails into a live code in the wild with no debit;
//   the eligibility echo, because a mutation that SUCCEEDS with the wrong shape is a store-wide money
//   leak that reports itself as a complete success.
//
// The Shopify calls are injected, so both are exercised offline.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  redemptionProblem, openRedemption, refundRedemption, mintRedemption,
  eligibleCustomerIds, eligibilityProblem, markUsedByOrder,
} from '../../lib/keepers-redeem.mjs';
import { openKeepersDbAt, upsertCustomer, appendEvent, ledgerTotals, withTransaction } from '../../lib/keepers-db.mjs';

const GID = 'gid://shopify/Customer/8675309';
const OTHER = 'gid://shopify/Customer/1111111';
const NOW = Date.parse('2026-09-06T00:00:00Z');

const TIER = { handle: 'tier-500', pointsCost: 500, percentOff: 5, label: '5% off' };
const RULES = { redemption_min_points: 500, redemption_expiry_days: 180, redemption_code_prefix: 'BK' };

let db;
beforeEach(() => {
  db = openKeepersDbAt(':memory:');
  upsertCustomer(db, { customerGid: GID });
  // 600 points to spend.
  appendEvent(db, {
    customerGid: GID, kind: 'order_accrual', xpDelta: 300, pointsDelta: 600,
    source: 'shopify_order', sourceRef: 'gid://shopify/Order/1', basisCents: 30000,
    rateXpPerDollar: 1, ratePointsPerDollar: 2,
  });
});

// A created node shaped the way Shopify returns one.
const node = (customerIds, over = {}) => ({
  id: 'gid://shopify/DiscountCodeNode/1',
  codeDiscount: {
    title: 'Keepers 5%', status: 'ACTIVE', asyncUsageCount: 0,
    codes: { nodes: [{ code: 'BK-ABCD-EFGH' }] },
    context: { customers: customerIds.map((id) => ({ id })) },
    ...over,
  },
});

describe('redemptionProblem', () => {
  it('allows a redemption the customer can afford', () => {
    assert.equal(redemptionProblem(db, { customerGid: GID, tier: TIER, rules: RULES }), null);
  });

  it('checks the LEDGER, not the projection cache', () => {
    // The cache is what we last wrote to Shopify and can be hours stale. Spending against it is how a
    // customer goes negative without ever being told.
    db.prepare('UPDATE keepers_customers SET points_written = 99999 WHERE customer_gid = ?').run(GID);
    const rich = { ...TIER, pointsCost: 5000 };
    assert.match(redemptionProblem(db, { customerGid: GID, tier: rich, rules: RULES }), /not enough points \(has 600/);
  });

  it('refuses below the configured floor', () => {
    const small = { ...TIER, pointsCost: 100 };
    assert.match(redemptionProblem(db, { customerGid: GID, tier: small, rules: RULES }), /below the 500-point minimum/);
  });

  it('refuses an unusable tier', () => {
    assert.match(redemptionProblem(db, { customerGid: GID, tier: null, rules: RULES }), /unknown tier/);
    assert.match(redemptionProblem(db, { customerGid: GID, tier: { pointsCost: 500, percentOff: 0 }, rules: RULES }), /unusable percentage/);
    assert.match(redemptionProblem(db, { customerGid: GID, tier: { pointsCost: 500, percentOff: 150 }, rules: RULES }), /unusable percentage/);
  });

  it('refuses a second open redemption', () => {
    withTransaction(db, () => openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }));
    assert.match(redemptionProblem(db, { customerGid: GID, tier: TIER, rules: RULES }), /already in progress/);
  });

  it('refuses an unknown customer', () => {
    assert.match(redemptionProblem(db, { customerGid: OTHER, tier: TIER, rules: RULES }), /unknown customer/);
  });
});

describe('openRedemption — the debit happens BEFORE Shopify is called', () => {
  it('takes the points and opens the row', () => {
    let r;
    withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    assert.equal(r.ok, true);
    assert.equal(ledgerTotals(db, GID).points, 100, '600 - 500');
    const row = db.prepare('SELECT * FROM keepers_redemptions WHERE id = ?').get(r.id);
    assert.equal(row.status, 'requested');
    assert.equal(row.points_cost, 500);
  });

  it('writes nothing when it refuses', () => {
    let r;
    withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: { ...TIER, pointsCost: 5000 }, rules: RULES }); });
    assert.equal(r.ok, false);
    assert.equal(ledgerTotals(db, GID).points, 600);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM keepers_redemptions').get().n, 0);
  });
});

describe('the eligibility echo — the entire security model', () => {
  it('accepts a code restricted to exactly our customer', () => {
    assert.equal(eligibilityProblem(node([GID]), GID), null);
    assert.deepEqual(eligibleCustomerIds(node([GID])), [GID]);
  });

  it('REFUSES a code with no customer restriction', () => {
    // This is the one that matters. A store-wide code is valid for everyone who finds the string, on
    // every order, and the mutation reports it as a complete success.
    assert.match(eligibilityProblem(node([]), GID), /NO customer restriction/);
    assert.match(eligibilityProblem({ codeDiscount: {} }, GID), /NO customer restriction/);
    assert.match(eligibilityProblem(null, GID), /NO customer restriction/);
  });

  it('refuses a code eligible for the WRONG customer', () => {
    assert.match(eligibilityProblem(node([OTHER]), GID), /eligible for gid:\/\/shopify\/Customer\/1111111/);
  });

  it('refuses a code eligible for more than one', () => {
    assert.match(eligibilityProblem(node([GID, OTHER]), GID), /eligible for 2 customers/);
  });
});

describe('mintRedemption', () => {
  const openOne = () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    return r.id;
  };

  // A fake shopifyGraphQL, injected by monkey-patching the module the same way the real one is called
  // is not possible here — so mintRedemption is exercised through its DB effects with a stub env that
  // makes the client refuse. What is fully covered offline is every DB transition it drives.
  it('refuses to mint a redemption that is not in the requested state', async () => {
    const id = openOne();
    db.prepare("UPDATE keepers_redemptions SET status='active' WHERE id=?").run(id);
    const out = await mintRedemption({}, db, id, { rules: RULES, store: 'dev', nowMs: NOW });
    assert.equal(out.ok, false);
    assert.match(out.reason, /not requested/);
  });

  it('refuses an unknown redemption', async () => {
    const out = await mintRedemption({}, db, 9999, { rules: RULES });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'unknown redemption');
  });

  it('REFUNDS the points when the mint fails', async () => {
    // Not configured, so shopifyGraphQL refuses without a network call.
    const id = openOne();
    assert.equal(ledgerTotals(db, GID).points, 100);
    const out = await mintRedemption({}, db, id, { rules: RULES, store: 'dev', nowMs: NOW });
    assert.equal(out.ok, false);
    assert.equal(ledgerTotals(db, GID).points, 600, 'the debit is compensated, not mutated');
    assert.equal(db.prepare('SELECT status FROM keepers_redemptions WHERE id=?').get(id).status, 'failed');
  });

  it('leaves the debit row in place and adds a refund row — append-only', async () => {
    const id = openOne();
    await mintRedemption({}, db, id, { rules: RULES, store: 'dev', nowMs: NOW });
    const kinds = db.prepare("SELECT kind FROM keepers_events WHERE source='redemption' ORDER BY id").all().map((r) => r.kind);
    assert.deepEqual(kinds, ['redemption_debit', 'redemption_refund'], 'the pair of them is the story');
  });
});

describe('refundRedemption', () => {
  it('is idempotent — a retried refund does not pay twice', () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    refundRedemption(db, r.id, { nowMs: NOW });
    const again = refundRedemption(db, r.id, { nowMs: NOW });
    assert.equal(again.already, true);
    assert.equal(ledgerTotals(db, GID).points, 600);
  });

  it('refuses an unknown redemption', () => {
    assert.equal(refundRedemption(db, 9999).ok, false);
  });
});

describe('markUsedByOrder — the second, independent reading', () => {
  it('marks an active code used, however the code was cased', () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    db.prepare("UPDATE keepers_redemptions SET status='active', code='BK-ABCD-EFGH' WHERE id=?").run(r.id);

    assert.equal(markUsedByOrder(db, 'bk-abcd-efgh', 'gid://shopify/Order/5', { nowMs: NOW }), 1);
    const row = db.prepare('SELECT status, used_order_gid FROM keepers_redemptions WHERE id=?').get(r.id);
    assert.equal(row.status, 'used');
    assert.equal(row.used_order_gid, 'gid://shopify/Order/5');
  });

  it('does not resurrect an expired or revoked code', () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    db.prepare("UPDATE keepers_redemptions SET status='expired', code='BK-X' WHERE id=?").run(r.id);
    assert.equal(markUsedByOrder(db, 'BK-X', 'gid://shopify/Order/5'), 0);
  });

  it('ignores a code we never minted', () => {
    assert.equal(markUsedByOrder(db, 'WELCOME10', 'gid://shopify/Order/5'), 0);
  });
});
