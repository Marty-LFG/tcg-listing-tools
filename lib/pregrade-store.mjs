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

// The errno set Windows raises when a rename loses a race for its destination. EEXIST is here for
// POSIX hosts, where a rename onto a path another writer just claimed can surface that way instead.
const RACE_CODES = new Set(['EPERM', 'EACCES', 'EEXIST']);

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
//
// AND NEVER ONTO AN EXISTING FILE. This module is a clone of listing-image-store.mjs, and it cloned
// that store's bug along with its shape: fs.renameSync onto a destination that already exists throws
// EPERM on Windows whenever anything else holds the file open — Defender reading a just-written shot
// is enough. Measured on the sibling store: 2 failures in 400 renames onto an existing path with no
// other reader, 393 in 400 with three; and zero in 2100 when the destination did not exist.
//
// TWO THINGS DIFFER FROM THE SIBLING, and both make the case here stronger rather than weaker.
//   · The hash is sha256 of the BYTES (lib/pregrade.mjs:477 computes it from the decoded upload), not
//     of the inputs. So "the destination already holds this exact file" is true by construction here,
//     where the sibling can only claim the same IMAGE. Do not copy its wording back: it says less.
//   · A composed Shopify frame is regenerable. A scan or microscope shot of a RAW card is not — once
//     the card is sleeved, submitted or sold there is no second take. A put that throws here can lose
//     the only copy of something the owner cannot re-take, so the store that actually flaked is the
//     one whose bytes matter least.
//
// It deliberately gets NO directory override. The sibling needed one because its fixture is
// deterministic — same inputs, same hash, the same two filenames on every run and every machine — so
// every run after the first renamed onto the last one's file. Nothing here can collide that way: both
// suites key on sha256 of crypto.randomBytes, so no two runs, processes or machines ever contend for
// one destination, and the real (gitignored) directory is where the refcounted delete under test has
// to run. If that ever stops being true, this store needs TCG_PREGRADE_IMAGE_DIR and this paragraph
// is the record of why it did not have one.
export function storePut(hash, ext, buffer) {
  const file = storePath(hash, ext);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  if (stored(file)) return file;
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, buffer);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // The check above is a fast path, not a lock: another writer can land the file between the stat
    // and the rename, with the same bytes by definition of the hash. A genuine fault still throws —
    // the destination being there is what separates the two, and it is checked, never assumed.
    try { fs.unlinkSync(tmp); } catch { /* already consumed, or already gone */ }
    if (!(RACE_CODES.has(e.code) && stored(file))) throw e;
  }
  return file;
}

// "Real bytes are already here." Size only. A zero-length entry is the classic shape of a rename that
// landed before its data flushed, and without this gate it would be permanent: the name looks taken,
// so nothing ever re-makes it, and /file would serve an empty shot forever. Size is as far as it goes
// on purpose — the bytes ARE the hash here, so re-reading them to compare would cost a full read to
// re-derive something the filename already asserts.
function stored(file) {
  try { const st = fs.statSync(file); return st.isFile() && st.size > 0; } catch { return false; }
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
