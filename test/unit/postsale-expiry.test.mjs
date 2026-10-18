// test/unit/postsale-expiry.test.mjs — a stale buyer message cannot be sent, and no message can be
// sent twice (audit 2026-10, findings P1 and P5).
//
// P1: 39 drafts sat in awaiting_approval on the live box, 4 to 75 days old. Every order had shipped,
// 9 thank-yous still promised "tomorrow", and 7 were on orders where the buyer had already written in.
// Nothing expired them, and Send re-checked nothing but the (switched off) same-day promise.
//
// P5: the Telegram tap claimed the row as 'sending' and then put it BACK to awaiting_approval before
// the eBay call, and the dashboard's Approve took no claim at all, so a tap in one place during a send
// from the other sent the buyer the same message twice.
//
// Nothing here can reach eBay or Telegram: every send goes through an injected `sendBuyer` stub, the
// env carries no tokens (tgCall answers { disabled } without a request), and the database is a temp
// file opened with openPostsaleDbAt. TCG_CONFIG_DIR must be set BEFORE lib/postsale.mjs loads, because
// CONFIG_PATH resolves at module scope, hence the dynamic import.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';

const DIR = tmpDir('tcg-postsale-expiry-');
const TAPPER = { id: 4242, username: 'owner' };
// dry_run OFF so the send path really reaches its sender. The sender is always the stub below.
const CFG_FILE = path.join(DIR, 'postsale.config.json');
fs.writeFileSync(CFG_FILE, JSON.stringify({
  enabled: false, mode: 'approve', dry_run: false, telegram_allowed_user_ids: [TAPPER.id],
  quiet_hours: { enabled: false, start: '21:00', end: '08:00' }, holidays: [],
}, null, 2));
process.env.TCG_CONFIG_DIR = DIR;
process.env.TCG_POSTSALE_DB = path.join(DIR, 'unused-singleton.db');

const { openPostsaleDbAt } = await import('../../lib/postsale-db.mjs');
const ps = await import('../../lib/postsale.mjs');
const { ingestOrder, loadConfig, messageExpiry, sendRefusal, buyerInContact, expireStaleMessages,
  sendPostsaleMessage, onPostsaleUpdate, SEND_REFUSALS } = ps;

const ENV = {};   // no TELEGRAM_*, no eBay: nothing in this file can leave the box
let db, cfg;
before(() => { db = openPostsaleDbAt(path.join(DIR, 'postsale.db')); cfg = loadConfig(); });
after(() => { try { db.close(); } catch {} try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 }); } catch {} });

const HOUR = 3_600_000;
// The real clock, not a fixed date: the Telegram path asks sendPostsaleMessage with its own Date.now(),
// so a fixture aged against anything else would drift into "expired" as the calendar moves on.
const NOW = Date.now();
// SQLite's own format, which is what created_at really holds: UTC, space-separated, no zone.
const sqlAt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

let seq = 0;
const mkOrder = (id, over = {}) => ({
  orderId: id, buyerUsername: 'buyer_' + id.toLowerCase(), orderStatus: 'Completed', checkoutStatus: 'Complete',
  paidStatus: 'NoPaymentFailure', createdTime: '2026-10-10T01:00:00.000Z', paidTime: '2026-10-10T01:05:00.000Z',
  shippedTime: null, currency: 'AUD', totalCents: 1200, subtotalCents: 1000, shippingCents: 200,
  shipService: 'AU_Regular', paid: true,
  ship: { name: 'Test Buyer', street1: '1 Test St', street2: null, city: 'Sydney', state: 'NSW', postal: '2000', country: 'AU', countryName: 'Australia', phone: null },
  items: [{ orderLineItemId: id + '-1', transactionId: 'tx-' + id, itemId: '7700' + id.replace(/\D/g, ''), sku: 'AAA-001', title: 'Test Card', quantity: 1, unitPriceCents: 1000 }],
  ...over,
});

/**
 * One order and one message on it, in exactly the state a test names. Orders are unique per call so
 * no test can lean on another's rows (the reply checks are per BUYER, and shared buyers leak).
 */
function seed({ kind = 'purchase', status = 'awaiting_approval', ageH = 1, order = {}, card = false } = {}) {
  const id = 'X-' + (++seq);
  ingestOrder(db, mkOrder(id), cfg);
  if (Object.keys(order).length) {
    db.prepare(`UPDATE orders SET ${Object.keys(order).map((k) => k + '=?').join(', ')} WHERE order_id=?`)
      .run(...Object.values(order), id);
  }
  if (kind !== 'purchase') {
    // A follow-up means the thank-you went out long ago. Left 'pending' it would be a second, unasked
    // for row on a shipped order, and the sweep would (correctly) retire it.
    db.prepare(`UPDATE postsale_messages SET status='sent', sent_at=? WHERE order_id=? AND kind='purchase'`).run(sqlAt(NOW - 200 * HOUR), id);
    db.prepare(`INSERT INTO postsale_messages (order_id, kind, buyer_id, status)
                SELECT order_id, ?, buyer_id, 'pending' FROM orders WHERE order_id=?`).run(kind, id);
  }
  const m = db.prepare('SELECT * FROM postsale_messages WHERE order_id=? AND kind=?').get(id, kind);
  db.prepare(`UPDATE postsale_messages SET status=?, subject='Thanks!', body='Cheers, packed and sent tomorrow. -BK',
              created_at=?, updated_at=?, telegram_chat_id=?, telegram_message_id=? WHERE id=?`)
    .run(status, sqlAt(NOW - ageH * HOUR), sqlAt(NOW - ageH * HOUR), card ? '-100123' : null, card ? 9000 + seq : null, m.id);
  return { orderId: id, msg: db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(m.id) };
}
const row = (id) => db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(id);

// A stand-in for AddMemberMessageAAQToPartner that counts, and can be held open mid-call — which is
// the whole window P5 lived in.
function stubSender({ hold = false, result = { ok: true }, throws = null } = {}) {
  const calls = [];
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const inside = new Promise((r) => { entered = r; });
  const fn = async (_env, args) => {
    calls.push(args);
    entered();
    if (hold) await gate;
    if (throws) throw throws;
    return result;
  };
  return { fn, calls, release: () => release(), inside };
}
const tap = (msgId, action = 'a') => ({ callback_query: { id: 'cq-' + msgId + '-' + Math.random(), from: TAPPER, data: `ps${action}:${msgId}` } });

describe('messageExpiry — when an unsent message stops being true', () => {
  const at = (kind, ageH, order = {}) => messageExpiry({ kind, created_at: sqlAt(NOW - ageH * HOUR) },
    { shipped_status: 'unshipped', delivered_time: null, ...order }, cfg, NOW);

  it('a thank-you dies the moment the order ships, however young it is', () => {
    assert.equal(at('purchase', 1, { shipped_status: 'shipped' }), 'order already shipped');
    assert.equal(at('purchase', 1), null);
  });

  it('a thank-you dies after a day, because it promises a dispatch day', () => {
    assert.equal(at('purchase', 23.9), null);
    assert.match(at('purchase', 25), /^older than 1 day \(25h old\)$/);
    assert.match(at('purchase', 75 * 24), /^older than 1 day \(75 days old\)$/);
  });

  it('a dispatch note dies once delivered, or after 3 days', () => {
    assert.equal(at('dispatch', 1, { delivered_time: '2026-10-17T00:00:00.000Z' }), 'order already delivered');
    assert.equal(at('dispatch', 71), null);
    assert.match(at('dispatch', 73), /^older than 3 days/);
    // Shipping is what a dispatch note is ABOUT, so it is not a reason to retire one.
    assert.equal(at('dispatch', 1, { shipped_status: 'shipped' }), null);
  });

  it('a delivered note has nothing to be overtaken by, so it only ages, after 5 days', () => {
    assert.equal(at('delivered', 119, { shipped_status: 'shipped', delivered_time: '2026-10-10T00:00:00.000Z' }), null);
    assert.match(at('delivered', 121), /^older than 5 days/);
  });

  it('0 hours turns the age limit off, and only the age limit', () => {
    const off = { ...cfg, message_expiry: { purchase_hours: 0, dispatch_hours: 0, delivered_hours: 0 } };
    const born = { kind: 'purchase', created_at: sqlAt(NOW - 900 * HOUR) };
    assert.equal(messageExpiry(born, { shipped_status: 'unshipped' }, off, NOW), null);
    assert.equal(messageExpiry(born, { shipped_status: 'shipped' }, off, NOW), 'order already shipped');
  });

  it('reads SQLite timestamps as UTC, not local time', () => {
    // Parsed raw, '2026-10-17 01:00:00' lands ten hours out on an AEST box and a 25-hour-old
    // thank-you would read as fifteen hours old.
    const at = Date.parse('2026-10-18T02:00:00.000Z');
    const m = { kind: 'purchase', created_at: '2026-10-17 01:00:00' };
    assert.match(messageExpiry(m, { shipped_status: 'unshipped' }, cfg, at), /25h old/);
    assert.match(messageExpiry({ ...m, created_at: '2026-10-17T01:00:00.000Z' }, { shipped_status: 'unshipped' }, cfg, at), /25h old/);
  });

  it('ships the owner\'s thresholds as the default', () => {
    assert.deepEqual(cfg.message_expiry, { purchase_hours: 24, dispatch_hours: 72, delivered_hours: 120 },
      'a config file with no message_expiry block must still get the defaults merged in');
  });
});

describe('expireStaleMessages — the sweep the order poll runs', () => {
  let rows, stamps;
  const stamp = async (_env, _db, msg, decided) => { stamps.push({ id: msg.id, status: msg.status, decided }); };

  before(() => {
    stamps = [];
    rows = {
      shipped: seed({ kind: 'purchase', ageH: 2, order: { shipped_status: 'shipped' }, card: true }),
      oldThanks: seed({ kind: 'purchase', ageH: 30, card: true }),
      pendingOnShipped: seed({ kind: 'purchase', status: 'pending', ageH: 1, order: { shipped_status: 'shipped' } }),
      failedOld: seed({ kind: 'purchase', status: 'failed', ageH: 48 }),
      dispatchDelivered: seed({ kind: 'dispatch', ageH: 5, order: { shipped_status: 'shipped', delivered_time: '2026-10-17T00:00:00.000Z' }, card: true }),
      deliveredOld: seed({ kind: 'delivered', ageH: 6 * 24, order: { shipped_status: 'shipped', delivered_time: '2026-10-11T00:00:00.000Z' } }),
      fresh: seed({ kind: 'purchase', ageH: 2, card: true }),
      freshDispatch: seed({ kind: 'dispatch', ageH: 20, order: { shipped_status: 'shipped' } }),
      // Mid-send, already sent, and already decided rows are never the sweep's to touch, however old.
      sending: seed({ kind: 'purchase', status: 'sending', ageH: 99, order: { shipped_status: 'shipped' } }),
      sent: seed({ kind: 'purchase', status: 'sent', ageH: 99, order: { shipped_status: 'shipped' } }),
      skipped: seed({ kind: 'purchase', status: 'skipped', ageH: 99 }),
    };
  });
  const STALE = ['shipped', 'oldThanks', 'pendingOnShipped', 'failedOld', 'dispatchDelivered', 'deliveredOld'];

  it('a dry run names every stale message and writes nothing', async () => {
    const r = await expireStaleMessages(ENV, db, cfg, { apply: false, now: NOW, stamp });
    assert.equal(r.dry_run, true);
    const ids = new Set(r.expired.map((e) => e.id));
    for (const k of STALE) assert.ok(ids.has(rows[k].msg.id), k + ' should be listed');
    for (const k of ['fresh', 'freshDispatch', 'sending', 'sent', 'skipped']) assert.ok(!ids.has(rows[k].msg.id), k + ' must not be listed');
    for (const k of STALE) assert.equal(row(rows[k].msg.id).status, rows[k].msg.status, 'a dry run wrote to ' + k);
    assert.equal(stamps.length, 0, 'a dry run must not touch a Telegram card');
    const shipped = r.expired.find((e) => e.id === rows.shipped.msg.id);
    assert.equal(shipped.reason, 'order already shipped');
    assert.equal(shipped.has_card, true);
  });

  it('applied, it retires exactly the stale ones with their reason', async () => {
    const r = await expireStaleMessages(ENV, db, cfg, { now: NOW, stamp });
    assert.equal(r.expired.length, STALE.length);
    for (const k of STALE) {
      const m = row(rows[k].msg.id);
      assert.equal(m.status, 'expired', k);
      assert.equal(m.decided_by, 'expiry');
      assert.ok(m.error, k + ' should say why');
    }
    assert.equal(row(rows.shipped.msg.id).error, 'order already shipped');
    assert.equal(row(rows.dispatchDelivered.msg.id).error, 'order already delivered');
    assert.match(row(rows.oldThanks.msg.id).error, /older than 1 day/);
    assert.match(row(rows.deliveredOld.msg.id).error, /older than 5 days/);
    assert.equal(row(rows.fresh.msg.id).status, 'awaiting_approval');
    assert.equal(row(rows.freshDispatch.msg.id).status, 'awaiting_approval');
    assert.equal(row(rows.sending.msg.id).status, 'sending', 'a message mid-send belongs to its sender');
    assert.equal(row(rows.sent.msg.id).status, 'sent');
    assert.equal(row(rows.skipped.msg.id).status, 'skipped');
  });

  it('stamps every retired card that exists, and only those', async () => {
    const withCard = ['shipped', 'oldThanks', 'dispatchDelivered'].map((k) => rows[k].msg.id).sort();
    assert.deepEqual(stamps.map((s) => s.id).sort(), withCard);
    for (const s of stamps) {
      assert.equal(s.status, 'expired', 'the card is stamped from the row AFTER it was retired');
      assert.match(s.decided.status, /^expired: /);
      assert.equal(s.decided.icon, '⌛');
    }
  });

  it('is idempotent: a second pass finds nothing', async () => {
    const before = stamps.length;
    const r = await expireStaleMessages(ENV, db, cfg, { now: NOW, stamp });
    assert.equal(r.expired.length, 0);
    assert.equal(stamps.length, before);
  });

  it('an expired card\'s Send button does nothing, even if the card edit never landed', async () => {
    const s = stubSender();
    await onPostsaleUpdate(ENV, db, tap(rows.shipped.msg.id), { sendBuyer: s.fn });
    assert.equal(s.calls.length, 0, 'an expired message reached the sender');
    assert.equal(row(rows.shipped.msg.id).status, 'expired');
  });

  it('all=1 retires every undecided message for a by-hand clear-out, and says so', async () => {
    const dry = await expireStaleMessages(ENV, db, cfg, { apply: false, all: true, now: NOW, stamp });
    const fresh = dry.expired.find((e) => e.id === rows.fresh.msg.id);
    assert.equal(fresh.reason, 'retired by hand');
    assert.ok(!dry.expired.some((e) => e.id === rows.sending.msg.id), 'all=1 still never touches a send in flight');
    const r = await expireStaleMessages(ENV, db, cfg, { all: true, now: NOW, stamp, decidedBy: 'diag' });
    assert.ok(r.expired.some((e) => e.id === rows.fresh.msg.id));
    assert.equal(row(rows.fresh.msg.id).status, 'expired');
    assert.equal(row(rows.fresh.msg.id).decided_by, 'diag');
  });
});

describe('sendPostsaleMessage — every send re-checks what is true NOW', () => {
  const sendIt = async (msg, s = stubSender()) => ({ r: await sendPostsaleMessage(ENV, db, msg, cfg, { decidedBy: 'test', sendBuyer: s.fn, now: NOW }), s });

  it('a fresh, welcome message goes out exactly once', async () => {
    const { msg, orderId } = seed();
    const { r, s } = await sendIt(msg);
    assert.equal(r.ok, true);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].recipientId, 'buyer_' + orderId.toLowerCase());
    assert.equal(row(msg.id).status, 'sent');
  });

  it('refuses a thank-you once the order has shipped', async () => {
    const { msg } = seed({ order: { shipped_status: 'shipped' } });
    const { r, s } = await sendIt(msg);
    assert.deepEqual([r.ok, r.error, r.status], [false, 'expired', 'expired']);
    assert.equal(r.detail, 'order already shipped');
    assert.equal(s.calls.length, 0);
    assert.equal(row(msg.id).status, 'expired');
  });

  it('refuses a stale message the sweep has not reached yet', async () => {
    const { msg } = seed({ ageH: 40 });
    const { r, s } = await sendIt(msg);
    assert.equal(r.error, 'expired');
    assert.match(r.detail, /older than 1 day/);
    assert.equal(s.calls.length, 0);
  });

  it('refuses a dispatch note once the parcel is delivered', async () => {
    const { msg } = seed({ kind: 'dispatch', order: { shipped_status: 'shipped', delivered_time: '2026-10-17T00:00:00.000Z' } });
    const { r, s } = await sendIt(msg);
    assert.equal(r.detail, 'order already delivered');
    assert.equal(s.calls.length, 0);
  });

  it('refuses every kind once the buyer has replied to us', async () => {
    for (const kind of ['purchase', 'dispatch', 'delivered']) {
      const { msg, orderId } = seed({ kind, order: { shipped_status: kind === 'purchase' ? 'unshipped' : 'shipped' } });
      // The buyer answered an earlier message on this order: what maybeHandleReply records.
      const replyAt = new Date(NOW - HOUR).toISOString();
      if (kind === 'purchase') {
        db.prepare(`INSERT INTO postsale_messages (order_id, kind, buyer_id, status, reply_detected_at)
                    SELECT order_id, 'dispatch', buyer_id, 'replied', ? FROM orders WHERE order_id=?`).run(replyAt, orderId);
      } else {
        db.prepare(`UPDATE postsale_messages SET status='replied', reply_detected_at=? WHERE order_id=? AND kind='purchase'`).run(replyAt, orderId);
      }
      const { r, s } = await sendIt(msg);
      // The delivered note already asked this in messagingBlocked, so its code is that gate's; the
      // outcome is what matters, and it is the same for all three.
      assert.ok(['buyer_in_contact', 'blocked'].includes(r.error), kind + ': ' + r.error);
      assert.deepEqual([r.status, r.detail], ['skipped', 'buyer already in contact'], kind);
      assert.equal(s.calls.length, 0, kind);
    }
  });

  it('refuses when the buyer wrote to us after paying, even about another card', async () => {
    const { msg, orderId } = seed();
    db.prepare(`INSERT INTO member_messages (message_id, sender_id, ebay_item_id, body, creation_time)
                VALUES (?, ?, '1234', 'do you have the alt art too?', '2026-10-11T03:00:00.000Z')`)
      .run('mm-' + orderId, 'BUYER_' + orderId);   // eBay's casing is not ours; the match must not care
    assert.equal(buyerInContact(db, orderId), true);
    const { r, s } = await sendIt(msg);
    assert.equal(r.error, 'buyer_in_contact');
    assert.equal(s.calls.length, 0);
  });

  it('does not count a message from before the order was paid', async () => {
    const { orderId } = seed();
    db.prepare(`INSERT INTO member_messages (message_id, sender_id, body, creation_time)
                VALUES (?, ?, 'is this still available?', '2026-10-09T03:00:00.000Z')`).run('mm-pre-' + orderId, 'buyer_' + orderId.toLowerCase());
    assert.equal(buyerInContact(db, orderId), false, 'a pre-sale question is not a reply to anything we sent');
  });

  it('refuses a cancelled order and a failed payment', async () => {
    for (const order of [{ cancel_state: 'cancelled' }, { payment_state: 'failed' }]) {
      const { msg } = seed({ order });
      const { r, s } = await sendIt(msg);
      assert.deepEqual([r.ok, r.error, r.status], [false, 'blocked', 'skipped'], JSON.stringify(order));
      assert.match(r.detail, /cancelled|payment failed/);
      assert.equal(s.calls.length, 0);
    }
  });

  it('sendRefusal names the strongest reason first: a cancellation outranks staleness', () => {
    const { msg } = seed({ ageH: 99, order: { cancel_state: 'cancelled', shipped_status: 'shipped' } });
    assert.equal(sendRefusal(db, msg, cfg, NOW).reason, 'order cancelled on eBay');
  });

  it('a sender that throws leaves the row failed, never stranded in sending', async () => {
    const { msg } = seed();
    const { r } = await sendIt(msg, stubSender({ throws: new Error('socket hang up') }));
    assert.equal(r.ok, false);
    assert.equal(row(msg.id).status, 'failed');
    assert.match(row(msg.id).error, /socket hang up/);
  });

  it('every refusal code it can return is one the routes answer with 409', () => {
    for (const c of ['already_claimed', 'not_claimed', 'expired', 'blocked', 'buyer_in_contact']) assert.ok(SEND_REFUSALS.has(c), c);
    assert.ok(!SEND_REFUSALS.has('ebay'), 'eBay saying no is a 502, the dashboard reads it as retryable');
  });
});

describe('the double send (P5) — the claim is held through the eBay call', () => {
  it('two senders racing on one row: one sends, the other is told', async () => {
    const { msg } = seed();
    const s = stubSender({ hold: true });
    const first = sendPostsaleMessage(ENV, db, msg, cfg, { decidedBy: 'telegram', sendBuyer: s.fn, now: NOW });
    await s.inside;
    assert.equal(row(msg.id).status, 'sending', 'the row must stay claimed while eBay is being called');
    const second = await sendPostsaleMessage(ENV, db, msg, cfg, { decidedBy: 'dashboard', sendBuyer: s.fn, now: NOW });
    assert.deepEqual([second.ok, second.error], [false, 'already_claimed']);
    assert.match(second.detail, /already being sent/);
    s.release();
    assert.equal((await first).ok, true);
    assert.equal(s.calls.length, 1, 'the buyer got the message twice');
    assert.equal(row(msg.id).status, 'sent');
  });

  it('a Telegram tap in flight: a second tap and a dashboard Approve both bounce', async () => {
    const { msg } = seed({ card: true });
    const s = stubSender({ hold: true });
    const tapA = onPostsaleUpdate(ENV, db, tap(msg.id), { sendBuyer: s.fn });
    await s.inside;
    // The old handler reset the row to awaiting_approval right here, before calling eBay.
    assert.equal(row(msg.id).status, 'sending');
    await onPostsaleUpdate(ENV, db, tap(msg.id), { sendBuyer: s.fn });
    const dash = await sendPostsaleMessage(ENV, db, row(msg.id), cfg, { decidedBy: 'dashboard', sendBuyer: s.fn, now: NOW });
    assert.equal(dash.error, 'already_claimed');
    s.release();
    await tapA;
    assert.equal(s.calls.length, 1, 'a second tap or a dashboard Approve reached eBay mid-send');
    assert.equal(row(msg.id).status, 'sent');
    assert.equal(row(msg.id).decided_by, '@owner');
  });

  it('a Telegram tap on a message that went stale is refused and retired, not sent', async () => {
    const { msg } = seed({ card: true, order: { shipped_status: 'shipped' } });
    const s = stubSender();
    await onPostsaleUpdate(ENV, db, tap(msg.id), { sendBuyer: s.fn });
    assert.equal(s.calls.length, 0);
    assert.equal(row(msg.id).status, 'expired');
    assert.equal(row(msg.id).error, 'order already shipped');
  });

  it('a caller claiming to hold the row must actually hold it', async () => {
    const { msg } = seed();
    const s = stubSender();
    const r = await sendPostsaleMessage(ENV, db, msg, cfg, { claimed: true, sendBuyer: s.fn, now: NOW });
    assert.equal(r.error, 'not_claimed');
    assert.equal(s.calls.length, 0);
    assert.equal(row(msg.id).status, 'awaiting_approval', 'a refused claim must not move the row');
  });

  it('a row already sent cannot be claimed again', async () => {
    const { msg } = seed({ status: 'sent' });
    const s = stubSender();
    const r = await sendPostsaleMessage(ENV, db, msg, cfg, { sendBuyer: s.fn, now: NOW });
    assert.deepEqual([r.error, r.status], ['already_claimed', 'sent']);
    assert.equal(s.calls.length, 0);
  });
});
