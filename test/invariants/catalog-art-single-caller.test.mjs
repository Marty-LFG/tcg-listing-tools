// test/invariants/catalog-art-single-caller.test.mjs
//
// Bandai's keyless One Piece mirrors serve card scans with a SAMPLE WATERMARK stamped across them.
// cleanOnepieceArt() swaps in the clean TCGplayer scan — and it used to be applied BY HAND at each
// surface that shows catalog art. That is a bug waiting for the next surface: a path that forgets it
// publishes a watermarked image as the product photo, with no error anywhere. On Shopify that would
// be position 1 on every One Piece product in the store.
//
// So the swap lives in exactly one function, catalogArtFor(), and every surface goes through it.
// Same shape as the test pinning resolveSetArt as the sole caller of loadSetArt.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';
import { catalogArtFor } from '../../lib/onepiece-clean-art.mjs';

const OWNER = path.join('lib', 'onepiece-clean-art.mjs');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

describe('cleanOnepieceArt has exactly one caller', () => {
  it('is only referenced inside the module that owns it', () => {
    const offenders = [];
    for (const file of walk(path.join(ROOT, 'lib'))) {
      const rel = path.relative(ROOT, file);
      if (rel === OWNER) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (/\bcleanOnepieceArt\s*\(/.test(src) || /\bcleanOnepieceArt\b(?=[^(]*from)/.test(src)) offenders.push(rel);
    }
    assert.deepEqual(offenders, [],
      'these modules call cleanOnepieceArt directly instead of catalogArtFor — a surface that '
      + 'forgets the swap publishes SAMPLE-watermarked art as the product photo:\n  ' + offenders.join('\n  '));
  });

  it('catalogArtFor is what the surfaces import', () => {
    const users = [];
    for (const file of walk(path.join(ROOT, 'lib'))) {
      const rel = path.relative(ROOT, file);
      if (rel === OWNER) continue;
      if (/\bcatalogArtFor\s*\(/.test(fs.readFileSync(file, 'utf8'))) users.push(rel);
    }
    // The publish path and the compositor surfaces. If this list shrinks, a surface stopped
    // resolving catalog art through the one place that knows about the watermark.
    assert.ok(users.length >= 2, `expected several surfaces to use catalogArtFor, found: ${users.join(', ')}`);
    assert.ok(users.some((u) => u.includes('ebay-map')), 'the eBay publish path must go through it');
    assert.ok(users.some((u) => u.includes('listing-image-lab')), 'the compositor surfaces must go through it');
  });
});

describe('catalogArtFor', () => {
  it('passes a non-One-Piece row straight through', () => {
    assert.equal(catalogArtFor({ game: 'pokemon', image_url: 'https://x/a.png' }, 'https://x/a.png'), 'https://x/a.png');
  });

  it('falls back to the row\'s own image when nothing is passed', () => {
    assert.equal(catalogArtFor({ game: 'mtg', image_url: 'https://x/b.png' }), 'https://x/b.png');
  });

  it('a One Piece row with no index entry keeps its fallback rather than losing its art', () => {
    // GR7: no clean scan is a reason to use the original, never a reason to have no image.
    assert.equal(catalogArtFor({ game: 'onepiece', number: 'ZZ99-999', language: 'EN' }, 'https://x/c.png'), 'https://x/c.png');
  });

  it('never returns undefined', () => {
    assert.equal(catalogArtFor({}), '');
    assert.equal(catalogArtFor(), '');
  });
});
