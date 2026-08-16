// test/unit/listing-image-bands.test.mjs — the Shopify banded frames.
//
// The band decision reversed the original spec (which said Shopify should carry no furniture at
// all), so the tests that matter are the ones proving the reversal did not cost anything:
//   · condition never reaches the image, so an NM and an LP of one card share ONE composite;
//   · a landscape card contains cleanly instead of being cropped or flagged;
//   · the bottom band's two labels cannot collide, whatever the set name.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  bandText, aspectReview, composeBandImage, bandsAvailable,
} from '../../lib/listing-image-bands.mjs';
import { resolveBandGeometry, DEFAULT_BAND_FRACTION, resolveTarget, resolveTargetFrame } from '../../lib/listing-image-targets.mjs';
import { loadConfig } from '../../lib/listing-image-config.mjs';
import { fakeCard, sharpOrNull, toRaw } from '../helpers/image-diff.mjs';

describe('bandText', () => {
  const base = { productType: 'single', cardName: 'Iono', setName: 'Paldea Evolved', cardNumber: '254/182', language: 'English' };

  it('top is the card name, bottom-left is set and printed number', () => {
    assert.deepEqual(bandText(base), { top: 'IONO', left: 'PALDEA EVOLVED · 254/182', right: '' });
  });

  it('CONDITION NEVER APPEARS — an NM and an LP of one card must share a composite', () => {
    const nm = bandText({ ...base, condition: 'Near Mint' });
    const lp = bandText({ ...base, condition: 'Lightly Played' });
    assert.deepEqual(nm, lp);
    for (const v of Object.values(nm)) assert.ok(!/MINT|PLAYED|NM|LP/.test(v), `condition leaked into "${v}"`);
  });

  it('a non-English printing gets its marker, English gets none', () => {
    assert.equal(bandText({ ...base, language: 'Japanese' }).right, 'JP');
    assert.equal(bandText({ ...base, language: 'Korean' }).right, 'KO');
    assert.equal(bandText({ ...base, language: 'English' }).right, '');
    assert.equal(bandText({ ...base, language: '' }).right, '');
  });

  it('a slab carries its grade and cert instead — it is one of one, so nothing splits', () => {
    const t = bandText({ ...base, productType: 'slab', grader: 'PSA', grade: 10, certNumber: '84512203' });
    assert.equal(t.right, 'PSA 10 · CERT 84512203');
  });

  it('a half grade keeps its decimal', () => {
    assert.equal(bandText({ ...base, productType: 'slab', grader: 'BGS', grade: 9.5 }).right, 'BGS 9.5');
  });

  it('drops what is missing rather than printing undefined', () => {
    assert.deepEqual(bandText({ productType: 'single' }), { top: '', left: '', right: '' });
    assert.equal(bandText({ ...base, cardNumber: '' }).left, 'PALDEA EVOLVED');
    assert.equal(bandText({ ...base, setName: '' }).left, '254/182');
  });

  it('drops text the bundled Latin font cannot draw, rather than gambling on a substitution', () => {
    // Pango silently falls back to a SYSTEM font for a missing glyph — perfect on the Windows dev
    // box, blank boxes on a Linux server with no CJK font, and nothing reports it.
    assert.equal(bandText({ ...base, cardName: 'スタートデッキ100' }).top, '');
    assert.equal(bandText({ ...base, cardName: 'Pokémon Card 151' }).top, 'POKÉMON CARD 151');
  });
});

describe('band geometry', () => {
  it('the default fraction gives a 196px band and a 1512x1720 card box', () => {
    const frame = resolveTargetFrame(resolveTarget('shopify-card'), {});
    const g = resolveBandGeometry(frame, DEFAULT_BAND_FRACTION);
    assert.equal(g.bandH, 196);
    assert.deepEqual(g.cardBox, { width: 1512, height: 1720 });
  });

  it('refuses a fraction that leaves no room for the card, naming the number', () => {
    const frame = resolveTargetFrame(resolveTarget('shopify-card'), {});
    assert.throws(() => resolveBandGeometry(frame, 0.48), /bands leave no room for the card/);
    assert.throws(() => resolveBandGeometry(frame, 0), /must be >0/);
    assert.throws(() => resolveBandGeometry(frame, 0.6), /must be >0 and <0\.5/);
  });
});

describe('aspectReview — advisory, never destructive', () => {
  const card = (w, h) => ({ width: w, height: h });

  it('says nothing about a real card', () => {
    assert.equal(aspectReview(card(733, 1024)), null);   // pokemontcg.io
    assert.equal(aspectReview(card(744, 1040)), null);   // Scryfall
    assert.equal(aspectReview(card(1120, 1560)), null);  // SWU unit
  });

  it('EXEMPTS landscape cards — SWU Leaders, MTG Battles, Lorcana Locations are printed sideways', () => {
    assert.equal(aspectReview(card(1560, 1120)), null);
    assert.equal(aspectReview(card(1600, 1600)), null);
  });

  it('flags a portrait source that is far from card-shaped', () => {
    const r = aspectReview(card(700, 1600));
    assert.ok(r, 'a 0.44 aspect portrait is not a card');
    assert.equal(r.reason, 'aspect-far-from-card');
    assert.ok(r.off > 0.08);
  });

  it('a PSA slab is off-ratio enough to be noticed, which is correct — it still renders untouched', () => {
    const r = aspectReview(card(700, 1129));
    assert.ok(r && r.off > 0.08);
  });

  it('the threshold is inclusive at the boundary, and configurable', () => {
    assert.equal(aspectReview(card(700, 1129), 50), null);
    assert.ok(aspectReview(card(700, 1129), 1));
  });

  it('a missing or degenerate region says nothing rather than throwing', () => {
    assert.equal(aspectReview(null), null);
    assert.equal(aspectReview(card(0, 0)), null);
  });
});

const sharp = await sharpOrNull();
const cfg = loadConfig();
const avail = sharp ? await bandsAvailable(cfg, 'default') : { ok: false, reasons: ['sharp unavailable'] };
const SKIP = avail.ok ? false : 'band compositor unavailable: ' + avail.reasons.join('; ');

describe('composeBandImage', { skip: SKIP }, () => {
  const meta = { productType: 'single', cardName: 'Iono', setName: 'Paldea Evolved', cardNumber: '254/182', language: 'English' };

  it('renders the 63:88 tile exactly', async () => {
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    assert.equal(r.width, 1512);
    assert.equal(r.height, 2112);
    assert.equal(r.band.height, 196);
  });

  it('a card fills the width it can and sits between the bands', async () => {
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    assert.equal(r.card.height, 1720, 'a 63:88 card is height-bound by the card box');
    assert.ok(r.card.width > 1200 && r.card.width < 1512, `card came out ${r.card.width}px wide`);
  });

  it('a LANDSCAPE card contains cleanly — nothing cropped, nothing flagged', async () => {
    const r = await composeBandImage(await fakeCard(1560, 1120), meta, { cfg, trim: false });
    assert.equal(r.width, 1512);
    assert.equal(r.card.width, 1512, 'a landscape card is width-bound');
    assert.ok(r.card.height < 1720);
    assert.equal(r.review, null, 'a sideways card is not a bad trim and must not be flagged');
  });

  it('sealed uses the 1:1 frame', async () => {
    const r = await composeBandImage(await fakeCard(1500, 1050), { ...meta, productType: 'sealed' }, { cfg, trim: false });
    assert.equal(r.width, 1600);
    assert.equal(r.height, 1600);
  });

  it('output is opaque JPEG — the branded ground means nothing needs alpha', async () => {
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    const m = await sharp(r.buffer).metadata();
    assert.equal(m.format, 'jpeg');
    assert.equal(!!m.hasAlpha, false);
  });

  it('the corners are branded plum, not a neutral mat — that is what makes both storefront modes work', async () => {
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    const { data } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
    const [rr, gg, bb] = [data[0], data[1], data[2]];
    assert.ok(rr < 90 && gg < 60 && bb < 100, `top-left corner is rgb(${rr},${gg},${bb}) — expected dark plum`);
  });

  it('an NM and an LP of one card produce the SAME hash — one composite per card', async () => {
    const bytes = await fakeCard(733, 1024);
    const nm = await composeBandImage(bytes, { ...meta, condition: 'Near Mint' }, { cfg, trim: false });
    const lp = await composeBandImage(bytes, { ...meta, condition: 'Lightly Played' }, { cfg, trim: false });
    assert.equal(nm.contentHash, lp.contentHash);
  });

  it('a different card does NOT collide', async () => {
    const bytes = await fakeCard(733, 1024);
    const a = await composeBandImage(bytes, meta, { cfg, trim: false });
    const b = await composeBandImage(bytes, { ...meta, cardName: 'Bellibolt' }, { cfg, trim: false });
    assert.notEqual(a.contentHash, b.contentHash);
  });

  it('the hash carries the target, so the eBay square and the tile cannot share a key', async () => {
    const bytes = await fakeCard(733, 1024);
    const card = await composeBandImage(bytes, meta, { cfg, trim: false });
    const square = await composeBandImage(bytes, { ...meta, productType: 'sealed' }, { cfg, trim: false });
    assert.notEqual(card.contentHash, square.contentHash);
    assert.equal(card.composeVersion.endsWith('/shopify-card'), true);
  });

  it('refuses a vertical-rail target rather than quietly rendering the wrong frame', async () => {
    await assert.rejects(
      () => composeBandImage(fakeCard(733, 1024), meta, { cfg, target: 'ebay-square' }),
      /uses vertical rails/);
  });

  it('an ordinary slab fits both labels whole, at full size', async () => {
    const slab = { ...meta, productType: 'slab', grader: 'PSA', grade: 10, certNumber: '84512203' };
    const r = await composeBandImage(await fakeCard(733, 1024), slab, { cfg, trim: false });
    assert.equal(r.band.drawn.left, 'PALDEA EVOLVED · 254/182');
    assert.equal(r.band.drawn.right, 'PSA 10 · CERT 84512203');
  });

  it('when they cannot both fit, the CERT survives and the set name gives way', async () => {
    // The two labels share one line, so they share one budget. Sizing them independently let them
    // run into each other; clipping whichever was measured second threw away the cert, which is the
    // slab's SKU. They now scale down together first, and only then does the left give way —
    // 48 characters of set name plus a full cert genuinely does not fit at a legible size.
    const long = { ...meta, productType: 'slab', setName: 'Shrouded Fable Ultra Premium Collection', cardNumber: '000/000', grader: 'PSA', grade: 10, certNumber: '84512203' };
    const r = await composeBandImage(await fakeCard(733, 1024), long, { cfg, trim: false });
    assert.equal(r.band.drawn.right, 'PSA 10 · CERT 84512203', 'the cert must survive intact — it is the SKU');
    assert.ok(r.band.drawn.left.startsWith('SHROUDED FABLE'), 'the set name keeps its head, not its tail');
    assert.ok(r.band.drawn.left.endsWith('…'), 'and is visibly cut rather than silently overflowing');
  });

  it('a pathological label still clips rather than overflowing the band', async () => {
    const absurd = { ...meta, setName: 'A'.repeat(140), cardNumber: '001/999' };
    const r = await composeBandImage(await fakeCard(733, 1024), absurd, { cfg, trim: false });
    assert.ok(r.band.drawn.left.includes('…'), 'a 140-character set name has to be cut somewhere');
  });

  it('the disk cache round-trips on the target extension', async () => {
    const dir = path.join(process.cwd(), 'test', '.tmp-band-cache-' + process.pid);
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      const bytes = await fakeCard(733, 1024);
      const first = await composeBandImage(bytes, meta, { cfg, cacheDir: dir, trim: false });
      assert.equal(first.cached, false);
      assert.ok(fs.existsSync(path.join(dir, first.contentHash + '.jpg')));
      const second = await composeBandImage(bytes, meta, { cfg, cacheDir: dir, trim: false });
      assert.equal(second.cached, true);
      assert.equal(Buffer.compare(first.buffer, second.buffer), 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
