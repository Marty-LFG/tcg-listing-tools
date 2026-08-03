// lib/set-cache.mjs — the mechanics behind "fetch a set's cards once, then keep them".
//
// Two games use this: Pokémon (lib/pkm-cards-cache.mjs, pokemontcg.io) and Lorcana
// (lib/lorcana-cards-cache.mjs, Lorcast). What differs between them is only the upstream — the URL
// shape, the paging, and what counts as a whole set. Everything else is identical and is here:
// where the file goes, how it is written, what to serve when upstream is down, and not fetching the
// same set twice at once.
//
// The rule that shapes all of it: THESE CACHES DO NOT EXPIRE. A released set's card list does not
// change, so nothing re-fetches on a timer — only an explicit refresh does. That makes a bad write
// permanent, which is why writing is gated on getting a whole set and why the file is written
// atomically. Everything here is about not learning something wrong.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A set id off the wire becomes a FILENAME, so it is whitelisted rather than escaped. Both APIs use
// lowercase alphanumeric ids with dots and hyphens (sv3, base1, swshp; Lorcast uses 1, 2, 3…).
const SET_ID_RE = /^[a-z0-9][a-z0-9.-]{0,40}$/i;
export const isSetId = (s) => SET_ID_RE.test(String(s || ''));

// Read the directory per call, not once at import: a test or a check harness points the env var at a
// temp folder so its stubbed cards never reach the real cache. They would never leave, either.
export function cacheDir(dirName, envVar) {
  return (envVar && process.env[envVar]) || path.join(ROOT, 'data', dirName);
}
export function cachePathFor(dirName, envVar, setId) {
  return path.join(cacheDir(dirName, envVar), String(setId).toLowerCase() + '.json');
}

export function readCache(dirName, envVar, setId) {
  if (!isSetId(setId)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(cachePathFor(dirName, envVar, setId), 'utf8'));
    return j && Array.isArray(j.cards) && j.cards.length ? j : null;
  } catch { return null; }
}
// The file is the record; anything held in memory is only a copy of it. Deleting a file is the
// obvious way to force one set to be fetched again, and it has to work without a restart.
export function hasCache(dirName, envVar, setId) {
  return isSetId(setId) && fs.existsSync(cachePathFor(dirName, envVar, setId));
}
export function writeCache(dirName, envVar, setId, at, cards, label) {
  if (!isSetId(setId)) return false;
  try {
    fs.mkdirSync(cacheDir(dirName, envVar), { recursive: true });
    // Temp file then rename: a crash mid-write would otherwise leave a truncated JSON file that
    // never expires, and the whole point of this cache is that nobody re-fetches it.
    const target = cachePathFor(dirName, envVar, setId);
    fs.writeFileSync(target + '.tmp', JSON.stringify({ v: 1, setId, at, count: cards.length, cards }));
    fs.renameSync(target + '.tmp', target);
    return true;
  } catch (e) { console.warn('[' + label + '] could not write the cache for', setId, '—', e?.message || e); return false; }
}

// What to serve, given a fresh fetch and whatever is already stored. `isComplete(fresh)` is the
// game's own answer to "is this the whole set?" — the one thing worth being strict about, because
// a partial set written here is a partial set forever.
//
// fresh: the upstream result, or null when every attempt failed. cached: { at, cards } | null.
export function decideSetResponse(fresh, cached, nowIso, isComplete) {
  if (fresh && isComplete(fresh)) return { store: true, status: 200, source: 'upstream', at: nowIso, cards: fresh.cards };
  // Upstream gave us nothing usable. A copy on disk beats an error every time.
  if (cached && cached.cards && cached.cards.length) {
    return { store: false, status: 200, source: 'disk', stale: true, at: cached.at, cards: cached.cards };
  }
  // A partial set is still something to look at, but it must never be written down.
  if (fresh && Array.isArray(fresh.cards) && fresh.cards.length) {
    return { store: false, status: 200, source: 'upstream', partial: true, at: nowIso, cards: fresh.cards };
  }
  return { store: false, status: 502, source: 'none', at: nowIso, cards: null };
}

// A set's card list is immutable. The PRICES riding along inside those cards are not, and every one
// of these APIs bundles them into the card object: SWU-DB MarketPrice, optcgapi market_price,
// pokemontcg.io tcgplayer.prices, Lorcast prices. The builders show those figures, and the batch
// runner cross-checks its eBay comps against the TCGplayer one — so a copy kept forever would go on
// quoting whatever the market said the day the set was first opened.
//
// Identity still never expires: a copy is always served immediately, however old, and nothing here
// can make a lookup wait or fail. But if the copy predates the window below, a refresh is kicked off
// behind the answer, so the next lookup carries current prices. One background fetch per set per
// day of actual use, and only for sets someone is really working with.
export const PRICE_REFRESH_MS = 24 * 60 * 60 * 1000;
export function refreshIfPricesAreStale(at, run) {
  const t = Date.parse(at || '');
  if (t && Date.now() - t < PRICE_REFRESH_MS) return false;
  Promise.resolve().then(run).catch(() => {});     // fire and forget — the caller already has an answer
  return true;
}

// THE ONE CALLER THAT MUST NOT BE CACHED: the price tracker.
//
// lib/collector.mjs walks the watchlist and fetches each card's price through the very paths these
// caches now answer (lib/normalize.mjs pricePath → /api/pkm/cards/:id, /api/mtg/cards/:set/:num and
// the rest). Serving those from a stored set would make every snapshot a copy of the last one:
// a price history that only moves when the cache does is not a price history, and the signals built
// on it — the buy flags, the downtrend alerts — would be reading their own echo.
//
// So the collector asks for the real thing with this header, and every cache steps aside. It is a
// header rather than a query parameter on purpose: it never reaches the upstream URL, so no API has
// to know or care that we asked.
export const BYPASS_HEADER = 'x-tcg-cache-bypass';
export const wantsFresh = (req) => String((req && req.headers && req.headers[BYPASS_HEADER]) || '') === '1';

// Collapse concurrent work on the same key: two tabs opening the same cold set fetch it once.
export function withInflight(map, key, run) {
  let job = map.get(key);
  if (!job) {
    job = Promise.resolve().then(run).finally(() => map.delete(key));
    map.set(key, job);
  }
  return job;
}

// A JSON GET with retries, a timeout and no throwing — the upstreams behind these caches are both
// prone to answering 500 with an HTML body, so the parse is part of the retry decision.
export async function fetchJsonRetry(url, { headers = {}, attempts = 3, timeoutMs = 20000, label = 'set-cache' } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers, signal: ac.signal });
      const text = await r.text();
      if (r.ok) { try { return JSON.parse(text); } catch { /* an HTML error page dressed as a 200 */ } }
      else console.warn('[' + label + ']', url, '→', r.status, 'attempt', attempt + '/' + attempts);
    } catch (e) {
      console.warn('[' + label + ']', url, 'attempt', attempt + '/' + attempts, '—', e?.message || e);
    } finally { clearTimeout(timer); }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  return null;
}

// Collector numbers are strings, and every one of these APIs pads them differently from the way a
// person types them — Lorcast '7', SWU-DB '059', Scryfall '1' vs '001'. So the compare is on the
// NUMBER when both sides are plain digits, and on the text otherwise, which keeps suffixed numbers
// like '12a' or '039b' distinct instead of collapsing them onto 12 and 39.
export function sameNumber(a, b) {
  const na = String(a == null ? '' : a).trim(), nb = String(b == null ? '' : b).trim();
  if (!na || !nb) return false;
  if (na.toLowerCase() === nb.toLowerCase()) return true;
  if (!/^\d+$/.test(na) || !/^\d+$/.test(nb)) return false;
  return parseInt(na, 10) === parseInt(nb, 10);
}
// Find one card in a cached set by its collector number. `field` differs per game.
export function findByNumber(cards, num, field) {
  return (cards || []).find((c) => c && sameNumber(c[field], num)) || null;
}

export function sendJson(res, status, payload, cacheState) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-tcg-cache', cacheState);      // memory | disk | upstream | stale | none
  res.end(JSON.stringify(payload));
}
