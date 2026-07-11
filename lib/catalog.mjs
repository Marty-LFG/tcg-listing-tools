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
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPokemonIntlSets } from '../scripts/build-pokemon-intl-sets.mjs'
import { openDb } from './db.mjs'
import { enumerateConsole } from './pricecharting.mjs'

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
function cleanEntry(raw) {
  const e = {};
  for (const f of STR_FIELDS) { const v = raw && typeof raw[f] === 'string' ? raw[f].trim() : ''; if (v) e[f] = v; }
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

async function fetchJson(u, headers) {
  const r = await fetch(u, { headers: { accept: 'application/json', ...(headers || {}) } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// Market value (mirrors catalog.html enPrice): tcgplayer USD first, then cardmarket EUR.
function enPrice(c) {
  const tp = c.tcgplayer && c.tcgplayer.prices;
  if (tp) for (const k of ['holofoil', 'reverseHolofoil', 'normal', '1stEditionHolofoil', 'unlimitedHolofoil'])
    if (tp[k] && tp[k].market != null) return { val: tp[k].market, label: 'US$' + tp[k].market.toFixed(2) };
  const cm = c.cardmarket && c.cardmarket.prices;
  if (cm && cm.averageSellPrice != null) return { val: cm.averageSellPrice, label: '€' + cm.averageSellPrice.toFixed(2) };
  return null;
}
// EN cards from pokemontcg.io. The vite /api/pkm proxy isn't reachable from middleware — hit the host.
async function fetchEnCards(setId, env) {
  const headers = env && env.POKEMONTCG_API_KEY ? { 'X-Api-Key': env.POKEMONTCG_API_KEY } : {};
  const j = await fetchJson('https://api.pokemontcg.io/v2/cards?q=set.id:' + encodeURIComponent(setId) + '&pageSize=250', headers);
  return (j.data || []).map((c) => {
    const numRaw = String(c.number || ''); const pr = enPrice(c);
    return { numRaw: numRaw.replace(/^0+(?=\d)/, '') || numRaw, name: c.name || '', rarity: c.rarity || '',
      priceVal: pr ? pr.val : null, price: pr ? pr.label : null,
      img: (c.images && (c.images.small || c.images.large)) || '', imgLarge: (c.images && c.images.large) || '', source: 'pokemontcg' };
  });
}
// Intl cards from TCGdex (indexed sets). image is a base URL; often absent on brand-new sets.
async function fetchTcgdexCards(lang, id) {
  const j = await fetchJson('https://api.tcgdex.net/v2/' + encodeURIComponent(lang) + '/sets/' + encodeURIComponent(id));
  return ((j && j.cards) || []).map((c) => {
    const numRaw = String(c.localId || c.id || '');
    return { numRaw, name: c.name || '', rarity: '', priceVal: null, price: null,
      img: c.image ? c.image + '/low.webp' : '', imgLarge: c.image ? c.image + '/high.webp' : '', source: 'tcgdex' };
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
      img: c.image ? '/api/img?u=' + encodeURIComponent(c.image + '/320.jpg') : '', imgLarge: c.image ? c.image + '/1600.jpg' : '', source: 'pricecharting' };
  });
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

          // GET /cards?lang=&set=&src=&tcgdexId=&pcSlug=  — normalized, cached card list for one set.
          // Server owns source selection (EN=pokemontcg.io, indexed=TCGdex, seeded/pcOnly=PriceCharting)
          // and persists to set_cards (24h TTL); on upstream failure it serves the last-good copy (GR7).
          if (p === '/cards' && method === 'GET') {
            const lang = (url.searchParams.get('lang') || '').trim();
            const setCode = (url.searchParams.get('set') || '').trim();
            const srcHint = (url.searchParams.get('src') || '').trim();
            const tcgdexId = (url.searchParams.get('tcgdexId') || '').trim();
            const pcSlug = (url.searchParams.get('pcSlug') || '').trim();
            if (!lang || !setCode) return send(res, 400, { error: 'lang and set required' });
            const db = openDb();
            const fresh = setCardsGet(db, lang, setCode, 24);
            if (fresh) return send(res, 200, { cards: fresh.cards, source: fresh.source, stale: false, cached: true, cachedAt: fresh.at, count: fresh.cards.length });
            try {
              let cards = [], source = 'none';
              if (lang === 'en') { cards = await fetchEnCards(setCode, env); source = 'pokemontcg'; }
              else if (srcHint === 'indexed' && tcgdexId) { cards = await fetchTcgdexCards(lang, tcgdexId); source = 'tcgdex'; }
              else if (pcSlug) { cards = await fetchPcCards(pcSlug); source = 'pricecharting'; }
              if (cards.length) setCardsPut(db, lang, setCode, source, cards);
              return send(res, 200, { cards, source, stale: false, cached: false, cachedAt: new Date().toISOString(), count: cards.length });
            } catch (e) {
              const last = setCardsLast(db, lang, setCode);   // upstream down → serve the stored copy
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
