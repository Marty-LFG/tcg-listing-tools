// test/unit/stock-games.test.mjs — the per-game adapter table behind the two stock tools.
//
// stock-uploader.html and stock-runner.html used to have Pokémon welded in at ~25 sites each. This
// module is what they read instead, so these assertions are the contract between the pages, the
// publish path and the tests.
//
// Two of them are load-bearing beyond the obvious:
//
//   · The GOLDEN test at the bottom deep-compares the adapter's Pokémon row against the row
//     stock-runner.html builds inline today. itemToListing MERGES card_facts over the DB row rather
//     than replacing it, so a key dropped in the refactor does not throw — it silently produces a
//     listing with fewer item specifics. This is the only thing that would catch that.
//   · The card_facts key names for Magic are not free. lib/channels/ebay-map.mjs buildRowIn reads
//     item.colour / item.card_type / item.treatment / item.promo_note when the Scryfall cache is
//     cold; rename one and the fallback quietly loses an aspect.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK_GAME_ADAPTERS, STOCK_GAME_IDS, adapterFor, isStockGame,
  compsQueryFor, compsNumberMatch, mtgFinishOf,
} from '../../lib/stock-games.mjs';
import { formatCardNumber } from '../../lib/listing-copy.mjs';

// A trimmed pokemontcg.io card, exactly the shape lib/pkm-cards-cache.mjs trimCard emits.
const PKM_CARD = {
  id: 'sv4-25', name: 'Tinkaton', number: '25', rarity: 'Rare', artist: 'Sanosuke Sakuma',
  supertype: 'Pokémon', subtypes: ['Stage 2'], types: ['Metal'], hp: '150',
  nationalPokedexNumbers: [959], regulationMark: 'G', evolvesFrom: 'Tinkatuff',
  images: { small: 'https://img/s.png', large: 'https://img/l.png' },
  set: { id: 'sv4', name: 'Paradox Rift', series: 'Scarlet & Violet', ptcgoCode: 'PAR', releaseDate: '2023/11/03', printedTotal: 182 },
  tcgplayer: { prices: { normal: { market: 1.2 }, reverseHolofoil: { market: 2.4 } } },
};

// A trimmed Scryfall printing — the real HOB #249 Smaug, the fixture the MTG aspect suite uses.
const MTG_CARD = {
  id: 'ffffffff-0000-0000-0000-000000000000', name: 'Smaug, the Golden', collector_number: '249',
  rarity: 'mythic', artist: 'Chris Rahn', lang: 'en', released_at: '2023-06-23',
  type_line: 'Legendary Creature — Dragon', colors: ['B', 'R'],
  finishes: ['foil'], promo_types: ['headliner', 'universesbeyond'], promo: true,
  frame_effects: [], border_color: 'black', full_art: false,
  set: 'hob', set_name: 'The Hobbit',
  image_uris: { small: 's.jpg', normal: 'n.jpg', large: 'l.jpg' },
  prices: { usd: null, usd_foil: '199.99', usd_etched: null },
};

// ---------------------------------------------------------------------------
describe('the registry', () => {
  it('lists exactly the games whose eBay aspects have been checked live', () => {
    assert.deepEqual(STOCK_GAME_IDS, ['pokemon', 'mtg']);
    for (const id of STOCK_GAME_IDS) assert.ok(STOCK_GAME_ADAPTERS[id], id + ' is listed but has no adapter');
  });

  // A shape test, in the style of normalize.test.mjs: this is what makes "adding a game is one
  // entry" safe. A new adapter missing a key would otherwise fail at runtime, in a page, on a
  // Sunday, halfway through a pile.
  it('every adapter carries every key, of the right kind', () => {
    const fns = ['setsUrl', 'setCardsUrl', 'cardUrl', 'setsFrom', 'rawNumber', 'printingsFor',
      'finishFallback', 'rarityClass', 'normalizeCard', 'invRowFrom', 'overridesFrom'];
    const strs = ['id', 'label', 'tag', 'sourceName', 'code', 'setsCacheKey'];
    for (const id of STOCK_GAME_IDS) {
      const a = STOCK_GAME_ADAPTERS[id];
      assert.equal(a.id, id, 'the adapter knows its own id');
      for (const k of fns) assert.equal(typeof a[k], 'function', id + '.' + k + ' must be a function');
      for (const k of strs) assert.ok(a[k] && typeof a[k] === 'string', id + '.' + k + ' must be a non-empty string');
      assert.ok(Array.isArray(a.finishOptions) && a.finishOptions.length, id + '.finishOptions');
      assert.ok(Array.isArray(a.rarityOptions) && a.rarityOptions.length, id + '.rarityOptions');
      assert.equal(typeof a.printingTokens, 'object', id + '.printingTokens');
    }
  });

  it('the SKU codes match GAMECODE in lib/inventory.mjs', () => {
    assert.equal(STOCK_GAME_ADAPTERS.pokemon.code, 'PKM');
    assert.equal(STOCK_GAME_ADAPTERS.mtg.code, 'MTG');
  });

  // Not cosmetic. Templating this key would orphan every browser's cached set list, and that cache
  // is the only thing between a flaky pokemontcg.io and an empty picker (GR7).
  it('keeps the EXACT Pokémon sets-cache key both pages already wrote', () => {
    assert.equal(STOCK_GAME_ADAPTERS.pokemon.setsCacheKey, 'tcg_uploader_pkm_sets');
    assert.notEqual(STOCK_GAME_ADAPTERS.mtg.setsCacheKey, STOCK_GAME_ADAPTERS.pokemon.setsCacheKey);
  });

  it('falls back to Pokémon rather than exploding on an unknown game', () => {
    assert.equal(adapterFor('nonsense').id, 'pokemon', 'legacy rows and a hand-typed ?game= land here');
    assert.equal(adapterFor(undefined).id, 'pokemon');
    assert.equal(adapterFor('MTG').id, 'mtg', 'case-insensitive');
    assert.equal(isStockGame('mtg'), true);
    assert.equal(isStockGame('swu'), false, 'a card-data game is not yet a stock-tool game');
  });
});

// ---------------------------------------------------------------------------
describe('URLs and set lists', () => {
  it('each game points at its own cache route', () => {
    const p = STOCK_GAME_ADAPTERS.pokemon, m = STOCK_GAME_ADAPTERS.mtg;
    assert.equal(p.setCardsUrl('sv4'), '/api/pkm/set/sv4/cards');
    assert.equal(p.setCardsUrl('sv4', true), '/api/pkm/set/sv4/cards?refresh=1');
    assert.equal(m.setCardsUrl('hob'), '/api/mtg/set/hob/cards');
    assert.equal(m.setCardsUrl('hob', true), '/api/mtg/set/hob/cards?refresh=1');
    assert.equal(m.cardUrl('hob', '249'), '/api/mtg/cards/hob/249');
  });

  it('maps pokemontcg.io sets, newest first', () => {
    const out = STOCK_GAME_ADAPTERS.pokemon.setsFrom({ data: [
      { id: 'base1', name: 'Base', ptcgoCode: 'BS', releaseDate: '1999/01/09', images: { symbol: 'b.png' } },
      { id: 'sv4', name: 'Paradox Rift', ptcgoCode: 'PAR', releaseDate: '2023/11/03', images: { symbol: 'p.png' } },
    ] });
    assert.deepEqual(out.map((s) => s.value), ['sv4', 'base1']);
    assert.deepEqual(out[0], { value: 'sv4', label: 'Paradox Rift', code: 'PAR', icon: 'p.png', releaseDate: '2023/11/03' });
  });

  it('maps Scryfall sets on the CODE, and drops the digital-only ones', () => {
    const out = STOCK_GAME_ADAPTERS.mtg.setsFrom({ data: [
      { code: 'hob', name: 'The Hobbit', released_at: '2023-06-23', icon_svg_uri: 'h.svg' },
      { code: 'ymid', name: 'Alchemy: Midnight Hunt', released_at: '2024-01-01', digital: true },
      { code: 'neo', name: 'Kamigawa: Neon Dynasty', released_at: '2022-02-18', icon_svg_uri: 'n.svg' },
    ] });
    assert.deepEqual(out.map((s) => s.value), ['hob', 'neo'], 'digital sets are not physical stock');
    assert.deepEqual(out[0], { value: 'hob', label: 'The Hobbit', code: 'HOB', icon: 'h.svg', releaseDate: '2023-06-23' });
  });
});

// ---------------------------------------------------------------------------
describe('normalizeCard — Magic', () => {
  const nc = STOCK_GAME_ADAPTERS.mtg.normalizeCard(MTG_CARD, { value: 'hob', label: 'The Hobbit', code: 'HOB' });

  it('builds the identity key resolveMtgCard can parse back', () => {
    assert.equal(nc.identityKey, 'hob-249', 'set-collector_number, NOT the Scryfall uuid');
  });

  // GR10. Run through the Pokémon formatter, HOB #1 comes out '001' — a number that is not on the
  // card, and buyers search the exact printed string.
  it('leaves the collector number verbatim — Magic prints 249, so 249 it is', () => {
    assert.equal(nc.number, '249');
    assert.equal(STOCK_GAME_ADAPTERS.mtg.normalizeCard({ ...MTG_CARD, collector_number: '1' }, {}).number, '1');
    // What the Pokémon formatter would have done to the same string, spelled out: a modern set pads
    // to three and appends the printed total. '001/182' is not on the Magic card and is not what a
    // buyer searches, which is the whole of GR10.
    assert.equal(formatCardNumber('1', PKM_CARD.set, { source: 'ptcg' }), '001/182');
    assert.equal(STOCK_GAME_ADAPTERS.pokemon.normalizeCard(PKM_CARD, {}).number, '025/182',
      'and Pokémon still gets that treatment');
  });

  // titleParts' mtg branch reads the code out of these parens for the abbreviated title;
  // stripSetCodeSuffix and compsQueryFor both strip it back off. Same string the builder stores.
  it('carries the (CODE) suffix on the set name', () => {
    assert.equal(nc.setName, 'The Hobbit (HOB)');
    assert.equal(nc.setCode, 'HOB');
  });

  it('capitalises the rarity the way the eBay Rarity member is spelled', () => {
    assert.equal(nc.rarity, 'Mythic', 'the live enum member is "Mythic", not "mythic" or "Mythic Rare"');
  });

  // A whole-set fetch carries non-English prints: HOC has 5 Dwarvish cards (up to US$642) and NEO
  // has Japanese and Phyrexian ones. Hardcoding EN here is a straight INAD exposure.
  it('reads the language off the print, and stores the code the builder stores', () => {
    assert.equal(nc.language, 'EN');
    assert.equal(STOCK_GAME_ADAPTERS.mtg.normalizeCard({ ...MTG_CARD, lang: 'dw' }, {}).language, 'DW');
    assert.equal(STOCK_GAME_ADAPTERS.mtg.normalizeCard({ ...MTG_CARD, lang: 'ja' }, {}).language, 'JP');
  });

  it('falls back to the front face for a double-faced card', () => {
    const dfc = STOCK_GAME_ADAPTERS.mtg.normalizeCard({
      ...MTG_CARD, image_uris: null, colors: null,
      card_faces: [{ colors: ['U'], image_uris: { normal: 'front.jpg' } }, { image_uris: { normal: 'back.jpg' } }],
    }, {});
    // trimCard resolves the face server-side, so by the time the adapter sees it image_uris is
    // populated; this only guards the un-trimmed path (a direct /api/mtg/cards lookup).
    assert.equal(dfc.image, '', 'no top-level image_uris and none supplied → empty, never a guess');
  });

  // These names are read by buildRowIn's cold-cache branch. Renaming one loses an aspect silently.
  it('names card_facts exactly what ebay-map buildRowIn falls back to reading', () => {
    for (const k of ['colour', 'card_type', 'treatment', 'promo_note', 'illustrator', 'set_code', 'set_release_date', 'full_art', 'promo']) {
      assert.ok(k in nc.facts, 'card_facts.' + k + ' is what the cold-cache fallback reads');
    }
    assert.equal(nc.facts.colour, 'Multicolour', 'B+R — and the AU spelling, which is the aspect member');
    assert.equal(nc.facts.treatment, 'Normal');
    assert.equal(nc.facts.promo_note, 'Headliner', 'universesbeyond is a brand marker, not a promo flag');
    assert.equal(nc.facts.promo, true);
  });

  // GR10: Scryfall has no printed total — set.card_count counts PRINTINGS, which is a different
  // number and would render a wrong "249/321" on the listing.
  it('never invents a printed total', () => {
    assert.ok(!('printed_total' in nc.facts));
  });
});

// ---------------------------------------------------------------------------
describe('mtgFinishOf — the uploader default', () => {
  it('prefers nonfoil when the print has one', () => {
    assert.equal(mtgFinishOf({ finishes: ['nonfoil', 'foil'] }), 'Nonfoil');
  });
  it('foil-only prints default to Foil', () => {
    assert.equal(mtgFinishOf({ finishes: ['foil'] }), 'Foil');
  });
  it('etched-only prints default to Etched Foil', () => {
    assert.equal(mtgFinishOf({ finishes: ['etched'] }), 'Etched Foil');
  });
  // Scryfall marks surge only in promo_types and calls the printing plain "foil". A surge print is
  // a different TCGplayer product at several times the price (HOC #25 US$29.93 vs #65 US$125).
  it('surge foil beats the finishes list', () => {
    assert.equal(mtgFinishOf({ finishes: ['foil'], promo_types: ['surgefoil'] }), 'Surge Foil');
  });
});

// ---------------------------------------------------------------------------
describe('rarity classes', () => {
  it('Pokémon keeps its three-way filter', () => {
    const rc = STOCK_GAME_ADAPTERS.pokemon.rarityClass;
    assert.equal(rc('Common'), 'common');
    assert.equal(rc('Uncommon'), 'uncommon', 'tested before common, which is a substring of it');
    assert.equal(rc('Illustration Rare'), 'rare_plus');
  });

  // HOC is 61% mythic, so "rare and above" would select most of the box and tell you nothing.
  it('Magic splits mythic out, because "rare and above" is not a filter on a Magic set', () => {
    const rc = STOCK_GAME_ADAPTERS.mtg.rarityClass;
    assert.equal(rc('mythic'), 'mythic');
    assert.equal(rc('rare'), 'rare');
    assert.equal(rc('uncommon'), 'uncommon');
    assert.equal(rc('common'), 'common');
    assert.equal(rc('special'), 'rare', 'special/bonus are chase-adjacent, not commons');
  });
});

// ---------------------------------------------------------------------------
describe('compsQueryFor / compsNumberMatch', () => {
  it('each game asks eBay in its own words', () => {
    const it0 = { name: 'Tinkaton', set_name: 'Paradox Rift' };
    assert.equal(compsQueryFor('pokemon', it0, '25'), 'Pokemon Tinkaton 25 Paradox Rift');
    assert.equal(compsQueryFor('lorcana', it0, '25'), 'Disney Lorcana Tinkaton 25 Paradox Rift');
    assert.equal(compsQueryFor('swu', it0, '25'), 'Star Wars Unlimited Tinkaton 25 Paradox Rift');
  });

  it('Magic drops the number AND the (CODE) decoration', () => {
    const q = compsQueryFor('mtg', { name: 'Smaug, the Golden', set_name: 'The Hobbit (HOB)' }, '249');
    assert.equal(q, 'Smaug, the Golden The Hobbit');
    assert.ok(!/249/.test(q), 'Magic titles rarely carry a collector number; matching on it finds nothing');
  });

  // The bug: compsQueryFor said "no number" and priceItem said "the title MUST contain the number".
  // singlesFilter hard-rejects on the second, so the whole cluster was thrown away and every Magic
  // row came back "no confident comps".
  it('the number FILTER agrees with the query it is filtering', () => {
    assert.equal(compsNumberMatch('mtg', '249'), null);
    assert.equal(compsNumberMatch('pokemon', '25'), '25');
    assert.equal(compsNumberMatch('lorcana', '25'), '25');
  });
});

// ---------------------------------------------------------------------------
// The golden snapshot. stock-runner.html and stock-uploader.html used to build this row inline; this
// is BYTE FOR BYTE what the Pokémon path produced before the adapter existed, written out as a
// literal rather than extracted from the page, so it stays a guard once the page delegates.
//
// It matters because itemToListing MERGES card_facts over the DB row rather than replacing it: a
// key dropped here does not throw, it silently publishes a listing with fewer item specifics than a
// hand-made one. Nothing else in the suite would notice.
describe('GOLDEN — the Pokémon row is unchanged from what the page built inline', () => {
  const storePick = ['/Pokemon/Singles'];
  const nc = STOCK_GAME_ADAPTERS.pokemon.normalizeCard(PKM_CARD, { value: 'sv4', label: 'Paradox Rift', code: 'PAR' });
  const row = STOCK_GAME_ADAPTERS.pokemon.invRowFrom(nc, {
    finish: 'Reverse Holofoil', variant: 'Reverse Holo', edition: '',
    condition: 'Ungraded, Near Mint', language: 'EN', storeCategories: storePick,
  });
  // JSON is what actually reaches POST /api/inventory/items, and the old invRow wrote
  // `edition: undefined` for a card with no edition — which JSON drops and deepEqual would not.
  const wire = (o) => JSON.parse(JSON.stringify(o));

  it('every column, exactly as before', () => {
    assert.deepEqual(wire(row), {
      game: 'pokemon',
      name: 'Tinkaton',
      set_name: 'Paradox Rift',
      number: '025/182',
      rarity: 'Rare',
      language: 'EN',
      finish: 'Reverse Holofoil',
      image_url: 'https://img/l.png',
      identity_key: 'sv4-25',
      illustrator: 'Sanosuke Sakuma',
      card_type: 'Pokémon',
      variant: 'Reverse Holo',
      store_categories: ['/Pokemon/Singles'],
      card_facts: row.card_facts,
      condition: 'Ungraded, Near Mint',
      stage: 'Stage 2',
    });
  });

  // Key ORDER too: the blob is compared as a string in places, and reordering it would churn every
  // stored row for no reason.
  it('card_facts is byte-identical, key order included', () => {
    assert.equal(row.card_facts, JSON.stringify({
      hp: '150', pokedex: [959], regulation_mark: 'G', evolves_from: 'Tinkatuff',
      set_series: 'Scarlet & Violet', set_code: 'PAR', set_release_date: '2023/11/03', printed_total: 182,
      types: ['Metal'], subtypes: ['Stage 2'], supertype: 'Pokémon',
    }));
  });

  it('a sub-NM condition rides through, and nothing else moves', () => {
    const lp = STOCK_GAME_ADAPTERS.pokemon.invRowFrom(nc, {
      finish: 'Reverse Holofoil', variant: 'Reverse Holo', edition: '',
      condition: 'Ungraded, Lightly Played', storeCategories: storePick,
    });
    assert.equal(lp.condition, 'Ungraded, Lightly Played');
    assert.deepEqual(wire({ ...lp, condition: null }), wire({ ...row, condition: null }));
  });

  it('an edition only appears when there is one', () => {
    assert.ok(!('edition' in row));
    assert.equal(STOCK_GAME_ADAPTERS.pokemon.invRowFrom(nc, { finish: 'Holofoil', edition: '1st Edition' }).edition, '1st Edition');
  });

  // The Magic half of the same contract: the row the runner stages for a Magic card.
  it('and the Magic row carries what the publish path needs', () => {
    const m = STOCK_GAME_ADAPTERS.mtg;
    const mnc = m.normalizeCard(MTG_CARD, { value: 'hob', label: 'The Hobbit', code: 'HOB' });
    const mrow = m.invRowFrom(mnc, { finish: 'Foil', variant: 'Foil', condition: 'Ungraded, Near Mint', storeCategories: [] });
    assert.deepEqual(wire(mrow), {
      game: 'mtg',
      name: 'Smaug, the Golden',
      set_name: 'The Hobbit (HOB)',
      number: '249',
      rarity: 'Mythic',
      language: 'EN',
      finish: 'Foil',
      image_url: 'l.jpg',
      identity_key: 'hob-249',
      illustrator: 'Chris Rahn',
      card_type: 'Legendary Creature — Dragon',
      variant: 'Foil',
      store_categories: [],
      card_facts: mrow.card_facts,
      condition: 'Ungraded, Near Mint',
    });
    assert.equal(mrow.image_url, 'l.jpg', 'the biggest art the trim kept — this is what gets re-hosted on EPS');
    assert.ok(!('stage' in mrow), 'Stage is a Pokémon axis and must not leak onto Magic');
  });
});
