// The Japanese card-art repair, and above all the rule that decides when NOT to repair.
//
// PriceCharting sometimes carries a card's illustration crop instead of the card scan — measured
// 2026-08-23, M6 Storm Emeralda 12 of 113. That crop would go to eBay as the product photo.
//
// The naive rule ("not portrait, therefore broken") is wrong on real data, twice. Storm Emeralda
// introduced PAIRED STADIUM cards, and for those Serebii serves the JOINED PAIR — #73 Legendary
// Summit measures 1736x1212, exactly two 868x1212 cards side by side — while PriceCharting has the
// correct single card. A threshold rule would put a two-card picture on a one-card listing, which is
// worse than the crop it set out to fix. So the rule compares the two sources and only ever swaps
// toward a single card.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideArtOverride, isSingleCardAspect, serebiiSlug, serebiiCardUrl, jpPokemonArt, clearJpArtCache,
  serebiiAlignment, parseSerebiiIndex, artName,
} from '../../lib/pokemon-jp-art.mjs';

// Real measurements, 2026-08-23.
const CARD = 868 / 1212;          // 0.716 — a single Japanese card
const PC_PADDED = 259 / 320;      // 0.809 — PriceCharting pads some legitimate single-card scans
const CROP = 320 / 187;           // 1.711 — #68 Aarune, the illustration crop
const PAIR = 1736 / 1212;         // 1.432 — #73 Legendary Summit, two cards side by side

describe('isSingleCardAspect', () => {
  it('accepts a card, including PriceCharting\'s padded one', () => {
    assert.equal(isSingleCardAspect(CARD), true);
    assert.equal(isSingleCardAspect(PC_PADDED), true, '0.809 is a real single card, measured on M6 #72');
  });
  it('rejects a crop and a joined pair alike', () => {
    assert.equal(isSingleCardAspect(CROP), false);
    assert.equal(isSingleCardAspect(PAIR), false);
  });
  it('rejects nonsense rather than guessing', () => {
    for (const v of [null, undefined, NaN, 0, 'x']) assert.equal(isSingleCardAspect(v), false, String(v));
  });
});

describe('decideArtOverride — compare, never threshold', () => {
  const OK = { setAligned: true };

  it('swaps the illustration crop for the real scan (#68 Aarune)', () => {
    assert.equal(decideArtOverride({ pcAspect: CROP, serebiiAspect: CARD, ...OK }), 'substitute');
  });

  it('KEEPS PriceCharting when Serebii has the joined pair (#73 Legendary Summit)', () => {
    // The whole reason this is a comparison. PriceCharting has the single card here and Serebii
    // does not — swapping would misrepresent a one-card listing as two.
    assert.equal(decideArtOverride({ pcAspect: 237 / 320, serebiiAspect: PAIR, ...OK }), 'keep');
  });

  it('leaves a genuinely non-portrait card alone when both sources agree it is one', () => {
    assert.equal(decideArtOverride({ pcAspect: PAIR, serebiiAspect: PAIR, ...OK }), 'keep');
  });

  it('never touches a card PriceCharting already has right', () => {
    assert.equal(decideArtOverride({ pcAspect: CARD, serebiiAspect: CARD, ...OK }), 'keep');
    assert.equal(decideArtOverride({ pcAspect: PC_PADDED, ...OK }), 'keep', 'and does not even need Serebii to say so');
  });

  it('keeps what it has when Serebii offers nothing', () => {
    assert.equal(decideArtOverride({ pcAspect: CROP, serebiiAspect: null, ...OK }), 'keep');
  });

  it('refuses every swap in a set whose numbering is not corroborated', () => {
    // The swap is BY NUMBER. Without proof the two catalogues number the set the same way, a
    // substitution is a coin flip on showing a different card.
    assert.equal(decideArtOverride({ pcAspect: CROP, serebiiAspect: CARD, setAligned: false }), 'keep');
    assert.equal(decideArtOverride({ pcAspect: CROP, serebiiAspect: CARD }), 'keep', 'unknown is not aligned');
  });
});

describe('serebiiAlignment — prove the numbering, tolerate the translations', () => {
  const pc = (n, name) => ({ number: String(n), name });

  it('accepts a set that agrees on names apart from translation noise', () => {
    // Real M6 shape: PriceCharting says "Delicious Onigiri" where Serebii says "Yummy Onigiri", and
    // "Adventuring Lantern" where it says "Adventure Lantern". Same cards, different translators.
    const cards = Array.from({ length: 20 }, (_, i) => pc(i + 1, 'Card' + (i + 1)));
    const names = Object.fromEntries(cards.map((c) => [c.number, c.name]));
    names['3'] = 'Yummy Onigiri'; names['7'] = 'Adventure Lantern';
    const a = serebiiAlignment(cards, names);
    assert.equal(a.both, 20);
    assert.equal(a.match, 18);
    assert.equal(a.aligned, true, '90% is comfortably aligned');
  });

  it('refuses a set where the numbering has genuinely drifted', () => {
    const cards = Array.from({ length: 20 }, (_, i) => pc(i + 1, 'Card' + (i + 1)));
    const names = Object.fromEntries(cards.map((c) => [c.number, 'Card' + (i0(c) + 5)]));   // everything shifted
    function i0(c) { return Number(c.number); }
    assert.equal(serebiiAlignment(cards, names).aligned, false);
  });

  it('refuses to conclude anything from a tiny overlap', () => {
    assert.equal(serebiiAlignment([pc(1, 'Pikachu')], { 1: 'Pikachu' }).aligned, false, '1/1 is not evidence');
  });

  it('survives an empty or missing roster', () => {
    assert.equal(serebiiAlignment([], {}).aligned, false);
    assert.equal(serebiiAlignment(null, null).aligned, false);
  });

  it('compares names past PriceCharting\'s bracketed printing tags', () => {
    assert.equal(artName('Heracross [Reverse Holo]'), artName('Heracross'));
  });
});

describe('parseSerebiiIndex — both row shapes, or it reads a quarter of the set', () => {
  const HTML = [
    // Trainer: the name is the link text
    '<td class="cen"><a href="/card/stormemeralda/068.shtml">Aarune</a></td>',
    // Pokemon: the name is wrapped in a <font>. Matching only the shape above read 26 of 117.
    '<td class="cen"><a href="/card/stormemeralda/001.shtml"> <font size="2">Heracross</font> </a></td>',
    // The picture column links the same page around an <img> and must not be read as a name
    '<td><a href="/card/stormemeralda/001.shtml"><img src="/card/th/stormemeralda/1.jpg" /></a></td>',
    // another set entirely
    '<td><a href="/card/abysseye/050.shtml">Malamar</a></td>',
  ].join('\n');

  it('reads both shapes and strips the leading zeros', () => {
    const idx = parseSerebiiIndex(HTML, 'stormemeralda');
    assert.equal(idx['68'], 'Aarune');
    assert.equal(idx['1'], 'Heracross', 'the <font>-wrapped name is the one that used to be missed');
  });

  it('never reads another set\'s card', () => {
    assert.equal(parseSerebiiIndex(HTML, 'stormemeralda')['50'], undefined);
    assert.equal(parseSerebiiIndex(HTML, 'abysseye')['50'], 'Malamar');
  });

  it('is empty on junk rather than throwing', () => {
    assert.deepEqual(parseSerebiiIndex('', 'x'), {});
    assert.deepEqual(parseSerebiiIndex(null, 'x'), {});
  });
});

describe('serebii URLs', () => {
  it('slugs the English set name the way Serebii files it', () => {
    assert.equal(serebiiSlug('Storm Emeralda'), 'stormemeralda');
    assert.equal(serebiiSlug('Mega Dream ex'), 'megadreamex');
    assert.equal(serebiiSlug('Gold, Silver, to a New World...'), 'goldsilvertoanewworld');
    assert.equal(serebiiSlug(''), '');
  });
  it('uses the UNPADDED number — 068.jpg is a 404', () => {
    assert.equal(serebiiCardUrl('stormemeralda', '068'), 'https://www.serebii.net/card/stormemeralda/68.jpg');
    assert.equal(serebiiCardUrl('stormemeralda', 68), 'https://www.serebii.net/card/stormemeralda/68.jpg');
  });
});

describe('jpPokemonArt — who is allowed an override', () => {
  it('serves nothing for a non-Pokémon row', () => {
    clearJpArtCache();
    assert.equal(jpPokemonArt({ game: 'onepiece', language: 'JA', set_name: 'Storm Emeralda', number: '68' }), '');
  });
  it('serves nothing for a Korean or Chinese row', () => {
    // A Korean listing must never be handed a Japanese scan — the same rule that strips images off
    // the Japanese-twin card source.
    for (const language of ['KO', 'ZH-CN', 'EN']) {
      assert.equal(jpPokemonArt({ game: 'pokemon', language, set_name: 'Storm Emeralda', number: '68' }), '', language);
    }
  });
  it('serves nothing when there is no index', () => {
    clearJpArtCache();
    assert.equal(typeof jpPokemonArt({ game: 'pokemon', language: 'JA', set_name: 'No Such Set', number: '1' }), 'string');
  });
});
