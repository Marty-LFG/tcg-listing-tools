// lib/collector.mjs — in-process price collector + signal computation.
//
// Runs inside the Vite service. To honour Golden Rule 1 (the API proxies exist only
// in the dev server) it SELF-FETCHES its own proxy — `http://127.0.0.1:<port>/api/...`
// — so all auth (Scrydex keys, Scryfall UA, pokemon key, FX) is reused with zero
// proxy refactor. Single in-process writer; the Claude agent never touches the .db.
import { mapPrice, lookupPath, toAUD } from './normalize.mjs';
import { scrubSecrets } from './logbuffer.mjs';

// Benign per-card outcomes — expected on keyless sources, NOT worth a warn (they'd flood
// the /api/status/logs?level=warn tail). Everything else (scrydex_inactive, network, bad_json,
// exception, http_5xx, …) is actionable and does warn.
const BENIGN_OUTCOMES = new Set(['no_price', 'http_404']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jfetch(url, { retry429 = true } = {}) {
  let r = await fetch(url);
  if (r.status === 429 && retry429) { await sleep(1500); r = await fetch(url); }
  return r;
}

// Loads live FX once per pass. Returns {USD:1, AUD, EUR, ...} or null.
async function loadRates(base) {
  try {
    const r = await jfetch(base + '/api/fx/latest?from=USD&to=AUD,EUR,GBP,JPY');
    if (!r.ok) return null;
    const j = await r.json();
    return Object.assign({ USD: 1 }, j.rates || {});
  } catch { return null; }
}

const SOURCE_BY_GAME = { riftbound: 'scrydex', mtg: 'scryfall', pokemon: 'pokemontcg', swu: 'swudb', lorcana: 'lorcast' };

function setWatchState(db, id, { error = null } = {}) {
  db.prepare(`UPDATE watchlist SET last_checked_at = datetime('now'), last_error = ? WHERE id = ?`).run(error, id);
}

// Upsert the full raw upstream payload for a card (one row per card, latest wins).
function cacheRaw(db, card, status, payloadText) {
  db.prepare(`INSERT INTO card_cache (game, identity_key, fetched_at, http_status, source, payload)
              VALUES (?,?,datetime('now'),?,?,?)
              ON CONFLICT(game, identity_key) DO UPDATE SET
                fetched_at = datetime('now'), http_status = excluded.http_status,
                source = excluded.source, payload = excluded.payload`)
    .run(card.game, card.identity_key, status, SOURCE_BY_GAME[card.game] || null, payloadText);
}

// Fetch + map + persist a single card. Returns 'snapshot' | 'no_price' | error-code.
async function collectCard(db, base, card, rates) {
  const path = lookupPath(card.game, card.identity_key);
  if (!path) { setWatchState(db, card.id, { error: 'bad_game' }); return 'bad_game'; }

  let r;
  try { r = await jfetch(base + path); }
  catch { setWatchState(db, card.id, { error: 'network' }); return 'network'; }

  let bodyText = '';
  try { bodyText = await r.text(); } catch {}

  if (!r.ok) {
    // Riftbound prices need Scrydex: 401/403 = key missing/invalid; 402 = valid key but
    // no active subscription (Scrydex has no free tier — needs a paid plan).
    let err;
    if (card.game === 'riftbound' && (r.status === 401 || r.status === 403)) err = 'scrydex_unauthorized';
    else if (card.game === 'riftbound' && r.status === 402) err = 'scrydex_inactive';
    else if (r.status === 404) err = 'http_404';
    else err = 'http_' + r.status;
    setWatchState(db, card.id, { error: err });
    return err;
  }

  let json;
  try { json = JSON.parse(bodyText); } catch { setWatchState(db, card.id, { error: 'bad_json' }); return 'bad_json'; }

  // Cache the full upstream payload locally on EVERY successful fetch (any source) —
  // a durable copy of whatever the API returned, and it conserves credits (Scrydex bills
  // per request). Done before price mapping so we keep the data even when there's no price.
  try { cacheRaw(db, card, r.status, bodyText); } catch (e) { console.error('[collector] cache', card.id, e?.message || e); }

  const p = mapPrice(card.game, json, card.variant);
  if (!p || p.market == null) { setWatchState(db, card.id, { error: 'no_price' }); return 'no_price'; }

  const fxAud = rates ? (rates.AUD || null) : null;
  const marketAud = toAUD(p.market, p.currency, rates);
  db.prepare(`INSERT INTO price_snapshots
      (card_id, market, low, currency, market_aud, fx_usd_aud, source, pct_1d, pct_7d, pct_30d, pct_90d, raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(card.id, p.market, p.low ?? null, p.currency, marketAud, fxAud, p.source,
      p.pct_1d ?? null, p.pct_7d ?? null, p.pct_30d ?? null, p.pct_90d ?? null, JSON.stringify(p));
  setWatchState(db, card.id, { error: null });
  computeSignals(db, card.id);
  return 'snapshot';
}

// Structured record of the last FULL pass + next scheduled fire, surfaced at
// /api/status (jobs.collector) so a stalled/erroring collector is diagnosable
// without the box's console. Single-card (onlyId) runs don't overwrite it.
let _lastPass = null;   // { started_at, finished_at, trigger, ok, checked, snapshots, errors: {code:n} }
let _nextRunAt = null;  // ISO of the next scheduled pass
export function getCollectorState() {
  return { running: !!globalThis.__tcgCollectorTimer, next_run_at: _nextRunAt, last_pass: _lastPass };
}

// Runs one collection pass over active cards (or a single id). Returns {checked, snapshots, errors}.
export async function runPass({ db, base, onlyId = null, trigger = 'schedule' } = {}) {
  const started = new Date();
  try {
    const rates = await loadRates(base);
    const rows = onlyId
      ? db.prepare(`SELECT id, game, identity_key, variant, source FROM watchlist WHERE id = ? AND active = 1`).all(onlyId)
      : db.prepare(`SELECT id, game, identity_key, variant, source FROM watchlist WHERE active = 1 ORDER BY id`).all();

    let snapshots = 0;
    const errors = {};   // outcome-code -> count (e.g. scrydex_inactive, no_price, http_404)
    for (const card of rows) {
      try {
        const outcome = await collectCard(db, base, card, rates);
        if (outcome === 'snapshot') snapshots++;
        else if (outcome) errors[outcome] = (errors[outcome] || 0) + 1;
      } catch (e) { console.error('[collector] card', card.id, e?.message || e); errors.exception = (errors.exception || 0) + 1; }
      await sleep(400); // gentle on the upstream APIs
    }
    if (rows.length) console.log(`[collector] pass: ${snapshots}/${rows.length} cards snapshotted`);
    // Surface ACTIONABLE per-pass failures as a single warn line — otherwise the
    // /api/status/logs tail looks clean while cards silently fail (e.g. 14× scrydex_inactive
    // on a lapsed plan). Benign outcomes (no_price/http_404) are excluded so warn stays meaningful.
    const actionable = Object.keys(errors).filter((k) => !BENIGN_OUTCOMES.has(k));
    if (actionable.length) console.warn('[collector] pass errors: ' + actionable.map((k) => errors[k] + '× ' + k).join(', '));
    if (onlyId == null) _lastPass = { started_at: started.toISOString(), finished_at: new Date().toISOString(), trigger, ok: true, checked: rows.length, snapshots, errors };
    return { checked: rows.length, snapshots, errors };
  } catch (e) {
    if (onlyId == null) _lastPass = { started_at: started.toISOString(), finished_at: new Date().toISOString(), trigger, ok: false, error: scrubSecrets(String(e?.message || e)), checked: null, snapshots: 0, errors: {} };
    throw e;
  }
}

// ---- signals ---------------------------------------------------------------

let THRESHOLDS = { opportunity_drop_pct: -10, momentum_rise_pct: 15, downtrend_drop_pct: -8, min_price_aud: 2 };
export function setThresholds(t) { if (t) THRESHOLDS = { ...THRESHOLDS, ...t }; }
export function getThresholds() { return { ...THRESHOLDS }; }

// % change vs the most recent snapshot at least `days` old (null if not enough history).
function pctFromHistory(db, cardId, currentMarket, days) {
  const base = db.prepare(
    `SELECT market FROM price_snapshots
     WHERE card_id = ? AND market IS NOT NULL AND ts <= datetime('now', ?)
     ORDER BY ts DESC LIMIT 1`).get(cardId, `-${days} days`);
  if (!base || base.market == null || !(base.market > 0)) return null;
  return { pct: ((currentMarket - base.market) / base.market) * 100, from: base.market };
}

function recentSignal(db, cardId, kind, win) {
  return db.prepare(
    `SELECT 1 FROM signals WHERE card_id = ? AND kind = ? AND window = ? AND ts > datetime('now','-1 day') LIMIT 1`)
    .get(cardId, kind, win);
}

// Inspects a card's latest snapshot across the 7d/30d windows and records signals.
export function computeSignals(db, cardId) {
  const card = db.prepare(`SELECT id, game, name, source FROM watchlist WHERE id = ?`).get(cardId);
  const snap = db.prepare(
    `SELECT market, market_aud, currency, pct_7d, pct_30d FROM price_snapshots
     WHERE card_id = ? ORDER BY ts DESC LIMIT 1`).get(cardId);
  if (!card || !snap || snap.market == null) return [];

  const t = THRESHOLDS;
  const held = card.source === 'user';
  const priceOk = snap.market_aud == null || snap.market_aud >= t.min_price_aud;
  const windows = [
    { win: '7d', days: 7, rb: snap.pct_7d },
    { win: '30d', days: 30, rb: snap.pct_30d },
  ];
  const made = [];

  for (const w of windows) {
    let pct = null, from = null;
    // Riftbound: prefer Scrydex's built-in trend deltas (Growth+ tier); otherwise — and for
    // every other game — fall back to % computed from our own stored snapshots. This keeps
    // signals working on the Scrydex Starter tier (Raw Prices, no Trends) and keyless sources.
    if (card.game === 'riftbound' && w.rb != null) { pct = +w.rb; from = snap.market / (1 + pct / 100); }
    else { const h = pctFromHistory(db, cardId, snap.market, w.days); if (h) { pct = h.pct; from = h.from; } }
    if (pct == null || !isFinite(pct)) continue;

    let kind = null, msg = '';
    const pctR = Math.round(pct * 10) / 10;
    if (pct >= t.momentum_rise_pct) { kind = 'momentum'; msg = `${card.name} up ${pctR}% over ${w.win}`; }
    else if (!held && pct <= t.opportunity_drop_pct && priceOk) { kind = 'opportunity'; msg = `${card.name} down ${pctR}% over ${w.win} — possible buy`; }
    else if (held && pct <= t.downtrend_drop_pct) { kind = 'downtrend'; msg = `${card.name} (held) down ${pctR}% over ${w.win}`; }
    if (!kind) continue;
    if (recentSignal(db, cardId, kind, w.win)) continue;

    db.prepare(`INSERT INTO signals (card_id, kind, window, pct, from_price, to_price, currency, message)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(cardId, kind, w.win, pct, from ?? null, snap.market, snap.currency, msg);
    made.push({ kind, window: w.win, pct, message: msg });
  }
  return made;
}

// ---- scheduler -------------------------------------------------------------
// Stop-then-start (NOT an early-return guard): Vite restarts the dev server
// IN-PROCESS on any watched-file change (.env, config, a pulled lib/*.mjs), and the
// old server's httpServer 'close' used to tear this timer down — racing the new
// server's start and leaving NOTHING scheduled (the collector silently stalled for
// days). We no longer stop on close (see tracker.mjs); instead each (re)start
// cleanly replaces the prior timer+boot with the current db/base. globalThis is the
// cross-instance singleton (module may be re-imported on restart) so we never stack.
export function startCollector({ db, base, cadenceHours = 24 }) {
  stopCollector();
  const intervalMs = Math.max(1, cadenceHours) * 3600_000;
  const tick = () => { _nextRunAt = new Date(Date.now() + intervalMs).toISOString(); return runPass({ db, base }).catch((e) => console.error('[collector]', e?.message || e)); };
  // one pass shortly after boot, then on the cadence
  const boot = setTimeout(tick, 30_000);
  if (boot.unref) boot.unref();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  globalThis.__tcgCollectorTimer = timer;
  globalThis.__tcgCollectorBoot = boot;
  _nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  console.log(`[collector] scheduled every ${cadenceHours}h (base ${base})`);
  return timer;
}

export function stopCollector() {
  if (globalThis.__tcgCollectorBoot) { clearTimeout(globalThis.__tcgCollectorBoot); globalThis.__tcgCollectorBoot = null; }
  if (globalThis.__tcgCollectorTimer) { clearInterval(globalThis.__tcgCollectorTimer); globalThis.__tcgCollectorTimer = null; }
  _nextRunAt = null;
}
