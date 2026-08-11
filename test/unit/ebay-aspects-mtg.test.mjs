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

describe('mtgCardTypeAspect — a type LINE reduced to an eBay Card Type member', () => {
  // eBay keeps the supertype-bearing forms as members of their OWN (read live 2026-08-10:
  // 'Legendary Creature', 'Artifact Creature', 'Basic Land', 'Legendary Artifact', … are all in the
  // 30 that carry Game='Magic: The Gathering'), so the specific one is the better facet.
  it('prefers the card\'s own words when eBay has them as a member', () => {
    assert.equal(mtgCardTypeAspect('Legendary Creature — Dragon'), 'Legendary Creature');
    assert.equal(mtgCardTypeAspect('Basic Land — Mountain'), 'Basic Land');
    assert.equal(mtgCardTypeAspect('Legendary Planeswalker — Gandalf'), 'Legendary Planeswalker');
    assert.equal(mtgCardTypeAspect('Artifact Creature — Golem'), 'Artifact Creature');
    assert.equal(mtgCardTypeAspect('Legendary Enchantment Creature — God'), 'Legendary Enchantment Creature');
    assert.equal(mtgCardTypeAspect('Legendary Artifact'), 'Legendary Artifact');
  });
  it('drops subtypes', () => {
    assert.equal(mtgCardTypeAspect('Creature — Dwarf Warrior'), 'Creature');
    assert.equal(mtgCardTypeAspect('Enchantment'), 'Enchantment');
  });
  it('falls back to priority, not word order, when the exact form is NOT a member', () => {
    // 'Snow Creature' has no member; a Snow Creature is still a Creature to anyone shopping.
    assert.equal(mtgCardTypeAspect('Snow Creature — Bear'), 'Creature');
    assert.equal(mtgCardTypeAspect('Legendary Snow Artifact'), 'Artifact');
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

describe('Attribute/MTG:Colour — enabled, with the spelling eBay actually uses', () => {
  // Resolved live 2026-08-10: FREE_TEXT + SINGLE, so an unmatched value is dropped rather than
  // rejected — safe to send. The 27 members include Colourless and, crucially, Multicoloured.
  it('is on, now that the mode is known', () => {
    assert.equal(MTG_COLOUR_ASPECT_VERIFIED, true);
    assert.equal(mtgColourAspect('Red'), 'Red');
    assert.equal(mtgColourAspect('Colourless'), 'Colourless');
  });
  it('⚠ the member is Multicoloured — our DISPLAY word is Multicolour, and they differ', () => {
    assert.equal(mtgColourAspect('Multicolour'), 'Multicoloured');
    assert.equal(mtgColourAspect('Multicoloured'), 'Multicoloured');
  });
  it('tolerates US spellings from an override, and refuses anything else', () => {
    assert.equal(mtgColourAspect('Colorless'), 'Colourless');
    assert.equal(mtgColourAspect('Chartreuse'), null);
    assert.equal(mtgColourAspect(''), null);
  });
});

describe('mtgFeatures — the treatment IS a buyer-facing facet', () => {
  // Verified live 2026-08-10: Features carries Borderless / Extended Art / Full Art / Showcase /
  // Box Topper / Promo among its 39 members, all applying to Magic.
  it('promotes the treatment and the box-topper note', () => {
    assert.deepEqual(mtgFeatures(null, 'Borderless', ''), ['Borderless']);
    assert.deepEqual(mtgFeatures(null, 'Extended Art', 'Box Topper'), ['Extended Art', 'Box Topper']);
  });
  it('drops the values that are NOT members rather than inventing a facet', () => {
    assert.deepEqual(mtgFeatures(null, 'Normal', ''), [], "'Normal' is the absence of a treatment");
    assert.deepEqual(mtgFeatures(null, '', 'Headliner'), [], 'Headliner has no Features member');
  });
  it('universesbeyond is a BRAND marker — it is on all 479 HOB+HOC prints', () => {
    assert.deepEqual(mtgFeatures({ promo_types: ['universesbeyond'], full_art: false, promo: false }, 'Normal', ''), []);
    assert.deepEqual(mtgFeatures({ promo_types: ['headliner', 'universesbeyond'], promo: false }, 'Normal', 'Headliner'), []);
  });
  it('only what the record proves, and never a duplicate', () => {
    assert.deepEqual(mtgFeatures({ full_art: true, promo: true }, '', ''), ['Full Art', 'Promo']);
    assert.deepEqual(mtgFeatures({ full_art: true }, 'Full Art', ''), ['Full Art'], 'deduped');
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
    assert.equal(l.aspects['Card Type'], 'Legendary Creature');
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
