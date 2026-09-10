// test/unit/sealed-shopify.test.mjs — the sealed pool -> Shopify product mapping.
//
// The sealed lane's twin of shopify-map.test.mjs. Everything here is pure: a pool row and a unit count
// in, a product object out, so the whole payload is assertable without a store.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toSealedShopifyProduct, validateSealedShopifyProduct, buildSealedShopifyDescription,
  sealedProductHandle, recordSealedListing, V1_SEALED_TYPES,
} from '../../lib/sealed-shopify.mjs';
import { PRODUCT_TYPES, TAXONOMY, SEALED_DISPATCH_WEIGHT_GRAMS } from '../../lib/channels/shopify-map.mjs';

// A sealed_pools row as the DB hands it back.
const pool = (over = {}) => ({
  pool_sku: 'BKS-PKM-SV8A-BOX', game: 'pokemon', language: 'EN',
  set_code: 'SV8a', set_name: 'White Flare', product_type: 'booster_box',
  name: 'White Flare Booster Box', variant: null, condition: 'sealed',
  factory_sealed: 1, pack_count: 36, price_cents: 18900,
  ...over,
});

const productOf = (over = {}, opts = {}) => toSealedShopifyProduct(pool(over), { units: 3, ...opts });
const errsOf = (over = {}, opts = {}) => {
  const p = pool(over);
  return validateSealedShopifyProduct(toSealedShopifyProduct(p, { units: 3, ...opts }), p).errors.join(' | ');
};

describe('a sealed pool maps to one product at quantity N', () => {
  it('is a Sealed product under the card-games taxonomy', () => {
    const p = productOf();
    assert.equal(p.productType, PRODUCT_TYPES.sealed);
    assert.equal(p.productType, 'Sealed', 'the theme keys its square thumb off this literal');
    assert.equal(p.taxonomyCategory, TAXONOMY.sealed);
    assert.notEqual(p.taxonomyCategory, TAXONOMY.single, 'a booster box is not a gaming card');
  });

  it('carries the pool SKU as both the sku and the productSet upsert key', () => {
    const p = productOf();
    assert.equal(p.sku, 'BKS-PKM-SV8A-BOX');
    assert.deepEqual(p.customId, { namespace: 'custom', key: 'id', value: 'BKS-PKM-SV8A-BOX' });
  });

  it('is ONE product at the pool quantity, not N products', () => {
    assert.equal(toSealedShopifyProduct(pool(), { units: 7 }).quantity, 7);
    assert.equal(toSealedShopifyProduct(pool(), { units: 1 }).quantity, 1);
  });

  it('carries kind=sealed and a NULL item_id, because sealed_pools has a text primary key', () => {
    const p = productOf();
    assert.equal(p.kind, 'sealed');
    assert.equal(p.itemId, null, 'a sealed_items id here would mean something different from the singles lane');
  });

  it('has no card identity — a booster box has no conditions to group', () => {
    assert.equal(productOf().identity, null);
  });

  it('takes its dispatch weight from the sealed sub-table, by product type', () => {
    assert.equal(productOf().weight_grams, SEALED_DISPATCH_WEIGHT_GRAMS.booster_box);
    assert.equal(productOf({ product_type: 'booster_pack' }).weight_grams, SEALED_DISPATCH_WEIGHT_GRAMS.booster_pack);
    assert.ok(productOf().weight_grams > 0, 'a zero weight buys a label Australia Post will not honour');
  });

  it('tracks inventory and DENIES oversell', () => {
    const p = productOf();
    assert.equal(p.tracked, true);
    assert.equal(p.inventoryPolicy, 'DENY');
  });

  it('slugs the handle under a sealed prefix so it cannot collide with a card', () => {
    assert.equal(sealedProductHandle(pool()), 'sealed-bks-pkm-sv8a-box');
  });

  it('prefers a title override, and builds one otherwise', () => {
    assert.ok(productOf().title.length, 'a pool with no override still needs a title');
    assert.equal(productOf({ title_override: 'Hand-written' }).title, 'Hand-written');
  });
});

describe('the sealed description is the Shopify frame, not the eBay one', () => {
  it('is three plain paragraphs with no facts table', () => {
    const html = buildSealedShopifyDescription(pool());
    assert.equal((html.match(/<p>/g) || []).length, 3);
    assert.ok(!/<table/i.test(html), 'the PDP renders its own facts panel; a table here duplicates and flattens badly');
  });

  it('quotes no postage figure — the theme owns shipping', () => {
    const html = buildSealedShopifyDescription(pool());
    assert.ok(!/\$/.test(html), 'a dollar figure here is an eBay band amount on a Shopify PDP');
    assert.ok(!/Australia Post|tracked/i.test(html), 'shipping copy belongs to the theme, from schema settings');
  });

  it('says what the box is and what condition it is in', () => {
    const html = buildSealedShopifyDescription(pool());
    assert.match(html, /factory sealed/i);
  });

  it('honours a description override verbatim', () => {
    assert.equal(buildSealedShopifyDescription(pool({ desc_override: '<p>Mine</p>' })), '<p>Mine</p>');
  });
});

describe('the sealed gate', () => {
  it('passes a complete pool with stock', () => {
    const p = pool();
    assert.deepEqual(validateSealedShopifyProduct(toSealedShopifyProduct(p, { units: 3 }), p).errors, []);
  });

  it('refuses a pool with no units — an offer at zero is not a listing', () => {
    assert.match(errsOf({}, { units: 0 }), /no units in stock/);
  });

  it('refuses a pool with no price', () => {
    assert.match(errsOf({ price_cents: null }), /no price/);
  });

  it('refuses a product type outside the opened set', () => {
    assert.match(errsOf({ product_type: 'elite_trainer_box' }), /sealed v1 publishes/);
    assert.ok(!V1_SEALED_TYPES.includes('elite_trainer_box'), 'this test is only meaningful while ETBs are closed');
  });

  it('refuses a pool with no SKU, because productSet has nothing to key on', () => {
    assert.match(errsOf({ pool_sku: null }), /no pool SKU/);
  });
});

describe('the sealed mirror row', () => {
  it('refuses to write any kind but sealed', () => {
    assert.throws(() => recordSealedListing({}, { sku: 'BKS-X', store: 'dev', kind: 'inventory' }), /kind='sealed'/);
  });
});
