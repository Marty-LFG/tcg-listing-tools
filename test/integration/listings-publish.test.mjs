// test/integration/listings-publish.test.mjs — the full publish orchestration (runPublish) end to
// end against a temp DB and a stubbed eBay: item → validate → resolve descriptors (baked) → media
// upload (download+EPS) → createOrReplaceInventoryItem → createOffer → publishOffer → write-back +
// mirror + audit. Offline (global fetch stubbed); the live round-trip is the settings/UI smoke.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { runPublish } from '../../lib/listings.mjs';

const ENV = { EBAY_REFRESH_TOKEN: 'fake', EBAY_CERT_ID: 'c' };   // no EBAY_APP_ID → taxonomy uses baked ids
const CFG = {
  marketplaceId: 'EBAY_AU', categoryTreeId: '15', listingDuration: 'GTC',
  location: { merchantLocationKey: 'tcg-au-1' },
  policies: { paymentPolicyId: 'PAY', returnPolicyId: 'RET', fulfillmentPolicyId: 'FUL' },
  bestOffer: { enabled: false, autoAcceptPct: 95, autoDeclinePct: 78 },
  genericImage: { enabled: false },
};

let db, tmpDir, itemId;
const realFetch = globalThis.fetch;
let published = new Map();   // sku → offerId, to model idempotent find-or-create

function resp(status, json, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => (json == null ? '' : JSON.stringify(json)), arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer };
}
function installStub() {
  let offerSeq = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const m = opts.method || 'GET';
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    // CDN card-art download (the bytes we then re-host on EPS)
    if (u.includes('images.pokemontcg.io')) return resp(200, null, { 'content-type': 'image/png' });
    // Media API: create image from file → 201 + Location; GET that → imageUrl + expiry
    if (u.includes('/media/v1_beta/image/create_image_from_file')) return resp(201, {}, { location: 'https://apim.ebay.com/commerce/media/v1_beta/image/IMG1' });
    if (u.includes('/media/v1_beta/image/IMG1')) return resp(200, { imageUrl: 'https://i.ebayimg.com/IMG1.jpg', expirationDate: '2099-01-01T00:00:00Z' });
    // Inventory API
    if (u.includes('/inventory_item/') && m === 'PUT') return resp(204, null);
    if (u.match(/\/offer\?sku=/) && m === 'GET') { const sku = decodeURIComponent(u.split('sku=')[1]); const oid = published.get(sku); return resp(200, { offers: oid ? [{ offerId: oid, marketplaceId: 'EBAY_AU' }] : [] }); }
    if (u.endsWith('/offer') && m === 'POST') { const body = JSON.parse(opts.body); const oid = 'OFFER-' + (++offerSeq); published.set(body.sku, oid); return resp(200, { offerId: oid }); }
    if (u.match(/\/offer\/[^/]+$/) && m === 'PUT') return resp(200, {});   // updateOffer
    if (u.match(/\/offer\/[^/]+\/publish$/) && m === 'POST') return resp(200, { listingId: '2255' + offerSeq });
    if (u.includes('/offer/get_listing_fees')) return resp(200, { feeSummaries: [{ fees: [{ feeType: 'INSERTION', amount: { value: '0.00', currency: 'AUD' } }] }] });
    return resp(404, { errors: [{ errorId: 1, message: 'unstubbed ' + m + ' ' + u }] });
  };
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-listtest-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
});
after(() => { globalThis.fetch = realFetch; try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(() => {
  published = new Map();
  installStub();
  db.exec("DELETE FROM inventory_items; DELETE FROM ebay_listings; DELETE FROM listing_pushes; DELETE FROM listing_images;");
  const r = db.prepare(`INSERT INTO inventory_items (sku, game, name, set_name, number, variant, language, condition, quantity, target_price_cents, image_url, status)
                        VALUES ('BK-RAW-PKM-000001','pokemon','Pikachu','Base Set','58/102','Regular','EN','Near Mint',1,1299,'https://images.pokemontcg.io/base1/58.png','in_stock')`).run();
  itemId = r.lastInsertRowid;
});

describe('runPublish — publish a raw single end to end', () => {
  it('publishes, writes back the listing ids, mirror + audit', async () => {
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(out.ok, true, out.error);
    assert.ok(out.listingId, 'got a listingId');
    assert.match(out.url, /ebay\.com\.au\/itm\//);
    assert.deepEqual(out.imageUrls, ['https://i.ebayimg.com/IMG1.jpg'], 'CDN art was downloaded + re-hosted on EPS');

    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
    assert.equal(item.ebay_listing_id, out.listingId);
    assert.ok(item.ebay_offer_id);
    assert.equal(item.channel_status, 'active');
    assert.equal(item.status, 'listed');

    const mirror = db.prepare('SELECT * FROM ebay_listings WHERE sku = ?').get('BK-RAW-PKM-000001');
    assert.equal(mirror.listing_status, 'ACTIVE');
    assert.equal(mirror.price_cents, 1299);
    assert.equal(mirror.listing_id, out.listingId);

    const push = db.prepare("SELECT * FROM listing_pushes WHERE item_id = ? AND status='ok'").get(itemId);
    assert.ok(push && push.action === 'create');
    const img = db.prepare('SELECT * FROM listing_images WHERE item_id = ?').get(itemId);
    assert.equal(img.eps_url, 'https://i.ebayimg.com/IMG1.jpg');
  });

  it('re-publish is idempotent — revises the existing offer, one mirror row', async () => {
    const first = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(first.ok, true, first.error);
    const second = await runPublish(ENV, db, CFG, () => {}, { itemId, overrides: { price_cents: 1499 }, dryRun: false });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.revised, true, 'second push revises rather than creating a new offer');
    const rows = db.prepare('SELECT COUNT(*) n FROM ebay_listings WHERE sku = ?').get('BK-RAW-PKM-000001');
    assert.equal(rows.n, 1, 'still exactly one mirror row (upsert)');
    assert.equal(db.prepare('SELECT price_cents FROM ebay_listings WHERE sku=?').get('BK-RAW-PKM-000001').price_cents, 1499);
  });

  it('dry-run preview does not write back but returns fees + resolved data', async () => {
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: true });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.dryRun, true);
    assert.ok(out.fees, 'listing fees returned');
    const item = db.prepare('SELECT ebay_listing_id, status FROM inventory_items WHERE id = ?').get(itemId);
    assert.equal(item.ebay_listing_id, null, 'preview must not write back');
    assert.equal(item.status, 'in_stock');
    // but it still audits as a preview
    assert.ok(db.prepare("SELECT 1 FROM listing_pushes WHERE item_id=? AND action='preview'").get(itemId));
  });

  it('blocks publish when the price is missing (needs_price, GR4)', async () => {
    db.prepare('UPDATE inventory_items SET target_price_cents = NULL WHERE id = ?').run(itemId);
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(out.ok, false);
    assert.match(out.error, /price|needs_price/i);
  });
});
