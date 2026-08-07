// lib/ebay-notify-observe.mjs — what a push notification is worth, measured without acting on it.
//
// READ-ONLY. THIS IS THE WHOLE POINT OF THE MODULE, so it is worth being blunt about the boundary:
//
//   it MAY   call eBay's Trading GetOrders by order id (a read)
//   it MAY   write to notify_events, which is this subsystem's own audit log
//   it MUST NOT ingest or refresh an order, queue or send a buyer message, decrement or restock
//            anything, dispatch, revise a listing, or send a Telegram alert
//
// The last one deserves a note, because it looks harmless. Ingesting an order here would not send
// anything today — but an ingested order is picked up by processMessages on the NEXT scheduled poll,
// which can draft and (in auto mode) send a buyer a message. The effect would be deferred, not
// avoided. So nothing is ingested. The existing poll keeps doing all of the real work, exactly as it
// does now, and this module only writes down what it saw.
//
// What that buys is the evidence the soak needs: for each notification, was the order already in the
// database when the push arrived? If it was not, push genuinely beat the poll, and by how much is
// answerable later by comparing this row against the order the poll eventually adopted. Turning the
// pipeline on afterwards is then a decision made on measurements rather than on hope.
import { getOrders } from './ebay-trading.mjs';

// eBay caps an OrderIDArray request; sweepOpenOrders uses 20 and it is a proven size against this
// account, so match it rather than inventing a second number.
const CHUNK = 20;

/** Orders we already hold, out of a set of ids. One query, not one per id. */
function knownOrderIds(db, ids) {
  if (!ids.length) return new Set();
  const rows = db.prepare(`SELECT order_id FROM orders WHERE order_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Set(rows.map((r) => r.order_id));
}

/**
 * observeOrderEvents(env, db, opts) — take the ORDER_CONFIRMATION events that have not been looked at
 * yet, read those orders back from eBay, and record what was true at that moment.
 *
 * `fetchOrders` is injectable for tests, matching sweepOpenOrders and verifyNotification.
 */
export async function observeOrderEvents(env, db, { limit = 40, fetchOrders = getOrders, now = () => new Date() } = {}) {
  const due = db.prepare(`SELECT notification_id, ref_id, event_date, received_at
                          FROM notify_events
                          WHERE status = 'received' AND action = 'order_by_id' AND ref_id IS NOT NULL
                          ORDER BY received_at ASC LIMIT ?`).all(limit);
  if (!due.length) return { ok: true, considered: 0, observed: 0, ahead_of_poll: 0 };

  // One notification per order is the norm, but a redelivery that slipped past the dedupe (different
  // notificationId, same order) must not cost a second API call.
  const ids = [...new Set(due.map((d) => String(d.ref_id)))];
  const known = knownOrderIds(db, ids);

  const seen = new Map();     // orderId -> parsed order from eBay
  const missing = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    // A populated OrderIDArray makes eBay ignore every other filter, including the status and the
    // time window — which is exactly what we want when asking about one specific order.
    const res = await fetchOrders(env, { orderIds: batch, entriesPerPage: 100 });
    if (!res.ok) return { ok: false, error: 'GetOrders failed', ack: res.ack, errors: res.errors, considered: due.length };
    for (const o of res.orders) seen.set(o.orderId, o);
    for (const id of batch) if (!seen.has(id)) missing.push(id);
  }

  const stamp = db.prepare(`UPDATE notify_events
                            SET status = 'handled', handled_at = datetime('now'), action = 'observed', observation = ?
                            WHERE notification_id = ?`);
  let observed = 0, aheadOfPoll = 0;
  for (const ev of due) {
    const o = seen.get(String(ev.ref_id));
    const wasKnown = known.has(String(ev.ref_id));
    if (!wasKnown) aheadOfPoll++;
    const obs = {
      order_known_at_receipt: wasKnown,      // false => the push arrived before the poll had it
      found_on_ebay: !!o,                    // false => eBay told us about an order it will not yet return
      paid: o ? !!o.paid : null,
      paid_time: o?.paidTime ?? null,
      order_status: o?.orderStatus ?? null,
      total_cents: o?.totalCents ?? null,
      line_items: o ? (o.items || []).length : null,
      // eBay's own clock to ours: how long the notification took to arrive.
      delivery_lag_s: ev.event_date ? Math.round((new Date(ev.received_at + 'Z').getTime() - new Date(ev.event_date).getTime()) / 1000) : null,
      observed_at: now().toISOString(),
      note: 'observe-only — nothing was ingested, messaged or dispatched',
    };
    stamp.run(JSON.stringify(obs), ev.notification_id);
    observed++;
  }

  if (missing.length) {
    // Expected occasionally rather than alarming: eBay's order service can announce a sale before
    // GetOrders will return it. The scheduled poll picks those up regardless — this is only a note
    // that push ran ahead of eBay's own consistency, which is worth knowing before trusting it.
    console.log('[ebay-notify] observe: eBay did not yet return ' + missing.length + ' order(s) it notified us about — ' + missing.slice(0, 5).join(', '));
  }
  if (observed) {
    console.log(`[ebay-notify] observe: ${observed} notification(s) checked, ${aheadOfPoll} for orders the poll had not yet ingested`);
  }
  return { ok: true, considered: due.length, observed, ahead_of_poll: aheadOfPoll, missing };
}

/**
 * How much earlier did push know than the poll? Pure read, for /api/status and the soak decision.
 *
 * Compares when a notification landed against when the poll actually adopted the order. Only counts
 * orders the poll has since ingested, because until then there is no "when the poll found it" to
 * compare against.
 */
export function observationSummary(db, { days = 7 } = {}) {
  try {
    // orders.ingested_at is precisely "when the poll adopted this order", which is the thing the
    // notification is being raced against.
    const rows = db.prepare(`
      SELECT ne.notification_id, ne.ref_id, ne.received_at, ne.observation, o.ingested_at AS order_ingested_at
      FROM notify_events ne
      LEFT JOIN orders o ON o.order_id = ne.ref_id
      WHERE ne.topic = 'ORDER_CONFIRMATION' AND ne.received_at >= datetime('now', ?)`).all('-' + Math.max(1, days) + ' days');
    let ahead = 0, matched = 0;
    const leads = [];
    for (const r of rows) {
      let obs = null; try { obs = JSON.parse(r.observation || 'null'); } catch { /* older row */ }
      if (obs && obs.order_known_at_receipt === false) ahead++;
      if (r.order_ingested_at) {
        matched++;
        // Both are SQLite 'YYYY-MM-DD HH:MM:SS' in UTC.
        const lead = (new Date(r.order_ingested_at + 'Z').getTime() - new Date(r.received_at + 'Z').getTime()) / 1000;
        if (Number.isFinite(lead)) leads.push(lead);
      }
    }
    leads.sort((a, b) => a - b);
    const median = leads.length ? leads[Math.floor(leads.length / 2)] : null;
    return {
      window_days: days,
      notifications: rows.length,
      ahead_of_poll: ahead,
      matched_to_an_order: matched,
      // How many seconds LATER the poll adopted the order than the push told us about it.
      median_lead_over_poll_s: median == null ? null : Math.round(median),
      max_lead_over_poll_s: leads.length ? Math.round(leads[leads.length - 1]) : null,
    };
  } catch { return { window_days: days, notifications: 0, error: 'unavailable' }; }
}
