// scripts/check-relisted-price.mjs — after cancelling an order, eBay AU auto-relists a fixed-price,
// available-quantity listing. Confirm the relisted price is the ORIGINAL listing price, not something
// that drifted from whatever the order/invoice happened to carry.
//
// READ-ONLY. One GetItem per item id (lib/ebay-trading.mjs getListingState) — no revise, no relist,
// nothing written. Needs the USER token (data/ebay-oauth.json), so run on the machine that holds it.
//
// WHY THIS EXISTS. SendInvoice's AdjustmentAmount is an ORDER-level deduction — it has no mechanism to
// touch an Item's StartPrice, and this repo never calls ReviseItem/ReviseFixedPriceItem anywhere near
// the invoice path. So a relist picking up the discounted figure would mean something is reading price
// off the wrong record, not a plausible eBay behaviour — but "shouldn't happen" is a reason to check,
// not a reason to skip checking.
//
// Run: node --disable-warning=ExperimentalWarning scripts/check-relisted-price.mjs \
//        --items=158215666449:8.98,158190549975:4.98,168633660338:8.98
//   id alone (no :expected) just prints what eBay has, with no PASS/FAIL judgement.
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { getListingState } from '../lib/ebay-trading.mjs';
import { oauthStatus } from '../lib/ebay-oauth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv('development', ROOT, ''), ...process.env };
const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const money = (c) => (c == null ? '—' : 'A$' + (c / 100).toFixed(2));
const line = (s = '') => console.log(s);

const itemsArg = arg('items');
if (!itemsArg) {
  console.error('Usage: --items=itemId[:expectedDollars][,itemId[:expectedDollars]...]');
  process.exit(1);
}
const targets = itemsArg.split(',').map((chunk) => {
  const [id, expected] = chunk.split(':');
  return { id: id.trim(), expectedCents: expected != null ? Math.round(parseFloat(expected) * 100) : null };
});

const st = oauthStatus(env);
if (!st || !st.connected) {
  console.error('eBay account not connected on this machine. Run this on the box that holds');
  console.error('data/ebay-oauth.json — this cannot be checked from a box without the user token.');
  process.exit(1);
}

let anyMismatch = false;
for (const { id, expectedCents } of targets) {
  const r = await getListingState(env, id);
  if (!r.ok) {
    line(`${id}  ERROR  ${r.error}`);
    anyMismatch = true;
    continue;
  }
  const priceStr = money(r.price_cents).padEnd(9);
  const statusStr = `${r.listing_status || '?'}  qty avail=${r.available_qty ?? '?'}`;
  if (expectedCents == null) {
    line(`${id}  ${priceStr}  ${statusStr}  ${r.title || ''}`);
  } else {
    const ok = r.price_cents === expectedCents;
    if (!ok) anyMismatch = true;
    line(`${id}  ${priceStr}  expected ${money(expectedCents).padEnd(9)}  `
      + `${ok ? 'MATCH' : '*** MISMATCH ***'}  ${statusStr}  ${r.title || ''}`);
  }
}
line('');
line(anyMismatch
  ? 'MISMATCH FOUND — do not assume the relist is safe. Check the listing directly on eBay.'
  : 'All checked listings match the expected price.');
process.exit(anyMismatch ? 1 : 0);
