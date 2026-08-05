// test/unit/postsale-sweep.test.mjs — the by-id backstop.
//
// The ModTime cursor is a window, and a window can be missed: a poll that errored halfway through its
// pages, a box that was switched off, a clock that drifted. Anything that changed while we were not
// looking is invisible forever after, because the next window starts where the last one ended.
//
// sweepOpenOrders closes that by asking about specific orders BY ID — and a populated OrderIDArray
// makes eBay ignore both the status filter and the time window, so the sweep cannot be filtered out by
// the same class of thing it exists to catch.
//
// TCG_CONFIG_DIR / TCG_POSTSALE_DB must be set BEFORE lib/postsale.mjs loads (both resolve at module
// scope), hence the dynamic import — same pattern as postsale-sync.test.mjs.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.tmpdir(), 'tcg-postsale-sweep-' + process.pid);
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'postsale.config.json'), JSON.stringify({ enabled: true, messaging: false }, null, 2));
process.env.TCG_CONFIG_DIR = DIR;
process.env.TCG_POSTSALE_DB = path.join(DIR, 'postsale.db');
const { sweepOpenOrders, sweepDue } = await import('../../lib/postsale.mjs');
const { openPostsaleDb } = await import('../../lib/postsale-db.mjs');

const db = openPostsaleDb();
after(() => { try { db.close(); } catch {} try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
beforeEach(() => { db.exec('DELETE FROM order_line_items; DELETE FROM orders; DELETE FROM buyers;'); });

function seedOrder(orderId, over = {}) {
  const buyerId = db.prepare(`INSERT INTO buyers (ebay_username) VALUES (?)`).run('buyer-' + orderId).lastInsertRowid;
  const cols = { order_id: orderId, buyer_id: buyerId, buyer_username: 'buyer', shipped_status: 'unshipped',
    total_cents: 1000, paid_time: '2026-08-01T00:00:00.000Z', ...over };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO orders (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
  return orderId;
}
// The shape parseOrders produces, trimmed to what refreshOrder actually reads.
const parsed = (orderId, over = {}) => ({ orderId, orderStatus: 'Completed', ship: {}, items: [], ...over });

describe('sweepOpenOrders — what it asks about', () => {
  it('asks BY ID, and sends no time window or status filter with it', async () => {
    seedOrder('10-1-1');
    const calls = [];
    await sweepOpenOrders({}, db, { fetchOrders: async (env, opts) => { calls.push(opts); return { ok: true, orders: [] }; } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].orderIds, ['10-1-1']);
    // Those two being absent is the whole mechanism: eBay ignores them when ids are given, and sending
    // them would imply the sweep can be narrowed by the very filter that hid the order in the first place.
    assert.equal(calls[0].modTimeFrom, undefined);
    assert.equal(calls[0].orderStatus, undefined);
  });

  it('picks up the pack queue, the holds, and recently-shipped-not-delivered', async () => {
    seedOrder('queue-1');
    seedOrder('held-1', { cancel_state: 'requested' });
    seedOrder('payfail-1', { payment_state: 'failed' });
    seedOrder('intransit-1', { shipped_status: 'shipped', shipped_time: new Date().toISOString() });
    // Out of scope: finished, and long finished.
    seedOrder('done-1', { shipped_status: 'shipped', shipped_time: '2020-01-01T00:00:00.000Z', delivered_time: '2020-01-05T00:00:00.000Z' });
    seedOrder('cancelled-1', { cancel_state: 'cancelled', shipped_status: 'shipped', shipped_time: '2020-01-01T00:00:00.000Z' });

    const asked = [];
    await sweepOpenOrders({}, db, { fetchOrders: async (env, opts) => { asked.push(...opts.orderIds); return { ok: true, orders: [] }; } });
    assert.ok(asked.includes('queue-1'));
    assert.ok(asked.includes('held-1'), 'a held order is exactly what we want fresh news about');
    assert.ok(asked.includes('payfail-1'));
    assert.ok(asked.includes('intransit-1'));
    assert.ok(!asked.includes('done-1'));
    assert.ok(!asked.includes('cancelled-1'), 'a cancelled order is finished — stop asking about it');
  });

  it('chunks so one call cannot carry an unbounded id list', async () => {
    for (let i = 0; i < 45; i++) seedOrder('bulk-' + i);
    const sizes = [];
    await sweepOpenOrders({}, db, { chunk: 20, fetchOrders: async (env, opts) => { sizes.push(opts.orderIds.length); return { ok: true, orders: [] }; } });
    assert.deepEqual(sizes, [20, 20, 5]);
  });

  it('does nothing at all when there is nothing open', async () => {
    let called = 0;
    const r = await sweepOpenOrders({}, db, { fetchOrders: async () => { called++; return { ok: true, orders: [] }; } });
    assert.equal(called, 0);
    assert.equal(r.checked, 0);
  });
});

describe('sweepOpenOrders — what it does with the answer', () => {
  it('REFRESHES an order it knows and never ingests one it does not', async () => {
    seedOrder('10-2-1');
    const r = await sweepOpenOrders({}, db, {
      fetchOrders: async () => ({ ok: true, orders: [
        parsed('10-2-1', { orderStatus: 'Cancelled' }),
        // An id we never asked about. Ingesting here would walk straight past the paid gate and the
        // activation watermark, which are the two things that decide what this app adopts at all.
        parsed('stranger-1', { orderStatus: 'Completed' }),
      ] }),
    });
    assert.equal(r.refreshed, 1);
    assert.equal(db.prepare('SELECT cancel_state FROM orders WHERE order_id=?').get('10-2-1').cancel_state, 'cancelled');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 1, 'the stranger must not be adopted');
  });

  it('reports a cancellation as a move, so the caller can restock and alert', async () => {
    seedOrder('10-2-2');
    const r = await sweepOpenOrders({}, db, {
      fetchOrders: async () => ({ ok: true, orders: [parsed('10-2-2', { cancelStatus: 'CancelComplete' })] }),
    });
    assert.deepEqual(r.holdMoves, [{ orderId: '10-2-2', kind: 'cancel', state: 'cancelled', becameCancelled: true }]);
  });

  it('reports a failed payment as its own kind of move', async () => {
    seedOrder('10-2-3');
    const r = await sweepOpenOrders({}, db, {
      fetchOrders: async () => ({ ok: true, orders: [parsed('10-2-3', { paidStatus: 'BuyerECheckBounced' })] }),
    });
    assert.deepEqual(r.holdMoves, [{ orderId: '10-2-3', kind: 'payment', state: 'failed', becameCancelled: false }]);
  });

  it('names an id eBay simply did not return rather than assuming anything about it', async () => {
    seedOrder('10-2-4');
    const r = await sweepOpenOrders({}, db, { fetchOrders: async () => ({ ok: true, orders: [] }) });
    assert.deepEqual(r.missing, ['10-2-4']);
    // No news is not "cancelled" and not "fine" — it is unknown, and it says so.
    assert.equal(db.prepare('SELECT cancel_state FROM orders WHERE order_id=?').get('10-2-4').cancel_state, null);
  });

  it('a failed eBay call stops the sweep instead of half-reporting it', async () => {
    seedOrder('10-2-5');
    const r = await sweepOpenOrders({}, db, { fetchOrders: async () => ({ ok: false, ack: 'Failure', errors: [{ longMessage: 'nope' }] }) });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'GetOrders failed');
  });
});

// The restock is driven off holdMove.becameCancelled, and a cancellation fires exactly ONCE — the next
// refresh sees cancel_state already written and reports no move. So anything that swallows that first
// move loses the stock permanently, with nothing left to notice.
describe('a cancellation is never swallowed by a same-poll payment change', () => {
  it('reports becameCancelled even when the payment status moved in the same refresh', async () => {
    seedOrder('10-3-1');
    const r = await sweepOpenOrders({}, db, {
      // eBay does exactly this when it cancels an unpaid order: the cancellation and the payment
      // status both change in one response.
      fetchOrders: async () => ({ ok: true, orders: [parsed('10-3-1', {
        orderStatus: 'Cancelled', cancelStatus: 'CancelComplete', paidStatus: 'BuyerECheckBounced' })] }),
    });
    assert.equal(r.holdMoves.length, 1);
    assert.equal(r.holdMoves[0].becameCancelled, true,
      'without this the stock is never put back, and no later poll will try again');
    assert.equal(r.holdMoves[0].kind, 'cancel');
  });

  it('a plain payment failure still reports as a payment move, not a cancellation', async () => {
    seedOrder('10-3-2');
    const r = await sweepOpenOrders({}, db, {
      fetchOrders: async () => ({ ok: true, orders: [parsed('10-3-2', { paidStatus: 'BuyerCreditCardFailed' })] }),
    });
    assert.equal(r.holdMoves[0].kind, 'payment');
    assert.equal(r.holdMoves[0].becameCancelled, false, 'a failed payment must never restock — the buyer may still pay');
  });

  it('a routine in-flight payment on an order with no card is not a move at all', async () => {
    seedOrder('10-3-3');
    const r = await sweepOpenOrders({}, db, {
      fetchOrders: async () => ({ ok: true, orders: [parsed('10-3-3', { paidStatus: 'PayPalPaymentInProcess' })] }),
    });
    assert.deepEqual(r.holdMoves, [], 'ordinary payment chatter must not run a settle round');
  });
});

// The ↻ on the dashboard promises "ask eBay right now". The windowed query cannot answer that for a
// change that happened before the cursor — which is the usual reason somebody presses it — so the
// manual path has to sweep by id, whatever the background clock says.
describe('sweepDue — when a poll also sweeps by id', () => {
  const cfg = { sweep_interval_min: 60 };
  const justNow = new Date().toISOString();

  it('a manual sync sweeps even though it swept a moment ago', () => {
    assert.equal(sweepDue('manual', cfg, justNow), true, 'a person asking is not the schedule');
  });

  it('a manual sync sweeps even when the background timer is switched off', () => {
    // sweep_interval_min: 0 means "do not do this on a timer". It does not mean the button should
    // stop being able to answer the one question it exists to answer.
    assert.equal(sweepDue('manual', { sweep_interval_min: 0 }, justNow), true);
  });

  it('a scheduled tick keeps its clock', () => {
    assert.equal(sweepDue('schedule', cfg, justNow), false);
    assert.equal(sweepDue('schedule', cfg, new Date(Date.now() - 61 * 60_000).toISOString()), true);
  });

  it('a scheduled tick sweeps once on a fresh install, then waits', () => {
    assert.equal(sweepDue('schedule', cfg, null), true);
  });

  it('0 turns the SCHEDULED sweep off entirely', () => {
    assert.equal(sweepDue('schedule', { sweep_interval_min: 0 }, null), false);
    assert.equal(sweepDue('schedule', {}, null), false, 'a missing key reads as off, not as every tick');
  });
});
