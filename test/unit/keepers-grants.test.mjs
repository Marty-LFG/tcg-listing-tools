// test/unit/keepers-grants.test.mjs — awarding by hand.
//
// The manual path exists because every automated earn action can fail in a way that leaves a real
// customer short, and "sorry, nothing I can do" is a worse answer than the bug that caused it.
//
// So the tests are mostly about the two ways a hand-typed grant goes wrong: the same grant landing
// twice, and a slipped keypress turning 50 into 5000.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  grant, grantProblem, grantBadge, customerLedger, findCustomers,
  GRANT_REASONS, DEFAULT_MAX_GRANT,
} from '../../lib/keepers-grants.mjs';
import {
  openKeepersDbAt, upsertCustomer, appendEvent, ledgerTotals, ledgerBadges, getCustomer,
} from '../../lib/keepers-db.mjs';

const GID = 'gid://shopify/Customer/8675309';
const OTHER = 'gid://shopify/Customer/1111111';

let db;
beforeEach(() => {
  db = openKeepersDbAt(':memory:');
  upsertCustomer(db, { customerGid: GID, joinedAt: '2026-09-01T00:00:00Z' });
});

const ok = { customerGid: GID, xp: 50, points: 0, reason: 'goodwill', idempotencyKey: 'k1' };

describe('grantProblem — refusals the form can show before the button is pressed', () => {
  it('passes a well-formed grant', () => {
    assert.equal(grantProblem(ok), null);
  });

  it('REQUIRES an idempotency key rather than generating one', () => {
    // Generating one would make every retry a fresh grant — exactly the failure the key exists to
    // stop. A grant form is a button pressed on a phone, at a table, on bad wifi.
    assert.match(grantProblem({ ...ok, idempotencyKey: '' }), /idempotency key is required/);
    assert.match(grantProblem({ ...ok, idempotencyKey: undefined }), /idempotency key is required/);
  });

  it('requires a known reason', () => {
    assert.match(grantProblem({ ...ok, reason: 'because' }), /reason must be one of/);
    assert.match(grantProblem({ ...ok, reason: undefined }), /reason must be one of/);
    for (const r of Object.keys(GRANT_REASONS)) assert.equal(grantProblem({ ...ok, reason: r }), null, r);
  });

  it('caps a single grant, so a slipped keypress is refused rather than reversed later', () => {
    assert.match(grantProblem({ ...ok, xp: DEFAULT_MAX_GRANT + 1 }), /capped at/);
    assert.match(grantProblem({ ...ok, xp: 0, points: -5000 }), /capped at/);
    assert.equal(grantProblem({ ...ok, xp: DEFAULT_MAX_GRANT }), null);
    assert.equal(grantProblem({ ...ok, xp: 5000, maxGrant: 10000 }), null, 'overridable for a deliberate exception');
  });

  it('refuses fractional and empty grants', () => {
    assert.match(grantProblem({ ...ok, xp: 1.5 }), /whole numbers/);
    assert.match(grantProblem({ ...ok, xp: 0, points: 0 }), /nothing to grant/);
  });

  it('refuses with no customer', () => {
    assert.match(grantProblem({ ...ok, customerGid: null }), /no customer/);
  });
});

describe('grant', () => {
  it('awards and records the reason on the event', () => {
    const r = grant(db, ok);
    assert.equal(r.ok, true);
    assert.equal(r.already, false);
    assert.deepEqual(ledgerTotals(db, GID), { xp: 50, points: 0, events: 1 });
    const ev = db.prepare('SELECT kind, note, evidence FROM keepers_events').get();
    assert.equal(ev.kind, 'manual_grant');
    assert.equal(JSON.parse(ev.evidence).reason, 'goodwill');
    assert.ok(ev.note, 'a grant nobody can explain later is a number nobody can defend');
  });

  it('is idempotent on the key — a second press is a SUCCESS, not an error', () => {
    grant(db, ok);
    const again = grant(db, ok);
    assert.equal(again.ok, true, 'the intended effect is in place, which is what the caller wanted');
    assert.equal(again.already, true);
    assert.deepEqual(ledgerTotals(db, GID), { xp: 50, points: 0, events: 1 });
  });

  it('treats a different key as a different grant', () => {
    grant(db, ok);
    grant(db, { ...ok, idempotencyKey: 'k2' });
    assert.equal(ledgerTotals(db, GID).xp, 100);
  });

  it('files a negative grant as a CORRECTION, through the same door', () => {
    // A correction goes through the same audit trail as an award rather than a quiet back channel.
    const r = grant(db, { ...ok, xp: -20, reason: 'correction', idempotencyKey: 'fix1' });
    assert.equal(r.ok, true);
    assert.equal(db.prepare("SELECT kind FROM keepers_events WHERE source_ref='fix1'").get().kind, 'correction');
    assert.equal(ledgerTotals(db, GID).xp, -20);
  });

  it('creates the customer if this is the first thing that ever happened to them', () => {
    grant(db, { ...ok, customerGid: OTHER, idempotencyKey: 'new1' });
    assert.ok(getCustomer(db, OTHER));
  });

  it('writes nothing at all when it refuses', () => {
    const r = grant(db, { ...ok, idempotencyKey: '' });
    assert.equal(r.ok, false);
    assert.equal(ledgerTotals(db, GID).events, 0);
  });

  it('marks the customer dirty so the projection picks it up', () => {
    grant(db, ok);
    assert.equal(getCustomer(db, GID).dirty, 1);
  });
});

describe('grantBadge — the escape hatch for a rule that cannot fire', () => {
  it('awards once, and a repeat is a success', () => {
    const a = grantBadge(db, { customerGid: GID, badgeId: 'grade-school' });
    const b = grantBadge(db, { customerGid: GID, badgeId: 'grade-school' });
    assert.equal(a.already, false);
    assert.equal(b.already, true);
    assert.deepEqual(ledgerBadges(db, GID), ['grade-school']);
  });

  it('is indistinguishable from an earned badge afterwards, which is correct', () => {
    // To the customer they are the same thing.
    grantBadge(db, { customerGid: GID, badgeId: 'first-pull' });
    assert.ok(ledgerBadges(db, GID).includes('first-pull'));
  });

  it('refuses without a customer or a badge id', () => {
    assert.equal(grantBadge(db, { customerGid: null, badgeId: 'x' }).ok, false);
    assert.equal(grantBadge(db, { customerGid: GID, badgeId: '  ' }).ok, false);
  });
});

describe('customerLedger — what the admin looks at when a number is questioned', () => {
  it('shows held and void events, not just applied ones', () => {
    // A held referral and a voided one are exactly what someone is looking at when they ask why a
    // number is not what they expected. Hiding them turns an explainable answer into a mystery.
    grant(db, ok);
    appendEvent(db, { customerGid: GID, kind: 'referral_referrer', xpDelta: 200, source: 'referral', sourceRef: 'r1', status: 'held', holdUntil: '2099-01-01T00:00:00Z' });
    appendEvent(db, { customerGid: GID, kind: 'manual_grant', xpDelta: 999, source: 'admin', sourceRef: 'v1', status: 'void' });

    const l = customerLedger(db, GID);
    assert.equal(l.events.length, 3);
    assert.equal(l.totals.xp, 50, 'only applied events count towards the total');
    assert.equal(l.totals.held, 1);
    assert.equal(l.totals.void, 1);
  });

  it('shows what was last WRITTEN next to what the ledger says', () => {
    // A projection that has silently stalled looks perfectly fine from the storefront. This diff is
    // the only place it shows.
    grant(db, ok);
    const l = customerLedger(db, GID);
    assert.equal(l.totals.xp, 50);
    assert.equal(l.customer.written.xp, null, 'nothing written yet');
    assert.equal(l.customer.dirty, true);
  });

  it('returns null for a customer that does not exist', () => {
    assert.equal(customerLedger(db, 'gid://shopify/Customer/404'), null);
  });
});

describe('findCustomers — searchable by what we are allowed to hold', () => {
  beforeEach(() => {
    db.prepare("UPDATE keepers_customers SET referral_code = 'BK-7K4M-QX92' WHERE customer_gid = ?").run(GID);
    upsertCustomer(db, { customerGid: OTHER });
  });

  it('finds by numeric id, gid and referral code', () => {
    assert.equal(findCustomers(db, '8675309').length, 1);
    assert.equal(findCustomers(db, GID).length, 1);
    assert.equal(findCustomers(db, 'BK-7K4M-QX92')[0].customer_gid, GID);
    assert.equal(findCustomers(db, 'bk7k4mqx92')[0].customer_gid, GID, 'however it was typed');
  });

  it('lists recent customers when the box is empty', () => {
    assert.equal(findCustomers(db, '').length, 2);
  });

  it('finds nothing for an unmatched query rather than everything', () => {
    assert.equal(findCustomers(db, 'zzzznotacustomer').length, 0);
  });
});
