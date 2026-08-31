// lib/catalog.mjs — Vite plugin: read/write the Pokémon multi-language SEED overlay
// (data/pokemon-intl-seed.json) and rebuild the baked set index, powering catalog.html's
// "Edit overlay" mode. Mirrors the inventory/sealed plugin shape (plain connect middleware,
// registered in vite.config.js `plugins`). Ungated CRUD like the other inventory tools — it
// only writes the curated overlay + rebuilds catalog data the daily refresh already rebuilds
// (GR7: a failed rebuild keeps the existing baked catalog, and the save is reported separately).
//
// English is intentionally NOT editable: EN sets are live from pokemontcg.io, not the overlay.
//
// Routes (mounted at /api/catalog):
//   GET    /seed                          -> { seed, path }                     (full overlay)
//   POST   /seed  { lang, code, entry, rebuild? } -> upsert seed[lang][CODE], then rebuild
//   DELETE /seed  { lang, code }          -> remove seed[lang][CODE], then rebuild
//   POST   /rebuild                       -> rebuild the baked index only
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPokemonIntlSets } from '../scripts/build-pokemon-intl-sets.mjs'
import { openDb } from './db.mjs'
import { enumerateConsole } from './pricecharting.mjs'
import { tcgdexSetIdFor } from './pkm-tcgdex.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED_PATH = path.join(ROOT, 'data', 'pokemon-intl-seed.json')
const SETS_PATH = path.join(ROOT, 'data', 'pokemon-intl-sets.json')
const LANGS = ['ja', 'zh-cn', 'zh-tw', 'ko']            // EN is live (pokemontcg.io), never seeded
const STR_FIELDS = ['name_en', 'name_native', 'serie', 'releaseDate']

const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); }
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const loadSeed = () => { try { return JSON.parse(readFileSync(SEED_PATH, 'utf8')); } catch { return {}; } }
function writeSeed(seed) { const tmp = SEED_PATH + '.tmp'; writeFileSync(tmp, JSON.stringify(seed, null, 2)); renameSync(tmp, SEED_PATH); }

// Keep only the known overlay fields; drop empties. enEquivalent kept only if id or name present.
//
// pcSlug is here because a NAME alone is not always enough. mergePcConsoles finds a console by
// slugifying name_en and matching it against the console DIRECTORY — but that directory is a
// curated, incomplete index: of the consoles reconciled on 2026-08-23, more than half existed only
// as a direct URL and were absent from it. Those sets can only be reached by pinning the slug, so
// without this field the editor could fix the easy half and nothing else.
function cleanEntry(raw) {
  const e = {};
  for (const f of STR_FIELDS) { const v = raw && typeof raw[f] === 'string' ? raw[f].trim() : ''; if (v) e[f] = v; }
  const slug = raw && typeof raw.pcSlug === 'string' ? raw.pcSlug.trim().toLowerCase() : '';
  if (slug) e.pcSlug = slug;
  if (raw && raw.enEquivalent && typeof raw.enEquivalent === 'object') {
    const id = String(raw.enEquivalent.id || '').trim(), name = String(raw.enEquivalent.name || '').trim();
    if (id || name) e.enEquivalent = { id, name };
  }
  return e;
}

// ---- card-list cache + per-source fetchers (GET /api/catalog/cards) --------------------------
// One normalized card shape for all three sources; the drawer adds numN + owned client-side.
const CARDS_GAME = 'pokemon';

function setCardsGet(db, lang, setCode, ttlHours) {
  try {
    const r = db.prepare(`SELECT payload, source, fetched_at FROM set_cards
      WHERE game=? AND lang=? AND set_code=? AND fetched_at >= datetime('now', ?)`)
      .get(CARDS_GAME, lang, setCode, `-${ttlHours} hours`);
    return r && r.payload ? { cards: JSON.parse(r.payload), source: r.source, at: r.fetched_at } : null;
  } catch { return null; }
}
function setCardsLast(db, lang, setCode) {                          // ignore TTL — GR7 last-good copy
  try {
    const r = db.prepare(`SELECT payload, source, fetched_at FROM set_cards WHERE game=? AND lang=? AND set_code=?`)
      .get(CARDS_GAME, lang, setCode);
    return r && r.payload ? { cards: JSON.parse(r.payload), source: r.source, at: r.fetched_at } : null;
  } catch { return null; }
}
function setCardsPut(db, lang, setCode, source, cards) {
  try {
    db.prepare(`INSERT INTO set_cards (game, lang, set_code, fetched_at, http_status, source, card_count, stale, payload)
      VALUES (?,?,?,datetime('now'),200,?,?,0,?)
      ON CONFLICT(game, lang, set_code) DO UPDATE SET
        fetched_at=datetime('now'), http_status=200, source=excluded.source,
        card_count=excluded.card_count, stale=0, payload=excluded.payload`)
      .run(CARDS_GAME, lang, setCode, source, cards.length, JSON.stringify(cards));
  } catch (e) { console.warn('[catalog] set_cards write failed —', e?.message || e); }
}
// Drop the cached card list for one set so the next /cards load re-fetches live (used by the
// diagnostics cache-clear endpoint after a source/parser fix). Returns rows deleted. Never throws.
export function clearSetCardsRow(lang, setCode) {
  try {
    return openDb().prepare('DELETE FROM set_cards WHERE game=? AND lang=? AND set_code=?')
      .run(CARDS_GAME, lang, setCode).changes;
  } catch (e) { console.warn('[catalog] set_cards clear failed —', e?.message || e); return 0; }
}

async function fetchJson(u, headers) {
  const r = await fetch(u, { headers: { accept: 'application/json', ...(headers || {}) } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// Market value (mirrors catalog.html enPrice): tcgplayer USD first, then cardmarket EUR.
function enPrice(c) {
  const tp = c.tcgplayer && c.tcgplayer.prices;
  if (tp) for (const k of ['holofoil', 'reverseHolofoil', 'normal', '1stEditionHolofoil', 'unlimitedHolofoil'])
    if (tp[k] && tp[k].market != null) return { val: tp[k].market, label: 'US$' + tp[k].market.toFixed(2), cur: 'USD' };
  const cm = c.cardmarket && c.cardmarket.prices;
  if (cm && cm.averageSellPrice != null) return { val: cm.averageSellPrice, label: '€' + cm.averageSellPrice.toFixed(2), cur: 'EUR' };
  return null;
}
// Accumulate all pages from a `{ data, totalCount }` paginated JSON endpoint. Stops on a short page
// (< pageSize = the last one) or once totalCount is reached; a hard maxPages cap prevents a runaway
// loop. Pure over the injected fetchPage(page)->json, so it is unit-testable offline. Exported.
export async function paginateJson(fetchPage, pageSize, maxPages = 40) {
  const data = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = await fetchPage(page);
    const batch = (j && j.data) || [];
    data.push(...batch);
    if (batch.length < pageSize) break;                             // last (partial) page
    if (j && j.totalCount != null && data.length >= j.totalCount) break;   // collected everything
  }
  return data;
}

// Decide the /cards response from freshly-fetched cards + (only when empty) the last-good copy.
// An empty-but-OK upstream (a set re-indexing returns HTTP 200 with no cards) doesn't throw, so the
// handler's catch-block fallback never fires — without this it would show the set as empty and could
// poison the cache with []. So: cards present → store + serve fresh; empty + a stored copy → serve
// that copy flagged stale (do NOT overwrite it); empty + nothing stored → the empty result (GR7 /
// bug #5). `store` tells the caller whether to setCardsPut. Pure; exported for the unit harness.
export function decideCardsResponse(cards, source, lastGood, nowIso) {
  if (cards.length) return { store: true, body: { cards, source, stale: false, cached: false, cachedAt: nowIso, count: cards.length } };
  if (lastGood) return { store: false, body: { cards: lastGood.cards, source: lastGood.source, stale: true, cached: true, cachedAt: lastGood.at, count: lastGood.cards.length } };
  return { store: false, body: { cards, source, stale: false, cached: false, cachedAt: nowIso, count: cards.length } };
}

// EN cards from pokemontcg.io. The vite /api/pkm proxy isn't reachable from middleware — hit the host.
// pokemontcg.io caps pageSize at 250, so sets larger than that (e.g. sv2 = 279) MUST be paged or the
// tail (usually the high-number secret/illustration rares) is silently dropped and then cached as
// "complete" for 24h.
async function fetchEnCards(setId, env) {
  const headers = env && env.POKEMONTCG_API_KEY ? { 'X-Api-Key': env.POKEMONTCG_API_KEY } : {};
  const PAGE = 250;
  const data = await paginateJson((page) => fetchJson(
    'https://api.pokemontcg.io/v2/cards?q=set.id:' + encodeURIComponent(setId) + '&pageSize=' + PAGE + '&page=' + page, headers), PAGE);
  return data.map((c) => {
    const numRaw = String(c.number || ''); const pr = enPrice(c);
    return { numRaw: numRaw.replace(/^0+(?=\d)/, '') || numRaw, name: c.name || '', rarity: c.rarity || '',
      priceVal: pr ? pr.val : null, price: pr ? pr.label : null, priceCur: pr ? pr.cur : null,
      img: (c.images && (c.images.small || c.images.large)) || '', imgLarge: (c.images && c.images.large) || '', source: 'pokemontcg' };
  });
}
// Intl cards from TCGdex (indexed sets). image is a base URL; often absent on brand-new sets.
async function fetchTcgdexCards(lang, id) {
  const j = await fetchJson('https://api.tcgdex.net/v2/' + encodeURIComponent(lang) + '/sets/' + encodeURIComponent(id));
  return ((j && j.cards) || []).map((c) => {
    const numRaw = String(c.localId || c.id || '');
    // `img` is a DISPLAY thumbnail and stays webp — smaller, and every browser this runs in takes
    // it. `imgLarge` is the LISTING image: the stock tools hand it to runPublish, which downloads
    // the bytes and pushes them to eBay EPS, and webp is not among the formats eBay documents as
    // accepted (JPEG/PNG/GIF/BMP/TIFF). It only ever became JPEG when the compositor happened to
    // run, so an un-composited listing was one silent rejection away. PNG is what the server-side
    // resolveIntlImage (lib/inventory.mjs) has always asked TCGdex for, for exactly this reason.
    return { numRaw, name: c.name || '', rarity: '', priceVal: null, price: null, priceCur: null,
      img: c.image ? c.image + '/low.webp' : '', imgLarge: c.image ? c.image + '/high.png' : '', source: 'tcgdex' };
  });
}
// Seeded / PriceCharting-only sets (M4/M5): enumerate the PC console — English names + numbers +
// full-res images, already disk-cached 12h with a stale-safe fallback. Images route via /api/img.
async function fetchPcCards(pcSlug) {
  const r = await enumerateConsole(pcSlug);
  return (r.cards || []).map((c) => {
    const cents = c.prices && c.prices.ungraded != null ? c.prices.ungraded : null;   // raw/ungraded anchor (USD)
    return { numRaw: String(c.number || ''), name: c.name || '', rarity: '',
      priceVal: cents != null ? cents / 100 : null,
      price: cents != null ? 'US$' + (cents / 100).toFixed(2) : null,
      priceCur: cents != null ? 'USD' : null,
      img: c.image ? '/api/img?u=' + encodeURIComponent(c.image + '/320.jpg') : '', imgLarge: c.image ? c.image + '/1600.jpg' : '', source: 'pricecharting' };
  });
}

// Ordered card-source chain for ONE set. The SERVER decides where cards come from — never the
// client. A client that names a single source can strand a set indefinitely, and that is exactly
// how M6 Storm Emeralda spent three weeks unlistable: the batch runner sent `src=indexed`, TCGdex
// 404s a set it has not ingested, and the PriceCharting console it already had a pcSlug for was
// never tried. Source selection is a server concern because only the server knows which upstreams
// are actually answering right now.
//
// EN: pokemontcg.io is authoritative; PriceCharting covers the weeks before it catalogs a new set,
// so a set auto-GRADUATES the moment pokemontcg.io starts answering. Intl: TCGdex first (native
// names + the printing matrix), PriceCharting for everything TCGdex has not ingested yet.
//
// KO and ZH-CN then get one more step each, because for them the two sources above cover almost
// nothing. Measured 2026-08-23: TCGdex indexes those sets but serves ZERO cards on either lane
// (empty cards[], and the per-card endpoint 404s), and PriceCharting's directory holds 5 Korean
// consoles for 100 Korean sets and 22 Chinese for 66. So ~90 Korean and ~35 Chinese sets were
// pickable in the tools and had no card data anywhere.
//
//   ko    -> the JAPANESE TWIN. Korean releases mirror the Japanese line set-for-set under the SAME
//            code (98% of Korean codes exist in ja), and the rosters are identical — verified by
//            diffing the three sets PriceCharting happens to carry in both languages: M5 matched
//            118/118 on number+name, S6A 101/105, SV8A 237/239. Names and numbers therefore
//            transfer safely. IMAGES DO NOT, and fetchTwinCards strips them: PriceCharting does not
//            scan Korean cards, so the only picture available is a Japanese one, and shipping that
//            on a Korean listing shows the buyer a card they will not receive.
//   zh-cn -> 52poke (lib/wiki52poke.mjs). Chinese sets are NOT the Japanese line — only 12% share a
//            code — so the twin trick cannot work here and a real source was needed.
//
// Both are LAST in their chain, so a genuine Korean/Chinese console always wins.
// Pure; exported for the unit harness.
export function cardSourceChain(lang, { tcgdexId, pcSlug, twinSlug, cnName } = {}) {
  const chain = [];
  if (lang === 'en') {
    chain.push({ source: 'pokemontcg', kind: 'en' });
    if (pcSlug) chain.push({ source: 'pricecharting-early', kind: 'pc', slug: pcSlug });
    // TCGdex LAST on the English lane, and only when the server could join a set id for it
    // (lib/pkm-tcgdex.mjs). Until 2026-08-31 English had exactly two links, and on the day
    // pokemontcg.io answered 500 for hours every set without a pcSlug had nowhere left to go.
    // Last means it never pre-empts the authoritative source: a set graduates straight back the
    // moment pokemontcg.io answers again, exactly as it does off PriceCharting today.
    if (tcgdexId) chain.push({ source: 'tcgdex', kind: 'tcgdex', id: tcgdexId });
    return chain;
  }
  if (tcgdexId) chain.push({ source: 'tcgdex', kind: 'tcgdex', id: tcgdexId });
  if (pcSlug) chain.push({ source: 'pricecharting', kind: 'pc', slug: pcSlug });
  if (lang === 'ko' && twinSlug) chain.push({ source: 'japanese-twin', kind: 'twin', slug: twinSlug });
  if (lang === 'zh-cn' && cnName) chain.push({ source: '52poke', kind: 'cn', name: cnName });
  return chain;
}

// Walk the chain until a step returns cards. A step that THROWS must NOT end the walk — a 404 for
// a set an upstream has never heard of is the ordinary case, and it means "not here, try the next
// one", not "this set is broken". Only once every step has failed does the caller fall back to the
// stored copy. Pure over the injected run(step) -> cards. Exported for the unit harness.
export async function runCardSourceChain(chain, run) {
  const errors = [];
  for (const step of chain) {
    try {
      const cards = await run(step);
      if (cards && cards.length) return { cards, source: step.source, error: null, errors: [] };
    } catch (e) { errors.push(String(e?.message || e)); }
  }
  return { cards: [], source: 'none', error: errors.length ? new Error(errors[errors.length - 1]) : null, errors };
}

// "This set has no cards" and "we could not ask" are completely different facts, and conflating them
// makes the watchdog worthless. Proven live 2026-08-23: a keyless run against pokemontcg.io drew
// 108 HTTP 500/502s in one pass, which the first cut of this reported as 108 unlistable sets. An
// alert that cries wolf on its first outage is worse than no alert, so a transient upstream failure
// is its OWN state and never counts as a gap. Pure; exported for the unit harness.
const TRANSIENT_RE = /HTTP (?:408|425|429|5\d\d)|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i;
export function classifyCoverage(cardCount, errors = []) {
  if (cardCount > 0) return 'ok';
  if ((errors || []).some((e) => TRANSIENT_RE.test(String(e)))) return 'unavailable';
  return 'gap';
}

// Korean cards from the JAPANESE twin's console: identical numbering and identical card names, with
// every IMAGE stripped. Korean releases are the Japanese line reprinted under the same set code, so
// the roster transfers; the picture does not, because PriceCharting only scans the Japanese print.
// A Korean listing carrying a Japanese scan shows the buyer a card they will not receive, and no
// amount of set-level correctness makes that acceptable — so the fields are blanked here, at the
// source, rather than trusted to every downstream caller to remember.
export function stripTwinImages(cards) {
  return (cards || []).map((c) => ({ ...c, img: '', imgLarge: '', source: 'japanese-twin' }));
}
async function fetchTwinCards(pcSlug) { return stripTwinImages(await fetchPcCards(pcSlug)); }

// Simplified-Chinese cards from 52poke. Names arrive CHINESE and go out English wherever the shared
// species map can resolve them (~76% of a set; the rest are Trainers and Energy, which have no
// species to look up and keep their native name — exactly what the Japanese lane already does in
// STOCK_GAME_ADAPTERS.pokemon). No prices and no images exist on that source, so both stay empty
// rather than being faked.
async function fetchCnWikiCards(nameNative) {
  const [{ fetchCnSetCards }, { englishCardName }] = await Promise.all([
    import('./wiki52poke.mjs'), import('./pokemon-intl.mjs'),
  ]);
  const dex = readJson(path.join(ROOT, 'data', 'pokemon-dex-en.json'), {});
  const { cards } = await fetchCnSetCards(nameNative);
  return cards.map((c) => ({
    numRaw: c.numRaw, name: englishCardName({ name: c.name }, dex, 'zh-cn') || c.name,
    nameNative: c.name, rarity: c.rarity || '',
    priceVal: null, price: null, priceCur: null, img: '', imgLarge: '', source: '52poke',
  }));
}

// The baked set index, memoised on mtime — the chain needs it to find a Korean set's Japanese twin
// and a Chinese set's native name, and re-parsing ~90 KB per request would be silly.
let _idxCache = { at: 0, data: null };
function bakedIndex() {
  try {
    const at = statSync(SETS_PATH).mtimeMs;
    if (_idxCache.data && _idxCache.at === at) return _idxCache.data;
    _idxCache = { at, data: JSON.parse(readFileSync(SETS_PATH, 'utf8')) };
    return _idxCache.data;
  } catch { return _idxCache.data || {}; }
}
// A Korean set's Japanese twin is the ja set with the SAME printed code.
export function twinSlugFor(lang, setCode, idx) {
  if (lang !== 'ko' || !setCode) return '';
  const ja = ((idx || bakedIndex()).ja) || [];
  const hit = ja.find((s) => String(s.code || '').toUpperCase() === String(setCode).toUpperCase());
  return (hit && hit.pcSlug) || '';
}
// 52poke is keyed on the set's Chinese name, which only the baked index knows.
export function cnNameFor(lang, setCode, idx) {
  if (lang !== 'zh-cn' || !setCode) return '';
  const list = ((idx || bakedIndex())['zh-cn']) || [];
  const hit = list.find((s) => String(s.code || '').toUpperCase() === String(setCode).toUpperCase());
  return (hit && hit.name_native) || '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pre-warm set_cards for every baked JP/CN/KO set that has a PriceCharting slug — the seeded/pcOnly
// sets whose on-demand load is slowest + rate-limited. Serial + delayed (polite to PriceCharting;
// enumerateConsole's 12h disk cache makes repeat runs cheap). Skips sets already fresh (<24h in
// set_cards). Opt-in via a 'catalog-cards' bake in lib/refresh.mjs (NOT in the default set).
export async function prewarmCatalogCards({ delayMs = 500, langs = LANGS } = {}) {
  const db = openDb();
  let idx = {};
  try { idx = JSON.parse(readFileSync(SETS_PATH, 'utf8')); } catch { return { summary: 'no baked set index', warmed: 0 }; }
  const targets = [];
  for (const lang of langs) for (const r of (idx[lang] || [])) {
    if (r && r.pcSlug && (r.code || r.pcSlug)) targets.push({ lang, setCode: r.code || r.pcSlug, pcSlug: r.pcSlug });
  }
  let warmed = 0, fresh = 0, empty = 0;
  for (const t of targets) {
    if (setCardsGet(db, t.lang, t.setCode, 24)) { fresh++; continue; }
    try {
      const cards = await fetchPcCards(t.pcSlug);
      if (cards.length) { setCardsPut(db, t.lang, t.setCode, 'pricecharting', cards); warmed++; }
      else empty++;
    } catch { empty++; }
    if (delayMs) await sleep(delayMs);
  }
  return { summary: `${warmed} warmed, ${fresh} fresh, ${empty} empty/failed of ${targets.length} PC sets`, warmed };
}

// ---- coverage watchdog (GET-nothing, prove-everything) ---------------------------------------
// Before this existed the system could tell you a FILE was old. It could not tell you a SET was
// missing — there was no expected-set list, no diff, and no check that a set in the index actually
// resolves to cards. So M6 Storm Emeralda sat in the index, with a working PriceCharting slug, and
// answered "no cards returned" for three weeks with nothing anywhere going red.
//
// This resolves each recent set through the SAME chain the clients use and records what came back.
// A set that resolves to zero cards is a real, nameable state now.
const COVERAGE_PATH = path.join(ROOT, 'data', 'pokemon-coverage.json')
const COVERAGE_RECENT_DAYS = 120

const dayMs = 86400000
// pokemontcg.io prints YYYY/MM/DD, TCGdex + the seed print YYYY-MM-DD. Anything else -> NaN.
const setReleaseMs = (s) => Date.parse(String(s || '').replace(/\//g, '-'))

// Every set the watchdog could prove, ranked by how much proving it needs. Checking all ~600 on
// every run would be a stampede against a keyless scraper we are a guest of; checking only the new
// ones would never notice an old set going dark. So: rank, check the top `max`, and CARRY FORWARD
// the rest of last run's verdicts so the picture stays complete. Anything deferred is returned and
// logged — a bounded run must never read as "everything is fine".
//
// Ranks, most urgent first:
//   0  no lookup route at all — the most broken state there is, and free to detect (no fetch)
//   1  released recently — a new set is where coverage actually breaks
//   2  was a gap last run — did it heal?
//   3  never checked — includes a PriceCharting-only set that just appeared with no release date,
//      which is the M6 shape and would be invisible to a release-date rule
//   4  checked OK, but longer ago than recheckOkDays
//   -  checked OK recently — skip
// Pure; exported for the unit harness.
export function coverageTargets({ intl = {}, enSets = [], earlyEn = [], priorRows = [] }, nowMs, opts = {}) {
  const { recentDays = COVERAGE_RECENT_DAYS, recheckOkDays = 14, max = 250 } = opts
  const cutoff = nowMs - recentDays * dayMs
  const recheckCutoff = nowMs - recheckOkDays * dayMs
  const recent = (d) => { const t = setReleaseMs(d); return Number.isNaN(t) ? false : t >= cutoff }
  const prior = new Map((priorRows || []).map((r) => [r.lang + ':' + r.code, r]))

  const cand = []
  for (const lang of LANGS) {
    for (const r of (intl[lang] || [])) {
      if (!r) continue
      cand.push({
        lang, setCode: r.code || r.pcSlug || '', name: r.name_en || r.name_native || r.code || r.pcSlug || '',
        tcgdexId: r.tcgdexId || '', pcSlug: r.pcSlug || '', releaseDate: r.releaseDate || '',
      })
    }
  }
  // EN is live from pokemontcg.io and has no baked index to walk — use the cached set list, plus any
  // pre-release set the early-EN overlay is carrying (those resolve via PriceCharting).
  //
  // Unlike the intl lanes, EN's set list and EN's card data come from the SAME upstream, so a set
  // appearing in the list all but guarantees its cards resolve — there is very little to discover by
  // re-proving Base Set. Walking all 174 every cycle just rate-limits us out of the API we depend on
  // (measured: 108 HTTP 500/502 in one keyless pass). So EN earns a check only when it is new, still
  // pre-release, or was already failing.
  for (const s of enSets) {
    if (!s || !s.id) continue
    const p = prior.get('en:' + s.id)
    if (!recent(s.releaseDate) && !(p && !p.ok)) continue
    cand.push({ lang: 'en', setCode: s.id, name: s.name || s.id, tcgdexId: '', pcSlug: '', releaseDate: s.releaseDate || '' })
  }
  for (const s of earlyEn) {
    if (!s || !s.code) continue
    cand.push({ lang: 'en', setCode: s.code, name: s.name || s.code, tcgdexId: '', pcSlug: s.pcSlug || '', releaseDate: s.releaseDate || '' })
  }

  const seen = new Set()
  const ranked = []
  for (const t of cand) {
    const k = t.lang + ':' + t.setCode
    if (!t.setCode || seen.has(k)) continue          // an early-EN set that graduated is in both lists
    seen.add(k)
    const p = prior.get(k)
    const noRoute = t.lang !== 'en' && !t.tcgdexId && !t.pcSlug
    let rank
    if (noRoute) rank = 0
    else if (recent(t.releaseDate)) rank = 1
    else if (p && !p.ok) rank = 2
    else if (!p) rank = 3
    else if (!(Date.parse(p.checkedAt) >= recheckCutoff)) rank = 4
    else continue                                     // proven good, recently — leave it alone
    ranked.push({ ...t, rank, noRoute, prior: p || null })
  }
  ranked.sort((a, b) => a.rank - b.rank || String(a.lang).localeCompare(b.lang) || String(a.setCode).localeCompare(b.setCode))
  // Rank 0 needs no network, so it never spends budget.
  const free = ranked.filter((t) => t.rank === 0)
  const paid = ranked.filter((t) => t.rank !== 0)
  return { targets: free.concat(paid.slice(0, max)), deferred: paid.slice(max), skipped: cand.length - ranked.length }
}

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }

// Run the watchdog: resolve every target, write data/pokemon-coverage.json, return the gaps.
// Serial + delayed for the same reason prewarm is (polite to PriceCharting; the 12h disk cache makes
// repeat runs cheap). Warms set_cards as a side effect, so this doubles as a pre-warm for new sets.
export async function checkPokemonCoverage({ delayMs = 400, env = {}, now = Date.now(), max = 250 } = {}) {
  const intl = readJson(SETS_PATH, {})
  const pkmCache = readJson(path.join(ROOT, 'data', 'pkm-cache', 'sets.json'), null)
  const enSets = (pkmCache && pkmCache.body && pkmCache.body.data) || []
  const earlyEn = (readJson(path.join(ROOT, 'data', 'pokemon-en-early.json'), {}) || {}).sets || []
  const priorRows = (readJson(COVERAGE_PATH, {}) || {}).sets || []
  const { targets, deferred } = coverageTargets({ intl, enSets, earlyEn, priorRows }, now, { max })
  if (!targets.length && !priorRows.length) return { summary: 'no sets to check', checked: 0, gaps: [], rows: [] }

  const db = openDb()
  const checkedAt = new Date(now).toISOString()
  const rows = []
  for (const t of targets) {
    // Same chain the request handler builds, twin/52poke steps included — a watchdog that checks a
    // narrower chain than the tools use would report gaps that are not there.
    const chain = cardSourceChain(t.lang, {
      tcgdexId: t.tcgdexId, pcSlug: t.pcSlug,
      twinSlug: twinSlugFor(t.lang, t.setCode, intl), cnName: cnNameFor(t.lang, t.setCode, intl),
    })
    let cards = [], source = 'none', error = null, errors = []
    const cached = chain.length ? setCardsGet(db, t.lang, t.setCode, 24) : null
    if (cached) { cards = cached.cards; source = cached.source }
    else if (chain.length) {
      const got = await runCardSourceChain(chain, (step) => (
        step.kind === 'en' ? fetchEnCards(t.setCode, env)
          : step.kind === 'tcgdex' ? fetchTcgdexCards(t.lang, step.id)
            : step.kind === 'twin' ? fetchTwinCards(step.slug)
              : step.kind === 'cn' ? fetchCnWikiCards(step.name)
                : fetchPcCards(step.slug)
      ))
      cards = got.cards; source = got.source
      errors = got.errors || []
      error = got.error ? String(got.error?.message || got.error) : null
      if (cards.length) setCardsPut(db, t.lang, t.setCode, source, cards)
      if (delayMs) await sleep(delayMs)
    }
    // No chain at all is worth saying in words: it is not "the fetch failed", it is "there is
    // nowhere to fetch FROM", and the fix is a pcSlug in the seed rather than a retry.
    const why = chain.length ? error : 'no lookup route — neither a TCGdex id nor a PriceCharting console'
    const status = chain.length ? classifyCoverage(cards.length, errors) : 'gap'
    // GR7: an upstream we could not reach must never overwrite a verdict we already earned. Without
    // this, one bad afternoon at pokemontcg.io rewrites a hundred healthy sets as broken.
    if (status === 'unavailable' && t.prior && t.prior.ok) { rows.push({ ...t.prior, staleVerdict: true }); continue }
    rows.push({
      lang: t.lang, code: t.setCode, name: t.name, pcSlug: t.pcSlug, releaseDate: t.releaseDate,
      cards: cards.length, source, status, ok: status === 'ok', checkedAt,
      ...(why ? { error: why } : {}),
    })
  }
  // Carry forward every verdict this run did not revisit — the deferred tail AND the sets proven
  // good recently enough to skip. Without this the doc shrinks to just what ran, and "never checked"
  // is true again next cycle: a bounded run that quietly forgets is worse than an unbounded one.
  const fresh = new Set(rows.map((r) => r.lang + ':' + r.code))
  for (const p of priorRows) if (p && !fresh.has(p.lang + ':' + p.code)) rows.push(p)

  const gaps = rows.filter((r) => r.status === 'gap' || (r.status === undefined && !r.ok))
  const unreachable = rows.filter((r) => r.status === 'unavailable')
  // Only a set that WASN'T already a known gap is worth pushing to a phone. The long tail of
  // genuinely source-less old sets (JP era promo pools, the CS* block) belongs in the Settings
  // panel, not in a notification that repeats every six hours until it is ignored.
  const priorGap = new Set(priorRows.filter((r) => r && !r.ok).map((r) => r.lang + ':' + r.code));
  const newGaps = gaps.filter((r) => !priorGap.has(r.lang + ':' + r.code));
  const doc = { generatedAt: checkedAt, checked: targets.length, deferred: deferred.length, tracked: rows.length,
    gaps: gaps.length, newGaps: newGaps.length, unavailable: unreachable.length, sets: rows }
  const tmp = COVERAGE_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(doc, null, 2)); renameSync(tmp, COVERAGE_PATH)
  if (deferred.length) console.warn(`[coverage] ${deferred.length} sets deferred past the ${max}-per-run cap — they run next cycle`)
  if (unreachable.length) console.warn(`[coverage] ${unreachable.length} sets could not be reached this run — counted as unknown, not as gaps`)
  const summary = `${targets.length} checked, ${gaps.length} with no cards (${newGaps.length} new)`
    + (unreachable.length ? `, ${unreachable.length} unreachable` : '')
    + `, ${rows.length} tracked` + (deferred.length ? `, ${deferred.length} deferred` : '')
  return { summary, checked: targets.length, deferred: deferred.length, gaps, newGaps, unreachable, rows };
}

export function catalogPlugin(env) {
  return {
    name: 'catalog',
    configureServer(server) {
      server.middlewares.use('/api/catalog', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const p = url.pathname.replace(/\/+$/, '') || '/';
          const method = req.method;
          if (method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
            res.setHeader('access-control-allow-headers', 'content-type');
            return res.end();
          }

          if (p === '/seed' && method === 'GET') {
            return send(res, 200, { seed: loadSeed(), path: 'data/pokemon-intl-seed.json' });
          }

          if (p === '/seed' && method === 'POST') {
            const b = await readJsonBody(req);
            const lang = String(b.lang || '').trim();
            const code = String(b.code || '').trim().toUpperCase();
            if (!LANGS.includes(lang)) return send(res, 400, { error: 'lang must be one of ' + LANGS.join('/') + ' — English is live, not editable' });
            if (!code) return send(res, 400, { error: 'code required' });
            const entry = cleanEntry(b.entry || {});
            if (!Object.keys(entry).length) return send(res, 400, { error: 'nothing to save — supply at least one field (e.g. name_en)' });
            const seed = loadSeed();
            seed[lang] = seed[lang] || {};
            seed[lang][code] = entry;
            writeSeed(seed);
            if (b.rebuild === false) return send(res, 200, { ok: true, saved: true, code, lang, rebuilt: null });
            try { const r = await buildPokemonIntlSets(); return send(res, 200, { ok: true, saved: true, code, lang, rebuilt: r.summary }); }
            catch (e) { return send(res, 200, { ok: true, saved: true, code, lang, rebuilt: null, rebuild_error: String(e?.message || e) }); }
          }

          if (p === '/seed' && method === 'DELETE') {
            const b = await readJsonBody(req);
            const lang = String(b.lang || '').trim();
            const code = String(b.code || '').trim().toUpperCase();
            const seed = loadSeed();
            const existed = !!(seed[lang] && seed[lang][code]);
            if (existed) { delete seed[lang][code]; writeSeed(seed); }
            try { const r = await buildPokemonIntlSets(); return send(res, 200, { ok: true, deleted: existed ? code : null, rebuilt: r.summary }); }
            catch (e) { return send(res, 200, { ok: true, deleted: existed ? code : null, rebuilt: null, rebuild_error: String(e?.message || e) }); }
          }

          if (p === '/rebuild' && method === 'POST') {
            try { const r = await buildPokemonIntlSets(); return send(res, 200, { ok: true, rebuilt: r.summary }); }
            catch (e) { return send(res, 500, { error: String(e?.message || e) }); }
          }

          // GET /cards?lang=&set=&tcgdexId=&pcSlug=&refresh=  — normalized, cached card list for one set.
          // The server owns source selection via cardSourceChain(); tcgdexId/pcSlug are CAPABILITIES
          // ("this set can be looked up these ways"), not directives. `src` is still accepted from
          // older clients and deliberately IGNORED — honouring it is what stranded M6.
          // Persists to set_cards (24h TTL); on upstream failure it serves the last-good copy (GR7).
          if (p === '/cards' && method === 'GET') {
            const lang = (url.searchParams.get('lang') || '').trim();
            const setCode = (url.searchParams.get('set') || '').trim();
            const tcgdexId = (url.searchParams.get('tcgdexId') || '').trim();
            const pcSlug = (url.searchParams.get('pcSlug') || '').trim();
            const wantsFresh = /^(1|true|yes)$/i.test((url.searchParams.get('refresh') || '').trim());
            if (!lang || !setCode) return send(res, 400, { error: 'lang and set required' });
            const db = openDb();
            // ?refresh=1 is the ↻ button. Every other game's cache has always honoured it; this one
            // silently didn't, so a set that cached badly stayed bad for the full 24h with no way to
            // pull a corrected roster from the UI.
            const fresh = wantsFresh ? null : setCardsGet(db, lang, setCode, 24);
            if (fresh) return send(res, 200, { cards: fresh.cards, source: fresh.source, stale: false, cached: true, cachedAt: fresh.at, count: fresh.cards.length });
            try {
              // The last two steps are resolved HERE, from the baked index, not sent by the client:
              // a Korean set's Japanese twin and a Chinese set's native name are server knowledge,
              // and asking every caller to look them up is how the src=indexed mistake happened.
              // An English set carries no tcgdexId of its own — the baked index covers the intl
              // lanes only — so it is JOINED here, by set name and official card count, exactly as
              // the twin and the Chinese name are resolved server-side rather than asked of clients.
              const enTcgdex = lang === 'en' && !tcgdexId ? await tcgdexSetIdFor(setCode) : '';
              const chain = cardSourceChain(lang, {
                tcgdexId: tcgdexId || enTcgdex || '', pcSlug,
                twinSlug: twinSlugFor(lang, setCode),
                cnName: cnNameFor(lang, setCode),
              });
              const got = await runCardSourceChain(chain, (step) => (
                step.kind === 'en' ? fetchEnCards(setCode, env)
                  : step.kind === 'tcgdex' ? fetchTcgdexCards(lang, step.id)
                    : step.kind === 'twin' ? fetchTwinCards(step.slug)
                      : step.kind === 'cn' ? fetchCnWikiCards(step.name)
                        : fetchPcCards(step.slug)
              ));
              // Empty-but-OK upstream → serve the last-good copy instead of an empty set, without
              // poisoning the cache (bug #5). Only look up last-good when the fetch came back empty.
              const decision = decideCardsResponse(got.cards, got.source, got.cards.length ? null : setCardsLast(db, lang, setCode), new Date().toISOString());
              if (decision.store) setCardsPut(db, lang, setCode, got.source, got.cards);
              // Surface WHY it's empty when there is nothing stored to fall back to, same as before.
              if (!got.cards.length && !decision.body.cached && got.error) decision.body.error = String(got.error?.message || got.error);
              return send(res, 200, decision.body);
            } catch (e) {
              const last = setCardsLast(db, lang, setCode);   // unexpected failure → serve the stored copy
              if (last) return send(res, 200, { cards: last.cards, source: last.source, stale: true, cached: true, cachedAt: last.at, count: last.cards.length });
              return send(res, 200, { cards: [], source: 'none', stale: false, error: String(e?.message || e) });
            }
          }

          return send(res, 404, { error: 'not found' });
        } catch (e) { return send(res, 500, { error: String(e?.message || e) }); }
      });
      console.log('[catalog] overlay editor · API /api/catalog/seed (GET/POST/DELETE) + /rebuild');
    },
  };
}
