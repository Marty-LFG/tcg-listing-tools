// test/unit/ebay-account-flow.test.mjs — the bootstrap orchestration (opt-in → find/create the three
// AU business policies → merchant location) exercised offline by stubbing global fetch. Covers the
// non-trivial control flow (opt-in-pending short-circuit, find-or-create, duplicate re-list) that the
// pure body-shape tests can't. The live round-trip is a settings-dashboard smoke on the connected box.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAccount, accountStatus } from '../../lib/ebay-account.mjs';
import { testShipping, testBands, fulfillmentPolicyRows } from '../helpers/ebay-config.mjs';

const ENV = { EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y', EBAY_REFRESH_TOKEN: 'fake-refresh' };
const CFG = {
  marketplaceId: 'EBAY_AU', handlingDays: 1,
  location: { merchantLocationKey: 'tcg-au-1', name: 'TCG AU', country: 'AU', postalCode: '3000' },
  policyNames: { payment: 'Pay AU', return: 'Ret AU' },
  returns: { accepted: true, days: 30, shippingCostPayer: 'BUYER' },
  // Three PINNED postage policies, one per price band. That is the normal path now the owner supplied
  // real ids: bootstrap VERIFIES them against eBay rather than creating anything.
  shipping: testShipping(),
  policies: {},
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Build a fetch stub from a { "METHOD path-substring": handler } table. handler → { status, json }.
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const u = String(url);
    calls.push({ method, url: u, body: opts.body });
    // token mint/refresh
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 'tok', expires_in: 7200 });
    for (const [key, h] of Object.entries(routes)) {
      const [m, frag] = key.split(' ');
      if (m === method && u.includes(frag)) { const r = h(calls.length); return resp(r.status, r.json); }
    }
    return resp(404, { errors: [{ errorId: 404, message: 'unstubbed ' + method + ' ' + u }] });
  };
  return calls;
}
function resp(status, json) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(json || {}) };
}

describe('bootstrapAccount — happy path (opted in, all created fresh)', () => {
  it('opts-in as needed, creates all three policies + location, reports ready', async () => {
    let optedPrograms = [];   // starts empty → opt-in flips it
    const calls = stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: optedPrograms.map((p) => ({ programType: p })) } }),
      'POST /program/opt_in': () => { optedPrograms = ['SELLING_POLICY_MANAGEMENT']; return { status: 200, json: {} }; },
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
      'POST /payment_policy': () => ({ status: 201, json: { paymentPolicyId: 'PAY-1' } }),
      'POST /return_policy': () => ({ status: 201, json: { returnPolicyId: 'RET-1' } }),
      'POST /fulfillment_policy': () => ({ status: 201, json: { fulfillmentPolicyId: 'FUL-1' } }),
      'GET /inventory/v1/location/': () => ({ status: 404, json: { errors: [{ errorId: 25802, message: 'not found' }] } }),
      'POST /inventory/v1/location/': () => ({ status: 204, json: null }),
    });
    const report = await bootstrapAccount(ENV, CFG);
    assert.equal(report.optedIn, true);
    assert.equal(report.optInPending, false);
    assert.deepEqual(report.policies.paymentPolicyId, 'PAY-1');
    assert.equal(report.policies.returnPolicyId, 'RET-1');
    // Postage policies are PINNED per band, so bootstrap verifies them and creates nothing.
    assert.deepEqual(report.bands.map((b) => b.policyId), testBands().map((b) => b.policyId));
    assert.equal(report.bandCheck.ok, true, (report.bandCheck.errors || []).join(' · '));
    assert.equal(report.location, 'tcg-au-1');
    assert.equal(report.ready, true);
    assert.deepEqual(report.errors, []);
    // the location POST body carries the AU postcode
    const locPost = calls.find((c) => c.method === 'POST' && c.url.includes('/inventory/v1/location/'));
    assert.match(locPost.body, /"postalCode":"3000"/);
  });
});

describe('bootstrapAccount — opt-in still processing', () => {
  it('short-circuits with optInPending when the program is not yet active', async () => {
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [] } }),   // never flips
      'POST /program/opt_in': () => ({ status: 200, json: {} }),
    });
    const report = await bootstrapAccount(ENV, CFG);
    assert.equal(report.optedIn, false);
    assert.equal(report.optInPending, true);
    assert.equal(report.ready, undefined);   // never reaches the ready computation
    assert.ok(report.warnings.some((w) => /24h/.test(w)));
  });
});

describe('bootstrapAccount — reuses existing policies (idempotent re-run)', () => {
  it('finds policies by name and does not create duplicates', async () => {
    const calls = stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [{ name: 'Pay AU', paymentPolicyId: 'PAY-EXIST' }] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [{ name: 'Ret AU', returnPolicyId: 'RET-EXIST' }] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
      'GET /inventory/v1/location/': () => ({ status: 200, json: { merchantLocationKey: 'tcg-au-1' } }),
    });
    const report = await bootstrapAccount(ENV, CFG);
    assert.equal(report.policies.paymentPolicyId, 'PAY-EXIST');
    assert.deepEqual(report.bands.map((b) => b.policyId), testBands().map((b) => b.policyId));
    assert.equal(report.ready, true);
    assert.equal(calls.some((c) => c.method === 'POST' && c.url.includes('_policy')), false, 'must not create when found');
    assert.equal(calls.some((c) => c.method === 'POST' && c.url.includes('/location/')), false, 'must not create existing location');
  });
});

describe('bootstrapAccount — duplicate policy (eBay allows one per category type)', () => {
  it('adopts the duplicatePolicyId eBay returns when our name is not on any existing policy', async () => {
    // Live failure 2026-07-26: create returned [20400] Duplicate policy (duplicatePolicyId=266339227012)
    // while the account's policy carried an unrelated name, so the name-based re-list found nothing.
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [{ name: 'eBay default payment', paymentPolicyId: '266339227012' }] } }),
      'POST /payment_policy': () => ({ status: 400, json: { errors: [{ errorId: 20400, message: 'Duplicate policy', parameters: [{ name: 'duplicatePolicyId', value: '266339227012' }] }] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [{ name: 'Ret AU', returnPolicyId: 'RET-EXIST' }] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
      'GET /inventory/v1/location/': () => ({ status: 200, json: { merchantLocationKey: 'tcg-au-1' } }),
    });
    const report = await bootstrapAccount(ENV, CFG);
    assert.equal(report.policies.paymentPolicyId, '266339227012');
    assert.deepEqual(report.errors, []);
    assert.equal(report.ready, true);
    assert.ok(report.warnings.some((w) => /payment policy: reusing/.test(w)), 'adopting a foreign policy must warn');
    assert.ok(report.warnings.some((w) => /eBay default payment/.test(w)), 'warning names the adopted policy');
  });
});

describe('bootstrapAccount — missing warehouse postcode', () => {
  it('reports the location error pointing at the settings field, without blocking the policies', async () => {
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [{ name: 'Pay AU', paymentPolicyId: 'PAY-EXIST' }] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [{ name: 'Ret AU', returnPolicyId: 'RET-EXIST' }] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
      'GET /inventory/v1/location/': () => ({ status: 404, json: { errors: [{ errorId: 25802, message: 'not found' }] } }),
    });
    const report = await bootstrapAccount(ENV, { ...CFG, location: { merchantLocationKey: 'tcg-au-1', country: 'AU', postalCode: '' } });
    assert.equal(report.policies.paymentPolicyId, 'PAY-EXIST');
    assert.equal(report.location, null);
    assert.equal(report.ready, false);
    assert.ok(report.errors.some((e) => /Warehouse postcode/i.test(e)));
  });
});

describe('accountStatus — read-only readiness', () => {
  it('reports ready when opted-in + all IDs cached', async () => {
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /subscription': () => ({ status: 200, json: { subscriptions: [{ subscriptionLevel: 'Basic' }] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
    });
    const st = await accountStatus(ENV, { ...CFG, policies: { paymentPolicyId: 'P', returnPolicyId: 'R' } });
    assert.equal(st.optedIn, true);
    assert.equal(st.subscriptionLevel, 'Basic');
    assert.equal(st.apiListingEntitled, true);
    assert.equal(st.ready, true);
    assert.equal(st.bandCheck.ok, true, (st.bandCheck.errors || []).join(' · '));
    assert.equal(st.bands.length, 3);
  });
  it('NOT ready when a band amount disagrees with the policy pinned to it', async () => {
    // The wrong-order paste, caught read-only before anything publishes: the ids are all real and all
    // present, they just charge the wrong band's price.
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /subscription': () => ({ status: 200, json: { subscriptions: [{ subscriptionLevel: 'Basic' }] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
    });
    const bands = testBands();
    const swapped = [{ ...bands[0], policyId: bands[1].policyId }, { ...bands[1], policyId: bands[0].policyId }, bands[2]];
    const st = await accountStatus(ENV, { ...CFG, shipping: { minBandForSlab: 1, bands: swapped }, policies: { paymentPolicyId: 'P', returnPolicyId: 'R' } });
    assert.equal(st.ready, false);
    assert.equal(st.bandCheck.ok, false);
    assert.match(st.bandCheck.errors.join(' · '), /out of order/);
  });
  it('not ready when policies are missing', async () => {
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [] } }),
      'GET /subscription': () => ({ status: 200, json: { subscriptions: [] } }),
    });
    const st = await accountStatus(ENV, CFG);
    assert.equal(st.ready, false);
  });
});
