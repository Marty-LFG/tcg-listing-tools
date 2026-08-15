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
import fs from 'node:fs';
import { isSetId, cachePathFor, readCache, writeCache, hasCache, decideSetResponse, withInflight, fetchJsonRetry, sendJson, findByNumber, refreshIfPricesAreStale, wantsFresh } from './set-cache.mjs';

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

// Lorcast's card facts (ink, type, classifications, illustrator) are NOT persisted on
// inventory_items — only the identity is — so the eBay export path re-resolves them at build time.
// The same move MTG and Riftbound already make in lib/channels/ebay-map.mjs, and for the same
// reason: createOrReplaceInventoryItem is a full REPLACE, not a patch, so a republish carrying no
// overrides (a revise-price, a repricer apply) would strip every derived aspect back off.
//
// SYNC on purpose (toEbayListing is synchronous and runs per row), off the disk cache the builder
// already fills. Memoised on the cache file's mtime, so a ?refresh=1 is picked up without a
// restart. A cold cache returns null rather than throwing — the listing still builds (GR7).
//
// The identity key is "<setCode>/<collectorNumber>" — the shape ENUMERATORS.lorcana and
// lib/collectr-resolve.mjs both already produce. Split on the FIRST slash: a set code never
// contains one, and neither does a Lorcana collector number ('24B' is as exotic as they get).
const _resolved = new Map();
export function resolveLorcanaCard(identityKey) {
  const idk = String(identityKey == null ? '' : identityKey);
  const slash = idk.indexOf('/');
  if (slash <= 0) return null;
  const setId = idk.slice(0, slash), num = idk.slice(slash + 1);
  if (!isSetId(setId) || !num) return null;
  try {
    const key = setId.toLowerCase() + '@' + fs.statSync(cachePath(setId)).mtimeMs;
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

// setId -> { at, cards } — skips the disk read on the batch runner's repeat loads of a set.
const _mem = new Map();
function setBody(setId, at, cards, source, extra) {
  return { setId, count: cards.length, cachedAt: at, source, ...(extra || {}), cards };
}

// ---- plugin ----------------------------------------------------------------------
export function lorcanaCardsPlugin() {
  return {
    name: 'lorcana-cards-cache',
    configureServer(server) {
      // The batch runner's one structural move: a whole set in ONE request, kept resident, so the
      // typing loop never touches the network. Deliberately the SAME envelope lib/pkm-cards-cache
      // and lib/mtg-cards-cache answer with — stock-runner.html swaps the URL per game via the
      // adapter's setCardsUrl and nothing else changes.
      //
      // Cards go out UNTRIMMED, unlike Pokémon and Magic. A Pokémon set is megabytes of attack
      // text so its cache trims; a Lorcana card is small, and the runner's normalizeCard reads
      // fields (ink/inks, classifications, illustrators, layout) across the whole object.
      server.middlewares.use('/api/lorcana/set', async (req, res, next) => {
        // connect strips the mount path, so what arrives here is /:setId/cards.
        const [urlPath, search] = String(req.url || '/').split('?');
        const m = /^\/([^/]+)\/cards$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        const setId = decodeURIComponent(m[1]);
        if (!isSetId(setId)) return sendJson(res, 400, { error: 'bad set id', code: 'bad_set_id' }, 'none');
        const refresh = new URLSearchParams(search || '').get('refresh') === '1';
        const memKey = setId.toLowerCase();

        if (!refresh) {
          const warm = _mem.get(memKey);
          if (warm && hasSetCache(setId)) { ageLorcanaPrices(setId, warm.at); return sendJson(res, 200, setBody(setId, warm.at, warm.cards, 'memory'), 'memory'); }
          if (warm) _mem.delete(memKey);              // the file went away: so does the copy of it
          const disk = readSetCache(setId);
          if (disk) {
            _mem.set(memKey, { at: disk.at, cards: disk.cards });
            ageLorcanaPrices(setId, disk.at);
            return sendJson(res, 200, setBody(setId, disk.at, disk.cards, 'disk'), 'disk');
          }
        }

        // Cold, or the operator asked for a fresh copy. getSetCards collapses concurrent callers, so
        // two tabs opening the same cold set still cost Lorcast one request.
        let d;
        try { d = await getSetCards(setId, { refresh }); }
        catch { d = { cards: null }; }
        if (!d.cards) {
          return sendJson(res, 502, { error: 'Lorcast is unreachable and this set is not cached', code: 'upstream_unreachable', setId }, 'none');
        }
        if (d.store) _mem.set(memKey, { at: d.at, cards: d.cards });
        return sendJson(res, 200, setBody(setId, d.at, d.cards, d.source, { stale: !!d.stale }), d.stale ? 'stale' : d.source);
      });

      // Lorcast's `prices` block rides inside every cached card, and the batch runner flags a row
      // when its eBay comps disagree with the market figure. A frozen price turns that quality
      // check into noise, so an old copy is refreshed behind whatever went out. Lorcast recomputes
      // prices once a day, so this is the whole reason the set cache is allowed to be long-lived.
      function ageLorcanaPrices(setId, at) {
        if (refreshIfPricesAreStale(at, () => getSetCards(setId, { refresh: true }))) _mem.delete(String(setId).toLowerCase());
      }

      // Every card lookup in the Lorcana builder goes here. Answer it out of the set — fetching the
      // whole set on the first miss, because Lorcast serves it in the same single request a card
      // would have cost, so the first lookup pays nothing extra and the rest of the set is free.
      server.middlewares.use('/api/lorcana/cards', async (req, res, next) => {
        const [urlPath, search] = String(req.url || '/').split('?');
        const m = /^\/([^/]+)\/([^/]+)$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        const setId = decodeURIComponent(m[1]), num = decodeURIComponent(m[2]);
        // The price tracker asks for the real thing (see BYPASS_HEADER) — it is recording history,
        // not reading a card, so a stored copy is exactly what it must not get.
        if (wantsFresh(req)) return next();
        if (!isSetId(setId)) return next();
        // ?refresh=1 is the builders' refresh button: fetch the set again before answering, so a
        // set that gained cards (or moved on price) can be pulled without touching the disk by hand.
        const refresh = new URLSearchParams(search || '').get('refresh') === '1';
        let got;
        try { got = await getSetCards(setId, { refresh }); } catch { return next(); }
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
