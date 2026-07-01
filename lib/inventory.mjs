// lib/inventory.mjs — Vite plugin owning the graded-card INVENTORY DB tables + the
// /api/inventory/* API. Phase 1 of turning the tool into an inventory platform
// ("Binders Keepers"): graded-card stock, cost basis / P&L, live graded valuation,
// and the grading-submission pipeline. Mirrors lib/tracker.mjs (same openDb() handle,
// same send/readJson/makeRouter shape); registered in vite.config.js `plugins`.
//
// Golden rules honoured: money is INTEGER CENTS; live valuation via lib/pricecharting.mjs
// (never a model guess); manual entry always works and a down pricing source never blocks a
// write (valuation just doesn't update); no new deps (node:sqlite / node:fs only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.mjs';
import { GAMES, lookupPath, imageFrom } from './normalize.mjs';
import { lookup as pcLookup } from './pricecharting.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GRADING_CONFIG_PATH = path.join(ROOT, 'data', 'grading.config.json');

// ---- small http helpers (same shape as lib/tracker.mjs) --------------------
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

// ---- config / helpers ------------------------------------------------------
function loadGradingConfig() {
  try { return JSON.parse(fs.readFileSync(GRADING_CONFIG_PATH, 'utf8')); } catch { return null; }
}
function turnaroundDays(cfg, company, tier) {
  try {
    const tiers = (cfg && cfg.fees && cfg.fees[company]) || [];
    const t = tiers.find((x) => x.tier === tier);
    return t && t.turnaroundDays != null ? t.turnaroundDays : null;
  } catch { return null; }
}
// Calendar-day estimate (config turnaround is business days — an approximation, noted in the UI).
function computeReturn(db, submittedAt, days) {
  if (!submittedAt || days == null) return null;
  try { return db.prepare(`SELECT date(?, ?) AS d`).get(submittedAt, '+' + days + ' days').d; }
  catch { return null; }
}

const GAMECODE = { riftbound: 'RB', mtg: 'MTG', pokemon: 'PKM', swu: 'SWU', lorcana: 'LOR' };
// Atomic per-namespace SKU sequence (single-writer model => no race). BK-PKM-000042.
function nextSku(db, game) {
  const ns = GAMECODE[game] || 'GEN';
  db.prepare(`INSERT INTO sku_counter (namespace, seq) VALUES (?, 1)
              ON CONFLICT(namespace) DO UPDATE SET seq = seq + 1`).run(ns);
  const seq = db.prepare(`SELECT seq FROM sku_counter WHERE namespace = ?`).get(ns).seq;
  return 'BK-' + ns + '-' + String(seq).padStart(6, '0');
}

// Map a PriceCharting ladder {label->cents} to the item's grading_company + grade.
// Tries "<COMPANY> <grade>" (PSA 10), then generic "Grade <grade>" (Grade 9), then
// cross-company 10/9.5 rungs, finally the raw (Ungraded) anchor. Returns {cents,label}|null.
function valueFromLadder(ladder, company, grade) {
  if (!ladder || typeof ladder !== 'object') return null;
  const co = String(company || '').toUpperCase();
  const keys = [];
  if (grade != null && isFinite(grade)) {
    const g = +grade;
    const gs = String(g);
    if (co) keys.push(co + ' ' + gs);
    keys.push('Grade ' + gs);
    if (g >= 10) keys.push('PSA 10', 'BGS 10', 'CGC 10', 'SGC 10', 'Grade 10');
    else if (g === 9.5) keys.push('BGS 9.5', 'CGC 9.5', 'SGC 9.5');
  }
  for (const k of keys) if (ladder[k] != null) return { cents: ladder[k], label: k };
  if (ladder['Ungraded'] != null) return { cents: ladder['Ungraded'], label: 'Ungraded (raw anchor)' };
  return null;
}

// Latest graded-value series for an item's sparkline, shaped for TCG.lineGraph ([{daysAgo,price}]).
function getValSeries(db, itemId, days = 365) {
  return db.prepare(
    `SELECT ROUND(julianday('now') - julianday(ts), 3) AS daysAgo, value_cents AS c
     FROM inventory_valuations
     WHERE item_id = ? AND value_cents IS NOT NULL AND ts >= datetime('now', ?)
     ORDER BY ts ASC`).all(itemId, `-${days} days`).map((r) => ({ daysAgo: r.daysAgo, price: r.c / 100 }));
}

function pick(body, cols) {
  const out = {};
  for (const c of cols) if (body[c] !== undefined) out[c] = body[c];
  // JSON-encode subgrade objects transparently
  if (out.subgrades && typeof out.subgrades === 'object') out.subgrades = JSON.stringify(out.subgrades);
  if (out.result_subgrades && typeof out.result_subgrades === 'object') out.result_subgrades = JSON.stringify(out.result_subgrades);
  return out;
}
function insertRow(db, table, obj) {
  const cols = Object.keys(obj);
  const ph = cols.map(() => '?').join(',');
  const r = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`).run(...cols.map((c) => obj[c]));
  return r.lastInsertRowid;
}

const ITEM_INSERT_COLS = [
  'game', 'identity_key', 'name', 'set_name', 'number', 'variant', 'language',
  'grading_company', 'grade', 'grade_label', 'subgrades', 'cert_number', 'graded_date',
  'quantity', 'location', 'status', 'cost_cents', 'acq_fees_cents', 'acquired_at', 'source_vendor',
  'sale_price_cents', 'sale_fees_cents', 'sold_at', 'target_price_cents', 'notes',
  'value_cents', 'value_currency', 'value_source', 'value_manual', 'image_url', 'watchlist_id', 'submission_id',
  'ebay_listing_id', 'shopify_product_id', 'channel_status',
];
const ITEM_PATCH_COLS = ITEM_INSERT_COLS;
const SUB_COLS = [
  'game', 'identity_key', 'name', 'set_name', 'number', 'variant', 'language',
  'grading_company', 'tier', 'declared_value_cents', 'grading_cost_cents',
  'submitted_at', 'expected_return_at', 'status', 'tracking',
  'result_grade', 'result_grade_label', 'result_subgrades', 'cert_number', 'notes',
];

function itemWithPl(db, row) {
  const vals = getValSeries(db, row.id);
  return { ...row, spark: vals, val_count: vals.length };
}

// ---- watchlist link (reuses the tracker's own table so the collector keeps raw price fresh) --
function ensureWatchlist(db, { game, identity_key, name, variant }) {
  const v = (variant && String(variant).trim()) || '';
  const r = db.prepare(
    `INSERT OR IGNORE INTO watchlist (game, identity_key, name, variant, source) VALUES (?,?,?,?,'user')`)
    .run(game, String(identity_key), String(name || identity_key), v);
  const row = r.changes > 0
    ? db.prepare(`SELECT id FROM watchlist WHERE rowid = ?`).get(r.lastInsertRowid)
    : db.prepare(`SELECT id FROM watchlist WHERE game = ? AND identity_key = ? AND variant = ?`).get(game, String(identity_key), v);
  if (r.changes === 0) db.prepare(`UPDATE watchlist SET active = 1 WHERE id = ?`).run(row.id);
  return row.id;
}

// Strip a grading/finish prefix a slab label often carries ("FA/Sylveon VMAX" -> "Sylveon VMAX").
function cleanCardName(name) {
  return String(name || '').replace(/^\s*(FA|SIR|SAR|AR|UR|HR|RR|SR|CHR|full\s*art)\s*[\/:\-]\s*/i, '').replace(/\s+/g, ' ').trim();
}
function pickPkmCard(arr, item) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const num = String(item.number || '').split('/')[0].replace(/^0+/, '');
  if (num) { const hit = arr.find((c) => String(c.number || '').replace(/^0+/, '') === num); if (hit) return hit; }
  return arr[0];
}
// Search a game's API by name (+ number) when there's no identity_key. Returns {url, identity_key}|null.
// Covers the games with a robust text search (Pokémon, MTG, Lorcana); others fall back to manual paste.
async function searchCard(base, game, item) {
  const name = cleanCardName(item.name);
  if (!name) return null;
  try {
    if (game === 'pokemon') {
      const num = String(item.number || '').split('/')[0].replace(/^0+/, '');
      const tries = [];
      if (num) tries.push(`name:"${name}" number:${num}`);
      tries.push(`name:"${name}"`);
      for (const q of tries) {
        const r = await fetch(base + '/api/pkm/cards?pageSize=12&q=' + encodeURIComponent(q));
        if (!r.ok) continue;
        const j = await r.json();
        const card = pickPkmCard(j && j.data, item);
        if (card) { const url = imageFrom('pokemon', card); if (url) return { url, identity_key: card.id || null }; }
      }
    } else if (game === 'mtg') {
      const r = await fetch(base + '/api/mtg/cards/named?fuzzy=' + encodeURIComponent(name));
      if (r.ok) {
        const j = await r.json();
        if (j && j.object !== 'error') {
          const url = imageFrom('mtg', j);
          const key = (j.set && j.collector_number) ? (j.set + '-' + j.collector_number) : null;
          if (url) return { url, identity_key: key };
        }
      }
    } else if (game === 'lorcana') {
      const r = await fetch(base + '/api/lorcana/cards/search?q=' + encodeURIComponent(name));
      if (r.ok) { const j = await r.json(); const card = ((j && (j.results || j.data)) || [])[0]; if (card) { const url = imageFrom('lorcana', card); if (url) return { url, identity_key: null }; } }
    }
  } catch {}
  return null;
}
// Resolve + cache a card image: direct by identity_key first, then search by name/number.
// Backfills identity_key when the search resolves one. Best-effort, never throws.
async function resolveImage(db, base, item) {
  if (!item || !item.game) return null;
  let url = null, resolvedKey = null;
  if (item.identity_key) {
    const path = lookupPath(item.game, item.identity_key);
    if (path) { try { const r = await fetch(base + path); if (r.ok) url = imageFrom(item.game, await r.json()); } catch {} }
  }
  if (!url && item.name) {
    const found = await searchCard(base, item.game, item);
    if (found) { url = found.url; resolvedKey = found.identity_key; }
  }
  if (url) {
    if (resolvedKey && !item.identity_key) db.prepare(`UPDATE inventory_items SET image_url = ?, identity_key = ?, updated_at = datetime('now') WHERE id = ?`).run(url, resolvedKey, item.id);
    else db.prepare(`UPDATE inventory_items SET image_url = ?, updated_at = datetime('now') WHERE id = ?`).run(url, item.id);
  }
  return url || null;
}

function makeRouter({ db, env, base }) {
  const pcEnabled = String(env.PRICECHARTING_ENABLED || 'true').toLowerCase() !== 'false';
  const pcToken = (env.PRICECHARTING_TOKEN || '').trim();

  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const q = url.searchParams;
      let m;

      // GET /summary — portfolio P&L (money in cents; FX left to the client, app convention).
      if (p === '/summary' && method === 'GET') {
        const rows = db.prepare(`SELECT status, game, grading_company, cost_cents, acq_fees_cents,
          sale_price_cents, sale_fees_cents, value_cents, value_currency, quantity FROM inventory_items`).all();
        const cents = (n) => (n == null ? 0 : +n);
        const counts = { total: rows.length, in_stock: 0, listed: 0, sold: 0 };
        const byGame = {}, byCompany = {}, valueByCurrency = {};
        let totalCostCents = 0, realizedPlCents = 0;
        for (const r of rows) {
          counts[r.status] = (counts[r.status] || 0) + 1;
          byGame[r.game] = (byGame[r.game] || 0) + 1;
          if (r.grading_company) byCompany[r.grading_company] = (byCompany[r.grading_company] || 0) + 1;
          if (r.status === 'sold') {
            realizedPlCents += cents(r.sale_price_cents) - cents(r.sale_fees_cents) - cents(r.cost_cents) - cents(r.acq_fees_cents);
          } else {
            totalCostCents += cents(r.cost_cents) + cents(r.acq_fees_cents);
            if (r.value_cents != null) {
              const cur = r.value_currency || 'USD';
              valueByCurrency[cur] = (valueByCurrency[cur] || 0) + cents(r.value_cents);
            }
          }
        }
        return send(res, 200, { counts, totalCostCents, realizedPlCents, valueByCurrency, byGame, byCompany });
      }

      // GET /export — full bundle (accounting / Claude).
      if (p === '/export' && method === 'GET') {
        const now = db.prepare(`SELECT datetime('now') AS now`).get().now;
        const items = db.prepare(`SELECT * FROM inventory_items ORDER BY created_at DESC`).all();
        const submissions = db.prepare(`SELECT * FROM grading_submissions ORDER BY created_at DESC`).all();
        return send(res, 200, { generated_at: now, items, submissions });
      }

      // GET /items — filters: game, company, grade, status, q (name search)
      if (p === '/items' && method === 'GET') {
        const where = ['1 = 1'], args = [];
        if (q.get('game')) { where.push('game = ?'); args.push(q.get('game')); }
        if (q.get('company')) { where.push('grading_company = ?'); args.push(q.get('company')); }
        if (q.get('grade')) { where.push('grade = ?'); args.push(+q.get('grade')); }
        if (q.get('status')) { where.push('status = ?'); args.push(q.get('status')); }
        if (q.get('q')) { where.push('(name LIKE ? OR sku LIKE ? OR cert_number LIKE ?)'); const s = '%' + q.get('q') + '%'; args.push(s, s, s); }
        const rows = db.prepare(`SELECT * FROM inventory_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...args);
        return send(res, 200, { items: rows.map((r) => itemWithPl(db, r)) });
      }

      // POST /items — create (generates SKU). Optionally link_watchlist to keep raw price fresh.
      if (p === '/items' && method === 'POST') {
        const b = await readJson(req);
        if (!GAMES.includes(b.game) || !b.name) return send(res, 400, { error: 'game (one of ' + GAMES.join('/') + ') and name are required' });
        const obj = pick(b, ITEM_INSERT_COLS);
        if (b.link_watchlist && b.game && b.identity_key) {
          try { obj.watchlist_id = ensureWatchlist(db, b); } catch (e) { console.error('[inventory] link watchlist', e?.message || e); }
        }
        const sku = nextSku(db, b.game);
        obj.sku = sku;
        const id = insertRow(db, 'inventory_items', obj);
        // Seed an initial valuation row if a value was supplied (e.g. value-at-grade from the grader).
        if (b.value_cents != null) {
          insertRow(db, 'inventory_valuations', {
            item_id: id, value_cents: +b.value_cents, currency: b.value_currency || 'USD',
            source: b.value_source || 'manual', grade_label: b.grade_label || null,
          });
        }
        // Auto-resolve a card image (by identity, else by name/number search) unless one was supplied.
        if (obj.image_url == null && b.name) resolveImage(db, base, { id, game: b.game, identity_key: b.identity_key || null, name: b.name, number: b.number, set_name: b.set_name }).catch(() => {});
        return send(res, 201, { id, sku, created: true });
      }

      // GET /items/:id/valuations — value history (for the sparkline / detail view)
      if ((m = p.match(/^\/items\/(\d+)\/valuations$/)) && method === 'GET') {
        const id = +m[1];
        const points = db.prepare(`SELECT ts, value_cents, currency, source, grade_label, sample_size
          FROM inventory_valuations WHERE item_id = ? ORDER BY ts ASC`).all(id);
        return send(res, 200, { id, series: getValSeries(db, id), points });
      }

      // POST /items/:id/refresh-value — pull live graded value from PriceCharting.
      if ((m = p.match(/^\/items\/(\d+)\/refresh-value$/)) && method === 'POST') {
        const id = +m[1];
        const force = q.get('force') === '1';
        const item = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(id);
        if (!item) return send(res, 404, { error: 'no such item' });
        if (!item.name || item.number == null) return send(res, 200, { updated: false, reason: 'no_identity' });
        if (item.value_manual && !force) return send(res, 200, { updated: false, reason: 'manual_override' });
        const pc = await pcLookup({ name: item.name, number: item.number, setName: item.set_name, cardId: item.identity_key, token: pcToken, enabled: pcEnabled });
        if (!pc || !pc.matched) return send(res, 200, { updated: false, reason: (pc && pc.error) || 'no_match' });
        const v = valueFromLadder(pc.ladder, item.grading_company, item.grade);
        if (!v) return send(res, 200, { updated: false, reason: 'no_rung', ladder: pc.ladder });
        insertRow(db, 'inventory_valuations', {
          item_id: id, value_cents: v.cents, currency: 'USD', source: 'pricecharting',
          grade_label: v.label, raw: JSON.stringify({ url: pc.url, confidence: pc.confidence, rung: v.label }),
        });
        db.prepare(`UPDATE inventory_items SET value_cents = ?, value_currency = 'USD', value_source = 'pricecharting',
          value_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(v.cents, id);
        return send(res, 200, { updated: true, value_cents: v.cents, currency: 'USD', grade_label: v.label, confidence: pc.confidence });
      }

      // POST /items/:id/value-manual — set a value directly (user override, or an eBay-comp fair value).
      // body: { value_cents, currency='AUD', source='manual', sample_size? }. source!='manual' => not a
      // hard override (value_manual=0), so a later PriceCharting refresh can still update it.
      if ((m = p.match(/^\/items\/(\d+)\/value-manual$/)) && method === 'POST') {
        const id = +m[1];
        const b = await readJson(req);
        if (b.value_cents == null) return send(res, 400, { error: 'value_cents required' });
        const src = b.source || 'manual';
        const manual = src === 'manual' ? 1 : 0;
        const cur = b.currency || 'AUD';
        insertRow(db, 'inventory_valuations', {
          item_id: id, value_cents: +b.value_cents, currency: cur, source: src,
          grade_label: b.grade_label || null, sample_size: b.sample_size != null ? +b.sample_size : null,
        });
        db.prepare(`UPDATE inventory_items SET value_cents = ?, value_currency = ?, value_source = ?,
          value_manual = ?, value_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .run(+b.value_cents, cur, src, manual, id);
        return send(res, 200, { updated: true });
      }

      // POST /items/:id/fetch-image — resolve + cache the card image from the game API.
      if ((m = p.match(/^\/items\/(\d+)\/fetch-image$/)) && method === 'POST') {
        const id = +m[1];
        const item = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(id);
        if (!item) return send(res, 404, { error: 'no such item' });
        const url = await resolveImage(db, base, item);
        return send(res, 200, { updated: !!url, image_url: url });
      }

      // GET /items/:id
      if ((m = p.match(/^\/items\/(\d+)$/)) && method === 'GET') {
        const id = +m[1];
        const row = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(id);
        if (!row) return send(res, 404, { error: 'no such item' });
        const points = db.prepare(`SELECT ts, value_cents, currency, source, grade_label FROM inventory_valuations WHERE item_id = ? ORDER BY ts ASC`).all(id);
        return send(res, 200, { item: itemWithPl(db, row), valuations: points });
      }

      // PATCH /items/:id — partial update (whitelisted columns).
      if ((m = p.match(/^\/items\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        const b = await readJson(req);
        const obj = pick(b, ITEM_PATCH_COLS);
        const cols = Object.keys(obj);
        if (!cols.length) return send(res, 400, { error: 'nothing to update' });
        const sets = cols.map((c) => c + ' = ?').concat([`updated_at = datetime('now')`]);
        db.prepare(`UPDATE inventory_items SET ${sets.join(', ')} WHERE id = ?`).run(...cols.map((c) => obj[c]), id);
        return send(res, 200, { updated: true });
      }

      // DELETE /items/:id (hard; cascades valuations)
      if ((m = p.match(/^\/items\/(\d+)$/)) && method === 'DELETE') {
        db.prepare(`DELETE FROM inventory_items WHERE id = ?`).run(+m[1]);
        return send(res, 200, { removed: true });
      }

      // GET /submissions — filters: status, company
      if (p === '/submissions' && method === 'GET') {
        const where = ['1 = 1'], args = [];
        if (q.get('status')) { where.push('status = ?'); args.push(q.get('status')); }
        if (q.get('company')) { where.push('grading_company = ?'); args.push(q.get('company')); }
        const rows = db.prepare(`SELECT * FROM grading_submissions WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...args);
        return send(res, 200, { submissions: rows });
      }

      // POST /submissions — create a grading submission (computes expected_return_at from config).
      if (p === '/submissions' && method === 'POST') {
        const b = await readJson(req);
        if (!GAMES.includes(b.game) || !b.name || !b.grading_company) {
          return send(res, 400, { error: 'game, name and grading_company are required' });
        }
        const obj = pick(b, SUB_COLS);
        if (obj.expected_return_at == null && obj.submitted_at && obj.tier) {
          const d = turnaroundDays(loadGradingConfig(), obj.grading_company, obj.tier);
          const est = computeReturn(db, obj.submitted_at, d);
          if (est) obj.expected_return_at = est;
        }
        const id = insertRow(db, 'grading_submissions', obj);
        return send(res, 201, { id, created: true });
      }

      // PATCH /submissions/:id
      if ((m = p.match(/^\/submissions\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        const b = await readJson(req);
        const obj = pick(b, SUB_COLS);
        // Recompute the ETA if the submit date / tier changed and no explicit date was given.
        if (obj.expected_return_at == null && (obj.submitted_at !== undefined || obj.tier !== undefined)) {
          const cur = db.prepare(`SELECT grading_company, tier, submitted_at FROM grading_submissions WHERE id = ?`).get(id) || {};
          const company = obj.grading_company ?? cur.grading_company;
          const tier = obj.tier ?? cur.tier;
          const submitted = obj.submitted_at ?? cur.submitted_at;
          const d = turnaroundDays(loadGradingConfig(), company, tier);
          const est = computeReturn(db, submitted, d);
          if (est) obj.expected_return_at = est;
        }
        const cols = Object.keys(obj);
        if (!cols.length) return send(res, 400, { error: 'nothing to update' });
        const sets = cols.map((c) => c + ' = ?').concat([`updated_at = datetime('now')`]);
        db.prepare(`UPDATE grading_submissions SET ${sets.join(', ')} WHERE id = ?`).run(...cols.map((c) => obj[c]), id);
        return send(res, 200, { updated: true });
      }

      // POST /submissions/:id/promote — the slab returned: create the inventory item (idempotent).
      if ((m = p.match(/^\/submissions\/(\d+)\/promote$/)) && method === 'POST') {
        const id = +m[1];
        const b = await readJson(req);
        const sub = db.prepare(`SELECT * FROM grading_submissions WHERE id = ?`).get(id);
        if (!sub) return send(res, 404, { error: 'no such submission' });
        if (sub.promoted_item_id) {
          const existing = db.prepare(`SELECT id, sku FROM inventory_items WHERE id = ?`).get(sub.promoted_item_id);
          if (existing) return send(res, 200, { item_id: existing.id, sku: existing.sku, already: true });
        }
        // Result fields can be supplied on promote (actual grade/cert off the returned slab) or come from the row.
        const grade = b.result_grade != null ? +b.result_grade : sub.result_grade;
        const gradeLabel = b.result_grade_label ?? sub.result_grade_label;
        const subgrades = b.result_subgrades !== undefined ? b.result_subgrades : sub.result_subgrades;
        const cert = b.cert_number ?? sub.cert_number;
        const gradedDate = b.graded_date ?? db.prepare(`SELECT date('now') AS d`).get().d;
        const item = pick({
          game: sub.game, identity_key: sub.identity_key, name: sub.name, set_name: sub.set_name,
          number: sub.number, variant: sub.variant, language: sub.language,
          grading_company: sub.grading_company, grade, grade_label: gradeLabel, subgrades,
          cert_number: cert, graded_date: gradedDate, status: 'in_stock',
          // grading cost is part of cost basis; let the client add the purchase cost separately
          acq_fees_cents: b.acq_fees_cents != null ? +b.acq_fees_cents : sub.grading_cost_cents,
          cost_cents: b.cost_cents != null ? +b.cost_cents : null,
          acquired_at: b.acquired_at ?? gradedDate, location: b.location ?? null,
          submission_id: sub.id,
        }, ITEM_INSERT_COLS);
        const sku = nextSku(db, sub.game);
        item.sku = sku;
        const itemId = insertRow(db, 'inventory_items', item);
        db.prepare(`UPDATE grading_submissions SET status = 'graded', promoted_item_id = ?, result_grade = ?,
          result_grade_label = ?, result_subgrades = ?, cert_number = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(itemId, grade ?? null, gradeLabel ?? null,
               (subgrades && typeof subgrades === 'object') ? JSON.stringify(subgrades) : (subgrades ?? null), cert ?? null, id);
        return send(res, 201, { item_id: itemId, sku });
      }

      // DELETE /submissions/:id
      if ((m = p.match(/^\/submissions\/(\d+)$/)) && method === 'DELETE') {
        db.prepare(`DELETE FROM grading_submissions WHERE id = ?`).run(+m[1]);
        return send(res, 200, { removed: true });
      }

      return send(res, 404, { error: 'unknown inventory route', path: p, method });
    } catch (e) {
      console.error('[api/inventory] error:', e?.message || e);
      return send(res, 500, { error: 'inventory error', detail: String(e?.message || e) });
    }
  };
}

export function inventoryPlugin(env) {
  return {
    name: 'inventory',
    configureServer(server) {
      const db = openDb();
      const port = (server.config && server.config.server && server.config.server.port) || 5273;
      const base = `http://127.0.0.1:${port}`;
      server.middlewares.use('/api/inventory', makeRouter({ db, env, base }));
      console.log('[inventory] DB ' + DB_PATH + ' · API /api/inventory · psa ' + (env.PSA_API_TOKEN ? 'on' : 'off'));
    },
  };
}
