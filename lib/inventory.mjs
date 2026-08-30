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
import { STOCK_GAMES, lookupPath, imageFrom } from './normalize.mjs';
import { lookup as pcLookup } from './pricecharting.mjs';
import { detectLanguage } from './psa.mjs';
import { cardNumberKey } from './listing-copy.mjs';
import { intlNumCandidates } from './pokemon-intl.mjs';
import { labelFor, seqForLabel, maxLabelSeq } from './sku-labels.mjs';
import { itemUrl } from './ebay-links.mjs';
import { configFile } from './config-paths.mjs';
import { blendUnitCents } from './purchasing-money.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GRADING_CONFIG_PATH = configFile('grading.config.json');

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

const GAMECODE = { riftbound: 'RB', mtg: 'MTG', pokemon: 'PKM', swu: 'SWU', lorcana: 'LOR', onepiece: 'OP' };

// --- stock identity: is this the same physical thing we already hold? --------------------------
// Three writers describe the same card differently — the uploader saves "Ungraded, Near Mint", bulk
// saves "Near Mint", eBay's own enum says "Near Mint or Better" — so a raw string compare finds
// nothing. Normalise to a token instead. Condition and finish are part of the identity on purpose:
// a Lightly Played copy is NOT the same stock item as a Near Mint one, and merging them would
// misprice both. Pure + exported for the unit suite.
export function conditionKey(s) {
  const t = String(s || '').toLowerCase();
  if (/heavily\s*played|\bhp\b|\bpoor\b/.test(t)) return 'HP';
  if (/moderately\s*played|\bmp\b|very\s*good/.test(t)) return 'MP';
  if (/lightly\s*played|\blp\b|excellent/.test(t)) return 'LP';
  if (/near\s*mint|\bnm\b|\bmint\b/.test(t)) return 'NM';
  return t.trim() ? 'OTHER' : '';                  // '' is UNKNOWN and never equals NM
}
// "Non-holo" contains "holo", so it is tested before the holo branch (same trap as ebayFinish).
export function variantKey(s) {
  const t = String(s || '').toLowerCase();
  if (/reverse/.test(t)) return 'REVERSE';
  if (/non[-\s]?holo|non[-\s]?foil|^base$|^normal$|^regular$/.test(t)) return 'BASE';
  if (/holo/.test(t)) return 'HOLO';
  if (/foil/.test(t)) return 'FOIL';
  return t.trim() ? t.trim().toUpperCase() : 'BASE';
}
// The full identity of a piece of stock. Two rows with the same key are the same physical thing and
// should be one row with a higher quantity; anything else is a separate listing.
export function stockKey(row) {
  const graded = !!(row.graded || row.grading_company);
  return [
    row.game || '', String(row.identity_key || row.name || '').toLowerCase(),
    variantKey(row.variant || row.finish), String(row.language || 'EN').toUpperCase(),
    graded ? 'G:' + String(row.grading_company || '').toUpperCase() + ':' + (row.grade != null ? String(+row.grade) : '')
           : 'R:' + conditionKey(row.condition),
  ].join('|');
}

// --- physical stock labels (AAA-001 …) -------------------------------------------------------
// The owner's shelf system, and what eBay shows as "Custom label". Scheme + the never-reuse rule
// live in lib/sku-labels.mjs. SINGLES ride this series because it IS the physical filing system;
// bulk lots and sealed keep their own BK-* namespaces, since a 50-card lot or a booster box is one
// object rather than a slot on the singles shelf.
const LABEL_NS = 'LABEL';

// Where the series currently stands. null seq = never seeded.
export function stockLabelState(db) {
  const row = db.prepare('SELECT seq FROM sku_counter WHERE namespace = ?').get(LABEL_NS);
  const seq = row ? row.seq : null;
  return { seeded: seq != null, seq, current: seq ? labelFor(seq) : null, next: seq != null ? labelFor(seq + 1) : null };
}

// Move the series forward to at least `seq`. NEVER backwards: a rewind would re-issue a label that
// is already on a shelf or bound to a live eBay listing. Returns the resulting state.
export function seedStockLabels(db, seq) {
  const want = Math.max(0, Math.floor(seq || 0));
  db.prepare(`INSERT INTO sku_counter (namespace, seq) VALUES (?, ?)
              ON CONFLICT(namespace) DO UPDATE SET seq = MAX(seq, excluded.seq)`).run(LABEL_NS, want);
  return stockLabelState(db);
}

// Allocate the next label, or null when the series has not been seeded yet. Returning null is the
// important half: an unseeded counter would start at AAA-001 and hand out labels that are already
// on the owner's shelves, so nextSku falls back to the old BK-* form until someone seeds it (GR7 —
// degrade visibly, never guess a number that could collide).
// A label counts as TAKEN if it is on a stock row OR on any listing EITHER CHANNEL knows about. The
// mirrors matter: most of this seller's labels live only on hand-made listings that were never stock,
// so a stock-only check happily re-issues one that is on a live listing.
//
// ⚠ THE SHOPIFY MIRROR IS NOT OPTIONAL HERE, and it is a sharper case than eBay's. The label is
// productSet's `custom.id` upsert key, so a label that reads free while a Shopify product already
// carries it does not merely get reused — the next card's productSet RESOLVES to that product and
// overwrites it in place: title, description, images, price, the lot. Shopify reports no error, because
// it looks exactly like an ordinary update. The window is any publish that failed after the product was
// created (an inventory or publish refusal), or that succeeded and then failed to commit its label:
// both leave the counter un-advanced and the stock row still on STG-*, which is how the label reads
// free. The mirror row is written before the label is committed, so it holds the claim from that
// moment on whether the publish went on to succeed or fail.
export function labelTaken(db, label) {
  if (db.prepare('SELECT 1 FROM inventory_items WHERE sku = ?').get(label)) return true;
  try { if (db.prepare('SELECT 1 FROM ebay_seller_listings WHERE sku = ?').get(label)) return true; }
  catch { /* table may predate this build (GR7) */ }
  try { return !!db.prepare('SELECT 1 FROM shopify_listings WHERE sku = ?').get(label); }
  catch { return false; }                     // table may predate this build (GR7)
}

export function nextStockLabel(db) {
  if (!db.prepare('SELECT 1 FROM sku_counter WHERE namespace = ?').get(LABEL_NS)) return null;
  for (let guard = 0; guard < 200; guard++) {
    db.prepare('UPDATE sku_counter SET seq = seq + 1 WHERE namespace = ?').run(LABEL_NS);
    const seq = db.prepare('SELECT seq FROM sku_counter WHERE namespace = ?').get(LABEL_NS).seq;
    const label = labelFor(seq);
    if (!label) return null;                                             // past ZZZ-099
    if (!labelTaken(db, label)) return label;
    // Taken (a hand-entered label, an eBay listing, or a seed set too low). Skip it — never reuse.
  }
  return null;
}

// --- deferred label allocation (batch staging) -------------------------------------------------
// The counter is monotonic and is NEVER rewound, so allocating at stage time means every row that
// then fails to list burns its number for good — 6 of 27 labels on 2026-07-29 (AAC-088/089/090/091/
// 093/096), each a card that previewed and was never published. So staging takes a PROVISIONAL sku
// and the shelf label is allocated at publish, committed only once eBay has confirmed the listing.
//
// peek/commit rather than allocate/rollback, because rollback would mean moving the counter
// backwards and that is the one thing sku-labels.mjs forbids: a rewind can hand out a number that is
// already on a shelf. Peeking touches nothing, so a failed publish leaves the series exactly where
// it was and the next attempt gets the same number.
const PROVISIONAL_NS = 'STG';
export const PROVISIONAL_RE = /^STG-\d{6}$/;
export const isProvisionalSku = (sku) => PROVISIONAL_RE.test(String(sku || '').trim().toUpperCase());

// A placeholder that is obviously not a shelf label, so nothing downstream mistakes it for one and
// an operator seeing it in a list knows the row has not been listed yet.
export function nextProvisionalSku(db) {
  db.prepare(`INSERT INTO sku_counter (namespace, seq) VALUES (?, 1)
              ON CONFLICT(namespace) DO UPDATE SET seq = seq + 1`).run(PROVISIONAL_NS);
  const seq = db.prepare('SELECT seq FROM sku_counter WHERE namespace = ?').get(PROVISIONAL_NS).seq;
  return 'STG-' + String(seq).padStart(6, '0');
}

// What nextStockLabel WOULD return, without advancing anything. Same skip-taken walk, read-only.
export function peekStockLabel(db) {
  const row = db.prepare('SELECT seq FROM sku_counter WHERE namespace = ?').get(LABEL_NS);
  if (!row) return null;                                                 // unseeded — caller falls back
  for (let seq = row.seq + 1, guard = 0; guard < 200; seq++, guard++) {
    const label = labelFor(seq);
    if (!label) return null;                                             // past ZZZ-099
    if (!labelTaken(db, label)) return { label, seq };
  }
  return null;
}

// The next `want` free labels, in the order they will be handed out — a peek for a whole BATCH.
//
// The batch runner needs this to show each row the number it is actually heading for. Guessing
// client-side (next, next+1, next+2 …) would be wrong the moment the series has a gap ahead of the
// counter, which is exactly what the skip-taken walk exists for: a label sitting on a hand-made eBay
// listing is passed over, and every number after it shifts. Read-only — nothing here allocates.
// `fromSeq` previews the run as if the counter stood there instead — what the batch runner shows
// when the operator names a starting label. READ-ONLY, like the rest of this function: nothing is
// seeded until the run is actually confirmed, so a start typed and then thought better of never
// moves a counter that cannot be moved back.
export function upcomingStockLabels(db, want, fromSeq) {
  const row = db.prepare('SELECT seq FROM sku_counter WHERE namespace = ?').get(LABEL_NS);
  const base = Number.isFinite(fromSeq) ? Math.max(0, Math.floor(fromSeq)) : (row ? row.seq : null);
  if (base == null) return [];                                           // unseeded — caller falls back
  const n = Math.max(1, Math.min(500, Math.floor(want) || 1));
  const out = [];
  // The guard is per LABEL, not per candidate: a run of taken numbers must not eat the allowance for
  // the ones after it, so it scales with how many we were asked for.
  for (let seq = base + 1, guard = 0; out.length < n && guard < n + 200; seq++, guard++) {
    const label = labelFor(seq);
    if (!label) break;                                                   // past ZZZ-099
    if (!labelTaken(db, label)) out.push(label);
  }
  return out;
}

// Bind a peeked label to a row now that eBay has accepted it, and move the series past it. Ordered
// so the UNIQUE constraint on inventory_items.sku is the thing that catches a double-allocation: if
// two publishes somehow peeked the same number, the second UPDATE throws instead of duplicating.
export function commitStockLabel(db, itemId, label, seq) {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE inventory_items SET sku = ?, updated_at = datetime(\'now\') WHERE id = ?').run(label, +itemId);
    seedStockLabels(db, seq);                                            // MAX-based: forward only
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return label;
}

// Atomic per-namespace SKU sequence (single-writer model => no race). BK-PKM-000042.
function nextSku(db, game) {
  const label = nextStockLabel(db);
  if (label) return label;
  const ns = GAMECODE[game] || 'GEN';
  db.prepare(`INSERT INTO sku_counter (namespace, seq) VALUES (?, 1)
              ON CONFLICT(namespace) DO UPDATE SET seq = seq + 1`).run(ns);
  const seq = db.prepare(`SELECT seq FROM sku_counter WHERE namespace = ?`).get(ns).seq;
  return 'BK-' + ns + '-' + String(seq).padStart(6, '0');
}
// Bulk raw singles get their own namespace (BK-RAW-PKM-000042) so they never collide
// with graded slab SKUs. Same counter table + atomic idiom as nextSku.
function nextBulkSku(db, game) {
  const ns = 'RAW-' + (GAMECODE[game] || 'GEN');
  db.prepare(`INSERT INTO sku_counter (namespace, seq) VALUES (?, 1)
              ON CONFLICT(namespace) DO UPDATE SET seq = seq + 1`).run(ns);
  const seq = db.prepare(`SELECT seq FROM sku_counter WHERE namespace = ?`).get(ns).seq;
  return 'BK-' + ns + '-' + String(seq).padStart(6, '0');
}

// Pure portfolio roll-up over inventory_items rows (drives GET /summary). Exported for the unit
// harness. Money here is PER UNIT — value_cents is a single card's market price, cost/fees are per
// card — and `quantity` is the multiplier for raw bulk lots (a lot of 50 commons at 99c is ONE row
// with quantity=50). So every money term scales by qty: a qty=50 lot contributes 50× its per-unit
// figures. lib/sealed.mjs now matches this (its cost was summed unscaled until 2026-07-26, which
// invented profit on every multi-unit row). Graded slabs + manual adds are quantity 1 (DEFAULT 1, never
// null), so the scaling is a no-op for them. `units` = SUM(quantity) of held (non-sold) stock.
export function summarizeInventory(rows) {
  const cents = (n) => (n == null ? 0 : +n);
  const counts = { total: rows.length, in_stock: 0, listed: 0, sold: 0 };
  const byGame = {}, byCompany = {}, valueByCurrency = {};
  let totalCostCents = 0, realizedPlCents = 0, units = 0;
  for (const r of rows) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    byGame[r.game] = (byGame[r.game] || 0) + 1;
    if (r.grading_company) byCompany[r.grading_company] = (byCompany[r.grading_company] || 0) + 1;
    const qty = r.quantity || 1;
    if (r.status === 'sold') {
      realizedPlCents += (cents(r.sale_price_cents) - cents(r.sale_fees_cents) - cents(r.cost_cents) - cents(r.acq_fees_cents)) * qty;
    } else {
      units += qty;
      totalCostCents += (cents(r.cost_cents) + cents(r.acq_fees_cents)) * qty;
      if (r.value_cents != null) {
        const cur = r.value_currency || 'USD';
        valueByCurrency[cur] = (valueByCurrency[cur] || 0) + cents(r.value_cents) * qty;
      }
    }
  }
  return { counts, units, totalCostCents, realizedPlCents, valueByCurrency, byGame, byCompany };
}

// Refresh a batch's denormalised roll-up counts from its items.
function recountBatch(db, batchId) {
  db.prepare(`UPDATE bulk_batches SET
      item_count   = (SELECT COUNT(*) FROM inventory_items WHERE batch_id = ?),
      unit_count   = COALESCE((SELECT SUM(quantity) FROM inventory_items WHERE batch_id = ?), 0),
      listed_count = (SELECT COUNT(*) FROM inventory_items WHERE batch_id = ? AND status = 'listed'),
      sold_count   = (SELECT COUNT(*) FROM inventory_items WHERE batch_id = ? AND status = 'sold'),
      updated_at   = datetime('now')
    WHERE id = ?`).run(batchId, batchId, batchId, batchId, batchId);
}

// Map a PriceCharting ladder {label->cents} to the item's grading_company + grade.
// Tries "<COMPANY> <grade>" (PSA 10), then generic "Grade <grade>" (Grade 9), then
// cross-company 10/9.5 rungs, finally the raw (Ungraded) anchor. Returns {cents,label}|null.
// Exported: the Collectr import enrichment (lib/collectr-resolve.mjs) prices graded
// rows through this exact rung-mapping (Golden Rule 9 — one mapper, not a mirror).
export function valueFromLadder(ladder, company, grade) {
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

// INTEGER-boolean columns: node:sqlite throws if a JS boolean is bound, so a caller sending the
// JSON-natural {"image_manual": true} would 500. Coerce to 0/1 (mirrors lib/sealed.mjs pick()).
const INT_BOOL_COLS = new Set(['value_manual', 'image_manual']);
// JSON-array columns: node:sqlite throws when a JS array is bound, so a caller sending the
// JSON-natural {"store_categories": ["/A","/B"]} would 500. Encoded here, same as subgrades below.
const JSON_ARRAY_COLS = new Set(['store_categories']);
function pick(body, cols) {
  const out = {};
  for (const c of cols) if (body[c] !== undefined) out[c] = body[c];
  for (const c of INT_BOOL_COLS) if (typeof out[c] === 'boolean') out[c] = out[c] ? 1 : 0;   // JSON bools -> 0/1
  for (const c of JSON_ARRAY_COLS) if (Array.isArray(out[c])) out[c] = JSON.stringify(out[c]);
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

// The stock row as the match endpoints hand it back. Shared by GET /match and POST /match/batch so
// the two can never disagree about what a match looks like.
function slim(r) {
  return {
    id: r.id, sku: r.sku, quantity: r.quantity, status: r.status, channel_status: r.channel_status,
    location: r.location, variant: r.variant, condition: r.condition, language: r.language,
    graded: !!(r.graded || r.grading_company), grading_company: r.grading_company, grade: r.grade,
    target_price_cents: r.target_price_cents, value_cents: r.value_cents,
    ebay_listing_id: r.ebay_listing_id, ebay_offer_id: r.ebay_offer_id,
    // offer_id present = WE published it, so we can revise it through the Inventory API. A
    // listing id with no offer id was made by hand in Seller Hub and the Inventory API cannot
    // see it at all, let alone revise it — the UI has to say so rather than silently fail.
    ours: !!r.ebay_offer_id,
    listingUrl: itemUrl(r.ebay_listing_id),
  };
}

const ITEM_INSERT_COLS = [
  'game', 'identity_key', 'name', 'set_name', 'number', 'variant', 'language',
  'grading_company', 'grade', 'grade_label', 'subgrades', 'cert_number', 'graded_date',
  'quantity', 'location', 'status', 'cost_cents', 'acq_fees_cents', 'acquired_at', 'source_vendor',
  'sale_price_cents', 'sale_fees_cents', 'sold_at', 'target_price_cents', 'notes',
  'value_cents', 'value_currency', 'value_source', 'value_manual', 'image_url', 'image_manual', 'watchlist_id', 'submission_id',
  'ebay_listing_id', 'shopify_product_id', 'channel_status',
  // bulk-listing columns (migrateBulk in lib/db.mjs)
  'batch_id', 'rarity', 'edition', 'condition', 'ebay_offer_id', 'title_override', 'desc_override', 'card_facts',
  'store_categories',
];
const ITEM_PATCH_COLS = ITEM_INSERT_COLS;
const BATCH_COLS = [
  'game', 'source', 'set_code', 'set_name', 'listing_shape', 'language',
  'pricing_config', 'fx_usd_aud', 'status', 'export_shape', 'exported_at', 'notes',
];
const SUB_COLS = [
  'game', 'identity_key', 'name', 'set_name', 'number', 'variant', 'language',
  'grading_company', 'tier', 'declared_value_cents', 'grading_cost_cents',
  'submitted_at', 'expected_return_at', 'status', 'tracking',
  'result_grade', 'result_grade_label', 'result_subgrades', 'cert_number', 'notes', 'pregrade_id',
];


/**
 * THE ONLY SUPPORTED WAY TO PUT RECEIVED SINGLES/SLABS INTO THE TOOL — the inventory_items twin of
 * receiveSealed. lib/purchasing.mjs calls it when a purchase order is received.
 *
 * Unlike sealed stock there is NO placements table here: inventory_items carries a scalar location,
 * so one received line lands in exactly ONE spot. Splitting a delivery across spots is a sealed-only
 * capability and lib/purchasing.mjs blocks it on a line targeting this table rather than silently
 * dropping the extra spots.
 *
 * Money is per UNIT and must already be in AUD CENTS — inventory_items.cost_cents has no currency
 * sibling and inventory.html converts in the browser before it POSTs, so every existing reader
 * assumes AUD. This function converts nothing (GR3); the caller does the one transaction-date
 * conversion and keeps the native figures. cost_cents + acq_fees_cents is the landed cost
 * summarizeInventory already reads.
 *
 * The caller supplies the transaction. Deliberately does NOT resolve a card image — that is a network
 * call, and it must never happen inside the receive transaction (POST /items runs it after COMMIT for
 * the same reason).
 */
export function receiveInventory(db, opts = {}) {
  const { itemId = null, item = {}, quantity = 1, location = null, bulk = false,
    costCents = null, acqFeesCents = null, acquiredAt = null, sourceVendor = null, poLineId = null } = opts;
  const addQty = Math.max(1, Math.round(+quantity || 1));
  const loc = (location != null && String(location).trim()) ? String(location).trim() : null;

  if (itemId != null) {
    const cur = db.prepare(`SELECT id, sku, quantity, location, cost_cents, acq_fees_cents FROM inventory_items WHERE id = ?`).get(itemId);
    if (!cur) throw new Error('receiveInventory: no inventory_items row ' + itemId);
    const oldQty = cur.quantity || 0;
    // COALESCE on location: a restock names where THESE units went, but it must not silently move
    // the stock already on the shelf. An item with no spot yet adopts the one just given.
    db.prepare(`UPDATE inventory_items SET quantity = quantity + ?, location = COALESCE(location, ?),
        cost_cents = ?, acq_fees_cents = ?,
        acquired_at = COALESCE(acquired_at, ?), source_vendor = COALESCE(source_vendor, ?),
        updated_at = datetime('now') WHERE id = ?`)
      .run(
        addQty, loc,
        blendUnitCents(cur.cost_cents, oldQty, costCents, addQty),
        blendUnitCents(cur.acq_fees_cents, oldQty, acqFeesCents, addQty),
        acquiredAt, sourceVendor, itemId,
      );
    return { id: itemId, sku: cur.sku, created: false, quantity: oldQty + addQty };
  }

  if (!STOCK_GAMES.includes(item.game) || !item.name) {
    throw new Error('receiveInventory: game (one of ' + STOCK_GAMES.join('/') + ') and name are required');
  }
  // Null descriptor fields are dropped before pick so the column defaults apply — language is
  // NOT NULL DEFAULT 'EN', and an explicit NULL is a constraint failure rather than "use the
  // default". Money is set after, because a null cost genuinely means "unknown".
  const clean = {};
  for (const [k, v] of Object.entries(item)) if (v != null) clean[k] = v;
  const obj = pick({ ...clean, quantity: addQty, location: loc }, ITEM_INSERT_COLS);
  obj.cost_cents = costCents;
  obj.acq_fees_cents = acqFeesCents;
  obj.acquired_at = acquiredAt;
  obj.source_vendor = sourceVendor;
  // `bulk` picks the BK-RAW-* namespace instead of the AAA-001 shelf series. AGENTS.md §16b: a lot
  // is ONE object, not a slot on the singles shelf, and the shelf counter is monotonic and never
  // rewound — spending labels on an unsorted lot would retire numbers for cards that do not exist yet.
  obj.sku = bulk ? nextBulkSku(db, item.game) : nextSku(db, item.game);
  // Outside pick() on purpose: po_line_id is not in ITEM_INSERT_COLS and must not be, or an API
  // caller could claim a stock row came from a purchase it did not.
  if (poLineId != null) obj.po_line_id = poLineId;
  const id = insertRow(db, 'inventory_items', obj);
  return { id, sku: obj.sku, created: true, quantity: addQty };
}

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

// Normalise a slab label to the card's real name for API search. Strips a leading grading/finish
// prefix ("FA/Sylveon VMAX" -> "Sylveon VMAX") and a trailing finish suffix PSA bakes into the
// subject ("DARK CHARIZARD-HOLO" -> "DARK CHARIZARD"). Only whitelisted finish tokens are removed,
// so hyphenated NAMES survive ("Porygon-Z", "Ho-Oh", "Nidoran-M" are untouched). Exported for tests.
export function cleanCardName(name) {
  return String(name || '')
    .replace(/^\s*(FA|SIR|SAR|AR|UR|HR|RR|SR|CHR|full\s*art)\s*[\/:\-]\s*/i, '')
    .replace(/[\s\-–]+(reverse\s+holo(?:foil)?|rev\.?\s*holo|reverse\s+foil|cosmos\s+holo|non[-\s]?holo|holofoil|holo|foil)\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}
// PSA set/brand names -> pokemontcg.io set ids (data/psa-set-map.json, baked by
// scripts/build-psa-set-map.mjs). Lets pickPkmCard prefer the RIGHT printing when a name+number
// search spans several sets ("POKEMON ROCKET" -> Team Rocket base5, not Base Set).
let _psaMap = null, _psaMapMtime = 0;
function psaSetMap() {
  const P = path.join(ROOT, 'data', 'psa-set-map.json');
  try {
    const st = fs.statSync(P);
    if (!_psaMap || st.mtimeMs !== _psaMapMtime) { _psaMap = JSON.parse(fs.readFileSync(P, 'utf8')); _psaMapMtime = st.mtimeMs; }
    return _psaMap;
  } catch { return { byName: {}, aliases: {} }; }
}
// Resolve a PSA set/brand name to a pokemontcg.io set id: alias, then exact name, then the
// longest ptcg set name contained in the brand (>=5 chars, so short generics don't false-match).
export function psaSetToPtcgId(setName, map = psaSetMap()) {
  const norm = String(setName || '').toUpperCase().replace(/^POKEMON\s+/, '').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  if (map.aliases && map.aliases[norm]) return map.aliases[norm];
  if (map.byName && map.byName[norm]) return map.byName[norm];
  let best = null, bestLen = 0;
  for (const nm in (map.byName || {})) {
    if (nm.length >= 5 && nm.length > bestLen && norm.includes(nm)) { best = map.byName[nm]; bestLen = nm.length; }
  }
  return best;
}
function pickPkmCard(arr, item) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const num = String(item.number || '').split('/')[0].replace(/^0+/, '');
  if (num) {
    const byNum = arr.filter((c) => String(c.number || '').replace(/^0+/, '') === num);
    if (!byNum.length) return null;   // number given but nothing matches — don't guess a wrong card
    // 1) Prefer an exact set match via the PSA->ptcg id map ("POKEMON ROCKET" -> base5).
    const setId = psaSetToPtcgId(item.set_name);
    if (setId) { const byId = byNum.find((c) => c.set && c.set.id === setId); if (byId) return byId; }
    // 2) Else disambiguate by set-name substring (handles subsets the id map can't, e.g. Trainer Gallery).
    const set = String(item.set_name || '').toLowerCase().replace(/^pokemon\s+/, '').trim();
    if (set) {
      const bySet = byNum.find((c) => {
        const sn = String((c.set && c.set.name) || '').toLowerCase();
        return sn && (sn.includes(set) || set.includes(sn));
      });
      if (bySet) return bySet;
    }
    return byNum[0];
  }
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
// ---- Japanese / intl (TCGdex) image resolution -----------------------------
// The English pokemontcg.io DB has no JP/CN/KO cards, so searching it for one returns a
// confidently-WRONG match. Instead map the slab's set (PSA brand "POKEMON JAPANESE
// SV4M-FUTURE FLASH" -> code "SV4M") to a TCGdex set id via the baked catalog
// (data/pokemon-intl-sets.json — the same file the Pokémon builder uses) and fetch the
// native card + image from the keyless /api/tcgdex proxy. Best-effort; never throws.
// CN and TW are the codes the stock tools store, and they are DISTINCT products (GR5) — a
// Simplified and a Traditional print of one card are two different things, so each resolves to its
// own TCGdex lane. ZH stays for rows that predate them and for detectLanguage(), which sniffs a PSA
// brand string and cannot tell the two scripts apart; it keeps trying both.
const INTL_LANGS = { JP: ['ja'], KO: ['ko'], CN: ['zh-cn'], TW: ['zh-tw'], ZH: ['zh-tw', 'zh-cn'] };
let _intlSets = null, _intlSetsMtime = 0;
function intlSetCatalog() {
  const P = path.join(ROOT, 'data', 'pokemon-intl-sets.json');
  try {
    const st = fs.statSync(P);
    if (!_intlSets || st.mtimeMs !== _intlSetsMtime) { _intlSets = JSON.parse(fs.readFileSync(P, 'utf8')); _intlSetsMtime = st.mtimeMs; }
    return _intlSets;
  } catch { return {}; }
}
// Effective language: an explicit intl code (JP/KO/CN/TW/ZH) wins; else sniff the set name so a row
// mislabeled EN (older PSA lookups did that) still resolves to the right native card.
function effLang(item) {
  const code = String(item.language || '').toUpperCase();
  if (INTL_LANGS[code]) return code;
  if (item.game === 'pokemon' && item.set_name) { const d = detectLanguage(item.set_name); if (d !== 'EN') return d; }
  return code || 'EN';
}
// Printed set code out of a PSA-style brand: "POKEMON JAPANESE SV4M-FUTURE FLASH" -> "SV4M".
function intlSetCode(setName) {
  const s = String(setName || '').toUpperCase();
  const dash = s.indexOf('-');
  if (dash > 0) { const before = s.slice(0, dash).trim().split(/\s+/).pop(); if (before && /\d/.test(before)) return before; }
  const m = s.match(/\b([A-Z]{1,4}\d[A-Za-z0-9]*)\b/);
  return m ? m[1] : '';
}
// intlNumCandidates (TCGdex zero-pads to 3: SV4M-077) now lives in lib/pokemon-intl.mjs — the
// builder and both stock tools need the same ladder, and this was the second of what would have
// been three copies.
async function resolveIntlImage(base, item, lang) {
  const code = intlSetCode(item.set_name);
  if (!code) return null;
  const cat = intlSetCatalog();
  for (const dl of (INTL_LANGS[lang] || [])) {
    const set = (cat[dl] || []).find((s) =>
      String(s.code || '').toUpperCase() === code || String(s.tcgdexId || '').toUpperCase() === code);
    const setId = set && (set.tcgdexId || set.code);
    if (!setId) continue;
    for (const cand of intlNumCandidates(item.number)) {
      try {
        const r = await fetch(base + '/api/tcgdex/' + encodeURIComponent(dl) + '/cards/' + encodeURIComponent(setId + '-' + cand));
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.image) return j.image + '/high.png';   // TCGdex returns a base URL; append quality + ext
      } catch {}
    }
  }
  return null;
}

// Resolve a card image from its fields — direct by identity_key first, then search by name/number
// (JP/CN/KO route to TCGdex). No DB writes. Returns { url, identity_key?, language? }; the last two
// are anything the search LEARNED (a resolved key / proven language). Best-effort, never throws.
async function resolveImageUrl(base, item) {
  if (!item || !item.game) return { url: null };
  const lang = effLang(item);
  if (item.game === 'pokemon' && INTL_LANGS[lang]) {
    // JP/CN/KO slabs aren't in the English DB — resolve via TCGdex. NO English fallback on a
    // miss: leaving the image empty is far better than pinning a confidently-wrong card.
    const url = await resolveIntlImage(base, item, lang);
    return { url: url || null, language: url ? lang : null };   // a TCGdex match proves the language
  }
  let url = null, resolvedKey = null;
  if (item.identity_key) {
    const lp = lookupPath(item.game, item.identity_key);
    if (lp) { try { const r = await fetch(base + lp); if (r.ok) url = imageFrom(item.game, await r.json()); } catch {} }
  }
  if (!url && item.name) {
    const found = await searchCard(base, item.game, item);
    if (found) { url = found.url; resolvedKey = found.identity_key; }
  }
  return { url: url || null, identity_key: resolvedKey };
}

// Resolve + cache a card image for a stored row (persists url, and any learned identity/language).
async function resolveImage(db, base, item) {
  const { url, identity_key, language } = await resolveImageUrl(base, item);
  if (url) {
    const sets = { image_url: url };
    if (identity_key && !item.identity_key) sets.identity_key = identity_key;
    if (language && language !== String(item.language || '').toUpperCase()) sets.language = language;
    const cols = Object.keys(sets);
    db.prepare(`UPDATE inventory_items SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...cols.map((c) => sets[c]), item.id);
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
        return send(res, 200, summarizeInventory(rows));
      }

      // GET /locations — distinct non-empty item locations, most-used first (add-form combobox).
      if (p === '/locations' && method === 'GET') {
        const rows = db.prepare(`SELECT location, COUNT(*) AS n FROM inventory_items
          WHERE location IS NOT NULL AND TRIM(location) <> ''
          GROUP BY location ORDER BY n DESC, location ASC`).all();
        return send(res, 200, { locations: rows.map((r) => r.location) });
      }

      // GET /export — full bundle (accounting / Claude).
      if (p === '/export' && method === 'GET') {
        const now = db.prepare(`SELECT datetime('now') AS now`).get().now;
        const items = db.prepare(`SELECT * FROM inventory_items ORDER BY created_at DESC`).all();
        const submissions = db.prepare(`SELECT * FROM grading_submissions ORDER BY created_at DESC`).all();
        return send(res, 200, { generated_at: now, items, submissions });
      }

      // GET /resolve-image?game=&name=&number=&set_name=&language=&identity_key= -> { image_url }
      // Preview a card image for the add/edit modal BEFORE the row is saved (no DB write). Same
      // resolver the save path uses, so the preview == what gets stored. Best-effort, never 500s.
      if (p === '/resolve-image' && method === 'GET') {
        const item = {
          game: q.get('game'), name: q.get('name'), number: q.get('number'),
          set_name: q.get('set_name'), language: q.get('language'), identity_key: q.get('identity_key') || null,
        };
        if (!item.game || !item.name) return send(res, 200, { image_url: null });
        try { const { url } = await resolveImageUrl(base, item); return send(res, 200, { image_url: url || null }); }
        catch { return send(res, 200, { image_url: null }); }
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
        if (!STOCK_GAMES.includes(b.game) || !b.name) return send(res, 400, { error: 'game (one of ' + STOCK_GAMES.join('/') + ') and name are required' });
        const obj = pick(b, ITEM_INSERT_COLS);
        // Bump the SKU counter + link watchlist + insert the row (+ seed valuation) atomically. nextSku
        // durably commits an increment, so without a transaction a failed insert would permanently skip
        // that SKU number (gap). BEGIN/COMMIT rolls the counter back with the failed insert. No await
        // sits inside the txn (readJson already resolved), so nothing can interleave.
        // A caller may CHOOSE the label (the uploader shows it before listing, because eBay binds a
        // Custom label to a listing for life and there is no editing it afterwards). A chosen label
        // must be free, and the series is pushed past it so it can never be handed out again.
        const chosen = String(b.sku || '').trim().toUpperCase();
        if (chosen && labelTaken(db, chosen)) {
          return send(res, 409, { error: 'the custom label ' + chosen + ' is already used — by a stock row or an eBay listing', code: 'sku_taken' });
        }
        let id, sku;
        db.exec('BEGIN');
        try {
          if (b.link_watchlist && b.game && b.identity_key) {
            try { obj.watchlist_id = ensureWatchlist(db, b); } catch (e) { console.error('[inventory] link watchlist', e?.message || e); }
          }
          if (chosen) {
            sku = chosen;
            const seq = seqForLabel(chosen);
            if (seq) seedStockLabels(db, seq);      // never re-issue a slot the owner has filled by hand
          } else if (b.defer_label) {
            // Batch staging (stock-runner): the sticker goes on the sleeve AFTER the listing exists,
            // so a row that never lists must not hold a shelf number. runPublish swaps this for a
            // real label once eBay confirms. Opt-in, so the single uploader / manual adds / grader
            // promotions keep labelling immediately — those ARE being filed on the shelf right now.
            sku = nextProvisionalSku(db);
          } else {
            sku = nextSku(db, b.game);
          }
          obj.sku = sku;
          id = insertRow(db, 'inventory_items', obj);
          // Seed an initial valuation row if a value was supplied (e.g. value-at-grade from the grader).
          if (b.value_cents != null) {
            insertRow(db, 'inventory_valuations', {
              item_id: id, value_cents: +b.value_cents, currency: b.value_currency || 'USD',
              source: b.value_source || 'manual', grade_label: b.grade_label || null,
            });
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        // Auto-resolve a card image (by identity, else by name/number search) unless one was supplied.
        // Network + a later write — must run AFTER commit, never inside the txn.
        if (obj.image_url == null && b.name) resolveImage(db, base, { id, game: b.game, identity_key: b.identity_key || null, name: b.name, number: b.number, set_name: b.set_name, language: b.language }).catch(() => {});
        return send(res, 201, { id, sku, created: true });
      }

      // GET /match?identity_key=&variant=&condition=&language=&game=&graded=&grading_company=&grade=
      // "Do we already have this card?" for the uploader. Returns the EXACT stock match (same card,
      // finish, condition, language, grade) plus NEAR matches — same card held in another condition
      // or finish, which is legitimately separate stock but worth showing so the owner can see the
      // whole shelf at a glance. Read-only.
      if (p === '/match' && method === 'GET') {
        const want = {
          game: q.get('game') || 'pokemon', identity_key: q.get('identity_key') || '', name: q.get('name') || '',
          variant: q.get('variant') || q.get('finish') || '', condition: q.get('condition') || '',
          language: q.get('language') || 'EN', graded: q.get('graded') === '1' || q.get('graded') === 'true',
          grading_company: q.get('grading_company') || '', grade: q.get('grade') || null,
        };
        if (!want.identity_key && !want.name) return send(res, 400, { error: 'identity_key or name required' });
        const rows = want.identity_key
          ? db.prepare('SELECT * FROM inventory_items WHERE identity_key = ? ORDER BY id').all(want.identity_key)
          : db.prepare('SELECT * FROM inventory_items WHERE game = ? AND lower(name) = lower(?) ORDER BY id').all(want.game, want.name);
        const key = stockKey(want);
        const exact = rows.filter((r) => stockKey(r) === key).map(slim);
        const near = rows.filter((r) => stockKey(r) !== key).map(slim);
        // Listings on eBay for this same card, INCLUDING hand-made ones that were never in stock.
        // eBay refuses a second listing for an item you already have up ([25002]), and a hand-made
        // listing is invisible to a stock-only check — which is exactly how that error got hit.
        let onEbay = [];
        try {
          onEbay = want.identity_key
            ? db.prepare(`SELECT listing_id, sku, title, state, price_cents, quantity, listing_url, created_via
                          FROM ebay_seller_listings WHERE identity_key = ? ORDER BY (state='active') DESC`).all(want.identity_key)
            : [];
        } catch { onEbay = []; }   // table/column may predate this build (GR7)
        return send(res, 200, { key, exact, near, held: rows.length, onEbay, activeOnEbay: onEbay.filter((l) => l.state === 'active').length });
      }

      // POST /match/batch { keys: [{ game, identity_key, name, variant, condition, language, … }] }
      // (also GET ?keys=<json> for small/debug use) — the SAME answer GET /match gives, for many
      // cards in two SQL statements instead of N round trips. A Runner batch of a hundred rows was
      // otherwise a hundred requests, three at a time.
      //
      // PERFORMANCE only: the semantics are unchanged. Keyed on the full stockKey (condition and
      // printing included), and a hit is a WARNING the caller shows beside a "+1 to that one"
      // offer — never a block. ebay_seller_listings.identity_key is a best-effort parse of a
      // listing TITLE, so trusting it as a gate would both over-block a legitimate Reverse Holo and
      // let a real duplicate through.
      //
      // POST is the real door: a hundred keys is several KB, which does not belong in a URL.
      if (p === '/match/batch' && (method === 'POST' || method === 'GET')) {
        let keys = [];
        if (method === 'POST') { const b = await readJson(req); keys = Array.isArray(b.keys) ? b.keys : []; }
        else { try { keys = JSON.parse(q.get('keys') || '[]'); } catch { keys = []; } }
        if (!Array.isArray(keys) || !keys.length) return send(res, 400, { error: 'keys (non-empty array) required' });
        if (keys.length > 1000) return send(res, 400, { error: 'too many keys (' + keys.length + '); the cap is 1000' });

        // This variant matches on identity_key only — the Runner always has one (the card id), and
        // a name fallback would need a third statement per distinct name, which is the round-trip
        // cost this endpoint exists to remove. A key without one comes back empty rather than wrong.
        const idents = [...new Set(keys.map((k) => k && k.identity_key).filter(Boolean))];
        const ph = idents.map(() => '?').join(',');
        const rows = idents.length ? db.prepare(`SELECT * FROM inventory_items WHERE identity_key IN (${ph})`).all(...idents) : [];
        let sellerRows = [];
        try {
          sellerRows = idents.length ? db.prepare(`SELECT listing_id, sku, title, state, price_cents, quantity, listing_url, created_via, identity_key
            FROM ebay_seller_listings WHERE identity_key IN (${ph}) ORDER BY (state='active') DESC`).all(...idents) : [];
        } catch { sellerRows = []; }   // table/column may predate this build (GR7)

        const byIdent = new Map(), sellerByIdent = new Map();
        for (const r of rows) { const k = r.identity_key; if (!byIdent.has(k)) byIdent.set(k, []); byIdent.get(k).push(r); }
        for (const r of sellerRows) { const k = r.identity_key; if (!sellerByIdent.has(k)) sellerByIdent.set(k, []); sellerByIdent.get(k).push(r); }

        const results = keys.map((want) => {
          const ik = want && want.identity_key;
          if (!ik) return { identity_key: null, key: null, exact: [], near: [], held: 0, onEbay: [], activeOnEbay: 0, reason: 'no identity_key' };
          const key = stockKey(want);
          const mine = byIdent.get(ik) || [];
          const onEbay = sellerByIdent.get(ik) || [];
          return {
            identity_key: ik, key,
            exact: mine.filter((r) => stockKey(r) === key).map(slim),
            near: mine.filter((r) => stockKey(r) !== key).map(slim),
            held: mine.length, onEbay,
            activeOnEbay: onEbay.filter((l) => l.state === 'active').length,
          };
        });
        return send(res, 200, { total: results.length, results });
      }

      // GET /labels — where the physical stock label series stands (AAA-001 …). Unseeded means new
      // items still get the old BK-* form, because AAA-001 is already on a shelf somewhere.
      if (p === '/labels' && method === 'GET') {
        const st = stockLabelState(db);
        const used = db.prepare(`SELECT sku FROM inventory_items WHERE sku LIKE '___-___'`).all().map((r) => r.sku);
        let onEbay = [];
        try { onEbay = db.prepare(`SELECT sku FROM ebay_seller_listings WHERE sku LIKE '___-___'`).all().map((r) => r.sku); } catch { onEbay = []; }
        // `next` skips anything already taken, on a stock row OR on an eBay listing — otherwise the
        // series happily hands out a label that is on a live hand-made listing. `?peek=N` returns the
        // whole run for a caller listing N rows at once: they each get their own number, and the batch
        // runner can show which one before it is spent.
        const peek = Math.max(1, Math.min(500, parseInt(q.get('peek') || '1', 10) || 1));
        // ?from=<label> previews the run as if it started THERE — the batch runner's "start labels
        // at" box. Purely a preview: nothing is seeded here, because the series can only move
        // forward and a number typed then reconsidered must not cost the operator a label.
        // `fromRefused` says the ask is BEHIND where the series already stands, which is the one
        // answer that matters: a silent fall-back to the real next label would have the operator
        // writing one number on the sleeve while eBay carries another.
        const fromRaw = (q.get('from') || '').trim();
        let fromSeq = null, fromInvalid = false;
        if (fromRaw) {
          const s = seqForLabel(fromRaw);
          if (s == null) fromInvalid = true; else fromSeq = s - 1;        // seq-1: make THAT label next
        }
        const fromRefused = fromSeq != null && st.seq != null && fromSeq < st.seq;
        const upcoming = upcomingStockLabels(db, peek, fromRefused || fromSeq == null ? undefined : fromSeq);
        return send(res, 200, { ...st, next: upcoming[0] || null, upcoming, inUse: used.length + onEbay.length,
          from: fromRaw || null, fromInvalid, fromRefused,
          highestInDb: labelFor(maxLabelSeq(used.concat(onEbay))) || null });
      }

      // POST /labels/seed { label } | { startAt } | { seq } — move the series to just past a known
      // label, e.g. the highest custom label already on eBay. Only ever moves FORWARD (never reuse a
      // retired number), and the reply says so via `rewindRefused` rather than failing quietly.
      //
      // `label` and `startAt` are the same move expressed from opposite ends, and the difference is
      // an off-by-one worth naming: `label` is the last one SPENT (seed past it), `startAt` is the
      // next one to ISSUE (seed to just before it). The batch runner asks in `startAt` because that
      // is the operator's intent — "this run begins at AAF-020" — and doing the −1 here keeps every
      // caller from having to know how the counter relates to the label it hands out.
      if (p === '/labels/seed' && method === 'POST') {
        const b = await readJson(req);
        let seq = null;
        if (b.startAt != null && String(b.startAt).trim() !== '') {
          const s = seqForLabel(b.startAt);
          if (s == null) return send(res, 400, { error: 'not a stock label — expected the AAA-001 form, 001 to 099' });
          seq = s - 1;
        } else if (b.label != null && String(b.label).trim() !== '') {
          seq = seqForLabel(b.label);
          if (seq == null) return send(res, 400, { error: 'not a stock label — expected the AAA-001 form, 001 to 099' });
        } else if (b.seq != null) {
          seq = Math.floor(+b.seq);
          if (!(seq >= 0)) return send(res, 400, { error: 'seq must be a positive number' });
        } else {
          return send(res, 400, { error: 'label or seq required' });
        }
        const before = stockLabelState(db);
        const after = seedStockLabels(db, seq);
        return send(res, 200, { ...after, movedFrom: before.current, rewindRefused: before.seq != null && seq < before.seq });
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
        // Guard existence like /refresh-value + /fetch-image: without it the FK on the valuation
        // insert throws → a generic 500 for a deleted/unknown id instead of a clean 404.
        if (!db.prepare(`SELECT 1 FROM inventory_items WHERE id = ?`).get(id)) return send(res, 404, { error: 'no such item' });
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
      // A pinned image (image_manual=1) is never auto-replaced unless ?force=1.
      if ((m = p.match(/^\/items\/(\d+)\/fetch-image$/)) && method === 'POST') {
        const id = +m[1];
        const item = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(id);
        if (!item) return send(res, 404, { error: 'no such item' });
        if (item.image_manual && q.get('force') !== '1') return send(res, 200, { updated: false, reason: 'pinned', locked: true, image_url: item.image_url });
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

      // ================= BULK BATCHES (Binders Keepers: Bulk) =================
      // A batch = one bulk run (set enumeration or Collectr import); its rows are
      // inventory_items with batch_id set. Save semantics (owner decision): the UI
      // targets an EXISTING batch or creates one; only user-included rows arrive
      // here; raw rows upsert by identity (uq_inv_bulk_identity), graded slabs
      // match within the batch by identity+grade; rows already listed/sold are
      // NEVER touched (sale history is safe on re-import).

      // GET /batches — list (filters: game, source, status)
      if (p === '/batches' && method === 'GET') {
        const where = ['1 = 1'], args = [];
        if (q.get('game')) { where.push('game = ?'); args.push(q.get('game')); }
        if (q.get('source')) { where.push('source = ?'); args.push(q.get('source')); }
        if (q.get('status')) { where.push('status = ?'); args.push(q.get('status')); }
        const rows = db.prepare(`SELECT * FROM bulk_batches WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`).all(...args);
        return send(res, 200, { batches: rows });
      }

      // POST /batches — create/extend a batch from priced rows.
      // body: { batch_id? (extend existing) | batch:{...BATCH_COLS}, rows:[row…], link_watchlist? }
      // row: { game, identity_key?, name, set_name?, number?, variant?, language?, rarity?,
      //        edition?, condition?, graded?, grading_company?, grade?, grade_label?, image?,
      //        quantity?, price_cents?, value_source?, market_cents?, cost_cents?, notes?,
      //        title_override?, desc_override? }
      if (p === '/batches' && method === 'POST') {
        const b = await readJson(req);
        const rows = Array.isArray(b.rows) ? b.rows : [];
        if (!b.batch_id && !(b.batch && (b.batch.set_name || b.batch.game))) {
          return send(res, 400, { error: 'batch_id or batch{game/set_name} required' });
        }
        let batchId = b.batch_id ? +b.batch_id : null;
        if (batchId && !db.prepare(`SELECT id FROM bulk_batches WHERE id = ?`).get(batchId)) {
          return send(res, 404, { error: 'no such batch', batch_id: batchId });
        }
        const stats = { inserted: 0, updated: 0, skipped: 0, errors: [] };
        db.exec('BEGIN');
        try {
          if (!batchId) {
            const hdr = pick(b.batch || {}, BATCH_COLS);
            if (hdr.pricing_config && typeof hdr.pricing_config === 'object') hdr.pricing_config = JSON.stringify(hdr.pricing_config);
            batchId = insertRow(db, 'bulk_batches', hdr);
          } else if (b.batch) {
            const hdr = pick(b.batch, BATCH_COLS);
            if (hdr.pricing_config && typeof hdr.pricing_config === 'object') hdr.pricing_config = JSON.stringify(hdr.pricing_config);
            const cols = Object.keys(hdr);
            if (cols.length) db.prepare(`UPDATE bulk_batches SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`)
              .run(...cols.map((c) => hdr[c]), batchId);
          }
          // A raw re-import can MOVE an existing row out of another batch into this one (the raw-identity
          // lookup is global, mirroring the non-batch-scoped uq_inv_bulk_identity index). Recount EVERY
          // batch we touch, not just this one, so a source batch's denormalised counts don't drift.
          const touchedBatches = new Set([Number(batchId)]);
          for (const raw of rows) {
            try {
              if (!STOCK_GAMES.includes(raw.game) && raw.game != null) { stats.skipped++; stats.errors.push({ row: raw.name, error: 'unsupported game ' + raw.game }); continue; }
              const graded = !!(raw.graded || raw.grading_company);
              const variant = (raw.variant && String(raw.variant).trim()) || 'Base';
              // Find an existing row to update (per the semantics above).
              // Where the match falls back to the card NUMBER, compare on its padding-insensitive
              // key (Golden Rule 10): the printed form changed from "106/86" to the card-exact
              // "106/086", and an exact-string match would re-insert every legacy row as a duplicate.
              const wantNumKey = cardNumberKey(raw.number || '');
              let existing = null;
              if (graded) {
                existing = db.prepare(`SELECT id, status, image_manual, identity_key, name, number FROM inventory_items
                  WHERE batch_id = ? AND game IS ? AND grading_company IS ? AND grade IS ?
                    AND (identity_key IS ? OR identity_key IS NULL)`)
                  .all(batchId, raw.game, raw.grading_company || null, raw.grade != null ? +raw.grade : null,
                       raw.identity_key || null)
                  .find((r) => (raw.identity_key && r.identity_key === raw.identity_key)
                    || (r.identity_key == null && r.name === (raw.name || '') && cardNumberKey(r.number || '') === wantNumKey)) || null;
              } else if (raw.identity_key) {
                existing = db.prepare(`SELECT id, status, image_manual, batch_id FROM inventory_items
                  WHERE game = ? AND identity_key = ? AND variant = ? AND batch_id IS NOT NULL AND grading_company IS NULL LIMIT 1`)
                  .get(raw.game, raw.identity_key, variant);
              } else {
                existing = db.prepare(`SELECT id, status, image_manual, number FROM inventory_items
                  WHERE batch_id = ? AND grading_company IS NULL AND identity_key IS NULL
                    AND name = ? AND variant = ?`)
                  .all(batchId, raw.name || '', variant)
                  .find((r) => cardNumberKey(r.number || '') === wantNumKey) || null;
              }
              if (existing && existing.status !== 'in_stock') { stats.skipped++; continue; }   // listed/sold: hands off

              // Absent optional fields are UNDEFINED (pick() drops them) so a re-save
              // from a source that lacks a field UPDATES around it instead of nulling
              // stored data (e.g. image_url captured on first save survives a re-price).
              const obj = pick({
                game: raw.game, identity_key: raw.identity_key || undefined, name: raw.name, set_name: raw.set_name,
                number: raw.number, variant, language: raw.language || 'EN', rarity: raw.rarity,
                edition: raw.edition != null ? raw.edition : undefined,
                condition: raw.condition || undefined,
                grading_company: graded ? raw.grading_company : undefined,
                grade: graded && raw.grade != null ? +raw.grade : undefined,
                grade_label: graded ? raw.grade_label : undefined,
                quantity: raw.quantity != null ? Math.max(1, Math.round(+raw.quantity)) : 1,
                status: 'in_stock',
                cost_cents: raw.cost_cents != null ? Math.round(+raw.cost_cents) : undefined,
                target_price_cents: raw.price_cents != null ? Math.round(+raw.price_cents) : undefined,
                value_cents: raw.market_cents != null ? Math.round(+raw.market_cents) : undefined,
                value_currency: raw.market_cents != null ? 'AUD' : undefined,
                value_source: raw.value_source || undefined,
                image_url: raw.image || raw.image_url || undefined,
                notes: raw.notes || undefined, batch_id: batchId,
                title_override: raw.title_override || undefined, desc_override: raw.desc_override || undefined,
              }, ITEM_INSERT_COLS);
              if (b.link_watchlist && raw.game && raw.identity_key && !graded) {
                try { obj.watchlist_id = ensureWatchlist(db, { game: raw.game, identity_key: raw.identity_key, name: raw.name, variant }); } catch {}
              }
              if (existing) {
                if (existing.image_manual) delete obj.image_url;   // never overwrite a user-pinned image on re-import
                if (existing.batch_id != null && Number(existing.batch_id) !== Number(batchId)) touchedBatches.add(Number(existing.batch_id));   // moved out of its old batch → recount that one too
                const cols = Object.keys(obj).filter((c) => obj[c] !== undefined);
                db.prepare(`UPDATE inventory_items SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`)
                  .run(...cols.map((c) => obj[c]), existing.id);
                stats.updated++;
              } else {
                obj.sku = graded ? nextSku(db, raw.game) : nextBulkSku(db, raw.game);
                insertRow(db, 'inventory_items', obj);
                stats.inserted++;
              }
            } catch (e) {   // per-row failure never aborts the batch (Golden Rule 7)
              stats.errors.push({ row: raw && raw.name, error: String(e?.message || e) });
            }
          }
          db.prepare(`UPDATE bulk_batches SET status = 'saved', updated_at = datetime('now') WHERE id = ? AND status IN ('draft','priced')`).run(batchId);
          for (const bid of touchedBatches) recountBatch(db, bid);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          return send(res, 500, { error: 'batch save failed', detail: String(e?.message || e) });
        }
        return send(res, 201, { batch_id: batchId, ...stats });
      }

      // GET /batches/:id — header + its items (rehydrates the grid).
      if ((m = p.match(/^\/batches\/(\d+)$/)) && method === 'GET') {
        const id = +m[1];
        const batch = db.prepare(`SELECT * FROM bulk_batches WHERE id = ?`).get(id);
        if (!batch) return send(res, 404, { error: 'no such batch' });
        const items = db.prepare(`SELECT * FROM inventory_items WHERE batch_id = ? ORDER BY number, variant`).all(id);
        return send(res, 200, { batch, items });
      }

      // PATCH /batches/:id — header update (whitelist).
      if ((m = p.match(/^\/batches\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        const b = await readJson(req);
        const obj = pick(b, BATCH_COLS);
        if (obj.pricing_config && typeof obj.pricing_config === 'object') obj.pricing_config = JSON.stringify(obj.pricing_config);
        const cols = Object.keys(obj);
        if (!cols.length) return send(res, 400, { error: 'nothing to update' });
        db.prepare(`UPDATE bulk_batches SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`)
          .run(...cols.map((c) => obj[c]), id);
        return send(res, 200, { updated: true });
      }

      // DELETE /batches/:id — remove the batch; items are kept but unlinked (audit-safe).
      if ((m = p.match(/^\/batches\/(\d+)$/)) && method === 'DELETE') {
        const id = +m[1];
        const alsoItems = q.get('items') === '1';
        if (alsoItems) db.prepare(`DELETE FROM inventory_items WHERE batch_id = ? AND status = 'in_stock'`).run(id);
        db.prepare(`DELETE FROM bulk_batches WHERE id = ?`).run(id);
        return send(res, 200, { removed: true, items_removed: alsoItems });
      }

      // POST /batches/:id/mark — lifecycle transition for some/all of a batch's items.
      // body: { to:'listed'|'sold'|'in_stock', item_ids?, sale_price_cents?, sale_fees_cents? }
      if ((m = p.match(/^\/batches\/(\d+)\/mark$/)) && method === 'POST') {
        const id = +m[1];
        const b = await readJson(req);
        const to = b.to;
        if (!['in_stock', 'listed', 'sold'].includes(to)) return send(res, 400, { error: "to must be in_stock|listed|sold" });
        const ids = Array.isArray(b.item_ids) && b.item_ids.length ? b.item_ids.map(Number) : null;
        const inClause = ids ? ` AND id IN (${ids.map(() => '?').join(',')})` : '';
        const args = ids ? [id, ...ids] : [id];
        let r;
        if (to === 'sold') {
          r = db.prepare(`UPDATE inventory_items SET status = 'sold', sold_at = COALESCE(sold_at, datetime('now')),
              sale_price_cents = COALESCE(?, sale_price_cents), sale_fees_cents = COALESCE(?, sale_fees_cents),
              channel_status = 'ended', updated_at = datetime('now') WHERE batch_id = ?${inClause}`)
            .run(b.sale_price_cents != null ? Math.round(+b.sale_price_cents) : null,
                 b.sale_fees_cents != null ? Math.round(+b.sale_fees_cents) : null, ...args);
        } else {
          r = db.prepare(`UPDATE inventory_items SET status = ?, channel_status = ?, updated_at = datetime('now')
              WHERE batch_id = ?${inClause}`)
            .run(to, to === 'listed' ? 'active' : null, ...args);
        }
        recountBatch(db, id);
        return send(res, 200, { updated: r.changes, to });
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
        if (!STOCK_GAMES.includes(b.game) || !b.name || !b.grading_company) {
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
        // Atomic: SKU bump + item insert + marking the submission promoted. Without the txn a crash
        // between the insert and the UPDATE would orphan the item AND leave the submission
        // re-promotable → a duplicate slab; a failed insert would also gap the SKU counter.
        let itemId, sku;
        db.exec('BEGIN');
        try {
          sku = nextSku(db, sub.game);
          item.sku = sku;
          itemId = insertRow(db, 'inventory_items', item);
          db.prepare(`UPDATE grading_submissions SET status = 'graded', promoted_item_id = ?, result_grade = ?,
            result_grade_label = ?, result_subgrades = ?, cert_number = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(itemId, grade ?? null, gradeLabel ?? null,
                 (subgrades && typeof subgrades === 'object') ? JSON.stringify(subgrades) : (subgrades ?? null), cert ?? null, id);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
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
