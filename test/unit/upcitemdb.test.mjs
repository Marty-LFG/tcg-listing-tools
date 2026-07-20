// test/unit/upcitemdb.test.mjs — the keyless barcode->name bridge title cleaner (lib/upcitemdb.mjs).
// Pure/offline: no network. The live lookup is exercised by the integration + manual live smoke.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSealedTitle, demojibake } from '../../lib/upcitemdb.mjs';

describe('demojibake', () => {
  it('repairs UTF-8-as-Latin-1 mojibake from UPCItemDB titles', () => {
    assert.equal(demojibake('PokÃ©mon Mega Evolution Booster Pack'), 'Pokémon Mega Evolution Booster Pack');
    assert.equal(demojibake('CafÃ© au lait'), 'Café au lait');
  });
  it('leaves already-correct + plain-ASCII strings untouched', () => {
    assert.equal(demojibake('Pokémon 151 Booster Box'), 'Pokémon 151 Booster Box');
    assert.equal(demojibake('Pokemon Astral Radiance'), 'Pokemon Astral Radiance');
    assert.equal(demojibake(''), '');
    assert.equal(demojibake(null), '');
  });
});

describe('cleanSealedTitle', () => {
  it('strips the "Trading Card Game" brand boilerplate + separators for a searchable name', () => {
    assert.equal(
      cleanSealedTitle('Pokemon Trading Card Game: Scarlet & Violet - Surging Sparks Elite Trainer Box'),
      'Scarlet & Violet Surging Sparks Elite Trainer Box',
    );
    assert.equal(cleanSealedTitle('Pokémon TCG: Surging Sparks Booster Bundle'), 'Surging Sparks Booster Bundle');
    assert.equal(cleanSealedTitle('Magic: The Gathering Foundations Bundle'), 'Foundations Bundle');
  });
  it('drops trademark glyphs and collapses whitespace', () => {
    assert.equal(cleanSealedTitle('  Pokémon™  151   Booster   Box®  '), 'Pokémon 151 Booster Box');
  });
  it('null/empty -> empty string', () => {
    assert.equal(cleanSealedTitle(null), '');
    assert.equal(cleanSealedTitle(''), '');
  });
});
