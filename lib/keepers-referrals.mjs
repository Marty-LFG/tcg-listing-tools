// lib/keepers-referrals.mjs — refer a friend, and the guards that stop it being a money printer.
//
// The referral award is BY FAR the largest in the economy: spec §6.1 pays 200 XP and 500 points, next
// to 25 for a review and 50 for a show check-in. So it is also the only earn action where getting the
// controls wrong is worth someone's while, and where the controls carry the whole weight — because
// the controls a normal loyalty programme would use are not available to us.
//
// WHAT WE CANNOT DO, STATED PLAINLY. Same-card detection, same-address detection, same-device
// detection: all impossible here. D-022's protected-customer-data question means we may not be able
// to read a buyer's name or address at all, and the ledger is deliberately built never to need them.
// So there is no "these two accounts look like the same person" check and there will not be one.
//
// WHAT CARRIES THE WEIGHT INSTEAD:
//
//   the hold      an award does not COUNT until the referee's first order has survived the refund
//                 window. Without it, buy -> refund -> repeat mints a full award every cycle, which
//                 is the whole exploit in one line.
//   first-order   computed from the LEDGER, not from customer.numberOfOrders, which counts cancelled
//                 orders and would let one account be "first-ordered" repeatedly.
//   one forever   referee_gid is the PRIMARY KEY of keepers_referral_claims. A second claim on the
//                 same referee cannot be inserted, whatever any caller believes.
//   the cap       a per-referrer monthly ceiling, so even a working exploit is bounded.
//
// THE CODE ON THE ORDER IS AN INPUT, NEVER AN ASSERTION. It arrives as a cart attribute, and cart
// attributes are editable by the customer through the AJAX cart. Every check below runs server-side
// against the ledger; nothing trusts the string.
import crypto from 'node:crypto';
import { appendEvent, getCustomer, markDirty } from './keepers-db.mjs';

// Crockford base32: no I, L, O or U. The first three because a code read off a phone screen at a card
// show gets typed back as 1, 1 and 0; the U because excluding it is how the alphabet avoids
// accidentally spelling things. 32 symbols is exactly 5 bits, which is why the minting below can mask
// rather than modulo — 32 divides 256, so there is no modulo bias to correct for.
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * mintCode(prefix, bytes) — `BK-7K4M-QX92`. Eight symbols is 40 bits, which is not a secret and does
 * not need to be: a referral code is TYPEABLE, not a bearer token. Guessing one gains an attacker
 * nothing they could not get by asking a friend for theirs, because every award is gated on the
 * referee's genuine first order clearing a refund window.
 */
export function mintCode(prefix = 'BK', bytes = null) {
  const b = bytes || crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[b[i] & 31];
  const p = String(prefix || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${p ? p + '-' : ''}${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

/**
 * normalizeCode — what someone actually typed, turned into what we stored.
 *
 * The Crockford decoding rules are the point: I and L become 1, O becomes 0. Without them a customer
 * reading `7K4M-QX92` off a phone and typing `7K4M-QXO2` gets "unknown code" for a code that is
 * theirs, and there is nothing in the message to tell them what they got wrong.
 */
export function normalizeCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/[^0-9A-Z]/g, '');
}

/** Two codes match if they normalize the same — so BK-7K4M-QX92 and bk7k4mqxo2 are one code. */
export const codesMatch = (a, b) => Boolean(normalizeCode(a)) && normalizeCode(a) === normalizeCode(b);

/**
 * ensureReferralCode — every customer gets one on first sight, and keeps it forever.
 *
 * Retries on collision rather than trusting 40 bits to be unique: the UNIQUE index is the authority,
 * and a caller that assumed uniqueness would fail rarely and confusingly rather than never.
 */
export function ensureReferralCode(db, customerGid, { prefix = 'BK', attempts = 8 } = {}) {
  const row = getCustomer(db, customerGid);
  if (!row) throw new Error(`keepers-referrals: no customer row for ${customerGid}`);
  if (row.referral_code) return row.referral_code;

  for (let i = 0; i < attempts; i++) {
    const code = mintCode(prefix);
    try {
      const info = db.prepare(
        'UPDATE keepers_customers SET referral_code = ? WHERE customer_gid = ? AND referral_code IS NULL',
      ).run(code, String(customerGid));
      if (Number(info.changes) > 0) {
        // Queue a projection. A code that never reaches Shopify is worth nothing — /pages/refer
        // reads customer.metafields.keepers.referral_code and says "give it a few minutes" when
        // it is blank. Minting without marking dirty is how that message became permanent.
        markDirty(db, customerGid);
        return code;
      }
      // Somebody else set one between the read and the write.
      return getCustomer(db, customerGid).referral_code;
    } catch (e) {
      // UNIQUE violation: try again with a different code.
      if (!String(e?.message || '').toLowerCase().includes('unique')) throw e;
    }
  }
  throw new Error('keepers-referrals: could not mint a unique referral code');
}

/** Whose code is this? Normalized both sides, so a typed code resolves the same as a pasted one. */
export function resolveCode(db, code) {
  const n = normalizeCode(code);
  if (!n) return null;
  const rows = db.prepare('SELECT customer_gid, referral_code FROM keepers_customers WHERE referral_code IS NOT NULL').all();
  const hit = rows.find((r) => normalizeCode(r.referral_code) === n);
  return hit ? hit.customer_gid : null;
}

/** Has this customer ever had an order that actually accrued? The ledger is the authority. */
export function hasAccruedOrder(db, customerGid, { excludeOrderGid = null } = {}) {
  const n = Number(db.prepare(`
    SELECT COUNT(*) n FROM keepers_events
    WHERE customer_gid = ? AND kind = 'order_accrual'
      AND (? IS NULL OR source_ref <> ?)
  `).get(String(customerGid), excludeOrderGid, excludeOrderGid)?.n) || 0;
  return n > 0;
}

/** How many referrals this referrer has been PAID or is holding this calendar month. */
export function referralsThisMonth(db, referrerGid, { nowMs = Date.now() } = {}) {
  const since = new Date(nowMs);
  const monthStart = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1)).toISOString();
  return Number(db.prepare(`
    SELECT COUNT(*) n FROM keepers_referral_claims
    WHERE referrer_gid = ? AND status IN ('held','paid') AND claimed_at >= ?
  `).get(String(referrerGid), monthStart)?.n) || 0;
}

/**
 * claimProblem — every guard, in one place, each returning a reason string.
 *
 * Returns null when the claim is allowed. The reasons are recorded on the claim row rather than
 * discarded, because "why did my friend's referral not count" is a question that gets asked and
 * cannot be answered from a boolean.
 */
export function claimProblem(db, { refereeGid, referrerGid, orderGid, rules = {}, nowMs = Date.now() }) {
  if (!refereeGid) return 'no_referee';
  if (!referrerGid) return 'unknown_code';
  if (String(refereeGid) === String(referrerGid)) return 'self_referral';

  if (!getCustomer(db, referrerGid)) return 'referrer_unknown';

  const prior = db.prepare('SELECT referrer_gid, status FROM keepers_referral_claims WHERE referee_gid = ?')
    .get(String(refereeGid));
  // One referrer per referee, FOREVER — including a claim that was rejected. Allowing a retry after a
  // rejection would let someone try codes until one stuck.
  if (prior) return prior.referrer_gid === String(referrerGid) ? 'already_claimed' : 'already_referred_by_another';

  // The referee's first ACCRUING order is the qualifying event. Computed from the ledger, not from
  // customer.numberOfOrders, which counts cancelled orders — an account could otherwise be
  // "first-ordered" repeatedly by cancelling.
  if (hasAccruedOrder(db, refereeGid, { excludeOrderGid: orderGid })) return 'not_first_order';

  const cap = Number(rules.max_referrals_per_month);
  if (Number.isFinite(cap) && cap > 0 && referralsThisMonth(db, referrerGid, { nowMs }) >= cap) {
    return 'referrer_monthly_cap';
  }
  return null;
}

/**
 * claimReferral — record the claim and write the awards HELD.
 *
 * The award is appended immediately, with status 'held' and a hold_until, rather than being written
 * later. Two reasons: it is visible in the ledger and the admin from the moment it is earned, and
 * releasing it is then just a status flip that the existing sweep already performs — no second code
 * path that could disagree about who was owed what.
 *
 * The caller supplies the transaction.
 */
export function claimReferral(db, { refereeGid, code, orderGid, rules = {}, nowMs = Date.now() }) {
  const referrerGid = resolveCode(db, code);
  const problem = claimProblem(db, { refereeGid, referrerGid, orderGid, rules, nowMs });

  if (problem) {
    // A rejected claim is RECORDED, not dropped — but only when we know who the referee is, and only
    // when it does not collide with an existing claim (the primary key is the "one forever" rule and
    // must not be spent on a rejection).
    if (refereeGid && referrerGid && !['already_claimed', 'already_referred_by_another'].includes(problem)) {
      try {
        db.prepare(`
          INSERT INTO keepers_referral_claims (referee_gid, referrer_gid, code, order_gid, status, reject_reason)
          VALUES (?,?,?,?,'rejected',?)
          ON CONFLICT(referee_gid) DO NOTHING
        `).run(String(refereeGid), String(referrerGid), String(code || ''), orderGid || null, problem);
      } catch { /* a race on the primary key is itself the one-forever rule working */ }
    }
    return { ok: false, reason: problem, referrerGid };
  }

  const holdDays = Number.isFinite(Number(rules.referral_hold_days)) ? Number(rules.referral_hold_days) : 14;
  const holdUntil = new Date(nowMs + holdDays * 86400000).toISOString();

  const ins = db.prepare(`
    INSERT INTO keepers_referral_claims (referee_gid, referrer_gid, code, order_gid, hold_until, status)
    VALUES (?,?,?,?,?, 'held')
    ON CONFLICT(referee_gid) DO NOTHING
  `).run(String(refereeGid), String(referrerGid), String(code || ''), orderGid || null, holdUntil);
  // Lost the race to another claim for this referee. The primary key decided; we did not.
  if (Number(ins.changes) === 0) return { ok: false, reason: 'already_claimed', referrerGid };

  const award = (gid, kind, xp, points) => {
    const x = Math.trunc(Number(xp) || 0);
    const p = Math.trunc(Number(points) || 0);
    if (x === 0 && p === 0) return null;
    return appendEvent(db, {
      customerGid: gid, kind, xpDelta: x, pointsDelta: p,
      source: 'referral', sourceRef: String(orderGid || refereeGid),
      status: 'held', holdUntil,
      occurredAt: new Date(nowMs).toISOString(),
      note: `referral via ${normalizeCode(code)}`,
      evidence: { code: normalizeCode(code), refereeGid: String(refereeGid), referrerGid: String(referrerGid) },
    });
  };

  award(referrerGid, 'referral_referrer', rules.referral_referrer_xp, rules.referral_referrer_points);
  // Spec §6.1 pays the referrer only, so these default to 0 and the award is skipped entirely.
  // D-013 leaves give-10-get-10 open; when Marty decides, it is a config change rather than a build.
  award(refereeGid, 'referral_referee', rules.referral_referee_xp, rules.referral_referee_points);

  markDirty(db, referrerGid);
  markDirty(db, refereeGid);
  return { ok: true, referrerGid, holdUntil };
}

/**
 * settleDueClaims — flip held claims to paid once their window has passed.
 *
 * The EVENTS are released by keepers-db's releaseHeldEvents, which the sweep already calls. This only
 * moves the claim rows, so the two cannot disagree about the money: the ledger is the money, and this
 * is bookkeeping about the claim.
 */
export function settleDueClaims(db, { nowMs = Date.now() } = {}) {
  const now = new Date(nowMs).toISOString();
  const info = db.prepare(`
    UPDATE keepers_referral_claims SET status = 'paid'
    WHERE status = 'held' AND hold_until IS NOT NULL AND hold_until <= ?
  `).run(now);
  return Number(info.changes) || 0;
}

/**
 * voidClaimsForOrder — the referee's qualifying order was refunded or cancelled inside the window.
 *
 * This is the exploit closing. The claim is rejected and its held events are voided, so they never
 * count. Deliberately only touches HELD events: once an award has been released it is earned, and
 * clawing it back later would punish a referrer for something their friend did.
 */
export function voidClaimsForOrder(db, orderGid, { reason = 'qualifying_order_reversed' } = {}) {
  const claims = db.prepare("SELECT referee_gid, referrer_gid FROM keepers_referral_claims WHERE order_gid = ? AND status = 'held'")
    .all(String(orderGid));
  if (!claims.length) return 0;

  db.prepare("UPDATE keepers_referral_claims SET status='rejected', reject_reason=? WHERE order_gid = ? AND status='held'")
    .run(reason, String(orderGid));
  const voided = db.prepare(`
    UPDATE keepers_events SET status='void'
    WHERE source = 'referral' AND source_ref = ? AND status = 'held'
  `).run(String(orderGid));

  for (const c of claims) { markDirty(db, c.referrer_gid); markDirty(db, c.referee_gid); }
  return Number(voided.changes) || 0;
}
