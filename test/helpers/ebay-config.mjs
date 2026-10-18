// test/helpers/ebay-config.mjs — one eBay listing config for every suite that needs one.
//
// Postage is price-banded, so a publish fixture now has to carry a whole band table with a policy per
// band. Inlining that in each suite meant the same nine-line literal in seven files, and a fourth band
// would be seven more edits. This is that literal, once.
import { DEFAULT_BANDS, DEFAULT_MIN_BAND_FOR_SLAB } from '../../lib/shipping-bands.mjs';

// Short, obviously-fake policy ids per band, so an assertion failure names the band it came from.
export const TEST_BAND_POLICY = { letter: 'FUL-LETTER', tracked: 'FUL-TRACKED', signature: 'FUL-SIGNATURE' };

export function testBands() {
  return DEFAULT_BANDS.map((b) => ({ ...b, policyId: TEST_BAND_POLICY[b.id] || 'FUL-' + b.id.toUpperCase(), policyName: 'Postage ' + b.id }));
}

export function testShipping() {
  return { minBandForSlab: DEFAULT_MIN_BAND_FOR_SLAB, bands: testBands() };
}

// The full config, matching what loadConfig() hands the publish path.
export function testEbayConfig(overrides = {}) {
  return {
    marketplaceId: 'EBAY_AU',
    categoryTreeId: '15',
    listingDuration: 'GTC',
    handlingDays: 1,
    location: { merchantLocationKey: 'tcg-au-1', country: 'AU', postalCode: '2289' },
    policyNames: { payment: 'Pay', return: 'Ret' },
    returns: { accepted: false, days: 30, shippingCostPayer: 'BUYER' },
    shipping: testShipping(),
    policies: { paymentPolicyId: 'PAY', returnPolicyId: 'RET' },
    store: { defaultCategory: '', categoryByGame: {} },
    bestOffer: { enabled: false, autoAcceptPct: 95, autoDeclinePct: 78 },
    ...overrides,
  };
}

// A fulfilment policy row shaped the way the eBay Account API returns one, charging `costCents`.
// Used to fake GET /fulfillment_policy so verifyBandPolicies has something real to check against.
// `combined` attaches a combined-postage rule, the way Seller Hub → Business policies → Combined
// postage discounts does. Off by default because that is the real account's state: no rule anywhere.
// `services` ([{code,costCents}], first = the quoted one) offers a choice the way a real multi-service
// policy does; without it the policy carries the one service named by serviceCode/costCents.
export function fulfillmentPolicyRow(id, name, costCents, serviceCode = 'AU_AusPostStandardLetter', { combined = false, services = null } = {}) {
  const list = Array.isArray(services) && services.length ? services : [{ code: serviceCode, costCents }];
  const opt = {
    optionType: 'DOMESTIC',
    costType: 'FLAT_RATE',
    shippingServices: list.map((s, i) => ({
      sortOrder: i + 1, shippingServiceCode: s.code, freeShipping: false,
      shippingCost: { value: (s.costCents / 100).toFixed(2), currency: 'AUD' },
    })),
  };
  if (combined) { opt.shippingDiscountProfileId = '5000123'; opt.shippingPromotionOffered = true; }
  return {
    fulfillmentPolicyId: id,
    name,
    marketplaceId: 'EBAY_AU',
    handlingTime: { value: 1, unit: 'DAY' },
    shippingOptions: [opt],
  };
}

// The three rows that match testBands() exactly — the "everything is wired correctly" case. EXACTLY
// includes each band's whole service list: the description's options table is checked against the
// policy too, and a stub offering one service where the band lists three is a (correctly) failing
// account, not a correct one.
export function fulfillmentPolicyRows() {
  return testBands().map((b) => fulfillmentPolicyRow(b.policyId, b.policyName, b.costCents, b.serviceCode || 'AU_AusPostStandardLetter',
    { services: (b.services || []).map((s) => ({ code: s.code, costCents: s.costCents })) }));
}

// Payment and return rows shaped the way a CORRECTLY configured policy really is — immediate payment
// under managed payments, and a return policy matching the config's stated intent. Minimal stubs used
// to be fine when nothing inspected them; checkPolicyConstraints does, so a stub missing immediatePay
// now (rightly) reads as a policy the Inventory API cannot publish against.
export function paymentPolicyRow(id = 'PAY-EXIST', name = 'Pay AU') {
  return { paymentPolicyId: id, name, marketplaceId: 'EBAY_AU', immediatePay: true };
}
export function returnPolicyRow(id = 'RET-EXIST', name = 'Ret AU', returns = { accepted: true, days: 30, shippingCostPayer: 'BUYER' }) {
  if (!returns.accepted) return { returnPolicyId: id, name, marketplaceId: 'EBAY_AU', returnsAccepted: false };
  return {
    returnPolicyId: id, name, marketplaceId: 'EBAY_AU', returnsAccepted: true,
    returnPeriod: { value: returns.days, unit: 'DAY' },
    returnShippingCostPayer: returns.shippingCostPayer, refundMethod: 'MONEY_BACK',
  };
}
