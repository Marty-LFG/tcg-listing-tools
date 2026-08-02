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
// True for everything that is NOT the default free letter — i.e. everything that needs the packer to
// do something different. This is the flag that decides whether a row gets ink on a printed sheet.
export function isUpgrade(tier) { return tierRank(tier) > 0; }

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

  const label = (override && override.label)
    || (fromCatalog && fromCatalog.label)
    || prettifyServiceCode(code);
  const labelSource = (override && override.label) ? 'config' : (fromCatalog && fromCatalog.label) ? 'ebay' : 'derived';

  const out = (tier, note) => ({
    tier,
    // A config override may declare tracked explicitly (an untracked express service exists in theory);
    // otherwise the two upgrade tiers that imply a tracking number are the tracked ones.
    tracked: override && typeof override.tracked === 'boolean' ? override.tracked : (tier === 'express' || tier === 'tracked'),
    code,
    label: label || tierPhrase(tier),
    labelSource: label ? labelSource : 'derived',
    paidCents,
    note: (override && override.note) || note || null,
  });

  if (buyerSelected === false) return out('standard', 'eBay chose this service, the buyer did not');
  if (override && POSTAGE_TIERS.includes(override.tier)) return out(override.tier);
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
