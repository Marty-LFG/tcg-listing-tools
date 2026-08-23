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
import { getPostsaleState, startPostsaleJobs, stopPostsaleJobs, NEEDS_PACKING_SQL, HOLD_SQL, CANCELLED_SQL, LABEL_BOUGHT_SQL } from './postsale.mjs';
import { startCollector, stopCollector, setThresholds, getCollectorState, runPass } from './collector.mjs';
import { startDataRefresh, stopDataRefresh, loadRefreshConfig, getRefreshState, runRefreshNow, availableBakes } from './refresh.mjs';
import { startBackups, stopBackups, getBackupState, runBackupNow, loadBackupConfig, IMAGE_MIRROR_DIR } from './backup.mjs';
import { STORE_DIR as PREGRADE_STORE_DIR } from './pregrade-store.mjs';
import { scanConfig } from './scan.mjs';
import { installLogCapture, getLogs, logTags, scrubSecrets } from './logbuffer.mjs';
import { startHeartbeat, getHeartbeat } from './heartbeat.mjs';
import { printConfig } from './labelprint.mjs';
import { getSealedRefreshState } from './sealed.mjs';
import { getReconcileState, getBatchJobState } from './listings.mjs';
import { getRepricerScanState, startRepricerScan, stopRepricerScan } from './repricer-scan.mjs';
// The PINNED Admin API version, imported rather than restated: Shopify falls forward silently when a
// version retires, so the number the dashboard shows must be the number the transport actually sends.
import { API_VERSION as SHOPIFY_API_VERSION } from './channels/shopify-admin.mjs';
import { telegramEnabled, telegramChatConfigured } from './telegram.mjs';
import { oauthStatus } from './ebay-oauth.mjs';
import { getNotifyState, startNotifyListener, stopNotifyListener, KNOWN_TOPICS, REACT_MODES } from './ebay-notify.mjs';
import { clearSetCardsRow } from './catalog.mjs';
import { clearConsoleCache } from './pricecharting.mjs';
import { LAYOUT_OVERRIDE_KEYS, TEXT_OVERRIDE_KEYS, BADGE_OVERRIDE_KEYS, SHOPIFY_OVERRIDE_KEYS, SHOPIFY_OG_OVERRIDE_KEYS, VARIANTS, PROFILES, resolveLayout } from './listing-image-config.mjs';
import { TARGET_IDS, DEFAULT_BAND_FRACTION, resolveTarget, resolveTargetFrame, resolveBandGeometry } from './listing-image-targets.mjs';
import { describeCompositor } from './listing-image.mjs';
import { pluginHealth } from './plugin-registry.mjs';
import { configFile, configIsCanonical } from './config-paths.mjs';
import { validateBands, normalizeBands, DEFAULT_MIN_BAND_FOR_SLAB } from './shipping-bands.mjs';
import { curateBandServices } from './postage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = (f) => path.join(ROOT, 'data', f);
// Baked catalogue data always comes from data/ (above); the owner-editable configs go through
// configFile(), which tests redirect at a temp copy so a settings PUT can't dirty the repo.
const CONFIG = (f) => configFile(f);

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
      // The MODEL is not a secret and it is the one thing that silently changes what the pre-grader
      // costs and how it scores. Empty means lib/grader.mjs is on its own DEFAULT_*_MODEL — which is
      // a different fact from "unset because the lane is off", so the two are reported separately.
      GRADER_MODEL: has('GRADER_MODEL'), model: (env.GRADER_MODEL || '').trim() || null,
    },
    printer: { configured: printer.enabled, ip: printer.ip || null, dpi: printer.dpi, lang: printer.lang },
    telegram: { TELEGRAM_BOT_TOKEN: telegramEnabled(env), TELEGRAM_CHAT_ID: telegramChatConfigured(env) },
    psa: { PSA_API_TOKEN: has('PSA_API_TOKEN'), PSA_CERT_SCRAPE: has('PSA_CERT_SCRAPE') },
    pricecharting: { enabled: (env.PRICECHARTING_ENABLED ?? 'true') !== 'false', PRICECHARTING_TOKEN: has('PRICECHARTING_TOKEN') },
    // Presence-only groups for the .env flags that had no home on the dashboard at all. Every one of
    // these is a boolean or a non-secret label — a value is never echoed (GR2).
    diag: { DIAG_TOKEN: has('DIAG_TOKEN') },
    ebay_notify: { EBAY_NOTIFY_VERIFICATION_TOKEN: has('EBAY_NOTIFY_VERIFICATION_TOKEN'), EBAY_NOTIFY_DELETION_TOKEN: has('EBAY_NOTIFY_DELETION_TOKEN') },
    // The second sales channel (lib/channels/shopify-admin.mjs). Presence only for the credential
    // pair; the store subdomains are NOT secrets and are the two facts worth reading at a glance,
    // because "connected" means nothing without knowing WHICH store answered.
    //
    // `ready` is the one derived field, and it earns its place: the client-credentials grant needs
    // the id, the secret AND a shop, and a missing shop fails DIFFERENTLY from a missing secret
    // (ShopifyNotConfigured before anything is sent, versus a token mint that 401s). Reporting the
    // AND means nobody has to read three rows and do it in their head at the moment they are already
    // debugging something else. `default_store` mirrors resolveShop's own default, which is dev on
    // purpose: reaching live takes an explicit argument.
    shopify: {
      SHOPIFY_CLIENT_ID: has('SHOPIFY_CLIENT_ID'),
      SHOPIFY_CLIENT_SECRET: has('SHOPIFY_CLIENT_SECRET'),
      SHOPIFY_SHOP: (env.SHOPIFY_SHOP || '').trim() || null,
      SHOPIFY_DEV_SHOP: (env.SHOPIFY_DEV_SHOP || '').trim() || null,
      default_store: 'dev',
      api_version: SHOPIFY_API_VERSION,
      ready: has('SHOPIFY_CLIENT_ID') && has('SHOPIFY_CLIENT_SECRET')
        && !!((env.SHOPIFY_SHOP || '').trim() || (env.SHOPIFY_DEV_SHOP || '').trim()),
    },
    upcitemdb: { enabled: (env.UPCITEMDB_ENABLED ?? 'true') !== 'false', UPCITEMDB_KEY: has('UPCITEMDB_KEY') },
    postsale: {
      ANTHROPIC_API_KEY: has('ANTHROPIC_API_KEY'), OPENAI_API_KEY: has('OPENAI_API_KEY'),
      provider: (env.POSTSALE_PROVIDER || '').trim() || null, model: (env.POSTSALE_MODEL || '').trim() || null,
    },
    // The scanner has no address and no key — every knob is a plain .env default the pre-grader
    // reads at request time. Reported here because settings.html cannot write .env and a knob the
    // owner cannot see is a knob he cannot reason about. Live capability is GET /api/scan.
    scanner: (() => {
      const s = scanConfig(env);
      return {
        SCANNER_ENABLED: s.allowed, defaultDpi: s.defaultDpi,
        region_mm: { w: s.wmm, h: s.hmm }, sheet_mm: { w: s.sheetWmm, h: s.sheetHmm },
        overridden: ['SCANNER_ENABLED', 'SCANNER_DPI_DEFAULT', 'SCANNER_REGION_W_MM', 'SCANNER_REGION_H_MM', 'SCANNER_SHEET_W_MM', 'SCANNER_SHEET_H_MM'].filter((k) => has(k)),
      };
    })(),
  };
}

// ---- pre-grade image store + its backup mirror (read-only) ----
// The scans and microscope shots in data/pregrade-images are the one image set in this repo that is
// NOT regenerable — once the card is sleeved, submitted or sold there is no second take. The mirror
// under data/backups/pregrade-images is append-only and content-addressed, so "current" is a set
// comparison on filenames, not a timestamp: a file present in the mirror is by definition correct.
function dirStats(dir) {
  const out = { files: 0, bytes: 0, names: null, absent: false };
  let names;
  try { names = fs.readdirSync(dir); } catch { out.absent = true; return out; }
  out.names = new Set();
  for (const n of names) {
    if (n.includes('.tmp')) continue;   // half-written copies (store: .tmp<pid>, mirror: .tmp-<pid>) are not content
    let st; try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    if (!st.isFile()) continue;
    out.files++; out.bytes += st.size; out.names.add(n);
  }
  return out;
}
export function pregradeImageStatus() {
  const store = dirStats(PREGRADE_STORE_DIR);
  const mirror = dirStats(IMAGE_MIRROR_DIR);
  const includeImages = loadBackupConfig().include_images !== false;
  let pending = null;
  if (store.names && mirror.names) { pending = 0; for (const n of store.names) if (!mirror.names.has(n)) pending++; }
  else if (store.names && mirror.absent) pending = store.files;
  return {
    dir: 'data/pregrade-images', files: store.files, bytes: store.bytes, absent: store.absent,
    backup: {
      include_images: includeImages,
      dir: 'data/backups/pregrade-images', files: mirror.files, bytes: mirror.bytes, absent: mirror.absent,
      pending,                                   // store files not yet in the mirror (null = unknown)
      current: pending === 0 && !store.absent,   // every original byte is mirrored
    },
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
  // Sold comps ride a SEPARATE application token whose only scope is buy.marketplace.insights, and
  // eBay's token endpoint refuses to mint it — the API request is never even sent. Without a probe
  // this was invisible: every price in the app quietly falls back to ASKING prices, which is what let
  // a card whose last sale was A$25.00 be proposed at A$44.98. A permanently red pill is the honest
  // reporting of a capability we do not hold.
  'ebay-sold': '/api/ebay/buy/marketplace_insights/v1_beta/item_sales/search?q=charizard&limit=1',
  pc: '/api/pc/lookup?name=Charizard&number=4&set=Base%20Set',
  psa: '/api/cert?company=PSA&cert=00000001',
  // Loopback round-trip against our own notification listener: proves it is bound, routing, and
  // hashing the challenge the way eBay will. Touches no upstream, so it costs nothing to run.
  // It answers 503 (never 404) when the listener is down — classify() below reads 404 as ok, so a
  // 404 would paint a dead listener green, which is the one thing this probe exists to catch.
  'ebay-notify': '/api/ebay-notify/self-test',
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
    // The one row here that reports CONTENT, not freshness. Every other catalog can only say how old
    // its file is — which is exactly why a set could be missing while everything looked green.
    // `gaps` is the number of sets that are pickable in the tools and resolve to zero cards.
    pokemon_coverage: { file: 'pokemon-coverage.json', managed: refresh.bakes?.includes('pokemon-coverage'), count: (j) => (j.sets || []).length, extra: (j) => ({ gaps: j.gaps || 0, deferred: j.deferred || 0, gap_sets: (j.sets || []).filter((r) => !r.ok).slice(0, 25).map((r) => ({ lang: r.lang, code: r.code, name: r.name, error: r.error || null })) }) },
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
      ebay_listings_active: one(`SELECT COUNT(*) c FROM ebay_listings WHERE listing_status = 'ACTIVE'`)?.c ?? null,
    },
    repricer: {
      file: REPRICER_DB_PATH, size_mb: fileSizeMb(REPRICER_DB_PATH),
      // Price checks, not listings: the repricer's own listings mirror was dropped in Phase 3 (our
    // live listings are read from ebay_seller_listings in the tracker db). This counts the scan's
    // audit trail instead, which is the number that actually says whether it is doing anything.
    price_checks: oneR(`SELECT COUNT(*) c FROM price_checks`)?.c ?? null,
      proposals_open: oneR(`SELECT COUNT(*) c FROM reprice_proposals WHERE status='pending'`)?.c ?? null,
    },
    postsale: {
      file: POSTSALE_DB_PATH, size_mb: fileSizeMb(POSTSALE_DB_PATH),
      orders: oneP(`SELECT COUNT(*) c FROM orders`)?.c ?? null,
      buyers: oneP(`SELECT COUNT(*) c FROM buyers`)?.c ?? null,
      messages_pending: oneP(`SELECT COUNT(*) c FROM postsale_messages WHERE status='pending'`)?.c ?? null,
      messages_awaiting: oneP(`SELECT COUNT(*) c FROM postsale_messages WHERE status='awaiting_approval'`)?.c ?? null,
      // One pass, four conditional sums. None of these predicates is index-servable (they OR, and they
      // COALESCE), and settings.html polls /api/status every 10s while it is open — so four separate
      // COUNT(*)s would be four full scans of `orders` every ten seconds for numbers that all come off
      // the same row. Predicates come from lib/postsale.mjs so they cannot drift from the queue itself.
      //
      // to_pack is NEEDS_PACKING_SQL rather than a raw shipped_status test: the queue is about our
      // physical work, and eBay flips an order to "sent" the moment a postage label is bought.
      // holds = needs a decision before it can be packed; unacked = a pinned alert nobody has cleared.
      ...(oneP(`SELECT
           SUM(CASE WHEN ${NEEDS_PACKING_SQL} THEN 1 ELSE 0 END) to_pack,
           SUM(CASE WHEN ${HOLD_SQL} THEN 1 ELSE 0 END) holds,
           SUM(CASE WHEN ${CANCELLED_SQL} THEN 1 ELSE 0 END) cancelled,
           SUM(CASE WHEN ${LABEL_BOUGHT_SQL} THEN 1 ELSE 0 END) label_bought,
           SUM(CASE WHEN hold_alert_sent_at IS NOT NULL AND hold_ack_at IS NULL THEN 1 ELSE 0 END) unacked_holds
         FROM orders`) ?? { to_pack: null, holds: null, cancelled: null, label_bought: null, unacked_holds: null }),
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
      // Was editable in the settings form with no schema gate at all — a blank or a negative here
      // would wave through raises the owner meant to filter out.
      if (!(g.min_uplift_aud > 0)) return 'min_uplift_aud must be positive';
      if (!(g.max_increase_pct_per_run > 0 && g.max_increase_pct_per_run <= 100)) return 'max_increase_pct_per_run must be 1–100';
      if (!['high', 'medium', 'low'].includes(g.required_confidence)) return 'required_confidence must be high/medium/low';
      // Phase 5. Boolean-or-absent only: a truthy string here would quietly switch on the
      // ReviseFixedPriceItem write path, which touches Best Offer terms on 103 live listings.
      if (g.best_offer_scaling != null && typeof g.best_offer_scaling !== 'boolean') return 'best_offer_scaling must be boolean';
      // Which competitor to undercut. A typo here would silently fall back to the cluster anchor,
      // which prices into the middle of the market instead of the front of it.
      if (g.target_anchor != null && !['cluster', 'cheapest_n'].includes(g.target_anchor)) return 'target_anchor must be cluster or cheapest_n';
      if (g.anchor_n != null && !(Number.isInteger(g.anchor_n) && g.anchor_n >= 1 && g.anchor_n <= 10)) return 'anchor_n must be a whole number 1-10';
      // A promotion pass posts one Telegram card per proposal; groups rate-limit around 20/min, and
      // nobody reads thirty cards anyway.
      if (g.max_cards_per_run != null && !(Number.isInteger(g.max_cards_per_run) && g.max_cards_per_run >= 1 && g.max_cards_per_run <= 20)) return 'max_cards_per_run must be a whole number 1-20';
      // The window in which we take the cheapest slot instead of the Nth. Both are floors on the same
      // decision, so a negative or absurd value here quietly changes which listing gets undercut.
      if (g.beat_cheapest_within_aud != null && !(g.beat_cheapest_within_aud >= 0 && g.beat_cheapest_within_aud <= 50)) return 'beat_cheapest_within_aud must be 0-50';
      if (g.beat_cheapest_within_pct != null && !(g.beat_cheapest_within_pct >= 0 && g.beat_cheapest_within_pct <= 100)) return 'beat_cheapest_within_pct must be 0-100';
      // Turning corroboration off means raises rest on asking prices alone, which is the exact
      // condition that produced a A$44.98 proposal on a card that last sold for A$25.00.
      if (g.corroboration != null && !['require', 'advisory', 'off'].includes(g.corroboration)) return 'corroboration must be require/advisory/off';
      if (g.corroboration_tolerance_pct != null && !(g.corroboration_tolerance_pct >= 0 && g.corroboration_tolerance_pct <= 200)) return 'corroboration_tolerance_pct must be 0-200';
      if (typeof c.scan_enabled !== 'boolean') return 'scan_enabled must be boolean';
      if (!(c.cadence_hours >= 1)) return 'cadence_hours must be ≥ 1';
      return null;
    },
    // The scan timer reads scan_enabled + cadence_hours when it ARMS, so a save has to re-arm it —
    // otherwise toggling scanning off in settings leaves the loop running on the old cadence. The
    // loop remembers its env/db/base, so it can be restarted without server context here.
    apply() {
      stopRepricerScan();
      startRepricerScan();
      return getRepricerScanState().running ? 'repricer scan restarted' : 'repricer scan stopped (scan_enabled is off)';
    },
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
      // additive keys: an existing config predates them, so only validate what is present
      if ('include_images' in c && typeof c.include_images !== 'boolean') return 'include_images must be boolean';
      return null;
    },
    apply() {   // the backup loop reads the file at start → restart it
      stopBackups();
      startBackups();
      return 'backup loop restarted';
    },
  },
  'ebay-notify': {
    file: 'ebay-notify.config.json', editable: true,
    validate(c) {
      if (!c || typeof c !== 'object') return 'not an object';
      for (const k of ['enabled', 'alerts']) if (typeof c[k] !== 'boolean') return k + ' must be boolean';
      // THE ISOLATION RULE. This listener is the one thing in the suite reachable from the internet
      // (through the tunnel), and it is safe only because it is bound to loopback and serves two
      // paths. Binding it to the LAN would put an unauthenticated POST endpoint on the network; using
      // the Vite port would hand the tunnel the entire dev server. Both are one typo away, so neither
      // is allowed to be saved.
      if (!['127.0.0.1', '::1'].includes(c.listen_host)) {
        return 'listen_host must be 127.0.0.1 or ::1 — the tunnel is the only ingress, never bind this to the LAN';
      }
      if (!(Number.isInteger(c.listen_port) && c.listen_port >= 1024 && c.listen_port <= 65535)) return 'listen_port must be an integer 1024–65535';
      if (c.listen_port === 5273) return 'listen_port must NOT be the Vite port — a separate port is what keeps /api/* unreachable from the tunnel';
      for (const k of ['path', 'account_deletion_path']) {
        if (typeof c[k] !== 'string' || !c[k].startsWith('/') || c[k].includes('..')) return k + ' must be an absolute path with no ".."';
        if (/^\/api(\/|$)/.test(c[k])) return k + ' must not start with /api';
      }
      if (c.path === c.account_deletion_path) return 'path and account_deletion_path must differ';
      // The public endpoint is hashed VERBATIM into the challenge response, so a mismatch here fails
      // eBay's validation with no diagnostic on either side. Checked only when enabled, so the config
      // can be filled in over two saves.
      if (c.enabled) {
        let u; try { u = new URL(c.public_endpoint); } catch { return 'public_endpoint must be a full https URL when enabled'; }
        if (u.protocol !== 'https:') return 'public_endpoint must be https (eBay rejects http)';
        if (String(c.public_endpoint).endsWith('/')) return 'public_endpoint must not end with a trailing slash — it is hashed verbatim in the challenge';
        if (u.pathname !== c.path) return `public_endpoint path (${u.pathname}) must equal path (${c.path}) — a mismatch fails the challenge handshake with no useful error`;
      }
      if (!c.destination_name || typeof c.destination_name !== 'string' || c.destination_name.length > 100) return 'destination_name must be a non-empty string ≤100 chars';
      // Required by eBay before it will answer the subscription endpoints at all (195003), so it is
      // checked at the same time as the endpoint rather than left to fail during a reconcile.
      if (c.alert_email != null && typeof c.alert_email !== 'string') return 'alert_email must be a string';
      if (c.enabled && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(c.alert_email || ''))) {
        return 'alert_email must be a valid address when enabled — eBay refuses subscriptions without an app config (195003) and emails this address when it marks the destination down';
      }
      if (!Array.isArray(c.topics) || !c.topics.length) return 'topics must be a non-empty array';
      // Derived from the module's own map, so the allowlist can never drift from what is handled —
      // same trick as refresh.bakes validating against availableBakes().
      for (const t of c.topics) if (!KNOWN_TOPICS.includes(t)) return `unknown topic '${t}' (valid: ${KNOWN_TOPICS.join(', ')})`;
      if (!(Number.isInteger(c.retain_days) && c.retain_days >= 1 && c.retain_days <= 365)) return 'retain_days must be an integer 1–365';
      // What a verified notification is allowed to DO. This is a safety boundary, not a preference:
      // 'observe' reads the order back from eBay and writes down what it found, ingesting nothing, so
      // the existing poll stays the only thing that adopts orders, messages buyers or moves stock;
      // 'poll' lets a notification run that poll early, which is the whole pipeline, minutes sooner.
      // An unrecognised value must be refused rather than treated as "not off" — the failure mode of
      // a typo here is a mode that silently does more than the person saving it believed.
      const rk = c.react;
      if (rk != null) {
        if (typeof rk !== 'object' || Array.isArray(rk)) return 'react must be an object';
        if (rk.mode != null && !REACT_MODES.includes(rk.mode)) return `react.mode must be one of ${REACT_MODES.join(', ')}`;
        if (rk.quiet_ms != null && !(rk.quiet_ms >= 250 && rk.quiet_ms <= 60_000)) return 'react.quiet_ms must be 250–60000';
        if (rk.max_wait_ms != null && !(rk.max_wait_ms >= (rk.quiet_ms ?? 250) && rk.max_wait_ms <= 600_000)) return 'react.max_wait_ms must be ≥ quiet_ms and ≤ 600000';
        if (rk.min_gap_ms != null && !(rk.min_gap_ms >= 0 && rk.min_gap_ms <= 60_000)) return 'react.min_gap_ms must be 0–60000';
      }
      return null;
    },
    apply() {   // the listener reads the file when it binds → restart it (env is remembered)
      stopNotifyListener();
      startNotifyListener();
      const s = getNotifyState();
      return s.listening ? `notification listener on ${s.host}:${s.port}${s.path}`
        : (s.bind_error ? 'listener did NOT start — ' + s.bind_error : 'notification listener stopped');
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
      if (c.messaging != null && typeof c.messaging !== 'boolean') return 'messaging must be boolean';   // optional (default true)
      for (const k of ['invite_offers', 'alerts', 'labels', 'listings_sync', 'fees', 'cases']) if (typeof c[k] !== 'boolean') return k + ' must be boolean';
      // Optional (ensureConfigSeeded backfills them), but validated when present — a string here would
      // pass silently and then read as "not false", which is the wrong way for a safety switch to fail.
      for (const k of ['hold_alerts', 'hold_pin', 'cancel_restock', 'same_day_dispatch']) if (c[k] != null && typeof c[k] !== 'boolean') return k + ' must be boolean';
      // dispatchDay() already fails closed on a cut-off it can't read, so a typo is safe — but a
      // setting that silently does nothing is a bad way to fail, so it is caught at save time.
      if (c.same_day_cutoff != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.same_day_cutoff))) return 'same_day_cutoff must be 24h HH:MM (e.g. 12:00)';
      if (c.same_day_text != null && typeof c.same_day_text !== 'string') return 'same_day_text must be a string';
      if (c.different_day_wording != null && !['weekday', 'next business day'].includes(c.different_day_wording)) return "different_day_wording must be 'weekday' or 'next business day'";
      // Deal requests. Optional (loadConfig merges the defaults), but a string in `enabled` would read
      // as "not false" and silently switch on a queue nobody meant to switch on.
      const dl = c.deals;
      if (dl != null) {
        if (typeof dl !== 'object') return 'deals must be an object';
        for (const k of ['enabled', 'detect_from_messages']) if (dl[k] != null && typeof dl[k] !== 'boolean') return 'deals.' + k + ' must be boolean';
        if (dl.expire_hours != null && !(Number.isInteger(dl.expire_hours) && dl.expire_hours >= 1 && dl.expire_hours <= 720)) {
          return 'deals.expire_hours must be an integer 1–720';
        }
      }
      // 0 disables the by-id backstop. Unvalidated, a typo would coerce to NaN → 0 and switch off the
      // one thing that guarantees a missed state change is eventually noticed, with nothing to show it.
      if (c.sweep_interval_min != null && !(Number.isInteger(c.sweep_interval_min) && c.sweep_interval_min >= 0 && c.sweep_interval_min <= 1440)) {
        return 'sweep_interval_min must be an integer 0–1440 (0 = off)';
      }
      if (!c.quiet_hours || typeof c.quiet_hours !== 'object' || typeof c.quiet_hours.enabled !== 'boolean') return 'quiet_hours must be an object with a boolean enabled';
      if (!Array.isArray(c.holidays)) return 'holidays must be an array';
      if (c.postage != null) {
        const p = c.postage;
        if (typeof p !== 'object' || Array.isArray(p)) return 'postage must be an object';
        for (const k of ['dispatch_message', 'delivered_message']) {
          if (p[k] != null && (typeof p[k] !== 'object' || Array.isArray(p[k]))) return `postage.${k} must be an object`;
          if (p[k] && p[k].enabled != null && typeof p[k].enabled !== 'boolean') return `postage.${k}.enabled must be boolean`;
        }
        const dm = p.dispatch_message || {};
        if (dm.include_link != null && typeof dm.include_link !== 'boolean') return 'postage.dispatch_message.include_link must be boolean';
        if (dm.delay_min != null && !(dm.delay_min >= 0 && dm.delay_min <= 1440)) return 'postage.dispatch_message.delay_min must be 0–1440 minutes';
        if ((p.delivered_message || {}).force_approve != null && typeof p.delivered_message.force_approve !== 'boolean') return 'postage.delivered_message.force_approve must be boolean';
        // The URL templates are how a broken eBay deep link gets fixed without a deploy, so they are
        // validated for shape (a http(s) URL with the placeholder intact) rather than left free-form.
        for (const [k, ph] of [['seller_hub_order_url', '{orderId}'], ['tracking_url', '{tracking}']]) {
          if (p[k] == null || p[k] === '') continue;
          if (typeof p[k] !== 'string' || !/^https?:\/\//i.test(p[k])) return `postage.${k} must be an http(s) URL`;
          if (!p[k].includes(ph)) return `postage.${k} must contain ${ph}`;
        }
        if (p.seller_hub_fallback_url != null && p.seller_hub_fallback_url !== '' && !/^https?:\/\//i.test(p.seller_hub_fallback_url)) return 'postage.seller_hub_fallback_url must be an http(s) URL';
        if (p.services != null) {
          if (typeof p.services !== 'object' || Array.isArray(p.services)) return 'postage.services must be an object keyed by eBay shipping-service code';
          for (const [code, v] of Object.entries(p.services)) {
            if (!v || typeof v !== 'object' || Array.isArray(v)) return `postage.services["${code}"] must be an object`;
            if (v.tier != null && !['standard', 'paid', 'tracked', 'express'].includes(v.tier)) return `postage.services["${code}"].tier must be standard|paid|tracked|express`;
            if (v.tracked != null && typeof v.tracked !== 'boolean') return `postage.services["${code}"].tracked must be boolean`;
            for (const s of ['label', 'note']) if (v[s] != null && typeof v[s] !== 'string') return `postage.services["${code}"].${s} must be a string`;
          }
        }
      }
      return null;
    },
    apply() {   // the postsale timers read the file at start → restart them (env/db remembered)
      stopPostsaleJobs();
      startPostsaleJobs();
      return 'postsale jobs restarted';
    },
  },
  'ebay-listing': {
    file: 'ebay-listing.config.json', editable: true,
    // The band table is the one setting the runtime materialises rather than storing: a config written
    // before postage went banded has no `bands` key at all, and loadConfig() fills it in. The settings
    // form must see that same filled-in table, complete with each band's `id` — the form has no id
    // field (ids are internal), so it can only round-trip one it was given.
    normalize(c) {
      if (!c || typeof c !== 'object') return c;
      const s = c.shipping || {};
      // payments is materialised for the same reason as the band table: the form renders the FILE, not
      // loadConfig()'s merged view, so an absent key would draw the immediate-payment toggle OFF while
      // the runtime default has it ON — the form would be showing the opposite of the truth.
      const pay = { immediatePay: (c.payments || {}).immediatePay !== false };
      return { ...c, payments: pay, shipping: { ...s, minBandForSlab: Number.isInteger(s.minBandForSlab) ? s.minBandForSlab : DEFAULT_MIN_BAND_FOR_SLAB, bands: curateBandServices(normalizeBands(s.bands)) } };
    },
    validate(c) {
      if (!c || typeof c !== 'object') return 'not an object';
      if (c.marketplaceId !== 'EBAY_AU') return 'marketplaceId must be EBAY_AU';
      if (!c.categoryTreeId) return 'categoryTreeId required';
      if (c.listingDuration !== 'GTC') return 'listingDuration must be GTC (fixed-price)';
      if (!(Number.isInteger(c.handlingDays) && c.handlingDays >= 0 && c.handlingDays <= 3)) return 'handlingDays must be 0–3 (Authenticity-Guarantee safe)';
      if (!c.location || typeof c.location !== 'object' || !c.location.merchantLocationKey) return 'location.merchantLocationKey required';
      // No policyNames.fulfillment — each postage BAND names its own policy.
      if (!c.policyNames || !c.policyNames.payment || !c.policyNames.return) return 'policyNames.{payment,return} required';
      const pay = c.payments || {};
      if (pay.immediatePay !== undefined && typeof pay.immediatePay !== 'boolean') return 'payments.immediatePay must be boolean';
      const r = c.returns || {};
      if (typeof r.accepted !== 'boolean') return 'returns.accepted must be boolean';
      if (r.accepted && ![30, 60].includes(r.days)) return 'returns.days must be 30 or 60 (eBay AU rule)';
      // Delegated to the ONE band validator so this and accountReadyGuard can never disagree about
      // what a legal band table is. It deliberately does not require a policy per band — the owner has
      // to be able to save the bounds before picking the eBay policies. accountReadyGuard is what
      // refuses to PUBLISH with a band left unassigned.
      const s = c.shipping || {};
      const minSlab = s.minBandForSlab;
      if (!(Number.isInteger(minSlab) && minSlab >= 0)) return 'shipping.minBandForSlab must be a whole number (0 = graded slabs follow their price band)';
      const bandErr = validateBands(s.bands);
      if (bandErr) return 'shipping.bands: ' + bandErr;
      if (minSlab >= s.bands.length) return `shipping.minBandForSlab is ${minSlab} but there are only ${s.bands.length} bands`;
      const bo = c.bestOffer || {};
      if (typeof bo.enabled !== 'boolean') return 'bestOffer.enabled must be boolean';
      // REFUSED, not ignored. The publish path no longer emits Best Offer terms at all — the shop
      // answers a haggle with an invoice — so a `true` here would configure nothing and say nothing
      // about it, which is the exact failure this codebase keeps finding: a flag that reads as a
      // capability and is wired to no capability. Turning offers back on is a code change now, and
      // this refusal is where somebody is told that rather than discovering it on a live listing.
      if (bo.enabled === true) {
        return 'bestOffer.enabled must be false — this tool no longer publishes Best Offer terms. '
          + 'Buyers who want a keener price ask for a total instead (Deals, in the post-sale dashboard).';
      }
      if (!(bo.autoAcceptPct > 0 && bo.autoAcceptPct <= 100)) return 'bestOffer.autoAcceptPct must be 1–100';
      if (!(bo.autoDeclinePct >= 0 && bo.autoDeclinePct <= 100)) return 'bestOffer.autoDeclinePct must be 0–100';
      // Kept because the REPRICER still speaks in these percentages when it scales a floor on one of
      // the hand-made listings that does have Best Offer on. Each is separately legal, so only the pair
      // can be wrong: eBay rejects an auto-accept below the auto-decline (25002).
      if (bo.autoAcceptPct < bo.autoDeclinePct) return 'bestOffer.autoAcceptPct must be ≥ autoDeclinePct — eBay rejects an auto-accept below the auto-decline';
      return null;
    },
    apply() { return 'live-read — applies on next listing build/publish'; },
  },
  'listing-image': {
    file: 'listing-image.config.json', editable: true,
    validate(c) {
      if (!c || typeof c !== 'object') return 'not an object';
      if (typeof c.enabled !== 'boolean') return 'enabled must be boolean';
      const a = c.applyTo || {};
      if (typeof a.catalogArt !== 'boolean' || typeof a.ownerPhotos !== 'boolean') return 'applyTo.{catalogArt,ownerPhotos} must be booleans';
      // Absent is fine (loadConfig defaults it to 'inverted'); a present value must be one of the
      // two real modes so a typo cannot silently become a third rendering state.
      if (c.promoStar != null && !['inverted', 'normal'].includes(c.promoStar)) return "promoStar must be 'inverted' or 'normal'";
      if (!c.font || !c.font.family || !c.font.file) return 'font.family and font.file are both required';
      for (const [k, keys] of [['layoutOverrides', LAYOUT_OVERRIDE_KEYS], ['textOverrides', TEXT_OVERRIDE_KEYS], ['badgeOverrides', BADGE_OVERRIDE_KEYS]]) {
        const o = c[k];
        if (o == null) continue;
        if (typeof o !== 'object' || Array.isArray(o)) return `${k} must be an object`;
        for (const key of Object.keys(o)) if (!keys.includes(key)) return `${k}.${key} is not an overridable key (allowed: ${keys.join(', ')})`;
      }
      for (const [token, v] of Object.entries(c.variantOverrides || {})) {
        if (!VARIANTS.includes(v)) return `variantOverrides.${token} points at unknown rail art '${v}' (have: ${VARIANTS.join(', ')})`;
      }
      // The real gate: geometry that cannot close would emit a broken image on every listing, and
      // resolveLayout is the same validator the compositor runs, so a save can never pass something
      // a compose would then reject.
      try { resolveLayout(c, {}); } catch (e) { return String(e?.message || e); }
      for (const productType of Object.keys(PROFILES)) {
        try { resolveLayout(c, { productType }); } catch (e) { return `productType '${productType}': ${e?.message || e}`; }
      }
      // The Shopify frames. Same discipline: whitelist the keys, then run the REAL resolvers, so a
      // band thickness that leaves no room for the card is refused here rather than discovered on a
      // rendered image.
      const s = c.shopify;
      if (s != null) {
        if (typeof s !== 'object' || Array.isArray(s)) return 'shopify must be an object';
        const allowed = [...SHOPIFY_OVERRIDE_KEYS, 'og'];
        for (const k of Object.keys(s)) if (!allowed.includes(k)) return `shopify.${k} is not an overridable key (allowed: ${allowed.join(', ')})`;
        if (s.enabled != null && typeof s.enabled !== 'boolean') return 'shopify.enabled must be boolean';
        if (s.quality != null && !(Number.isInteger(s.quality) && s.quality >= 1 && s.quality <= 100)) return 'shopify.quality must be an integer 1–100';
        if (s.aspectWarnPct != null && !(s.aspectWarnPct > 0 && s.aspectWarnPct <= 50)) return 'shopify.aspectWarnPct must be >0 and ≤50';
        if (s.og != null) {
          if (typeof s.og !== 'object' || Array.isArray(s.og)) return 'shopify.og must be an object';
          for (const k of Object.keys(s.og)) if (!SHOPIFY_OG_OVERRIDE_KEYS.includes(k)) return `shopify.og.${k} is not an overridable key (allowed: ${SHOPIFY_OG_OVERRIDE_KEYS.join(', ')})`;
        }
      }
      const fraction = (s && s.bandFraction != null) ? s.bandFraction : DEFAULT_BAND_FRACTION;
      for (const id of TARGET_IDS) {
        let target;
        try { target = resolveTarget(id); } catch (e) { return `target '${id}': ${e?.message || e}`; }
        if (target.rails !== 'horizontal') continue;
        try { resolveBandGeometry(resolveTargetFrame(target, resolveLayout(c, {})), fraction); }
        catch (e) { return `target '${id}': ${e?.message || e}`; }
      }
      return null;
    },
    apply() { return 'live-read — applies on the next compose'; },
  },
  // The pre-grader's economic model. The SAME FILE is also registered read-only as `grading` below,
  // and that is deliberate: `grading` stays the never-writable view (an API PUT on it is still a
  // 403), while this entry is the curated editor for the half of the file that goes stale on a
  // schedule nobody controls — fees, availability, turnarounds, marketFactor, fx, submissionCosts.
  //
  // CURATED, NOT FULL. The tolerances are the model's physics: centering bands, pillarWeights,
  // gradeGates and tenTiers decide what a grade IS, and a wrong one is wrong silently on every
  // future report. They are VALIDATED here (so a hand-edit that breaks them can never be saved
  // through this route) but the form renders them read-only — the settings page edits prices and
  // availability flags, which are facts about the world, not the model.
  //
  // Whole-file semantics: the router validates BEFORE writeSettingAtomic, and the write is a
  // tmp+rename, so a refused edit leaves the file byte-identical and a half-applied edit is
  // impossible. Every invariant the config tests assert (roster of five, pillar weights summing to
  // 1, centering bands ordered best to worst) is re-asserted here, because this is now a second way
  // into that file and the two must not be able to disagree.
  'grading-economics': {
    file: 'grading.config.json', editable: true,
    validate(c) {
      const ROSTER = ['BGS', 'CGC', 'PCG', 'PSA', 'TAG'];
      const PILLARS = ['centering', 'corners', 'edges', 'surface'];
      const num = (v) => typeof v === 'number' && Number.isFinite(v);
      const inRange = (v, lo, hi) => num(v) && v >= lo && v <= hi;
      if (!c || typeof c !== 'object' || Array.isArray(c)) return 'not an object';

      // ---- the company roster (test/data/configs.test.mjs pins this exact set) ----
      if (!c.companies || typeof c.companies !== 'object' || Array.isArray(c.companies)) return 'companies must be an object';
      const got = Object.keys(c.companies).sort();
      if (got.join(',') !== ROSTER.join(',')) {
        return `companies must be exactly ${ROSTER.join(', ')} — got ${got.join(', ') || '(none)'}. `
          + 'Adding or removing a grader is a code change (grade-rules.js, the slab registry and the report all key off this roster).';
      }
      for (const code of ROSTER) {
        const co = c.companies[code];
        if (!co || typeof co !== 'object') return `companies.${code} must be an object`;
        const w = co.pillarWeights;
        if (!w || typeof w !== 'object' || Array.isArray(w)) return `companies.${code}.pillarWeights must be an object`;
        const extra = Object.keys(w).filter((k) => !PILLARS.includes(k));
        if (extra.length) return `companies.${code}.pillarWeights has unknown pillar(s) ${extra.join(', ')} (allowed: ${PILLARS.join(', ')})`;
        let sum = 0;
        for (const p of PILLARS) {
          if (!inRange(w[p], 0, 1)) return `companies.${code}.pillarWeights.${p} must be a number 0–1`;
          sum += w[p];
        }
        // The weighted pillar score IS the predicted grade, so weights that do not sum to 1 do not
        // shift the answer, they rescale it — every prediction moves and nothing says why.
        if (Math.abs(sum - 1) > 1e-9) return `companies.${code}.pillarWeights sum to ${Math.round(sum * 1e6) / 1e6} — they must sum to exactly 1`;
        // What a slab of this company realises against the same PSA grade. 0 would zero out the
        // company's entire economics; above 2 is not a resale factor, it is a typo.
        if (!(num(co.marketFactor) && co.marketFactor > 0 && co.marketFactor <= 2)) {
          return `companies.${code}.marketFactor must be a number above 0 and at most 2 (PSA is 1.0 by definition)`;
        }
      }

      // ---- centering bands: best to worst, and never tighter as the grade drops ----
      if (!c.centering || typeof c.centering !== 'object' || Array.isArray(c.centering)) return 'centering must be an object';
      for (const k of Object.keys(c.centering)) {
        if (k.startsWith('_')) continue;
        if (!ROSTER.includes(k)) return `centering.${k} is not one of ${ROSTER.join(', ')}`;
      }
      for (const code of ROSTER) {
        const bands = c.centering[code];
        if (!Array.isArray(bands) || !bands.length) return `centering.${code} must be a non-empty array of bands`;
        let prev = null;
        for (const [i, b] of bands.entries()) {
          const at = `centering.${code} band ${i + 1}`;
          if (!b || typeof b !== 'object') return `${at} must be an object`;
          if (!num(b.grade)) return `${at} needs a numeric grade`;
          if (!inRange(b.front, 50, 100)) return `${at} (grade ${b.grade}) front must be a percentage 50–100 (the larger side of the worst axis)`;
          if (b.back != null && !inRange(b.back, 50, 100)) return `${at} (grade ${b.grade}) back must be a percentage 50–100, or omitted to leave the back unconstrained`;
          if (prev) {
            if (!(b.grade < prev.grade)) return `${at} is grade ${b.grade} after grade ${prev.grade} — bands must be ordered best to worst`;
            if (b.front < prev.front) return `${at} (grade ${b.grade}) allows LESS centering error (${b.front}) than the better grade ${prev.grade} above it (${prev.front}) — a worse grade can never be the tighter band`;
            if (b.back != null && prev.back != null && b.back < prev.back) return `${at} (grade ${b.grade}) allows a tighter BACK (${b.back}) than the better grade ${prev.grade} above it (${prev.back})`;
          }
          prev = b;
        }
      }

      // ---- the money block ----
      if (c.fx != null) {
        if (typeof c.fx !== 'object' || Array.isArray(c.fx)) return 'fx must be an object';
        if (!(num(c.fx.audUsd) && c.fx.audUsd > 0 && c.fx.audUsd < 10)) return 'fx.audUsd must be a positive number (AUD × audUsd = USD, so ~0.6–0.8)';
        if (c.fx.asOf != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.fx.asOf))) return 'fx.asOf must be a date as YYYY-MM-DD — it is what tells the reader how stale the rate is';
      }
      if (c.submissionCosts != null) {
        const s = c.submissionCosts;
        if (typeof s !== 'object' || Array.isArray(s)) return 'submissionCosts must be an object';
        if (!inRange(s.shippingUsd, 0, 100000)) return 'submissionCosts.shippingUsd must be a number ≥ 0 (per BATCH, not per card)';
        if (!inRange(s.insurancePct, 0, 100)) return 'submissionCosts.insurancePct must be a percentage 0–100';
        if (!inRange(s.returnShippingUsd, 0, 100000)) return 'submissionCosts.returnShippingUsd must be a number ≥ 0 (per BATCH)';
      }
      if (!inRange(c.marketplaceFeePct, 0, 100)) return 'marketplaceFeePct must be a percentage 0–100';

      // ---- fees: what a tier costs, how long it takes, and whether it can be bought at all ----
      if (!c.fees || typeof c.fees !== 'object' || Array.isArray(c.fees)) return 'fees must be an object';
      for (const k of Object.keys(c.fees)) {
        if (k.startsWith('_')) continue;
        if (!ROSTER.includes(k)) return `fees.${k} is not one of ${ROSTER.join(', ')}`;
      }
      for (const code of ROSTER) {
        const tiers = c.fees[code];
        if (!Array.isArray(tiers) || !tiers.length) return `fees.${code} must be a non-empty array of tiers`;
        for (const [i, t] of tiers.entries()) {
          const at = `fees.${code}[${i}]`;
          if (!t || typeof t !== 'object') return `${at} must be an object`;
          if (!t.tier || typeof t.tier !== 'string') return `${at}.tier must be a non-empty name`;
          const nm = `fees.${code} "${t.tier}"`;
          if (!(num(t.price) && t.price > 0)) return `${nm}: price must be a positive number (USD per card)`;
          if (!(num(t.turnaroundDays) && t.turnaroundDays > 0 && t.turnaroundDays <= 1000)) return `${nm}: turnaroundDays must be a positive number of BUSINESS days (≤1000)`;
          // available is the flag the whole 'can I actually buy this?' story hangs on — a string
          // here reads as "not false" and quotes a price nobody can pay.
          if (t.available != null && typeof t.available !== 'boolean') return `${nm}: available must be true or false`;
          if (t.minCards != null && !(Number.isInteger(t.minCards) && t.minCards >= 1)) return `${nm}: minCards must be a whole number ≥ 1 (or omitted when the tier has no minimum)`;
          for (const k of ['maxValueUsd', 'maxValueAud', 'priceAud']) {
            if (t[k] == null) continue;   // null means "not published", which is not the same as unlimited
            if (!(num(t[k]) && t[k] > 0)) return `${nm}: ${k} must be a positive number, or null when the company does not publish one`;
          }
          const r = t.turnaroundDaysRange;
          if (r != null) {
            if (!Array.isArray(r) || r.length !== 2 || !num(r[0]) || !num(r[1])) return `${nm}: turnaroundDaysRange must be [low, high]`;
            if (!(r[0] > 0 && r[0] <= r[1])) return `${nm}: turnaroundDaysRange must be [low, high] with low ≤ high`;
          }
          if (t.turnaroundDaysObserved != null && !(num(t.turnaroundDaysObserved) && t.turnaroundDaysObserved > 0)) {
            return `${nm}: turnaroundDaysObserved must be a positive number of days, or omitted when nothing was sourced`;
          }
        }
      }
      if (c.disclaimers != null) {
        if (!Array.isArray(c.disclaimers)) return 'disclaimers must be an array of strings';
        for (const d of c.disclaimers) if (typeof d !== 'string') return 'every disclaimer must be a string';
      }
      return null;
    },
    // card-grader.html and inventory.html fetch /data/grading.config.json per page load, and
    // lib/inventory.mjs reads it per request — there is no loop holding a parsed copy to restart.
    apply() { return 'live-read — applies on the next pre-grade report'; },
  },
  // read-only in the UI (still owner-editable on disk)
  collectr: { file: 'collectr.config.json', editable: false },
  grading: { file: 'grading.config.json', editable: false },
  'grading-companies': { file: 'grading-companies.json', editable: false },
};

// What the UI prints as the file's home. Normally 'data/x.config.json'; if the configs have been
// redirected (tests) it says so, rather than naming a file the server is not actually reading.
const settingLabel = (f) => (configIsCanonical ? 'data/' + f : CONFIG(f));

function readSetting(name) {
  const s = SETTINGS[name];
  if (!s) return null;
  try {
    let content = JSON.parse(fs.readFileSync(CONFIG(s.file), 'utf8'));
    // A setting whose defaults the RUNTIME fills in has to hand the form the same filled-in shape,
    // or the form edits a hole. The save builds its payload from this content and overlays the
    // fields it owns, so anything absent here is absent from the PUT — which is how a band table
    // rendered from a config predating bands saved back three bands with no `id` and was refused.
    if (s.normalize) content = s.normalize(content);
    return { name, editable: s.editable, content, file: settingLabel(s.file) };
  } catch (e) { return { name, editable: s.editable, content: null, file: settingLabel(s.file), error: String(e?.message || e) }; }
}

function writeSettingAtomic(name, content) {
  const s = SETTINGS[name];
  const file = CONFIG(s.file);
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
          // Which routes THIS PROCESS owns, and whether the sources on disk have moved past it.
          // `stale: true` means restart the dev server — a pulled commit does nothing until
          // configureServer runs again, and every other signal (git commit, loaded config) reads
          // current while the routes are still missing.
          plugins: pluginHealth(),
          keys: keyPresence(env),
          sources,
          data: catalogStatus(),
          jobs: { refresh: getRefreshState(), collector: getCollectorState(), heartbeat: getHeartbeat(), backup: getBackupState(), postsale: getPostsaleState(), sealed_value: getSealedRefreshState(), listing_reconcile: getReconcileState(), listing_batch: getBatchJobState(), repricer_scan: getRepricerScanState(), ebay_notify: getNotifyState() },
          dbs: dbStats(db, rdb),
          subsystems: {
            printer: printConfig(env),
            telegram: { enabled: telegramEnabled(env), chat_configured: telegramChatConfigured(env) },
            ebay_oauth: (() => { try { return oauthStatus(env); } catch (e) { return { error: String(e?.message || e) }; } })(),
            collector: { cadence_hours: (() => { try { return JSON.parse(fs.readFileSync(CONFIG('tracker.config.json'), 'utf8')).cadence_hours; } catch { return null; } })() },
            // Branded listing images. Every failure mode here is silent at runtime — no sharp
            // binary, missing rail art, a font family that does not match the TTF — so the
            // dashboard has to be able to say which one it is.
            listing_image: await describeCompositor().catch((e) => ({ error: String(e?.message || e) })),
            // The pre-grader's unregenerable image store and whether the backup mirror has caught
            // up with it. Read-only, two readdirs of a small directory.
            pregrade_images: (() => { try { return pregradeImageStatus(); } catch (e) { return { error: String(e?.message || e) }; } })(),
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
        const tag = url.searchParams.get('tag');
        const logs = getLogs({ tail: Number.isFinite(tail) ? tail : 200, level, tag });
        // `tags` is the index: it names every subsystem in the buffer with a count, so a reader can
        // see at a glance that (say) api/ebay holds 200 lines and postsale holds 4, then ask for the
        // four directly instead of paging past the two hundred.
        return send(res, 200, { count: logs.length, tags: logTags(), logs });
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
