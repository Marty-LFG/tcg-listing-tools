// test/unit/listing-image-hash-pin.test.mjs — the eBay content hash, pinned to literal values.
//
// IF THIS FILE FAILS, A FIELD LEAKED INTO THE eBAY CONTENT HASH.
//
// Every branded image already hosted on a live eBay listing is keyed on these exact values
// (listing_images.compose_hash, and the <hash>.jpg disk cache). A change orphans the lot and forces
// a full re-upload of the store — an ASSET_VERSION-bump-sized decision. It fails here rather than
// in production, on the day the change is made rather than the day someone notices the store is
// re-uploading itself.
//
// WHY PIXELS ARE NOT PINNED BUT THESE ARE. The rest of the image suite compares decoded RGBA with a
// tolerance, because libvips is not byte-deterministic across builds (test/helpers/image-diff.mjs
// says so at length). composeHash is different in kind: it hashes INPUTS — the source bytes, the
// serialised layout, some strings — never output bytes. It is a pure function of values this repo
// controls, so it is stable across builds by construction and a literal pin is exactly right.
//
// Deliberately imports NO sharp, so it can never skip. The one test in this suite that must run on
// every host is the one guarding the hosted estate.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  ASSET_VERSION, DEFAULT_CONFIG, VARIANTS,
  composeHash, composeVersion, resolveLayout,
} from '../../lib/listing-image-config.mjs';
import {
  SIDES, railPath, railsDigest, railsPresent, bandsDigest, bandsPresent,
} from '../../lib/listing-image-assets.mjs';

// Fixed inputs, chosen to be independent of anything on disk. The assetDigest is a made-up constant
// rather than the real railsDigest(): the rail ART is pinned separately below, so swapping rail art
// fails ONE test with a clear message instead of all six with a confusing one.
const SRC = Buffer.from('pinned-source-bytes-v1');
const AD = 'deadbeefcafe';
const layoutFor = (productType) => resolveLayout(DEFAULT_CONFIG, { productType }, {});

const VECTORS = [
  ['single, no text, no badge', {
    sourceBytes: SRC, layout: layoutFor('single'), variant: 'default', textLines: [], assetDigest: AD, badge: '',
  }, '35716d344e3a889c8159b58390c22836446003c32754a1723e170a005b0ef618'],

  ['single with rail text and a set badge', {
    sourceBytes: SRC, layout: layoutFor('single'), variant: 'default',
    textLines: ['PARASECT', 'LOST ORIGIN'], assetDigest: AD, badge: '006/084||',
  }, '67240f246192604226440aae0cbd314c58c2196f20e117a336ecf3b158e5ce29'],

  ['japanese variant', {
    sourceBytes: SRC, layout: layoutFor('single'), variant: 'japanese', textLines: ['X'], assetDigest: AD, badge: '',
  }, '8175137060f003ff4ddbd01a700535304c7dcd03a0b7c1ae24267f026cc332a1'],

  ['slab profile', {
    sourceBytes: SRC, layout: layoutFor('slab'), variant: 'default', textLines: [], assetDigest: AD, badge: '',
  }, '06b130528ee6392b2dec23e3385818a7925e0a07a8bebeef8439e6f59ae69a02'],

  ['sealed profile on sealed rails', {
    sourceBytes: SRC, layout: layoutFor('sealed'), variant: 'sealed', textLines: [], assetDigest: AD, badge: '',
  }, '4de5e96ea331e021fc0240a2967adbad3fccc89b4c22973bd85ebb7cb0f5eacd'],

  ['catalog-art flags (notrim,rcorners)', {
    sourceBytes: SRC, layout: layoutFor('single'), variant: 'default', textLines: [], assetDigest: AD, badge: '',
    flags: 'notrim,rcorners',
  }, '810e9640d078833516b3f1786cf81b0fccdfa8e6444428f78ae3a2b243b619a9'],
];

describe('eBay content hash — pinned', () => {
  for (const [name, input, expected] of VECTORS) {
    it(name, () => {
      assert.equal(composeHash(input), expected,
        'the eBay content hash moved. Every image hosted on a live listing is keyed on the old '
        + 'value, so this is an ASSET_VERSION conversation (AGENTS.md 19), not a test to update.');
    });
  }

  it('ASSET_VERSION is v1 — it is an input to every hash above', () => {
    assert.equal(ASSET_VERSION, 'v1');
  });
});

describe('rail art digests — pinned separately', () => {
  // railsDigest is sha256 over the RAW rail PNGs and feeds the hash, so new art re-composes even
  // without an ASSET_VERSION bump. That is the design. The pin exists so the re-compose is a
  // decision someone made, not a surprise — and so that ADDING art (e.g. horizontal band assets in
  // the same directory) can be proven not to move it.
  const PINS = {
    default: '62bbecce83eff3135b9038d501aa6502e018ce99939260c9335d3452935385f3',
    japanese: 'd37fe0f3a724292eeea6726712a29e8cde6bf028c60bac37b12f443940c13340',
    sealed: '2f0b8746529637e47d783499c56371013c67817148b06661cf22339efde632ed',
  };

  it('covers exactly the variants the compositor knows about', () => {
    assert.deepEqual([...VARIANTS].sort(), Object.keys(PINS).sort());
  });

  for (const [variant, digest] of Object.entries(PINS)) {
    it(`${variant} rails are unchanged`, () => {
      assert.equal(railsDigest(variant), digest,
        `rails/${variant} art changed. Every composite using it re-hashes and re-uploads — `
        + 'intended when the art was deliberately replaced, a bug otherwise.');
    });
  }

  it('railsDigest means LEFT + RIGHT only', () => {
    // Load-bearing now that horizontal band art lives in the SAME directories. Any extra PNG folded
    // into this digest would re-key every hosted eBay image. Proven directly: the digest equals a
    // hand-rolled sha256 of exactly those two files, in that order, and nothing else.
    const h = crypto.createHash('sha256');
    for (const side of SIDES) h.update(fs.readFileSync(railPath('default', side)));
    assert.deepEqual([...SIDES], ['left', 'right'], 'SIDES is what railsDigest hashes — do not add to it');
    assert.equal(railsDigest('default'), h.digest('hex'));
    assert.equal(railsDigest('default'), PINS.default);
  });

  it('band art exists beside the rails and has NOT changed the rail digest', () => {
    for (const variant of Object.keys(PINS)) {
      assert.ok(bandsPresent(variant), `rails/${variant} is missing top.png/bottom.png`);
      assert.equal(railsDigest(variant), PINS[variant],
        `adding band art moved rails/${variant}'s digest — that re-uploads the whole eBay store`);
    }
  });

  it('the band digest is a DIFFERENT value, so the two can never be confused', () => {
    for (const variant of Object.keys(PINS)) {
      const bands = bandsDigest(variant);
      assert.ok(bands && bands.length === 64, `bandsDigest(${variant}) should be a sha256`);
      assert.notEqual(bands, railsDigest(variant));
    }
  });

  it('railsPresent still means left+right — a missing band must not block an eBay listing', () => {
    // If these ever became the same check, deleting top.png would take the whole store offline.
    for (const variant of Object.keys(PINS)) assert.equal(railsPresent(variant), true);
    assert.notEqual(railsPresent, bandsPresent);
  });
});

describe('composeVersion — the audit token', () => {
  it('is three segments for the eBay square', () => {
    const v = composeVersion('default', railsDigest('default'));
    assert.equal(v, 'v1/default/62bbecce');
    assert.equal(v.split('/').length, 3);
  });

  it('drops the digest segment when there is no art', () => {
    assert.equal(composeVersion('default', ''), 'v1/default');
  });
});
