// lib/db.mjs — the price-tracker's SQLite store (Node 24 built-in `node:sqlite`).
//
// Why node:sqlite: zero new dependencies (package.json stays vite-only, no native
// toolchain). It emits an ExperimentalWarning on import — suppressed in the service
// launcher via `--disable-warning=ExperimentalWarning` (scripts/run-dev.mjs).
//
// ALL database access funnels through this file. To swap to better-sqlite3 later,
// change only the import + `new DatabaseSync(...)` line below — the prepare/run/get/all
// surface is identical.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const DB_PATH = path.join(ROOT, 'data', 'tracker.db');

const DDL = `
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,                          -- 'riftbound'|'mtg'|'pokemon'|'swu'|'lorcana'
  identity_key TEXT NOT NULL,                  -- 'OGN-296'|'neo-1'|'sv4-25'|'sor/010'|'1/207'
  name TEXT NOT NULL,
  variant TEXT,                                -- finish/foil/alt-art; nullable
  source TEXT NOT NULL DEFAULT 'user',         -- 'user'|'claude'
  note TEXT,
  review_status TEXT NOT NULL DEFAULT 'ok',    -- claude-added => 'pending'
  active INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  last_error TEXT,                             -- 'scrydex_key_missing'|'no_price'|'http_404'|null
  UNIQUE(game, identity_key, variant)          -- foil vs nonfoil vs alt-art stay distinct
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  market REAL, low REAL, currency TEXT NOT NULL,
  market_aud REAL, fx_usd_aud REAL,
  source TEXT NOT NULL,                         -- 'scrydex'|'scryfall'|'pokemontcg'|'swudb'|'manual'
  pct_1d REAL, pct_7d REAL, pct_30d REAL, pct_90d REAL,   -- Scrydex deltas stored directly
  raw TEXT                                       -- JSON of the mapped price object
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,                           -- 'opportunity'|'momentum'|'downtrend'
  window TEXT, pct REAL,
  from_price REAL, to_price REAL, currency TEXT,
  message TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  acknowledged INTEGER NOT NULL DEFAULT 0
);

-- Latest full upstream payload per card (one row, upserted each fetch). Durable
-- local copy of whatever a source returns + conserves API credits (esp. Scrydex).
CREATE TABLE IF NOT EXISTS card_cache (
  game TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  http_status INTEGER,
  source TEXT,
  payload TEXT,
  PRIMARY KEY (game, identity_key)
);

CREATE INDEX IF NOT EXISTS idx_snap_card_ts ON price_snapshots(card_id, ts);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON price_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_signals_card ON signals(card_id, ts);
CREATE INDEX IF NOT EXISTS idx_signals_unnotified ON signals(notified) WHERE notified = 0;
CREATE INDEX IF NOT EXISTS idx_watch_active ON watchlist(active) WHERE active = 1;

-- ======================= INVENTORY (Binders Keepers) =======================
-- Graded-card stock, cost basis / P&L, live graded valuation, and the grading
-- pipeline. Phase 1 of an inventory platform that will become the source of
-- truth for eBay/Shopify (channel_* columns are RESERVED now so a future push
-- needs no migration). MONEY IS INTEGER CENTS (Golden Rule 3). Same DB as the
-- tracker so an item can FK a watchlist row and reuse the collector's raw price.

-- Raw cards SUBMITTED to a grader; promoted into inventory_items when the slab
-- returns. Declared before inventory_items because inventory_items.submission_id
-- references it.
CREATE TABLE IF NOT EXISTS grading_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- identity (same scheme as watchlist; carried over on promote)
  game TEXT NOT NULL,                          -- 'riftbound'|'mtg'|'pokemon'|'swu'|'lorcana'
  identity_key TEXT,                           -- 'sv4-25' etc. (nullable: manual-only)
  name TEXT NOT NULL,
  set_name TEXT,
  number TEXT,
  variant TEXT,                                -- finish/foil/alt-art
  language TEXT NOT NULL DEFAULT 'EN',
  grading_company TEXT NOT NULL,               -- PSA|BGS|CGC|SGC|TAG (data/grading.config.json)
  tier TEXT,                                   -- fee tier label from grading.config fees[company][]
  declared_value_cents INTEGER,
  grading_cost_cents INTEGER,                  -- fee (+ shipping) paid; becomes acq cost on promote
  submitted_at TEXT,
  expected_return_at TEXT,                      -- submitted_at + tier turnaroundDays (calendar est.)
  status TEXT NOT NULL DEFAULT 'draft',         -- 'draft'|'submitted'|'received'|'graded'
  tracking TEXT,                               -- carrier tracking number
  -- filled when the slab returns / on promote
  result_grade REAL,
  result_grade_label TEXT,
  result_subgrades TEXT,                       -- JSON {centering,corners,edges,surface}
  cert_number TEXT,
  promoted_item_id INTEGER,                    -- FK to inventory_items(id) set on promote
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Graded-card stock (the source-of-truth record).
CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,                     -- generated, e.g. BK-PKM-000042

  -- identity (same scheme as watchlist)
  game TEXT NOT NULL,
  identity_key TEXT,                           -- nullable for manual-only items
  name TEXT NOT NULL,
  set_name TEXT,
  number TEXT,
  variant TEXT,
  language TEXT NOT NULL DEFAULT 'EN',

  -- grading (null grading_company => a raw single held in stock)
  grading_company TEXT,                        -- PSA|BGS|CGC|SGC|TAG
  grade REAL,                                  -- 10, 9.5, 9 ...
  grade_label TEXT,                            -- 'Gem Mint 10'
  subgrades TEXT,                              -- JSON or null
  cert_number TEXT,
  graded_date TEXT,

  -- stock
  quantity INTEGER NOT NULL DEFAULT 1,
  location TEXT,                               -- storage box/binder/shelf
  status TEXT NOT NULL DEFAULT 'in_stock',      -- 'in_stock'|'listed'|'sold'

  -- acquisition / cost basis (cents)
  cost_cents INTEGER,                          -- price paid
  acq_fees_cents INTEGER,                      -- buy-side fees/shipping/grading
  acquired_at TEXT,
  source_vendor TEXT,

  -- sale (filled when status -> sold; cents)
  sale_price_cents INTEGER,
  sale_fees_cents INTEGER,
  sold_at TEXT,

  target_price_cents INTEGER,
  notes TEXT,

  -- valuation cache (latest graded value; full history in inventory_valuations)
  value_cents INTEGER,
  value_currency TEXT DEFAULT 'USD',
  value_source TEXT,                           -- 'pricecharting'|'ebay'|'manual'
  value_manual INTEGER NOT NULL DEFAULT 0,     -- 1 = user override; don't auto-overwrite
  value_updated_at TEXT,

  -- media
  image_url TEXT,                              -- card/slab image (resolved from the game API by identity, or PSA cert image)

  -- links
  watchlist_id INTEGER REFERENCES watchlist(id) ON DELETE SET NULL,          -- raw market via collector
  submission_id INTEGER REFERENCES grading_submissions(id) ON DELETE SET NULL,

  -- channel-ready (RESERVED — eBay/Shopify push deferred)
  ebay_listing_id TEXT,
  shopify_product_id TEXT,
  channel_status TEXT,                         -- null|'draft'|'active'|'ended'

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Graded-value history per item (feeds the value sparkline via TCG.lineGraph).
CREATE TABLE IF NOT EXISTS inventory_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  value_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL,                        -- 'pricecharting'|'ebay'|'manual'
  grade_label TEXT,                            -- which ladder rung mapped (e.g. 'PSA 10')
  sample_size INTEGER,                         -- eBay comps count when source='ebay'
  raw TEXT                                     -- JSON of the mapped valuation payload
);

-- Monotonic per-namespace counter for readable SKUs.
CREATE TABLE IF NOT EXISTS sku_counter (
  namespace TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_inv_status  ON inventory_items(status);
CREATE INDEX IF NOT EXISTS idx_inv_game    ON inventory_items(game);
CREATE INDEX IF NOT EXISTS idx_inv_company ON inventory_items(grading_company);
CREATE INDEX IF NOT EXISTS idx_inv_watch   ON inventory_items(watchlist_id);
CREATE INDEX IF NOT EXISTS idx_inv_cert    ON inventory_items(cert_number);
CREATE INDEX IF NOT EXISTS idx_val_item    ON inventory_valuations(item_id, ts);
CREATE INDEX IF NOT EXISTS idx_sub_status  ON grading_submissions(status);
`;

let _db = null;

// Opens (once per process) and initialises the tracker DB. Returns the live handle.
export function openDb(dbPath = DB_PATH) {
  if (_db) return _db;
  const db = new DatabaseSync(dbPath);
  // WAL lets a UI read overlap a collector write without "database is locked";
  // busy_timeout covers the brief contention window between the two.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(DDL);
  // Additive migrations for DBs created before a column shipped (CREATE IF NOT EXISTS
  // won't add columns to an existing table). Safe to run every boot.
  try {
    const cols = db.prepare(`PRAGMA table_info(inventory_items)`).all();
    if (cols.length && !cols.some((c) => c.name === 'image_url')) {
      db.exec(`ALTER TABLE inventory_items ADD COLUMN image_url TEXT`);
    }
  } catch {}
  _db = db;
  return db;
}
