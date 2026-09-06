// test/unit/keepers-config.test.mjs — the economy, read from metaobjects.
//
// Every metaobject field value arrives as a STRING whatever its declared type, so the coercion is the
// actual shape of the data rather than defensive noise. One case in here is a live hazard rather than
// a hypothetical: the string "false" is truthy in JavaScript, so a naive read of `enabled` runs the
// programme when it was switched off.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRules, normalizeTiers, configProblem, cachedConfig, CACHE_KEY,
} from '../../lib/keepers-config.mjs';
import { openKeepersDbAt, setMeta } from '../../lib/keepers-db.mjs';
import { normalizeRankTable } from '../../lib/keepers-levels.mjs';

const node = (handle, obj) => ({ handle, fields: Object.entries(obj).map(([key, value]) => ({ key, value: String(value) })) });

const RULES_NODE = node('default', {
  enabled: 'false',
  xp_per_dollar: '1', points_per_dollar: '2',
  basis: 'net_subtotal',
  review_xp: '25',
  referral_referrer_xp: '200', referral_referrer_points: '500',
  referral_referee_xp: '0', referral_referee_points: '0',
  referral_hold_days: '14', max_referrals_per_month: '10',
  checkin_xp: '50',
  redemption_min_points: '500', redemption_expiry_days: '180', redemption_code_prefix: 'BK',
  excluded_channels: '["eBay","Fetch TCG"]',
  streak_timezone_offset_min: '600',
  pregrade_sku_prefix: '',
});

const RANK_NODES = [
  node('level-1', { level: '1', min_xp: '0', rank_name: 'Rookie Keeper', perk: '' }),
  node('level-2', { level: '2', min_xp: '125', rank_name: 'Sleeve Keeper', perk: '' }),
];

describe('normalizeRules — the coercion IS the data shape', () => {
  it('reads every field at its declared type', () => {
    const r = normalizeRules([RULES_NODE]);
    assert.equal(r.enabled, false);
    assert.equal(r.xp_per_dollar, 1);
    assert.equal(r.points_per_dollar, 2);
    assert.equal(r.review_xp, 25);
    assert.equal(r.basis, 'net_subtotal');
    assert.deepEqual(r.excluded_channels, ['eBay', 'Fetch TCG']);
    assert.equal(r.streak_timezone_offset_min, 600);
  });

  it('treats the STRING "false" as false — the live hazard', () => {
    // A non-empty string is truthy, so `if (rules.enabled)` on the raw value runs the programme when
    // it was deliberately switched off. Only the literal 'true' is true.
    assert.equal(normalizeRules([RULES_NODE]).enabled, false);
    assert.equal(normalizeRules([node('default', { ...{}, enabled: 'true' })]).enabled, true);
    assert.equal(normalizeRules([node('default', { enabled: 'TRUE' })]).enabled, true);
    assert.equal(normalizeRules([node('default', { enabled: '' })]).enabled, false);
    assert.equal(normalizeRules([node('default', { enabled: '0' })]).enabled, false);
  });

  it('prefers the "default" handle but survives it being renamed', () => {
    const other = node('renamed', { enabled: 'true', xp_per_dollar: '5', points_per_dollar: '5' });
    assert.equal(normalizeRules([other]).xp_per_dollar, 5, 'falls back to the first entry');
    assert.equal(normalizeRules([other, RULES_NODE]).xp_per_dollar, 1, 'but default wins when present');
  });

  it('accepts a hand-typed comma list, because someone will type one in the admin', () => {
    const r = normalizeRules([node('default', { excluded_channels: 'eBay, Fetch TCG' })]);
    assert.deepEqual(r.excluded_channels, ['eBay', 'Fetch TCG']);
  });

  it('returns null for an unreadable number rather than NaN', () => {
    // NaN would propagate into the accrual and produce a silently zero award.
    const r = normalizeRules([node('default', { xp_per_dollar: 'one' })]);
    assert.equal(r.xp_per_dollar, null);
  });

  it('ignores a field name that is not in the schema', () => {
    const r = normalizeRules([node('default', { xp_per_doller: '99' })]);
    assert.equal(r.xp_per_doller, undefined, 'a typo must not look like it works');
  });

  it('returns null when there are no entries at all', () => {
    assert.equal(normalizeRules([]), null);
    assert.equal(normalizeRules(undefined), null);
  });
});

describe('normalizeTiers', () => {
  it('reads and sorts the tiers', () => {
    const t = normalizeTiers([
      node('tier-2500', { points_cost: '2500', percent_off: '10', label: '10% off', sort: '3' }),
      node('tier-500', { points_cost: '500', percent_off: '5', label: '5% off', sort: '1' }),
    ]);
    assert.deepEqual(t.map((x) => x.pointsCost), [500, 2500]);
    assert.equal(t[1].percentOff, 10);
  });

  it('accepts a fractional percentage', () => {
    assert.equal(normalizeTiers([node('t', { points_cost: '1000', percent_off: '7.5' })])[0].percentOff, 7.5);
  });

  it('drops a tier whose cost or percentage is missing, zero or absurd', () => {
    const t = normalizeTiers([
      node('bad', { points_cost: '', percent_off: '10' }),
      node('worse', { points_cost: '500', percent_off: '' }),
      node('zero', { points_cost: '0', percent_off: '10' }),
      node('pointless', { points_cost: '500', percent_off: '0' }),
      node('absurd', { points_cost: '500', percent_off: '150' }),
      node('good', { points_cost: '500', percent_off: '5' }),
    ]);
    assert.equal(t.length, 1);
    assert.equal(t[0].handle, 'good');
  });
});

describe('configProblem — a fetch that worked and returned nonsense is the dangerous case', () => {
  const good = {
    rules: normalizeRules([RULES_NODE]),
    ranks: normalizeRankTable(RANK_NODES),
    badges: [], tiers: [],
  };

  it('passes a usable economy', () => {
    assert.equal(configProblem(good), null);
  });

  it('refuses a missing config or missing rules', () => {
    assert.match(configProblem(null), /no config at all/);
    assert.match(configProblem({ ...good, rules: null }), /no entry/);
  });

  it('refuses unreadable rates', () => {
    assert.match(configProblem({ ...good, rules: { ...good.rules, xp_per_dollar: null } }), /not numbers/);
  });

  it('refuses an unusable rank table', () => {
    assert.match(configProblem({ ...good, ranks: [] }), /rank table:/);
  });

  it('REFUSES an empty exclusion list', () => {
    // This is how eBay orders start earning XP, against a promise printed on every page of the site.
    assert.match(configProblem({ ...good, rules: { ...good.rules, excluded_channels: [] } }), /excluded_channels is empty/);
    assert.match(configProblem({ ...good, rules: { ...good.rules, excluded_channels: null } }), /excluded_channels is empty/);
  });
});

describe('the cache', () => {
  let db;
  beforeEach(() => { db = openKeepersDbAt(':memory:'); });

  it('is empty until something is stored', () => {
    assert.equal(cachedConfig(db), null);
  });

  it('round-trips and reports its age', () => {
    const config = { rules: { xp_per_dollar: 1 }, ranks: [], badges: [], tiers: [] };
    setMeta(db, CACHE_KEY, JSON.stringify({ fetchedAt: '2026-09-06T00:00:00Z', config }));
    const c = cachedConfig(db);
    assert.equal(c.source, 'cache');
    assert.equal(c.fetchedAt, '2026-09-06T00:00:00Z');
    assert.equal(c.rules.xp_per_dollar, 1);
  });

  it('survives a corrupted cache entry rather than throwing', () => {
    setMeta(db, CACHE_KEY, 'not json');
    assert.doesNotThrow(() => cachedConfig(db));
    assert.equal(cachedConfig(db), null);
  });
});
