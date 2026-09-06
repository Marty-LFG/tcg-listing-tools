// test/unit/keepers-badges.test.mjs — the eight badge rules.
//
// The one that gets its own section is the streak, because its failure mode is a silent wrong answer
// rather than an error: bucketing orders into calendar months in UTC files a Newcastle morning order
// into the PREVIOUS month, which breaks streaks for exactly the customers who order before lunch and
// reports nothing at all while doing it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthKey, monthIndex, hasMonthStreak, evaluateBadges, normalizeBadges, RULE_FNS, RULES,
} from '../../lib/keepers-badges.mjs';

const SYD = 600; // Australia/Sydney standard time, minutes east of UTC

describe('monthKey — the timezone trap', () => {
  it('files a 9am Newcastle order on the 1st into THIS month, not last', () => {
    // 2026-09-01T09:00 in Sydney is 2026-08-31T23:00Z. In UTC that is August; for the customer it is
    // unambiguously September. Getting this wrong breaks a streak with no error anywhere.
    const utc = '2026-08-31T23:00:00Z';
    assert.equal(monthKey(utc, 0), '2026-08', 'UTC bucketing is the bug');
    assert.equal(monthKey(utc, SYD), '2026-09', 'Sydney bucketing is the fix');
  });

  it('handles the year boundary the same way', () => {
    assert.equal(monthKey('2026-12-31T23:00:00Z', SYD), '2027-01');
    assert.equal(monthKey('2026-12-31T23:00:00Z', 0), '2026-12');
  });

  it('accepts epoch milliseconds as well as ISO strings', () => {
    assert.equal(monthKey(Date.parse('2026-09-15T00:00:00Z'), 0), '2026-09');
  });

  it('returns null on anything unparseable rather than a wrong month', () => {
    for (const bad of ['', 'nonsense', null, undefined, {}]) assert.equal(monthKey(bad, SYD), null);
  });
});

describe('monthIndex', () => {
  it('makes consecutive months consecutive integers, across a year boundary', () => {
    assert.equal(monthIndex('2027-01') - monthIndex('2026-12'), 1);
    assert.equal(monthIndex('2026-09') - monthIndex('2026-08'), 1);
  });

  it('returns null on a malformed key', () => {
    for (const bad of ['2026-13-01', '202609', '', null]) assert.equal(monthIndex(bad), null);
  });
});

describe('hasMonthStreak', () => {
  const jul = '2026-07-10T00:00:00Z', aug = '2026-08-10T00:00:00Z', sep = '2026-09-10T00:00:00Z';

  it('is true for three consecutive months', () => {
    assert.equal(hasMonthStreak([jul, aug, sep], 3, 0), true);
  });

  it('is false when a month is skipped', () => {
    assert.equal(hasMonthStreak([jul, sep], 3, 0), false);
    assert.equal(hasMonthStreak([jul, sep, '2026-10-10T00:00:00Z'], 3, 0), false);
  });

  it('counts a month once however many orders it holds', () => {
    // Spec 6.3 says "order in three different months in a row" — the unit is the month, not the order.
    const many = [jul, jul, jul, aug, aug];
    assert.equal(hasMonthStreak(many, 3, 0), false);
    assert.equal(hasMonthStreak([...many, sep], 3, 0), true);
  });

  it('finds a qualifying run anywhere in a longer history', () => {
    const history = ['2025-01-05T00:00:00Z', jul, aug, sep, '2026-12-01T00:00:00Z'];
    assert.equal(hasMonthStreak(history, 3, 0), true);
  });

  it('does not care about input order', () => {
    assert.equal(hasMonthStreak([sep, jul, aug], 3, 0), true);
  });

  it('honours the timezone offset — the same dates EARN in Sydney and fail in UTC', () => {
    // The customer-visible story: they ordered on 1 July (9am Newcastle), mid-August and mid-September.
    // Three months running, and they have every right to the badge.
    //
    //   order          Sydney month   UTC month
    //   30 Jun 23:00Z   2026-07        2026-06   <- the one that straddles
    //   15 Aug 00:00Z   2026-08        2026-08
    //   15 Sep 00:00Z   2026-09        2026-09
    //
    // Sydney sees Jul/Aug/Sep, a run of three. UTC sees Jun/Aug/Sep, which is not.
    const dates = ['2026-06-30T23:00:00Z', '2026-08-15T00:00:00Z', '2026-09-15T00:00:00Z'];
    assert.equal(hasMonthStreak(dates, 3, SYD), true, 'Sydney: Jul, Aug, Sep is a run of three');
    assert.equal(hasMonthStreak(dates, 3, 0), false, 'UTC: Jun, Aug, Sep has a hole in it');
  });

  it('handles empty and single-month input', () => {
    assert.equal(hasMonthStreak([], 3, 0), false);
    assert.equal(hasMonthStreak([jul], 1, 0), true);
    assert.equal(hasMonthStreak([jul], 3, 0), false);
    assert.equal(hasMonthStreak(undefined, 3, 0), false);
  });
});

describe('the individual rules', () => {
  it('first_order needs one accrued order', () => {
    assert.equal(RULE_FNS.first_order({ orderCount: 0 }), false);
    assert.equal(RULE_FNS.first_order({ orderCount: 1 }), true);
    assert.equal(RULE_FNS.first_order({}), false);
  });

  it('languages requires ALL of the listed languages, case-insensitively', () => {
    const need = { require: ['English', 'Japanese', 'Chinese'] };
    assert.equal(RULE_FNS.languages({ languages: ['English', 'Japanese'] }, need), false);
    assert.equal(RULE_FNS.languages({ languages: ['english', ' JAPANESE ', 'Chinese'] }, need), true);
    // An empty requirement must not award the badge to everyone.
    assert.equal(RULE_FNS.languages({ languages: ['English'] }, { require: [] }), false);
    assert.equal(RULE_FNS.languages({ languages: [] }, need), false);
  });

  it('pregrade_sku is DISABLED by a blank prefix, not matched by it', () => {
    // ''.startsWith('') is true, so a blank prefix would award this to every customer who ever ordered.
    assert.equal(RULE_FNS.pregrade_sku({ skus: ['ABC-1'] }, {}, { pregrade_sku_prefix: '' }), false);
    assert.equal(RULE_FNS.pregrade_sku({ skus: ['ABC-1'] }, {}, {}), false);
    assert.equal(RULE_FNS.pregrade_sku({ skus: ['ABC-1'] }, {}, { pregrade_sku_prefix: 'PREGRADE' }), false);
    assert.equal(RULE_FNS.pregrade_sku({ skus: ['pregrade-001'] }, {}, { pregrade_sku_prefix: 'PREGRADE' }), true);
  });

  it('level_at_least compares against the derived level', () => {
    assert.equal(RULE_FNS.level_at_least({ level: 9 }, { level: 10 }), false);
    assert.equal(RULE_FNS.level_at_least({ level: 10 }, { level: 10 }), true);
    assert.equal(RULE_FNS.level_at_least({ level: 10 }, {}), false, 'no target means no award');
  });

  it('referral and runs_verified read straight off the facts', () => {
    assert.equal(RULE_FNS.referral({ referralCount: 0 }), false);
    assert.equal(RULE_FNS.referral({ referralCount: 2 }), true);
    assert.equal(RULE_FNS.runs_verified({ runsVerified: true }), true);
    assert.equal(RULE_FNS.runs_verified({}), false);
  });

  it('every rule named in RULES is implemented', () => {
    for (const name of RULES) assert.equal(typeof RULE_FNS[name], 'function', `${name} is missing`);
  });
});

describe('evaluateBadges', () => {
  const badges = normalizeBadges([
    { badge_id: 'first-pull', rule: 'first_order', sort: '1', coming_soon: 'false' },
    { badge_id: 'mystery-keeper', rule: 'runs_verified', sort: '4', coming_soon: 'true' },
    { badge_id: 'streak-keeper', rule: 'month_streak', rule_params: '{"months":3}', sort: '7', coming_soon: 'false' },
    { badge_id: 'master-keeper', rule: 'level_at_least', rule_params: '{"level":10}', sort: '8', coming_soon: 'false' },
  ]);

  it('awards what has been earned and nothing else', () => {
    const facts = { orderCount: 3, level: 4, orderDates: ['2026-07-01T00:00:00Z'], runsVerified: false };
    const { earned } = evaluateBadges(facts, { badges, rules: {} });
    assert.deepEqual(earned, ['first-pull']);
  });

  it('NEVER awards a coming_soon badge, even when its rule would fire', () => {
    // mystery-keeper's mechanism (the Runs verification path) is a later phase, and the theme renders a
    // dashed "Coming soon" tag against it. Awarding it anyway would show it as earned AND coming soon.
    const facts = { orderCount: 1, runsVerified: true };
    const { earned, skipped } = evaluateBadges(facts, { badges, rules: {} });
    assert.equal(earned.includes('mystery-keeper'), false);
    assert.equal(skipped.find((s) => s.badgeId === 'mystery-keeper').why, 'coming_soon');
  });

  it('passes the configured timezone offset through to the streak rule', () => {
    const dates = ['2026-06-30T23:00:00Z', '2026-07-31T23:00:00Z', '2026-08-31T23:00:00Z'];
    const utc = evaluateBadges({ orderDates: dates }, { badges, rules: { streak_timezone_offset_min: 0 } });
    const syd = evaluateBadges({ orderDates: dates }, { badges, rules: { streak_timezone_offset_min: SYD } });
    assert.equal(utc.earned.includes('streak-keeper'), true, 'Jun/Jul/Aug in UTC is still a run');
    assert.equal(syd.earned.includes('streak-keeper'), true, 'Jul/Aug/Sep in Sydney is a run too');
    // The offset genuinely reaches the rule — prove it by moving the boundary.
    const edge = ['2026-08-31T23:00:00Z'];
    assert.equal(monthKey(edge[0], 0) === monthKey(edge[0], SYD), false);
  });

  it('reports an unknown rule rather than silently ignoring it', () => {
    // A typo in the metaobject would otherwise produce a badge that is displayed, described as
    // earnable, and can never be won.
    const typo = normalizeBadges([{ badge_id: 'oops', rule: 'frist_order' }]);
    const { earned, skipped } = evaluateBadges({ orderCount: 5 }, { badges: typo, rules: {} });
    assert.deepEqual(earned, []);
    assert.match(skipped[0].why, /unknown rule "frist_order"/);
  });

  it('reports a badge with no rule as manual-grant-only', () => {
    const manual = normalizeBadges([{ badge_id: 'grade-school', rule: '' }]);
    assert.match(evaluateBadges({}, { badges: manual, rules: {} }).skipped[0].why, /manual grant/);
  });

  it("one badge's failure does not stop the other seven", () => {
    const mixed = normalizeBadges([
      { badge_id: 'boom', rule: 'languages', rule_params: 'not json at all' },
      { badge_id: 'first-pull', rule: 'first_order' },
    ]);
    const { earned } = evaluateBadges({ orderCount: 1 }, { badges: mixed, rules: {} });
    assert.deepEqual(earned, ['first-pull']);
  });

  it('survives an absent config without throwing', () => {
    assert.doesNotThrow(() => evaluateBadges({}, {}));
    assert.deepEqual(evaluateBadges({}, {}).earned, []);
    assert.deepEqual(evaluateBadges(undefined, { badges: undefined }).earned, []);
  });
});

describe('normalizeBadges', () => {
  it('coerces the string booleans and JSON that metaobjects actually return', () => {
    const [b] = normalizeBadges([{
      fields: [
        { key: 'badge_id', value: 'streak-keeper' },
        { key: 'title', value: 'Streak Keeper' },
        { key: 'coming_soon', value: 'false' },
        { key: 'rule', value: 'month_streak' },
        { key: 'rule_params', value: '{"months":3}' },
        { key: 'sort', value: '7' },
      ],
    }]);
    assert.equal(b.badgeId, 'streak-keeper');
    assert.equal(b.comingSoon, false);
    assert.deepEqual(b.ruleParams, { months: 3 });
    assert.equal(b.sort, 7);
  });

  it("treats the string 'true' as true, since that is what the API returns", () => {
    const [b] = normalizeBadges([{ badge_id: 'x', coming_soon: 'true' }]);
    assert.equal(b.comingSoon, true);
  });

  it('tolerates malformed rule_params rather than taking the projection down', () => {
    const [b] = normalizeBadges([{ badge_id: 'x', rule: 'month_streak', rule_params: '{oops' }]);
    assert.deepEqual(b.ruleParams, {});
  });

  it('drops entries with no badge_id and sorts the rest', () => {
    const out = normalizeBadges([{ badge_id: 'b', sort: '2' }, { title: 'no id' }, { badge_id: 'a', sort: '1' }]);
    assert.deepEqual(out.map((x) => x.badgeId), ['a', 'b']);
  });
});
