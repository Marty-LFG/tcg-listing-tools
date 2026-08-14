// test/unit/stock-games-lorcana.test.mjs — the Lorcana entry in the stock-tool adapter table.
//
// Split out of stock-games.test.mjs the way ebay-aspects-lorcana is split out of ebay-aspects: the
// shared contract (every adapter carries every key, of the right kind) lives there and already
// covers this one. What lives here is what is PARTICULAR to Lorcana, and one thing genuinely is:
//
//   Lorcana is the first game whose SET CODES are bare numbers, and the batch runner's catch line
//   treats a known set code as a set switch. Left in the vocabulary, typing `13` for card 13 would
//   silently switch sets and add no card — on the single most common input there is.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK_GAME_ADAPTERS, STOCK_GAME_IDS, adapterFor, isStockGame, compsQueryFor, compsNumberMatch,
} from '../../lib/stock-games.mjs';

// A Lorcast card, UNTRIMMED — exactly the shape /api/lorcana/set/:id/cards serves. Ariel 10/241 is
// Iconic: foil-only, US$1,344, and one of only ten Iconics in the game.
const LOR_CARD = {
  id: 'crd_abc', name: 'Ariel', version: 'Ethereal Voice', layout: 'normal',
  collector_number: '241', rarity: 'Iconic', released_at: '2025-11-07',
  ink: 'Amber', inks: null, type: ['Character'], classifications: ['Storyborn', 'Hero', 'Princess'],
  cost: 5, strength: 3, willpower: 4, lore: 2, illustrators: ['Nicholas Kole'],
  tcgplayer_id: 601234, set: { id: 'set_x', code: '10', name: 'Whispers in the Well' },
  image_uris: { digital: { small: 's.avif', normal: 'n.avif', large: 'l.avif' } },
  prices: { usd: null, usd_foil: '1344.77' },
};

const L = STOCK_GAME_ADAPTERS.lorcana;

describe('the Lorcana adapter is wired into the registry', () => {
  it('is listed, and reachable through adapterFor / isStockGame', () => {
    assert.ok(STOCK_GAME_IDS.includes('lorcana'));
    assert.equal(adapterFor('lorcana').id, 'lorcana');
    assert.equal(adapterFor('LORCANA').id, 'lorcana');
    assert.ok(isStockGame('lorcana'));
  });
  it('its SKU code matches GAMECODE in lib/inventory.mjs', () => {
    assert.equal(L.code, 'LOR');
  });
  it('builds the routes the caches actually serve', () => {
    assert.equal(L.setsUrl(), '/api/lorcana/sets');
    assert.equal(L.setCardsUrl('13'), '/api/lorcana/set/13/cards');
    assert.equal(L.setCardsUrl('13', true), '/api/lorcana/set/13/cards?refresh=1');
    assert.equal(L.cardUrl('10', '241'), '/api/lorcana/cards/10/241');
  });
});

describe('setsFrom — Lorcast`s wrapper, and the set-code collision', () => {
  const SETS = { results: [
    { code: '1', name: 'The First Chapter', released_at: '2023-08-18' },
    { code: '13', name: 'Attack of the Vine!', released_at: '2026-07-17' },
    { code: 'D23', name: 'D23 Collection', released_at: '2024-08-09' },
    { code: 'cp', name: 'Challenge Promo', released_at: '2024-05-17' },
  ] };

  it('reads `results`, not Scryfall`s `data`, and sorts newest first', () => {
    const sets = L.setsFrom(SETS);
    assert.equal(sets.length, 4);
    assert.equal(sets[0].value, '13');
    assert.equal(sets[0].label, 'Attack of the Vine!');
  });

  it('BLANKS the catch-line code on numbered sets, or `13` means "switch set", not "card 13"', () => {
    const byValue = Object.fromEntries(L.setsFrom(SETS).map((s) => [s.value, s]));
    assert.equal(byValue['1'].code, '', 'a numbered set contributes no catch-line token');
    assert.equal(byValue['13'].code, '');
    // Promo codes cannot be read as a collector number, so mid-pile switching still works there.
    assert.equal(byValue.D23.code, 'D23');
    assert.equal(byValue.cp.code, 'CP');
  });

  it('every set is still SELECTABLE — the dropdown keys on `value`, not on `code`', () => {
    const sets = L.setsFrom(SETS);
    assert.deepEqual(sets.map((s) => s.value).sort(), ['1', '13', 'D23', 'cp']);
    assert.ok(sets.every((s) => s.label), 'and every one has a name to pick it by');
  });

  it('carries no set icon, because Lorcast publishes none', () => {
    assert.ok(L.setsFrom(SETS).every((s) => s.icon === ''));
  });

  it('drops a set with no code rather than emitting one that cannot be fetched', () => {
    assert.equal(L.setsFrom({ results: [{ name: 'Codeless' }] }).length, 0);
  });

  it('drops an UNRELEASED set — you can select it and never post it', () => {
    // The same reasoning the mtg adapter drops `digital` sets on. Lorcana gains a set roughly every
    // three months, and Lorcast lists it as soon as it is announced.
    const future = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
    const sets = L.setsFrom({ results: [
      { code: '13', name: 'Attack of the Vine!', released_at: '2026-07-17' },
      { code: '14', name: 'Not Out Yet', released_at: future, prereleased_at: future },
    ] });
    assert.deepEqual(sets.map((s) => s.code === '' ? s.value : s.code), ['13']);
  });

  it('KEEPS a set in prerelease — those cards are physically in hand', () => {
    const future = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const sets = L.setsFrom({ results: [
      { code: '14', name: 'Prereleasing Now', released_at: future, prereleased_at: yesterday },
    ] });
    assert.equal(sets.length, 1, 'a prerelease set is stock');
  });

  it('keeps a set carrying no dates at all rather than silently hiding it (GR7)', () => {
    assert.equal(L.setsFrom({ results: [{ code: 'X1', name: 'Undated' }] }).length, 1);
  });
});

describe('numbers and identity', () => {
  it('keeps the collector number verbatim — Lorcana prints no denominator (GR10)', () => {
    assert.equal(L.cardNumber(LOR_CARD), '241');
    assert.equal(L.rawNumber(LOR_CARD), '241');
  });
  it('its identity key is "<set>/<number>", which resolveLorcanaCard splits back', () => {
    assert.equal(L.identityKey(LOR_CARD), '10/241');
  });
  it('the thumbnail is the SMALL art and the listing image the LARGE one', () => {
    assert.equal(L.thumbUrl(LOR_CARD), 's.avif');
    assert.equal(L.normalizeCard(LOR_CARD, {}).image, 'l.avif');
  });
});

describe('finish', () => {
  it('an Iconic defaults to the Iconic finish, not to a plain foil', () => {
    assert.equal(L.defaultFinish(LOR_CARD), 'Iconic');
    assert.equal(L.defaultFinish({ rarity: 'Enchanted', prices: { usd: null, usd_foil: '109' } }), 'Enchanted');
    assert.equal(L.defaultFinish({ rarity: 'Epic', prices: { usd: null, usd_foil: '4.74' } }), 'Epic');
  });
  it('a foil-only ORDINARY card is just a foil, and a two-priced card is Normal', () => {
    assert.equal(L.defaultFinish({ rarity: 'Common', prices: { usd: null, usd_foil: '0.18' } }), 'Foil');
    assert.equal(L.defaultFinish({ rarity: 'Rare', prices: { usd: '0.17', usd_foil: '0.56' } }), 'Normal');
  });
  it('never derives a finish from the rarity — that is what stamps a Rare as Holofoil', () => {
    const f = L.finishFallback({ rarity: 'Super Rare' });
    assert.equal(f.finish, 'Normal');
    assert.equal(f.fromRarity, false, 'a rarity-derived finish feeds a wrong finishHint into comps');
  });
  it('offers Cold Foil to the operator while deriving it nowhere (GR4)', () => {
    assert.ok(L.finishOptions.includes('Cold Foil'));
    for (const c of [LOR_CARD, { rarity: 'Common', prices: { usd: '1', usd_foil: '2' } }]) {
      assert.notEqual(L.defaultFinish(c), 'Cold Foil');
      assert.ok(!L.printingsFor(c).some((p) => p.finish === 'Cold Foil'));
    }
  });
  it('the catch-line tokens are Lorcast`s price fields', () => {
    assert.deepEqual(L.printingTokens, { n: 'usd', f: 'usd_foil', h: 'usd_foil' });
  });
});

describe('rarityClass — grouped by what the cards are WORTH', () => {
  it('tests the substrings in an order that survives them overlapping', () => {
    assert.equal(L.rarityClass('Uncommon'), 'uncommon', "'common' is a substring of it");
    assert.equal(L.rarityClass('Common'), 'common');
    assert.equal(L.rarityClass('Rare'), 'rare');
    // Counted medians: Rare US$0.56 foil, Super Rare US$0.97 foil. Those belong together, and NOT
    // with Enchanted (US$109) or Iconic (US$1,789).
    assert.equal(L.rarityClass('Super Rare'), 'rare');
    assert.equal(L.rarityClass('Super_rare'), 'rare', 'the raw Lorcast spelling too');
  });
  it('puts everything genuinely worth listing one at a time into `chase`', () => {
    for (const r of ['Legendary', 'Epic', 'Enchanted', 'Iconic', 'Promo']) {
      assert.equal(L.rarityClass(r), 'chase', r);
    }
  });
  it('offers four options, like Magic and unlike Pokémon`s three', () => {
    assert.equal(L.rarityOptions.length, 4);
    assert.deepEqual(L.rarityOptions.map((o) => o.value), ['common', 'uncommon', 'rare', 'chase']);
  });
});

describe('normalizeCard', () => {
  const nc = L.normalizeCard(LOR_CARD, { value: '10', label: 'Whispers in the Well', code: '' });

  it('joins the name the way every other surface does', () => {
    assert.equal(nc.name, 'Ariel - Ethereal Voice');
  });
  it('leaves the set name BARE — unlike Magic, there is no "(CODE)" to strip back off', () => {
    assert.equal(nc.setName, 'Whispers in the Well');
    assert.equal(nc.setCode, '10');
  });
  it('prettifies "Super_rare" so the eBay Rarity aspect matches its member', () => {
    assert.equal(L.normalizeCard({ ...LOR_CARD, rarity: 'Super_rare' }, {}).rarity, 'Super Rare');
  });
  it('carries the identity, image, illustrator and type', () => {
    assert.equal(nc.identityKey, '10/241');
    assert.equal(nc.number, '241');
    assert.equal(nc.rarity, 'Iconic');
    assert.equal(nc.image, 'l.avif');
    assert.equal(nc.illustrator, 'Nicholas Kole');
    assert.equal(nc.language, 'EN');
    assert.equal(nc.cardType, 'Character');
  });

  it('carries the card facts ebay-map reads back on a COLD Lorcast cache', () => {
    // These key names are not free: buildRowIn reads item.character / item.ink /
    // item.classifications / item.cost… when resolveLorcanaCard returns null. Rename one and the
    // fallback silently loses an aspect or a description row.
    const f = nc.facts;
    assert.equal(f.character, 'Ariel', 'the Character aspect, free from Lorcast`s split fields');
    assert.equal(f.ink, 'Amber');
    assert.deepEqual(f.lorcana_types, ['Character']);
    assert.equal(f.card_type, 'Character');
    assert.equal(f.classifications, 'Storyborn · Hero · Princess');
    assert.equal(f.cost, 5);
    assert.equal(f.strength, 3);
    assert.equal(f.willpower, 4);
    assert.equal(f.lore, 2);
    assert.equal(f.set_code, '10');
    assert.equal(f.tcgplayer_id, 601234);
  });

  it('reads the ink off `inks` when `ink` is null — 160 cards are in that state', () => {
    assert.equal(L.normalizeCard({ ...LOR_CARD, ink: null, inks: ['Ruby'] }, {}).facts.ink, 'Ruby');
    assert.equal(L.normalizeCard({ ...LOR_CARD, ink: null, inks: ['Amethyst', 'Sapphire'] }, {}).facts.ink, 'Amethyst-Sapphire');
  });

  it('keeps BOTH types on an Action+Song card so the aspect can choose', () => {
    const song = L.normalizeCard({ ...LOR_CARD, type: ['Action', 'Song'] }, {});
    assert.equal(song.cardType, 'Action/Song');
    assert.deepEqual(song.facts.lorcana_types, ['Action', 'Song']);
  });
});

describe('the row the runner stages', () => {
  const nc = L.normalizeCard(LOR_CARD, { value: '10', label: 'Whispers in the Well', code: '' });
  const row = L.invRowFrom(nc, { finish: 'Iconic', variant: 'Iconic', condition: 'Ungraded, Near Mint', storeCategories: [] });

  it('carries what the publish path needs', () => {
    assert.equal(row.game, 'lorcana');
    assert.equal(row.name, 'Ariel - Ethereal Voice');
    assert.equal(row.set_name, 'Whispers in the Well');
    assert.equal(row.number, '241');
    assert.equal(row.rarity, 'Iconic');
    assert.equal(row.identity_key, '10/241');
    assert.equal(row.image_url, 'l.avif');
    assert.equal(row.language, 'EN');
  });
  it('its `variant` keeps an Iconic off the plain foil`s identity row', () => {
    // variant IS part of UNIQUE(game, identity_key, variant), so this is the column that stops a
    // US$1,344 card and a US$1 one being the same row (GR5).
    assert.equal(row.variant, 'Iconic');
    const foil = L.invRowFrom(nc, { finish: 'Foil', variant: '' });
    assert.equal(foil.variant, 'Foil');
    assert.notEqual(row.variant, foil.variant);
  });
  it('no Pokémon axis leaks onto it', () => {
    assert.ok(!('stage' in row), 'Stage is a Pokémon axis');
  });
  it('card_facts survives the DB round trip', () => {
    assert.equal(JSON.parse(row.card_facts).character, 'Ariel');
  });
  it('overridesFrom sends the derived facts the server merges over the stored row', () => {
    const o = L.overridesFrom(nc);
    assert.equal(o.character, 'Ariel');
    assert.equal(o.ink, 'Amber');
    assert.equal(o.classifications, 'Storyborn · Hero · Princess');
    assert.deepEqual(o.lorcana_types, ['Character']);
  });
});

describe('comps', () => {
  it('names the game and KEEPS the number, unlike Magic', () => {
    // Lorcana titles DO carry the collector number, so the filter is right to insist on it. Do not
    // "tidy" this to match compsNumberMatch('mtg'), which is null for the opposite reason.
    const q = compsQueryFor('lorcana', { name: 'Ariel - Ethereal Voice', set_name: 'Whispers in the Well' }, '241');
    assert.match(q, /^Disney Lorcana /);
    assert.match(q, /241/);
    assert.equal(compsNumberMatch('lorcana', '241'), '241');
  });
});
