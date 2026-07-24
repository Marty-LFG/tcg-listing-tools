// lib/channels/ebay-inventory-api.mjs — the Sell Inventory API listing sink. Serializes the ONE
// canonical listing object (lib/channels/ebay-map.mjs toEbayListing) into the SKU-centric three-call
// flow: createOrReplaceInventoryItem (PUT /inventory_item/{sku}) → createOffer (POST /offer) →
// publishOffer (POST /offer/{offerId}/publish). It must NOT re-derive titles/aspects/descriptions —
// those come from the canonical object (GR6/8/9). Idempotent: SKU is the key, so a re-publish revises
// the existing offer rather than duplicating (find-or-create via getOffers).
//
// All calls go through ebayRest (user token, throttled + retried). Nothing throws on an eBay error —
// results are returned as data so the caller records an audit row and degrades (GR7). Fixed-price =
// FIXED_PRICE + GTC; AU has no tax container (GST is baked into the price, GR3 cents at the edge).
import { ebayRest, firstErrorText } from '../ebay-rest.mjs';

const INV = '/sell/inventory/v1';
const centsToStr = (c) => (Math.round(+c) / 100).toFixed(2);     // the ONE cents→eBay-price edge (GR3)
const CONDITION_ENUM = { 2750: 'LIKE_NEW', 4000: 'USED_VERY_GOOD' };   // trading-card graded / ungraded

// Map resolved condition descriptors ({name, value:[ids], additionalInfo}) → the Inventory API shape.
function toApiDescriptors(resolved = []) {
  return resolved.map((d) => {
    const out = { name: String(d.name) };
    if (d.value && d.value.length) out.values = d.value.map(String);
    if (d.additionalInfo) out.additionalInfo = String(d.additionalInfo);
    return out;
  });
}

// ---- pure payload builders (exported for the unit suite) ----
export function buildInventoryItemPayload(listing, { imageUrls, conditionDescriptors } = {}) {
  const imgs = (imageUrls && imageUrls.length) ? imageUrls : (listing.imageUrls || (listing.imageUrl ? [listing.imageUrl] : []));
  const product = {
    title: (listing.title || '').slice(0, 80),
    description: listing.descriptionHtml || '',
    aspects: Object.fromEntries(Object.entries(listing.aspects || {}).map(([k, v]) => [k, [String(v)]])),  // Inventory API wants array values
    imageUrls: imgs,
  };
  const body = {
    availability: { shipToLocationAvailability: { quantity: listing.quantity != null ? listing.quantity : 1 } },
    condition: CONDITION_ENUM[listing.conditionId] || 'USED_VERY_GOOD',
    product,
  };
  const desc = toApiDescriptors(conditionDescriptors && conditionDescriptors.length ? conditionDescriptors : []);
  if (desc.length) body.conditionDescriptors = desc;
  return body;
}

export function buildOfferPayload(listing, cfg, { bestOffer } = {}) {
  const pol = (cfg && cfg.policies) || {};
  const body = {
    sku: listing.sku,
    marketplaceId: (cfg && cfg.marketplaceId) || 'EBAY_AU',
    format: 'FIXED_PRICE',
    availableQuantity: listing.quantity != null ? listing.quantity : 1,
    categoryId: listing.categoryId,
    listingDuration: (cfg && cfg.listingDuration) || 'GTC',
    listingPolicies: {
      paymentPolicyId: pol.paymentPolicyId,
      returnPolicyId: pol.returnPolicyId,
      fulfillmentPolicyId: pol.fulfillmentPolicyId,
    },
    merchantLocationKey: (cfg && cfg.location && cfg.location.merchantLocationKey) || undefined,
    pricingSummary: { price: { value: centsToStr(listing.price_cents), currency: 'AUD' } },
  };
  if (bestOffer && bestOffer.enabled) {
    body.listingPolicies.bestOfferTerms = { bestOfferEnabled: true };
    if (bestOffer.autoAcceptCents != null) body.listingPolicies.bestOfferTerms.autoAcceptPrice = { value: centsToStr(bestOffer.autoAcceptCents), currency: 'AUD' };
    if (bestOffer.autoDeclineCents != null) body.listingPolicies.bestOfferTerms.autoDeclinePrice = { value: centsToStr(bestOffer.autoDeclineCents), currency: 'AUD' };
  }
  return body;
}

// ---- API calls ----
export async function createOrReplaceInventoryItem(env, sku, body) {
  const r = await ebayRest(env, 'PUT', `${INV}/inventory_item/${encodeURIComponent(sku)}`, { body });
  return { ok: r.ok, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus), raw: r.json };
}
export async function getOffersForSku(env, sku, marketplaceId = 'EBAY_AU') {
  const r = await ebayRest(env, 'GET', `${INV}/offer?sku=${encodeURIComponent(sku)}`);
  const offers = (r.ok && r.json && Array.isArray(r.json.offers)) ? r.json.offers : [];
  return offers.filter((o) => !o.marketplaceId || o.marketplaceId === marketplaceId);
}
export async function createOffer(env, body) {
  const r = await ebayRest(env, 'POST', `${INV}/offer`, { body });
  return { ok: r.ok, offerId: r.ok && r.json ? r.json.offerId : null, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus), raw: r.json };
}
export async function updateOffer(env, offerId, body) {
  const r = await ebayRest(env, 'PUT', `${INV}/offer/${encodeURIComponent(offerId)}`, { body });
  return { ok: r.ok, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus), raw: r.json };
}
export async function publishOffer(env, offerId) {
  const r = await ebayRest(env, 'POST', `${INV}/offer/${encodeURIComponent(offerId)}/publish`, { body: {} });
  return { ok: r.ok, listingId: r.ok && r.json ? r.json.listingId : null, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus), raw: r.json };
}
export async function withdrawOffer(env, offerId) {
  const r = await ebayRest(env, 'POST', `${INV}/offer/${encodeURIComponent(offerId)}/withdraw`, { body: {} });
  return { ok: r.ok, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus), raw: r.json };
}
// Read one offer's live state (listing status + sold qty) for reconcile.
export async function getOffer(env, offerId) {
  const r = await ebayRest(env, 'GET', `${INV}/offer/${encodeURIComponent(offerId)}`);
  if (!r.ok) return { ok: false, error: firstErrorText(r.json) || 'HTTP ' + r.httpStatus };
  const o = r.json || {};
  const listing = o.listing || {};
  return {
    ok: true,
    listingStatus: listing.listingStatus || (o.status === 'UNPUBLISHED' ? 'UNPUBLISHED' : null),
    listingId: listing.listingId || null,
    soldQuantity: listing.soldQuantity != null ? listing.soldQuantity : null,
    availableQuantity: o.availableQuantity != null ? o.availableQuantity : null,
    price_value: o.pricingSummary && o.pricingSummary.price ? o.pricingSummary.price.value : null,
    raw: o,
  };
}

// Dry-run fee check on an unpublished offer (the nearest thing to VerifyAddItem).
export async function getListingFees(env, offerId) {
  const r = await ebayRest(env, 'POST', `${INV}/offer/get_listing_fees`, { body: { offers: [{ offerId }] } });
  return { ok: r.ok, fees: r.ok && r.json ? r.json.feeSummaries : null, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus) };
}

export function listingUrl(listingId, marketplaceId = 'EBAY_AU') {
  const host = marketplaceId === 'EBAY_AU' ? 'www.ebay.com.au' : 'www.ebay.com';
  return listingId ? `https://${host}/itm/${listingId}` : null;
}

// publishListing — the full idempotent orchestrator. Returns
// { ok, offerId, listingId, url, revised, fees?, error, steps }.
// existingOfferId (from ebay_listings) short-circuits the getOffers lookup.
export async function publishListing(env, { listing, cfg, imageUrls, conditionDescriptors, bestOffer, existingOfferId, dryRun } = {}) {
  const steps = [];
  const marketplaceId = (cfg && cfg.marketplaceId) || 'EBAY_AU';

  const itemBody = buildInventoryItemPayload(listing, { imageUrls, conditionDescriptors });
  const put = await createOrReplaceInventoryItem(env, listing.sku, itemBody);
  steps.push({ step: 'inventory_item', ok: put.ok, error: put.error });
  if (!put.ok) return { ok: false, error: 'inventory item: ' + put.error, steps };

  // find-or-create the offer (idempotent on SKU)
  let offerId = existingOfferId || null, revised = false;
  const offerBody = buildOfferPayload(listing, cfg, { bestOffer });
  if (!offerId) {
    const existing = await getOffersForSku(env, listing.sku, marketplaceId);
    if (existing.length) offerId = existing[0].offerId;
  }
  if (offerId) {
    const up = await updateOffer(env, offerId, offerBody);
    steps.push({ step: 'update_offer', ok: up.ok, error: up.error });
    if (!up.ok) return { ok: false, offerId, error: 'update offer: ' + up.error, steps };
    revised = true;
  } else {
    const co = await createOffer(env, offerBody);
    steps.push({ step: 'create_offer', ok: co.ok, error: co.error });
    if (!co.ok) return { ok: false, error: 'create offer: ' + co.error, steps };
    offerId = co.offerId;
  }

  if (dryRun) {
    const fees = await getListingFees(env, offerId);
    steps.push({ step: 'get_listing_fees', ok: fees.ok, error: fees.error });
    return { ok: true, offerId, revised, dryRun: true, fees: fees.fees, steps };
  }

  const pub = await publishOffer(env, offerId);
  steps.push({ step: 'publish', ok: pub.ok, error: pub.error });
  if (!pub.ok) return { ok: false, offerId, revised, error: 'publish: ' + pub.error, steps };
  return { ok: true, offerId, listingId: pub.listingId, url: listingUrl(pub.listingId, marketplaceId), revised, steps };
}
