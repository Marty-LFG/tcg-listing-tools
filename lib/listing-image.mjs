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
import { fetchCached } from './img-cache.mjs';
import {
  ASSET_VERSION, DEFAULT_CONFIG, VARIANTS, PROMO_STAR_URL,
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

// --- set badge (symbol + printed card number, foot of the right rail) --------------------------

// images.scrydex.com answers 200 with this generic 186KB PNG for any id it does not have — an empty
// one, a Japanese set id, a typo. A 200 that is a valid image is indistinguishable from a hit unless
// you look at the bytes, so without this check a JP card would quietly get a grey blob where its set
// symbol should be. Compared by content, so it catches the same placeholder served from any URL.
const CDN_PLACEHOLDER_SHA = 'fd7c3800f9b8';

// Set art comes off a CDN, so it goes through the shared disk cache: the second listing from a set
// is a local read. Returns null on anything going wrong — missing art costs the rail an icon, never
// the listing its image.
// Scryfall publishes its set icons as monochrome SVG <path>s carrying NO fill attribute, so librsvg
// rasterises them BLACK — every pixel, verified: 26190 of 26190 opaque pixels on hob.svg. Both rails
// run #2e1640 → #150a1d, so a black symbol on them is an INVISIBLE symbol. `.tint()` cannot fix it:
// tint multiplies, and black times anything is still black. Keep the glyph's ALPHA (which carries the
// shape and its antialiasing) and replace the colour channels outright.
//
// Pokémon never hits this — Bulbapedia serves full-colour PNGs — which is why this is gated on the
// SOURCE FORMAT rather than on the game: a PNG takes neither this branch nor the digest change, so
// every existing composite stays bit-identical and no ASSET_VERSION bump is needed.
export async function recolourGlyph(sharp, pngBuffer, hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex == null ? '' : hex).trim());
  if (!m) return pngBuffer;
  const [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function loadSetArt(sharp, url, box, fill, invert = false) {
  if (!url) return null;
  try {
    const got = await fetchCached(url);
    if (!got.buffer) return null;
    let digest = crypto.createHash('sha256').update(got.buffer).digest('hex').slice(0, 12);
    if (digest === CDN_PLACEHOLDER_SHA) return null;
    const isSvg = (await sharp(got.buffer, { failOn: 'none' }).metadata()).format === 'svg';
    let buffer = await sharp(got.buffer, { failOn: 'none' })
      // fit:'inside' on a WxH box, not a square: set logos are wide, symbols are square-ish, and
      // forcing either into the other's shape is worse than letting each keep its aspect.
      .resize(box.width, box.height, { fit: 'inside', withoutEnlargement: false })
      .png().toBuffer();
    if (isSvg && fill) {
      buffer = await recolourGlyph(sharp, buffer, fill);
      // The recolour is a PIXEL change the source digest cannot see, so fold the fill in — otherwise
      // re-tuning badge.color would serve every already-composed image from the old cache entry.
      digest = crypto.createHash('sha256').update(digest + '|' + fill).digest('hex').slice(0, 12);
    }
    if (invert) {
      // The promo star's inverted treatment: negate RGB, keep alpha, so the black star body goes
      // white and the white PROMO lettering reads dark — the shape and its antialiasing live in the
      // alpha channel and are untouched. Not recolourGlyph: that flattens to one colour and would
      // erase the lettering with it.
      buffer = await sharp(buffer).negate({ alpha: false }).png().toBuffer();
      // Same rule as the fill above: a pixel change the source digest cannot see gets folded in,
      // so flipping the promoStar setting re-composes rather than serving the old cache entry.
      digest = crypto.createHash('sha256').update(digest + '|neg').digest('hex').slice(0, 12);
    }
    const m = await sharp(buffer).metadata();
    return { buffer, width: m.width, height: m.height, digest };
  } catch { return null; }
}

// The symbol/logo pair, resolved ONCE. composeListingImage and hashFor both need it and both feed
// its digests into the content hash, so any divergence between them means a cache probe reports a
// hit for an image the real compose would render differently. They used to derive it twice by hand,
// and the two copies had already drifted (hashFor carried an extra `sharp &&` on both calls).
// loadSetArt must be called from HERE and nowhere else — test/invariants/listing-image.test.mjs
// pins that.
async function resolveSetArt(sharp, meta, layout, wantBadge, cfg = DEFAULT_CONFIG) {
  const symSize = Math.round(layout.railWidth * layout.badge.symbolFraction);
  const symbol = sharp && wantBadge
    ? await loadSetArt(sharp, meta.setSymbolUrl, { width: symSize, height: symSize }, layout.badge.color)
    : null;
  // The inverted-star treatment applies to the PROMO star and nothing else — recognised by URL
  // equality, so a genuine wordmark can never be negated by accident. See PROMO_STAR_URL.
  const invertLogo = meta.setLogoUrl === PROMO_STAR_URL && (cfg && cfg.promoStar) !== 'normal';
  const setLogo = sharp && layout.logo.rail !== 'none'
    ? await loadSetArt(sharp, meta.setLogoUrl, {
      width: Math.round(layout.railWidth * layout.logo.widthFraction),
      height: Math.round(layout.railWidth * layout.logo.heightFraction),
    }, layout.badge.color, invertLogo)
    : null;
  return { symbol, setLogo };
}

// Horizontal (unrotated) line, sized to a fraction of the rail's width.
async function renderBadgeNumber(sharp, text, layout, cfg) {
  if (!text) return null;
  const probe = await fontProbe(cfg);
  if (!probe.ok) return null;
  const b = layout.badge;
  const budget = Math.round(layout.railWidth * b.numberFill);
  if (budget <= 0) return null;
  const markup = `<span foreground="${b.color}">${escapeMarkup(text)}</span>`;
  const render = (dpi) => sharp({ text: { text: markup, font: fontFamily(cfg), fontfile: fontFile(cfg), dpi, rgba: true } });
  const REF_DPI = 120;
  const ref = await sharp(await render(REF_DPI).png().toBuffer()).metadata();
  if (!ref.width) return null;
  const dpi = Math.max(24, Math.min(b.maxDpi, Math.round(REF_DPI * (budget / ref.width))));
  const buffer = await render(dpi).png().toBuffer();
  const m = await sharp(buffer).metadata();
  return { buffer, width: m.width, height: m.height };
}

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
  const lines = railText(meta, layout);
  const assetDigest = railsDigest(variant) || '';
  const sourceBytes = await readInput(input);

  // The badge has to be RESOLVED before the hash, not after: both the number and the symbol end up
  // as pixels, so a key computed without them would serve one printing's image for another's.
  const wantBadge = layout.badge.rail !== 'none' && (meta.cardNumber || meta.setSymbolUrl);
  const { symbol, setLogo } = await resolveSetArt(sharp, meta, layout, wantBadge, cfg);
  const badgeNumber = wantBadge && avail.text ? String(meta.cardNumber || '') : '';

  const badgeKey = `${wantBadge ? badgeNumber : ''}|${symbol ? symbol.digest : ''}|${setLogo ? setLogo.digest : ''}`;

  // Hash before any work: an unchanged input with unchanged layout is a cache hit, not a re-render.
  const contentHash = composeHash({ sourceBytes, layout, variant, textLines: avail.text ? lines : [], assetDigest, badge: badgeKey });
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

  // Set badge: symbol above the printed number, stacked at the foot of its rail. Built bottom-up so
  // the block keeps its distance from the canvas edge however tall the pieces turn out.
  const number = wantBadge ? await renderBadgeNumber(sharp, badgeNumber, layout, cfg) : null;
  if (symbol || number) {
    const b = layout.badge;
    const railX = b.rail === 'left' ? 0 : canvas - railWidth;
    const numberH = number ? number.height : 0;
    const symbolH = symbol ? symbol.height : 0;
    const stackH = symbolH + (symbol && number ? b.gap : 0) + numberH;
    let y = canvas - b.marginBottom - stackH;
    if (symbol) {
      layers.push({ input: symbol.buffer, left: Math.round(railX + (railWidth - symbol.width) / 2), top: Math.round(y) });
      y += symbolH + b.gap;
    }
    if (number) layers.push({ input: number.buffer, left: Math.round(railX + (railWidth - number.width) / 2), top: Math.round(y) });
  }

  // The set logo, mirroring the badge at the foot of the opposite rail.
  if (setLogo) {
    const g = layout.logo;
    const railX = g.rail === 'right' ? canvas - railWidth : 0;
    layers.push({
      input: setLogo.buffer,
      left: Math.round(railX + (railWidth - setLogo.width) / 2),
      top: Math.round(canvas - g.marginBottom - setLogo.height),
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
    badge: { number: number ? badgeNumber : '', symbol: !!symbol, logo: !!setLogo },
    card: { width: cardMeta.width, height: cardMeta.height, trimmed: !!region },
  };
}

// Convenience for callers that only need the key (e.g. a cache probe before fetching bytes).
// Must mirror composeListingImage's inputs EXACTLY, badge included, or a probe says "hit" for an
// image the real compose would render differently.
export async function hashFor(sourceBytes, meta = {}, options = {}) {
  const cfg = options.cfg || loadConfig();
  const variant = resolveVariant(meta, options, cfg);
  const layout = resolveLayout(cfg, meta, options);
  const font = await fontProbe(cfg);
  const lines = font.ok ? railText(meta, layout) : [];
  const assetDigest = railsDigest(variant) || '';
  const sharp = await getSharp();
  const wantBadge = layout.badge.rail !== 'none' && (meta.cardNumber || meta.setSymbolUrl);
  const { symbol, setLogo } = await resolveSetArt(sharp, meta, layout, wantBadge, cfg);
  const badge = `${wantBadge && font.ok ? String(meta.cardNumber || '') : ''}|${symbol ? symbol.digest : ''}|${setLogo ? setLogo.digest : ''}`;
  return {
    contentHash: composeHash({ sourceBytes, layout, variant, textLines: lines, assetDigest, badge }),
    composeVersion: composeVersion(variant, assetDigest),
    variant,
  };
}
