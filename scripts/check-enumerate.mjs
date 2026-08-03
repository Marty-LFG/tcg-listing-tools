// scripts/check-enumerate.mjs — set-enumeration harness (AGENTS.md §8) with a
// stubbed fetch: (1) a card enumerated twice yields byte-identical
// (identity_key, variant) tuples — the dedupe invariant uq_inv_bulk_identity
// relies on; (2) the printing matrix comes from tcgplayer.prices keys incl.
// 1st Edition vintage keys; (3) a failing page degrades to partial rows +
// warnings, never a throw (GR7).
// Run: node --disable-warning=ExperimentalWarning scripts/check-enumerate.mjs
//
// The Pokémon enumerator reads lib/pkm-cards-cache.mjs now instead of paging pokemontcg.io itself,
// so this points that cache at a throwaway folder before importing anything. Without it the stubbed
// Charizard below would be written into the real cache as the whole of base1 — and that cache never
// expires, so it would still be there next month.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-enum-check-'));
process.env.PKM_CARDS_CACHE_DIR = TMP;
const { ENUMERATORS, rarityFilterClass } = await import('../lib/enumerate.mjs');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

const PAGE1 = {
  totalCount: 3,
  data: [
    { id: 'base1-4', name: 'Charizard', number: '4', rarity: 'Rare Holo',
      set: { id: 'base1', name: 'Base', printedTotal: 102 },
      images: { small: 's', large: 'https://images.pokemontcg.io/base1/4_hires.png' },
      tcgplayer: { prices: { holofoil: { market: 641.27 }, '1stEditionHolofoil': { market: 3200 }, unlimitedHolofoil: { market: 640 } } } },
    { id: 'base1-58', name: 'Pikachu', number: '58', rarity: 'Common',
      set: { id: 'base1', name: 'Base', printedTotal: 102 },
      images: { small: 's', large: 'l' },
      tcgplayer: { prices: { normal: { market: 6.95 }, '1stEditionNormal': { market: 45 } } } },
    { id: 'base1-96', name: 'Potion', number: '96', rarity: 'Common',
      set: { id: 'base1', name: 'Base', printedTotal: 102 },
      images: { small: 's', large: 'l' } },   // NO tcgplayer prices → heuristic single row
  ],
};

// text(), because the cache reads the body as text and parses it itself (an HTML error page dressed
// as a 200 is a thing pokemontcg.io does, and JSON.parse is where that gets caught).
function stubFetch(behaviour) {
  return async (url) => {
    if (behaviour === 'fail-page') return { ok: false, status: 500, text: async () => 'upstream is unwell' };
    return { ok: true, status: 200, text: async () => JSON.stringify(PAGE1) };
  };
}

async function run(behaviour, filters) {
  const rows = [], warnings = [];
  globalThis.fetch = stubFetch(behaviour);
  // A fresh cache per run: these checks are about what the ENUMERATOR does with the cards, so each
  // one starts cold rather than reading what the previous check happened to store.
  try { fs.rmSync(path.join(TMP, 'base1.json')); } catch {}
  for await (const out of ENUMERATORS.pokemon({ base: 'http://stub', env: {}, setId: 'base1', filters })) {
    if (out.warning) warnings.push(out.warning);
    if (out.row) rows.push(out.row);
  }
  return { rows, warnings };
}

const realFetch = globalThis.fetch;
try {
  console.log('\n[printing matrix]');
  const a = await run();
  assert('6 rows from 3 cards (3 chz printings + 2 pika + 1 potion heuristic)', a.rows.length === 6, String(a.rows.length));
  const chz = a.rows.filter((r) => r.identity_key === 'base1-4');
  assert('Charizard: Holo + 1st Ed Holo distinct variants', new Set(chz.map((r) => r.variant)).size === 2, JSON.stringify(chz.map((r) => r.variant)));
  assert('1stEditionHolofoil → edition + variant token', chz.some((r) => r.edition === '1st Edition' && r.variant === '1st Edition Holo'));
  assert('unlimitedHolofoil collapses to Holo (same identity variant)', chz.filter((r) => r.variant === 'Holo').length === 2, 'the /batches upsert dedupes these');
  const pika = a.rows.filter((r) => r.identity_key === 'base1-58');
  assert('Pikachu: Base + 1st Edition', pika.some((r) => r.variant === 'Base') && pika.some((r) => r.variant === '1st Edition'));
  assert('numbers carry /printedTotal', pika[0].number === '58/102', pika[0].number);
  assert('no-price card still yields a listable row (GR7)', a.rows.some((r) => r.identity_key === 'base1-96' && r.market_usd === null));

  console.log('\n[determinism]');
  const b = await run();
  const tuple = (rows) => JSON.stringify(rows.map((r) => [r.identity_key, r.variant, r.printing_key]));
  assert('two runs → byte-identical (identity_key, variant) tuples', tuple(a.rows) === tuple(b.rows));

  console.log('\n[filters]');
  const c = await run(undefined, { rarities: ['common'] });
  assert('rarity filter keeps only commons', c.rows.every((r) => /common/i.test(r.rarity)) && c.rows.length > 0);
  assert("rarityFilterClass('Uncommon') !== 'common' (substring trap)", rarityFilterClass('Uncommon') === 'uncommon');

  console.log('\n[GR7 degradation]');
  const d = await run('fail-page');
  assert('failed page → zero rows + warning, no throw', d.rows.length === 0 && d.warnings.length === 1, JSON.stringify(d.warnings));
} finally {
  globalThis.fetch = realFetch;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL ENUMERATE CHECKS PASSED');
process.exit(failures ? 1 : 0);
