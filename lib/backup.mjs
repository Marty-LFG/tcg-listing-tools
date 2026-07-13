// lib/backup.mjs — scheduled, rotated SQLite snapshots of the money-bearing databases.
//
// tracker.db (graded/sealed/bulk inventory: cost basis, P/L, SKUs, grading submissions) and
// repricer.db hold real financial data that is NOT reconstructible from any upstream API — a disk
// failure or a corrupt WAL would lose it irrecoverably, and nothing else in the repo backs it up.
// This takes a consistent online snapshot of each DB via `VACUUM INTO` (safe even while the
// single-writer collector is mid-pass — it produces a fully-checkpointed standalone copy), bundles
// the small owner-editable config files alongside, and rotates to the newest N snapshots.
//
// Runs inside the always-on dev service on a timer — a direct mirror of lib/refresh.mjs
// startDataRefresh (boot delay + interval, HMR-guarded globalThis singleton, unref'd). GR7: a
// failed snapshot logs a warning and never throws out of the timer. Surfaced at /api/status
// (jobs.backup) so a silently-failing backup is diagnosable; forced now via POST /api/status/backup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.mjs';
import { openRepricerDb, REPRICER_DB_PATH } from './repricer-db.mjs';
import { scrubSecrets } from './logbuffer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'backup.config.json');
// TCG_BACKUP_DIR overrides the output location so the integration suite never writes to data/backups.
export const BACKUP_DIR = process.env.TCG_BACKUP_DIR || path.join(ROOT, 'data', 'backups');

const DEFAULT_CONFIG = { enabled: true, interval_hours: 24, keep: 14, include_secrets: false };

export function loadBackupConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return DEFAULT_CONFIG; }
}

// 2026-07-13_11-45-30 — a lexicographically sortable folder name (rotation sorts by name).
const SNAP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
function stamp(d) { return d.toISOString().replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '-'); }

// VACUUM INTO writes a consistent, fully-checkpointed standalone copy of the live DB even while the
// app's single writer is mid-pass (WAL). Target must NOT already exist (guaranteed by the fresh
// per-run folder). SQLite takes a string literal, not a bound param, so escape single quotes and
// normalise Windows backslashes to '/' (SQLite accepts either and doesn't treat '\' as an escape).
function snapshotDb(db, target) {
  const lit = target.replace(/\\/g, '/').replace(/'/g, "''");
  db.exec(`VACUUM INTO '${lit}'`);
  return fs.statSync(target).size;
}

function defaultSources() {
  return [
    { name: 'tracker', db: openDb(), src: DB_PATH },
    { name: 'repricer', db: openRepricerDb(), src: REPRICER_DB_PATH },
  ];
}

// The small owner-editable JSON + (opt-in) the secrets, so a restore is self-contained. include_secrets
// is OFF by default — the .env / encrypted refresh token are only duplicated when the owner asks.
function bundledConfigFiles(includeSecrets) {
  const dataDir = path.join(ROOT, 'data');
  const files = [];
  try {
    for (const f of fs.readdirSync(dataDir)) {
      if (f.endsWith('.config.json') || f === 'grading-companies.json') files.push(path.join(dataDir, f));
    }
  } catch { /* no data dir yet */ }
  if (includeSecrets) {
    for (const f of [path.join(ROOT, '.env'), path.join(dataDir, 'ebay-oauth.json')]) {
      try { if (fs.existsSync(f)) files.push(f); } catch { /* ignore */ }
    }
  }
  return files;
}

function listSnapshots(outDir) {
  try {
    return fs.readdirSync(outDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SNAP_RE.test(e.name)).map((e) => e.name).sort();
  } catch { return []; }
}

// Delete oldest snapshots beyond `keep` (never below 1). Returns how many were removed.
function rotate(outDir, keep) {
  const dirs = listSnapshots(outDir);
  const excess = Math.max(0, dirs.length - Math.max(1, keep));
  let removed = 0;
  for (const name of dirs.slice(0, excess)) {
    try { fs.rmSync(path.join(outDir, name), { recursive: true, force: true }); removed++; } catch { /* ignore */ }
  }
  return removed;
}

function newestSnapshotAgeHours(outDir) {
  const dirs = listSnapshots(outDir);
  if (!dirs.length) return Infinity;
  try { return (Date.now() - fs.statSync(path.join(outDir, dirs[dirs.length - 1])).mtimeMs) / 3600_000; }
  catch { return Infinity; }
}

// Structured record of the last pass + next scheduled fire (mirrors getRefreshState), surfaced at
// /api/status (jobs.backup) so a silently-failing snapshot is visible without the box's console.
let _lastRun = null;
let _nextRunAt = null;
export function getBackupState() {
  return { running: !!globalThis.__tcgBackupTimer, enabled: loadBackupConfig().enabled !== false, next_run_at: _nextRunAt, last_run: _lastRun };
}

// One snapshot pass. `sources`/`outDir`/`keep`/`includeSecrets`/`now` are injectable for tests;
// defaults come from the live DBs + config. Never throws (GR7) — failures land in the record + log.
export async function runBackup({ trigger = 'schedule', sources, outDir = BACKUP_DIR, keep, includeSecrets, now } = {}) {
  const cfg = loadBackupConfig();
  keep = keep ?? cfg.keep;
  includeSecrets = includeSecrets ?? cfg.include_secrets;
  sources = sources || defaultSources();
  const started = now || new Date();
  const dir = path.join(outDir, stamp(started));
  const results = [];
  let ok = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const s of sources) {
      const target = path.join(dir, s.name + '.db');
      try { const bytes = snapshotDb(s.db, target); results.push({ name: s.name, ok: true, bytes, file: target }); }
      catch (e) { ok = false; results.push({ name: s.name, ok: false, detail: scrubSecrets(String(e?.message || e)) }); }
    }
    // best-effort config/secret bundle — a copy failure never fails the DB snapshot
    let copied = 0;
    try {
      const cfgDir = path.join(dir, 'config');
      fs.mkdirSync(cfgDir, { recursive: true });
      for (const f of bundledConfigFiles(includeSecrets)) {
        try { fs.copyFileSync(f, path.join(cfgDir, path.basename(f))); copied++; } catch { /* skip this file */ }
      }
    } catch { /* skip config bundle */ }
    const rotated = rotate(outDir, keep);
    _lastRun = { started_at: started.toISOString(), finished_at: new Date().toISOString(), trigger, ok, dir, kept: keep, config_files: copied, rotated_out: rotated, results };
    console.log(`[backup] ${path.basename(dir)} — ${results.filter((r) => r.ok && r.bytes != null).map((r) => r.name).join('+') || 'nothing'} + ${copied} config · rotated ${rotated} · keep ${keep}`);
  } catch (e) {
    const detail = scrubSecrets(String(e?.message || e));
    console.warn('[backup] snapshot failed — ' + detail);
    _lastRun = { started_at: started.toISOString(), finished_at: new Date().toISOString(), trigger, ok: false, dir, results, error: detail };
  }
  return _lastRun;
}

// One-shot pass for the diagnostics trigger (POST /api/status/backup).
export async function runBackupNow() { return runBackup({ trigger: 'manual' }); }

// Stop-then-start (mirror of startDataRefresh): survives Vite's in-process restarts and never
// stacks two timers. globalThis is the cross-instance singleton.
export function startBackups() {
  stopBackups();
  const cfg = loadBackupConfig();
  if (cfg.enabled === false) { console.log('[backup] disabled (data/backup.config.json)'); return; }
  const intervalMs = Math.max(1, cfg.interval_hours) * 3600_000;
  // Boot pass skips if a snapshot already exists fresher than the interval, so frequent dev
  // restarts don't spawn a snapshot storm; the recurring pass always snapshots.
  const boot = setTimeout(() => {
    if (newestSnapshotAgeHours(BACKUP_DIR) < Math.max(1, cfg.interval_hours)) {
      console.log('[backup] a recent snapshot exists (< interval) — boot snapshot skipped'); return;
    }
    runBackup({ trigger: 'boot' }).catch((e) => console.error('[backup]', e?.message || e));
  }, 90_000);
  if (boot.unref) boot.unref();
  const timer = setInterval(() => {
    _nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    runBackup({ trigger: 'schedule' }).catch((e) => console.error('[backup]', e?.message || e));
  }, intervalMs);
  if (timer.unref) timer.unref();
  globalThis.__tcgBackupTimer = timer;
  globalThis.__tcgBackupBoot = boot;
  _nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  console.log(`[backup] DB snapshots every ${cfg.interval_hours}h → ${path.relative(ROOT, BACKUP_DIR) || BACKUP_DIR} · keep ${cfg.keep}${cfg.include_secrets ? ' · +secrets' : ''}`);
  return timer;
}

export function stopBackups() {
  if (globalThis.__tcgBackupBoot) { clearTimeout(globalThis.__tcgBackupBoot); globalThis.__tcgBackupBoot = null; }
  if (globalThis.__tcgBackupTimer) { clearInterval(globalThis.__tcgBackupTimer); globalThis.__tcgBackupTimer = null; }
  _nextRunAt = null;
}
