// test/unit/postsale-digest.test.mjs — the daily pack digest's two bulk buttons.
//
// One of these dispatches a whole day of orders to eBay from a phone notification, so the parts that
// matter are: WHICH orders a tap acts on, that a stale button can't act on the wrong set, that a
// double tap can't run it twice, and that a failed eBay write leaves the order in the queue rather
// than half-hiding it. All offline, against a temp SQLite file.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import {
  ingestOrder, digestOrders, buildDigestView, pickAllInDigest, dispatchAllInDigest, dispatchOrder,
} from '../../lib/postsale.mjs';
import { DEFAULT_POSTAGE_CONFIG } from '../../lib/postage.mjs';
import { renderPullList, renderDispatchSummary, renderDigestFooter } from '../../lib/telegram-cards.mjs';

const CFG = { labels: false, messaging: false, dry_run: true, postage: DEFAULT_POSTAGE_CONFIG };
const TODAY = '2026-08-03';
const YESTERDAY = '2026-08-02';

let tmpdir;
before(() => { tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-digest-')); });
after(() => { try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {} });

let n = 0;
const freshDb = () => openPostsaleDbAt(path.join(tmpdir, `d${++n}.db`));

const mkOrder = (id, over = {}) => ({
  orderId: id, buyerUsername: 'buyer' + id, orderStatus: 'Completed', checkoutStatus: 'Complete',
  paidStatus: 'NoPaymentFailure', createdTime: '2026-08-01T01:00:00.000Z', paidTime: '2026-08-01T01:05:00.000Z',
  shippedTime: null, currency: 'AUD', totalCents: 4550, subtotalCents: 4200, shippingCents: 0,
  shipService: 'AU_Regular', paid: true,
  ship: { name: 'Sam Lee', street1: '9 King St', street2: null, city: 'Sydney', state: 'NSW', postal: '2000', country: 'AU', countryName: 'Australia', phone: null },
  items: [{ orderLineItemId: id + '-1', transactionId: 't' + id, itemId: '900' + id, sku: 'AAA-00' + id, title: 'Pokemon Card ' + id, quantity: 1, unitPriceCents: 4200 }],
  ...over,
});
// runPackDigest stamps this before it sends; the tests do it directly so they need no bot token.
const stamp = (db, date, ids) => { for (const id of ids) db.prepare('UPDATE orders SET pack_digest_date=? WHERE order_id=?').run(date, id); };
const seed = (db, ids, date = TODAY) => { for (const id of ids) ingestOrder(db, mkOrder(id), CFG); stamp(db, date, ids); return db; };
const row = (db, id) => db.prepare('SELECT * FROM orders WHERE order_id=?').get(id);

describe('digestOrders — what a button acts on', () => {
  it('is scoped to the digest that listed them, not to whatever is unshipped now', () => {
    const db = seed(freshDb(), ['1', '2']);
    // An order that landed AFTER the digest went out. Tapping "mark all shipped" must not sweep it up:
    // nobody has looked at it, and it was never on the message.
    ingestOrder(db, mkOrder('3'), CFG);
    assert.deepEqual(digestOrders(db, TODAY).map((o) => o.order_id), ['1', '2']);
  });

  it('drops an order that has since been dispatched', () => {
    const db = seed(freshDb(), ['1', '2']);
    db.prepare(`UPDATE orders SET shipped_status='shipped' WHERE order_id='1'`).run();
    assert.deepEqual(digestOrders(db, TODAY).map((o) => o.order_id), ['2']);
  });

  it("yesterday's buttons stop matching once an order is re-stamped, so a stale tap does nothing", () => {
    const db = seed(freshDb(), ['1'], YESTERDAY);
    assert.equal(digestOrders(db, YESTERDAY).length, 1);
    stamp(db, TODAY, ['1']);                       // still unshipped, so it is on today's digest too
    assert.deepEqual(digestOrders(db, YESTERDAY), []);
    assert.equal(digestOrders(db, TODAY).length, 1);
  });

  it('carries the line items and postage each message needs', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('1', { shipService: 'AU_Express', expedited: true, shippingCents: 1295 }), CFG);
    stamp(db, TODAY, ['1']);
    const [o] = digestOrders(db, TODAY);
    assert.equal(o.items.length, 1);
    assert.equal(o.postage.tier, 'express');
  });
});

describe('buildDigestView — the messages and their buttons', () => {
  it('offers both buttons with live counts', () => {
    const v = buildDigestView(seed(freshDb(), ['1', '2', '3']), TODAY);
    assert.equal(v.toPick, 3);
    assert.equal(v.toShip, 3);
    assert.match(v.pullButtons[0][0].text, /Mark all 3 picked/);
    assert.equal(v.pullButtons[0][0].data, `psp:${TODAY}`);
    assert.match(v.dispatchButtons[0][0].text, /Mark all 3 shipped/);
    // The dispatch button asks before it acts, so it opens the CONFIRM step, not the dispatch.
    assert.equal(v.dispatchButtons[0][0].data, `psdq:${TODAY}`);
  });

  it('drops the pick button once everything is pulled, and keeps the dispatch one', () => {
    const db = seed(freshDb(), ['1', '2']);
    pickAllInDigest(db, TODAY, 'tester');
    const v = buildDigestView(db, TODAY);
    assert.deepEqual(v.pullButtons, []);
    assert.equal(v.toPick, 0);
    assert.equal(v.dispatchButtons.length, 1, 'picked orders still have to be posted');
    assert.match(v.pullText, /Nothing to pull/);
  });

  it('offers nothing at all when the digest is empty', () => {
    const v = buildDigestView(freshDb(), TODAY);
    assert.deepEqual(v.pullButtons, []);
    assert.deepEqual(v.dispatchButtons, []);
  });

  it('every callback the buttons emit is one the handler will actually parse', () => {
    // The handler matches /^ps(p|dq|dy|dn):(\d{4}-\d{2}-\d{2})$/ and must not collide with the
    // approve/skip buttons on /^ps(a|s):(\d+)$/. A prefix drifting apart from its matcher is a button
    // that silently does nothing.
    const DIGEST = /^ps(p|dq|dy|dn):(\d{4}-\d{2}-\d{2})$/;
    const APPROVE = /^ps(a|s):(\d+)$/;
    const v = buildDigestView(seed(freshDb(), ['1']), TODAY);
    for (const b of [...v.pullButtons.flat(), ...v.dispatchButtons.flat(),
      { data: `psdy:${TODAY}` }, { data: `psdn:${TODAY}` }]) {
      assert.match(b.data, DIGEST, b.data);
      assert.doesNotMatch(b.data, APPROVE, b.data);
    }
    for (const d of ['psa:12', 'pss:12']) assert.doesNotMatch(d, DIGEST, d);
  });
});

describe('pickAllInDigest', () => {
  it('marks the whole digest pulled without dispatching anything', () => {
    const db = seed(freshDb(), ['1', '2']);
    assert.equal(pickAllInDigest(db, TODAY, 'tester'), 2);
    for (const id of ['1', '2']) {
      assert.ok(row(db, id).picked_at, id);
      assert.equal(row(db, id).shipped_status, 'unshipped', 'picking is not posting');
    }
  });

  it('is idempotent — a second tap changes nothing', () => {
    const db = seed(freshDb(), ['1', '2']);
    pickAllInDigest(db, TODAY, 'tester');
    assert.equal(pickAllInDigest(db, TODAY, 'tester'), 0);
  });

  it('leaves an order from another digest alone', () => {
    const db = seed(freshDb(), ['1'], TODAY);
    seed(db, ['2'], YESTERDAY);
    pickAllInDigest(db, TODAY, 'tester');
    assert.ok(row(db, '1').picked_at);
    assert.equal(row(db, '2').picked_at, null);
  });
});

describe('dispatchAllInDigest', () => {
  it('dispatches every order on the digest', async () => {
    const db = seed(freshDb(), ['1', '2', '3']);
    const r = await dispatchAllInDigest({}, db, TODAY, CFG, 'tester');
    assert.equal(r.claimed, true);
    assert.equal(r.total, 3);
    assert.equal(r.ok, 3);
    assert.deepEqual(r.failed, []);
    for (const id of ['1', '2', '3']) assert.equal(row(db, id).shipped_status, 'shipped', id);
    assert.equal(row(db, '1').dispatch_source, 'manual', 'a human closed this one out, not eBay');
  });

  it('releases its claim, so a later run is not wedged', async () => {
    const db = seed(freshDb(), ['1']);
    await dispatchAllInDigest({}, db, TODAY, CFG, 'tester');
    assert.equal(db.prepare(`SELECT 1 FROM meta WHERE key='digest_dispatching:${TODAY}'`).get(), undefined);
    assert.equal((await dispatchAllInDigest({}, db, TODAY, CFG, 'tester')).claimed, true);
  });

  it('a second tap mid-run is refused rather than dispatching twice', async () => {
    const db = seed(freshDb(), ['1']);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('digest_dispatching:' + TODAY, 'now');
    const r = await dispatchAllInDigest({}, db, TODAY, CFG, 'tester');
    assert.equal(r.claimed, false);
    assert.equal(row(db, '1').shipped_status, 'unshipped');
  });

  it('a failed eBay write leaves that order in the queue to retry', async () => {
    // dry_run off + no eBay consent on this box = the CompleteSale call throws before any network.
    // That is the real contract: if eBay did not accept the dispatch, the order must NOT be flipped,
    // or it disappears from our queue while eBay still shows it awaiting postage.
    const db = seed(freshDb(), ['1', '2']);
    const live = { ...CFG, dry_run: false };
    const r = await dispatchAllInDigest({}, db, TODAY, live, 'tester');
    assert.equal(r.claimed, true);
    assert.equal(r.ok, 0);
    assert.equal(r.failed.length, 2);
    assert.deepEqual(r.failed.map((f) => f.order_id).sort(), ['1', '2']);
    for (const id of ['1', '2']) assert.equal(row(db, id).shipped_status, 'unshipped', id);
    // …and they are still on the digest, so tomorrow's message picks them up again.
    assert.equal(digestOrders(db, TODAY).length, 2);
  });
});

describe('dispatchOrder (shared by the API route and the digest button)', () => {
  it('dispatch:false flips local state without touching eBay', async () => {
    const db = seed(freshDb(), ['1']);
    const r = await dispatchOrder({}, db, '1', { ...CFG, dry_run: false }, { dispatch: false });
    assert.equal(r.ok, true);
    assert.equal(r.dispatched, false);
    assert.equal(r.ebay, null);
    assert.equal(row(db, '1').shipped_status, 'shipped');
  });

  it('records a tracking number handed to it, and stamps when we first saw it', async () => {
    const db = seed(freshDb(), ['1']);
    await dispatchOrder({}, db, '1', CFG, { tracking: '36LB1234567890', carrier: 'Australia Post' });
    const o = row(db, '1');
    assert.equal(o.tracking_number, '36LB1234567890');
    assert.equal(o.carrier, 'Australia Post');
    assert.ok(o.tracking_seen_at);
  });
});

describe('digest message rendering', () => {
  it('the footer says what happened and who did it, so a cleared message still answers for itself', () => {
    const f = renderDigestFooter({ icon: '✅', status: 'All 3 dispatched', who: 'Marty', detail: 'nice' });
    assert.match(f, /✅ <b>All 3 dispatched<\/b> by Marty/);
    assert.match(f, /<i>nice<\/i>/);
    assert.equal(renderDigestFooter(null), '', 'no footer before anything has happened');
  });

  it('escapes a name rather than trusting it as HTML', () => {
    assert.doesNotMatch(renderDigestFooter({ status: 'x', who: '<b>evil</b>' }), /<b>evil<\/b>/);
  });

  it('both digest messages render unchanged when no action has been taken', () => {
    assert.doesNotMatch(renderPullList([], { orderCount: 0 }), /<b>All/);
    assert.doesNotMatch(renderDispatchSummary([]), /<b>All/);
  });

  it('the dispatch summary calls out a postage upgrade, because that parcel needs an eBay label first', () => {
    const s = renderDispatchSummary([
      { buyer_username: 'a', ship_city: 'Sydney', ship_state: 'NSW', items: [{ quantity: 1 }], postage: { upgrade: true, tier: 'express' } },
      { buyer_username: 'b', ship_city: 'Perth', ship_state: 'WA', items: [{ quantity: 1 }], postage: { upgrade: false, tier: 'standard' } },
    ]);
    assert.match(s, /@a[^\n]*<b>EXPRESS<\/b>/);
    assert.doesNotMatch(s, /@b[^\n]*<b>STANDARD<\/b>/, 'only exceptions get called out');
  });
});
