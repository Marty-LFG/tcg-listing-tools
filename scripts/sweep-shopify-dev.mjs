// scripts/sweep-shopify-dev.mjs — empty the DEV store so a real catalogue can be uploaded onto a
// clean slate.
//
// DEV STORE ONLY, AND STRUCTURALLY SO. There is no --store flag and no live branch anywhere in this
// file, plus an explicit refusal if the resolved shop is SHOPIFY_SHOP. That is not belt-and-braces: a
// bulk-delete script that CAN be pointed at the real shop is a bad thing to have in a repo, and the
// same reasoning already governs scripts/check-shopify.mjs. The live store is cleaned by hand, in the
// admin, where there are four items and a confirmation dialog.
//
// IT ALSO CLEARS THE MIRROR, and that is the half people forget. shopify_listings is what the publish
// path consults to decide a card is already live. Delete a product on Shopify and leave its mirror row
// saying state='live' with a product_gid, and the tool will skip that card forever — a clean store the
// tool believes is full, which is worse than either state on its own. Every deletion here removes the
// matching mirror row in the same run.
//
// THREE PILES, chosen explicitly. Nothing is deleted without naming its pile, because "everything that
// is not real" is exactly the kind of judgement a script should not be making on a store:
//
//   --demos      Shopify's own sample data — the-*-snowboard, selling-plans-ski-wax, asset-pack-*.
//                Never anything of ours. `gift-card` is deliberately EXCLUDED: it is a Shopify system
//                product, not sample data, and deleting it breaks gift card orders.
//   --seed       Rows created by scripts/seed-dev-catalog.ps1 — bkc metafields but no tool SKU.
//   --published  Products the LISTING TOOL published (AAC-/AAD-/AAG-/BK-PKM-/BK-RAW-PKM-/STG-).
//                These are real cards. Re-uploading them is one publish-shopify.mjs run, which is why
//                this is offered at all — but it is the pile that deletes real work, so it is never
//                included in a bare --all and has to be asked for by name.
//
// Run:
//   node --disable-warning=ExperimentalWarning scripts/sweep-shopify-dev.mjs                    (dry run, all piles)
//   node --disable-warning=ExperimentalWarning scripts/sweep-shopify-dev.mjs --demos --write
//   node --disable-warning=ExperimentalWarning scripts/sweep-shopify-dev.mjs --demos --seed --collections --write
//   node --disable-warning=ExperimentalWarning scripts/sweep-shopify-dev.mjs --everything --write
import { DatabaseSync } from 'node:sqlite';
import { loadEnv } from 'vite';
import { DB_PATH } from '../lib/db.mjs';
import { shopifyGraphQL, resolveShop, firstErrorText } from '../lib/channels/shopify-admin.mjs';

const env = loadEnv('development', process.cwd(), '');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const WRITE = has('--write');
const EVERYTHING = has('--everything');
const WANT = {
  demos: EVERYTHING || has('--demos'),
  seed: EVERYTHING || has('--seed'),
  published: EVERYTHING || has('--published'),
  collections: EVERYTHING || has('--collections'),
};
// A bare run with no pile named means "show me everything", which is the useful default for a tool
// whose first job is telling you what is there.
const NONE_CHOSEN = !WANT.demos && !WANT.seed && !WANT.published && !WANT.collections;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// ---- the refusal that makes this file safe to have around -------------------------------------
const devShop = (() => { try { return resolveShop(env, 'dev'); } catch { return null; } })();
const liveShop = String(env.SHOPIFY_SHOP || '').trim();
if (!devShop) { console.error(red('\nno dev store configured — set SHOPIFY_DEV_SHOP in .env\n')); process.exit(2); }
if (liveShop && devShop.replace(/\.myshopify\.com$/, '') === liveShop.replace(/\.myshopify\.com$/, '')) {
  console.error(red('\nREFUSING: SHOPIFY_DEV_SHOP resolves to the same store as SHOPIFY_SHOP.'));
  console.error(red('This script only ever deletes from the dev store, and it cannot prove that here.\n'));
  process.exit(2);
}

const TOOL_SKU = /^(AAC|AAD|AAG|BK-PKM|BK-RAW-PKM|STG)-/i;
const DEMO_HANDLE = /(^|-)(snowboard|ski-wax)(-|$)|^asset-pack-|^the-(minimal|archived|draft|hidden|complete|videographer|compare-at-price|out-of-stock|inventory-not-tracked|multi-location|multi-managed|3p-fulfilled|collection)-/;
// Shopify's own sample collections. Everything else that is not frontpage was created by our seed
// script, and is swept under the same flag — deliberately. Those are MANUAL collections, while
// D-016/D-027 call for the per-set ones to be AUTOMATED collections keyed on the bkc.set_code
// metafield. Keeping them would preserve the wrong shape and make the real ones harder to see.
const DEMO_COLLECTION = /^(automated-collection|hydrogen|asset-pack-)/;
// frontpage is Shopify's own Home page collection and gift-card is a system product. Neither is sample
// data, and deleting either breaks something real.
const KEEP_COLLECTION = /^frontpage$/;
const KEEP_PRODUCT = /^gift-card$/;

const gql = (q, v) => shopifyGraphQL(env, q, v, { store: 'dev', estimate: 40 });

console.log(bold(`\nDev store sweep — ${WRITE ? red('WRITE') : 'dry run'}`));
console.log(dim(`  store     ${devShop}`));

const pr = await gql(`query { products(first:250){nodes{ id handle status tags
  variants(first:1){nodes{sku}} metafields(first:3,namespace:"bkc"){nodes{key}} }} }`);
if (!pr.ok) { console.error(red('could not read products: ' + (firstErrorText(pr) || pr.httpStatus))); process.exit(2); }
const cr = await gql(`query { collections(first:100){nodes{ id handle title productsCount{count} }} }`);
if (!cr.ok) { console.error(red('could not read collections: ' + (firstErrorText(cr) || cr.httpStatus))); process.exit(2); }

const piles = { demos: [], seed: [], published: [], keep: [] };
for (const p of pr.data.products.nodes) {
  const sku = p.variants.nodes[0]?.sku || '';
  const rec = { id: p.id, handle: p.handle, sku, status: p.status };
  // `bk-seed` is written by bk-shopify/scripts/seed-dev-catalog.ps1 on EVERY product it creates, so it
  // is the honest marker for the seeded catalogue. Matching on bkc metafields instead missed the three
  // non-card seeds — the mystery bundle and the two accessories — because they are not cards and carry
  // no bkc.* at all. They would have survived a --seed sweep and looked like real stock afterwards.
  const seeded = (p.tags || []).includes('bk-seed');
  if (KEEP_PRODUCT.test(p.handle)) piles.keep.push(rec);
  else if (TOOL_SKU.test(sku)) piles.published.push(rec);
  else if (seeded || p.metafields.nodes.length) piles.seed.push(rec);
  else if (DEMO_HANDLE.test(p.handle)) piles.demos.push(rec);
  else piles.keep.push(rec);                       // unrecognised: never swept, only reported
}
const cols = cr.data.collections.nodes.map((c) => ({ id: c.id, handle: c.handle, n: c.productsCount.count }));
const colDemos = cols.filter((c) => !KEEP_COLLECTION.test(c.handle));

const show = (name, arr, wanted) => {
  console.log(`\n${bold(name)} ${dim('(' + arr.length + ')')}${wanted ? red('  → will delete') : dim('  → keeping')}`);
  for (const p of arr.slice(0, 40)) console.log(`   ${(p.sku || '—').padEnd(20)} ${p.handle}`);
  if (arr.length > 40) console.log(dim(`   … and ${arr.length - 40} more`));
};
show('Shopify sample data', piles.demos, WANT.demos);
show('seeded test catalogue', piles.seed, WANT.seed);
show('published by the listing tool', piles.published, WANT.published);
if (piles.keep.length) show('not touched — unrecognised or system', piles.keep, false);
console.log(`\n${bold('collections')} ${dim('(' + colDemos.length + ' sweepable of ' + cols.length + ')')}${WANT.collections ? red('  → will delete') : dim('  → keeping')}`);
for (const c of cols) {
  const swept = colDemos.includes(c);
  const why = DEMO_COLLECTION.test(c.handle) ? 'Shopify sample' : 'seeded — manual, D-016/D-027 wants these automated';
  console.log(`   ${String(c.n).padStart(3)}  ${c.handle.padEnd(24)}${KEEP_COLLECTION.test(c.handle)
    ? dim('Shopify Home page — always kept')
    : (WANT.collections ? red('← sweep  ') : dim('kept     ')) + dim(why)}`);
}

const targets = [...(WANT.demos ? piles.demos : []), ...(WANT.seed ? piles.seed : []), ...(WANT.published ? piles.published : [])];

console.log(bold('\n──────── plan ────────'));
console.log(`  ${targets.length} product(s) and ${WANT.collections ? colDemos.length : 0} collection(s) to delete`);
if (WANT.published && piles.published.length) {
  console.log(yellow(`  ⚠ includes ${piles.published.length} REAL card(s) published by the tool. Their mirror rows are cleared too,`));
  console.log(yellow('    so publish-shopify.mjs will treat them as new and can re-upload them in one run.'));
}

if (NONE_CHOSEN) {
  console.log(dim('\n  Nothing selected. Name the piles you want gone:'));
  console.log(dim('    --demos          Shopify sample data'));
  console.log(dim('    --seed           the seeded test catalogue'));
  console.log(dim('    --published      real cards the tool published (re-uploadable)'));
  console.log(dim('    --collections    the sample collections'));
  console.log(dim('    --everything     all of the above'));
  console.log(dim('  Then add --write.\n'));
  process.exit(0);
}
if (!WRITE) {
  console.log(yellow('\n  dry run — nothing was deleted. Re-run with --write to apply.\n'));
  process.exit(0);
}

// ---- the write pass ---------------------------------------------------------------------------
const DEL_P = `mutation D($input: ProductDeleteInput!){ productDelete(input:$input){ deletedProductId userErrors{ message } } }`;
const DEL_C = `mutation D($input: CollectionDeleteInput!){ collectionDelete(input:$input){ deletedCollectionId userErrors{ message } } }`;

const db = new DatabaseSync(DB_PATH);
const forget = db.prepare('DELETE FROM shopify_listings WHERE sku = ?');
let gone = 0, failed = 0, forgot = 0;

console.log('');
for (const p of targets) {
  const r = await gql(DEL_P, { input: { id: p.id } });
  const ue = r.data?.productDelete?.userErrors || [];
  if (r.ok && r.data?.productDelete?.deletedProductId) {
    gone++;
    // The mirror, in the same breath. A store emptied without this leaves the tool skipping every card
    // it thinks is still live.
    if (p.sku) { try { forgot += forget.run(p.sku).changes || 0; } catch { /* nothing to forget */ } }
    console.log(`  ${green('✔')} ${(p.sku || '—').padEnd(20)} ${p.handle}`);
  } else {
    failed++;
    console.log(`  ${red('✖')} ${(p.sku || '—').padEnd(20)} ${p.handle}  ${red(ue[0]?.message || firstErrorText(r) || 'HTTP ' + r.httpStatus)}`);
  }
}
if (WANT.collections) {
  for (const c of colDemos) {
    const r = await gql(DEL_C, { input: { id: c.id } });
    const ok = r.ok && r.data?.collectionDelete?.deletedCollectionId;
    console.log(`  ${ok ? green('✔') : red('✖')} collection            ${c.handle}`);
    ok ? gone++ : failed++;
  }
}
// THE IMAGE CACHE GOES TOO, and forgetting it cost a run. shopify_files maps a content hash to a
// MediaImage gid and never revalidates — its own header says so — which means it assumes Shopify's
// files are immortal. Deleting a product takes its media with it, so the next publish of that same
// card reuses a gid that no longer exists and productSet refuses the ENTIRE call with INVALID_INPUT.
//
// Measured here: a sweep of 60 products was followed by a run in which exactly the ten
// previously-published cards failed and all 35 new ones succeeded. That split is what identified it.
//
// Cleared whole rather than per product, because the cache is keyed on content hash and has no idea
// which product a file belonged to. Re-uploading is the only cost, and after a sweep there is nothing
// left for those references to point at anyway. The publish path also self-heals this now, so a stale
// row is recoverable rather than fatal — but not creating them is better than recovering from them.
if (gone && (WANT.seed || WANT.published)) {
  try { files = db.prepare('DELETE FROM shopify_files').run().changes || 0; } catch { /* GR7 */ }
}
db.close();

console.log(bold('\n──────── summary ────────'));
console.log(`  ${green(String(gone))} deleted   ${failed ? red(failed + ' failed') : '0 failed'}   ${forgot} mirror row(s) cleared   ${files} cached image ref(s) cleared`);
if (WANT.published) {
  console.log(dim('\n  Re-upload the real cards when you are ready:'));
  console.log(dim('    node --disable-warning=ExperimentalWarning scripts/publish-shopify.mjs --limit 50 --include-listed --live\n'));
} else console.log('');
process.exitCode = failed ? 1 : 0;
