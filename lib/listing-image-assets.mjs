// lib/listing-image-assets.mjs — rail art + font loading for the compositor.
//
// Two jobs, both of which exist because the failure modes here are SILENT:
//   · rails are normalised to the target width ONCE and memoised, so no per-image resampling ever
//     touches the branded art (that is what keeps every listing in the store looking identical);
//   · the font is PROBED rather than trusted, because sharp renders the wrong face without error.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, VARIANTS } from './listing-image-config.mjs';

export const RAILS_DIR = path.join(ROOT, 'rails');
// The VERTICAL rails. This list is load-bearing: railsDigest() hashes exactly these files and feeds
// the eBay content hash, so adding a side here re-keys every image on every live eBay listing.
export const SIDES = Object.freeze(['left', 'right']);
// The HORIZONTAL bands, kept in a separate list with a separate digest for that exact reason.
export const BAND_SIDES = Object.freeze(['top', 'bottom']);

// sharp is the repo's only native dependency and its only runtime dependency at all. Importing it
// lazily means a host without the binary still boots the dev server and still runs `pnpm test` —
// the compositor just reports itself unavailable and every call site falls through to the
// un-composed path (Golden Rule 7, applied to a dependency instead of an API).
let _sharp;
let _sharpError = null;
export async function getSharp() {
  if (_sharp !== undefined) return _sharp;
  try { _sharp = (await import('sharp')).default; }
  catch (e) { _sharpError = e?.message || String(e); _sharp = null; }
  return _sharp;
}
export const sharpError = () => _sharpError;

export const railPath = (variant, side) => path.join(RAILS_DIR, variant, side + '.png');

// --- rail art ---

const _railCache = new Map();      // `${variant}|${side}|${w}x${h}` -> PNG buffer
const _digestCache = new Map();    // variant -> sha256 of both source files

// sha256 over the RAW rail files (not the normalised output), so swapping in new art changes the
// content hash of every composite that uses it even if nobody bumped ASSET_VERSION.
export function railsDigest(variant) {
  if (_digestCache.has(variant)) return _digestCache.get(variant);
  const h = crypto.createHash('sha256');
  for (const side of SIDES) {
    const p = railPath(variant, side);
    if (!fs.existsSync(p)) return null;
    h.update(fs.readFileSync(p));
  }
  const d = h.digest('hex');
  _digestCache.set(variant, d);
  return d;
}

// Normalise the art to exactly width×height once, then hand out the same buffer forever. Accepts
// art authored at any scale (2× 600×3200 or native 300×1600) — the authoring size is the designer's
// call, not a code constraint. The invariant that matters is that this resize happens ONCE at load
// and never per image, so the branded art is byte-identical across every listing.
export async function loadRail(variant, side, width, height) {
  const key = `${variant}|${side}|${width}x${height}`;
  if (_railCache.has(key)) return _railCache.get(key);
  const sharp = await getSharp();
  if (!sharp) throw new Error('sharp unavailable: ' + _sharpError);
  const p = railPath(variant, side);
  if (!fs.existsSync(p)) throw new Error(`missing rail asset: ${path.relative(ROOT, p)}`);
  const src = sharp(p);
  const m = await src.metadata();
  const buf = (m.width === width && m.height === height)
    ? await src.png().toBuffer()
    : await src.resize(width, height, { kernel: 'lanczos3', fit: 'fill' }).png().toBuffer();
  _railCache.set(key, buf);
  return buf;
}

export function railsPresent(variant) {
  return SIDES.every((side) => fs.existsSync(railPath(variant, side)));
}

// --- horizontal bands (the Shopify 63:88 tile) ---
//
// Deliberately a parallel set of functions rather than a `sides` parameter on the ones above. The
// rail digest is an input to the eBay content hash; the band digest must never reach it, and the
// cheapest way to guarantee that is for the two to have no shared code path that someone could
// later "unify". A missing band must also never stop an eBay listing composing, which is why
// railsPresent() keeps meaning left+right and bandsPresent() is asked separately.

const _bandCache = new Map();     // `${variant}|${side}|${w}x${h}` -> PNG buffer
const _bandDigestCache = new Map();

export function bandsDigest(variant) {
  if (_bandDigestCache.has(variant)) return _bandDigestCache.get(variant);
  const h = crypto.createHash('sha256');
  for (const side of BAND_SIDES) {
    const p = railPath(variant, side);
    if (!fs.existsSync(p)) return null;
    h.update(fs.readFileSync(p));
  }
  const d = h.digest('hex');
  _bandDigestCache.set(variant, d);
  return d;
}

export function bandsPresent(variant) {
  return BAND_SIDES.every((side) => fs.existsSync(railPath(variant, side)));
}

// Same contract as loadRail: normalise to exactly width x height ONCE and hand out the same buffer
// forever, so the branded art never resamples per image.
export async function loadBand(variant, side, width, height) {
  const key = `${variant}|${side}|${width}x${height}`;
  if (_bandCache.has(key)) return _bandCache.get(key);
  const sharp = await getSharp();
  if (!sharp) throw new Error('sharp unavailable: ' + _sharpError);
  const p = railPath(variant, side);
  if (!fs.existsSync(p)) throw new Error(`missing band asset: ${path.relative(ROOT, p)}`);
  const src = sharp(p);
  const m = await src.metadata();
  const buf = (m.width === width && m.height === height)
    ? await src.png().toBuffer()
    : await src.resize(width, height, { kernel: 'lanczos3', fit: 'fill' }).png().toBuffer();
  _bandCache.set(key, buf);
  return buf;
}

export async function railMeta(variant, side) {
  const sharp = await getSharp();
  if (!sharp) return null;
  const p = railPath(variant, side);
  if (!fs.existsSync(p)) return null;
  try { const m = await sharp(p).metadata(); return { width: m.width, height: m.height, format: m.format }; }
  catch { return null; }
}

// Test seam + a way for the lab to pick up freshly-dropped art without a server restart.
export function clearAssetCache() {
  _railCache.clear(); _digestCache.clear(); _probeCache.clear();
  _bandCache.clear(); _bandDigestCache.clear();
}

// --- font ---

export const fontFile = (cfg) => path.resolve(ROOT, (cfg && cfg.font && cfg.font.file) || '');
export const fontFamily = (cfg) => (cfg && cfg.font && cfg.font.family) || '';

const PROBE_TEXT = 'JAPANESE · MEGA SYMPHONIA';
const _probeCache = new Map();

// Does the configured font ACTUALLY render, or is sharp quietly substituting?
//
// There is no error to catch: naming a family fontconfig cannot find falls back to the default face
// and returns a perfectly good image of the wrong font. So the probe renders the same string twice —
// once with the configured family+fontfile, once with the bare fallback — and compares pixels. If
// they match, the font did not load.
//
// Deliberately NOT a hardcoded pixel pin: libvips rasterises identically for a given build but not
// necessarily across builds, so a pin would fail on the server for a font that is working fine.
// Comparing against the fallback rendered by the SAME libvips is build-independent.
//
// Blind spot: if the configured font were also the system default sans, the two renders would match
// and the probe would wrongly report failure. That degrades to "rails without text", never to a
// wrong-font image, so it is the safe direction to be wrong in.
export async function fontProbe(cfg) {
  const family = fontFamily(cfg);
  const file = fontFile(cfg);
  const key = family + '|' + file;
  if (_probeCache.has(key)) return _probeCache.get(key);

  const out = { ok: false, family, file, reason: null };
  const sharp = await getSharp();
  if (!sharp) { out.reason = 'sharp unavailable: ' + _sharpError; _probeCache.set(key, out); return out; }
  if (!family) { out.reason = 'no font family configured'; _probeCache.set(key, out); return out; }
  if (!file || !fs.existsSync(file)) { out.reason = 'font file not found: ' + (file || '(unset)'); _probeCache.set(key, out); return out; }

  const raw = async (opts) => {
    const { data, info } = await sharp({ text: { text: PROBE_TEXT, dpi: 200, rgba: true, ...opts } }).raw().toBuffer({ resolveWithObject: true });
    return { fp: crypto.createHash('sha256').update(data).digest('hex').slice(0, 16), width: info.width, height: info.height };
  };
  try {
    const fallback = await raw({ font: 'sans' });
    const actual = await raw({ font: family, fontfile: file });
    out.fingerprint = actual.fp;
    out.width = actual.width;
    out.height = actual.height;
    if (actual.fp === fallback.fp) out.reason = `font '${family}' did not load — sharp substituted the default face (check the family name matches the TTF's internal name, not its filename)`;
    else out.ok = true;
  } catch (e) { out.reason = 'probe render failed: ' + (e?.message || e); }
  _probeCache.set(key, out);
  return out;
}

// --- readiness ---

// One structured answer to "can this host compose?", used by composeAvailable(), /api/status and
// the lab page. Never throws.
export async function assetsStatus(cfg) {
  const sharp = await getSharp();
  const variants = {};
  for (const v of VARIANTS) {
    const present = railsPresent(v);
    variants[v] = { present, digest: present ? (railsDigest(v) || null) : null };
    if (present && sharp) {
      variants[v].left = await railMeta(v, 'left');
      variants[v].right = await railMeta(v, 'right');
    }
    // Reported SEPARATELY, never merged into the rail entry above: band art is a fifth thing that
    // can be silently absent, and a host missing it must still be able to list on eBay.
    const bands = bandsPresent(v);
    variants[v].bands = { present: bands, digest: bands ? (bandsDigest(v) || null) : null };
    if (bands && sharp) {
      variants[v].bands.top = await railMeta(v, 'top');
      variants[v].bands.bottom = await railMeta(v, 'bottom');
    }
  }
  const font = await fontProbe(cfg);
  const svg = await svgProbe();
  return {
    sharp: sharp ? { available: true, sharp: sharp.versions.sharp, vips: sharp.versions.vips } : { available: false, error: _sharpError },
    rails: variants,
    font,
    svg,
    ready: !!sharp && font.ok && VARIANTS.every((v) => variants[v].present),
  };
}

// A FOURTH silent failure, alongside the font / rail art / sharp three (AGENTS.md §19). Scryfall
// serves its set icons as SVG, and a sharp built WITHOUT librsvg throws on one — loadSetArt catches,
// returns null, and the badge quietly comes out number-only with no error anywhere. Rasterise a
// two-pixel SVG once and report it, so the cause is visible in /api/status instead of being
// something you notice on a composed image weeks later.
let _svgProbe = null;
export async function svgProbe() {
  if (_svgProbe) return _svgProbe;
  const sharp = await getSharp();
  if (!sharp) return (_svgProbe = { ok: false, reason: 'sharp unavailable' });
  try {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0h2v2H0z"/></svg>');
    const m = await sharp(svg).png().toBuffer().then((b) => sharp(b).metadata());
    if (!(m.width > 0)) return (_svgProbe = { ok: false, reason: 'SVG rasterised to nothing' });
    return (_svgProbe = { ok: true, rsvg: sharp.versions.rsvg || null });
  } catch (e) {
    return (_svgProbe = { ok: false, reason: 'sharp has no SVG support (librsvg missing) — set symbols will be dropped: ' + (e?.message || e) });
  }
}
