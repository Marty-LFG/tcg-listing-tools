// test/unit/sealed.test.mjs — pure helpers of the sealed-product tool (lib/sealed.mjs).
// Barcode normalisation, sealed price-rung selection (never fabricated), game inference from a
// PriceCharting console name, and title -> product_type classification. Offline / no DB.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpc, upcCandidates, valueForSealed, gameFromConsole, inferProductType, PRODUCT_TYPES } from '../../lib/sealed.mjs';

describe('normalizeUpc / upcCandidates', () => {
  it('strips separators, keeps digits', () => {
    assert.equal(normalizeUpc('  8201-3648-8510 '), '820136488510');
    assert.equal(normalizeUpc('abc'), '');
    assert.equal(normalizeUpc(null), '');
  });
  it('UPC-A <-> 0-prefixed EAN-13 are treated as the same product', () => {
    assert.deepEqual(upcCandidates('820136488510'), ['820136488510', '0820136488510']);   // UPC-A -> EAN-13
    assert.deepEqual(upcCandidates('0820136488510'), ['0820136488510', '820136488510']);   // 0-EAN-13 -> UPC-A
  });
  it('empty in -> empty out', () => {
    assert.deepEqual(upcCandidates(''), []);
  });
});

describe('valueForSealed', () => {
  const prices = { sealed: 39900, loose: 35000, cib: 36000 };
  it('sealed uses the New rung only', () => {
    assert.deepEqual(valueForSealed(prices, 'sealed'), { cents: 39900, label: 'New' });
  });
  it('opened uses Loose then CIB — never the sealed price as a proxy', () => {
    assert.deepEqual(valueForSealed(prices, 'opened'), { cents: 35000, label: 'Loose' });
    assert.deepEqual(valueForSealed({ cib: 36000 }, 'opened'), { cents: 36000, label: 'CIB' });
  });
  it('no matching rung -> null, never fabricated (GR4)', () => {
    assert.equal(valueForSealed({ loose: 35000 }, 'sealed'), null);   // sealed wants New, only Loose present
    assert.equal(valueForSealed({}, 'sealed'), null);
    assert.equal(valueForSealed(null, 'sealed'), null);
  });
});

describe('gameFromConsole', () => {
  it('maps game-named consoles to our keys', () => {
    assert.equal(gameFromConsole('Pokemon Scarlet & Violet 151'), 'pokemon');
    assert.equal(gameFromConsole('Magic Sealed Product'), 'mtg');
    assert.equal(gameFromConsole('MTG Foundations'), 'mtg');
    assert.equal(gameFromConsole('Riftbound Origins'), 'riftbound');
  });
  it('unknown -> null (caller falls back to the session game)', () => {
    assert.equal(gameFromConsole('Yu-Gi-Oh Sealed'), null);
    assert.equal(gameFromConsole(''), null);
  });
});

describe('inferProductType', () => {
  it('classifies each major sealed product from its title', () => {
    assert.equal(inferProductType('Scarlet & Violet 151 Booster Box', 'pokemon'), 'booster_box');
    assert.equal(inferProductType('Surging Sparks Elite Trainer Box', 'pokemon'), 'elite_trainer_box');
    assert.equal(inferProductType('Prismatic Evolutions Booster Bundle', 'pokemon'), 'booster_bundle');
    assert.equal(inferProductType('Charizard ex Premium Collection', 'pokemon'), 'premium_collection');
    assert.equal(inferProductType('Paldea Evolved Sleeved Booster Blister', 'pokemon'), 'blister');
    assert.equal(inferProductType('Pokemon Center Tin', 'pokemon'), 'tin');
    assert.equal(inferProductType('Foundations Collector Booster Box', 'mtg'), 'booster_box');
    assert.equal(inferProductType('Bloomburrow Commander Deck', 'mtg'), 'commander_deck');
    assert.equal(inferProductType('Murders at Karlov Manor Prerelease Pack', 'mtg'), 'prerelease_pack');
    assert.equal(inferProductType('Foundations Bundle', 'mtg'), 'booster_bundle');
    assert.equal(inferProductType('Riftbound Origins Booster Case', 'riftbound'), 'booster_case');
    assert.equal(inferProductType('Riftbound Two-Player Starter Set', 'riftbound'), 'starter_deck');
  });
  it('ETB / case / bundle win over the generic "box"/"pack" fallbacks', () => {
    assert.equal(inferProductType('Twilight Masquerade Elite Trainer Box', 'pokemon'), 'elite_trainer_box');
    assert.equal(inferProductType('151 Booster Box Case', 'pokemon'), 'booster_case');
  });
  it('unknown -> other, and every result is a valid enum value', () => {
    assert.equal(inferProductType('Mystery Grab Bag', 'pokemon'), 'other');
    for (const t of ['Booster Box', 'Booster Pack', 'Tin', 'Bundle']) {
      assert.ok(PRODUCT_TYPES.includes(inferProductType(t, 'pokemon')));
    }
  });
});
