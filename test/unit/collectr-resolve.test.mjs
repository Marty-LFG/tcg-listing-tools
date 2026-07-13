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
  ];
  const MUST_FAIL = [
    ['Mew', 'Mewtwo'],           // the reported bug — 'mewtwo'.includes('mew')
    ['Mewtwo', 'Mew'],           // symmetric
    ['Rai', 'Raichu'],
    ['Raichu', 'Rai'],
    ['Pichu', 'Pikachu'],
    ['Nidoking', 'N'],           // old code false-positived via 'nidoking'.includes('n')
    ['Full Art Pikachu', 'Full Art Raichu'],  // shared modifier tokens must NOT overlap two diff cards
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
