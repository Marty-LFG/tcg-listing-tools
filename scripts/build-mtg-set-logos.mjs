// scripts/build-mtg-set-logos.mjs — bake MTG set WORDMARKS from mtg.fandom.com.
//
// WHY: the rail's left slot wants the set's logo, and Scryfall publishes only the SYMBOL
// (icon_svg_uri). The MTG wiki carries per-set wordmarks under a `<Set>_logo.png|jpg` convention
// on each set's own page (`Bloomburrow_logo.jpg`, `Neon_Dynasty_logo.png` — verified 2026-08-15).
//
// SCOPE: only the sets the store actually touches — the keys of data/mtg-cards/ (the card cache
// fills when a set is listed or looked up), merged over the existing index so coverage accretes
// and a wiki hiccup never deletes an entry. Coverage is expected to be PARTIAL (some pages name
// their logo differently, e.g. LTR); every miss falls back to the game logo on the rail.
//
//   node scripts/build-mtg-set-logos.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normName } from './build-pokemon-set-symbols.mjs';
import { fetchSetLogo, politePause } from './fandom-set-logos.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const OUT_PATH = path.join(ROOT, 'data', 'mtg-set-art.json');
const CARDS_DIR = path.join(ROOT, 'data', 'mtg-cards');
const WIKI = 'https://mtg.fandom.com';

export const INDEX_FORMAT = 1;

// The store's active MTG sets: one entry per data/mtg-cards/<code>.json, named off its own cards.
export function activeSets() {
  let files = [];
  try { files = fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const sets = [];
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(CARDS_DIR, f), 'utf8'));
      const card = (doc.cards || [])[0];
      if (card && card.set_name) sets.push({ code: (doc.setId || f.replace(/\.json$/, '')).toUpperCase(), name: card.set_name });
    } catch { /* one bad cache file must not stop the bake */ }
  }
  return sets;
}

export async function buildMtgSetLogos({ dryRun = false, log = () => {} } = {}) {
  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')).sets || {}; } catch { return {}; }
  })();
  const sets = { ...existing };
  let added = 0, missed = 0, kept = Object.keys(existing).length;
  for (const s of activeSets()) {
    const key = normName(s.name);
    if (sets[key]) continue;                       // accretive: never re-fetch or overwrite a hit
    const logo = await fetchSetLogo(WIKI, s.name);
    await politePause();
    if (!logo) { missed++; log(`  miss: ${s.name}`); continue; }
    const entry = { name: s.name, code: s.code, logoUrl: logo.url };
    sets[key] = entry;
    const codeKey = normName(s.code);
    if (codeKey && !sets[codeKey]) sets[codeKey] = entry;
    added++;
    log(`  + ${s.name} -> ${logo.file}`);
  }
  const doc = { format: INDEX_FORMAT, builtAt: new Date().toISOString(), source: WIKI, game: 'mtg', count: Object.keys(sets).length, sets };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    const tmp = OUT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 0));
    fs.renameSync(tmp, OUT_PATH);
  }
  return { summary: `${added} added, ${missed} missing on the wiki, ${kept} kept`, added, missed, path: path.relative(ROOT, OUT_PATH) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dryRun = process.argv.includes('--dry-run');
  const r = await buildMtgSetLogos({ dryRun, log: (s) => console.log(s) });
  console.log(r.summary + (dryRun ? '  [dry run — nothing written]' : ' → ' + r.path));
}
