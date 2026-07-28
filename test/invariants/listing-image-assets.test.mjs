// test/invariants/listing-image-assets.test.mjs — the compositor's assets must exist and be usable.
//
// These are the failures that are SILENT at runtime: a variant registered in code with no art on
// disk throws only when someone lists a card of that language, and a font whose family name does not
// match the TTF's internal name renders a different typeface with no error at all. Both would ship.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VARIANTS, DEFAULT_CONFIG, PROFILES, resolveLayout, ROOT } from '../../lib/listing-image-config.mjs';
import { railPath, railsPresent, railsDigest, railMeta, fontProbe, fontFile, getSharp, SIDES } from '../../lib/listing-image-assets.mjs';

const sharp = await getSharp();

describe('rail art', () => {
  for (const variant of VARIANTS) {
    it(`variant '${variant}' has both rails on disk`, () => {
      for (const side of SIDES) {
        const p = railPath(variant, side);
        assert.ok(fs.existsSync(p), `missing ${path.relative(ROOT, p)} — a registered variant with no art throws at listing time, not now`);
        assert.ok(fs.statSync(p).size > 0, `${path.relative(ROOT, p)} is empty`);
      }
      assert.equal(railsPresent(variant), true);
      assert.match(railsDigest(variant), /^[0-9a-f]{64}$/);
    });
  }

  it('every rail is a portrait PNG — a rail runs the full canvas edge', { skip: !sharp && 'sharp not installed' }, async () => {
    for (const variant of VARIANTS) {
      for (const side of SIDES) {
        const m = await railMeta(variant, side);
        assert.equal(m.format, 'png', `${variant}/${side} is ${m.format}, not png`);
        assert.ok(m.height > m.width, `${variant}/${side} is ${m.width}x${m.height} — rails are taller than they are wide`);
      }
    }
  });

  it('left and right rails of a variant are the same size', { skip: !sharp && 'sharp not installed' }, async () => {
    for (const variant of VARIANTS) {
      const [l, r] = await Promise.all([railMeta(variant, 'left'), railMeta(variant, 'right')]);
      assert.deepEqual([l.width, l.height], [r.width, r.height], `${variant} rails differ: ${l.width}x${l.height} vs ${r.width}x${r.height}`);
    }
  });

  it('rail art matches the aspect its profile will scale it to, within tolerance', { skip: !sharp && 'sharp not installed' }, async () => {
    // Art is normalised to (railWidth x canvas) once at load. Authoring at a very different aspect
    // means that one resize distorts it — which is a design problem the tests should surface, not a
    // runtime error. The `sealed` variant pairs with the sealed profile's narrower rail.
    const profileFor = { default: 'single', japanese: 'single', sealed: 'sealed' };
    for (const variant of VARIANTS) {
      const l = resolveLayout(DEFAULT_CONFIG, { productType: profileFor[variant] });
      const target = l.railWidth / l.canvas;
      const m = await railMeta(variant, 'left');
      const actual = m.width / m.height;
      assert.ok(Math.abs(actual - target) / target < 0.08,
        `${variant} art is ${m.width}x${m.height} (aspect ${actual.toFixed(4)}) but will be scaled to ${l.railWidth}x${l.canvas} (aspect ${target.toFixed(4)}) — it will squash`);
    }
  });

  it('every variant named by a profile-driven rule is registered', () => {
    // resolveVariant can return 'sealed' for productType sealed; VARIANTS must carry it or the
    // lookup throws at listing time.
    assert.ok(VARIANTS.includes('sealed'));
    assert.ok(VARIANTS.includes('japanese'));
    assert.ok(VARIANTS.includes('default'));
    for (const name of Object.keys(PROFILES)) assert.equal(typeof name, 'string');
  });
});

describe('font', () => {
  it('the configured font file is committed', () => {
    const f = fontFile(DEFAULT_CONFIG);
    assert.ok(fs.existsSync(f), `missing ${path.relative(ROOT, f)} — the text layer silently disables without it`);
    assert.ok(fs.statSync(f).size > 1000, 'font file looks truncated');
  });

  it('the configured family name actually selects the bundled face', { skip: !sharp && 'sharp not installed' }, async () => {
    // The failure this catches: sharp's `text.fontfile` loads the file, but `font` still picks the
    // face through fontconfig. Name the family wrong — 'Genty-Sans' instead of 'Genty Sans' — and
    // it renders the system default with no error whatsoever.
    const p = await fontProbe(DEFAULT_CONFIG);
    assert.equal(p.ok, true, p.reason || 'font probe failed');
    assert.ok(p.width > 0 && p.height > 0);
  });

  it('the probe FAILS on a wrong family name (it is not just returning true)', { skip: !sharp && 'sharp not installed' }, async () => {
    const p = await fontProbe({ ...DEFAULT_CONFIG, font: { ...DEFAULT_CONFIG.font, family: 'Genty-Sans' } });
    assert.equal(p.ok, false);
    assert.match(p.reason, /did not load|substituted/);
  });

  it('the probe FAILS on a missing file rather than reporting ready', async () => {
    const p = await fontProbe({ ...DEFAULT_CONFIG, font: { family: 'Genty Sans', file: 'fonts/does-not-exist.ttf' } });
    assert.equal(p.ok, false);
    assert.match(p.reason, /not found/);
  });
});
