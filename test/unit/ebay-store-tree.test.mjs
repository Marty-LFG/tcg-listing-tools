// test/unit/ebay-store-tree.test.mjs — reading the seller's storefront departments (Trading GetStore)
// and the per-item pick that decides where a listing is filed.
//
// Two eBay rules drive all of this: an offer may sit in at most TWO store categories, and only in
// TERMINAL ones — filing against a category that has children makes eBay quietly file the listing
// under "Other" instead, which is how the first API listing ended up the only one of 163 store items
// outside Trading Card Games.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStoreCategories, buildGetStoreInner } from '../../lib/ebay-trading.mjs';
import { resolveStoreCategoryNames } from '../../lib/channels/ebay-inventory-api.mjs';
import { storeCategoryList, toEbayListing, loadEbayCategories } from '../../lib/channels/ebay-map.mjs';

// Note the element ORDER: eBay emits a parent's <Name> AFTER its <ChildCategory> nodes, which is
// exactly what breaks a naive non-greedy xmlField() — it would report the parent as "Lost Origin".
const XML = `<GetStoreResponse><Store><Name>Binders Keepers</Name><CustomCategories>
  <CustomCategory><CategoryID>1</CategoryID><Name>Other</Name><Order>0</Order></CustomCategory>
  <CustomCategory><CategoryID>245</CategoryID>
    <ChildCategory><CategoryID>246</CategoryID><Name>Lost Origin</Name><Order>1</Order></ChildCategory>
    <ChildCategory><CategoryID>247</CategoryID>
      <ChildCategory><CategoryID>248</CategoryID><Name>Alt Art</Name><Order>1</Order></ChildCategory>
      <Name>Silver Tempest &amp; Co</Name><Order>2</Order></ChildCategory>
    <Name>Pokemon Singles</Name><Order>1</Order></CustomCategory>
</CustomCategories></Store></GetStoreResponse>`;

describe('parseStoreCategories', () => {
  const cats = parseStoreCategories(XML);
  const byPath = Object.fromEntries(cats.map((c) => [c.path, c]));

  it('builds full slash paths, which is the form storeCategoryNames wants', () => {
    assert.deepEqual(cats.map((c) => c.path), [
      '/Other', '/Pokemon Singles', '/Pokemon Singles/Lost Origin',
      '/Pokemon Singles/Silver Tempest & Co', '/Pokemon Singles/Silver Tempest & Co/Alt Art',
    ]);
  });

  it('attributes a parent\'s Name to the parent even though eBay emits it after the children', () => {
    assert.equal(byPath['/Pokemon Singles'].id, '245', 'the classic mis-parse reports the child here');
    assert.equal(byPath['/Pokemon Singles/Lost Origin'].id, '246');
  });

  it('flags which categories can actually hold an item', () => {
    assert.equal(byPath['/Pokemon Singles'].leaf, false, 'a parent cannot hold items');
    assert.equal(byPath['/Pokemon Singles/Lost Origin'].leaf, true);
    assert.equal(byPath['/Pokemon Singles/Silver Tempest & Co'].leaf, false, 'has a child, so not selectable');
    assert.equal(byPath['/Pokemon Singles/Silver Tempest & Co/Alt Art'].leaf, true);
  });

  it('decodes entities and records depth for the indented picker', () => {
    assert.equal(byPath['/Pokemon Singles/Silver Tempest & Co'].name, 'Silver Tempest & Co');
    assert.equal(byPath['/Pokemon Singles/Silver Tempest & Co/Alt Art'].depth, 3);
  });

  it('survives a store with no custom categories', () => {
    assert.deepEqual(parseStoreCategories('<GetStoreResponse><Store><Name>x</Name></Store></GetStoreResponse>'), []);
    assert.deepEqual(parseStoreCategories(''), []);
  });

  it('asks eBay for the structure only', () => {
    assert.match(buildGetStoreInner(), /<CategoryStructureOnly>true<\/CategoryStructureOnly>/);
    assert.match(buildGetStoreInner({ levelLimit: 1 }), /<LevelLimit>1<\/LevelLimit>/);
  });
});

describe('storeCategoryList — the column is TEXT, the override is an array', () => {
  it('reads a JSON array out of the TEXT column', () => {
    assert.deepEqual(storeCategoryList('["/A","/B"]'), ['/A', '/B']);
  });
  it('takes a real array unchanged and a bare string as one entry', () => {
    assert.deepEqual(storeCategoryList(['/A', ' /B ']), ['/A', '/B']);
    assert.deepEqual(storeCategoryList('/A'), ['/A']);
  });
  it('never splits on commas — a department may be named "Singles, Graded"', () => {
    assert.deepEqual(storeCategoryList('/Singles, Graded'), ['/Singles, Graded']);
  });
  it('empty and malformed values yield no pick, so config still decides', () => {
    assert.deepEqual(storeCategoryList(null), []);
    assert.deepEqual(storeCategoryList(''), []);
    assert.deepEqual(storeCategoryList('[not json'), []);
  });
});

describe('resolveStoreCategoryNames — per-item pick beats config', () => {
  const cfg = { store: { defaultCategory: '/Trading Card Games', categoryByGame: { pokemon: '/Trading Card Games/Pokemon Singles' } } };

  it('the owner\'s per-item pick wins over both defaults', () => {
    const listing = { game: 'pokemon', storeCategoryNames: ['/Pokemon Singles', '/Pokemon Singles/Lost Origin'] };
    assert.deepEqual(resolveStoreCategoryNames(listing, cfg), ['/Pokemon Singles', '/Pokemon Singles/Lost Origin']);
  });

  it('no pick falls through to the per-game default, never to nothing', () => {
    assert.deepEqual(resolveStoreCategoryNames({ game: 'pokemon', storeCategoryNames: [] }, cfg), ['/Trading Card Games/Pokemon Singles']);
  });

  it('a row that predates the column behaves exactly as before', () => {
    assert.deepEqual(resolveStoreCategoryNames({ game: 'mtg' }, cfg), ['/Trading Card Games']);
  });

  it('still enforces eBay\'s cap of two — the limit is prose-only, nothing server-side rejects a third', () => {
    const listing = { game: 'pokemon', storeCategoryNames: ['/A', '/B', '/C'] };
    assert.deepEqual(resolveStoreCategoryNames(listing, cfg), ['/A', '/B']);
  });
});

describe('the round trip that keeps a listing in its department', () => {
  it('a republish with no overrides still sends the persisted pick', () => {
    // updateOffer is a COMPLETE REPLACEMENT: an offer body that omits storeCategoryNames makes eBay
    // drop the listing back into "Other". So the pick has to survive a price-only republish.
    const row = { game: 'pokemon', name: 'Radiant Gardevoir', set_name: 'Lost Origin', number: '069/196',
      condition: 'Near Mint', quantity: 1, target_price_cents: 498,
      store_categories: '["/Pokemon Singles","/Pokemon Singles/Lost Origin"]' };
    const listing = toEbayListing(row, null, loadEbayCategories());
    assert.deepEqual(listing.storeCategoryNames, ['/Pokemon Singles', '/Pokemon Singles/Lost Origin']);
    assert.deepEqual(resolveStoreCategoryNames(listing, { store: {} }),
      ['/Pokemon Singles', '/Pokemon Singles/Lost Origin']);
  });
});
