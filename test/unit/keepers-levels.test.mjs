// test/unit/keepers-levels.test.mjs — XP to Keeper level.
//
// Two things here earn their own tests because they are the ones that go wrong quietly:
//
//   the 3,499 / 3,500 boundary, because an off-by-one is invisible in code review and extremely
//   visible to a customer who watches their bar fill and then not level up;
//
//   fail-closed on an unusable table, because the alternative — returning level 1 — silently DEMOTES
//   every Keeper on the store the first time a config read fails, and writes that demotion to a real
//   customer metafield.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRankTable, rankTableProblem, levelForXp, maxLevel } from '../../lib/keepers-levels.mjs';

// The shipped curve: min_xp(L) = 62.5 * (L-1) * L.
const CURVE = [
  [1, 0, 'Rookie Keeper'], [2, 125, 'Sleeve Keeper'], [3, 375, 'Binder Keeper'],
  [4, 750, 'Page Keeper'], [5, 1250, 'Trade Keeper'], [6, 1875, 'Set Keeper'],
  [7, 2625, 'Shiny Keeper'], [8, 3500, 'Vault Keeper'], [9, 4500, 'Chase Keeper'],
  [10, 5625, 'Master Keeper'],
];
const TABLE = CURVE.map(([level, minXp, rankName]) => ({ level, minXp, rankName, perk: '' }));

// How the rows actually arrive from the Admin API: every value a string, whatever the declared type.
const asNodes = (rows) => rows.map(([level, minXp, rankName]) => ({
  handle: `level-${level}`,
  fields: [
    { key: 'level', value: String(level) },
    { key: 'min_xp', value: String(minXp) },
    { key: 'rank_name', value: rankName },
    { key: 'perk', value: '' },
  ],
}));

describe('normalizeRankTable', () => {
  it('reads Admin API metaobject nodes, coercing the string values', () => {
    const t = normalizeRankTable(asNodes(CURVE));
    assert.equal(t.length, 10);
    assert.deepEqual(t[7], { level: 8, minXp: 3500, rankName: 'Vault Keeper', perk: '' });
  });

  it('sorts by level, so the seed order cannot matter', () => {
    const shuffled = asNodes([CURVE[4], CURVE[0], CURVE[9], CURVE[2]]);
    assert.deepEqual(normalizeRankTable(shuffled).map((r) => r.level), [1, 3, 5, 10]);
  });

  it('survives junk input without throwing', () => {
    assert.deepEqual(normalizeRankTable(undefined), []);
    assert.deepEqual(normalizeRankTable('nonsense'), []);
    assert.deepEqual(normalizeRankTable([{ fields: [] }, null, 7]), []);
  });
});

describe('rankTableProblem — each check is a shape a hand-edited metaobject can actually take', () => {
  it('passes the shipped curve', () => {
    assert.equal(rankTableProblem(TABLE), null);
    assert.equal(rankTableProblem(normalizeRankTable(asNodes(CURVE))), null);
  });

  it('rejects an empty table — the read failed or nobody ran the seed script', () => {
    assert.match(rankTableProblem([]), /empty/);
    assert.match(rankTableProblem(undefined), /empty/);
  });

  it('rejects a ladder that does not start at level 1 with 0 XP', () => {
    assert.match(rankTableProblem(TABLE.slice(1)), /starts at level 2/);
    assert.match(rankTableProblem([{ level: 1, minXp: 50, rankName: 'X' }]), /floor must be 0/);
  });

  it('rejects gaps, because the theme walks the table to draw the ladder', () => {
    const gapped = [TABLE[0], TABLE[1], TABLE[3]];
    assert.match(rankTableProblem(gapped), /jump from 2 to 4/);
  });

  it('rejects a duplicated level', () => {
    const dup = [TABLE[0], TABLE[1], { ...TABLE[1] }];
    assert.match(rankTableProblem(dup), /appears twice/);
  });

  it('rejects a curve where earning XP would DEMOTE', () => {
    const backwards = [TABLE[0], TABLE[1], { level: 3, minXp: 100, rankName: 'Oops' }];
    assert.match(rankTableProblem(backwards), /would demote/);
  });

  it('rejects an unnamed rank, which would render an empty chip', () => {
    const unnamed = [TABLE[0], { level: 2, minXp: 125, rankName: '' }];
    assert.match(rankTableProblem(unnamed), /no rank name/);
  });
});

describe('levelForXp', () => {
  it('THE BOUNDARY: 3,499 is level 7 and 3,500 is level 8', () => {
    // Thresholds are inclusive — reaching exactly min_xp reaches the level.
    assert.equal(levelForXp(3499, TABLE).level, 7);
    assert.equal(levelForXp(3500, TABLE).level, 8);
    assert.equal(levelForXp(3500, TABLE).rankName, 'Vault Keeper');
  });

  it('holds that boundary at every rung of the shipped curve', () => {
    for (const { level, minXp } of TABLE) {
      assert.equal(levelForXp(minXp, TABLE).level, level, `${minXp} XP should be level ${level}`);
      if (minXp > 0) {
        assert.equal(levelForXp(minXp - 1, TABLE).level, level - 1, `${minXp - 1} XP should be level ${level - 1}`);
      }
    }
  });

  it('reproduces the mockup number the storefront still ships as a default', () => {
    // bk-keepers-band.liquid's demo reads "2,840 XP - 660 XP to Level 8". If the curve stopped
    // agreeing with that, the shipped example would become a lie.
    const at = levelForXp(2840, TABLE);
    assert.equal(at.level, 7);
    assert.equal(at.nextLevel, 8);
    assert.equal(at.xpToNext, 660);
  });

  it('puts a brand-new Keeper at level 1 with an empty bar', () => {
    const at = levelForXp(0, TABLE);
    assert.equal(at.level, 1);
    assert.equal(at.progressPct, 0);
    assert.equal(at.xpToNext, 125);
    assert.equal(at.isMax, false);
  });

  it('clamps negative XP to level 1 rather than erroring', () => {
    // The ledger really can go negative: spend points, then refund the order that earned them.
    assert.equal(levelForXp(-500, TABLE).level, 1);
    assert.equal(levelForXp(-500, TABLE).progressPct, 0);
  });

  it('tops out cleanly at the last rung', () => {
    const at = levelForXp(999999, TABLE);
    assert.equal(at.level, 10);
    assert.equal(at.isMax, true);
    assert.equal(at.nextLevel, null);
    assert.equal(at.xpToNext, 0);
    assert.equal(at.progressPct, 100);
  });

  it('computes progress across the span, not from zero', () => {
    // Level 7 spans 2,625 -> 3,500, so halfway is 3,062.5.
    const at = levelForXp(3062, TABLE);
    assert.equal(at.level, 7);
    assert.ok(Math.abs(at.progressPct - 50) < 0.2, `expected ~50%, got ${at.progressPct}`);
  });

  it('THROWS on an unusable table rather than quietly returning level 1', () => {
    // The whole point: a refused write leaves the correct value in place and shows up as a stalled
    // queue. A confident level 1 demotes everyone and looks like success.
    assert.throws(() => levelForXp(5000, []), /unusable rank table/);
    assert.throws(() => levelForXp(5000, undefined), /unusable rank table/);
    assert.throws(() => levelForXp(5000, TABLE.slice(1)), /unusable rank table/);
  });

  it('treats non-numeric XP as zero rather than throwing', () => {
    assert.equal(levelForXp(undefined, TABLE).level, 1);
    assert.equal(levelForXp('not a number', TABLE).level, 1);
    assert.equal(levelForXp('3500', TABLE).level, 8); // a metafield value arrives as a string
  });
});

describe('maxLevel', () => {
  it('reports the top rung so master-keeper need not hardcode 10', () => {
    assert.equal(maxLevel(TABLE), 10);
    assert.equal(maxLevel([...TABLE, { level: 11, minXp: 6875, rankName: 'Beyond' }]), 11);
    assert.equal(maxLevel([]), null);
  });
});
