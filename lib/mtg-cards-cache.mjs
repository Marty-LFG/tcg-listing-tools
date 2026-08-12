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
//
//   GET /api/mtg/cards/:set/:num             → one printing out of the stored set
//   GET /api/mtg/set/:setId/cards            → the whole set, TRIMMED (the batch runner's index)
//   GET /api/mtg/set/:setId/cards?refresh=1  → Scryfall again, keep the old copy on failure
//
// The set route answers in the SAME envelope as lib/pkm-cards-cache.mjs's, because stock-runner.html
// reads both through one code path and only the URL differs between the two games.
import fs from 'node:fs';
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

// ---- the shape the pickers actually use -----------------------------------------
// Everything stock-runner.html's index, the ghost line and the MTG adapter read, and nothing else. A
// raw Scryfall printing carries oracle text, legalities, rulings/prints URIs, related cards and two
// currencies of prices — 4-8 KB each, so a 400-print set is 2-3 MB raw and ~200 KB like this. The
// difference is all on the wire AND in the browser's localStorage, which the runner shares between
// several resident sets against a ~5 MB origin quota.
//
// The DISK copy stays RAW (see writeSetCache below): resolveMtgCard reads it on the export path and
// wants the whole record, and storing raw means a change to this shape costs a re-serve, never a
// re-fetch. Only the HTTP response is trimmed.
export function trimCard(c) {
  const f0 = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || null;
  const pr = c.prices || {};
  return {
    id: c.id, name: c.name, collector_number: c.collector_number,
    rarity: c.rarity || '', artist: c.artist || '', lang: c.lang || 'en',
    released_at: c.released_at || '', type_line: c.type_line || '',
    // A double-faced card carries its colours on the front face, not on the card (same fallback
    // lib/channels/ebay-map.mjs buildRowIn makes).
    colors: c.colors || (c.card_faces && c.card_faces[0] && c.card_faces[0].colors) || [],
    // The printing matrix (runner-core mtgPrintingsFor) is `finishes` PLUS promo_types, because a
    // surge foil is a separate product that `finishes` only ever calls "foil".
    finishes: c.finishes || [], promo_types: c.promo_types || [], promo: !!c.promo,
    // The treatment axis: frame_effects/border_color/full_art feed mtgTreatmentOf and the Features
    // aspect. Dropping them would cost every Borderless and Showcase print its item specific.
    frame_effects: c.frame_effects || [], border_color: c.border_color || '', full_art: !!c.full_art,
    set: c.set || '', set_name: c.set_name || '',
    image_uris: f0 ? { small: f0.small || '', normal: f0.normal || '', large: f0.large || '' } : null,
    prices: { usd: pr.usd ?? null, usd_foil: pr.usd_foil ?? null, usd_etched: pr.usd_etched ?? null },
  };
}

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
const _mem = new Map();        // setId -> { at, cards: trimmed } — skips the disk read AND the trim

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

// Scryfall's card facts (colour, type line, treatment, artist, release) are NOT persisted on
// inventory_items — only the identity is — so the export path re-resolves them at build time. Same
// move Riftbound already makes in lib/channels/ebay-map.mjs, and for the same reason: a row that has
// been through the DB would otherwise render a half-empty CARD DETAILS table and lose every derived
// aspect. SYNC on purpose (toEbayListing is synchronous and runs per row), off the disk cache the
// builder already fills. Memoised on the cache file's mtime, so a ?refresh=1 is picked up without a
// restart. A cold cache returns null rather than throwing — the listing still builds (GR7).
const _resolved = new Map();
export function resolveMtgCard(identityKey) {
  const idk = String(identityKey == null ? '' : identityKey);
  const dash = idk.indexOf('-');
  if (dash <= 0) return null;
  const setId = idk.slice(0, dash), num = idk.slice(dash + 1);
  if (!isSetId(setId) || !num) return null;
  try {
    const key = setId + '@' + fs.statSync(cachePath(setId)).mtimeMs;
    let idx = _resolved.get(key);
    if (!idx) {
      const disk = readSetCache(setId);
      if (!disk || !Array.isArray(disk.cards)) return null;
      idx = new Map();
      for (const c of disk.cards) {
        if (c && c.collector_number != null) idx.set(String(c.collector_number).toLowerCase(), c);
      }
      if (_resolved.size > 6) _resolved.clear();   // a handful of sets in flight is plenty
      _resolved.set(key, idx);
    }
    return idx.get(String(num).toLowerCase()) || null;
  } catch { return null; }
}

export function mtgCardsPlugin() {
  return {
    name: 'mtg-cards-cache',
    configureServer(server) {
      // The batch runner's one structural move: a whole set in ONE request, kept resident, so the
      // typing loop never touches the network. Mounted BEFORE /api/mtg/cards would ever see it, and
      // deliberately the same envelope lib/pkm-cards-cache.mjs answers with — the page swaps the URL
      // per game and nothing else.
      server.middlewares.use('/api/mtg/set', async (req, res, next) => {
        // connect strips the mount path, so what arrives here is /:setId/cards.
        const [urlPath, search] = String(req.url || '/').split('?');
        const m = /^\/([^/]+)\/cards$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        const setId = decodeURIComponent(m[1]).toLowerCase();
        if (!isSetId(setId)) return sendJson(res, 400, { error: 'bad set id', code: 'bad_set_id' }, 'none');
        const refresh = new URLSearchParams(search || '').get('refresh') === '1';

        if (!refresh) {
          const warm = _mem.get(setId);
          if (warm && hasSetCache(setId)) { ageMtgPrices(setId, warm.at); return sendJson(res, 200, setBody(setId, warm.at, warm.cards, 'memory'), 'memory'); }
          if (warm) _mem.delete(setId);              // the file went away: so does the copy of it
          const disk = readSetCache(setId);
          if (disk) {
            const trimmed = disk.cards.map(trimCard);
            _mem.set(setId, { at: disk.at, cards: trimmed });
            ageMtgPrices(setId, disk.at);
            return sendJson(res, 200, setBody(setId, disk.at, trimmed, 'disk'), 'disk');
          }
        }

        // Cold, or the operator asked for a fresh copy. getSetCards collapses concurrent callers, so
        // two tabs opening the same cold set still cost Scryfall one walk.
        let d;
        try { d = await getSetCards(setId, { refresh }); }
        catch { d = { cards: null }; }
        if (!d.cards) {
          return sendJson(res, 502, { error: 'Scryfall is unreachable and this set is not cached', code: 'upstream_unreachable', setId }, 'none');
        }
        const trimmed = d.cards.map(trimCard);
        if (d.store) _mem.set(setId, { at: d.at, cards: trimmed });
        return sendJson(res, 200, setBody(setId, d.at, trimmed, d.source, { stale: !!d.stale, partial: !!d.partial }), d.stale ? 'stale' : d.source);
      });

      // Scryfall's `prices` block rides inside every cached card, and the batch runner flags a row
      // when its eBay comps disagree with the market figure by more than 2.5x. A frozen price would
      // turn that quality check into noise, so an old copy is refreshed behind whatever went out.
      // setId is lowercased for the _mem key because the two routes reach here with different
      // casing (the set route normalises, the card route passes the URL segment through) and the
      // disk filename is lowercase either way.
      function ageMtgPrices(setId, at) {
        if (refreshIfPricesAreStale(at, () => getSetCards(setId, { refresh: true }))) _mem.delete(String(setId).toLowerCase());
      }

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
        if (refresh) _mem.delete(setId.toLowerCase());   // the set route's copy is now the old one
        let got;
        try { got = await getSetCards(setId, { refresh }); } catch { return next(); }
        if (!got.cards) return next();
        const card = findCardInSet(got.cards, num);
        if (!card) return next();
        // Scryfall's `prices` block rides inside the card, so an old copy gets refreshed behind this
        // answer instead of quoting a price from whenever the set was first opened. Goes through the
        // shared helper so the set route's memory copy is dropped too — otherwise a refresh started
        // here would rewrite the file and leave /api/mtg/set serving the prices it replaced.
        ageMtgPrices(setId, got.at);
        return sendJson(res, 200, card, got.stale ? 'stale' : got.source);
      });
    },
  };
}

// Byte-for-byte the envelope lib/pkm-cards-cache.mjs answers with, so stock-runner.html's
// loadSetIndex parses one shape whichever game it is looking at.
function setBody(setId, at, cards, source, extra) {
  return { setId, count: cards.length, cachedAt: at, source, ...(extra || {}), cards };
}
