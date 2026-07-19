// test/unit/sealed.test.mjs — pure helpers of the sealed-product tool (lib/sealed.mjs).
// Barcode normalisation, sealed price-rung selection (never fabricated), game inference from a
// PriceCharting console name, and title -> product_type classification. Offline / no DB.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpc, upcCandidates, valueForSealed, gameFromConsole, inferProductType, PRODUCT_TYPES, sanitizePlacements, pickSealedHit, fuzzyContainment, catalogScore } from '../../lib/sealed.mjs';

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
  it('maps the newer sealed games too (swu / lorcana)', () => {
    assert.equal(gameFromConsole('Star Wars Unlimited Spark of Rebellion'), 'swu');
    assert.equal(gameFromConsole('Disney Lorcana The First Chapter'), 'lorcana');
  });
  it('unknown -> null (caller falls back to the session game)', () => {
    assert.equal(gameFromConsole('Yu-Gi-Oh Sealed'), null);
    assert.equal(gameFromConsole(''), null);
  });
});

describe('sanitizePlacements', () => {
  it('trims locations, rounds quantities, drops non-positive rows', () => {
    assert.deepEqual(
      sanitizePlacements([{ location: '  Shelf B ', quantity: '3' }, { location: 'Bin 2', quantity: 0 }, { location: 'Bin 3', quantity: -1 }]),
      [{ location: 'Shelf B', quantity: 3 }],
    );
  });
  it('merges rows that share a location (case-insensitive), first-seen casing wins', () => {
    assert.deepEqual(
      sanitizePlacements([{ location: 'Storage 1', quantity: 2 }, { location: 'storage 1', quantity: 3 }]),
      [{ location: 'Storage 1', quantity: 5 }],
    );
  });
  it('empty / blank location becomes a single "unassigned" (null) bucket', () => {
    assert.deepEqual(
      sanitizePlacements([{ location: '', quantity: 1 }, { location: '   ', quantity: 2 }, { quantity: 1 }]),
      [{ location: null, quantity: 4 }],
    );
  });
  it('keeps distinct locations in first-seen order and sums the total correctly', () => {
    const out = sanitizePlacements([{ location: 'A', quantity: 1 }, { location: 'B', quantity: 2 }, { location: 'A', quantity: 4 }]);
    assert.deepEqual(out, [{ location: 'A', quantity: 5 }, { location: 'B', quantity: 2 }]);
    assert.equal(out.reduce((s, p) => s + p.quantity, 0), 7);
  });
  it('nothing usable -> [] (caller supplies a fallback row)', () => {
    assert.deepEqual(sanitizePlacements([]), []);
    assert.deepEqual(sanitizePlacements(null), []);
    assert.deepEqual(sanitizePlacements([{ location: 'X', quantity: 'abc' }]), []);
  });
});

describe('fuzzy catalog search scoring', () => {
  const row = { name: 'Scarlet & Violet Surging Sparks Elite Trainer Box', set_name: 'Pokemon Surging Sparks', upc: '820650859526' };
  it('fuzzyContainment: identical=1, disjoint=0, empty=0', () => {
    assert.equal(fuzzyContainment('surging sparks', 'surging sparks'), 1);
    assert.equal(fuzzyContainment('pikachu', 'booster box'), 0);
    assert.equal(fuzzyContainment('', 'anything'), 0);
  });
  it('name substring scores high; a typo still clears the search threshold', () => {
    assert.ok(catalogScore('surging sparks', row) >= 0.85, 'exact substring is a strong match');
    assert.ok(catalogScore('surdging sparks', row) >= 0.3, 'one-letter typo still matches (fuzzy)');
    assert.ok(catalogScore('surging sparks', row) > catalogScore('surdging sparks', row), 'exact beats typo');
  });
  it('a UPC query matches by exact / partial code, not by name', () => {
    assert.equal(catalogScore('820650859526', row), 1, 'exact UPC');
    assert.equal(catalogScore('859526', row), 0.95, 'trailing digits of the UPC');
    assert.equal(catalogScore('0820650859526', row), 0.95, 'EAN-13 (0-prefixed) form');
  });
  it('an unrelated query scores below the search threshold (0.3)', () => {
    assert.ok(catalogScore('charizard tin', row) < 0.3);
    assert.ok(catalogScore('999999999999', row) < 0.3);
  });
});

describe('pickSealedHit (barcode title -> the right PriceCharting sealed product)', () => {
  // Real-shaped hits for the Surging Sparks ETB name search (verified live).
  const hits = [
    { productName: 'Booster Box', consoleName: 'Pokemon Surging Sparks', url: 'u1' },
    { productName: 'Elite Trainer Box', consoleName: 'Pokemon Surging Sparks', url: 'u2' },
    { productName: 'Elite Trainer Box [Pokemon Center]', consoleName: 'Pokemon Surging Sparks', url: 'u3' },
    { productName: 'Elite Trainer Box', consoleName: 'Pokemon Phantom Forces', url: 'u4' },   // wrong set
  ];
  it('matches the set (console ⊆ title) + product-type phrase, preferring the plain variant', () => {
    const hit = pickSealedHit(hits, { title: 'Scarlet & Violet Surging Sparks Elite Trainer Box', productType: 'elite_trainer_box' });
    assert.equal(hit && hit.url, 'u2');                       // Surging Sparks ETB, not the wrong-set or PC variant
  });
  it('prefers the [Pokemon Center] variant only when the title asks for it', () => {
    const hit = pickSealedHit(hits, { title: 'Surging Sparks Elite Trainer Box Pokemon Center', productType: 'elite_trainer_box' });
    assert.equal(hit && hit.url, 'u3');
  });
  it('refuses to guess when the set does not resolve (wrong set → null, never a wrong price)', () => {
    assert.equal(pickSealedHit(hits, { title: 'Paldea Evolved Elite Trainer Box', productType: 'elite_trainer_box' }), null);
  });
  it('refuses an ambiguous tie (two identical candidates → null)', () => {
    const tie = [
      { productName: 'Tin', consoleName: 'Pokemon Surging Sparks', url: 'a' },
      { productName: 'Tin', consoleName: 'Pokemon Surging Sparks', url: 'b' },
    ];
    assert.equal(pickSealedHit(tie, { title: 'Surging Sparks Tin', productType: 'tin' }), null);
  });
  it('empty/absent hits -> null', () => {
    assert.equal(pickSealedHit([], { title: 'x', productType: 'tin' }), null);
    assert.equal(pickSealedHit(null, { title: 'x', productType: 'tin' }), null);
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
