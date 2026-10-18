// lib/shopify-stock-orders.mjs — a Shopify sale takes the card off the shelf, and off eBay.
//
// Until this existed nothing ingested a Shopify order for stock (only Keeper's Runs SKUs, through their
// own narrow poll), so a card that sold on the storefront stayed in_stock here and stayed live on eBay —
// a second buyer for a one-of-one (audit K1). This is S7's stock half (docs/SHOPIFY_CHANNEL_PLAN.md).
//
// THE ORDER LANDS IN THE EXISTING postsale TABLES, so applyStockDecrements runs UNCHANGED (§3.2). That
// function is the most carefully ordered in the repo (decrement-then-stamp, so a crash under-lists
// rather than oversells) and a second copy of it in another file is the worst trade available. The
// requirements are exactly what postsale-db.mjs says they are: the order id is namespaced
// ('shopify:<n>'), the buyer is namespaced ('shopify:<customer>' or 'shopify:guest:<order>'), and the
// row says channel = 'shopify'.
//
// shipped_status = 'external' IS LOAD-BEARING. Every eBay fulfilment path keys off shipped_status —
// the pack queue (IN_QUEUE_SQL wants 'unshipped'), the by-id GetOrders backstop (which would send a
// 'shopify:' id to eBay and fail the whole batch), the daily digest's bulk "mark shipped" (a
// CompleteSale per order) and the label-bought sweep. A Shopify order is packed from Shopify admin, so
// it is filed as already-external and none of those can see it. dispatchOrder refuses it by channel as
// a second wall.
//
// TWO WAYS IN, ONE INGEST. The webhook receiver (lib/shopify-hooks.mjs) hands deliveries to the
// `stock` consumer, which stores them durably before the ack; the 10-minute poll is the backup that
// makes a lost delivery a delay instead of a loss — Shopify's own advice is not to rely on webhooks.
// Both re-read the ORDER from the Admin API (a webhook is a trigger, never the data — the rule
// lib/keepers-ingest.mjs follows), and the ingest is idempotent on the order id, so neither needs to
// know about the other.
//
// LIVE STORE ONLY. The dev store holds rehearsal products that share shelf labels with real stock, and
// a test order there must never take a real card off the shelf.
import { shopifyGraphQL, firstErrorText, moneyToCents, resolveShop } from './channels/shopify-admin.mjs';
import { registerConsumer, loadConfig as loadHooksConfig } from './shopify-hooks.mjs';
import { getMeta, setMeta } from './postsale-db.mjs';
import { applyStockDecrements, reverseStockForOrder, buildInventoryLookup, matchLineItem } from './postsale.mjs';
import { reservedUnits } from './runs-reserve.mjs';

export const STORE = 'live';
export const CURSOR_KEY = 'shopify_stock_orders_cursor';
export const POLL_STATE_KEY = 'shopify_stock_orders_last_poll';
// THE EPOCH: the moment this first ran ARMED. An order Shopify processed before it is history — paid,
// packed and dealt with before this code existed — and is never ingested as a new sale, however recently
// Shopify touched it. The poll reads by updated_at, so without this an order paid last month and
// fulfilled, archived or refunded today (REFUNDED counts as paid, below) came back as a sale and took a
// real card off the shelf. Only an explicit `since` backfill reaches behind it.
export const EPOCH_KEY = 'shopify_stock_orders_epoch';
export const OVERLAP_MIN = 10;
// A backfill may reach back at most this far: read_orders sees 60 days, and a window near its edge can
// cross it mid-run and come back EMPTY rather than as an error (lib/keepers-reconcile.mjs).
export const MAX_BACKFILL_DAYS = 55;
const MAX_EVENT_ATTEMPTS = 10;

// Money that SETTLED. Matches Keeper's Runs (only PAID is a sale) plus the two states an order reaches
// after it was paid — a refund does not un-sell the card; a cancellation does, and has its own path.
// AUTHORIZED / PENDING / PARTIALLY_PAID wait: orders/paid fires when they settle, and the poll re-reads.
export const PAID_STATES = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const FAILED_STATES = new Set(['VOIDED', 'EXPIRED']);

const ORDER_FIELDS = `
  id name createdAt processedAt updatedAt cancelledAt test
  displayFinancialStatus currencyCode sourceName
  customer { id }
  totalPriceSet { shopMoney { amount currencyCode } }
  subtotalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 100) {
    nodes { id sku quantity name discountedTotalSet { shopMoney { amount currencyCode } } }
    pageInfo { hasNextPage }
  }`;

// Deliberately no shipping address, email or name: the order is packed from Shopify admin, so this side
// needs none of it, and the live store's PII position (D-022) is unsettled. A field never asked for is
// a field that cannot leak.
export const ORDER_QUERY = `query BkStockOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;
export const ORDERS_QUERY = `
query BkStockOrders($q: String!, $after: String) {
  orders(query: $q, first: 25, after: $after, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}`;

const tail = (gid) => String(gid || '').split('/').pop();
export const shopifyOrderId = (gid) => 'shopify:' + tail(gid);

// --- mapping (pure) --------------------------------------------------------------------------------

/** Shopify's order -> the postsale row shapes. Pure, so the money and status rules are table-testable. */
export function mapShopifyOrder(order) {
  const fin = String(order.displayFinancialStatus || '').toUpperCase();
  const paid = PAID_STATES.has(fin);
  const cancelled = !!order.cancelledAt;
  const customer = order.customer && order.customer.id ? 'shopify:' + tail(order.customer.id) : null;
  const lines = (order.lineItems?.nodes || []).map((li) => {
    const qty = Math.max(1, Number(li.quantity) || 1);
    const total = moneyToCents(li.discountedTotalSet?.shopMoney?.amount);
    return {
      line_id: li.id ? tail(li.id) : null,
      sku: li.sku ? String(li.sku).trim() : null,
      title: li.name || null,
      quantity: qty,
      // Per unit, rounded once (GR3). The order line is in the shop currency (AUD for this store).
      unit_price_cents: total != null ? Math.round(total / qty) : 0,
    };
  });
  return {
    order_id: shopifyOrderId(order.id),
    order_gid: order.id,
    name: order.name || null,
    buyer: customer || 'shopify:guest:' + tail(order.id),
    financial: fin || null,
    paid,
    payment_state: paid ? 'ok' : (FAILED_STATES.has(fin) ? 'failed' : 'pending'),
    paid_time: paid ? (order.processedAt || order.createdAt || null) : null,
    created_time: order.createdAt || null,
    cancel_state: cancelled ? 'cancelled' : 'none',
    currency: order.currencyCode || order.totalPriceSet?.shopMoney?.currencyCode || 'AUD',
    total_cents: moneyToCents(order.totalPriceSet?.shopMoney?.amount) || 0,
    subtotal_cents: moneyToCents(order.subtotalPriceSet?.shopMoney?.amount),
    test: !!order.test,
    truncated: !!order.lineItems?.pageInfo?.hasNextPage,
    lines,
  };
}

/**
 * A sealed POOL is sold on Shopify under its pool_sku, but stock is matched on each sealed_items row's
 * own sku (buildInventoryLookup), so a pool line would match nothing and sit pending forever. It is
 * split here, FIFO across the pool's held rows, into lines carrying the rows' own skus — and then
 * applyStockDecrements matches them like any other line. Units promised to a Keeper's Run are not
 * offered, for the same reason poolUnits does not count them.
 */
export function allocatePoolLine(tdb, poolSku, qty) {
  const rows = tdb.prepare(`SELECT id, sku, quantity FROM sealed_items
                             WHERE pool_sku = ? AND status IN ('in_stock','listed') AND quantity > 0
                             ORDER BY id`).all(String(poolSku));
  const out = [];
  let left = qty;
  for (const r of rows) {
    if (left <= 0) break;
    const free = Math.max(0, (Number(r.quantity) || 0) - reservedUnits(tdb, 'sealed', r.id));
    const take = Math.min(free, left);
    if (take > 0) { out.push({ sku: r.sku, quantity: take }); left -= take; }
  }
  return { parts: out, short: left };
}

function isPoolSku(tdb, sku) {
  if (!sku) return false;
  return !!tdb.prepare('SELECT 1 FROM sealed_pools WHERE pool_sku = ?').get(String(sku));
}

// --- writing it down -------------------------------------------------------------------------------

function buyerId(pdb, username) {
  pdb.prepare('INSERT OR IGNORE INTO buyers (ebay_username) VALUES (?)').run(username);
  const b = pdb.prepare('SELECT id FROM buyers WHERE ebay_username = ?').get(username);
  pdb.prepare(`UPDATE buyers SET last_seen_at = datetime('now') WHERE id = ?`).run(b.id);
  return b.id;
}

/**
 * Upsert one Shopify order. Lines are written ONCE, when the order is first seen: they are what the
 * stock decrement reads, and rewriting them would hand applyStockDecrements fresh unstamped lines for a
 * sale it has already applied. Status fields are refreshed every time.
 */
export function upsertShopifyOrder(pdb, tdb, mapped) {
  const prev = pdb.prepare('SELECT order_id, cancel_state, paid_time, payment_state FROM orders WHERE order_id = ?').get(mapped.order_id);
  const raw = JSON.stringify({
    source: 'shopify', name: mapped.name, financial: mapped.financial, test: mapped.test,
    lines: mapped.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
  });
  const warnings = [];
  if (!prev) {
    const bid = buyerId(pdb, mapped.buyer);
    pdb.prepare(`INSERT INTO orders (order_id, buyer_id, buyer_username, order_status, created_time, paid_time, currency,
                   total_cents, subtotal_cents, shipped_status, channel, payment_state, cancel_state, raw)
                 VALUES (?,?,?,?,?,?,?,?,?, 'external', 'shopify', ?,?,?)`)
      .run(mapped.order_id, bid, mapped.buyer, mapped.financial, mapped.created_time, mapped.paid_time, mapped.currency,
        mapped.total_cents, mapped.subtotal_cents ?? null, mapped.payment_state, mapped.cancel_state, raw);
    const ins = pdb.prepare(`INSERT INTO order_line_items (order_id, order_line_item_id, sku, title, quantity, unit_price_cents, channel)
                             VALUES (?,?,?,?,?,?, 'shopify')`);
    for (const l of mapped.lines) {
      if (isPoolSku(tdb, l.sku)) {
        const { parts, short } = allocatePoolLine(tdb, l.sku, l.quantity);
        for (const part of parts) ins.run(mapped.order_id, l.line_id, part.sku, l.title, part.quantity, l.unit_price_cents);
        if (short > 0) {
          // The pool could not cover it: the shortfall stays a line under the pool sku, which matches
          // nothing and is reported — sold on Shopify, not on the shelf.
          ins.run(mapped.order_id, l.line_id, l.sku, l.title, short, l.unit_price_cents);
          warnings.push(`${mapped.name || mapped.order_id}: Shopify sold ${l.quantity} of pool ${l.sku} but only ${l.quantity - short} were on the shelf`);
        }
      } else {
        ins.run(mapped.order_id, l.line_id, l.sku, l.title, l.quantity, l.unit_price_cents);
      }
    }
    if (mapped.truncated) warnings.push(`${mapped.name || mapped.order_id} has more than 100 lines — only the first 100 were read`);
    return { created: true, becameCancelled: false, bornCancelled: mapped.cancel_state === 'cancelled', warnings };
  }
  pdb.prepare(`UPDATE orders SET order_status = ?, paid_time = COALESCE(paid_time, ?), payment_state = ?,
                 cancel_state = CASE WHEN cancel_state = 'cancelled' THEN cancel_state ELSE ? END, raw = ?
               WHERE order_id = ?`)
    .run(mapped.financial, mapped.paid_time, mapped.payment_state, mapped.cancel_state, raw, mapped.order_id);
  const becameCancelled = prev.cancel_state !== 'cancelled' && mapped.cancel_state === 'cancelled';
  return { created: false, becameCancelled, bornCancelled: false, warnings };
}

/**
 * The card a Shopify line names, BEFORE the decrement: already sold here, or fewer on the shelf than
 * Shopify just sold. Either means two channels sold one object, and the decrement would stamp the line
 * as applied with nothing to say so — so it is named and alerted instead.
 */
function doubleSales(tdb, mapped) {
  const lookup = buildInventoryLookup(tdb);
  if (!lookup) return [];
  const out = [];
  for (const l of mapped.lines) {
    if (!l.sku) continue;
    const m = matchLineItem(lookup, { sku: l.sku });
    if (!m) continue;
    const t = m.kind === 'sealed' ? 'sealed_items' : 'inventory_items';
    const row = tdb.prepare(`SELECT status, quantity FROM ${t} WHERE id = ?`).get(m.id);
    if (!row) continue;
    if (row.status === 'sold' || (Number(row.quantity) || 0) < l.quantity) {
      out.push({ sku: l.sku, kind: m.kind, item_id: m.id, status: row.status, on_shelf: row.quantity, sold_on_shopify: l.quantity });
    }
  }
  return out;
}

/** The epoch, set the first time it is asked for (the first armed boot, poll or webhook pass). */
export function ensureEpoch(pdb, nowMs = Date.now()) {
  const cur = getMeta(pdb, EPOCH_KEY);
  if (cur) return cur;
  const at = new Date(nowMs).toISOString();
  setMeta(pdb, EPOCH_KEY, at);
  console.log('[shopify-stock] epoch set at ' + at + ' — Shopify orders processed before this are never ingested as new sales');
  return at;
}

/** Was this order processed before the epoch? Unknown times are treated as current (ingested). */
export function beforeEpoch(pdb, order) {
  const epoch = getMeta(pdb, EPOCH_KEY);
  if (!epoch) return false;
  const t = Date.parse(order.processedAt || order.createdAt || '');
  return Number.isFinite(t) && t < Date.parse(epoch);
}

/**
 * Ingest one order node (from a by-id read or a poll page). Never throws.
 * Returns { ok, order_id, name, created, paid, cancelled, stock, reversal, doubleSales, warnings }.
 * `backfill` (an explicit `since` poll) is the only way to ingest an order from before the epoch.
 */
export function ingestOrderNode(ctx, order, { backfill = false } = {}) {
  const { pdb, tdb } = ctx;
  if (!order || !order.id) return { ok: false, error: 'no order' };
  const mapped = mapShopifyOrder(order);
  if (mapped.test) return { ok: true, order_id: mapped.order_id, name: mapped.name, skipped: 'test order — no stock moved' };
  try {
    const known = !!pdb.prepare('SELECT 1 FROM orders WHERE order_id = ?').get(mapped.order_id);
    // An order we already hold is always kept current (a cancellation must still restock). An order we
    // have never seen, processed before the epoch, is history: it is not adopted, and no stock moves.
    if (!known && !backfill && beforeEpoch(pdb, order)) {
      return { ok: true, order_id: mapped.order_id, name: mapped.name, skipped: 'before_epoch — processed before cross-channel sync was armed' };
    }
    const doubles = !known && mapped.paid && mapped.cancel_state !== 'cancelled' ? doubleSales(tdb, mapped) : [];
    const up = upsertShopifyOrder(pdb, tdb, mapped);
    // Unchanged, and run for every ingest: it sweeps every paid, uncancelled, unapplied line in the
    // table, so it is also what catches a line whose payment settled since the last pass.
    const stock = applyStockDecrements(pdb, tdb);
    const reversal = up.becameCancelled ? reverseStockForOrder(pdb, mapped.order_id, tdb) : null;
    for (const d of doubles) {
      const msg = `DOUBLE SALE — Shopify order ${mapped.name || mapped.order_id} sold ${d.sold_on_shopify} × ${d.sku}, `
        + `but this side shows it ${d.status === 'sold' ? 'already sold' : `with only ${d.on_shelf} on the shelf`}. `
        + 'Contact the buyer before packing.';
      console.error('[shopify-stock] ' + msg);
      try { ctx.alert && ctx.alert(msg); } catch { /* logged above */ }
    }
    for (const w of up.warnings) console.warn('[shopify-stock] ' + w);
    if (reversal && (reversal.reversed || reversal.skipped?.length)) {
      console.log(`[shopify-stock] ${mapped.name || mapped.order_id} cancelled: ${reversal.reversed} line(s) back on the shelf`
        + (reversal.skipped?.length ? `, ${reversal.skipped.length} need a human` : '')
        + ' — nothing is relisted anywhere automatically');
    }
    return {
      ok: true, order_id: mapped.order_id, name: mapped.name, created: up.created, paid: mapped.paid,
      cancelled: mapped.cancel_state === 'cancelled', becameCancelled: up.becameCancelled,
      stock, reversal, doubleSales: doubles, warnings: up.warnings,
    };
  } catch (e) {
    return { ok: false, order_id: mapped.order_id, error: String(e?.message || e) };
  }
}

export async function fetchShopifyOrder(env, orderGid, { fetchImpl, graphql = null } = {}) {
  const call = graphql || shopifyGraphQL;
  const res = await call(env, ORDER_QUERY, { id: String(orderGid) }, { store: STORE, fetchImpl, estimate: 20 });
  if (!res.ok) return { ok: false, error: firstErrorText(res) || `HTTP ${res.httpStatus}` };
  if (!res.data?.order) return { ok: false, error: 'not_found' };
  return { ok: true, order: res.data.order };
}

// --- the webhook consumer --------------------------------------------------------------------------

export const TOPICS = Object.freeze(['orders/paid', 'orders/cancelled']);

/**
 * record — inside the request, before the ack. Fast, and THROWS if it could not store (the receiver
 * turns a throw into a 503 so Shopify retries for 48 hours — acking something nobody stored loses it).
 */
export function recordStockDelivery(pdb, event, { shop = loadHooksConfig().shop } = {}) {
  if (shop !== STORE) return { stored: false, reason: `listener is for the ${shop} store — only live orders move stock` };
  const b = event?.body || {};
  const gid = b.admin_graphql_api_id || (b.id ? `gid://shopify/Order/${b.id}` : null);
  if (!gid) return { stored: false, reason: 'no order id in the delivery' };
  pdb.prepare(`INSERT OR IGNORE INTO shopify_order_events (webhook_id, topic, shop_domain, order_gid) VALUES (?,?,?,?)`)
    .run(event.webhookId || null, event.topic || null, event.shopDomain || null, String(gid));
  return { stored: true };
}

/** Work the stored deliveries: re-read each order and ingest it. One order is read once per pass. */
export async function processStockEvents(env, ctx, { limit = 50 } = {}) {
  const { pdb } = ctx;
  ensureEpoch(pdb);
  const pending = pdb.prepare(`SELECT id, order_gid FROM shopify_order_events
                                WHERE processed_at IS NULL AND attempts < ? ORDER BY id LIMIT ?`).all(MAX_EVENT_ATTEMPTS, limit);
  const byOrder = new Map();
  for (const e of pending) {
    if (!byOrder.has(e.order_gid)) byOrder.set(e.order_gid, []);
    byOrder.get(e.order_gid).push(e.id);
  }
  const results = [];
  for (const [gid, ids] of byOrder) {
    const got = await fetchShopifyOrder(env, gid, { fetchImpl: ctx.fetchImpl, graphql: ctx.graphql });
    const out = got.ok ? ingestOrderNode(ctx, got.order) : { ok: false, error: got.error };
    const ph = ids.map(() => '?').join(',');
    if (out.ok) {
      pdb.prepare(`UPDATE shopify_order_events SET processed_at = datetime('now'), attempts = attempts + 1, last_error = NULL, outcome = ?
                   WHERE id IN (${ph})`).run(JSON.stringify(summarise(out)), ...ids);
    } else {
      pdb.prepare(`UPDATE shopify_order_events SET attempts = attempts + 1, last_error = ? WHERE id IN (${ph})`).run(String(out.error || 'failed'), ...ids);
      console.warn(`[shopify-stock] could not ingest ${gid}: ${out.error} — will retry`);
    }
    results.push({ order_gid: gid, ...summarise(out) });
  }
  return { processed: results.length, results };
}

const summarise = (o) => ({
  ok: !!o.ok, order_id: o.order_id || null, name: o.name || null, created: !!o.created, paid: !!o.paid,
  cancelled: !!o.cancelled, applied: o.stock?.applied ?? 0, reversed: o.reversal?.reversed ?? 0,
  double_sales: (o.doubleSales || []).length, skipped: o.skipped || null, error: o.error || null,
});

// --- the backup poll -------------------------------------------------------------------------------

/**
 * pollShopifyOrders — read everything that changed since the cursor and ingest it.
 *
 * THE CURSOR MOVES ON A CLEAN RUN EVEN WHEN NOTHING CHANGED. Keepers' sweep advances only to the newest
 * order it saw, so on a quiet store it never moves and eventually falls out of read_orders' 60-day
 * window, where the query returns an EMPTY PAGE rather than an error (audit K4). Here a clean run moves
 * the cursor to the later of the newest order seen and (run start − overlap), so a quiet store keeps
 * up. A run that failed or was truncated holds it: delay is recoverable, loss is not.
 */
//
// THE FIRST RUN STARTS FROM NOW, not from a month back. An order paid on live before this existed —
// a test purchase the owner refunded without cancelling, say — would otherwise take a real card off the
// shelf and then, through the sync worker, end its live eBay listing, all on the first boot after a
// deploy. The same rule as the stock ledger's cursor: history is never replayed automatically.
// `since` is the deliberate backfill (POST /api/channels/shopify/poll {since}, DIAG-gated).
export async function pollShopifyOrders(env, ctx, { nowMs = Date.now(), maxOrders = 500, since: sinceOverride = null } = {}) {
  const { pdb } = ctx;
  const started = new Date(nowMs).toISOString();
  ensureEpoch(pdb, nowMs);
  const stored = getMeta(pdb, CURSOR_KEY);
  let cursor = stored || new Date(nowMs).toISOString();
  if (sinceOverride) {
    const t = Date.parse(sinceOverride);
    if (!Number.isFinite(t)) return { at: started, ok: false, error: `since ${sinceOverride} is not a date` };
    if (nowMs - t > MAX_BACKFILL_DAYS * 86400000) {
      return { at: started, ok: false, error: `since is more than ${MAX_BACKFILL_DAYS} days back — read_orders cannot see that far reliably` };
    }
    cursor = new Date(t).toISOString();
  }
  const since = new Date(Date.parse(cursor) - OVERLAP_MIN * 60000).toISOString();
  const call = ctx.graphql || shopifyGraphQL;
  let after = null, seen = 0, ingested = 0, failed = null, truncated = false, newest = cursor;
  const problems = [];
  while (true) {
    const res = await call(env, ORDERS_QUERY, { q: `updated_at:>='${since}' status:any`, after }, { store: STORE, fetchImpl: ctx.fetchImpl, estimate: 40 });
    if (!res.ok) { failed = firstErrorText(res) || `HTTP ${res.httpStatus}`; break; }
    const conn = res.data?.orders;
    for (const node of conn?.nodes || []) {
      if (seen >= maxOrders) { truncated = true; break; }
      seen++;
      if (node.updatedAt && node.updatedAt > newest) newest = node.updatedAt;
      const out = ingestOrderNode(ctx, node, { backfill: !!sinceOverride });
      if (out.ok && out.created) ingested++;
      if (!out.ok) problems.push({ order: node.id, error: out.error });
    }
    if (truncated || !conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  const clean = !failed && !truncated && !problems.length;
  let advancedTo = null;
  if (clean) {
    const floor = new Date(nowMs - OVERLAP_MIN * 60000).toISOString();
    advancedTo = newest > floor ? newest : floor;
    // Compared with what is STORED, not with this run's start: a first run must leave a cursor behind
    // even when nothing newer arrived, and a backfill must never move a later cursor backwards.
    if (!stored || advancedTo > stored) setMeta(pdb, CURSOR_KEY, advancedTo); else advancedTo = null;
  }
  const summary = {
    at: started, ok: !failed, error: failed, cursor, advanced_to: advancedTo, held: !clean,
    seen, ingested, truncated, problems: problems.slice(0, 20),
    // read_orders is the scope this needs. A refusal naming it is the most likely reason a live store
    // that is selling shows nothing here, so it is said in plain words rather than left in the error.
    hint: failed && /access|scope|denied|read_orders/i.test(failed) ? 'the live app needs the read_orders scope' : null,
  };
  try { setMeta(pdb, POLL_STATE_KEY, JSON.stringify(summary)); } catch { /* status only */ }
  if (failed) console.warn('[shopify-stock] poll failed — ' + failed + (summary.hint ? ` (${summary.hint})` : ''));
  else if (ingested) console.log(`[shopify-stock] poll: ${ingested} new Shopify order(s) ingested (${seen} seen)`);
  return summary;
}

export function liveStoreConfigured(env) {
  try { resolveShop(env, STORE); } catch { return false; }
  return !!(String(env.SHOPIFY_CLIENT_ID || '').trim() && String(env.SHOPIFY_CLIENT_SECRET || '').trim());
}

export function shopifyStockState(pdb) {
  let lastPoll = null;
  try { lastPoll = JSON.parse(getMeta(pdb, POLL_STATE_KEY) || 'null'); } catch { /* none yet */ }
  const pending = pdb.prepare('SELECT COUNT(*) n FROM shopify_order_events WHERE processed_at IS NULL').get().n;
  const stuck = pdb.prepare('SELECT COUNT(*) n FROM shopify_order_events WHERE processed_at IS NULL AND attempts >= ?').get(MAX_EVENT_ATTEMPTS).n;
  const lastEvent = pdb.prepare('SELECT topic, received_at, processed_at, last_error FROM shopify_order_events ORDER BY id DESC LIMIT 1').get() || null;
  const orders = pdb.prepare("SELECT COUNT(*) n FROM orders WHERE channel = 'shopify'").get().n;
  return { cursor: getMeta(pdb, CURSOR_KEY), epoch: getMeta(pdb, EPOCH_KEY), last_poll: lastPoll, pending_events: pending, stuck_events: stuck, last_event: lastEvent, shopify_orders: orders };
}

/**
 * Register the `stock` consumer on the shared receiver. Idempotent by name.
 *
 * `armed()` is the cross-channel switch. While it is off the consumer stores NOTHING (the receiver acks a
 * delivery no consumer stored, so Shopify does not retry it), which is exactly how the box behaved
 * before this existed: a Shopify order moves no stock and touches no eBay listing.
 */
export function stockConsumerRecord({ pdbFn, armed = () => false }) {
  return (event) => (armed()
    ? recordStockDelivery(pdbFn(), event)
    : { stored: false, reason: 'cross-channel sync is off (CROSS_CHANNEL_SYNC is not on) — Shopify orders are not read for stock' });
}

export function registerStockConsumer({ pdbFn, schedule, armed = () => false }) {
  return registerConsumer({ name: 'stock', topics: [...TOPICS], record: stockConsumerRecord({ pdbFn, armed }), schedule });
}
