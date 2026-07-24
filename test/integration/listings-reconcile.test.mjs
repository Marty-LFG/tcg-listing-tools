// test/integration/listings-reconcile.test.mjs — reconcileListings checks OUR mirrored offers against
// eBay's live state (stubbed) and marks ended/out-of-stock drift on the mirror + the inventory item.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { reconcileListings } from '../../lib/listings.mjs';

const ENV = { EBAY_REFRESH_TOKEN: 'fake' };
let db, tmpDir, item1, item2;
const realFetch = globalThis.fetch;
let offerState = {};
function resp(status, json) { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(json || {}) }; }
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-recon-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    const m = u.match(/\/offer\/([^/?]+)/);
    if (m) { const s = offerState[m[1]]; return s ? resp(200, s) : resp(404, { errors: [{ errorId: 1 }] }); }
    return resp(404, {});
  };
});
after(() => { globalThis.fetch = realFetch; try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(() => {
  db.exec("DELETE FROM inventory_items; DELETE FROM ebay_listings;");
  item1 = db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, channel_status, ebay_offer_id, ebay_listing_id) VALUES ('BK-PKM-1','pokemon','A',1,'listed','active','OFF-1','111')`).run().lastInsertRowid;
  item2 = db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, channel_status, ebay_offer_id, ebay_listing_id) VALUES ('BK-PKM-2','pokemon','B',1,'listed','active','OFF-2','222')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, listing_status) VALUES ('BK-PKM-1','EBAY_AU','OFF-1','111',?, 'ACTIVE')`).run(item1);
  db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, listing_status) VALUES ('BK-PKM-2','EBAY_AU','OFF-2','222',?, 'ACTIVE')`).run(item2);
});

describe('reconcileListings', () => {
  it('marks an ENDED listing on the mirror + inventory; leaves an ACTIVE one', async () => {
    offerState = {
      'OFF-1': { status: 'PUBLISHED', availableQuantity: 1, listing: { listingStatus: 'ACTIVE', listingId: '111', soldQuantity: 0 } },
      'OFF-2': { status: 'PUBLISHED', availableQuantity: 0, listing: { listingStatus: 'ENDED', listingId: '222', soldQuantity: 1 } },
    };
    const r = await reconcileListings(ENV, db);
    assert.equal(r.checked, 2);
    assert.equal(r.ended, 1);
    assert.equal(db.prepare(`SELECT listing_status FROM ebay_listings WHERE sku='BK-PKM-2'`).get().listing_status, 'ENDED');
    assert.equal(db.prepare(`SELECT channel_status FROM inventory_items WHERE id=?`).get(item2).channel_status, 'ended');
    // active one stays active
    assert.equal(db.prepare(`SELECT channel_status FROM inventory_items WHERE id=?`).get(item1).channel_status, 'active');
    assert.equal(db.prepare(`SELECT sold_qty FROM ebay_listings WHERE sku='BK-PKM-2'`).get().sold_qty, 1);
  });

  it('skips already-ended mirror rows on the next pass', async () => {
    offerState = { 'OFF-1': { listing: { listingStatus: 'ACTIVE' } }, 'OFF-2': { listing: { listingStatus: 'ENDED' } } };
    await reconcileListings(ENV, db);
    const r2 = await reconcileListings(ENV, db);
    assert.equal(r2.checked, 1, 'the ENDED row is excluded from the next reconcile');
  });
});
