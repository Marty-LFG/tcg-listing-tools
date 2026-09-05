// test/unit/runs-language.test.mjs — the committed language vocabulary (lib/runs-language.mjs).
//
// THE DEFECT THIS PREVENTS is measured, not imagined. Three spellings of "Japanese" already exist in this
// codebase, and the specification's own Edition 1 claim uses a fourth reading of one of them:
//
//   lib/psa.mjs detectLanguage() returns 'JP' — so every slab resolved from a cert is recorded as JP
//   lib/catalog.mjs LANGS uses 'ja'
//   docs/RUNS_PLAN.md §11.2 writes the claim as `language bundle eq JA`
//
// §11.2 evaluates a language claim by LITERAL comparison. So Edition 1's claim would have failed on every
// bundle — and on a pool built through the intake page it would have failed inconsistently, because a
// cert that resolved gave JP while one typed by hand gave JA. Same run, two spellings, one claim.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGE_TABLE_VERSION, LANGUAGE_SOURCES, LANGUAGE_DISPLAY,
  canonicalLanguage, languageDisplay, languageTable,
} from '../../lib/runs-language.mjs';
import { detectLanguage } from '../../lib/psa.mjs';

describe('the three spellings that are actually in this repo', () => {
  it('what the PSA cert lookup writes folds to the code the claim uses', () => {
    // Pinned against the REAL function rather than the string 'JP', so this fails loudly if that
    // function ever changes what it returns — which would otherwise silently break every language claim.
    const fromCert = detectLanguage('2024 Pokemon Japanese Mega Brave Charizard');
    assert.equal(fromCert, 'JP');
    assert.equal(canonicalLanguage(fromCert), 'JA');
  });

  it('the catalogue spelling and the claim spelling fold to the same code', () => {
    assert.equal(canonicalLanguage('ja'), 'JA');
    assert.equal(canonicalLanguage('JA'), 'JA');
    assert.equal(canonicalLanguage('Japanese'), 'JA');
    assert.equal(new Set(['JP', 'ja', 'JA', 'Japanese'].map(canonicalLanguage)).size, 1);
  });

  it('and the catalogue Chinese codes keep Simplified and Traditional apart', () => {
    assert.equal(canonicalLanguage('zh-cn'), 'ZH_HANS');
    assert.equal(canonicalLanguage('zh-tw'), 'ZH_HANT');
    assert.notEqual(canonicalLanguage('zh-cn'), canonicalLanguage('zh-tw'));
  });
});

describe('unmapped fails closed', () => {
  it('a bare zh is REFUSED rather than guessed', () => {
    // Simplified and Traditional are different printings with different markets and prices. Guessing
    // would put the wrong word in a sentence that gets anchored.
    assert.equal(canonicalLanguage('zh'), null);
    assert.equal(canonicalLanguage('chinese'), null);
  });

  it('so is anything else', () => {
    for (const s of ['', '  ', null, undefined, 'Klingon', 'JAP', 'j', 'en-GB']) {
      assert.equal(canonicalLanguage(s), null, JSON.stringify(s));
    }
  });

  it('and a code with no display word cannot be rendered', () => {
    assert.equal(languageDisplay('KLINGON'), null);
    assert.equal(languageDisplay(null), null);
    assert.equal(languageDisplay('toString'), null, 'not fooled by a prototype key');
  });
});

describe('folding', () => {
  it('is case-insensitive over ASCII', () => {
    for (const s of ['JAPANESE', 'japanese', 'JaPaNeSe', '  Japanese\t']) {
      assert.equal(canonicalLanguage(s), 'JA', JSON.stringify(s));
    }
  });

  it('folds ASCII ONLY — a Turkish locale must not change the answer', () => {
    assert.notEqual('I'.toLocaleLowerCase('tr-TR'), 'i');
    assert.equal(canonicalLanguage('ITALIAN'), 'IT');
  });
});

describe('the table is closed and complete', () => {
  it('every source maps to a code that has a display word', () => {
    for (const [source, code] of Object.entries(LANGUAGE_SOURCES)) {
      assert.ok(LANGUAGE_DISPLAY[code], `${source} -> ${code} has no display word`);
    }
  });

  it('every code is reachable from at least one source', () => {
    const reachable = new Set(Object.values(LANGUAGE_SOURCES));
    for (const code of Object.keys(LANGUAGE_DISPLAY)) {
      assert.ok(reachable.has(code), `${code} is declared but nothing maps to it`);
    }
  });

  it('source keys are already folded, so a lookup cannot miss its own table', () => {
    for (const source of Object.keys(LANGUAGE_SOURCES)) {
      assert.equal(source, source.toLowerCase());
      assert.equal(canonicalLanguage(source), LANGUAGE_SOURCES[source]);
    }
  });

  it('publishes a version alongside the mapping, so a reader can check the words against the codes', () => {
    const t = languageTable();
    assert.equal(t.version, LANGUAGE_TABLE_VERSION);
    assert.equal(t.sources.jp, 'JA');
    assert.equal(t.display.JA, 'Japanese');
  });
});
