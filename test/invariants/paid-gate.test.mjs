// test/invariants/paid-gate.test.mjs — nothing leaves the building against money that has not arrived.
//
// This is a safety invariant, not a feature test. The whole post-sale pipeline was written when the
// `orders` table could only ever contain PAID orders — pollOrders drops the rest before ingest — so
// every queue, count, tick and bulk action inherited "it is paid" as an unstated assumption rather
// than a checked one. An audit of the paths into stock, labels, pick sheets and CompleteSale found
// that assumption stated in comments in three places and enforced in none.
//
// These tests pin the enforcement at the two places that can actually cost something: the one function
// that tells eBay a parcel has gone, and the one query that takes stock off the shelf. Both are
// chokepoints — every route, every Telegram button and every poll funnels through them — so a guard
// here cannot be routed around by a caller that forgot.
//
// The row-level predicate agreement lives in test/unit/postsale-cancel.test.mjs beside the cancellation
// twins; the stock sweep's own end-to-end coverage is in test/integration/stock-decrement-sweep.test.mjs.
// What is here is what those two cannot reach: dispatchOrder's ordering, and the shape of the refusal.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { ingestOrder, dispatchOrder, isPaid, PAID_SQL, LOCAL_REFUSALS } from '../../lib/postsale.mjs';
import { DEFAULT_POSTAGE_CONFIG } from '../../lib/postage.mjs';

const CFG = { labels: false, messaging: false, dry_run: true, postage: DEFAULT_POSTAGE_CONFIG };

let tmpdir, n = 0;
before(() => { tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-paidgate-')); });
after(() => { try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {} });
const freshDb = () => openPostsaleDbAt(path.join(tmpdir, `p${++n}.db`));

const mkOrder = (id) => ({
  orderId: id, buyerUsername: 'buyer' + id, orderStatus: 'Completed', checkoutStatus: 'Complete',
  paidStatus: 'NoPaymentFailure', createdTime: '2026-08-01T01:00:00.000Z', paidTime: '2026-08-01T01:05:00.000Z',
  shippedTime: null, currency: 'AUD', totalCents: 4550, subtotalCents: 4200, shippingCents: 0,
  shipService: 'AU_Regular', paid: true,
  ship: { name: 'Sam Lee', street1: '9 King St', street2: null, city: 'Sydney', state: 'NSW', postal: '2000', country: 'AU', countryName: 'Australia', phone: null },
  items: [{ orderLineItemId: id + '-1', transactionId: 't' + id, itemId: '900' + id, sku: 'AAA-00' + id, title: 'Pokemon Card ' + id, quantity: 1, unitPriceCents: 4200 }],
});

// Ingest a normal paid order, then move it into the state under test. Going through ingestOrder rather
// than a hand-written INSERT keeps these rows the shape the real pipeline produces.
const seed = (db, id, set = {}) => {
  ingestOrder(db, mkOrder(id), CFG);
  const keys = Object.keys(set);
  if (keys.length) {
    db.prepare(`UPDATE orders SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE order_id=?`)
      .run(...keys.map((k) => set[k]), id);
  }
  return db.prepare('SELECT * FROM orders WHERE order_id=?').get(id);
};
const row = (db, id) => db.prepare('SELECT * FROM orders WHERE order_id=?').get(id);

// The three ways an order can fail to be paid for. Each is a real eBay state, not a hypothetical:
// unpaid is a commitment with no payment, pending is PayPalPaymentInProcess, failed is a bounced
// eCheck or a declined card reported AFTER PaidTime.
const UNPAID_STATES = [
  ['was never paid for', { paid_time: null }, 'order_unpaid'],
  ['has a payment still in flight', { payment_state: 'pending' }, 'payment_not_settled'],
  ['had its payment bounce after PaidTime', { payment_state: 'failed' }, 'payment_not_settled'],
];

describe('the paid gate: dispatchOrder is the only door to CompleteSale, and it is locked', () => {
  for (const [why, state, code] of UNPAID_STATES) {
    it(`refuses to dispatch an order that ${why}`, async () => {
      const db = freshDb();
      seed(db, '1', state);
      const r = await dispatchOrder({}, db, '1', { ...CFG, dry_run: false });
      assert.equal(r.ok, false, 'must refuse');
      assert.equal(r.code, code);
      assert.ok(LOCAL_REFUSALS.has(r.code), 'a local refusal, so the route answers 409 not 502');
      // The refusal is worth nothing if it happened after the write. Nothing in this repo ever sets
      // shipped_status back to 'unshipped', so a flip here would be permanent.
      const o = row(db, '1');
      assert.equal(o.shipped_status, 'unshipped', 'must not flip local state');
      assert.equal(o.shipped_time, null);
      assert.equal(o.picked_at, null);
      assert.equal(o.dispatch_source, null);
    });
  }

  it('refuses BEFORE the already-dispatched short-circuit, which would otherwise stamp picked_at', () => {
    // The eBay-already-has-it branch returns ok and stamps picked_at without consulting anything else,
    // so a guard placed after it would be skipped for precisely the orders eBay thinks are gone —
    // which is the population most likely to get packed next.
    const db = freshDb();
    seed(db, '1', { paid_time: null, shipped_status: 'shipped', dispatch_source: 'ebay' });
    return dispatchOrder({}, db, '1', { ...CFG, dry_run: false }).then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'order_unpaid');
      assert.equal(row(db, '1').picked_at, null, 'the short-circuit must not have run');
    });
  });

  it('refuses under dry_run too, because the local flip happens either way', async () => {
    // dry_run makes no eBay call but still writes shipped_status='shipped'. A rehearsal that reached
    // that line would permanently mark an unpaid order as sent.
    const db = freshDb();
    seed(db, '1', { paid_time: null });
    const r = await dispatchOrder({}, db, '1', { ...CFG, dry_run: true });
    assert.equal(r.ok, false);
    assert.equal(row(db, '1').shipped_status, 'unshipped');
  });

  it('refuses with dispatch:false, which is the local-only bookkeeping path', async () => {
    const db = freshDb();
    seed(db, '1', { paid_time: null });
    const r = await dispatchOrder({}, db, '1', { ...CFG, dry_run: false }, { dispatch: false });
    assert.equal(r.ok, false);
    assert.equal(row(db, '1').shipped_status, 'unshipped');
  });

  it('refuses an order it has never heard of rather than telling eBay about it', async () => {
    const db = freshDb();
    const r = await dispatchOrder({}, db, 'no-such-order', { ...CFG, dry_run: false });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'order_unknown');
  });

  it('still dispatches a genuinely paid order — the gate is a gate, not a wall', async () => {
    const db = freshDb();
    seed(db, '1');
    const r = await dispatchOrder({}, db, '1', { ...CFG, dry_run: true });
    assert.equal(r.ok, true);
    assert.equal(row(db, '1').shipped_status, 'shipped');
  });

  it('lets an order through the moment its payment settles', async () => {
    // The gate must be a hold, not a permanent exclusion: an order that wobbles and then clears has to
    // become dispatchable, or the guard turns a payment hiccup into a lost order.
    const db = freshDb();
    seed(db, '1', { payment_state: 'pending' });
    assert.equal((await dispatchOrder({}, db, '1', { ...CFG, dry_run: true })).ok, false);
    db.prepare(`UPDATE orders SET payment_state='ok' WHERE order_id='1'`).run();
    assert.equal((await dispatchOrder({}, db, '1', { ...CFG, dry_run: true })).ok, true);
  });
});

describe('the paid gate: PAID_SQL and isPaid() are one rule in two spellings', () => {
  it('agree row for row, including the states a naive paid_time test waves through', () => {
    const db = freshDb();
    seed(db, 'paid');
    seed(db, 'unpaid', { paid_time: null });
    seed(db, 'pending', { payment_state: 'pending' });
    seed(db, 'failed', { payment_state: 'failed' });
    seed(db, 'silent', { payment_state: null });      // eBay said nothing — COALESCEs to ok
    const sqlPaid = new Set(db.prepare(`SELECT order_id FROM orders WHERE ${PAID_SQL}`).all().map((r) => r.order_id));
    for (const r of db.prepare('SELECT * FROM orders').all()) {
      assert.equal(isPaid(r), sqlPaid.has(r.order_id), `disagreement on ${r.order_id}`);
    }
    assert.deepEqual([...sqlPaid].sort(), ['paid', 'silent']);
  });
});
