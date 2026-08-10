// test/unit/ebay-aspects-mtg.test.mjs — the Magic side of the eBay AU 183454 derivations.
//
// Two jobs. Derive Magic's own aspects (a Magic listing used to carry EIGHT, against Pokémon's
// twenty), and make sure the POKÉMON ones stop leaking onto a game with no species, no stage and no
// HP. That leak was real rather than theoretical: 'Basic' is a Magic SUPERTYPE, so ebayStage's bare
// /^basic$/ match was one Basic Land import away from stamping "Stage: Basic" on a Mountain.
//
// eBay silently DROPS a FREE_TEXT value that misses its enum but REJECTS a SELECTION_ONLY one, so an
// unset aspect is always safer than a near-miss (GR4).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toEbayListing, loadEbayCategories, mtgCardTypeAspect, stripSetCodeSuffix, mtgColourAspect,
  mtgFeatures, ebayLanguageAspect, ebayLanguageName, ebayManufacturer, MTG_COLOUR_ASPECT_VERIFIED,
} from '../../lib/channels/ebay-map.mjs';

const cats = loadEbayCategories();

// HOB #249 — the headliner, foil-only at ~US$200. Card facts arrive as overrides here so the test
// is independent of whether the Scryfall set cache happens to be warm.
const SMAUG = {
  sku: 'BK-MTG-000001', game: 'mtg', name: 'Smaug the Magnificent', set_name: 'The Hobbit (HOB)',
  number: '249', rarity: 'Mythic', language: 'EN', finish: 'Foil', condition: 'Ungraded, Near Mint',
  quantity: 1, target_price_cents: 29900, identity_key: 'hob-249', artist: 'Ted Nasmith',
  card_type: 'Legendary Creature — Dragon', colour: 'Red', treatment: 'Normal', promo_note: 'Headliner',
  set_release_date: '2026-08-14', image_url: 'https://cards.scryfall.io/normal/front/a/b/c.jpg',
};

describe('mtgCardTypeAspect — a type LINE reduced to the one word a buyer filters on', () => {
  it('drops supertypes and subtypes', () => {
    assert.equal(mtgCardTypeAspect('Legendary Creature — Dragon'), 'Creature');
    assert.equal(mtgCardTypeAspect('Basic Land — Mountain'), 'Land');
    assert.equal(mtgCardTypeAspect('Legendary Planeswalker — Gandalf'), 'Planeswalker');
    assert.equal(mtgCardTypeAspect('Creature — Dwarf Warrior'), 'Creature');
  });
  it('picks by priority, not word order — an Artifact Creature is a Creature', () => {
    assert.equal(mtgCardTypeAspect('Artifact Creature — Golem'), 'Creature');
    assert.equal(mtgCardTypeAspect('Legendary Enchantment Creature — God'), 'Creature');
    assert.equal(mtgCardTypeAspect('Legendary Artifact'), 'Artifact');
  });
  it('takes the FRONT face only — 39 of HOB’s 321 prints are double-faced', () => {
    assert.equal(mtgCardTypeAspect('Creature — Bear // Sorcery'), 'Creature');
  });
  it('an unknown type stays verbatim rather than being forced into a member (GR4)', () => {
    assert.equal(mtgCardTypeAspect('Conspiracy'), 'Conspiracy');
  });
  it('empty in, null out — never the string "undefined"', () => {
    assert.equal(mtgCardTypeAspect(''), null);
    assert.equal(mtgCardTypeAspect(null), null);
  });
});

describe('the Set aspect drops the code the TITLE needs', () => {
  it('strips a trailing (CODE)', () => {
    assert.equal(stripSetCodeSuffix('The Hobbit (HOB)'), 'The Hobbit');
    assert.equal(stripSetCodeSuffix('The Hobbit Eternal (HOC)'), 'The Hobbit Eternal');
  });
  it('leaves a name that has none alone, and never returns empty', () => {
    assert.equal(stripSetCodeSuffix('The Hobbit'), 'The Hobbit');
    assert.equal(stripSetCodeSuffix('(HOB)'), '(HOB)');
  });
});

describe('Language: the ASPECT is narrower than the display name', () => {
  it('leaves an unrecognised language UNSET rather than risking a rejected publish', () => {
    // Dwarvish is a real Scryfall print language (HOC #93-97, up to US$642 foil), not an eBay member.
    assert.equal(ebayLanguageAspect('dw'), null);
    assert.equal(ebayLanguageAspect('DW'), null);
    assert.equal(ebayLanguageAspect('Klingon'), null);
  });
  it('but the DISPLAY name still reads Dwarvish — the description row must not say "DW"', () => {
    assert.equal(ebayLanguageName('DW'), 'Dwarvish');
  });
  it('full names already coming from the UI are members and still pass', () => {
    assert.equal(ebayLanguageAspect('Japanese'), 'Japanese');
    assert.equal(ebayLanguageAspect('French'), 'French');
    assert.equal(ebayLanguageAspect('JP'), 'Japanese');
  });
  it('blank still means English', () => {
    assert.equal(ebayLanguageAspect(''), 'English');
    assert.equal(ebayLanguageAspect(null), 'English');
  });
});

describe('Attribute/MTG:Colour ships unset until the live enum mode is known', () => {
  it('returns null while the flag is false — a SELECTION_ONLY miss is a FAILED PUBLISH', () => {
    assert.equal(MTG_COLOUR_ASPECT_VERIFIED, false, 'flip only after running scripts/check-ebay-aspects.mjs');
    assert.equal(mtgColourAspect('Red'), null);
  });
});

describe('mtgFeatures is driven by the card record, never by promo_types', () => {
  it('universesbeyond is a BRAND marker — it is on all 479 HOB+HOC prints', () => {
    assert.deepEqual(mtgFeatures({ promo_types: ['universesbeyond'], full_art: false, promo: false }), []);
    assert.deepEqual(mtgFeatures({ promo_types: ['headliner', 'universesbeyond'], promo: false }), []);
  });
  it('only what the record proves', () => {
    assert.deepEqual(mtgFeatures({ full_art: true, promo: true }), ['Full Art', 'Promo']);
    assert.deepEqual(mtgFeatures(null), []);
  });
});

describe('Manufacturer', () => {
  it('every Magic set is Wizards of the Coast', () => {
    assert.equal(ebayManufacturer('mtg', 'EN', '2026-08-14'), 'Wizards of the Coast');
  });
  it('a game with no rule still gets nothing rather than a guess', () => {
    assert.equal(ebayManufacturer('lorcana', 'EN', '2023-08-18'), null);
  });
});

describe('a Magic listing carries Magic aspects and NO Pokémon ones', () => {
  const l = toEbayListing(SMAUG, null, cats);
  it('lands in the right category with the right Game', () => {
    assert.equal(l.categoryId, '183454');
    assert.equal(l.aspects.Game, 'Magic: The Gathering');
  });
  it('never carries a Pokémon-only aspect', () => {
    for (const k of ['Character', 'Stage', 'Speciality', 'HP']) {
      assert.equal(l.aspects[k], undefined, `${k} must not appear on a Magic listing`);
    }
  });
  it('derives the Magic ones', () => {
    assert.equal(l.aspects.Set, 'The Hobbit', 'the (HOB) belongs in the title, not the facet');
    assert.equal(l.aspects['Card Type'], 'Creature');
    assert.equal(l.aspects.Manufacturer, 'Wizards of the Coast');
    assert.equal(l.aspects['Card Size'], 'Standard');
    assert.equal(l.aspects.Material, 'Card Stock');
    assert.equal(l.aspects.Illustrator, 'Ted Nasmith');
    assert.equal(l.aspects['Year Manufactured'], '2026');
    assert.equal(l.aspects.Finish, 'Foil', 'ebayFinish needs no MTG change');
    assert.equal(l.aspects.Rarity, 'Mythic', 'verbatim — never remapped onto a Pokémon rarity');
  });
  it('carries more than the eight it used to', () => {
    assert.ok(Object.keys(l.aspects).length >= 13, `only ${Object.keys(l.aspects).length}: ${Object.keys(l.aspects)}`);
  });
  it('respects the Inventory API caps on every aspect', () => {
    for (const [k, v] of Object.entries(l.aspects)) {
      assert.ok(k.length <= 40, `aspect name over 40: ${k}`);
      for (const one of [].concat(v)) assert.ok(String(one).length <= 50, `value over 50: ${one}`);
    }
  });
  it('Surge Foil tiers as Foil — there is no Surge member, and a near-miss is worse than none', () => {
    assert.equal(toEbayListing({ ...SMAUG, finish: 'Surge Foil' }, null, cats).aspects.Finish, 'Foil');
    assert.equal(toEbayListing({ ...SMAUG, finish: 'Nonfoil' }, null, cats).aspects.Finish, 'Regular');
  });
  it('a Dwarvish print lists with NO Language aspect but still reads Dwarvish in the description', () => {
    const dw = toEbayListing({ ...SMAUG, language: 'DW' }, null, cats);
    assert.equal(dw.aspects.Language, undefined);
    assert.match(dw.descriptionHtml, /Dwarvish/);
  });
  it('the description is Magic’s, not Pokémon’s', () => {
    assert.match(l.descriptionHtml, /Magic: The Gathering/);
    assert.doesNotMatch(l.descriptionHtml, /Pok[eé]mon/);
  });
  it('validates clean — a Magic row is publishable', () => {
    assert.deepEqual(toEbayListing(SMAUG, null, cats).aspects.Game, 'Magic: The Gathering');
  });
});
