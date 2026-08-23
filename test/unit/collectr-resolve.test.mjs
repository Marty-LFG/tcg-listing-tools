// test/unit/collectr-resolve.test.mjs — pure guards in lib/collectr-resolve.mjs. Offline.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { namesOverlap, decideGradedValue } from '../../lib/collectr-resolve.mjs';

describe('namesOverlap (word-boundary token guard — no substring false-positives)', () => {
  const MUST_PASS = [
    ['Metagross (Delta Species)', 'Metagross δ'],
    ['N (Supporter) (Full Art)', 'N'],
    ['Charizard ex', 'Charizard'],
    ['Dark Charizard', 'Charizard'],
    ['Surfing Pikachu', 'Pikachu'],
    ['', 'anything'],            // empty short-circuit
    ['Nidoran ♀', 'Nidoran ♂'],  // symbols stripped → both {nidoran}
    ['Pikachu', 'Pikachu'],
    ['  pikachu ', 'PIKACHU'],    // case / whitespace
    // THE HYPHENATED MECHANIC SUFFIX. pokemontcg.io writes 'Charizard-EX'; Collectr, TCGplayer and
    // every eBay seller write 'Charizard EX'. Until the suffix became a token boundary, EVERY BW4/XY
    // -EX and SM -GX card in a Collectr import failed this guard AFTER resolving the right set and
    // fetching the right card, and imported with no identity, no image and no live price.
    ['Gardevoir-EX', 'Gardevoir EX (Full Art)'],   // Steam Siege #111 — seen live
    ['Dragonite-EX', 'Dragonite EX'],              // Evolutions #72 — seen live
    ['Charizard-EX', 'Charizard EX'],
    ['M Charizard-EX', 'M Charizard EX'],          // the Mega prefix is already space-separated
    ['Shaymin-EX', 'Shaymin EX'],                  // BW4 hyphenates too, not just XY
    ['Kommo-o-GX', 'Kommo-o GX'],                  // splits at the LAST hyphen only
    // A base name overlapping its own mechanic card is the SAME tolerance 'Charizard ex' ⇄
    // 'Charizard' has had all along, and it is deliberate: by the time this guard runs, the set and
    // the collector NUMBER have already pinned one specific card (identityFor(game, set.id,
    // lookup_num)). Telling Kommo-o from Kommo-o-GX is the number's job, not this function's — all
    // this asks is "is that plausibly the same Pokémon, or did a fuzzy set match land somewhere else
    // entirely". Blocking these would make the hyphenated spelling stricter than the spaced one.
    ['Charizard-EX', 'Charizard'],
    ['Kommo-o', 'Kommo-o-GX'],
    ['Ho-Oh', 'Ho-Oh-GX'],
  ];
  const MUST_FAIL = [
    ['Mew', 'Mewtwo'],           // the reported bug — 'mewtwo'.includes('mew')
    ['Mewtwo', 'Mew'],           // symmetric
    ['Rai', 'Raichu'],
    ['Raichu', 'Rai'],
    ['Pichu', 'Pikachu'],
    ['Nidoking', 'N'],           // old code false-positived via 'nidoking'.includes('n')
    ['Full Art Pikachu', 'Full Art Raichu'],  // shared modifier tokens must NOT overlap two diff cards
    // WHY THE RULE IS "-EX/-GX ONLY" AND NOT "SPLIT ON EVERY HYPHEN". Splitting all hyphens is the
    // obvious fix, and it re-opens the exact false-positive this guard exists to stop — through
    // punctuation instead of through a substring. Porygon and Porygon-Z are DIFFERENT POKÉMON, not a
    // base and its mechanic card, so no collector number relates them and a fuzzy set match landing
    // on one while the row means the other must be blocked. Under a naive split it is not: {porygon}
    // ⊆ {porygon, z}. 'Z' is not a mechanic marker, so the suffix rule leaves Porygon-Z whole.
    ['Porygon', 'Porygon-Z'],
    ['Porygon-Z', 'Porygon'],       // symmetric
    ['Ho-Oh', 'Oh'],                // the hyphen inside a name is not a boundary
    ['Jangmo-o', 'Hakamo-o'],       // one-token each, and they are not the same card
    ['Kommo-o', 'Jangmo-o'],
  ];
  for (const [a, b] of MUST_PASS) it(`overlaps: "${a}" ⇄ "${b}"`, () => assert.equal(namesOverlap(a, b), true));
  for (const [a, b] of MUST_FAIL) it(`blocks: "${a}" ⇄ "${b}"`, () => assert.equal(namesOverlap(a, b), false));
});

describe('decideGradedValue (GR4 — only high-confidence seats an authoritative value)', () => {
  const rung = { cents: 12000, label: 'PSA 10' };
  it('high confidence → apply the value', () => {
    const d = decideGradedValue({ matched: true, ladder: {}, confidence: 'high', url: 'U' }, rung);
    assert.equal(d.apply, true);
    assert.equal(d.valueUsd, 120);
    assert.equal(d.label, 'PSA 10');
  });
  it('medium confidence → withhold, mark provisional, warn with the verify URL', () => {
    const d = decideGradedValue({ matched: true, ladder: {}, confidence: 'medium', url: 'https://pc/x', consoleName: 'Pokemon Base Set 2' }, rung);
    assert.equal(d.apply, false);
    assert.equal(d.provisional, true);
    assert.equal(d.valueUsd, 120);   // kept as a suggestion
    assert.match(d.warning, /medium-confidence/);
    assert.match(d.warning, /https:\/\/pc\/x/);
  });
  it('high but stale → withhold', () => {
    const d = decideGradedValue({ matched: true, ladder: {}, confidence: 'high', stale: true, url: 'U' }, rung);
    assert.equal(d.apply, false);
  });
  it('no rung / raw-anchor / no match → no value, descriptive warning', () => {
    assert.equal(decideGradedValue({ matched: true, ladder: {}, confidence: 'high' }, null).apply, false);
    assert.equal(decideGradedValue({ matched: true, ladder: {}, confidence: 'high' }, { cents: 0, label: 'x' }).apply, false);
    assert.match(decideGradedValue({ matched: true, ladder: {}, confidence: 'high' }, { cents: 5000, label: 'Ungraded (raw anchor)' }).warning, /no PriceCharting rung/);
    assert.match(decideGradedValue({ matched: false }, rung).warning, /no PriceCharting match/);
  });
});
