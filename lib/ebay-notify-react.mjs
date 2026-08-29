// lib/ebay-notify-react.mjs — what a push notification does once it is allowed to do something.
//
// Observe mode existed to answer one question: is push actually faster than the poll, on real sales?
// It is. Over the first fortnight, six of six real notifications arrived before the poll had adopted
// the order, a median of 364 seconds ahead. This module is what spends those six minutes.
//
// THERE IS NO SECOND PIPELINE, AND THAT IS THE ENTIRE DESIGN. A notification does not ingest an
// order, fire a Telegram alert, decrement stock or draft a message. It calls runOrderPoll — the same
// function the ten-minute timer calls — a few seconds after the sale instead of up to ten minutes
// after it. Every alert, dedupe, stock decrement and draft is the code that has been carrying this
// store all along; push changes only WHEN it runs. That is what makes this safe to turn on, and it is
// worth defending: any behaviour that lives here and not in the poll is a divergence that has to be
// understood twice and will be debugged at the worst possible moment.
//
// So this module owns only the two things the poll cannot know on its own.
//
//   1. THE CURSOR GUARD. pollOrders ends its window at "now" and moves orders_cursor there. eBay's
//      order service can announce a sale a moment before GetOrders will return it — observe mode saw
//      exactly that, and lib/ebay-notify-observe.mjs says so in as many words — and polling two
//      seconds after the notification is precisely when that gap is open. A window that did not
//      produce the order we were told about is a window we have not really read, so `expect` makes
//      pollOrders HOLD the cursor. Same defence, same reasoning, as a window truncated by
//      max_per_run: advancing past an order nobody read loses it rather than delaying it.
//
//   2. SETTLING THE AUDIT ROWS. notify_events only prunes rows that have settled, so in observe mode
//      the observe pass was what stamped them. Something still has to. A row whose order the poll
//      adopted is handled; a row whose order has not appeared yet is retried a couple of times and
//      then handed to the schedule — which is safe precisely because of (1). The retry is a latency
//      optimisation. The cursor guard is the correctness guarantee. Keeping those two straight is
//      what stops the retry budget from being load-bearing.
import { knownOrderIds } from './ebay-notify-observe.mjs';

// How many push-triggered polls an order gets before it is handed back to the schedule. Small on
// purpose: each attempt is a real GetOrders, and the next scheduled poll is already guaranteed to
// cover the order because the cursor was held. Three attempts spaced by min_gap_ms covers eBay
// being briefly behind itself; anything slower than that is not a latency problem.
const MAX_ATTEMPTS = 3;

/** The order events waiting on a reaction. next_attempt_at is what idx_ne_due is indexed for. */
function dueOrderEvents(db, limit) {
  return db.prepare(`SELECT notification_id, ref_id, event_date, received_at, attempt
                     FROM notify_events
                     WHERE status = 'received' AND action = 'order_by_id' AND ref_id IS NOT NULL
                       AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
                     ORDER BY received_at ASC LIMIT ?`).all(limit);
}

/**
 * reactToOrderEvents(env, db, opts) — run the real order poll for the sales we have been told about,
 * then settle the notifications that prompted it.
 *
 * Returns { ok, considered, adopted, retrying, gave_up, poll } where `poll` is runOrderPoll's own
 * result, unedited — the poll is the thing that did the work and its report is the interesting one.
 *
 * `runPoll` is injectable for tests, the same dependency-by-argument seam sweepOpenOrders and
 * observeOrderEvents use. Left null it dynamically imports postsale.mjs, matching how lib/ebay-notify.mjs
 * reaches the same module without giving status.mjs an import cycle to trip over.
 */
export async function reactToOrderEvents(env, db, {
  limit = 40, runPoll = null, retryDelayMs = 5000, now = () => new Date(),
} = {}) {
  const due = dueOrderEvents(db, limit);
  if (!due.length) return { ok: true, considered: 0, adopted: 0, retrying: 0, gave_up: 0, poll: null };

  // One notification per order is the norm, but a redelivery that slipped the dedupe (a different
  // notificationId for the same order) must not make this look like two sales.
  const ids = [...new Set(due.map((d) => String(d.ref_id)))];
  // Sampled BEFORE the poll: whether push genuinely got there first, rather than whether the row
  // happened to be drained late. Recorded, never acted on.
  const wasKnown = knownOrderIds(db, ids);

  const poll = runPoll || (async (opts) => {
    const { runOrderPoll } = await import('./postsale.mjs');
    return runOrderPoll(env, db, opts);
  });

  let result;
  try {
    // `expect` is the cursor guard. `trigger` is what keeps this off the manual-sync path — a
    // notification is not a person pressing ↻, so it must not force the by-id sweep on every sale.
    result = await poll({ trigger: 'notification', expect: ids });
  } catch (e) {
    result = { ok: false, error: String(e?.message || e) };
  }

  // Re-read rather than trusting the poll's counters: what matters per notification is whether THIS
  // order is now ours, and a poll that adopted three orders says nothing about which three.
  const adopted = knownOrderIds(db, ids);

  const settle = db.prepare(`UPDATE notify_events
                             SET status = 'handled', handled_at = datetime('now'), action = 'polled',
                                 attempt = ?, next_attempt_at = NULL, observation = ?
                             WHERE notification_id = ?`);
  const requeue = db.prepare(`UPDATE notify_events SET attempt = ?, next_attempt_at = ? WHERE notification_id = ?`);
  const nextAt = new Date(Date.now() + Math.max(0, retryDelayMs)).toISOString().replace('T', ' ').slice(0, 19);

  let settled = 0, retrying = 0, gaveUp = 0;
  for (const ev of due) {
    const id = String(ev.ref_id);
    const attempt = (Number(ev.attempt) || 0) + 1;
    const landed = adopted.has(id);
    if (!landed && attempt < MAX_ATTEMPTS) {
      requeue.run(attempt, nextAt, ev.notification_id);
      retrying++;
      continue;
    }
    if (!landed) gaveUp++;
    settle.run(attempt, JSON.stringify({
      mode: 'poll',
      order_known_at_receipt: wasKnown.has(id),   // false => push arrived before the poll had it
      order_adopted: landed,                      // false => eBay announced an order it would not return
      attempts: attempt,
      // eBay's clock to ours: how long the notification itself took to arrive.
      delivery_lag_s: ev.event_date
        ? Math.round((new Date(ev.received_at + 'Z').getTime() - new Date(ev.event_date).getTime()) / 1000)
        : null,
      poll_ok: result?.ok !== false,
      reacted_at: now().toISOString(),
      note: landed
        ? 'poll mode — the notification ran the scheduled order poll early; every alert and stock move is the poll\'s own'
        : 'poll mode — eBay had not returned this order yet; the cursor was held, so the scheduled poll still covers it',
    }), ev.notification_id);
    settled++;
  }

  if (gaveUp) {
    console.log(`[ebay-notify] react: ${gaveUp} notified order(s) still not returned by eBay after ${MAX_ATTEMPTS} attempts `
      + '— handed to the scheduled poll (its window was held open for them)');
  }
  if (settled || retrying) {
    console.log(`[ebay-notify] react: ${due.length} notification(s) → poll · ${settled - gaveUp} adopted`
      + (retrying ? `, ${retrying} awaiting eBay` : ''));
  }
  return { ok: result?.ok !== false, considered: due.length, adopted: settled - gaveUp, retrying, gave_up: gaveUp, poll: result };
}

/**
 * reactToMessageEvents(env, db, opts) — a NEW_MESSAGE / BUYER_QUESTION push turns straight into a
 * member-message poll.
 *
 * Much simpler than the order path, and deliberately so. eBay's message topics carry no id we can
 * fetch by (GetMemberMessages is windowed, not addressable), so there is nothing to verify per
 * notification and nothing to retry: the poll either read the window or it did not, and the 15-minute
 * schedule is already the backstop. So every drained row settles on the first attempt.
 *
 * runMemberMessagePoll is single-flight, so a burst of notifications collapsing onto one pass is
 * already safe — a second caller joins the run in progress rather than racing the cursor.
 */
export async function reactToMessageEvents(env, db, { limit = 40, runPoll = null } = {}) {
  const due = db.prepare(`SELECT notification_id FROM notify_events
                          WHERE status = 'received' AND action = 'message_poll'
                          ORDER BY received_at ASC LIMIT ?`).all(limit);
  if (!due.length) return { ok: true, considered: 0, polled: false };

  const poll = runPoll || (async (opts) => {
    const { runMemberMessagePoll } = await import('./postsale.mjs');
    return runMemberMessagePoll(env, db, opts);
  });

  let result;
  try { result = await poll({ trigger: 'notification' }); }
  catch (e) { result = { ok: false, error: String(e?.message || e) }; }

  // Settle either way. A failed poll leaves the messages exactly where they were — inside the next
  // scheduled window — so holding the rows open would only re-spend calls on the same outcome.
  const settle = db.prepare(`UPDATE notify_events
                             SET status = 'handled', handled_at = datetime('now'), action = 'polled',
                                 attempt = attempt + 1, next_attempt_at = NULL, observation = ?
                             WHERE notification_id = ?`);
  const obs = JSON.stringify({ ok: !!(result && result.ok), seen: result && result.seen, alerts: result && result.alerts });
  let settled = 0;
  for (const ev of due) settled += settle.run(obs, ev.notification_id).changes || 0;
  return { ok: !!(result && result.ok), considered: due.length, settled, polled: true, poll: result };
}
