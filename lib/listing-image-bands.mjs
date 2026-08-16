// lib/listing-image-bands.mjs — the Shopify frames: a card contained on plum, between two branded
// horizontal bands carrying its own facts.
//
//   composeBandImage(input, meta, options?) -> { buffer, width, height, contentHash, ... }
//
// WHY BANDS AND NOT SIDE RAILS. eBay crops gallery thumbs to a square, so a portrait card
// letterboxes and the rails fill dead space we were given. Shopify's grid is 63:88 — the card's own
// ratio — so there is no dead space to fill and we create some deliberately. Creating it on the
// HORIZONTAL axis is the load-bearing call: side rails would eat a portrait card's width (the eBay
// square only gets away with that because the card is already width-constrained there), and
// horizontal type needs no rotation, so a band carries a full set name and printed number at
// readable size where a 300px vertical rail manages two clipped lines.
//
// WHY THE GROUND IS BRANDED RATHER THAN TRANSPARENT. The storefront has a light and a dark mode. A
// NEUTRAL mat would be wrong in one of them, which is the objection that originally argued Shopify
// should carry no furniture at all. A branded plum surround is not a mat: it is dark in both modes
// on purpose, the way a card's own border is. That also makes every frame opaque, so nothing here
// needs an alpha channel, a PNG branch, or a format switch.
//
// CONDITION NEVER APPEARS ON THESE IMAGES. An NM and an LP of one card are two stock rows with
// IDENTICAL source bytes; putting condition on the image splits every such pair into two separately
// composed, separately stored images across the whole store. Alt text and the product title carry
// it instead, where it costs nothing. Slabs are the one exception and legitimately so — a slab is
// one of one, so there is no pair to split.
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, loadConfig, resolveVariant, resolveLayout, composeHash, composeVersion, isRailDrawable,
} from './listing-image-config.mjs';
import {
  getSharp, sharpError, loadBand, bandsPresent, bandsDigest, fontProbe, fontFamily, fontFile,
  railPath, railMeta, railsPresent, railsDigest,
} from './listing-image-assets.mjs';
import { prepareSource, regionFor } from './listing-image-source.mjs';
import {
  DEFAULT_BAND_FRACTION, SHOPIFY_TARGET_FOR, resolveTarget, resolveTargetFrame, resolveBandGeometry,
  resolveOgGeometry, OG_SAMPLE_FRACTION, targetFingerprint,
} from './listing-image-targets.mjs';
import { ComposeUnavailable, trimDetector } from './listing-image.mjs';

// The store mark, composited at render time rather than baked into the band art: one band asset
// serves both the 1512-wide card tile and the 1600-wide sealed tile, so a baked mark would stretch
// by a different amount in each.
const MARK = 'logos/BK_Logo_alpha.png';
const INK = '#efe8f6';        // the same near-white lilac the eBay badge uses
const GOLD = '#c9a227';       // the same gold as the eBay rail text
const CARD_RATIO = 63 / 88;
const LANDSCAPE_MIN = 0.95;   // at or above this a source is a sideways card, not a bad trim

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shopifyCfg = (cfg) => (cfg && cfg.shopify) || {};

// --- what the bands say -------------------------------------------------------------------------

const langMarker = (lang) => {
  const s = String(lang || '').trim();
  if (!s || /^(english|en|eng)$/i.test(s)) return '';
  const two = { japanese: 'JP', korean: 'KO', chinese: 'ZH', german: 'DE', french: 'FR', italian: 'IT', spanish: 'ES', portuguese: 'PT', russian: 'RU' }[s.toLowerCase()];
  return two || (s.length <= 3 ? s.toUpperCase() : s.slice(0, 2).toUpperCase());
};

/**
 * Returns ONE STRING PER SLOT, never a pre-joined band. Undrawable text is dropped rather than
 * gambled on: the bundled font is Latin-only and Pango silently substitutes a SYSTEM font for a
 * glyph it lacks, which renders perfectly on the Windows dev box and as blank boxes on a Linux
 * server with no CJK font — the same trap railText() already guards.
 */
export function bandText(meta = {}) {
  const drawable = (s) => (s && isRailDrawable(s) ? String(s).trim() : '');
  const name = drawable(meta.cardName);
  const setName = drawable(meta.setName);
  const number = String(meta.cardNumber || '').trim();
  const left = [setName, number].filter(Boolean).join(' · ');

  // Slabs carry their grade and cert; everything else carries the language marker, and only when
  // it is not English. English is the store default and the bulk of stock, so printing it on every
  // image is noise; a non-English printing is a different product and changes what the card is
  // worth. NEVER condition — see the header.
  let right = '';
  if (String(meta.productType || '') === 'slab') {
    const grade = [meta.grader, meta.grade].filter((x) => x != null && String(x).trim()).join(' ');
    const cert = String(meta.certNumber || '').trim();
    right = [grade, cert ? 'CERT ' + cert : ''].filter(Boolean).join(' · ');
  } else {
    right = langMarker(meta.language);
  }
  return { top: name.toUpperCase(), left: left.toUpperCase(), right: String(right).toUpperCase() };
}

// --- type ---------------------------------------------------------------------------------------

// Render one line at approximately `targetH` pixels tall. Measure-then-scale, the same mechanism
// renderTextLayer uses, because a fixed dpi that suits "BASE SET" leaves "PRISMATIC EVOLUTIONS"
// either tiny or overflowing.
// 1200, NOT the 420 the vertical rail text uses. That cap exists to stop a two-word set name
// rendering absurdly large down a 1600px rail, where nothing else bounds it. Band type is already
// bounded by the band's own thickness, so the same cap silently BINDS instead: a 120dpi reference
// render of one line is only ~14px tall, so a 55px target needs ~470dpi and a 67px target ~574dpi —
// both clamped to 420, both coming out the same size. That made the shared-width budget below
// compute from a width the type never actually had, and a label that would have fitted got clipped.
const MAX_BAND_DPI = 1200;

async function line(sharp, text, targetH, colour, cfg) {
  if (!text) return null;
  const markup = `<span foreground="${colour}">${esc(text)}</span>`;
  const render = (dpi) => sharp({ text: { text: markup, font: fontFamily(cfg), fontfile: fontFile(cfg), dpi, rgba: true } });
  const REF = 120;
  const ref = await sharp(await render(REF).png().toBuffer()).metadata();
  if (!ref.height) return null;
  const dpi = Math.max(24, Math.min(MAX_BAND_DPI, Math.round(REF * (targetH / ref.height))));
  const buffer = await render(dpi).png().toBuffer();
  const m = await sharp(buffer).metadata();
  return { buffer, width: m.width, height: m.height };
}

// Render `text` so it fits `budget` px wide, clipping CHARACTERS first and only shrinking as a last
// resort. Clipping keeps the type the same size as its neighbour on the band; shrinking makes one
// label visibly smaller than the other, which reads as a mistake rather than as a long name.
async function fitLine(sharp, text, targetH, colour, budget, cfg) {
  if (!text || budget <= 0) return null;
  let out = await line(sharp, text, targetH, colour, cfg);
  if (!out) return null;
  out.text = text;
  if (out.width <= budget) return out;
  const keep = Math.max(1, Math.floor(text.length * (budget / out.width)) - 1);
  const clipped = text.slice(0, keep).trimEnd() + '…';
  out = await line(sharp, clipped, targetH, colour, cfg);
  if (!out) return null;
  out.text = clipped;
  if (out.width > budget) {
    // Still over on a pathological string — shrink rather than overflow the band. An unclamped
    // composite offset goes negative and sharp throws the whole image away.
    const buffer = await sharp(out.buffer).resize(budget, null, { fit: 'inside' }).png().toBuffer();
    const m = await sharp(buffer).metadata();
    out = { buffer, width: m.width, height: m.height, text: out.text };
  }
  return out;
}

// --- the bands ------------------------------------------------------------------------------

// The plum ground, sampled from the band art's OWN gradient rather than regenerated from the design
// constants. Taking a 1px ROW out of the already-normalised top band and replicating it down the
// frame makes the ground and the bands the same gradient BY CONSTRUCTION — no resampling difference
// is possible, so the join can never seam however the art is later redrawn.
//
// Row 2, not row 0: the hairline sits on the band's card-facing edge (the BOTTOM of the top band),
// so the outer rows are clean plum. Replication uses kernel 'nearest', which on a 1px source is
// exact rather than interpolated.
async function ground(sharp, variant, frame, bandH) {
  const top = await loadBand(variant, 'top', frame.width, bandH);
  const row = await sharp(top).extract({ left: 0, top: 2, width: frame.width, height: 1 }).png().toBuffer();
  return sharp(row).resize(frame.width, frame.height, { kernel: 'nearest', fit: 'fill' }).png().toBuffer();
}

async function markLayer(sharp, height) {
  const p = path.resolve(ROOT, MARK);
  if (!fs.existsSync(p)) return null;
  try {
    const buffer = await sharp(p).resize(null, height, { fit: 'inside' }).png().toBuffer();
    const m = await sharp(buffer).metadata();
    return { buffer, width: m.width, height: m.height };
  } catch { return null; }
}

// Dress one band. Degrades in the same direction the rails do: no font means a plain branded band,
// never a failed image.
async function dressBand(sharp, variant, side, frame, bandH, text, cfg, hasFont) {
  const base = await loadBand(variant, side, frame.width, bandH);
  // Degrades the way the rails do: no usable font means a plain branded band, never a failed image.
  if (!hasFont) return { buffer: base, drawn: {} };
  const pad = Math.round(bandH * 0.26);
  const layers = [];
  const drawn = {};

  if (side === 'top') {
    const mark = await markLayer(sharp, Math.round(bandH * 0.62));
    let x = pad;
    if (mark) {
      layers.push({ input: mark.buffer, left: x, top: Math.round((bandH - mark.height) / 2) });
      x += mark.width + pad;
    }
    const name = await fitLine(sharp, text.top, Math.round(bandH * 0.40), INK, frame.width - x - pad, cfg);
    if (name) {
      layers.push({ input: name.buffer, left: x, top: Math.round((bandH - name.height) / 2) });
      drawn.top = name.text;
    }
  } else {
    // The two labels share one line, so they share one budget. Sizing them INDEPENDENTLY is what
    // made "SPARK OF REBELLION · 010/252" run into its neighbour, and clipping whichever is
    // measured second throws away the wrong thing — on a slab the right-hand label is the grade and
    // the cert, which is that item's SKU.
    //
    // So: render both at the nominal size, and if they do not fit, scale BOTH down by the same
    // factor. Two complete labels a little smaller read better than one full and one truncated, and
    // it matches the sized-to-fit rule the vertical rail text already follows. Clipping is the last
    // resort, floored so the type cannot shrink to nothing.
    // 0.28, not the top band's 0.40: this band carries TWO labels on one line, and measured against
    // the bundled font a glyph runs about 0.6x its height wide. A set name plus a printed number
    // plus a full cert is ~46 characters, which needs ~49px on a 1512px band — 0.34 (67px) overflows
    // before the shared-scale pass even starts, so the nominal size is set where an ordinary slab
    // fits whole and only genuinely long names scale.
    const h0 = Math.round(bandH * 0.28);
    const gap = pad;
    const budget = frame.width - 2 * pad - gap;
    let left = await line(sharp, text.left, h0, GOLD, cfg);
    let right = await line(sharp, text.right, h0, INK, cfg);
    if (left) left.text = text.left;
    if (right) right.text = text.right;
    const total = (left ? left.width : 0) + (right ? right.width : 0);
    if (total > budget) {
      // Scale both to the same smaller size, floored so the type cannot shrink to nothing.
      const h = Math.max(Math.round(h0 * 0.62), Math.round(h0 * (budget / total)));
      // Re-render the RIGHT at the new size first and measure it, then give the left the actual
      // remainder. Budgeting the left against the right's PRE-scale width is what clipped a set
      // name that would in fact have fitted.
      right = await fitLine(sharp, text.right, h, INK, Math.round(budget * 0.55), cfg);
      left = await fitLine(sharp, text.left, h, GOLD, budget - (right ? right.width : 0), cfg);
    }
    if (left) {
      layers.push({ input: left.buffer, left: pad, top: Math.round((bandH - left.height) / 2) });
      drawn.left = left.text;
    }
    if (right) {
      layers.push({ input: right.buffer, left: frame.width - pad - right.width, top: Math.round((bandH - right.height) / 2) });
      drawn.right = right.text;
    }
  }
  const buffer = layers.length ? await sharp(base).composite(layers).png().toBuffer() : base;
  return { buffer, drawn };
}

// --- readiness ------------------------------------------------------------------------------

export async function bandsAvailable(cfg = loadConfig(), variant = 'default') {
  const reasons = [];
  const sharp = await getSharp();
  if (!sharp) reasons.push('sharp not installed (' + (sharpError() || 'unknown') + ')');
  if (!bandsPresent(variant)) reasons.push(`band art missing for variant '${variant}' (expected rails/${variant}/top.png and bottom.png)`);
  const font = sharp ? await fontProbe(cfg) : { ok: false, reason: 'sharp unavailable' };
  return { ok: reasons.length === 0, reasons, text: font.ok, textReason: font.ok ? null : font.reason };
}

// --- the aspect sanity flag ------------------------------------------------------------------

// ADVISORY ONLY. Nothing is cropped by this pipeline, so an off-ratio source costs a smaller card
// on plum rather than lost art — which is exactly why the flag can afford to be honest instead of
// conservative. Landscape sources are exempt: SWU Leaders and Bases (82 of 946 in SOR alone),
// Lorcana Locations, MTG Battles and Riftbound Battlefields are printed sideways, and flagging
// every one of them would bury the real bad trims.
export function aspectReview(region, warnPct = 8) {
  if (!region || !(region.width > 0 && region.height > 0)) return null;
  const a = region.width / region.height;
  if (a >= LANDSCAPE_MIN) return null;
  const off = 1 - Math.min(a, CARD_RATIO) / Math.max(a, CARD_RATIO);
  if (off <= warnPct / 100 + 1e-9) return null;
  return { reason: 'aspect-far-from-card', aspect: +a.toFixed(4), off: +off.toFixed(4) };
}

// --- the 1200x630 social card -----------------------------------------------------------------

/**
 * The OG / link-preview card. Wide, so its dead space is at the SIDES — it reuses the vertical rail
 * art rather than the bands, per the same dead-axis rule that put bands on the 63:88 tile.
 *
 * Deliberately carries NO rail text and NO set badge. Both are sized against a 1600-tall canvas and
 * a 300-wide rail; at 630 tall the vertically-centred text block runs straight through the store
 * mark — the first render did exactly that. Re-deriving that typography for a wide frame is a new
 * design decision, not a reuse of the existing one. The card, the mark and the game wordmark are a
 * complete social card. Do not "finish" this.
 */
export async function composeOgImage(input, meta = {}, options = {}) {
  const cfg = options.cfg || loadConfig();
  const variant = resolveVariant(meta, options, cfg);
  const target = resolveTarget('og-card');

  const sharp = await getSharp();
  const reasons = [];
  if (!sharp) reasons.push('sharp not installed (' + (sharpError() || 'unknown') + ')');
  if (!railsPresent(variant)) reasons.push(`rail art missing for variant '${variant}'`);
  if (reasons.length) throw new ComposeUnavailable(reasons);

  const art = await railMeta(variant, 'left');
  const g = resolveOgGeometry(cfg, art);
  const layout = resolveLayout(cfg, meta, options);
  const assetDigest = railsDigest(variant) || '';
  const sourceBytes = Buffer.isBuffer(input) ? input
    : input instanceof Uint8Array ? Buffer.from(input)
      : fs.readFileSync(input);

  const contentHash = composeHash({
    sourceBytes, layout, variant, textLines: [], assetDigest, badge: '',
    flags: options.trim === false ? 'notrim' : '', target: targetFingerprint(target),
  });
  const version = composeVersion(variant, assetDigest, target.id);

  const cacheFile = options.cacheDir ? path.join(options.cacheDir, contentHash + '.' + target.ext) : null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    return { buffer: fs.readFileSync(cacheFile), width: g.width, height: g.height, contentHash, composeVersion: version, variant, target: target.id, cached: true };
  }

  // Scale by width, crop from the top: uniform horizontal scale keeps the mark's proportions and
  // the inner hairline exactly, and top-anchoring keeps the masthead in frame.
  const railLayer = async (side) => sharp(railPath(variant, side))
    .resize(g.railWidth, g.scaledHeight, { kernel: 'lanczos3', fit: 'fill' })
    .extract({ left: 0, top: 0, width: g.railWidth, height: g.height })
    .png().toBuffer();
  const [left, right] = await Promise.all([railLayer('left'), railLayer('right')]);

  // THE GROUND. A 1px column lifted from the ALREADY-RENDERED rail, not re-transformed from the
  // native art. That makes the join seamless BY CONSTRUCTION — the ground's row y is literally a
  // copy of the rail's row y, so no resampling difference is possible on any libvips build.
  // Measured: sampling the rendered layer gives a seam delta of 0, an independent identical
  // transform gives 1.
  //
  // The sample column is at 10% of the rail's width. Measured against the art on disk, the store
  // mark spans x 123-476 of 600 (20.5% to 79.4%, the same fractions on the narrower `sealed` art)
  // and the accent hairline is the inner 10px, so 10% is clear of both with room to spare. This
  // fraction stays in CODE: at 0.30 it samples the mark and the ground becomes a smear of the logo.
  const sampleX = Math.round(g.railWidth * OG_SAMPLE_FRACTION);
  const column = await sharp(left).extract({ left: sampleX, top: 0, width: 1, height: g.height }).png().toBuffer();
  // 'nearest' on a 1px-wide source is pure replication, not interpolation.
  const ground = await sharp(column).resize(g.width, g.height, { kernel: 'nearest', fit: 'fill' }).png().toBuffer();

  const detector = options.trim === false ? null : (options.detector || trimDetector);
  const prep = await prepareSource(sharp, sourceBytes, { layout, meta, detector });
  const region = regionFor(prep, { legacy: false });
  let card = prep.base.clone();
  if (region) card = card.extract(region);
  const cardBuf = await card.resize(g.cardBox.width, g.cardBox.height, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
  const cm = await sharp(cardBuf).metadata();

  const layers = [
    { input: cardBuf, left: Math.round((g.width - cm.width) / 2), top: Math.round((g.height - cm.height) / 2) },
    { input: left, left: 0, top: 0 },
    { input: right, left: g.width - g.railWidth, top: 0 },
  ];

  // The game wordmark at the foot of the left rail, mirroring the eBay layout. Rail-only asset, so
  // it never reaches a buyer's browser as a local path.
  if (meta.setLogoAsset) {
    const p = path.resolve(ROOT, meta.setLogoAsset);
    if (p.startsWith(path.resolve(ROOT, 'logos') + path.sep) && fs.existsSync(p)) {
      try {
        // NOT recoloured. loadSetArt only flattens a glyph to the badge colour when the source is
        // an SVG (Scryfall's icons carry no fill and rasterise pure black on a near-black rail);
        // logos/rail/<game>.png are full-colour PNGs and take neither that branch nor this one on
        // the eBay rail. Tinting one flat erases the internal shapes that make it a wordmark.
        const box = { width: Math.round(g.railWidth * 0.80), height: Math.round(g.railWidth * 0.62) };
        const mark = await sharp(p).resize(box.width, box.height, { fit: 'inside' }).png().toBuffer();
        const mm = await sharp(mark).metadata();
        layers.push({ input: mark, left: Math.round((g.railWidth - mm.width) / 2), top: g.height - Math.round(g.railWidth * 0.12) - mm.height });
      } catch { /* a missing wordmark costs the rail an icon, never the card its image */ }
    }
  }

  const s = shopifyCfg(cfg);
  const buffer = await sharp(ground).composite(layers)
    .jpeg({ quality: s.quality || layout.quality, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();

  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = cacheFile + '.tmp' + process.pid;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, cacheFile);
    } catch (e) { console.warn('[listing-image] og cache write failed —', e?.message || e); }
  }

  return {
    buffer, width: g.width, height: g.height, contentHash, composeVersion: version,
    variant, target: target.id, cached: false, geometry: g,
    card: { width: cm.width, height: cm.height, trimmed: !!region },
  };
}

// --- the pipeline ---------------------------------------------------------------------------

/**
 * @param input   file path | Buffer
 * @param meta    composeMetaFor()'s shape, plus grader/grade/certNumber for slabs
 * @param options { target, variant, cfg, cacheDir, detector, trim }
 */
export async function composeBandImage(input, meta = {}, options = {}) {
  const cfg = options.cfg || loadConfig();
  const variant = resolveVariant(meta, options, cfg);
  const targetId = options.target || SHOPIFY_TARGET_FOR[String(meta.productType || 'single')] || SHOPIFY_TARGET_FOR.single;
  const target = resolveTarget(targetId);
  if (target.rails !== 'horizontal') {
    throw new Error(`composeBandImage renders the banded frames — '${target.id}' uses ${target.rails} rails`);
  }

  const avail = await bandsAvailable(cfg, variant);
  if (!avail.ok) throw new ComposeUnavailable(avail.reasons);
  const sharp = await getSharp();

  const s = shopifyCfg(cfg);
  const layout = resolveLayout(cfg, meta, options);
  const frame = resolveTargetFrame(target, layout);
  const { bandH, cardBox } = resolveBandGeometry(frame, s.bandFraction != null ? s.bandFraction : DEFAULT_BAND_FRACTION);

  const text = bandText(meta);
  const lines = avail.text ? [text.top, text.left, text.right].filter(Boolean) : [];
  const assetDigest = bandsDigest(variant) || '';
  const sourceBytes = Buffer.isBuffer(input) ? input
    : input instanceof Uint8Array ? Buffer.from(input)
      : fs.readFileSync(input);

  const noTrim = options.trim === false;
  // Catalog singles get real-card rounded corners here too, and the argument is STRONGER on plum
  // than on eBay's white: a square-cornered print rectangle against a dark ground reads as a
  // mistake. The mask cuts to transparent and the plum shows through.
  const flags = noTrim ? ('notrim' + (String(meta.productType || 'single') === 'single' ? ',rcorners' : '')) : '';

  const contentHash = composeHash({
    sourceBytes, layout, variant, textLines: lines, assetDigest, badge: '', flags,
    target: targetFingerprint(target),
  });
  const version = composeVersion(variant, assetDigest, target.id);

  const cacheFile = options.cacheDir ? path.join(options.cacheDir, contentHash + '.' + target.ext) : null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    return {
      buffer: fs.readFileSync(cacheFile), width: frame.width, height: frame.height,
      contentHash, composeVersion: version, variant, target: target.id, textLines: lines, cached: true,
    };
  }

  const detector = noTrim ? null : (options.detector || trimDetector);
  const prep = await prepareSource(sharp, sourceBytes, { layout, meta, detector });
  const region = regionFor(prep, { legacy: false });
  const measured = region || { width: prep.frame.width, height: prep.frame.height };
  const review = aspectReview(measured, s.aspectWarnPct);

  let card = prep.base.clone();
  if (region) card = card.extract(region);
  let cardBuf = await card.resize(cardBox.width, cardBox.height, { fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' }).png().toBuffer();
  let cardMeta = await sharp(cardBuf).metadata();

  if (flags.includes('rcorners')) {
    try {
      const r = Math.round(cardMeta.width * 0.046);
      const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cardMeta.width}" height="${cardMeta.height}"><rect width="${cardMeta.width}" height="${cardMeta.height}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
      cardBuf = await sharp(cardBuf).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
      cardMeta = await sharp(cardBuf).metadata();
    } catch { /* square corners beat no image */ }
  }

  const [topBand, bottomBand] = await Promise.all([
    dressBand(sharp, variant, 'top', frame, bandH, text, cfg, avail.text),
    dressBand(sharp, variant, 'bottom', frame, bandH, text, cfg, avail.text),
  ]);

  // Centred on the FRAME, not measured off the band edge — the bands are symmetric, so this stays
  // correct however bandFraction is set, and deriving it from the band would shift the card the
  // moment the two bands ever differ.
  const buffer = await sharp(await ground(sharp, variant, frame, bandH))
    .composite([
      { input: cardBuf, left: Math.round((frame.width - cardMeta.width) / 2), top: Math.round((frame.height - cardMeta.height) / 2) },
      { input: topBand.buffer, left: 0, top: 0 },
      { input: bottomBand.buffer, left: 0, top: frame.height - bandH },
    ])
    // 4:4:4, same as the eBay square: subsampled chroma smears holo foil and small print, which is
    // exactly what a buyer zooms into.
    .jpeg({ quality: s.quality || layout.quality, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();

  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = cacheFile + '.tmp' + process.pid;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, cacheFile);
    } catch (e) { console.warn('[listing-image] band cache write failed —', e?.message || e); }
  }

  return {
    buffer, width: frame.width, height: frame.height, contentHash, composeVersion: version,
    variant, target: target.id, textLines: lines, cached: false, review,
    // `band` reports what was ASKED for; `band.drawn` what actually landed on the image after the
    // width budget clipped it. The previews page shows both, because "why is that name cut off" is
    // otherwise a question you can only answer by measuring pixels.
    band: { height: bandH, ...text, drawn: { ...topBand.drawn, ...bottomBand.drawn } },
    card: { width: cardMeta.width, height: cardMeta.height, trimmed: !!region },
  };
}
