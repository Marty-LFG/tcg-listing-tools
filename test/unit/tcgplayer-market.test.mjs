// test/unit/tcgplayer-market.test.mjs — the DISPLAY-ONLY TCGplayer market reference.
//
// Four things are worth testing here, and only one of them is arithmetic:
//
//   1. The ROUTE does not drift from the three bakes that already use it (the Golden Rule 9 habit).
//   2. The module never answers with a CONFIDENT WRONG NUMBER. Every way it can be handed the
//      wrong card — a product line the API silently ignores, a sealed deck matching a card search,
//      two printings at one collector number — has to come back as a blank with a sentence or as
//      candidates, never as a figure. On a buy screen a wrong reference is worse than no reference.
//   3. The money maths is integer cents and the browser's copy agrees with the server's (GR3/GR9).
//   4. The BOUNDARY holds: nothing in lib/pricing.mjs or the repricer imports this.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { read } from '../helpers/extract-inline.mjs';
import {
  GAME_LINES, NO_COVERAGE_WORDS, WHY, TCGP_SEARCH_URL, TCGP_HEADERS,
  normName, numbersMatch, isCardRow, isSealedRow, marketOf, productUrl, rowOut,
  searchBody, searchUrl, pickRow, comparison, cacheKey,
  marketFor, marketForCached, resolveLine, resolveSetSlug, _resetCaches, ANSWER_TTL_MS,
} from '../../lib/tcgplayer-market.mjs';

// ---------------------------------------------------------------------------------------------
// fixtures — shaped exactly like the rows the live API returned on 2026-10-16
// ---------------------------------------------------------------------------------------------
const card = (o = {}) => ({
  productId: o.productId ?? 517045,
  productName: o.productName ?? 'Charizard ex - 199/165',
  setName: o.setName ?? 'SV: Scarlet & Violet 151',
  productLineName: o.productLineName ?? 'Pokemon',
  rarityName: o.rarityName ?? 'Special Illustration Rare',
  marketPrice: o.marketPrice === undefined ? 322.27 : o.marketPrice,
  lowestPrice: o.lowestPrice ?? 210,
  totalListings: o.totalListings ?? 310,
  sealed: o.sealed ?? false,
  customAttributes: o.number === null ? { number: null } : { number: o.number ?? '199/165' },
});
// The One Piece trap: one collector number, two products, US$5.01 against US$1,023.34.
const LUFFY_BASE = card({ productId: 454515, productName: 'Monkey.D.Luffy (003)', setName: 'Romance Dawn', productLineName: 'One Piece Card Game', number: 'OP01-003', marketPrice: 5.01 });
const LUFFY_PARALLEL = card({ productId: 453506, productName: 'Monkey.D.Luffy (003) (Parallel)', setName: 'Romance Dawn', productLineName: 'One Piece Card Game', number: 'OP01-003', marketPrice: 1023.34 });
// The sealed trap: TCGplayer reports sealed:false for a starter deck, and it was the TOP HIT for a
// search for a card inside it. Only the absent collector number separates them.
const STARTER_DECK = card({ productId: 704885, productName: 'Starter Deck 31: RED Monkey.D.Luffy', setName: 'ST-31', productLineName: 'One Piece Card Game', number: null, marketPrice: 26.86, sealed: false });

const LINE_BUCKETS = Object.values(GAME_LINES).map((v) => ({ value: v, urlValue: v.toLowerCase().replace(/[^a-z0-9]+/g, '-'), count: 100 }));
const block = ({ results = [], lines = LINE_BUCKETS, sets = null, total = null } = {}) => ({
  results: [{
    results, totalResults: total == null ? results.length : total,
    aggregations: { productLineName: lines, ...(sets ? { setName: sets } : {}) },
  }],
});
/** A cold marketFor asks for the line roster FIRST, then the set roster, then the search. */
const seq = (...rest) => [block({}), ...rest];
/** A fetch stand-in that answers each call from a queue and records the bodies it was sent. */
function fakeFetch(queue) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === 'fail') throw new Error('socket hang up');
    if (next === 'http500') return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => next };
  };
  impl.calls = calls;
  return impl;
}
const NOW = Date.parse('2026-10-16T08:30:00Z');
const at = (ms = 0) => () => NOW + ms;

beforeEach(() => _resetCaches());

// ---------------------------------------------------------------------------------------------
describe('the route does not drift from the bakes that already use it', () => {
  // Three bakes reach this same endpoint with these same browser headers. This module is the
  // single home for the per-card lookup, but they keep their own paging loops — so if TCGplayer
  // moves the endpoint, these are the four places, and this test is what says so out loud.
  const BAKES = [
    'scripts/build-riftbound-prices.mjs',
    'scripts/build-pokemon-mep.mjs',
    'scripts/build-onepiece-tcgimages.mjs',
  ];
  for (const f of BAKES) {
    it(f + ' posts to the same endpoint with the same Origin and Referer', () => {
      const src = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
      assert.ok(src.includes(TCGP_SEARCH_URL), f + ' no longer uses ' + TCGP_SEARCH_URL);
      assert.ok(src.includes(TCGP_HEADERS.Origin), f + ' no longer sends Origin ' + TCGP_HEADERS.Origin);
      assert.ok(src.includes(TCGP_HEADERS.Referer), f + ' no longer sends Referer ' + TCGP_HEADERS.Referer);
      // The browser-UA shape is what gets a Node fetch past the filtering; the version may be
      // bumped without meaning anything, so only the shape is pinned.
      assert.ok(/User-Agent'?"?:\s*'Mozilla\/5\.0/.test(src), f + ' no longer sends a browser User-Agent');
    });
  }

  it('asks for a stable page order, never the default sales ranking', () => {
    // The ranking moves between requests — it cost the Riftbound bake real products mid-page.
    assert.deepEqual(searchBody({ line: 'Pokemon' }).sort, { field: 'product-sorting-name', order: 'asc' });
  });

  it('a product-id lookup needs no sort at all', () => {
    assert.deepEqual(searchBody({ productId: 1479 }).sort, {});
    assert.deepEqual(searchBody({ productId: 1479 }).filters.term, { productId: [1479] });
  });

  it('puts the search text in the query string, not the filter body', () => {
    assert.equal(searchUrl('Charizard ex'), TCGP_SEARCH_URL + '?q=Charizard%20ex&isList=false');
    assert.deepEqual(searchBody({ line: 'Pokemon', setSlug: 'sv-151' }).filters.term,
      { productLineName: ['Pokemon'], setName: ['sv-151'] });
  });

  it('every game key lib/normalize.mjs maps prices for has a product line', () => {
    // A new game added to the price collector without a line here would lose its reference figure
    // silently; this is the reminder, by name.
    const src = readFileSync(new URL('../../lib/normalize.mjs', import.meta.url), 'utf8');
    const mappers = src.slice(src.indexOf('const MAPPERS = {'));
    for (const g of ['pokemon', 'mtg', 'lorcana', 'riftbound', 'swu', 'onepiece']) {
      assert.ok(new RegExp('^  ' + g + '\\(', 'm').test(mappers), 'normalize.mjs no longer maps ' + g);
      assert.ok(GAME_LINES[g], 'GAME_LINES has no product line for ' + g);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('numbersMatch — the denominator is a display concern (GR10)', () => {
  it('a bare numerator matches a printed number', () => {
    assert.equal(numbersMatch('199/165', '199'), true);     // pokemontcg.io gives 199, TCGplayer 199/165
    assert.equal(numbersMatch('42/204', '42'), true);
    assert.equal(numbersMatch('263/298', '263'), true);
  });
  it('padding does not matter on either side', () => {
    assert.equal(numbersMatch('010/252', '10'), true);
    assert.equal(numbersMatch('004/165', '4/165'), true);
    assert.equal(numbersMatch('106/86', '106/086'), true);  // the legacy and card-exact forms
  });
  it('two full numbers must agree on BOTH halves', () => {
    // SWU's prerelease promo is 001/002 and the main-set card is 001/252. Treating them as one
    // card prices a A$1.88 promo as a main-set single, or the reverse.
    assert.equal(numbersMatch('001/002', '001/252'), false);
    assert.equal(numbersMatch('199/165', '199/205'), false);
  });
  it('a different card is never a match', () => {
    assert.equal(numbersMatch('199/165', '198'), false);
    assert.equal(numbersMatch('100', '10'), false);         // leading-zero stripping must not eat 100
    assert.equal(numbersMatch('OP01-003', 'OP01-004'), false);
  });
  it('One Piece and subset prefixes survive', () => {
    assert.equal(numbersMatch('OP01-003', 'OP01-003'), true);
    assert.equal(numbersMatch('OP01-003', 'OP01-3'), true);
    assert.equal(numbersMatch('TG01/TG30', 'TG01'), true);
  });
  it('a missing number on either side is not a match', () => {
    assert.equal(numbersMatch(null, '199'), false);
    assert.equal(numbersMatch('199', ''), false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('card rows against sealed rows', () => {
  it('a collector number is what makes a row a card', () => {
    assert.equal(isCardRow(card()), true);
    assert.equal(isCardRow(card({ number: null })), false);
    assert.equal(isCardRow(card({ sealed: true })), false);
  });
  it('the starter deck TCGplayer calls unsealed is still not a card', () => {
    // It was the top hit for "Monkey D. Luffy OP01-003" at US$26.86, with sealed:false.
    assert.equal(STARTER_DECK.sealed, false);
    assert.equal(isCardRow(STARTER_DECK), false);
    assert.equal(isSealedRow(STARTER_DECK), true);
  });
  it('a card is not sealed product', () => assert.equal(isSealedRow(card()), false));
  it('a zero or missing market price is no price', () => {
    assert.equal(marketOf(card({ marketPrice: 0 })), null);
    assert.equal(marketOf(card({ marketPrice: null })), null);
    assert.equal(marketOf(card({ marketPrice: 322.27 })), 322.27);
  });
  it('every matched product carries a deep link', () => {
    assert.equal(productUrl(card()), 'https://www.tcgplayer.com/product/517045');
    assert.equal(productUrl({}), null);
    assert.equal(rowOut(card()).url, 'https://www.tcgplayer.com/product/517045');
  });
});

// ---------------------------------------------------------------------------------------------
describe('pickRow — it never picks between printings', () => {
  it('one card at the number is the answer', () => {
    const r = pickRow([card()], { number: '199', name: 'Charizard ex' });
    assert.equal(r.row.productId, 517045);
  });
  it('two printings at one number is a QUESTION, not a figure', () => {
    // US$5.01 against US$1,023.34. Answering with either is a 200x error either way.
    const r = pickRow([LUFFY_BASE, LUFFY_PARALLEL], { number: 'OP01-003', name: 'Monkey.D.Luffy' });
    assert.equal(r.row, undefined);
    assert.equal(r.code, 'ambiguous');
    assert.equal(r.candidates.length, 2);
  });
  it('an exactly-matching name breaks the tie only when it is unique', () => {
    const r = pickRow([LUFFY_BASE, LUFFY_PARALLEL], { number: 'OP01-003', name: 'Monkey.D.Luffy (003)' });
    assert.equal(r.row.productId, 454515);
  });
  it('a name with no number is a question once more than one card answers to it', () => {
    const rows = [card({ productId: 1, number: '6/165' }), card({ productId: 2, number: '183/165' })];
    assert.equal(pickRow(rows, { name: 'Charizard ex' }).code, 'needs_number');
    assert.equal(pickRow([rows[0]], { name: 'Charizard ex' }).row.productId, 1);
  });
  it('a number that matches nothing is a blank, not the nearest row', () => {
    const rows = [card({ productId: 1, number: '6/165' }), card({ productId: 2, number: '183/165' })];
    const r = pickRow(rows, { number: '9999', name: 'Charizard ex' });
    assert.equal(r.row, undefined);
    assert.equal(r.code, 'no_number_match');
    assert.equal(r.candidates.length, 2);        // what TCGplayer DOES price, so the gap is visible
  });
  it('a card search skips the sealed deck entirely', () => {
    const r = pickRow([STARTER_DECK, LUFFY_BASE], { number: 'OP01-003', name: 'Monkey.D.Luffy' });
    assert.equal(r.row.productId, 454515);
  });
  it('a sealed search matches on name and skips the cards', () => {
    const r = pickRow([STARTER_DECK, LUFFY_BASE], { kind: 'sealed', name: 'Starter Deck 31: RED Monkey.D.Luffy' });
    assert.equal(r.row.productId, 704885);
  });
  it('nothing at all is no_match', () => assert.equal(pickRow([], {}).code, 'no_match'));
});

// ---------------------------------------------------------------------------------------------
describe('comparison — integer cents, converted exactly once (GR3)', () => {
  it('our price as a percentage of market, and the direction in words', () => {
    const c = comparison({ marketUsd: 322.27, rate: 1.52, ourCents: 42000 });
    assert.equal(c.marketUsdCents, 32227);
    assert.equal(c.marketAudCents, 48985);                 // round(322.27 * 1.52 * 100)
    assert.equal(c.pctOfMarket, 85.7);
    assert.equal(c.deltaPct, -14.3);
    assert.equal(c.stance, 'below');
    assert.equal(c.words, '14.3% below TCGplayer market');
  });
  it('above market says so', () => {
    const c = comparison({ marketUsd: 10, rate: 1.5, ourCents: 1800 });   // A$15 market, A$18 ours
    assert.equal(c.pctOfMarket, 120);
    assert.equal(c.stance, 'above');
    assert.equal(c.words, '20.0% above TCGplayer market');
  });
  it('level is level, not 0.1% below', () => {
    const c = comparison({ marketUsd: 10, rate: 1.5, ourCents: 1500 });
    assert.equal(c.stance, 'at');
    assert.equal(c.words, 'level with TCGplayer market');
  });
  it('every money field is an integer number of cents', () => {
    for (const usd of [0.33, 1.015, 322.27, 1023.34]) {
      const c = comparison({ marketUsd: usd, rate: 1.5234, ourCents: 999 });
      assert.equal(c.marketUsdCents, Math.round(usd * 100));
      assert.ok(Number.isInteger(c.marketAudCents), usd + ' gave a fractional cent');
    }
  });
  it('no rate means no A$ figure and no comparison — never a silently wrong one', () => {
    const c = comparison({ marketUsd: 322.27, rate: null, ourCents: 42000 });
    assert.equal(c.marketAudCents, null);
    assert.equal(c.pctOfMarket, null);
    assert.equal(c.words, WHY.no_rate);
    assert.ok(/US dollars only/.test(c.words));
  });
  it('no figure of ours is not an error', () => {
    const c = comparison({ marketUsd: 322.27, rate: 1.52, ourCents: null });
    assert.equal(c.marketAudCents, 48985);
    assert.equal(c.pctOfMarket, null);
  });
  it('no market price gives nothing to compare against', () => {
    const c = comparison({ marketUsd: null, rate: 1.52, ourCents: 42000 });
    assert.equal(c.marketUsdCents, null);
    assert.equal(c.marketAudCents, null);
    assert.equal(c.pctOfMarket, null);
  });
  it('a nonsense rate or price is refused rather than propagated', () => {
    assert.equal(comparison({ marketUsd: -5, rate: 1.5, ourCents: 100 }).marketUsdCents, null);
    assert.equal(comparison({ marketUsd: 10, rate: 0, ourCents: 100 }).marketAudCents, null);
    assert.equal(comparison({ marketUsd: NaN, rate: 1.5, ourCents: 100 }).marketUsdCents, null);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the browser's copy of the maths agrees with the server's (GR9)", () => {
  // extras.js is a classic script and cannot import the ESM module, so TCG.tcgpCompare is a
  // mirror of comparison(). Two copies of a money calculation is exactly the kind of pair this
  // repo pins with a test rather than a comment.
  function bootExtras(rate) {
    const sandbox = {
      document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }), head: { appendChild() {} } },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ date: '2026-10-16', rates: { AUD: rate } }) }),
      setTimeout, clearTimeout, console, Date, Math, JSON, URLSearchParams, Image: function () {},
    };
    sandbox.window = sandbox;
    sandbox.screen = { availWidth: 2560, availHeight: 1400, availLeft: 0, availTop: 0 };
    sandbox.window.open = () => null;
    vm.createContext(sandbox);
    vm.runInContext(read('extras.js'), sandbox);
    return sandbox.window.TCG;
  }

  const VECTORS = [
    { marketUsd: 322.27, ourCents: 42000 },
    { marketUsd: 0.32, ourCents: 149 },
    { marketUsd: 1023.34, ourCents: 180000 },
    { marketUsd: 10, ourCents: 1500 },
    { marketUsd: 4.75, ourCents: 724 },
  ];
  const RATE = 1.5234;

  it('every vector gives the same cents, percentage and words in both copies', async () => {
    const TCG = bootExtras(RATE);
    await TCG.loadFx();
    for (const v of VECTORS) {
      const server = comparison({ marketUsd: v.marketUsd, rate: RATE, ourCents: v.ourCents });
      const browser = TCG.tcgpCompare(v.marketUsd, v.ourCents);
      assert.equal(browser.marketUsdCents, server.marketUsdCents, 'usd cents ' + v.marketUsd);
      assert.equal(browser.marketAudCents, server.marketAudCents, 'aud cents ' + v.marketUsd);
      assert.equal(browser.pctOfMarket, server.pctOfMarket, 'pct ' + v.marketUsd);
      assert.equal(browser.stance, server.stance, 'stance ' + v.marketUsd);
      assert.equal(browser.words, server.words, 'words ' + v.marketUsd);
    }
  });

  it('with no rate the browser copy also refuses to show an A$ figure', () => {
    const TCG = bootExtras(1.5);                  // loadFx NOT awaited: no rates yet
    const browser = TCG.tcgpCompare(322.27, 42000);
    assert.equal(browser.marketAudCents, null);
    assert.equal(browser.pctOfMarket, null);
    assert.equal(browser.words, comparison({ marketUsd: 322.27, rate: null, ourCents: 42000 }).words);
  });
});

// ---------------------------------------------------------------------------------------------
describe('resolveLine — the product line comes from the API, never from our constant', () => {
  it('matches our candidate name against the live aggregation', async () => {
    const f = fakeFetch([block({})]);
    const r = await resolveLine('riftbound', { fetchImpl: f, now: at() });
    assert.equal(r.line, GAME_LINES.riftbound);
    assert.deepEqual(f.calls[0].body.filters.term, {});        // the whole catalogue, for its buckets
  });
  it('a line TCGplayer has renamed is reported, not guessed at', async () => {
    // The hazard this guards: a productLineName that is not the FULL display value is silently
    // IGNORED and the API answers with ~500k products from every line. A stale constant must
    // read as "no coverage", never as a filter that did nothing.
    const f = fakeFetch([block({ lines: [{ value: 'Riftbound', urlValue: 'riftbound', count: 1 }] })]);
    const r = await resolveLine('riftbound', { fetchImpl: f, now: at() });
    assert.equal(r.line, null);
    assert.equal(r.code, 'line_gone');
    assert.ok(/no longer lists a product line/.test(r.why));
  });
  it('a game we do not price says why in its own words', async () => {
    const r = await resolveLine('pokemon-jp', { fetchImpl: fakeFetch([block({})]), now: at() });
    assert.equal(r.code, 'no_coverage');
    assert.equal(r.why, NO_COVERAGE_WORDS['pokemon-jp']);
    assert.ok(/eBay AU is the reference/.test(r.why));
  });
  it('an unreachable API is an outage, not a missing line', async () => {
    const r = await resolveLine('pokemon', { fetchImpl: fakeFetch(['fail']), now: at() });
    assert.equal(r.code, 'upstream_down');
  });
  it('the roster is held for an hour, not re-fetched per card', async () => {
    const f = fakeFetch([block({})]);
    await resolveLine('pokemon', { fetchImpl: f, now: at() });
    await resolveLine('mtg', { fetchImpl: f, now: at(60_000) });
    assert.equal(f.calls.length, 1);
    await resolveLine('mtg', { fetchImpl: f, now: at(61 * 60 * 1000) });
    assert.equal(f.calls.length, 2);
  });
});

describe('resolveSetSlug — matched by name, never constructed', () => {
  const SETS = [
    { value: 'SV: Scarlet & Violet 151', urlValue: 'sv-scarlet-and-violet-151' },
    { value: 'The First Chapter', urlValue: 'the-first-chapter' },
    { value: 'Fabled', urlValue: 'fabled' },
  ];
  it('an exact name wins', async () => {
    const f = fakeFetch([block({ sets: SETS })]);
    assert.equal(await resolveSetSlug('Pokemon', 'The First Chapter', { fetchImpl: f, now: at() }), 'the-first-chapter');
  });
  it('our set name may carry a prefix TCGplayer does not', async () => {
    // The builder writes 'Scarlet & Violet 151'; TCGplayer writes 'SV: Scarlet & Violet 151'.
    const f = fakeFetch([block({ sets: SETS })]);
    assert.equal(await resolveSetSlug('Pokemon', 'Scarlet & Violet 151', { fetchImpl: f, now: at() }), 'sv-scarlet-and-violet-151');
  });
  it('an ambiguous or unknown set widens to the whole line rather than guessing', async () => {
    const f = fakeFetch([block({ sets: [{ value: 'Set A One', urlValue: 'a1' }, { value: 'Set A Two', urlValue: 'a2' }] })]);
    assert.equal(await resolveSetSlug('Pokemon', 'Set A', { fetchImpl: f, now: at() }), null);
    _resetCaches();
    const g = fakeFetch([block({ sets: SETS })]);
    assert.equal(await resolveSetSlug('Pokemon', 'A Set That Is Not There', { fetchImpl: g, now: at() }), null);
  });
});

// ---------------------------------------------------------------------------------------------
describe('marketFor — one answer shape, and never a confident wrong number', () => {
  it('prices a card matched on set and number', async () => {
    const f = fakeFetch(seq(block({ sets: [{ value: 'SV: Scarlet & Violet 151', urlValue: 'sv-151' }] }), block({ results: [card()] })));
    const r = await marketFor({ game: 'pokemon', name: 'Charizard ex', number: '199', setName: 'SV: Scarlet & Violet 151' }, { fetchImpl: f, now: at() });
    assert.equal(r.market, 322.27);
    assert.equal(r.currency, 'USD');
    assert.equal(r.matchedBy, 'set+number');
    assert.equal(r.setName, 'SV: Scarlet & Violet 151');
    assert.equal(r.number, '199/165');
    assert.equal(r.url, 'https://www.tcgplayer.com/product/517045');
    assert.equal(r.fetchedAt, new Date(NOW).toISOString());
    assert.equal(r.code, undefined);
  });

  it('a product id skips matching entirely — the MTG route', async () => {
    // Scryfall's tcgplayer_id IS TCGplayer's productId. Revised Edition carries a NULL collector
    // number, so the card guard must not apply on this path or Magic's old sets go unpriceable.
    const f = fakeFetch([block({}), block({ results: [card({ productId: 1479, productName: 'Lightning Bolt', setName: 'Revised Edition', productLineName: 'Magic: The Gathering', number: null, marketPrice: 2.39 })] })]);
    const r = await marketFor({ game: 'mtg', productId: 1479 }, { fetchImpl: f, now: at() });
    assert.equal(r.market, 2.39);
    assert.equal(r.matchedBy, 'product-id');
    assert.equal(r.url, 'https://www.tcgplayer.com/product/1479');
    assert.deepEqual(f.calls[1].body.filters.term, { productId: [1479] });
  });

  it('THE UNFILTERED-CATALOGUE GUARD: rows from another line are not this card', async () => {
    // When the API ignores the filter it answers 200 with every line at once. Those rows must
    // never be priced as the card we asked for.
    const f = fakeFetch(seq(block({ sets: [{ value: 'Origins', urlValue: 'origins' }] }), block({ results: [card({ productLineName: 'Pokemon', number: '263/298', marketPrice: 999 })] })));
    const r = await marketFor({ game: 'riftbound', name: 'Teemo', number: '263', setName: 'Origins' }, { fetchImpl: f, now: at() });
    assert.equal(r.market, null);
    assert.equal(r.code, 'no_match');
    assert.ok(r.why.length > 10);
  });

  it('two printings at one number come back as candidates with a sentence', async () => {
    const f = fakeFetch(seq(block({ sets: [{ value: 'Romance Dawn', urlValue: 'romance-dawn' }] }), block({ results: [LUFFY_BASE, LUFFY_PARALLEL] })));
    const r = await marketFor({ game: 'onepiece', name: 'Monkey.D.Luffy', number: 'OP01-003', setName: 'Romance Dawn' }, { fetchImpl: f, now: at() });
    assert.equal(r.market, null);
    assert.equal(r.code, 'ambiguous');
    assert.equal(r.candidates.length, 2);
    assert.deepEqual(r.candidates.map((c) => c.market).sort((a, b) => a - b), [5.01, 1023.34]);
    assert.ok(r.candidates.every((c) => c.url), 'a candidate the operator must choose between needs its link');
  });

  it('a card TCGplayer lists but does not price yet says exactly that', async () => {
    const f = fakeFetch(seq(block({ sets: [{ value: 'X', urlValue: 'x' }] }), block({ results: [card({ marketPrice: null })] })));
    const r = await marketFor({ game: 'pokemon', name: 'Charizard ex', number: '199', setName: 'X' }, { fetchImpl: f, now: at() });
    assert.equal(r.market, null);
    assert.equal(r.code, 'no_price');
    assert.ok(/normal for a few weeks after release/.test(r.why));
    assert.equal(r.productId, 517045);           // still a real product, still linkable
  });

  it('the set is reported when it could not be matched, so a line-wide hit is visible', async () => {
    const f = fakeFetch(seq(block({ sets: [{ value: 'Some Other Set', urlValue: 'other' }] }), block({ results: [card()] })));
    const r = await marketFor({ game: 'pokemon', name: 'Charizard ex', number: '199', setName: 'A Set Not On TCGplayer' }, { fetchImpl: f, now: at() });
    assert.equal(r.matchedBy, 'line+number');
    assert.equal(r.setMatched, false);
    assert.equal(r.setName, 'SV: Scarlet & Violet 151');   // the operator can see what was priced
  });

  it('never throws, whatever the upstream does', async () => {
    for (const bad of ['fail', 'http500']) {
      const r = await marketFor({ game: 'pokemon', name: 'X', number: '1' }, { fetchImpl: fakeFetch([bad]), now: at() });
      assert.equal(r.market, null);
      assert.equal(r.code, 'upstream_down');
      assert.ok(/Nothing else on this page is affected/.test(r.why));
      _resetCaches();
    }
  });

  it('a missing game or name is answered, not thrown', async () => {
    const f = fakeFetch([block({})]);
    assert.equal((await marketFor({}, { fetchImpl: f, now: at() })).code, 'no_game');
    assert.equal((await marketFor({ game: 'pokemon' }, { fetchImpl: f, now: at() })).code, 'no_query');
    assert.equal((await marketFor(undefined, { fetchImpl: f, now: at() })).code, 'no_game');
  });

  it('EVERY blank carries a sentence — a silent dash is the defect', async () => {
    // The rule this page set in commit 78be980: an unexplained blank reads as a failed fetch.
    for (const key of Object.keys(WHY)) {
      const w = typeof WHY[key] === 'function' ? WHY[key]('x') : WHY[key];
      assert.equal(typeof w, 'string', key + ' is not a sentence');
      assert.ok(w.length > 20, key + ' is too terse to explain anything: ' + w);
      assert.ok(/[.!]$/.test(w.trim()), key + ' does not read as a sentence: ' + w);
    }
  });

  it('a sealed line prices sealed product, not the cards inside it', async () => {
    const f = fakeFetch(seq(block({ sets: [{ value: 'ST-31', urlValue: 'st-31' }] }), block({ results: [STARTER_DECK, LUFFY_BASE] })));
    const r = await marketFor({ game: 'onepiece', kind: 'sealed', name: 'Starter Deck 31: RED Monkey.D.Luffy', setName: 'ST-31' }, { fetchImpl: f, now: at() });
    assert.equal(r.market, 26.86);
    assert.equal(r.matchedBy, 'sealed-name');
  });
});

// ---------------------------------------------------------------------------------------------
describe('caching — an undocumented private endpoint is not hammered', () => {
  it('a repeat question inside the TTL is served from memory', async () => {
    const f = fakeFetch(seq(block({ sets: [{ value: 'X', urlValue: 'x' }] }), block({ results: [card()] })));
    const req = { game: 'pokemon', name: 'Charizard ex', number: '199', setName: 'X' };
    const a = await marketForCached(req, { fetchImpl: f, now: at() });
    const b = await marketForCached(req, { fetchImpl: f, now: at(60_000) });
    assert.equal(a.cacheState, 'upstream');
    assert.equal(b.cacheState, 'memory');
    assert.equal(b.payload.market, 322.27);
    const callsBefore = f.calls.length;
    await marketForCached(req, { fetchImpl: f, now: at(ANSWER_TTL_MS + 1) });
    assert.ok(f.calls.length > callsBefore, 'a past-TTL answer should be re-asked');
  });

  it('an outage is NOT cached — the next look tries again', async () => {
    const f = fakeFetch(['fail']);
    const req = { game: 'pokemon', name: 'X', number: '1' };
    assert.equal((await marketForCached(req, { fetchImpl: f, now: at() })).payload.code, 'upstream_down');
    const second = await marketForCached(req, { fetchImpl: f, now: at(1000) });
    assert.equal(second.cacheState, 'upstream');
  });

  it('refresh=1 goes upstream even on a warm cache', async () => {
    const f = fakeFetch(seq(block({ sets: [{ value: 'X', urlValue: 'x' }] }), block({ results: [card()] })));
    const req = { game: 'pokemon', name: 'Charizard ex', number: '199', setName: 'X' };
    await marketForCached(req, { fetchImpl: f, now: at() });
    const r = await marketForCached(req, { fetchImpl: f, now: at(1000), refresh: true });
    assert.equal(r.cacheState, 'upstream');
  });

  it('the same question asked twice at once is one lookup', async () => {
    const f = fakeFetch(seq(block({ sets: [{ value: 'X', urlValue: 'x' }] }), block({ results: [card()] })));
    const req = { game: 'pokemon', name: 'Charizard ex', number: '199', setName: 'X' };
    const [a, b] = await Promise.all([
      marketForCached(req, { fetchImpl: f, now: at() }),
      marketForCached(req, { fetchImpl: f, now: at() }),
    ]);
    assert.equal(a.payload.market, 322.27);
    assert.equal(b.payload.market, 322.27);
  });

  it('the cache key ignores padding and case but not the card', () => {
    assert.equal(cacheKey({ game: 'Pokemon', name: 'Charizard EX', number: '004' }), cacheKey({ game: 'pokemon', name: 'charizard ex', number: '4' }));
    assert.notEqual(cacheKey({ game: 'pokemon', name: 'A', number: '4' }), cacheKey({ game: 'pokemon', name: 'A', number: '5' }));
    assert.notEqual(cacheKey({ game: 'pokemon', name: 'A', number: '4' }), cacheKey({ game: 'pokemon', name: 'A', number: '4', kind: 'sealed' }));
  });
  it('normName folds the whitespace a typed field collects', () => {
    assert.equal(normName('  Charizard   ex '), 'charizard ex');
    assert.equal(normName(null), '');
  });
});

// ---------------------------------------------------------------------------------------------
describe('the boundary: display only (owner decision 2026-10-16)', () => {
  // The whole point of the feature is that it does NOT change what anything costs. A later import
  // into either of these is the one thing that would turn a reference figure into an automatic
  // price, so it fails here rather than in production.
  const forbidden = ['lib/pricing.mjs', 'lib/repricer.mjs', 'lib/repricer-decide.mjs', 'lib/repricer-propose.mjs', 'lib/repricer-scan.mjs', 'lib/repricer-db.mjs'];
  for (const f of forbidden) {
    it(f + ' does not import the TCGplayer reference', () => {
      const src = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
      assert.ok(!/tcgplayer-market/.test(src),
        f + ' imports lib/tcgplayer-market.mjs. TCGplayer is DISPLAY ONLY — it must not enter pricing precedence or become a repricer anchor.');
    });
  }
  it('the module itself pulls in neither the pricing engine nor the repricer', () => {
    const src = readFileSync(new URL('../../lib/tcgplayer-market.mjs', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .*?from '(.+?)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports.filter((i) => /pricing|repricer/.test(i)), []);
  });
});
