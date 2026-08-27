// test/unit/postsale-settle-label.test.mjs — settleLabelBought, the hand-driven escape hatch for
// dropping a label_bought order out of the pack queue.
//
// It used to sweep: every untracked row parked in label_bought was assumed to be a Seller Hub
// bulk-tick and cleared, by the same "a bought label carries a tracking number" test refreshOrder
// applied. That test is gone — an eBay-bought Australia Post Regular Letter label is untracked, so it
// was clearing exactly the orders that are now deliberately held — and a sweep still running on it
// would undo the live rule on every invocation. So it takes ids now, and the properties that matter
// are: no ids clears nothing, a dry run writes nothing, and a second apply is a no-op. All offline,
// against a temp SQLite file.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { ingestOrder, settleLabelBought, attachFulfilment, inQueue } from '../../lib/postsale.mjs';
import { DEFAULT_POSTAGE_CONFIG } from '../../lib/postage.mjs';

const CFG = { labels: false, messaging: false, postage: DEFAULT_POSTAGE_CONFIG };

let tmpdir;
before(() => { tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-settle-')); });
after(() => { try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {} });

let n = 0;
const freshDb = () => openPostsaleDbAt(path.join(tmpdir, `s${++n}.db`));

const mkOrder = (id, over = {}) => ({
  orderId: id, buyerUsername: 'buyer' + id, orderStatus: 'Completed', checkoutStatus: 'Complete',
  paidStatus: 'NoPaymentFailure', createdTime: '2026-08-01T01:00:00.000Z', paidTime: '2026-08-01T01:05:00.000Z',
  shippedTime: null, currency: 'AUD', totalCents: 4550, subtotalCents: 4200, shippingCents: 0,
  // AU_AusPostStandardLetter, not AU_Regular: AU_Regular is the account's $8.26 TRACKED letter
  // (band 2). It only ever looked untracked because it matches none of the classifier's regexes,
  // which is the bug KNOWN_SERVICES fixes. This fixture wants a genuinely plain letter.
  shipService: 'AU_AusPostStandardLetter', paid: true,
  ship: { name: 'Sam Lee', street1: '9 King St', street2: null, city: 'Sydney', state: 'NSW', postal: '2000', country: 'AU', countryName: 'Australia', phone: null },
  items: [{ orderLineItemId: id + '-1', transactionId: 't' + id, itemId: '900' + id, sku: 'AAA-00' + id, title: 'Card ' + id, quantity: 1, unitPriceCents: 4200 }],
  ...over,
});
const row = (db, id) => db.prepare('SELECT * FROM orders WHERE order_id=?').get(id);

// Park an order in label_bought. This is now the ORDINARY shape refreshOrder produces for anything
// eBay flipped that we never touched, tracked or not — not a historical artefact.
function parkAsLabelBought(db, id, { tracking = null, service = 'AU_AusPostStandardLetter' } = {}) {
  db.prepare(`UPDATE orders SET shipped_status='shipped', shipped_time='2026-08-02T05:00:00.000Z',
              dispatch_source='ebay', label_bought_at='2026-08-02T05:07:00.000Z',
              tracking_number=?, ship_service=? WHERE order_id=?`).run(tracking, service, id);
}

describe('settleLabelBought', () => {
  it('refuses without ids and hands back the candidates instead', () => {
    // The old sweep decided for itself which rows had "really" been posted. Nothing can answer that
    // now, so the useful reply is the list it used to act on, handed over rather than acted upon.
    const db = freshDb();
    ingestOrder(db, mkOrder('A'), CFG);
    ingestOrder(db, mkOrder('B'), CFG);
    parkAsLabelBought(db, 'A');
    parkAsLabelBought(db, 'B', { tracking: '36LB1234567890', service: 'AU_Express' });

    const r = settleLabelBought(db, CFG, { apply: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ids_required');
    assert.equal(r.updated, 0);
    assert.deepEqual(r.candidates.map((o) => o.order_id).sort(), ['A', 'B']);
    assert.ok(row(db, 'A').label_bought_at, 'and however untracked the row is, it is still there');
    assert.ok(row(db, 'B').label_bought_at);
  });

  it('a dry run names what it would clear and writes nothing', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('A'), CFG);
    ingestOrder(db, mkOrder('B'), CFG);
    parkAsLabelBought(db, 'A');
    parkAsLabelBought(db, 'B');

    const r = settleLabelBought(db, CFG, { ids: ['A'] });
    assert.equal(r.ok, true);
    assert.equal(r.dry_run, true);
    assert.equal(r.checked, 2);
    assert.equal(r.updated, 0);
    assert.deepEqual(r.settled.map((o) => o.order_id), ['A']);
    assert.ok(row(db, 'A').label_bought_at, 'a dry run must not have touched the row');
  });

  it('apply clears exactly the named row and leaves it posted', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('A'), CFG);
    ingestOrder(db, mkOrder('B'), CFG);
    parkAsLabelBought(db, 'A');
    parkAsLabelBought(db, 'B');

    const r = settleLabelBought(db, CFG, { apply: true, ids: ['A'] });
    assert.equal(r.updated, 1);
    const o = row(db, 'A');
    assert.equal(o.label_bought_at, null);
    assert.equal(o.shipped_status, 'shipped', "eBay's own flag is untouched");
    assert.equal(o.dispatch_source, 'ebay', 'and so is the provenance the badge reads');
    assert.equal(inQueue(o), false);
    assert.equal(attachFulfilment([o])[0].fulfilment_state, 'posted');
    assert.ok(row(db, 'B').label_bought_at, 'and the row nobody named is left alone');
  });

  it('clears a TRACKED row too when it is named — the caller is asserting the parcel has gone', () => {
    // The old version refused this outright, because a tracking number meant a real bought label. It
    // still does mean that, and it says nothing about whether the parcel has been lodged, which is the
    // only question this function answers. A human naming the order is the evidence now.
    const db = freshDb();
    ingestOrder(db, mkOrder('B'), CFG);
    parkAsLabelBought(db, 'B', { tracking: '36LB1234567890', service: 'AU_Express' });

    const r = settleLabelBought(db, CFG, { apply: true, ids: ['B'] });
    assert.equal(r.updated, 1);
    assert.equal(inQueue(row(db, 'B')), false);
  });

  it('an id that is not in the queue is reported, not silently dropped', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('A'), CFG);
    parkAsLabelBought(db, 'A');

    const r = settleLabelBought(db, CFG, { apply: true, ids: ['A', 'NOPE'] });
    assert.equal(r.updated, 1);
    assert.deepEqual(r.missing, ['NOPE']);
  });

  it('a second apply is a no-op — a cleared row no longer matches', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('A'), CFG);
    parkAsLabelBought(db, 'A');

    assert.equal(settleLabelBought(db, CFG, { apply: true, ids: ['A'] }).updated, 1);
    const again = settleLabelBought(db, CFG, { apply: true, ids: ['A'] });
    assert.equal(again.checked, 0);
    assert.equal(again.updated, 0);
  });

  it('a picked order is out of scope — it already left the queue', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('A'), CFG);
    parkAsLabelBought(db, 'A');
    db.prepare(`UPDATE orders SET picked_at='2026-08-02T06:00:00.000Z' WHERE order_id='A'`).run();

    const r = settleLabelBought(db, CFG, { apply: true, ids: ['A'] });
    assert.equal(r.checked, 0, 'label_bought_at is history once picked_at is set');
    assert.ok(row(db, 'A').label_bought_at, 'and history is not rewritten');
  });

  it('a cancelled order is out of scope', () => {
    const db = freshDb();
    ingestOrder(db, mkOrder('A'), CFG);
    parkAsLabelBought(db, 'A');
    db.prepare(`UPDATE orders SET cancel_state='cancelled' WHERE order_id='A'`).run();
    assert.equal(settleLabelBought(db, CFG, { apply: true, ids: ['A'] }).checked, 0);
  });

  it('an unshipped row falls back to to_pack, not posted', () => {
    // Defensive: nothing should produce this shape, but clearing the stamp on one must return it to
    // the queue as work rather than silently marking it done.
    const db = freshDb();
    ingestOrder(db, mkOrder('A'), CFG);
    db.prepare(`UPDATE orders SET label_bought_at='2026-08-02T05:07:00.000Z' WHERE order_id='A'`).run();

    assert.equal(settleLabelBought(db, CFG, { apply: true, ids: ['A'] }).updated, 1);
    const o = row(db, 'A');
    assert.equal(o.shipped_status, 'unshipped');
    assert.equal(inQueue(o), true);
    assert.equal(attachFulfilment([o])[0].fulfilment_state, 'to_pack');
  });
});
