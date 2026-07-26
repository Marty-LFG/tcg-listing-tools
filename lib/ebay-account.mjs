// lib/ebay-account.mjs — eBay Account API v1 client + the one-time listing bootstrap.
//
// Publishing an offer through the Sell Inventory API has hard prerequisites that are stable per
// account and must exist BEFORE the first listing (verified live 2026-07-24):
//   1. opt in to business policies  (Account API: optInToProgram SELLING_POLICY_MANAGEMENT; up to 24h)
//   2. a payment + return + fulfilment policy on EBAY_AU  (Account API create*Policy)
//   3. a merchant inventory location  (Inventory API createInventoryLocation)
// publishOffer needs all four IDs. This module discovers-or-creates them and reports status; the
// caller (lib/listings.mjs) caches the resulting IDs into data/ebay-listing.config.json.
//
// All calls go through ebayRest() (user token, JSON). Nothing throws on an eBay error — results are
// surfaced as data so the settings UI can show exactly what's missing (Golden Rule 7).
import { ebayRest, firstErrorText, restErrors } from './ebay-rest.mjs';

const ACCT = '/sell/account/v1';
const INV = '/sell/inventory/v1';
const ALL_CATS = [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }];

// ---- reads -------------------------------------------------------------------
export async function getPrivileges(env) {
  const r = await ebayRest(env, 'GET', ACCT + '/privilege');
  return r.ok ? r.json : { _error: firstErrorText(r.json) || ('HTTP ' + r.httpStatus) };
}
export async function getOptedInPrograms(env) {
  const r = await ebayRest(env, 'GET', ACCT + '/program/get_opted_in_programs');
  const programs = (r.ok && r.json && Array.isArray(r.json.programs)) ? r.json.programs.map((p) => p.programType) : [];
  return { ok: r.ok, programs, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus) };
}
export async function getSubscription(env) {
  const r = await ebayRest(env, 'GET', ACCT + '/subscription');
  // subscriptions[].subscriptionLevel: Starter | Basic | Featured | Anchor (Pro tiers)
  const subs = (r.ok && r.json && Array.isArray(r.json.subscriptions)) ? r.json.subscriptions : [];
  return { ok: r.ok, subscriptions: subs, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus) };
}

export async function listPolicies(env, kind, marketplaceId) {
  // kind: 'fulfillment_policy' | 'payment_policy' | 'return_policy'
  const r = await ebayRest(env, 'GET', `${ACCT}/${kind}?marketplace_id=${encodeURIComponent(marketplaceId)}`);
  const listKey = { fulfillment_policy: 'fulfillmentPolicies', payment_policy: 'paymentPolicies', return_policy: 'returnPolicies' }[kind];
  const idKey = { fulfillment_policy: 'fulfillmentPolicyId', payment_policy: 'paymentPolicyId', return_policy: 'returnPolicyId' }[kind];
  const rows = (r.ok && r.json && Array.isArray(r.json[listKey])) ? r.json[listKey] : [];
  return { ok: r.ok, rows, idKey, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus) };
}

// ---- opt-in ------------------------------------------------------------------
export async function optInToProgram(env, programType = 'SELLING_POLICY_MANAGEMENT') {
  const r = await ebayRest(env, 'POST', ACCT + '/program/opt_in', { body: { programType } });
  // 200 on success; a 409/"already opted in" is also fine.
  const already = !r.ok && /already/i.test(firstErrorText(r.json) || '');
  return { ok: r.ok || already, error: (r.ok || already) ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus) };
}

// ---- policy bodies (AU managed-payments shapes) — exported for the unit suite ----
export function paymentBody(cfg) {
  // Managed payments: NO paymentMethods, immediatePay must be true (Inventory API listings are
  // immediate-payment). name + marketplace + categoryTypes only.
  return { name: cfg.policyNames.payment, marketplaceId: cfg.marketplaceId, categoryTypes: ALL_CATS, immediatePay: true };
}
export function returnBody(cfg) {
  const r = cfg.returns || {};
  if (r.accepted === false) return { name: cfg.policyNames.return, marketplaceId: cfg.marketplaceId, categoryTypes: ALL_CATS, returnsAccepted: false };
  return {
    name: cfg.policyNames.return, marketplaceId: cfg.marketplaceId, categoryTypes: ALL_CATS,
    returnsAccepted: true,
    returnPeriod: { value: r.days === 60 ? 60 : 30, unit: 'DAY' },   // AU allows only 30 or 60
    returnShippingCostPayer: r.shippingCostPayer === 'SELLER' ? 'SELLER' : 'BUYER',
    refundMethod: 'MONEY_BACK',
  };
}
export function fulfillmentBody(cfg) {
  const s = cfg.shipping || {};
  const svc = {
    sortOrder: 1,
    shippingServiceCode: s.serviceCode || 'AU_StandardDelivery',
    freeShipping: s.freeDomestic !== false,          // free AU post model
    buyerResponsibleForShipping: false,
  };
  if (s.freeDomestic === false) svc.shippingCost = { value: String(s.domesticCost || '0.00'), currency: 'AUD' };
  return {
    name: cfg.policyNames.fulfillment, marketplaceId: cfg.marketplaceId, categoryTypes: ALL_CATS,
    handlingTime: { value: Math.min(3, Math.max(0, cfg.handlingDays ?? 1)), unit: 'DAY' },  // ≤3 (AG-safe)
    shippingOptions: [{ optionType: 'DOMESTIC', costType: 'FLAT_RATE', shippingServices: [svc] }],
    // regionName takes eBay's ShippingLocation codes, not country NAMES — 'Australia' is rejected
    // with [20400] Invalid Location(s) (live 2026-07-26). The ISO country code is the valid form.
    shipToLocations: { regionIncluded: [{ regionName: (cfg.location && cfg.location.country) || 'AU' }] },
  };
}

// eBay's [20400] "Duplicate policy" error carries the id of the policy already holding those settings
// in a parameter, so this fires even when OUR name is unused — the id is the only way back to it.
// Sellers report the parameter as both duplicatePolicyId and DuplicateProfileId depending on the
// endpoint, so match either; restErrors has already flattened parameters to "name=value".
function duplicatePolicyId(json) {
  for (const e of restErrors(json)) {
    for (const p of e.parameters) {
      const m = /^duplicate(?:policy|profile)id\s*=\s*(.+)$/i.exec(String(p));
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return null;
}

// A one-line, human summary of what a policy actually DOES. The picker shows terms, not names:
// "TCG 30-day returns AU" told us nothing, which is how a no-returns store shipped 30-day returns.
export function describePolicy(kind, row) {
  if (!row) return '';
  if (kind === 'payment_policy') return row.immediatePay ? 'immediate payment' : 'payment on checkout';
  if (kind === 'return_policy') {
    if (!row.returnsAccepted) return 'no returns accepted';
    const d = row.returnPeriod && row.returnPeriod.value != null ? `${row.returnPeriod.value}-day returns` : 'returns accepted';
    return `${d} · ${row.returnShippingCostPayer === 'SELLER' ? 'seller' : 'buyer'} pays return post`;
  }
  const dom = (row.shippingOptions || []).find((o) => o.optionType === 'DOMESTIC') || (row.shippingOptions || [])[0] || {};
  const svcs = dom.shippingServices || [];
  const first = svcs[0] || {};
  const cost = first.freeShipping ? 'free'
    : (first.shippingCost && first.shippingCost.value != null ? 'A$' + first.shippingCost.value : 'paid');
  const more = svcs.length > 1 ? ` (+${svcs.length - 1} more)` : '';
  const hand = row.handlingTime && row.handlingTime.value != null ? ` · dispatch ${row.handlingTime.value}d` : '';
  return `${cost} · ${first.shippingServiceCode || 'service unspecified'}${more}${hand}`;
}

async function createPolicy(env, kind, body) {
  const r = await ebayRest(env, 'POST', `${ACCT}/${kind}`, { body });
  const idKey = { fulfillment_policy: 'fulfillmentPolicyId', payment_policy: 'paymentPolicyId', return_policy: 'returnPolicyId' }[kind];
  const id = r.ok && r.json ? r.json[idKey] : null;
  // A "name already used" collision means it exists — the caller adopts duplicateId, else re-lists.
  return {
    ok: r.ok, id,
    duplicateId: r.ok ? null : duplicatePolicyId(r.json),
    duplicate: !r.ok && /(already|duplicate|25506|20400)/i.test(firstErrorText(r.json) || ''),
    error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus),
  };
}

// Find the policy by the configured name, else create it. Returns { id, created, adopted, error }.
// adopted = we reused an existing eBay policy that isn't named the way the config asks, so its terms
// are whatever the account already had — the caller warns about it.
async function ensurePolicy(env, kind, cfg, buildBody) {
  const pinKey = { fulfillment_policy: 'fulfillmentPolicyId', payment_policy: 'paymentPolicyId', return_policy: 'returnPolicyId' }[kind];
  const pinned = String(((cfg && cfg.policies) || {})[pinKey] || '').trim();
  if (pinned) {
    // The owner picked one of the account's OWN policies for this kind. Never shadow it with a new
    // one: creating a parallel policy on an account that already has hand-made ones is exactly how
    // 30-day returns and parcel post ended up on a no-returns, letter-post store.
    const have = await listPolicies(env, kind, cfg.marketplaceId);
    if (!have.ok) return { id: pinned, created: false, adopted: false, pinned: true, unverified: have.error, error: null };
    const row = have.rows.find((p) => String(p[have.idKey]) === pinned);
    if (row) return { id: pinned, created: false, adopted: false, pinned: true, pinnedName: row.name || null, error: null };
    // Deleted on eBay since it was picked. Refuse to quietly create a replacement with different terms.
    return { id: null, created: false, adopted: false, pinned: true, missing: true,
      error: `the chosen ${kind.replace('_policy', '')} policy ${pinned} is no longer on this eBay account — re-pick it in Settings → eBay listing` };
  }
  const name = cfg.policyNames[{ fulfillment_policy: 'fulfillment', payment_policy: 'payment', return_policy: 'return' }[kind]];
  const listed = await listPolicies(env, kind, cfg.marketplaceId);
  if (listed.ok) {
    const hit = listed.rows.find((p) => (p.name || '').trim() === name.trim());
    if (hit) return { id: hit[listed.idKey], created: false, adopted: false, error: null };
  }
  const created = await createPolicy(env, kind, buildBody(cfg));
  if (created.ok) return { id: created.id, created: true, adopted: false, error: null };
  if (created.duplicateId) {                     // eBay pointed straight at the existing policy
    const again = await listPolicies(env, kind, cfg.marketplaceId);
    const row = again.rows.find((p) => String(p[again.idKey]) === String(created.duplicateId));
    return { id: created.duplicateId, created: false, adopted: true, adoptedName: row ? row.name : null, error: null };
  }
  if (created.duplicate) {                       // race / name reused — re-list to fetch the id
    const again = await listPolicies(env, kind, cfg.marketplaceId);
    const hit = again.rows.find((p) => (p.name || '').trim() === name.trim());
    if (hit) return { id: hit[again.idKey], created: false, adopted: false, error: null };
  }
  return { id: null, created: false, adopted: false, error: created.error || listed.error };
}

// ---- inventory location (Inventory API) --------------------------------------
export async function getInventoryLocation(env, key) {
  const r = await ebayRest(env, 'GET', `${INV}/location/${encodeURIComponent(key)}`);
  return { ok: r.ok, location: r.ok ? r.json : null, error: r.ok ? null : (firstErrorText(r.json) || 'HTTP ' + r.httpStatus) };
}
export async function ensureLocation(env, cfg) {
  const loc = cfg.location || {};
  const key = loc.merchantLocationKey || 'tcg-au-1';
  const got = await getInventoryLocation(env, key);
  if (got.ok) return { key, created: false, error: null };
  const address = { country: loc.country || 'AU' };
  if (loc.postalCode) address.postalCode = String(loc.postalCode);
  if (loc.city) address.city = loc.city;
  if (loc.stateOrProvince) address.stateOrProvince = loc.stateOrProvince;
  if (!address.postalCode && !(address.city && address.stateOrProvince)) {
    return { key: null, created: false, error: 'no warehouse postcode — set "Warehouse postcode" under Settings → eBay listing, save, then re-run this setup' };
  }
  const body = { location: { address }, name: loc.name || 'TCG AU', merchantLocationStatus: 'ENABLED', locationTypes: ['WAREHOUSE'] };
  const r = await ebayRest(env, 'POST', `${INV}/location/${encodeURIComponent(key)}`, { body });
  if (r.ok) return { key, created: true, error: null };
  return { key: null, created: false, error: firstErrorText(r.json) || 'HTTP ' + r.httpStatus };
}

// ---- orchestration -----------------------------------------------------------
// bootstrapAccount: run the whole prerequisite chain. Returns a report the settings UI renders and
// the resolved IDs the caller persists into config. Safe to re-run (idempotent find-or-create).
export async function bootstrapAccount(env, cfg) {
  const report = { optedIn: false, optInPending: false, policies: {}, location: null, warnings: [], errors: [] };

  const opted = await getOptedInPrograms(env);
  if (!opted.ok) { report.errors.push('read opted-in programs: ' + opted.error); return report; }
  report.optedIn = opted.programs.includes('SELLING_POLICY_MANAGEMENT');
  if (!report.optedIn) {
    const oi = await optInToProgram(env, 'SELLING_POLICY_MANAGEMENT');
    if (!oi.ok) { report.errors.push('opt-in: ' + oi.error); return report; }
    // eBay can take up to 24h to activate the program — policies can't be created until it's live.
    const recheck = await getOptedInPrograms(env);
    report.optedIn = recheck.ok && recheck.programs.includes('SELLING_POLICY_MANAGEMENT');
    if (!report.optedIn) { report.optInPending = true; report.warnings.push('business-policy opt-in submitted — eBay may take up to 24h to activate it; re-run bootstrap after that'); return report; }
  }

  const pay = await ensurePolicy(env, 'payment_policy', cfg, paymentBody);
  const ret = await ensurePolicy(env, 'return_policy', cfg, returnBody);
  const ful = await ensurePolicy(env, 'fulfillment_policy', cfg, fulfillmentBody);
  report.policies = {
    paymentPolicyId: pay.id, returnPolicyId: ret.id, fulfillmentPolicyId: ful.id,
    created: { payment: pay.created, return: ret.created, fulfillment: ful.created },
  };
  for (const [k, v] of [['payment', pay], ['return', ret], ['fulfillment', ful]]) {
    if (v.error) report.errors.push(`${k} policy: ${v.error}`);
    else if (v.unverified) report.warnings.push(`${k} policy: kept your chosen policy ${v.id} unchecked — eBay's policy list was unreadable (${v.unverified})`);
    else if (v.pinned) report.warnings.push(`${k} policy: using your chosen policy ${v.id}${v.pinnedName ? ` ("${v.pinnedName}")` : ''} — nothing created`);
    else if (v.adopted) report.warnings.push(`${k} policy: reusing the account's existing policy ${v.id}${v.adoptedName ? ` ("${v.adoptedName}")` : ''} — its terms are whatever you set on eBay, not what the config says`);
  }

  const locR = await ensureLocation(env, cfg);
  if (locR.error) report.errors.push('location: ' + locR.error);
  report.location = locR.key;

  report.ready = report.optedIn && !!pay.id && !!ret.id && !!ful.id && !!locR.key;
  return report;
}

// accountStatus: read-only — what's already in place, without creating anything. Used by
// GET /api/listings/account/status and the settings dashboard.
export async function accountStatus(env, cfg) {
  const [opted, sub] = await Promise.all([getOptedInPrograms(env), getSubscription(env)]);
  const optedIn = opted.ok && opted.programs.includes('SELLING_POLICY_MANAGEMENT');
  const proLevel = (sub.subscriptions[0] && sub.subscriptions[0].subscriptionLevel) || null;
  const p = (cfg && cfg.policies) || {};
  const loc = (cfg && cfg.location) || {};
  return {
    optedIn,
    optInError: opted.error,
    subscriptionLevel: proLevel,                 // Basic/Featured/Anchor => API listing allowed
    apiListingEntitled: !!proLevel && proLevel !== 'Starter',
    policies: { paymentPolicyId: p.paymentPolicyId || null, returnPolicyId: p.returnPolicyId || null, fulfillmentPolicyId: p.fulfillmentPolicyId || null },
    merchantLocationKey: loc.merchantLocationKey || null,
    ready: optedIn && !!p.paymentPolicyId && !!p.returnPolicyId && !!p.fulfillmentPolicyId && !!loc.merchantLocationKey,
  };
}
