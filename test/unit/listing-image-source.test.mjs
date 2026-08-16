// test/unit/listing-image-source.test.mjs — the shared source prep (lib/listing-image-source.mjs).
//
// Two things are pinned here and both are load-bearing:
//   · orientedSize() must report the POST-rotate dimensions. Getting it wrong does not produce a
//     wrong image, it produces `extract_area: bad extract area` — measured, and the reason this
//     function exists rather than a `base.clone().metadata()` call.
//   · the eBay path's whole-frame check stays FROZEN against the pre-rotate dimensions. That looks
//     like a bug and is one, but un-fixing it on the eBay path would change pixels on a cold render
//     of every sideways owner photo (0.58% of them, max channel delta 97). The new frames get the
//     honest check; eBay keeps the old one until the D-023 reset.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orientedSize, prepareSource, regionFor } from '../../lib/listing-image-source.mjs';
import { resolveLayout, DEFAULT_CONFIG } from '../../lib/listing-image-config.mjs';
import { getSharp } from '../../lib/listing-image-assets.mjs';
import { trimDetector } from '../../lib/listing-image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'listing-image', 'exif-orient-6.jpg');

describe('orientedSize', () => {
  it('prefers autoOrient, which sharp >= 0.33 reports correctly', () => {
    assert.deepEqual(orientedSize({ width: 600, height: 300, orientation: 6, autoOrient: { width: 300, height: 600 } }),
      { width: 300, height: 600 });
  });

  it('falls back to the manual swap for orientations 5-8', () => {
    for (const o of [5, 6, 7, 8]) {
      assert.deepEqual(orientedSize({ width: 600, height: 300, orientation: o }), { width: 300, height: 600 },
        `orientation ${o} should swap the axes`);
    }
  });

  it('leaves orientations 1-4 alone — those are flips and rotations by 180, not by 90', () => {
    for (const o of [1, 2, 3, 4]) {
      assert.deepEqual(orientedSize({ width: 600, height: 300, orientation: o }), { width: 600, height: 300 },
        `orientation ${o} should not swap the axes`);
    }
  });

  it('a source with no orientation tag at all passes through', () => {
    assert.deepEqual(orientedSize({ width: 733, height: 1024 }), { width: 733, height: 1024 });
  });

  it('ignores a malformed autoOrient rather than returning zeroes', () => {
    assert.deepEqual(orientedSize({ width: 400, height: 560, autoOrient: { width: 0, height: 0 } }),
      { width: 400, height: 560 });
  });
});

const sharp = await getSharp();
const SKIP = sharp ? false : 'sharp unavailable';

describe('prepareSource', { skip: SKIP }, () => {
  const layout = resolveLayout(DEFAULT_CONFIG, { productType: 'single' }, {});

  it('reports the true post-rotate frame for a sideways photo', async () => {
    const prep = await prepareSource(sharp, fs.readFileSync(FIXTURE), { layout, detector: trimDetector });
    // The fixture is stored 600x300 with orientation 6.
    assert.equal(prep.srcMeta.width, 600);
    assert.equal(prep.srcMeta.height, 300);
    assert.deepEqual(prep.frame, { width: 300, height: 600 });
  });

  it('the two whole-frame checks DISAGREE on a rotated source — that is the frozen bug, pinned', async () => {
    const prep = await prepareSource(sharp, fs.readFileSync(FIXTURE), { layout, detector: trimDetector });
    assert.ok(prep.region, 'the detector should have returned a region for this fixture');
    assert.equal(prep.frameFull, true, 'nothing to crop: the region covers the true frame');
    assert.equal(prep.legacyFull, false, 'the pre-rotate comparison cannot match a rotated frame');

    // And therefore: eBay still extracts (pixels preserved), the new frames do not.
    assert.ok(regionFor(prep, { legacy: true }), 'the eBay path must keep taking the extract');
    assert.equal(regionFor(prep, { legacy: false }), null, 'the honest path drops the no-op extract');
  });

  it('agrees on an unrotated source, which is every catalog scan', async () => {
    const flat = await sharp({ create: { width: 400, height: 560, channels: 3, background: '#2c6' } }).jpeg().toBuffer();
    const prep = await prepareSource(sharp, flat, { layout, detector: trimDetector });
    assert.equal(prep.legacyFull, prep.frameFull);
    assert.equal(regionFor(prep, { legacy: true }), regionFor(prep, { legacy: false }));
  });

  it('the tiny-region guard is identical under both checks — it is w*h, and that commutes', async () => {
    const prep = await prepareSource(sharp, fs.readFileSync(FIXTURE), { layout, detector: trimDetector });
    const swapped = { ...prep, srcMeta: { ...prep.srcMeta, width: prep.srcMeta.height, height: prep.srcMeta.width } };
    assert.equal(prep.tooSmall, false);
    assert.equal(swapped.tooSmall, prep.tooSmall);
  });

  it('no detector means no region, and never throws', async () => {
    const prep = await prepareSource(sharp, fs.readFileSync(FIXTURE), { layout, detector: null });
    assert.equal(prep.region, null);
    assert.equal(regionFor(prep, { legacy: true }), null);
  });

  it('a detector that throws degrades to the untrimmed frame', async () => {
    const boom = { name: 'boom', async detect() { throw new Error('detector exploded'); } };
    const prep = await prepareSource(sharp, fs.readFileSync(FIXTURE), { layout, detector: boom });
    assert.equal(prep.region, null);
  });

  it('rejects a region that keeps almost nothing, whatever the detector claims', async () => {
    const flat = await sharp({ create: { width: 400, height: 560, channels: 3, background: '#2c6' } }).jpeg().toBuffer();
    const sliver = { name: 'sliver', async detect() { return { left: 0, top: 0, width: 20, height: 20 }; } };
    const prep = await prepareSource(sharp, flat, { layout, detector: sliver });
    assert.equal(prep.tooSmall, true);
    assert.equal(regionFor(prep, { legacy: true }), null);
  });
});
