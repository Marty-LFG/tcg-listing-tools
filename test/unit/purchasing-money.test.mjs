// test/unit/purchasing-money.test.mjs — the exact-cents rules behind receiving.
//
// The property that matters more than any single case: an apportionment MUST sum to what went in.
// Freight that half-lands is a cost basis that is quietly wrong on every unit it touched, and nothing
// downstream would ever notice — so it is asserted here over random input, not just examples.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  apportion, splitEvenly, lineValueCents, chargesPotCents, orderTotalCents,
  allocateCharges, perUnitFeesCents, blendUnitCents,
  effectiveFx, isFxEstimated, toAudCents, impliedFx,
  paidCents, paymentStatus,
} from '../../lib/purchasing-money.mjs';

const sum = (a) => a.reduce((x, y) => x + y, 0);

describe('apportion', () => {
  it('splits 100c three ways as 34/33/33 and loses nothing', () => {
    const out = apportion(100, [1, 1, 1]);
    assert.deepEqual(out, [34, 33, 33]);
    assert.equal(sum(out), 100);
  });

  it('weights by value, so freight follows the expensive line', () => {
    // A $600 case and a $6 pack: the case must carry ~99% of the freight, not 50%.
    const out = apportion(18000, [60000, 600]);
    assert.equal(sum(out), 18000);
    assert.ok(out[0] > out[1] * 50, `expected the case to dominate, got ${out}`);
  });

  it('handles a NEGATIVE pot, because a discount can exceed the freight', () => {
    const out = apportion(-100, [1, 1, 1]);
    assert.equal(sum(out), -100, 'a negative pot must still land exactly');
    // floor() puts the shortfall on the remainder ordering rather than drifting toward zero.
    assert.ok(out.every((c) => c < 0));
  });

  it('falls back to an equal split when every weight is zero', () => {
    const out = apportion(10, [0, 0, 0]);
    assert.equal(sum(out), 10);
    assert.deepEqual(out, [4, 3, 3]);
  });

  it('gives a single line the whole pot', () => {
    assert.deepEqual(apportion(777, [5]), [777]);
  });

  it('is empty for no lines, and never divides by zero', () => {
    assert.deepEqual(apportion(500, []), []);
  });

  it('is deterministic — the same input always yields the same answer', () => {
    // A preview the owner approved has to commit identically; a tie broken by object order would
    // make the committed allocation differ from the previewed one.
    const a = apportion(1000, [7, 7, 7, 7]);
    const b = apportion(1000, [7, 7, 7, 7]);
    assert.deepEqual(a, b);
    assert.equal(sum(a), 1000);
  });

  it('PROPERTY: sums exactly, for 500 random pots and weightings', () => {
    // Deterministic LCG — Math.random() would make a failure unreproducible.
    let seed = 20260829;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let t = 0; t < 500; t++) {
      const n = 1 + rnd(40);
      const weights = Array.from({ length: n }, () => rnd(200000));
      const pot = rnd(2000000) - 400000;                 // includes negative pots
      const out = apportion(pot, weights);
      assert.equal(out.length, n);
      assert.equal(sum(out), pot, `pot=${pot} weights=${weights}`);
      assert.ok(out.every(Number.isInteger), 'every share must be whole cents');
    }
  });

  it('stays exact at a scale that could overflow a naive product', () => {
    // A$100,000 pot over 40 lines of six-figure value: pot * weight must stay inside 2^53.
    const weights = Array.from({ length: 40 }, (_, i) => 100000 + i * 1000);
    const out = apportion(10000000, weights);
    assert.equal(sum(out), 10000000);
  });
});

describe('splitEvenly', () => {
  it('splits a lot to the cent — 1000c over 7 items', () => {
    const out = splitEvenly(1000, 7);
    assert.equal(sum(out), 1000, 'the owner\'s rule: it must sum to the lot total to the cent');
    assert.deepEqual(out, [143, 143, 143, 143, 143, 143, 142]);
  });

  it('divides cleanly when it can', () => {
    assert.deepEqual(splitEvenly(900, 3), [300, 300, 300]);
  });

  it('is empty for a lot with no items', () => {
    assert.deepEqual(splitEvenly(500, 0), []);
  });
});

describe('order value', () => {
  const line = (o) => ({ line_kind: 'unit', qty_ordered: 1, unit_cost_cents: 0, ...o });

  it('extends a unit line by quantity', () => {
    assert.equal(lineValueCents(line({ qty_ordered: 6, unit_cost_cents: 16840 })), 101040);
  });

  it('does NOT multiply a lot line — its price is the lump, not a unit rate', () => {
    assert.equal(lineValueCents(line({ line_kind: 'lot', qty_ordered: 1, lot_total_cents: 40000 })), 40000);
  });

  it('takes an explicit received quantity over the ordered one', () => {
    assert.equal(lineValueCents(line({ qty_ordered: 6, unit_cost_cents: 100 }), 4), 400);
  });

  it('subtracts a discount from the pot, and lets it go negative', () => {
    assert.equal(chargesPotCents({ shipping_cents: 1000, tax_cents: 500, other_fees_cents: 200, discount_cents: 300 }), 1400);
    assert.equal(chargesPotCents({ shipping_cents: 100, discount_cents: 500 }), -400);
    assert.equal(chargesPotCents(null), 0);
  });

  it('totals goods plus charges', () => {
    const lines = [line({ qty_ordered: 2, unit_cost_cents: 1000 }), line({ line_kind: 'lot', lot_total_cents: 5000 })];
    assert.equal(orderTotalCents({ shipping_cents: 1500 }, lines), 2000 + 5000 + 1500);
  });
});

describe('allocateCharges', () => {
  const L = (id, unit, qty) => ({ id, line_kind: 'unit', unit_cost_cents: unit, qty });

  it('spreads by value and sums to the pot exactly', () => {
    const alloc = allocateCharges(18000, [L(1, 16840, 6), L(2, 600, 10)], 'value');
    assert.equal(alloc.get(1) + alloc.get(2), 18000);
    assert.ok(alloc.get(1) > alloc.get(2), 'the boxes carry more freight than the packs');
  });

  it('by qty instead, when the value basis would be wrong', () => {
    const alloc = allocateCharges(300, [L(1, 10000, 1), L(2, 100, 2)], 'qty');
    assert.equal(alloc.get(1) + alloc.get(2), 300);
    assert.equal(alloc.get(1), 100);
    assert.equal(alloc.get(2), 200, 'by qty, two cheap units carry twice one expensive one');
  });

  it('is empty for no received lines', () => {
    assert.equal(allocateCharges(1000, []).size, 0);
  });

  it('still lands exactly when a line is free', () => {
    const alloc = allocateCharges(101, [L(1, 0, 1), L(2, 5000, 1)], 'value');
    assert.equal(alloc.get(1) + alloc.get(2), 101);
  });
});

describe('perUnitFeesCents', () => {
  it('rounds UP, so cost is never understated', () => {
    // 100c over 3 units: 34c each overstates by 2c total. Overstating cost understates profit, which
    // is the safe direction for a price floor.
    assert.equal(perUnitFeesCents(100, 3), 34);
    assert.ok(34 * 3 >= 100);
  });

  it('is exact when it divides', () => {
    assert.equal(perUnitFeesCents(600, 6), 100);
  });

  it('is zero for no units, rather than Infinity', () => {
    assert.equal(perUnitFeesCents(100, 0), 0);
  });
});

describe('blendUnitCents', () => {
  it('moves to the weighted average', () => {
    assert.equal(blendUnitCents(10000, 3, 13000, 3), 11500);
    assert.equal(blendUnitCents(1000, 9, 2000, 1), 1100);
  });

  it('treats an unknown old cost as unknown, not as zero', () => {
    assert.equal(blendUnitCents(null, 3, 9000, 1), 9000);
  });

  it('leaves the old cost alone when the new one is unknown', () => {
    assert.equal(blendUnitCents(9000, 3, null, 1), 9000);
    assert.equal(blendUnitCents(null, 0, null, 1), null);
  });

  it('adopts the new figure when there was no stock to average against', () => {
    assert.equal(blendUnitCents(5000, 0, 8000, 2), 8000);
  });
});

describe('FX', () => {
  it('prefers the settled rate, falls back to live, else null', () => {
    assert.equal(effectiveFx({ fx_to_aud: 1.52, settled_fx_to_aud: 1.5255 }), 1.5255);
    assert.equal(effectiveFx({ fx_to_aud: 1.52 }), 1.52);
    assert.equal(effectiveFx({}), null);
    assert.equal(effectiveFx(null), null);
  });

  it('flags an unsettled foreign order as an estimate, and never an AUD one', () => {
    assert.equal(isFxEstimated({ currency: 'USD', fx_to_aud: 1.52 }), true);
    assert.equal(isFxEstimated({ currency: 'USD', settled_fx_to_aud: 1.5 }), false);
    assert.equal(isFxEstimated({ currency: 'AUD' }), false);
  });

  it('passes AUD through untouched and converts everything else', () => {
    assert.equal(toAudCents(1000, 'AUD', null), 1000);
    assert.equal(toAudCents(1000, 'USD', 1.5255), 1526);
    assert.equal(toAudCents(null, 'USD', 1.5), null);
  });

  it('returns null rather than guessing when the rate is missing', () => {
    // GR3's hard edge: a silently wrong AUD number is worse than no number.
    assert.equal(toAudCents(1000, 'USD', null), null);
  });

  it('derives the rate a settled figure implies', () => {
    assert.equal(impliedFx(152550, 100000), 1.5255);
    assert.equal(impliedFx(null, 100000), null);
    assert.equal(impliedFx(1000, 0), null);
  });
});

describe('payments', () => {
  const order = { currency: 'USD' };

  it('sums same-currency payments', () => {
    const { paid, unconvertible } = paidCents(order, [{ id: 1, amount_cents: 4000, currency: 'USD' }, { id: 2, amount_cents: 4120, currency: 'USD' }]);
    assert.equal(paid, 8120);
    assert.deepEqual(unconvertible, []);
  });

  it('folds a payment made in another currency through its captured rate', () => {
    // An AUD card paying a USD invoice — this seller's normal case.
    const { paid } = paidCents(order, [{ id: 1, amount_cents: 15255, currency: 'AUD', fx_to_order: 0.6555 }]);
    assert.equal(paid, Math.round(15255 * 0.6555));
  });

  it('reports a payment it cannot convert instead of guessing a rate', () => {
    const { paid, unconvertible } = paidCents(order, [{ id: 7, amount_cents: 5000, currency: 'JPY' }]);
    assert.equal(paid, 0);
    assert.deepEqual(unconvertible, [7]);
  });

  it('counts a refund as negative, so the balance goes back up', () => {
    const { paid } = paidCents(order, [{ id: 1, amount_cents: 8120, currency: 'USD' }, { id: 2, amount_cents: -2000, currency: 'USD' }]);
    assert.equal(paid, 6120);
  });

  it('derives unpaid / partial / paid and the balance owed', () => {
    assert.deepEqual(paymentStatus(10000, 0), { status: 'unpaid', balance: 10000, overpaid: false });
    assert.deepEqual(paymentStatus(10000, 4000), { status: 'partial', balance: 6000, overpaid: false });
    assert.deepEqual(paymentStatus(10000, 10000), { status: 'paid', balance: 0, overpaid: false });
  });

  it('calls an overpayment paid, and says so, rather than inventing a fourth state', () => {
    const r = paymentStatus(10000, 12000);
    assert.equal(r.status, 'paid');
    assert.equal(r.balance, -2000);
    assert.equal(r.overpaid, true);
  });
});
