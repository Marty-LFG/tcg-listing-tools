// test/unit/listing-image-config.test.mjs — layout resolution + the content hash
// (lib/listing-image-config.mjs). Pure: no sharp, no disk, runs everywhere.
//
// The hash matrix is the important part of this file. The compositor renders per-card metadata into
// the rail, so the hash has to split on anything that reaches the pixels and NOT split on anything
// that does not — get it wrong in one direction and one card wears another card's branding, wrong
// in the other and every condition variant of every card is a separate upload to eBay.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_VERSION, CANVAS, DEFAULT_LAYOUT, DEFAULT_CONFIG, PROFILES, VARIANTS,
  resolveVariant, resolveLayout, validateLayout, railText, composeHash, composeVersion, layoutFingerprint,
} from '../../lib/listing-image-config.mjs';

const BYTES = Buffer.from('pretend this is a card scan');

describe('resolveVariant', () => {
  it('explicit option beats every rule', () => {
    assert.equal(resolveVariant({ language: 'Japanese', productType: 'sealed' }, { variant: 'default' }), 'default');
  });
  it('throws on an unknown explicit variant rather than silently falling back', () => {
    assert.throws(() => resolveVariant({}, { variant: 'nope' }), /unknown rail variant 'nope'/);
  });
  it('productType sealed wins over language', () => {
    assert.equal(resolveVariant({ productType: 'sealed', language: 'Japanese' }), 'sealed');
  });
  it('japanese by language, case and abbreviation insensitive', () => {
    assert.equal(resolveVariant({ language: 'Japanese' }), 'japanese');
    assert.equal(resolveVariant({ language: '  JAPANESE ' }), 'japanese');
    assert.equal(resolveVariant({ language: 'jp' }), 'japanese');
  });
  it('falls back to default', () => {
    assert.equal(resolveVariant({ language: 'English' }), 'default');
    assert.equal(resolveVariant({}), 'default');
  });
  it('config variantOverrides point a new token at existing art without a code change', () => {
    const cfg = { ...DEFAULT_CONFIG, variantOverrides: { korean: 'japanese' } };
    assert.equal(resolveVariant({ language: 'Korean' }, {}, cfg), 'japanese');
  });
  it('ignores an override naming art that does not exist', () => {
    const cfg = { ...DEFAULT_CONFIG, variantOverrides: { korean: 'ghost' } };
    assert.equal(resolveVariant({ language: 'Korean' }, {}, cfg), 'default');
  });
});

describe('resolveLayout', () => {
  it('the geometry invariant holds: 2 rails + 2 side paddings + card box === canvas', () => {
    for (const productType of Object.keys(PROFILES)) {
      const l = resolveLayout(DEFAULT_CONFIG, { productType });
      assert.equal(l.railWidth * 2 + l.cardPaddingX * 2 + l.cardBox.width, l.canvas, `${productType} geometry does not close`);
      assert.equal(l.cardPaddingY * 2 + l.cardBox.height, l.canvas, `${productType} padding does not close`);
    }
  });
  it('defaults are the specced 1600 canvas / 300 rails, minus the side mat', () => {
    const l = resolveLayout(DEFAULT_CONFIG, { productType: 'single' });
    assert.equal(l.canvas, 1600);
    assert.equal(l.railWidth, 300);
    assert.equal(l.cardPaddingX, 48);
    assert.deepEqual({ ...l.cardBox }, { width: 904, height: 1408 });   // 1600 − 2×300 − 2×48
  });
  it('the sealed profile widens the card column (landscape boxes float otherwise)', () => {
    const l = resolveLayout(DEFAULT_CONFIG, { productType: 'sealed' });
    assert.equal(l.railWidth, 220);
    const single = resolveLayout(DEFAULT_CONFIG, { productType: 'single' });
    assert.ok(l.cardBox.width > single.cardBox.width && l.cardBox.height > single.cardBox.height);
  });
  it('the side mat cannot be squeezed out by a wide rail without failing loudly', () => {
    assert.throws(() => resolveLayout(DEFAULT_CONFIG, {}, { railWidth: 760, cardPaddingX: 48 }), /rails leave no room/);
  });
  it('unknown productType falls back to the base layout, it does not throw', () => {
    assert.deepEqual({ ...resolveLayout(DEFAULT_CONFIG, { productType: 'wat' }).cardBox }, { width: 904, height: 1408 });
  });
  it('config overrides beat profiles, per-call options beat config', () => {
    const cfg = { ...DEFAULT_CONFIG, layoutOverrides: { railWidth: 260 } };
    assert.equal(resolveLayout(cfg, { productType: 'sealed' }).railWidth, 260);
    assert.equal(resolveLayout(cfg, { productType: 'sealed' }, { railWidth: 100 }).railWidth, 100);
  });
  it('only whitelisted keys get through — an unknown key cannot reach the layout', () => {
    const cfg = { ...DEFAULT_CONFIG, layoutOverrides: { railWidth: 260, evil: 'yes', canvas: 1600 } };
    assert.equal(resolveLayout(cfg, {}).evil, undefined);
  });
  it('canvasSize is the documented public alias for canvas', () => {
    assert.equal(resolveLayout(DEFAULT_CONFIG, {}, { canvasSize: 800, railWidth: 150 }).canvas, 800);
  });
  it('returns a frozen object so nothing downstream can mutate shared geometry', () => {
    const l = resolveLayout(DEFAULT_CONFIG, {});
    assert.ok(Object.isFrozen(l) && Object.isFrozen(l.text) && Object.isFrozen(l.cardBox));
  });
});

describe('validateLayout', () => {
  const base = () => JSON.parse(JSON.stringify({ ...DEFAULT_LAYOUT, text: { ...DEFAULT_LAYOUT.text } }));
  it('rejects rails that leave no room for the card', () => {
    assert.throws(() => validateLayout({ ...base(), railWidth: 790 }), /rails leave no room/);
  });
  it('rejects padding that leaves no room for the card', () => {
    assert.throws(() => validateLayout({ ...base(), cardPaddingY: 790 }), /padding leaves no room/);
  });
  it('rejects non-integer geometry', () => {
    assert.throws(() => validateLayout({ ...base(), railWidth: 300.5 }), /railWidth must be/);
    assert.throws(() => validateLayout({ ...base(), canvas: '1600' }), /canvas must be/);
  });
  it('rejects out-of-range quality, threshold and text settings', () => {
    assert.throws(() => validateLayout({ ...base(), quality: 0 }), /quality must be/);
    assert.throws(() => validateLayout({ ...base(), quality: 101 }), /quality must be/);
    assert.throws(() => validateLayout({ ...base(), trimThreshold: 300 }), /trimThreshold must be/);
    assert.throws(() => validateLayout({ ...base(), trimMinAreaRatio: 0 }), /trimMinAreaRatio must be/);
    const bad = base(); bad.text.rail = 'middle';
    assert.throws(() => validateLayout(bad), /text.rail must be/);
    const spin = base(); spin.text.rotate = 45;
    assert.throws(() => validateLayout(spin), /text.rotate must be/);
  });
  it('resolveLayout runs the validator, so a bad config fails at the point of use', () => {
    assert.throws(() => resolveLayout({ ...DEFAULT_CONFIG, layoutOverrides: { railWidth: 800 } }, {}), /rails leave no room/);
  });
});

describe('railText', () => {
  const L = resolveLayout(DEFAULT_CONFIG, {});
  it('is the set name alone for English — the store default needs no announcing', () => {
    assert.deepEqual(railText({ language: 'English', setName: 'Pitch Black' }, L), ['PITCH BLACK']);
    assert.deepEqual(railText({ language: 'EN', setName: 'Pitch Black' }, L), ['PITCH BLACK']);
    assert.deepEqual(railText({ setName: 'Pitch Black' }, L), ['PITCH BLACK']);
  });
  it('prefixes the language when it is NOT English — that changes what the card is worth', () => {
    assert.deepEqual(railText({ language: 'Japanese', setName: 'Mega Symphonia' }, L), ['JAPANESE · MEGA SYMPHONIA']);
    assert.deepEqual(railText({ language: 'Korean', setName: 'Base Set' }, L), ['KOREAN · BASE SET']);
  });
  it('drops missing fields rather than leaving a dangling separator', () => {
    assert.deepEqual(railText({ setName: 'Base Set' }, L), ['BASE SET']);
    assert.deepEqual(railText({ language: 'English' }, L), [], 'English alone is nothing worth printing');
    assert.deepEqual(railText({ language: 'Japanese' }, L), ['JAPANESE']);
    assert.deepEqual(railText({}, L), []);
  });
  it('CONDITION never reaches the rail — it would split every NM/LP pair into two eBay uploads', () => {
    const a = railText({ language: 'English', setName: 'Base Set', condition: 'Near Mint' }, L);
    const b = railText({ language: 'English', setName: 'Base Set', condition: 'Lightly Played' }, L);
    assert.deepEqual(a, b);
  });
  it('truncates the SET and never the language', () => {
    const [line] = railText({ language: 'Japanese', setName: 'Some Extremely Long Set Name That Will Never Fit' }, L);
    assert.ok(line.startsWith('JAPANESE · '), 'language must survive intact');
    assert.ok(line.endsWith('…'));
    assert.ok(line.length <= L.text.maxChars + 1);
  });
  it('drops the set entirely when there is no room to abbreviate it usefully', () => {
    const tight = resolveLayout(DEFAULT_CONFIG, {}, { text: { maxChars: 14 } });
    assert.deepEqual(railText({ language: 'Japanese', setName: 'Mega Symphonia' }, tight), ['JAPANESE']);
  });
  it('text.rail none means no line at all', () => {
    const off = resolveLayout(DEFAULT_CONFIG, {}, { text: { rail: 'none' } });
    assert.deepEqual(railText({ language: 'English', setName: 'Base Set' }, off), []);
  });
});

describe('composeHash', () => {
  const L = resolveLayout(DEFAULT_CONFIG, {});
  const H = (over = {}) => composeHash({ sourceBytes: BYTES, layout: L, variant: 'default', textLines: ['ENGLISH · BASE SET'], assetDigest: 'aaaa', ...over });

  it('is stable for identical inputs', () => {
    assert.equal(H(), H());
  });
  it('splits on the rendered text — the NM/LP collision the naive hash would cause', () => {
    assert.notEqual(H(), H({ textLines: ['JAPANESE · MEGA SYMPHONIA'] }));
  });
  it('splits on the BADGE — two cards from one set share art but not a number', () => {
    assert.notEqual(H({ badge: '006/084|abc' }), H({ badge: '007/084|abc' }));
    assert.notEqual(H({ badge: '006/084|abc' }), H({ badge: '006/084|def' }), 'a different set symbol must re-compose');
    assert.equal(H({ badge: '006/084|abc' }), H({ badge: '006/084|abc' }));
  });
  it('splits on source bytes, variant, layout and rail art', () => {
    assert.notEqual(H(), H({ sourceBytes: Buffer.from('different scan') }));
    assert.notEqual(H(), H({ variant: 'japanese' }));
    assert.notEqual(H(), H({ layout: resolveLayout(DEFAULT_CONFIG, {}, { railWidth: 280 }) }));
    assert.notEqual(H(), H({ assetDigest: 'bbbb' }), 'swapping rail art must re-compose even without an ASSET_VERSION bump');
  });
  it('does NOT split on meta that never reaches a pixel', () => {
    // Same picture, two stock rows: one NM, one LP. These must share a single eBay upload.
    const nm = resolveLayout(DEFAULT_CONFIG, { condition: 'Near Mint', cardNumber: '004/165', rarity: 'Rare' });
    const lp = resolveLayout(DEFAULT_CONFIG, { condition: 'Lightly Played', cardNumber: '199/165', rarity: 'Secret' });
    assert.equal(H({ layout: nm }), H({ layout: lp }));
  });
  it('hashes INPUTS, not output bytes, so the key survives a different libvips build', () => {
    assert.ok(/^[0-9a-f]{64}$/.test(H()));
  });
});

describe('layoutFingerprint', () => {
  it('excludes the derived cardBox so railWidth is not double counted', () => {
    const l = resolveLayout(DEFAULT_CONFIG, {});
    assert.ok(!layoutFingerprint(l).includes('cardBox'));
  });
  it('is order independent for the same values', () => {
    assert.equal(layoutFingerprint(resolveLayout(DEFAULT_CONFIG, {})), layoutFingerprint(resolveLayout(DEFAULT_CONFIG, {})));
  });

  // Regression: the fingerprint used JSON.stringify's replacer-ARRAY form, which is a RECURSIVE
  // property allowlist rather than a key ordering. With only top-level names in the list the nested
  // `text` and `badge` blocks serialised to {}, so restyling the rail or moving the set badge
  // changed nothing in the content hash and every cached composite kept the old art.
  it('INCLUDES the nested text block', () => {
    const l = resolveLayout(DEFAULT_CONFIG, {});
    const fp = layoutFingerprint(l);
    assert.ok(fp.includes('"railInset"'), 'text.railInset missing from the fingerprint');
    assert.ok(fp.includes('"maxChars"'), 'text.maxChars missing from the fingerprint');
  });
  it('INCLUDES the nested badge block', () => {
    const fp = layoutFingerprint(resolveLayout(DEFAULT_CONFIG, {}));
    assert.ok(fp.includes('"symbolFraction"'), 'badge.symbolFraction missing from the fingerprint');
    assert.ok(fp.includes('"marginBottom"'), 'badge.marginBottom missing from the fingerprint');
  });
  it('changes when a nested value changes — the whole point of the thing', () => {
    const base = resolveLayout(DEFAULT_CONFIG, {});
    for (const over of [
      { text: { fill: 0.9 } },
      { text: { color: '#ff0000' } },
      { text: { rotate: 270 } },
      { badge: { symbolFraction: 0.8 } },
      { badge: { marginBottom: 300 } },
      { badge: { rail: 'none' } },
    ]) {
      const changed = resolveLayout(DEFAULT_CONFIG, {}, over);
      assert.notEqual(layoutFingerprint(base), layoutFingerprint(changed), `${JSON.stringify(over)} did not move the fingerprint`);
    }
  });
  it('is stable across key insertion order', () => {
    const a = layoutFingerprint({ b: 2, a: 1, n: { y: 2, x: 1 } });
    const b = layoutFingerprint({ a: 1, b: 2, n: { x: 1, y: 2 } });
    assert.equal(a, b);
  });
  it('handles arrays, null and undefined without throwing', () => {
    assert.doesNotThrow(() => layoutFingerprint({ a: [1, 2, { z: null }], b: null, c: undefined }));
  });
});

describe('composeVersion', () => {
  it('is the human-answerable "which art is this listing on" token', () => {
    assert.equal(composeVersion('japanese', 'f08bad8512345678'), `${ASSET_VERSION}/japanese/f08bad85`);
    assert.equal(composeVersion('default'), `${ASSET_VERSION}/default`);
  });
});

describe('module invariants', () => {
  it('canvas default is 1600 (eBay gallery square)', () => assert.equal(CANVAS, 1600));
  it('every profile names only known layout keys', () => {
    for (const [name, p] of Object.entries(PROFILES)) {
      for (const k of Object.keys(p)) assert.ok(k in DEFAULT_LAYOUT, `profile ${name} sets unknown key ${k}`);
    }
  });
  it('ships disabled — turning this on is an explicit act', () => {
    assert.equal(DEFAULT_CONFIG.enabled, false);
  });
  it('the default variant is in the registry', () => assert.ok(VARIANTS.includes('default')));
});
