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
// TCG_TRACKER_DB overrides the location so the integration suite never touches the real DB.
export const DB_PATH = process.env.TCG_TRACKER_DB || path.join(ROOT, 'data', 'tracker.db');

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
  image_manual INTEGER NOT NULL DEFAULT 0,     -- 1 = user pinned the image; never auto-replace (GR7 for sets we can't resolve)

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

-- ===================== BULK LISTING (Binders Keepers: Bulk) =====================
-- Per-set / per-import bulk listing runs. A batch is the header for one bulk run
-- (a set enumeration OR a Collectr portfolio import); its rows are inventory_items
-- with batch_id set (added by migrateBulk below). MONEY IS INTEGER CENTS (Golden
-- Rule 3). Full model: docs/BULK_LISTING_DESIGN.md §4.

CREATE TABLE IF NOT EXISTS bulk_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT,                                   -- riftbound|mtg|pokemon|swu|lorcana (null: mixed import)
  source TEXT NOT NULL DEFAULT 'enumerate',    -- 'enumerate' | 'collectr'
  set_code TEXT,
  set_name TEXT,                               -- set name, or Collectr Portfolio Name
  listing_shape TEXT NOT NULL DEFAULT 'per_card',   -- 'per_card' | 'multi_variation' (experimental on EBAY_AU)
  language TEXT NOT NULL DEFAULT 'EN',
  pricing_config TEXT,                         -- JSON snapshot of tiers/thresholds used this run (GR4 audit)
  fx_usd_aud REAL,                             -- FX rate captured at pricing time
  status TEXT NOT NULL DEFAULT 'draft',        -- 'draft'|'priced'|'saved'|'exported'|'archived'
  export_shape TEXT,                           -- last exported shape
  exported_at TEXT,
  item_count   INTEGER NOT NULL DEFAULT 0,     -- distinct rows
  unit_count   INTEGER NOT NULL DEFAULT 0,     -- sum(quantity)
  listed_count INTEGER NOT NULL DEFAULT 0,
  sold_count   INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batch_game   ON bulk_batches(game);
CREATE INDEX IF NOT EXISTS idx_batch_status ON bulk_batches(status);

-- Audit log of every CSV generated / (Phase 2) Sell-API push per batch.
CREATE TABLE IF NOT EXISTS channel_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,                        -- 'ebay-csv' | 'ebay-inventory-api'
  shape TEXT NOT NULL,                          -- 'per_card' | 'multi_variation'
  marketplace TEXT NOT NULL DEFAULT 'EBAY_AU',
  batch_id INTEGER REFERENCES bulk_batches(id) ON DELETE SET NULL,
  item_ids TEXT NOT NULL,                       -- JSON array of inventory_items.id
  artifact_path TEXT,                           -- CSV file path (data/exports/…), null for API pushes
  result TEXT,                                  -- JSON jobResults for API pushes
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== SEALED PRODUCT INVENTORY (Binders Keepers: Sealed) ====================
-- Sealed TCG product stock (booster boxes, ETBs, bundles, tins, blisters, collections, packs,
-- cases) for Pokémon / MTG / Riftbound — a sibling of the graded-card inventory above with
-- grading removed and barcode/product-type added. Same DB + conventions: MONEY IS INTEGER CENTS
-- (Golden Rule 3); reserved channel_* columns for a future eBay/Shopify push. Served by
-- lib/sealed.mjs at /api/sealed. Barcodes resolve via PriceCharting (UPC) with a local
-- sealed_barcodes cache + manual entry as the always-works backbone (Golden Rule 7).

-- Scan-session header (one bulk barcode-scan run); its rows are sealed_items with batch_id set.
-- Declared before sealed_items (which references it).
CREATE TABLE IF NOT EXISTS sealed_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  source TEXT NOT NULL DEFAULT 'scan',          -- 'scan'|'manual'
  status TEXT NOT NULL DEFAULT 'saved',
  item_count INTEGER NOT NULL DEFAULT 0,        -- distinct rows
  unit_count INTEGER NOT NULL DEFAULT 0,        -- sum(quantity)
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sealed-product stock (the source-of-truth record).
CREATE TABLE IF NOT EXISTS sealed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,                      -- generated, e.g. BK-SLD-PKM-000042

  -- identity
  game TEXT NOT NULL,                            -- 'pokemon'|'mtg'|'riftbound' (extensible)
  product_type TEXT NOT NULL,                    -- booster_box|elite_trainer_box|booster_bundle|blister|tin|
                                                 -- collection|premium_collection|booster_pack|booster_case|
                                                 -- starter_deck|commander_deck|prerelease_pack|other (validated in lib/sealed.mjs)
  name TEXT NOT NULL,
  set_name TEXT,
  language TEXT NOT NULL DEFAULT 'EN',

  -- barcode / pricing identity
  upc TEXT,                                      -- scanned/resolved barcode
  pc_product_id TEXT,                            -- PriceCharting product id (valuation key)
  pc_url TEXT,                                   -- resolved PriceCharting product page

  -- sealed condition / configuration
  condition TEXT NOT NULL DEFAULT 'sealed',      -- 'sealed'|'opened'|'damaged'
  factory_sealed INTEGER NOT NULL DEFAULT 1,
  pack_count INTEGER,                            -- packs in a box/bundle (nullable)
  units_per_case INTEGER,                        -- boxes per case (nullable)

  -- stock
  quantity INTEGER NOT NULL DEFAULT 1,
  location TEXT,                                 -- storage box/shelf
  status TEXT NOT NULL DEFAULT 'in_stock',       -- 'in_stock'|'listed'|'sold'

  -- acquisition / cost basis (cents)
  cost_cents INTEGER, acq_fees_cents INTEGER, acquired_at TEXT, source_vendor TEXT,

  -- sale (filled when status -> sold; cents)
  sale_price_cents INTEGER, sale_fees_cents INTEGER, sold_at TEXT,
  target_price_cents INTEGER, notes TEXT,

  -- valuation cache (latest sealed value; full history in sealed_valuations)
  value_cents INTEGER,
  value_currency TEXT DEFAULT 'USD',
  value_source TEXT,                             -- 'pricecharting'|'ebay'|'manual'
  value_manual INTEGER NOT NULL DEFAULT 0,       -- 1 = user override; don't auto-overwrite
  value_updated_at TEXT,

  -- media
  image_url TEXT, image_manual INTEGER NOT NULL DEFAULT 0,

  -- scan session
  batch_id INTEGER REFERENCES sealed_batches(id) ON DELETE SET NULL,

  -- channel-ready (RESERVED — eBay/Shopify push deferred)
  ebay_listing_id TEXT,
  shopify_product_id TEXT,
  channel_status TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sealed-value history per item (feeds the value sparkline via TCG.lineGraph).
CREATE TABLE IF NOT EXISTS sealed_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES sealed_items(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  value_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL,                          -- 'pricecharting'|'ebay'|'manual'
  price_label TEXT,                             -- which rung mapped (e.g. 'New'/'Loose')
  sample_size INTEGER,                          -- eBay comps count when source='ebay'
  raw TEXT
);

-- Local barcode -> product cache (the always-works backbone). Every resolved OR user-confirmed
-- UPC is upserted here so repeat scans are instant + offline, and a private barcode DB accretes.
CREATE TABLE IF NOT EXISTS sealed_barcodes (
  upc TEXT PRIMARY KEY,                          -- normalized digits (UPC-A / EAN-13)
  game TEXT,
  name TEXT, set_name TEXT, product_type TEXT,   -- denormalized for fast display/search
  pc_product_id TEXT, pc_url TEXT, image_url TEXT,
  suggested_cents INTEGER, suggested_currency TEXT DEFAULT 'USD',
  product_json TEXT,                            -- full resolved payload
  source TEXT,                                  -- 'pricecharting-api'|'pricecharting-scrape'|'manual'
  confidence TEXT,                              -- 'high'|'medium'|'low'|'manual'
  confirmed INTEGER NOT NULL DEFAULT 0,         -- user confirmed the mapping (remembered manual entry)
  hit_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sealed_status ON sealed_items(status);
CREATE INDEX IF NOT EXISTS idx_sealed_game   ON sealed_items(game);
CREATE INDEX IF NOT EXISTS idx_sealed_type   ON sealed_items(product_type);
CREATE INDEX IF NOT EXISTS idx_sealed_upc    ON sealed_items(upc);
CREATE INDEX IF NOT EXISTS idx_sealed_batch  ON sealed_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_sval_item     ON sealed_valuations(item_id, ts);
`;

let _db = null;

// node:sqlite has no ADD COLUMN IF NOT EXISTS — guard with PRAGMA table_info so the
// migration is idempotent + metadata-only (existing rows just get NULLs).
function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.length && !cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// Bulk-listing columns on inventory_items + the raw-only identity index.
// Runs every boot after db.exec(DDL); safe on existing DBs (no data loss).
function migrateBulk(db) {
  addColumnIfMissing(db, 'inventory_items', 'batch_id', 'INTEGER REFERENCES bulk_batches(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'inventory_items', 'rarity', 'TEXT');            // tier lookup + titles
  addColumnIfMissing(db, 'inventory_items', 'edition', 'TEXT');           // '1st Edition'|'Unlimited'|null (GR5)
  addColumnIfMissing(db, 'inventory_items', 'condition', 'TEXT');         // raw-single condition ('Near Mint' …)
  addColumnIfMissing(db, 'inventory_items', 'ebay_offer_id', 'TEXT');     // Phase 2 Sell API offer id
  addColumnIfMissing(db, 'inventory_items', 'title_override', 'TEXT');    // persisted manual title edit
  addColumnIfMissing(db, 'inventory_items', 'desc_override', 'TEXT');     // persisted manual description edit
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_batch ON inventory_items(batch_id);`);
  // One row per (card × printing) for RAW bulk items only — mirrors watchlist
  // UNIQUE(game, identity_key, variant). Excludes graded slabs (distinct physical
  // items: a raw Charizard and a TAG 10 Charizard must both persist) and non-bulk
  // rows (batch_id NULL — the graded/manual inventory may legitimately repeat a card).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_bulk_identity
    ON inventory_items(game, identity_key, variant)
    WHERE batch_id IS NOT NULL AND grading_company IS NULL;`);
}

// Future additive columns for the sealed-inventory tables land here. The four sealed tables
// (sealed_items/sealed_valuations/sealed_barcodes/sealed_batches) ship complete via
// CREATE IF NOT EXISTS, so there is nothing to backfill yet. Safe to run every boot.
// eslint-disable-next-line no-unused-vars
function migrateSealed(db) {
  // e.g. addColumnIfMissing(db, 'sealed_items', 'new_col', 'TEXT');
}

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
    addColumnIfMissing(db, 'inventory_items', 'image_url', 'TEXT');
    addColumnIfMissing(db, 'inventory_items', 'image_manual', 'INTEGER NOT NULL DEFAULT 0');
    migrateBulk(db);
    migrateSealed(db);
  } catch (e) { console.error('[db] migration:', e?.message || e); }
  _db = db;
  return db;
}
