// lib/repricer-decide.mjs — should this listing's price go up, and to what?
//
// PURE. No fetch, no db, no config read, no clock (`nowIso` is passed in). The scan does the I/O and
// this judges, mirroring evalHealth() in lib/heartbeat.mjs and clusterValue() in lib/comps.mjs. That
// split is what lets every guardrail have a test asserting the REFUSAL, which is where the money risk
// lives — a wrong "no" costs nothing, a wrong "yes" changes a real price.
//
// Three measured traps drive the shape of this file. Each has a fixture test:
//
//   1. comps are DELIVERED prices, our price is a LIST price.
//      lib/comps-singles.mjs computes `delivered = r.price + r.ship`, so `recommended`, `fair`,
//      `cheapest` and `clusterRange` are all competitor list PLUS competitor postage. Our
//      price_cents excludes postage. Setting list = recommended therefore lands our delivered price
//      above the cluster by exactly our postage while the maths believes it undercut by 1c —
//      silently, on every listing. Nothing in the repo parses our own postage yet, so an unknown
//      postage is a SKIP here rather than an assumption.
//
//   2. snapToEnding('down') turns a small raise into a CUT.
//      A$3.00 → target A$3.20 snaps to A$2.98. The snap moves down by up to 49c, which is larger
//      than a typical marginal uplift, so never_decrease must be re-checked AFTER the snap or the
//      scan emits decreases that applyReprice then rejects at the tap ("all my small raises fail").
//
//   3. buildNumberRe breaks on alt-art numbers.
//      buildNumberRe('039a/298') compiles to /\b0*39\b/, which fails to match the card's own title
//      while matching "Mewtwo 39 Promo" and "Charizard $39 bargain" — it excludes every correct comp
//      and admits wrong ones. parseCardTitle gets this right and reports confidence:'none', so that
//      is the gate: no identity, no comps, no proposal.
//
//   4. banded postage has NO fixed point, and re-resolving it oscillates forever.
//      Postage is a function of OUR price now ($1.70 / $8.26 / $15.20 by band), so "list = delivered
//      anchor − our postage" is circular. Solving it exactly has no solution at all for a delivered
//      anchor in [5169,5824] or [15825,16518] cents, and the obvious fix — recompute the band from the
//      tentative price, subtract again, repeat — does not terminate. Worked, at D=5500:
//        5500−170 = 5330 → that is band 2 → 5500−826 = 4674 → that is band 1 → 5330 → …
//      Because delivered(P) = P + cost(band(P)) is monotonically increasing, the answer is instead a
//      single descending scan (listPriceForDelivered in lib/shipping-bands.mjs). And because a raise
//      that CROSSES a band would change the buyer's postage, the fulfilment policy and the quoted
//      amount in the description — three writes this path cannot make — the raise is clamped at the
//      top of the band the listing is already in.
//
// AGENTS.md §15 is the invariant everything here serves: the system NEVER decreases a price.

import { snapToEnding, undercut } from './comps-singles.mjs';
import { bandForCost, listPriceForDelivered } from './shipping-bands.mjs';

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
const cents = (n) => Math.round(Number(n) * 100);

export const DEFAULT_GUARDRAILS = {
  minComparable: 8,
  minUpliftPct: 10,
  minUpliftCents: 100,
  requireReliable: true,
  requiredConfidence: 'medium',
  allowedModes: ['asking', 'sold'],   // 'sold' stays allowed so a future sold source needs no change here
  maxIncreasePct: 40,
  floorCents: 0,
  neverDecrease: true,
  // Which competitor to undercut: 'cluster' (cheapest in the densest band — a fair-value read) or
  // 'cheapest_n' (the Nth cheapest listing outright — stay on the first page of search results).
  targetAnchor: 'cheapest_n',
  anchorN: 3,
  // Third place keeps us on the first page; being CHEAPEST wins the click. When the top of the market
  // is bunched, third buys almost nothing — so if the anchor is within a few cents (cheap card) or a
  // few percent (dear card) of the cheapest listing, take the cheapest instead. Whichever of the two
  // is larger applies, which is what makes one rule work at A$3 and at A$300.
  beatCheapestWithinCents: 50,
  beatCheapestWithinPct: 5,
  // 'require' | 'advisory' | 'off'. A raise built only from asking prices has nothing behind it but
  // other sellers' hopes; 'require' refuses one that no real transaction seconds.
  corroboration: 'require',
  // How far above the best corroborating sale a target may sit. Asking markets legitimately run above
  // the last sale, so this is not zero — but it is what stopped A$44.98 on a card that sold at A$25.
  corroborationTolerancePct: 30,
  // Phase 5. OFF until the ReviseFixedPriceItem write has been proven against a real listing: with it
  // off, a Best Offer auto-accept is still a refusal, which is exactly today's behaviour.
  bestOfferScaling: false,
};

// Pick the delivered price this listing should undercut, per the configured anchor. Returns null when
// the comps cannot answer, which the caller turns into a decline rather than a guess.
//
// `cheapest_n` reads the raw low tail (comps.lowest) rather than any cluster summary. When fewer than
// N comps came back it falls to the LAST one available — with minComparable at 8 that cannot happen
// for a sane N, but a short list must never index past its end and silently produce undefined.
export function anchorFor(comps, guardrails = {}) {
  const g = { ...DEFAULT_GUARDRAILS, ...guardrails };
  if (!comps) return null;
  if (g.targetAnchor !== 'cheapest_n') return comps.recommended;

  // Prefer the flagged tail when the comps engine supplied one; fall back to the plain numbers so an
  // older stored comps object still works.
  const rows = Array.isArray(comps.lowestRows) && comps.lowestRows.length
    ? comps.lowestRows.filter((r) => r && r.delivered > 0)
    : (Array.isArray(comps.lowest) ? comps.lowest : []).filter((v) => v > 0).map((v) => ({ delivered: v, coupon: false }));
  if (!rows.length) return null;

  // A COUPONED listing is cheaper than its price by an amount eBay will not tell us. Dropping it is
  // the wrong instinct — removing a cheap competitor pushes the anchor UP. Measured on Sett - Brawler:
  // dropping the couponed row moved the 3rd-cheapest anchor from A$45.40 to A$46.48.
  //
  // So it is kept, and counted as a rival we must assume undercuts us. Each one consumes a slot in the
  // top N, and the anchor moves DOWN the clean list by that many places. On Sett that turns "beat the
  // 3rd cheapest" into "beat the 2nd cheapest of the priceable ones" — A$37.99 — which sits below our
  // A$38.98, so the raise correctly becomes a hold.
  const clean = rows.filter((r) => !r.coupon).map((r) => r.delivered);
  if (!clean.length) return null;                     // nothing we can actually price against
  const n = Math.max(1, Math.floor(g.anchorN || 1));
  const consumed = rows.filter((r) => r.coupon).length;
  const idx = Math.min(Math.max(0, n - 1 - consumed), clean.length - 1);
  let anchor = clean[idx];

  // Owner's rule: top three keeps us on the first page, but when the whole top of the market is
  // bunched, third place buys almost nothing and being CHEAPEST buys the click. If the gap between
  // the cheapest listing and the one we were going to beat is small — a few cents on a cheap card, a
  // few percent on a dear one — beat the cheapest instead, by the same one cent.
  const cheapestCents = Math.round(clean[0] * 100);
  const anchorCents = Math.round(anchor * 100);
  const within = Math.max(Math.round(g.beatCheapestWithinCents || 0), Math.round(cheapestCents * (g.beatCheapestWithinPct || 0) / 100));
  if (anchorCents - cheapestCents <= within) anchor = clean[0];

  return undercut(anchor);
}

const out = (verdict, code, extra = {}) => ({
  verdict, code,
  fromPriceCents: null, toPriceCents: null, upliftCents: null, upliftPct: null,
  capped: false, basis: null, evidence: null, reasons: [],
  ...extra,
});

// --- eligibility ------------------------------------------------------------------------------
// Exported separately so the scan can filter BEFORE spending a Browse call. On a store with
// auctions, sold-out rows and unparseable titles that is a real slice of the comps budget.
//
// Everything here is a property of the listing or its title — never of the market — so it can be
// decided offline.
// `bands` is the configured postage band table (lib/shipping-bands.mjs), passed separately from the
// guardrails because it is account config rather than a repricing rule. Omitted, the band checks are
// simply skipped and the flat postage model applies.
export function eligibleForReprice(listing = {}, identity = null, guardrails = {}, bands = null) {
  const g = { ...DEFAULT_GUARDRAILS, ...guardrails };
  if (!listing.listingId) return { ok: false, code: 'no_listing_id' };
  // Reserved for a Keeper's Run: the item is spoken for and its price is part of a commitment the
  // manifest publishes against, so moving it is not ours to do. This module is pure, so the caller
  // resolves the reservation and sets the flag — the mergeCardFacts pattern. See lib/runs-reserve.mjs.
  if (listing.reservedForRun) return { ok: false, code: 'reserved_for_run' };
  if (listing.state && listing.state !== 'active') return { ok: false, code: 'not_active' };
  if (listing.listingType && listing.listingType !== 'FixedPriceItem') {
    // An auction's price is the current bid, not an asking price; raising it is meaningless.
    return { ok: false, code: listing.listingType === 'Chinese' ? 'auction' : 'not_fixed_price' };
  }
  if (!(listing.priceCents > 0)) return { ok: false, code: 'no_price' };
  if (listing.currency && listing.currency !== 'AUD') return { ok: false, code: 'currency_mismatch' };
  if (listing.availableQty != null && listing.availableQty <= 0) return { ok: false, code: 'zero_qty' };
  // A multi-variation listing reports the LOWEST variation's price, and a revise needs a per-SKU
  // target. Nothing in the codebase reads Variations, so refuse rather than reprice the wrong thing.
  if (listing.isVariation) return { ok: false, code: 'multi_variation' };
  // Best Offer AUTO-ACCEPT is an ABSOLUTE amount fixed at publish. Raising the list price does not
  // move it, so a successful raise widens the discount (A$10 list / A$8 accept → A$15 list / A$8
  // accept turns a 20% floor into 47% off). Skip until Phase 5 moves the floors with the price.
  //
  // Best Offer being merely ENABLED is not that. The first scan found it on 7 of the first 10
  // listings, so refusing all of them refuses most of the store — and the risk it was standing in for
  // does not exist without a threshold: with no auto-accept, every offer comes to a human, and a
  // raise can only ever improve the anchor they answer from. Worst case on a listing that DOES have a
  // hidden auto-accept is a partly-ineffective raise; it can never sell below what the listing was
  // already willing to take, so this is bounded by today's price, not below it.
  //
  // MinimumBestOfferPrice (auto-DECLINE) is deliberately not a refusal. It stays where it is after a
  // raise, which only means offers between the old floor and the new price reach a human — stale,
  // never a loss.
  //
  // `bestOfferScaling` is Phase 5 lifting this refusal: with it on, the apply path moves the floor by
  // the same ratio as the price (scaleBestOfferCents) and reverts the whole write if eBay did not
  // take it. It is refused here rather than at the write so no comps budget is spent on a listing
  // this system has no way to price safely.
  if (listing.bestOfferAutoAcceptCents > 0 && !g.bestOfferScaling) return { ok: false, code: 'best_offer_auto_accept' };
  // Under a Promotions Manager markdown, StartPrice is the struck-through anchor rather than what the
  // buyer pays, and AU was-pricing rules care about that anchor.
  if (listing.discountPricing) return { ok: false, code: 'discount_pricing_active' };
  // Trap 1: we cannot convert a delivered target into a list price without knowing our own postage,
  // and guessing zero is how every listing ends up priced above the cluster.
  if (listing.postageCents == null) return { ok: false, code: 'postage_unknown' };
  // A listing THIS tool published should be on one of our banded policies. If its live postage matches
  // no band, something moved it — a policy edited in Seller Hub, a hand-fixed listing. Pretending
  // otherwise would clamp it to the wrong band ceiling, so say so instead.
  if (bands && listing.createdVia === 'tool' && !bandForCost(listing.postageCents, bands)) {
    return { ok: false, code: 'postage_off_band' };
  }
  // Trap 3: the comps precision filter keys on the collector number, so an unusable number means an
  // untrustworthy comp set. `numberSafe` is the scan's self-test — it builds the filter's own regex
  // from the number and checks it matches that number (see identifyListing). It is deliberately NOT
  // parseCardTitle's `confidence`: that also requires a resolved SET, which needs a per-game set list
  // the scan does not have, so it reads 'none' for perfectly good titles and would skip everything.
  if (!identity || !identity.number || identity.numberSafe !== true) {
    return { ok: false, code: 'title_unparseable' };
  }
  if (!identity.game) return { ok: false, code: 'unknown_game' };
  if (g.neverDecrease !== false && listing.priceCents <= 0) return { ok: false, code: 'no_price' };
  return { ok: true, code: null };
}

// --- the decision -----------------------------------------------------------------------------
// Ordering below is load-bearing and asserted by tests. In particular the never_decrease check runs
// TWICE — once on the computed target and again after the snap (trap 2).
export function decideReprice({ listing = {}, identity = null, comps = null, guardrails = {}, context = {} } = {}) {
  const g = { ...DEFAULT_GUARDRAILS, ...guardrails };
  const fromCents = listing.priceCents;

  // 1. eligibility — a `skip` means comps should never have been spent on this row at all.
  const elig = eligibleForReprice(listing, identity, g, (context && context.shippingBands) || null);
  if (!elig.ok) return out('skip', elig.code, { fromPriceCents: fromCents ?? null });

  // A proposal already open for this listing, or one applied moments ago, is not a fresh decision.
  // The mirror can move BACKWARDS after a successful reprice (GetMyeBaySelling is a search index and
  // lags the item record), so without this the scan re-proposes the raise it just made.
  if (context.openProposal) return out('skip', 'open_proposal', { fromPriceCents: fromCents });
  if (context.lastAppliedAt && context.cooldownHours > 0 && context.nowIso) {
    const ageH = (Date.parse(context.nowIso) - Date.parse(context.lastAppliedAt)) / 3600_000;
    if (Number.isFinite(ageH) && ageH < context.cooldownHours) {
      return out('skip', 'cooldown', { fromPriceCents: fromCents });
    }
  }

  // 2. do we trust the market read? A `decline` means comps ran and the answer is not usable —
  // deliberately a different verdict from `hold`, which means comps ran and the price is already
  // right. Collapsing the two makes a shadow-mode run unreadable.
  if (!comps || !comps.matched) return out('decline', 'no_comps', { fromPriceCents: fromCents });
  if (g.requireReliable && !comps.reliable) return out('decline', 'not_reliable', { fromPriceCents: fromCents, evidence: evidenceOf(comps) });
  if (!(comps.comparable >= g.minComparable)) return out('decline', 'too_few_comps', { fromPriceCents: fromCents, evidence: evidenceOf(comps) });
  if (Array.isArray(g.allowedModes) && comps.mode && !g.allowedModes.includes(comps.mode)) {
    return out('decline', 'mode_not_allowed', { fromPriceCents: fromCents, evidence: evidenceOf(comps) });
  }
  const rank = CONFIDENCE_RANK[String(comps.confidence || '').toLowerCase()];
  const need = CONFIDENCE_RANK[String(g.requiredConfidence || 'medium').toLowerCase()] ?? 1;
  if (!(rank >= need)) return out('decline', 'confidence_below_required', { fromPriceCents: fromCents, evidence: evidenceOf(comps) });

  // 3. WHICH competitor are we trying to beat?
  //
  //   cluster     — undercut the cheapest listing in the densest price band. A fair-value model.
  //   cheapest_n  — undercut the Nth cheapest listing outright. A "stay on page one" model.
  //
  // They diverge whenever a card has a cheap tail below the main band, which is most of them:
  // Forest of Vitality's cluster began at A$18.50 while five real listings sat between A$12.00 and
  // A$14.50, so the cluster anchor proposed a price that would have moved a 7th-cheapest listing to
  // 18th. N defaults to 3 rather than 1 so a single lowball — a damaged card, a mis-titled listing,
  // a seller clearing stock — cannot drag the whole shelf down with it.
  const anchorDelivered = anchorFor(comps, g);
  if (anchorDelivered == null) return out('decline', 'no_anchor', { fromPriceCents: fromCents, evidence: evidenceOf(comps) });

  // 4. The anchor is DELIVERED (competitor list + competitor postage). Convert to a LIST price by
  // removing OUR postage, which is the number ReviseInventoryStatus actually sets (trap 1).
  const targetDelivered = cents(anchorDelivered);
  if (!(targetDelivered > 0)) return out('decline', 'no_comps', { fromPriceCents: fromCents, evidence: evidenceOf(comps) });

  // Our OWN banded policies apply only to listings THIS tool published, and only while the live
  // postage still matches one of the configured band costs. A hand-made listing on a flat $9.95 parcel
  // policy keeps the simple subtraction, because its postage really IS independent of its price.
  const bands = (context && context.shippingBands) || null;
  const ourBand = (bands && listing.createdVia === 'tool') ? bandForCost(listing.postageCents, bands) : null;
  const banded = !!ourBand;

  let toCents = banded ? listPriceForDelivered(targetDelivered, bands) : targetDelivered - listing.postageCents;
  if (toCents == null) {
    // Even the cheapest band's postage eats the whole anchor. A DECLINE, not a skip: comps ran fine,
    // the answer is just unusable — the same distinction step 2 draws.
    return out('decline', 'postage_exceeds_anchor', { fromPriceCents: fromCents, evidence: evidenceOf(comps) });
  }

  // 5. a hard floor, if the owner set one
  if (g.floorCents > 0) toCents = Math.max(toCents, g.floorCents);

  // 5b. BAND CEILING. Crossing a band changes the buyer's postage AND the fulfilment policy AND the
  // amount the description quotes — three writes this path cannot make (ReviseInventoryStatus sends no
  // ShippingDetails at all, and a hand-made listing has no offer to update). So a raise stops at the
  // top of the band the listing is already in, and the proposal says so.
  //
  // Why the clamp is COMPLETE, not just a mitigation: it caps at ourBand.maxCents; the tool is up-only
  // and step 10 re-asserts toCents > fromCents AFTER the snap; fromCents is inside ourBand. So every
  // accepted proposal satisfies bandMin ≤ toCents ≤ bandMax and cannot leave the band in either
  // direction — snapToEnding('down') can drop up to 49c and still not fall out the bottom.
  // ⚠ That argument DEPENDS on never_decrease, which test/data/configs.test.mjs pins as a hard
  // invariant. Turning it off would silently break this reasoning.
  let bandCapped = false;
  if (banded && ourBand.maxCents != null && toCents > ourBand.maxCents) {
    toCents = ourBand.maxCents;
    bandCapped = true;
  }

  const evidence = evidenceOf(comps, {
    targetDeliveredCents: targetDelivered, ourPostageCents: listing.postageCents,
    band: ourBand ? ourBand.id : null, bandCapped,
    bandCeilingCents: bandCapped ? ourBand.maxCents : null,
  });
  const hold = (code) => out('hold', code, { fromPriceCents: fromCents, toPriceCents: toCents, basis: 'delivered', evidence });

  // 6. up-only. HOLD, never clamp to fromCents — clamping manufactures a +0% "raise" that is really
  // a no-op, and an up-only tool proposing no-ops is how the feed becomes noise.
  if (g.neverDecrease !== false && toCents <= fromCents) {
    return hold(toCents < fromCents ? 'above_market' : 'at_market');
  }

  // 7. is the move worth a decision? Both thresholds must clear — a 30% raise on a A$2 card is 60c.
  let upliftCents = toCents - fromCents;
  let upliftPct = (upliftCents / fromCents) * 100;
  if (upliftPct < g.minUpliftPct || upliftCents < g.minUpliftCents) return hold('uplift_below_threshold');

  // 8. cap a single run's move. Not a refusal — the capped raise is still worth making.
  let capped = false;
  const capCents = Math.floor(fromCents * (1 + g.maxIncreasePct / 100));
  if (toCents > capCents) { toCents = capCents; capped = true; }

  // 9. snap to the store's price endings, reusing the ONE implementation (GR9).
  const snapped = cents(snapToEnding(toCents / 100, 'down'));
  if (snapped > 0) toCents = snapped;

  // 10. RE-CHECK up-only after the snap (trap 2). snapToEnding moves down by up to 49c, so a raise
  // that cleared step 6 can land at or below where it started. Without this the scan emits cuts and
  // applyReprice rejects them at the tap, which reads to the owner as "my raises randomly fail".
  if (g.neverDecrease !== false && toCents <= fromCents) {
    return out('hold', 'snap_erased_uplift', { fromPriceCents: fromCents, toPriceCents: toCents, basis: 'delivered', evidence });
  }

  // Recompute after cap + snap so the reported uplift is the one actually being proposed.
  upliftCents = toCents - fromCents;
  upliftPct = (upliftCents / fromCents) * 100;
  // The snap can drop a marginal raise back under the threshold it only just cleared.
  if (upliftPct < g.minUpliftPct || upliftCents < g.minUpliftCents) return hold('uplift_below_threshold');

  // 11. LAST: does anything that actually transacted support this number?
  //
  // Deliberately at the end, against the price we would really send rather than the raw target — cap
  // and snap both move it, and corroborating a figure we are not going to use proves nothing. It is a
  // DECLINE, not a hold: the market read may be perfectly fine and merely unsupported, which is the
  // difference the shadow data needs to stay readable.
  const corr = corroborate({ targetCents: toCents, sources: context.corroborators || [], guardrails: g });
  evidence.corroboration = { mode: corr.mode, ceilingCents: corr.ceilingCents ?? null, agreedWith: corr.agreedWith ?? null, sources: corr.evidence };
  if (!corr.ok) {
    return out('decline', corr.code, { fromPriceCents: fromCents, toPriceCents: toCents, basis: 'delivered', evidence });
  }

  return {
    verdict: 'raise', code: null,
    fromPriceCents: fromCents, toPriceCents: toCents,
    upliftCents, upliftPct: Math.round(upliftPct * 10) / 10,
    capped, basis: 'delivered', evidence,
    uncorroborated: !!corr.uncorroborated, reasons: [],
  };
}

// The comps facts worth persisting on a price_check / showing on a card. Kept flat and JSON-safe.
function evidenceOf(comps, extra = {}) {
  if (!comps) return null;
  return {
    mode: comps.mode || null,
    confidence: comps.confidence || null,
    reliable: !!comps.reliable,
    comparable: comps.comparable ?? null,
    sampleSize: comps.sampleSize ?? null,
    cheapestCents: comps.cheapest != null ? cents(comps.cheapest) : null,
    fairCents: comps.fair != null ? cents(comps.fair) : null,
    clusterLoCents: comps.clusterRange && comps.clusterRange[0] != null ? cents(comps.clusterRange[0]) : null,
    clusterHiCents: comps.clusterRange && comps.clusterRange[1] != null ? cents(comps.clusterRange[1]) : null,
    query: comps.query || null,
    ...extra,
  };
}

// --- Phase 5: keep the Best Offer floors where the owner put them ---------------------------------
//
// Best Offer auto-accept is an ABSOLUTE amount fixed at publish, and it is set on 103 of 161 live
// listings — so refusing every listing that has one refuses two thirds of the store. The alternative
// is to move it with the price, which is what this computes.
//
// The owner chose a DISCOUNT, not a dollar figure: A$8 auto-accept on a A$10 listing means "I'll take
// 20% off". Raising to A$15 and leaving A$8 turns that into 47% off — the same intent, silently
// re-expressed as a much worse deal. Scaling by the price ratio is what preserves what they meant.
//
// Pure, and separated from the write so the arithmetic can be tested without eBay. Returns nulls for
// anything absent, which the builder then omits from the request.
export function scaleBestOfferCents({ fromPriceCents, toPriceCents, autoAcceptCents, minOfferCents } = {}) {
  const from = Math.round(Number(fromPriceCents) || 0);
  const to = Math.round(Number(toPriceCents) || 0);
  const none = { autoAcceptCents: null, minOfferCents: null, ratio: null };
  // Only ever scale UP, and only from a real starting price. A cut is not this system's business
  // (AGENTS.md §15), and a zero `from` would make the ratio infinite.
  if (!(from > 0) || !(to > from)) return none;
  const ratio = to / from;

  const one = (v) => {
    const cur = v == null ? null : Math.round(Number(v));
    if (cur == null || !(cur > 0)) return null;         // not set → nothing to move, and never invent one
    const scaled = Math.round(cur * ratio);
    // Up-only applies to the floor as much as to the price: rounding must never walk a threshold
    // down, and a floor above the new list price is nonsense eBay would reject anyway.
    return Math.min(to, Math.max(cur, scaled));
  };
  const autoAccept = one(autoAcceptCents);
  const min = one(minOfferCents);
  // eBay refuses an auto-accept below the auto-decline minimum. Independent rounding can cross them
  // when they started equal, so re-establish the order rather than let the write fail at eBay.
  const fixed = (autoAccept != null && min != null && autoAccept < min) ? min : autoAccept;
  return { autoAcceptCents: fixed, minOfferCents: min, ratio };
}

// --- corroboration: does anything except other sellers' hopes support this price? ------------------
//
// Every comp this system has is an ASKING price. eBay's sold-comps API is entitlement-gated and the
// keyset is not entitled (see lib/ebay-token.mjs), so the anchor is built entirely from what other
// sellers WANT. Asking prices of unsold inventory sit above the clearing price, and the gap widens
// with supply — measured on Sett - Brawler 164/298: eleven active AU listings asking A$34-47, last
// actual sale A$25.00, and the repricer proposed raising A$38.98 to A$44.98.
//
// So a raise now has to be seconded by something that reflects a real transaction. Sources are
// already-AUD integer cents; the caller decides which it can supply.
//
// The ceiling comes from the HIGHEST corroborator, not the lowest or the average. The question being
// asked is "does ANY independent source support this number", so one agreeing source is enough — and
// taking the highest keeps a stale or thin source from vetoing a price a better one endorses.
export function corroborate({ targetCents, sources = [], guardrails = {} } = {}) {
  const g = { ...DEFAULT_GUARDRAILS, ...guardrails };
  const mode = g.corroboration || 'require';
  const usable = (sources || []).filter((s) => s && s.cents > 0);
  const evidence = usable.map((s) => ({ name: s.name, cents: s.cents, at: s.at || null }));

  if (mode === 'off') return { ok: true, code: null, mode, evidence, ceilingCents: null };
  if (!usable.length) {
    // Nothing transacted to check against. In `require` that is a refusal — the whole point is that an
    // uncorroborated asking-price target is what produced the bad proposal.
    return mode === 'require'
      ? { ok: false, code: 'no_corroboration', mode, evidence, ceilingCents: null }
      : { ok: true, code: null, mode, evidence, ceilingCents: null, uncorroborated: true };
  }
  const best = usable.reduce((m, s) => (s.cents > m.cents ? s : m), usable[0]);
  const ceilingCents = Math.round(best.cents * (1 + (g.corroborationTolerancePct || 0) / 100));
  if (targetCents > ceilingCents) {
    return { ok: false, code: 'not_corroborated', mode, evidence, ceilingCents, agreedWith: null, best: best.name };
  }
  return { ok: true, code: null, mode, evidence, ceilingCents, agreedWith: best.name };
}
