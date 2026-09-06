// lib/keepers-badges.mjs — deciding which of the eight badges a Keeper has earned. Pure: no DB, no
// network, no clock. The caller assembles `facts` from the ledger and hands them in.
//
// Which badges exist, what they are called and WHICH RULE DECIDES EACH ONE all live in the
// bk_keepers_badge metaobject, not here. This file only implements the named rules. Adding a badge
// that reuses an existing rule needs no deploy at all; adding a genuinely new kind of badge is a new
// rule function here plus a metaobject entry naming it.
//
// TWO PROPERTIES OF BADGES THAT ARE NOT OBVIOUS AND ARE DELIBERATE:
//
//   Badges are never revoked. XP and points reverse on a refund; a badge does not. A badge is a
//   memory of something that happened, not a balance — and clawing one back for a returned order
//   would be a hostile surprise for a customer who did nothing wrong. This function reports what is
//   CURRENTLY earned; the caller only ever appends the ones it has not already awarded, and the
//   uq_kev_badge index makes that once-only in the database rather than in a caller's memory.
//
//   Snapshotted evidence, not live lookups. `preorder` and `languages` are decided from what was
//   recorded on the order AT ACCRUAL TIME, never by re-reading the product. bkc.release_status flips
//   from pre-order to in-stock the week a set drops, so a rule that re-read it would make
//   preorder-pioneer permanently unwinnable — and unwinnable in a way nobody would notice, because
//   the badge would simply never appear.

/**
 * The rule names a bk_keepers_badge entry may carry. A badge whose `rule` is not in here is skipped
 * and reported, never silently ignored: a typo in the metaobject would otherwise produce a badge that
 * is displayed, is described as earnable, and can never be earned.
 */
export const RULES = Object.freeze([
  'first_order', 'preorder', 'languages', 'runs_verified',
  'pregrade_sku', 'referral', 'month_streak', 'level_at_least',
]);

/**
 * monthKey(iso, offsetMin) -> 'YYYY-MM' | null
 *
 * THE TIMEZONE TRAP, and the reason this is its own tested function. An order placed in Newcastle at
 * 09:00 on the 1st is 23:00 UTC on the LAST DAY OF THE PREVIOUS MONTH. Bucketing in UTC therefore
 * files a large share of Australian morning orders into the wrong month — which does not throw, does
 * not warn, and quietly breaks streak-keeper runs for exactly the customers who order before lunch.
 *
 * offsetMin is minutes east of UTC (Australia/Sydney is +600, or +660 in daylight saving). It comes
 * from bk_keepers_rules.streak_timezone_offset_min so it can be corrected without a deploy.
 */
export function monthKey(iso, offsetMin = 0) {
  const t = typeof iso === 'number' ? iso : Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return null;
  const shifted = new Date(t + Number(offsetMin || 0) * 60000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** monthIndex('2026-09') -> 24327. Turns calendar months into integers so "consecutive" is arithmetic. */
export function monthIndex(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

/**
 * hasMonthStreak(dates, months, offsetMin)
 *
 * True when the dates contain `months` CONSECUTIVE calendar months with at least one order in each.
 * Several orders in one month count once — spec §6.3 says "order in three different months in a row",
 * so the unit is the month, not the order.
 */
export function hasMonthStreak(dates, months = 3, offsetMin = 0) {
  const want = Math.max(1, Math.trunc(Number(months) || 1));
  const idx = [...new Set(
    (Array.isArray(dates) ? dates : [])
      .map((d) => monthKey(d, offsetMin))
      .filter(Boolean)
      .map(monthIndex)
      .filter((n) => n !== null),
  )].sort((a, b) => a - b);

  let run = idx.length ? 1 : 0;
  for (let i = 1; i < idx.length; i++) {
    run = idx[i] === idx[i - 1] + 1 ? run + 1 : 1;
    if (run >= want) return true;
  }
  return run >= want;
}

// --- the rule implementations ---
//
// Each takes (facts, params, rules) and returns a boolean. They are exported for direct testing,
// because a rule that is only reachable through evaluateBadges is a rule whose edge cases get tested
// through three layers of setup and therefore mostly do not get tested.

export const RULE_FNS = Object.freeze({
  first_order: (f) => count(f.orderCount) >= 1,

  preorder: (f) => Boolean(f.hasPreorder),

  // Case- and whitespace-insensitive, because the language string is authored by the listing tool and
  // read back off a metafield. "japanese" and "Japanese " are the same language.
  languages: (f, params) => {
    const need = (params && Array.isArray(params.require) ? params.require : []).map(norm).filter(Boolean);
    if (!need.length) return false;
    const have = new Set((Array.isArray(f.languages) ? f.languages : []).map(norm).filter(Boolean));
    return need.every((l) => have.has(l));
  },

  runs_verified: (f) => Boolean(f.runsVerified),

  // A blank prefix disables the rule rather than matching everything — which is what
  // ''.startsWith('') would do, and it would award this badge to every customer who has ever ordered.
  pregrade_sku: (f, _params, rules) => {
    const prefix = String((rules && rules.pregrade_sku_prefix) || '').trim();
    if (!prefix) return false;
    const p = prefix.toUpperCase();
    return (Array.isArray(f.skus) ? f.skus : []).some((s) => String(s ?? '').trim().toUpperCase().startsWith(p));
  },

  referral: (f) => count(f.referralCount) >= 1,

  month_streak: (f, params, rules) => hasMonthStreak(
    f.orderDates,
    params && params.months !== undefined ? params.months : 3,
    rules && rules.streak_timezone_offset_min !== undefined ? rules.streak_timezone_offset_min : 0,
  ),

  level_at_least: (f, params) => {
    const want = Number(params && params.level);
    if (!Number.isFinite(want)) return false;
    return count(f.level) >= want;
  },
});

const norm = (s) => String(s ?? '').trim().toLowerCase();
const count = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/**
 * evaluateBadges(facts, { badges, rules })
 *
 * `badges` is the bk_keepers_badge config (normalized by normalizeBadges below), `rules` the
 * bk_keepers_rules singleton. Returns { earned, skipped } — skipped carries a reason per badge so the
 * admin page can show why something can never be won, rather than leaving it looking merely unearned.
 *
 * A COMING-SOON BADGE IS NEVER AWARDED. The flag means the earning mechanism is not live yet
 * (mystery-keeper waits on the Runs verification path, D-011), and the theme renders a dashed
 * "Coming soon" tag against it. Awarding one anyway would render it as simultaneously earned and
 * coming soon, which is not a state anyone can read. Flip the flag when the mechanism ships and the
 * badge starts being winnable on the next projection pass — including, correctly, for people who
 * already met the condition.
 */
export function evaluateBadges(facts, { badges = [], rules = {} } = {}) {
  const earned = [];
  const skipped = [];
  const f = facts || {};

  for (const b of Array.isArray(badges) ? badges : []) {
    const id = String(b.badgeId ?? b.badge_id ?? '').trim();
    if (!id) { skipped.push({ badgeId: null, why: 'entry has no badge_id' }); continue; }

    if (b.comingSoon) { skipped.push({ badgeId: id, why: 'coming_soon' }); continue; }

    const ruleName = String(b.rule ?? '').trim();
    if (!ruleName) { skipped.push({ badgeId: id, why: 'no rule — manual grant only' }); continue; }
    if (!RULE_FNS[ruleName]) { skipped.push({ badgeId: id, why: `unknown rule "${ruleName}"` }); continue; }

    let ok = false;
    try {
      ok = Boolean(RULE_FNS[ruleName](f, b.ruleParams || {}, rules));
    } catch (e) {
      // One badge's bad params must not stop the other seven being awarded.
      skipped.push({ badgeId: id, why: `rule threw: ${e.message}` });
      continue;
    }
    if (ok) earned.push(id);
  }

  return { earned, skipped };
}

/**
 * normalizeBadges(input) — Admin API metaobject nodes, or plain objects, to the shape evaluateBadges
 * wants. Every metaobject value arrives as a string, including the boolean and the JSON.
 */
export function normalizeBadges(input) {
  const rows = Array.isArray(input) ? input : [];
  const out = [];
  for (const row of rows) {
    const f = row && Array.isArray(row.fields)
      ? Object.fromEntries(row.fields.map((x) => [x.key, x.value]))
      : (row || {});
    const id = String(f.badge_id ?? f.badgeId ?? '').trim();
    if (!id) continue;
    let params = {};
    const raw = f.rule_params ?? f.ruleParams;
    if (raw) {
      // Malformed JSON in config must not take the whole projection down — the badge simply loses its
      // parameters and its rule then decides on defaults or reports itself unwinnable.
      try { params = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { params = {}; }
    }
    out.push({
      badgeId: id,
      title: String(f.title ?? '').trim(),
      icon: String(f.icon ?? '').trim(),
      body: String(f.body ?? '').trim(),
      rule: String(f.rule ?? '').trim(),
      ruleParams: params && typeof params === 'object' ? params : {},
      comingSoon: f.coming_soon === true || String(f.coming_soon ?? '').trim().toLowerCase() === 'true',
      sort: Number.isFinite(Number(f.sort)) ? Number(f.sort) : 0,
    });
  }
  out.sort((a, b) => a.sort - b.sort || a.badgeId.localeCompare(b.badgeId));
  return out;
}
