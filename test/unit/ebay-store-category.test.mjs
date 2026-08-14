// test/unit/ebay-store-category.test.mjs — offer.storeCategoryNames, the storefront department.
// The first API-published listing was the only one of 163 store items sitting in eBay's default
// "Other" category, because the offer never carried this field. eBay also DROPS it on any updateOffer
// that omits it, so it has to be rebuilt on every call rather than sent once at create time.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOfferPayload, resolveStoreCategoryNames } from '../../lib/channels/ebay-inventory-api.mjs';
import { testEbayConfig } from '../helpers/ebay-config.mjs';

const listing = { sku: 'BK-PKM-1', game: 'pokemon', categoryId: '183454', price_cents: 498, quantity: 1 };
const base = testEbayConfig();

describe('resolveStoreCategoryNames', () => {
  it('prefers the per-game path over the default', () => {
    const cfg = { ...base, store: { defaultCategory: '/Trading Card Games', categoryByGame: { pokemon: '/Trading Card Games/Pokemon Singles' } } };
    assert.deepEqual(resolveStoreCategoryNames(listing, cfg), ['/Trading Card Games/Pokemon Singles']);
    assert.deepEqual(resolveStoreCategoryNames({ ...listing, game: 'mtg' }, cfg), ['/Trading Card Games']);
  });

  it('drops anything that is not a full path — a bare name is not a store category', () => {
    // eBay wants "/Trading Card Games/Pokemon Singles". Prefixing a bare name for the owner would
    // turn a typo into a plausible-looking WRONG path, so it is dropped instead (GR4).
    assert.deepEqual(resolveStoreCategoryNames(listing, { ...base, store: { defaultCategory: 'Pokemon Singles', categoryByGame: {} } }), []);
    assert.deepEqual(resolveStoreCategoryNames(listing, { ...base, store: { defaultCategory: '/', categoryByGame: {} } }), []);
  });

  it('accepts at most two paths and de-duplicates', () => {
    const cfg = { ...base, store: { categoryByGame: { pokemon: ['/A', '/A', '/B', '/C'] } } };
    assert.deepEqual(resolveStoreCategoryNames(listing, cfg), ['/A', '/B']);
  });

  it('no store config → empty, so the offer body is byte-identical to before this change', () => {
    assert.deepEqual(resolveStoreCategoryNames(listing, base), []);
    assert.equal('storeCategoryNames' in buildOfferPayload(listing, base, {}), false);
  });
});

describe('buildOfferPayload store category', () => {
  it('sends the path when configured', () => {
    const cfg = { ...base, store: { defaultCategory: '/Trading Card Games', categoryByGame: {} } };
    assert.deepEqual(buildOfferPayload(listing, cfg, {}).storeCategoryNames, ['/Trading Card Games']);
  });
  it('is rebuilt on every call — an updateOffer that omits it makes eBay drop it', () => {
    const cfg = { ...base, store: { defaultCategory: '/Trading Card Games', categoryByGame: {} } };
    const a = buildOfferPayload(listing, cfg, {});
    const b = buildOfferPayload(listing, cfg, { bestOffer: { enabled: true, autoAcceptCents: 470 } });
    assert.deepEqual(a.storeCategoryNames, b.storeCategoryNames);
  });
});
