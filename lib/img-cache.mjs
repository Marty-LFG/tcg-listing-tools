// lib/img-cache.mjs — the content-addressed disk cache for remote images.
//
// Extracted from the `/api/img` middleware in vite.config.js so the compositor can share it. That is
// not tidying: the compose pipeline has to hash the SOURCE BYTES to work out its cache key, so it
// must download before it can decide whether it has work to do. Routing that through the same cache
// as the browser proxy turns the second and later fetches of a card's art into a local read.
//
// Card images are content-addressed upstream and effectively immutable, so entries live for a month.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IMG_CACHE_DIR = path.join(ROOT, 'data', 'img-cache');
export const IMG_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30d — re-fetch monthly in case one is replaced at the same URL
export const IMG_CT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' };

// sha1 of the URL plus the original extension, so the on-disk name still says what it is.
export function imgCacheFile(u, dir = IMG_CACHE_DIR) {
  const ext = ((String(u).match(/\.(png|jpe?g|webp|avif|gif)(?:[?#]|$)/i) || [])[1] || '').toLowerCase();
  const name = crypto.createHash('sha1').update(String(u)).digest('hex') + (ext ? '.' + ext : '');
  return { file: path.join(dir, name), ext };
}

// Returns { buffer, ext, age } for a cache entry, or null. `allowStale` returns an expired entry
// rather than nothing — the proxy uses it to serve an old copy when a refetch fails, which is the
// difference between a slightly stale thumbnail and a broken one.
export function readCached(u, { allowStale = false, dir = IMG_CACHE_DIR } = {}) {
  const { file, ext } = imgCacheFile(u, dir);
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (!allowStale && age >= IMG_TTL_MS) return null;
    return { buffer: fs.readFileSync(file), ext, age };
  } catch { return null; }
}

export function writeCached(u, buffer, { dir = IMG_CACHE_DIR } = {}) {
  const { file } = imgCacheFile(u, dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);          // atomic: a concurrent reader never sees a half-written image
    return true;
  } catch { return false; }
}

/**
 * Fetch through the cache. Returns { buffer, contentType, status } where status is
 * 'hit' | 'miss' | 'stale' | 'error'.
 *
 * Only a response that is genuinely an image gets cached — an upstream error page is HTML with a
 * 200 often enough that caching on status alone poisons the directory with junk that then looks
 * like a hit forever.
 */
export async function fetchCached(u, { dir = IMG_CACHE_DIR, fetchImpl = fetch } = {}) {
  const fresh = readCached(u, { dir });
  if (fresh) return { buffer: fresh.buffer, contentType: IMG_CT[fresh.ext] || 'image/jpeg', status: 'hit' };

  // A real User-Agent, not optional politeness: cards.scryfall.io started answering a UA-less
  // request with 400 (verified 2026-08-15 — {} → 400 text/html, with UA → 200 image/jpeg), which
  // broke every MTG compose whose art was not already on disk. Named per Scryfall's API policy.
  const headers = { 'User-Agent': 'TCGListingTools/1.0 (Binders Keepers listing images)', Accept: 'image/*' };
  const r = await fetchImpl(u, { headers }).catch(() => null);
  const ct = (r && r.headers.get('content-type')) || '';
  if (r && r.ok && /^image\//i.test(ct)) {
    const buffer = Buffer.from(await r.arrayBuffer());
    writeCached(u, buffer, { dir });
    return { buffer, contentType: ct, status: 'miss' };
  }

  const stale = readCached(u, { allowStale: true, dir });
  if (stale) return { buffer: stale.buffer, contentType: IMG_CT[stale.ext] || 'image/jpeg', status: 'stale' };
  return { buffer: null, contentType: null, status: 'error', httpStatus: r ? r.status : 502 };
}
