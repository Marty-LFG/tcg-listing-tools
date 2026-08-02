// test/data/catalogs.test.mjs — shape audits for the baked data catalogs. These fail
// loudly if a refresh bake (lib/refresh.mjs) or manual rebuild writes a broken file —
// the builders fetch these same-origin and would otherwise break silently at runtime.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';
import { normNum } from '../../lib/riftbound-data.mjs';
import { TREATMENT_OVERRIDE } from '../../scripts/build-riftbound-data.mjs';

describe('data/riftbound.json (build-riftbound-data.mjs)', () => {
  const rb = JSON.parse(read('data/riftbound.json'));
  // Deliberately NOT a hardcoded set list: the bake takes its roster + release order straight from
  // Riot's card gallery so a new set needs no code change, and a list here would be the one place
  // that still went stale. Assert the shape and the release-order anchor instead.
  it('is keyed by lowercase set code, in release order, covering every released set', () => {
    assert.ok(Object.keys(rb).length >= 5, `only ${Object.keys(rb).length} sets`);
    assert.equal(Object.keys(rb)[0], 'ogn', 'Origins must sort first (Riot release order)');
    assert.ok(rb.ogn, 'missing the Origins canary');
    for (const code of Object.keys(rb)) assert.equal(code, code.toLowerCase());
  });
  it('holds the full catalog (~1164+ cards)', () => {
    const total = Object.values(rb).reduce((n, s) => n + s.cards.length, 0);
    assert.ok(total >= 1150, `only ${total} cards`);
  });
  it('every card carries the slim per-card shape', () => {
    for (const [code, set] of Object.entries(rb)) {
      assert.ok(set.name && set.code, `${code}: set name/code`);
      assert.ok(set.total > 0, `${code}: printed set total (collectorNumberMax)`);
      for (const c of set.cards) {
        for (const k of ['k', 'num', 'name', 'rarity']) {
          assert.ok(c[k] != null && c[k] !== undefined, `${code} card ${c.num || c.k}: missing ${k}`);
        }
        assert.match(c.num, /^(\d+[a-z*]?|SP\d+[a-z*]?)\/\d+$/, `${code} card ${c.num}: printed number shape`);
        assert.equal(c.k, normNum(c.num), `${code} card ${c.num}: lookup key must be normNum(num)`);
      }
    }
  });
  // The variant label is derived once at bake time and frozen into the name, which is what keeps the
  // builder, lib/riftbound-data.mjs and every bulk consumer agreeing without duplicating the rule.
  // Re-derive it here so the frozen label can never silently drift from the printed number.
  it('name suffix matches the treatment its printed number implies', () => {
    for (const [code, set] of Object.entries(rb)) {
      for (const c of set.cards) {
        const numPart = c.num.split('/')[0];
        const sp = /^SP/i.test(numPart);
        const star = numPart.endsWith('*');
        const alt = !sp && /[a-z]$/i.test(numPart);
        const over = !sp && !star && !alt && (parseInt(numPart, 10) || 0) > set.total;
        const override = TREATMENT_OVERRIDE[set.code + '-' + c.k];
        const want = override ? ` (${override})` : star ? ' (Signature)' : alt ? ' (Alternate Art)' : over ? ' (Overnumbered)' : '';
        const got = (c.name.match(/\s\((Signature|Alternate Art|Overnumbered|Ultimate)\)$/) || [''])[0];
        assert.equal(got, want, `${code} ${c.num} "${c.name}": wrong treatment for its number`);
        // SP carries no suffix, so its rarity is the ONLY thing marking it as a premium printing.
        if (sp) assert.equal(c.rarity, 'Showcase', `${code} ${c.num}: SP promos must bake as Showcase`);
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
