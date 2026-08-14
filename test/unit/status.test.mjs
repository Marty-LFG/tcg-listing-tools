// test/unit/status.test.mjs — pure helpers of the status plugin (lib/status.mjs).
// The endpoint behaviour (incl. the no-secret-leak guard) lives in the integration suite.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyPresence, versionInfo, SETTINGS, PROBES, diagTokenCheck } from '../../lib/status.mjs';
import { availableBakes } from '../../lib/refresh.mjs';
import { DEFAULT_BANDS } from '../../lib/shipping-bands.mjs';

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
  it('refresh: every registered bake is accepted, unknown rejected', () => {
    assert.equal(SETTINGS.refresh.validate({ enabled: true, interval_hours: 6, bakes: ['riftbound'] }), null);
    // Derived from the BAKES registry — so a config selecting ALL registered bakes always validates.
    const all = availableBakes().map((b) => b.name);
    assert.ok(all.includes('pokemon-mep'), 'pokemon-mep is a registered bake');
    assert.equal(SETTINGS.refresh.validate({ enabled: true, interval_hours: 6, bakes: all }), null);
    assert.match(SETTINGS.refresh.validate({ enabled: true, interval_hours: 6, bakes: ['nope'] }), /unknown bake/);
    assert.match(SETTINGS.refresh.validate({ enabled: true, interval_hours: 6, bakes: ['funko'] }), /unknown bake/);   // funko isn't a bake
  });
  const ebayOk = () => ({
    marketplaceId: 'EBAY_AU', categoryTreeId: '15', listingDuration: 'GTC', handlingDays: 1,
    location: { merchantLocationKey: 'tcg-au-1' },
    policyNames: { payment: 'P', return: 'R' },
    returns: { accepted: true, days: 30 },
    shipping: { minBandForSlab: 1, bands: JSON.parse(JSON.stringify(DEFAULT_BANDS)) },
    bestOffer: { enabled: true, autoAcceptPct: 95, autoDeclinePct: 78 },
  });
  const ebayBands = (mutate) => {
    const c = ebayOk(); mutate(c.shipping.bands, c.shipping); return SETTINGS['ebay-listing'].validate(c);
  };

  it('ebay-listing: a transposed best-offer pair cannot be saved as the default', () => {
    // Each percentage is separately legal, so only the PAIR can be wrong — and eBay rejects an
    // auto-accept below the auto-decline (25002) at publish, i.e. once per listing that inherits it.
    const ok = ebayOk();
    assert.equal(SETTINGS['ebay-listing'].validate(ok), null);
    const swapped = { ...ok, bestOffer: { enabled: true, autoAcceptPct: 71, autoDeclinePct: 94 } };
    assert.match(SETTINGS['ebay-listing'].validate(swapped), /autoAcceptPct must be ≥ autoDeclinePct/);
    // Equal is fine — eBay only objects to accept being LOWER than decline.
    assert.equal(SETTINGS['ebay-listing'].validate({ ...ok, bestOffer: { enabled: true, autoAcceptPct: 80, autoDeclinePct: 80 } }), null);
  });
  it('ebay-listing: no fulfilment policy NAME is required — each band names its own policy', () => {
    const c = ebayOk(); delete c.policyNames.fulfillment;
    assert.equal(SETTINGS['ebay-listing'].validate(c), null);
  });
  it('ebay-listing: a broken postage band table cannot be saved', () => {
    // Every one of these would publish a listing whose description contradicts what eBay charges the
    // buyer, so the form has to refuse it rather than the publish call failing per listing.
    assert.match(ebayBands((b) => { b[0].costCents = 0; }), /above zero/);                       // free postage sneaking back in
    assert.match(ebayBands((b) => { b[0].maxCents = 20000; }), /ceilings must increase/);        // overlap
    assert.match(ebayBands((b) => { b[0].costCents = 900; }), /postage must increase/);          // breaks the monotone anchor maths
    assert.match(ebayBands((b) => { b[1].policyId = b[0].policyId; }), /more than one band/);    // one policy on two bands
    assert.match(ebayBands((b) => { b[2].maxCents = 99999; }), /last band .* no ceiling/);       // a ceiling on the top band
    assert.match(ebayBands((b) => { b[0].copy = 'free'; }), /no description wording/);
    assert.match(ebayBands((b, s) => { s.bands = undefined; b.length = 0; }), /shipping\.bands/);
  });
  it('ebay-listing: a config predating bands is normalised BEFORE the form sees it', () => {
    // The lived failure: /api/settings served the raw file, so a config with no `bands` key rendered
    // empty band fields. The save builds its payload from that content and overlays only the fields
    // the form owns — and the form has no `id` field, because ids are internal. So it saved three
    // bands with no id and the PUT was refused with "band 1 needs an id", which the owner had no way
    // to act on. Normalising on READ is what makes the round trip possible at all.
    const legacy = { marketplaceId: 'EBAY_AU', shipping: { serviceCode: 'AU_StandardDelivery', freeDomestic: true } };
    const seen = SETTINGS['ebay-listing'].normalize(legacy);
    assert.equal(seen.shipping.bands.length, 3);
    for (const b of seen.shipping.bands) assert.ok(b.id, 'every band the form renders must carry its id');
    assert.equal(seen.shipping.minBandForSlab, 1);
    // ...and what comes back out of that round trip validates, so the owner can actually save.
    assert.equal(SETTINGS['ebay-listing'].validate({ ...ebayOk(), shipping: seen.shipping }), null);
  });
  it('ebay-listing: the graded-slab floor must name a band that exists', () => {
    const c = ebayOk(); c.shipping.minBandForSlab = 7;
    assert.match(SETTINGS['ebay-listing'].validate(c), /only 3 bands/);
    const d = ebayOk(); d.shipping.minBandForSlab = '1';
    assert.match(SETTINGS['ebay-listing'].validate(d), /whole number/);
  });
  it('postsale: the postage block is optional, but a bad one cannot be saved', () => {
    // The whole config as the settings form posts it, minus postage — an install that predates the
    // postage work must still validate, because loadConfig merges the defaults anyway.
    const base = {
      enabled: false, mode: 'approve', dry_run: true, poll_interval_min: 10, reply_poll_interval_min: 15,
      lookback_hours: 48, max_per_run: 10, timezone: 'Australia/Sydney', digest_hour: 9,
      ship_timing_text: 'x', signature: '-BK', brand_voice: '', style_notes: '',
      invite_offers: true, alerts: true, labels: true, listings_sync: true, fees: false, cases: true,
      quiet_hours: { enabled: true, start: '21:00', end: '08:00' }, holidays: [],
    };
    assert.equal(SETTINGS.postsale.validate(base), null);

    const postage = {
      dispatch_message: { enabled: true, include_link: false, delay_min: 20 },
      delivered_message: { enabled: true, force_approve: true },
      seller_hub_order_url: 'https://www.ebay.com.au/sh/ord/details?orderid={orderId}',
      tracking_url: 'https://auspost.com.au/mypost/track/details/{tracking}',
      services: { AU_Regular: { tier: 'tracked', label: 'Tracked letter' } },
    };
    assert.equal(SETTINGS.postsale.validate({ ...base, postage }), null);

    // A URL template that lost its placeholder builds the same link for every order — the kind of
    // break that looks fine in the settings box and sends you to the wrong page every time.
    assert.match(SETTINGS.postsale.validate({ ...base, postage: { ...postage, seller_hub_order_url: 'https://www.ebay.com.au/sh/ord' } }), /\{orderId\}/);
    assert.match(SETTINGS.postsale.validate({ ...base, postage: { ...postage, tracking_url: 'auspost.com.au/{tracking}' } }), /http\(s\) URL/);
    assert.match(SETTINGS.postsale.validate({ ...base, postage: { ...postage, services: { AU_X: { tier: 'platinum' } } } }), /tier must be/);
    assert.match(SETTINGS.postsale.validate({ ...base, postage: { ...postage, dispatch_message: { delay_min: -5 } } }), /delay_min/);
    assert.match(SETTINGS.postsale.validate({ ...base, postage: { ...postage, dispatch_message: { include_link: 'yes' } } }), /include_link must be boolean/);
    assert.match(SETTINGS.postsale.validate({ ...base, postage: [] }), /postage must be an object/);
  });

  it('read-only entries are flagged and have no validators', () => {
    for (const name of ['collectr', 'grading', 'grading-companies']) {
      assert.equal(SETTINGS[name].editable, false);
    }
  });
});

describe('diagTokenCheck (logs + triggers gate)', () => {
  it('DISABLED when DIAG_TOKEN is unset — 503, even with a token supplied', () => {
    const r = diagTokenCheck({}, 'anything');
    assert.equal(r.ok, false);
    assert.equal(r.code, 503);
  });
  it('401 when enabled but no token provided', () => {
    const r = diagTokenCheck({ DIAG_TOKEN: 'sekret-value-123456' }, '');
    assert.equal(r.ok, false);
    assert.equal(r.code, 401);
  });
  it('403 on a wrong token (incl. length mismatch — no throw)', () => {
    const env = { DIAG_TOKEN: 'sekret-value-123456' };
    assert.equal(diagTokenCheck(env, 'nope').code, 403);
    assert.equal(diagTokenCheck(env, 'sekret-value-123457').code, 403);
  });
  it('ok on an exact match', () => {
    assert.equal(diagTokenCheck({ DIAG_TOKEN: 'sekret-value-123456' }, 'sekret-value-123456').ok, true);
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
