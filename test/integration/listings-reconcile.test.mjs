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
let fetched = [];   // every offer id getOffer asked eBay about, in order
function resp(status, json) { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(json || {}) }; }
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-recon-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    const m = u.match(/\/offer\/([^/?]+)/);
    if (m) {
      fetched.push(m[1]);
      const s = offerState[m[1]];
      if (!s) return resp(404, { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] });
      if (s.__http) return resp(s.__http, { errors: [{ errorId: s.__errorId || 25709, message: 'stubbed failure' }] });
      return resp(200, s);
    }
    return resp(404, {});
  };
});
after(() => { globalThis.fetch = realFetch; try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(() => {
  fetched = [];
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

// ---------------------------------------------------------------------------------------------------
// Audit E2 (2026-10-16): `LIMIT 200` with no ORDER BY re-read the same 200 rows every pass — ~91 of
// them already-sold OUT_OF_STOCK — and ~146 newer listings were never checked; `updated` counted every
// row read; ENDED left the card 'listed'; a deleted offer was an anonymous error forever.
function addListing(n, { status = 'listed', channel = 'active', listingStatus = 'ACTIVE', soldQty = 0, availQty = 1 } = {}) {
  const sku = 'BK-PKM-X' + n, oid = 'OFF-X' + n;
  const id = db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, channel_status, ebay_offer_id, ebay_listing_id)
                         VALUES (?,'pokemon',?,1,?,?,?,?)`).run(sku, 'Card ' + n, status, channel, oid, '9' + n).lastInsertRowid;
  db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, listing_status, sold_qty, available_qty)
              VALUES (?,'EBAY_AU',?,?,?,?,?,?)`).run(sku, oid, '9' + n, id, listingStatus, soldQty, availQty);
  offerState[oid] = { status: 'PUBLISHED', availableQuantity: availQty, listing: { listingStatus, listingId: '9' + n, soldQuantity: soldQty } };
  return { id: Number(id), sku, oid };
}
const listing = (sku) => db.prepare('SELECT * FROM ebay_listings WHERE sku = ?').get(sku);
const item = (id) => ({ ...db.prepare('SELECT status, channel_status FROM inventory_items WHERE id = ?').get(id) });

describe('reconcileListings — coverage beyond the cap (E2)', () => {
  beforeEach(() => { db.exec('DELETE FROM inventory_items; DELETE FROM ebay_listings;'); offerState = {}; });

  it('rotates through MORE rows than the limit, oldest-checked first, instead of re-reading the same ones', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => addListing(n));
    const seen = new Set();
    const r1 = await reconcileListings(ENV, db, { limit: 2 });
    assert.equal(r1.checked, 2);
    assert.equal(r1.due, 5);
    assert.equal(r1.remaining, 3, 'the summary says how much this pass did not reach');
    fetched.forEach((o) => seen.add(o));
    fetched = [];
    await reconcileListings(ENV, db, { limit: 2 });
    assert.deepEqual(fetched.filter((o) => seen.has(o)), [], 'the second pass reads rows the first did not');
    fetched.forEach((o) => seen.add(o));
    fetched = [];
    await reconcileListings(ENV, db, { limit: 2 });
    fetched.forEach((o) => seen.add(o));
    assert.equal(seen.size, 5, 'three passes of two reach all five rows');
    assert.ok(fetched.includes(rows[4].oid), 'the last never-checked row comes before any re-check');
    assert.ok(rows.every((r) => listing(r.sku).reconcile_checked_at), 'every row carries its check stamp');
  });

  it('counts real changes, not rows read', async () => {
    addListing(1); addListing(2);
    const r1 = await reconcileListings(ENV, db);
    assert.equal(r1.checked, 2);
    assert.equal(r1.updated, 0, 'nothing moved on eBay, so nothing was updated');
    offerState['OFF-X2'].listing.soldQuantity = 1;
    offerState['OFF-X2'].availableQuantity = 0;
    offerState['OFF-X2'].listing.listingStatus = 'OUT_OF_STOCK';
    const r2 = await reconcileListings(ENV, db);
    assert.equal(r2.updated, 1);
    assert.equal(listing('BK-PKM-X2').listing_status, 'OUT_OF_STOCK');
  });

  it('skips an OUT_OF_STOCK listing whose card has SOLD, and checks one that has not', async () => {
    const sold = addListing(1, { status: 'sold', channel: 'ended', listingStatus: 'OUT_OF_STOCK', soldQty: 1, availQty: 0 });
    const restocked = addListing(2, { status: 'in_stock', listingStatus: 'OUT_OF_STOCK', soldQty: 1, availQty: 0 });
    const r = await reconcileListings(ENV, db);
    assert.deepEqual(fetched, [restocked.oid], 'the sold one costs no eBay call');
    assert.equal(r.skipped_sold, 1);
    assert.equal(r.checked, 1);
    assert.equal(listing(sold.sku).reconcile_checked_at, null);
  });

  it('a row whose listing_status is still NULL is NOT dropped by the sold-OOS exclusion', async () => {
    // NOT (NULL = 'OUT_OF_STOCK' AND …) is NULL in SQL, which would have silently excluded every
    // freshly-published row whose status had never been read back.
    const fresh = addListing(1);
    db.prepare('UPDATE ebay_listings SET listing_status = NULL WHERE sku = ?').run(fresh.sku);
    const r = await reconcileListings(ENV, db);
    assert.equal(r.checked, 1);
  });
});

describe('reconcileListings — ENDED puts an unsold card back in stock (E2)', () => {
  beforeEach(() => { db.exec('DELETE FROM inventory_items; DELETE FROM ebay_listings;'); offerState = {}; });

  it('ended UNSOLD (owner ended it in Seller Hub) → in_stock, like /withdraw', async () => {
    const a = addListing(1);
    offerState[a.oid].listing.listingStatus = 'ENDED';
    const r = await reconcileListings(ENV, db);
    assert.equal(r.ended, 1);
    assert.equal(r.restocked, 1);
    assert.deepEqual(item(a.id), { status: 'in_stock', channel_status: 'ended' });
  });
  it('ended SOLD OUT → stays for the order poll to mark sold (never advertised as in stock)', async () => {
    const a = addListing(1);
    Object.assign(offerState[a.oid], { availableQuantity: 0 });
    Object.assign(offerState[a.oid].listing, { listingStatus: 'ENDED', soldQuantity: 1 });
    const r = await reconcileListings(ENV, db);
    assert.equal(r.ended, 1);
    assert.equal(r.restocked, 0);
    assert.deepEqual(item(a.id), { status: 'listed', channel_status: 'ended' });
  });
  it('never touches a card already marked sold', async () => {
    const a = addListing(1, { status: 'sold' });
    offerState[a.oid].listing.listingStatus = 'ENDED';
    await reconcileListings(ENV, db);
    assert.equal(item(a.id).status, 'sold');
  });
});

describe('reconcileListings — a deleted offer is flagged after consecutive 404s (E2)', () => {
  beforeEach(() => { db.exec('DELETE FROM inventory_items; DELETE FROM ebay_listings;'); offerState = {}; });

  it('counts consecutive "offer not available" answers and flags the row on the third', async () => {
    const gone = addListing(1);
    delete offerState[gone.oid];   // eBay now answers 404 / 25713 for it
    for (let pass = 1; pass <= 2; pass++) {
      const r = await reconcileListings(ENV, db);
      assert.equal(r.missing, 1);
      assert.equal(r.errors, 0, 'eBay answered — a missing offer is not an outage');
      assert.equal(r.flagged, 0, `not flagged after ${pass}`);
      assert.equal(listing(gone.sku).offer_missing_runs, pass);
      assert.equal(listing(gone.sku).offer_missing_at, null);
    }
    const r3 = await reconcileListings(ENV, db);
    assert.equal(r3.flagged, 1);
    assert.ok(listing(gone.sku).offer_missing_at, 'flagged with a timestamp');
    assert.deepEqual(r3.offers_missing.map((x) => x.sku), [gone.sku], 'and named in the summary');
    // A flag is information, never an action: the card and its mirror state are untouched.
    assert.deepEqual(item(gone.id), { status: 'listed', channel_status: 'active' });
    assert.equal(listing(gone.sku).listing_status, 'ACTIVE');
  });
  it('a successful read resets the count — the runs must be CONSECUTIVE', async () => {
    const a = addListing(1);
    const saved = offerState[a.oid];
    delete offerState[a.oid];
    await reconcileListings(ENV, db); await reconcileListings(ENV, db);
    offerState[a.oid] = saved;
    await reconcileListings(ENV, db);
    assert.equal(listing(a.sku).offer_missing_runs, 0);
    delete offerState[a.oid];
    const r = await reconcileListings(ENV, db);
    assert.equal(r.flagged, 0, 'two misses, a hit, then one miss is not three in a row');
  });
  it('a transient failure is an error, not a miss, and still moves the row to the back of the queue', async () => {
    const a = addListing(1);
    offerState[a.oid] = { __http: 400 };
    const r = await reconcileListings(ENV, db);
    assert.equal(r.errors, 1);
    assert.equal(r.missing, 0);
    assert.equal(listing(a.sku).offer_missing_runs, 0);
    assert.ok(listing(a.sku).reconcile_checked_at, 'stamped, so a row that only fails cannot pin the front');
    assert.equal(listing(a.sku).last_synced_at, null, 'but last_synced_at still means "eBay last answered"');
  });
});
