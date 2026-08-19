// test/unit/taxonomy-aspects.test.mjs — shaping a get_item_aspects_for_category response.
//
// This file exists because a ReferenceError shipped in categoryAspects and the ENTIRE suite stayed
// green: the function needs a live eBay call, so nothing exercised it, and the bug only surfaced when
// it was called against the real account. Pulling the pure part out into shapeAspects makes the thing
// that actually has logic in it testable offline.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shapeAspects } from '../../lib/ebay-taxonomy.mjs';

// Trimmed from the real 261044 (CCG Sealed Boxes) response.
const JSON_261044 = {
  aspects: [
    { localizedAspectName: 'Game',
      aspectConstraint: { aspectRequired: true, aspectMode: 'FREE_TEXT', itemToAspectCardinality: 'SINGLE' },
      aspectValues: [{ localizedValue: '7th Sea CCG' }, { localizedValue: 'Bakugan TCG' },
        { localizedValue: 'Pokémon TCG' }, { localizedValue: 'Pokemon Rumble' }] },
    { localizedAspectName: 'Configuration',
      aspectConstraint: { aspectRequired: false, aspectMode: 'SELECTION_ONLY', itemToAspectCardinality: 'SINGLE' },
      aspectValues: [{ localizedValue: 'Box' }] },
    { localizedAspectName: 'Number of Cards',
      aspectConstraint: { aspectRequired: false, aspectMode: 'FREE_TEXT' }, aspectValues: [] },
  ],
};

describe('shapeAspects', () => {
  it('reports the mode, which decides whether a wrong value is fatal or merely invisible', () => {
    const a = shapeAspects(JSON_261044);
    assert.equal(a.find((x) => x.name === 'Game').mode, 'FREE_TEXT');
    assert.equal(a.find((x) => x.name === 'Configuration').mode, 'SELECTION_ONLY');
    assert.equal(a.find((x) => x.name === 'Game').required, true);
    assert.equal(a.find((x) => x.name === 'Configuration').required, false);
  });

  it('reports the FULL enum size even when the sample is truncated', () => {
    const many = { aspects: [{ localizedAspectName: 'Set', aspectConstraint: {},
      aspectValues: Array.from({ length: 400 }, (_, i) => ({ localizedValue: 'Set ' + i })) }] };
    const s = shapeAspects(many)[0];
    assert.equal(s.valueCount, 400, 'a truncated answer has to be visible as truncated');
    assert.equal(s.values.length, 25);
  });

  it('searches the whole list, not the sample — the question a sample cannot answer', () => {
    // 'Pokémon TCG' sorts past the 25-value sample in the real enum, which is exactly why this exists.
    const g = shapeAspects(JSON_261044, 'pok').find((x) => x.name === 'Game');
    assert.equal(g.matched, 2);
    assert.deepEqual(g.values, ['Pokémon TCG', 'Pokemon Rumble']);
  });

  it('matching is case-insensitive and finds nothing rather than throwing', () => {
    assert.equal(shapeAspects(JSON_261044, 'POKÉ').find((x) => x.name === 'Game').matched, 1);
    assert.equal(shapeAspects(JSON_261044, 'zzz').find((x) => x.name === 'Game').matched, 0);
  });

  it('survives junk without throwing (GR7) — the failure mode that shipped', () => {
    assert.deepEqual(shapeAspects(null), []);
    assert.deepEqual(shapeAspects({}), []);
    assert.deepEqual(shapeAspects({ aspects: [] }, 'pok'), []);
    const bare = shapeAspects({ aspects: [{ localizedAspectName: 'X' }] })[0];
    assert.equal(bare.valueCount, 0);
    assert.deepEqual(bare.values, []);
  });
});
