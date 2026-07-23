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
} from './telegram.mjs';
import { getOrders, geteBayOfficialTime, sendBuyerMessage, getMemberMessages, completeSale } from './ebay-trading.mjs';
import { oauthStatus } from './ebay-oauth.mjs';
import { openDb } from './db.mjs';
import { draftMessage, guardrailScrub, nextBusinessDay } from './postsale-llm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'postsale.config.json');
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
  holidays: [],
  dashboard_url: '',          // e.g. http://192.168.4.200:5273 — enables the Telegram "Edit in dashboard" button
  alerts: true,
  labels: true,
  listings_sync: true,
  fees: false,
  cases: true,
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
  } catch (e) { console.warn('[postsale] config seed failed —', e?.message || e); }
}

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw, quiet_hours: { ...DEFAULT_CONFIG.quiet_hours, ...(raw.quiet_hours || {}) } };
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
export function buildInventoryLookup() {
  let tdb;
  try { tdb = openDb(); } catch { return null; }
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
  const sorted = rows.slice().sort((a, b) => {
    const ka = rank(a.location), kb = rank(b.location);
    return ka[0] - kb[0]
      || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0)
      || (String(a.order_id) < String(b.order_id) ? -1 : String(a.order_id) > String(b.order_id) ? 1 : 0);
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
      li.location = m ? m.location : null;
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
      shipping_cents: o.shippingCents, ship_service: o.shipService,
      sales_record_number: o.salesRecordNumber, buyer_note: o.buyerNote,
      ship_name: o.ship.name, ship_street1: o.ship.street1, ship_street2: o.ship.street2,
      ship_city: o.ship.city, ship_state: o.ship.state, ship_postal: o.ship.postal,
      ship_country: o.ship.country, ship_country_name: o.ship.countryName, ship_phone: o.ship.phone,
      shipped_status: o.shippedTime ? 'shipped' : 'unshipped',
      label_status: (cfg.labels && !o.shippedTime && o.ship.name) ? 'queued' : null,
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
    db.prepare(`INSERT INTO postsale_messages (order_id, buyer_id, ebay_item_id, is_repeat_buyer, status)
                VALUES (?,?,?,?,?) ON CONFLICT(order_id) DO NOTHING`)
      .run(o.orderId, buyer.id, rep ? rep.itemId : null, repeat ? 1 : 0, messageStatus);
    db.exec('COMMIT');
    return { created: true, repeat };
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

// --- Telegram alerts (one-way; owner-facing) ---
async function fireSaleAlert(env, db, o, repeat, cfg) {
  if (!cfg.alerts || !telegramEnabled(env) || !telegramChatConfigured(env)) return;
  const row = db.prepare('SELECT sale_alert_sent_at FROM orders WHERE order_id = ?').get(o.orderId);
  if (row?.sale_alert_sent_at) return;
  const lines = o.items.map((it) => `• ${escapeHtml(it.title || it.sku || it.itemId || 'item')}${it.quantity > 1 ? ` ×${it.quantity}` : ''}`).join('\n');
  const loc = [o.ship.city, o.ship.state].filter(Boolean).join(', ') + (o.ship.postal ? ` ${o.ship.postal}` : '');
  const text = `🟢 <b>SOLD</b>${repeat ? ' · ⭐ repeat buyer' : ''}\n${lines}\n<b>${money(o.totalCents, o.currency)}</b> · ship to ${escapeHtml(loc || '—')} · @${escapeHtml(o.buyerUsername || '')}`;
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
function cardsText(db, orderId) {
  return db.prepare('SELECT title, sku, ebay_item_id, quantity FROM order_line_items WHERE order_id=?').all(orderId)
    .map((it) => `${it.title || it.sku || it.ebay_item_id || 'a card'}${it.quantity > 1 ? ` ×${it.quantity}` : ''}`).join(', ');
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

function renderApprovalCard({ buyerUsername, repeat, itemsText, subject, body, dryRun }, decided) {
  let s = `💌 <b>Draft ready</b> for @${escapeHtml(buyerUsername || '')}${repeat ? ' · ⭐ repeat' : ''}\n`;
  if (itemsText) s += `<i>bought: ${escapeHtml(itemsText)}</i>\n`;
  s += `\n<b>${escapeHtml(subject || '')}</b>\n${escapeHtml(body || '')}`;
  if (dryRun && !decided) s += `\n\n<i>DRY-RUN — Send records approval only, nothing goes to eBay.</i>`;
  if (decided) s += `\n\n${decided.icon} <b>${escapeHtml(decided.status)}</b>${decided.who ? ` by ${escapeHtml(decided.who)}` : ''}`;
  return s;
}
function approvalButtons(id, cfg) {
  const rows = [[{ text: '✅ Send', data: `psa:${id}` }, { text: '⏭ Skip', data: `pss:${id}` }]];
  if (cfg && cfg.dashboard_url) rows.push([{ text: '✏️ Edit in dashboard', url: String(cfg.dashboard_url).replace(/\/$/, '') + '/postsale.html' }]);
  return rows;
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
  const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(msg.order_id);
  const items = db.prepare('SELECT * FROM order_line_items WHERE order_id=?').all(msg.order_id);
  const buyer = db.prepare('SELECT * FROM buyers WHERE id=?').get(msg.buyer_id);
  const priorCards = msg.is_repeat_buyer ? priorCardsFor(db, msg.buyer_id, msg.order_id) : [];
  const shipBy = nextBusinessDay(order?.paid_time ? new Date(order.paid_time) : new Date(), { tz: cfg.timezone, holidays: cfg.holidays });
  const d = await draftMessage({ order, items, buyer, priorCards, cfg, env, shipBy });
  if (!d.ok) { setMsg(db, msg.id, { status: 'failed', error: d.error + ': ' + (d.message || '') }); return { ok: false, error: d.error }; }
  const scrub = guardrailScrub(d.body);
  if (!scrub.clean) { setMsg(db, msg.id, { status: 'failed', subject: d.subject, body: d.body, model: d.model, error: 'guardrail: ' + scrub.violations.join(', ') }); return { ok: false, error: 'guardrail', violations: scrub.violations }; }
  setMsg(db, msg.id, { status: 'drafted', subject: d.subject, body: d.body, model: d.model, error: null });

  // auto mode (outside quiet hours) sends now; otherwise park for approval.
  if (cfg.mode === 'auto' && !inQuietHours(cfg)) {
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

async function pushApprovalCard(env, db, msg, order, cfg) {
  if (!telegramEnabled(env) || !telegramChatConfigured(env)) return;
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  const text = renderApprovalCard({ buyerUsername: order.buyer_username, repeat: !!msg.is_repeat_buyer, itemsText: cardsText(db, order.order_id), subject: msg.subject, body: msg.body, dryRun: cfg.dry_run });
  const r = await sendMessage(env, { chatId, text, buttons: approvalButtons(msg.id, cfg) });
  if (r.ok) db.prepare('UPDATE postsale_messages SET telegram_chat_id=?, telegram_message_id=? WHERE id=?').run(String(chatId), r.result.message_id, msg.id);
}
// Stamp the outcome onto the Telegram card + drop its buttons (keeps both surfaces in sync when the
// decision was made in the web dashboard instead of via a Telegram tap).
async function stampTelegramCard(env, db, msg, decided) {
  if (!msg.telegram_chat_id || !msg.telegram_message_id) return;
  const order = db.prepare('SELECT buyer_username FROM orders WHERE order_id=?').get(msg.order_id);
  await editMessageText(env, { chatId: msg.telegram_chat_id, messageId: msg.telegram_message_id,
    text: renderApprovalCard({ buyerUsername: order?.buyer_username, repeat: !!msg.is_repeat_buyer, itemsText: cardsText(db, msg.order_id), subject: msg.subject, body: msg.body }, decided), clearButtons: true }).catch(() => {});
}

// Re-draft an existing message (dashboard "Regenerate"); edits the Telegram card in place if present.
async function redraftMessage(env, db, id, cfg) {
  const msg = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(id);
  if (!msg) return { ok: false, error: 'not_found' };
  const r = await draftAndRoute(env, db, msg, cfg, { pushCard: false });
  const fresh = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(id);
  if (fresh.telegram_chat_id && fresh.telegram_message_id && fresh.status === 'awaiting_approval') {
    const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(fresh.order_id);
    await editMessageText(env, { chatId: fresh.telegram_chat_id, messageId: fresh.telegram_message_id,
      text: renderApprovalCard({ buyerUsername: order.buyer_username, repeat: !!fresh.is_repeat_buyer, itemsText: cardsText(db, fresh.order_id), subject: fresh.subject, body: fresh.body, dryRun: cfg.dry_run }),
      buttons: approvalButtons(fresh.id, cfg) }).catch(() => {});
  }
  return { ...r, message: fresh };
}

// Draft the pending backlog (called at the end of each order-poll, and via the manual trigger).
export async function processMessages(env, db, cfg = loadConfig(), { limit } = {}) {
  const max = limit || cfg.max_per_run || 10;
  const pend = db.prepare(`SELECT * FROM postsale_messages WHERE status='pending' ORDER BY id LIMIT ?`).all(max);
  let drafted = 0, sent = 0, failed = 0;
  for (const m of pend) {
    try {
      const r = await draftAndRoute(env, db, m, cfg);
      if (!r.ok) failed++; else if (r.status === 'sent') sent++; else drafted++;
    } catch (e) { failed++; console.warn('[postsale] draft failed', m.order_id, e?.message || e); setMsg(db, m.id, { status: 'failed', error: String(e?.message || e) }); }
  }
  return { considered: pend.length, drafted, sent, failed };
}

// --- Telegram approve/skip callbacks (shared-poller handler, prefix ps*) ---
async function onPostsaleUpdate(env, db, u) {
  const cq = u.callback_query;
  if (!cq) return;                                   // post-sale only owns its buttons
  const m = (cq.data || '').match(/^ps(a|s):(\d+)$/);
  if (!m) return;                                    // not ours — another handler will claim it
  const cfg = loadConfig();
  const action = m[1], id = +m[2];
  const who = (cq.from && (cq.from.username ? '@' + cq.from.username : cq.from.first_name)) || 'someone';
  const msg = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(id);
  if (!msg) return answerCallbackQuery(env, { id: cq.id, text: 'Message not found' });
  if (msg.status !== 'awaiting_approval') return answerCallbackQuery(env, { id: cq.id, text: 'Already ' + msg.status });
  const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(msg.order_id);
  const cardMeta = { buyerUsername: order?.buyer_username, repeat: !!msg.is_repeat_buyer, itemsText: cardsText(db, msg.order_id), subject: msg.subject, body: msg.body };

  if (action === 's') {
    setMsg(db, id, { status: 'skipped', decided_by: who, decided_at: nowSql() });
    await answerCallbackQuery(env, { id: cq.id, text: 'Skipped' });
    return editMessageText(env, { chatId: msg.telegram_chat_id, messageId: msg.telegram_message_id, text: renderApprovalCard(cardMeta, { status: 'skipped', icon: '⏭', who }), clearButtons: true });
  }
  const r = await sendPostsaleMessage(env, db, msg, cfg, { decidedBy: who });
  const status = r.ok ? (cfg.dry_run ? 'approved (dry-run)' : 'sent') : 'send failed';
  await answerCallbackQuery(env, { id: cq.id, text: r.ok ? (cfg.dry_run ? 'Approved — dry-run, nothing sent' : 'Sent to the buyer') : 'Send failed: ' + (r.detail || r.error), showAlert: !r.ok });
  return editMessageText(env, { chatId: msg.telegram_chat_id, messageId: msg.telegram_message_id, text: renderApprovalCard(cardMeta, { status, icon: r.ok ? '✅' : '⚠️', who }), clearButtons: true });
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
    const newOrders = [];
    while (page <= MAX_PAGES) {
      const res = await getOrders(env, { modTimeFrom, modTimeTo, page, entriesPerPage: 100, orderStatus: 'Completed' });
      if (!res.ok) return finishPoll(started, trigger, { ok: false, error: 'GetOrders failed', ack: res.ack, errors: res.errors });
      for (const o of res.orders) {
        seen++;
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

    // Fire alerts AFTER ingest (network, outside the DB txn). Serialised inside sendMessage.
    for (const { o, repeat } of newOrders) {
      try { await fireSaleAlert(env, db, o, repeat, cfg); } catch (e) { console.warn('[postsale] sale alert failed —', e?.message || e); }
    }
    if (ingested) console.log(`[postsale] order-poll: ${ingested} new paid order(s) ingested (${seen} seen)`);
    // Draft (and, in approve mode, queue for approval; in auto mode, send) the pending backlog.
    // messaging:false runs the fulfilment side (orders + alerts + dashboard) without the LLM drafting.
    const msg = (cfg.messaging === false) ? { skipped: 'messaging_off' } : await processMessages(env, db, cfg);
    return finishPoll(started, trigger, { ok: true, seen, ingested, skipped_unpaid: skippedUnpaid, skipped_pre_watermark: skippedPreWatermark, messages: msg, window: { from: modTimeFrom, to: modTimeTo } });
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
export async function runPackDigest(env, db, { force = false } = {}) {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.alerts) return { skipped: 'disabled' };
  if (!telegramEnabled(env) || !telegramChatConfigured(env)) return { skipped: 'no_telegram' };
  const { date, hour } = localDateHour(cfg.timezone);
  if (!force) {
    if (hour < (cfg.digest_hour ?? 9)) return { skipped: 'before_digest_hour' };
    if (getMeta(db, 'last_pack_digest_date') === date) return { skipped: 'already_sent_today' };
  }
  const rows = db.prepare(`SELECT o.order_id, o.buyer_username, o.ship_city, o.ship_state, o.paid_time,
      (SELECT group_concat(title, ', ') FROM order_line_items WHERE order_id = o.order_id) items
      FROM orders o WHERE o.shipped_status = 'unshipped' ORDER BY o.paid_time ASC`).all();
  if (!rows.length) { setMeta(db, 'last_pack_digest_date', date); return { ok: true, count: 0 }; }
  const lines = rows.slice(0, 40).map((r) => `• ${escapeHtml(r.items || r.order_id)} — ${escapeHtml([r.ship_city, r.ship_state].filter(Boolean).join(', ') || '—')} · @${escapeHtml(r.buyer_username || '')}`);
  const more = rows.length > 40 ? `\n…and ${rows.length - 40} more` : '';
  const text = `📦 <b>To pack today</b> (${rows.length})\n${lines.join('\n')}${more}`;
  const r = await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text });
  if (r.ok) setMeta(db, 'last_pack_digest_date', date);
  _packDigest.last_run = { at: new Date().toISOString(), count: rows.length, ok: !!r.ok };
  return { ok: !!r.ok, count: rows.length };
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
        });
      }

      // GET /orders?limit=&status= — recent ingested orders + line items, each with a resolved
      // storage location (from the tracker inventory). status=unshipped|shipped filters the queue.
      if (p === '/orders' && method === 'GET') {
        const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '100', 10) || 100);
        const status = url.searchParams.get('status');
        const where = status === 'unshipped' ? `WHERE shipped_status='unshipped'`
          : status === 'shipped' ? `WHERE shipped_status='shipped'` : '';
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
        return send(res, 200, { orders: withItems });
      }

      // GET /picksheet?status= — one consolidated pull list across every unshipped order's line items,
      // each tagged with its stored location, SORTED by location (sealed_locations.sort_order first,
      // then alpha; unmatched → "Unsorted"). `groups` is the same rows pre-grouped for the printout.
      if (p === '/picksheet' && method === 'GET') {
        const status = url.searchParams.get('status') || 'unshipped';
        const where = status === 'all' ? '' : `WHERE shipped_status='unshipped'`;
        const orders = db.prepare(`SELECT order_id, buyer_username, sales_record_number, paid_time FROM orders ${where} ORDER BY COALESCE(paid_time, created_time) ASC`).all();
        const lookup = buildInventoryLookup();
        const rows = [];
        for (const o of orders) {
          const items = db.prepare('SELECT * FROM order_line_items WHERE order_id=?').all(o.order_id);
          attachLocations(db, [{ order_id: o.order_id, items }], lookup);
          for (const li of items) {
            rows.push({
              order_id: o.order_id, buyer_username: o.buyer_username, sales_record_number: o.sales_record_number,
              title: li.title, sku: li.sku, quantity: li.quantity, ebay_item_id: li.ebay_item_id,
              location: li.location || null, matched_kind: li.matched_kind || null,
            });
          }
        }
        const ps = buildPickSheet(rows, lookup?.locSort || new Map());
        return send(res, 200, { rows: ps.rows, groups: ps.groups, order_count: orders.length, item_count: ps.rows.length, unit_count: ps.unit_count });
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
          await editMessageText(env, { chatId: fresh.telegram_chat_id, messageId: fresh.telegram_message_id, text: renderApprovalCard({ buyerUsername: order?.buyer_username, repeat: !!fresh.is_repeat_buyer, itemsText: cardsText(db, fresh.order_id), subject: fresh.subject, body: fresh.body, dryRun: loadConfig().dry_run }), buttons: approvalButtons(fresh.id, loadConfig()) }).catch(() => {});
        }
        return send(res, 200, { ok: true, message: fresh });
      }
      // POST /messages/:id/regenerate — re-run the LLM draft.
      const regenM = p.match(/^\/messages\/(\d+)\/regenerate$/);
      if (regenM && method === 'POST') {
        const r = await redraftMessage(env, db, +regenM[1], loadConfig());
        return send(res, r.ok ? 200 : 502, r);
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
        const cfg = loadConfig();
        const dispatch = body.dispatch !== false;   // default: also mark dispatched on eBay
        let ebay = null;
        if (dispatch && cfg.dry_run) {
          ebay = { ok: true, dry_run: true };
        } else if (dispatch) {
          try {
            const r = await completeSale(env, { orderId: id, shipped: true, tracking: body.tracking || undefined, carrier: body.carrier || undefined });
            ebay = { ok: r.ok, ack: r.ack, errors: r.errors };
          } catch (e) { ebay = { ok: false, error: String(e?.message || e) }; }
        }
        const flip = !dispatch || !ebay || ebay.ok !== false;   // don't hide the order if the eBay write failed
        if (flip) {
          db.prepare(`UPDATE orders SET shipped_status='shipped', shipped_time=COALESCE(shipped_time, datetime('now')),
            tracking_number=COALESCE(?, tracking_number), carrier=COALESCE(?, carrier) WHERE order_id=?`)
            .run(body.tracking || null, body.carrier || null, id);
        }
        return send(res, flip ? 200 : 502, { ok: flip, dispatched: dispatch && !cfg.dry_run && !!(ebay && ebay.ok), dry_run: !!(dispatch && cfg.dry_run), ebay });
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
