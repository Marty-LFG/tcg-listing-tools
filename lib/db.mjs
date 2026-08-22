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
