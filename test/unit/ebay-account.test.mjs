// test/unit/ebay-account.test.mjs — the AU business-policy body shapes (managed payments) and the
// REST error extractor. Pure/offline: the live Account API calls are covered by the settings
// bootstrap smoke. These guard the GR-critical publish prerequisites — an eBay managed-payments AU
// listing must use immediatePay, no offline paymentMethods, a 30/60-day return, and ≤3-day handling.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { paymentBody, returnBody, fulfillmentBody, fulfillmentTerms, verifyBandPolicies, checkPolicyConstraints } from '../../lib/ebay-account.mjs';
import { restErrors, firstErrorText } from '../../lib/ebay-rest.mjs';
import { DEFAULT_BANDS } from '../../lib/shipping-bands.mjs';
import { testBands, fulfillmentPolicyRow, fulfillmentPolicyRows } from '../helpers/ebay-config.mjs';

const CFG = {
  marketplaceId: 'EBAY_AU',
  handlingDays: 1,
  policyNames: { payment: 'Pay AU', return: 'Ret AU' },
  returns: { accepted: true, days: 30, shippingCostPayer: 'BUYER' },
};
const ALL = [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }];

describe('paymentBody (AU managed payments)', () => {
  const b = paymentBody(CFG);
  it('immediatePay true, NO offline paymentMethods, AU marketplace', () => {
    assert.equal(b.marketplaceId, 'EBAY_AU');
    assert.equal(b.immediatePay, true);
    assert.equal(b.paymentMethods, undefined, 'must not send paymentMethods under managed payments');
    assert.deepEqual(b.categoryTypes, ALL);
    assert.equal(b.name, 'Pay AU');
  });
});

describe('returnBody', () => {
  it('accepted → 30-day money-back, buyer pays return post', () => {
    const b = returnBody(CFG);
    assert.equal(b.returnsAccepted, true);
    assert.deepEqual(b.returnPeriod, { value: 30, unit: 'DAY' });
    assert.equal(b.returnShippingCostPayer, 'BUYER');
    assert.equal(b.refundMethod, 'MONEY_BACK');
  });
  it('clamps an out-of-range period to 30 (AU allows only 30/60)', () => {
    const b = returnBody({ ...CFG, returns: { accepted: true, days: 14 } });
    assert.equal(b.returnPeriod.value, 30);
  });
  it('60-day is honoured', () => {
    assert.equal(returnBody({ ...CFG, returns: { accepted: true, days: 60 } }).returnPeriod.value, 60);
  });
  it('not accepted → returnsAccepted false, no period', () => {
    const b = returnBody({ ...CFG, returns: { accepted: false } });
    assert.equal(b.returnsAccepted, false);
    assert.equal(b.returnPeriod, undefined);
  });
});

describe('fulfillmentBody — one policy per price band, nothing free', () => {
  const LETTER = DEFAULT_BANDS[0], TRACKED = DEFAULT_BANDS[1], SIG = DEFAULT_BANDS[2];
  const b = fulfillmentBody(CFG, LETTER);
  it('handling ≤3 days, one flat-rate domestic service', () => {
    assert.equal(b.handlingTime.unit, 'DAY');
    assert.ok(b.handlingTime.value <= 3, 'handling must stay ≤3 days (Authenticity-Guarantee safe)');
    assert.equal(b.shippingOptions.length, 1);
    const opt = b.shippingOptions[0];
    assert.equal(opt.optionType, 'DOMESTIC');
    assert.equal(opt.costType, 'FLAT_RATE');
    assert.equal(opt.shippingServices[0].shippingServiceCode, LETTER.serviceCode);
  });
  it('EVERY band charges the buyer — there is no free branch left', () => {
    // A store that charges for every band should not carry a code path capable of emitting
    // freeShipping:true. That branch is deleted, not made conditional.
    for (const band of DEFAULT_BANDS) {
      const body = fulfillmentBody(CFG, band);
      const svc = body.shippingOptions[0].shippingServices[0];
      assert.equal(svc.freeShipping, false, `${band.id} must not be free`);
      assert.deepEqual(svc.shippingCost, { value: (band.costCents / 100).toFixed(2), currency: 'AUD' });
    }
  });
  it('each band renders its own amount', () => {
    assert.equal(fulfillmentBody(CFG, LETTER).shippingOptions[0].shippingServices[0].shippingCost.value, '1.70');
    assert.equal(fulfillmentBody(CFG, TRACKED).shippingOptions[0].shippingServices[0].shippingCost.value, '8.26');
    assert.equal(fulfillmentBody(CFG, SIG).shippingOptions[0].shippingServices[0].shippingCost.value, '15.20');
  });
  it('the policy is named after its band, not after one global name', () => {
    assert.equal(fulfillmentBody(CFG, { ...LETTER, policyName: 'BK Postage 1' }).name, 'BK Postage 1');
    assert.match(fulfillmentBody(CFG, { ...LETTER, policyName: '' }).name, /Regular letter/);
  });
  it('ships to the ISO country code, never the country name', () => {
    // live 2026-07-26: regionName 'Australia' → [20400] Invalid request (Invalid Location(s)=Australia)
    assert.deepEqual(b.shipToLocations.regionIncluded, [{ regionName: 'AU' }]);
    assert.deepEqual(fulfillmentBody({ ...CFG, location: { country: 'NZ' } }, LETTER).shipToLocations.regionIncluded, [{ regionName: 'NZ' }]);
  });
  it('clamps a too-long handling time to 3 days', () => {
    assert.equal(fulfillmentBody({ ...CFG, handlingDays: 10 }, LETTER).handlingTime.value, 3);
  });
});

describe('fulfillmentTerms / verifyBandPolicies — which policy is which band', () => {
  const bands = testBands();
  it('reads the amount a policy really charges', () => {
    const t = fulfillmentTerms(fulfillmentPolicyRow('X', 'n', 826));
    assert.equal(t.costCents, 826);
    assert.equal(t.free, false);
    assert.equal(t.serviceCount, 1);
  });
  it('captures EVERY domestic service, not just the one we quote', () => {
    // A policy offering a choice is a policy whose buyers see a choice. Keeping only
    // shippingServices[0] is what made the description describe one option out of three.
    const row = fulfillmentPolicyRow('X', 'Paid Shipping', 170);
    row.shippingOptions[0].shippingServices.push(
      { sortOrder: 2, shippingServiceCode: 'AU_RegularParcelWithTracking', shippingCost: { value: '9.30', currency: 'AUD' }, additionalShippingCost: { value: '2.00', currency: 'AUD' } },
      { sortOrder: 3, shippingServiceCode: 'AU_Express', shippingCost: { value: '15.95', currency: 'AUD' }, freeShipping: false },
    );
    const t = fulfillmentTerms(row);
    assert.equal(t.serviceCount, 3);
    assert.deepEqual(t.services.map((s) => s.code), ['AU_AusPostStandardLetter', 'AU_RegularParcelWithTracking', 'AU_Express']);
    assert.deepEqual(t.services.map((s) => s.costCents), [170, 930, 1595]);
    assert.equal(t.services[1].additionalCostCents, 200, 'what each extra unit adds');
    assert.equal(t.services[2].additionalCostCents, null, 'absent means eBay charges the full rate again');
    // The quoted figure stays the FIRST service, so band matching is unchanged.
    assert.equal(t.costCents, 170);
  });
  it('reads a free service as 0c rather than null', () => {
    const row = fulfillmentPolicyRow('X', 'n', 0);
    row.shippingOptions[0].shippingServices[0] = { sortOrder: 1, shippingServiceCode: 'AU_Free', freeShipping: true };
    const t = fulfillmentTerms(row);
    assert.equal(t.services[0].free, true);
    assert.equal(t.services[0].costCents, 0);
  });
  it('a correctly wired account verifies clean', () => {
    const v = verifyBandPolicies(bands, fulfillmentPolicyRows(), 'fulfillmentPolicyId');
    assert.equal(v.ok, true, v.errors.join(' · '));
    assert.equal(v.bands.length, 3);
    assert.ok(v.bands.every((b) => b.ok));
  });
  it('catches three policy ids pasted in the WRONG ORDER, and names the band each really is', () => {
    // The whole point: eBay publishes a wrong-order paste happily, and the only symptom is a $200 slab
    // charged $1.70. The costs are distinct, so a policy identifies its own band.
    const swapped = [
      { ...bands[0], policyId: bands[1].policyId },
      { ...bands[1], policyId: bands[0].policyId },
      bands[2],
    ];
    const v = verifyBandPolicies(swapped, fulfillmentPolicyRows(), 'fulfillmentPolicyId');
    assert.equal(v.ok, false);
    assert.match(v.errors.join(' · '), /out of order/);
    assert.match(v.errors[0], /Regular letter/);
    assert.match(v.errors[0], /A\$1\.70/);
    assert.match(v.errors[0], /A\$8\.26/);
  });
  it('catches an unassigned band, a missing policy, and one policy on two bands', () => {
    const rows = fulfillmentPolicyRows();
    assert.match(verifyBandPolicies([{ ...bands[0], policyId: '' }], rows, 'fulfillmentPolicyId').errors[0], /no eBay policy is assigned/);
    assert.match(verifyBandPolicies([{ ...bands[0], policyId: '999' }], rows, 'fulfillmentPolicyId').errors[0], /no longer on this eBay account/);
    const dup = [bands[0], { ...bands[1], policyId: bands[0].policyId }];
    assert.match(verifyBandPolicies(dup, rows, 'fulfillmentPolicyId').errors.join(' · '), /on both the/);
  });
  it('warns when a policy offers more than one service — the quoted amount stops being a fact', () => {
    const rows = fulfillmentPolicyRows();
    rows[0].shippingOptions[0].shippingServices.push({ sortOrder: 2, shippingServiceCode: 'AU_Express', shippingCost: { value: '12.00', currency: 'AUD' } });
    const v = verifyBandPolicies(bands, rows, 'fulfillmentPolicyId');
    assert.equal(v.ok, true, 'a second service is a warning, not a refusal');
    assert.match(v.warnings.join(' · '), /offers 2 services/);
  });
});

// The other half of the *Body builders' job. Nothing creates a policy any more, so these constraints
// are only useful read BACKWARDS: given a policy the owner built by hand in Seller Hub, does it meet
// them? Distinct from verifyBandPolicies, which asks whether it is the right policy for its band.
describe('checkPolicyConstraints', () => {
  const sev = (issues, field) => (issues.find((i) => i.field === field) || {}).severity || null;
  // Informational notes are not problems. A policy with no combined-postage rule raises one, and that
  // is the account's real state — asserting "raises nothing" on the whole list would make every other
  // fixture here depend on a setting none of them are about.
  const problems = (issues) => issues.filter((i) => i.severity !== 'info');
  const CFG3 = { ...CFG, handlingDays: 1, returns: { accepted: false, days: 30, shippingCostPayer: 'BUYER' } };

  describe('payment', () => {
    const good = { paymentPolicyId: 'P1', name: 'Managed', immediatePay: true };
    it('a correct managed-payments policy raises nothing', () => {
      assert.deepEqual(checkPolicyConstraints('payment_policy', good, CFG3), []);
    });
    it('ERROR when immediate payment is off — the Inventory API cannot publish against it', () => {
      const i = checkPolicyConstraints('payment_policy', { ...good, immediatePay: false }, CFG3);
      assert.equal(sev(i, 'immediatePay'), 'error');
      assert.match(i[0].message, /immediate payment/i);
    });
    it('warns about leftover offline payment methods under managed payments', () => {
      const i = checkPolicyConstraints('payment_policy', { ...good, paymentMethods: [{ paymentMethodType: 'PERSONAL_CHECK' }] }, CFG3);
      assert.equal(sev(i, 'paymentMethods'), 'warning');
    });
  });

  describe('return', () => {
    it('a no-returns policy matching a no-returns store raises nothing', () => {
      assert.deepEqual(checkPolicyConstraints('return_policy', { returnPolicyId: 'R1', name: 'No returns', returnsAccepted: false }, CFG3), []);
    });
    it('warns when the policy accepts returns and Settings says the store does not', () => {
      // THE lived mismatch: 30-day returns quietly sitting on a store whose own listings say
      // "No returns accepted". A warning rather than an error — buyers see the policy, and which
      // side is wrong is the owner's call, not ours.
      const row = { returnPolicyId: 'R1', name: '30-day', returnsAccepted: true, returnPeriod: { value: 30, unit: 'DAY' }, refundMethod: 'MONEY_BACK', returnShippingCostPayer: 'BUYER' };
      const i = checkPolicyConstraints('return_policy', row, CFG3);
      assert.equal(sev(i, 'returnsAccepted'), 'warning');
      assert.match(i.find((x) => x.field === 'returnsAccepted').message, /Buyers see the policy/);
    });
    it('ERROR on a return period eBay AU does not allow', () => {
      const cfg = { ...CFG3, returns: { accepted: true, days: 30, shippingCostPayer: 'BUYER' } };
      const row = { returnPolicyId: 'R1', name: 'odd', returnsAccepted: true, returnPeriod: { value: 14, unit: 'DAY' } };
      assert.equal(sev(checkPolicyConstraints('return_policy', row, cfg), 'returnPeriod'), 'error');
    });
    it('warns when the window or the return-postage payer disagrees with Settings', () => {
      const cfg = { ...CFG3, returns: { accepted: true, days: 30, shippingCostPayer: 'BUYER' } };
      const row = { returnPolicyId: 'R1', name: '60-day', returnsAccepted: true, returnPeriod: { value: 60, unit: 'DAY' }, refundMethod: 'MONEY_BACK', returnShippingCostPayer: 'SELLER' };
      const i = checkPolicyConstraints('return_policy', row, cfg);
      assert.equal(sev(i, 'returnPeriod'), 'warning');
      assert.equal(sev(i, 'returnShippingCostPayer'), 'warning');
    });
  });

  describe('fulfilment', () => {
    const band = DEFAULT_BANDS[0];
    const good = fulfillmentPolicyRow('F1', 'Paid Shipping $0 - $49.98', 170);
    it('a correct postage policy raises nothing', () => {
      assert.deepEqual(problems(checkPolicyConstraints('fulfillment_policy', good, CFG3, band)), []);
    });
    it('ERROR when dispatch runs past 3 days — Authenticity Guarantee stops applying', () => {
      const row = { ...good, handlingTime: { value: 5, unit: 'DAY' } };
      const i = checkPolicyConstraints('fulfillment_policy', row, CFG3, band);
      assert.equal(sev(i, 'handlingTime'), 'error');
      assert.match(i[0].message, /Authenticity-Guarantee/);
      assert.match(i[0].message, /Regular letter/, 'the message names the band it belongs to');
    });
    it('ERROR when the policy offers FREE postage while the description quotes an amount', () => {
      const row = JSON.parse(JSON.stringify(good));
      row.shippingOptions[0].shippingServices[0].freeShipping = true;
      const i = checkPolicyConstraints('fulfillment_policy', row, CFG3, band);
      assert.equal(sev(i, 'freeShipping'), 'error');
      assert.match(i.find((x) => x.field === 'freeShipping').message, /lying to the buyer/);
    });
    it('ERROR when there is no DOMESTIC option at all', () => {
      const row = { ...good, shippingOptions: [{ optionType: 'INTERNATIONAL', shippingServices: [] }] };
      assert.equal(sev(checkPolicyConstraints('fulfillment_policy', row, CFG3, band), 'shippingOptions'), 'error');
    });
    it('warns when dispatch disagrees with Settings, and when postage is not flat rate', () => {
      const row = JSON.parse(JSON.stringify(good));
      row.handlingTime = { value: 3, unit: 'DAY' };
      row.shippingOptions[0].costType = 'CALCULATED';
      const i = checkPolicyConstraints('fulfillment_policy', row, CFG3, band);
      assert.equal(sev(i, 'handlingTime'), 'warning');
      assert.equal(sev(i, 'costType'), 'warning');
    });
    it('says so when no combined-postage rule is attached — the blind spot that reported green', () => {
      // Nothing in the codebase could see this until fulfillmentTerms learned to read
      // shippingDiscountProfileId / shippingPromotionOffered, so every guard passed a policy on which
      // combined postage was entirely off. INFO, not a problem: the store need not combine, and no
      // description claims it. It is here so the answer is visible before any copy assumes it.
      const i = checkPolicyConstraints('fulfillment_policy', good, CFG3, band);
      assert.equal(sev(i, 'combinedPostage'), 'info');
      assert.match(i.find((x) => x.field === 'combinedPostage').message, /pays postage twice/);
      // ...and it goes quiet once a rule really is attached.
      const withRule = fulfillmentPolicyRow('F1', 'Paid Shipping', 170, 'AU_AusPostStandardLetter', { combined: true });
      assert.equal(sev(checkPolicyConstraints('fulfillment_policy', withRule, CFG3, band), 'combinedPostage'), null);
      assert.equal(fulfillmentTerms(withRule).combined, true);
      assert.equal(fulfillmentTerms(good).combined, false);
    });
    it('warns when shipToLocations carries a country NAME rather than its code', () => {
      // live 2026-07-26: regionName 'Australia' → [20400] Invalid request (Invalid Location(s))
      const row = { ...good, shipToLocations: { regionIncluded: [{ regionName: 'Australia' }] } };
      assert.equal(sev(checkPolicyConstraints('fulfillment_policy', row, CFG3, band), 'shipToLocations'), 'warning');
      const ok = { ...good, shipToLocations: { regionIncluded: [{ regionName: 'AU' }] } };
      assert.deepEqual(problems(checkPolicyConstraints('fulfillment_policy', ok, CFG3, band)), []);
    });
  });

  it('the shipped band table, built by our own fulfillmentBody, passes its own constraints', () => {
    // The builders and the checker have to agree, or the reference shape is not a reference at all.
    for (const b of DEFAULT_BANDS) {
      const body = fulfillmentBody({ ...CFG3, policyNames: { payment: 'p', return: 'r' } }, b);
      const row = { fulfillmentPolicyId: 'X', name: b.label, ...body };
      assert.deepEqual(problems(checkPolicyConstraints('fulfillment_policy', row, CFG3, b)), [], b.id);
    }
    const pay = { paymentPolicyId: 'X', name: 'p', ...paymentBody(CFG3) };
    assert.deepEqual(checkPolicyConstraints('payment_policy', pay, CFG3), []);
    const ret = { returnPolicyId: 'X', name: 'r', ...returnBody(CFG3) };
    assert.deepEqual(checkPolicyConstraints('return_policy', ret, CFG3), []);
  });
});

describe('restErrors / firstErrorText', () => {
  it('extracts errors + warnings with parameters', () => {
    const json = { errors: [{ errorId: 25709, message: 'Invalid value', longMessage: 'Invalid value for Condition', parameters: [{ name: 'Condition', value: '3000' }] }], warnings: [{ errorId: 25710, message: 'heads up' }] };
    const errs = restErrors(json);
    assert.equal(errs.length, 2);
    assert.equal(errs[0].severity, 'error');
    assert.equal(errs[0].id, 25709);
    assert.deepEqual(errs[0].parameters, ['Condition=3000']);
    assert.equal(errs[1].severity, 'warning');
    assert.match(firstErrorText(json), /25709/);
    assert.match(firstErrorText(json), /Invalid value for Condition/);
  });
  it('joins every error so a generic wrapper cannot hide the specific one', () => {
    // eBay pairs [25001] "Core Inventory Service internal error" with the error that names the real
    // problem. Reporting only errors[0] is what made a live publish failure undiagnosable.
    const json = { errors: [
      { errorId: 25001, message: 'A system error has occurred', longMessage: 'Core Inventory Service internal error' },
      { errorId: 25604, message: 'Product not found', parameters: [{ name: 'sku', value: 'BK-PKM-1' }] },
    ] };
    const t = firstErrorText(json);
    assert.match(t, /25001/);
    assert.match(t, /25604/);
    assert.match(t, /sku=BK-PKM-1/);
  });
  it('empty on a clean body', () => {
    assert.deepEqual(restErrors({}), []);
    assert.equal(firstErrorText({}), null);
  });
});
