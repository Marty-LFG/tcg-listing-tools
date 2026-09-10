// lib/runs-orders.mjs — turning a storefront order into a ledger entry.
//
// A NARROW POLL, DELIBERATELY, and not the general postsale ingest. Three reasons, in order of weight:
//
//   1. THE STOCK IS ALREADY SPOKEN FOR. A run bundle's units are drawn down at PACK time by
//      consumeReservation, off run_reservations. An order line that also decremented would be a second
//      draw on the same physical objects. A run order carries no stock consequence at all — only a
//      ledger one.
//   2. orders.buyer_id is NOT NULL REFERENCES buyers(id), and buyers.ebay_username is NOT NULL UNIQUE.
//      Ingesting a Shopify order needs the channel columns and the `shopify:` / `shopify:guest:`
//      namespacing that docs/SHOPIFY_CHANNEL_PLAN.md specifies and that does not exist yet. Building the
//      cross-channel order path as a side effect of this module would be building it in the wrong file.
//   3. applyStockDecrements leaves an unmatched line pending forever with no alert. A BK-RUN-* SKU
//      matches nothing there, so it would join that pile — which is why it is excluded in SQL, and why
//      this poll exists to give those lines somewhere to go instead.
//
// THE IDEMPOTENCY KEY IS THE LINE ITEM, not the order. run_ledger_orders has a UNIQUE index on
// (channel, line_ref) and the binding is written in the SAME transaction as the entry, so re-reading an
// overlapping window of orders appends nothing the second time and the two can never disagree.

import { shopifyGraphQL, firstErrorText } from './channels/shopify-admin.mjs';
import { isRunSku, parseRunSku } from './runs-shopify.mjs';
import { appendSale, appendCancel, availability, instant } from './runs-ledger.mjs';

export const ORDERS_PAGE = 50;

const ORDERS = `
query BkRunOrders($q: String!, $first: Int!, $after: String) {
  orders(query: $q, first: $first, after: $after, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt processedAt cancelledAt updatedAt displayFinancialStatus
      customer { id }
      lineItems(first: 50) { nodes { id sku quantity } }
    }
  }
}`;

/** The poll's cursor. Job state, kept off the runs row so a job never writes beside the commitment. */
export const ordersCursor = (db, runId) =>
  db.prepare("SELECT value FROM run_meta WHERE run_id = ? AND key = 'orders_cursor'").get(+runId)?.value || null;

export const setOrdersCursor = (db, runId, iso) =>
  db.prepare(`INSERT INTO run_meta (run_id, key, value, updated_at) VALUES (?, 'orders_cursor', ?, datetime('now'))
              ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(+runId, iso);

/**
 * The run's own lines in one order, ASCENDING BY BUNDLE NUMBER.
 *
 * The sort is not cosmetic. §12.2 permits a buyer to take three numbers in one order, and the chain must
 * be reproducible — so the order in which one order's lines enter it cannot depend on how Shopify happened
 * to return them.
 *
 * Filtered on the run's OWN public id as well as the SKU shape, because a second run's product lives in
 * the same store and its lines must not append to this chain.
 */
export function runLinesOf(order, run) {
  const out = [];
  for (const li of order?.lineItems?.nodes || []) {
    if (!isRunSku(li.sku)) continue;
    const parsed = parseRunSku(li.sku);
    if (!parsed || parsed.publicId !== String(run.public_id).toUpperCase()) continue;
    out.push({ bundleNo: parsed.bundleNo, lineRef: li.id, sku: li.sku, qty: li.quantity });
  }
  return out.sort((a, b) => a.bundleNo - b.bundleNo);
}

export async function fetchRunOrders(env, {
  run, since, store = 'dev', fetchImpl, graphql = null, limit = ORDERS_PAGE, after = null,
} = {}) {
  const call = graphql || shopifyGraphQL;
  const q = since ? `updated_at:>='${since}' status:any` : 'status:any';
  const res = await call(env, ORDERS, { q, first: limit, after }, { store, fetchImpl, estimate: 30 });
  if (!res.ok) throw new Error(`reading orders: ${firstErrorText(res) || `HTTP ${res.httpStatus}`}`);
  return {
    orders: res.data?.orders?.nodes || [],
    hasNext: !!res.data?.orders?.pageInfo?.hasNextPage,
    cursor: res.data?.orders?.pageInfo?.endCursor || null,
  };
}

const alreadyBound = (db, lineRef) =>
  !!db.prepare("SELECT 1 FROM run_ledger_orders WHERE channel = 'shopify' AND line_ref = ?").get(String(lineRef));

/**
 * Read orders and append what is new.
 *
 * A REFUSAL IS COLLECTED AND NAMED, never swallowed. A sale of a number the ledger already accounted for
 * is a real incident — it means the storefront let a second unit through — and an operator needs the
 * bundle number, not a counter.
 */
export async function ingestRunOrders(env, db, {
  runId, store = 'dev', fetchImpl, graphql = null, now = null, actor = null, windowMinutes = 10,
} = {}) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  const out = { seen: 0, appended: 0, duplicates: 0, cancelled: 0, refused: [], errors: [] };

  // Overlap the window by a few minutes; the line-item uniqueness makes re-reading free, and an order
  // updated exactly on the boundary is otherwise missed forever.
  const from = ordersCursor(db, run.id) || run.locked_at;
  const since = from ? new Date(Date.parse(from) - windowMinutes * 60_000).toISOString() : null;

  let after = null;
  let newest = from;
  do {
    let page;
    try { page = await fetchRunOrders(env, { run, since, store, fetchImpl, graphql, after }); }
    catch (e) { out.errors.push(String(e?.message || e)); break; }

    for (const order of page.orders) {
      out.seen++;
      if (order.updatedAt && (!newest || Date.parse(order.updatedAt) > Date.parse(newest))) newest = order.updatedAt;
      const lines = runLinesOf(order, run);
      if (!lines.length) continue;

      // An unpaid order is not a sale — the same reason PAID_SQL exists in the postsale sweep.
      const paid = String(order.displayFinancialStatus || '').toUpperCase() === 'PAID';

      for (const line of lines) {
        if (alreadyBound(db, line.lineRef)) {
          out.duplicates++;
          // A previously ingested order that has since been cancelled releases its number, but only
          // before dispatch — appendCancel enforces that.
          if (order.cancelledAt) {
            try {
              const bound = db.prepare(`SELECT l.ref FROM run_ledger l JOIN run_ledger_orders o ON o.entry_id = l.id
                                         WHERE o.channel = 'shopify' AND o.line_ref = ?`).get(line.lineRef);
              const a = availability(db, run.id);
              if (bound?.ref && !a.cancelled.has(bound.ref)) {
                await appendCancel(db, run.id, {
                  token: bound.ref, reason: 'order cancelled', occurredAt: instant(order.cancelledAt), actor,
                });
                out.cancelled++;
              }
            } catch (e) { out.refused.push({ lineRef: line.lineRef, why: String(e?.message || e) }); }
          }
          continue;
        }
        if (!paid) continue;
        if (order.cancelledAt) continue;   // never ingested, and already dead

        try {
          await appendSale(db, run.id, {
            bundleNo: line.bundleNo,
            channel: 'sale_online',
            occurredAt: instant(order.processedAt || order.createdAt),
            order: {
              channel: 'shopify', store, orderRef: order.id, orderName: order.name,
              lineRef: line.lineRef, buyerRef: order.customer?.id || null,
            },
            actor,
          });
          out.appended++;
        } catch (e) {
          out.refused.push({ lineRef: line.lineRef, bundleNo: line.bundleNo, why: String(e?.message || e) });
        }
      }
    }
    after = page.hasNext ? page.cursor : null;
  } while (after);

  if (newest && newest !== from) setOrdersCursor(db, run.id, newest);
  return out;
}

/**
 * Compare what the ledger says with what Shopify last told us, and REPORT rather than reconcile.
 *
 * A drift is either an oversell the storefront allowed or a mirror write that failed, and the two need
 * opposite responses. Silently "fixing" it would erase the evidence of which.
 */
export function availabilityDrift(db, runId) {
  const a = availability(db, runId);
  const mirror = db.prepare(`SELECT sl.sku, sl.available_qty FROM shopify_listings sl
                               JOIN run_bundles b ON b.id = sl.item_id
                              WHERE sl.kind = 'run' AND b.run_id = ?`).all(+runId);
  const drift = [];
  for (const row of mirror) {
    const no = parseRunSku(row.sku)?.bundleNo;
    if (no == null) continue;
    const ledgerSaysAvailable = a.available.includes(no);
    const storeSaysAvailable = (row.available_qty ?? 0) > 0;
    if (ledgerSaysAvailable !== storeSaysAvailable) {
      drift.push({
        bundle_no: no,
        ledger: ledgerSaysAvailable ? 'available' : 'accounted for',
        storefront: storeSaysAvailable ? 'available' : 'unavailable',
      });
    }
  }
  return { ok: !drift.length, drift, available: a.available };
}
