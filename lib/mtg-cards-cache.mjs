// lib/mtg-cards-cache.mjs — a Magic set's printings, fetched once and kept.
//
// Same deal as the other set caches, against Scryfall, sharing lib/set-cache.mjs. The builder looks
// a card up one request at a time (/cards/{set}/{num}), so a pile out of one set was a round trip
// per card.
//
// Two things are particular to Scryfall:
//
//   · The set comes from /cards/search, which pages at 175 with `has_more` + `next_page` rather than
//     a page number, so the loop follows the link it is given.
//   · Their API guidelines ask for a descriptive User-Agent and 50-100ms between requests. This is
//     already far politer than what it replaces (one request per card looked up), but the delay is
//     honoured between pages anyway — it costs a few hundred milliseconds once per set, ever.
//
// unique=prints is deliberate: a set's listable objects are its PRINTINGS, and the builder is
// looking up a specific collector number. Scryfall's default would collapse them.
import { isSetId, cachePathFor, readCache, writeCache, hasCache, decideSetResponse, withInflight, fetchJsonRetry, sendJson, findByNumber, refreshIfPricesAreStale, wantsFresh } from './set-cache.mjs';

const DIR = 'mtg-cards';
const ENV_DIR = 'MTG_CARDS_CACHE_DIR';
const LABEL = 'api/mtg/set';
const UPSTREAM = 'https://api.scryfall.com';
const MAX_PAGES = 40;                 // 7000 printings; the largest MTG set is nowhere near
const PAGE_GAP_MS = 100;              // Scryfall's requested courtesy delay

export { isSetId };
export const cachePath = (setId) => cachePathFor(DIR, ENV_DIR, setId);
export const readSetCache = (setId) => readCache(DIR, ENV_DIR, setId);
export const hasSetCache = (setId) => hasCache(DIR, ENV_DIR, setId);
export const writeSetCache = (setId, at, cards) => writeCache(DIR, ENV_DIR, setId, at, cards, LABEL);

// Scryfall reports total_cards on the first page, so a short walk is detectable — and a half-walked
// set written into a cache that never expires would be missing its high numbers for good.
export function isCompleteSet(cards, totalCards) {
  if (!Array.isArray(cards) || !cards.length) return false;
  return !(typeof totalCards === 'number' && totalCards > 0 && cards.length < totalCards);
}
export const decideCardsResponse = (fresh, cached, nowIso) =>
  decideSetResponse(fresh, cached, nowIso, (f) => isCompleteSet(f.cards, f.totalCards));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSetCards(setId) {
  const headers = { Accept: 'application/json', 'User-Agent': 'TCGListingBuilder/1.0' };
  const cards = [];
  let totalCards = null;
  let url = UPSTREAM + '/cards/search?q=' + encodeURIComponent('set:' + setId) + '&unique=prints&order=set';
  for (let page = 1; page <= MAX_PAGES && url; page++) {
    const body = await fetchJsonRetry(url, { headers, label: LABEL + ' ' + setId + ' p' + page });
    // A set with no cards answers 404 with an error object, which is not a failure worth retrying
    // into — but it is also not a set, so it never gets stored.
    if (!body) return null;
    if (typeof body.total_cards === 'number') totalCards = body.total_cards;
    const batch = Array.isArray(body.data) ? body.data : [];
    if (!batch.length) break;
    cards.push(...batch);
    url = body.has_more && body.next_page ? String(body.next_page) : null;
    if (url) await sleep(PAGE_GAP_MS);
  }
  return { cards, totalCards };
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
    else if (decided.stale) console.warn('[' + LABEL + ']', setId, '— Scryfall is down, serving the copy from', decided.at);
    return decided;
  });
  return { cards: d.cards, at: d.at, source: d.source, stale: !!d.stale, partial: !!d.partial, store: !!d.store };
}

export const findCardInSet = (cards, num) => findByNumber(cards, num, 'collector_number');

export function mtgCardsPlugin() {
  return {
    name: 'mtg-cards-cache',
    configureServer(server) {
      server.middlewares.use('/api/mtg/cards', async (req, res, next) => {
        const [urlPath, search] = String(req.url || '/').split('?');
        const m = /^\/([^/]+)\/([^/]+)$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();     // /cards/search and the rest stay with the proxy
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
        if (!card) return next();
        // Scryfall's `prices` block rides inside the card, so an old copy gets refreshed behind this
        // answer instead of quoting a price from whenever the set was first opened.
        refreshIfPricesAreStale(got.at, () => getSetCards(setId, { refresh: true }));
        return sendJson(res, 200, card, got.stale ? 'stale' : got.source);
      });
    },
  };
}
