// test/unit/listings-compose-context.test.mjs — the compositor's decision layer in lib/listings.mjs.
//
// Three things decide whether a listing gets branded rails: the master switch in
// data/listing-image.config.json, the per-path applyTo flags, and the per-listing toggle on the
// uploader. This pins the precedence and pins what goes ON the rail — the meta shape is what makes
// two conditions of one card share a single eBay upload instead of doubling the store's.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { composeMetaFor, composeContext, storePhotoOriginal } from '../../lib/listings.mjs';
import { ROOT } from '../helpers/extract-inline.mjs';

// composeContext reads the real config file, so these assertions pin the SHIPPED state: disabled.
const shipped = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'listing-image.config.json'), 'utf8')); }
  catch { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'listing-image.config.example.json'), 'utf8')); }
})();

describe('composeMetaFor', () => {
  it('maps the stored 2-letter language code to a readable name', () => {
    // The rail is buyer-facing: 'JP · MEGA SYMPHONIA' reads like a typo.
    assert.equal(composeMetaFor({ language: 'JP' }).language, 'Japanese');
    assert.equal(composeMetaFor({ language: 'EN' }).language, 'English');
  });
  it('derives productType from the stock row', () => {
    assert.equal(composeMetaFor({}).productType, 'single');
    assert.equal(composeMetaFor({ grading_company: 'PSA', grade: '10' }).productType, 'slab');
    assert.equal(composeMetaFor({ product_type: 'sealed' }).productType, 'sealed');
  });
  it('a graded row is a slab even with no company recorded', () => {
    assert.equal(composeMetaFor({ grade: '9' }).productType, 'slab');
  });
  it('carries set name, number and rarity', () => {
    const m = composeMetaFor({ set_name: 'Base Set', number: '58/102', rarity: 'Rare Holo' });
    assert.equal(m.setName, 'Base Set');
    assert.equal(m.cardNumber, '58/102');
    assert.equal(m.rarity, 'Rare Holo');
  });
  it('does NOT carry condition — that is the whole NM/LP dedupe argument', () => {
    const nm = composeMetaFor({ set_name: 'Base Set', condition: 'Near Mint' });
    const lp = composeMetaFor({ set_name: 'Base Set', condition: 'Lightly Played' });
    assert.equal(nm.condition, undefined);
    assert.deepEqual(nm, lp);
  });
  it('never returns undefined fields that would leak into a hash as "undefined"', () => {
    const m = composeMetaFor({});
    for (const [k, v] of Object.entries(m)) assert.equal(typeof v, 'string', `${k} is ${typeof v}`);
  });
});

describe('composeContext', () => {
  const item = { language: 'JP', set_name: 'Mega Symphonia' };

  it('ships OFF — nothing gets branded until the owner turns it on', () => {
    assert.equal(shipped.enabled, false, 'the shipped config must have enabled:false');
    const c = composeContext(item, null);
    assert.equal(c.enabled, false);
    assert.match(c.reason, /disabled in settings/);
  });

  it('an explicit false beats the config, and says why', () => {
    const c = composeContext(item, false);
    assert.equal(c.enabled, false);
    assert.match(c.reason, /turned off for this listing/);
  });

  it('an explicit true beats a disabled config', () => {
    const c = composeContext(item, true);
    assert.equal(c.enabled, true);
    assert.equal(c.meta.language, 'Japanese');
    assert.equal(c.meta.setName, 'Mega Symphonia');
    assert.ok(c.options.cfg, 'the resolved config must ride along so the compositor does not re-read it');
  });

  it('null defers to the config rather than defaulting to on', () => {
    assert.equal(composeContext(item, undefined).enabled, shipped.enabled);
    assert.equal(composeContext(item, null).enabled, shipped.enabled);
  });

  it('respects the per-path applyTo flags even when forced on', () => {
    // Rolling out ownerPhotos first, before catalogArt, is the documented sequence — so an explicit
    // per-listing "yes" must still not brand a path the owner has switched off.
    const both = composeContext(item, true, { path: 'catalogArt' });
    assert.equal(both.enabled, shipped.applyTo.catalogArt);
    if (!shipped.applyTo.catalogArt) assert.match(both.reason, /applyTo\.catalogArt is off/);
  });

  it('defaults to the catalogArt path when none is named', () => {
    assert.deepEqual(composeContext(item, true), composeContext(item, true, { path: 'catalogArt' }));
  });
});

describe('storePhotoOriginal', () => {
  it('content-addresses, so re-uploading the same photo costs nothing', () => {
    const buf = Buffer.from('pretend jpeg bytes ' + process.pid);
    const a = storePhotoOriginal(buf, 'jpg');
    const b = storePhotoOriginal(buf, 'jpg');
    try {
      assert.equal(a, b, 'the same bytes must land on the same path');
      assert.ok(fs.existsSync(a));
      assert.equal(fs.readFileSync(a).toString(), buf.toString());
      assert.match(path.basename(a), /^[0-9a-f]{64}\.jpg$/);
    } finally { try { fs.rmSync(a, { force: true }); } catch {} }
  });
  it('different bytes get different paths', () => {
    const a = storePhotoOriginal(Buffer.from('one ' + process.pid), 'jpg');
    const b = storePhotoOriginal(Buffer.from('two ' + process.pid), 'jpg');
    try { assert.notEqual(a, b); } finally { for (const f of [a, b]) { try { fs.rmSync(f, { force: true }); } catch {} } }
  });
});
