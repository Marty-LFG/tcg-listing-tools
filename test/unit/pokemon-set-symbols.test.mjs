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
import { findSetSymbol, findSetLogo, baseSetCode, INDEX_FORMAT, normSetKey } from '../../lib/pkm-sets-cache.mjs';

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

describe('the two normalisers must stay identical', () => {
  // The index is WRITTEN with normName (the build script) and READ with normSetKey (the lib). Any
  // divergence is a lookup that silently finds nothing — which is exactly how the accented
  // `Pokémon Card 151` went missing after only one side learned to fold.
  it('agree on every shape the sources actually produce', () => {
    for (const s of ['Abyss Eye', 'Pokémon Card 151', 'Pokemon Card 151', 'アビスアイ', 'メガブレイブ',
      'Sword & Shield', "Trainer's Toolkit", 'SV3a', 'M5', '  spaced  out  ', '', null, 'Neo Genesis']) {
      assert.equal(normName(s), normSetKey(s), `diverged on ${JSON.stringify(s)}`);
    }
  });
  it('folds Latin accents so the sources agree', () => {
    assert.equal(normSetKey('Pokémon Card 151'), normSetKey('Pokemon Card 151'));
  });
  it('does NOT fold Japanese dakuten — that would merge distinct sets', () => {
    // ガ decomposes to カ + U+3099. Stripping it would make メガブレイブ match メカフレイフ.
    assert.notEqual(normSetKey('メガブレイブ'), normSetKey('メカフレイフ'));
    assert.ok(normSetKey('メガブレイブ').length > 0);
  });
});

describe('normName', () => {
  it('matches on letters alone, so punctuation and spacing cannot split a set', () => {
    assert.equal(normName('Abyss Eye'), normName('abyss-eye'));
    assert.equal(normName('Abyss Eye'), normName('  ABYSS   EYE  '));
    assert.equal(normName('Pokémon Card 151'), 'pokemoncard151');
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
  const allSymbols = () => Object.values(baked.symbols).flatMap((m) => Object.values(m));
  const allLogos = () => Object.values(baked.logos).flatMap((m) => Object.values(m));

  it('is the language-scoped format', () => {
    assert.equal(baked.format, INDEX_FORMAT, 'a flat v1 index lets one language shadow another');
    assert.ok(baked.symbols.ja && baked.symbols.en, 'symbols must be bucketed per language');
    assert.ok(baked.logos.ja && baked.logos.en, 'logos must be bucketed per language');
  });
  it('has a sane shape and a real count', () => {
    assert.ok(baked.builtAt);
    assert.ok(baked.count > 100, `only ${baked.count} symbols indexed`);
  });
  it('every entry carries a usable https URL', () => {
    for (const v of [...allSymbols(), ...allLogos()]) {
      assert.match(v.url, /^https:\/\//, `${v.name} has no https url`);
      assert.ok(v.name, 'entry has no display name');
    }
  });
  it('covers Japanese sets — the whole reason this bake exists', () => {
    assert.ok(Object.keys(baked.symbols.ja).length > 100, 'the JP page did not parse');
  });
  it('resolves Abyss Eye, the JP counterpart of Pitch Black', () => {
    const s = findSetSymbol('JP', 'Abyss Eye');
    assert.ok(s, 'Abyss Eye missing from the index');
    assert.match(s.url, /SetSymbolAbyss_Eye/);
  });
  it('lookup is punctuation- and case-insensitive', () => {
    assert.ok(findSetSymbol('JP', 'abyss eye'));
    assert.ok(findSetSymbol('JP', 'ABYSS-EYE'));
  });
  it('an unknown set returns null rather than a wrong symbol', () => {
    assert.equal(findSetSymbol('JP', 'No Such Set Anywhere'), null);
    assert.equal(findSetSymbol('JP', ''), null);
    assert.equal(findSetSymbol('JP', null), null);
  });

  it('indexes logos, including the whole MEGA series by set code', () => {
    // M1–M6 are all `M<n>_Logo_JP.png`. They were missing entirely until the language suffix was
    // handled, so this pins the era the compositor is being used on.
    for (const code of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']) {
      const hit = findSetLogo('JP', code);
      assert.ok(hit, `no logo indexed for ${code}`);
      assert.match(hit.url, new RegExp(`${code}_Logo_JP\\.png$`));
    }
  });
  it('finds a logo by set name as well as by code', () => {
    const byName = findSetLogo('JP', 'Raging Surf');
    if (byName) assert.match(byName.url, /Raging_Surf_Logo/);
  });
  it('takes several candidates and returns the first that hits', () => {
    assert.ok(findSetLogo('JP', 'nope-not-a-set', 'M5'), 'should fall through to the second candidate');
    assert.equal(findSetLogo('JP', 'nope', 'also-nope'), null);
    assert.equal(findSetLogo('JP'), null);
  });
  it('indexes enough English logos to be worth having', () => {
    assert.ok(Object.keys(baked.logos.en).length > 50, 'the language suffix filter has regressed');
  });

  describe('languages never cross', () => {
    // The bug this format fixes: the JP page claimed `bw1`/`xy4`/`sm7` and shadowed the English file
    // of the same code, so an English card could be handed a JAPANESE logo.
    for (const code of ['BW1', 'XY4', 'SM7']) {
      it(`${code} resolves to different art for EN and JP`, () => {
        const en = findSetLogo('EN', code);
        const ja = findSetLogo('JP', code);
        assert.ok(en, `${code} has no EN logo`);
        assert.ok(ja, `${code} has no JP logo`);
        assert.notEqual(en.url, ja.url, `${code} served the same file to both languages`);
        assert.match(en.url, /_Logo_EN\.png$/);
      });
    }
    it('a JP-only set does not leak into an English lookup', () => {
      assert.ok(findSetSymbol('JP', 'Abyss Eye'), 'sanity: it exists in JP');
      assert.equal(findSetSymbol('EN', 'Abyss Eye'), null, 'a JP set must not resolve for an English card');
    });
  });

  describe('paired-set base-code fallback', () => {
    // JP sets often ship in pairs sharing ONE logo on the wiki: Ancient Roar/Future Flash are
    // SV4K/SV4M against a single SV4_Logo_JP.png.
    for (const [code, base] of [['M1L', 'M1'], ['M1S', 'M1'], ['SV11B', 'SV11'], ['SV11W', 'SV11'],
      ['SV5M', 'SV5'], ['SV5K', 'SV5'], ['SV4K', 'SV4'], ['SV4M', 'SV4'], ['SV2D', 'SV2'], ['SV2P', 'SV2']]) {
      it(`${code} falls back to ${base}`, () => {
        const hit = findSetLogo('JP', code);
        assert.ok(hit, `${code} resolved no logo`);
        assert.match(hit.url, new RegExp(`${base}_Logo`, 'i'));
      });
    }
    it('an EXACT match always beats the base code', () => {
      // SV3a has its own file, so stripping to SV3 must not win.
      assert.match(findSetLogo('JP', 'SV3a').url, /SV3a_Raging_Surf_Logo/);
    });
  });

  describe('romanisation aliases', () => {
    for (const [ours, wiki] of [['Glory of Team Rocket', 'Glory_of_the_Rocket_Gang'], ['Terastal Festival ex', 'Terastal_Fest_ex'],
      ['Heat Wave Arena', 'Hot_Wind_Arena'], ['Mask of Change', 'Transformation_Mask']]) {
      it(`${ours} resolves to the wiki's ${wiki}`, () => {
        const hit = findSetSymbol('JP', ours);
        assert.ok(hit, `${ours} resolved no symbol`);
        assert.match(hit.url, new RegExp(wiki, 'i'));
      });
    }
    it('the accented JP file resolves from our unaccented name', () => {
      // The wiki writes SetSymbolPokémon_Card_151.png; TCGdex gives us "Pokemon Card 151". Each
      // language resolves to ITS OWN file — the JP set symbol is not the English one.
      const jp = findSetSymbol('JP', 'Pokemon Card 151');
      const en = findSetSymbol('EN', '151');
      assert.ok(jp, 'JP 151 resolved no symbol');
      assert.ok(en, 'EN 151 resolved no symbol');
      assert.notEqual(jp.url, en.url);
    });
    it('an alias never rescues a set that genuinely does not exist', () => {
      assert.equal(findSetSymbol('JP', 'Completely Made Up Set'), null);
      assert.equal(findSetLogo('JP', 'ZZ99Q'), null);
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
