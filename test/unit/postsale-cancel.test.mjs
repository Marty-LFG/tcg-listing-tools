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
  IN_QUEUE_SQL, NEEDS_PACKING_SQL, PICKABLE_SQL, NOT_CANCELLED_SQL, HOLD_SQL,
} from '../../lib/postsale.mjs';

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
    assert.ok(isOnHold({ cancel_state: 'unknown' }));
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
  const unshipped = { shipped_status: 'unshipped', picked_at: null, label_bought_at: null };

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

  it('a failed payment holds the order the same way, and says so differently', () => {
    const o = { ...unshipped, payment_state: 'failed' };
    assert.equal(inQueue(o), true);
    assert.equal(pickable(o), false);
    assert.equal(holdReason(o), 'payment failed');
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
      picked_at TEXT, label_bought_at TEXT, cancel_state TEXT, payment_state TEXT)`);
    db.exec(`INSERT INTO orders (order_id) VALUES ('legacy-1'), ('legacy-2'), ('legacy-3')`);
    db.exec(`INSERT INTO orders (order_id, cancel_state) VALUES ('cancelled-1','cancelled')`);
    db.exec(`INSERT INTO orders (order_id, cancel_state) VALUES ('requested-1','requested')`);
    db.exec(`INSERT INTO orders (order_id, cancel_state) VALUES ('unknown-1','unknown')`);
    db.exec(`INSERT INTO orders (order_id, cancel_state) VALUES ('rejected-1','rejected')`);
    db.exec(`INSERT INTO orders (order_id, payment_state) VALUES ('badpay-1','failed')`);
    db.exec(`INSERT INTO orders (order_id, shipped_status) VALUES ('posted-1','shipped')`);
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
    assert.deepEqual(p, ['legacy-1', 'legacy-2', 'legacy-3', 'rejected-1']);
    // NEEDS_PACKING_SQL is the wider set the per-order buttons use: a human may pack a held order.
    const n = idsWhere(NEEDS_PACKING_SQL);
    assert.ok(n.includes('requested-1') && n.includes('badpay-1'));
  });

  it('the "shipped" tab is the negation of the queue, so it must exclude cancelled explicitly', () => {
    // Without the extra clause a cancelled order — newly absent from the queue — reads as SHIPPED,
    // which moves the bug rather than fixing it.
    const shipped = idsWhere(`NOT ${IN_QUEUE_SQL} AND ${NOT_CANCELLED_SQL}`);
    assert.deepEqual(shipped, ['posted-1']);
    const naive = idsWhere(`NOT ${IN_QUEUE_SQL}`);
    assert.ok(naive.includes('cancelled-1'), 'guarding the regression this test exists for');
  });

  it('HOLD_SQL finds exactly what needs a decision', () => {
    assert.deepEqual(idsWhere(HOLD_SQL), ['badpay-1', 'requested-1', 'unknown-1']);
  });

  it('the SQL and the JS agree, row for row', () => {
    // Two implementations of one rule is how the dashboard and the pick sheet end up disagreeing.
    const rows = db.prepare('SELECT * FROM orders').all();
    const sqlQueue = new Set(idsWhere(IN_QUEUE_SQL));
    const sqlPickable = new Set(idsWhere(PICKABLE_SQL));
    for (const r of rows) {
      assert.equal(inQueue(r), sqlQueue.has(r.order_id), `inQueue disagrees on ${r.order_id}`);
      assert.equal(pickable(r), sqlPickable.has(r.order_id), `pickable disagrees on ${r.order_id}`);
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
    const cols = { order_id: id, buyer_id: buyerId, ...over };
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
