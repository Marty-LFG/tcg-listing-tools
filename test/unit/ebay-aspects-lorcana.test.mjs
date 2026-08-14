// test/unit/ebay-aspects-lorcana.test.mjs — the Lorcana side of the eBay AU 183454 derivations.
//
// Same two jobs as the Magic suite: derive Lorcana's own aspects, and make sure the POKÉMON ones
// stop leaking onto a game with no species, no stage and no HP.
//
// Every enum referenced here was read off the LIVE Taxonomy on 2026-08-14
// (scripts/check-ebay-aspects.mjs --game "Disney Lorcana"). eBay silently DROPS a FREE_TEXT value
// that misses its enum but REJECTS a SELECTION_ONLY one, so an unset aspect is always safer than a
// near-miss (GR4) — and a near-miss on a FREE_TEXT aspect is INVISIBLE, which is how
// 'Disney Lorcana' shipped for as long as it did.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toEbayListing, validateListing, loadEbayCategories, lorcanaCardTypeAspect, lorcanaInks,
  lorcanaInkAspect, lorcanaFeatures, lorcanaRarityAspect, ebayManufacturer, ebayFinish,
} from '../../lib/channels/ebay-map.mjs';
import { writeSetCache } from '../../lib/lorcana-cards-cache.mjs';

const cats = loadEbayCategories();

// Ariel 10/241 — Iconic, foil-only, US$1,344. Card facts arrive as overrides so the test does not
// depend on whether the Lorcast set cache happens to be warm.
const ARIEL = {
  sku: 'BK-LOR-000001', game: 'lorcana', name: 'Ariel - Ethereal Voice',
  set_name: 'Whispers in the Well', number: '241', rarity: 'Iconic', language: 'EN',
  finish: 'Iconic', variant: 'Iconic', condition: 'Ungraded, Near Mint', quantity: 1,
  target_price_cents: 199900, identity_key: '10/241', character: 'Ariel',
  card_type: 'Character', ink: 'Amber', illustrator: 'Nicholas Kole',
  set_release_date: '2025-11-07', image_url: 'https://cards.lorcast.io/card/digital/large/x.avif',
};

describe('the Game aspect — the one eBay requires, and the one a near-miss hides in', () => {
  it('is the LIVE member "Disney Lorcana TCG", not the near-miss "Disney Lorcana"', () => {
    // Game is REQUIRED and FREE_TEXT: a value off the enum still publishes, it just earns no facet
    // — so this was silently wrong on every Lorcana listing rather than failing loudly once.
    assert.equal(cats.games.lorcana.gameAspect, 'Disney Lorcana TCG');
    assert.equal(toEbayListing(ARIEL, null, cats).aspects.Game, 'Disney Lorcana TCG');
  });
  it('the other games kept the strings their own live checks produced', () => {
    assert.equal(cats.games.pokemon.gameAspect, 'Pokémon TCG');
    assert.equal(cats.games.mtg.gameAspect, 'Magic: The Gathering');
    // Checked live at the same time: eBay has no Star Wars: Unlimited member at all (the Star Wars
    // entries are Destiny / CCG / Force Attax / TCG), so verbatim is the honest answer.
    assert.equal(cats.games.swu.gameAspect, 'Star Wars: Unlimited');
    assert.equal(cats.games.riftbound.gameAspect, 'Riftbound: League of Legends TCG');
  });
});

describe('lorcanaCardTypeAspect — SINGLE, and 174 cards carry two types', () => {
  it('picks Song out of the Action+Song pair, because Song is the distinctive half', () => {
    assert.equal(lorcanaCardTypeAspect(['Action', 'Song']), 'Song');
    assert.equal(lorcanaCardTypeAspect(['Song', 'Action']), 'Song');
  });
  it('passes a single type straight through', () => {
    for (const t of ['Character', 'Action', 'Item', 'Location', 'Song']) {
      assert.equal(lorcanaCardTypeAspect([t]), t);
    }
  });
  it('accepts the "/"-joined string the builder stores as well as the array', () => {
    assert.equal(lorcanaCardTypeAspect('Action/Song'), 'Song');
    assert.equal(lorcanaCardTypeAspect('Character'), 'Character');
  });
  it('an unknown type goes verbatim rather than being mapped onto a Magic member (GR4)', () => {
    assert.equal(lorcanaCardTypeAspect(['Sorcery']), 'Sorcery');
  });
  it('nothing in, nothing out', () => {
    assert.equal(lorcanaCardTypeAspect([]), null);
    assert.equal(lorcanaCardTypeAspect(null), null);
    assert.equal(lorcanaCardTypeAspect(''), null);
  });
});

describe('lorcanaInks — READ BOTH FIELDS, or 160 cards lose their ink', () => {
  it('reads `inks` when `ink` is null (Jolly Roger)', () => {
    assert.deepEqual(lorcanaInks({ ink: null, inks: ['Ruby'] }), ['Ruby']);
    assert.equal(lorcanaInkAspect({ ink: null, inks: ['Ruby'] }), 'Ruby');
  });
  it('reads `ink` when `inks` is null (Never Land)', () => {
    assert.deepEqual(lorcanaInks({ ink: 'Amber', inks: null }), ['Amber']);
    assert.equal(lorcanaInkAspect({ ink: 'Amber', inks: null }), 'Amber');
  });
  it('joins a dual-ink card the way the community writes it — 187 cards are dual', () => {
    // The aspect is SINGLE cardinality, so this has to be one string.
    assert.equal(lorcanaInkAspect({ ink: null, inks: ['Amethyst', 'Sapphire'] }), 'Amethyst-Sapphire');
    assert.equal(lorcanaInkAspect(['Amber', 'Steel']), 'Amber-Steel');
  });
  it('round-trips the stored hyphen form', () => {
    assert.equal(lorcanaInkAspect('Amber-Steel'), 'Amber-Steel');
    assert.equal(lorcanaInkAspect('Amber'), 'Amber');
  });
  it('is null when there is no ink at all, never an invented one', () => {
    assert.equal(lorcanaInkAspect({ ink: null, inks: null }), null);
    assert.equal(lorcanaInkAspect(''), null);
  });
  it('sends the ink VERBATIM — "Amber" is not translated to "Yellow"', () => {
    // The six inks are not enum members, so this earns no facet today. Mapping Amber->Yellow would
    // earn one by claiming something the card does not say, which is the trade GR4 refuses.
    const l = toEbayListing({ ...ARIEL, ink: 'Amber' }, null, cats);
    assert.equal(l.aspects['Attribute/MTG:Colour'], 'Amber');
  });
});

describe('lorcanaFeatures — Chase is a real member, Enchanted/Epic/Iconic are not', () => {
  it('marks all three foil-only chase rarities as Chase', () => {
    for (const r of ['Enchanted', 'Epic', 'Iconic']) {
      assert.deepEqual(lorcanaFeatures(r), ['Chase'], r);
    }
  });
  it('marks a promo as Promo', () => {
    assert.deepEqual(lorcanaFeatures('Promo'), ['Promo']);
  });
  it('claims nothing for an ordinary card', () => {
    for (const r of ['Common', 'Uncommon', 'Rare', 'Super Rare', 'Legendary', '', null]) {
      assert.deepEqual(lorcanaFeatures(r), [], String(r));
    }
  });
  it('never claims Full Art or Borderless — no Lorcast field says so', () => {
    assert.ok(!lorcanaFeatures('Enchanted').includes('Full Art'));
    assert.ok(!lorcanaFeatures('Enchanted').includes('Borderless'));
  });
});

describe('lorcanaRarityAspect', () => {
  it('turns Lorcast`s raw "Super_rare" into the live member "Super Rare"', () => {
    assert.equal(lorcanaRarityAspect('Super_rare'), 'Super Rare');
  });
  it('leaves the rarities that are already exact members alone', () => {
    for (const r of ['Common', 'Uncommon', 'Rare', 'Legendary', 'Enchanted', 'Promo']) {
      assert.equal(lorcanaRarityAspect(r), r);
    }
  });
  it('passes Epic and Iconic verbatim — eBay has no member, and FREE_TEXT just drops them', () => {
    assert.equal(lorcanaRarityAspect('Epic'), 'Epic');
    assert.equal(lorcanaRarityAspect('Iconic'), 'Iconic');
  });
  it('empty in, null out', () => {
    assert.equal(lorcanaRarityAspect(''), null);
    assert.equal(lorcanaRarityAspect(null), null);
  });
});

describe('a Lorcana listing carries Lorcana aspects and NO Pokémon ones', () => {
  const l = toEbayListing(ARIEL, null, cats);
  it('lands in the right category with the right Game', () => {
    assert.equal(l.categoryId, '183454');
    assert.equal(l.aspects.Game, 'Disney Lorcana TCG');
  });
  it('never carries a Pokémon-only aspect', () => {
    // 'Basic' is a Lorcana classification too, so ebayStage's bare match is the same one-import-away
    // trap it was for Magic's Basic Lands.
    for (const k of ['Stage', 'Speciality', 'HP']) {
      assert.equal(l.aspects[k], undefined, `${k} must not appear on a Lorcana listing`);
    }
  });
  it('derives the Lorcana ones', () => {
    assert.equal(l.aspects.Set, 'Whispers in the Well');
    assert.equal(l.aspects['Card Name'], 'Ariel - Ethereal Voice');
    // Lorcast keeps name and version apart, so the character is free — no splitting, no guessing.
    assert.equal(l.aspects.Character, 'Ariel');
    assert.equal(l.aspects['Card Type'], 'Character');
    assert.equal(l.aspects['Attribute/MTG:Colour'], 'Amber');
    assert.equal(l.aspects.Manufacturer, 'Ravensburger');
    assert.equal(l.aspects['Card Size'], 'Standard');
    assert.equal(l.aspects.Material, 'Card Stock');
    assert.equal(l.aspects.Illustrator, 'Nicholas Kole');
    assert.equal(l.aspects.Language, 'English');
    assert.equal(l.aspects['Year Manufactured'], '2025');
    assert.equal(l.aspects.Rarity, 'Iconic');
    assert.deepEqual(l.aspects.Features, ['Chase']);
  });
  it('an Iconic still gets a Finish, because it IS a foil printing', () => {
    // It contains neither "holo" nor "foil", so before the ladder learned the word this was unset
    // on the most valuable cards in the game.
    assert.equal(l.aspects.Finish, 'Foil');
    assert.equal(ebayFinish('Enchanted'), 'Foil');
    assert.equal(ebayFinish('Epic'), 'Foil');
  });
  it('respects the Inventory API caps on every aspect', () => {
    for (const [k, v] of Object.entries(l.aspects)) {
      assert.ok(k.length <= 40, `aspect name over 40: ${k}`);
      for (const one of [].concat(v)) assert.ok(String(one).length <= 50, `value over 50: ${one}`);
    }
  });
  it('the description is Lorcana`s, not Pokémon`s', () => {
    assert.match(l.descriptionHtml, /Disney Lorcana/);
    assert.doesNotMatch(l.descriptionHtml, /Pok[eé]mon/);
  });
  it('validates clean — a Lorcana row is publishable', () => {
    const v = validateListing(l, cats);
    assert.deepEqual(v.errors, []);
  });
  it('an ordinary card carries no Features rather than an empty array', () => {
    const common = toEbayListing({ ...ARIEL, rarity: 'Common', finish: 'Normal', variant: 'Base' }, null, cats);
    assert.equal(common.aspects.Features, undefined);
    assert.equal(common.aspects.Finish, 'Regular');
    assert.equal(common.aspects.Rarity, 'Common');
  });
  it('carries a real facet set, not the handful it would have had', () => {
    assert.ok(Object.keys(l.aspects).length >= 15, `only ${Object.keys(l.aspects).length}: ${Object.keys(l.aspects)}`);
  });
});

// ---------------------------------------------------------------------------
// The DB round trip. inventory_items stores the IDENTITY and nothing else, so on a republish every
// aspect below has to come back out of resolveLorcanaCard. The tests above all hand the facts in as
// overrides, which is why they passed while two aspects were silently absent on this path: Character
// and the ink were being read off `item` when buildRowIn had put them on `rowIn`.
// ---------------------------------------------------------------------------
describe('a row carrying only its identity still lists with every aspect', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lorcana-aspects-'));
  let keep;
  before(() => {
    keep = process.env.LORCANA_CARDS_CACHE_DIR;
    process.env.LORCANA_CARDS_CACHE_DIR = TMP;     // read per call, so this lands before the lookup
    writeSetCache('10', '2026-08-14T00:00:00.000Z', [
      {
        id: 'crd_a', name: 'Ariel', version: 'Ethereal Voice', collector_number: '241',
        rarity: 'Iconic', released_at: '2025-11-07', ink: 'Amber', inks: null,
        type: ['Character'], classifications: ['Storyborn', 'Hero', 'Princess'],
        cost: 4, strength: 3, willpower: 4, lore: 2, illustrators: ['Aristeidis Zentelis'],
        set: { code: '10', name: 'Whispers in the Well' },
        image_uris: { digital: { large: 'l.avif' } }, prices: { usd: null, usd_foil: '1344.77' },
      },
      // The `ink: null, inks: [...]` shape — 160 cards are in it, and every dual-ink card is.
      {
        id: 'crd_b', name: 'Rhino', version: 'Motivational Speaker', collector_number: '1',
        rarity: 'Rare', released_at: '2025-03-07', ink: null, inks: ['Amber', 'Steel'],
        type: ['Action', 'Song'], classifications: ['Storyborn'],
        cost: 2, strength: 1, willpower: 2, lore: 1, illustrators: ['Stefano Zanchi'],
        set: { code: '10', name: 'Whispers in the Well' },
        image_uris: { digital: { large: 'l2.avif' } }, prices: { usd: '0.17', usd_foil: '0.40' },
      },
    ]);
  });
  after(() => {
    if (keep === undefined) delete process.env.LORCANA_CARDS_CACHE_DIR;
    else process.env.LORCANA_CARDS_CACHE_DIR = keep;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  // Deliberately NO character, ink, card_type, illustrator or release date on the row.
  const bare = (over) => ({
    game: 'lorcana', name: 'Ariel - Ethereal Voice', set_name: 'Whispers in the Well',
    number: '241', rarity: 'Iconic', language: 'EN', finish: 'Iconic', variant: 'Iconic',
    condition: 'Ungraded, Near Mint', quantity: 1, target_price_cents: 199900,
    identity_key: '10/241', ...over,
  });

  it('re-resolves Character, which is read off rowIn and not off the row', () => {
    assert.equal(toEbayListing(bare(), null, cats).aspects.Character, 'Ariel');
  });
  it('re-resolves the ink, reading BOTH Lorcast fields', () => {
    assert.equal(toEbayListing(bare(), null, cats).aspects['Attribute/MTG:Colour'], 'Amber');
    const dual = toEbayListing(bare({ name: 'Rhino - Motivational Speaker', number: '1', rarity: 'Rare', identity_key: '10/1', finish: 'Normal', variant: 'Base' }), null, cats);
    assert.equal(dual.aspects['Attribute/MTG:Colour'], 'Amber-Steel');
    assert.equal(dual.aspects.Character, 'Rhino');
    assert.equal(dual.aspects['Card Type'], 'Song', 'and Song still wins the Action+Song pair');
  });
  it('re-resolves Card Type, Illustrator and Year Manufactured', () => {
    const l = toEbayListing(bare(), null, cats);
    assert.equal(l.aspects['Card Type'], 'Character');
    assert.equal(l.aspects.Illustrator, 'Aristeidis Zentelis');
    assert.equal(l.aspects['Year Manufactured'], '2025');
  });
  it('fills the CARD DETAILS table rather than rendering it half-empty', () => {
    const html = toEbayListing(bare(), null, cats).descriptionHtml;
    for (const want of ['Amber', 'Storyborn · Hero · Princess', '4 / 3 / 4 / 2']) {
      assert.ok(html.includes(want), 'description is missing ' + want);
    }
  });
  it('validates, and carries MORE aspects than the same row did before re-resolution', () => {
    const l = toEbayListing(bare(), null, cats);
    assert.deepEqual(validateListing(l, cats).errors, []);
    assert.ok(Object.keys(l.aspects).length >= 17, `only ${Object.keys(l.aspects).length}`);
  });
  it('a cold cache still lists — fewer facets, never a failed publish (GR7)', () => {
    const l = toEbayListing(bare({ identity_key: '10/999' }), null, cats);
    assert.deepEqual(validateListing(l, cats).errors, [], 'the listing must still be publishable');
    assert.equal(l.aspects.Character, undefined, 'absent rather than invented');
    assert.equal(l.aspects.Game, 'Disney Lorcana TCG');
  });
});

describe('ebayManufacturer', () => {
  it('Lorcana is published by Ravensburger, a live enum member', () => {
    assert.equal(ebayManufacturer('lorcana', 'EN', '2023-08-18'), 'Ravensburger');
  });
  it('and that does not leak onto anyone else', () => {
    assert.equal(ebayManufacturer('swu', 'EN', '2024-03-08'), null);
    assert.equal(ebayManufacturer('mtg', 'EN', '2026-08-14'), 'Wizards of the Coast');
  });
});
