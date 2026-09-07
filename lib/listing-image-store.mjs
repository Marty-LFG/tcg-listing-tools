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

// TCG_LISTING_IMAGE_DIR overrides the location so the suite never writes into the real store. Same
// escape hatch as TCG_TRACKER_DB / TCG_POSTSALE_DB / TCG_CONFIG_DIR, and unset in production.
//
// It is read at import time, so anything setting it must do so BEFORE the first import of this
// module — test/helpers/boot-server.mjs sets it alongside the database redirects, which is early
// enough for both module instances Vite creates (it evaluates vite.config.js in its own graph, so
// lib modules load twice in a test process; both read the same already-set env var).
export const STORE_DIR = process.env.TCG_LISTING_IMAGE_DIR || path.join(ROOT, 'data', 'listing-images');
export const STORE_EXTS = Object.freeze(['jpg', 'png']);

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

// Atomic tmp + rename, so two composers racing on the same hash can never tear a file — the same
// discipline the compose cache and every config write in this repo already follow.
//
// AND NEVER ONTO AN EXISTING FILE, which is the half that was missing and cost a 1-in-10 flake.
//
// The store is content-addressed: the hash IS the identity of the inputs, so a file already at this
// path is the file we were about to write. Returning it is not an optimisation, it is the semantics —
// and it keeps the rename below off a destination that exists, which is the only shape that fails.
//
// MEASURED, because it reads like superstition otherwise. fs.renameSync on Windows is
// MoveFileEx(MOVEFILE_REPLACE_EXISTING), which has to unlink the DESTINATION's directory entry then
// and there; NTFS refuses while any process holds that file open, and libuv maps the resulting
// ERROR_ACCESS_DENIED to EPERM. It does not use POSIX rename semantics, so the reader having opened
// with FILE_SHARE_DELETE does not save it. Defender reading a freshly written 1MB jpeg is holder
// enough. 400 renames onto an existing path, one writer and no deliberate reader:
// 2 failed. The same 400 with three concurrent readers: 393 failed. Onto a path that does NOT exist
// the failure was unreachable — 0 across 2100 renames under both conditions. So POST /build composing
// a card the store already held would intermittently 503 "nothing could be rendered" (GR7 catches the
// throw per frame and the last frame's loss empties the manifest), and re-running made it go away,
// which is the worst shape a failure can have.
//
// NOTE WHAT THE HASH PROMISES, because the clone in pregrade-store.mjs promises more. contentHash is
// sha256 of the INPUTS, never of the output bytes (listing-image-config.mjs says why), and libvips is
// deterministic for a given build but not across builds. So an existing entry is the same IMAGE, not
// necessarily the same OCTETS — first writer wins, deliberately. That is also what finally makes
// /file's `cache-control: immutable` honest: before this, re-composing on an upgraded host quietly
// replaced the bytes under a URL we had promised could never change. Nothing downstream loses by it —
// ensureShopifyMedia uploads what storeLookup found, never the buffer its caller happens to hold.
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
    // and the rename. Ask again and stand down if it is now answered — the winner composed the same
    // INPUTS, so its rendering is as good as ours (see the note above: same image, not necessarily
    // the same octets). A genuine fault — no permission, full disk, vanished tmp — still throws, and
    // the destination being there is what separates the two: checked, never assumed, or this decays
    // into a blanket catch that would hide a read-only store directory forever.
    try { fs.unlinkSync(tmp); } catch { /* already consumed, or already gone */ }
    if (!(RACE_CODES.has(e.code) && stored(file))) throw e;
  }
  return file;
}

// "Real bytes are already here." Size only, and the gate is not defensive theatre — it is the lesson
// lib/backup.mjs's mirror had to learn first: a half-written file whose name already looks present is
// never re-made, so it becomes a permanent hole. Here that hole is worse than a missing backup, since
// /file would serve the empty entry under `cache-control: immutable` and ensureShopifyMedia would
// upload it to a live store as a valid image. A zero-length entry is the classic shape of a rename
// that landed before its data flushed — and test/unit/shopify-media.test.mjs seeds this directory
// with a plain writeFileSync, so "nothing writes this path except the rename" is not something this
// function may assume.
//
// It stops at size > 0 deliberately. Comparing against buffer.length would re-open the very rename
// this exists to avoid, because a different length here is a legitimate second rendering of identical
// inputs; comparing content would make byte-equality a store invariant that listing-image-config.mjs
// explicitly disclaims, and a mismatch would carry no available remedy anyway.
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
// it makes a saved file carry the spec's {sku}-{position}-{view}.{ext} convention while storage
// stays keyed on the hash. It is in the PATH rather than a query deliberately: a query parameter
// invites someone to pass it through to fs.
export function storeUrl(hash, ext, filename) {
  const base = `/api/listing-image/file/${hash}.${String(ext).toLowerCase()}`;
  return filename && isDownloadName(filename) ? `${base}/${encodeURIComponent(filename)}` : base;
}

export const CONTENT_TYPE = Object.freeze({ jpg: 'image/jpeg', png: 'image/png' });
