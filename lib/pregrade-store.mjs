// lib/pregrade-store.mjs — the content-addressed store for pre-grade report shots.
//
// A deliberate clone of lib/listing-image-store.mjs (same function shapes, pregrade naming) rather
// than a shared parameterised store, because the two differ where it matters most: a composed
// Shopify frame is fully regenerable from data/photo-originals/ plus the catalog art, but a scan
// or microscope shot of a RAW card is not — once the card is sleeved, submitted or sold there is
// no second take. So data/pregrade-images/ sits with data/photo-originals/ on the "original
// bytes, gitignored for size not disposability" side of the line, not with the caches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const STORE_DIR = path.join(ROOT, 'data', 'pregrade-images');
export const STORE_EXTS = Object.freeze(['png', 'jpg']);

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

// Atomic tmp + rename, so two writers racing on the same hash can never tear a file — the same
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
// a saved file gets a human-readable name while storage stays keyed on the hash. It is in the
// PATH rather than a query deliberately: a query parameter invites someone to pass it through
// to fs.
export function storeUrl(hash, ext, filename) {
  const base = `/api/pregrade/file/${hash}.${String(ext).toLowerCase()}`;
  return filename && isDownloadName(filename) ? `${base}/${encodeURIComponent(filename)}` : base;
}

export const CONTENT_TYPE = Object.freeze({ jpg: 'image/jpeg', png: 'image/png' });
