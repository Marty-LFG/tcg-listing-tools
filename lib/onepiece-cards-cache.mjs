// lib/onepiece-cards-cache.mjs — a One Piece set's cards, fetched once and kept.
//
// Same deal as the other set caches, against optcgapi.com, sharing lib/set-cache.mjs. The builder
// looks a card up one request at a time (/sets/card/{code}/), so a pile out of one set was a round
// trip per card.
//
// THE THING THAT HAD TO BE CHECKED FIRST: One Piece art variants. A card's base print and its
// parallel share a card_set_id and differ only in card_image and price — OP01-001 is $5.73 as the
// base and $568 as the parallel (GR5: never collapse printings). The per-card endpoint returns BOTH,
// in order, and serving that lookup from a cached set is only safe if the set carries them the same
// way. Verified against the live API: the two entries for OP01-001 in /api/sets/OP-01/ are identical
// to the two from /api/sets/card/OP01-001/, field for field and in the same order. So the array is
// passed through whole, and the builder's variant dropdown is unchanged.
//
// The other wrinkle is the id shapes: the set list gives OP-01, card codes read OP01-001. The
// hyphen goes back in to build the URL, and a prefix that does not resolve is remembered so an
// unusual set (the API also has OP14-EB04) costs one failed lookup per process, not one per card.
import { isSetId, cachePathFor, readCache, writeCache, hasCache, decideSetResponse, withInflight, fetchJsonRetry, sendJson, refreshIfPricesAreStale, wantsFresh } from './set-cache.mjs';

const DIR = 'onepiece-cards';
const ENV_DIR = 'ONEPIECE_CARDS_CACHE_DIR';
const LABEL = 'api/op/set';
const UPSTREAM = 'https://optcgapi.com/api';

export const cachePath = (setId) => cachePathFor(DIR, ENV_DIR, setId);
export const readSetCache = (setId) => readCache(DIR, ENV_DIR, setId);
export const hasSetCache = (setId) => hasCache(DIR, ENV_DIR, setId);
export const writeSetCache = (setId, at, cards) => writeCache(DIR, ENV_DIR, setId, at, cards, LABEL);

// optcgapi returns a bare array with no count, so "complete" is "we got cards" — the same weaker
// gate as Lorcana, and the same consequence: an empty answer is treated as no answer, never as an
// empty set, because storing one would blank the set for good.
export const isCompleteSet = (cards) => Array.isArray(cards) && cards.length > 0;
export const decideCardsResponse = (fresh, cached, nowIso) =>
  decideSetResponse(fresh, cached, nowIso, (f) => isCompleteSet(f.cards));

// OP01-001 → OP-01 · ST01-002 → ST-01 · PRB01-005 → PRB-01. A code whose prefix does not split that
// way (or names a set the API keys differently) simply does not resolve, and the caller falls back
// to the proxy rather than guessing at a URL.
export function setIdFromCode(code) {
  const m = /^([A-Za-z]+)(\d+)-/.exec(String(code || '').trim());
  return m ? m[1].toUpperCase() + '-' + m[2] : null;
}
// The cache file name must survive the hyphen, which isSetId already allows.
const cacheKey = (setId) => String(setId || '').toUpperCase();

async function fetchSetCards(setId) {
  const headers = { Accept: 'application/json', 'User-Agent': 'TCGListingBuilder/1.0' };
  const body = await fetchJsonRetry(UPSTREAM + '/sets/' + encodeURIComponent(setId) + '/', { headers, label: LABEL + ' ' + setId });
  if (!body) return null;
  return { cards: Array.isArray(body) ? body : (body.data || body.cards || []) };
}

const _inflight = new Map();
const _unresolvable = new Set();      // set ids the API does not serve — asked once per process

export async function getSetCards(setId, { refresh = false } = {}) {
  const key = cacheKey(setId);
  if (!key || !isSetId(key)) return { cards: null, at: null, source: 'none' };
  if (!refresh) {
    const disk = readSetCache(key);
    if (disk) return { cards: disk.cards, at: disk.at, source: 'disk' };
    if (_unresolvable.has(key)) return { cards: null, at: null, source: 'none' };
  }
  const d = await withInflight(_inflight, key, async () => {
    const now = new Date().toISOString();
    const fresh = await fetchSetCards(key);
    const decided = decideCardsResponse(fresh, readSetCache(key), now);
    if (decided.store) writeSetCache(key, decided.at, decided.cards);
    else if (decided.stale) console.warn('[' + LABEL + ']', key, '— optcgapi is down, serving the copy from', decided.at);
    else if (!decided.cards) _unresolvable.add(key);
    return decided;
  });
  return { cards: d.cards, at: d.at, source: d.source, stale: !!d.stale, partial: !!d.partial, store: !!d.store };
}

// EVERY entry for this card code, in the order the set lists them — that is the art-variant list the
// builder's dropdown is built from, and dropping or reordering it would quietly change which print
// a listing is for.
export function findCardVariants(cards, code) {
  const want = String(code || '').trim().toUpperCase();
  if (!want) return [];
  return (cards || []).filter((c) => c && String(c.card_set_id || '').trim().toUpperCase() === want);
}

export function onepieceCardsPlugin() {
  return {
    name: 'onepiece-cards-cache',
    configureServer(server) {
      server.middlewares.use('/api/op/sets/card', async (req, res, next) => {
        const [urlPath] = String(req.url || '/').split('?');
        const m = /^\/([^/]+)\/?$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        const code = decodeURIComponent(m[1]);
        // The price tracker asks for the real thing (see BYPASS_HEADER) — it is recording history,
        // not reading a card, so a stored copy is exactly what it must not get.
        if (wantsFresh(req)) return next();
        const setId = setIdFromCode(code);
        if (!setId) return next();
        let got;
        try { got = await getSetCards(setId); } catch { return next(); }
        if (!got.cards) return next();
        const variants = findCardVariants(got.cards, code);
        if (!variants.length) return next();          // not in the set we hold — no invented 404
        // market_price / inventory_price ride inside the card and the builder shows them, so an old
        // copy is refreshed behind this answer. It matters more here than anywhere: the gap between a
        // base print and its parallel is the whole reason those two prices are read.
        refreshIfPricesAreStale(got.at, () => getSetCards(setId, { refresh: true }));
        return sendJson(res, 200, variants, got.stale ? 'stale' : got.source);
      });
    },
  };
}
