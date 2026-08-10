// test/unit/ebay-notify-react.test.mjs — poll mode: the notification that actually does something.
//
// Observe mode proved push arrives first. Poll mode spends that lead, and the way it spends it is the
// thing worth testing: it does NOT ingest, alert or restock. It calls runOrderPoll, the same function
// the ten-minute timer calls, early. So the tests here are mostly about the two things that are
// genuinely this module's own — that the poll is asked to HOLD ITS CURSOR for an order eBay announced
// but has not returned yet, and that the audit rows settle rather than piling up unpruned.
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-react-'));
process.env.TCG_CONFIG_DIR = DIR;
process.env.TCG_POSTSALE_DB = path.join(DIR, 'postsale.db');
const { openPostsaleDb } = await import('../../lib/postsale-db.mjs');
const { reactToOrderEvents } = await import('../../lib/ebay-notify-react.mjs');
const { observationSummary } = await import('../../lib/ebay-notify-observe.mjs');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* windows locks */ } });

const db = openPostsaleDb();

function addEvent(id, orderId, { action = 'order_by_id', topic = 'ORDER_CONFIRMATION' } = {}) {
  db.prepare(`INSERT INTO notify_events (notification_id, topic, ref_id, event_date, status, action)
              VALUES (?,?,?,?, 'received', ?)`)
    .run(id, topic, orderId, '2026-08-07T01:00:00.000Z', action);
}
function addOrder(orderId) {
  db.prepare(`INSERT INTO buyers (id, ebay_username) VALUES (?,?) ON CONFLICT(id) DO NOTHING`).run(1, 'buyer');
  db.prepare(`INSERT INTO orders (order_id, buyer_id, buyer_username, currency, total_cents)
              VALUES (?,?,?,?,?)`).run(orderId, 1, 'buyer', 'AUD', 1000);
}
const row = (id) => db.prepare('SELECT * FROM notify_events WHERE notification_id=?').get(id);

/** A poll that adopts whatever it is told to, so the module's own behaviour is what is under test. */
const pollAdopting = (...ids) => {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); for (const id of ids) addOrder(id); return { ok: true, ingested: ids.length }; };
  fn.calls = calls;
  return fn;
};

beforeEach(() => {
  db.exec('DELETE FROM notify_events; DELETE FROM order_line_items; DELETE FROM orders; DELETE FROM buyers;');
});

describe('reactToOrderEvents — a notification runs the real poll', () => {
  it('names the notified orders so the poll can hold its cursor for them', async () => {
    // The single most important assertion in this file. Without `expect`, a poll running two seconds
    // after the notification advances orders_cursor past a sale eBay had not yet returned, and that
    // order then falls outside every future window: lost, not late.
    addEvent('n1', '10-1');
    const poll = pollAdopting('10-1');
    await reactToOrderEvents({}, db, { runPoll: poll });
    assert.equal(poll.calls.length, 1, 'exactly one poll for one notification');
    assert.deepEqual(poll.calls[0].expect, ['10-1'], 'the poll must be told which order it is answering');
    assert.equal(poll.calls[0].trigger, 'notification',
      'not "manual" — a notification is not a person, and manual forces a by-id sweep on every sale');
  });

  it('settles the notification once the poll has adopted the order', async () => {
    addEvent('n1', '10-1');
    const r = await reactToOrderEvents({}, db, { runPoll: pollAdopting('10-1') });
    assert.equal(r.adopted, 1);
    const ev = row('n1');
    assert.equal(ev.status, 'handled', 'an unsettled row is never pruned, so it has to settle');
    assert.equal(ev.action, 'polled');
    const obs = JSON.parse(ev.observation);
    assert.equal(obs.mode, 'poll');
    assert.equal(obs.order_adopted, true);
    assert.equal(obs.order_known_at_receipt, false, 'push got there before the poll had it');
  });

  it('records that the poll already had the order, when it did', async () => {
    addEvent('n1', '10-1');
    addOrder('10-1');
    const r = await reactToOrderEvents({}, db, { runPoll: pollAdopting() });
    assert.equal(r.adopted, 1);
    assert.equal(JSON.parse(row('n1').observation).order_known_at_receipt, true);
  });

  it('polls once for two notifications about the same order', async () => {
    addEvent('a', '10-SAME');
    addEvent('b', '10-SAME');
    const poll = pollAdopting('10-SAME');
    const r = await reactToOrderEvents({}, db, { runPoll: poll });
    assert.deepEqual(poll.calls[0].expect, ['10-SAME'], 'a redelivery must not be counted as a second sale');
    assert.equal(r.considered, 2);
    assert.equal(row('a').status, 'handled');
    assert.equal(row('b').status, 'handled', 'both rows settle even though one poll covered them');
  });

  it('never reaches eBay when nothing is due', async () => {
    let called = false;
    const r = await reactToOrderEvents({}, db, { runPoll: async () => { called = true; return { ok: true }; } });
    assert.equal(r.considered, 0);
    assert.equal(called, false);
  });

  it('ignores topics whose action is not an order lookup', async () => {
    addEvent('fb', 'x', { action: 'record_only', topic: 'FEEDBACK_RECEIVED' });
    const r = await reactToOrderEvents({}, db, { runPoll: pollAdopting() });
    assert.equal(r.considered, 0);
  });
});

describe('an order eBay announced but will not yet return', () => {
  it('retries rather than settling, and leaves the row due', async () => {
    // Real behaviour, documented in observe mode and seen live: eBay's order service can announce a
    // sale before GetOrders will serve it. Reacting seconds after the notification is exactly when
    // that gap is open.
    addEvent('n1', '10-NOTYET');
    const r = await reactToOrderEvents({}, db, { runPoll: pollAdopting() });
    assert.equal(r.retrying, 1);
    assert.equal(r.gave_up, 0);
    const ev = row('n1');
    assert.equal(ev.status, 'received', 'still due — the retry is what makes this fast rather than correct');
    assert.equal(ev.attempt, 1);
    assert.ok(ev.next_attempt_at, 'a retry with no next_attempt_at would spin');
  });

  it('does not look again until the retry is due', async () => {
    addEvent('n1', '10-NOTYET');
    db.prepare("UPDATE notify_events SET next_attempt_at = datetime('now','+60 seconds') WHERE notification_id='n1'").run();
    let called = false;
    const r = await reactToOrderEvents({}, db, { runPoll: async () => { called = true; return { ok: true }; } });
    assert.equal(r.considered, 0);
    assert.equal(called, false, 'min_gap_ms is what stops a notification storm spending the day’s call budget');
  });

  it('gives up after a bounded number of attempts and hands it to the schedule', async () => {
    // The retry budget is small on purpose: the cursor guard already guarantees the next scheduled
    // poll covers this order, so retrying is a latency optimisation and must not become load-bearing.
    addEvent('n1', 'string');   // eBay's own test payload never resolves to an order
    const poll = pollAdopting();
    for (let i = 0; i < 3; i++) {
      db.prepare("UPDATE notify_events SET next_attempt_at = NULL WHERE notification_id='n1'").run();
      await reactToOrderEvents({}, db, { runPoll: poll });
    }
    assert.equal(poll.calls.length, 3, 'three attempts, then it stops');
    const ev = row('n1');
    assert.equal(ev.status, 'handled', 'a row that can never resolve still has to settle, or it is never pruned');
    assert.equal(ev.attempt, 3);
    const obs = JSON.parse(ev.observation);
    assert.equal(obs.order_adopted, false);
    assert.match(obs.note, /cursor was held/);
  });

  it('keeps the row due when the poll itself failed', async () => {
    addEvent('n1', '10-1');
    const r = await reactToOrderEvents({}, db, { runPoll: async () => ({ ok: false, error: 'GetOrders failed' }) });
    assert.equal(r.ok, false);
    assert.equal(row('n1').status, 'received', 'a failed poll must not mark the sale dealt with');
  });

  it('survives the poll throwing, rather than taking the listener down with it', async () => {
    addEvent('n1', '10-1');
    const r = await reactToOrderEvents({}, db, { runPoll: async () => { throw new Error('boom'); } });
    assert.equal(r.ok, false);
    assert.equal(row('n1').status, 'received');
  });
});

// The guarantee that makes poll mode safe to turn on: there is no second pipeline. Asserted against
// the SOURCE, because the point is that the capability is absent rather than merely unexercised.
describe('there is no second pipeline', () => {
  const src = fs.readFileSync(new URL('../../lib/ebay-notify-react.mjs', import.meta.url), 'utf8');

  it('never sends, ingests, restocks or dispatches on its own account', () => {
    for (const fn of ['ingestOrder', 'refreshOrder', 'enqueueMessage', 'processMessages',
      'applyStockDecrements', 'reverseStockForOrder', 'settleHolds', 'dispatchOrder', 'fireSaleAlert',
      'sendBuyerMessage', 'sendMessage', 'completeSale', 'getOrders']) {
      assert.doesNotMatch(src, new RegExp('\\b' + fn + '\\s*\\('),
        `${fn}() here would be a second copy of the pipeline — the poll is meant to be the only one`);
    }
  });

  it('reaches the pipeline through runOrderPoll and nothing else', () => {
    const reaches = [...src.matchAll(/['"]\.\/postsale\.mjs['"]/g)];
    assert.equal(reaches.length, 1, 'exactly one route into postsale.mjs');
    assert.match(src, /const \{ runOrderPoll \} = await import\('\.\/postsale\.mjs'\)/,
      'runOrderPoll is the whole interface: every alert and stock move must stay the poll’s own');
  });

  it('writes to notify_events and nothing else', () => {
    const writes = [...src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/gi)].map((m) => m[2].toLowerCase());
    for (const t of writes) {
      assert.equal(t, 'notify_events', `poll mode wrote to ${t} directly; only its own audit log is fair game`);
    }
  });
});

describe('observationSummary — poll-mode rows', () => {
  it('counts an order eBay never returned as unresolved, not as evidence', async () => {
    addEvent('n1', 'string');
    const poll = pollAdopting();
    for (let i = 0; i < 3; i++) {
      db.prepare("UPDATE notify_events SET next_attempt_at = NULL WHERE notification_id='n1'").run();
      await reactToOrderEvents({}, db, { runPoll: poll });
    }
    const s = observationSummary(db, { days: 7 });
    assert.equal(s.notifications, 1);
    assert.equal(s.unresolved, 1);
    assert.equal(s.ahead_of_poll, 0, 'a payload that never resolved says nothing about latency');
    assert.equal(s.matched_to_an_order, 0);
  });

  it('measures reaction time once the order is real', async () => {
    addEvent('n1', '10-FAST');
    db.prepare("UPDATE notify_events SET received_at = datetime('now','-8 seconds') WHERE notification_id='n1'").run();
    await reactToOrderEvents({}, db, { runPoll: pollAdopting('10-FAST') });
    const s = observationSummary(db, { days: 7 });
    assert.equal(s.matched_to_an_order, 1);
    assert.ok(s.median_lead_over_poll_s >= 5 && s.median_lead_over_poll_s <= 15,
      'in poll mode the lead IS the reaction time — expected roughly 8s, got ' + s.median_lead_over_poll_s);
  });
});
