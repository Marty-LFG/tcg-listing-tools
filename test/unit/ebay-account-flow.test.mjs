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
  // Payment and return are PINNED too. Nothing bootstrap touches can create a policy any more.
  policies: { paymentPolicyId: 'PAY-EXIST', returnPolicyId: 'RET-EXIST' },
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

describe('bootstrapAccount — happy path (opts in, verifies every pinned policy, makes the location)', () => {
  it('creates NO policy of any kind, and reports ready', async () => {
    let optedPrograms = [];   // starts empty → opt-in flips it
    const calls = stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: optedPrograms.map((p) => ({ programType: p })) } }),
      'POST /program/opt_in': () => { optedPrograms = ['SELLING_POLICY_MANAGEMENT']; return { status: 200, json: {} }; },
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [{ name: 'Pay AU', paymentPolicyId: 'PAY-EXIST' }] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [{ name: 'Ret AU', returnPolicyId: 'RET-EXIST' }] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
      'GET /inventory/v1/location/': () => ({ status: 404, json: { errors: [{ errorId: 25802, message: 'not found' }] } }),
      'POST /inventory/v1/location/': () => ({ status: 204, json: null }),
    });
    const report = await bootstrapAccount(ENV, CFG);
    assert.equal(report.optedIn, true);
    assert.equal(report.optInPending, false);
    assert.equal(report.policies.paymentPolicyId, 'PAY-EXIST');
    assert.equal(report.policies.returnPolicyId, 'RET-EXIST');
    assert.deepEqual(report.bands.map((b) => b.policyId), testBands().map((b) => b.policyId));
    assert.equal(report.bandCheck.ok, true, (report.bandCheck.errors || []).join(' · '));
    assert.equal(report.location, 'tcg-au-1');
    assert.equal(report.ready, true);
    assert.deepEqual(report.errors, []);

    // THE invariant of this whole module: setup never POSTs a policy. eBay business policies are the
    // terms buyers see, and the owner makes them by hand. The location IS created — that is an
    // internal warehouse record, not something a buyer ever sees.
    const posted = calls.filter((c) => c.method === 'POST' && /_policy/.test(c.url));
    assert.deepEqual(posted, [], 'setup must never create a business policy');
    const locPost = calls.find((c) => c.method === 'POST' && c.url.includes('/inventory/v1/location/'));
    assert.match(locPost.body, /"postalCode":"3000"/);
  });
});

describe('bootstrapAccount — a policy the owner never picked', () => {
  const noPins = { ...CFG, policies: {} };
  it('refuses by name for payment and return, exactly as it does for a band', async () => {
    const calls = stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [{ name: 'Pay AU', paymentPolicyId: 'PAY-EXIST' }] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [{ name: 'Ret AU', returnPolicyId: 'RET-EXIST' }] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
      'GET /inventory/v1/location/': () => ({ status: 200, json: { merchantLocationKey: 'tcg-au-1' } }),
    });
    const report = await bootstrapAccount(ENV, noPins);
    // A policy named exactly as policyNames asks IS on the account — and it still is not adopted.
    // Matching by name is a guess about which policy the owner meant; picking one is not.
    assert.equal(report.policies.paymentPolicyId, null);
    assert.equal(report.policies.returnPolicyId, null);
    assert.equal(report.ready, false);
    assert.ok(report.errors.some((e) => /payment policy: no payment policy is chosen/.test(e)), report.errors.join(' · '));
    assert.ok(report.errors.some((e) => /return policy: no return policy is chosen/.test(e)), report.errors.join(' · '));
    assert.deepEqual(calls.filter((c) => c.method === 'POST' && /_policy/.test(c.url)), []);
  });
  it('refuses when a pinned policy has been deleted on eBay, rather than replacing it', async () => {
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [] } }),      // the pin is gone
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [{ name: 'Ret AU', returnPolicyId: 'RET-EXIST' }] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
      'GET /inventory/v1/location/': () => ({ status: 200, json: { merchantLocationKey: 'tcg-au-1' } }),
    });
    const report = await bootstrapAccount(ENV, CFG);
    assert.equal(report.policies.paymentPolicyId, null);
    assert.ok(report.errors.some((e) => /no longer on this eBay account/.test(e)), report.errors.join(' · '));
    assert.equal(report.ready, false);
  });
});

describe('bootstrapAccount — an unassigned band is NEVER filled in by creating a policy', () => {
  it('reports the gap and creates nothing (lived: three duplicate policies, 2026-08-14)', async () => {
    // The real failure: the server's config predated bands, migration blanked the policy ids, and
    // setup helpfully created "TCG postage — Regular letter" beside the seller's own
    // "Paid Shipping $0 - $49.98". Same money, a name they never chose, and six policies where they
    // wanted three. A band with no policy is a configuration gap, not something to invent.
    const calls = stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [{ name: 'Pay AU', paymentPolicyId: 'PAY-EXIST' }] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [{ name: 'Ret AU', returnPolicyId: 'RET-EXIST' }] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
      'GET /inventory/v1/location/': () => ({ status: 200, json: { merchantLocationKey: 'tcg-au-1' } }),
    });
    const blanked = testBands().map((b) => ({ ...b, policyId: '' }));
    const report = await bootstrapAccount(ENV, { ...CFG, shipping: { minBandForSlab: 1, bands: blanked } });

    assert.equal(calls.some((c) => c.method === 'POST' && c.url.includes('fulfillment_policy')), false,
      'setup must not create a postage policy for an unassigned band');
    assert.equal(report.ready, false);
    assert.ok(report.bands.every((b) => b.policyId === null && b.created === false));
    // Every band is named, and every error is about the missing assignment — nothing else went wrong.
    // Six rather than three: verifyBandPolicies flags them independently of the loop, which is the
    // belt-and-braces that would have caught a duplicate even if the loop had created one.
    for (const b of testBands()) assert.ok(report.errors.some((e) => e.includes(b.label)), `no error names "${b.label}"`);
    for (const e of report.errors) assert.match(e, /no eBay policy (is )?assigned|will not create/);
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
