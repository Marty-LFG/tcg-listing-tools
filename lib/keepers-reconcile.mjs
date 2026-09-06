// lib/keepers-reconcile.mjs — the correctness guarantee.
//
// Shopify's own documentation says not to rely on webhook delivery and to run reconciliation jobs.
// This is that job. The webhook is a latency optimisation; THIS is what makes the ledger right.
//
// That framing is borrowed verbatim from lib/ebay-notify-react.mjs, and it matters more here than it
// did there, because there at least the poll was the primary path. Here the sweep is the only thing
// standing between a lost delivery and a customer who silently never earned anything for an order
// they placed.
//
// THE CURSOR HOLD. The cursor advances ONLY if every page of a run succeeded and the run was not
// truncated. A window that was not fully read is a window we have not read; advancing past it loses
// orders rather than delaying them. Delay is recoverable and invisible to the customer; loss is
// neither.
import { shopifyGraphQL } from './channels/shopify-admin.mjs';
import { ingestOrder } from './keepers-ingest.mjs';
import { getMeta, setMeta, releaseHeldEvents } from './keepers-db.mjs';

export const CURSOR_KEY = 'orders_cursor';
export const FLOOR_KEY = 'orders_window_floor_hit';

// read_orders grants the last 60 days and nothing older. read_all_orders is a separate,
// approval-gated scope we do not hold.
export const ORDER_WINDOW_DAYS = 60;
// How close to the edge we allow the cursor to drift before refusing to sweep. Not paranoia: a run
// that starts inside the window and pages slowly can cross it mid-run.
export const WINDOW_MARGIN_DAYS = 5;

export const ORDERS_QUERY = `
query($q: String!, $after: String) {
  orders(query: $q, first: 50, after: $after, sortKey: UPDATED_AT, reverse: false) {
    pageInfo { hasNextPage endCursor }
    nodes { id updatedAt }
  }
}`;

/**
 * windowFloorProblem(cursorIso, opts)
 *
 * THE TRAP THIS EXISTS FOR, and it is the kind that reports green for a year.
 *
 * If the cursor falls below now-60d, `orders(query: "updated_at:>=…")` returns nothing for the part of
 * the range we are no longer permitted to see. Not an error. Not a partial result with a warning — an
 * empty page, which is indistinguishable from "nothing changed". The sweep would then report a clean
 * run, advance nothing, and quietly stop reconciling anything older than the window while continuing
 * to look perfectly healthy on /api/status.
 *
 * So: refuse, say so loudly, and let a human decide whether to accept the gap or request
 * read_all_orders. Returns a problem string, or null.
 */
export function windowFloorProblem(cursorIso, { nowMs = Date.now(), windowDays = ORDER_WINDOW_DAYS, marginDays = WINDOW_MARGIN_DAYS } = {}) {
  if (!cursorIso) return null;                       // no cursor yet: the first run picks its own start
  const t = Date.parse(cursorIso);
  if (!Number.isFinite(t)) return `cursor ${cursorIso} is not a date`;
  const ageDays = (nowMs - t) / 86400000;
  if (ageDays > windowDays) {
    return `cursor is ${Math.floor(ageDays)} days old, past the ${windowDays}-day read_orders window — `
      + 'orders older than that return an EMPTY page rather than an error, so a sweep from here would '
      + 'report clean while reconciling nothing. Accept the gap deliberately (move the cursor forward) '
      + 'or request the read_all_orders scope.';
  }
  if (ageDays > windowDays - marginDays) {
    return `cursor is ${Math.floor(ageDays)} days old and within ${marginDays} days of the `
      + `${windowDays}-day read_orders window — a slow run could cross the edge mid-sweep.`;
  }
  return null;
}

/** The default starting point for a store that has never swept: comfortably inside the window. */
export function defaultCursor({ nowMs = Date.now(), daysBack = ORDER_WINDOW_DAYS - WINDOW_MARGIN_DAYS - 5 } = {}) {
  return new Date(nowMs - daysBack * 86400000).toISOString();
}

/**
 * sweepOrders — re-read everything that changed since the cursor and bring the ledger to match.
 *
 * Every order goes through ingestOrder, which is idempotent by schema, so this is safe to run
 * alongside the webhook path with no coordination between them. That is the whole point of putting
 * idempotency in the database rather than in a caller.
 *
 * Returns a summary. Never throws: a sweep that dies takes the scheduler with it.
 */
export async function sweepOrders(env, db, {
  rules, store = 'dev', maxPerRun = 500, nowMs = Date.now(), knownCodes = [], codePrefix = '',
  observeOnly = false, apply = true,
} = {}) {
  const started = new Date(nowMs).toISOString();
  const cursor = getMeta(db, CURSOR_KEY) || defaultCursor({ nowMs });

  const floor = windowFloorProblem(cursor, { nowMs });
  const hardFloor = floor && floor.includes('past the');
  if (hardFloor) {
    // Refuse rather than sweep a window we cannot actually see.
    setMeta(db, FLOOR_KEY, started);
    return { ok: false, at: started, cursor, error: 'window_floor', detail: floor, seen: 0, ingested: 0 };
  }
  if (floor) setMeta(db, FLOOR_KEY, started);

  const q = `updated_at:>='${cursor}' status:any`;
  let after = null;
  let pages = 0;
  let seen = 0;
  let ingested = 0;
  let truncated = false;
  let failed = null;
  let maxUpdatedAt = cursor;
  const problems = [];

  while (true) {
    const res = await shopifyGraphQL(env, ORDERS_QUERY, { q, after }, { store });
    if (!res.ok) { failed = res.errors || res.userErrors || 'query_failed'; break; }
    const conn = res.data?.orders;
    const nodes = conn?.nodes || [];
    pages++;

    for (const n of nodes) {
      if (seen >= maxPerRun) { truncated = true; break; }
      seen++;
      if (n.updatedAt && n.updatedAt > maxUpdatedAt) maxUpdatedAt = n.updatedAt;
      if (!apply) continue;
      const out = await ingestOrder(env, db, n.id, { rules, store, knownCodes, codePrefix, observeOnly });
      if (out.ok) { if (out.wrote) ingested += out.wrote; }
      else problems.push({ orderGid: n.id, error: out.error });
    }

    if (truncated || !conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  // THE CURSOR HOLD. Everything has to have gone right, or the window stays open.
  const clean = !failed && !truncated && problems.length === 0;
  if (clean && apply && maxUpdatedAt > cursor) setMeta(db, CURSOR_KEY, maxUpdatedAt);

  // Held referral awards whose window has passed become countable. Done here rather than on its own
  // timer because it is cheap, needs no network, and belongs to the same "make the ledger right" job.
  const released = apply ? releaseHeldEvents(db, { now: new Date(nowMs).toISOString() }) : 0;

  return {
    ok: !failed,
    at: started,
    cursor, cursorAdvancedTo: clean && apply && maxUpdatedAt > cursor ? maxUpdatedAt : null,
    cursorHeld: !clean,
    holdReason: failed ? 'query_failed' : truncated ? 'truncated' : problems.length ? 'order_errors' : null,
    windowWarning: floor || null,
    pages, seen, ingested, released,
    problems: problems.slice(0, 20),
    problemCount: problems.length,
    error: failed || null,
  };
}

/**
 * driftReport — what the ledger holds that the orders it came from cannot explain.
 *
 * Three shapes, and only one of them is repaired automatically:
 *
 *   missing    an accruing order with no accrual event. The sweep repairs these by re-ingesting, and
 *              the unique index makes that safe even against a webhook landing simultaneously.
 *   extra      an accrual event for an order we believe does not accrue, or for no order at all.
 *              NEVER deleted. A ledger that silently removes rows is not a ledger — it is flagged and
 *              a human decides.
 *   unlinked   events with no owner. Reported so they are visible rather than quietly uncounted.
 */
export function driftReport(db) {
  const missing = db.prepare(`
    SELECT o.order_gid, o.order_number FROM keepers_orders o
    WHERE o.accrues = 1
      AND NOT EXISTS (
        SELECT 1 FROM keepers_events e
        WHERE e.source_ref = o.order_gid AND e.kind = 'order_accrual'
      )
    LIMIT 200
  `).all();

  const extra = db.prepare(`
    SELECT e.id, e.source_ref, e.xp_delta, e.points_delta FROM keepers_events e
    WHERE e.kind = 'order_accrual'
      AND NOT EXISTS (
        SELECT 1 FROM keepers_orders o WHERE o.order_gid = e.source_ref AND o.accrues = 1
      )
    LIMIT 200
  `).all();

  const unlinked = db.prepare(`
    SELECT source_ref, COUNT(*) AS n FROM keepers_events
    WHERE customer_gid IS NULL GROUP BY source_ref LIMIT 200
  `).all();

  return {
    missing, extra, unlinked,
    counts: { missing: missing.length, extra: extra.length, unlinked: unlinked.length },
    clean: missing.length === 0 && extra.length === 0,
  };
}
