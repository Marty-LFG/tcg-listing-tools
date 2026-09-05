// lib/sealed-shopify.mjs — a sealed POOL as ONE Shopify product at quantity N.
//
// WHY A SEPARATE MODULE, and not a widening of lib/channels/shopify-map.mjs.
//
// lib/runs-shopify.mjs states the rule this follows: do not widen a working, test-pinned pipeline to
// serve a lane that is not armed yet. Sealed is a genuinely different shape from a single in every way
// that decides code — its own source table, its own SKU namespace, no shelf label, no card identity, no
// condition ladder, quantity greater than one, its own copy module and its own images table. Every one
// of those is a branch that would have to be threaded through toShopifyProduct, validateProduct and
// publishProduct, each of which currently serves exactly one shape and is pinned by tests that say so.
//
// What it does NOT re-implement is anything already generic. buildProductSetInput, productSetProduct,
// setAvailableQty, publishToChannel and taxonomyGid are imported unchanged, and so are PRODUCT_TYPES,
// TAXONOMY, dispatchWeightGrams and slug. That inheritance is the point: setAvailableQty alone carries
// the read-then-activate-or-compare-and-swap logic, the null-means-not-stocked distinction, a fresh
// idempotency key per attempt and a re-read-once stale path, all measured against the dev store.
//
// ONE VARIANT, so buildProductSetInput is reusable as-is. The runs module had to fork the productSet
// document only because a run needs one variant per bundle number and the shared document asks for
// `variants(first: 1)`. A sealed pool is one product with one variant at quantity N, which is exactly
// the shape that document already describes.
//
// THE POOL IS THE LISTING UNIT (D1, mirrored from the eBay lane). Several sealed_items rows share a
// pool_sku and publish as ONE product, so a restock revises the quantity rather than opening a second
// storefront listing competing with itself. Quantity comes from poolUnits — a SUM over
// sealed_placements — rather than the cached sealed_items.quantity mirror, because placements are the
// authoritative side.
//
// NO CARD IDENTITY. bk_card_identity groups the conditions of one card, and a booster box has no
// conditions. The singles orchestrator upserts one as step 1 and validateProduct hard-errors without an
// identity_key; both are why this module has its own gate and its own four-step publish. Sealed instead
// joins its SET, which is a separate relationship and a later slice.
import { buildProductSetInput, productSetProduct, setAvailableQty, publishToChannel }
  from './channels/shopify-product-api.mjs';
import { firstErrorText } from './channels/shopify-admin.mjs';
import { PRODUCT_TYPES, TAXONOMY, dispatchWeightGrams, slug } from './channels/shopify-map.mjs';
import { buildSealedTitle, buildSealedPitch, sealedCondText } from './sealed-copy.mjs';
import { SHOPIFY_CATALOGUE_ART, SHOPIFY_PROVENANCE, SEALED_PROTECTION } from './listing-copy.mjs';
import { poolUnits } from './sealed-listing.mjs';
import { sealedImageRows } from './sealed-images.mjs';
import { ensureShopifyMedia } from './channels/shopify-media.mjs';
import { recordShopifyListing, pinsFor, publishStatus } from './shopify.mjs';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The sealed product types the storefront lane is open for. Narrower than SEALED_GAMES on purpose and
// narrower than the eBay lane's V1_TYPES is allowed to be: a type outside this set has no verified
// dispatch weight sub-key and no agreed storefront presentation, and publishing it would guess at both.
export const V1_SEALED_TYPES = Object.freeze(['booster_box', 'booster_bundle', 'booster_pack']);

/** `BKS-…` is already the pool's own namespace; the handle just slugs it under a sealed prefix. */
export const sealedProductHandle = (pool) => `sealed-${slug(String(pool.pool_sku || ''))}`;

/**
 * The Shopify description for a sealed pool.
 *
 * Deliberately NOT buildSealedDescription. That one is the eBay frame: a dark masthead, a facts table,
 * and a postage paragraph built from the band. Two of those are wrong here. The band is an eBay
 * price-banded fact and test/invariants/shopify-no-ebay-postage.test.mjs forbids it reaching Shopify at
 * all; the table duplicates the PDP's own facts panel and flattens, for an agent, into
 * "Set White Flare Set code SV8a Product Booster box" — worse than the same facts in grammar.
 *
 * So: the same three-sentence shape buildShopifyDescription uses for a single. Identity first, because
 * it carries what the title cannot; then the brand line; then the parcel, with no figure in it, because
 * the theme owns shipping from schema settings.
 */
export function buildSealedShopifyDescription(pool) {
  if (pool.desc_override && String(pool.desc_override).trim()) return String(pool.desc_override).trim();
  const f = {
    name: pool.name, set_name: pool.set_name, set_code: pool.set_code,
    product_type: pool.product_type, language: pool.language, variant: pool.variant,
    pack_count: pool.pack_count, condition: pool.condition, factory_sealed: pool.factory_sealed,
  };
  const identity = [buildSealedPitch(f), sealedCondText(f)].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  const brand = [SHOPIFY_CATALOGUE_ART, SHOPIFY_PROVENANCE].join(' ');
  return [`<p>${esc(identity)}</p>`, `<p>${esc(brand)}</p>`, `<p>${esc(SEALED_PROTECTION)}</p>`].join('\n');
}

/**
 * Pool row + live unit count -> the product object publishProduct-shaped consumers expect.
 *
 * Pure, so the whole payload is assertable offline. Mirrors toShopifyProduct's output shape field for
 * field, minus `identity` (there is none) and plus nothing — a caller that can render a single can
 * render this.
 */
export function toSealedShopifyProduct(pool, { units = 0, status = 'ACTIVE', collections = [] } = {}) {
  const productType = PRODUCT_TYPES.sealed;
  const lang = String(pool.language || 'EN').toUpperCase();
  const f = {
    name: pool.name, set_name: pool.set_name, set_code: pool.set_code,
    product_type: pool.product_type, language: pool.language, variant: pool.variant,
    pack_count: pool.pack_count, condition: pool.condition, factory_sealed: pool.factory_sealed,
  };
  const metafields = [
    ['game', pool.game || 'pokemon'],
    ['set_code', pool.set_code],
    ['set_name', pool.set_name],
    ['language', lang],
    ['product_type', pool.product_type],
    ['pack_count', pool.pack_count != null ? String(pool.pack_count) : ''],
    ['release_status', pool.release_status || 'in-stock'],
  ]
    .filter(([, v]) => v !== '' && v != null)
    .map(([key, value]) => ({ namespace: 'bkc', key, value: String(value) }));

  return {
    sku: pool.pool_sku || null,
    // productSet upserts on custom.id — the only metafield type Shopify makes unique automatically.
    // The pool_sku is already stable and already unique, so it is the natural key here exactly as the
    // shelf label is for a single.
    customId: pool.pool_sku ? { namespace: 'custom', key: 'id', value: String(pool.pool_sku) } : null,
    kind: 'sealed',
    // No integer id: sealed_pools' primary key is the pool_sku text. Every sealed mirror lookup keys on
    // sku for that reason, and item_id stays null rather than carrying a sealed_items id that would
    // mean something different from the one the singles lane puts there.
    itemId: null,
    game: pool.game || 'pokemon',

    handle: sealedProductHandle(pool),
    title: (pool.title_override && String(pool.title_override).trim()) || buildSealedTitle(f),
    descriptionHtml: buildSealedShopifyDescription(pool),
    productType,
    taxonomyCategory: TAXONOMY.sealed,
    vendor: 'Binders Keepers',
    status: status === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
    tags: [
      pool.game || 'pokemon', pool.set_code, pool.set_name, 'sealed',
      String(pool.product_type || '').replace(/_/g, ' '),
    ].map((s) => String(s || '').trim()).filter(Boolean),

    price_cents: pool.price_cents != null ? Number(pool.price_cents) : null,
    quantity: units,
    // DENY, like every other lane: a pool that has sold out must stop selling. Sealed has no
    // one-of-one argument behind it, but overselling a booster box is the same broken promise.
    inventoryPolicy: 'DENY',
    tracked: true,
    // Sub-keyed by the sealed product_type — the table already exists in shopify-map and was
    // unreachable until this module, because nothing could produce a PRODUCT_TYPES.sealed product.
    weight_grams: dispatchWeightGrams({ product_type: pool.product_type }, productType),

    metafields,
    collections,
    // Deliberately absent: `identity`. A sealed product has no bk_card_identity, and emitting an empty
    // one would create a metaobject with no listings that rebuildIdentity would then keep rewriting.
    identity: null,
    imageSources: [],
  };
}

/**
 * The sealed gate. Its own function rather than a branch inside validateProduct, because almost none of
 * that one's rules apply: no identity_key, no condition ladder, no shelf label, no provisional SKU.
 */
export function validateSealedShopifyProduct(p, pool = {}) {
  const errors = [], warnings = [];

  if (p.kind !== 'sealed') errors.push(`this validator is for sealed pools, not "${p.kind}" stock`);
  if (!p.sku) errors.push('no pool SKU — productSet has nothing stable to key on');
  if (!V1_SEALED_TYPES.includes(String(pool.product_type || ''))) {
    errors.push(`sealed v1 publishes ${V1_SEALED_TYPES.join(', ')} — "${pool.product_type || '?'}" has no verified weight or presentation yet`);
  }
  // A pool at zero units is not a listing. The eBay lane refuses the same shape for the same reason:
  // an offer at quantity 0 advertises nothing and cannot be bought.
  if (!(p.quantity > 0)) errors.push('no units in stock for this pool');
  if (!(p.price_cents > 0)) errors.push('no price — set one on the pool before publishing');
  if (!p.title) errors.push('no title');
  else if (p.title.length > 255) errors.push(`title is ${p.title.length} characters — Shopify caps at 255`);
  if (!p.handle) errors.push('no handle');
  // The same refusal shopify-map makes for a single: a zero weight buys a label Australia Post will not
  // honour, and there is nowhere else for the number to come from.
  if (!(p.weight_grams > 0)) errors.push('no dispatch weight for this product type');

  // Sealed has no automatic art source — a card resolves an image from its game API, a booster box does
  // not — so a pool with no owner photo has nothing to show. A warning rather than an error here
  // because the caller resolves media separately and refuses on an empty set with a better message.
  if (!p.imageSources || !p.imageSources.length) warnings.push('no images resolved for this pool yet');

  return { errors, warnings };
}

/** One mirror row per POOL, kind='sealed'. Guarded the way recordRunListing guards its own kind. */
export function recordSealedListing(db, row) {
  if (row.kind && row.kind !== 'sealed') throw new Error(`recordSealedListing writes kind='sealed', not '${row.kind}'`);
  return recordShopifyListing(db, { ...row, kind: 'sealed', item_id: null });
}

/** The mirror row for one pool on one store. Keyed on sku, because item_id is null for sealed. */
export const sealedListingFor = (db, poolSku, store = 'dev') =>
  db.prepare(`SELECT * FROM shopify_listings WHERE store = ? AND kind = 'sealed' AND sku = ?`).get(store, String(poolSku));

/**
 * Publish one pool: productSet -> inventory -> publish to the Online Store, in that order.
 *
 * The order is the singles orchestrator's and it is kept for the same reason: publish LAST, so nothing
 * becomes visible unstocked, and a failure at the inventory step returns before publishing rather than
 * leaving a buyable product with no stock behind it.
 *
 * There is no identity step. That is the one thing this drops from the four, and dropping it is why the
 * module exists.
 */
export async function publishSealedProduct(env, {
  product, pool = {}, fileGids = [], ogFileGid = null, locationGid, publicationGid,
  store = 'dev', fetchImpl, dryRun = false,
} = {}) {
  const steps = [];
  const fail = (error, extra = {}) => ({ ok: false, error, steps, ...extra });
  if (!product) return fail('no product to publish');

  const v = validateSealedShopifyProduct(product, pool);
  steps.push({ step: 'validate', ok: !v.errors.length, error: v.errors.join('; ') || null, warnings: v.warnings });
  if (v.errors.length) return fail('validation: ' + v.errors.join('; '), { warnings: v.warnings });

  if (!product.customId) return fail('no pool SKU — productSet has nothing stable to key on');
  // Refused BEFORE the write, exactly as publishProduct refuses them: discovering a missing publication
  // after productSet has created the product is how a product ends up live-in-the-ledger and invisible
  // in the shop, and a missing location leaves a published product with no sellable stock.
  if (!locationGid) return fail('no shipping location pinned — set it in data/shopify.config.json');
  if (!publicationGid) return fail('no Online Store publication pinned — a product would be created invisible');

  const input = buildProductSetInput(product, { fileGids, ogFileGid, identityGid: null });
  if (dryRun) {
    steps.push({ step: 'dry_run', ok: true, error: null });
    return { ok: true, dryRun: true, input, identifier: { customId: product.customId }, warnings: v.warnings, steps };
  }

  // 1 — the product. productSetProduct reports ok/false without a message, so the userError text is
  // pulled off its response rather than reported as a bare "failed".
  const set = await productSetProduct(env, { identifier: { customId: product.customId }, input, store, fetchImpl });
  const setError = set.ok ? null : (firstErrorText(set.res) || `HTTP ${set.res?.httpStatus ?? '?'}`);
  steps.push({ step: 'product_set', ok: set.ok, error: setError, productGid: set.productGid || null });
  if (!set.ok) return fail(setError || 'productSet failed', { warnings: v.warnings });

  // 2 — inventory. setAvailableQty carries the compare-and-swap; a stale changeFromQuantity means a
  // sale landed underneath us, which is information rather than a failure to paper over.
  const qty = await setAvailableQty(env, {
    inventoryItemGid: set.inventoryItemGid, locationGid, quantity: product.quantity, store, fetchImpl,
  });
  steps.push({ step: 'inventory', ok: qty.ok, error: qty.error || null, available: qty.available ?? null });
  if (!qty.ok) {
    return fail(qty.error || 'could not set inventory', {
      productGid: set.productGid, variantGid: set.variantGid, inventoryItemGid: set.inventoryItemGid,
      warnings: v.warnings,
    });
  }

  // 3 — publish LAST. productSet returning a product id is not a successful publish: without this the
  // product exists, is invisible to buyers, and looks live in our ledger (§3.3).
  const pub = await publishToChannel(env, { productGid: set.productGid, publicationGid, store, fetchImpl });
  steps.push({ step: 'publish', ok: pub.ok, error: pub.error || null });

  return {
    ok: pub.ok,
    error: pub.ok ? null : (pub.error || 'publishablePublish failed'),
    productGid: set.productGid, variantGid: set.variantGid, inventoryItemGid: set.inventoryItemGid,
    handle: set.product?.handle || product.handle, status: set.product?.status || null,
    available: qty.available ?? null,
    warnings: v.warnings, steps,
  };
}

/**
 * Compose the Shopify frames for a pool by self-fetching the image lab's /build route.
 *
 * The singles twin is composeFrames in lib/shopify.mjs, and the two differ in the only two ways sealed
 * differs pictorially:
 *
 *   THE TARGET IS SQUARE. SHOPIFY_TARGET_FOR already says sealed -> 'shopify-square' and has since the
 *   target table was written; nothing could reach it, because nothing could produce a sealed product.
 *   The singles path hardcodes 'shopify-card' behind a ternary whose branches are identical — correct
 *   there, since a slab and a raw single are framed the same, and wrong the moment a box arrives.
 *
 *   THE ART HAS TO BE SUPPLIED. A card resolves its own picture from a game API; a booster box has no
 *   catalogue lookup at all, which is why sealed_pool_images exists and why a pool with no owner photo
 *   is a hard refusal rather than a warning. The first usable row is the hero. `url` is passed
 *   explicitly and survives catalogArtFor, which falls through to its fallback for anything that is
 *   not a One Piece card or a Japanese Pokémon one.
 */
export async function composeSealedFrames({ base, pool, imageUrl, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!imageUrl) return { ok: false, error: 'compose: this pool has no image — sealed product has no catalogue art to fall back on' };
  const body = {
    // Card-shaped on purpose: composeMetaFor reads these names to build the rail text, and a pool has
    // an equivalent for every field that matters to it. number and rarity are genuinely absent.
    stockRow: {
      game: pool.game || 'pokemon',
      name: pool.name || '',
      set_name: pool.set_name || '',
      set_code: pool.set_code || '',
      language: String(pool.language || 'EN').toUpperCase(),
      productType: PRODUCT_TYPES.sealed,
    },
    url: imageUrl,
    sku: pool.pool_sku,
    targets: ['shopify-square', 'og-card'],
    viewFor: { 'og-card': 'og' },
  };
  let r;
  try { r = await doFetch(`${base}/api/listing-image/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { return { ok: false, error: 'compose: ' + (e?.message || e) }; }
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!r.ok || !json?.manifest) {
    return { ok: false, error: 'compose: ' + (json?.error || `HTTP ${r.status}`), warnings: json?.warnings || [] };
  }
  return { ok: true, manifest: json.manifest, warnings: json.warnings || [] };
}

/**
 * runSealedShopifyPublish — pool SKU in, live product out.
 *
 * The sealed twin of runShopifyPublish, and shorter by everything sealed does not have: no shelf label
 * to reserve or commit (the pool_sku is its own namespace for life, and commitStockLabel writes to
 * inventory_items, which is the wrong table entirely), and no card identity to upsert or rebuild.
 *
 * What it keeps is the order that matters: validate before uploading anything, because a Shopify file
 * is permanent and has no bulk delete; and record the ledger row for a FAILURE as well as a success,
 * because a row that quietly vanishes on failure is a row nobody retries.
 */
export async function runSealedShopifyPublish({
  env, db, base, cfg, poolSku, store = 'dev', dryRun = false, fetchImpl,
} = {}) {
  const steps = [];
  const warnings = [];
  const pool = db.prepare('SELECT * FROM sealed_pools WHERE pool_sku = ?').get(String(poolSku || ''));
  if (!pool) return { ok: false, error: 'no such sealed pool: ' + poolSku, steps };

  const pins = pinsFor(cfg, store);
  const units = poolUnits(db, pool.pool_sku);
  steps.push({ step: 'units', ok: units > 0, units, error: units > 0 ? null : 'no units on the shelf for this pool' });

  const product = toSealedShopifyProduct(pool, { units, status: publishStatus(cfg) });

  // 1 — VALIDATE FIRST, before a single byte is staged. Same reasoning as the singles path: the media
  // layer's files are permanent, so a row the gate refuses would otherwise leave orphans on the store
  // for every attempt.
  const pre = validateSealedShopifyProduct(product, pool);
  steps.push({ step: 'validate', ok: !pre.errors.length, error: pre.errors.join('; ') || null, warnings: pre.warnings });
  if (pre.errors.length) return { ok: false, error: 'validation: ' + pre.errors.join('; '), steps, warnings };

  // 2 — the frames. A pool with no image cannot publish: unlike a card there is no catalogue art to
  // fall back on, so this is an error rather than the warning the singles lane can afford.
  const imgRows = sealedImageRows(db, pool.pool_sku);
  const hero = imgRows.find((r) => r.source_url || r.local_path) || null;
  const composed = await composeSealedFrames({
    base, pool, imageUrl: hero?.source_url || null, fetchImpl,
  });
  steps.push({ step: 'compose', ok: composed.ok, error: composed.error || null });
  if (composed.warnings?.length) warnings.push(...composed.warnings);
  if (!composed.ok) {
    if (!dryRun) {
      recordSealedListing(db, { sku: pool.pool_sku, store, state: 'failed', error: composed.error });
    }
    return { ok: false, error: composed.error, steps, warnings };
  }

  const media = await ensureShopifyMedia(env, db, { imageSet: composed.manifest, store, fetchImpl });
  // ensureShopifyMedia reports `errors` as an array, not a single `error` — a lost LATER frame is a
  // warning there, and only a missing position-1 image is fatal.
  const mediaError = (media.errors || []).join('; ') || null;
  steps.push({ step: 'media', ok: media.ok, error: mediaError, uploaded: media.uploaded, reused: media.reused });
  if (media.warnings?.length) warnings.push(...media.warnings);
  if (!media.ok) {
    if (!dryRun) recordSealedListing(db, { sku: pool.pool_sku, store, state: 'failed', error: mediaError });
    return { ok: false, error: mediaError || 'media failed', steps, warnings };
  }

  // 3 — the claim row, after validation and before the store round trip, for the reason the singles
  // lane writes one: a failure has to leave something behind that names what was attempted.
  if (!dryRun) recordSealedListing(db, { sku: pool.pool_sku, store, state: 'pending' });

  const result = await publishSealedProduct(env, {
    product, pool, fileGids: media.fileGids || [], ogFileGid: media.ogFileGid || null,
    locationGid: pins.locationGid, publicationGid: pins.publicationGid,
    store, fetchImpl, dryRun,
  });
  steps.push(...(result.steps || []));
  if (result.warnings?.length) warnings.push(...result.warnings);
  if (dryRun) return { ...result, sku: pool.pool_sku, units, steps, warnings, dryRun: true };

  recordSealedListing(db, {
    sku: pool.pool_sku, store,
    product_gid: result.productGid ?? null, variant_gid: result.variantGid ?? null,
    inventory_gid: result.inventoryItemGid ?? null, location_gid: pins.locationGid,
    handle: result.handle ?? product.handle,
    // 'live' means published to the Online Store publication, not merely created (§3.3).
    state: result.ok ? 'live' : 'failed',
    price_cents: product.price_cents, available_qty: result.available ?? units,
    error: result.ok ? null : (result.error || 'publish failed'),
  });

  return { ...result, sku: pool.pool_sku, units, steps, warnings };
}

/** Units on the shelf for a pool, re-exported so callers need only this module. */
export { poolUnits };
