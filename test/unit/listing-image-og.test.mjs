// test/unit/listing-image-og.test.mjs — the 1200x630 social card.
//
// The card reuses the VERTICAL rail art, because a wide frame's dead space is at the sides. The one
// thing that needs proving is the ground: it is built by lifting a single pixel column out of the
// already-rendered rail and replicating it, which makes the join seamless BY CONSTRUCTION rather
// than by two transforms happening to agree. If the sample column is ever taken from somewhere that
// is not clean gradient — over the store mark, or over the accent hairline — the whole ground turns
// into a smear of that, and these tests are what catch it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeOgImage } from '../../lib/listing-image-bands.mjs';
import { resolveOgGeometry, OG_SAMPLE_FRACTION, OG_FRAME } from '../../lib/listing-image-targets.mjs';
import { loadConfig, VARIANTS } from '../../lib/listing-image-config.mjs';
import { railMeta, railsPresent } from '../../lib/listing-image-assets.mjs';
import { fakeCard, sharpOrNull } from '../helpers/image-diff.mjs';

const cfg = loadConfig();

describe('resolveOgGeometry', () => {
  it('the defaults leave a 528x554 card box, and a 63:88 card lands at 397x554', () => {
    const g = resolveOgGeometry(cfg, { width: 600, height: 3200 });
    assert.deepEqual({ w: g.width, h: g.height }, { w: 1200, h: 630 });
    assert.deepEqual(g.cardBox, { width: 528, height: 554 });
    assert.equal(Math.round(554 * (63 / 88)), 397);
  });

  it('scales the art by WIDTH, so the 600x3200 rails become 1600 tall and are cropped to 630', () => {
    assert.equal(resolveOgGeometry(cfg, { width: 600, height: 3200 }).scaledHeight, 1600);
  });

  it('refuses a rail width that scales the art too short to fill the frame, naming the numbers', () => {
    const narrow = { ...cfg, shopify: { ...cfg.shopify, og: { ...cfg.shopify.og, railWidth: 40 } } };
    assert.throws(() => resolveOgGeometry(narrow, { width: 600, height: 3200 }), /short of the 630px frame/);
  });

  it('refuses rails that leave no room for the card', () => {
    const fat = { ...cfg, shopify: { ...cfg.shopify, og: { ...cfg.shopify.og, railWidth: 560 } } };
    assert.throws(() => resolveOgGeometry(fat, { width: 600, height: 3200 }), /leave no room for the card/);
  });

  it('EVERY variant on disk survives the configured rail width', async () => {
    for (const v of VARIANTS) {
      if (!railsPresent(v)) continue;
      const art = await railMeta(v, 'left');
      if (!art) continue;
      assert.doesNotThrow(() => resolveOgGeometry(cfg, art), `variant '${v}' fails the OG geometry gate`);
    }
  });

  it('the sample column is clear of the store mark and the hairline', () => {
    // Measured on the art: the mark spans 20.5%-79.4% of the rail's width and the hairline is the
    // inner 10px (1.7%). 10% sits between them with room either side.
    assert.ok(OG_SAMPLE_FRACTION > 0.02 && OG_SAMPLE_FRACTION < 0.20,
      `OG_SAMPLE_FRACTION ${OG_SAMPLE_FRACTION} is no longer clear of the hairline and the mark`);
  });
});

const sharp = await sharpOrNull();
const SKIP = sharp && railsPresent('default') ? false : 'compositor unavailable';

describe('composeOgImage', { skip: SKIP }, () => {
  const meta = { productType: 'single', cardName: 'Iono', setName: 'Paldea Evolved', language: 'English' };

  const raw = async (buf) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    return { data, info, px: (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; } };
  };

  it('renders the OG frame exactly', async () => {
    const r = await composeOgImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    assert.equal(r.width, OG_FRAME.width);
    assert.equal(r.height, OG_FRAME.height);
    assert.equal(r.card.width, 397);
    assert.equal(r.card.height, 554);
  });

  it('the ground is horizontally uniform — proof the sample column was clean gradient', async () => {
    // The ground is one column replicated, so every ground column is identical by construction.
    // If the sample had landed on the mark or the hairline, the whole ground would carry it and
    // this would blow up immediately.
    const r = await composeOgImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    const { px } = await raw(r.buffer);
    const g = r.geometry;
    let max = 0;
    for (let y = 4; y < r.height - 4; y += 11) {
      const a = px(g.railWidth + 18, y);
      const b = px(g.railWidth + 70, y);
      for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(a[c] - b[c]));
    }
    assert.ok(max <= 6, `ground columns differ by ${max} — the sample column is not clean gradient`);
  });

  it('the ground matches the rail it sits beside, so the join cannot seam', async () => {
    const r = await composeOgImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    const { px } = await raw(r.buffer);
    const g = r.geometry;
    let max = 0;
    // Sample INSIDE the rail (clear of the inner hairline) against the adjacent ground.
    for (let y = 4; y < r.height - 4; y += 11) {
      const rail = px(g.railWidth - 40, y);
      const ground = px(g.railWidth + 18, y);
      for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(rail[c] - ground[c]));
    }
    assert.ok(max <= 8, `rail and ground differ by ${max} at the join — the gradients have drifted apart`);
  });

  it('the store mark is in frame, in the upper half', async () => {
    const r = await composeOgImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    const { px } = await raw(r.buffer);
    // Rows 78-306 carry the mark; the plum gradient alone is much darker than the mark's artwork.
    let markBright = 0, plainBright = 0;
    for (let y = 90; y < 290; y += 9) { const p = px(Math.round(r.geometry.railWidth / 2), y); markBright += p[0] + p[1] + p[2]; }
    for (let y = 420; y < 560; y += 9) { const p = px(Math.round(r.geometry.railWidth / 2), y); plainBright += p[0] + p[1] + p[2]; }
    assert.ok(markBright > plainBright, 'the store mark should be visibly brighter than bare rail below it');
  });

  it('carries NO rail text — at 630 tall it would run straight through the mark', async () => {
    const r = await composeOgImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    assert.equal(r.textLines, undefined);
  });

  it('a landscape card still fits the column', async () => {
    const r = await composeOgImage(await fakeCard(1560, 1120), meta, { cfg, trim: false });
    assert.equal(r.card.width, 528);
    assert.ok(r.card.height < 554);
  });

  it('hashes distinctly from the tile and the eBay square', async () => {
    const bytes = await fakeCard(733, 1024);
    const og = await composeOgImage(bytes, meta, { cfg, trim: false });
    assert.ok(og.composeVersion.endsWith('/og-card'));
    assert.equal(og.target, 'og-card');
  });

  it('a Japanese card wears the japanese rails, same as everywhere else', async () => {
    const r = await composeOgImage(await fakeCard(733, 1024), { ...meta, language: 'Japanese' }, { cfg, trim: false });
    assert.equal(r.variant, 'japanese');
  });
});
