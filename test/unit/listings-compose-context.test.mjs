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
import { composeMetaFor, composeContext, storePhotoOriginal, printedCardNumber } from '../../lib/listings.mjs';
import { ROOT } from '../helpers/extract-inline.mjs';
import { isRailDrawable } from '../../lib/listing-image-config.mjs';

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
  it('resolves the set symbol when the set is one we have cached', () => {
    // Cold cache in CI is fine — the assertion is "a URL or nothing", never a crash.
    const m = composeMetaFor({ set_name: 'Pitch Black', set_code: 'PBL', number: '006/084' });
    assert.equal(typeof m.setSymbolUrl, 'string');
    if (m.setSymbolUrl) assert.match(m.setSymbolUrl, /^https?:\/\//);
  });
  it('an unknown set yields no symbol rather than throwing', () => {
    const m = composeMetaFor({ set_name: 'No Such Set At All', number: '1/1' });
    assert.equal(m.setSymbolUrl, '');
  });

  describe('non-English cards resolve against the JP index, not the English one', () => {
    // A JP card is a different product, not a translation: its own set name, its own card count and
    // therefore its own printed number. The English set's identity on a JP rail is simply wrong.
    it('uses the romanised JP set name for a JP row saved under its English set', () => {
      const m = composeMetaFor({ set_name: 'Pitch Black', set_code: 'M5', number: '102', language: 'JP' });
      assert.equal(m.language, 'Japanese');
      assert.equal(m.setName, 'Abyss Eye', 'a JP card is not in "Pitch Black"');
    });
    it('numbers it out of the JAPANESE card count', () => {
      // JP Abyss Eye holds 81 cards, so a secret rare prints 102/081 — a number that does not exist
      // in the 84-card English set.
      const m = composeMetaFor({ set_name: 'Pitch Black', set_code: 'M5', number: '102', language: 'JP' });
      assert.equal(m.cardNumber, '102/081');
    });
    it('resolves by the native name and by the English equivalent too', () => {
      for (const name of ['Abyss Eye', 'アビスアイ', 'Pitch Black']) {
        assert.equal(composeMetaFor({ set_name: name, number: '1', language: 'JP' }).setName, 'Abyss Eye', `failed for ${name}`);
      }
    });
    it('English rows are untouched by any of this', () => {
      const m = composeMetaFor({ set_name: 'Pitch Black', set_code: 'PBL', number: '006/084', language: 'EN' });
      assert.equal(m.setName, 'Pitch Black');
      assert.equal(m.cardNumber, '006/084');
    });
    it('an unknown JP set falls back to the row rather than throwing', () => {
      const m = composeMetaFor({ set_name: 'Not A Real JP Set', number: '5', language: 'JP' });
      assert.equal(m.setName, 'Not A Real JP Set');
    });
    it('NEVER falls back to the native name — the rail font cannot draw it', () => {
      // 146 of 277 JP sets have no romanised name in the bake. Using name_native there would put
      // Japanese script on a Latin-only rail, which renders via a system font on Windows and as
      // blank boxes on a server without one.
      const m = composeMetaFor({ set_name: 'Start Deck 100', set_code: 'MC', number: '5', language: 'JP' });
      assert.ok(isRailDrawable(m.setName), `setName "${m.setName}" is not drawable by the rail font`);
    });
    it('resolves the JP set logo by code as well as by name', () => {
      // Bulbapedia files them as SV3a_Raging_Surf_Logo.png — findable from either identity.
      const byCode = composeMetaFor({ set_name: 'Raging Surf', set_code: 'SV3a', number: '50', language: 'JP' });
      if (byCode.setLogoUrl) assert.match(byCode.setLogoUrl, /Raging_Surf_Logo/);
    });
  });

  describe('every JP set in the bake produces rail-drawable output', () => {
    it('no set name reaching the rail needs a font we do not ship', () => {
      const bad = [];
      for (const code of ['M5', 'SV3a', 'S12a', 'MC', 'M-P', 'SVLN', 'CS1.5']) {
        const m = composeMetaFor({ set_name: '', set_code: code, number: '1', language: 'JP' });
        if (m.setName && !isRailDrawable(m.setName)) bad.push(code + '=' + m.setName);
      }
      assert.deepEqual(bad, [], 'these would render as blank boxes on a host without a CJK font');
    });
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

describe('printedCardNumber (Golden Rule 10 on the rail)', () => {
  it('passes an ALREADY-PRINTED number through untouched', () => {
    // The trap: formatCardNumber takes the RAW upstream number. "069/086" matches neither numeric
    // branch, so it falls to the trailing `raw + '/' + denom` and comes back "069/086/086".
    assert.equal(printedCardNumber({ number: '069/086', set_name: 'Pitch Black', printed_total: 86 }), '069/086');
    assert.equal(printedCardNumber({ number: '106/086', printed_total: 86 }), '106/086');
    assert.equal(printedCardNumber({ number: 'TG01/TG30', printed_total: 30 }), 'TG01/TG30');
  });
  it('rebuilds a bare number from the set era — modern pads to three digits', () => {
    assert.equal(printedCardNumber({ number: '6', set_name: 'Pitch Black', printed_total: 84, set_series: 'Mega Evolution', set_release_date: '2026/07/17' }), '006/084');
  });
  it('pre-Sword & Shield keeps its natural width', () => {
    assert.equal(printedCardNumber({ number: '58', set_name: 'Base Set', printed_total: 102, set_release_date: '1999/01/09' }), '58/102');
  });
  it('a promo prints bare, with no invented denominator', () => {
    assert.equal(printedCardNumber({ number: 'SWSH039', set_name: 'SWSH Black Star Promos', printed_total: 307 }), 'SWSH039');
  });
  it('an empty number stays empty rather than becoming a lone slash', () => {
    assert.equal(printedCardNumber({}), '');
    assert.equal(printedCardNumber({ number: '   ' }), '');
  });
  it('never throws on a malformed row — the rail badge is not worth a failed listing', () => {
    assert.doesNotThrow(() => printedCardNumber({ number: '4', printed_total: 'wat', set_release_date: 'nonsense' }));
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
