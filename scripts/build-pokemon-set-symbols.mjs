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

// MUST stay identical to _norm in lib/pkm-sets-cache.mjs — the index is written with this and read
// with that, so any divergence is a lookup that silently finds nothing. Latin accents are folded
// (the wiki writes `Pokémon Card 151`, TCGdex gives us `Pokemon Card 151`); the stripped range is
// U+0300–U+036F, so Japanese dakuten (U+3099/U+309A) survive and ガ never folds into カ.
export const normName = (s) => String(s == null ? '' : s)
  .trim().toLowerCase()
  // NFD → drop Latin combining marks → NFC. The recompose matters: without it NFD leaves ガ as
  // カ + U+3099, and the \p{L}\p{N} filter eats that mark, folding メガブレイブ into メカフレイフ.
  .normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
  .replace(/[^\p{L}\p{N}]+/gu, '');

// `SetSymbolAbyss_Eye.png` → `Abyss Eye`. A leading underscore appears on a few (`SetSymbol_SMPromo`).
export function setNameFromFile(file) {
  const m = String(file).match(/^SetSymbol_?(.+)\.(png|gif|jpg)$/i);
  return m ? m[1].replace(/_/g, ' ').trim() : null;
}

// Logos use a DIFFERENT convention from symbols, and it varies by era AND carries an optional
// LANGUAGE SUFFIX:
//   `Jungle_Logo.png`              → name 'Jungle'
//   `SM1_Logo.png`                 → code 'SM1', no name
//   `SV3a_Raging_Surf_Logo.png`    → code 'SV3a', name 'Raging Surf'
//   `M5_Logo_JP.png`               → code 'M5'          ← the MEGA series, and every modern SV set
//   `Neo_Genesis_Logo_EN.png`      → name 'Neo Genesis'
//
// That `_JP`/`_EN` suffix is not a detail: matching only `_Logo.png` caught 13 of 135 English logos
// and missed the entire MEGA series, which is exactly the set the compositor is being used on.
//
// Returns { code, name } — either may be empty, but not both. Both get indexed, because a stock row
// may carry either identity.
const CODE_TOKEN = /^[A-Za-z]{1,4}\d+[A-Za-z]?$/;
export const LOGO_FILE_RE = /_logo(?:_[a-z]{2})?\.(png|gif|jpg)$/i;

export function setLogoKeysFromFile(file) {
  const m = String(file).match(/^(.+?)_logo(?:_[a-z]{2})?\.(png|gif|jpg)$/i);
  if (!m) return null;
  const parts = m[1].split('_').filter(Boolean);
  if (!parts.length) return null;
  if (CODE_TOKEN.test(parts[0])) return { code: parts[0], name: parts.slice(1).join(' ').trim() };
  return { code: '', name: parts.join(' ').trim() };
}

async function api(base, params) {
  const url = base + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${base} HTTP ${r.status}`);
  return r.json();
}

export async function listPageImages(page) {
  const j = await api(BULBAPEDIA, { action: 'parse', page, prop: 'images' });
  const all = (j.parse && j.parse.images) || [];
  return {
    symbols: all.filter((n) => /^SetSymbol/i.test(n)),
    logos: all.filter((n) => LOGO_FILE_RE.test(n)),
  };
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

// Bump when the document SHAPE changes. The lookup refuses an index it does not understand rather
// than mis-reading one, and the refresh bake rebuilds it.
export const INDEX_FORMAT = 2;

export async function buildSetSymbols({ dryRun = false, log = () => {} } = {}) {
  // LANGUAGE-SCOPED. A flat index let the Japanese page claim `bw1`/`xy4`/`sm7` and shadow the
  // English file of the same code — 45 of them — so an English card falling through to this bake
  // would have been given the JAPANESE logo. Set art is language-specific; keys are not.
  const symbols = {};
  const logos = {};
  const perPage = {};
  for (const [lang, page] of PAGES) {
    symbols[lang] = symbols[lang] || {};
    logos[lang] = logos[lang] || {};
    const { symbols: symFiles, logos: logoFiles } = await listPageImages(page);
    const urls = await resolveUrls([...symFiles, ...logoFiles]);

    let sAdded = 0, sMissed = 0;
    for (const f of symFiles) {
      const name = setNameFromFile(f);
      const hit = urls.get(f);
      const key = name ? normName(name) : '';
      if (!key || !hit) { sMissed++; continue; }
      if (!symbols[lang][key]) { symbols[lang][key] = { name, url: hit.url, w: hit.width, h: hit.height, lang }; sAdded++; }
    }

    let lAdded = 0, lMissed = 0;
    for (const f of logoFiles) {
      const keys = setLogoKeysFromFile(f);
      const hit = urls.get(f);
      if (!keys || !hit) { lMissed++; continue; }
      const entry = { name: keys.name || keys.code, url: hit.url, w: hit.width, h: hit.height, lang };
      // Indexed under BOTH the set code and the set name: `SV3a_Raging_Surf_Logo.png` has to be
      // findable from a row storing "SV3a" and from one storing "Raging Surf".
      let any = false;
      for (const k of [normName(keys.code), normName(keys.name)]) {
        if (k && !logos[lang][k]) { logos[lang][k] = entry; any = true; }
      }
      if (any) lAdded++; else lMissed++;
    }

    perPage[lang] = { symbolFiles: symFiles.length, symbols: sAdded, logoFiles: logoFiles.length, logos: lAdded };
    log(`  ${lang}: ${symFiles.length} symbol files → ${sAdded} indexed (${sMissed} skipped) · ${logoFiles.length} logo files → ${lAdded} indexed (${lMissed} skipped)`);
  }
  const total = (o) => Object.values(o).reduce((n, m) => n + Object.keys(m).length, 0);
  const doc = {
    format: INDEX_FORMAT,
    builtAt: new Date().toISOString(),
    source: 'bulbapedia.bulbagarden.net + archives.bulbagarden.net',
    count: total(symbols),
    logoCount: total(logos),
    symbols,
    logos,
  };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    const tmp = OUT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 0));
    fs.renameSync(tmp, OUT_PATH);
  }
  return { summary: `${doc.count} symbols + ${doc.logoCount} logos indexed`, count: doc.count, logoCount: doc.logoCount, perPage, path: path.relative(ROOT, OUT_PATH) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dryRun = process.argv.includes('--dry-run');
  const r = await buildSetSymbols({ dryRun, log: (s) => console.log(s) });
  console.log(r.summary + (dryRun ? '  [dry run — nothing written]' : ' → ' + r.path));
}
