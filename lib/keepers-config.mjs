// lib/keepers-config.mjs — the Keepers economy, read from Shopify metaobjects and cached locally.
//
// The numbers live in bk_keepers_rules / _rank / _badge / _tier on the store, not in a file here and
// not in theme settings. That is D-005's standing requirement — "everything stays config-driven so
// that session needs no redeploy" — and it is also the only arrangement that works at all: the theme
// and the engine both have to read the same rates, and the engine cannot read theme settings because
// read_themes is ungranted on both stores. A metaobject is the only surface both halves can see.
//
// THE CACHE IS NOT AN OPTIMISATION. A Shopify outage must not stall the projection, and a projection
// that runs with no rank table refuses outright (keepers-project fails closed rather than writing
// level 1 to everyone). So a stale-but-present table beats none, and the cache is what supplies it.
// `source` always says which you got, because acting on a day-old economy is fine and not knowing you
// are is not.
//
// EVERY METAOBJECT FIELD VALUE IS A STRING, whatever its declared type. The coercion below is not
// defensive noise — it is the actual shape of the data, and getting a boolean wrong here means
// `enabled: "false"` reads as truthy and the programme runs when it was switched off.
import { shopifyGraphQL } from './channels/shopify-admin.mjs';
import { getMeta, setMeta } from './keepers-db.mjs';
import { normalizeRankTable, rankTableProblem } from './keepers-levels.mjs';
import { normalizeBadges } from './keepers-badges.mjs';

export const CACHE_KEY = 'config_cache';
export const DEFAULT_TTL_SEC = 900;

export const CONFIG_QUERY = `
query {
  rules: metaobjects(type: "bk_keepers_rules", first: 5) { nodes { handle fields { key value } } }
  ranks: metaobjects(type: "bk_keepers_rank", first: 50) { nodes { handle fields { key value } } }
  badges: metaobjects(type: "bk_keepers_badge", first: 50) { nodes { handle fields { key value } } }
  tiers: metaobjects(type: "bk_keepers_tier", first: 50) { nodes { handle fields { key value } } }
}`;

// Declarative so the coercion cannot drift from the definition. Anything not listed is ignored
// rather than passed through as a raw string, which would let a typo'd field name look like it works.
const RULE_TYPES = {
  enabled: 'bool',
  xp_per_dollar: 'num', points_per_dollar: 'num',
  basis: 'text',
  review_xp: 'int',
  referral_referrer_xp: 'int', referral_referrer_points: 'int',
  referral_referee_xp: 'int', referral_referee_points: 'int',
  referral_hold_days: 'int', max_referrals_per_month: 'int',
  checkin_xp: 'int',
  redemption_min_points: 'int', redemption_expiry_days: 'int', redemption_code_prefix: 'text',
  redemption_expiry_refunds: 'bool',
  excluded_channels: 'list',
  streak_timezone_offset_min: 'int',
  pregrade_sku_prefix: 'text',
};

function coerce(kind, raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  switch (kind) {
    case 'bool':
      // Only the literal string 'true' is true. Everything else — including 'false', which is what
      // would otherwise be a truthy non-empty string — is false.
      return s.toLowerCase() === 'true';
    // An EMPTY string is absent, not zero. Number('') is 0 — not NaN — so without this an unset field
    // silently becomes a real value. That is how a redemption tier with no points_cost became "10%
    // off for zero points", i.e. a free discount code. '0' still means zero, which several fields
    // legitimately are (referral_referee_xp, for one).
    case 'int': { if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? Math.trunc(n) : null; }
    case 'num': { if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; }
    case 'list':
      if (!s) return [];
      try { const j = JSON.parse(s); return Array.isArray(j) ? j.map(String) : [String(j)]; }
      // A list field that is not JSON is treated as one comma-separated line rather than dropped:
      // somebody editing it by hand in the admin will type "eBay, Fetch TCG".
      catch { return s.split(',').map((x) => x.trim()).filter(Boolean); }
    case 'text':
    default: return s;
  }
}

const fieldsOf = (node) => Object.fromEntries((node?.fields || []).map((f) => [f.key, f.value]));

export function normalizeRules(nodes) {
  // The singleton is handle 'default'; fall back to the first entry so a renamed handle degrades to
  // "wrong-ish" rather than to "no economy at all".
  const list = Array.isArray(nodes) ? nodes : [];
  const node = list.find((n) => n?.handle === 'default') || list[0];
  if (!node) return null;
  const raw = fieldsOf(node);
  const out = {};
  for (const [key, kind] of Object.entries(RULE_TYPES)) out[key] = coerce(kind, raw[key]);
  return out;
}

export function normalizeTiers(nodes) {
  const out = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const f = fieldsOf(n);
    const pointsCost = coerce('int', f.points_cost);
    const percentOff = coerce('num', f.percent_off);
    // Both must be POSITIVE, not merely present. A tier costing zero points is a free discount code;
    // a tier giving zero percent takes points and returns nothing. Neither is a tier, and a
    // half-filled row in the admin produces exactly one of them.
    if (!Number.isFinite(pointsCost) || pointsCost <= 0) continue;
    if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 100) continue;
    out.push({
      handle: n.handle,
      pointsCost,
      percentOff,
      label: coerce('text', f.label) || '',
      sort: coerce('int', f.sort) ?? 0,
    });
  }
  out.sort((a, b) => a.sort - b.sort || a.pointsCost - b.pointsCost);
  return out;
}

/**
 * configProblem(cfg) — is this economy safe to act on?
 *
 * Separate from "did the fetch work", because a fetch that succeeded and returned an unusable economy
 * is the more dangerous case: it looks healthy.
 */
export function configProblem(cfg) {
  if (!cfg) return 'no config at all — the metaobjects are unseeded or unreadable';
  if (!cfg.rules) return 'bk_keepers_rules has no entry (expected handle "default")';
  if (!Number.isFinite(cfg.rules.xp_per_dollar) || !Number.isFinite(cfg.rules.points_per_dollar)) {
    return 'xp_per_dollar / points_per_dollar are not numbers';
  }
  const rt = rankTableProblem(cfg.ranks);
  if (rt) return `rank table: ${rt}`;
  // An empty exclusion list is how eBay orders start earning XP, and the storefront prints
  // "Keeper XP and points only count on orders placed here" on every page (D-009, invariant 9).
  if (!Array.isArray(cfg.rules.excluded_channels) || cfg.rules.excluded_channels.length === 0) {
    return 'excluded_channels is empty — at minimum it must exclude the channels the storefront promises do not earn';
  }
  return null;
}

/**
 * loadKeepersConfig — fetch, or fall back to the cache, and always say which.
 *
 * Never throws. A caller that cannot get a usable config must fail closed on its own terms
 * (keepers-project refuses the run; keepers-ingest refuses to accrue), and it can only do that if
 * this hands back a value rather than an exception.
 */
export async function loadKeepersConfig(env, db, {
  store = 'dev', ttlSec = DEFAULT_TTL_SEC, force = false, nowMs = Date.now(),
} = {}) {
  let cached = null;
  try { cached = JSON.parse(getMeta(db, CACHE_KEY) || 'null'); } catch { cached = null; }

  const fresh = cached && !force
    && Number.isFinite(Date.parse(cached.fetchedAt))
    && (nowMs - Date.parse(cached.fetchedAt)) / 1000 < ttlSec;
  if (fresh) return { ...cached.config, source: 'cache', fetchedAt: cached.fetchedAt };

  const res = await shopifyGraphQL(env, CONFIG_QUERY, {}, { store });
  if (!res.ok) {
    if (cached) {
      // Stale beats nothing. The projection can run on a day-old economy; it cannot run on none.
      return { ...cached.config, source: 'stale', fetchedAt: cached.fetchedAt, error: 'fetch_failed' };
    }
    return { rules: null, ranks: [], badges: [], tiers: [], source: 'none', error: 'fetch_failed' };
  }

  const config = {
    rules: normalizeRules(res.data?.rules?.nodes),
    ranks: normalizeRankTable(res.data?.ranks?.nodes),
    badges: normalizeBadges(res.data?.badges?.nodes),
    tiers: normalizeTiers(res.data?.tiers?.nodes),
  };

  // Only cache an economy that is safe to act on. Caching a broken one would let a transient bad read
  // poison every subsequent fallback for as long as Shopify stayed unreachable.
  const problem = configProblem(config);
  const fetchedAt = new Date(nowMs).toISOString();
  if (!problem) {
    setMeta(db, CACHE_KEY, JSON.stringify({ fetchedAt, config }));
    return { ...config, source: 'shopify', fetchedAt };
  }
  if (cached) return { ...cached.config, source: 'stale', fetchedAt: cached.fetchedAt, error: problem };
  return { ...config, source: 'shopify', fetchedAt, error: problem };
}

/** What is in the cache right now, for /api/status and the admin page. Never fetches. */
export function cachedConfig(db) {
  try {
    const c = JSON.parse(getMeta(db, CACHE_KEY) || 'null');
    return c ? { ...c.config, source: 'cache', fetchedAt: c.fetchedAt } : null;
  } catch { return null; }
}
