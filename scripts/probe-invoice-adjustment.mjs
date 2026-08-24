// scripts/probe-invoice-adjustment.mjs — does Trading SendInvoice's AdjustmentAmount actually reduce
// an order total, or is it capped at the postage like Seller Hub's form is?
//
// WHY THIS EXISTS. The owner tried to take AU$6.90 off AU$61.90 of cards on Seller Hub's "Send invoice"
// screen and could not submit the form: with $0.00 postage it said "Discounts cannot be applied to
// orders with free postage", and with $1.70 postage it said "Please enter a discount less than AU $1.70
// (postage + sales tax)". That proves the UI caps the adjustment at the postage amount. It does NOT
// prove the API does — eBay's own docs describe no bound on the field, and a UI being stricter than its
// API is common. The whole invoice-discount feature lives or dies on this one answer, and reasoning from
// what eBay's docs do not say has already killed two designs in this project.
//
// It deliberately calls the SHIPPED builder (buildSendInvoiceInner), not hand-rolled XML, so a pass here
// is a pass for the code that would actually go live.
//
// Run on ALCSERVER, where the user token is:
//   node --disable-warning=ExperimentalWarning scripts/probe-invoice-adjustment.mjs --order=NN-NNNNN-NNNNN
//   …prints the order, the XML it WOULD send, and stops. Nothing is sent without --live.
//
//   node --disable-warning=ExperimentalWarning scripts/probe-invoice-adjustment.mjs --order=… --rung=1 --live
//   node --disable-warning=ExperimentalWarning scripts/probe-invoice-adjustment.mjs --order=… --rung=2 --live
//
// RUN RUNG 1 FIRST. It sends $1.00, which is INSIDE the UI's cap, and it is the control: if even a
// within-cap adjustment vanishes, the field is inert on the OrderID path entirely and rung 2 would tell
// you nothing. Rung 2 sends $6.90, outside the cap, and is the actual question.
//
// CONFIRMED (2026-08-24, live, twice): the API is uncapped. $1 and $3 adjustments both applied in full
// on real orders. See memory ebay-sendinvoice-uncapped for the write-up.
//
// SHIPPING OVERRIDE — pass --ship-service=CODE --ship-cost=DOLLARS (together, or not at all) to
// OVERRIDE postage to something OTHER than what eBay already computed for the order, instead of the
// default of echoing it back unchanged. This is the real question for a multi-item invoice: does eBay
// accept a seller-chosen combined-postage figure, not just tolerate an echo of its own number.
//   node --disable-warning=ExperimentalWarning scripts/probe-invoice-adjustment.mjs --order=… \
//     --adjust=3.00 --ship-service=AU_Regular --ship-cost=8.26 --live
//
// CODE MUST BE TRADING-VOCABULARY, NOT THE REST BAND TABLE'S. lib/shipping-bands.mjs's
// 'AU_AusPostPriorityLetterWithTracking' ($8.26 tracked letter) is the REST/Sell-Account name for the
// SAME service Trading calls 'AU_Regular' — echoing an already-on-the-order code sidesteps this, but
// choosing a NEW tier does not. Guessing a REST-vocabulary code here risks error 20197. See the
// AddOrder section of lib/ebay-trading.mjs for the fuller account of this trap.
//
// --combine=<itemId1>-<transId1>,<itemId2>-<transId2>[,...] — for TWO OR MORE separate unpaid
// transactions (confirmed live: adding items to cart together does NOT auto-merge them into one
// order). Calls AddOrder to merge them into a real Combined Invoice order first, THEN chains straight
// into the SendInvoice flow above using the new OrderID — --ship-service/--ship-cost become REQUIRED
// (there is no single existing order to echo postage from), and --adjust is checked against the
// MERGED total, so a discount past what any single order's postage would have capped is exactly what
// this tests:
//   node --disable-warning=ExperimentalWarning scripts/probe-invoice-adjustment.mjs \
//     --combine=168633660463-10087339797818,168615215862-10084290487219 \
//     --ship-service=AU_Regular --ship-cost=5.00 --adjust=12.96 --live
// AddOrder has never been called from this repo before — see its header comment in
// lib/ebay-trading.mjs for what is (WSDL-confirmed) and is not (best-effort guess) verified about it.
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import {
  getOrders, sendInvoice, buildSendInvoiceInner, addOrder, buildAddOrderInner, xmlField, xmlMoneyCents,
} from '../lib/ebay-trading.mjs';
import { oauthStatus } from '../lib/ebay-oauth.mjs';
// cancelState is the CANONICAL reader for eBay's CancelStatus, and using it rather than the raw field
// is the whole point: eBay returns <CancelStatus>NotApplicable</CancelStatus> on a perfectly ordinary
// order, so a truthiness test on the raw value marks every healthy order as cancelled.
import { cancelState } from '../lib/postsale.mjs';

// The secrets live in .env and are read by Vite, never exported into the shell — so process.env is
// empty for a standalone script and oauthStatus would report "not connected" on the very machine that
// holds the token. Same loadEnv the dev server and scripts/check-ebay-aspects.mjs use.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv('development', ROOT, ''), ...process.env };
const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : (process.argv.includes('--' + k) ? true : d);
};
const money = (c) => (c == null ? '—' : 'A$' + (c / 100).toFixed(2));
const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(74));
// Moved up from beside the single-order guards below so --combine (which runs before those guards
// even exist) can refuse through the same path instead of a second, inconsistent error style.
const refuse = (why) => { console.error('\nREFUSED: ' + why); process.exit(1); };

// Rung 1 is the control and rung 2 is the question. See the header.
const RUNGS = { 1: 100, 2: 690 };

// eBay has TWO OrderID shapes and Seller Hub shows neither of them plainly. A COMBINED (multi-line)
// order is the numeric NN-NNNNN-NNNNN form; a SINGLE-line order's id is the legacy pair
// "ItemID-TransactionID". The Seller Hub URL exposes itemid= and transId= separately, so a bare
// transaction id pasted from there looks like an order id and is not one — GetOrders simply returns
// nothing, with no hint as to why. Accept every form and assemble it.
const rawOrder = arg('order');
const itemArg = arg('item');
const transArg = arg('trans');
let orderId = rawOrder;
if (!orderId && itemArg && transArg) orderId = `${itemArg}-${transArg}`;
// A pasted Seller Hub URL: pull itemid + transId straight out of it.
if (orderId && /[?&#]/.test(orderId)) {
  const it = orderId.match(/itemid=(\d+)/i), tr = orderId.match(/transid=(\d+)/i);
  if (it && tr) orderId = `${it[1]}-${tr[1]}`;
}
const rung = arg('rung');
const live = arg('live') === true;
// A blunt guard against a fat-fingered order id landing on a real sale. The probe order is meant to be
// two ~$9.99 listings; anything dearer than this is almost certainly not it.
const maxTotalCents = Math.round(parseFloat(arg('max-total', '50')) * 100);
const discountCents = arg('adjust') ? Math.round(parseFloat(arg('adjust')) * 100) : RUNGS[rung];

// Default behaviour (no flags) ECHOES the order's own current shipping service/cost back unchanged —
// that's what isolates the discount-only question the first two live runs answered. The combined-order
// question is different: does SendInvoice actually let the SELLER override postage to something other
// than what eBay already computed for the cart, which is the entire mechanism the real feature depends
// on for "one lot of postage, sized to our own band, not eBay's per-line total." Pass both flags to
// test that; passing only one is refused below, since a half override is not a real test of either.
const shipServiceOverride = arg('ship-service');
const shipCostOverride = arg('ship-cost') != null ? Math.round(parseFloat(arg('ship-cost')) * 100) : null;

// Seller Hub's order panel shows a SALES RECORD NO. and no order id at all, so that number is the
// only identifier a human can actually read off the screen. Look up by it.
const salesRecord = arg('sales-record') || arg('sr');

// GetOrders returns ONE page and reports hasMore; the caller must walk it. Reading page 1 and stopping
// is how "100 order(s) · 0 UNPAID" gets printed for an account with three orders awaiting payment —
// exactly 100 is the page size, which is the tell. The cap is a runaway guard, and a truncated read
// says so out loud rather than quietly answering from a slice.
async function fetchOrders({ orderStatus = null, days = 30, maxPages = 25 } = {}) {
  // A WEEK of headroom on the upper bound. eBay stamps orders in the seller's timezone and this window
  // is built from the local clock, so any skew between the two silently truncates the newest orders —
  // the ones a probe is looking for. Cheap to be generous; a too-narrow window is indistinguishable
  // from an order that does not exist.
  const to = new Date(Date.now() + 7 * 86400000).toISOString();
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await getOrders(env, { createTimeFrom: from, createTimeTo: to, orderStatus, page, entriesPerPage: 100 });
    if (!res.ok) return { ok: false, errors: res.errors, ack: res.ack };
    out.push(...(res.orders || []));
    if (!res.hasMore) return { ok: true, orders: out, pages: page, truncated: false };
  }
  return { ok: true, orders: out, pages: maxPages, truncated: true };
}

if (arg('list') || salesRecord) {
  const days = Math.max(1, parseInt(arg('days', '30'), 10));

  // Ask eBay for awaiting-payment orders directly rather than pulling everything and filtering.
  // 'Active' is Trading's word for unpaid. Fall back to a full scan if that returns nothing, so a
  // wrong status name cannot masquerade as "you have no unpaid orders".
  let via = 'OrderStatus=Active';
  let res = await fetchOrders({ orderStatus: 'Active', days });
  if (res.ok && !(res.orders || []).length) {
    via = 'full scan';
    res = await fetchOrders({ days });
  }
  if (!res.ok) { console.error('GetOrders failed:', JSON.stringify(res.errors || res.ack)); process.exit(1); }
  const all = res.orders || [];
  line(`read ${all.length} order(s) over ${res.pages} page(s) via ${via}, window ${days}d`
    + (res.truncated ? '  ⚠ TRUNCATED at the page cap — widen nothing, this is a bug' : ''));
  line('');

  if (salesRecord) {
    const hit = all.find((o) => String(o.salesRecordNumber) === String(salesRecord));
    if (!hit) {
      console.error(`No order with sales record no. ${salesRecord} among the ${all.length} read `
        + `(${res.pages} page(s), ${days}d window, via ${via}).`);
      console.error('Widen it with --days=90, or run --list to see what is there.');
      process.exit(1);
    }
    line(`sales record ${salesRecord} → order ${hit.orderId}`);
    line(`  ${money(hit.totalCents)}  ${(hit.items || []).length} line(s)  @${hit.buyerUsername || '?'}  `
      + `${hit.paidTime ? 'PAID ' + hit.paidTime : 'UNPAID'}`);
    line('');
    line(hit.paidTime
      ? 'PAID, so it cannot be probed — SendInvoice needs an unpaid order.'
      : `Probe it with:  --order=${hit.orderId}`);
    process.exit(0);
  }

  // Only a GENUINE cancellation disqualifies an order. cancelState maps NotApplicable/Invalid/
  // CustomCode to 'none' — all of which are truthy strings on the raw field, which is what previously
  // filtered away three healthy unpaid orders and reported "0 UNPAID".
  const probeable = (o) => !o.paidTime && cancelState(o) !== 'cancelled';
  const unpaid = all.filter(probeable);

  // Show the fields the decision was made on. A filter that silently disagrees with Seller Hub has
  // already cost two rounds here; its working belongs on screen.
  if (all.length && all.length <= 40) {
    line('what was read, and how each was judged:');
    for (const o of all) {
      line(`  sr ${String(o.salesRecordNumber || '?').padEnd(6)} ${String(o.orderId).padEnd(30)} `
        + `${money(o.totalCents).padStart(9)}  ${probeable(o) ? 'PROBEABLE ' : 'skipped   '}`
        + `paid=${o.paidTime || 'null'}  cancel=${o.cancelStatus || 'null'}→${cancelState(o) || 'null'}  `
        + `order=${o.orderStatus || '?'}  checkout=${o.checkoutStatus || '?'}`);
    }
    line('');
  }
  line(`${all.length} order(s) created in the last ${days} days · ${unpaid.length} UNPAID`);
  line('');
  if (!unpaid.length) {
    line(`No unpaid orders among the ${all.length} read. If Seller Hub disagrees, the window is wrong —`);
    line('try --days=90. Otherwise, to make a probe target: from a second account, cart two cheap');
    line('cards, commit to buy, and do NOT pay. Then re-run --list.');
    process.exit(0);
  }
  line('UNPAID — any of these can be probed:');
  for (const o of unpaid) {
    line(`  sr ${String(o.salesRecordNumber || '?').padEnd(6)} ${String(o.orderId).padEnd(30)} `
      + `${money(o.totalCents).padStart(9)}  ${(o.items || []).length} line(s)  @${o.buyerUsername || '?'}`);
  }
  line('');
  line('Then:  --order=<the id above>');
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// --combine — merge 2+ separate unpaid transactions (SAME buyer) into one Combined Invoice order
// via AddOrder, THEN fall through into the ordinary single-order flow below unchanged, now pointed
// at the new merged OrderID. This is the answer to "can we combine two carts AND still discount
// past the postage cap": AddOrder has never been called from this repo before, and everything past
// this block is the already-proven SendInvoice path — see the header and lib/ebay-trading.mjs's
// AddOrder section for what is and is not confirmed.
// ---------------------------------------------------------------------------------------------
const combineArg = arg('combine');
if (combineArg) {
  const combineLines = String(combineArg).split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    const m = p.match(/^(\d+)-(\d+)$/);
    if (!m) { console.error(`--combine: "${p}" is not <ItemID>-<TransactionID>. Get these from --list.`); process.exit(2); }
    return { itemId: m[1], transactionId: m[2] };
  });
  if (combineLines.length < 2) refuse('--combine needs 2+ comma-separated <ItemID>-<TransactionID> pairs.');

  const st0 = oauthStatus(env);
  if (!st0.connected) { console.error('eBay account not connected. Run on the machine that holds data/ebay-oauth.json.'); process.exit(1); }

  // AddOrder needs a Total (eBay's own docs call it an estimate, computed from subtotal + whatever
  // costs are specified here) and there is no single existing order to echo postage from — two
  // different transactions may not even carry the same service. So, unlike the single-order path,
  // the shipping override is not optional here.
  if (!shipServiceOverride || shipCostOverride == null) {
    console.error('--combine also needs --ship-service + --ship-cost. AddOrder has no order to echo');
    console.error('postage from — merging separate transactions IS the point, so there is no "unchanged"');
    console.error('figure to fall back on. Use --ship-service=AU_Regular for a ~$8.26 tracked letter —');
    console.error('the Trading-vocabulary code confirmed to exist for that tier (see lib/ebay-trading.mjs).');
    process.exit(2);
  }

  line(`MERGING ${combineLines.length} lines into one Combined Invoice order via AddOrder:`);
  let subtotalCents = 0;
  for (const l of combineLines) {
    const pseudoId = `${l.itemId}-${l.transactionId}`;
    const res = await getOrders(env, { orderIds: [pseudoId] });
    const o = res.ok && (res.orders || []).find((x) => String(x.orderId) === pseudoId);
    if (!o) { console.error(`eBay did not return order ${pseudoId} — check the ItemID-TransactionID pair.`); process.exit(1); }
    if (o.paidTime) refuse(`${pseudoId} is already PAID — cannot merge a paid line into a new order.`);
    if (cancelState(o) === 'cancelled') refuse(`${pseudoId} is cancelled.`);
    line(`  ${pseudoId}  ${money(o.subtotalCents).padStart(9)}  ${((o.items[0] || {}).title || '').slice(0, 45)}`);
    subtotalCents += (o.subtotalCents || 0);
  }
  const combineTotalCents = subtotalCents + shipCostOverride;
  line(`  subtotal ${money(subtotalCents)}  +  postage ${shipServiceOverride} ${money(shipCostOverride)}  =  `
    + `Total(estimate) ${money(combineTotalCents)}`);
  line('');

  const addOrderOpts = {
    lines: combineLines, currency: 'AUD', totalCents: combineTotalCents,
    shippingService: shipServiceOverride, shippingCostCents: shipCostOverride,
  };
  line('AddOrder XML (from the shipped buildAddOrderInner):');
  line(buildAddOrderInner(addOrderOpts).replace(/></g, '>\n  <').replace(/^/, '  '));
  line('');

  if (!live) {
    line('DRY RUN — AddOrder was not sent. Re-run with --live to actually merge these into one order');
    line('(this creates a real combined order on eBay — not obviously reversible by un-merging).');
    process.exit(0);
  }

  line('sending AddOrder…');
  const added = await addOrder(env, addOrderOpts);
  line(`  ack=${added.ack}  http=${added.httpStatus}`);
  for (const e of (added.errors || [])) line(`  eBay ${e.severity || ''} ${e.code || ''}: ${e.longMessage || e.shortMessage || ''}`);
  if (!added.ok || !added.orderId) {
    console.error('');
    console.error('AddOrder failed or returned no OrderID — cannot chain into SendInvoice.');
    console.error('If the error names a field/sequence problem rather than a business rule, the field');
    console.error('order in buildAddOrderInner (lib/ebay-trading.mjs) is an inferred best guess, not');
    console.error('WSDL-confirmed — see its header comment for what to try reordering first.');
    process.exit(1);
  }
  line(`  merged → new combined OrderID: ${added.orderId}  (created ${added.createdTime || '?'})`);
  line('');

  // The new order may not be immediately readable by ID — same write-then-read lag already proven
  // for SendInvoice. Confirm it resolves BEFORE falling through to the snapshot() below, which is
  // fatal on a miss; better a clear retry here than an unhelpful crash right after a real merge.
  let mergedVisible = null;
  const mergeWaits = [3000, 3000, 6000];
  for (let i = 0; i < mergeWaits.length && !mergedVisible; i++) {
    await new Promise((res) => setTimeout(res, mergeWaits[i]));
    const res = await getOrders(env, { orderIds: [added.orderId] });
    mergedVisible = res.ok && (res.orders || []).find((x) => String(x.orderId) === String(added.orderId));
    if (!mergedVisible && i < mergeWaits.length - 1) line(`  (waiting for the merged order to become readable, attempt ${i + 1}/${mergeWaits.length}…)`);
  }
  if (!mergedVisible) {
    console.error(`AddOrder ack'd Success but ${added.orderId} still won't read back after `
      + `${mergeWaits.reduce((a, b) => a + b, 0) / 1000}s. It likely exists — check Seller Hub directly `
      + `for order ${added.orderId} rather than assuming the merge failed.`);
    process.exit(1);
  }
  line('merged order confirmed readable — continuing into the invoice flow below.');
  rule();

  orderId = added.orderId;   // fall through into the existing single-order flow, unchanged from here.
}

if (!orderId) {
  line('Usage: --order=<order id> [--rung=1|2 | --adjust=6.90] [--live] [--max-total=50]');
  line('       --list [--days=30]           ← recent UNPAID orders, with sales record nos');
  line('       --sales-record=1165          ← look up the order id from the number Seller Hub shows');
  line('       --combine=<itemId1>-<transId1>,<itemId2>-<transId2>[,...] --ship-service=… --ship-cost=…');
  line('                                     ← merge separate unpaid transactions first (AddOrder),');
  line('                                       then chain straight into the invoice flow below');
  line('');
  line('An order id is one of two shapes, and Seller Hub shows neither plainly:');
  line('  combined (multi-line)   NN-NNNNN-NNNNN');
  line('  single line             <ItemID>-<TransactionID>');
  line('You can also pass --item= and --trans=, or paste a Seller Hub URL as --order=.');
  line('');
  line('  rung 1 = A$1.00  — INSIDE Seller Hub\'s cap. The control. Run this first.');
  line('  rung 2 = A$6.90  — OUTSIDE the cap. The actual question.');
  line('');
  line('Without --live it prints the order and the XML and sends nothing.');
  process.exit(2);
}

if (orderId && /^\d{10,}$/.test(String(orderId))) {
  line(`"${orderId}" looks like a TRANSACTION id, not an order id.`);
  line('For a single-line order the OrderID is <ItemID>-<TransactionID>. From the Seller Hub URL,');
  line('take itemid= and transId= and pass them as --item= and --trans=, or paste the whole URL.');
  line('Or run --list to see the real ids.');
  process.exit(2);
}

const st = oauthStatus(env);
if (!st.connected) {
  console.error('eBay account not connected.');
  console.error(`  read .env from: ${ROOT}`);
  console.error(`  EBAY_APP_ID     ${env.EBAY_APP_ID ? 'set' : 'MISSING'}`);
  console.error(`  EBAY_CERT_ID    ${env.EBAY_CERT_ID ? 'set' : 'MISSING'}`);
  console.error(`  EBAY_REFRESH_TOKEN ${env.EBAY_REFRESH_TOKEN ? 'set' : 'not set (fine if data/ebay-oauth.json exists)'}`);
  console.error(`  oauthStatus: ${JSON.stringify(st)}`);
  console.error('Run this from the repo root on the machine that holds data/ebay-oauth.json.');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Read the order BEFORE, and refuse anything that is not a safe probe target.
// ---------------------------------------------------------------------------------------------
// fatal=true (the pre-flight read) dies immediately on a miss — there is nothing left to test without
// an order. fatal=false (the post-send readback) returns null instead, because a miss right after a
// WRITE is ambiguous — eBay lag vs. something structural — and the caller decides whether to retry.
const snapshot = async (label, { fatal = true } = {}) => {
  const res = await getOrders(env, { orderIds: [orderId] });
  if (!res.ok) {
    if (!fatal) return null;
    console.error(`GetOrders (${label}) failed:`, JSON.stringify(res.errors || res.ack));
    process.exit(1);
  }
  const o = (res.orders || []).find((x) => String(x.orderId) === String(orderId));
  if (!o) {
    if (!fatal) return null;
    console.error(`eBay did not return order ${orderId}`); process.exit(1);
  }
  // AmountSaved is not in parseOrders and is corroborating evidence only — OrderType documents
  // AdjustmentAmount as an adjustment made by the BUYER, so a zero there proves nothing either way.
  o._amountSavedCents = xmlMoneyCents(res.xml, 'AmountSaved');
  o._adjustmentCents = xmlMoneyCents(res.xml, 'AdjustmentAmount');
  o._status = xmlField(res.xml, 'OrderStatus');
  return o;
};

const show = (o, label) => {
  line(`${label}`);
  line(`  status        ${o.orderStatus || o._status}   checkout=${o.checkoutStatus || '—'}   paid=${o.paidTime ? 'YES ' + o.paidTime : 'no'}`);
  line(`  subtotal      ${money(o.subtotalCents)}`);
  line(`  postage       ${money(o.shippingCents)}   service=${o.shipService || '—'}`);
  line(`  TOTAL         ${money(o.totalCents)}`);
  line(`  AmountSaved   ${money(o._amountSavedCents)}      AdjustmentAmount ${money(o._adjustmentCents)}`);
  line(`  lines         ${(o.items || []).length}   ship-to=${(o.ship && o.ship.country) || '?'}`);
  for (const it of (o.items || [])) {
    line(`     ${String(it.itemId || '').padEnd(14)} ×${it.quantity}  ${money(it.unitPriceCents)}  ${(it.title || '').slice(0, 40)}`);
  }
};

const before = await snapshot('before');
rule();
show(before, 'ORDER BEFORE');
rule();

if (before.paidTime) refuse('this order is already PAID. SendInvoice needs an unpaid order, and a probe must never touch a real sale.');
// cancelState, NOT the raw field — same trap as the lister. "NotApplicable" is truthy, so a raw test
// refuses every healthy order, which is exactly what it did.
if (cancelState(before) === 'cancelled') refuse('this order is cancelled.');
if ((before.totalCents || 0) > maxTotalCents) {
  refuse(`total ${money(before.totalCents)} is above the ${money(maxTotalCents)} safety ceiling. `
    + 'If this really is the throwaway order, pass --max-total to raise it deliberately.');
}
if ((before.items || []).length < 2) {
  line('NOTE: this order has one line. The probe still answers the cap question, but a multi-line order');
  line('      is the real case, so prefer one with two.');
}
const beforeTotal0 = before.totalCents || 0;
const postage0 = before.shippingCents || 0;

// No adjustment yet? Then this run is an inspection, which is exactly what a first look should be.
// Suggest amounts sized to THIS order rather than the generic $1.00/$6.90: the default rung 2 of $6.90
// exceeds a $6.68 order outright, so on small orders the canned figure is unusable.
if (!Number.isInteger(discountCents) || discountCents <= 0) {
  const inside = Math.max(1, Math.min(100, postage0));                       // within the postage cap
  const outside = Math.min(Math.max(postage0 + 100, 300), Math.max(100, beforeTotal0 - 100));
  line('');
  line('No adjustment given, so this was a look at the order. Next:');
  line('');
  line(`  CONTROL   inside the postage cap (${money(postage0)}) — does the field do ANYTHING?`);
  line(`    node --disable-warning=ExperimentalWarning scripts/probe-invoice-adjustment.mjs \\`);
  line(`      --order=${orderId} --adjust=${(inside / 100).toFixed(2)} --live`);
  line('');
  line('  THE QUESTION   outside the cap — does it discount the CARDS?');
  line(`    node --disable-warning=ExperimentalWarning scripts/probe-invoice-adjustment.mjs \\`);
  line(`      --order=${orderId} --adjust=${(outside / 100).toFixed(2)} --live`);
  line('');
  line(`Run the control first. If ${money(inside)} vanishes, the field is inert on this path and the`);
  line('second run tells you nothing new.');
  process.exit(0);
}

// An adjustment bigger than the order is not a test of anything — eBay would have to refuse it whatever
// the cap turns out to be, so it cannot distinguish the outcomes this probe exists to separate.
if (discountCents >= beforeTotal0) {
  refuse(`${money(discountCents)} is the whole ${money(beforeTotal0)} order or more. Pick something under `
    + `the total and over the ${money(postage0)} postage — try --adjust=`
    + `${(Math.min(Math.max(postage0 + 100, 300), Math.max(100, beforeTotal0 - 100)) / 100).toFixed(2)}.`);
}

// The shipping option is NOT optional on SendInvoice, even to leave it unchanged — omitting it fails
// the whole call with Error 20188 "At least one shipping option is required" (confirmed live). Default
// is to echo the order's OWN current service/cost back verbatim, which isolates the discount-only
// question. --ship-service + --ship-cost together instead OVERRIDE it — the combined-order question is
// whether eBay actually accepts a seller-chosen postage figure that differs from what it already
// computed for the cart, which is the real mechanism, not an echo.
if (!!shipServiceOverride !== (shipCostOverride != null)) {
  refuse('--ship-service and --ship-cost must be given together, or not at all. One without the other '
    + 'is not a real test of the override.');
}
if (!shipServiceOverride && (!before.shipService || before.shippingCents == null)) {
  refuse(`order has no shipping service on file (service=${before.shipService || '—'}, `
    + `cost=${before.shippingCents}) — cannot echo it back, so SendInvoice cannot be tested here.`);
}
const shipService = shipServiceOverride || before.shipService;
const shipCostCents = shipServiceOverride ? shipCostOverride : before.shippingCents;
const payload = {
  orderId, currency: before.currency || 'AUD', discountCents, messageId: 'probe-' + Date.now(),
  shippingService: shipService, shippingCostCents: shipCostCents,
};
const xml = buildSendInvoiceInner(payload);

line('');
line(`ADJUSTMENT UNDER TEST   −${money(discountCents)}` + (rung ? `   (rung ${rung})` : ''));
line(rung === '1' ? '  inside Seller Hub\'s cap — this is the CONTROL' : '  outside Seller Hub\'s cap — this is the QUESTION');
if (shipServiceOverride) {
  line(`SHIPPING OVERRIDE   ${before.shipService || '—'} ${money(before.shippingCents)}  →  ${shipService} ${money(shipCostCents)}`);
  line('  this is the COMBINED-POSTAGE question: does eBay accept OUR figure, not just echo its own?');
}
line('');
line('XML that will be sent (from the shipped buildSendInvoiceInner):');
line(xml.replace(/></g, '>\n  <').replace(/^/, '  '));
line('');

const beforeTotal = beforeTotal0;
const postage = postage0;
// With a shipping override, "uncapped" no longer means beforeTotal - discount — postage itself moved
// too. Expected total is subtotal (whatever it is) minus the discount plus the OVERRIDDEN postage.
const expectedUncappedTotal = (beforeTotal0 - postage0) - discountCents + shipCostCents;
line('Outcomes to expect:');
if (shipServiceOverride) {
  line(`  UNCAPPED       total becomes ${money(expectedUncappedTotal)}  (subtotal − discount + overridden postage)  → build it`);
} else {
  line(`  UNCAPPED       total becomes ${money(beforeTotal - discountCents)}  → build it`);
}
line(`  CAPPED         total becomes ${money(beforeTotal - postage)}  (only the postage came off)`);
line(`  SILENT DROP    total stays   ${money(beforeTotal)}  with Ack=Success  → the dangerous one`);
line('  HARD REJECT    Ack=Failure with an error code');
line('');

if (!live) {
  line('DRY RUN — nothing was sent. Re-run with --live to fire it.');
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Fire, then read back. The arithmetic is the primary evidence; the field values corroborate.
// ---------------------------------------------------------------------------------------------
line('sending…');
const r = await sendInvoice(env, payload);
line(`  ack=${r.ack}  http=${r.httpStatus}`);
for (const e of (r.errors || [])) line(`  eBay ${e.severity || ''} ${e.code || ''}: ${e.longMessage || e.shortMessage || ''}`);

if (!r.ok) {
  rule();
  line('VERDICT: HARD REJECT — eBay refused the call outright.');
  line('Record the error code above. If it names a maximum, the API mirrors the UI cap and the');
  line('invoice-discount design is dead; fall back to combined-postage rules + partial refund.');
  process.exit(0);
}

// eBay can lag before a write shows up on a read-by-id — confirmed live: the first real run here got
// Ack=Success and then a bare miss on the very next read, at a single fixed 4s wait. Retry with backoff
// instead of treating one miss as the answer; a transient lag and a structural problem look identical
// after exactly one try.
let after = null;
const waits = [4000, 4000, 8000, 8000];
for (let i = 0; i < waits.length && !after; i++) {
  await new Promise((res) => setTimeout(res, waits[i]));
  after = await snapshot('after', { fatal: false });
  if (!after && i < waits.length - 1) line(`  (readback ${i + 1}/${waits.length} found nothing yet, retrying…)`);
}
if (!after) {
  rule();
  const totalWait = waits.reduce((a, b) => a + b, 0) / 1000;
  line(`VERDICT: UNKNOWN — eBay ack'd the call (Ack=Success) but would not read order ${orderId} back`);
  line(`by ID after ${totalWait}s of retries. This is NOT the same as "nothing happened" — check Seller`);
  line('Hub directly for this order before concluding anything about the cap.');
  process.exit(0);
}
rule();
show(after, 'ORDER AFTER');
rule();

const afterTotal = after.totalCents || 0;
const moved = beforeTotal - afterTotal;
// With no override, shipCostCents === postage0, so this collapses to plain discountCents — same check
// as before. With an override, "fully honoured" means BOTH the discount AND the new postage landed.
const expectedMoved = postage0 - shipCostCents + discountCents;
line('');
line(`total moved by   ${money(moved)}   (asked for ${money(discountCents)}` + (shipServiceOverride ? ` + postage ${money(postage0)}→${money(shipCostCents)}` : '') + ')');
line('');

let verdict;
if (moved === expectedMoved) {
  verdict = shipServiceOverride
    ? 'UNCAPPED + OVERRIDE HONOURED — the discount AND our postage figure both landed. THE COMBINED-INVOICE MECHANISM WORKS.'
    : 'UNCAPPED — the API applied the full adjustment. THE EXISTING BUILD IS THE ANSWER.';
} else if (moved === 0) {
  verdict = 'SILENT DROP — eBay accepted the call and changed nothing. The field is inert on this path.';
} else if (moved === postage) {
  verdict = shipServiceOverride
    ? `POSTAGE OVERRIDE IGNORED — exactly the ORIGINAL ${money(postage)} came off; our ${money(shipCostCents)} figure was not honoured.`
    : `CAPPED AT THE POSTAGE LINE — exactly ${money(postage)} came off. The API mirrors the UI.`;
} else if (shipServiceOverride && moved === discountCents) {
  verdict = `DISCOUNT LANDED, POSTAGE OVERRIDE DID NOT — the ${money(discountCents)} discount applied but `
    + `postage stayed at the original ${money(postage)} instead of our ${money(shipCostCents)}.`;
} else if (moved > 0 && moved < expectedMoved) {
  // Partial, but not a figure this probe recognises. Do not claim it matches something it does not.
  verdict = `CAPPED AT SOMETHING ELSE — ${money(moved)} came off, which matches neither the full ask `
    + `(${money(expectedMoved)}) nor the original postage (${money(postage)}). Read the invoice email before concluding anything.`;
} else {
  verdict = `UNEXPECTED — the total moved by ${money(moved)}, which matches none of the figures this probe tracks.`;
}

line('VERDICT: ' + verdict);
line('');
line('Now check the invoice email copy in the seller inbox (EmailCopyToSeller was on). What the BUYER');
line('is asked to pay is the second witness, and it outranks any field on the order if they disagree.');
if (rung === '1' && moved === 0) {
  line('');
  line('Rung 1 vanished, so the field does nothing on the OrderID path at all. Rung 2 would add nothing —');
  line('skip it and go to the fallback design.');
}
line('');
line('Remember to cancel this order as buyer-requested before payment, so no money moves and no fee is');
line('charged.');
