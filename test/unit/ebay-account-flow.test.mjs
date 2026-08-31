// test/unit/ebay-account-flow.test.mjs — the bootstrap orchestration (opt-in → find/create the three
// AU business policies → merchant location) exercised offline by stubbing global fetch. Covers the
// non-trivial control flow (opt-in-pending short-circuit, find-or-create, duplicate re-list) that the
// pure body-shape tests can't. The live round-trip is a settings-dashboard smoke on the connected box.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAccount, accountStatus } from '../../lib/ebay-account.mjs';
import { testShipping, testBands, fulfillmentPolicyRow, fulfillmentPolicyRows, paymentPolicyRow, returnPolicyRow } from '../helpers/ebay-config.mjs';

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
    // A healthy merchant location by default. accountStatus began verifying the location against
    // eBay once `ready` stopped trusting our own config file for it, and restating that in every
    // test would be noise. A test that cares declares 'GET /inventory/v1/location/' itself, which
    // matches in the loop above and wins.
    if (method === 'GET' && u.includes('/inventory/v1/location/')) {
      return resp(200, { merchantLocationKey: 'tcg-au-1', merchantLocationStatus: 'ENABLED' });
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
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
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
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
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
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
      'GET /inventory/v1/location/': () => ({ status: 200, json: { merchantLocationKey: 'tcg-au-1' } }),
    });
    const report = await bootstrapAccount(ENV, CFG);
    assert.equal(report.policies.paymentPolicyId, null);
    assert.ok(report.errors.some((e) => /no longer on this eBay account/.test(e)), report.errors.join(' · '));
    assert.equal(report.ready, false);
  });
});

describe('accountStatus — the constraint checks actually RUN against the fulfilment policies', () => {
  it('a policy with no combined-postage rule produces one info per band, not silence', async () => {
    // Guards against a vacuous green: if rowFor() ever failed to match a policy id, every fulfilment
    // check would return [] and the settings card would say "all policies meet the constraints"
    // having checked nothing at all. Three bands with no rule attached must produce three infos.
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /subscription': () => ({ status: 200, json: { subscriptions: [{ subscriptionLevel: 'Basic' }] } }),
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
    });
    const st = await accountStatus(ENV, { ...CFG, policies: { paymentPolicyId: 'PAY-EXIST', returnPolicyId: 'RET-EXIST' } });
    const combined = st.policyCheck.issues.filter((i) => i.field === 'combinedPostage');
    assert.equal(combined.length, 3, 'one per band — silence here means the checks never ran');
    assert.ok(combined.every((i) => i.severity === 'info'));
    assert.equal(st.policyCheck.ok, true, 'info is not a failure');
    assert.equal(st.ready, true);
  });
  it('and goes quiet on every band once a rule really is attached', async () => {
    const rows = testBands().map((b) => fulfillmentPolicyRow(b.policyId, b.policyName, b.costCents, b.serviceCode || 'AU_AusPostStandardLetter', { combined: true }));
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /subscription': () => ({ status: 200, json: { subscriptions: [{ subscriptionLevel: 'Basic' }] } }),
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: rows } }),
    });
    const st = await accountStatus(ENV, { ...CFG, policies: { paymentPolicyId: 'PAY-EXIST', returnPolicyId: 'RET-EXIST' } });
    assert.deepEqual(st.policyCheck.issues.filter((i) => i.field === 'combinedPostage').map(i=>i.message), []);
  });
});

describe('bootstrapAccount — a policy that is the RIGHT one but wrongly configured', () => {
  it('is not ready, and says which setting to change in Seller Hub', async () => {
    // The band ids are correct and charge the right money, so verifyBandPolicies is happy. The policy
    // is still unusable: 5-day dispatch takes Authenticity-Guarantee items out of eligibility. Two
    // different questions, and only the constraint check answers this one.
    const rows = fulfillmentPolicyRows();
    rows[0].handlingTime = { value: 5, unit: 'DAY' };
    stubFetch({
      'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
      'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: rows } }),
      'GET /inventory/v1/location/': () => ({ status: 200, json: { merchantLocationKey: 'tcg-au-1' } }),
    });
    const report = await bootstrapAccount(ENV, CFG);
    assert.equal(report.bandCheck.ok, true, 'the right policy is on the right band');
    assert.equal(report.policyCheck.ok, false, 'but it is not configured correctly');
    assert.equal(report.ready, false);
    const bad = report.policyCheck.issues.filter((i) => i.severity === 'error');
    assert.equal(bad.length, 1);
    assert.equal(bad[0].field, 'handlingTime');
    assert.match(bad[0].message, /Authenticity-Guarantee/);
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
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
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
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
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
      // Both lists have to answer for the account to be READ. Leaving them unstubbed used to pass
      // — that was the vacuous green: an unreadable list produced no complaint, so `ready` came out
      // true having confirmed nothing. It is now `degraded`, which is what happened on 2026-08-31.
      'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
      'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
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

// The failure that shipped GREEN on 2026-08-31: eBay's Account API answered 500 for the whole
// window, accountStatus reported ready:true with no error text anywhere in its reply, both stock
// tools showed a green gate, and every publish behind it failed. `bandCheck` was null on a failed
// read, `!bandCheck` satisfied bandsOk, rowFor() matched nothing so checkPolicyConstraints had
// nothing to object to — a vacuous green built out of three separate absences.
describe('accountStatus — an account it cannot READ is degraded, never ready', () => {
  const healthy = {
    'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
    'GET /subscription': () => ({ status: 200, json: { subscriptions: [{ subscriptionLevel: 'Basic' }] } }),
    'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
    'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
    'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
  };
  const PINNED = { paymentPolicyId: 'PAY-EXIST', returnPolicyId: 'RET-EXIST' };

  it('a 500 on the fulfilment list is reported, and stops the tools publishing', async () => {
    stubFetch({ ...healthy, 'GET /fulfillment_policy': () => ({ status: 500, json: { errors: [{ errorId: 20500, message: 'System error.' }] } }) });
    const st = await accountStatus(ENV, { ...CFG, policies: PINNED });
    assert.equal(st.degraded, true);
    assert.equal(st.ready, false, 'this is the exact call that answered ready:true during the outage');
    assert.ok(st.policyReadError, 'the read failure must reach the caller as text, not vanish');
    assert.match(st.policyReadError, /20500|System error/);
    assert.equal(st.policyReads.fulfillment != null, true);
    assert.equal(st.bandCheck, null, 'unverified stays unverified — the doubt belongs to `degraded`');
  });

  it('same for the payment and return lists, one at a time', async () => {
    for (const kind of ['payment_policy', 'return_policy']) {
      stubFetch({ ...healthy, ['GET /' + kind]: () => ({ status: 500, json: { errors: [{ errorId: 20500, message: 'System error.' }] } }) });
      const st = await accountStatus(ENV, { ...CFG, policies: PINNED });
      assert.equal(st.degraded, true, kind);
      assert.equal(st.ready, false, kind);
    }
  });

  it('a healthy account is still ready, and says so with no error text', async () => {
    stubFetch(healthy);
    const st = await accountStatus(ENV, { ...CFG, policies: PINNED });
    assert.equal(st.ready, true);
    assert.equal(st.degraded, false);
    assert.equal(st.policyReadError, null);
  });
});

// The other thing `ready` could not see. getInventoryLocation existed but was reachable only from
// bootstrapAccount, so `ready` asked whether OUR config held a non-empty string and nothing more.
// A location deleted or disabled in Seller Hub therefore left the tools green, createOffer
// succeeding, and publishOffer failing with an error that named nothing.
describe('accountStatus — the merchant location is checked against eBay, not against our config', () => {
  const healthy = {
    'GET /program/get_opted_in_programs': () => ({ status: 200, json: { programs: [{ programType: 'SELLING_POLICY_MANAGEMENT' }] } }),
    'GET /subscription': () => ({ status: 200, json: { subscriptions: [{ subscriptionLevel: 'Basic' }] } }),
    'GET /payment_policy': () => ({ status: 200, json: { paymentPolicies: [paymentPolicyRow()] } }),
    'GET /return_policy': () => ({ status: 200, json: { returnPolicies: [returnPolicyRow()] } }),
    'GET /fulfillment_policy': () => ({ status: 200, json: { fulfillmentPolicies: fulfillmentPolicyRows() } }),
  };
  const PINNED = { paymentPolicyId: 'PAY-EXIST', returnPolicyId: 'RET-EXIST' };

  it('a location that is GONE is a configuration fault — not ready, not degraded', async () => {
    stubFetch({ ...healthy, 'GET /inventory/v1/location/': () => ({ status: 404, json: { errors: [{ errorId: 25802, message: 'not found' }] } }) });
    const st = await accountStatus(ENV, { ...CFG, policies: PINNED });
    assert.equal(st.ready, false);
    assert.equal(st.merchantLocation.missing, true);
    assert.equal(st.merchantLocation.verified, false);
    assert.equal(st.degraded, false, 'a 404 is an answer; it is not an unreadable account');
  });

  it('a location we could not READ is degraded, like any other unreadable fact', async () => {
    stubFetch({ ...healthy, 'GET /inventory/v1/location/': () => ({ status: 500, json: { errors: [{ errorId: 25001, message: 'System error.' }] } }) });
    const st = await accountStatus(ENV, { ...CFG, policies: PINNED });
    assert.equal(st.degraded, true);
    assert.equal(st.ready, false);
    assert.equal(st.merchantLocation.unreadable, true);
    assert.equal(st.merchantLocation.missing, false);
  });

  it('a live location is reported verified, with its eBay status', async () => {
    stubFetch(healthy);
    const st = await accountStatus(ENV, { ...CFG, policies: PINNED });
    assert.equal(st.merchantLocation.verified, true);
    assert.equal(st.merchantLocation.status, 'ENABLED');
    assert.equal(st.ready, true);
  });
});
