// lib/status.mjs — Vite plugin behind settings.html: /api/status (system dashboard)
// + /api/settings (read/write the owner-editable data/*.config.json files).
// Mirrors the trackerPlugin/inventoryPlugin shape; registered in vite.config.js `plugins`.
//
// Security invariants:
//   - `.env` VALUES never leave the server. /api/status reports key PRESENCE as booleans
//     (plus non-secret printer ip/dpi). /api/settings cannot read or write .env at all.
//   - Probes never run automatically (Scrydex bills per request): POST /probe/:source is
//     an explicit user action, cached PROBE_TTL_MS, so a stuck refresh button can't burn
//     credits. GET /api/status derives source health passively (tracker card_cache /
//     watchlist.last_error / cached probes).
//   - Everything degrades gracefully (GR7): a broken data file or missing DB shows up as
//     a a status entry, never a 500.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.mjs';
import { openRepricerDb, REPRICER_DB_PATH } from './repricer-db.mjs';
import { openPostsaleDb, POSTSALE_DB_PATH } from './postsale-db.mjs';
import { getPostsaleState, startPostsaleJobs, stopPostsaleJobs } from './postsale.mjs';
import { startCollector, stopCollector, setThresholds, getCollectorState, runPass } from './collector.mjs';
import { startDataRefresh, stopDataRefresh, loadRefreshConfig, getRefreshState, runRefreshNow, availableBakes } from './refresh.mjs';
import { startBackups, stopBackups, getBackupState, runBackupNow } from './backup.mjs';
import { installLogCapture, getLogs, scrubSecrets } from './logbuffer.mjs';
import { startHeartbeat, getHeartbeat } from './heartbeat.mjs';
import { printConfig } from './labelprint.mjs';
import { getSealedRefreshState } from './sealed.mjs';
import { telegramEnabled, telegramChatConfigured } from './telegram.mjs';
import { oauthStatus } from './ebay-oauth.mjs';
import { clearSetCardsRow } from './catalog.mjs';
import { clearConsoleCache } from './pricecharting.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = (f) => path.join(ROOT, 'data', f);

// ---- helpers (repo convention — same shape as lib/tracker.mjs) ----
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  // NB: intentionally NO `access-control-allow-origin: *`. /api/status + /api/settings are
  // consumed same-origin by settings.html only; omitting the header keeps a random website
  // the owner visits from cross-origin-reading config presence, DB sizes, and internal IPs.
  // Same-origin (the dashboard) and server-side clients (curl/Invoke-RestMethod) are unaffected.
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) b = b.slice(0, 1e6); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
const ageHours = (file) => { try { return (Date.now() - fs.statSync(file).mtimeMs) / 3600_000; } catch { return null; } };
const fileSizeMb = (file) => { try { return Math.round(fs.statSync(file).size / 1048.576) / 1000; } catch { return null; } };
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// ---- diagnostics auth (logs + triggers only — the status snapshot stays open) ----
// Gate on DIAG_TOKEN: UNSET => the endpoint is disabled (503), so raw logs and the
// side-effecting triggers are NEVER exposed by default. Token via `Authorization:
// Bearer <t>` or `?token=<t>`, constant-time compared. GR2: the token itself is
// .env-only and is never echoed back.
export function diagTokenCheck(env, provided) {
  const want = (env.DIAG_TOKEN || '').trim();
  if (!want) return { ok: false, code: 503, error: 'diagnostics disabled — set DIAG_TOKEN in .env to enable /logs + triggers' };
  const got = (provided || '').trim();
  if (!got) return { ok: false, code: 401, error: 'missing token — pass Authorization: Bearer <DIAG_TOKEN> or ?token=' };
  const a = Buffer.from(got), b = Buffer.from(want);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, code: 403, error: 'invalid diagnostics token' };
}
function diagToken(req, url) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || '');
  return (m && m[1]) || url.searchParams.get('token') || '';
}

// ---- version (computed once per process) ----
let _version = null;
export function versionInfo() {
  if (_version) return { ..._version, uptime_s: Math.round(process.uptime()) };
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { /* noop */ }
  _version = { pkg, commit, node: process.version };
  return { ..._version, uptime_s: Math.round(process.uptime()) };
}

// ---- env key presence (BOOLEANS ONLY — never echo a value) ----
export function keyPresence(env) {
  const has = (k) => !!(env[k] || '').trim();
  const printer = printConfig(env);
  return {
    pokemon: { POKEMONTCG_API_KEY: has('POKEMONTCG_API_KEY'), note: 'keyless works (lower rate limit)' },
    riftbound: { SCRYDEX_API_KEY: has('SCRYDEX_API_KEY'), SCRYDEX_TEAM_ID: has('SCRYDEX_TEAM_ID'), note: 'optional — coverage is keyless (baked/riftscribe)' },
    lego: {
      REBRICKABLE_API_KEY: has('REBRICKABLE_API_KEY'), BRICKSET_API_KEY: has('BRICKSET_API_KEY'),
      BRICKLINK: has('BRICKLINK_CONSUMER_KEY') && has('BRICKLINK_CONSUMER_SECRET') && has('BRICKLINK_TOKEN') && has('BRICKLINK_TOKEN_SECRET'),
    },
    ebay: {
      EBAY_APP_ID: has('EBAY_APP_ID'), EBAY_CERT_ID: has('EBAY_CERT_ID'), EBAY_RUNAME: has('EBAY_RUNAME'),
      marketplace: (env.EBAY_MARKETPLACE || 'EBAY_AU'),   // not a secret
    },
    grader: {
      ANTHROPIC_API_KEY: has('ANTHROPIC_API_KEY'), OPENAI_API_KEY: has('OPENAI_API_KEY'),
      provider: (env.GRADER_PROVIDER || (has('ANTHROPIC_API_KEY') ? 'anthropic' : has('OPENAI_API_KEY') ? 'openai' : null)),
    },
    printer: { configured: printer.enabled, ip: printer.ip || null, dpi: printer.dpi, lang: printer.lang },
    telegram: { TELEGRAM_BOT_TOKEN: telegramEnabled(env), TELEGRAM_CHAT_ID: telegramChatConfigured(env) },
    psa: { PSA_API_TOKEN: has('PSA_API_TOKEN') },
    pricecharting: { enabled: (env.PRICECHARTING_ENABLED ?? 'true') !== 'false', PRICECHARTING_TOKEN: has('PRICECHARTING_TOKEN') },
  };
}

// ---- probes (explicit, allowlisted, cached — never automatic) ----
export const PROBE_TTL_MS = 15 * 60 * 1000;
// source -> cheapest healthy request through the existing proxy (auth injection reused).
export const PROBES = {
  fx: '/api/fx/latest?base=USD&symbols=AUD',
  mtg: '/api/mtg/cards/neo/1',
  swu: '/api/swu/cards/sor/010',
  lorcana: '/api/lorcana/cards/1/1',
  rbs: '/api/rbs/cards?limit=1',
  rb: '/api/rb/cards/OGN-001?include=prices',
  pkm: '/api/pkm/cards/base1-4',
  tcgdex: '/api/tcgdex/ja/sets',
  rebrickable: '/api/lego/rebrickable/sets/75192-1/',
  brickset: '/api/lego/brickset/getThemes',
  bricklink: '/api/lego/bricklink/items/SET/75192-1/price',
  ebay: '/api/ebay/buy/browse/v1/item_summary/search?q=charizard&limit=1',
  pc: '/api/pc/lookup?name=Charizard&number=4&set=Base%20Set',
  psa: '/api/cert?company=PSA&cert=00000001',
};
const _probeCache = new Map();   // source -> { state, http, ms, detail, checked_at }

function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 402) return 'billing';
  if (status === 404) return 'ok';          // upstream answered; the probe card id may age out
  if (status === 429) return 'rate_limited';
  return 'down';
}

// Render an error VALUE to text. Upstreams often return a structured body ({code,message,…});
// String() on that yields a useless "[object Object]" (e.g. Scrydex 402), so dig out a message.
function errText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const m = v.message || v.error || v.detail || v.code;
  if (m) return String(m);
  try { return JSON.stringify(v); } catch { return String(v); }
}

export async function runProbe(source, base, { force = false } = {}) {
  const pathName = PROBES[source];
  if (!pathName) return null;
  const cached = _probeCache.get(source);
  if (cached && !force && Date.now() - cached.checked_at_ms < PROBE_TTL_MS) return { ...cached, cached: true };
  const t0 = Date.now();
  let out;
  try {
    const r = await fetch(base + pathName, { signal: AbortSignal.timeout(20_000) });
    let detail = null;
    // some middlewares answer 200 with a structured failure body (GR7) — look inside
    try {
      const j = JSON.parse(await r.text());
      // scrub upstream-echoed text: an API could reflect a key back in an error body (GR2 defense-in-depth)
      if (j && j.error) detail = scrubSecrets(errText(j.error)).slice(0, 200);
      if (j && j.matched === false && j.reason) detail = scrubSecrets(errText(j.reason)).slice(0, 200);
    } catch { /* non-JSON body is fine */ }
    out = { state: classify(r.status), http: r.status, ms: Date.now() - t0, detail };
  } catch (e) {
    out = { state: 'down', http: null, ms: Date.now() - t0, detail: e?.name === 'TimeoutError' ? 'timeout' : scrubSecrets(String(e?.message || e)).slice(0, 200) };
  }
  out.checked_at = new Date().toISOString();
  out.checked_at_ms = Date.now();
  _probeCache.set(source, out);
  return out;
}
export function clearProbeCache() { _probeCache.clear(); }   // for tests

// ---- passive source evidence from the tracker DB ----
const GAME_TO_SOURCE = { pokemon: 'pkm', mtg: 'mtg', swu: 'swu', lorcana: 'lorcana', riftbound: 'rb' };
function passiveSources(db) {
  const out = {};
  try {
    for (const r of db.prepare(
      `SELECT game, MAX(fetched_at) last, MIN(http_status) minStatus, MAX(http_status) maxStatus
       FROM card_cache GROUP BY game`).all()) {
      const src = GAME_TO_SOURCE[r.game] || r.game;
      out[src] = { state: r.maxStatus >= 200 && r.maxStatus < 300 ? 'ok' : 'unknown', evidence: 'card_cache', last_evidence_at: r.last };
    }
    for (const r of db.prepare(
      `SELECT game, last_error, COUNT(*) n, MAX(last_checked_at) last
       FROM watchlist WHERE active=1 AND last_error IS NOT NULL GROUP BY game, last_error`).all()) {
      const src = GAME_TO_SOURCE[r.game] || r.game;
      const state = /unauthorized|key_missing/.test(r.last_error) ? 'auth_failed'
        : /inactive/.test(r.last_error) ? 'billing' : 'degraded';
      out[src] = { state, evidence: scrubSecrets(`watchlist last_error=${r.last_error} (${r.n} cards)`), last_evidence_at: r.last };
    }
  } catch { /* fresh DB — no evidence yet */ }
  return out;
}

// ---- baked-data freshness ----
function catalogStatus() {
  const refresh = loadRefreshConfig();
  const out = { refresh: { ...refresh } };
  const spec = {
    riftbound: { file: 'riftbound.json', managed: refresh.bakes?.includes('riftbound'), count: (j) => Object.values(j).reduce((n, s) => n + (s.cards?.length || 0), 0), extra: (j) => ({ sets: Object.keys(j).length }) },
    pokemon_intl: { file: 'pokemon-intl-sets.json', managed: refresh.bakes?.includes('pokemon-intl'), count: (j) => Object.values(j).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0), extra: (j) => ({ langs: Object.keys(j).length }) },
    pokemon_en_early: { file: 'pokemon-en-early.json', managed: refresh.bakes?.includes('pokemon-en-early'), count: (j) => (j.sets || []).length },
    pokemon_mep: { file: 'pokemon-mep.json', managed: refresh.bakes?.includes('pokemon-mep'), count: (j) => (j.cards || []).length, extra: (j) => ({ with_art: (j.cards || []).filter((c) => c.img).length }) },
    funko: { file: 'funko_pop.json', managed: false, frozen: true, count: (j) => j.length },
    pokemon_dex: { file: 'pokemon-dex-en.json', managed: false, count: (j) => Object.keys(j.dex || {}).length },
  };
  for (const [name, s] of Object.entries(spec)) {
    const file = DATA(s.file);
    const age_h = ageHours(file);
    let count = null, extra = {};
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); count = s.count(j); extra = s.extra ? s.extra(j) : {}; }
    catch (e) { extra = { error: String(e?.message || e).slice(0, 120) }; }
    out[name] = {
      file: 'data/' + s.file, age_h: round1(age_h), count, ...extra,
      frozen: !!s.frozen, managed: !!s.managed,
      stale: !!s.managed && refresh.enabled && age_h != null && age_h > refresh.interval_hours * 1.5,
    };
  }
  return out;
}

// ---- DB stats ----
function dbStats(db, rdb) {
  const one = (sql) => { try { return db.prepare(sql).get(); } catch { return null; } };
  const oneR = (sql) => { try { return rdb.prepare(sql).get(); } catch { return null; } };
  const pdb = (() => { try { return openPostsaleDb(); } catch { return null; } })();
  const oneP = (sql) => { try { return pdb ? pdb.prepare(sql).get() : null; } catch { return null; } };
  return {
    tracker: {
      file: DB_PATH, size_mb: fileSizeMb(DB_PATH),
      watchlist: one(`SELECT COUNT(*) c FROM watchlist WHERE active=1`)?.c ?? null,
      snapshots: one(`SELECT COUNT(*) c FROM price_snapshots`)?.c ?? null,
      signals_pending: one(`SELECT COUNT(*) c FROM signals WHERE acknowledged=0`)?.c ?? null,
      last_pass_at: one(`SELECT MAX(last_checked_at) t FROM watchlist`)?.t ?? null,
    },
    inventory: {
      items: one(`SELECT COUNT(*) c FROM inventory_items`)?.c ?? null,
      submissions_open: one(`SELECT COUNT(*) c FROM grading_submissions WHERE status IN ('draft','submitted','received')`)?.c ?? null,
    },
    repricer: {
      file: REPRICER_DB_PATH, size_mb: fileSizeMb(REPRICER_DB_PATH),
      listings: oneR(`SELECT COUNT(*) c FROM listings`)?.c ?? null,
      proposals_open: oneR(`SELECT COUNT(*) c FROM reprice_proposals WHERE status='pending'`)?.c ?? null,
    },
    postsale: {
      file: POSTSALE_DB_PATH, size_mb: fileSizeMb(POSTSALE_DB_PATH),
      orders: oneP(`SELECT COUNT(*) c FROM orders`)?.c ?? null,
      buyers: oneP(`SELECT COUNT(*) c FROM buyers`)?.c ?? null,
      messages_pending: oneP(`SELECT COUNT(*) c FROM postsale_messages WHERE status='pending'`)?.c ?? null,
      messages_awaiting: oneP(`SELECT COUNT(*) c FROM postsale_messages WHERE status='awaiting_approval'`)?.c ?? null,
      to_pack: oneP(`SELECT COUNT(*) c FROM orders WHERE shipped_status='unshipped'`)?.c ?? null,
    },
  };
}

// ---- editable settings ----
// name -> { file, editable, validate(content) -> error string | null, apply(cfg, ctx) }
export const SETTINGS = {
  tracker: {
    file: 'tracker.config.json', editable: true,
    validate(c) {
      if (!c || typeof c !== 'object') return 'not an object';
      if (!(c.cadence_hours >= 1 && c.cadence_hours <= 168)) return 'cadence_hours must be 1–168';
      const t = c.thresholds;
      if (!t) return 'thresholds required';
      if (!(t.opportunity_drop_pct < 0)) return 'opportunity_drop_pct must be negative';
      if (!(t.downtrend_drop_pct < 0)) return 'downtrend_drop_pct must be negative';
      if (!(t.momentum_rise_pct > 0)) return 'momentum_rise_pct must be positive';
      if (!(t.min_price_aud >= 0)) return 'min_price_aud must be ≥ 0';
      return null;
    },
    apply(c, { db, base }) {   // cadence lives in the collector timer → restart it
      setThresholds(c.thresholds);
      stopCollector();
      startCollector({ db, base, cadenceHours: c.cadence_hours });
      return 'collector restarted @ ' + c.cadence_hours + 'h';
    },
  },
  repricer: {
    file: 'repricer.config.json', editable: true,
    validate(c) {
      if (!c || typeof c !== 'object') return 'not an object';
      const g = c.guardrails;
      if (!g) return 'guardrails required';
      if (g.never_decrease !== true) return 'never_decrease must stay true (hard invariant, AGENTS.md §15)';
      if (!(g.min_comparable >= 1)) return 'min_comparable must be ≥ 1';
      if (!(g.min_uplift_pct > 0)) return 'min_uplift_pct must be positive';
      if (!(g.max_increase_pct_per_run > 0 && g.max_increase_pct_per_run <= 100)) return 'max_increase_pct_per_run must be 1–100';
      if (!['high', 'medium', 'low'].includes(g.required_confidence)) return 'required_confidence must be high/medium/low';
      if (typeof c.scan_enabled !== 'boolean') return 'scan_enabled must be boolean';
      if (!(c.cadence_hours >= 1)) return 'cadence_hours must be ≥ 1';
      return null;
    },
    apply() { return 'live-read — applies on next scan'; },
  },
  'bulk-pricing': {
    file: 'bulk-pricing.config.json', editable: true,
    validate(c) {
      if (!c || typeof c !== 'object') return 'not an object';
      if (c.currency !== 'AUD') return 'currency must be AUD';
      if (!(c.min_price_aud > 0)) return 'min_price_aud must be positive';
      if (!Array.isArray(c.rounding_endings) || !c.rounding_endings.length) return 'rounding_endings must be a non-empty array';
      for (const e of c.rounding_endings) if (!(e > 0 && e < 1)) return `rounding ending ${e} must be a sub-dollar decimal`;
      if (!(c.market_threshold_aud?.default > 0)) return 'market_threshold_aud.default must be positive';
      if (!(c.tiers?.default?.default?.default > 0)) return 'tiers.default.default.default (catch-all floor) required';
      for (const [g, rar] of Object.entries(c.tiers)) {
        if (g.startsWith('_')) continue;
        for (const [r, fin] of Object.entries(rar)) {
          if (r.startsWith('_')) continue;
          for (const [f, v] of Object.entries(fin)) {
            if (f.startsWith('_')) continue;
            if (!(typeof v === 'number' && v > 0)) return `tiers.${g}.${r}.${f} must be a positive number`;
          }
        }
      }
      return null;
    },
    apply() { return 'live-read — applies on next /api/bulk/price'; },
  },
  refresh: {
    file: 'refresh.config.json', editable: true,
    validate(c) {
      if (!c || typeof c !== 'object') return 'not an object';
      if (typeof c.enabled !== 'boolean') return 'enabled must be boolean';
      if (!(c.interval_hours >= 1)) return 'interval_hours must be ≥ 1';
      if (!Array.isArray(c.bakes)) return 'bakes must be an array';
      const valid = new Set(availableBakes().map((b) => b.name));   // derived from the BAKES registry — never stale
      for (const b of c.bakes) if (!valid.has(b)) return `unknown bake '${b}' (valid: ${[...valid].join(', ')})`;
      return null;
    },
    apply() {   // the refresh loop reads the file at start → restart it
      stopDataRefresh();
      startDataRefresh();
      return 'refresh loop restarted';
    },
  },
  backup: {
    file: 'backup.config.json', editable: true,
    validate(c) {
      if (!c || typeof c !== 'object') return 'not an object';
      if (typeof c.enabled !== 'boolean') return 'enabled must be boolean';
      if (!(c.interval_hours >= 1)) return 'interval_hours must be ≥ 1';
      if (!(Number.isInteger(c.keep) && c.keep >= 1 && c.keep <= 365)) return 'keep must be an integer 1–365';
      if (typeof c.include_secrets !== 'boolean') return 'include_secrets must be boolean';
      return null;
    },
    apply() {   // the backup loop reads the file at start → restart it
      stopBackups();
      startBackups();
      return 'backup loop restarted';
    },
  },
  postsale: {
    file: 'postsale.config.json', editable: true,
    validate(c) {
      if (!c || typeof c !== 'object') return 'not an object';
      if (typeof c.enabled !== 'boolean') return 'enabled must be boolean';
      if (!['approve', 'auto'].includes(c.mode)) return "mode must be 'approve' or 'auto'";
      if (typeof c.dry_run !== 'boolean') return 'dry_run must be boolean';
      if (!(c.poll_interval_min >= 1)) return 'poll_interval_min must be ≥ 1';
      if (!(c.reply_poll_interval_min >= 1)) return 'reply_poll_interval_min must be ≥ 1';
      if (!(c.lookback_hours >= 1 && c.lookback_hours <= 24 * 30)) return 'lookback_hours must be 1–720 (eBay ModTime window cap)';
      if (!(Number.isInteger(c.max_per_run) && c.max_per_run >= 1 && c.max_per_run <= 100)) return 'max_per_run must be an integer 1–100';
      if (!c.timezone || typeof c.timezone !== 'string') return 'timezone must be a non-empty string';
      if (!(Number.isInteger(c.digest_hour) && c.digest_hour >= 0 && c.digest_hour <= 23)) return 'digest_hour must be 0–23';
      for (const k of ['ship_timing_text', 'signature', 'brand_voice', 'style_notes']) if (typeof c[k] !== 'string') return k + ' must be a string';
      if (c.dashboard_url != null && typeof c.dashboard_url !== 'string') return 'dashboard_url must be a string';   // optional
      for (const k of ['invite_offers', 'alerts', 'labels', 'listings_sync', 'fees', 'cases']) if (typeof c[k] !== 'boolean') return k + ' must be boolean';
      if (!c.quiet_hours || typeof c.quiet_hours !== 'object' || typeof c.quiet_hours.enabled !== 'boolean') return 'quiet_hours must be an object with a boolean enabled';
      if (!Array.isArray(c.holidays)) return 'holidays must be an array';
      return null;
    },
    apply() {   // the postsale timers read the file at start → restart them (env/db remembered)
      stopPostsaleJobs();
      startPostsaleJobs();
      return 'postsale jobs restarted';
    },
  },
  // read-only in the UI (still owner-editable on disk)
  collectr: { file: 'collectr.config.json', editable: false },
  grading: { file: 'grading.config.json', editable: false },
  'grading-companies': { file: 'grading-companies.json', editable: false },
};

function readSetting(name) {
  const s = SETTINGS[name];
  if (!s) return null;
  try { return { name, editable: s.editable, content: JSON.parse(fs.readFileSync(DATA(s.file), 'utf8')), file: 'data/' + s.file }; }
  catch (e) { return { name, editable: s.editable, content: null, file: 'data/' + s.file, error: String(e?.message || e) }; }
}

function writeSettingAtomic(name, content) {
  const s = SETTINGS[name];
  const file = DATA(s.file);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(content, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ---- routers ----
function statusRouter({ env, db, rdb, base }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method || 'GET';

      if (p === '/' && method === 'GET') {
        const sources = passiveSources(db);
        for (const [src, probe] of _probeCache) sources[src] = { ...sources[src], ...probe, evidence: 'probe' };
        for (const src of Object.keys(PROBES)) if (!sources[src]) sources[src] = { state: 'unknown' };
        return send(res, 200, {
          version: versionInfo(),
          keys: keyPresence(env),
          sources,
          data: catalogStatus(),
          jobs: { refresh: getRefreshState(), collector: getCollectorState(), heartbeat: getHeartbeat(), backup: getBackupState(), postsale: getPostsaleState(), sealed_value: getSealedRefreshState() },
          dbs: dbStats(db, rdb),
          subsystems: {
            printer: printConfig(env),
            telegram: { enabled: telegramEnabled(env), chat_configured: telegramChatConfigured(env) },
            ebay_oauth: (() => { try { return oauthStatus(env); } catch (e) { return { error: String(e?.message || e) }; } })(),
            collector: { cadence_hours: (() => { try { return JSON.parse(fs.readFileSync(DATA('tracker.config.json'), 'utf8')).cadence_hours; } catch { return null; } })() },
          },
          probe_ttl_min: PROBE_TTL_MS / 60000,
        });
      }

      const probeM = p.match(/^\/probe\/([a-z-]+)$/);
      if (probeM && method === 'POST') {
        const source = probeM[1];
        if (!PROBES[source]) return send(res, 404, { error: 'unknown source', sources: Object.keys(PROBES) });
        const result = await runProbe(source, base, { force: url.searchParams.get('force') === '1' });
        return send(res, 200, { source, ...result });
      }

      // ---- DIAG_TOKEN-gated diagnostics (remote troubleshooting of the always-on box) ----
      // GET /logs?tail=200&level=warn — scrubbed ring buffer of recent [refresh]/[collector]/[api/*] lines.
      if (p === '/logs' && method === 'GET') {
        const auth = diagTokenCheck(env, diagToken(req, url));
        if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const tail = parseInt(url.searchParams.get('tail') || '200', 10);
        const level = url.searchParams.get('level');
        const logs = getLogs({ tail: Number.isFinite(tail) ? tail : 200, level });
        return send(res, 200, { count: logs.length, logs });
      }

      // POST /refresh — force a baked-data refresh NOW; returns the structured result (incl. per-bake errors).
      if (p === '/refresh' && method === 'POST') {
        const auth = diagTokenCheck(env, diagToken(req, url));
        if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await runRefreshNow();
        return send(res, 200, { triggered: 'refresh', result });
      }

      // POST /collect — force one price-collector pass NOW (self-fetches the proxy; may bill Scrydex).
      if (p === '/collect' && method === 'POST') {
        const auth = diagTokenCheck(env, diagToken(req, url));
        if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await runPass({ db, base, trigger: 'manual' });
        return send(res, 200, { triggered: 'collect', result });
      }

      // POST /backup — snapshot the money-bearing DBs NOW (VACUUM INTO + config bundle + rotate).
      if (p === '/backup' && method === 'POST') {
        const auth = diagTokenCheck(env, diagToken(req, url));
        if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const result = await runBackupNow();
        return send(res, 200, { triggered: 'backup', result });
      }

      // POST /clear-card-cache { lang, set, pcSlug? } — drop the catalog card cache for ONE set so the
      // next /api/catalog/cards load re-fetches live. Clears the set_cards DB row (checked first) AND,
      // when pcSlug is given, the PriceCharting console disk cache (else the truncated disk copy is
      // served for up to 12h). For pushing a source/parser fix past the 12h/24h caches without waiting.
      if (p === '/clear-card-cache' && method === 'POST') {
        const auth = diagTokenCheck(env, diagToken(req, url));
        if (!auth.ok) return send(res, auth.code, { error: auth.error });
        const body = (await readJson(req)) || {};
        const lang = String(body.lang || '').trim();
        const set = String(body.set || '').trim();
        const pcSlug = String(body.pcSlug || '').trim();
        if (!lang || !set) return send(res, 400, { error: 'lang and set required' });
        const rows = clearSetCardsRow(lang, set);
        const cache = pcSlug ? clearConsoleCache(pcSlug) : { removed: [] };
        console.log(`[api/status] clear-card-cache ${lang}/${set} — set_cards rows=${rows}, pc-cache files=[${cache.removed.join(', ') || 'none'}]`);
        return send(res, 200, { triggered: 'clear-card-cache', lang, set, pcSlug: pcSlug || null, set_cards_deleted: rows, pc_cache_removed: cache.removed });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[api/status] error:', e?.message || e);
      return send(res, 500, { error: 'status error', detail: String(e?.message || e) });
    }
  };
}

function settingsRouter({ db, base }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method || 'GET';

      if (p === '/' && method === 'GET') {
        const files = {};
        for (const name of Object.keys(SETTINGS)) files[name] = readSetting(name);
        // `bakes` = the registered refresh bakes (name+label) so the UI renders the checklist from the
        // registry, not a hardcoded list — a new bake shows up automatically.
        return send(res, 200, { files, bakes: availableBakes() });
      }

      const m = p.match(/^\/([a-z-]+)$/);
      if (m) {
        const name = m[1];
        const s = SETTINGS[name];
        if (!s) return send(res, 404, { error: 'unknown setting', names: Object.keys(SETTINGS) });
        if (method === 'GET') return send(res, 200, readSetting(name));
        if (method === 'PUT') {
          if (!s.editable) return send(res, 403, { error: name + ' is read-only via the API' });
          const body = await readJson(req);
          if (!body) return send(res, 400, { error: 'invalid JSON body' });
          const err = s.validate(body);
          if (err) return send(res, 400, { error: err });
          writeSettingAtomic(name, body);
          let applied = null;
          try { applied = s.apply ? s.apply(body, { db, base }) : null; }
          catch (e) { applied = 'apply failed: ' + String(e?.message || e); }
          console.log(`[api/settings] ${name} updated — ${applied || 'saved'}`);
          return send(res, 200, { saved: true, applied, content: readSetting(name).content });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[api/settings] error:', e?.message || e);
      return send(res, 500, { error: 'settings error', detail: String(e?.message || e) });
    }
  };
}

export function statusPlugin(env) {
  return {
    name: 'status',
    configureServer(server) {
      installLogCapture(env);   // start capturing console.* into the scrubbed ring buffer (GET /api/status/logs)
      startHeartbeat();         // sub-24h liveness canary — warns if a background loop is found stopped
      startBackups();           // scheduled VACUUM INTO snapshots of the money-bearing DBs (data/backups)
      const db = openDb();
      const rdb = openRepricerDb();
      const port = (server.config && server.config.server && server.config.server.port) || 5273;
      const base = `http://127.0.0.1:${port}`;
      server.middlewares.use('/api/status', statusRouter({ env, db, rdb, base }));
      server.middlewares.use('/api/settings', settingsRouter({ db, base }));
      console.log('[status] API /api/status + /api/settings · editable: ' +
        Object.entries(SETTINGS).filter(([, s]) => s.editable).map(([n]) => n).join(', ') +
        ' · diag (/logs,/refresh,/collect): ' + ((env.DIAG_TOKEN || '').trim() ? 'ENABLED' : 'off (set DIAG_TOKEN)'));
    },
  };
}
