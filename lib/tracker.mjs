// lib/tracker.mjs — Vite plugin that owns the price-tracker DB + /api/tracker/* API
// and starts the in-process collector. Mirrors the ebayProxy(env)/imgProxy shape in
// vite.config.js; registered in its `plugins` array.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.mjs';
import { GAMES } from './normalize.mjs';
import { runPass, startCollector, stopCollector, setThresholds, getThresholds, computeSignals } from './collector.mjs';
import { startDataRefresh, stopDataRefresh } from './refresh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'tracker.config.json');

const DEFAULT_CONFIG = {
  cadence_hours: 24,
  thresholds: { opportunity_drop_pct: -10, momentum_rise_pct: 15, downtrend_drop_pct: -8, min_price_aud: 2 },
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      cadence_hours: raw.cadence_hours ?? DEFAULT_CONFIG.cadence_hours,
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...(raw.thresholds || {}) },
    };
  } catch { return DEFAULT_CONFIG; }
}

// ---- small http helpers ----
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) b = b.slice(0, 1e6); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ---- query helpers ----
function getSeries(db, cardId, days = 90) {
  return db.prepare(
    `SELECT ROUND(julianday('now') - julianday(ts), 3) AS daysAgo, market AS price
     FROM price_snapshots
     WHERE card_id = ? AND market IS NOT NULL AND ts >= datetime('now', ?)
     ORDER BY ts ASC`).all(cardId, `-${days} days`);
}
function getLatest(db, cardId) {
  return db.prepare(
    `SELECT market, low, market_aud, currency, ts, source, pct_1d, pct_7d, pct_30d, pct_90d
     FROM price_snapshots WHERE card_id = ? ORDER BY ts DESC LIMIT 1`).get(cardId);
}
function snapCount(db, cardId) {
  return db.prepare(`SELECT COUNT(*) c FROM price_snapshots WHERE card_id = ? AND market IS NOT NULL`).get(cardId).c;
}

function makeRouter({ db, base, scrydexEnabled }) {
  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') { res.statusCode = 204; res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS'); res.setHeader('access-control-allow-headers', 'content-type'); return res.end(); }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const q = url.searchParams;
      let m;

      // GET /config
      if (p === '/config' && method === 'GET') {
        return send(res, 200, { thresholds: getThresholds(), cadence_hours: loadConfig().cadence_hours, scrydex_enabled: !!scrydexEnabled });
      }

      // GET /watchlist
      if (p === '/watchlist' && method === 'GET') {
        const where = ['active = 1'];
        const args = [];
        if (q.get('game')) { where.push('game = ?'); args.push(q.get('game')); }
        if (q.get('review')) { where.push('review_status = ?'); args.push(q.get('review')); }
        const rows = db.prepare(`SELECT * FROM watchlist WHERE ${where.join(' AND ')} ORDER BY game, name`).all(...args);
        const cards = rows.map((c) => ({ ...c, latest: getLatest(db, c.id) || null, spark: getSeries(db, c.id, 90), count: snapCount(db, c.id) }));
        return send(res, 200, { cards });
      }

      // POST /watchlist
      if (p === '/watchlist' && method === 'POST') {
        const b = await readJson(req);
        if (!GAMES.includes(b.game) || !b.identity_key || !b.name) return send(res, 400, { error: 'game (one of ' + GAMES.join('/') + '), identity_key and name are required' });
        const variant = (b.variant && String(b.variant).trim()) || '';
        const source = b.source === 'claude' ? 'claude' : 'user';
        const review = b.review_status || (source === 'claude' ? 'pending' : 'ok');
        const r = db.prepare(
          `INSERT OR IGNORE INTO watchlist (game, identity_key, name, variant, source, note, review_status)
           VALUES (?,?,?,?,?,?,?)`).run(b.game, String(b.identity_key), String(b.name), variant, source, b.note ?? null, review);
        const created = r.changes > 0;
        const row = created
          ? db.prepare(`SELECT id FROM watchlist WHERE rowid = ?`).get(r.lastInsertRowid)
          : db.prepare(`SELECT id FROM watchlist WHERE game = ? AND identity_key = ? AND variant = ?`).get(b.game, String(b.identity_key), variant);
        const id = row.id;
        // re-activate a previously soft-deleted entry
        if (!created) db.prepare(`UPDATE watchlist SET active = 1 WHERE id = ?`).run(id);
        // seed an immediate manual snapshot if the builder supplied a live price
        if (created && b.price && b.price.market != null) {
          db.prepare(`INSERT INTO price_snapshots (card_id, market, low, currency, source) VALUES (?,?,?,?,?)`)
            .run(id, +b.price.market, b.price.low != null ? +b.price.low : null, b.price.currency || 'USD', 'manual');
        }
        // fire-and-forget: pull a proper priced+AUD snapshot right away
        runPass({ db, base, onlyId: id }).catch(() => {});
        return send(res, created ? 201 : 200, { id, created });
      }

      // POST /snapshot — record a price snapshot (e.g. an eBay-comp fair value), upserting the
      // card if it isn't tracked yet. Lets the comps analysis feed historical trends/signals.
      if (p === '/snapshot' && method === 'POST') {
        const b = await readJson(req);
        if (!GAMES.includes(b.game) || !b.identity_key || b.market == null) return send(res, 400, { error: 'game, identity_key and market are required' });
        const variant = (b.variant && String(b.variant).trim()) || '';
        const cur = b.currency || 'AUD';
        const r = db.prepare(`INSERT OR IGNORE INTO watchlist (game, identity_key, name, variant, source) VALUES (?,?,?,?,?)`)
          .run(b.game, String(b.identity_key), String(b.name || b.identity_key), variant, b.source === 'claude' ? 'claude' : 'user');
        const created = r.changes > 0;
        const row = created
          ? db.prepare(`SELECT id FROM watchlist WHERE rowid = ?`).get(r.lastInsertRowid)
          : db.prepare(`SELECT id FROM watchlist WHERE game = ? AND identity_key = ? AND variant = ?`).get(b.game, String(b.identity_key), variant);
        const id = row.id;
        if (!created) db.prepare(`UPDATE watchlist SET active = 1 WHERE id = ?`).run(id);
        const marketAud = cur === 'AUD' ? +b.market : null;
        db.prepare(`INSERT INTO price_snapshots (card_id, market, low, currency, market_aud, source, raw) VALUES (?,?,?,?,?,?,?)`)
          .run(id, +b.market, b.low != null ? +b.low : null, cur, marketAud, b.source || 'manual', JSON.stringify({ sample_size: b.sample_size ?? null, via: b.source || 'manual' }));
        try { computeSignals(db, id); } catch {}
        return send(res, 201, { id, created, snapshot: true });
      }

      // PATCH /watchlist/:id
      if ((m = p.match(/^\/watchlist\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        const b = await readJson(req);
        const sets = [], args = [];
        if (b.active != null) { sets.push('active = ?'); args.push(b.active ? 1 : 0); }
        if (b.note !== undefined) { sets.push('note = ?'); args.push(b.note); }
        if (b.review_status) { sets.push('review_status = ?'); args.push(b.review_status); }
        if (!sets.length) return send(res, 400, { error: 'nothing to update' });
        args.push(id);
        db.prepare(`UPDATE watchlist SET ${sets.join(', ')} WHERE id = ?`).run(...args);
        return send(res, 200, { updated: true });
      }

      // DELETE /watchlist/:id
      if ((m = p.match(/^\/watchlist\/(\d+)$/)) && method === 'DELETE') {
        const id = +m[1];
        if (q.get('hard') === '1') db.prepare(`DELETE FROM watchlist WHERE id = ?`).run(id);
        else db.prepare(`UPDATE watchlist SET active = 0 WHERE id = ?`).run(id);
        return send(res, 200, { removed: true });
      }

      // GET /history/:id
      if ((m = p.match(/^\/history\/(\d+)$/)) && method === 'GET') {
        const id = +m[1];
        const days = Math.min(3650, Math.max(1, +(q.get('days') || 90)));
        const points = db.prepare(
          `SELECT ts, market, low, market_aud, currency, source FROM price_snapshots
           WHERE card_id = ? AND ts >= datetime('now', ?) ORDER BY ts ASC`).all(id, `-${days} days`);
        return send(res, 200, { id, series: getSeries(db, id, days), points });
      }

      // GET /cache/:id — the latest full raw upstream payload cached for this card
      if ((m = p.match(/^\/cache\/(\d+)$/)) && method === 'GET') {
        const id = +m[1];
        const w = db.prepare(`SELECT game, identity_key FROM watchlist WHERE id = ?`).get(id);
        if (!w) return send(res, 404, { error: 'no such card' });
        const c = db.prepare(`SELECT fetched_at, http_status, source, payload FROM card_cache WHERE game = ? AND identity_key = ?`).get(w.game, w.identity_key);
        if (!c) return send(res, 404, { error: 'no cached payload yet' });
        let payload = null; try { payload = JSON.parse(c.payload); } catch {}
        return send(res, 200, { id, game: w.game, identity_key: w.identity_key, fetched_at: c.fetched_at, http_status: c.http_status, source: c.source, payload });
      }

      // GET /signals
      if (p === '/signals' && method === 'GET') {
        const where = ['1 = 1'], args = [];
        if (q.get('kind')) { where.push('s.kind = ?'); args.push(q.get('kind')); }
        if (q.get('unacked') === '1') where.push('s.acknowledged = 0');
        if (q.get('unnotified') === '1') where.push('s.notified = 0');
        const signals = db.prepare(
          `SELECT s.*, w.name, w.game, w.identity_key, w.source AS card_source
           FROM signals s JOIN watchlist w ON w.id = s.card_id
           WHERE ${where.join(' AND ')} ORDER BY s.ts DESC LIMIT 200`).all(...args);
        return send(res, 200, { signals });
      }

      // POST /signals/:id/ack
      if ((m = p.match(/^\/signals\/(\d+)\/ack$/)) && method === 'POST') {
        db.prepare(`UPDATE signals SET acknowledged = 1 WHERE id = ?`).run(+m[1]);
        return send(res, 200, { acknowledged: true });
      }

      // POST /notified  { ids: [] }
      if (p === '/notified' && method === 'POST') {
        const b = await readJson(req);
        const ids = (b.ids || []).map(Number).filter((n) => Number.isInteger(n));
        if (ids.length) db.prepare(`UPDATE signals SET notified = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        return send(res, 200, { marked: ids.length });
      }

      // POST /refresh  { id? }
      if (p === '/refresh' && method === 'POST') {
        const b = await readJson(req);
        const result = await runPass({ db, base, onlyId: b.id ? +b.id : null });
        return send(res, 200, result);
      }

      // GET /export  (the Claude bundle)
      if (p === '/export' && method === 'GET') {
        const days = Math.min(3650, Math.max(1, +(q.get('days') || 90)));
        const now = db.prepare(`SELECT datetime('now') AS now`).get().now;
        const fxRow = db.prepare(`SELECT fx_usd_aud FROM price_snapshots WHERE fx_usd_aud IS NOT NULL ORDER BY ts DESC LIMIT 1`).get();
        const rows = db.prepare(`SELECT * FROM watchlist WHERE active = 1 ORDER BY game, name`).all();
        const cards = rows.map((c) => {
          const latest = getLatest(db, c.id);
          const sigs = db.prepare(`SELECT kind, window, pct, message, ts, acknowledged FROM signals WHERE card_id = ? AND acknowledged = 0 ORDER BY ts DESC`).all(c.id);
          const n = snapCount(db, c.id);
          const cache = db.prepare(`SELECT fetched_at FROM card_cache WHERE game = ? AND identity_key = ?`).get(c.game, c.identity_key);
          return {
            id: c.id, game: c.game, identity_key: c.identity_key, name: c.name, variant: c.variant,
            source: c.source, note: c.note, review_status: c.review_status,
            added_at: c.added_at, last_checked_at: c.last_checked_at, last_error: c.last_error,
            latest: latest || null, history: getSeries(db, c.id, days), signals: sigs,
            cached_at: cache ? cache.fetched_at : null,
            insufficient_history: c.game !== 'riftbound' && n < 2,
          };
        });
        return send(res, 200, { generated_at: now, fx: { usd_aud: fxRow ? fxRow.fx_usd_aud : null }, thresholds: getThresholds(), cards });
      }

      return send(res, 404, { error: 'unknown tracker route', path: p, method });
    } catch (e) {
      console.error('[api/tracker] error:', e?.message || e);
      return send(res, 500, { error: 'tracker error', detail: String(e?.message || e) });
    }
  };
}

export function trackerPlugin(env) {
  return {
    name: 'tracker',
    configureServer(server) {
      const db = openDb();
      const cfg = loadConfig();
      setThresholds(cfg.thresholds);
      const port = (server.config && server.config.server && server.config.server.port) || 5273;
      const base = `http://127.0.0.1:${port}`;
      server.middlewares.use('/api/tracker', makeRouter({ db, base, scrydexEnabled: !!env.SCRYDEX_API_KEY }));
      startCollector({ db, base, cadenceHours: cfg.cadence_hours });
      startDataRefresh();   // daily bake of the baked catalogs (data/riftbound.json) — lib/refresh.mjs
      server.httpServer?.on('close', () => { stopCollector(); stopDataRefresh(); });
      console.log('[tracker] DB ' + DB_PATH + ' · API /api/tracker · scrydex ' + (env.SCRYDEX_API_KEY ? 'on' : 'off'));
    },
  };
}
