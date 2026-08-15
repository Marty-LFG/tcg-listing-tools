// test/unit/rail-previews-samples.test.mjs — the /api/listing-image/samples shaping for
// rail-previews.html (sampleFromCard + gameSamples in lib/listing-image-lab.mjs).
//
// The rows these produce are what the /preview route feeds composeMetaFor, so their SHAPE is the
// contract: set_name carries the "(CODE)" decoration the builders write (that is what splitSetIdent
// and the per-game set resolution expect), and a card that cannot yield a previewable sample
// returns null rather than a half-row that composes wrongly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sampleFromCard, gameSamples } from '../../lib/listing-image-lab.mjs';
import { GAMES } from '../../lib/normalize.mjs';

describe('sampleFromCard — one cached card, one publish-identical stockRow', () => {
  it('pokemon: pokemontcg.io shape, bare set identity (no paren decoration — the EN lane resolves it)', () => {
    const s = sampleFromCard('pokemon', {
      name: 'Magikarp', number: '203', rarity: 'Illustration Rare',
      set: { id: 'sv2', ptcgoCode: 'PAL', name: 'Paldea Evolved' },
      images: { small: 'https://images.pokemontcg.io/sv2/203.png', large: 'https://images.pokemontcg.io/sv2/203_hires.png' },
    });
    assert.equal(s.art, 'https://images.pokemontcg.io/sv2/203_hires.png');
    assert.deepEqual(s.stockRow, { game: 'pokemon', name: 'Magikarp', set_name: 'Paldea Evolved', set_code: 'PAL', number: '203', rarity: 'Illustration Rare', language: 'EN' });
  });
  it('mtg: Scryfall shape incl. the double-faced fallback, "(CODE)" set name', () => {
    const s = sampleFromCard('mtg', {
      name: 'Delver of Secrets', collector_number: '47', rarity: 'common', set: 'isd', set_name: 'Innistrad', lang: 'en',
      card_faces: [{ image_uris: { normal: 'https://cards.scryfall.io/normal/front/x.jpg' } }],
    });
    assert.equal(s.stockRow.set_name, 'Innistrad (ISD)');
    assert.match(s.art, /^https:\/\/cards\.scryfall\.io\//, 'a DFC must fall back to its front face art');
  });
  it('lorcana: version joins the name the way rows store it, set carries "(code)"', () => {
    const s = sampleFromCard('lorcana', {
      name: 'Elsa', version: 'Spirit of Winter', collector_number: '42', rarity: 'Legendary',
      set: { code: '1', name: 'The First Chapter' },
      image_uris: { digital: { normal: 'https://cards.lorcast.io/x.avif' } },
    });
    assert.equal(s.label, 'Elsa - Spirit of Winter');
    assert.equal(s.stockRow.set_name, 'The First Chapter (1)');
  });
  it('swu: subtitle joins, VariantType Normal collapses to no variant, hyperspace survives', () => {
    const base = { Set: 'SOR', Number: '010', Name: 'Darth Vader', Subtitle: 'Dark Lord of the Sith', Rarity: 'Legendary', FrontArt: 'https://x/vader.png', VariantType: 'Normal' };
    const s = sampleFromCard('swu', base, { setName: 'Spark of Rebellion' });
    assert.equal(s.label, 'Darth Vader, Dark Lord of the Sith');
    assert.equal(s.stockRow.set_name, 'Spark of Rebellion (SOR)');
    assert.equal(s.stockRow.variant, '');
    assert.equal(sampleFromCard('swu', { ...base, VariantType: 'Hyperspace' }, {}).stockRow.variant, 'Hyperspace');
  });
  it('onepiece: the card code IS the number, variant stays empty (the name carries any alt tag)', () => {
    const s = sampleFromCard('onepiece', {
      card_name: 'Shanks', card_set_id: 'OP01-120', rarity: 'SEC', set_id: 'OP-01', set_name: 'Romance Dawn',
      card_image: 'https://optcgapi.com/media/static/Card_Images/OP01-120.jpg',
    });
    assert.equal(s.stockRow.number, 'OP01-120');
    assert.equal(s.stockRow.set_name, 'Romance Dawn (OP-01)');
    assert.equal(s.stockRow.variant, '');
  });
  it('riftbound: the baked set rides in via ctx', () => {
    const s = sampleFromCard('riftbound', { name: 'Jinx, Demolitionist', num: '030/298', rarity: 'Rare', img: 'https://x/jinx.png' },
      { set: { name: 'Origins', code: 'OGN' } });
    assert.equal(s.stockRow.set_name, 'Origins (OGN)');
    assert.equal(s.stockRow.number, '030/298');
  });
  it('a card with no art or no name yields NOTHING — never a half-row', () => {
    assert.equal(sampleFromCard('pokemon', { name: 'X', set: {}, number: '1' }), null);
    assert.equal(sampleFromCard('swu', { Set: 'SOR', Number: '1' }, {}), null);
    assert.equal(sampleFromCard('mtg', null), null);
    assert.equal(sampleFromCard('nope', { name: 'X' }), null);
  });
});

describe('gameSamples — search + spread over the local caches', () => {
  // Disk-backed: on a host with cached cards these prove filtering; on a bare checkout they prove
  // the empty shape (never a crash). Neither outcome is vacuous.
  it('every game returns the { total, samples[] } shape without throwing', () => {
    for (const game of GAMES) {
      const r = gameSamples(game, '', 5);
      assert.equal(typeof r.total, 'number', game);
      assert.ok(Array.isArray(r.samples), game);
      assert.ok(r.samples.length <= 5, `${game} ignored the limit`);
      for (const s of r.samples) {
        assert.ok(s.art && s.label && s.stockRow, `${game} produced a half-sample`);
        assert.equal(s.stockRow.game, game);
      }
    }
  });
  it('a query filters, and an unmatchable query returns empty rather than the spread', () => {
    const r = gameSamples('pokemon', 'zzzz-no-such-card-zzzz', 10);
    assert.equal(r.samples.length, 0);
  });
});
