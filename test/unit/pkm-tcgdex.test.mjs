// test/unit/pkm-tcgdex.test.mjs — the English backup source's SHAPE, pinned.
//
// lib/pkm-tcgdex.mjs exists because on 2026-08-31 pokemontcg.io answered 500/502 for hours and a
// single card lookup had nowhere else to go. Its whole job is to hand back a record the rest of the
// suite cannot tell apart from the real one — so what is worth testing is not that it fetches, but
// that the translation is exact. The mapper is pure; nothing here touches the network.
//
// The one that matters most is THE ID RULE. `identityKey` for an English card IS `card.id`
// (lib/stock-games.mjs), and the two sources pad numbers differently: pokemontcg.io writes the
// first card of 151 as `sv3pt5-1`, TCGdex writes it `sv03.5-001`. Carry the padding through and the
// same Bulbasaur holds stock under two keys depending on which source happened to answer that day.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toPtcgCard, localIdCandidates } from '../../lib/pkm-tcgdex.mjs';

// A TCGdex record, in the shape their /v2/en/cards/:id really returns (verified live 2026-08-31).
const tcgdex = (over = {}) => ({
  category: 'Pokemon',
  id: 'sv03.5-001',
  illustrator: 'Narumi Sato',
  image: 'https://assets.tcgdex.net/en/sv/sv03.5/001',
  localId: '001',
  name: 'Bulbasaur',
  rarity: 'Common',
  set: { id: 'sv03.5', name: '151', cardCount: { official: 165, total: 207 }, abbreviation: 'MEW' },
  dexId: [1],
  hp: 70,
  types: ['Grass'],
  stage: 'Basic',
  regulationMark: 'G',
  pricing: { tcgplayer: { unit: 'USD', updated: '2026-08-30T15:19:59.378Z', normal: { lowPrice: 1, midPrice: 2, highPrice: 3, marketPrice: 2.5, directLowPrice: 4 } } },
  ...over,
});

describe('toPtcgCard — THE ID RULE', () => {
  it('unpads a numeric localId so the id matches pokemontcg.io exactly', () => {
    const c = toPtcgCard(tcgdex(), 'sv3pt5');
    assert.equal(c.id, 'sv3pt5-1', 'pokemontcg.io calls this card sv3pt5-1, so we must too');
    assert.equal(c.number, '1');
  });
  it('builds the id around OUR set id, never TCGdex’s', () => {
    // TCGdex's own set id is sv03.5. Letting it through would mint a whole parallel catalogue.
    assert.equal(toPtcgCard(tcgdex(), 'sv3pt5').id.startsWith('sv3pt5-'), true);
    assert.equal(toPtcgCard(tcgdex(), 'sv3pt5').set.id, 'sv3pt5');
  });
  it('leaves an alphanumeric number alone — padding it would be a guess', () => {
    const c = toPtcgCard(tcgdex({ localId: 'SWSH284' }), 'swshp');
    assert.equal(c.id, 'swshp-SWSH284');
    assert.equal(c.number, 'SWSH284');
  });
  it('a three-digit number is already unpadded and passes through unchanged', () => {
    assert.equal(toPtcgCard(tcgdex({ localId: '162' }), 'rsv10pt5').id, 'rsv10pt5-162');
  });
});

describe('toPtcgCard — the vocabularies the eBay aspects are built from', () => {
  it('title-cases the rarity, because a near-miss earns no eBay facet', () => {
    // TCGdex writes sentence case ("Illustration rare"); pokemontcg.io writes "Illustration Rare",
    // and that string is copied verbatim into the listing's Rarity aspect.
    assert.equal(toPtcgCard(tcgdex({ rarity: 'Illustration rare' }), 'sv3pt5').rarity, 'Illustration Rare');
    assert.equal(toPtcgCard(tcgdex({ rarity: 'Ultra Rare' }), 'sv3pt5').rarity, 'Ultra Rare');
  });
  it('puts the accent back on Pokémon — Card Type is an aspect too', () => {
    assert.equal(toPtcgCard(tcgdex(), 'sv3pt5').supertype, 'Pokémon');
    assert.equal(toPtcgCard(tcgdex({ category: 'Trainer' }), 'sv3pt5').supertype, 'Trainer');
  });
  it('rebuilds subtypes[] from stage + suffix, which is all pkmStage() reads', () => {
    assert.deepEqual(toPtcgCard(tcgdex(), 'sv3pt5').subtypes, ['Basic']);
    assert.deepEqual(toPtcgCard(tcgdex({ stage: 'Stage1', suffix: 'ex' }), 'sv3pt5').subtypes, ['Stage 1', 'ex']);
    assert.deepEqual(toPtcgCard(tcgdex({ stage: 'Stage2' }), 'sv3pt5').subtypes, ['Stage 2']);
  });
  it('carries hp as a string, dex numbers and the regulation mark', () => {
    const c = toPtcgCard(tcgdex(), 'sv3pt5');
    assert.equal(c.hp, '70');
    assert.deepEqual(c.nationalPokedexNumbers, [1]);
    assert.equal(c.regulationMark, 'G');
    assert.equal(c.artist, 'Narumi Sato');
  });
  it('asks for PNG art, not webp — these bytes go to eBay EPS', () => {
    const c = toPtcgCard(tcgdex(), 'sv3pt5');
    assert.match(c.images.large, /\/high\.png$/);
    assert.match(c.images.small, /\/low\.webp$/);
  });
});

describe('toPtcgCard — prices', () => {
  it('remaps the kebab-case printing keys onto the vocabulary PRINTING_TO_FINISH indexes by', () => {
    const c = toPtcgCard(tcgdex({ pricing: { tcgplayer: {
      unit: 'USD', updated: 'x',
      'reverse-holofoil': { lowPrice: 1, marketPrice: 2 },
      holofoil: { marketPrice: 9 },
    } } }), 'sv3pt5');
    assert.deepEqual(Object.keys(c.tcgplayer.prices).sort(), ['holofoil', 'reverseHolofoil']);
    assert.equal(c.tcgplayer.prices.reverseHolofoil.low, 1);
    assert.equal(c.tcgplayer.prices.holofoil.market, 9);
  });
  it('DROPS an unrecognised printing rather than transliterating it (GR5)', () => {
    // A printing invented upstream must not become a finish on a listing for a card that does not
    // have it. Absent is recoverable; wrong is not.
    const c = toPtcgCard(tcgdex({ pricing: { tcgplayer: { unit: 'USD', 'quantum-holofoil': { marketPrice: 5 }, normal: { marketPrice: 1 } } } }), 'sv3pt5');
    assert.deepEqual(Object.keys(c.tcgplayer.prices), ['normal']);
  });
  it('a card with no price block gets tcgplayer:null, never a zero', () => {
    // The runner reads a missing market figure as "no second opinion" and says so. A zero would
    // read as a real number and fire the disagreement detector on every row.
    assert.equal(toPtcgCard(tcgdex({ pricing: undefined }), 'sv3pt5').tcgplayer, null);
    assert.equal(toPtcgCard(tcgdex({ pricing: { tcgplayer: { unit: 'USD', updated: 'x' } } }), 'sv3pt5').tcgplayer, null);
  });
  it('stamps the source so nothing mistakes a stand-in for the record', () => {
    assert.equal(toPtcgCard(tcgdex(), 'sv3pt5').__source, 'tcgdex');
  });
});

describe('localIdCandidates — the padding the two sources disagree on', () => {
  it('tries the number as typed first, then the padded forms', () => {
    assert.deepEqual(localIdCandidates('1'), ['1', '001', '01']);
    assert.deepEqual(localIdCandidates('25'), ['25', '025']);
  });
  it('costs exactly one request for a three-digit number', () => {
    assert.deepEqual(localIdCandidates('162'), ['162']);
  });
  it('offers the unpadded form for an already-padded number', () => {
    assert.deepEqual(localIdCandidates('001'), ['001', '1']);
  });
  it('never pads a non-numeric number', () => {
    assert.deepEqual(localIdCandidates('SWSH284'), ['SWSH284']);
    assert.deepEqual(localIdCandidates('TG12'), ['TG12']);
  });
  it('an empty number asks for nothing', () => {
    assert.deepEqual(localIdCandidates(''), []);
    assert.deepEqual(localIdCandidates(null), []);
  });
});
