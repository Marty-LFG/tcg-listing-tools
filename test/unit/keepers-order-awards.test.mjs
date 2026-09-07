// test/unit/keepers-order-awards.test.mjs — the per-order award, written to the order.
//
// THE GAP THIS CLOSES. sections/bk-my-keeper.liquid's Orders tab reads
// order.metafields.keepers.xp_awarded and names lib/keepers-project.mjs as the writer in its own
// comment. Nothing wrote it. The definitions were applied to both stores, storefront-readable, and
// metafieldsCount stood at 0 — schema ready, writer never built. The per-order XP line was
// permanently blank, and because the theme renders nothing when the value is absent it degraded
// perfectly, which is why it went unnoticed rather than being reported on day one.
//
// The number cannot be computed in Liquid, and that is the whole reason these metafields exist: the
// theme would have to multiply the order total by the CURRENT rate, so every historical order
// silently re-prices itself the day the rate moves.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  openKeepersDbAt, upsertCustomer, appendEvent, orderLedger, clampReversal,
  ordersNeedingAwardProjection, markOrderAwardWritten,
} from '../../lib/keepers-db.mjs';
import { projectOrderAwards } from '../../lib/keepers-project.mjs';

const GID = 'gid://shopify/Customer/8675309';
const ORDER = 'gid://shopify/Order/5001';

let db;
beforeEach(() => {
  db = openKeepersDbAt(':memory:');
  upsertCustomer(db, { customerGid: GID, joinedAt: '2026-09-01T00:00:00Z' });
});

/** The order row ingest would have written, plus its accrual. */
function order(gid = ORDER, { xp = 74, points = 148, basisCents = 7400 } = {}) {
  db.prepare(`INSERT INTO keepers_orders (order_gid, customer_gid, channel, accrues)
              VALUES (?,?,?,1) ON CONFLICT(order_gid) DO NOTHING`).run(gid, GID, 'Online Store');
  appendEvent(db, {
    customerGid: GID, kind: 'order_accrual', xpDelta: xp, pointsDelta: points,
    source: 'shopify_order', sourceRef: gid, basisCents,
    rateXpPerDollar: 1, ratePointsPerDollar: 2, occurredAt: '2026-09-01T00:00:00Z',
  });
}

/** A reversal, scored and clamped exactly as ingest does it. */
function reverse(gid, refundedCents, ref) {
  const l = orderLedger(db, gid);
  const share = Math.min(1, refundedCents / l.basisCents);
  const c = clampReversal(db, gid, { xp: Math.floor(l.accruedXp * share), points: Math.floor(l.accruedPoints * share) });
  appendEvent(db, {
    customerGid: GID, kind: 'order_reversal', xpDelta: c.xpDelta, pointsDelta: c.pointsDelta,
    source: 'shopify_refund', sourceRef: ref, reversesEventId: c.reversesEventId,
  });
}

describe('which orders still owe Shopify a number', () => {
  it('an order that has never been written is due, with its net', () => {
    order();
    const due = ordersNeedingAwardProjection(db);
    assert.equal(due.length, 1);
    assert.equal(due[0].orderGid, ORDER);
    assert.equal(due[0].netXp, 74);
    assert.equal(due[0].netPoints, 148);
  });

  it('once written at that value it is not due again', () => {
    order();
    markOrderAwardWritten(db, ORDER, { xp: 74, points: 148 });
    assert.deepEqual(ordersNeedingAwardProjection(db), []);
  });

  it('a refund makes it due again, at the NET', () => {
    order();
    markOrderAwardWritten(db, ORDER, { xp: 74, points: 148 });
    reverse(ORDER, 3700, 'refund-1');          // half the order
    const due = ordersNeedingAwardProjection(db);
    assert.equal(due.length, 1, 'a reversal must re-queue the order — the diff IS the queue');
    assert.equal(due[0].netXp, 37);
    assert.equal(due[0].netPoints, 74);
  });

  it('an order refunded to zero is due, and its net is zero — not absent', () => {
    // The null-safe comparison earns its keep here. `xp_written != 0` is NULL against a NULL
    // xp_written, which is not true, so a never-written order would never be selected at all. An
    // order whose net is legitimately 0 must still be written, or the storefront shows the old
    // number beside a balance that has already dropped.
    order();
    reverse(ORDER, 7400, 'refund-full');
    const due = ordersNeedingAwardProjection(db);
    assert.equal(due.length, 1);
    assert.equal(due[0].netXp, 0);
    assert.equal(due[0].netPoints, 0);
  });

  it('an order with no accrual at all is never due', () => {
    // A non-accruing order — excluded channel, programme off — has nothing to publish, and writing a
    // zero to it would be a claim about an order the programme never touched.
    db.prepare(`INSERT INTO keepers_orders (order_gid, customer_gid, channel, accrues) VALUES (?,?,?,0)`)
      .run('gid://shopify/Order/9999', GID, 'eBay');
    assert.deepEqual(ordersNeedingAwardProjection(db), []);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) order(`gid://shopify/Order/60${i}`);
    assert.equal(ordersNeedingAwardProjection(db, { limit: 2 }).length, 2);
  });
});

describe('projectOrderAwards — what it sends, and what it refuses', () => {
  const capture = () => { const sent = []; return { sent, writer: async (mf) => { sent.push(mf); return { ok: true }; } }; };

  it('sends both keys against the ORDER as owner', async () => {
    order();
    const { sent, writer } = capture();
    const r = await projectOrderAwards({}, db, { writer });
    assert.equal(r.written, 1);
    assert.equal(r.failed, 0);
    assert.deepEqual(sent[0].map((m) => m.key).sort(), ['points_awarded', 'xp_awarded']);
    assert.equal(sent[0][0].ownerId, ORDER, 'the owner is the ORDER, not the customer');
    assert.equal(sent[0][0].namespace, 'keepers');
    assert.equal(sent[0].find((m) => m.key === 'xp_awarded').value, '74');
    assert.equal(sent[0].find((m) => m.key === 'points_awarded').value, '148');
  });

  it('a second pass sends nothing', async () => {
    order();
    const { sent, writer } = capture();
    await projectOrderAwards({}, db, { writer });
    const again = await projectOrderAwards({}, db, { writer });
    assert.equal(again.written, 0);
    assert.equal(again.due, 0);
    assert.equal(sent.length, 1, 'an unchanged order must not be rewritten every pass');
  });

  it('a FAILED write does not stamp the cache, so the order comes back', async () => {
    // The one thing that would lose an order for good. There is no backoff column here on purpose —
    // the diff is the queue — so the cache must only ever record a write that actually landed.
    order();
    const r = await projectOrderAwards({}, db, { writer: async () => ({ ok: false, userErrors: [{ message: 'nope' }] }) });
    assert.equal(r.failed, 1);
    assert.equal(r.written, 0);
    assert.equal(ordersNeedingAwardProjection(db).length, 1, 'a failed order must stay queued');
  });

  it('a writer that THROWS is a failure, not a crash', async () => {
    order();
    const r = await projectOrderAwards({}, db, { writer: async () => { throw new Error('network gone'); } });
    assert.equal(r.failed, 1);
    assert.match(r.problems[0].error, /network gone/);
    assert.equal(ordersNeedingAwardProjection(db).length, 1);
  });

  it('refuses the live store without the second switch', async () => {
    order();
    const { sent, writer } = capture();
    const r = await projectOrderAwards({}, db, { writer, store: 'live' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'live_not_allowed');
    assert.equal(sent.length, 0, 'nothing may reach the live store on one switch');
  });

  it('and a truthy-but-not-true allowLive is not consent', async () => {
    order();
    const { sent, writer } = capture();
    for (const bad of [1, 'true', {}, []]) {
      const r = await projectOrderAwards({}, db, { writer, store: 'live', allowLive: bad });
      assert.equal(r.error, 'live_not_allowed', `allowLive: ${JSON.stringify(bad)} must not pass`);
    }
    assert.equal(sent.length, 0);
  });
});
