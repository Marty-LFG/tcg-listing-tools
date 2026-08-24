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
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { getOrders, sendInvoice, buildSendInvoiceInner, xmlField, xmlMoneyCents } from '../lib/ebay-trading.mjs';
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

if (!orderId) {
  line('Usage: --order=<order id> [--rung=1|2 | --adjust=6.90] [--live] [--max-total=50]');
  line('       --list [--days=30]           ← recent UNPAID orders, with sales record nos');
  line('       --sales-record=1165          ← look up the order id from the number Seller Hub shows');
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
const snapshot = async (label) => {
  const res = await getOrders(env, { orderIds: [orderId] });
  if (!res.ok) {
    console.error(`GetOrders (${label}) failed:`, JSON.stringify(res.errors || res.ack));
    process.exit(1);
  }
  const o = (res.orders || []).find((x) => String(x.orderId) === String(orderId));
  if (!o) { console.error(`eBay did not return order ${orderId}`); process.exit(1); }
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

const refuse = (why) => { console.error('\nREFUSED: ' + why); process.exit(1); };
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

// What the shipped builder would send. Deliberately NO shipping override: this probe isolates the
// adjustment, so the postage line must stay exactly where it was or the arithmetic below is ambiguous.
const payload = { orderId, currency: before.currency || 'AUD', discountCents, messageId: 'probe-' + Date.now() };
const xml = buildSendInvoiceInner(payload);

line('');
line(`ADJUSTMENT UNDER TEST   −${money(discountCents)}` + (rung ? `   (rung ${rung})` : ''));
line(rung === '1' ? '  inside Seller Hub\'s cap — this is the CONTROL' : '  outside Seller Hub\'s cap — this is the QUESTION');
line('');
line('XML that will be sent (from the shipped buildSendInvoiceInner):');
line(xml.replace(/></g, '>\n  <').replace(/^/, '  '));
line('');

const beforeTotal = beforeTotal0;
const postage = postage0;
line('Outcomes to expect:');
line(`  UNCAPPED       total becomes ${money(beforeTotal - discountCents)}  → build it`);
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

// eBay can lag a moment before the order reflects the invoice.
await new Promise((res) => setTimeout(res, 4000));
const after = await snapshot('after');
rule();
show(after, 'ORDER AFTER');
rule();

const afterTotal = after.totalCents || 0;
const moved = beforeTotal - afterTotal;
line('');
line(`total moved by   ${money(moved)}   (asked for ${money(discountCents)})`);
line('');

let verdict;
if (moved === discountCents) {
  verdict = 'UNCAPPED — the API applied the full adjustment. THE EXISTING BUILD IS THE ANSWER.';
} else if (moved === 0) {
  verdict = 'SILENT DROP — eBay accepted the call and changed nothing. The field is inert on this path.';
} else if (moved === postage) {
  verdict = `CAPPED AT THE POSTAGE LINE — exactly ${money(postage)} came off. The API mirrors the UI.`;
} else if (moved > 0 && moved < discountCents) {
  // Partial, but not the postage figure either. Do not claim it matches something it does not.
  verdict = `CAPPED AT SOMETHING ELSE — ${money(moved)} came off, which is neither the ${money(discountCents)} `
    + `asked for nor the ${money(postage)} postage. Read the invoice email before concluding anything.`;
} else {
  verdict = `UNEXPECTED — the total moved by ${money(moved)}, which is neither the adjustment nor the postage.`;
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
