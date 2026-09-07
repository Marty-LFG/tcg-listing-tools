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
/**
 * cursorDecision — may this run move the orders cursor, and if not, why not.
 *
 * Extracted as a pure function because the bug it encodes was invisible for exactly as long as the
 * rule lived inline: sweepOrders reaches Shopify, so nothing in the suite ever drove it, and the
 * condition was `clean && apply` with no mention of the mode. Under observe that advanced the cursor
 * past orders the run had deliberately not recorded, and the loss was unrecoverable and invisible —
 * driftReport joins from a table observe never writes.
 *
 * A rule with three inputs and one output is worth eight assertions. Now it has them.
 *
 * @param {{clean:boolean, apply:boolean, observeOnly:boolean}} state
 * @returns {{advance:boolean, holdReason:string|null}}
 */
export function cursorDecision({ clean, apply, observeOnly, failed = false, truncated = false, problems = 0 }) {
  // Order matters: the most specific real fault wins the explanation, and 'observe' beats 'dry_run'
  // because a dry run in observe mode is held by the mode, not by the flag.
  if (!clean) {
    return {
      advance: false,
      holdReason: failed ? 'query_failed' : truncated ? 'truncated' : problems ? 'order_errors' : 'not_clean',
    };
  }
  if (observeOnly) return { advance: false, holdReason: 'observe' };
  if (!apply) return { advance: false, holdReason: 'dry_run' };
  return { advance: true, holdReason: null };
}

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
  //
  // AND OBSERVE MODE MUST NOT MOVE IT. This read `clean && apply` and nothing else, which quietly
  // broke the guarantee the mode is sold on. Under observe, ingestOrder returns before writing
  // anything — not even the keepers_orders row — while the timer still calls this with apply
  // defaulting to true. So every sweep paged real orders, wrote nothing, and advanced the cursor past
  // them. On the day the mode is flipped to 'apply', every order the soak saw sits behind the cursor
  // and accrues nothing, ever; and driftReport cannot show it, because its `missing` query joins from
  // the keepers_orders table observe never wrote to. The dashboard reads clean while the loss is
  // total.
  //
  // That is exactly what this file's own header says the hold exists to prevent — "advancing past it
  // loses orders rather than delaying them. Delay is recoverable and invisible to the customer; loss
  // is neither." Observe is the case where nothing is recoverable, so it is the last place the cursor
  // should move.
  const clean = !failed && !truncated && problems.length === 0;
  const decision = cursorDecision({
    clean, apply, observeOnly,
    failed: Boolean(failed), truncated: Boolean(truncated), problems: problems.length,
  });
  if (decision.advance && maxUpdatedAt > cursor) setMeta(db, CURSOR_KEY, maxUpdatedAt);

  // Held referral awards whose window has passed become countable. Done here rather than on its own
  // timer because it is cheap, needs no network, and belongs to the same "make the ledger right" job.
  //
  // Gated on observeOnly for the same reason: releaseHeldEvents MUTATES the ledger — it flips events
  // from 'held' to 'applied' and marks the customer dirty. Inert on a database that has never been
  // applied to, but a store switched from 'apply' back to 'observe' would keep promoting awards while
  // claiming to append nothing.
  const released = (apply && !observeOnly) ? releaseHeldEvents(db, { now: new Date(nowMs).toISOString() }) : 0;

  return {
    ok: !failed,
    at: started,
    cursor, cursorAdvancedTo: decision.advance && maxUpdatedAt > cursor ? maxUpdatedAt : null,
    // Say WHY it did not move. A held cursor with no reason reads as a bug, and 'observe' is the one
    // reason that is entirely intentional and would otherwise look identical to a failure.
    cursorHeld: !decision.advance,
    holdReason: decision.holdReason,
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

  // THE REDEMPTION DISAGREEMENT, which until now had nowhere to live.
  //
  // The design calls the two usage readings — discountApplications on a paid order, and
  // asyncUsageCount on the discount node — an alarm: "their disagreement is the alarm".
  // reconcileRedemptions did compute the disagreements and return them; every caller dropped the
  // value, driftReport had no redemption term, and a grep for consumers found none. An alarm nobody
  // can hear is a comment.
  //
  // No new column is needed, because the state already says it: Shopify counted a use, we recorded
  // the row as used, and no order of ours ever claimed it. status='used' with used_order_gid NULL IS
  // the disagreement, durably, long after a log line has scrolled out of the ring buffer. It means
  // either a lost webhook — a reconciliation gap — or a code redeemed by someone it was not minted
  // for, which would be the eligibility model failing, and that is why it is surfaced rather than
  // merely counted.
  const redemptionsUnexplained = db.prepare(`
    SELECT id, code, used_at FROM keepers_redemptions
    WHERE status = 'used' AND used_order_gid IS NULL
    LIMIT 200
  `).all();

  return {
    missing, extra, unlinked, redemptionsUnexplained,
    counts: {
      missing: missing.length,
      extra: extra.length,
      unlinked: unlinked.length,
      redemptions_unexplained: redemptionsUnexplained.length,
    },
    // Deliberately NOT folded into `clean`. A disagreement is something to look at, not a reason to
    // hold the reconcile cursor — holding it would stop the only sweep able to resolve anything else,
    // so one unexplained redemption would freeze every accrual behind it.
    clean: missing.length === 0 && extra.length === 0,
  };
}
