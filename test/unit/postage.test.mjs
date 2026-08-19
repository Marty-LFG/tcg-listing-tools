// test/unit/postage.test.mjs — the postage classifier (lib/postage.mjs).
//
// This is the rule set that decides whether whoever is packing an order sees a black EXPRESS block or
// nothing at all, so every branch is pinned here. Pure: no network, no filesystem, no DB.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifyPostage, deliveryWindow, prettifyServiceCode, tierPhrase, tierRank, strongestTier,
  SERVICE_LABELS, KNOWN_SERVICES, isDerivedServiceLabel, resolveServiceLabel, curateBandServices,
  isUpgrade, trackingUrl, sellerHubUrl, parseShippingServiceDetails, setServiceCatalog,
  POSTAGE_TIERS, DEFAULT_POSTAGE_CONFIG,
} from '../../lib/postage.mjs';

const EMPTY = new Map();

describe('classifyPostage — tiers', () => {
  it('a free untracked letter is standard, and gets no ink anywhere', () => {
    // AU_AusPostStandardLetter, not AU_Regular: the latter used to look untracked only because it
    // matches none of the regexes, and that misreading is the bug KNOWN_SERVICES exists to fix.
    const p = classifyPostage({ ship_service: 'AU_AusPostStandardLetter', shipping_cents: 0 }, {}, EMPTY);
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

// These use codes NOT in SERVICE_LABELS on purpose. The curated map deliberately outranks eBay's
// catalog (eBay describes AU_Regular as the single word "Regular", on a band that promises tracking),
// so a curated code could no longer prove the catalog is consulted at all.
describe('classifyPostage — labels', () => {
  it("uses eBay's own description when the service catalog has one", () => {
    const cat = new Map([['AU_StandardDelivery', { code: 'AU_StandardDelivery', label: 'Standard Delivery' }]]);
    const p = classifyPostage({ ship_service: 'AU_StandardDelivery' }, {}, cat);
    assert.equal(p.label, 'Standard Delivery');
    assert.equal(p.labelSource, 'ebay');
  });

  it('marks a label as derived when it is only a prettified code, so callers can prefer a phrase', () => {
    const p = classifyPostage({ ship_service: 'AU_SomeService' }, {}, EMPTY);
    assert.equal(p.label, 'Some Service');
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
    // AU_Express rather than AU_Regular: the latter is curated now, and curated outranks the catalog.
    const p = classifyPostage({ ship_service: 'AU_Express' }, {}, cat);
    assert.equal(p.label, 'Express Delivery');
    assert.equal(p.labelSource, 'ebay');
    setServiceCatalog([]);   // leave the module-level catalog as we found it
  });

  it('returns nothing rather than throwing on junk', () => {
    assert.deepEqual(parseShippingServiceDetails(''), []);
    assert.deepEqual(parseShippingServiceDetails(null), []);
  });
});

// ---------------------------------------------------------------------------
// Buyer-facing service names. A live listing rendered "AUP 500 G SATCHEL SIG" in its postage table.
// ---------------------------------------------------------------------------
describe('isDerivedServiceLabel — a machine label is provable, not guessed', () => {
  it('recognises its own prettify output for every code the account actually uses', () => {
    for (const code of Object.keys(SERVICE_LABELS)) {
      assert.equal(isDerivedServiceLabel(code, prettifyServiceCode(code)), true, code);
    }
  });
  it('recognises the exact strings sitting in the live config', () => {
    assert.equal(isDerivedServiceLabel('AU_AusPostStandardLetter', 'Aus Post Standard Letter'), true);
    assert.equal(isDerivedServiceLabel('AU_AusPostPriorityLetterWithTracking', 'Aus Post Priority Letter With Tracking'), true);
    assert.equal(isDerivedServiceLabel('AU_Regular', 'Regular'), true);
    assert.equal(isDerivedServiceLabel('AUP_500G_SATCHEL_SIG', 'AUP 500 G SATCHEL SIG'), true);
  });
  it('treats blank and the raw code as machine-written too', () => {
    assert.equal(isDerivedServiceLabel('AU_Regular', ''), true);
    assert.equal(isDerivedServiceLabel('AU_Regular', '   '), true);
    assert.equal(isDerivedServiceLabel('AU_Regular', 'AU_Regular'), true);
  });
  it('leaves a name a person wrote alone', () => {
    assert.equal(isDerivedServiceLabel('AUP_500G_SATCHEL_SIG', 'Tracked satchel, signature on delivery'), false);
    assert.equal(isDerivedServiceLabel('AU_Regular', 'Tracked letter'), false);
  });
});

describe('resolveServiceLabel — owner, then curated, then eBay, then prettify', () => {
  it('heals every poisoned label in the live config to a proper name', () => {
    const heal = (code) => resolveServiceLabel(code, prettifyServiceCode(code));
    assert.deepEqual(heal('AU_AusPostStandardLetter'), { label: 'Regular letter', labelSource: 'curated' });
    assert.deepEqual(heal('AU_AusPostPriorityLetterWithTracking'), { label: 'Priority letter, tracked', labelSource: 'curated' });
    assert.deepEqual(heal('AU_Regular'), { label: 'Tracked letter', labelSource: 'curated' });
    assert.deepEqual(heal('AUP_500G_SATCHEL_SIG'), { label: 'Tracked satchel, signature on delivery', labelSource: 'curated' });
  });
  it('never prints a weight tier for the satchel — Australia Post retired that name', () => {
    const { label } = resolveServiceLabel('AUP_500G_SATCHEL_SIG', 'AUP 500 G SATCHEL SIG');
    assert.ok(!/500\s*g/i.test(label), 'label must not name a retired product: ' + label);
  });
  it('a name the owner chose survives, even one that looks machine-shaped', () => {
    assert.deepEqual(resolveServiceLabel('AU_Regular', 'Big yellow satchel'), { label: 'Big yellow satchel', labelSource: 'owner' });
    assert.deepEqual(resolveServiceLabel('AU_Regular', 'Regular', 'owner'), { label: 'Regular', labelSource: 'owner' });
  });
  it('invents nothing for a code it does not know (GR4)', () => {
    assert.deepEqual(resolveServiceLabel('AU_SomethingNew', ''), { label: 'Something New', labelSource: 'derived' });
  });
  it('consults eBay catalog only BELOW the curated map, because eBay calls AU_Regular "Regular"', () => {
    const catalog = new Map([['AU_Regular', { label: 'Regular' }], ['AU_Odd', { label: 'A Real eBay Name' }]]);
    assert.equal(resolveServiceLabel('AU_Regular', '', undefined, catalog).label, 'Tracked letter');
    assert.deepEqual(resolveServiceLabel('AU_Odd', '', undefined, catalog), { label: 'A Real eBay Name', labelSource: 'ebay' });
  });
});

describe('curateBandServices — heals on READ, so no bootstrap re-run is needed', () => {
  const poisoned = [{ id: 'letter', costCents: 170, services: [
    { code: 'AU_AusPostStandardLetter', label: 'Aus Post Standard Letter', costCents: 170, sortOrder: 1 },
    { code: 'AUP_500G_SATCHEL_SIG', label: 'AUP 500 G SATCHEL SIG', costCents: 1520, sortOrder: 3 },
  ] }];
  it('replaces the codes a buyer would have read with proper names', () => {
    const out = curateBandServices(poisoned);
    assert.deepEqual(out[0].services.map((s) => s.label), ['Regular letter', 'Tracked satchel, signature on delivery']);
  });
  it('touches nothing but the label — costs and order are byte-identical', () => {
    const out = curateBandServices(poisoned);
    assert.deepEqual(out[0].services.map((s) => [s.code, s.costCents, s.sortOrder]),
      poisoned[0].services.map((s) => [s.code, s.costCents, s.sortOrder]));
    assert.equal(out[0].costCents, 170);
  });
  it('mutates nothing and copes with bands that have no services (GR7)', () => {
    const before = JSON.stringify(poisoned);
    curateBandServices(poisoned);
    assert.equal(JSON.stringify(poisoned), before);
    assert.deepEqual(curateBandServices([{ id: 'x' }]), [{ id: 'x' }]);
    assert.deepEqual(curateBandServices(null), null);
  });
});

describe('classifyPostage uses the same names, so the buyer message matches the listing', () => {
  it('names the service properly instead of prettifying its code', () => {
    const r = classifyPostage({ shipService: 'AUP_500G_SATCHEL_SIG', shippingCents: 1520 }, {});
    assert.equal(r.label, 'Tracked satchel, signature on delivery');
    assert.equal(r.labelSource, 'curated');
  });
  it('an owner override still wins over the curated map', () => {
    const r = classifyPostage({ shipService: 'AU_Regular', shippingCents: 826 },
      { services: { AU_Regular: { label: 'My own words' } } });
    assert.equal(r.label, 'My own words');
    assert.equal(r.labelSource, 'config');
  });
});

// ---------------------------------------------------------------------------
// Two of the account's own service codes lie about what they are.
// ---------------------------------------------------------------------------
describe('KNOWN_SERVICES — the tier comes from what the service IS, not what the code says', () => {
  it('AU_Regular is TRACKED, not a plain paid letter', () => {
    // The $8.26 band. Its description promises "sent tracked with Australia Post", but the code
    // matches none of the tracked patterns, so the packer was never told to buy a label.
    const p = classifyPostage({ ship_service: 'AU_Regular', shipping_cents: 826 }, {}, EMPTY);
    assert.equal(p.tier, 'tracked');
    assert.equal(p.tracked, true);
    assert.equal(isUpgrade(p.tier), true, 'a tracked order must send the packer to buy a label');
  });

  it('AU_AusPostPriorityLetterWithTracking is tracked, NOT express', () => {
    // It matches /priorit/, so it used to read as Express Post and put a black EXPRESS block on the
    // slip for a service that is a priority letter with tracking.
    const p = classifyPostage({ ship_service: 'AU_AusPostPriorityLetterWithTracking', shipping_cents: 826 }, {}, EMPTY);
    assert.equal(p.tier, 'tracked');
    assert.equal(p.tracked, true);
  });

  it('the satchel stays tracked, and the standard letter stays out of the way', () => {
    assert.equal(classifyPostage({ ship_service: 'AUP_500G_SATCHEL_SIG', shipping_cents: 1520 }, {}, EMPTY).tier, 'tracked');
    const letter = classifyPostage({ ship_service: 'AU_AusPostStandardLetter', shipping_cents: 170 }, {}, EMPTY);
    assert.equal(letter.tier, 'standard', 'the normal band must not put ink on every slip');
    assert.equal(isUpgrade(letter.tier), false);
  });

  it('works with no config at all — the whole point, since the live config has services: {}', () => {
    for (const cfg of [undefined, {}, { services: {} }]) {
      assert.equal(classifyPostage({ ship_service: 'AU_Regular', shipping_cents: 826 }, cfg, EMPTY).tier, 'tracked');
    }
  });

  it('an owner override still wins, field by field', () => {
    const cfg = { services: { AU_Regular: { tier: 'express' } } };
    const p = classifyPostage({ ship_service: 'AU_Regular', shipping_cents: 826 }, cfg, EMPTY);
    assert.equal(p.tier, 'express', 'the owner overrode the tier');
    assert.equal(p.label, 'Tracked letter', 'and kept the curated label they did not override');
  });

  it('eBay saying it chose the service still wins over everything (the hard guard)', () => {
    const p = classifyPostage({ ship_service: 'AU_Regular', shipping_cents: 826, buyer_selected_shipping: false }, {}, EMPTY);
    assert.equal(p.tier, 'standard');
  });

  it('agrees with the facts shipped in data/postsale.config.example.json', () => {
    // The example config has carried these since 2026-08-14. Code and example must not drift.
    const example = JSON.parse(fs.readFileSync(new URL('../../data/postsale.config.example.json', import.meta.url), 'utf8'));
    for (const [code, want] of Object.entries(example.postage.services)) {
      assert.equal(KNOWN_SERVICES[code].tier, want.tier, code + ' tier');
      assert.equal(KNOWN_SERVICES[code].tracked, want.tracked, code + ' tracked');
    }
  });
});
