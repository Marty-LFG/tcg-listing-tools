// scripts/build-psa-set-map.mjs — bake data/psa-set-map.json from pokemontcg.io /sets.
//
// PSA prints its own set/brand names on the slab ("POKEMON ROCKET", "POKEMON SWORD & SHIELD
// BRILLIANT STARS") which often DON'T match pokemontcg.io's set names ("Team Rocket",
// "Brilliant Stars"). The inventory image resolver uses this map to prefer the right printing
// when a name+number search returns cards from several sets (lib/inventory.mjs pickPkmCard).
//
// Output shape:
//   { generatedAt, byName: { "<UPPERCASE PTCG SET NAME>": "<setId>" },
//     aliases:      { "<PSA PHRASE, 'POKEMON ' STRIPPED, UPPER>": "<setId>" } }
//
// byName is generated from the live set list (so new sets are covered automatically); aliases
// are the hand-curated PSA-specific names that don't contain the ptcg name. Run: node scripts/build-psa-set-map.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'data', 'psa-set-map.json');

// PSA brand phrases (uppercased, leading "POKEMON " stripped) whose name doesn't contain the
// pokemontcg.io set name, so the substring match can't find them. id = pokemontcg.io set id.
const ALIASES = {
  'GAME': 'base1',                 // PSA calls Base Set "POKEMON GAME"
  'GAME 1ST EDITION': 'base1',
  'ROCKET': 'base5',               // PSA calls Team Rocket "POKEMON ROCKET"
  'ROCKET 1ST EDITION': 'base5',
  'BASE SET': 'base1',
  'BLACK STAR PROMO': 'basep',
  'WIZARDS BLACK STAR PROMO': 'basep',
  'LC': 'base6',                   // Legendary Collection
};

async function main() {
  const r = await fetch('https://api.pokemontcg.io/v2/sets?pageSize=250&orderBy=releaseDate');
  if (!r.ok) throw new Error('sets fetch failed: HTTP ' + r.status);
  const sets = (await r.json()).data || [];
  const byName = {};
  for (const s of sets) {
    const key = String(s.name || '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (key && byName[key] === undefined) byName[key] = s.id;   // first (oldest) wins on a dup name
  }
  const out = { generatedAt: new Date().toISOString().slice(0, 10), setCount: sets.length, byName, aliases: ALIASES };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log('wrote', OUT, '·', Object.keys(byName).length, 'sets +', Object.keys(ALIASES).length, 'aliases');
}
main().catch((e) => { console.error(e); process.exit(1); });
