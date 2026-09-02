// test/unit/runs-ledger.test.mjs — §5.6.2 the committed sale ledger.
//
// THE SIX-ENTRY VECTOR CHAIN IS THE PRIMARY PROOF and it is the first thing in this file. Everything else
// is a property that chain does not pin.
//
// The ledger exists for one attack the cryptography does not touch: LYING ABOUT AVAILABILITY. A buyer asks
// for 7, we want to keep 7, we say it is taken. Publishing the chain makes the available set at any moment
// derivable by anyone, so a buyer told "7 is gone" can check that 7 really was sold to an earlier ordinal.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import {
  chainOf, verifyChain, ledgerCanonical, normalizeEntry, availabilityFrom, validDetail,
  instant, mintReceiptToken, appendEntry, appendSale, appendCancel, appendPause, appendResume,
  appendOpenedLive, availability, publicLedger, ledgerHead, orderBinding, ZERO_HASH,
} from '../../lib/runs-ledger.mjs';
import { submitAnchor, upgradeAnchor } from '../../lib/runs-anchor.mjs';

// --- §5.6.5, transcribed from the specification -------------------------------------------------------

const VECTOR = [
  { kind: 'sale_online', seq: 1, ref: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', occurredAt: '2026-09-01T10:00:00.000Z', bundleNo: '002', qty: 1, detail: '' },
  { kind: 'reprice', seq: 0, ref: '', occurredAt: '2026-09-02T09:00:00.000Z', bundleNo: '', qty: 0, detail: 'run-wide price change' },
  { kind: 'pause', seq: 0, ref: '', occurredAt: '2026-09-03T08:00:00.000Z', bundleNo: '', qty: 0, detail: 'event-melbourne;present=001,003' },
  { kind: 'sale_in_person', seq: 2, ref: '9f8e7d6c5b4a39281706f5e4d3c2b1a0', occurredAt: '2026-09-03T11:20:00.000Z', bundleNo: '003', qty: 1, detail: 'event-melbourne' },
  { kind: 'resume', seq: 0, ref: '', occurredAt: '2026-09-03T17:00:00.000Z', bundleNo: '', qty: 0, detail: 'event-melbourne' },
  { kind: 'cancel', seq: 0, ref: '9f8e7d6c5b4a39281706f5e4d3c2b1a0', occurredAt: '2026-09-04T09:00:00.000Z', bundleNo: '003', qty: 0, detail: 'buyer requested refund' },
];
const WANT = [
  '255db3441ab840f9ecad6d6003a2d61cd22b5dc61496c4f19fb4153a7d677d5e',
  'd6d0ab9b48e64cb4916332a2d0ec1d4a42d38e3c2e0980cf435a31c659aef058',
  '1cf85148bd734f398b3ea9ad8ea69325854dd083729468a2daa46066c8dbbfe8',
  '24f9150ba3d05429d8f00ac7b15b179f596f45355bf52609ace113d49a9f6c37',
  'aef2d1fbdbbd1528513417102c2f712355d8fadf161f842eb2e868ee042cfd76',
  'b57e154ecb04a0b89e119b240a7e6c33dd97cb786fe622ead839a3c7a8a76328',
];

describe('§5.6.5 the published chain reproduces', () => {
  it('the first entry canonicalises to the exact expected string', async () => {
    // Asserted as a STRING before the hash, so a failure says which field is wrong rather than only that
    // something is.
    assert.equal(ledgerCanonical('EX2', ZERO_HASH, VECTOR[0]),
      '3:EX2,64:' + ZERO_HASH + ',1:1,11:sale_online,32:a1b2c3d4e5f60718293a4b5c6d7e8f90,'
      + '24:2026-09-01T10:00:00.000Z,3:002,1:1,0:,');
  });

  it('and all six hashes match, byte for byte', async () => {
    const chain = await chainOf('EX2', VECTOR);
    chain.forEach((e, i) => assert.equal(e.entry_hash, WANT[i], `${i} ${e.kind}`));
  });

  it('the chain verifies as a whole', async () => {
    const v = await verifyChain('EX2', await chainOf('EX2', VECTOR));
    assert.deepEqual(v.errors, []);
    assert.equal(v.ok, true);
    assert.equal(v.sales, 2);
  });

  it('and a single altered field breaks it at that entry', async () => {
    const chain = await chainOf('EX2', VECTOR);
    chain[3] = { ...chain[3], bundleNo: '001' };
    const v = await verifyChain('EX2', chain);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /entry 3/.test(e)));
  });

  it('a chain from one run cannot be replayed under another', async () => {
    // public_id is inside every hash for exactly this reason.
    const v = await verifyChain('EX3', await chainOf('EX2', VECTOR));
    assert.equal(v.ok, false);
  });
});

describe('the field grammars', () => {
  it('seq means SALE ORDINAL: 0 on everything else, cancellations included', () => {
    // Revision 4's vector used 3 on a cancel while its own prose said 0, and both reviewers caught it.
    assert.throws(() => normalizeEntry({ kind: 'cancel', seq: 3, ref: 'a'.repeat(32), occurredAt: '2026-09-01T00:00:00.000Z', bundleNo: '001' }), /consumes an ordinal/);
    assert.throws(() => normalizeEntry({ kind: 'sale_online', seq: 0, qty: 1, bundleNo: '001', occurredAt: '2026-09-01T00:00:00.000Z' }), /consumes an ordinal/);
  });

  it('qty is 1 on a sale and 0 on everything else', () => {
    assert.throws(() => normalizeEntry({ kind: 'reprice', seq: 0, qty: 1, occurredAt: '2026-09-01T00:00:00.000Z' }), /carries qty/);
  });

  it('a disposition must name a bundle', () => {
    assert.throws(() => normalizeEntry({ kind: 'opened_live', seq: 0, qty: 0, occurredAt: '2026-09-01T00:00:00.000Z' }), /must name a bundle/);
  });

  it('a receipt token is 32 lowercase hex, never an order number', () => {
    // §5.6.2: revision 3 used SHA-256(order id), and storefront order numbers are short and sequential —
    // a few thousand preimages, so anyone recovers ordinal to order number instantly.
    assert.throws(() => normalizeEntry({ kind: 'sale_online', seq: 1, qty: 1, bundleNo: '001', ref: '#1001', occurredAt: '2026-09-01T00:00:00.000Z' }), /32 lowercase hex/);
    assert.match(mintReceiptToken(), /^[0-9a-f]{32}$/);
    assert.notEqual(mintReceiptToken(), mintReceiptToken());
  });

  it('THE DETAIL GRAMMAR FOLLOWS THE VECTORS, NOT THE PROSE', () => {
    // §5.6.5 restricts "keys and values" to [A-Za-z0-9_.,=-], which excludes the space — and then two of
    // its own six vectors use "run-wide price change" and "buyer requested refund". The vectors are what a
    // conforming implementation must reproduce, so the restriction governs the STRUCTURED form only.
    assert.equal(validDetail('run-wide price change'), true);
    assert.equal(validDetail('buyer requested refund'), true);
    assert.equal(validDetail('event-melbourne;present=001,003'), true);
    // A structured detail stays strict, so present= remains machine-parsable.
    assert.equal(validDetail('bad id;present=001'), false);
    // And no control characters, which would survive netstring framing and break every rendering.
    assert.equal(validDetail('a\nb'), false);
    assert.equal(validDetail('a\tb'), false);
  });

  it('and a detail may never carry a monetary amount', () => {
    // §5.6.2: a reprice records only THAT a run-wide change happened. Refused at write time, because a
    // detail that reached the database would then be anchored and only throw on read.
    assert.throws(() => normalizeEntry({ kind: 'reprice', seq: 0, qty: 0, detail: 'raised to $129', occurredAt: '2026-09-01T00:00:00.000Z' }), /monetary amount/);
  });

  it('an instant is RFC 3339 UTC with milliseconds', () => {
    assert.equal(instant('2026-09-01T10:00:00.000Z'), '2026-09-01T10:00:00.000Z');
    assert.equal(instant('2026-09-01T10:00:00Z'), '2026-09-01T10:00:00.000Z');
    assert.throws(() => instant('not a date'), TypeError);
  });
});

describe('§5.6.3 availability is derivable by anyone', () => {
  const at = (kind, bundleNo, ref = '', detail = '') => ({
    kind, seq: kind.startsWith('sale') ? 1 : 0, qty: kind.startsWith('sale') ? 1 : 0,
    bundleNo, ref, detail, occurredAt: '2026-09-01T00:00:00.000Z',
  });

  it('a sale removes its number', () => {
    const a = availabilityFrom(3, [at('sale_online', '002', 'a'.repeat(32))]);
    assert.deepEqual(a.available, [1, 3]);
  });

  it('a cancellation gives it back', () => {
    const token = 'a'.repeat(32);
    const a = availabilityFrom(3, [at('sale_online', '002', token), at('cancel', '002', token, 'refund')]);
    assert.deepEqual(a.available, [1, 2, 3]);
  });

  it('and a second cancellation of the same token changes nothing', () => {
    const token = 'a'.repeat(32);
    const a = availabilityFrom(3, [
      at('sale_online', '002', token), at('cancel', '002', token), at('cancel', '002', token),
    ]);
    assert.deepEqual(a.available, [1, 2, 3]);
  });

  it('opened_live accounts for a number without being a sale', () => {
    // The v2 unsold-policy disposition. Without it a run with one unsellable bundle could never close.
    const a = availabilityFrom(3, [at('opened_live', '003')]);
    assert.deepEqual(a.available, [1, 2]);
  });

  it('and a pause commits the set present at the event', () => {
    const a = availabilityFrom(3, [at('pause', '', '', 'event-melbourne;present=001,003')]);
    assert.equal(a.paused, true);
    assert.deepEqual(a.present, [1, 3]);
  });
});

// --- against a real database ---------------------------------------------------------------------------

const db = openDbAt(tmpFile('runs-ledger.db'));
let n = 0;
async function mkRun({ open = true, units = 3 } = {}) {
  const k = ++n;
  const pid = `DEV-L${k}`;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, locked_at, run_root, header_digest)
              VALUES (?,?,?, 'dev', ?, 'locked_published', '2026-08-30T00:00:00.000Z', ?, ?)`)
    .run(pid, k, `Ledger ${k}`, units, 'ab'.repeat(32), (`${k}`).padStart(2, '0').repeat(32));
  const runId = db.prepare('SELECT id FROM runs WHERE public_id = ?').get(pid).id;
  for (let i = 1; i <= units; i++) {
    db.prepare('INSERT INTO run_bundles (run_id, bundle_no, label) VALUES (?,?,?)').run(runId, i, `${pid}-00${i}`);
  }
  if (open) {
    const run = db.prepare('SELECT header_digest FROM runs WHERE id = ?').get(runId);
    const a = await submitAnchor(db, { runId, digest: run.header_digest, mode: 'stub' });
    await upgradeAnchor(db, a.id);
  }
  return { runId, pid };
}

describe('appending against a run', () => {
  it('chains from the zero hash and mints a receipt token', async () => {
    const { runId } = await mkRun();
    const e = await appendSale(db, runId, { bundleNo: 2 });
    assert.equal(e.prev_hash, ZERO_HASH);
    assert.equal(e.seq, 1);
    assert.match(e.token, /^[0-9a-f]{32}$/);
    assert.deepEqual(availability(db, runId).available, [1, 3]);
  });

  it('REFUSES a second sale of the same number, by name', async () => {
    // From the orders poll this is a real incident: the storefront let a second unit through.
    const { runId } = await mkRun();
    await appendSale(db, runId, { bundleNo: 2 });
    const err = await appendSale(db, runId, { bundleNo: 2 }).then(() => null, (e) => e);
    assert.equal(err.code, 'already_sold');
    assert.match(err.message, /002 is already accounted for/);
  });

  it('and refuses a sale while the gate is shut', async () => {
    const { runId } = await mkRun({ open: false });
    const err = await appendSale(db, runId, { bundleNo: 1 }).then(() => null, (e) => e);
    assert.equal(err.code, 'sale_gate');
  });

  it('a resale after a cancellation takes the NEXT ordinal, never the released one', async () => {
    const { runId } = await mkRun();
    const first = await appendSale(db, runId, { bundleNo: 1 });
    await appendCancel(db, runId, { token: first.token, reason: 'buyer requested refund' });
    const again = await appendSale(db, runId, { bundleNo: 1 });
    assert.equal(again.seq, 2, 'sale entries are never removed, so the ordinal advances');
    assert.deepEqual(availability(db, runId).available, [2, 3]);
  });

  it('refuses a cancellation after dispatch, because a return is not a release', async () => {
    const { runId } = await mkRun();
    const sale = await appendSale(db, runId, { bundleNo: 3 });
    db.prepare("UPDATE run_bundles SET shipped_at = '2026-09-05T00:00:00.000Z' WHERE run_id = ? AND bundle_no = 3").run(runId);
    await assert.rejects(() => appendCancel(db, runId, { token: sale.token }), /has shipped/);
  });

  it('and refuses a cancellation naming no known token', async () => {
    const { runId } = await mkRun();
    await assert.rejects(() => appendCancel(db, runId, { token: 'f'.repeat(32) }), /must name the receipt token/);
  });

  it('a pause DERIVES the set present rather than taking it from the caller', async () => {
    // §5.6.4 rule 1: all unsold bundles travel. A seller bringing a subset regains the selection control
    // buyer-choice exists to remove, and the committed set makes a shortfall checkable.
    const { runId } = await mkRun();
    await appendSale(db, runId, { bundleNo: 2 });
    const p = await appendPause(db, runId, { eventId: 'event-melbourne' });
    assert.equal(p.detail, 'event-melbourne;present=001,003');
    assert.equal(availability(db, runId).paused, true);
    await appendResume(db, runId, { eventId: 'event-melbourne' });
    assert.equal(availability(db, runId).paused, false);
  });

  it('opened_live closes out a number nobody bought', async () => {
    const { runId } = await mkRun();
    await appendOpenedLive(db, runId, { bundleNo: 1, detail: 'stream-2026-10-01' });
    assert.deepEqual(availability(db, runId).available, [2, 3]);
  });

  it('and every chain written this way verifies', async () => {
    const { runId, pid } = await mkRun();
    const s = await appendSale(db, runId, { bundleNo: 1 });
    await appendPause(db, runId, { eventId: 'ev1' });
    await appendResume(db, runId, { eventId: 'ev1' });
    await appendCancel(db, runId, { token: s.token, reason: 'changed mind' });
    const pub = publicLedger(db, runId);
    const v = await verifyChain(pid, pub.entries);
    assert.deepEqual(v.errors, []);
    assert.equal(pub.head, ledgerHead(db, runId).prevHash);
  });
});

describe('the order binding is private', () => {
  it('is written in the same transaction and never reaches the public ledger', async () => {
    // §5.6.2 makes `ref` a random token specifically so a storefront order number is not recoverable.
    // Putting the order id on the ledger row would undo that in one column, so it lives in its own table.
    const { runId } = await mkRun();
    const e = await appendSale(db, runId, {
      bundleNo: 1,
      order: { channel: 'shopify', store: 'dev', orderRef: 'gid://shopify/Order/123', orderName: '#1001', lineRef: 'gid://shopify/LineItem/9' },
    });
    const bound = orderBinding(db, e.id);
    assert.equal(bound.order_name, '#1001');

    const body = JSON.stringify(publicLedger(db, runId));
    assert.ok(!body.includes('#1001'), 'an order name reached the public ledger');
    assert.ok(!body.includes('gid://shopify/Order/123'), 'an order id reached the public ledger');
    assert.ok(body.includes(e.token), 'the receipt token is published, and is how a buyer finds their entry');
  });

  it('and one order line can only be bound once', async () => {
    const { runId } = await mkRun();
    const order = { channel: 'shopify', store: 'dev', orderRef: 'gid://o/1', lineRef: 'gid://li/1' };
    await appendSale(db, runId, { bundleNo: 1, order });
    // The idempotency key for the poll: re-reading the same order must not append a second entry.
    await assert.rejects(() => appendSale(db, runId, { bundleNo: 2, order }), /UNIQUE constraint failed/);
  });
});
