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
import { configFile } from './config-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Bump when rail art or the geometry defaults change. It is an INPUT to the content hash, so a bump
// invalidates every cached composite and every listing_images row keyed on the old value — that is
// the point: a rebrand becomes one constant plus a batch run.
export const ASSET_VERSION = 'v1';

// The black-star PROMO mark, used for every Black Star Promos set (the mark is unbranded — it names
// no set, so unlike a set symbol it may be shared). It fills the LEFT rail's logo slot on promo
// listings, because those sets have no wordmark anywhere: pokemontcg.io's "logo" for them is
// literally this star, and Bulbapedia carries none. ONE constant, not per-set URLs, so the whole
// store shows one identical star and the compositor can recognise it by equality (that equality is
// what gates the inverted-star treatment below).
export const PROMO_STAR_URL = 'https://images.pokemontcg.io/svp/symbol.png';

export const CANVAS = 1600;

// The one geometry object. Everything — compositor, CLI, lab, hash — reads the resolved form of this.
export const DEFAULT_LAYOUT = Object.freeze({
  canvas: CANVAS,
  railWidth: 300,
  cardPaddingY: 96,
  // Horizontal breathing room between the rails and the card. Without it a standard card is
  // width-constrained by the column and its edge sits hard against the rail, which reads as a
  // printing error rather than a mat — and on eBay's white page the card's own white border is the
  // only thing separating artwork from near-black chrome.
  cardPaddingX: 48,
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
    // 0.52, not more: the mark sits at the TOP of both rails and the set badge at the bottom of the
    // right one, so the middle third is all the set name may safely occupy.
    fill: 0.52,
    // 0.12, not 0.22: the cross-axis budget is shared by ALL lines, so a two-line rail
    // ("JAPANESE" over "ABYSS EYE") gets half of it each and shrinks visibly at a wide inset.
    // A single line is bound by the along-run `fill` instead, so loosening this does not blow it up.
    railInset: 0.12,      // fraction of railWidth kept clear either side of the text block
    maxDpi: 420,          // cap, so a two-word set name does not render absurdly large
  }),
  // The set symbol + the card's printed number, at the foot of the right rail. Together they say
  // which printing this is — the two things a collector checks after the name, and the pair a
  // thumbnail otherwise makes unreadable.
  badge: Object.freeze({
    rail: 'right',
    symbolFraction: 0.42,   // of railWidth
    numberFill: 0.74,       // number width as a fraction of railWidth
    gap: 16,                // between symbol and number
    marginBottom: 104,      // clear of the canvas edge
    color: '#efe8f6',
    maxDpi: 200,
  }),
  // The set LOGO — the wordmark, not the symbol — at the foot of the LEFT rail, mirroring the badge
  // opposite it. English sets have both; the logo is wide rather than square, so it gets its own box
  // and keeps its aspect instead of being squeezed into the symbol's.
  logo: Object.freeze({
    rail: 'left',
    widthFraction: 0.80,    // of railWidth
    heightFraction: 0.62,   // of railWidth — a box, so a tall logo cannot run up the rail
    marginBottom: 104,
  }),
});

// Per-productType overrides. Slabs and sealed boxes have aspect ratios a card profile handles badly:
// a landscape ETB photo fitted into a 1000px column floats tiny in the middle of the canvas, so
// sealed gets narrower rails and less padding to claw back width.
export const PROFILES = Object.freeze({
  single: Object.freeze({}),
  slab: Object.freeze({ cardPaddingY: 72 }),
  sealed: Object.freeze({ railWidth: 220, cardPaddingY: 40, cardPaddingX: 24 }),
});

// The rail art sets that exist on disk. Adding a variant means adding a directory under rails/.
export const VARIANTS = Object.freeze(['default', 'japanese', 'sealed']);
export const DEFAULT_VARIANT = 'default';

// Only these may be overridden from data/listing-image.config.json. `text` is handled separately.
export const LAYOUT_OVERRIDE_KEYS = Object.freeze(['railWidth', 'cardPaddingY', 'cardPaddingX', 'trimThreshold', 'trimMinAreaRatio', 'quality', 'canvas']);
export const TEXT_OVERRIDE_KEYS = Object.freeze(['rail', 'color', 'rotate', 'maxChars', 'marginY', 'fill', 'railInset', 'maxDpi']);
export const BADGE_OVERRIDE_KEYS = Object.freeze(['rail', 'symbolFraction', 'numberFill', 'gap', 'marginBottom', 'color', 'maxDpi']);
export const LOGO_OVERRIDE_KEYS = Object.freeze(['rail', 'widthFraction', 'heightFraction', 'marginBottom']);

// --- config file (repo convention: data/<name>.config.json, seeded from a tracked .example) ---
const CONFIG_PATH = configFile('listing-image.config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'data', 'listing-image.config.example.json');

export const DEFAULT_CONFIG = Object.freeze({
  // Master switch. Ships OFF: nothing about existing listings changes until the owner turns it on.
  enabled: false,
  applyTo: Object.freeze({ catalogArt: true, ownerPhotos: true }),
  // How the PROMO star is drawn. The art comes off the CDN black; the default rails run
  // #2e1640 → #150a1d, so 'inverted' (white star, dark PROMO lettering) is the default — 'normal'
  // exists for a future light rail variant, where black is the readable one. Owner-set in settings;
  // the star's pixels feed the content hash, so flipping this re-composes (and re-uploads) every
  // promo listing on its next pass.
  promoStar: 'inverted',
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
  badgeOverrides: Object.freeze({}),
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
      // Two states only: anything that is not the explicit opt-out is the default. A typo must not
      // silently become a third rendering mode.
      promoStar: raw.promoStar === 'normal' ? 'normal' : 'inverted',
      layoutOverrides: { ...(raw.layoutOverrides || {}) },
      textOverrides: { ...(raw.textOverrides || {}) },
      badgeOverrides: { ...(raw.badgeOverrides || {}) },
      variantOverrides: { ...(raw.variantOverrides || {}) },
    };
  } catch { return { ...DEFAULT_CONFIG, applyTo: { ...DEFAULT_CONFIG.applyTo }, font: { ...DEFAULT_CONFIG.font }, layoutOverrides: {}, textOverrides: {}, badgeOverrides: {}, variantOverrides: {} }; }
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
  if (!isInt(l.cardPaddingX) || l.cardPaddingX < 0) throw new Error(`cardPaddingX must be a non-negative integer (got ${l.cardPaddingX})`);
  const boxW = l.canvas - 2 * l.railWidth - 2 * l.cardPaddingX;
  const boxH = l.canvas - 2 * l.cardPaddingY;
  if (boxW < 100) throw new Error(`rails leave no room for the card: canvas ${l.canvas} - 2×${l.railWidth} - 2×${l.cardPaddingX} = ${boxW}`);
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
  const b = l.badge;
  if (!['left', 'right', 'none'].includes(b.rail)) throw new Error(`badge.rail must be left|right|none (got ${b.rail})`);
  if (!(b.symbolFraction > 0 && b.symbolFraction <= 1)) throw new Error(`badge.symbolFraction must be >0 and ≤1 (got ${b.symbolFraction})`);
  if (!(b.numberFill > 0 && b.numberFill <= 1)) throw new Error(`badge.numberFill must be >0 and ≤1 (got ${b.numberFill})`);
  if (!isInt(b.gap) || b.gap < 0) throw new Error(`badge.gap must be a non-negative integer (got ${b.gap})`);
  if (!isInt(b.marginBottom) || b.marginBottom < 0) throw new Error(`badge.marginBottom must be a non-negative integer (got ${b.marginBottom})`);
  if (!isInt(b.maxDpi) || b.maxDpi < 24) throw new Error(`badge.maxDpi must be an integer ≥24 (got ${b.maxDpi})`);
  const g = l.logo;
  if (!['left', 'right', 'none'].includes(g.rail)) throw new Error(`logo.rail must be left|right|none (got ${g.rail})`);
  if (!(g.widthFraction > 0 && g.widthFraction <= 1)) throw new Error(`logo.widthFraction must be >0 and ≤1 (got ${g.widthFraction})`);
  if (!(g.heightFraction > 0 && g.heightFraction <= 2)) throw new Error(`logo.heightFraction must be >0 and ≤2 (got ${g.heightFraction})`);
  if (!isInt(g.marginBottom) || g.marginBottom < 0) throw new Error(`logo.marginBottom must be a non-negative integer (got ${g.marginBottom})`);
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
    badge: {
      ...DEFAULT_LAYOUT.badge,
      ...pick(cfg && cfg.badgeOverrides, BADGE_OVERRIDE_KEYS),
      ...pick(options.badge, BADGE_OVERRIDE_KEYS),
    },
    logo: {
      ...DEFAULT_LAYOUT.logo,
      ...pick(cfg && cfg.logoOverrides, LOGO_OVERRIDE_KEYS),
      ...pick(options.logo, LOGO_OVERRIDE_KEYS),
    },
  };
  if (options.canvasSize) merged.canvas = options.canvasSize;   // the documented public option name
  validateLayout(merged);
  merged.cardBox = Object.freeze({ width: merged.canvas - 2 * merged.railWidth - 2 * merged.cardPaddingX, height: merged.canvas - 2 * merged.cardPaddingY });
  merged.text = Object.freeze(merged.text);
  merged.badge = Object.freeze(merged.badge);
  merged.logo = Object.freeze(merged.logo);
  return Object.freeze(merged);
}

// --- rail text ---

// The set name, e.g. "PITCH BLACK" — with the language prefixed ONLY when it is not English
// ("JAPANESE · MEGA SYMPHONIA"). English is the store's default and the overwhelming majority of
// stock, so printing it on every rail is noise that costs space the set name wants; a non-English
// printing is the thing a buyer needs told, because it changes what the card is worth.
//
// Deliberately NOT condition: an NM and an LP of one card are two stock rows, and putting condition
// on the rail would split them into two separately-hosted images for every card in the store.
const isEnglish = (lang) => {
  const s = String(lang || '').trim().toLowerCase();
  return !s || s === 'english' || s === 'en' || s === 'eng';
};

// Can the bundled rail font actually draw this?
//
// The font is Latin-only, and Pango does NOT fail on a glyph it lacks — it silently substitutes a
// SYSTEM font. On the Windows dev box that renders Japanese perfectly; on a Linux server with no
// CJK font installed the same string is blank boxes, and nothing in the pipeline would say so.
// Same class of silent substitution as the fontProbe case, one level down.
//
// So a line the bundled font cannot draw is dropped rather than gambled on. A JP card still gets
// "JAPANESE" plus its symbol and number; it just does not get a set name we cannot render.
const RAIL_DRAWABLE = /^[\p{Script=Latin}\p{Nd}\s'&.,:/()+—–\-·!?#]*$/u;
export const isRailDrawable = (s) => RAIL_DRAWABLE.test(String(s == null ? '' : s));

// Two lines, every listing:
//   1. the CARD NAME     — what the buyer is looking at
//   2. the SET NAME      — with a language marker appended for anything non-English ("ABYSS EYE (JP)")
//
// Returns ONE LINE PER ELEMENT, never a joined string: the type is sized to the longest line, so two
// short lines render bigger down a 300px rail than one long one. Rotated onto the rail they read as
// two stacked columns.
//
// Line 2 is optional — 146 JP sets have no romanised name, and a set name we cannot draw is dropped
// rather than gambled on (see isRailDrawable). A non-English card with no usable set name keeps its
// language on that line instead, because "which printing is this" is the thing a JP buyer checks.
const langMarker = (lang) => {
  const s = String(lang || '').trim();
  if (!s || isEnglish(s)) return '';
  const two = { japanese: 'JP', korean: 'KO', chinese: 'ZH', german: 'DE', french: 'FR', italian: 'IT', spanish: 'ES', portuguese: 'PT', russian: 'RU' }[s.toLowerCase()];
  return two || (s.length <= 3 ? s.toUpperCase() : s.slice(0, 2).toUpperCase());
};

export function railText(meta = {}, layout = DEFAULT_LAYOUT) {
  if (layout.text.rail === 'none') return [];
  const max = layout.text.maxChars;
  const clip = (s) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);
  const lines = [];

  const card = String(meta.cardName || '').trim();
  if (card && isRailDrawable(card)) lines.push(clip(card.toUpperCase()));

  const lang = String(meta.language || '').trim();
  const marker = langMarker(lang);
  const set = String(meta.setName || '').trim();
  if (set && isRailDrawable(set)) {
    // Clip the SET, then append the marker, so the marker can never be the thing that gets cut —
    // "ABYSS EY… (JP)" still says which printing it is; "ABYSS EYE (J…" does not.
    const suffix = marker ? ` (${marker})` : '';
    lines.push(clip(set.toUpperCase().slice(0, Math.max(1, max - suffix.length))) + suffix);
  } else if (marker && /^\p{L}+$/u.test(lang)) {
    // Only a language WORD ("Japanese"), never a raw code. ebayLanguageName passes through anything
    // it does not recognise, so a row carrying "zh-cn" would otherwise print "ZH-CN" down the rail.
    lines.push(lang.toUpperCase());
  }
  return lines;
}

// --- hashing ---

// Everything that can change a pixel, in a stable order. Note `cardBox` is derived, so it is
// excluded — including it would double-count railWidth and canvas.
// Key-sorted at EVERY level, hand-rolled rather than via JSON.stringify's replacer.
//
// The replacer-array form (`JSON.stringify(o, Object.keys(o).sort())`) looks like "serialise these
// keys in this order" but is really a RECURSIVE property allowlist: applied to a nested object it
// keeps only properties whose names also appear in the array. With only top-level names in the list,
// the whole `text` and `badge` blocks serialised to `{}` — so restyling the rail text or moving the
// set badge changed no pixels in the hash, and every cached composite and hosted eBay image would
// have kept the old art with nothing to say why.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

export function layoutFingerprint(layout) {
  const { cardBox, ...rest } = layout;   // derived from railWidth/canvas/padding — double counting
  return stable(rest);
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

export function composeHash({ sourceBytes, layout, variant, textLines = [], assetDigest = '', badge = '' }) {
  return crypto.createHash('sha256')
    .update(sourceBytes)
    .update(SEP + layoutFingerprint(layout))
    .update(SEP + ASSET_VERSION)
    .update(SEP + variant)
    .update(SEP + JSON.stringify(textLines))
    .update(SEP + assetDigest)
    // The rendered badge (card number + a digest of the set symbol). Two cards from one set share
    // art only if they also share a number — and once the number is drawn on the rail, leaving it
    // out of the key is the same collision the rail text already had to fix.
    .update(SEP + badge)
    .digest('hex');
}

// The human-answerable audit token stored beside each hosted image: "which listings are still on
// the old art?" A hash alone cannot answer that.
export function composeVersion(variant, assetDigest = '') {
  return `${ASSET_VERSION}/${variant}` + (assetDigest ? '/' + assetDigest.slice(0, 8) : '');
}
