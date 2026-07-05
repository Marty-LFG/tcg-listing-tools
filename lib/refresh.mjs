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

async function runRefresh(bakes, { skipIfFreshHours = 0 } = {}) {
  for (const name of bakes) {
    const b = BAKES[name];
    if (!b) { console.warn('[refresh] unknown bake:', name); continue; }
    if (skipIfFreshHours > 0 && fileAgeHours(b.file) < skipIfFreshHours) { console.log(`[refresh] ${name} still fresh (< ${skipIfFreshHours}h) — skipped`); continue; }
    try { console.log('[refresh] ' + (await b.run())); }
    catch (e) { console.warn('[refresh] ' + name + ' failed (kept existing catalog) — ' + (e?.message || e)); }
  }
}

// Singleton + HMR guard so a dev reload never stacks intervals (mirror of startCollector).
export function startDataRefresh() {
  if (globalThis.__tcgRefreshTimer) return;
  const cfg = loadRefreshConfig();
  if (!cfg.enabled) { console.log('[refresh] disabled (data/refresh.config.json)'); return; }
  const bakes = Array.isArray(cfg.bakes) && cfg.bakes.length ? cfg.bakes : DEFAULT_CONFIG.bakes;
  // Boot pass skips catalogs already fresher than the interval (so frequent dev restarts don't
  // re-fetch); the recurring pass always refreshes.
  const boot = setTimeout(() => runRefresh(bakes, { skipIfFreshHours: cfg.interval_hours }).catch((e) => console.error('[refresh]', e?.message || e)), 60_000);
  if (boot.unref) boot.unref();
  const timer = setInterval(() => runRefresh(bakes).catch((e) => console.error('[refresh]', e?.message || e)), Math.max(1, cfg.interval_hours) * 3600_000);
  if (timer.unref) timer.unref();
  globalThis.__tcgRefreshTimer = timer;
  console.log(`[refresh] baked-data refresh every ${cfg.interval_hours}h · bakes: ${bakes.join(', ')}`);
  return timer;
}

export function stopDataRefresh() {
  if (globalThis.__tcgRefreshTimer) { clearInterval(globalThis.__tcgRefreshTimer); globalThis.__tcgRefreshTimer = null; }
}
