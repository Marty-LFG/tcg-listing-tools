// test/unit/ebay-aspects.test.mjs — the eBay AU 183454 item-specific derivations. Every enum asserted
// here was read live from getItemAspectsForCategory (tree 15, EBAY_AU, 2026-07-26). The first live
// listing carried 9 aspects, three of its description rows were blank and it had no picture; these
// guard the fixes. eBay silently DROPS a FREE_TEXT value that misses its enum and REJECTS a
// SELECTION_ONLY one, so a near-miss is worse than an absent value — hence "unset, never guessed".
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toEbayListing, loadEbayCategories, ebayFinish, ebayAttribute, ebayCardType, ebayStage,
  ebaySpeciality, ebayManufacturer, ebayYearManufactured, ebaySetName, ebayRarity, ebayFeatures,
  ebayCharacters, buildItemDescription,
} from '../../lib/channels/ebay-map.mjs';

const cats = loadEbayCategories();

// The card that exposed all of this, with the facts the uploader now persists and passes through.
const GARDEVOIR = {
  sku: 'BK-PKM-000010', game: 'pokemon', name: 'Radiant Gardevoir', set_name: 'Lost Origin',
  number: '069/196', rarity: 'Radiant Rare', language: 'EN', variant: 'Holo', finish: 'Holo',
  condition: 'Ungraded, Near Mint', quantity: 1, target_price_cents: 498,
  image_url: 'https://images.pokemontcg.io/swsh11/69_hires.png', artist: 'Ryuta Fuse',
  supertype: 'Pokémon', subtypes: ['Basic', 'Radiant'], types: ['Psychic'], hp: '130',
  pokedex_numbers: [282], regulation_mark: 'F', set_code: 'LOR', set_release_date: '2022/09/09',
};

describe('aspect derivation helpers', () => {
  it('Finish maps our vocabulary onto eBay\'s four values, and nothing else', () => {
    assert.equal(ebayFinish('Holofoil'), 'Holo');
    assert.equal(ebayFinish('Reverse Holofoil'), 'Reverse Holo');
    assert.equal(ebayFinish('Base'), 'Regular');
    assert.equal(ebayFinish('Normal'), 'Regular');
    assert.equal(ebayFinish('Cosmos Foil'), 'Foil');
    assert.equal(ebayFinish('Sparkly'), null, 'unknown finish must be unset, never a near-miss');
    assert.equal(ebayFinish(''), null);
  });

  it('Attribute uses the AU British spelling', () => {
    assert.equal(ebayAttribute(['Colorless']), 'Colourless', "eBay AU's member is Colourless");
    assert.equal(ebayAttribute(['Psychic']), 'Psychic');
    assert.equal(ebayAttribute(['Darkness']), 'Darkness', "'Dark' is a different eBay member");
    assert.equal(ebayAttribute(['Bug']), null);
  });

  it('Card Type resolves the 11 Pokémon-constrained values, including energy', () => {
    assert.equal(ebayCardType('Pokémon', ['Basic']), 'Pokémon');
    assert.equal(ebayCardType('Energy', ['Basic']), 'Energy-Basic', "plain 'Energy' is not an eBay value");
    assert.equal(ebayCardType('Energy', ['Special']), 'Energy-Special');
    assert.equal(ebayCardType('Trainer', ['Supporter']), 'Trainer-Supporter');
    assert.equal(ebayCardType('Trainer', ['Item']), 'Trainer-Item');
    assert.equal(ebayCardType('Trainer', ['Pokémon Tool']), 'Pokémon Tool');
    assert.equal(ebayCardType('Trainer', []), 'Trainer');
  });

  it('Stage allows only the three Pokémon values (the rest are Digimon)', () => {
    assert.equal(ebayStage(['Stage 2']), 'Stage 2');
    assert.equal(ebayStage(['Basic', 'Radiant']), 'Basic');
    assert.equal(ebayStage(['Mega']), null, 'Mega is a Digimon stage on 183454');
    assert.equal(ebayStage([]), null);
  });

  it('Speciality leaves modern mechanics unset rather than near-missing them', () => {
    assert.equal(ebaySpeciality(['VMAX']), 'VMAX');
    assert.equal(ebaySpeciality(['TAG TEAM', 'GX']), 'TAG TEAM');
    assert.equal(ebaySpeciality(['VSTAR']), null, 'VSTAR has no enum member');
    assert.equal(ebaySpeciality(['Radiant']), null, 'Radiant has no enum member');
  });

  it('Manufacturer switches at the WotC handover, English only', () => {
    assert.equal(ebayManufacturer('pokemon', 'EN', '1999/01/09'), 'Wizards of the Coast');
    assert.equal(ebayManufacturer('pokemon', 'EN', '2003/07/01'), 'The Pokémon Company');
    assert.equal(ebayManufacturer('pokemon', 'JP', '1999/01/09'), 'The Pokémon Company', 'WotC never published Japanese');
    assert.equal(ebayManufacturer('mtg', 'EN', '1999/01/09'), null);
  });

  it('Year Manufactured is clamped — SELECTION_ONLY rejects an out-of-range value', () => {
    assert.equal(ebayYearManufactured('2022/09/09'), '2022');
    assert.equal(ebayYearManufactured('1889/01/01'), null);
    assert.equal(ebayYearManufactured('2099/01/01'), null);
    assert.equal(ebayYearManufactured(''), null);
  });

  it('Set and Rarity rewrite only where eBay spells it differently', () => {
    assert.equal(ebaySetName('Lost Origin'), 'Sword & Shield - Lost Origin');
    assert.equal(ebaySetName('Surging Sparks'), 'Surging Sparks', 'no enum entry → verbatim, never an invented prefix');
    assert.equal(ebayRarity('Rare Holo'), 'Holo Rare');
    assert.equal(ebayRarity('Illustration Rare'), 'Illustration Rare', 'modern rarities have no enum entry');
  });

  it('Character resolves the BASE SPECIES from the dex number, not the printed name', () => {
    // The enum carries 'Gardevoir', not 'Radiant Gardevoir' — string surgery on the card name would
    // also mangle "Iono's Bellibolt" and δ-delta cards.
    assert.deepEqual(ebayCharacters({ pokedex_numbers: [282] }), ['Gardevoir']);
    assert.deepEqual(ebayCharacters({ pokedex_numbers: [25, 644] }), ['Pikachu', 'Zekrom'], 'TAG TEAM duos give two values');
    assert.deepEqual(ebayCharacters({ pokedex_numbers: [] }), []);
  });

  it('Features only claims what the record proves', () => {
    assert.deepEqual(ebayFeatures({ edition: '1st Edition' }), ['1st Edition']);
    assert.deepEqual(ebayFeatures({ rarity: 'Special Illustration Rare' }), ['Full Art']);
    assert.deepEqual(ebayFeatures({ rarity: 'Radiant Rare' }), [], 'Radiant has no Features member');
  });
});

describe('toEbayListing — the full aspect set for the card that exposed this', () => {
  const l = toEbayListing(GARDEVOIR, null, cats);

  it('carries every aspect we can prove, and none we cannot', () => {
    assert.equal(l.aspects['Game'], 'Pokémon TCG');
    assert.equal(l.aspects['Set'], 'Sword & Shield - Lost Origin');
    assert.equal(l.aspects['Card Type'], 'Pokémon');
    assert.deepEqual(l.aspects['Character'], ['Gardevoir']);
    assert.equal(l.aspects['Attribute/MTG:Colour'], 'Psychic');
    assert.equal(l.aspects['Stage'], 'Basic');
    assert.equal(l.aspects['HP'], '130');
    assert.equal(l.aspects['Finish'], 'Holo');
    assert.equal(l.aspects['Manufacturer'], 'The Pokémon Company');
    assert.equal(l.aspects['Card Size'], 'Standard');
    assert.equal(l.aspects['Year Manufactured'], '2022');
    assert.equal(l.aspects['Autographed'], 'No');
    assert.equal(l.aspects['Material'], 'Card Stock');
    assert.equal(l.aspects['Speciality'], undefined, 'Radiant has no Speciality enum member');
    assert.ok(Object.keys(l.aspects).length >= 18, 'the live listing shipped 9; ' + Object.keys(l.aspects).length + ' now');
  });

  it('renders a description with the card image and no empty rows', () => {
    const d = l.descriptionHtml;
    assert.match(d, /<img/, 'the card image was missing entirely on the first live listing');
    assert.equal((d.match(/<td[^>]*><\/td>/g) || []).length, 0, 'Pokémon/Stage/Finish rendered blank before');
    assert.match(d, /Gardevoir/);
    assert.match(d, /English/, "the Language row read the raw 'EN' code before");
  });

  it('a Trainer card omits the Pokémon-only rows rather than rendering them blank', () => {
    const trainer = toEbayListing({ ...GARDEVOIR, name: "Professor's Research", supertype: 'Trainer',
      subtypes: ['Supporter'], types: [], hp: '', pokedex_numbers: [] }, null, cats);
    assert.equal(trainer.aspects['Card Type'], 'Trainer-Supporter');
    assert.equal(trainer.aspects['Stage'], undefined);
    assert.equal(trainer.aspects['Character'], undefined);
    assert.equal((trainer.descriptionHtml.match(/<td[^>]*><\/td>/g) || []).length, 0);
  });

  it('a thin row (bulk, no lookup) still builds without inventing anything', () => {
    const thin = toEbayListing({ sku: 'T', game: 'pokemon', name: 'Pikachu', set_name: 'Base Set',
      number: '58/102', condition: 'Near Mint', quantity: 1, target_price_cents: 500 }, null, cats);
    assert.equal(thin.aspects['Game'], 'Pokémon TCG');
    assert.equal(thin.aspects['HP'], undefined);
    assert.equal(thin.aspects['Character'], undefined);
    assert.equal(thin.aspects['Year Manufactured'], undefined);
  });
});

describe('buildItemDescription — the post-EPS re-render', () => {
  it('swaps in the eBay-hosted hero image', () => {
    const d = buildItemDescription(GARDEVOIR, { imageUrl: 'https://i.ebayimg.com/eps/hero.jpg', cats });
    assert.match(d, /i\.ebayimg\.com\/eps\/hero\.jpg/);
    assert.doesNotMatch(d, /images\.pokemontcg\.io/, 'the source CDN url must be replaced, not appended');
  });
  it('an owner description override still wins', () => {
    assert.equal(buildItemDescription({ ...GARDEVOIR, desc_override: '<p>mine</p>' }, { imageUrl: 'x', cats }), '<p>mine</p>');
  });
});
