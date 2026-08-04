// lib/swu-cards-cache.mjs — a Star Wars Unlimited set's cards, fetched once and kept.
//
// Same deal as the Pokémon and Lorcana caches, against SWU-DB, sharing lib/set-cache.mjs. The
// builder looks a card up one request at a time (/cards/{set}/{num}), so listing a dozen out of one
// set was a dozen round trips for cards that all live in the same list.
//
// SWU-DB serves a whole set in one request and tells you how many cards it should have
// (`total_cards`), which makes the completeness gate a real check rather than "we got something" —
// worth having when the cache never expires. Sorcerer's Showdown is 946 cards / ~600 KB, so the
// first card looked up in a set is a bigger download than it used to be; every card after it in that
// set costs nothing, which is the trade a pile of one set wants.
import { isSetId, cachePathFor, readCache, writeCache, hasCache, decideSetResponse, withInflight, fetchJsonRetry, sendJson, findByNumber, refreshIfPricesAreStale, wantsFresh } from './set-cache.mjs';

const DIR = 'swu-cards';
const ENV_DIR = 'SWU_CARDS_CACHE_DIR';
const LABEL = 'api/swu/set';
const UPSTREAM = 'https://api.swu-db.com';

export { isSetId };
export const cachePath = (setId) => cachePathFor(DIR, ENV_DIR, setId);
export const readSetCache = (setId) => readCache(DIR, ENV_DIR, setId);
export const hasSetCache = (setId) => hasCache(DIR, ENV_DIR, setId);
export const writeSetCache = (setId, at, cards) => writeCache(DIR, ENV_DIR, setId, at, cards, LABEL);

// Empty is no answer; short of `total_cards` is half a set, and half a set stored in a cache that
// never expires is half a set forever.
export function isCompleteSet(cards, totalCards) {
  if (!Array.isArray(cards) || !cards.length) return false;
  return !(typeof totalCards === 'number' && totalCards > 0 && cards.length < totalCards);
}
export const decideCardsResponse = (fresh, cached, nowIso) =>
  decideSetResponse(fresh, cached, nowIso, (f) => isCompleteSet(f.cards, f.totalCards));

async function fetchSetCards(setId) {
  const headers = { Accept: 'application/json', 'User-Agent': 'TCGListingBuilder/1.0' };
  const body = await fetchJsonRetry(UPSTREAM + '/cards/' + encodeURIComponent(setId), { headers, label: LABEL + ' ' + setId });
  if (!body) return null;
  return { cards: Array.isArray(body.data) ? body.data : [], totalCards: typeof body.total_cards === 'number' ? body.total_cards : null };
}

const _inflight = new Map();

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
    else if (decided.stale) console.warn('[' + LABEL + ']', setId, '— SWU-DB is down, serving the copy from', decided.at);
    return decided;
  });
  return { cards: d.cards, at: d.at, source: d.source, stale: !!d.stale, partial: !!d.partial, store: !!d.store };
}

// SWU-DB pads its numbers ('059'); the builder passes whatever was typed.
export const findCardInSet = (cards, num) => findByNumber(cards, num, 'Number');

export function swuCardsPlugin() {
  return {
    name: 'swu-cards-cache',
    configureServer(server) {
      server.middlewares.use('/api/swu/cards', async (req, res, next) => {
        const [urlPath, search] = String(req.url || '/').split('?');
        const m = /^\/([^/]+)\/([^/]+)$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();          // /cards/{set} itself belongs to the proxy
        // The price tracker asks for the real thing (see BYPASS_HEADER) — it is recording history,
        // not reading a card, so a stored copy is exactly what it must not get.
        if (wantsFresh(req)) return next();
        const setId = decodeURIComponent(m[1]), num = decodeURIComponent(m[2]);
        if (!isSetId(setId)) return next();
        // ?refresh=1 is the builders' refresh button: fetch the set again before answering, so a
        // set that gained cards (or moved on price) can be pulled without touching the disk by hand.
        const refresh = new URLSearchParams(search || '').get('refresh') === '1';
        let got;
        try { got = await getSetCards(setId, { refresh }); } catch { return next(); }
        if (!got.cards) return next();
        const card = findCardInSet(got.cards, num);
        if (!card) return next();                                // not in the set we hold — no invented 404
        // MarketPrice/LowPrice/FoilPrice ride inside the card and the builder shows them, so an old
        // copy gets refreshed behind this answer rather than quoting last month's market forever.
        refreshIfPricesAreStale(got.at, () => getSetCards(setId, { refresh: true }));
        return sendJson(res, 200, card, got.stale ? 'stale' : got.source);
      });
    },
  };
}
