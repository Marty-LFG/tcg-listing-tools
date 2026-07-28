// test/integration/listings-photos-compose.test.mjs — owner photos through the branded pipeline.
//
// Owner photos are the awkward path: POST /photos uploads them to eBay EPS immediately, so by
// publish time there are no bytes left to brand. Branding therefore happens in the route, which
// means the ORIGINAL has to be retained or an ASSET_VERSION bump can never reach them — the only
// other copy is on the owner's phone. That retention, and the recompose route it enables, is what
// this file pins.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootServer } from '../helpers/boot-server.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { sharpOrNull, fakeCard } from '../helpers/image-diff.mjs';

const sharp = await sharpOrNull();

let S, db, uploads, photoDataUrl;
const realFetch = globalThis.fetch;

function resp(status, json, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => (json == null ? '' : JSON.stringify(json)),
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer,
  };
}

// The dev server itself is fetched over the loopback by the test, so the stub has to pass those
// through — only eBay is intercepted.
function installStub(base) {
  uploads = [];
  let seq = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    if (u.includes('/media/v1_beta/image/create_image_from_file')) {
      seq++;
      // Record the uploaded byte length so a branded upload is distinguishable from a raw one.
      let bytes = 0;
      try { const f = opts.body; const blob = f && f.get && f.get('image'); bytes = blob ? blob.size : 0; } catch {}
      uploads.push({ seq, bytes });
      return resp(201, {}, { location: 'https://apim.ebay.com/commerce/media/v1_beta/image/IMG' + seq });
    }
    const m = u.match(/\/media\/v1_beta\/image\/IMG(\d+)$/);
    if (m) return resp(200, { imageUrl: `https://i.ebayimg.com/IMG${m[1]}.jpg`, expirationDate: '2099-01-01T00:00:00Z' });
    return resp(404, { errors: [{ errorId: 1, message: 'unstubbed ' + u }] });
  };
}

const post = (p, body) => fetch(S.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json() }));

before(async () => {
  process.env.EBAY_REFRESH_TOKEN = 'fake';
  process.env.EBAY_CERT_ID = 'c';
  process.env.EBAY_APP_ID = 'a';
  S = await bootServer();
  db = openDbAt(S.trackerDb);
  if (sharp) photoDataUrl = 'data:image/jpeg;base64,' + (await fakeCard(900, 1200)).toString('base64');
});
after(() => {
  globalThis.fetch = realFetch;
  try { db.close(); } catch {}
  return S && S.close();
});
beforeEach(() => {
  installStub(S.base);
  db.exec('DELETE FROM listing_images; DELETE FROM inventory_items;');
  db.prepare(`INSERT INTO inventory_items (id, sku, game, name, set_name, number, variant, language, condition, quantity, target_price_cents, status)
              VALUES (1, 'BK-RAW-PKM-000001', 'pokemon', 'Pikachu', 'Base Set', '58/102', 'Regular', 'JP', 'Lightly Played', 1, 1299, 'in_stock')`).run();
});

const photoRow = () => db.prepare("SELECT * FROM listing_images WHERE item_id = 1 AND kind IN ('front','back','blemish','slab') ORDER BY id DESC LIMIT 1").get();

describe('POST /api/listings/photos', { skip: !sharp && 'sharp not installed' }, () => {
  it('retains the ORIGINAL bytes even when branding is off', async () => {
    const r = await post('/api/listings/photos', { itemId: 1, kind: 'front', dataUrl: photoDataUrl, compose: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.composed, false);
    const row = photoRow();
    assert.ok(row.local_path, 'local_path was not recorded — an ASSET_VERSION bump could never reach this photo');
    assert.ok(fs.existsSync(row.local_path), 'the retained original is missing from disk');
    assert.equal(row.compose_hash, null);
  });

  it('brands the photo when asked, recording the hash and the version', async () => {
    const r = await post('/api/listings/photos', { itemId: 1, kind: 'front', dataUrl: photoDataUrl, compose: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.composed, true);
    assert.match(r.json.compose_version, /^v1\/japanese\//, 'a JP stock row should pick the japanese rails');
    const row = photoRow();
    assert.match(row.compose_hash, /^[0-9a-f]{64}$/);
    assert.ok(row.local_path && fs.existsSync(row.local_path));
  });

  it('the branded upload is a DIFFERENT image from the raw one', async () => {
    await post('/api/listings/photos', { itemId: 1, kind: 'front', dataUrl: photoDataUrl, compose: false });
    const rawBytes = uploads.at(-1).bytes;
    await post('/api/listings/photos', { itemId: 1, kind: 'back', dataUrl: photoDataUrl, compose: true });
    const brandedBytes = uploads.at(-1).bytes;
    assert.notEqual(rawBytes, brandedBytes, 'the composed upload is byte-identical to the raw one — nothing was composed');
  });

  it('404s on an unknown stock item instead of uploading an orphan to eBay', async () => {
    const r = await post('/api/listings/photos', { itemId: 9999, kind: 'front', dataUrl: photoDataUrl, compose: true });
    assert.equal(r.status, 404);
    assert.equal(uploads.length, 0, 'nothing should have been pushed to eBay');
  });

  it('still 400s on a malformed data URL', async () => {
    assert.equal((await post('/api/listings/photos', { itemId: 1, kind: 'front', dataUrl: 'nope' })).status, 400);
    assert.equal((await post('/api/listings/photos', { itemId: 1 })).status, 400);
  });
});

describe('POST /api/listings/:id/photos/recompose', { skip: !sharp && 'sharp not installed' }, () => {
  it('re-brands from the retained original and swaps the hosted image', async () => {
    await post('/api/listings/photos', { itemId: 1, kind: 'front', dataUrl: photoDataUrl, compose: false });
    const before = photoRow();
    assert.equal(before.compose_hash, null);

    const r = await post('/api/listings/1/photos/recompose', { compose: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.recomposed, 1);
    assert.deepEqual(r.json.warnings, []);
    // eBay copies the image into the offer; our table changing does not update a live listing.
    assert.match(r.json.note, /republish/);

    const after = photoRow();
    assert.equal(after.id, before.id, 'recompose should update the row, not orphan it');
    assert.match(after.compose_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(after.eps_url, before.eps_url, 'the hosted url should point at the new image');
    assert.equal(after.local_path, before.local_path, 'the original must survive so it can be redone again');
  });

  it('reports per-photo when there is no retained original, leaving the row alone', async () => {
    // Models a photo uploaded before originals were kept.
    db.prepare("INSERT INTO listing_images (item_id, kind, eps_url, expires_at, sort_order) VALUES (1,'front','https://i.ebayimg.com/OLD.jpg','2099-01-01T00:00:00Z',0)").run();
    const r = await post('/api/listings/1/photos/recompose', { compose: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.recomposed, 0);
    assert.match(r.json.warnings.join(' '), /no retained original/);
    assert.equal(photoRow().eps_url, 'https://i.ebayimg.com/OLD.jpg', 'a live listing must not lose its image');
  });

  it('404s when the item has no owner photos at all', async () => {
    const r = await post('/api/listings/1/photos/recompose', {});
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no owner photos/);
  });

  it('404s on an unknown item', async () => {
    assert.equal((await post('/api/listings/9999/photos/recompose', {})).status, 404);
  });

  it('can also strip branding back off', async () => {
    await post('/api/listings/photos', { itemId: 1, kind: 'front', dataUrl: photoDataUrl, compose: true });
    assert.match(photoRow().compose_hash, /^[0-9a-f]{64}$/);
    const r = await post('/api/listings/1/photos/recompose', { compose: false });
    assert.equal(r.json.recomposed, 1);
    assert.equal(photoRow().compose_hash, null, 'compose:false must produce an unbranded image');
  });
});

describe('/api/status', () => {
  it('reports compositor readiness so a silent failure is visible', async () => {
    const j = await fetch(S.base + '/api/status').then((r) => r.json());
    const li = j.subsystems.listing_image;
    assert.ok(li, 'subsystems.listing_image missing');
    assert.equal(li.enabled, false, 'ships disabled');
    assert.equal(typeof li.assetVersion, 'string');
    assert.ok('sharp' in li && 'rails' in li && 'font' in li, 'each silent failure mode must be individually reportable');
  });
});
