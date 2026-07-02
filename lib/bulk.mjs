// lib/bulk.mjs — bulkPlugin(env): the /api/bulk/* surface for the bulk listing tool.
// Two front doors, one pipeline (docs/BULK_LISTING_DESIGN.md):
//   POST /api/bulk/enumerate        Workflow A — set → NDJSON stream of rows
//   POST /api/bulk/import/collectr  Workflow B — Collectr CSV → NDJSON stream of rows
//   POST /api/bulk/price            hybrid pricing (one FX fetch per call)
//   GET  /api/bulk/export/preview   canonical listings + validation (pre-flight gate)
//   POST /api/bulk/export/csv       eBay File Exchange CSV (records channel_exports)
//   GET  /api/bulk/sets             set list for the picker
//   GET  /api/bulk/config           pricing config + pinned eBay categories (UI display)
//
// Mirrors lib/inventory.mjs (send/readJson/router shape, openDb handle) and the
// collector's self-fetch pattern (GR1/2). Streaming responses are NDJSON —
// one JSON per line, a trailing {summary} record; errors become {warning}/{error}
// lines or per-row skips, never a mid-stream 500 (GR7).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { GAMES } from './normalize.mjs';
import { ENUMERATORS, listSets } from './enumerate.mjs';
import { importCollectr } from './collectr.mjs';
import { loadSetIndex, enrichRow } from './collectr-resolve.mjs';
import { loadBulkConfig, resolvePrice } from './pricing.mjs';
import { loadEbayCategories, toEbayListing, validateListing, groupVariations } from './channels/ebay-map.mjs';
import { toPerCardCsv, toVariationCsv } from './channels/ebay-csv.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXPORTS_DIR = path.join(ROOT, 'data', 'exports');

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 20e6) {   // raw text (CSV uploads can be MBs)
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > limit) b = b.slice(0, limit); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(b));
  });
}
async function readJson(req) { try { return JSON.parse(await readBody(req) || '{}'); } catch { return {}; } }

function ndjsonStart(res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'access-control-allow-origin': '*', 'cache-control': 'no-cache' });
  return (obj) => res.write(JSON.stringify(obj) + '\n');
}

// FX for USD legs (collector's loadRates pattern). null when /api/fx is down —
// pricing then simply can't convert USD (rows keep native figures, GR7).
async function loadRates(base) {
  try {
    const r = await fetch(base + '/api/fx/latest?from=USD&to=AUD,EUR,GBP,JPY');
    if (!r.ok) return null;
    const j = await r.json();
    return Object.assign({ USD: 1 }, j.rates || {});
  } catch { return null; }
}

// Upsert a fetched card payload into the tracker's card_cache (shared writer;
// same idiom as lib/collector.mjs cacheRaw).
function cachePayload(db, p) {
  if (!p || !p.identity_key) return;
  try {
    db.prepare(`INSERT INTO card_cache (game, identity_key, fetched_at, http_status, source, payload)
                VALUES (?,?,datetime('now'),200,?,?)
                ON CONFLICT(game, identity_key) DO UPDATE SET
                  fetched_at = datetime('now'), http_status = 200, source = excluded.source, payload = excluded.payload`)
      .run(p.game, p.identity_key, p.source || null, JSON.stringify(p.json));
  } catch {}
}

// Load the items for an export/preview: by batch_id or explicit item_ids.
function loadItems(db, { batch_id, item_ids }) {
  if (Array.isArray(item_ids) && item_ids.length) {
    const ph = item_ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM inventory_items WHERE id IN (${ph})`).all(...item_ids.map(Number));
  }
  if (batch_id) return db.prepare(`SELECT * FROM inventory_items WHERE batch_id = ? ORDER BY number, variant`).all(+batch_id);
  return [];
}

// inventory_items row → the finish string ebay-map/titles expect. `variant` holds
// the canonical token ('1st Edition Holo'); finish is its base part.
function itemFinish(item) {
  const v = item.variant || '';
  if (/reverse/i.test(v)) return 'Reverse Holofoil';
  if (/holo/i.test(v)) return 'Holofoil';
  if (/enchanted/i.test(v)) return 'Enchanted';
  if (/foil/i.test(v)) return 'Foil';
  return 'Normal';
}

function makeRouter({ db, env, base }) {
  const pcToken = (env.PRICECHARTING_TOKEN || '').trim();
  const pcEnabled = String(env.PRICECHARTING_ENABLED || 'true').toLowerCase() !== 'false';

  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const q = url.searchParams;

      // GET /sets?game= — set list for the picker (proxied through the game APIs).
      if (p === '/sets' && method === 'GET') {
        const game = q.get('game');
        if (!GAMES.includes(game)) return send(res, 400, { error: 'game must be one of ' + GAMES.join('/') });
        try { return send(res, 200, { sets: await listSets(base, game) }); }
        catch (e) { return send(res, 200, { sets: [], warning: String(e?.message || e) }); }   // GR7: soft-fail
      }

      // GET /config — pricing config + pinned eBay category info (for UI display).
      if (p === '/config' && method === 'GET') {
        return send(res, 200, { pricing: loadBulkConfig(), ebay: loadEbayCategories() });
      }

      // POST /enumerate — body {game, setId, setName?, filters:{rarities?[]}} → NDJSON.
      if (p === '/enumerate' && method === 'POST') {
        const b = await readJson(req);
        if (!ENUMERATORS[b.game]) return send(res, 400, { error: 'enumeration not supported for "' + b.game + '" (supported: ' + Object.keys(ENUMERATORS).join('/') + ')' });
        if (!b.setId) return send(res, 400, { error: 'setId required' });
        const write = ndjsonStart(res);
        const warnings = [];
        let count = 0;
        try {
          for await (const out of ENUMERATORS[b.game]({ base, setId: b.setId, setName: b.setName, filters: b.filters })) {
            if (out.warning) { warnings.push(out.warning); write({ warning: out.warning }); continue; }
            if (out.cachePayload) cachePayload(db, out.cachePayload);
            count++;
            write({ row: out.row });
          }
        } catch (e) { warnings.push(String(e?.message || e)); write({ warning: String(e?.message || e) }); }
        write({ summary: { total: count, warnings } });
        return res.end();
      }

      // POST /import/collectr?market_currency=AUD|USD&enrich=1|0&fresh=1 — body = raw CSV text → NDJSON.
      if (p === '/import/collectr' && method === 'POST') {
        const text = await readBody(req);
        if (!text || !text.trim()) return send(res, 400, { error: 'empty body — POST the raw Collectr CSV text' });
        const marketCurrency = (q.get('market_currency') || (loadCollectrConfig().market_currency) || 'AUD').toUpperCase();
        const enrich = q.get('enrich') !== '0';
        const fresh = q.get('fresh') === '1';
        const parsed = importCollectr(text, { marketCurrency });
        const write = ndjsonStart(res);
        const warnings = [...parsed.warnings];
        const stats = { total: 0, resolved: 0, unresolved: 0, graded: 0, needs_price: 0, unsupported_game: 0 };
        const setIndexByGame = {};
        for (const r of parsed.rows) {
          let row = r;
          if (!r.game) stats.unsupported_game++;
          else if (enrich) {
            try {
              if (!setIndexByGame[r.game]) setIndexByGame[r.game] = await loadSetIndex(base, r.game, { fresh });
              const out = await enrichRow(base, r, { setIndex: setIndexByGame[r.game], db, fresh, pcToken, pcEnabled });
              row = out.row;
              warnings.push(...out.warnings);
            } catch (e) { warnings.push((r.name || '?') + ': ' + String(e?.message || e)); }
          }
          stats.total++;
          if (row.resolved) stats.resolved++; else stats.unresolved++;
          if (row.graded) {
            stats.graded++;
            if (row.market_source_value == null && row.pc_value_usd == null && row.override_aud == null) stats.needs_price++;
          }
          write({ row });
        }
        write({ summary: { ...stats, market_currency: marketCurrency, enriched: enrich, portfolios: parsed.portfolios, byGame: parsed.byGame, warnings } });
        return res.end();
      }

      // POST /price — body {rows:[…]} → one FX fetch, hybrid-resolve every row.
      if (p === '/price' && method === 'POST') {
        const b = await readJson(req);
        const rows = Array.isArray(b.rows) ? b.rows : [];
        const cfg = loadBulkConfig();
        const rates = await loadRates(base);
        const out = rows.map((r) => { try { return resolvePrice(r, cfg, rates); } catch (e) { return { price_cents: null, value_source: 'needs_price', error: String(e?.message || e) }; } });
        return send(res, 200, { rows: out, fx_usd_aud: rates ? rates.AUD || null : null, config: { thresholds: cfg.market_threshold_aud, min: cfg.min_price_aud } });
      }

      // GET /export/preview?batch_id=|item_ids=1,2,3&shape= — pre-flight gate, no side effects.
      if (p === '/export/preview' && method === 'GET') {
        const items = loadItems(db, { batch_id: q.get('batch_id'), item_ids: (q.get('item_ids') || '').split(',').filter(Boolean) });
        if (!items.length) return send(res, 404, { error: 'no items — pass batch_id or item_ids' });
        const cats = loadEbayCategories();
        const shape = q.get('shape') || 'per_card';
        const out = items.map((it) => {
          const listing = toEbayListing({ ...it, finish: itemFinish(it) }, null, cats);
          return { id: it.id, sku: it.sku, listing, ...validateListing(listing, cats) };
        });
        const blocked = out.filter((o) => o.errors.length);
        return send(res, 200, {
          shape, total: out.length, exportable: out.length - blocked.length, blocked: blocked.length,
          rows: out.map(({ id, sku, errors, warnings, listing }) => ({ id, sku, title: listing.title, price_cents: listing.price_cents, errors, warnings })),
        });
      }

      // POST /export/csv — body {batch_id|item_ids, shape, location?} → CSV download.
      // HARD gate: any row with validation errors blocks the whole export (a broken
      // batch must never reach eBay); the response tells the UI exactly which rows.
      if (p === '/export/csv' && method === 'POST') {
        const b = await readJson(req);
        const items = loadItems(db, b);
        if (!items.length) return send(res, 404, { error: 'no items — pass batch_id or item_ids' });
        const cats = loadEbayCategories();
        const shape = b.shape === 'multi_variation' ? 'multi_variation' : 'per_card';
        const listings = items.map((it) => toEbayListing({ ...it, finish: itemFinish(it) }, null, cats));
        const problems = listings.map((l, i) => ({ id: items[i].id, sku: l.sku, errors: validateListing(l, cats).errors })).filter((x) => x.errors.length);
        if (problems.length) return send(res, 422, { error: 'export blocked — ' + problems.length + ' row(s) failed validation', problems });

        let csv;
        if (shape === 'multi_variation') {
          const byGameSet = {};
          for (const l of listings) { const k = l.game + '|' + (l.aspects['Set'] || ''); (byGameSet[k] = byGameSet[k] || []).push(l); }
          const groups = [];
          for (const k of Object.keys(byGameSet)) {
            const [game, setName] = k.split('|');
            groups.push(...groupVariations(byGameSet[k], { game, setName: setName || 'Singles' }));
          }
          csv = toVariationCsv(groups, { location: b.location });
        } else {
          csv = toPerCardCsv(listings, { location: b.location });
        }

        // Artifact + audit trail (channel_exports), then stream the download.
        let artifact = null;
        try {
          fs.mkdirSync(EXPORTS_DIR, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          artifact = path.join(EXPORTS_DIR, `ebay-${b.batch_id || 'items'}-${shape}-${stamp}.csv`);
          fs.writeFileSync(artifact, csv, 'utf8');
        } catch {}
        try {
          db.prepare(`INSERT INTO channel_exports (channel, shape, marketplace, batch_id, item_ids, artifact_path)
                      VALUES ('ebay-csv', ?, 'EBAY_AU', ?, ?, ?)`)
            .run(shape, b.batch_id ? +b.batch_id : null, JSON.stringify(items.map((i) => i.id)), artifact);
          if (b.batch_id) db.prepare(`UPDATE bulk_batches SET status = 'exported', export_shape = ?, exported_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(shape, +b.batch_id);
        } catch {}
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="ebay-bulk-' + shape + '.csv"',
          'access-control-allow-origin': '*',
        });
        return res.end(csv);
      }

      // Phase 2 stubs — the Sell Inventory API channel is gated on production
      // sell.inventory scope approval (see docs/BULK_LISTING_DESIGN.md §9.2).
      if (p.startsWith('/channel/') || p.startsWith('/auth/')) {
        return send(res, 501, { error: 'eBay Sell API channel is Phase 2 (pending sell.inventory production approval) — use POST /api/bulk/export/csv' });
      }

      return send(res, 404, { error: 'unknown bulk route', path: p, method });
    } catch (e) {
      console.error('[api/bulk] error:', e?.message || e);
      return send(res, 500, { error: 'bulk error', detail: String(e?.message || e) });
    }
  };
}

const COLLECTR_CONFIG_PATH = path.join(ROOT, 'data', 'collectr.config.json');
function loadCollectrConfig() {
  try { return JSON.parse(fs.readFileSync(COLLECTR_CONFIG_PATH, 'utf8')); } catch { return { market_currency: 'AUD' }; }
}

export function bulkPlugin(env) {
  return {
    name: 'bulk',
    configureServer(server) {
      const db = openDb();
      const port = (server.config && server.config.server && server.config.server.port) || 5273;
      const base = `http://127.0.0.1:${port}`;
      server.middlewares.use('/api/bulk', makeRouter({ db, env, base }));
      console.log('[bulk] API /api/bulk · enumerate: pokemon/lorcana · collectr import · CSV export');
    },
  };
}
