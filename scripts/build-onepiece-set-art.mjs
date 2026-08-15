// scripts/build-onepiece-set-art.mjs — bake the One Piece set roster (name ↔ code) from optcgapi.
//
// One Piece needs the LEAST from its bake: cards print no set symbol (the full card code
// `OP01-120` is the badge) and no wordmark source exists keyless, so the rail wears the game
// logo. What compose-time DOES need is a server-side name↔code join — inventory rows store
// `"Romance Dawn (OP-01)"` and the builder's set list lives only in the page — so this is that
// join, in the same doc shape as the other games' set-art bakes.
//
//   node scripts/build-onepiece-set-art.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normName } from './build-pokemon-set-symbols.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const OUT_PATH = path.join(ROOT, 'data', 'onepiece-set-art.json');
const API = 'https://optcgapi.com/api';
const UA = { 'User-Agent': 'TCGListingTools/1.0 (Binders Keepers set index)' };

export const INDEX_FORMAT = 1;

export async function buildOnepieceSetArt({ dryRun = false, log = () => {} } = {}) {
  const r = await fetch(API + '/allSets/', { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('optcgapi HTTP ' + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('optcgapi /allSets/ returned no sets');

  const sets = {};
  let count = 0;
  for (const row of rows) {
    const name = row && row.set_name, code = row && row.set_id;
    if (!name || !code) continue;
    const entry = { name, code: String(code).toUpperCase() };
    let any = false;
    for (const k of [normName(name), normName(code)]) if (k && !sets[k]) { sets[k] = entry; any = true; }
    if (any) count++;
    log(`  ${entry.code}: ${name}`);
  }
  const doc = { format: INDEX_FORMAT, builtAt: new Date().toISOString(), source: API, game: 'onepiece', count, sets };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    const tmp = OUT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 0));
    fs.renameSync(tmp, OUT_PATH);
  }
  return { summary: `${count} sets indexed`, count, path: path.relative(ROOT, OUT_PATH) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dryRun = process.argv.includes('--dry-run');
  const r = await buildOnepieceSetArt({ dryRun, log: (s) => console.log(s) });
  console.log(r.summary + (dryRun ? '  [dry run — nothing written]' : ' → ' + r.path));
}
