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

-- Catalog card-LIST cache: one row per SET (game+lang+set_code), payload = the normalized
-- card[] the catalog drawer renders. Kept separate from card_cache (which is one-row-per-CARD,
-- owned by the price tracker + shares a game namespace with watchlist) so those readers stay
-- clean. Regenerable artifact; 24h read-time TTL lives in lib/catalog.mjs. Lets the drawer serve
-- a cached/offline copy when pokemontcg.io / TCGdex / PriceCharting are slow or down (GR7).
CREATE TABLE IF NOT EXISTS set_cards (
  game TEXT NOT NULL,
  lang TEXT NOT NULL,
  set_code TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT,
  http_status INTEGER,
  card_count INTEGER,
  stale INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  PRIMARY KEY (game, lang, set_code)
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

-- ===================== PRE-GRADE REPORTS (card-grader persistence) =====================
-- Saved output of card-grader.html: measured centering, per-pillar observations, the AI vision
-- pass, per-company grade PREDICTIONS and the submit-vs-sell economics behind them, plus the
-- scan/microscope shots that justify it all. Golden Rule 4 boundary: a report stores PREDICTIONS
-- — the ACTUAL grade lives only on grading_submissions.result_grade. The join
-- (grading_submissions.pregrade_id, migratePregrade below) displays both side by side; nothing
-- ever copies a predicted grade into a result, or a result back into a report.
CREATE TABLE IF NOT EXISTS pregrade_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- identity (same scheme as watchlist / grading_submissions)
  game TEXT NOT NULL DEFAULT 'pokemon', identity_key TEXT, name TEXT NOT NULL,
  set_name TEXT, number TEXT, rarity TEXT, finish TEXT, language TEXT NOT NULL DEFAULT 'EN',
  -- JSON blobs, stored as the grader page computed them (its schema, not ours)
  centering TEXT, pillars TEXT, granular TEXT, defects TEXT,
  ai_meta TEXT, predictions TEXT, economics TEXT, config_as_of TEXT,
  status TEXT NOT NULL DEFAULT 'saved',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per shot. Bytes live content-addressed by sha256 in data/pregrade-images/
-- (lib/pregrade-store.mjs); this table holds the per-shot metadata + the sha that finds them.
-- UNIQUE(report_id, shot_id) is what makes the image POST an upsert: re-shooting a slot
-- re-points the row instead of accreting duplicates.
CREATE TABLE IF NOT EXISTS pregrade_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES pregrade_reports(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL, sha256 TEXT NOT NULL, ext TEXT NOT NULL,
  width INTEGER, height INTEGER, dpi INTEGER, kind TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(report_id, shot_id)
);
CREATE INDEX IF NOT EXISTS idx_pregrade_images_report ON pregrade_images(report_id);

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

-- Per-location stock placements for a sealed item (one item -> many locations). The item is a
-- single product/SKU; its physical units may be split across storage spots, each with its own
-- quantity. sealed_items.quantity is the cached SUM of these rows and sealed_items.location the
-- primary (first) located spot — both kept in sync by lib/sealed.mjs on every placement write, so
-- all the existing SUM(quantity)/location readers keep working. location NULL = "unassigned".
CREATE TABLE IF NOT EXISTS sealed_placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES sealed_items(id) ON DELETE CASCADE,
  location TEXT,                                 -- storage box/shelf; NULL = unassigned
  quantity INTEGER NOT NULL DEFAULT 1,
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

-- Per-UPC market value (the seller's model: market value is the same for every item of a barcode,
-- independent of what each was bought for). One row per UPC; item cards derive their unit value from
-- here (a per-item value_manual override wins). Refreshed once per UPC (not once per item).
CREATE TABLE IF NOT EXISTS sealed_upc_prices (
  upc TEXT PRIMARY KEY,                          -- normalized barcode digits
  value_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'AUD',          -- eBay AU values are AUD; PriceCharting fallback is USD
  source TEXT,                                   -- 'ebay'|'pricecharting'
  sample_size INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Per-UPC value history (feeds the shared sparkline for every item of that UPC).
CREATE TABLE IF NOT EXISTS sealed_upc_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upc TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  value_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'AUD',
  source TEXT NOT NULL,                          -- 'ebay'|'pricecharting'
  sample_size INTEGER,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_supcval_upc ON sealed_upc_valuations(upc, ts);

-- Storage-location records for the sealed inventory: freeform info + user-uploaded photos per spot.
-- Locations themselves live as free-text strings on sealed_placements/sealed_items; this table adds an
-- OPTIONAL metadata record (keyed by name, case-insensitive) so a location can carry notes, a sort
-- order, and photos. The Locations page merges these records with in-use placement location strings.
CREATE TABLE IF NOT EXISTS sealed_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sealed_loc_name ON sealed_locations(name COLLATE NOCASE);

-- Photos the owner takes + uploads for a location (NOT external links). Stored as a downscaled data
-- URL in-DB (client-side canvas resize keeps each well under a MB) so they travel with the DB backup
-- and need no disk/static-file plumbing. thumb is a smaller data URL for list cards.
CREATE TABLE IF NOT EXISTS sealed_location_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES sealed_locations(id) ON DELETE CASCADE,
  caption TEXT,
  mime TEXT,
  thumb TEXT,                                   -- small data URL (~256px) for list cards
  data TEXT NOT NULL,                           -- full downscaled data URL (~1400px)
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sealed_locphoto ON sealed_location_photos(location_id, sort_order);

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
CREATE INDEX IF NOT EXISTS idx_splace_item   ON sealed_placements(item_id);
CREATE INDEX IF NOT EXISTS idx_splace_loc    ON sealed_placements(location);

-- ===================== EBAY LISTINGS (Sell Inventory API pipeline) =====================
-- The tool creates listings via the Sell Inventory API (createOrReplaceInventoryItem → createOffer
-- → publishOffer). SKU is the join key across local stock ↔ eBay (↔ future Shopify). These three
-- tables are the local mirror + audit + image-hosting state. MONEY IS INTEGER CENTS (Golden Rule 3).
-- Served by lib/listings.mjs at /api/listings. See AGENTS.md.

-- Local mirror of one eBay offer/listing we created (or reconciled). One row per SKU per marketplace.
CREATE TABLE IF NOT EXISTS ebay_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,                              -- inventory_items.sku (the Inventory API SKU)
  marketplace TEXT NOT NULL DEFAULT 'EBAY_AU',
  offer_id TEXT,                                  -- Sell Inventory API offerId
  listing_id TEXT,                                -- eBay ItemID (from publishOffer)
  item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  game TEXT,
  category_id TEXT,
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'AUD',
  available_qty INTEGER,
  sold_qty INTEGER NOT NULL DEFAULT 0,
  listing_status TEXT,                            -- ACTIVE|OUT_OF_STOCK|ENDED|EBAY_ENDED|UNPUBLISHED
  best_offer_enabled INTEGER NOT NULL DEFAULT 0,
  auto_accept_cents INTEGER,
  auto_decline_cents INTEGER,
  listing_url TEXT,
  last_synced_at TEXT,
  raw TEXT,                                       -- JSON of the last offer/listing payload
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ebay_listing_sku ON ebay_listings(sku, marketplace);
CREATE INDEX IF NOT EXISTS idx_ebay_listing_item ON ebay_listings(item_id);
CREATE INDEX IF NOT EXISTS idx_ebay_listing_status ON ebay_listings(listing_status);

-- Everything the SELLER has on eBay, as eBay reports it — including the listings made by hand in
-- Seller Hub, which the Sell Inventory API cannot see at all (eBay KB 5210) and which therefore never
-- appear in ebay_listings. Keyed on the eBay ItemID because that is the only identifier eBay
-- guarantees: a Trading listing's Custom label (SKU) is optional, and eBay allows the same one on
-- several listings unless InventoryTrackingMethod=SKU is set. Populated by the GetMyeBaySelling
-- import; item_id is filled in opportunistically when a Custom label matches a stock row.
CREATE TABLE IF NOT EXISTS ebay_seller_listings (
  listing_id TEXT PRIMARY KEY,                    -- eBay ItemID
  sku TEXT,                                       -- the seller's "Custom label"; may be null/duplicated
  title TEXT,
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'AUD',
  quantity INTEGER,                               -- eBay's Item.Quantity = AVAILABLE + SOLD, a total
  available_qty INTEGER,                          -- what is actually buyable, and what a revise sends
  sold_qty INTEGER NOT NULL DEFAULT 0,
  listing_type TEXT,                              -- only FixedPriceItem can be revised by RIS
  state TEXT,                                     -- 'active'|'sold'|'unsold'|'ended'
  identity_key TEXT,                              -- the card, read out of the title (best effort)
  listing_url TEXT,
  created_via TEXT,                               -- 'tool' when we published it, else 'manual'
  image_url TEXT,                                 -- the listing's FIRST picture, as eBay hosts it
  image_checked_at TEXT,                          -- set once GetItem answered definitively (image or none)
  item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_esl_sku ON ebay_seller_listings(sku);
CREATE INDEX IF NOT EXISTS idx_esl_state ON ebay_seller_listings(state);
CREATE INDEX IF NOT EXISTS idx_esl_item ON ebay_seller_listings(item_id);

-- Per-push audit / state machine (the per-item outcome record the CSV path never had).
CREATE TABLE IF NOT EXISTS listing_pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  sku TEXT,
  action TEXT NOT NULL,                           -- 'create'|'revise'|'withdraw'|'preview'|'relist'|'adopt'
  offer_id TEXT,
  listing_id TEXT,
  status TEXT NOT NULL,                           -- 'ok'|'error'|'skipped'
  error TEXT,
  request TEXT,                                   -- JSON (scrubbed) of what we sent
  response TEXT,                                  -- JSON of eBay's reply (ids/errors)
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listing_push_item ON listing_pushes(item_id, ts);
CREATE INDEX IF NOT EXISTS idx_listing_push_sku  ON listing_pushes(sku, ts);

-- eBay-hosted (EPS) images per stock item, built by the media pipeline (download CDN art / photos →
-- Media API createImageFromFile → EPS URL). item_id NULL = the shared generic "follow us" trailing
-- image reused across every listing. Lazily re-uploaded when expires_at passes / eBay 404s.
CREATE TABLE IF NOT EXISTS listing_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                             -- 'card'|'front'|'back'|'blemish'|'slab'|'generic'
  source_url TEXT,                               -- CDN url the bytes came from (card art)
  local_path TEXT,                               -- disk path (owner photo / generic image)
  eps_url TEXT,                                   -- eBay-hosted URL used in the offer
  expires_at TEXT,                               -- EPS expiry (unused images purge after ~30 days)
  sort_order INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listing_img_item ON listing_images(item_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_listing_img_generic ON listing_images(kind) WHERE item_id IS NULL;

-- When a cancellation is accepted, eBay AUTO-RELISTS a single-quantity fixed-price listing unless the
-- seller unticked "Relist item?" in the cancel flow. The relist mints a NEW ItemID and carries the
-- Custom Label across UNCHANGED — so the account ends up holding two listings with the same SKU, the
-- old one ended and the new one active, and nothing repoints inventory_items.ebay_listing_id at it.
--
-- One row per stock item we are WATCHING for that relist. A table rather than columns on
-- inventory_items because this is a bounded job queue with retry state and a give-up point, it has to
-- cover sealed_items too, and "eBay never relisted this one" is a state a human has to be able to see.
-- Rows are only ever created by a confirmed cancellation — see reverseStockForOrder in
-- lib/postsale.mjs — which is what keeps it free of false positives. Served by lib/relist-watch.mjs.
CREATE TABLE IF NOT EXISTS relist_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                             -- 'inventory'|'sealed'
  item_id INTEGER NOT NULL,                       -- inventory_items.id / sealed_items.id
  sku TEXT,                                       -- the Custom Label, checked against the relist
  old_listing_id TEXT NOT NULL,                   -- the ItemID that ended when the sale went through
  order_id TEXT,                                  -- the cancelled eBay order that caused it (audit)
  state TEXT NOT NULL DEFAULT 'watching',         -- watching|adopted|not_relisted|mismatch
  attempts INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT,                             -- backoff cursor; NULL once terminal
  last_error TEXT,
  new_listing_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_relist_watch ON relist_watch(kind, item_id, old_listing_id);
CREATE INDEX IF NOT EXISTS idx_relist_watch_due ON relist_watch(state, next_check_at);

-- ---------------------------------------------------------------------------------------------
-- PURCHASING — stock ordered but not yet held (lib/purchasing.mjs, /api/purchasing, purchasing.html)
--
-- The inbound counterpart to orders.html, which is the OUTBOUND eBay fulfilment queue. Nothing here
-- is stock: these tables record an intent to buy and what it cost. Stock only exists once a receive
-- COMMITS, at which point the units are written into sealed_items / inventory_items and the line is
-- stamped with what it produced. That stamp is the idempotency guard — a replayed commit is a no-op.
--
-- These tables live in tracker.db rather than a store of their own (cf. lib/postsale-db.mjs) because
-- the receive writes purchase_lines AND sealed_items/sealed_placements/inventory_items in ONE
-- transaction, and SQLite cannot span two database files. Same DB is a correctness requirement.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,                       -- human handle, 'PO-000042'; monotonic, never reused
  supplier TEXT,                                  -- FREE TEXT, autocompleted from DISTINCT past values the
                                                  -- way /api/sealed/locations does. There is no suppliers
                                                  -- table on purpose: a registry the owner has to maintain
                                                  -- is a second thing to keep true, for no gain here.
  supplier_ref TEXT,                              -- their invoice / order number
  status TEXT NOT NULL DEFAULT 'draft',           -- draft|preorder|ordered|in_transit|arrived|received|cancelled

  -- GR3: the currency the ORDER WAS PLACED IN. Every *_cents on this order and on its lines is in
  -- THIS currency, stored exactly as sourced. Nothing is converted at storage — AUD is a render-time
  -- concern (TCG.toAUD), because a rate baked into a stored number stops being a faithful record.
  currency TEXT NOT NULL DEFAULT 'AUD',

  -- Order-level charges, in the order currency. Allocated down into each received unit's acq_fees_cents on
  -- commit, so a box sitting on a shelf carries its true landed cost into the existing margin maths.
  shipping_cents INTEGER, tax_cents INTEGER, other_fees_cents INTEGER, discount_cents INTEGER,

  -- What the bank/PayPal ACTUALLY took, in AUD cents. NULL until the owner enters it, and while it is
  -- NULL every AUD figure shown for this order is a live-FX ESTIMATE and is labelled as one (GR4).
  -- Once set it is the permanent cost basis and live FX stops applying to this order: a purchase is a
  -- settled transaction, not a market quote, so its cost must not drift as ECB rates move.
  -- FX in two layers, because the rule is "live rate, overridden once settled".
  --   fx_to_aud          the live ECB rate at order time (/api/fx). An ESTIMATE, and labelled one.
  --   settled_aud_cents  what the bank actually charged. NULL = not settled.
  --   settled_fx_to_aud  the rate that figure IMPLIES, computed server-side on the settle write and
  --                      STORED rather than derived on read — the order total can still be edited
  --                      afterwards, and a derived rate would silently rewrite a cost basis that is
  --                      already sitting on stock rows.
  -- effectiveFx(order) = settled_fx_to_aud ?? fx_to_aud, and everything AUD-facing goes through it.
  -- Both nullable: FX being down must never stop an order being typed (GR7); the page then shows the
  -- native amount flagged approximate rather than a silently wrong AUD number (GR3).
  fx_to_aud REAL,
  fx_captured_at TEXT,
  settled_aud_cents INTEGER,                      -- ALWAYS AUD — that is the point of it, so no sibling column
  settled_fx_to_aud REAL,
  settled_at TEXT,
  settled_source TEXT,                            -- 'bank'|'paypal'|'card'|'manual' — provenance, GR4

  ordered_at TEXT,
  release_date TEXT,                              -- preorder street date — what makes a preorder a preorder
  eta_at TEXT, carrier TEXT, tracking TEXT,
  arrived_at TEXT, received_at TEXT, closed_at TEXT, cancelled_at TEXT,
  default_location TEXT,                          -- destination spot applied to every line at receive,
                                                  -- overridable per line. Most of a delivery lands together.
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,

  line_kind TEXT NOT NULL DEFAULT 'unit',         -- 'unit'    N identical units -> one stock row
                                                  -- 'lot'     lump price, contents unknown until sorted
                                                  -- 'grading' cards already owned; the FEE is the cost

  -- RESTOCK LINK. Many orders are simply more of a SKU already held, so a line can bind to an existing
  -- stock row instead of describing a new product. Deliberately NOT a foreign key: the target is one of
  -- TWO tables, and SQLite has no polymorphic FK. The row is re-verified at receive time and the line
  -- falls back to the new-product path with a warning if it has since been deleted — failing shut here
  -- would strand a delivery that is physically on the floor.
  -- link_sku and link_snapshot are what make a DELETED target survivable. Resolution at receive is:
  -- (1) the row exists and its sku still equals link_sku -> merge into it; (2) it is gone -> identity-
  -- match the snapshot against stock on hand and merge if EXACTLY one hits; (3) nothing matches ->
  -- create from the snapshot. The preview says which of the three happened, in amber for 2 and 3, so
  -- the operator can re-pick before committing. A dead link must never block goods physically on the
  -- floor from being put away (GR7). link_sku also guards a restored-from-backup id collision.
  link_kind TEXT,                                 -- 'sealed'|'inventory'|NULL (NULL = a new product)
  link_item_id INTEGER,
  link_sku TEXT,                                  -- the sku AT LINK TIME
  link_snapshot TEXT,                             -- JSON identity at link time; the fallback + rebuild source

  -- New-product descriptor. Ignored when link_item_id resolves to a live row.
  target TEXT NOT NULL DEFAULT 'sealed',          -- 'sealed'|'inventory' — which table receiving creates in
  game TEXT, product_type TEXT, name TEXT NOT NULL, set_name TEXT,
  language TEXT NOT NULL DEFAULT 'EN', upc TEXT, condition TEXT,
  variant TEXT, number TEXT, identity_key TEXT,

  qty_ordered INTEGER NOT NULL DEFAULT 1,
  unit_cost_cents INTEGER,                        -- 'unit'/'grading' lines, in the ORDER's currency
  lot_total_cents INTEGER,                        -- 'lot' lines: the lump price for the whole lot

  -- Receiving. qty_received NULL means "not counted yet" and BLOCKS the order closing — the whole point
  -- of the validation pass is that nothing moves from ordered to in-stock without someone counting it.
  qty_received INTEGER,
  submission_ids TEXT,                            -- 'grading' lines ONLY: JSON array of the
                                                  -- grading_submissions this fee is for, one per card
                                                  -- (read by parseSubmissionIds). Deliberately NOT
                                                  -- identity_key, which is a PRODUCT identity here.
  lot_units INTEGER,                              -- 'lot' lines ONLY: how many items actually came out of
                                                  -- the lot. The lump price divides evenly across THIS,
                                                  -- not across qty_received (a lot is one delivered thing
                                                  -- containing many).
  discrepancy TEXT,                               -- NULL|'short'|'over'|'damaged'|'not_shipped'|'wrong_item'
  discrepancy_note TEXT,
  -- alloc_fees_cents is the EXACT share of the order-level pot this line carried, in ORDER currency.
  -- Stored rather than recomputed, because it is the audit answer to "why does this box have $4.12 of
  -- freight on it" and because the order's charges stay editable afterwards. Over the received lines
  -- these sum to the pot exactly — that is the invariant the allocator's tests assert.
  alloc_fees_cents INTEGER,
  received_kind TEXT,                             -- 'sealed'|'inventory'|'none' ('none' = a grading line,
                                                  -- which buys a service and creates no stock)
  -- The stock row the units landed in, and the idempotency guard. A 'lot' line can produce TWO rows
  -- when its lump price does not divide evenly, and this names only the FIRST — anything that needs
  -- the whole lot must group on sealed_items/inventory_items.po_line_id instead.
  received_item_id INTEGER,
  received_sku TEXT,                              -- denormalised, so the trail survives a deleted stock row
  received_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Where a line's units are going, captured DURING receiving. Same shape as sealed_placements on
-- purpose: the receive hands these straight to the sealed placement writer, so one line's units can
-- be split across several spots (4 on a shelf, 2 in a tub) without a second location model existing.
CREATE TABLE IF NOT EXISTS purchase_line_placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id INTEGER NOT NULL REFERENCES purchase_lines(id) ON DELETE CASCADE,
  location TEXT,                                  -- NULL = unassigned, same convention as sealed_placements
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Individual payments against an order: a deposit now, the balance on despatch, instalments.
-- There is deliberately NO paid/unpaid column on purchase_orders — the status is DERIVED from the sum
-- of these rows against the order total. A stored status is a second source of truth, and it drifts
-- the first time a payment is edited or deleted.
CREATE TABLE IF NOT EXISTS purchase_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  amount_cents INTEGER NOT NULL,                  -- SIGNED — a refund is negative, so a running balance
                                                  -- never has to branch on a payment "kind" and get it
                                                  -- wrong the first time a new kind appears
  currency TEXT NOT NULL,                         -- in the currency below — NOT necessarily the order's:
                                                  -- a deposit can settle in AUD on a USD order (GR3)
  fx_to_order REAL,                               -- THIS payment's currency -> the ORDER's, captured when
                                                  -- the payment was recorded. Folds the balance; it never
                                                  -- rewrites amount_cents. NULL when the two match.
  aud_cents INTEGER,                              -- what the bank actually took, when known — the input to
                                                  -- settling the order from its payments
  method TEXT, reference TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- THE RECEIVING EVENT, and the real idempotency guard. UNIQUE(order_id) is not tidiness: the commit's
-- FIRST statement inside the transaction is the INSERT here, so a second receive — a double tap, a
-- retried fetch, two tabs — hits the constraint and rolls the whole transaction back before one unit
-- of stock has moved. Cheap, total, and it needs no re-derivation of what already happened.
--
-- ONE receipt per order is the schema saying the owner's rule out loud: an order arrives once. A
-- shortfall is a reason code on a line, not a second open receipt. Goods that genuinely turn up later
-- are a new order — there is no partial-receipt engine here to reopen.
CREATE TABLE IF NOT EXISTS purchase_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES purchase_orders(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  alloc_basis TEXT NOT NULL DEFAULT 'value',      -- 'value'|'qty' — which rule spread the pot, recorded
                                                  -- so "why does this box carry $4.12 of freight" is answerable
  alloc_total_cents INTEGER,                      -- the pot, in the ORDER's currency
  fx_used REAL,                                   -- the rate the stock rows were written at. Never overwritten.
  line_count INTEGER, unit_count INTEGER,
  preview TEXT,                                   -- JSON of the plan the operator actually approved
  result TEXT,                                    -- JSON of what the commit did, incl. pre-blend cost basis
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_po_status    ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_supplier  ON purchase_orders(supplier);
CREATE INDEX IF NOT EXISTS idx_pline_order  ON purchase_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_pline_link   ON purchase_lines(link_kind, link_item_id);
CREATE INDEX IF NOT EXISTS idx_pplace_line  ON purchase_line_placements(line_id);
CREATE INDEX IF NOT EXISTS idx_ppay_order   ON purchase_payments(order_id);
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
  // JSON blob of the facts a card LOOKUP found (hp, types, dex numbers, set series/release, …). These
  // drive eBay item specifics and the description table. Persisted because createOrReplaceInventoryItem
  // is a full replace: a later republish that carries no overrides (revise-price, a repricer apply)
  // would otherwise strip every rich aspect back off a live listing.
  addColumnIfMissing(db, 'inventory_items', 'card_facts', 'TEXT');
  // The printed set code, PROMOTED OUT OF card_facts into a column of its own.
  //
  // It has lived inside card_facts since it existed, and for Shopify's identity metaobject that was
  // fine — mergeCardFacts splices it back onto the row on the way past. It stops being fine the moment
  // anything wants to JOIN on it: the set-identity metaobject groups every product of one set, and a
  // JSON blob that is "rewritten wholesale from a card lookup" (two lines above) is neither indexable
  // nor stable enough to key a relationship on.
  //
  // It also makes the graded and sealed sides symmetric — sealed_items.set_code has always been a real
  // column, which is why a booster could be filed by set and a slab could not.
  addColumnIfMissing(db, 'inventory_items', 'set_code', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_inv_set_code ON inventory_items(set_code);');
  // Backfill from the blob it used to live in. Idempotent (only fills a NULL), and json_valid guards
  // the rows where card_facts is absent or was written by something that is not this pipeline.
  db.exec(`UPDATE inventory_items
              SET set_code = json_extract(card_facts, '$.set_code')
            WHERE set_code IS NULL
              AND card_facts IS NOT NULL
              AND json_valid(card_facts)
              AND json_extract(card_facts, '$.set_code') IS NOT NULL`);
  // The owner's PER-ITEM storefront department pick: a JSON array of eBay store category paths, at
  // most 2 (eBay's cap). A listing DECISION, not a card fact, so it deliberately does NOT ride in
  // card_facts — that blob is rewritten wholesale from a card lookup, and two copies of one card can
  // legitimately sit in different departments. Persisted because updateOffer is a COMPLETE REPLACE:
  // a republish that omits storeCategoryNames drops the listing back into eBay's "Other".
  addColumnIfMissing(db, 'inventory_items', 'store_categories', 'TEXT');
  // The card a mirrored eBay listing is FOR, read out of its title. Lets the uploader warn "this is
  // already listed" before eBay refuses the duplicate — a hand-made listing is not in inventory_items,
  // so an identity check against stock alone cannot see it. Added by migration for DBs created before
  // the column existed; new DBs get it from the CREATE TABLE above.
  addColumnIfMissing(db, 'ebay_seller_listings', 'identity_key', 'TEXT');
  // See the CREATE TABLE note: `quantity` is eBay's total (available + sold). available_qty is the
  // buyable figure, and the ONLY one safe to echo back to ReviseInventoryStatus.
  addColumnIfMissing(db, 'ebay_seller_listings', 'available_qty', 'INTEGER');
  addColumnIfMissing(db, 'ebay_seller_listings', 'listing_type', 'TEXT');
  // The listing's first picture, so the listings page shows the card rather than a wall of titles.
  // Filled for free by the import when GetMyeBaySelling carries PictureDetails, and otherwise by a
  // capped lazy GetItem backfill — image_checked_at is what stops that asking again about a listing
  // eBay says has no picture (same cache shape as order_line_items, lib/postsale-db.mjs).
  addColumnIfMissing(db, 'ebay_seller_listings', 'image_url', 'TEXT');
  addColumnIfMissing(db, 'ebay_seller_listings', 'image_checked_at', 'TEXT');
  // Listing-image compositor. `compose_hash` is the content key: sha256 over the source bytes, the
  // resolved layout, ASSET_VERSION, the variant and the rendered rail text. It replaces source_url
  // as the dedupe key once compositing is on, because the hosted bytes are no longer a function of
  // the source URL alone — a Japanese and an English printing of one card share art but not rails.
  // `compose_version` ('<ASSET_VERSION>/<variant>/<artDigest>') is the AUDIT token: it answers
  // "which live listings are still on the old art?", which a hash alone cannot. NULL on every
  // existing row, which reads as "not composed" — exactly right.
  addColumnIfMissing(db, 'listing_images', 'compose_hash', 'TEXT');
  addColumnIfMissing(db, 'listing_images', 'compose_version', 'TEXT');
  // --- listing supersession (a relist mints a NEW ItemID) ---
  // ebay_listings is UNIQUE(sku, marketplace), so any republish overwrites the row in place and the old
  // ItemID survives nowhere. The chain of "which listing was this card, and when" is therefore recorded
  // in listing_pushes (action 'relist' when we republished, 'adopt' when eBay auto-relisted), which
  // survives the upsert. Deliberately NOT a pointer column on this row: the same row can be both the
  // replacement and the replaced depending on which path touched it last, so one timestamp there would
  // answer two opposite questions.
  //
  // The Sell-API offer this row USED to own. Moved aside rather than left in offer_id, because
  // `offer_id IS NOT NULL` is exactly what puts a row inside reconcileListings' jurisdiction — and once
  // eBay has auto-relisted on the Trading side that offer is dead, so the reconciler's conclusion
  // ("the listing ended") is right about the offer and wrong about the card. See lib/relist-watch.mjs.
  addColumnIfMissing(db, 'ebay_listings', 'retired_offer_id', 'TEXT');
  // Deliberately NOT in the DDL template above: that string is exec'd before these columns exist.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_img_compose ON listing_images(compose_hash);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_batch ON inventory_items(batch_id);`);
  // One row per (card × printing) for RAW bulk items only — mirrors watchlist
  // UNIQUE(game, identity_key, variant). Excludes graded slabs (distinct physical
  // items: a raw Charizard and a TAG 10 Charizard must both persist) and non-bulk
  // rows (batch_id NULL — the graded/manual inventory may legitimately repeat a card).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_bulk_identity
    ON inventory_items(game, identity_key, variant)
    WHERE batch_id IS NOT NULL AND grading_company IS NULL;`);
}

// Additive migrations for the sealed-inventory tables. Safe + idempotent every boot.
function migrateSealed(db) {
  // Multi-location placements shipped after sealed_items already had rows. Seed one placement per
  // existing item that has none yet, mirroring its scalar (location, quantity) so the "quantity ==
  // SUM(placements)" invariant holds for every item from here on. WHERE NOT EXISTS makes it a no-op
  // once seeded; new items get their placements written at insert time by lib/sealed.mjs.
  db.exec(`INSERT INTO sealed_placements (item_id, location, quantity)
           SELECT si.id, si.location, COALESCE(si.quantity, 1)
             FROM sealed_items si
            WHERE NOT EXISTS (SELECT 1 FROM sealed_placements sp WHERE sp.item_id = si.id);`);
}


// Sealed LISTING tables. Parallel to ebay_listings / listing_pushes / listing_images rather than
// reusing them, because all four are `item_id INTEGER REFERENCES inventory_items(id)` with
// PRAGMA foreign_keys ON, and the two id sequences are INDEPENDENT: a sealed_items.id that happens
// to exist in inventory_items would PASS the FK check and silently attach a sealed listing, its
// audit trail and its photos to an unrelated graded card. SQLite cannot drop an FK additively, so a
// `kind` discriminator is not available here the way it was for relist_watch.
//
// The pool is the listing unit, not the row. Several acquisitions of one product share a pool_sku and
// therefore ONE eBay offer at quantity N, which is what stops a restock publishing a competing
// listing against stock that is really one pile.
function migrateSealedListing(db) {
  addColumnIfMissing(db, 'sealed_items', 'pool_sku', 'TEXT');       // the eBay custom label; NOT unique
  addColumnIfMissing(db, 'sealed_items', 'set_code', 'TEXT');       // segment 4 of the SKU; no column existed
  addColumnIfMissing(db, 'sealed_items', 'release_date', 'TEXT');   // pre-order headroom, unused for now
  addColumnIfMissing(db, 'sealed_items', 'in_hand', 'INTEGER DEFAULT 1');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sealed_pools (
      pool_sku        TEXT PRIMARY KEY,
      game            TEXT NOT NULL DEFAULT 'pokemon',
      language        TEXT NOT NULL DEFAULT 'EN',
      set_code        TEXT,
      set_name        TEXT,
      product_type    TEXT NOT NULL,
      name            TEXT,                            -- the product's own name, e.g. Surging Sparks Booster Box
      variant         TEXT,
      condition       TEXT NOT NULL DEFAULT 'sealed',
      factory_sealed  INTEGER NOT NULL DEFAULT 1,
      pack_count      INTEGER,
      -- Complete-replace fields. updateOffer and createOrReplaceInventoryItem REPLACE rather than
      -- patch, so anything the owner hand-edited has to be re-sent on every revise or it reverts.
      title_override    TEXT,
      desc_override     TEXT,
      store_categories  TEXT,
      postage_band_id   TEXT,
      price_cents       INTEGER,
      ebay_listing_id   TEXT,
      ebay_offer_id     TEXT,
      channel_status    TEXT,
      published_at      TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sealed_pool_images (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_sku   TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      kind       TEXT NOT NULL DEFAULT 'owner',   -- 'owner' | 'catalog'
      local_path TEXT,
      source_url TEXT,
      ebay_url   TEXT,
      sha256     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sealed_listing_pushes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_sku     TEXT NOT NULL,
      action       TEXT NOT NULL,                 -- 'publish' | 'revise' | 'preview' | 'withdraw'
      status       TEXT NOT NULL,                 -- 'ok' | 'error' | 'skipped'
      offer_id     TEXT,
      listing_id   TEXT,
      price_cents  INTEGER,
      quantity     INTEGER,
      request      TEXT,
      response     TEXT,
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sealed_pool          ON sealed_items(pool_sku);
    CREATE INDEX IF NOT EXISTS idx_sealed_pool_images   ON sealed_pool_images(pool_sku, position);
    CREATE INDEX IF NOT EXISTS idx_sealed_pushes        ON sealed_listing_pushes(pool_sku, created_at);
  `);
  // sealed_pools may already exist from an earlier run of this migration, and CREATE TABLE IF NOT
  // EXISTS will not add a column to it, so anything added after the first ship needs its own guard.
  addColumnIfMissing(db, 'sealed_pools', 'name', 'TEXT');
  // sealed_pool_images shipped without expires_at, which is the column that makes EPS caching work:
  // without it there is no way to ask whether a hosted URL is still alive, so every revise would
  // re-upload every image. listing_images has always had it. The compose_* pair is added now, while
  // the table is empty, rather than as a migration over rows that are already live on eBay.
  addColumnIfMissing(db, 'sealed_pool_images', 'expires_at', 'TEXT');
  addColumnIfMissing(db, 'sealed_pool_images', 'compose_hash', 'TEXT');
  addColumnIfMissing(db, 'sealed_pool_images', 'compose_version', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sealed_img_sha     ON sealed_pool_images(sha256);
           CREATE INDEX IF NOT EXISTS idx_sealed_img_compose ON sealed_pool_images(compose_hash);`);
}

// Pre-grade link on grading_submissions: which saved pre-grade report a submission grew out of.
// Golden Rule 4 lives in this join: pregrade_reports stores PREDICTIONS, the actual grade lives
// only on grading_submissions.result_grade, and the UI displays both side by side through this
// column — nothing copies one into the other. ON DELETE SET NULL: a deleted report must not take
// a real submission (or its slab history) down with it.
function migratePregrade(db) {
  addColumnIfMissing(db, 'grading_submissions', 'pregrade_id', 'INTEGER REFERENCES pregrade_reports(id) ON DELETE SET NULL');
  // THE FREEZE. A linked report's prediction is the only before-the-fact record that exists; the
  // slab that comes back weeks later is compared against it. Reopening that report in the grader
  // re-pulls today's comps and re-runs the AI, and saving re-writes the prediction columns — so
  // without a lock the calibration data quietly becomes a record of what we thought AFTER the
  // grade was known. Nothing in the row would look wrong afterwards, which is what makes it
  // worth a column. locked_at is stamped from the SUBMISSION's created_at (the freeze began when
  // the card was sent, not when the app got round to noticing), frozen_dirty_at is the confession
  // that an override actually rewrote a frozen column, and unlock_log is the append-only record
  // of every override. NULL everywhere reads as "never locked, never overridden".
  addColumnIfMissing(db, 'pregrade_reports', 'locked_at', 'TEXT');
  addColumnIfMissing(db, 'pregrade_reports', 'frozen_dirty_at', 'TEXT');
  addColumnIfMissing(db, 'pregrade_reports', 'unlock_log', 'TEXT');
  // Backfill: a report linked before this column existed is already frozen in fact — its card is
  // out at the grader — so stamp it from the link instead of leaving it editable until someone
  // happens to PATCH. Only NULL locked_at is touched, and the stamp is idempotent: re-running it
  // on a report that was deliberately unlocked simply re-freezes it, which is the same one-shot
  // rule the PATCH route applies (an unlock covers one request, never a standing exemption).
  db.exec(`UPDATE pregrade_reports SET locked_at = (
             SELECT COALESCE(MIN(s.created_at), datetime('now'))
               FROM grading_submissions s WHERE s.pregrade_id = pregrade_reports.id)
            WHERE locked_at IS NULL
              AND EXISTS (SELECT 1 FROM grading_submissions s WHERE s.pregrade_id = pregrade_reports.id)`);
}

// ===================== SHOPIFY CHANNEL + CROSS-CHANNEL SYNC =====================
// See docs/SHOPIFY_CHANNEL_PLAN.md. Three tables, and the split between them is the whole design:
//
//   ebay_listings     — eBay's answer about a SKU.       Written by the eBay write-back + reconciler.
//   shopify_listings  — Shopify's answer about a SKU.    Written by the Shopify write-back + reconciler.
//   channel_intent    — OUR intent for a SKU on a channel. Written by the operator and the tool.
//
// Folding intent into the mirrors is the mistake this avoids. The reconciler rewrites a mirror on a
// 30-minute timer; the operator edits intent by hand. One table means those two UPDATEs race on one
// row, and the failure mode is a reconcile pass quietly resetting a mode='never' an operator set
// thirty seconds earlier. Two writers, two tables.
//
// Shopify also needs SEVEN identifiers per sibling (product, variant, inventory item, location,
// handle, publication state, identity metaobject), which is why it gets a shaped table of its own
// rather than three generic columns holding JSON.
// Additive migrations for the purchasing tables. Safe + idempotent every boot.
//
// The tables themselves are in the DDL template above, so a fresh DB gets them from CREATE TABLE IF
// NOT EXISTS. This function exists for the deployed box, whose tracker.db predates them: exec'ing
// the CREATE statements again is a no-op there, and any column added AFTER this first shipped has
// to come through addColumnIfMissing, because CREATE TABLE IF NOT EXISTS will not alter a table
// that already exists — the same trap migrateSealedListing documents for sealed_pools.
function migratePurchasing(db) {
  // Columns that shipped after the first cut of these tables, so an early DB needs them ADDED rather
  // than recreated — CREATE TABLE IF NOT EXISTS will not alter a table that already exists.
  addColumnIfMissing(db, 'purchase_orders', 'default_location', 'TEXT');
  // The grading_submissions a 'grading' line is paying for, as a JSON array. Its own column because
  // these ids briefly rode in identity_key, which is a PRODUCT identity everywhere else — a real key
  // parsed to NaN and the fee was applied to nothing, silently.
  addColumnIfMissing(db, 'purchase_lines', 'submission_ids', 'TEXT');
  addColumnIfMissing(db, 'purchase_payments', 'fx_to_order', 'REAL');
  addColumnIfMissing(db, 'purchase_lines', 'lot_units', 'INTEGER');
  addColumnIfMissing(db, 'purchase_orders', 'closed_at', 'TEXT');
  addColumnIfMissing(db, 'purchase_orders', 'cancelled_at', 'TEXT');

  // The reverse index: which purchase a stock row came from. It is also the ONLY route back to what
  // that row actually cost in the currency it was bought in — sealed_items.cost_cents and
  // inventory_items.cost_cents are AUD (sealed.html's dcAud converts before it POSTs, and every
  // existing reader assumes it), so a USD order's native figures survive nowhere but the purchase
  // line this points at, alongside the FX the receive used.
  //
  // No FK, for the reason migrateSealedListing gives about cross-table ids: it must also outlive the
  // order being deleted, because the cost basis is already booked on the stock and deleting the
  // paperwork must not silently rewrite it.
  addColumnIfMissing(db, 'sealed_items', 'po_line_id', 'INTEGER');
  addColumnIfMissing(db, 'inventory_items', 'po_line_id', 'INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sealed_po_line ON sealed_items(po_line_id);
           CREATE INDEX IF NOT EXISTS idx_inv_po_line    ON inventory_items(po_line_id);`);
}

// shopify_listings was built as `sku TEXT PRIMARY KEY`. One install now reaches two stores, so the key
// has to move to (sku, store) — see the CREATE TABLE comment for what a single row per SKU actually
// costs at cutover.
//
// SQLite cannot alter a PRIMARY KEY, so this is a table rebuild in the shape migrateMessageKinds
// already established (lib/postsale-db.mjs): create the new form, copy every row across, drop, rename.
// Guarded on the column so it runs exactly once, and a no-op on a fresh DB, which gets the new shape
// straight from the CREATE TABLE above.
//
// EXISTING ROWS BECOME 'dev'. Nothing has ever published to live from this table — publish.allowLive
// gates that and the M1 gate has not run — so every row present was written by a dev rehearsal. Naming
// them 'dev' is a statement of fact, not a default; a row wrongly labelled 'live' would make the real
// live run skip that card as already published.
function migrateShopifyStore(db) {
  const cols = db.prepare('PRAGMA table_info(shopify_listings)').all().map((c) => c.name);
  if (!cols.length || cols.includes('store')) return;
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE shopify_listings_new (
      sku              TEXT NOT NULL,
      store            TEXT NOT NULL DEFAULT 'dev',
      kind             TEXT NOT NULL DEFAULT 'inventory',
      item_id          INTEGER,
      product_gid      TEXT, variant_gid TEXT, inventory_gid TEXT, location_gid TEXT, identity_gid TEXT,
      identity_handle  TEXT,
      handle           TEXT,
      state            TEXT NOT NULL DEFAULT 'pending',
      published_at     TEXT,
      price_cents      INTEGER,
      currency         TEXT NOT NULL DEFAULT 'AUD',
      available_qty    INTEGER,
      last_synced_at   TEXT, error TEXT, raw TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (sku, store)
    )`);
    db.exec(`INSERT INTO shopify_listings_new
      (sku, store, kind, item_id, product_gid, variant_gid, inventory_gid, location_gid, identity_gid,
       identity_handle, handle, state, published_at, price_cents, currency, available_qty,
       last_synced_at, error, raw, created_at, updated_at)
      SELECT sku, 'dev', kind, item_id, product_gid, variant_gid, inventory_gid, location_gid, identity_gid,
             identity_handle, handle, state, published_at, price_cents, currency, available_qty,
             last_synced_at, error, raw, created_at, updated_at FROM shopify_listings`);
    const moved = db.prepare('SELECT COUNT(*) c FROM shopify_listings_new').get().c;
    db.exec('DROP TABLE shopify_listings');
    db.exec('ALTER TABLE shopify_listings_new RENAME TO shopify_listings');
    db.exec('COMMIT');
    console.log(`[db] shopify_listings rebuilt on (sku, store); ${moved} existing row(s) stamped 'dev'`);
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

// shopify_files, same key change and same reason: a MediaImage gid belongs to one store. Rebuild rather
// than ALTER, because the PRIMARY KEY is what has to move. Existing rows are dev for the same reason
// migrateShopifyStore's are — nothing has ever published to live.
function migrateShopifyFilesStore(db) {
  const cols = db.prepare('PRAGMA table_info(shopify_files)').all().map((c) => c.name);
  if (!cols.length || cols.includes('store')) return;
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE shopify_files_new (
      content_hash  TEXT NOT NULL,
      store         TEXT NOT NULL DEFAULT 'dev',
      file_gid      TEXT, resource_url TEXT,
      status        TEXT NOT NULL DEFAULT 'staged',
      view          TEXT, filename TEXT, width INTEGER, height INTEGER, bytes INTEGER,
      compose_version TEXT, error TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      ready_at      TEXT,
      PRIMARY KEY (content_hash, store)
    )`);
    db.exec(`INSERT INTO shopify_files_new
      (content_hash, store, file_gid, resource_url, status, view, filename, width, height, bytes,
       compose_version, error, created_at, ready_at)
      SELECT content_hash, 'dev', file_gid, resource_url, status, view, filename, width, height, bytes,
             compose_version, error, created_at, ready_at FROM shopify_files`);
    const moved = db.prepare('SELECT COUNT(*) c FROM shopify_files_new').get().c;
    db.exec('DROP TABLE shopify_files');
    db.exec('ALTER TABLE shopify_files_new RENAME TO shopify_files');
    db.exec('COMMIT');
    console.log(`[db] shopify_files rebuilt on (content_hash, store); ${moved} existing row(s) stamped 'dev'`);
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function migrateShopify(db) {
  // Shopify's answer. One row per SKU PER STORE.
  //
  // The original shape was `sku TEXT PRIMARY KEY`, on the stated assumption that "a second Shopify
  // store would be a different install, not a different row". That assumption stopped being true the
  // day storeFor() started reading `?store=` per request (lib/shopify.mjs) and guardLiveStore was
  // written so ONE install could reach both. With a single row per SKU, a live publish UPSERTs over
  // the dev rehearsal's row: excluded.product_gid replaces a dev GID with a live one — or, when the
  // live attempt fails, the COALESCE-preserve logic below actively KEEPS the dev GID alive. Every
  // consumer is then store-blind, so the live run skips cards as "already live" that only dev ever
  // published, and identity.rebuild mixes dev product GIDs into a live store's identities.
  //
  // item_id carries NO foreign key, deliberately, for the reason migrateSealedListing documents: the
  // inventory_items and sealed_items id sequences are INDEPENDENT, so a sealed id that happens to
  // exist in inventory_items would PASS an FK check and silently attach a sealed row's listing to an
  // unrelated graded card. `kind` is the discriminator that makes the pair meaningful.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shopify_listings (
      sku              TEXT NOT NULL,             -- inventory_items.sku / sealed_pools.pool_sku
      store            TEXT NOT NULL DEFAULT 'dev',  -- 'dev'|'live' — resolveShop()'s axis, not a marketplace
      kind             TEXT NOT NULL DEFAULT 'inventory',  -- 'inventory'|'sealed' (mirrors order_line_items.matched_kind)
      item_id          INTEGER,                   -- tracker id within its kind; no FK, see above
      product_gid      TEXT,                      -- gid://shopify/Product/…
      variant_gid      TEXT,                      -- gid://shopify/ProductVariant/…
      inventory_gid    TEXT,                      -- gid://shopify/InventoryItem/… — what qty pushes address
      location_gid     TEXT,                      -- the pinned shipping location the stock sits at
      identity_gid     TEXT,                      -- gid://shopify/Metaobject/… — the bk_card_identity
      handle           TEXT,
      state            TEXT NOT NULL DEFAULT 'pending',   -- pending|live|unpublished|ended|failed
      published_at     TEXT,                      -- set only when publishablePublish SUCCEEDED (§3.3)
      price_cents      INTEGER,                   -- what Shopify currently holds, not what we intend
      currency         TEXT NOT NULL DEFAULT 'AUD',
      available_qty    INTEGER,
      last_synced_at   TEXT,
      error            TEXT,
      raw              TEXT,                      -- JSON of the last productSet response (scrubbed)
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (sku, store)
    );
  `);
  // The card identity this product belongs to, denormalised onto the mirror. addColumnIfMissing rather
  // than a CREATE TABLE edit because the table already exists on the deployed box, and CREATE TABLE IF
  // NOT EXISTS would silently leave it one column short.
  //
  // It is stored rather than derived because identity.rebuild's whole job is "every sibling of this
  // card, in condition order", and deriving the handle would mean re-deriving it for every mirror row
  // in the table on every rebuild — plus re-deriving it from inventory_items columns that may have been
  // edited since the publish, which would silently regroup a product that Shopify still has filed under
  // the old identity. The handle Shopify was actually told is the one that has to be queried.
  //
  // Runs BEFORE migrateShopifyStore so the rebuild's column list is uniform: a DB predating this
  // column still gets it, and the copy below never has to branch on whether it exists.
  addColumnIfMissing(db, 'shopify_listings', 'identity_handle', 'TEXT');
  migrateShopifyStore(db);
  // Every index leads with `store`, because every consumer now filters on it first.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_listing_item ON shopify_listings(store, kind, item_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_listing_state ON shopify_listings(store, state);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_listing_identity ON shopify_listings(store, identity_handle, state);`);

  // Our intent, per SKU per channel. Small on purpose: everything here is a decision somebody made,
  // and nothing here is an observation. A reconciler must never write to this table.
  //
  // price_cents NULL means "derive from inventory_items.target_price_cents" — the base price. A
  // non-null value with price_manual=1 is an override that a republish and a repricer pass must both
  // leave alone. The repricer writes HERE, never to target_price_cents, or the eBay uplift compounds
  // on every run (docs/SHOPIFY_CHANNEL_PLAN.md T6).
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_intent (
      sku            TEXT NOT NULL,
      channel        TEXT NOT NULL,               -- 'shopify'|'ebay'
      kind           TEXT NOT NULL DEFAULT 'inventory',
      item_id        INTEGER,
      mode           TEXT NOT NULL DEFAULT 'auto', -- 'auto'|'manual'|'never'
      publish_after  TEXT,                        -- the delay gate; NULL = as soon as the worker sees it
      price_cents    INTEGER,                     -- NULL = derive from the base price
      price_manual   INTEGER NOT NULL DEFAULT 0,
      desired_qty    INTEGER,
      hold_reason    TEXT,                        -- non-null = a human stopped this one; the worker skips
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (sku, channel)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_intent_due ON channel_intent(channel, mode, publish_after);`);

  // The outbox. Every cross-channel effect goes through here rather than being fired inline from a
  // webhook handler, and the reason is local to this repo: vite.config.js imports every lib/*.mjs, so
  // saving ANY of them restarts the dev server. An in-memory retry holding "delist AAC-097 from eBay"
  // dies mid-flight on an unrelated edit — an oversell on a qty-1 card caused by a stray save.
  //
  // Idempotency lives in the HANDLERS, by construction (SKU on createOrReplaceInventoryItem,
  // identifier on productSet, changeFromQuantity on inventorySetQuantities, stock_applied_at on the
  // order line). dedupe_key is therefore free to do the thing it is actually good at: collapsing
  // redundant ENQUEUES — ten sibling publishes coalescing into one identity.rebuild.
  //
  // lease_expires, not a bare claim: a job claimed by a process that then died must come back.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL,                -- 'shopify.publish'|'shopify.setqty'|'ebay.publish'|'ebay.delist'|'identity.rebuild'
      channel       TEXT NOT NULL,                -- 'shopify'|'ebay'|'local'
      sku           TEXT NOT NULL,
      payload       TEXT,                         -- JSON
      dedupe_key    TEXT UNIQUE,                  -- NULLs do not collide in SQLite, which is what we want
      priority      INTEGER NOT NULL DEFAULT 10,  -- delist/sync 0, publish 10; a delist must not queue behind a 400-row run
      run_after     TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at    TEXT,
      lease_expires TEXT,
      attempts      INTEGER NOT NULL DEFAULT 0,
      state         TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|dead
      last_error    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      done_at       TEXT
    );
  `);
  // The claim query's index: state + priority + run_after, in the order it sorts.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_claim ON sync_jobs(state, priority, run_after, id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_sku ON sync_jobs(sku, channel);`);

  // applyStockDecrements' second match rung is ebay_item_id → inventory_items.ebay_listing_id, and
  // there has never been an index for it — buildInventoryLookup compensates by loading both stock
  // tables into memory on every poll. Cheap to add, and the sync worker will hit this column too.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_ebay_listing ON inventory_items(ebay_listing_id);`);

  // Uploaded Shopify media, keyed on the COMPOSITOR'S CONTENT HASH rather than on a product or a SKU.
  // That key is the whole point: the hash already means "these exact bytes, this exact art, this exact
  // rail text", so two products that legitimately share an image (a card and its own condition sibling
  // — same source bytes, condition never reaches the pixels) upload once and reference the same file.
  //
  // WITHOUT THIS TABLE THE PIPELINE QUIETLY LITTERS. productSet's `files` is a REPLACE list, so every
  // republish sends the full set; re-staging the same bytes each time mints a NEW file in Shopify's
  // Files on every pass, and nothing ever collects them. At ~150 products with a few republishes each
  // that is thousands of orphans, and Files has no bulk delete.
  //
  // The eBay twin is listing_images, but the two cannot share: an EPS url EXPIRES and is re-uploaded on
  // a timer, while a Shopify file is permanent once READY. listing_images therefore carries expires_at
  // and a per-item id; this carries neither, and conflating them would put an expiry check on rows that
  // can never expire.
  //
  // KEYED PER STORE, for the same reason shopify_listings is: a file_gid is a
  // gid://shopify/MediaImage/… that exists on ONE store. Keyed on the hash alone, a live publish of a
  // card already rehearsed on dev reuses the DEV MediaImage id, productSet refuses the entire call with
  // INVALID_INPUT, and the self-heal in lib/shopify.mjs then "recovers" from it on every card forever.
  // The bytes are identical across stores; the id Shopify gives them is not.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shopify_files (
      content_hash  TEXT NOT NULL,             -- composeHash: bytes + layout + variant + rail text + target
      store         TEXT NOT NULL DEFAULT 'dev',  -- which store this file_gid exists on
      file_gid      TEXT,                      -- gid://shopify/MediaImage/… once READY
      resource_url  TEXT,                      -- the staged upload's resourceUrl, kept for diagnosis
      status        TEXT NOT NULL DEFAULT 'staged',  -- staged|ready|failed
      view          TEXT,                      -- front|back|corners|cert|branded|og — provenance only
      filename      TEXT,
      width         INTEGER,
      height        INTEGER,
      bytes         INTEGER,
      compose_version TEXT,                    -- answers "which files are still on the old art?"
      error         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      ready_at      TEXT,
      PRIMARY KEY (content_hash, store)
    );
  `);
  migrateShopifyFilesStore(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_files_status ON shopify_files(store, status);`);

  // Backfill intent for the eBay estate that already exists, so the arbitration layer is not empty on
  // day one and a reconcile has something to compare against. WHERE NOT EXISTS makes it a no-op on
  // every boot after the first, and it never overwrites an intent someone has since edited.
  db.exec(`
    INSERT INTO channel_intent (sku, channel, kind, item_id, mode, price_cents)
    SELECT el.sku, 'ebay', 'inventory', el.item_id, 'auto', NULL
      FROM ebay_listings el
     WHERE el.sku IS NOT NULL   -- defensive; the column is NOT NULL today
       AND NOT EXISTS (SELECT 1 FROM channel_intent ci WHERE ci.sku = el.sku AND ci.channel = 'ebay');
  `);
}

// Initialise a tracker-schema DB at dbPath (PRAGMAs + DDL + additive migrations). Used by openDb and
// by openDbAt; does NOT touch the process singleton.
function initDb(dbPath) {
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
    migrateSealedListing(db);
    migratePregrade(db);
    migrateShopify(db);
    migratePurchasing(db);
  } catch (e) { console.error('[db] migration:', e?.message || e); }
  return db;
}

// Opens (once per process) and initialises the tracker DB. Returns the live handle.
export function openDb(dbPath = DB_PATH) {
  if (_db) return _db;
  _db = initDb(dbPath);
  return _db;
}

// Opens a FRESH, non-cached tracker-schema DB at dbPath. For tests ONLY — so a test's temp DB is
// never confused with the process singleton (which would otherwise return the real data/tracker.db
// regardless of the path passed, risking real-data writes). Never call from app code.
export function openDbAt(dbPath) { return initDb(dbPath); }
