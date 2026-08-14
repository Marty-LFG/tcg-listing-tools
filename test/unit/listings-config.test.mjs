// test/unit/listings-config.test.mjs — loadConfig's postage-band migration.
//
// The store moved from one free-postage fulfilment policy to three price-banded, buyer-paid ones. The
// dangerous case is a config file written BEFORE that: it carries a single fulfilmentPolicyId and no
// band table, and the tempting thing to do is promote that id onto a band. Nothing on disk says which
// band it was, and a wrong guess ships a $200 slab on a $1.70 untracked letter. This pins the
// fail-closed behaviour instead.
//
// TCG_CONFIG_DIR must be set BEFORE lib/listings.mjs loads (CONFIG_PATH resolves at module scope), so
// the import is dynamic. node:test gives each file its own process, so this env mutation is contained.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-listing-cfg-'));
process.env.TCG_CONFIG_DIR = dir;
const CONFIG = path.join(dir, 'ebay-listing.config.json');

const { loadConfig } = await import('../../lib/listings.mjs');
const { DEFAULT_BANDS, validateBands } = await import('../../lib/shipping-bands.mjs');

const write = (o) => fs.writeFileSync(CONFIG, JSON.stringify(o, null, 2));
const rm = () => { try { fs.unlinkSync(CONFIG); } catch { /* already gone */ } };

// exactly what the config looked like before this work
const legacy = () => ({
  marketplaceId: 'EBAY_AU', categoryTreeId: '15', listingDuration: 'GTC', handlingDays: 1,
  location: { merchantLocationKey: 'tcg-au-1', postalCode: '2289' },
  policyNames: { payment: 'TCG Managed Payments AU', return: 'TCG 30-day returns AU', fulfillment: 'TCG Free AU Post' },
  returns: { accepted: true, days: 30, shippingCostPayer: 'BUYER' },
  shipping: { serviceCode: 'AU_StandardDelivery', freeDomestic: true },
  policies: { paymentPolicyId: 'PAY', returnPolicyId: 'RET', fulfillmentPolicyId: '266339227012' },
});

describe('loadConfig — a config predating price bands', () => {
  it('gets the default band bounds but NO policy assigned to any of them', () => {
    write(legacy());
    const cfg = loadConfig();
    assert.deepEqual(cfg.shipping.bands.map((b) => b.id), DEFAULT_BANDS.map((b) => b.id));
    assert.deepEqual(cfg.shipping.bands.map((b) => b.maxCents), DEFAULT_BANDS.map((b) => b.maxCents));
    assert.deepEqual(cfg.shipping.bands.map((b) => b.costCents), DEFAULT_BANDS.map((b) => b.costCents));
    for (const b of cfg.shipping.bands) assert.equal(b.policyId, '', `${b.id} must be unassigned`);
  });
  it('does NOT promote the old single fulfilment policy onto a band', () => {
    write(legacy());
    const cfg = loadConfig();
    const ids = cfg.shipping.bands.map((b) => b.policyId);
    assert.ok(!ids.includes('266339227012'), 'the legacy policy id was guessed onto a band');
  });
  it('still keeps the payment and return policies, which ARE unambiguous', () => {
    write(legacy());
    const cfg = loadConfig();
    assert.equal(cfg.policies.paymentPolicyId, 'PAY');
    assert.equal(cfg.policies.returnPolicyId, 'RET');
  });
  it('the resulting table is structurally legal, so only the missing policies block publishing', () => {
    write(legacy());
    assert.equal(validateBands(loadConfig().shipping.bands), null);
  });
});

describe('loadConfig — a config already on bands', () => {
  it('keeps the saved bounds, costs and policy ids', () => {
    const saved = { ...legacy(), shipping: { minBandForSlab: 0, bands: [
      { id: 'a', label: 'A', maxCents: 1000, costCents: 100, copy: 'letter_untracked', serviceCode: '', serviceLabel: '', policyId: '111', policyName: '' },
      { id: 'b', label: 'B', maxCents: null, costCents: 500, copy: 'tracked', serviceCode: '', serviceLabel: '', policyId: '222', policyName: '' },
    ] } };
    write(saved);
    const cfg = loadConfig();
    assert.equal(cfg.shipping.bands.length, 2);
    assert.deepEqual(cfg.shipping.bands.map((b) => b.policyId), ['111', '222']);
    assert.equal(cfg.shipping.minBandForSlab, 0);
  });
  it('fills field defaults under a band saved before a field existed', () => {
    write({ ...legacy(), shipping: { bands: [
      { id: 'a', maxCents: 1000, costCents: 100 },
      { id: 'b', maxCents: null, costCents: 500, copy: 'tracked' },
    ] } });
    const cfg = loadConfig();
    assert.equal(cfg.shipping.bands[0].copy, 'letter_untracked');
    assert.equal(cfg.shipping.bands[0].policyName, '');
    assert.equal(cfg.shipping.bands[1].copy, 'tracked');
    // ...and the slab floor falls back to "never untracked" rather than to 0.
    assert.equal(cfg.shipping.minBandForSlab, 1);
  });
  it('a band table saved out of order is sorted and the top band loses its ceiling', () => {
    write({ ...legacy(), shipping: { bands: [
      { id: 'b', maxCents: 2000, costCents: 500 },
      { id: 'a', maxCents: 1000, costCents: 100 },
    ] } });
    const bands = loadConfig().shipping.bands;
    assert.deepEqual(bands.map((b) => b.id), ['a', 'b']);
    assert.equal(bands[1].maxCents, null);
  });
});

describe('loadConfig — a missing file is a FRESH install, not a migration', () => {
  it('falls back to the shipped defaults, policy ids included', () => {
    // Different from the legacy case on purpose: an old-shape file is EVIDENCE the owner had another
    // setup and we must not guess. No file at all is a fresh install, and it gets exactly what the
    // tracked example config would have seeded.
    rm();
    const cfg = loadConfig();
    assert.deepEqual(cfg.shipping.bands, DEFAULT_BANDS);
    assert.equal(cfg.shipping.minBandForSlab, 1);
  });
  it('carries no fulfilment policy name and no single fulfilment policy id', () => {
    rm();
    const cfg = loadConfig();
    assert.equal(cfg.policyNames.fulfillment, undefined);
    assert.equal(cfg.policies.fulfillmentPolicyId, undefined);
  });
});
