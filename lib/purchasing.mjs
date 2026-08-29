// lib/purchasing.mjs — Vite plugin owning the PURCHASE-ORDER tables + the /api/purchasing/* API.
//
// The inbound counterpart to orders.html, which is the OUTBOUND eBay fulfilment queue. Nothing in
// here is stock: these are records of an intent to buy and what it cost. Stock exists only once a
// receive COMMITS, at which point the units go into sealed_items / inventory_items through the
// receiveSealed / receiveInventory seams and the line is stamped with what it produced.
//
// Shares the same openDb() handle and the same send/readJson/makeRouter shape as lib/sealed.mjs and
// lib/inventory.mjs; registered in vite.config.js `plugins`.
//
// Golden rules honoured: money is INTEGER CENTS stored in the currency it was sourced in, never
// pre-converted (GR3) — the ONE conversion happens at receiving, because the stock tables store AUD
// and have no currency column; an unsettled foreign order is labelled an estimate rather than
// presented as a settled cost (GR4); FX being down never blocks typing an order, and a deleted
// restock target never blocks putting goods away (GR7); no new deps (node:sqlite only).
import { openDb, DB_PATH } from './db.mjs';
import { STOCK_GAMES } from './normalize.mjs';
import { naturalCompare, sanitizePlacements, SEALED_GAMES, receiveSealed } from './sealed.mjs';
import { receiveInventory } from './inventory.mjs';
import {
  chargesPotCents, orderTotalCents, lineValueCents,
  paidCents, paymentStatus, effectiveFx, isFxEstimated, impliedFx,
} from './purchasing-money.mjs';

// ---- small http helpers (same shape as lib/sealed.mjs) ---------------------
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) b = b.slice(0, 1e6); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ---- vocabulary ------------------------------------------------------------
//
// Data, not logic — the page's dropdowns are built from GET /statuses, so the two can never disagree
// (the TYPES_BY_GAME idiom in lib/sealed.mjs).
export const STATUSES = ['draft', 'preorder', 'ordered', 'in_transit', 'arrived', 'received', 'closed', 'cancelled'];

// Legal moves. 'received' appears in NO list here on purpose: it is reachable only by committing a
// receive, exactly as grading_submissions reaches 'graded' only through promote. A PATCH asking for
// it is refused, because the status is a claim about stock existing and only the receive can make
// that true.
export const TRANSITIONS = {
  draft:      ['preorder', 'ordered', 'cancelled'],
  preorder:   ['ordered', 'cancelled'],
  ordered:    ['in_transit', 'arrived', 'cancelled'],
  in_transit: ['arrived', 'cancelled'],
  arrived:    ['cancelled'],            // -> 'received' via POST /orders/:id/receive only
  received:   ['closed'],
  closed:     [],
  cancelled:  ['draft'],                // reopening a cancelled order is a correction, not a new order
};

// Why a count did not match the order. `affects_stock` says whether the units are physically here:
// 'over' and 'damaged' still put goods on a shelf, 'short' and the rest do not.
export const DISCREPANCY_CODES = [
  { code: 'short',        label: 'Short-shipped',      affects_stock: true },
  { code: 'over',         label: 'Over-shipped',       affects_stock: true },
  { code: 'damaged',      label: 'Damaged in transit', affects_stock: true },
  { code: 'wrong_item',   label: 'Wrong item sent',    affects_stock: true },
  { code: 'not_shipped',  label: 'Never shipped',      affects_stock: false },
  { code: 'substituted',  label: 'Substituted',        affects_stock: true },
];

export const LINE_KINDS = ['unit', 'lot', 'grading'];
const LINE_TARGETS = ['sealed', 'inventory'];

const ORDER_COLS = [
  'supplier', 'supplier_ref', 'currency', 'shipping_cents', 'tax_cents', 'other_fees_cents',
  'discount_cents', 'fx_to_aud', 'fx_captured_at', 'ordered_at', 'release_date', 'eta_at',
  'carrier', 'tracking', 'arrived_at', 'default_location', 'notes',
];
const LINE_COLS = [
  'line_kind', 'target', 'game', 'product_type', 'name', 'set_name', 'language', 'upc', 'condition',
  'variant', 'number', 'identity_key', 'qty_ordered', 'unit_cost_cents', 'lot_total_cents', 'notes',
];
const PAYMENT_COLS = ['paid_at', 'amount_cents', 'currency', 'fx_to_order', 'method', 'reference', 'notes', 'aud_cents'];

function pick(body, cols) {
  const out = {};
  for (const c of cols) if (body[c] !== undefined) out[c] = body[c];
  return out;
}
function insertRow(db, table, obj) {
  const cols = Object.keys(obj);
  const ph = cols.map(() => '?').join(',');
  const r = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`).run(...cols.map((c) => obj[c]));
  return r.lastInsertRowid;
}
function patchRow(db, table, id, obj) {
  const cols = Object.keys(obj);
  if (!cols.length) return 0;
  const set = cols.map((c) => `${c} = ?`).join(', ');
  return db.prepare(`UPDATE ${table} SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .run(...cols.map((c) => obj[c]), id).changes;
}

// Human order handle. Its own sku_counter namespace, so it never collides with a stock SKU series and
// never rewinds — a reused PO number would point at two different deliveries.
function nextOrderRef(db) {
  db.prepare(`INSERT INTO sku_counter (namespace, seq) VALUES ('PO', 1)
              ON CONFLICT(namespace) DO UPDATE SET seq = seq + 1`).run();
  const { seq } = db.prepare(`SELECT seq FROM sku_counter WHERE namespace = 'PO'`).get();
  return 'PO-' + String(seq).padStart(6, '0');
}

const asCents = (v) => (v == null || v === '' ? null : Math.round(+v));
const trimOrNull = (v) => (v != null && String(v).trim() ? String(v).trim() : null);

// ---- reading an order ------------------------------------------------------

export function linesFor(db, orderId) {
  return db.prepare(`SELECT * FROM purchase_lines WHERE order_id = ? ORDER BY id`).all(orderId);
}
export function paymentsFor(db, orderId) {
  return db.prepare(`SELECT * FROM purchase_payments WHERE order_id = ? ORDER BY paid_at, id`).all(orderId);
}
export function placementsFor(db, lineId) {
  return db.prepare(`SELECT id, location, quantity FROM purchase_line_placements WHERE line_id = ? ORDER BY id`).all(lineId);
}

// Everything the list view and the drawer need to render one order without a second round trip, and
// without re-deriving money maths in the browser (the client's only job is TCG.toAUD at render time).
export function orderTotals(db, order, lines, payments) {
  const total = orderTotalCents(order, lines);
  const { paid, unconvertible } = paidCents(order, payments);
  const pay = paymentStatus(total, paid);
  const fx = effectiveFx(order);
  return {
    goods_cents: (lines || []).reduce((s, l) => s + lineValueCents(l), 0),
    charges_cents: chargesPotCents(order),
    total_cents: total,
    paid_cents: paid,
    balance_cents: pay.balance,
    payment_status: pay.status,
    overpaid: pay.overpaid,
    unconvertible_payments: unconvertible,
    currency: order.currency || 'AUD',
    fx,
    fx_estimated: isFxEstimated(order),
    unit_count: (lines || []).reduce((s, l) => s + (l.qty_ordered || 0), 0),
    line_count: (lines || []).length,
  };
}

// A linked line's target may have been sold, moved or deleted since it was picked. Resolved lazily on
// read so the drawer can say "record missing" rather than erroring, and so the receive preview can
// warn before anything is committed.
export function resolveLink(db, line) {
  if (!line.link_kind || line.link_item_id == null) return null;
  const table = line.link_kind === 'sealed' ? 'sealed_items' : 'inventory_items';
  const row = db.prepare(`SELECT id, sku, name, quantity, location, status, cost_cents, acq_fees_cents
                          FROM ${table} WHERE id = ?`).get(line.link_item_id);
  if (!row) return { alive: false, reason: 'deleted' };
  // The sku check is the guard against a restored-from-backup id collision: the id can be reused by a
  // different row, and silently attaching a restock to an unrelated card is worse than a warning.
  if (line.link_sku && row.sku !== line.link_sku) return { alive: false, reason: 'sku_changed', current: row };
  return { alive: true, current: row, landed_unit_cents: (row.cost_cents || 0) + (row.acq_fees_cents || 0) };
}

function orderPayload(db, order) {
  const lines = linesFor(db, order.id).map((l) => ({
    ...l,
    placements: placementsFor(db, l.id),
    link: resolveLink(db, l),
    value_cents: lineValueCents(l),
  }));
  const payments = paymentsFor(db, order.id);
  const receipt = db.prepare(`SELECT * FROM purchase_receipts WHERE order_id = ?`).get(order.id) || null;
  return { order, lines, payments, receipt, totals: orderTotals(db, order, lines, payments) };
}

// ---- validation ------------------------------------------------------------

function validateStatusChange(from, to) {
  if (from === to) return null;
  if (!STATUSES.includes(to)) return { error: 'unknown_status', status: to, known: STATUSES };
  if (to === 'received') {
    return { error: 'receive_via_endpoint',
      detail: 'a received order is a claim that stock exists; only POST /orders/:id/receive can make that true' };
  }
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) return { error: 'illegal_transition', from, to, allowed };
  return null;
}

// ---- the router ------------------------------------------------------------

function makeRouter({ db }) {
  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const q = url.searchParams;
      let m;

      // GET /statuses — the vocabulary + the legal moves, so the page's status dropdown can disable
      // what the server would refuse instead of finding out with a 409.
      if (p === '/statuses' && method === 'GET') {
        return send(res, 200, { statuses: STATUSES, transitions: TRANSITIONS, line_kinds: LINE_KINDS });
      }

      // GET /discrepancy-codes — why a count did not match.
      if (p === '/discrepancy-codes' && method === 'GET') {
        return send(res, 200, { codes: DISCREPANCY_CODES });
      }

      // GET /suppliers — DISTINCT names for the autocomplete. Deliberately unions the vendors already
      // recorded on stock, so the first purchase order can offer the names the owner has been typing
      // into sealed.html and inventory.html for months. This is the whole "supplier registry": a list
      // derived from what has been used, exactly like /api/sealed/locations.
      if (p === '/suppliers' && method === 'GET') {
        const rows = db.prepare(`SELECT DISTINCT s FROM (
            SELECT supplier AS s FROM purchase_orders
            UNION SELECT source_vendor FROM sealed_items
            UNION SELECT source_vendor FROM inventory_items
          ) WHERE s IS NOT NULL AND TRIM(s) <> ''`).all();
        return send(res, 200, { suppliers: rows.map((r) => r.s).sort(naturalCompare) });
      }

      // GET /stock — the RESTOCK PICKER. One ranked union over both stock tables with one paging
      // cursor, because many orders are simply more of a SKU already held.
      //
      // A new route rather than calling /api/sealed/items + /api/inventory/items: those return the full
      // item shape with valuation sparklines and per-UPC joins — hundreds of KB per keystroke. This is
      // a lean read-only projection, and it computes landed_unit_cents with the SAME
      // cost_cents + acq_fees_cents expression both summarizers use, so the page never re-derives it.
      if (p === '/stock' && method === 'GET') {
        const kind = q.get('kind');
        const status = q.get('status') || 'in_stock';     // you restock what you hold; 'all' widens it
        const game = trimOrNull(q.get('game'));
        const ptype = trimOrNull(q.get('product_type'));
        const set = trimOrNull(q.get('set'));
        const text = trimOrNull(q.get('q'));
        const limit = Math.min(200, Math.max(1, +(q.get('limit') || 50)));
        const offset = Math.max(0, +(q.get('offset') || 0));

        const where = [];
        const args = [];
        if (status !== 'all') { where.push('status = ?'); args.push(status); }
        if (game) { where.push('game = ?'); args.push(game); }
        if (set) { where.push('set_name LIKE ?'); args.push('%' + set + '%'); }
        if (text) { where.push('(name LIKE ? OR sku LIKE ?)'); args.push('%' + text + '%', text.toUpperCase() + '%'); }
        const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const out = [];
        if (kind !== 'inventory') {
          const sw = clause + (ptype ? (clause ? ' AND ' : 'WHERE ') + 'product_type = ?' : '');
          const sargs = ptype ? [...args, ptype] : args;
          out.push(...db.prepare(`SELECT 'sealed' AS kind, id, sku, name, set_name, game, product_type, language,
              condition, upc, NULL AS identity_key, NULL AS grading_company, NULL AS grade,
              quantity, location, status, cost_cents, acq_fees_cents, image_url
            FROM sealed_items ${sw}`).all(...sargs));
        }
        // product_type is a sealed-only facet; asking for one excludes singles/slabs by definition
        // rather than returning them unfiltered, which would read as "the filter did nothing".
        if (kind !== 'sealed' && !ptype) {
          out.push(...db.prepare(`SELECT 'inventory' AS kind, id, sku, name, set_name, game, NULL AS product_type, language,
              condition, NULL AS upc, identity_key, grading_company, grade,
              quantity, location, status, cost_cents, acq_fees_cents, image_url
            FROM inventory_items ${clause}`).all(...args));
        }
        for (const r of out) r.landed_unit_cents = (r.cost_cents || 0) + (r.acq_fees_cents || 0);
        // An exact SKU match first — typing a known label should not make you scroll.
        const exact = text ? text.toUpperCase() : null;
        out.sort((a, b) => {
          const ax = exact && a.sku === exact ? 0 : 1, bx = exact && b.sku === exact ? 0 : 1;
          return ax - bx || naturalCompare(a.name, b.name);
        });
        return send(res, 200, { items: out.slice(offset, offset + limit), total: out.length, limit, offset });
      }

      // GET /summary — counts and outstanding value for the hub tile and the masthead.
      // PER-CURRENCY subtotals, never a pre-folded AUD figure: the client folds with TCG.toAUD at
      // render time (GR3), exactly as /api/sealed/summary does.
      if (p === '/summary' && method === 'GET') {
        const orders = db.prepare(`SELECT * FROM purchase_orders`).all();
        const byStatus = {};
        const openByCur = {}, unpaidByCur = {}, preorderByCur = {};
        for (const o of orders) {
          byStatus[o.status] = (byStatus[o.status] || 0) + 1;
          const t = orderTotals(db, o, linesFor(db, o.id), paymentsFor(db, o.id));
          const cur = t.currency;
          if (['ordered', 'in_transit', 'arrived'].includes(o.status)) openByCur[cur] = (openByCur[cur] || 0) + t.total_cents;
          if (o.status === 'preorder') preorderByCur[cur] = (preorderByCur[cur] || 0) + t.total_cents;
          if (!['cancelled', 'closed'].includes(o.status) && t.balance_cents > 0) unpaidByCur[cur] = (unpaidByCur[cur] || 0) + t.balance_cents;
        }
        return send(res, 200, {
          counts: byStatus,
          open_by_currency: openByCur,
          unpaid_by_currency: unpaidByCur,
          preorder_by_currency: preorderByCur,
          orders: orders.length,
        });
      }

      // GET /orders — the register. Facets rather than raw status filters, because the questions the
      // owner actually asks are "where is my stuff", "what have I preordered" and "what needs
      // counting" — and a preorder must never sit in the first of those.
      if (p === '/orders' && method === 'GET') {
        const facet = q.get('facet') || 'all';
        const supplier = trimOrNull(q.get('supplier'));
        const status = trimOrNull(q.get('status'));
        const text = trimOrNull(q.get('q'));
        let rows = db.prepare(`SELECT * FROM purchase_orders ORDER BY
            COALESCE(eta_at, release_date, ordered_at, created_at) DESC, id DESC`).all();
        if (supplier) rows = rows.filter((o) => (o.supplier || '').toLowerCase() === supplier.toLowerCase());
        if (status) rows = rows.filter((o) => o.status === status);
        if (text) {
          const t = text.toLowerCase();
          rows = rows.filter((o) => [o.ref, o.supplier, o.supplier_ref, o.tracking, o.notes]
            .some((v) => v && String(v).toLowerCase().includes(t)));
        }
        const today = new Date().toISOString().slice(0, 10);
        const decorate = (o) => {
          const lines = linesFor(db, o.id);
          const totals = orderTotals(db, o, lines, paymentsFor(db, o.id));
          const outstanding = ['ordered', 'in_transit', 'arrived'].includes(o.status);
          return {
            ...o,
            ...totals,
            outstanding,
            overdue: outstanding && !!o.eta_at && o.eta_at < today,
            to_reconcile: o.status === 'arrived' && lines.some((l) => l.qty_received == null),
          };
        };
        const all = rows.map(decorate);
        const inFacet = (o) => (
          facet === 'outstanding' ? o.outstanding
          : facet === 'preorder' ? o.status === 'preorder'
          : facet === 'to_reconcile' ? o.to_reconcile
          : facet === 'received' ? ['received', 'closed'].includes(o.status)
          : facet === 'cancelled' ? o.status === 'cancelled'
          : true);
        return send(res, 200, {
          orders: all.filter(inFacet),
          counts: {
            outstanding: all.filter((o) => o.outstanding).length,
            preorder: all.filter((o) => o.status === 'preorder').length,
            to_reconcile: all.filter((o) => o.to_reconcile).length,
            received: all.filter((o) => ['received', 'closed'].includes(o.status)).length,
            cancelled: all.filter((o) => o.status === 'cancelled').length,
            all: all.length,
          },
        });
      }

      // POST /orders — create, optionally with its lines in one call.
      if (p === '/orders' && method === 'POST') {
        const b = await readJson(req);
        const obj = pick(b, ORDER_COLS);
        obj.currency = String(obj.currency || 'AUD').toUpperCase();
        obj.supplier = trimOrNull(obj.supplier);
        obj.status = STATUSES.includes(b.status) && b.status !== 'received' ? b.status : 'draft';
        if (obj.status === 'preorder' && !obj.release_date) {
          return send(res, 400, { error: 'release_date_required',
            detail: 'a preorder is an order whose product does not exist yet — without a street date it is just an order' });
        }
        for (const c of ['shipping_cents', 'tax_cents', 'other_fees_cents', 'discount_cents']) {
          if (obj[c] !== undefined) obj[c] = asCents(obj[c]);
        }
        let id, ref;
        db.exec('BEGIN');
        try {
          ref = nextOrderRef(db);
          obj.ref = ref;
          id = insertRow(db, 'purchase_orders', obj);
          for (const raw of (Array.isArray(b.lines) ? b.lines : [])) addLine(db, id, raw);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return send(res, 201, { id, ref, created: true });
      }

      // GET /orders/:id — the drawer's whole payload in one round trip.
      if ((m = p.match(/^\/orders\/(\d+)$/)) && method === 'GET') {
        const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(+m[1]);
        if (!order) return send(res, 404, { error: 'no_such_order' });
        return send(res, 200, orderPayload(db, order));
      }

      // PATCH /orders/:id — header edits and status moves.
      if ((m = p.match(/^\/orders\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
        if (!order) return send(res, 404, { error: 'no_such_order' });
        const b = await readJson(req);
        const obj = pick(b, ORDER_COLS);
        for (const c of ['shipping_cents', 'tax_cents', 'other_fees_cents', 'discount_cents']) {
          if (obj[c] !== undefined) obj[c] = asCents(obj[c]);
        }
        if (obj.currency !== undefined) obj.currency = String(obj.currency || 'AUD').toUpperCase();
        if (obj.supplier !== undefined) obj.supplier = trimOrNull(obj.supplier);
        if (b.status !== undefined) {
          const bad = validateStatusChange(order.status, b.status);
          if (bad) return send(res, bad.error === 'unknown_status' ? 400 : 409, bad);
          const nextRelease = obj.release_date !== undefined ? obj.release_date : order.release_date;
          if (b.status === 'preorder' && !nextRelease) return send(res, 400, { error: 'release_date_required' });
          obj.status = b.status;
          // Stamp the date the move implies, so the register can sort on it without the UI having to
          // remember to send it.
          if (b.status === 'ordered' && !order.ordered_at) obj.ordered_at = b.ordered_at || new Date().toISOString().slice(0, 10);
          if (b.status === 'arrived' && !order.arrived_at) obj.arrived_at = b.arrived_at || new Date().toISOString().slice(0, 10);
          if (b.status === 'cancelled') obj.cancelled_at = new Date().toISOString();
        }
        patchRow(db, 'purchase_orders', id, obj);
        return send(res, 200, orderPayload(db, db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id)));
      }

      // DELETE /orders/:id — only before it produced stock. Once received, the order is the paper
      // trail behind a cost basis that is already booked; deleting it would orphan po_line_id.
      if ((m = p.match(/^\/orders\/(\d+)$/)) && method === 'DELETE') {
        const id = +m[1];
        const order = db.prepare(`SELECT status FROM purchase_orders WHERE id = ?`).get(id);
        if (!order) return send(res, 404, { error: 'no_such_order' });
        if (db.prepare(`SELECT 1 FROM purchase_receipts WHERE order_id = ?`).get(id)) {
          return send(res, 409, { error: 'already_received', detail: 'cancel it instead — the cost basis is booked on stock' });
        }
        db.prepare(`DELETE FROM purchase_orders WHERE id = ?`).run(id);
        return send(res, 200, { removed: true });
      }

      // POST /orders/:id/lines — add one line, or several.
      if ((m = p.match(/^\/orders\/(\d+)\/lines$/)) && method === 'POST') {
        const id = +m[1];
        const order = db.prepare(`SELECT id, status FROM purchase_orders WHERE id = ?`).get(id);
        if (!order) return send(res, 404, { error: 'no_such_order' });
        if (db.prepare(`SELECT 1 FROM purchase_receipts WHERE order_id = ?`).get(id)) {
          return send(res, 409, { error: 'already_received' });
        }
        const b = await readJson(req);
        const raws = Array.isArray(b.lines) ? b.lines : [b];
        const ids = [];
        db.exec('BEGIN');
        try {
          for (const raw of raws) ids.push(addLine(db, id, raw));
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          return send(res, 400, { error: 'bad_line', detail: e?.message || String(e) });
        }
        return send(res, 201, { ids });
      }

      // PATCH /lines/:id
      if ((m = p.match(/^\/lines\/(\d+)$/)) && method === 'PATCH') {
        const lineId = +m[1];
        const line = db.prepare(`SELECT * FROM purchase_lines WHERE id = ?`).get(lineId);
        if (!line) return send(res, 404, { error: 'no_such_line' });
        if (line.received_item_id != null || line.received_batch_id != null) {
          return send(res, 409, { error: 'line_received', detail: 'this line already produced stock' });
        }
        const b = await readJson(req);
        const obj = pick(b, LINE_COLS);
        for (const c of ['unit_cost_cents', 'lot_total_cents']) if (obj[c] !== undefined) obj[c] = asCents(obj[c]);
        if (obj.qty_ordered !== undefined) obj.qty_ordered = Math.max(1, Math.round(+obj.qty_ordered || 1));
        if (b.link !== undefined) Object.assign(obj, linkFields(db, b.link));
        patchRow(db, 'purchase_lines', lineId, obj);
        return send(res, 200, { updated: true });
      }

      // DELETE /lines/:id
      if ((m = p.match(/^\/lines\/(\d+)$/)) && method === 'DELETE') {
        const lineId = +m[1];
        const line = db.prepare(`SELECT received_item_id, received_batch_id FROM purchase_lines WHERE id = ?`).get(lineId);
        if (!line) return send(res, 404, { error: 'no_such_line' });
        if (line.received_item_id != null || line.received_batch_id != null) {
          return send(res, 409, { error: 'line_received' });
        }
        db.prepare(`DELETE FROM purchase_lines WHERE id = ?`).run(lineId);
        return send(res, 200, { removed: true });
      }

      // GET /orders/:id/payments
      if ((m = p.match(/^\/orders\/(\d+)\/payments$/)) && method === 'GET') {
        const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(+m[1]);
        if (!order) return send(res, 404, { error: 'no_such_order' });
        const payments = paymentsFor(db, order.id);
        return send(res, 200, { payments, ...orderTotals(db, order, linesFor(db, order.id), payments) });
      }

      // POST /orders/:id/payments — a deposit, an instalment, the balance, or a refund (negative).
      if ((m = p.match(/^\/orders\/(\d+)\/payments$/)) && method === 'POST') {
        const id = +m[1];
        const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
        if (!order) return send(res, 404, { error: 'no_such_order' });
        const b = await readJson(req);
        if (b.amount_cents == null || !Number.isFinite(+b.amount_cents)) {
          return send(res, 400, { error: 'amount_required' });
        }
        const obj = pick(b, PAYMENT_COLS);
        obj.order_id = id;
        obj.amount_cents = asCents(b.amount_cents);
        obj.currency = String(b.currency || order.currency || 'AUD').toUpperCase();
        obj.aud_cents = asCents(b.aud_cents);
        if (!obj.paid_at) obj.paid_at = new Date().toISOString().slice(0, 10);
        const pid = insertRow(db, 'purchase_payments', obj);
        const payments = paymentsFor(db, id);
        return send(res, 201, { id: pid, ...orderTotals(db, order, linesFor(db, id), payments) });
      }

      // DELETE /payments/:id
      if ((m = p.match(/^\/payments\/(\d+)$/)) && method === 'DELETE') {
        const pid = +m[1];
        const row = db.prepare(`SELECT order_id FROM purchase_payments WHERE id = ?`).get(pid);
        if (!row) return send(res, 404, { error: 'no_such_payment' });
        db.prepare(`DELETE FROM purchase_payments WHERE id = ?`).run(pid);
        const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(row.order_id);
        return send(res, 200, { removed: true, ...orderTotals(db, order, linesFor(db, order.id), paymentsFor(db, order.id)) });
      }

      // POST /orders/:id/settle — what the bank actually took. This is the moment a live-FX estimate
      // becomes a settled cost basis, so the implied rate is computed and STORED here rather than
      // derived on read: the order total stays editable, and a derived rate would silently rewrite a
      // cost basis already sitting on stock rows.
      if ((m = p.match(/^\/orders\/(\d+)\/settle$/)) && method === 'POST') {
        const id = +m[1];
        const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
        if (!order) return send(res, 404, { error: 'no_such_order' });
        const b = await readJson(req);
        const lines = linesFor(db, id);
        const payments = paymentsFor(db, id);
        // 'from_payments' sums the AUD actually recorded against the order — the common case, where
        // the statement figures are already typed in.
        let audCents = asCents(b.settled_aud_cents);
        if (b.from_payments) {
          audCents = payments.reduce((s, p) => s + (
            String(p.currency).toUpperCase() === 'AUD' ? (p.amount_cents || 0) : (p.aud_cents || 0)
          ), 0);
        }
        if (audCents == null) return send(res, 400, { error: 'settled_aud_cents_required' });
        const total = orderTotalCents(order, lines);
        const fx = impliedFx(audCents, total);
        patchRow(db, 'purchase_orders', id, {
          settled_aud_cents: audCents,
          settled_fx_to_aud: fx,
          settled_at: b.settled_at || new Date().toISOString(),
          settled_source: b.settled_source || 'manual',
        });
        const after = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
        return send(res, 200, {
          settled_aud_cents: audCents, settled_fx_to_aud: fx,
          order_total_cents: total,
          ...orderTotals(db, after, lines, payments),
        });
      }

      return send(res, 404, { error: 'unknown_route', path: p });
    } catch (e) {
      console.error('[purchasing]', e?.stack || e?.message || e);
      return send(res, 500, { error: 'server_error', detail: e?.message || String(e) });
    }
  };
}

// Snapshot the identity of a picked stock row onto the line. link_sku guards a reused id and
// link_snapshot is what lets a receive still put goods away after the target is deleted (GR7).
function linkFields(db, link) {
  if (!link || link.clear || !link.kind || link.item_id == null) {
    return { link_kind: null, link_item_id: null, link_sku: null, link_snapshot: null };
  }
  const kind = link.kind === 'sealed' ? 'sealed' : 'inventory';
  const table = kind === 'sealed' ? 'sealed_items' : 'inventory_items';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(+link.item_id);
  if (!row) throw new Error('no such ' + kind + ' item ' + link.item_id);
  const snap = {
    game: row.game, name: row.name, set_name: row.set_name, language: row.language,
    product_type: row.product_type ?? null, upc: row.upc ?? null, condition: row.condition ?? null,
    identity_key: row.identity_key ?? null, number: row.number ?? null, variant: row.variant ?? null,
    grading_company: row.grading_company ?? null, grade: row.grade ?? null,
  };
  return { link_kind: kind, link_item_id: row.id, link_sku: row.sku, link_snapshot: JSON.stringify(snap) };
}

function addLine(db, orderId, raw) {
  const obj = pick(raw, LINE_COLS);
  obj.order_id = orderId;
  obj.line_kind = LINE_KINDS.includes(raw.line_kind) ? raw.line_kind : 'unit';
  obj.target = LINE_TARGETS.includes(raw.target) ? raw.target : 'sealed';
  obj.qty_ordered = Math.max(1, Math.round(+raw.qty_ordered || 1));
  obj.unit_cost_cents = asCents(raw.unit_cost_cents);
  obj.lot_total_cents = asCents(raw.lot_total_cents);
  Object.assign(obj, linkFields(db, raw.link));
  // A linked line inherits its identity from the stock row it points at, so a restock needs nothing
  // typed. An unlinked one must at least be named — a line nobody can identify cannot be received.
  if (obj.link_snapshot) {
    const snap = JSON.parse(obj.link_snapshot);
    obj.target = obj.link_kind;
    for (const k of ['game', 'name', 'set_name', 'language', 'product_type', 'upc', 'condition', 'identity_key', 'number', 'variant']) {
      if (obj[k] == null && snap[k] != null) obj[k] = snap[k];
    }
  }
  if (!obj.name) throw new Error('a line needs a name, or a linked stock row to take one from');
  const games = obj.target === 'sealed' ? SEALED_GAMES : STOCK_GAMES;
  if (obj.game != null && !games.includes(obj.game)) obj.game = obj.target === 'sealed' ? 'other' : null;
  return insertRow(db, 'purchase_lines', obj);
}

export function purchasingPlugin() {
  return {
    name: 'purchasing',
    configureServer(server) {
      const db = openDb();
      server.middlewares.use('/api/purchasing', makeRouter({ db }));
      console.log('[purchasing] DB ' + DB_PATH + ' · API /api/purchasing');
    },
  };
}
