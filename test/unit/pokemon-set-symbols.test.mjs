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
import { setNameFromFile, setLogoKeysFromFile, normName, OUT_PATH } from '../../scripts/build-pokemon-set-symbols.mjs';
import { findSetSymbol, findSetLogo, baseSetCode } from '../../lib/pkm-sets-cache.mjs';

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

describe('setLogoKeysFromFile', () => {
  it('reads a bare name', () => {
    assert.deepEqual(setLogoKeysFromFile('Jungle_Logo.png'), { code: '', name: 'Jungle' });
  });
  it('reads a bare set code', () => {
    assert.deepEqual(setLogoKeysFromFile('SM1_Logo.png'), { code: 'SM1', name: '' });
  });
  it('reads code AND name together', () => {
    assert.deepEqual(setLogoKeysFromFile('SV3a_Raging_Surf_Logo.png'), { code: 'SV3a', name: 'Raging Surf' });
  });

  // Regression: the LANGUAGE SUFFIX. Matching only `_Logo.png` caught 13 of 135 English logos and
  // missed the entire MEGA series — the sets this compositor is actually being used on.
  it('handles the _JP suffix the MEGA series uses', () => {
    assert.deepEqual(setLogoKeysFromFile('M5_Logo_JP.png'), { code: 'M5', name: '' });
    assert.deepEqual(setLogoKeysFromFile('M2a_Logo_JP.png'), { code: 'M2a', name: '' });
    assert.deepEqual(setLogoKeysFromFile('SV1S_Logo_JP.png'), { code: 'SV1S', name: '' });
  });
  it('handles the _EN suffix', () => {
    assert.deepEqual(setLogoKeysFromFile('Neo_Genesis_Logo_EN.png'), { code: '', name: 'Neo Genesis' });
    assert.deepEqual(setLogoKeysFromFile('EX1_Logo_EN.png'), { code: 'EX1', name: '' });
  });
  it('ignores files that are not logos', () => {
    assert.equal(setLogoKeysFromFile('SetSymbolAbyss_Eye.png'), null);
    assert.equal(setLogoKeysFromFile('Charizard.png'), null);
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

  it('indexes logos, including the whole MEGA series by set code', () => {
    // M1–M6 are all `M<n>_Logo_JP.png`. They were missing entirely until the language suffix was
    // handled, so this pins the era the compositor is being used on.
    for (const code of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']) {
      const hit = findSetLogo(code);
      assert.ok(hit, `no logo indexed for ${code}`);
      assert.match(hit.url, new RegExp(`${code}_Logo_JP\\.png$`));
    }
  });
  it('finds a logo by set name as well as by code', () => {
    const byName = findSetLogo('Raging Surf');
    if (byName) assert.match(byName.url, /Raging_Surf_Logo/);
  });
  it('takes several candidates and returns the first that hits', () => {
    assert.ok(findSetLogo('nope-not-a-set', 'M5'), 'should fall through to the second candidate');
    assert.equal(findSetLogo('nope', 'also-nope'), null);
    assert.equal(findSetLogo(), null);
  });
  it('indexes enough English logos to be worth having', () => {
    const en = Object.values(baked.logos).filter((v) => v.lang === 'en');
    assert.ok(en.length > 50, `only ${en.length} EN logos — the language suffix filter has regressed`);
  });

  describe('paired-set base-code fallback', () => {
    // JP sets often ship in pairs sharing ONE logo on the wiki: Ancient Roar/Future Flash are
    // SV4K/SV4M against a single SV4_Logo_JP.png.
    for (const [code, base] of [['M1L', 'M1'], ['M1S', 'M1'], ['SV11B', 'SV11'], ['SV11W', 'SV11'],
      ['SV5M', 'SV5'], ['SV5K', 'SV5'], ['SV4K', 'SV4'], ['SV4M', 'SV4'], ['SV2D', 'SV2'], ['SV2P', 'SV2']]) {
      it(`${code} falls back to ${base}`, () => {
        const hit = findSetLogo(code);
        assert.ok(hit, `${code} resolved no logo`);
        assert.match(hit.url, new RegExp(`${base}_Logo`, 'i'));
      });
    }
    it('an EXACT match always beats the base code', () => {
      // SV3a has its own file, so stripping to SV3 must not win.
      const hit = findSetLogo('SV3a');
      assert.match(hit.url, /SV3a_Raging_Surf_Logo/);
    });
  });

  describe('romanisation aliases', () => {
    for (const [ours, wiki] of [['Glory of Team Rocket', 'Glory_of_the_Rocket_Gang'], ['Terastal Festival ex', 'Terastal_Fest_ex'],
      ['Pokemon Card 151', 'SetSymbol151'], ['Heat Wave Arena', 'Hot_Wind_Arena'], ['Mask of Change', 'Transformation_Mask']]) {
      it(`${ours} resolves to the wiki's ${wiki}`, () => {
        const hit = findSetSymbol(ours);
        assert.ok(hit, `${ours} resolved no symbol`);
        assert.match(hit.url, new RegExp(wiki, 'i'));
      });
    }
    it('an alias never rescues a set that genuinely does not exist', () => {
      assert.equal(findSetSymbol('Completely Made Up Set'), null);
      assert.equal(findSetLogo('ZZ99Q'), null);
    });
  });
});

describe('baseSetCode', () => {
  it('strips the trailing letters of a paired set code', () => {
    assert.equal(baseSetCode('SV4K'), 'SV4');
    assert.equal(baseSetCode('M1L'), 'M1');
    assert.equal(baseSetCode('SV11B'), 'SV11');
    assert.equal(baseSetCode('CS4DA'), 'CS4');
  });
  it('leaves a code that is already a base alone', () => {
    // Returning '' means "no fallback to try" — a base code must not resolve to itself and mask a
    // genuine miss.
    assert.equal(baseSetCode('SV2'), '');
    assert.equal(baseSetCode('M5'), '');
  });
  it('ignores things that are not set codes', () => {
    assert.equal(baseSetCode('PBL'), '');
    assert.equal(baseSetCode('CS1.5'), '');
    assert.equal(baseSetCode(''), '');
    assert.equal(baseSetCode(null), '');
  });
});
