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
  chargesPotCents, orderTotalCents, lineValueCents, allocateCharges, splitEvenly,
  perUnitFeesCents, blendUnitCents, toAudCents,
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
  // Deliberately EMPTY, for the same reason 'received' is unreachable above: closing runs checks
  // (a receipt exists, nothing still owed unless forced) and stamps closed_at. Leaving 'closed' here
  // gave the page a second door with none of that — and since fillOrderForm builds its dropdown from
  // this table, it was the only door the UI offered on a received order.
  received:   [],                       // -> 'closed' via POST /orders/:id/close only
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

// A ceiling on how many items a lot may contain. splitEvenly builds an array of this length, and it
// runs inside the dry preview, so an unbounded value turns a read-only request into an OOM.
export const MAX_LOT_UNITS = 100000;

// What "we still have this" means for a restock target. NOT just 'in_stock': a listed product is on
// eBay, not gone, and lib/sealed.mjs's valuation query uses the same pair. Sold is the only status
// that disqualifies a row from being topped up.
export const HELD_STATUSES = ['in_stock', 'listed'];

const ORDER_COLS = [
  'supplier', 'supplier_ref', 'currency', 'shipping_cents', 'tax_cents', 'other_fees_cents',
  'discount_cents', 'fx_to_aud', 'fx_captured_at', 'ordered_at', 'release_date', 'eta_at',
  'carrier', 'tracking', 'arrived_at', 'default_location', 'notes',
];
const LINE_COLS = [
  'line_kind', 'target', 'game', 'product_type', 'name', 'set_name', 'language', 'upc', 'condition',
  'variant', 'number', 'identity_key', 'qty_ordered', 'unit_cost_cents', 'lot_total_cents', 'notes',
  'submission_ids',
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
// Neutralise LIKE's own wildcards so a search TERM containing % or _ matches those characters
// literally. Paired with an ESCAPE '\' clause at every call site.
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

// The grading_submissions a 'grading' line is paying for, stored as a JSON array in its own column.
// It used to ride in identity_key, which is a PRODUCT identity everywhere else in this schema and is
// copied verbatim out of link_snapshot — so a real key like 'sv4-25' parsed to NaN, got filtered
// out, and the fee was applied to nothing at all without an error.
export function parseSubmissionIds(raw) {
  if (raw == null) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(v)) return [];
    // Deduped: the gate compares ids.length against the cards counted, so [7,7] on a two-unit line
    // would pass and then run the fee UPDATE twice against submission 7 — a multiple of the per-card
    // fee into one permanent cost basis, and nothing at all for the card that was missed.
    return [...new Set(v.map((n) => Math.round(+n)).filter((n) => Number.isFinite(n) && n > 0))];
  } catch { return []; }
}

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
  // A row that has SOLD is not a merge target: the card can sell while its restock is still on the
  // water, and merging six boxes onto it hides them from every in-stock view while summarizeSealed
  // goes on counting them as sold.
  //
  // 'listed' is emphatically still HELD, and restocking something currently on eBay is the ordinary
  // case — the picker offers a `listed` filter for exactly that, and lib/sealed.mjs's own valuation
  // query treats status IN ('in_stock','listed') as stock on hand. Refusing it here split the pile
  // across two SKUs, left the live listing's quantity untouched and never blended the cost basis.
  if (!HELD_STATUSES.includes(row.status)) return { alive: false, reason: 'not_held', current: row };
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

// The only statuses an order may be BORN in. A purchase order starts life somewhere on the way to
// being placed, never at the end of it: creating one directly in 'arrived' skips the whole history,
// and 'closed'/'received' would assert facts (a receipt exists, money is settled) that the endpoints
// owning those states verify and a create cannot.
const CREATE_STATUSES = ['draft', 'preorder', 'ordered'];

function validateStatusChange(from, to) {
  if (from === to) return null;
  if (!STATUSES.includes(to)) return { error: 'unknown_status', status: to, known: STATUSES };
  if (to === 'received') {
    return { error: 'receive_via_endpoint',
      detail: 'a received order is a claim that stock exists; only POST /orders/:id/receive can make that true' };
  }
  if (to === 'closed') {
    return { error: 'close_via_endpoint',
      detail: 'closing checks the order was received and nothing is owed; only POST /orders/:id/close does that' };
  }
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) return { error: 'illegal_transition', from, to, allowed };
  return null;
}

// ---- receiving: the gate ---------------------------------------------------
//
// Nothing moves from ordered to in-stock without somebody counting it. These are the reasons a line
// is not ready, and every one of them blocks the whole order — a half-received delivery is exactly
// the state this design refuses to have.
//
// Pure over rows the caller already read, so it is unit-testable without a database.
// `db` is optional: the pure-logic tests pass none, and the submission-existence check is simply
// skipped when it is absent. Every caller inside the server supplies it.
export function reconcileGate(lines, db = null) {
  const blocking = [];
  for (const l of lines) {
    const at = { line_id: l.id, name: l.name };
    if (l.qty_received == null) { blocking.push({ ...at, reason: 'uncounted' }); continue; }
    if (l.qty_received !== l.qty_ordered && !l.discrepancy) {
      blocking.push({ ...at, reason: 'discrepancy_reason_required', ordered: l.qty_ordered, counted: l.qty_received });
      continue;
    }
    if (l.qty_received > 0) {
      const placed = (l.placements || []).reduce((s, p) => s + (p.quantity || 0), 0);
      // Only when spots were named at all: no placements means "wherever the order says", which the
      // plan resolves. A PARTIAL split, though, is someone mid-edit, and putting the remainder
      // somewhere silently is how stock goes missing.
      if (placed > 0 && placed !== l.qty_received) {
        blocking.push({ ...at, reason: 'placements_mismatch', counted: l.qty_received, placed });
        continue;
      }
      if ((l.placements || []).length > 1 && l.line_kind !== 'unit') {
        blocking.push({ ...at, reason: 'split_not_supported',
          detail: 'only a sealed unit line can split across spots; singles and lots carry one location' });
        continue;
      }
      if (l.line_kind === 'unit' && l.target === 'inventory' && (l.placements || []).length > 1) {
        blocking.push({ ...at, reason: 'split_not_supported',
          detail: 'inventory_items has a scalar location — splitting is a sealed-only capability' });
        continue;
      }
      if (l.line_kind === 'lot' && !(l.lot_units > 0)) {
        blocking.push({ ...at, reason: 'lot_units_required',
          detail: 'a lot needs to know how many items came out before its cost can be split evenly' });
      }
      // A grading line's whole effect is writing the fee onto its submissions. With none named there
      // is nothing to write it to, and the money would vanish without an error.
      if (l.line_kind === 'grading') {
        const ids = parseSubmissionIds(l.submission_ids);
        // Checked against the DB, not just counted: an id for a deleted submission, or one whose
        // slab has already been promoted, takes the UPDATE without error and the money vanishes —
        // which is the failure grading_submissions_required was added to prevent in the first place.
        // promote() copies grading_cost_cents onto the slab AT PROMOTE TIME, so a fee arriving after
        // that never reaches the card.
        const unusable = db ? ids.filter((id) => {
          const row = db.prepare(`SELECT promoted_item_id FROM grading_submissions WHERE id = ?`).get(id);
          return !row || row.promoted_item_id != null;
        }) : [];
        if (unusable.length) {
          blocking.push({ ...at, reason: 'grading_submissions_unusable', submission_ids: unusable,
            detail: 'these submissions are gone or already promoted — the fee would land on nothing' });
        } else if (!ids.length) {
          blocking.push({ ...at, reason: 'grading_submissions_required',
            detail: 'name the grading submissions this fee is for, or the cost lands on nothing' });
        } else if (ids.length !== l.qty_received) {
          // unit_cost_cents on a grading line is the fee for ONE card, so one submission is one
          // counted unit. Any other ratio books a total that is not what was paid — three ids on a
          // one-unit line would put 3x the fee into three permanent cost bases.
          blocking.push({ ...at, reason: 'grading_count_mismatch', counted: l.qty_received, submissions: ids.length,
            detail: 'one submission per card graded — the per-card fee is booked once each' });
        }
      }
    }
  }
  return { ok: blocking.length === 0, blocking };
}

// ---- receiving: the plan ---------------------------------------------------
//
// Pure with respect to the database — it READS to resolve links, and writes nothing. The preview
// endpoint returns exactly this, and the commit applies exactly this, so what the owner approved is
// what happens.
export function buildPlan(db, order, lines, opts = {}) {
  const fx = effectiveFx(order);
  const currency = String(order.currency || 'AUD').toUpperCase();
  const basis = opts.basis === 'qty' ? 'qty' : 'value';
  const defaultLocation = opts.default_location || order.default_location || null;

  const gate = reconcileGate(lines, db);
  const blockers = [...gate.blocking];

  // A foreign order with no rate cannot be written to stock at all: the stock tables store AUD, and
  // GR3 forbids inventing the number. The remedy is one tap on the page (capture the live rate, or
  // enter the settled amount), which is why this is a blocker with a name rather than a 500.
  if (currency !== 'AUD' && fx == null) {
    blockers.push({ reason: 'fx_required', currency,
      detail: 'stock is stored in AUD and there is no rate to convert at — capture one or settle the order' });
  }

  // The pot is spread over the lines that actually brought goods in. A line that never shipped
  // carries no freight, because it carried nothing.
  const eligible = lines.filter((l) => l.qty_received > 0);
  const alloc = allocateCharges(chargesPotCents(order), eligible.map((l) => ({
    id: l.id, line_kind: l.line_kind, unit_cost_cents: l.unit_cost_cents,
    lot_total_cents: l.lot_total_cents, qty: l.qty_received,
  })), basis);

  const steps = [];
  for (const l of lines) {
    const allocCents = alloc.get(l.id) || 0;
    if (!(l.qty_received > 0)) {
      steps.push({ line_id: l.id, name: l.name, action: 'skip', reason: l.discrepancy || 'nothing_received' });
      continue;
    }

    // Where the units go. Named spots win; otherwise the order's default; otherwise unassigned.
    const named = sanitizePlacements(l.placements || []);
    const places = named.length ? named : [{ location: defaultLocation, quantity: l.qty_received }];

    if (l.line_kind === 'lot') {
      // The lump plus its freight share, split EVENLY across the items that came out — the owner's
      // rule, and it has to sum back to the lump exactly. A remainder means two buckets (six at 143c
      // and one at 142c), which is why a lot can produce two rows.
      const totalNative = (l.lot_total_cents || 0) + allocCents;
      // Guarded HERE as well as at the count route, because this is where the array is allocated —
      // a row written before the ceiling existed, or restored from a backup, still reaches it.
      if (l.lot_units > MAX_LOT_UNITS) {
        blockers.push({ line_id: l.id, name: l.name, reason: 'lot_units_too_large',
          lot_units: l.lot_units, max: MAX_LOT_UNITS });
        continue;
      }
      const per = splitEvenly(totalNative, l.lot_units);
      const buckets = [];
      for (const cents of per) {
        const audc = toAudCents(cents, currency, fx);
        const hit = buckets.find((b) => b.unit_cents === audc);
        if (hit) hit.qty += 1; else buckets.push({ qty: 1, unit_cents: audc, native_unit_cents: cents });
      }
      steps.push({
        line_id: l.id, name: l.name, kind: 'lot', action: 'new_lot',
        qty: l.qty_received, lot_units: l.lot_units, buckets,
        location: places[0].location, alloc_fees_cents: allocCents,
        native_total_cents: totalNative,
      });
      continue;
    }

    if (l.line_kind === 'grading') {
      // You already own these cards; you are buying a service. Nothing enters stock — the fee lands
      // on the grading submissions, which promote already folds into acq_fees_cents.
      steps.push({
        line_id: l.id, name: l.name, kind: 'grading', action: 'fee',
        qty: l.qty_received, alloc_fees_cents: allocCents,
        fee_cents: toAudCents((l.unit_cost_cents || 0) + perUnitFeesCents(allocCents, l.qty_received), currency, fx),
      });
      continue;
    }

    // A 'unit' line. Where do the units land?
    const link = resolveLink(db, l);
    let target = link && link.alive ? link.current : null;
    let linkNote = null;
    if (l.link_kind && !target) {
      // The picked row is gone. Try to find the same product still in stock before giving up — a
      // deleted-and-recreated record is common, and stranding a delivery over it would be absurd.
      const snap = l.link_snapshot ? JSON.parse(l.link_snapshot) : null;
      const hits = snap ? identityMatches(db, l.link_kind, snap) : [];
      // One hit is unambiguous. TWO usually means the ordinary split — part of the pile on the shelf,
      // part of it listed — which widening this query to include 'listed' newly made possible; prefer
      // the in_stock row rather than minting a third SKU, since that is where new units land anyway.
      // Anything genuinely ambiguous still creates: guessing between two equal candidates is worse
      // than a row the owner can merge by hand.
      const inStock = hits.filter((h) => h.status === 'in_stock');
      if (hits.length === 1) { target = hits[0]; linkNote = 'link_repaired'; }
      else if (inStock.length === 1) { target = inStock[0]; linkNote = 'link_repaired'; }
      else linkNote = 'link_broken';
    }

    const unitRaw = toAudCents(l.unit_cost_cents, currency, fx);
    const unitFees = toAudCents(perUnitFeesCents(allocCents, l.qty_received), currency, fx);
    const kind = target ? (l.link_kind || l.target) : l.target;

    steps.push({
      line_id: l.id, name: l.name, kind, link_note: linkNote,
      action: target ? 'merge' : 'new',
      target_id: target ? target.id : null,
      target_sku: target ? target.sku : null,
      target_qty_before: target ? target.quantity : null,
      qty: l.qty_received,
      placements: places,
      location: places[0].location,
      cost_cents: unitRaw,
      acq_fees_cents: unitFees,
      landed_unit_cents: unitRaw == null || unitFees == null ? null : unitRaw + unitFees,
      alloc_fees_cents: allocCents,
      // Both sides of the blend, captured here where the target row is actually in hand. The
      // weighted average rewrites an existing cost basis, so "what was it before" is the number that
      // makes it reversible by hand — and it has to be read off the row BEFORE the merge writes over
      // it, which is why the commit cannot recover it on its own.
      blend_before: target ? {
        quantity: target.quantity,
        cost_cents: target.cost_cents,
        acq_fees_cents: target.acq_fees_cents,
      } : null,
      blend_after: target ? {
        cost_cents: blendUnitCents(target.cost_cents, target.quantity, unitRaw, l.qty_received),
        acq_fees_cents: blendUnitCents(target.acq_fees_cents, target.quantity, unitFees, l.qty_received),
      } : null,
    });
  }

  const potCents = chargesPotCents(order);
  return {
    steps, blockers, basis, currency, fx,
    fx_estimated: isFxEstimated(order),
    pot_cents: potCents,
    allocated_cents: [...alloc.values()].reduce((a, b) => a + b, 0),
    // The per-unit ceil overstates cost by at most (qty-1) cents per line. Surfaced rather than
    // hidden, so the ledger on screen adds up to what the eye expects.
    rounding_residue_cents: steps.reduce((s, st) => (
      st.action === 'merge' || st.action === 'new'
        ? s + (perUnitFeesCents(st.alloc_fees_cents, st.qty) * st.qty - st.alloc_fees_cents)
        : s), 0),
  };
}

// Same product, still held — the fallback when a linked row has been deleted. "Held" is the same
// pair resolveLink uses (in_stock OR listed); a repair path narrower than the direct path would send
// a listed product down the create branch the moment its link broke. Deliberately
// conservative: it merges only on an unambiguous single hit, because guessing which of two similar
// rows a delivery belongs to is worse than creating a new one the owner can merge by hand.
function identityMatches(db, kind, snap) {
  if (kind === 'sealed') {
    return db.prepare(`SELECT id, sku, status, quantity, cost_cents, acq_fees_cents FROM sealed_items
      WHERE status IN (${HELD_STATUSES.map(() => '?').join(',')}) AND name = ? AND IFNULL(game,'') = IFNULL(?,'')
        AND IFNULL(set_name,'') = IFNULL(?,'') AND IFNULL(language,'') = IFNULL(?,'')
        AND IFNULL(product_type,'') = IFNULL(?,'')`)
      .all(...HELD_STATUSES, snap.name, snap.game, snap.set_name, snap.language, snap.product_type);
  }
  return db.prepare(`SELECT id, sku, status, quantity, cost_cents, acq_fees_cents FROM inventory_items
    WHERE status IN (${HELD_STATUSES.map(() => '?').join(',')}) AND name = ? AND IFNULL(game,'') = IFNULL(?,'')
      AND IFNULL(set_name,'') = IFNULL(?,'') AND IFNULL(language,'') = IFNULL(?,'')
      AND IFNULL(condition,'') = IFNULL(?,'') AND IFNULL(grading_company,'') = IFNULL(?,'')`)
    .all(...HELD_STATUSES, snap.name, snap.game, snap.set_name, snap.language, snap.condition, snap.grading_company);
}

// ---- receiving: the commit -------------------------------------------------
//
// ONE transaction. The receipt INSERT goes first, because UNIQUE(order_id) is what makes a second
// receive impossible: a double tap, a retried fetch or a second tab throws on the constraint and the
// whole thing rolls back before a single unit of stock has moved.
export function commitReceive(db, order, lines, plan, receivedAt) {
  const result = [];
  db.exec('BEGIN');
  try {
    const receiptId = insertRow(db, 'purchase_receipts', {
      order_id: order.id, received_at: receivedAt, alloc_basis: plan.basis,
      alloc_total_cents: plan.pot_cents, fx_used: plan.fx,
      preview: JSON.stringify(plan.steps),
    });

    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const step of plan.steps) {
      const line = byId.get(step.line_id);
      if (step.action === 'skip') { result.push({ ...step }); continue; }

      if (step.action === 'fee') {
        // Grading: the fee lands on the submissions this line paid for. promote() already folds
        // grading_cost_cents into the slab's acq_fees_cents, so there is no new plumbing here.
        const ids = parseSubmissionIds(line.submission_ids);
        for (const sid of ids) {
          // ADDING ACROSS CURRENCIES IS THE BUG THIS GUARDS. step.fee_cents is AUD (toAudCents ran on
          // it upstream), but card-grader.html seeds the same column in the company's NATIVE currency —
          // USD for everyone except PCG, per data/grading.config.json's own note. A blind `+=` turned
          // A$120 and US$79.99 into "19999" of nothing.
          //
          // So: add only into a column that is already AUD or empty. A native-currency figure is
          // REPLACED and the currency stamped, because the fee actually paid — the one on the invoice
          // being received — is the truth, and the grader's sticker price was only ever an estimate.
          // Either way the row comes out of here in one currency, named.
          const cur = db.prepare('SELECT grading_cost_cents, grading_cost_currency FROM grading_submissions WHERE id = ?').get(sid);
          const addable = !cur || cur.grading_cost_cents == null
            || String(cur.grading_cost_currency || 'AUD').toUpperCase() === 'AUD';
          db.prepare(`UPDATE grading_submissions
                        SET grading_cost_cents = ${addable ? 'COALESCE(grading_cost_cents, 0) + ?' : '?'},
                            grading_cost_currency = 'AUD',
                            updated_at = datetime('now')
                      WHERE id = ?`).run(step.fee_cents, sid);
        }
        markLine(db, line.id, { received_kind: 'none', alloc_fees_cents: step.alloc_fees_cents, received_at: receivedAt });
        result.push({ ...step, submission_ids: ids });
        continue;
      }

      if (step.action === 'new_lot') {
        // One row per cost bucket, sharing a po_line_id. Two rows is what "exact to the cent" costs
        // when the lump does not divide: anything reading a lot must group on po_line_id, not on
        // received_item_id, which names only the first row.
        const made = [];
        for (const b of step.buckets) {
          made.push(receiveInventory(db, {
            item: { game: line.game, name: line.name, set_name: line.set_name, language: line.language,
              condition: line.condition, notes: 'Unsorted lot · ' + order.ref },
            quantity: b.qty, location: step.location, bulk: true,
            costCents: b.unit_cents, acqFeesCents: 0,
            acquiredAt: receivedAt, sourceVendor: order.supplier, poLineId: line.id,
          }));
        }
        markLine(db, line.id, {
          received_kind: 'inventory', received_item_id: made[0].id, received_sku: made[0].sku,
          alloc_fees_cents: step.alloc_fees_cents, received_at: receivedAt,
        });
        result.push({ ...step, items: made });
        continue;
      }

      const isSealed = step.kind === 'sealed';
      const out = isSealed
        ? receiveSealed(db, {
          itemId: step.target_id,
          item: { game: line.game, product_type: line.product_type, name: line.name, set_name: line.set_name,
            language: line.language, upc: line.upc, condition: line.condition, status: 'in_stock' },
          placements: step.placements,
          costCents: step.cost_cents, acqFeesCents: step.acq_fees_cents,
          acquiredAt: receivedAt, sourceVendor: order.supplier, poLineId: line.id,
        })
        : receiveInventory(db, {
          itemId: step.target_id,
          item: { game: line.game, name: line.name, set_name: line.set_name, number: line.number,
            variant: line.variant, identity_key: line.identity_key, language: line.language,
            condition: line.condition, status: 'in_stock' },
          quantity: step.qty, location: step.location,
          costCents: step.cost_cents, acqFeesCents: step.acq_fees_cents,
          acquiredAt: receivedAt, sourceVendor: order.supplier, poLineId: line.id,
        });

      markLine(db, line.id, {
        received_kind: isSealed ? 'sealed' : 'inventory',
        received_item_id: out.id, received_sku: out.sku,
        alloc_fees_cents: step.alloc_fees_cents, received_at: receivedAt,
      });
      // step.blend_before was read off the target row in buildPlan, before this merge wrote over it —
      // that is what makes a weighted average reversible by hand.
      result.push({ ...step, item_id: out.id, sku: out.sku, created: out.created, quantity_after: out.quantity });
    }

    db.prepare(`UPDATE purchase_receipts SET result = ?, line_count = ?, unit_count = ? WHERE id = ?`)
      .run(JSON.stringify(result),
        result.filter((r) => r.action !== 'skip').length,
        result.reduce((s, r) => s + (r.action === 'skip' ? 0 : (r.qty || 0)), 0),
        receiptId);
    patchRow(db, 'purchase_orders', order.id, { status: 'received', received_at: receivedAt });
    db.exec('COMMIT');
    return { receipt_id: receiptId, result };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function markLine(db, lineId, fields) {
  patchRow(db, 'purchase_lines', lineId, fields);
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
        // create_statuses is separate from transitions on purpose: creating an order is not a move
        // from anywhere, and building the new-order dropdown out of TRANSITIONS offered 'cancelled',
        // which POST /orders then refused.
        return send(res, 200, {
          statuses: STATUSES, transitions: TRANSITIONS,
          create_statuses: CREATE_STATUSES, line_kinds: LINE_KINDS, held_statuses: HELD_STATUSES,
        });
      }

      // GET /discrepancy-codes — why a count did not match.
      if (p === '/discrepancy-codes' && method === 'GET') {
        return send(res, 200, { codes: DISCREPANCY_CODES });
      }

      // GET /submissions — grading submissions that have not come back yet, for the grading-line
      // picker. Without this the page could offer a 'grading' line kind but had no way to say WHICH
      // cards it was for, so the gate refused every one of them with no remedy on screen.
      if (p === '/submissions' && method === 'GET') {
        // Searchable, because this endpoint is the ONLY way the page can set submission_ids and a
        // grading line with none blocks the whole delivery — a flat cap with no filter meant the card
        // you needed could simply be unreachable. COALESCE on the sort key because a draft has no
        // submitted_at and SQLite sorts NULLs last, burying exactly the rows being staged.
        const text = trimOrNull(q.get('q'));
        const args = [];
        let where = `WHERE status IN ('draft','submitted','received') AND promoted_item_id IS NULL`;
        if (text) {
          where += ` AND name LIKE ? ESCAPE '\\'`;
          args.push('%' + likeEscape(text) + '%');
        }
        const rows = db.prepare(`SELECT id, name, set_name, number, grading_company, tier, status,
            submitted_at, grading_cost_cents
          FROM grading_submissions ${where}
          ORDER BY COALESCE(submitted_at, created_at) DESC, id DESC LIMIT 200`).all(...args);
        const total = db.prepare(`SELECT COUNT(*) n FROM grading_submissions ${where}`).get(...args).n;
        return send(res, 200, { submissions: rows, total });
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
        // node:sqlite throws "datatype mismatch" on anything bound to LIMIT ? that is not an integer
        // — NaN AND 1.5 alike — so this has to floor, not merely check finiteness. It also has to
        // treat an ABSENT or blank param as "use the default": `+null` is 0, which quietly turned a
        // missing limit into one row per page.
        const num = (v, dflt) => {
          if (v == null || String(v).trim() === '') return dflt;
          const n = Math.floor(+v);
          return Number.isFinite(n) ? n : dflt;
        };
        const limit = Math.min(200, Math.max(1, num(q.get('limit'), 50)));
        const offset = Math.max(0, num(q.get('offset'), 0));

        const where = [];
        const args = [];
        if (status !== 'all') { where.push('status = ?'); args.push(status); }
        if (game) { where.push('game = ?'); args.push(game); }
        // % and _ are LIKE wildcards. A product name containing either (a "50%" promo, a set code with
        // an underscore) would otherwise silently widen the search instead of narrowing it.
        if (set) { where.push(`set_name LIKE ? ESCAPE '\\'`); args.push('%' + likeEscape(set) + '%'); }
        if (text) {
          where.push(`(name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')`);
          args.push('%' + likeEscape(text) + '%', likeEscape(text.toUpperCase()) + '%');
        }
        const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

        // The ordering and the paging both belong in SQL. This used to read BOTH stock tables whole,
        // map over every row and sort the lot in JS before slicing 40 — on every keystroke of the
        // picker, which is exactly the cost this route exists to avoid. An exact SKU match still
        // sorts first, so typing a known label does not make you scroll.
        const rank = text ? `CASE WHEN sku = ? THEN 0 ELSE 1 END` : `0`;
        const rankArg = text ? [text.toUpperCase()] : [];
        // Over-fetch by the offset so the two tables can still be interleaved correctly after the
        // union, then slice once. Bounded by limit+offset rather than by the size of the table.
        const cap = limit + offset;

        const out = [];
        let total = 0;
        if (kind !== 'inventory') {
          const sw = clause + (ptype ? (clause ? ' AND ' : 'WHERE ') + 'product_type = ?' : '');
          const sargs = ptype ? [...args, ptype] : args;
          out.push(...db.prepare(`SELECT 'sealed' AS kind, id, sku, name, set_name, game, product_type, language,
              condition, upc, NULL AS identity_key, NULL AS grading_company, NULL AS grade,
              quantity, location, status, cost_cents, acq_fees_cents, image_url, ${rank} AS rank
            FROM sealed_items ${sw} ORDER BY rank, name COLLATE NOCASE LIMIT ?`).all(...rankArg, ...sargs, cap));
          total += db.prepare(`SELECT COUNT(*) n FROM sealed_items ${sw}`).get(...sargs).n;
        }
        // product_type is a sealed-only facet; asking for one excludes singles/slabs by definition
        // rather than returning them unfiltered, which would read as "the filter did nothing".
        if (kind !== 'sealed' && !ptype) {
          out.push(...db.prepare(`SELECT 'inventory' AS kind, id, sku, name, set_name, game, NULL AS product_type, language,
              condition, NULL AS upc, identity_key, grading_company, grade,
              quantity, location, status, cost_cents, acq_fees_cents, image_url, ${rank} AS rank
            FROM inventory_items ${clause} ORDER BY rank, name COLLATE NOCASE LIMIT ?`).all(...rankArg, ...args, cap));
          total += db.prepare(`SELECT COUNT(*) n FROM inventory_items ${clause}`).get(...args).n;
        }
        for (const r of out) r.landed_unit_cents = (r.cost_cents || 0) + (r.acq_fees_cents || 0);
        out.sort((a, b) => a.rank - b.rank || naturalCompare(a.name, b.name));
        // A real match count, not out.length — `out` is now capped by the per-table LIMIT, so
        // reporting its length would make `total` equal the fetch size whenever there ARE more
        // matches, and no caller could ever tell there was a next page.
        return send(res, 200, { items: out.slice(offset, offset + limit), total, limit, offset });
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
        // != null, not !== undefined: an explicit null is the normal shape from a client spreading a
        // partial form, and the line below already reads it as "draft".
        if (b.status != null && b.status !== '' && !CREATE_STATUSES.includes(b.status)) {
          return send(res, 400, { error: 'bad_create_status', status: b.status, allowed: CREATE_STATUSES,
            detail: 'an order is created on its way to being placed, not at the end of its life' });
        }
        obj.status = b.status || 'draft';
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
        // != null for the same reason POST /orders uses it: an explicit null is a client spreading a
        // partial form, and it means "leave the status alone", not "set it to nothing".
        if (b.status != null && b.status !== '') {
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
        if (line.received_item_id != null) {
          return send(res, 409, { error: 'line_received', detail: 'this line already produced stock' });
        }
        const b = await readJson(req);
        const obj = pick(b, LINE_COLS);
        for (const c of ['unit_cost_cents', 'lot_total_cents']) if (obj[c] !== undefined) obj[c] = asCents(obj[c]);
        // Same normalisation addLine applies, so the column only ever holds the shape
        // parseSubmissionIds expects — a PATCH used to write the raw body through untouched.
        if (obj.submission_ids !== undefined) {
          const ids = parseSubmissionIds(obj.submission_ids);
          obj.submission_ids = ids.length ? JSON.stringify(ids) : null;
        }
        if (obj.qty_ordered !== undefined) obj.qty_ordered = Math.max(1, Math.round(+obj.qty_ordered || 1));
        if (b.link !== undefined) Object.assign(obj, linkFields(db, b.link));
        patchRow(db, 'purchase_lines', lineId, obj);
        return send(res, 200, { updated: true });
      }

      // DELETE /lines/:id
      if ((m = p.match(/^\/lines\/(\d+)$/)) && method === 'DELETE') {
        const lineId = +m[1];
        const line = db.prepare(`SELECT received_item_id FROM purchase_lines WHERE id = ?`).get(lineId);
        if (!line) return send(res, 404, { error: 'no_such_line' });
        if (line.received_item_id != null) {
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
          // A payment we cannot express in AUD is REFUSED, not silently counted as zero. The figure
          // derived here becomes settled_fx_to_aud, which becomes the permanent cost basis on every
          // stock row this order produces — so a payment quietly worth 0 lands the whole order at a
          // fraction of what it cost, with nothing on screen to say so.
          const missing = payments.filter((p) => String(p.currency).toUpperCase() !== 'AUD' && p.aud_cents == null);
          if (missing.length) {
            return send(res, 409, {
              error: 'payments_not_in_aud',
              payment_ids: missing.map((p) => p.id),
              detail: 'these payments have no AUD figure, so the total would be understated — add one, or enter the settled amount directly',
            });
          }
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

      // POST /lines/:id/count — the count check. This is where a delivery meets its paperwork, and
      // where the storage spot is chosen: named spots (splittable for sealed), else the order default.
      if ((m = p.match(/^\/lines\/(\d+)\/count$/)) && method === 'POST') {
        const lineId = +m[1];
        const line = db.prepare(`SELECT * FROM purchase_lines WHERE id = ?`).get(lineId);
        if (!line) return send(res, 404, { error: 'no_such_line' });
        if (line.received_item_id != null) {
          return send(res, 409, { error: 'line_received' });
        }
        const b = await readJson(req);
        const qty = b.qty_received == null ? null : Math.max(0, Math.round(+b.qty_received));
        const code = trimOrNull(b.discrepancy);
        if (code && !DISCREPANCY_CODES.some((c) => c.code === code)) {
          return send(res, 400, { error: 'unknown_discrepancy', code, known: DISCREPANCY_CODES.map((c) => c.code) });
        }
        const fields = {
          qty_received: qty,
          discrepancy: code,
          discrepancy_note: trimOrNull(b.discrepancy_note),
        };
        if (b.lot_units !== undefined) {
          // Capped, because splitEvenly allocates an array of this size — inside the DRY preview,
          // which is supposed to be cheap and write nothing. sanitizePlacements caps quantities for
          // the same reason; a fat-fingered extra zero should be a 400, not an out-of-memory.
          const n = b.lot_units == null ? null : Math.max(0, Math.round(+b.lot_units));
          if (n != null && n > MAX_LOT_UNITS) {
            return send(res, 400, { error: 'lot_units_too_large', lot_units: n, max: MAX_LOT_UNITS });
          }
          fields.lot_units = n;
        }

        // EVERYTHING is validated before ANYTHING is written, and the two writes share a
        // transaction. This used to patch the count first and check the split second, so a split
        // that did not add up returned 409 with the count already committed and the old placements
        // still attached — while the page, seeing an error, told the operator nothing had saved.
        const rows = Array.isArray(b.placements) ? sanitizePlacements(b.placements) : null;
        if (rows) {
          const placed = rows.reduce((s, r) => s + r.quantity, 0);
          if (qty != null && placed > 0 && placed !== qty) {
            return send(res, 409, { error: 'placements_mismatch', counted: qty, placed });
          }
        }
        db.exec('BEGIN');
        try {
          patchRow(db, 'purchase_lines', lineId, fields);
          if (rows) {
            db.prepare(`DELETE FROM purchase_line_placements WHERE line_id = ?`).run(lineId);
            for (const r of rows) {
              insertRow(db, 'purchase_line_placements', { line_id: lineId, location: r.location, quantity: r.quantity });
            }
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        const after = db.prepare(`SELECT * FROM purchase_lines WHERE id = ?`).get(lineId);
        return send(res, 200, { counted: true, line: { ...after, placements: placementsFor(db, lineId) } });
      }

      // POST /orders/:id/receive[?dry=1] — the plan, then the same plan applied.
      //
      // ?dry=1 writes NOTHING and is what the receive screen renders: which SKUs get +N, which are
      // new, what each unit ends up having cost, and every reason the order is not ready. The commit
      // rebuilds the plan from the same rows and applies it, so approval and outcome cannot diverge.
      if ((m = p.match(/^\/orders\/(\d+)\/receive$/)) && method === 'POST') {
        const id = +m[1];
        const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
        if (!order) return send(res, 404, { error: 'no_such_order' });
        const b = await readJson(req);
        const dry = q.get('dry') === '1' || b.dry === true;

        const prior = db.prepare(`SELECT * FROM purchase_receipts WHERE order_id = ?`).get(id);
        if (prior && !dry) {
          // Already done. Idempotent by design, mirroring promote's promoted_item_id check — a
          // retried request must not add the delivery to stock a second time.
          return send(res, 200, { already: true, receipt_id: prior.id, result: JSON.parse(prior.result || '[]') });
        }
        if (order.status === 'cancelled') return send(res, 409, { error: 'order_cancelled' });
        if (!dry && !['ordered', 'in_transit', 'arrived'].includes(order.status)) {
          return send(res, 409, { error: 'not_receivable', status: order.status });
        }

        const lines = linesFor(db, id).map((l) => ({ ...l, placements: placementsFor(db, l.id) }));
        if (!lines.length) return send(res, 409, { error: 'no_lines' });
        const plan = buildPlan(db, order, lines, { basis: b.basis, default_location: b.default_location });

        if (dry) return send(res, 200, plan);
        if (plan.blockers.length) return send(res, 409, { error: 'lines_unreconciled', blockers: plan.blockers });

        const receivedAt = b.received_at || new Date().toISOString().slice(0, 10);
        const out = commitReceive(db, order, lines, plan, receivedAt);
        return send(res, 201, { ...out, plan });
      }

      // GET /orders/:id/receipt — what the receive actually did.
      if ((m = p.match(/^\/orders\/(\d+)\/receipt$/)) && method === 'GET') {
        const r = db.prepare(`SELECT * FROM purchase_receipts WHERE order_id = ?`).get(+m[1]);
        if (!r) return send(res, 404, { error: 'not_received' });
        return send(res, 200, { receipt: r, result: JSON.parse(r.result || '[]'), preview: JSON.parse(r.preview || '[]') });
      }

      // POST /orders/:id/close — the order is done with. Refuses while money is still owed unless the
      // owner says so explicitly: closing an order you are still paying off is legitimate, but it
      // should take a deliberate flag rather than happening by accident.
      if ((m = p.match(/^\/orders\/(\d+)\/close$/)) && method === 'POST') {
        const id = +m[1];
        const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
        if (!order) return send(res, 404, { error: 'no_such_order' });
        const b = await readJson(req);
        if (!db.prepare(`SELECT 1 FROM purchase_receipts WHERE order_id = ?`).get(id)) {
          return send(res, 409, { error: 'not_received' });
        }
        const totals = orderTotals(db, order, linesFor(db, id), paymentsFor(db, id));
        if (totals.balance_cents > 0 && !b.force_close_unpaid) {
          return send(res, 409, { error: 'unpaid', balance_cents: totals.balance_cents, currency: totals.currency });
        }
        patchRow(db, 'purchase_orders', id, { status: 'closed', closed_at: new Date().toISOString() });
        return send(res, 200, { closed: true });
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
  // Normalised to a JSON array on the way in, so the column only ever holds the one shape
  // parseSubmissionIds expects.
  if (raw.submission_ids !== undefined) {
    const ids = parseSubmissionIds(raw.submission_ids);
    obj.submission_ids = ids.length ? JSON.stringify(ids) : null;
  }
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
