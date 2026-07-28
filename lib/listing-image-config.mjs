// lib/listing-image-config.mjs — layout constants + config for the listing image compositor.
//
// eBay crops every gallery thumbnail to a square. A portrait card scan letterboxes, handing eBay
// two columns of dead space to fill however it likes. This module owns the geometry that fills them
// ourselves: a fixed-width branded rail either side of a centred card.
//
// FIXED RAILS, FLEXIBLE CARD. The rails are always exactly `railWidth` px, so the branded art is
// pixel-exact and never stretches; the card is fitted into whatever is left. The alternative —
// rails sized to the leftover space — makes the art scale per photo and the store stops looking
// like one set. That is the load-bearing decision in here.
//
// Split by design: ASSET_VERSION and the variant rules live in CODE (bumping ASSET_VERSION orphans
// every eBay-hosted image already on a live listing and forces a full re-upload of the store — that
// must be a deliberate commit, never a Settings field someone nudges). Geometry the owner may want
// to tune lives in data/listing-image.config.json and is whitelisted on the way in.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Bump when rail art or the geometry defaults change. It is an INPUT to the content hash, so a bump
// invalidates every cached composite and every listing_images row keyed on the old value — that is
// the point: a rebrand becomes one constant plus a batch run.
export const ASSET_VERSION = 'v1';

export const CANVAS = 1600;

// The one geometry object. Everything — compositor, CLI, lab, hash — reads the resolved form of this.
export const DEFAULT_LAYOUT = Object.freeze({
  canvas: CANVAS,
  railWidth: 300,
  cardPaddingY: 96,
  // trim() background threshold. 25, not 10: at 10 a card on a white background keeps a 1px bleed
  // of background (measured — 400x561 instead of 400x560). Catalog art is already tightly cropped
  // so trim is a no-op there either way; this only bites on owner photos.
  trimThreshold: 25,
  // A trim that keeps less than this fraction of the source area is rejected as a misfire and the
  // untrimmed image is used instead. trim() proved conservative in testing (it no-ops rather than
  // over-cropping) but a blown-out photo should never silently become a listing of nothing.
  trimMinAreaRatio: 0.15,
  quality: 88,
  text: Object.freeze({
    rail: 'right',        // which rail carries the metadata line
    color: '#c9a227',
    rotate: 90,           // clockwise; text reads top-to-bottom down the rail
    maxChars: 42,
    marginY: 64,          // gap from each canvas end, so the line never runs to the edge
    // The line is SIZED TO FIT, not set at a fixed point size: a fixed dpi that suits "BASE SET"
    // leaves "PRISMATIC EVOLUTIONS" either tiny or overflowing. `fill` is the fraction of the
    // available run the line should occupy; `railInset` keeps it off the rail's own edges.
    fill: 0.62,
    railInset: 0.22,      // fraction of railWidth kept clear either side of the line
    maxDpi: 420,          // cap, so a two-word set name does not render absurdly large
  }),
});

// Per-productType overrides. Slabs and sealed boxes have aspect ratios a card profile handles badly:
// a landscape ETB photo fitted into a 1000px column floats tiny in the middle of the canvas, so
// sealed gets narrower rails and less padding to claw back width.
export const PROFILES = Object.freeze({
  single: Object.freeze({}),
  slab: Object.freeze({ cardPaddingY: 72 }),
  sealed: Object.freeze({ railWidth: 220, cardPaddingY: 40 }),
});

// The rail art sets that exist on disk. Adding a variant means adding a directory under rails/.
export const VARIANTS = Object.freeze(['default', 'japanese', 'sealed']);
export const DEFAULT_VARIANT = 'default';

// Only these may be overridden from data/listing-image.config.json. `text` is handled separately.
export const LAYOUT_OVERRIDE_KEYS = Object.freeze(['railWidth', 'cardPaddingY', 'trimThreshold', 'trimMinAreaRatio', 'quality', 'canvas']);
export const TEXT_OVERRIDE_KEYS = Object.freeze(['rail', 'color', 'rotate', 'maxChars', 'marginY', 'fill', 'railInset', 'maxDpi']);

// --- config file (repo convention: data/<name>.config.json, seeded from a tracked .example) ---
const CONFIG_PATH = path.join(ROOT, 'data', 'listing-image.config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'data', 'listing-image.config.example.json');

export const DEFAULT_CONFIG = Object.freeze({
  // Master switch. Ships OFF: nothing about existing listings changes until the owner turns it on.
  enabled: false,
  applyTo: Object.freeze({ catalogArt: true, ownerPhotos: true }),
  font: Object.freeze({
    // BOTH are required and the family must be exact. sharp's `text.fontfile` adds the file to the
    // font set but `font` still selects the face through fontconfig: with font:'sans' the fontfile
    // is silently ignored, and a wrong family name silently substitutes a different face with no
    // error at all. Measured — 'Genty-Sans' substitutes where 'Genty Sans' does not. fontProbe()
    // exists because of this.
    family: 'Genty Sans',
    file: 'fonts/Genty-Sans-Regular.ttf',
  }),
  layoutOverrides: Object.freeze({}),
  textOverrides: Object.freeze({}),
  variantOverrides: Object.freeze({}),   // productType or language token -> variant name
});

export function ensureConfigSeeded() {
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_EXAMPLE_PATH)) {
      fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
      console.log('[listing-image] seeded data/listing-image.config.json from example');
    }
  } catch (e) { console.warn('[listing-image] config seed failed —', e?.message || e); }
}

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      ...DEFAULT_CONFIG, ...raw,
      applyTo: { ...DEFAULT_CONFIG.applyTo, ...(raw.applyTo || {}) },
      font: { ...DEFAULT_CONFIG.font, ...(raw.font || {}) },
      layoutOverrides: { ...(raw.layoutOverrides || {}) },
      textOverrides: { ...(raw.textOverrides || {}) },
      variantOverrides: { ...(raw.variantOverrides || {}) },
    };
  } catch { return { ...DEFAULT_CONFIG, applyTo: { ...DEFAULT_CONFIG.applyTo }, font: { ...DEFAULT_CONFIG.font }, layoutOverrides: {}, textOverrides: {}, variantOverrides: {} }; }
}

export function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);            // atomic, like lib/listings.mjs
}

// --- variant + layout resolution ---

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// Explicit option wins, then a rule on the meta, then 'default'. Owner overrides slot in ahead of
// the built-in rules so a new language can be pointed at existing art without a code change.
export function resolveVariant(meta = {}, options = {}, cfg = DEFAULT_CONFIG) {
  const explicit = options.variant;
  if (explicit) {
    if (!VARIANTS.includes(explicit)) throw new Error(`unknown rail variant '${explicit}' (have: ${VARIANTS.join(', ')})`);
    return explicit;
  }
  const overrides = (cfg && cfg.variantOverrides) || {};
  for (const token of [norm(meta.productType), norm(meta.language)]) {
    if (token && overrides[token] && VARIANTS.includes(overrides[token])) return overrides[token];
  }
  if (norm(meta.productType) === 'sealed') return 'sealed';
  if (norm(meta.language) === 'japanese' || norm(meta.language) === 'jp') return 'japanese';
  return DEFAULT_VARIANT;
}

const isInt = (v) => Number.isInteger(v);

// Throws on any geometry that cannot produce a valid canvas. Called on every resolve, so a bad
// override from the config or the lab fails loudly at the point of use rather than emitting a
// silently-wrong image.
export function validateLayout(l) {
  if (!isInt(l.canvas) || l.canvas < 200 || l.canvas > 6000) throw new Error(`canvas must be an integer 200–6000 (got ${l.canvas})`);
  if (!isInt(l.railWidth) || l.railWidth < 0) throw new Error(`railWidth must be a non-negative integer (got ${l.railWidth})`);
  if (!isInt(l.cardPaddingY) || l.cardPaddingY < 0) throw new Error(`cardPaddingY must be a non-negative integer (got ${l.cardPaddingY})`);
  const boxW = l.canvas - 2 * l.railWidth;
  const boxH = l.canvas - 2 * l.cardPaddingY;
  if (boxW < 100) throw new Error(`rails leave no room for the card: canvas ${l.canvas} - 2×${l.railWidth} = ${boxW}`);
  if (boxH < 100) throw new Error(`padding leaves no room for the card: canvas ${l.canvas} - 2×${l.cardPaddingY} = ${boxH}`);
  if (!(l.trimThreshold >= 0 && l.trimThreshold <= 255)) throw new Error(`trimThreshold must be 0–255 (got ${l.trimThreshold})`);
  if (!(l.trimMinAreaRatio > 0 && l.trimMinAreaRatio <= 1)) throw new Error(`trimMinAreaRatio must be >0 and ≤1 (got ${l.trimMinAreaRatio})`);
  if (!isInt(l.quality) || l.quality < 1 || l.quality > 100) throw new Error(`quality must be an integer 1–100 (got ${l.quality})`);
  if (!['left', 'right', 'none'].includes(l.text.rail)) throw new Error(`text.rail must be left|right|none (got ${l.text.rail})`);
  if (![0, 90, 180, 270].includes(l.text.rotate)) throw new Error(`text.rotate must be 0|90|180|270 (got ${l.text.rotate})`);
  if (!(l.text.fill > 0 && l.text.fill <= 1)) throw new Error(`text.fill must be >0 and ≤1 (got ${l.text.fill})`);
  if (!(l.text.railInset >= 0 && l.text.railInset < 0.5)) throw new Error(`text.railInset must be ≥0 and <0.5 (got ${l.text.railInset})`);
  if (!isInt(l.text.maxDpi) || l.text.maxDpi < 24) throw new Error(`text.maxDpi must be an integer ≥24 (got ${l.text.maxDpi})`);
  if (!isInt(l.text.marginY) || l.text.marginY < 0) throw new Error(`text.marginY must be a non-negative integer (got ${l.text.marginY})`);
  return l;
}

const pick = (src, keys) => { const o = {}; for (const k of keys) if (src && src[k] !== undefined) o[k] = src[k]; return o; };

// Defaults → productType profile → config overrides → per-call overrides. Returns ONE frozen object
// plus the derived boxes, so no caller ever recomputes geometry from raw constants.
export function resolveLayout(cfg = DEFAULT_CONFIG, meta = {}, options = {}) {
  const profile = PROFILES[norm(meta.productType)] || {};
  const merged = {
    ...DEFAULT_LAYOUT,
    ...profile,
    ...pick(cfg && cfg.layoutOverrides, LAYOUT_OVERRIDE_KEYS),
    ...pick(options, LAYOUT_OVERRIDE_KEYS),
    text: {
      ...DEFAULT_LAYOUT.text,
      ...pick(cfg && cfg.textOverrides, TEXT_OVERRIDE_KEYS),
      ...pick(options.text, TEXT_OVERRIDE_KEYS),
    },
  };
  if (options.canvasSize) merged.canvas = options.canvasSize;   // the documented public option name
  validateLayout(merged);
  merged.cardBox = Object.freeze({ width: merged.canvas - 2 * merged.railWidth, height: merged.canvas - 2 * merged.cardPaddingY });
  merged.text = Object.freeze(merged.text);
  return Object.freeze(merged);
}

// --- rail text ---

// Language + set name, e.g. "JAPANESE · MEGA SYMPHONIA". Deliberately NOT condition: an NM and an
// LP of one card are two stock rows, and putting condition on the rail would split them into two
// separately-hosted images for every card in the store.
export function railText(meta = {}, layout = DEFAULT_LAYOUT) {
  if (layout.text.rail === 'none') return [];
  const parts = [];
  const lang = String(meta.language || '').trim();
  const set = String(meta.setName || '').trim();
  if (lang) parts.push(lang.toUpperCase());
  if (set) parts.push(set.toUpperCase());
  if (!parts.length) return [];
  let line = parts.join(' · ');
  const max = layout.text.maxChars;
  // Trim the SET, never the language — the language is one short token and dropping characters off
  // it turns "JAPANESE" into "JAPANES", which reads as a typo rather than an abbreviation.
  if (line.length > max && parts.length === 2) {
    const room = max - (parts[0].length + 3) - 1;
    if (room >= 6) line = parts[0] + ' · ' + parts[1].slice(0, room).trimEnd() + '…';
    else line = parts[0];
  } else if (line.length > max) {
    line = line.slice(0, max - 1).trimEnd() + '…';
  }
  return [line];
}

// --- hashing ---

// Everything that can change a pixel, in a stable order. Note `cardBox` is derived, so it is
// excluded — including it would double-count railWidth and canvas.
export function layoutFingerprint(layout) {
  const { cardBox, ...rest } = layout;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

// contentHash = sha256 of every INPUT, never of the output bytes. libvips is deterministic for a
// given build but not across builds, so hashing output would make the same card hash differently on
// the dev box and the server; hashing inputs keeps the key stable by construction.
//
// The rendered TEXT LINES are part of the hash. Without them, an NM and an LP of one card — two
// stock rows, identical source bytes, identical variant — collide, and whichever composes first
// wins, so one card can end up wearing another card's branding.
//
// `assetDigest` covers the rail PNG bytes, so replacing rail art re-composes even if nobody
// remembered to bump ASSET_VERSION.
// Field separator, written as an ESCAPE so no literal NUL byte ever lands in a source file — the
// repo bans those outright (git treats the file as binary and vite's HTML parser rejects the page,
// while `node --check` happily tolerates one inside a string literal). A separator is not optional:
// without it, variant 'ab' with digest 'cd' hashes identically to variant 'a' with digest 'bcd'.
// NUL is the one byte that cannot occur in a hex digest, a JSON string or a variant name.
const SEP = String.fromCharCode(0);

export function composeHash({ sourceBytes, layout, variant, textLines = [], assetDigest = '' }) {
  return crypto.createHash('sha256')
    .update(sourceBytes)
    .update(SEP + layoutFingerprint(layout))
    .update(SEP + ASSET_VERSION)
    .update(SEP + variant)
    .update(SEP + JSON.stringify(textLines))
    .update(SEP + assetDigest)
    .digest('hex');
}

// The human-answerable audit token stored beside each hosted image: "which listings are still on
// the old art?" A hash alone cannot answer that.
export function composeVersion(variant, assetDigest = '') {
  return `${ASSET_VERSION}/${variant}` + (assetDigest ? '/' + assetDigest.slice(0, 8) : '');
}
