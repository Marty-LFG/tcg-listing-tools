// test/invariants/deal-postage-floor.test.mjs — a combined quote is NEVER postaged below its dearest line.
//
// This is one assertion, exhaustively applied, and it guards one number. Every other mistake in the
// deal feature is visible: a wrong subtotal is arithmetic somebody checks, a wrong discount is a figure
// the owner typed and can see. Postage quoted too LOW is silent — the invoice looks right, the buyer
// pays it, and the shop discovers the gap at the post office counter, per order, forever.
//
// The shop's rule, in the owner's words: "we don't want to do $1.70 for a $500 card". Combining is the
// concession; downgrading the service is not part of it.
//
// Every SUBSET of the band table is exercised rather than a handful of hand-picked carts, because the
// failure mode is a cart nobody thought to try — and the table is small enough that "every combination"
// is cheap and complete.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { combinedPostageCents } from '../../lib/deals.mjs';
import { DEFAULT_BANDS, bandMinCents, DEFAULT_SHIPPING } from '../../lib/shipping-bands.mjs';

// A price comfortably inside band i: its lower bound, which bandIndexForPrice must map back to i.
const priceInBand = (i) => bandMinCents(DEFAULT_BANDS, i) || 1;
// A raw (ungraded) title, so minBandForSlab cannot lift the band and change what is being measured.
const raw = (cents) => ({ title: 'Pikachu 025/165 SV151 Near Mint', unit_price_cents: cents, quantity: 1 });

// Every non-empty subset of the three bands, as index arrays: [0], [1], [2], [0,1], [0,2], … [0,1,2].
function subsets(n) {
  const out = [];
  for (let mask = 1; mask < (1 << n); mask++) {
    const s = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s.push(i);
    out.push(s);
  }
  return out;
}

describe('INVARIANT: combined postage is the MAX of the lines, never less', () => {
  const N = DEFAULT_BANDS.length;

  for (const combo of subsets(N)) {
    const label = combo.map((i) => DEFAULT_BANDS[i].id).join(' + ');
    it(`a cart of [${label}] is postaged at its dearest band`, () => {
      const lines = combo.map((i) => raw(priceInBand(i)));
      const want = Math.max(...combo.map((i) => DEFAULT_BANDS[i].costCents));
      const r = combinedPostageCents(lines, DEFAULT_SHIPPING);
      assert.equal(r.ok, true, r.message);
      assert.equal(r.postageCents, want, `[${label}] must be ${want}c`);
      // And the same regardless of the order the lines arrive in — a cart is a set, and the dearest
      // card being added last must not change the answer.
      const reversed = combinedPostageCents([...lines].reverse(), DEFAULT_SHIPPING);
      assert.equal(reversed.postageCents, want, 'order of lines must not matter');
    });
  }

  it('never quotes below ANY line in the cart, for every subset', () => {
    // The invariant stated directly rather than via the expected value, so it still holds if the band
    // table is ever re-costed.
    for (const combo of subsets(N)) {
      const lines = combo.map((i) => raw(priceInBand(i)));
      const r = combinedPostageCents(lines, DEFAULT_SHIPPING);
      for (const l of r.perLine) {
        assert.ok(r.postageCents >= l.costCents,
          `quoted ${r.postageCents}c on a cart containing a ${l.costCents}c line`);
      }
    }
  });

  it('a cheap line can never DRAG DOWN an expensive one, however many of them there are', () => {
    // The specific shape of the bug: twenty commons and one dear card. A rule that averaged, took the
    // first, took the most common, or took the cheapest would all pass a two-line test and fail here.
    const lines = [...Array.from({ length: 20 }, () => raw(priceInBand(0))), raw(priceInBand(2))];
    const r = combinedPostageCents(lines, DEFAULT_SHIPPING);
    assert.equal(r.postageCents, DEFAULT_BANDS[2].costCents);
  });

  it('holds for a re-costed band table, not just the shipped figures', () => {
    // Guards the rule rather than the numbers: if the owner re-prices the bands in Settings, MAX must
    // still be MAX. Costs must stay strictly increasing (validateBands enforces that separately).
    const bands = DEFAULT_BANDS.map((b, i) => ({ ...b, costCents: [250, 900, 2200][i] }));
    const shipping = { minBandForSlab: 0, bands };
    const r = combinedPostageCents([raw(priceInBand(0)), raw(priceInBand(1))], shipping);
    assert.equal(r.postageCents, 900);
  });

  it('a single-line quote is just that line, with nothing added', () => {
    for (let i = 0; i < N; i++) {
      const r = combinedPostageCents([raw(priceInBand(i))], DEFAULT_SHIPPING);
      assert.equal(r.postageCents, DEFAULT_BANDS[i].costCents);
    }
  });
});
