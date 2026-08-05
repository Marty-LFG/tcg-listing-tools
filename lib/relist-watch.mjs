// lib/relist-watch.mjs — following a cancelled card back onto eBay.
//
// THE PROBLEM. When a cancellation is accepted, eBay auto-relists a single-quantity fixed-price
// listing itself (unless the seller unticked "Relist item?" during the cancel flow). The relist mints
// a NEW ItemID, ends the old listing, and carries the Custom Label across UNCHANGED — so the account
// ends up holding two listings with the same SKU, and inventory_items.ebay_listing_id still points at
// the dead one. Nothing in the tool noticed, because nothing was looking.
//
// THE HOOK. GetItem on the OLD ItemID returns Item.ListingDetails.RelistedItemID: eBay writes the new
// id onto the dead listing so a buyer landing there can follow it forward. That is an authoritative
// old→new pointer from eBay itself — one cheap call, and immune to the duplicate-Custom-Label problem
// an auto-relist creates by definition. There is deliberately no SKU-matching fallback: two mechanisms
// that can disagree about which ItemID a card points at are worse than one that sometimes says "don't
// know", and "don't know" here has a clean terminal state a human can see and resolve.
//
// NO FALSE POSITIVES BY CONSTRUCTION. Rows are only ever created by reverseStockForOrder — that is, by
// a confirmed cancellation of a line whose recorded effect says it SOLD OUT and that had a listing id.
// An item that genuinely sold is never enqueued. A partial sale is never enqueued. Nothing scans the
// account looking for candidates.
//
// A separate module because it is written from both sides — post-sale enqueues, listings resolves —
// and importing lib/listings.mjs into lib/postsale.mjs would drag its whole dependency tree into the
// post-sale plugin. This imports only db.mjs and ebay-trading.mjs.
import { openDb } from './db.mjs';
import { getItem, getListingState } from './ebay-trading.mjs';
import { itemUrl } from './ebay-links.mjs';

// eBay says a relist "can take a few hours to appear". The owner may also have unticked the box, or
// the item may have been multi-quantity, in which case the pointer NEVER appears — so this has to
// terminate. Nine attempts over roughly four days, then a clearly-labelled dead end.
const BACKOFF_MIN = [30, 60, 120, 240, 480, 720, 1440, 1440, 1440];

export function enqueueRelistWatch(tdb, { kind, item_id, sku, old_listing_id, order_id } = {}) {
  if (!kind || !item_id || !old_listing_id) return false;
  // ON CONFLICT re-arms rather than ignores: the same card cancelled twice is a new watch, and a row
  // that gave up last time deserves another go rather than staying dead forever.
  tdb.prepare(`INSERT INTO relist_watch (kind, item_id, sku, old_listing_id, order_id, next_check_at)
               VALUES (?,?,?,?,?, datetime('now','+30 minutes'))
               ON CONFLICT(kind, item_id, old_listing_id) DO UPDATE SET
                 state='watching', attempts=0, resolved_at=NULL, last_error=NULL, new_listing_id=NULL,
                 order_id=COALESCE(excluded.order_id, order_id),
                 next_check_at=datetime('now','+30 minutes'), updated_at=datetime('now')`)
    .run(kind, item_id, sku || null, String(old_listing_id), order_id || null);
  return true;
}

function bump(tdb, w, err) {
  const next = BACKOFF_MIN[Math.min(w.attempts, BACKOFF_MIN.length - 1)];
  tdb.prepare(`UPDATE relist_watch SET attempts = attempts + 1, last_error = ?,
               next_check_at = datetime('now', ?), updated_at = datetime('now') WHERE id = ?`)
    .run(err || null, '+' + next + ' minutes', w.id);
}
function terminal(tdb, w, state, why, newId) {
  tdb.prepare(`UPDATE relist_watch SET state=?, last_error=?, new_listing_id=COALESCE(?, new_listing_id),
               next_check_at=NULL, resolved_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .run(state, why || null, newId || null, w.id);
}

/**
 * Bind a stock row to the listing eBay relisted it as.
 *
 * The second call (getListingState) is a VERIFICATION GATE, not just a detail fetch: eBay has told us
 * "this was relisted to X", and we then confirm X still carries our Custom Label and is actually live
 * before pointing a stock row at it. Without a second read there is nothing to check the pointer
 * against. It also happens to return exactly the fields the mirror row needs, so it costs one call.
 */
async function adoptRelist(env, tdb, w, newId, { fetchState = getListingState } = {}) {
  const live = await fetchState(env, newId);
  if (!live.ok) return { ok: false, why: 'could not read the relisted item: ' + live.error };
  // Belt to the pointer's braces. eBay carries the Custom Label across a relist unchanged, so a
  // mismatch means the pointer is not describing our card — bind nothing, and say so loudly.
  if (w.sku && live.sku && String(live.sku).toUpperCase() !== String(w.sku).toUpperCase()) {
    terminal(tdb, w, 'mismatch', `relisted item ${newId} carries SKU ${live.sku}, not ${w.sku}`, newId);
    return { ok: false, terminal: true, why: 'sku mismatch' };
  }
  // A variation listing holds many SKUs and cannot be pointed at one stock row.
  if (live.has_variations) {
    terminal(tdb, w, 'mismatch', `relisted item ${newId} is a variation listing`, newId);
    return { ok: false, terminal: true, why: 'variation listing' };
  }
  // Not live YET is normal — a relist can be scheduled. Retry rather than give up.
  if (live.listing_status && live.listing_status !== 'Active') {
    return { ok: false, why: 'the relist is ' + live.listing_status + ', not Active yet' };
  }

  const table = w.kind === 'sealed' ? 'sealed_items' : 'inventory_items';
  tdb.exec('BEGIN');
  try {
    // Guarded on the OLD id so a row that has moved on since — relisted by hand, re-linked, sold
    // again — is never stomped by a pointer we followed minutes later.
    const moved = tdb.prepare(`UPDATE ${table} SET ebay_listing_id = ?, channel_status = 'active',
                               status = CASE WHEN status = 'sold' THEN status ELSE 'listed' END,
                               updated_at = datetime('now')
                               WHERE id = ? AND ebay_listing_id = ?`).run(newId, w.item_id, w.old_listing_id).changes;
    if (!moved) { tdb.exec('ROLLBACK'); return { ok: false, why: 'the stock row no longer points at the old listing' }; }

    if (w.kind === 'inventory') {
      // The Sell-API offer this SKU used to own is DEAD: eBay relisted on the TRADING side, and the
      // Inventory API cannot see a Trading listing at all (eBay KB 5210). Moving offer_id aside is what
      // takes this row out of reconcileListings' jurisdiction — its WHERE clause is
      // `offer_id IS NOT NULL AND listing_status NOT IN ('ENDED','EBAY_ENDED')`, and we now fail both.
      // That is the answer to "who wins": don't teach the reconciler an exception, remove the row from
      // its remit, because the remit genuinely moved.
      //
      // listing_id deliberately KEEPS the old ItemID. importSellerListings decides created_via by
      // `SELECT 1 FROM ebay_listings WHERE listing_id = ?` — repoint it and the relist gets tagged
      // 'tool', which makes reviseTradingListing refuse it while there is also no live offer. The card
      // would be unreviseable by BOTH paths. Left alone, the relist is 'manual', which is what it
      // actually is, and the repricer keeps working on it.
      tdb.prepare(`UPDATE ebay_listings SET retired_offer_id = COALESCE(retired_offer_id, offer_id),
                   offer_id = NULL, listing_status = 'ENDED', updated_at = datetime('now')
                   WHERE item_id = ? AND COALESCE(listing_id,'') = ?`).run(w.item_id, w.old_listing_id);
      tdb.prepare(`UPDATE inventory_items SET ebay_offer_id = NULL WHERE id = ?`).run(w.item_id);
    }

    // Put the relist in the seller mirror NOW. reviseTradingListing refuses anything absent from that
    // table, and nothing populates it on a schedule — waiting for the next repricer scan would leave
    // the card unpriceable for up to cadence_hours.
    // Column list matches importSellerListings' upsert, including listing_url — a row missing it would
    // be structurally different from every other row in the mirror, and the surfaces that link out of
    // the catalogue would have nothing to link to until the next full import.
    tdb.prepare(`INSERT INTO ebay_seller_listings
        (listing_id, sku, title, price_cents, currency, quantity, available_qty, sold_qty, listing_type,
         state, listing_url, created_via, item_id, last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'active', ?, 'manual', ?, datetime('now'))
      ON CONFLICT(listing_id) DO UPDATE SET
        sku=excluded.sku, title=COALESCE(excluded.title, title), price_cents=excluded.price_cents,
        quantity=excluded.quantity, available_qty=excluded.available_qty, sold_qty=excluded.sold_qty,
        listing_type=COALESCE(excluded.listing_type, listing_type), state='active',
        listing_url=COALESCE(excluded.listing_url, listing_url),
        item_id=COALESCE(excluded.item_id, item_id), last_seen_at=datetime('now')`)
      // getListingState does not report a currency — this store is AU-only and the column already
      // defaults to AUD, so saying so explicitly is honest rather than reading a field that isn't there.
      .run(newId, live.sku || w.sku || null, live.title || null, live.price_cents ?? null,
        'AUD', live.quantity_total ?? null, live.available_qty ?? null,
        live.sold_qty || 0, live.listing_type || null, itemUrl(newId),
        // sealed_items cannot go here — the column is REFERENCES inventory_items(id).
        w.kind === 'inventory' ? w.item_id : null);
    tdb.prepare(`UPDATE ebay_seller_listings SET state='ended', last_seen_at=datetime('now') WHERE listing_id=?`)
      .run(w.old_listing_id);

    // The durable supersession record. ebay_listings is overwritten in place by any future publish, so
    // the chain of "which listing was this card, and when" cannot live only there.
    tdb.prepare(`INSERT INTO listing_pushes (item_id, sku, action, listing_id, status, response)
                 VALUES (?,?,'adopt',?, 'ok', ?)`)
      .run(w.kind === 'inventory' ? w.item_id : null, w.sku || null, newId,
        JSON.stringify({ from: w.old_listing_id, to: newId, order_id: w.order_id,
          reason: 'ebay auto-relist after cancellation', kind: w.kind,
          price_cents: live.price_cents ?? null, available_qty: live.available_qty ?? null }));

    tdb.prepare(`UPDATE relist_watch SET state='adopted', new_listing_id=?, next_check_at=NULL,
                 resolved_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(newId, w.id);
    tdb.exec('COMMIT');
  } catch (e) {
    try { tdb.exec('ROLLBACK'); } catch {}
    return { ok: false, why: String(e?.message || e) };
  }
  console.log(`[relist-watch] ${w.sku || w.kind + '#' + w.item_id}: eBay relisted ${w.old_listing_id} as ${newId} — adopted`);
  return { ok: true, kind: w.kind, item_id: w.item_id, sku: w.sku, from: w.old_listing_id, to: newId,
    price_cents: live.price_cents ?? null };
}

/**
 * One pass over the watches that are due. Cheap and usually a no-op: nothing is watching unless an
 * order was cancelled, and each watch is probed on a widening backoff.
 *
 * `fetchItem` / `fetchState` are injectable so the whole sweep is testable offline — the same
 * dependency-by-argument seam the rest of this codebase uses for module-scope imports.
 */
export async function sweepRelistWatch(env, tdbIn, { max = 10, fetchItem = getItem, fetchState = getListingState } = {}) {
  let tdb = tdbIn;
  try { tdb = tdb || openDb(); } catch { return { ok: false, error: 'tracker_db' }; }
  let due;
  try {
    due = tdb.prepare(`SELECT * FROM relist_watch WHERE state='watching'
                       AND (next_check_at IS NULL OR next_check_at <= datetime('now'))
                       ORDER BY next_check_at LIMIT ?`).all(max);
  } catch { return { ok: false, error: 'no_table' }; }
  const out = { ok: true, checked: 0, adopted: [], mismatched: [], errors: 0 };
  for (const w of due) {
    out.checked++;
    let probe;
    // ONE GetItem on the OLD id, trimmed to ListingDetails. Without the selector the container is not
    // in the response at all, so the pointer would always read as absent (see getItem).
    try { probe = await fetchItem(env, w.old_listing_id, { selectors: ['ListingDetails'] }); }
    catch (e) { out.errors++; bump(tdb, w, String(e?.message || e)); continue; }
    if (!probe || !probe.ok) {
      out.errors++;
      bump(tdb, w, (probe && probe.errors && probe.errors[0] && probe.errors[0].longMessage) || 'GetItem failed');
      continue;
    }
    if (!probe.relistedItemId) { bump(tdb, w, null); continue; }   // not relisted yet — try again later

    const r = await adoptRelist(env, tdb, w, probe.relistedItemId, { fetchState });
    if (r.ok) out.adopted.push(r);
    else if (r.terminal) out.mismatched.push({ sku: w.sku, why: r.why });
    else bump(tdb, w, r.why);
  }
  // Everything out of attempts, in ONE statement, so a crash mid-loop cannot strand a row as
  // permanently "watching" with no next_check_at anybody will ever act on. Guarded on having actually
  // probed something: only bump() can push a row over the limit, so with nothing due there is nothing
  // new to retire — and this runs every reconcile tick against a table that is empty almost always.
  out.not_relisted = 0;
  if (due.length) {
    const gone = tdb.prepare(`UPDATE relist_watch SET state='not_relisted', next_check_at=NULL,
                              resolved_at=datetime('now'), updated_at=datetime('now'),
                              last_error=COALESCE(last_error,'eBay never relisted it')
                              WHERE state='watching' AND attempts >= ?`).run(BACKOFF_MIN.length);
    out.not_relisted = gone.changes || 0;
  }
  if (out.not_relisted) {
    console.warn(`[relist-watch] gave up on ${out.not_relisted} item(s) — eBay never relisted them. `
      + 'They are in stock and unlisted; relist from the batch runner when you want them back up.');
  }
  return out;
}

// What the dashboard and /api/status read.
export function getRelistWatchState(tdbIn) {
  let tdb = tdbIn;
  try { tdb = tdb || openDb(); } catch { return null; }
  try {
    const rows = tdb.prepare('SELECT state, COUNT(*) n FROM relist_watch GROUP BY state').all();
    const by = {}; for (const r of rows) by[r.state] = r.n;
    return { watching: by.watching || 0, adopted: by.adopted || 0,
      not_relisted: by.not_relisted || 0, mismatch: by.mismatch || 0 };
  } catch { return null; }
}
