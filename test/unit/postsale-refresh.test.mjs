// test/unit/postsale-refresh.test.mjs — refreshOrder, the update path that lets eBay tell us what
// happened to a parcel after we ingested the sale, plus the postsale_messages kind migration.
//
// ingestOrder deliberately returns early on an order it already has, which was fine while an order
// was a fixed record of a sale. It isn't one: eBay keeps writing to the shipment side of it, and in
// particular it writes the tracking number and flips the order to shipped by itself the moment a
// postage label is bought in Seller Hub. Everything here pins that behaviour.
//
// Runs against a temp SQLite file, never data/postsale.db.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { ingestOrder, refreshOrder, enqueueMessage, attachPostage, observedServices,
  inQueue, isLabelBought, attachFulfilment } from '../../lib/postsale.mjs';
import { DEFAULT_POSTAGE_CONFIG } from '../../lib/postage.mjs';

const CFG = { labels: false, messaging: true, postage: DEFAULT_POSTAGE_CONFIG };
const CFG_NO_MSG = { ...CFG, messaging: false };

let tmpdir;
before(() => { tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-refresh-')); });
after(() => { try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {} });

let n = 0;
const freshDb = () => openPostsaleDbAt(path.join(tmpdir, `t${++n}.db`));

const mkOrder = (id, over = {}) => ({
  orderId: id, buyerUsername: 'testbuyer', orderStatus: 'Completed', checkoutStatus: 'Complete',
  paidStatus: 'NoPaymentFailure', createdTime: '2026-08-01T01:00:00.000Z', paidTime: '2026-08-01T01:05:00.000Z',
  shippedTime: null, currency: 'AUD', totalCents: 4550, subtotalCents: 4200, shippingCents: 0,
  // AU_AusPostStandardLetter, not AU_Regular: AU_Regular is the account's $8.26 TRACKED letter
  // (band 2). It only ever looked untracked because it matches none of the classifier's regexes,
  // which is the bug KNOWN_SERVICES fixes. This fixture wants a genuinely plain letter.
  shipService: 'AU_AusPostStandardLetter', paid: true,
  expedited: null, buyerSelectedShipping: null, handleByTime: null,
  etaMin: null, etaMax: null, scheduledMin: null, scheduledMax: null, deliveredTime: null,
  trackingNumber: null, carrier: null, salesRecordNumber: null, buyerNote: null,
  ship: { name: 'Test Buyer', street1: '1 Test St', street2: null, city: 'Sydney', state: 'NSW', postal: '2000', country: 'AU', countryName: 'Australia', phone: null },
  items: [{ orderLineItemId: id + '-1', transactionId: 'tx', itemId: '9001', sku: 'AAA-001', title: 'Card', quantity: 1, unitPriceCents: 4200 }],
  ...over,
});
const row = (db, id) => db.prepare('SELECT * FROM orders WHERE order_id=?').get(id);
const msgs = (db, id) => db.prepare('SELECT * FROM postsale_messages WHERE order_id=? ORDER BY kind').all(id);

describe('ingestOrder stores the postage classification', () => {
  it('writes the raw signals and the derived tier', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1', { shipService: 'AU_Express', shippingCents: 1295, expedited: true, handleByTime: '2026-08-03T06:59:59.000Z' }), CFG);
    const r = row(db, 'O1');
    assert.equal(r.postage_tier, 'express');
    assert.equal(r.postage_tracked, 1);
    assert.equal(r.expedited, 1);
    assert.equal(r.shipping_cents, 1295);
    assert.equal(r.ship_service, 'AU_Express');
    assert.equal(r.handle_by_time, '2026-08-03T06:59:59.000Z');
  });

  it('a free letter classifies as standard', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    assert.equal(row(db, 'O1').postage_tier, 'standard');
    assert.equal(row(db, 'O1').postage_tracked, 0);
  });
});

describe('refreshOrder', () => {
  it('does nothing for an order we do not have', () => {
    const db = freshDb();
    assert.deepEqual(refreshOrder(db, mkOrder('NOPE'), CFG), { updated: false });
  });

  it('is a no-op when nothing changed — a re-poll must not churn rows or queue messages', () => {
    const db = freshDb();
    const o = mkOrder('O1');
    ingestOrder(db, o, CFG);
    const r = refreshOrder(db, o, CFG);
    assert.equal(r.updated, false);
    assert.deepEqual(r.changed, []);
    assert.equal(msgs(db, 'O1').length, 1);   // still just the purchase message
  });

  it('pulls back a tracking number and marks the order shipped on eBay\'s say-so', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1', { shipService: 'AU_Express', shippingCents: 1295, expedited: true }), CFG);
    assert.equal(row(db, 'O1').shipped_status, 'unshipped');

    const r = refreshOrder(db, mkOrder('O1', {
      shipService: 'AU_Express', shippingCents: 1295, expedited: true,
      trackingNumber: '36LB1234567890', carrier: 'Australia Post', shippedTime: '2026-08-02T05:00:00.000Z',
    }), CFG);

    assert.equal(r.updated, true);
    assert.equal(r.gotTracking, true);
    assert.equal(r.becameShipped, true);
    const after = row(db, 'O1');
    assert.equal(after.tracking_number, '36LB1234567890');
    assert.equal(after.carrier, 'Australia Post');
    assert.equal(after.shipped_status, 'shipped');
    assert.equal(after.dispatch_source, 'ebay');
    assert.ok(after.tracking_seen_at, 'tracking_seen_at should stamp when WE first saw it');
  });

  it('marks the order shipped and stamps nothing else when eBay was merely TICKED dispatched', () => {
    // The bulk "mark as dispatched" in Seller Hub: ShippedTime, no tracking, untracked letter. The
    // parcel has already gone, so there is no work left and the order must leave the queue on its own.
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    const r = refreshOrder(db, mkOrder('O1', { shippedTime: '2026-08-02T05:00:00.000Z' }), CFG);

    assert.equal(r.becameShipped, true);
    assert.equal(r.settledViaEbay, true);
    assert.equal(r.labelBought, false);
    const o = row(db, 'O1');
    assert.equal(o.shipped_status, 'shipped');
    assert.equal(o.dispatch_source, 'ebay', 'provenance is still recorded — the "via eBay" badge reads it');
    assert.equal(o.label_bought_at, null, 'no label was bought, so nothing pins it to the queue');
    assert.equal(o.picked_at, null, 'a poll may not assert that a human packed something');
    assert.equal(inQueue(o), false);
    assert.equal(attachFulfilment([o])[0].fulfilment_state, 'posted');
  });

  it('still holds an order in the queue when a label really was bought', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    const r = refreshOrder(db, mkOrder('O1', {
      trackingNumber: '36LB1234567890', carrier: 'Australia Post', shippedTime: '2026-08-02T05:00:00.000Z',
    }), CFG);

    assert.equal(r.labelBought, true);
    assert.equal(r.settledViaEbay, false);
    const o = row(db, 'O1');
    assert.ok(o.label_bought_at);
    assert.equal(inQueue(o), true, 'the cards are still on the shelf');
    assert.equal(isLabelBought(o), true);
  });

  it('holds on doubt: a paid-for express service with no tracking number yet stays in the queue', () => {
    // eBay can flip the order before the tracking number reaches GetOrders. Settling this one would be
    // the expensive mistake; holding it for a poll or two only means somebody looks at it.
    const db = freshDb();
    ingestOrder(db, mkOrder('O1', { shipService: 'AU_Express', shippingCents: 1295, expedited: true }), CFG);
    const r = refreshOrder(db, mkOrder('O1', {
      shipService: 'AU_Express', shippingCents: 1295, expedited: true, shippedTime: '2026-08-02T05:00:00.000Z',
    }), CFG);

    assert.equal(r.labelBought, true);
    assert.equal(r.settledViaEbay, false);
    assert.equal(inQueue(row(db, 'O1')), true);
  });

  it('a settled order is not re-stamped by the next poll', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    const shipped = mkOrder('O1', { shippedTime: '2026-08-02T05:00:00.000Z' });
    refreshOrder(db, shipped, CFG);
    const second = refreshOrder(db, shipped, CFG);
    assert.equal(second.updated, false);
    assert.equal(second.settledViaEbay, false);
    assert.equal(row(db, 'O1').label_bought_at, null);
  });

  it('a service override that declares the tier tracked flips the verdict on a fresh transition', () => {
    // The classification is re-derived from config on every refresh, so correcting a service in
    // settings changes what the NEXT transition decides — no re-poll of eBay needed.
    const db = freshDb();
    const cfg = { ...CFG, postage: { ...DEFAULT_POSTAGE_CONFIG, services: { AU_AusPostStandardLetter: { tracked: true, tier: 'tracked' } } } };
    ingestOrder(db, mkOrder('O1'), cfg);
    const r = refreshOrder(db, mkOrder('O1', { shippedTime: '2026-08-02T05:00:00.000Z' }), cfg);
    assert.equal(r.labelBought, true, 'a tracked service gets a label, so hold it');
    assert.equal(inQueue(row(db, 'O1')), true);
  });

  it('queues exactly one dispatch message, on the transition and never again', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    const shipped = mkOrder('O1', { trackingNumber: '36LB1', carrier: 'Australia Post', shippedTime: '2026-08-02T05:00:00.000Z' });

    const first = refreshOrder(db, shipped, CFG);
    assert.deepEqual(first.queued, ['dispatch']);

    // Same payload again (eBay re-serves an order whenever anything about it changes).
    const second = refreshOrder(db, shipped, CFG);
    assert.equal(second.updated, false);
    assert.equal(msgs(db, 'O1').filter((m) => m.kind === 'dispatch').length, 1);
  });

  it('queues a delivered message when the parcel actually arrives', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    refreshOrder(db, mkOrder('O1', { trackingNumber: '36LB1', carrier: 'Australia Post' }), CFG);
    const r = refreshOrder(db, mkOrder('O1', {
      trackingNumber: '36LB1', carrier: 'Australia Post', deliveredTime: '2026-08-04T06:12:00.000Z',
    }), CFG);
    assert.equal(r.gotDelivered, true);
    assert.deepEqual(r.queued, ['delivered']);
    assert.deepEqual(msgs(db, 'O1').map((m) => m.kind), ['delivered', 'dispatch', 'purchase']);
  });

  it('never blanks a value eBay has stopped sending', () => {
    // A later GetOrders legitimately omits fields it sent before. Overwriting with null would erase a
    // tracking number we have already shown the buyer.
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    refreshOrder(db, mkOrder('O1', { trackingNumber: '36LB1', carrier: 'Australia Post', etaMin: 'E1' }), CFG);
    refreshOrder(db, mkOrder('O1'), CFG);   // everything absent again
    const after = row(db, 'O1');
    assert.equal(after.tracking_number, '36LB1');
    assert.equal(after.eta_min, 'E1');
  });

  it('does not overwrite a hand dispatch as if eBay had done it', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    db.prepare(`UPDATE orders SET shipped_status='shipped', dispatch_source='manual' WHERE order_id='O1'`).run();
    refreshOrder(db, mkOrder('O1', { trackingNumber: '36LB1', carrier: 'Australia Post' }), CFG);
    assert.equal(row(db, 'O1').dispatch_source, 'manual');
  });

  it('re-derives the tier when a service override changes, without waiting for eBay', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    assert.equal(row(db, 'O1').postage_tier, 'standard');
    const withOverride = { ...CFG, postage: { ...DEFAULT_POSTAGE_CONFIG, services: { AU_AusPostStandardLetter: { tier: 'tracked' } } } };
    const r = refreshOrder(db, mkOrder('O1'), withOverride);
    assert.equal(r.updated, true);
    assert.equal(row(db, 'O1').postage_tier, 'tracked');
  });

  it('queues nothing when messaging is off', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG_NO_MSG);
    const r = refreshOrder(db, mkOrder('O1', { trackingNumber: '36LB1', carrier: 'AP' }), CFG_NO_MSG);
    assert.equal(r.gotTracking, true);
    assert.deepEqual(r.queued, []);
  });

  it('queues nothing when the dispatch message is disabled', () => {
    const db = freshDb();
    const off = { ...CFG, postage: { ...DEFAULT_POSTAGE_CONFIG, dispatch_message: { ...DEFAULT_POSTAGE_CONFIG.dispatch_message, enabled: false } } };
    ingestOrder(db, mkOrder('O1'), off);
    const r = refreshOrder(db, mkOrder('O1', { trackingNumber: '36LB1', carrier: 'AP' }), off);
    assert.deepEqual(r.queued, []);
  });
});

describe('enqueueMessage', () => {
  it('never messages a backfilled historical order', () => {
    // backfillOrders parks its purchase message as 'closed' precisely to mean "this predates us going
    // live". A months-old sale must not get a dispatch note because eBay happened to touch it.
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG, { messageStatus: 'closed' });
    assert.equal(enqueueMessage(db, 'O1', 'dispatch'), false);
    assert.equal(msgs(db, 'O1').filter((m) => m.kind === 'dispatch').length, 0);
  });

  it('returns false for an order that does not exist', () => {
    assert.equal(enqueueMessage(freshDb(), 'NOPE', 'dispatch'), false);
  });

  it('picks the highest-value line as the item the message hangs off', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1', { items: [
      { orderLineItemId: 'a', transactionId: 't1', itemId: 'CHEAP', sku: 'AAA-001', title: 'a', quantity: 1, unitPriceCents: 500 },
      { orderLineItemId: 'b', transactionId: 't2', itemId: 'DEAR', sku: 'AAA-002', title: 'b', quantity: 1, unitPriceCents: 9000 },
    ] }), CFG);
    enqueueMessage(db, 'O1', 'dispatch');
    assert.equal(msgs(db, 'O1').find((m) => m.kind === 'dispatch').ebay_item_id, 'DEAR');
  });
});

describe('attachPostage / observedServices (read paths)', () => {
  it('decorates a DB row with the view the UI and print docs read', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1', { shipService: 'AU_Express', shippingCents: 1295, expedited: true }), CFG);
    refreshOrder(db, mkOrder('O1', { shipService: 'AU_Express', shippingCents: 1295, expedited: true, trackingNumber: '36LB1' }), CFG);
    const [o] = attachPostage([row(db, 'O1')], CFG);
    assert.equal(o.postage.tier, 'express');
    assert.equal(o.postage.upgrade, true);
    assert.equal(o.postage.label, 'Express Post');       // derived code → tier phrase, not "Express"
    assert.equal(o.postage.code, 'AU_Express');          // raw code kept for the seller-side surfaces
    assert.equal(o.postage.paid_cents, 1295);
    assert.match(o.postage.tracking_url, /36LB1$/);
    assert.match(o.postage.seller_hub_url, /orderid=O1/);
  });

  it('a standard order carries no upgrade flag, so nothing gets ink', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1'), CFG);
    const [o] = attachPostage([row(db, 'O1')], CFG);
    assert.equal(o.postage.tier, 'standard');
    assert.equal(o.postage.upgrade, false);
    assert.equal(o.postage.tracking_url, null);
  });

  it('lists every service actually sold under, with its current tier', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('O1', { shipService: 'AU_Express', expedited: true }), CFG);
    ingestOrder(db, mkOrder('O2', { shipService: 'AU_Regular' }), CFG);
    ingestOrder(db, mkOrder('O3', { shipService: 'AU_Regular' }), CFG);
    const seen = observedServices(db, CFG);
    assert.deepEqual(seen.map((s) => s.code), ['AU_Regular', 'AU_Express']);   // busiest first
    assert.equal(seen[0].orders, 2);
    assert.equal(seen[1].tier, 'express');
    assert.equal(seen[0].overridden, false);
  });
});

describe('postsale_messages kind migration', () => {
  it('rebuilds a legacy one-message-per-order table, preserving ids', () => {
    // The old shape: order_id TEXT NOT NULL UNIQUE, no kind. Telegram approval callbacks are keyed on
    // postsale_messages.id, so an id that shifted here would orphan every card already in a chat.
    const file = path.join(tmpdir, 'legacy.db');
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE buyers (id INTEGER PRIMARY KEY AUTOINCREMENT, ebay_username TEXT NOT NULL UNIQUE,
      display_name TEXT, first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), order_count INTEGER NOT NULL DEFAULT 0,
      total_spent_cents INTEGER NOT NULL DEFAULT 0, notes TEXT)`);
    raw.exec(`CREATE TABLE orders (order_id TEXT PRIMARY KEY, buyer_id INTEGER NOT NULL REFERENCES buyers(id),
      buyer_username TEXT, currency TEXT NOT NULL DEFAULT 'AUD', total_cents INTEGER NOT NULL DEFAULT 0,
      shipped_status TEXT NOT NULL DEFAULT 'unshipped', ingested_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.exec(`CREATE TABLE postsale_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
      buyer_id INTEGER NOT NULL REFERENCES buyers(id), ebay_item_id TEXT,
      is_repeat_buyer INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      subject TEXT, body TEXT, model TEXT, telegram_chat_id TEXT, telegram_message_id INTEGER,
      decided_by TEXT, decided_at TEXT, sent_at TEXT, reply_detected_at TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.exec(`INSERT INTO buyers (id, ebay_username) VALUES (7, 'legacybuyer')`);
    raw.exec(`INSERT INTO orders (order_id, buyer_id) VALUES ('OLD-1', 7), ('OLD-2', 7)`);
    raw.exec(`INSERT INTO postsale_messages (id, order_id, buyer_id, status, subject, telegram_message_id)
              VALUES (41, 'OLD-1', 7, 'sent', 'Thanks!', 5551), (42, 'OLD-2', 7, 'awaiting_approval', 'Hi', 5552)`);
    raw.close();

    const db = openPostsaleDbAt(file);
    const rows = db.prepare('SELECT * FROM postsale_messages ORDER BY id').all();
    assert.deepEqual(rows.map((r) => r.id), [41, 42], 'ids must survive — Telegram cards key off them');
    assert.deepEqual(rows.map((r) => r.kind), ['purchase', 'purchase']);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[1].telegram_message_id, 5552);

    // The constraint moved: a second message on the same order is now allowed, a second of the SAME
    // kind is not.
    db.prepare(`INSERT INTO postsale_messages (order_id, kind, buyer_id, status) VALUES ('OLD-1','dispatch',7,'pending')`).run();
    assert.throws(() => db.prepare(`INSERT INTO postsale_messages (order_id, kind, buyer_id, status) VALUES ('OLD-1','dispatch',7,'pending')`).run());
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM postsale_messages WHERE order_id='OLD-1'`).get().c, 2);

    // Re-opening must be inert, not a second rebuild.
    const again = openPostsaleDbAt(file);
    assert.deepEqual(again.prepare('SELECT id FROM postsale_messages ORDER BY id').all().map((r) => r.id), [41, 42, 43]);
  });
});
