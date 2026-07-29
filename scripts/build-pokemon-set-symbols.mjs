// scripts/build-pokemon-set-symbols.mjs — bake a set-name → symbol-image map from Bulbapedia.
//
// WHY THIS EXISTS. The listing-image compositor draws a set symbol on the rail. English sets get one
// from the pokemontcg.io cache (images.scrydex.com), but there is no keyless CDN carrying JAPANESE
// set symbols — checked and ruled out:
//   · TCGdex        — only old shared "univ" symbols (neo/xy/bw); every modern JP set 404s.
//   · images.scrydex.com — JP ids are simply absent, and it answers 200 with a 186KB GENERIC
//                     PLACEHOLDER for anything it does not have, so a constructed URL silently
//                     puts a grey blob on the rail rather than failing. See PLACEHOLDER_SHA below.
// Bulbapedia's expansion lists carry them all, named `SetSymbol<Name>.png` — a convention that maps
// straight onto the romanised set name the intl bake already stores as `name_en`.
//
// Kept in its OWN file rather than folded into data/pokemon-intl-sets.json, because that file is
// regenerated wholesale by build-pokemon-intl-sets.mjs and would wipe the symbols on every refresh.
//
// This resolves URLs only — a few batched API calls, no image downloads. The images themselves are
// fetched lazily at compose time through lib/img-cache.mjs, which caches them to disk for 30 days.
//
//   node scripts/build-pokemon-set-symbols.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const OUT_PATH = path.join(ROOT, 'data', 'pokemon-set-symbols.json');

const BULBAPEDIA = 'https://bulbapedia.bulbagarden.net/w/api.php';
// Bulbapedia's files live on the shared Archives wiki — imageinfo against Bulbapedia itself reports
// every one of them missing, which is what made the first attempt at this look like a dead end.
const ARCHIVES = 'https://archives.bulbagarden.net/w/api.php';
const UA = { 'User-Agent': 'TCGListingTools/1.0 (Binders Keepers listing images; set symbol index)' };

const PAGES = [
  ['ja', 'List_of_Japanese_Pokémon_Trading_Card_Game_expansions'],
  ['en', 'List_of_Pokémon_Trading_Card_Game_expansions'],
];

// Same normalisation the lookup uses: unicode-aware, so a name is matched on its letters alone.
export const normName = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// `SetSymbolAbyss_Eye.png` → `Abyss Eye`. A leading underscore appears on a few (`SetSymbol_SMPromo`).
export function setNameFromFile(file) {
  const m = String(file).match(/^SetSymbol_?(.+)\.(png|gif|jpg)$/i);
  return m ? m[1].replace(/_/g, ' ').trim() : null;
}

async function api(base, params) {
  const url = base + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${base} HTTP ${r.status}`);
  return r.json();
}

export async function listSymbolFiles(page) {
  const j = await api(BULBAPEDIA, { action: 'parse', page, prop: 'images' });
  return ((j.parse && j.parse.images) || []).filter((n) => /^SetSymbol/i.test(n));
}

// imageinfo caps at 50 titles per call, so batch.
export async function resolveUrls(files) {
  const out = new Map();
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const j = await api(ARCHIVES, { action: 'query', prop: 'imageinfo', iiprop: 'url|size', titles: batch.map((f) => 'File:' + f).join('|') });
    for (const p of (j.query && j.query.pages) || []) {
      const ii = p.imageinfo && p.imageinfo[0];
      if (p.missing || !ii || !ii.url) continue;
      const file = String(p.title).replace(/^File:/, '').replace(/ /g, '_');
      out.set(file, { url: ii.url, width: ii.width, height: ii.height });
    }
  }
  return out;
}

export async function buildSetSymbols({ dryRun = false, log = () => {} } = {}) {
  const symbols = {};
  const perPage = {};
  for (const [lang, page] of PAGES) {
    const files = await listSymbolFiles(page);
    const urls = await resolveUrls(files);
    let added = 0, missed = 0;
    for (const f of files) {
      const name = setNameFromFile(f);
      const hit = urls.get(f);
      if (!name || !hit) { missed++; continue; }
      const key = normName(name);
      if (!key) { missed++; continue; }
      // First page wins: Japanese is listed first on purpose, because where a name collides the
      // JP symbol is the one we cannot get anywhere else.
      if (!symbols[key]) { symbols[key] = { name, url: hit.url, w: hit.width, h: hit.height, lang }; added++; }
    }
    perPage[lang] = { files: files.length, added, missed };
    log(`  ${lang}: ${files.length} symbol files · ${added} indexed · ${missed} unresolved`);
  }
  const doc = { builtAt: new Date().toISOString(), source: 'bulbapedia.bulbagarden.net + archives.bulbagarden.net', count: Object.keys(symbols).length, symbols };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    const tmp = OUT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 0));
    fs.renameSync(tmp, OUT_PATH);
  }
  return { summary: `${doc.count} set symbols indexed`, count: doc.count, perPage, path: path.relative(ROOT, OUT_PATH) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dryRun = process.argv.includes('--dry-run');
  const r = await buildSetSymbols({ dryRun, log: (s) => console.log(s) });
  console.log(r.summary + (dryRun ? '  [dry run — nothing written]' : ' → ' + r.path));
}
