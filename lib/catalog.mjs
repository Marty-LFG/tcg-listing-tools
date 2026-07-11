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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED_PATH = path.join(ROOT, 'data', 'pokemon-intl-seed.json')
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

          return send(res, 404, { error: 'not found' });
        } catch (e) { return send(res, 500, { error: String(e?.message || e) }); }
      });
      console.log('[catalog] overlay editor · API /api/catalog/seed (GET/POST/DELETE) + /rebuild');
    },
  };
}
