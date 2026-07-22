// lib/postsale-db.mjs — the post-sale automation store (Node 24 built-in `node:sqlite`).
//
// Deliberately a SEPARATE database file (data/postsale.db) from the card-price tracker
// (data/tracker.db) and the repricer (data/repricer.db). This subsystem owns eBay order
// ingestion + buyer CRM + the post-purchase message state machine — its own domain, own
// WAL, own writer, and it holds buyer PII (shipping addresses) so isolating it keeps the
// money/PII surface small for backup + redaction. Same zero-dependency `node:sqlite`
// approach and singleton/WAL conventions as lib/repricer-db.mjs.
//
// GR3: all money is INTEGER CENTS. Buyer email is NEVER stored (eBay masks it); we key
// buyers by eBay username / opaque UserID and message through the platform.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// TCG_POSTSALE_DB overrides the location so the integration suite never touches the real DB.
export const POSTSALE_DB_PATH = process.env.TCG_POSTSALE_DB || path.join(ROOT, 'data', 'postsale.db');

const DDL = `
-- Mini-CRM: one row per eBay buyer. Keyed by username (what GetOrders returns as BuyerUserID
-- and what AddMemberMessageAAQToPartner needs as RecipientID). buyer_user_id holds the opaque
-- immutable id when eBay provides one (GetMemberMessages SenderID is moving to that).
CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ebay_username TEXT NOT NULL UNIQUE,
  buyer_user_id TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  order_count   INTEGER NOT NULL DEFAULT 0,
  total_spent_cents INTEGER NOT NULL DEFAULT 0,   -- GR3
  notes TEXT
);

-- One row per eBay OrderID (idempotent ingest key). Carries the shipping address the seller
-- receives for fulfilment (email stays masked) — powers sale alerts + label queue.
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  buyer_username TEXT,
  order_status TEXT,                     -- eBay OrderStatus (Active|Completed|Cancelled|...)
  checkout_status TEXT,                  -- CheckoutStatus.Status (Complete|Incomplete)
  paid_status TEXT,                      -- CheckoutStatus.eBayPaymentStatus
  created_time TEXT, paid_time TEXT, shipped_time TEXT,
  currency TEXT NOT NULL DEFAULT 'AUD',
  total_cents INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER, shipping_cents INTEGER,
  ship_service TEXT,
  -- Order.ShippingAddress (AddressType)
  ship_name TEXT, ship_street1 TEXT, ship_street2 TEXT, ship_city TEXT,
  ship_state TEXT, ship_postal TEXT, ship_country TEXT, ship_country_name TEXT, ship_phone TEXT,
  shipped_status TEXT NOT NULL DEFAULT 'unshipped',   -- unshipped|shipped
  tracking_number TEXT, carrier TEXT,
  fees_cents INTEGER, fees_synced_at TEXT,            -- SUM of fee_transactions (C); NULL until fees-sync
  label_status TEXT,                                  -- null|queued|printed|skipped (G)
  sale_alert_sent_at TEXT, pack_digest_date TEXT,     -- alert dedupe
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw TEXT                                            -- JSON order snapshot (audit)
);

-- One row per Transaction / OrderLineItem; carries the reconciliation link to our stock.
CREATE TABLE IF NOT EXISTS order_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  order_line_item_id TEXT, transaction_id TEXT,
  ebay_item_id TEXT, sku TEXT, title TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  line_fee_cents INTEGER,                             -- from Finances marketplaceFees (C)
  matched_kind TEXT,                                  -- 'inventory'|'sealed'|null
  matched_item_id INTEGER,                            -- tracker.db inventory_items.id / sealed_items.id
  match_method TEXT,                                  -- 'sku'|'item_id'|'manual'|null
  reconciled_at TEXT
);

-- The post-purchase message state machine (modeled on repricer's reprice_proposals).
-- One first-message per order (UNIQUE order_id) = idempotency: an order is never messaged twice.
CREATE TABLE IF NOT EXISTS postsale_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  ebay_item_id TEXT,                                  -- representative ItemID used for the send
  is_repeat_buyer INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
     -- pending|drafted|awaiting_approval|sent|skipped|failed|replied|closed
  subject TEXT, body TEXT, model TEXT,
  telegram_chat_id TEXT, telegram_message_id INTEGER,
  decided_by TEXT, decided_at TEXT,
  sent_at TEXT, reply_detected_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Buyer questions + reply detection (F). GetMemberMessages returns buyer-sent messages only.
CREATE TABLE IF NOT EXISTS member_messages (
  message_id TEXT PRIMARY KEY,
  message_type TEXT,                                  -- 'AskSellerQuestion'|...
  sender_id TEXT, ebay_item_id TEXT, order_id TEXT,
  subject TEXT, body TEXT,
  status TEXT,                                        -- 'Answered'|'Unanswered'
  creation_time TEXT, seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  alert_sent_at TEXT, raw TEXT
);

-- Finances ledger (C) — idempotent by Finances transactionId; SALE + NON_SALE_CHARGE both land here.
CREATE TABLE IF NOT EXISTS fee_transactions (
  transaction_id TEXT PRIMARY KEY,
  order_id TEXT, transaction_type TEXT,               -- SALE|NON_SALE_CHARGE|REFUND|CREDIT
  fee_type TEXT,                                      -- FINAL_VALUE_FEE|FINAL_VALUE_FEE_FIXED_PER_ORDER|...
  amount_cents INTEGER, currency TEXT NOT NULL DEFAULT 'AUD',
  booking_date TEXT, raw TEXT
);

-- Open returns / INR inquiries / cancellations / (future) payment disputes (F).
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,                           -- namespaced: return:{id}|inquiry:{id}|cancel:{id}|dispute:{id}
  case_type TEXT,                                     -- 'return'|'inquiry'|'cancellation'|'payment_dispute'
  order_id TEXT, ebay_item_id TEXT, transaction_id TEXT, buyer_user_id TEXT,
  status TEXT, reason TEXT, open_close TEXT,          -- open|closed (derived)
  amount_cents INTEGER, currency TEXT,
  creation_date TEXT, respond_by_date TEXT,           -- SLA deadline for the alert
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT, status_changed_at TEXT, alert_sent_at TEXT, raw TEXT
);

-- Small key/value store — poll cursors + the activation watermark.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE INDEX IF NOT EXISTS idx_orders_buyer   ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_shipped ON orders(shipped_status);
CREATE INDEX IF NOT EXISTS idx_oli_order      ON order_line_items(order_id);
CREATE INDEX IF NOT EXISTS idx_oli_match      ON order_line_items(matched_kind, matched_item_id);
CREATE INDEX IF NOT EXISTS idx_ps_status      ON postsale_messages(status);
CREATE INDEX IF NOT EXISTS idx_ps_buyer       ON postsale_messages(buyer_id);
CREATE INDEX IF NOT EXISTS idx_mm_status      ON member_messages(status);
CREATE INDEX IF NOT EXISTS idx_fee_order      ON fee_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_cases_open     ON cases(open_close);
`;

let _pdb = null;

// node:sqlite has no ADD COLUMN IF NOT EXISTS — guard with PRAGMA table_info so the migration is
// idempotent + metadata-only (existing rows just get NULLs). Mirrors lib/db.mjs addColumnIfMissing.
function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.length && !cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
// Additive columns that shipped after orders existed (CREATE IF NOT EXISTS won't add them). The
// packing slip renders SalesRecordNumber ("Sales record #") + the buyer's checkout note.
function migratePostsale(db) {
  addColumnIfMissing(db, 'orders', 'sales_record_number', 'TEXT');
  addColumnIfMissing(db, 'orders', 'buyer_note', 'TEXT');
}

export function openPostsaleDb(dbPath = POSTSALE_DB_PATH) {
  if (_pdb) return _pdb;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');   // order_line_items / postsale_messages cascade with their order
  db.exec(DDL);
  try { migratePostsale(db); } catch (e) { console.error('[postsale-db] migration:', e?.message || e); }
  _pdb = db;
  return db;
}

// --- meta helpers (poll cursors + activation watermark live here) ---
export function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
export function setMeta(db, key, value) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}
