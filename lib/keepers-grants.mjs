// lib/keepers-grants.mjs — awarding by hand, and correcting what the engine got wrong.
//
// Every automated earn action can fail in a way that leaves a real customer short: a webhook that
// never arrived and a sweep that could not reach the order, a show check-in on a phone with no
// signal, a review that Judge.me never marked verified. Without a manual path those become "sorry,
// nothing I can do", which is a worse answer than the bug that caused them.
//
// This is also the ONLY earn path for anything the engine cannot see at all — a goodwill gesture, a
// prize at a show, an apology after a mis-shipped order.
//
// THE IDEMPOTENCY KEY IS REQUIRED, NOT OPTIONAL. A grant form is a button someone clicks while
// looking at a customer, on a phone, at a table, possibly on bad wifi. Double-clicking it, or
// retrying after a request that appeared to hang, must not award twice — and the caller cannot be
// trusted to remember that, so the signature refuses without a key rather than generating one. A
// generated key would make every retry a fresh grant, which is exactly the failure it exists to stop.
//
// GRANTS ARE LEDGER EVENTS LIKE ANY OTHER. They reverse, they project, they show up in the customer's
// history with their reason attached. There is no separate "adjustments" concept, because a second
// place where XP comes from is a second place that has to be reconciled.
import { appendEvent, upsertCustomer, markDirty, getCustomer } from './keepers-db.mjs';

// A grant that cannot be explained later is a number nobody can defend. The reason is stored on the
// event and shown in the customer's own history, so it has to read as something a customer could see.
export const GRANT_REASONS = Object.freeze({
  goodwill: 'a gesture — an apology, a delay, a mix-up',
  missed_checkin: 'they checked in at a show and it did not register',
  missed_review: 'they left a review the engine did not pick up',
  missed_order: 'an order that should have accrued and did not',
  prize: 'won something at a show or online',
  correction: 'fixing an earlier mistake by us',
});

// Deliberately modest. This is a hand-typed number on a form; a slipped keypress turning 50 into 5000
// should be refused rather than reversed later, and anything genuinely larger deserves a conversation
// rather than a text field. Overridable per call for the rare deliberate exception.
export const DEFAULT_MAX_GRANT = 1000;

/**
 * grantProblem — every refusal, in one place.
 *
 * Returns a reason string or null. Kept separate from the write so the admin form can show the
 * refusal before the button is pressed rather than after.
 */
export function grantProblem({ customerGid, xp = 0, points = 0, reason, idempotencyKey, maxGrant = DEFAULT_MAX_GRANT }) {
  if (!customerGid) return 'no customer';
  if (!idempotencyKey) return 'an idempotency key is required — a double-clicked grant must not award twice';
  if (!GRANT_REASONS[reason]) return `reason must be one of ${Object.keys(GRANT_REASONS).join('|')}`;

  const x = Number(xp); const p = Number(points);
  if (!Number.isInteger(x) || !Number.isInteger(p)) return 'xp and points must be whole numbers';
  if (x === 0 && p === 0) return 'nothing to grant';
  // A negative grant is a correction and is allowed — but it goes through the same door, with the
  // same reason and the same audit trail, rather than through a quiet back channel.
  if (Math.abs(x) > maxGrant || Math.abs(p) > maxGrant) {
    return `a single grant is capped at ${maxGrant} — a slipped keypress should be refused, not reversed later`;
  }
  return null;
}

/**
 * grant — award (or correct) by hand.
 *
 * Returns { ok, granted, already } where `already: true` means the idempotency key had been used
 * before. That is a SUCCESS, not an error: the intended effect is in place, which is what the caller
 * actually wanted to know.
 *
 * The caller supplies the transaction.
 */
export function grant(db, {
  customerGid, xp = 0, points = 0, reason, idempotencyKey, note = null,
  actor = 'admin', maxGrant = DEFAULT_MAX_GRANT, nowMs = Date.now(),
}) {
  const problem = grantProblem({ customerGid, xp, points, reason, idempotencyKey, maxGrant });
  if (problem) return { ok: false, reason: problem };

  upsertCustomer(db, { customerGid });
  const ev = appendEvent(db, {
    customerGid,
    // A correction is its own kind so it reads differently in a customer's history from an award.
    kind: (Number(xp) < 0 || Number(points) < 0) ? 'correction' : 'manual_grant',
    xpDelta: Math.trunc(Number(xp)), pointsDelta: Math.trunc(Number(points)),
    source: 'admin', sourceRef: String(idempotencyKey),
    occurredAt: new Date(nowMs).toISOString(),
    note: note || GRANT_REASONS[reason],
    evidence: { reason, actor, note: note || null },
  });

  return {
    ok: true,
    already: !ev.inserted,
    granted: { xp: Math.trunc(Number(xp)), points: Math.trunc(Number(points)) },
    reason,
  };
}

/**
 * grantBadge — award a badge by hand.
 *
 * The escape hatch for the badges whose rule cannot fire: grade-school with no PREGRADE SKU family
 * configured, or any badge earned somewhere the engine cannot see. Once-only per customer through the
 * uq_kev_badge index, the same as an automatic award, so a hand-granted badge and an earned one are
 * indistinguishable afterwards — which is correct, because to the customer they are.
 */
export function grantBadge(db, { customerGid, badgeId, actor = 'admin', note = null, nowMs = Date.now() }) {
  if (!customerGid) return { ok: false, reason: 'no customer' };
  const id = String(badgeId || '').trim();
  if (!id) return { ok: false, reason: 'no badge id' };

  upsertCustomer(db, { customerGid });
  const ev = appendEvent(db, {
    customerGid, kind: 'badge_award', badgeId: id,
    source: 'admin', sourceRef: `badge:${id}:${customerGid}`,
    occurredAt: new Date(nowMs).toISOString(),
    note: note || `granted by ${actor}`,
    evidence: { actor, manual: true },
  });
  return { ok: true, already: !ev.inserted, badgeId: id };
}

/**
 * customerLedger — one customer's whole history, for the admin.
 *
 * Includes held and void events deliberately. A held referral and a voided one are exactly what
 * someone is looking at when they ask why a number is not what they expected, and hiding them turns
 * an explainable answer into a mystery.
 */
export function customerLedger(db, customerGid, { limit = 200 } = {}) {
  const row = getCustomer(db, customerGid);
  if (!row) return null;
  const events = db.prepare(`
    SELECT id, kind, xp_delta, points_delta, badge_id, source, source_ref, basis_cents,
           rate_xp_per_dollar, occurred_at, recorded_at, status, hold_until, note
    FROM keepers_events WHERE customer_gid = ? ORDER BY id DESC LIMIT ?
  `).all(String(customerGid), limit);

  const applied = events.filter((e) => e.status === 'applied');
  return {
    customer: {
      customerGid: row.customer_gid,
      handle: row.handle,
      joinedAt: row.joined_at,
      referralCode: row.referral_code,
      dirty: Boolean(row.dirty),
      writeError: row.write_error,
      // What we last WROTE to Shopify, next to what the ledger says — the diff is the whole point of
      // this view, because a projection that has silently stalled looks fine from the storefront.
      written: {
        xp: row.xp_written, points: row.points_written, level: row.level_written,
        badges: row.badges_written, at: row.written_at,
      },
    },
    totals: {
      xp: applied.reduce((a, e) => a + Number(e.xp_delta || 0), 0),
      points: applied.reduce((a, e) => a + Number(e.points_delta || 0), 0),
      events: events.length,
      held: events.filter((e) => e.status === 'held').length,
      void: events.filter((e) => e.status === 'void').length,
    },
    events,
  };
}

/**
 * findCustomers — the admin's search box.
 *
 * Matches on the customer gid, the numeric id, or a referral code, and NOT on a name or an email —
 * because under D-022 we may not hold either, and a search that works on dev and returns nothing on
 * live is worse than one that never promised it.
 */
export function findCustomers(db, query, { limit = 25 } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return db.prepare('SELECT customer_gid, handle, joined_at, referral_code, dirty FROM keepers_customers ORDER BY last_seen_at DESC LIMIT ?').all(limit);
  }
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const code = q.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return db.prepare(`
    SELECT customer_gid, handle, joined_at, referral_code, dirty FROM keepers_customers
    WHERE customer_gid LIKE ? OR handle LIKE ? OR CAST(numeric_id AS TEXT) LIKE ?
       OR REPLACE(UPPER(COALESCE(referral_code,'')), '-', '') LIKE ?
    ORDER BY last_seen_at DESC LIMIT ?
  `).all(like, like, like, `%${code}%`, limit);
}
