// lib/deals.mjs — is this buyer asking for a deal, and what kind?
//
// Why this exists: the store turned Best Offer off and moved to three buyer-paid postage bands, so a
// buyer who wants a keener price, or one lot of postage on five cards, has no button to press. All
// they can do is ask — in a message, or by pressing "Request total" in the cart — and until now
// neither reached anybody. pollMemberMessages already stores every AskSellerQuestion, but its only
// consumer is maybeHandleReply, which fires solely for a KNOWN buyer with a PRIOR sent message. A
// pre-sale question from a stranger is written to the table and nothing happens: no alert, no card,
// no queue. That is the hole this closes.
//
// TWO HALVES. The first is detection — does this message read like an ask. The second is the money: one
// lot of postage for a whole quote, and what a person needs on screen to type a discount into. They
// live together because they are the same feature and neither is useful alone.
//
// PURE: no fs, no fetch, no DOM, no DB. Importable by Vite plugins, Node harnesses and tests alike,
// which is what lets the classifier be exercised over a corpus, and the money exercised over every
// band combination, without a database behind either.
import { bandForListing, shippingOf, money } from './shipping-bands.mjs';
// isSlabCondition is REUSED rather than re-spelled (GR6): it is the same test the description builder
// applies, and listing-copy.mjs imports nothing but shipping-bands.mjs, so it costs no purity.
import { isSlabCondition } from './listing-copy.mjs';
//
// HIGH RECALL ON PURPOSE. Every hit is a proposal for a human, never an action — nothing here sends,
// prices or commits anything. A false positive costs a glance at a card that says "probably not a deal
// ask"; a false negative is a buyer who asked for a bundle and was ignored, which is a lost sale and a
// rude shop. So the rules lean towards firing, and the tests pin the specific phrases that must NOT.

// ---------------------------------------------------------------------------
// The false friends, and why each is worth a rule rather than a hope
// ---------------------------------------------------------------------------
// Three words carry almost all the risk, because each is ordinary English in this shop's inbox:
//
//   "total"  — "what's the total weight", "is this the total print run", "the total number printed".
//              Card buyers ask about print runs constantly. A bare /total/ would fire on all of them.
//   "offer"  — "do you offer tracking?", "do you offer returns?". With Best Offer switched off, this
//              is now the ONLY sense of the word a buyer is likely to mean.
//   "best"   — "what's the best way to ship this?", "best sleeve for this card?".
//
// So none of the three is ever matched alone: each needs a neighbour that makes the money sense the
// only reading. That is the whole design of the rule list below.

const rule = (name, re) => ({ name, re });

// A buyer asking to pay LESS for the cards themselves.
const DISCOUNT_RULES = [
  rule('best_price', /\bbest\s+(?:price|offer|deal)\b/i),
  rule('best_you_can_do', /\bbest\s+(?:you|u)\s+(?:can|could)\s+do\b/i),
  rule('discount', /\bdiscount(?:s|ed|ing)?\b/i),
  rule('deal', /\b(?:a|any|the|some)\s+deals?\b|\bdeals?\s+(?:on|for)\b|\bdo\s+a\s+deal\b/i),
  rule('bundle', /\bbundl(?:e|es|ed|ing)\b/i),
  rule('how_much_for_lot', /\bhow\s+much\s+for\s+(?:the\s+)?(?:lot|both|all|these|them)\b/i),
  rule('would_you_take', /\bwould\s+(?:you|u)\s+(?:take|accept|consider|do)\b/i),
  rule('take_amount', /\b(?:take|accept)\s*\$?\s*\d+(?:\.\d{2})?\b/i),
  rule('cheaper', /\bcheap(?:er|est)\b/i),
  rule('knock_off', /\bknock\s+(?:.{0,12}\s)?off\b|\btake\s+.{0,12}\s?off\s+the\s+price\b/i),
  rule('price_drop', /\b(?:lower|drop|reduce|budge\s+on)\s+(?:the\s+)?price\b/i),
  // "better price" is how most of these actually arrive, and it is unambiguous — nobody asks for a
  // better price about anything but money. "best way to ship" cannot reach it: different adjective.
  rule('better_price', /\b(?:better|keener|sharper)\s+(?:price|deal)\b|\bprice\s+drop\b/i),
  // "offer" only in its money sense: something is SENT, MADE, ACCEPTED or PUT IN. Never bare, so
  // "do you offer tracking" cannot reach it.
  rule('offer_verb', /\b(?:send|make|making|accept|accepting|put\s+in|open\s+to)\s+(?:me\s+)?(?:an?\s+)?offers?\b|\boffers?\s+(?:accepted|considered)\b/i),
];

// A buyer asking to pay one lot of POSTAGE instead of several. Distinct from a discount because the
// answer is different: combining postage costs the shop nothing it has not already priced in, whereas
// a discount comes off the cards.
const POSTAGE_RULES = [
  rule('combine_postage', /\bcombin\w*\s+(?:the\s+)?(?:post|postage|shipping|ship|freight|delivery)\w*\b/i),
  rule('postage_combined', /\b(?:post|postage|shipping|delivery)\s+combin\w*\b/i),
  rule('one_postage', /\b(?:one|single|1)\s+(?:lot\s+of\s+)?(?:post|postage|shipping)\b/i),
  rule('ship_together', /\b(?:ship|post|send)\s+(?:them|these|it|the\s+\w+)?\s*(?:all\s+)?together\b|\bin\s+(?:the\s+)?(?:one|same)\s+(?:parcel|satchel|envelope|package)\b/i),
  // A short gap is allowed before the "for", because the natural phrasing puts a verb in it — "what
  // would postage BE for all 4 cards". Bounded to one clause (no . ? !) so it cannot reach across two
  // unrelated sentences and invent a match out of two halves that were never together.
  rule('postage_on_multiple', /\b(?:post|postage|shipping)\b[^.?!]{0,14}?\b(?:on|for)\s+(?:both|all|multiple|several|the\s+lot|\d+\s*(?:cards?|items?))\b/i),
  // "total" only where it is being REQUESTED or SENT — never bare, so print-run questions cannot reach
  // it. This is also the exact phrase eBay's own cart button uses ("Request total from seller"), which
  // is what a buyer copies into a message when the button is not offered.
  rule('request_total', /\b(?:request|send|sent|sending|get|give|work\s+out|calculate)\w*\s+(?:me\s+)?(?:an?\s+|the\s+|a\s+)?(?:combined\s+|total\s+)?(?:total|invoice)\b/i),
  rule('total_for_lot', /\btotal\s+(?:for|on)\s+(?:the\s+)?(?:lot|both|all|these|them|\d+)\b/i),
  rule('invoice', /\binvoice\b/i),
];

/**
 * classifyDealAsk(subject, body) → { ask, kind, matched }
 *
 *   ask     — boolean, did anything fire
 *   kind    — 'discount' | 'combined_postage' | 'both' | null
 *   matched — the rule NAMES that fired, so a card can say WHY it was flagged and a false positive is
 *             debuggable without re-running the regexes by hand
 *
 * Subject and body are read as one blob. eBay puts a lot of the intent in the subject line ("Bundle
 * deal?") and sometimes leaves the body near-empty, so scoring them apart would only lose signal.
 */
export function classifyDealAsk(subject, body) {
  const text = normaliseForMatch(subject, body);
  if (!text) return { ask: false, kind: null, matched: [] };
  const discount = DISCOUNT_RULES.filter((r) => r.re.test(text)).map((r) => r.name);
  const postage = POSTAGE_RULES.filter((r) => r.re.test(text)).map((r) => r.name);
  const kind = discount.length && postage.length ? 'both'
    : discount.length ? 'discount'
      : postage.length ? 'combined_postage'
        : null;
  return { ask: !!kind, kind, matched: [...discount, ...postage] };
}

/**
 * One lowercase blob from a subject and a body, with the parts that would cause false matches removed.
 *
 * QUOTED HISTORY IS STRIPPED. eBay threads quote the previous message inline, so our own dispatch note
 * — which the post-sale copy has always used to invite bundle deals — would come back quoted in every
 * single reply and match `bundle` forever. Classifying our own words as the buyer's ask would turn
 * every thank-you into a deal request. Lines beginning with `>` and everything after eBay's own
 * separators go.
 */
export function normaliseForMatch(subject, body) {
  const raw = [subject || '', body || ''].join('\n');
  const cut = raw
    .split(/\n-{2,}\s*original message\s*-{2,}|\n_{5,}|\bon .{0,40}wrote:/i)[0]
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
  return cut.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Exported for the test harness, so a corpus test can report which rule is over-firing rather than
// only that something did.
export const DEAL_RULE_NAMES = [...DISCOUNT_RULES, ...POSTAGE_RULES].map((r) => r.name);

// ===========================================================================================
// The money
// ===========================================================================================
// Everything below is integer cents (GR3) and pure. It COMPUTES a quote; it never decides one — the
// discount is a number the owner types, because live pricing beats estimated pricing (GR4) and a model
// guessing what a card is worth to this buyer is exactly the kind of authority this repo refuses to
// hand a machine.


/** A named refusal, so a caller can branch on `code` and a card can print `message` verbatim. */
function refuse(code, message) { return { ok: false, code, message }; }

/**
 * Which postage band a single quote line needs.
 *
 * TWO DECISIONS ARE BAKED IN HERE, both in the safe direction, both easy to get backwards:
 *
 * 1. THE BAND FOLLOWS THE LINE TOTAL, not the unit price. A line of 10 × $20 cards is $200 of goods in
 *    one parcel; billing its postage off $20 would send $200 untracked. The band exists to protect
 *    what is in the envelope, and what is in the envelope is unit × quantity. (Every listing this tool
 *    publishes is quantity 1, so this only bites on a lot or a multi-quantity hand-made listing — which
 *    is precisely the case nobody would notice going wrong.)
 *
 * 2. A SLAB IS READ OFF THE TITLE. deal_lines has no condition column, and minBandForSlab exists
 *    because a graded card never travels untracked whatever it is worth. isSlabCondition is the same
 *    test the description builder uses, reused rather than re-spelled (GR6) — buildTitle puts the grade
 *    token in the title, so "… PSA 10 GEM MINT" is detectable and "Special Illustration Rare" is not a
 *    false positive.
 */
export function lineBand(line, shipping) {
  const qty = Math.max(1, Math.round(Number(line?.quantity) || 1));
  const unit = Number(line?.unit_price_cents);
  if (!Number.isFinite(unit) || unit <= 0) return null;
  const slab = isSlabCondition(line?.title || '');
  return bandForListing(Math.round(unit) * qty, shipping, { slab });
}

/**
 * ONE lot of postage for a whole quote: the MAX band cost across the lines.
 *
 * Never the sum — charging postage per line is the thing the buyer is asking us to stop doing, and the
 * reason eBay's own cart splits a mixed-band order into two or three groups (three distinct fulfilment
 * policies, one per band). Never the min, and never a default: a $2 common beside a $500 card ships at
 * $15.20 once, which is the owner's rule in one sentence.
 *
 * REFUSES rather than guessing. bandForListing returns null for a price it cannot read, and quietly
 * treating that as band 0 is how a $500 card ends up on a $1.70 letter — the exact failure the band
 * module exists to prevent, and the same call publishListing makes before it will publish
 * (lib/channels/ebay-inventory-api.mjs).
 *
 * Returns { ok, postageCents, bandId, bandLabel, perLine } or a refusal.
 */
export function combinedPostageCents(lines, shipping) {
  const rows = Array.isArray(lines) ? lines : [];
  if (!rows.length) return refuse('no_lines', 'there are no lines to quote');
  const ship = shippingOf(shipping);
  const perLine = [];
  let best = null;
  for (const li of rows) {
    const band = lineBand(li, ship);
    if (!band) {
      return refuse('band_unresolved',
        `cannot work out the postage band for "${li?.title || li?.sku || li?.ebay_item_id || 'a line'}" — `
        + 'it has no readable price, so quoting one lot of postage would be a guess');
    }
    perLine.push({ sku: li.sku || null, title: li.title || null, bandId: band.id, costCents: band.costCents });
    if (!best || band.costCents > best.costCents) best = band;
  }
  return { ok: true, postageCents: best.costCents, bandId: best.id, bandLabel: best.label || best.id, perLine };
}

/**
 * Everything a person needs on screen to type a discount figure into, and nothing they don't.
 *
 * NO PROFIT FIGURE, deliberately. lib/fees.mjs models the AU BUYER-PROTECTION fee and says so at its
 * head; there is no seller final-value-fee model anywhere in this repo. A "profit" number built from
 * the one fee we can compute would be confidently wrong in the direction that loses money, so the card
 * shows cost basis and lets a human do the subtraction they can actually justify (GR4).
 *
 * costBasis is optional and per-line ({ [sku]: cents }); an unknown one is reported as unknown rather
 * than assumed to be zero.
 */
export function dealSummary({ lines, shipping, costBasis } = {}) {
  const rows = Array.isArray(lines) ? lines : [];
  const post = combinedPostageCents(rows, shipping);
  if (!post.ok) return post;
  let subtotal = 0;
  let knownCost = 0, unknownCostLines = 0;
  for (const li of rows) {
    const qty = Math.max(1, Math.round(Number(li?.quantity) || 1));
    subtotal += Math.round(Number(li?.unit_price_cents) || 0) * qty;
    const c = costBasis ? costBasis[li?.sku] : undefined;
    if (Number.isFinite(c)) knownCost += Math.round(c) * qty; else unknownCostLines++;
  }
  return {
    ok: true,
    lineCount: rows.length,
    subtotalCents: subtotal,
    postageCents: post.postageCents,
    bandId: post.bandId,
    bandLabel: post.bandLabel,
    perLine: post.perLine,
    // What the buyer would pay with no discount at all — the number the typed figure comes off.
    grossTotalCents: subtotal + post.postageCents,
    // Cost basis is reported with its own completeness, so a card can say "$41.00 across 3 of 4 lines"
    // rather than implying it knows the fourth is free.
    costBasisCents: unknownCostLines === rows.length ? null : knownCost,
    costBasisComplete: unknownCostLines === 0,
    unknownCostLines,
    // What one lot of postage actually saves this buyer versus eBay's own per-band grouping. The honest
    // comparison is against the SUM of the line bands, which is what their cart would have quoted.
    postageSavedCents: Math.max(0, post.perLine.reduce((n, l) => n + l.costCents, 0) - post.postageCents),
  };
}

/**
 * Check the figure the owner typed. REFUSALS are structural — a number eBay would reject, or one that
 * means something other than a discount. WARNINGS are judgement — a call the owner is allowed to make
 * and this code is not entitled to overrule.
 *
 * The split matters because there is deliberately no automatic pricing here. Refusing a discount that
 * merely looks generous would be this module quietly setting the shop's margin policy, which is the
 * owner's job (GR4); but sending a NEGATIVE discount, or one bigger than the goods, is not a decision
 * anybody made on purpose.
 *
 * Returns { ok, refusal?, warnings: [{code, message}], discountCents, totalCents }.
 */
export function checkDiscount(discountCents, summary, { costBasisCents = null } = {}) {
  const warnings = [];
  const d = Number(discountCents);
  if (!Number.isFinite(d)) return refuse('discount_not_a_number', 'the discount has to be a number');
  if (!Number.isInteger(d)) {
    // GR3. A fractional cent here becomes a rounded one in the XML, so the invoice would not match the
    // figure on screen — small, silent, and exactly the kind of drift that makes a buyer query a total.
    return refuse('discount_not_whole_cents', 'the discount has to be a whole number of cents');
  }
  if (d < 0) {
    // AdjustmentAmount is signed, and this code sends the NEGATION of this number. A negative here
    // would surface on the invoice as a SURCHARGE — the buyer charged extra for asking for a deal.
    return refuse('discount_negative', 'a negative discount would charge the buyer MORE than the listing price');
  }
  if (d === 0) return refuse('discount_zero', 'a zero discount is not worth an invoice — skip the request instead');

  const subtotal = Number(summary?.subtotalCents);
  if (!Number.isFinite(subtotal) || subtotal <= 0) return refuse('no_subtotal', 'the quote has no subtotal to discount');
  if (d > subtotal) {
    // Capped at the GOODS, not at the gross total. Discounting past the subtotal would mean the buyer
    // paying nothing for the cards and something for postage, or eBay rejecting the adjustment outright
    // — and either way it is a typo (a stray zero), not an intention.
    return refuse('discount_exceeds_subtotal',
      `${money(d)} is more than the ${money(subtotal)} of cards on this order`);
  }

  // --- judgement, not structure -------------------------------------------------------------------
  if (costBasisCents != null && Number.isFinite(costBasisCents)) {
    const net = subtotal - d;
    if (net < costBasisCents) {
      warnings.push({ code: 'below_cost',
        message: `${money(net)} for the cards is below what they cost you (${money(costBasisCents)}) — before any eBay or postage fees` });
    }
  }
  if (!summary?.costBasisComplete) {
    warnings.push({ code: 'cost_unknown',
      message: summary?.costBasisCents == null
        ? 'no cost basis is known for this order, so nothing here can tell you whether the discount clears it'
        : `cost is only known for some of the lines (${summary.unknownCostLines} missing)` });
  }
  const pct = Math.round((d / subtotal) * 100);
  if (pct >= 50) warnings.push({ code: 'large_discount', message: `that is ${pct}% off the cards` });

  return {
    ok: true,
    warnings,
    discountCents: d,
    // What the buyer is actually asked for. Postage is NOT discounted: it is a real cost the shop pays
    // Australia Post, and the concession the buyer asked for is already in there — one lot of it
    // instead of one per line.
    totalCents: subtotal - d + Number(summary.postageCents || 0),
  };
}

// Re-exported so a card or a route can format a figure without importing two modules to describe one
// quote. Same function shipping-bands uses for the postage sentence, so a card and a description can
// never render the same amount two ways.
export { money };
