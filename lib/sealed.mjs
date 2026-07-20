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
import { STOCK_GAMES } from './normalize.mjs';
import { lookupByUpc, sealedByUrl, searchSealed, enumerateSealedConsole } from './pricecharting.mjs';
import { lookupUpcName } from './upcitemdb.mjs';
import { sealedEbayValue } from './comps.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Natural alphanumeric sort: "Storage Crate 2" before "Storage Crate 10" (not 1,10,11,2). Case-insensitive.
export const naturalCompare = (a, b) => String(a == null ? '' : a).localeCompare(String(b == null ? '' : b), 'en', { numeric: true, sensitivity: 'base' });

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
// Larger-body JSON reader for photo uploads (data URLs). Rejects (never truncates) over the cap so a
// too-big upload fails cleanly with 413 rather than corrupting the payload.
function readJsonBig(req, maxBytes = 16 * 1024 * 1024) {
  return new Promise((resolve) => {
    let b = '', over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > maxBytes) over = true; });
    req.on('end', () => { if (over) return resolve({ __oversize: true }); try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
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
  swu: ['booster_box', 'booster_pack', 'booster_case', 'starter_deck', 'prerelease_pack', 'other'],
  lorcana: ['booster_box', 'booster_pack', 'booster_case', 'starter_deck', 'collection', 'tin', 'other'],
  onepiece: ['booster_box', 'booster_pack', 'booster_case', 'starter_deck', 'other'],
  other: PRODUCT_TYPES,   // generic "Other" game → the full product-type enum
};
// Sealed inventory accepts every stockable game (incl. One Piece) PLUS a generic "other" (Yu-Gi-Oh,
// Digimon, …). STOCK_GAMES is the shared inventory list (see lib/normalize.mjs).
export const SEALED_GAMES = [...STOCK_GAMES, 'other'];
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
  if (/lorcana/.test(c)) return 'lorcana';
  if (/star wars.*unlimited|\bswu\b/.test(c)) return 'swu';
  if (/one piece/.test(c)) return 'onepiece';
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
// Normalise an incoming placements array ([{location, quantity}]) into clean rows to persist:
// trims locations ('' -> null "unassigned"), rounds quantities, DROPS non-positive rows, and MERGES
// rows that share a location (case-insensitive, first-seen casing wins) so a spot never appears
// twice. Order is preserved. Returns [] if nothing usable — callers supply a fallback single row.
const MAX_QTY = 1_000_000;   // sane ceiling so a fat-fingered/garbage quantity can't overflow the INTEGER mirror
export function sanitizePlacements(list) {
  const map = new Map();
  for (const p of (Array.isArray(list) ? list : [])) {
    const loc = (p && p.location != null && String(p.location).trim()) ? String(p.location).trim() : null;
    let qty = (p && p.quantity != null) ? Math.round(+p.quantity) : 0;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    qty = Math.min(MAX_QTY, qty);
    const key = loc == null ? '' : loc.toLowerCase();   // '' bucket = unassigned (a real loc is never blank)
    const cur = map.get(key);
    if (cur) cur.quantity += qty;
    else map.set(key, { location: loc, quantity: qty });
  }
  return [...map.values()];
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

// ---- barcode -> PriceCharting sealed match (name bridge) --------------------
// PriceCharting's public search can't resolve a UPC, so we resolve the barcode to a NAME via
// lib/upcitemdb.mjs and then find the right PriceCharting SEALED product by that name. A plain name
// search returns dozens of loose matches (a wrong price is worse than none — GR4), so pick precisely:
// the hit's console SET tokens must all be present in the resolved title, and its product name must
// carry the product-type phrase.
const SEALED_TYPE_PHRASES = {
  elite_trainer_box: ['elite trainer box', 'etb'],
  booster_box: ['booster box'],
  booster_case: ['booster case', 'case'],
  booster_bundle: ['booster bundle', 'bundle'],
  booster_pack: ['booster pack'],
  blister: ['blister', 'sleeved booster', 'checklane', 'hanger', '3pk', '3 pack', 'pack'],
  tin: ['tin'],
  collection: ['collection'],
  premium_collection: ['premium collection', 'collection'],
  starter_deck: ['starter'],
  commander_deck: ['commander'],
  prerelease_pack: ['prerelease', 'pre release'],
};
// Generic words that never distinguish a SET from another (so they don't create false set matches).
const SEALED_STOP = new Set(['pokemon', 'pokemon', 'magic', 'mtg', 'tcg', 'ccg', 'trading', 'card', 'game',
  'the', 'and', 'of', 'a', 'english', 'japanese', 'scarlet', 'violet', 'sword', 'shield', 'sun', 'moon',
  'elite', 'trainer', 'box', 'booster', 'pack', 'case', 'bundle', 'tin', 'collection', 'premium', 'blister',
  'starter', 'deck', 'commander', 'prerelease', 'set', 'plus', 'display', 'center', 'build', 'battle']);
function sealedTokens(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((t) => t && !SEALED_STOP.has(t));
}
// Choose the sealed hit that matches a resolved barcode title, or null (ambiguous/none → never guess).
// Exported for the offline unit harness.
export function pickSealedHit(hits, { title, productType } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return null;
  const titleToks = new Set(sealedTokens(title));
  const phrases = SEALED_TYPE_PHRASES[productType] || [];
  const wantsPokemonCenter = /pokemon center|elite trainer box plus/i.test(title || '');
  const cands = list.filter((h) => {
    const setToks = sealedTokens(h.consoleName);
    if (!setToks.length || !setToks.every((t) => titleToks.has(t))) return false;   // console SET ⊆ title
    if (!phrases.length) return true;
    const pn = String(h.productName || '').toLowerCase();
    return phrases.some((ph) => pn.includes(ph));
  });
  if (!cands.length) return null;
  // Prefer the variant whose "[Pokemon Center]"-ness matches the title, then the plainest product name.
  const scored = cands.map((h) => {
    const isPC = /pokemon center/i.test(h.productName || '');
    const key = (isPC === wantsPokemonCenter ? 0 : 100) + String(h.productName || '').length;
    return { h, key };
  }).sort((a, b) => a.key - b.key);
  if (scored.length > 1 && scored[0].key === scored[1].key) return null;   // tie → ambiguous, refuse
  return scored[0].h;
}

// ---- fuzzy catalog search (over the permanent UPC cache) -------------------
// The sealed_barcodes table is a permanent barcode->product cache (a UPC never changes), so a scanned
// product is reused forever. These pure helpers add typo-tolerant search by NAME or UPC over that
// cache. Trigram Dice similarity handles typos without any index/dep (node:sqlite ships FTS5+trigram
// if this ever needs to scale to 100k+ rows — a drop-in, still no Redis). Exported for the unit harness.
export function trigrams(s) {
  const t = ' ' + String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ') + ' ';
  const out = new Set();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}
// Fraction of the QUERY's trigrams present in the target (containment): 0 (none) .. 1 (all). Better
// than a Dice coefficient for "is this short query a fuzzy substring of a longer product name" — it
// tolerates typos AND length differences (Dice over-penalizes the long name's extra trigrams).
export function fuzzyContainment(query, target) {
  const A = trigrams(query);
  if (!A.size) return 0;
  const B = trigrams(target);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / A.size;
}
// Score a query against a cached product row (0..1). A digit-heavy query is a UPC search (exact wins,
// then substring, then fuzzy); otherwise a name/set search (exact substring/prefix beat fuzzy).
// Exported for the unit harness.
export function catalogScore(q, row) {
  const query = String(q == null ? '' : q).trim().toLowerCase();
  if (!query || !row) return 0;
  const qDigits = query.replace(/\D+/g, '');
  const compact = query.replace(/\s+/g, '');
  const isUpcQuery = qDigits.length >= 6 && (qDigits.length / (compact.length || 1)) > 0.7;
  if (isUpcQuery) {
    const upc = String(row.upc || '');
    if (!upc) return 0;
    if (upc === qDigits) return 1;
    if (upc.includes(qDigits) || qDigits.includes(upc)) return 0.95;   // partial UPC / EAN-13 vs UPC-A
    return 0.7 * fuzzyContainment(qDigits, upc);
  }
  const name = String(row.name || '').toLowerCase();
  const hay = (name + ' ' + String(row.set_name || '').toLowerCase()).trim();
  if (!hay) return 0;
  let score = fuzzyContainment(query, hay);
  if (hay.includes(query)) score = Math.max(score, 0.9);
  if (name.startsWith(query)) score = Math.max(score, 0.95);
  return score;
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

const GAMECODE = { riftbound: 'RB', mtg: 'MTG', pokemon: 'PKM', swu: 'SWU', lorcana: 'LOR', onepiece: 'OP' };
// Atomic per-game SKU sequence (single-writer model => no race). BK-SLD-PKM-000042.
function nextSku(db, game) {
  const ns = 'SLD-' + (GAMECODE[game] || 'GEN');
  db.prepare(`INSERT INTO sku_counter (namespace, seq) VALUES (?, 1)
              ON CONFLICT(namespace) DO UPDATE SET seq = seq + 1`).run(ns);
  const seq = db.prepare(`SELECT seq FROM sku_counter WHERE namespace = ?`).get(ns).seq;
  return 'BK-' + ns + '-' + String(seq).padStart(6, '0');
}

// ---- per-location stock placements ----------------------------------------
// One sealed_item can split its units across storage spots. sealed_placements holds the detail;
// sealed_items.quantity + .location are cached mirrors (SUM + primary spot) so every existing
// SUM(quantity)/location reader keeps working. These four helpers own the mirror invariant.

function getPlacements(db, itemId) {
  return db.prepare(`SELECT id, location, quantity FROM sealed_placements WHERE item_id = ? ORDER BY id`).all(itemId);
}
// Recompute the cached scalar mirror on sealed_items from its placement rows. No placements => leave
// the scalars untouched (nothing to mirror — shouldn't happen once an item has been written).
function recomputeItemStock(db, itemId) {
  const rows = getPlacements(db, itemId);
  if (!rows.length) return;
  const total = rows.reduce((s, r) => s + (r.quantity || 0), 0);
  const primary = rows.find((r) => r.location && String(r.location).trim());
  db.prepare(`UPDATE sealed_items SET quantity = ?, location = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(total, primary ? primary.location : null, itemId);
}
// Replace an item's placements wholesale (used by create + edit). `rows` is already sanitized; an
// empty list falls back to a single unassigned unit so an item is never left with zero placements
// (keeps quantity >= 1, matching the tool's long-standing min-quantity-1 behaviour).
function setPlacements(db, itemId, rows) {
  const list = (rows && rows.length) ? rows : [{ location: null, quantity: 1 }];
  db.prepare(`DELETE FROM sealed_placements WHERE item_id = ?`).run(itemId);
  const ins = db.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)`);
  for (const p of list) ins.run(itemId, p.location != null ? p.location : null, Math.max(1, Math.round(p.quantity || 1)));
  recomputeItemStock(db, itemId);
}
// Add stock to a specific location (used by the bulk-scan merge): bump the matching placement or
// add a new one, then re-mirror. Treats null/'' as the single "unassigned" bucket.
function addStock(db, itemId, location, addQty) {
  const loc = (location != null && String(location).trim()) ? String(location).trim() : null;
  const qty = Math.max(1, Math.round(+addQty || 1));
  const hit = db.prepare(`SELECT id FROM sealed_placements WHERE item_id = ? AND lower(IFNULL(location,'')) = lower(IFNULL(?,'')) LIMIT 1`).get(itemId, loc);
  if (hit) db.prepare(`UPDATE sealed_placements SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?`).run(qty, hit.id);
  else db.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)`).run(itemId, loc, qty);
  recomputeItemStock(db, itemId);
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
// Per-UPC value series — the shared sparkline for every item of that barcode.
function getUpcValSeries(db, upc, days = 365) {
  return db.prepare(
    `SELECT ROUND(julianday('now') - julianday(ts), 3) AS daysAgo, value_cents AS c
     FROM sealed_upc_valuations
     WHERE upc = ? AND value_cents IS NOT NULL AND ts >= datetime('now', ?)
     ORDER BY ts ASC`).all(upc, `-${days} days`).map((r) => ({ daysAgo: r.daysAgo, price: r.c / 100 }));
}
function itemWithPl(db, row) {
  // Market VALUE is per-UPC — the same unit value for every item of a barcode, whatever each cost.
  // Derive it from sealed_upc_prices; a per-item manual override (value_manual) wins for that item.
  let value_cents = row.value_cents, value_currency = row.value_currency, value_source = row.value_source, value_updated_at = row.value_updated_at;
  let vals;
  const code = normalizeUpc(row.upc);
  if (code && !row.value_manual) {
    const up = db.prepare(`SELECT value_cents, currency, source, updated_at FROM sealed_upc_prices WHERE upc = ?`).get(code);
    if (up && up.value_cents != null) { value_cents = up.value_cents; value_currency = up.currency; value_source = up.source; value_updated_at = up.updated_at; }
    vals = getUpcValSeries(db, code);
    if (!vals.length) vals = getValSeries(db, row.id);   // legacy per-item history before the first per-UPC refresh
  } else {
    vals = getValSeries(db, row.id);
  }
  return { ...row, value_cents, value_currency, value_source, value_updated_at, spark: vals, val_count: vals.length, placements: getPlacements(db, row.id) };
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

// Find + price the PriceCharting sealed product for a resolved barcode title. Search by name, pick the
// precise hit (pickSealedHit), then fetch its page for the live sealed price (the search table has none).
// Returns { url, pc_product_id, consoleName, prices } or null. Never throws (GR7).
async function resolveSealedByTitle({ title, productType }) {
  const name = String(title || '').trim();
  if (!name) return null;
  let hits = [];
  try { hits = await searchSealed(name); } catch { hits = []; }
  const hit = pickSealedHit(hits, { title: name, productType });
  if (!hit) return null;
  let prices = (hit.prices && Object.values(hit.prices).some((v) => v != null)) ? hit.prices : {};
  if (!Object.keys(prices).length && hit.url) {
    try { const prod = await sealedByUrl(hit.url); if (prod && prod.matched) prices = prod.prices || {}; } catch { /* GR7 */ }
  }
  return { url: hit.url || null, pc_product_id: hit.productId || null, consoleName: hit.consoleName || '', prices };
}

// Typo-tolerant search over the permanent barcode cache (sealed_barcodes) by NAME or UPC. Small table
// (one row per scanned/remembered UPC) → score every row in-process; cap the scan for safety. Returns
// ranked product objects (+ their upc/score). No network, no dep — instant + offline.
function searchCatalog(db, { q, limit = 12, threshold = 0.3 } = {}) {
  const query = String(q == null ? '' : q).trim();
  if (!query) return [];
  const rows = db.prepare(`SELECT * FROM sealed_barcodes ORDER BY hit_count DESC, updated_at DESC LIMIT 8000`).all();
  return rows
    .map((r) => ({ r, s: catalogScore(query, r) }))
    .filter((x) => x.s >= threshold)
    .sort((a, b) => b.s - a.s || (b.r.hit_count || 0) - (a.r.hit_count || 0))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map((x) => ({ ...barcodeToProduct(x.r), upc: x.r.upc, hit_count: x.r.hit_count, score: Math.round(x.s * 100) / 100 }));
}

// Merge the optional sealed_locations metadata records with the location strings actually IN USE on
// placements, for the Locations page: one card per location with item/unit counts + a photo thumbnail.
function buildLocationCards(db) {
  const records = db.prepare(`SELECT id, name, notes, sort_order FROM sealed_locations`).all();
  const usage = db.prepare(`SELECT location AS name, COUNT(DISTINCT item_id) AS item_count, COALESCE(SUM(quantity),0) AS unit_count
    FROM sealed_placements WHERE location IS NOT NULL AND TRIM(location) <> '' GROUP BY location COLLATE NOCASE`).all();
  const usageByName = new Map(usage.map((u) => [String(u.name).toLowerCase(), u]));
  const photoAgg = db.prepare(`SELECT location_id, COUNT(*) AS n,
      (SELECT thumb FROM sealed_location_photos p2 WHERE p2.location_id = p.location_id ORDER BY sort_order, id LIMIT 1) AS thumb
    FROM sealed_location_photos p GROUP BY location_id`).all();
  const photoById = new Map(photoAgg.map((pa) => [pa.location_id, pa]));
  const out = [], seen = new Set();
  for (const r of records) {
    seen.add(r.name.toLowerCase());
    const u = usageByName.get(r.name.toLowerCase()) || {};
    const ph = photoById.get(r.id) || {};
    out.push({ id: r.id, name: r.name, notes: r.notes || '', sort_order: r.sort_order || 0, has_record: true,
      item_count: u.item_count || 0, unit_count: u.unit_count || 0, photo_count: ph.n || 0, thumb: ph.thumb || null });
  }
  for (const u of usage) {
    if (seen.has(String(u.name).toLowerCase())) continue;
    out.push({ id: null, name: u.name, notes: '', sort_order: 0, has_record: false,
      item_count: u.item_count || 0, unit_count: u.unit_count || 0, photo_count: 0, thumb: null });
  }
  return out;
}

// ---- live VALUE resolution (eBay AU primary, PriceCharting fallback) -------
// Build an eBay AU query for a sealed item (its name usually already carries the set + product type).
function ebayQueryFor(item) {
  const seen = new Set();
  return [item.name || '', item.set_name || ''].join(' ').split(/\s+/)
    .filter((w) => { const k = w.toLowerCase(); if (!w || seen.has(k)) return false; seen.add(k); return true; })
    .join(' ').trim();
}

// Write a valuation to history + refresh the item's cached value/source. Heals a stale/wrong pc_url.
function applySealedValuation(db, id, val) {
  insertRow(db, 'sealed_valuations', {
    item_id: id, value_cents: val.value_cents, currency: val.currency, source: val.source,
    price_label: val.price_label || null, sample_size: val.sample_size != null ? val.sample_size : null,
    raw: JSON.stringify(val.raw != null ? val.raw : null),
  });
  const sets = ['value_cents = ?', 'value_currency = ?', 'value_source = ?', `value_updated_at = datetime('now')`, `updated_at = datetime('now')`];
  const args = [val.value_cents, val.currency, val.source];
  if (val.pc_url) { sets.push('pc_url = ?'); args.push(val.pc_url); }
  db.prepare(`UPDATE sealed_items SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
}

// Write a PER-UPC valuation: the shared market value for every item of that barcode (+ history). This
// is the primary path — value is resolved once per UPC, not once per item. pc_url healing still runs
// per representative item (in the refresh loop) so the PriceCharting fallback link stays fresh.
function applyUpcValuation(db, upc, val) {
  const code = String(upc == null ? '' : upc).replace(/\D+/g, '');
  if (!code) return;
  db.prepare(`INSERT INTO sealed_upc_prices (upc, value_cents, currency, source, sample_size, updated_at)
      VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(upc) DO UPDATE SET value_cents = excluded.value_cents, currency = excluded.currency,
      source = excluded.source, sample_size = excluded.sample_size, updated_at = datetime('now')`)
    .run(code, val.value_cents, val.currency, val.source, val.sample_size != null ? val.sample_size : null);
  insertRow(db, 'sealed_upc_valuations', {
    upc: code, value_cents: val.value_cents, currency: val.currency, source: val.source,
    sample_size: val.sample_size != null ? val.sample_size : null, raw: JSON.stringify(val.raw != null ? val.raw : null),
  });
}

// Resolve a sealed item's live value: eBay AU comps (the seller's market, AUD) PRIMARY, PriceCharting
// (USD) as the fallback when eBay is thin/unreliable. Re-resolves the PriceCharting product by the
// item's CURRENT name (never blindly trusts a possibly-stale stored pc_url — the bug behind a booster
// box reading a booster PACK's price). Returns a valuation object or null. Never throws (GR7).
async function resolveSealedValue(db, item, { env, base }) {
  let eb = null;
  try { eb = await sealedEbayValue({ base, query: ebayQueryFor(item), productType: item.product_type }); } catch { eb = null; }
  if (eb && eb.matched && eb.reliable) {
    return { value_cents: Math.round(eb.value * 100), currency: 'AUD', source: 'ebay',
      price_label: 'eBay AU ' + eb.mode + (eb.mode === 'sold' ? '' : ' cluster'), sample_size: eb.comparable, raw: eb };
  }
  const pcEnabled = String(env.PRICECHARTING_ENABLED || 'true').toLowerCase() !== 'false';
  const pcToken = (env.PRICECHARTING_TOKEN || '').trim();
  if (pcEnabled) {
    let prices = null, url = item.pc_url || null;
    try {
      const pc = await resolveSealedByTitle({ title: item.name, productType: item.product_type });   // re-resolve → fixes stale pc_url
      if (pc && pc.prices && Object.values(pc.prices).some((v) => v != null)) { prices = pc.prices; url = pc.url || url; }
      if (!prices && item.pc_url) { const prod = await sealedByUrl(item.pc_url); if (prod && prod.matched) { prices = prod.prices; url = item.pc_url; } }
      if (!prices && item.upc) { const r = await lookupByUpc({ upc: item.upc, token: pcToken, enabled: true }); if (r && r.matched) { prices = r.prices; url = r.url || url; } }
    } catch { /* GR7 */ }
    if (prices) {
      const v = valueForSealed(prices, item.condition);
      if (v) return { value_cents: v.cents, currency: 'USD', source: 'pricecharting', price_label: v.label, pc_url: url, raw: { prices, url } };
    }
  }
  if (eb && eb.matched) return { value_cents: Math.round(eb.value * 100), currency: 'AUD', source: 'ebay',
    price_label: 'eBay AU ' + eb.mode + ' · low confidence', sample_size: eb.comparable, low_confidence: 1, raw: eb };
  return null;
}

// ---- nightly value refresh (in-process scheduler; HMR-guarded singleton) ----
let _svTimer = null, _svRunning = false;
const _svState = { enabled: false, interval_hours: 24, last_run_at: null, next_run_at: null, last_result: null };
async function runSealedRefresh(db, env, base) {
  if (_svRunning) return _svState.last_result;
  _svRunning = true;
  _svState.last_run_at = new Date().toISOString();
  const stats = { checked: 0, updated: 0, ebay: 0, pricecharting: 0, skipped: 0, errors: 0 };
  try {
    // Value ONCE per distinct UPC (shared across all its items), plus each UPC-less item on its own.
    const held = `status IN ('in_stock','listed') AND value_manual = 0`;
    const upcs = db.prepare(`SELECT upc, MIN(id) AS rep FROM sealed_items
      WHERE ${held} AND upc IS NOT NULL AND TRIM(upc) <> '' GROUP BY upc`).all();
    for (const { upc, rep } of upcs) {
      stats.checked++;
      try {
        const item = db.prepare(`SELECT * FROM sealed_items WHERE id = ?`).get(rep);
        const val = await resolveSealedValue(db, item, { env, base });
        if (val) { applyUpcValuation(db, upc, val); if (val.pc_url) db.prepare(`UPDATE sealed_items SET pc_url = ? WHERE upc = ? AND (pc_url IS NULL OR pc_url <> ?)`).run(val.pc_url, upc, val.pc_url); stats.updated++; stats[val.source === 'ebay' ? 'ebay' : 'pricecharting']++; }
        else stats.skipped++;
      } catch { stats.errors++; }
      await sleep(1500);
    }
    const noUpc = db.prepare(`SELECT * FROM sealed_items WHERE ${held} AND (upc IS NULL OR TRIM(upc) = '')
      ORDER BY value_updated_at IS NULL DESC, value_updated_at ASC`).all();
    for (const item of noUpc) {
      stats.checked++;
      try {
        const val = await resolveSealedValue(db, item, { env, base });
        if (val) { applySealedValuation(db, item.id, val); stats.updated++; stats[val.source === 'ebay' ? 'ebay' : 'pricecharting']++; }
        else stats.skipped++;
      } catch { stats.errors++; }
      await sleep(1500);
    }
  } catch (e) { console.error('[sealed] value refresh:', e?.message || e); }
  _svState.last_result = stats;
  _svRunning = false;
  console.log(`[sealed] value refresh: ${stats.updated}/${stats.checked} updated (${stats.ebay} eBay · ${stats.pricecharting} PC · ${stats.skipped} no-source)`);
  return stats;
}
export function startSealedValueRefresh(db, env, base) {
  if (_svTimer) return;   // singleton (HMR-safe)
  _svState.enabled = String(env.SEALED_VALUE_REFRESH_ENABLED || 'true').toLowerCase() !== 'false';
  _svState.interval_hours = Math.max(1, +(env.SEALED_VALUE_REFRESH_HOURS || 24) || 24);
  if (!_svState.enabled) { console.log('[sealed] nightly value refresh disabled (SEALED_VALUE_REFRESH_ENABLED=false)'); return; }
  const intervalMs = _svState.interval_hours * 3600_000;
  const boot = setTimeout(() => runSealedRefresh(db, env, base).catch(() => {}), 120_000);   // 2 min after boot
  _svTimer = setInterval(() => { _svState.next_run_at = new Date(Date.now() + intervalMs).toISOString(); runSealedRefresh(db, env, base).catch(() => {}); }, intervalMs);
  if (_svTimer.unref) _svTimer.unref();
  if (boot.unref) boot.unref();
  _svState.next_run_at = new Date(Date.now() + intervalMs).toISOString();
  console.log(`[sealed] nightly value refresh every ${_svState.interval_hours}h · eBay AU primary → PriceCharting fallback`);
}
export function getSealedRefreshState() { return { ..._svState, running: _svRunning }; }

// The resolve pipeline: local cache -> PriceCharting UPC (token/rare scrape redirect) -> UPCItemDB
// keyless barcode->name bridge (+ PriceCharting name-search price) -> miss. Never throws (GR7).
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
  // 4) keyless barcode DB (UPCItemDB) — the fix for the many scans PriceCharting's public search can't
  //    resolve by UPC. Maps the barcode to a product NAME + image, infers game + product_type, and
  //    best-effort attaches a live PriceCharting price via a precise NAME match (GR4: a wrong price is
  //    worse than none). Even without a price this turns a blank scan into a pre-filled product.
  const udbEnabled = String(env.UPCITEMDB_ENABLED || 'true').toLowerCase() !== 'false';
  if (udbEnabled) {
    let u = null;
    try { u = await lookupUpcName({ upc: code, key: (env.UPCITEMDB_KEY || '').trim(), keyType: env.UPCITEMDB_KEY_TYPE }); } catch { u = null; }
    if (u && u.matched) {
      const game = gameFromConsole(u.title);                       // "Pokemon Trading Card Game ..." -> pokemon
      const product_type = inferProductType(u.title, game);
      const pcEnabled = String(env.PRICECHARTING_ENABLED || 'true').toLowerCase() !== 'false';
      let pc = null;
      if (pcEnabled) { try { pc = await resolveSealedByTitle({ title: u.name, productType: product_type }); } catch { pc = null; } }
      const prices = (pc && pc.prices) || {};
      const priced = prices.sealed != null;
      const product = {
        game: game || null, name: u.name, set_name: (pc && pc.consoleName) || '',
        product_type, upc: code,
        pc_product_id: (pc && pc.pc_product_id) || null, pc_url: (pc && pc.url) || null,
        image_url: u.image || null,
        suggested_cents: priced ? prices.sealed : null, suggested_currency: 'USD', prices,
      };
      // A confident PriceCharting product match is 'medium' even if its price rung is momentarily blank
      // (we still stored the exact pc_url for a later refresh); a name-only resolve (no PC hit) is 'low'.
      const conf = pc ? 'medium' : 'low';
      const source = 'upcitemdb' + (pc ? '+pricecharting' : '');
      upsertBarcode(db, { code, product, source, confidence: conf, confirmed: 0, raw: { upcitemdb: u, pc } });
      return { matched: true, source, confidence: conf, product, cached: false };
    }
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

      // GET /summary — portfolio P&L (money in cents; FX left to the client). VALUE is the per-UNIT
      // market value (per-UPC, shared) × quantity; COST is the per-row total paid; `units` = SUM(qty).
      if (p === '/summary' && method === 'GET') {
        const rows = db.prepare(`SELECT status, game, product_type, cost_cents, acq_fees_cents,
          sale_price_cents, sale_fees_cents, quantity, value_manual, upc, value_cents AS row_value, value_currency AS row_cur FROM sealed_items`).all();
        // per-UPC prices keyed by NORMALIZED upc (same as itemWithPl's lookup, so totals stay consistent).
        const upcMap = new Map(db.prepare(`SELECT upc, value_cents, currency FROM sealed_upc_prices WHERE value_cents IS NOT NULL`).all().map((r) => [r.upc, r]));
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
            const qty = r.quantity || 0;
            units += qty;
            totalCostCents += cents(r.cost_cents) + cents(r.acq_fees_cents);
            const up = (!r.value_manual && r.upc) ? upcMap.get(normalizeUpc(r.upc)) : null;   // shared per-UPC value unless a manual override
            const uv = up ? up.value_cents : r.row_value, cur = up ? (up.currency || 'AUD') : (r.row_cur || 'USD');
            if (uv != null) valueByCurrency[cur] = (valueByCurrency[cur] || 0) + cents(uv) * qty;   // unit value × qty
          }
        }
        return send(res, 200, { counts, totalCostCents, realizedPlCents, valueByCurrency, byGame, byType, units });
      }

      // GET /locations — distinct non-empty locations across every placement (+ legacy item spots),
      // NATURAL-SORTED (Storage Crate 1,2,3…10,11 — not 1,10,11,2). Drives the add/edit combobox +
      // the location filter so a spot set once is easy to reselect.
      if (p === '/locations' && method === 'GET') {
        const rows = db.prepare(`SELECT DISTINCT location FROM (
            SELECT location FROM sealed_placements WHERE location IS NOT NULL AND TRIM(location) <> ''
            UNION ALL
            SELECT location FROM sealed_items WHERE location IS NOT NULL AND TRIM(location) <> ''
          )`).all();
        return send(res, 200, { locations: rows.map((r) => r.location).sort(naturalCompare) });
      }

      // GET /locations/cards — the Locations page: every location (metadata records + in-use spots),
      // with item/unit counts + a photo thumbnail. Sorting is left to the client.
      if (p === '/locations/cards' && method === 'GET') {
        return send(res, 200, { locations: buildLocationCards(db) });
      }

      // POST /locations — create (or update, by name) a location metadata record.
      if (p === '/locations' && method === 'POST') {
        const b = await readJson(req);
        const name = String(b.name == null ? '' : b.name).trim();
        if (!name) return send(res, 400, { error: 'name required' });
        const existing = db.prepare(`SELECT id FROM sealed_locations WHERE name = ? COLLATE NOCASE`).get(name);
        if (existing) {
          db.prepare(`UPDATE sealed_locations SET notes = ?, sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`)
            .run(b.notes !== undefined ? (b.notes || null) : null, b.sort_order != null ? Math.round(+b.sort_order) : null, existing.id);
          return send(res, 200, { id: existing.id, updated: true });
        }
        const id = insertRow(db, 'sealed_locations', { name, notes: b.notes || null, sort_order: b.sort_order != null ? Math.round(+b.sort_order) : 0 });
        return send(res, 201, { id, created: true });
      }

      // GET /locations/:id/photos — full-size photos for a location's gallery.
      if ((m = p.match(/^\/locations\/(\d+)\/photos$/)) && method === 'GET') {
        const rows = db.prepare(`SELECT id, caption, mime, data, sort_order, created_at FROM sealed_location_photos WHERE location_id = ? ORDER BY sort_order, id`).all(+m[1]);
        return send(res, 200, { photos: rows });
      }

      // POST /locations/:id/photos — upload one owner-taken photo (downscaled data URL + thumb).
      if ((m = p.match(/^\/locations\/(\d+)\/photos$/)) && method === 'POST') {
        const id = +m[1];
        if (!db.prepare(`SELECT 1 FROM sealed_locations WHERE id = ?`).get(id)) return send(res, 404, { error: 'no such location' });
        const b = await readJsonBig(req);
        if (b.__oversize) return send(res, 413, { error: 'photo too large (downscale before upload)' });
        const data = String(b.data || '');
        if (!/^data:image\//.test(data)) return send(res, 400, { error: 'data must be an image data URL' });
        const nextOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM sealed_location_photos WHERE location_id = ?`).get(id).n;
        const pid = insertRow(db, 'sealed_location_photos', {
          location_id: id, caption: b.caption || null, mime: b.mime || 'image/jpeg',
          thumb: b.thumb || null, data, sort_order: b.sort_order != null ? Math.round(+b.sort_order) : nextOrder,
        });
        return send(res, 201, { id: pid, created: true });
      }

      // POST /locations/:id/photos/reorder — persist a new photo order ({order:[id,…]}) atomically.
      if ((m = p.match(/^\/locations\/(\d+)\/photos\/reorder$/)) && method === 'POST') {
        const id = +m[1];
        const b = await readJson(req);
        const order = Array.isArray(b.order) ? b.order.map((x) => +x).filter(Number.isFinite) : [];
        if (!order.length) return send(res, 400, { error: 'order[] required' });
        const owned = new Set(db.prepare(`SELECT id FROM sealed_location_photos WHERE location_id = ?`).all(id).map((r) => r.id));
        db.exec('BEGIN');
        try {
          const upd = db.prepare(`UPDATE sealed_location_photos SET sort_order = ? WHERE id = ? AND location_id = ?`);
          let i = 0;
          for (const pid of order) if (owned.has(pid)) upd.run(i++, pid, id);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); return send(res, 500, { error: 'reorder failed', detail: String((e && e.message) || e) }); }
        return send(res, 200, { reordered: true });
      }

      // PATCH /locations/photos/:id — edit a photo's caption / order.
      if ((m = p.match(/^\/locations\/photos\/(\d+)$/)) && method === 'PATCH') {
        const b = await readJson(req);
        const sets = [], args = [];
        if (b.caption !== undefined) { sets.push('caption = ?'); args.push(b.caption || null); }
        if (b.sort_order != null) { sets.push('sort_order = ?'); args.push(Math.round(+b.sort_order)); }
        if (!sets.length) return send(res, 400, { error: 'nothing to update' });
        db.prepare(`UPDATE sealed_location_photos SET ${sets.join(', ')} WHERE id = ?`).run(...args, +m[1]);
        return send(res, 200, { updated: true });
      }

      // DELETE /locations/photos/:id — remove one photo.
      if ((m = p.match(/^\/locations\/photos\/(\d+)$/)) && method === 'DELETE') {
        db.prepare(`DELETE FROM sealed_location_photos WHERE id = ?`).run(+m[1]);
        return send(res, 200, { removed: true });
      }

      // PATCH /locations/:id — edit a location record. A rename PROPAGATES to every placement/item using
      // the old name (one transaction) so stock stays attached to the renamed spot.
      if ((m = p.match(/^\/locations\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        const b = await readJson(req);
        const rec = db.prepare(`SELECT * FROM sealed_locations WHERE id = ?`).get(id);
        if (!rec) return send(res, 404, { error: 'no such location' });
        const newName = b.name != null ? String(b.name).trim() : null;
        if (newName === '') return send(res, 400, { error: 'name cannot be empty' });
        db.exec('BEGIN');
        try {
          if (newName && newName.toLowerCase() !== rec.name.toLowerCase()) {
            const clash = db.prepare(`SELECT id FROM sealed_locations WHERE name = ? COLLATE NOCASE AND id <> ?`).get(newName, id);
            if (clash) { db.exec('ROLLBACK'); return send(res, 409, { error: 'a location with that name already exists' }); }
            db.prepare(`UPDATE sealed_placements SET location = ?, updated_at = datetime('now') WHERE lower(location) = lower(?)`).run(newName, rec.name);
            db.prepare(`UPDATE sealed_items SET location = ?, updated_at = datetime('now') WHERE lower(location) = lower(?)`).run(newName, rec.name);
          }
          const sets = [], args = [];
          if (newName) { sets.push('name = ?'); args.push(newName); }
          if (b.notes !== undefined) { sets.push('notes = ?'); args.push(b.notes || null); }
          if (b.sort_order != null) { sets.push('sort_order = ?'); args.push(Math.round(+b.sort_order)); }
          if (sets.length) { sets.push(`updated_at = datetime('now')`); db.prepare(`UPDATE sealed_locations SET ${sets.join(', ')} WHERE id = ?`).run(...args, id); }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); return send(res, 500, { error: 'update failed', detail: String((e && e.message) || e) }); }
        return send(res, 200, { updated: true });
      }

      // DELETE /locations/:id — drop the metadata record (+ its photos). Placements keep their location
      // string; the spot just loses its notes/photos.
      if ((m = p.match(/^\/locations\/(\d+)$/)) && method === 'DELETE') {
        db.prepare(`DELETE FROM sealed_locations WHERE id = ?`).run(+m[1]);
        return send(res, 200, { removed: true });
      }

      // GET /product-types — the enum + per-game subsets (drives the UI dropdowns).
      if (p === '/product-types' && method === 'GET') {
        return send(res, 200, { types: PRODUCT_TYPES, by_game: TYPES_BY_GAME });
      }

      // GET /search?q=&limit= — typo-tolerant search over the permanent barcode cache, by NAME or UPC.
      // Instant + offline; lets a product resolved once be reused without another lookup.
      if (p === '/search' && method === 'GET') {
        const query = q.get('q') || '';
        const results = searchCatalog(db, { q: query, limit: +(q.get('limit') || 12) });
        return send(res, 200, { query, results });
      }

      // GET /export — full bundle (accounting / Claude). Each item carries its per-location placements.
      if (p === '/export' && method === 'GET') {
        const now = db.prepare(`SELECT datetime('now') AS now`).get().now;
        const items = db.prepare(`SELECT * FROM sealed_items ORDER BY created_at DESC`).all()
          .map((it) => ({ ...it, placements: getPlacements(db, it.id) }));
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

      // GET /items — filters: game, product_type, status, set, location, q (name / sku / upc)
      if (p === '/items' && method === 'GET') {
        const where = ['1 = 1'], args = [];
        if (q.get('game')) { where.push('game = ?'); args.push(q.get('game')); }
        if (q.get('product_type')) { where.push('product_type = ?'); args.push(q.get('product_type')); }
        if (q.get('status')) { where.push('status = ?'); args.push(q.get('status')); }
        if (q.get('set')) { where.push('set_name LIKE ?'); args.push('%' + q.get('set') + '%'); }
        // location matches ANY of the item's per-location placements (not just the primary mirror).
        if (q.get('location')) { where.push(`id IN (SELECT item_id FROM sealed_placements WHERE lower(IFNULL(location,'')) = lower(?))`); args.push(q.get('location')); }
        if (q.get('q')) { where.push('(name LIKE ? OR sku LIKE ? OR upc LIKE ?)'); const s = '%' + q.get('q') + '%'; args.push(s, s, s); }
        const rows = db.prepare(`SELECT * FROM sealed_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...args);
        return send(res, 200, { items: rows.map((r) => itemWithPl(db, r)) });
      }

      // POST /items — create (generates SKU; validates game + product_type).
      if (p === '/items' && method === 'POST') {
        const b = await readJson(req);
        if (!SEALED_GAMES.includes(b.game)) return send(res, 400, { error: 'game must be one of ' + SEALED_GAMES.join('/') });
        if (!b.name) return send(res, 400, { error: 'name is required' });
        // A non-empty but invalid / cross-game type must normalise to 'other' too — `x || 'other'`
        // only caught empty/nullish, letting garbage or another game's type pollute the facet.
        const pt = typesForGame(b.game).includes(b.product_type) ? b.product_type : 'other';
        const obj = pick({ ...b, product_type: pt }, SEALED_INSERT_COLS);
        obj.sku = nextSku(db, b.game);
        const id = insertRow(db, 'sealed_items', obj);
        // Multi-location stock: an explicit placements array wins; else mirror the scalar
        // quantity/location into a single placement so the "quantity == SUM(placements)" invariant
        // holds for every item (and re-mirrors quantity/location from the placements).
        const seed = Array.isArray(b.placements)
          ? sanitizePlacements(b.placements)
          : sanitizePlacements([{ location: obj.location != null ? obj.location : null, quantity: obj.quantity != null ? obj.quantity : 1 }]);
        setPlacements(db, id, seed);
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

      // GET /refresh-state — nightly value-refresh scheduler status (for the UI / settings).
      if (p === '/refresh-state' && method === 'GET') {
        return send(res, 200, getSealedRefreshState());
      }

      // POST /refresh-all — run the value refresh across all held items now (server-side, eBay-first).
      // Returns immediately with the run's stats when done (the client shows a spinner meanwhile).
      if (p === '/refresh-all' && method === 'POST') {
        const stats = await runSealedRefresh(db, env, base);
        return send(res, 200, { ran: true, stats });
      }

      // POST /items/:id/refresh-value — pull the live SEALED value: eBay AU comps (your market, AUD)
      // first, PriceCharting (USD) as the fallback. Re-resolves the PriceCharting product by the item's
      // current name (no longer trusts a stale pc_url), and records the source in the valuation history.
      if ((m = p.match(/^\/items\/(\d+)\/refresh-value$/)) && method === 'POST') {
        const id = +m[1];
        const force = q.get('force') === '1';
        const item = db.prepare(`SELECT * FROM sealed_items WHERE id = ?`).get(id);
        if (!item) return send(res, 404, { error: 'no such item' });
        if (item.value_manual && !force) return send(res, 200, { updated: false, reason: 'manual_override' });
        const val = await resolveSealedValue(db, item, { env, base });
        if (!val) return send(res, 200, { updated: false, reason: 'no_source' });
        // A barcoded item shares one value per UPC (updates every item of that UPC); a UPC-less item
        // is valued on its own row.
        if (item.upc && String(item.upc).trim()) {
          applyUpcValuation(db, item.upc, val);
          if (val.pc_url) db.prepare(`UPDATE sealed_items SET pc_url = ? WHERE upc = ?`).run(val.pc_url, String(item.upc).replace(/\D+/g, ''));
        } else {
          applySealedValuation(db, id, val);
        }
        return send(res, 200, { updated: true, value_cents: val.value_cents, currency: val.currency, source: val.source, price_label: val.price_label, low_confidence: val.low_confidence || 0 });
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

      // PATCH /items/:id — partial update (whitelisted columns). A `placements` array is authoritative
      // for stock: it replaces the item's placements and re-mirrors quantity/location. A bare scalar
      // quantity/location update (no placements) is mirrored into a single placement — but ONLY for a
      // single-location item; it refuses to silently collapse/relocate a multi-location split. All
      // stock changes are validated BEFORE any write so a rejected request never partially applies.
      if ((m = p.match(/^\/items\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        const b = await readJson(req);
        const hasPlacements = Array.isArray(b.placements);
        const scalarStock = !hasPlacements && ('quantity' in b || 'location' in b);
        const obj = pick(b, SEALED_PATCH_COLS);
        if (hasPlacements) { delete obj.quantity; delete obj.location; }   // placements own these
        const cols = Object.keys(obj);
        if (!cols.length && !hasPlacements) return send(res, 400, { error: 'nothing to update' });
        if (!db.prepare(`SELECT 1 FROM sealed_items WHERE id = ?`).get(id)) return send(res, 404, { error: 'no such item' });
        // Validate the stock change up front (no partial writes on rejection).
        let clean = null;
        if (hasPlacements) {
          clean = sanitizePlacements(b.placements);
          if (!clean.length) return send(res, 400, { error: 'placements need at least one row with quantity >= 1' });   // never wipe stock to a phantom unit
        } else if (scalarStock) {
          const nPl = db.prepare(`SELECT COUNT(*) AS n FROM sealed_placements WHERE item_id = ?`).get(id).n;
          if (nPl > 1) return send(res, 400, { error: 'this item has multiple locations — send a placements array to change its stock' });
        }
        if (cols.length) {
          const sets = cols.map((c) => c + ' = ?').concat([`updated_at = datetime('now')`]);
          db.prepare(`UPDATE sealed_items SET ${sets.join(', ')} WHERE id = ?`).run(...cols.map((c) => obj[c]), id);
        }
        if (hasPlacements) {
          setPlacements(db, id, clean);
        } else if (scalarStock) {
          const cur = db.prepare(`SELECT quantity, location FROM sealed_items WHERE id = ?`).get(id);
          setPlacements(db, id, [{ location: cur.location, quantity: cur.quantity }]);
        }
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
              if (!SEALED_GAMES.includes(game)) { stats.skipped++; stats.errors.push({ row: raw && raw.name, error: 'unsupported game ' + game }); continue; }
              if (!raw.name) { stats.skipped++; stats.errors.push({ row: '(no name)', error: 'name required' }); continue; }
              const productType = typesForGame(game).includes(raw.product_type) ? raw.product_type : 'other';   // invalid/cross-game → 'other' (not verbatim)
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
                addStock(db, existing.id, raw.location || null, qty);                 // bumps the matching placement + re-mirrors quantity
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
              setPlacements(db, itemId, sanitizePlacements([{ location: obj.location != null ? obj.location : null, quantity: obj.quantity }]));
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
      startSealedValueRefresh(db, env, base);
      console.log('[sealed] DB ' + DB_PATH + ' · API /api/sealed · pc ' + ((env.PRICECHARTING_TOKEN || '').trim() ? 'api' : 'scrape'));
    },
  };
}
