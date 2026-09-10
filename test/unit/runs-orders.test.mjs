// test/unit/runs-orders.test.mjs — turning a storefront order into a ledger entry.
//
// No network: the GraphQL client is injected. The properties that matter are idempotence — re-reading an
// overlapping window must append nothing the second time — and that a refusal is NAMED rather than
// counted, because a sale of a number the ledger already accounted for means the storefront let a second
// unit through, which is an incident and not a statistic.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { runLinesOf, ingestRunOrders, ordersCursor, availabilityDrift } from '../../lib/runs-orders.mjs';
import { availability, publicLedger, appendSale } from '../../lib/runs-ledger.mjs';
import { submitAnchor, upgradeAnchor } from '../../lib/runs-anchor.mjs';

const db = openDbAt(tmpFile('runs-orders.db'));

let n = 0;
async function mkRun({ units = 3 } = {}) {
  const k = ++n;
  const pid = `DEV-O${k}`;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, locked_at, run_root, header_digest)
              VALUES (?,?,?, 'dev', ?, 'locked_published', '2026-08-30T00:00:00.000Z', ?, ?)`)
    .run(pid, k, `Orders ${k}`, units, 'ab'.repeat(32), String(k).padStart(2, '0').repeat(32));
  const runId = db.prepare('SELECT id FROM runs WHERE public_id = ?').get(pid).id;
  for (let i = 1; i <= units; i++) {
    db.prepare('INSERT INTO run_bundles (run_id, bundle_no, label) VALUES (?,?,?)').run(runId, i, `${pid}-00${i}`);
  }
  const run = db.prepare('SELECT header_digest FROM runs WHERE id = ?').get(runId);
  const a = await submitAnchor(db, { runId, digest: run.header_digest, mode: 'stub' });
  await upgradeAnchor(db, a.id);
  return { runId, pid, run: db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) };
}

const order = (pid, nos, over = {}) => ({
  id: over.id || `gid://shopify/Order/${Math.floor(Math.random() * 1e9)}`,
  name: over.name || '#1001',
  createdAt: '2026-09-01T10:00:00.000Z',
  processedAt: '2026-09-01T10:00:00.000Z',
  updatedAt: over.updatedAt || '2026-09-01T10:00:05.000Z',
  cancelledAt: over.cancelledAt || null,
  displayFinancialStatus: over.financial || 'PAID',
  customer: { id: 'gid://shopify/Customer/5' },
  lineItems: {
    nodes: nos.map((no, i) => ({
      id: over.lineIds?.[i] || `gid://shopify/LineItem/${pid}-${no}`,
      sku: typeof no === 'string' ? no : `BK-RUN-${pid}-${String(no).padStart(3, '0')}`,
      quantity: 1,
    })),
  },
});

const feed = (orders) => async () => ({
  ok: true,
  data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: orders } },
});

describe('picking a run\'s own lines out of an order', () => {
  it('takes only this run\'s SKUs, ASCENDING BY NUMBER', () => {
    // §12.2 permits three numbers in one order, and the chain must be reproducible — so the order in
    // which one order's lines enter it cannot depend on how Shopify happened to return them.
    const o = order('DEV-O1', [3, 1, 2]);
    assert.deepEqual(runLinesOf(o, { public_id: 'DEV-O1' }).map((l) => l.bundleNo), [1, 2, 3]);
  });

  it('ignores an ordinary shelf SKU in the same order', () => {
    const o = order('DEV-O1', [1, 'BK-PKM-000042']);
    assert.deepEqual(runLinesOf(o, { public_id: 'DEV-O1' }).map((l) => l.bundleNo), [1]);
  });

  it('and ignores ANOTHER run\'s SKU, which lives in the same store', () => {
    const o = order('DEV-O1', [1, 'BK-RUN-DEV-O9-002']);
    assert.deepEqual(runLinesOf(o, { public_id: 'DEV-O1' }).map((l) => l.bundleNo), [1]);
  });
});

describe('ingesting', () => {
  it('appends one entry per line and binds it to the order', async () => {
    const { runId, pid } = await mkRun();
    const out = await ingestRunOrders({}, db, { runId, graphql: feed([order(pid, [2])]) });
    assert.equal(out.appended, 1);
    assert.deepEqual(availability(db, runId).available, [1, 3]);
  });

  it('IS IDEMPOTENT — re-reading the same window appends nothing', async () => {
    // The property the whole poll turns on. The window deliberately overlaps, so every order is seen more
    // than once by design.
    const { runId, pid } = await mkRun();
    const o = order(pid, [1]);
    await ingestRunOrders({}, db, { runId, graphql: feed([o]) });
    const again = await ingestRunOrders({}, db, { runId, graphql: feed([o]) });
    assert.equal(again.appended, 0);
    assert.equal(again.duplicates, 1);
    assert.equal(publicLedger(db, runId).entries.length, 1);
  });

  it('a three-number order produces three entries with consecutive ordinals', async () => {
    const { runId, pid } = await mkRun();
    const out = await ingestRunOrders({}, db, { runId, graphql: feed([order(pid, [1, 2, 3])]) });
    assert.equal(out.appended, 3);
    assert.deepEqual(publicLedger(db, runId).entries.map((e) => Number(e.seq)), [1, 2, 3]);
    assert.deepEqual(availability(db, runId).available, []);
  });

  it('skips an unpaid order, because an unpaid order is not a sale', async () => {
    const { runId, pid } = await mkRun();
    const out = await ingestRunOrders({}, db, { runId, graphql: feed([order(pid, [1], { financial: 'PENDING' })]) });
    assert.equal(out.appended, 0);
    assert.deepEqual(availability(db, runId).available, [1, 2, 3]);
  });

  it('REFUSES a number the ledger already accounted for, and names it', async () => {
    // From the poll this is an incident: the storefront let a second unit through. It has to reach an
    // operator as a bundle number, not as a counter.
    const { runId, pid } = await mkRun();
    await appendSale(db, runId, { bundleNo: 2 });
    const out = await ingestRunOrders({}, db, { runId, graphql: feed([order(pid, [2])]) });
    assert.equal(out.appended, 0);
    assert.equal(out.refused.length, 1);
    assert.equal(out.refused[0].bundleNo, 2);
    assert.match(out.refused[0].why, /already accounted for/);
  });

  it('and one refusal does not stop the rest of the order', async () => {
    const { runId, pid } = await mkRun();
    await appendSale(db, runId, { bundleNo: 1 });
    const out = await ingestRunOrders({}, db, { runId, graphql: feed([order(pid, [1, 2, 3])]) });
    assert.equal(out.appended, 2);
    assert.equal(out.refused.length, 1);
    assert.deepEqual(availability(db, runId).available, []);
  });

  it('a cancelled order that was ingested releases its number', async () => {
    const { runId, pid } = await mkRun();
    const o = order(pid, [3]);
    await ingestRunOrders({}, db, { runId, graphql: feed([o]) });
    assert.deepEqual(availability(db, runId).available, [1, 2]);
    const cancelled = { ...o, cancelledAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:01.000Z' };
    const out = await ingestRunOrders({}, db, { runId, graphql: feed([cancelled]) });
    assert.equal(out.cancelled, 1);
    assert.deepEqual(availability(db, runId).available, [1, 2, 3]);
  });

  it('and a cancelled order that was never ingested is simply ignored', async () => {
    const { runId, pid } = await mkRun();
    const out = await ingestRunOrders({}, db, {
      runId, graphql: feed([order(pid, [1], { cancelledAt: '2026-09-02T00:00:00.000Z' })]),
    });
    assert.equal(out.appended, 0);
    assert.equal(out.cancelled, 0);
    assert.deepEqual(availability(db, runId).available, [1, 2, 3]);
  });

  it('advances its cursor, and keeps it off the runs row', async () => {
    const { runId, pid } = await mkRun();
    assert.equal(ordersCursor(db, runId), null);
    await ingestRunOrders({}, db, { runId, graphql: feed([order(pid, [1], { updatedAt: '2026-09-05T00:00:00.000Z' })]) });
    assert.equal(ordersCursor(db, runId), '2026-09-05T00:00:00.000Z');
  });

  it('and a failed read is reported rather than losing the cursor', async () => {
    const { runId } = await mkRun();
    const out = await ingestRunOrders({}, db, { runId, graphql: async () => ({ ok: false, httpStatus: 500 }) });
    assert.equal(out.errors.length, 1);
    assert.equal(out.appended, 0);
  });
});

describe('availability drift is reported, never silently reconciled', () => {
  it('names a number the ledger and the storefront disagree about', async () => {
    // The two disagreeing means either an oversell the storefront allowed or a mirror write that failed,
    // and those need opposite responses. Quietly "fixing" it erases the evidence of which.
    const { runId, pid } = await mkRun();
    const bundle = db.prepare('SELECT id FROM run_bundles WHERE run_id = ? AND bundle_no = 1').get(runId);
    db.prepare(`INSERT INTO shopify_listings (sku, kind, item_id, available_qty, state)
                VALUES (?, 'run', ?, 1, 'live')`).run(`BK-RUN-${pid}-001`, bundle.id);
    assert.equal(availabilityDrift(db, runId).ok, true);

    await appendSale(db, runId, { bundleNo: 1 });
    const d = availabilityDrift(db, runId);
    assert.equal(d.ok, false);
    assert.equal(d.drift[0].bundle_no, 1);
    assert.equal(d.drift[0].ledger, 'accounted for');
    assert.equal(d.drift[0].storefront, 'available');
  });
});
