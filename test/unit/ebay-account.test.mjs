// test/unit/ebay-account.test.mjs — the AU business-policy body shapes (managed payments) and the
// REST error extractor. Pure/offline: the live Account API calls are covered by the settings
// bootstrap smoke. These guard the GR-critical publish prerequisites — an eBay managed-payments AU
// listing must use immediatePay, no offline paymentMethods, a 30/60-day return, and ≤3-day handling.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { paymentBody, returnBody, fulfillmentBody, fulfillmentTerms, verifyBandPolicies } from '../../lib/ebay-account.mjs';
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
