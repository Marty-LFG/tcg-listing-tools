// test/unit/content-store-put.test.mjs — storePut's write semantics, held identical across BOTH
// content-addressed stores.
//
// THE BUG THIS EXISTS TO PREVENT, which cost a 1-in-10 flake in `pnpm verify`:
//
//   fs.renameSync(tmp, file);        // onto a destination that already exists
//
// On Windows that throws EPERM whenever anything else holds the destination open, and Defender
// reading a freshly written 1MB jpeg is exactly that. Measured on this machine, renaming onto an
// EXISTING path: 2 failures in 400 from a single writer with no other reader, and 393 in 400 with
// three concurrent readers. Onto a path that does NOT exist: zero in 2100 under both conditions.
// POST /api/listing-image/build then returned 503 "nothing could be rendered" — and passed on retry,
// which is the shape that gets a test re-run instead of read.
//
// The fix is the semantics the store always implied: content-addressed means the hash IS the identity
// of the bytes, so a file already at that path IS the file we were about to write. lib/backup.mjs's
// mirror had already written that reasoning down ("a file that exists in the mirror is by definition
// already correct"); the stores just never applied it to themselves.
//
// BOTH STORES ARE TESTED FROM ONE TABLE ON PURPOSE. lib/pregrade-store.mjs is a deliberate clone of
// lib/listing-image-store.mjs — its own header says so — and it cloned the bug along with the shape.
// A table means a fix to one that is not made to the other fails here, rather than waiting to be
// discovered by the store whose bytes are the ones that cannot be re-taken.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpDir } from '../helpers/tmp.mjs';

// Set BEFORE the import below: STORE_DIR is resolved at module scope, so a redirect applied after the
// import reaches nothing. node --test gives each file its own process, so this cannot leak sideways.
process.env.TCG_LISTING_IMAGE_DIR = path.join(tmpDir('tcg-store-'), 'listing-images');
const listing = await import('../../lib/listing-image-store.mjs');
// The pregrade store has no directory override, by the documented choice its own suite explains — it
// writes distinctive random bytes into the real (gitignored) directory and removes exactly what it
// wrote. Every hash here is random, so no destination is ever shared with a real shot or another run.
const pregrade = await import('../../lib/pregrade-store.mjs');

const STORES = [
  ['listing-image', listing, 'jpg'],
  ['pregrade', pregrade, 'png'],
];

const shaOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// Source pins read CODE, never prose. This repo quotes code inside comments constantly — the header
// of this very file contains `fs.renameSync(tmp, file);`, and both stores now quote the expression
// they replaced — so a pin matched against raw text could be satisfied by the comment EXPLAINING the
// bug rather than by the fix. test/invariants/temp-paths.test.mjs:152 skips comment lines for exactly
// this reason; this is the same discipline.
const read = (f, base = '../../lib/') => fs.readFileSync(new URL(base + f, import.meta.url), 'utf8');
const code = (...a) => read(...a).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const src = (f) => code(f);
const written = [];
const put = (store, hash, ext, bytes) => { const f = store.storePut(hash, ext, bytes); written.push(f); return f; };

after(() => { for (const f of written) { try { fs.unlinkSync(f); } catch { /* already gone */ } } });

for (const [label, store, ext] of STORES) {
  describe(`${label}: storePut never renames onto an existing file`, () => {
    it('a second put of the same hash leaves the FIRST bytes in place', () => {
      // The observable proof that no rename happened, without spying on fs. Feeding different bytes
      // under one hash is impossible through the real callers — the hash is derived from the inputs —
      // so this is a probe, not a scenario: if the second put still renamed, these bytes would change.
      const first = crypto.randomBytes(2048);
      const sha = shaOf(first);
      const file = put(store, sha, ext, first);
      const decoy = crypto.randomBytes(2048);
      const again = put(store, sha, ext, decoy);
      assert.equal(again, file, 'the same hash must resolve to the same path');
      assert.ok(Buffer.compare(fs.readFileSync(file), first) === 0,
        'the second put overwrote the destination — that rename is the EPERM this module exists to avoid');
    });

    it('leaves no .tmp behind on either put', () => {
      const bytes = crypto.randomBytes(2048);
      const sha = shaOf(bytes);
      put(store, sha, ext, bytes);
      put(store, sha, ext, bytes);
      const leftovers = fs.readdirSync(store.STORE_DIR).filter((f) => f.startsWith(sha) && f.includes('.tmp'));
      assert.deepEqual(leftovers, [], 'tmp file survived');
    });

    it('the second put writes no tmp file at all — it returns before writing', () => {
      // Distinct from the assertion above: that one proves the tmp was cleaned up, this one proves it
      // was never created. A ~1MB write per repeat compose is worth not doing.
      const bytes = crypto.randomBytes(2048);
      const sha = shaOf(bytes);
      put(store, sha, ext, bytes);
      const realWrite = fs.writeFileSync;
      let writes = 0;
      fs.writeFileSync = (...a) => { writes++; return realWrite.apply(fs, a); };
      try { put(store, sha, ext, bytes); } finally { fs.writeFileSync = realWrite; }
      assert.equal(writes, 0, 'the early return must happen before the tmp write, not after it');
    });
  });

  describe(`${label}: storePut survives losing a race, but not a real fault`, () => {
    // The window the early return cannot close: two writers both see no file, both write a tmp, and
    // the second renames onto what the first just created. Rare, and the whole point is that it is no
    // longer fatal — the winner wrote the same content by definition of the hash.
    const withRename = (impl, fn) => {
      const real = fs.renameSync;
      fs.renameSync = impl;
      try { return fn(); } finally { fs.renameSync = real; }
    };
    const err = (code) => Object.assign(new Error(`${code}: simulated`), { code });

    it('a losing rename is absorbed when the destination is there', () => {
      const bytes = crypto.randomBytes(2048);
      const sha = shaOf(bytes);
      const dest = store.storePath(sha, ext);
      let file;
      withRename((from) => {
        // Stand in for the winner: the destination appears, and our rename fails the way Windows fails.
        fs.writeFileSync(dest, bytes);
        try { fs.unlinkSync(from); } catch { /* the real rename would have consumed it */ }
        throw err('EPERM');
      }, () => { file = store.storePut(sha, ext, bytes); });
      written.push(dest);
      assert.equal(file, dest, 'storePut must return the winner\'s file rather than throwing');
      assert.ok(Buffer.compare(fs.readFileSync(dest), bytes) === 0);
      const leftovers = fs.readdirSync(store.STORE_DIR).filter((f) => f.startsWith(sha) && f.includes('.tmp'));
      assert.deepEqual(leftovers, [], 'the loser must clean up its tmp before returning');
    });

    it('an EPERM with NO destination still throws — that is a real permission fault', () => {
      // The distinction that keeps this from being a blanket catch. A read-only directory, a full
      // disk or a vanished tmp must still reach the caller; GR7 handles it per frame upstream.
      const bytes = crypto.randomBytes(2048);
      const sha = shaOf(bytes);
      assert.throws(
        () => withRename((from) => { try { fs.unlinkSync(from); } catch { /* fine */ } throw err('EPERM'); },
          () => store.storePut(sha, ext, bytes)),
        /EPERM/,
        'a failure that left no file behind is not a lost race and must not be swallowed');
    });

    it('a non-race errno throws even when the destination DID appear', () => {
      // THE ERRNO CONJUNCT ON ITS OWN, and it took two goes to actually test it. The first version
      // unlinked the destination before calling storePut, so the throw came from `stored(file)` being
      // false and the errno set was never consulted — widening RACE_CODES to include ENOSPC (or
      // EBUSY, which is the one a future reader will reach for) passed it. Here the destination is
      // made to appear INSIDE the failed rename, exactly as in the salvage case above, so
      // `stored(file)` is true at the catch and the only thing left to decide the outcome is whether
      // ENOSPC counts as a lost race. It must not: a full disk is a fault, not a race.
      const bytes = crypto.randomBytes(2048);
      const sha = shaOf(bytes);
      const dest = store.storePath(sha, ext);
      assert.throws(
        () => withRename((from) => {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, bytes);
          try { fs.unlinkSync(from); } catch { /* fine */ }
          throw err('ENOSPC');
        }, () => store.storePut(sha, ext, bytes)),
        /ENOSPC/,
        'a full disk is not a lost race, even with a file sitting at the destination');
      written.push(dest);
    });
  });
}

describe('the two stores have not drifted apart', () => {
  // They are clones by decision, not by accident. If one grows a guard the other lacks, the next
  // person to read either one is misled about what the pair guarantees.
  it('both refuse to rename onto an existing destination', () => {
    for (const f of ['listing-image-store.mjs', 'pregrade-store.mjs']) {
      const s = src(f);
      assert.match(s, /if \(stored\(file\)\) return file;/,
        `${f} must return early when the content is already stored — that early return IS the fix`);
      assert.match(s, /RACE_CODES\.has\(e\.code\) && stored\(file\)/,
        `${f} must salvage a lost race only when the destination actually appeared`);
      // Size, not mere existence. A zero-length entry left by a rename that landed before its data
      // flushed would otherwise be permanent — the name looks taken, so nothing re-makes it.
      assert.match(s, /st\.isFile\(\) && st\.size > 0/,
        `${f}'s stored() must reject an empty file, or a torn entry becomes immortal`);
      // The SET, not just the expression that reads it. EBUSY is the entry the next person to hit a
      // Windows rename failure will reach for, and it is ERROR_SHARING_VIOLATION on the SOURCE — a
      // tmp we could not open is a real fault, so admitting it would swallow one whenever any stale
      // file happened to sit at the destination. ENOSPC and EROFS are the same trap wearing different
      // hats. The behavioural case above catches this too; this says why in the place someone edits.
      assert.match(s, /const RACE_CODES = new Set\(\['EPERM', 'EACCES', 'EEXIST'\]\);/,
        `${f}'s RACE_CODES must stay exactly EPERM/EACCES/EEXIST — every other errno is a fault, not a race`);
    }
  });

  it('an empty destination is treated as absent, not as done', () => {
    // The behavioural half of the assertion above. Without the size gate this put returns the 0-byte
    // file and the store serves it under cache-control: immutable for ever.
    for (const [, store, ext] of STORES) {
      const bytes = crypto.randomBytes(2048);
      const sha = shaOf(bytes);
      const dest = store.storePath(sha, ext);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.alloc(0));
      written.push(dest);
      store.storePut(sha, ext, bytes);
      assert.ok(Buffer.compare(fs.readFileSync(dest), bytes) === 0,
        'a zero-length entry must be replaced, not accepted as already stored');
    }
  });
});

describe('the composed-frame store can be redirected away from the real one', () => {
  it('STORE_DIR honours TCG_LISTING_IMAGE_DIR', () => {
    // Without this, every integration run that composed a frame deposited real ~1MB jpegs into the
    // owner's own gitignored data/listing-images/, where nothing would ever notice them.
    assert.equal(listing.STORE_DIR, process.env.TCG_LISTING_IMAGE_DIR);
    assert.match(src('listing-image-store.mjs'), /process\.env\.TCG_LISTING_IMAGE_DIR \|\|/);
  });

  // THE PROPERTY IS ORDER, NOT PRESENCE, and the two assertions below are written that way on
  // purpose. STORE_DIR is resolved when the module is first evaluated, so a redirect that runs after
  // that import reaches nothing — the line is still there, the guard still matches, and the whole
  // suite quietly goes back to writing into the real store. A `assert.match(src, /TCG_..._DIR =/)`
  // would be exactly the shape of guard this repo keeps finding: true, and blind to what it names.
  // (temp-paths.test.mjs:120-133 pins the mirror-image property — that four closers must be imported
  // STATICALLY — so "which side of an import a line falls on is load-bearing" is already house idiom.)
  const before = (haystack, a, b, what) => {
    const i = haystack.indexOf(a);
    const j = haystack.indexOf(b);
    assert.ok(i !== -1, `could not find ${JSON.stringify(a)} — ${what}`);
    assert.ok(j !== -1, `could not find ${JSON.stringify(b)} — ${what}`);
    assert.ok(i < j, `${what}\n  ${JSON.stringify(a)} must come BEFORE ${JSON.stringify(b)}, and does not`);
  };

  it('the integration harness sets it before Vite loads the module', () => {
    const boot = code('boot-server.mjs', '../helpers/');
    before(boot,
      "process.env.TCG_LISTING_IMAGE_DIR = path.join(dataDir,",
      "await import('vite')",
      'bootServer must redirect the image store BEFORE Vite evaluates the plugin graph that reads it');
  });

  it('the one unit file that seeds the store directly redirects it before either import', () => {
    // This file boots no server, so bootServer's redirect cannot reach it. It seeds ~20 fixtures and
    // one 21MB file straight onto store paths; before the redirect those went into the owner's real
    // data/listing-images/. BOTH imports have to stay dynamic and stay below the assignment:
    // shopify-media.mjs pulls in listing-image-store.mjs transitively, so leaving that one static
    // resolves STORE_DIR from the real path before the assignment ever runs — and the seeded bytes
    // and the code reading them would then be looking at two different directories.
    const media = code('shopify-media.test.mjs', './');
    const assign = 'process.env.TCG_LISTING_IMAGE_DIR = ';
    for (const mod of ['../../lib/listing-image-store.mjs', '../../lib/channels/shopify-media.mjs']) {
      assert.ok(!new RegExp(`^import\\s[^\\n]*from '${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'm').test(media),
        `${mod} must NOT be imported statically here — a static import hoists above the redirect`);
      before(media, assign, `await import('${mod}')`,
        'the redirect must run before the module that resolves STORE_DIR is loaded');
    }
  });
});
