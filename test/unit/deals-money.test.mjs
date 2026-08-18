// test/unit/deals-money.test.mjs — the quote arithmetic.
//
// One lot of postage across a multi-line quote, and the guards on the discount figure the owner types.
// The band-MAX rule has its own invariant file (test/invariants/deal-postage-floor.test.mjs); what is
// here is the surrounding behaviour: slabs, quantities, refusals, and what the card is allowed to say.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { combinedPostageCents, dealSummary, checkDiscount, lineBand } from '../../lib/deals.mjs';
import { DEFAULT_BANDS } from '../../lib/shipping-bands.mjs';

const LETTER = 170, TRACKED = 826, SIGNATURE = 1520;
const line = (over = {}) => ({ title: 'Pikachu 025/165 SV151 Near Mint', unit_price_cents: 500, quantity: 1, sku: 'BK-1', ...over });

describe('combinedPostageCents — one lot of postage, at the dearest line', () => {
  it('a mixed cart ships at the TOP band, once', () => {
    // The owner's rule in one sentence: no $1.70 on a $500 card, even when a $3 common is beside it.
    const r = combinedPostageCents([line({ unit_price_cents: 300 }), line({ unit_price_cents: 50000 })]);
    assert.equal(r.ok, true);
    assert.equal(r.postageCents, SIGNATURE);
    assert.equal(r.bandId, 'signature');
  });

  it('a cart entirely inside one band stays in that band', () => {
    assert.equal(combinedPostageCents([line({ unit_price_cents: 300 }), line({ unit_price_cents: 400 })]).postageCents, LETTER);
  });

  it('is never the SUM — that is the thing the buyer is asking us to stop doing', () => {
    const lines = Array.from({ length: 5 }, () => line({ unit_price_cents: 300 }));
    const r = combinedPostageCents(lines);
    assert.equal(r.postageCents, LETTER);
    assert.notEqual(r.postageCents, LETTER * 5);
    // What the buyer's own cart would have quoted them, which is what makes the invoice worth sending.
    assert.equal(r.perLine.reduce((n, l) => n + l.costCents, 0), LETTER * 5);
  });

  it('honours minBandForSlab — a cheap graded card never travels untracked', () => {
    // A $20 slab fits a letter physically. The owner's call is that it does not go untracked whatever
    // it is worth, and the band table already says so; this proves the quote path honours it too.
    const raw = combinedPostageCents([line({ unit_price_cents: 2000 })]);
    const slab = combinedPostageCents([line({ unit_price_cents: 2000, title: 'Blastoise 009/102 Base Set PSA 8' })]);
    assert.equal(raw.postageCents, LETTER);
    assert.equal(slab.postageCents, TRACKED, 'the slab floor must lift it');
  });

  it('reads the band off the LINE TOTAL, not the unit price', () => {
    // 10 × $20 is $200 of cards in one envelope. Billing that off $20 would post $200 untracked.
    assert.equal(combinedPostageCents([line({ unit_price_cents: 2000, quantity: 1 })]).postageCents, LETTER);
    assert.equal(combinedPostageCents([line({ unit_price_cents: 2000, quantity: 10 })]).postageCents, SIGNATURE);
  });

  it('REFUSES a line it cannot price, instead of guessing band 1', () => {
    // Quietly treating an unreadable price as the cheapest band is exactly how a $500 card ends up on
    // a $1.70 letter — the failure the whole band module exists to prevent.
    for (const bad of [null, undefined, 0, -5, NaN, 'abc']) {
      const r = combinedPostageCents([line({ unit_price_cents: 500 }), line({ unit_price_cents: bad, title: 'Mystery' })]);
      assert.equal(r.ok, false, `should refuse on ${String(bad)}`);
      assert.equal(r.code, 'band_unresolved');
      assert.match(r.message, /Mystery/, 'names the line so it can be fixed');
    }
  });

  it('refuses an empty quote', () => {
    assert.equal(combinedPostageCents([]).code, 'no_lines');
    assert.equal(combinedPostageCents(null).code, 'no_lines');
  });

  it('lineBand returns null rather than a default for an unreadable price', () => {
    assert.equal(lineBand({ unit_price_cents: null }, undefined), null);
    assert.ok(lineBand({ unit_price_cents: 500, quantity: 1 }, undefined));
  });
});

describe('dealSummary — what a person needs to type a number into', () => {
  const lines = [line({ unit_price_cents: 3000, sku: 'A' }), line({ unit_price_cents: 50000, sku: 'B' })];

  it('adds up the cards, quotes one postage, and shows what it saved', () => {
    const s = dealSummary({ lines });
    assert.equal(s.subtotalCents, 53000);
    assert.equal(s.postageCents, SIGNATURE);
    assert.equal(s.grossTotalCents, 53000 + SIGNATURE);
    // Against what the buyer's cart would have charged: letter + signature.
    assert.equal(s.postageSavedCents, LETTER);
  });

  it('multiplies by quantity', () => {
    assert.equal(dealSummary({ lines: [line({ unit_price_cents: 500, quantity: 4 })] }).subtotalCents, 2000);
  });

  it('reports cost basis WITH its completeness, never assuming a missing one is zero', () => {
    const known = dealSummary({ lines, costBasis: { A: 1000, B: 30000 } });
    assert.equal(known.costBasisCents, 31000);
    assert.equal(known.costBasisComplete, true);

    const partial = dealSummary({ lines, costBasis: { A: 1000 } });
    assert.equal(partial.costBasisCents, 1000);
    assert.equal(partial.costBasisComplete, false);
    assert.equal(partial.unknownCostLines, 1);

    const none = dealSummary({ lines });
    assert.equal(none.costBasisCents, null, 'null means unknown, not free');
    assert.equal(none.costBasisComplete, false);
  });

  it('never reports a profit figure', () => {
    // lib/fees.mjs models the AU BUYER-protection fee only; there is no seller final-value-fee model
    // in this repo, so any "profit" would be confidently wrong in the direction that loses money (GR4).
    const s = dealSummary({ lines, costBasis: { A: 1000, B: 30000 } });
    for (const k of Object.keys(s)) {
      assert.ok(!/profit|margin|net_|earn/i.test(k), `dealSummary must not surface ${k}`);
    }
  });

  it('passes a band refusal straight through', () => {
    const s = dealSummary({ lines: [line({ unit_price_cents: null })] });
    assert.equal(s.ok, false);
    assert.equal(s.code, 'band_unresolved');
  });
});

describe('checkDiscount — structure is refused, judgement is only flagged', () => {
  const s = dealSummary({ lines: [line({ unit_price_cents: 3000, sku: 'A' }), line({ unit_price_cents: 50000, sku: 'B' })],
    costBasis: { A: 1000, B: 30000 } });

  it('accepts an ordinary discount and works out what the buyer pays', () => {
    const r = checkDiscount(5000, s);
    assert.equal(r.ok, true);
    // Postage is NOT discounted: it is a real cost, and the concession is already one lot of it.
    assert.equal(r.totalCents, 53000 - 5000 + SIGNATURE);
    assert.deepEqual(r.warnings, []);
  });

  const REFUSALS = [
    ['a negative figure, which would SURCHARGE the buyer', -100, 'discount_negative'],
    ['zero, which is not worth an invoice', 0, 'discount_zero'],
    ['fractional cents, which would not match the screen', 1.5, 'discount_not_whole_cents'],
    ['more than the cards are worth (a stray zero)', 60000, 'discount_exceeds_subtotal'],
    ['not a number at all', 'lots', 'discount_not_a_number'],
  ];
  for (const [why, v, code] of REFUSALS) {
    it(`refuses ${why}`, () => {
      const r = checkDiscount(v, s);
      assert.equal(r.ok, false);
      assert.equal(r.code, code);
    });
  }

  it('WARNS below cost rather than refusing — that call is the owner\'s to make', () => {
    const r = checkDiscount(30000, s, { costBasisCents: s.costBasisCents });
    assert.equal(r.ok, true, 'a thin deal is still a deal somebody may want to do');
    assert.ok(r.warnings.some((w) => w.code === 'below_cost'));
    assert.ok(r.warnings.some((w) => w.code === 'large_discount'));
  });

  it('says so plainly when it cannot tell whether the discount clears cost', () => {
    const blind = dealSummary({ lines: [line({ unit_price_cents: 3000, sku: 'A' })] });
    const r = checkDiscount(500, blind);
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.code === 'cost_unknown'));
  });

  it('refuses when the quote has no subtotal to discount', () => {
    assert.equal(checkDiscount(100, { subtotalCents: 0 }).code, 'no_subtotal');
  });

  it('allows discounting the cards down to exactly zero, but not past it', () => {
    assert.equal(checkDiscount(53000, s).ok, true);
    assert.equal(checkDiscount(53001, s).code, 'discount_exceeds_subtotal');
  });
});

describe('the band table these sums are built on', () => {
  it('is the shipped three, so the figures above mean what they say', () => {
    assert.deepEqual(DEFAULT_BANDS.map((b) => b.costCents), [LETTER, TRACKED, SIGNATURE]);
  });
});
