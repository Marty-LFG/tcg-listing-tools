// lib/sealed.mjs — Vite plugin owning the SEALED-product inventory tables + the /api/sealed/* API.
// A sibling of lib/inventory.mjs (graded cards): sealed TCG stock (booster boxes, ETBs, bundles,
// tins, blisters, collections, packs, cases) for Pokémon / MTG / Riftbound, with cost basis / P&L,
// live PriceCharting valuation, and a bulk BARCODE-SCAN import. Shares the same openDb() handle and
// the same send/readJson/makeRouter shape; registered in vite.config.js `plugins`.
//
// Golden rules honoured: money is INTEGER CENTS (GR3); live valuation via lib/pricecharting.mjs, never
// a guess (GR4); barcode resolution NEVER throws and always degrades to manual entry — a blocked/down
// PriceCharting must not break a scan or a save (GR7); no new deps (node:sqlite only).
import { openDb, DB_PATH } from './db.mjs';
import { GAMES } from './normalize.mjs';
import { lookupByUpc, sealedByUrl, searchSealed, enumerateSealedConsole } from './pricecharting.mjs';

// ---- small http helpers (same shape as lib/inventory.mjs) ------------------
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

// ---- product-type taxonomy -------------------------------------------------
// A union enum; the UI shows only the game-relevant subset (TYPES_BY_GAME). MTG booster-box KIND
// (Draft/Set/Play/Collector) is captured in the product NAME, not the enum, to avoid sprawl.
export const PRODUCT_TYPES = [
  'booster_box', 'booster_pack', 'booster_case', 'booster_bundle', 'starter_deck',
  'elite_trainer_box', 'blister', 'tin', 'collection', 'premium_collection',
  'commander_deck', 'prerelease_pack', 'other',
];
export const TYPES_BY_GAME = {
  pokemon: ['booster_box', 'elite_trainer_box', 'booster_bundle', 'blister', 'tin', 'collection', 'premium_collection', 'booster_pack', 'booster_case', 'other'],
  mtg: ['booster_box', 'booster_bundle', 'commander_deck', 'prerelease_pack', 'starter_deck', 'booster_pack', 'booster_case', 'other'],
  riftbound: ['booster_box', 'booster_pack', 'booster_case', 'starter_deck', 'other'],
};
function typesForGame(game) { return TYPES_BY_GAME[game] || PRODUCT_TYPES; }

// ---- pure helpers (exported for the unit harness) --------------------------
// Strip separators; keep digits. '' if nothing usable.
export function normalizeUpc(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }
// Candidate forms for cache/source lookup: a 12-digit UPC-A and its 0-prefixed 13-digit EAN-13 are
// the same product; try both. De-duplicated, primary form first.
export function upcCandidates(code) {
  const c = normalizeUpc(code);
  if (!c) return [];
  const out = [c];
  if (c.length === 13 && c[0] === '0') out.push(c.slice(1));   // 0-padded EAN-13 -> UPC-A
  if (c.length === 12) out.push('0' + c);                       // UPC-A -> EAN-13
  return out.filter((v, i, a) => a.indexOf(v) === i);
}
// PriceCharting console-name -> our game key (sealed lives under game-named consoles). null if unknown.
export function gameFromConsole(consoleName) {
  const c = String(consoleName || '').toLowerCase();
  if (/pok[eé]?mon/.test(c)) return 'pokemon';
  if (/magic|mtg/.test(c)) return 'mtg';
  if (/riftbound/.test(c)) return 'riftbound';
  return null;
}
// Product title -> product_type via a keyword map (most-specific first). `game` is accepted for
// future game-specific disambiguation; today the map is shared. Falls back to 'other'.
// eslint-disable-next-line no-unused-vars
export function inferProductType(title, game) {
  const t = String(title || '').toLowerCase();
  const has = (re) => re.test(t);
  if (has(/elite trainer box|\betb\b/)) return 'elite_trainer_box';
  if (has(/premium collection/)) return 'premium_collection';
  if (has(/pre-?release/)) return 'prerelease_pack';
  if (has(/commander (deck|precon)|\bcommander\b/)) return 'commander_deck';
  if (has(/starter (deck|set)|two[- ]player|2[- ]player/)) return 'starter_deck';
  if (has(/booster bundle|\bbundle\b|fat pack/)) return 'booster_bundle';
  if (has(/booster case|\bcase\b/)) return 'booster_case';
  if (has(/booster box|\bbox\b/)) return 'booster_box';        // after ETB/case/bundle so those win
  if (has(/blister|checklane|hanger|sleeved booster/)) return 'blister';
  if (has(/\btin\b/)) return 'tin';
  if (has(/collection/)) return 'collection';
  if (has(/booster pack|\bpack\b/)) return 'booster_pack';
  return 'other';
}
// Pick the market value for a sealed item from a {sealed,loose,cib} price object by condition.
// Sealed uses the 'New' rung ONLY (never a loose/opened price as a proxy — that would misstate a
// sealed box's value); opened/damaged use loose then CIB. Returns {cents,label}|null (GR4: no invent).
export function valueForSealed(prices, condition) {
  if (!prices || typeof prices !== 'object') return null;
  const c = String(condition || 'sealed').toLowerCase();
  const order = (c === 'opened' || c === 'damaged')
    ? [['loose', 'Loose'], ['cib', 'CIB']]
    : [['sealed', 'New']];
  for (const [k, label] of order) if (prices[k] != null) return { cents: prices[k], label };
  return null;
}

// ---- DB write helpers ------------------------------------------------------
const INT_BOOL_COLS = new Set(['factory_sealed', 'image_manual', 'value_manual']);
function pick(body, cols) {
  const out = {};
  for (const c of cols) if (body[c] !== undefined) out[c] = body[c];
  for (const c of INT_BOOL_COLS) if (out[c] !== undefined) out[c] = out[c] ? 1 : 0;   // JSON bools -> 0/1
  return out;
}
function insertRow(db, table, obj) {
  const cols = Object.keys(obj);
  const ph = cols.map(() => '?').join(',');
  const r = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`).run(...cols.map((c) => obj[c]));
  return r.lastInsertRowid;
}

const GAMECODE = { riftbound: 'RB', mtg: 'MTG', pokemon: 'PKM', swu: 'SWU', lorcana: 'LOR' };
// Atomic per-game SKU sequence (single-writer model => no race). BK-SLD-PKM-000042.
function nextSku(db, game) {
  const ns = 'SLD-' + (GAMECODE[game] || 'GEN');
  db.prepare(`INSERT INTO sku_counter (namespace, seq) VALUES (?, 1)
              ON CONFLICT(namespace) DO UPDATE SET seq = seq + 1`).run(ns);
  const seq = db.prepare(`SELECT seq FROM sku_counter WHERE namespace = ?`).get(ns).seq;
  return 'BK-' + ns + '-' + String(seq).padStart(6, '0');
}

function recountBatch(db, batchId) {
  db.prepare(`UPDATE sealed_batches SET
      item_count = (SELECT COUNT(*) FROM sealed_items WHERE batch_id = ?),
      unit_count = COALESCE((SELECT SUM(quantity) FROM sealed_items WHERE batch_id = ?), 0),
      updated_at = datetime('now')
    WHERE id = ?`).run(batchId, batchId, batchId);
}

// Latest sealed-value series for an item's sparkline, shaped for TCG.lineGraph ([{daysAgo,price}]).
function getValSeries(db, itemId, days = 365) {
  return db.prepare(
    `SELECT ROUND(julianday('now') - julianday(ts), 3) AS daysAgo, value_cents AS c
     FROM sealed_valuations
     WHERE item_id = ? AND value_cents IS NOT NULL AND ts >= datetime('now', ?)
     ORDER BY ts ASC`).all(itemId, `-${days} days`).map((r) => ({ daysAgo: r.daysAgo, price: r.c / 100 }));
}
function itemWithPl(db, row) {
  const vals = getValSeries(db, row.id);
  return { ...row, spark: vals, val_count: vals.length };
}

// ---- barcode cache <-> product -----------------------------------------------
function barcodeToProduct(row) {
  let prices = {};
  try { const j = row.product_json ? JSON.parse(row.product_json) : null; if (j && j.prices) prices = j.prices; } catch { /* ignore */ }
  return {
    game: row.game || null, name: row.name || '', set_name: row.set_name || '',
    product_type: row.product_type || 'other', upc: row.upc,
    pc_product_id: row.pc_product_id || null, pc_url: row.pc_url || null, image_url: row.image_url || null,
    suggested_cents: row.suggested_cents != null ? row.suggested_cents : null,
    suggested_currency: row.suggested_currency || 'USD', prices,
  };
}
function upsertBarcode(db, { code, product, source, confidence, confirmed, raw }) {
  db.prepare(`INSERT INTO sealed_barcodes
      (upc, game, name, set_name, product_type, pc_product_id, pc_url, image_url,
       suggested_cents, suggested_currency, product_json, source, confidence, confirmed, hit_count, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'))
    ON CONFLICT(upc) DO UPDATE SET
      game=excluded.game, name=excluded.name, set_name=excluded.set_name, product_type=excluded.product_type,
      pc_product_id=excluded.pc_product_id, pc_url=excluded.pc_url,
      image_url=COALESCE(excluded.image_url, sealed_barcodes.image_url),
      suggested_cents=COALESCE(excluded.suggested_cents, sealed_barcodes.suggested_cents),
      suggested_currency=excluded.suggested_currency, product_json=excluded.product_json,
      source=excluded.source, confidence=excluded.confidence,
      confirmed=MAX(sealed_barcodes.confirmed, excluded.confirmed),
      hit_count=sealed_barcodes.hit_count+1, updated_at=datetime('now')`)
    .run(code, product.game || null, product.name || null, product.set_name || null, product.product_type || null,
      product.pc_product_id || null, product.pc_url || null, product.image_url || null,
      product.suggested_cents != null ? product.suggested_cents : null, product.suggested_currency || 'USD',
      JSON.stringify(raw != null ? raw : product), source || null, confidence || null, confirmed ? 1 : 0);
}

// The resolve pipeline: local cache -> PriceCharting API (token) -> scrape -> miss. Never throws (GR7).
async function resolveUpc(db, { upc, env }) {
  const cands = upcCandidates(upc);
  if (!cands.length) return { matched: false, upc: '' };
  const code = cands[0];
  // 1) local cache (prefer confirmed, then most-hit)
  const ph = cands.map(() => '?').join(',');
  const cached = db.prepare(`SELECT * FROM sealed_barcodes WHERE upc IN (${ph}) ORDER BY confirmed DESC, hit_count DESC LIMIT 1`).all(...cands)[0];
  if (cached) {
    db.prepare(`UPDATE sealed_barcodes SET hit_count = hit_count + 1, updated_at = datetime('now') WHERE upc = ?`).run(cached.upc);
    return { matched: true, source: 'cache', confidence: cached.confidence || 'manual', product: barcodeToProduct(cached), cached: true };
  }
  // 2/3) PriceCharting: official API when a token is set, else keyless scrape.
  const token = (env.PRICECHARTING_TOKEN || '').trim();
  const pcEnabled = String(env.PRICECHARTING_ENABLED || 'true').toLowerCase() !== 'false';
  let r = null;
  if (pcEnabled) { try { r = await lookupByUpc({ upc: code, token, enabled: true }); } catch { r = null; } }
  if (r && r.matched) {
    const game = gameFromConsole(r.consoleName);
    const product = {
      game, name: r.name || '', set_name: r.consoleName || '', product_type: inferProductType(r.name, game),
      upc: code, pc_product_id: r.pc_product_id || null, pc_url: r.url || null, image_url: r.image || null,
      suggested_cents: (r.prices && r.prices.sealed != null) ? r.prices.sealed : null, suggested_currency: 'USD',
      prices: r.prices || {},
    };
    upsertBarcode(db, { code, product, source: r.source, confidence: r.confidence, confirmed: 0, raw: r });
    return { matched: true, source: r.source, confidence: r.confidence, product, cached: false };
  }
  return { matched: false, upc: code };   // UI -> manual entry; POST /barcodes remembers it
}

const SEALED_INSERT_COLS = [
  'game', 'product_type', 'name', 'set_name', 'language', 'upc', 'pc_product_id', 'pc_url',
  'condition', 'factory_sealed', 'pack_count', 'units_per_case', 'quantity', 'location', 'status',
  'cost_cents', 'acq_fees_cents', 'acquired_at', 'source_vendor', 'sale_price_cents', 'sale_fees_cents', 'sold_at',
  'target_price_cents', 'notes', 'value_cents', 'value_currency', 'value_source', 'value_manual',
  'image_url', 'image_manual', 'batch_id', 'ebay_listing_id', 'shopify_product_id', 'channel_status',
];
const SEALED_PATCH_COLS = SEALED_INSERT_COLS;

function makeRouter({ db, env }) {
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

      // GET /summary — portfolio P&L (money in cents; FX left to the client). Money amounts are per
      // ROW (as entered), matching the graded tool's convention; `units` is SUM(quantity) of held stock.
      if (p === '/summary' && method === 'GET') {
        const rows = db.prepare(`SELECT status, game, product_type, cost_cents, acq_fees_cents,
          sale_price_cents, sale_fees_cents, value_cents, value_currency, quantity FROM sealed_items`).all();
        const cents = (n) => (n == null ? 0 : +n);
        const counts = { total: rows.length, in_stock: 0, listed: 0, sold: 0 };
        const byGame = {}, byType = {}, valueByCurrency = {};
        let totalCostCents = 0, realizedPlCents = 0, units = 0;
        for (const r of rows) {
          counts[r.status] = (counts[r.status] || 0) + 1;
          byGame[r.game] = (byGame[r.game] || 0) + 1;
          byType[r.product_type] = (byType[r.product_type] || 0) + 1;
          if (r.status === 'sold') {
            realizedPlCents += cents(r.sale_price_cents) - cents(r.sale_fees_cents) - cents(r.cost_cents) - cents(r.acq_fees_cents);
          } else {
            units += (r.quantity || 0);
            totalCostCents += cents(r.cost_cents) + cents(r.acq_fees_cents);
            if (r.value_cents != null) { const cur = r.value_currency || 'USD'; valueByCurrency[cur] = (valueByCurrency[cur] || 0) + cents(r.value_cents); }
          }
        }
        return send(res, 200, { counts, totalCostCents, realizedPlCents, valueByCurrency, byGame, byType, units });
      }

      // GET /locations — distinct non-empty item locations, most-used first (add-form combobox).
      if (p === '/locations' && method === 'GET') {
        const rows = db.prepare(`SELECT location, COUNT(*) AS n FROM sealed_items
          WHERE location IS NOT NULL AND TRIM(location) <> ''
          GROUP BY location ORDER BY n DESC, location ASC`).all();
        return send(res, 200, { locations: rows.map((r) => r.location) });
      }

      // GET /product-types — the enum + per-game subsets (drives the UI dropdowns).
      if (p === '/product-types' && method === 'GET') {
        return send(res, 200, { types: PRODUCT_TYPES, by_game: TYPES_BY_GAME });
      }

      // GET /export — full bundle (accounting / Claude).
      if (p === '/export' && method === 'GET') {
        const now = db.prepare(`SELECT datetime('now') AS now`).get().now;
        const items = db.prepare(`SELECT * FROM sealed_items ORDER BY created_at DESC`).all();
        const batches = db.prepare(`SELECT * FROM sealed_batches ORDER BY created_at DESC`).all();
        return send(res, 200, { generated_at: now, items, batches });
      }

      // POST /resolve/upc — barcode -> product (cache -> PriceCharting -> miss). No DB item write.
      if (p === '/resolve/upc' && method === 'POST') {
        const b = await readJson(req);
        const out = await resolveUpc(db, { upc: b.upc, env });
        return send(res, 200, out);
      }

      // POST /resolve/search — text fallback for manual disambiguation (scrapes PriceCharting search).
      if (p === '/resolve/search' && method === 'POST') {
        const b = await readJson(req);
        const query = String(b.q || '').trim();
        if (!query) return send(res, 400, { error: 'q required' });
        let hits = [];
        if (pcEnabled) { try { hits = await searchSealed(query); } catch { hits = []; } }
        const results = hits.map((h) => {
          const game = gameFromConsole(h.consoleName);
          return { name: h.productName, set_name: h.consoleName, game, product_type: inferProductType(h.productName, game),
            pc_product_id: h.productId || null, pc_url: h.url || null, prices: h.prices || {} };
        });
        return send(res, 200, { query, results });
      }

      // GET /console?slug=&game= — browse-by-set (secondary): enumerate a console's SEALED products.
      if (p === '/console' && method === 'GET') {
        const slug = q.get('slug');
        if (!slug) return send(res, 400, { error: 'slug required' });
        if (!pcEnabled) return send(res, 200, { products: [], reason: 'pc_disabled' });
        const game = q.get('game') || null;
        const r = await enumerateSealedConsole(slug);
        const products = (r.products || []).map((pr) => ({ ...pr, product_type: inferProductType(pr.name, game) }));
        return send(res, 200, { slug, stale: r.stale, products });
      }

      // GET /barcodes — recent cache entries (inspection / management).
      if (p === '/barcodes' && method === 'GET') {
        const rows = db.prepare(`SELECT upc, game, name, set_name, product_type, suggested_cents, suggested_currency,
          source, confidence, confirmed, hit_count, updated_at FROM sealed_barcodes ORDER BY updated_at DESC LIMIT 500`).all();
        return send(res, 200, { barcodes: rows });
      }

      // POST /barcodes — remember a (manual) barcode mapping so the next scan resolves instantly.
      if (p === '/barcodes' && method === 'POST') {
        const b = await readJson(req);
        const code = normalizeUpc(b.upc);
        if (!code) return send(res, 400, { error: 'upc required' });
        if (!b.name) return send(res, 400, { error: 'name required' });
        const product = {
          game: b.game || null, name: b.name, set_name: b.set_name || null,
          product_type: b.product_type || 'other', pc_product_id: b.pc_product_id || null, pc_url: b.pc_url || null,
          image_url: b.image_url || null, suggested_cents: b.suggested_cents != null ? Math.round(+b.suggested_cents) : null,
          suggested_currency: b.suggested_currency || 'USD', prices: b.prices || {},
        };
        upsertBarcode(db, { code, product, source: b.source || 'manual', confidence: 'manual', confirmed: 1, raw: { manual: true, prices: product.prices } });
        return send(res, 201, { upc: code, remembered: true });
      }

      // GET /barcodes/:upc — one cache entry (full payload).
      if ((m = p.match(/^\/barcodes\/(\d+)$/)) && method === 'GET') {
        const row = db.prepare(`SELECT * FROM sealed_barcodes WHERE upc = ?`).get(m[1]);
        if (!row) return send(res, 404, { error: 'no such barcode' });
        return send(res, 200, { barcode: row });
      }

      // PATCH /barcodes/:upc — correct a stored mapping.
      if ((m = p.match(/^\/barcodes\/(\d+)$/)) && method === 'PATCH') {
        const b = await readJson(req);
        const obj = pick(b, ['game', 'name', 'set_name', 'product_type', 'pc_product_id', 'pc_url', 'image_url', 'suggested_cents', 'suggested_currency', 'confirmed']);
        const cols = Object.keys(obj);
        if (!cols.length) return send(res, 400, { error: 'nothing to update' });
        db.prepare(`UPDATE sealed_barcodes SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE upc = ?`)
          .run(...cols.map((c) => obj[c]), m[1]);
        return send(res, 200, { updated: true });
      }

      // DELETE /barcodes/:upc — forget a mapping.
      if ((m = p.match(/^\/barcodes\/(\d+)$/)) && method === 'DELETE') {
        db.prepare(`DELETE FROM sealed_barcodes WHERE upc = ?`).run(m[1]);
        return send(res, 200, { removed: true });
      }

      // GET /items — filters: game, product_type, status, set, q (name / sku / upc)
      if (p === '/items' && method === 'GET') {
        const where = ['1 = 1'], args = [];
        if (q.get('game')) { where.push('game = ?'); args.push(q.get('game')); }
        if (q.get('product_type')) { where.push('product_type = ?'); args.push(q.get('product_type')); }
        if (q.get('status')) { where.push('status = ?'); args.push(q.get('status')); }
        if (q.get('set')) { where.push('set_name LIKE ?'); args.push('%' + q.get('set') + '%'); }
        if (q.get('q')) { where.push('(name LIKE ? OR sku LIKE ? OR upc LIKE ?)'); const s = '%' + q.get('q') + '%'; args.push(s, s, s); }
        const rows = db.prepare(`SELECT * FROM sealed_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...args);
        return send(res, 200, { items: rows.map((r) => itemWithPl(db, r)) });
      }

      // POST /items — create (generates SKU; validates game + product_type).
      if (p === '/items' && method === 'POST') {
        const b = await readJson(req);
        if (!GAMES.includes(b.game)) return send(res, 400, { error: 'game must be one of ' + GAMES.join('/') });
        if (!b.name) return send(res, 400, { error: 'name is required' });
        const pt = typesForGame(b.game).includes(b.product_type) ? b.product_type : (b.product_type || 'other');
        const obj = pick({ ...b, product_type: pt }, SEALED_INSERT_COLS);
        obj.sku = nextSku(db, b.game);
        const id = insertRow(db, 'sealed_items', obj);
        if (b.value_cents != null) {
          insertRow(db, 'sealed_valuations', {
            item_id: id, value_cents: +b.value_cents, currency: b.value_currency || 'USD',
            source: b.value_source || 'manual', price_label: b.price_label || null,
          });
        }
        return send(res, 201, { id, sku: obj.sku, created: true });
      }

      // GET /items/:id/valuations — value history (for the sparkline / detail view)
      if ((m = p.match(/^\/items\/(\d+)\/valuations$/)) && method === 'GET') {
        const id = +m[1];
        const points = db.prepare(`SELECT ts, value_cents, currency, source, price_label, sample_size
          FROM sealed_valuations WHERE item_id = ? ORDER BY ts ASC`).all(id);
        return send(res, 200, { id, series: getValSeries(db, id), points });
      }

      // POST /items/:id/refresh-value — pull live SEALED value from PriceCharting.
      // Resolves by the stored product page (exact) then the UPC; a name search is too ambiguous for
      // sealed, so a row with neither pc_url nor upc reports no_source rather than risking a wrong match.
      if ((m = p.match(/^\/items\/(\d+)\/refresh-value$/)) && method === 'POST') {
        const id = +m[1];
        const force = q.get('force') === '1';
        const item = db.prepare(`SELECT * FROM sealed_items WHERE id = ?`).get(id);
        if (!item) return send(res, 404, { error: 'no such item' });
        if (!pcEnabled) return send(res, 200, { updated: false, reason: 'pc_disabled' });
        if (item.value_manual && !force) return send(res, 200, { updated: false, reason: 'manual_override' });
        let prices = null, srcUrl = item.pc_url || null;
        try {
          if (item.pc_url) { const prod = await sealedByUrl(item.pc_url); if (prod && prod.matched) prices = prod.prices; }
          if (!prices && item.upc) { const r = await lookupByUpc({ upc: item.upc, token: pcToken, enabled: true }); if (r && r.matched) { prices = r.prices; srcUrl = r.url || srcUrl; } }
        } catch { /* GR7 — leave prices null */ }
        if (!prices || Object.values(prices).every((v) => v == null)) return send(res, 200, { updated: false, reason: 'no_source' });
        const v = valueForSealed(prices, item.condition);
        if (!v) return send(res, 200, { updated: false, reason: 'no_rung', prices });
        insertRow(db, 'sealed_valuations', {
          item_id: id, value_cents: v.cents, currency: 'USD', source: 'pricecharting',
          price_label: v.label, raw: JSON.stringify({ url: srcUrl, rung: v.label }),
        });
        db.prepare(`UPDATE sealed_items SET value_cents = ?, value_currency = 'USD', value_source = 'pricecharting',
          value_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(v.cents, id);
        return send(res, 200, { updated: true, value_cents: v.cents, currency: 'USD', price_label: v.label });
      }

      // POST /items/:id/value-manual — set a value directly (user override, or an eBay-comp fair value).
      if ((m = p.match(/^\/items\/(\d+)\/value-manual$/)) && method === 'POST') {
        const id = +m[1];
        const b = await readJson(req);
        if (b.value_cents == null) return send(res, 400, { error: 'value_cents required' });
        const src = b.source || 'manual';
        const manual = src === 'manual' ? 1 : 0;
        const cur = b.currency || 'AUD';
        insertRow(db, 'sealed_valuations', {
          item_id: id, value_cents: +b.value_cents, currency: cur, source: src,
          price_label: b.price_label || null, sample_size: b.sample_size != null ? +b.sample_size : null,
        });
        db.prepare(`UPDATE sealed_items SET value_cents = ?, value_currency = ?, value_source = ?,
          value_manual = ?, value_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .run(+b.value_cents, cur, src, manual, id);
        return send(res, 200, { updated: true });
      }

      // GET /items/:id
      if ((m = p.match(/^\/items\/(\d+)$/)) && method === 'GET') {
        const id = +m[1];
        const row = db.prepare(`SELECT * FROM sealed_items WHERE id = ?`).get(id);
        if (!row) return send(res, 404, { error: 'no such item' });
        const points = db.prepare(`SELECT ts, value_cents, currency, source, price_label FROM sealed_valuations WHERE item_id = ? ORDER BY ts ASC`).all(id);
        return send(res, 200, { item: itemWithPl(db, row), valuations: points });
      }

      // PATCH /items/:id — partial update (whitelisted columns).
      if ((m = p.match(/^\/items\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        const b = await readJson(req);
        const obj = pick(b, SEALED_PATCH_COLS);
        const cols = Object.keys(obj);
        if (!cols.length) return send(res, 400, { error: 'nothing to update' });
        const sets = cols.map((c) => c + ' = ?').concat([`updated_at = datetime('now')`]);
        db.prepare(`UPDATE sealed_items SET ${sets.join(', ')} WHERE id = ?`).run(...cols.map((c) => obj[c]), id);
        return send(res, 200, { updated: true });
      }

      // DELETE /items/:id (hard; cascades valuations)
      if ((m = p.match(/^\/items\/(\d+)$/)) && method === 'DELETE') {
        db.prepare(`DELETE FROM sealed_items WHERE id = ?`).run(+m[1]);
        return send(res, 200, { removed: true });
      }

      // GET /batches — scan-session list.
      if (p === '/batches' && method === 'GET') {
        const rows = db.prepare(`SELECT * FROM sealed_batches ORDER BY created_at DESC`).all();
        return send(res, 200, { batches: rows });
      }

      // POST /batches — save a scan session: create a header + insert its rows (one txn, per-row
      // try/catch so one bad row never aborts the batch — GR7). Dedup within the batch by upc (else
      // product_type+name+set+condition): a repeat increments quantity; listed/sold rows are untouched.
      if (p === '/batches' && method === 'POST') {
        const b = await readJson(req);
        const rows = Array.isArray(b.rows) ? b.rows : [];
        if (!rows.length) return send(res, 400, { error: 'rows required' });
        const stats = { batch_id: null, inserted: 0, updated: 0, skipped: 0, errors: [] };
        db.exec('BEGIN');
        try {
          const batchId = insertRow(db, 'sealed_batches', { label: b.label || null, source: b.source || 'scan', status: 'saved' });
          stats.batch_id = batchId;
          for (const raw of rows) {
            try {
              const game = raw.game;
              if (!GAMES.includes(game)) { stats.skipped++; stats.errors.push({ row: raw && raw.name, error: 'unsupported game ' + game }); continue; }
              if (!raw.name) { stats.skipped++; stats.errors.push({ row: '(no name)', error: 'name required' }); continue; }
              const productType = typesForGame(game).includes(raw.product_type) ? raw.product_type : (raw.product_type || 'other');
              const condition = raw.condition || 'sealed';
              const qty = raw.quantity != null ? Math.max(1, Math.round(+raw.quantity)) : 1;
              let existing = null;
              if (raw.upc) {
                existing = db.prepare(`SELECT id, status FROM sealed_items WHERE batch_id = ? AND upc = ? LIMIT 1`).get(batchId, String(raw.upc));
              } else {
                existing = db.prepare(`SELECT id, status FROM sealed_items WHERE batch_id = ? AND product_type = ?
                  AND lower(name) = lower(?) AND IFNULL(set_name,'') = IFNULL(?, '') AND condition = ? LIMIT 1`)
                  .get(batchId, productType, raw.name, raw.set_name || null, condition);
              }
              if (existing) {
                if (existing.status !== 'in_stock') { stats.skipped++; continue; }   // listed/sold: hands off
                db.prepare(`UPDATE sealed_items SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?`).run(qty, existing.id);
                stats.updated++;
                continue;
              }
              const obj = pick({
                game, product_type: productType, name: raw.name, set_name: raw.set_name || null, language: raw.language || 'EN',
                upc: raw.upc || null, pc_product_id: raw.pc_product_id || null, pc_url: raw.pc_url || null,
                condition, factory_sealed: raw.factory_sealed != null ? raw.factory_sealed : 1,
                pack_count: raw.pack_count != null ? +raw.pack_count : null,
                units_per_case: raw.units_per_case != null ? +raw.units_per_case : null,
                quantity: qty, location: raw.location || null, status: 'in_stock',
                cost_cents: raw.cost_cents != null ? Math.round(+raw.cost_cents) : null,
                target_price_cents: raw.target_price_cents != null ? Math.round(+raw.target_price_cents)
                  : (raw.price_cents != null ? Math.round(+raw.price_cents) : null),
                value_cents: raw.value_cents != null ? Math.round(+raw.value_cents) : null,
                value_currency: raw.value_cents != null ? (raw.value_currency || 'USD') : null,
                value_source: raw.value_source || (raw.value_cents != null ? 'pricecharting' : null),
                image_url: raw.image_url || null, notes: raw.notes || null, batch_id: batchId,
              }, SEALED_INSERT_COLS);
              obj.sku = nextSku(db, game);
              const itemId = insertRow(db, 'sealed_items', obj);
              if (obj.value_cents != null) {
                insertRow(db, 'sealed_valuations', { item_id: itemId, value_cents: obj.value_cents, currency: obj.value_currency || 'USD', source: obj.value_source || 'manual' });
              }
              stats.inserted++;
            } catch (e) {   // per-row failure never aborts the batch (GR7)
              stats.errors.push({ row: raw && raw.name, error: String((e && e.message) || e) });
            }
          }
          recountBatch(db, batchId);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          return send(res, 500, { error: 'batch save failed', detail: String((e && e.message) || e) });
        }
        return send(res, 201, stats);
      }

      // GET /batches/:id — header + its items (rehydrate a session).
      if ((m = p.match(/^\/batches\/(\d+)$/)) && method === 'GET') {
        const id = +m[1];
        const batch = db.prepare(`SELECT * FROM sealed_batches WHERE id = ?`).get(id);
        if (!batch) return send(res, 404, { error: 'no such batch' });
        const items = db.prepare(`SELECT * FROM sealed_items WHERE batch_id = ? ORDER BY created_at DESC`).all(id);
        return send(res, 200, { batch, items });
      }

      // DELETE /batches/:id — remove the batch; in-stock items are kept but unlinked (audit-safe).
      if ((m = p.match(/^\/batches\/(\d+)$/)) && method === 'DELETE') {
        const id = +m[1];
        const alsoItems = q.get('items') === '1';
        if (alsoItems) db.prepare(`DELETE FROM sealed_items WHERE batch_id = ? AND status = 'in_stock'`).run(id);
        db.prepare(`DELETE FROM sealed_batches WHERE id = ?`).run(id);
        return send(res, 200, { removed: true, items_removed: alsoItems });
      }

      return send(res, 404, { error: 'unknown sealed route', path: p, method });
    } catch (e) {
      console.error('[api/sealed] error:', e?.message || e);
      return send(res, 500, { error: 'sealed error', detail: String(e?.message || e) });
    }
  };
}

export function sealedPlugin(env) {
  return {
    name: 'sealed',
    configureServer(server) {
      const db = openDb();
      const port = (server.config && server.config.server && server.config.server.port) || 5273;
      const base = `http://127.0.0.1:${port}`;
      server.middlewares.use('/api/sealed', makeRouter({ db, env, base }));
      console.log('[sealed] DB ' + DB_PATH + ' · API /api/sealed · pc ' + ((env.PRICECHARTING_TOKEN || '').trim() ? 'api' : 'scrape'));
    },
  };
}
