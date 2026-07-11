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
import { scrubSecrets } from './logbuffer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'refresh.config.json');
const DEFAULT_CONFIG = { enabled: true, interval_hours: 24, bakes: ['riftbound', 'pokemon-intl'] };

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
  // funko: upstream is frozen at 2021 — a rebuild is a no-op. Add 'funko' to refresh.config.json
  // bakes to force it (kept out of the default set on purpose).
};

function fileAgeHours(file) { try { return (Date.now() - fs.statSync(file).mtimeMs) / 3600_000; } catch { return Infinity; } }

// Structured record of the last pass + next scheduled fire, surfaced at /api/status
// (jobs.refresh) so a silently-failing bake is diagnosable without the box's console.
let _lastRun = null;    // { started_at, finished_at, trigger, ok, results: [{name, ok, detail}] }
let _nextRunAt = null;  // ISO of the next recurring pass
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
    try { const summary = await b.run(); console.log('[refresh] ' + summary); results.push({ name, ok: true, detail: summary }); }
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
export async function runRefreshNow() {
  const cfg = loadRefreshConfig();
  const bakes = Array.isArray(cfg.bakes) && cfg.bakes.length ? cfg.bakes : DEFAULT_CONFIG.bakes;
  return runRefresh(bakes, { trigger: 'manual' });
}

// Stop-then-start (mirror of startCollector): survives Vite's in-process restarts —
// each (re)start cleanly replaces the prior timer+boot rather than early-returning and
// being torn down by the old server's close handler (which left the refresh loop dead;
// see tracker.mjs + lib/collector.mjs). globalThis is the cross-instance singleton.
export function startDataRefresh() {
  stopDataRefresh();
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
