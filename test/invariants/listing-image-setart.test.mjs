// test/invariants/listing-image-setart.test.mjs — the set symbol/logo pair has ONE resolver, and a
// monochrome SVG icon does not rasterise to an invisible black blob.
//
// composeListingImage and hashFor both need the symbol + logo, and both feed their digests into the
// content hash. They used to derive the pair twice, by hand, and the two copies had already drifted
// — hashFor carried an extra `sharp &&` that composeListingImage did not. Any divergence there means
// a cache probe reports a hit for an image the real compose would render differently, which is the
// one failure mode a content-addressed cache is supposed to make impossible.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSharp } from '../../lib/listing-image-assets.mjs';
import { recolourGlyph } from '../../lib/listing-image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'listing-image.mjs'), 'utf8');

describe('loadSetArt has exactly one caller', () => {
  it('is called only from resolveSetArt', () => {
    // Strip the declaration and every comment, then count what is left.
    const body = SRC.replace(/^\s*async function loadSetArt\(/m, 'async function DECL_(')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const calls = body.match(/\bloadSetArt\s*\(/g) || [];
    assert.equal(calls.length, 2, `expected the two calls inside resolveSetArt, found ${calls.length}`);
    // …and both of them inside resolveSetArt, not scattered back through the entry points.
    const fn = body.slice(body.indexOf('async function resolveSetArt'));
    const end = fn.indexOf('\n}');
    const inside = (fn.slice(0, end).match(/\bloadSetArt\s*\(/g) || []).length;
    assert.equal(inside, 2, 'both loadSetArt calls must live inside resolveSetArt');
  });

  it('composeListingImage and hashFor go through the resolver, not the loader', () => {
    for (const entry of ['export async function composeListingImage', 'export async function hashFor']) {
      const at = SRC.indexOf(entry);
      assert.ok(at > 0, `${entry} not found`);
      const body = SRC.slice(at, SRC.indexOf('\n}', at));
      assert.ok(/resolveSetArt\(/.test(body), `${entry} must call resolveSetArt`);
      assert.ok(!/loadSetArt\(/.test(body), `${entry} must NOT call loadSetArt directly`);
    }
  });
});

describe('recolourGlyph — a black SVG icon on a near-black rail', () => {
  // Scryfall's icons are <path>s with no fill attribute, so librsvg draws them pure black; the rails
  // run #2e1640 -> #150a1d. .tint() cannot fix it — tint multiplies, and black x anything is black.
  const BADGE = '#efe8f6';
  const black = (sharp) => sharp(Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M1 1h6v6H1z"/></svg>',
  )).png().toBuffer();

  it('an unfilled path really does rasterise black (the bug this guards)', async () => {
    const sharp = await getSharp();
    if (!sharp) return;                                  // host without sharp — nothing to assert
    const { data } = await sharp(await black(sharp)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0, isBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200) { opaque++; if (data[i] < 20 && data[i + 1] < 20 && data[i + 2] < 20) isBlack++; }
    }
    assert.ok(opaque > 0, 'the probe glyph drew nothing');
    assert.equal(isBlack, opaque, 'every opaque pixel should be black — that is the whole problem');
  });

  it('replaces the colour channels and PRESERVES the alpha that carries the shape', async () => {
    const sharp = await getSharp();
    if (!sharp) return;
    const src = await black(sharp);
    const before = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = await recolourGlyph(sharp, src, BADGE);
    const after = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    assert.equal(after.data.length, before.data.length, 'dimensions must not change');
    let recoloured = 0, alphaKept = 0;
    for (let i = 0; i < after.data.length; i += 4) {
      assert.equal(after.data[i + 3], before.data[i + 3], 'alpha must survive byte for byte');
      if (after.data[i + 3] === 0) alphaKept++;
      if (after.data[i + 3] > 200) {
        assert.equal(after.data[i], 0xef);
        assert.equal(after.data[i + 1], 0xe8);
        assert.equal(after.data[i + 2], 0xf6);
        recoloured++;
      }
    }
    assert.ok(recoloured > 0, 'nothing was recoloured');
    assert.ok(alphaKept > 0, 'the transparent surround should still be transparent');
  });

  it('a malformed colour is a no-op rather than a thrown listing', async () => {
    const sharp = await getSharp();
    if (!sharp) return;
    const src = await black(sharp);
    assert.equal(await recolourGlyph(sharp, src, 'not-a-colour'), src);
    assert.equal(await recolourGlyph(sharp, src, null), src);
  });
});
