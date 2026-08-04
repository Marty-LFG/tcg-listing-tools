// lib/postsale.mjs — Vite plugin that owns the post-sale automation DB + /api/postsale/* API and
// runs the eBay order-ingest loop. Mirrors repricerPlugin(env) in lib/repricer.mjs; registered in
// vite.config.js `plugins`.
//
// PHASE 0 SCOPE (this file today): read-only order ingest + buyer CRM + one-way Telegram alerts.
// It polls GetOrders on a timer, records new PAID orders (+ buyers + line items) into data/postsale.db,
// creates a `pending` postsale_messages row per order (the message itself is drafted/sent in Phase 1),
// fires a "SOLD" Telegram alert + a daily "to pack" digest, and queues the shipping address for the
// label tool (Phase 5). A cold-start activation watermark guarantees historical buyers are never
// touched. Everything degrades gracefully with no eBay/Telegram creds (Golden Rule 7).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPostsaleDb, POSTSALE_DB_PATH, getMeta, setMeta } from './postsale-db.mjs';
import {
  sendMessage, editMessageText, answerCallbackQuery, telegramEnabled, telegramChatConfigured,
  escapeHtml, startTelegramPoller, registerUpdateHandler,
  isAllowedUser, describeUser, denyCallbackText, sendCard, editCard,
} from './telegram.mjs';
import { itemUrl, searchUrl, compsQuery } from './ebay-links.mjs';
import { shortTitle, renderPullList, renderDispatchSummary, renderSaleAlert } from './telegram-cards.mjs';
import { getOrders, geteBayOfficialTime, sendBuyerMessage, getMemberMessages, completeSale, getItem } from './ebay-trading.mjs';
import { oauthStatus } from './ebay-oauth.mjs';
import { openDb } from './db.mjs';
import {
  draftMessage, guardrailScrub, nextBusinessDay, fallbackDraft, fallbackFollowUp, dispatchFacts,
  DEFAULT_FALLBACK_SUBJECT, DEFAULT_FALLBACK_BODY, DEFAULT_FALLBACK_CARD_LINE,
} from './postsale-llm.mjs';
import { configFile } from './config-paths.mjs';
import {
  classifyPostage, deliveryWindow, isUpgrade, strongestTier, tierPhrase,
  trackingUrl, sellerHubUrl, loadServiceCatalog, refreshServiceCatalog, DEFAULT_POSTAGE_CONFIG,
} from './postage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = configFile('postsale.config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'data', 'postsale.config.example.json');

const DEFAULT_CONFIG = {
  enabled: false,
  mode: 'approve',            // 'approve' | 'auto'
  dry_run: true,
  messaging: true,            // false = ingest orders for the fulfilment dashboard but skip the buyer-message drafting
  poll_interval_min: 10,
  reply_poll_interval_min: 15,
  lookback_hours: 48,
  max_per_run: 10,
  timezone: 'Australia/Sydney',
  digest_hour: 9,
  ship_timing_text: 'packed and sent the next business day',
  signature: '-BK',
  brand_voice: '',
  style_notes: '',
  invite_offers: true,
  quiet_hours: { enabled: true, start: '21:00', end: '08:00' },
  // Plain-template message used when the model lane can't produce a draft. Placeholders that can't be
  // filled with confidence collapse to nothing, so the body has to read correctly without them.
  fallback_enabled: true,
  fallback_subject: DEFAULT_FALLBACK_SUBJECT,
  fallback_body: DEFAULT_FALLBACK_BODY,
  fallback_card_line: DEFAULT_FALLBACK_CARD_LINE,
  holidays: [],
  dashboard_url: '',          // e.g. http://192.168.4.200:5273 — enables the Telegram "Edit in dashboard" button
  alerts: true,
  // Telegram user ids allowed to tap Send/Skip on a post-sale card. EMPTY DENIES EVERYONE — being in
  // the chat is not authorisation, since the chat is a place you add people.
  telegram_allowed_user_ids: [],
  labels: true,
  listings_sync: true,
  fees: false,
  cases: true,
  // What the buyer paid for, and what we do about it — see lib/postage.mjs.
  postage: DEFAULT_POSTAGE_CONFIG,
};

const MAX_PAGES = 20;   // GetOrders pagination safety cap (100 orders/page)

// data/postsale.config.json is gitignored (server-owned) — re-seed on boot from the tracked
// .example so the settings dashboard always has a file to show (mirrors lib/refresh.mjs).
export function ensureConfigSeeded() {
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_EXAMPLE_PATH)) {
      fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
      console.log('[postsale] seeded data/postsale.config.json from example');
    }
    // Backfill keys introduced by a later release. loadConfig() merges DEFAULT_CONFIG so the server
    // behaves correctly without this, but the settings dashboard renders the FILE — a default-only
    // key shows as an empty box, and saving that form would persist the blank over the default.
    // Only ever ADDS absent keys; an existing value is never touched.
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const missing = Object.keys(DEFAULT_CONFIG).filter((k) => !(k in raw));
      for (const k of missing) raw[k] = DEFAULT_CONFIG[k];
      // `postage` nests, and the settings form addresses it by path (postage.dispatch_message.enabled).
      // A half-present block would render those toggles as empty boxes and saving the form would then
      // persist the blanks over the defaults — the exact failure the top-level backfill exists to stop.
      if (raw.postage && typeof raw.postage === 'object') {
        for (const [k, v] of Object.entries(DEFAULT_POSTAGE_CONFIG)) {
          if (!(k in raw.postage)) { raw.postage[k] = v; missing.push('postage.' + k); }
          else if (v && typeof v === 'object' && !Array.isArray(v) && raw.postage[k] && typeof raw.postage[k] === 'object') {
            for (const [k2, v2] of Object.entries(v)) {
              if (!(k2 in raw.postage[k])) { raw.postage[k][k2] = v2; missing.push(`postage.${k}.${k2}`); }
            }
          }
        }
      }
      if (missing.length) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
        console.log('[postsale] config backfilled with new defaults: ' + missing.join(', '));
      }
    }
  } catch (e) { console.warn('[postsale] config seed failed —', e?.message || e); }
}

// postage nests one level deeper than anything else in this config, so a shallow spread would drop
// every default the file happens not to mention (a config written before delivered_message existed
// would silently disable it). Merge the two sub-objects explicitly.
function mergePostage(raw) {
  const d = DEFAULT_POSTAGE_CONFIG, p = (raw && raw.postage) || {};
  return {
    ...d, ...p,
    dispatch_message: { ...d.dispatch_message, ...(p.dispatch_message || {}) },
    delivered_message: { ...d.delivered_message, ...(p.delivered_message || {}) },
    services: { ...(p.services || {}) },
  };
}
export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw,
      quiet_hours: { ...DEFAULT_CONFIG.quiet_hours, ...(raw.quiet_hours || {}) },
      postage: mergePostage(raw) };
  } catch { return DEFAULT_CONFIG; }
}

// --- tiny http helpers (same shape as lib/repricer.mjs) ---
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
// DIAG_TOKEN gate (inlined to avoid a lib/status.mjs <-> lib/postsale.mjs import cycle; same contract).
function diagOk(env, req, url) {
  const want = (env.DIAG_TOKEN || '').trim();
  if (!want) return { ok: false, code: 503, error: 'diagnostics disabled — set DIAG_TOKEN in .env to enable manual triggers' };
  const m = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || '');
  const got = ((m && m[1]) || url.searchParams.get('token') || '').trim();
  if (!got) return { ok: false, code: 401, error: 'missing token — pass Authorization: Bearer <DIAG_TOKEN> or ?token=' };
  const a = Buffer.from(got), b = Buffer.from(want);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, code: 403, error: 'invalid diagnostics token' };
}

const money = (cents, cur = 'AUD') => (cur === 'AUD' ? 'A$' : cur + ' ') + ((Math.round(+cents || 0)) / 100).toFixed(2);
const isoLt = (a, b) => new Date(a).getTime() < new Date(b).getTime();
const maxIso = (a, b) => (isoLt(a, b) ? b : a);

// Generic INSERT from an object; coerces undefined -> null (node:sqlite rejects undefined/booleans).
function insertRow(db, table, obj) {
  const cols = Object.keys(obj);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...cols.map((c) => (obj[c] === undefined ? null : obj[c])));
}

// --- CRM + ingest ---
function upsertBuyer(db, o) {
  const existing = db.prepare('SELECT id, order_count FROM buyers WHERE ebay_username = ?').get(o.buyerUsername);
  if (existing) {
    db.prepare(`UPDATE buyers SET last_seen_at = datetime('now') WHERE id = ?`).run(existing.id);
    return { id: existing.id, priorOrderCount: existing.order_count };
  }
  const ins = db.prepare(`INSERT INTO buyers (ebay_username) VALUES (?)`).run(o.buyerUsername);
  return { id: Number(ins.lastInsertRowid), priorOrderCount: 0 };
}
function recomputeBuyer(db, buyerId) {
  const agg = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(total_cents),0) s FROM orders WHERE buyer_id = ?`).get(buyerId);
  db.prepare(`UPDATE buyers SET order_count = ?, total_spent_cents = ?, last_seen_at = datetime('now') WHERE id = ?`)
    .run(agg.c, agg.s, buyerId);
}
// The line to attach the eBay message to (one msg per order) = the highest-value line.
function representativeItem(items) {
  if (!items || !items.length) return null;
  return items.reduce((best, it) =>
    ((it.unitPriceCents || 0) * (it.quantity || 1)) > ((best.unitPriceCents || 0) * (best.quantity || 1)) ? it : best);
}

// --- reconcile: resolve sold line items to their stored inventory location (powers the pick sheet) ---
// Reads the tracker inventory (data/tracker.db) LIVE so locations stay current even if stock moved.
// Match ladder: order_line_items.sku == inventory sku (exact) → ebay_item_id == inventory ebay_listing_id.
// Returns { bySku, byItemId, locSort } or null when the tracker DB can't be opened (→ everything Unsorted).
export function buildInventoryLookup(tdbIn) {
  let tdb = tdbIn;
  try { tdb = tdb || openDb(); } catch { return null; }
  const bySku = new Map(), byItemId = new Map(), locSort = new Map();
  const add = (kind, r) => {
    const rec = { kind, id: r.id, location: r.location || null, name: r.name, sku: r.sku, status: r.status };
    if (r.sku) bySku.set(String(r.sku).toUpperCase(), rec);
    if (r.ebay_listing_id) byItemId.set(String(r.ebay_listing_id), rec);
  };
  try {
    for (const r of tdb.prepare('SELECT id, sku, name, location, status, ebay_listing_id FROM inventory_items').all()) add('inventory', r);
    for (const r of tdb.prepare('SELECT id, sku, name, location, status, ebay_listing_id FROM sealed_items').all()) add('sealed', r);
    for (const r of tdb.prepare('SELECT name, sort_order FROM sealed_locations').all()) locSort.set(String(r.name).toLowerCase(), r.sort_order | 0);
  } catch (e) { console.warn('[postsale] inventory lookup failed —', e?.message || e); }
  return { bySku, byItemId, locSort };
}
export function matchLineItem(lookup, li) {
  if (!lookup) return null;
  const sku = li.sku || li.SKU;
  if (sku) { const m = lookup.bySku.get(String(sku).toUpperCase()); if (m) return { ...m, method: 'sku' }; }
  const itemId = li.ebay_item_id || li.itemId;
  if (itemId) { const m = lookup.byItemId.get(String(itemId)); if (m) return { ...m, method: 'item_id' }; }
  return null;
}

// --- stock decrement (the "update inventory from eBay activity" direction) ---
// Pure, tracker.db-only. Decrement N units of a graded/raw single: a qty-1 slab (or the last unit of a
// bulk lot) flips to sold + records the sale; a partial bulk lot just loses N. Exported for the unit
// suite. Returns { ok, sold, newQty }.
export function decrementInventoryItem(tdb, itemId, qtySold, saleUnitCents) {
  const inv = tdb.prepare('SELECT id, quantity, status FROM inventory_items WHERE id = ?').get(itemId);
  if (!inv) return { ok: false, reason: 'gone' };
  if (inv.status === 'sold') return { ok: true, sold: true, already: true, newQty: 0 };
  const newQty = Math.max(0, (inv.quantity ?? 1) - (qtySold || 1));
  if (newQty <= 0) {
    tdb.prepare(`UPDATE inventory_items SET quantity = 0, status = 'sold', channel_status = 'ended',
                 sold_at = COALESCE(sold_at, datetime('now')), sale_price_cents = COALESCE(sale_price_cents, ?),
                 updated_at = datetime('now') WHERE id = ?`).run(saleUnitCents != null ? Math.round(saleUnitCents * (qtySold || 1)) : null, itemId);
    return { ok: true, sold: true, newQty: 0 };
  }
  tdb.prepare(`UPDATE inventory_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(newQty, itemId);
  return { ok: true, sold: false, newQty };
}
// Decrement a sealed item through its placements (never write sealed_items.quantity directly when
// placements exist — the multi-location mirror rule); falls back to the scalar quantity when it has none.
export function decrementSealedItem(tdb, itemId, qtySold) {
  const item = tdb.prepare('SELECT id, quantity, status, channel_status FROM sealed_items WHERE id = ?').get(itemId);
  if (!item) return { ok: false, reason: 'gone' };
  let remaining = qtySold || 1;
  const places = tdb.prepare('SELECT id, location, quantity FROM sealed_placements WHERE item_id = ? ORDER BY quantity DESC, id').all(itemId);
  if (places.length) {
    for (const pl of places) {
      if (remaining <= 0) break;
      const take = Math.min(pl.quantity, remaining); remaining -= take;
      const nq = pl.quantity - take;
      if (nq <= 0) tdb.prepare('DELETE FROM sealed_placements WHERE id = ?').run(pl.id);
      else tdb.prepare('UPDATE sealed_placements SET quantity = ? WHERE id = ?').run(nq, pl.id);
    }
    const total = tdb.prepare('SELECT COALESCE(SUM(quantity),0) s FROM sealed_placements WHERE item_id = ?').get(itemId).s;
    const firstLoc = (tdb.prepare('SELECT location FROM sealed_placements WHERE item_id = ? ORDER BY id LIMIT 1').get(itemId) || {}).location || null;
    const sold = total <= 0;
    tdb.prepare(`UPDATE sealed_items SET quantity = ?, location = ?, status = ?, channel_status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(total, firstLoc, sold ? 'sold' : item.status, sold ? 'ended' : item.channel_status, itemId);
    return { ok: true, sold, newQty: total };
  }
  const newQty = Math.max(0, (item.quantity ?? 1) - (qtySold || 1));
  const sold = newQty <= 0;
  tdb.prepare(`UPDATE sealed_items SET quantity = ?, status = ?, channel_status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newQty, sold ? 'sold' : item.status, sold ? 'ended' : item.channel_status, itemId);
  return { ok: true, sold, newQty };
}

// applyStockDecrements(pdb) — sweep every paid line item not yet applied to stock; for each that
// matches a tracker row (SKU or ebay_item_id), decrement and stamp stock_applied_at (cross-DB
// idempotency). Unmatched lines are left for a later sweep (they'll match once the listing publishes).
export function applyStockDecrements(pdb, tdbIn) {
  let tdb = tdbIn; try { tdb = tdb || openDb(); } catch { return { considered: 0, matched: 0, applied: 0, sold: 0, error: 'tracker_db' }; }
  const lookup = buildInventoryLookup(tdb);
  if (!lookup) return { considered: 0, matched: 0, applied: 0, sold: 0, error: 'no_lookup' };
  let hasCol = true;
  try { pdb.prepare('SELECT stock_applied_at FROM order_line_items LIMIT 1').get(); } catch { hasCol = false; }
  if (!hasCol) return { considered: 0, matched: 0, applied: 0, sold: 0, error: 'no_column' };
  const lines = pdb.prepare('SELECT id, order_id, ebay_item_id, sku, quantity, unit_price_cents FROM order_line_items WHERE stock_applied_at IS NULL').all();
  let matched = 0, applied = 0, sold = 0;
  for (const li of lines) {
    const m = matchLineItem(lookup, { sku: li.sku, ebay_item_id: li.ebay_item_id });
    if (!m) continue;
    matched++;
    const r = m.kind === 'sealed' ? decrementSealedItem(tdb, m.id, li.quantity) : decrementInventoryItem(tdb, m.id, li.quantity, li.unit_price_cents);
    if (r.ok) {
      pdb.prepare(`UPDATE order_line_items SET stock_applied_at = datetime('now'), matched_kind = ?, matched_item_id = ?, match_method = COALESCE(match_method, ?), reconciled_at = COALESCE(reconciled_at, datetime('now')) WHERE id = ?`)
        .run(m.kind, m.id, m.method, li.id);
      applied++; if (r.sold) sold++;
    }
  }
  if (applied) console.log(`[postsale] stock decrement: ${applied} line(s) applied (${sold} sold out) of ${matched} matched / ${lines.length} pending`);
  return { considered: lines.length, matched, applied, sold };
}

// Chaos-sort storage: the seller stows singles in acquisition order and encodes the location in the
// SKU — prefix = box (AAA holds AAA-001…AAA-100, then AAB…), number = slot within the box. So the SKU
// prefix IS the physical location; derive the box label from it for the dashboard + pick sheet.
export function skuGroupLabel(sku) {
  if (!sku) return null;
  const s = String(sku).trim();
  if (!s) return null;
  const prefix = s.replace(/[-_\s]*\d+[A-Za-z]?$/, '').trim();   // strip the trailing slot number: AAC-012 → AAC
  return 'Box ' + (prefix || s);
}

// Sort + group pick rows by storage location — pure (unit-testable). locSort maps a location name
// (lowercased) to a sealed_locations.sort_order; those come first (by order), then alphabetical
// locations, then the unmatched "Unsorted" bucket last. Ties break by order id for a stable pull path.
export const PICK_UNSORTED = 'Unsorted — find manually';
export function buildPickSheet(rows, locSort = new Map()) {
  const rank = (loc) => {
    if (!loc) return [2, ''];
    const so = locSort.get(String(loc).toLowerCase());
    return so != null ? [0, String(so).padStart(8, '0') + '|' + loc.toLowerCase()] : [1, loc.toLowerCase()];
  };
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const sorted = rows.slice().sort((a, b) => {
    const ka = rank(a.location), kb = rank(b.location);
    return ka[0] - kb[0]
      || cmp(ka[1], kb[1])                              // by location/bin
      || cmp(String(a.sku || ''), String(b.sku || ''))  // then by SKU so a bin is walked front-to-back
      || cmp(String(a.order_id), String(b.order_id));
  });
  const groups = [];
  let cur = null;
  for (const r of sorted) {
    const key = r.location || PICK_UNSORTED;
    if (!cur || cur.location !== key) { cur = { location: key, items: [] }; groups.push(cur); }
    cur.items.push(r);
  }
  return { rows: sorted, groups, unit_count: sorted.reduce((n, r) => n + (r.quantity || 1), 0) };
}
// Mutates each order's items[] with resolved { location, matched_kind, matched_item_id, match_method },
// and opportunistically persists a new/changed match onto order_line_items so the reconcile columns fill in.
export function attachLocations(db, orders, lookup = buildInventoryLookup()) {
  for (const o of orders) {
    for (const li of (o.items || [])) {
      const m = matchLineItem(lookup, li);
      // Prefer a real inventory-record location; otherwise derive the chaos-sort box from the SKU.
      li.location = (m && m.location) || skuGroupLabel(li.sku);
      li.matched_kind = m ? m.kind : (li.matched_kind ?? null);
      li.matched_item_id = m ? m.id : (li.matched_item_id ?? null);
      li.match_method = m ? m.method : (li.match_method ?? null);
      if (m && li.id && (li.matched_item_id !== m.id || li.match_method !== m.method)) {
        try {
          db.prepare(`UPDATE order_line_items SET matched_kind=?, matched_item_id=?, match_method=?, reconciled_at=datetime('now') WHERE id=?`)
            .run(m.kind, m.id, m.method, li.id);
        } catch { /* reconcile is best-effort */ }
      }
    }
  }
  return orders;
}

/**
 * The pack queue, as ONE SQL predicate, because three copies of it is how the pick sheet and the
 * dashboard end up disagreeing about what is left to do.
 *
 * The queue is about OUR physical work, not eBay's paperwork. `shipped_status` is eBay's truth and it
 * flips the moment a postage label is bought, which happens while the cards are still on the shelf —
 * so an order eBay calls "sent" that nobody has picked yet is still very much in the queue. `picked_at`
 * (pulled off the shelf and packed) is the signal that the work is actually done.
 *
 * label_bought_at is only ever stamped by refreshOrder on the live transition, so historical backfilled
 * orders can never leak back into the queue through this.
 */
// A label-bought order is in the queue only UNTIL it is picked. label_bought_at is history and is
// never cleared, so without the picked_at clause those orders would sit in the queue forever.
export const IN_QUEUE_SQL = "(shipped_status = 'unshipped' OR (label_bought_at IS NOT NULL AND picked_at IS NULL))";
export const NEEDS_PACKING_SQL = `(picked_at IS NULL AND ${IN_QUEUE_SQL})`;
// The same two rules against a row already in hand.
export function inQueue(o) { return o.shipped_status === 'unshipped' || (!!o.label_bought_at && !o.picked_at); }
export function needsPacking(o) { return !o.picked_at && inQueue(o); }

// The one-word state the dashboard and the digest both label an order with.
//   to_pack      — nobody has pulled it yet
//   label_bought — eBay says sent because a label was bought, but the cards are still on the shelf
//   to_post      — pulled and packed, still needs dispatching
//   posted       — done
export function attachFulfilment(orders) {
  for (const o of orders) {
    o.needs_packing = needsPacking(o);
    o.in_queue = inQueue(o);
    o.fulfilment_state = !inQueue(o) ? 'posted'
      : o.label_bought_at && !o.picked_at ? 'label_bought'
        : o.picked_at ? 'to_post' : 'to_pack';
  }
  return orders;
}

// Decorate order rows with the postage view that the dashboard, the pick sheet and the packing slip
// all read. Deliberately RE-DERIVED from the raw eBay columns on every read rather than trusting the
// stored postage_tier: that way correcting a service override in settings takes effect on the next
// page load, instead of waiting for eBay to touch the order again so a refresh re-stamps it.
//
// `label` is the buyer-facing name and only ever comes from a source we trust (a config override, or
// eBay's own Description via the service catalog); anything else falls back to the tier phrase, since
// "Standard delivery" reads better on a customer's packing slip than "AU_Regular". `code` keeps the
// raw service string for the seller-side surfaces, where knowing the exact eBay service is the point.
export function attachPostage(orders, cfg = DEFAULT_CONFIG) {
  const pcfg = (cfg && cfg.postage) || {};
  for (const o of orders) {
    const p = classifyPostage(o, pcfg);
    const w = deliveryWindow(o);
    o.postage = {
      tier: p.tier,
      upgrade: isUpgrade(p.tier),
      tracked: p.tracked,
      label: p.labelSource === 'derived' ? tierPhrase(p.tier) : p.label,
      code: p.code,
      paid_cents: p.paidCents,
      note: p.note,
      handle_by: o.handle_by_time || null,
      eta_min: w.min, eta_max: w.max, eta_source: w.source,
      tracking: o.tracking_number || null,
      carrier: o.carrier || null,
      tracking_url: o.tracking_number ? trackingUrl(pcfg, o.tracking_number) : null,
      seller_hub_url: sellerHubUrl(pcfg, o.order_id),
      delivered_time: o.delivered_time || null,
      dispatch_source: o.dispatch_source || null,
    };
  }
  return orders;
}

// Distinct shipping services this account has actually sold under, each with the tier it currently
// classifies as and how many orders used it. Feeds the settings UI so overriding a mis-read service is
// picking from a real list rather than guessing eBay's code spelling.
export function observedServices(db, cfg = DEFAULT_CONFIG) {
  // Report how each service ACTUALLY classified on real orders — the most common tier among them —
  // rather than re-deriving one from an aggregate. The cost is part of the rule set, so any single
  // summary figure (max, average) invents an order that never existed and can report a tier nothing
  // has ever had. The stored tiers are the truth, and a service that reads two ways is worth seeing.
  const rows = db.prepare(`SELECT ship_service AS code, COUNT(*) AS orders,
                                  MAX(COALESCE(paid_time, created_time)) AS last_seen
                           FROM orders WHERE ship_service IS NOT NULL AND ship_service <> ''
                           GROUP BY ship_service ORDER BY orders DESC`).all();
  const tiers = db.prepare(`SELECT ship_service AS code, COALESCE(postage_tier,'standard') AS tier, COUNT(*) AS n
                            FROM orders WHERE ship_service IS NOT NULL AND ship_service <> ''
                            GROUP BY ship_service, tier ORDER BY n DESC`).all();
  const pcfg = (cfg && cfg.postage) || {};
  return rows.map((r) => {
    const mine = tiers.filter((t) => t.code === r.code);
    const top = mine[0] || { tier: 'standard' };
    const p = classifyPostage({ ship_service: r.code }, pcfg);
    return {
      code: r.code, orders: r.orders, last_seen: r.last_seen,
      tier: top.tier,
      // Present only when the same service has classified more than one way, which is the signal that
      // it is being driven by what the buyer paid rather than by the code.
      mixed: mine.length > 1 ? mine.map((t) => `${t.tier}×${t.n}`) : null,
      label: p.label,
      overridden: !!(pcfg.services && pcfg.services[r.code]),
    };
  });
}

// Lazily resolve the eBay listing image for line items that don't have one cached yet, capped per call
// (fetched in parallel) so the dashboard fills in over a few loads without hammering the Trading API.
// image_checked_at is stamped once GetItem gives a definitive answer (image or none); a thrown/transient
// failure leaves it unstamped so it retries. Mutates each item's image_url in place.
export async function resolveImages(env, db, orders, max = 12) {
  const need = [];
  for (const o of orders) for (const li of (o.items || [])) {
    if (!li.image_url && !li.image_checked_at && li.ebay_item_id) need.push(li);
  }
  const batch = need.slice(0, Math.max(0, max));
  if (!batch.length) return orders;
  await Promise.all(batch.map(async (li) => {
    try {
      const r = await getItem(env, li.ebay_item_id);
      const url = (r.ok && r.imageUrl) ? r.imageUrl : null;
      db.prepare(`UPDATE order_line_items SET image_url=?, image_checked_at=datetime('now') WHERE id=?`).run(url, li.id);
      li.image_url = url;
    } catch { /* transient — leave image_checked_at null so it retries next load */ }
  }));
  return orders;
}

// Ingest ONE paid order in a single transaction. Idempotent (ON CONFLICT / pre-check on order_id).
// Returns { created, repeat } — created=false when the order was already ingested. Exported so the
// integration suite can seed an order without a live GetOrders call.
export function ingestOrder(db, o, cfg = DEFAULT_CONFIG, { messageStatus = 'pending' } = {}) {
  if (db.prepare('SELECT 1 FROM orders WHERE order_id = ?').get(o.orderId)) return { created: false, repeat: false };
  db.exec('BEGIN');
  try {
    const buyer = upsertBuyer(db, o);
    const repeat = buyer.priorOrderCount > 0;
    insertRow(db, 'orders', {
      order_id: o.orderId, buyer_id: buyer.id, buyer_username: o.buyerUsername,
      order_status: o.orderStatus, checkout_status: o.checkoutStatus, paid_status: o.paidStatus,
      created_time: o.createdTime, paid_time: o.paidTime, shipped_time: o.shippedTime,
      currency: o.currency || 'AUD', total_cents: o.totalCents ?? 0, subtotal_cents: o.subtotalCents,
      sales_record_number: o.salesRecordNumber, buyer_note: o.buyerNote,
      ship_name: o.ship.name, ship_street1: o.ship.street1, ship_street2: o.ship.street2,
      ship_city: o.ship.city, ship_state: o.ship.state, ship_postal: o.ship.postal,
      ship_country: o.ship.country, ship_country_name: o.ship.countryName, ship_phone: o.ship.phone,
      shipped_status: o.shippedTime ? 'shipped' : 'unshipped',
      label_status: (cfg.labels && !o.shippedTime && o.ship.name) ? 'queued' : null,
      ...postageColumns(o, cfg),
      raw: JSON.stringify(o),
    });
    for (const it of o.items) {
      insertRow(db, 'order_line_items', {
        order_id: o.orderId, order_line_item_id: it.orderLineItemId, transaction_id: it.transactionId,
        ebay_item_id: it.itemId, sku: it.sku, title: it.title,
        quantity: it.quantity ?? 1, unit_price_cents: it.unitPriceCents ?? 0,
      });
    }
    recomputeBuyer(db, buyer.id);
    const rep = representativeItem(o.items);
    db.prepare(`INSERT INTO postsale_messages (order_id, kind, buyer_id, ebay_item_id, is_repeat_buyer, status)
                VALUES (?,'purchase',?,?,?,?) ON CONFLICT(order_id, kind) DO NOTHING`)
      .run(o.orderId, buyer.id, rep ? rep.itemId : null, repeat ? 1 : 0, messageStatus);
    db.exec('COMMIT');
    return { created: true, repeat };
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

// Every postage column an ingest or a refresh writes, derived once from a parsed order.
function postageColumns(o, cfg) {
  const p = classifyPostage(o, (cfg && cfg.postage) || {});
  const bit = (v) => (v == null ? null : (v ? 1 : 0));
  return {
    expedited: bit(o.expedited),
    buyer_selected_shipping: bit(o.buyerSelectedShipping),
    postage_tier: p.tier, postage_label: p.label, postage_tracked: p.tracked ? 1 : 0,
    handle_by_time: o.handleByTime, eta_min: o.etaMin, eta_max: o.etaMax,
    scheduled_min: o.scheduledMin, scheduled_max: o.scheduledMax,
    delivered_time: o.deliveredTime,
    tracking_number: o.trackingNumber, carrier: o.carrier,
    ship_service: o.shipService, shipping_cents: o.shippingCents,
  };
}

// Queue one buyer message of a given kind, once. The unique (order_id, kind) index is the idempotency
// key, so a re-poll that re-detects the same transition is a no-op rather than a second message.
// Returns true only when a row was actually created.
export function enqueueMessage(db, orderId, kind) {
  const ord = db.prepare('SELECT buyer_id FROM orders WHERE order_id=?').get(orderId);
  if (!ord) return false;
  // Never message on history. backfillOrders parks its purchase message as 'closed', which is exactly
  // the marker for "this order predates us being live" — a months-old sale should not suddenly get a
  // dispatch note because eBay touched it.
  const purchase = db.prepare(`SELECT status FROM postsale_messages WHERE order_id=? AND kind='purchase'`).get(orderId);
  if (purchase && purchase.status === 'closed') return false;
  const rep = db.prepare('SELECT ebay_item_id FROM order_line_items WHERE order_id=? AND ebay_item_id IS NOT NULL ORDER BY unit_price_cents DESC LIMIT 1').get(orderId);
  const r = db.prepare(`INSERT INTO postsale_messages (order_id, kind, buyer_id, ebay_item_id, status)
                        VALUES (?,?,?,?,'pending') ON CONFLICT(order_id, kind) DO NOTHING`)
    .run(orderId, kind, ord.buyer_id, rep ? rep.ebay_item_id : null);
  return (r.changes || 0) > 0;
}

/**
 * refreshOrder(db, o, cfg) — update an order we already have from a fresh GetOrders read.
 *
 * ingestOrder deliberately returns early on a known order_id, which was right when an order was a
 * fixed record of a sale. It isn't: eBay keeps writing to the shipment side of it for weeks, and in
 * particular it writes the tracking number and flips the order to shipped by itself the moment a
 * postage label is bought in Seller Hub. Without this function all of that landed in a response we
 * made every ten minutes and discarded.
 *
 * Only mutable fields are touched. Buyer, line items and money are what they were.
 *
 * Two rules worth keeping:
 *  - Never blank a value eBay has stopped sending. A later response legitimately omits fields it sent
 *    before (Scheduled* supersedes Estimated*, ReturnAll trims empty blocks), and a naive overwrite
 *    would erase a tracking number we already showed the buyer.
 *  - Fire messages on the TRANSITION, not on the state. eBay's own timestamps can be backdated, so
 *    "there is a tracking number" is not a trigger; "there was not one before" is.
 */
export function refreshOrder(db, o, cfg = DEFAULT_CONFIG) {
  const prev = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(o.orderId);
  if (!prev) return { updated: false };

  const next = {};
  for (const [k, v] of Object.entries(postageColumns(o, cfg))) {
    if (v != null && v !== '') next[k] = v;              // 0 is a real value; '' and null are "not sent"
  }
  if (o.shippedTime) next.shipped_time = o.shippedTime;
  if (o.orderStatus) next.order_status = o.orderStatus;
  if (o.checkoutStatus) next.checkout_status = o.checkoutStatus;
  if (o.paidStatus) next.paid_status = o.paidStatus;

  const gotTracking = !prev.tracking_number && !!next.tracking_number;
  const gotDelivered = !prev.delivered_time && !!next.delivered_time;
  const becameShipped = prev.shipped_status !== 'shipped' && !!(next.shipped_time || next.tracking_number);

  if (gotTracking) next.tracking_seen_at = nowSql();
  if (gotDelivered) next.delivered_seen_at = nowSql();
  if (becameShipped) {
    next.shipped_status = 'shipped';
    // Only claim eBay dispatched it when we didn't. A manual "Mark shipped" already stamped this.
    if (!prev.dispatch_source) next.dispatch_source = 'ebay';
    // eBay says "sent" the moment the postage label is BOUGHT. That is not the parcel leaving — the
    // cards are usually still in the box. Record it as a distinct fact so the order keeps its place in
    // our pack queue until a human has actually pulled and packed it; without this, buying a label at
    // 9am silently deletes the order from the queue, the pick sheet and the morning digest.
    if (!prev.dispatch_source && !prev.picked_at && !prev.label_bought_at) next.label_bought_at = nowSql();
  }

  const changed = Object.keys(next).filter((k) => String(prev[k] ?? '') !== String(next[k] ?? ''));
  if (!changed.length) return { updated: false, changed: [], gotTracking: false, gotDelivered: false, becameShipped: false };

  const pcfg = (cfg && cfg.postage) || {};
  const messagingOn = cfg.messaging !== false;
  const queued = [];
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE orders SET ${changed.map((c) => `${c}=?`).join(', ')} WHERE order_id=?`)
      .run(...changed.map((c) => next[c]), o.orderId);
    if (gotTracking && messagingOn && pcfg.dispatch_message?.enabled) {
      if (enqueueMessage(db, o.orderId, 'dispatch')) queued.push('dispatch');
    }
    if (gotDelivered && messagingOn && pcfg.delivered_message?.enabled) {
      if (enqueueMessage(db, o.orderId, 'delivered')) queued.push('delivered');
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }

  return { updated: true, changed, gotTracking, gotDelivered, becameShipped, queued };
}

// --- Telegram alerts (one-way; owner-facing) ---
async function fireSaleAlert(env, db, o, repeat, cfg) {
  if (!cfg.alerts || !telegramEnabled(env) || !telegramChatConfigured(env)) return;
  const row = db.prepare('SELECT sale_alert_sent_at FROM orders WHERE order_id = ?').get(o.orderId);
  if (row?.sale_alert_sent_at) return;
  const loc = [o.ship.city, o.ship.state].filter(Boolean).join(', ') + (o.ship.postal ? ` ${o.ship.postal}` : '');
  const text = renderSaleAlert({
    items: o.items, totalText: money(o.totalCents, o.currency), where: loc || null,
    buyerUsername: o.buyerUsername, repeat,
  });
  const r = await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text });
  if (r.ok) db.prepare(`UPDATE orders SET sale_alert_sent_at = datetime('now') WHERE order_id = ?`).run(o.orderId);
}

// --- message drafting + approval + send (Phase 1) ---
const nowSql = () => new Date().toISOString();   // ISO-Z, unambiguous UTC (comparable for reply detection)
function setMsg(db, id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const sql = `UPDATE postsale_messages SET ${cols.map((c) => `${c}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`;
  db.prepare(sql).run(...cols.map((c) => (fields[c] === undefined ? null : fields[c])), id);
}
// Card list for the OWNER's eye (Telegram cards, alerts, the reply handoff), so titles are shortened
// to name + number + set. The model is fed full titles separately via buildContext — it needs the
// exact wording to name the card back to the buyer, and must not inherit this trimming.
function cardsText(db, orderId) {
  return db.prepare('SELECT title, sku, ebay_item_id, quantity FROM order_line_items WHERE order_id=?').all(orderId)
    .map((it) => `${shortTitle(it.title) || it.sku || it.ebay_item_id || 'a card'}${it.quantity > 1 ? ` ×${it.quantity}` : ''}`).join(', ');
}
// A few card titles this buyer bought on EARLIER orders (for the repeat-buyer "good to see you again").
function priorCardsFor(db, buyerId, excludeOrderId) {
  return db.prepare(`SELECT DISTINCT li.title FROM order_line_items li JOIN orders o ON o.order_id = li.order_id
                     WHERE o.buyer_id = ? AND o.order_id != ? AND li.title IS NOT NULL
                     ORDER BY o.paid_time DESC LIMIT 3`).all(buyerId, excludeOrderId).map((r) => r.title);
}
function localHourMinute(tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t) => parseInt(parts.find((p) => p.type === t)?.value, 10);
  return { hour: g('hour'), minute: g('minute') };
}
function inQuietHours(cfg) {
  const q = cfg.quiet_hours; if (!q || !q.enabled) return false;
  const { hour, minute } = localHourMinute(cfg.timezone);
  const cur = hour * 60 + minute;
  const [sh, sm] = String(q.start || '21:00').split(':').map(Number);
  const [eh, em] = String(q.end || '08:00').split(':').map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);   // wraps midnight
}

// The message itself is the thing being approved, so it gets the room. Everything above it is the
// one line of context needed to judge it: who, whether they've bought before, and what they bought.
const KIND_BADGE = {
  purchase: { icon: '💌', label: '' },
  dispatch: { icon: '📦', label: 'dispatch note' },
  delivered: { icon: '📬', label: 'delivered follow-up' },
};
function renderApprovalCard({ buyerUsername, repeat, itemsText, subject, body, dryRun, kind }, decided) {
  const badge = KIND_BADGE[kind] || KIND_BADGE.purchase;
  let s = `${badge.icon} <b>@${escapeHtml(buyerUsername || '')}</b>${badge.label ? `  <i>${badge.label}</i>` : ''}${repeat ? '  ⭐ <i>repeat buyer</i>' : ''}\n`;
  if (itemsText) s += `<i>${escapeHtml(itemsText)}</i>\n`;
  s += `\n<b>${escapeHtml(subject || '')}</b>\n${escapeHtml(body || '')}`;
  if (dryRun && !decided) s += `\n\n<i>DRY-RUN — Send records approval only, nothing goes to eBay.</i>`;
  if (decided) s += `\n\n${decided.icon} <b>${escapeHtml(decided.status)}</b>${decided.who ? ` by ${escapeHtml(decided.who)}` : ''}`;
  return s;
}
// Reference links, kept after the decision for the same reason as the repricer's: "what did I just
// send, and about what?" outlives the buttons. `item` is the single line item, when there is one —
// naming a listing is only unambiguous for a one-card order.
function postsaleLinkButtons(cfg, item) {
  const row = [];
  const url = item && item.ebay_item_id ? itemUrl(item.ebay_item_id) : null;
  if (url) row.push({ text: '🔗 Listing', url });
  if (cfg && cfg.dashboard_url) row.push({ text: '✏️ Dashboard', url: String(cfg.dashboard_url).replace(/\/$/, '') + '/postsale.html' });
  // Both halves of the comparison, same as the repricer's card: what the card actually sold for, and
  // what the ones still up are asking. One without the other is half a picture.
  const q = item ? compsQuery(item.title) : '';
  const sold = q ? searchUrl(q, { sold: true }) : null;
  const active = q ? searchUrl(q) : null;
  if (sold) row.push({ text: '💰 Sold', url: sold });
  if (active) row.push({ text: '🔎 Active', url: active });
  return row.length ? [row] : [];
}
function approvalButtons(id, cfg, item) {
  return [[{ text: '✅ Send', data: `psa:${id}` }, { text: '⏭ Skip', data: `pss:${id}` }], ...postsaleLinkButtons(cfg, item)];
}
// The order's line items, and the single one worth linking to (a one-card order).
function cardItems(db, orderId) {
  const items = db.prepare('SELECT * FROM order_line_items WHERE order_id=?').all(orderId);
  return { items, only: items.length === 1 ? items[0] : null };
}

// The one place an eBay member message actually goes out. dry_run short-circuits BEFORE any eBay call.
async function sendPostsaleMessage(env, db, msg, cfg, { decidedBy } = {}) {
  if (cfg.dry_run) {
    setMsg(db, msg.id, { status: 'sent', sent_at: nowSql(), decided_by: decidedBy || 'system', decided_at: nowSql(), error: 'dry_run (not sent to eBay)' });
    return { ok: true, dry_run: true };
  }
  const order = db.prepare('SELECT buyer_username FROM orders WHERE order_id=?').get(msg.order_id);
  const recipientId = order?.buyer_username;
  const itemId = msg.ebay_item_id
    || db.prepare('SELECT ebay_item_id FROM order_line_items WHERE order_id=? ORDER BY unit_price_cents DESC LIMIT 1').get(msg.order_id)?.ebay_item_id;
  if (!itemId || !recipientId) { setMsg(db, msg.id, { status: 'failed', error: 'missing itemId/recipient for send' }); return { ok: false, error: 'missing' }; }
  const r = await sendBuyerMessage(env, { itemId, recipientId, subject: msg.subject, body: msg.body });
  if (r.ok) { setMsg(db, msg.id, { status: 'sent', sent_at: nowSql(), decided_by: decidedBy || 'system', decided_at: nowSql(), error: null }); return { ok: true }; }
  const detail = (r.errors || []).map((e) => e.shortMessage || e.longMessage).filter(Boolean).join('; ') || r.ack || 'send failed';
  setMsg(db, msg.id, { status: 'failed', error: 'eBay: ' + detail });
  return { ok: false, error: 'ebay', detail };
}

// Draft a `pending`/regenerate message, guardrail it, then route by mode. Returns a small result.
async function draftAndRoute(env, db, msg, cfg, { pushCard = true } = {}) {
  const kind = msg.kind || 'purchase';
  const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(msg.order_id);
  const items = db.prepare('SELECT * FROM order_line_items WHERE order_id=?').all(msg.order_id);
  const buyer = db.prepare('SELECT * FROM buyers WHERE id=?').get(msg.buyer_id);
  const priorCards = msg.is_repeat_buyer ? priorCardsFor(db, msg.buyer_id, msg.order_id) : [];
  const shipBy = nextBusinessDay(order?.paid_time ? new Date(order.paid_time) : new Date(), { tz: cfg.timezone, holidays: cfg.holidays });
  const pcfg = cfg.postage || {};
  // The follow-ups are about the parcel, so they get the same postage view the dashboard renders.
  const postage = kind === 'purchase' ? {} : attachPostage([{ ...order }], cfg)[0].postage;
  // The tracking number is stamped on, never written by the model — see dispatchFacts. `stamp` is
  // applied to whichever draft wins (model or template) so both carry identical, correct facts.
  const facts = kind === 'dispatch' ? dispatchFacts(postage, pcfg) : { text: '', allow: [] };
  const stamp = (b) => (facts.text ? String(b).trim() + '\n\n' + facts.text : String(b).trim());

  const d = await draftMessage({ order, items, buyer, priorCards, cfg, env, shipBy, kind, postage });
  let use = null, why = null;
  if (d.ok) {
    const body = stamp(d.body);
    const scrub = guardrailScrub(body, { allow: facts.allow });
    if (scrub.clean) use = { ...d, body };
    else why = 'guardrail: ' + scrub.violations.join(', ');
  } else {
    why = d.error + ': ' + (d.message || '');
  }
  // The model lane failed. Rather than leave the buyer with nothing (which is what used to happen),
  // fall back to the plain config template — no model, so it can't fail the same way. The reason is
  // still recorded on the message, so a dead provider stays visible instead of being papered over.
  if (!use && cfg.fallback_enabled !== false) {
    const fb = kind === 'purchase'
      ? fallbackDraft({ order, items, cfg, shipBy })
      : fallbackFollowUp({ order, items, postage, cfg, kind });
    const body = fb.ok ? stamp(fb.body) : '';
    if (fb.ok && guardrailScrub(body, { allow: facts.allow }).clean) use = { ...fb, body };
  }
  if (!use) {
    setMsg(db, msg.id, { status: 'failed', ...(d.ok ? { subject: d.subject, body: d.body, model: d.model } : {}), error: why });
    return { ok: false, error: d.ok ? 'guardrail' : d.error };
  }
  setMsg(db, msg.id, {
    status: 'drafted', subject: use.subject, body: use.body, model: use.model,
    error: use.model === 'template' ? 'fallback template (' + why + ')' : null,
  });

  // auto mode (outside quiet hours) sends now; otherwise park for approval.
  // The delivered note is the exception: it lands after the transaction is done, it asks for a rating,
  // and it is the one message where a bad read of the situation (an order with a case open, a parcel
  // eBay thinks arrived and didn't) is most costly. It is held for a human tap regardless of mode.
  const forceApprove = kind === 'delivered' && (pcfg.delivered_message || {}).force_approve !== false;
  if (cfg.mode === 'auto' && !forceApprove && !inQuietHours(cfg)) {
    const fresh = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(msg.id);
    const r = await sendPostsaleMessage(env, db, fresh, cfg, { decidedBy: 'auto' });
    if (r.ok && telegramEnabled(env) && telegramChatConfigured(env)) {
      await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text: `✅ <b>Auto-sent</b> to @${escapeHtml(order.buyer_username || '')}${cfg.dry_run ? ' (dry-run)' : ''}\n<i>${escapeHtml(cardsText(db, msg.order_id))}</i>` }).catch(() => {});
    }
    return { ok: r.ok, status: r.ok ? 'sent' : 'failed' };
  }
  setMsg(db, msg.id, { status: 'awaiting_approval' });
  if (pushCard) {
    const fresh = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(msg.id);
    await pushApprovalCard(env, db, fresh, order, cfg);
  }
  return { ok: true, status: 'awaiting_approval' };
}

// Returns a small result so a caller can report the outcome. The draft path ignores it (a Telegram
// hiccup must not fail the draft — GR7), but the manual push endpoint below surfaces it.
async function pushApprovalCard(env, db, msg, order, cfg) {
  if (!telegramEnabled(env) || !telegramChatConfigured(env)) return { ok: false, skipped: 'no_telegram' };
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  const { only } = cardItems(db, order.order_id);
  // Resolve the card's picture if we haven't already — cached on the line item, so this costs one
  // GetItem once per order and nothing thereafter.
  if (only && !only.image_url && !only.image_checked_at) {
    try { await resolveImages(env, db, [{ items: [only] }], 1); } catch { /* picture is optional */ }
  }
  const text = renderApprovalCard({ buyerUsername: order.buyer_username, repeat: !!msg.is_repeat_buyer, itemsText: cardsText(db, order.order_id), subject: msg.subject, body: msg.body, dryRun: cfg.dry_run, kind: msg.kind });
  const r = await sendCard(env, { chatId, photo: only && only.image_url, text, buttons: approvalButtons(msg.id, cfg, only) });
  if (!r.ok) return { ok: false, error: r.description || 'send failed' };
  db.prepare('UPDATE postsale_messages SET telegram_chat_id=?, telegram_message_id=? WHERE id=?').run(String(chatId), r.result.message_id, msg.id);
  return { ok: true, chat_id: String(chatId), message_id: r.result.message_id, photo: !!r.photo };
}
// Stamp the outcome onto the Telegram card + drop its buttons (keeps both surfaces in sync when the
// decision was made in the web dashboard instead of via a Telegram tap).
async function stampTelegramCard(env, db, msg, decided) {
  if (!msg.telegram_chat_id || !msg.telegram_message_id) return;
  const order = db.prepare('SELECT buyer_username FROM orders WHERE order_id=?').get(msg.order_id);
  const { only } = cardItems(db, msg.order_id);
  await editCard(env, { chatId: msg.telegram_chat_id, messageId: msg.telegram_message_id,
    text: renderApprovalCard({ buyerUsername: order?.buyer_username, repeat: !!msg.is_repeat_buyer, itemsText: cardsText(db, msg.order_id), subject: msg.subject, body: msg.body, kind: msg.kind }, decided),
    buttons: postsaleLinkButtons(loadConfig(), only), clearButtons: true, photo: !!(only && only.image_url) }).catch(() => {});
}

// Re-draft an existing message (dashboard "Regenerate"); edits the Telegram card in place if present.
async function redraftMessage(env, db, id, cfg) {
  const msg = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(id);
  if (!msg) return { ok: false, error: 'not_found' };
  const r = await draftAndRoute(env, db, msg, cfg, { pushCard: false });
  const fresh = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(id);
  if (fresh.telegram_chat_id && fresh.telegram_message_id && fresh.status === 'awaiting_approval') {
    const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(fresh.order_id);
    const { only } = cardItems(db, fresh.order_id);
    await editCard(env, { chatId: fresh.telegram_chat_id, messageId: fresh.telegram_message_id,
      text: renderApprovalCard({ buyerUsername: order.buyer_username, repeat: !!fresh.is_repeat_buyer, itemsText: cardsText(db, fresh.order_id), subject: fresh.subject, body: fresh.body, dryRun: cfg.dry_run, kind: fresh.kind }),
      buttons: approvalButtons(fresh.id, cfg, only), photo: !!(only && only.image_url) }).catch(() => {});
  }
  return { ...r, message: fresh };
}

// Draft the pending backlog (called at the end of each order-poll, and via the manual trigger).
export async function processMessages(env, db, cfg = loadConfig(), { limit } = {}) {
  const max = limit || cfg.max_per_run || 10;
  const pcfg = cfg.postage || {};
  // A tracking number appears the moment the label is BOUGHT, which is usually a while before the
  // parcel is actually lodged. delay_min holds the "it's on its way" note back so it isn't a lie.
  const delayMin = Math.max(0, +((pcfg.dispatch_message || {}).delay_min ?? 0) || 0);
  const readyAfter = new Date(Date.now() - delayMin * 60_000).toISOString();
  const pend = db.prepare(`SELECT * FROM postsale_messages
                           WHERE status='pending' AND (kind <> 'dispatch' OR created_at <= ?)
                           ORDER BY id LIMIT ?`).all(readyAfter, max);
  let drafted = 0, sent = 0, failed = 0, held = 0;
  for (const m of pend) {
    try {
      // A buyer who has already come back to us, or who has a case open, is in a conversation. Do not
      // drop a cheerful "did it arrive?" into the middle of that.
      if (m.kind === 'delivered' && !deliveredIsWelcome(db, m.order_id)) {
        setMsg(db, m.id, { status: 'skipped', error: 'buyer already in contact or a case is open' });
        held++; continue;
      }
      const r = await draftAndRoute(env, db, m, cfg);
      if (!r.ok) failed++; else if (r.status === 'sent') sent++; else drafted++;
    } catch (e) { failed++; console.warn('[postsale] draft failed', m.order_id, e?.message || e); setMsg(db, m.id, { status: 'failed', error: String(e?.message || e) }); }
  }
  return { considered: pend.length, drafted, sent, failed, held };
}

// Guard for the delivered follow-up only. `cases` is populated by a later phase, so the query is
// defensive: an absent table must not stop the message, it just means we know of no case.
function deliveredIsWelcome(db, orderId) {
  const replied = db.prepare(`SELECT 1 FROM postsale_messages WHERE order_id=? AND reply_detected_at IS NOT NULL`).get(orderId);
  if (replied) return false;
  try {
    const c = db.prepare(`SELECT 1 FROM cases WHERE order_id=? AND open_close='open'`).get(orderId);
    if (c) return false;
  } catch { /* no cases table yet */ }
  return true;
}

// The daily digest's two bulk buttons.
//
// "Mark all picked" is local bookkeeping, so it just happens. "Mark all shipped" writes to eBay once
// per order and cannot be undone from a phone, so it asks first — a fat-fingered tap on a notification
// should not dispatch fourteen orders.
async function onDigestAction(env, db, cq, cfg, action, digestId, who) {
  const answer = (text, showAlert) => answerCallbackQuery(env, { id: cq.id, text, showAlert });

  if (action === 'p') {
    const n = pickAllInDigest(db, digestId, who);
    if (!n) return answer('Nothing left to mark picked');
    await answer(`${n} marked picked`);
    return editDigestMessage(env, db, digestId, 'pull', {
      done: { pull: { icon: '✅', status: `All ${n} pulled and packed`, who, detail: 'Still to post — the dispatch list below is the next step.' } },
    });
  }

  if (action === 'dn') {                        // backed out of the confirm
    await answer('Cancelled');
    return editDigestMessage(env, db, digestId, 'dispatch');
  }

  if (action === 'dq') {                        // are you sure?
    const n = digestOrders(db, digestId).length;
    if (!n) return answer('Nothing left to dispatch');
    await answer();
    return editDigestMessage(env, db, digestId, 'dispatch', {
      done: { dispatch: { icon: '⚠️', status: `Dispatch all ${n} on eBay?`, who,
        detail: cfg.dry_run ? 'Dry run is ON, so nothing will actually be sent to eBay.' : 'This marks every order above as posted. It cannot be undone from here.' } },
      buttons: [[{ text: `⚠️ Yes, dispatch ${n}`, data: `psdy:${digestId}` }, { text: 'Cancel', data: `psdn:${digestId}` }]],
    });
  }

  // action === 'dy' — confirmed.
  const orders = digestOrders(db, digestId);
  if (!orders.length) return answer('Nothing left to dispatch');
  // Cheap fast path for the common double-tap; dispatchAllInDigest still holds the real atomic claim.
  if (db.prepare('SELECT 1 FROM pack_digests WHERE id=? AND dispatch_started_at IS NOT NULL').get(digestId)) return answer('Already dispatching, hang on');

  // Answer and show the work BEFORE the eBay round trip: a dozen CompleteSale calls take longer than
  // Telegram will keep a callback spinner alive, and the buttons would sit there looking tappable.
  await answer(cfg.dry_run ? 'Recording…' : 'Dispatching…');
  await editDigestMessage(env, db, digestId, 'dispatch', {
    done: { dispatch: { icon: '⏳', status: `Dispatching ${orders.length}…`, who } }, buttons: [],
  });

  const r = await dispatchAllInDigest(env, db, digestId, cfg, who);
  if (!r.claimed) {
    return editDigestMessage(env, db, digestId, 'dispatch', {
      done: { dispatch: { icon: '⏳', status: 'Already dispatching', who } }, buttons: [],
    });
  }
  const dry = cfg.dry_run ? ' (dry run, nothing sent to eBay)' : '';
  const done = r.failed.length
    // A failed eBay write leaves that order unshipped ON PURPOSE, so it stays in tomorrow's digest to
    // retry. Naming the ids is the difference between a retry and a hunt.
    ? { icon: '⚠️', status: `${r.ok} of ${r.total} dispatched${dry}`, who,
        detail: `${r.failed.length} failed and stayed in the queue: ${r.failed.map((f) => f.order_id).join(', ')}` }
    : { icon: '✅', status: `All ${r.ok} dispatched${dry}`, who };
  return editDigestMessage(env, db, digestId, 'dispatch', { done: { dispatch: done }, buttons: [] });
}

// --- Telegram approve/skip callbacks (shared-poller handler, prefix ps*) ---
async function onPostsaleUpdate(env, db, u) {
  const cq = u.callback_query;
  if (!cq) return;                                   // post-sale only owns its buttons
  const m = (cq.data || '').match(/^ps(a|s):(\d+)$/);
  const dg = (cq.data || '').match(/^ps(p|dq|dy|dn):(\d+)$/);
  if (!m && !dg) return;                             // not ours — another handler will claim it
  const cfg = loadConfig();
  // Authorisation first, before any lookup: an unauthorised tap must not even be able to probe which
  // message ids exist. Empty allowlist denies everyone (see isAllowedUser). This matters more for the
  // digest buttons than anywhere else in the app — one of them dispatches a whole day of orders.
  if (!isAllowedUser(cfg.telegram_allowed_user_ids, cq.from)) {
    console.warn('[postsale/telegram] denied ' + describeUser(cq.from) + ' (id ' + (cq.from && cq.from.id) + ') on ' + cq.data);
    return answerCallbackQuery(env, { id: cq.id, showAlert: true, text: denyCallbackText(cq.from, 'Post-sale') });
  }
  const who = describeUser(cq.from);
  if (dg) return onDigestAction(env, db, cq, cfg, dg[1], +dg[2], who);
  const action = m[1], id = +m[2];
  const msg = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(id);
  if (!msg) return answerCallbackQuery(env, { id: cq.id, text: 'Message not found' });
  if (msg.status !== 'awaiting_approval') return answerCallbackQuery(env, { id: cq.id, text: 'Already ' + msg.status });
  const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(msg.order_id);
  const cardMeta = { buyerUsername: order?.buyer_username, repeat: !!msg.is_repeat_buyer, itemsText: cardsText(db, msg.order_id), subject: msg.subject, body: msg.body, kind: msg.kind };
  const { only } = cardItems(db, msg.order_id);
  const links = postsaleLinkButtons(cfg, only);
  const editThisCard = (text) => editCard(env, {
    chatId: msg.telegram_chat_id, messageId: msg.telegram_message_id,
    text, buttons: links, clearButtons: true, photo: !!(only && only.image_url),
  });
  // Claim the row ATOMICALLY. `WHERE status='awaiting_approval'` means a double tap — or an
  // impatient second tap during the seconds eBay takes — changes 0 rows and is told so, rather than
  // sending the buyer the same message twice. The check above is a fast path; this is the one that
  // holds, because it and the state change are a single statement.
  const claim = (next) => db.prepare("UPDATE postsale_messages SET status=? WHERE id=? AND status='awaiting_approval'").run(next, id).changes > 0;
  const lostRace = async () => {
    const now = db.prepare('SELECT status FROM postsale_messages WHERE id=?').get(id);
    return answerCallbackQuery(env, { id: cq.id, text: 'Already ' + ((now && now.status) || 'decided') });
  };

  if (action === 's') {
    if (!claim('skipped')) return lostRace();
    setMsg(db, id, { decided_by: who, decided_at: nowSql() });
    await answerCallbackQuery(env, { id: cq.id, text: 'Skipped' });
    return editThisCard(renderApprovalCard(cardMeta, { status: 'skipped', icon: '⏭', who }));
  }

  // Claim before the eBay round trip, and show the work: those seconds are dead time in which the
  // buttons would otherwise sit there looking tappable.
  if (!claim('sending')) return lostRace();
  await answerCallbackQuery(env, { id: cq.id, text: cfg.dry_run ? 'Recording…' : 'Sending…' });
  await editThisCard(renderApprovalCard(cardMeta, { status: 'sending…', icon: '⏳', who }));

  // sendPostsaleMessage sets the final status itself (sent / failed), so it needs the row back in a
  // state it recognises — 'sending' is ours, not part of its state machine.
  setMsg(db, id, { status: 'awaiting_approval' });
  const fresh = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(id);
  const r = await sendPostsaleMessage(env, db, fresh, cfg, { decidedBy: who });
  const status = r.ok ? (cfg.dry_run ? 'approved (dry-run)' : 'sent') : 'send failed';
  await answerCallbackQuery(env, { id: cq.id, text: r.ok ? (cfg.dry_run ? 'Approved — dry-run, nothing sent' : 'Sent to the buyer') : 'Send failed: ' + (r.detail || r.error), showAlert: !r.ok });
  return editThisCard(renderApprovalCard(cardMeta, { status, icon: r.ok ? '✅' : '⚠️', who }));
}

// --- reply detection (message-poll): buyer replied to our sent message -> human handoff ---
let _msgPoll = { last_run: null, next_run_at: null };
async function fireReplyHandoff(env, db, sentMsg, mm) {
  if (!telegramEnabled(env) || !telegramChatConfigured(env)) return;
  const order = db.prepare('SELECT buyer_username FROM orders WHERE order_id=?').get(sentMsg.order_id);
  const cards = cardsText(db, sentMsg.order_id);
  const snippet = (mm.body || '').slice(0, 240);
  const text = `💬 <b>@${escapeHtml(mm.senderId || order?.buyer_username || '')} replied</b>${cards ? ` · re: ${escapeHtml(cards)}` : ''}\n`
    + (snippet ? `<i>“${escapeHtml(snippet)}”</i>\n` : '')
    + `Over to a human in eBay Messages. The assistant won't send anything else on this order.`;
  await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text });
}
export async function maybeHandleReply(env, db, mm) {
  if (!mm.senderId) return false;
  const buyer = db.prepare('SELECT id FROM buyers WHERE ebay_username=?').get(mm.senderId);
  if (!buyer) return false;
  const sent = db.prepare(`SELECT * FROM postsale_messages WHERE buyer_id=? AND status='sent' AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1`).get(buyer.id);
  if (!sent) return false;
  if (mm.creationTime && sent.sent_at && new Date(mm.creationTime) <= new Date(sent.sent_at)) return false;  // reply must post-date our send
  setMsg(db, sent.id, { status: 'replied', reply_detected_at: nowSql() });
  await fireReplyHandoff(env, db, sent, mm);
  return true;
}
export async function pollMemberMessages(env, db, { trigger = 'schedule' } = {}) {
  const started = new Date();
  const cfg = loadConfig();
  if (!cfg.enabled) { _msgPoll.last_run = { at: started.toISOString(), trigger, skipped: 'disabled' }; return { ok: true, skipped: 'disabled' }; }
  try {
    const start = getMeta(db, 'messages_cursor') || new Date(Date.now() - Math.max(1, cfg.lookback_hours) * 3600_000).toISOString();
    const end = new Date().toISOString();
    let page = 1, seen = 0, replies = 0;
    while (page <= MAX_PAGES) {
      const res = await getMemberMessages(env, { mailMessageType: 'AskSellerQuestion', startCreationTime: start, endCreationTime: end, page, entriesPerPage: 100 });
      if (!res.ok) { _msgPoll.last_run = { at: started.toISOString(), trigger, ok: false, ack: res.ack, errors: res.errors }; return { ok: false, ack: res.ack, errors: res.errors }; }
      for (const mm of res.messages) {
        seen++;
        db.prepare(`INSERT INTO member_messages (message_id, message_type, sender_id, ebay_item_id, subject, body, status, creation_time)
                    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET status=excluded.status, seen_at=datetime('now')`)
          .run(mm.messageId || ('mm-' + start + '-' + seen), 'AskSellerQuestion', mm.senderId, mm.itemId, mm.subject, mm.body, mm.status, mm.creationTime);
        try { if (await maybeHandleReply(env, db, mm)) replies++; } catch (e) { console.warn('[postsale] reply handoff failed —', e?.message || e); }
      }
      if (!res.hasMore) break;
      page++;
    }
    setMeta(db, 'messages_cursor', end);
    if (replies) console.log(`[postsale] reply-poll: ${replies} buyer repl${replies === 1 ? 'y' : 'ies'} → human handoff`);
    _msgPoll.last_run = { at: started.toISOString(), finished_at: new Date().toISOString(), trigger, ok: true, seen, replies };
    return { ok: true, seen, replies };
  } catch (e) {
    _msgPoll.last_run = { at: started.toISOString(), trigger, ok: false, error: String(e?.message || e) };
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- the order-poll job ---
let _orderPoll = { last_run: null, next_run_at: null };
let _packDigest = { last_run: null };

export async function pollOrders(env, db, { trigger = 'schedule' } = {}) {
  const started = new Date();
  const cfg = loadConfig();
  if (!cfg.enabled) { const r = { ok: true, skipped: 'disabled' }; _orderPoll.last_run = { ...r, at: started.toISOString(), trigger }; return r; }
  try {
    // eBay's own names for the shipping services on this marketplace, so a packing slip can say
    // "Express Post" rather than "AU_ExpressPost". Self-gated to one call a week and never fatal.
    try { await refreshServiceCatalog(env); } catch { /* prettified codes are a fine fallback */ }
    // cold-start watermark from eBay's clock (not the box) — the hard floor that keeps historical
    // buyers untouched. Its presence also proves the user token authenticates before we ingest.
    let watermark = getMeta(db, 'activation_watermark');
    if (!watermark) {
      // Cold-start watermark from eBay's clock. GeteBayOfficialTime is a trivial call, but if it fails
      // it must NOT block order ingest — fall back to server time (NTP-close to eBay's) and log the raw
      // response so a real failure is diagnosable instead of dead-ending the whole poll.
      const t = await geteBayOfficialTime(env);
      if (t.ok && t.timestamp) {
        watermark = t.timestamp;
      } else {
        watermark = new Date().toISOString();
        console.warn('[postsale] GeteBayOfficialTime failed (http ' + t.httpStatus + ' · ack ' + t.ack + ') — using server time ' + watermark
          + ' for the activation watermark. raw: ' + String(t.xml || '').replace(/\s+/g, ' ').slice(0, 300));
      }
      setMeta(db, 'activation_watermark', watermark);
      console.log('[postsale] activation watermark set to ' + watermark + ' — only orders paid at/after this are ingested');
    }

    const nowIso = new Date().toISOString();
    const fromCandidate = getMeta(db, 'orders_cursor') || new Date(Date.now() - Math.max(1, cfg.lookback_hours) * 3600_000).toISOString();
    let modTimeFrom = maxIso(fromCandidate, watermark);
    const modTimeTo = nowIso;
    if (isoLt(modTimeTo, modTimeFrom)) modTimeFrom = modTimeTo;

    let page = 1, seen = 0, ingested = 0, skippedUnpaid = 0, skippedPreWatermark = 0;
    let refreshed = 0, trackingFound = 0, deliveredFound = 0;
    const newOrders = [], queuedMessages = [];
    const isKnown = db.prepare('SELECT 1 FROM orders WHERE order_id = ?');
    while (page <= MAX_PAGES) {
      const res = await getOrders(env, { modTimeFrom, modTimeTo, page, entriesPerPage: 100, orderStatus: 'Completed' });
      if (!res.ok) return finishPoll(started, trigger, { ok: false, error: 'GetOrders failed', ack: res.ack, errors: res.errors });
      for (const o of res.orders) {
        seen++;
        // An order we already hold gets REFRESHED, and neither the paid gate nor the activation
        // watermark applies to it — those two decide what we adopt, not what we keep current. This is
        // the branch a Seller Hub postage label comes back through: eBay writes the tracking number
        // onto the order and marks it shipped, which bumps its ModTime straight into this window.
        if (isKnown.get(o.orderId)) {
          const r = refreshOrder(db, o, cfg);
          if (r.updated) {
            refreshed++;
            if (r.gotTracking) trackingFound++;
            if (r.gotDelivered) deliveredFound++;
            if (r.queued && r.queued.length) queuedMessages.push(...r.queued);
          }
          continue;
        }
        if (!o.paid) { skippedUnpaid++; continue; }
        if (o.paidTime && isoLt(o.paidTime, watermark)) { skippedPreWatermark++; continue; }
        const r = ingestOrder(db, o, cfg);
        if (r.created) { ingested++; newOrders.push({ o, repeat: r.repeat }); }
        if (cfg.max_per_run && ingested >= cfg.max_per_run) break;
      }
      if (!res.hasMore || (cfg.max_per_run && ingested >= cfg.max_per_run)) break;
      page++;
    }
    setMeta(db, 'orders_cursor', modTimeTo);
    if (trackingFound || deliveredFound) {
      console.log(`[postsale] order-poll: ${trackingFound} tracking number(s) and ${deliveredFound} delivery(ies) pulled back from eBay`);
    }

    // Fire alerts AFTER ingest (network, outside the DB txn). Serialised inside sendMessage.
    for (const { o, repeat } of newOrders) {
      try { await fireSaleAlert(env, db, o, repeat, cfg); } catch (e) { console.warn('[postsale] sale alert failed —', e?.message || e); }
    }
    if (ingested) console.log(`[postsale] order-poll: ${ingested} new paid order(s) ingested (${seen} seen)`);
    // Decrement local stock for every matched paid line not yet applied (idempotent, cross-DB). Runs
    // every poll — a line the tool listed matches by ebay_item_id/SKU and flips the stock to sold.
    let stock = null;
    try { stock = applyStockDecrements(db); } catch (e) { console.warn('[postsale] stock decrement failed —', e?.message || e); }
    // Draft (and, in approve mode, queue for approval; in auto mode, send) the pending backlog.
    // messaging:false runs the fulfilment side (orders + alerts + dashboard) without the LLM drafting.
    const msg = (cfg.messaging === false) ? { skipped: 'messaging_off' } : await processMessages(env, db, cfg);
    return finishPoll(started, trigger, { ok: true, seen, ingested, refreshed, tracking_found: trackingFound,
      delivered_found: deliveredFound, queued_messages: queuedMessages,
      skipped_unpaid: skippedUnpaid, skipped_pre_watermark: skippedPreWatermark, stock, messages: msg,
      window: { from: modTimeFrom, to: modTimeTo } });
  } catch (e) {
    return finishPoll(started, trigger, { ok: false, error: String(e?.message || e), code: e?.code || null });
  }
}
function finishPoll(started, trigger, result) {
  _orderPoll.last_run = { at: started.toISOString(), finished_at: new Date().toISOString(), trigger, ...result };
  return result;
}

// --- one-time historical backfill (fulfilment + CRM data; does NOT message old buyers) ---
// Sweeps CreateTime windows backward (eBay caps a GetOrders window at 90 days) and ingests every PAID
// order with its postsale message pre-set to 'closed' — so the buyer CRM, repeat-buyer history, spend
// totals and order/line-item data all populate, but processMessages (which only picks 'pending') never
// drafts a thank-you for a months-old sale. The activation watermark is left untouched, so it stays the
// boundary for LIVE messaging. Idempotent (ingestOrder ON CONFLICT), fires no Telegram sale alerts.
let _backfill = { last_run: null };
export function getBackfillState() { return _backfill; }
export async function backfillOrders(env, db, { months = 24 } = {}) {
  const started = new Date();
  const cfg = loadConfig();
  const WINDOW_MS = 89 * 24 * 3600_000;   // < eBay's 90-day CreateTime window cap
  // eBay's Trading GetOrders cannot return orders older than 90 days (error 21920384), so cap the
  // sweep there no matter what `months` requests — older windows would only error out.
  const requestedFloorMs = Date.now() - Math.max(1, months) * 30 * 24 * 3600_000;
  const floorMs = Math.max(requestedFloorMs, Date.now() - 89 * 24 * 3600_000);
  let toMs = Date.now(), ingested = 0, seen = 0, windows = 0, emptyStreak = 0, hitLimit = false;
  try {
    while (toMs > floorMs && emptyStreak < 2) {
      const fromMs = Math.max(floorMs, toMs - WINDOW_MS);
      const createTimeFrom = new Date(fromMs).toISOString();
      const createTimeTo = new Date(toMs).toISOString();
      let page = 1, windowIngested = 0;
      while (page <= 100) {
        const res = await getOrders(env, { createTimeFrom, createTimeTo, page, entriesPerPage: 100, orderStatus: 'Completed' });
        if (!res.ok) {
          // "older than 90 days" is the expected end of retrievable history — stop cleanly with what we have.
          if ((res.errors || []).some((e) => e.code === '21920384' || /90 days/i.test(e.longMessage || ''))) { hitLimit = true; break; }
          _backfill.last_run = { at: started.toISOString(), ok: false, error: 'GetOrders failed', ack: res.ack, errors: res.errors, ingested, seen };
          return _backfill.last_run;
        }
        for (const o of res.orders) {
          seen++;
          if (!o.paid) continue;
          const r = ingestOrder(db, o, cfg, { messageStatus: 'closed' });
          if (r.created) { ingested++; windowIngested++; }
        }
        if (!res.hasMore) break;
        page++;
      }
      if (hitLimit) break;
      windows++;
      emptyStreak = windowIngested === 0 ? emptyStreak + 1 : 0;
      toMs = fromMs;
    }
    _backfill.last_run = { at: started.toISOString(), finished_at: new Date().toISOString(), ok: true, ingested, seen, windows, note: 'eBay Trading GetOrders serves at most the last 90 days' };
    console.log(`[postsale] backfill: ${ingested} historical order(s) ingested (${seen} seen, ${windows} windows) — messages closed · capped at eBay's 90-day GetOrders limit`);
    return _backfill.last_run;
  } catch (e) {
    _backfill.last_run = { at: started.toISOString(), ok: false, error: String(e?.message || e), ingested, seen };
    return _backfill.last_run;
  }
}

// --- daily "to pack" digest ---
// Local calendar date (config timezone) so "once per day past digest_hour" is stable across restarts.
function localDateHour(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) };
}
/**
 * Dispatch ONE order: mark it shipped on eBay via CompleteSale, then locally.
 *
 * The one place an order gets closed out by hand, shared by POST /orders/:id/shipped and the daily
 * digest's bulk button, because two copies of this would eventually disagree about the thing that
 * matters: if the eBay write FAILS we deliberately do not flip local state, so the order stays in the
 * queue to retry rather than vanishing while eBay still shows it awaiting postage.
 *
 * Untracked letters (most card orders) pass no tracking, which is what CompleteSale wants.
 */
export async function dispatchOrder(env, db, id, cfg = DEFAULT_CONFIG, { dispatch: doEbay = true, tracking, carrier } = {}) {
  // eBay already dispatched this one itself when the postage label was bought, so there is nothing to
  // tell it. All that is left is our side: record that the parcel has actually gone, which is what
  // takes it out of the pack queue.
  const prev = db.prepare('SELECT shipped_status, label_bought_at, picked_at FROM orders WHERE order_id=?').get(id);
  if (prev && prev.label_bought_at && prev.shipped_status === 'shipped') {
    if (!prev.picked_at) db.prepare('UPDATE orders SET picked_at=? WHERE order_id=?').run(nowSql(), id);
    return { ok: true, alreadyShipped: true, dispatched: false, dry_run: false, ebay: null };
  }
  let ebay = null;
  if (doEbay && cfg.dry_run) {
    ebay = { ok: true, dry_run: true };
  } else if (doEbay) {
    try {
      const r = await completeSale(env, { orderId: id, shipped: true, tracking: tracking || undefined, carrier: carrier || undefined });
      ebay = { ok: r.ok, ack: r.ack, errors: r.errors };
    } catch (e) { ebay = { ok: false, error: String(e?.message || e) }; }
  }
  const flip = !doEbay || !ebay || ebay.ok !== false;
  if (flip) {
    // dispatch_source records who closed it out, so a later poll that finds eBay's own tracking
    // doesn't overwrite a hand dispatch as if eBay had done it (refreshOrder only claims 'ebay'
    // when nothing has claimed it yet).
    db.prepare(`UPDATE orders SET shipped_status='shipped', shipped_time=COALESCE(shipped_time, datetime('now')),
      tracking_number=COALESCE(?, tracking_number), carrier=COALESCE(?, carrier),
      tracking_seen_at=CASE WHEN ? IS NOT NULL AND tracking_seen_at IS NULL THEN datetime('now') ELSE tracking_seen_at END,
      dispatch_source=COALESCE(dispatch_source, 'manual') WHERE order_id=?`)
      .run(tracking || null, carrier || null, tracking || null, id);
    // A tracking number entered here is just as real as one eBay wrote, so it earns the same
    // dispatch note to the buyer.
    if (tracking && cfg.messaging !== false && (cfg.postage || {}).dispatch_message?.enabled) {
      try { enqueueMessage(db, id, 'dispatch'); } catch { /* the dispatch itself already succeeded */ }
    }
  }
  return { ok: flip, dispatched: doEbay && !cfg.dry_run && !!(ebay && ebay.ok), dry_run: !!(doEbay && cfg.dry_run), ebay };
}

// The orders ONE SENT DIGEST listed, with line items + locations resolved.
//
// Membership is frozen in pack_digest_orders when the message is sent, and the buttons carry that
// digest's id. Nothing here is re-derived from "what is unshipped now": someone tapping "mark all
// shipped" three hours later must act on the orders their message named, and only those. Two orders
// that landed since are two orders nobody has looked at, and a second digest sent the same day (the
// DIAG trigger can do that) gets its own row, so the older message keeps acting on its own list.
//
// openOnly drops anything already dealt with since, so a re-tap is a no-op rather than a repeat.
export function digestOrders(db, digestId, { openOnly = true, lookup } = {}) {
  const rows = db.prepare(`SELECT o.* FROM orders o
                           JOIN pack_digest_orders d ON d.order_id = o.order_id
                           WHERE d.digest_id = ? ${openOnly ? 'AND ' + IN_QUEUE_SQL : ''}
                           ORDER BY o.paid_time ASC`).all(digestId);
  if (!rows.length) return [];
  const liStmt = db.prepare('SELECT * FROM order_line_items WHERE order_id=?');
  const orders = rows.map((r) => ({ ...r, items: liStmt.all(r.order_id) }));
  attachLocations(db, orders, lookup || buildInventoryLookup());
  attachPostage(orders, loadConfig());
  attachFulfilment(orders);
  return orders;
}

// Freeze one digest's membership. Called BEFORE either message is sent, so the set the buttons act on
// is recorded before anyone can possibly tap them — a set decided at tap time would be whatever is
// unshipped by then, not the orders the reader is looking at.
export function createDigest(db, date, orderIds) {
  let id;
  db.exec('BEGIN');
  try {
    id = db.prepare('INSERT INTO pack_digests (digest_date) VALUES (?)').run(date).lastInsertRowid;
    const member = db.prepare('INSERT INTO pack_digest_orders (digest_id, order_id) VALUES (?, ?)');
    const stamp = db.prepare('UPDATE orders SET pack_digest_date = ? WHERE order_id = ?');
    for (const oid of orderIds) { member.run(id, oid); stamp.run(date, oid); }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return Number(id);
}

// Both digest messages plus their buttons, rebuilt from current state. Used for the morning send and
// again after every button tap, so what the message says is always what the database says.
export function buildDigestView(db, digestId, { done } = {}) {
  const lookup = buildInventoryLookup();
  const orders = digestOrders(db, digestId, { lookup });
  // Already-pulled orders drop off the PULL list (that work is done) but stay in the dispatch
  // summary, because they still have to be posted. Same rule as the pick sheet's default.
  const pickRows = [];
  for (const o of orders) {
    if (o.picked_at) continue;
    for (const li of o.items) pickRows.push({ order_id: o.order_id, buyer_username: o.buyer_username, title: li.title, sku: li.sku, quantity: li.quantity, ebay_item_id: li.ebay_item_id, location: li.location });
  }
  const ps = buildPickSheet(pickRows, (lookup && lookup.locSort) || new Map());
  const toPick = orders.filter((o) => !o.picked_at).length;
  return {
    orders, toPick, toShip: orders.length,
    pullText: renderPullList(ps.groups, { orderCount: orders.length, itemCount: ps.rows.length, unitCount: ps.unit_count }, done && done.pull),
    dispatchText: renderDispatchSummary(orders, done && done.dispatch),
    // Local-only and reversible from the dashboard, so one tap is enough.
    pullButtons: toPick ? [[{ text: `✅ Mark all ${toPick} picked`, data: `psp:${digestId}` }]] : [],
    // A real eBay write per order, so this one asks first (see onPostsaleUpdate).
    dispatchButtons: orders.length ? [[{ text: `🚚 Mark all ${orders.length} shipped`, data: `psdq:${digestId}` }]] : [],
  };
}

export async function runPackDigest(env, db, { force = false } = {}) {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.alerts) return { skipped: 'disabled' };
  if (!telegramEnabled(env) || !telegramChatConfigured(env)) return { skipped: 'no_telegram' };
  const { date, hour } = localDateHour(cfg.timezone);
  if (!force) {
    if (hour < (cfg.digest_hour ?? 9)) return { skipped: 'before_digest_hour' };
    if (getMeta(db, 'last_pack_digest_date') === date) return { skipped: 'already_sent_today' };
  }
  const ids = db.prepare(`SELECT order_id FROM orders WHERE ${IN_QUEUE_SQL} ORDER BY paid_time ASC`).all().map((r) => r.order_id);
  if (!ids.length) { setMeta(db, 'last_pack_digest_date', date); return { ok: true, count: 0 }; }

  const digestId = createDigest(db, date, ids);

  // Two messages, because this is two jobs, and now two buttons for the same reason. The PULL LIST
  // runs through exactly the same pipeline as GET /picksheet — buildInventoryLookup →
  // attachLocations → buildPickSheet — so the phone walks the shelf in the same order as the printed
  // sheet. Inventing a second ordering here would be a way to pull the wrong card confidently.
  const view = buildDigestView(db, digestId);
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();

  const r = await sendMessage(env, { chatId, text: view.pullText, buttons: view.pullButtons });
  // The summary is worth having on its own, so a failed pull list doesn't suppress it (and vice
  // versa) — but only the first send gates the once-a-day marker.
  const r2 = await sendMessage(env, { chatId, text: view.dispatchText, buttons: view.dispatchButtons });
  // Remember where each message landed so a button tap edits the RIGHT one of the two. A send that
  // came back without a message id just means that message can't be edited later; the action itself
  // still runs, so this must never throw.
  db.prepare('UPDATE pack_digests SET chat_id=?, pull_message_id=?, dispatch_message_id=? WHERE id=?')
    .run(String(chatId), r.ok && r.result ? r.result.message_id : null, r2.ok && r2.result ? r2.result.message_id : null, digestId);
  if (r.ok) setMeta(db, 'last_pack_digest_date', date);
  _packDigest.last_run = { at: new Date().toISOString(), digest_id: digestId, count: view.orders.length, ok: !!r.ok, summary_ok: !!r2.ok };
  return { ok: !!r.ok, digest_id: digestId, count: view.orders.length, lines: view.orders.reduce((n, o) => n + o.items.length, 0) };
}

// --- the daily digest's bulk buttons ---
// Re-render whichever of the two messages this action belongs to, from current state plus a footer.
// Rebuilding beats storing the sent text: after "mark all picked" the pull list legitimately becomes
// "nothing to pull", and a message that still lists the cards would be lying about the shelf.
async function editDigestMessage(env, db, digestId, which, { done, buttons } = {}) {
  const d = db.prepare('SELECT chat_id, pull_message_id, dispatch_message_id FROM pack_digests WHERE id=?').get(digestId);
  const messageId = d && (which === 'pull' ? d.pull_message_id : d.dispatch_message_id);
  if (!d || !d.chat_id || !messageId) return { ok: false, skipped: 'no_message' };
  const view = buildDigestView(db, digestId, { done });
  return editMessageText(env, {
    chatId: d.chat_id, messageId,
    text: which === 'pull' ? view.pullText : view.dispatchText,
    buttons: buttons !== undefined ? buttons : (which === 'pull' ? view.pullButtons : view.dispatchButtons),
    clearButtons: true,
  });
}

// Mark every order ON THIS DIGEST as pulled + packed. Local only: nothing is written to eBay and the
// orders stay in the queue to dispatch, they just drop off the pull list.
//
// The `IN (…)` is over this digest's frozen membership, so an order that arrived after the message
// went out is untouched no matter how much later the button is tapped.
export function pickAllInDigest(db, digestId, who) {
  const r = db.prepare(`UPDATE orders SET picked_at = ?
                        WHERE order_id IN (SELECT order_id FROM pack_digest_orders WHERE digest_id = ?)
                        AND ${NEEDS_PACKING_SQL}`).run(nowSql(), digestId);
  if (r.changes) db.prepare('UPDATE pack_digests SET picked_at=?, picked_by=? WHERE id=?').run(nowSql(), who, digestId);
  console.log(`[postsale/digest] ${r.changes} order(s) marked picked by ${who} (digest ${digestId})`);
  return r.changes || 0;
}

// Mark every order on a digest dispatched, one CompleteSale at a time.
//
// Sequential on purpose: eBay is happier, and a partial failure has to leave the failed orders in the
// queue rather than half-hiding them. The claim is a single conditional UPDATE on the digest row, so
// two people tapping at once cannot both start dispatching the same list.
export async function dispatchAllInDigest(env, db, digestId, cfg, who) {
  const claimed = db.prepare('UPDATE pack_digests SET dispatch_started_at=? WHERE id=? AND dispatch_started_at IS NULL')
    .run(nowSql(), digestId).changes > 0;
  if (!claimed) return { claimed: false };
  try {
    const orders = digestOrders(db, digestId);
    const failed = [];
    let ok = 0;
    for (const o of orders) {
      const r = await dispatchOrder(env, db, o.order_id, cfg);
      if (r.ok) ok++; else failed.push({ order_id: o.order_id, ebay: r.ebay });
    }
    if (ok) db.prepare('UPDATE pack_digests SET dispatched_at=?, dispatched_by=? WHERE id=?').run(nowSql(), who, digestId);
    console.log(`[postsale/digest] dispatched ${ok}/${orders.length} by ${who} (digest ${digestId})${failed.length ? ' — ' + failed.length + ' failed' : ''}`);
    return { claimed: true, total: orders.length, ok, failed };
  } finally {
    // Always release, so a crash or a partial failure doesn't wedge the button forever.
    db.prepare('UPDATE pack_digests SET dispatch_started_at=NULL WHERE id=?').run(digestId);
  }
}

// --- state (surfaced at /api/status jobs) ---
export function getPostsaleState() {
  return {
    order_poll: { running: !!globalThis.__postsaleOrderTimer, enabled: loadConfig().enabled !== false, next_run_at: _orderPoll.next_run_at, last_run: _orderPoll.last_run },
    reply_poll: { running: !!globalThis.__postsaleMsgTimer, next_run_at: _msgPoll.next_run_at, last_run: _msgPoll.last_run },
    pack_digest: { running: !!globalThis.__postsalePackTimer, last_run: _packDigest.last_run },
  };
}

// --- scheduler (stop-then-start singleton, HMR-safe — mirrors lib/collector.mjs / lib/refresh.mjs) ---
// env + db are remembered so a config-restart from the settings registry (which has no env in
// scope, mirroring startDataRefresh) can re-arm the timers with the original credentials/DB.
let _env = {};
let _db = null;
export function startPostsaleJobs(env, db) {
  stopPostsaleJobs();
  if (env && typeof env === 'object') _env = env;
  if (db) _db = db;
  ensureConfigSeeded();
  const cfg = loadConfig();
  if (!cfg.enabled) { console.log('[postsale] disabled (data/postsale.config.json)'); return; }
  const orderMs = Math.max(1, cfg.poll_interval_min) * 60_000;
  const tick = () => { _orderPoll.next_run_at = new Date(Date.now() + orderMs).toISOString(); return pollOrders(_env, _db, { trigger: 'schedule' }).catch((e) => console.error('[postsale]', e?.message || e)); };
  const boot = setTimeout(tick, 45_000); if (boot.unref) boot.unref();
  const timer = setInterval(tick, orderMs); if (timer.unref) timer.unref();
  globalThis.__postsaleOrderTimer = timer;
  globalThis.__postsaleOrderBoot = boot;
  _orderPoll.next_run_at = new Date(Date.now() + orderMs).toISOString();
  // reply-poll: detect buyer replies to our sent messages → human handoff.
  const msgMs = Math.max(1, cfg.reply_poll_interval_min) * 60_000;
  const msgTick = () => { _msgPoll.next_run_at = new Date(Date.now() + msgMs).toISOString(); return pollMemberMessages(_env, _db, { trigger: 'schedule' }).catch((e) => console.error('[postsale/reply]', e?.message || e)); };
  const msgBoot = setTimeout(msgTick, 75_000); if (msgBoot.unref) msgBoot.unref();
  const msgTimer = setInterval(msgTick, msgMs); if (msgTimer.unref) msgTimer.unref();
  globalThis.__postsaleMsgTimer = msgTimer;
  globalThis.__postsaleMsgBoot = msgBoot;
  _msgPoll.next_run_at = new Date(Date.now() + msgMs).toISOString();
  // pack digest: hourly tick, self-gated to once/day past digest_hour.
  const packTimer = setInterval(() => runPackDigest(_env, _db).catch((e) => console.error('[postsale/digest]', e?.message || e)), 3600_000);
  if (packTimer.unref) packTimer.unref();
  globalThis.__postsalePackTimer = packTimer;
  console.log(`[postsale] order-poll ${cfg.poll_interval_min}m · reply-poll ${cfg.reply_poll_interval_min}m · mode ${cfg.mode}${cfg.dry_run ? ' · DRY-RUN' : ''} · alerts ${cfg.alerts ? 'on' : 'off'}`);
}
export function stopPostsaleJobs() {
  for (const k of ['__postsaleOrderBoot', '__postsaleMsgBoot']) { if (globalThis[k]) { clearTimeout(globalThis[k]); globalThis[k] = null; } }
  for (const k of ['__postsaleOrderTimer', '__postsaleMsgTimer', '__postsalePackTimer']) { if (globalThis[k]) { clearInterval(globalThis[k]); globalThis[k] = null; } }
  _orderPoll.next_run_at = null;
  _msgPoll.next_run_at = null;
}

// --- router ---
function makeRouter({ env, db }) {
  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type,authorization');
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';

      // GET /config — non-secret config + connection state (never returns tokens/keys).
      if (p === '/config' && method === 'GET') {
        const cfg = loadConfig();
        return send(res, 200, {
          config: cfg,
          telegram: { enabled: telegramEnabled(env), chat_configured: telegramChatConfigured(env) },
          ebay_oauth: (() => { try { return oauthStatus(env); } catch (e) { return { error: String(e?.message || e) }; } })(),
          activation_watermark: getMeta(db, 'activation_watermark'),
          orders_cursor: getMeta(db, 'orders_cursor'),
          state: getPostsaleState(),
          // Every shipping service this store has actually sold under, with how each currently
          // classifies. Derived on read rather than written into the config file by the poll: nothing
          // races a settings save, and the list is always current. This is what you look at when a
          // service is being read as the wrong tier and you want to add an override for it.
          observed_services: observedServices(db, cfg),
        });
      }

      // GET /orders?limit=&status=&picked= — recent ingested orders + line items, each with a resolved
      // storage location (from the tracker inventory). status=unshipped|shipped filters the queue;
      // picked=0|1 filters on the pull state (0 = still to pull, 1 = already pulled + packed).
      if (p === '/orders' && method === 'GET') {
        const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '100', 10) || 100);
        const status = url.searchParams.get('status');
        const picked = url.searchParams.get('picked');
        const conds = [];
        // "unshipped" is the PACK QUEUE, not eBay's flag: an order eBay marked sent because a label
        // was bought still belongs here until someone has actually pulled and packed it.
        if (status === 'unshipped') conds.push(IN_QUEUE_SQL);
        else if (status === 'shipped') conds.push('NOT ' + IN_QUEUE_SQL);
        if (picked === '0') conds.push('picked_at IS NULL');
        else if (picked === '1') conds.push('picked_at IS NOT NULL');
        const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
        const orders = db.prepare(`SELECT * FROM orders ${where} ORDER BY COALESCE(paid_time, created_time, ingested_at) DESC LIMIT ?`).all(limit);
        const ids = orders.map((o) => o.order_id);
        const itemsBy = {};
        if (ids.length) {
          const ph = ids.map(() => '?').join(',');
          for (const it of db.prepare(`SELECT * FROM order_line_items WHERE order_id IN (${ph})`).all(...ids)) {
            (itemsBy[it.order_id] ||= []).push(it);
          }
        }
        const withItems = orders.map((o) => ({ ...o, items: itemsBy[o.order_id] || [] }));
        attachLocations(db, withItems);
        attachPostage(withItems, loadConfig());
        attachFulfilment(withItems);
        // Resolve listing thumbnails for the actionable pack queue only (bounds the GetItem calls);
        // the "all" view shows whatever's already cached. Cheap after the first few loads fill the cache.
        if (status === 'unshipped') { try { await resolveImages(env, db, withItems, 12); } catch { /* non-fatal */ } }
        return send(res, 200, { orders: withItems });
      }

      // GET /picksheet?status= — one consolidated pull list across every unshipped order's line items,
      // each tagged with its stored location, SORTED by location (sealed_locations.sort_order first,
      // then alpha; unmatched → "Unsorted"). `groups` is the same rows pre-grouped for the printout.
      if (p === '/picksheet' && method === 'GET') {
        // ids=<order_id,order_id,…> picks a hand-selected subset (dashboard tick boxes) and is taken at
        // face value — ticking an already-picked order is a deliberate re-print. Without ids we take the
        // whole status set (unshipped by default) MINUS anything already picked, so a weekend's pulled +
        // packed orders drop off the pull list (?include_picked=1 keeps them). Either way the list is
        // grouped + ordered by BOX.
        const idsParam = (url.searchParams.get('ids') || '').trim();
        let orders;
        if (idsParam) {
          const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
          if (!ids.length) return send(res, 200, { rows: [], groups: [], order_count: 0, item_count: 0, unit_count: 0 });
          const ph = ids.map(() => '?').join(',');
          orders = db.prepare(`SELECT * FROM orders WHERE order_id IN (${ph}) ORDER BY COALESCE(paid_time, created_time) ASC`).all(...ids);
        } else {
          const status = url.searchParams.get('status') || 'unshipped';
          const conds = [];
          if (status !== 'all') conds.push(IN_QUEUE_SQL);
          if (url.searchParams.get('include_picked') !== '1') conds.push('picked_at IS NULL');
          const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
          orders = db.prepare(`SELECT * FROM orders ${where} ORDER BY COALESCE(paid_time, created_time) ASC`).all();
        }
        attachPostage(orders, loadConfig());
        attachFulfilment(orders);
        const lookup = buildInventoryLookup();
        const rows = [];
        for (const o of orders) {
          const items = db.prepare('SELECT * FROM order_line_items WHERE order_id=?').all(o.order_id);
          attachLocations(db, [{ order_id: o.order_id, items }], lookup);
          for (const li of items) {
            rows.push({
              order_id: o.order_id, buyer_username: o.buyer_username, sales_record_number: o.sales_record_number,
              title: li.title, sku: li.sku, quantity: li.quantity, ebay_item_id: li.ebay_item_id, image_url: li.image_url || null,
              // inventory location if matched; else fall back to the SKU-prefix bin so the pull list still groups.
              location: li.location || skuGroupLabel(li.sku), matched_kind: li.matched_kind || null,
              // Carried per LINE because one order's cards scatter across boxes: the picker standing at
              // a shelf needs to know this card belongs to an Express order without cross-referencing.
              postage_tier: o.postage.tier, postage_upgrade: o.postage.upgrade,
            });
          }
        }
        const ps = buildPickSheet(rows, lookup?.locSort || new Map());
        // Per-ORDER summary of everything that isn't a plain letter — the banner at the top of the
        // printed sheet, read before anyone walks off to the shelves.
        const upgrades = orders.filter((o) => o.postage.upgrade).map((o) => ({
          order_id: o.order_id, buyer_username: o.buyer_username, sales_record_number: o.sales_record_number,
          tier: o.postage.tier, label: o.postage.label, code: o.postage.code,
          paid_cents: o.postage.paid_cents, currency: o.currency || 'AUD',
          tracked: o.postage.tracked, tracking: o.postage.tracking, handle_by: o.postage.handle_by,
        }));
        return send(res, 200, { rows: ps.rows, groups: ps.groups, order_count: orders.length,
          item_count: ps.rows.length, unit_count: ps.unit_count, upgrades });
      }

      // GET /buyers — CRM list.
      if (p === '/buyers' && method === 'GET') {
        const rows = db.prepare(`SELECT * FROM buyers ORDER BY last_seen_at DESC LIMIT 500`).all();
        return send(res, 200, { buyers: rows });
      }
      // GET /buyers/:username — one buyer profile + purchase + message history.
      const buyerM = p.match(/^\/buyers\/(.+)$/);
      if (buyerM && method === 'GET') {
        const username = decodeURIComponent(buyerM[1]);
        const buyer = db.prepare('SELECT * FROM buyers WHERE ebay_username = ?').get(username);
        if (!buyer) return send(res, 404, { error: 'buyer not found' });
        const orders = db.prepare('SELECT * FROM orders WHERE buyer_id = ? ORDER BY COALESCE(paid_time, created_time) DESC').all(buyer.id);
        const messages = db.prepare('SELECT * FROM postsale_messages WHERE buyer_id = ? ORDER BY id DESC').all(buyer.id);
        return send(res, 200, { buyer, orders, messages });
      }

      // GET /messages?status= — message state-machine rows (dashboard feed + audit).
      if (p === '/messages' && method === 'GET') {
        const status = url.searchParams.get('status');
        const rows = status
          ? db.prepare(`SELECT m.*, o.buyer_username, o.total_cents, o.currency FROM postsale_messages m JOIN orders o ON o.order_id = m.order_id WHERE m.status = ? ORDER BY m.id DESC LIMIT 500`).all(status)
          : db.prepare(`SELECT m.*, o.buyer_username, o.total_cents, o.currency FROM postsale_messages m JOIN orders o ON o.order_id = m.order_id ORDER BY m.id DESC LIMIT 500`).all();
        return send(res, 200, { messages: rows });
      }

      // GET /messages/:id — one message + its order/items/buyer (dashboard detail modal).
      const msgGetM = p.match(/^\/messages\/(\d+)$/);
      if (msgGetM && method === 'GET') {
        const msg = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(+msgGetM[1]);
        if (!msg) return send(res, 404, { error: 'message not found' });
        const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(msg.order_id);
        const items = db.prepare('SELECT * FROM order_line_items WHERE order_id=?').all(msg.order_id);
        const buyer = db.prepare('SELECT * FROM buyers WHERE id=?').get(msg.buyer_id);
        return send(res, 200, { message: msg, order, items, buyer, dry_run: loadConfig().dry_run });
      }
      // POST /messages/:id/approve — send now (dry_run gated). decided_by = dashboard.
      const apprM = p.match(/^\/messages\/(\d+)\/approve$/);
      if (apprM && method === 'POST') {
        const msg = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(+apprM[1]);
        if (!msg) return send(res, 404, { error: 'message not found' });
        if (!['awaiting_approval', 'drafted', 'failed'].includes(msg.status)) return send(res, 409, { error: 'cannot send a message that is ' + msg.status });
        const cfg = loadConfig();
        const r = await sendPostsaleMessage(env, db, msg, cfg, { decidedBy: 'dashboard' });
        const fresh = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(msg.id);
        if (r.ok) await stampTelegramCard(env, db, fresh, { status: cfg.dry_run ? 'approved (dry-run)' : 'sent', icon: '✅', who: 'dashboard' });
        return send(res, r.ok ? 200 : 502, { ...r, message: fresh });
      }
      // POST /messages/:id/skip
      const skipM = p.match(/^\/messages\/(\d+)\/skip$/);
      if (skipM && method === 'POST') {
        const msg = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(+skipM[1]);
        if (!msg) return send(res, 404, { error: 'message not found' });
        setMsg(db, msg.id, { status: 'skipped', decided_by: 'dashboard', decided_at: nowSql() });
        const fresh = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(msg.id);
        await stampTelegramCard(env, db, fresh, { status: 'skipped', icon: '⏭', who: 'dashboard' });
        return send(res, 200, { ok: true, message: fresh });
      }
      // POST /messages/:id/edit { subject, body } — human edit; validated + re-scrubbed.
      const editM = p.match(/^\/messages\/(\d+)\/edit$/);
      if (editM && method === 'POST') {
        const msg = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(+editM[1]);
        if (!msg) return send(res, 404, { error: 'message not found' });
        const b = await readJson(req);
        const body = String(b.body || '').trim();
        if (!body) return send(res, 400, { error: 'body is required' });
        if (body.length > 2000) return send(res, 400, { error: 'body exceeds eBay 2000-char limit' });
        const scrub = guardrailScrub(body);
        if (!scrub.clean) return send(res, 400, { error: 'blocked by eBay content policy: ' + scrub.violations.join(', ') });
        setMsg(db, msg.id, { subject: String(b.subject || msg.subject || 'Thanks for your order!').slice(0, 120), body, status: 'awaiting_approval', error: null });
        const fresh = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(msg.id);
        if (fresh.telegram_chat_id && fresh.telegram_message_id) {
          const order = db.prepare('SELECT buyer_username FROM orders WHERE order_id=?').get(fresh.order_id);
          const { only } = cardItems(db, fresh.order_id);
          await editCard(env, { chatId: fresh.telegram_chat_id, messageId: fresh.telegram_message_id, text: renderApprovalCard({ buyerUsername: order?.buyer_username, repeat: !!fresh.is_repeat_buyer, itemsText: cardsText(db, fresh.order_id), subject: fresh.subject, body: fresh.body, dryRun: loadConfig().dry_run, kind: fresh.kind }), buttons: approvalButtons(fresh.id, loadConfig(), only), photo: !!(only && only.image_url) }).catch(() => {});
        }
        return send(res, 200, { ok: true, message: fresh });
      }
      // POST /messages/:id/regenerate — re-run the LLM draft.
      const regenM = p.match(/^\/messages\/(\d+)\/regenerate$/);
      if (regenM && method === 'POST') {
        const r = await redraftMessage(env, db, +regenM[1], loadConfig());
        return send(res, r.ok ? 200 : 502, r);
      }

      // POST /messages/:id/push-card — (re)send this message's Telegram approval card. Otherwise the
      // card is only ever pushed by the draft path, for a message in `pending`, which leaves no way
      // to exercise the Approve/Skip buttons without waiting for a real sale. Ungated like the
      // sibling /approve, /skip and /regenerate actions (and the repricer's /test-alert): it writes
      // only to the store's own Telegram chat and touches nothing buyer-facing.
      const cardM = p.match(/^\/messages\/(\d+)\/push-card$/);
      if (cardM && method === 'POST') {
        const msg = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(+cardM[1]);
        if (!msg) return send(res, 404, { error: 'message not found' });
        // Same actionable set as /approve. Pushing a card for a sent/skipped/replied message would put
        // live-looking buttons on a decision that is already made — they'd answer "Already <status>",
        // so the card is a lie the moment it lands.
        if (!['awaiting_approval', 'drafted', 'failed'].includes(msg.status)) {
          return send(res, 409, { error: 'cannot push a card for a message that is ' + msg.status });
        }
        const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(msg.order_id);
        if (!order) return send(res, 404, { error: 'order not found' });
        const r = await pushApprovalCard(env, db, msg, order, loadConfig());
        return send(res, r.ok ? 200 : 502, { ...r, message: db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(msg.id) });
      }

      // POST /orders/:id/shipped { dispatch?, tracking?, carrier? } — mark packed/shipped locally AND
      // (unless dispatch:false or dry_run) mark dispatched on eBay via CompleteSale. Untracked letters
      // omit tracking. If the eBay write fails we do NOT flip local state (so it stays in the queue to
      // retry) and return 502 with the ack/errors (GR7 — degrade, never hard-fail).
      const shipM = p.match(/^\/orders\/(.+)\/shipped$/);
      if (shipM && method === 'POST') {
        const id = decodeURIComponent(shipM[1]);
        if (!db.prepare('SELECT 1 FROM orders WHERE order_id=?').get(id)) return send(res, 404, { error: 'order not found' });
        const body = await readJson(req);
        const r = await dispatchOrder(env, db, id, loadConfig(), body);
        return send(res, r.ok ? 200 : 502, r);
      }
      // POST /orders/picked { ids:[…] | id, picked } — mark orders pulled off the shelf + packed (or
      // undo it). Purely local bookkeeping: nothing is written to eBay and the order stays in the pack
      // queue awaiting dispatch — it just stops showing up on the pull list (see /picksheet). Built for
      // a weekend of orders packed as they land and posted together on Monday.
      if (p === '/orders/picked' && method === 'POST') {
        const body = await readJson(req);
        const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map((s) => String(s || '').trim()).filter(Boolean);
        if (!ids.length) return send(res, 400, { error: 'ids is required' });
        const picked = body.picked !== false;   // default: mark picked
        const stmt = db.prepare(`UPDATE orders SET picked_at = ? WHERE order_id = ?`);
        const at = picked ? nowSql() : null;
        let changed = 0;
        const missing = [];
        for (const id of ids) {
          const r = stmt.run(at, id);
          if (r.changes) changed += 1; else missing.push(id);
        }
        return send(res, 200, { ok: true, picked, picked_at: at, updated: changed, missing });
      }
      // POST /orders/label-printed { ids:[…] } — bulk form of the per-order route below. A batch of
      // address labels reaches the AUSPRINT as ONE print job over one socket, so it is recorded as one
      // write rather than N round trips. Same shape as /orders/picked above.
      if (p === '/orders/label-printed' && method === 'POST') {
        const body = await readJson(req);
        const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map((s) => String(s || '').trim()).filter(Boolean);
        if (!ids.length) return send(res, 400, { error: 'ids is required' });
        const stmt = db.prepare(`UPDATE orders SET label_status='printed' WHERE order_id = ?`);
        let changed = 0;
        const missing = [];
        for (const id of ids) {
          const r = stmt.run(id);
          if (r.changes) changed += 1; else missing.push(id);
        }
        return send(res, 200, { ok: true, updated: changed, missing });
      }
      // POST /orders/:id/label-printed — record that the address label / packing slip went to the printer.
      const lblM = p.match(/^\/orders\/(.+)\/label-printed$/);
      if (lblM && method === 'POST') {
        const id = decodeURIComponent(lblM[1]);
        const r = db.prepare(`UPDATE orders SET label_status='printed' WHERE order_id = ?`).run(id);
        return send(res, r.changes ? 200 : 404, r.changes ? { ok: true } : { error: 'order not found' });
      }

      // ---- DIAG_TOKEN-gated manual triggers ----
      if (p === '/poll/orders' && method === 'POST') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await pollOrders(env, db, { trigger: 'manual' });
        return send(res, 200, { triggered: 'poll-orders', result });
      }
      // POST /backfill?months= — one-time historical sweep (data only; historical messages stay closed).
      if (p === '/backfill' && method === 'POST') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const months = Math.min(60, Math.max(1, parseInt(url.searchParams.get('months') || '24', 10) || 24));
        const result = await backfillOrders(env, db, { months });
        return send(res, 200, { triggered: 'backfill', result });
      }
      if (p === '/digest/pack' && method === 'POST') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await runPackDigest(env, db, { force: true });
        return send(res, 200, { triggered: 'pack-digest', result });
      }
      if (p === '/poll/messages' && method === 'POST') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await pollMemberMessages(env, db, { trigger: 'manual' });
        return send(res, 200, { triggered: 'poll-messages', result });
      }
      if (p === '/process' && method === 'POST') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await processMessages(env, db, loadConfig());
        return send(res, 200, { triggered: 'process-messages', result });
      }

      return send(res, 404, { error: 'unknown postsale route', path: p, method });
    } catch (e) {
      console.error('[api/postsale] error:', e?.message || e);
      return send(res, 500, { error: 'postsale error', detail: String(e?.message || e) });
    }
  };
}

export function postsalePlugin(env) {
  return {
    name: 'postsale',
    configureServer(server) {
      const db = openPostsaleDb();
      loadServiceCatalog();   // cached eBay shipping-service names; absent on a box with no token
      server.middlewares.use('/api/postsale', makeRouter({ env, db }));
      startPostsaleJobs(env, db);
      // Join the shared Telegram long-poll loop (owned by whichever of repricer/postsale starts it
      // first — singleton) with our own Approve/Skip handler. registerUpdateHandler is independent of
      // who owns the loop, so our taps work regardless. getOffset/setOffset are used only if we start it.
      registerUpdateHandler('postsale', (u) => onPostsaleUpdate(env, db, u).catch((e) => console.warn('[postsale/telegram]', e?.message || e)));
      if (telegramEnabled(env)) {
        startTelegramPoller(env, {
          getOffset: () => { const v = getMeta(db, 'tg_offset'); return v ? +v : undefined; },
          setOffset: (o) => setMeta(db, 'tg_offset', o),
          log: (m) => console.log('[postsale/telegram]', m),
        });
      }
      console.log('[postsale] DB ' + POSTSALE_DB_PATH + ' · API /api/postsale · '
        + (loadConfig().enabled ? 'ENABLED' : 'disabled (data/postsale.config.json)'));
    },
  };
}
