// lib/sealed-images.mjs — listing photos for a SEALED pool.
//
// Sealed cannot reuse buildOfferImageUrls, for a reason sharper than the familiar FK one. cachedEps
// (lib/ebay-media.mjs) branches on `itemId` BEFORE it branches on `sourceUrl`, and `itemId == null`
// is a reserved sentinel meaning "the shared generic follow-us banner". So the obvious reuse —
// passing itemId:null for an entity that is not an inventory_item — returns the store banner as a
// cache hit and publishes it as the listing's lead image. Do not pass null there, and do not widen
// that function: the singles path is the only live publish path in the store and its cache rules
// carry three paragraphs of hard-won reasoning.
//
// So this file reimplements ~40 lines of cache logic against sealed_pool_images and imports every
// byte primitive from ebay-media.mjs. The listing unit is the POOL, because photos belong to the
// product rather than to one acquisition of it.
//
// Uploads happen at UPLOAD time, not publish time. By the time publish runs, every row already holds
// a live EPS url, which is what lets dry_run be a genuinely free preflight whose image count is
// exactly the count publish will see.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createImageFromFile, bytesFromUrl, bytesFromPath, ensureGenericImage, notExpired } from './ebay-media.mjs';

// ---- guards ----------------------------------------------------------------
// Catalog art arrives as an operator-typed URL that the SERVER fetches and then stores and replays,
// which is a different risk from the browser-driven /api/img proxy. Block the obvious SSRF targets.
// Hot-linking is not structurally possible anyway (the Media API takes multipart binary, not a URL),
// but the rule to hold is that the third-party URL is provenance only and never reaches eBay.
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.0\.0\.0$)/i;
export function isFetchableImageUrl(u) {
  let url;
  try { url = new URL(String(u || '')); } catch { return { ok: false, error: 'not a URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'only http and https are fetchable' };
  if (url.username || url.password) return { ok: false, error: 'credentials in the URL are not accepted' };
  if (PRIVATE_HOST.test(url.hostname)) return { ok: false, error: 'refusing to fetch a private or loopback address' };
  return { ok: true, url: url.href };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- reads -----------------------------------------------------------------
export function sealedImageRows(db, poolSku) {
  return db.prepare(`SELECT * FROM sealed_pool_images WHERE pool_sku = ? ORDER BY position, id`).all(poolSku);
}

// A live EPS url for these exact bytes, from ANY pool. Two pools of the same product, or an EN and a
// JP pool that share catalog art, upload once. Keyed on the composite hash when composed and on the
// source bytes otherwise, mirroring the singles rule: once branding is on, the hosted bytes are no
// longer a function of the source, so the composite's hash IS the identity of what eBay holds.
function liveEpsFor(db, { sha, composeHash }) {
  const row = composeHash
    ? db.prepare(`SELECT ebay_url, expires_at FROM sealed_pool_images WHERE compose_hash = ? AND ebay_url IS NOT NULL ORDER BY id DESC LIMIT 1`).get(composeHash)
    : db.prepare(`SELECT ebay_url, expires_at FROM sealed_pool_images WHERE sha256 = ? AND compose_hash IS NULL AND ebay_url IS NOT NULL ORDER BY id DESC LIMIT 1`).get(sha);
  return row && notExpired(row.expires_at) ? row : null;
}

// ---- write -----------------------------------------------------------------
/**
 * Take bytes (already fetched or decoded by the caller), retain the original, upload to EPS unless an
 * identical upload is still alive, and record the row. Never throws (GR7).
 * deps: { storeOriginal(buffer, ext) -> localPath } so this module does not import lib/listings.mjs
 *       (which imports lib/sealed.mjs, so the edge would close a cycle).
 */
export async function putSealedImage(env, db, { poolSku, buffer, filename, contentType, kind, sourceUrl, position }, deps = {}) {
  if (!buffer || !buffer.length) return { ok: false, error: 'empty image' };
  const sha = sha256(buffer);
  const ext = String(filename || 'jpg').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';

  // Retain the original for BOTH kinds. The third-party URL is the one thing here guaranteed to rot,
  // and retaining makes re-upload-on-expiry uniform across owner photos and catalog art.
  let localPath = null;
  try { localPath = deps.storeOriginal ? deps.storeOriginal(buffer, ext) : null; } catch { localPath = null; }

  const cached = liveEpsFor(db, { sha, composeHash: null });
  let epsUrl = cached ? cached.ebay_url : null;
  let expires = cached ? cached.expires_at : null;
  if (!epsUrl) {
    const up = await createImageFromFile(env, { buffer, filename: filename || ('sealed.' + ext), contentType });
    if (!up.ok) return { ok: false, error: up.error };
    epsUrl = up.eps_url; expires = up.expires_at;
  }

  const pos = position != null ? Number(position)
    : (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM sealed_pool_images WHERE pool_sku = ?`).get(poolSku).n);
  const info = db.prepare(`INSERT INTO sealed_pool_images
      (pool_sku, position, kind, local_path, source_url, ebay_url, sha256, expires_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(poolSku, pos, kind || (sourceUrl ? 'catalog' : 'owner'), localPath, sourceUrl || null, epsUrl, sha, expires || null);
  return { ok: true, id: Number(info.lastInsertRowid), ebay_url: epsUrl, expires_at: expires, sha256: sha, reused: !!cached, position: pos };
}

// ---- resolve for publish ---------------------------------------------------
/**
 * The image urls a publish should carry, refreshing any that expired. Returns
 * { imageUrls, hero, warnings }. Never throws.
 *
 * The generic banner is appended ONLY when a real image exists. That is load-bearing: publish refuses
 * when there are no images, and a banner-only array would be length 1 and sail past the refusal,
 * putting the store's follow-us graphic on the listing as its only picture.
 */
export async function resolveSealedImageUrls(env, db, cfg, saveCfg, poolSku) {
  const rows = sealedImageRows(db, poolSku);
  const imageUrls = [], warnings = [];
  for (const r of rows) {
    if (r.ebay_url && notExpired(r.expires_at)) { imageUrls.push(r.ebay_url); continue; }
    const got = r.local_path && fs.existsSync(r.local_path) ? bytesFromPath(r.local_path)
      : r.source_url ? await bytesFromUrl(r.source_url) : { ok: false, error: 'no retained bytes and no source url' };
    if (!got.ok) { warnings.push(`image ${r.id}: ${got.error}`); continue; }
    const up = await createImageFromFile(env, { buffer: got.buffer, filename: got.filename, contentType: got.contentType });
    if (!up.ok) { warnings.push(`image ${r.id}: ${up.error}`); continue; }
    // UPDATE in place. Inserting a second row would make `position` stop meaning anything.
    db.prepare(`UPDATE sealed_pool_images SET ebay_url = ?, expires_at = ? WHERE id = ?`).run(up.eps_url, up.expires_at || null, r.id);
    imageUrls.push(up.eps_url);
  }
  const hero = imageUrls[0] || null;
  if (hero) {
    try {
      const gen = await ensureGenericImage(env, cfg, saveCfg, db);
      if (gen && gen.eps) imageUrls.push(gen.eps);
    } catch { /* the banner is a nicety; never let it fail a publish (GR7) */ }
  }
  return { imageUrls, hero, warnings };
}
