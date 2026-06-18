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
  game TEXT NOT NULL,                          -- 'riftbound'|'mtg'|'pokemon'|'swu'
  identity_key TEXT NOT NULL,                  -- 'OGN-296'|'neo-1'|'sv4-25'|'sor/010'
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
  _db = db;
  return db;
}
