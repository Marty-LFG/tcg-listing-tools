// test/unit/relist-watch.test.mjs — following a cancelled card onto the listing eBay relisted it as.
//
// Fully offline: getItem and getListingState are injected. The cases that earn their place are the
// REFUSALS (a pointer that does not describe our card, a stock row that has moved on) and the
// created_via invariant — get that one wrong and the relisted card becomes unpriceable by both the
// Sell API and the Trading API at once, with nothing to say so.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { enqueueRelistWatch, sweepRelistWatch, getRelistWatchState } from '../../lib/relist-watch.mjs';

const OLD = '296111111111', NEW = '296999999999';
let db, tmpDir;

before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-relist-')); db = openDbAt(path.join(tmpDir, 'tracker.db')); });
after(() => { try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(() => {
  db.exec(`DELETE FROM relist_watch; DELETE FROM inventory_items; DELETE FROM sealed_items;
           DELETE FROM ebay_listings; DELETE FROM ebay_seller_listings; DELETE FROM listing_pushes;`);
});

// A cancelled single whose listing ended with the sale: back on the shelf, pointing at the dead id.
function seedCancelledSingle({ sku = 'AAC-012', offerId = 'offer-1' } = {}) {
  const id = db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, channel_status, ebay_listing_id, ebay_offer_id)
                         VALUES (?,'pokemon','Charizard',1,'in_stock','ended',?,?)`).run(sku, OLD, offerId).lastInsertRowid;
  db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, listing_status)
              VALUES (?,'EBAY_AU',?,?,?, 'ACTIVE')`).run(sku, offerId, OLD, id);
  db.prepare(`INSERT INTO ebay_seller_listings (listing_id, sku, state, created_via) VALUES (?,?, 'ended','tool')`).run(OLD, sku);
  enqueueRelistWatch(db, { kind: 'inventory', item_id: id, sku, old_listing_id: OLD, order_id: '10-1-1' });
  return id;
}
// A fresh watch is not due for 30 minutes — eBay needs time to actually relist. Tests about what the
// probe DOES have to bring it forward; the one about the backoff itself pushes it back instead.
function makeDue() { db.prepare(`UPDATE relist_watch SET next_check_at = datetime('now','-1 minute')`).run(); }
const pointsTo = (newId) => async () => ({ ok: true, relistedItemId: newId });
const liveListing = (over = {}) => async () => ({ ok: true, listing_id: NEW, sku: 'AAC-012', title: 'Charizard',
  listing_type: 'FixedPriceItem', listing_status: 'Active', price_cents: 51000,
  quantity_total: 1, sold_qty: 0, available_qty: 1, has_variations: false, ...over });

describe('enqueueRelistWatch', () => {
  it('arms a watch with a first check due shortly', () => {
    const id = seedCancelledSingle();
    const w = db.prepare('SELECT * FROM relist_watch').get();
    assert.equal(w.kind, 'inventory');
    assert.equal(w.item_id, id);
    assert.equal(w.old_listing_id, OLD);
    assert.equal(w.state, 'watching');
    assert.equal(w.attempts, 0);
    assert.ok(w.next_check_at);
  });

  it('re-arms rather than duplicating when the same card is cancelled again', () => {
    const id = seedCancelledSingle();
    db.prepare(`UPDATE relist_watch SET state='not_relisted', attempts=9 WHERE item_id=?`).run(id);
    enqueueRelistWatch(db, { kind: 'inventory', item_id: id, sku: 'AAC-012', old_listing_id: OLD, order_id: '10-2-2' });
    const rows = db.prepare('SELECT * FROM relist_watch').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'watching');
    assert.equal(rows[0].attempts, 0);
  });
});

describe('sweepRelistWatch — the happy path', () => {
  it('adopts the new ItemID and repoints the stock row', async () => {
    const id = seedCancelledSingle();
    makeDue();
    const r = await sweepRelistWatch({}, db, { fetchItem: pointsTo(NEW), fetchState: liveListing() });
    assert.equal(r.adopted.length, 1);
    assert.deepEqual({ from: r.adopted[0].from, to: r.adopted[0].to }, { from: OLD, to: NEW });

    const inv = db.prepare('SELECT * FROM inventory_items WHERE id=?').get(id);
    assert.equal(inv.ebay_listing_id, NEW);
    assert.equal(inv.channel_status, 'active');
    assert.equal(inv.status, 'listed');
    // The Sell-API offer is dead: eBay relisted on the TRADING side, which that API cannot see at all.
    assert.equal(inv.ebay_offer_id, null);
    assert.equal(db.prepare('SELECT state FROM relist_watch').get().state, 'adopted');
  });

  it('THE INVARIANT: the relist stays created_via=manual, so the repricer can still price it', async () => {
    // importSellerListings decides created_via by `SELECT 1 FROM ebay_listings WHERE listing_id = ?`.
    // If the retired row were repointed at the new ItemID, the relist would be tagged 'tool' —
    // reviseTradingListing refuses those, and there is no live Sell-API offer either, so the card
    // would be unreviseable by BOTH paths with nothing to explain why.
    seedCancelledSingle();
    makeDue();
    await sweepRelistWatch({}, db, { fetchItem: pointsTo(NEW), fetchState: liveListing() });
    assert.equal(db.prepare('SELECT 1 x FROM ebay_listings WHERE listing_id = ?').get(NEW), undefined,
      'ebay_listings must NOT claim the relisted ItemID');
    const mirror = db.prepare('SELECT * FROM ebay_seller_listings WHERE listing_id=?').get(NEW);
    assert.equal(mirror.created_via, 'manual');
    assert.equal(mirror.state, 'active');
    assert.equal(mirror.price_cents, 51000);
  });

  it('takes the retired row out of the reconciler\'s jurisdiction instead of teaching it an exception', async () => {
    // reconcileListings selects `offer_id IS NOT NULL AND listing_status NOT IN ('ENDED','EBAY_ENDED')`.
    // After the adopt the row fails BOTH halves, so the reconciler never re-marks the card ended.
    seedCancelledSingle();
    makeDue();
    await sweepRelistWatch({}, db, { fetchItem: pointsTo(NEW), fetchState: liveListing() });
    const row = db.prepare('SELECT * FROM ebay_listings WHERE listing_id=?').get(OLD);
    assert.equal(row.offer_id, null);
    assert.equal(row.retired_offer_id, 'offer-1');   // kept, not lost
    assert.equal(row.listing_status, 'ENDED');
    const inScope = db.prepare(`SELECT COUNT(*) c FROM ebay_listings
      WHERE offer_id IS NOT NULL AND (listing_status IS NULL OR listing_status NOT IN ('ENDED','EBAY_ENDED'))`).get().c;
    assert.equal(inScope, 0);
  });

  it('leaves an auditable old→new trail', async () => {
    seedCancelledSingle();
    makeDue();
    await sweepRelistWatch({}, db, { fetchItem: pointsTo(NEW), fetchState: liveListing() });
    const push = db.prepare(`SELECT * FROM listing_pushes WHERE action='adopt'`).get();
    const body = JSON.parse(push.response);
    assert.equal(body.from, OLD);
    assert.equal(body.to, NEW);
    assert.equal(body.order_id, '10-1-1');       // which cancellation caused it
    assert.equal(db.prepare('SELECT state FROM ebay_seller_listings WHERE listing_id=?').get(OLD).state, 'ended');
    // listing_pushes is the ONLY durable record: ebay_listings is UNIQUE(sku, marketplace), so the next
    // publish for this SKU overwrites that row in place and the old ItemID would survive nowhere else.
    assert.equal(push.listing_id, NEW);
    assert.equal(push.sku, 'AAC-012');
  });

  it('gives the relisted row a URL, like every other row in the mirror', async () => {
    // A row missing listing_url is structurally different from the ones importSellerListings writes,
    // and the surfaces that link out of the catalogue would have nothing to point at.
    seedCancelledSingle();
    makeDue();
    await sweepRelistWatch({}, db, { fetchItem: pointsTo(NEW), fetchState: liveListing() });
    const row = db.prepare('SELECT listing_url FROM ebay_seller_listings WHERE listing_id=?').get(NEW);
    assert.match(row.listing_url, new RegExp(NEW + '$'));
  });
});

describe('sweepRelistWatch — refusals and retries', () => {
  it('retries with a widening backoff while eBay has not relisted yet', async () => {
    seedCancelledSingle();
    makeDue();
    const noPointer = async () => ({ ok: true, relistedItemId: null });
    await sweepRelistWatch({}, db, { fetchItem: noPointer, fetchState: liveListing() });
    const w = db.prepare('SELECT * FROM relist_watch').get();
    assert.equal(w.state, 'watching');
    assert.equal(w.attempts, 1);
  });

  it('gives up after the last backoff step rather than retrying forever', async () => {
    seedCancelledSingle();
    makeDue();
    // The owner may simply have unticked "Relist item?", in which case the pointer NEVER appears.
    db.prepare('UPDATE relist_watch SET attempts = 9').run();
    const r = await sweepRelistWatch({}, db, { fetchItem: async () => ({ ok: true, relistedItemId: null }), fetchState: liveListing() });
    assert.equal(r.not_relisted, 1);
    const w = db.prepare('SELECT * FROM relist_watch').get();
    assert.equal(w.state, 'not_relisted');
    assert.equal(w.next_check_at, null);
    assert.ok(w.resolved_at);
  });

  it('a SKU mismatch is terminal and binds nothing', async () => {
    const id = seedCancelledSingle();
    makeDue();
    const r = await sweepRelistWatch({}, db, { fetchItem: pointsTo(NEW), fetchState: liveListing({ sku: 'SOMEONE-ELSE' }) });
    assert.equal(r.adopted.length, 0);
    assert.equal(r.mismatched.length, 1);
    assert.equal(db.prepare('SELECT state FROM relist_watch').get().state, 'mismatch');
    // The stock row is untouched — a pointer we cannot verify must not move anything.
    assert.equal(db.prepare('SELECT ebay_listing_id FROM inventory_items WHERE id=?').get(id).ebay_listing_id, OLD);
  });

  it('a variation listing is terminal — it cannot map to one stock row', async () => {
    seedCancelledSingle();
    makeDue();
    await sweepRelistWatch({}, db, { fetchItem: pointsTo(NEW), fetchState: liveListing({ has_variations: true }) });
    assert.equal(db.prepare('SELECT state FROM relist_watch').get().state, 'mismatch');
  });

  it('a relist that is not live YET retries instead of giving up', async () => {
    seedCancelledSingle();
    makeDue();
    await sweepRelistWatch({}, db, { fetchItem: pointsTo(NEW), fetchState: liveListing({ listing_status: 'Scheduled' }) });
    const w = db.prepare('SELECT * FROM relist_watch').get();
    assert.equal(w.state, 'watching');
    assert.equal(w.attempts, 1);
    assert.match(w.last_error, /Scheduled/);
  });

  it('refuses to stomp a stock row that has moved on since', async () => {
    const id = seedCancelledSingle();
    makeDue();
    // Somebody relisted this by hand in the meantime. That is a more recent decision than our pointer.
    db.prepare(`UPDATE inventory_items SET ebay_listing_id='296555555555' WHERE id=?`).run(id);
    const r = await sweepRelistWatch({}, db, { fetchItem: pointsTo(NEW), fetchState: liveListing() });
    assert.equal(r.adopted.length, 0);
    assert.equal(db.prepare('SELECT ebay_listing_id FROM inventory_items WHERE id=?').get(id).ebay_listing_id, '296555555555');
    assert.equal(db.prepare('SELECT state FROM relist_watch').get().state, 'watching');
  });

  it('a failed GetItem is a retry, not a verdict', async () => {
    seedCancelledSingle();
    makeDue();
    await sweepRelistWatch({}, db, { fetchItem: async () => ({ ok: false, errors: [{ longMessage: 'eBay is having a moment' }] }), fetchState: liveListing() });
    const w = db.prepare('SELECT * FROM relist_watch').get();
    assert.equal(w.state, 'watching');
    assert.match(w.last_error, /having a moment/);
  });

  it('a watch that is not due yet is left alone', async () => {
    seedCancelledSingle();
    db.prepare(`UPDATE relist_watch SET next_check_at = datetime('now','+1 hour')`).run();
    let called = 0;
    const r = await sweepRelistWatch({}, db, { fetchItem: async () => { called++; return { ok: true }; }, fetchState: liveListing() });
    assert.equal(r.checked, 0);
    assert.equal(called, 0, 'the whole point of the backoff is not making the call');
  });
});

describe('getRelistWatchState', () => {
  it('counts by state for the dashboard', () => {
    seedCancelledSingle();
    assert.deepEqual(getRelistWatchState(db), { watching: 1, adopted: 0, not_relisted: 0, mismatch: 0 });
  });
});
