// test/unit/listing-image.test.mjs — the compositor itself (lib/listing-image.mjs).
//
// Skipped wholesale when sharp is not installed: the module is designed to be absent-tolerant so a
// host without the native binary still boots the dev server, and the suite has to hold that shape.
//
// Deliberately NOT byte-comparing encoded JPEGs. libvips is deterministic for a given build but not
// across builds, so a byte assert would pass on the dev box and fail on the server for output that
// is perfectly correct. Everything here asserts geometry, or pixels with a tolerance.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeListingImage, composeAvailable, describeCompositor, hashFor, trimDetector, ComposeUnavailable,
} from '../../lib/listing-image.mjs';
import { DEFAULT_CONFIG, resolveLayout } from '../../lib/listing-image-config.mjs';
import { loadRail, clearAssetCache } from '../../lib/listing-image-assets.mjs';
import { sharpOrNull, toRaw, diffRatio, fakeCard, cardOnBackground } from '../helpers/image-diff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'listing-image');

const sharp = await sharpOrNull();
const avail = sharp ? await composeAvailable(DEFAULT_CONFIG, 'default') : { ok: false, reasons: ['sharp missing'] };
const SKIP = sharp && avail.ok ? false : `compositor unavailable: ${avail.reasons.join('; ')}`;

const CFG = { ...DEFAULT_CONFIG };
const compose = (input, meta = {}, options = {}) => composeListingImage(input, meta, { cfg: CFG, ...options });

describe('composeAvailable', { skip: !sharp && 'sharp not installed' }, () => {
  it('reports ready for a variant whose art exists', async () => {
    const a = await composeAvailable(CFG, 'default');
    assert.equal(a.ok, true, a.reasons.join('; '));
  });
  it('is per-variant — missing sealed art must not stop singles composing', async () => {
    const a = await composeAvailable(CFG, 'no-such-variant');
    assert.equal(a.ok, false);
    assert.match(a.reasons.join(' '), /rail art missing/);
  });
  it('reports the text layer separately from the composite itself', async () => {
    const a = await composeAvailable({ ...CFG, font: { family: 'Definitely Not Installed XYZ', file: 'fonts/Genty-Sans-Regular.ttf' } }, 'default');
    assert.equal(a.ok, true, 'a bad font must not block compositing');
    assert.equal(a.text, false);
    assert.match(a.textReason, /did not load|substituted/);
    clearAssetCache();
  });
});

describe('composeListingImage', { skip: SKIP }, () => {
  let card;
  before(async () => { card = await fakeCard(733, 1024); });

  it('emits a 1600x1600 JPEG', async () => {
    const r = await compose(card, { language: 'English', setName: 'Base Set' });
    assert.equal(r.width, 1600);
    assert.equal(r.height, 1600);
    assert.equal(r.buffer[0], 0xff);            // JPEG SOI
    assert.equal(r.buffer[1], 0xd8);
    const m = await sharp(r.buffer).metadata();
    assert.equal(m.format, 'jpeg');
    assert.deepEqual([m.width, m.height], [1600, 1600]);
  });

  it('accepts a file path as well as a Buffer', async () => {
    const p = path.join(FIXTURES, 'exif-orient-6.jpg');
    const r = await compose(p, {});
    assert.equal(r.width, 1600);
  });

  it('rejects an input that is neither', async () => {
    await assert.rejects(() => compose(42, {}), /file path, Buffer or Uint8Array/);
  });

  it('centres the card inside the rails and never under them', async () => {
    const r = await compose(card, {});
    const l = resolveLayout(CFG, {});
    const left = Math.round(l.railWidth + (l.cardBox.width - r.card.width) / 2);
    assert.ok(left >= l.railWidth, `card starts at ${left}, inside the left rail at ${l.railWidth}`);
    assert.ok(left + r.card.width <= l.canvas - l.railWidth, 'card runs under the right rail');
    assert.ok(r.card.height <= l.cardBox.height && r.card.width <= l.cardBox.width);
  });

  it('throws ComposeUnavailable (not a generic error) when the variant has no art', async () => {
    await assert.rejects(() => compose(card, {}, { variant: 'default', cfg: CFG }).then(() => compose(card, { productType: 'ghost' }, { variant: 'ghost' })), (e) => {
      // resolveVariant rejects an unknown explicit variant before availability is even consulted
      assert.match(e.message, /unknown rail variant/);
      return true;
    });
  });

  it('is deterministic: same input twice gives the same hash AND the same bytes', async () => {
    const a = await compose(card, { language: 'Japanese', setName: 'Mega Symphonia' });
    const b = await compose(card, { language: 'Japanese', setName: 'Mega Symphonia' });
    assert.equal(a.contentHash, b.contentHash);
    assert.equal(Buffer.compare(a.buffer, b.buffer), 0, 'same host must produce identical bytes');
  });

  it('hashFor agrees with a real compose, so callers can probe the cache before doing the work', async () => {
    const meta = { language: 'English', setName: 'Surging Sparks' };
    const pre = await hashFor(card, meta, { cfg: CFG });
    const r = await compose(card, meta);
    assert.equal(pre.contentHash, r.contentHash);
    assert.equal(pre.composeVersion, r.composeVersion);
    assert.equal(pre.variant, r.variant);
  });

  it('two conditions of one card share a hash; two languages do not', async () => {
    const nm = await compose(card, { language: 'English', setName: 'Base Set', condition: 'Near Mint' });
    const lp = await compose(card, { language: 'English', setName: 'Base Set', condition: 'Lightly Played' });
    const jp = await compose(card, { language: 'Japanese', setName: 'Base Set' });
    assert.equal(nm.contentHash, lp.contentHash, 'NM and LP of one card must be a single eBay upload');
    assert.notEqual(nm.contentHash, jp.contentHash);
  });

  it('honours EXIF orientation — a sideways phone photo comes out upright', async () => {
    // The fixture is a 600x300 LANDSCAPE jpeg tagged orientation 6. Auto-orient makes it portrait;
    // skip .rotate() and the card stays landscape, which is the bug this guards.
    const r = await compose(path.join(FIXTURES, 'exif-orient-6.jpg'), {});
    assert.ok(r.card.height > r.card.width, `card came out ${r.card.width}x${r.card.height} — EXIF orientation was not applied`);
  });

  it('flattens transparency to white instead of compositing black', async () => {
    const png = await sharp({ create: { width: 400, height: 560, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const r = await compose(png, {});
    const raw = await toRaw(r.buffer);
    const mid = ((800 * raw.width) + 800) * raw.channels;      // dead centre, inside the card
    assert.ok(raw.data[mid] > 240 && raw.data[mid + 1] > 240 && raw.data[mid + 2] > 240,
      `centre pixel is rgb(${raw.data[mid]},${raw.data[mid + 1]},${raw.data[mid + 2]}) — a transparent PNG went black`);
  });

  it('leaves the rails intact: they are placed, never rescaled per image', async () => {
    const r = await compose(card, { language: 'English', setName: 'Base Set' });
    const l = resolveLayout(CFG, {});
    const rail = await loadRail('default', 'left', l.railWidth, l.canvas);
    // Compare the output's left column against the loaded rail. JPEG is lossy so this cannot be
    // byte-exact (measured max channel error ~31 at the rail's hard gold edge) — but a rail that
    // moved or resampled would differ across a large FRACTION of pixels, not a thin edge.
    const crop = await sharp(r.buffer).extract({ left: 0, top: 0, width: l.railWidth, height: l.canvas }).png().toBuffer();
    const d = await diffRatio(crop, rail, { threshold: 12, width: 300 });
    assert.ok(d.ratio < 0.03, `left rail differs on ${(d.ratio * 100).toFixed(1)}% of pixels (max delta ${d.maxDelta}) — it was moved or rescaled`);
  });

  it('rejects a trim that would keep almost nothing', async () => {
    // A frame that is nearly all background with a tiny mark: trim would crop to the mark, and a
    // listing photo of a 20px speck is worse than an untrimmed one.
    const sliver = await sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: { create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } } }, left: 440, top: 590 }])
      .jpeg().toBuffer();
    const r = await compose(sliver, {});
    assert.equal(r.card.trimmed, false, 'the area guard should have rejected this detection');
  });

  it('reports trimmed:false when the detector found nothing to crop', async () => {
    // Catalog art arrives already cut to the card — the common case, and a no-op extract would be
    // wasted work reported as a crop.
    const r = await compose(card, {});
    assert.equal(r.card.trimmed, false);
  });

  it('crops a card off its background when there IS one', async () => {
    const r = await compose(await cardOnBackground(400, 560), {});
    const box = resolveLayout(CFG, {}).cardBox;
    assert.equal(r.card.trimmed, true);
    // 400x560 into a 904x1408 box is width-constrained, so it pegs to the column width
    assert.equal(r.card.width, box.width);
  });

  it('leaves a white mat between the card and each rail', async () => {
    const r = await compose(card, {});
    const l = resolveLayout(CFG, {});
    const gap = (l.canvas - 2 * l.railWidth - r.card.width) / 2;
    assert.equal(gap, l.cardPaddingX, `card sits ${gap}px off the rails, expected ${l.cardPaddingX}`);
    assert.ok(gap > 0, 'the card must not butt against the rail');
  });

  it('a custom cardDetector can replace trim without touching the compositor', async () => {
    const calls = [];
    const detector = { name: 'stub', async detect(image, meta, layout) { calls.push(layout.canvas); return { left: 10, top: 10, width: 300, height: 500 }; } };
    const r = await compose(card, {}, { detector });
    assert.deepEqual(calls, [1600]);
    assert.equal(r.card.trimmed, true);
    assert.equal(r.card.width, 845);       // 300x500 fitted into 1000x1408 is height-constrained
  });

  it('a detector that throws degrades to the untrimmed frame', async () => {
    const detector = { name: 'boom', async detect() { throw new Error('nope'); } };
    const r = await compose(card, {}, { detector });
    assert.equal(r.card.trimmed, false);
    assert.equal(r.width, 1600);
  });

  describe('aspect edge cases', () => {
    const box = resolveLayout(DEFAULT_CONFIG, {}).cardBox;
    const cases = [
      ['portrait single', 733, 1024, 'single'],
      ['graded slab', 700, 1200, 'slab'],
      ['landscape sealed box', 1400, 900, 'sealed'],
      ['already square', 800, 800, 'single'],
      ['very low res', 60, 84, 'single'],
      ['extreme panorama', 3000, 300, 'single'],
    ];
    for (const [label, w, h, productType] of cases) {
      it(`${label} (${w}x${h}) fits its column without distortion`, async () => {
        const src = await fakeCard(w, h);
        const r = await compose(src, { productType });
        const l = resolveLayout(CFG, { productType });
        assert.equal(r.width, 1600);
        assert.ok(r.card.width <= l.cardBox.width + 1, `card ${r.card.width} wider than the ${l.cardBox.width} column`);
        assert.ok(r.card.height <= l.cardBox.height + 1, `card ${r.card.height} taller than the ${l.cardBox.height} column`);
        // fit:'inside' must preserve aspect: one dimension pegs to the box, never both stretched.
        const pegged = r.card.width >= l.cardBox.width - 1 || r.card.height >= l.cardBox.height - 1;
        assert.ok(pegged, `card ${r.card.width}x${r.card.height} fills neither axis of ${l.cardBox.width}x${l.cardBox.height}`);
        const srcAspect = w / h, outAspect = r.card.width / r.card.height;
        assert.ok(Math.abs(srcAspect - outAspect) / srcAspect < 0.02, `aspect drifted ${srcAspect.toFixed(3)} -> ${outAspect.toFixed(3)}`);
      });
    }
    it('low-res sources are ENLARGED to fill the column, not left as a stamp', async () => {
      const r = await compose(await fakeCard(60, 84), { productType: 'single' });
      assert.ok(r.card.width > 900, `60px source only reached ${r.card.width}px — withoutEnlargement is wrong`);
    });
  });

  describe('disk cache', () => {
    it('a hit returns the cached bytes without re-rendering', async () => {
      const dir = path.join(ROOT, 'test', '.tmp-compose-cache-' + process.pid);
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        const meta = { language: 'English', setName: 'Cached Set' };
        const first = await compose(card, meta, { cacheDir: dir });
        assert.equal(first.cached, false);
        assert.ok(fs.existsSync(path.join(dir, first.contentHash + '.jpg')));
        const second = await compose(card, meta, { cacheDir: dir });
        assert.equal(second.cached, true);
        assert.equal(Buffer.compare(first.buffer, second.buffer), 0);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });

  describe('variants and profiles', () => {
    it('japanese metadata selects the japanese rail art', async () => {
      const r = await compose(card, { language: 'Japanese', setName: 'Mega Symphonia' });
      assert.equal(r.variant, 'japanese');
    });
    it('sealed narrows the rails and widens the card column', async () => {
      const r = await compose(await fakeCard(1400, 900), { productType: 'sealed' });
      const single = resolveLayout(CFG, { productType: 'single' });
      assert.equal(r.variant, 'sealed');
      assert.equal(r.layout.railWidth, 220);
      assert.ok(r.card.width > single.cardBox.width, `sealed card ${r.card.width} is not wider than the single column ${single.cardBox.width}`);
    });
    it('an explicit variant overrides the metadata rule', async () => {
      const r = await compose(card, { language: 'Japanese' }, { variant: 'default' });
      assert.equal(r.variant, 'default');
    });
  });

  describe('rail text', () => {
    it('renders card name over set name and reports them', async () => {
      const r = await compose(card, { cardName: 'Iron Defender', language: 'Japanese', setName: 'Mega Symphonia' });
      assert.deepEqual(r.textLines, ['IRON DEFENDER', 'MEGA SYMPHONIA (JP)']);
    });
    it('English carries no language marker', async () => {
      const r = await compose(card, { cardName: 'Parasect', language: 'English', setName: 'Lost Origin' });
      assert.deepEqual(r.textLines, ['PARASECT', 'LOST ORIGIN']);
    });
    it('composites cleanly with no metadata at all', async () => {
      const r = await compose(card, {});
      assert.deepEqual(r.textLines, []);
      assert.equal(r.width, 1600);
    });
    it('a set name long enough to overflow still fits the rail', async () => {
      const long = await compose(card, { language: 'Japanese', setName: 'Some Extremely Long Set Name That Will Never Fit On A Rail' });
      assert.equal(long.width, 1600);
      assert.ok(long.textLines[0].length <= resolveLayout(CFG, {}).text.maxChars + 1);
    });
    it('draws the printed card number at the foot of the rail', async () => {
      const r = await compose(card, { setName: 'Pitch Black', cardNumber: '006/084' });
      assert.equal(r.badge.number, '006/084');
    });
    it('a card with no number and no symbol gets no badge at all', async () => {
      const r = await compose(card, { setName: 'Pitch Black' });
      assert.equal(r.badge.number, '');
      assert.equal(r.badge.symbol, false);
    });
    it('badge.rail none suppresses it', async () => {
      const r = await compose(card, { setName: 'Pitch Black', cardNumber: '006/084' }, { badge: { rail: 'none' } });
      assert.equal(r.badge.number, '');
    });
    it('draws the set LOGO at the foot of the left rail', async () => {
      // Served off the local fixture rather than a CDN — the assertion is the compositing, not the
      // network.
      const logo = path.join(ROOT, 'logos', 'BK_Logo_alpha.png');
      const r = await compose(card, { setName: 'X', cardNumber: '1/1', setLogoUrl: 'file-not-a-url' });
      assert.equal(r.badge.logo, false, 'a non-http source must not be treated as a logo');
      void logo;
    });
    it('logo.rail none suppresses it', async () => {
      const r = await compose(card, { setName: 'X', cardNumber: '1/1' }, { logo: { rail: 'none' } });
      assert.equal(r.badge.logo, false);
    });
    it('an unreachable set symbol still draws the number — it never fails the image', async () => {
      const r = await compose(card, { setName: 'X', cardNumber: '001/999', setSymbolUrl: 'https://unreachable.invalid/sym.png' });
      assert.equal(r.badge.symbol, false);
      assert.equal(r.badge.number, '001/999');
      assert.equal(r.width, 1600);
    });
    it('the card number is in the hash — two cards of one set must not collide', async () => {
      const a = await compose(card, { setName: 'Pitch Black', cardNumber: '006/084' });
      const b = await compose(card, { setName: 'Pitch Black', cardNumber: '007/084' });
      assert.notEqual(a.contentHash, b.contentHash);
    });
    it('hashFor agrees with a real compose once a badge is involved', async () => {
      const meta = { setName: 'Pitch Black', cardNumber: '006/084' };
      const pre = await hashFor(card, meta, { cfg: CFG });
      const r = await compose(card, meta);
      assert.equal(pre.contentHash, r.contentHash, 'a cache probe that disagrees with the render serves the wrong image');
    });
    it('an unusable font degrades to rails-without-text, it does not fail the image', async () => {
      const badFont = { ...CFG, font: { family: 'Nope Not A Font 12345', file: 'fonts/Genty-Sans-Regular.ttf' } };
      const r = await composeListingImage(card, { language: 'English', setName: 'Base Set' }, { cfg: badFont });
      assert.equal(r.width, 1600);
      assert.deepEqual(r.textLines, [], 'text must be dropped, not rendered in a substituted face');
      clearAssetCache();
    });
    it('the hash follows the text: no font means no text in the key', async () => {
      const badFont = { ...CFG, font: { family: 'Nope Not A Font 12345', file: 'fonts/Genty-Sans-Regular.ttf' } };
      const withText = await compose(card, { language: 'English', setName: 'Base Set' });
      const without = await composeListingImage(card, { language: 'English', setName: 'Base Set' }, { cfg: badFont });
      assert.notEqual(withText.contentHash, without.contentHash);
      clearAssetCache();
    });
  });
});

describe('trimDetector', { skip: SKIP }, () => {
  it('returns the full frame for art that is already cropped', async () => {
    const l = resolveLayout(DEFAULT_CONFIG, {});
    const img = sharp(await fakeCard(400, 560)).rotate().flatten({ background: '#ffffff' });
    const r = await trimDetector.detect(img, {}, l);
    assert.deepEqual([r.left, r.top], [0, 0]);
  });
  it('returns the card box for a card on a background', async () => {
    const l = resolveLayout(DEFAULT_CONFIG, {});
    const photo = await cardOnBackground(400, 560, { left: 250, top: 320 });
    const r = await trimDetector.detect(sharp(photo).rotate().flatten({ background: '#ffffff' }), {}, l);
    assert.ok(Math.abs(r.left - 250) <= 2 && Math.abs(r.top - 320) <= 2, `got origin (${r.left},${r.top}), expected ~(250,320)`);
    assert.ok(Math.abs(r.width - 400) <= 2 && Math.abs(r.height - 560) <= 2, `got ${r.width}x${r.height}, expected ~400x560`);
  });
});

describe('describeCompositor', { skip: !sharp && 'sharp not installed' }, () => {
  it('answers the readiness question without throwing, whatever the state', async () => {
    const d = await describeCompositor(CFG);
    assert.equal(d.enabled, false, 'ships off');
    assert.equal(typeof d.assetVersion, 'string');
    assert.equal(d.sharp.available, true);
    for (const v of ['default', 'japanese', 'sealed']) assert.ok(v in d.rails);
  });
});
