// lib/shipping-bands.mjs — the one place the app decides which postage band an item is in, what the
// buyer pays for it, and which eBay fulfilment policy carries it.
//
// Why this exists: the store used to post everything free on a single fulfilment policy, so "what does
// postage cost" was a constant and nobody had to ask. It is now a function of the item price across
// three buyer-paid bands, and four independent places need the same answer — the offer's
// fulfilmentPolicyId, the description's quoted amount, the repricer's delivered→list conversion, and
// the settings validator. Any two of them disagreeing puts a listing on eBay whose description
// contradicts what the buyer is actually charged, which is an INAD claim with our name on it.
//
// PURE: no fs, no fetch, no DOM. Importable by Vite plugins, Node harnesses and
// <script type="module"> pages alike. Config LOADING lives in lib/listings.mjs (which already has fs);
// everything here takes the band table as an argument.
//
// MIRROR RULE (Golden Rules 6 + 9): the classic-<script> builders keep inline copies of BANDS and
// postagePhrase() because they cannot import ESM. If you change POSTAGE_COPY or DEFAULT_BANDS here,
// change all eight builders and extras.js too. test/invariants/builder-wording.test.mjs enforces it.

// ---------------------------------------------------------------------------
// Band shape
// ---------------------------------------------------------------------------
// A band stores only its UPPER bound. The lower bound is DERIVED as the previous band's maxCents + 1,
// so a gap or an overlap between bands is impossible to express, let alone save. A minCents/maxCents
// pair would invite exactly the one-cent hole this avoids. The last band's maxCents is null (no
// ceiling).
export const BAND_FIELD_DEFAULTS = {
  id: '',
  label: '',
  maxCents: null,
  costCents: 0,
  copy: 'letter_untracked',
  serviceCode: '',
  serviceLabel: '',
  policyId: '',
  policyName: '',
};

// The owner's live band table as of 2026-08-13. These literals are the MIRROR SOURCE: the builders'
// inline copies and the tracked example config are pinned equal to them by
// test/invariants/shipping-band-copy.test.mjs, and both copy harnesses run against them with no
// config loaded, which is what keeps the byte-identical builder parity working now that the postage
// sentence is a function rather than a constant.
export const DEFAULT_BANDS = [
  {
    id: 'letter',
    label: 'Regular letter',
    maxCents: 4998,
    costCents: 170,
    copy: 'letter_untracked',
    serviceCode: 'AU_AusPostStandardLetter',
    serviceLabel: 'Australia Post Domestic Regular Letter (untracked)',
    policyId: '269598843012',
    policyName: '',
  },
  {
    id: 'tracked',
    label: 'Tracked',
    maxCents: 14998,
    costCents: 826,
    copy: 'tracked',
    // Read live off the account's own policy 2026-08-14, not guessed. Worth knowing: AU_Regular
    // matches NONE of the postage classifier's patterns, so it has to be named explicitly in
    // postsale.config.json services — without that entry an $8.26 tracked order classifies as a plain
    // paid letter and the packer is never told to buy a label.
    serviceCode: 'AU_Regular',
    serviceLabel: 'Tracked with Australia Post',
    policyId: '273172636012',
    policyName: '',
  },
  {
    id: 'signature',
    label: 'Tracked + signature',
    maxCents: null,
    costCents: 1520,
    copy: 'tracked_signature',
    serviceCode: 'AUP_500G_SATCHEL_SIG',           // live 2026-08-14; a 500 g satchel, signature on delivery
    serviceLabel: 'Tracked with Signature on Delivery',
    policyId: '273172669012',
    policyName: '',
  },
];

// 0-indexed floor for GRADED slabs. A $20 PSA 8 fits the letter service physically, but the owner's
// call is that a graded card never travels untracked — so a slab's band is its price band raised to at
// least this index. Slabs therefore make band 2's effective price range [1c, its ceiling].
export const DEFAULT_MIN_BAND_FOR_SLAB = 1;

export const DEFAULT_SHIPPING = { minBandForSlab: DEFAULT_MIN_BAND_FOR_SLAB, bands: DEFAULT_BANDS };

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function cloneBand(b) { return { ...BAND_FIELD_DEFAULTS, ...b }; }

// DEFAULT_BANDS with every policyId blanked. What a config predating the band table gets: nothing on
// disk says which band the old single fulfilmentPolicyId was, and guessing is how a $200 slab ends up
// shipping on a $1.70 untracked letter. Blank ids make accountReadyGuard refuse to publish with a
// named error instead. Fail closed (GR4/GR7).
function defaultBandsUnassigned() {
  return DEFAULT_BANDS.map((b) => ({ ...cloneBand(b), policyId: '', policyName: '' }));
}

// Saved bands → a table bandIndexForPrice can always answer from. Merges BAND_FIELD_DEFAULTS under
// each ELEMENT by FIELD and never by position, so inserting a band in Settings cannot shuffle another
// band's defaults onto it.
//
// This is the RUNTIME-SAFETY path and deliberately repairs what it can (sort order, a missing null
// ceiling). It is not the validator: validateBands runs on the RAW saved value, so a malformed table
// is still refused at save time rather than being quietly rewritten.
export function normalizeBands(saved) {
  if (!Array.isArray(saved) || !saved.length) return defaultBandsUnassigned();
  const list = saved.filter(isPlainObject).map(cloneBand);
  if (!list.length) return defaultBandsUnassigned();
  // null sorts last; everything else ascends by ceiling.
  list.sort((a, b) => {
    if (a.maxCents == null) return b.maxCents == null ? 0 : 1;
    if (b.maxCents == null) return -1;
    return a.maxCents - b.maxCents;
  });
  list[list.length - 1] = { ...list[list.length - 1], maxCents: null };   // the top band has no ceiling
  return list;
}

// Accept either the shipping config sub-object or a bare bands array. The array form falls back to
// DEFAULT_MIN_BAND_FOR_SLAB rather than 0, because that is the SAFE direction: forgetting to thread
// minBandForSlab sends a slab tracked, never untracked.
export function shippingOf(shipping) {
  if (Array.isArray(shipping)) return { minBandForSlab: DEFAULT_MIN_BAND_FOR_SLAB, bands: normalizeBands(shipping) };
  const s = isPlainObject(shipping) ? shipping : {};
  const n = Number(s.minBandForSlab);
  return {
    minBandForSlab: Number.isInteger(n) && n >= 0 ? n : DEFAULT_MIN_BAND_FOR_SLAB,
    bands: normalizeBands(s.bands),
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
// Price → band index. The owner's figures (≤ $49.98 / $49.99–$149.98 / ≥ $149.99) read as CENTS, which
// is the only reading with no gap: 4998 / 14998 as ceilings, so 4999 and 14999 open the next band.
//
// Returns -1 for null, undefined, 0, a negative, NaN or a non-number. It NEVER falls back to band 1:
// a missing price is a fact the caller has to handle out loud, and quietly charging $1.70 postage on
// an item whose price we could not read is exactly the failure this whole module exists to stop.
export function bandIndexForPrice(priceCents, bands) {
  const p = Number(priceCents);
  if (!Number.isFinite(p) || !(p > 0)) return -1;
  const list = normalizeBands(bands);
  for (let i = 0; i < list.length; i++) {
    if (list[i].maxCents == null || p <= list[i].maxCents) return i;
  }
  return list.length - 1;   // unreachable once normalizeBands has nulled the top ceiling
}

export function bandForPrice(priceCents, bands) {
  const list = normalizeBands(bands);
  const i = bandIndexForPrice(priceCents, list);
  return i < 0 ? null : list[i];
}

// The band a LISTING gets: its price band, raised to the slab floor when the card is encapsulated.
export function bandIndexForListing(priceCents, shipping, { slab = false } = {}) {
  const { bands, minBandForSlab } = shippingOf(shipping);
  const i = bandIndexForPrice(priceCents, bands);
  if (i < 0) return -1;
  if (!slab) return i;
  return Math.max(i, Math.min(minBandForSlab, bands.length - 1));
}

export function bandForListing(priceCents, shipping, opts) {
  const { bands } = shippingOf(shipping);
  const i = bandIndexForListing(priceCents, shipping, opts);
  return i < 0 ? null : bands[i];
}

// The derived lower bound of band i. Band 0 starts at one cent.
export function bandMinCents(bands, i) {
  const list = normalizeBands(bands);
  if (i <= 0) return 1;
  const prev = list[i - 1];
  return prev && prev.maxCents != null ? prev.maxCents + 1 : 1;
}

// Reverse lookup: what the buyer paid → which band that is. Used by the repricer to tell whether a
// live listing is on our banded policies at all, and by verifyBandPolicies to prove which supplied
// policy id belongs to which band. Costs are strictly increasing (validateBands rule 7), so this is
// unambiguous by construction.
export function bandForCost(costCents, bands) {
  const c = Number(costCents);
  if (!Number.isFinite(c)) return null;
  const list = normalizeBands(bands);
  const hits = list.filter((b) => Number(b.costCents) === c);
  return hits.length === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------------------
// Delivered → list price (the repricer's arithmetic)
// ---------------------------------------------------------------------------
// The highest LIST price whose DELIVERED total (list + that price's band postage) does not exceed D.
//
// This is NOT a fixed-point iteration, and the difference matters. Solving P = D − cost(band(P))
// exactly has NO solution for a delivered anchor inside either of two dead zones, and a naive
// re-resolve loop oscillates between two bands forever. With costs 170/826/1520 and ceilings
// 4998/14998:
//     P₁ = D−170  is valid iff D ≤ 5168      P₂ = D−826 iff 5825 ≤ D ≤ 15824      P₃ = D−1520 iff D ≥ 16519
// The intervals are disjoint, so D ∈ [5169,5824] and D ∈ [15825,16518] have no self-consistent price.
// Worked: D = 5500 → 5330 → band 2 → 4674 → band 1 → 5330 → … forever.
//
// Because delivered(P) = P + cost(band(P)) is monotonically INCREASING (guaranteed by validateBands'
// strictly-increasing-cost rule: it rises inside a band, and at a boundary it steps from max+cost to
// max+1+higherCost), max{ P : delivered(P) ≤ D } exists and is unique. One descending scan finds it,
// at most one candidate per band, no loop. A dead-zone anchor resolves to the ceiling of the band
// below, which is the correct answer: the next cent up would deliver above D.
//
// minBandIndex is the slab floor. When it bites, the floor band's effective range starts at one cent
// rather than at the band below's ceiling + 1, because a $20 slab really is allowed to sit in band 2.
export function listPriceForDelivered(deliveredCents, bands, { minBandIndex = 0 } = {}) {
  const D = Math.round(Number(deliveredCents));
  if (!Number.isFinite(D) || D <= 0) return null;
  const list = normalizeBands(bands);
  const floor = Math.max(0, Math.min(minBandIndex, list.length - 1));
  for (let i = list.length - 1; i >= floor; i--) {
    const hi = list[i].maxCents == null ? Infinity : list[i].maxCents;
    const cand = Math.min(hi, D - Number(list[i].costCents));
    const lo = i === floor ? 1 : bandMinCents(list, i);
    if (cand >= lo) return cand;
  }
  return null;    // even the cheapest allowed band's postage eats the whole anchor
}

// ---------------------------------------------------------------------------
// Buyer-facing copy
// ---------------------------------------------------------------------------
// Owner-verified wording (Golden Rule 6). These are TEMPLATES in code, never free text in config:
// config supplies the money and picks a template by key. Free-text copy would be one typo away from
// promising tracking on an untracked service, and it would make the builders' byte-identical mirror
// impossible to enforce.
//
// No delivery dates. Estimates are eBay's, not ours, and promising one is an INAD claim.
export const POSTAGE_COPY = {
  letter_untracked: (m) => `Postage is ${m} anywhere in Australia, going as a regular Australia Post letter. There's no tracking on that one.`,
  tracked: (m) => `Postage is ${m} anywhere in Australia, sent tracked with Australia Post so you can follow it along.`,
  tracked_signature: (m) => `Postage is ${m} anywhere in Australia, sent tracked and signed for when it lands.`,
};

// Used when the price is unknown, which only happens in an unpriced PREVIEW — validateListing blocks
// publish on a null price. It quotes no amount, so it cannot contradict any policy.
export const POSTAGE_UNKNOWN = 'Postage within Australia is shown at checkout.';

export function money(cents) {
  const c = Number(cents);
  return '$' + ((Number.isFinite(c) ? Math.round(c) : 0) / 100).toFixed(2);
}

export function postagePhrase(band) {
  if (!band) return POSTAGE_UNKNOWN;
  const fn = POSTAGE_COPY[band.copy] || POSTAGE_COPY.letter_untracked;
  return fn(money(band.costCents));
}

// ---------------------------------------------------------------------------
// Validation — the ONE validator. lib/status.mjs (can this be saved?) and accountReadyGuard (can this
// publish?) both delegate here so they can never disagree about what a legal band table is.
// ---------------------------------------------------------------------------
// Returns a human sentence describing the first problem, or null when the table is sound.
//
// It deliberately does NOT require policyId to be set: the owner has to be able to save a band table
// before picking the eBay policies for it. accountReadyGuard is what refuses to PUBLISH with a band
// left unassigned.
// A shape check only, and deliberately permissive: eBay AU's real codes are far less regular than
// they look. The account's own three are AU_AusPostStandardLetter, AU_Regular and
// AUP_500G_SATCHEL_SIG — three-letter prefix, digits, and multiple underscores all appear. Anything
// tighter rejects a legitimate code the owner read straight off their policy, which is worse than
// letting a typo through: the check that actually matters is verifyBandPolicies, live against eBay.
const RE_SERVICE_CODE = /^[A-Z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/;
const RE_POLICY_ID = /^\d+$/;

export function validateBands(bands) {
  if (!Array.isArray(bands) || !bands.length) return 'at least one band is required';
  const ids = new Set();
  const policyIds = new Set();
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const last = i === bands.length - 1;
    const where = `band ${i + 1}`;
    if (!isPlainObject(b)) return `${where} is not an object`;

    const id = String(b.id || '').trim();
    if (!id) return `${where} needs an id`;
    if (ids.has(id)) return `two bands share the id "${id}"`;
    ids.add(id);

    if (!Number.isInteger(b.costCents) || b.costCents <= 0) {
      // Not ">= 0". This store has no free band, and a 0c band is exactly how free postage sneaks back
      // in through the settings form after all of this.
      return `${where} ("${id}") needs a whole-cent postage cost above zero`;
    }

    if (last) {
      if (b.maxCents != null) return `the last band ("${id}") must have no ceiling — leave "applies up to" blank`;
    } else {
      if (!Number.isInteger(b.maxCents) || b.maxCents <= 0) return `${where} ("${id}") needs a whole-cent ceiling above zero`;
      const next = bands[i + 1];
      if (isPlainObject(next) && next.maxCents != null && !(next.maxCents > b.maxCents)) {
        return `band ceilings must increase — "${id}" tops out at ${b.maxCents}c but the next band tops out at ${next.maxCents}c`;
      }
      // Strictly increasing, not merely non-decreasing. Two things depend on it: the repricer's
      // delivered→list scan needs delivered(P) monotone, and bandForCost needs cost→band to be
      // one-to-one so a live listing's postage identifies the band it is on.
      if (isPlainObject(next) && !(Number(next.costCents) > Number(b.costCents))) {
        return `band postage must increase — "${id}" charges ${b.costCents}c and the next band charges ${next.costCents}c`;
      }
    }

    if (!Object.prototype.hasOwnProperty.call(POSTAGE_COPY, b.copy)) {
      return `${where} ("${id}") has no description wording — pick one of ${Object.keys(POSTAGE_COPY).join(', ')}`;
    }

    const svc = String(b.serviceCode || '').trim();
    // Not an allow-list: hard-coding the seven codes the settings dropdown knows would refuse a
    // legitimate code the owner reads off their real policy. See RE_SERVICE_CODE above.
    if (svc && !RE_SERVICE_CODE.test(svc)) return `${where} ("${id}") has an eBay service code that does not look like one: "${svc}"`;

    const pid = String(b.policyId || '').trim();
    if (pid) {
      if (!RE_POLICY_ID.test(pid)) return `${where} ("${id}") has an eBay policy id that is not a number: "${pid}"`;
      if (policyIds.has(pid)) return `policy ${pid} is assigned to more than one band`;
      policyIds.add(pid);
    }
  }
  return null;
}

// Every band that still needs an eBay policy picked. accountReadyGuard turns this into its refusal.
export function unassignedBands(bands) {
  return normalizeBands(bands).filter((b) => !String(b.policyId || '').trim());
}
