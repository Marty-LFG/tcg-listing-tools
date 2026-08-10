// test/unit/postsale-cursor-hold.test.mjs — orders_cursor is the one piece of state in this app that
// can lose a sale rather than delay one.
//
// The poll reads a ModTime window and then moves the cursor to the end of it. Anything inside that
// window it did not actually read is invisible for ever after, because the next window starts where
// this one stopped. There are two ways to end up there, and both must hold the cursor instead:
//
//   1. TRUNCATION — max_per_run or MAX_PAGES stopped the sweep with orders still in the window.
//   2. AN EXPECTED ORDER THAT DID NOT ARRIVE — push mode names the order it was told about, and
//      eBay's order service can announce a sale a moment before GetOrders will return it. Polling
//      seconds after the notification is exactly when that gap is open, which is why poll mode had
//      to bring this guard with it.
//
// The whole suite runs offline through the injected fetchOrders seam.
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.tmpdir(), 'tcg-cursor-hold-' + process.pid);
fs.mkdirSync(DIR, { recursive: true });
// messaging off and no background sweep: this suite is about the cursor, and both of those would
// otherwise reach the network on a path that has nothing to do with it.
fs.writeFileSync(path.join(DIR, 'postsale.config.json'), JSON.stringify({
  enabled: true, messaging: false, alerts: false, dry_run: true, sweep_interval_min: 0, max_per_run: 10,
}, null, 2));
process.env.TCG_CONFIG_DIR = DIR;
process.env.TCG_POSTSALE_DB = path.join(DIR, 'postsale.db');
const { pollOrders } = await import('../../lib/postsale.mjs');
const { openPostsaleDb } = await import('../../lib/postsale-db.mjs');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* windows locks */ } });

const db = openPostsaleDb();
const setMeta = (k, v) => db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
const getMeta = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value ?? null;

const CURSOR = '2026-08-10T00:00:00.000Z';
const order = (orderId) => ({
  orderId, paid: true, paidTime: '2026-08-10T01:00:00.000Z', orderStatus: 'Completed',
  totalCents: 2500, currency: 'AUD', buyerUsername: 'buyer', items: [], ship: {},
});
const returning = (...orders) => async () => ({ ok: true, orders, hasMore: false });

beforeEach(() => {
  db.exec('DELETE FROM notify_events; DELETE FROM order_line_items; DELETE FROM orders; DELETE FROM buyers; DELETE FROM meta;');
  // Pre-set so the poll does not cold-start its watermark off eBay's clock, and so every order below
  // is comfortably after it.
  setMeta('activation_watermark', '2026-01-01T00:00:00.000Z');
  setMeta('orders_cursor', CURSOR);
});

describe('a push-triggered poll that got what it was promised', () => {
  it('adopts the order and moves the cursor on', async () => {
    const r = await pollOrders({}, db, { trigger: 'notification', expect: ['10-1'], fetchOrders: returning(order('10-1')) });
    assert.equal(r.ok, true);
    assert.equal(r.ingested, 1);
    assert.deepEqual(r.awaiting, []);
    assert.notEqual(getMeta('orders_cursor'), CURSOR, 'a window that delivered everything expected is finished with');
  });

  it('is satisfied by an order it already held, without re-ingesting it', async () => {
    // A redelivered notification for an order the poll adopted last time. The window is complete —
    // holding the cursor here would re-read the same window for ever.
    await pollOrders({}, db, { trigger: 'notification', expect: ['10-1'], fetchOrders: returning(order('10-1')) });
    const moved = getMeta('orders_cursor');
    setMeta('orders_cursor', CURSOR);
    const r = await pollOrders({}, db, { trigger: 'notification', expect: ['10-1'], fetchOrders: returning() });
    assert.deepEqual(r.awaiting, [], 'we have the order; that eBay did not mention it again is not a gap');
    assert.notEqual(getMeta('orders_cursor'), CURSOR);
    assert.ok(moved, 'sanity: the first poll did move it');
  });
});

describe('a push-triggered poll for an order eBay has not returned yet', () => {
  it('HOLDS the cursor, so the next window still covers the sale', async () => {
    // The failure this guards against is silent and permanent: advance past 10-NOTYET here and its
    // ModTime is behind every future window, so no poll ever sees it again and the sale is simply
    // never adopted.
    const r = await pollOrders({}, db, { trigger: 'notification', expect: ['10-NOTYET'], fetchOrders: returning() });
    assert.equal(r.ok, true, 'this is a normal occurrence, not a failure');
    assert.deepEqual(r.awaiting, ['10-NOTYET']);
    assert.equal(getMeta('orders_cursor'), CURSOR, 'the cursor must not move past an order nobody read');
  });

  it('holds for the one that is missing even when other orders did arrive', async () => {
    const r = await pollOrders({}, db, {
      trigger: 'notification', expect: ['10-HERE', '10-NOTYET'], fetchOrders: returning(order('10-HERE')),
    });
    assert.equal(r.ingested, 1, 'the order that did arrive is still adopted immediately');
    assert.deepEqual(r.awaiting, ['10-NOTYET']);
    assert.equal(getMeta('orders_cursor'), CURSOR);
  });

  it('lets the next SCHEDULED poll release the cursor, so a hold can never stick', async () => {
    // The reason the hold is safe to apply so readily: only the notification path passes `expect`.
    // An order eBay announced and then never returned at all would otherwise pin the cursor for ever.
    await pollOrders({}, db, { trigger: 'notification', expect: ['string'], fetchOrders: returning() });
    assert.equal(getMeta('orders_cursor'), CURSOR, 'held, as it should be');
    const r = await pollOrders({}, db, { trigger: 'schedule', fetchOrders: returning() });
    assert.deepEqual(r.awaiting, []);
    assert.notEqual(getMeta('orders_cursor'), CURSOR, 'the schedule always drains its own window');
  });
});

describe('the truncation hold still works', () => {
  it('holds when max_per_run cut the window short', async () => {
    // Guarding the guard: `expect` shares the cursor decision with truncation, and an edit that
    // reads one condition and forgets the other looks perfectly fine.
    const many = Array.from({ length: 12 }, (_, i) => order('10-' + i));
    const r = await pollOrders({}, db, { trigger: 'schedule', fetchOrders: returning(...many) });
    assert.equal(r.truncated, true, 'max_per_run is 10 and twelve orders arrived');
    assert.equal(getMeta('orders_cursor'), CURSOR, 'an unread remainder must be re-read, not skipped');
  });
});
