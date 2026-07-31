// lib/repricer-db.mjs — the store-repricer's SQLite store (Node 24 built-in `node:sqlite`).
//
// Deliberately a SEPARATE database file (data/repricer.db) from the card-price tracker
// (data/tracker.db). The two subsystems are independent — the tracker watches card market
// prices; the repricer watches OUR live eBay listings vs competitors — so they get their own
// files, own WAL, own writer. Same zero-dependency `node:sqlite` approach as lib/db.mjs
// (ExperimentalWarning suppressed by the launcher's --disable-warning flag).
//
// Tables: `reprice_proposals` (the approve-then-apply queue), `price_checks` (one row per listing
// per scan — the audit trail shadow mode is judged on), `seen_chats` and `meta` (Telegram plumbing).
// Money is integer cents throughout (GR3); migrate() below moves an older database off the REAL
// dollars this store used until Phase 3.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// TCG_REPRICER_DB overrides the location so the integration suite never touches the real DB.
export const REPRICER_DB_PATH = process.env.TCG_REPRICER_DB || path.join(ROOT, 'data', 'repricer.db');

// Schema version for migrate() below. Bump when the shape changes.
const SCHEMA_VERSION = 1;

const DDL = `
-- NOTE: there is deliberately no \`listings\` table. Phase 3 reads OUR live listings from
-- ebay_seller_listings in the TRACKER db (lib/db.mjs), which is the ItemID-keyed mirror the apply
-- path already requires — reviseTradingListing refuses any listing absent from it. A second mirror
-- here would lack the two columns the scan cannot work without (created_via, to route Trading vs
-- Inventory API; listing_type, to exclude auctions) and would guarantee drift between them.

-- One row per listing per scan: what the market said and what we decided. This is the audit trail
-- shadow mode is judged on, so it records the REFUSALS too, with the specific guardrail that fired.
CREATE TABLE IF NOT EXISTS price_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  scan_id TEXT,                           -- groups every row written by one pass
  our_price_cents INTEGER,                -- our LIST price at scan time
  our_postage_cents INTEGER,              -- needed to read target_delivered_cents correctly
  -- Comps speak in DELIVERED prices (competitor list + competitor postage); target_cents is the
  -- LIST price that follows from it. Storing both is what makes a surprising row explainable.
  target_delivered_cents INTEGER,
  target_cents INTEGER,                   -- post-cap, post-snap: the number a proposal would carry
  cluster_lo_cents INTEGER, cluster_hi_cents INTEGER,
  fair_cents INTEGER, cheapest_cents INTEGER,
  n_comparable INTEGER,                   -- rows that survived the precision filter
  sample_size INTEGER,                    -- rows eBay returned before it
  reliable INTEGER,                       -- the comps engine's own trust flag
  confidence TEXT,                        -- 'low'|'medium'|'high'
  mode TEXT,                              -- 'asking'|'sold'
  query TEXT,                             -- without this a comp set cannot be reproduced
  uplift_cents INTEGER, uplift_pct REAL,
  verdict TEXT NOT NULL,                  -- 'raise'|'hold'|'decline'|'skip'
  code TEXT,                              -- the specific reason; null on a raise
  proposal_id INTEGER                     -- set when this check produced a proposal
);

-- The approve-then-apply queue. Every price change starts life here as 'pending' and only
-- becomes 'applied' after a human taps Approve in Telegram. Full audit trail (who/when).
CREATE TABLE IF NOT EXISTS reprice_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'reprice',   -- 'reprice' (real) | 'test' (Phase 1 dry-run, never writes to eBay)
  item_id TEXT,
  title TEXT,
  -- Integer cents (GR3). These were REAL dollars until Phase 3, the only money in the repo that
  -- wasn't — and the rounding out of them became load-bearing once expectPriceCents turned into an
  -- apply precondition, where a one-cent float drift makes eBay refuse with an unexplained
  -- price_moved. The columns were RENAMED in the migration, never reinterpreted in place: a column
  -- that keeps its name and changes its units is how you get a 100x price.
  from_price_cents INTEGER,
  to_price_cents INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_pc_scan ON price_checks(scan_id);
CREATE INDEX IF NOT EXISTS idx_pc_verdict ON price_checks(verdict, ts);
CREATE INDEX IF NOT EXISTS idx_prop_status ON reprice_proposals(status);
`;

// Runs BEFORE the DDL, so it sees the old shape on an existing database and does nothing at all on
// a fresh one (no tables yet). Guarded by PRAGMA user_version, so it is a no-op on every boot after
// the first. Never destructive without checking: the one table it drops is verified empty first.
export function migrate(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version || 0;
  if (v >= SCHEMA_VERSION) return { migrated: false, from: v };
  const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  const steps = [];

  // Money: REAL dollars -> INTEGER cents, under NEW column names.
  if (hasTable('reprice_proposals') && cols('reprice_proposals').includes('from_price')) {
    db.exec('ALTER TABLE reprice_proposals ADD COLUMN from_price_cents INTEGER');
    db.exec('ALTER TABLE reprice_proposals ADD COLUMN to_price_cents INTEGER');
    db.exec(`UPDATE reprice_proposals SET
      from_price_cents = CAST(ROUND(COALESCE(from_price, 0) * 100) AS INTEGER),
      to_price_cents   = CAST(ROUND(COALESCE(to_price, 0) * 100) AS INTEGER)`);
    db.exec('ALTER TABLE reprice_proposals DROP COLUMN from_price');
    db.exec('ALTER TABLE reprice_proposals DROP COLUMN to_price');
    steps.push('reprice_proposals money -> cents');
  }

  // price_checks is replaced wholesale rather than widened — the old shape stored dollars and had no
  // room for the decline reason, the query, or the delivered/list distinction. It has never had a
  // writer, so it should be empty; if it somehow isn't, keep the rows aside rather than delete them.
  if (hasTable('price_checks') && cols('price_checks').includes('our_price')) {
    const n = db.prepare('SELECT COUNT(*) c FROM price_checks').get().c;
    if (n > 0) { db.exec('ALTER TABLE price_checks RENAME TO price_checks_v0'); steps.push(`price_checks kept aside as price_checks_v0 (${n} rows)`); }
    else { db.exec('DROP TABLE price_checks'); steps.push('price_checks rebuilt'); }
  }

  // The repricer's own listings mirror is redundant against ebay_seller_listings (see the DDL note).
  if (hasTable('listings')) {
    db.exec('DROP INDEX IF EXISTS idx_listings_active');
    db.exec('DROP TABLE listings');
    steps.push('dropped the redundant listings mirror');
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  if (steps.length) console.log('[repricer-db] migrated v' + v + ' -> v' + SCHEMA_VERSION + ': ' + steps.join('; '));
  return { migrated: true, from: v, to: SCHEMA_VERSION, steps };
}

let _rdb = null;

export function openRepricerDb(dbPath = REPRICER_DB_PATH) {
  if (_rdb) return _rdb;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);   // old shape -> new, before the DDL fills in anything still missing
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
