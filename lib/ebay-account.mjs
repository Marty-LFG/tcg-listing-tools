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
import { ebayRest, firstErrorText } from './ebay-rest.mjs';
import { normalizeBands } from './shipping-bands.mjs';

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
// One fulfilment policy per postage BAND. There is no free-shipping branch left on purpose: a store
// that charges for every band should not carry a code path capable of emitting freeShipping:true.
export function fulfillmentBody(cfg, band) {
  const svc = {
    sortOrder: 1,
    shippingServiceCode: band.serviceCode || 'AU_AusPostStandardLetter',
    freeShipping: false,
    buyerResponsibleForShipping: false,
    shippingCost: { value: (Number(band.costCents) / 100).toFixed(2), currency: 'AUD' },
  };
  return {
    name: band.policyName || `TCG postage — ${band.label || band.id}`, marketplaceId: cfg.marketplaceId, categoryTypes: ALL_CATS,
    handlingTime: { value: Math.min(3, Math.max(0, cfg.handlingDays ?? 1)), unit: 'DAY' },  // ≤3 (AG-safe)
    shippingOptions: [{ optionType: 'DOMESTIC', costType: 'FLAT_RATE', shippingServices: [svc] }],
    // regionName takes eBay's ShippingLocation codes, not country NAMES — 'Australia' is rejected
    // with [20400] Invalid Location(s) (live 2026-07-26). The ISO country code is the valid form.
    shipToLocations: { regionIncluded: [{ regionName: (cfg.location && cfg.location.country) || 'AU' }] },
  };
}

// The three *Body builders above are the REFERENCE SHAPE of a correctly configured policy. Nothing
// here posts them — no policy is ever created — but the constraints in them are live-verified and
// easy to get wrong by hand, so checkPolicyConstraints below reads them back the other way: given a
// policy the owner made in Seller Hub, does it actually meet those constraints?
//
// Deliberately a SEPARATE question from verifyBandPolicies. That one asks "is this the right policy
// for this band" and answers it from the price. This asks "is this policy configured correctly at
// all", which is true or false regardless of which band it belongs to.
//
// ERROR = eBay will reject the listing, or the store is charging something it did not intend to.
// WARNING = works, but disagrees with what the config says the owner wanted; the lived case is
// 30-day returns quietly sitting on a store whose own listings say "No returns accepted".
// Returns [{ kind, policyId, policyName, severity, field, message }].
export function checkPolicyConstraints(kind, row, cfg, band) {
  const out = [];
  if (!row) return out;
  const id = String(row.paymentPolicyId || row.returnPolicyId || row.fulfillmentPolicyId || '');
  const name = row.name || '(unnamed)';
  const add = (severity, field, message) => out.push({ kind, policyId: id, policyName: name, severity, field, message });
  const who = `${name} (${id})`;

  if (kind === 'payment_policy') {
    // Inventory-API listings are immediate-payment. Without this eBay refuses the publish outright.
    if (row.immediatePay !== true) add('error', 'immediatePay', `${who} does not require immediate payment — the Sell Inventory API cannot publish against it. Turn on immediate payment in Seller Hub.`);
    // Under managed payments eBay runs the money; an offline method listed here is a leftover.
    const methods = Array.isArray(row.paymentMethods) ? row.paymentMethods.filter(Boolean) : [];
    if (methods.length) add('warning', 'paymentMethods', `${who} still lists offline payment methods (${methods.map((m) => m.paymentMethodType || m).join(', ')}) — this account is on managed payments, so they do nothing.`);
  }

  if (kind === 'return_policy') {
    const want = (cfg && cfg.returns) || {};
    const accepted = row.returnsAccepted === true;
    // The mismatch that started this: a policy the tool created accepted 30-day returns on a store
    // whose hand-made listings all said no returns. Config is the owner's stated intent.
    if (typeof want.accepted === 'boolean' && accepted !== want.accepted) {
      add('warning', 'returnsAccepted', accepted
        ? `${who} ACCEPTS returns, but Settings says this store does not. Buyers see the policy, not the setting — change whichever one is wrong.`
        : `${who} accepts no returns, but Settings says it should. Buyers see the policy, not the setting.`);
    }
    if (accepted) {
      const days = row.returnPeriod && row.returnPeriod.value;
      if (![30, 60].includes(days)) add('error', 'returnPeriod', `${who} has a ${days == null ? 'missing' : days + '-day'} return period — eBay AU allows only 30 or 60.`);
      else if (want.days && days !== want.days) add('warning', 'returnPeriod', `${who} gives buyers ${days} days, Settings says ${want.days}.`);
      if (row.refundMethod && row.refundMethod !== 'MONEY_BACK') add('warning', 'refundMethod', `${who} refunds by ${row.refundMethod} rather than money back.`);
      const payer = row.returnShippingCostPayer;
      if (want.shippingCostPayer && payer && payer !== want.shippingCostPayer) {
        add('warning', 'returnShippingCostPayer', `${who} makes the ${payer === 'SELLER' ? 'SELLER' : 'BUYER'} pay return postage, Settings says the ${want.shippingCostPayer}.`);
      }
    }
  }

  if (kind === 'fulfillment_policy') {
    const label = band ? `the "${band.label || band.id}" band's policy ${who}` : who;
    const hand = row.handlingTime && row.handlingTime.value;
    // ≤3 days is what keeps Authenticity-Guarantee items eligible; the settings validator pins the
    // same ceiling on our own config, so a hand-made policy that breaks it would be the one gap.
    if (hand == null) add('warning', 'handlingTime', `${label} states no dispatch time.`);
    else if (hand > 3) add('error', 'handlingTime', `${label} dispatches in ${hand} days — keep it to 3 or fewer or Authenticity-Guarantee items stop being eligible.`);
    else if (cfg && cfg.handlingDays != null && hand !== cfg.handlingDays) {
      add('warning', 'handlingTime', `${label} dispatches in ${hand} day${hand === 1 ? '' : 's'}, Settings says ${cfg.handlingDays}.`);
    }

    const dom = (row.shippingOptions || []).find((o) => o.optionType === 'DOMESTIC');
    if (!dom) add('error', 'shippingOptions', `${label} has no DOMESTIC postage option — an AU listing cannot use it.`);
    else {
      if (dom.costType && dom.costType !== 'FLAT_RATE') add('warning', 'costType', `${label} prices postage as ${dom.costType} rather than a flat rate, so the amount quoted in the description is not what every buyer pays.`);
      const svc = (dom.shippingServices || [])[0] || {};
      // Nothing is free postage any more, and the description quotes a figure.
      if (svc.freeShipping === true) add('error', 'freeShipping', `${label} offers FREE postage, but every description quotes an amount. One of them is lying to the buyer.`);
    }

    // Combined postage is OFF unless a rule is attached to the policy, and until this check existed
    // nothing in the codebase could tell — every guard reported green while it was entirely off.
    // INFO, not a warning: the store is under no obligation to combine, and while no description
    // claims it there is nothing to contradict. It earns its place by making the answer visible
    // before anyone writes copy that assumes it.
    if (!fulfillmentTerms(row).combined) {
      add('info', 'combinedPostage', `${label} carries no combined-postage rule, so a buyer ordering two items pays postage twice. Attach one under Seller Hub → Business policies → Combined postage discounts if you want them combined.`);
    }

    // regionName takes eBay's ShippingLocation codes, not country NAMES — 'Australia' is rejected
    // with [20400] Invalid Location(s) (live 2026-07-26).
    for (const r of ((row.shipToLocations || {}).regionIncluded) || []) {
      const rn = String(r.regionName || '');
      if (rn && !/^[A-Z]{2}$/.test(rn) && !/^Worldwide$/i.test(rn)) {
        add('warning', 'shipToLocations', `${label} ships to "${rn}" — eBay wants a location code (AU), not a country name.`);
      }
    }
  }
  return out;
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
  const d = fulfillmentTerms(row);
  const cost = d.free ? 'free' : (d.costCents != null ? 'A$' + (d.costCents / 100).toFixed(2) : 'paid');
  const more = d.serviceCount > 1 ? ` (+${d.serviceCount - 1} more)` : '';
  const hand = row.handlingTime && row.handlingTime.value != null ? ` · dispatch ${row.handlingTime.value}d` : '';
  return `${cost} · ${d.serviceCode || 'service unspecified'}${more}${hand}`;
}

// The terms a fulfilment policy actually carries, pulled out so describePolicy, the settings picker
// and verifyBandPolicies all read the same fields the same way.
export function fulfillmentTerms(row) {
  const dom = ((row && row.shippingOptions) || []).find((o) => o.optionType === 'DOMESTIC') || ((row && row.shippingOptions) || [])[0] || {};
  const svcs = dom.shippingServices || [];
  const cents = (m) => {
    const n = m && m.value != null ? Number(m.value) : null;
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  // EVERY domestic service, in eBay's own order, not just the first. A policy that offers a choice is
  // a policy whose buyers see a choice, so quoting only shippingServices[0] as "the" postage price
  // describes one option out of several. sortOrder is carried through rather than sorted on: it is
  // eBay's field and the buyer-facing order should be eBay's, not ours.
  const services = svcs.map((s, i) => ({
    code: s.shippingServiceCode || null,
    sortOrder: s.sortOrder != null ? s.sortOrder : i + 1,
    free: !!s.freeShipping,
    costCents: s.freeShipping ? 0 : cents(s.shippingCost),
    // ⚠ NOT a combined-postage figure. This is the per-extra-unit cost for multiple quantities of the
    // SAME line item, and eBay documents it as inapplicable to single-quantity fixed-price listings —
    // which is every listing this tool makes (buildOfferPayload defaults availableQuantity to 1). It
    // must never reach a description: "each extra card is $X" would be false on every listing here.
    additionalCostCents: cents(s.additionalShippingCost),
  }));
  const first = services[0] || {};
  // Is a COMBINED POSTAGE rule attached to this policy? Two fields, either of which means yes.
  //
  // Nothing in this repo could see these until now, which is why every guard reported three green
  // policies while combined postage was entirely off. eBay AU documents the postage policy as an
  // attachment point ("the postage discounts will then be applied to all listings with that postage
  // policy"), and since the Sell Inventory API offer carries no combined-postage field at all, this
  // policy-level attachment is the ONLY way a listing here can be opted in. So this is the one place
  // worth looking.
  const opts = (row && row.shippingOptions) || [];
  const discountProfileId = (opts.map((o) => o.shippingDiscountProfileId).find((v) => v != null && String(v).trim() && String(v) !== '0')) || null;
  const promotionOffered = opts.some((o) => o.shippingPromotionOffered === true);
  return {
    free: !!first.free,
    costCents: first.costCents != null ? first.costCents : null,
    serviceCode: first.code || null,
    serviceCount: services.length,
    services,
    discountProfileId,
    promotionOffered,
    combined: !!(discountProfileId || promotionOffered),
  };
}

// Prove which supplied policy id belongs to which band, instead of trusting the order they were pasted
// in. The band costs are distinct (1.70 / 8.26 / 15.20), so a fulfilment policy IDENTIFIES ITS OWN
// BAND — and three ids in the wrong order is a silent, total mispricing that eBay would publish
// happily: a $200 slab charged $1.70, a $2 common charged $15.20.
// Returns { ok, bands: [{id,label,policyId,policyName,wantCents,gotCents,wantService,gotService,ok,error}], errors, warnings }.
export function verifyBandPolicies(bands, rows, idKey) {
  const out = { ok: true, bands: [], errors: [], warnings: [] };
  const byId = new Map((rows || []).map((r) => [String(r[idKey]), r]));
  const seen = new Map();
  for (const b of bands || []) {
    const pid = String(b.policyId || '').trim();
    const row = pid ? byId.get(pid) : null;
    const terms = row ? fulfillmentTerms(row) : null;
    const e = { id: b.id, label: b.label || b.id, policyId: pid || null, policyName: row ? (row.name || null) : null,
      wantCents: b.costCents, gotCents: terms ? terms.costCents : null,
      wantService: b.serviceCode || null, gotService: terms ? terms.serviceCode : null, ok: false, error: null };

    if (!pid) e.error = `no eBay policy is assigned to the "${e.label}" band`;
    else if (seen.has(pid)) e.error = `policy ${pid} is on both the "${seen.get(pid)}" and "${e.label}" bands`;
    else if (!row) e.error = `the "${e.label}" band points at policy ${pid}, which is no longer on this eBay account`;
    else if (terms.costCents !== b.costCents) {
      // Name the band the policy REALLY belongs to — that is what makes a wrong-order paste obvious.
      const belongs = (bands || []).find((x) => x.costCents === terms.costCents);
      e.error = `the "${e.label}" band expects A$${(b.costCents / 100).toFixed(2)} but policy ${pid}`
        + `${row.name ? ` ("${row.name}")` : ''} charges ${terms.costCents == null ? 'free postage' : 'A$' + (terms.costCents / 100).toFixed(2)}`
        + (belongs ? ` — that is the "${belongs.label || belongs.id}" band's price, so the policy ids look out of order` : '');
    } else e.ok = true;

    if (pid) seen.set(pid, e.label);
    if (e.ok) {
      // shippingServices[0] stops being "what the buyer pays" the moment a policy offers a choice, and
      // the description quotes a single figure as fact.
      if (terms.serviceCount > 1) out.warnings.push(`the "${e.label}" band's policy offers ${terms.serviceCount} services — the description quotes only the first one's price`);
      if (b.serviceCode && terms.serviceCode && b.serviceCode !== terms.serviceCode) {
        out.warnings.push(`the "${e.label}" band is configured as ${b.serviceCode} but its policy really uses ${terms.serviceCode}`);
      }
    } else {
      out.ok = false;
      out.errors.push(e.error);
    }
    out.bands.push(e);
  }
  return out;
}

// Resolve the policy the owner PICKED for this kind. It can only ever verify.
//
// There is no create path here, by design and by instruction: eBay business policies are made by hand
// in Seller Hub, always. This function used to fall back to find-by-name and then POST a new policy
// when nothing matched, and on 2026-08-14 a blank band id took exactly that route and left three
// duplicates on the account — "TCG postage — Regular letter" beside the owner's own
// "Paid Shipping $0 - $49.98", charging the same money under a name they never chose.
//
// Deleting the branch rather than guarding each call site is the point: a NEW policy kind added later
// inherits the refusal instead of having to remember it.
//
// opts.pinnedId / opts.name say where the pin comes from. A postage BAND passes its own id and label
// (each band owns its policy); payment/return fall back to cfg.policies.
// Returns { id, pinned, pinnedName, missing, unverified, error }.
async function ensurePolicy(env, kind, cfg, opts = {}) {
  const kindName = kind.replace('_policy', '');
  const pinKey = { fulfillment_policy: 'fulfillmentPolicyId', payment_policy: 'paymentPolicyId', return_policy: 'returnPolicyId' }[kind];
  const pinned = opts.pinnedId !== undefined
    ? String(opts.pinnedId || '').trim()
    : String(((cfg && cfg.policies) || {})[pinKey] || '').trim();

  if (!pinned) {
    return { id: null, pinned: false, missing: true,
      error: `no ${kindName} policy is chosen — pick one under Settings → eBay listing. Setup will not create one: your policies already exist on eBay, and adding a parallel set is how an account ends up with duplicates.` };
  }
  const have = await listPolicies(env, kind, cfg.marketplaceId);
  // Unreadable list: keep the pin rather than declaring it gone. A read failure is not evidence.
  if (!have.ok) return { id: pinned, pinned: true, unverified: have.error, error: null };
  const row = have.rows.find((p) => String(p[have.idKey]) === pinned);
  // `row` rides back so the caller can run checkPolicyConstraints without a second round trip.
  if (row) return { id: pinned, pinned: true, pinnedName: row.name || null, row, error: null };
  return { id: null, pinned: true, missing: true,
    error: `the chosen ${kindName} policy ${pinned} is no longer on this eBay account — re-pick it in Settings → eBay listing` };
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

  // Payment and return are verified exactly like the postage bands below: pinned or refused. Neither
  // can create — see ensurePolicy.
  const pay = await ensurePolicy(env, 'payment_policy', cfg);
  const ret = await ensurePolicy(env, 'return_policy', cfg);
  report.policies = { paymentPolicyId: pay.id, returnPolicyId: ret.id };
  // Does each pinned policy actually MEET the constraints, separate from being the right one?
  const constraints = [];
  for (const [k, v] of [['payment', pay], ['return', ret]]) {
    if (v.error) report.errors.push(`${k} policy: ${v.error}`);
    else if (v.unverified) report.warnings.push(`${k} policy: kept your chosen policy ${v.id} unchecked — eBay's policy list was unreadable (${v.unverified})`);
    else report.warnings.push(`${k} policy: using your chosen policy ${v.id}${v.pinnedName ? ` ("${v.pinnedName}")` : ''} — nothing created`);
    if (v.row) constraints.push(...checkPolicyConstraints(k + '_policy', v.row, cfg));
  }

  // One fulfilment policy per postage band. The policy list is read ONCE above the loop: three bands
  // would otherwise mean three identical GETs, and hoisting it makes the band verification free.
  const bands = normalizeBands((cfg.shipping || {}).bands);
  const listed = await listPolicies(env, 'fulfillment_policy', cfg.marketplaceId);
  report.bands = [];
  for (const band of bands) {
    const label = band.label || band.id;
    const pinned = String(band.policyId || '').trim();
    // A band NEVER creates a policy. Postage policies are something the seller already has — they are
    // the terms buyers see — so an unassigned band is a configuration gap to report, not a thing to
    // invent. Letting this fall through to find-or-create is exactly how an account ends up with
    // "TCG postage — Regular letter" sitting beside the seller's own "Paid Shipping $0 - $49.98",
    // charging the same money under a name they never chose (lived, 2026-08-14: three duplicates).
    if (!pinned) {
      report.bands.push({ id: band.id, label, policyId: null, policyName: null, created: false });
      report.errors.push(`"${label}" postage band has no eBay policy assigned — pick one under Settings → eBay listing. Setup will not create one: your postage policies already exist on eBay, and adding a parallel set is how an account ends up with duplicates.`);
      continue;
    }
    // pinnedId is non-empty, so ensurePolicy takes its pinned branch: it VERIFIES the policy is still
    // on the account and refuses to substitute anything else. It cannot reach the create path.
    const r = await ensurePolicy(env, 'fulfillment_policy', cfg, { pinnedId: pinned, name: band.policyName || label });
    report.bands.push({ id: band.id, label, policyId: r.id, policyName: r.pinnedName || null, created: false });
    if (r.error) report.errors.push(`"${label}" postage policy: ${r.error}`);
    else if (r.unverified) report.warnings.push(`"${label}" postage policy: kept your chosen policy ${r.id} unchecked — eBay's policy list was unreadable (${r.unverified})`);
    if (r.row) constraints.push(...checkPolicyConstraints('fulfillment_policy', r.row, cfg, band));
  }
  // Constraint failures are their own list rather than being folded into errors/warnings: they are
  // about a policy being MISCONFIGURED, which is a different fix from one being missing or mismatched,
  // and the settings card groups them accordingly.
  report.policyCheck = { ok: !constraints.some((c) => c.severity === 'error'), issues: constraints };
  // Do the ids actually charge what their bands claim? This is the check that catches three ids pasted
  // in the wrong order, which nothing else would ever notice.
  if (listed.ok) {
    const resolved = bands.map((b, i) => ({ ...b, policyId: (report.bands[i] && report.bands[i].policyId) || b.policyId }));
    report.bandCheck = verifyBandPolicies(resolved, listed.rows, listed.idKey);
    report.errors.push(...report.bandCheck.errors);
    report.warnings.push(...report.bandCheck.warnings);
  } else {
    report.warnings.push('could not read the fulfilment policies back from eBay, so the band amounts are unverified: ' + listed.error);
  }

  const locR = await ensureLocation(env, cfg);
  if (locR.error) report.errors.push('location: ' + locR.error);
  report.location = locR.key;

  const bandsOk = report.bands.length > 0 && report.bands.every((b) => !!b.policyId) && (!report.bandCheck || report.bandCheck.ok);
  report.ready = report.optedIn && !!pay.id && !!ret.id && bandsOk && !!locR.key && report.policyCheck.ok;
  return report;
}

// accountStatus: read-only — what's already in place, without creating anything. Used by
// GET /api/listings/account/status and the settings dashboard.
export async function accountStatus(env, cfg) {
  const bands = normalizeBands(((cfg && cfg.shipping) || {}).bands);
  // The extra policy read is the price of catching a wrong-order paste BEFORE it reaches a live
  // listing rather than after. It is a read-only endpoint; nothing is created either way.
  const mkt = (cfg && cfg.marketplaceId) || 'EBAY_AU';
  const [opted, sub, listed, paidL, retL] = await Promise.all([
    getOptedInPrograms(env), getSubscription(env),
    listPolicies(env, 'fulfillment_policy', mkt),
    listPolicies(env, 'payment_policy', mkt),
    listPolicies(env, 'return_policy', mkt),
  ]);
  const optedIn = opted.ok && opted.programs.includes('SELLING_POLICY_MANAGEMENT');
  const proLevel = (sub.subscriptions[0] && sub.subscriptions[0].subscriptionLevel) || null;
  const p = (cfg && cfg.policies) || {};
  const loc = (cfg && cfg.location) || {};
  const bandCheck = listed.ok ? verifyBandPolicies(bands, listed.rows, listed.idKey) : null;
  const bandsOk = bands.length > 0 && bands.every((b) => !!String(b.policyId || '').trim()) && (!bandCheck || bandCheck.ok);

  // Are the pinned policies correctly CONFIGURED? Read-only and answerable without running setup,
  // which is the point: a policy edited in Seller Hub can drift at any time, and the owner should see
  // that on the settings card rather than the next time a publish fails.
  const rowFor = (r, id) => (r.ok && id ? r.rows.find((x) => String(x[r.idKey]) === String(id)) : null) || null;
  const issues = [
    ...checkPolicyConstraints('payment_policy', rowFor(paidL, p.paymentPolicyId), cfg),
    ...checkPolicyConstraints('return_policy', rowFor(retL, p.returnPolicyId), cfg),
    ...bands.flatMap((b) => checkPolicyConstraints('fulfillment_policy', rowFor(listed, b.policyId), cfg, b)),
  ];
  const policyCheck = { ok: !issues.some((i) => i.severity === 'error'), issues };
  return {
    optedIn,
    optInError: opted.error,
    subscriptionLevel: proLevel,                 // Basic/Featured/Anchor => API listing allowed
    apiListingEntitled: !!proLevel && proLevel !== 'Starter',
    policies: { paymentPolicyId: p.paymentPolicyId || null, returnPolicyId: p.returnPolicyId || null },
    // Kept readable for one release so the settings card can say "no longer used" rather than "set".
    legacyFulfillmentPolicyId: p.fulfillmentPolicyId || null,
    bands: bands.map((b) => ({ id: b.id, label: b.label || b.id, costCents: b.costCents, policyId: b.policyId || null, ok: !!String(b.policyId || '').trim() })),
    bandCheck,
    policyCheck,
    merchantLocationKey: loc.merchantLocationKey || null,
    ready: optedIn && !!p.paymentPolicyId && !!p.returnPolicyId && bandsOk && !!loc.merchantLocationKey && policyCheck.ok,
  };
}
