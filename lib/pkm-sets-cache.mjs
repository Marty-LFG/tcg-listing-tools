// lib/pkm-sets-cache.mjs — a resilient /api/pkm/sets that survives pokemontcg.io's flakiness.
//
// /api/pkm is otherwise a bare Vite proxy (vite.config.js) with no retry and no fallback, and
// pokemontcg.io intermittently answers HTTP 500 with an EMPTY text/html body — reproduced at 25-50%
// on 2026-07-26, where failures fast-fail in ~260ms while successes take ~2s. Every tool with a set
// picker opens on this one endpoint, so a bad upstream minute made every picker look broken and lit
// up the console with 500s that were never ours.
//
// This middleware sits in FRONT of the proxy — Vite installs plugin middlewares before its internal
// proxy middleware — and claims ONLY the exact /api/pkm/sets path. Card lookups (/api/pkm/cards/…)
// and /api/pkm/sets/{id} fall through to the proxy untouched.
//
// Behaviour (Golden Rule 7): serve a warm in-memory copy → else fetch upstream with backoff → on
// success cache to disk and serve → on failure serve the last good list flagged { stale:true } → and
// only with nothing cached at all, a 502. Never a bodyless 500, so the client can always tell
// "upstream is down" from "we crashed".
//
// ONE canonical list, cached under ONE key. The caller's query string is ignored (every picker in
// the suite asks for the same pageSize=500 anyway) and a body that is empty OR SHORTER THAN
// totalCount is never written to the cache — the two ways of "we did not actually get the list".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'pkm-cache');
const CACHE_PATH = path.join(CACHE_DIR, 'sets.json');

const UPSTREAM = 'https://api.pokemontcg.io/v2/sets';
// The ONE query this endpoint ever makes. The cache holds a single shared copy, so there is exactly
// one thing worth fetching: the whole list. See the note at the fetch site.
const CANONICAL_SEARCH = '?pageSize=500';
const MEM_TTL_MS = 30 * 60 * 1000;    // the set list gains an entry every few weeks; 30min is plenty
const ATTEMPTS = 3;
const TIMEOUT_MS = 12000;

let _mem = null;                      // { at:ISO, body } — last good, this process

// ---- pure decision (exported for the unit suite) --------------------------------
// A body is only worth CACHING when it is the whole list. Two ways it can fail that:
//   · empty — a re-indexing upstream answers 200 with data:[] (the trap catalog.mjs
//     decideCardsResponse guards), and caching it would blank every picker for the TTL
//   · truncated — data.length < totalCount, i.e. fewer sets than upstream says exist
// Both are "we did not get the list", so both are treated the same way: serve the last good copy
// instead, and never overwrite it.
export function isCompleteSetList(body) {
  const list = body && Array.isArray(body.data) ? body.data : null;
  if (!list || !list.length) return false;
  const total = body.totalCount;
  return !(typeof total === 'number' && total > 0 && list.length < total);
}
// Annotate whatever we are about to serve. `truncated` is additive and diagnostic — a short list
// flagged as complete is exactly how a near-empty set picker looks like a broken tool rather than a
// bad upstream minute.
function mark(body, extra) {
  const out = { ...body, ...extra };
  if (Array.isArray(body.data) && body.data.length && !isCompleteSetList(body)) out.truncated = true;
  return out;
}
// fresh: the upstream JSON, or null when every attempt failed. lastGood: { at, body } | null.
export function decideSetsResponse(fresh, lastGood, nowIso) {
  const list = fresh && Array.isArray(fresh.data) ? fresh.data : null;
  if (isCompleteSetList(fresh)) return { store: true, status: 200, body: mark(fresh, { stale: false, cached: false, cachedAt: nowIso }) };
  const cached = lastGood && lastGood.body && Array.isArray(lastGood.body.data) && lastGood.body.data.length ? lastGood : null;
  if (cached) return { store: false, status: 200, body: mark(cached.body, { stale: true, cached: true, cachedAt: cached.at }) };
  if (list) return { store: false, status: 200, body: mark(fresh, { stale: false, cached: false, cachedAt: nowIso }) };   // partial/empty, but it is all there is
  return { store: false, status: 502, body: { error: 'pokemontcg.io is unreachable and no set list is cached', code: 'upstream_unreachable', stale: true, data: [] } };
}

// ---- disk cache ------------------------------------------------------------------
export function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return j && j.body ? j : null;
  } catch { return null; }
}
// findSet — resolve one cached set by id, ptcgo code or name. Case- and punctuation-insensitive on
// the name, because a stock row stores the set's DISPLAY name and the cache stores pokemontcg.io's.
//
// Added for the listing-image compositor, which needs a set's SYMBOL plus the era fields
// (printedTotal / total / series / releaseDate) that Golden Rule 10's number formatter reads. Returns
// null rather than throwing on a cold cache: no set means a rail badge without a symbol, never a
// failed listing.
// Unicode-aware: strips separators and punctuation but KEEPS letters of any script. An
// ASCII-only class ([^a-z0-9]) collapsed アビスアイ to the empty string, so every Japanese set name
// matched every other one — or nothing, depending which side was blank.
//
// Latin accents are folded, because the sources disagree on them: the wiki files
// `SetSymbolPokémon_Card_151.png` while TCGdex gives us "Pokemon Card 151". The stripped range is
// U+0300–U+036F (Combining Diacritical Marks) and NOT U+3099/U+309A, so Japanese dakuten survive —
// folding those would merge ガ into カ and make メガブレイブ match a different set.
export const normSetKey = (s) => String(s == null ? '' : s)
  .trim().toLowerCase()
  // Decompose, drop LATIN combining marks (U+0300–U+036F) only, then RECOMPOSE.
  //
  // The recompose is not cosmetic. NFD turns ガ into カ + U+3099, and U+3099 is a nonspacing mark,
  // so the \p{L}\p{N} filter below would eat it — folding メガブレイブ into メカフレイフ and making
  // distinct Japanese sets collide. NFC puts ガ back together before that filter runs.
  .normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
  .replace(/[^\p{L}\p{N}]+/gu, '');
const _norm = normSetKey;
let _index = null, _indexFrom = null;

export function findSet({ id, code, name } = {}) {
  const cache = readCache();
  const list = cache && cache.body && Array.isArray(cache.body.data) ? cache.body.data : null;
  if (!list || !list.length) return null;
  // Rebuilt whenever the cached body changes (the timestamp is the cheap identity).
  if (!_index || _indexFrom !== cache.at) {
    _index = { byId: new Map(), byCode: new Map(), byName: new Map() };
    for (const s of list) {
      if (s.id) _index.byId.set(_norm(s.id), s);
      if (s.ptcgoCode) _index.byCode.set(_norm(s.ptcgoCode), s);
      if (s.name) _index.byName.set(_norm(s.name), s);
    }
    _indexFrom = cache.at;
  }
  return (id && _index.byId.get(_norm(id)))
    || (code && (_index.byCode.get(_norm(code)) || _index.byId.get(_norm(code))))
    || (name && _index.byName.get(_norm(name)))
    || null;
}

// ---- non-English sets (the baked TCGdex index) --------------------------------------------
//
// A Japanese card is not "Pitch Black #006/084". It is a DIFFERENT product: its own set (アビスアイ
// / Abyss Eye), its own symbol and its own numbering out of a different card count — the card that
// prompted this prints 102/081, a number that does not exist in the English set. Putting the English
// set's identity on a Japanese card's rail is simply wrong, and it is wrong in the way that costs a
// sale, because it is exactly what a JP collector is checking.
const INTL_PATH = path.join(ROOT, 'data', 'pokemon-intl-sets.json');
// The stock row stores a 2-letter code; the bake is keyed by TCGdex language.
const LANG_TO_INTL = { jp: 'ja', ja: 'ja', japanese: 'ja', zh: 'zh-cn', 'zh-cn': 'zh-cn', chinese: 'zh-cn', 'zh-tw': 'zh-tw', ko: 'ko', korean: 'ko' };
export const intlLangKey = (lang) => LANG_TO_INTL[String(lang || '').trim().toLowerCase()] || null;

let _intl = null, _intlAt = 0;
function loadIntl() {
  try {
    const st = fs.statSync(INTL_PATH);
    if (!_intl || st.mtimeMs !== _intlAt) { _intl = JSON.parse(fs.readFileSync(INTL_PATH, 'utf8')); _intlAt = st.mtimeMs; }
    return _intl;
  } catch { return null; }
}

/**
 * Resolve a non-English set by code or by ANY of the names it goes under — its romanised name
 * ("Abyss Eye"), its native name (アビスアイ) or the English set it corresponds to ("Pitch Black"),
 * because a stock row may have been saved from any of those. Returns null for English or an unknown
 * set, which the caller must treat as "fall back to the English index".
 */
export function findIntlSet(lang, { code, name } = {}) {
  const key = intlLangKey(lang);
  if (!key) return null;
  const idx = loadIntl();
  const list = idx && Array.isArray(idx[key]) ? idx[key] : null;
  if (!list || !list.length) return null;
  const want = _norm(code), wantName = _norm(name);
  let byName = null;
  for (const s of list) {
    if (want && (_norm(s.code) === want || _norm(s.tcgdexId) === want)) return s;
    if (!byName && wantName && (
      _norm(s.name_en) === wantName || _norm(s.name_native) === wantName
      || _norm(s.enEquivalent && s.enEquivalent.name) === wantName)) byName = s;
  }
  return byName;
}

// ---- set symbols (baked from Bulbapedia; see scripts/build-pokemon-set-symbols.mjs) --------
//
// The only source that covers JAPANESE set symbols. TCGdex carries only old shared "univ" symbols
// and images.scrydex.com has no JP ids at all — it answers 200 with a generic placeholder instead,
// which is why a constructed URL is never safe here.
const SYMBOLS_PATH = path.join(ROOT, 'data', 'pokemon-set-symbols.json');
let _symbols = null, _symbolsAt = 0;

// The shape this file understands. A v1 index is FLAT (one key space for every language), and
// reading it as v2 would silently find nothing; reading it as flat would hand English cards Japanese
// art. So an index of any other format is refused outright — the refresh bake rebuilds it, and until
// then a rail simply has no set art.
export const INDEX_FORMAT = 2;
let _warnedFormat = false;

function loadSymbolIndex() {
  try {
    const st = fs.statSync(SYMBOLS_PATH);
    if (!_symbols || st.mtimeMs !== _symbolsAt) { _symbols = JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8')); _symbolsAt = st.mtimeMs; _warnedFormat = false; }
  } catch { return null; }
  if (!_symbols || _symbols.format !== INDEX_FORMAT) {
    if (!_warnedFormat) {
      _warnedFormat = true;
      console.warn(`[pkm-sets] data/pokemon-set-symbols.json is format ${_symbols && _symbols.format ? _symbols.format : 'v1 (pre-language-scoping)'}, expected ${INDEX_FORMAT} — re-run: node scripts/build-pokemon-set-symbols.mjs`);
    }
    return null;
  }
  return _symbols;
}

// TCGdex and Bulbapedia romanise the same set differently, so an exact-name lookup misses sets we
// definitely have art for. Keyed by OUR name (as it reaches the lookup) → the wiki's.
// Deliberately a short, checked list rather than fuzzy matching: a near-miss that resolves to the
// WRONG set puts the wrong symbol on a listing, which is worse than no symbol at all.
export const SET_NAME_ALIASES = Object.freeze({
  gloryofteamrocket: 'Glory of the Rocket Gang',
  terastalfestivalex: 'Terastal Fest ex',
  pokemoncard151: '151',
  pokémoncard151: '151',
  // Our name for these is the ENGLISH set's, since the intl bake stores the equivalent; the wiki
  // romanises the Japanese one (熱風のアリーナ, 変幻の仮面).
  heatwavearena: 'Hot Wind Arena',
  maskofchange: 'Transformation Mask',
});

// Japanese sets frequently release in PAIRS that share one logo on the wiki — Ancient Roar/Future
// Flash are SV4K/SV4M against a single `SV4_Logo_JP.png`, and Mega Brave/Mega Symphonia are M1L/M1S
// against `M1_Logo_JP.png`. Stripping the trailing letters gives the base code the art is filed
// under. Only applied as a FALLBACK, so an exact match always wins.
export const baseSetCode = (code) => {
  const s = String(code == null ? '' : code).trim();
  const m = s.match(/^([A-Za-z]{1,4}\d+)[A-Za-z]{1,3}$/);
  return m ? m[1] : '';
};

// The index is LANGUAGE-SCOPED, and lookups never cross languages.
//
// A flat index let the Japanese page claim `bw1`/`xy4`/`sm7` and shadow the English file of the same
// set code — 45 of them — so an English card could be handed a JAPANESE set logo. Falling back
// across languages is not a graceful degradation here: the wrong-language logo on a listing is worse
// than no logo, because it reads as the wrong product.
const INDEX_LANG = { ja: 'ja', jp: 'ja', japanese: 'ja', en: 'en', eng: 'en', english: 'en' };
const indexLang = (lang) => INDEX_LANG[String(lang || '').trim().toLowerCase()] || 'en';

function lookup(bucket, lang, candidates) {
  const idx = loadSymbolIndex();
  const table = idx && idx[bucket] && idx[bucket][indexLang(lang)];
  if (!table) return null;
  const hit = (k) => { const v = k && table[k]; return v && v.url ? v : null; };

  // 1. exact, on every identity the caller offered
  for (const c of candidates) { const v = hit(_norm(c)); if (v) return v; }
  // 2. romanisation aliases
  for (const c of candidates) {
    const alias = SET_NAME_ALIASES[_norm(c)];
    if (alias) { const v = hit(_norm(alias)); if (v) return v; }
  }
  // 3. base code for a paired set
  for (const c of candidates) { const v = hit(_norm(baseSetCode(c))); if (v) return v; }
  return null;
}

/** findSetSymbol(lang, ...candidates) — lang is the card's, e.g. 'JP' or 'EN'. */
export function findSetSymbol(lang, ...candidates) {
  return lookup('symbols', lang, candidates);
}

/**
 * The set LOGO (wordmark). Accepts any number of candidates — a set code, a romanised name, a
 * native name — because Bulbapedia files them under a mix (`SM1_Logo.png`, `Jungle_Logo.png`,
 * `SV3a_Raging_Surf_Logo.png`, `M5_Logo_JP.png`) and a stock row may carry any of them.
 */
export function findSetLogo(lang, ...candidates) {
  return lookup('logos', lang, candidates);
}

function writeCache(entry) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(entry));
  } catch (e) { console.warn('[api/pkm/sets] cache write failed —', e?.message || e); }
}

// ---- upstream ----------------------------------------------------------------------
async function fetchSets(env, search) {
  const headers = { Accept: 'application/json', 'User-Agent': 'TCGListingBuilder/1.0' };
  if (env && env.POKEMONTCG_API_KEY) headers['X-Api-Key'] = env.POKEMONTCG_API_KEY;
  const url = UPSTREAM + (search || '');
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers, signal: ac.signal });
      const text = await r.text();
      if (r.ok) { try { return JSON.parse(text); } catch { /* HTML error page dressed as 200 */ } }
      else console.warn('[api/pkm/sets]', r.status, 'attempt', attempt + '/' + ATTEMPTS);
    } catch (e) {
      console.warn('[api/pkm/sets] attempt', attempt + '/' + ATTEMPTS, '—', e?.message || e);
    } finally { clearTimeout(timer); }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  return null;
}

// ---- plugin ----------------------------------------------------------------------
export function pkmSetsPlugin(env) {
  return {
    name: 'pkm-sets-cache',
    configureServer(server) {
      server.middlewares.use('/api/pkm/sets', async (req, res, next) => {
        // Only the collection endpoint, only GET. connect strips the mount path, so anything deeper
        // (e.g. /api/pkm/sets/sv3) arrives with a non-'/' url and belongs to the proxy.
        const [urlPath] = String(req.url || '/').split('?');
        if (req.method !== 'GET' || (urlPath !== '/' && urlPath !== '')) return next();

        const now = new Date().toISOString();
        if (_mem && Date.now() - Date.parse(_mem.at) < MEM_TTL_MS) return send(res, 200, { ..._mem.body, stale: false, cached: true, cachedAt: _mem.at }, 'memory');

        // The caller's query string is deliberately IGNORED and the canonical full list fetched
        // instead. This cache is keyed on NOTHING — one _mem slot, one file — because its whole
        // purpose is that every set picker in the suite shares one copy. Honouring the query while
        // caching the answer under a single key meant one request for ?pageSize=5 served a 5-set
        // body to every ?pageSize=500 caller for the next 30 minutes AND persisted it to disk, so
        // it survived a restart (reproduced 2026-07-27). Every in-app caller asks for pageSize=500
        // already; nothing paginates or filters this endpoint.
        const fresh = await fetchSets(env, CANONICAL_SEARCH);
        const lastGood = _mem || readCache();
        const d = decideSetsResponse(fresh, lastGood, now);
        if (d.store) { _mem = { at: now, body: d.body }; writeCache(_mem); }
        else if (d.status === 200 && d.body.stale) console.warn('[api/pkm/sets] upstream down — serving the cached list from', d.body.cachedAt);
        return send(res, d.status, d.body, d.store ? 'live' : d.status === 200 ? 'stale' : 'none');
      });
    },
  };
}

function send(res, status, body, cacheState) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-tcg-cache', cacheState);     // live | memory | stale | none
  res.end(JSON.stringify(body));
}
