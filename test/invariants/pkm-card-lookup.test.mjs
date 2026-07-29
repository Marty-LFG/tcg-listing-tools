// test/invariants/pkm-card-lookup.test.mjs — guards that no Pokémon EN lane goes back to building
// a pokemontcg.io card id by concatenating the set id with whatever the seller typed.
//
// That concatenation IS the bug this suite exists for: `swshp-284` 404s because upstream stores
// `SWSH284`, so every promo, Trainer/Galarian Gallery and Shiny Vault card answered "No card
// found. Check the number." — 12 sets, in three separate pages that each had their own copy of
// the same line. The mapping now lives once in TCG.pkmLookupCard (see test/unit/pkm-resolve-
// number.test.mjs); this test is what stops a fourth lane, or a revert, from reintroducing it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';

// The three pages that look a Pokémon EN card up by set + number.
const PKM_EN_LANES = ['stock-uploader.html', 'pokemon-listing-builder.html', 'card-grader.html'];

describe('Pokémon EN card lookup resolves through the roster, never by concatenation', () => {
  for (const file of PKM_EN_LANES) {
    const src = read(file);

    it(`${file} calls TCG.pkmLookupCard`, () => {
      assert.match(src, /TCG\.pkmLookupCard\(/, `${file} must resolve via TCG.pkmLookupCard`);
    });

    it(`${file} builds no EN /cards/ URL from setId + '-' + a typed value`, () => {
      // Catches the shape `'/cards/'+encodeURIComponent(setId+'-'+num)` in any spacing/quoting,
      // which is exactly how all three lanes were written before the fix.
      //
      // EXCEPTION — the JP/CN/KO lane (`/api/tcgdex/…`) legitimately concatenates, because TCGdex
      // pads its ids and fetchTcgdexCard() already walks intlNumCandidates() zero-padded-first.
      // Different upstream, different (working) solution — this invariant is about the EN one.
      const concat = /(.{0,80})cards\/['"]\s*\+\s*encodeURIComponent\(\s*[A-Za-z_$][\w$.]*\s*\+\s*['"]-['"]\s*\+/g;
      const offenders = [...src.matchAll(concat)].filter((m) => !/tcgdex/i.test(m[1]));
      assert.deepEqual(offenders.map((m) => m[0].slice(-60)), [],
        `${file} must not concatenate the set id and the typed number into a pokemontcg.io card id`);
    });

    it(`${file} distinguishes source-down from no-match (GR7)`, () => {
      // An outage reported as "no card found" sends sellers hunting a typo that isn't there.
      assert.match(src, /source-down/, `${file} must branch on the source-down error`);
    });
  }
});

describe('the resolver itself stays shared in extras.js', () => {
  const extras = read('extras.js');
  it('exposes the three entry points the lanes rely on', () => {
    for (const fn of ['pkmRoster', 'pkmResolveNumber', 'pkmLookupCard']) {
      assert.match(extras, new RegExp('TCG\\.' + fn + '\\s*='), 'TCG.' + fn + ' must live in extras.js');
    }
  });
  it('resolves against the cached catalog roster, not a hardcoded prefix table', () => {
    // A prefix/padding table cannot express the real upstream data: bwp contradicts itself
    // (BW01 … BW004 … BW101) and the two Shiny Vaults disagree (SV1 vs SV001).
    assert.match(extras, /\/api\/catalog\/cards\?lang=en&set=/);
  });
  it('never pads the number it sends upstream (padding is display-only)', () => {
    // formatCardNumber() rebuilds the PRINTED form; feeding that to a lookup returns nothing.
    const resolver = extras.slice(extras.indexOf('TCG.pkmResolveNumber'), extras.indexOf('TCG.pkmLookupCard'));
    assert.ok(!/formatCardNumber/.test(resolver), 'the resolver must return the RAW upstream number');
  });
});
