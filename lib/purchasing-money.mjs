// lib/purchasing-money.mjs — the money maths behind receiving a purchase order.
//
// Pure: no DOM, no fetch, no DB, no deps (the lib/fees.mjs shape). Everything here is integer cents
// (Golden Rule 3) and everything here works in the ORDER's currency — conversion to AUD happens once,
// at the very end, in lib/purchasing.mjs, because the stock tables store AUD and nothing else does.
//
// Two problems this module exists to solve, both of them "the cents must not vanish":
//
//   1. An order carries freight, tax and fees at the HEADER. Those have to land on the individual
//      units, or a box on a shelf claims to have cost less than it did. Spread naively with integer
//      division and the pieces do not add back up to what was paid.
//   2. A bulk lot is one lump price over N items. The owner's rule is that the split "must sum to the
//      lot total to the cent".
//
// Both are the apportionment problem, and both use the same largest-remainder (Hamilton) method.

// ---- the exact-cents primitive ---------------------------------------------------------------
//
// Spread `pot` across weights so the parts sum to `pot` EXACTLY, for every input.
//
// floor() first (not trunc — floor is also correct for a negative pot, which a discount bigger than
// the freight genuinely produces), then hand the leftover cents out one at a time to whoever was
// robbed hardest by the rounding. The shortfall is always 0 <= short < weights.length, so the loop is
// bounded by the number of lines and every cent is placed.
//
// Ties break on remainder, then weight, then the caller's original order, so the same input always
// produces the same answer — a preview the owner approved must commit identically.
export function apportion(pot, weights) {
  const n = weights.length;
  if (!n) return [];
  const total = weights.reduce((a, b) => a + b, 0);
  // Nothing to weight by (all zeros, or a single free line): fall back to an equal split, which is
  // the only defensible reading of "spread this over these" when the weights say nothing.
  const w = total === 0 ? weights.map(() => 1) : weights;
  const W = total === 0 ? n : total;
  const out = [];
  const rems = [];
  let given = 0;
  for (let i = 0; i < n; i++) {
    const num = pot * w[i];
    const q = Math.floor(num / W);
    out.push(q);
    given += q;
    rems.push({ i, rem: num - q * W, w: w[i] });
  }
  const short = pot - given;                                  // 0 <= short < n, always
  rems.sort((a, b) => b.rem - a.rem || b.w - a.w || a.i - b.i);
  for (let k = 0; k < short; k++) out[rems[k].i] += 1;
  return out;
}

// Split one amount evenly across n items, exactly. Returns the per-item amounts, biggest first, so
// `extra` items get one cent more than the rest — 1000c over 7 is 143,143,143,143,143,143,142.
export function splitEvenly(total, n) {
  if (!(n > 0)) return [];
  return apportion(total, new Array(n).fill(1));
}

// ---- what an order is worth -------------------------------------------------------------------

// A line's extended value in the order's currency. A 'lot' line's price is the lump, not a unit rate,
// so quantity must not multiply it.
export function lineValueCents(line, qty) {
  if (!line) return 0;
  if (line.line_kind === 'lot') return line.lot_total_cents || 0;
  const n = qty == null ? (line.qty_ordered || 0) : qty;
  return (line.unit_cost_cents || 0) * n;
}

// The pot that gets spread over the goods. A discount is stored POSITIVE and subtracted, so this can
// legitimately come out negative — a supplier discount that exceeds the freight is a real thing, and
// the allocator handles it rather than clamping and quietly losing the difference.
export function chargesPotCents(order) {
  if (!order) return 0;
  return (order.shipping_cents || 0) + (order.tax_cents || 0)
       + (order.other_fees_cents || 0) - (order.discount_cents || 0);
}

// Everything the supplier is owed, in the order's currency.
export function orderTotalCents(order, lines) {
  const goods = (lines || []).reduce((s, l) => s + lineValueCents(l), 0);
  return goods + chargesPotCents(order);
}

// ---- allocating the header charges onto the lines ---------------------------------------------
//
// BY VALUE, not by unit count. These orders are wildly heterogeneous — six booster boxes and four
// hundred raw singles arrive in one carton — and spreading freight by quantity would put almost all
// of it on the singles, inventing a 60c landed cost on a 20c common while understating the boxes.
// Value-weighting also keeps the fee proportional to what is at risk, which is what the repricer's
// cost floor downstream actually wants. 'qty' stays available for the pathological case (something
// heavy and cheap), and which basis ran is recorded on the receipt so it is never a mystery later.
//
// `lines` are the RECEIVED lines only, each {id, line_kind, unit_cost_cents, lot_total_cents, qty}.
// Returns a Map of line id -> cents, summing to the pot exactly.
export function allocateCharges(pot, lines, basis = 'value') {
  const list = lines || [];
  if (!list.length) return new Map();
  const weights = list.map((l) => (basis === 'qty'
    ? Math.max(0, l.qty || 0)
    : Math.max(0, lineValueCents(l, l.qty))));
  const parts = apportion(pot, weights);
  return new Map(list.map((l, i) => [l.id, parts[i]]));
}

// A line's allocated pot expressed per unit, for the single acq_fees_cents column a stock row has.
//
// ceil, not round: the column cannot express "3 units at 34c and 2 at 33c", so the choice is which
// way to be wrong by at most (qty - 1) cents. Rounding UP overstates cost, which understates profit —
// the safe direction for someone setting price floors off this number. The exact figure is kept on
// purchase_lines.alloc_fees_cents, so nothing is lost, and the receive preview shows the residue
// rather than hiding it.
export function perUnitFeesCents(allocCents, qty) {
  if (!(qty > 0)) return 0;
  return Math.ceil((allocCents || 0) / qty);
}

// ---- cost basis when a restock merges ----------------------------------------------------------
//
// Moving weighted average, and it is the only option that keeps `cost_cents * quantity` a true
// statement about the pile — which is exactly what summarizeSealed and summarizeInventory assume.
// Keeping the original price would make the portfolio roll-up wrong by (price difference x new qty)
// on the very next page load. FIFO would need per-unit lot records; a single cost_cents column cannot
// express them, and that ledger is not what was asked for.
//
// Applied separately to cost_cents and acq_fees_cents, because the whole point of the pair is to keep
// the raw price and the landed uplift distinguishable; averaging their sum would collapse it.
//
// A null is not a zero. An unknown old cost adopts the new figure outright (there is nothing to
// average, and averaging against 0 would halve a known number using an unknown one); an unknown new
// cost leaves the old one alone.
export function blendUnitCents(oldCents, oldQty, newCents, newQty) {
  if (newCents == null) return oldCents != null ? oldCents : null;
  if (oldCents == null || !(oldQty > 0)) return Math.round(newCents);
  const total = oldQty + newQty;
  if (!(total > 0)) return Math.round(newCents);
  return Math.round((oldCents * oldQty + newCents * newQty) / total);
}

// ---- FX ----------------------------------------------------------------------------------------

// The rate a given order's money should be read at: the settled rate once the bank figure is known,
// the live estimate until then. ONE function, so nothing anywhere has to remember the precedence.
export function effectiveFx(order) {
  if (!order) return null;
  if (order.settled_fx_to_aud != null) return order.settled_fx_to_aud;
  if (order.fx_to_aud != null) return order.fx_to_aud;
  return null;
}

// True while the AUD figures for this order are still a live-rate estimate rather than what was paid.
// The page must label these (GR4) — an estimate presented as a settled cost is exactly the kind of
// confident wrong number the golden rules exist to stop.
export function isFxEstimated(order) {
  return !!order && order.settled_fx_to_aud == null && String(order.currency || 'AUD').toUpperCase() !== 'AUD';
}

// Convert to AUD cents. Returns null rather than guessing when the rate is missing — a silently wrong
// AUD number is the one outcome GR3 forbids outright, so callers must handle the null (receiving
// refuses; the page shows the native amount flagged approximate).
export function toAudCents(cents, currency, fx) {
  if (cents == null) return null;
  if (String(currency || 'AUD').toUpperCase() === 'AUD') return Math.round(cents);
  if (fx == null) return null;
  return Math.round(cents * fx);
}

// The rate a settled figure implies. Stored on the order rather than derived on read: the order total
// stays editable afterwards, and a derived rate would silently rewrite a cost basis already sitting
// on stock rows.
export function impliedFx(settledAudCents, orderTotalNativeCents) {
  if (settledAudCents == null || !(orderTotalNativeCents > 0)) return null;
  return settledAudCents / orderTotalNativeCents;
}

// ---- payments ----------------------------------------------------------------------------------

// What has been paid, in the ORDER's currency. A payment carries its own currency (a USD invoice
// settled off an AUD card is this seller's normal case) plus the rate to the order's, captured when
// it was recorded. A payment we cannot convert is counted as 0 and reported separately rather than
// guessed at — same rule as everywhere else.
export function paidCents(order, payments) {
  const cur = String((order && order.currency) || 'AUD').toUpperCase();
  let paid = 0;
  const unconvertible = [];
  for (const p of payments || []) {
    const pc = String(p.currency || 'AUD').toUpperCase();
    if (pc === cur) { paid += p.amount_cents || 0; continue; }
    if (p.fx_to_order != null) { paid += Math.round((p.amount_cents || 0) * p.fx_to_order); continue; }
    unconvertible.push(p.id);
  }
  return { paid, unconvertible };
}

// Derived, never stored. A paid/unpaid column would be a second source of truth and it drifts the
// first time a payment is edited or deleted.
//
// An overpayment still reads 'paid' rather than inventing a fourth state — the flag says so for
// anyone who needs it, but the shelf question ("do I still owe for this?") has three answers.
export function paymentStatus(totalCents, paid) {
  if (!(totalCents > 0)) return { status: paid > 0 ? 'paid' : 'unpaid', balance: -paid, overpaid: paid > 0 };
  if (paid <= 0) return { status: 'unpaid', balance: totalCents, overpaid: false };
  if (paid >= totalCents) return { status: 'paid', balance: totalCents - paid, overpaid: paid > totalCents };
  return { status: 'partial', balance: totalCents - paid, overpaid: false };
}
