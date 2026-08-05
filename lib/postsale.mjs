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
  pinChatMessage, unpinChatMessage,
} from './telegram.mjs';
import { itemUrl, searchUrl, compsQuery } from './ebay-links.mjs';
import { shortTitle, renderPullList, renderDispatchSummary, renderSaleAlert, renderHoldAlert } from './telegram-cards.mjs';
import { getOrders, geteBayOfficialTime, sendBuyerMessage, getMemberMessages, completeSale, getItem } from './ebay-trading.mjs';
import { oauthStatus } from './ebay-oauth.mjs';
import { openDb } from './db.mjs';
import { enqueueRelistWatch } from './relist-watch.mjs';
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
  // --- cancellations + payment holds ---
  // Named for the shared concept, not for cancellations: the same card and the same switch also cover a
  // payment that failed after eBay called the order paid. Calling it cancel_alerts would mean turning
  // off cancellation alerts silently turned off payment ones too, with nothing saying so.
  hold_alerts: true,          // the loud pinned Telegram card when an order is cancelled or held
  hold_pin: true,             // pin it (needs can_pin_messages in a group; degrades silently without)
  cancel_restock: true,       // put the stock back on a CONFIRMED cancellation — genuinely cancel-only
  // How often the BACKGROUND poll re-reads the orders we still consider open, BY ID. The ModTime
  // cursor is a window and a window can be missed; this is the backstop that means a state change
  // cannot be lost forever. 0 turns the timer off — the dashboard's ↻ sweeps regardless, because a
  // person pressing it is asking to be told what is actually true.
  sweep_interval_min: 60,
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

// Blank the buyer out of a raw GetOrders response, keeping every TAG so the shape survives.
//
// This exists for one job: the /diag/order-xml route below hands a real eBay response to a human, who
// pastes it into the test suite as a fixture. A parser for an order state we have never actually seen
// has to be written against real bytes — eBay's documented field list and eBay's payload disagree often
// enough that guessing is how you ship a regex matching nothing. But that response carries the buyer's
// name, street and phone, and a test fixture is tracked in git forever.
//
// Contents are replaced, not elements removed: the parser is being tested on WHERE things sit, so an
// empty <Street1></Street1> is the useful redaction and a deleted one is a different document. The
// whole <Buyer> block goes because it nests fields (Email, RegistrationAddress) worth not enumerating.
export function redactOrderXml(xml) {
  if (!xml) return '';
  const FIELDS = ['Name', 'Street1', 'Street2', 'Phone', 'Email', 'PostalCode', 'BuyerUserID',
    'BuyerEmail', 'ExternalTransactionID', 'CityName'];
  let out = String(xml).replace(/<Buyer>[\s\S]*?<\/Buyer>/g, '<Buyer><!-- redacted --></Buyer>');
  for (const f of FIELDS) {
    // Self-closing and already-empty elements are left alone; only a filled one is emptied.
    out = out.replace(new RegExp('(<' + f + '(?:\\s[^>]*)?>)[\\s\\S]*?(</' + f + '>)', 'g'), '$1$2');
  }
  return out;
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
  // Cancelled orders are excluded. They were invisible here while the poll filtered them out at the
  // request; now that it doesn't, a cancelled order would inflate lifetime spend and could flip a
  // first-time buyer to "repeat" — and that flag drives both the ⭐ on the sale alert and the context
  // the model writes from.
  const agg = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(total_cents),0) s FROM orders
                          WHERE buyer_id = ? AND ${NOT_CANCELLED_SQL}`).get(buyerId);
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
  // Named columns, not SELECT * — inventory_items is ~45 wide (notes, subgrades JSON, image_url) and
  // the snapshot below reads seven of them, once per sold line on every poll.
  const inv = tdb.prepare(`SELECT id, quantity, status, channel_status, sold_at, sale_price_cents,
                           ebay_listing_id, location FROM inventory_items WHERE id = ?`).get(itemId);
  if (!inv) return { ok: false, reason: 'gone' };
  if (inv.status === 'sold') return { ok: true, sold: true, already: true, newQty: 0, effect: null };
  // Snapshot BEFORE the write. This is the only record of what the row looked like, and a cancellation
  // months later has nothing else to put it back from. See reverseStockForOrder.
  const before = { quantity: inv.quantity ?? 1, status: inv.status, channel_status: inv.channel_status,
    sold_at: inv.sold_at ?? null, sale_price_cents: inv.sale_price_cents ?? null,
    ebay_listing_id: inv.ebay_listing_id ?? null, location: inv.location ?? null };
  const qty = qtySold || 1;
  const newQty = Math.max(0, before.quantity - qty);
  const mkEffect = (sold) => ({ v: 1, kind: 'inventory', item_id: itemId, qty, at: new Date().toISOString(),
    before, after: { quantity: newQty, status: sold ? 'sold' : before.status, sold } });
  if (newQty <= 0) {
    tdb.prepare(`UPDATE inventory_items SET quantity = 0, status = 'sold', channel_status = 'ended',
                 sold_at = COALESCE(sold_at, datetime('now')), sale_price_cents = COALESCE(sale_price_cents, ?),
                 updated_at = datetime('now') WHERE id = ?`).run(saleUnitCents != null ? Math.round(saleUnitCents * qty) : null, itemId);
    return { ok: true, sold: true, newQty: 0, effect: mkEffect(true) };
  }
  tdb.prepare(`UPDATE inventory_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(newQty, itemId);
  return { ok: true, sold: false, newQty, effect: mkEffect(false) };
}
// Decrement a sealed item through its placements (never write sealed_items.quantity directly when
// placements exist — the multi-location mirror rule); falls back to the scalar quantity when it has none.
export function decrementSealedItem(tdb, itemId, qtySold) {
  const item = tdb.prepare(`SELECT id, quantity, status, channel_status, location, ebay_listing_id
                            FROM sealed_items WHERE id = ?`).get(itemId);
  if (!item) return { ok: false, reason: 'gone' };
  const qty = qtySold || 1;
  let remaining = qty;
  const before = { quantity: item.quantity ?? 1, status: item.status, channel_status: item.channel_status,
    location: item.location ?? null, ebay_listing_id: item.ebay_listing_id ?? null };
  const mkEffect = (total, placements) => ({ v: 1, kind: 'sealed', item_id: itemId, qty,
    at: new Date().toISOString(), before, placements,
    after: { quantity: total, status: total <= 0 ? 'sold' : item.status, sold: total <= 0 } });
  const places = tdb.prepare('SELECT id, location, quantity FROM sealed_placements WHERE item_id = ? ORDER BY quantity DESC, id').all(itemId);
  if (places.length) {
    const touched = [];
    for (const pl of places) {
      if (remaining <= 0) break;
      const take = Math.min(pl.quantity, remaining); remaining -= take;
      const nq = pl.quantity - take;
      // Record the LOCATION as well as the row id. The row is DELETED when it empties, so the id dies
      // with it and the location is the only thing left that can put those units back on the right
      // shelf. Reversing a sealed decrement is impossible without this line.
      touched.push({ id: pl.id, location: pl.location, from: pl.quantity, took: take, to: nq, deleted: nq <= 0 });
      if (nq <= 0) tdb.prepare('DELETE FROM sealed_placements WHERE id = ?').run(pl.id);
      else tdb.prepare('UPDATE sealed_placements SET quantity = ? WHERE id = ?').run(nq, pl.id);
    }
    const total = tdb.prepare('SELECT COALESCE(SUM(quantity),0) s FROM sealed_placements WHERE item_id = ?').get(itemId).s;
    const firstLoc = (tdb.prepare('SELECT location FROM sealed_placements WHERE item_id = ? ORDER BY id LIMIT 1').get(itemId) || {}).location || null;
    const sold = total <= 0;
    tdb.prepare(`UPDATE sealed_items SET quantity = ?, location = ?, status = ?, channel_status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(total, firstLoc, sold ? 'sold' : item.status, sold ? 'ended' : item.channel_status, itemId);
    return { ok: true, sold, newQty: total, effect: mkEffect(total, touched) };
  }
  const newQty = Math.max(0, before.quantity - qty);
  const sold = newQty <= 0;
  tdb.prepare(`UPDATE sealed_items SET quantity = ?, status = ?, channel_status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newQty, sold ? 'sold' : item.status, sold ? 'ended' : item.channel_status, itemId);
  return { ok: true, sold, newQty, effect: mkEffect(newQty, []) };
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
      // stock_effect is written in the SAME statement that stamps stock_applied_at, so the record of
      // what we did and the claim that we did it can never disagree.
      pdb.prepare(`UPDATE order_line_items SET stock_applied_at = datetime('now'), stock_effect = ?, matched_kind = ?, matched_item_id = ?, match_method = COALESCE(match_method, ?), reconciled_at = COALESCE(reconciled_at, datetime('now')) WHERE id = ?`)
        .run(r.effect ? JSON.stringify(r.effect) : null, m.kind, m.id, m.method, li.id);
      applied++; if (r.sold) sold++;
    }
  }
  if (applied) console.log(`[postsale] stock decrement: ${applied} line(s) applied (${sold} sold out) of ${matched} matched / ${lines.length} pending`);
  return { considered: lines.length, matched, applied, sold };
}

// --- stock reversal (the inverse of the above, for a cancelled order) ---
//
// Idempotent through its own stamp, order_line_items.stock_reversed_at, exactly as the forward
// direction is through stock_applied_at. The two databases cannot share a transaction, so each
// direction carries its own key rather than trying to share one.
//
// TWO RULES, and both of them are refusals:
//
//  - No recorded effect, no reversal. A line decremented before stock_effect shipped cannot be put
//    back faithfully — the sealed placement rows it drew from were deleted and nothing recorded which
//    shelves they were. Inventing a quantity is worse than reporting that we cannot, so the line is
//    NAMED and handed to a human (and the Telegram card says so rather than claiming a clean restock).
//  - The row must still be what the decrement left behind. A row that has moved on since — relisted,
//    re-located, sold again through another channel — is somebody's more recent decision, and stamping
//    a months-old snapshot over it destroys real work to fix a bookkeeping error.
function reverseInventoryEffect(tdb, eff) {
  const row = tdb.prepare('SELECT id, quantity, status FROM inventory_items WHERE id = ?').get(eff.item_id);
  if (!row) return { ok: false, why: 'the stock row is gone' };
  if (String(row.quantity) !== String(eff.after.quantity) || row.status !== eff.after.status) {
    return { ok: false, why: 'the stock row changed after the sale — left alone' };
  }
  if (!eff.after.sold) {
    // A partial decrement never ended the listing: it is still live on eBay with the remaining
    // quantity. Nothing moves here but the number.
    tdb.prepare(`UPDATE inventory_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(eff.before.quantity, eff.item_id);
    return { ok: true, relisting: false };
  }
  // The last unit went, so the listing DID end. A cancellation does not bring an eBay listing back —
  // eBay mints a NEW ItemID when it relists, which is what the relist watch is for — so the card comes
  // back to the shelf as in_stock/ended and NEVER to the 'listed'/'active' pair in the snapshot.
  // Restoring `before.status` here is how the catalogue ends up pointing at a dead ItemID and the
  // repricer starts pricing a listing that is not there.
  tdb.prepare(`UPDATE inventory_items SET quantity = ?, status = 'in_stock', channel_status = 'ended',
               sold_at = NULL, sale_price_cents = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(eff.before.quantity, eff.item_id);
  return { ok: true, relisting: true };
}

function reverseSealedEffect(tdb, eff) {
  const row = tdb.prepare('SELECT id, quantity, status FROM sealed_items WHERE id = ?').get(eff.item_id);
  if (!row) return { ok: false, why: 'the stock row is gone' };
  if (String(row.quantity) !== String(eff.after.quantity)) {
    return { ok: false, why: 'the sealed quantity changed after the sale — left alone' };
  }
  const places = eff.placements || [];
  let qty = eff.before.quantity, loc = eff.before.location ?? null;
  if (places.length) {
    for (const pl of places) {
      // Put the units back by LOCATION, not by row id: an emptied placement row was deleted, and a new
      // one may since have appeared for the same shelf. The shelf is the fact worth preserving.
      const existing = tdb.prepare('SELECT id, quantity FROM sealed_placements WHERE item_id = ? AND location IS ? LIMIT 1')
        .get(eff.item_id, pl.location ?? null);
      if (existing) tdb.prepare('UPDATE sealed_placements SET quantity = ? WHERE id = ?').run(existing.quantity + pl.took, existing.id);
      else tdb.prepare('INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,?,?)').run(eff.item_id, pl.location ?? null, pl.took);
    }
    // Re-mirror from the placements, exactly as the decrement does. Never write sealed_items.quantity
    // directly while placements exist — that is the multi-location mirror rule.
    qty = tdb.prepare('SELECT COALESCE(SUM(quantity),0) s FROM sealed_placements WHERE item_id = ?').get(eff.item_id).s;
    loc = (tdb.prepare('SELECT location FROM sealed_placements WHERE item_id = ? ORDER BY id LIMIT 1').get(eff.item_id) || {}).location || null;
  }
  // Same landing state either way: a sold-out line comes back as in_stock/ended (the eBay listing died
  // with the sale and a cancellation does not revive it), a partial one keeps what it had.
  tdb.prepare(`UPDATE sealed_items SET quantity = ?, location = ?, status = ?, channel_status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(qty, loc, eff.after.sold ? 'in_stock' : eff.before.status,
      eff.after.sold ? 'ended' : eff.before.channel_status, eff.item_id);
  return { ok: true, relisting: !!eff.after.sold };
}

export function reverseStockForOrder(pdb, orderId, tdbIn) {
  let tdb = tdbIn;
  try { tdb = tdb || openDb(); } catch { return { considered: 0, reversed: 0, skipped: [], error: 'tracker_db' }; }
  let lines;
  try {
    lines = pdb.prepare(`SELECT id, sku, stock_effect FROM order_line_items
                         WHERE order_id = ? AND stock_applied_at IS NOT NULL AND stock_reversed_at IS NULL`).all(orderId);
  } catch { return { considered: 0, reversed: 0, skipped: [], error: 'no_column' }; }
  let reversed = 0; const skipped = [], relist = [];
  for (const li of lines) {
    let eff = null;
    try { eff = li.stock_effect ? JSON.parse(li.stock_effect) : null; } catch { /* corrupt — treated as absent */ }
    if (!eff || eff.v !== 1) {
      skipped.push({ line_id: li.id, sku: li.sku, why: 'no record of what the sale did — put this one back by hand' });
      continue;
    }
    const r = eff.kind === 'sealed' ? reverseSealedEffect(tdb, eff) : reverseInventoryEffect(tdb, eff);
    if (!r.ok) { skipped.push({ line_id: li.id, sku: li.sku, why: r.why }); continue; }
    pdb.prepare(`UPDATE order_line_items SET stock_reversed_at = datetime('now') WHERE id = ?`).run(li.id);
    reversed++;
    // Only a line that SOLD OUT ended a listing, so only that line has a relist to watch for. A bulk
    // lot that went 10 → 7 never ended anything. The guard falls straight out of the effect log.
    if (r.relisting && eff.before && eff.before.ebay_listing_id) {
      relist.push({ kind: eff.kind, item_id: eff.item_id, sku: li.sku, old_listing_id: String(eff.before.ebay_listing_id) });
    }
  }
  // Start watching for eBay's own relist of anything whose listing ended with the sale. Best-effort:
  // a failure here must not undo a restock that already succeeded, and the sweep is idempotent anyway.
  for (const w of relist) {
    try { enqueueRelistWatch(tdb, { ...w, order_id: orderId }); }
    catch (e) { console.warn('[postsale] could not queue the relist watch —', e?.message || e); }
  }
  if (reversed || skipped.length) {
    console.log(`[postsale] stock reversal for ${orderId}: ${reversed} line(s) put back`
      + (skipped.length ? `, ${skipped.length} needing a human` : '')
      + (relist.length ? `, watching for eBay to relist ${relist.length}` : ''));
  }
  return { considered: lines.length, reversed, skipped, relist };
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

// --- cancellations and payment failures, as four words instead of nineteen ---
//
// eBay's cancellation vocabulary is twelve values wide and our decisions are four wide, so the mapping
// is written down once, here, next to the SQL that acts on it. Deliberately NOT a separate module: its
// entire job is to stay in lockstep with the predicates immediately below, and a file boundary between
// a mapping and the query that reads it is how the two drift apart.
//
//   none       nothing in play
//   requested  a cancellation is IN FLIGHT and undecided — the seller can still reject it
//   cancelled  final: the order is dead
//   rejected   the request was refused or failed — the order STANDS
//   unknown    a value eBay has started sending that we have never mapped
//
// CancelClosedForCommitment sits with the completed cancellations on eBay's own wording: "since the
// buyer committed to buying the item but did not pay for it, the cancellation succeeded and no refund
// is needed". It only arises on an order that was never paid, which the paid gate never ingests, so in
// practice it cannot reach the queue either way.
const CANCEL_STATUS_MAP = {
  NotApplicable: 'none', Invalid: 'none', CustomCode: 'none',
  CancelRequested: 'requested',
  // CancelStatus sense: the seller HAS approved and it is completing. Not to be confused with
  // OrderStatus=CancelPending, which is the opposite — buyer asked, seller has not decided yet.
  CancelPending: 'cancelled',
  CancelComplete: 'cancelled', CancelClosedWithRefund: 'cancelled',
  CancelClosedNoRefund: 'cancelled', CancelClosedUnknownRefund: 'cancelled',
  CancelClosedForCommitment: 'cancelled',
  CancelRejected: 'rejected', CancelFailed: 'rejected',
};
const _unmappedCancel = new Set();   // log-once: a ten-minute poll would otherwise spam the console

/**
 * cancelState(o) — the one word we act on, from a parsed GetOrders order.
 *
 * Returns NULL when eBay said nothing at all, so refreshOrder's never-blank rule keeps what we have.
 * `NotApplicable` is different: that is eBay actively saying there is no cancellation, which is what a
 * rejected request decays to, and it maps to 'none' and IS written. Without that, a request that the
 * seller declined would stay flagged HOLD forever.
 *
 * CancelStatus is read first because it is the more specific field. OrderStatus is the fallback, and
 * `Cancelled` there is decisive on its own — an order can be cancelled without a CancelStatus ever
 * appearing. An OrderStatus we do not recognise (`InProcess` is returnable but not requestable, and
 * several legacy Half.com values still exist in the enum) must be INERT, never a hold.
 */
export function cancelState(o) {
  const raw = String((o && o.cancelStatus) || '').trim();
  const os = String((o && o.orderStatus) || '').trim();
  if (raw) {
    const mapped = CANCEL_STATUS_MAP[raw];
    if (mapped) return mapped;
    if (!_unmappedCancel.has(raw)) {
      _unmappedCancel.add(raw);
      console.warn('[postsale] unmapped eBay CancelStatus "' + raw + '" — orders carrying it are HELD off '
        + 'the pull list until it is mapped (CANCEL_STATUS_MAP in lib/postsale.mjs)');
    }
    // Fail safe in BOTH directions: held rather than packed, but never silently deleted from the queue.
    return 'unknown';
  }
  if (os === 'Cancelled') return 'cancelled';
  if (os === 'CancelPending') return 'requested';   // OrderStatus sense: buyer asked, seller undecided
  return null;
}

/**
 * eBay's cancellation reason code, in words.
 *
 * There are TWO documented vocabularies for the same handful of ideas — the Trading API's
 * CancelReasonCodeType (BuyerCancelOrder, OrderPlacedByMistake, OutOfStock…) and the Post-Order API's
 * CancelReasonEnum (BUYER_ASKED_CANCEL, ORDER_MISTAKE, ORDER_UNPAID…) — and the value this account
 * actually received for order 10-14989-43407 was `BuyerAskedCancel`, which appears verbatim in
 * NEITHER: it is the Post-Order idea in the Trading API's CamelCase.
 *
 * So codes are normalised (case and underscores dropped) before lookup, both vocabularies are mapped
 * to the same phrases, and an unrecognised code is SPLIT INTO WORDS rather than printed raw. eBay is
 * demonstrably sending values its own docs do not list, so the fallback is the part that has to be
 * good: "some new reason" reads like an answer, `SomeNewReason` reads like a bug.
 */
const CANCEL_REASON_TEXT = {
  buyeraskedcancel: 'the buyer asked to cancel',
  buyercancelorder: 'the buyer asked to cancel',
  ordermistake: 'the buyer ordered it by mistake',
  orderplacedbymistake: 'the buyer ordered it by mistake',
  foundcheaperprice: 'the buyer found it cheaper somewhere else',
  pricetoohigh: 'the buyer thought the price was too high',
  wontarriveintime: 'it would not have arrived in time',
  addressissues: 'there was a problem with the delivery address',
  addressissue: 'there was a problem with the delivery address',
  buyercanceloraddressissue: 'the buyer asked to cancel, or the address was wrong',
  orderunpaid: 'the buyer never paid',
  // Seller-side, and the one that costs you: eBay records a defect against the account for it.
  outofstock: 'we were out of stock (this one carries a seller defect)',
  outofstockorcannotfulfill: 'we could not fulfil it (this one carries a seller defect)',
  // Deprecated by eBay and carries no information, so it is better to say nothing than to say "other".
  other: null,
  customcode: null,
};
export function cancelReasonText(code) {
  const raw = String(code == null ? '' : code).trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (key in CANCEL_REASON_TEXT) return CANCEL_REASON_TEXT[key];
  // Unknown: BUYER_DID_SOMETHING and BuyerDidSomething both become "buyer did something".
  const words = raw.includes('_')
    ? raw.toLowerCase().split('_').filter(Boolean).join(' ')
    : raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.trim() || null;
}

// CheckoutStatus.eBayPaymentStatus. `paid` in this app means "PaidTime exists", and eBay can report a
// failure AFTER that — a bounced eCheck or a declined card on an order already in the pack queue. So
// this is the second thing that can put an order on hold, and it is not a cancellation: the buyer may
// pay again and eBay may resolve it, so the stock is never reversed on it.
const PAYMENT_STATUS_MAP = {
  NoPaymentFailure: 'ok', CustomCode: 'ok',
  PayPalPaymentInProcess: 'pending', PaymentInProcess: 'pending',
  BuyerECheckBounced: 'failed', BuyerCreditCardFailed: 'failed',
  BuyerFailedPaymentReportedBySeller: 'failed',
};
const _unmappedPayment = new Set();
export function paymentState(o) {
  const raw = String((o && o.paidStatus) || '').trim();
  if (!raw) return null;                       // eBay said nothing — keep what we have
  const mapped = PAYMENT_STATUS_MAP[raw];
  if (mapped) return mapped;
  if (!_unmappedPayment.has(raw)) {
    _unmappedPayment.add(raw);
    console.warn('[postsale] unmapped eBay eBayPaymentStatus "' + raw + '" — treated as ok '
      + '(PAYMENT_STATUS_MAP in lib/postsale.mjs)');
  }
  // Unlike a cancellation, an unknown payment status defaults to OK. Holding every order on a value
  // eBay merely added would stop the shop; a genuine failure has a name and it is in the map.
  return 'ok';
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
// A CANCELLED order leaves the queue outright: there is nothing to pack and nothing to post. That is
// not the same as `posted`, so attachFulfilment labels it separately — an order that vanished with no
// explanation is an order somebody goes looking for.
//
// A HELD one (cancellation requested but undecided, or a payment that failed after PaidTime) does NOT
// leave. The seller can still reject a cancellation, and an order that quietly disappeared from the
// pull list is an order that gets packed a day late when the request is declined. It stays in the
// queue, flagged, and off the DEFAULT pick selection — visible and deliberate, not invisible and
// automatic.
//
// COALESCE everywhere, and this is not defensive habit: every row that existed before the cancellation
// migration has cancel_state NULL, and in SQLite `NULL <> 'cancelled'` evaluates to NULL, which is
// falsy. A bare comparison here would empty the ENTIRE pack queue on the first boot after upgrading.
export const NOT_CANCELLED_SQL = "COALESCE(cancel_state,'none') <> 'cancelled'";
export const CANCELLED_SQL = `NOT (${NOT_CANCELLED_SQL})`;
// Composed from two halves that are never used apart, so they stay local rather than becoming two more
// exported names to keep straight.
const CANCEL_HOLD_SQL = "COALESCE(cancel_state,'none') IN ('requested','unknown')";
const PAYMENT_HOLD_SQL = "COALESCE(payment_state,'ok') = 'failed'";
export const HOLD_SQL = `(${CANCEL_HOLD_SQL} OR ${PAYMENT_HOLD_SQL})`;
// A label-bought order is in the queue only UNTIL it is picked. label_bought_at is history and is
// never cleared, so without the picked_at clause those orders would sit in the queue forever.
export const IN_QUEUE_SQL = `(${NOT_CANCELLED_SQL} AND (shipped_status = 'unshipped' OR (label_bought_at IS NOT NULL AND picked_at IS NULL)))`;
export const NEEDS_PACKING_SQL = `(picked_at IS NULL AND ${IN_QUEUE_SQL})`;
// In the queue, and safe to pull WITHOUT anyone thinking about it. The distinction from
// NEEDS_PACKING_SQL is the whole point: bulk actions (the default pick sheet, "mark all picked") use
// this, while per-order buttons keep NEEDS_PACKING_SQL — a human looking at one held order may
// legitimately decide to pack it anyway, and that decision is theirs to make.
export const PICKABLE_SQL = `(${NEEDS_PACKING_SQL} AND NOT ${HOLD_SQL})`;

// The same rules against a row already in hand. Every one of these has an SQL twin above, and
// postsale-cancel.test.mjs runs the two against the same rows to prove they agree — so a caller may
// use whichever fits, and neither spelling can quietly drift from the other.
export function isCancelled(o) { return (o.cancel_state || 'none') === 'cancelled'; }
// Why an order is held, in the words the pick sheet and the dashboard both print. isOnHold is defined
// in terms of this rather than repeating the three conditions in a different order.
export function holdReason(o) {
  if ((o.payment_state || 'ok') === 'failed') return 'payment failed';
  if (o.cancel_state === 'requested') return 'cancel requested';
  if (o.cancel_state === 'unknown') return 'unknown eBay cancel status';
  return null;
}
export function isOnHold(o) { return holdReason(o) !== null; }
export function inQueue(o) {
  if (isCancelled(o)) return false;
  return o.shipped_status === 'unshipped' || (!!o.label_bought_at && !o.picked_at);
}
export function needsPacking(o) { return !o.picked_at && inQueue(o); }
// What a BULK action may touch — the dashboard ships this as o.pickable so no client re-derives it.
// Callers that already read through IN_QUEUE_SQL have cancelled orders excluded for them and only need
// the hold test; the pick sheet is the one place that states both, because its ids= branch is allowed
// to override a hold but never a cancellation.
export function pickable(o) { return needsPacking(o) && !isOnHold(o); }

// The one-word state the dashboard and the digest both label an order with.
//   to_pack      — nobody has pulled it yet
//   label_bought — eBay says sent because a label was bought, but the cards are still on the shelf
//   to_post      — pulled and packed, still needs dispatching
//   posted       — done
export function attachFulfilment(orders) {
  for (const o of orders) {
    o.needs_packing = needsPacking(o);
    o.in_queue = inQueue(o);
    o.on_hold = isOnHold(o);
    o.hold_reason = holdReason(o);
    o.cancelled = isCancelled(o);
    // eBay's reason in words, resolved server-side so the dashboard, the pick sheet and the Telegram
    // card all say the same thing. The free-text detail wins when eBay sent one; it rarely does.
    o.cancel_reason_text = o.cancel_reason_detail || cancelReasonText(o.cancel_reason);
    // The server's answer to "may a bulk action touch this?", so no client has to re-derive it from
    // three other fields and quietly fall a term behind.
    o.pickable = pickable(o);
    // 'cancelled' is checked FIRST and is its own word, not folded into 'posted'. An order that left
    // the queue because it died is a different fact from one that left because it went in the post,
    // and a dashboard that calls the first one "shipped" is lying to whoever reads it.
    o.fulfilment_state = isCancelled(o) ? 'cancelled'
      : !inQueue(o) ? 'posted'
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
  // Now that the poll asks for orders in every state, an order can be BORN cancelled: paid and then
  // cancelled inside one poll interval. It is still worth ingesting (the buyer, the line items and the
  // audit trail are all real), but it must not queue a label and must not be thanked for a purchase.
  const cancelCols = cancelColumns(o);
  const bornCancelled = cancelCols.cancel_state === 'cancelled';
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
      label_status: (cfg.labels && !o.shippedTime && o.ship.name && !bornCancelled) ? 'queued' : null,
      ...postageColumns(o, cfg),
      ...cancelCols,
      cancel_seen_at: cancelCols.cancel_state && cancelCols.cancel_state !== 'none' ? nowSql() : null,
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
      .run(o.orderId, buyer.id, rep ? rep.itemId : null, repeat ? 1 : 0,
        bornCancelled ? 'skipped' : messageStatus);
    db.exec('COMMIT');
    return { created: true, repeat, bornCancelled };
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

// Every cancellation/payment column an ingest or a refresh writes, derived once from a parsed order.
//
// Deliberately NOT merged through refreshOrder's generic never-blank loop. That rule is right for a
// tracking number — eBay legitimately stops sending fields it sent before, and blanking one we already
// showed the buyer would be a lie. It is wrong here: a declined cancellation decays to NotApplicable,
// and refusing to write that would leave the order flagged HOLD forever. So a value eBay ACTUALLY sent
// is always written, including the one that clears the flag; only silence is ignored.
function cancelColumns(o) {
  const out = {};
  const cs = cancelState(o);
  if (cs) {
    out.cancel_state = cs;
    // Keep the raw eBay word for diagnosis. When the state came from OrderStatus alone there is no
    // CancelStatus to keep, so say where it came from rather than inventing one.
    out.cancel_status = o.cancelStatus || 'OrderStatus:' + (o.orderStatus || '');
  }
  if (o.cancelReason) out.cancel_reason = o.cancelReason;
  if (o.cancelReasonDetails) out.cancel_reason_detail = o.cancelReasonDetails;
  if (o.cancelInitiator) out.cancel_initiator = o.cancelInitiator;
  if (o.cancelInitiatedAt) out.cancel_requested_at = o.cancelInitiatedAt;
  if (o.cancelCompletedAt) out.cancel_completed_at = o.cancelCompletedAt;
  const ps = paymentState(o);
  if (ps) out.payment_state = ps;
  return out;
}

// Queue one buyer message of a given kind, once. The unique (order_id, kind) index is the idempotency
// key, so a re-poll that re-detects the same transition is a no-op rather than a second message.
// Returns true only when a row was actually created.
export function enqueueMessage(db, orderId, kind) {
  const ord = db.prepare('SELECT buyer_id FROM orders WHERE order_id=?').get(orderId);
  if (!ord) return false;
  if (messagingBlocked(db, orderId, kind)) return false;
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
  // Merged AFTER the never-blank loop and outside it — see cancelColumns for why the rule is inverted
  // for these. A value eBay actually sent always wins, including the one that clears a hold.
  Object.assign(next, cancelColumns(o));

  const gotTracking = !prev.tracking_number && !!next.tracking_number;
  const gotDelivered = !prev.delivered_time && !!next.delivered_time;
  const becameShipped = prev.shipped_status !== 'shipped' && !!(next.shipped_time || next.tracking_number);

  // Fire on the TRANSITION, not the state — the same rule the tracking/delivered messages follow. eBay's
  // cancellation timestamps can be backdated, so "there is a CancelStatus" is not a trigger; "there was
  // not one before" is. Without this a re-poll would re-alert and re-reverse the stock every ten minutes.
  const prevCancel = prev.cancel_state || 'none';
  const nextCancel = next.cancel_state || prevCancel;
  const cancelMoved = nextCancel !== prevCancel;
  const becameCancelled = prevCancel !== 'cancelled' && nextCancel === 'cancelled';
  const prevPayment = prev.payment_state || 'ok';
  const nextPayment = next.payment_state || prevPayment;
  const paymentMoved = nextPayment !== prevPayment;
  // ONE derived move for the caller to act on, rather than each caller re-deriving it (the poll and the
  // sweep both need this, and two copies is how they drift).
  //
  // BECOMING CANCELLED OUTRANKS EVERYTHING, and that ordering is load-bearing rather than cosmetic: it
  // is the only transition with an irreversible side effect (settleHolds puts the stock back off the
  // back of it), and it fires exactly once, because the next refresh sees cancel_state already written.
  // eBay routinely moves the payment status in the same breath as cancelling an unpaid order, so a
  // payment-first ordering would swallow the cancellation and the cards would never come back.
  //
  // A routine payment transition (ok→pending→ok, or the very first write) is NOT a move worth settling.
  // Reporting those would have every ordinary order run a card-resolve round that writes NULLs over
  // NULLs for an alert it never had.
  //
  // When a cancellation REQUEST and a payment failure land together the payment card wins and the
  // request has no card of its own — deliberate. The order is held either way, and if the cancellation
  // later completes it takes the branch above and is handled in full.
  const move = (kind, state) => ({ orderId: o.orderId, kind, state, becameCancelled });
  const holdMove = becameCancelled ? move('cancel', nextCancel)
    : paymentMoved && nextPayment === 'failed' ? move('payment', 'failed')
      : cancelMoved && !(nextCancel === 'none' && !prev.hold_alert_state) ? move('cancel', nextCancel)
        : paymentMoved && nextPayment !== 'failed' && prev.hold_alert_state ? move('payment', 'ok')
          : null;

  if (gotTracking) next.tracking_seen_at = nowSql();
  if (gotDelivered) next.delivered_seen_at = nowSql();
  if (cancelMoved && nextCancel !== 'none') next.cancel_seen_at = nowSql();
  if (paymentMoved && nextPayment !== 'ok') next.payment_seen_at = nowSql();
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
  if (!changed.length) {
    return { updated: false, changed: [], gotTracking: false, gotDelivered: false, becameShipped: false,
      becameCancelled: false, holdMove: null, cancelState: nextCancel, paymentState: nextPayment };
  }

  const pcfg = (cfg && cfg.postage) || {};
  const messagingOn = cfg.messaging !== false;
  const queued = [];
  let closedMessages = 0;
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
    // Close out anything already drafted for a now-dead order. enqueueMessage stops NEW ones, but a
    // card sitting in Telegram with a live ✅ Send button is one tap from telling a buyer their parcel
    // is on the way for an order that no longer exists. The caller stamps that card afterwards.
    if (becameCancelled) {
      closedMessages = db.prepare(`UPDATE postsale_messages SET status='skipped', error='order cancelled on eBay',
                                   updated_at=datetime('now')
                                   WHERE order_id=? AND status IN ('pending','drafted','awaiting_approval')`)
        .run(o.orderId).changes || 0;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }

  // A cancelled order is not a purchase: it must not inflate lifetime spend, and it must not make a
  // one-time buyer read as a repeat one (that flag drives both the ⭐ on the sale alert and the model's
  // context). Outside the transaction — it is a single UPDATE and never worth failing the refresh over.
  if (becameCancelled && prev.buyer_id) {
    try { recomputeBuyer(db, prev.buyer_id); } catch (e) { console.warn('[postsale] recomputeBuyer failed —', e?.message || e); }
  }

  return { updated: true, changed, gotTracking, gotDelivered, becameShipped, queued,
    becameCancelled, holdMove, cancelState: nextCancel, paymentState: nextPayment, closedMessages };
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

/**
 * The loud one. A cancellation or a failed payment, pinned so it cannot scroll away behind sale alerts.
 *
 * Dedupe is on hold_alert_state — one card per STATE, not per order. A request that later completes is
 * new information that changes what to do about it, and a silently edited pin does not make a phone
 * buzz. When a card IS superseded its buttons are cleared and it is unpinned first: a live button on a
 * decision that has moved on is a lie you can tap.
 *
 * Network, so it runs outside every transaction — the same shape as fireSaleAlert.
 */
async function fireHoldAlert(env, db, orderId, { kind, state, restock, watching, lookup } = {}, cfg = DEFAULT_CONFIG) {
  if (cfg.hold_alerts === false || !cfg.alerts) return { skipped: 'disabled' };
  if (!telegramEnabled(env) || !telegramChatConfigured(env)) return { skipped: 'no_telegram' };
  const row = db.prepare('SELECT * FROM orders WHERE order_id=?').get(orderId);
  if (!row) return { skipped: 'gone' };
  if (row.hold_alert_state === state) return { skipped: 'already_alerted' };
  const over = state === 'none' || state === 'rejected' || state === 'ok';
  // Nothing to retire and nothing to raise: an order whose trouble ended without ever having a card.
  if (over && !row.hold_alert_state && !row.hold_alert_message_id) return { skipped: 'nothing_to_clear' };

  // Retire whatever card is currently live for this order before putting up a new one.
  if (row.hold_alert_message_id) {
    await editMessageText(env, { chatId: row.hold_alert_chat_id, messageId: row.hold_alert_message_id,
      text: holdAlertText(db, row, { kind: row.hold_alert_kind, state: row.hold_alert_state, lookup },
        { icon: '↪️', status: over ? 'sorted out — back to normal' : 'superseded — see the newer card' }),
      clearButtons: true }).catch(() => {});
    if (row.hold_alert_pinned) {
      await unpinChatMessage(env, { chatId: row.hold_alert_chat_id, messageId: row.hold_alert_message_id }).catch(() => {});
    }
  }

  // 'none'/'rejected'/'ok' means the trouble is over: retire the card and clear the state so a LATER
  // cancellation on the same order alerts fresh rather than being deduped against a stale one.
  if (over) {
    db.prepare(`UPDATE orders SET hold_alert_state=NULL, hold_alert_kind=NULL, hold_alert_message_id=NULL,
                hold_alert_pinned=NULL, hold_ack_at=NULL, hold_ack_by=NULL WHERE order_id=?`).run(orderId);
    return { resolved: true };
  }

  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  const buttons = [[{ text: '✅ Got it', data: `psk:${orderId}` }]];
  const hub = sellerHubUrl((cfg && cfg.postage) || {}, orderId);
  // The alert links to Seller Hub rather than offering an approve/reject button, because the Cancel ID
  // that those calls need is simply not in the GetOrders response — see the note in lib/postsale-db.mjs.
  if (hub) buttons.push([{ text: '📦 Sort it out on eBay', url: hub }]);
  const r = await sendMessage(env, { chatId, text: holdAlertText(db, row, { kind, state, restock, watching, lookup }), buttons });
  if (!r.ok) { console.warn('[postsale] hold alert send failed —', r.description || r.error); return { ok: false }; }
  const messageId = r.result && r.result.message_id;
  const pin = cfg.hold_pin === false ? { ok: false } : await pinChatMessage(env, { chatId, messageId });
  db.prepare(`UPDATE orders SET hold_alert_kind=?, hold_alert_state=?, hold_alert_sent_at=datetime('now'),
              hold_alert_chat_id=?, hold_alert_message_id=?, hold_alert_pinned=?,
              hold_ack_at=NULL, hold_ack_by=NULL WHERE order_id=?`)
    .run(kind, state, String(chatId), messageId, pin.ok ? 1 : 0, orderId);
  return { ok: true, message_id: messageId, pinned: !!pin.ok };
}

// The card's text, rebuilt from current state every time it is drawn (send, supersede, acknowledge) —
// so what the message says is always what the database says.
//
// `lookup` is threaded in because attachLocations builds the WHOLE inventory index when it isn't given
// one — every row of inventory_items and sealed_items, to resolve the two or three lines on one order.
// A single cancellation draws this card two or three times, so the caller builds it once.
function holdAlertText(db, row, { kind, state, restock, watching, lookup } = {}, decided) {
  const items = db.prepare('SELECT * FROM order_line_items WHERE order_id=?').all(row.order_id);
  // attachLocations already falls back to the SKU-prefix bin, so there is nothing to re-derive after it.
  attachLocations(db, [{ order_id: row.order_id, items }], lookup || buildInventoryLookup());
  return renderHoldAlert({
    kind: kind || 'cancel', state, orderId: row.order_id, salesRecordNumber: row.sales_record_number,
    buyerUsername: row.buyer_username, totalText: money(row.total_cents, row.currency), items,
    reason: row.cancel_reason_detail || cancelReasonText(row.cancel_reason), initiator: row.cancel_initiator,
    requestedAt: row.cancel_requested_at, restock, watching,
  }, decided);
}

/**
 * Everything that has to happen when an order's cancellation or payment state MOVES: put the stock
 * back if it died, then tell somebody.
 *
 * Deliberately one function called once, after the poll loop, rather than side effects sprinkled
 * through it — both halves touch things a DB transaction must not be holding open (the other database,
 * and the network), and both must run whether the move was spotted by the poll or by the sweep.
 */
async function settleHolds(env, db, moves, cfg) {
  if (!moves || !moves.length) return [];
  const out = [];
  // Built once for the whole batch: every card draw needs it and it is a full read of both stock tables.
  let lookup = null;
  try { lookup = buildInventoryLookup(); } catch { /* cards fall back to the SKU-prefix bin */ }
  for (const mv of moves) {
    let restock = null;
    // Only a CONFIRMED cancellation restocks. A request may still be rejected and a failed payment may
    // still be paid — putting the cards back for either would be undoing a sale that still exists.
    if (mv.becameCancelled && cfg.cancel_restock !== false) {
      try {
        restock = reverseStockForOrder(db, mv.orderId);
      } catch (e) {
        console.warn('[postsale] stock reversal failed —', e?.message || e);
        restock = { error: String(e?.message || e), reversed: 0, skipped: [] };
      }
    }
    let alert = null;
    try {
      alert = await fireHoldAlert(env, db, mv.orderId,
        { kind: mv.kind, state: mv.state, restock, lookup, watching: !!(restock && restock.relist && restock.relist.length) }, cfg);
    } catch (e) { console.warn('[postsale] hold alert failed —', e?.message || e); }
    out.push({ order_id: mv.orderId, kind: mv.kind, state: mv.state, restock, alert });
  }
  return out;
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
      // enqueueMessage asks the same question when the message is QUEUED; this catches an order whose
      // circumstances changed while the message sat pending — which is exactly what a cancellation is.
      const blocked = messagingBlocked(db, m.order_id, m.kind);
      if (blocked) { setMsg(db, m.id, { status: 'skipped', error: blocked }); held++; continue; }
      const r = await draftAndRoute(env, db, m, cfg);
      if (!r.ok) failed++; else if (r.status === 'sent') sent++; else drafted++;
    } catch (e) { failed++; console.warn('[postsale] draft failed', m.order_id, e?.message || e); setMsg(db, m.id, { status: 'failed', error: String(e?.message || e) }); }
  }
  return { considered: pend.length, drafted, sent, failed, held };
}

/**
 * "Is there any reason not to write to this buyer right now?" — one question, one place, one answer.
 *
 * Every reason to stay quiet lives here rather than at the call sites, because the list keeps growing:
 * it started as "the buyer already replied", gained "a case is open", and this change added "the order
 * was cancelled" and "the payment failed". Three call sites each carrying their own copy of a growing
 * list is how one of them ends up missing the newest reason.
 *
 * Returns the REASON as a string (which processMessages records verbatim), or null to proceed.
 * `cases` is queried defensively — an absent table must not stop a message, it just means no case.
 */
export function messagingBlocked(db, orderId, kind) {
  const ord = db.prepare('SELECT cancel_state, payment_state FROM orders WHERE order_id=?').get(orderId);
  if (ord && isCancelled(ord)) return 'order cancelled on eBay';
  if (ord && isOnHold(ord)) return 'order on hold — ' + holdReason(ord);
  // The rest apply to the delivered follow-up only: a thank-you or a dispatch note is still welcome
  // mid-conversation, but a cheerful "did it arrive?" dropped into an open case is not.
  if (kind !== 'delivered') return null;
  const replied = db.prepare(`SELECT 1 FROM postsale_messages WHERE order_id=? AND reply_detected_at IS NOT NULL`).get(orderId);
  if (replied) return 'buyer already in contact';
  try {
    const c = db.prepare(`SELECT 1 FROM cases WHERE order_id=? AND open_close='open'`).get(orderId);
    if (c) return 'a case is open';
  } catch { /* no cases table yet */ }
  return null;
}

// Acknowledging a hold card: lift the pin, and record who cleared it.
//
// The claim is atomic for the same reason the message approval's is — two people tapping at once must
// mean one unpin and one honest "already acknowledged by …", not two unpins and a race over the edit.
// Acknowledging changes nothing about the ORDER: it says a human has seen this, which is the only
// thing a pinned alert is actually asking for.
async function onHoldAck(env, db, cq, orderId, who) {
  const row = db.prepare('SELECT * FROM orders WHERE order_id=?').get(orderId);
  if (!row) return answerCallbackQuery(env, { id: cq.id, text: 'Order not found' });
  const claimed = db.prepare(`UPDATE orders SET hold_ack_at=?, hold_ack_by=?
                              WHERE order_id=? AND hold_ack_at IS NULL`).run(nowSql(), who, orderId).changes > 0;
  if (!claimed) return answerCallbackQuery(env, { id: cq.id, text: 'Already cleared by ' + (row.hold_ack_by || 'someone') });
  await answerCallbackQuery(env, { id: cq.id, text: 'Cleared and unpinned' });
  if (row.hold_alert_pinned) {
    await unpinChatMessage(env, { chatId: row.hold_alert_chat_id, messageId: row.hold_alert_message_id }).catch(() => {});
    db.prepare('UPDATE orders SET hold_alert_pinned=0 WHERE order_id=?').run(orderId);
  }
  // Buttons cleared, wording kept: the card stays in the chat as the record of what happened, stamped
  // with who dealt with it. Same shape as every other decided card in this app.
  return editMessageText(env, { chatId: row.hold_alert_chat_id, messageId: row.hold_alert_message_id,
    text: holdAlertText(db, row, { kind: row.hold_alert_kind, state: row.hold_alert_state },
      { icon: '✅', status: 'acknowledged', who }), clearButtons: true }).catch(() => {});
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
  // psk: carries an ORDER id, which has dashes in it — the two patterns above both require (\d+) and
  // so could never match one. `k` also matches neither alternation after `ps`, and neither the
  // repricer's ap:/sk: prefixes: no collision in any direction.
  const ack = (cq.data || '').match(/^psk:(.+)$/);
  if (!m && !dg && !ack) return;                     // not ours — another handler will claim it
  const cfg = loadConfig();
  // Authorisation first, before any lookup: an unauthorised tap must not even be able to probe which
  // message ids exist. Empty allowlist denies everyone (see isAllowedUser). This matters more for the
  // digest buttons than anywhere else in the app — one of them dispatches a whole day of orders.
  if (!isAllowedUser(cfg.telegram_allowed_user_ids, cq.from)) {
    console.warn('[postsale/telegram] denied ' + describeUser(cq.from) + ' (id ' + (cq.from && cq.from.id) + ') on ' + cq.data);
    return answerCallbackQuery(env, { id: cq.id, showAlert: true, text: denyCallbackText(cq.from, 'Post-sale') });
  }
  const who = describeUser(cq.from);
  if (ack) return onHoldAck(env, db, cq, ack[1], who);
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
// Floor between on-demand syncs (the dashboard's ↻). Long enough that leaning on the button can't
// spend the eBay call quota, short enough that "I just packed that, where is it" is one click away.
const MANUAL_SYNC_COOLDOWN_MS = 20_000;
let _lastManualSync = 0;

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
    const newOrders = [], queuedMessages = [], holdMoves = [];
    const isKnown = db.prepare('SELECT 1 FROM orders WHERE order_id = ?');
    while (page <= MAX_PAGES) {
      // No orderStatus — eBay's default is "All". Asking for 'Completed' is what made a cancelled order
      // invisible: it stopped matching the filter the moment it stopped being completed, so it fell out
      // of every future window and sat in the pack queue with nothing able to remove it.
      const res = await getOrders(env, { modTimeFrom, modTimeTo, page, entriesPerPage: 100 });
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
            if (r.holdMove) holdMoves.push(r.holdMove);
            if (r.queued && r.queued.length) queuedMessages.push(...r.queued);
          }
          continue;
        }
        if (!o.paid) { skippedUnpaid++; continue; }
        if (o.paidTime && isoLt(o.paidTime, watermark)) { skippedPreWatermark++; continue; }
        const r = ingestOrder(db, o, cfg);
        if (r.created) {
          ingested++;
          // Asking for every state means the poll can now adopt an order that is ALREADY cancelled —
          // paid and cancelled inside one interval. Firing 🟢 SOLD and then 🚫 CANCELLED back to back
          // is worse than firing neither: the cancel card carries the sale facts anyway.
          if (r.bornCancelled) holdMoves.push({ orderId: o.orderId, kind: 'cancel', state: 'cancelled', becameCancelled: true });
          else newOrders.push({ o, repeat: r.repeat });
        }
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
    // The by-id backstop. Cheap (one call per 20 open orders) but not free, so it runs on its own clock
    // INSIDE the poll rather than on every tick — and on a timestamp rather than a counter, because a
    // counter resets on restart and a restart loop would mean it never ran. Placed before settleHolds
    // so a cancellation only the sweep can see gets its restock and its alert on the same tick.
    //
    // A MANUAL sync always sweeps, and ignores the clock.
    //
    // The ↻ on the dashboard means "go and find out what is actually true". The windowed query above
    // cannot answer that for anything that changed BEFORE the cursor — and that is the single most
    // common reason a person presses it: they know something happened on eBay and the dashboard does
    // not show it. Asking by id is the only thing that can see back there, so leaving it out of the
    // manual path made the button ask a question that could not return the answer.
    //
    // sweep_interval_min governs the BACKGROUND cadence (0 turns the timer off). A person pressing a
    // button is not the schedule. /sync's own 20s cooldown is what bounds a leaned-on button.
    let sweep = null;
    {
      const due = sweepDue(trigger, cfg, getMeta(db, 'last_sweep_at'));
      if (due) {
        try {
          sweep = await sweepOpenOrders(env, db, { cfg });
          if (sweep.holdMoves && sweep.holdMoves.length) holdMoves.push(...sweep.holdMoves);
          if (sweep.refreshed) console.log(`[postsale] sweep: ${sweep.refreshed} of ${sweep.checked} open order(s) had changed`);
        } catch (e) { console.warn('[postsale] sweep failed —', e?.message || e); }
      }
    }
    // Cancellations and payment failures, after everything else and outside every transaction: the
    // restock writes the OTHER database and the alert is network. Same shape as the sale alerts above.
    const holds = await settleHolds(env, db, holdMoves, cfg);
    // Draft (and, in approve mode, queue for approval; in auto mode, send) the pending backlog.
    // messaging:false runs the fulfilment side (orders + alerts + dashboard) without the LLM drafting.
    const msg = (cfg.messaging === false) ? { skipped: 'messaging_off' } : await processMessages(env, db, cfg);
    return finishPoll(started, trigger, { ok: true, seen, ingested, refreshed, tracking_found: trackingFound,
      delivered_found: deliveredFound, queued_messages: queuedMessages,
      skipped_unpaid: skippedUnpaid, skipped_pre_watermark: skippedPreWatermark, stock, messages: msg,
      holds, sweep, window: { from: modTimeFrom, to: modTimeTo } });
  } catch (e) {
    return finishPoll(started, trigger, { ok: false, error: String(e?.message || e), code: e?.code || null });
  }
}
function finishPoll(started, trigger, result) {
  _orderPoll.last_run = { at: started.toISOString(), finished_at: new Date().toISOString(), trigger, ...result };
  return result;
}

/**
 * sweepOpenOrders — ask eBay about the orders we still consider OPEN, by ID.
 *
 * The ModTime cursor is a window, and a window can be missed: a poll that errored halfway through its
 * pages, a box that was switched off, a clock that drifted. Anything whose state changed while we were
 * not looking is invisible forever after, because the next window starts where the last one ended.
 *
 * This is the backstop, and the mechanism is the point: a populated OrderIDArray makes eBay ignore
 * BOTH the status filter and the time window, so this sweep cannot be filtered out by the same class
 * of thing it exists to catch. It closes the gap for every state change, not just cancellations —
 * tracking numbers and address edits come back through it too.
 *
 * Refresh only. An id we asked about that comes back unknown is REPORTED, never ingested: ingesting
 * here would walk straight past the paid gate and the activation watermark.
 *
 * `fetchOrders` is injectable purely so the whole thing is testable offline, the same
 * dependency-by-argument seam applyStockDecrements and attachLocations already use.
 */
/**
 * Should this poll also sweep by id? Pulled out of pollOrders because it is the whole rule in one
 * place — and because pollOrders reaches the network before it gets here, so inline it could only ever
 * be tested against a live eBay.
 *
 * A MANUAL run always sweeps and ignores the clock. The ↻ on the dashboard means "go and find out what
 * is actually true", and the windowed query cannot answer that for anything that changed BEFORE the
 * cursor — which is the usual reason somebody presses it. sweep_interval_min governs the BACKGROUND
 * cadence (0 turns the timer off); a person pressing a button is not the schedule, and /sync's own 20s
 * cooldown is what bounds a leaned-on button.
 */
export function sweepDue(trigger, cfg = {}, lastSweepAt = null, now = Date.now()) {
  if (trigger !== 'schedule') return true;
  const mins = Math.max(0, +cfg.sweep_interval_min || 0);
  if (!mins) return false;
  if (!lastSweepAt) return true;
  return now - new Date(lastSweepAt).getTime() >= mins * 60_000;
}

export async function sweepOpenOrders(env, db, { limit = 60, chunk = 20, fetchOrders = getOrders, cfg = loadConfig() } = {}) {
  const ids = db.prepare(`SELECT order_id FROM orders
     WHERE ${IN_QUEUE_SQL}
        OR ${HOLD_SQL}
        OR (shipped_status = 'shipped' AND delivered_time IS NULL
            AND COALESCE(shipped_time, paid_time, created_time) > datetime('now','-21 days'))
     ORDER BY COALESCE(paid_time, created_time) ASC LIMIT ?`).all(limit).map((r) => r.order_id);
  if (!ids.length) return { ok: true, checked: 0, refreshed: 0, holdMoves: [], missing: [] };

  let refreshed = 0; const holdMoves = [], missing = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const batch = ids.slice(i, i + chunk);
    const res = await fetchOrders(env, { orderIds: batch, entriesPerPage: 100 });
    if (!res.ok) return { ok: false, error: 'GetOrders failed', ack: res.ack, errors: res.errors, checked: i, holdMoves, missing };
    const seen = new Set();
    for (const o of res.orders) {
      seen.add(o.orderId);
      const r = refreshOrder(db, o, cfg);
      if (!r.updated) continue;
      refreshed++;
      if (r.holdMove) holdMoves.push(r.holdMove);
    }
    for (const id of batch) if (!seen.has(id)) missing.push(id);
  }
  setMeta(db, 'last_sweep_at', new Date().toISOString());
  if (missing.length) console.warn(`[postsale] sweep: eBay did not return ${missing.length} order(s) we asked about — ${missing.slice(0, 5).join(', ')}`);
  return { ok: true, checked: ids.length, refreshed, holdMoves, missing };
}

// One order-poll at a time, whoever asked for it. The dashboard's ↻ can now fire a poll on demand,
// so a manual run and the scheduled tick can genuinely collide — and both would call setMeta on
// orders_cursor at the end, so the slower one would push the cursor past a window the faster one
// never read. Those orders would then be outside every future window: silently lost, not late.
// A caller arriving mid-run joins the run in progress instead of starting a second one.
let _pollInFlight = null;
export function runOrderPoll(env, db, { trigger = 'schedule' } = {}) {
  if (_pollInFlight) return _pollInFlight;
  _pollInFlight = Promise.resolve(pollOrders(env, db, { trigger })).finally(() => { _pollInFlight = null; });
  return _pollInFlight;
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
        // No status filter here either. A historical order that was later cancelled is part of this
        // buyer's history, and with recomputeBuyer excluding cancelled orders from lifetime spend it is
        // now correctly counted as "happened and was cancelled" rather than being indistinguishable
        // from "never happened". The queue predicate keeps it out of the pack queue regardless.
        const res = await getOrders(env, { createTimeFrom, createTimeTo, page, entriesPerPage: 100 });
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
  const prev = db.prepare('SELECT shipped_status, label_bought_at, picked_at, cancel_state FROM orders WHERE order_id=?').get(id);
  // CompleteSale on a cancelled order fails at eBay anyway. Refusing locally is cheaper, and it says
  // something a person can act on instead of relaying an eBay error code.
  if (prev && isCancelled(prev)) {
    return { ok: false, code: 'order_cancelled', error: 'this order was cancelled on eBay — there is nothing to dispatch' };
  }
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
  //
  // A HELD order drops off the pull list too, for the opposite reason: that work must not be done yet.
  // It stays in the dispatch summary so it is visible rather than mysteriously absent — the digest is
  // rebuilt from current state on every tap, so an order cancelled after the message was sent corrects
  // itself the next time anyone touches it.
  const pickRows = [];
  for (const o of orders) {
    if (o.picked_at || isOnHold(o)) continue;
    for (const li of o.items) pickRows.push({ order_id: o.order_id, buyer_username: o.buyer_username, title: li.title, sku: li.sku, quantity: li.quantity, ebay_item_id: li.ebay_item_id, location: li.location });
  }
  const ps = buildPickSheet(pickRows, (lookup && lookup.locSort) || new Map());
  // Both counts are what the BUTTONS will actually act on, so the number on the button and the number
  // of orders it changes can never disagree — pickAllInDigest uses PICKABLE_SQL and
  // dispatchAllInDigest filters holds, and a button promising more than it delivers reads as a bug.
  const toPick = orders.filter((o) => !o.picked_at && !isOnHold(o)).length;
  const toShip = orders.filter((o) => !isOnHold(o)).length;
  const heldCount = orders.filter((o) => isOnHold(o)).length;
  return {
    orders, toPick, toShip, held: heldCount,
    pullText: renderPullList(ps.groups, { orderCount: orders.length, itemCount: ps.rows.length, unitCount: ps.unit_count, heldCount }, done && done.pull),
    dispatchText: renderDispatchSummary(orders, done && done.dispatch),
    // Local-only and reversible from the dashboard, so one tap is enough.
    pullButtons: toPick ? [[{ text: `✅ Mark all ${toPick} picked`, data: `psp:${digestId}` }]] : [],
    // A real eBay write per order, so this one asks first (see onPostsaleUpdate).
    dispatchButtons: toShip ? [[{ text: `🚚 Mark all ${toShip} shipped`, data: `psdq:${digestId}` }]] : [],
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
  // PICKABLE_SQL, not NEEDS_PACKING_SQL: this is the bulk button, and it must not sweep a held order
  // into "picked" on somebody's behalf. A held order can still be picked deliberately, one at a time.
  const r = db.prepare(`UPDATE orders SET picked_at = ?
                        WHERE order_id IN (SELECT order_id FROM pack_digest_orders WHERE digest_id = ?)
                        AND ${PICKABLE_SQL}`).run(nowSql(), digestId);
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
    const all = digestOrders(db, digestId);
    // A held order is not dispatched by the bulk button. Dispatching one whose cancellation the seller
    // is still deciding on, or whose payment bounced, is the expensive mistake this whole change exists
    // to stop — and it is reported rather than silently dropped, so the count still adds up on screen.
    const orders = all.filter((o) => !isOnHold(o));
    const held = all.filter((o) => isOnHold(o)).map((o) => ({ order_id: o.order_id, why: holdReason(o) }));
    const failed = [];
    let ok = 0;
    for (const o of orders) {
      const r = await dispatchOrder(env, db, o.order_id, cfg);
      if (r.ok) ok++; else failed.push({ order_id: o.order_id, ebay: r.ebay, code: r.code });
    }
    if (ok) db.prepare('UPDATE pack_digests SET dispatched_at=?, dispatched_by=? WHERE id=?').run(nowSql(), who, digestId);
    console.log(`[postsale/digest] dispatched ${ok}/${orders.length} by ${who} (digest ${digestId})`
      + (failed.length ? ' — ' + failed.length + ' failed' : '')
      + (held.length ? ' — ' + held.length + ' held back' : ''));
    return { claimed: true, total: orders.length, ok, failed, held };
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
  const tick = () => { _orderPoll.next_run_at = new Date(Date.now() + orderMs).toISOString(); return runOrderPoll(_env, _db, { trigger: 'schedule' }).catch((e) => console.error('[postsale]', e?.message || e)); };
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
      // storage location (from the tracker inventory). status=unshipped|shipped|cancelled|held filters
      // the queue; picked=0|1 filters on the pull state (0 = still to pull, 1 = already pulled+packed).
      if (p === '/orders' && method === 'GET') {
        const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '100', 10) || 100);
        const status = url.searchParams.get('status');
        const picked = url.searchParams.get('picked');
        const conds = [];
        // "unshipped" is the PACK QUEUE, not eBay's flag: an order eBay marked sent because a label
        // was bought still belongs here until someone has actually pulled and packed it.
        if (status === 'unshipped') conds.push(IN_QUEUE_SQL);
        // "shipped" is the literal negation of the queue, which means a cancelled order — which now
        // leaves the queue — would otherwise land here and be labelled SHIPPED. Excluding it explicitly
        // is the difference between fixing the bug and moving it.
        else if (status === 'shipped') conds.push(`NOT ${IN_QUEUE_SQL} AND ${NOT_CANCELLED_SQL}`);
        else if (status === 'cancelled') conds.push(CANCELLED_SQL);
        else if (status === 'held') conds.push(HOLD_SQL);
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
          // Held orders are deliberately NOT filtered out here. Their cards are kept off the pull list
          // by the pullFrom filter below — but they still belong in the DO-NOT-PACK banner, because a
          // sheet that is quietly two orders shorter than the queue is how somebody ends up hunting the
          // shelves for a card the paper never mentioned.
          const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
          orders = db.prepare(`SELECT * FROM orders ${where} ORDER BY COALESCE(paid_time, created_time) ASC`).all();
        }
        attachPostage(orders, loadConfig());
        attachFulfilment(orders);
        const lookup = buildInventoryLookup();
        const rows = [];
        // A cancelled order NEVER contributes pull rows — there is nothing to send. A held one is
        // different: it is kept off the sheet you did not ask for, but ticking it by hand IS the
        // deliberate override the queue predicates exist to allow (you rejected the cancellation, and
        // now you want to pack it). So the ids= branch prints its cards; the derived branch does not.
        const pullFrom = orders.filter((o) => !isCancelled(o) && (idsParam ? true : !isOnHold(o)));
        for (const o of pullFrom) {
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
        const upgrades = pullFrom.filter((o) => o.postage.upgrade).map((o) => ({
          order_id: o.order_id, buyer_username: o.buyer_username, sales_record_number: o.sales_record_number,
          tier: o.postage.tier, label: o.postage.label, code: o.postage.code,
          paid_cents: o.postage.paid_cents, currency: o.currency || 'AUD',
          tracked: o.postage.tracked, tracking: o.postage.tracking, handle_by: o.postage.handle_by,
        }));
        // The DO-NOT-PACK banner. Same job as the upgrades one and printed above it: it is a packing
        // instruction, and the moment it matters is before anyone walks off to the shelves. A ticked
        // order that has since been cancelled says so here rather than silently disappearing.
        const holds = orders.filter((o) => isOnHold(o) || isCancelled(o)).map((o) => ({
          order_id: o.order_id, buyer_username: o.buyer_username, sales_record_number: o.sales_record_number,
          cancel_state: o.cancel_state || null, payment_state: o.payment_state || null,
          why: isCancelled(o) ? 'cancelled on eBay' : holdReason(o),
          cancel_reason: o.cancel_reason_text || null,
          cancel_initiator: o.cancel_initiator || null, cancel_requested_at: o.cancel_requested_at || null,
        }));
        return send(res, 200, { rows: ps.rows, groups: ps.groups, order_count: pullFrom.length,
          item_count: ps.rows.length, unit_count: ps.unit_count, upgrades, holds });
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

      // POST /sync — what the ↻ on the fulfilment dashboard means: ask eBay for anything new, THEN
      // let the page re-read. Ungated, like the dashboard's other buttons (mark-shipped next door
      // writes to eBay through the same open router) — the limits here are for eBay's call quota,
      // not the caller: one poll in flight at a time, and a floor between manual runs. Landing
      // inside that floor is not an error, it just reports the last run so the page can say so.
      if (p === '/sync' && method === 'POST') {
        const waited = Date.now() - _lastManualSync;
        if (waited < MANUAL_SYNC_COOLDOWN_MS) {
          return send(res, 200, { ok: true, skipped: 'cooldown', retry_in_ms: MANUAL_SYNC_COOLDOWN_MS - waited, state: getPostsaleState().order_poll });
        }
        _lastManualSync = Date.now();
        const result = await runOrderPoll(env, db, { trigger: 'manual' });
        return send(res, 200, { ok: result?.ok !== false, result, state: getPostsaleState().order_poll });
      }

      // ---- DIAG_TOKEN-gated manual triggers ----

      // GET /diag/order-xml?id=<OrderID>[&as=parsed] — what eBay ACTUALLY says about one order.
      //
      // Read-only, one GetOrders, by id. Asking by OrderIDArray means eBay ignores the status filter and
      // the time window, so this answers for any order in any state — including the ones a windowed poll
      // can no longer see, which is the whole reason it exists. `as=parsed` returns what parseOrders made
      // of it, so a field can be checked against its interpretation in one round trip.
      //
      // The XML is REDACTED on the way out (see redactOrderXml): its intended destination is a git-tracked
      // test fixture, and the raw response carries the buyer's name, street and phone.
      if (p === '/diag/order-xml' && method === 'GET') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const id = (url.searchParams.get('id') || '').trim();
        if (!id) return send(res, 400, { error: 'id is required (an eBay OrderID, e.g. 10-14989-43407)' });
        const r = await getOrders(env, { orderIds: [id] });
        if (url.searchParams.get('as') === 'parsed') {
          return send(res, 200, { ok: r.ok, ack: r.ack, errors: r.errors || null, orders: r.orders });
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        return res.end(redactOrderXml(r.xml || ''));
      }

      if (p === '/poll/orders' && method === 'POST') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await runOrderPoll(env, db, { trigger: 'manual' });
        return send(res, 200, { triggered: 'poll-orders', result });
      }
      // POST /sweep — re-read every open order BY ID, ignoring the time window entirely. This is what
      // you reach for when an order is doing something on eBay that the dashboard has not noticed.
      if (p === '/sweep' && method === 'POST') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await sweepOpenOrders(env, db);
        // Act on whatever it found, exactly as the poll would have.
        if (result.ok && result.holdMoves && result.holdMoves.length) {
          result.holds = await settleHolds(env, db, result.holdMoves, loadConfig());
        }
        return send(res, 200, { triggered: 'sweep', result });
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
