// test/unit/ebay-notify-observe.test.mjs — the observe worker, and the boundary that makes it safe.
//
// Observe mode exists so push can be trusted on evidence rather than on hope: it reads each notified
// order back from eBay and writes down what was true, while the existing poll keeps doing every bit
// of the real work. The tests that matter most are therefore the NEGATIVE ones — what it must not
// touch — because a mistake there reaches a buyer rather than a log file.
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-observe-'));
process.env.TCG_CONFIG_DIR = DIR;
process.env.TCG_POSTSALE_DB = path.join(DIR, 'postsale.db');
const { openPostsaleDb } = await import('../../lib/postsale-db.mjs');
const { observeOrderEvents, observationSummary } = await import('../../lib/ebay-notify-observe.mjs');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* windows locks */ } });

const db = openPostsaleDb();

function addEvent(id, orderId, { eventDate = '2026-08-07T01:00:00.000Z', received = "datetime('now')" } = {}) {
  db.prepare(`INSERT INTO notify_events (notification_id, topic, ref_id, event_date, status, action, received_at)
              VALUES (?,?,?,?, 'received', 'order_by_id', ${received})`)
    .run(id, 'ORDER_CONFIRMATION', orderId, eventDate);
}
function addOrder(orderId, ingestedAt = null) {
  db.prepare(`INSERT INTO buyers (id, ebay_username) VALUES (?,?) ON CONFLICT(id) DO NOTHING`).run(1, 'buyer');
  db.prepare(`INSERT INTO orders (order_id, buyer_id, buyer_username, currency, total_cents, ingested_at)
              VALUES (?,?,?,?,?, COALESCE(?, datetime('now')))`)
    .run(orderId, 1, 'buyer', 'AUD', 1000, ingestedAt);
}
const parsedOrder = (orderId, over = {}) => ({
  orderId, paid: true, paidTime: '2026-08-07T01:00:05.000Z', orderStatus: 'Completed',
  totalCents: 2500, items: [{ itemId: '1', sku: 'AAA-001' }], ship: {}, ...over,
});
const okFetch = (orders) => async () => ({ ok: true, orders, hasMore: false });

beforeEach(() => {
  db.exec('DELETE FROM notify_events; DELETE FROM order_line_items; DELETE FROM orders; DELETE FROM buyers;');
});

describe('observeOrderEvents — reads eBay, records what it saw', () => {
  it('marks a notification handled and writes the observation', async () => {
    addEvent('n1', '10-1');
    const r = await observeOrderEvents({}, db, { fetchOrders: okFetch([parsedOrder('10-1')]) });
    assert.equal(r.ok, true);
    assert.equal(r.observed, 1);
    const row = db.prepare('SELECT * FROM notify_events WHERE notification_id=?').get('n1');
    assert.equal(row.status, 'handled');
    assert.equal(row.action, 'observed');
    const obs = JSON.parse(row.observation);
    assert.equal(obs.found_on_ebay, true);
    assert.equal(obs.paid, true);
    assert.equal(obs.total_cents, 2500);
    assert.match(obs.note, /nothing was ingested/);
  });

  it('records whether the poll had already ingested the order — the whole point', async () => {
    addEvent('known', '10-KNOWN');
    addEvent('fresh', '10-FRESH');
    addOrder('10-KNOWN');
    const r = await observeOrderEvents({}, db, { fetchOrders: okFetch([parsedOrder('10-KNOWN'), parsedOrder('10-FRESH')]) });
    assert.equal(r.ahead_of_poll, 1, 'exactly one order was not yet known when its push arrived');
    const known = JSON.parse(db.prepare('SELECT observation o FROM notify_events WHERE notification_id=?').get('known').o);
    const fresh = JSON.parse(db.prepare('SELECT observation o FROM notify_events WHERE notification_id=?').get('fresh').o);
    assert.equal(known.order_known_at_receipt, true);
    assert.equal(fresh.order_known_at_receipt, false, 'push beat the poll for this one');
  });

  it('notes an order eBay announced but will not yet return, without failing', async () => {
    // Real behaviour: eBay's order service can announce a sale before GetOrders will serve it. The
    // scheduled poll picks those up regardless, so this is a note rather than an error.
    addEvent('n2', '10-NOTYET');
    const r = await observeOrderEvents({}, db, { fetchOrders: okFetch([]) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, ['10-NOTYET']);
    const obs = JSON.parse(db.prepare('SELECT observation o FROM notify_events WHERE notification_id=?').get('n2').o);
    assert.equal(obs.found_on_ebay, false);
    assert.equal(obs.paid, null);
  });

  it('asks eBay once for an order two notifications point at', async () => {
    addEvent('a', '10-SAME');
    addEvent('b', '10-SAME');
    let asked = [];
    const r = await observeOrderEvents({}, db, {
      fetchOrders: async (env, { orderIds }) => { asked = asked.concat(orderIds); return { ok: true, orders: [parsedOrder('10-SAME')] }; },
    });
    assert.deepEqual(asked, ['10-SAME'], 'a redelivery must not cost a second API call');
    assert.equal(r.observed, 2, 'both rows are still settled');
  });

  it('leaves everything alone when there is nothing due', async () => {
    let called = false;
    const r = await observeOrderEvents({}, db, { fetchOrders: async () => { called = true; return { ok: true, orders: [] }; } });
    assert.equal(r.considered, 0);
    assert.equal(called, false, 'no events means no call to eBay');
  });

  it('does not settle rows when eBay fails, so they are retried', async () => {
    addEvent('n3', '10-3');
    const r = await observeOrderEvents({}, db, { fetchOrders: async () => ({ ok: false, ack: 'Failure', errors: [] }) });
    assert.equal(r.ok, false);
    const row = db.prepare('SELECT status, action FROM notify_events WHERE notification_id=?').get('n3');
    assert.equal(row.status, 'received', 'a failed read must leave the event due, not mark it handled');
    assert.equal(row.action, 'order_by_id');
  });

  it('only looks at order events, not every topic', async () => {
    db.prepare(`INSERT INTO notify_events (notification_id, topic, ref_id, status, action)
                VALUES ('fb','FEEDBACK_RECEIVED','x','received','record_only')`).run();
    const r = await observeOrderEvents({}, db, { fetchOrders: okFetch([]) });
    assert.equal(r.considered, 0, 'record_only topics are not this worker’s business');
  });
});

// The guarantee the owner actually asked for. These assert on the module SOURCE because the point is
// that the capability is absent, not merely unused — a behavioural test can only show that a given
// path did not write, never that no path can.
describe('the read-only boundary', () => {
  const src = fs.readFileSync(new URL('../../lib/ebay-notify-observe.mjs', import.meta.url), 'utf8');

  it('imports nothing that can write to eBay or to a buyer', () => {
    const imports = [...src.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['./ebay-trading.mjs'], 'the only dependency should be the read it makes');
    for (const banned of ['postsale-llm', 'telegram', 'ebay-rest', 'listings.mjs', 'db.mjs']) {
      assert.ok(!imports.some((i) => i.includes(banned)), `must not import ${banned}`);
    }
  });

  it('calls only getOrders out of the Trading API', () => {
    const named = (/import\s*\{([^}]+)\}\s*from\s*'\.\/ebay-trading\.mjs'/.exec(src) || [, ''])[1];
    assert.deepEqual(named.split(',').map((s) => s.trim()).filter(Boolean), ['getOrders'],
      'sendBuyerMessage, completeSale and the Revise* calls must not even be in scope');
  });

  it('never calls the ingest, messaging, stock or dispatch paths', () => {
    for (const fn of ['ingestOrder', 'refreshOrder', 'enqueueMessage', 'processMessages',
      'applyStockDecrements', 'reverseStockForOrder', 'settleHolds', 'dispatchOrder',
      'sendBuyerMessage', 'sendMessage', 'completeSale']) {
      assert.doesNotMatch(src, new RegExp('\\b' + fn + '\\s*\\('), `${fn}() must not be called from observe mode`);
    }
  });

  it('writes to notify_events and nothing else', () => {
    const writes = [...src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/gi)].map((m) => m[2].toLowerCase());
    for (const t of writes) {
      assert.equal(t, 'notify_events', `observe mode wrote to ${t}; only its own audit log is fair game`);
    }
  });
});

describe('observationSummary — the evidence the soak is for', () => {
  it('excludes eBay’s own test notifications from the measurement', async () => {
    // testSubscription sends literal placeholders — the orderId comes through as the string
    // "string" — so it never resolves. Counting it as "push beat the poll" would inflate precisely
    // the number this mode exists to produce. Seen for real on the live account.
    addEvent('t1', 'string');
    await observeOrderEvents({}, db, { fetchOrders: okFetch([]) });
    const s = observationSummary(db, { days: 7 });
    assert.equal(s.notifications, 1);
    assert.equal(s.test_notifications, 1);
    assert.equal(s.ahead_of_poll, 0, 'a test payload is not evidence of anything');
    assert.equal(s.matched_to_an_order, 0);
  });

  it('counts ahead-of-poll from the timestamps, not from when the pass happened to run', async () => {
    // order_known_at_receipt is evaluated when the observe pass runs. Drain a backlog hours late and
    // the poll has already caught up, so orders push genuinely announced first read as "already
    // known". The recorded timestamps do not drift like that, so the summary derives from those.
    addEvent('late', '10-LATE');
    db.prepare("UPDATE notify_events SET received_at = datetime('now','-600 seconds') WHERE notification_id='late'").run();
    addOrder('10-LATE');   // the poll adopted it AFTER the push arrived
    // Observe only now — long after both, which is what makes the snapshot misleading.
    await observeOrderEvents({}, db, { fetchOrders: okFetch([parsedOrder('10-LATE')]) });
    const obs = JSON.parse(db.prepare("SELECT observation o FROM notify_events WHERE notification_id='late'").get().o);
    assert.equal(obs.order_known_at_receipt, true, 'the snapshot says known, because the poll caught up first');
    const s = observationSummary(db, { days: 7 });
    assert.equal(s.ahead_of_poll, 1, 'but the timestamps show push announced it first, which is the truth');
  });

  it('is safe on an empty table', () => {
    const s = observationSummary(db, { days: 7 });
    assert.ok(!s.error, 'an empty table is not an error: ' + s.error);
    assert.equal(s.notifications, 0);
    assert.equal(s.median_lead_over_poll_s, null);
  });

  it('measures how much later the poll adopted an order than push announced it', async () => {
    // The number the soak exists to produce. orders.ingested_at is when the poll adopted it;
    // notify_events.received_at is when the push arrived.
    addEvent('lead1', '10-LEAD');
    db.prepare("UPDATE notify_events SET received_at = datetime('now','-300 seconds') WHERE notification_id='lead1'").run();
    await observeOrderEvents({}, db, { fetchOrders: okFetch([parsedOrder('10-LEAD')]) });
    addOrder('10-LEAD');   // the poll catches up now, five minutes later
    const s = observationSummary(db, { days: 7 });
    assert.equal(s.matched_to_an_order, 1);
    assert.ok(s.median_lead_over_poll_s >= 290 && s.median_lead_over_poll_s <= 310,
      'expected roughly 300s of lead, got ' + s.median_lead_over_poll_s);
  });
});
