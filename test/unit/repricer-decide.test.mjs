// test/unit/repricer-decide.test.mjs — the repricer's decision function.
//
// Most of these assert a REFUSAL. That is deliberate: a wrong "no" costs nothing, a wrong "yes"
// changes a real price on a live listing that a human approves from a phone in three seconds. The
// three fixtures named "trap N" pin defects measured against the real code — remove one and the
// scan ships a wrong price.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideReprice, eligibleForReprice, scaleBestOfferCents, anchorFor, DEFAULT_GUARDRAILS } from '../../lib/repricer-decide.mjs';

const listing = (over = {}) => ({
  listingId: '168537104622', title: 'Pokemon Wailord ex 016/084 Pitch Black Double Rare Holo EN M/NM',
  priceCents: 1000, postageCents: 0, currency: 'AUD', availableQty: 3,
  listingType: 'FixedPriceItem', state: 'active', createdVia: 'manual',
  bestOffer: false, discountPricing: false, isVariation: false, ...over,
});
const identity = (over = {}) => ({ game: 'Pokemon', name: 'Wailord ex', number: '016/084', numberSafe: true, ...over });
const comps = (over = {}) => {
  const c = {
    matched: true, reliable: true, mode: 'asking', comparable: 20, sampleSize: 30,
    confidence: 'medium', recommended: 12.00, cheapest: 12.01, fair: 13.0, clusterRange: [12.0, 14.0],
    query: 'Pokemon Wailord ex 016/084 Pitch Black', ...over,
  };
  // The default anchor is cheapest_n, so a fixture needs a low tail. Unless a test supplies its own,
  // derive one whose THIRD entry undercuts to the same place `recommended` does — that way a test
  // that only cares about the cap, the snap or a threshold keeps asserting what it always asserted,
  // and only the tests that are actually ABOUT the anchor have to think about it.
  if (!c.lowest) c.lowest = [c.recommended - 1, c.recommended - 0.5, c.recommended + 0.01];
  return c;
};
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
    const r = decide({ listing: listing({ postageCents: 450 }), guardrails: { targetAnchor: 'cluster' } });
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
  // Pinned to the CLUSTER anchor: it is the one that hands step 9 an unsnapped number, which is the
  // whole point of the trap. Under cheapest_n the anchor arrives already on an ending, and the same
  // hazard reappears one step later — via the postage subtraction and the cap — which the sweep below
  // covers under both anchors.
  const loose = { minUpliftPct: 1, minUpliftCents: 1, targetAnchor: 'cluster' };

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
       for (const anchor of ['cluster', 'cheapest_n']) {
        const r = decide({
          listing: listing({ priceCents: from, postageCents: from % 300 }),
          comps: comps({ recommended: (from * mult) / 100 }),
          guardrails: { ...loose, targetAnchor: anchor },
        });
        if (r.verdict === 'raise') {
          assert.ok(r.toPriceCents > from,
            `raise must increase: from ${from} to ${r.toPriceCents} (x${mult}, ${anchor})`);
          assert.ok(r.upliftCents > 0, 'uplift must be positive');
        }
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
  it('skips when the collector number cannot drive the comps filter', () => {
    // buildNumberRe('039a/298') compiles to /\b0*39\b/ — it fails to match the card's own number and
    // matches "Mewtwo 39 Promo". The scan self-tests that regex against the number and reports
    // numberSafe:false for exactly those shapes, which is the gate here.
    for (const over of [{ numberSafe: false }, { number: null }, { number: null, numberSafe: true }]) {
      const r = decide({ identity: identity(over) });
      assert.equal(r.verdict, 'skip');
      assert.equal(r.code, 'title_unparseable');
    }
  });
  it('does NOT gate on parseCardTitle confidence, which reads "none" for good titles', () => {
    // parseCardTitle needs a per-game SET list to reach any confidence above 'none', and the scan
    // does not have one — so a perfectly good "Pokemon Wailord ex 016/084 …" parses to 'none'.
    // Gating on confidence would have skipped every listing in the store, silently.
    assert.equal(decide({ identity: identity({ confidence: 'none' }) }).verdict, 'raise');
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
    ['best_offer_auto_accept', { bestOffer: true, bestOfferAutoAcceptCents: 800 }],
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

  // Best Offer was on 7 of the first 10 real listings scanned, so refusing all of it refuses most of
  // the store. The risk it stood in for is specifically the ABSOLUTE auto-accept amount; without one,
  // every offer reaches a human and a raise only improves the anchor they answer from.
  describe('Best Offer is refused for its threshold, not for existing', () => {
    it('allows Best Offer with no thresholds at all', () => {
      assert.equal(eligibleForReprice(listing({ bestOffer: true }), identity()).ok, true);
    });
    it('allows Best Offer with only an auto-decline minimum', () => {
      // The minimum stays put after a raise, which strands offers into a human queue — never a sale
      // below what the listing already accepted.
      assert.equal(eligibleForReprice(listing({ bestOffer: true, bestOfferMinCents: 500 }), identity()).ok, true);
    });
    it('refuses as soon as an auto-accept amount is present', () => {
      const e = eligibleForReprice(listing({ bestOffer: true, bestOfferAutoAcceptCents: 1 }), identity());
      assert.equal(e.code, 'best_offer_auto_accept');
    });
    // An absent field must read as "not set", not as "A$0.00 auto-accept" — otherwise the refusal
    // fires on every listing and the relaxation above is undone silently.
    it('treats an absent auto-accept as not set, not as zero', () => {
      for (const v of [null, undefined, 0]) {
        assert.equal(eligibleForReprice(listing({ bestOffer: true, bestOfferAutoAcceptCents: v }), identity()).ok,
          true, 'auto-accept ' + JSON.stringify(v) + ' must not refuse');
      }
    });
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
// Pinned to the cluster anchor so the arithmetic stays exact and readable — these are about the
// thresholds and the up-only rule, not about which competitor gets undercut.
describe('decideReprice — holds a price that does not need moving', () => {
  it('market below us', () => {
    // The live Wailord case: comps said A$1.98 against our A$2.98.
    const r = decide({ listing: listing({ priceCents: 298 }), comps: comps({ recommended: 1.98 }) });
    assert.equal(r.verdict, 'hold');
    assert.equal(r.code, 'above_market');
  });
  it('market exactly at us', () => {
    assert.equal(decide({ comps: comps({ recommended: 10.0 }), guardrails: { targetAnchor: 'cluster' } }).code, 'at_market');
  });
  it('uplift below the percentage floor', () => {
    assert.equal(decide({ comps: comps({ recommended: 10.5 }), guardrails: { targetAnchor: 'cluster' } }).code, 'uplift_below_threshold');
  });
  it('uplift below the dollar floor even when the percentage clears', () => {
    // A$0.50 → A$0.60 is +20% but only 10c; min_uplift_aud exists precisely to filter this out.
    const r = decide({ listing: listing({ priceCents: 50 }), comps: comps({ recommended: 0.60 }), guardrails: { targetAnchor: 'cluster' } });
    assert.equal(r.verdict, 'hold');
    assert.equal(r.code, 'uplift_below_threshold');
  });
  it('NEVER clamps a decrease into a +0% no-op raise', () => {
    const r = decide({ comps: comps({ recommended: 4.0 }), guardrails: { targetAnchor: 'cluster' } });
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

// --- Phase 5: the Best Offer floor arithmetic ---------------------------------------------------
// The owner set a DISCOUNT, not a dollar amount: A$8 auto-accept on a A$10 listing means "20% off is
// fine". Raise to A$15 and leave the floor and that becomes 47% off — the same intent silently
// re-expressed as a much worse deal. Scaling by the price ratio is what preserves what they chose.
describe('scaleBestOfferCents — the floor keeps its ratio to the price', () => {
  it('moves the auto-accept by the same multiple as the price', () => {
    const r = scaleBestOfferCents({ fromPriceCents: 1000, toPriceCents: 1500, autoAcceptCents: 800 });
    assert.equal(r.autoAcceptCents, 1200, '80% of list before, 80% of list after');
    assert.equal(r.ratio, 1.5);
  });
  it('moves the auto-decline minimum too', () => {
    const r = scaleBestOfferCents({ fromPriceCents: 1000, toPriceCents: 1500, autoAcceptCents: 800, minOfferCents: 600 });
    assert.deepEqual([r.autoAcceptCents, r.minOfferCents], [1200, 900]);
  });
  it('reports nothing to move when no threshold is set', () => {
    const r = scaleBestOfferCents({ fromPriceCents: 1000, toPriceCents: 1500 });
    assert.deepEqual([r.autoAcceptCents, r.minOfferCents], [null, null]);
    // …and a zero is "not set", not a floor of A$0.00 — that would auto-accept anything.
    assert.equal(scaleBestOfferCents({ fromPriceCents: 1000, toPriceCents: 1500, autoAcceptCents: 0 }).autoAcceptCents, null);
  });

  // AGENTS.md §15 applies to the floor as much as to the price.
  it('refuses to compute anything for a cut or a no-op', () => {
    for (const to of [1000, 900, 0]) {
      const r = scaleBestOfferCents({ fromPriceCents: 1000, toPriceCents: to, autoAcceptCents: 800 });
      assert.equal(r.autoAcceptCents, null, 'to=' + to);
      assert.equal(r.ratio, null);
    }
  });
  it('never lets rounding walk a floor downwards', () => {
    for (let from = 100; from <= 4000; from += 23) {
      for (const mult of [1.001, 1.01, 1.1, 1.4]) {
        const to = Math.round(from * mult);
        if (to <= from) continue;
        for (const frac of [0.5, 0.8, 0.95, 1]) {
          const cur = Math.round(from * frac);
          const r = scaleBestOfferCents({ fromPriceCents: from, toPriceCents: to, autoAcceptCents: cur });
          if (r.autoAcceptCents == null) continue;
          assert.ok(r.autoAcceptCents >= cur, `floor went down: ${cur} -> ${r.autoAcceptCents}`);
          assert.ok(r.autoAcceptCents <= to, `floor above list: ${r.autoAcceptCents} > ${to}`);
        }
      }
    }
  });
  it('keeps auto-accept at or above the auto-decline minimum, which eBay requires', () => {
    // Equal thresholds can cross on independent rounding; the result must still be a valid pair.
    const r = scaleBestOfferCents({ fromPriceCents: 333, toPriceCents: 397, autoAcceptCents: 333, minOfferCents: 333 });
    assert.ok(r.autoAcceptCents >= r.minOfferCents, JSON.stringify(r));
  });
});

describe('bestOfferScaling — the guardrail that unlocks Phase 5', () => {
  it('is OFF by default, so an auto-accept is still refused', () => {
    assert.equal(DEFAULT_GUARDRAILS.bestOfferScaling, false);
    const e = eligibleForReprice(listing({ bestOfferAutoAcceptCents: 800 }), identity());
    assert.equal(e.code, 'best_offer_auto_accept');
  });
  it('lets the listing through once the apply path can move the floor', () => {
    const e = eligibleForReprice(listing({ bestOfferAutoAcceptCents: 800 }), identity(), { bestOfferScaling: true });
    assert.equal(e.ok, true);
  });
});

// --- the target anchor: which competitor are we trying to beat? ---------------------------------
// Owner's rule: "we generally want to be one of, if not the cheapest seller... so we're always on the
// first page of results if someone searches for a card." The cluster anchor cannot deliver that. It
// undercuts the cheapest listing in the DENSEST band, and on a card with a cheap tail that band sits
// well above the front of the queue — measured on Forest of Vitality 109/088, whose cluster started
// at A$18.50 while five real AU listings sat between A$12.00 and A$14.50. Undercutting the cluster
// there would have moved a 7th-cheapest listing to 18th.
describe('anchorFor — cheapest_n keeps us at the front of the queue', () => {
  const withLow = (lowest, over = {}) => comps({ lowest, recommended: 18.48, ...over });

  it('undercuts the Nth cheapest, not the cluster', () => {
    // The real Forest of Vitality tail. N=3 → beat A$13.00 → A$12.99 → snaps to the A$12.98 ending.
    const a = anchorFor(withLow([12.00, 12.88, 13.00, 13.88, 14.50, 14.59]), { targetAnchor: 'cheapest_n', anchorN: 3 });
    assert.equal(a, 12.98);
  });
  it('defaults to cheapest_n at N=3', () => {
    assert.equal(DEFAULT_GUARDRAILS.targetAnchor, 'cheapest_n');
    assert.equal(DEFAULT_GUARDRAILS.anchorN, 3);
    assert.equal(anchorFor(withLow([12.00, 12.88, 13.00, 20.00])), 12.98);
  });
  it('still offers the cluster anchor for a fair-value read', () => {
    assert.equal(anchorFor(withLow([12.00, 12.88, 13.00]), { targetAnchor: 'cluster' }), 18.48);
  });

  // N=3 rather than N=1 is the whole robustness argument: one damaged card or mis-titled listing
  // must not set the shelf price for the entire store.
  it('a single lowball cannot drag the anchor down', () => {
    const withOutlier = anchorFor(withLow([0.99, 12.88, 13.00, 13.88]), { targetAnchor: 'cheapest_n', anchorN: 3 });
    assert.equal(withOutlier, 12.98, 'the A$0.99 outlier is absorbed, not followed');
    // …whereas chasing the very bottom does follow it, which is why N=1 is not the default.
    assert.equal(anchorFor(withLow([0.99, 12.88, 13.00]), { targetAnchor: 'cheapest_n', anchorN: 1 }), 0.98);
  });

  it('never indexes past a short list', () => {
    assert.equal(anchorFor(withLow([9.00, 11.00]), { targetAnchor: 'cheapest_n', anchorN: 3 }), 10.98, 'falls to the last one available');
    assert.equal(anchorFor(withLow([]), { targetAnchor: 'cheapest_n' }), null);
    assert.equal(anchorFor({ matched: true }, { targetAnchor: 'cheapest_n' }), null, 'comps with no tail at all');
    assert.equal(anchorFor(null, {}), null);
  });
  it('ignores junk prices in the tail', () => {
    assert.equal(anchorFor(withLow([0, -5, 12.88, 13.00, 13.88]), { targetAnchor: 'cheapest_n', anchorN: 3 }), 13.48);
  });
});

describe('decideReprice — the anchor drives the verdict', () => {
  // The three real survivors of the AU-only scan. Under the cluster anchor all three were raises that
  // would have dropped them 11-20 places down the price-sorted results; under cheapest_n they hold.
  const live = [
    { name: 'Forest of Vitality', ours: 1498, lowest: [12.00, 12.88, 13.00, 13.88, 14.50], rec: 18.48 },
    { name: "Boss's Orders", ours: 1498, lowest: [13.25, 14.00, 14.00, 14.98, 14.99], rec: 18.48 },
    { name: 'Togekiss', ours: 1248, lowest: [9.00, 11.00, 11.59, 12.00, 12.50], rec: 14.98 },
  ];
  for (const c of live) {
    it('holds ' + c.name + ' — already inside the cheapest three', () => {
      const r = decide({
        listing: listing({ priceCents: c.ours, postageCents: 0 }),
        comps: comps({ lowest: c.lowest, recommended: c.rec }),
      });
      assert.equal(r.verdict, 'hold', JSON.stringify(r));
      assert.equal(r.code, 'above_market');
    });
    it('raises ' + c.name + ' under the old cluster anchor (what we are moving away from)', () => {
      const r = decide({
        listing: listing({ priceCents: c.ours, postageCents: 0 }),
        comps: comps({ lowest: c.lowest, recommended: c.rec }),
        guardrails: { targetAnchor: 'cluster' },
      });
      assert.equal(r.verdict, 'raise');
    });
  }

  it('raises when we really are under the third cheapest', () => {
    // Cheapest three are A$9.00 / A$11.00 / A$11.59 and we are at A$6.98 — beat A$11.59 to A$11.58.
    const r = decide({
      listing: listing({ priceCents: 698, postageCents: 0 }),
      comps: comps({ lowest: [9.00, 11.00, 11.59, 12.00], recommended: 14.98 }),
    });
    assert.equal(r.verdict, 'raise');
    assert.equal(r.toPriceCents, 948, 'A$11.58 target, capped to +40% (A$9.77), snapped down to A$9.48');
  });

  it('subtracts our postage from the anchor, same as any other target', () => {
    const r = decide({
      listing: listing({ priceCents: 500, postageCents: 300 }),
      comps: comps({ lowest: [12.00, 12.88, 13.00], recommended: 18.48 }),
    });
    // Beat A$13.00 delivered → A$12.98, minus our A$3.00 postage → A$9.98 list, then the +40%
    // cap on a A$5.00 listing pulls it to A$7.00 and the snap lands it on A$6.98.
    assert.equal(r.evidence.targetDeliveredCents, 1298);
    assert.equal(r.toPriceCents, 698);
    assert.equal(r.capped, true);
  });

  it('declines rather than guesses when the tail is missing entirely', () => {
    const r = decide({ comps: comps({ lowest: [], recommended: 18.48 }) });
    assert.equal(r.verdict, 'decline');
    assert.equal(r.code, 'no_anchor');
  });
});
