// scripts/build-lorcana-set-art.mjs — bake Lorcana set WORDMARKS + printed totals.
//
// TWO gaps, one bake. Lorcast publishes no set art and no printed totals, and Lorcana cards print
// no set symbol at all — their identity line is `42/204 · EN · 1`. So the rail wants:
//   · the set's wordmark (left slot) — lorcana.fandom.com carries `<Set>_logo.jpg|png` on each
//     set's page (`The_First_Chapter_logo.jpg`, verified 2026-08-15);
//   · the printed DENOMINATOR (badge) — derivable from the card files we already cache: the max
//     collector_number across BASE rarities. Enchanted/Epic/Iconic chase cards are numbered PAST
//     the printed total (TFC: Enchanted run 205–216 but cards print /204), so they are excluded.
//     Verified against sets 1/6/9/13 → 204/204/204/207.
//
//   node scripts/build-lorcana-set-art.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normName } from './build-pokemon-set-symbols.mjs';
import { fetchSetLogo, politePause } from './fandom-set-logos.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const OUT_PATH = path.join(ROOT, 'data', 'lorcana-set-art.json');
const SETS_CACHE = path.join(ROOT, 'data', 'lorcana-cache', 'sets.json');
const CARDS_DIR = path.join(ROOT, 'data', 'lorcana-cards');
const WIKI = 'https://lorcana.fandom.com';

export const INDEX_FORMAT = 1;

// Rarities that live INSIDE the printed numbering. Lorcast spells them capitalised with
// underscores ('Super_rare'); compared case-folded so a casing drift cannot silently shrink a set.
const BASE_RARITIES = new Set(['common', 'uncommon', 'rare', 'super_rare', 'legendary']);

export function printedTotalOf(cards) {
  let max = 0;
  for (const c of cards || []) {
    const r = String(c.rarity || '').toLowerCase();
    if (!BASE_RARITIES.has(r)) continue;
    const n = parseInt(String(c.collector_number), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max || null;
}

export function lorcastSets() {
  try {
    const doc = JSON.parse(fs.readFileSync(SETS_CACHE, 'utf8'));
    return ((doc.body && doc.body.results) || []).map((s) => ({ code: String(s.code), name: s.name }));
  } catch { return []; }
}

export async function buildLorcanaSetArt({ dryRun = false, log = () => {} } = {}) {
  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')).sets || {}; } catch { return {}; }
  })();
  const sets = {};
  let logos = 0, totals = 0, missed = 0;
  for (const s of lorcastSets()) {
    const key = normName(s.name);
    if (!key) continue;
    const prev = existing[key] || {};
    const entry = { name: s.name, code: s.code };

    // Totals re-derive every run (a set's card file grows as Lorcast catalogues it).
    try {
      const file = JSON.parse(fs.readFileSync(path.join(CARDS_DIR, s.code + '.json'), 'utf8'));
      const total = printedTotalOf(file.cards);
      if (total) { entry.printedTotal = total; totals++; }
    } catch { /* set not cached on this host — no denominator, no drama */ }

    // Logos are accretive: a wiki hiccup keeps last run's URL.
    if (prev.logoUrl) { entry.logoUrl = prev.logoUrl; logos++; }
    else {
      const logo = await fetchSetLogo(WIKI, s.name);
      await politePause();
      if (logo) { entry.logoUrl = logo.url; logos++; log(`  + ${s.name} -> ${logo.file}`); }
      else { missed++; log(`  miss: ${s.name}`); }
    }

    sets[key] = entry;
    const codeKey = normName(s.code);
    if (codeKey && !sets[codeKey]) sets[codeKey] = entry;
  }
  if (!Object.keys(sets).length) throw new Error('no Lorcana sets resolved (is data/lorcana-cache/sets.json present?)');
  const doc = { format: INDEX_FORMAT, builtAt: new Date().toISOString(), source: WIKI + ' + data/lorcana-cards', game: 'lorcana', count: Object.keys(sets).length, sets };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    const tmp = OUT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 0));
    fs.renameSync(tmp, OUT_PATH);
  }
  return { summary: `${logos} logos, ${totals} printed totals, ${missed} logo misses`, logos, totals, missed, path: path.relative(ROOT, OUT_PATH) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dryRun = process.argv.includes('--dry-run');
  const r = await buildLorcanaSetArt({ dryRun, log: (s) => console.log(s) });
  console.log(r.summary + (dryRun ? '  [dry run — nothing written]' : ' → ' + r.path));
}
