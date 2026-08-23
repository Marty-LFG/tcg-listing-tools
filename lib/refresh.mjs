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
import { buildRiftboundPrices } from '../scripts/build-riftbound-prices.mjs';
import { buildPokemonIntlSets } from '../scripts/build-pokemon-intl-sets.mjs';
import { buildPokemonEnEarly } from '../scripts/build-pokemon-en-early.mjs';
import { buildPokemonMep } from '../scripts/build-pokemon-mep.mjs';
import { buildSetSymbols } from '../scripts/build-pokemon-set-symbols.mjs';
import { buildMtgSetLogos } from '../scripts/build-mtg-set-logos.mjs';
import { buildLorcanaSetArt } from '../scripts/build-lorcana-set-art.mjs';
import { buildSwuSetArt } from '../scripts/build-swu-set-art.mjs';
import { buildOnepieceSetArt } from '../scripts/build-onepiece-set-art.mjs';
import { buildOnepieceTcgImages } from '../scripts/build-onepiece-tcgimages.mjs';
import { buildPokemonJpArt } from '../scripts/build-pokemon-jp-art.mjs';
import { prewarmCatalogCards, clearSetCardsRow, checkPokemonCoverage } from './catalog.mjs';
import { sendMessage, telegramEnabled, telegramChatConfigured, escapeHtml } from './telegram.mjs';
import { scrubSecrets } from './logbuffer.mjs';
import { configFile } from './config-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = configFile('refresh.config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'data', 'refresh.config.example.json');
const EN_EARLY_PATH = path.join(ROOT, 'data', 'pokemon-en-early.json');
const EN_EARLY_SEED_PATH = path.join(ROOT, 'data', 'pokemon-en-early-seed.json');
const MEP_PATH = path.join(ROOT, 'data', 'pokemon-mep.json');
const MEP_SEED_PATH = path.join(ROOT, 'data', 'pokemon-mep-seed.json');
const DEFAULT_CONFIG = { enabled: true, interval_hours: 24, bakes: ['riftbound', 'riftbound-prices', 'pokemon-intl', 'pokemon-en-early', 'pokemon-mep'] };

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
// Cold-start the gitignored Mega Evolution Promo roster from its tracked snapshot, so a fresh deploy
// lists the set immediately (the pokemon-mep bake then refreshes it live ~60s later). Network-free.
function ensureMepSeeded() {
  try {
    if (fs.existsSync(MEP_PATH) || !fs.existsSync(MEP_SEED_PATH)) return;
    fs.copyFileSync(MEP_SEED_PATH, MEP_PATH);
    console.log('[refresh] seeded data/pokemon-mep.json from seed');
  } catch (e) { console.warn('[refresh] mep seed failed —', e?.message || e); }
}

export function loadRefreshConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return DEFAULT_CONFIG; }
}

// name -> { label (human name for the settings UI), file (the catalog it writes, for the freshness
// check), run() }. The KEYS are the single source of truth for "which bakes exist" — availableBakes()
// below exports them so the settings validator + UI derive from this and never go stale.
const BAKES = {
  // Riot's card gallery ships its own set roster (codes, names, printed totals, release order), so
  // this bake is what makes a NEW SET appear everywhere with no code change — and it Telegram-alerts
  // when one does. Must stay ORDERED BEFORE 'riftbound-prices': that bake derives its TCGplayer
  // set-name join from this file, so reversing them makes a new set's prices lag a whole cycle.
  riftbound: {
    label: 'Riftbound card gallery (Riot)',
    file: path.join(ROOT, 'data', 'riftbound.json'),
    run: async (ctx) => {
      const r = await buildRiftboundData();
      if (r.newSets && r.newSets.length) await alertRiftboundSets((ctx && ctx.env) || {}, r.newSets).catch((e) => console.warn('[refresh] riftbound-set alert failed —', e?.message || e));
      return `riftbound refreshed [${r.summary}]`;
    },
  },
  // Riftbound market prices (data/riftbound-prices.json) — the KEYLESS replacement for the Scrydex
  // price lane, whose subscription lapsed (402 SUBSCRIPTION_INACTIVE) while being the game's only
  // price source. Because the whole tracker watchlist is Riftbound, that left price_snapshots empty
  // for every game; this bake is what makes the collector able to snapshot anything at all, and
  // what lets the price-trend graph reconstruct deltas from local history. Best-effort (GR7):
  // buildRiftboundPrices throws pre-write (atomic temp+rename), so a bad day keeps the last index.
  'riftbound-prices': {
    label: 'Riftbound market prices (TCGplayer, keyless)',
    file: path.join(ROOT, 'data', 'riftbound-prices.json'),
    run: async () => { const r = await buildRiftboundPrices(); return `riftbound-prices baked [${r.summary}]`; },
  },
  // The JP/CN/KO set index — the lane that sees a brand-new Japanese set FIRST, and until now the
  // only Pokémon lane with no new-set alert at all. A set dropping in Japan was silent: it showed up
  // in a bake summary and nowhere else, which is how M6 Storm Emeralda went three weeks unnoticed.
  'pokemon-intl': {
    label: 'Pokémon JP/CN/KO set index (TCGdex)',
    file: path.join(ROOT, 'data', 'pokemon-intl-sets.json'),
    run: async (ctx) => {
      const r = await buildPokemonIntlSets();
      if (r.newSets && r.newSets.length) await alertIntlSets((ctx && ctx.env) || {}, r.newSets).catch((e) => console.warn('[refresh] intl-set alert failed —', e?.message || e));
      return `pokemon-intl refreshed [${r.summary}]`;
    },
  },
  // EN early/pre-release sets from PriceCharting (data/pokemon-en-early.json) — surfaces a new EN set
  // in the catalog + builder weeks before pokemontcg.io catalogs it. Runs AFTER pokemon-intl (it reads
  // its enEquivalent names). Busts a graduated set's stale card cache; Telegram-alerts on a newly
  // discovered set so the owner knows they can start listing. Best-effort (GR7): a fetch failure keeps
  // the existing file. env (pokemontcg key + Telegram creds) is threaded from startDataRefresh.
  'pokemon-en-early': {
    label: 'Early EN Pokémon sets (PriceCharting)',
    file: path.join(ROOT, 'data', 'pokemon-en-early.json'),
    run: async (ctx) => {
      const r = await buildPokemonEnEarly({ env: (ctx && ctx.env) || {}, clearCache: clearSetCardsRow });
      if (r.newSets && r.newSets.length) await alertEarlySets((ctx && ctx.env) || {}, r.newSets).catch((e) => console.warn('[refresh] early-set alert failed —', e?.message || e));
      return `pokemon-en-early baked [${r.summary}]`;
    },
  },
  // Mega Evolution Promo (data/pokemon-mep.json) — a baked EN set absent from pokemontcg.io AND
  // PriceCharting; roster from TCGplayer's public search API, images from the keyless Scrydex CDN.
  // Telegram-alerts on a newly listed card so the owner can start listing it. Best-effort (GR7): a
  // fetch failure keeps the existing file (buildPokemonMep throws pre-write, atomic temp+rename).
  'pokemon-mep': {
    label: 'Mega Evolution Promo roster (TCGplayer)',
    file: MEP_PATH,
    run: async (ctx) => {
      const r = await buildPokemonMep();
      if (r.newCards && r.newCards.length) await alertMepCards((ctx && ctx.env) || {}, r.newCards).catch((e) => console.warn('[refresh] mep-card alert failed —', e?.message || e));
      return `pokemon-mep baked [${r.summary}]`;
    },
  },
  // Set symbol/logo index (data/pokemon-set-symbols.json) for the listing-image compositor's rail
  // badge. Bulbapedia is the only source that covers JAPANESE symbols — TCGdex carries only old
  // shared "univ" ones and images.scrydex.com has no JP ids at all (it answers 200 with a generic
  // placeholder, so a constructed URL silently yields a grey blob). Resolves URLs only, a handful of
  // batched API calls; the images themselves are fetched lazily through lib/img-cache.mjs. Runs after
  // pokemon-intl because it is keyed on the romanised set names that bake stores.
  'pokemon-set-symbols': {
    label: 'Pokémon set symbols + logos (Bulbapedia)',
    file: path.join(ROOT, 'data', 'pokemon-set-symbols.json'),
    run: async () => { const r = await buildSetSymbols(); return `pokemon-set-symbols baked [${r.summary}]`; },
  },
  // Per-game set-art indexes (data/<game>-set-art.json) for the compositor's rails + the
  // description masthead — one doc shape, read back through lib/set-art-data.mjs findGameSetArt.
  // What each carries differs by what exists keyless: MTG + Lorcana get wiki WORDMARKS, Lorcana +
  // SWU get printed denominators, One Piece is the bare name↔code join. Misses degrade to the
  // game-logo rail fallback, never an error (GR7).
  'mtg-set-art': {
    label: 'MTG set wordmarks (mtg.fandom.com)',
    file: path.join(ROOT, 'data', 'mtg-set-art.json'),
    run: async () => { const r = await buildMtgSetLogos(); return `mtg-set-art baked [${r.summary}]`; },
  },
  'lorcana-set-art': {
    label: 'Lorcana set wordmarks + printed totals (lorcana.fandom.com)',
    file: path.join(ROOT, 'data', 'lorcana-set-art.json'),
    run: async () => { const r = await buildLorcanaSetArt(); return `lorcana-set-art baked [${r.summary}]`; },
  },
  'swu-set-art': {
    label: 'SWU set roster + printed totals (official API)',
    file: path.join(ROOT, 'data', 'swu-set-art.json'),
    run: async () => { const r = await buildSwuSetArt(); return `swu-set-art baked [${r.summary}]`; },
  },
  'onepiece-set-art': {
    label: 'One Piece set roster (optcgapi)',
    file: path.join(ROOT, 'data', 'onepiece-set-art.json'),
    run: async () => { const r = await buildOnepieceSetArt(); return `onepiece-set-art baked [${r.summary}]`; },
  },
  // Clean One Piece card art (data/onepiece-tcg-images.json): card code → TCGplayer productId per
  // PRINTING. Bandai's English images are SAMPLE-watermarked at every keyless mirror; TCGplayer's
  // own product scans are the one clean source, and toEbayListing swaps them in variant-strictly
  // (lib/onepiece-clean-art.mjs). Scoped to the sets in data/onepiece-cards/, accretive.
  'onepiece-tcg-images': {
    label: 'One Piece clean card art (TCGplayer)',
    file: path.join(ROOT, 'data', 'onepiece-tcg-images.json'),
    run: async () => { const r = await buildOnepieceTcgImages(); return `onepiece-tcg-images baked [${r.summary}]`; },
  },
  // Japanese card art repair (data/pokemon-jp-art.json). PriceCharting sometimes carries the
  // ILLUSTRATION CROP instead of the card scan — 12 of 113 on M6 Storm Emeralda when measured — and
  // that crop would go to eBay as the product photo. Accretive: a card is measured once, so the
  // first pass is long and every pass after it only sees the newest set. Runs after pokemon-intl
  // (it reads that index for the set list and the English names Serebii is keyed on).
  'pokemon-jp-art': {
    label: 'Japanese card art repair (Serebii)',
    file: path.join(ROOT, 'data', 'pokemon-jp-art.json'),
    run: async () => { const r = await buildPokemonJpArt(); return `pokemon-jp-art baked [${r.summary}]`; },
  },
  // The coverage watchdog (data/pokemon-coverage.json). Resolves every recently-released Pokémon set
  // across all five lanes — plus any set with no card count at any age — through the SAME source
  // chain the stock tools use, and alerts on anything that comes back with zero cards. This is the
  // check that was missing: file freshness told us the bakes ran, and nothing told us a SET was
  // unlistable. Runs AFTER pokemon-intl + pokemon-en-early (it reads both their outputs).
  'pokemon-coverage': {
    label: 'Pokémon set coverage watchdog',
    file: path.join(ROOT, 'data', 'pokemon-coverage.json'),
    run: async (ctx) => {
      const r = await checkPokemonCoverage({ env: (ctx && ctx.env) || {} });
      // NEW gaps only. The known source-less tail (JP era promo pools, the CS* block) is real and
      // belongs in the Settings panel, but re-pushing it every six hours trains the alert to be
      // ignored — and an alert you ignore is the same as the one we did not have on 2026-07-31.
      if (r.newGaps && r.newGaps.length) await alertCoverageGaps((ctx && ctx.env) || {}, r.newGaps).catch((e) => console.warn('[refresh] coverage alert failed —', e?.message || e));
      return `pokemon-coverage checked [${r.summary}]`;
    },
  },
  // Opt-in: pre-warm the catalog's set_cards for every PriceCharting-backed JP/CN/KO set (the seeded
  // sets whose on-demand load is slowest + rate-limited). Add 'catalog-cards' to refresh.config.json
  // `bakes` to enable; trigger immediately with POST /api/status/refresh. Writes tracker.db (set_cards).
  'catalog-cards': {
    label: 'Pre-warm catalog card cache (opt-in, slow)',
    file: path.join(ROOT, 'data', 'tracker.db'),
    run: async () => { const r = await prewarmCatalogCards(); return `catalog-cards pre-warmed [${r.summary}]`; },
  },
  // NB: funko is NOT a refresh bake — its upstream (kennymkchan) has been frozen since 2021, so
  // data/funko_pop.json is a build-time-only artifact (scripts/build-funko-data.mjs). It is
  // deliberately absent from this registry, so it never appears as a selectable/valid bake.
};

// Registered bake names + labels — the SINGLE SOURCE OF TRUTH for "which bakes exist". The settings
// validator (lib/status.mjs) and the settings-UI checklist (settings.html) both derive from this, so
// adding a bake to BAKES automatically makes it selectable + valid with zero allowlist edits.
export function availableBakes() {
  return Object.entries(BAKES).map(([name, b]) => ({ name, label: b.label || name }));
}

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

// Telegram heads-up when a brand-new JP/CN/KO set enters the baked index — from TCGdex ingesting it,
// or from a PriceCharting console appearing for a set TCGdex still hasn't. Either way it is listable
// straight away, by NAME. A set that arrived via PriceCharting has no printed code yet (nothing
// publishes one that early), so the message asks for it: assigning `M7` in catalog.html's overlay is
// one click and makes the set switchable mid-pile in the batch runner. Best-effort + silent when
// Telegram isn't configured (GR7).
const LANG_LABEL = { ja: 'Japanese', 'zh-cn': 'Chinese (simplified)', 'zh-tw': 'Chinese (traditional)', ko: 'Korean' };
async function alertIntlSets(env, sets) {
  if (!env || !telegramEnabled(env) || !telegramChatConfigured(env)) return;
  const lines = sets.slice(0, 20).map((s) => `🆕 <b>${escapeHtml(s.name)}</b>`
    + ` — ${escapeHtml(LANG_LABEL[s.lang] || s.lang)}`
    + (s.code ? ` (<code>${escapeHtml(s.code)}</code>)` : '')
    + (s.releaseDate ? ` · released ${escapeHtml(s.releaseDate)}` : '')
    + (s.needsCode ? '\n   ⚠ no printed set code yet — listable by name; add the code in the catalog overlay to make it switchable by code' : ''));
  const more = sets.length > 20 ? `\n\n…and ${sets.length - 20} more` : '';
  const text = `<b>🃏 New Pokémon set detected</b>\nListable now in the catalog + stock tools:\n\n${lines.join('\n\n')}${more}`;
  await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text });
}

// Telegram warning when a set in the catalog resolves to NO cards — i.e. it is visible in the tools
// and cannot actually be listed. This is the alert whose absence let M6 Storm Emeralda go three
// weeks: everything upstream was fine, the set was in the index, and the only way to find out was to
// stand at the counter with a pile of cards. Best-effort + silent when Telegram isn't configured.
async function alertCoverageGaps(env, gaps) {
  if (!env || !telegramEnabled(env) || !telegramChatConfigured(env)) return;
  const lines = gaps.slice(0, 15).map((g) => `⚠ <b>${escapeHtml(g.name || g.code)}</b>`
    + ` — ${escapeHtml(LANG_LABEL[g.lang] || g.lang)}${g.code ? ` (<code>${escapeHtml(g.code)}</code>)` : ''}`
    + (g.error ? `\n   ${escapeHtml(g.error)}` : '')
    + (g.pcSlug ? `\n   PriceCharting: <code>${escapeHtml(g.pcSlug)}</code>` : ''));
  const more = gaps.length > 15 ? `\n\n…and ${gaps.length - 15} more` : '';
  const text = `<b>🚫 Set with no cards</b>\nNewly unlistable — in the catalog, pickable in the stock tools, resolving to zero cards:\n\n${lines.join('\n\n')}${more}`;
  await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text });
}

// Telegram heads-up when a NEW Mega Evolution Promo card appears in the roster (owner can start
// listing it). Best-effort + silent when Telegram isn't configured (GR7).
async function alertMepCards(env, cards) {
  if (!env || !telegramEnabled(env) || !telegramChatConfigured(env)) return;
  const lines = cards.slice(0, 20).map((c) => `🆕 <b>${escapeHtml(c.name)}</b> — #${escapeHtml(c.number)}`);
  const more = cards.length > 20 ? `\n…and ${cards.length - 20} more` : '';
  const text = `<b>🃏 New Mega Evolution Promo card${cards.length > 1 ? 's' : ''}</b>\nListable now in the Pokémon builder (via TCGplayer — ahead of pokemontcg.io):\n\n${lines.join('\n')}${more}`;
  await sendMessage(env, { chatId: (env.TELEGRAM_CHAT_ID || '').trim(), text });
}

// Telegram heads-up when a BRAND-NEW Riftbound set first appears in Riot's card gallery. Everything
// downstream derives from that bake — the builder's set pills, the bulk enumerator's set list, and
// (since the TCGplayer join is matched by set NAME) the price index on the very next price bake — so
// the set is listable the moment this fires. Best-effort + silent when Telegram isn't configured (GR7).
async function alertRiftboundSets(env, sets) {
  if (!env || !telegramEnabled(env) || !telegramChatConfigured(env)) return;
  const lines = sets.map((s) => `🆕 <b>${escapeHtml(s.name)}</b> (<code>${escapeHtml(s.code)}</code>)`
    + ` — ${s.cards} cards, printed total ${escapeHtml(String(s.total || '?'))}`);
  const text = `<b>🃏 New Riftbound set detected</b>\nListable now in the Riftbound builder + bulk enumerator (via Riot's card gallery):\n\n${lines.join('\n')}`;
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
  ensureMepSeeded();
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
