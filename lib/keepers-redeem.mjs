// lib/keepers-redeem.mjs — turning points into a discount code.
//
// PERCENTAGES, NOT FIXED AMOUNTS, and not by preference: a percentage discount CANNOT be capped on
// Basic. There is no maximum-amount field anywhere in the 2026-07 discount input tree, and the only
// mechanism that does it — the Discounts Allocator Function — is Plus-only AND developer-preview-only
// AND preview-stores-only. So "10% off, up to $25" is not expressible here.
//
// The upside is that percentages have no lost-change problem. A fixed $25 code spent on a $6 card
// destroys $19: Shopify caps the discount at the order total, retains no residual, and still burns
// the code. A percentage is always exactly a percentage, so a small order simply earns a small
// discount. And a percentage discount is merchandise-only by construction — MerchandiseDiscountClass
// is ORDER|PRODUCT with no SHIPPING member — so "never applies to shipping" is satisfied for free.
//
// DEBIT BEFORE MINT. The points come out of the ledger in the same transaction that opens the
// redemption, before Shopify is called at all. Same reasoning as deal_requests claiming 'sending'
// before the eBay round trip: mint-first fails into a live code in the wild with no debit, which is
// free money; debit-first fails into points temporarily missing, which is a ticket someone can fix.
//
// THE ELIGIBILITY ECHO IS THE ENTIRE SECURITY MODEL. `context.customers.add` is what makes a code
// usable by one person. shopifyGraphQL's `ok` catches userErrors, but it cannot catch a mutation that
// SUCCEEDED with the wrong shape — a code minted store-wide verifies as a success and is a money leak
// on every order until someone notices. So the created node is read back and the eligibility checked,
// and a mismatch is deactivated immediately rather than reported.
//
// Note for anyone reading the older Shopify docs: `customerSelection` is GONE from
// DiscountCodeBasicInput in 2026-07, not merely deprecated. Confirmed by introspection before this
// was written. `context` is the field.
import { shopifyGraphQL, centsToMoney } from './channels/shopify-admin.mjs';
import { appendEvent, ledgerTotals, getCustomer, markDirty } from './keepers-db.mjs';
import { mintCode as mintCodeBody } from './keepers-referrals.mjs';

export const CREATE_MUTATION = `
mutation($basic: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basic) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title status usageLimit appliesOncePerCustomer startsAt endsAt asyncUsageCount
          codes(first: 5) { nodes { code } }
          context { ... on DiscountCustomers { customers { id } } }
          customerGets { value { ... on DiscountPercentage { percentage } } }
        }
      }
    }
    userErrors { field message code }
  }
}`;

export const READ_QUERY = `
query($id: ID!) {
  codeDiscountNode(id: $id) {
    id
    codeDiscount {
      ... on DiscountCodeBasic {
        title status asyncUsageCount endsAt
        codes(first: 5) { nodes { code } }
        context { ... on DiscountCustomers { customers { id } } }
      }
    }
  }
}`;

export const DEACTIVATE_MUTATION = `
mutation($id: ID!) {
  discountCodeDeactivate(id: $id) { userErrors { field message } }
}`;

/**
 * redemptionProblem — every refusal, before anything is written.
 */
export function redemptionProblem(db, { customerGid, tier, rules = {} }) {
  if (!customerGid) return 'no customer';
  if (!getCustomer(db, customerGid)) return 'unknown customer';
  if (!tier || !Number.isFinite(Number(tier.pointsCost)) || Number(tier.pointsCost) <= 0) return 'unknown tier';
  if (!Number.isFinite(Number(tier.percentOff)) || Number(tier.percentOff) <= 0 || Number(tier.percentOff) > 100) {
    return 'tier has an unusable percentage';
  }

  const floor = Number(rules.redemption_min_points);
  if (Number.isFinite(floor) && Number(tier.pointsCost) < floor) return `below the ${floor}-point minimum`;

  // BEFORE the balance check, deliberately. An open redemption has ALREADY debited its points, so a
  // second attempt would otherwise report "not enough points" — which is misleading in the way that
  // sends someone to the wrong place: their points are not gone, they are committed to a redemption
  // that is still in flight.
  const open = db.prepare("SELECT id FROM keepers_redemptions WHERE customer_gid = ? AND status IN ('requested','minting')").get(String(customerGid));
  if (open) return 'a redemption is already in progress';

  // Checked against the LEDGER, never the projection cache: the cache is what we last wrote to
  // Shopify, which can be hours stale, and spending against a stale balance is how a customer goes
  // negative without ever being told.
  const { points } = ledgerTotals(db, customerGid);
  if (points < Number(tier.pointsCost)) return `not enough points (has ${points}, needs ${tier.pointsCost})`;

  return null;
}

/**
 * openRedemption — debit the points and open the row. ONE transaction, supplied by the caller.
 *
 * Returns { ok, id } or { ok:false, reason }. Nothing has reached Shopify at this point.
 */
export function openRedemption(db, { customerGid, tier, rules = {}, nowMs = Date.now() }) {
  const problem = redemptionProblem(db, { customerGid, tier, rules });
  if (problem) return { ok: false, reason: problem };

  const info = db.prepare(`
    INSERT INTO keepers_redemptions (customer_gid, tier_handle, points_cost, percent_off, status, requested_at)
    VALUES (?,?,?,?, 'requested', ?)
  `).run(String(customerGid), tier.handle || null, Math.trunc(Number(tier.pointsCost)), Number(tier.percentOff),
    new Date(nowMs).toISOString());
  const id = Number(info.lastInsertRowid);

  const ev = appendEvent(db, {
    customerGid, kind: 'redemption_debit',
    xpDelta: 0, pointsDelta: -Math.trunc(Number(tier.pointsCost)),
    source: 'redemption', sourceRef: String(id),
    occurredAt: new Date(nowMs).toISOString(),
    note: `redeemed ${tier.percentOff}% off for ${tier.pointsCost} points`,
    evidence: { tier: tier.handle || null, percentOff: Number(tier.percentOff) },
  });
  // The redemption id is fresh from AUTOINCREMENT, so the unique index cannot have seen it. If this
  // ever fails to insert, something is very wrong and spending the points silently would be worse.
  if (!ev.inserted) return { ok: false, reason: 'debit_failed' };

  markDirty(db, customerGid);
  return { ok: true, id, pointsCost: Math.trunc(Number(tier.pointsCost)), percentOff: Number(tier.percentOff) };
}

/**
 * refundRedemption — give the points back with a compensating event.
 *
 * Used when a mint fails, when a code is revoked, and (config permitting) when one expires unused.
 * Never mutates the debit: the ledger is append-only, so a refund is its own row and the pair of them
 * is the story.
 */
export function refundRedemption(db, id, { reason = 'mint_failed', nowMs = Date.now() } = {}) {
  const r = db.prepare('SELECT * FROM keepers_redemptions WHERE id = ?').get(Number(id));
  if (!r) return { ok: false, reason: 'unknown redemption' };

  const ev = appendEvent(db, {
    customerGid: r.customer_gid, kind: 'redemption_refund',
    xpDelta: 0, pointsDelta: Math.trunc(Number(r.points_cost)),
    source: 'redemption', sourceRef: `refund:${id}`,
    occurredAt: new Date(nowMs).toISOString(),
    note: `points returned — ${reason}`,
    evidence: { redemptionId: Number(id), reason },
  });
  markDirty(db, r.customer_gid);
  return { ok: true, already: !ev.inserted, points: Math.trunc(Number(r.points_cost)) };
}

/** The customer eligibility a created code actually carries, from the read-back. */
export function eligibleCustomerIds(node) {
  const ctx = node?.codeDiscount?.context;
  const list = ctx?.customers;
  return Array.isArray(list) ? list.map((c) => String(c?.id || '')).filter(Boolean) : [];
}

/**
 * eligibilityProblem — is this code usable by EXACTLY the one customer we minted it for?
 *
 * The check that matters most in this file. A code minted with no customer restriction is valid for
 * everyone who finds the string, on every order, until someone notices — and the mutation reports it
 * as a complete success.
 */
export function eligibilityProblem(node, customerGid) {
  const ids = eligibleCustomerIds(node);
  if (ids.length === 0) return 'the code carries NO customer restriction — it is usable by anyone';
  if (ids.length > 1) return `the code is eligible for ${ids.length} customers, not one`;
  if (ids[0] !== String(customerGid)) return `the code is eligible for ${ids[0]}, not ${customerGid}`;
  return null;
}

/**
 * mintRedemption — call Shopify, verify the echo, record the code.
 *
 * Does its own transaction handling around the DB writes because the network call must not be inside
 * one: a SQLite transaction held open across an HTTP round trip blocks every other writer for its
 * duration, and this one can be slow.
 */
export async function mintRedemption(env, db, id, { rules = {}, store = 'dev', nowMs = Date.now() } = {}) {
  const r = db.prepare('SELECT * FROM keepers_redemptions WHERE id = ?').get(Number(id));
  if (!r) return { ok: false, reason: 'unknown redemption' };
  if (r.status !== 'requested') return { ok: false, reason: `redemption is ${r.status}, not requested` };

  db.prepare("UPDATE keepers_redemptions SET status='minting' WHERE id = ?").run(Number(id));

  const prefix = String(rules.redemption_code_prefix || 'BK').trim();
  const code = mintCodeBody(prefix);
  const days = Number.isFinite(Number(rules.redemption_expiry_days)) ? Number(rules.redemption_expiry_days) : 180;
  const endsAt = new Date(nowMs + days * 86400000).toISOString();

  const basic = {
    title: `Keepers ${r.percent_off}% — ${r.customer_gid}`,
    code,
    startsAt: new Date(nowMs).toISOString(),
    endsAt,
    // Both of these, deliberately. usageLimit is the store-wide ceiling and appliesOncePerCustomer is
    // the per-person one; the eligibility below should already make them redundant, and belt and
    // braces on a money-equivalent object is cheap.
    usageLimit: 1,
    appliesOncePerCustomer: true,
    context: { customers: { add: [String(r.customer_gid)] } },
    customerGets: {
      // percentage is 0.00-1.00, while the tier is stored as a whole percent for humans.
      value: { percentage: Number(r.percent_off) / 100 },
      items: { all: true },
    },
    // A Keepers reward stacking on top of a sale can go negative-margin. Shipping discounts are a
    // different class and are allowed to coexist, which is what keeps free-shipping-over-$300 working.
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
  };

  const res = await shopifyGraphQL(env, CREATE_MUTATION, { basic }, { store });
  if (!res.ok) {
    db.prepare("UPDATE keepers_redemptions SET status='failed', error=? WHERE id=?")
      .run(JSON.stringify(res.userErrors || res.errors || 'create_failed').slice(0, 500), Number(id));
    refundRedemption(db, id, { reason: 'mint_failed', nowMs });
    return { ok: false, reason: 'create_failed', detail: res.userErrors || res.errors };
  }

  const node = res.data?.discountCodeBasicCreate?.codeDiscountNode;
  const gid = node?.id;

  // THE ECHO CHECK. A successful mutation with the wrong eligibility is a store-wide money leak that
  // reports as success, so this is not defensive — it is the security model.
  const bad = eligibilityProblem(node, r.customer_gid);
  if (bad) {
    if (gid) { try { await shopifyGraphQL(env, DEACTIVATE_MUTATION, { id: gid }, { store }); } catch { /* best effort */ } }
    db.prepare("UPDATE keepers_redemptions SET status='failed', discount_gid=?, error=? WHERE id=?")
      .run(gid || null, `eligibility mismatch: ${bad}`, Number(id));
    refundRedemption(db, id, { reason: 'eligibility_mismatch', nowMs });
    return { ok: false, reason: 'eligibility_mismatch', detail: bad, deactivated: Boolean(gid) };
  }

  db.prepare(`
    UPDATE keepers_redemptions SET status='active', code=?, discount_gid=?, minted_at=?, expires_at=?, error=NULL
    WHERE id=?
  `).run(code, gid || null, new Date(nowMs).toISOString(), endsAt, Number(id));

  return { ok: true, id: Number(id), code, discountGid: gid, expiresAt: endsAt, percentOff: Number(r.percent_off) };
}

/**
 * reconcileRedemptions — two independent readings of whether a code was used, and expiry.
 *
 * Usage is learned two ways: `discountApplications` on a paid order (the ingest path records it), and
 * `asyncUsageCount` here. Their DISAGREEMENT is the alarm — asyncUsageCount above zero with no order
 * recorded means a code was used on an order we never saw, which is a lost webhook the sweep should
 * have caught.
 */
export async function reconcileRedemptions(env, db, { rules = {}, store = 'dev', nowMs = Date.now(), limit = 100 } = {}) {
  const now = new Date(nowMs).toISOString();
  const rows = db.prepare("SELECT * FROM keepers_redemptions WHERE status = 'active' ORDER BY id LIMIT ?").all(limit);
  const refundOnExpiry = rules.redemption_expiry_refunds !== false;

  let used = 0; let expired = 0; let refunded = 0; let checked = 0;
  const disagreements = [];

  for (const r of rows) {
    if (!r.discount_gid) continue;
    checked++;
    const res = await shopifyGraphQL(env, READ_QUERY, { id: r.discount_gid }, { store });
    if (!res.ok) continue;
    const cd = res.data?.codeDiscountNode?.codeDiscount;
    const count = Number(cd?.asyncUsageCount || 0);

    if (count > 0 && !r.used_order_gid) {
      // Shopify says it was used; we never saw the order. Recorded rather than silently accepted.
      disagreements.push({ id: r.id, code: r.code, asyncUsageCount: count, note: 'used on an order we never recorded' });
    }
    if (count > 0) {
      db.prepare("UPDATE keepers_redemptions SET status='used', used_at=COALESCE(used_at, ?) WHERE id=?").run(now, r.id);
      used++;
      continue;
    }
    if (r.expires_at && String(r.expires_at) <= now) {
      db.prepare("UPDATE keepers_redemptions SET status='expired' WHERE id=?").run(r.id);
      expired++;
      // Points vanishing because somebody forgot is the fastest way to make a loyalty programme feel
      // hostile, and the store keeps the money either way. Config, so Marty can disagree.
      if (refundOnExpiry) { refundRedemption(db, r.id, { reason: 'code_expired_unused', nowMs }); refunded++; }
    }
  }
  return { checked, used, expired, refunded, disagreements };
}

/**
 * markUsedByOrder — the other reading, from an order that carried the code.
 *
 * Called by the ingest path when a paid order's discountApplications name one of our codes.
 */
export function markUsedByOrder(db, code, orderGid, { nowMs = Date.now() } = {}) {
  const n = db.prepare(`
    UPDATE keepers_redemptions SET status='used', used_at=COALESCE(used_at, ?), used_order_gid=?
    WHERE UPPER(code) = UPPER(?) AND status IN ('active','used')
  `).run(new Date(nowMs).toISOString(), String(orderGid), String(code));
  return Number(n.changes) || 0;
}

/** Every code that could still be used, so the ingest path can recognise one on an order. */
export function activeCodes(db) {
  return db.prepare("SELECT code FROM keepers_redemptions WHERE code IS NOT NULL AND status IN ('active','used')").all().map((x) => x.code);
}

/**
 * revokeRedemption — deactivate a live code and give the points back.
 *
 * Needed because a minted code lives on Shopify and keeps working after app/uninstalled, after the
 * engine is switched off, and after anything else we might do on this side.
 */
export async function revokeRedemption(env, db, id, { store = 'dev', nowMs = Date.now(), refund = true } = {}) {
  const r = db.prepare('SELECT * FROM keepers_redemptions WHERE id = ?').get(Number(id));
  if (!r) return { ok: false, reason: 'unknown redemption' };
  if (r.status === 'used') return { ok: false, reason: 'already used' };

  if (r.discount_gid) {
    const res = await shopifyGraphQL(env, DEACTIVATE_MUTATION, { id: r.discount_gid }, { store });
    if (!res.ok) return { ok: false, reason: 'deactivate_failed', detail: res.userErrors || res.errors };
  }
  db.prepare("UPDATE keepers_redemptions SET status='revoked' WHERE id=?").run(Number(id));
  if (refund) refundRedemption(db, id, { reason: 'revoked', nowMs });
  return { ok: true, refunded: refund };
}
