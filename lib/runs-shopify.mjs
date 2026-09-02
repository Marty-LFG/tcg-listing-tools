// lib/runs-shopify.mjs — a Keeper's Run as ONE product with ONE VARIANT PER BUNDLE NUMBER.
//
// WHY A SEPARATE MODULE. lib/channels/shopify-product-api.mjs is hardcoded to one variant in three
// places — the PRODUCT_SET document asks for `variants(first: 1)`, buildProductSetInput emits a
// one-element array with the synthetic `Default Title` option, and productSetProduct reads `[0]`. That is
// correct for singles (one product per condition, D-012) and its tests pin the shape. Widening it would
// put the one pipeline that currently works at risk to serve a lane that is not even armed yet, so this
// module routes around it and touches neither file.
//
// It does NOT re-implement the parts that are already generic: `setAvailableQty` and `publishToChannel`
// are imported unchanged. That inheritance is the single most valuable reuse decision here —
// setAvailableQty carries the read-then-activate-or-compare-and-swap logic, the null-means-not-stocked
// distinction, a fresh idempotency key per attempt, and a re-read-and-re-decide-once stale path, all of
// it already measured against the dev store.
//
// WHY VARIANTS RATHER THAN N PRODUCTS. §5.6.3: the buyer picks their own number, and the storefront's own
// inventory is what stops a number selling twice and shows the true remaining set. Twenty-five separate
// products would scatter that across twenty-five pages and make "what is still available" something a
// buyer has to assemble by hand.
//
// INVENTORY IS SET ONE ITEM AT A TIME, DELIBERATELY. Batching the whole run into a single
// inventorySetQuantities call is the obvious optimisation and it is a trap: that mutation is atomic
// across its `quantities` array, so ONE stale changeFromQuantity — which is exactly what a concurrent
// sale produces — fails the write for every other number too. Per item is slower and cannot be poisoned
// by a neighbour.

import { shopifyGraphQL, firstErrorText } from './channels/shopify-admin.mjs';
import { setAvailableQty, publishToChannel, taxonomyGid } from './channels/shopify-product-api.mjs';
import { PRODUCT_TYPES, dispatchWeightGrams, slug } from './channels/shopify-map.mjs';
import { recordShopifyListing } from './shopify.mjs';
import { audit } from './runs-reserve.mjs';
import { availabilityFrom, ledgerEntries, asEntries } from './runs-ledger.mjs';

export const RUN_SKU_PREFIX = 'BK-RUN-';
export const BUNDLE_OPTION = 'Bundle';

/**
 * §5.6.3 lists one variant per bundle number, and `productSet(synchronous: true)` has a documented
 * variant ceiling. REFUSED above it rather than discovered: a silent truncation would publish a product
 * missing numbers the ledger believes are for sale, and the storefront would then be the only thing that
 * knew. A larger edition needs the asynchronous productSetOperation path, which is not built.
 */
export const MAX_SYNC_VARIANTS = 100;

const pad3 = (n) => String(n).padStart(3, '0');

export const runProductSku = (run) => `${RUN_SKU_PREFIX}${String(run.public_id).toUpperCase()}`;
export const runVariantSku = (run, bundleNo) => `${runProductSku(run)}-${pad3(bundleNo)}`;
export const runProductHandle = (run) => `keepers-run-${slug(String(run.public_id))}`;

/**
 * The one definition of "this SKU belongs to a run".
 *
 * Exported so postsale can recognise one without importing this module — see the note beside the
 * exclusion in applyStockDecrements. A run bundle's stock is drawn down at PACK time by
 * consumeReservation, so an order line for one of these must never reach a second decrement.
 */
export const RUN_SKU_RE = /^BK-RUN-[A-Z0-9-]+-\d{3}$/;
export const isRunSku = (sku) => RUN_SKU_RE.test(String(sku || '').toUpperCase());

export function parseRunSku(sku) {
  const s = String(sku || '').toUpperCase();
  if (!isRunSku(s)) return null;
  const m = /^BK-RUN-(.+)-(\d{3})$/.exec(s);
  return { publicId: m[1], bundleNo: Number(m[2]) };
}

// The one multi-variant document. `variants(first: 250)` because the selection must cover the whole set
// or the mirror below is written from a truncated response and the missing numbers read as never
// published.
const RUN_PRODUCT_SET = `
mutation BkRunProductSet($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
  productSet(identifier: $identifier, input: $input, synchronous: true) {
    product {
      id handle status
      variants(first: 250) {
        nodes { id sku inventoryItem { id } selectedOptions { name value } }
      }
    }
    userErrors { field message code }
  }
}`;

/**
 * The productSet input. Pure — no network, so the whole shape is unit-testable.
 *
 * NO PRICE APPEARS IN ANY COPY. The variant price is Shopify's own field and is what a buyer pays; the
 * title, description, tags and metafields carry none, because guardrail (a) is that a mystery bundle
 * never states a value for what is inside it.
 */
export function buildRunProductSetInput(run, bundles, {
  status = 'ACTIVE', descriptionHtml = '', tags = [], fileGids = [], collections = [], weightGrams = null,
} = {}) {
  const ordered = [...bundles].sort((a, b) => a.bundle_no - b.bundle_no);
  // dispatchWeightGrams(item, productType) — two arguments, and passing productType on the ITEM would
  // silently return 0, which Shopify would take as a weightless parcel.
  //
  // THE TABLE'S BUNDLE FIGURE IS A PLACEHOLDER and shopify-map says so: 250 g with no measurement
  // behind it. Edition 1 is a slab (~150 g shipped) plus three boosters (~60 g each) plus an art card,
  // an insert and a mailer, so 250 g is an UNDER-declaration and postage is priced off this. Weigh a
  // packed parcel and pass weightGrams before a live run sells.
  const weight = weightGrams ?? dispatchWeightGrams({}, PRODUCT_TYPES.bundle);

  const input = {
    handle: runProductHandle(run),
    title: `${run.name} — Keeper's Run ${run.public_id}`,
    descriptionHtml,
    productType: PRODUCT_TYPES.bundle,
    vendor: 'Binders Keepers',
    status,
    tags: ['keepers-run', `run-${String(run.public_id).toLowerCase()}`, ...tags],

    // A real option a buyer chooses, not the synthetic Default Title the singles path uses.
    productOptions: [{
      name: BUNDLE_OPTION, position: 1,
      values: ordered.map((b) => ({ name: pad3(b.bundle_no) })),
    }],

    variants: ordered.map((b) => ({
      optionValues: [{ optionName: BUNDLE_OPTION, name: pad3(b.bundle_no) }],
      sku: runVariantSku(run, b.bundle_no),
      price: centsToMoney(run.unit_price_cents),
      // DENY, so the storefront itself refuses a second sale of a number rather than accepting an
      // oversell we would then have to explain. §5.6.3 leans on exactly this.
      inventoryPolicy: 'DENY',
      inventoryItem: {
        tracked: true,
        ...(weight > 0 ? { measurement: { weight: { unit: 'GRAMS', value: weight } } } : {}),
      },
      // No inventoryQuantities: quantity is set per item afterwards, through the compare-and-swap.
    })),
  };
  if (collections.length) input.collections = collections;
  if (fileGids.length) input.files = fileGids.map((id) => ({ id }));
  return input;
}

const centsToMoney = (c) => (c == null ? '0.00' : (Math.round(+c) / 100).toFixed(2));

/** Everything wrong with this run as a product, before a byte is written. */
export function validateRunProduct(run, bundles, { locationGid, publicationGid } = {}) {
  const errors = [];
  if (!run?.public_id) errors.push('the run has no public identifier');
  if (!bundles?.length) errors.push('the run has no bundles');
  if (bundles && bundles.length !== run.unit_count) {
    errors.push(`the run declares ${run.unit_count} bundles but ${bundles.length} were given`);
  }
  if (bundles && bundles.length > MAX_SYNC_VARIANTS) {
    errors.push(`${bundles.length} bundles exceeds the ${MAX_SYNC_VARIANTS}-variant ceiling of a `
      + 'synchronous productSet; the asynchronous path is not built');
  }
  for (const b of bundles || []) {
    if (!(b.bundle_no > 0)) errors.push('a bundle has no number');
  }
  const nos = (bundles || []).map((b) => b.bundle_no);
  if (new Set(nos).size !== nos.length) errors.push('two bundles share a number');
  if (!locationGid) errors.push('no location is pinned for this store');
  if (!publicationGid) errors.push('no publication is pinned for this store');
  if (run && run.unit_price_cents == null) errors.push('the run has no price');
  return { ok: !errors.length, errors };
}

export async function productSetRun(env, { identifier, input, store = 'dev', fetchImpl, graphql = null } = {}) {
  const call = graphql || shopifyGraphQL;
  const res = await call(env, RUN_PRODUCT_SET, { identifier, input }, { store, fetchImpl, estimate: 50 });
  if (!res.ok) return { ok: false, error: firstErrorText(res) || `HTTP ${res.httpStatus}`, res };
  const ue = res.data?.productSet?.userErrors || [];
  if (ue.length) return { ok: false, error: ue.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; '), res };
  const product = res.data?.productSet?.product;
  if (!product?.id) return { ok: false, error: 'productSet returned no product', res };

  const variants = (product.variants?.nodes || []).map((v) => ({
    variantGid: v.id,
    sku: v.sku,
    inventoryItemGid: v.inventoryItem?.id || null,
    bundleNo: Number(v.selectedOptions?.find((o) => o.name === BUNDLE_OPTION)?.value ?? NaN),
  }));
  return { ok: true, product, productGid: product.id, handle: product.handle, status: product.status, variants, res };
}

/** One mirror row per BUNDLE, kind='run'. */
export function recordRunListing(db, row) {
  if (row.kind && row.kind !== 'run') throw new Error(`recordRunListing writes kind='run', not '${row.kind}'`);
  return recordShopifyListing(db, { ...row, kind: 'run' });
}

export const runListings = (db, runId) =>
  db.prepare(`SELECT sl.* FROM shopify_listings sl
                JOIN run_bundles b ON b.id = sl.item_id
               WHERE sl.kind = 'run' AND b.run_id = ? ORDER BY b.bundle_no`).all(+runId);

export const runListingFor = (db, runId, bundleNo) =>
  db.prepare(`SELECT sl.* FROM shopify_listings sl
                JOIN run_bundles b ON b.id = sl.item_id
               WHERE sl.kind = 'run' AND b.run_id = ? AND b.bundle_no = ?`).get(+runId, +bundleNo);

/**
 * Publish the run as a product and stock every number at one.
 *
 * The four-step order of the singles orchestrator is kept for the same reasons: set the product, then
 * inventory, then publish LAST, so nothing becomes visible unstocked. A failure at the inventory step
 * returns before publishing rather than leaving a buyable product with no stock behind it.
 */
/**
 * The numbers still for sale, read from the LEDGER rather than from run_bundles.status.
 *
 * A sale is a ledger entry and nothing more - appendEntry never touches a bundle row - so
 * run_bundles.status sits on its 'open' default for the whole life of a sold number. Deciding stock
 * from that column meant every republish RESTOCKED numbers that had already sold, offering a bundle
 * that was already in the post. The ledger is the availability proof we publish to buyers; it has to be
 * the availability proof we act on too, or the two disagree and only the buyer's copy is right.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: number, unit_count: number }} run
 * @returns {Set<number>} bundle numbers not yet accounted for
 */
export function sellableSet(db, run) {
  return new Set(availabilityFrom(run.unit_count, asEntries(ledgerEntries(db, run.id))).available);
}

/**
 * What one number should carry on the storefront.
 *
 * BOTH TESTS, and neither is redundant. The ledger knows what SOLD; the bundle row knows what has been
 * packed and is physically spoken for, which the ledger cannot see. A number failing either is not for
 * sale, and a number that has never been either is exactly one unit - never more, because the whole
 * point of one variant per number is that a number is a single object.
 *
 * @param {{ bundle_no: number, status: string }} bundle
 * @param {Set<number>} sellable
 * @returns {0|1}
 */
export const stockFor = (bundle, sellable) =>
  (sellable.has(bundle.bundle_no) && bundle.status === 'open') ? 1 : 0;

export async function publishRunProduct(env, db, {
  run, bundles, locationGid, publicationGid, store = 'dev', fetchImpl, graphql = null,
  status = 'ACTIVE', descriptionHtml = '', dryRun = false, actor = null,
} = {}) {
  const steps = [];
  const v = validateRunProduct(run, bundles, { locationGid, publicationGid });
  steps.push({ step: 'validate', ok: v.ok, errors: v.errors });
  if (!v.ok) return { ok: false, errors: v.errors, steps };

  const input = buildRunProductSetInput(run, bundles, { status, descriptionHtml });
  if (dryRun) {
    steps.push({ step: 'dry_run', ok: true, variants: input.variants.length });
    return { ok: true, dryRun: true, input, steps };
  }

  // handle, not customId: customId is the metafield-keyed identifier the singles pipeline owns, and
  // sharing that namespace is how a run and a shelf label collide.
  const set = await productSetRun(env, {
    identifier: { handle: input.handle }, input, store, fetchImpl, graphql,
  });
  steps.push({ step: 'product_set', ok: set.ok, variants: set.variants?.length ?? 0, error: set.error || null });
  if (!set.ok) return { ok: false, error: set.error, steps };

  if (set.variants.length !== bundles.length) {
    // A truncated response would leave numbers the ledger believes are for sale with no mirror row and
    // no stock, and nothing downstream would notice.
    return {
      ok: false, steps,
      error: `productSet returned ${set.variants.length} variants for ${bundles.length} bundles`,
    };
  }

  const byNo = new Map(bundles.map((b) => [b.bundle_no, b]));
  const sellable = sellableSet(db, run);
  const stocked = [];
  for (const variant of set.variants.sort((a, b) => a.bundleNo - b.bundleNo)) {
    const bundle = byNo.get(variant.bundleNo);
    if (!bundle) return { ok: false, error: `Shopify returned a variant for unknown bundle ${variant.bundleNo}`, steps };
    const want = stockFor(bundle, sellable);
    const q = await setAvailableQty(env, {
      inventoryItemGid: variant.inventoryItemGid, locationGid, quantity: want, store, fetchImpl,
      referenceDocumentUri: `gid://tcg-listing-tools/runs/${run.public_id}/${pad3(variant.bundleNo)}`,
    });
    if (!q.ok) {
      steps.push({ step: 'inventory', ok: false, bundle_no: variant.bundleNo, error: q.error || 'set failed' });
      return { ok: false, error: `stocking bundle ${pad3(variant.bundleNo)}: ${q.error || 'failed'}`, steps };
    }
    stocked.push({ ...variant, quantity: want, action: q.action });
  }
  steps.push({ step: 'inventory', ok: true, count: stocked.length });

  const pub = await publishToChannel(env, { productGid: set.productGid, publicationGid, store, fetchImpl });
  steps.push({ step: 'publish', ok: pub.ok });
  if (!pub.ok) return { ok: false, error: 'the product was set and stocked but not published to the channel', steps };

  for (const s of stocked) {
    recordRunListing(db, {
      sku: s.sku, item_id: byNo.get(s.bundleNo).id, product_gid: set.productGid, variant_gid: s.variantGid,
      inventory_gid: s.inventoryItemGid, location_gid: locationGid, handle: set.handle,
      state: status === 'ACTIVE' ? 'live' : 'unpublished', available_qty: s.quantity,
      price_cents: run.unit_price_cents, currency: run.currency || 'AUD',
    });
  }
  db.prepare("UPDATE runs SET shopify_sku = ?, updated_at = datetime('now') WHERE id = ?")
    .run(runProductSku(run), run.id);
  audit(db, { runId: run.id, entity: 'runs', entityId: run.id, action: 'product_published', actor,
    after: { product_gid: set.productGid, handle: set.handle, variants: stocked.length, store } });

  return { ok: true, productGid: set.productGid, handle: set.handle, status: set.status, variants: stocked, steps };
}

/**
 * Set one bundle number's availability — the in-person sale, the cancellation, and the event pause.
 *
 * THE LEDGER IS WRITTEN FIRST, ALWAYS. §5.6.3 makes the ledger the availability proof and the storefront
 * a mirror of it. Reversed, a network failure after the storefront write would leave a number nobody can
 * buy and no record of why; in this order it leaves a number sold in the ledger and still purchasable
 * online, which the next poll finds and refuses BY NAME. Loud beats silent.
 */
export async function setBundleAvailable(env, db, {
  run, bundleNo, quantity, store = 'dev', fetchImpl, reason = 'correction', actor = null,
} = {}) {
  const row = runListingFor(db, run.id, bundleNo);
  if (!row) throw new Error(`run ${run.public_id} bundle ${pad3(bundleNo)} has no published listing`);
  if (!row.inventory_gid || !row.location_gid) throw new Error(`bundle ${pad3(bundleNo)} has no inventory item on file`);

  const q = await setAvailableQty(env, {
    inventoryItemGid: row.inventory_gid, locationGid: row.location_gid, quantity, store, fetchImpl, reason,
    referenceDocumentUri: `gid://tcg-listing-tools/runs/${run.public_id}/${pad3(bundleNo)}`,
  });
  if (!q.ok) throw new Error(`could not set bundle ${pad3(bundleNo)} to ${quantity}: ${q.error || 'failed'}`);
  recordRunListing(db, { sku: row.sku, item_id: row.item_id, available_qty: quantity });
  audit(db, { runId: run.id, entity: 'shopify_listings', entityId: null, action: 'availability_set', actor,
    after: { bundle_no: bundleNo, quantity, action: q.action } });
  return { ok: true, action: q.action, from: q.from, to: quantity };
}

/** What Shopify last told us was available, per number. Reconciled against the ledger, never assumed. */
export const mirrorAvailability = (db, runId) =>
  Object.fromEntries(runListings(db, runId).map((r) => [parseRunSku(r.sku)?.bundleNo, r.available_qty]));

export { taxonomyGid };
