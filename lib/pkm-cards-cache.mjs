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
import { isSetId, cachePathFor, readCache, writeCache, hasCache, decideSetResponse, withInflight, fetchJsonRetry, sendJson, refreshIfPricesAreStale, wantsFresh } from './set-cache.mjs';
import { fetchTcgdexCardById, fetchTcgdexSetCards } from './pkm-tcgdex.mjs';

const DIR = 'pkm-cards';
const ENV_DIR = 'PKM_CARDS_CACHE_DIR';       // tests and check harnesses point this at a temp folder
const LABEL = 'api/pkm/set';

const UPSTREAM = 'https://api.pokemontcg.io/v2/cards';
const PAGE_SIZE = 250;                // upstream's maximum
const MAX_PAGES = 20;                 // 5000 cards; no Pokémon set is remotely close

// A set whose warm attempt just failed is not tried again on the next keystroke. Without this, one
// lookup against a cold set while pokemontcg.io is down costs a full paged fetch — twenty pages,
// each retried — and the operator waits through all of it before the backup source is even reached.
// Sixty seconds is long enough to cover a burst of typing and short enough that a source coming back
// is picked up on the next card rather than the next restart.
const WARM_RETRY_MS = 60 * 1000;
const WARM_DEADLINE_MS = 4000;        // how long one card lookup will wait on a whole-set warm
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _warmFailed = new Map();
const warmFailedRecently = (setId) => Date.now() - (_warmFailed.get(setId) || 0) < WARM_RETRY_MS;
const noteWarmFailure = (setId) => { _warmFailed.set(setId, Date.now()); };

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
    // Survives the trim on purpose: it is how a served index can say it is a stand-in, and how the
    // graduation check below recognises one without re-reading the file.
    ...(c.__source ? { __source: c.__source } : {}),
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
  if (!(typeof totalCount === 'number' && totalCount > 0)) return true;
  // Count DISTINCT cards, not ROWS. A paged fetch can come back exactly the right length and still
  // be wrong, and counting rows is what made that permanent: measured 2026-08-23 on me2pt5
  // (Ascended Heroes, 295 cards), `orderBy=number` made page 2 re-serve 45 rows already on page 1.
  // The result was 295 rows long, so it passed this check, so it was written to a cache that never
  // expires — holding 250 unique cards, 45 duplicates, and nothing at all above #250. The set
  // looked complete everywhere and every card past 250 was unlistable.
  const seen = new Set();
  for (const c of cards) seen.add(String((c && (c.id != null ? c.id : c.number)) || ''));
  return seen.size >= totalCount;
}

// Two rows sharing a card id cannot happen in a real set — it only happens when a paged fetch
// re-served rows it had already given. Exported so the unit suite can pin it.
export function hasDuplicateCards(cards) {
  if (!Array.isArray(cards) || !cards.length) return false;
  const seen = new Set();
  for (const c of cards) {
    const k = String((c && (c.id != null ? c.id : c.number)) || '');
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

// Keep the FIRST row per card id and drop the repeats. A duplicate row is not a harmless extra —
// it is a phantom card in the grid and an inflated count that reads as "complete".
export function dedupeCards(cards) {
  if (!Array.isArray(cards)) return cards;
  const seen = new Set();
  return cards.filter((c) => {
    const k = String((c && (c.id != null ? c.id : c.number)) || '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// fresh: { cards, totalCount } from upstream, or null when every attempt failed.
// cached: { at, cards } from disk, or null.
export const decideCardsResponse = (fresh, cached, nowIso) =>
  decideSetResponse(fresh, cached, nowIso, (f) => isCompleteSet(f.cards, f.totalCount));

// A copy built from the BACKUP source is a stand-in, not the record. Serving it is right; leaving
// it there forever is not — this cache never expires, so without a way back a set rescued during
// one outage would still be TCGdex's a year later. So a re-check of the real source is kicked off
// BEHIND whatever answer just went out, and the set graduates on its own the moment pokemontcg.io
// recovers. Same shape as the PriceCharting→pokemontcg graduation in lib/catalog.mjs.
//
// Only a completed upstream write counts (`got.store`); anything else re-arms the throttle, so a
// still-dead source is asked at most once a minute rather than once per request.
export const isBackupCopy = (cards) => !!(Array.isArray(cards) && cards.length && cards[0] && cards[0].__source === 'tcgdex');
function gradeIfBackup(env, setId, cards) {
  if (!isBackupCopy(cards) || warmFailedRecently(setId)) return false;
  Promise.resolve()
    .then(() => getSetCards(env, setId, { refresh: true }))
    .then((got) => { if (!got || !got.store) noteWarmFailure(setId); })
    .catch(() => noteWarmFailure(setId));
  return true;
}

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
    // NO orderBy. `orderBy=number` is a STRING sort upstream (runner-core numRank exists because of
    // it) so it buys no useful order, and it BREAKS PAGING: with it, page 2 of me2pt5 came back as
    // 45 rows already served on page 1. Without it, page 1 is #1-250 and page 2 is #251-295, clean,
    // and the rows arrive numerically ordered anyway. Both measured 2026-08-23. The grid re-ranks
    // client-side regardless (cmpRank), so nothing here depends on upstream order.
    const url = UPSTREAM + '?q=' + encodeURIComponent('set.id:' + setId) + '&pageSize=' + PAGE_SIZE + '&page=' + page;
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
    // SELF-HEAL. This cache never expires, so a bad copy written before the paging fix would be
    // served forever with no way to notice — and one was: me2pt5 held 295 rows, 250 unique, nothing
    // above #250. Two rows with the same card id is impossible in a real set, so it can only mean a
    // duplicate-inflated fetch. Ignore the copy and go upstream rather than wait to be told.
    if (disk && hasDuplicateCards(disk.cards)) {
      console.warn('[' + LABEL + ']', setId, '— cached copy has duplicate cards (pre-fix paging); refetching');
    } else if (disk) { gradeIfBackup(env, setId, disk.cards); return { cards: disk.cards, at: disk.at, source: 'disk' }; }
  }
  // A copy proven corrupt must not come back as the last-good fallback either. Serving it was the
  // gap in the first cut of this fix: the refetch above goes upstream, pokemontcg.io answers 500
  // (measured 3 of 4 on 2026-08-24), decideCardsResponse falls back to the stored copy — and hands
  // over the very rows we just detected as duplicates. Deduped, the fallback is 250 real cards
  // instead of 295 rows containing 45 phantoms, and because the copy still fails the completeness
  // check, every request keeps trying upstream until a clean fetch lands.
  const fallback = (() => {
    const d = readSetCache(setId);
    if (!d || !hasDuplicateCards(d.cards)) return d;
    return { ...d, cards: dedupeCards(d.cards) };
  })();
  const d = await withInflight(_inflight, setId, async () => {
    const now = new Date().toISOString();
    const fresh = await fetchSetCards(env, setId);
    // Nothing from pokemontcg.io AND nothing on disk: the set is simply unavailable, which is what
    // left the Batch Runner unable to start a pile at all on 2026-08-31 — both its entry modes read
    // one per-set index and there was no index to read. Ask the backup source for the whole set.
    // Only in that corner: a stale copy on disk is still OUR data and beats a substitute.
    const backup = (!fresh && !fallback) ? await fetchTcgdexSetCards(setId) : null;
    const decided = decideCardsResponse(fresh || backup, fallback, now);
    if (decided.store) { writeSetCache(setId, decided.at, decided.cards); _mem.delete(setId); }
    else if (decided.stale) console.warn('[' + LABEL + ']', setId, '— upstream is down, serving the copy from', decided.at);
    return { ...decided, backup: !fresh && !!backup };
  });
  return { cards: d.cards, at: d.at, source: d.source, stale: !!d.stale, partial: !!d.partial, store: !!d.store, backup: !!d.backup };
}

// One card out of a set we already hold. Used to answer /api/pkm/cards/:id without touching
// pokemontcg.io: once a set has been loaded anywhere in the suite, every card lookup in every
// builder is a local read. Returns null when we do not have the set, so the caller falls through —
// and when we do, the copy's age comes back with it, because the prices inside it have a shelf life
// even though the card does not.
export function cachedCardById(cardId) {
  const id = String(cardId || '').trim();
  const dash = id.lastIndexOf('-');
  if (dash < 1) return null;
  const setId = id.slice(0, dash);
  if (!isSetId(setId)) return null;
  const disk = readSetCache(setId);
  if (!disk) return null;
  const card = disk.cards.find((c) => c && c.id === id);
  return card ? { card, setId, at: disk.at } : null;
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
          if (warm && hasSetCache(setId)) { agePrices(env, setId, warm.at); gradeIfBackup(env, setId, warm.cards); return send(res, 200, body(setId, warm.at, warm.cards, 'memory'), 'memory'); }
          if (warm) _mem.delete(setId);            // the file went away: so does the copy of it
          const disk = readSetCache(setId);
          if (disk) {
            const trimmed = disk.cards.map(trimCard);
            _mem.set(setId, { at: disk.at, cards: trimmed });
            agePrices(env, setId, disk.at);
            gradeIfBackup(env, setId, disk.cards);
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

      // tcgplayer.prices rides inside every cached card, and it is not just decoration here: the
      // batch runner flags a row when its eBay comps disagree with the TCGplayer market by more than
      // 2.5×. A frozen market figure would turn that quality check into noise, so an old copy is
      // refreshed behind whatever answer just went out.
      function agePrices(env, setId, at) {
        if (refreshIfPricesAreStale(at, () => getSetCards(env, setId, { refresh: true }))) _mem.delete(setId);
      }

      // Every single-card lookup in the suite goes through /api/pkm/cards/:id first — the builder,
      // the uploader and the grader all share that ladder (extras.js pkmLookupCard). It was a bare
      // proxy call, so listing thirty cards out of one set meant thirty round trips to a source that
      // regularly 500s, for cards already sitting in a file on this machine. Answer from that file
      // when we have it; anything we do not have falls through to the proxy untouched.
      server.middlewares.use('/api/pkm/cards', async (req, res, next) => {
        const [urlPath, search] = String(req.url || '/').split('?');
        const m = /^\/([^/?]+)$/.exec(urlPath || '');
        if (req.method !== 'GET' || !m) return next();
        // The price tracker asks for the real thing (see BYPASS_HEADER) — it is recording history,
        // not reading a card, so a stored copy is exactly what it must not get.
        if (wantsFresh(req)) return next();
        const id = decodeURIComponent(m[1]);
        // ?refresh=1 is the builders' refresh button. It re-fetches the whole SET the card belongs
        // to, because that is the unit this cache stores — one card cannot be refreshed on its own.
        let state = 'disk';
        if (new URLSearchParams(search || '').get('refresh') === '1') {
          const dash = id.lastIndexOf('-');
          const setId = dash > 0 ? id.slice(0, dash) : '';
          if (isSetId(setId)) {
            _mem.delete(setId);
            const got = await getSetCards(env, setId, { refresh: true });
            // Report what the refresh actually achieved. Answering 'disk' either way would hide a
            // refresh that went out, failed, and served the same copy back — which is the one
            // outcome the person pressing the button needs to know about.
            state = got.stale ? 'stale' : got.source === 'upstream' ? 'upstream' : 'disk';
          }
        }
        let hit = cachedCardById(id);
        // A COLD SET used to fall straight through to the bare proxy, which meant a card from a set
        // nobody had opened yet was one pokemontcg.io 500 away from unlistable. On 2026-08-31 it
        // was exactly that: rsv10pt5-162 asked for fifteen times in four minutes, refused every
        // time, while both stock tools sat unusable. Two rungs now stand before the proxy.
        if (!hit) {
          const dash = id.lastIndexOf('-');
          const setId = dash > 0 ? id.slice(0, dash) : '';
          // 1. Warm the whole SET — the unit this cache stores. One fetch answers this lookup and
          //    every other card in the same pile, and getSetCards already knows how to fall back to
          //    its last-good copy when upstream is unwell.
          //    It is RACED against a short deadline, and the race is the point: a cold set with
          //    upstream unwell is twenty paged fetches, each with its own retries — measured at 61
          //    SECONDS on 2026-08-31 — and nobody types a card number expecting to wait a minute.
          //    The warm is not cancelled when it loses, so its copy still lands on disk and the
          //    next card in the same pile is instant.
          if (isSetId(setId) && !warmFailedRecently(setId)) {
            const warm = getSetCards(env, setId).then(
              (got) => { if (!got || !got.cards) noteWarmFailure(setId); return got; },
              () => { noteWarmFailure(setId); return null; },
            );
            const got = await Promise.race([warm, sleep(WARM_DEADLINE_MS).then(() => null)]);
            if (got && got.cards) {
              hit = cachedCardById(id);
              if (hit) state = got.stale ? 'stale' : got.source === 'upstream' ? 'upstream' : 'disk';
            }
          }
          // 2. TCGdex — keyless, independent, and up on the day pokemontcg.io was not. Identity,
          //    art and TCGplayer prices, already shaped like pokemontcg.io's own single-card reply
          //    (lib/pkm-tcgdex.mjs). Last, so it never pre-empts the authoritative source.
          if (!hit) {
            const backup = await fetchTcgdexCardById(id);
            if (backup) {
              console.warn('[' + LABEL + ']', id, '— pokemontcg.io has nothing for us; answered from TCGdex');
              return send(res, 200, { data: backup, source: 'tcgdex' }, 'tcgdex');
            }
          }
        }
        if (!hit) return next();
        agePrices(env, hit.setId, hit.at);
        // Shaped exactly like pokemontcg.io's own single-card response, because that is what the
        // callers parse. Raw, not trimmed: this stands in for the upstream, so it answers like it.
        return send(res, 200, { data: hit.card }, state);
      });
    },
  };
}

function body(setId, at, cards, source, extra) {
  return { setId, count: cards.length, cachedAt: at, source, ...(extra || {}), cards };
}
const send = sendJson;
