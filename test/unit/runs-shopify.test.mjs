// test/unit/runs-shopify.test.mjs — a run as one product with one variant per bundle number.
//
// No network: the GraphQL client is injected. What matters here is the SHAPE of what we would send, and
// the two properties the storefront leans on — §5.6.3's "the buyer picks their own number and the
// storefront's own inventory shows the true remaining set", and guardrail (a)'s "no monetary value ever
// reaches a customer as a statement about what is inside a bundle".
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import {
  buildRunProductSetInput, validateRunProduct, publishRunProduct, runVariantSku, runProductSku,
  runProductHandle, isRunSku, parseRunSku, mirrorAvailability, runListings, guaranteeHtml,
  MAX_SYNC_VARIANTS, BUNDLE_OPTION, RUN_SKU_PREFIX, RUN_TEMPLATE_SUFFIX,
} from '../../lib/runs-shopify.mjs';
import { PRODUCT_TYPES } from '../../lib/channels/shopify-map.mjs';

const db = openDbAt(tmpFile('runs-shopify.db'));

const RUN = { id: 1, public_id: 'DEV-E1', name: 'Edition One', unit_count: 3, unit_price_cents: 12900, currency: 'AUD' };
const BUNDLES = [
  { id: 11, bundle_no: 1, label: 'DEV-E1-001', status: 'open' },
  { id: 12, bundle_no: 2, label: 'DEV-E1-002', status: 'open' },
  { id: 13, bundle_no: 3, label: 'DEV-E1-003', status: 'open' },
];
const PINS = { locationGid: 'gid://shopify/Location/1', publicationGid: 'gid://shopify/Publication/1' };

describe('SKUs and handles', () => {
  it('one product SKU, one variant SKU per number, zero-padded', () => {
    assert.equal(runProductSku(RUN), 'BK-RUN-DEV-E1');
    assert.equal(runVariantSku(RUN, 7), 'BK-RUN-DEV-E1-007');
    assert.equal(runProductHandle(RUN), 'keepers-run-dev-e1');
  });

  it('and a run SKU is recognisable without importing this module', () => {
    // postsale has to exclude these from the stock sweep without adding an import cycle, so the shape is
    // the contract. A run bundle's stock is drawn down at PACK time, never by an order line.
    assert.ok(isRunSku('BK-RUN-DEV-E1-007'));
    assert.ok(isRunSku('bk-run-dev-e1-007'), 'case-insensitive');
    assert.ok(!isRunSku('BK-PKM-000042'), 'a shelf SKU is not a run SKU');
    assert.ok(!isRunSku('BK-RUN-DEV-E1'), 'the product SKU is not a variant SKU');
    assert.deepEqual(parseRunSku('BK-RUN-DEV-E1-007'), { publicId: 'DEV-E1', bundleNo: 7 });
    assert.equal(parseRunSku('AAA-001'), null);
    assert.equal(RUN_SKU_PREFIX, 'BK-RUN-');
  });
});

describe('the productSet input', () => {
  const input = buildRunProductSetInput(RUN, BUNDLES);

  it('is ONE product with one variant per bundle number', () => {
    assert.equal(input.variants.length, 3);
    assert.deepEqual(input.variants.map((v) => v.sku),
      ['BK-RUN-DEV-E1-001', 'BK-RUN-DEV-E1-002', 'BK-RUN-DEV-E1-003']);
  });

  it('with a REAL option a buyer chooses, not the synthetic Default Title', () => {
    // §5.6.3: the buyer picks their own number. That is only true if the number is an option value.
    assert.equal(input.productOptions.length, 1);
    assert.equal(input.productOptions[0].name, BUNDLE_OPTION);
    assert.deepEqual(input.productOptions[0].values.map((v) => v.name), ['001', '002', '003']);
    for (const v of input.variants) assert.equal(v.optionValues[0].optionName, BUNDLE_OPTION);
  });

  it('every option value has exactly one variant, and vice versa', () => {
    const opts = input.productOptions[0].values.map((v) => v.name).sort();
    const vars = input.variants.map((v) => v.optionValues[0].name).sort();
    assert.deepEqual(opts, vars);
  });

  it('is sorted by bundle number whatever order it was handed', () => {
    const shuffled = buildRunProductSetInput(RUN, [BUNDLES[2], BUNDLES[0], BUNDLES[1]]);
    assert.deepEqual(shuffled.variants.map((v) => v.sku), input.variants.map((v) => v.sku));
  });

  it('denies overselling at the storefront rather than accepting it', () => {
    // The storefront refusing a second sale of a number is what §5.6.3 relies on structurally.
    for (const v of input.variants) {
      assert.equal(v.inventoryPolicy, 'DENY');
      assert.equal(v.inventoryItem.tracked, true);
      assert.ok(!('inventoryQuantities' in v), 'quantity is set per item through the compare-and-swap');
    }
  });

  it('carries a real dispatch weight, not zero', () => {
    // dispatchWeightGrams takes (item, productType); passing productType on the item returns 0, which
    // Shopify would take as a weightless parcel.
    assert.ok(input.variants[0].inventoryItem.measurement.weight.value > 0);
    assert.equal(input.variants[0].inventoryItem.measurement.weight.unit, 'GRAMS');
  });

  it('and is typed as a Mystery Bundle, the value that has sat unused until now', () => {
    assert.equal(input.productType, PRODUCT_TYPES.bundle);
  });

  it('NO MONETARY VALUE APPEARS IN ANY COPY', () => {
    // Guardrail (a). The variant price is Shopify's own field and is what a buyer pays; a value stated in
    // the title, description, tags or metafields would be a claim about what is INSIDE the bundle.
    const copy = JSON.stringify({
      title: input.title, descriptionHtml: input.descriptionHtml,
      tags: input.tags, metafields: input.metafields || [],
    });
    assert.ok(!/\$|\d+\.\d{2}|\bAUD\b|\bUSD\b|129/.test(copy), copy);
    // And the price IS on the variant, because the product has to be buyable.
    assert.equal(input.variants[0].price, '129.00');
  });
});

describe('validation refuses before anything is written', () => {
  it('a run above the synchronous variant ceiling', () => {
    // A silent truncation would publish a product missing numbers the ledger believes are for sale.
    const many = Array.from({ length: MAX_SYNC_VARIANTS + 1 }, (_, i) => ({ id: i, bundle_no: i + 1, status: 'open' }));
    const v = validateRunProduct({ ...RUN, unit_count: many.length }, many, PINS);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /variant ceiling/.test(e)));
  });

  it('a bundle count that disagrees with the run', () => {
    const v = validateRunProduct(RUN, BUNDLES.slice(0, 2), PINS);
    assert.ok(v.errors.some((e) => /declares 3 bundles but 2/.test(e)));
  });

  it('two bundles sharing a number', () => {
    const v = validateRunProduct(RUN, [BUNDLES[0], BUNDLES[1], { ...BUNDLES[2], bundle_no: 1 }], PINS);
    assert.ok(v.errors.some((e) => /share a number/.test(e)));
  });

  it('missing pins', () => {
    const v = validateRunProduct(RUN, BUNDLES, {});
    assert.ok(v.errors.some((e) => /no location is pinned/.test(e)));
    assert.ok(v.errors.some((e) => /no publication is pinned/.test(e)));
  });

  it('and a run with no price, because the product must be buyable', () => {
    const v = validateRunProduct({ ...RUN, unit_price_cents: null }, BUNDLES, PINS);
    assert.ok(v.errors.some((e) => /no price/.test(e)));
  });
});

// --- a fake store that answers like the real one -------------------------------------------------------

function fakeShopify({ variantCount = null, failInventory = null } = {}) {
  const calls = { productSet: 0, read: 0, set: 0, activate: 0, publish: 0 };
  const graphql = async (env, query, vars) => {
    if (query.includes('productSet')) {
      calls.productSet++;
      const wanted = vars.input.variants;
      const take = variantCount == null ? wanted.length : variantCount;
      return {
        ok: true,
        data: {
          productSet: {
            product: {
              id: 'gid://shopify/Product/900', handle: vars.input.handle, status: vars.input.status,
              variants: {
                nodes: wanted.slice(0, take).map((v, i) => ({
                  id: `gid://shopify/ProductVariant/${i + 1}`,
                  sku: v.sku,
                  inventoryItem: { id: `gid://shopify/InventoryItem/${i + 1}` },
                  selectedOptions: [{ name: BUNDLE_OPTION, value: v.optionValues[0].name }],
                })),
              },
            },
            userErrors: [],
          },
        },
      };
    }
    if (query.includes('inventoryLevel') || query.includes('inventoryItem(')) {
      calls.read++;
      return { ok: true, data: { inventoryItem: { inventoryLevel: { quantities: [{ name: 'available', quantity: 0 }] } } } };
    }
    if (query.includes('inventorySetQuantities')) {
      calls.set++;
      if (failInventory != null && calls.set === failInventory) return { ok: false, httpStatus: 500 };
      return { ok: true, data: { inventorySetQuantities: { userErrors: [] } } };
    }
    if (query.includes('inventoryActivate')) { calls.activate++; return { ok: true, data: {} }; }
    if (query.includes('publishablePublish')) { calls.publish++; return { ok: true, data: {} }; }
    return { ok: false, httpStatus: 400 };
  };
  return { graphql, calls };
}

describe('publishing refuses a truncated response', () => {
  it('rather than writing a mirror that silently omits numbers', async () => {
    // The one failure mode that would leave the ledger and the storefront disagreeing with nothing to
    // notice it: numbers believed for sale that were never listed.
    const store = fakeShopify({ variantCount: 2 });
    const out = await publishRunProduct({}, db, {
      run: RUN, bundles: BUNDLES, ...PINS, graphql: store.graphql,
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /returned 2 variants for 3 bundles/);
    assert.equal(store.calls.publish, 0, 'it published anyway');
  });
});

describe('a dry run calls nothing', () => {
  it('builds the input and stops', async () => {
    const store = fakeShopify();
    const out = await publishRunProduct({}, db, {
      run: RUN, bundles: BUNDLES, ...PINS, graphql: store.graphql, dryRun: true,
    });
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.equal(out.input.variants.length, 3);
    assert.deepEqual(store.calls, { productSet: 0, read: 0, set: 0, activate: 0, publish: 0 });
  });
});

describe('a run renders through its own PDP template, not the singles one', () => {
  it('carries the template suffix on every product it publishes', () => {
    // A run has no condition to choose, its trust copy is about penny sleeves and a Near Mint scale,
    // and - the part that matters - templates/product.json has no way to pick a bundle NUMBER. §5.6.3
    // makes the visible remaining set a property of the product: it is what makes "7 is gone"
    // checkable rather than asserted.
    const input = buildRunProductSetInput(RUN, BUNDLES);
    assert.equal(input.templateSuffix, RUN_TEMPLATE_SUFFIX);
    assert.equal(RUN_TEMPLATE_SUFFIX, 'keepers-run',
      'the suffix and templates/product.keepers-run.json are one fact in two places');
  });

  it('and the guarantee becomes the description, because otherwise the page says nothing', () => {
    // The one sentence that says what the buyer is getting. Generated from the run's own claims rather
    // than typed, and inside headerDigest, so the page cannot drift from what was anchored.
    const input = buildRunProductSetInput({ ...RUN, guarantee_text: 'Every bundle contains one PSA 10 card.' }, BUNDLES);
    assert.equal(input.descriptionHtml, '<p>Every bundle contains one PSA 10 card.</p>');
  });

  it('but a caller that supplies its own description keeps it', () => {
    const input = buildRunProductSetInput({ ...RUN, guarantee_text: 'G.' }, BUNDLES,
      { descriptionHtml: '<p>hand written</p>' });
    assert.equal(input.descriptionHtml, '<p>hand written</p>');
  });

  it('and a run with no sentence gets no description rather than an empty tag', () => {
    assert.equal(buildRunProductSetInput({ ...RUN, guarantee_text: '' }, BUNDLES).descriptionHtml, '');
    assert.equal(guaranteeHtml({}), '');
    assert.equal(guaranteeHtml({ guarantee_text: '   ' }), '');
  });

  it('and the sentence is escaped, because a storefront is the wrong place to find out it was not', () => {
    assert.equal(guaranteeHtml({ guarantee_text: 'one <b>PSA</b> & three packs' }),
      '<p>one &lt;b&gt;PSA&lt;/b&gt; &amp; three packs</p>');
  });
});
