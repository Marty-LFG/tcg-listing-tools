// test/unit/shopify-media.test.mjs — the Shopify media pipeline (lib/channels/shopify-media.mjs).
//
// Offline: a stub fetch answers the GraphQL endpoint and the staged-upload target, and the bytes come
// from a real temp file in the content-addressed store. Nothing here touches a network or a real store.
//
// The properties worth locking down are the ones whose failure is SILENT on a live store: a file
// attached before it finished processing (broken image, no error anywhere), the same bytes uploaded
// twice (Shopify Files fills with orphans that have no bulk delete), the social card leaking into the
// product gallery, and the multipart field ordering GCS rejects.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDbAt } from '../../lib/db.mjs';
import { storePath } from '../../lib/listing-image-store.mjs';
import { ensureShopifyMedia, postToStagedTarget, cachedFile } from '../../lib/channels/shopify-media.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { buildProductSetInput } from '../../lib/channels/shopify-product-api.mjs';
import { toShopifyProduct } from '../../lib/channels/shopify-map.mjs';

const ENV = {
  SHOPIFY_DEV_SHOP: 'binders-keepers-dev',
  SHOPIFY_CLIENT_ID: 'fake-client-id',
  SHOPIFY_CLIENT_SECRET: 'fake-client-secret',
};

// Put real bytes in the real content store under a hash we control, so storeLookup finds them.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5]);
function seedStore(tag) {
  const hash = crypto.createHash('sha256').update(tag).digest('hex');
  const p = storePath(hash, 'jpg');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JPEG);
  process.on('exit', () => { try { fs.unlinkSync(p); } catch { /* best effort */ } });
  return hash;
}

const frame = (hash, over = {}) => ({
  position: 1, view: 'front', filename: 'AAC-085-1-front.jpg', alt: 'Iono front',
  contentHash: hash, composeVersion: 'v1/default/abc', width: 1512, height: 2112, bytes: JPEG.length, ...over,
});

function mkResponse(status, body, headers = {}) {
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null }, text: async () => body };
}

// A stub that plays the whole three-call dance. `script` lets a test bend one step.
function stubShopify({ fileStatus = 'READY', statusSequence = null, stagedFail = false, uploadStatus = 204 } = {}) {
  const calls = { staged: 0, uploads: [], fileCreate: 0, statusPolls: 0, tokens: 0 };
  let seq = 0;
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/admin/oauth/access_token')) {
      calls.tokens++;
      return mkResponse(200, JSON.stringify({ access_token: 't', scope: 'write_files', expires_in: 86399 }));
    }
    if (u.includes('storage.example')) { calls.uploads.push(init); return mkResponse(uploadStatus, ''); }
    const q = JSON.parse(init.body).query;
    if (q.includes('stagedUploadsCreate')) {
      calls.staged++;
      if (stagedFail) return mkResponse(200, JSON.stringify({ data: { stagedUploadsCreate: { stagedTargets: [], userErrors: [{ field: ['input'], message: 'nope' }] } } }));
      return mkResponse(200, JSON.stringify({
        data: { stagedUploadsCreate: { stagedTargets: [{
          url: 'https://storage.example/upload',
          resourceUrl: 'https://storage.example/resource/1',
          parameters: [{ name: 'policy', value: 'P' }, { name: 'signature', value: 'S' }, { name: 'key', value: 'K' }],
        }], userErrors: [] } },
      }));
    }
    if (q.includes('fileCreate')) {
      calls.fileCreate++;
      calls.fileCreateAlt = JSON.parse(init.body).variables.files[0].alt;
      return mkResponse(200, JSON.stringify({ data: { fileCreate: { files: [{ id: 'gid://shopify/MediaImage/' + calls.fileCreate, fileStatus, alt: '' }], userErrors: [] } } }));
    }
    if (q.includes('nodes(ids:')) {
      calls.statusPolls++;
      const st = statusSequence ? (statusSequence[seq++] ?? statusSequence[statusSequence.length - 1]) : 'READY';
      return mkResponse(200, JSON.stringify({ data: { nodes: [{ id: 'gid://shopify/MediaImage/1', fileStatus: st, fileErrors: st === 'FAILED' ? [{ message: 'bad image' }] : [] }] } }));
    }
    return mkResponse(200, JSON.stringify({ data: {} }));
  };
  fn.calls = calls;
  return fn;
}

// A real mapped product, so the seam test exercises the actual contract rather than a stand-in.
const PRODUCT = toShopifyProduct({
  id: 7, sku: 'AAC-085', game: 'pokemon', identity_key: 'sv8a-102', name: 'Iono', number: '186/159',
  set_name: 'White Flare', set_code: 'SV8a', rarity: 'Special Illustration Rare', language: 'JP',
  variant: 'Holo', condition: 'Near Mint', quantity: 1, target_price_cents: 12999,
});

let db;
beforeEach(() => { db = openDbAt(tmpFile('shopify-media-' + Math.random().toString(36).slice(2) + '.db')); });

describe('the happy path', () => {
  it('stages, uploads, registers and returns an ordered gallery', async () => {
    const h1 = seedStore('front-1'), h2 = seedStore('back-1');
    const fetchImpl = stubShopify();
    const set = { sku: 'AAC-085', alt: 'Iono front', images: [frame(h1), frame(h2, { position: 2, view: 'back', filename: 'AAC-085-2-back.jpg' })], social: null };

    const r = await ensureShopifyMedia(ENV, db, { imageSet: set, fetchImpl });
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.uploaded, 2);
    // Gallery order IS array order, and buildImageSet guarantees position 1 is the real card.
    assert.equal(r.fileGids.length, 2);
    assert.ok(r.fileGids.every((g) => typeof g === 'string'), 'bare GIDs — an object here cannot connect to buildProductSetInput');
    assert.match(r.fileGids[0], /^gid:\/\/shopify\/MediaImage\//);
  });

  it('returns exactly the shape publishProduct takes, so the two wire up with no adapter', async () => {
    const h = seedStore('shape-1');
    const fetchImpl = stubShopify();
    const set = { sku: 'AAC-085', alt: 'Iono front', images: [frame(h)], social: frame(h, { position: null, view: 'og', filename: 'AAC-085-og.jpg' }) };

    const r = await ensureShopifyMedia(ENV, db, { imageSet: set, fetchImpl });
    // publishProduct destructures { fileGids, ogFileGid } — spreading the result must satisfy it.
    const input = buildProductSetInput(PRODUCT, { fileGids: r.fileGids, ogFileGid: r.ogFileGid });
    assert.deepEqual(input.files, [{ id: r.fileGids[0] }], 'the media layer and the publish layer disagreed about `files`');
    assert.ok(input.metafields.some((m) => m.namespace === 'bkc' && m.key === 'og_image' && m.value === r.ogFileGid));
  });

  it('alt travels with the FILE, not with the attachment — siblings share one file', async () => {
    const h = seedStore('alt-1');
    const fetchImpl = stubShopify();
    const set = { sku: 'AAC-085', alt: 'Iono front', images: [frame(h, { alt: 'Iono front' })], social: null };
    await ensureShopifyMedia(ENV, db, { imageSet: set, fetchImpl });
    assert.equal(fetchImpl.calls.fileCreateAlt, 'Iono front', 'alt must be set at fileCreate, where it belongs to the file');
  });

  it('sends the signed parameters BEFORE the file part', async () => {
    // Not style: GCS validates the policy fields as it streams, so a file part that arrives first is
    // rejected before the policy is read. bk-shopify hit this — "Malformed multipart body".
    const h = seedStore('order-1');
    const fetchImpl = stubShopify();
    await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl });
    const body = fetchImpl.calls.uploads[0].body;
    const keys = [...body.keys()];
    assert.deepEqual(keys, ['policy', 'signature', 'key', 'file']);
    assert.equal(keys.indexOf('file'), keys.length - 1, 'the file part must be last');
  });

  it('sends fileSize as a STRING, which is easy to get wrong', async () => {
    const h = seedStore('size-1');
    const fetchImpl = stubShopify();
    const seen = [];
    const spy = async (url, init) => { if (String(url).includes('graphql')) seen.push(JSON.parse(init.body)); return fetchImpl(url, init); };
    await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: spy });
    const staged = seen.find((b) => b.query.includes('stagedUploadsCreate'));
    assert.equal(typeof staged.variables.input[0].fileSize, 'string');
  });
});

describe('the social card never enters the gallery', () => {
  it('comes back as ogFileGid and is absent from files', async () => {
    const h1 = seedStore('front-2'), og = seedStore('og-2');
    const fetchImpl = stubShopify();
    const set = {
      sku: 'AAC-085', alt: 'Iono front',
      images: [frame(h1)],
      social: { view: 'og', filename: 'AAC-085-og.jpg', contentHash: og, width: 1200, height: 630, bytes: JPEG.length },
    };
    const r = await ensureShopifyMedia(ENV, db, { imageSet: set, fetchImpl });
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.fileGids.length, 1, 'the og card leaked into the product gallery');
    assert.ok(r.ogFileGid, 'the og card was not uploaded at all');
    assert.ok(!r.fileGids.includes(r.ogFileGid));
  });
});

describe('the cache is what stops Shopify Files filling with orphans', () => {
  it('a second run uploads nothing and reuses the file', async () => {
    const h = seedStore('cache-1');
    const set = { images: [frame(h)], social: null };
    const first = stubShopify();
    const a = await ensureShopifyMedia(ENV, db, { imageSet: set, fetchImpl: first });
    assert.equal(a.uploaded, 1);

    const second = stubShopify();
    const b = await ensureShopifyMedia(ENV, db, { imageSet: set, fetchImpl: second });
    assert.equal(b.reused, 1);
    assert.equal(b.uploaded, 0);
    assert.equal(second.calls.staged, 0, 'it re-staged bytes it had already uploaded');
    assert.equal(b.fileGids[0], a.fileGids[0]);
  });

  it('condition siblings sharing one image upload it ONCE', async () => {
    // The case the content-hash key exists for: condition never reaches the pixels, so an NM and an LP
    // of one card have byte-identical art. Four siblings must reference one file, not mint four.
    const h = seedStore('sibling-1');
    const fetchImpl = stubShopify();
    const set = { images: [frame(h), frame(h, { position: 2, view: 'back', filename: 'x-2-back.jpg' })], social: null };
    const r = await ensureShopifyMedia(ENV, db, { imageSet: set, fetchImpl });
    assert.equal(fetchImpl.calls.fileCreate, 1, 'the same bytes were uploaded twice in one pass');
    assert.equal(r.fileGids.length, 2);
    assert.equal(r.fileGids[0], r.fileGids[1]);
  });

  it('only a READY row is reusable — a staged or failed one is not', async () => {
    const h = seedStore('halfmade-1');
    db.prepare(`INSERT INTO shopify_files (content_hash, status, resource_url) VALUES (?, 'staged', 'x')`).run(h);
    assert.equal(cachedFile(db, h), null, 'a half-made row was handed out as reusable');
    db.prepare(`UPDATE shopify_files SET status='ready', file_gid='gid://shopify/MediaImage/9' WHERE content_hash=?`).run(h);
    assert.equal(cachedFile(db, h).file_gid, 'gid://shopify/MediaImage/9');
  });
});

describe('failures are reported, never assumed away', () => {
  it('waits for PROCESSING to become READY rather than attaching early', async () => {
    // Attaching a file mid-processing gives a product with a broken image and no error anywhere.
    const h = seedStore('processing-1');
    const fetchImpl = stubShopify({ fileStatus: 'PROCESSING', statusSequence: ['PROCESSING', 'READY'] });
    const r = await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl });
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.ok(fetchImpl.calls.statusPolls >= 2, 'it did not actually poll');
  });

  it('reports a processing FAILURE as a failure', async () => {
    const h = seedStore('failed-1');
    const fetchImpl = stubShopify({ fileStatus: 'PROCESSING', statusSequence: ['FAILED'] });
    const r = await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /failed to process|bad image/i);
    assert.equal(db.prepare('SELECT status FROM shopify_files WHERE content_hash = ?').get(h).status, 'failed');
  });

  it('losing position 1 is an ERROR; losing a later frame is a warning', async () => {
    // A product with three of its four images is better than no product. A product without the actual
    // card is not a product.
    const h1 = seedStore('pos1-1');
    const set = { images: [frame(h1), frame('0'.repeat(64), { position: 2, view: 'back' })], social: null };
    const r = await ensureShopifyMedia(ENV, db, { imageSet: set, fetchImpl: stubShopify() });
    assert.equal(r.ok, true, 'a missing back should not block the publish');
    assert.equal(r.fileGids.length, 1);
    assert.match(r.warnings.join(' '), /no bytes in the image store/);

    const set2 = { images: [frame('0'.repeat(64))], social: null };
    const r2 = await ensureShopifyMedia(ENV, db, { imageSet: set2, fetchImpl: stubShopify() });
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.length);
  });

  it('surfaces a staged-upload refusal instead of proceeding', async () => {
    const h = seedStore('stagedfail-1');
    const r = await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: stubShopify({ stagedFail: true }) });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /stagedUploadsCreate/);
  });

  it('surfaces a GCS rejection with its status', async () => {
    const h = seedStore('gcsfail-1');
    const r = await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: stubShopify({ uploadStatus: 400 }) });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /staged upload 400/);
  });

  it('refuses an oversized image before sending a byte', async () => {
    const h = seedStore('big-1');
    const big = frame(h, { bytes: 21 * 1024 * 1024 });
    const p = storePath(h, 'jpg');
    fs.writeFileSync(p, Buffer.alloc(21 * 1024 * 1024, 1));
    const fetchImpl = stubShopify();
    const r = await ensureShopifyMedia(ENV, db, { imageSet: { images: [big], social: null }, fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /over Shopify's/);
    assert.equal(fetchImpl.calls.staged, 0, 'it asked for a target for a file it could never upload');
  });

  it('an empty set warns rather than throwing', async () => {
    const r = await ensureShopifyMedia(ENV, db, { imageSet: { images: [], social: null }, fetchImpl: stubShopify() });
    assert.match(r.warnings.join(' '), /empty/);
  });
});

describe('postToStagedTarget in isolation', () => {
  it('never throws on a non-2xx — it reports', async () => {
    const r = await postToStagedTarget({ url: 'https://storage.example/u', parameters: [] }, JPEG,
      { filename: 'a.jpg', mimeType: 'image/jpeg', fetchImpl: async () => mkResponse(403, 'denied') });
    assert.equal(r.ok, false);
    assert.match(r.error, /403/);
  });
});

// A file that Shopify has already created is a permanent object on the store. If our poll gives up
// before it finishes processing, the id is the only handle we will ever have on it — drop that and the
// file is unreachable AND the retry makes another one, in a Files area with no bulk delete. These lock
// down the difference between a retry that RESUMES and a retry that LITTERS.
describe('a timeout is an unfinished wait, not a failure', () => {
  // Shopify says PROCESSING at fileCreate and never reaches READY within the (tiny) timeout.
  const neverReady = () => stubShopify({ fileStatus: 'PROCESSING', statusSequence: ['PROCESSING'] });

  it('KEEPS the file id when the READY poll times out', async () => {
    const h = seedStore('timeout-1');
    const r = await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: neverReady(), timeoutMs: 5 });
    assert.equal(r.ok, false);
    const row = db.prepare('SELECT * FROM shopify_files WHERE content_hash = ?').get(h);
    assert.equal(row.status, 'processing', 'a timeout is not the same fact as a failure');
    assert.match(row.file_gid, /^gid:\/\/shopify\/MediaImage\//, 'the id was thrown away — that file is now unreachable');
  });

  it('the RETRY adopts that file instead of uploading the same bytes again', async () => {
    const h = seedStore('timeout-2');
    await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: neverReady(), timeoutMs: 5 });

    // Second attempt: the file finished processing in the meantime, as it almost always does.
    const second = stubShopify();
    const r = await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: second });

    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(second.calls.staged, 0, 'it re-staged bytes for a file that already existed');
    assert.equal(second.calls.fileCreate, 0, 'it minted a DUPLICATE file — this is the orphan pile');
    assert.equal(r.adopted, 1);
    assert.equal(cachedFile(db, h).status, 'ready');
  });

  it('records the id even when Shopify FAILED the image, so the orphan is at least nameable', async () => {
    const h = seedStore('failed-1');
    const fetchImpl = stubShopify({ fileStatus: 'PROCESSING', statusSequence: ['FAILED'] });
    const r = await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl });
    assert.equal(r.ok, false);
    const row = db.prepare('SELECT * FROM shopify_files WHERE content_hash = ?').get(h);
    assert.equal(row.status, 'failed');
    assert.ok(row.file_gid, 'a failed file still exists on the store and still needs deleting by hand');
  });

  it('a gidless failure never erases an id an earlier attempt recorded', async () => {
    const h = seedStore('coalesce-1');
    await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: neverReady(), timeoutMs: 5 });
    const gid = db.prepare('SELECT file_gid FROM shopify_files WHERE content_hash = ?').get(h).file_gid;

    // Now a run that cannot even reach fileCreate — staging itself fails.
    await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: stubShopify({ stagedFail: true }), timeoutMs: 5 });
    assert.equal(db.prepare('SELECT file_gid FROM shopify_files WHERE content_hash = ?').get(h).file_gid, gid);
  });

  it('a still-unfinished file stays adoptable rather than being downgraded to failed', async () => {
    const h = seedStore('still-1');
    await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: neverReady(), timeoutMs: 5 });
    // Second attempt, still processing: it must NOT end up as a plain 'failed' row with the id lost.
    await ensureShopifyMedia(ENV, db, { imageSet: { images: [frame(h)], social: null }, fetchImpl: neverReady(), timeoutMs: 5 });
    const row = db.prepare('SELECT * FROM shopify_files WHERE content_hash = ?').get(h);
    assert.ok(row.file_gid, 'the handle survived a second timeout');
    assert.equal(row.status, 'processing');
  });
});
