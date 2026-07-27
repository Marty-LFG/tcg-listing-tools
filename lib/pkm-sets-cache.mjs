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
