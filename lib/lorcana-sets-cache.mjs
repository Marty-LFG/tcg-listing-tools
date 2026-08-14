// lib/lorcana-sets-cache.mjs — Lorcana's set list, fetched once and kept.
//
// /api/lorcana/sets was a bare pass-through to Lorcast, so every load of the builder hit the network
// for the list, and nothing SERVER-side could read it at all. Three things need it: the Collectr
// import (to resolve a typed set name to a code), composeMetaFor (so a Lorcana row stops falling
// into the Pokémon set-identity path), and the stock adapter's set picker.
//
// Modelled on lib/mtg-sets-cache.mjs, which is the same job against Scryfall. Four differences, all
// forced by Lorcast rather than chosen:
//
//   · THE LIST IS `results`, NOT `data`. Scryfall wraps in {data:[...]}, Lorcast in {results:[...]}.
//     Every completeness gate and reader here keys on `results`, and the body is stored VERBATIM
//     because lorcana-listing-builder.html loadSets() already reads that shape.
//   · THERE IS NO PAGINATION. Lorcast answers /sets in one response with no cursor and no has_more,
//     so there is no page walk to guard — which also means the ONLY way to get a short list is for
//     upstream to hand back a short list, and that is what isCompleteSetList refuses to store.
//   · SET OBJECTS CARRY NO ICON AND NO CARD COUNT — only id, name, code, released_at and
//     prereleased_at. So findLorcanaSet cannot answer a setSymbolUrl the way findMtgSet can, and
//     composeMetaFor leaves the rail's symbol slot empty rather than constructing a URL from the
//     code (AGENTS.md 19's placeholder trap, GR4). Card counts come from the cached set-cards files.
//   · Lorcast asks for 50-100ms between requests and explicitly says to cache for at least 24h.
//     One request per 6 hours is well inside that.
//
// `code` is the set id used EVERYWHERE else in this repo — '1'…'13' plus the promo codes ('P1',
// 'P2', 'P3', 'D23', 'DIS', 'C2', 'cp', 'Coconut', 'PD1'). It is what /api/lorcana/sets/:id/cards
// takes and what identity_key is built from, so it is the `id` this module reports too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normSetKey } from './pkm-sets-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_DIR = 'LORCANA_SETS_CACHE_DIR';
// Read per call, never once at import — same reason as lib/set-cache.mjs cacheDir().
const cacheDir = () => process.env[ENV_DIR] || path.join(ROOT, 'data', 'lorcana-cache');
const cachePath = () => path.join(cacheDir(), 'sets.json');

const UPSTREAM = 'https://api.lorcast.com/v0/sets';
const MEM_TTL_MS = 6 * 60 * 60 * 1000;   // Lorcana gains a set every ~3 months; Lorcast asks for 24h
const ATTEMPTS = 3;
const TIMEOUT_MS = 12000;

let _mem = null;                          // { at:ISO, body } — last good, this process

// ---- pure decisions (exported for the unit suite) --------------------------------
// A body is only worth caching when it is a WHOLE list. A re-indexing upstream answering 200 with
// results:[] would otherwise blank the set picker for the whole TTL. There is no has_more to check
// here — Lorcast sends the lot in one response — so "complete" is "we got sets", the same weaker
// gate lib/lorcana-cards-cache.mjs documents for the same reason.
export function isCompleteSetList(body) {
  const list = body && Array.isArray(body.results) ? body.results : null;
  return !!(list && list.length);
}

export function decideSetsResponse(fresh, lastGood, nowIso) {
  if (isCompleteSetList(fresh)) return { store: true, status: 200, body: { ...fresh, stale: false, cached: false, cachedAt: nowIso } };
  const cached = lastGood && lastGood.body && Array.isArray(lastGood.body.results) && lastGood.body.results.length ? lastGood : null;
  if (cached) return { store: false, status: 200, body: { ...cached.body, stale: true, cached: true, cachedAt: cached.at } };
  return { store: false, status: 502, body: { error: 'Lorcast is unreachable and no set list is cached', code: 'upstream_unreachable', stale: true, results: [] } };
}

// ---- disk cache ------------------------------------------------------------------
export function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    return j && j.body && Array.isArray(j.body.results) && j.body.results.length ? j : null;
  } catch { return null; }
}
function writeCache(entry) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(entry));
  } catch (e) { console.warn('[api/lorcana/sets] cache write failed —', e?.message || e); }
}

// ---- findLorcanaSet --------------------------------------------------------------
// SYNC, off the disk cache, for composeMetaFor and the Collectr resolver. Reuses normSetKey rather
// than writing a fourth normaliser (AGENTS.md 19 — byte-identical near-copies).
//
// A cold cache returns null, never a throw: no set means a rail without set art, not a failed
// listing (GR7).
let _index = null, _indexFrom = null;
function setIndex() {
  const cache = readCache();
  if (!cache) { _index = null; _indexFrom = null; return null; }
  if (_index && _indexFrom === cache.at) return _index;
  const byCode = new Map(), byName = new Map();
  for (const s of cache.body.results) {
    if (!s) continue;
    // Lorcast's codes are case-mixed ('cp', 'D23', 'PD1'), and the builder stores whatever the user
    // picked, so both sides are lowered before they meet.
    if (s.code) byCode.set(String(s.code).toLowerCase(), s);
    if (s.name) { const k = normSetKey(s.name); if (k && !byName.has(k)) byName.set(k, s); }
  }
  _index = { byCode, byName };
  _indexFrom = cache.at;
  return _index;
}

export function findLorcanaSet({ code, name } = {}) {
  const idx = setIndex();
  if (!idx) return null;
  const c = String(code == null ? '' : code).trim().toLowerCase();
  if (c && idx.byCode.has(c)) return idx.byCode.get(c);
  const n = normSetKey(name);
  if (n && idx.byName.has(n)) return idx.byName.get(n);
  // A stored display name may carry a "(TFC)" decoration the way the builder's fixtures do; try it
  // stripped too, exactly as findMtgSet does for "(HOB)".
  const stripped = normSetKey(String(name == null ? '' : name).replace(/\s*\([^)]*\)\s*$/, ''));
  if (stripped && idx.byName.has(stripped)) return idx.byName.get(stripped);
  return null;
}

// Every set, newest first — the shape the Collectr resolver's set index and the bulk picker want.
// `id` is the CODE, not Lorcast's `set_…` uuid: that is what /api/lorcana/sets/:id/cards takes and
// what identity_key is built from, and an id the resolver cannot round-trip is worse than none.
export function listLorcanaSets() {
  const cache = readCache();
  const list = cache && cache.body && Array.isArray(cache.body.results) ? cache.body.results : null;
  if (!list) return [];
  return list.filter((s) => s && s.code)
    .map((s) => ({ id: String(s.code), name: s.name || '', code: String(s.code), releaseDate: s.released_at || '' }))
    .sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate)));
}

// ---- upstream ----------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchSets() {
  const headers = { Accept: 'application/json', 'User-Agent': 'TCGListingBuilder/1.0' };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(UPSTREAM, { headers, signal: ac.signal });
      const text = await r.text();
      if (r.ok) { try { return JSON.parse(text); } catch { /* HTML error page dressed as 200 */ } }
      else console.warn('[api/lorcana/sets]', r.status, 'attempt', attempt + '/' + ATTEMPTS);
    } catch (e) {
      console.warn('[api/lorcana/sets] attempt', attempt + '/' + ATTEMPTS, '—', e?.message || e);
    } finally { clearTimeout(timer); }
    if (attempt < ATTEMPTS) await sleep(300 * attempt);
  }
  return null;
}

// ---- plugin ----------------------------------------------------------------------
// Claims the EXACT collection path only. connect strips the mount path, so anything deeper
// (/api/lorcana/sets/1, /api/lorcana/sets/1/cards) arrives with a non-'/' url and falls through to
// the Lorcast proxy — which is what serves the per-set card list the enumerator's fallback walks.
export function lorcanaSetsPlugin() {
  return {
    name: 'lorcana-sets-cache',
    configureServer(server) {
      server.middlewares.use('/api/lorcana/sets', async (req, res, next) => {
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
        else if (d.status === 200 && d.body.stale) console.warn('[api/lorcana/sets] Lorcast is down — serving the cached list from', d.body.cachedAt);
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
