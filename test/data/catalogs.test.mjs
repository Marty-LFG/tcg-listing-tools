// test/data/catalogs.test.mjs — shape audits for the baked data catalogs. These fail
// loudly if a refresh bake (lib/refresh.mjs) or manual rebuild writes a broken file —
// the builders fetch these same-origin and would otherwise break silently at runtime.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';

describe('data/riftbound.json (build-riftbound-data.mjs)', () => {
  const rb = JSON.parse(read('data/riftbound.json'));
  it('has all released sets, keyed by lowercase set code', () => {
    for (const code of ['ogn', 'ogs', 'sfd', 'unl']) assert.ok(rb[code], `missing set ${code}`);
    for (const code of Object.keys(rb)) assert.equal(code, code.toLowerCase());
  });
  it('holds the full catalog (~943+ cards)', () => {
    const total = Object.values(rb).reduce((n, s) => n + s.cards.length, 0);
    assert.ok(total >= 900, `only ${total} cards`);
  });
  it('every card carries the slim per-card shape', () => {
    for (const [code, set] of Object.entries(rb)) {
      assert.ok(set.name && set.code, `${code}: set name/code`);
      for (const c of set.cards) {
        for (const k of ['k', 'num', 'name', 'rarity']) {
          assert.ok(c[k] != null && c[k] !== undefined, `${code} card ${c.num || c.k}: missing ${k}`);
        }
      }
    }
  });
});

describe('data/pokemon-intl-sets.json (build-pokemon-intl-sets.mjs)', () => {
  const intl = JSON.parse(read('data/pokemon-intl-sets.json'));
  it('covers the JP/CN/KO languages', () => {
    for (const lang of ['ja', 'zh-cn', 'zh-tw', 'ko']) {
      assert.ok(Array.isArray(intl[lang]), `missing ${lang}`);
    }
    assert.ok(intl.ja.length >= 50, `ja has only ${intl.ja.length} sets`);
  });
  it('every set has an identity; the vast majority are TCGdex-backed', () => {
    for (const lang of Object.keys(intl)) {
      let dexBacked = 0;
      for (const s of intl[lang]) {
        assert.ok(s.code || s.tcgdexId || s.name_native || s.name_en,
          `${lang}: set with no identity at all (${JSON.stringify(s).slice(0, 80)})`);
        assert.ok('code' in s, `${lang}: code key must exist`);
        if (s.tcgdexId) dexBacked++;
      }
      // vintage seed-only rows (data/pokemon-intl-seed.json) are ~1/3 of ja — majority is the bar
      assert.ok(dexBacked / intl[lang].length > 0.5, `${lang}: only ${dexBacked}/${intl[lang].length} TCGdex-backed`);
    }
  });
});

describe('data/funko_pop.json (frozen 2021 assist catalog)', () => {
  const fk = JSON.parse(read('data/funko_pop.json'));
  it('is the ~11k-row vendored catalog', () => assert.ok(fk.length > 10_000, `${fk.length} rows`));
  it('rows carry a title; franchise on most', () => {
    const sample = fk.slice(0, 500);
    for (const r of sample) assert.ok(typeof r.t === 'string' && r.t, 'row without t');
    const withFr = sample.filter((r) => r.fr).length;
    assert.ok(withFr / sample.length > 0.8, `only ${withFr}/${sample.length} rows have a franchise`);
  });
});

describe('data/pokemon-dex-en.json', () => {
  const dex = JSON.parse(read('data/pokemon-dex-en.json'));
  it('has the dex + per-language name maps', () => {
    for (const k of ['dex', 'ja', 'ko', 'zh-cn', 'zh-tw']) assert.ok(dex[k], `missing ${k}`);
    assert.equal(dex.dex['6'], 'Charizard'); // canary
  });
});

describe('data/grading-companies.json (inventory cert registry)', () => {
  const gc = JSON.parse(read('data/grading-companies.json'));
  it('registry shape + unique codes', () => {
    assert.ok(gc.companies.length >= 12, `${gc.companies.length} companies`);
    const codes = gc.companies.map((c) => c.code);
    assert.equal(new Set(codes).size, codes.length, 'duplicate company codes');
    for (const c of gc.companies) {
      assert.ok(c.code && c.label && c.scale, `${c.code || '?'}: code/label/scale`);
      assert.ok('certUrl' in c, `${c.code}: certUrl key (nullable) must exist`);
      assert.equal(typeof c.lookup, 'boolean', `${c.code}: lookup flag`);
    }
  });
  it('PSA is the only lookup-capable provider today (lib/certlookup.mjs PROVIDERS)', () => {
    const lookups = gc.companies.filter((c) => c.lookup).map((c) => c.code);
    assert.deepEqual(lookups, ['PSA'], 'a new lookup=true company needs a PROVIDERS entry in lib/certlookup.mjs');
  });
});
