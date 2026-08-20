// test/unit/sealed-images.test.mjs — listing photos for a sealed pool.
//
// Offline. `createImageFromFile` is the only thing that would touch the network, so every test here
// either supplies rows with a live EPS url already on them or asserts a path that never uploads.
//
// The invariant worth stating up front: sealed uses PARALLEL tables because listing_images.item_id is
// REFERENCES inventory_items(id) and the two id sequences are independent, so a sealed id that happens
// to exist over there would PASS the FK check and attach a sealed listing's photos to an unrelated
// graded card. There is a test for exactly that at the bottom.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDbAt } from '../../lib/db.mjs';
import { isFetchableImageUrl, sealedImageRows, resolveSealedImageUrls } from '../../lib/sealed-images.mjs';

const POOL = 'BKS-PKM-EN-SSP-BOX';
const future = () => new Date(Date.now() + 30 * 864e5).toISOString();
const past = () => new Date(Date.now() - 864e5).toISOString();

function freshDb() {
  const p = path.join(os.tmpdir(), `sealimg-${process.pid}-${Math.round(process.hrtime()[1])}.db`);
  const db = openDbAt(p);
  db.prepare(`INSERT INTO sealed_pools (pool_sku, product_type) VALUES (?, 'booster_box')`).run(POOL);
  return { db, p };
}
const addImg = (db, over = {}) => {
  const r = { pool_sku: POOL, position: 0, kind: 'owner', ebay_url: 'https://i.ebayimg.com/a.jpg',
    expires_at: future(), sha256: 'aaa', local_path: null, source_url: null, ...over };
  return db.prepare(`INSERT INTO sealed_pool_images (pool_sku, position, kind, ebay_url, expires_at, sha256, local_path, source_url)
                     VALUES (?,?,?,?,?,?,?,?)`)
    .run(r.pool_sku, r.position, r.kind, r.ebay_url, r.expires_at, r.sha256, r.local_path, r.source_url);
};

describe('isFetchableImageUrl — the server fetches, stores and replays this URL', () => {
  it('accepts ordinary http and https', () => {
    assert.equal(isFetchableImageUrl('https://cdn.example.com/a.jpg').ok, true);
    assert.equal(isFetchableImageUrl('http://cdn.example.com/a.jpg').ok, true);
  });
  it('refuses loopback, private ranges and the cloud metadata address', () => {
    for (const u of ['http://localhost/a.jpg', 'http://127.0.0.1/a.jpg', 'http://10.0.0.5/a.jpg',
      'http://192.168.4.200/a.jpg', 'http://172.16.0.1/a.jpg', 'http://169.254.169.254/latest']) {
      assert.equal(isFetchableImageUrl(u).ok, false, u);
    }
  });
  it('refuses non-http schemes and embedded credentials', () => {
    assert.equal(isFetchableImageUrl('file:///etc/passwd').ok, false);
    assert.equal(isFetchableImageUrl('https://user:pw@example.com/a.jpg').ok, false);
    assert.equal(isFetchableImageUrl('nonsense').ok, false);
    assert.equal(isFetchableImageUrl('').ok, false);
  });
});

describe('resolveSealedImageUrls', () => {
  it('reuses a live EPS url with no upload at all', async () => {
    const { db, p } = freshDb();
    addImg(db);
    // env {} would make any eBay call throw, so reaching one is itself the failure.
    const out = await resolveSealedImageUrls({}, db, {}, null, POOL);
    assert.deepEqual(out.imageUrls.slice(0, 1), ['https://i.ebayimg.com/a.jpg']);
    assert.equal(out.hero, 'https://i.ebayimg.com/a.jpg');
    db.close(); fs.unlinkSync(p);
  });

  it('returns [] for a pool with no images — NOT the generic banner', async () => {
    // This is what keeps the publish refusal honest. A banner-only array would be length 1 and would
    // sail past "no image", putting the store's follow-us graphic on the listing as its only picture.
    const { db, p } = freshDb();
    const out = await resolveSealedImageUrls({}, db, {}, null, POOL);
    assert.deepEqual(out.imageUrls, []);
    assert.equal(out.hero, null);
    db.close(); fs.unlinkSync(p);
  });

  it('orders by position, so the hero is the operator’s first pick', async () => {
    const { db, p } = freshDb();
    addImg(db, { position: 1, ebay_url: 'https://i.ebayimg.com/second.jpg', sha256: 'bbb' });
    addImg(db, { position: 0, ebay_url: 'https://i.ebayimg.com/first.jpg', sha256: 'ccc' });
    const out = await resolveSealedImageUrls({}, db, {}, null, POOL);
    assert.equal(out.hero, 'https://i.ebayimg.com/first.jpg');
    db.close(); fs.unlinkSync(p);
  });

  it('an expired row with no bytes to re-upload warns and is skipped, never throws (GR7)', async () => {
    const { db, p } = freshDb();
    addImg(db, { expires_at: past(), local_path: null, source_url: null });
    const out = await resolveSealedImageUrls({}, db, {}, null, POOL);
    assert.deepEqual(out.imageUrls, []);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /no retained bytes/);
    db.close(); fs.unlinkSync(p);
  });

  it('does not duplicate rows while resolving — position must keep meaning something', async () => {
    const { db, p } = freshDb();
    addImg(db);
    const before = sealedImageRows(db, POOL).length;
    await resolveSealedImageUrls({}, db, {}, null, POOL);
    assert.equal(sealedImageRows(db, POOL).length, before);
    db.close(); fs.unlinkSync(p);
  });
});

describe('the D7 invariant — sealed photos never touch the singles tables', () => {
  it('a full sealed image cycle leaves listing_images untouched, even on a colliding id', async () => {
    const { db, p } = freshDb();
    // Give inventory_items a row whose id would collide with a sealed id, which is the exact shape
    // that makes the FK check pass and silently attach sealed photos to a graded card.
    db.prepare(`INSERT INTO inventory_items (sku, game, name, condition, status)
                VALUES ('AAA-001','pokemon','A card','Near Mint','in_stock')`).run();
    const before = db.prepare('SELECT COUNT(*) n FROM listing_images').get().n;

    addImg(db);
    addImg(db, { position: 1, sha256: 'ddd', ebay_url: 'https://i.ebayimg.com/b.jpg' });
    await resolveSealedImageUrls({}, db, {}, null, POOL);

    assert.equal(db.prepare('SELECT COUNT(*) n FROM listing_images').get().n, before, 'listing_images must be untouched');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sealed_pool_images').get().n, 2);
    db.close(); fs.unlinkSync(p);
  });
});
