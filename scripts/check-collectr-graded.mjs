// scripts/check-collectr-graded.mjs — graded-path harness (AGENTS.md §8):
//   1. the raw-only unique index lets a raw + graded copy of the SAME card coexist,
//      while two raw copies collide (the /batches route then updates, not duplicates);
//   2. graded pricing precedence (Collectr>0 → market; 0 → PriceCharting rung;
//      nothing → needs_price, never fabricated — GR4);
//   3. valueFromLadder maps the real slab grades (PSA 10 / BGS 10 / TAG 10).
// Run: node --disable-warning=ExperimentalWarning scripts/check-collectr-graded.mjs
import { openDb } from '../lib/db.mjs';
import { resolvePrice, loadBulkConfig } from '../lib/pricing.mjs';
import { valueFromLadder } from '../lib/inventory.mjs';

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\n[schema: raw-only unique index]');
const db = openDb(':memory:');   // full DDL + migrateBulk run on a blank DB
{
  db.prepare(`INSERT INTO bulk_batches (game, source, set_name) VALUES ('pokemon','collectr','30th Vintage')`).run();
  const batchId = db.prepare(`SELECT id FROM bulk_batches ORDER BY id DESC LIMIT 1`).get().id;
  const ins = (sku, graded) => db.prepare(
    `INSERT INTO inventory_items (sku, game, identity_key, name, variant, batch_id, grading_company, grade, quantity)
     VALUES (?,?,?,?,?,?,?,?,1)`)
    .run(sku, 'pokemon', 'base1-4', 'Charizard', 'Holo', batchId, graded ? 'TAG' : null, graded ? 10 : null);

  ins('BK-RAW-PKM-000001', false);
  let rawDupThrew = false;
  try { ins('BK-RAW-PKM-000002', false); } catch { rawDupThrew = true; }
  assert('second RAW copy of same (game,identity,variant) collides (upsert path)', rawDupThrew);

  ins('BK-PKM-000001', true);
  let gradedThrew = false;
  try { ins('BK-PKM-000002', true); } catch { gradedThrew = true; }
  assert('graded slabs never collide (distinct physical items)', !gradedThrew);

  const n = db.prepare(`SELECT COUNT(*) AS n FROM inventory_items WHERE identity_key = 'base1-4'`).get().n;
  assert('raw + graded coexist (raw 1 + graded 2 = 3 rows)', n === 3, 'rows=' + n);

  // non-bulk rows (batch_id NULL) are exempt — the graded/manual inventory may repeat a card
  db.prepare(`INSERT INTO inventory_items (sku, game, identity_key, name, variant, quantity) VALUES ('BK-PKM-000099','pokemon','base1-4','Charizard','Holo',1)`).run();
  assert('non-bulk duplicate identity allowed (index is batch-scoped)', true);
}

console.log('\n[graded pricing precedence]');
{
  const cfg = loadBulkConfig();
  const rates = { USD: 1, AUD: 1.52 };
  const withCollectr = resolvePrice({ game: 'pokemon', graded: true, market_aud: 252962.07 }, cfg, rates);
  assert('Collectr market > 0 → market', withCollectr.value_source === 'market' && withCollectr.price_cents > 0);
  const withPc = resolvePrice({ game: 'pokemon', graded: true, market_aud: null, pc_value_usd: 974.76 }, cfg, rates);
  assert('Collectr 0 → PriceCharting rung', withPc.value_source === 'pricecharting' && withPc.price_cents > 0);
  const nothing = resolvePrice({ game: 'pokemon', graded: true, market_aud: null }, cfg, rates);
  assert('nothing → needs_price + null price (no fabrication, GR4)', nothing.value_source === 'needs_price' && nothing.price_cents === null && nothing.needs_price === true);
  const noFx = resolvePrice({ game: 'pokemon', graded: true, pc_value_usd: 974.76 }, cfg, null);
  assert('PC rung without FX rates degrades to needs_price (GR7)', noFx.value_source === 'needs_price');
}

console.log('\n[valueFromLadder — real slab grades]');
{
  const ladder = { 'Ungraded': 97476, 'Grade 9': 500000, 'PSA 10': 25296207, 'BGS 10': 30000000 };
  assert('PSA 10 rung', valueFromLadder(ladder, 'PSA', 10).cents === 25296207);
  assert('BGS 10 rung', valueFromLadder(ladder, 'BGS', 10).cents === 30000000);
  const tag = valueFromLadder(ladder, 'TAG', 10);   // no TAG rung → cross-company 10 fallback
  assert('TAG 10 falls back to a cross-company 10 rung', tag && tag.cents > 0 && /10/.test(tag.label), JSON.stringify(tag));
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL GRADED CHECKS PASSED');
process.exit(failures ? 1 : 0);
