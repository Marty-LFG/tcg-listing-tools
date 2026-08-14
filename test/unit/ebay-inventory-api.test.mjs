// test/unit/ebay-inventory-api.test.mjs — the pure Sell Inventory API payload builders + condition
// descriptor id resolution. Offline; guards the GR-critical shapes (cents→price at the edge, GTC
// fixed-price, best-offer terms, condition enum, and that grading rides as numeric descriptors).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildInventoryItemPayload, buildOfferPayload, publishListing, fitDescription } from '../../lib/channels/ebay-inventory-api.mjs';
import { toEbayListing, loadEbayCategories, buildItemDescription } from '../../lib/channels/ebay-map.mjs';
import { resolveConditionDescriptorIds, parseConditionPolicies, __test } from '../../lib/ebay-taxonomy.mjs';
import { testEbayConfig, testShipping, TEST_BAND_POLICY } from '../helpers/ebay-config.mjs';
import { money } from '../../lib/shipping-bands.mjs';

const cats = loadEbayCategories();
const CFG = testEbayConfig();
// The same band table CFG carries, so the policy on the offer and the amount in the description come
// from one place — building these against the code defaults instead would silently test nothing.
const SHIPPING = testShipping();
const rawListing = toEbayListing({ sku: 'BK-RAW-PKM-1', game: 'pokemon', name: 'Pikachu', set_name: 'Base Set', number: '58/102', rarity: 'Common', condition: 'Near Mint', language: 'EN', quantity: 3, target_price_cents: 1299, image_url: 'https://cdn/x.png', finish: 'Regular' }, null, cats, { shipping: SHIPPING });
const slabListing = toEbayListing({ sku: 'BK-PKM-9', game: 'pokemon', name: 'Charizard', set_name: 'Base Set', number: '4/102', variant: 'Holo', grading_company: 'PSA', grade: 10, cert_number: '12345678', language: 'EN', quantity: 1, target_price_cents: 500000, image_url: 'https://cdn/charizard.png', finish: 'Holofoil' }, null, cats, { shipping: SHIPPING });

describe('buildInventoryItemPayload', () => {
  it('raw → USED_VERY_GOOD, aspects as arrays, image + quantity', () => {
    const b = buildInventoryItemPayload(rawListing, { imageUrls: ['https://eps/1.jpg'] });
    assert.equal(b.condition, 'USED_VERY_GOOD');
    assert.equal(b.availability.shipToLocationAvailability.quantity, 3);
    assert.deepEqual(b.product.aspects.Game, ['Pokémon TCG']);      // aspect values are arrays
    assert.deepEqual(b.product.imageUrls, ['https://eps/1.jpg']);
    assert.ok(b.product.title.length <= 80);
  });
  it('graded → LIKE_NEW + numeric condition descriptors passed through', () => {
    const b = buildInventoryItemPayload(slabListing, { imageUrls: ['https://eps/c.jpg'], conditionDescriptors: [{ name: '27501', value: ['275010'] }, { name: '27502', value: ['275020'] }, { name: '27503', additionalInfo: '12345678' }] });
    assert.equal(b.condition, 'LIKE_NEW');
    assert.equal(b.conditionDescriptors.length, 3);
    assert.deepEqual(b.conditionDescriptors[0], { name: '27501', values: ['275010'] });
    assert.deepEqual(b.conditionDescriptors[2], { name: '27503', additionalInfo: '12345678' });
  });
});

describe('description length — the 4000 vs 500000 split', () => {
  // Live failure 2026-07-26: "[25718] Invalid value for description. The length should be between 1
  // and 4000 characters." eBay caps product.description at 4000 but offer.listingDescription at
  // 500000, and the offer's is the one buyers see. Rich copy on the offer, safe copy on the item.
  const rich = '<div style="max-width:760px">' + Array.from({ length: 60 }, (_, i) =>
    `<div style="padding:9px 12px;color:#1a1a22;font-weight:600;">row ${i} ${'x'.repeat(60)}</div>`).join('') + '</div>';

  it('leaves a description that already fits completely alone', () => {
    const short = '<div>hello</div>';
    assert.equal(fitDescription(short), short);
  });

  it('cuts an over-long description at a completed block, never mid-tag', () => {
    const out = fitDescription(rich, 4000);
    assert.ok(out.length <= 4000, out.length + ' chars');
    assert.equal((out.match(/<div/g) || []).length, (out.match(/<\/div>/g) || []).length, 'div tags must balance');
    assert.match(out, /<\/div>$/);
    assert.doesNotMatch(out, /<div[^>]*$/, 'must not end inside an open tag');
  });

  it('whitespace-minifies before it resorts to cutting anything', () => {
    const padded = '<div>\n    ' + 'y'.repeat(90) + '\n    </div>';   // 111 raw, 103 minified
    const out = fitDescription(padded, 105);
    assert.ok(out.length <= 105, out.length + ' chars');
    assert.match(out, /y{90}/, 'no content lost when whitespace alone gets it under the cap');
  });

  it('the item payload is capped and the offer carries the full copy', () => {
    const listing = { ...rawListing, descriptionHtml: rich };
    const item = buildInventoryItemPayload(listing, { imageUrls: ['https://eps/1.jpg'] });
    assert.ok(item.product.description.length <= 4000, 'inventory item must respect eBay\'s 4000 cap');
    assert.equal(buildOfferPayload(listing, CFG, {}).listingDescription, rich, 'the offer gets it untrimmed');
  });

  it('an empty description does not become the string "undefined" on the offer', () => {
    assert.equal(buildOfferPayload({ ...rawListing, descriptionHtml: '' }, CFG, {}).listingDescription, undefined);
  });
});

describe('buildOfferPayload', () => {
  it('AU fixed-price GTC with the three policy IDs, price at the cents→decimal edge', () => {
    const o = buildOfferPayload(rawListing, CFG, {});
    assert.equal(o.marketplaceId, 'EBAY_AU');
    assert.equal(o.format, 'FIXED_PRICE');
    assert.equal(o.listingDuration, 'GTC');
    assert.equal(o.categoryId, '183454');
    assert.equal(o.availableQuantity, 3);
    assert.equal(o.listingPolicies.paymentPolicyId, 'PAY');
    assert.equal(o.listingPolicies.returnPolicyId, 'RET');
    // A$12.99 is the cheapest band, so the offer carries THAT band's policy.
    assert.equal(o.listingPolicies.fulfillmentPolicyId, TEST_BAND_POLICY.letter);
    assert.equal(o.merchantLocationKey, 'tcg-au-1');
    assert.deepEqual(o.pricingSummary.price, { value: '12.99', currency: 'AUD' });   // 1299 cents
    assert.equal(o.tax, undefined, 'no tax container on AU (GST baked into price)');
  });
  it('best offer terms carry auto-accept / auto-decline prices when enabled', () => {
    const o = buildOfferPayload(slabListing, CFG, { bestOffer: { enabled: true, autoAcceptCents: 485000, autoDeclineCents: 400000 } });
    assert.equal(o.listingPolicies.bestOfferTerms.bestOfferEnabled, true);
    assert.deepEqual(o.listingPolicies.bestOfferTerms.autoAcceptPrice, { value: '4850.00', currency: 'AUD' });
    assert.deepEqual(o.listingPolicies.bestOfferTerms.autoDeclinePrice, { value: '4000.00', currency: 'AUD' });
  });
  it('no best offer container when disabled', () => {
    assert.equal(buildOfferPayload(rawListing, CFG, { bestOffer: { enabled: false } }).listingPolicies.bestOfferTerms, undefined);
  });
});

// The load-bearing round trip. Postage is banded by price, and the two things that must agree are the
// POLICY eBay charges under and the AMOUNT the description quotes. They are derived once, in
// toEbayListing, precisely so they cannot drift — this proves it at every band boundary.
describe('price band → fulfilment policy AND quoted postage, from one decision', () => {
  const SHIP = testShipping();
  const cases = [
    [199, 'letter'], [4998, 'letter'],       // ≤ A$49.98
    [4999, 'tracked'], [14998, 'tracked'],   // A$49.99 – A$149.98
    [14999, 'signature'], [250000, 'signature'],
  ];
  for (const [cents, wantBand] of cases) {
    it(`A$${(cents / 100).toFixed(2)} → the "${wantBand}" band`, () => {
      const l = toEbayListing({ sku: 'BK-B-' + cents, game: 'pokemon', name: 'Pikachu', set_name: 'Base Set', number: '58/102', rarity: 'Common', condition: 'Near Mint', language: 'EN', quantity: 1, target_price_cents: cents, image_url: 'https://cdn/x.png', finish: 'Regular' }, null, cats, { shipping: SHIP });
      const band = SHIP.bands.find((b) => b.id === wantBand);
      assert.equal(l.postageBand.id, wantBand);
      assert.equal(buildOfferPayload(l, CFG, {}).listingPolicies.fulfillmentPolicyId, band.policyId);
      assert.ok(l.descriptionHtml.includes(money(band.costCents)), `description does not quote ${money(band.costCents)}`);
      for (const other of SHIP.bands) {
        if (other.id === wantBand) continue;
        assert.ok(!l.descriptionHtml.includes(money(other.costCents)), `description also quotes the "${other.id}" amount`);
      }
    });
  }
  it('a graded slab is lifted off the untracked band even when its price sits there', () => {
    const l = toEbayListing({ sku: 'BK-SLAB-CHEAP', game: 'pokemon', name: 'Charizard', set_name: 'Base Set', number: '4/102', variant: 'Holo', grading_company: 'PSA', grade: 8, cert_number: '999', language: 'EN', quantity: 1, target_price_cents: 2000, image_url: 'https://cdn/c.png', finish: 'Holofoil' }, null, cats, { shipping: SHIP });
    assert.equal(l.postageBand.id, 'tracked');
    assert.equal(buildOfferPayload(l, CFG, {}).listingPolicies.fulfillmentPolicyId, TEST_BAND_POLICY.tracked);
  });
  it('the EPS re-render quotes the SAME band as the offer', () => {
    // buildItemDescription runs again after the image upload. Resolving a different band there would
    // publish a description quoting an amount the pinned policy does not charge.
    const item = { sku: 'BK-EPS', game: 'pokemon', name: 'Pikachu', set_name: 'Base Set', number: '58/102', rarity: 'Common', condition: 'Near Mint', language: 'EN', quantity: 1, target_price_cents: 9999, image_url: 'https://cdn/x.png', finish: 'Regular' };
    const l = toEbayListing(item, null, cats, { shipping: SHIP });
    const rerendered = buildItemDescription(item, { imageUrl: 'https://eps/1.jpg', cats, shipping: SHIP });
    const band = SHIP.bands.find((b) => b.id === 'tracked');
    assert.equal(l.postageBand.id, 'tracked');
    assert.ok(rerendered.includes(money(band.costCents)), 're-render lost the band');
    assert.ok(!rerendered.includes(money(SHIP.bands[0].costCents)), 're-render fell back to the cheapest band');
  });
  it('publishing refuses, by name, when the band has no policy', async () => {
    const noPolicy = { minBandForSlab: 1, bands: SHIP.bands.map((b) => ({ ...b, policyId: '' })) };
    const l = toEbayListing({ sku: 'BK-NOPOL', game: 'pokemon', name: 'Pikachu', set_name: 'Base Set', number: '58/102', rarity: 'Common', condition: 'Near Mint', language: 'EN', quantity: 1, target_price_cents: 500, image_url: 'https://cdn/x.png', finish: 'Regular' }, null, cats, { shipping: noPolicy });
    const r = await publishListing({}, { listing: l, cfg: { ...CFG, shipping: noPolicy }, imageUrls: ['https://cdn/x.png'] });
    assert.equal(r.ok, false);
    assert.match(r.error, /no eBay policy assigned/);
    // and it refused BEFORE touching the inventory item, so nothing half-built is left on eBay
    assert.deepEqual(r.steps.map((s) => s.step), ['postage_band']);
  });
});

describe('resolveConditionDescriptorIds (baked fallback, no network)', () => {
  it('graded PSA 10 → grader + grade ids from the baked table + cert as free text', async () => {
    const out = await resolveConditionDescriptorIds({}, slabListing.conditionDescriptors, { graded: true });
    const byName = Object.fromEntries(out.descriptors.map((d) => [d.name, d]));
    assert.deepEqual(byName['27501'].value, ['275010']);   // PSA
    assert.deepEqual(byName['27502'].value, ['275020']);   // grade 10 (baked)
    assert.equal(byName['27503'].additionalInfo, '12345678');
    assert.deepEqual(out.unresolved, []);
  });
  it('raw NM → card-condition id from the baked table', async () => {
    const out = await resolveConditionDescriptorIds({}, rawListing.conditionDescriptors, { graded: false });
    assert.deepEqual(out.descriptors[0], { name: '40001', value: ['400010'] });   // Near Mint or Better
  });
  it('an unbaked grade with no live data is reported unresolved (never guessed)', async () => {
    const out = await resolveConditionDescriptorIds({}, [{ name: 'Professional Grader', value: 'PSA' }, { name: 'Grade', value: '9.5' }], { graded: true });
    assert.ok(out.unresolved.some((u) => /Grade/.test(u)), 'grade 9.5 has no baked id → unresolved');
  });
});

describe('resolveConditionDescriptorIds (live metadata beats the baked table)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const resp = (json, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) });

  it("matches eBay's sentence-case value name against our title-case enum", async () => {
    // Regression: the lookup was an exact key hit, so 'Near Mint or Better' never matched eBay's
    // 'Near mint or better'. Live data could never win and every listing silently shipped baked ids.
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/identity/v1/oauth2/token')) return resp({ access_token: 'tok', expires_in: 7200 });
      if (u.includes('get_item_condition_policies')) {
        return resp({ itemConditionPolicies: [{ categoryId: '183050', itemConditions: [
          { conditionId: '4000', conditionDescriptors: [{ name: '40001', conditionDescriptorValues: [
            { conditionDescriptorValueId: '400099', conditionDescriptorValueName: 'Near mint or better' }] }] }] }] });
      }
      return resp({}, 404);
    };
    const out = await resolveConditionDescriptorIds({ EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y' },
      [{ name: 'Card Condition', value: 'Near Mint or Better' }], { graded: false, categoryId: '183050' });
    assert.deepEqual(out.descriptors[0], { name: '40001', value: ['400099'] }, 'live id, not the baked 400010');
    assert.equal(out.source, 'live');
  });

  it('an unknown descriptor name is reported unresolved, never silently dropped', async () => {
    const out = await resolveConditionDescriptorIds({}, [{ name: 'Sparkliness', value: 'high' }], { graded: false });
    assert.deepEqual(out.descriptors, []);
    assert.ok(out.unresolved.some((u) => /Sparkliness/.test(u)), 'must block publish rather than ship a bare condition');
  });
});

describe('publishListing guards', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  it('refuses a trading-card condition with no resolved descriptors, without calling eBay', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error('must not reach eBay'); };
    const res = await publishListing({}, { listing: rawListing, cfg: CFG, imageUrls: ['https://eps/1.jpg'], conditionDescriptors: [] });
    assert.equal(res.ok, false);
    assert.match(res.error, /requires conditionDescriptors/);
    assert.equal(called, false, 'the guard must fire before the PUT');
    assert.ok(res.requestBody, 'the rejected body is returned for diagnosis');
  });
});

describe('parseConditionPolicies (defensive live parse)', () => {
  it('extracts grader + grade value ids from a getItemConditionPolicies-shaped body', () => {
    const json = { itemConditionPolicies: [{ categoryId: '183454', itemConditions: [
      { conditionId: '2750', conditionDescriptors: [
        { name: '27501', conditionDescriptorValues: [{ conditionDescriptorValueId: '275010', conditionDescriptorValueName: 'Professional Sports Authenticator (PSA)' }] },
        { name: '27502', conditionDescriptorValues: [{ conditionDescriptorValueId: '2750299', conditionDescriptorValueName: '9.5' }] },
      ] },
      { conditionId: '4000', conditionDescriptors: [{ name: '40001', conditionDescriptorValues: [{ conditionDescriptorValueId: '400010', conditionDescriptorValueName: 'Near mint or better' }] }] },
    ] }] };
    const p = parseConditionPolicies(json, '183454');
    assert.ok(p.conditions.has('2750') && p.conditions.has('4000'));
    assert.equal(p.grader['Professional Sports Authenticator (PSA)'], '275010');
    assert.equal(__test.matchGradeId('9.5', p.grade), '2750299');   // live id used
    assert.equal(p.cardCondition['Near mint or better'], '400010');
  });
});
