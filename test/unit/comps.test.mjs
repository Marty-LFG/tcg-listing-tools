// test/unit/comps.test.mjs — server-side sealed eBay comps helpers (lib/comps.mjs).
// Pure/offline: the sealed-product title filter (keep the right product type, drop the noise a human
// would filter out) + the delivered-price cluster value. The live eBay fetch is exercised manually.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSealedType, clusterValue } from '../../lib/comps.mjs';

describe('matchesSealedType (sealed eBay noise filter)', () => {
  // Exact titles from a real "Mega Evolution Enhanced Booster Box" eBay search.
  it('keeps the real booster box, drops single packs / empties / wrong bundles', () => {
    const keep = [
      'Pokémon TCG: Mega Evolutions Enhanced Booster Box Sealed Base Set',
      'SEALED Pokémon TCG Mega Evolution Base Set Enhanced Booster Box FREE SHIP',
    ];
    const drop = [
      'Pokémon TCG: Mega Evolution – Single Booster Pack',
      'Pokémon 3x **EMPTY** Mega Evolution Base Set Enhanced Booster Boxes',
      'Pokemon TCG: Mega Evolution Booster Pack (Mega Kangaskhan)',
      '2X Pokemon TCG: Ascended Heroes Factory Sealed Booster Bundle Box',
      'Pokemon Ascended Heroes Booster Bundle Sealed',
    ];
    for (const t of keep) assert.equal(matchesSealedType(t, 'booster_box'), true, 'keep: ' + t);
    for (const t of drop) assert.equal(matchesSealedType(t, 'booster_box'), false, 'drop: ' + t);
  });
  it('type-aware: an ETB query keeps ETBs and drops booster boxes/packs (and vice versa)', () => {
    assert.equal(matchesSealedType('Surging Sparks Elite Trainer Box Sealed', 'elite_trainer_box'), true);
    assert.equal(matchesSealedType('Surging Sparks Booster Box', 'elite_trainer_box'), false);
    assert.equal(matchesSealedType('Surging Sparks Elite Trainer Box', 'booster_box'), false);
  });
  it('always drops opened/proxy/graded regardless of type', () => {
    assert.equal(matchesSealedType('151 Booster Box OPENED no cards', 'booster_box'), false);
    assert.equal(matchesSealedType('151 Booster Box PSA graded', 'booster_box'), false);
    assert.equal(matchesSealedType('', 'booster_box'), false);
  });
});

describe('clusterValue (densest-cluster median, not the cheapest)', () => {
  it('ignores a lowball outlier — values the real cluster', () => {
    const prices = [9.99, 455, 460, 465, 470, 472, 480, 485, 490, 500];
    const c = clusterValue(prices);
    assert.ok(c.fair >= 455 && c.fair <= 490, 'fair is in the cluster, not the $10 outlier: ' + c.fair);
    assert.ok(c.cheapestInCluster >= 455, 'cheapest-in-cluster excludes the outlier');
  });
  it('handles tiny samples + empty', () => {
    assert.equal(clusterValue([]), null);
    assert.equal(clusterValue([472.29, 480]).fair, 476.145);
  });
});
