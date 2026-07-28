// test/integration/listings-compose.test.mjs — the compositor's effect on the eBay media pipeline
// (lib/ebay-media.mjs buildOfferImageUrls), against a temp DB and a stubbed eBay.
//
// The whole point of this file is the CACHE KEY. Before compositing, catalog art was deduped on
// source_url alone so one card's art uploaded once for the whole store. Compositing breaks that
// premise — two printings share art but not rails — so the key becomes the compose hash. The tests
// below pin BOTH halves: the dedupe win survives, and the flag-off path is provably unchanged.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { buildOfferImageUrls } from '../../lib/ebay-media.mjs';
import { DEFAULT_CONFIG } from '../../lib/listing-image-config.mjs';
import { composeAvailable } from '../../lib/listing-image.mjs';
import { sharpOrNull, fakeCard } from '../helpers/image-diff.mjs';

const ENV = { EBAY_REFRESH_TOKEN: 'fake', EBAY_CERT_ID: 'c' };
const CFG = { genericImage: { enabled: false } };

const sharp = await sharpOrNull();
const avail = sharp ? await composeAvailable(DEFAULT_CONFIG, 'default') : { ok: false, reasons: ['sharp missing'] };
const SKIP = sharp && avail.ok ? false : `compositor unavailable: ${avail.reasons.join('; ')}`;

let db, tmpDir, uploads, cardBytes;
const realFetch = globalThis.fetch;

function resp(status, json, headers = {}, bytes = null) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => (json == null ? '' : JSON.stringify(json)),
    arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer),
  };
}

// Counts every create_image_from_file POST — the number this whole design is about, since each one
// is a real upload to eBay and eBay rate-limits them at 50 per 5 seconds.
function installStub() {
  uploads = [];
  let seq = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    if (u.includes('cdn.example/')) return resp(200, null, { 'content-type': 'image/jpeg' }, cardBytes);
    if (u.includes('/media/v1_beta/image/create_image_from_file')) {
      seq++;
      uploads.push(seq);
      return resp(201, {}, { location: 'https://apim.ebay.com/commerce/media/v1_beta/image/IMG' + seq });
    }
    const m = u.match(/\/media\/v1_beta\/image\/IMG(\d+)$/);
    if (m) return resp(200, { imageUrl: `https://i.ebayimg.com/IMG${m[1]}.jpg`, expirationDate: '2099-01-01T00:00:00Z' });
    return resp(404, { errors: [{ errorId: 1, message: 'unstubbed ' + u }] });
  };
}

// listing_images.item_id is a real foreign key into inventory_items, so the stock rows have to
// exist before anything can be cached against them.
const ITEMS = [1, 2, 3];
before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-compose-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
  for (const n of ITEMS) {
    db.prepare(`INSERT INTO inventory_items (id, sku, game, name, set_name, number, variant, language, condition, quantity, target_price_cents, status)
                VALUES (?, ?, 'pokemon', 'Pikachu', 'Base Set', '58/102', 'Regular', 'EN', 'Near Mint', 1, 1299, 'in_stock')`)
      .run(n, 'BK-RAW-PKM-00000' + n);
  }
  if (sharp) cardBytes = await fakeCard(733, 1024);
});
after(() => { globalThis.fetch = realFetch; try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(() => { installStub(); db.exec('DELETE FROM listing_images;'); });

// A distinct URL per test so the shared on-disk image cache (data/img-cache) never serves one
// test's bytes to another, and so the stub is genuinely exercised.
let urlSeq = 0;
const artUrl = () => `https://cdn.example/card-${++urlSeq}.jpg`;

const build = (opts) => buildOfferImageUrls(ENV, { db, cfg: CFG, ...opts });
const composeOn = (meta = {}) => ({ enabled: true, meta, options: { cfg: DEFAULT_CONFIG } });

describe('schema migration', () => {
  it('listing_images carries compose_hash + compose_version and an index on the hash', () => {
    const cols = db.prepare('PRAGMA table_info(listing_images)').all().map((c) => c.name);
    assert.ok(cols.includes('compose_hash'), 'compose_hash column missing');
    assert.ok(cols.includes('compose_version'), 'compose_version column missing');
    const idx = db.prepare('PRAGMA index_list(listing_images)').all().map((i) => i.name);
    assert.ok(idx.includes('idx_listing_img_compose'), 'idx_listing_img_compose missing');
  });
});

describe('flag OFF — the pre-compositing behaviour must be untouched', () => {
  it('still dedupes catalog art on source_url ALONE, across different items', async () => {
    const url = artUrl();
    const a = await build({ itemId: 1, sources: [{ url, kind: 'card' }] });
    const b = await build({ itemId: 2, sources: [{ url, kind: 'card' }] });
    assert.deepEqual(a.imageUrls, b.imageUrls, 'two items with the same art must share one hosted image');
    assert.equal(uploads.length, 1, `expected 1 upload for 2 items sharing art, got ${uploads.length}`);
  });

  it('writes NO compose_hash, so nothing looks branded that is not', async () => {
    await build({ itemId: 1, sources: [{ url: artUrl(), kind: 'card' }] });
    const rows = db.prepare('SELECT compose_hash, compose_version FROM listing_images').all();
    assert.ok(rows.length);
    for (const r of rows) {
      assert.equal(r.compose_hash, null);
      assert.equal(r.compose_version, null);
    }
  });

  it('an owner photo stays item-scoped (one card’s photo must never land on another card)', async () => {
    const p = path.join(tmpDir, 'photo.jpg');
    fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]));
    await build({ itemId: 1, sources: [{ path: p, kind: 'front' }] });
    await build({ itemId: 2, sources: [{ path: p, kind: 'front' }] });
    assert.equal(uploads.length, 2, 'a local photo must NOT be shared between items');
  });

  it('reports a failed source as a warning without losing the others', async () => {
    const good = artUrl();
    // A host the stub does not answer for — cdn.example/* always succeeds, so it cannot model a miss.
    const r = await build({ itemId: 1, sources: [{ url: 'https://unreachable.invalid/missing.jpg', kind: 'card' }, { url: good, kind: 'card' }] });
    assert.equal(r.imageUrls.length, 1);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /image upload failed/);
  });
});

describe('flag ON', { skip: SKIP }, () => {
  it('brands the image and records the hash + version', async () => {
    const r = await build({ itemId: 1, sources: [{ url: artUrl(), kind: 'card' }], compose: composeOn({ language: 'Japanese', setName: 'Mega Symphonia' }) });
    assert.equal(r.imageUrls.length, 1);
    assert.deepEqual(r.warnings, []);
    const row = db.prepare('SELECT * FROM listing_images ORDER BY id DESC LIMIT 1').get();
    assert.match(row.compose_hash, /^[0-9a-f]{64}$/);
    assert.match(row.compose_version, /^v1\/japanese\//);
  });

  it('KEEPS the dedupe win: two items, identical art and metadata → ONE upload', async () => {
    const url = artUrl();
    const meta = { language: 'English', setName: 'Base Set' };
    const a = await build({ itemId: 1, sources: [{ url, kind: 'card' }], compose: composeOn(meta) });
    const b = await build({ itemId: 2, sources: [{ url, kind: 'card' }], compose: composeOn(meta) });
    assert.deepEqual(a.imageUrls, b.imageUrls);
    assert.equal(uploads.length, 1, `expected 1 upload, got ${uploads.length} — the compose-hash cache key is not hitting`);
  });

  it('two CONDITIONS of one card still share a single upload', async () => {
    const url = artUrl();
    await build({ itemId: 1, sources: [{ url, kind: 'card' }], compose: composeOn({ language: 'English', setName: 'Base Set', condition: 'Near Mint' }) });
    await build({ itemId: 2, sources: [{ url, kind: 'card' }], compose: composeOn({ language: 'English', setName: 'Base Set', condition: 'Lightly Played' }) });
    assert.equal(uploads.length, 1, 'condition must not reach the rail, or every NM/LP pair doubles the store’s uploads');
  });

  it('SPLITS what used to collide: same art, different language → TWO uploads', async () => {
    const url = artUrl();
    const a = await build({ itemId: 1, sources: [{ url, kind: 'card' }], compose: composeOn({ language: 'English', setName: 'Base Set' }) });
    const b = await build({ itemId: 2, sources: [{ url, kind: 'card' }], compose: composeOn({ language: 'Japanese', setName: 'Base Set' }) });
    assert.notDeepEqual(a.imageUrls, b.imageUrls, 'a JP and an EN printing must not share a branded image');
    assert.equal(uploads.length, 2);
  });

  it('a different set name splits too (it is on the rail)', async () => {
    const url = artUrl();
    await build({ itemId: 1, sources: [{ url, kind: 'card' }], compose: composeOn({ language: 'English', setName: 'Base Set' }) });
    await build({ itemId: 2, sources: [{ url, kind: 'card' }], compose: composeOn({ language: 'English', setName: 'Surging Sparks' }) });
    assert.equal(uploads.length, 2);
  });

  it('a LAYOUT change re-composes and re-uploads (ASSET_VERSION-style invalidation)', async () => {
    const url = artUrl();
    const meta = { language: 'English', setName: 'Base Set' };
    await build({ itemId: 1, sources: [{ url, kind: 'card' }], compose: composeOn(meta) });
    await build({
      itemId: 1, sources: [{ url, kind: 'card' }],
      compose: { enabled: true, meta, options: { cfg: { ...DEFAULT_CONFIG, layoutOverrides: { railWidth: 260 } } } },
    });
    assert.equal(uploads.length, 2, 'changing the layout must invalidate the hosted image');
  });

  it('degrades to the UNBRANDED image when the compositor cannot run', async () => {
    // No rail art for this variant. The listing must still get its photo — a branded frame is a
    // presentation upgrade, never a reason to publish with no image.
    const r = await build({
      itemId: 1, sources: [{ url: artUrl(), kind: 'card' }],
      compose: { enabled: true, meta: {}, options: { cfg: { ...DEFAULT_CONFIG, variantOverrides: {} }, variant: 'default' } },
    });
    assert.equal(r.imageUrls.length, 1);
    const bad = await build({
      itemId: 2, sources: [{ url: artUrl(), kind: 'card' }],
      compose: { enabled: true, meta: {}, options: { cfg: { ...DEFAULT_CONFIG }, detector: { name: 'x', detect() { throw new Error('boom'); } } } },
    });
    assert.equal(bad.imageUrls.length, 1, 'a detector explosion must not cost the listing its image');
  });

  it('an undecodable source falls back to the raw bytes with a warning, still uploading', async () => {
    // The stub serves real JPEG bytes for cdn.example; point at a path holding junk instead.
    const p = path.join(tmpDir, 'junk.jpg');
    fs.writeFileSync(p, Buffer.from('definitely not an image'));
    const r = await build({ itemId: 3, sources: [{ path: p, kind: 'front' }], compose: composeOn({ setName: 'Base Set' }) });
    assert.equal(r.imageUrls.length, 1, 'the original bytes should still have been uploaded');
    assert.match(r.warnings.join(' '), /branding (failed|skipped)/);
    const row = db.prepare('SELECT compose_hash FROM listing_images ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.compose_hash, null, 'a fallback must not be recorded as branded');
  });

  it('a branded row and an unbranded row of the same art do not collide', async () => {
    const url = artUrl();
    await build({ itemId: 1, sources: [{ url, kind: 'card' }] });                                    // flag off
    await build({ itemId: 2, sources: [{ url, kind: 'card' }], compose: composeOn({ setName: 'Base Set' }) });  // flag on
    assert.equal(uploads.length, 2, 'the unbranded upload must not satisfy a request for a branded one');
  });

  it('turning the flag back OFF reuses the ORIGINAL unbranded image, not the branded one', async () => {
    const url = artUrl();
    const on = await build({ itemId: 1, sources: [{ url, kind: 'card' }], compose: composeOn({ setName: 'Base Set' }) });
    const off = await build({ itemId: 1, sources: [{ url, kind: 'card' }] });
    assert.notDeepEqual(on.imageUrls, off.imageUrls);
    assert.equal(uploads.length, 2);
  });
});
