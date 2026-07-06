// test/unit/status.test.mjs — pure helpers of the status plugin (lib/status.mjs).
// The endpoint behaviour (incl. the no-secret-leak guard) lives in the integration suite.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyPresence, versionInfo, SETTINGS, PROBES } from '../../lib/status.mjs';

describe('keyPresence', () => {
  const env = {
    POKEMONTCG_API_KEY: 'real-key-value-12345678', SCRYDEX_API_KEY: 'scrydex-key-abcdef123456',
    SCRYDEX_TEAM_ID: 'team-9876543210', EBAY_APP_ID: 'MyApp-PRD-11112222-abcd',
    TELEGRAM_BOT_TOKEN: '1234567890:AAAbbbCCCdddEEEfffGGG', LABEL_PRINTER_IP: '192.168.4.220',
  };
  const keys = keyPresence(env);
  it('reports presence as booleans, grouped by feature', () => {
    assert.equal(keys.pokemon.POKEMONTCG_API_KEY, true);
    assert.equal(keys.riftbound.SCRYDEX_API_KEY, true);
    assert.equal(keys.ebay.EBAY_APP_ID, true);
    assert.equal(keys.ebay.EBAY_CERT_ID, false);
    assert.equal(keys.telegram.TELEGRAM_BOT_TOKEN, true);
    assert.equal(keys.psa.PSA_API_TOKEN, false);
    assert.equal(keys.printer.configured, true);
  });
  it('NEVER contains a key value anywhere in the structure (GR2)', () => {
    const s = JSON.stringify(keys);
    for (const v of Object.values(env)) {
      if (v === '192.168.4.220') continue;   // printer ip/dpi are non-secret by design
      assert.ok(!s.includes(v), `leaked value ${v}`);
    }
  });
  it('empty env → all false, nothing throws', () => {
    const k = keyPresence({});
    assert.equal(k.pokemon.POKEMONTCG_API_KEY, false);
    assert.equal(k.printer.configured, false);
    assert.equal(k.grader.provider, null);
  });
});

describe('versionInfo', () => {
  const v = versionInfo();
  it('carries pkg/node/uptime (commit null outside git)', () => {
    assert.ok(v.pkg, 'package.json version');
    assert.match(v.node, /^v\d+/);
    assert.ok(v.uptime_s >= 0);
  });
});

describe('SETTINGS validators', () => {
  it('tracker: valid config passes, bad cadence/thresholds fail', () => {
    const ok = { cadence_hours: 24, thresholds: { opportunity_drop_pct: -10, momentum_rise_pct: 15, downtrend_drop_pct: -8, min_price_aud: 2 } };
    assert.equal(SETTINGS.tracker.validate(ok), null);
    assert.match(SETTINGS.tracker.validate({ ...ok, cadence_hours: 0 }), /cadence/);
    assert.match(SETTINGS.tracker.validate({ cadence_hours: 24, thresholds: { ...ok.thresholds, opportunity_drop_pct: 10 } }), /negative/);
  });
  it('repricer: never_decrease=false is REJECTED (hard invariant)', () => {
    const ok = {
      scan_enabled: false, cadence_hours: 24,
      guardrails: { min_uplift_pct: 10, min_uplift_aud: 1, min_comparable: 8, required_confidence: 'high', max_increase_pct_per_run: 40, proposal_ttl_hours: 24, never_decrease: true },
    };
    assert.equal(SETTINGS.repricer.validate(ok), null);
    const evil = JSON.parse(JSON.stringify(ok));
    evil.guardrails.never_decrease = false;
    assert.match(SETTINGS.repricer.validate(evil), /never_decrease/);
  });
  it('bulk-pricing: floors must be positive, catch-all default required', () => {
    const ok = {
      currency: 'AUD', min_price_aud: 0.49, rounding_endings: [0.49, 0.99],
      market_threshold_aud: { default: 2 },
      tiers: { default: { default: { default: 0.99 } }, pokemon: { common: { Base: 0.49 } } },
    };
    assert.equal(SETTINGS['bulk-pricing'].validate(ok), null);
    assert.match(SETTINGS['bulk-pricing'].validate({ ...ok, rounding_endings: [] }), /rounding_endings/);
    const bad = JSON.parse(JSON.stringify(ok));
    bad.tiers.pokemon.common.Base = -1;
    assert.match(SETTINGS['bulk-pricing'].validate(bad), /positive/);
    const noCatch = JSON.parse(JSON.stringify(ok));
    delete noCatch.tiers.default;
    assert.match(SETTINGS['bulk-pricing'].validate(noCatch), /catch-all/);
  });
  it('refresh: unknown bakes rejected', () => {
    assert.equal(SETTINGS.refresh.validate({ enabled: true, interval_hours: 24, bakes: ['riftbound'] }), null);
    assert.match(SETTINGS.refresh.validate({ enabled: true, interval_hours: 24, bakes: ['nope'] }), /unknown bake/);
  });
  it('read-only entries are flagged and have no validators', () => {
    for (const name of ['collectr', 'grading', 'grading-companies']) {
      assert.equal(SETTINGS[name].editable, false);
    }
  });
});

describe('PROBES allowlist', () => {
  it('every probe goes through a local /api proxy path', () => {
    for (const [src, p] of Object.entries(PROBES)) {
      assert.match(p, /^\/api\//, `${src} probe must self-fetch the proxy, not the upstream`);
    }
  });
  it('covers the key sources', () => {
    for (const s of ['pkm', 'mtg', 'swu', 'lorcana', 'rb', 'rbs', 'fx', 'pc', 'ebay']) {
      assert.ok(PROBES[s], `missing probe for ${s}`);
    }
  });
});
