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
// AGENTS.md §15 is the invariant everything here serves: the system NEVER decreases a price.

import { snapToEnding, undercut } from './comps-singles.mjs';

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
  if (g.targetAnchor === 'cheapest_n') {
    const low = Array.isArray(comps.lowest) ? comps.lowest.filter((v) => v > 0) : [];
    if (!low.length) return null;
    const n = Math.max(1, Math.floor(g.anchorN || 1));
    return undercut(low[Math.min(n, low.length) - 1]);
  }
  return comps.recommended;
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
export function eligibleForReprice(listing = {}, identity = null, guardrails = {}) {
  const g = { ...DEFAULT_GUARDRAILS, ...guardrails };
  if (!listing.listingId) return { ok: false, code: 'no_listing_id' };
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
  const elig = eligibleForReprice(listing, identity, g);
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
  let toCents = targetDelivered - listing.postageCents;

  // 5. a hard floor, if the owner set one
  if (g.floorCents > 0) toCents = Math.max(toCents, g.floorCents);

  const evidence = evidenceOf(comps, { targetDeliveredCents: targetDelivered, ourPostageCents: listing.postageCents });
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

  return {
    verdict: 'raise', code: null,
    fromPriceCents: fromCents, toPriceCents: toCents,
    upliftCents, upliftPct: Math.round(upliftPct * 10) / 10,
    capped, basis: 'delivered', evidence, reasons: [],
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
