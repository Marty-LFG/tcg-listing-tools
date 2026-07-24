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

// Fetch bytes from a public URL, then upload to EPS. Returns { ok, eps_url, expires_at, error }.
export async function uploadFromUrl(env, url) {
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return { ok: false, error: 'image fetch HTTP ' + r.status };
    const buffer = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || '';
    const filename = 'card.' + (ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg');
    return await createImageFromFile(env, { buffer, filename, contentType: ct.split(';')[0] || undefined });
  } catch (e) { return { ok: false, error: 'download: ' + (e?.message || e) }; }
}
export async function uploadFromPath(env, filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    return await createImageFromFile(env, { buffer, filename: filePath.split(/[\\/]/).pop() });
  } catch (e) { return { ok: false, error: 'read ' + filePath + ': ' + (e?.message || e) }; }
}

const notExpired = (iso) => { if (!iso) return false; const t = Date.parse(iso); return Number.isFinite(t) && t - Date.now() > 24 * 3600 * 1000; };

// --- listing_images cache (db-backed; the pipeline re-uses a still-valid EPS url instead of re-uploading) ---
function cachedEps(db, { itemId, sourceUrl, localPath }) {
  if (!db) return null;
  const row = itemId != null
    ? db.prepare(`SELECT * FROM listing_images WHERE item_id = ? AND (source_url IS ? OR local_path IS ?) ORDER BY id DESC LIMIT 1`).get(itemId, sourceUrl || null, localPath || null)
    : db.prepare(`SELECT * FROM listing_images WHERE item_id IS NULL AND kind = 'generic' ORDER BY id DESC LIMIT 1`).get();
  return row && row.eps_url && notExpired(row.expires_at) ? row : null;
}
function storeEps(db, { itemId, kind, sourceUrl, localPath, eps, sortOrder }) {
  if (!db) return;
  db.prepare(`INSERT INTO listing_images (item_id, kind, source_url, local_path, eps_url, expires_at, sort_order)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(itemId ?? null, kind, sourceUrl || null, localPath || null, eps.eps_url, eps.expires_at || null, sortOrder | 0);
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

// buildOfferImageUrls — the pipeline. Returns { imageUrls:[EPS…], warnings:[…] }.
//  sources: [{ url?, path?, kind }]  (kind: card/front/back/blemish/slab). Card art first, photos next.
//  The generic trailing image (if configured) is appended last.
export async function buildOfferImageUrls(env, { db, itemId, sources = [], cfg, saveCfg } = {}) {
  const imageUrls = [];
  const warnings = [];
  let order = 0;
  for (const s of sources) {
    const key = { itemId, sourceUrl: s.url || null, localPath: s.path || null };
    const hit = cachedEps(db, key);
    if (hit) { imageUrls.push(hit.eps_url); order++; continue; }
    const up = s.url ? await uploadFromUrl(env, s.url) : s.path ? await uploadFromPath(env, s.path) : { ok: false, error: 'no source' };
    if (up.ok) { imageUrls.push(up.eps_url); storeEps(db, { itemId, kind: s.kind || 'card', sourceUrl: s.url, localPath: s.path, eps: up, sortOrder: order++ }); }
    else warnings.push('image upload failed (' + (s.url || s.path) + '): ' + up.error);
  }
  const generic = await ensureGenericImage(env, cfg, saveCfg, db);
  if (generic) imageUrls.push(generic);
  return { imageUrls, warnings };
}
