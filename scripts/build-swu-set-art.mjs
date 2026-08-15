// scripts/build-swu-set-art.mjs — bake the SWU set roster + printed denominators from the
// OFFICIAL site API (the same Strapi backend starwarsunlimited.com/cards reads).
//
// WHY THE OFFICIAL API: swu-db's per-set `total_cards` counts the whole roster INCLUDING variant
// reprints (SOR: 946), while the card face prints `010/252` — the official card payload's
// `cardCount` is that printed denominator. There is no /api/expansions route; instead card #1 of
// every set is fetched in one page (filters[cardNumber][$eq]=1) and each carries its expansion
// (name, code) + cardCount. Set symbols/logos are NOT here — the media kit is a JS app — so the
// rail shows the boxed set-code badge instead (print-faithful: SWU cards print the code).
//
// The API answers anonymously but expects browser-ish headers (Origin/Referer) — kept identical
// to what the official site sends.
//
//   node scripts/build-swu-set-art.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normName } from './build-pokemon-set-symbols.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const OUT_PATH = path.join(ROOT, 'data', 'swu-set-art.json');
const API = 'https://admin.starwarsunlimited.com/api';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 TCGListingTools/1.0 (Binders Keepers set index)',
  Origin: 'https://starwarsunlimited.com',
  Referer: 'https://starwarsunlimited.com/',
};

export const INDEX_FORMAT = 1;

// Every set's card #1, one page. Variants of card 1 may repeat an expansion; the LARGEST
// cardCount per set wins (a variant batch can carry a smaller sub-count, never a larger one).
export function rosterFromCards(data) {
  const bySet = {};
  for (const row of data || []) {
    const a = row && row.attributes;
    const exp = a && a.expansion && a.expansion.data && a.expansion.data.attributes;
    if (!exp || !exp.code) continue;
    const total = parseInt(String(a.cardCount), 10) || null;
    const cur = bySet[exp.code];
    if (!cur || (total && total > (cur.printedTotal || 0))) {
      bySet[exp.code] = { name: exp.name || exp.code, code: String(exp.code).toUpperCase(), printedTotal: total || undefined };
    }
  }
  return Object.values(bySet);
}

export async function buildSwuSetArt({ dryRun = false, log = () => {} } = {}) {
  const url = API + '/cards?locale=en&filters[cardNumber][$eq]=1&pagination[pageSize]=100';
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('official SWU API HTTP ' + r.status);
  const j = await r.json();
  const roster = rosterFromCards(j.data);
  if (!roster.length) throw new Error('official SWU API returned no expansions — payload shape changed?');

  const sets = {};
  for (const s of roster) {
    const entry = { name: s.name, code: s.code };
    if (s.printedTotal) entry.printedTotal = s.printedTotal;
    for (const k of [normName(s.name), normName(s.code)]) if (k && !sets[k]) sets[k] = entry;
    log(`  ${s.code}: ${s.name} /${s.printedTotal || '?'}`);
  }
  const doc = { format: INDEX_FORMAT, builtAt: new Date().toISOString(), source: API, game: 'swu', count: roster.length, sets };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    const tmp = OUT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 0));
    fs.renameSync(tmp, OUT_PATH);
  }
  return { summary: `${roster.length} sets, ${roster.filter((s) => s.printedTotal).length} with printed totals`, count: roster.length, path: path.relative(ROOT, OUT_PATH) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dryRun = process.argv.includes('--dry-run');
  const r = await buildSwuSetArt({ dryRun, log: (s) => console.log(s) });
  console.log(r.summary + (dryRun ? '  [dry run — nothing written]' : ' → ' + r.path));
}
