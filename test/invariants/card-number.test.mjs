// test/invariants/card-number.test.mjs — Golden Rule 10: every Pokémon collector number is
// rendered by the shared formatter (extras.js TCG.formatCardNumber ⇄ lib/listing-copy.mjs),
// never by hand-concatenating number + '/' + printedTotal.
//
// The printed number is era-, promo- and subset-dependent — 012/086 (Scarlet & Violet) vs
// 58/102 (Base) vs SWSH039 (promo, no denominator) vs TG01/TG30 (subset) — so a local
// concatenation silently emits a number that does not exist on the card. That was the bug
// this rule was written for: a card printed 106/086 was listed as 106/86.
//
// The ban is paired with a POSITIVE assertion that each surface really calls the helper,
// because an absence-of-string check alone would pass on dead code (same lesson as
// middleware-extraction.test.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';

// Pokémon surfaces that build — or could start building — a collector number. The helper's
// own two homes (extras.js, lib/listing-copy.mjs) are excluded: they ARE the implementation.
// Other games are excluded on purpose — SWU is number/SETCODE, and Riftbound / One Piece /
// MTG / Lorcana each have their own shape that must NOT be routed through this formatter.
const POKEMON_SURFACES = [
  'pokemon-listing-builder.html',
  'card-grader.html',
  'lib/enumerate.mjs',
  'catalog.html',
  'lib/catalog.mjs',
];

// Surfaces that must actually CALL the formatter (file -> minimum call count).
// pokemon-listing-builder has four lookup lanes: EN, MEP promo, PriceCharting, TCGdex intl.
const MUST_CALL = {
  'pokemon-listing-builder.html': 4,
  'card-grader.html': 1,
  'lib/enumerate.mjs': 1,
};

const SLASH_CONCAT = /\+\s*['"]\/['"]|['"]\/['"]\s*\+/;              // a lone "/" string being joined
const CARD_NUMBERISH = /\bnumber\b|localId|printedTotal|cardCount|f_num/i;

describe('Pokémon card numbers go through the shared formatter (GR10)', () => {
  it('no hand-rolled number + "/" + total concatenation', () => {
    const hits = [];
    for (const rel of POKEMON_SURFACES) {
      read(rel).split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|<!--)/.test(line)) return;                  // doc comments quote sample output
        if (SLASH_CONCAT.test(line) && CARD_NUMBERISH.test(line)) {
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    assert.deepEqual(hits, [], 'build these with formatCardNumber() instead:\n' + hits.join('\n'));
  });

  it('the Pokémon surfaces actually call the formatter', () => {
    for (const [rel, min] of Object.entries(MUST_CALL)) {
      const n = (read(rel).match(/formatCardNumber\(/g) || []).length;
      assert.ok(n >= min, `${rel}: expected >= ${min} formatCardNumber() call(s), found ${n}`);
    }
  });

  it('both mirror homes still define the helper', () => {
    assert.match(read('extras.js'), /TCG\.formatCardNumber=function/, 'extras.js lost the client copy');
    assert.match(read('lib/listing-copy.mjs'), /export function formatCardNumber/, 'listing-copy lost the server twin');
    // The parity harness extracts by this exact marker style (scripts/check-listing-copy.mjs).
    assert.match(read('extras.js'), /TCG\.cardNumberKey=function/, 'extras.js lost cardNumberKey');
  });
});
