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
import { itemUrl } from '../ebay-links.mjs';
import { bandForListing } from '../shipping-bands.mjs';

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

// eBay caps the INVENTORY ITEM's product.description at 4000 characters, while the OFFER's
// listingDescription allows 500000 — and the offer's is what buyers actually see, the item's being
// only the fallback when the offer omits it. So the rich description rides on the offer and this
// trims a safe copy for the item. It cuts at a completed top-level element, never mid-tag: a
// half-open <div> renders worse than a short description. (Live failure 2026-07-26: a 4744-char
// description came back as "[25718] Invalid value for description".)
export const ITEM_DESCRIPTION_MAX = 4000;
export function fitDescription(html, max = ITEM_DESCRIPTION_MAX) {
  const s = String(html == null ? '' : html);
  if (s.length <= max) return s;
  const min = s.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
  if (min.length <= max) return min;
  const re = /<(\/?)div\b[^>]*>/gi;
  let depth = 0, cut = -1, m;
  while ((m = re.exec(min))) {
    depth += m[1] ? -1 : 1;
    const end = m.index + m[0].length;
    if (end > max) break;
    if (depth === 1) cut = end;                    // a completed block inside the root wrapper
  }
  // +6 for the '</div>' we re-add; if no clean boundary exists, a hard cut is the last resort.
  return (cut > 0 && cut + 6 <= max) ? min.slice(0, cut) + '</div>' : min.slice(0, max);
}

export function buildInventoryItemPayload(listing, { imageUrls, conditionDescriptors } = {}) {
  const imgs = (imageUrls && imageUrls.length) ? imageUrls : (listing.imageUrls || (listing.imageUrl ? [listing.imageUrl] : []));
  const product = {
    title: (listing.title || '').slice(0, 80),
    description: fitDescription(listing.descriptionHtml || ''),   // 4000 cap; the full copy is on the offer
    // Inventory API wants array values. A MULTI-cardinality aspect (Character, Features on 183454)
    // arrives already an array and must stay one — wrapping it would ship "Pikachu,Zekrom" as a single
    // literal value. Behaviour is unchanged for every scalar aspect.
    aspects: Object.fromEntries(Object.entries(listing.aspects || {})
      .map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).map(String)])),
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

// Resolve the eBay STORE category (the seller's storefront department — NOT the marketplace
// categoryId). Values are FULL PATHS ("/Trading Card Games/Pokemon Singles"); eBay accepts at most
// two. A path that is not exactly a live store category is returned as-is rather than repaired:
// silently fixing a typo turns it into a plausible-looking WRONG path.
export function resolveStoreCategoryNames(listing, cfg) {
  const s = (cfg && cfg.store) || {};
  // Precedence: the owner's per-item pick > the per-game default > the global default. An item with
  // no pick (bulk import, anything published outside the uploader) falls straight through to config —
  // this must never resolve to nothing just because a row predates the store_categories column.
  const perItem = (listing && listing.storeCategoryNames) || [];
  const picked = perItem.length
    ? perItem
    : ((s.categoryByGame || {})[(listing && listing.game) || ''] || s.defaultCategory || '');
  const names = (Array.isArray(picked) ? picked : [picked])
    .map((v) => String(v == null ? '' : v).trim())
    .filter((v) => v.startsWith('/') && v.length > 1);
  return [...new Set(names)].slice(0, 2);
}

// The postage band a listing sits on. Prefer the band toEbayListing already stamped, so the policy
// eBay charges under and the amount the description quotes are ONE decision rather than two
// derivations that can drift; fall back to re-deriving only for callers that build a payload directly.
export function offerBandFor(listing, cfg) {
  if (listing && listing.postageBand) return listing.postageBand;
  return bandForListing(listing && listing.price_cents, (cfg && cfg.shipping) || undefined, { slab: !!(listing && listing.graded) });
}

// NO bestOfferTerms. Best Offer is off store-wide and the shop answers a haggle with an invoice now
// (lib/deals.mjs), so this builder has no branch that can emit offer terms — the capability is absent
// rather than merely defaulted off, which is the difference between "we chose not to" and "somebody
// could turn it on and not notice". Re-adding it means listingPolicies.bestOfferTerms with
// autoAcceptPrice / autoDeclinePrice, and note eBay rejects an auto-accept BELOW the auto-decline at
// the PUBLISH step (25002) — after the inventory item and offer already exist.
export function buildOfferPayload(listing, cfg) {
  const pol = (cfg && cfg.policies) || {};
  const band = offerBandFor(listing, cfg);
  const body = {
    sku: listing.sku,
    marketplaceId: (cfg && cfg.marketplaceId) || 'EBAY_AU',
    format: 'FIXED_PRICE',
    availableQuantity: listing.quantity != null ? listing.quantity : 1,
    categoryId: listing.categoryId,
    listingDuration: (cfg && cfg.listingDuration) || 'GTC',
    // The description buyers see. 500000-char budget here versus 4000 on the inventory item, so the
    // full rich HTML lives on the offer. eBay requires it to be re-sent on every updateOffer for a
    // published listing, which is why the whole offer body is rebuilt each call rather than patched.
    listingDescription: listing.descriptionHtml || undefined,
    listingPolicies: {
      paymentPolicyId: pol.paymentPolicyId,
      returnPolicyId: pol.returnPolicyId,
      // The BAND's policy, not one global one. Postage is banded by price now, so this is what makes
      // the buyer's charge match the amount the description quotes.
      fulfillmentPolicyId: band ? band.policyId : undefined,
    },
    merchantLocationKey: (cfg && cfg.location && cfg.location.merchantLocationKey) || undefined,
    pricingSummary: { price: { value: centsToStr(listing.price_cents), currency: 'AUD' } },
  };
  // An offer published without this is auto-filed into the store's default "Other" category — which is
  // why the first API listing was the only one of 163 store items missing from Trading Card Games
  // (verified live 2026-07-26). eBay DROPS the field on any updateOffer that omits it, so it is
  // rebuilt on every call rather than being made conditional on "is this a create".
  const storeCats = resolveStoreCategoryNames(listing, cfg);
  if (storeCats.length) body.storeCategoryNames = storeCats;
  return body;
}

// ---- API calls ----
// One result shape for every call. httpStatus + requestId (eBay's rlogid) travel with the error because
// [25001] "Core Inventory Service internal error" is meaningless without them: 400 means our payload is
// wrong and deterministic, 500 means eBay's backend and already-retried, and the rlogid is what eBay
// Support traces. Learned the hard way on a live publish (2026-07-26) where all three were discarded.
function shape(r, extra = {}) {
  return {
    ok: r.ok,
    httpStatus: r.httpStatus,
    requestId: r.requestId || null,
    attempts: r.attempts || 1,
    error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus),
    raw: r.json,
    ...extra,
  };
}

export async function createOrReplaceInventoryItem(env, sku, body) {
  const r = await ebayRest(env, 'PUT', `${INV}/inventory_item/${encodeURIComponent(sku)}`, { body });
  return shape(r);
}
export async function getOffersForSku(env, sku, marketplaceId = 'EBAY_AU') {
  const r = await ebayRest(env, 'GET', `${INV}/offer?sku=${encodeURIComponent(sku)}`);
  const offers = (r.ok && r.json && Array.isArray(r.json.offers)) ? r.json.offers : [];
  return offers.filter((o) => !o.marketplaceId || o.marketplaceId === marketplaceId);
}
export async function createOffer(env, body) {
  const r = await ebayRest(env, 'POST', `${INV}/offer`, { body });
  return shape(r, { offerId: r.ok && r.json ? r.json.offerId : null });
}
export async function updateOffer(env, offerId, body) {
  const r = await ebayRest(env, 'PUT', `${INV}/offer/${encodeURIComponent(offerId)}`, { body });
  return shape(r);
}
export async function publishOffer(env, offerId) {
  const r = await ebayRest(env, 'POST', `${INV}/offer/${encodeURIComponent(offerId)}/publish`, { body: {} });
  return shape(r, { listingId: r.ok && r.json ? r.json.listingId : null });
}
// Drop an inventory item and, with it, any UNPUBLISHED offer hanging off it. Used to tidy up the
// provisional-SKU record a canary/preview leaves behind once the row has really listed under its
// shelf label — eBay keys inventory by SKU, so the preview's SKU is a different record entirely and
// would otherwise sit in the account forever. Never used on a published listing: eBay refuses to
// delete an inventory item with a live offer, which is the safety net we want here.
export async function deleteInventoryItem(env, sku) {
  const r = await ebayRest(env, 'DELETE', `${INV}/inventory_item/${encodeURIComponent(sku)}`);
  return shape(r);
}
export async function withdrawOffer(env, offerId) {
  const r = await ebayRest(env, 'POST', `${INV}/offer/${encodeURIComponent(offerId)}/withdraw`, { body: {} });
  return shape(r);
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
    storeCategoryNames: o.storeCategoryNames || null,   // read-back: proof of what eBay actually stored
    price_value: o.pricingSummary && o.pricingSummary.price ? o.pricingSummary.price.value : null,
    raw: o,
  };
}

// Dry-run fee check on an unpublished offer (the nearest thing to VerifyAddItem).
export async function getListingFees(env, offerId) {
  const r = await ebayRest(env, 'POST', `${INV}/offer/get_listing_fees`, { body: { offers: [{ offerId }] } });
  return { ok: r.ok, fees: r.ok && r.json ? r.json.feeSummaries : null, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus) };
}

// Kept as the name this module's callers already use; the URL itself comes from lib/ebay-links.mjs,
// which owns every eBay link in the suite.
export const listingUrl = (listingId, marketplaceId = 'EBAY_AU') => itemUrl(listingId, { marketplace: marketplaceId });

// publishListing — the full idempotent orchestrator. Returns
// { ok, offerId, listingId, url, revised, fees?, error, steps }.
// existingOfferId (from ebay_listings) short-circuits the getOffers lookup.
export async function publishListing(env, { listing, cfg, imageUrls, conditionDescriptors, existingOfferId, dryRun } = {}) {
  const steps = [];
  const marketplaceId = (cfg && cfg.marketplaceId) || 'EBAY_AU';

  // Refuse an unresolvable postage band BEFORE createOrReplaceInventoryItem, so a misconfigured band
  // never leaves a half-built inventory record behind (same reasoning as the conditionDescriptors
  // guard below). Publishing without one would inherit whatever policy eBay defaults to, which is how
  // a description quoting $1.70 ends up on a listing charging something else entirely.
  const band = offerBandFor(listing, cfg);
  if (!band || !String(band.policyId || '').trim()) {
    const why = band
      ? `the "${band.label || band.id}" postage band has no eBay policy assigned — pick one in Settings → eBay listing`
      : `no postage band matches A$${listing.price_cents != null ? (listing.price_cents / 100).toFixed(2) : '—'} — check the band table in Settings → eBay listing`;
    steps.push({ step: 'postage_band', ok: false, error: why });
    return { ok: false, error: 'postage: ' + why, steps };
  }

  const itemBody = buildInventoryItemPayload(listing, { imageUrls, conditionDescriptors });
  // eBay's trading-card conditions are 2750 (Graded) / 4000 (Ungraded), spelled LIKE_NEW /
  // USED_VERY_GOOD in ConditionEnum, and BOTH are only legal accompanied by conditionDescriptors.
  // buildInventoryItemPayload omits the container when the resolver returned nothing, so an
  // unresolvable descriptor would ship a condition eBay must reject. Refuse it here, named.
  if ((itemBody.condition === 'LIKE_NEW' || itemBody.condition === 'USED_VERY_GOOD') && !itemBody.conditionDescriptors) {
    steps.push({ step: 'inventory_item', ok: false, error: 'no condition descriptors resolved' });
    return { ok: false, error: 'inventory item: condition ' + itemBody.condition + ' requires conditionDescriptors and none resolved', requestBody: itemBody, steps };
  }
  const put = await createOrReplaceInventoryItem(env, listing.sku, itemBody);
  steps.push({ step: 'inventory_item', ok: put.ok, error: put.error, httpStatus: put.httpStatus, requestId: put.requestId, attempts: put.attempts, ebay: put.ok ? null : put.raw });
  if (!put.ok) return { ok: false, error: 'inventory item: ' + put.error, httpStatus: put.httpStatus, requestId: put.requestId, rawResponse: put.raw, requestBody: itemBody, steps };

  // find-or-create the offer (idempotent on SKU)
  let offerId = existingOfferId || null, revised = false;
  const offerBody = buildOfferPayload(listing, cfg);
  if (!offerId) {
    const existing = await getOffersForSku(env, listing.sku, marketplaceId);
    if (existing.length) offerId = existing[0].offerId;
  }
  if (offerId) {
    const up = await updateOffer(env, offerId, offerBody);
    steps.push({ step: 'update_offer', ok: up.ok, error: up.error, httpStatus: up.httpStatus, requestId: up.requestId, ebay: up.ok ? null : up.raw });
    if (!up.ok) return { ok: false, offerId, error: 'update offer: ' + up.error, httpStatus: up.httpStatus, requestId: up.requestId, rawResponse: up.raw, requestBody: offerBody, steps };
    revised = true;
  } else {
    const co = await createOffer(env, offerBody);
    steps.push({ step: 'create_offer', ok: co.ok, error: co.error, httpStatus: co.httpStatus, requestId: co.requestId, ebay: co.ok ? null : co.raw });
    if (!co.ok) return { ok: false, error: 'create offer: ' + co.error, httpStatus: co.httpStatus, requestId: co.requestId, rawResponse: co.raw, requestBody: offerBody, steps };
    offerId = co.offerId;
  }

  if (dryRun) {
    const fees = await getListingFees(env, offerId);
    steps.push({ step: 'get_listing_fees', ok: fees.ok, error: fees.error });
    // A preflight that answers "ok" when eBay just rejected the offer is worse than no preflight at
    // all: catching what publish would reject IS its whole job, and reporting ok anyway means the
    // audit row says ok, the runner shows a green preview, and the row is quietly never listed.
    // (Lived: AAC-096 previewed clean at 99c and sat unlisted, holding a shelf label.)
    if (!fees.ok) return { ok: false, offerId, revised, dryRun: true, error: 'preflight: ' + fees.error, offerBody, steps };
    return { ok: true, offerId, revised, dryRun: true, fees: fees.fees, offerBody, steps };
  }

  const pub = await publishOffer(env, offerId);
  steps.push({ step: 'publish', ok: pub.ok, error: pub.error, httpStatus: pub.httpStatus, requestId: pub.requestId, ebay: pub.ok ? null : pub.raw });
  if (!pub.ok) return { ok: false, offerId, revised, error: 'publish: ' + pub.error, httpStatus: pub.httpStatus, requestId: pub.requestId, rawResponse: pub.raw, steps };
  return { ok: true, offerId, listingId: pub.listingId, url: listingUrl(pub.listingId, marketplaceId), revised, offerBody, steps };
}
