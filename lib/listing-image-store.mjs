// lib/listing-image-store.mjs — the content-addressed store for composed Shopify frames.
//
// Deliberately imports NO sharp. A host that cannot compose should still be able to SERVE bytes
// that are already on disk, the same way the rest of this subsystem degrades rather than failing
// (Golden Rule 7, applied to a dependency).
//
// Bytes here are FULLY REGENERABLE from data/photo-originals/ plus the catalog art, so unlike that
// directory this one needs no backup coverage. Worth saying out loud, because the comment two
// directories away says the exact opposite about itself.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './listing-image-config.mjs';

export const STORE_DIR = path.join(ROOT, 'data', 'listing-images');
export const STORE_EXTS = Object.freeze(['jpg', 'png']);

// sha256 hex. This character class admits no dot, no slash and no percent, so a traversal is not
// merely blocked — it is unrepresentable. The resolved-path re-check below is belt and braces.
const HASH_RE = /^[0-9a-f]{64}$/;
// The download name is COSMETIC and never touches the filesystem; it only reaches a
// Content-Disposition header, where an unvalidated value is a header-injection hole.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export const isStoreHash = (h) => HASH_RE.test(String(h == null ? '' : h));
export const isStoreExt = (e) => STORE_EXTS.includes(String(e == null ? '' : e).toLowerCase());
export const isDownloadName = (n) => NAME_RE.test(String(n == null ? '' : n));

export function storePath(hash, ext) {
  if (!isStoreHash(hash)) throw new Error('bad content hash');
  if (!isStoreExt(ext)) throw new Error(`bad extension (allowed: ${STORE_EXTS.join(', ')})`);
  const p = path.join(STORE_DIR, `${hash}.${String(ext).toLowerCase()}`);
  // The guard that actually matters if the regex above is ever loosened.
  if (!p.startsWith(STORE_DIR + path.sep)) throw new Error('resolved outside the store');
  return p;
}

// Atomic tmp + rename, so two composers racing on the same hash can never tear a file — the same
// discipline the compose cache and every config write in this repo already follow.
export function storePut(hash, ext, buffer) {
  const file = storePath(hash, ext);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
  return file;
}

export function storeLookup(hash, exts = STORE_EXTS) {
  for (const ext of exts) {
    let file;
    try { file = storePath(hash, ext); } catch { continue; }
    if (fs.existsSync(file)) return { file, ext };
  }
  return null;
}

// Content-addressed, so the URL can be cached forever. The trailing name segment is decorative —
// it makes a saved file carry the spec's {sku}-{position}-{view}.{ext} convention while storage
// stays keyed on the hash. It is in the PATH rather than a query deliberately: a query parameter
// invites someone to pass it through to fs.
export function storeUrl(hash, ext, filename) {
  const base = `/api/listing-image/file/${hash}.${String(ext).toLowerCase()}`;
  return filename && isDownloadName(filename) ? `${base}/${encodeURIComponent(filename)}` : base;
}

export const CONTENT_TYPE = Object.freeze({ jpg: 'image/jpeg', png: 'image/png' });
