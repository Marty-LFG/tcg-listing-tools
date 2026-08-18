// test/unit/postsale-cancel.test.mjs — cancellations and payment failures: eBay's vocabulary mapped to
// the four words we act on, and the queue predicates that read them.
//
// The single most important case in this file is "an upgraded database still has a pack queue". Every
// row that existed before the cancellation migration has cancel_state NULL, and in SQLite
// `NULL <> 'cancelled'` is NULL, which is falsy — a predicate written without COALESCE would empty the
// whole queue on the first boot after upgrading, and it would do it silently.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  cancelState, paymentState, isCancelled, isOnHold, holdReason, inQueue, needsPacking, pickable,
  isLabelBought, isPaid,
  IN_QUEUE_SQL, NEEDS_PACKING_SQL, PICKABLE_SQL, NOT_CANCELLED_SQL, HOLD_SQL, LABEL_BOUGHT_SQL, PAID_SQL,
} from '../../lib/postsale.mjs';

// Every row handed to holdReason/isPaid must carry paid_time, or they throw rather than guess — see
// assertPaymentColumns. A stub that omits it is indistinguishable from an unpaid order, and guessing
// either way is how an unpaid parcel goes out.
const PAID_AT = '2026-08-01T00:00:00.000Z';

describe('cancelState — eBay CancelStatus → the word we act on', () => {
  const at = (cancelStatus, orderStatus = 'Completed') => cancelState({ cancelStatus, orderStatus });

  it('a buyer request is HELD, not cancelled — the seller can still reject it', () => {
    assert.equal(at('CancelRequested'), 'requested');
  });

  it('every "it actually happened" status is cancelled', () => {
    for (const s of ['CancelComplete', 'CancelClosedWithRefund', 'CancelClosedNoRefund',
      'CancelClosedUnknownRefund', 'CancelClosedForCommitment']) {
      assert.equal(at(s), 'cancelled', s + ' should be a completed cancellation');
    }
  });

  it('CancelPending means the SELLER ALREADY APPROVED — not "awaiting a decision"', () => {
    // The trap: OrderStatus=CancelPending means the opposite (buyer asked, seller has not decided).
    // Same word, two enums, two meanings. CancelStatus is the more specific field and wins.
    assert.equal(at('CancelPending'), 'cancelled');
    assert.equal(cancelState({ orderStatus: 'CancelPending' }), 'requested');
  });

  it('a refused or failed cancellation leaves the order standing', () => {
    assert.equal(at('CancelRejected'), 'rejected');
    assert.equal(at('CancelFailed'), 'rejected');
  });

  it('NotApplicable is written, not ignored — it is how a rejected request clears the hold', () => {
    assert.equal(at('NotApplicable'), 'none');
    assert.equal(at('Invalid'), 'none');
    assert.equal(at('CustomCode'), 'none');
  });

  it('silence returns null, so refreshOrder keeps whatever it already had', () => {
    assert.equal(cancelState({}), null);
    assert.equal(cancelState({ cancelStatus: '', orderStatus: 'Completed' }), null);
    assert.equal(cancelState(null), null);
  });

  it('OrderStatus=Cancelled is decisive on its own, with no CancelStatus at all', () => {
    assert.equal(cancelState({ orderStatus: 'Cancelled' }), 'cancelled');
  });

  it('an OrderStatus we do not recognise is INERT — never a hold', () => {
    // InProcess can be RETURNED by eBay though it cannot be requested as a filter, and several
    // deprecated Half.com values are still in the enum. None of them mean anything is wrong.
    for (const s of ['InProcess', 'Active', 'Shipped', 'Inactive', 'Authenticated', 'Default', 'Whatever']) {
      assert.equal(cancelState({ orderStatus: s }), null, s + ' must not produce a state');
    }
  });

  it('an unmapped CancelStatus holds the order rather than packing OR deleting it', () => {
    // Fail safe in both directions: not packed by accident, not silently dropped from the queue.
    assert.equal(at('CancelSomethingEbayAddedLater'), 'unknown');
    assert.ok(isOnHold({ cancel_state: 'unknown', paid_time: PAID_AT }));
    assert.ok(!isCancelled({ cancel_state: 'unknown' }));
  });
});

describe('paymentState — a payment can fail AFTER eBay said the order was paid', () => {
  const at = (paidStatus) => paymentState({ paidStatus });

  it('names the three real failures', () => {
    for (const s of ['BuyerECheckBounced', 'BuyerCreditCardFailed', 'BuyerFailedPaymentReportedBySeller']) {
      assert.equal(at(s), 'failed', s + ' should hold the order');
    }
  });
  it('in-flight payment is pending, not failed', () => {
    assert.equal(at('PayPalPaymentInProcess'), 'pending');
    assert.equal(at('PaymentInProcess'), 'pending');
  });
  it('the happy path and silence', () => {
    assert.equal(at('NoPaymentFailure'), 'ok');
    assert.equal(at(''), null);           // eBay said nothing — keep what we have
    assert.equal(paymentState({}), null);
  });
  it('an unmapped payment status defaults to OK, unlike an unmapped cancel status', () => {
    // Holding every order on a value eBay merely added would stop the shop. A real failure has a name.
    assert.equal(at('SomeNewEbayThing'), 'ok');
  });
});

describe('the row-level predicates', () => {
  const unshipped = { shipped_status: 'unshipped', picked_at: null, label_bought_at: null, paid_time: PAID_AT };

  it('a cancelled order is out of the queue entirely', () => {
    const o = { ...unshipped, cancel_state: 'cancelled' };
    assert.equal(inQueue(o), false);
    assert.equal(needsPacking(o), false);
  });

  it('a held order STAYS in the queue but is not pickable', () => {
    const o = { ...unshipped, cancel_state: 'requested' };
    assert.equal(inQueue(o), true);       // the seller may still reject it
    assert.equal(needsPacking(o), true);  // a human may still deliberately pack it
    assert.equal(pickable(o), false);     // but no bulk action will
    assert.equal(holdReason(o), 'cancel requested');
  });

  it('a failed payment holds the order the same way, but is NOT overridable', () => {
    const o = { ...unshipped, payment_state: 'failed' };
    assert.equal(inQueue(o), true);
    assert.equal(pickable(o), false);
    assert.equal(holdReason(o), 'payment failed');
    // The difference from a cancellation hold: there is no human judgement that makes an unpaid order
    // packable, so this one closes the wider per-order route too.
    assert.equal(needsPacking(o), false);
  });

  it('an unpaid or unsettled order is in the queue, held, and unpackable by any route', () => {
    for (const [o, why] of [
      [{ ...unshipped, paid_time: null }, 'not paid yet'],
      [{ ...unshipped, payment_state: 'pending' }, 'payment not settled'],
    ]) {
      assert.equal(inQueue(o), true, why + ': stays visible and polled');
      assert.equal(holdReason(o), why);
      assert.equal(isPaid(o), false);
      assert.equal(needsPacking(o), false, why + ': no per-order override');
      assert.equal(pickable(o), false, why + ': no bulk action');
    }
  });

  it('a row that never SELECTed paid_time throws rather than guessing', () => {
    // The trap this replaces: an unselected column reads as undefined, which a falsy test cannot tell
    // apart from a genuine NULL. Silently that makes every order look unpaid, or — with the test
    // written the other way — every order look paid.
    assert.throws(() => holdReason({ shipped_status: 'unshipped' }), /no paid_time/);
    assert.throws(() => isPaid({ shipped_status: 'unshipped' }), /no paid_time/);
  });

  it('an ordinary order is untouched by any of it', () => {
    assert.equal(pickable(unshipped), true);
    assert.equal(holdReason(unshipped), null);
    assert.equal(isOnHold(unshipped), false);
    assert.equal(isCancelled(unshipped), false);
  });

  it('a rejected cancellation puts the order fully back to work', () => {
    const o = { ...unshipped, cancel_state: 'rejected' };
    assert.equal(pickable(o), true);
    assert.equal(isOnHold(o), false);
  });
});

// --- the predicates as SQL, against a real SQLite database ---
describe('the SQL predicates on an UPGRADED database', () => {
  let db, tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-cancel-'));
    db = new DatabaseSync(path.join(tmpDir, 'q.db'));
    // Deliberately the shape of a database that predates the migration: the columns exist (they were
    // just added) but every existing row has NULL in them, because ALTER TABLE ADD COLUMN cannot
    // backfill. This is exactly the state of the live DB on the first boot after this ships.
    db.exec(`CREATE TABLE orders (
      order_id TEXT PRIMARY KEY, shipped_status TEXT NOT NULL DEFAULT 'unshipped',
      picked_at TEXT, label_bought_at TEXT, cancel_state TEXT, payment_state TEXT, paid_time TEXT)`);
    // paid_time is NOT one of the newly-added columns: it has been written at ingest since the first
    // post-sale commit, and pollOrders has always refused to ingest an order without one. So every
    // ordinary row here carries it, including the "legacy" ones — a NULL paid_time is not a migration
    // artefact, it is a genuinely unpaid order, and the two must not be conflated.
    const PAID = "'2026-08-01T00:00:00.000Z'";
    db.exec(`INSERT INTO orders (order_id, paid_time) VALUES ('legacy-1',${PAID}), ('legacy-2',${PAID}), ('legacy-3',${PAID})`);
    db.exec(`INSERT INTO orders (order_id, cancel_state, paid_time) VALUES ('cancelled-1','cancelled',${PAID})`);
    db.exec(`INSERT INTO orders (order_id, cancel_state, paid_time) VALUES ('requested-1','requested',${PAID})`);
    db.exec(`INSERT INTO orders (order_id, cancel_state, paid_time) VALUES ('unknown-1','unknown',${PAID})`);
    db.exec(`INSERT INTO orders (order_id, cancel_state, paid_time) VALUES ('rejected-1','rejected',${PAID})`);
    db.exec(`INSERT INTO orders (order_id, payment_state, paid_time) VALUES ('badpay-1','failed',${PAID})`);
    db.exec(`INSERT INTO orders (order_id, shipped_status, paid_time) VALUES ('posted-1','shipped',${PAID})`);
    // The two rows the payment gate exists for. unpaid-1 is an order nobody has paid for at all;
    // pending-1 has a PaidTime but the money is still in flight (PayPalPaymentInProcess), which is the
    // case a naive `paid_time IS NOT NULL` test would wave straight through.
    db.exec(`INSERT INTO orders (order_id) VALUES ('unpaid-1')`);
    db.exec(`INSERT INTO orders (order_id, payment_state, paid_time) VALUES ('pending-1','pending',${PAID})`);
    // eBay bought a label for this one; the cards are still on the shelf.
    db.exec(`INSERT INTO orders (order_id, shipped_status, label_bought_at, paid_time)
             VALUES ('label-1','shipped','2026-08-02T05:07:00.000Z',${PAID})`);
    // Same, but somebody has since packed it — label_bought_at is history now, not work.
    db.exec(`INSERT INTO orders (order_id, shipped_status, label_bought_at, picked_at, paid_time)
             VALUES ('label-picked-1','shipped','2026-08-02T05:07:00.000Z','2026-08-02T06:00:00.000Z',${PAID})`);
  });
  after(() => { try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  const idsWhere = (sql) => db.prepare(`SELECT order_id FROM orders WHERE ${sql} ORDER BY order_id`).all().map((r) => r.order_id);

  it('THE ONE THAT MATTERS: a NULL cancel_state does not empty the pack queue', () => {
    // `NULL <> 'cancelled'` is NULL in SQLite, which is falsy. Without COALESCE, all three legacy rows
    // vanish from the queue on the first boot after upgrading — every order the shop has, silently.
    const q = idsWhere(IN_QUEUE_SQL);
    for (const id of ['legacy-1', 'legacy-2', 'legacy-3']) {
      assert.ok(q.includes(id), `${id} (cancel_state NULL) must still be in the pack queue`);
    }
  });

  it('an UNPAID order stays in the queue, and that is deliberate', () => {
    // The payment gate lives in NEEDS_PACKING_SQL, never in IN_QUEUE_SQL, and this is the test that
    // pins the difference. The shipped tab is defined as NOT IN_QUEUE_SQL, so a payment term here
    // would label an unpaid order SHIPPED; sweepOpenOrders' ACTIONABLE set is built from IN_QUEUE_SQL,
    // so it would also stop polling the order and never learn the buyer had paid.
    const q = idsWhere(IN_QUEUE_SQL);
    assert.ok(q.includes('unpaid-1'), 'an unpaid order must stay visible and polled');
    assert.ok(q.includes('pending-1'));
    const shipped = idsWhere(`NOT ${IN_QUEUE_SQL} AND ${NOT_CANCELLED_SQL}`);
    assert.ok(!shipped.includes('unpaid-1'), 'an unpaid order must never read as shipped');
  });

  it('PAID_SQL is stricter than "paid_time is set"', () => {
    // A bounced eCheck and a card still in flight both leave PaidTime in place.
    const paid = idsWhere(PAID_SQL);
    assert.ok(!paid.includes('unpaid-1'));
    assert.ok(!paid.includes('pending-1'), 'money in flight is not money received');
    assert.ok(!paid.includes('badpay-1'), 'a payment that failed after PaidTime is not paid');
    assert.ok(paid.includes('legacy-1'));
  });

  it('cancelled leaves the queue; held stays in it', () => {
    const q = idsWhere(IN_QUEUE_SQL);
    assert.ok(!q.includes('cancelled-1'));
    assert.ok(q.includes('requested-1'));
    assert.ok(q.includes('unknown-1'));
    assert.ok(q.includes('rejected-1'));
    assert.ok(q.includes('badpay-1'));
  });

  it('PICKABLE_SQL is what a BULK action acts on, and it excludes every hold', () => {
    const p = idsWhere(PICKABLE_SQL);
    // label-1 belongs here: eBay bought its label, but the cards have not been pulled, so it is
    // exactly the work a bulk pick is for. label-picked-1 does not — it has been packed already.
    assert.deepEqual(p, ['label-1', 'legacy-1', 'legacy-2', 'legacy-3', 'rejected-1']);
    // NEEDS_PACKING_SQL is the wider set the per-order buttons use: a human may pack an order whose
    // cancellation they have decided to reject. They may NOT override a payment that has not arrived —
    // there is no judgement call to make there — so the payment terms sit in this predicate rather
    // than only in HOLD_SQL.
    const n = idsWhere(NEEDS_PACKING_SQL);
    assert.ok(n.includes('requested-1'), 'a rejected cancellation is a human decision to make');
    for (const id of ['badpay-1', 'unpaid-1', 'pending-1']) {
      assert.ok(!n.includes(id), `${id} must not be packable by any route`);
    }
  });

  it('the "shipped" tab is the negation of the queue, so it must exclude cancelled explicitly', () => {
    // Without the extra clause a cancelled order — newly absent from the queue — reads as SHIPPED,
    // which moves the bug rather than fixing it.
    const shipped = idsWhere(`NOT ${IN_QUEUE_SQL} AND ${NOT_CANCELLED_SQL}`);
    // label-picked-1 reads as shipped and should: the label was bought AND the parcel has been packed,
    // so there is nothing left to do about it.
    assert.deepEqual(shipped, ['label-picked-1', 'posted-1']);
    const naive = idsWhere(`NOT ${IN_QUEUE_SQL}`);
    assert.ok(naive.includes('cancelled-1'), 'guarding the regression this test exists for');
  });

  it('HOLD_SQL finds exactly what needs a decision', () => {
    assert.deepEqual(idsWhere(HOLD_SQL), ['badpay-1', 'pending-1', 'requested-1', 'unknown-1', 'unpaid-1']);
  });

  it('LABEL_BOUGHT_SQL finds the orders eBay dispatched that nobody has packed', () => {
    // A NULL label_bought_at must not match — that is every ordinary order, and the tab would show
    // the whole queue. `IS NOT NULL` is NULL-safe, so this needs no COALESCE, unlike the <> tests.
    assert.deepEqual(idsWhere(LABEL_BOUGHT_SQL), ['label-1']);
  });

  it('the queue predicate did not move — the label-bought lens is additive', () => {
    // The whole point of adding LABEL_BOUGHT_SQL as its own name is that IN_QUEUE_SQL keeps behaving
    // exactly as it did. A label-bought order is in the queue; a picked one is not.
    const q = idsWhere(IN_QUEUE_SQL);
    assert.ok(q.includes('label-1'), 'the cards still have to be pulled');
    assert.ok(!q.includes('label-picked-1'), 'label_bought_at must not pin an order forever');
    assert.ok(!q.includes('posted-1'));
  });

  it('the SQL and the JS agree, row for row', () => {
    // Two implementations of one rule is how the dashboard and the pick sheet end up disagreeing.
    const rows = db.prepare('SELECT * FROM orders').all();
    const sqlQueue = new Set(idsWhere(IN_QUEUE_SQL));
    const sqlPickable = new Set(idsWhere(PICKABLE_SQL));
    const sqlLabelBought = new Set(idsWhere(LABEL_BOUGHT_SQL));
    const sqlPaid = new Set(idsWhere(PAID_SQL));
    for (const r of rows) {
      assert.equal(inQueue(r), sqlQueue.has(r.order_id), `inQueue disagrees on ${r.order_id}`);
      assert.equal(pickable(r), sqlPickable.has(r.order_id), `pickable disagrees on ${r.order_id}`);
      assert.equal(isLabelBought(r), sqlLabelBought.has(r.order_id), `isLabelBought disagrees on ${r.order_id}`);
      assert.equal(isPaid(r), sqlPaid.has(r.order_id), `isPaid disagrees on ${r.order_id}`);
    }
  });
});

// Every reason to stay quiet lives in one function, because the list keeps growing and three call
// sites each carrying their own copy is how one of them ends up missing the newest reason.
describe('messagingBlocked — one gate, every reason', () => {
  let db, tmpDir;
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-msggate-'));
    const { openPostsaleDbAt } = await import('../../lib/postsale-db.mjs');
    db = openPostsaleDbAt(path.join(tmpDir, 'p.db'));
  });
  after(() => { try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  const order = (id, over = {}) => {
    const buyerId = db.prepare('INSERT INTO buyers (ebay_username) VALUES (?)').run('b-' + id).lastInsertRowid;
    // paid_time defaults to set, because that is what every ingested order has. A test that wants an
    // unpaid order asks for it explicitly, the same way it asks for a cancellation.
    const cols = { order_id: id, buyer_id: buyerId, paid_time: '2026-08-01T00:00:00.000Z', ...over };
    const keys = Object.keys(cols);
    db.prepare(`INSERT INTO orders (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
    return id;
  };

  it('lets an ordinary order through, for every kind', async () => {
    const { messagingBlocked } = await import('../../lib/postsale.mjs');
    order('ok-1');
    for (const kind of ['purchase', 'dispatch', 'delivered']) {
      assert.equal(messagingBlocked(db, 'ok-1', kind), null, kind + ' should be allowed');
    }
  });

  it('blocks EVERY kind on a cancelled or held order, and says which', async () => {
    const { messagingBlocked } = await import('../../lib/postsale.mjs');
    order('dead-1', { cancel_state: 'cancelled' });
    order('held-1', { cancel_state: 'requested' });
    order('pay-1', { payment_state: 'failed' });
    // A dispatch note for an order that no longer exists is the expensive one — it is not a
    // delivered-only concern, so the guard cannot live behind the delivered branch.
    assert.match(messagingBlocked(db, 'dead-1', 'dispatch'), /cancelled on eBay/);
    assert.match(messagingBlocked(db, 'held-1', 'purchase'), /cancel requested/);
    assert.match(messagingBlocked(db, 'pay-1', 'delivered'), /payment failed/);
  });

  it('an order nobody has paid for is silent on every kind', async () => {
    const { messagingBlocked } = await import('../../lib/postsale.mjs');
    order('nopay-1', { paid_time: null });
    order('inflight-1', { payment_state: 'pending' });
    // Thanking somebody for a purchase they have not completed, or telling them a parcel is coming,
    // are both promises the shop cannot keep yet.
    for (const kind of ['purchase', 'dispatch', 'delivered']) {
      assert.match(messagingBlocked(db, 'nopay-1', kind), /not paid yet/, kind);
      assert.match(messagingBlocked(db, 'inflight-1', kind), /payment not settled/, kind);
    }
  });

  it('the "already in conversation" reasons stay delivered-only', async () => {
    const { messagingBlocked } = await import('../../lib/postsale.mjs');
    order('chat-1');
    db.prepare(`INSERT INTO postsale_messages (order_id, kind, buyer_id, status, reply_detected_at)
                VALUES ('chat-1','purchase',(SELECT buyer_id FROM orders WHERE order_id='chat-1'),'replied',datetime('now'))`).run();
    // A buyer mid-conversation should still be told their parcel went out; only the cheerful
    // "did it arrive?" is unwelcome.
    assert.equal(messagingBlocked(db, 'chat-1', 'dispatch'), null);
    assert.match(messagingBlocked(db, 'chat-1', 'delivered'), /already in contact/);
  });
});

// eBay has two documented vocabularies for the same handful of reasons, and the value this account
// actually received (BuyerAskedCancel) is in NEITHER verbatim — it is the Post-Order idea spelled in
// the Trading API's CamelCase. So the fallback matters more than the map.
describe('cancelReasonText — eBay reason codes in words', () => {
  it('handles the code the live order actually returned', async () => {
    const { cancelReasonText } = await import('../../lib/postsale.mjs');
    assert.equal(cancelReasonText('BuyerAskedCancel'), 'the buyer asked to cancel');
  });

  it('maps BOTH vocabularies to the same phrase', async () => {
    const { cancelReasonText } = await import('../../lib/postsale.mjs');
    // Trading API CamelCase and Post-Order SCREAMING_SNAKE for one idea.
    assert.equal(cancelReasonText('OrderPlacedByMistake'), cancelReasonText('ORDER_MISTAKE'));
    assert.equal(cancelReasonText('AddressIssues'), cancelReasonText('ADDRESS_ISSUES'));
    assert.equal(cancelReasonText('FoundCheaperPrice'), cancelReasonText('FOUND_CHEAPER_PRICE'));
  });

  it('warns that an out-of-stock cancellation costs a seller defect', async () => {
    const { cancelReasonText } = await import('../../lib/postsale.mjs');
    assert.match(cancelReasonText('OutOfStock'), /defect/);
  });

  it('splits an UNDOCUMENTED code into words instead of printing the enum', async () => {
    const { cancelReasonText } = await import('../../lib/postsale.mjs');
    // This is the case that will actually happen again: eBay is already sending values its own
    // reference does not list, so an unmapped code has to still read like an answer.
    assert.equal(cancelReasonText('BuyerChangedTheirMind'), 'buyer changed their mind');
    assert.equal(cancelReasonText('SOME_NEW_REASON'), 'some new reason');
  });

  it('says nothing rather than something useless', async () => {
    const { cancelReasonText } = await import('../../lib/postsale.mjs');
    assert.equal(cancelReasonText('Other'), null);      // eBay deprecated it; it carries no information
    assert.equal(cancelReasonText(''), null);
    assert.equal(cancelReasonText(null), null);
  });
});

// The repeat-buyer copy asserts the buyer HAS the card ("hope it looks right at home with your X").
// So a cancelled order must never reach it: warmly listing three cards somebody was just refunded for
// is worse than saying nothing at all. This is the bug that actually shipped to a buyer.
describe('a cancelled order never reaches the buyer-facing copy', () => {
  let db, tmpDir, ps;
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-prior-'));
    const { openPostsaleDbAt } = await import('../../lib/postsale-db.mjs');
    db = openPostsaleDbAt(path.join(tmpDir, 'p.db'));
    ps = await import('../../lib/postsale.mjs');
    db.prepare('INSERT INTO buyers (ebay_username) VALUES (?)').run('taikonirvana');
    const order = (id, over = {}) => {
      const cols = { order_id: id, buyer_id: 1, buyer_username: 'taikonirvana', paid_time: '2026-08-0' + id.slice(-1) + 'T00:00:00Z', ...over };
      const keys = Object.keys(cols);
      db.prepare(`INSERT INTO orders (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
    };
    const line = (id, title) => db.prepare('INSERT INTO order_line_items (order_id, title) VALUES (?,?)').run(id, title);
    order('live-1'); line('live-1', "Pokemon N's Plan 163/086 Black Bolt Ultra Rare Holo EN M/NM");
    order('good-2'); line('good-2', 'Pokemon Pikachu 025/165 151 Holo EN M/NM');
    order('dead-3', { cancel_state: 'cancelled' });
    line('dead-3', 'Pokemon Dewgong 097/094 Phantasmal Flames Illustration Rare Holo EN M/NM');
    line('dead-3', "Pokemon Boss's Orders 256/217 Ascended Heroes Ultra Rare Holo EN M/NM");
    line('dead-3', "Pokemon Giovanni's Charisma 204/165 151 Special Illustration Rare Holo EN M/NM");
    order('held-4', { cancel_state: 'requested' });
    line('held-4', 'Pokemon Mewtwo 150/165 151 Holo EN M/NM');
  });
  after(() => { try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('leaves out the cards from a cancelled order', () => {
    // draftAndRoute is the only consumer, and it feeds this straight to the model as "what they own".
    const titles = ps.priorCardsFor(db, 1, 'live-1').join(' | ');
    assert.ok(!/Dewgong|Boss's Orders|Giovanni/.test(titles),
      'cancelled cards must not be offered to the model as things the buyer owns — got: ' + titles);
    assert.match(titles, /Pikachu/, 'a genuine earlier purchase is still worth mentioning');
  });

  it('leaves out an order whose cancellation is still in flight', () => {
    // It may never become a card in their hands, so it cannot be spoken about as one.
    const titles = ps.priorCardsFor(db, 1, 'live-1').join(' | ');
    assert.ok(!/Mewtwo/.test(titles), 'a held order is not a completed purchase');
  });
});
