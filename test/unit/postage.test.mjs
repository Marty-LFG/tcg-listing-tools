// test/unit/postage.test.mjs — the postage classifier (lib/postage.mjs).
//
// This is the rule set that decides whether whoever is packing an order sees a black EXPRESS block or
// nothing at all, so every branch is pinned here. Pure: no network, no filesystem, no DB.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPostage, deliveryWindow, prettifyServiceCode, tierPhrase, tierRank, strongestTier,
  isUpgrade, trackingUrl, sellerHubUrl, parseShippingServiceDetails, setServiceCatalog,
  POSTAGE_TIERS, DEFAULT_POSTAGE_CONFIG,
} from '../../lib/postage.mjs';

const EMPTY = new Map();

describe('classifyPostage — tiers', () => {
  it('a free untracked letter is standard, and gets no ink anywhere', () => {
    const p = classifyPostage({ ship_service: 'AU_Regular', shipping_cents: 0 }, {}, EMPTY);
    assert.equal(p.tier, 'standard');
    assert.equal(p.tracked, false);
    assert.equal(isUpgrade(p.tier), false);
  });

  it("trusts eBay's ExpeditedService flag ahead of any guess from the code", () => {
    // The code says nothing express-ish; the flag does. The flag wins.
    const p = classifyPostage({ shipService: 'AU_ServiceX', expedited: true, shippingCents: 1295 }, {}, EMPTY);
    assert.equal(p.tier, 'express');
    assert.equal(p.tracked, true);
    assert.equal(p.paidCents, 1295);
  });

  it('reads express out of the service code when the flag is absent', () => {
    for (const code of ['AU_Express', 'AU_ExpressPost', 'AU_eBayExpressOvernight', 'AU_NextDay']) {
      assert.equal(classifyPostage({ ship_service: code }, {}, EMPTY).tier, 'express', code);
    }
  });

  it('reads tracked out of the service code', () => {
    for (const code of ['AU_RegularParcelWithTracking', 'AU_Courier', 'AU_RegisteredPost', 'AU_Satchel']) {
      const p = classifyPostage({ ship_service: code }, {}, EMPTY);
      assert.equal(p.tier, 'tracked', code);
      assert.equal(p.tracked, true, code);
    }
  });

  it('falls back to `paid` when the buyer paid for something we cannot otherwise name', () => {
    const p = classifyPostage({ ship_service: 'AU_Freight', shipping_cents: 900 }, {}, EMPTY);
    assert.equal(p.tier, 'paid');
    assert.equal(p.tracked, false);   // nothing here promises a tracking number
    // NOT an upgrade any more. `upgrade` means "the packer must do something different", and since
    // the store went to banded postage EVERY card order is paid — so treating paid as an upgrade
    // would flag the entire day's run and the flag would stop meaning anything.
    assert.equal(isUpgrade(p.tier), false);
  });
  it('the $1.70 letter band is standard, not an upgrade — it is the normal case', () => {
    // Configured in data/postsale.config.json services, which is checked before every regex.
    const cfg = { services: { AU_AusPostStandardLetter: { label: 'Regular letter', tier: 'standard', tracked: false } } };
    const p = classifyPostage({ ship_service: 'AU_AusPostStandardLetter', shipping_cents: 170 }, cfg, EMPTY);
    assert.equal(p.tier, 'standard');
    assert.equal(isUpgrade(p.tier), false);
  });
  it('the $8.26 tracked band IS an upgrade — someone has to buy a label', () => {
    const cfg = { services: { AU_AusPostStandardLetterWithTracking: { label: 'Tracked letter', tier: 'tracked', tracked: true } } };
    const p = classifyPostage({ ship_service: 'AU_AusPostStandardLetterWithTracking', shipping_cents: 826 }, cfg, EMPTY);
    assert.equal(p.tier, 'tracked');
    assert.equal(p.tracked, true);
    assert.equal(isUpgrade(p.tier), true);
  });

  it('treats collection in person as standard — there is no parcel to post', () => {
    const p = classifyPostage({ ship_service: 'AU_PickupInStore', shipping_cents: 0 }, {}, EMPTY);
    assert.equal(p.tier, 'standard');
    assert.match(p.note, /collection/i);
  });

  it('never promotes a tier when eBay says the buyer did not choose the service', () => {
    // eBay's docs: BuyerSelectedShipping=false means it defaulted the service, and an application must
    // ignore ShippingServiceSelected and ShippingServiceCost. Both look like Express here; both lie.
    const p = classifyPostage(
      { ship_service: 'AU_Express', shipping_cents: 1495, expedited: true, buyer_selected_shipping: false },
      {}, EMPTY);
    assert.equal(p.tier, 'standard');
    assert.match(p.note, /eBay chose/i);
  });

  it('ABSENT is not false — a missing BuyerSelectedShipping must not flatten a real Express order', () => {
    const p = classifyPostage({ ship_service: 'AU_Express', buyerSelectedShipping: null }, {}, EMPTY);
    assert.equal(p.tier, 'express');
  });

  it('treats eBay\'s literal "Not Selected" as no service at all', () => {
    const p = classifyPostage({ ship_service: 'Not Selected', shipping_cents: 0 }, {}, EMPTY);
    assert.equal(p.code, null);
    assert.equal(p.tier, 'standard');
    // With a cost but no service, the money is still the honest signal.
    assert.equal(classifyPostage({ ship_service: 'Not Selected', shipping_cents: 500 }, {}, EMPTY).tier, 'paid');
  });

  it('reads both the camelCase parse shape and the snake_case DB row shape', () => {
    const fromParse = classifyPostage({ shipService: 'AU_Express', shippingCents: 1200 }, {}, EMPTY);
    const fromRow = classifyPostage({ ship_service: 'AU_Express', shipping_cents: 1200 }, {}, EMPTY);
    assert.deepEqual(fromParse, fromRow);
  });
});

describe('classifyPostage — config overrides', () => {
  const cfg = { services: { AU_Regular: { tier: 'tracked', label: 'Tracked letter', note: 'use a satchel' } } };

  it('an override beats every derived rule', () => {
    const p = classifyPostage({ ship_service: 'AU_Regular', shipping_cents: 0 }, cfg, EMPTY);
    assert.equal(p.tier, 'tracked');
    assert.equal(p.label, 'Tracked letter');
    assert.equal(p.labelSource, 'config');
    assert.equal(p.note, 'use a satchel');
  });

  it('an override can declare tracked independently of the tier', () => {
    const p = classifyPostage({ ship_service: 'AU_X' }, { services: { AU_X: { tier: 'express', tracked: false } } }, EMPTY);
    assert.equal(p.tier, 'express');
    assert.equal(p.tracked, false);
  });

  it('a junk tier in the config is ignored rather than trusted', () => {
    const p = classifyPostage({ ship_service: 'AU_Express' }, { services: { AU_Express: { tier: 'platinum' } } }, EMPTY);
    assert.equal(p.tier, 'express');
    assert.ok(POSTAGE_TIERS.includes(p.tier));
  });

  it('the buyer-did-not-choose guard outranks even an override', () => {
    const p = classifyPostage({ ship_service: 'AU_Regular', buyer_selected_shipping: false }, cfg, EMPTY);
    assert.equal(p.tier, 'standard');
  });
});

describe('classifyPostage — labels', () => {
  it("uses eBay's own description when the service catalog has one", () => {
    const cat = new Map([['AU_Regular', { code: 'AU_Regular', label: 'Standard Delivery' }]]);
    const p = classifyPostage({ ship_service: 'AU_Regular' }, {}, cat);
    assert.equal(p.label, 'Standard Delivery');
    assert.equal(p.labelSource, 'ebay');
  });

  it('marks a label as derived when it is only a prettified code, so callers can prefer a phrase', () => {
    const p = classifyPostage({ ship_service: 'AU_Regular' }, {}, EMPTY);
    assert.equal(p.label, 'Regular');
    assert.equal(p.labelSource, 'derived');
    assert.equal(tierPhrase(p.tier), 'Standard delivery');
  });

  it('a catalog entry flagged tracked promotes an otherwise unreadable code', () => {
    const cat = new Map([['AU_X', { code: 'AU_X', label: 'Parcel Post plus', tracked: true }]]);
    assert.equal(classifyPostage({ ship_service: 'AU_X' }, {}, cat).tier, 'tracked');
  });
});

describe('prettifyServiceCode', () => {
  it('drops the marketplace prefix and splits camelCase', () => {
    assert.equal(prettifyServiceCode('AU_RegularParcelWithTracking'), 'Regular Parcel With Tracking');
    assert.equal(prettifyServiceCode('AU_Express'), 'Express');
    assert.equal(prettifyServiceCode('ShippingMethodStandard'), 'Shipping Method Standard');
  });
  it('is safe on empty input', () => {
    assert.equal(prettifyServiceCode(null), '');
    assert.equal(prettifyServiceCode(''), '');
  });
});

describe('tier ordering', () => {
  it('ranks weakest to strongest', () => {
    assert.ok(tierRank('standard') < tierRank('paid'));
    assert.ok(tierRank('paid') < tierRank('tracked'));
    assert.ok(tierRank('tracked') < tierRank('express'));
    assert.equal(tierRank('nonsense'), 0);
  });
  it('a combined slip takes the strongest tier across its orders', () => {
    assert.equal(strongestTier(['standard', 'express', 'paid']), 'express');
    assert.equal(strongestTier(['standard', 'standard']), 'standard');
    assert.equal(strongestTier([]), 'standard');
  });
});

describe('deliveryWindow', () => {
  it('prefers Scheduled over Estimated once eBay starts returning it', () => {
    const w = deliveryWindow({ eta_min: 'E1', eta_max: 'E2', scheduled_min: 'S1', scheduled_max: 'S2' });
    assert.deepEqual(w, { min: 'S1', max: 'S2', source: 'scheduled' });
  });
  it('uses Estimated before dispatch', () => {
    assert.deepEqual(deliveryWindow({ etaMin: 'E1', etaMax: 'E2' }), { min: 'E1', max: 'E2', source: 'estimated' });
  });
  it('mirrors a lone bound rather than returning a half window', () => {
    assert.deepEqual(deliveryWindow({ eta_max: 'E2' }), { min: 'E2', max: 'E2', source: 'estimated' });
  });
  it('reports no window at all rather than inventing one', () => {
    assert.deepEqual(deliveryWindow({}), { min: null, max: null, source: null });
  });
});

describe('url templates', () => {
  it('fills the tracking template', () => {
    assert.equal(trackingUrl(DEFAULT_POSTAGE_CONFIG, '36LB1234567890'),
      'https://auspost.com.au/mypost/track/details/36LB1234567890');
  });
  it('returns null rather than a half-built tracking url', () => {
    assert.equal(trackingUrl(DEFAULT_POSTAGE_CONFIG, ''), null);
    assert.equal(trackingUrl({ tracking_url: '' }, '123'), null);
  });
  it('escapes an order id into the seller hub link', () => {
    assert.equal(sellerHubUrl(DEFAULT_POSTAGE_CONFIG, '14-14908-12300'),
      'https://www.ebay.com.au/sh/ord/details?orderid=14-14908-12300');
  });
  it('falls back to the awaiting-postage list when the deep link cannot be built', () => {
    // eBay does not document the deep link, so a template that stops resolving must not dead-end.
    assert.equal(sellerHubUrl(DEFAULT_POSTAGE_CONFIG, null), DEFAULT_POSTAGE_CONFIG.seller_hub_fallback_url);
  });
});

describe('parseShippingServiceDetails (GeteBayDetails)', () => {
  const XML = `<GeteBayDetailsResponse>
    <ShippingServiceDetails>
      <Description>Standard Delivery</Description>
      <ShippingService>AU_Regular</ShippingService>
      <ShippingCategory>STANDARD</ShippingCategory>
      <ValidForSellingFlow>true</ValidForSellingFlow>
    </ShippingServiceDetails>
    <ShippingServiceDetails>
      <Description>Express Delivery</Description>
      <ShippingService>AU_Express</ShippingService>
      <ShippingCategory>EXPEDITED</ShippingCategory>
      <ExpeditedService>true</ExpeditedService>
      <ValidForSellingFlow>true</ValidForSellingFlow>
    </ShippingServiceDetails>
    <ShippingServiceDetails>
      <Description>Retired thing</Description>
      <ShippingService>AU_Old</ShippingService>
      <ValidForSellingFlow>false</ValidForSellingFlow>
    </ShippingServiceDetails>
  </GeteBayDetailsResponse>`;

  it('reads code, buyer-facing description and the expedited flag', () => {
    const s = parseShippingServiceDetails(XML);
    assert.equal(s.length, 3);
    assert.deepEqual(s[0].code, 'AU_Regular');
    assert.equal(s[0].label, 'Standard Delivery');
    assert.equal(s[0].expedited, false);
    assert.equal(s[1].expedited, true);
    assert.equal(s[2].valid, false);
  });

  it('feeds the catalog that classifyPostage reads', () => {
    const cat = setServiceCatalog(parseShippingServiceDetails(XML));
    const p = classifyPostage({ ship_service: 'AU_Regular' }, {}, cat);
    assert.equal(p.label, 'Standard Delivery');
    assert.equal(p.labelSource, 'ebay');
    setServiceCatalog([]);   // leave the module-level catalog as we found it
  });

  it('returns nothing rather than throwing on junk', () => {
    assert.deepEqual(parseShippingServiceDetails(''), []);
    assert.deepEqual(parseShippingServiceDetails(null), []);
  });
});
