// test/unit/deals-send.test.mjs — sending one invoice, and every reason not to.
//
// This is the only path in the repo that changes what a buyer is asked to pay, so the assertions that
// matter most are the negative ones: that a refusal happened BEFORE anything reached eBay, and that the
// row did not move. A guard that fires after the write is not a guard.
//
// Both eBay calls are injected, so every test here runs offline and can prove a call was never made —
// rather than stubbing a transport and hoping nothing slipped past it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { sendDealInvoice, quoteDeal, getDeal, DEAL_REFUSALS } from '../../lib/postsale.mjs';

const CFG = { dry_run: false, deals: { enabled: true, invoice_note: 'One lot of postage on this one.' } };
const DRY = { ...CFG, dry_run: true };

let tmpdir, n = 0;
before(() => { tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-dealsend-')); });
after(() => { try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {} });
const freshDb = () => openPostsaleDbAt(path.join(tmpdir, `s${++n}.db`));

// A quote for two cards: $30 and $500. Signature band, so postage is $15.20 once.
const LINES = [
  { ebay_item_id: '9001', order_line_item_id: '9001-1', sku: 'BK-A', title: 'Pikachu 025/165 SV151 Near Mint', quantity: 1, unit_price_cents: 3000 },
  { ebay_item_id: '9002', order_line_item_id: '9002-1', sku: 'BK-B', title: 'Charizard 006/165 SV151 Near Mint', quantity: 1, unit_price_cents: 50000 },
];

function seed(db, over = {}, lines = LINES) {
  const id = db.prepare(`INSERT INTO deal_requests (source, ebay_order_id, ebay_username, status, currency, postage_cents, expires_at)
                         VALUES ('quote', ?, 'buyer_bob', ?, 'AUD', ?, ?)`)
    .run(over.ebay_order_id === null ? null : (over.ebay_order_id || 'ORD-1'),
      over.status || 'awaiting_approval',
      over.postage_cents === undefined ? 1520 : over.postage_cents,
      over.expires_at === undefined ? null : over.expires_at).lastInsertRowid;
  for (const li of lines) {
    db.prepare(`INSERT INTO deal_lines (deal_id, ebay_item_id, order_line_item_id, sku, title, quantity, unit_price_cents)
                VALUES (?,?,?,?,?,?,?)`).run(id, li.ebay_item_id, li.order_line_item_id, li.sku, li.title, li.quantity, li.unit_price_cents);
  }
  return Number(id);
}

// The live order eBay would return: unpaid, Australian, matching the snapshot.
const liveOrder = (over = {}) => ({
  orderId: 'ORD-1', orderStatus: 'Active', checkoutStatus: 'Incomplete', paidTime: null,
  createdTime: new Date(Date.now() - 2 * 86400000).toISOString(),
  currency: 'AUD', totalCents: 54520, subtotalCents: 53000, shippingCents: 1520,
  shipService: 'AU_Regular',
  ship: { country: 'AU', name: 'Sam Lee' },
  items: LINES.map((l) => ({ orderLineItemId: l.order_line_item_id, itemId: l.ebay_item_id, sku: l.sku, quantity: l.quantity, unitPriceCents: l.unit_price_cents })),
  ...over,
});
const ordersOk = (over) => async () => ({ ok: true, orders: [liveOrder(over)] });

// A submitInvoice that records every call, so "no eBay call was made" is provable rather than assumed.
function spy(result = { ok: true, ack: 'Success' }) {
  const calls = [];
  const fn = async (env, payload) => { calls.push(payload); return result; };
  fn.calls = calls;
  return fn;
}

describe('sendDealInvoice — the refusals, none of which may reach eBay', () => {
  const cases = [
    ['a quote that does not exist', (db) => 999, {}, 'deal_unknown'],
    ['a quote with no eBay order behind it', (db) => seed(db, { ebay_order_id: null }), {}, 'no_order_id'],
    ['an expired quote', (db) => seed(db, { expires_at: '2020-01-01T00:00:00.000Z' }), {}, 'quote_expired'],
    ['an order the buyer has already paid for', (db) => seed(db), { orders: { paidTime: '2026-08-01T00:00:00.000Z' } }, 'order_already_paid'],
    ['an order eBay has marked complete', (db) => seed(db), { orders: { checkoutStatus: 'Complete' } }, 'order_already_paid'],
    ['a cancelled order', (db) => seed(db), { orders: { cancelStatus: 'CancelComplete' } }, 'order_cancelled'],
    ['an order shipping outside Australia', (db) => seed(db), { orders: { ship: { country: 'NZ' } } }, 'international_order'],
    ['an order past eBay\'s 30-day invoice limit', (db) => seed(db), { orders: { createdTime: new Date(Date.now() - 40 * 86400000).toISOString() } }, 'order_too_old'],
    ['an order whose lines have changed', (db) => seed(db), { orders: { items: [{ orderLineItemId: 'X-9', itemId: '9', quantity: 1, unitPriceCents: 100 }] } }, 'order_lines_changed'],
    ['a quote whose postage band has moved', (db) => seed(db, { postage_cents: 826 }), {}, 'bands_moved'],
  ];

  for (const [why, mk, opts, code] of cases) {
    it(`refuses ${why} — and sends nothing`, async () => {
      const db = freshDb();
      const id = mk(db);
      const invoice = spy();
      const r = await sendDealInvoice({}, db, id, CFG, {
        discountCents: 5000,
        fetchOrders: ordersOk(opts.orders),
        submitInvoice: invoice,
      });
      assert.equal(r.ok, false, `expected a refusal, got ${JSON.stringify(r)}`);
      assert.equal(r.code, code);
      assert.ok(r.error && r.error.length > 10, 'a refusal must say something a person can act on');
      assert.ok(DEAL_REFUSALS.has(r.code), `${r.code} must be in DEAL_REFUSALS so the route answers 409`);
      assert.equal(invoice.calls.length, 0, 'NOTHING may reach eBay on a refusal');
      // And the quote must not be stranded in 'sending' with no button that can move it.
      const row = getDeal(db, id);
      if (row) assert.notEqual(row.status, 'sending', 'a refusal must release the claim');
    });
  }

  it('refuses a bad discount without reaching eBay', async () => {
    const db = freshDb();
    const id = seed(db);
    for (const [d, code] of [[-1, 'discount_negative'], [0, 'discount_zero'], [53000, 'discount_exceeds_subtotal'], [1.5, 'discount_not_whole_cents']]) {
      const invoice = spy();
      const r = await sendDealInvoice({}, db, id, CFG, { discountCents: d, fetchOrders: ordersOk(), submitInvoice: invoice });
      assert.equal(r.code, code, `discount ${d}`);
      assert.equal(invoice.calls.length, 0);
    }
  });

  it('refuses when eBay will not say which postage service the buyer chose', async () => {
    const db = freshDb();
    const invoice = spy();
    const r = await sendDealInvoice({}, db, seed(db), CFG, {
      discountCents: 5000, fetchOrders: ordersOk({ shipService: null }), submitInvoice: invoice,
    });
    assert.equal(r.code, 'service_unknown');
    assert.equal(invoice.calls.length, 0);
  });

  it('refuses when the total on screen is not the total it worked out', async () => {
    // Optimistic concurrency, same idea as reviseTradingListing's price_moved: the owner approves a
    // figure, and if anything moved underneath it they get told rather than sending a different one.
    const db = freshDb();
    const invoice = spy();
    const r = await sendDealInvoice({}, db, seed(db), CFG, {
      discountCents: 5000, expectTotalCents: 1, fetchOrders: ordersOk(), submitInvoice: invoice,
    });
    assert.equal(r.code, 'total_moved');
    assert.equal(invoice.calls.length, 0);
  });
});

describe('sendDealInvoice — the double tap', () => {
  it('claims atomically, so only one of two concurrent sends can invoice', async () => {
    const db = freshDb();
    const id = seed(db);
    const invoice = spy();
    const opts = { discountCents: 5000, fetchOrders: ordersOk(), submitInvoice: invoice };
    const [a, b] = await Promise.all([
      sendDealInvoice({}, db, id, DRY, opts),
      sendDealInvoice({}, db, id, DRY, opts),
    ]);
    const results = [a, b];
    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one may proceed');
    const loser = results.find((r) => !r.ok);
    assert.equal(loser.code, 'already_sending');
  });
});

describe('sendDealInvoice — dry run', () => {
  it('does everything except the eBay call, and says so on the row', async () => {
    const db = freshDb();
    const id = seed(db);
    const invoice = spy();
    const r = await sendDealInvoice({}, db, id, DRY, { discountCents: 5000, fetchOrders: ordersOk(), submitInvoice: invoice });
    assert.equal(r.ok, true);
    assert.equal(r.dry_run, true);
    assert.equal(invoice.calls.length, 0, 'a rehearsal must not invoice a real buyer');
    const row = getDeal(db, id);
    assert.match(row.error, /dry_run/);
    assert.equal(row.status, 'pending', 'and it stays actionable rather than reading as sent');
    assert.equal(row.total_cents, 53000 - 5000 + 1520);
    assert.equal(row.postage_cents, 1520);
  });

  it('builds the payload it WOULD have sent, so it can be eyeballed before going live', async () => {
    const db = freshDb();
    const r = await sendDealInvoice({}, db, seed(db), DRY, { discountCents: 5000, fetchOrders: ordersOk(), submitInvoice: spy() });
    assert.equal(r.payload.orderId, 'ORD-1');
    assert.equal(r.payload.discountCents, 5000, 'a POSITIVE magnitude — the builder applies the sign');
    assert.equal(r.payload.shippingCostCents, 1520);
    assert.equal(r.payload.shippingService, 'AU_Regular', 'echoed off the order, never off the band table');
    assert.equal(r.payload.currency, 'AUD');
  });
});

describe('sendDealInvoice — the live path', () => {
  it('sends once, records what it sent, and marks the quote sent', async () => {
    const db = freshDb();
    const id = seed(db);
    const invoice = spy();
    const r = await sendDealInvoice({}, db, id, CFG, { discountCents: 5000, fetchOrders: ordersOk(), submitInvoice: invoice });
    assert.equal(r.ok, true);
    assert.equal(invoice.calls.length, 1);
    assert.equal(invoice.calls[0].discountCents, 5000);
    assert.equal(invoice.calls[0].shippingCostCents, 1520);
    const row = getDeal(db, id);
    assert.equal(row.status, 'sent');
    assert.ok(row.sent_at);
    assert.equal(row.error, null);
    assert.equal(row.total_cents, 49520);
    const ev = JSON.parse(row.evidence);
    assert.equal(ev.service, 'AU_Regular');
    assert.ok(ev.boundBy, 'the card needs to say WHY that band was chosen');
  });

  it('leaves the quote re-sendable when eBay refuses', async () => {
    const db = freshDb();
    const id = seed(db);
    const invoice = spy({ ok: false, ack: 'Failure', errors: [{ longMessage: 'eBay said no' }] });
    const r = await sendDealInvoice({}, db, id, CFG, { discountCents: 5000, fetchOrders: ordersOk(), submitInvoice: invoice });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ebay_refused');
    assert.ok(!DEAL_REFUSALS.has(r.code), 'an eBay failure is a 502, not a 409 — retrying is reasonable');
    const row = getDeal(db, id);
    assert.equal(row.status, 'awaiting_approval', 'released, not stranded in sending');
    assert.match(row.error, /ebay_refused/);
  });

  it('does not claim the invoice went when the send throws', async () => {
    const db = freshDb();
    const id = seed(db);
    const boom = async () => { throw new Error('socket hung up'); };
    const r = await sendDealInvoice({}, db, id, CFG, { discountCents: 5000, fetchOrders: ordersOk(), submitInvoice: boom });
    assert.equal(r.ok, false);
    assert.notEqual(getDeal(db, id).status, 'sent');
  });
});

describe('quoteDeal — pricing without sending', () => {
  it('prices a quote and leaves the row alone', async () => {
    const db = freshDb();
    const id = seed(db);
    const q = quoteDeal(db, id, 5000);
    assert.equal(q.ok, true);
    assert.equal(q.summary.subtotalCents, 53000);
    assert.equal(q.summary.postageCents, 1520);
    assert.equal(q.totalCents, 49520);
    assert.equal(getDeal(db, id).status, 'awaiting_approval', 'pricing must not decide anything');
  });

  it('returns the summary with no discount applied when none is given', () => {
    const db = freshDb();
    const q = quoteDeal(db, seed(db), null);
    assert.equal(q.ok, true);
    assert.equal(q.summary.grossTotalCents, 53000 + 1520);
    assert.equal(q.totalCents, undefined);
  });

  it('404-shaped for an unknown quote', () => {
    assert.equal(quoteDeal(freshDb(), 999, null).code, 'deal_unknown');
  });
});
