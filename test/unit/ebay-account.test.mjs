// test/unit/ebay-account.test.mjs — the AU business-policy body shapes (managed payments) and the
// REST error extractor. Pure/offline: the live Account API calls are covered by the settings
// bootstrap smoke. These guard the GR-critical publish prerequisites — an eBay managed-payments AU
// listing must use immediatePay, no offline paymentMethods, a 30/60-day return, and ≤3-day handling.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { paymentBody, returnBody, fulfillmentBody } from '../../lib/ebay-account.mjs';
import { restErrors, firstErrorText } from '../../lib/ebay-rest.mjs';

const CFG = {
  marketplaceId: 'EBAY_AU',
  handlingDays: 1,
  policyNames: { payment: 'Pay AU', return: 'Ret AU', fulfillment: 'Post AU' },
  returns: { accepted: true, days: 30, shippingCostPayer: 'BUYER' },
  shipping: { serviceCode: 'AU_StandardDelivery', freeDomestic: true },
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

describe('fulfillmentBody (free AU post)', () => {
  const b = fulfillmentBody(CFG);
  it('handling ≤3 days, one free-shipping domestic AU standard service', () => {
    assert.equal(b.handlingTime.unit, 'DAY');
    assert.ok(b.handlingTime.value <= 3, 'handling must stay ≤3 days (Authenticity-Guarantee safe)');
    assert.equal(b.shippingOptions.length, 1);
    const opt = b.shippingOptions[0];
    assert.equal(opt.optionType, 'DOMESTIC');
    assert.equal(opt.costType, 'FLAT_RATE');
    const svc = opt.shippingServices[0];
    assert.equal(svc.shippingServiceCode, 'AU_StandardDelivery');
    assert.equal(svc.freeShipping, true);
  });
  it('clamps a too-long handling time to 3 days', () => {
    assert.equal(fulfillmentBody({ ...CFG, handlingDays: 10 }).handlingTime.value, 3);
  });
  it('paid domestic post carries an explicit shippingCost', () => {
    const b2 = fulfillmentBody({ ...CFG, shipping: { serviceCode: 'AU_StandardDelivery', freeDomestic: false, domesticCost: '9.95' } });
    assert.equal(b2.shippingOptions[0].shippingServices[0].freeShipping, false);
    assert.deepEqual(b2.shippingOptions[0].shippingServices[0].shippingCost, { value: '9.95', currency: 'AUD' });
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
  it('empty on a clean body', () => {
    assert.deepEqual(restErrors({}), []);
    assert.equal(firstErrorText({}), null);
  });
});
