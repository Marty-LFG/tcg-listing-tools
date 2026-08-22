// test/unit/pregrade-store.test.mjs — the content-addressed shot store (lib/pregrade-store.mjs).
//
// Mirrors the guard matrix of test/integration/listing-image-store.test.mjs, minus the server:
// that suite boots one because its /file route dispatch is the thing under test; here the store
// functions are pure fs and unit-testable directly. Like its sibling, the store has NO dir
// override — its own suite exercises the real (gitignored) directory — so this one writes
// distinctive random bytes into data/pregrade-images/ and removes exactly what it wrote.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  STORE_DIR, STORE_EXTS, CONTENT_TYPE, isStoreHash, isStoreExt, isDownloadName,
  storePath, storePut, storeLookup, storeUrl,
} from '../../lib/pregrade-store.mjs';

const written = [];
const put = (hash, ext, bytes) => { const f = storePut(hash, ext, bytes); written.push(f); return f; };
const shaOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

after(() => { for (const f of written) { try { fs.unlinkSync(f); } catch { /* already gone */ } } });

describe('put/lookup round-trip', () => {
  it('stores bytes under <sha256>.<ext> and finds them again byte-identical', () => {
    const bytes = crypto.randomBytes(256);
    const sha = shaOf(bytes);
    const file = put(sha, 'png', bytes);
    assert.equal(file, storePath(sha, 'png'));
    const hit = storeLookup(sha);
    assert.ok(hit, 'lookup missed a file just written');
    assert.equal(hit.ext, 'png');
    assert.ok(Buffer.compare(fs.readFileSync(hit.file), bytes) === 0, 'bytes changed in transit');
  });
  it('a lookup restricted to the wrong extension misses', () => {
    const bytes = crypto.randomBytes(256);
    const sha = shaOf(bytes);
    put(sha, 'jpg', bytes);
    assert.equal(storeLookup(sha, ['png']), null);
    assert.equal(storeLookup(sha, ['jpg'])?.ext, 'jpg');
  });
  it('an unknown hash is a null, not a throw', () => {
    assert.equal(storeLookup('f'.repeat(64)), null);
  });
});

describe('bad hashes and traversal are unrepresentable', () => {
  // The hash regex admits no dot, slash or percent, so none of these can NAME a path — storePath
  // throws before path.join ever runs. The resolved-path re-check is belt and braces behind it.
  for (const [label, hash] of [
    ['traversal', '../../.env'],
    ['encoded traversal', '..%2f..%2f.env'],
    ['dotted hash', '.'.repeat(64)],
    ['short hash', 'a'.repeat(63)],
    ['long hash', 'a'.repeat(65)],
    ['uppercase hash', 'A'.repeat(64)],
    ['empty hash', ''],
    ['null hash', null],
  ]) {
    it(`refuses ${label}`, () => {
      assert.throws(() => storePath(hash, 'png'), /bad content hash/);
      assert.equal(isStoreHash(hash), false);
    });
  }
  it('refuses a disallowed extension by name', () => {
    for (const ext of ['mjs', 'exe', 'png/..', '', null]) {
      assert.throws(() => storePath('a'.repeat(64), ext), /bad extension/);
      assert.equal(isStoreExt(ext), false);
    }
  });
  it('a valid pair resolves INSIDE the store, for every allowed extension', () => {
    for (const ext of STORE_EXTS) {
      assert.ok(storePath('a'.repeat(64), ext).startsWith(STORE_DIR + path.sep));
      assert.ok(CONTENT_TYPE[ext], `no content-type mapped for .${ext}`);
    }
  });
});

describe('atomic put', () => {
  it('leaves no .tmp file behind, and an overwrite of the same hash is clean', () => {
    const bytes = crypto.randomBytes(300);
    const sha = shaOf(bytes);
    put(sha, 'jpg', bytes);
    put(sha, 'jpg', bytes);   // the racing-composer case: same content, same name, no tear
    const leftovers = fs.readdirSync(STORE_DIR).filter((f) => f.startsWith(sha) && f.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'tmp file survived the rename');
    assert.ok(Buffer.compare(fs.readFileSync(storePath(sha, 'jpg')), bytes) === 0);
  });
});

describe('download names and URLs', () => {
  it('accepts a normal filename, refuses header-injection material', () => {
    assert.equal(isDownloadName('AAC-097-1-front.jpg'), true);
    assert.equal(isDownloadName('scan-front.png'), true);
    for (const bad of ['a"; rm -rf /', 'a\r\nX-Evil: 1', '.hidden', '../up.jpg', '', null]) {
      assert.equal(isDownloadName(bad), false, JSON.stringify(bad));
    }
  });
  it('storeUrl appends the name only when it is valid — never a bad one, never a query param', () => {
    const sha = 'b'.repeat(64);
    assert.equal(storeUrl(sha, 'png'), `/api/pregrade/file/${sha}.png`);
    assert.equal(storeUrl(sha, 'png', 'scan-front.png'), `/api/pregrade/file/${sha}.png/scan-front.png`);
    assert.equal(storeUrl(sha, 'png', 'a"; rm -rf /'), `/api/pregrade/file/${sha}.png`);
  });
});
