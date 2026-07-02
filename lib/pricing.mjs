// lib/pricing.mjs — the hybrid bulk-pricing engine (one engine for both workflows).
//
// Precedence (owner decision C):
//   RAW rows:    override  >  live market (≥ threshold)  >  tier floor
//   GRADED rows: override  >  market (Collectr/live, any amount > 0)  >
//                PriceCharting graded ladder (USD → AUD)  >  needs_price
//
// Golden Rule 3: everything upstream passes FLOATS; Math.round(x*100) to integer
// cents happens HERE, exactly once. Golden Rule 4: a tier floor is an owner-set
// floor, never a market claim — value_source tags every result ('override' |
// 'market' | 'bulk_tier' | 'pricecharting' | 'needs_price') so provenance is
// machine-checkable end to end; graded rows with no source are flagged, never
// given a fabricated price. Pure module: no DOM, no fetch, no DB.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toAUD } from './normalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(path.resolve(__dirname, '..'), 'data', 'bulk-pricing.config.json');

const FALLBACK_CONFIG = {
  currency: 'AUD',
  min_price_aud: 0.49,
  rounding_endings: [0.49, 0.99],
  market_threshold_aud: { default: 2.0 },
  tiers: { default: { default: { default: 0.99 } } },
};

// Live-read each request (same pattern as lib/inventory.mjs loadGradingConfig) so the
// owner can tune floors/thresholds with no restart. Falls back to safe defaults (GR7).
export function loadBulkConfig(configPath = CONFIG_PATH) {
  try { return { ...FALLBACK_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; }
  catch { return FALLBACK_CONFIG; }
}

// 'Uncommon' before 'common' — "uncommon" contains "common".
export function rarityClass(rarity) {
  const r = (rarity || '').toLowerCase();
  if (/uncommon/.test(r)) return 'uncommon';
  if (/common/.test(r)) return 'common';
  if (/\brare\b|\bholo rare\b/.test(r)) return 'rare';
  return 'default';
}

// Finish → the tier column. Mirrors listing-copy variantToken's base tokens.
export function finishClass(finish) {
  const f = (finish || '').toLowerCase();
  if (/reverse/.test(f)) return 'Reverse Holo';
  if (/holo/.test(f)) return 'Holo';
  if (/enchanted/.test(f)) return 'Enchanted';
  if (/foil/.test(f)) return 'Foil';
  return 'Base';
}

export function tierFloor(cfg, game, rarity, finish) {
  const tiers = cfg.tiers || {};
  const g = tiers[game] || tiers.default || {};
  const r = g[rarityClass(rarity)] || g.default || {};
  const v = r[finishClass(finish)];
  const floor = v != null ? v : (r.default != null ? r.default : null);
  if (floor != null) return floor;
  const dd = (tiers.default && tiers.default.default) || {};
  return dd[finishClass(finish)] != null ? dd[finishClass(finish)] : (dd.default != null ? dd.default : FALLBACK_CONFIG.min_price_aud);
}

export function thresholdFor(cfg, game) {
  const t = cfg.market_threshold_aud || {};
  return t[game] != null ? t[game] : (t.default != null ? t.default : 2.0);
}

// Round an AUD amount UP to the nearest configured psychological ending (.49/.99),
// then floor at min_price. 3.10 → 3.49, 3.60 → 3.99, 0.30 → 0.49.
export function roundAU(aud, cfg) {
  if (aud == null || !(aud > 0)) return null;
  const endings = (cfg.rounding_endings && cfg.rounding_endings.length ? cfg.rounding_endings : [0.49, 0.99]).slice().sort((a, b) => a - b);
  const whole = Math.floor(aud);
  const frac = aud - whole;
  let out = null;
  for (const e of endings) { if (frac <= e + 1e-9) { out = whole + e; break; } }
  if (out == null) out = whole + 1 + endings[0];
  const min = cfg.min_price_aud != null ? cfg.min_price_aud : 0.49;
  return Math.max(out, min);
}

// resolvePrice(row, cfg, rates) -> { price_cents, value_source, market_cents, needs_price }
//   row: { game, rarity, finish, graded, override_aud, market_aud, market_usd,
//          pc_value_usd }  — floats or null throughout (GR3 boundary is here).
//   rates: {USD:1, AUD, ...} from /api/fx (needed only for USD→AUD legs).
export function resolvePrice(row, cfg, rates) {
  cfg = cfg || FALLBACK_CONFIG;
  const cents = (aud) => (aud == null ? null : Math.round(aud * 100));

  // Best-known market in AUD (for the audit chip + threshold test), no rounding.
  let marketAud = row.market_aud;
  if (marketAud == null && row.market_usd != null && rates) marketAud = toAUD(+row.market_usd, 'USD', rates);
  const market_cents = cents(marketAud);

  // 1. Human override always wins.
  if (row.override_aud != null && +row.override_aud > 0) {
    return { price_cents: cents(+row.override_aud), value_source: 'override', market_cents };
  }

  if (row.graded) {
    // 2g. Any positive market figure (Collectr export / live comp) is the basis.
    if (marketAud != null && marketAud > 0) {
      return { price_cents: cents(roundAU(marketAud, cfg)), value_source: 'market', market_cents };
    }
    // 3g. PriceCharting graded-ladder rung (USD).
    if (row.pc_value_usd != null && +row.pc_value_usd > 0 && rates) {
      const aud = toAUD(+row.pc_value_usd, 'USD', rates);
      if (aud != null && aud > 0) {
        return { price_cents: cents(roundAU(aud, cfg)), value_source: 'pricecharting', market_cents: market_cents != null ? market_cents : cents(aud) };
      }
    }
    // 4g. Nothing usable — flag, never fabricate (GR4). Export is hard-blocked upstream.
    return { price_cents: null, value_source: 'needs_price', market_cents, needs_price: true };
  }

  // 2. Raw: live market when it clears the threshold.
  const threshold = thresholdFor(cfg, row.game);
  if (marketAud != null && marketAud >= threshold) {
    return { price_cents: cents(roundAU(marketAud, cfg)), value_source: 'market', market_cents };
  }

  // 3. Raw: conservative tier floor (owner-set, GR4-safe).
  const floor = tierFloor(cfg, row.game, row.rarity, row.finish);
  return { price_cents: cents(Math.max(floor, cfg.min_price_aud != null ? cfg.min_price_aud : 0.49)), value_source: 'bulk_tier', market_cents };
}
