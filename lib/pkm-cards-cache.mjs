// lib/pkm-cards-cache.mjs — a set's card list, fetched once and kept.
//
// WHAT THIS REPLACES: /api/pkm is a bare Vite proxy to pokemontcg.io with no cache of any kind, and
// every set load went through it — paged 250 cards at a time, from a source that intermittently
// answers 500. Worse, the batch runner re-fetched the whole set even when it already had a copy in
// localStorage: the cached copy only made the wait feel shorter, it never skipped the download. So
// picking a set to start a pile meant waiting on pokemontcg.io, every single time, in every browser.
//
// A released set's card list does not change. So it is fetched once, written to disk, and served
// from there forever — until someone asks for it again with ?refresh=1, which is the only thing that
// goes upstream after the first time. New sets DO gain cards for a few weeks after release, which is
// exactly what that button is for; the page says how old its copy is so the choice is informed.
//
//   GET /api/pkm/set/:setId/cards            → disk if we have it, else upstream (and store)
//   GET /api/pkm/set/:setId/cards?refresh=1  → upstream, rewrite the file, keep the old one on failure
//
// The RAW upstream card is what lands on disk; the response is TRIMMED to the fields the pickers
// actually use (see trimCard — a raw set is megabytes, mostly attack text and price fields nobody
// reads here). Storing raw means a change to that shape costs a re-serve, never a re-fetch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'pkm-cards');

const UPSTREAM = 'https://api.pokemontcg.io/v2/cards';
const PAGE_SIZE = 250;                // upstream's maximum
const MAX_PAGES = 20;                 // 5000 cards; no Pokémon set is remotely close
const ATTEMPTS = 3;
const TIMEOUT_MS = 20000;

// A set id off the wire becomes a FILENAME, so it is whitelisted rather than escaped. pokemontcg.io
// ids are lowercase alphanumerics with dots and hyphens (sv3, base1, sm35, swshp).
const SET_ID_RE = /^[a-z0-9][a-z0-9.-]{0,40}$/i;
export const isSetId = (s) => SET_ID_RE.test(String(s || ''));

// ---- the shape the pickers actually use -----------------------------------------
// Everything a set picker, the ghost line and the listing builder read, and nothing else. The raw
// card carries attacks, abilities, weaknesses, legalities, ancient traits and two full price blocks;
// a 250-card set is ~1.5 MB raw and ~250 KB like this, and the difference is all on the wire.
export function trimCard(c) {
  const p = (c.tcgplayer && c.tcgplayer.prices) || null;
  let prices = null;
  if (p) { prices = {}; for (const k of Object.keys(p)) { const v = p[k] || {}; prices[k] = { market: v.market ?? null, mid: v.mid ?? null, low: v.low ?? null }; } }
  return {
    id: c.id, name: c.name, number: c.number, rarity: c.rarity || '', artist: c.artist || '',
    supertype: c.supertype || '', subtypes: c.subtypes || [], types: c.types || [], hp: c.hp != null ? String(c.hp) : '',
    nationalPokedexNumbers: c.nationalPokedexNumbers || [], regulationMark: c.regulationMark || '', evolvesFrom: c.evolvesFrom || '',
    images: { small: (c.images && c.images.small) || '', large: (c.images && c.images.large) || '' },
    set: c.set ? { id: c.set.id, name: c.set.name, series: c.set.series || '', ptcgoCode: c.set.ptcgoCode || '', releaseDate: c.set.releaseDate || '', printedTotal: c.set.printedTotal ?? null } : {},
    tcgplayer: prices ? { prices } : null,
  };
}

// ---- pure decision (exported for the unit suite) --------------------------------
// Only a WHOLE set is worth keeping. Two ways a fetch can fail that while still looking like data:
//   · empty — a re-indexing upstream answers 200 with data:[]
//   · truncated — the paging loop gave up early, or upstream stopped mid-set
// Writing either would freeze a blank or half a set into a cache that never expires, which is the
// one genuinely bad outcome of caching forever. Both are refused.
export function isCompleteSet(cards, totalCount) {
  if (!Array.isArray(cards) || !cards.length) return false;
  return !(typeof totalCount === 'number' && totalCount > 0 && cards.length < totalCount);
}

// fresh: { cards, totalCount } from upstream, or null when every attempt failed.
// cached: { at, cards } from disk, or null.
export function decideCardsResponse(fresh, cached, nowIso) {
  if (fresh && isCompleteSet(fresh.cards, fresh.totalCount)) {
    return { store: true, status: 200, source: 'upstream', at: nowIso, cards: fresh.cards };
  }
  // Upstream gave us nothing usable. A copy on disk is better than an error every time.
  if (cached && cached.cards && cached.cards.length) {
    return { store: false, status: 200, source: 'disk', stale: true, at: cached.at, cards: cached.cards };
  }
  // A partial set is still something to look at, but it must never be written down.
  if (fresh && Array.isArray(fresh.cards) && fresh.cards.length) {
    return { store: false, status: 200, source: 'upstream', partial: true, at: nowIso, cards: fresh.cards };
  }
  return { store: false, status: 502, source: 'none', at: nowIso, cards: null };
}

// ---- disk ------------------------------------------------------------------------
const cachePath = (setId) => path.join(CACHE_DIR, setId.toLowerCase() + '.json');

export function readSetCache(setId) {
  if (!isSetId(setId)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(setId), 'utf8'));
    return j && Array.isArray(j.cards) && j.cards.length ? j : null;
  } catch { return null; }
}
// The file is the record; the in-process copy is only a copy of it. Deleting a file from
// data/pkm-cards/ is the obvious way to force one set to be fetched again, and it has to work
// without a restart — so the warm copy is only good while its file is still there.
export const hasSetCache = (setId) => isSetId(setId) && fs.existsSync(cachePath(setId));
export function writeSetCache(setId, at, cards) {
  if (!isSetId(setId)) return false;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // Written via a temp file and renamed: a crash mid-write would otherwise leave a truncated JSON
    // file that never expires, and the whole point of this cache is that nobody re-fetches it.
    const tmp = cachePath(setId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, setId, at, count: cards.length, cards }));
    fs.renameSync(tmp, cachePath(setId));
    return true;
  } catch (e) { console.warn('[api/pkm/set] could not write the cache for', setId, '—', e?.message || e); return false; }
}

// ---- upstream --------------------------------------------------------------------
// PAGED, because one request truncates any set over 250 cards — Paldea Evolved has 279 and would
// silently lose its last 29.
async function fetchSetCards(env, setId) {
  const headers = { Accept: 'application/json', 'User-Agent': 'TCGListingBuilder/1.0' };
  if (env && env.POKEMONTCG_API_KEY) headers['X-Api-Key'] = env.POKEMONTCG_API_KEY;
  const cards = [];
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = UPSTREAM + '?q=' + encodeURIComponent('set.id:' + setId) + '&pageSize=' + PAGE_SIZE + '&page=' + page + '&orderBy=number';
    const body = await fetchPage(url, headers, setId, page);
    if (!body) return null;                                   // a failed PAGE fails the whole set
    const batch = Array.isArray(body.data) ? body.data : [];
    if (typeof body.totalCount === 'number') totalCount = body.totalCount;
    if (!batch.length) break;
    cards.push(...batch);
    if (totalCount != null && cards.length >= totalCount) break;
  }
  return { cards, totalCount };
}
async function fetchPage(url, headers, setId, page) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers, signal: ac.signal });
      const text = await r.text();
      if (r.ok) { try { return JSON.parse(text); } catch { /* an HTML error page dressed as a 200 */ } }
      else console.warn('[api/pkm/set]', setId, 'page', page, '→', r.status, 'attempt', attempt + '/' + ATTEMPTS);
    } catch (e) {
      console.warn('[api/pkm/set]', setId, 'page', page, 'attempt', attempt + '/' + ATTEMPTS, '—', e?.message || e);
    } finally { clearTimeout(timer); }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  return null;
}

// ---- plugin ----------------------------------------------------------------------
const _mem = new Map();        // setId -> { at, cards: trimmed }  — skips the disk read AND the trim
const _inflight = new Map();   // setId -> Promise — two tabs opening the same cold set fetch once

export function pkmCardsPlugin(env) {
  return {
    name: 'pkm-cards-cache',
    configureServer(server) {
      server.middlewares.use('/api/pkm/set', async (req, res, next) => {
        // connect strips the mount path, so what arrives here is /:setId/cards.
        const [urlPath, search] = String(req.url || '/').split('?');
        const m = /^\/([^/]+)\/cards$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        const setId = decodeURIComponent(m[1]);
        if (!isSetId(setId)) return send(res, 400, { error: 'bad set id', code: 'bad_set_id' }, 'none');
        const refresh = new URLSearchParams(search || '').get('refresh') === '1';

        if (!refresh) {
          const warm = _mem.get(setId);
          if (warm && hasSetCache(setId)) return send(res, 200, body(setId, warm.at, warm.cards, 'memory'), 'memory');
          if (warm) _mem.delete(setId);            // the file went away: so does the copy of it
          const disk = readSetCache(setId);
          if (disk) {
            const trimmed = disk.cards.map(trimCard);
            _mem.set(setId, { at: disk.at, cards: trimmed });
            return send(res, 200, body(setId, disk.at, trimmed, 'disk'), 'disk');
          }
        }

        // Cold, or the operator asked for a fresh copy. One fetch per set, however many tabs ask.
        let job = _inflight.get(setId);
        if (!job) {
          job = (async () => {
            const now = new Date().toISOString();
            const fresh = await fetchSetCards(env, setId);
            const cached = readSetCache(setId);
            const d = decideCardsResponse(fresh, cached, now);
            if (d.store) { writeSetCache(setId, d.at, d.cards); _mem.delete(setId); }
            else if (d.stale) console.warn('[api/pkm/set]', setId, '— upstream is down, serving the copy from', d.at);
            return d;
          })().finally(() => _inflight.delete(setId));
          _inflight.set(setId, job);
        }
        const d = await job;
        if (!d.cards) {
          return send(res, 502, { error: 'pokemontcg.io is unreachable and this set is not cached', code: 'upstream_unreachable', setId }, 'none');
        }
        const trimmed = d.cards.map(trimCard);
        if (d.store) _mem.set(setId, { at: d.at, cards: trimmed });
        return send(res, 200, body(setId, d.at, trimmed, d.source, { stale: !!d.stale, partial: !!d.partial }), d.stale ? 'stale' : d.source);
      });
    },
  };
}

function body(setId, at, cards, source, extra) {
  return { setId, count: cards.length, cachedAt: at, source, ...(extra || {}), cards };
}
function send(res, status, payload, cacheState) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-tcg-cache', cacheState);      // memory | disk | upstream | stale | none
  res.end(JSON.stringify(payload));
}
