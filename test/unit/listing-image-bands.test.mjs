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

  it('splits into the card name, the set, and the printed number', () => {
    assert.deepEqual(bandText(base), { name: 'IONO', set: 'PALDEA EVOLVED', number: '254/182' });
  });

  it('the number line carries whatever qualifies it, and nothing when nothing does', () => {
    assert.equal(bandText({ ...base, language: 'Japanese' }).number, '254/182 · JP');
    assert.equal(bandText({ ...base, productType: 'slab', grader: 'PSA', grade: 10, certNumber: '84512203' }).number,
      '254/182 · PSA 10 · CERT 84512203');
  });

  it('a sealed product has no number line at all', () => {
    assert.equal(bandText({ productType: 'sealed', cardName: 'Booster Box', setName: 'Paldea Evolved' }).number, '');
  });

  it('CONDITION NEVER APPEARS — an NM and an LP of one card must share a composite', () => {
    const nm = bandText({ ...base, condition: 'Near Mint' });
    const lp = bandText({ ...base, condition: 'Lightly Played' });
    assert.deepEqual(nm, lp);
    for (const v of Object.values(nm)) assert.ok(!/MINT|PLAYED/.test(v), `condition leaked into "${v}"`);
  });

  it('a non-English printing gets its marker, English gets none', () => {
    assert.match(bandText({ ...base, language: 'Japanese' }).number, / · JP$/);
    assert.match(bandText({ ...base, language: 'Korean' }).number, / · KO$/);
    assert.equal(bandText({ ...base, language: 'English' }).number, '254/182');
    assert.equal(bandText({ ...base, language: '' }).number, '254/182');
  });

  it('a slab carries its grade and cert instead — it is one of one, so nothing splits', () => {
    const t = bandText({ ...base, productType: 'slab', grader: 'PSA', grade: 10, certNumber: '84512203' });
    assert.match(t.number, /PSA 10 · CERT 84512203$/);
  });

  it('a half grade keeps its decimal', () => {
    assert.match(bandText({ ...base, productType: 'slab', grader: 'BGS', grade: 9.5 }).number, /BGS 9\.5$/);
  });

  it('drops what is missing rather than printing undefined', () => {
    assert.deepEqual(bandText({ productType: 'single' }), { name: '', set: '', number: '' });
    assert.equal(bandText({ ...base, cardNumber: '' }).number, '');
    assert.equal(bandText({ ...base, setName: '' }).set, '');
  });

  it('drops text the bundled Latin font cannot draw, rather than gambling on a substitution', () => {
    // Pango silently falls back to a SYSTEM font for a missing glyph — perfect on the Windows dev
    // box, blank boxes on a Linux server with no CJK font, and nothing reports it.
    assert.equal(bandText({ ...base, cardName: 'スタートデッキ100' }).name, '');
    assert.equal(bandText({ ...base, cardName: 'Pokémon Card 151' }).name, 'POKÉMON CARD 151');
  });
});

describe('band geometry', () => {
  it('the default fraction gives a 196px band, a 48px mat and a 1416x1624 card box', () => {
    const frame = resolveTargetFrame(resolveTarget('shopify-card'), {});
    const g = resolveBandGeometry(frame, DEFAULT_BAND_FRACTION);
    assert.equal(g.bandH, 196);
    // The mat is the band's counterpart to the eBay square's cardPaddingX, and the same 48px:
    // without it the card's edge sits hard against the band's hairline.
    assert.equal(g.mat, 48);
    assert.deepEqual(g.cardBox, { width: 1416, height: 1624 });
  });

  it('the card never touches a band — there is plum on all four sides', () => {
    const frame = resolveTargetFrame(resolveTarget('shopify-card'), {});
    const g = resolveBandGeometry(frame, DEFAULT_BAND_FRACTION);
    assert.ok(g.mat > 0);
    assert.equal(g.cardBox.width, frame.width - 2 * g.mat);
    assert.equal(g.cardBox.height, frame.height - 2 * g.bandH - 2 * g.mat);
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

  it('carries the SET MARK — the boxed code where a game prints one instead of a symbol', async () => {
    // The information the eBay rail has always shown and the first band pass dropped. SWU and
    // Riftbound print a set CODE where Pokémon prints a symbol, so the badge is the boxed code.
    const r = await composeBandImage(await fakeCard(733, 1024), { ...meta, setAbbrev: 'SOR' }, { cfg, trim: false });
    assert.equal(r.band.drawn.setMark, 'code SOR');
  });

  it('the set mark is part of the hash — it is pixels, so two sets cannot share a key', async () => {
    const bytes = await fakeCard(733, 1024);
    const plain = await composeBandImage(bytes, meta, { cfg, trim: false });
    const sor = await composeBandImage(bytes, { ...meta, setAbbrev: 'SOR' }, { cfg, trim: false });
    const ogn = await composeBandImage(bytes, { ...meta, setAbbrev: 'OGN' }, { cfg, trim: false });
    assert.notEqual(plain.contentHash, sor.contentHash);
    assert.notEqual(sor.contentHash, ogn.contentHash);
  });

  it('a card with no set art still renders — the mark is furniture, not a requirement', async () => {
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    assert.equal(r.band.drawn.setMark, undefined);
    assert.equal(r.width, 1512);
  });

  it('a card fills the width it can and sits between the bands', async () => {
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    assert.equal(r.card.height, 1624, 'a 63:88 card is height-bound by the card box');
    assert.ok(r.card.width > 1100 && r.card.width < 1416, `card came out ${r.card.width}px wide`);
  });

  it('a LANDSCAPE card contains cleanly — nothing cropped, nothing flagged', async () => {
    const r = await composeBandImage(await fakeCard(1560, 1120), meta, { cfg, trim: false });
    assert.equal(r.width, 1512);
    assert.equal(r.card.width, 1416, 'a landscape card is width-bound by the matted card box');
    assert.ok(r.card.height < 1624);
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

  it('an ordinary slab shows set, number, grade and cert without losing any of it', async () => {
    const slab = { ...meta, productType: 'slab', grader: 'PSA', grade: 10, certNumber: '84512203' };
    const r = await composeBandImage(await fakeCard(733, 1024), slab, { cfg, trim: false });
    assert.equal(r.band.drawn.set, 'PALDEA EVOLVED');
    assert.equal(r.band.drawn.number, '254/182 · PSA 10 · CERT 84512203');
  });

  it('THE CARD NAME IS NEVER TRUNCATED — it shrinks, then wraps to two lines', async () => {
    // "ROSA'S ENCOURAGE…" was the failure: the one thing on this band a buyer is reading, cut off.
    const long = { ...meta, cardName: "Rosa's Encouragement" };
    const a = await composeBandImage(await fakeCard(733, 1024), long, { cfg, trim: false });
    assert.equal(a.band.drawn.name, "ROSA'S ENCOURAGEMENT");
    assert.equal(a.band.drawn.nameLines, 1, 'this one still fits on one line');

    const longer = { ...meta, cardName: 'Mega Gardevoir ex Special Illustration Rare' };
    const b = await composeBandImage(await fakeCard(733, 1024), longer, { cfg, trim: false });
    assert.equal(b.band.drawn.name, 'MEGA GARDEVOIR EX SPECIAL ILLUSTRATION RARE');
    assert.equal(b.band.drawn.nameLines, 2, 'too long for one line, so it wraps rather than clips');
    assert.ok(!b.band.drawn.name.includes('…'));
  });

  it('even an absurd name keeps every character', async () => {
    const absurd = { ...meta, cardName: 'A'.repeat(40) + ' ' + 'B'.repeat(40) };
    const r = await composeBandImage(await fakeCard(733, 1024), absurd, { cfg, trim: false });
    assert.equal(r.band.drawn.name, absurd.cardName.toUpperCase());
    assert.ok(!r.band.drawn.name.includes('…'));
  });

  it('a set with NO symbol still renders — both ends empty, block still centred', async () => {
    // Early Pokemon sets printed no symbol, and Lorcana and One Piece have none in the bakes.
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    assert.equal(r.band.drawn.setMark, undefined);
    assert.equal(r.band.drawn.set, 'PALDEA EVOLVED');
    assert.equal(r.band.drawn.number, '254/182');
  });

  it('the store mark is OFF by default — our own storefront does not need telling whose it is', async () => {
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    assert.equal(r.band.mark, 'none');
  });

  it("'share' puts the mark back, and the two are DIFFERENT images", async () => {
    // They must not collide: the storefront tile and the shareable one are the same card and the
    // same bytes in, so only the mark distinguishes them — if it were not in the key, whichever
    // rendered first would be served for both.
    const bytes = await fakeCard(733, 1024);
    const plain = await composeBandImage(bytes, meta, { cfg, trim: false });
    const shared = await composeBandImage(bytes, meta, { cfg, trim: false, mark: 'share' });
    assert.equal(shared.band.mark, 'share');
    assert.notEqual(plain.contentHash, shared.contentHash);
    assert.notEqual(Buffer.compare(plain.buffer, shared.buffer), 0);
  });

  it('an unknown mark mode falls back to the default rather than throwing', async () => {
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false, mark: 'enormous' });
    assert.equal(r.band.mark, 'none');
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
