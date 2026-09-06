// lib/keepers-levels.mjs — turning lifetime XP into a Keeper level. Pure: no DB, no network, no clock.
//
// The rank table is CONFIG, not code. It lives in the bk_keepers_rank metaobject (ten entries, seeded
// by bk-shopify/scripts/seed-keepers-config.ps1) precisely so the curve can be retuned without a
// deploy on either side — D-005's standing requirement. Nothing in this file knows what the numbers
// are; it only knows how to read a table and what makes one unusable.
//
// The shipped curve is min_xp(L) = 62.5 * (L-1) * L, chosen to land level 8 on exactly 3,500 XP,
// because that number is already load-bearing: the approved v3 mockup reads "2,840 XP - 660 XP to
// Level 8" and sections/bk-keepers-band.liquid still ships it as a default. A curve that missed it
// would have made the shipped example a lie.
//
// WHY THIS FAILS CLOSED. levelForXp throws on an unusable table rather than returning level 1. The
// projection writes keepers.level to a real customer's metafield, and the difference matters: a
// refused write leaves the previous (correct) value in place and shows up as a stalled queue, while a
// confident level 1 silently DEMOTES every Keeper on the store the first time a config read fails.
// One is visible and reversible; the other is neither.

/**
 * normalizeRankTable(input)
 *
 * Accepts either Admin API metaobject nodes ({ handle, fields: [{key, value}] }) or plain objects, and
 * returns a sorted array of { level, minXp, rankName, perk }.
 *
 * Every metaobject field value arrives as a STRING whatever its declared type, so the coercion here is
 * not defensive noise — it is the actual shape of the data.
 */
export function normalizeRankTable(input) {
  const rows = Array.isArray(input) ? input : [];
  const out = [];
  for (const row of rows) {
    const f = fieldsOf(row);
    const level = toInt(f.level);
    const minXp = toInt(f.min_xp ?? f.minXp);
    if (level === null || minXp === null) continue; // a row we cannot read is dropped, then caught by rankTableProblem as a count mismatch
    out.push({
      level,
      minXp,
      rankName: String(f.rank_name ?? f.rankName ?? '').trim(),
      perk: String(f.perk ?? '').trim(),
    });
  }
  out.sort((a, b) => a.level - b.level);
  return out;
}

function fieldsOf(row) {
  if (row && Array.isArray(row.fields)) {
    const f = {};
    for (const x of row.fields) if (x && x.key !== undefined) f[x.key] = x.value;
    return f;
  }
  return row && typeof row === 'object' ? row : {};
}

function toInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * rankTableProblem(table)
 *
 * Returns a human-readable reason the table cannot be used, or null.
 *
 * Each of these has a specific failure it prevents, and none of them is theoretical — every one is a
 * shape a hand-edited metaobject can take:
 *
 *   empty            a Shopify read failed, or nobody ran the seed script. Levelling everyone at 1.
 *   not starting at 1  every customer sits below the floor and levelForXp has no answer for them.
 *   non-contiguous   the theme walks the table to draw the ladder; a gap renders a missing rung.
 *   duplicate level  two rows claim the same rung and which one wins is arbitrary.
 *   non-monotonic XP earning XP would move a customer DOWN a level.
 *   unnamed rank     the storefront renders an empty chip where a title should be.
 */
export function rankTableProblem(table) {
  const t = Array.isArray(table) ? table : [];
  if (t.length === 0) return 'rank table is empty — the bk_keepers_rank metaobject is missing, unseeded, or was never cached';
  if (t[0].level !== 1) return `rank table starts at level ${t[0].level}, not 1`;
  if (t[0].minXp !== 0) return `level 1 requires ${t[0].minXp} XP, but the floor must be 0`;
  for (let i = 0; i < t.length; i++) {
    if (!Number.isInteger(t[i].level)) return `row ${i} has a non-integer level`;
    if (!Number.isInteger(t[i].minXp) || t[i].minXp < 0) return `level ${t[i].level} has an invalid minimum XP`;
    if (!t[i].rankName) return `level ${t[i].level} has no rank name`;
    if (i > 0) {
      if (t[i].level === t[i - 1].level) return `level ${t[i].level} appears twice`;
      if (t[i].level !== t[i - 1].level + 1) return `levels jump from ${t[i - 1].level} to ${t[i].level} — the ladder must be contiguous`;
      if (t[i].minXp <= t[i - 1].minXp) return `level ${t[i].level} requires ${t[i].minXp} XP, which is not more than level ${t[i - 1].level}'s ${t[i - 1].minXp} — earning XP would demote`;
    }
  }
  return null;
}

/**
 * levelForXp(xp, table)
 *
 * Returns everything the storefront needs to draw the chip, the ring and the progress bar:
 *
 *   { level, rankName, perk, minXp, nextLevel, nextMinXp, xpToNext, progressPct, isMax }
 *
 * THROWS on an unusable table — see the fail-closed note at the top of this file.
 *
 * Threshold semantics are inclusive: reaching exactly min_xp reaches the level. 3,499 XP is level 7
 * and 3,500 XP is level 8, and that boundary has its own test because an off-by-one here is the kind
 * of bug a customer notices before we do.
 */
export function levelForXp(xp, table) {
  const problem = rankTableProblem(table);
  if (problem) throw new Error(`unusable rank table: ${problem}`);

  // Negative XP is possible in the ledger — someone can spend points, then refund the order that
  // earned them. The projection clamps at zero before writing, and so does this, so a customer in
  // that state reads as a level 1 Keeper rather than as an error.
  const n = Number.isFinite(Number(xp)) ? Math.max(0, Math.trunc(Number(xp))) : 0;

  let i = 0;
  while (i + 1 < table.length && n >= table[i + 1].minXp) i++;

  const here = table[i];
  const next = table[i + 1] || null;
  const isMax = !next;

  let progressPct;
  let xpToNext;
  if (isMax) {
    progressPct = 100;
    xpToNext = 0;
  } else {
    const span = next.minXp - here.minXp;
    xpToNext = next.minXp - n;
    // span is guaranteed > 0 by rankTableProblem's monotonic check, so this cannot divide by zero.
    progressPct = Math.max(0, Math.min(100, ((n - here.minXp) / span) * 100));
  }

  return {
    level: here.level,
    rankName: here.rankName,
    perk: here.perk,
    minXp: here.minXp,
    nextLevel: next ? next.level : null,
    nextMinXp: next ? next.minXp : null,
    xpToNext,
    progressPct,
    isMax,
  };
}

/**
 * maxLevel(table) — the top rung, used by the master-keeper badge rule so that "reach the top" does not
 * have to hardcode 10 in a second place. If the curve ever grows a level 11, the badge follows.
 */
export function maxLevel(table) {
  const t = Array.isArray(table) ? table : [];
  return t.length ? t[t.length - 1].level : null;
}
