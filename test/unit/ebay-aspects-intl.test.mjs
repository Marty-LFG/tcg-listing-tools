// test/unit/ebay-aspects-intl.test.mjs — a non-English Pokémon card, adapter to eBay payload.
//
// The interesting property is not any one function: it is that a Japanese card survives the WHOLE
// chain — normalizeIntlCard -> invRowFrom -> card_facts -> buildRowIn -> rowToFields ->
// buildDescription / toEbayListing — carrying its language, its own set identity and its own
// printed number. Every previous attempt to list one stopped at the first step, because the adapter
// stamped 'EN' on everything pokemontcg.io could see and pokemontcg.io cannot see these cards.
//
// The card is Abyss Eye (M5) #102 — the JP set that prompted the work. It holds 81 cards where the
// English counterpart (Pitch Black) holds 84, so a JP secret rare prints 102/081: a number that
// does not exist in the English set, and the thing a JP collector checks first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toEbayListing, loadEbayCategories, buildRowIn, ebayLanguageAspect, ebayLanguageName,
  ebayManufacturer,
} from '../../lib/channels/ebay-map.mjs';
import { rowToFields, buildDescription } from '../../lib/listing-copy.mjs';
import { adapterFor, compsQueryFor } from '../../lib/stock-games.mjs';

const cats = loadEbayCategories();
const GA = adapterFor('pokemon');

// The baked data/pokemon-intl-sets.json record shape.
const M5 = {
  code: 'M5', tcgdexId: 'M5', name_native: 'アビスアイ', name_en: 'Abyss Eye',
  serie: 'ポケモンカードゲーム MEGA', releaseDate: '2026-05-22', cardCount: 81,
  enEquivalent: { name: 'Pitch Black' }, pcSlug: 'pokemon-japanese-abyss-eye',
};
// A TCGdex single-card record, trimmed to the fields the adapter reads.
const TCGDEX = {
  id: 'M5-102', localId: '102', name: 'トリデプス', rarity: 'Illustration Rare',
  category: 'Pokemon', stage: 'Stage 2', hp: 150, types: ['Metal'], dexId: [411],
  illustrator: 'PLANETA Mochizuki', regulationMark: 'M',
  image: 'https://assets.tcgdex.net/ja/M5/102',
  variants: { firstEdition: false, holo: true, normal: false, reverse: false, wPromo: false },
  set: { id: 'M5', name: 'アビスアイ', cardCount: { official: 81, total: 102 } },
};
const DEX = {
  dex: { 411: 'Bastiodon' },
  ja: { 'トリデプス': 'Bastiodon' },
  romaji: { bastiodon: 'Torideps' },
};

// The synthetic intl card both stock pages build at the boundary: one shape, carrying its own
// language and set, so every adapter method works on it without being told which lane it is on.
const intl = (o = {}) => GA.intlCard({
  lang: 'JP', set: M5, full: TCGDEX, localId: '102', name: TCGDEX.name, rarity: TCGDEX.rarity,
  image: 'https://assets.tcgdex.net/ja/M5/102/high.png', source: 'tcgdex', ...o,
});
const nc = () => GA.normalizeCard(intl(), M5, DEX);

// What the uploader persists, with card_facts merged back on the way the publish path does it
// (itemToListing: JSON.parse(item.card_facts) onto the row).
function itemFor(overrides = {}) {
  const row = GA.invRowFrom(nc(), { finish: 'Holo', variant: 'Holo', condition: 'Ungraded, Near Mint' });
  const item = { sku: 'BK-PKM-000001', quantity: 1, target_price_cents: 4500, ...row, ...overrides };
  if (item.card_facts) Object.assign(item, JSON.parse(item.card_facts));
  if (!item.finish && item.variant) item.finish = item.variant;
  return item;
}

describe('normalizeIntlCard', () => {
  it('carries the language, so everything downstream has something to read', () => {
    assert.equal(nc().language, 'JP');
  });

  it('names the card in English, keeping the Latin suffix printed on it', () => {
    assert.equal(nc().name, 'Bastiodon');
    const ex = GA.normalizeCard(
      intl({ full: { ...TCGDEX, name: 'リザードンex', dexId: [] }, name: 'リザードンex' }),
      M5, { ...DEX, ja: { 'リザードン': 'Charizard' } },
    );
    assert.equal(ex.name, 'Charizard ex');
  });

  // GR10. The denominator is the JAPANESE set's count. Run through the English set's numbers this
  // would read 102/084, which is not on any card in either language.
  it('prints the number the way the JAPANESE card prints it', () => {
    assert.equal(nc().number, '102/081');
    assert.equal(nc().rawNumber, '102');
  });

  it('takes the English set name but keeps the native code as the set identity', () => {
    assert.equal(nc().setName, 'Abyss Eye');
    assert.equal(nc().setCode, 'M5');
    assert.equal(nc().facts.set_code, 'M5');
    assert.equal(nc().facts.native_set, 'アビスアイ');
    assert.equal(nc().facts.en_set, 'Pitch Black');
  });

  it('namespaces the identity key with its lane', () => {
    assert.equal(nc().identityKey, 'ja:m5-102');
  });

  it('reads the printing off TCGdex variants, not off the rarity string', () => {
    assert.deepEqual(nc().printings.map((p) => p.variant), ['Holo']);
  });

  // PriceCharting supplies an English name and real JPEG art but no facts; TCGdex supplies the
  // facts. Dropping the enrich step is what would make a JP listing thinner than an English one.
  it('prefers PriceCharting art and name, and still keeps the TCGdex facts', () => {
    const merged = GA.normalizeCard(intl({
      source: 'pricecharting', name: 'Bastiodon',
      image: 'https://storage.googleapis.com/images.pricecharting.com/abc/1600.jpg',
    }), M5, DEX);
    assert.equal(merged.name, 'Bastiodon');
    assert.equal(merged.image, 'https://storage.googleapis.com/images.pricecharting.com/abc/1600.jpg');
    assert.equal(merged.rarity, 'Illustration Rare');       // from the TCGdex enrich
    assert.deepEqual(merged.facts.pokedex, [411]);          // ditto — this is the Character aspect
    assert.equal(merged.facts.native_name, 'トリデプス');   // still the native name for the description
  });

  // The image is downloaded and re-uploaded to eBay EPS, so it has to be a real file — not the
  // builder's display-only .webp, and not an extension-less base URL.
  it('asks TCGdex for a PNG, not the display webp', () => {
    assert.equal(nc().image, 'https://assets.tcgdex.net/ja/M5/102/high.png');
    assert.equal(/\.webp$/.test(nc().image), false);
  });

  // The runner's per-set index is TCGdex's briefs endpoint: a name, a number and a picture. No
  // rarity, no dexId, no variants. It still has to produce a listable row.
  it('builds a usable row from the runner’s per-set index alone', () => {
    const fromIndex = GA.intlCardFromIndex(
      { numRaw: '102', name: 'トリデプス', rarity: '', imgLarge: 'https://assets.tcgdex.net/ja/M5/102/high.png', source: 'tcgdex' },
      M5, 'JP',
    );
    const r = GA.normalizeCard(fromIndex, M5, DEX);
    assert.equal(r.language, 'JP');
    assert.equal(r.identityKey, 'ja:m5-102');
    assert.equal(r.number, '102/081');
    assert.equal(r.name, 'Bastiodon');       // resolved through the dex, not left in katakana
    assert.deepEqual(r.printings, []);       // no variants on a brief — the caller under-promises
  });

  it('degrades to a usable row when neither source answers (GR7)', () => {
    const bare = GA.normalizeCard(GA.intlCard({ lang: 'JP', set: M5, localId: '102' }), M5, DEX);
    assert.equal(bare.language, 'JP');
    assert.equal(bare.setName, 'Abyss Eye');
    assert.equal(bare.identityKey, 'ja:m5-102');
    assert.equal(bare.name, '');            // the operator types it
    assert.deepEqual(bare.printings, []);
  });
});

describe('the eBay payload', () => {
  it('faces the card as Japanese', () => {
    const listing = toEbayListing(itemFor(), null, cats);
    assert.equal(listing.aspects.Language, 'Japanese');
    assert.equal(ebayLanguageAspect('JP'), 'Japanese');
  });

  // TW is a distinct stored code (a Traditional print is a different product) but eBay has one
  // Chinese member. Before this it mapped to nothing and the aspect was dropped silently.
  it('faces every stock lane, including Traditional Chinese', () => {
    for (const [code, name] of [['JP', 'Japanese'], ['CN', 'Chinese'], ['TW', 'Chinese'], ['KO', 'Korean'], ['EN', 'English']]) {
      assert.equal(ebayLanguageAspect(code), name, code);
      assert.equal(ebayLanguageName(code), name, code);
    }
  });

  it('still says The Pokémon Company for an old-dated Japanese card', () => {
    // The Wizards branch is gated on English, so a pre-2003 JP set must not claim it.
    assert.equal(ebayManufacturer('pokemon', 'JP', '1999/01/09'), 'The Pokémon Company');
    assert.equal(ebayManufacturer('pokemon', 'EN', '1999/01/09'), 'Wizards of the Coast');
  });

  it('keeps the JAPANESE set name on the Set aspect, verbatim', () => {
    // Set is FREE_TEXT: an unmatched value lists fine and simply earns no facet. Mapping it to the
    // English counterpart would assert a different product — different card count, and a number
    // (102/081) that does not exist there.
    assert.equal(toEbayListing(itemFor(), null, cats).aspects.Set, 'Abyss Eye');
  });

  it('derives Character from the TCGdex dexId', () => {
    assert.deepEqual(toEbayListing(itemFor(), null, cats).aspects.Character, ['Bastiodon']);
  });

  it('carries the printed number and the rarity through', () => {
    const a = toEbayListing(itemFor(), null, cats).aspects;
    assert.equal(a['Card Number'], '102/081');
    assert.equal(a.Rarity, 'Illustration Rare');
  });

  // An absent aspect is correct; a guessed one is not. PriceCharting-only rows have no rarity.
  it('omits Rarity rather than inventing one when the source has none', () => {
    const a = toEbayListing(itemFor({ rarity: '' }), null, cats).aspects;
    assert.equal('Rarity' in a, false);
  });
});

describe('the description', () => {
  const html = () => buildDescription('pokemon', rowToFields(buildRowIn(itemFor(), cats)));

  it('keeps JP in the title, above the condition code', () => {
    const title = toEbayListing(itemFor(), null, cats).title;
    assert.match(title, /\bJP\b/);
    assert.match(title, /102\/081/);
  });

  it('renders the native name, the romaji and the native set', () => {
    const h = html();
    assert.match(h, /トリデプス/);
    assert.match(h, /Torideps/);
    assert.match(h, /アビスアイ/);
  });

  // The cross-reference a JP buyer actually wants: which English set this corresponds to.
  it('renders the English-equivalent set as its own row', () => {
    assert.match(html(), /English set/);
    assert.match(html(), /Pitch Black/);
  });

  it('says Japanese, not JP, in the details table', () => {
    assert.match(html(), /Japanese/);
  });

  // GR8 — eBay strips active content, so the description is inline styles only.
  it('is still inline-style only', () => {
    assert.equal(/<(style|script)\b|\son\w+=|\sclass=/i.test(html()), false);
  });

  // Through the SAME path as the JP row above, so this is a like-for-like comparison: an English
  // card must gain no provenance rows and lose nothing.
  it('leaves an English description untouched by any of this', () => {
    const en = { game: 'pokemon', name: 'Pikachu', number: '25/165', set_name: '151', rarity: 'Common', finish: 'Normal', language: 'EN' };
    const h = buildDescription('pokemon', rowToFields(buildRowIn(en, cats)));
    assert.equal(/English set/.test(h), false, 'no en_set cross-reference on an English card');
    assert.match(h, />English</, 'the Language row still reads English');
  });
});

describe('the comps query', () => {
  // The language FILTER keeps a Japanese title and an English one (a JP listing is often titled
  // bilingually), so without the word in the QUERY a JP card searched the English market and the
  // filter happily kept the English results.
  it('adds the language word and the native set code for a Japanese row', () => {
    const q = compsQueryFor('pokemon', { name: 'Bastiodon', set_name: 'Abyss Eye', set_code: 'M5', language: 'JP' }, '102/081');
    assert.equal(q, 'Pokemon Bastiodon 102/081 Abyss Eye M5 Japanese');
  });

  it('leaves an English query byte-identical to what it always was', () => {
    const q = compsQueryFor('pokemon', { name: 'Pikachu', set_name: '151', set_code: 'MEW', language: 'EN' }, '25/165');
    assert.equal(q, 'Pokemon Pikachu 25/165 151');
  });

  // Many intl sets have no romanised name, so setEnglishName falls back to the printed code and
  // set_name IS set_code — "SV1S SV1S Chinese" spent a token to say the same thing twice.
  it('does not repeat the set code when it IS the set name', () => {
    const q = compsQueryFor('pokemon', { name: 'Cacnea', set_name: 'SV1S', set_code: 'SV1S', language: 'TW' }, '001/078');
    assert.equal(q, 'Pokemon Cacnea 001/078 SV1S Chinese');
  });

  it('never says "English" — English listings are unmarked', () => {
    for (const language of ['EN', '', null, undefined]) {
      assert.equal(/English/.test(compsQueryFor('pokemon', { name: 'X', set_name: 'S', set_code: 'C', language }, '1')), false);
    }
  });
});
