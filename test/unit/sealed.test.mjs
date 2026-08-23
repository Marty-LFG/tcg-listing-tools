// test/unit/sealed.test.mjs — pure helpers of the sealed-product tool (lib/sealed.mjs).
// Barcode normalisation, sealed price-rung selection (never fabricated), game inference from a
// PriceCharting console name, and title -> product_type classification. Offline / no DB.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSealed, normalizeUpc, upcCandidates, valueForSealed, gameFromConsole, inferProductType, PRODUCT_TYPES, sanitizePlacements, pickSealedHit, fuzzyContainment, catalogScore, naturalCompare, ebayQueryFor, getSealedRefreshState} from '../../lib/sealed.mjs';

describe('naturalCompare (locations)', () => {
  it('sorts numeric suffixes 1,2,…10,11 — not 1,10,11,2', () => {
    const sorted = ['Storage Crate 10', 'Storage Crate 2', 'Storage Crate 1', 'Wardrobe 1 / Shelf 5', 'Storage Crate 11'].sort(naturalCompare);
    assert.deepEqual(sorted, ['Storage Crate 1', 'Storage Crate 2', 'Storage Crate 10', 'Storage Crate 11', 'Wardrobe 1 / Shelf 5']);
  });
  it('is case-insensitive', () => {
    assert.equal(naturalCompare('shelf a', 'Shelf A'), 0);
    assert.ok(naturalCompare('Bin 3', 'bin 20') < 0);
  });
});

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

describe('summarizeSealed — cost is PER UNIT, like value', () => {
  // The bug this pins: cost was summed unscaled while value was multiplied by quantity, so a row of
  // 14 booster boxes bought at A$300 each contributed A$300 of cost against A$4,608 of value and
  // reported A$4,308 of profit that did not exist.
  const upcMap = new Map([['196214154186', { value_cents: 32915, currency: 'AUD' }]]);
  const boxes = { status: 'in_stock', game: 'pokemon', product_type: 'booster_box', quantity: 14,
    cost_cents: 30000, acq_fees_cents: 0, upc: '196214154186', value_manual: 0, row_value: null, row_cur: null };

  it('scales cost by quantity', () => {
    const s = summarizeSealed([boxes], upcMap);
    assert.equal(s.totalCostCents, 30000 * 14, '14 boxes at A$300 each cost A$4,200');
    assert.equal(s.valueByCurrency.AUD, 32915 * 14);
    assert.equal(s.units, 14);
    const profit = s.valueByCurrency.AUD - s.totalCostCents;
    assert.equal(profit, 40810, 'A$408.10, not the A$4,308 the old maths reported');
  });

  it('counts acquisition fees per unit too', () => {
    assert.equal(summarizeSealed([{ ...boxes, acq_fees_cents: 500 }], upcMap).totalCostCents, (30000 + 500) * 14);
  });

  it('a single-unit row is unchanged by the fix', () => {
    const s = summarizeSealed([{ ...boxes, quantity: 1 }], upcMap);
    assert.equal(s.totalCostCents, 30000);
    assert.equal(s.valueByCurrency.AUD, 32915);
  });

  it('realized P/L on a sold row also scales cost by quantity', () => {
    // Sold 3 boxes bought at A$300 each for A$1,200 with A$100 of fees: 1200 - 100 - 900 = A$200.
    const s = summarizeSealed([{ ...boxes, status: 'sold', quantity: 3, sale_price_cents: 120000, sale_fees_cents: 10000 }], upcMap);
    assert.equal(s.realizedPlCents, 120000 - 10000 - 30000 * 3);
    assert.equal(s.units, 0, 'sold stock is not held stock');
  });

  it('a sold row with no quantity recorded is treated as one unit, not zero', () => {
    const s = summarizeSealed([{ ...boxes, status: 'sold', quantity: null, sale_price_cents: 40000, sale_fees_cents: 0 }], upcMap);
    assert.equal(s.realizedPlCents, 40000 - 30000);
  });

  it('a manual value overrides the shared per-UPC price, still × quantity', () => {
    const s = summarizeSealed([{ ...boxes, value_manual: 1, row_value: 20000, row_cur: 'AUD' }], upcMap);
    assert.equal(s.valueByCurrency.AUD, 20000 * 14);
  });
});

describe('ebayQueryFor (language belongs in the query, not just the filter)', () => {
  it('appends the language word for non-English, and nothing for English', () => {
    assert.equal(ebayQueryFor({ name: 'Abyss Eye Booster Box', set_name: 'Abyss Eye', language: 'JP' }),
      'Abyss Eye Booster Box Japanese');
    assert.equal(ebayQueryFor({ name: 'Prismatic Evolutions Booster Box', set_name: 'Prismatic Evolutions', language: 'EN' }),
      'Prismatic Evolutions Booster Box');
    assert.equal(ebayQueryFor({ name: 'CSV10C Booster Box', set_name: '', language: 'CN' }),
      'CSV10C Booster Box Chinese');
    assert.equal(ebayQueryFor({ name: 'Terastal Festival Booster Box', set_name: '', language: 'KO' }),
      'Terastal Festival Booster Box Korean');
  });
  it('never says the language twice — the existing word dedupe covers it', () => {
    assert.equal(ebayQueryFor({ name: 'Japanese Abyss Eye Booster Box', set_name: '', language: 'JP' }),
      'Japanese Abyss Eye Booster Box');
  });
  it('an unknown or missing language degrades to the old behaviour (GR7)', () => {
    assert.equal(ebayQueryFor({ name: 'Surging Sparks Booster Box', set_name: 'Surging Sparks' }),
      'Surging Sparks Booster Box');
    assert.equal(ebayQueryFor({ name: 'Surging Sparks Booster Box', set_name: '', language: 'DE' }),
      'Surging Sparks Booster Box');
  });
  it('still de-duplicates set words already carried by the name', () => {
    assert.equal(ebayQueryFor({ name: 'Surging Sparks Booster Box', set_name: 'Surging Sparks', language: 'EN' }),
      'Surging Sparks Booster Box');
  });
});

describe('getSealedRefreshState — `running` answers the same question as every other loop', () => {
  it('reports the TIMER being armed, not a pass being mid-flight', () => {
    // The console renders this field as the state pill. It used to return _svRunning, true only for
    // the few seconds a nightly pass executes, so a healthy loop showed STOPPED ~all day and sent
    // the owner looking for a fault on a freshly deployed server. Siblings (getReconcileState,
    // getRefreshState) all mean "armed"; this now matches them and reports in-flight separately.
    const st = getSealedRefreshState();
    assert.equal(typeof st.running, 'boolean');
    assert.ok('in_progress' in st, 'the in-flight fact is still reported, under its own name');
    // never started in this process -> no timer -> not running, and definitely not mid-pass
    assert.equal(st.running, false);
    assert.equal(st.in_progress, false);
  });
});
