// test/unit/listing-image-names.test.mjs — alt text, filenames, the ordered image set.
// Pure: no sharp, so this NEVER skips. Alt text is the transport for the attributes an agent
// surface cannot filter on, so it is the one part of the image pipeline that has to work on every
// host regardless of whether anything can actually be rendered there.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { altTextFor, imageFilename, sanitiseSkuToken, buildImageSet, VALUE_CLAIM_RE } from '../../lib/listing-image-names.mjs';
import { composeMetaFor } from '../../lib/listings.mjs';

const single = { productType: 'single', cardName: 'Iono', cardNumber: '254/182', setName: 'Paldea Evolved', language: 'English' };

describe('altTextFor', () => {
  it('raw single: name, number, set, language, condition', () => {
    assert.equal(altTextFor({ condition: 'Near Mint' }, single),
      'Iono 254/182 — Paldea Evolved (English), Near Mint');
  });

  it('slab: grade and cert instead of condition', () => {
    assert.equal(
      altTextFor({ grading_company: 'PSA', grade: 10, cert_number: '84512203' }, { ...single, productType: 'slab' }),
      'Iono 254/182 — Paldea Evolved (English), PSA 10, cert 84512203');
  });

  it('sealed: the product title, and the word sealed', () => {
    assert.equal(
      altTextFor({ name: 'Paldea Evolved Booster Box' }, { productType: 'sealed', setName: 'Paldea Evolved', language: 'English' }),
      'Paldea Evolved Booster Box — Paldea Evolved (English), sealed');
  });

  it('a half grade keeps its decimal, a whole grade gains no .0', () => {
    assert.match(altTextFor({ grading_company: 'BGS', grade: 9.5 }, { ...single, productType: 'slab' }), /BGS 9\.5/);
    assert.match(altTextFor({ grading_company: 'PSA', grade: 10 }, { ...single, productType: 'slab' }), /PSA 10(?!\.)/);
  });

  it('DROPS every missing field rather than stringifying it', () => {
    // Each of these is genuinely absent on some real row.
    assert.equal(altTextFor({}, single), 'Iono 254/182 — Paldea Evolved (English)');
    assert.equal(altTextFor({ condition: 'Near Mint' }, { ...single, cardNumber: '' }), 'Iono — Paldea Evolved (English), Near Mint');
    assert.equal(altTextFor({ condition: 'Near Mint' }, { ...single, setName: '' }), 'Iono 254/182 — (English), Near Mint');
    assert.equal(altTextFor({ condition: 'Near Mint' }, { ...single, language: '' }), 'Iono 254/182 — Paldea Evolved, Near Mint');
    assert.equal(altTextFor({}, { productType: 'single' }), '');
    for (const s of [altTextFor({}, single), altTextFor({}, { productType: 'slab' })]) {
      assert.ok(!/undefined|null/.test(s), `"${s}" leaked a placeholder`);
      assert.ok(!/—\s*$|,\s*$|\(\)/.test(s), `"${s}" has a dangling separator`);
    }
  });

  it('caps at Shopify\'s 512 characters', () => {
    const long = altTextFor({ condition: 'Near Mint' }, { ...single, cardName: 'A'.repeat(900) });
    assert.ok(long.length <= 512);
    assert.ok(long.endsWith('…'));
  });

  it('NEVER carries a currency symbol or a value claim', () => {
    const rows = [
      [{ condition: 'Near Mint' }, single],
      [{ grading_company: 'PSA', grade: 10, cert_number: '1' }, { ...single, productType: 'slab' }],
      [{ name: 'Mystery Bundle' }, { productType: 'sealed', setName: 'Mixed', language: 'English' }],
    ];
    for (const [item, meta] of rows) {
      const s = altTextFor(item, meta);
      assert.ok(!VALUE_CLAIM_RE.test(s), `alt text made a value claim: "${s}"`);
    }
  });

  it('works off a real composeMetaFor result, for every game', () => {
    const games = [
      { game: 'pokemon', name: 'Iono', set_name: 'Paldea Evolved', number: '254/182', condition: 'Near Mint' },
      { game: 'mtg', name: 'Lightning Bolt', set_name: 'Modern Horizons 3 (MH3)', number: '129', condition: 'Near Mint' },
      { game: 'lorcana', name: 'Elsa', set_name: 'Ursula\'s Return (5)', number: '42', condition: 'Near Mint' },
      { game: 'swu', name: 'Darth Vader', set_name: 'Spark of Rebellion (SOR)', number: '10', condition: 'Near Mint' },
      { game: 'onepiece', name: 'Monkey D. Luffy (055)', set_name: 'Romance Dawn (OP01)', number: 'OP01-003', condition: 'Near Mint' },
      { game: 'riftbound', name: 'Annie', set_name: 'Origins (OGN)', number: 'OGN-001', condition: 'Near Mint' },
    ];
    for (const row of games) {
      const s = altTextFor(row, composeMetaFor(row));
      assert.ok(s.includes('Near Mint'), `${row.game}: condition missing from "${s}"`);
      assert.ok(!/undefined/.test(s), `${row.game}: "${s}"`);
      assert.ok(s.length > 10, `${row.game}: "${s}" looks empty`);
    }
  });
});

describe('filenames', () => {
  it('follows {sku}-{position}-{view}.{ext}', () => {
    assert.equal(imageFilename({ sku: 'AAC-097', position: 1, view: 'front', ext: 'jpg' }), 'AAC-097-1-front.jpg');
    assert.equal(imageFilename({ sku: '84512203', position: 3, view: 'cert', ext: 'jpg' }), '84512203-3-cert.jpg');
  });

  it('sanitises the SKU — it reaches a path and a URL', () => {
    assert.equal(sanitiseSkuToken('../../.env'), 'ENV');
    assert.equal(sanitiseSkuToken('bk pkm 42'), 'BK-PKM-42');
    assert.equal(sanitiseSkuToken('  --AAC--097--  '), 'AAC-097');
    assert.equal(sanitiseSkuToken('日本語'), '');
    assert.ok(!sanitiseSkuToken('a/b\\c..d').includes('/'));
    assert.ok(sanitiseSkuToken('X'.repeat(200)).length <= 64);
  });

  it('drops the position for images outside the gallery strip', () => {
    // The social card has no position; numbering it 1 would collide with the front of the card.
    assert.equal(imageFilename({ sku: 'AAC-097', view: 'og', ext: 'jpg' }), 'AAC-097-og.jpg');
    assert.equal(imageFilename({ sku: 'AAC-097', position: 0, view: 'og', ext: 'jpg' }), 'AAC-097-og.jpg');
  });

  it('never produces an empty or dotted name', () => {
    const f = imageFilename({ sku: '', position: 1, view: '', ext: '' });
    assert.equal(f, 'ITEM-1-image.jpg');
    assert.ok(!f.includes('..'));
  });
});

describe('buildImageSet', () => {
  const res = (hash, extra = {}) => ({ contentHash: hash, composeVersion: 'v1/default/aaaa/shopify-card', width: 1512, height: 2112, ext: 'jpg', buffer: Buffer.alloc(10), ...extra });
  const urlFor = (h, e) => `/api/listing-image/file/${h}.${e}`;

  it('numbers the gallery in the spec order, whatever order it was handed', () => {
    const set = buildImageSet({
      item: { condition: 'Near Mint' }, meta: single, sku: 'AAC-097', urlFor,
      rendered: [
        { view: 'branded', target: 'ebay-square', result: res('d') },
        { view: 'back', target: 'shopify-card', result: res('b') },
        { view: 'front', target: 'shopify-card', result: res('a') },
        { view: 'corners', target: 'shopify-card', result: res('c') },
      ],
    });
    assert.deepEqual(set.images.map((i) => i.view), ['front', 'back', 'corners', 'branded']);
    assert.deepEqual(set.images.map((i) => i.position), [1, 2, 3, 4]);
    assert.equal(set.images[0].filename, 'AAC-097-1-front.jpg');
    assert.equal(set.images[0].url, '/api/listing-image/file/a.jpg');
  });

  it('THROWS if the branded composite would land at position 1', () => {
    assert.throws(() => buildImageSet({
      item: {}, meta: single, sku: 'AAC-097',
      rendered: [{ view: 'branded', target: 'ebay-square', result: res('d') }],
    }), /cannot be position 1/);
  });

  it('the social card is not a gallery image', () => {
    const set = buildImageSet({
      item: {}, meta: single, sku: 'AAC-097', urlFor,
      rendered: [
        { view: 'front', target: 'shopify-card', result: res('a') },
        { view: 'og', target: 'og-card', result: res('z', { width: 1200, height: 630 }) },
      ],
    });
    assert.equal(set.images.length, 1);
    assert.equal(set.social.contentHash, 'z');
    assert.ok(!set.images.some((i) => i.view === 'og'));
  });

  it('the filename extension comes from what was RENDERED, not from the product type', () => {
    const set = buildImageSet({
      item: {}, meta: single, sku: 'AAC-097',
      rendered: [{ view: 'front', target: 'shopify-card', result: res('a', { ext: 'png' }) }],
    });
    assert.equal(set.images[0].filename, 'AAC-097-1-front.png');
  });

  it('surfaces a review flag on the set, so a batch can be filtered', () => {
    const set = buildImageSet({
      item: {}, meta: single, sku: 'AAC-097',
      rendered: [{ view: 'front', target: 'shopify-card', result: res('a', { review: { reason: 'aspect-far-from-card' } }) }],
    });
    assert.equal(set.needsReview, true);
    assert.equal(set.images[0].review.reason, 'aspect-far-from-card');
  });

  it('every image carries the same alt text — it describes the item, not the crop', () => {
    const set = buildImageSet({
      item: { condition: 'Near Mint' }, meta: single, sku: 'AAC-097',
      rendered: [
        { view: 'front', target: 'shopify-card', result: res('a') },
        { view: 'back', target: 'shopify-card', result: res('b') },
      ],
    });
    assert.equal(set.images[0].alt, set.images[1].alt);
    assert.equal(set.alt, 'Iono 254/182 — Paldea Evolved (English), Near Mint');
  });
});
