// lib/tcgplayer-market.mjs — ONE way to ask TCGplayer what a card is worth, for DISPLAY ONLY.
//
// WHY THIS EXISTS (owner decision, 2026-10-16). EB Games Australia now buys over the counter
// against TCGplayer's market price and sells against it, so TCGplayer is a competitor's stated
// basis. It has to be VISIBLE on the screens where we decide what to pay and what to charge.
//
// DISPLAY ONLY, and that is the decision, not an oversight. Nothing here is imported by
// lib/pricing.mjs (which owns precedence: override > live market > tier floor) or by any
// lib/repricer-*.mjs. A TCGplayer figure must never become an anchor, a floor, a threshold or an
// input to an automatic price — it sits beside our own number so a person can see the gap and
// decide. If you are about to import this module into either of those, that is the exact thing
// the owner said no to; put the figure on the screen instead.
//
// THE ROUTE. The official TCGplayer API has been shut to new developers since late 2024
// (docs/DATA_SOURCES.md), so the only way in is the public search API behind the price-guide
// pages — the same endpoint three bakes already use (scripts/build-riftbound-prices.mjs,
// build-pokemon-mep.mjs, build-onepiece-tcgimages.mjs). This module is the single home for the
// per-card lookup; the bakes keep their own paging loops because they pull whole product lines.
// test/unit/tcgplayer-market.test.mjs asserts the endpoint and headers here still match the ones
// the bakes send, so the four cannot drift apart silently (the Golden Rule 9 habit).
//
// It is an undocumented private endpoint reached with browser headers, and it is CORS-blocked in
// the browser — which is why this is server-side and the page talks to /api/tcgplayer/market
// (Golden Rules 1 and 2: every upstream goes through the dev-server proxy layer).
//
// THREE THINGS THIS REFUSES TO DO, each because getting it wrong puts a confident wrong number on
// a buy screen, which is worse than a blank (Golden Rules 4 and 5):
//
//   1. It never constructs a productLineName or a setName. A productLineName that is not the FULL
//      display value is silently IGNORED by the API — it answers 200 with the whole unfiltered
//      catalogue (~500k products), so a typo looks like success. Both are resolved from the API's
//      own aggregations and matched by normalised name, and every returned row is checked to
//      actually belong to the line we asked for.
//   2. It never picks between printings. One Piece OP01-003 is two products at one number: the
//      base Luffy at US$5.01 and the (Parallel) at US$1,023.34. Where several products match, the
//      answer is `candidates` and a sentence, never the first row.
//   3. It never guesses a card from a bare name. A free-text search for "Monkey D. Luffy OP01-003"
//      returns a sealed Starter Deck at US$26.86 as its top hit. A card answer must match on the
//      collector number, or be reached by product id, which is exact by construction.
//
// Degradation is the normal case, not the error case: marketFor never throws and never returns a
// bare blank — every unpriced answer carries a `code` and a `why` sentence the UI prints verbatim.
import { cardNumberKey } from './listing-copy.mjs';
import { withInflight, sendJson } from './set-cache.mjs';

export const TCGP_SEARCH_URL = 'https://mp-search-api.tcgplayer.com/v1/search/request';
// Verbatim from the three bakes. The Origin/Referer pair is what gets a Node fetch past the
// filtering the browser cannot get past at all.
export const TCGP_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Origin: 'https://www.tcgplayer.com',
  Referer: 'https://www.tcgplayer.com/',
};
export const TCGP_PRODUCT_URL = 'https://www.tcgplayer.com/product/';
const TIMEOUT_MS = 20000;
const SEARCH_SIZE = 24;        // a name inside one set; the API rejects size > 50 regardless

// Our game key -> TCGplayer's product-line DISPLAY value. Checked against the live
// productLineName aggregation on 2026-10-16 (product counts in comments). These are CANDIDATE
// names only: resolveLine matches each against the aggregation the API itself serves, so a
// renamed or retired line degrades to "no coverage" with a sentence rather than to a filter the
// API ignores. Game keys are lib/normalize.mjs's (pokemon, mtg, lorcana, riftbound, swu,
// onepiece), so a caller that already knows its game needs no translation table of its own.
export const GAME_LINES = {
  pokemon: 'Pokemon',                                              // 32,868
  mtg: 'Magic: The Gathering',                                     // 119,268
  lorcana: 'Disney Lorcana',                                       // 3,954
  onepiece: 'One Piece Card Game',                                 // 7,739
  swu: 'Star Wars: Unlimited',                                     // 9,114
  riftbound: 'Riftbound: League of Legends Trading Card Game',     // 1,822
  funko: 'Funko',                                                  // 4,304
  // 'pokemon-jp' is NOT here on purpose. TCGplayer's "Pokemon Japan" line (30,694) prices the
  // Japanese print as a US import, which is a different market from the one the intl lane sells
  // into; stock-uploader.html already says in words that TCGplayer does not price those printings
  // and that eBay AU is the reference there. Adding it would quietly contradict that page.
};

// Every blank the UI can be handed, in words. The page prints `why` as-is — a silent dash on a buy
// screen is the defect this whole module exists to avoid (the precedent is commit 78be980, where
// the arbitrage page learned to say why it had gone quiet).
// Games we deliberately do not price, and the real reason for each. A caller that passes one of
// these gets the reason rather than a generic shrug, because "why is this blank" has a specific
// answer here and the operator needs it to know what to price off instead.
export const NO_COVERAGE_WORDS = {
  'pokemon-jp': 'TCGplayer prices the Japanese print as a US import, which is a different market from the one these cards sell into, so no figure is shown. eBay AU is the reference for a non-English printing.',
  'pokemon-intl': 'TCGplayer does not price non-English printings in a market comparable to ours, so no figure is shown. eBay AU is the reference here.',
  other: 'This line is not a trading-card product TCGplayer carries, so there is no market figure for it.',
};

export const WHY = {
  no_game: 'No game was given, so there is nothing to look up on TCGplayer.',
  no_coverage: (g) => NO_COVERAGE_WORDS[String(g || '').toLowerCase()]
    || ('TCGplayer has no price line we can read for ' + (g || 'this game') + ', so there is no market figure to show.'),
  line_gone: (name) => 'TCGplayer no longer lists a product line called "' + name + '", so the lookup was not attempted. The name in GAME_LINES needs updating.',
  no_query: 'This line has no card name yet, so there is nothing to match on TCGplayer.',
  no_match: 'TCGplayer has no product matching this name in this set.',
  no_number_match: (n) => 'TCGplayer lists this name but nothing at number ' + n + ', so no figure is shown rather than one from a different card.',
  needs_number: 'TCGplayer lists several cards under this name. Add the collector number to pick the right one.',
  ambiguous: 'Several printings share this number and they are priced very differently, so none is shown as the figure. Pick one.',
  no_price: 'TCGplayer lists this card but carries no market price for it yet, which is normal for a few weeks after release.',
  upstream_down: 'TCGplayer did not answer, so there is no market figure right now. Nothing else on this page is affected.',
  no_rate: 'No exchange rate, so the figure is shown in US dollars only and is not compared with ours.',
};

// ---------------------------------------------------------------------------------------------
// pure helpers (the unit suite drives these directly)
// ---------------------------------------------------------------------------------------------

export const normName = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Do two collector numbers name the same card? Built on cardNumberKey (lib/listing-copy.mjs),
 * which already collapses printed padding so '106/86' and '106/086' are one card.
 *
 * The extra rule is the denominator: TCGplayer answers '199/165' where a builder, an operator or
 * an identity key supplies a bare '199', and Golden Rule 10 is explicit that the denominator is a
 * DISPLAY concern. So when either side carries no denominator, only the numerators are compared;
 * when both do, both halves must agree — that is what keeps SWU's '001/002' prerelease promo from
 * answering for '001/252' in the main set.
 */
export function numbersMatch(a, b) {
  const ka = unpad(a), kb = unpad(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [na, da] = ka.split('/'), [nb, db] = kb.split('/');
  if (na !== nb) return false;
  return !da || !db;              // one side is a bare numerator: the numerators agreeing is enough
}
// cardNumberKey strips padding per SLASH-separated part, which is all Pokémon needs. One Piece and
// the other Bandai games hyphenate instead ('OP01-003'), so the hyphen halves are unpadded too —
// it can only ever collapse two spellings of the SAME number, never make two numbers equal.
const unpad = (s) => cardNumberKey(s).split('-').map((p) => cardNumberKey(p)).join('-');

/**
 * A row that is a CARD: it carries a collector number. TCGplayer's own `sealed` flag is not enough
 * on its own — "Starter Deck 31: RED Monkey.D.Luffy" comes back sealed:false with a null number,
 * and it was the top hit for a search for a card in that deck. The number is what actually
 * separates singles from boxes, which is why all three bakes test it.
 */
export const isCardRow = (p) => !!(p && !p.sealed && p.customAttributes && p.customAttributes.number);
/** A row that is SEALED product: a purchase order's booster boxes have no collector number. */
export const isSealedRow = (p) => !!(p && p.productId && !(p.customAttributes && p.customAttributes.number));

export const marketOf = (p) => {
  const v = p && p.marketPrice;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
};
export const productUrl = (p) => (p && p.productId != null ? TCGP_PRODUCT_URL + p.productId : null);

/** The one row the panel describes, trimmed to what a reference figure needs. */
export function rowOut(p) {
  return {
    productId: p.productId == null ? null : p.productId,
    productName: p.productName || '',
    setName: p.setName || '',
    number: (p.customAttributes && p.customAttributes.number) || null,
    rarity: p.rarityName || '',
    market: marketOf(p),
    low: typeof p.lowestPrice === 'number' ? p.lowestPrice : null,
    listings: typeof p.totalListings === 'number' ? p.totalListings : null,
    url: productUrl(p),
  };
}

/**
 * The POST body. Pure, so the exact shape is pinned by a test instead of by a live call.
 * `sort` by product-sorting-name, never the default sales ranking: the ranking moves between
 * requests, which is what cost the Riftbound bake real products mid-page (see its comments).
 */
export function searchBody({ line = null, setSlug = null, productId = null, size = SEARCH_SIZE, from = 0 } = {}) {
  const term = {};
  if (productId != null) term.productId = [Number(productId)];
  if (line) term.productLineName = [line];
  if (setSlug) term.setName = [setSlug];
  return {
    algorithm: 'sales_dismax', from, size,
    filters: { term, range: {}, match: {} },
    context: { shippingCountry: 'US' },
    sort: productId != null ? {} : { field: 'product-sorting-name', order: 'asc' },
  };
}

export const searchUrl = (q) => TCGP_SEARCH_URL + '?q=' + encodeURIComponent(q || '') + '&isList=false';

/**
 * Choose among the rows a search returned. Returns `{ row }` for exactly one answer, or
 * `{ candidates, code }` when the honest answer is "you pick".
 *
 * kind 'card' demands a number match. kind 'sealed' matches a product name, because a booster box
 * has no number to match on.
 */
export function pickRow(rows, { number = null, name = null, kind = 'card' } = {}) {
  const pool = (rows || []).filter(kind === 'sealed' ? isSealedRow : isCardRow);
  if (!pool.length) return { candidates: [], code: 'no_match' };

  if (kind === 'card') {
    if (!number) {
      // No number to match on. One card under the name is an answer; several is a question.
      if (pool.length === 1) return { row: pool[0] };
      return { candidates: pool, code: 'needs_number' };
    }
    const at = pool.filter((p) => numbersMatch(p.customAttributes.number, number));
    if (!at.length) return { candidates: pool, code: 'no_number_match' };
    if (at.length === 1) return { row: at[0] };
    // Several printings at one number — the OP01-003 case, US$5 against US$1,023. An exact name
    // match breaks the tie only when it is unique; otherwise the operator chooses.
    const exact = name ? at.filter((p) => normName(p.productName) === normName(name)) : [];
    if (exact.length === 1) return { row: exact[0] };
    return { candidates: at, code: 'ambiguous' };
  }

  const exact = name ? pool.filter((p) => normName(p.productName) === normName(name)) : [];
  if (exact.length === 1) return { row: exact[0] };
  if (pool.length === 1) return { row: pool[0] };
  return { candidates: pool, code: 'ambiguous' };
}

/**
 * Our price against the market figure, which is the number the business question actually turns
 * on: EB buys and sells against TCGplayer, so what matters is whether we sit over or under it.
 *
 * Golden Rule 3: money is integer cents and the float crosses to cents EXACTLY ONCE, here.
 * `marketUsd` is the upstream float, `rate` the USD->AUD rate, `ourCents` already-integer AUD
 * cents from the caller. The rate used and the moment of the fetch travel with the figure for the
 * same reason price_snapshots stores fx_usd_aud beside market_aud: a stale conversion has to be
 * auditable rather than quietly wrong.
 */
export function comparison({ marketUsd = null, rate = null, ourCents = null } = {}) {
  const usd = typeof marketUsd === 'number' && Number.isFinite(marketUsd) && marketUsd > 0 ? marketUsd : null;
  const r = typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
  const out = {
    marketUsdCents: usd == null ? null : Math.round(usd * 100),
    marketAudCents: usd == null || r == null ? null : Math.round(usd * r * 100),
    rate: r, ourCents: Number.isInteger(ourCents) ? ourCents : null,
    pctOfMarket: null, deltaPct: null, stance: null, words: null,
  };
  if (usd != null && r == null) out.words = WHY.no_rate;
  if (out.marketAudCents == null || out.ourCents == null || out.marketAudCents <= 0) return out;
  // One decimal place, the shape arb-core's dropPct already uses.
  out.pctOfMarket = Math.round((out.ourCents / out.marketAudCents) * 1000) / 10;
  out.deltaPct = Math.round((out.pctOfMarket - 100) * 10) / 10;
  const near = Math.abs(out.deltaPct) < 0.5;
  out.stance = near ? 'at' : out.deltaPct < 0 ? 'below' : 'above';
  out.words = near
    ? 'level with TCGplayer market'
    : Math.abs(out.deltaPct).toFixed(1) + '% ' + out.stance + ' TCGplayer market';
  return out;
}

// ---------------------------------------------------------------------------------------------
// upstream
// ---------------------------------------------------------------------------------------------

/** One search POST. Returns the first result block, or null — never throws. */
export async function tcgpSearch(body, { q = '', fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(searchUrl(q), {
      method: 'POST', headers: TCGP_HEADERS, body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.results && j.results[0]) || null;
  } catch { return null; }
}

// The product-line and per-line set rosters change on TCGplayer's schedule, not ours, and every
// lookup needs them. Held for an hour; _resetCaches is the test seam.
const HOUR = 60 * 60 * 1000;
let _lines = null;                 // { at, byName: Map<normalised, displayValue> }
const _setSlugs = new Map();       // line -> { at, byName: Map<normalised, urlValue> }
const _answers = new Map();        // signature -> { at, payload }
const _inflight = new Map();
export const ANSWER_TTL_MS = 30 * 60 * 1000;   // a reference figure, not a ticker

export function _resetCaches() { _lines = null; _setSlugs.clear(); _answers.clear(); _inflight.clear(); }

/**
 * Our game key -> the product-line name TCGplayer ITSELF publishes right now. The aggregation is
 * the authority; GAME_LINES only says which bucket we want. This is the guard that keeps a stale
 * constant from turning into a filter the API ignores and a price from the wrong catalogue.
 */
export async function resolveLine(game, { fetchImpl = fetch, now = Date.now } = {}) {
  const want = GAME_LINES[String(game || '').toLowerCase()];
  if (!want) return { line: null, code: 'no_coverage', why: WHY.no_coverage(game) };
  if (!_lines || now() - _lines.at > HOUR) {
    const res = await tcgpSearch(searchBody({ size: 1 }), { fetchImpl });
    const buckets = (res && res.aggregations && res.aggregations.productLineName) || [];
    if (!buckets.length) return { line: null, code: 'upstream_down', why: WHY.upstream_down };
    _lines = { at: now(), byName: new Map(buckets.map((b) => [normName(b.value), b.value])) };
  }
  const live = _lines.byName.get(normName(want));
  if (!live) return { line: null, code: 'line_gone', why: WHY.line_gone(want) };
  return { line: live };
}

/**
 * Our set name -> TCGplayer's setName URL slug, matched by normalised name against the line's own
 * aggregation and never constructed (the lesson in build-onepiece-tcgimages.mjs's
 * resolveSetSlugs). A set we cannot match is not an error: the lookup widens to the whole product
 * line and the number match carries the weight.
 */
export async function resolveSetSlug(line, setName, { fetchImpl = fetch, now = Date.now } = {}) {
  const want = normName(setName);
  if (!line || !want) return null;
  let entry = _setSlugs.get(line);
  if (!entry || now() - entry.at > HOUR) {
    const res = await tcgpSearch(searchBody({ line, size: 1 }), { fetchImpl });
    const buckets = (res && res.aggregations && res.aggregations.setName) || [];
    if (!buckets.length) return null;
    entry = { at: now(), byName: new Map(buckets.map((b) => [normName(b.value), b.urlValue])) };
    _setSlugs.set(line, entry);
  }
  if (entry.byName.has(want)) return entry.byName.get(want);
  // Our set names carry prefixes TCGplayer's do not ('SV: Scarlet & Violet 151' against the
  // builder's 'Scarlet & Violet 151', 'OP-01 Romance Dawn' against 'Romance Dawn'). A single
  // containment match in one direction is safe; two would be a guess, so it widens to the line.
  const hits = [...entry.byName.keys()].filter((k) => k.includes(want) || want.includes(k));
  return hits.length === 1 ? entry.byName.get(hits[0]) : null;
}

/**
 * THE lookup. One answer shape for every caller and every outcome:
 *
 *   { market, currency:'USD', fetchedAt, productId, productName, setName, number, url,
 *     matchedBy: 'product-id' | 'set+number' | 'line+number' | 'name' | 'sealed-name',
 *     code?, why?, candidates? }
 *
 * `market` is null whenever we do not have an honest figure, and code + why always say which kind
 * of blank it is. Never throws (Golden Rule 7): a dead upstream is a sentence, not an exception,
 * and nothing else on the page is affected.
 */
export async function marketFor(req = {}, { fetchImpl = fetch, now = Date.now } = {}) {
  const game = String(req.game || '').toLowerCase();
  const kind = req.kind === 'sealed' ? 'sealed' : 'card';
  const name = String(req.name || '').trim();
  const number = req.number == null ? '' : String(req.number).trim();
  const productId = req.productId != null && String(req.productId).trim() !== '' && Number.isFinite(Number(req.productId))
    ? Number(req.productId) : null;
  const blank = (code, why, extra = {}) => ({
    market: null, currency: 'USD', fetchedAt: new Date(now()).toISOString(), code, why, ...extra,
  });

  if (!game) return blank('no_game', WHY.no_game);
  const { line, code: lineCode, why: lineWhy } = await resolveLine(game, { fetchImpl, now });
  if (!line) return blank(lineCode, lineWhy);

  // A product id is exact by construction, so it skips name matching, set resolution and the
  // number guard entirely. MTG reaches this path for nothing: Scryfall's tcgplayer_id IS this id
  // (verified 2026-10-16 — Lightning Bolt 3ED, Scryfall 1479, TCGplayer product 1479). Old sets
  // carry a null customAttributes.number, which is exactly why the number guard must not apply
  // here: Revised Edition would otherwise be unpriceable.
  if (productId != null) {
    const res = await tcgpSearch(searchBody({ productId, size: 2 }), { fetchImpl });
    if (!res) return blank('upstream_down', WHY.upstream_down);
    const rows = (res.results || []).filter((p) => normName(p.productLineName) === normName(line));
    if (!rows.length) return blank('no_match', WHY.no_match);
    const out = { ...rowOut(rows[0]), currency: 'USD', fetchedAt: new Date(now()).toISOString(), matchedBy: 'product-id' };
    return out.market == null ? { ...out, code: 'no_price', why: WHY.no_price } : out;
  }

  if (!name) return blank('no_query', WHY.no_query);

  const setSlug = await resolveSetSlug(line, req.setName, { fetchImpl, now });
  const res = await tcgpSearch(searchBody({ line, setSlug }), { q: name, fetchImpl });
  if (!res) return blank('upstream_down', WHY.upstream_down);

  // THE UNFILTERED-CATALOGUE GUARD. A filter the API ignores answers 200 with ~500k products from
  // every line at once. Keeping only rows that belong to the line we asked for means that failure
  // reads as "no match" instead of as a Pokemon price on a Lorcana card.
  const rows = (res.results || []).filter((p) => normName(p.productLineName) === normName(line));
  const picked = pickRow(rows, { number, name, kind });
  const stamp = { currency: 'USD', fetchedAt: new Date(now()).toISOString(), setMatched: !!setSlug };

  if (!picked.row) {
    const why = picked.code === 'no_number_match' ? WHY.no_number_match(number) : WHY[picked.code] || WHY.no_match;
    return blank(picked.code, why, { ...stamp, candidates: (picked.candidates || []).slice(0, 8).map(rowOut) });
  }
  const out = {
    ...rowOut(picked.row), ...stamp,
    matchedBy: kind === 'sealed' ? 'sealed-name' : setSlug ? 'set+number' : number ? 'line+number' : 'name',
  };
  return out.market == null ? { ...out, code: 'no_price', why: WHY.no_price } : out;
}

/** The request signature the TTL cache and the in-flight collapse both key on. */
export const cacheKey = (req = {}) => [
  String(req.game || '').toLowerCase(), req.kind === 'sealed' ? 'sealed' : 'card',
  req.productId == null ? '' : String(req.productId),
  normName(req.name), normName(req.setName), cardNumberKey(req.number),
].join('|');

/**
 * Cached marketFor. Private undocumented endpoint: a panel that remounts on every keystroke must
 * not become traffic. Returns `{ payload, cacheState }` so the route can report which it served,
 * the way lib/set-cache.mjs's x-tcg-cache header already does.
 */
export async function marketForCached(req = {}, { fetchImpl = fetch, now = Date.now, refresh = false } = {}) {
  const key = cacheKey(req);
  const hit = _answers.get(key);
  if (!refresh && hit && now() - hit.at < ANSWER_TTL_MS) return { payload: hit.payload, cacheState: 'memory' };
  const payload = await withInflight(_inflight, key, () => marketFor(req, { fetchImpl, now }));
  // An outage is not cached: the next look should try again, not be told no for half an hour.
  if (payload && payload.code !== 'upstream_down') _answers.set(key, { at: now(), payload });
  return { payload, cacheState: 'upstream' };
}

/**
 * GET /api/tcgplayer/market?game=&name=&number=&set=&productId=&kind=&refresh=1
 *
 * ALWAYS 200 for an answer we can stand behind, blank or not: a card TCGplayer does not price is
 * an answer, not a failure, and the page has one code path that reads `why` either way. Only a
 * dead upstream is 502 — and it carries the same why sentence, so even that renders as words.
 *
 * /api/tcgplayer shares no prefix with /api/tcgdex (Vite matches proxy contexts by startsWith in
 * declaration order — the trap lib/riftbound-prices.mjs documents for /api/rb against /api/rbs).
 */
export function tcgplayerMarketPlugin() {
  return {
    name: 'tcgplayer-market',
    configureServer(server) {
      server.middlewares.use('/api/tcgplayer', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const p = url.pathname.replace(/\/+$/, '') || '/market';
          if (p !== '/market') {
            return sendJson(res, 404, { error: 'not found', usage: 'GET /api/tcgplayer/market?game=&name=&number=&set=' }, 'none');
          }
          const q = url.searchParams;
          const { payload, cacheState } = await marketForCached({
            game: q.get('game'), name: q.get('name'), number: q.get('number'),
            setName: q.get('set'), productId: q.get('productId'), kind: q.get('kind'),
          }, { refresh: q.get('refresh') === '1' });
          return sendJson(res, payload && payload.code === 'upstream_down' ? 502 : 200, payload, cacheState);
        } catch (e) {
          // Belt and braces: marketFor does not throw, so this is a bug rather than an outage —
          // and it still has to leave the operator a sentence instead of a dash.
          return sendJson(res, 500, { market: null, currency: 'USD', code: 'error', why: 'The TCGplayer lookup failed on our side: ' + String(e && e.message ? e.message : e) }, 'none');
        }
      });
      console.log('[tcgplayer-market] API /api/tcgplayer/market · DISPLAY-ONLY market reference (public search API, ' + Object.keys(GAME_LINES).length + ' product lines)');
    },
  };
}
