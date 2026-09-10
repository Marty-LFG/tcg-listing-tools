// test/unit/shopify-product-api.test.mjs — the Shopify publish sequence.
//
// Offline: a stub fetch answers the token endpoint and plays each mutation, and the product under test
// comes from the REAL toShopifyProduct rather than a hand-rolled literal — a fixture shaped by hand
// would pass happily while the actual seam between the two modules was broken.
//
// What is locked down here is, in every case, something whose failure is SILENT on a live store:
// a metaobject write that clears the condition list off the PDP, an inventory set with no
// compare-and-swap (the oversell), a product created but never published (invisible, and the ledger
// says live), and a file re-uploaded on every republish because it was attached by URL instead of id.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toShopifyProduct } from '../../lib/channels/shopify-map.mjs';
import {
  buildProductSetInput, upsertIdentity, setAvailableQty, publishProduct, taxonomyGid,
} from '../../lib/channels/shopify-product-api.mjs';

const ENV = {
  SHOPIFY_DEV_SHOP: 'binders-keepers-dev',
  SHOPIFY_CLIENT_ID: 'fake-client-id',
  SHOPIFY_CLIENT_SECRET: 'fake-client-secret',
};

const base = {
  id: 7, sku: 'AAC-085', game: 'pokemon', identity_key: 'sv8a-102',
  name: 'Iono', number: '186/159', set_name: 'White Flare', set_code: 'SV8a',
  rarity: 'Special Illustration Rare', language: 'JP', variant: 'Holo',
  condition: 'Near Mint', quantity: 1, target_price_cents: 12999,
  image_url: 'https://cdn.example/iono.png',
};
const row = (over = {}) => ({ ...base, ...over });
const product = (over = {}) => toShopifyProduct(row(over));

const LOC = 'gid://shopify/Location/1';
const PUB = 'gid://shopify/Publication/2';

function mkResponse(status, body) {
  const h = new Map([['content-type', 'application/json']]);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    text: async () => body,
  };
}

/**
 * A stub that plays the whole publish sequence. `bend` lets one test break exactly one step, so a
 * failure test proves the orchestrator's response to THAT step rather than to a generally broken store.
 */
function stubShopify(bend = {}) {
  const calls = [];                       // { op, variables } in the order they happened
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/admin/oauth/access_token')) {
      return mkResponse(200, JSON.stringify({ access_token: 't', scope: 'write_products', expires_in: 86399 }));
    }
    const body = JSON.parse(init.body);
    const q = body.query;
    const v = body.variables;

    const answer = (op, data, userErrorsPath) => {
      calls.push({ op, variables: v });
      const b = bend[op];
      if (b === 'http500') return mkResponse(500, '{}');
      if (typeof b === 'string') {
        // a userError, which is an HTTP 200 the transport must still treat as a failure
        const errs = [{ field: null, message: b, code: b.includes('stale') ? 'CHANGE_FROM_QUANTITY_STALE' : 'INVALID' }];
        const shell = {}; shell[userErrorsPath] = { userErrors: errs };
        return mkResponse(200, JSON.stringify({ data: shell }));
      }
      if (typeof b === 'function') { const r = b(v, calls); if (r !== undefined) return mkResponse(200, JSON.stringify({ data: r })); }
      return mkResponse(200, JSON.stringify({ data }));
    };

    if (q.includes('metaobjectUpsert')) {
      return answer('identity', { metaobjectUpsert: { metaobject: { id: 'gid://shopify/Metaobject/9', handle: v.handle.handle }, userErrors: [] } }, 'metaobjectUpsert');
    }
    if (q.includes('productSet')) {
      return answer('productSet', {
        productSet: {
          product: {
            id: 'gid://shopify/Product/100', handle: v.input.handle, status: v.input.status,
            variants: { nodes: [{ id: 'gid://shopify/ProductVariant/200', sku: v.input.variants[0].sku, inventoryItem: { id: 'gid://shopify/InventoryItem/300' } }] },
          },
          userErrors: [],
        },
      }, 'productSet');
    }
    if (q.includes('inventoryItem(id:')) {
      calls.push({ op: 'readLevel', variables: v });
      const levels = bend.level === undefined ? [] : bend.level;
      return mkResponse(200, JSON.stringify({ data: { inventoryItem: { inventoryLevels: { nodes: levels } } } }));
    }
    if (q.includes('inventoryActivate')) {
      return answer('activate', { inventoryActivate: { inventoryLevel: { id: 'gid://shopify/InventoryLevel/400', quantities: [{ name: 'available', quantity: v.available }] }, userErrors: [] } }, 'inventoryActivate');
    }
    if (q.includes('inventorySetQuantities')) {
      return answer('setQty', { inventorySetQuantities: { inventoryAdjustmentGroup: { changes: [{ name: 'available', delta: 1, quantityAfterChange: 1 }] }, userErrors: [] } }, 'inventorySetQuantities');
    }
    if (q.includes('publishablePublish')) {
      return answer('publish', { publishablePublish: { publishable: { availablePublicationsCount: { count: 1 } }, userErrors: [] } }, 'publishablePublish');
    }
    throw new Error('the stub was asked something the publish sequence should never send: ' + q.slice(0, 80));
  };
  return { fn, calls, ops: () => calls.map((c) => c.op) };
}

const levelAt = (locationGid, quantity) => [{ location: { id: locationGid }, quantities: [{ name: 'available', quantity }] }];
const run = (over = {}, bend = {}) => {
  const stub = stubShopify(bend);
  return publishProduct(ENV, {
    product: product(), locationGid: LOC, publicationGid: PUB, fetchImpl: stub.fn, item: row(), ...over,
  }).then((r) => ({ r, stub }));
};

// --- the payload ----------------------------------------------------------------------------------

describe('buildProductSetInput — complete state, every time', () => {
  it('carries the full metafield and tag set, because a partial productSet DELETES the rest', () => {
    const p = product();
    const input = buildProductSetInput(p);
    assert.equal(input.metafields.length, p.metafields.length);
    assert.deepEqual(input.tags, p.tags);
    assert.ok(input.tags.length > 0, 'a fixture with no tags cannot prove anything about tag replacement');
  });

  it('attaches files by id, NOT originalSource — originalSource would mint a new file per republish', () => {
    const input = buildProductSetInput(product(), { fileGids: ['gid://shopify/MediaImage/1', 'gid://shopify/MediaImage/2'] });
    assert.deepEqual(input.files, [{ id: 'gid://shopify/MediaImage/1' }, { id: 'gid://shopify/MediaImage/2' }]);
    const asText = JSON.stringify(input);
    assert.ok(!asText.includes('originalSource'), 'a cached file attached by URL is a duplicate upload');
  });

  it('omits `files` entirely when there is no media, rather than sending an empty list that would clear it', () => {
    assert.equal('files' in buildProductSetInput(product()), false);
  });

  it('never sends inventoryQuantities — productSet has no compare-and-swap, so quantity goes elsewhere', () => {
    const input = buildProductSetInput(product());
    assert.ok(!('inventoryQuantities' in input.variants[0]), 'an unguarded absolute set would silently win over a concurrent sale');
    assert.equal(input.variants[0].inventoryItem.tracked, true);
    assert.equal(input.variants[0].inventoryPolicy, 'DENY');
  });

  it('sends the dispatch weight on the variant, in the shape InventoryItemInput takes', () => {
    // The AAC-089 defect was measured HERE, on the published variant: measurement.weight read
    // `0 KILOGRAMS`. InventoryItemMeasurementInput { weight: WeightInput { unit, value } }, 2026-07.
    const single = buildProductSetInput(product()).variants[0].inventoryItem;
    assert.deepEqual(single.measurement, { weight: { unit: 'GRAMS', value: 30 } });
    assert.equal(single.tracked, true, 'the weight must not have displaced tracked');

    const slab = buildProductSetInput(product({ graded: 1, grading_company: 'PSA', grade: 9, cert_number: '1' }));
    assert.deepEqual(slab.variants[0].inventoryItem.measurement, { weight: { unit: 'GRAMS', value: 150 } });
  });

  it('omits measurement entirely when there is no weight, rather than writing a zero', () => {
    // A scalar left out of productSet is left alone; a zero sent explicitly clobbers a weight somebody
    // corrected in admin. validateProduct refuses such a row anyway, so this is a guard, not a path.
    const p = product();
    p.weight_grams = 0;
    assert.equal('measurement' in buildProductSetInput(p).variants[0].inventoryItem, false);
  });

  it('prices from integer cents, and never in a way that could round (GR3)', () => {
    assert.equal(buildProductSetInput(product()).variants[0].price, '129.99');
    assert.equal(buildProductSetInput(product({ target_price_cents: 5 })).variants[0].price, '0.05');
    assert.equal(buildProductSetInput(product({ target_price_cents: 100000 })).variants[0].price, '1000.00');
  });

  it('REPLACES bkc.card rather than appending a second one', () => {
    const p = product();
    p.metafields.push({ namespace: 'bkc', key: 'card', value: 'gid://shopify/Metaobject/OLD', type: 'metaobject_reference' });
    const input = buildProductSetInput(p, { identityGid: 'gid://shopify/Metaobject/NEW' });
    const cards = input.metafields.filter((m) => m.namespace === 'bkc' && m.key === 'card');
    assert.equal(cards.length, 1, 'a duplicate namespace/key pair is a userError, not a last-one-wins');
    assert.equal(cards[0].value, 'gid://shopify/Metaobject/NEW');
  });

  it('does not mutate the product it was handed', () => {
    const p = product();
    const before = p.metafields.length;
    buildProductSetInput(p, { identityGid: 'gid://shopify/Metaobject/9', ogFileGid: 'gid://shopify/MediaImage/8' });
    assert.equal(p.metafields.length, before, 'a builder that edits its input behaves differently the second time');
  });

  it('sends the taxonomy category as a GID', () => {
    assert.equal(buildProductSetInput(product()).category, taxonomyGid('ae-2-2-3-2'));
    assert.equal(taxonomyGid(null), null);
  });
});

// --- the identity ---------------------------------------------------------------------------------

describe('upsertIdentity — patch, never replace', () => {
  it('uses metaobject.fields and NEVER `values`, which would clear the condition list off the PDP', async () => {
    const stub = stubShopify();
    await upsertIdentity(ENV, { identity: product().identity, fetchImpl: stub.fn });
    const v = stub.calls[0].variables;
    assert.ok(Array.isArray(v.metaobject.fields), 'fields is the patch form and is the only safe one here');
    assert.equal('values' in v, false, '`values` clears every omitted key — it would blank `listings`');
  });

  it('never writes `listings` — that is identity.rebuild’s job, and appending here is a lost-update race', async () => {
    const stub = stubShopify();
    await upsertIdentity(ENV, { identity: product().identity, fetchImpl: stub.fn });
    const keys = stub.calls[0].variables.metaobject.fields.map((f) => f.key);
    assert.ok(!keys.includes('listings'), 'two siblings publishing at once would each drop the other');
  });

  it('addresses the metaobject by type and handle, so siblings converge on one identity', async () => {
    const stub = stubShopify();
    const r = await upsertIdentity(ENV, { identity: product().identity, fetchImpl: stub.fn });
    assert.deepEqual(stub.calls[0].variables.handle, { type: 'bk_card_identity', handle: 'pokemon-sv8a-102-holo-jp' });
    assert.equal(r.gid, 'gid://shopify/Metaobject/9');
  });

  it('drops empty fields rather than writing blanks over real values', async () => {
    const stub = stubShopify();
    const identity = product().identity;
    identity.fields.set_name = '';
    await upsertIdentity(ENV, { identity, fetchImpl: stub.fn });
    assert.ok(!stub.calls[0].variables.metaobject.fields.some((f) => f.key === 'set_name'));
  });
});

// --- inventory ------------------------------------------------------------------------------------

describe('setAvailableQty — read first, then compare-and-swap', () => {
  const call = (bend, quantity = 1) => {
    const stub = stubShopify(bend);
    return setAvailableQty(ENV, { inventoryItemGid: 'gid://shopify/InventoryItem/300', locationGid: LOC, quantity, fetchImpl: stub.fn })
      .then((r) => ({ r, stub }));
  };

  it('ACTIVATES when the item is not stocked at the location', async () => {
    const { r, stub } = await call({ level: [] });
    assert.equal(r.action, 'activate');
    assert.deepEqual(stub.ops(), ['readLevel', 'activate']);
  });

  it('COMPARE-AND-SWAPS against the value it just read when a level already exists', async () => {
    const { r, stub } = await call({ level: levelAt(LOC, 3) }, 1);
    assert.equal(r.action, 'set');
    const q = stub.calls[1].variables.input.quantities[0];
    assert.equal(q.changeFromQuantity, 3, 'without this the write silently wins over a concurrent sale');
    assert.equal(q.quantity, 1);
    assert.equal(stub.calls[1].variables.input.name, 'available', 'on_hand fights the checkout for the same number');
  });

  it('does nothing at all when the quantity is already right', async () => {
    const { r, stub } = await call({ level: levelAt(LOC, 1) }, 1);
    assert.equal(r.action, 'noop');
    assert.deepEqual(stub.ops(), ['readLevel']);
  });

  it('reads the level at OUR location, not whichever one came back first', async () => {
    const other = [{ location: { id: 'gid://shopify/Location/999' }, quantities: [{ name: 'available', quantity: 42 }] }];
    const { r } = await call({ level: other }, 1);
    assert.equal(r.action, 'activate', 'a level at another location is not a level at ours');
  });

  it('on a STALE compare it RE-READS and re-decides, rather than retrying the same numbers', async () => {
    let reads = 0;
    const stub = stubShopify({
      level: levelAt(LOC, 3),
      setQty: (v, calls) => {
        // fail the first set with a stale compare; succeed the second
        const sets = calls.filter((c) => c.op === 'setQty').length;
        if (sets === 1) return { inventorySetQuantities: { userErrors: [{ field: null, message: 'changeFromQuantity is stale', code: 'CHANGE_FROM_QUANTITY_STALE' }] } };
        return undefined;
      },
    });
    const r = await setAvailableQty(ENV, { inventoryItemGid: 'gid://shopify/InventoryItem/300', locationGid: LOC, quantity: 1, fetchImpl: stub.fn });
    reads = stub.calls.filter((c) => c.op === 'readLevel').length;
    assert.equal(reads, 2, 'the world moved — the point of retrying is to look again');
    assert.equal(r.ok, true);
    assert.equal(r.retried, true);
  });

  it('mints a FRESH idempotency key per attempt — a reused key replays the first answer', async () => {
    const stub = stubShopify({
      level: levelAt(LOC, 3),
      setQty: (v, calls) => (calls.filter((c) => c.op === 'setQty').length === 1
        ? { inventorySetQuantities: { userErrors: [{ field: null, message: 'changeFromQuantity is stale', code: 'CHANGE_FROM_QUANTITY_STALE' }] } }
        : undefined),
    });
    await setAvailableQty(ENV, { inventoryItemGid: 'gid://shopify/InventoryItem/300', locationGid: LOC, quantity: 1, fetchImpl: stub.fn });
    const keys = stub.calls.filter((c) => c.op === 'setQty').map((c) => c.variables.key);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1], 'replaying a failed compare-and-swap reports a false success');
  });

  it('gives up after one retry rather than looping on a persistently stale compare', async () => {
    const { r, stub } = await call({ level: levelAt(LOC, 3), setQty: 'changeFromQuantity is stale' }, 1);
    assert.equal(r.ok, false);
    assert.equal(stub.calls.filter((c) => c.op === 'setQty').length, 2);
  });

  it('reports a failed READ as a failure rather than assuming the level is absent', async () => {
    const stub = stubShopify();
    const fetchImpl = async (u, i) => (String(u).includes('oauth') ? stub.fn(u, i) : mkResponse(500, '{}'));
    const r = await setAvailableQty(ENV, { inventoryItemGid: 'gid://shopify/InventoryItem/300', locationGid: LOC, quantity: 1, fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'read', 'guessing "not stocked" here would activate over a real level');
  });
});

// --- the orchestrator -----------------------------------------------------------------------------

describe('publishProduct — the order is the safety', () => {
  it('runs identity, then set identity, then productSet, then inventory, then publish', async () => {
    const { r, stub } = await run({}, { level: [] });
    assert.equal(r.ok, true, r.error);
    // The set identity is a second metaobject upsert and lands beside the card one, BEFORE productSet,
    // because its GID is spliced into the product's bkc.set metafield.
    assert.deepEqual(stub.ops(), ['identity', 'identity', 'productSet', 'readLevel', 'activate', 'publish']);
  });

  it('publishes LAST, so a product is never visible before it is stocked', async () => {
    const { stub } = await run({}, { level: [] });
    const ops = stub.ops();
    assert.ok(ops.indexOf('publish') > ops.indexOf('activate'), 'a visible unstocked product reads as sold out');
  });

  it('points bkc.card at the identity the FIRST call just created', async () => {
    const { stub } = await run({}, { level: [] });
    const mfs = stub.calls.find((c) => c.op === 'productSet').variables.input.metafields;
    const card = mfs.find((m) => m.namespace === 'bkc' && m.key === 'card');
    assert.equal(card.value, 'gid://shopify/Metaobject/9');
    assert.equal(card.type, 'metaobject_reference');
  });

  it('keys the upsert on customId, never on the merchant-editable handle', async () => {
    const { stub } = await run({}, { level: [] });
    const id = stub.calls.find((c) => c.op === 'productSet').variables.identifier;
    assert.deepEqual(id, { customId: { namespace: 'custom', key: 'id', value: 'AAC-085' } });
  });

  it('A FAILED PUBLISH IS A FAILED PUBLISH — never ok with an invisible product', async () => {
    const { r, stub } = await run({}, { level: [], publish: 'no such publication' });
    assert.equal(r.ok, false);
    assert.match(r.error, /publish/);
    assert.ok(stub.ops().includes('productSet'), 'the product was created, which is exactly why this must not report ok');
    assert.equal(r.productGid, 'gid://shopify/Product/100', 'the caller needs the id to clean up or retry');
  });

  it('stops BEFORE publishing when the quantity could not be set', async () => {
    const { r, stub } = await run({}, { level: levelAt(LOC, 5), setQty: 'inventory is locked' });
    assert.equal(r.ok, false);
    assert.match(r.error, /inventory/);
    assert.ok(!stub.ops().includes('publish'), 'a visible product with the wrong quantity is the oversell this build exists to prevent');
  });

  it('refuses a missing publication pin BEFORE writing anything', async () => {
    const { r, stub } = await run({ publicationGid: null });
    assert.equal(r.ok, false);
    assert.match(r.error, /publication/);
    assert.deepEqual(stub.ops(), [], 'discovering this after productSet is how an invisible product happens');
  });

  it('refuses a missing location pin BEFORE writing anything', async () => {
    const { r, stub } = await run({ locationGid: null });
    assert.equal(r.ok, false);
    assert.match(r.error, /location/);
    assert.deepEqual(stub.ops(), []);
  });

  it('a dry run touches NOTHING — there is no Shopify preview call to make', async () => {
    const { r, stub } = await run({ dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.deepEqual(stub.ops(), [], 'a dry run that wrote would be a publish with a reassuring name');
    assert.equal(r.input.variants[0].sku, 'AAC-085');
  });

  // This used to assert the warning pointed at identity.rebuild as the remedy. It was wrong advice:
  // rebuildIdentity sends only the `listings` field, so against a metaobject that was never created it
  // is a CREATE with every other required field absent — the operator gets four "can't be blank" errors
  // when one field was missing, and three of them are innocent. Seen for real on 2026-08-25.
  //
  // The warning now carries the STORE'S OWN reason, and it is raised where a driver will actually print
  // it. Living only on steps[].warning is why the real cause never reached anyone: every driver renders
  // `warnings`, none renders `steps`.
  it('publishes anyway when only the identity failed, and reports the reason where it will be seen', async () => {
    const { r, stub } = await run({}, { level: [], identity: 'metaobject definition not found' });
    assert.equal(r.ok, true, 'a card that is correct and priced should not be withheld over a grouping field');
    assert.ok(stub.ops().includes('publish'));

    const s = r.steps.find((x) => x.step === 'identity');
    assert.equal(s.ok, false);
    assert.match(s.warning, /metaobject definition not found/, "the step carries the store's reason, not a guess at the remedy");

    assert.ok(r.warnings.some((w) => /NO card identity/.test(w)), 'and it must reach warnings, which is what drivers print');
    assert.ok(r.warnings.some((w) => /metaobject definition not found/.test(w)), 'carrying the reason with it');
  });

  it('refuses a row the map layer rejects, without calling anything', async () => {
    const { r, stub } = await run({ product: toShopifyProduct(row({ target_price_cents: null, price_cents: null })), item: row({ target_price_cents: null }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /validation/);
    assert.deepEqual(stub.ops(), []);
  });

  it('records every hop in steps[], so a half-finished publish is diagnosable', async () => {
    const { r } = await run({}, { level: [] });
    assert.deepEqual(r.steps.map((s) => s.step), ['validate', 'identity', 'set_identity', 'product_set', 'inventory', 'publish']);
    assert.ok(r.steps.every((s) => s.ok));
  });
});
