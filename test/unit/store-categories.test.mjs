// test/unit/store-categories.test.mjs — which storefront DEPARTMENT a listing is filed under.
//
// Not the marketplace categoryId: this is the seller's own store navigation. eBay files a listing
// with no valid department under "Other", which is where the first API listing landed — the only one
// of 163 store items outside Trading Card Games.
//
// Two defects drove this file. Sealed emitted `store_categories` while the resolver reads
// `storeCategoryNames`, and never set `game`, so every sealed listing resolved to nothing. And the
// configured Pokémon path went stale when the store nested Pokémon under a "Pokemon TCG" parent, with
// nothing to notice, because the resolver deliberately passes an unknown path through unrepaired.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkStoreCategories } from '../../lib/channels/ebay-map.mjs';
import { resolveStoreCategoryNames } from '../../lib/channels/ebay-inventory-api.mjs';
import { toSealedListing, sealedStoreCategories } from '../../lib/sealed-listing.mjs';

// The store's real departments, read live 2026-08-19.
const LIVE = [
  '/Trading Card Games',
  '/Trading Card Games/Pokemon TCG',
  '/Trading Card Games/Pokemon TCG/Pokemon Singles',
  '/Trading Card Games/Pokemon TCG/Pokemon Sealed',
  '/Trading Card Games/Magic: The Gathering Singles',
].map((path) => ({ path }));

const CFG = {
  policies: { paymentPolicyId: 'P', returnPolicyId: 'R' },
  store: {
    defaultCategory: '/Trading Card Games',
    categoryByGame: { pokemon: '/Trading Card Games/Pokemon TCG/Pokemon Singles' },
    sealedCategory: '/Trading Card Games/Pokemon TCG/Pokemon Sealed',
  },
  shipping: { sealedBands: [{ id: 'sealed_medium', costCents: 1600, extraCents: 0, policyId: '273398171012' }] },
};
const POOL = {
  pool_sku: 'BKS-PKM-EN-SSP-BOX', game: 'pokemon', product_type: 'booster_box', language: 'EN',
  set_name: 'Surging Sparks (SSP)', set_code: 'SSP', condition: 'sealed', factory_sealed: 1,
  pack_count: 36, price_cents: 24900,
};

describe('sealedStoreCategories — sealed needs its OWN department', () => {
  it('does not fall through to the game department, which would file a box under Singles', () => {
    assert.deepEqual(sealedStoreCategories(POOL, CFG), ['/Trading Card Games/Pokemon TCG/Pokemon Sealed']);
  });
  it('a per-type pick beats the single sealed default', () => {
    const cfg = { store: { sealedCategory: '/Fallback', sealedCategoryByType: { booster_box: '/Boxes' } } };
    assert.deepEqual(sealedStoreCategories(POOL, cfg), ['/Boxes']);
    assert.deepEqual(sealedStoreCategories({ ...POOL, product_type: 'booster_pack' }, cfg), ['/Fallback']);
  });
  it("the pool's own pick beats config, and parses a JSON array", () => {
    assert.deepEqual(sealedStoreCategories({ ...POOL, store_categories: '["/Own/Pick"]' }, CFG), ['/Own/Pick']);
  });
  it('unset resolves to nothing rather than inventing a department', () => {
    assert.deepEqual(sealedStoreCategories(POOL, { store: {} }), []);
  });
});

describe('the sealed listing actually carries it through to the offer', () => {
  it('sets storeCategoryNames, the field the resolver reads', () => {
    const listing = toSealedListing(POOL, { units: 3, cfg: CFG });
    // The bug: it used to emit `store_categories`, which nothing reads.
    assert.deepEqual(listing.storeCategoryNames, ['/Trading Card Games/Pokemon TCG/Pokemon Sealed']);
    assert.deepEqual(resolveStoreCategoryNames(listing, CFG), ['/Trading Card Games/Pokemon TCG/Pokemon Sealed']);
  });
  it('sets game, so an unset sealed department can still fall back to the Pokémon one', () => {
    const listing = toSealedListing(POOL, { units: 3, cfg: { ...CFG, store: { ...CFG.store, sealedCategory: '' } } });
    assert.equal(listing.game, 'pokemon');
    assert.deepEqual(resolveStoreCategoryNames(listing, CFG), ['/Trading Card Games/Pokemon TCG/Pokemon Singles']);
  });
});

describe('checkStoreCategories — catch a path going stale', () => {
  it('flags the real defect: Pokémon nested under a new parent', () => {
    const stale = checkStoreCategories({ store: { categoryByGame: { pokemon: '/Trading Card Games/Pokemon Singles' } } }, LIVE);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].setting, 'store.categoryByGame.pokemon');
    assert.match(stale[0].error, /no longer a department/);
  });
  it('says nothing when every configured path is real', () => {
    assert.deepEqual(checkStoreCategories(CFG, LIVE), []);
  });
  it('checks the sealed settings too, not just the per-game map', () => {
    const bad = { store: { sealedCategory: '/Gone', sealedCategoryByType: { booster_box: '/Also Gone' } } };
    assert.deepEqual(checkStoreCategories(bad, LIVE).map((s) => s.setting).sort(),
      ['store.sealedCategory', 'store.sealedCategoryByType.booster_box']);
  });
  it('reports NOTHING when the store is unreadable, rather than flagging everything', () => {
    // An eBay outage must not present every department as broken (GR7).
    assert.deepEqual(checkStoreCategories(CFG, []), []);
    assert.deepEqual(checkStoreCategories(CFG, null), []);
  });
});
