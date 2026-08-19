// lib/postage.mjs — the one place the app decides what a buyer paid for, and the only postage
// vocabulary used anywhere: dashboard, pick sheet, packing slip, buyer messages.
//
// Why this exists: parseOrders has always captured ShippingServiceSelected/ShippingService and its
// cost into orders.ship_service / orders.shipping_cents, and nothing ever read them back. So whoever
// packs an order could not tell a free-letter sale from one where the buyer paid for Express, which is
// the kind of thing you find out once the card is already in a plain envelope.
//
// Everything above `--- catalog ---` is pure and side-effect free, so the whole rule set is table
// testable without a network or a filesystem.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tradingCall, xmlField, xmlFieldAll, xmlText, xmlBool } from './ebay-trading.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'ebay-shipping-services.json');
const CATALOG_MAX_AGE_MS = 7 * 24 * 3600_000;   // weekly is plenty; eBay's service list barely moves

// Weakest → strongest. A combined packing slip shows the strongest tier across its orders, so this
// order is load-bearing, not cosmetic.
export const POSTAGE_TIERS = ['standard', 'paid', 'tracked', 'express'];
export function tierRank(tier) {
  const i = POSTAGE_TIERS.indexOf(String(tier || 'standard'));
  return i < 0 ? 0 : i;
}
export function strongestTier(tiers) {
  return (tiers || []).reduce((best, t) => (tierRank(t) > tierRank(best) ? t : best), 'standard');
}
// True for everything that needs the packer to DO SOMETHING DIFFERENT — which is now tracked or
// better, not merely "the buyer paid something".
//
// This moved when the store went to banded postage. It used to mean "not the default FREE letter", and
// that was the same question while every card order shipped free. It is not any more: the normal band
// is a $1.70 letter, so `paid` describes the majority of orders and flagging them would put ink on
// every row of every sheet and a bordered block on every packing slip — inverting the whole design,
// where a box on a sheet is worth stopping for. A `paid` order still goes in a plain envelope; only a
// tracked one sends the packer to eBay to buy a label.
export function isUpgrade(tier) { return tierRank(tier) >= tierRank('tracked'); }

// Plain-English phrase per tier, used wherever we have no trustworthy service name from eBay. Reads
// fine to a buyer on a packing slip, which a raw code like "AU_Regular" does not.
const TIER_PHRASE = {
  express: 'Express Post',
  tracked: 'Tracked parcel',
  paid: 'Paid postage',
  standard: 'Standard delivery',
};
export function tierPhrase(tier) { return TIER_PHRASE[tier] || TIER_PHRASE.standard; }

export const DEFAULT_POSTAGE_CONFIG = {
  dispatch_message: { enabled: true, include_link: false, delay_min: 20 },
  delivered_message: { enabled: true, force_approve: true },
  // eBay does not document its Seller Hub deep links, so this is a template you can correct without a
  // code change. {orderId} is substituted. If it ever stops resolving, the dashboard falls back to the
  // awaiting-postage list, which always works.
  seller_hub_order_url: 'https://www.ebay.com.au/sh/ord/details?orderid={orderId}',
  seller_hub_fallback_url: 'https://www.ebay.com.au/sh/ord?filter=status:AWAITING_SHIPMENT',
  tracking_url: 'https://auspost.com.au/mypost/track/details/{tracking}',
  // Observed service code → { label, tier, tracked, note }. Auto-seeded with every code the poll
  // actually sees, so overriding one is editing a value that is already sitting in settings.
  services: {},
};

// eBay's own "this is a fast service" flag is the best express signal there is; these only run when it
// is absent. Kept deliberately loose because the codes are per-marketplace and per-seller-offering.
const RE_EXPRESS = /express|overnight|next[\s_-]?day|priorit/i;
const RE_TRACKED = /track|parcel|courier|registered|platinum|signature|satchel/i;
const RE_PICKUP = /pickup|pick[\s_-]?up|collect|click.?and.?collect|in[\s_-]?store/i;
// eBay returns this literal when the buyer typed a postage amount instead of choosing a service.
const RE_NOT_SELECTED = /^\s*(not\s*selected|notselected|none)\s*$/i;

// Read a field from either shape without the caller having to care: the camelCase object that
// parseOrders returns, or the snake_case row that comes back out of SQLite. Every call site handles
// both at some point, and one adapter here is cheaper than a shape bug at each of them.
function pick(o, ...keys) {
  for (const k of keys) {
    const v = o == null ? undefined : o[k];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

// "AU_RegularParcelWithTracking" → "Regular Parcel With Tracking". Last resort only: a real name from
// eBay's own catalog or from config always wins.
export function prettifyServiceCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^[A-Z]{2}_/, '')                       // drop the marketplace prefix
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')           // camelCase → words
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Buyer-facing service NAMES (the one canonical map)
// ---------------------------------------------------------------------------
// A live eBay listing rendered "AUP 500 G SATCHEL SIG" in its postage table, because the only thing
// standing between an eBay service CODE and the buyer was prettifyServiceCode(). This map is the fix:
// the name a buyer reads is looked up, never derived.
//
// Only codes the account's own fulfilment policies actually offer are listed. An unknown code gets NO
// invented name (GR4) - it falls through to eBay's catalog and then to prettify, and the operator sees
// something obviously machine-shaped rather than a confident wrong product name.
//
// Wording rules learned the hard way:
//  - NEVER print a weight tier for AUP_500G_SATCHEL_SIG. Australia Post retired the "500g satchel"
//    name; prepaid Parcel Post satchels are now Extra small..Extra large and all carry 5kg. eBay's own
//    catalog already calls the sibling code "Australia Post Flat Rate Box/Satchel (Small)". A label
//    naming a product Australia Post no longer sells is worse than a code.
//  - The label is part of the SERVICE CLAIM the description makes (GR6). "Tracked" in a name the buyer
//    reads has to be true of what actually gets posted, or every listing in the band is an INAD risk.
//  - No delivery-day estimates. Australia Post and eBay quote different ranges for the same service.
// What we KNOW about each service the account's own policies offer: what to call it, and what it
// actually is. The tier matters as much as the label, because two of these codes lie about
// themselves and the classifier reads codes:
//   AU_Regular                            matches none of the tracked patterns, so an $8.26 TRACKED
//                                         order read as a plain paid letter and the packer was never
//                                         told to buy a label - while the listing description
//                                         promised "sent tracked with Australia Post".
//   AU_AusPostPriorityLetterWithTracking  matches /priorit/, so it read as EXPRESS. It is a Priority
//                                         letter with tracking, not Express Post.
// data/postsale.config.example.json has carried exactly these facts since 2026-08-14, but a config
// written before that block existed has `services: {}` and inherits neither. Shipping them in code
// means the classification is right whether or not anyone remembers to seed the config, and an
// owner's config entry still wins field by field.
export const KNOWN_SERVICES = Object.freeze({
  AU_AusPostStandardLetter: { label: 'Regular letter', tier: 'standard', tracked: false },
  AU_AusPostPriorityLetterWithTracking: { label: 'Priority letter, tracked', tier: 'tracked', tracked: true },
  AU_Regular: { label: 'Tracked letter', tier: 'tracked', tracked: true },
  AUP_500G_SATCHEL_SIG: { label: 'Tracked satchel, signature on delivery', tier: 'tracked', tracked: true },
});

// The name half, kept as its own export because the listing side only ever wants the string.
export const SERVICE_LABELS = Object.freeze(Object.fromEntries(
  Object.entries(KNOWN_SERVICES).map(([code, s]) => [code, s.label])));

// Is a stored label one a MACHINE wrote, rather than one the owner chose? This is not a guess: it is
// provable by re-running the same derivation. All four labels sitting in the live config match their
// own prettify output exactly - prettifyServiceCode('AUP_500G_SATCHEL_SIG') === 'AUP 500 G SATCHEL SIG'
// (the three-letter AUP_ prefix survives the two-letter strip, underscores become spaces, and the
// camelCase rule splits '500G' into '500 G'), and prettifyServiceCode('AU_Regular') === 'Regular'.
// A blank label counts too, because postageOptions falls back to the RAW code when it is empty.
export function isDerivedServiceLabel(code, label) {
  const s = String(label == null ? '' : label).replace(/\s+/g, ' ').trim();
  if (!s) return true;
  const c = String(code == null ? '' : code).trim();
  const norm = (x) => x.replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(s) === norm(prettifyServiceCode(c)) || norm(s) === norm(c);
}

// The ladder: the owner's own wording wins, then the curated map, then eBay's catalog, then prettify.
//
// Curated sits ABOVE eBay's catalog deliberately. eBay describes AU_Regular as the single word
// "Regular", which contradicts the "sent tracked with Australia Post" sentence its own band prints -
// exactly the service-claim drift GR6 exists to stop. The catalog is still consulted, because it is
// the only source that covers codes we have never seen.
//
// `savedSource === 'owner'` is preserved unconditionally, so once someone really does rename a service
// no bootstrap, no config read and no future heal can undo it. Legacy entries carry no source, so they
// fall to isDerivedServiceLabel, which repairs the poisoned ones and leaves hand-written ones alone.
export function resolveServiceLabel(code, saved, savedSource, catalog = SERVICE_CATALOG) {
  const c = String(code == null ? '' : code).trim();
  const s = String(saved == null ? '' : saved).trim();
  if (savedSource === 'owner' && s) return { label: s, labelSource: 'owner' };
  if (s && !isDerivedServiceLabel(c, s)) return { label: s, labelSource: savedSource || 'owner' };
  if (SERVICE_LABELS[c]) return { label: SERVICE_LABELS[c], labelSource: 'curated' };
  const fromCatalog = c && catalog ? catalog.get(c) : null;
  if (fromCatalog && fromCatalog.label) return { label: fromCatalog.label, labelSource: 'ebay' };
  return { label: prettifyServiceCode(c), labelSource: 'derived' };
}

// Resolve every service label in a band table. Applied on the READ path as well as at capture, which
// is what makes the fix land without a bootstrap re-run: the config on disk keeps whatever it holds,
// and the buyer still reads a proper name. Pure - returns a new array, mutates nothing.
export function curateBandServices(bands) {
  if (!Array.isArray(bands)) return bands;
  return bands.map((b) => {
    if (!b || !Array.isArray(b.services) || !b.services.length) return b;
    return {
      ...b,
      services: b.services.map((s) => {
        if (!s || typeof s !== 'object') return s;
        const r = resolveServiceLabel(s.code, s.label, s.labelSource);
        return { ...s, label: r.label, labelSource: r.labelSource };
      }),
    };
  });
}

/**
 * classifyPostage(order, cfg, catalog) → { tier, tracked, code, label, labelSource, paidCents, note }
 *
 * Rules, in order. The first that matches wins:
 *   1. an explicit override in cfg.services[code]
 *   2. eBay's ExpeditedService flag            → express
 *   3. the service code looks like express     → express
 *   4. the service code looks tracked          → tracked
 *   5. the buyer paid anything at all          → paid
 *   6. otherwise                               → standard
 *
 * With one hard guard in front of all of it: when eBay says BuyerSelectedShipping is FALSE, it picked
 * the service itself and its docs are explicit that an application must ignore both the service and
 * the cost. So we never promote above `standard` on data the buyer did not choose. Note that ABSENT
 * (null) is not false: most responses simply don't carry the flag, and treating that as "eBay chose"
 * would silently flatten every real Express order.
 */
export function classifyPostage(order = {}, cfg = {}, catalog = SERVICE_CATALOG) {
  const codeRaw = pick(order, 'shipService', 'ship_service', 'service', 'code');
  const code = codeRaw && !RE_NOT_SELECTED.test(String(codeRaw)) ? String(codeRaw).trim() : null;
  const paidCents = Number(pick(order, 'shippingCents', 'shipping_cents') ?? 0) || 0;
  const expedited = pick(order, 'expedited', 'expedited_service');
  const buyerSelected = pick(order, 'buyerSelectedShipping', 'buyer_selected_shipping');

  const services = (cfg && cfg.services) || {};
  const override = code ? services[code] : null;
  const fromCatalog = code && catalog ? catalog.get(code) : null;
  // The owner's config entry wins FIELD BY FIELD over what we ship in code, so a partial override
  // (just a label, say) keeps the curated tier rather than silently dropping back to the regexes.
  const facts = { ...(code ? KNOWN_SERVICES[String(code).trim()] : null), ...(override || {}) };

  // Same ladder the listing side runs (resolveServiceLabel), so the name in the dispatch message the
  // buyer receives matches the name in the listing they bought from. SERVICE_LABELS sits above the
  // catalog for the AU_Regular reason spelled out at the map: eBay calls it "Regular", which reads as
  // untracked on a band that promises tracking.
  const label = (override && override.label)
    || facts.label
    || (fromCatalog && fromCatalog.label)
    || prettifyServiceCode(code);
  const labelSource = (override && override.label) ? 'config'
    : facts.label ? 'curated'
      : (fromCatalog && fromCatalog.label) ? 'ebay' : 'derived';

  const out = (tier, note) => ({
    tier,
    // A config override may declare tracked explicitly (an untracked express service exists in theory);
    // otherwise the two upgrade tiers that imply a tracking number are the tracked ones.
    tracked: typeof facts.tracked === 'boolean' ? facts.tracked : (tier === 'express' || tier === 'tracked'),
    code,
    label: label || tierPhrase(tier),
    labelSource: label ? labelSource : 'derived',
    paidCents,
    note: facts.note || note || null,
  });

  if (buyerSelected === false) return out('standard', 'eBay chose this service, the buyer did not');
  if (POSTAGE_TIERS.includes(facts.tier)) return out(facts.tier);
  if (code && RE_PICKUP.test(code)) return out('standard', 'collection in person');
  if (expedited === true) return out('express');
  if (code && RE_EXPRESS.test(code)) return out('express');
  if (code && (RE_TRACKED.test(code) || (fromCatalog && fromCatalog.tracked === true))) return out('tracked');
  if (paidCents > 0) return out('paid');
  return out('standard');
}

/**
 * deliveryWindow(order) → { min, max, source }
 *
 * eBay returns Estimated* before dispatch and starts returning Scheduled* only once the order is
 * marked shipped with tracking, at which point the scheduled dates are the accurate ones. Prefer
 * whichever we have, strongest first, and say which it was so the wording can differ ("estimated
 * arrival" vs "arriving").
 */
export function deliveryWindow(order = {}) {
  const sMin = pick(order, 'scheduledMin', 'scheduled_min');
  const sMax = pick(order, 'scheduledMax', 'scheduled_max');
  if (sMin || sMax) return { min: sMin || sMax, max: sMax || sMin, source: 'scheduled' };
  const eMin = pick(order, 'etaMin', 'eta_min');
  const eMax = pick(order, 'etaMax', 'eta_max');
  if (eMin || eMax) return { min: eMin || eMax, max: eMax || eMin, source: 'estimated' };
  return { min: null, max: null, source: null };
}

// {placeholder} substitution for the two configured URL templates. Returns null rather than a
// half-built URL when the input is missing, so a caller can just test the result.
function fillTemplate(template, vars) {
  const t = String(template || '').trim();
  if (!t) return null;
  let missing = false;
  const url = t.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    if (v == null || v === '') { missing = true; return ''; }
    return encodeURIComponent(String(v));
  });
  return missing ? null : url;
}
export function trackingUrl(cfg = {}, tracking) {
  return fillTemplate(cfg.tracking_url ?? DEFAULT_POSTAGE_CONFIG.tracking_url, { tracking });
}
export function sellerHubUrl(cfg = {}, orderId) {
  return fillTemplate(cfg.seller_hub_order_url ?? DEFAULT_POSTAGE_CONFIG.seller_hub_order_url, { orderId })
    || (cfg.seller_hub_fallback_url ?? DEFAULT_POSTAGE_CONFIG.seller_hub_fallback_url) || null;
}

/* --- catalog: eBay's own names for the shipping services on this marketplace ------------------- */
// GeteBayDetails(DetailName=ShippingServiceDetails) on SiteID 15 returns every AU service with its
// buyer-facing Description, so the packing slip can say "Express Post" instead of "AU_ExpressPost"
// without anyone hand-maintaining a lookup table that silently rots. Runs on the Trading API's IAF
// token: no OAuth scope, no re-consent. Cached to disk for a week; every read path degrades to
// prettifyServiceCode when the file isn't there, which is the case on a box with no eBay token.

export const SERVICE_CATALOG = new Map();

export function parseShippingServiceDetails(xml) {
  return xmlFieldAll(xml || '', 'ShippingServiceDetails').map((b) => {
    const code = xmlField(b, 'ShippingService');
    if (!code) return null;
    const category = xmlText(b, 'ShippingCategory');
    return {
      code,
      label: xmlText(b, 'Description') || prettifyServiceCode(code),
      category: category || null,
      expedited: xmlBool(b, 'ExpeditedService') === true || /EXPEDITED|ONE_DAY/i.test(category || ''),
      international: xmlBool(b, 'InternationalService') === true,
      valid: xmlBool(b, 'ValidForSellingFlow') !== false,
    };
  }).filter(Boolean);
}

export function setServiceCatalog(entries) {
  SERVICE_CATALOG.clear();
  for (const e of entries || []) if (e && e.code) SERVICE_CATALOG.set(e.code, e);
  return SERVICE_CATALOG;
}

export function loadServiceCatalog(file = CATALOG_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    setServiceCatalog(j.services);
    return { ok: true, count: SERVICE_CATALOG.size, fetched_at: j.fetched_at || null };
  } catch { return { ok: false, count: 0, fetched_at: null }; }
}

// Refresh from eBay unless the cache is still fresh. Never throws: a missing catalog costs us nothing
// worse than a prettified service code on a packing slip.
export async function refreshServiceCatalog(env, { force = false, file = CATALOG_PATH } = {}) {
  try {
    if (!force) {
      const st = fs.existsSync(file) ? fs.statSync(file) : null;
      if (st && (Date.now() - st.mtimeMs) < CATALOG_MAX_AGE_MS) {
        if (!SERVICE_CATALOG.size) loadServiceCatalog(file);
        return { ok: true, skipped: 'fresh', count: SERVICE_CATALOG.size };
      }
    }
    const res = await tradingCall(env, 'GeteBayDetails', '<DetailName>ShippingServiceDetails</DetailName>');
    if (!res.ok) return { ok: false, error: 'GeteBayDetails failed', ack: res.ack, errors: res.errors };
    const services = parseShippingServiceDetails(res.xml);
    if (!services.length) return { ok: false, error: 'no ShippingServiceDetails in response' };
    setServiceCatalog(services);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetched_at: new Date().toISOString(), services }, null, 2) + '\n');
    return { ok: true, count: services.length };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}
