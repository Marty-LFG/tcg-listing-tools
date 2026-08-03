// lib/lorcana-cards-cache.mjs — a Lorcana set's cards, fetched once and kept.
//
// The same deal as lib/pkm-cards-cache.mjs, against Lorcast instead of pokemontcg.io, and sharing
// the mechanics in lib/set-cache.mjs. What it replaces here is two different live-fetch habits:
//
//   · the bulk builder enumerated a set by asking Lorcast for the whole card list, every time — and
//     when that list came back empty it fell back to WALKING the collector numbers one request at a
//     time, which is a set's worth of requests for one enumeration.
//   · the Lorcana builder looks a card up by number, one request per card, so listing a dozen out of
//     one set is a dozen round trips for cards that all live in the same list.
//
// Both are now reads of one stored file. A Lorcast set comes back in a SINGLE request, so unlike the
// Pokémon side there is no paging — which also means the first card you look up in a set pays for
// the whole set, and every card after it in that set is free.
//
// Cards are stored and served as Lorcast returns them: no trim. The Pokémon payload needed one
// because a raw set is megabytes of attack text; a Lorcana card is small, and the builder reads
// fields across the whole object.
import { isSetId, cachePathFor, readCache, writeCache, hasCache, decideSetResponse, withInflight, fetchJsonRetry, sendJson, findByNumber, refreshIfPricesAreStale } from './set-cache.mjs';

const DIR = 'lorcana-cards';
const ENV_DIR = 'LORCANA_CARDS_CACHE_DIR';   // tests point this at a temp folder
const LABEL = 'api/lorcana/set';
const UPSTREAM = 'https://api.lorcast.com/v0';

export { isSetId };
export const cachePath = (setId) => cachePathFor(DIR, ENV_DIR, setId);
export const readSetCache = (setId) => readCache(DIR, ENV_DIR, setId);
export const hasSetCache = (setId) => hasCache(DIR, ENV_DIR, setId);
export const writeSetCache = (setId, at, cards) => writeCache(DIR, ENV_DIR, setId, at, cards, LABEL);

// Lorcast hands back the whole set in one response, so "complete" is simply "we got cards". There is
// no count to check it against — which is the one place this is weaker than the Pokémon gate, and
// the reason a set that comes back empty is treated as no answer at all rather than an empty set.
export const isCompleteSet = (cards) => Array.isArray(cards) && cards.length > 0;
export const decideCardsResponse = (fresh, cached, nowIso) =>
  decideSetResponse(fresh, cached, nowIso, (f) => isCompleteSet(f.cards));

// The list arrives as a bare array on some Lorcast builds and wrapped on others; both shapes have
// been seen in the wild, and lib/enumerate.mjs already had to handle each.
function cardsFrom(body) {
  if (Array.isArray(body)) return body;
  if (!body) return [];
  return body.results || body.data || body.cards || [];
}

async function fetchSetCards(setId) {
  const headers = { Accept: 'application/json', 'User-Agent': 'TCGListingBuilder/1.0' };
  const body = await fetchJsonRetry(UPSTREAM + '/sets/' + encodeURIComponent(setId) + '/cards', { headers, label: LABEL + ' ' + setId });
  if (!body) return null;
  return { cards: cardsFrom(body) };
}

const _inflight = new Map();

// The whole set, from the nearest copy. Used by lib/enumerate.mjs in-process and by the middleware
// below. Returns { cards, at, source, stale } with cards:null only when there is nothing anywhere.
export async function getSetCards(setId, { refresh = false } = {}) {
  if (!isSetId(setId)) return { cards: null, at: null, source: 'none' };
  if (!refresh) {
    const disk = readSetCache(setId);
    if (disk) return { cards: disk.cards, at: disk.at, source: 'disk' };
  }
  const d = await withInflight(_inflight, setId, async () => {
    const now = new Date().toISOString();
    const fresh = await fetchSetCards(setId);
    const decided = decideCardsResponse(fresh, readSetCache(setId), now);
    if (decided.store) writeSetCache(setId, decided.at, decided.cards);
    else if (decided.stale) console.warn('[' + LABEL + ']', setId, '— Lorcast is down, serving the copy from', decided.at);
    return decided;
  });
  return { cards: d.cards, at: d.at, source: d.source, stale: !!d.stale, partial: !!d.partial, store: !!d.store };
}

// One card out of a set, by its collector number — Lorcast pads these inconsistently, which is what
// findByNumber is for (shared with SWU and MTG, whose APIs do the same).
export const findCardInSet = (cards, num) => findByNumber(cards, num, 'collector_number');

// ---- plugin ----------------------------------------------------------------------
export function lorcanaCardsPlugin() {
  return {
    name: 'lorcana-cards-cache',
    configureServer(server) {
      // Every card lookup in the Lorcana builder goes here. Answer it out of the set — fetching the
      // whole set on the first miss, because Lorcast serves it in the same single request a card
      // would have cost, so the first lookup pays nothing extra and the rest of the set is free.
      server.middlewares.use('/api/lorcana/cards', async (req, res, next) => {
        const [urlPath] = String(req.url || '/').split('?');
        const m = /^\/([^/]+)\/([^/]+)$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        const setId = decodeURIComponent(m[1]), num = decodeURIComponent(m[2]);
        if (!isSetId(setId)) return next();
        let got;
        try { got = await getSetCards(setId); } catch { return next(); }
        if (!got.cards) return next();                 // nothing stored and Lorcast is down: let the proxy try
        const card = findCardInSet(got.cards, num);
        if (!card) return next();                      // not in the set we hold — never invent a 404
        // Lorcast's `prices` ride inside the card and the builder shows the market figure, so an old
        // copy gets refreshed behind this answer rather than quoting a stale one forever.
        refreshIfPricesAreStale(got.at, () => getSetCards(setId, { refresh: true }));
        return sendJson(res, 200, card, got.stale ? 'stale' : got.source);
      });
    },
  };
}
