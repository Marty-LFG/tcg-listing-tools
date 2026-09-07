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

// Finding a code we may have created but cannot name. Searched by TITLE, because a discount is NOT
// findable by its code string: `query: "code:BK-…"` returns unrelated discounts and a bare term
// returns nothing, while an exact quoted title returns the node with its codes attached (measured
// against the dev store, not assumed). The code is then matched from the result, which is what makes
// the answer exact rather than a guess.
export const SEARCH_QUERY = `
query($q: String!) {
  codeDiscountNodes(first: 25, query: $q) {
    nodes {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title status asyncUsageCount endsAt
          codes(first: 5) { nodes { code } }
          context { ... on DiscountCustomers { customers { id } } }
        }
      }
    }
  }
}`;

/**
 * mintTitle — the title a redemption's discount carries, and the handle recovery searches on.
 *
 * The redemption id is in it so the title identifies ONE redemption. Without it every code for a
 * customer at a given percentage shares a title, and a recovery search would return a pile of them
 * with no way to tell which attempt was which.
 *
 * It is also what the merchant sees in the Shopify discounts list, so it stays readable.
 */
export function mintTitle({ percent_off: percentOff, id, customer_gid: customerGid }) {
  return `Keepers ${percentOff}% · #${id} — ${customerGid}`;
}

/**
 * findMintedDiscount — did Shopify create this code after all?
 *
 * THE QUESTION THAT USED TO GO UNASKED. A discount create that succeeds on Shopify but whose response
 * is lost — a 502, an RST, the 30s abort in shopify-admin.mjs — comes back as `ok: false`, which is
 * indistinguishable from "nothing was created" unless somebody looks. It used to be read as the
 * latter: the row was marked failed and the points refunded, while a live, correctly-scoped,
 * single-use code sat on the store that no row, no query and no sweep in this repo could name. The
 * customer then had their points back AND a spendable code, and `failed` is not in uq_kr_open, so
 * they could immediately mint a second.
 *
 * Returns { ok: false } when the SEARCH itself could not run. That distinction is the whole point:
 * "not created" and "cannot tell" must never collapse into the same branch, because one justifies a
 * refund and the other justifies refusing to decide.
 */
export async function findMintedDiscount(env, { title, code, store = 'dev', graphql = shopifyGraphQL }) {
  const res = await graphql(env, SEARCH_QUERY, { q: `title:"${title}"` }, { store });
  if (!res.ok) return { ok: false, errors: res.userErrors || res.errors };
  const want = String(code || '');
  const nodes = res.data?.codeDiscountNodes?.nodes || [];
  const node = want
    ? nodes.find((n) => (n?.codeDiscount?.codes?.nodes || []).some((c) => String(c?.code || '') === want))
    : null;
  return { ok: true, node: node || null };
}

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
export async function mintRedemption(env, db, id, { rules = {}, store = 'dev', nowMs = Date.now(), graphql = shopifyGraphQL } = {}) {
  const r = db.prepare('SELECT * FROM keepers_redemptions WHERE id = ?').get(Number(id));
  if (!r) return { ok: false, reason: 'unknown redemption' };
  if (r.status !== 'requested') return { ok: false, reason: `redemption is ${r.status}, not requested` };

  const prefix = String(rules.redemption_code_prefix || 'BK').trim();
  const code = mintCodeBody(prefix);

  // THE CODE IS WRITTEN BEFORE THE NETWORK CALL, and that ordering is the fix. It used to live only
  // in this function's frame until the success UPDATE at the bottom, so every way of not reaching
  // that line — a lost response, a restart, a throw between the create and the commit — left a code
  // on Shopify that nothing here could ever name. Persisting it first costs one UPDATE and turns an
  // unrecoverable leak into a lookup. The column is UNIQUE, so this cannot collide silently either.
  db.prepare("UPDATE keepers_redemptions SET status='minting', code=? WHERE id = ?").run(code, Number(id));

  const days = Number.isFinite(Number(rules.redemption_expiry_days)) ? Number(rules.redemption_expiry_days) : 180;
  const endsAt = new Date(nowMs + days * 86400000).toISOString();

  const title = mintTitle(r);
  const basic = {
    title,
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

  const res = await graphql(env, CREATE_MUTATION, { basic }, { store });

  // A FAILED CREATE IS NOT PROOF THAT NOTHING WAS CREATED. shopifyGraphQL returns ok:false for a
  // network failure, an abort and a userError alike, and a create that committed on Shopify before
  // the response was lost is indistinguishable from one that never happened — from here. So ask.
  let recovered = null;
  if (!res.ok) {
    // NEVER SENT is not the same as SENT-AND-UNKNOWN, and shopifyGraphQL already tells them apart:
    // it returns attempts: 0 (code 'not_configured') when the request never left this machine. There
    // is nothing on Shopify to look for in that case, so the refund is justified without asking, and
    // making the operator resolve a wedged row because credentials were missing would be a worse
    // outcome than the bug this fix exists to close.
    const neverSent = Number(res.attempts || 0) === 0;
    const found = neverSent
      ? { ok: true, node: null }
      : await findMintedDiscount(env, { title, code, store, graphql });
    if (!found.ok) {
      // CANNOT TELL. Refuse to decide rather than guess: refunding might hand back points for a code
      // that is live, and marking it failed would bury it. The row stays 'minting' with the code on
      // it, which is exactly the state revoke can now resolve once Shopify is reachable again.
      db.prepare("UPDATE keepers_redemptions SET error=? WHERE id=?")
        .run(`create failed and the recovery search also failed: ${JSON.stringify(found.errors || 'unknown').slice(0, 300)}`, Number(id));
      return { ok: false, reason: 'mint_unverifiable', detail: found.errors, code };
    }
    if (!found.node) {
      // Genuinely not created. NOW the refund is justified, which it always was in this case — the
      // bug was only ever that this branch was reached without asking.
      db.prepare("UPDATE keepers_redemptions SET status='failed', error=? WHERE id=?")
        .run(JSON.stringify(res.userErrors || res.errors || 'create_failed').slice(0, 500), Number(id));
      refundRedemption(db, id, { reason: 'mint_failed', nowMs });
      return { ok: false, reason: 'create_failed', detail: res.userErrors || res.errors };
    }
    // It exists after all. Fall through to the SAME echo check the happy path runs — an orphan is
    // still a code that has to be proven scoped before anyone is told it is theirs.
    recovered = found.node;
  }

  const node = recovered || res.data?.discountCodeBasicCreate?.codeDiscountNode;
  const gid = node?.id;

  // THE ECHO CHECK. A successful mutation with the wrong eligibility is a store-wide money leak that
  // reports as success, so this is not defensive — it is the security model.
  const bad = eligibilityProblem(node, r.customer_gid);
  if (bad) {
    if (gid) { try { await graphql(env, DEACTIVATE_MUTATION, { id: gid }, { store }); } catch { /* best effort */ } }
    db.prepare("UPDATE keepers_redemptions SET status='failed', discount_gid=?, error=? WHERE id=?")
      .run(gid || null, `eligibility mismatch: ${bad}`, Number(id));
    refundRedemption(db, id, { reason: 'eligibility_mismatch', nowMs });
    return { ok: false, reason: 'eligibility_mismatch', detail: bad, deactivated: Boolean(gid) };
  }

  // For a recovered node the authority on when it expires is the node, not the value we computed for
  // a request whose answer we never saw. They will normally agree; recording ours over Shopify's
  // would be inventing a fact about an object we did not observe being made.
  const settledEnds = (recovered && node?.codeDiscount?.endsAt) || endsAt;

  db.prepare(`
    UPDATE keepers_redemptions SET status='active', code=?, discount_gid=?, minted_at=?, expires_at=?, error=?
    WHERE id=?
  `).run(code, gid || null, new Date(nowMs).toISOString(), settledEnds,
    recovered ? 'created on Shopify but the response was lost; adopted by recovery search' : null, Number(id));

  return {
    ok: true, id: Number(id), code, discountGid: gid, expiresAt: settledEnds,
    percentOff: Number(r.percent_off),
    // Surfaced rather than swallowed: a recovered mint means a round trip was lost, and a run of them
    // is a network problem worth seeing on the admin page rather than a quiet success.
    ...(recovered ? { recovered: true } : {}),
  };
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
export async function revokeRedemption(env, db, id, { store = 'dev', nowMs = Date.now(), refund = true, graphql = shopifyGraphQL } = {}) {
  const r = db.prepare('SELECT * FROM keepers_redemptions WHERE id = ?').get(Number(id));
  if (!r) return { ok: false, reason: 'unknown redemption' };
  if (r.status === 'used') return { ok: false, reason: 'already used' };

  // A ROW WEDGED AT 'minting' HAS NO GID, AND THAT USED TO SKIP EVERY CHECK BELOW.
  //
  // discount_gid is written by the same UPDATE that marks a redemption active, so a row stuck at
  // 'minting' is stuck precisely because that UPDATE did not run — the gid is NULL by construction.
  // The whole fail-closed usage read lived inside `if (r.discount_gid)`, so revoke walked past it and
  // refunded with zero Shopify calls. The reasoning under it — "a row that never minted has
  // discount_gid NULL" — is true of 'requested' and false of 'minting', and nothing here could tell
  // them apart because discount_gid was the only thing it looked at. keepers.html makes it worse by
  // NAMING revoke as the fix for a wedged row, so the operator is led down the leaking path.
  //
  // The code is now persisted before the create, so a wedged row carries the one handle needed to ask
  // Shopify whether that code exists. If it does, this falls into the normal path below and the usage
  // read, the deactivate and the fail-closed refusal all apply to it exactly as they would to any
  // other code. If the search cannot run, refuse — same discipline as `usage_unreadable` below.
  let gid = r.discount_gid;
  if (!gid && r.code && r.status === 'minting') {
    const found = await findMintedDiscount(env, { title: mintTitle(r), code: r.code, store, graphql });
    if (!found.ok) {
      return { ok: false, reason: 'usage_unreadable', detail: found.errors, wedged: true };
    }
    if (found.node) {
      gid = found.node.id;
      db.prepare('UPDATE keepers_redemptions SET discount_gid=? WHERE id=?').run(gid, Number(id));
    }
  }

  if (gid) {
    // ASK SHOPIFY WHETHER IT WAS SPENT, before refunding anything. `r.status` is OUR copy, and this
    // module's whole premise is that our copy lags: markUsedByOrder runs off a webhook that Shopify's
    // own docs say not to rely on, and reconcileRedemptions — the second reading — only runs from the
    // 30-minute sweep, and only in mode 'apply'. So there is a routine window, up to half an hour
    // wide and unbounded in 'observe', in which a code has been spent on a real order and this row
    // still says 'active'.
    //
    // Revoking inside that window used to give the discount AND hand the points back, and then hide
    // the evidence: a 'revoked' row is excluded from reconcileRedemptions' scan (status='active') and
    // from markUsedByOrder's update (status IN ('active','used')), so neither usage reading could
    // ever catch up and the disagreement alarm could not fire.
    //
    // This read narrows the window to seconds. It cannot close it — a checkout in flight beats any
    // pre-read — but the residual is a race of seconds instead of a routine half-hour.
    const seen = await graphql(env, READ_QUERY, { id: gid }, { store });
    if (!seen.ok) {
      // FAIL CLOSED. A refund we cannot justify is money out the door; a refusal is a retry.
      return { ok: false, reason: 'usage_unreadable', detail: seen.userErrors || seen.errors };
    }
    const node = seen.data?.codeDiscountNode?.codeDiscount;
    const used = Number(node?.asyncUsageCount || 0);
    if (used > 0) {
      // It was spent. Record what we just learned rather than discarding it — this is exactly what
      // the lost webhook would have told us, and 'used' is the state both readings can still act on.
      // used_order_gid stays NULL: we know THAT it was spent, not on which order, and inventing a
      // link would be worse than admitting the gap.
      db.prepare("UPDATE keepers_redemptions SET status='used', used_at=COALESCE(used_at,?), error=? WHERE id=?")
        .run(new Date(nowMs).toISOString(), `spent on Shopify (asyncUsageCount ${used}); learned during a revoke attempt`, Number(id));
      return { ok: false, reason: 'already used', usage: used, learned: true };
    }

    const res = await graphql(env, DEACTIVATE_MUTATION, { id: gid }, { store });
    if (!res.ok) return { ok: false, reason: 'deactivate_failed', detail: res.userErrors || res.errors };
  }
  db.prepare("UPDATE keepers_redemptions SET status='revoked' WHERE id=?").run(Number(id));
  if (refund) refundRedemption(db, id, { reason: 'revoked', nowMs });
  return { ok: true, refunded: refund };
}
