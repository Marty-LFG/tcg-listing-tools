// lib/listing-image.mjs — the listing image compositor.
//
//   composeListingImage(input, meta, options?) -> { buffer, width, height, contentHash, ... }
//
// Card photo in, branded square out: the card centred in the middle column with a fixed-width rail
// either side, so eBay's square gallery crop shows OUR thumbnail instead of letterboxing the scan.
//
// This module knows nothing about eBay, inventory or HTTP. It reads assets from disk and returns
// bytes. Everything policy-shaped (is compositing on? which listings? when do we re-upload?) lives
// with the callers in lib/ebay-media.mjs and lib/listings.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ASSET_VERSION, DEFAULT_CONFIG, VARIANTS,
  loadConfig, resolveVariant, resolveLayout, railText, composeHash, composeVersion, layoutFingerprint,
} from './listing-image-config.mjs';
import { getSharp, sharpError, loadRail, railsPresent, railsDigest, fontProbe, fontFamily, fontFile, assetsStatus } from './listing-image-assets.mjs';

export { ASSET_VERSION, VARIANTS, composeHash, composeVersion, layoutFingerprint, resolveVariant, resolveLayout, railText };

// Thrown when the host cannot compose at all. Callers catch this and fall through to the
// un-composed image rather than failing the listing (GR7).
export class ComposeUnavailable extends Error {
  constructor(reasons) { super('compositor unavailable: ' + reasons.join('; ')); this.name = 'ComposeUnavailable'; this.reasons = reasons; }
}

// --- card detection -------------------------------------------------------------------------
//
// The seam an edge-detection or ML detector drops into later. A detector returns the card's bounding
// box in the (already EXIF-rotated, already flattened) source, or null to use the whole image.

export const trimDetector = {
  name: 'trim',
  async detect(image, meta, layout) {
    // Measured behaviour: catalog art is already cropped to the card, so this is a clean no-op on
    // it. On an owner photo it crops the card off the background reliably at threshold 25 — at 10 a
    // white background leaves a 1px bleed.
    let info;
    try {
      ({ info } = await image.trim({ threshold: layout.trimThreshold }).toBuffer({ resolveWithObject: true }));
    } catch { return null; }                                   // trim refuses on some inputs; keep the full frame
    if (!info || !(info.width > 0 && info.height > 0)) return null;
    // trimOffsetLeft/Top are NEGATIVE offsets from the original origin.
    const left = Math.max(0, -(info.trimOffsetLeft || 0));
    const top = Math.max(0, -(info.trimOffsetTop || 0));
    return { left, top, width: info.width, height: info.height };
  },
};

// --- readiness ------------------------------------------------------------------------------

// Per-variant, because a missing `sealed` rail must not stop singles composing. Text is reported
// separately: no font is a degraded composite (rails, no metadata line), not a broken one.
export async function composeAvailable(cfg = loadConfig(), variant = 'default') {
  const reasons = [];
  const sharp = await getSharp();
  if (!sharp) reasons.push('sharp not installed (' + (sharpError() || 'unknown') + ')');
  if (!railsPresent(variant)) reasons.push(`rail art missing for variant '${variant}' (expected rails/${variant}/left.png and right.png)`);
  const font = sharp ? await fontProbe(cfg) : { ok: false, reason: 'sharp unavailable' };
  return { ok: reasons.length === 0, reasons, text: font.ok, textReason: font.ok ? null : font.reason };
}

export async function describeCompositor(cfg = loadConfig()) {
  const status = await assetsStatus(cfg);
  return { assetVersion: ASSET_VERSION, enabled: !!cfg.enabled, applyTo: cfg.applyTo, ...status };
}

// --- text layer -----------------------------------------------------------------------------

// Renders one metadata line, rotated to run down the rail. Returns null when there is nothing to
// draw or no usable font — the caller composites the rails regardless.
async function renderTextLayer(sharp, lines, layout, cfg) {
  if (!lines.length || layout.text.rail === 'none') return null;
  const probe = await fontProbe(cfg);
  if (!probe.ok) return null;

  const family = fontFamily(cfg);
  const file = fontFile(cfg);
  const t = layout.text;
  // Pango markup carries the colour; sharp's text has no separate fill option.
  const markup = `<span foreground="${t.color}">${lines.map(escapeMarkup).join('\n')}</span>`;
  const render = (dpi) => sharp({ text: { text: markup, font: family, fontfile: file, dpi, rgba: true, align: 'centre' } });

  // Rotated onto the rail, the line's pre-rotation WIDTH runs along the canvas and its HEIGHT sits
  // across the rail's thickness. Upright text swaps those. Both have to fit, so the size comes from
  // whichever constraint binds first.
  const upright = t.rotate === 0 || t.rotate === 180;
  const alongRun = (upright ? layout.railWidth : layout.canvas) - 2 * t.marginY;
  const acrossRun = Math.round((upright ? layout.canvas : layout.railWidth) * (1 - 2 * t.railInset));
  if (alongRun <= 0 || acrossRun <= 0) return null;

  // Measure once at a reference size, then scale to the target. Sizing to fit is what stops a short
  // set name rendering as a speck and a long one overflowing the rail.
  const REF_DPI = 120;
  const ref = await sharp(await render(REF_DPI).png().toBuffer()).metadata();
  if (!ref.width || !ref.height) return null;
  const scale = Math.min((alongRun * t.fill) / ref.width, acrossRun / ref.height);
  const dpi = Math.max(24, Math.min(t.maxDpi, Math.round(REF_DPI * scale)));

  let buf = await render(dpi).png().toBuffer();
  let m = await sharp(buf).metadata();
  // Rounding dpi can push it a hair over; clamp by resize rather than re-rendering in a loop.
  if (m.width > alongRun || m.height > acrossRun) {
    buf = await sharp(buf).resize(Math.min(m.width, alongRun), Math.min(m.height, acrossRun), { fit: 'inside' }).png().toBuffer();
    m = await sharp(buf).metadata();
  }
  if (t.rotate) {
    buf = await sharp(buf).rotate(t.rotate).png().toBuffer();
    m = await sharp(buf).metadata();
  }
  return { buffer: buf, width: m.width, height: m.height, dpi };
}

const escapeMarkup = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- the pipeline ---------------------------------------------------------------------------

async function readInput(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return fs.readFileSync(input);
  throw new Error('input must be a file path, Buffer or Uint8Array');
}

/**
 * @param input   file path | Buffer
 * @param meta    { productType, language, condition, setName, cardNumber, rarity } — all optional
 * @param options { variant, canvasSize, quality, cfg, cacheDir, detector, text, ...layout overrides }
 * @returns { buffer, width, height, contentHash, composeVersion, variant, layout, textLines, cached }
 */
export async function composeListingImage(input, meta = {}, options = {}) {
  const cfg = options.cfg || loadConfig();
  const variant = resolveVariant(meta, options, cfg);

  const avail = await composeAvailable(cfg, variant);
  if (!avail.ok) throw new ComposeUnavailable(avail.reasons);
  const sharp = await getSharp();

  const layout = resolveLayout(cfg, meta, options);
  if (options.quality != null) { /* already folded in by resolveLayout via LAYOUT_OVERRIDE_KEYS */ }
  const lines = railText(meta, layout);
  const assetDigest = railsDigest(variant) || '';
  const sourceBytes = await readInput(input);

  // Hash before any work: an unchanged input with unchanged layout is a cache hit, not a re-render.
  const contentHash = composeHash({ sourceBytes, layout, variant, textLines: avail.text ? lines : [], assetDigest });
  const version = composeVersion(variant, assetDigest);

  const cacheFile = options.cacheDir ? path.join(options.cacheDir, contentHash + '.jpg') : null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    return { buffer: fs.readFileSync(cacheFile), width: layout.canvas, height: layout.canvas, contentHash, composeVersion: version, variant, layout, textLines: lines, cached: true };
  }

  const { canvas, railWidth, cardBox } = layout;

  // 1–3. normalise (EXIF), flatten so a transparent PNG does not composite black, detect the card
  const base = sharp(sourceBytes, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' });
  const detector = options.detector || trimDetector;
  const srcMeta = await sharp(sourceBytes, { failOn: 'none' }).metadata();
  let region = null;
  try { region = await detector.detect(base.clone(), meta, layout); } catch { region = null; }
  if (region) {
    // A region covering the whole frame is what a detector returns when it found nothing to crop —
    // catalog art is already cut to the card, so this is the common case. Drop it rather than
    // running a no-op extract, and so `trimmed` in the result means what it says.
    const full = region.left === 0 && region.top === 0 && region.width === srcMeta.width && region.height === srcMeta.height;
    // Guard every detector, not just this one: a box that keeps almost nothing means detection
    // misfired, and a listing photo of a 40px sliver is worse than an untrimmed one.
    const srcArea = (srcMeta.width || 0) * (srcMeta.height || 0);
    const tooSmall = !srcArea || (region.width * region.height) / srcArea < layout.trimMinAreaRatio;
    if (full || tooSmall) region = null;
  }

  // 4. fit into the centre column
  let card = base.clone();
  if (region) card = card.extract(region);
  const cardBuf = await card
    .resize(cardBox.width, cardBox.height, { fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
    .toBuffer();
  const cardMeta = await sharp(cardBuf).metadata();

  // 5. compose: card, then rails over it, then the text over the rail
  const [left, right] = await Promise.all([
    loadRail(variant, 'left', railWidth, canvas),
    loadRail(variant, 'right', railWidth, canvas),
  ]);
  // Centred on the canvas, not measured off the rail: the card column is symmetric, so this stays
  // correct however railWidth and cardPaddingX are set. Deriving it from the rail edge silently
  // shifts the card by cardPaddingX the moment horizontal padding is non-zero.
  const layers = [
    { input: cardBuf, left: Math.round((canvas - cardMeta.width) / 2), top: Math.round((canvas - cardMeta.height) / 2) },
    { input: left, left: 0, top: 0 },
    { input: right, left: canvas - railWidth, top: 0 },
  ];

  const text = await renderTextLayer(sharp, lines, layout, cfg);
  if (text) {
    const railX = layout.text.rail === 'left' ? 0 : canvas - railWidth;
    layers.push({
      input: text.buffer,
      left: Math.round(railX + (railWidth - text.width) / 2),
      top: Math.round((canvas - text.height) / 2),
    });
  }

  // 6. encode. 4:4:4 is not a default worth accepting here: subsampled chroma smears holo foil and
  // small print, which is exactly what a buyer zooms into. Measured against 4:2:0 it also keeps the
  // rail art visibly cleaner (max channel error 35 vs 49).
  const buffer = await sharp({ create: { width: canvas, height: canvas, channels: 3, background: '#ffffff' } })
    .composite(layers)
    .jpeg({ quality: layout.quality, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();

  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = cacheFile + '.tmp' + process.pid;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, cacheFile);              // atomic; concurrent composers cannot tear a file
    } catch (e) { console.warn('[listing-image] cache write failed —', e?.message || e); }
  }

  return {
    buffer, width: canvas, height: canvas, contentHash, composeVersion: version, variant, layout,
    textLines: text ? lines : [], cached: false,
    card: { width: cardMeta.width, height: cardMeta.height, trimmed: !!region },
  };
}

// Convenience for callers that only need the key (e.g. a cache probe before fetching bytes).
export async function hashFor(sourceBytes, meta = {}, options = {}) {
  const cfg = options.cfg || loadConfig();
  const variant = resolveVariant(meta, options, cfg);
  const layout = resolveLayout(cfg, meta, options);
  const font = await fontProbe(cfg);
  const lines = font.ok ? railText(meta, layout) : [];
  const assetDigest = railsDigest(variant) || '';
  return {
    contentHash: composeHash({ sourceBytes, layout, variant, textLines: lines, assetDigest }),
    composeVersion: composeVersion(variant, assetDigest),
    variant,
  };
}
