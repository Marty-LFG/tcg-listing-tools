// test/data/configs.test.mjs — config-audit tests (BJB config.test.ts pattern):
// every owner-editable data/*.config.json must parse and keep its operational
// invariants pinned. Changing a pinned flag means deliberately editing this test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';

const cfg = (name) => JSON.parse(read(`data/${name}`));

describe('tracker.config.json', () => {
  const c = cfg('tracker.config.json');
  it('cadence + the four signal thresholds', () => {
    assert.ok(c.cadence_hours >= 1);
    const t = c.thresholds;
    assert.ok(t.opportunity_drop_pct < 0, 'opportunity is a drop (negative)');
    assert.ok(t.downtrend_drop_pct < 0, 'downtrend is a drop (negative)');
    assert.ok(t.momentum_rise_pct > 0, 'momentum is a rise (positive)');
    assert.ok(t.min_price_aud >= 0);
  });
});

describe('repricer.config.json', () => {
  const c = cfg('repricer.config.json');
  it('HARD INVARIANT: never_decrease stays true (AGENTS.md §15)', () => {
    assert.equal(c.guardrails.never_decrease, true);
  });
  it('guardrails are sane', () => {
    const g = c.guardrails;
    assert.ok(g.min_comparable >= 1);
    assert.ok(g.min_uplift_pct > 0);
    assert.ok(g.max_increase_pct_per_run > 0);
    assert.ok(['high', 'medium', 'low'].includes(g.required_confidence));
    assert.ok(c.cadence_hours >= 1);
  });
  it('own listings are excluded from comps', () => {
    assert.ok(c.exclude_seller_username, 'exclude_seller_username must be set');
  });
});

describe('bulk-pricing.config.json', () => {
  const c = cfg('bulk-pricing.config.json');
  it('AUD, positive floors, valid rounding endings', () => {
    assert.equal(c.currency, 'AUD');
    assert.ok(c.min_price_aud > 0);
    assert.ok(Array.isArray(c.rounding_endings) && c.rounding_endings.length > 0);
    for (const e of c.rounding_endings) assert.ok(e > 0 && e < 1, `ending ${e} must be a sub-dollar decimal`);
    assert.ok(c.market_threshold_aud.default > 0);
  });
  it('tier table always has the catch-all default chain', () => {
    assert.ok(c.tiers.default, 'tiers.default');
    assert.ok(c.tiers.default.default, 'tiers.default.default');
    assert.ok(c.tiers.default.default.default > 0, 'tiers.default.default.default');
  });
  it('per-game floors are positive numbers', () => {
    for (const [game, rarities] of Object.entries(c.tiers)) {
      if (game.startsWith('_')) continue;
      for (const [rar, finishes] of Object.entries(rarities)) {
        if (rar.startsWith('_')) continue;
        for (const [fin, floor] of Object.entries(finishes)) {
          if (fin.startsWith('_')) continue;
          assert.ok(typeof floor === 'number' && floor > 0, `tiers.${game}.${rar}.${fin} = ${floor}`);
        }
      }
    }
  });
});

describe('refresh.config.example.json', () => {
  const c = cfg('refresh.config.example.json');   // refresh.config.json is gitignored (server-owned); validate the tracked template
  it('interval + known bakes only', () => {
    assert.equal(typeof c.enabled, 'boolean');
    assert.ok(c.interval_hours >= 1);
    for (const b of c.bakes) assert.ok(['riftbound', 'pokemon-intl', 'pokemon-en-early', 'pokemon-mep', 'catalog-cards', 'funko'].includes(b), `unknown bake ${b}`);
  });
});

describe('backup.config.json', () => {
  const c = cfg('backup.config.json');
  it('enabled boolean, positive interval, bounded rotation, secrets OFF by default', () => {
    assert.equal(typeof c.enabled, 'boolean');
    assert.ok(c.interval_hours >= 1);
    assert.ok(Number.isInteger(c.keep) && c.keep >= 1 && c.keep <= 365, `keep=${c.keep}`);
    assert.equal(typeof c.include_secrets, 'boolean');
    assert.equal(c.include_secrets, false, 'include_secrets must default false — no silent .env duplication');
  });
});

describe('collectr.config.json', () => {
  it('market currency is a real currency code', () => {
    assert.match(cfg('collectr.config.json').market_currency, /^[A-Z]{3}$/);
  });
});

describe('grading.config.json (pre-grader tolerances)', () => {
  const c = cfg('grading.config.json');
  it('stays limited to companies with real tolerances (Golden Rule 4)', () => {
    assert.deepEqual(Object.keys(c.companies).sort(), ['BGS', 'CGC', 'PSA', 'SGC', 'TAG']);
  });
  it('pillar weights sum to 1 per company', () => {
    for (const [code, co] of Object.entries(c.companies)) {
      const sum = Object.values(co.pillarWeights).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `${code} pillarWeights sum to ${sum}`);
    }
  });
});
