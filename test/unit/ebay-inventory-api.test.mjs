// test/unit/ebay-inventory-api.test.mjs — the pure Sell Inventory API payload builders + condition
// descriptor id resolution. Offline; guards the GR-critical shapes (cents→price at the edge, GTC
// fixed-price, best-offer terms, condition enum, and that grading rides as numeric descriptors).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildInventoryItemPayload, buildOfferPayload } from '../../lib/channels/ebay-inventory-api.mjs';
import { toEbayListing, loadEbayCategories } from '../../lib/channels/ebay-map.mjs';
import { resolveConditionDescriptorIds, parseConditionPolicies, __test } from '../../lib/ebay-taxonomy.mjs';

const cats = loadEbayCategories();
const CFG = {
  marketplaceId: 'EBAY_AU', listingDuration: 'GTC',
  policies: { paymentPolicyId: 'PAY', returnPolicyId: 'RET', fulfillmentPolicyId: 'FUL' },
  location: { merchantLocationKey: 'tcg-au-1' },
};
const rawListing = toEbayListing({ sku: 'BK-RAW-PKM-1', game: 'pokemon', name: 'Pikachu', set_name: 'Base Set', number: '58/102', rarity: 'Common', condition: 'Near Mint', language: 'EN', quantity: 3, target_price_cents: 1299, image_url: 'https://cdn/x.png', finish: 'Regular' }, null, cats);
const slabListing = toEbayListing({ sku: 'BK-PKM-9', game: 'pokemon', name: 'Charizard', set_name: 'Base Set', number: '4/102', variant: 'Holo', grading_company: 'PSA', grade: 10, cert_number: '12345678', language: 'EN', quantity: 1, target_price_cents: 500000, image_url: 'https://cdn/charizard.png', finish: 'Holofoil' }, null, cats);

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
    assert.equal(o.listingPolicies.fulfillmentPolicyId, 'FUL');
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
