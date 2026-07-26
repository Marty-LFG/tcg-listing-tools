// test/unit/sku-labels.test.mjs — the physical stock label series (eBay "Custom label").
// AAA-001 … AAA-099 → AAB-001 … , ninety-nine per block, and numbers are NEVER reused. See AGENTS.md
// §16b. The owner's shelf depends on these being right: a recycled label points at a card that is no
// longer in that slot.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { labelFor, seqForLabel, maxLabelSeq, peekNextLabel, blockLetters, lettersToBlock } from '../../lib/sku-labels.mjs';

describe('labelFor — the series', () => {
  it('starts at AAA-001 and rolls the block at 099, not 999', () => {
    assert.equal(labelFor(1), 'AAA-001');
    assert.equal(labelFor(99), 'AAA-099');
    assert.equal(labelFor(100), 'AAB-001', 'ninety-nine per block');
    assert.equal(labelFor(198), 'AAB-099');
    assert.equal(labelFor(199), 'AAC-001');
  });

  it('advances the letters like an odometer', () => {
    assert.equal(labelFor(26 * 99), 'AAZ-099');
    assert.equal(labelFor(26 * 99 + 1), 'ABA-001');
    assert.equal(blockLetters(0), 'AAA');
    assert.equal(blockLetters(26), 'ABA');
    assert.equal(blockLetters(17575), 'ZZZ');
  });

  it('places the owner\'s real label where they said it is', () => {
    assert.equal(labelFor(282), 'AAC-084');
    assert.equal(peekNextLabel(282), 'AAC-085', 'the next card off the shelf');
  });

  it('refuses rather than wrapping past the end of the series', () => {
    assert.equal(labelFor(17576 * 99), 'ZZZ-099');
    assert.equal(labelFor(17576 * 99 + 1), null);
    assert.equal(labelFor(0), null);
    assert.equal(labelFor(-5), null);
  });
});

describe('seqForLabel — the inverse, and what it refuses', () => {
  it('round-trips every label it issues', () => {
    for (const n of [1, 99, 100, 198, 282, 2574, 2575, 100000]) assert.equal(seqForLabel(labelFor(n)), n);
  });
  it('accepts lowercase and stray whitespace', () => {
    assert.equal(seqForLabel(' aac-084 '), 282);
  });
  it('rejects anything off-scheme so it can never move the counter', () => {
    assert.equal(seqForLabel('AAC-000'), null, '000 is not in the series');
    assert.equal(seqForLabel('AAC-100'), null, 'the block rolls at 099');
    assert.equal(seqForLabel('BK-PKM-000010'), null, 'our old format');
    assert.equal(seqForLabel('AAC-084-B'), null, 'a hand-annotated label');
    assert.equal(seqForLabel('AA-084'), null);
    assert.equal(seqForLabel(''), null);
    assert.equal(seqForLabel(null), null);
  });
  it('lettersToBlock rejects non-letters', () => {
    assert.equal(lettersToBlock('A1A'), null);
    assert.equal(lettersToBlock('AAAA'), null);
  });
});

describe('maxLabelSeq — seeding from a mixed bag', () => {
  it('finds the highest label and ignores everything else', () => {
    // What a read of the seller's live listings actually looks like: their labels, our old ones, junk.
    const skus = ['BK-PKM-000010', 'AAC-084', 'AAB-012', 'AAC-084-B', '', null, 'AAA-099'];
    assert.equal(maxLabelSeq(skus), 282);
    assert.equal(labelFor(maxLabelSeq(skus)), 'AAC-084');
  });
  it('is zero when nothing matches, which keeps the counter unseeded', () => {
    assert.equal(maxLabelSeq(['BK-PKM-000010', 'nonsense']), 0);
    assert.equal(maxLabelSeq([]), 0);
  });
  it('is not fooled by zero padding differences', () => {
    assert.equal(maxLabelSeq(['AAC-84', 'AAC-084']), 282, 'AAC-84 and AAC-084 are the same slot');
  });
});
