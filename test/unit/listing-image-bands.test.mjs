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
import { tmpDir } from '../helpers/tmp.mjs';
import {
  bandText, aspectReview, composeBandImage, composeOgImage, bandsAvailable,
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

  it('a set with neither wordmark nor symbol still renders — both ends empty, block still centred', async () => {
    // Early Pokemon sets printed no symbol, and Lorcana and One Piece have none in the bakes.
    const r = await composeBandImage(await fakeCard(733, 1024), meta, { cfg, trim: false });
    assert.equal(r.band.drawn.setMark, undefined);
    assert.equal(r.band.drawn.setLogo, undefined);
    assert.equal(r.band.drawn.set, 'PALDEA EVOLVED');
    assert.equal(r.band.drawn.number, '254/182');
  });

  it('the WORDMARK and the SYMBOL are different slots — left and right, not the same art twice', async () => {
    // The bug this pins: the symbol was mirrored to both ends, which threw the set's wordmark away
    // entirely. They are not interchangeable — a wordmark is the set's name as type, a symbol is
    // the mark printed on the card — and the eBay square has always shown both, one per rail foot.
    const withArt = {
      ...meta,
      setLogoAsset: 'logos/rail/pokemon.png',       // stands in for the set's own wordmark
      setAbbrev: 'SCR',                             // stands in for the printed symbol
    };
    const r = await composeBandImage(await fakeCard(733, 1024), withArt, { cfg, trim: false });
    assert.equal(r.band.drawn.setLogo, 'wordmark', 'the left end must carry the wordmark');
    assert.equal(r.band.drawn.setMark, 'code SCR', 'the right end must carry the printed mark');
  });

  it('a wordmark with no symbol still fills the left end', async () => {
    const r = await composeBandImage(await fakeCard(733, 1024), { ...meta, setLogoAsset: 'logos/rail/mtg.png' }, { cfg, trim: false });
    assert.equal(r.band.drawn.setLogo, 'wordmark');
    assert.equal(r.band.drawn.setMark, undefined);
  });

  it('the wordmark is in the hash — two sets must not share a composite', async () => {
    const bytes = await fakeCard(733, 1024);
    const bare = await composeBandImage(bytes, meta, { cfg, trim: false });
    const a = await composeBandImage(bytes, { ...meta, setLogoAsset: 'logos/rail/pokemon.png' }, { cfg, trim: false });
    const b = await composeBandImage(bytes, { ...meta, setLogoAsset: 'logos/rail/mtg.png' }, { cfg, trim: false });
    assert.notEqual(bare.contentHash, a.contentHash);
    assert.notEqual(a.contentHash, b.contentHash);
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
    // Out of the working tree and into a unique temp directory. This was
    // `test/.tmp-band-cache-<pid>`, which git does NOT ignore — a leak here turns up in
    // `git status` and is commitable, unlike every other leak in this sweep. The pre-clean that
    // used to sit here was load-bearing (the first compose must miss the cache for
    // `first.cached === false` to mean anything); mkdtemp guarantees an empty directory instead.
    const dir = tmpDir('tcg-band-cache-');
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

// --- the owner-editable settings that change pixels must change the key ---------------------------
//
// WHY THIS EXISTS. lib/listing-image-store.mjs no longer overwrites a destination that already holds
// the hash it was about to write — it returns the stored file, because renaming onto an existing file
// is what made `pnpm verify` flake on Windows. That turned a latent hash bug into a permanent one:
// shopify.bandFraction, shopify.quality and shopify.og.* all change pixels without going through
// `layout`, so before this they shared ONE contentHash. Measured then: 0.093 / 0.12 / quality 40 gave
// 176,285 / 180,556 / 57,488 bytes under one key. With the store returning first-writer bytes, tuning
// bandFraction would have done nothing to any card already composed, and the store would have ended
// up half-framed one way and half the other.
describe('shopify pixel settings are part of the content hash', { skip: SKIP }, () => {
  const meta = { productType: 'single', cardName: 'Iono', setName: 'Paldea Evolved', cardNumber: '254/182', language: 'English' };
  const withShopify = (over) => ({ ...cfg, shopify: { ...cfg.shopify, ...over } });
  const compose = async (over) => composeBandImage(
    await fakeCard(733, 1024), meta, { cfg: withShopify(over), trim: false });

  it('a different band fraction is a different key AND different pixels', async () => {
    const a = await compose({});
    const b = await compose({ bandFraction: 0.12 });
    assert.notEqual(a.contentHash, b.contentHash, 'two framings of one card must not share a key');
    assert.notEqual(Buffer.compare(a.buffer, b.buffer), 0, 'precondition: the setting really does move pixels');
  });

  it('a different jpeg quality is a different key AND different pixels', async () => {
    const a = await compose({});
    const b = await compose({ quality: 40 });
    assert.notEqual(a.contentHash, b.contentHash);
    assert.notEqual(Buffer.compare(a.buffer, b.buffer), 0);
  });

  it('og geometry is keyed too, on the social card', async () => {
    // The social card has its own entry point — composeBandImage refuses 'og-card' outright, because
    // that frame uses vertical rails rather than bands — so it needs its own case here, or the
    // shopify.og.* keys go unguarded.
    const og = async (over) => composeOgImage(await fakeCard(733, 1024), meta, { cfg: withShopify(over), trim: false });
    const a = await og({});
    const b = await og({ og: { ...cfg.shopify.og, railWidth: 240 } });
    assert.notEqual(a.contentHash, b.contentHash);
    assert.notEqual(Buffer.compare(a.buffer, b.buffer), 0);
  });

  it('and STOCK settings key exactly as they did before the segment existed', async () => {
    // The zero-blast-radius property, and the whole reason the segment is append-only. If this fails,
    // every composite already on disk and every image already hosted is orphaned and the store
    // re-uploads itself — an ASSET_VERSION-sized event, which this must never be.
    const a = await compose({});
    const explicitDefaults = await compose({ quality: cfg.shopify.quality, bandFraction: cfg.shopify.bandFraction });
    assert.equal(a.contentHash, explicitDefaults.contentHash,
      'spelling a default out must not re-key it — the segment is written only for values that DIFFER');
  });
});
