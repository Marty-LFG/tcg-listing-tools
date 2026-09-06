// test/unit/keepers-project.test.mjs — the ledger projected onto customer metafields.
//
// The Shopify write is injected, so everything the projection DECIDES is testable offline: who gets
// written, who gets skipped, what the values are, and — the ones that matter most — the three refusals.
// Each refusal exists because the alternative fails silently and looks like success:
//
//   no events        writing zeroes flips the storefront from "not started" to a dashboard of zeroes.
//   no rank table    writing level 1 to everyone demotes every Keeper on the store.
//   lease held       two writers on one customer, last-write-wins, with no way to tell afterwards.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectionFor, factsFor, isUnchanged, metafieldInputs, projectDirty,
  acquireLease, releaseLease, projectionQueueDepth, NAMESPACE,
} from '../../lib/keepers-project.mjs';
import { openKeepersDbAt, appendEvent, upsertCustomer, getCustomer, markDirty } from '../../lib/keepers-db.mjs';
import { normalizeBadges } from '../../lib/keepers-badges.mjs';

const GID = 'gid://shopify/Customer/8675309';
const ORDER = 'gid://shopify/Order/5001';

const RANKS = [
  { level: 1, minXp: 0, rankName: 'Rookie Keeper', perk: '' },
  { level: 2, minXp: 125, rankName: 'Sleeve Keeper', perk: '' },
  { level: 3, minXp: 375, rankName: 'Binder Keeper', perk: '' },
];
const BADGES = normalizeBadges([
  { badge_id: 'first-pull', rule: 'first_order', sort: '1' },
  { badge_id: 'globetrotter', rule: 'languages', rule_params: '{"require":["English","Japanese"]}', sort: '3' },
]);
const RULES = { xp_per_dollar: 1, points_per_dollar: 2 };

let db;
beforeEach(() => {
  db = openKeepersDbAt(':memory:');
  upsertCustomer(db, { customerGid: GID, joinedAt: '2026-09-01T00:00:00Z' });
});

const accrue = (over = {}) => appendEvent(db, {
  customerGid: GID, kind: 'order_accrual', xpDelta: 200, pointsDelta: 400,
  source: 'shopify_order', sourceRef: ORDER, basisCents: 20000,
  rateXpPerDollar: 1, ratePointsPerDollar: 2, occurredAt: '2026-09-02T00:00:00Z',
  evidence: { languages: ['English', 'Japanese'], preorder: false, skus: ['ABC'] },
  ...over,
});

describe('projectionFor', () => {
  it('derives xp, points, level and badges from the ledger', () => {
    accrue();
    const p = projectionFor(db, GID, { rankTable: RANKS, badges: BADGES, rules: RULES });
    assert.equal(p.xp, 200);
    assert.equal(p.points, 400);
    assert.equal(p.level, 2, '200 XP is Sleeve Keeper');
    assert.equal(p.rankName, 'Sleeve Keeper');
    assert.deepEqual(p.badges, ['first-pull', 'globetrotter']);
    assert.equal(p.joinedAt, '2026-09-01T00:00:00Z');
  });

  it('returns NULL for a customer with no events — the load-bearing null', () => {
    // Writing zeroes here flips the storefront out of its "not started yet" state and into a
    // dashboard of zeroes, which reads as a broken programme rather than an unstarted one.
    assert.equal(projectionFor(db, GID, { rankTable: RANKS, badges: BADGES, rules: RULES }), null);
  });

  it('clamps a negative balance to zero without hiding it', () => {
    // Spend points, then refund the order that earned them. The customer sees zero and earns back;
    // the shortfall stays visible so nobody thinks the ledger is wrong.
    accrue();
    appendEvent(db, { customerGid: GID, kind: 'redemption_debit', pointsDelta: -500, source: 'redemption', sourceRef: '1' });
    const p = projectionFor(db, GID, { rankTable: RANKS, badges: BADGES, rules: RULES });
    assert.equal(p.points, 0);
    assert.equal(p.negativeShortfall, 100);
  });

  it('THROWS on an unusable rank table rather than projecting level 1', () => {
    accrue();
    assert.throws(() => projectionFor(db, GID, { rankTable: [], badges: BADGES, rules: RULES }), /cannot project/);
  });

  it('never withdraws a badge already awarded in the ledger', () => {
    // A badge is a memory, not a balance. Even if its rule would no longer fire, it stays.
    accrue();
    appendEvent(db, { customerGid: GID, kind: 'badge_award', badgeId: 'streak-keeper', source: 'derive' });
    const p = projectionFor(db, GID, { rankTable: RANKS, badges: BADGES, rules: RULES });
    assert.ok(p.badges.includes('streak-keeper'), 'an awarded badge survives even with no matching rule');
  });
});

describe('factsFor — assembled from what was RECORDED, never re-read', () => {
  it('collects languages and skus out of the snapshotted evidence', () => {
    accrue();
    const f = factsFor(db, GID);
    assert.deepEqual(f.languages.sort(), ['English', 'Japanese']);
    assert.deepEqual(f.skus, ['ABC']);
    assert.equal(f.orderCount, 1);
    assert.deepEqual(f.orderDates, ['2026-09-02T00:00:00Z']);
  });

  it('survives an event whose evidence is missing or malformed', () => {
    accrue({ evidence: null });
    assert.doesNotThrow(() => factsFor(db, GID));
    appendEvent(db, {
      customerGid: GID, kind: 'order_accrual', xpDelta: 1, source: 'shopify_order',
      sourceRef: 'gid://shopify/Order/9', evidence: '{broken',
    });
    const f = factsFor(db, GID);
    assert.equal(f.orderCount, 2, 'a bad evidence blob must not drop the order');
  });

  it('counts referrals and runs verification', () => {
    accrue();
    appendEvent(db, { customerGid: GID, kind: 'referral_referrer', xpDelta: 200, source: 'referral', sourceRef: 'r1' });
    appendEvent(db, { customerGid: GID, kind: 'badge_award', badgeId: 'mystery-keeper', source: 'runs', sourceRef: 'seal-1' });
    const f = factsFor(db, GID);
    assert.equal(f.referralCount, 1);
    assert.equal(f.runsVerified, true);
  });
});

describe('metafieldInputs', () => {
  it('produces the five metafields with string values in the keepers namespace', () => {
    accrue();
    const p = projectionFor(db, GID, { rankTable: RANKS, badges: BADGES, rules: RULES });
    const mf = metafieldInputs(p);
    assert.equal(mf.length, 5);
    for (const m of mf) {
      assert.equal(m.namespace, NAMESPACE);
      assert.equal(m.ownerId, GID);
      assert.equal(typeof m.value, 'string', `${m.key} must be a string`);
    }
    assert.equal(mf.find((m) => m.key === 'xp').value, '200');
    assert.deepEqual(JSON.parse(mf.find((m) => m.key === 'badges').value), ['first-pull', 'globetrotter']);
  });

  it('omits joined_at when there is none, rather than writing an empty date', () => {
    upsertCustomer(db, { customerGid: 'gid://shopify/Customer/2' });
    appendEvent(db, {
      customerGid: 'gid://shopify/Customer/2', kind: 'manual_grant', xpDelta: 10,
      source: 'admin', sourceRef: 'g1',
    });
    const p = projectionFor(db, 'gid://shopify/Customer/2', { rankTable: RANKS, badges: BADGES, rules: RULES });
    assert.equal(metafieldInputs(p).find((m) => m.key === 'joined_at'), undefined);
  });
});

describe('the lease — a second writer refuses rather than duels', () => {
  it('lets one holder in and keeps the other out', () => {
    assert.equal(acquireLease(db, 'A'), true);
    assert.equal(acquireLease(db, 'B'), false);
    assert.equal(acquireLease(db, 'A'), true, 'the holder can renew');
  });

  it('lets another holder in once the lease expires', () => {
    // Expiry rather than release-on-exit, because the case this guards is a process that died.
    const t0 = Date.parse('2026-09-06T00:00:00Z');
    acquireLease(db, 'A', { ttlSec: 60, nowMs: t0 });
    assert.equal(acquireLease(db, 'B', { nowMs: t0 + 30000 }), false);
    assert.equal(acquireLease(db, 'B', { nowMs: t0 + 90000 }), true);
  });

  it('release only clears the lease for its own holder', () => {
    acquireLease(db, 'A');
    releaseLease(db, 'B');
    assert.equal(acquireLease(db, 'C'), false, "B's release must not free A's lease");
  });
});

describe('projectDirty', () => {
  const run = (over = {}) => projectDirty({}, db, {
    rankTable: RANKS, badges: BADGES, rules: RULES,
    writer: async () => ({ ok: true }), ...over,
  });

  it('writes a dirty customer and records what it wrote', async () => {
    accrue();
    const r = await run();
    assert.equal(r.written, 1);
    const row = getCustomer(db, GID);
    assert.equal(row.dirty, 0);
    assert.equal(row.xp_written, 200);
    assert.equal(row.badges_written, 'first-pull,globetrotter');
  });

  it('skips a customer whose numbers have not moved', async () => {
    accrue();
    await run();
    markDirty(db, GID);                       // dirtied again, but nothing changed
    let calls = 0;
    const r = await run({ writer: async () => { calls++; return { ok: true }; } });
    assert.equal(calls, 0, 'an unchanged customer must not cost an API call');
    assert.equal(r.skipped, 1);
  });

  it('clears dirty without writing for a customer with no events', async () => {
    markDirty(db, GID);
    let calls = 0;
    const r = await run({ writer: async () => { calls++; return { ok: true }; } });
    assert.equal(calls, 0);
    assert.equal(r.skipped, 1);
    assert.equal(getCustomer(db, GID).dirty, 0);
  });

  it('REFUSES the whole run when the rank table is unusable', async () => {
    accrue();
    const r = await run({ rankTable: [] });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'rank_table_unusable');
    assert.equal(getCustomer(db, GID).dirty, 1, 'the customer stays queued');
  });

  it('REFUSES to write to live without the second switch', async () => {
    accrue();
    const r = await run({ store: 'live' });
    assert.equal(r.error, 'live_not_allowed');
    const ok = await run({ store: 'live', allowLive: true });
    assert.equal(ok.written, 1);
  });

  it('backs off on failure and NEVER clears dirty', async () => {
    accrue();
    const r = await run({ writer: async () => ({ ok: false, userErrors: [{ message: 'nope' }] }) });
    assert.equal(r.failed, 1);
    const row = getCustomer(db, GID);
    assert.equal(row.dirty, 1, 'a failed write must leave the customer queued');
    assert.equal(row.write_attempt, 1);
    assert.ok(row.next_write_at, 'backoff must be scheduled');
    assert.match(row.write_error, /nope/);
  });

  it('does not retry before the backoff expires', async () => {
    accrue();
    const t0 = Date.parse('2026-09-06T00:00:00Z');
    await run({ writer: async () => ({ ok: false }), nowMs: t0 });
    let calls = 0;
    await run({ writer: async () => { calls++; return { ok: true }; }, nowMs: t0 + 1000 });
    assert.equal(calls, 0, 'still inside the backoff');
    await run({ writer: async () => { calls++; return { ok: true }; }, nowMs: t0 + 7200000 });
    assert.equal(calls, 1, 'retried once the backoff passed');
  });

  it('treats a partial write as a failure, not a success', async () => {
    // shopifyGraphQL's ok already means no userErrors anywhere. This asserts we honour that.
    accrue();
    const r = await run({ writer: async () => ({ ok: false, userErrors: [{ field: 'badges', message: 'invalid' }] }) });
    assert.equal(r.written, 0);
    assert.equal(getCustomer(db, GID).dirty, 1);
  });

  it('does nothing when another holder owns the lease', async () => {
    accrue();
    acquireLease(db, 'someone-else');
    const r = await run({ holderId: 'me' });
    assert.equal(r.skippedRun, 'lease_held_elsewhere');
    assert.equal(r.written, 0);
    assert.equal(getCustomer(db, GID).dirty, 1);
  });
});

describe('projectionQueueDepth', () => {
  it('counts what is waiting — a number that only grows is the alarm', async () => {
    assert.equal(projectionQueueDepth(db), 0);
    accrue();
    assert.equal(projectionQueueDepth(db), 1);
    await projectDirty({}, db, { rankTable: RANKS, badges: BADGES, rules: RULES, writer: async () => ({ ok: true }) });
    assert.equal(projectionQueueDepth(db), 0);
  });
});
