// test/unit/inventory.test.mjs — card-name normalisation for image search (lib/inventory.mjs).
// PSA bakes finish descriptors into the slab subject ("DARK CHARIZARD-HOLO"); the game APIs
// name the card plainly ("Dark Charizard"), so the search must strip finish affixes WITHOUT
// eating hyphenated Pokémon names. Pure string logic — no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCardName, psaSetToPtcgId } from '../../lib/inventory.mjs';

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
