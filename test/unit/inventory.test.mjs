// test/unit/inventory.test.mjs — card-name normalisation for image search (lib/inventory.mjs).
// PSA bakes finish descriptors into the slab subject ("DARK CHARIZARD-HOLO"); the game APIs
// name the card plainly ("Dark Charizard"), so the search must strip finish affixes WITHOUT
// eating hyphenated Pokémon names. Pure string logic — no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCardName, psaSetToPtcgId, summarizeInventory } from '../../lib/inventory.mjs';

describe('cleanCardName', () => {
  it('strips a trailing PSA -HOLO suffix (the reported bug)', () => {
    assert.equal(cleanCardName('DARK CHARIZARD-HOLO'), 'DARK CHARIZARD');
    assert.equal(cleanCardName('BLASTOISE-HOLO'), 'BLASTOISE');
  });
  it('strips multi-word finish suffixes', () => {
    assert.equal(cleanCardName('CHARIZARD-REVERSE HOLO'), 'CHARIZARD');
    assert.equal(cleanCardName('Pikachu - Cosmos Holo'), 'Pikachu');
    assert.equal(cleanCardName('Zapdos-NON HOLO'), 'Zapdos');
  });
  it('strips a leading finish/rarity prefix', () => {
    assert.equal(cleanCardName('FA/Sylveon VMAX'), 'Sylveon VMAX');
    assert.equal(cleanCardName('SIR/Umbreon VMAX'), 'Umbreon VMAX');
  });
  it('does NOT eat hyphenated Pokémon names', () => {
    assert.equal(cleanCardName('PORYGON-Z'), 'PORYGON-Z');
    assert.equal(cleanCardName('HO-OH'), 'HO-OH');
    assert.equal(cleanCardName('Nidoran-M'), 'Nidoran-M');
    assert.equal(cleanCardName('Umbreon VMAX'), 'Umbreon VMAX');   // "VMAX" is not a finish token
  });
  it('is empty-safe', () => {
    assert.equal(cleanCardName(''), '');
    assert.equal(cleanCardName(null), '');
  });
});

describe('psaSetToPtcgId', () => {
  // Fixture map (not the baked file) so the test is stable + offline.
  const map = {
    byName: { 'BRILLIANT STARS': 'swsh9', 'TEAM ROCKET': 'base5', 'TEAM ROCKET RETURNS': 'ex7', 'JUNGLE': 'base2', 'BASE': 'base1' },
    aliases: { 'ROCKET': 'base5', 'GAME': 'base1' },
  };
  it('resolves PSA-specific aliases the substring pass would miss', () => {
    assert.equal(psaSetToPtcgId('POKEMON ROCKET', map), 'base5');   // "Rocket" != "Team Rocket"
    assert.equal(psaSetToPtcgId('POKEMON GAME', map), 'base1');     // PSA's name for Base Set
  });
  it('resolves by exact ptcg set name (POKEMON prefix stripped)', () => {
    assert.equal(psaSetToPtcgId('POKEMON JUNGLE', map), 'base2');
  });
  it('resolves modern sets by longest substring', () => {
    assert.equal(psaSetToPtcgId('POKEMON SWORD & SHIELD BRILLIANT STARS', map), 'swsh9');
  });
  it('prefers the longer, more specific name (Returns, not Team Rocket)', () => {
    assert.equal(psaSetToPtcgId('POKEMON TEAM ROCKET RETURNS', map), 'ex7');
  });
  it('returns null for an unknown / non-EN brand', () => {
    assert.equal(psaSetToPtcgId('POKEMON JAPANESE SV4M-FUTURE FLASH', map), null);
    assert.equal(psaSetToPtcgId('', map), null);
  });
});

describe('summarizeInventory (portfolio roll-up — quantity-aware, GR3)', () => {
  it('scales every money term by quantity for raw bulk lots', () => {
    // One graded slab (qty 1) + one raw bulk lot (qty 50). Money is PER UNIT, so the lot must
    // contribute 50×. Before the fix, /summary added each per-unit figure exactly once.
    const rows = [
      { status: 'in_stock', game: 'pokemon', grading_company: 'PSA', quantity: 1,
        cost_cents: 20000, acq_fees_cents: 1000, value_cents: 30000, value_currency: 'USD' },
      { status: 'in_stock', game: 'pokemon', grading_company: null, quantity: 50,
        cost_cents: 20, acq_fees_cents: 0, value_cents: 99, value_currency: 'AUD' },
    ];
    const s = summarizeInventory(rows);
    assert.equal(s.units, 51, 'units = SUM(quantity) of held stock (1 + 50)');
    assert.equal(s.totalCostCents, 20000 + 1000 + (20 * 50), 'cost scales by qty (slab 21000 + lot 1000)');
    assert.equal(s.valueByCurrency.USD, 30000, 'slab USD value unscaled (qty 1)');
    assert.equal(s.valueByCurrency.AUD, 99 * 50, 'bulk lot AUD value scaled ×50 = 4950c');
    assert.equal(s.counts.total, 2);
    assert.equal(s.counts.in_stock, 2);
    assert.equal(s.byCompany.PSA, 1);
  });
  it('realized P/L on a sold lot scales by quantity', () => {
    const rows = [{ status: 'sold', game: 'mtg', quantity: 10,
      sale_price_cents: 500, sale_fees_cents: 50, cost_cents: 100, acq_fees_cents: 10 }];
    const s = summarizeInventory(rows);
    // (500 - 50 - 100 - 10) × 10 = 3400c
    assert.equal(s.realizedPlCents, (500 - 50 - 100 - 10) * 10);
    assert.equal(s.units, 0, 'sold rows are not counted as held units');
    assert.equal(s.counts.sold, 1);
  });
  it('missing quantity defaults to 1 (no-op) and null value is skipped', () => {
    const rows = [
      { status: 'in_stock', game: 'swu', cost_cents: 500, acq_fees_cents: 0, value_cents: null },
      { status: 'listed', game: 'swu', quantity: 1, cost_cents: 300, acq_fees_cents: 0, value_cents: 700, value_currency: 'AUD' },
    ];
    const s = summarizeInventory(rows);
    assert.equal(s.units, 2, 'qty defaults to 1 for both held rows');
    assert.equal(s.totalCostCents, 800);
    assert.equal(s.valueByCurrency.AUD, 700);
    assert.equal(s.valueByCurrency.USD, undefined, 'null value_cents contributes nothing');
  });
});
