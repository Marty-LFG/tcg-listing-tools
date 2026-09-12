// test/unit/arb-core.test.mjs — the pure arbitrage engine (lib/arb-core.mjs).
//
// Every rule that decides money is pinned here against the live Browse fixture captured on
// 2026-09-12 (test/fixtures/arbitrage/browse-sv3-125.json — one row per shape the filter must
// handle) and against the title vectors that bit during Phase 0. A filter that lets a PSA 10
// through or scores an unmarked common at the reverse-holo price is a real purchase gone wrong,
// so the assertions read as the rule, not as the implementation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';
import {
  ARB_FILTER, QUERY_MODES, buildScanQuery, numberMatcher, matchTier, setMentionRe,
  isGradedListing, classifyTitleCondition, titleFinish, scoringMarket, rowFromBrowse, filterListing,
  hitMaths, qualifies, marketAgeDays, warningsFor, alertable, rankHits, reconcileHits, canTransition,
  findCards, printingsWithSource, resolveCard, toCents,
  titleNumbers, nameToken, titleNamesCard, buildSetIndex, matchTitleToCard, sweepQuery, foldText,
} from '../../lib/arb-core.mjs';

const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/arbitrage/browse-sv3-125.json'), 'utf8'));
const rowsByTitle = (re) => FIX.itemSummaries.filter((it) => re.test(it.title)).map(rowFromBrowse);

// Charizard ex 125/197, Obsidian Flames — the shape lib/pkm-cards-cache.mjs serves.
const CHARIZARD = {
  id: 'sv3-125', name: 'Charizard ex', number: '125', rarity: 'Double Rare',
  set: { id: 'sv3', name: 'Obsidian Flames', printedTotal: 197, total: 230, ptcgoCode: 'OBF' },
  tcgplayer: { updatedAt: '2026/08/15', prices: { holofoil: { low: 3.11, mid: 6, high: 99, market: 5.46 } } },
};
// Umbreon 130/197 — two printings, and the reverse is ten times the normal.
const UMBREON = {
  id: 'sv3-130', name: 'Umbreon', number: '130', rarity: 'Uncommon',
  set: { id: 'sv3', name: 'Obsidian Flames', printedTotal: 197, ptcgoCode: 'OBF' },
  tcgplayer: { updatedAt: '2026/09/11', prices: { normal: { market: 0.34, mid: 0.4, low: 0.1 }, reverseHolofoil: { market: 3.16, mid: 3.5, low: 2 } } },
};

describe('buildScanQuery', () => {
  it('the default wording is the comps engine\'s own, with the three structural filters', () => {
    const q = buildScanQuery(CHARIZARD);
    assert.equal(q.q, 'Pokemon Charizard ex 125 Obsidian Flames');
    assert.equal(q.filter, ARB_FILTER);
    assert.match(q.path, /^\/api\/ebay\/buy\/browse\/v1\/item_summary\/search\?/);
    assert.match(decodeURIComponent(q.path), /buyingOptions:\{FIXED_PRICE\},itemLocationCountry:AU,conditionIds:\{4000\}/);
    assert.match(q.path, /category_ids=183454/);
    assert.match(q.path, /limit=100/);
  });
  it('no exclusion term ever reaches the query — eBay flips to literal matching on the first one', () => {
    for (const mode of QUERY_MODES) assert.doesNotMatch(buildScanQuery(CHARIZARD, { queryMode: mode }).q, /(^|\s)-\w/);
  });
  it('short drops the set name and slash writes number/printedTotal', () => {
    assert.equal(buildScanQuery(CHARIZARD, { queryMode: 'short' }).q, 'Pokemon Charizard ex 125');
    assert.equal(buildScanQuery(CHARIZARD, { queryMode: 'slash' }).q, 'Pokemon Charizard ex 125/197');
  });
});

describe('number matching — strict, or bare with the set named', () => {
  const m = numberMatcher(CHARIZARD);
  it('number/printedTotal is strict', () => {
    assert.equal(matchTier('Charizard ex - 125/197 - Double Rare - Obsidian Flames', m), 'strict');
    assert.equal(matchTier('Charizard ex #125/197 PSA', m), 'strict');
    assert.equal(matchTier('CHARIZARD EX 125 / 197', m), 'strict');
  });
  it('a bare number needs the set beside it', () => {
    assert.equal(matchTier('Pokémon Obsidian Flames Charizard ex 125', m), 'set');
    assert.equal(matchTier('Charizard ex 125 OBF holo', m), 'set');
    assert.equal(matchTier('Charizard ex 125 SV03 Double Rare', m), 'set');
    assert.equal(matchTier('Charizard ex 125 sv3', m), 'set');
  });
  it('the measured failure: the same number in another set is NOT this card', () => {
    assert.equal(matchTier('Mega Charizard X ex 125/094 Phantasmal Flames', m), null);
    assert.equal(matchTier('Mega Charizard X EX 223/193 - NM/M', numberMatcher({ ...CHARIZARD, number: '223' })), null);
    assert.equal(matchTier('Charizard ex 125', m), null, 'bare number, no set');
  });
  it('the Japanese twin (same set name, different printed total) is strict-rejected', () => {
    assert.equal(matchTier('Pokemon Charizard ex(SR) 125/108 SV3 Obsidian Flames', m), 'set',
      'a JP title that names the set passes the number gate — the language gate is what drops it');
  });
  it('a letter-prefixed number is its own identity, never its bare digits (TG01 ≠ 1/195)', () => {
    const tg = numberMatcher({ number: 'TG01', set: { id: 'swsh12', name: 'Silver Tempest', printedTotal: 195 } });
    assert.equal(matchTier('Pikachu 1/195 Silver Tempest', tg), null, 'the bug: bare digits matched any card numbered 1');
    assert.equal(matchTier('Flareon TG01/TG30 Silver Tempest', tg), 'strict');
    assert.equal(matchTier('Flareon TG1 Trainer Gallery', tg), 'strict');
    assert.equal(matchTier('Flareon TG 01', tg), 'strict');
    const promo = numberMatcher({ number: 'SWSH039', set: { id: 'swshp', name: 'SWSH Black Star Promos' } });
    assert.equal(matchTier('Pikachu SWSH39 promo', promo), 'strict');
    assert.equal(matchTier('Pikachu 39/200', promo), null);
  });
  it('setMentionRe covers name, ptcgo code and zero-padded id', () => {
    const re = setMentionRe(CHARIZARD);
    for (const t of ['obsidian flames', 'Obsidian  Flames', 'OBF', 'sv3', 'SV03']) assert.ok(re.test(t), t);
    assert.ok(!re.test('Paldea Evolved PAL sv2'));
  });
});

describe('graded detection ignores the condition id', () => {
  it('a PSA 10 listed as conditionId 4000 is still graded (measured live)', () => {
    const [psa] = rowsByTitle(/PSA 10/);
    assert.equal(psa.condId, '4000');
    assert.equal(isGradedListing(psa), true);
  });
  it('2750 is graded whatever the title says; a plain NM title is not', () => {
    assert.equal(isGradedListing({ condId: '2750', title: 'Charizard ex 125/197' }), true);
    assert.equal(isGradedListing({ condId: '4000', title: 'Charizard ex 125/197 NM' }), false);
    assert.equal(isGradedListing({ condId: '4000', title: 'Charizard ex 125/197 slab ready' }), true);
  });
});

describe('classifyTitleCondition', () => {
  const V = [
    ['Charizard ex 125/197 NM', 'nm'],
    ['Charizard ex 125/197 Near Mint', 'nm'],
    ['Charizard ex 125/197 NM/M', 'nm'],
    ['Pikachu 125/197 pack fresh', 'nm'],
    ['Charizard ex 125/197 LP', 'lp'],
    ['Charizard ex 125/197 lightly played', 'lp'],
    ['Charizard ex 125/197 light play', 'unstated'],
    ['Charizard ex 125/197 excellent condition', 'vague'],
    ['Charizard ex 125/197 very good condition', 'vague'],
    ['Umbreon 130/197 NM no whitening', 'nm'],
    ['Umbreon 130/197 no edge wear', 'unstated'],
    ['Umbreon 130/197 free of scratches', 'unstated'],
    ['Umbreon 130/197 no damage', 'unstated'],
    ['Umbreon 130/197 whitening', 'lp'],
    ['Umbreon 130/197 slight edge wear', 'lp'],
    ['Charizard ex 125/197 MP', 'mp'],
    ['Charizard ex 125/197 moderately played', 'mp'],
    ['Charizard ex 125/197 played', 'mp'],
    ['Charizard ex unplayed 125/197', 'unstated'],
    ['Charizard ex 125/197 HP', 'hp'],
    ['Charizard ex HP 125/197', 'hp'],
    ['Charizard ex 125/197 heavily played', 'hp'],
    ['Charizard ex 330 HP 125/197', 'unstated'],
    ['Charizard ex HP 330 125/197', 'unstated'],
    ['Charizard ex 125/197 damaged', 'dmg'],
    ['Charizard ex 125/197 creased', 'dmg'],
    ['Charizard ex 125/197 NM/LP', 'lp'],
    ['Charizard ex 125/197 Double Rare Obsidian Flames', 'unstated'],
    ['Charizard ex 125/197 good condition', 'unstated'],
  ];
  for (const [title, cls] of V) it(`${JSON.stringify(title)} → ${cls}`, () => assert.equal(classifyTitleCondition(title).cls, cls));
  it('"ex" is a card type, never Excellent', () => assert.equal(classifyTitleCondition('Charizard ex 125/197').cls, 'unstated'));
  it('a Card Condition descriptor, when eBay ever sends one, overrides the title', () => {
    assert.equal(classifyTitleCondition('Charizard ex 125/197 LP', [{ name: 'Card Condition', values: [{ content: 'Near Mint or Better' }] }]).cls, 'nm');
    assert.equal(classifyTitleCondition('Charizard ex 125/197 NM', [{ name: 'Card Condition', values: [{ content: 'Excellent' }] }]).cls, 'lp');
    assert.equal(classifyTitleCondition('x', [{ name: 'Card Condition', values: [{ content: 'Poor' }] }]).cls, 'dmg');
  });
});

describe('printing from the title, and what a listing is scored against', () => {
  it('titleFinish', () => {
    assert.equal(titleFinish('Umbreon 130/197 Reverse Holo'), 'reverse');
    assert.equal(titleFinish('Umbreon 130/197 RH'), 'reverse');
    assert.equal(titleFinish('Umbreon 130/197 Holo'), 'holo');
    assert.equal(titleFinish('Umbreon 130/197 non-holo'), 'normal');
    assert.equal(titleFinish('Umbreon 130/197 Uncommon'), null);
    // "Regular Holo" is a holo — the seller is saying NOT the reverse. It was read as non-holo.
    assert.equal(titleFinish('Charizard ex 125/197 Regular Holo NM'), 'holo');
    assert.equal(titleFinish('Charizard ex 125/197 standard holo'), 'holo');
    assert.equal(titleFinish('Charizard ex 125/197 regular'), 'normal');
  });
  const P = printingsWithSource(UMBREON);
  it('a reverse-holo title is scored at the reverse price, unambiguously', () => {
    assert.deepEqual(scoringMarket(P, 'reverseHolofoil', 'Umbreon 130/197 Reverse Holo'), { key: 'reverseHolofoil', marketUsd: 3.16, ambiguous: false });
  });
  it('an unmarked title on a two-printing card is scored at the CHEAPEST printing and flagged', () => {
    const s = scoringMarket(P, 'reverseHolofoil', 'Umbreon 130/197 Obsidian Flames');
    assert.equal(s.key, 'normal'); assert.equal(s.marketUsd, 0.34); assert.equal(s.ambiguous, true);
  });
  it('a title that rules the wanted printing out returns null (the caller drops the row)', () => {
    assert.equal(scoringMarket(P, 'reverseHolofoil', 'Umbreon 130/197 non holo'), null);
    assert.equal(scoringMarket(P, 'normal', 'Umbreon 130/197 reverse holo'), null);
  });
  it('"holo" on a card with no plain holofoil printing means the reverse', () => {
    assert.deepEqual(scoringMarket(P, 'reverseHolofoil', 'Umbreon 130/197 Holo'), { key: 'reverseHolofoil', marketUsd: 3.16, ambiguous: false });
  });
  it('a single-printing card is never ambiguous', () => {
    assert.deepEqual(scoringMarket(printingsWithSource(CHARIZARD), 'holofoil', 'Charizard ex 125/197'), { key: 'holofoil', marketUsd: 5.46, ambiguous: false });
  });
  it('an unpriced alternative printing makes an unmarked listing unscorable (marketUsd null)', () => {
    const half = P.map((p) => (p.key === 'normal' ? { ...p, marketUsd: null } : p));
    const s = scoringMarket(half, 'reverseHolofoil', 'Umbreon 130/197');
    assert.equal(s.marketUsd, null); assert.equal(s.ambiguous, true);
  });
  it('printingsWithSource names the field that fed marketUsd, so a low-only printing can be refused', () => {
    const card = { tcgplayer: { prices: { normal: { low: 0.5 }, holofoil: { mid: 2 }, reverseHolofoil: { market: 1 } } } };
    assert.deepEqual(printingsWithSource(card).map((p) => [p.key, p.which]), [['normal', 'low'], ['reverseHolofoil', 'market'], ['holofoil', 'mid']]);
  });
});

describe('rowFromBrowse keeps the listing identity rowFromAsk throws away', () => {
  it('itemId, url, image, seller feedback, currency, listed date', () => {
    const [r] = rowsByTitle(/NM\/M$/);
    assert.equal(r.itemId, 'v1|287460438921|0');
    assert.equal(r.legacyItemId, '287460438921');
    assert.match(r.url, /^https:\/\/www\.ebay\.com\.au\/itm\/287460438921/);
    assert.match(r.image, /^https:\/\/i\.ebayimg\.com\//);
    assert.equal(r.price, 9.99); assert.equal(r.currency, 'AUD'); assert.equal(r.ship, 0);
    assert.equal(r.seller, 'gettin_gains'); assert.equal(r.sellerFbPct, 99.9); assert.equal(r.sellerFbScore, 13059);
    assert.equal(r.loc, 'AU'); assert.equal(r.auction, false); assert.equal(r.bestOffer, true);
    assert.equal(r.listedAt, '2026-07-14T08:34:39.000Z');
    assert.equal(r.condDescriptors, null, 'no descriptor on any summary row — the title is the whole signal');
  });
  it('a coupon row is flagged, not dropped', () => { const [r] = rowsByTitle(/\[OBF 125\/197\]/); assert.equal(r.coupon, true); });
  it('no price → null', () => assert.equal(rowFromBrowse({ title: 'x' }), null));
});

describe('filterListing on the live fixture', () => {
  const { printings, chosen } = resolveCard(CHARIZARD, null);
  const ctx = { matcher: numberMatcher(CHARIZARD), printings, wantedKey: chosen.key, sellerMinPct: 95, sellerMinScore: 10, excludeSeller: 'omg.its.alcatrazz' };
  const verdict = (re) => filterListing(rowsByTitle(re)[0], ctx);
  it('keeps the plain NM listing, strict match', () => { const f = verdict(/NM\/M$/); assert.equal(f.ok, true); assert.equal(f.tier, 'strict'); assert.equal(f.cond.cls, 'nm'); });
  it('keeps an unstated-condition listing (chipped later, not dropped)', () => { const f = verdict(/Sv03: Obsidian Flames 125\/197 Holo Double Rare$/); assert.equal(f.ok, true); assert.equal(f.cond.cls, 'unstated'); });
  it('drops the PSA 10 that came through conditionId 4000', () => assert.equal(verdict(/PSA 10/).reason, 'graded'));
  it('drops the stamped promo variant', () => assert.equal(verdict(/Prize Stamp/).reason, 'variant'));
  it('drops the deck', () => assert.equal(verdict(/League Battle Deck/).reason, 'junk'));
  it('drops the 7-rating seller', () => assert.equal(verdict(/Tera Full Art Holo$/).reason, 'seller_fb'));
  it('drops our own listing', () => assert.equal(filterListing({ ...rowsByTitle(/NM\/M$/)[0], seller: 'OMG.its.Alcatrazz' }, ctx).reason, 'own_listing'));
  it('drops a row with no postage quote rather than treating it as free', () => assert.equal(filterListing({ ...rowsByTitle(/NM\/M$/)[0], ship: null }, ctx).reason, 'ship_unknown'));
  it('drops auctions, overseas rows and non-AUD prices', () => {
    const base = rowsByTitle(/NM\/M$/)[0];
    assert.equal(filterListing({ ...base, auction: true }, ctx).reason, 'auction');
    assert.equal(filterListing({ ...base, loc: 'US' }, ctx).reason, 'not_au');
    assert.equal(filterListing({ ...base, currency: 'USD' }, ctx).reason, 'currency');
  });
  it('drops a stated LP and names the grade', () => assert.equal(filterListing({ ...rowsByTitle(/NM\/M$/)[0], title: 'Charizard ex 125/197 LP' }, ctx).reason, 'cond_lp'));
  it('keeps "excellent condition" (casual-seller language) and marks it vague', () => {
    const f = filterListing({ ...rowsByTitle(/NM\/M$/)[0], title: 'Charizard ex 125/197 excellent condition' }, ctx);
    assert.equal(f.ok, true); assert.equal(f.cond.cls, 'vague');
    assert.equal(warningsFor({ ratio: 0.8 }, { condClass: 'vague', condEvidence: 'excellent' })[0].k, 'cond_vague');
  });
  it('a row with no seller figures cannot clear a configured floor', () => {
    const base = rowsByTitle(/NM\/M$/)[0];
    assert.equal(filterListing({ ...base, sellerFbPct: null, sellerFbScore: null }, ctx).reason, 'seller_fb');
    assert.equal(filterListing({ ...base, sellerFbPct: null, sellerFbScore: null }, { ...ctx, sellerMinPct: 0, sellerMinScore: 0 }).ok, true, 'no floor, no refusal');
  });
  it('a "Regular Holo" listing of a holofoil-only card is kept', () => {
    const f = filterListing({ ...rowsByTitle(/NM\/M$/)[0], title: 'Charizard ex 125/197 Regular Holo Obsidian Flames NM' }, ctx);
    assert.equal(f.ok, true); assert.equal(f.market.key, 'holofoil');
  });
  it('drops a Japanese title', () => assert.equal(filterListing({ ...rowsByTitle(/NM\/M$/)[0], title: 'Charizard ex 125/197 Japanese Obsidian Flames' }, ctx).reason, 'lang'));
});

describe('the money', () => {
  it('12.34 USD × 1.52 × 0.8 is 1501 cents, once, at the end', () => {
    assert.equal(hitMaths({ priceCents: 1000, shipCents: 0, marketUsdCents: 1234, fx: 1.52, buyerPct: 0.8, feeMode: 'none' }).buyerAudCents, 1501);
  });
  it('landed = price + postage + the buyer-protection fee on the item price', () => {
    const h = hitMaths({ priceCents: 5000, shipCents: 300, marketUsdCents: 6000, fx: 1.5, buyerPct: 0.8 });
    assert.equal(h.feeCents, 370, '0.30 + 8% of 20 + 6% of 30');
    assert.equal(h.deliveredCents, 5670);
    assert.equal(h.marketAudCents, 9000); assert.equal(h.buyerAudCents, 7200);
    assert.equal(h.profitCents, 1530);
    assert.equal(h.marginPct, 26.98, 'return on outlay');
    assert.equal(h.ratio, 0.63);
  });
  it('feeMode none leaves the fee out and says so', () => {
    const h = hitMaths({ priceCents: 5000, shipCents: 300, marketUsdCents: 6000, fx: 1.5, buyerPct: 0.8, feeMode: 'none' });
    assert.equal(h.feeCents, 0); assert.equal(h.deliveredCents, 5300);
  });
  it('qualifies needs BOTH floors', () => {
    const cfg = { min_profit_aud: 5, min_margin_pct: 15 };
    assert.equal(qualifies({ profitCents: 500, marginPct: 15 }, cfg), true);
    assert.equal(qualifies({ profitCents: 499, marginPct: 50 }, cfg), false, 'A$4.99 fails the A$ floor');
    assert.equal(qualifies({ profitCents: 5000, marginPct: 14.9 }, cfg), false, '14.9% fails the % floor');
    assert.equal(qualifies({ profitCents: 500, marginPct: null }, cfg), false);
  });
  it('toCents rounds once', () => { assert.equal(toCents(9.99), 999); assert.equal(toCents(0.345), 35); assert.equal(toCents(null), null); });
});

describe('warnings', () => {
  it('a quarter of market is "check printing" and blocks alerts; unstated condition does not', () => {
    const w = warningsFor({ ratio: 0.2 }, { tooGoodRatio: 0.25, condClass: 'unstated' });
    assert.deepEqual(w.map((x) => x.k), ['check_printing', 'cond_unstated']);
    assert.equal(alertable(w), false);
    assert.equal(alertable(warningsFor({ ratio: 0.6 }, { condClass: 'unstated', coupon: true })), true);
  });
  it('stale market is measured against the config age and blocks alerts', () => {
    const w = warningsFor({ ratio: 0.6 }, { marketAgeDays: 20, maxMarketAgeDays: 14 });
    assert.equal(w[0].k, 'stale_market'); assert.equal(alertable(w), false);
    assert.equal(warningsFor({ ratio: 0.6 }, { marketAgeDays: 3, maxMarketAgeDays: 14 }).length, 0);
  });
  it('marketAgeDays reads pokemontcg.io\'s slash dates', () => {
    const now = Date.parse('2026-09-12T00:00:00Z');
    assert.equal(marketAgeDays('2026/08/15', now), 28);
    assert.equal(marketAgeDays('2026-09-11T10:00:00Z', now), 0);
    assert.equal(marketAgeDays(null, now), null);
  });
});

describe('ranking, transitions and reconciliation', () => {
  it('rankHits: profit, then margin, then newest listing', () => {
    const r = rankHits([{ profit_cents: 100, margin_pct: 10, listed_at: '2026-01-01' }, { profit_cents: 300, margin_pct: 5, listed_at: '2026-01-01' }, { profit_cents: 100, margin_pct: 20, listed_at: '2026-01-02' }]);
    assert.deepEqual(r.map((x) => [x.profit_cents, x.margin_pct]), [[300, 5], [100, 20], [100, 10]]);
  });
  it('bought and dismissed are final; gone can only be dismissed', () => {
    assert.equal(canTransition('new', 'seen'), true); assert.equal(canTransition('new', 'bought'), true);
    assert.equal(canTransition('seen', 'new'), false); assert.equal(canTransition('bought', 'seen'), false);
    assert.equal(canTransition('dismissed', 'new'), false);
    assert.equal(canTransition('gone', 'dismissed'), true); assert.equal(canTransition('gone', 'bought'), false);
  });
  const now = '2026-09-12T10:00:00.000Z';
  it('a brand-new listing inserts as new; a repeat keeps its status and refreshes figures', () => {
    const r = reconcileHits({ existing: [{ id: 1, item_id: 'A', status: 'seen', last_seen: 'x' }], current: [{ item_id: 'A', profit_cents: 700 }, { item_id: 'B', profit_cents: 900 }], seenItemIds: ['A', 'B'], now, scanId: 's1' });
    assert.equal(r.inserts.length, 1); assert.equal(r.inserts[0].item_id, 'B'); assert.equal(r.inserts[0].status, 'new'); assert.equal(r.inserts[0].first_seen, now);
    assert.equal(r.updates.length, 1); assert.equal(r.updates[0].id, 1); assert.equal(r.updates[0].patch.status, undefined); assert.equal(r.updates[0].patch.profit_cents, 700);
    assert.equal(r.gone.length, 0);
  });
  it('absent after a successful scan → gone, with below_floor when it was in the results', () => {
    const r = reconcileHits({ existing: [{ id: 1, item_id: 'A', status: 'new' }, { id: 2, item_id: 'B', status: 'seen' }], current: [], seenItemIds: ['B'], now, scanId: 's2' });
    assert.deepEqual(r.gone.map((g) => [g.id, g.reason]), [[1, 'not_listed'], [2, 'below_floor']]);
  });
  it('a gone listing that comes back is seen, never new again (one alert per item, ever)', () => {
    const r = reconcileHits({ existing: [{ id: 1, item_id: 'A', status: 'gone' }], current: [{ item_id: 'A' }], seenItemIds: ['A'], now, scanId: 's3' });
    assert.equal(r.inserts.length, 0); assert.equal(r.updates[0].patch.status, 'seen'); assert.equal(r.updates[0].patch.gone_reason, null);
  });
  it('bought and dismissed rows are never marked gone and never reopened', () => {
    const r = reconcileHits({ existing: [{ id: 1, item_id: 'A', status: 'bought' }, { id: 2, item_id: 'B', status: 'dismissed' }], current: [{ item_id: 'B' }], seenItemIds: ['B'], now, scanId: 's4' });
    assert.equal(r.gone.length, 0); assert.equal(r.updates.length, 1); assert.equal(r.updates[0].patch.status, undefined);
  });
});

describe('findCards — the catch line against a set', () => {
  const cards = [CHARIZARD, UMBREON, { id: 'sv3-4', name: 'Oddish', number: '4' }, { id: 'sv3-223', name: 'Charizard ex', number: '223' }];
  it('a number finds one card, zero-padding tolerant', () => {
    assert.deepEqual(findCards(cards, { num: '004' }).map((c) => c.id), ['sv3-4']);
    assert.deepEqual(findCards(cards, { num: '125/197' }).map((c) => c.id), ['sv3-125']);
    assert.deepEqual(findCards(cards, { num: '999' }), []);
  });
  it('*name finds every card whose name contains it', () => {
    assert.deepEqual(findCards(cards, { nameQuery: 'charizard' }).map((c) => c.id), ['sv3-125', 'sv3-223']);
  });
  it('resolveCard honours the printing token and defaults to the first printing', () => {
    assert.equal(resolveCard(UMBREON, 'reverseHolofoil').chosen.key, 'reverseHolofoil');
    assert.equal(resolveCard(UMBREON, null).chosen.key, 'normal');
  });
});

describe('the newly-listed sweep — a title matched back to the catalogue on its own evidence', () => {
  const SET = { id: 'sv3', name: 'Obsidian Flames', printedTotal: 197, total: 230, ptcgoCode: 'OBF' };
  const cards = [
    { id: 'sv3-4', name: 'Oddish', number: '4', set: SET },
    { id: 'sv3-125', name: 'Charizard ex', number: '125', set: SET },
    { id: 'sv3-130', name: 'Umbreon', number: '130', set: SET },
    { id: 'sv3-223', name: 'Charizard ex', number: '223', set: SET },
    { id: 'sv3-199', name: 'Ninetales', number: '199', set: SET },
    { id: 'sv3-tg1', name: 'Flareon', number: 'TG01', set: SET },
    { id: 'sv3-88', name: "Farfetch'd", number: '88', set: SET },
    { id: 'sv3-25', name: 'Ho-Oh', number: '25', set: SET },
    { id: 'sv3-90', name: "Professor's Research", number: '90', set: SET },
  ];
  const idx = buildSetIndex(cards, SET);

  it('titleNumbers reads every number/total and the gallery forms', () => {
    assert.deepEqual(titleNumbers('Charizard ex 125/197 and Oddish 004/197 TG01/TG30').map((n) => n.num + '/' + n.total), ['125/197', '4/197', 'TG1/null']);
    assert.deepEqual(titleNumbers('booster box'), []);
  });
  it('nameToken and titleNamesCard survive punctuation and diacritics', () => {
    assert.equal(nameToken('Charizard ex'), 'charizard');
    assert.equal(nameToken("Professor's Research"), 'professors');
    assert.equal(nameToken('Mr. Mime'), 'mime');
    assert.equal(nameToken('Ho-Oh'), 'hooh');
    assert.equal(titleNamesCard("Farfetch'd 88/197 NM", "Farfetch'd"), true);
    assert.equal(titleNamesCard('HO OH 25/197', 'Ho-Oh'), true);
    assert.equal(titleNamesCard('Pokémon Pokemon 25/197', 'Ho-Oh'), false);
    assert.equal(foldText('Flabébé'), 'flabebe');
  });
  it('the strict number/total plus the name finds the card', () => {
    assert.equal(matchTitleToCard('Charizard ex - 125/197 - Double Rare - Obsidian Flames NM', idx).card.id, 'sv3-125');
    assert.equal(matchTitleToCard('CHARIZARD EX 223/197 SIR OBF', idx).card.id, 'sv3-223');
    assert.equal(matchTitleToCard('Oddish 004/197 reverse holo', idx).card.id, 'sv3-4', 'zero padding');
    assert.equal(matchTitleToCard('Flareon TG01/TG30 Trainer Gallery', idx).card.id, 'sv3-tg1');
    assert.equal(matchTitleToCard("Professor's Research 90/197", idx).card.id, 'sv3-90');
  });
  it('refuses with the reason that matters', () => {
    assert.equal(matchTitleToCard('Mega Charizard X ex 223/193 NM', idx).reason, 'other_set', 'right number, wrong printed total');
    assert.equal(matchTitleToCard('Pikachu 125/197 Obsidian Flames', idx).reason, 'name_mismatch', 'a set that shares the total, or a lot');
    assert.equal(matchTitleToCard('Rotom 150/197', idx).reason, 'unknown_number');
    assert.equal(matchTitleToCard('Obsidian Flames booster box', idx).reason, 'no_number');
    assert.equal(matchTitleToCard('Charizard ex #125 Obsidian Flames', idx).reason, 'no_number', 'a bare number is not enough evidence for a sweep');
  });
  it('a title naming two cards resolves to the first that checks out', () => {
    assert.equal(matchTitleToCard('Charizard ex 125/197 + Umbreon 130/197 both NM', idx).card.id, 'sv3-125');
    assert.equal(matchTitleToCard('Pikachu 125/197 and Umbreon 130/197', idx).card.id, 'sv3-130', 'the mismatching pair is skipped, not fatal');
  });
  it('sweepQuery wordings', () => {
    assert.equal(sweepQuery(SET, 'name'), 'Pokemon Obsidian Flames');
    assert.equal(sweepQuery(SET, 'number'), 'Pokemon 197');
    assert.equal(sweepQuery({ name: 'X' }, 'number'), null, 'no printed total, no number query');
  });
});
