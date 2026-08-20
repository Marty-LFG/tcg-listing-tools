// lib/ebay-media.mjs — eBay Media API image hosting + the listing image pipeline.
//
// eBay requires listing images to be on its own servers (EPS). Rather than hand eBay a CDN URL to
// fetch (which breaks the listing if the CDN is ever down), we DOWNLOAD the bytes and UPLOAD the
// binary via the Media API (createImageFromFile) — pure outbound HTTPS, so a LAN host works. eBay
// then hosts the image permanently for the listing's life + 90 days. Owner photos (for played cards)
// take the same path, and every listing appends a configurable generic "follow us" image last.
//
// Scope sell.inventory (already held); host apim.ebay.com; not available in Sandbox; 50 POSTs/5s.
// UploadSiteHostedPictures (Trading) is decommissioned 2026-09-30 — do not use it.
import fs from 'node:fs';
import { ebayRest, firstErrorText } from './ebay-rest.mjs';
import { fetchCached } from './img-cache.mjs';
import { composeListingImage, ComposeUnavailable } from './listing-image.mjs';

const MEDIA = 'https://apim.ebay.com/commerce/media/v1_beta';

const extType = (name = '') => {
  const e = String(name).toLowerCase().split('.').pop();
  return e === 'png' ? 'image/png' : e === 'gif' ? 'image/gif' : e === 'webp' ? 'image/webp' : 'image/jpeg';
};

// createImageFromFile: POST the binary, then GET the returned resource for { imageUrl, expirationDate }.
// Returns { ok, eps_url, expires_at, error }.
export async function createImageFromFile(env, { buffer, filename = 'card.jpg', contentType } = {}) {
  if (!buffer || !buffer.length) return { ok: false, error: 'empty image buffer' };
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: contentType || extType(filename) }), filename);
  const post = await ebayRest(env, 'POST', MEDIA + '/image/create_image_from_file', { form, timeoutMs: 45000 });
  if (!post.ok) return { ok: false, error: firstErrorText(post.json) || ('HTTP ' + post.httpStatus) };
  // The image id URI comes back in the Location header; the body may also carry it.
  const loc = post.location || (post.json && (post.json.imageUrl || post.json.image_id));
  let eps_url = post.json && post.json.imageUrl;
  let expires_at = post.json && post.json.expirationDate;
  if ((!eps_url || !expires_at) && loc && /^https?:\/\//.test(loc)) {
    const get = await ebayRest(env, 'GET', loc);
    if (get.ok && get.json) { eps_url = get.json.imageUrl || eps_url; expires_at = get.json.expirationDate || expires_at; }
  }
  if (!eps_url) return { ok: false, error: 'no EPS url returned' };
  return { ok: true, eps_url, expires_at: expires_at || null };
}

// --- getting the bytes, separately from uploading them ---
//
// Split out so the compositor can sit in between: it needs the SOURCE BYTES to compute its content
// hash, which is also the cache key, so the pipeline has to hold the bytes before it can decide
// whether there is any work to do. Fetching goes through the shared disk cache (lib/img-cache.mjs),
// so re-listing a card that has already been seen is a local read rather than a CDN round trip.

// Returns { ok, buffer, filename, contentType, error }.
export async function bytesFromUrl(url) {
  try {
    const got = await fetchCached(url);
    if (!got.buffer) return { ok: false, error: 'image fetch HTTP ' + (got.httpStatus || '?') };
    const ct = got.contentType || '';
    const filename = 'card.' + (ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg');
    return { ok: true, buffer: got.buffer, filename, contentType: ct.split(';')[0] || undefined };
  } catch (e) { return { ok: false, error: 'download: ' + (e?.message || e) }; }
}
export function bytesFromPath(filePath) {
  try { return { ok: true, buffer: fs.readFileSync(filePath), filename: filePath.split(/[\\/]/).pop() }; }
  catch (e) { return { ok: false, error: 'read ' + filePath + ': ' + (e?.message || e) }; }
}

// Fetch bytes from a public URL, then upload to EPS. Returns { ok, eps_url, expires_at, error }.
export async function uploadFromUrl(env, url) {
  const got = await bytesFromUrl(url);
  if (!got.ok) return { ok: false, error: got.error };
  return await createImageFromFile(env, { buffer: got.buffer, filename: got.filename, contentType: got.contentType });
}
export async function uploadFromPath(env, filePath) {
  const got = bytesFromPath(filePath);
  if (!got.ok) return { ok: false, error: got.error };
  return await createImageFromFile(env, { buffer: got.buffer, filename: got.filename });
}

export const notExpired = (iso) => { if (!iso) return false; const t = Date.parse(iso); return Number.isFinite(t) && t - Date.now() > 24 * 3600 * 1000; };

// --- listing_images cache (db-backed; the pipeline re-uses a still-valid EPS url instead of re-uploading) ---
function cachedEps(db, { itemId, sourceUrl, localPath, composeHash }) {
  if (!db) return null;
  let row;
  if (composeHash) {
    // With compositing on, the hosted bytes are no longer a function of source_url: two printings
    // that share catalog art get different rails. The compose hash IS the identity of the bytes —
    // source image + layout + ASSET_VERSION + variant + the rendered text — so keying on it keeps
    // the dedupe win below (two copies of one card still upload once) while making a cross-card
    // collision impossible. The source_url branch is untouched and is the flag-off path.
    row = db.prepare(`SELECT * FROM listing_images WHERE compose_hash = ? AND eps_url IS NOT NULL ORDER BY id DESC LIMIT 1`).get(composeHash);
  } else if (itemId == null) {
    row = db.prepare(`SELECT * FROM listing_images WHERE item_id IS NULL AND kind = 'generic' ORDER BY id DESC LIMIT 1`).get();
  } else if (sourceUrl) {
    // Catalog art is the SAME BYTES for every copy of a card, so a live EPS url for this source
    // is a hit whichever item first uploaded it. Keying this on (item_id, source_url) meant a
    // batch holding two copies of one card — or an NM and an LP of it, which are two stock rows —
    // pushed identical bytes to eBay twice. Nothing reads catalog rows back per item: runPublish
    // only ever selects kind IN ('front','back','blemish','slab') for the owner-photo check.
    //
    // `compose_hash IS NULL` is what makes the toggle real. A branded row also carries the source
    // url it was built from, so without this an item that had been published WITH rails and then
    // had them switched off would match its own branded image and keep them — the escape hatch
    // would silently do nothing. Every pre-compositing row has a NULL hash, so this changes nothing
    // about the behaviour that existed before.
    row = db.prepare(`SELECT * FROM listing_images WHERE source_url = ? AND compose_hash IS NULL AND eps_url IS NOT NULL ORDER BY id DESC LIMIT 1`).get(sourceUrl);
  } else if (localPath) {
    // An OWNER PHOTO is of one physical card. It stays item-scoped, or one card's photo would end
    // up on another card's listing. Same compose_hash rule as above, for the same reason.
    row = db.prepare(`SELECT * FROM listing_images WHERE item_id = ? AND local_path IS ? AND compose_hash IS NULL ORDER BY id DESC LIMIT 1`).get(itemId, localPath);
  } else return null;
  return row && row.eps_url && notExpired(row.expires_at) ? row : null;
}
function storeEps(db, { itemId, kind, sourceUrl, localPath, eps, sortOrder, composeHash, composeVersion }) {
  if (!db) return;
  db.prepare(`INSERT INTO listing_images (item_id, kind, source_url, local_path, eps_url, expires_at, sort_order, compose_hash, compose_version)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId ?? null, kind, sourceUrl || null, localPath || null, eps.eps_url, eps.expires_at || null, sortOrder | 0, composeHash || null, composeVersion || null);
}

// Upload (or reuse) the shared generic trailing image. Persists its EPS url into config so it's shared
// across every listing and only re-uploaded when it expires. Returns the EPS url or null.
export async function ensureGenericImage(env, cfg, saveCfg, db) {
  const g = cfg && cfg.genericImage;
  if (!g || !g.enabled || !g.path) return null;
  if (g.eps && notExpired(g.expires)) return g.eps;
  const up = await uploadFromPath(env, g.path);
  if (!up.ok) return null;
  if (typeof saveCfg === 'function') { try { saveCfg({ ...cfg, genericImage: { ...g, eps: up.eps_url, expires: up.expires_at } }); } catch {} }
  if (db) { try { db.prepare(`DELETE FROM listing_images WHERE item_id IS NULL AND kind='generic'`).run(); storeEps(db, { itemId: null, kind: 'generic', localPath: g.path, eps: up, sortOrder: 999 }); } catch {} }
  return up.eps_url;
}

// Run one source's bytes through the compositor, if compositing is on for this call. Returns
// { buffer, filename, contentType, composeHash, composeVersion } — with composeHash null when
// nothing was composed, which is what puts the caller back on the source_url cache key.
//
// GR7 applied to a dependency: any failure here (no sharp on this host, missing rail art, an image
// libvips will not decode) degrades to the ORIGINAL bytes with a warning. A branded frame is a
// presentation upgrade; failing to make one must never cost a listing its photo.
async function maybeCompose(bytes, compose, warnings, extraOptions = null) {
  if (!compose || !compose.enabled) return { ...bytes, composeHash: null, composeVersion: null };
  try {
    const r = await composeListingImage(bytes.buffer, compose.meta || {}, { ...(compose.options || {}), ...(extraOptions || {}) });
    return { buffer: r.buffer, filename: 'card.jpg', contentType: 'image/jpeg', composeHash: r.contentHash, composeVersion: r.composeVersion };
  } catch (e) {
    warnings.push((e instanceof ComposeUnavailable ? 'branding skipped' : 'branding failed') + ': ' + (e?.message || e));
    return { ...bytes, composeHash: null, composeVersion: null };
  }
}

// buildOfferImageUrls — the pipeline. Returns { imageUrls:[EPS…], warnings:[…] }.
//  sources: [{ url?, path?, kind }]  (kind: card/front/back/blemish/slab). Card art first, photos next.
//  compose: { enabled, meta, options } — when enabled, each source is branded before upload and the
//           resulting content hash becomes its cache key (see cachedEps).
//  The generic trailing image (if configured) is appended last.
export async function buildOfferImageUrls(env, { db, itemId, sources = [], cfg, saveCfg, compose = null } = {}) {
  const imageUrls = [];
  const warnings = [];
  let order = 0;
  for (const s of sources) {
    // Flag OFF: unchanged from before compositing existed — the cheap cache probe happens first and
    // a hit costs nothing. Flag ON: the bytes have to be in hand before the key can be computed,
    // which is why fetching now goes through the shared image cache.
    if (!compose || !compose.enabled) {
      const hit = cachedEps(db, { itemId, sourceUrl: s.url || null, localPath: s.path || null });
      if (hit) { imageUrls.push(hit.eps_url); order++; continue; }
      const up = s.url ? await uploadFromUrl(env, s.url) : s.path ? await uploadFromPath(env, s.path) : { ok: false, error: 'no source' };
      if (up.ok) { imageUrls.push(up.eps_url); storeEps(db, { itemId, kind: s.kind || 'card', sourceUrl: s.url, localPath: s.path, eps: up, sortOrder: order++ }); }
      else warnings.push('image upload failed (' + (s.url || s.path) + '): ' + up.error);
      continue;
    }

    const raw = s.url ? await bytesFromUrl(s.url) : s.path ? bytesFromPath(s.path) : { ok: false, error: 'no source' };
    if (!raw.ok) { warnings.push('image upload failed (' + (s.url || s.path) + '): ' + raw.error); continue; }

    // Catalog CDN art is already cropped to the card — trimming it eats the edges of borderless
    // printings (The One Ring, extended-art frames). Owner PHOTOS keep the trim: cropping the
    // background off a desk shot is what the detector is for.
    const catalog = (s.kind || 'card') === 'card';
    const done = await maybeCompose(raw, compose, warnings, catalog ? { trim: false } : null);
    // A compose that fell back to the original bytes has no hash, so it lands on the pre-compositing
    // key and behaves exactly as it did before — no half-branded state gets cached as branded.
    const hit = cachedEps(db, { itemId, sourceUrl: s.url || null, localPath: s.path || null, composeHash: done.composeHash });
    if (hit) { imageUrls.push(hit.eps_url); order++; continue; }

    const up = await createImageFromFile(env, { buffer: done.buffer, filename: done.filename, contentType: done.contentType });
    if (up.ok) {
      imageUrls.push(up.eps_url);
      storeEps(db, { itemId, kind: s.kind || 'card', sourceUrl: s.url, localPath: s.path, eps: up, sortOrder: order++, composeHash: done.composeHash, composeVersion: done.composeVersion });
    } else warnings.push('image upload failed (' + (s.url || s.path) + '): ' + up.error);
  }
  // `hero` = the first REAL image, taken BEFORE the generic banner is appended. The description embeds
  // it; a follow-us banner as the hero shot would be worse than no image at all.
  const hero = imageUrls.length ? imageUrls[0] : null;
  const generic = await ensureGenericImage(env, cfg, saveCfg, db);
  if (generic) imageUrls.push(generic);
  return { imageUrls, warnings, hero };
}
