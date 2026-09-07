// test/unit/keepers-ingest.test.mjs — the accrual decision.
//
// Pure, so every rule here is exercised against an order shaped the way Shopify actually returns one.
// These are the rules the money runs through, and two of them fail in ways nobody would notice:
// accruing on a channel we promised not to, and snapshotting badge evidence too late to be true.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelOf, accrualBasisCents, keepersDiscountOf, evidenceOf, decideAccrual, reversalFor,
} from '../../lib/keepers-ingest.mjs';

const RULES = {
  enabled: true, xp_per_dollar: 1, points_per_dollar: 2,
  excluded_channels: ['eBay', 'Fetch TCG'],
};

const order = (over = {}) => ({
  id: 'gid://shopify/Order/5001',
  name: '#BK-1047',
  processedAt: '2026-09-02T00:00:00Z',
  createdAt: '2026-09-02T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  cancelledAt: null,
  displayFinancialStatus: 'PAID',
  currencyCode: 'AUD',
  sourceName: 'web',
  app: { name: 'Online Store' },
  publication: { name: 'Online Store' },
  tags: [],
  customer: { id: 'gid://shopify/Customer/8675309' },
  subtotalPriceSet: { shopMoney: { amount: '74.00', currencyCode: 'AUD' } },
  totalRefundedSet: { shopMoney: { amount: '0.00' } },
  refunds: [],
  discountApplications: { nodes: [] },
  customAttributes: [],
  lineItems: { nodes: [] },
  ...over,
});

describe('channelOf — three fields, populated inconsistently', () => {
  it('prefers publication, then app, then sourceName', () => {
    assert.deepEqual(channelOf(order()), { channel: 'Online Store', definite: true });
    assert.deepEqual(channelOf(order({ publication: null })), { channel: 'Online Store', definite: true });
    assert.deepEqual(channelOf(order({ publication: null, app: null })), { channel: 'web', definite: true });
  });

  it('reports INDEFINITE rather than guessing when all three are empty', () => {
    // "Could not tell" is not the same as "it was the online store", and conflating them is how an
    // eBay order starts earning XP.
    assert.deepEqual(channelOf(order({ publication: null, app: null, sourceName: '' })),
      { channel: null, definite: false });
    assert.deepEqual(channelOf({}), { channel: null, definite: false });
    assert.deepEqual(channelOf(undefined), { channel: null, definite: false });
  });
});

describe('decideAccrual', () => {
  it('accrues at the configured rates', () => {
    const d = decideAccrual(order(), RULES);
    assert.equal(d.accrues, true);
    assert.equal(d.basisCents, 7400);
    assert.equal(d.xp, 74);
    assert.equal(d.points, 148);
    assert.equal(d.rateXp, 1);
  });

  it('FLOORS, matching what the storefront promised on the product page', () => {
    // blocks/bk-keepers-earn.liquid floors. A customer told "74 XP" must not be handed 75, and two
    // roundings that disagree is exactly the broken promise that file's header warns about.
    const d = decideAccrual(order({ subtotalPriceSet: { shopMoney: { amount: '74.60' } } }), RULES);
    assert.equal(d.basisCents, 7460);
    assert.equal(d.xp, 74, '74.6 XP floors to 74');
    assert.equal(d.points, 149, '149.2 points floors to 149');
  });

  it('FAILS CLOSED when the channel cannot be determined', () => {
    // Accruing on an eBay order breaks a promise printed on every page of the site. Not accruing is a
    // support ticket. The cheaper mistake wins.
    const d = decideAccrual(order({ publication: null, app: null, sourceName: '' }), RULES);
    assert.equal(d.accrues, false);
    assert.equal(d.reason, 'channel_unknown');
    assert.equal(d.xp, 0);
  });

  it('refuses an excluded channel, case-insensitively', () => {
    for (const name of ['eBay', 'ebay', ' EBAY ']) {
      const d = decideAccrual(order({ publication: { name } }), RULES);
      assert.equal(d.accrues, false, name);
      assert.equal(d.reason, 'channel_excluded');
    }
  });

  it('stops accruing when the programme is switched off', () => {
    // One switch, both halves — the same flag that hides the storefront must stop the engine, or the
    // ledger keeps growing against surfaces that no longer promise anything.
    assert.equal(decideAccrual(order(), { ...RULES, enabled: false }).reason, 'programme_disabled');
    assert.equal(decideAccrual(order(), { ...RULES, enabled: 'false' }).reason, 'programme_disabled');
  });

  it('refuses rather than guessing when the rates are unreadable', () => {
    assert.equal(decideAccrual(order(), { ...RULES, xp_per_dollar: undefined }).reason, 'rates_unreadable');
    assert.equal(decideAccrual(order(), { ...RULES, points_per_dollar: 'lots' }).reason, 'rates_unreadable');
  });

  it('refuses an order with no readable subtotal', () => {
    assert.equal(decideAccrual(order({ subtotalPriceSet: null }), RULES).reason, 'no_subtotal');
  });

  it('always carries a reason when it declines', () => {
    // "This order earned nothing" is something someone will need explained months later, and the
    // config will have moved by then.
    for (const o of [
      order({ publication: null, app: null, sourceName: '' }),
      order({ publication: { name: 'eBay' } }),
      order({ subtotalPriceSet: null }),
    ]) {
      const d = decideAccrual(o, RULES);
      assert.equal(d.accrues, false);
      assert.ok(d.reason, 'a refusal must say why');
    }
  });
});

describe('the Keepers discount', () => {
  const withCode = (code) => order({
    discountApplications: { nodes: [{ __typename: 'DiscountCodeApplication', code }] },
  });

  it('matches a code we minted', () => {
    const d = keepersDiscountOf(withCode('BK-7K4M-QX92'), { knownCodes: ['BK-7K4M-QX92'] });
    assert.equal(d.used, true);
    assert.deepEqual(d.codes, ['BK-7K4M-QX92']);
  });

  it('falls back to the prefix, so a code minted before a prefix change still counts', () => {
    assert.equal(keepersDiscountOf(withCode('BK-OLD-CODE'), { codePrefix: 'BK-' }).used, true);
  });

  it('ignores an unrelated discount', () => {
    assert.equal(keepersDiscountOf(withCode('WELCOME10'), { codePrefix: 'BK-', knownCodes: [] }).used, false);
  });

  it('does not match everything when no prefix and no codes are configured', () => {
    // A blank prefix must disable the fallback, not match every code in the store.
    assert.equal(keepersDiscountOf(withCode('WELCOME10'), {}).used, false);
  });

  it('is case-insensitive', () => {
    assert.equal(keepersDiscountOf(withCode('bk-7k4m-qx92'), { knownCodes: ['BK-7K4M-QX92'] }).used, true);
  });
});

describe('evidenceOf — snapshotted, because re-reading later would be wrong', () => {
  const lines = (nodes) => order({ lineItems: { nodes } });

  it('collects languages, deduped and sorted', () => {
    const e = evidenceOf(lines([
      { sku: 'A', product: { language: { value: 'Japanese' } } },
      { sku: 'B', product: { language: { value: 'English' } } },
      { sku: 'C', product: { language: { value: 'Japanese' } } },
    ]));
    assert.deepEqual(e.languages, ['English', 'Japanese']);
  });

  it('records the pre-order flag AT THE TIME', () => {
    // bkc.release_status flips to in-stock the week the set drops. Re-reading it later would make
    // preorder-pioneer permanently unwinnable, silently.
    const e = evidenceOf(lines([{ sku: 'A', product: { releaseStatus: { value: 'pre-order' } } }]));
    assert.equal(e.preorder, true);
    assert.equal(evidenceOf(lines([{ sku: 'A', product: { releaseStatus: { value: 'in-stock' } } }])).preorder, false);
  });

  it('collects SKUs for the pre-grading rule', () => {
    assert.deepEqual(evidenceOf(lines([{ sku: 'PREGRADE-001' }, { sku: 'ABC' }, { sku: '' }])).skus,
      ['PREGRADE-001', 'ABC']);
  });

  it('carries the referral code off the cart attribute', () => {
    const e = evidenceOf(order({ customAttributes: [{ key: 'bk_ref', value: 'BK-1234-ABCD' }] }));
    assert.equal(e.ref, 'BK-1234-ABCD');
    assert.equal(evidenceOf(order()).ref, null);
  });

  it('survives an order with no line items', () => {
    const e = evidenceOf(order());
    assert.deepEqual(e.languages, []);
    assert.equal(e.preorder, false);
  });
});

describe('accrualBasisCents', () => {
  it('is the subtotal — shipping and tax are excluded by using it', () => {
    assert.equal(accrualBasisCents(order()), 7400);
  });

  it('subtracts a Keepers discount so redeemed points cannot earn points back', () => {
    assert.equal(accrualBasisCents(order(), { keepersDiscountCents: 500 }), 6900);
  });

  it('never goes below zero', () => {
    assert.equal(accrualBasisCents(order(), { keepersDiscountCents: 999999 }), 0);
  });

  it('returns null rather than 0 when there is no subtotal to read', () => {
    // 0 is a real basis (a fully-discounted order); null means we could not tell, and the caller
    // refuses on it.
    assert.equal(accrualBasisCents(order({ subtotalPriceSet: null })), null);
    assert.equal(accrualBasisCents({}), null);
  });
});

describe('reversalFor — proportional, at the original rate', () => {
  const d = decideAccrual(order(), RULES);   // 7400c -> 74 xp / 148 pts

  it('takes back the refunded share', () => {
    assert.deepEqual(reversalFor(d, { refundedCents: 3700 }), { xp: 37, points: 74 });
  });

  it('takes back everything on a full refund', () => {
    assert.deepEqual(reversalFor(d, { refundedCents: 7400 }), { xp: 74, points: 148 });
  });

  it('cannot exceed the original, even if the refund somehow does', () => {
    assert.deepEqual(reversalFor(d, { refundedCents: 999999 }), { xp: 74, points: 148 });
  });

  it('is zero for a zero or nonsensical refund', () => {
    for (const c of [0, -5, null, undefined, NaN]) {
      assert.deepEqual(reversalFor(d, { refundedCents: c }), { xp: 0, points: 0 }, String(c));
    }
  });

  it('is zero when there was no basis to reverse', () => {
    assert.deepEqual(reversalFor({ basisCents: 0, xp: 0, points: 0 }, { refundedCents: 100 }), { xp: 0, points: 0 });
  });

  it('floors, so a partial refund never gives back more than it took', () => {
    // One card refunded from a five-card order: 1/3 of 74 is 24.67, and 24 is the safe direction.
    assert.deepEqual(reversalFor(d, { refundedCents: 2467 }), { xp: 24, points: 49 });
  });
});

// --- the accrual basis is BEFORE returns ----------------------------------------------------------
//
// THE BUG THIS EXISTS TO PREVENT, and it is invisible unless a fixture carries BOTH subtotals with
// DIFFERENT values — which no fixture in this file did, because they all set one field and the code
// read the same one. That is why 5000 tests missed it.
//
// accrualBasisCents used to read currentSubtotalPriceSet, which the Admin API documents as "after
// returns and refunds". An accrual is write-once (uq_kev_source + ON CONFLICT DO NOTHING), so an
// order whose FIRST ingest happened after money had moved banked a permanently reduced accrual — and
// the reversal then took its share of that already-reduced figure, charging the refund twice.
//
// Reachable precisely when the ledger is armed: observe mode never advances the cursor, so the first
// sweep after arming first-ingests everything updated in the last 50 days in the state it is in that
// day, refunds included.
describe('the accrual basis is what was SPENT, not what survived the refunds', () => {
  // $74 order, $40 refunded. The two subtotals disagree, which is the whole point of the fixture.
  const refunded = order({
    subtotalPriceSet: { shopMoney: { amount: '74.00', currencyCode: 'AUD' } },
    currentSubtotalPriceSet: { shopMoney: { amount: '34.00', currencyCode: 'AUD' } },
    refunds: [{ id: 'gid://shopify/Refund/1', createdAt: '2026-09-01T00:00:00Z', totalRefundedSet: { shopMoney: { amount: '40.00' } } }],
  });

  it('accrues on the pre-refund subtotal', () => {
    assert.equal(accrualBasisCents(refunded), 7400,
      'the basis must be what the customer spent — reading the refund-net figure charges the refund twice');
  });

  it('and the decision carries that basis into the ledger', () => {
    const d = decideAccrual(refunded, RULES);
    assert.equal(d.accrues, true);
    assert.equal(d.basisCents, 7400);
    assert.equal(d.xp, 74, 'a $74 order earns 74 XP however much of it was later refunded');
  });

  it('the refund is still seen, so the reversal has something to score', () => {
    // The fix must not accidentally hide the refund: the accrual goes up, and the reversal that
    // brings it back down has to still be reachable from the same decision.
    assert.equal(decideAccrual(refunded, RULES).refunds.length, 1);
    assert.equal(decideAccrual(refunded, RULES).refunds[0].cents, 4000);
  });

  it('a missing pre-refund subtotal is a refusal, not a fallback to the live one', () => {
    // Falling back to currentSubtotalPriceSet would reintroduce the bug on exactly the orders where
    // it matters. No subtotal means no accrual.
    const noSub = order({ subtotalPriceSet: null, currentSubtotalPriceSet: { shopMoney: { amount: '34.00' } } });
    assert.equal(accrualBasisCents(noSub), null);
    assert.equal(decideAccrual(noSub, RULES).reason, 'no_subtotal');
  });
});
