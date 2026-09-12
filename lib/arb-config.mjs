// lib/arb-config.mjs — the arbitrage finder's own switches.
//
// A separate file from lib/arbitrage.mjs for the reason lib/runs-config.mjs is separate from
// lib/runs.mjs: lib/status.mjs validates this config for the settings form, and it also imports the
// job-state getter from lib/arbitrage.mjs. Keeping the loader and validator here means neither
// import forms a cycle.
//
// Same server-owned pattern as the runs, repricer and refresh configs: the runtime copy is gitignored
// and rewritten in place by a settings PUT, and it is seeded from the tracked
// data/arbitrage.config.example.json so a fresh deploy is never missing it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFile } from './config-paths.mjs';
import { QUERY_MODES } from './arb-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_PATH = path.join(ROOT, 'data', 'arbitrage.config.example.json');

export const arbConfigPath = () => configFile('arbitrage.config.json');

export const FEE_MODES = ['feeAU', 'none'];

// Every default is the SAFE one: the watch job disarmed, floors that refuse marginal deals, and a
// call budget with room left for the rest of the app on the same eBay app token.
export const ARB_DEFAULTS = Object.freeze({
  buyer_pct: 0.8,
  min_profit_aud: 5,
  min_margin_pct: 15,
  buyer_fee_mode: 'feeAU',
  daily_call_budget: 3500,
  call_gap_ms: 400,
  browse_limit: 100,
  query_mode: 'comps',
  seller_min_feedback_pct: 95,
  seller_min_feedback_score: 10,
  too_good_ratio: 0.25,
  max_market_age_days: 14,
  exclude_seller_username: null,
  watch: { enabled: false, interval_hours: 6, alerts: true, max_cards_per_pass: 300, max_alerts_per_pass: 10 },
});

export function ensureArbConfigSeeded() {
  try {
    if (!fs.existsSync(arbConfigPath()) && fs.existsSync(EXAMPLE_PATH)) {
      fs.copyFileSync(EXAMPLE_PATH, arbConfigPath());
      console.log('[arb] seeded data/arbitrage.config.json from example');
    }
  } catch (e) { console.warn('[arb] config seed failed —', e?.message || e); }
}

// _comment* keys are documentation for whoever opens the file, not configuration.
function stripComments(v) {
  if (Array.isArray(v)) return v.map(stripComments);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_comment')).map(([k, x]) => [k, stripComments(x)]));
  }
  return v;
}

let _warned = false;
export function loadArbConfig() {
  try {
    const c = stripComments(JSON.parse(fs.readFileSync(arbConfigPath(), 'utf8')));
    return { ...ARB_DEFAULTS, ...c, watch: { ...ARB_DEFAULTS.watch, ...(c.watch || {}) } };
  } catch (e) {
    if (!_warned) { _warned = true; console.warn('[arb] no readable config — using defaults:', e?.message || e); }
    return structuredClone(ARB_DEFAULTS);
  }
}

const num = (v) => typeof v === 'number' && isFinite(v);
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// Returns an error string or null — the shape lib/status.mjs SETTINGS.validate expects.
export function validateArbConfig(c) {
  if (!c || typeof c !== 'object') return 'not an object';
  if (!(num(c.buyer_pct) && c.buyer_pct > 0 && c.buyer_pct <= 1)) return 'buyer_pct must be a fraction in (0, 1] — 0.8 means the buyer pays 80% of market';
  if (!(num(c.min_profit_aud) && c.min_profit_aud >= 0)) return 'min_profit_aud must be a number ≥ 0';
  if (!(num(c.min_margin_pct) && c.min_margin_pct >= 0 && c.min_margin_pct <= 1000)) return 'min_margin_pct must be a percentage ≥ 0';
  if (!FEE_MODES.includes(c.buyer_fee_mode)) return `buyer_fee_mode must be ${FEE_MODES.join(' or ')}`;
  // The Browse app token is roughly 5,000 calls a day for the WHOLE app; comps, the repricer and the
  // testbed all draw on it. The cap here is this tool's share, and 5,000 is the ceiling even if the
  // owner wants it all.
  if (!intIn(c.daily_call_budget, 1, 5000)) return 'daily_call_budget must be a whole number, 1–5000';
  if (!intIn(c.call_gap_ms, 200, 60_000)) return 'call_gap_ms must be a whole number of milliseconds, 200–60000';
  if (!intIn(c.browse_limit, 1, 200)) return 'browse_limit must be 1–200 (the Browse API page cap)';
  if (!QUERY_MODES.includes(c.query_mode)) return `query_mode must be ${QUERY_MODES.join(', ')}`;
  if (!(num(c.seller_min_feedback_pct) && c.seller_min_feedback_pct >= 0 && c.seller_min_feedback_pct <= 100)) return 'seller_min_feedback_pct must be 0–100';
  if (!intIn(c.seller_min_feedback_score, 0, 1_000_000)) return 'seller_min_feedback_score must be a whole number ≥ 0';
  if (!(num(c.too_good_ratio) && c.too_good_ratio >= 0 && c.too_good_ratio < 1)) return 'too_good_ratio must be a fraction in [0, 1)';
  if (!intIn(c.max_market_age_days, 1, 365)) return 'max_market_age_days must be a whole number of days, 1–365';
  if (c.exclude_seller_username != null && typeof c.exclude_seller_username !== 'string') return 'exclude_seller_username must be a string or null';
  const w = c.watch;
  if (!w || typeof w !== 'object') return 'watch required';
  if (typeof w.enabled !== 'boolean') return 'watch.enabled must be boolean';
  if (!(num(w.interval_hours) && w.interval_hours >= 1 && w.interval_hours <= 168)) return 'watch.interval_hours must be 1–168';
  if (typeof w.alerts !== 'boolean') return 'watch.alerts must be boolean';
  if (!intIn(w.max_cards_per_pass, 1, 5000)) return 'watch.max_cards_per_pass must be a whole number, 1–5000';
  if (!intIn(w.max_alerts_per_pass, 0, 100)) return 'watch.max_alerts_per_pass must be a whole number, 0–100';
  return null;
}
