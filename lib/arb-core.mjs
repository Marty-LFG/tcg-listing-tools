// lib/arb-core.mjs — the pure logic behind arbitrage.html and lib/arbitrage.mjs (the eBay AU →
// local-buyer arbitrage finder).
//
// Browser-safe ESM: no node imports, no DOM. The page loads it with `<script type="module">` and
// test/unit/arb-core.test.mjs imports it directly. One source, so a rule can never drift between
// "what the hits table shows" and "what the tests assert" — the same reason lib/runner-core.mjs
// exists for the batch runner.
//
// THE BUSINESS RULE. A local buyer pays BUYER_PCT (80%) of the TCGplayer MARKET price (USD) for a
// Near Mint raw card of the MATCHED printing, no questions asked. A listing is a hit when what the
// buyer pays, converted to AUD, clears what the card costs to land here by both an absolute and a
// percentage floor. Everything in this file is one of: turning a Browse row into a candidate,
// deciding whether it is plausibly THIS card in THIS condition, or doing the money maths.
//
// Money here is integer cents in the currency it arrived in (GR3): eBay AU rows are AUD, TCGplayer
// is USD, and the fx rate that joined them is carried on the result rather than baked in.
import { compsQueryFor } from './stock-games.mjs';
import { JUNK_RE, buildNumberRe, classifyLang } from './comps-singles.mjs';
import { shipOf } from './comps.mjs';
import { browseSearchUrl } from './ebay-links.mjs';
import { CATEGORY } from './ebay-vocab.mjs';
import { feeAU } from './fees.mjs';
import { printingsFor, pickPrinting, numKeys, DISAGREE_LO } from './runner-core.mjs';

// ---------------------------------------------------------------------------
// The eBay query
// ---------------------------------------------------------------------------

// Three structural filters, one literal. Fixed price (a Buy-It-Now the owner can act on tonight),
// located in Australia (the delivered price then has no international freight in it — the same
// finding lib/comps.mjs AU_ONLY is built on), and eBay's RAW condition id. That last one is a coarse
// gate: measured live 2026-09-12, a "PSA 10" listing came back under conditionId 4000, so the graded
// check below runs on the title regardless.
//
// Deliberately NO exclusion terms in the query itself (-psa, -lot): lib/ebay-query.mjs measured that
// any exclusion flips eBay from stemmed to literal matching and collapses recall. Every exclusion
// here is a post-filter.
export const ARB_FILTER = 'buyingOptions:{FIXED_PRICE},itemLocationCountry:AU,conditionIds:{4000}';

// Query wordings, measured 2026-09-12 on ten Obsidian Flames cards (see docs/ARBITRAGE_PLAN.md):
//   comps  — compsQueryFor verbatim: "Pokemon <name> <number> <set name>". Same strict-number recall
//            as the shorter wording, a fraction of the noise. THE DEFAULT.
//   short  — "Pokemon <name> <number>". Recalls more rows, but the extras were the WRONG card almost
//            every time (Mega Charizard X ex 223/193 for a 223/197 search) and on a common name the
//            200-row page fills with them.
//   slash  — "Pokemon <name> <number>/<printedTotal>". Same strict recall as comps, slightly fewer rows.
export const QUERY_MODES = ['comps', 'short', 'slash'];

// A pokemontcg.io card (as cached by lib/pkm-cards-cache.mjs) has `set: { name, printedTotal, id }`;
// a stored watch row carries the same facts flat. Accept both.
function setOf(card) {
  const s = (card && card.set) || {};
  return {
    id: s.id || card.set_id || null,
    name: s.name || card.set_name || '',
    printedTotal: s.printedTotal || card.printed_total || null,
    ptcgoCode: s.ptcgoCode || card.ptcgo_code || null,
  };
}

export function buildScanQuery(card, { queryMode = 'comps', limit = 100 } = {}) {
  const set = setOf(card);
  const number = String(card.number == null ? '' : card.number).trim();
  let q;
  if (queryMode === 'short') q = ['Pokemon', card.name, number].filter(Boolean).join(' ');
  else if (queryMode === 'slash') q = ['Pokemon', card.name, set.printedTotal ? number + '/' + set.printedTotal : number].filter(Boolean).join(' ');
  else q = compsQueryFor('pokemon', { name: card.name, set_name: set.name, language: 'EN' }, number);
  return { q, filter: ARB_FILTER, path: browseSearchUrl(q, { limit, categoryIds: CATEGORY.ccgSingles, filter: ARB_FILTER }) };
}

// ---------------------------------------------------------------------------
// Is this listing THIS card?
// ---------------------------------------------------------------------------

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The set, as sellers write it: the name ("Obsidian Flames"), the PTCGO code ("OBF"), and the set id
// with or without a zero pad ("sv3" / "SV03"). Any of them in the title is the set being named.
export function setMentionRe(card) {
  const set = setOf(card);
  const parts = [];
  if (set.name) parts.push(escapeRe(set.name).replace(/\\?\s+/g, '\\s*'));
  if (set.ptcgoCode) parts.push('\\b' + escapeRe(set.ptcgoCode) + '\\b');
  if (set.id) {
    const m = /^([a-z]+)0*(\d+)([a-z0-9]*)$/i.exec(set.id);
    parts.push(m ? '\\b' + escapeRe(m[1]) + '0*' + m[2] + escapeRe(m[3]) + '\\b' : '\\b' + escapeRe(set.id) + '\\b');
  }
  return parts.length ? new RegExp(parts.join('|'), 'i') : null;
}

// Two tiers, and the second exists for a measured reason. Matching on the bare collector number
// alone accepted "Mega Charizard X ex 223/193" for a 223/197 search — 18 of 39 rows on one card were
// a different, dearer card, which is exactly the shape that turns a false hit into a real purchase.
// So:
//   strict — the title carries "<number>/<printedTotal>": this card, no question.
//   set    — the title carries the bare number AND names the set ("Umbreon 130 Obsidian Flames").
// A bare number with no set mention is rejected. Secret rares (223/197) are strict like any other.
// A letter-prefixed number (TG01, SWSH039, GG12, SV001) is its own identity: the prefix is the
// subset. buildNumberRe would degrade one to its bare digits and match ANY card with that number, so
// these get a literal, zero-pad-tolerant pattern and count as strict — there is no "TG01/195" form
// for the slash tier to look for.
export function prefixedNumberRe(num) {
  const m = /^([A-Za-z]{1,6})0*(\d{1,4})([A-Za-z]?)$/.exec(String(num || '').trim());
  if (!m) return null;
  return new RegExp('\\b' + escapeRe(m[1]) + '\\s?0*' + m[2] + escapeRe(m[3]) + '\\b', 'i');
}

export function numberMatcher(card) {
  const set = setOf(card);
  const number = String(card.number == null ? '' : card.number).trim();
  const prefixed = prefixedNumberRe(number);
  if (prefixed) return { strict: prefixed, bare: null, set: setMentionRe(card) };
  return {
    strict: set.printedTotal ? buildNumberRe(number + '/' + set.printedTotal) : null,
    bare: buildNumberRe(number),
    set: setMentionRe(card),
  };
}

export function matchTier(title, matcher) {
  const t = String(title || '');
  if (matcher.strict && matcher.strict.test(t)) return 'strict';
  if (matcher.bare && matcher.bare.test(t) && matcher.set && matcher.set.test(t)) return 'set';
  return null;
}

// Things that share the collector number but are not the card the buyer is paying market for: stamped
// event promos, prerelease and staff prints, misprints. A stamped 125/197 sells for four times the
// plain one, and if it ever appeared cheap it would be for a reason the title is telling you.
export const VARIANT_RE = /\bstamp(?:ed)?\b|prize\s*pack|play!?\s*(?:pack|prize|promo)|pre-?release|\bstaff\b|build\s*&\s*battle|league\s*(?:promo|battle)|\bmisprint|\bmiscut|\bcrimp|\bink\s*error|\berror\s*card|\bcosmos?\s*holo\b/i;

// What JUNK_RE (lib/comps-singles.mjs, shared with the browser comps engine) does not cover but a
// buy-side scan meets: decks and tins that carry a headline card's number in the title.
export const EXTRA_JUNK_RE = /\bdeck\b|\btins?\b|\betb\b|\bblister\b|\bcode\s*card|\bonline\s*code|\bdigital\b|\bcollection\s*box|\bpremium\s*collection/i;

// Graded detection that does NOT trust eBay's condition id. lib/comps-singles.mjs isGraded returns
// "raw" as soon as it sees conditionId 4000, which is the right call for pricing a cluster and the
// wrong one here: the 4000 gate is already in the query filter, so every graded row that reaches
// this function came through it, and the title is the only thing left that knows.
export const GRADED_RE = /\b(?:psa|bgs|cgc|sgc|ace|tag|pcg|hga|gma)\b\s*\d|\bgraded\b|gem\s*mint|\bslab(?:bed)?\b|\bcert(?:ified)?\b\s*#?\d/i;
export function isGradedListing(row) {
  if (String(row.condId || '') === '2750') return true;
  return GRADED_RE.test((row.cond || '') + ' ' + (row.title || ''));
}

// ---------------------------------------------------------------------------
// Condition, from the title
// ---------------------------------------------------------------------------

// Browse item summaries carry NO condition descriptor for trading cards (measured: 0 of 50 AU rows on
// 2026-09-12), so the title is the whole signal. The buyer takes Near Mint and nothing else, so any
// stated grade below it rejects the row; a title that says nothing is ACCEPTED and chipped
// `cond unstated` — most AU listings say nothing, and excluding them would hide the market. The
// owner reads the photos before buying; this function only refuses what the seller has already
// admitted.
//
// Two traps, both measured on real titles:
//   · "120 HP" is a Pokémon stat, not Heavily Played. A bare "HP" adjacent to digits is stripped
//     BEFORE the grade test.
//   · "ex" is a card type ("Charizard ex"), never eBay's "Excellent". Only the full word counts.
// The stat is digits then HP ("330 HP") or HP then digits ("HP 330"). A collector number is NOT a
// stat even when it sits beside the word: "125/197 HP" is a heavily played card, so digits that
// belong to a slash-number (preceded or followed by "/") are left alone and the bare HP then counts.
const HP_STAT_RE = /(?<![\/\d])\b\d+\s*hp\b|\bhp\s*\d+(?![\d\/])/gi;
// "NM no whitening", "no edge wear", "free of scratches" — the seller is asserting the ABSENCE of the
// flaw, and a rule that only sees the noun would read it as the flaw. Stripped before the grades run.
const NEGATED_FLAW_RE = /\b(?:no|nil|zero|without|free\s+(?:of|from))\s+(?:visible\s+|noticeable\s+|major\s+|any\s+)?(?:edge\s+|corner\s+|surface\s+)?(?:wear|scratch(?:es)?|scratching|whitening|creas(?:e|es|ing)|damage|marks?|dents?|bends?|dings?|flaws?|defects?)\b/gi;
const COND_RULES = [
  // [class, regex] — first match wins. The two-word grades are tested BEFORE the bare "played", or
  // "lightly played" would fall through to the played rule and be recorded as moderately played.
  ['dmg', /\bdamaged?\b|\bdmg\b|\bcreas(?:e|ed|ing)\b|\bwater\s*damage|\bbent\b|\bpoor\b|\bwell[\s-]*loved\b|\btorn\b|\bwritten\s*on\b|\bink\s*mark/i],
  ['hp', /\bheav(?:il)?y[\s-]*played\b|\bhp\b/i],
  ['lp', /\blight(?:ly)?[\s-]*played\b|\blp\b|\bwhitening\b|\bscratch(?:es|ed)?\b|\bedge\s*wear\b|\bwear\b/i],
  ['mp', /\bmod(?:erately)?[\s-]*played\b|\bmp\b|(?<!un)\bplayed\b/i],
];
// "Excellent" and "Very Good" are grades below NM on eBay's structured scale — but that scale is not
// in the title, and in an AU title these words are nearly always a casual seller's enthusiasm. The
// casual seller is also the likeliest source of an underpriced listing, so the row is ACCEPTED and
// chipped `says excellent` rather than dropped; the owner reads the photos either way.
const VAGUE_RE = /\bexcellent\b|\bvery\s*good\b|\bgreat\s*cond/i;
const NM_RE = /\bnm\b|\bnear[\s-]*mint\b|\bmint\b|\bm\/nm\b|\bnm\/m\b|\bpack[\s-]*fresh\b/i;

export function classifyTitleCondition(title, condDescriptors) {
  // A descriptor, when eBay ever sends one on a summary, is the seller's structured answer and beats
  // whatever the title says. Accepts the display text ("Card Condition" / "Near Mint or Better").
  const desc = Array.isArray(condDescriptors) ? condDescriptors.find((d) => /card\s*condition/i.test(d && d.name || '')) : null;
  if (desc && Array.isArray(desc.values) && desc.values.length) {
    const v = desc.values.map((x) => (x && (x.content || x.value || x)) + '').join(' ');
    if (/near\s*mint/i.test(v)) return { cls: 'nm', source: 'descriptor', evidence: v };
    if (/excellent/i.test(v)) return { cls: 'lp', source: 'descriptor', evidence: v };
    if (/very\s*good/i.test(v)) return { cls: 'mp', source: 'descriptor', evidence: v };
    if (/poor/i.test(v)) return { cls: 'dmg', source: 'descriptor', evidence: v };
  }
  const t = String(title || '').replace(HP_STAT_RE, ' ').replace(NEGATED_FLAW_RE, ' ');
  for (const [cls, re] of COND_RULES) {
    const m = re.exec(t);
    if (m) return { cls, source: 'title', evidence: m[0] };
  }
  if (NM_RE.test(t)) return { cls: 'nm', source: 'title', evidence: (NM_RE.exec(t) || [])[0] };
  const v = VAGUE_RE.exec(t);
  if (v) return { cls: 'vague', source: 'title', evidence: v[0] };
  return { cls: 'unstated', source: 'none', evidence: null };
}

// ---------------------------------------------------------------------------
// Printing, from the title
// ---------------------------------------------------------------------------

// What the seller says about the finish. `reverse` beats `holo` because every reverse holo is also
// described as holo; `normal` is any explicit non-foil word. Null is the common case and it is a
// real answer, not a gap — see scoringMarket for what it costs.
export function titleFinish(title) {
  const t = String(title || '');
  if (/\brev(?:erse)?\b|\brh\b/i.test(t)) return 'reverse';
  // "Regular Holo" / "Standard Holo" / "Normal Holo" is how sellers say NOT the reverse — a holo. It
  // has to be read before the bare non-holo words, or the plain holofoil printing of every rare
  // would be classed as its own opposite.
  if (/\b(?:regular|standard|normal|plain)[\s-]*holo/i.test(t)) return 'holo';
  if (/\bnon[\s-]?(?:holo|foil)\b|\bnonholo\b|\bnonfoil\b|\bnormal\b|\bregular\b/i.test(t)) return 'normal';
  if (/\bholo(?:foil|graphic)?\b|\bfoil\b/i.test(t)) return 'holo';
  return null;
}

const finishOfKey = (key) => (/reverse/i.test(key) ? 'reverse' : /holo|foil/i.test(key) ? 'holo' : 'normal');

// Which market price a listing is scored against, given the printing the operator asked for.
//
// A title that says "Reverse Holo" is that printing. A title that says nothing could be any printing
// the card comes in — and on a common with a US$0.20 normal and a US$3 reverse, scoring an unmarked
// listing at the reverse price would call every cheap normal a bargain. So an ambiguous listing is
// scored against the LOWEST market among the printings its title does not rule out, and chipped
// `printing?`. The cheap direction is the honest one: a hit that survives it is a hit whichever
// printing turns up in the envelope.
//
// Returns null when the title rules out the wanted printing altogether (asked for reverse, title
// says non-holo) — the caller drops the row as a finish mismatch.
export function scoringMarket(printings, wantedKey, title) {
  const list = (printings || []).filter((p) => p && p.key);
  if (!list.length) return null;
  const signal = titleFinish(title);
  const wanted = list.find((p) => p.key === wantedKey) || null;
  let candidates;
  if (signal === 'reverse') candidates = list.filter((p) => finishOfKey(p.key) === 'reverse');
  else if (signal === 'holo') candidates = list.filter((p) => finishOfKey(p.key) !== 'normal');
  else if (signal === 'normal') candidates = list.filter((p) => finishOfKey(p.key) === 'normal');
  else candidates = list.slice();
  if (!candidates.length) return null;
  if (wanted && !candidates.some((p) => p.key === wanted.key)) return null;
  if (candidates.length === 1) return { key: candidates[0].key, marketUsd: candidates[0].marketUsd, ambiguous: false };
  // Several printings possible. If any of them has no market figure the listing cannot be scored
  // honestly — the unpriced one might be the cheap one — so marketUsd is null and the caller drops
  // the row rather than scoring it against a printing it may not be (GR4).
  const priced = candidates.filter((p) => typeof p.marketUsd === 'number' && p.marketUsd > 0);
  if (priced.length < candidates.length) return { key: (wanted || candidates[0]).key, marketUsd: null, ambiguous: true };
  const lowest = priced.reduce((a, b) => (b.marketUsd < a.marketUsd ? b : a));
  return { key: lowest.key, marketUsd: lowest.marketUsd, ambiguous: true };
}

// ---------------------------------------------------------------------------
// One Browse row → one candidate
// ---------------------------------------------------------------------------

// A sibling of lib/comps.mjs rowFromAsk rather than a call to it: that parser deliberately keeps no
// listing identity (a cluster does not need one), and this tool is nothing WITHOUT one — every hit
// has to open the listing it came from. Same field reads for everything they share.
export function rowFromBrowse(it) {
  const price = it && it.price && parseFloat(it.price.value);
  if (!(price > 0)) return null;
  const so = (it.shippingOptions || [])[0];
  const seller = it.seller || {};
  const fbPct = seller.feedbackPercentage != null ? parseFloat(seller.feedbackPercentage) : null;
  const fbScore = seller.feedbackScore != null ? +seller.feedbackScore : null;
  return {
    itemId: it.itemId || null,
    legacyItemId: it.legacyItemId || null,
    url: it.itemWebUrl || null,
    image: (it.image && it.image.imageUrl) || (it.thumbnailImages && it.thumbnailImages[0] && it.thumbnailImages[0].imageUrl) || null,
    title: it.title || '',
    price,
    currency: (it.price && it.price.currency) || null,
    ship: shipOf(it.shippingOptions),
    shipCurrency: (so && so.shippingCost && so.shippingCost.currency) || null,
    loc: (it.itemLocation && it.itemLocation.country) || '?',
    cond: it.condition || '',
    condId: String(it.conditionId || ''),
    condDescriptors: Array.isArray(it.conditionDescriptors) ? it.conditionDescriptors : null,
    seller: seller.username || null,
    sellerFbPct: isFinite(fbPct) ? fbPct : null,
    sellerFbScore: isFinite(fbScore) ? fbScore : null,
    auction: Array.isArray(it.buyingOptions) && it.buyingOptions.indexOf('AUCTION') >= 0,
    bestOffer: Array.isArray(it.buyingOptions) && it.buyingOptions.indexOf('BEST_OFFER') >= 0,
    // A coupon EXISTS but its value is not in the API (lib/comps.mjs rowFromAsk explains the
    // measurement). So the price is an upper bound and the profit a lower bound: kept, and chipped.
    coupon: it.availableCoupons === true,
    listedAt: it.itemCreationDate || it.itemOriginDate || null,
  };
}

// The gate, one reason per row so the scan can say "87 rows → 12 kept: 30 graded, 25 wrong number…"
// instead of going quiet. Order is cheapest-first and does not change the answer.
//
// ctx: { matcher, printings, wantedKey, excludeSeller, sellerMinPct, sellerMinScore }
export function filterListing(row, ctx) {
  if (!row) return { ok: false, reason: 'unparsed' };
  if (row.auction) return { ok: false, reason: 'auction' };
  if (row.loc !== 'AU') return { ok: false, reason: 'not_au' };
  if (row.currency && row.currency !== 'AUD') return { ok: false, reason: 'currency' };
  if (ctx.excludeSeller && row.seller && row.seller.toLowerCase() === String(ctx.excludeSeller).toLowerCase()) return { ok: false, reason: 'own_listing' };
  // No postage quote means no delivered price. These are the rows the proxy's postcode header exists
  // for (vite.config.js ebayProxy), and the ones that are left are typically the dear "contact for
  // postage" listings. Counted, never guessed at as free.
  if (row.ship == null) return { ok: false, reason: 'ship_unknown' };
  if (isGradedListing(row)) return { ok: false, reason: 'graded' };
  const title = row.title || '';
  if (JUNK_RE.test(title) || EXTRA_JUNK_RE.test(title)) return { ok: false, reason: 'junk' };
  if (VARIANT_RE.test(title)) return { ok: false, reason: 'variant' };
  const tier = ctx.matcher ? matchTier(title, ctx.matcher) : 'strict';
  if (!tier) return { ok: false, reason: 'number' };
  if (classifyLang(title) !== 'en') return { ok: false, reason: 'lang' };
  const cond = classifyTitleCondition(title, row.condDescriptors);
  if (cond.cls !== 'nm' && cond.cls !== 'unstated' && cond.cls !== 'vague') return { ok: false, reason: 'cond_' + cond.cls, cond };
  const market = ctx.printings ? scoringMarket(ctx.printings, ctx.wantedKey, title) : null;
  if (ctx.printings && !market) return { ok: false, reason: 'finish' };
  // A floor is a floor: a row that carries no seller figures at all cannot clear it. (eBay sends a
  // seller block on every summary measured so far; this is for the day it does not.)
  if (ctx.sellerMinPct != null && ctx.sellerMinPct > 0 && !(row.sellerFbPct != null && row.sellerFbPct >= ctx.sellerMinPct)) return { ok: false, reason: 'seller_fb' };
  if (ctx.sellerMinScore != null && ctx.sellerMinScore > 0 && !(row.sellerFbScore != null && row.sellerFbScore >= ctx.sellerMinScore)) return { ok: false, reason: 'seller_fb' };
  return { ok: true, tier, cond, market };
}

// ---------------------------------------------------------------------------
// The money
// ---------------------------------------------------------------------------

export const toCents = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100));

// Landed cost is price + postage + eBay AU's buyer-protection fee (lib/fees.mjs, the one home for
// that maths — the owner pays it as the buyer). On an A$50 card the fee is ~A$3.70, so leaving it
// out would call a 7% loss a break-even. `feeMode: 'none'` exists because two live AU listing pages
// showed no fee line on 2026-09-12 (docs/ARBITRAGE_PLAN.md); the switch is a settings edit, and
// the fee is carried as its own figure so the page can show what it assumed.
//
// Margin is RETURN ON OUTLAY (profit / delivered), not profit / sale — the question is "what does
// each dollar tied up in this envelope come back as", and a 15% floor means 15% on the money spent.
export function hitMaths({ priceCents, shipCents, marketUsdCents, fx, buyerPct, feeMode = 'feeAU' }) {
  const price = +priceCents || 0, ship = +shipCents || 0;
  const feeCents = feeMode === 'none' ? 0 : Math.round(feeAU(price / 100) * 100);
  const deliveredCents = price + ship + feeCents;
  const marketAudCents = Math.round((+marketUsdCents || 0) * fx);
  const buyerAudCents = Math.round((+marketUsdCents || 0) * fx * buyerPct);
  const profitCents = buyerAudCents - deliveredCents;
  return {
    feeCents, deliveredCents, marketAudCents, buyerAudCents, profitCents,
    marginPct: deliveredCents > 0 ? Math.round((profitCents / deliveredCents) * 10000) / 100 : null,
    ratio: marketAudCents > 0 ? Math.round((deliveredCents / marketAudCents) * 1000) / 1000 : null,
  };
}

export function qualifies(h, cfg) {
  const minProfit = Math.round((+cfg.min_profit_aud || 0) * 100);
  const minMargin = +cfg.min_margin_pct || 0;
  return h.profitCents >= minProfit && h.marginPct != null && h.marginPct >= minMargin;
}

// tcgplayer.updatedAt arrives as "2026/08/15" from pokemontcg.io and as ISO from our own tables.
export function marketAgeDays(updatedAt, now = Date.now()) {
  if (!updatedAt) return null;
  const s = String(updatedAt).trim().replace(/^(\d{4})\/(\d{2})\/(\d{2})$/, '$1-$2-$3');
  const t = Date.parse(s);
  if (!isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

// Why a hit needs a human. Each carries its own sentence (DESIGN.md forbids colour carrying meaning
// alone). The first one is the classic failure of this whole idea: a listing at a quarter of market
// is nearly always the wrong printing or the wrong card, not a gift — it mirrors DISAGREE_LO in
// lib/runner-core.mjs, the same detector the batch runner uses in the other direction.
export function warningsFor(h, ctx = {}) {
  const out = [];
  const tooGood = ctx.tooGoodRatio != null ? ctx.tooGoodRatio : DISAGREE_LO;
  if (h.ratio != null && h.ratio < tooGood) out.push({ k: 'check_printing', why: 'delivered is only ' + h.ratio.toFixed(2) + '× the TCGplayer market — check this is the right printing and the right card' });
  if (ctx.coupon) out.push({ k: 'coupon', why: 'the seller has a coupon the API cannot see, so the real price is lower than shown' });
  if (ctx.marketAgeDays != null && ctx.maxMarketAgeDays != null && ctx.marketAgeDays > ctx.maxMarketAgeDays) out.push({ k: 'stale_market', why: 'the TCGplayer market figure is ' + ctx.marketAgeDays + ' days old' });
  if (ctx.condClass === 'unstated') out.push({ k: 'cond_unstated', why: 'the title states no condition — judge it from the photos' });
  if (ctx.condClass === 'vague') out.push({ k: 'cond_vague', why: 'the seller says "' + (ctx.condEvidence || 'excellent') + '" — below NM on eBay’s own scale, but casual sellers use it loosely; judge it from the photos' });
  if (ctx.printingAmbiguous) out.push({ k: 'printing_ambiguous', why: 'the title does not say which printing this is — scored at the cheapest one it could be' });
  if (ctx.multi) out.push({ k: 'multi', why: 'the title reads like more than one card — check what the price buys' });
  if (ctx.bestOffer) out.push({ k: 'best_offer', why: 'accepts offers — the listed price is the ceiling, not the floor' });
  return out;
}

export const MULTI_RE = /\bx\s?[2-9]\b|\b[2-9]\s?x\b|\bpair\b|\bboth\b/i;

// Warnings that mean "not tonight" for an automated alert: a probable wrong card, or a market figure
// too old to trust. They still show on the page.
export const ALERT_BLOCKERS = ['check_printing', 'stale_market'];
export const alertable = (warnings) => !(warnings || []).some((w) => ALERT_BLOCKERS.includes(w.k || w));

export function rankHits(hits) {
  return (hits || []).slice().sort((a, b) =>
    (b.profit_cents - a.profit_cents)
    || ((b.margin_pct || 0) - (a.margin_pct || 0))
    || String(b.listed_at || '').localeCompare(String(a.listed_at || '')));
}

// ---------------------------------------------------------------------------
// Reconciling one scan against what is already stored
// ---------------------------------------------------------------------------

export const HIT_STATUSES = ['new', 'seen', 'bought', 'dismissed', 'gone'];
// What a person may do to a row. `gone` rows can be dismissed (tidy the list) and nothing else; a
// `bought` or `dismissed` row is final — the scan never reopens it, and neither does a click.
export const HIT_TRANSITIONS = {
  new: ['seen', 'bought', 'dismissed'],
  seen: ['bought', 'dismissed'],
  gone: ['dismissed'],
  bought: [],
  dismissed: [],
};
export const canTransition = (from, to) => Array.isArray(HIT_TRANSITIONS[from]) && HIT_TRANSITIONS[from].includes(to);

// Pure. `existing` are the stored rows for this card+printing, `current` the qualifying candidates
// this scan produced (each with an item_id and its fresh figures), `seenItemIds` every item id the
// scan saw at all (qualifying or not) so a row that fell below the floor is told apart from one that
// sold or ended. Rules:
//   · brand new item        → insert as `new`
//   · new/seen, still here  → refresh figures, keep status
//   · gone, back again      → `seen` (never `new` again — an alert fires once per item, ever)
//   · new/seen, not here    → `gone`, reason below_floor if it was in the results, else not_listed
//   · bought/dismissed      → figures and last_seen refreshed only; status is the owner's
// A scan whose Browse call FAILED must not call this at all — nothing was observed.
export function reconcileHits({ existing, current, seenItemIds, now, scanId }) {
  const byItem = new Map((existing || []).map((r) => [r.item_id, r]));
  const seen = new Set(seenItemIds || []);
  const inserts = [], updates = [], gone = [];
  const touched = new Set();
  for (const h of current || []) {
    touched.add(h.item_id);
    const ex = byItem.get(h.item_id);
    if (!ex) { inserts.push({ ...h, status: 'new', first_seen: now, last_seen: now, last_scan_id: scanId }); continue; }
    const patch = { ...h, last_seen: now, last_scan_id: scanId };
    if (ex.status === 'gone') { patch.status = 'seen'; patch.gone_reason = null; }
    updates.push({ id: ex.id, from: ex.status, patch });
  }
  for (const ex of existing || []) {
    if (touched.has(ex.item_id)) continue;
    if (ex.status !== 'new' && ex.status !== 'seen') continue;
    gone.push({ id: ex.id, reason: seen.has(ex.item_id) ? 'below_floor' : 'not_listed', last_scan_id: scanId, last_seen: seen.has(ex.item_id) ? now : ex.last_seen });
  }
  return { inserts, updates, gone };
}

// ---------------------------------------------------------------------------
// The catch line → cards
// ---------------------------------------------------------------------------

// Resolve one parsed catch line (lib/runner-core.mjs parseCatch) against a set's cards. A number finds
// at most one card (numKeys makes `4`, `004` and `004/165` the same key); a `*name` finds every card
// whose name contains it, so `*charizard` in Obsidian Flames yields all four Charizard ex prints and
// the operator keeps the ones they meant. Returns [] when nothing matches.
export function findCards(cards, parsed) {
  const list = Array.isArray(cards) ? cards : [];
  if (parsed && parsed.nameQuery) {
    const q = String(parsed.nameQuery).toLowerCase();
    return list.filter((c) => String(c.name || '').toLowerCase().includes(q));
  }
  if (parsed && parsed.num != null) {
    const want = new Set(numKeys(parsed.num));
    return list.filter((c) => numKeys(c.number).some((k) => want.has(k))).slice(0, 1);
  }
  return [];
}

// The printing matrix and the one the line asked for, straight off the card's tcgplayer.prices keys
// (lib/runner-core.mjs printingsFor — data, never a guess, GR5). `which` records which price field
// fed marketUsd so the caller can refuse to score a card that only has a `low` (GR4: the buyer pays
// on MARKET, and `low` is not market).
export function printingsWithSource(card) {
  const prices = card && card.tcgplayer && card.tcgplayer.prices;
  return printingsFor(card).map((p) => {
    const b = (prices && prices[p.key]) || {};
    const which = b.market > 0 ? 'market' : b.mid > 0 ? 'mid' : b.low > 0 ? 'low' : null;
    return { ...p, which };
  });
}

export function resolveCard(card, printingToken) {
  const printings = printingsWithSource(card);
  const chosen = pickPrinting(printings, printingToken);
  return { printings, chosen };
}

// ---------------------------------------------------------------------------
// The newly-listed sweep — a title with no card attached, matched back to the catalogue
// ---------------------------------------------------------------------------
// One broad Browse call per set ("Pokemon Obsidian Flames", sorted newest first) returns 200 titles
// that could be any card in the set. Measured 2026-09-12: 194 of the newest 200 for Obsidian Flames
// carried a strict "<number>/<printedTotal>" that resolved to a catalogue card, and those 200 spanned
// about 36 hours — so one call a day per set sees every new listing, which is the cheapest lever this
// tool has. The matching below is deliberately strict: a sweep has no operator-chosen card to check
// against, so the title has to prove which card it is on its own.

// Every "<number>/<total>" in a title, plus the lettered forms galleries use ("TG01/TG30"). The
// denominator is what ties a number to a SET: 125/197 is Obsidian Flames, 125/165 is 151.
export function titleNumbers(title) {
  const t = String(title || '');
  const out = [];
  const re = /\b(\d{1,3})([A-Za-z])?\s*\/\s*(\d{2,3})\b/g;
  let m;
  while ((m = re.exec(t))) out.push({ num: String(+m[1]) + (m[2] || '').toUpperCase(), total: +m[3], prefixed: false });
  const pre = /\b([A-Za-z]{1,4})\s?0*(\d{1,3})\s*\/\s*([A-Za-z]{1,4})\s?\d{1,3}\b/g;
  while ((m = pre.exec(t))) if (m[1].toUpperCase() === m[3].toUpperCase()) out.push({ num: m[1].toUpperCase() + m[2], total: null, prefixed: true });
  return out;
}

// Diacritics folded, everything but letters and digits gone: "Farfetch'd" and "Ho-Oh" survive the
// seller's punctuation, and the check is a substring rather than a word boundary for the same reason.
export const foldText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The word that makes a card its name: the first token of three or more letters ("Charizard" of
// "Charizard ex", "Professors" of "Professor's Research"), else the longest one. A number match
// with the wrong name is a different set with the same printed total, or a lot.
export function nameToken(name) {
  const toks = String(name || '').split(/\s+/).map(foldText).filter(Boolean);
  return toks.find((t) => t.length >= 3) || toks.sort((a, b) => b.length - a.length)[0] || '';
}
export const titleNamesCard = (title, name) => { const tok = nameToken(name); return !!tok && foldText(title).includes(tok); };

// An index of one set's cards by every key a typed or printed number could mean (lib/runner-core.mjs
// numKeys), so "4", "004" and "TG1" all find their card.
export function buildSetIndex(cards, set) {
  const byKey = new Map();
  for (const c of cards || []) {
    for (const k of numKeys(c.number)) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c); }
  }
  return { byKey, printedTotal: (set && set.printedTotal) || null, total: (set && set.total) || null };
}

// Title → the one card it is, or the reason it is not. Order of refusal: no number at all, a number
// for another set (wrong denominator), a number the set does not have, a name that does not match.
export function matchTitleToCard(title, index) {
  const nums = titleNumbers(title);
  if (!nums.length) return { card: null, reason: 'no_number' };
  let sawOtherSet = false, sawUnknown = false, sawWrongName = false;
  for (const n of nums) {
    if (!n.prefixed && n.total !== index.printedTotal && n.total !== index.total) { sawOtherSet = true; continue; }
    const cands = [];
    for (const k of numKeys(n.num)) for (const c of index.byKey.get(k) || []) if (!cands.includes(c)) cands.push(c);
    if (!cands.length) { sawUnknown = true; continue; }
    const named = cands.filter((c) => titleNamesCard(title, c.name));
    if (!named.length) { sawWrongName = true; continue; }
    return { card: named[0], number: n.num, tier: 'strict' };
  }
  return { card: null, reason: sawWrongName ? 'name_mismatch' : sawUnknown ? 'unknown_number' : sawOtherSet ? 'other_set' : 'no_number' };
}

// The two broad wordings a sweep runs per set. `name` is the precise one (194 strict matches in the
// newest 200, all naming the set); `number` — the bare printed total — is the net for the ~6% of
// titles that never name the set, at the cost of more rows from other sets, which the denominator
// check throws away.
export function sweepQuery(set, mode) {
  if (mode === 'number') return set.printedTotal ? 'Pokemon ' + set.printedTotal : null;
  return set.name ? 'Pokemon ' + set.name : null;
}
export const SWEEP_QUERY_MODES = ['name', 'number'];
