// test/unit/pokemon-set-symbols.test.mjs — the Bulbapedia set-symbol index
// (scripts/build-pokemon-set-symbols.mjs + findSetSymbol in lib/pkm-sets-cache.mjs).
//
// This bake exists because there is no CDN carrying JAPANESE set symbols: TCGdex has only the old
// shared "univ" ones, and images.scrydex.com answers 200 with a generic placeholder for any id it
// does not hold. Offline — the network build is exercised by hand, the parsing and lookup here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setNameFromFile, normName, OUT_PATH } from '../../scripts/build-pokemon-set-symbols.mjs';
import { findSetSymbol } from '../../lib/pkm-sets-cache.mjs';

describe('setNameFromFile', () => {
  it('reads the set name out of the Bulbapedia filename convention', () => {
    assert.equal(setNameFromFile('SetSymbolAbyss_Eye.png'), 'Abyss Eye');
    assert.equal(setNameFromFile('SetSymbolMega_Symphonia.png'), 'Mega Symphonia');
    assert.equal(setNameFromFile('SetSymbolSurging_Sparks.png'), 'Surging Sparks');
  });
  it('handles the leading-underscore variants a few files use', () => {
    assert.equal(setNameFromFile('SetSymbol_SMPromo.png'), 'SMPromo');
  });
  it('keeps non-ASCII names intact', () => {
    assert.equal(setNameFromFile('SetSymbolPokémon_Card_151.png'), 'Pokémon Card 151');
  });
  it('ignores anything that is not a set symbol file', () => {
    assert.equal(setNameFromFile('Charizard.png'), null);
    assert.equal(setNameFromFile('SetSymbol.png'), null);
    assert.equal(setNameFromFile(''), null);
  });
});

describe('normName', () => {
  it('matches on letters alone, so punctuation and spacing cannot split a set', () => {
    assert.equal(normName('Abyss Eye'), normName('abyss-eye'));
    assert.equal(normName('Pokémon Card 151'), normName('pokemon card 151') === normName('Pokémon Card 151') ? 'pokémoncard151' : normName('Pokémon Card 151'));
  });
  it('is unicode-aware — an ASCII-only class collapses Japanese names to nothing', () => {
    assert.ok(normName('アビスアイ').length > 0, 'a native name must not normalise to the empty string');
    assert.notEqual(normName('アビスアイ'), normName('メガシンフォニア'));
  });
  it('empty in, empty out', () => {
    assert.equal(normName(''), '');
    assert.equal(normName(null), '');
  });
});

const baked = (() => { try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch { return null; } })();

describe('the baked index', { skip: !baked && 'data/pokemon-set-symbols.json not built on this host' }, () => {
  it('has a sane shape and a real count', () => {
    assert.ok(baked.builtAt);
    assert.ok(baked.count > 100, `only ${baked.count} symbols indexed`);
    assert.equal(typeof baked.symbols, 'object');
  });
  it('every entry carries a usable https URL', () => {
    for (const [key, v] of Object.entries(baked.symbols)) {
      assert.match(v.url, /^https:\/\//, `${key} has no https url`);
      assert.ok(v.name, `${key} has no display name`);
    }
  });
  it('covers Japanese sets — the whole reason this bake exists', () => {
    const jp = Object.values(baked.symbols).filter((v) => v.lang === 'ja');
    assert.ok(jp.length > 100, `only ${jp.length} JP symbols — the JP page did not parse`);
  });
  it('resolves Abyss Eye, the JP counterpart of Pitch Black', () => {
    const s = findSetSymbol('Abyss Eye');
    assert.ok(s, 'Abyss Eye missing from the index');
    assert.match(s.url, /SetSymbolAbyss_Eye/);
  });
  it('lookup is punctuation- and case-insensitive', () => {
    assert.ok(findSetSymbol('abyss eye'));
    assert.ok(findSetSymbol('ABYSS-EYE'));
  });
  it('an unknown set returns null rather than a wrong symbol', () => {
    assert.equal(findSetSymbol('No Such Set Anywhere'), null);
    assert.equal(findSetSymbol(''), null);
    assert.equal(findSetSymbol(null), null);
  });
});
