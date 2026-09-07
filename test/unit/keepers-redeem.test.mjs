// test/unit/keepers-redeem.test.mjs — points into a discount code.
//
// Two things here are worth more than the rest put together:
//
//   debit-before-mint, because the alternative fails into a live code in the wild with no debit;
//   the eligibility echo, because a mutation that SUCCEEDS with the wrong shape is a store-wide money
//   leak that reports itself as a complete success.
//
// The Shopify calls are injected, so both are exercised offline.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  redemptionProblem, openRedemption, refundRedemption, mintRedemption, revokeRedemption,
  findMintedDiscount, mintTitle,
  CREATE_MUTATION, SEARCH_QUERY, READ_QUERY, DEACTIVATE_MUTATION,
  reconcileRedemptions,
  eligibleCustomerIds, eligibilityProblem, markUsedByOrder,
} from '../../lib/keepers-redeem.mjs';
import { openKeepersDbAt, upsertCustomer, appendEvent, ledgerTotals, withTransaction } from '../../lib/keepers-db.mjs';
import { driftReport } from '../../lib/keepers-reconcile.mjs';

const GID = 'gid://shopify/Customer/8675309';
const OTHER = 'gid://shopify/Customer/1111111';
const NOW = Date.parse('2026-09-06T00:00:00Z');

const TIER = { handle: 'tier-500', pointsCost: 500, percentOff: 5, label: '5% off' };
const RULES = { redemption_min_points: 500, redemption_expiry_days: 180, redemption_code_prefix: 'BK' };

let db;
beforeEach(() => {
  db = openKeepersDbAt(':memory:');
  upsertCustomer(db, { customerGid: GID });
  // 600 points to spend.
  appendEvent(db, {
    customerGid: GID, kind: 'order_accrual', xpDelta: 300, pointsDelta: 600,
    source: 'shopify_order', sourceRef: 'gid://shopify/Order/1', basisCents: 30000,
    rateXpPerDollar: 1, ratePointsPerDollar: 2,
  });
});

// A created node shaped the way Shopify returns one.
const node = (customerIds, over = {}) => ({
  id: 'gid://shopify/DiscountCodeNode/1',
  codeDiscount: {
    title: 'Keepers 5%', status: 'ACTIVE', asyncUsageCount: 0,
    codes: { nodes: [{ code: 'BK-ABCD-EFGH' }] },
    context: { customers: customerIds.map((id) => ({ id })) },
    ...over,
  },
});

describe('redemptionProblem', () => {
  it('allows a redemption the customer can afford', () => {
    assert.equal(redemptionProblem(db, { customerGid: GID, tier: TIER, rules: RULES }), null);
  });

  it('checks the LEDGER, not the projection cache', () => {
    // The cache is what we last wrote to Shopify and can be hours stale. Spending against it is how a
    // customer goes negative without ever being told.
    db.prepare('UPDATE keepers_customers SET points_written = 99999 WHERE customer_gid = ?').run(GID);
    const rich = { ...TIER, pointsCost: 5000 };
    assert.match(redemptionProblem(db, { customerGid: GID, tier: rich, rules: RULES }), /not enough points \(has 600/);
  });

  it('refuses below the configured floor', () => {
    const small = { ...TIER, pointsCost: 100 };
    assert.match(redemptionProblem(db, { customerGid: GID, tier: small, rules: RULES }), /below the 500-point minimum/);
  });

  it('refuses an unusable tier', () => {
    assert.match(redemptionProblem(db, { customerGid: GID, tier: null, rules: RULES }), /unknown tier/);
    assert.match(redemptionProblem(db, { customerGid: GID, tier: { pointsCost: 500, percentOff: 0 }, rules: RULES }), /unusable percentage/);
    assert.match(redemptionProblem(db, { customerGid: GID, tier: { pointsCost: 500, percentOff: 150 }, rules: RULES }), /unusable percentage/);
  });

  it('refuses a second open redemption', () => {
    withTransaction(db, () => openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }));
    assert.match(redemptionProblem(db, { customerGid: GID, tier: TIER, rules: RULES }), /already in progress/);
  });

  it('refuses an unknown customer', () => {
    assert.match(redemptionProblem(db, { customerGid: OTHER, tier: TIER, rules: RULES }), /unknown customer/);
  });
});

describe('openRedemption — the debit happens BEFORE Shopify is called', () => {
  it('takes the points and opens the row', () => {
    let r;
    withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    assert.equal(r.ok, true);
    assert.equal(ledgerTotals(db, GID).points, 100, '600 - 500');
    const row = db.prepare('SELECT * FROM keepers_redemptions WHERE id = ?').get(r.id);
    assert.equal(row.status, 'requested');
    assert.equal(row.points_cost, 500);
  });

  it('writes nothing when it refuses', () => {
    let r;
    withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: { ...TIER, pointsCost: 5000 }, rules: RULES }); });
    assert.equal(r.ok, false);
    assert.equal(ledgerTotals(db, GID).points, 600);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM keepers_redemptions').get().n, 0);
  });
});

describe('the eligibility echo — the entire security model', () => {
  it('accepts a code restricted to exactly our customer', () => {
    assert.equal(eligibilityProblem(node([GID]), GID), null);
    assert.deepEqual(eligibleCustomerIds(node([GID])), [GID]);
  });

  it('REFUSES a code with no customer restriction', () => {
    // This is the one that matters. A store-wide code is valid for everyone who finds the string, on
    // every order, and the mutation reports it as a complete success.
    assert.match(eligibilityProblem(node([]), GID), /NO customer restriction/);
    assert.match(eligibilityProblem({ codeDiscount: {} }, GID), /NO customer restriction/);
    assert.match(eligibilityProblem(null, GID), /NO customer restriction/);
  });

  it('refuses a code eligible for the WRONG customer', () => {
    assert.match(eligibilityProblem(node([OTHER]), GID), /eligible for gid:\/\/shopify\/Customer\/1111111/);
  });

  it('refuses a code eligible for more than one', () => {
    assert.match(eligibilityProblem(node([GID, OTHER]), GID), /eligible for 2 customers/);
  });
});

describe('mintRedemption', () => {
  const openOne = () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    return r.id;
  };

  // A fake shopifyGraphQL, injected by monkey-patching the module the same way the real one is called
  // is not possible here — so mintRedemption is exercised through its DB effects with a stub env that
  // makes the client refuse. What is fully covered offline is every DB transition it drives.
  it('refuses to mint a redemption that is not in the requested state', async () => {
    const id = openOne();
    db.prepare("UPDATE keepers_redemptions SET status='active' WHERE id=?").run(id);
    const out = await mintRedemption({}, db, id, { rules: RULES, store: 'dev', nowMs: NOW });
    assert.equal(out.ok, false);
    assert.match(out.reason, /not requested/);
  });

  it('refuses an unknown redemption', async () => {
    const out = await mintRedemption({}, db, 9999, { rules: RULES });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'unknown redemption');
  });

  it('REFUNDS the points when the mint fails', async () => {
    // Not configured, so shopifyGraphQL refuses without a network call.
    const id = openOne();
    assert.equal(ledgerTotals(db, GID).points, 100);
    const out = await mintRedemption({}, db, id, { rules: RULES, store: 'dev', nowMs: NOW });
    assert.equal(out.ok, false);
    assert.equal(ledgerTotals(db, GID).points, 600, 'the debit is compensated, not mutated');
    assert.equal(db.prepare('SELECT status FROM keepers_redemptions WHERE id=?').get(id).status, 'failed');
  });

  it('leaves the debit row in place and adds a refund row — append-only', async () => {
    const id = openOne();
    await mintRedemption({}, db, id, { rules: RULES, store: 'dev', nowMs: NOW });
    const kinds = db.prepare("SELECT kind FROM keepers_events WHERE source='redemption' ORDER BY id").all().map((r) => r.kind);
    assert.deepEqual(kinds, ['redemption_debit', 'redemption_refund'], 'the pair of them is the story');
  });
});

describe('refundRedemption', () => {
  it('is idempotent — a retried refund does not pay twice', () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    refundRedemption(db, r.id, { nowMs: NOW });
    const again = refundRedemption(db, r.id, { nowMs: NOW });
    assert.equal(again.already, true);
    assert.equal(ledgerTotals(db, GID).points, 600);
  });

  it('refuses an unknown redemption', () => {
    assert.equal(refundRedemption(db, 9999).ok, false);
  });
});

describe('markUsedByOrder — the second, independent reading', () => {
  it('marks an active code used, however the code was cased', () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    db.prepare("UPDATE keepers_redemptions SET status='active', code='BK-ABCD-EFGH' WHERE id=?").run(r.id);

    assert.equal(markUsedByOrder(db, 'bk-abcd-efgh', 'gid://shopify/Order/5', { nowMs: NOW }), 1);
    const row = db.prepare('SELECT status, used_order_gid FROM keepers_redemptions WHERE id=?').get(r.id);
    assert.equal(row.status, 'used');
    assert.equal(row.used_order_gid, 'gid://shopify/Order/5');
  });

  it('does not resurrect an expired or revoked code', () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    db.prepare("UPDATE keepers_redemptions SET status='expired', code='BK-X' WHERE id=?").run(r.id);
    assert.equal(markUsedByOrder(db, 'BK-X', 'gid://shopify/Order/5'), 0);
  });

  it('ignores a code we never minted', () => {
    assert.equal(markUsedByOrder(db, 'WELCOME10', 'gid://shopify/Order/5'), 0);
  });
});

// --- a create that FAILED is not proof that nothing was created ----------------------------------
//
// THE BUG THIS EXISTS TO PREVENT. shopifyGraphQL returns ok:false for a network failure, a 30s abort
// and a userError alike, so a create that COMMITTED on Shopify before its response was lost is
// indistinguishable, from inside this function, from one that never happened. It used to be read as
// the latter: mark the row failed, refund the points — while a live, correctly-scoped, single-use
// code sat on the store that no row, no query and no sweep in this repo could name. The customer had
// their points back AND a spendable code, and since 'failed' is not in uq_kr_open they could
// immediately mint another. Same points, two rewards.
//
// The Shopify client is INJECTED below, and that is what makes any of this testable. Before it, the
// only branch reachable offline was 'not_configured', so every recovery path here would have shipped
// unexercised — the exact shape of gap this file's own header warns about.
describe('mintRedemption — a lost response, and the code that outlives it', () => {
  const openOne = () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    return r.id;
  };
  const row = (id) => db.prepare('SELECT * FROM keepers_redemptions WHERE id=?').get(id);

  // Sent, and the answer never came back. attempts >= 1 is what says "this left the machine".
  const LOST = { ok: false, attempts: 1, errors: [{ code: 'network', message: 'socket hang up' }] };
  // Never left the machine: no credentials, no request, nothing to look for afterwards.
  const NEVER_SENT = { ok: false, attempts: 0, errors: [{ code: 'not_configured', message: 'no creds' }] };

  const node = (code, over = {}) => ({
    id: 'gid://shopify/DiscountCodeNode/1',
    codeDiscount: {
      title: 't', status: 'ACTIVE', endsAt: '2027-01-01T00:00:00Z', asyncUsageCount: 0,
      codes: { nodes: [{ code }] },
      context: { customers: [{ id: GID }] },
      ...over,
    },
  });
  const searchHit = (code, over) => ({ ok: true, attempts: 1, data: { codeDiscountNodes: { nodes: [node(code, over)] } } });
  const searchMiss = { ok: true, attempts: 1, data: { codeDiscountNodes: { nodes: [] } } };

  /** Routes each call by the query it was handed, so a test can answer create and search differently. */
  const client = ({ create, search, read, deactivate }) => {
    const calls = [];
    const fn = async (env, q, vars) => {
      if (q === CREATE_MUTATION) { calls.push('create'); return typeof create === 'function' ? create(vars) : create; }
      if (q === SEARCH_QUERY) { calls.push('search'); return typeof search === 'function' ? search(vars) : search; }
      if (q === READ_QUERY) { calls.push('read'); return read; }
      if (q === DEACTIVATE_MUTATION) { calls.push('deactivate'); return deactivate || { ok: true }; }
      throw new Error('unexpected query');
    };
    fn.calls = calls;
    return fn;
  };

  it('writes the code BEFORE calling Shopify, so a lost response is still findable', async () => {
    const id = openOne();
    let onDiskAtCallTime = null;
    const g = client({ create: () => { onDiskAtCallTime = row(id).code; return NEVER_SENT; }, search: searchMiss });
    await mintRedemption({}, db, id, { rules: RULES, nowMs: NOW, graphql: g });
    assert.ok(onDiskAtCallTime, 'the code must be on the row before the create, or it can never be recovered');
    assert.match(onDiskAtCallTime, /^BK-/);
  });

  it('a lost response whose code DID land is adopted, and the points stay spent', async () => {
    const id = openOne();
    const g = client({ create: LOST, search: (vars) => searchHit(row(id).code) });
    const out = await mintRedemption({}, db, id, { rules: RULES, nowMs: NOW, graphql: g });

    assert.equal(out.ok, true, 'the code exists on Shopify — the customer must be told it is theirs');
    assert.equal(out.recovered, true, 'a recovered mint is surfaced, not swallowed: it means a round trip was lost');
    assert.equal(row(id).status, 'active');
    assert.equal(row(id).discount_gid, 'gid://shopify/DiscountCodeNode/1');
    assert.equal(ledgerTotals(db, GID).points, 100, 'refunding here would be paying twice for one code');
    assert.deepEqual(g.calls, ['create', 'search']);
  });

  it('a lost response whose code did NOT land refunds, as it always should have', async () => {
    const id = openOne();
    const g = client({ create: LOST, search: searchMiss });
    const out = await mintRedemption({}, db, id, { rules: RULES, nowMs: NOW, graphql: g });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'create_failed');
    assert.equal(row(id).status, 'failed');
    assert.equal(ledgerTotals(db, GID).points, 600, 'nothing was created, so the debit must come back');
  });

  it('when the SEARCH also fails it refuses to decide — no refund, still minting', async () => {
    // The distinction the whole fix rests on. "Not created" and "cannot tell" must never share a
    // branch: one justifies handing points back, the other justifies refusing to guess. Refunding
    // here could pay out for a code that is live; marking it failed would bury it.
    const id = openOne();
    const g = client({ create: LOST, search: { ok: false, attempts: 1, errors: [{ code: 'network' }] } });
    const out = await mintRedemption({}, db, id, { rules: RULES, nowMs: NOW, graphql: g });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'mint_unverifiable');
    assert.equal(row(id).status, 'minting', 'the row stays resolvable — revoke can settle it later');
    assert.ok(row(id).code, 'and it keeps the code, which is the handle revoke will search on');
    assert.equal(ledgerTotals(db, GID).points, 100, 'points must NOT come back while a code may be live');
  });

  it('a request that never left the machine refunds WITHOUT searching', async () => {
    // attempts: 0 means no HTTP happened, so there is nothing on Shopify to find. Making an operator
    // resolve a wedged row because credentials were missing would be a worse outcome than the bug.
    const id = openOne();
    const g = client({ create: NEVER_SENT, search: searchMiss });
    const out = await mintRedemption({}, db, id, { rules: RULES, nowMs: NOW, graphql: g });
    assert.equal(out.ok, false);
    assert.equal(row(id).status, 'failed');
    assert.equal(ledgerTotals(db, GID).points, 600);
    assert.deepEqual(g.calls, ['create'], 'no search — the request never went out');
  });

  it('a RECOVERED code still has to pass the eligibility echo', async () => {
    // An orphan is still a code, and a store-wide one is the money leak this module exists to stop.
    // Recovery must not become a way around the check that matters most.
    const id = openOne();
    const g = client({ create: LOST, search: () => searchHit(row(id).code, { context: { customers: [] } }) });
    const out = await mintRedemption({}, db, id, { rules: RULES, nowMs: NOW, graphql: g });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'eligibility_mismatch');
    assert.ok(g.calls.includes('deactivate'), 'a store-wide code must be killed, not merely reported');
    assert.equal(ledgerTotals(db, GID).points, 600, 'the code is dead, so the points come back');
  });
});

describe('revokeRedemption — a row wedged at minting', () => {
  const openOne = () => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOW }); });
    return r.id;
  };
  const row = (id) => db.prepare('SELECT * FROM keepers_redemptions WHERE id=?').get(id);
  /** The state a crash between the create and the commit leaves: minting, code on it, no gid. */
  const wedge = (id) => db.prepare("UPDATE keepers_redemptions SET status='minting', code='BK-WEDG-EDXX' WHERE id=?").run(id);

  const client = ({ search, read, deactivate }) => {
    const calls = [];
    const fn = async (env, q) => {
      if (q === SEARCH_QUERY) { calls.push('search'); return search; }
      if (q === READ_QUERY) { calls.push('read'); return read; }
      if (q === DEACTIVATE_MUTATION) { calls.push('deactivate'); return deactivate || { ok: true }; }
      throw new Error('unexpected query');
    };
    fn.calls = calls;
    return fn;
  };
  const found = {
    ok: true,
    data: { codeDiscountNodes: { nodes: [{ id: 'gid://shopify/DiscountCodeNode/9',
      codeDiscount: { codes: { nodes: [{ code: 'BK-WEDG-EDXX' }] }, context: { customers: [{ id: GID }] } } }] } },
  };

  it('asks Shopify about the code before refunding anything', async () => {
    // It used to skip every check below, because the usage read lived inside `if (r.discount_gid)`
    // and a wedged row has no gid BY CONSTRUCTION — the UPDATE that would set it is the step that did
    // not run. So revoke refunded with zero Shopify calls while a live code sat on the store. Worse,
    // keepers.html NAMES revoke as the fix for a wedged row, so the operator is led down that path.
    const id = openOne();
    wedge(id);
    const g = client({ search: found, read: { ok: true, data: { codeDiscountNode: { codeDiscount: { asyncUsageCount: 0 } } } } });
    const out = await revokeRedemption({}, db, id, { nowMs: NOW, graphql: g });
    assert.equal(out.ok, true);
    assert.deepEqual(g.calls, ['search', 'read', 'deactivate'],
      'the found code must go through the SAME usage read and deactivate as any other');
    assert.equal(row(id).status, 'revoked');
    assert.equal(ledgerTotals(db, GID).points, 600);
  });

  it('refuses when the search fails — it cannot tell whether a code is live', async () => {
    const id = openOne();
    wedge(id);
    const g = client({ search: { ok: false, errors: [{ code: 'network' }] } });
    const out = await revokeRedemption({}, db, id, { nowMs: NOW, graphql: g });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'usage_unreadable');
    assert.equal(out.wedged, true);
    assert.equal(ledgerTotals(db, GID).points, 100, 'a refund we cannot justify is money out the door');
  });

  it('a wedged code that was already SPENT is recorded as used, not revoked', async () => {
    const id = openOne();
    wedge(id);
    const g = client({ search: found, read: { ok: true, data: { codeDiscountNode: { codeDiscount: { asyncUsageCount: 1 } } } } });
    const out = await revokeRedemption({}, db, id, { nowMs: NOW, graphql: g });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'already used');
    assert.equal(row(id).status, 'used');
    assert.equal(ledgerTotals(db, GID).points, 100, 'it was spent — the points are gone, correctly');
  });

  it("a 'requested' row still needs no Shopify call at all", async () => {
    // The half that must NOT change: nothing was ever sent for a requested row and it carries no
    // code, so there is nothing to ask about. Gating or delaying it would strand a customer's points.
    const id = openOne();
    const g = client({});
    const out = await revokeRedemption({}, db, id, { nowMs: NOW, graphql: g });
    assert.equal(out.ok, true);
    assert.deepEqual(g.calls, [], 'no Shopify call for a row that never reached Shopify');
    assert.equal(ledgerTotals(db, GID).points, 600);
  });
});

// --- expiry waits, and the disagreement is heard ---------------------------------------------------
//
// TWO BUGS, both found by auditing this path before exercising it, and both of a kind this file is
// the right place to pin: a reading acted on too early, and an alarm nobody could hear.
describe('reconcileRedemptions — the grace window and the alarm', () => {
  const NOWMS = Date.parse('2026-09-06T12:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();

  /** An active, minted redemption expiring at `expiresMs`. */
  const seed = (expiresMs, over = {}) => {
    let r; withTransaction(db, () => { r = openRedemption(db, { customerGid: GID, tier: TIER, rules: RULES, nowMs: NOWMS }); });
    db.prepare(`UPDATE keepers_redemptions
                SET status='active', code=?, discount_gid=?, expires_at=?, used_order_gid=?
                WHERE id=?`)
      .run(over.code || 'BK-EXPY-0001', 'gid://shopify/DiscountCodeNode/7', iso(expiresMs), over.usedOrderGid || null, r.id);
    return r.id;
  };
  const row = (id) => db.prepare('SELECT * FROM keepers_redemptions WHERE id=?').get(id);
  /** A Shopify client answering READ_QUERY with a fixed usage count. */
  const seeing = (count) => async () => ({ ok: true, data: { codeDiscountNode: { codeDiscount: { asyncUsageCount: count } } } });

  it('does NOT expire or refund a code that only just passed its endsAt', () => {
    // The bug: asyncUsageCount is asynchronous and this sweep runs every 30 minutes, so a code spent
    // shortly before endsAt can still read 0 here. Acting on that reading refunded the points for a
    // code that HAD been spent, and nothing could correct it afterwards — 'expired' is excluded from
    // this scan and from markUsedByOrder alike.
    const id = seed(NOWMS - 60_000);           // expired one minute ago
    const before = ledgerTotals(db, GID).points;
    return reconcileRedemptions({}, db, { rules: RULES, nowMs: NOWMS, graphql: seeing(0) }).then((out) => {
      assert.equal(row(id).status, 'active', 'it must stay active so a late reading can still land');
      assert.equal(out.expired, 0);
      assert.equal(out.refunded, 0);
      assert.equal(out.awaitingGrace, 1, 'and be counted, so patience does not read as a stalled sweep');
      assert.equal(ledgerTotals(db, GID).points, before);
    });
  });

  it('a late asyncUsageCount inside the window still catches it — which is the point of waiting', async () => {
    const id = seed(NOWMS - 60_000);
    const before = ledgerTotals(db, GID).points;
    const out = await reconcileRedemptions({}, db, { rules: RULES, nowMs: NOWMS, graphql: seeing(1) });
    assert.equal(row(id).status, 'used', 'the row was still in the scan, so the lagging count reached it');
    assert.equal(out.refunded, 0);
    assert.equal(ledgerTotals(db, GID).points, before, 'it was spent — the points are gone, correctly');
  });

  it('expires and refunds once the window has passed with nothing said', async () => {
    const id = seed(NOWMS - 2 * 60 * 60_000);   // two hours past, default grace is one
    const before = ledgerTotals(db, GID).points;
    const out = await reconcileRedemptions({}, db, { rules: RULES, nowMs: NOWMS, graphql: seeing(0) });
    assert.equal(row(id).status, 'expired');
    assert.equal(out.expired, 1);
    assert.equal(out.refunded, 1);
    assert.equal(ledgerTotals(db, GID).points, before + TIER.pointsCost, 'unused and truly expired — give them back');
  });

  it('the window is configurable, and zero means the old behaviour on purpose', async () => {
    const id = seed(NOWMS - 60_000);
    const out = await reconcileRedemptions({}, db,
      { rules: { ...RULES, redemption_expiry_grace_min: 0 }, nowMs: NOWMS, graphql: seeing(0) });
    assert.equal(row(id).status, 'expired', 'a grace of 0 is a deliberate choice, not an ignored setting');
    assert.equal(out.expired, 1);
  });

  it('an unreadable grace setting falls back to the default rather than to zero', async () => {
    // Falling back to 0 would silently restore the bug the moment somebody typed a bad value.
    const id = seed(NOWMS - 60_000);
    await reconcileRedemptions({}, db,
      { rules: { ...RULES, redemption_expiry_grace_min: 'soon' }, nowMs: NOWMS, graphql: seeing(0) });
    assert.equal(row(id).status, 'active');
  });

  it('a disagreement is recorded, warned about, AND left in a state the drift report can see', async () => {
    // "Their disagreement is the alarm" — but the array was returned to callers that dropped it, and
    // driftReport had no redemption term, so nothing could hear it. The durable half is the STATE:
    // used, with no order of ours claiming it.
    const id = seed(NOWMS + 86_400_000);        // not near expiry; this is about usage, not time
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    let out;
    try { out = await reconcileRedemptions({}, db, { rules: RULES, nowMs: NOWMS, graphql: seeing(1) }); }
    finally { console.warn = realWarn; }

    assert.equal(out.disagreements.length, 1);
    assert.equal(out.disagreements[0].id, id);
    assert.ok(warned.some((w) => /spent on Shopify but no order of ours claims it/.test(w)),
      'a returned array nobody reads is not an alarm — it has to say something out loud too');

    const drift = driftReport(db);
    assert.equal(drift.counts.redemptions_unexplained, 1,
      'and the state must be visible in the report /api/status publishes');
    assert.equal(drift.redemptionsUnexplained[0].id, id);
  });

  it('a redemption used on an order WE recorded is not a disagreement', () => {
    // The negative half. If this counted, the alarm would fire on every normal redemption and be
    // ignored within a week.
    const id = seed(NOWMS + 86_400_000, { usedOrderGid: 'gid://shopify/Order/99' });
    return reconcileRedemptions({}, db, { rules: RULES, nowMs: NOWMS, graphql: seeing(1) }).then((out) => {
      assert.equal(out.disagreements.length, 0);
      assert.equal(row(id).status, 'used');
      assert.equal(driftReport(db).counts.redemptions_unexplained, 0);
    });
  });

  it('an unexplained redemption does NOT make the drift report unclean', async () => {
    // Deliberate: `clean` holds the reconcile cursor, and holding it would stop the only sweep able
    // to resolve anything else. One unexplained redemption must not freeze every accrual behind it.
    seed(NOWMS + 86_400_000);
    // Compared BEFORE against AFTER rather than asserted absolutely. This file's harness seeds an
    // accrual with no matching order row, so `clean` is already false here for a reason that has
    // nothing to do with redemptions — what matters is that the disagreement does not MOVE it.
    const cleanBefore = driftReport(db).clean;
    const realWarn = console.warn; console.warn = () => {};
    try { await reconcileRedemptions({}, db, { rules: RULES, nowMs: NOWMS, graphql: seeing(1) }); }
    finally { console.warn = realWarn; }
    const drift = driftReport(db);
    assert.equal(drift.counts.redemptions_unexplained, 1);
    assert.equal(drift.clean, cleanBefore, 'visible, but not a reason to stop the sweep');
  });
});
