// scripts/publish-shopify.mjs — drive the Shopify batch over EXISTING stock, from the command line.
//
// WHY THIS EXISTS. The Batch Runner's 🛍 Shopify button publishes the queue it is holding, and that
// queue is localStorage: cards caught in this browser session and staged. It has no way to reach a row
// that is already in inventory_items — which on the trading box is most of them (265 rows, none of
// them ever published). M1's gate is "20 real Pokémon singles on dev", and those singles are exactly
// the rows the button cannot see. So the batch needs a second driver, and R1's re-catalog wants one
// anyway: thousands of cards is a script's job, not a tab's.
//
// WHAT IT TALKS TO. The running dev server's routes, not the library directly — deliberately. Every
// guard (credentials, pins, publish.enabled), the shelf-label claim and the audit row live behind
// /api/shopify, and a CLI that reached past them into the lib would be a second code path with its own
// bugs and none of the refusals. It also needs the server for another reason: the publish path
// self-fetches the image compositor at /api/listing-image/build, so there is no serverless mode to
// have.
//
// SAFE BY DEFAULT. Selection is read-only, and nothing publishes without --live. Bare, it previews:
// picks the rows, runs the free preflight and prints what would happen. The server refuses --live
// anyway while publish.enabled is false, so arming is still a deliberate edit to
// data/shopify.config.json and never a flag typed here.
//
// Run:
//   node --disable-warning=ExperimentalWarning scripts/publish-shopify.mjs                  (preview 20 Pokémon)
//   node --disable-warning=ExperimentalWarning scripts/publish-shopify.mjs --limit 5
//   node --disable-warning=ExperimentalWarning scripts/publish-shopify.mjs --dry-run        (server-side dry run)
//   node --disable-warning=ExperimentalWarning scripts/publish-shopify.mjs --live           (really publish)
//   node --disable-warning=ExperimentalWarning scripts/publish-shopify.mjs --ids 12,13,14
// DatabaseSync directly, not openDbAt — that runs migrations, and a tool whose only job is to SELECT
// twenty ids has no business writing schema to the box that trades. DB_PATH is just a resolved path.
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../lib/db.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const LIMIT = Math.max(1, parseInt(val('--limit', '20'), 10) || 20);
const GAME = val('--game', 'pokemon');
const IDS = val('--ids', '').split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite);
const PORT = val('--port', process.env.PORT || '5273');
const BASE = val('--base', `http://127.0.0.1:${PORT}`);
const LIVE = has('--live');
const DRY = has('--dry-run');
const FORCE = has('--force');
const API = BASE + '/api/shopify';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

async function api(path, body) {
  let r;
  try {
    r = await fetch(API + path, body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    console.error(red(`\ncannot reach ${BASE} — is \`pnpm dev\` running on this box?`));
    console.error(dim(`  ${e && e.message}`));
    process.exit(2);
  }
  return r;
}
const json = async (path, body) => { const r = await api(path, body); const t = await r.text(); try { return { status: r.status, j: JSON.parse(t) }; } catch { return { status: r.status, j: null, t }; } };

// Wrapped in main() so every early exit is a RETURN. process.exit() while a fetch response is
// still tearing down trips a libuv assertion on Windows (UV_HANDLE_CLOSING) and reports 127 —
// a crash banner on top of a refusal that was handled correctly.
async function main() {
  // --- 1. which rows -----------------------------------------------------------------------------
  //
  // Read-only, and deliberately conservative: in_stock, has a price, has a quantity, and is not already
  // mirrored as live on Shopify. `status` is the tool's own lifecycle ('in_stock'|'listed'|'sold') and a
  // 'listed' row is on EBAY, not Shopify — so it is still a candidate here. Anything questionable is
  // left for the server's preflight to refuse rather than filtered out silently, because a row that
  // vanishes between the DB and the run is a row nobody knows to ask about.
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let rows;
  if (IDS.length) {
    rows = db.prepare(`SELECT i.id, i.sku, i.game, i.name, i.condition, i.status, i.quantity, i.target_price_cents
                       FROM inventory_items i WHERE i.id IN (${IDS.map(() => '?').join(',')})`).all(...IDS);
  } else {
    rows = db.prepare(`
      SELECT i.id, i.sku, i.game, i.name, i.condition, i.status, i.quantity, i.target_price_cents
      FROM inventory_items i
      LEFT JOIN shopify_listings s ON s.kind = 'inventory' AND s.item_id = i.id AND s.state = 'live'
      WHERE i.game = ? AND i.status = 'in_stock' AND i.quantity > 0
        AND i.target_price_cents IS NOT NULL AND i.target_price_cents > 0
        AND s.sku IS NULL
      ORDER BY i.id
      LIMIT ?`).all(GAME, LIMIT);
  }

  const totals = db.prepare('SELECT COUNT(*) n FROM inventory_items').get().n;
  const mirrored = db.prepare("SELECT COUNT(*) n FROM shopify_listings WHERE state = 'live'").get().n;
  db.close();

  console.log(bold('\nShopify batch — ' + (LIVE ? red('LIVE') : DRY ? yellow('server dry run') : 'preview')));
  console.log(dim(`  database   ${DB_PATH}`));
  console.log(dim(`  stock      ${totals} inventory_items · ${mirrored} already live on Shopify`));
  console.log(dim(`  selected   ${rows.length}${IDS.length ? ' by id' : ` × ${GAME}, in_stock, priced, not yet on Shopify`}`));

  if (!rows.length) {
    console.log(red('\nnothing to publish — no row matched. Try --game, --limit, or --ids.\n'));
    { process.exitCode = 1; return; }
  }
  for (const r of rows) {
    console.log(`  ${String(r.id).padStart(5)}  ${(r.sku || '—').padEnd(14)} ${String(r.name || '').slice(0, 42).padEnd(42)} ${dim((r.condition || '') + ' · A$' + ((r.target_price_cents || 0) / 100).toFixed(2))}`);
  }

  // --- 2. the free preflight ---------------------------------------------------------------------
  const itemIds = rows.map((r) => r.id);
  const { status: pfStatus, j: pf } = await json('/publish/preflight', { itemIds });
  if (pfStatus !== 200 || !pf) { console.error(red(`\npreflight failed (HTTP ${pfStatus})`)); { process.exitCode = 2; return; } }

  console.log(bold('\npreflight'));
  console.log(`  store        ${pf.store === 'live' ? red(bold('LIVE — the real shop')) : pf.store}${pf.pins.missing.length ? red(' — NOT PINNED: ' + pf.pins.missing.join(', ')) : ''}`);
  // There is no --store flag: the target comes from defaultStore in the config. Saying so out loud
  // matters most in the case where someone has changed it and forgotten.
  if (pf.store === 'live') {
    console.log(red('               ^ this is not the dev store. publish.allowLive must also be true,'));
    console.log(red('                 and it is a separate switch from publish.enabled on purpose.'));
  }
  console.log(`  publishing   ${pf.publishEnabled ? green('ARMED') : yellow('off — the server will only dry run')}  ·  new products land as ${bold(pf.publishStatus)}`);
  console.log(`  labels       ${pf.nextLabel ? 'from ' + bold(pf.nextLabel) : 'rows already carry theirs'}`);
  console.log(`  publishable  ${green(String(pf.publishable))}   already live ${pf.alreadyLive}   refused ${pf.refused ? red(String(pf.refused)) : '0'}`);

  for (const r of pf.rows.filter((x) => !x.ok)) {
    console.log(red(`  ✖ ${r.item_id}`) + `  ${(r.name || '').slice(0, 40)}`);
    for (const e of r.errors) console.log(`      ${e}`);
  }
  const warned = pf.rows.filter((x) => x.ok && x.warnings.length);
  for (const r of warned) console.log(yellow(`  ! ${r.item_id}`) + `  ${(r.name || '').slice(0, 40)} — ${r.warnings.join(' · ')}`);

  if (!pf.publishable) { console.log(red('\nnothing publishable. Fix the refusals above and run again.\n')); { process.exitCode = 1; return; } }
  if (!LIVE && !DRY) {
    console.log(dim('\npreview only — nothing was sent. Add --dry-run to have the SERVER map and validate every card,'));
    console.log(dim('or --live to publish for real (the server still refuses unless publish.enabled is true).\n'));
    { process.exitCode = 0; return; }
  }

  // --- 3. the run --------------------------------------------------------------------------------
  const go = pf.rows.filter((x) => x.ok && (FORCE || !x.alreadyLive)).map((x) => x.item_id);
  console.log(bold(`\n${LIVE ? 'publishing' : 'dry running'} ${go.length}…\n`));

  const resp = await api('/publish/batch', { itemIds: go, dryRun: !LIVE, force: FORCE });
  if (!resp.ok) {
    const t = await resp.text();
    let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
    console.error(red(`\nthe server refused the batch (HTTP ${resp.status}): ${j ? j.error : t}`));
    if (j && j.code === 'publish_disabled') console.error(dim('  set publish.enabled true in data/shopify.config.json once a dry run has been eyeballed.'));
    { process.exitCode = 2; return; }
  }

  // NDJSON, one record per row as it lands. Printed as it arrives rather than collected, because the
  // whole point of a streamed batch is watching it — and if it dies halfway, what already printed is
  // the record of what got through.
  let buf = '', summary = null;
  for await (const chunk of resp.body) {
    buf += Buffer.from(chunk).toString('utf8');
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.start) { console.log(dim(`  ${o.start.total} rows → ${o.start.store}${o.start.dryRun ? ' (dry run)' : ''}\n`)); continue; }
      if (o.summary) { summary = o.summary; continue; }
      if (!o.row) continue;
      const r = o.row;
      const mark = r.status === 'published' ? green('✔') : r.status === 'would_publish' ? green('·') : r.status === 'skipped' ? dim('–') : red('✖');
      // On a dry run the sku is a PEEK, and a peek does not advance — so every row reports the same
      // next-free label. Printing it per row would show three cards sharing one SKU, which is not what
      // a real run does and not a thing anyone should have to reason about at 2am. The label series is
      // stated once, by the preflight above.
      const skuCol = LIVE ? (r.sku || '—') : dim('(at publish)');
      console.log(`  ${mark} ${String(r.item_id).padStart(5)}  ${skuCol.padEnd(LIVE ? 14 : 22)} ${String(r.name || '').slice(0, 34).padEnd(34)} ${r.status}`
        + (r.handle ? dim('  /products/' + r.handle) : '') + (r.error ? red('  ' + r.error) : ''));
      for (const w of r.warnings || []) console.log(yellow(`        ! ${w}`));
    }
  }

  const s = summary || {};
  const held = (s.failed || 0) + (s.refused || 0);
  console.log(bold('\n──────── summary ────────'));
  console.log(`  ${green(String(s.published || 0))} ${LIVE ? 'published' : 'would publish'}   ${s.skipped || 0} skipped   ${held ? red(held + ' held') : '0 held'}`);
  if (s.cancelled) console.log(yellow('  the run was cancelled'));
  if (s.aborted) console.log(red('  aborted: ' + s.aborted));
  if (LIVE && s.published) console.log(dim(`\n  check them: https://admin.shopify.com/store/${pf.store === 'live' ? 'binderskeepers' : 'binders-keepers-dev'}/products`));
  console.log(held ? yellow('\n  fix the held rows and run again — a re-run never duplicates, it upserts.\n') : '\n');
  // exitCode, not exit(). process.exit() while the NDJSON response is still tearing down trips a libuv
  // assertion on Windows (UV_HANDLE_CLOSING) and reports 127 — a crash banner on a run that in fact
  // succeeded. Setting the code and letting node drain naturally is quieter and more honest.
  process.exitCode = held ? 1 : 0;

}

await main();
