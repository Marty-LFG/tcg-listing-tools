// lib/sealed-listing.mjs — publishing a SEALED pool to eBay.
//
// Reuses lib/channels/ebay-inventory-api.mjs wholesale rather than forking the publish orchestration:
// createOrReplaceInventoryItem -> getOffers/createOffer or updateOffer -> publishOffer, with its
// retries, rate limiting and step-by-step audit. The one thing that had to change there was the
// condition enum (1000 NEW). Everything else is achieved by handing publishListing a correctly shaped
// `listing`, in particular a pre-stamped `postageBand`, which offerBandFor prefers over re-deriving
// one from price. That is what keeps sealed off the price-banded table entirely (plan D10).
//
// The POOL is the listing unit. Several sealed_items rows share a pool_sku and publish as ONE offer at
// quantity N (D1), so a restock revises rather than competing with itself.
import { publishListing } from './channels/ebay-inventory-api.mjs';
import { buildSealedTitle, buildSealedDescription, buildSealedPitch } from './sealed-copy.mjs';

export const SEALED_CONDITION_ID = 1000;                       // eBay "New"
export const V1_TYPES = ['booster_box', 'booster_bundle', 'booster_pack'];
// Size class, not price. Packs and bundles share a satchel; a box needs its own.
export const BAND_FOR_TYPE = { booster_pack: 'sealed_small', booster_bundle: 'sealed_small', booster_box: 'sealed_medium' };


// eBay AU sealed categories, read live off get_category_suggestions on 2026-08-19 (tree 15):
//   261044  Toys & Hobbies > Collectable Card Games > CCG Sealed Boxes
//   183456  Toys & Hobbies > Collectable Card Games > CCG Sealed Packs
// It is TWO categories, not one, which is why this is keyed by product type the same way postage is.
//
// booster_bundle is the one judgement call, and it is recorded as such: eBay's TOP suggestion for
// "pokemon booster bundle" is 183462, CCG Supplies > Deck Boxes, Storage Cases & Dividers, which is
// flatly wrong. Its second suggestion is 261044, and a bundle is a sealed box of packs, so 261044 it
// is. That mismatch is the reason suggestions are surfaced to the owner and never auto-adopted.
export const SEALED_CATEGORY = { booster_box: '261044', booster_bundle: '261044', booster_pack: '183456' };

/** Config wins over the baked value, so a category eBay moves can be corrected without a release. */
export function sealedCategoryFor(productType, cfg) {
  const s = (cfg || {}).sealed || {};
  return (s.categories && s.categories[productType]) || s.categoryId || SEALED_CATEGORY[productType] || null;
}

/** The sealed band for a product type, out of cfg.shipping.sealedBands. Null when nothing is pinned. */
export function sealedBandFor(productType, cfg) {
  const want = BAND_FOR_TYPE[productType];
  const list = ((cfg || {}).shipping || {}).sealedBands;
  if (!want || !Array.isArray(list)) return null;
  return list.find((b) => b && b.id === want && String(b.policyId || '').trim()) || null;
}

/** Units actually on the shelf for this pool, summed from placements rather than the cached mirror. */
export function poolUnits(db, poolSku) {
  const r = db.prepare(`SELECT COALESCE(SUM(sp.quantity), 0) AS n
                          FROM sealed_items si
                          JOIN sealed_placements sp ON sp.item_id = si.id
                         WHERE si.pool_sku = ? AND si.status IN ('in_stock','listed')`).get(poolSku);
  return Number(r && r.n) || 0;
}

/**
 * Pool row + live stock -> the `listing` shape publishListing expects.
 * Pure, so the whole payload can be asserted offline.
 */
export function toSealedListing(pool, { units, cfg, band } = {}) {
  const f = {
    name: pool.name, set_name: pool.set_name, set_code: pool.set_code,
    product_type: pool.product_type, language: pool.language, variant: pool.variant,
    pack_count: pool.pack_count, condition: pool.condition, factory_sealed: pool.factory_sealed,
  };
  f.pitch = buildSealedPitch(f);
  const resolvedBand = band || sealedBandFor(pool.product_type, cfg);
  return {
    sku: pool.pool_sku,
    title: pool.title_override || buildSealedTitle(f),
    descriptionHtml: pool.desc_override || buildSealedDescription(f, { band: resolvedBand }),
    price_cents: pool.price_cents,
    quantity: units,
    // Per PRODUCT TYPE, because sealed is two categories: boxes and packs are filed separately.
    // Not a guess any more, but still config-overridable: see SEALED_CATEGORY above.
    categoryId: sealedCategoryFor(pool.product_type, cfg),
    conditionId: SEALED_CONDITION_ID,
    aspects: sealedAspects(pool, cfg, sealedCategoryFor(pool.product_type, cfg)),
    postageBand: resolvedBand,
    store_categories: pool.store_categories ? safeJson(pool.store_categories) : null,
    graded: false,
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }


// Per-category aspect shape, read live off get_item_aspects_for_category on 2026-08-19.
//
// The distinction that matters: a FREE_TEXT aspect takes any string and silently earns no facet when
// it misses the enum, but a SELECTION_ONLY aspect REJECTS the listing. So a wrong FREE_TEXT value is
// an invisible loss and a wrong SELECTION_ONLY value is a failed publish, and the two need opposite
// treatment. 261044's Configuration is SELECTION_ONLY with exactly one member, "Box" — sending
// "Booster Box" there would have failed the very first publish.
//
// Anything we have NOT read off the live enum is omitted rather than guessed, which is why packs
// carry no Configuration yet: 183456's enum has not been dumped.
const CATEGORY_ASPECTS = {
  '261044': { configuration: 'Box', packsAspect: null },            // CCG Sealed Boxes
  '183456': { configuration: null, packsAspect: 'Number of Packs' }, // CCG Sealed Packs
};

/**
 * Item specifics. The owner's configured values win, so a category whose required aspects we have not
 * met can be corrected without a code change. Only non-empty values are emitted.
 */
export function sealedAspects(pool, cfg, categoryId) {
  const prof = CATEGORY_ASPECTS[String(categoryId || sealedCategoryFor(pool.product_type, cfg) || '')] || {};
  const sealedCfg = (cfg || {}).sealed || {};
  const out = {};
  const put = (k, v) => {
    if (v == null) return;
    const s = String(v).trim();
    if (s && k.length <= 40) out[k] = s.slice(0, 50);
  };
  // 'Game' is FREE_TEXT on the singles category and a near-miss silently earns no facet, so the value
  // is configurable rather than assumed to be right for whatever the sealed category turns out to be.
  put('Game', sealedCfg.gameAspect || 'Pokémon TCG');
  put('Language', ({ EN: 'English', JP: 'Japanese', CN: 'Chinese', TW: 'Chinese', KO: 'Korean' })[String(pool.language || 'EN').toUpperCase()]);
  put('Set', pool.set_name);
  // SELECTION_ONLY: send it only when the live enum is known to contain it, or eBay rejects.
  put('Configuration', prof.configuration);
  if (prof.packsAspect) put(prof.packsAspect, pool.pack_count);   // not an aspect on the BOXES category
  put('Manufacturer', 'The Pokémon Company');
  Object.entries(sealedCfg.aspects || {}).forEach(([k, v]) => put(k, v));   // owner override wins
  return out;
}

/**
 * Everything that must be true before an eBay call. Refusals are NAMED: a blocked publish should never
 * leave the operator guessing which of eight things is missing. Returns [] when publishable.
 */
export function validateSealedListing(listing, pool, cfg) {
  const errors = [];
  if (!listing.sku) errors.push('no pool SKU');
  if (!listing.categoryId) {
    errors.push(`no eBay category resolves for ${pool.product_type} — look one up with GET /api/sealed/listings/categories?q= and save it under sealed.categories`);
  }
  if (!listing.title) errors.push('no title');
  else if (listing.title.length > 80) errors.push(`title over 80 chars (${listing.title.length})`);
  if (!(listing.price_cents > 0)) errors.push('no price');
  else if (listing.price_cents < 100) errors.push('price under A$1.00 — eBay AU rejects it with 25016');
  if (!(listing.quantity > 0)) errors.push('no units in stock for this pool');
  if (V1_TYPES.indexOf(pool.product_type) < 0) errors.push(`${pool.product_type} is outside v1 (packs, bundles and boxes only)`);
  // The gate that keeps catalog art honest. v1 lists factory-sealed stock as New; the moment it is not
  // New, eBay's stock-photo rule applies and owner photos stop being optional.
  if (pool.condition !== 'sealed' || !pool.factory_sealed) {
    errors.push('not factory sealed — v1 lists New only, and an opened or damaged box wants a hand-made listing');
  }
  if (!listing.postageBand) {
    errors.push(`no eBay policy is pinned for the ${BAND_FOR_TYPE[pool.product_type] || 'sealed'} band — postage policies are made by hand in Seller Hub`);
  }
  const pol = (cfg || {}).policies || {};
  if (!pol.paymentPolicyId || !pol.returnPolicyId) errors.push('account is missing a payment or return policy');
  return errors;
}

/** Audit every attempt, successful or not, with the exact outbound payload. */
function audit(db, poolSku, action, status, extra = {}) {
  try {
    db.prepare(`INSERT INTO sealed_listing_pushes
      (pool_sku, action, status, offer_id, listing_id, price_cents, quantity, request, response, error)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      poolSku, action, status, extra.offerId || null, extra.listingId || null,
      extra.priceCents != null ? extra.priceCents : null, extra.quantity != null ? extra.quantity : null,
      extra.request ? JSON.stringify(extra.request) : null,
      extra.response ? JSON.stringify(extra.response) : null, extra.error || null);
  } catch { /* an audit failure must never take the publish down with it (GR7) */ }
}

/**
 * Publish (or revise) one pool. Idempotent on the SKU: eBay binds a custom label for life, so a second
 * call finds the existing offer and revises it rather than creating a competing listing.
 */
export async function publishSealedPool(env, db, cfg, { poolSku, dryRun = false, imageUrls } = {}) {
  const pool = db.prepare('SELECT * FROM sealed_pools WHERE pool_sku = ?').get(poolSku);
  if (!pool) return { ok: false, error: 'no such pool: ' + poolSku, code: 'no_pool' };

  const units = poolUnits(db, poolSku);
  const band = sealedBandFor(pool.product_type, cfg);
  const listing = toSealedListing(pool, { units, cfg, band });

  const errors = validateSealedListing(listing, pool, cfg);
  if (errors.length) {
    audit(db, poolSku, dryRun ? 'preview' : 'publish', 'skipped', { error: errors.join(' · '), quantity: units, priceCents: listing.price_cents });
    return { ok: false, error: errors.join(' · '), errors, code: 'not_publishable', listing };
  }
  if (dryRun) {
    audit(db, poolSku, 'preview', 'ok', { quantity: units, priceCents: listing.price_cents, request: listing });
    return { ok: true, dryRun: true, listing };
  }

  const out = await publishListing(env, {
    listing, cfg, imageUrls,
    existingOfferId: pool.ebay_offer_id || null,
    // No conditionDescriptors: those are required for the two CARD conditions, not for NEW.
  });

  if (!out.ok) {
    audit(db, poolSku, 'publish', 'error', { error: out.error, request: out.requestBody, response: out.rawResponse, quantity: units, priceCents: listing.price_cents });
    return { ok: false, error: out.error, steps: out.steps, listing };
  }

  db.prepare(`UPDATE sealed_pools SET ebay_listing_id = ?, ebay_offer_id = ?, channel_status = 'active',
                published_at = COALESCE(published_at, datetime('now')), updated_at = datetime('now')
              WHERE pool_sku = ?`).run(out.listingId || null, out.offerId || null, poolSku);
  // Mirror onto the stock rows so the sealed ledger and the post-sale reconciler can both see it.
  db.prepare(`UPDATE sealed_items SET ebay_listing_id = ?, channel_status = 'active', status = 'listed',
                updated_at = datetime('now')
              WHERE pool_sku = ? AND status = 'in_stock'`).run(out.listingId || null, poolSku);

  audit(db, poolSku, out.revised ? 'revise' : 'publish', 'ok', {
    offerId: out.offerId, listingId: out.listingId, quantity: units,
    priceCents: listing.price_cents, request: out.requestBody, response: { listingId: out.listingId, offerId: out.offerId },
  });
  return { ok: true, listingId: out.listingId, offerId: out.offerId, revised: !!out.revised, units, steps: out.steps };
}
