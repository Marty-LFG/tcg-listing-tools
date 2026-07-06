// lib/repricer-db.mjs — the store-repricer's SQLite store (Node 24 built-in `node:sqlite`).
//
// Deliberately a SEPARATE database file (data/repricer.db) from the card-price tracker
// (data/tracker.db). The two subsystems are independent — the tracker watches card market
// prices; the repricer watches OUR live eBay listings vs competitors — so they get their own
// files, own WAL, own writer. Same zero-dependency `node:sqlite` approach as lib/db.mjs
// (ExperimentalWarning suppressed by the launcher's --disable-warning flag).
//
// Phase 1 uses only `reprice_proposals`, `seen_chats`, and `meta` (Telegram plumbing). The
// `listings` / `price_checks` tables are created now so the schema is stable when the eBay
// read+compare collector lands (Phase 3) — creating them empty costs nothing.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// TCG_REPRICER_DB overrides the location so the integration suite never touches the real DB.
export const REPRICER_DB_PATH = process.env.TCG_REPRICER_DB || path.join(ROOT, 'data', 'repricer.db');

const DDL = `
-- One row per active eBay listing of ours (populated in Phase 3 via GetMyeBaySelling).
CREATE TABLE IF NOT EXISTS listings (
  item_id TEXT PRIMARY KEY,               -- legacy eBay ItemID (the ReviseInventoryStatus key)
  sku TEXT,
  title TEXT,
  game TEXT,                              -- inferred from title/category for the comps query
  current_price REAL,
  currency TEXT NOT NULL DEFAULT 'AUD',
  quantity INTEGER,
  best_offer_enabled INTEGER,
  min_best_offer REAL,
  auto_accept_price REAL,
  active INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  last_scanned_at TEXT
);

-- History of how each listing stacked up against the market on each scan (Phase 3).
CREATE TABLE IF NOT EXISTS price_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  our_price REAL,
  cluster_low REAL, cluster_median REAL, target REAL,   -- target = cheapestInCluster - 0.01
  n_comparable INTEGER,
  confidence TEXT,                        -- 'low'|'medium'|'high'
  mode TEXT,                              -- 'asking'|'sold'
  delta_pct REAL,                         -- (target - our_price)/our_price * 100
  verdict TEXT                            -- 'underpriced'|'overpriced'|'ok'|'low_confidence'
);

-- The approve-then-apply queue. Every price change starts life here as 'pending' and only
-- becomes 'applied' after a human taps Approve in Telegram. Full audit trail (who/when).
CREATE TABLE IF NOT EXISTS reprice_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'reprice',   -- 'reprice' (real) | 'test' (Phase 1 dry-run, never writes to eBay)
  item_id TEXT,
  title TEXT,
  from_price REAL,
  to_price REAL,
  currency TEXT NOT NULL DEFAULT 'AUD',
  evidence TEXT,                          -- JSON: comps summary shown in the Telegram card
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|applied|skipped|expired|failed
  telegram_chat_id TEXT,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  decided_by TEXT, decided_at TEXT,
  applied_at TEXT,
  error TEXT
);

-- Chats the bot has seen (added-to / messaged in). Powers /api/repricer/chatid so setup can
-- discover the numeric chat_id without a competing getUpdates call (the poller feeds this).
CREATE TABLE IF NOT EXISTS seen_chats (
  id TEXT PRIMARY KEY,                    -- chat.id as string (channels/supergroups look like -100...)
  type TEXT, title TEXT, username TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Small key/value store (the Telegram long-poll offset cursor, etc.).
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_pc_item_ts ON price_checks(item_id, ts);
CREATE INDEX IF NOT EXISTS idx_prop_status ON reprice_proposals(status);
CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(active) WHERE active = 1;
`;

let _rdb = null;

export function openRepricerDb(dbPath = REPRICER_DB_PATH) {
  if (_rdb) return _rdb;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(DDL);
  _rdb = db;
  return db;
}

// --- meta helpers (Telegram offset cursor lives here) ---
export function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
export function setMeta(db, key, value) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

// Upsert a chat the bot has encountered (from message/channel_post/my_chat_member updates).
export function recordChat(db, chat) {
  if (!chat || chat.id == null) return;
  db.prepare(`INSERT INTO seen_chats (id, type, title, username, last_seen_at)
              VALUES (?,?,?,?, datetime('now'))
              ON CONFLICT(id) DO UPDATE SET
                type = excluded.type, title = excluded.title,
                username = excluded.username, last_seen_at = datetime('now')`)
    .run(String(chat.id), chat.type || null, chat.title || null, chat.username || null);
}
