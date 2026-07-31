// test/unit/repricer-decide.test.mjs — the repricer's decision function.
//
// Most of these assert a REFUSAL. That is deliberate: a wrong "no" costs nothing, a wrong "yes"
// changes a real price on a live listing that a human approves from a phone in three seconds. The
// three fixtures named "trap N" pin defects measured against the real code — remove one and the
// scan ships a wrong price.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideReprice, eligibleForReprice, DEFAULT_GUARDRAILS } from '../../lib/repricer-decide.mjs';

const listing = (over = {}) => ({
  listingId: '168537104622', title: 'Pokemon Wailord ex 016/084 Pitch Black Double Rare Holo EN M/NM',
  priceCents: 1000, postageCents: 0, currency: 'AUD', availableQty: 3,
  listingType: 'FixedPriceItem', state: 'active', createdVia: 'manual',
  bestOffer: false, discountPricing: false, isVariation: false, ...over,
});
const identity = (over = {}) => ({ confidence: 'medium', game: 'pokemon', name: 'Wailord ex', number: '016/084', ...over });
const comps = (over = {}) => ({
  matched: true, reliable: true, mode: 'asking', comparable: 20, sampleSize: 30,
  confidence: 'medium', recommended: 12.00, cheapest: 12.01, fair: 13.0, clusterRange: [12.0, 14.0],
  query: 'Pokemon Wailord ex 016/084 Pitch Black', ...over,
});
const decide = (over = {}) => decideReprice({
  listing: listing(), identity: identity(), comps: comps(), guardrails: {}, context: {}, ...over,
});

describe('decideReprice — the happy path', () => {
  it('raises, and reports the price it will actually send', () => {
    const r = decide();
    assert.equal(r.verdict, 'raise');
    assert.equal(r.code, null);
    assert.equal(r.fromPriceCents, 1000);
    assert.equal(r.toPriceCents, 1198, 'A$12.00 target snaps down to the store ending A$11.98');
    assert.equal(r.upliftCents, 198);
    assert.equal(r.upliftPct, 19.8, 'uplift is recomputed AFTER cap+snap, not before');
    assert.equal(r.basis, 'delivered');
    assert.equal(r.evidence.comparable, 20);
    assert.equal(r.evidence.query, 'Pokemon Wailord ex 016/084 Pitch Black');
  });

  it('caps a big move and says it capped', () => {
    const r = decide({ comps: comps({ recommended: 50.0 }) });
    assert.equal(r.verdict, 'raise');
    assert.equal(r.capped, true);
    assert.ok(r.toPriceCents <= 1400, 'must not exceed +40% of A$10.00, got ' + r.toPriceCents);
  });
});

// --- trap 1: comps are DELIVERED, our price is LIST -------------------------------------------
describe('trap 1 — delivered vs list price basis', () => {
  it('subtracts OUR postage before comparing, so postage cannot fake an uplift', () => {
    // Market delivered A$12.00. We charge A$4.50 postage, so a matching LIST price is A$7.50 —
    // below our A$10.00. Treating the comps figure as a list price would have "raised" us to
    // A$11.98 and put our delivered price A$4.50 above the whole cluster.
    const r = decide({ listing: listing({ postageCents: 450 }) });
    assert.equal(r.verdict, 'hold');
    assert.equal(r.code, 'above_market');
    assert.equal(r.toPriceCents, 750);
  });

  it('free postage means the delivered target IS the list target', () => {
    assert.equal(decide({ listing: listing({ postageCents: 0 }) }).toPriceCents, 1198);
  });

  it('refuses when our postage is unknown rather than assuming zero', () => {
    const r = decide({ listing: listing({ postageCents: null }) });
    assert.equal(r.verdict, 'skip');
    assert.equal(r.code, 'postage_unknown');
  });
});

// --- trap 2: the snap turns raises into cuts ---------------------------------------------------
describe('trap 2 — snapToEnding can erase (or invert) an uplift', () => {
  const loose = { minUpliftPct: 1, minUpliftCents: 1 };

  it('holds instead of emitting a CUT when the snap lands at or below the current price', () => {
    // Measured: snapToEnding(3.20,'down') === 2.98. A 20c raise becomes a 2c cut. Without the
    // post-snap re-check this returns verdict 'raise' with toPriceCents BELOW fromPriceCents, and
    // applyReprice rejects it at the tap — which reads as "my small raises randomly fail".
    const r = decide({
      listing: listing({ priceCents: 300 }),
      comps: comps({ recommended: 3.20 }),
      guardrails: loose,
    });
    assert.equal(r.verdict, 'hold');
    assert.equal(r.code, 'snap_erased_uplift');
    assert.ok(r.toPriceCents <= 300, 'the snapped target really is a cut: ' + r.toPriceCents);
  });

  it('never returns a raise whose target is below its source — across a sweep of prices', () => {
    for (let from = 100; from <= 5000; from += 37) {
      for (const mult of [1.01, 1.05, 1.2, 1.5, 2.0]) {
        const r = decide({
          listing: listing({ priceCents: from }),
          comps: comps({ recommended: (from * mult) / 100 }),
          guardrails: loose,
        });
        if (r.verdict === 'raise') {
          assert.ok(r.toPriceCents > from,
            `raise must increase: from ${from} to ${r.toPriceCents} (x${mult})`);
          assert.ok(r.upliftCents > 0, 'uplift must be positive');
        }
      }
    }
  });

  it('a target that survives the snap still raises', () => {
    // A$3.00 → market A$5.00, capped at +40% to A$4.20, which is not a store ending, so it snaps
    // down to A$3.98 — still comfortably a raise, so the post-snap re-check lets it through.
    const r = decide({ listing: listing({ priceCents: 300 }), comps: comps({ recommended: 5.0 }), guardrails: loose });
    assert.equal(r.verdict, 'raise');
    assert.equal(r.toPriceCents, 398);
    assert.equal(r.capped, true);
  });
});

// --- trap 3: an unparseable title must never be comped ------------------------------------------
describe('trap 3 — identity is the gate on comps precision', () => {
  it('skips when parseCardTitle could not identify the card', () => {
    // buildNumberRe('039a/298') compiles to /\b0*39\b/ — it fails to match the card's own title and
    // matches "Mewtwo 39 Promo". parseCardTitle reports confidence:'none' for exactly these, so it
    // is the gate.
    for (const conf of ['none', null, undefined]) {
      const r = decide({ identity: identity({ confidence: conf }) });
      assert.equal(r.verdict, 'skip');
      assert.equal(r.code, 'title_unparseable');
    }
  });
  it('skips a listing whose game could not be determined', () => {
    const r = decide({ identity: identity({ game: null }) });
    assert.equal(r.verdict, 'skip');
    assert.equal(r.code, 'unknown_game');
  });
});

// --- eligibility ------------------------------------------------------------------------------
describe('eligibleForReprice — refuses before a comps call is spent', () => {
  const cases = [
    ['not_active', { state: 'ended' }],
    ['auction', { listingType: 'Chinese' }],
    ['not_fixed_price', { listingType: 'StoresFixedPrice' }],
    ['no_price', { priceCents: 0 }],
    ['currency_mismatch', { currency: 'USD' }],
    ['zero_qty', { availableQty: 0 }],
    ['multi_variation', { isVariation: true }],
    ['best_offer_active', { bestOffer: true }],
    ['discount_pricing_active', { discountPricing: true }],
    ['postage_unknown', { postageCents: null }],
  ];
  for (const [code, over] of cases) {
    it('refuses ' + code, () => {
      const e = eligibleForReprice(listing(over), identity());
      assert.equal(e.ok, false);
      assert.equal(e.code, code);
    });
  }
  it('passes a clean listing', () => {
    assert.equal(eligibleForReprice(listing(), identity()).ok, true);
  });
});

// --- market trust: decline ----------------------------------------------------------------------
describe('decideReprice — declines an untrustworthy market read', () => {
  it('no comps at all', () => {
    assert.equal(decide({ comps: null }).code, 'no_comps');
    assert.equal(decide({ comps: comps({ matched: false }) }).code, 'no_comps');
  });
  it('the engine says the set is not reliable', () => {
    // The live Froakie case: 5 comps, reliable:false, and an absurd A$32.48 recommendation.
    const r = decide({ comps: comps({ reliable: false, comparable: 5, confidence: 'low', recommended: 32.48 }) });
    assert.equal(r.verdict, 'decline');
    assert.equal(r.code, 'not_reliable');
  });
  it('too few comparables', () => {
    assert.equal(decide({ comps: comps({ comparable: 7 }) }).code, 'too_few_comps');
    assert.equal(decide({ comps: comps({ comparable: 8 }) }).verdict, 'raise', 'the threshold is inclusive');
  });
  it('confidence below the required floor', () => {
    assert.equal(decide({ comps: comps({ confidence: 'low' }) }).code, 'confidence_below_required');
    assert.equal(decide({ comps: comps({ confidence: 'high' }) }).verdict, 'raise');
    // The whole point of dropping the floor to medium: asking-only comps can never score 'high'.
    assert.equal(decide({ guardrails: { requiredConfidence: 'high' } }).code, 'confidence_below_required');
  });
  it('a mode the owner has not allowed', () => {
    const r = decide({ guardrails: { allowedModes: ['sold'] } });
    assert.equal(r.code, 'mode_not_allowed');
    // 'sold' must stay permitted by default so a future sold source needs no change here.
    assert.ok(DEFAULT_GUARDRAILS.allowedModes.includes('sold'));
    assert.equal(decide({ comps: comps({ mode: 'sold' }) }).verdict, 'raise');
  });
  it('declines are distinct from holds — a shadow run must be able to tell them apart', () => {
    assert.equal(decide({ comps: comps({ comparable: 2 }) }).verdict, 'decline');
    assert.equal(decide({ comps: comps({ recommended: 5.0 }) }).verdict, 'hold');
  });
});

// --- the price is already right: hold -----------------------------------------------------------
describe('decideReprice — holds a price that does not need moving', () => {
  it('market below us', () => {
    // The live Wailord case: comps said A$1.98 against our A$2.98.
    const r = decide({ listing: listing({ priceCents: 298 }), comps: comps({ recommended: 1.98 }) });
    assert.equal(r.verdict, 'hold');
    assert.equal(r.code, 'above_market');
  });
  it('market exactly at us', () => {
    assert.equal(decide({ comps: comps({ recommended: 10.0 }) }).code, 'at_market');
  });
  it('uplift below the percentage floor', () => {
    assert.equal(decide({ comps: comps({ recommended: 10.5 }) }).code, 'uplift_below_threshold');
  });
  it('uplift below the dollar floor even when the percentage clears', () => {
    // A$0.50 → A$0.60 is +20% but only 10c; min_uplift_aud exists precisely to filter this out.
    const r = decide({ listing: listing({ priceCents: 50 }), comps: comps({ recommended: 0.60 }) });
    assert.equal(r.verdict, 'hold');
    assert.equal(r.code, 'uplift_below_threshold');
  });
  it('NEVER clamps a decrease into a +0% no-op raise', () => {
    const r = decide({ comps: comps({ recommended: 4.0 }) });
    assert.notEqual(r.verdict, 'raise');
    assert.equal(r.toPriceCents, 400, 'the computed target is reported honestly, not clamped to the current price');
  });
});

// --- context: don't re-propose what we just did -------------------------------------------------
describe('decideReprice — context guards', () => {
  it('skips a listing that already has an open proposal', () => {
    assert.equal(decide({ context: { openProposal: true } }).code, 'open_proposal');
  });
  it('skips inside the cooldown after a recent apply, and allows it after', () => {
    const nowIso = '2026-07-31T12:00:00.000Z';
    const recent = { nowIso, lastAppliedAt: '2026-07-31T09:00:00.000Z', cooldownHours: 24 };
    const old = { nowIso, lastAppliedAt: '2026-07-25T09:00:00.000Z', cooldownHours: 24 };
    assert.equal(decide({ context: recent }).code, 'cooldown');
    assert.equal(decide({ context: old }).verdict, 'raise');
  });
});

describe('decideReprice — purity', () => {
  it('is deterministic and does not mutate its inputs', () => {
    const l = listing(), i = identity(), c = comps();
    const before = JSON.stringify({ l, i, c });
    const a = decide({ listing: l, identity: i, comps: c });
    const b = decide({ listing: l, identity: i, comps: c });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify({ l, i, c }), before, 'inputs must not be mutated');
  });
});
