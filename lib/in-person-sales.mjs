// lib/in-person-sales.mjs — a card sold across a table, recorded so it comes off every channel.
//
// Before this, a show sale was recorded by setting status=sold in the inventory edit modal, which
// changed the row and nothing else: the eBay listing stayed up and the Shopify quantity stayed at one,
// so the card was still buyable online after it had left in someone's bag (audit V10). The owner
// records show sales BOTH ways — tapping each one at the table when it is quiet, and catching up the
// rest at the end of the day — so one function serves a single line and a batch of them.
//
// THE SALE IS WRITTEN FIRST, AND IT NEVER ROLLS BACK. The order is Keeper's Runs' (lib/runs.mjs, the
// in-person bundle sale): the ledger, then the channels. A card that has physically gone must be
// recorded as gone even when eBay is unreachable — the channel write is retried by the sync worker and
// reported to the person holding the phone, and the one outcome this never produces is a sale that did
// not happen because a marketplace was slow.
//
// THROUGH THE SAME DECREMENT AN eBAY ORDER USES (decrementInventoryItem / decrementSealedItem), with
// refKind 'in_person'. So an in-person sale is a ledger 'sale' with the same sold-out write-back
// (status sold, sold_at, sale price, channel_status ended) and the same effect snapshot, rather than a
// second hand-rolled version that would drift from it. The jobs that bring the channels down are
// queued in the SAME transaction, so a crash between the two cannot leave a sale with nothing queued.
//
// Not gated on hand verification (AGENTS.md §23): that gate is about what a LISTING claims, and
// selling the object in hand is the opposite of listing it. Gated on a Keeper's Run reservation,
// because a card promised to a numbered bundle must not be sold out from under it.
import { migrateChannelSync, enqueueChannelSync, channelPresence, openEventItemFor } from './channel-presence.mjs';
import { decrementInventoryItem, decrementSealedItem } from './postsale.mjs';
import { assertNotReserved, reservedUnits } from './runs-reserve.mjs';

const clean = (s) => String(s == null ? '' : s).trim();

/**
 * Find the stock row a line names. A line is {kind, id} or {sku}: a shelf label (inventory), a sealed
 * row's own sku, or a sealed POOL sku — a pool resolves to its first row with units free, preferring
 * one with a placement at `location` when the line names one.
 *
 * A pool label at a SHOW names a box on the table, so the row a show took is preferred: `eventId`
 * (scan-back, a sale tagged to a show) prefers that show's row with units still out, `preferAway` (any
 * table sale) prefers any offline show's. Without it a pool sale took the box off the home row and the
 * close-out then recorded the show box as sold too.
 */
export function resolveLine(db, line = {}, { eventId = null, preferAway = false } = {}) {
  const kind = line.kind === 'sealed' ? 'sealed' : line.kind === 'inventory' ? 'inventory' : null;
  const id = line.id != null ? +line.id : null;
  if (kind && Number.isInteger(id) && id > 0) {
    const row = db.prepare(`SELECT * FROM ${kind === 'sealed' ? 'sealed_items' : 'inventory_items'} WHERE id = ?`).get(id);
    return row ? { ok: true, kind, row } : { ok: false, error: `no ${kind} row ${id}`, code: 'not_found' };
  }
  const sku = clean(line.sku);
  if (!sku) return { ok: false, error: 'name the card: a shelf label, a sku, or {kind, id}', code: 'no_reference' };
  if (kind !== 'sealed') {
    const inv = db.prepare('SELECT * FROM inventory_items WHERE UPPER(sku) = UPPER(?) LIMIT 1').get(sku);
    if (inv) return { ok: true, kind: 'inventory', row: inv };
  }
  const box = db.prepare('SELECT * FROM sealed_items WHERE UPPER(sku) = UPPER(?) LIMIT 1').get(sku);
  if (box) return { ok: true, kind: 'sealed', row: box };
  const pool = db.prepare('SELECT pool_sku FROM sealed_pools WHERE UPPER(pool_sku) = UPPER(?)').get(sku);
  if (pool) {
    const loc = clean(line.location);
    const rows = db.prepare(`SELECT * FROM sealed_items WHERE pool_sku = ? AND status IN ('in_stock','listed') AND quantity > 0 ORDER BY id`).all(pool.pool_sku);
    const atLoc = loc ? rows.find((r) => db.prepare('SELECT 1 FROM sealed_placements WHERE item_id = ? AND LOWER(location) = LOWER(?) AND quantity > 0').get(r.id)) : null;
    const outAtShow = (r) => {
      if (eventId == null && !preferAway) return false;
      const x = db.prepare(`SELECT COALESCE(SUM(ei.qty_taken - ei.qty_returned - ei.qty_sold_table - ei.qty_sold_close), 0) AS n
                              FROM event_items ei JOIN events e ON e.id = ei.event_id
                             WHERE ei.kind = 'sealed' AND ei.item_id = ? AND ${eventId != null ? 'ei.event_id = ?' : "e.status = 'offline'"}`)
        .get(...(eventId != null ? [r.id, +eventId] : [r.id]));
      return (Number(x && x.n) || 0) > 0;
    };
    const atShow = rows.find(outAtShow);
    const pick = atLoc || atShow || rows.find((r) => (r.quantity - reservedUnits(db, 'sealed', r.id)) > 0) || rows[0];
    if (pick) return { ok: true, kind: 'sealed', row: pick, via_pool: pool.pool_sku };
    return { ok: false, error: `pool ${pool.pool_sku} has nothing on the shelf`, code: 'not_enough' };
  }
  return { ok: false, error: `nothing in stock is labelled ${sku}`, code: 'not_found' };
}

/** Why this line cannot be sold, or null. Read at the moment of the sale, never trusted from a preview. */
export function lineRefusal(db, resolved, qty) {
  const { kind, row } = resolved;
  const want = Math.floor(Number(qty) || 0);
  if (!(want >= 1)) return { code: 'bad_qty', error: 'quantity must be at least 1' };
  if (row.status === 'sold') return { code: 'already_sold', error: `${row.sku || 'this item'} is already recorded as sold` };
  const onHand = Number(row.quantity) || 0;
  if (kind === 'inventory') {
    const held = assertNotReserved(db, 'inventory', row.id);
    if (held) return { code: held.code, error: held.error, reservation: held };
    if (want > onHand) return { code: 'not_enough', error: `${row.sku || 'this item'} has ${onHand} on the shelf, not ${want}` };
    return null;
  }
  // Sealed: units promised to a Run are subtracted, not refused — one sealed row legitimately supplies
  // both a run and the table, the same way poolUnits treats it for a listing.
  const reserved = reservedUnits(db, 'sealed', row.id);
  const free = Math.max(0, onHand - reserved);
  if (want > free) {
    return {
      code: reserved ? 'reserved_for_run' : 'not_enough',
      error: reserved
        ? `${row.sku || 'this box'} has ${onHand} on the shelf but ${reserved} are held for a Keeper's Run — ${free} can be sold`
        : `${row.sku || 'this box'} has ${onHand} on the shelf, not ${want}`,
    };
  }
  return null;
}

function summary(db, kind, row) {
  return {
    kind, id: row.id, sku: row.sku || null, name: row.name || null,
    set_name: row.set_name || null, number: row.number || null,
    condition: row.condition || null, grading_company: row.grading_company || null, grade: row.grade ?? null,
    quantity: row.quantity ?? null, status: row.status, location: row.location || null,
    image_url: row.image_url || null,
    // The asking price the owner set — a suggestion for the price field, never recorded unless the
    // operator keeps it. Not the sealed valuation: that is stored in its SOURCE currency (GR3), and a
    // USD figure dropped into an AUD field is the silently-wrong number the rule exists to prevent.
    price_cents: row.target_price_cents ?? null,
    pool_sku: row.pool_sku || null,
    presence: channelPresence(db, kind, { itemId: row.id }),
  };
}

/** Resolve and check lines WITHOUT writing anything — the batch preview and the phone's lookup. */
export function previewInPerson(db, lines = []) {
  migrateChannelSync(db);
  return (lines || []).map((line, i) => {
    const qty = Math.floor(Number(line.qty ?? line.quantity ?? 1));
    const r = resolveLine(db, line, { preferAway: true });
    if (!r.ok) return { index: i, ok: false, line, code: r.code, error: r.error };
    const refusal = lineRefusal(db, r, qty);
    return { index: i, ok: !refusal, line, qty, item: summary(db, r.kind, r.row), via_pool: r.via_pool || null, ...(refusal || {}) };
  });
}

/**
 * Record ONE in-person sale line. Synchronous and all-or-nothing on the tracker DB:
 * the sale row, the stock movement (through the decrement), and the channel jobs commit together.
 *
 * Returns { ok, sale_id, kind, item, qty, sold_out, remaining, jobs:[{id, channel, target}] }
 * or { ok:false, code, error } for a refusal (nothing written).
 */
export function recordInPersonSale(db, line = {}, { event = null, note = null, actor = null, batchRef = null, eventId = null, phase = 'table' } = {}) {
  migrateChannelSync(db);
  // A repeat of a sale already written (same client_key: a retried request, a paste sent twice) records
  // nothing and answers with the original, so a phone that lost the reply can simply send again.
  const clientKey = clean(line.client_key).slice(0, 120) || null;
  if (clientKey) {
    const prev = db.prepare('SELECT * FROM in_person_sales WHERE client_key = ?').get(clientKey);
    if (prev) {
      const t = prev.kind === 'sealed' ? 'sealed_items' : 'inventory_items';
      const row = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(prev.item_id);
      return {
        ok: true, already: true, sale_id: prev.id, kind: prev.kind, qty: prev.qty, unit_price_cents: prev.unit_price_cents,
        sold_out: !!prev.sold_out, event_id: prev.event_id ?? null, remaining: row ? row.quantity : null,
        item: row ? summary(db, prev.kind, row) : { sku: prev.sku, name: prev.name }, jobs: [],
        note: 'already recorded — this is the same sale sent again, so nothing was written twice',
      };
    }
  }
  // Strict: a typed 0 or a stray character is a refusal (lineRefusal: bad_qty), never one unit sold.
  const qty = Math.floor(Number(line.qty ?? line.quantity ?? 1));
  const r = resolveLine(db, line, { eventId, preferAway: true });
  if (!r.ok) return { ok: false, code: r.code, error: r.error, line };
  const refusal = lineRefusal(db, r, qty);
  if (refusal) return { ok: false, ...refusal, line, item: summary(db, r.kind, r.row) };

  const price = line.unit_price_cents != null && line.unit_price_cents !== ''
    ? Math.round(Number(line.unit_price_cents)) : null;
  if (price != null && !(price >= 0)) return { ok: false, code: 'bad_price', error: 'price must be zero or more, in cents', line };
  const location = clean(line.location) || null;

  // A card on an open show's take-list is sold AT that show, whoever records it and from which screen.
  // Counting it against the take-list is what keeps the close-out from recording the same card as sold a
  // second time when it is missing from the box that comes home.
  // A show named on the sale must be OFFLINE (stock is out at it) and the card must be on its list. A
  // planning show has nothing out yet, so counting a sale there would make its take-list read short the
  // moment it goes offline; a closing show's close-out has already counted everything that did not come
  // back; and a show the card is not on would leave the show it IS on to record it again at close-out.
  if (eventId != null) {
    const ev = db.prepare('SELECT id, name, status FROM events WHERE id = ?').get(+eventId);
    if (!ev) return { ok: false, code: 'wrong_event', error: 'no such show', line };
    if (ev.status !== 'offline') {
      return { ok: false, code: 'wrong_event', line, error: ev.status === 'planning'
        ? `${ev.name} has not started — nothing is out at it yet, so this sale is a sale at home: record it with no show`
        : `${ev.name}'s close-out is recorded — everything that did not come back is already counted as sold there` };
    }
    // Not on this show's list is fine — a card brought along unscanned is still a sale at the table, and
    // its share of the takings belongs to this show. On ANOTHER open show's list it is not: that show
    // would record it again at its own close-out.
    const on = db.prepare('SELECT 1 FROM event_items WHERE event_id = ? AND kind = ? AND item_id = ?').get(ev.id, r.kind, r.row.id);
    const elsewhere = on ? null : openEventItemFor(db, r.kind, r.row.id, { salesOnly: true });
    if (elsewhere) return { ok: false, code: 'wrong_event', line, error: `${r.row.sku || 'this item'} is on ${elsewhere.event_name}'s take-list, not ${ev.name}'s — record it against that show` };
  }
  const evItem = eventId != null
    ? db.prepare('SELECT ei.*, e.name AS event_name FROM event_items ei JOIN events e ON e.id = ei.event_id WHERE ei.event_id = ? AND ei.kind = ? AND ei.item_id = ?').get(+eventId, r.kind, r.row.id) || null
    : openEventItemFor(db, r.kind, r.row.id, { salesOnly: true });
  const evId = eventId != null ? +eventId : (evItem ? evItem.event_id : null);
  const evName = event || (evItem ? evItem.event_name : null)
    || (evId != null ? (db.prepare('SELECT name FROM events WHERE id = ?').get(evId) || {}).name : null);

  db.exec('BEGIN');
  try {
    const ins = db.prepare(`INSERT INTO in_person_sales (kind, item_id, sku, name, qty, unit_price_cents, event, note, actor, location, batch_ref, event_id, client_key)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.kind, r.row.id, r.row.sku || null, r.row.name || null, qty, price, clean(evName) || null, clean(line.note || note) || null,
        clean(actor) || null, location, batchRef, evId, clientKey);
    const saleId = Number(ins.lastInsertRowid);
    const ref = `ips-${saleId}`;
    // Queued BEFORE the decrement: selling out writes channel_status = 'ended', which is the decrement
    // assuming eBay ended its own listing (true for an eBay sale, false here). Read first, the listing
    // that is still live is the one that gets queued.
    const q = enqueueChannelSync(db, { kind: r.kind, itemId: r.row.id, reason: 'sold in person', ref: `in-person sale #${saleId}` });
    const dec = r.kind === 'sealed'
      ? decrementSealedItem(db, r.row.id, qty, price, ref, 'in_person', location)
      : decrementInventoryItem(db, r.row.id, qty, price, ref, 'in_person');
    if (!dec.ok) throw Object.assign(new Error(`the stock row is ${dec.reason || 'unavailable'}`), { code: 'gone' });
    if (dec.already) throw Object.assign(new Error('already recorded as sold'), { code: 'already_sold' });
    db.prepare('UPDATE in_person_sales SET sold_out = ?, effect = ? WHERE id = ?')
      .run(dec.sold ? 1 : 0, dec.effect ? JSON.stringify(dec.effect) : null, saleId);
    if (evItem) {
      // Never count more than is still away: a unit sold that was never taken came off the shelf at home.
      const stillAway = evItem.qty_taken - evItem.qty_returned - evItem.qty_sold_table - evItem.qty_sold_close;
      const n = Math.max(0, Math.min(qty, stillAway));
      if (n) db.prepare(`UPDATE event_items SET ${phase === 'close' ? 'qty_sold_close' : 'qty_sold_table'} = ${phase === 'close' ? 'qty_sold_close' : 'qty_sold_table'} + ? WHERE id = ?`).run(n, evItem.id);
    }
    db.exec('COMMIT');
    const after = db.prepare(`SELECT * FROM ${r.kind === 'sealed' ? 'sealed_items' : 'inventory_items'} WHERE id = ?`).get(r.row.id);
    return {
      ok: true, sale_id: saleId, kind: r.kind, qty, unit_price_cents: price, sold_out: !!dec.sold, event_id: evId,
      remaining: dec.newQty, item: summary(db, r.kind, after),
      jobs: q.jobs.map((j) => ({ id: j.id, channel: j.channel, target: j.target })),
    };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
    return { ok: false, code: e.code || 'failed', error: String(e?.message || e), line };
  }
}

/** Recent in-person sales, newest first, for the page's "today" list. */
export function recentInPersonSales(db, { limit = 50, since = null } = {}) {
  migrateChannelSync(db);
  const rows = since
    ? db.prepare('SELECT * FROM in_person_sales WHERE created_at >= ? ORDER BY id DESC LIMIT ?').all(String(since), Math.min(500, limit))
    : db.prepare('SELECT * FROM in_person_sales ORDER BY id DESC LIMIT ?').all(Math.min(500, limit));
  return rows.map((r) => ({ ...r, effect: undefined }));
}

/** Free-text lookup for the phone: an exact label first, then names. Held stock only. */
export function lookupStock(db, q, { limit = 20 } = {}) {
  migrateChannelSync(db);
  const s = clean(q);
  if (!s) return [];
  const out = [];
  const exact = previewInPerson(db, [{ sku: s }])[0];
  if (exact && exact.item) out.push({ ...exact.item, refusal: exact.ok ? null : { code: exact.code, error: exact.error } });
  const like = '%' + s.replace(/[%_]/g, '') + '%';
  for (const row of db.prepare(`SELECT * FROM inventory_items WHERE status IN ('in_stock','listed') AND (name LIKE ? OR sku LIKE ?)
                                 ORDER BY CASE WHEN UPPER(sku) = UPPER(?) THEN 0 ELSE 1 END, name LIMIT ?`).all(like, like, s, limit)) {
    if (!out.some((o) => o.kind === 'inventory' && o.id === row.id)) out.push(summary(db, 'inventory', row));
  }
  for (const row of db.prepare(`SELECT * FROM sealed_items WHERE status IN ('in_stock','listed') AND (name LIKE ? OR sku LIKE ? OR pool_sku LIKE ?)
                                 ORDER BY name LIMIT ?`).all(like, like, like, limit)) {
    if (!out.some((o) => o.kind === 'sealed' && o.id === row.id)) out.push(summary(db, 'sealed', row));
  }
  return out.slice(0, limit);
}
