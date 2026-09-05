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
import { itemUrl, searchUrl, compsQuery, messagesUrl } from './ebay-links.mjs';
import { shortTitle, renderPullList, renderDispatchSummary, renderSaleAlert, renderHoldAlert, renderDealCard,
  renderInboxMessage, renderInboxNag } from './telegram-cards.mjs';
import { getOrders, geteBayOfficialTime, sendBuyerMessage, getMemberMessages, completeSale, getItem, sendInvoice, siteId,
  getMyMessages, reviseMyMessages, getUser, MY_MESSAGES_ID_CAP } from './ebay-trading.mjs';
import { oauthStatus } from './ebay-oauth.mjs';
import { openDb } from './db.mjs';
import { enqueueRelistWatch } from './relist-watch.mjs';
// money() is NOT imported: postsale has its own currency-aware one at :239 that renders 'A$8.26',
// which is what an owner-facing refusal should say. deals.mjs re-exports shipping-bands' bare
// '$8.26' form because that is what the buyer-facing postage sentence uses.
import { classifyDealAsk, dealSummary, checkDiscount, stripQuotedHistory } from './deals.mjs';
// The band table lives in the eBay-listing config, and loadConfig there is its single reader —
// re-reading the file here would duplicate normalizeBands and invite the two to drift.
import { loadConfig as loadListingConfig } from './listings.mjs';
import {
  draftMessage, guardrailScrub, nextBusinessDay, dispatchDay, shipTiming, fallbackDraft,
  fallbackFollowUp, dispatchFacts,
  DEFAULT_FALLBACK_SUBJECT, DEFAULT_FALLBACK_BODY, DEFAULT_FALLBACK_CARD_LINE, DEFAULT_SHIP_TIMING_TEXT,
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
  // The dispatch promise. {{when}} is filled per order with "later today" / "tomorrow" /
  // "on Tuesday" — see shipTiming(). A sentence with no {{when}} is used exactly as written, which
  // is how a config from before this existed keeps working; it just never says "later today".
  ship_timing_text: DEFAULT_SHIP_TIMING_TEXT,
  // --- same-day dispatch ---
  // OPT-IN. Off = every order is promised the next business day, exactly as before. On, an order
  // that lands on a working day at or before the cut-off is promised dispatch TODAY.
  same_day_dispatch: false,
  same_day_cutoff: '12:00',        // store-local HH:MM, read against the clock NOW, not paid_time
  same_day_text: 'later today',
  // What a buyer whose own calendar date differs from ours is told instead of a relative word (a
  // 1am Sydney order is still yesterday evening in Perth). 'weekday' | 'next business day'.
  different_day_wording: 'weekday',
  signature: '-BK',
  brand_voice: '',
  style_notes: '',
  // Named before Best Offer went off store-wide, so it reads as "invite an offer". It now controls the
  // line inviting a buyer to ask for a TOTAL, which is the mechanism that replaced it. The key keeps
  // its name because renaming it would silently reset the owner's saved choice to the default.
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
  // --- eBay inbox alerts (every human message, not just the two we already recognised) ---
  // SHIPS OFF, and gated INDEPENDENTLY of `enabled` above: turning on inbox alerts must not also turn
  // on order ingest and buyer messaging. When this is on and `enabled` is off, startPostsaleJobs arms
  // the message timer and nothing else.
  inbox_alerts: {
    enabled: false,
    // 'All' widens GetMemberMessages past AskSellerQuestion to every member-to-member type. eBay
    // documents both values; keep AskSellerQuestion as the retreat if a live account rejects All.
    message_types: 'All',
    max_alerts_per_run: 10,     // a flood is told about once, not fifty times (the rest are counted)
    preview_chars: 400,
    mark_read_button: true,     // costs one GetMyMessages header sweep per pass to map the other id
    nag_after_hours: 6,         // a message left six hours is a message somebody forgot
    nag_max: 2,                 // then it stops shouting; silence beats an alarm you learn to ignore
    nag_window_hours: 168,      // stop re-reading a thread after a week, answered or not
    inbox_url: '',              // '' = lib/ebay-links.mjs messagesUrl(); set it when eBay moves the page
  },
  // --- deal requests (a buyer asking for a keener price, or one lot of postage) ---
  // SHIPS OFF. Detection writes a row and nothing else — no message, no price, no eBay call — but it
  // is still a new queue appearing in the dashboard, so it is opt-in like every other capability here.
  deals: {
    enabled: false,
    detect_from_messages: true,   // run classifyDealAsk over incoming AskSellerQuestion messages
    expire_hours: 72,             // a quote nobody acted on stops being offered
  },
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
      // One-time: a config seeded before {{when}} existed carries the old fixed sentence, which has
      // no slot for the same-day wording. Turning same-day on would then leave the AI lane still
      // promising next-business-day while the template lane said "later today" — the exact drift
      // shipTiming() exists to kill. Exact-match only: a sentence the owner has edited is his.
      const OLD_SHIP_TIMING = 'packed and sent the next business day';
      if (raw.ship_timing_text === OLD_SHIP_TIMING) {
        raw.ship_timing_text = DEFAULT_CONFIG.ship_timing_text;
        missing.push('ship_timing_text → {{when}} template');
      }
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
      // Same reasoning one level down for inbox_alerts, which the settings form also addresses by
      // path (inbox_alerts.enabled). The top-level backfill above only fires when the whole block is
      // absent, so a release that ADDS a key to it would otherwise render that field as an empty box.
      if (raw.inbox_alerts && typeof raw.inbox_alerts === 'object') {
        for (const [k, v] of Object.entries(DEFAULT_CONFIG.inbox_alerts)) {
          if (!(k in raw.inbox_alerts)) { raw.inbox_alerts[k] = v; missing.push('inbox_alerts.' + k); }
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
      // Merged rather than replaced so a config carrying only { enabled: true } keeps expire_hours and
      // detect_from_messages rather than silently losing them to undefined.
      deals: { ...DEFAULT_CONFIG.deals, ...(raw.deals || {}) },
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
    // PER UNIT, and the count beside it. This used to write `saleUnitCents * qty` — a LINE TOTAL — into
    // a column summarizeInventory documents as per-unit and then multiplied by quantity again. The
    // same statement zeroes quantity, so `r.quantity || 1` yielded 1 and the double never showed: what
    // showed instead was COGS charged once for a whole lot, overstating profit by cost x (qty - 1).
    tdb.prepare(`UPDATE inventory_items SET quantity = 0, status = 'sold', channel_status = 'ended',
                 sold_at = COALESCE(sold_at, datetime('now')), sale_price_cents = COALESCE(sale_price_cents, ?),
                 sale_qty = COALESCE(sale_qty, ?), updated_at = datetime('now') WHERE id = ?`)
      .run(saleUnitCents != null ? Math.round(saleUnitCents) : null, qty, itemId);
    return { ok: true, sold: true, newQty: 0, effect: mkEffect(true) };
  }
  tdb.prepare(`UPDATE inventory_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(newQty, itemId);
  return { ok: true, sold: false, newQty, effect: mkEffect(false) };
}
// Decrement a sealed item through its placements (never write sealed_items.quantity directly when
// placements exist — the multi-location mirror rule); falls back to the scalar quantity when it has none.
export function decrementSealedItem(tdb, itemId, qtySold, saleUnitCents = null) {
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
    // The sale itself is RECORDED, which it never was. decrementSealedItem was called with three
    // arguments while its inventory twin on the same line got li.unit_price_cents, and neither of its
    // UPDATEs wrote sale_price_cents or sold_at — so summarizeSealed read NULL revenue and multiplied
    // the cost by a quantity this statement had just set to zero. An automated sealed sale contributed
    // exactly $0.00 to realized P&L: not mis-stated, invisible.
    tdb.prepare(`UPDATE sealed_items SET quantity = ?, location = ?, status = ?, channel_status = ?,
                 sold_at = CASE WHEN ? THEN COALESCE(sold_at, datetime('now')) ELSE sold_at END,
                 sale_price_cents = CASE WHEN ? THEN COALESCE(sale_price_cents, ?) ELSE sale_price_cents END,
                 sale_qty = CASE WHEN ? THEN COALESCE(sale_qty, 0) + ? ELSE sale_qty END,
                 updated_at = datetime('now') WHERE id = ?`)
      .run(total, firstLoc, sold ? 'sold' : item.status, sold ? 'ended' : item.channel_status,
        sold ? 1 : 0, sold ? 1 : 0, saleUnitCents != null ? Math.round(saleUnitCents) : null,
        sold ? 1 : 0, qty, itemId);
    return { ok: true, sold, newQty: total, effect: mkEffect(total, touched) };
  }
  const newQty = Math.max(0, before.quantity - qty);
  const sold = newQty <= 0;
  tdb.prepare(`UPDATE sealed_items SET quantity = ?, status = ?, channel_status = ?,
               sold_at = CASE WHEN ? THEN COALESCE(sold_at, datetime('now')) ELSE sold_at END,
               sale_price_cents = CASE WHEN ? THEN COALESCE(sale_price_cents, ?) ELSE sale_price_cents END,
               sale_qty = CASE WHEN ? THEN COALESCE(sale_qty, 0) + ? ELSE sale_qty END,
               updated_at = datetime('now') WHERE id = ?`)
    .run(newQty, sold ? 'sold' : item.status, sold ? 'ended' : item.channel_status,
      sold ? 1 : 0, sold ? 1 : 0, saleUnitCents != null ? Math.round(saleUnitCents) : null,
      sold ? 1 : 0, qty, itemId);
  return { ok: true, sold, newQty, effect: mkEffect(newQty, []) };
}

// applyStockDecrements(pdb) — sweep every line item of a PAID, uncancelled order that is not yet
// applied to stock; for each that matches a tracker row (SKU or ebay_item_id), decrement and stamp
// stock_applied_at (cross-DB idempotency). Unmatched lines are left for a later sweep (they'll match
// once the listing publishes).
//
// THE JOIN IS THE GUARD. This query used to be `WHERE stock_applied_at IS NULL` with no reference to
// `orders` at all, and this comment claimed it swept "every paid line item" — which was true only
// because pollOrders refused to ingest an unpaid order in the first place. That made the safety
// property depend on a caller three functions away, and it would have failed silently the moment an
// unpaid order reached the table for any reason. It is stated here now, where the write happens.
//
// The cancelled clause is not decoration either. An unmatched line stays pending forever (`if (!m)
// continue` below), while becameCancelled is a ONE-SHOT transition — so a line whose SKU publishes
// after its order was cancelled would be decremented against a dead order with no reversal left to
// run.
//
// The two writes below touch DIFFERENT databases (tracker.db then postsale.db) and cannot share a
// transaction, so a crash in between is possible. THE ORDER IS DELIBERATE AND IS THE SAFER ONE — do
// not "fix" it by stamping first:
//   decrement → stamp  (today): a crash re-decrements next run. Stock reads LOW, so we under-list.
//                               Visible, recoverable, costs a missed sale.
//   stamp → decrement:          a crash leaves the line claimed but the stock untouched. Stock reads
//                               HIGH, so we OVERSELL — a cancelled order, a seller defect, and a
//                               buyer who paid for a card that is gone.
// Under-listing is the failure we can afford; overselling is not. A real fix is two-phase (write an
// intent column + effect, decrement, then finalise; reconcile intent-without-applied rows on boot),
// which is worth doing only if this ever starts firing — see the note on `considered` vs `matched` in
// the poll log, which has sat at matched:0 while the pending list grew.
export function applyStockDecrements(pdb, tdbIn) {
  let tdb = tdbIn; try { tdb = tdb || openDb(); } catch { return { considered: 0, matched: 0, applied: 0, sold: 0, error: 'tracker_db' }; }
  const lookup = buildInventoryLookup(tdb);
  if (!lookup) return { considered: 0, matched: 0, applied: 0, sold: 0, error: 'no_lookup' };
  let hasCol = true;
  try { pdb.prepare('SELECT stock_applied_at FROM order_line_items LIMIT 1').get(); } catch { hasCol = false; }
  if (!hasCol) return { considered: 0, matched: 0, applied: 0, sold: 0, error: 'no_column' };
  // PAID_SQL and NOT_CANCELLED_SQL are the same predicates the pack queue uses, qualified to `o.` —
  // reused rather than restated so the sweep and the queue can never drift apart on what "safe to act
  // on" means.
  const PAID_O = PAID_SQL.replace(/paid_time/g, 'o.paid_time').replace(/payment_state/g, 'o.payment_state');
  const NOT_CANCELLED_O = NOT_CANCELLED_SQL.replace(/cancel_state/g, 'o.cancel_state');
  const lines = pdb.prepare(`SELECT li.id, li.order_id, li.ebay_item_id, li.sku, li.quantity, li.unit_price_cents
                             FROM order_line_items li JOIN orders o ON o.order_id = li.order_id
                             WHERE li.stock_applied_at IS NULL AND ${PAID_O} AND ${NOT_CANCELLED_O}`).all();
  let matched = 0, applied = 0, sold = 0;
  for (const li of lines) {
    const m = matchLineItem(lookup, { sku: li.sku, ebay_item_id: li.ebay_item_id });
    if (!m) continue;
    matched++;
    const r = m.kind === 'sealed' ? decrementSealedItem(tdb, m.id, li.quantity, li.unit_price_cents) : decrementInventoryItem(tdb, m.id, li.quantity, li.unit_price_cents);
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
// Three payment states hold an order, not one. 'failed' is a payment that bounced AFTER PaidTime;
// 'pending' is money still in flight; a NULL paid_time is an order nobody has paid for at all. Wrapped
// in its own parentheses because it now contains an OR and is composed into a larger expression.
const PAYMENT_HOLD_SQL = "(COALESCE(payment_state,'ok') IN ('failed','pending') OR paid_time IS NULL)";
export const HOLD_SQL = `(${CANCEL_HOLD_SQL} OR ${PAYMENT_HOLD_SQL})`;

// HAS THE MONEY ACTUALLY ARRIVED. Deliberately stricter than "paid_time is set", because PaidTime is
// eBay saying a payment was ATTEMPTED, not that it cleared: a bounced eCheck or a declined card is
// reported afterwards (see PAYMENT_STATUS_MAP above), and PayPalPaymentInProcess/PaymentInProcess mean
// the money is still in flight right now. Both must fail this test, or the one thing this predicate
// exists to prevent — cards leaving the building against money that never arrived — is exactly what it
// permits.
//
// Nothing in `orders` is unpaid TODAY: pollOrders drops those before ingest. This is the guard for the
// day that stops being true, whether through the invoice/quote work or any future change, and it is
// deliberately expressed at the same level as the cancellation rules so it cannot be forgotten the way
// a per-caller `if` would be.
export const PAID_SQL = "(paid_time IS NOT NULL AND COALESCE(payment_state,'ok') = 'ok')";
// A label-bought order is in the queue only UNTIL it is picked. label_bought_at is history and is
// never cleared, so without the picked_at clause those orders would sit in the queue forever.
export const IN_QUEUE_SQL = `(${NOT_CANCELLED_SQL} AND (shipped_status = 'unshipped' OR (label_bought_at IS NOT NULL AND picked_at IS NULL)))`;
// PAID_SQL sits HERE and not in IN_QUEUE_SQL, and the placement is load-bearing in two directions.
// Putting it in IN_QUEUE_SQL would define an unpaid order as 'shipped' (the shipped tab is literally
// NOT IN_QUEUE_SQL) and would drop it out of sweepOpenOrders' ACTIONABLE set, so the app would never
// learn the buyer had paid. Putting it here instead keeps an unpaid order visible and polled while
// making it unpackable. And it is here rather than only in HOLD_SQL because a hold is by design a
// human-overridable state — per-order buttons read NEEDS_PACKING_SQL precisely so somebody can decide
// to pack a held order anyway. There is no such decision to make about an order nobody has paid for.
export const NEEDS_PACKING_SQL = `(picked_at IS NULL AND ${PAID_SQL} AND ${IN_QUEUE_SQL})`;
// The orders eBay calls sent because a postage LABEL was bought, that nobody has packed yet. Its own
// name because it is its own kind of work: it is in the queue, but there is nothing left to tell eBay
// when it leaves — dispatchOrder short-circuits it. Additive on purpose; IN_QUEUE_SQL is untouched.
export const LABEL_BOUGHT_SQL = `(${NOT_CANCELLED_SQL} AND label_bought_at IS NOT NULL AND picked_at IS NULL)`;
// In the queue, and safe to pull WITHOUT anyone thinking about it. The distinction from
// NEEDS_PACKING_SQL is the whole point: bulk actions (the default pick sheet, "mark all picked") use
// this, while per-order buttons keep NEEDS_PACKING_SQL — a human looking at one held order may
// legitimately decide to pack it anyway, and that decision is theirs to make.
export const PICKABLE_SQL = `(${NEEDS_PACKING_SQL} AND NOT ${HOLD_SQL})`;

// The same rules against a row already in hand. Every one of these has an SQL twin above, and
// postsale-cancel.test.mjs runs the two against the same rows to prove they agree — so a caller may
// use whichever fits, and neither spelling can quietly drift from the other.
export function isCancelled(o) { return (o.cancel_state || 'none') === 'cancelled'; }
// A row that never SELECTed paid_time reads as undefined, which is indistinguishable from NULL by a
// falsy test — so a partial SELECT would silently make every order look unpaid (blocking all
// messaging) or, with the test written the other way, silently make every order look paid. Both are
// wrong and neither would raise a single error. node:sqlite gives a selected NULL column as null and
// omits an unselected one entirely, so the two ARE distinguishable, and this is the only place that
// has to know it. Throwing is the right severity: these predicates decide whether goods leave the
// building, and a 500 on a dashboard is a one-line fix while a wrong answer is a parcel.
function assertPaymentColumns(o, who) {
  if (!o || !('paid_time' in o)) {
    throw new Error(`postsale ${who}: row has no paid_time — add it to the SELECT. `
      + 'The payment guards cannot answer from a partial row.');
  }
}
// Twin of PAID_SQL. test/invariants/paid-gate.test.mjs runs both over the same rows.
export function isPaid(o) {
  assertPaymentColumns(o, 'isPaid');
  return o.paid_time != null && (o.payment_state || 'ok') === 'ok';
}
// Why an order is held, in the words the pick sheet and the dashboard both print. isOnHold is defined
// in terms of this rather than repeating the three conditions in a different order.
export function holdReason(o) {
  assertPaymentColumns(o, 'holdReason');
  // Order matters: these are the words label-render.js prints on the DO-NOT-PACK banner, and "not paid
  // yet" and "payment failed" call for different actions from the packer.
  if (!o.paid_time) return 'not paid yet';
  if ((o.payment_state || 'ok') === 'pending') return 'payment not settled';
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
export function needsPacking(o) { return !o.picked_at && isPaid(o) && inQueue(o); }
// What a BULK action may touch — the dashboard ships this as o.pickable so no client re-derives it.
// Callers that already read through IN_QUEUE_SQL have cancelled orders excluded for them and only need
// the hold test; the pick sheet is the one place that states both, because its ids= branch is allowed
// to override a hold but never a cancellation.
export function pickable(o) { return needsPacking(o) && !isOnHold(o); }
export function isLabelBought(o) { return !isCancelled(o) && !!o.label_bought_at && !o.picked_at; }

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
        : isLabelBought(o) ? 'label_bought'
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
    // WHAT WAS BOUGHT BEATS WHAT WAS CHOSEN.
    //
    // classifyPostage can only read ShippingServiceSelected/ShippingService — the service the BUYER
    // picked at checkout — and eBay never rewrites that when the seller later buys a different label.
    // Upgrade a $1.70 letter to a tracked service and GetOrders still reports AU_AusPostStandardLetter
    // for the life of the order. So the slip printed "Regular letter" on a parcel that went tracked
    // and, worse because it reaches the customer, the automated dispatch message said "It's going
    // Regular letter" immediately above the tracking number it was handing them.
    //
    // A tracking number is the only evidence we ever get about the label actually bought: the shipment
    // block carries ShippingCarrierUsed and ShipmentTrackingNumber and nothing else, so the real
    // service NAME is not recoverable at any price. What the number proves is that the parcel is
    // TRACKED — it does not prove express, so this lifts the tier to `tracked` and never past it.
    //
    // THIS LIVES HERE AND NOT IN classifyPostage, and the placement is load-bearing. classifyPostage
    // also feeds postageColumns, which WRITES postage_tier/postage_label/postage_tracked to the row.
    // Those columns describe what a SERVICE CODE means, and observedServices groups by them to tell
    // the settings UI when one code has classified more than one way — its `mixed` flag. Push
    // per-parcel evidence through there and every ordinary letter service starts reporting itself as
    // mixed, which is the settings UI's one signal that a service is mis-read. Deriving it on the read
    // path instead also means the correction applies to orders already in the DB on the next page
    // load, with no backfill and no re-poll.
    //
    // The buyer's own service name is KEPT rather than replaced: "Regular letter" is what they paid
    // for and what their invoice says, and we cannot name what it was upgraded to. `tracked_evidence`
    // is how the slip and the dispatch message say the second half out loud.
    // Both shapes, for the same reason classifyPostage's pick() adapter handles both: every caller
    // here passes a SQLite row today, but a parsed eBay order carries trackingNumber, and reading only
    // one spelling means the day somebody hands this the other one the tier silently falls back to the
    // buyer's checkout choice with no error — which is precisely the bug this block exists to fix,
    // failing quietly.
    const trackingSeen = o.tracking_number || o.trackingNumber || null;
    const trackedEvidence = !!trackingSeen && !isUpgrade(p.tier);
    const tier = trackedEvidence ? 'tracked' : p.tier;
    o.postage = {
      tier,
      upgrade: isUpgrade(tier),
      tracked: trackedEvidence ? true : p.tracked,
      tracked_evidence: trackedEvidence,
      // Deliberately still keyed on p.tier, not the lifted one: an unreadable service code falls back
      // to the phrase for what the BUYER chose. A tracking number is not permission to rename their
      // service to "Tracked parcel".
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
    // IF EBAY FLIPPED IT AND WE DID NOT, A LABEL WAS BOUGHT. That is the whole rule, and it is
    // deliberately not a judgement call any more.
    //
    // This used to try to separate two events that arrive through the same flag: a postage label being
    // BOUGHT (cards still on the shelf, work outstanding) versus the seller bulk-ticking "mark as
    // dispatched" in Seller Hub for parcels that had already gone (no work left). The test was "a
    // bought label carries a tracking number".
    //
    // THAT TEST IS FALSE IN AUSTRALIA. An eBay-bought Australia Post Regular Letter label is untracked:
    // no number ever reaches GetOrders, and the checkout service classifies untracked too. Every one of
    // those scored "already gone" and settled straight to posted — so the order vanished off the
    // fulfilment page at the exact moment the label was bought, which is before anyone has printed a
    // packing slip for it. Five orders left that way before it was noticed, and the only reason it was
    // survivable is that the cards did eventually get posted.
    //
    // There is no signal left that tells the two events apart, so we stop pretending there is one and
    // keep the case that is recoverable. An order held here costs one tap of "Packed & posted"; an
    // order settled wrongly costs a parcel nobody can find the paperwork for. The three guards below
    // are what keep this honest — a dispatch of ours, a pick of ours, or a stamp already made all mean
    // this is not eBay telling us something new.
    if (!prev.dispatch_source && !prev.picked_at && !prev.label_bought_at) {
      next.label_bought_at = nowSql();
    }
    // else: nothing more to write, and that is the point. shipped_status='shipped' with no
    // label_bought_at IS the settled state — inQueue() goes false, attachFulfilment calls it 'posted',
    // and dispatch_source='ebay' is what the dashboard's "via eBay" badge already reads. picked_at is
    // deliberately NOT stamped: it means a human HERE pulled and packed the cards, and a poll cannot
    // honestly assert that. A button may (see dispatchOrder); a background job may not.
  }

  const changed = Object.keys(next).filter((k) => String(prev[k] ?? '') !== String(next[k] ?? ''));
  if (!changed.length) {
    return { updated: false, changed: [], gotTracking: false, gotDelivered: false, becameShipped: false,
      labelBought: false, settledAlreadyOurs: false,
      becameCancelled: false, holdMove: null, cancelState: nextCancel, paymentState: nextPayment };
  }

  const pcfg = (cfg && cfg.postage) || {};
  const messagingOn = cfg.messaging !== false;
  const queued = [];
  let closedMessages = 0, staleDrafts = [];
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
      // And any draft for this buyer's OTHER orders is now stale, because the repeat-buyer context is
      // built from what they have bought before — so a sibling thank-you can be sitting in Telegram
      // saying "hope it looks right at home with your X" about the very cards being refunded. Undecided
      // drafts go back to 'pending' so they are rewritten from the corrected history; their live cards
      // are stamped by the caller, outside this transaction.
      staleDrafts = db.prepare(`SELECT * FROM postsale_messages
                                WHERE buyer_id=? AND order_id<>? AND status IN ('drafted','awaiting_approval')`)
        .all(prev.buyer_id, o.orderId);
      if (staleDrafts.length) {
        db.prepare(`UPDATE postsale_messages SET status='pending', subject=NULL, body=NULL, error=NULL,
                    telegram_chat_id=NULL, telegram_message_id=NULL, updated_at=datetime('now')
                    WHERE id IN (${staleDrafts.map(() => '?').join(',')})`).run(...staleDrafts.map((m) => m.id));
      }
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }

  // A cancelled order is not a purchase: it must not inflate lifetime spend, and it must not make a
  // one-time buyer read as a repeat one (that flag drives both the ⭐ on the sale alert and the model's
  // context). Outside the transaction — it is a single UPDATE and never worth failing the refresh over.
  if (becameCancelled && prev.buyer_id) {
    try { recomputeBuyer(db, prev.buyer_id); } catch (e) { console.warn('[postsale] recomputeBuyer failed —', e?.message || e); }
  }

  // Which of the two shipment branches ran, reported rather than left for each caller to re-derive
  // from the columns — the poll, the sweep and the tests all want to know, and three spellings of the
  // same question is how they drift.
  return { updated: true, changed, gotTracking, gotDelivered, becameShipped, queued,
    // Renamed with the rule it reports on. This no longer means "eBay settled it for us" — under the
    // old discriminator that was the untracked-letter case, which is now the one thing that always
    // stamps. It means the flip landed on an order we had ALREADY handled here, so nothing new was
    // parked. Only the tests read it, and leaving the old name is how the next reader gets it wrong.
    labelBought: !!next.label_bought_at, settledAlreadyOurs: becameShipped && !next.label_bought_at,
    becameCancelled, holdMove, cancelState: nextCancel, paymentState: nextPayment,
    closedMessages, staleDrafts };
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
// A few card titles this buyer bought on EARLIER orders, for the repeat-buyer "good to see you again".
//
// The copy this feeds says things like "hope it looks right at home with your X" — it asserts the buyer
// HAS the card. So an order that was cancelled must never appear here: warmly reminding somebody of
// three cards they never received, on the same day you refunded them, is worse than saying nothing.
// A held order is excluded for the same reason — a cancellation still in flight, or a payment that
// failed, may well never become a card in their hands.
//
// The predicates are unqualified `cancel_state`/`payment_state`, which resolve to the orders alias
// because order_line_items has no such columns (same reliance as digestOrders).
export function priorCardsFor(db, buyerId, excludeOrderId) {
  return db.prepare(`SELECT DISTINCT li.title FROM order_line_items li JOIN orders o ON o.order_id = li.order_id
                     WHERE o.buyer_id = ? AND o.order_id != ? AND li.title IS NOT NULL
                       AND ${NOT_CANCELLED_SQL} AND NOT ${HOLD_SQL}
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
  // A same-day promise has a shelf life. The body is frozen at draft time and sent verbatim
  // whenever someone taps ✅, so "we'll get this packed and sent later today", drafted at 11:55 and
  // approved at 21:30, is a promise the buyer can check and we have already broken. Recomputing
  // what the timing was at draft time and what it is now is enough to spot that, with no new column.
  //
  // Rewriting the phrase in the stored body was the obvious alternative and is worse: the body is
  // model prose, so "later today" may have become "this arvo" or been folded into a clause, and a
  // find-and-replace that misses ships a lie. Refusing and redrafting cannot miss.
  //
  // updated_at, NOT created_at: created_at is stamped when the order is ingested and is never
  // touched again, so a redraft would keep testing the original timestamp and re-queue the
  // corrected text forever. updated_at moves with every write, including this re-queue and the
  // redraft that follows, so the second approve sees a draft written after the cut-off and lets it
  // through.
  if (cfg.same_day_dispatch === true && msg.kind === 'purchase' && msg.updated_at) {
    const opts = { tz: cfg.timezone, holidays: cfg.holidays, cutoff: cfg.same_day_cutoff };
    // SQLite datetime('now') is UTC, space-separated, with no zone marker. Parsed raw it reads as
    // LOCAL time and lands ten hours out on an AEST box.
    const drafted = new Date(String(msg.updated_at).replace(' ', 'T') + 'Z');
    if (!Number.isNaN(drafted.getTime()) && dispatchDay(drafted, opts)?.sameDay && !dispatchDay(new Date(), opts)?.sameDay) {
      setMsg(db, msg.id, { status: 'pending', error: 'same-day promise expired, queued for a redraft' });
      return { ok: false, error: 'stale_same_day', detail: 'this draft promised same-day dispatch and the cut-off has passed, so it has been queued for a redraft' };
    }
  }
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
  // Feature off keeps the old basis, paid_time. On, the basis becomes the clock NOW, because "when
  // does this get packed" is a question about now, and because nextBusinessDay cannot return today
  // at all — an order paid 11pm Monday and drafted 00:05 Tuesday goes out that Tuesday, which only
  // dispatchDay can say.
  const now = new Date();
  const sameDay = cfg.same_day_dispatch === true;
  const shipBy = sameDay
    ? dispatchDay(now, { tz: cfg.timezone, holidays: cfg.holidays, cutoff: cfg.same_day_cutoff })
    : nextBusinessDay(order?.paid_time ? new Date(order.paid_time) : now, { tz: cfg.timezone, holidays: cfg.holidays });
  // One object, both lanes, so they cannot phrase the same parcel two different ways. Computed
  // whether or not same-day is on: the toggle decides whether TODAY is a possible answer, not
  // whether the sentence gets built. Skipping it when off would feed the prompt a raw
  // "packed and sent {{when}}" — and would leave the buyer-timezone guard off for "tomorrow" too,
  // which is just as wrong a word for someone whose date is not ours.
  const timing = shipTiming({ shipBy, order, cfg, now });
  const pcfg = cfg.postage || {};
  // The follow-ups are about the parcel, so they get the same postage view the dashboard renders.
  const postage = kind === 'purchase' ? {} : attachPostage([{ ...order }], cfg)[0].postage;
  // The tracking number is stamped on, never written by the model — see dispatchFacts. `stamp` is
  // applied to whichever draft wins (model or template) so both carry identical, correct facts.
  const facts = kind === 'dispatch' ? dispatchFacts(postage, pcfg) : { text: '', allow: [] };
  const stamp = (b) => (facts.text ? String(b).trim() + '\n\n' + facts.text : String(b).trim());

  const d = await draftMessage({ order, items, buyer, priorCards, cfg, env, shipBy, timing, kind, postage });
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
      ? fallbackDraft({ order, items, cfg, shipBy, timing, now })
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
  // paid_time is SELECTed because isOnHold/holdReason now answer on it — without it assertPaymentColumns
  // throws, which is the design: this gate is why an unpaid buyer is never thanked for a purchase that
  // has not happened, or told a parcel is coming.
  const ord = db.prepare('SELECT cancel_state, payment_state, paid_time FROM orders WHERE order_id=?').get(orderId);
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
// ---- deal request → Telegram --------------------------------------------------------------------
// The card announces that somebody is waiting and carries enough to decide; the DASHBOARD is where a
// discount gets typed, because a phone is a poor place to enter a number that spends money. So Send
// only appears once a figure already exists, and before that the only action is to go and set one.

/** Everything renderDealCard needs, from the row + its lines + a fresh quote. */
function dealCardMeta(db, id, cfg) {
  const d = getDeal(db, id);
  if (!d) return null;
  const lines = getDealLines(db, id);
  const q = quoteDeal(db, id, d.discount_cents == null ? null : d.discount_cents);
  const s = q && q.summary;
  let matched = [];
  try { matched = JSON.parse(d.matched_terms || '[]'); } catch { /* free text is not worth a crash */ }
  return {
    deal: d,
    quote: q,
    meta: {
      buyerUsername: d.ebay_username, kind: d.detected_kind, matched, source: d.source, lines,
      subtotalText: s ? money(s.subtotalCents) : null,
      discountText: q && q.ok && q.discountCents ? money(q.discountCents) : null,
      postageText: s ? money(s.postageCents) : null,
      bandLabel: s ? s.bandLabel : null,
      boundBy: s ? s.boundBy : null,
      totalText: q && q.ok && q.totalCents != null ? money(q.totalCents) : null,
      costText: s && s.costBasisCents != null ? money(s.costBasisCents) : null,
      costComplete: !s || s.costBasisComplete,
      warnings: (q && q.warnings) || (q && q.ok === false ? [{ message: q.error || q.message }] : []),
      dryRun: !!cfg.dry_run,
    },
  };
}

// A quote with no figure yet gets no Send button — there is nothing to send. Skip is always offered,
// because "not this one" is a decision worth making from a phone.
function dealButtons(id, cfg, hasTotal) {
  const rows = [];
  if (hasTotal) rows.push([{ text: '💸 Send invoice', data: `psi:${id}` }, { text: 'Skip', data: `psin:${id}` }]);
  else rows.push([{ text: 'Skip', data: `psin:${id}` }]);
  if (cfg && cfg.dashboard_url) {
    rows.push([{ text: '✏️ Price it in the dashboard', url: String(cfg.dashboard_url).replace(/\/$/, '') + '/postsale.html' }]);
  }
  return rows;
}

export async function pushDealCard(env, db, id, cfg = DEFAULT_CONFIG) {
  if (!telegramEnabled(env) || !telegramChatConfigured(env)) return { ok: false, skipped: 'no_telegram' };
  const m = dealCardMeta(db, id, cfg);
  if (!m) return { ok: false, error: 'no such deal' };
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  const r = await sendCard(env, {
    chatId, text: renderDealCard(m.meta), buttons: dealButtons(id, cfg, !!m.meta.totalText),
  });
  if (!r.ok) return { ok: false, error: r.description || 'send failed' };
  setDeal(db, id, { telegram_chat_id: String(chatId), telegram_message_id: r.result.message_id });
  return { ok: true, chat_id: String(chatId), message_id: r.result.message_id };
}

/** Re-render the card in place. photo is explicitly false: these cards are text, and editCard treats
 *  anything other than a literal false as "try editMessageCaption first", which fails on a text card. */
async function editDealCard(env, db, id, cfg, decided, buttons) {
  const m = dealCardMeta(db, id, cfg);
  if (!m || !m.deal.telegram_message_id) return;
  await editCard(env, {
    chatId: m.deal.telegram_chat_id, messageId: m.deal.telegram_message_id,
    text: renderDealCard(m.meta, decided), buttons: buttons || [], clearButtons: !buttons, photo: false,
  });
}

/**
 * psi: arm · psiy: confirm · psin: skip.
 *
 * TWO TAPS, like the digest dispatch and unlike the message approve. An invoice cannot be undone from
 * a phone, and the first tap is where the amount is read back — so the second is a decision about a
 * specific figure rather than a reflex on a notification.
 */
async function onDealAction(env, db, cq, cfg, action, dealId, who) {
  const answer = (text, showAlert) => answerCallbackQuery(env, { id: cq.id, text, showAlert });
  const d = getDeal(db, dealId);
  if (!d) return answer('Deal not found');
  if (d.status !== 'pending' && d.status !== 'awaiting_approval') return answer('Already ' + d.status);

  if (action === 'n') {                              // skip / back out
    const done = db.prepare("UPDATE deal_requests SET status='skipped', decided_by=?, decided_at=?, updated_at=datetime('now') WHERE id=? AND status IN ('pending','awaiting_approval')")
      .run(who, nowSql(), dealId).changes > 0;
    if (!done) return answer('Already decided');
    await answer('Skipped');
    return editDealCard(env, db, dealId, cfg, { icon: '⏭', status: 'Skipped', who });
  }

  const m = dealCardMeta(db, dealId, cfg);
  if (!m || !m.meta.totalText) {
    return answer('No discount worked out yet — price it in the dashboard first', true);
  }

  if (action === '') {                               // psi: — are you sure?
    await answer();
    return editDealCard(env, db, dealId, cfg,
      { icon: '⚠️', status: `Invoice ${m.meta.totalText}?`, who,
        detail: cfg.dry_run ? 'Dry run is ON, so nothing will actually be sent to eBay.' : 'This invoices the buyer. It cannot be undone from here.' },
      [[{ text: `⚠️ Yes, invoice ${m.meta.totalText}`, data: `psiy:${dealId}` }, { text: 'Cancel', data: `psin:${dealId}` }]]);
  }

  // action === 'y' — confirmed. Answer and show the work BEFORE the eBay round trip: SendInvoice plus
  // the verify read takes longer than Telegram keeps a spinner alive, and the buttons would sit there
  // looking tappable.
  await answer(cfg.dry_run ? 'Recording…' : 'Sending…');
  await editDealCard(env, db, dealId, cfg, { icon: '⏳', status: 'Sending…', who }, []);

  const r = await sendDealInvoice(env, db, dealId, cfg, { discountCents: d.discount_cents });
  if (!r.ok) {
    return editDealCard(env, db, dealId, cfg,
      { icon: '⚠️', status: 'Not sent', who, detail: r.error || r.code || 'refused' });
  }
  return editDealCard(env, db, dealId, cfg,
    { icon: r.dry_run ? '🧪' : '✅', status: r.dry_run ? 'Recorded (dry run)' : 'Invoice sent', who,
      detail: r.dry_run ? 'Nothing was sent to eBay.' : null });
}

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
  // Say which of the two things happened. An order eBay had already dispatched was only written down,
  // and a card that calls that "dispatched" is claiming a message was sent that never was.
  const only = r.recorded && !r.dispatched;
  const word = only ? 'recorded' : 'dispatched';
  const alsoRecorded = r.recorded && r.dispatched ? `, ${r.recorded} already dispatched on eBay` : '';
  const done = r.failed.length
    // A failed eBay write leaves that order unshipped ON PURPOSE, so it stays in tomorrow's digest to
    // retry. Naming the ids is the difference between a retry and a hunt.
    ? { icon: '⚠️', status: `${r.ok} of ${r.total} ${word}${alsoRecorded}${only ? '' : dry}`, who,
        detail: `${r.failed.length} failed and stayed in the queue: ${r.failed.map((f) => f.order_id).join(', ')}` }
    : { icon: '✅', status: `All ${r.ok} ${word}${alsoRecorded}${only ? '' : dry}`, who };
  return editDigestMessage(env, db, digestId, 'dispatch', { done: { dispatch: done }, buttons: [] });
}

// The card text, in one place, because the alert and every later re-stamp have to be the same card
// with a footer added — a re-stamp that rebuilt it differently would look like a different message.
function inboxCardText(db, row, ic, decided) {
  return renderInboxMessage({
    senderId: row.sender_id,
    subject: row.subject,
    preview: stripQuotedHistory(row.body || ''),
    itemTitle: itemTitleFor(db, row.ebay_item_id),
    status: row.status,
    unread: row.is_read == null ? undefined : !row.is_read,
    receivedText: sinceText(row.creation_time),
    previewChars: ic.preview_chars,
  }, decided);
}

// Re-draw the card a tap just changed. Never fatal: the database is the record and Telegram is the
// notification, so a failed edit must not undo an action that already happened.
async function restampInboxCard(env, db, messageId, cfg, decided) {
  const row = db.prepare('SELECT * FROM member_messages WHERE message_id=?').get(messageId);
  if (!row || !row.telegram_chat_id || !row.telegram_message_id) return { skipped: 'no_card' };
  const buttons = inboxButtons(cfg, row);
  try {
    return await editMessageText(env, {
      chatId: row.telegram_chat_id, messageId: row.telegram_message_id,
      text: inboxCardText(db, row, inboxCfg(cfg), decided),
      buttons, clearButtons: !buttons.length,
    });
  } catch (e) { console.warn('[postsale/inbox] card re-stamp failed —', e?.message || e); return { ok: false }; }
}

// pmr: mark read on eBay · pmd: handled, stop nagging.
async function onInboxAction(env, db, cq, cfg, action, messageId, who) {
  const answer = (text, showAlert = false) => answerCallbackQuery(env, { id: cq.id, text, showAlert });
  const row = db.prepare('SELECT * FROM member_messages WHERE message_id=?').get(messageId);
  if (!row) return answer('Message not found');

  if (action === 'd') {
    // Atomic claim, like every other decided-once button here: a double tap changes 0 rows and is
    // told so, rather than stamping a second person's name over the first.
    const claimed = db.prepare(`UPDATE member_messages SET handled_at=datetime('now'), handled_by=?
                                WHERE message_id=? AND handled_at IS NULL`).run(who, messageId).changes > 0;
    if (!claimed) {
      const now = db.prepare('SELECT handled_by FROM member_messages WHERE message_id=?').get(messageId);
      return answer('Already handled' + ((now && now.handled_by) ? ' by ' + now.handled_by : ''));
    }
    await answer('Handled — no more reminders');
    return restampInboxCard(env, db, messageId, cfg, { icon: '✔️', status: 'Handled', who });
  }

  // action === 'r' — mark it read in the eBay inbox.
  if (row.marked_read_at) return answer('Already marked read');
  // The two ids are not interchangeable (see lib/ebay-trading.mjs): ReviseMyMessages needs the My
  // Messages one, and it arrives on a separate header sweep. Saying so beats a button that fails.
  if (!row.my_message_id) return answer("eBay hasn't indexed this message yet — try again after the next check", true);
  const r = await reviseMyMessages(env, { messageIds: [row.my_message_id], read: true });
  if (!r.ok) {
    const why = (r.errors && r.errors[0] && (r.errors[0].shortMessage || r.errors[0].longMessage)) || r.ack || 'unknown error';
    return answer('eBay refused: ' + why, true);
  }
  db.prepare(`UPDATE member_messages SET marked_read_at=datetime('now'), is_read=1 WHERE message_id=?`).run(messageId);
  await answer('Marked read on eBay');
  return restampInboxCard(env, db, messageId, cfg, { icon: '✅', status: 'Marked read', who });
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
  // psi: arm · psiy: confirm · psin: skip. No collision with the alternations above (neither `i`, `iy`
  // nor `in` is one of their branches) nor with psk: (which needs a literal `k`) nor the repricer's
  // ap:/sk:. The real hazard is the opposite of a collision: an UNREGISTERED prefix falls through the
  // return below and is dropped silently, so the buttons would visibly do nothing.
  const dl = (cq.data || '').match(/^psi(y|n|):(\d+)$/);
  // pm*: the inbox alert's own buttons. A member message id is not always numeric (synthMessageId
  // mints `mm-<sha>` for the ones eBay sends without one), so this alternation takes anything after
  // the colon - and `pm` shares no prefix with `ps`, `ap` or `sk`, so it can collide with none of them.
  const inbox = (cq.data || '').match(/^pm(r|d):(.+)$/);
  if (!m && !dg && !ack && !dl && !inbox) return;     // not ours — another handler will claim it
  const cfg = loadConfig();
  // Authorisation first, before any lookup: an unauthorised tap must not even be able to probe which
  // message ids exist. Empty allowlist denies everyone (see isAllowedUser). This matters more for the
  // digest buttons than anywhere else in the app — one of them dispatches a whole day of orders.
  if (!isAllowedUser(cfg.telegram_allowed_user_ids, cq.from)) {
    console.warn('[postsale/telegram] denied ' + describeUser(cq.from) + ' (id ' + (cq.from && cq.from.id) + ') on ' + cq.data);
    return answerCallbackQuery(env, { id: cq.id, showAlert: true, text: denyCallbackText(cq.from, 'Post-sale') });
  }
  const who = describeUser(cq.from);
  if (inbox) return onInboxAction(env, db, cq, cfg, inbox[1], inbox[2], who);
  if (dl) return onDealAction(env, db, cq, cfg, dl[1], +dl[2], who);
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
/**
 * Stable id for a member message eBay sent us with no MessageID of its own (parseMemberMessages keeps
 * those as long as they carry a senderId). The key has to be derived from the MESSAGE, not from the
 * run that happened to read it: the previous form was `mm-<cursorISO>-<n>`, so the same message read
 * from two different cursors produced two different keys and slipped straight past the
 * ON CONFLICT(message_id) upsert as a duplicate row. Re-reads of one window are normal — the cursor
 * overlaps by design, and a nudge can start a run at any moment — so this must be idempotent.
 */
export function synthMessageId(mm) {
  const h = crypto.createHash('sha1');
  h.update(String(mm.senderId || ''));
  h.update('|');
  h.update(String(mm.creationTime || ''));
  h.update('|');
  h.update(String(mm.itemId || ''));
  h.update('|');
  h.update(String(mm.body || '').slice(0, 200));
  return 'mm-' + h.digest('hex').slice(0, 24);
}

/**
 * A buyer message that reads like an ask for a deal becomes a deal_requests row.
 *
 * Runs on EVERY message, including ones maybeHandleReply has already claimed as a reply. A repeat
 * buyer replying to a thank-you with "any chance of a bundle on these two?" is the single most
 * valuable version of this, and the reply handoff — which only says "over to a human" — would
 * otherwise be the whole response. The two are complementary: the handoff says somebody is talking,
 * the deal row says what they appear to want.
 *
 * Detection is not an action. Nothing is priced, sent, or promised here; the row is a proposal a
 * person reads. That is what lets classifyDealAsk lean towards firing.
 *
 * Returns true when a row was created.
 */
export function recordDealFromMessage(db, mm, cfg = DEFAULT_CONFIG) {
  // 0, not false: this returns the new row's ID, and one consistent falsy type keeps every caller and
  // test reading the same way.
  const deals = cfg.deals || {};
  if (!deals.enabled || deals.detect_from_messages === false) return 0;
  const cls = classifyDealAsk(mm.subject, mm.body);
  if (!cls.ask) return 0;
  const buyer = mm.senderId ? db.prepare('SELECT id FROM buyers WHERE ebay_username=?').get(mm.senderId) : null;
  const hours = Number(deals.expire_hours);
  const expires = Number.isFinite(hours) && hours > 0 ? "datetime('now','+" + Math.round(hours) + " hours')" : 'NULL';
  // ON CONFLICT DO NOTHING against uq_deal_open_message. The poll cursor overlaps by design and a
  // nudge can start a run at any moment, so the same message is re-read routinely — a second row for
  // it would mean a second card and a second Send button for one ask.
  const r = db.prepare(`INSERT INTO deal_requests
      (source, buyer_id, ebay_username, message_id, detected_kind, matched_terms, status, expires_at)
      VALUES ('message', ?, ?, ?, ?, ?, 'pending', ${expires})
      ON CONFLICT DO NOTHING`)
    .run(buyer ? buyer.id : null, mm.senderId || null, mm.messageId || synthMessageId(mm),
      cls.kind, JSON.stringify(cls.matched));
  // The ID, not a boolean: the caller needs it to push a card at the row it just made.
  return (r.changes || 0) > 0 ? Number(r.lastInsertRowid) : 0;
}

// --- eBay inbox alerts ---------------------------------------------------------------------------
//
// The gap this closes: pollMemberMessages has always stored every message it read, and until now
// member_messages was WRITE-ONLY. The only two things that could turn a message into a notification
// were maybeHandleReply (needs a known buyer with a prior sent message) and the deal classifier
// (needs deals.enabled, which ships off). A pre-sale question from a stranger reached nobody.

const num = (v, dflt) => (Number.isFinite(+v) && +v > 0 ? Math.round(+v) : dflt);
function inboxCfg(cfg) {
  const c = (cfg && cfg.inbox_alerts) || {};
  const d = DEFAULT_CONFIG.inbox_alerts;
  return {
    enabled: !!c.enabled,
    message_types: c.message_types || d.message_types,
    max_alerts_per_run: num(c.max_alerts_per_run, d.max_alerts_per_run),
    preview_chars: num(c.preview_chars, d.preview_chars),
    mark_read_button: c.mark_read_button !== false,
    nag_after_hours: num(c.nag_after_hours, d.nag_after_hours),
    nag_max: c.nag_max == null ? d.nag_max : Math.max(0, Math.round(+c.nag_max || 0)),
    nag_window_hours: num(c.nag_window_hours, d.nag_window_hours),
    inbox_url: (c.inbox_url || '').trim() || messagesUrl(),
  };
}
export function inboxAlertsOn(cfg) { return !!(cfg && cfg.inbox_alerts && cfg.inbox_alerts.enabled); }

// Our own eBay username, so a message WE sent can be dropped before it becomes an alert about
// ourselves. MailMessageType 'All' widens past AskSellerQuestion (buyer-sent by definition) to types
// that can carry either direction, and the post-sale messenger is itself a prolific sender. Cached in
// meta because it never changes and GetUser is a whole round trip.
async function ourEbayUsername(env, db) {
  const cached = getMeta(db, 'ebay_username');
  if (cached) return cached;
  try {
    const r = await getUser(env);
    const u = (r && r.ok && r.userId) || null;
    if (u) { setMeta(db, 'ebay_username', u); return u; }
  } catch (e) { console.warn('[postsale/inbox] could not resolve our eBay username -', e?.message || e); }
  return null;                                   // unknown: alert on everything rather than nothing
}

// The listing title, for the "re:" line. Ours if we have sold it; otherwise the card just carries the
// subject, which is what eBay shows the buyer anyway.
function itemTitleFor(db, ebayItemId) {
  if (!ebayItemId) return null;
  const r = db.prepare('SELECT title FROM order_line_items WHERE ebay_item_id=? AND title IS NOT NULL ORDER BY id DESC LIMIT 1').get(String(ebayItemId));
  return (r && r.title) || null;
}

// "4 min ago" / "7 hours" - a duration a person can act on, from an ISO timestamp they can't.
function sinceText(iso, { suffix = ' ago' } = {}) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${suffix}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'}${suffix}`;
  return `${Math.round(hrs / 24)} days${suffix}`;
}

// Links first, actions second - the two rows do different jobs, and a tap on the wrong one should not
// be one pixel from a tap on the right one. `Item` is offered only when there IS an item: a button
// that leads nowhere is worse than no button.
function inboxButtons(cfg, row) {
  const ic = inboxCfg(cfg);
  const links = [{ text: '📬 eBay Messages', url: ic.inbox_url }];
  const item = row.ebay_item_id ? itemUrl(row.ebay_item_id) : null;
  if (item) links.push({ text: '🔗 Item', url: item });
  const actions = [];
  // Telegram rejects callback_data over 64 BYTES, and it rejects the whole sendMessage with it. That
  // would fail the alert, leave alert_sent_at unstamped, and re-fail on every pass forever - so an
  // id too long to carry costs its buttons, not the card. eBay ids and our own mm-<sha> are far
  // inside the limit; this is the guard for the one that is not.
  const fits = (d) => Buffer.byteLength(d, 'utf8') <= 64;
  const act = (text, data) => { if (fits(data)) actions.push({ text, data }); };
  // No mapped id means ReviseMyMessages has nothing to name, so the button is left off rather than
  // offered and then apologised for. The header sweep usually fills it in on the same pass.
  if (ic.mark_read_button && row.my_message_id && !row.marked_read_at) {
    act('✅ Mark read', `pmr:${row.message_id}`);
  }
  if (!row.handled_at) act('✔️ Handled', `pmd:${row.message_id}`);
  return actions.length ? [links, actions] : [links];
}

/**
 * One card for one message. Stamps alert_sent_at ONLY on a successful send, so a Telegram outage
 * delays the alert rather than swallowing it - the next pass re-reads the same window and tries
 * again. Same contract as fireSaleAlert.
 */
export async function fireInboxAlert(env, db, messageId, cfg, { send = sendMessage } = {}) {
  const ic = inboxCfg(cfg);
  if (!ic.enabled) return { skipped: 'disabled' };
  if (!telegramEnabled(env) || !telegramChatConfigured(env)) return { skipped: 'no_telegram' };
  const row = db.prepare('SELECT * FROM member_messages WHERE message_id=?').get(messageId);
  if (!row) return { skipped: 'no_row' };
  if (row.alert_sent_at) return { skipped: 'already_alerted' };
  const text = inboxCardText(db, row, ic);
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  // Quiet hours SILENCE an inbox alert, they do not suppress it: the message still landed, and a card
  // you find in the morning beats one that was never sent. The nag defers instead - see below.
  const r = await send(env, { chatId, text, buttons: inboxButtons(cfg, row), silent: inQuietHours(cfg) });
  if (!r.ok) return { ok: false, error: r.description || 'send failed' };
  db.prepare(`UPDATE member_messages SET alert_sent_at=datetime('now'), telegram_chat_id=?, telegram_message_id=?
              WHERE message_id=?`)
    .run(String(chatId), (r.result && r.result.message_id) || null, messageId);
  return { ok: true, message_id: r.result && r.result.message_id };
}

/**
 * Map GetMemberMessages ids onto My Messages ids, which is the only way to mark one read.
 *
 * ONE extra Trading call per poll pass, windowed to the period the poll just read. ReturnHeaders with
 * no MessageIDs returns the WHOLE mailbox, which is why the window is not optional. Failure is never
 * fatal: an unmapped row simply shows no Mark-read button.
 */
export async function mapMyMessageIds(env, db, { startTime, endTime, fetchHeaders = getMyMessages } = {}) {
  let mapped = 0;
  const res = await fetchHeaders(env, { detailLevel: 'ReturnHeaders', startTime, endTime });
  if (!res || !res.ok) return { ok: false, ack: res && res.ack, errors: res && res.errors, mapped };
  const upd = db.prepare('UPDATE member_messages SET my_message_id=?, is_read=? WHERE message_id=?');
  for (const h of res.headers || []) {
    if (!h.externalMessageId) continue;           // nothing to join on; not every My Message has one
    mapped += upd.run(h.messageId, h.read == null ? null : (h.read ? 1 : 0), h.externalMessageId).changes || 0;
  }
  return { ok: true, mapped, headers: (res.headers || []).length };
}

// `fetchMessages` / `fetchHeaders` / `send` are injectable for the same reason pollOrders takes
// fetchOrders: the rules worth testing here — one card per message, the self-filter, the per-run cap
// and the cursor — are only testable if the eBay reads and the Telegram writes can be answered
// offline. ES module exports are immutable, so an argument is the seam this repo uses.
export async function pollMemberMessages(env, db, { trigger = 'schedule',
  fetchMessages = getMemberMessages, fetchHeaders = getMyMessages, send = sendMessage } = {}) {
  const started = new Date();
  const cfg = loadConfig();
  const ic = inboxCfg(cfg);
  // Two independent reasons to run. Post-sale being off must not mean the eBay inbox goes unwatched,
  // and inbox alerts being on must not drag order ingest and buyer messaging along with them.
  if (!cfg.enabled && !ic.enabled) { _msgPoll.last_run = { at: started.toISOString(), trigger, skipped: 'disabled' }; return { ok: true, skipped: 'disabled' }; }
  try {
    const start = getMeta(db, 'messages_cursor') || new Date(Date.now() - Math.max(1, cfg.lookback_hours) * 3600_000).toISOString();
    const end = new Date().toISOString();
    // Resolved once per pass, before the loop, so the self-filter below costs no round trips per
    // message. Null means "we don't know who we are" and nothing is filtered - see ourEbayUsername.
    const me = ic.enabled ? await ourEbayUsername(env, db) : null;
    const mailMessageType = ic.enabled ? ic.message_types : 'AskSellerQuestion';
    let page = 1, seen = 0, replies = 0, deals = 0, alerts = 0, suppressed = 0, mine = 0;
    const alertable = [];
    while (page <= MAX_PAGES) {
      const res = await fetchMessages(env, { mailMessageType, startCreationTime: start, endCreationTime: end, page, entriesPerPage: 100 });
      if (!res.ok) { _msgPoll.last_run = { at: started.toISOString(), trigger, ok: false, ack: res.ack, errors: res.errors }; return { ok: false, ack: res.ack, errors: res.errors }; }
      for (const mm of res.messages) {
        seen++;
        // A message we sent is not news. Only reachable under 'All' - AskSellerQuestion is buyer-sent
        // by definition - but under 'All' the post-sale messenger's own output comes back at us.
        if (me && mm.senderId && String(mm.senderId).toLowerCase() === String(me).toLowerCase()) { mine++; continue; }
        const id = mm.messageId || synthMessageId(mm);
        db.prepare(`INSERT INTO member_messages (message_id, message_type, sender_id, ebay_item_id, subject, body, status, creation_time)
                    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET status=excluded.status, seen_at=datetime('now')`)
          .run(id, mm.messageType || mailMessageType, mm.senderId, mm.itemId, mm.subject, mm.body, mm.status, mm.creationTime);
        let claimed = false;
        try { if (await maybeHandleReply(env, db, mm)) { replies++; claimed = true; } } catch (e) { console.warn('[postsale] reply handoff failed —', e?.message || e); }
        // Deliberately NOT an else-branch of the reply handoff: a reply can be a deal ask too, and
        // that is the best kind. Its own try/catch so a classifier or schema problem cannot cost us
        // the message poll, which is the thing that has to keep working (GR7).
        try {
          const dealId = recordDealFromMessage(db, { ...mm, messageId: id }, cfg);
          if (dealId) {
            deals++;
            claimed = true;
            // The card is the whole point of detecting early: a deal ask goes cold, and the owner is
            // rarely at the dashboard. Failing to send one must not lose the ROW — the queue is the
            // durable half and Telegram is the notification, so this is caught separately.
            try { await pushDealCard(env, db, dealId, cfg); }
            catch (e) { console.warn('[postsale] deal card failed —', e?.message || e); }
          }
        } catch (e) { console.warn('[postsale] deal detection failed —', e?.message || e); }
        // ONE CARD PER MESSAGE, chosen by specificity: deal card > reply handoff > generic alert.
        // Both of the above already said something about this message, and a second card saying it
        // again teaches you that two notifications can mean one event.
        if (ic.enabled && !claimed) alertable.push(id);
      }
      if (!res.hasMore) break;
      page++;
    }
    // The My Messages id sweep runs ONCE for the window, after the reads and before the cards, so a
    // card can carry its Mark-read button on the first showing rather than the second.
    if (ic.enabled && ic.mark_read_button && alertable.length) {
      try {
        const m = await mapMyMessageIds(env, db, { startTime: start, endTime: end, fetchHeaders });
        if (!m.ok) console.warn('[postsale/inbox] My Messages id sweep failed — ack ' + m.ack + '; Mark-read buttons will be missing this pass');
      } catch (e) { console.warn('[postsale/inbox] My Messages id sweep failed —', e?.message || e); }
    }
    for (const id of alertable) {
      // Cap the cards, not the ROWS: everything is stored either way, and the overflow is counted and
      // named below rather than silently dropped.
      if (alerts >= ic.max_alerts_per_run) { suppressed++; continue; }
      try {
        const r = await fireInboxAlert(env, db, id, cfg, { send });
        if (r && r.ok) alerts++;
      } catch (e) { console.warn('[postsale/inbox] alert failed —', e?.message || e); }
    }
    if (suppressed) {
      try {
        await send(env, {
          chatId: (env.TELEGRAM_CHAT_ID || '').trim(), silent: inQuietHours(cfg),
          text: `📬 <i>…and ${suppressed} more message${suppressed === 1 ? '' : 's'} in this batch — open eBay Messages.</i>`,
          buttons: [[{ text: '📬 eBay Messages', url: ic.inbox_url }]],
        });
      } catch (e) { console.warn('[postsale/inbox] overflow notice failed —', e?.message || e); }
    }
    setMeta(db, 'messages_cursor', end);
    if (replies) console.log(`[postsale] reply-poll: ${replies} buyer repl${replies === 1 ? 'y' : 'ies'} → human handoff`);
    if (deals) console.log(`[postsale] deal-poll: ${deals} message(s) look like a deal ask → deal queue`);
    if (alerts || suppressed) console.log(`[postsale/inbox] ${alerts} alert${alerts === 1 ? '' : 's'} sent` + (suppressed ? `, ${suppressed} over the per-run cap` : ''));
    // The nag rides the same tick the way sweepOpenOrders rides the order poll: one timer, and the
    // cursor is already stamped, so a sweep failure cannot cost the window that was just read.
    let nags = null;
    if (ic.enabled) {
      try { nags = await sweepOpenMessages(env, db, cfg, { fetchMessages, fetchHeaders, send }); }
      catch (e) { console.warn('[postsale/inbox] nag sweep failed —', e?.message || e); }
    }
    _msgPoll.last_run = { at: started.toISOString(), finished_at: new Date().toISOString(), trigger, ok: true, seen, replies, deals, alerts, suppressed, mine, nags };
    return { ok: true, seen, replies, deals, alerts, suppressed, mine, nags };
  } catch (e) {
    _msgPoll.last_run = { at: started.toISOString(), trigger, ok: false, error: String(e?.message || e) };
    return { ok: false, error: String(e?.message || e) };
  }
}


/**
 * THE NAG. A message that was alerted, is still not answered, and is now hours old.
 *
 * Rides the message-poll tick the way sweepOpenOrders rides the order poll, and runs AFTER the cursor
 * is stamped so a failure here cannot cost the window that was just read.
 *
 * IT MUST NOT TOUCH messages_cursor. The refresh below deliberately re-reads a window the main poll
 * has already been through - that is the only way to learn that a message was answered, since eBay
 * offers no fetch-one-message-by-id on this call. Moving the cursor back to cover it would re-alert
 * every message in between; writing it forward would skip whatever arrived meanwhile. So it reads and
 * UPDATES existing rows only, and never inserts: a genuinely new message in that window belongs to
 * the main poll, which is what decides whether it gets a card.
 */
export async function sweepOpenMessages(env, db, cfg, { fetchMessages = getMemberMessages, fetchHeaders = getMyMessages, send = sendMessage } = {}) {
  const ic = inboxCfg(cfg);
  if (!ic.enabled || ic.nag_max <= 0) return { skipped: 'disabled' };
  const cursorBefore = getMeta(db, 'messages_cursor');
  const cutoff = Date.now() - ic.nag_window_hours * 3600_000;
  // "Not answered" rather than "explicitly Unanswered": under MailMessageType=All not every exchange
  // is guaranteed to carry a MessageStatus, and a missing one should not silently disable the whole
  // feature for that message type. nag_max is what stops this being a nuisance either way.
  const open = db.prepare(`SELECT * FROM member_messages
      WHERE alert_sent_at IS NOT NULL AND handled_at IS NULL
        AND (status IS NULL OR lower(status) <> 'answered')
        AND nag_count < ?
      ORDER BY creation_time ASC`).all(ic.nag_max)
    .filter((r) => { const t = Date.parse(r.creation_time || ''); return !Number.isFinite(t) || t >= cutoff; });
  if (!open.length) return { open: 0, refreshed: 0, nagged: 0, deferred: 0 };

  // Re-read from the oldest still-open message to now, and refresh what eBay now says about each.
  let refreshed = 0;
  const from = open[0].creation_time || new Date(cutoff).toISOString();
  const to = new Date().toISOString();
  try {
    const upd = db.prepare('UPDATE member_messages SET status=?, seen_at=datetime(\'now\') WHERE message_id=?');
    let page = 1;
    while (page <= MAX_PAGES) {
      const res = await fetchMessages(env, { mailMessageType: ic.message_types, startCreationTime: from, endCreationTime: to, page, entriesPerPage: 100 });
      if (!res.ok) { console.warn('[postsale/inbox] nag refresh failed — ack ' + res.ack); break; }
      for (const mm of res.messages) {
        refreshed += upd.run(mm.status, mm.messageId || synthMessageId(mm)).changes || 0;
      }
      if (!res.hasMore) break;
      page++;
    }
  } catch (e) { console.warn('[postsale/inbox] nag refresh failed —', e?.message || e); }

  // Older rows can predate the mark-read sweep, so fill in any id that is still missing. Conditional,
  // because in steady state every row already has one and this costs a whole Trading call.
  if (ic.mark_read_button && open.some((r) => !r.my_message_id)) {
    try { await mapMyMessageIds(env, db, { startTime: from, endTime: to, fetchHeaders }); }
    catch (e) { console.warn('[postsale/inbox] nag id sweep failed —', e?.message || e); }
  }

  // A nag DEFERS through quiet hours rather than arriving silently. The first card is news and is
  // worth a buzz whenever it lands; a reminder at 5am is just noise, and it will still be true at 8.
  if (inQuietHours(cfg)) {
    const due = open.filter((r) => nagDue(db, r, ic)).length;
    return { open: open.length, refreshed, nagged: 0, deferred: due };
  }

  let nagged = 0;
  for (const before of open) {
    const row = db.prepare('SELECT * FROM member_messages WHERE message_id=?').get(before.message_id);
    if (!row || row.handled_at) continue;
    if (String(row.status || '').toLowerCase() === 'answered') continue;   // refreshed out from under us
    if (!nagDue(db, row, ic)) continue;
    const text = renderInboxNag({
      senderId: row.sender_id, subject: row.subject,
      itemTitle: itemTitleFor(db, row.ebay_item_id),
      waitingText: sinceText(row.creation_time, { suffix: '' }),
      nagCount: (row.nag_count || 0) + 1,
    });
    try {
      const r = await send(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text, buttons: inboxButtons(cfg, row) });
      if (!r.ok) continue;
      // Stamped only on a successful send, like every other alert here.
      db.prepare(`UPDATE member_messages SET nag_count=nag_count+1, nag_sent_at=datetime('now') WHERE message_id=?`).run(row.message_id);
      nagged++;
    } catch (e) { console.warn('[postsale/inbox] nag failed —', e?.message || e); }
  }
  // The cursor is this function's one hard invariant, so it is asserted rather than assumed.
  if (getMeta(db, 'messages_cursor') !== cursorBefore) {
    console.error('[postsale/inbox] BUG: the nag sweep moved messages_cursor — that re-alerts or skips messages');
  }
  return { open: open.length, refreshed, nagged, deferred: 0 };
}

// Due when enough time has passed since the LAST thing we said about it — the first alert, or the
// previous nudge — so a second nag is nag_after_hours after the first, not after the message.
function nagDue(db, row, ic) {
  const last = row.nag_sent_at || row.alert_sent_at;
  if (!last) return false;
  const r = db.prepare("SELECT datetime(?, '+' || ? || ' hours') <= datetime('now') AS due").get(last, ic.nag_after_hours);
  return !!(r && r.due);
}

// One member-message poll at a time, whoever asked for it — the exact twin of runOrderPoll, and for
// the exact same reason: pollMemberMessages ends by stamping messages_cursor, so two overlapping runs
// let the slower one push the cursor past a window the faster one never read. Those buyer questions
// then sit outside every future window and no reply handoff ever fires for them. The scheduled tick
// and the DIAG /poll/messages route can already collide today; a notification nudge makes it routine.
// A caller arriving mid-run joins the run in progress instead of starting a second one.
let _msgPollInFlight = null;
export function runMemberMessagePoll(env, db, opts = {}) {
  if (_msgPollInFlight) return _msgPollInFlight;
  _msgPollInFlight = Promise.resolve(pollMemberMessages(env, db, opts)).finally(() => { _msgPollInFlight = null; });
  return _msgPollInFlight;
}

// --- the order-poll job ---
let _orderPoll = { last_run: null, next_run_at: null };
let _packDigest = { last_run: null };
// Floor between on-demand syncs (the dashboard's ↻). Long enough that leaning on the button can't
// spend the eBay call quota, short enough that "I just packed that, where is it" is one click away.
const MANUAL_SYNC_COOLDOWN_MS = 20_000;
let _lastManualSync = 0;

// `fetchOrders` is injectable for the same reason sweepOpenOrders and observeOrderEvents take one:
// the cursor rules are the part of this function that can lose a sale rather than delay one, and they
// are only testable if the window read can be answered offline. ES module exports are immutable, so
// an argument is the seam this repo uses.
export async function pollOrders(env, db, { trigger = 'schedule', expect = [], fetchOrders = getOrders } = {}) {
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
    // A window we did not finish reading must NOT move the cursor. Two caps stop this sweep early —
    // max_per_run, and running out of MAX_PAGES — and both leave orders in the window unread. The by-id
    // sweep cannot rescue them: it only refreshes orders we already hold, so anything skipped here falls
    // outside every future window and is silently lost, not late. Holding the cursor costs one refresh
    // per already-adopted order on the next poll (cheap, and refreshOrder is transition-based so it
    // fires nothing twice) and the next max_per_run of new orders get adopted instead.
    let truncated = false, morePages = false;
    const newOrders = [], queuedMessages = [], holdMoves = [], staleDrafts = [];
    const isKnown = db.prepare('SELECT 1 FROM orders WHERE order_id = ?');
    while (page <= MAX_PAGES) {
      // No orderStatus — eBay's default is "All". Asking for 'Completed' is what made a cancelled order
      // invisible: it stopped matching the filter the moment it stopped being completed, so it fell out
      // of every future window and sat in the pack queue with nothing able to remove it.
      const res = await fetchOrders(env, { modTimeFrom, modTimeTo, page, entriesPerPage: 100 });
      if (!res.ok) return finishPoll(started, trigger, { ok: false, error: 'GetOrders failed', ack: res.ack, errors: res.errors });
      morePages = !!res.hasMore;
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
            if (r.staleDrafts && r.staleDrafts.length) staleDrafts.push(...r.staleDrafts);
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
        if (cfg.max_per_run && ingested >= cfg.max_per_run) { truncated = true; break; }
      }
      if (truncated || !morePages) break;
      page++;
    }
    // Fell out of the loop with eBay still holding pages: MAX_PAGES ran out mid-window.
    if (morePages) truncated = true;
    // A push-triggered poll NAMES the orders it was told about, and that turns the window into a
    // checkable claim. eBay's order service can announce a sale a moment before GetOrders will return
    // it, and running seconds after the notification is exactly when that gap is open — so a window
    // that did not produce an expected order is a window we have not really read. Hold the cursor,
    // for the identical reason truncation does: moving it past an order nobody saw puts that order
    // outside every future window, which loses a sale rather than delaying one.
    //
    // The hold cannot get stuck. Only the notification path passes `expect`; the scheduled poll
    // passes none, so it always drains the window and releases the cursor — including for an order
    // eBay announced and then never returned at all.
    const awaiting = expect.filter((id) => !isKnown.get(id));
    if (awaiting.length) {
      console.warn(`[postsale] order-poll: eBay has not returned ${awaiting.length} order(s) it notified us about `
        + `(${awaiting.slice(0, 5).join(', ')}) — cursor HELD so the next poll's window still covers them`);
    }
    // Only a window we read to the end, and that produced everything we were promised, may move the cursor.
    if (!truncated && !awaiting.length) setMeta(db, 'orders_cursor', modTimeTo);
    else if (truncated) {
      console.warn(`[postsale] order-poll: window ${modTimeFrom} → ${modTimeTo} not drained `
        + `(${ingested} ingested, max_per_run ${cfg.max_per_run}) — cursor HELD so the remainder is `
        + `picked up next run. Raise max_per_run if this repeats.`);
    }
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
          if (sweep.staleDrafts && sweep.staleDrafts.length) staleDrafts.push(...sweep.staleDrafts);
          if (sweep.refreshed) console.log(`[postsale] sweep: ${sweep.refreshed} of ${sweep.checked} open order(s) had changed`);
        } catch (e) { console.warn('[postsale] sweep failed —', e?.message || e); }
      }
    }
    // Retire any approval card whose draft the cancellation just invalidated, BEFORE processMessages
    // rewrites them — otherwise a card sits in Telegram with a live ✅ Send button under text that
    // mentions cards the buyer is being refunded for.
    for (const m of staleDrafts) {
      try {
        await stampTelegramCard(env, db, m,
          { status: 'rewritten — another order was cancelled', icon: '♻️' });
      } catch (e) { console.warn('[postsale] could not retire a stale card —', e?.message || e); }
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
      holds, sweep, truncated, awaiting, window: { from: modTimeFrom, to: modTimeTo } });
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
 *
 * A NOTIFICATION is not a person, and this is the distinction the check turns on. Push fires on every
 * sale, so treating it like the ↻ would spend a by-id sweep — up to three GetOrders calls over sixty
 * open orders — on each one, to answer a question nobody asked. It knows precisely which order it
 * came about; the windowed query is the right tool for that. So it follows the background cadence,
 * like the schedule it is standing in for.
 */
export function sweepDue(trigger, cfg = {}, lastSweepAt = null, now = Date.now()) {
  if (trigger === 'manual') return true;
  const mins = Math.max(0, +cfg.sweep_interval_min || 0);
  if (!mins) return false;
  if (!lastSweepAt) return true;
  return now - new Date(lastSweepAt).getTime() >= mins * 60_000;
}

export async function sweepOpenOrders(env, db, { limit = 60, chunk = 20, fetchOrders = getOrders, cfg = loadConfig() } = {}) {
  // THE PACK QUEUE COMES FIRST, and that ordering is the difference between this working and not.
  //
  // The sweep set is deliberately wider than the queue — it also covers parcels in transit, so a
  // delivery date can arrive. On any established store those in-transit orders vastly outnumber the
  // queue, so ordering by date alone means `limit` is spent entirely on them and the orders that
  // actually need a decision are never asked about. That is not a smaller version of the feature; it
  // is the feature never running on the rows it exists for.
  //
  // Within each band, newest first: a cancellation or a payment failure is far likelier on a recent
  // order than on one that has been sitting for a fortnight.
  const ACTIONABLE = `(${IN_QUEUE_SQL} OR ${HOLD_SQL})`;
  const ids = db.prepare(`SELECT order_id FROM orders
     WHERE ${ACTIONABLE}
        OR (shipped_status = 'shipped' AND delivered_time IS NULL
            AND COALESCE(shipped_time, paid_time, created_time) > datetime('now','-21 days'))
     ORDER BY CASE WHEN ${ACTIONABLE} THEN 0 ELSE 1 END,
              COALESCE(paid_time, created_time) DESC
     LIMIT ?`).all(limit).map((r) => r.order_id);
  if (!ids.length) return { ok: true, checked: 0, refreshed: 0, holdMoves: [], staleDrafts: [], missing: [] };

  let refreshed = 0; const holdMoves = [], staleDrafts = [], missing = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const batch = ids.slice(i, i + chunk);
    const res = await fetchOrders(env, { orderIds: batch, entriesPerPage: 100 });
    if (!res.ok) return { ok: false, error: 'GetOrders failed', ack: res.ack, errors: res.errors, checked: i, holdMoves, staleDrafts, missing };
    const seen = new Set();
    for (const o of res.orders) {
      seen.add(o.orderId);
      const r = refreshOrder(db, o, cfg);
      if (!r.updated) continue;
      refreshed++;
      if (r.holdMove) holdMoves.push(r.holdMove);
      if (r.staleDrafts && r.staleDrafts.length) staleDrafts.push(...r.staleDrafts);
    }
    for (const id of batch) if (!seen.has(id)) missing.push(id);
  }
  setMeta(db, 'last_sweep_at', new Date().toISOString());
  if (missing.length) console.warn(`[postsale] sweep: eBay did not return ${missing.length} order(s) we asked about — ${missing.slice(0, 5).join(', ')}`);
  return { ok: true, checked: ids.length, refreshed, holdMoves, staleDrafts, missing };
}

// One order-poll at a time, whoever asked for it. The dashboard's ↻ can now fire a poll on demand,
// so a manual run and the scheduled tick can genuinely collide — and both would call setMeta on
// orders_cursor at the end, so the slower one would push the cursor past a window the faster one
// never read. Those orders would then be outside every future window: silently lost, not late.
// A caller arriving mid-run joins the run in progress instead of starting a second one.
//
// `expect` is the notification path's cursor guard (see pollOrders). It rides through the singleton
// unchanged, which is worth being clear-eyed about: a notification arriving mid-poll JOINS that poll
// rather than starting one, so its ids never reach the guard and the run it joined may have opened
// its window before the sale existed. That order is not lost — it is simply adopted by the next
// scheduled poll, exactly as it would have been before push existed. The react pass sees the same
// thing (the order is still not ours afterwards) and retries, so in practice it costs one debounce
// interval, not ten minutes. Starting a second concurrent poll to avoid that would trade a rare
// small delay for the cursor race this singleton exists to prevent.
let _pollInFlight = null;
export function runOrderPoll(env, db, { trigger = 'schedule', expect = [] } = {}) {
  if (_pollInFlight) return _pollInFlight;
  _pollInFlight = Promise.resolve(pollOrders(env, db, { trigger, expect })).finally(() => { _pollInFlight = null; });
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
// dispatchOrder codes that mean WE refused, not that eBay did. Nothing was sent, so they are a 409
// (the state is wrong) rather than a 502 (the upstream failed).
export const LOCAL_REFUSALS = new Set(['order_unknown', 'order_unpaid', 'payment_not_settled', 'order_cancelled', 'carrier_required']);

export async function dispatchOrder(env, db, id, cfg = DEFAULT_CONFIG, { dispatch: doEbay = true, tracking, carrier } = {}) {
  const prev = db.prepare('SELECT shipped_status, label_bought_at, picked_at, cancel_state, payment_state, paid_time, dispatch_source FROM orders WHERE order_id=?').get(id);
  // THE PAYMENT GATE, and it is deliberately the FIRST thing in this function.
  //
  // This is the only place in the repo that calls CompleteSale — every dispatch, from the per-order
  // button, the bulk "mark all shipped" and the daily digest tap, arrives here — so this is the one
  // test that can promise an item is never reported shipped before the money arrived.
  //
  // It must sit above BOTH branches below, and each for its own reason. The already-dispatched
  // short-circuit stamps picked_at and returns ok, so a guard after it would be skipped for exactly
  // the orders eBay already thinks are gone. And `flip` writes shipped_status='shipped' even under
  // dry_run and even with dispatch:false — nothing in this repo ever writes it back to 'unshipped', so
  // a rehearsal that got this far would permanently mark an unpaid order as sent.
  //
  // paid_time alone is not the test: eBay reports a bounced eCheck or a declined card AFTER PaidTime,
  // and 'pending' means the money is still moving. Both are read here at the moment of the write
  // rather than trusted from whatever the dashboard was showing when the button was pressed.
  if (!prev) {
    return { ok: false, code: 'order_unknown', error: 'no such order here — refusing to tell eBay it shipped' };
  }
  if (!prev.paid_time) {
    return { ok: false, code: 'order_unpaid', error: 'this order has not been paid for — there is no dispatch to record' };
  }
  if ((prev.payment_state || 'ok') !== 'ok') {
    return { ok: false, code: 'payment_not_settled',
      error: `payment has not settled (${prev.payment_state}) — leave the cards on the shelf until it clears` };
  }
  // CompleteSale on a cancelled order fails at eBay anyway. Refusing locally is cheaper, and it says
  // something a person can act on instead of relaying an eBay error code.
  if (prev && isCancelled(prev)) {
    return { ok: false, code: 'order_cancelled', error: 'this order was cancelled on eBay — there is nothing to dispatch' };
  }
  // eBay requires BOTH the number and a valid ShippingCarrierUsed code, and buildCompleteSaleInner
  // drops the whole Shipment block when either is missing — so a carrier-less tracking number does not
  // error, it silently dispatches the order with no tracking on it. We would still write the number
  // here and quote it in the buyer's dispatch note, leaving them chasing a number their order does not
  // carry. Refusing costs a retry; sending a half-true dispatch costs the buyer's afternoon.
  if (tracking && !carrier) {
    return { ok: false, code: 'carrier_required',
      error: 'a tracking number needs its eBay carrier code with it — eBay drops tracking that arrives without one' };
  }
  // Nothing to tell eBay about an order eBay ALREADY has dispatched, whoever dispatched it. Keyed on
  // shipped_status rather than on label_bought_at deliberately: an order eBay merely marked dispatched
  // is just as shipped as one with a bought label, and firing a second CompleteSale at either earns an
  // eBay error for work that is already done. This is equally the guard for a double tap of "Mark
  // shipped" — which used to fail the second write, skip the flip, and return a 502 to a dashboard
  // that was already showing the order as dispatched.
  //
  // Tracking is the one exception: eBay accepts a number added to an already-shipped order, and a
  // caller who supplied one is asking for exactly that, so it goes through.
  //
  // This DOES stamp picked_at, and that is the difference from refreshOrder's settle path: here a
  // human pressed a button meaning "this parcel has gone", which is a fact about our own work. A poll
  // may not assert that; a button may.
  //
  // What counts as evidence eBay has it depends on WHO said so. dispatch_source='ebay' is written by
  // refreshOrder from eBay's own answer, so it is proof whatever mode we are in. 'manual' is our own
  // record, and under dry_run that record is a REHEARSAL — trusting it would make the first live tap
  // after switching over a silent no-op, so in that one case we fall through (the branch below still
  // makes no call, so a dry run stays a dry run).
  const ebayHasIt = prev && prev.shipped_status === 'shipped'
    && (prev.dispatch_source === 'ebay' || !cfg.dry_run);
  if (ebayHasIt && !tracking) {
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
    // picked_at is stamped here for the SAME reason the short-circuit above stamps it: somebody
    // pressed a button meaning "this parcel has gone", which is a fact about our own work that a
    // button may assert and a poll may not. Without it a dispatch that came through this branch left
    // the order in the pack queue after a SUCCESSFUL dispatch — and this branch is reachable, because
    // the short-circuit is gated on `!tracking` and POST /orders/:id/shipped passes its body straight
    // through. A caller supplying a tracking number got a real CompleteSale, an ok:true, and an order
    // still sitting in the queue needing a second tap to clear.
    // BOUND nowSql(), not datetime('now'), and the difference is not cosmetic. nowSql() is
    // toISOString() — '2026-08-27T07:31:49.142Z', explicitly UTC — while SQLite's datetime('now')
    // yields '2026-08-27 07:31:49', which JS parses as LOCAL time: in Sydney that reads ten hours
    // earlier than it happened. The short-circuit above stamps this same column with nowSql(), so
    // mixing the two would put two incompatible formats in one column and the dashboard's "Pulled +
    // packed" tooltip would be wrong for exactly the orders that came through this branch.
    db.prepare(`UPDATE orders SET shipped_status='shipped', shipped_time=COALESCE(shipped_time, datetime('now')),
      picked_at=COALESCE(picked_at, ?),
      tracking_number=COALESCE(?, tracking_number), carrier=COALESCE(?, carrier),
      tracking_seen_at=CASE WHEN ? IS NOT NULL AND tracking_seen_at IS NULL THEN datetime('now') ELSE tracking_seen_at END,
      dispatch_source=COALESCE(dispatch_source, 'manual') WHERE order_id=?`)
      .run(nowSql(), tracking || null, carrier || null, tracking || null, id);
    // A tracking number entered here is just as real as one eBay wrote, so it earns the same
    // dispatch note to the buyer.
    if (tracking && cfg.messaging !== false && (cfg.postage || {}).dispatch_message?.enabled) {
      try { enqueueMessage(db, id, 'dispatch'); } catch { /* the dispatch itself already succeeded */ }
    }
  }
  return { ok: flip, dispatched: doEbay && !cfg.dry_run && !!(ebay && ebay.ok), dry_run: !!(doEbay && cfg.dry_run), ebay };
}

// ---------------------------------------------------------------------------------------------
// Deal quotes → one eBay invoice
// ---------------------------------------------------------------------------------------------
// The only path in this repo that changes what a buyer is asked to pay, so it is shaped like
// dispatchOrder and for the same reason: claim, refuse, then act, then VERIFY what eBay actually did.
//
// EVERYTHING IS RECOMPUTED AT SEND, never trusted from the row. A quote can sit in the dashboard or a
// Telegram card for hours; in that time the buyer can pay, the repricer can raise a price, the owner
// can re-cost a postage band in Settings, or eBay can cancel the order. The precedent is
// reviseTradingListing's expectPriceCents precondition — a proposal is a snapshot, and the world moves.
//
// DEAL_REFUSALS is deliberately NOT folded into LOCAL_REFUSALS. Every code in that set names a state of
// the `orders` table, and an invoice by design targets an order that is NOT in it (unpaid orders are
// never ingested — see the deal_requests DDL). Sharing the set would be a category error that reads
// fine and misroutes every status code.
export const DEAL_REFUSALS = new Set([
  'deal_unknown', 'already_sending', 'quote_expired', 'order_too_old', 'currency_mismatch', 'wrong_site',
  'order_not_found', 'order_already_paid', 'order_cancelled', 'international_order', 'order_lines_changed',
  'subtotal_moved', 'bands_moved', 'total_moved', 'service_unknown', 'no_order_id',
  'no_lines', 'band_unresolved', 'subtotal_band_unresolved', 'zero_postage_band',
  'discount_not_a_number', 'discount_not_whole_cents', 'discount_negative', 'discount_zero',
  'no_subtotal', 'discount_exceeds_subtotal',
]);

// A refusal that means this quote is over: leaving it retryable would have the owner tapping Send at a
// wall. Everything else restores the row so it can be re-quoted once the cause is fixed.
const DEAL_TERMINAL = { quote_expired: 'expired', order_too_old: 'expired', order_cancelled: 'skipped' };
// The buyer paid without needing the invoice. Not a failure, and not something to retry.
const DEAL_SETTLED = { order_already_paid: 'skipped' };

export function getDeal(db, id) { return db.prepare('SELECT * FROM deal_requests WHERE id=?').get(id); }
export function getDealLines(db, id) { return db.prepare('SELECT * FROM deal_lines WHERE deal_id=? ORDER BY id').all(id); }
function setDeal(db, id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE deal_requests SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`)
    .run(...keys.map((k) => patch[k]), id);
}

/**
 * Price a quote without sending anything. Shared by the dashboard's live preview and by the send path,
 * so the figure on screen and the figure on the wire come from one function.
 */
export function quoteDeal(db, id, discountCents, listingCfg) {
  const row = getDeal(db, id);
  if (!row) return { ok: false, code: 'deal_unknown', error: 'no such quote' };
  const lines = getDealLines(db, id);
  const shipping = (listingCfg || loadListingConfig()).shipping;
  const costBasis = dealCostBasis(lines);
  const summary = dealSummary({ lines, shipping, costBasis });
  if (!summary.ok) return { ...summary, error: summary.message };
  if (discountCents == null) return { ok: true, deal: row, lines, summary };
  const check = checkDiscount(discountCents, summary, { costBasisCents: summary.costBasisCents });
  if (!check.ok) return { ...check, error: check.message, summary };
  return { ok: true, deal: row, lines, summary, ...check };
}

// Cost basis per SKU out of the tracker, so the card can say whether a discount clears what the cards
// cost. Unknown stays unknown — never zero (GR4), because "free" is a number somebody would act on.
function dealCostBasis(lines) {
  const out = {};
  try {
    const tdb = openDb();
    const stmt = tdb.prepare('SELECT sku, cost_cents, acq_fees_cents FROM inventory_items WHERE sku=?');
    for (const li of lines) {
      if (!li.sku) continue;
      const r = stmt.get(li.sku);
      if (r && Number.isFinite(r.cost_cents)) out[li.sku] = (r.cost_cents || 0) + (r.acq_fees_cents || 0);
    }
  } catch { /* no tracker db — cost is simply unknown, which dealSummary reports honestly */ }
  return out;
}

/**
 * Send one invoice for a quote. Returns { ok, code?, error?, dry_run?, ebay?, verified? }.
 */
export async function sendDealInvoice(env, db, id, cfg = DEFAULT_CONFIG,
  // fetchOrders and submitInvoice are injectable for the same reason pollOrders' is: so the whole
  // decision — every refusal, the dry-run stop, the claim, the verify — can be exercised offline
  // without a token, and a test can prove that a refusal reached NO eBay call rather than assuming it.
  { discountCents, expectTotalCents, fetchOrders = getOrders, submitInvoice = sendInvoice } = {}) {
  const before = getDeal(db, id);
  if (!before) return { ok: false, code: 'deal_unknown', error: 'no such quote' };

  // THE CLAIM IS FIRST, and it is the only thing standing between a double tap and two invoices. The
  // read above is a fast path; this single statement is what actually holds, because the check and the
  // state change cannot be separated. Same idiom as the postsale message approve path.
  const claimed = db.prepare(
    "UPDATE deal_requests SET status='sending', updated_at=datetime('now') WHERE id=? AND status IN ('pending','awaiting_approval')",
  ).run(id).changes > 0;
  if (!claimed) {
    const now = getDeal(db, id);
    return { ok: false, code: 'already_sending', error: 'this quote is already ' + ((now && now.status) || 'decided') };
  }

  // Every refusal from here on must put the row back, or a single hiccup strands the quote in 'sending'
  // with no button that can move it.
  const fail = (code, error, extra = {}) => {
    const next = DEAL_TERMINAL[code] || DEAL_SETTLED[code] || before.status || 'pending';
    setDeal(db, id, { status: next, error: `${code}: ${error}` });
    return { ok: false, code, error, ...extra };
  };

  try {
    if (!before.ebay_order_id) {
      return fail('no_order_id', 'this quote has no eBay order behind it yet — the buyer has to commit to buy before an invoice exists');
    }
    if (before.expires_at && isoLt(before.expires_at, new Date().toISOString())) {
      return fail('quote_expired', 'this quote has expired — re-quote it if the buyer is still interested');
    }
    if (String(before.currency || 'AUD') !== 'AUD') {
      return fail('currency_mismatch', `this quote is in ${before.currency}, and the invoice path only handles AUD`);
    }
    if (siteId(env) !== '15') {
      return fail('wrong_site', 'the eBay site is not Australia (15), and every postage band here is Australia Post domestic');
    }

    const lines = getDealLines(db, id);
    if (!lines.length) return fail('no_lines', 'this quote has no lines');

    // READ THE ORDER LIVE. It is deliberately absent from the `orders` table — that table means "paid" —
    // so eBay is the only source of truth for its current state. OrderIDArray makes eBay ignore every
    // other filter, which is what lets an unpaid order be fetched at all.
    const res = await fetchOrders(env, { orderIds: [before.ebay_order_id] });
    if (!res.ok) return fail('order_not_found', 'could not read the order back from eBay', { ebay: { ack: res.ack, errors: res.errors } });
    const order = (res.orders || []).find((o) => String(o.orderId) === String(before.ebay_order_id));
    if (!order) return fail('order_not_found', 'eBay no longer returns that order');

    // Already paid is the common, happy version of "too late": the buyer just bought it. SendInvoice on
    // a paid order is rejected anyway, and eBay defines Active as exactly the state in which a seller
    // may still change the price or the postage — which is the legal basis for this whole feature.
    if (order.paidTime || order.checkoutStatus === 'Complete' || (order.orderStatus && order.orderStatus !== 'Active')) {
      return fail('order_already_paid', 'the buyer has already paid for this order, so there is nothing left to invoice');
    }
    if (order.cancelStatus || order.orderStatus === 'Cancelled') {
      return fail('order_cancelled', 'that order was cancelled on eBay');
    }
    const country = (order.ship && order.ship.country) || null;
    if (country && country !== 'AU') {
      return fail('international_order', `this order ships to ${country}, and every postage band here is Australia Post domestic`);
    }
    // eBay refuses a SendInvoice whose line items are more than 30 days old, and its own error codes
    // cannot tell "too old" from "not yours" — so refuse on our clock, where the reason is knowable.
    if (order.createdTime) {
      const days = (Date.now() - new Date(order.createdTime).getTime()) / 86400000;
      if (days > 30) return fail('order_too_old', `that order is ${Math.floor(days)} days old, past eBay's 30-day invoice limit`);
    }

    // THE SNAPSHOT MUST STILL DESCRIBE THE ORDER. A buyer can add or remove items from an unpaid cart,
    // and invoicing a set of lines that no longer matches would quote a total for cards they are not
    // buying.
    const key = (x) => `${x.orderLineItemId || x.order_line_item_id || ''}|${x.itemId || x.ebay_item_id || ''}`;
    const liveKeys = new Set((order.items || []).map(key));
    const snapKeys = new Set(lines.map(key));
    if (liveKeys.size !== snapKeys.size || [...snapKeys].some((k) => !liveKeys.has(k))) {
      return fail('order_lines_changed', 'the items on that order have changed since the quote was worked out — re-quote it');
    }

    // Recompute from the FROZEN unit prices, then check them against what eBay currently says. The
    // repricer can raise a listing between the quote and the tap, and the buyer must be charged the
    // figure they were quoted or none at all.
    const listingCfg = loadListingConfig();
    const shipping = listingCfg.shipping;
    const summary = dealSummary({ lines, shipping, costBasis: dealCostBasis(lines) });
    if (!summary.ok) return fail(summary.code, summary.message);

    const liveSubtotal = (order.items || []).reduce((n, it) => n + (Number(it.unitPriceCents) || 0) * (Number(it.quantity) || 1), 0);
    if (liveSubtotal && liveSubtotal !== summary.subtotalCents) {
      return fail('subtotal_moved',
        `the cards now total ${money(liveSubtotal)} on eBay but the quote was worked out at ${money(summary.subtotalCents)} — re-quote it`);
    }
    if (before.postage_cents != null && summary.postageCents !== before.postage_cents) {
      return fail('bands_moved',
        `postage for this order is now ${money(summary.postageCents)}, not the ${money(before.postage_cents)} quoted — the band table has changed, so re-quote it`);
    }

    const want = discountCents != null ? discountCents : before.discount_cents;
    const check = checkDiscount(want, summary, { costBasisCents: summary.costBasisCents });
    if (!check.ok) return fail(check.code, check.message);
    if (expectTotalCents != null && Number(expectTotalCents) !== check.totalCents) {
      return fail('total_moved',
        `the total is now ${money(check.totalCents)}, not the ${money(expectTotalCents)} on screen — check it and send again`);
    }

    // THE SERVICE CODE COMES OFF THE ORDER. Trading and the REST Account API use different service
    // vocabularies, and three of this shop's four band codes do not exist in Trading's enum — a wrong
    // one passes schema validation and fails at runtime. Echoing what the buyer actually selected
    // satisfies eBay's must-match rule by construction.
    const service = order.shipService;
    if (!service) {
      return fail('service_unknown', 'eBay did not say which postage service the buyer selected, so the invoice cannot name one');
    }

    const note = (cfg.deals || {}).invoice_note || null;
    const payload = {
      orderId: before.ebay_order_id,
      currency: before.currency || 'AUD',
      shippingService: service,
      shippingCostCents: summary.postageCents,
      discountCents: check.discountCents,
      checkoutInstructions: note,
      messageId: `deal-${id}-${before.created_at || ''}`.slice(0, 60),
    };

    // DRY RUN STOPS HERE, after every refusal and before anything reaches eBay — so a rehearsal
    // exercises the whole decision and none of the consequences. data/postsale.config.json ships
    // dry_run:true, which is the state this path runs in first.
    if (cfg.dry_run) {
      setDeal(db, id, {
        status: 'pending', discount_cents: check.discountCents, postage_cents: summary.postageCents,
        subtotal_cents: summary.subtotalCents, total_cents: check.totalCents, postage_band_id: summary.bandId,
        evidence: JSON.stringify({ boundBy: summary.boundBy, perLine: summary.perLine, warnings: check.warnings, service }),
        error: 'dry_run (not sent to eBay)',
      });
      return { ok: true, dry_run: true, summary, check, payload };
    }

    let ebay = null;
    try {
      const r = await submitInvoice(env, payload);
      ebay = { ok: r.ok, ack: r.ack, errors: r.errors };
    } catch (e) {
      ebay = { ok: false, error: String(e?.message || e) };
    }
    if (!ebay.ok) {
      setDeal(db, id, { status: before.status || 'awaiting_approval', error: 'ebay_refused: ' + (ebay.error || (ebay.errors || [])[0]?.longMessage || 'unknown') });
      return { ok: false, code: 'ebay_refused', error: (ebay.errors || [])[0]?.longMessage || ebay.error || 'eBay refused the invoice', ebay };
    }

    // VERIFY, because this repo has already been bitten by eBay accepting a call and ignoring a field
    // (reviseTradingListing auto-reverts a price for exactly that reason). The invoice is only recorded
    // as sent once eBay's own copy of the order shows the adjustment.
    let verified = null;
    try {
      const back = await fetchOrders(env, { orderIds: [before.ebay_order_id] });
      const o2 = back.ok ? (back.orders || []).find((o) => String(o.orderId) === String(before.ebay_order_id)) : null;
      if (o2) verified = { totalCents: o2.totalCents, shippingCents: o2.shippingCents };
    } catch { /* the invoice went; a failed read-back is not a reason to claim it did not */ }

    setDeal(db, id, {
      status: 'sent', sent_at: nowSql(), error: null,
      discount_cents: check.discountCents, postage_cents: summary.postageCents,
      subtotal_cents: summary.subtotalCents, total_cents: check.totalCents, postage_band_id: summary.bandId,
      evidence: JSON.stringify({ boundBy: summary.boundBy, perLine: summary.perLine, warnings: check.warnings, service, verified }),
    });
    return { ok: true, dry_run: false, ebay, summary, check, verified };
  } catch (e) {
    setDeal(db, id, { status: before.status || 'awaiting_approval', error: 'threw: ' + String(e?.message || e) });
    return { ok: false, code: 'send_failed', error: String(e?.message || e) };
  }
}


/**
 * Clear label_bought_at on orders NAMED BY A HUMAN, so they drop out of the pack queue as posted.
 *
 * This used to sweep automatically, by the same "a bought label carries a tracking number" test
 * refreshOrder applied: every untracked row parked in label_bought was assumed to be a Seller Hub
 * bulk-tick and cleared. That test is gone (see refreshOrder's becameShipped block for why an
 * untracked eBay label is the ordinary case here, not the exception), and a sweep still running on it
 * would silently undo the live rule on every invocation — clearing exactly the orders that are now
 * deliberately held. So the sweep is gone with it.
 *
 * What remains is the escape hatch, and it takes ids because there is no longer any signal that can
 * pick the rows on its own. Naming them is the point: the caller is asserting, about specific parcels,
 * that they have actually gone.
 *
 * label_bought_at is CLEARED rather than shadowed by a "settled" column — a third term in the queue
 * predicate carried forever, to remember that a stamp should not have been there, is a worse trade.
 *
 * Dry-run by default, exposed as POST /diag/settle-label-bought rather than run on boot, and the
 * response names every order on both sides because "cleared 8" is not something anybody can check.
 * Idempotent by construction: a cleared row no longer matches LABEL_BOUGHT_SQL.
 */
export function settleLabelBought(db, cfg = loadConfig(), { apply = false, ids = null } = {}) {
  const rows = db.prepare(`SELECT * FROM orders WHERE ${LABEL_BOUGHT_SQL}`).all();
  attachPostage(rows, cfg);
  const view = (o) => ({
    order_id: o.order_id, buyer_username: o.buyer_username,
    tier: o.postage ? o.postage.tier : null, tracked: !!(o.postage && o.postage.tracked),
    tracking: o.tracking_number || null, shipped_status: o.shipped_status,
    label_bought_at: o.label_bought_at,
  });

  // No ids is not an empty selection, it is a caller still expecting the old sweep. Refusing and
  // listing the candidates is the useful answer: it is the same information the sweep used to act on,
  // handed over for someone to choose from instead of acted on unattended.
  const want = (Array.isArray(ids) ? ids : []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!want.length) {
    return { ok: false, code: 'ids_required', dry_run: !apply, checked: rows.length, updated: 0,
      error: 'name the orders to clear — a bought eBay label is often untracked, so nothing here can '
        + 'tell a posted parcel from one still on the shelf',
      candidates: rows.map(view) };
  }

  const known = new Set(rows.map((o) => o.order_id));
  const settle = want.filter((id) => known.has(id));
  const missing = want.filter((id) => !known.has(id));
  const settling = new Set(settle);
  let updated = 0;
  if (apply && settle.length) {
    const ph = settle.map(() => '?').join(',');
    updated = db.prepare(`UPDATE orders SET label_bought_at = NULL WHERE order_id IN (${ph})`)
      .run(...settle).changes || 0;
    // Named, not counted — the ring buffer behind /api/status/logs is the only record of a one-shot
    // correction, and a bare number is not something anybody can check afterwards.
    console.log(`[postsale] settle-label-bought: cleared ${updated} order(s) by hand — ${settle.join(', ')}`);
  }
  return { ok: true, dry_run: !apply, checked: rows.length, updated,
    settled: rows.filter((o) => settling.has(o.order_id)).map(view), missing };
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
    // Same split as the dashboard's bulk route: `dispatched` was told to eBay, `recorded` was already
    // dispatched there and only written down here. `ok` stays "closed out, either way" because that is
    // what the claim stamp and the card footer have always meant by it.
    let dispatched = 0, recorded = 0;
    for (const o of orders) {
      const r = await dispatchOrder(env, db, o.order_id, cfg);
      if (r.ok) { if (r.alreadyShipped) recorded++; else dispatched++; }
      else failed.push({ order_id: o.order_id, ebay: r.ebay, code: r.code });
    }
    const ok = dispatched + recorded;
    if (ok) db.prepare('UPDATE pack_digests SET dispatched_at=?, dispatched_by=? WHERE id=?').run(nowSql(), who, digestId);
    console.log(`[postsale/digest] dispatched ${dispatched}/${orders.length} by ${who} (digest ${digestId})`
      + (recorded ? ' — ' + recorded + ' already dispatched on eBay, recorded only' : '')
      + (failed.length ? ' — ' + failed.length + ' failed' : '')
      + (held.length ? ' — ' + held.length + ' held back' : ''));
    return { claimed: true, total: orders.length, ok, dispatched, recorded, failed, held };
  } finally {
    // Always release, so a crash or a partial failure doesn't wedge the button forever.
    db.prepare('UPDATE pack_digests SET dispatch_started_at=NULL WHERE id=?').run(digestId);
  }
}

// --- state (surfaced at /api/status jobs) ---
export function getPostsaleState() {
  return {
    order_poll: { running: !!globalThis.__postsaleOrderTimer, enabled: loadConfig().enabled !== false, next_run_at: _orderPoll.next_run_at, last_run: _orderPoll.last_run },
    // The message poll now carries two jobs, so it reports which of them is armed: 'enabled' alone
    // could not distinguish inbox-only mode from the whole subsystem being on.
    reply_poll: { running: !!globalThis.__postsaleMsgTimer, next_run_at: _msgPoll.next_run_at, last_run: _msgPoll.last_run,
      inbox_alerts: inboxAlertsOn(loadConfig()), message_types: inboxCfg(loadConfig()).message_types },
    // The digest is an HOURLY tick self-gated to send once a day past digest_hour, so it has no
    // single next_run_at to report. Carry the hour instead, or the console shows a healthy armed
    // job as "never / —" with nothing to explain when it is actually due.
    pack_digest: { running: !!globalThis.__postsalePackTimer, last_run: _packDigest.last_run, digest_hour: loadConfig().digest_hour ?? 9 },
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
  // INBOX-ONLY MODE. Watching the eBay inbox is a different decision from ingesting orders and
  // drafting buyer messages, so it gets its own switch — and when only that switch is on, ONLY the
  // message timer arms. Arming the order poll here would quietly start writing orders, stock
  // decrements and sale alerts that nobody asked for.
  const inboxOnly = !cfg.enabled && inboxAlertsOn(cfg);
  if (!cfg.enabled && !inboxOnly) { console.log('[postsale] disabled (data/postsale.config.json)'); return; }
  if (!inboxOnly) {
    const orderMs = Math.max(1, cfg.poll_interval_min) * 60_000;
    const tick = () => { _orderPoll.next_run_at = new Date(Date.now() + orderMs).toISOString(); return runOrderPoll(_env, _db, { trigger: 'schedule' }).catch((e) => console.error('[postsale]', e?.message || e)); };
    const boot = setTimeout(tick, 45_000); if (boot.unref) boot.unref();
    const timer = setInterval(tick, orderMs); if (timer.unref) timer.unref();
    globalThis.__postsaleOrderTimer = timer;
    globalThis.__postsaleOrderBoot = boot;
    _orderPoll.next_run_at = new Date(Date.now() + orderMs).toISOString();
  }
  // reply-poll: detect buyer replies to our sent messages → human handoff, and (inbox_alerts) card
  // every other message that reaches the inbox.
  const msgMs = Math.max(1, cfg.reply_poll_interval_min) * 60_000;
  const msgTick = () => { _msgPoll.next_run_at = new Date(Date.now() + msgMs).toISOString(); return runMemberMessagePoll(_env, _db, { trigger: 'schedule' }).catch((e) => console.error('[postsale/reply]', e?.message || e)); };
  const msgBoot = setTimeout(msgTick, 75_000); if (msgBoot.unref) msgBoot.unref();
  const msgTimer = setInterval(msgTick, msgMs); if (msgTimer.unref) msgTimer.unref();
  globalThis.__postsaleMsgTimer = msgTimer;
  globalThis.__postsaleMsgBoot = msgBoot;
  _msgPoll.next_run_at = new Date(Date.now() + msgMs).toISOString();
  if (!inboxOnly) {
    // pack digest: hourly tick, self-gated to once/day past digest_hour.
    const packTimer = setInterval(() => runPackDigest(_env, _db).catch((e) => console.error('[postsale/digest]', e?.message || e)), 3600_000);
    if (packTimer.unref) packTimer.unref();
    globalThis.__postsalePackTimer = packTimer;
  }
  const inbox = inboxAlertsOn(cfg) ? ` · inbox-alerts ${inboxCfg(cfg).message_types}` : '';
  if (inboxOnly) {
    console.log(`[postsale] INBOX-ONLY — reply-poll ${cfg.reply_poll_interval_min}m${inbox}; order poll, digest and buyer messaging stay off`);
  } else {
    console.log(`[postsale] order-poll ${cfg.poll_interval_min}m · reply-poll ${cfg.reply_poll_interval_min}m · mode ${cfg.mode}${cfg.dry_run ? ' · DRY-RUN' : ''} · alerts ${cfg.alerts ? 'on' : 'off'}${inbox}`);
  }
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
          // "signature required on delivery" and the like — a physical instruction tracking alone does
          // not imply, so it has to reach the sheet the packer reads before walking to the shelves.
          note: o.postage.note || null,
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
        // 502 means "eBay refused"; the dashboard turns it into "kept in the queue to retry". A local
        // refusal is neither of those — nothing was sent and retrying changes nothing until the state
        // that caused it does — so it answers 409 and the dashboard prints the reason instead.
        return send(res, r.ok ? 200 : (LOCAL_REFUSALS.has(r.code) ? 409 : 502), r);
      }
      // POST /orders/shipped { ids:[…] } — the bulk form of the per-order route above, for the
      // dashboard's "Mark all shipped". SEQUENTIAL on purpose, same as dispatchAllInDigest: eBay is
      // happier one at a time, and a partial failure has to leave the failed orders in the queue
      // rather than half-hiding them.
      //
      // Refuses the same things the digest button refuses. A held order is never swept up by a BULK
      // action — the whole point of a hold is that a person decides first — and a cancelled one has
      // nothing to dispatch. Both are reported rather than silently dropped, so the count on screen
      // always accounts for every order that was ticked. The per-order button stays the deliberate
      // override for a hold you have looked at and want to pack anyway.
      if (p === '/orders/shipped' && method === 'POST') {
        const body = await readJson(req);
        const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map((s) => String(s || '').trim()).filter(Boolean);
        if (!ids.length) return send(res, 400, { error: 'ids is required' });
        const cfg = loadConfig();
        const ph = ids.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM orders WHERE order_id IN (${ph})`).all(...ids);
        attachFulfilment(rows);
        const found = new Set(rows.map((o) => o.order_id));
        const missing = ids.filter((id) => !found.has(id));
        const held = rows.filter((o) => o.on_hold).map((o) => ({ order_id: o.order_id, why: o.hold_reason }));
        const cancelled = rows.filter((o) => o.cancelled).map((o) => o.order_id);
        const todo = rows.filter((o) => !o.on_hold && !o.cancelled);
        // TWO OUTCOMES HIDE BEHIND ok:true and they are not the same claim. One told eBay the parcel
        // has gone; the other found eBay already knew and only wrote it down here. Counted together,
        // the dashboard said "5 dispatched" about five orders nothing was sent for — directly
        // contradicting the confirm dialog, which had just promised nothing would be. Now the label
        // bought lens makes that the ordinary case rather than a rarity, so they are counted apart.
        let shipped = 0, recorded = 0; const failed = [];
        for (const o of todo) {
          try {
            const r = await dispatchOrder(env, db, o.order_id, cfg);
            if (r.ok) { if (r.alreadyShipped) recorded += 1; else shipped += 1; }
            else failed.push({ order_id: o.order_id, code: r.code || null, error: r.error || ((r.ebay && (r.ebay.error || (r.ebay.errors || [])[0]?.longMessage)) || 'eBay refused it') });
          } catch (e) { failed.push({ order_id: o.order_id, error: String(e?.message || e) }); }
        }
        console.log(`[postsale] bulk dispatch: ${shipped}/${todo.length} shipped`
          + (recorded ? ` — ${recorded} already dispatched on eBay, recorded only` : '')
          + (failed.length ? ` — ${failed.length} failed` : '') + (held.length ? ` — ${held.length} held back` : ''));
        return send(res, 200, { ok: !failed.length, requested: ids.length, shipped, recorded, failed, held, cancelled, missing,
          dry_run: !!cfg.dry_run });
      }
      // POST /orders/picked { ids:[…] | id, picked } — mark orders pulled off the shelf + packed (or
      // undo it). Purely local bookkeeping: nothing is written to eBay and the order stays in the pack
      // queue awaiting dispatch — it just stops showing up on the pull list (see /picksheet). Built for
      // a weekend of orders packed as they land and posted together on Monday.
      // --- deal quotes -----------------------------------------------------------------------
      // GET /deals?status= — the queue. Newest first, because a deal ask goes cold.
      if (p === '/deals' && method === 'GET') {
        const status = (url.searchParams.get('status') || '').trim();
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const rows = status
          ? db.prepare('SELECT * FROM deal_requests WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
          : db.prepare('SELECT * FROM deal_requests ORDER BY id DESC LIMIT ?').all(limit);
        for (const r of rows) r.lines = getDealLines(db, r.id);
        return send(res, 200, { deals: rows });
      }

      // GET /deals/:id — the row, its lines, and a priced summary with no discount applied yet.
      const dqGetM = p.match(/^\/deals\/(\d+)$/);
      if (dqGetM && method === 'GET') {
        const q = quoteDeal(db, Number(dqGetM[1]), null);
        return send(res, q.ok ? 200 : (q.code === 'deal_unknown' ? 404 : 409), q);
      }

      // POST /deals/:id/quote { discount_cents } — price it WITHOUT sending. This is what the dashboard
      // calls as the owner types, so the figure on screen comes from the same function the send path
      // uses rather than from arithmetic repeated in the browser.
      const dqQuoteM = p.match(/^\/deals\/(\d+)\/quote$/);
      if (dqQuoteM && method === 'POST') {
        const body = await readJson(req);
        const q = quoteDeal(db, Number(dqQuoteM[1]), body.discount_cents);
        return send(res, q.ok ? 200 : (q.code === 'deal_unknown' ? 404 : 409), q);
      }

      // POST /deals/:id/send { discount_cents, expect_total_cents } — the only route that can invoice.
      //
      // 409 vs 502 is the same distinction dispatchOrder's route makes, and it matters to the person
      // reading the dashboard: 409 means nothing was sent and retrying changes nothing until the state
      // does (re-quote it), while 502 means eBay refused and a retry is reasonable. The whole result
      // object goes back so the caller gets code, error and eBay's own words.
      const dqSendM = p.match(/^\/deals\/(\d+)\/send$/);
      if (dqSendM && method === 'POST') {
        const body = await readJson(req);
        const cfg = loadConfig();
        if (!(cfg.deals || {}).enabled) {
          return send(res, 409, { ok: false, code: 'deals_disabled', error: 'deal requests are switched off in Settings' });
        }
        const r = await sendDealInvoice(env, db, Number(dqSendM[1]), cfg, {
          discountCents: body.discount_cents,
          expectTotalCents: body.expect_total_cents,
        });
        return send(res, r.ok ? 200 : (DEAL_REFUSALS.has(r.code) ? 409 : 502), r);
      }

      // POST /deals/:id/skip — close a quote without sending. Terminal, and it frees the partial unique
      // index so the same buyer asking again mints a fresh row rather than colliding with a dead one.
      const dqSkipM = p.match(/^\/deals\/(\d+)\/skip$/);
      if (dqSkipM && method === 'POST') {
        const id = Number(dqSkipM[1]);
        const done = db.prepare("UPDATE deal_requests SET status='skipped', decided_at=?, updated_at=datetime('now') WHERE id=? AND status IN ('pending','awaiting_approval')")
          .run(nowSql(), id).changes > 0;
        if (!done) {
          const now = getDeal(db, id);
          return send(res, now ? 409 : 404, { ok: false, code: now ? 'already_decided' : 'deal_unknown',
            error: now ? 'this quote is already ' + now.status : 'no such quote' });
        }
        return send(res, 200, { ok: true, id, status: 'skipped' });
      }

      if (p === '/orders/picked' && method === 'POST') {
        const body = await readJson(req);
        const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map((s) => String(s || '').trim()).filter(Boolean);
        if (!ids.length) return send(res, 400, { error: 'ids is required' });
        const picked = body.picked !== false;   // default: mark picked
        // ASYMMETRIC BY DESIGN, and the asymmetry is the guard.
        //
        // Marking picked says "these cards are off the shelf and packed", and it is what arms dispatch:
        // shipReady() in orders.html treats picked_at as half its readiness test, and the bulk
        // /orders/shipped that follows filters only on hold and cancelled. So a bulk pick of an order
        // that should never have been pulled walks straight into a CompleteSale.
        //
        // This is a BULK action, and pickAllInDigest — the Telegram twin of this exact operation —
        // already constrains its UPDATE with PICKABLE_SQL for that reason. This route did not, so the
        // guard existed in one twin and not the other: the dashboard could bulk-pick an order the
        // digest button would have refused. PICKABLE_SQL now carries the payment terms too, so an
        // unpaid or unsettled order is refused here as well as a held or cancelled one.
        //
        // UN-picking stays unconstrained. Undoing a mistake must always be possible, and it moves the
        // order away from dispatch rather than towards it.
        const stmt = picked
          ? db.prepare(`UPDATE orders SET picked_at = ? WHERE order_id = ? AND ${PICKABLE_SQL}`)
          : db.prepare(`UPDATE orders SET picked_at = ? WHERE order_id = ?`);
        const at = picked ? nowSql() : null;
        const exists = db.prepare('SELECT 1 FROM orders WHERE order_id = ?');
        let changed = 0;
        const missing = [], refused = [];
        for (const id of ids) {
          const r = stmt.run(at, id);
          if (r.changes) { changed += 1; continue; }
          // A row that matched nothing is either absent or refused, and the caller needs to tell those
          // apart — "we have never heard of this order" and "we will not pick that one" ask for
          // different things from the person who pressed the button. Same split the bulk dispatch
          // route reports.
          (exists.get(id) ? refused : missing).push(id);
        }
        return send(res, 200, { ok: true, picked, picked_at: at, updated: changed, missing, refused });
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
        // Act on whatever it found, exactly as the poll would have — including the stale approval
        // cards. Retiring them comes FIRST and is not optional: sweepOpenOrders returns staleDrafts
        // for the same reason pollOrders does (a sibling order of the same buyer was cancelled), and
        // skipping it here left a live ✅ Send button in Telegram under copy about cards being
        // refunded. Same order as pollOrders: stamp the cards, then settle the holds.
        if (result.ok && result.staleDrafts && result.staleDrafts.length) {
          for (const m of result.staleDrafts) {
            try {
              await stampTelegramCard(env, db, m,
                { status: 'rewritten — another order was cancelled', icon: '♻️' });
            } catch (e) { console.warn('[postsale] could not retire a stale card —', e?.message || e); }
          }
        }
        if (result.ok && result.holdMoves && result.holdMoves.length) {
          result.holds = await settleHolds(env, db, result.holdMoves, loadConfig());
        }
        return send(res, 200, { triggered: 'sweep', result });
      }
      // POST /diag/settle-label-bought[?apply=1] { ids:[…] } — drop NAMED orders out of the pack queue
      // as posted. Dry-run by default; the response names every order it touched, because "8 settled"
      // is not a thing anyone can check. Called with no ids it refuses and lists the candidates —
      // there is no rule left that can pick them, which is the point (see settleLabelBought). That
      // refusal is a 400, but the BODY still carries result.candidates: a client that throws on a
      // non-2xx has to read the response anyway to get the list it came for.
      if (p === '/diag/settle-label-bought' && method === 'POST') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const body = (await readJson(req)) || {};
        const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
        const result = settleLabelBought(db, loadConfig(), { apply: url.searchParams.get('apply') === '1', ids });
        return send(res, result.ok ? 200 : 400, { triggered: 'settle-label-bought', result });
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
      // GET /diag/member-messages?type=All&hours=72 — what does eBay ACTUALLY return, before any of
      // this is switched on.
      //
      // Read-only and alert-free by construction: it never writes a row, never sends a card, and
      // never touches messages_cursor. It exists to answer three questions that only a live account
      // can answer — does MailMessageType=All error; which types actually come back; and is `body`
      // populated, given buildGetMemberMessagesInner sends no DetailLevel. A SUMMARY, not a dump:
      // these are buyers' words, and the answer needs shapes and counts, not the correspondence.
      if (p === '/diag/member-messages' && method === 'GET') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const type = (url.searchParams.get('type') || 'All').trim();
        const hours = Math.min(720, Math.max(1, parseInt(url.searchParams.get('hours') || '72', 10) || 72));
        const startCreationTime = new Date(Date.now() - hours * 3600_000).toISOString();
        const endCreationTime = new Date().toISOString();
        const r = await getMemberMessages(env, { mailMessageType: type, startCreationTime, endCreationTime, page: 1, entriesPerPage: 100 });
        if (!r.ok) return send(res, 200, { ok: false, type, ack: r.ack, errors: r.errors, hint: type !== 'AskSellerQuestion' ? 'retry with ?type=AskSellerQuestion to confirm the account works at all' : null });
        const msgs = r.messages || [];
        const me = getMeta(db, 'ebay_username');
        const count = (fn) => msgs.reduce((n, m) => n + (fn(m) ? 1 : 0), 0);
        const sample = msgs.find((m) => (m.body || '').trim());
        return send(res, 200, {
          ok: true, type, window: { from: startCreationTime, to: endCreationTime }, hasMore: r.hasMore,
          total: msgs.length,
          types: [...new Set(msgs.map((m) => m.messageType || '(none)'))],
          senders: [...new Set(msgs.map((m) => m.senderId).filter(Boolean))],
          our_username: me || '(unresolved — GetUser has not run yet)',
          from_us: me ? count((m) => String(m.senderId || '').toLowerCase() === String(me).toLowerCase()) : null,
          with_body: count((m) => (m.body || '').trim()),
          with_subject: count((m) => (m.subject || '').trim()),
          with_item: count((m) => m.itemId),
          with_message_id: count((m) => m.messageId),
          statuses: [...new Set(msgs.map((m) => m.status || '(none)'))],
          // 120 chars is enough to tell prose from an empty string or an HTML wrapper, and short
          // enough not to turn a diagnostic into a transcript.
          body_sample: sample ? String(sample.body).replace(/\s+/g, ' ').slice(0, 120) : null,
          detail_level_note: count((m) => (m.body || '').trim()) === 0 && msgs.length
            ? 'NO bodies came back — add <DetailLevel>ReturnMessages</DetailLevel> to buildGetMemberMessagesInner and re-probe'
            : null,
        });
      }
      if (p === '/poll/messages' && method === 'POST') {
        const auth = diagOk(env, req, url); if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await runMemberMessagePoll(env, db, { trigger: 'manual' });
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
