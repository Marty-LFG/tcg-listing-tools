// lib/channels/shopify-product-api.mjs — the Shopify publish sequence.
//
// The twin of lib/channels/ebay-inventory-api.mjs, and deliberately the same shape: pure payload
// builders at the top, one thin wrapper per mutation in the middle, and a single orchestrator at the
// bottom that returns { ok, steps[] } with every hop recorded. `steps` is not decoration — it is what
// makes a half-finished publish diagnosable, and a publish here has four places to stop rather than
// eBay's three.
//
// EVERY MUTATION SHAPE BELOW WAS VERIFIED, not remembered. productSet and inventorySetQuantities were
// measured against the real dev store by scripts/check-shopify.mjs (probes 2 and 3); publishablePublish,
// metaobjectUpsert, inventoryActivate and the two input objects were read off shopify.dev at the pinned
// version. That mattered more than it usually does — see the metaobject note below, where the intuitive
// reading of the API silently destroys the PDP.
//
// WHAT THIS FILE DOES NOT DO. It does not touch tracker.db, it does not decide whether a row should be
// published, and it does not build the images — media is S5's job and arrives here as file ids. It also
// never appends to the identity metaobject's `listings` list; that is identity.rebuild's job, for the
// race reason recorded at upsertIdentity.
import crypto from 'node:crypto';
import { shopifyGraphQL, centsToMoney, firstErrorText } from './shopify-admin.mjs';
import { validateProduct } from './shopify-map.mjs';

// Shopify's taxonomy ids travel as GIDs on ProductSetInput.category, but the vocabulary the map layer
// speaks is the bare id ('ae-2-2-3-2'), because that is what the taxonomy documents and what a human
// can look up. One place converts.
export const taxonomyGid = (id) => (id ? `gid://shopify/TaxonomyCategory/${id}` : null);

// --- the mutations --------------------------------------------------------------------------------

// `synchronous: true` because the alternative is polling a job for a result we need before the next
// step can run. The product comes back with its variant and inventory-item ids, which steps 3 and 4
// both need — asking for them here saves a round trip and makes those steps unable to run against a
// product that was not actually written.
const PRODUCT_SET = `
mutation BkProductSet($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
  productSet(identifier: $identifier, input: $input, synchronous: true) {
    product {
      id handle status
      variants(first: 1) { nodes { id sku inventoryItem { id } } }
    }
    userErrors { field message code }
  }
}`;

// PATCH SEMANTICS, AND THAT IS THE ENTIRE POINT OF USING THIS FORM.
// metaobjectUpsert takes EITHER `metaobject: { fields: [...] }` or `values: {...}`, and they are
// opposites: `fields` updates only the keys you send, `values` is a full replacement that CLEARS every
// key you omit. `values` is the more natural-looking of the two and it would be catastrophic here.
// Publishing a sibling would send the descriptive fields, omit `listings`, and wipe the condition list
// off the identity — blanking the PDP's condition selector for every other condition of that card
// until identity.rebuild happened to run, and permanently if it failed. With `fields`, a publish
// physically cannot touch `listings`. Do not "simplify" this to `values`.
const METAOBJECT_UPSERT = `
mutation BkIdentity($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
  metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
    metaobject { id handle }
    userErrors { field message code }
  }
}`;

const READ_LEVEL = `
query BkLevel($id: ID!) {
  inventoryItem(id: $id) {
    inventoryLevels(first: 20) {
      nodes { location { id } quantities(names: ["available"]) { name quantity } }
    }
  }
}`;

// @idempotent is REQUIRED on both inventory mutations as of 2026-04. The key is minted per ATTEMPT and
// never reused across a retry: reusing it would make the retry a replay of the first call's result,
// which is precisely how a compare-and-swap that actually failed gets reported as a success.
const INVENTORY_ACTIVATE = `
mutation BkActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int!, $key: String!) {
  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) @idempotent(key: $key) {
    inventoryLevel { id quantities(names: ["available"]) { name quantity } }
    userErrors { field message }
  }
}`;

const INVENTORY_SET = `
mutation BkSetQty($input: InventorySetQuantitiesInput!, $key: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $key) {
    inventoryAdjustmentGroup { changes { name delta quantityAfterChange } }
    userErrors { field message code }
  }
}`;

const PUBLISHABLE_PUBLISH = `
mutation BkPublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    publishable { availablePublicationsCount { count } }
    userErrors { field message }
  }
}`;

// --- payload builders (pure) ----------------------------------------------------------------------

/**
 * buildProductSetInput(p, opts) -> ProductSetInput
 *
 * ⚠ EVERY LIST FIELD HERE IS A COMPLETE REPLACEMENT. S0 probe 2 measured this against the dev store:
 * publish three metafields and three tags, call productSet again with one of each, and the other two
 * of BOTH are gone. shopify.dev documents the behaviour for `tags` only, which is exactly why the
 * probe existed — the measurement is the source of truth here, not the page.
 *
 * The consequence is a rule with no exceptions: this builder always emits the FULL desired state from
 * tracker.db. There is deliberately no "patch" or "partial" mode, because a partial productSet is not
 * a smaller write, it is a deletion of everything omitted.
 */
export function buildProductSetInput(p, { fileGids = [], identityGid = null, ogFileGid = null } = {}) {
  // The metafields the map layer built, plus the two ids that only exist once their objects do. Copied
  // rather than mutated: `p` is the caller's, and a builder that edits its input is a builder that
  // behaves differently the second time it is called.
  const metafields = [...(p.metafields || [])];
  const putMf = (mf) => {
    // Replace rather than append — two metafields with the same namespace/key is a userError from
    // Shopify, not a last-one-wins.
    const at = metafields.findIndex((m) => m.namespace === mf.namespace && m.key === mf.key);
    if (at >= 0) metafields[at] = mf; else metafields.push(mf);
  };
  // The map layer emits bkc.card itself when it already knows the GID; on a first publish it cannot,
  // because the metaobject does not exist yet, so the value is spliced in here.
  if (identityGid) putMf({ namespace: 'bkc', key: 'card', value: identityGid, type: 'metaobject_reference' });
  if (ogFileGid) putMf({ namespace: 'bkc', key: 'og_image', value: ogFileGid, type: 'file_reference' });

  const input = {
    handle: p.handle,
    title: p.title,
    descriptionHtml: p.descriptionHtml,
    productType: p.productType,
    vendor: p.vendor,
    status: p.status || 'ACTIVE',
    tags: p.tags || [],
    metafields,

    // One variant per product (D-012: one product per condition), so the option is the synthetic
    // single-value one Shopify requires rather than anything a buyer chooses.
    productOptions: [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }],
    variants: [{
      optionValues: [{ optionName: 'Title', name: 'Default Title' }],
      sku: p.sku,
      price: centsToMoney(p.price_cents),
      inventoryPolicy: p.inventoryPolicy || 'DENY',
      inventoryItem: { tracked: p.tracked !== false },
      // NO inventoryQuantities, on purpose — see setAvailableQty below.
    }],
  };

  if (p.taxonomyCategory) input.category = taxonomyGid(p.taxonomyCategory);
  if (p.collections && p.collections.length) input.collections = p.collections;

  // `id`, NOT `originalSource`. FileSetInput has both: originalSource takes a URL (external, or a
  // staged upload target) and MINTS A NEW FILE; `id` references a file that already exists. S5 uploads
  // once and caches on the compositor's content hash, so the ids arriving here are already real files.
  // Sending them as originalSource would re-upload on every republish — exactly the litter the cache
  // exists to prevent, and Shopify Files has no bulk delete.
  if (fileGids.length) input.files = fileGids.map((id) => ({ id }));

  return input;
}

// --- one wrapper per mutation ---------------------------------------------------------------------

const stepOf = (name, res, extra = {}) => ({
  step: name,
  ok: !!res?.ok,
  error: res?.ok ? null : (firstErrorText(res) || `HTTP ${res?.httpStatus ?? '?'}`),
  httpStatus: res?.httpStatus ?? null,
  ...extra,
});

/**
 * The identity metaobject. Upserted BEFORE the product, because the product's bkc.card metafield has to
 * point at it and a metafield cannot reference an object that does not exist yet.
 *
 * ⚠ `listings` IS NOT WRITTEN HERE, and must never be. Publishing NM and LP concurrently would have
 * both read the list, both append, and one silently win — a condition vanishing from the PDP with no
 * error anywhere. identity.rebuild recomputes the whole list from tracker.db instead, which is
 * idempotent, self-healing, and coalesces ten sibling publishes into one write.
 */
export async function upsertIdentity(env, { identity, store = 'dev', fetchImpl } = {}) {
  if (!identity?.handle) return { ok: false, gid: null, res: null, error: 'no identity handle' };
  const fields = Object.entries(identity.fields || {})
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([key, value]) => ({ key, value: String(value) }));
  const res = await shopifyGraphQL(env, METAOBJECT_UPSERT, {
    handle: { type: identity.type || 'bk_card_identity', handle: identity.handle },
    metaobject: { fields },
  }, { store, fetchImpl, estimate: 10 });
  return { ok: res.ok, gid: res.ok ? res.data?.metaobjectUpsert?.metaobject?.id || null : null, res };
}

export async function productSetProduct(env, { identifier, input, store = 'dev', fetchImpl } = {}) {
  const res = await shopifyGraphQL(env, PRODUCT_SET, { identifier, input },
    { store, fetchImpl, estimate: 30 + (input?.files?.length || 0) * 2 });
  const product = res.ok ? res.data?.productSet?.product || null : null;
  return {
    ok: res.ok && !!product,
    product,
    productGid: product?.id || null,
    variantGid: product?.variants?.nodes?.[0]?.id || null,
    inventoryItemGid: product?.variants?.nodes?.[0]?.inventoryItem?.id || null,
    res,
  };
}

export async function readAvailable(env, { inventoryItemGid, locationGid, store = 'dev', fetchImpl } = {}) {
  const res = await shopifyGraphQL(env, READ_LEVEL, { id: inventoryItemGid }, { store, fetchImpl, estimate: 10 });
  if (!res.ok) return { ok: false, available: null, res };
  const node = res.data?.inventoryItem?.inventoryLevels?.nodes?.find((n) => n.location?.id === locationGid);
  const q = node?.quantities?.find((x) => x.name === 'available')?.quantity;
  // `null` means NOT STOCKED AT THIS LOCATION, which is a different fact from 0 and drives a different
  // mutation below. Collapsing the two would send a compare-and-swap against a level that does not
  // exist, and read as a mysterious failure rather than "this needs activating".
  return { ok: true, available: Number.isFinite(q) ? q : null, res };
}

/**
 * setAvailableQty — make `available` equal `quantity` at the pinned location.
 *
 * Read first, then activate or compare-and-swap. The read is not an optimisation: a product created by
 * productSet is ALREADY active at the location (measured in S0 probe 3), so an unconditional activate
 * fails every time after the first with "already active" — harmless, but it puts an alarming line in
 * the log for the entirely normal case, and noise in a diagnostic costs real time later.
 *
 * ⚠ changeFromQuantity is the ONLY defence against the simultaneous-purchase race, and this catalogue
 * is mostly one-of-one. A bare set silently wins over a concurrent sale and oversells the card. On a
 * stale compare we re-READ and re-decide rather than retrying the same numbers — the whole point is
 * that the world moved, so the old intent may no longer be the right one.
 *
 * `available`, never `on_hand`: an order in flight sits in `committed`, which the Admin API cannot
 * touch, and writing on_hand would fight the checkout for the same number.
 */
export async function setAvailableQty(env, {
  inventoryItemGid, locationGid, quantity, store = 'dev', fetchImpl,
  referenceDocumentUri = 'gid://tcg-listing-tools/publish', reason = 'correction', _retry = 0,
} = {}) {
  const read = await readAvailable(env, { inventoryItemGid, locationGid, store, fetchImpl });
  if (!read.ok) {
    return { ok: false, action: 'read', error: 'could not read the current level: ' + (firstErrorText(read.res) || ''), res: read.res };
  }

  if (read.available === null) {
    const res = await shopifyGraphQL(env, INVENTORY_ACTIVATE, {
      inventoryItemId: inventoryItemGid, locationId: locationGid, available: quantity, key: crypto.randomUUID(),
    }, { store, fetchImpl, estimate: 20 });
    return { ok: res.ok, action: 'activate', from: null, to: quantity, res };
  }

  if (read.available === quantity) {
    return { ok: true, action: 'noop', from: read.available, to: quantity, res: read.res };
  }

  const res = await shopifyGraphQL(env, INVENTORY_SET, {
    input: {
      name: 'available', reason, referenceDocumentUri,
      quantities: [{ inventoryItemId: inventoryItemGid, locationId: locationGid, quantity, changeFromQuantity: read.available }],
    },
    key: crypto.randomUUID(),
  }, { store, fetchImpl, estimate: 20 });

  if (!res.ok && _retry < 1 && /stale|CHANGE_FROM_QUANTITY/i.test(firstErrorText(res) || '')) {
    return setAvailableQty(env, {
      inventoryItemGid, locationGid, quantity, store, fetchImpl, referenceDocumentUri, reason, _retry: _retry + 1,
    });
  }
  return { ok: res.ok, action: 'set', from: read.available, to: quantity, retried: _retry > 0, res };
}

export async function publishToChannel(env, { productGid, publicationGid, store = 'dev', fetchImpl } = {}) {
  const res = await shopifyGraphQL(env, PUBLISHABLE_PUBLISH,
    { id: productGid, input: [{ publicationId: publicationGid }] }, { store, fetchImpl, estimate: 10 });
  return { ok: res.ok, res };
}

// --- the orchestrator ------------------------------------------------------------------------------

/**
 * publishProduct(env, { product, ... }) -> { ok, productGid, handle, steps[] }
 *
 * The four network steps, in the one order that is safe:
 *
 *   1. identity metaobject   — the product's bkc.card must point at something that exists
 *   2. productSet            — complete state, keyed on customId
 *   3. inventory             — separately, because productSet's inventory input has no compare-and-swap
 *   4. publishablePublish    — LAST, so nothing is ever visible unstocked
 *
 * ⚠ THE PUBLISH STEP IS NOT OPTIONAL AND ITS FAILURE IS NOT COSMETIC. A product that is created but
 * never published exists, is invisible to buyers, and looks completely live in our ledger — which is
 * worse than a clean failure, because the delayed-eBay window would then be protecting a card that is
 * for sale on ZERO channels. A missing publication GID is a REFUSAL before any writing starts, not a
 * step we skip and report ok.
 *
 * ⚠ THERE IS NO SHOPIFY DRY RUN. eBay has getListingFees; Shopify has no analogue, and productSet on a
 * real identifier creates a real product. So dryRun here is purely local: build, validate, return the
 * payload, call NOTHING. A "dry run" that touched the store would be a publish with a reassuring name.
 */
export async function publishProduct(env, {
  product, fileGids = [], ogFileGid = null, locationGid, publicationGid,
  store = 'dev', fetchImpl, dryRun = false, item = {},
} = {}) {
  const steps = [];
  const fail = (error, extra = {}) => ({ ok: false, error, steps, ...extra });

  if (!product) return fail('no product to publish');

  // Validation before anything else. A wrong card on a customer-facing storefront is a dispute, and
  // the map layer's refusals are the only thing standing between a half-identified row and a PDP
  // (GR4/GR7).
  const v = validateProduct(product, item);
  steps.push({ step: 'validate', ok: !v.errors.length, error: v.errors.join('; ') || null, warnings: v.warnings });
  if (v.errors.length) return fail('validation: ' + v.errors.join('; '), { warnings: v.warnings });

  if (!product.customId) return fail('no SKU — productSet has nothing stable to key on');

  // Refuse the two pins BEFORE writing. Discovering a missing publication after productSet has already
  // created the product is exactly how a product ends up live-in-the-ledger and invisible in the shop;
  // discovering a missing location after that leaves a published product with no sellable stock.
  if (!locationGid) return fail('no shipping location pinned — set it in data/shopify.config.json');
  if (!publicationGid) return fail('no Online Store publication pinned — a product would be created invisible');

  if (dryRun) {
    const input = buildProductSetInput(product, { fileGids, ogFileGid, identityGid: null });
    steps.push({ step: 'dry_run', ok: true, error: null });
    return { ok: true, dryRun: true, input, identifier: { customId: product.customId }, warnings: v.warnings, steps };
  }

  // 1 — identity
  const ident = await upsertIdentity(env, { identity: product.identity, store, fetchImpl });
  steps.push(stepOf('identity', ident.res || { ok: ident.ok }, { handle: product.identity?.handle || null }));
  // A failed identity is NOT fatal to the publish: the card is still correct, still priced, still
  // photographed. What breaks is the PDP's condition grouping, which is a degraded page rather than a
  // wrong one — so it publishes and says so, loudly, rather than withholding a sellable card (GR7).
  if (!ident.ok) {
    steps[steps.length - 1].warning =
      'published WITHOUT a card identity — the PDP condition selector will not group this card until identity.rebuild runs';
  }

  // 2 — the product itself
  const input = buildProductSetInput(product, { fileGids, ogFileGid, identityGid: ident.gid });
  const set = await productSetProduct(env, { identifier: { customId: product.customId }, input, store, fetchImpl });
  steps.push(stepOf('product_set', set.res, { productGid: set.productGid, handle: set.product?.handle || null }));
  if (!set.ok) return fail('productSet: ' + (firstErrorText(set.res) || `HTTP ${set.res?.httpStatus}`), { input });
  if (!set.inventoryItemGid) {
    return fail('productSet returned no inventory item — quantity cannot be set', { productGid: set.productGid, input });
  }

  // 3 — inventory, separately and guarded
  const qty = product.quantity != null ? product.quantity : 1;
  const inv = await setAvailableQty(env, {
    inventoryItemGid: set.inventoryItemGid, locationGid, quantity: qty, store, fetchImpl,
    referenceDocumentUri: `gid://tcg-listing-tools/publish/${product.sku}`,
  });
  steps.push(stepOf('inventory', inv.res || { ok: inv.ok }, { action: inv.action, from: inv.from, to: inv.to, retried: !!inv.retried }));
  if (!inv.ok) {
    // Stop BEFORE publishing. A visible product whose quantity is not what tracker.db believes is the
    // oversell this whole build exists to prevent — leaving it unpublished is the safe half of a bad
    // situation, and the row stays visibly unfinished in the ledger.
    return fail('inventory: ' + (inv.error || firstErrorText(inv.res) || 'could not set the available quantity'),
      { productGid: set.productGid, handle: set.product?.handle || null, input });
  }

  // 4 — publish, last
  const pub = await publishToChannel(env, { productGid: set.productGid, publicationGid, store, fetchImpl });
  steps.push(stepOf('publish', pub.res));
  if (!pub.ok) {
    return fail('publish: ' + (firstErrorText(pub.res) || `HTTP ${pub.res?.httpStatus}`),
      { productGid: set.productGid, handle: set.product?.handle || null, input });
  }

  return {
    ok: true,
    productGid: set.productGid,
    variantGid: set.variantGid,
    inventoryItemGid: set.inventoryItemGid,
    identityGid: ident.gid,
    handle: set.product?.handle || null,
    quantity: qty,
    warnings: v.warnings,
    input,
    steps,
  };
}
