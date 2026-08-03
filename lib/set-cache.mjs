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

export function sendJson(res, status, payload, cacheState) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-tcg-cache', cacheState);      // memory | disk | upstream | stale | none
  res.end(JSON.stringify(payload));
}
