// lib/mtg-sets-cache.mjs — Magic's set list, fetched once and kept.
//
// /api/mtg/sets was a bare pass-through to Scryfall, so every load of the builder hit the network
// for a 600KB list, and nothing SERVER-side could read the set list at all. Three things need it:
// the Collectr import (to resolve a typed set name to a code), composeMetaFor (for the set's icon),
// and any future enumerator.
//
// Modelled on lib/pkm-sets-cache.mjs, with three deliberate differences:
//
//   · The body is stored VERBATIM. mtg-listing-builder.html loadSets() reads Scryfall's own shape
//     ({data:[{code,name,icon_svg_uri,digital,released_at}]}), and re-shaping it here would mean
//     changing the builder too — for no gain, since the builder is the only browser consumer.
//   · MTG_SETS_CACHE_DIR overrides the directory. pkm-sets-cache hardcodes its path, which means a
//     test run writes into the real data/ dir; lib/set-cache.mjs already established the env-var
//     pattern for exactly this reason ("a test or a check harness points the env var at a temp
//     folder"), and a new module should not inherit the older one's gap.
//   · Scryfall asks for a descriptive User-Agent and 50-100ms between requests. /sets currently
//     answers in ONE page (has_more:false, 1047 sets), but the pagination is followed anyway
//     because a list that silently truncates at 175 would drop every recent set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normSetKey } from './pkm-sets-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_DIR = 'MTG_SETS_CACHE_DIR';
// Read per call, never once at import — same reason as lib/set-cache.mjs cacheDir().
const cacheDir = () => process.env[ENV_DIR] || path.join(ROOT, 'data', 'mtg-cache');
const cachePath = () => path.join(cacheDir(), 'sets.json');

const UPSTREAM = 'https://api.scryfall.com/sets';
const MEM_TTL_MS = 30 * 60 * 1000;    // Magic gains a set every few weeks; 30min is plenty
const ATTEMPTS = 3;
const TIMEOUT_MS = 12000;
const PAGE_GAP_MS = 100;              // Scryfall's requested courtesy delay
const MAX_PAGES = 20;

let _mem = null;                      // { at:ISO, body } — last good, this process

// ---- pure decisions (exported for the unit suite) --------------------------------
// A body is only worth caching when it is a WHOLE list. A re-indexing upstream answering 200 with
// data:[] would otherwise blank the set picker for the whole TTL, and a half-walked pagination would
// be written to a cache that never expires — losing the newest sets, which are the ones being listed.
export function isCompleteSetList(body) {
  const list = body && Array.isArray(body.data) ? body.data : null;
  if (!list || !list.length) return false;
  return body.has_more !== true;      // a body still claiming more pages is a short walk
}

export function decideSetsResponse(fresh, lastGood, nowIso) {
  if (isCompleteSetList(fresh)) return { store: true, status: 200, body: { ...fresh, stale: false, cached: false, cachedAt: nowIso } };
  const cached = lastGood && lastGood.body && Array.isArray(lastGood.body.data) && lastGood.body.data.length ? lastGood : null;
  if (cached) return { store: false, status: 200, body: { ...cached.body, stale: true, cached: true, cachedAt: cached.at } };
  if (fresh && Array.isArray(fresh.data)) return { store: false, status: 200, body: { ...fresh, stale: false, cached: false, cachedAt: nowIso, truncated: true } };
  return { store: false, status: 502, body: { error: 'Scryfall is unreachable and no set list is cached', code: 'upstream_unreachable', stale: true, data: [] } };
}

// ---- disk cache ------------------------------------------------------------------
export function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    return j && j.body && Array.isArray(j.body.data) && j.body.data.length ? j : null;
  } catch { return null; }
}
function writeCache(entry) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(entry));
  } catch (e) { console.warn('[api/mtg/sets] cache write failed —', e?.message || e); }
}

// ---- findMtgSet ------------------------------------------------------------------
// SYNC, off the disk cache, for composeMetaFor and the Collectr resolver. Reuses normSetKey rather
// than writing a third normaliser — AGENTS.md 19's warning about byte-identical near-copies applies
// as much to a key function as to a template.
//
// DIGITAL SETS ARE EXCLUDED. An Alchemy/Arena set is not a thing that can be posted in an envelope,
// and its name shares enough with the paper set it rebalances that a containment match could seat
// the wrong one. (Checked: there are no exact duplicate names across the 1047, so this is hygiene
// rather than a live collision.)
//
// A cold cache returns null, never a throw: no set means a rail without a symbol, not a failed
// listing (GR7).
let _index = null, _indexFrom = null;
function setIndex() {
  const cache = readCache();
  if (!cache) { _index = null; _indexFrom = null; return null; }
  if (_index && _indexFrom === cache.at) return _index;
  const byCode = new Map(), byName = new Map();
  for (const s of cache.body.data) {
    if (!s || s.digital) continue;
    if (s.code) byCode.set(String(s.code).toLowerCase(), s);
    if (s.name) { const k = normSetKey(s.name); if (k && !byName.has(k)) byName.set(k, s); }
  }
  _index = { byCode, byName };
  _indexFrom = cache.at;
  return _index;
}

export function findMtgSet({ code, name } = {}) {
  const idx = setIndex();
  if (!idx) return null;
  const c = String(code == null ? '' : code).trim().toLowerCase();
  if (c && idx.byCode.has(c)) return idx.byCode.get(c);
  const n = normSetKey(name);
  // The stored display name may carry the builder's "(HOB)" decoration; try it stripped too.
  if (n && idx.byName.has(n)) return idx.byName.get(n);
  const stripped = normSetKey(String(name == null ? '' : name).replace(/\s*\([^)]*\)\s*$/, ''));
  if (stripped && idx.byName.has(stripped)) return idx.byName.get(stripped);
  return null;
}

// Every paper set, newest first — the shape the Collectr resolver's set index wants.
export function listMtgSets() {
  const cache = readCache();
  const list = cache && cache.body && Array.isArray(cache.body.data) ? cache.body.data : null;
  if (!list) return [];
  return list.filter((s) => s && !s.digital)
    .map((s) => ({ id: s.code, name: s.name || '', code: String(s.code || '').toUpperCase() }));
}

// ---- upstream ----------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOne(url) {
  const headers = { Accept: 'application/json', 'User-Agent': 'TCGListingBuilder/1.0' };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers, signal: ac.signal });
      const text = await r.text();
      if (r.ok) { try { return JSON.parse(text); } catch { /* HTML error page dressed as 200 */ } }
      else console.warn('[api/mtg/sets]', r.status, 'attempt', attempt + '/' + ATTEMPTS);
    } catch (e) {
      console.warn('[api/mtg/sets] attempt', attempt + '/' + ATTEMPTS, '—', e?.message || e);
    } finally { clearTimeout(timer); }
    if (attempt < ATTEMPTS) await sleep(300 * attempt);
  }
  return null;
}

export async function fetchSets() {
  const first = await fetchOne(UPSTREAM);
  if (!first || !Array.isArray(first.data)) return null;
  const data = [...first.data];
  let body = first, page = 1;
  while (body.has_more && body.next_page && page < MAX_PAGES) {
    await sleep(PAGE_GAP_MS);
    const next = await fetchOne(String(body.next_page));
    if (!next || !Array.isArray(next.data)) return { ...first, data, has_more: true };   // short walk — never stored
    data.push(...next.data);
    body = next; page++;
  }
  return { ...first, data, has_more: false, total_cards: undefined };
}

// ---- plugin ----------------------------------------------------------------------
// Claims the EXACT collection path only. connect strips the mount path, so anything deeper
// (/api/mtg/sets/hob) arrives with a non-'/' url and falls through to the Scryfall proxy.
export function mtgSetsPlugin() {
  return {
    name: 'mtg-sets-cache',
    configureServer(server) {
      server.middlewares.use('/api/mtg/sets', async (req, res, next) => {
        const [urlPath] = String(req.url || '/').split('?');
        if (req.method !== 'GET' || (urlPath !== '/' && urlPath !== '')) return next();

        const now = new Date().toISOString();
        if (_mem && Date.now() - Date.parse(_mem.at) < MEM_TTL_MS) {
          return send(res, 200, { ..._mem.body, stale: false, cached: true, cachedAt: _mem.at }, 'memory');
        }
        const fresh = await fetchSets();
        const lastGood = _mem || readCache();
        const d = decideSetsResponse(fresh, lastGood, now);
        if (d.store) { _mem = { at: now, body: d.body }; writeCache(_mem); }
        else if (d.status === 200 && d.body.stale) console.warn('[api/mtg/sets] Scryfall is down — serving the cached list from', d.body.cachedAt);
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
