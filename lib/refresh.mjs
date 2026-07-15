// lib/refresh.mjs — daily in-process refresh of the BAKED data catalogs.
//
// All-games pass (docs/DATA_SOURCES.md): mtg/swu/lorcana/lego + FX are LIVE-proxied per request
// and need no refresh, and so is English Pokémon (pokemontcg.io). Two baked catalogs go stale on
// a set drop and are refreshed here: data/riftbound.json (Riot's card gallery) and
// data/pokemon-intl-sets.json (the JP/CN/KO Pokémon set index, baked from TCGdex — a daily
// rebuild also picks up sets TCGdex ingests after a physical release). data/funko_pop.json is
// baked too but its upstream (kennymkchan/funko-pop-data) has been frozen since 2021, so a
// rebuild is a no-op and it's excluded by default.
//
// Runs inside the always-on dev service on a timer — mirror of lib/collector.mjs startCollector
// (boot delay + interval, HMR-guarded singleton, unref'd). GR7: a failed fetch logs a warning
// and keeps the existing catalog (buildRiftboundData writes atomically and throws pre-write).
// The single-card + bulk Riftbound tools fetch /data/riftbound.json per page load, so a refresh
// is picked up with no restart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRiftboundData } from '../scripts/build-riftbound-data.mjs';
import { buildPokemonIntlSets } from '../scripts/build-pokemon-intl-sets.mjs';
import { buildPokemonEnEarly } from '../scripts/build-pokemon-en-early.mjs';
import { prewarmCatalogCards, clearSetCardsRow } from './catalog.mjs';
import { sendMessage, telegramEnabled, telegramChatConfigured, escapeHtml } from './telegram.mjs';
import { scrubSecrets } from './logbuffer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'refresh.config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'data', 'refresh.config.example.json');
const EN_EARLY_PATH = path.join(ROOT, 'data', 'pokemon-en-early.json');
const EN_EARLY_SEED_PATH = path.join(ROOT, 'data', 'pokemon-en-early-seed.json');
const DEFAULT_CONFIG = { enabled: true, interval_hours: 24, bakes: ['riftbound', 'pokemon-intl', 'pokemon-en-early'] };

// refresh.config.json + pokemon-en-early.json are gitignored (server-owned / rebuilt in place) so pulls
// never collide with the server's own edits/rebuilds. If a deploy removed them, re-seed on boot: the
// config from its tracked .example (so the settings dashboard has a file to show), and the EN early-set
// bake from its tracked seed (manual entries — the pokemon-en-early bake then refines it with
// auto-discovery ~60s later). Both are synchronous, network-free, and best-effort — a missing config
// still falls back to DEFAULT_CONFIG, and a missing early-set file just renders as "no early sets".
function ensureConfigSeeded() {
  try { if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_EXAMPLE_PATH)) { fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH); console.log('[refresh] seeded data/refresh.config.json from example'); } }
  catch (e) { console.warn('[refresh] config seed failed —', e?.message || e); }
}
function ensureEnEarlySeeded() {
  try {
    if (fs.existsSync(EN_EARLY_PATH) || !fs.existsSync(EN_EARLY_SEED_PATH)) return;
    const seed = JSON.parse(fs.readFileSync(EN_EARLY_SEED_PATH, 'utf8'));
    const sets = (seed.sets || []).filter((s) => s && s.pcSlug).map((s) => ({
      code: s.code || '', name: s.name || '', series: s.series || '', releaseDate: s.releaseDate || '',
      pcSlug: s.pcSlug, jpEquivalent: s.jpEquivalent || '', source: 'manual', manual: true,
    }));
    fs.writeFileSync(EN_EARLY_PATH, JSON.stringify({ generatedAt: '', sets }, null, 2));
    console.log('[refresh] seeded data/pokemon-en-early.json from seed (' + sets.length + ' manual set(s))');
  } catch (e) { console.warn('[refresh] en-early seed failed —', e?.message || e); }
}

export function loadRefreshConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return DEFAULT_CONFIG; }
}

// name -> { file (the catalog it writes, for the freshness check), run() }.
const BAKES = {
  riftbound: {
    file: path.join(ROOT, 'data', 'riftbound.json'),
    run: async () => { const r = await buildRiftboundData(); return `riftbound refreshed [${r.summary}]`; },
  },
  'pokemon-intl': {
    file: path.join(ROOT, 'data', 'pokemon-intl-sets.json'),
    run: async () => { const r = await buildPokemonIntlSets(); return `pokemon-intl refreshed [${r.summary}]`; },
  },
  // EN early/pre-release sets from PriceCharting (data/pokemon-en-early.json) — surfaces a new EN set
  // in the catalog + builder weeks before pokemontcg.io catalogs it. Runs AFTER pokemon-intl (it reads
  // its enEquivalent names). Busts a graduated set's stale card cache; Telegram-alerts on a newly
  // discovered set so the owner knows they can start listing. Best-effort (GR7): a fetch failure keeps
  // the existing file. env (pokemontcg key + Telegram creds) is threaded from startDataRefresh.
  'pokemon-en-early': {
    file: path.join(ROOT, 'data', 'pokemon-en-early.json'),
    run: async (ctx) => {
      const r = await buildPokemonEnEarly({ env: (ctx && ctx.env) || {}, clearCache: clearSetCardsRow });
      if (r.newSets && r.newSets.length) await alertEarlySets((ctx && ctx.env) || {}, r.newSets).catch((e) => console.warn('[refresh] early-set alert failed —', e?.message || e));
      return `pokemon-en-early baked [${r.summary}]`;
    },
  },
  // Opt-in: pre-warm the catalog's set_cards for every PriceCharting-backed JP/CN/KO set (the seeded
  // sets whose on-demand load is slowest + rate-limited). Add 'catalog-cards' to refresh.config.json
  // `bakes` to enable; trigger immediately with POST /api/status/refresh. Writes tracker.db (set_cards).
  'catalog-cards': {
    file: path.join(ROOT, 'data', 'tracker.db'),
    run: async () => { const r = await prewarmCatalogCards(); return `catalog-cards pre-warmed [${r.summary}]`; },
  },
  // funko: upstream is frozen at 2021 — a rebuild is a no-op. Add 'funko' to refresh.config.json
  // bakes to force it (kept out of the default set on purpose).
};

// Telegram heads-up when a new pre-release EN set becomes browsable/listable (owner can start listing
// pre-release-event cards). Best-effort + silent when Telegram isn't configured (GR7).
async function alertEarlySets(env, sets) {
  if (!env || !telegramEnabled(env) || !telegramChatConfigured(env)) return;
  const lines = sets.map((s) => `🆕 <b>${escapeHtml(s.name)}</b>`
    + (s.releaseDate ? ` — EN release ${escapeHtml(s.releaseDate)}` : '')
    + (s.pcSlug ? `\n   PriceCharting: <code>${escapeHtml(s.pcSlug)}</code>` : ''));
  const text = `<b>🃏 Early Pokémon set detected</b>\nBrowsable + listable now in the catalog (pre-release, via PriceCharting — ahead of pokemontcg.io):\n\n${lines.join('\n\n')}`;
  await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text });
}

function fileAgeHours(file) { try { return (Date.now() - fs.statSync(file).mtimeMs) / 3600_000; } catch { return Infinity; } }

// Structured record of the last pass + next scheduled fire, surfaced at /api/status
// (jobs.refresh) so a silently-failing bake is diagnosable without the box's console.
let _lastRun = null;    // { started_at, finished_at, trigger, ok, results: [{name, ok, detail}] }
let _nextRunAt = null;  // ISO of the next recurring pass
let _env = {};          // remembered from startDataRefresh(env) so config-restart calls (which lack env) still alert/auth
export function getRefreshState() {
  // `enabled` lets the heartbeat tell an owner-disabled loop (a legitimate quiet state) from a
  // silently-dead one, so it doesn't false-alarm when refresh.config.json has enabled:false.
  return { running: !!globalThis.__tcgRefreshTimer, enabled: loadRefreshConfig().enabled !== false, next_run_at: _nextRunAt, last_run: _lastRun };
}

async function runRefresh(bakes, { skipIfFreshHours = 0, trigger = 'schedule' } = {}) {
  const started = new Date();
  const results = [];
  for (const name of bakes) {
    const b = BAKES[name];
    if (!b) { console.warn('[refresh] unknown bake:', name); results.push({ name, ok: false, detail: 'unknown bake' }); continue; }
    if (skipIfFreshHours > 0 && fileAgeHours(b.file) < skipIfFreshHours) {
      console.log(`[refresh] ${name} still fresh (< ${skipIfFreshHours}h) — skipped`);
      results.push({ name, ok: true, skipped: true, detail: `fresh (< ${skipIfFreshHours}h) — skipped` });
      continue;
    }
    try { const summary = await b.run({ env: _env }); console.log('[refresh] ' + summary); results.push({ name, ok: true, detail: summary }); }
    catch (e) {
      const detail = scrubSecrets(String(e?.message || e));   // surfaced on the open /api/status → scrub (GR2)
      console.warn('[refresh] ' + name + ' failed (kept existing catalog) — ' + detail);
      results.push({ name, ok: false, detail });
    }
  }
  _lastRun = { started_at: started.toISOString(), finished_at: new Date().toISOString(), trigger, ok: results.every((r) => r.ok), results };
  return _lastRun;
}

// One-shot pass for the diagnostics trigger (POST /api/status/refresh) — runs the
// configured bakes now (no freshness skip) and returns the structured result.
export async function runRefreshNow(env) {
  if (env && typeof env === 'object') _env = env;
  const cfg = loadRefreshConfig();
  const bakes = Array.isArray(cfg.bakes) && cfg.bakes.length ? cfg.bakes : DEFAULT_CONFIG.bakes;
  return runRefresh(bakes, { trigger: 'manual' });
}

// Stop-then-start (mirror of startCollector): survives Vite's in-process restarts —
// each (re)start cleanly replaces the prior timer+boot rather than early-returning and
// being torn down by the old server's close handler (which left the refresh loop dead;
// see tracker.mjs + lib/collector.mjs). globalThis is the cross-instance singleton.
export function startDataRefresh(env) {
  stopDataRefresh();
  if (env && typeof env === 'object') _env = env;   // remember for config-restart calls that pass none
  ensureConfigSeeded();     // recreate gitignored server-owned files a deploy may have removed
  ensureEnEarlySeeded();
  const cfg = loadRefreshConfig();
  if (!cfg.enabled) { console.log('[refresh] disabled (data/refresh.config.json)'); return; }
  const bakes = Array.isArray(cfg.bakes) && cfg.bakes.length ? cfg.bakes : DEFAULT_CONFIG.bakes;
  // Boot pass skips catalogs already fresher than the interval (so frequent dev restarts don't
  // re-fetch); the recurring pass always refreshes.
  const intervalMs = Math.max(1, cfg.interval_hours) * 3600_000;
  const boot = setTimeout(() => runRefresh(bakes, { skipIfFreshHours: cfg.interval_hours }).catch((e) => console.error('[refresh]', e?.message || e)), 60_000);
  if (boot.unref) boot.unref();
  const timer = setInterval(() => {
    _nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    runRefresh(bakes).catch((e) => console.error('[refresh]', e?.message || e));
  }, intervalMs);
  if (timer.unref) timer.unref();
  globalThis.__tcgRefreshTimer = timer;
  globalThis.__tcgRefreshBoot = boot;
  _nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  console.log(`[refresh] baked-data refresh every ${cfg.interval_hours}h · bakes: ${bakes.join(', ')}`);
  return timer;
}

export function stopDataRefresh() {
  if (globalThis.__tcgRefreshBoot) { clearTimeout(globalThis.__tcgRefreshBoot); globalThis.__tcgRefreshBoot = null; }
  if (globalThis.__tcgRefreshTimer) { clearInterval(globalThis.__tcgRefreshTimer); globalThis.__tcgRefreshTimer = null; }
  _nextRunAt = null;
}
