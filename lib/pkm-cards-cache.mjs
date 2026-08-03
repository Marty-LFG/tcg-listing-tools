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
// The disk store, the serve-what-you-have decision and the one-fetch-per-set lock are shared with
// Lorcana in lib/set-cache.mjs — only the upstream differs between the two.
import { isSetId, cachePathFor, readCache, writeCache, hasCache, decideSetResponse, withInflight, fetchJsonRetry, sendJson } from './set-cache.mjs';

const DIR = 'pkm-cards';
const ENV_DIR = 'PKM_CARDS_CACHE_DIR';       // tests and check harnesses point this at a temp folder
const LABEL = 'api/pkm/set';

const UPSTREAM = 'https://api.pokemontcg.io/v2/cards';
const PAGE_SIZE = 250;                // upstream's maximum
const MAX_PAGES = 20;                 // 5000 cards; no Pokémon set is remotely close

export { isSetId };

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
export const decideCardsResponse = (fresh, cached, nowIso) =>
  decideSetResponse(fresh, cached, nowIso, (f) => isCompleteSet(f.cards, f.totalCount));

// ---- disk ------------------------------------------------------------------------
export const cachePath = (setId) => cachePathFor(DIR, ENV_DIR, setId);
export const readSetCache = (setId) => readCache(DIR, ENV_DIR, setId);
export const hasSetCache = (setId) => hasCache(DIR, ENV_DIR, setId);
export const writeSetCache = (setId, at, cards) => writeCache(DIR, ENV_DIR, setId, at, cards, LABEL);

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
    const body = await fetchJsonRetry(url, { headers, label: LABEL + ' ' + setId + ' p' + page });
    if (!body) return null;                                   // a failed PAGE fails the whole set
    const batch = Array.isArray(body.data) ? body.data : [];
    if (typeof body.totalCount === 'number') totalCount = body.totalCount;
    if (!batch.length) break;
    cards.push(...batch);
    if (totalCount != null && cards.length >= totalCount) break;
  }
  return { cards, totalCount };
}
// ---- plugin ----------------------------------------------------------------------
const _mem = new Map();        // setId -> { at, cards: trimmed }  — skips the disk read AND the trim
const _inflight = new Map();   // setId -> Promise — two tabs opening the same cold set fetch once

// ---- the cache, for anything running in this process --------------------------------
// The HTTP route is one caller. lib/enumerate.mjs is another: the bulk builder paged pokemontcg.io
// itself, over the proxy, for every set it enumerated — the same live-fetch-every-time this exists
// to end. Server-side callers get the RAW cards, because that is what they were reading before.
//
// Returns { cards, at, source, stale, partial } with cards:null only when there is nothing anywhere.
export async function getSetCards(env, setId, { refresh = false } = {}) {
  if (!isSetId(setId)) return { cards: null, at: null, source: 'none' };
  if (!refresh) {
    const disk = readSetCache(setId);
    if (disk) return { cards: disk.cards, at: disk.at, source: 'disk' };
  }
  const d = await withInflight(_inflight, setId, async () => {
    const now = new Date().toISOString();
    const fresh = await fetchSetCards(env, setId);
    const decided = decideCardsResponse(fresh, readSetCache(setId), now);
    if (decided.store) { writeSetCache(setId, decided.at, decided.cards); _mem.delete(setId); }
    else if (decided.stale) console.warn('[' + LABEL + ']', setId, '— upstream is down, serving the copy from', decided.at);
    return decided;
  });
  return { cards: d.cards, at: d.at, source: d.source, stale: !!d.stale, partial: !!d.partial, store: !!d.store };
}

// One card out of a set we already hold. Used to answer /api/pkm/cards/:id without touching
// pokemontcg.io: once a set has been loaded anywhere in the suite, every card lookup in every
// builder is a local read. Returns null when we do not have the set, so the caller falls through.
export function cachedCardById(cardId) {
  const id = String(cardId || '').trim();
  const dash = id.lastIndexOf('-');
  if (dash < 1) return null;
  const setId = id.slice(0, dash);
  if (!isSetId(setId)) return null;
  const disk = readSetCache(setId);
  if (!disk) return null;
  return disk.cards.find((c) => c && c.id === id) || null;
}

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
        const d = await getSetCards(env, setId, { refresh });
        if (!d.cards) {
          return send(res, 502, { error: 'pokemontcg.io is unreachable and this set is not cached', code: 'upstream_unreachable', setId }, 'none');
        }
        const trimmed = d.cards.map(trimCard);
        if (d.store) _mem.set(setId, { at: d.at, cards: trimmed });
        return send(res, 200, body(setId, d.at, trimmed, d.source, { stale: !!d.stale, partial: !!d.partial }), d.stale ? 'stale' : d.source);
      });

      // Every single-card lookup in the suite goes through /api/pkm/cards/:id first — the builder,
      // the uploader and the grader all share that ladder (extras.js pkmLookupCard). It was a bare
      // proxy call, so listing thirty cards out of one set meant thirty round trips to a source that
      // regularly 500s, for cards already sitting in a file on this machine. Answer from that file
      // when we have it; anything we do not have falls through to the proxy untouched.
      server.middlewares.use('/api/pkm/cards', (req, res, next) => {
        const [urlPath] = String(req.url || '/').split('?');
        const m = /^\/([^/?]+)$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        const card = cachedCardById(decodeURIComponent(m[1]));
        if (!card) return next();
        // Shaped exactly like pokemontcg.io's own single-card response, because that is what the
        // callers parse. Raw, not trimmed: this stands in for the upstream, so it answers like it.
        return send(res, 200, { data: card }, 'disk');
      });
    },
  };
}

function body(setId, at, cards, source, extra) {
  return { setId, count: cards.length, cachedAt: at, source, ...(extra || {}), cards };
}
const send = sendJson;
