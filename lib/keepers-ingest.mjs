// lib/keepers-ingest.mjs — turning a Shopify order into ledger events.
//
// SPLIT IN TWO ON PURPOSE. decideAccrual() is pure: it takes an order as Shopify returns it plus the
// economy rules, and says what the ledger should hold. Everything above it does I/O. That split is
// what makes the rules — which channel accrues, what the basis is, what an order is worth —
// exercisable against fixtures with no network, no database and no clock, because those rules are
// where the money is and where a quiet mistake compounds.
//
// A WEBHOOK IS A TRIGGER, NEVER A SOURCE OF DATA. Nothing here reads an order out of a webhook body.
// The handler re-reads the order by id and derives the whole ledger state for it from scratch, which
// is what makes unordered at-least-once delivery survivable: refunds/create arriving before
// orders/paid produces the identical end state, because neither one is believed.
import { shopifyGraphQL, moneyToCents } from './channels/shopify-admin.mjs';
import {
  appendEvent, clampReversal, upsertCustomer, withTransaction, linkUnlinkedEvents,
} from './keepers-db.mjs';
import { claimReferral, voidClaimsForOrder, ensureReferralCode } from './keepers-referrals.mjs';
import { markUsedByOrder } from './keepers-redeem.mjs';

// What we ask Shopify for. Deliberately explicit rather than a spread: every field here is used by a
// rule below, and a field nobody uses is a field that quietly starts costing query points.
export const ORDER_QUERY = `
query($id: ID!) {
  order(id: $id) {
    id name processedAt updatedAt cancelledAt createdAt
    displayFinancialStatus
    currencyCode
    sourceName
    app { name }
    publication { name }
    tags
    customer { id }
    currentSubtotalPriceSet { shopMoney { amount currencyCode } }
    totalRefundedSet { shopMoney { amount } }
    refunds { id createdAt totalRefundedSet { shopMoney { amount } } }
    discountApplications(first: 20) {
      nodes {
        __typename
        ... on DiscountCodeApplication { code allocationMethod }
      }
    }
    customAttributes { key value }
    lineItems(first: 100) {
      nodes {
        quantity sku
        discountedTotalSet { shopMoney { amount } }
        product {
          id
          language: metafield(namespace: "bkc", key: "language") { value }
          releaseStatus: metafield(namespace: "bkc", key: "release_status") { value }
        }
      }
    }
  }
}`;

/**
 * channelOf(order) — which sales channel an order came through.
 *
 * Shopify spreads this across three fields that are populated inconsistently depending on how the
 * order was created, so all three are consulted and the first definite answer wins.
 *
 * Returns { channel, definite }. `definite: false` means we genuinely could not tell — which is NOT
 * the same as "it was the online store", and the caller must treat it as a refusal.
 */
export function channelOf(order) {
  const o = order || {};
  const pub = o.publication?.name?.trim();
  if (pub) return { channel: pub, definite: true };
  const app = o.app?.name?.trim();
  if (app) return { channel: app, definite: true };
  const src = typeof o.sourceName === 'string' ? o.sourceName.trim() : '';
  if (src) return { channel: src, definite: true };
  return { channel: null, definite: false };
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * accrualBasisCents(order, { keepersDiscountCents })
 *
 * The basis is currentSubtotalPriceSet — net of line discounts, EXCLUDING shipping and tax.
 *
 *   shipping is excluded because earning loyalty on postage rewards a customer for a cost we pass
 *   through at no margin, and it makes a $4 card in a $12 parcel earn like a $12 purchase.
 *   tax is excluded because GST is not ours.
 *
 * Then any Keepers redemption is SUBTRACTED. Without that, points spent on a discount earn points
 * back on the discounted order — a slow inflation loop that nobody notices until the liability is
 * real.
 */
export function accrualBasisCents(order, { keepersDiscountCents = 0 } = {}) {
  const gross = moneyToCents(order?.currentSubtotalPriceSet?.shopMoney?.amount);
  if (gross === null) return null;
  return Math.max(0, gross - Math.max(0, Number(keepersDiscountCents) || 0));
}

/**
 * keepersDiscountOf(order, { codePrefix, knownCodes })
 *
 * How much of this order was paid for with a Keepers reward. Matched by explicit code list first —
 * the caller passes the codes it actually minted — and falls back to the configured prefix, so a code
 * minted before a prefix change is still recognised.
 *
 * Percentage discounts do not report their value on the application node, so the value is taken from
 * the difference the order already reflects rather than recomputed: currentSubtotalPriceSet is net of
 * discounts, so the discount is not subtracted twice. This returns the MATCHED FLAG, and the cents
 * only when Shopify gave us a figure to use.
 */
export function keepersDiscountOf(order, { codePrefix = '', knownCodes = [] } = {}) {
  const codes = new Set((Array.isArray(knownCodes) ? knownCodes : []).map(norm).filter(Boolean));
  const prefix = norm(codePrefix);
  const nodes = order?.discountApplications?.nodes || [];
  const matched = [];
  for (const n of nodes) {
    const code = n?.code;
    if (!code) continue;
    const c = norm(code);
    if (codes.has(c) || (prefix && c.startsWith(prefix))) matched.push(String(code));
  }
  return { used: matched.length > 0, codes: matched };
}

/**
 * evidenceOf(order) — the badge inputs, SNAPSHOTTED at accrual.
 *
 * This is load-bearing rather than convenient. bkc.release_status flips from pre-order to in-stock the
 * week a set drops, so a badge evaluator that re-read the product later would find every past order
 * looking like an in-stock purchase and preorder-pioneer would become permanently unwinnable — with
 * no error, and no obvious moment where it broke.
 */
export function evidenceOf(order, { channel = null, keepersCodes = [] } = {}) {
  const lines = order?.lineItems?.nodes || [];
  const languages = [...new Set(
    lines.map((l) => String(l?.product?.language?.value ?? '').trim()).filter(Boolean),
  )].sort();
  const preorder = lines.some((l) => norm(l?.product?.releaseStatus?.value) === 'pre-order');
  const skus = [...new Set(lines.map((l) => String(l?.sku ?? '').trim()).filter(Boolean))];
  const ref = (order?.customAttributes || []).find((a) => norm(a?.key) === 'bk_ref');
  return {
    channel,
    languages,
    preorder,
    skus,
    keepersCodes,
    // The referral code as it arrived on the cart. An INPUT, never an assertion — cart attributes are
    // customer-editable through the AJAX cart, so every check on it happens server-side.
    ref: ref ? String(ref.value || '').trim() || null : null,
  };
}

/**
 * decideAccrual(order, rules, opts) — the whole decision, pure.
 *
 * Returns:
 *   { accrues, reason, basisCents, xp, points, evidence, channel, rateXp, ratePoints,
 *     refunds: [{ id, cents }], cancelled }
 *
 * `accrues: false` always carries a `reason`, because "this order earned nothing" is a thing someone
 * will one day need explained, and reconstructing it from the config six months later is not viable.
 */
export function decideAccrual(order, rules = {}, { codePrefix = '', knownCodes = [] } = {}) {
  const o = order || {};
  const rateXp = Number(rules.xp_per_dollar);
  const ratePoints = Number(rules.points_per_dollar);
  const excluded = new Set((Array.isArray(rules.excluded_channels) ? rules.excluded_channels : []).map(norm));

  const { channel, definite } = channelOf(o);
  const disc = keepersDiscountOf(o, { codePrefix, knownCodes });
  const evidence = evidenceOf(o, { channel, keepersCodes: disc.codes });

  const refunds = (o.refunds || [])
    .map((r) => ({ id: r?.id, cents: moneyToCents(r?.totalRefundedSet?.shopMoney?.amount) }))
    .filter((r) => r.id && Number.isFinite(r.cents) && r.cents > 0);
  const cancelled = Boolean(o.cancelledAt);

  const no = (reason) => ({
    accrues: false, reason, basisCents: null, xp: 0, points: 0,
    evidence, channel, rateXp, ratePoints, refunds, cancelled,
  });

  // The programme being off must stop accrual, not just hide the storefront. One switch, both halves.
  if (rules.enabled === false || norm(rules.enabled) === 'false') return no('programme_disabled');
  if (!Number.isFinite(rateXp) || !Number.isFinite(ratePoints)) return no('rates_unreadable');

  // FAIL CLOSED ON AN UNKNOWN CHANNEL. Accruing XP on an eBay order breaks a promise printed on every
  // page of the storefront — "Keeper XP and points only count on orders placed here" (D-009,
  // invariant 9). Not accruing is a support ticket someone can fix by hand. The cheaper mistake wins.
  if (!definite) return no('channel_unknown');
  if (excluded.has(norm(channel))) return no('channel_excluded');

  const basisCents = accrualBasisCents(o, { keepersDiscountCents: 0 });
  if (basisCents === null) return no('no_subtotal');

  // Floor, not round. A customer who is told "74 XP" on the product page must not be handed 75, and
  // the storefront floors too — blocks/bk-keepers-earn.liquid. Two roundings that disagree is the
  // broken promise that file's own header warns about.
  const dollars = basisCents / 100;
  const xp = Math.floor(dollars * rateXp);
  const points = Math.floor(dollars * ratePoints);

  return {
    accrues: true, reason: null, basisCents, xp, points,
    evidence, channel, rateXp, ratePoints, refunds, cancelled,
  };
}

/**
 * reversalFor(decision, { refundedCents }) — what a refund is worth back, before clamping.
 *
 * Proportional to the refunded share of the basis, at the ORIGINAL rate. A half-refunded order takes
 * back half the XP, which is the only answer that survives a customer refunding one card out of five.
 */
export function reversalFor(decision, { refundedCents }) {
  const basis = Number(decision?.basisCents);
  const refunded = Number(refundedCents);
  if (!Number.isFinite(basis) || basis <= 0 || !Number.isFinite(refunded) || refunded <= 0) {
    return { xp: 0, points: 0 };
  }
  const share = Math.min(1, refunded / basis);
  return {
    xp: Math.floor(decision.xp * share),
    points: Math.floor(decision.points * share),
  };
}

// --- the I/O half ---

export async function fetchOrder(env, orderGid, { store = 'dev' } = {}) {
  const res = await shopifyGraphQL(env, ORDER_QUERY, { id: String(orderGid) }, { store });
  if (!res.ok) return { ok: false, error: res.errors || res.userErrors, order: null, res };
  return { ok: true, order: res.data?.order || null, res };
}

/**
 * ingestOrder — re-read one order and bring the ledger to match it.
 *
 * Idempotent by construction: every append is keyed on (source, source_ref, kind), so running this
 * twice on the same order changes nothing the second time. That is what lets the webhook and the
 * reconcile sweep both call it without coordinating.
 *
 * Returns a summary rather than throwing, so a caller processing a batch can record what happened to
 * each order and keep going.
 */
export async function ingestOrder(env, db, orderGid, { rules, store = 'dev', codePrefix = '', knownCodes = [], observeOnly = false } = {}) {
  const got = await fetchOrder(env, orderGid, { store });
  if (!got.ok) return { orderGid, ok: false, error: 'fetch_failed', detail: got.error };
  const order = got.order;
  if (!order) return { orderGid, ok: false, error: 'not_found' };

  const decision = decideAccrual(order, rules, { codePrefix, knownCodes });
  const customerGid = order.customer?.id || null;
  // PII presence, recorded as evidence for D-022 rather than argued about. The customer block coming
  // back without a name on live, while dev returns one, is the whole open question.
  const piiPresent = Object.prototype.hasOwnProperty.call(order.customer || {}, 'firstName') ? 1 : null;

  const summary = {
    orderGid, ok: true, name: order.name, customerGid,
    accrues: decision.accrues, reason: decision.reason,
    channel: decision.channel, basisCents: decision.basisCents,
    xp: decision.xp, points: decision.points,
    refunds: decision.refunds.length, cancelled: decision.cancelled,
    piiPresent, wrote: 0,
  };

  // OBSERVE MODE writes nothing to the ledger. Its whole promise is that it changes nothing, so it
  // must not even create the customer row.
  if (observeOnly) return { ...summary, observed: true };

  withTransaction(db, () => {
    if (customerGid) {
      upsertCustomer(db, { customerGid, joinedAt: order.createdAt || null });
      // An event that arrived before we knew whose it was gets its owner now — through a GraphQL read,
      // which is a different surface from the webhook body and may succeed where that failed.
      linkUnlinkedEvents(db, String(orderGid), customerGid);
    }

    db.prepare(`
      INSERT INTO keepers_orders (
        order_gid, order_number, customer_gid, channel, accrues, financial_status, cancelled_at,
        processed_at, updated_at, net_cents, refunded_cents, keepers_discount_cents, currency,
        pii_present, last_seen_at, raw
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
      ON CONFLICT(order_gid) DO UPDATE SET
        customer_gid = COALESCE(excluded.customer_gid, keepers_orders.customer_gid),
        channel = excluded.channel, accrues = excluded.accrues,
        financial_status = excluded.financial_status, cancelled_at = excluded.cancelled_at,
        updated_at = excluded.updated_at, refunded_cents = excluded.refunded_cents,
        pii_present = COALESCE(excluded.pii_present, keepers_orders.pii_present),
        last_seen_at = datetime('now')
    `).run(
      String(orderGid), order.name || null, customerGid, decision.channel,
      decision.accrues ? 1 : 0, order.displayFinancialStatus || null, order.cancelledAt || null,
      order.processedAt || null, order.updatedAt || null, decision.basisCents,
      moneyToCents(order.totalRefundedSet?.shopMoney?.amount) ?? 0, 0,
      order.currencyCode || null, piiPresent, null,
    );

    if (!decision.accrues) return;

    const accrual = appendEvent(db, {
      customerGid, kind: 'order_accrual',
      xpDelta: decision.xp, pointsDelta: decision.points,
      source: 'shopify_order', sourceRef: String(orderGid),
      basisCents: decision.basisCents,
      rateXpPerDollar: decision.rateXp, ratePointsPerDollar: decision.ratePoints,
      occurredAt: order.processedAt || order.createdAt || null,
      evidence: decision.evidence,
    });
    if (accrual.inserted) summary.wrote++;

    // Reversals, one per refund id so a second refund on the same order is its own event. The clamp
    // is what stops two partial refunds plus a cancellation taking back more than was ever earned.
    for (const r of decision.refunds) {
      const want = reversalFor(decision, { refundedCents: r.cents });
      const c = clampReversal(db, String(orderGid), want);
      if (c.xpDelta === 0 && c.pointsDelta === 0) continue;
      const rev = appendEvent(db, {
        customerGid, kind: 'order_reversal',
        xpDelta: c.xpDelta, pointsDelta: c.pointsDelta,
        source: 'shopify_refund', sourceRef: String(r.id),
        reversesEventId: c.reversesEventId,
        occurredAt: order.updatedAt || null,
        note: `refund ${r.cents}c of ${decision.basisCents}c`,
      });
      if (rev.inserted) summary.wrote++;
    }

    if (decision.cancelled) {
      const c = clampReversal(db, String(orderGid), { xp: decision.xp, points: decision.points });
      if (c.xpDelta !== 0 || c.pointsDelta !== 0) {
        const rev = appendEvent(db, {
          customerGid, kind: 'order_reversal',
          xpDelta: c.xpDelta, pointsDelta: c.pointsDelta,
          source: 'shopify_order_cancel', sourceRef: String(orderGid),
          reversesEventId: c.reversesEventId,
          occurredAt: order.cancelledAt || null,
          note: 'order cancelled',
        });
        if (rev.inserted) summary.wrote++;
      }
    }

    // A paid order carrying one of our codes is the FIRST of two independent readings that it was
    // used; reconcileRedemptions reads asyncUsageCount as the second. Their disagreement is the alarm.
    for (const code of decision.evidence?.keepersCodes || []) {
      markUsedByOrder(db, code, String(orderGid), { nowMs: Date.now() });
    }

    // ---- referral ----
    //
    // The code travelled here as a cart attribute, which the customer can edit through the AJAX cart,
    // so it is an INPUT and every check happens inside claimReferral against the ledger. Attempted
    // once per order and idempotent afterwards: the referee_gid primary key means a redelivery of the
    // same order cannot mint a second claim.
    if (customerGid && decision.evidence?.ref) {
      const r = claimReferral(db, {
        refereeGid: customerGid, code: decision.evidence.ref,
        orderGid: String(orderGid), rules, nowMs: Date.now(),
      });
      summary.referral = r.ok ? { claimed: true, referrerGid: r.referrerGid } : { claimed: false, reason: r.reason };
    }

    // A refund or cancellation on the order that QUALIFIED a referral kills the held award. This is
    // where buy -> refund -> repeat dies; without it the hold merely delays the exploit.
    if (decision.refunds.length > 0 || decision.cancelled) {
      const voided = voidClaimsForOrder(db, String(orderGid));
      if (voided) summary.referralVoided = voided;
    }

    // Every customer gets a code on first sight, so /pages/refer has something to show before they
    // have earned anything at all.
    if (customerGid) {
      try { ensureReferralCode(db, customerGid, { prefix: rules?.redemption_code_prefix || 'BK' }); }
      catch (e) { summary.referralCodeError = String(e?.message || e); }
    }
  });

  return summary;
}
