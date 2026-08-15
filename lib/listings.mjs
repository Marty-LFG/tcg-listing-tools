// lib/listings.mjs — Vite plugin that owns the eBay LISTING pipeline: /api/listings/*.
// Mirrors repricerPlugin / postsalePlugin (send/readJson helpers, CORS, a pathname router,
// registered in vite.config.js `plugins`). Uses the shared openDb() (tracker.db) and the single
// eBay user-token acquirer (lib/ebay-oauth.mjs via lib/ebay-rest.mjs).
//
// PHASE 0 SCOPE (this file today): the one-time account bootstrap only — opt into business policies,
// discover/create the AU payment+return+fulfilment policies and the merchant location, and report
// readiness. Phase 1 adds /preview + /publish (Sell Inventory API create→offer→publish) and the
// listings mirror; Phase 2 adds /price; Phase 4 adds the reconcile job. Everything degrades
// gracefully when eBay isn't connected (Golden Rule 7).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { oauthStatus } from './ebay-oauth.mjs';
import { accountStatus, bootstrapAccount, getPrivileges, listPolicies, describePolicy, fulfillmentTerms, verifyBandPolicies } from './ebay-account.mjs';
import { toEbayListing, validateListing, loadEbayCategories, buildItemDescription, ebayLanguageName } from './channels/ebay-map.mjs';
import { resolveConditionDescriptorIds } from './ebay-taxonomy.mjs';
import { buildOfferImageUrls, ensureGenericImage, createImageFromFile } from './ebay-media.mjs';
import { publishListing, withdrawOffer, listingUrl, getOffer, resolveStoreCategoryNames, deleteInventoryItem } from './channels/ebay-inventory-api.mjs';
import { getStoreCategories, getSellerSkus, getSellerListings, getListingState, buildReviseInventoryStatusInner,
  buildReviseFixedPriceItemInner, tradingCall, getItem,
  getItemSpecifics, mergeItemSpecifics, reviseItemSpecifics } from './ebay-trading.mjs';
// Phase 5: the Best Offer floor arithmetic is a DECISION, so it lives in the pure module with the
// rest of them and is tested without eBay. This file only does the I/O around it.
import { scaleBestOfferCents } from './repricer-decide.mjs';
import { stockLabelState, seedStockLabels, isProvisionalSku, peekStockLabel, commitStockLabel } from './inventory.mjs';
import { maxLabelSeq, labelFor } from './sku-labels.mjs';
import { parseCardTitle } from './listing-title-parse.mjs';
import { sweepRelistWatch, getRelistWatchState } from './relist-watch.mjs';
import { readCache as readPkmSetsCache, findSet, findIntlSet, findSetSymbol, findSetLogo } from './pkm-sets-cache.mjs';
import { findMtgSet } from './mtg-sets-cache.mjs';
import { findLorcanaSet } from './lorcana-sets-cache.mjs';
import { formatCardNumber } from './listing-copy.mjs';
import { ndjsonStart } from './ndjson.mjs';
// The batch guard rails live beside the client's own rules, on the SAME constants, so the two can
// never drift to different numbers. lib/runner-core.mjs is pure and browser-safe, so both the page
// and this server module import it.
import { refuseRow, blockingRefusals, medianOf } from './runner-core.mjs';
// The comps query lives with the other per-game facts, because the two stock pages need the same
// string for their eBay ↗ links and a hand-written second copy in a page is a mirror to police.
import { compsQueryFor, compsNumberMatch } from './stock-games.mjs';

// The EN set list, for turning a set NAME in a listing title into a set id. Comes from the same
// disk cache /api/pkm/sets fills, so no upstream call and no key needed. Empty until that has been
// populated once, which the caller reports rather than guessing set ids.
function enSetList() {
  const c = readPkmSetsCache();
  const data = (c && c.body && Array.isArray(c.body.data)) ? c.body.data : [];
  return data.map((s) => ({ id: s.id, name: s.name })).filter((s) => s.id && s.name);
}
import { singlesEbayValue } from './comps-singles.mjs';
import { feeAU, totalFromList } from './fees.mjs';
import { loadConfig as loadImageConfig, composeVersion as currentComposeVersion, resolveVariant as resolveRailVariant, PROMO_STAR_URL } from './listing-image-config.mjs';
import { composeListingImage, ComposeUnavailable } from './listing-image.mjs';
import { railsDigest } from './listing-image-assets.mjs';
import { configFile } from './config-paths.mjs';
import { DEFAULT_BANDS, DEFAULT_MIN_BAND_FOR_SLAB, normalizeBands, validateBands, unassignedBands } from './shipping-bands.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = configFile('ebay-listing.config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'data', 'ebay-listing.config.example.json');

const DEFAULT_CONFIG = {
  marketplaceId: 'EBAY_AU', categoryTreeId: '15', listingDuration: 'GTC', handlingDays: 1,
  outOfStockControl: true,
  location: { merchantLocationKey: 'tcg-au-1', name: 'TCG AU', country: 'AU', postalCode: '', city: '', stateOrProvince: '' },
  // No `fulfillment` name any more — each postage BAND names its own policy (see shipping.bands).
  policyNames: { payment: 'TCG Managed Payments AU', return: 'TCG 30-day returns AU' },
  // This store does not accept returns (its hand-made listings say "No returns accepted"), so a policy
  // the tool has to CREATE must say that too. A policy PICKED in Settings always wins over this.
  returns: { accepted: false, days: 30, shippingCostPayer: 'BUYER' },
  // PRICE-BANDED buyer-paid postage. Nothing is free. lib/shipping-bands.mjs owns the table, the
  // resolver and the buyer-facing wording; this is only where it gets loaded from disk.
  shipping: { minBandForSlab: DEFAULT_MIN_BAND_FOR_SLAB, bands: DEFAULT_BANDS },
  policies: { paymentPolicyId: '', returnPolicyId: '' },
  // eBay STORE categories (the storefront department, NOT the marketplace categoryId). Full paths.
  // Left blank, eBay files every offer under the store's default "Other" — which is where our first
  // API listing landed, the only one of 163 store items outside Trading Card Games.
  store: { defaultCategory: '', categoryByGame: {} },
  bestOffer: { enabled: false, autoAcceptPct: 95, autoDeclinePct: 78 },
  genericImage: { enabled: false, path: '', eps: '', expires: '' },
};

// eBay's documented cap: an offer may sit in one or two store categories. It is prose-only — the
// OpenAPI contract carries no maxItems — so nothing server-side enforces it and behaviour on a third
// is undocumented. That makes this client-side limit load-bearing rather than belt-and-braces.
export const STORE_CATEGORY_MAX = 2;
const STORE_CATS_TTL_MS = 30 * 60 * 1000;
let _storeCats = null;

// Seed the server-owned config from its tracked .example on first boot (like refresh/postsale).
export function ensureConfigSeeded() {
  try { if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_EXAMPLE_PATH)) { fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH); console.log('[listings] seeded data/ebay-listing.config.json from example'); } }
  catch (e) { console.warn('[listings] config seed failed —', e?.message || e); }
}
// One-shot boot warnings. loadConfig runs per request, so these must not repeat per call.
let _warnedLegacyShipping = false;
function warnLegacyShipping(rawShipping, rawPolicies) {
  if (_warnedLegacyShipping) return;
  const s = rawShipping || {}, p = rawPolicies || {};
  const legacy = !Array.isArray(s.bands) && (s.serviceCode || s.freeDomestic != null || p.fulfillmentPolicyId != null);
  if (!legacy) return;
  _warnedLegacyShipping = true;
  console.warn('[listings] shipping config predates price bands — the three postage policies must be assigned in Settings → eBay listing before anything can publish');
  if (s.freeDomestic === true) {
    console.warn('[listings] shipping.freeDomestic is still true on disk and is now IGNORED — this store charges banded postage. Remove the key.');
  }
}

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    warnLegacyShipping(raw.shipping, raw.policies);
    return {
      ...DEFAULT_CONFIG, ...raw,
      location: { ...DEFAULT_CONFIG.location, ...(raw.location || {}) },
      policyNames: { ...DEFAULT_CONFIG.policyNames, ...(raw.policyNames || {}) },
      returns: { ...DEFAULT_CONFIG.returns, ...(raw.returns || {}) },
      // `bands` is an ARRAY, so the spread replaces it wholesale — which is what we want, because no
      // half-merged band may exist. normalizeBands then fills BAND_FIELD_DEFAULTS under each ELEMENT
      // by field and never by position, so inserting a band cannot shuffle another band's defaults
      // onto it. A config predating the band table has no `bands` and gets the defaults with every
      // policyId BLANK: nothing on disk says which band the old single fulfilmentPolicyId was, and
      // guessing is how a $200 slab ends up on a $1.70 untracked letter. accountReadyGuard then
      // refuses to publish by name (GR4/GR7). A MISSING file is different — that is a fresh install,
      // and it gets the same shipped defaults the example config seeds.
      shipping: { ...DEFAULT_CONFIG.shipping, ...(raw.shipping || {}), bands: normalizeBands((raw.shipping || {}).bands) },
      policies: { ...DEFAULT_CONFIG.policies, ...(raw.policies || {}) },
      store: { ...DEFAULT_CONFIG.store, ...(raw.store || {}),
        categoryByGame: { ...DEFAULT_CONFIG.store.categoryByGame, ...((raw.store || {}).categoryByGame || {}) } },
      bestOffer: { ...DEFAULT_CONFIG.bestOffer, ...(raw.bestOffer || {}) },
      genericImage: { ...DEFAULT_CONFIG.genericImage, ...(raw.genericImage || {}) },
    };
  } catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);            // atomic
}
// Merge bootstrap results (policy IDs + location key) back into the persisted config.
function persistBootstrap(cfg, report) {
  const next = {
    ...cfg,
    policies: { ...cfg.policies },
    location: { ...cfg.location },
    shipping: { ...cfg.shipping, bands: (cfg.shipping.bands || []).map((b) => ({ ...b })) },
  };
  if (report.policies) {
    if (report.policies.paymentPolicyId) next.policies.paymentPolicyId = report.policies.paymentPolicyId;
    if (report.policies.returnPolicyId) next.policies.returnPolicyId = report.policies.returnPolicyId;
  }
  // Postage policies are merged by band ID, never by array position: a band inserted in Settings
  // between two bootstrap runs would otherwise write the ids onto the wrong bands, which is a silent
  // total mispricing rather than an error.
  for (const row of (report.bands || [])) {
    if (!row || !row.id || !row.policyId) continue;
    const band = next.shipping.bands.find((b) => b.id === row.id);
    if (!band) continue;
    band.policyId = String(row.policyId);
    if (row.policyName) band.policyName = row.policyName;
    // Full overwrite, not a merge: the service list is eBay's truth, and a service removed on eBay
    // must disappear here or the description keeps offering an option the buyer cannot pick.
    if (Array.isArray(row.services)) band.services = row.services;
  }
  if (report.location) next.location.merchantLocationKey = report.location;
  saveConfig(next);
  return next;
}

// --- tiny http helpers (same shape as lib/repricer.mjs / lib/postsale.mjs) ---
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 20e6) b = b.slice(0, 20e6); });   // room for a base64 photo
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
// 'not connected' (no eBay consent) → a clean 409 the UI turns into "connect eBay first".
function guardConnected(env, res) {
  const st = oauthStatus(env);
  if (!st.connected) { send(res, 409, { error: 'eBay account not connected — run the consent flow at /api/repricer/oauth first', code: 'not_connected' }); return false; }
  return true;
}
// publishing needs the bootstrap done (the three policy IDs + merchant location).
function accountReadyGuard(cfg, res) {
  const p = (cfg && cfg.policies) || {}, loc = (cfg && cfg.location) || {};
  const bands = ((cfg && cfg.shipping) || {}).bands || [];
  // Postage is banded now, so "ready" means EVERY band has a policy — a single missing one publishes
  // that whole price range against no fulfilment policy at all.
  const bandErr = validateBands(bands);
  const unassigned = bandErr ? [] : unassignedBands(bands).map((b) => b.label || b.id);
  if (!p.paymentPolicyId || !p.returnPolicyId || !loc.merchantLocationKey || bandErr || unassigned.length) {
    const why = bandErr ? `the postage band table is invalid (${bandErr})`
      : unassigned.length ? `these postage bands have no eBay policy: ${unassigned.join(', ')}`
      : 'business policies + merchant location';
    send(res, 409, { error: 'eBay listing not set up — ' + why + '. Fix it under Settings → eBay listing, then run “Run eBay listing setup”.', code: 'not_ready' });
    return false;
  }
  return true;
}
// DIAG_TOKEN gate for the manual reconcile trigger (makes eBay reads). Mirrors postsale's diagOk:
// 503 when unset (feature disabled), 401 missing, 403 wrong — constant-time compare.
function diagOk(env, req, url) {
  const token = String(env.DIAG_TOKEN || '').trim();
  if (!token) return { ok: false, code: 503, error: 'diagnostics disabled (no DIAG_TOKEN on server)' };
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (url.searchParams.get('token') || '').trim();
  if (!bearer) return { ok: false, code: 401, error: 'missing DIAG_TOKEN' };
  const a = Buffer.from(bearer), b = Buffer.from(token);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, code: 403, error: 'bad DIAG_TOKEN' };
}
// The override fields a caller (the builder) may pass to enrich a thin inventory row at publish time.
// ONE list, shared with itemToListing — adding a name here carries it all the way to toEbayListing.
const OVERRIDE_FIELDS = ['character', 'card_type', 'speciality', 'illustrator', 'card_size', 'stage',
  'year_manufactured', 'manufacturer', 'autographed', 'finish', 'supertype', 'subtypes', 'types', 'hp',
  'pokedex', 'pokedex_numbers', 'regulation_mark', 'set_code', 'set_series', 'set_release_date',
  'printed_total', 'evolves_from', 'release_year',
  // Magic. These are re-resolved from the Scryfall cache at export time (resolveMtgCard), so they
  // are an OVERRIDE channel rather than the only source — but without them on this list a builder
  // that already knows the colour/treatment has no way to say so, and a card whose set has fallen
  // out of the cache would silently lose every derived aspect.
  'colour', 'treatment', 'promo_note', 'card_type_aspect'];
function pickOverrides(b) {
  const o = {};
  if (b.price_cents != null) o.price_cents = b.price_cents;
  for (const k of OVERRIDE_FIELDS) if (b[k] != null) o[k] = b[k];
  if (Array.isArray(b.photo_urls)) o.photo_urls = b.photo_urls;
  // A listing DECISION, not a card fact, so it is not in OVERRIDE_FIELDS. Only an ARRAY counts: an
  // ABSENT field must leave the persisted pick alone, which is what makes /revise-price and a future
  // repricer apply re-send the same storeCategoryNames instead of letting eBay drop them.
  if (Array.isArray(b.store_categories)) o.store_categories = b.store_categories;
  // Branded rails, same shape: a decision rather than a fact, and ABSENT means "defer" — only an
  // explicit true/false overrides the batch-level pick or the config default.
  if (b.compose != null) o.compose = !!b.compose;
  return o;
}

// Compute Best-Offer auto-accept / auto-decline cents from the price + a {enabled, autoAcceptPct,
// autoDeclinePct} spec (falling back to config defaults). Returns { enabled, autoAcceptCents, autoDeclineCents }.
function resolveBestOffer(priceCents, spec, cfg) {
  const d = (cfg && cfg.bestOffer) || {};
  const enabled = spec && spec.enabled != null ? !!spec.enabled : !!d.enabled;
  if (!enabled || !(priceCents > 0)) return { enabled: false };
  const accPct = spec && spec.autoAcceptPct != null ? +spec.autoAcceptPct : d.autoAcceptPct;
  const decPct = spec && spec.autoDeclinePct != null ? +spec.autoDeclinePct : d.autoDeclinePct;
  const out = { enabled: true };
  if (accPct > 0) out.autoAcceptCents = Math.round(priceCents * accPct / 100);
  if (decPct >= 0) out.autoDeclineCents = Math.round(priceCents * decPct / 100);
  // eBay rejects an auto-accept BELOW the auto-decline (25002), and it rejects it at the publish step
  // — after the inventory item and the offer have already been created, so a swap leaves a half-built
  // offer on the account and burns the round trip. Nothing upstream catches it: each percentage is
  // separately legal (both are a valid 0–100), and only the RELATIONSHIP between them is wrong, which
  // is exactly what a transposed pair looks like. Equal is fine — eBay only objects to lower.
  if (out.autoAcceptCents != null && out.autoDeclineCents != null && out.autoAcceptCents < out.autoDeclineCents) {
    out.error = 'best offer: auto-accept A$' + (out.autoAcceptCents / 100).toFixed(2) + ' (' + accPct + '%) is below auto-decline A$'
      + (out.autoDeclineCents / 100).toFixed(2) + ' (' + decPct + '%) — eBay rejects that (25002). The two percentages look transposed.';
  }
  return out;
}

// Build the canonical listing object for one inventory item, applying overrides (price, rich aspect
// fields the builder looked up, photo URLs). Returns { listing, item } or { error }.
function itemToListing(db, itemId, overrides = {}) {
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(+itemId);
  if (!item) return { error: 'inventory item ' + itemId + ' not found' };
  const merged = { ...item };
  // Card facts captured at save time. Without this a republish carrying no overrides (/revise-price, a
  // future repricer apply) PUTs a thinner inventory item and STRIPS the item specifics off a live
  // listing, because createOrReplaceInventoryItem is a full replace.
  if (item.card_facts) { try { Object.assign(merged, JSON.parse(item.card_facts)); } catch {} }
  if (overrides.price_cents != null) merged.target_price_cents = overrides.price_cents;
  // rich aspects + photos the thin DB row doesn't carry (supplied from the builder lookup)
  for (const k of OVERRIDE_FIELDS) if (overrides[k] != null) merged[k] = overrides[k];
  if (Array.isArray(overrides.photo_urls)) merged.photo_urls = overrides.photo_urls;
  if (Array.isArray(overrides.store_categories)) merged.store_categories = overrides.store_categories;
  // 'variant' is the persisted identity token ('Holo'/'Reverse Holo'/'Base'); ebay-map wants a finish.
  if (!merged.finish && merged.variant) merged.finish = merged.variant;
  // The LIVE band table, not the code defaults: the amount the description quotes has to match the
  // policy the offer will carry, and both come from this one shipping block.
  const listing = toEbayListing(merged, null, loadEbayCategories(), { shipping: loadConfig().shipping });
  return { listing, item, merged };
}

// ---------------------------------------------------------------------------
// Branded listing images (lib/listing-image.mjs). Off by default; see AGENTS.md §19.
// ---------------------------------------------------------------------------

// The ORIGINAL bytes of an owner photo, kept so an ASSET_VERSION bump can re-brand it later. The
// /photos route used to decode the data URL, upload it and drop it on the floor — with the rails
// baked in and no original, the only way back would be re-shooting the card. Content-addressed, so
// re-uploading the same photo costs nothing.
const PHOTO_ORIGINALS_DIR = path.join(ROOT, 'data', 'photo-originals');
export function storePhotoOriginal(buffer, ext = 'jpg') {
  try {
    fs.mkdirSync(PHOTO_ORIGINALS_DIR, { recursive: true });
    const name = crypto.createHash('sha256').update(buffer).digest('hex') + '.' + ext;
    const file = path.join(PHOTO_ORIGINALS_DIR, name);
    if (!fs.existsSync(file)) {
      const tmp = file + '.tmp' + process.pid;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
    }
    return file;
  } catch (e) { console.warn('[listings] could not retain photo original —', e?.message || e); return null; }
}

// What the rails say about a card. Language is mapped out of the stored 2-letter code ('JP' →
// 'Japanese') because the rail is buyer-facing and 'JP · MEGA SYMPHONIA' reads like a typo.
// Condition is deliberately ABSENT: it would put an NM and an LP of one card on two separately
// hosted images, doubling uploads across the store for something the rail never shows.
export function composeMetaFor(item = {}) {
  const graded = !!(item.grading_company || item.grade);
  const productType = item.product_type === 'sealed' ? 'sealed' : graded ? 'slab' : 'single';

  // SET IDENTITY IS POKÉMON-ONLY BELOW. findIntlSet (TCGdex), findSet (pokemontcg.io),
  // findSetSymbol/findSetLogo (the Bulbapedia bake) and Golden Rule 10's formatter all index the
  // POKÉMON set universe, and NONE of them is game-scoped — they match on a bare set code or name.
  // Codes collide across games, so an un-guarded non-Pokémon row silently borrows another game's
  // branding: MTG's 'LTR' resolves to Pokémon's Legendary Treasures (bw11) and stamps a Pokémon
  // symbol, a Pokémon logo AND a fabricated '246/113' onto a Magic card — a set the card is not
  // from and a number that is not printed on it (GR4 + GR10).
  //
  // `game` is NOT NULL on inventory_items; only test fixtures omit it, and those are Pokémon.
  // Other games take their identity verbatim and get no set art until their own branch lands.
  const pkm = !item.game || item.game === 'pokemon';
  if (!pkm) {
    // Magic resolves against its OWN set list. The icon comes off the resolved record and is never
    // constructed from the code: svgs.scryfall.io answering 200 for a code we invented is the
    // images.scrydex.com placeholder trap over again (AGENTS.md 19), and a wrong symbol is worse
    // than none. Magic has no set wordmark, so the logo box stays empty and the masthead falls back
    // to the set name — which is what the frame already does on an empty value.
    const mset = item.game === 'mtg'
      ? findMtgSet({ code: item.set_code, name: item.set_name })
      : null;
    // Lorcana resolves against its OWN set list too, but for LESS than Magic does — it fetches no
    // art, because Lorcast publishes no set symbol and no wordmark and neither does any other
    // keyless source. Both slots stay empty and the masthead falls back to the set name, exactly as
    // it does for Magic's missing wordmark. Constructing a symbol URL out of the set code instead
    // is the images.scrydex.com placeholder trap (AGENTS.md 19) — a URL that 200s with the wrong
    // picture is worse than no picture (GR4).
    //
    // What the lookup buys is the CANONICAL set name on the rail: the owner's stored `set_name` may
    // carry a decoration or a typo, and Lorcast's own name is the better label. It is a small win,
    // and it is honestly all it is — the `!pkm` guard above is what keeps every non-Pokémon game
    // out of the Pokémon set-identity path, and that predates this branch. The value of naming
    // Lorcana here is that the hook exists if Lorcast ever ships set art.
    const lset = item.game === 'lorcana'
      ? findLorcanaSet({ code: item.set_code, name: item.set_name })
      : null;
    return {
      productType,
      cardName: item.name || '',
      language: ebayLanguageName(item.language),
      setName: (lset && lset.name) || item.set_name || '',
      cardNumber: String(item.number == null ? '' : item.number).trim(),
      rarity: item.rarity || '',
      setSymbolUrl: (mset && mset.icon_svg_uri) || '',
      setLogoUrl: '',
    };
  }

  // A NON-ENGLISH card is a different product, not a translation: its own set (アビスアイ /
  // "Abyss Eye" where English has "Pitch Black"), its own symbol and its own numbering out of a
  // different card count — a JP Abyss Eye secret rare prints 102/081, a number that does not exist
  // in the English set. So a JP row resolves against the baked TCGdex index first; the English
  // index is the fallback, not the default.
  const intl = findIntlSet(item.language, { code: item.set_code, name: item.set_name });
  if (intl) {
    // NEVER name_native: 146 of 277 JP sets have no romanised name in the bake, and their native
    // names are Japanese script the Latin rail font cannot draw. The owner's own stored set_name is
    // the better fallback; railText drops whatever is left that cannot be rendered.
    //
    // `nameSuspect` marks a block where TCGdex returned ONE set's identity for many distinct codes
    // (all fifteen JP CS* ids come back as トリプレットビート). Trusting that name would print the
    // wrong set on the rail, so the owner's own value wins outright for those.
    const setName = (intl.nameSuspect ? item.set_name : (intl.name_en || item.set_name)) || '';
    // TCGdex carries almost no JP symbols, so the Bulbapedia bake is the real source here and the
    // bake's own field is the fallback, not the other way round.
    const sym = findSetSymbol(item.language, setName, intl.name_native, intl.code, intl.tcgdexId);
    return {
      productType,
      cardName: item.name || '',
      language: ebayLanguageName(item.language),
      // The romanised name — what an AU buyer searches and what fits a Latin-glyph rail font.
      setName,
      cardNumber: printedCardNumber(item, { name: intl.name_en, printedTotal: intl.cardCount, total: intl.cardCount, series: intl.serie, releaseDate: intl.releaseDate }),
      rarity: item.rarity || '',
      setSymbolUrl: (sym && sym.url) || (intl.symbol && String(intl.symbol).trim()) || '',
      // Bulbapedia files JP logos under a mix of set code and set name (`SM1_Logo.png` vs
      // `SV3a_Raging_Surf_Logo.png`), so try every identity this row has.
      setLogoUrl: (findSetLogo(item.language, intl.code, intl.tcgdexId, setName, intl.name_native) || {}).url || '',
    };
  }

  // The English set's cached record carries the SYMBOL and the LOGO, plus the era fields Golden
  // Rule 10's formatter reads. A cold cache or a set it does not know falls back to the symbol bake.
  const set = findSet({ code: item.set_code, name: item.set_name }) || null;
  if (isBlackStarPromoSet(item.set_name || (set && set.name), item.set_code)) {
    return {
      productType,
      cardName: item.name || '',
      language: ebayLanguageName(item.language),
      setName: item.set_name || '',
      cardNumber: printedCardNumber(item, set),
      rarity: item.rarity || '',
      // The BAKE only, never pokemontcg.io: its "symbol" for a promo set is the generic black star,
      // and the star already has the logo slot below — the badge wants the SET's own boxed mark
      // (MEP, SVP), which only Bulbapedia carries. Older promo eras have no boxed mark anywhere,
      // so their badge is deliberately the printed number alone.
      setSymbolUrl: (findSetSymbol('en', item.set_name, item.set_code) || {}).url || '',
      // Every Black Star promo wears the star where a wordmark would go — none of these sets has a
      // wordmark, and the star is what tells a buyer at a glance that this is a promo printing.
      setLogoUrl: PROMO_STAR_URL,
    };
  }
  const enSym = (set && set.images && set.images.symbol) || (findSetSymbol('en', item.set_name, item.set_code) || {}).url || '';
  return {
    productType,
    cardName: item.name || '',
    language: ebayLanguageName(item.language),
    setName: item.set_name || '',
    cardNumber: printedCardNumber(item, set),
    rarity: item.rarity || '',
    setSymbolUrl: enSym,
    // pokemontcg.io first — its logos are clean transparent PNGs sized for display. The Bulbapedia
    // index is the fallback for sets it does not carry.
    setLogoUrl: (set && set.images && set.images.logo) || (findSetLogo('en', item.set_code, item.set_name) || {}).url || '',
  };
}

// The English Black Star Promo family — every era names itself "<era> Black Star Promos" on
// pokemontcg.io (Wizards/DP/HGSS/XY/SM/SWSH/SVP), plus the baked Mega-era roster, which is named
// off TCGplayer instead. A checked test, not a fuzzy one: 'promo' alone would also match rarity
// strings and the JP promotional sets, which have their own identity and are not in scope here.
export function isBlackStarPromoSet(setName, setCode) {
  return /black star promos/i.test(String(setName || ''))
    || /^mega evolution promo$/i.test(String(setName || '').trim())
    || String(setCode || '').trim().toLowerCase() === 'mep';
}

// The number EXACTLY as printed on the card (Golden Rule 10) — never `number + '/' + printedTotal`.
//
// The guard matters: formatCardNumber takes the RAW upstream number, and the uploader already
// stores a formatted one. Feeding "069/086" back through it falls past both numeric branches and
// hits the trailing `raw + '/' + denom`, producing "069/086/086". So anything already carrying a
// slash is treated as printed and passed through untouched; a bare "69" from a bulk import still
// gets rebuilt from the set's era.
export function printedCardNumber(item = {}, set = null) {
  const raw = String(item.number == null ? '' : item.number).trim();
  if (!raw || raw.includes('/')) return raw;
  // GR10 is a POKÉMON rule — it rebuilds the padding pokemontcg.io strips, out of that set's era
  // and printed total. No other game has those inputs: Scryfall exposes no printed total (MTG's
  // set.card_count counts PRINTINGS — HOB is 321 with alt treatments numbered past 250), so there
  // is no denominator to render and inventing one is GR4. Magic prints '249', so '249' it is.
  if (item.game && item.game !== 'pokemon') return raw;
  const s = set || {};
  try {
    return formatCardNumber(raw, {
      name: item.set_name || s.name || '',
      printedTotal: item.printed_total != null ? item.printed_total : s.printedTotal,
      total: s.total,
      series: item.set_series || s.series || '',
      releaseDate: item.set_release_date || s.releaseDate || '',
    }, { rarity: item.rarity || '' }) || raw;
  } catch { return raw; }
}

/**
 * Should this publish brand its images, and with what?
 * `decision` is the per-listing toggle: true/false force it, null/undefined defers to the config.
 * Returns { enabled, meta, options } for buildOfferImageUrls, plus `reason` when it is off.
 */
export function composeContext(item, decision, { path: which = 'catalogArt' } = {}) {
  const cfg = loadImageConfig();
  const wanted = decision == null ? !!cfg.enabled : !!decision;
  if (!wanted) return { enabled: false, reason: decision === false ? 'turned off for this listing' : 'disabled in settings' };
  if (!cfg.applyTo || !cfg.applyTo[which]) return { enabled: false, reason: `applyTo.${which} is off` };
  return { enabled: true, meta: composeMetaFor(item), options: { cfg } };
}

/**
 * Brand one owner photo's bytes, if branding is on for this call.
 * Returns { buffer, ext, contentType, composeHash, composeVersion, warning } — falling back to the
 * ORIGINAL bytes on any failure, because a listing with an unbranded photo beats one with none.
 */
async function composePhotoBytes(item, buffer, ext, contentType, decision) {
  const plain = { buffer, ext, contentType: contentType || undefined, composeHash: null, composeVersion: null };
  const ctx = composeContext(item, decision, { path: 'ownerPhotos' });
  if (!ctx.enabled) return plain;
  try {
    const r = await composeListingImage(buffer, ctx.meta, ctx.options);
    return { buffer: r.buffer, ext: 'jpg', contentType: 'image/jpeg', composeHash: r.contentHash, composeVersion: r.composeVersion };
  } catch (e) {
    return { ...plain, warning: (e instanceof ComposeUnavailable ? 'branding skipped' : 'branding failed') + ': ' + (e?.message || e) };
  }
}

// The compose_version an image branded RIGHT NOW would carry, for the stale check below.
function expectedComposeVersion(item) {
  try {
    const cfg = loadImageConfig();
    const variant = resolveRailVariant(composeMetaFor(item), {}, cfg);
    return currentComposeVersion(variant, railsDigest(variant) || '');
  } catch { return null; }
}

// The full publish/preview pipeline for one item: resolve descriptor IDs → EPS images → publish (or
// dry-run) → write back. Returns a rich result object. saveCfg persists the generic-image EPS cache.
export async function runPublish(env, db, cfg, saveCfg, { itemId, overrides = {}, bestOfferSpec, photoPaths = [], dryRun = false, compose = null }) {
  const built = itemToListing(db, itemId, overrides);
  if (built.error) return { ok: false, error: built.error };
  const { listing, item, merged } = built;

  const v = validateListing(listing, loadEbayCategories());
  if (v.errors.length) return { ok: false, error: 'validation: ' + v.errors.join('; '), validation: v };

  // GR7: never block on this, but never let it be invisible either. An offer with no store category
  // is filed under the store's default "Other" — the exact failure that left the first API listing
  // the only one of 163 store items outside Trading Card Games.
  const storeCategoryNames = resolveStoreCategoryNames(listing, cfg);
  if (!storeCategoryNames.length) v.warnings.push('no eBay store department — this listing will be filed under “Other”');

  // structured grading → numeric eBay condition-descriptor IDs (never guessed; unresolved blocks)
  const cd = await resolveConditionDescriptorIds(env, listing.conditionDescriptors, { graded: listing.graded, categoryId: listing.categoryId });
  if (cd.unresolved.length) return { ok: false, error: 'could not resolve eBay condition descriptor id(s): ' + cd.unresolved.join(', ') + ' — retry when eBay Metadata is reachable', validation: v };

  // images: if the owner uploaded real photos for this card (played cards), those REPLACE the stock
  // CDN art (eBay bans stock photos on used items). Otherwise download the card art → EPS. Either way
  // the generic trailing image is appended last.
  const photoRows = db.prepare(`SELECT eps_url, compose_version FROM listing_images WHERE item_id = ? AND kind IN ('front','back','blemish','slab') AND eps_url IS NOT NULL ORDER BY sort_order, id`).all(item.id);
  const photoEps = photoRows.map((r) => r.eps_url).filter(Boolean);
  let img;
  if (photoEps.length) {
    // Owner photos are branded at UPLOAD time (POST /photos), not here — by now they are finished
    // EPS urls. Flag the ones built against older rail art so the owner can recompose deliberately;
    // never block on it, because an older frame is dated, not wrong (GR7).
    const want = expectedComposeVersion(merged);
    const stale = [...new Set(photoRows.map((r) => r.compose_version).filter((v) => v && want && v !== want))];
    if (stale.length) v.warnings.push(`photos were branded with ${stale.join(', ')} (current ${want}) — recompose to refresh`);
    const generic = await ensureGenericImage(env, cfg, saveCfg, db);
    img = { imageUrls: [...photoEps, ...(generic ? [generic] : [])], warnings: [], hero: photoEps[0] };
  } else {
    const sources = (listing.imageUrls || []).map((u) => ({ url: u, kind: 'card' })).concat((photoPaths || []).map((path) => ({ path, kind: 'front' })));
    // The explicit argument wins; a per-row `compose` inside overrides is the batch path's channel.
    const decision = compose != null ? compose : (overrides.compose != null ? overrides.compose : null);
    img = await buildOfferImageUrls(env, { db, itemId: item.id, sources, cfg, saveCfg, compose: composeContext(merged, decision, { path: 'catalogArt' }) });
  }
  if (!img.imageUrls.length) return { ok: false, error: 'no listable image (all uploads failed): ' + (img.warnings.join('; ') || 'none'), validation: v };

  // The description embeds the hero image, so it can only be finalised AFTER the EPS upload —
  // toEbayListing necessarily runs before a byte is hosted. eBay-hosted beats the source CDN (EPS
  // lives as long as the listing), and an owner photo wins over the stock scan on a played card.
  if (img.hero) {
    // The description's masthead wants the set's own logo + symbol, and its art block wants the
    // CARD rather than the branded composite — composeMetaFor already resolves all three, per
    // language, so the description and the rail cannot disagree about which set this is.
    const dmeta = composeMetaFor(merged);
    listing.descriptionHtml = buildItemDescription(merged, {
      imageUrl: img.hero,
      // Owner photos ARE the item, so they stay the art. Otherwise prefer the un-composed catalog
      // source over the hero, which is the composite whenever branding is on.
      artUrl: photoEps.length ? null : (listing.imageUrls && listing.imageUrls[0]) || null,
      setLogoUrl: dmeta.setLogoUrl,
      setSymbolUrl: dmeta.setSymbolUrl,
      // Same band table the offer resolved from — a re-render that picked a different band would
      // quote an amount the pinned policy does not charge.
      shipping: cfg.shipping,
    });
  }

  const bestOffer = resolveBestOffer(listing.price_cents, bestOfferSpec, cfg);
  if (bestOffer.error) return { ok: false, error: bestOffer.error, validation: v };

  // A staged row carries a provisional STG-* sku; its real shelf label is allocated HERE, on the way
  // to a live listing, and committed further down only if eBay accepts it. eBay keys inventory by
  // SKU and binds the Custom label to a listing for life, so the swap has to happen before the first
  // API call — there is no renaming it afterwards.
  //
  // A dry run deliberately keeps the provisional sku: a canary that consumed a shelf number would
  // reintroduce the exact bug this replaces (previewed, never published, label gone). The cost is a
  // provisional inventory-item record left on eBay, which the real publish tidies up below.
  let pendingLabel = null;
  if (!dryRun && isProvisionalSku(item.sku)) {
    pendingLabel = peekStockLabel(db);
    // Unseeded series => no label to hand out. Listing under the provisional sku would burn the
    // Custom label permanently, so refuse and say what to do (GR7: degrade visibly, never guess).
    if (!pendingLabel) return { ok: false, error: 'the stock label series is not seeded, so there is no shelf label to give ' + item.sku + ' — seed it under Settings → labels before listing staged rows', validation: v };
    listing.sku = pendingLabel.label;
  }

  const existingOfferId = item.ebay_offer_id || (db.prepare('SELECT offer_id FROM ebay_listings WHERE sku = ? AND marketplace = ?').get(item.sku, cfg.marketplaceId) || {}).offer_id || null;

  const res = await publishListing(env, { listing, cfg, imageUrls: img.imageUrls, conditionDescriptors: cd.descriptors, bestOffer, existingOfferId, dryRun });

  // eBay took it, so the shelf label is really spoken for now: bind it to the row and move the series
  // past it. This sits BEFORE the audit + write-back on purpose — both key off item.sku, and a row
  // that just listed as AAC-097 must not be recorded against the STG-* placeholder it used to carry.
  // A publish that failed above skips all of this, which is the entire point: the series never moves
  // for a card that never listed.
  if (res.ok && !dryRun && pendingLabel) {
    const provisional = item.sku;
    try {
      commitStockLabel(db, item.id, pendingLabel.label, pendingLabel.seq);
      item.sku = pendingLabel.label;
      // The preview's provisional record is a SEPARATE inventory item on eBay's side (they key by
      // SKU), so drop it now the row lives under its real label. Best-effort: a card that is already
      // live must never fail on tidy-up, and eBay refuses to delete anything with a live offer (GR7).
      deleteInventoryItem(env, provisional).catch(() => {});
    } catch (e) {
      // The listing is LIVE under pendingLabel.label but the row still says STG-*. Loud, because the
      // audit row below is then the only record of which label eBay actually bound to it.
      console.warn('[listings] label commit FAILED for ' + provisional + ' — the listing is live as ' + pendingLabel.label + ' but the stock row still holds the placeholder:', e?.message || e);
    }
  }

  // audit every attempt
  try {
    db.prepare(`INSERT INTO listing_pushes (item_id, sku, action, offer_id, listing_id, status, error, request, response)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(
      item.id, item.sku, dryRun ? 'preview' : (res.revised ? 'revise' : 'create'),
      res.offerId || null, res.listingId || null, res.ok ? 'ok' : 'error', res.error || null,
      // The EXACT outbound body, not a summary of it — an audit row that omits what we sent can't
      // explain what eBay rejected. No tokens live in these bodies (GR2).
      JSON.stringify({ title: listing.title, price_cents: listing.price_cents, aspects: listing.aspects, conditionDescriptors: cd.descriptors, descriptorSource: cd.source, imageUrls: img.imageUrls, bestOffer, inventoryItem: res.requestBody || null, offer: res.offerBody || null }),
      JSON.stringify({ offerId: res.offerId, listingId: res.listingId, steps: res.steps, fees: res.fees, error: res.error || null, httpStatus: res.httpStatus || null, requestId: res.requestId || null, rawResponse: res.rawResponse || null }));
  } catch (e) { console.warn('[listings] audit write failed —', e?.message || e); }

  if (res.ok && !dryRun) writeBackListed(db, cfg, item, listing, res, bestOffer);
  return { ...res, sku: item.sku, itemId: item.id, title: listing.title, price_cents: listing.price_cents, imageUrls: img.imageUrls, imageWarnings: img.warnings, aspects: listing.aspects, descriptionHtml: listing.descriptionHtml, storeCategoryNames, conditionDescriptors: cd.descriptors, descriptorSource: cd.source, bestOffer, validation: v };
}

// Persist a successful publish onto inventory_items + the ebay_listings mirror (lights up the
// reserved columns; enables the postsale item_id match rung).
function writeBackListed(db, cfg, item, listing, res, bestOffer) {
  const url = res.url || listingUrl(res.listingId, cfg.marketplaceId);
  // What eBay had for this SKU BEFORE this publish. A relist mints a new ItemID and the
  // UNIQUE(sku, marketplace) upsert below overwrites the old one in place — after which the only trace
  // the old listing ever existed is listing_pushes. Anything still pointing at that id (an order line,
  // the post-sale byItemId match rung, a bookmark) would have no way back to the card.
  let superseded = null;
  try {
    const prev = db.prepare('SELECT listing_id FROM ebay_listings WHERE sku = ? AND marketplace = ?').get(item.sku, cfg.marketplaceId);
    if (prev && prev.listing_id && res.listingId && String(prev.listing_id) !== String(res.listingId)) {
      superseded = String(prev.listing_id);
    }
  } catch { /* first publish for this SKU — nothing to supersede */ }
  try {
    db.prepare(`UPDATE inventory_items SET ebay_listing_id = ?, ebay_offer_id = ?, channel_status = 'active', status = CASE WHEN status = 'sold' THEN status ELSE 'listed' END, updated_at = datetime('now') WHERE id = ?`)
      .run(res.listingId || null, res.offerId || null, item.id);
  } catch (e) { console.warn('[listings] inventory write-back failed —', e?.message || e); }
  try {
    db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, game, category_id, price_cents, currency, available_qty, listing_status, best_offer_enabled, auto_accept_cents, auto_decline_cents, listing_url, last_synced_at, raw)
                VALUES (?,?,?,?,?,?,?,?, 'AUD', ?, 'ACTIVE', ?, ?, ?, ?, datetime('now'), ?)
                ON CONFLICT(sku, marketplace) DO UPDATE SET offer_id=excluded.offer_id, listing_id=excluded.listing_id, item_id=excluded.item_id, price_cents=excluded.price_cents, available_qty=excluded.available_qty, listing_status='ACTIVE', best_offer_enabled=excluded.best_offer_enabled, auto_accept_cents=excluded.auto_accept_cents, auto_decline_cents=excluded.auto_decline_cents, listing_url=excluded.listing_url, last_synced_at=datetime('now'), updated_at=datetime('now')`)
      .run(item.sku, cfg.marketplaceId, res.offerId || null, res.listingId || null, item.id, item.game, listing.categoryId, listing.price_cents,
        listing.quantity, bestOffer.enabled ? 1 : 0, bestOffer.autoAcceptCents ?? null, bestOffer.autoDeclineCents ?? null, url);
  } catch (e) { console.warn('[listings] mirror write failed —', e?.message || e); }
  // listing_pushes is the durable chain — it survives the upsert above, which has already overwritten
  // listing_id in place. Same record shape lib/relist-watch.mjs writes when eBay does the relisting.
  if (superseded) {
    try {
      db.prepare(`INSERT INTO listing_pushes (item_id, sku, action, offer_id, listing_id, status, response)
                  VALUES (?,?,'relist',?,?, 'ok', ?)`)
        .run(item.id, item.sku, res.offerId || null, res.listingId || null,
          JSON.stringify({ from: superseded, to: res.listingId, reason: 'republish' }));
    } catch (e) { console.warn('[listings] supersession record failed —', e?.message || e); }
  }
}

// ---------------------------------------------------------------------------
// BATCH PUBLISH (Phase 2) — the Runner's many-listings-at-once path.
// ---------------------------------------------------------------------------
// A loop, not a second pipeline: every row goes through runPublish UNCHANGED, in the per-row
// try/catch shape already used by runSealedRefresh (lib/sealed.mjs), linkMirrorListings and
// importSellerListings — one bad row never aborts the run.
//
// NO inter-row sleep. runSealedRefresh sleeps 1500ms because it scrapes PriceCharting, which has no
// rate-limit contract; publishing has one and lib/ebay-rest.mjs already serialises every Sell-API
// call app-wide at 120ms + jitter while honouring Retry-After. A second gate here would only make a
// 100-card run twice as slow for nothing.
const BATCH_MAX = 500;   // runaway guard, far above any real batch — not a product limit

// A list of inventory ids from a query string or a JSON array. Ids are AUTOINCREMENT from 1, so a
// valid one is always a positive integer; everything else is dropped. Note `+'' === 0` and
// `Number.isFinite(0)` is true, so a plain finite check would turn `?item_ids=` into a request for
// item 0 and answer 200 with a not-found row instead of rejecting a malformed request.
function parseIdList(v) {
  const parts = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  const out = [];
  for (const x of parts) {
    const n = Number(typeof x === 'string' ? x.trim() : x);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

// Everything the refusals need, in one pass, with zero eBay calls.
function batchRows(db, ids, overridesById) {
  const out = [];
  for (const id of ids) {
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    if (!item) { out.push({ id, missing: true }); continue; }
    const ov = (overridesById && overridesById[id]) || {};
    const priceCents = ov.price_cents != null ? Math.round(+ov.price_cents) : item.target_price_cents;
    const photos = (db.prepare(`SELECT COUNT(*) n FROM listing_images WHERE item_id = ?
      AND kind IN ('front','back','blemish','slab') AND eps_url IS NOT NULL`).get(id) || {}).n || 0;
    out.push({
      id, item, overrides: pickOverrides(ov), priceCents, hasOwnerPhotos: photos > 0,
      // The three dimensions the outbound payload actually varies on (aspects + condition
      // descriptors follow them) — what pickCanaries samples across.
      finish: ov.finish || item.variant || '', language: item.language || 'EN',
      condition: item.condition || '', graded: !!item.grading_company,
    });
  }
  return out;
}
function refusalInput(r) {
  return { priceCents: r.priceCents, condition: r.item.condition, graded: !!r.item.grading_company, hasOwnerPhotos: r.hasOwnerPhotos };
}
// A refused / skipped row still gets an audit row. 'skipped' is a value db.mjs:526 already
// documents, and a batch that silently declined half its rows is not something you can reconstruct
// later from an empty table.
function auditSkip(db, r, status, note) {
  try {
    db.prepare(`INSERT INTO listing_pushes (item_id, sku, action, status, error, request, response)
                VALUES (?,?,?,?,?,?,?)`)
      .run(r.id, r.item ? r.item.sku : null, 'publish', status, note, JSON.stringify({ batch: true, price_cents: r.priceCents }), null);
  } catch (e) { console.warn('[listings] batch audit write failed —', e?.message || e); }
}

// The free pre-flight: build + validate every row locally. Zero eBay calls, so it can gate the
// publish button without costing anything — the same pass lib/bulk.mjs runs before a CSV export.
export function batchPreflight(db, cfg, { itemIds, overridesById = {}, releasedIds = [] }) {
  const released = new Set((releasedIds || []).map(Number));
  const rows = batchRows(db, itemIds, overridesById);
  const medianCents = medianOf(rows.filter((r) => !r.missing).map((r) => r.priceCents));
  const out = rows.map((r) => {
    if (r.missing) return { item_id: r.id, ok: false, errors: ['inventory item ' + r.id + ' not found'], warnings: [], refusals: [] };
    const refusals = blockingRefusals(refuseRow(refusalInput(r), medianCents), released.has(r.id));
    const built = itemToListing(db, r.id, r.overrides);
    if (built.error) return { item_id: r.id, sku: r.item.sku, ok: false, errors: [built.error], warnings: [], refusals };
    const v = validateListing(built.listing, loadEbayCategories());
    const storeCategoryNames = resolveStoreCategoryNames(built.listing, cfg);
    const warnings = [...v.warnings];
    if (!storeCategoryNames.length) warnings.push('no eBay store department — this listing will be filed under “Other”');
    const alreadyLive = !!(r.item.ebay_listing_id && r.item.channel_status === 'active');
    return {
      item_id: r.id, sku: r.item.sku, name: r.item.name, title: built.listing.title,
      price_cents: r.priceCents, already_live: alreadyLive, store_categories: storeCategoryNames,
      ok: !v.errors.length && !refusals.length, errors: v.errors, warnings, refusals,
    };
  });
  return {
    median_cents: Math.round(medianCents),
    total: out.length,
    publishable: out.filter((r) => r.ok && !r.already_live).length,
    blocked: out.filter((r) => !r.ok).length,
    already_live: out.filter((r) => r.already_live).length,
    rows: out,
  };
}

// Which rows are worth a REAL dry run. Deliberately a handful, never the whole batch: a
// runPublish(dryRun:true) still PUTs a real inventory item, creates a real offer and uploads every
// image to EPS (ebay-inventory-api.mjs:218-243) — only publishOffer is skipped. There is no
// deleteOffer anywhere in lib/channels/, so each one leaves an unpublished offer on the account
// that nothing in this repo can remove. Four is acceptable litter for finding out that eBay hates
// your payload; a hundred is not.
//
// The pick: the first row, the dearest, then one per distinct finish × language × condition, which
// is where the payload actually varies (aspects and condition descriptors follow those three).
export function pickCanaries(rows, max = 4) {
  const live = (rows || []).filter((r) => r && !r.missing);
  if (!live.length) return [];
  const sig = (r) => [r.finish || '', r.language || '', r.condition || '', r.graded ? 'G' : ''].join('|');
  const out = [], seen = new Set();
  const take = (r) => {
    if (!r || out.length >= max || out.includes(r)) return;
    out.push(r); seen.add(sig(r));
  };
  take(live[0]);
  take(live.reduce((a, r) => ((r.priceCents || 0) > (a ? (a.priceCents || 0) : -1) ? r : a), null));
  for (const r of live) { if (!seen.has(sig(r))) take(r); }
  return out;
}

// Rows in this batch that still need publishing. DERIVED on every call, never stored: a saved
// cursor goes stale the moment the 30-minute reconcile job marks something ended, or the moment a
// Vite restart kills a run. Re-open the queue, press Publish, it picks up where it left off.
//
// Correctness does not depend on this — publishListing is idempotent on SKU (createOrReplaceInventoryItem
// is a full PUT, the offer is find-or-create, publishing an already-published offer is a revise), so
// the worst a re-run can do is a no-op revise. This just saves the round trips.
export function pendingBatchIds(db, ids) {
  const out = [];
  for (const id of parseIdList(ids)) {
    const it = db.prepare('SELECT ebay_listing_id, channel_status FROM inventory_items WHERE id = ?').get(id);
    if (!it) continue;                                                    // gone — nothing to publish
    if (it.ebay_listing_id && it.channel_status === 'active') continue;   // already live
    out.push(id);
  }
  return out;
}

// listing_pushes stores the exact request AND eBay's exact reply on every attempt, which is what
// makes a bad day diagnosable — and what makes the table grow without bound once batches are the
// normal way to list. Pruned by age after a run, which is a natural low-frequency trigger.
export function pruneListingPushes(db, days = 90) {
  try {
    const r = db.prepare(`DELETE FROM listing_pushes WHERE ts < datetime('now', ?)`).run('-' + Math.max(1, days | 0) + ' days');
    if (r.changes) console.log('[listings] pruned ' + r.changes + ' listing_pushes row(s) older than ' + days + ' days');
    return r.changes || 0;
  } catch (e) { console.warn('[listings] push prune failed —', e?.message || e); return 0; }
}

// Publish a whole batch, emitting one NDJSON record per row as it lands.
export async function runBatchPublish(env, db, cfg, saveCfg, { itemIds, overridesById = {}, bestOfferSpec, releasedIds = [], compose = null, emit, shouldCancel }) {
  const released = new Set((releasedIds || []).map(Number));
  const rows = batchRows(db, itemIds, overridesById);
  // The batch's own median, computed server-side from the prices actually about to be sent — not
  // whatever the client believed. That is the point of re-checking it here.
  const medianCents = medianOf(rows.filter((r) => !r.missing).map((r) => r.priceCents));
  const stats = { total: rows.length, listed: 0, refused: 0, failed: 0, skipped: 0 };
  const itemIdsDone = [];
  let aborted = null, cancelled = false;

  emit({ start: { total: rows.length, median_cents: Math.round(medianCents) } });

  for (const r of rows) {
    // The ONLY safe cancellation point is between rows. There is no way to un-send publishOffer,
    // and stopping between createOffer and publishOffer would strand an offer that nothing in this
    // repo can delete — so a cancel finishes the card in hand and then stops.
    if (!aborted && !cancelled && shouldCancel && shouldCancel()) { cancelled = true; aborted = 'cancelled by you'; }
    if (aborted) { stats.skipped++; emit({ row: { item_id: r.id, sku: r.item ? r.item.sku : null, status: 'skipped', error: 'batch stopped: ' + aborted } }); continue; }
    if (r.missing) { stats.failed++; emit({ row: { item_id: r.id, status: 'failed', error: 'inventory item ' + r.id + ' not found' } }); continue; }

    const name = r.item.name;
    // Already live and active: default-skip. Correctness does not depend on this — publishListing is
    // idempotent on SKU, so a re-run is a no-op revise at worst — but re-sending it would burn an
    // eBay round trip per row on every resumed batch.
    if (r.item.ebay_listing_id && r.item.channel_status === 'active') {
      stats.skipped++; auditSkip(db, r, 'skipped', 'already live on eBay');
      emit({ row: { item_id: r.id, sku: r.item.sku, name, status: 'skipped', error: 'already live on eBay' } });
      continue;
    }

    const refusals = blockingRefusals(refuseRow(refusalInput(r), medianCents), released.has(r.id));
    if (refusals.length) {
      stats.refused++; auditSkip(db, r, 'skipped', refusals.map((x) => x.code).join(', '));
      emit({ row: { item_id: r.id, sku: r.item.sku, name, status: 'refused', refusals } });
      continue;
    }

    try {
      const out = await runPublish(env, db, cfg, saveCfg, {
        itemId: r.id, overrides: r.overrides, bestOfferSpec, dryRun: false,
        // Per-row beats the batch-level pick, which beats the config default.
        compose: r.overrides && r.overrides.compose != null ? !!r.overrides.compose : compose,
      });
      if (out.ok) {
        stats.listed++; itemIdsDone.push(r.id);
        emit({ row: { item_id: r.id, sku: out.sku, name, status: 'live', listing_id: out.listingId, url: out.url } });
      } else {
        stats.failed++;
        // An unresolved condition descriptor is ENVIRONMENTAL (eBay Metadata unreachable), not a
        // property of this row — grinding out the same failure 99 more times helps nobody, and every
        // one of them costs a round trip. Stop and say so.
        if (/could not resolve ebay condition descriptor/i.test(String(out.error || ''))) aborted = out.error;
        emit({ row: { item_id: r.id, sku: r.item.sku, name, status: 'failed', error: out.error, steps: out.steps || null, httpStatus: out.httpStatus || null, requestId: out.requestId || null, rawResponse: out.rawResponse || null } });
      }
    } catch (e) {
      // Per-row try/catch: one exploding row never takes the rest of the batch with it (GR7).
      stats.failed++;
      emit({ row: { item_id: r.id, sku: r.item.sku, name, status: 'failed', error: String(e?.message || e) } });
    }
  }

  // The run-level audit. channel_exports was pre-declared for exactly this (db.mjs:259/265 —
  // channel 'ebay-inventory-api', artifact_path null for API pushes, result = the job results) and
  // until now only ever saw 'ebay-csv'.
  try {
    db.prepare(`INSERT INTO channel_exports (channel, shape, marketplace, item_ids, artifact_path, result)
                VALUES ('ebay-inventory-api', 'per_card', ?, ?, NULL, ?)`)
      .run(cfg.marketplaceId || 'EBAY_AU', JSON.stringify(itemIdsDone), JSON.stringify({ ...stats, aborted: aborted || null }));
  } catch (e) { console.warn('[listings] batch export audit failed —', e?.message || e); }

  pruneListingPushes(db, (cfg && cfg.auditRetentionDays) || 90);

  emit({ summary: { ...stats, aborted: aborted || null, cancelled, median_cents: Math.round(medianCents) } });
  return { ...stats, aborted: aborted || null, cancelled };
}

// ---------------------------------------------------------------------------
// THE DETACHED JOB (Phase 4)
// ---------------------------------------------------------------------------
// A hundred-card run takes minutes. Holding it inside one HTTP request meant a closed tab, a lost
// connection or a Vite restart (which this repo's own notes say to expect mid-session) stopped it.
// The run now lives on globalThis — HMR-safe, same reason startReconcileJob keeps its timers there —
// and the request is only a VIEW onto it.
//
// State shape mirrors getReconcileState/getSealedRefreshState so /api/status can show it like every
// other background worker.
const RING_MAX = 2000;   // 500-row cap × ~1 event each, plus start/summary — replay never truncates a real run
const JOB = globalThis.__listingsBatchJob || (globalThis.__listingsBatchJob = {
  id: null, running: false, cancel_requested: false,
  started_at: null, finished_at: null,
  total: 0, listed: 0, refused: 0, failed: 0, skipped: 0, aborted: null, cancelled: false, median_cents: 0,
  events: [], seq: 0, waiters: [],
});

function jobWake() { const w = JOB.waiters.splice(0); for (const f of w) { try { f(); } catch {} } }

// One place that both records an event and keeps the counters honest, so runBatchPublish needs no
// knowledge of the job wrapper at all.
function jobEmit(obj) {
  const rec = { seq: ++JOB.seq, ...obj };
  JOB.events.push(rec);
  if (JOB.events.length > RING_MAX) JOB.events.splice(0, JOB.events.length - RING_MAX);
  if (obj.start) { JOB.total = obj.start.total || 0; JOB.median_cents = obj.start.median_cents || 0; }
  else if (obj.row) {
    const s = obj.row.status;
    if (s === 'live') JOB.listed++;
    else if (s === 'refused') JOB.refused++;
    else if (s === 'skipped') JOB.skipped++;
    else JOB.failed++;
  } else if (obj.summary) { Object.assign(JOB, { aborted: obj.summary.aborted || null, cancelled: !!obj.summary.cancelled }); }
  jobWake();
  return rec;
}

export function getBatchJobState() {
  const { id, running, cancel_requested, started_at, finished_at, total, listed, refused, failed, skipped, aborted, cancelled, median_cents, seq } = JOB;
  return { id, running, cancel_requested, started_at, finished_at, total, listed, refused, failed, skipped, aborted, cancelled, median_cents, seq };
}
export function cancelBatchJob(id) {
  if (!JOB.running || (id && id !== JOB.id)) return { ok: false, error: 'no such run is in progress', code: 'not_running' };
  JOB.cancel_requested = true;
  jobWake();
  // Honest wording: the card already in flight finishes. See the cancellation note in runBatchPublish.
  return { ok: true, id: JOB.id, message: 'stopping after the current card' };
}

// Start a run. Returns immediately; the work continues whatever the browser does.
export function startBatchJob(env, db, cfg, saveCfg, opts) {
  if (JOB.running) return { ok: false, code: 'job_running', id: JOB.id, error: 'a batch is already running — attach to it instead of starting a second one' };
  JOB.id = 'b' + Date.now().toString(36);
  JOB.running = true; JOB.cancel_requested = false; JOB.cancelled = false; JOB.aborted = null;
  JOB.started_at = new Date().toISOString(); JOB.finished_at = null;
  JOB.total = JOB.listed = JOB.refused = JOB.failed = JOB.skipped = JOB.median_cents = 0;
  JOB.events = []; JOB.seq = 0;
  runBatchPublish(env, db, cfg, saveCfg, { ...opts, emit: jobEmit, shouldCancel: () => JOB.cancel_requested })
    .catch((e) => {
      console.error('[listings] batch job failed —', e?.message || e);
      jobEmit({ summary: { total: JOB.total, listed: JOB.listed, refused: JOB.refused, failed: JOB.failed, skipped: JOB.skipped, aborted: String(e?.message || e) } });
    })
    .finally(() => { JOB.running = false; JOB.finished_at = new Date().toISOString(); jobWake(); });
  return { ok: true, id: JOB.id };
}

// Stream a job's events to one response: replay everything after `fromSeq` out of the ring buffer,
// then follow live until it finishes. Several viewers can attach at once, and none of them owns the
// run — closing the tab drops the view, not the work.
export async function followBatchJob(write, fromSeq, isClosed) {
  let cursor = Math.max(0, fromSeq | 0);
  for (;;) {
    if (isClosed && isClosed()) return;
    const pending = JOB.events.filter((e) => e.seq > cursor);
    for (const e of pending) { write(e); cursor = e.seq; }
    if (!JOB.running && !JOB.events.some((e) => e.seq > cursor)) return;
    // Woken by jobEmit, or by the timeout — the timeout is what stops a finished-but-unnoticed run
    // from parking a viewer forever.
    await new Promise((resolve) => { JOB.waiters.push(resolve); setTimeout(resolve, 1000); });
  }
}

// Read the seller username to exclude from comps (so we never price a card off our own listing).
function ownSeller() {
  try { return JSON.parse(fs.readFileSync(configFile('repricer.config.json'), 'utf8')).exclude_seller_username || null; }
  catch { return null; }
}
const LANG_DATA = { EN: 'en', JP: 'ja', JA: 'ja', ZH: 'zh-cn', CN: 'zh-cn', KO: 'ko' };
// Derive a foil/nonfoil hint from a card's finish/variant so comps don't mix foil + non-foil prices.
function finishHint(s) {
  const t = String(s || '').toLowerCase();
  if (/non[\s-]?foil|non[\s-]?holo/.test(t)) return 'nonfoil';
  if (/holo|foil|reverse|etched|rainbow/.test(t)) return 'foil';
  return null;
}
// The comps query and its number filter now live in lib/stock-games.mjs beside the other per-game
// facts (the browser needs the same query for its ↗ links). Re-exported here because this is where
// every existing caller and test looks for it.
export { compsQueryFor, compsNumberMatch };

// Suggest a price for one item (or inline row) from eBay AU singles comps. Returns the full analysis.
async function priceItem(env, db, base, input) {
  const it = input.itemId != null ? db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(+input.itemId) : input.row;
  if (!it) return { error: 'item not found' };
  const number = it.number != null ? String(it.number) : '';
  const query = (input.query || compsQueryFor(it.game, it, number)).trim();
  const graded = !!(it.graded || it.grading_company);
  const comps = await singlesEbayValue({
    // numberMatch has to agree with the QUERY, and for Magic the query deliberately has no number in
    // it. singlesFilter hard-rejects any title the number regex misses, so passing one anyway meant
    // the server asked for a cluster it then threw away wholesale — every Magic row priced at
    // "no confident comps". compsNumberMatch is the one place that agreement is stated.
    base, query, numberMatch: compsNumberMatch(it.game, number),
    lang: LANG_DATA[String(it.language || 'EN').toUpperCase()] || 'en',
    finish: finishHint(it.finish || it.variant), excludeSeller: ownSeller(), graded,
  });
  const out = { query, graded, comps };
  if (comps.matched) {
    const listCents = Math.round(comps.recommended * 100);
    const fee = feeAU(comps.recommended);                    // buyer-protection fee band (indicative)
    out.recommended_cents = listCents;
    out.confidence = comps.confidence;
    out.reliable = comps.reliable;
    out.fee_aud = Math.round(fee * 100) / 100;
    out.buyer_total_aud = totalFromList(comps.recommended);  // what the buyer pays incl. protection fee
  }
  return out;
}

// reviseTradingListing — change price and/or available quantity on a HAND-MADE eBay listing.
//
// This is the only route to those listings: the Sell Inventory API cannot see a Trading-model listing
// at all (eBay KB 5210), so publishListing/updateOffer are not options. It is also the most dangerous
// call in the app — a wrong price sells a A$2500 card for A$25, and a wrong quantity oversells stock
// that does not exist — so the guards below matter more than the call does.
//
// Shape: PREFLIGHT from eBay → refuse or write → VERIFY from eBay. The mirror is never the basis for
// a write; it is only as fresh as the last import, and a sale in between would make the quantity
// wrong. Every number that goes out is computed from what eBay said seconds earlier.
export const PRICE_SANITY_MULTIPLE = 5;      // a >5x move either way needs `force` — fat-finger catcher

export async function reviseTradingListing(env, db, { listingId, priceCents, availableQty, force = false, expectPriceCents = null, bestOffer = 'leave' } = {}) {
  const id = String(listingId || '').trim();
  const refuse = (why, extra) => ({ ok: false, refused: true, error: why, ...extra });
  if (!id) return refuse('no listing id');
  if (priceCents == null && availableQty == null) return refuse('nothing to change — pass a price, a quantity, or both');

  const row = db.prepare('SELECT * FROM ebay_seller_listings WHERE listing_id = ?').get(id);
  if (!row) return refuse('that listing is not in the mirror — run an import first');
  // created_via 'tool' means we published it through the Sell Inventory API, and eBay states those
  // "cannot be revised using the ReviseFixedPriceItem, ReviseItem, or ReviseInventoryStatus calls".
  // This is routing, not just safety: those go through publishListing instead.
  if (row.created_via === 'tool') {
    return refuse('this listing was published by the tool, so it is revised through the Inventory API, not Trading', { code: 'wrong_api' });
  }

  if (availableQty != null) {
    const q = Math.floor(availableQty);
    if (!(q >= 0)) return refuse('quantity must be zero or more');
    // eBay rejects 0 on a normal listing ("The quantity should be greater than 0 for an active item").
    // Ending a listing is a different call (EndFixedPriceItem) that mints a NEW ItemID on relist, so
    // it is deliberately not wired into a "revise" path.
    if (q === 0) return refuse('eBay will not accept a quantity of 0 here — end the listing on eBay instead', { code: 'qty_zero' });
  }

  // PREFLIGHT — what is true on eBay right now.
  const live = await getListingState(env, id);
  if (!live.ok) return { ok: false, error: 'could not read the listing from eBay: ' + live.error };
  if (live.listing_type && live.listing_type !== 'FixedPriceItem') {
    return refuse('ReviseInventoryStatus only works on fixed-price listings (this one is ' + live.listing_type + ')', { code: 'not_fixed_price' });
  }
  if (live.listing_status && live.listing_status !== 'Active') {
    return refuse('that listing is ' + live.listing_status + ' on eBay, so there is nothing to revise', { code: 'not_active' });
  }
  // An approve-then-apply flow can leave a decision sitting for hours. When the caller says what the
  // price WAS when that decision was made, refuse if eBay no longer agrees — applying the old target
  // would silently undo whatever changed in between. Checked here, inside the preflight, so there is
  // no window between reading the price and writing over it.
  if (expectPriceCents != null && live.price_cents !== Math.round(expectPriceCents)) {
    return refuse('the price moved after this was proposed: it was A$' + (Math.round(expectPriceCents) / 100).toFixed(2)
      + ' and eBay now says A$' + ((live.price_cents || 0) / 100).toFixed(2) + '. Propose again from the current price.',
      { code: 'price_moved', currentPriceCents: live.price_cents });
  }
  if (availableQty != null && live.sold_qty && Math.floor(availableQty) < 0) {
    return refuse('quantity cannot go below zero');
  }
  if (priceCents != null && live.price_cents && !force) {
    const hi = live.price_cents * PRICE_SANITY_MULTIPLE, lo = live.price_cents / PRICE_SANITY_MULTIPLE;
    if (priceCents > hi || priceCents < lo) {
      return refuse('that price is more than ' + PRICE_SANITY_MULTIPLE + '× away from the current A$'
        + (live.price_cents / 100).toFixed(2) + ' — send force:true if you mean it', { code: 'price_sanity', currentPriceCents: live.price_cents });
    }
  }

  const before = {
    price_cents: live.price_cents, available_qty: live.available_qty, sold_qty: live.sold_qty,
    best_offer_auto_accept_cents: live.best_offer_auto_accept_cents, best_offer_min_cents: live.best_offer_min_cents,
  };

  // PHASE 5 — should the Best Offer floors move with the price?
  //
  // Auto-accept is an absolute amount, so a raise that leaves it alone silently deepens the discount
  // the owner agreed to. Scaled from the PREFLIGHT numbers, never the mirror: the mirror does not
  // carry them at all, and they are the whole reason for taking the riskier call.
  const scaled = bestOffer === 'scale' && priceCents != null
    ? scaleBestOfferCents({
      fromPriceCents: live.price_cents, toPriceCents: priceCents,
      autoAcceptCents: live.best_offer_auto_accept_cents, minOfferCents: live.best_offer_min_cents,
    })
    : { autoAcceptCents: null, minOfferCents: null };
  const movingFloors = scaled.autoAcceptCents != null || scaled.minOfferCents != null;

  // ReviseInventoryStatus cannot express Best Offer terms at all, so a floor move has to go through
  // ReviseFixedPriceItem. Everything else stays on the lighter call that four phases of testing has
  // been done against.
  const inner = movingFloors
    ? buildReviseFixedPriceItemInner({ itemId: id, priceCents, autoAcceptCents: scaled.autoAcceptCents, minOfferCents: scaled.minOfferCents })
    : buildReviseInventoryStatusInner({ itemId: id, priceCents, availableQty });
  const res = await tradingCall(env, movingFloors ? 'ReviseFixedPriceItem' : 'ReviseInventoryStatus', inner);
  // Warning 21917091 ("revision is redundant") means the value already matched — a no-op, not a
  // failure. tradingCall already treats Ack=Warning as ok; this keeps the message out of the error.
  if (!res.ok) {
    const e = (res.errors && res.errors[0]) || {};
    return { ok: false, error: 'eBay refused the revision: ' + (e.longMessage || e.shortMessage || 'HTTP ' + res.httpStatus), errors: res.errors };
  }

  // VERIFY — read it back rather than assuming our request took effect verbatim.
  const after = await getListingState(env, id);

  // …and for a floor move, verifying is not a formality. eBay's failure mode for a field it does not
  // want in this container is to ACCEPT the call and ignore the field, which would leave exactly the
  // widened discount this whole path exists to prevent — and leave it silently. If the floor did not
  // land, put the price back where it was and report a refusal rather than bank a half-applied write.
  if (movingFloors && after.ok && scaled.autoAcceptCents != null
      && after.best_offer_auto_accept_cents !== scaled.autoAcceptCents) {
    const back = await tradingCall(env, 'ReviseInventoryStatus',
      buildReviseInventoryStatusInner({ itemId: id, priceCents: live.price_cents }));
    return refuse('eBay took the new price but not the Best Offer floor — it still auto-accepts A$'
      + ((after.best_offer_auto_accept_cents || 0) / 100).toFixed(2) + ' against a A$' + (priceCents / 100).toFixed(2)
      + ' listing, which is a deeper discount than you agreed to. '
      + (back.ok ? 'The price has been put back to A$' + (live.price_cents / 100).toFixed(2) + '.'
        : 'REVERTING THE PRICE ALSO FAILED — fix this listing in Seller Hub.'),
      { code: 'best_offer_floor_not_applied', reverted: back.ok, currentPriceCents: back.ok ? live.price_cents : priceCents });
  }
  if (after.ok) {
    db.prepare(`UPDATE ebay_seller_listings SET price_cents = ?, quantity = ?, available_qty = ?, sold_qty = ?,
                listing_type = COALESCE(?, listing_type), last_seen_at = datetime('now') WHERE listing_id = ?`)
      .run(after.price_cents, after.quantity_total, after.available_qty, after.sold_qty, after.listing_type, id);
    // Keep the linked stock row honest too — the shelf count is the point of changing quantity.
    if (row.item_id && after.available_qty != null) {
      db.prepare(`UPDATE inventory_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(after.available_qty, row.item_id);
    }
  }
  return {
    ok: true, listing_id: id, before,
    after: after.ok ? {
      price_cents: after.price_cents, available_qty: after.available_qty, sold_qty: after.sold_qty,
      best_offer_auto_accept_cents: after.best_offer_auto_accept_cents, best_offer_min_cents: after.best_offer_min_cents,
    } : null,
    verified: after.ok,
    bestOfferMoved: movingFloors ? { from: live.best_offer_auto_accept_cents, to: scaled.autoAcceptCents } : null,
    warnings: (res.errors || []).filter((e) => e.severity === 'Warning' || e.severity === 'warning').map((e) => e.longMessage || e.shortMessage),
  };
}

// pushListingSpecifics — put the tool's generated item specifics onto a HAND-MADE listing.
//
// ItemSpecifics is a COMPLETE REPLACE on eBay's side: "all newly input Item Specifics will replace
// all existing Item Specific values, regardless of if the values changed", and there is no way to
// delete a single pair. So this reads what is there, MERGES ours over it, and sends the union —
// sending only our names would silently delete everything the seller typed by hand.
//
// Two hard rules follow from that:
//   1. If the read fails, ABORT. An empty read must never be mistaken for "nothing to preserve".
//   2. Catalog-sourced pairs (Source=Product) are carried through untouched.
// Uses ReviseItem, not ReviseFixedPriceItem, because only ReviseItem supports VerifyOnly — a real
// dry run that validates the whole payload without persisting anything.
export async function pushListingSpecifics(env, db, { listingId, dryRun = true } = {}) {
  const id = String(listingId || '').trim();
  const refuse = (why, extra) => ({ ok: false, refused: true, error: why, ...extra });
  const row = db.prepare('SELECT * FROM ebay_seller_listings WHERE listing_id = ?').get(id);
  if (!row) return refuse('that listing is not in the mirror — run an import first');
  if (row.created_via === 'tool') return refuse('this listing was published by the tool — republish it from the uploader instead', { code: 'wrong_api' });
  if (row.state !== 'active') return refuse('only an active listing can be revised');
  // The specifics come from the CARD, so the listing has to be linked to one first.
  if (!row.item_id) return refuse('link this listing to a card first (Match eBay Listings), so there is something to generate specifics from', { code: 'unlinked' });

  const built = itemToListing(db, row.item_id, {});
  if (built.error) return refuse('could not build the card: ' + built.error);
  const ours = built.listing.aspects || {};
  if (!Object.keys(ours).length) return refuse('no item specifics could be generated for that card');

  const current = await getItemSpecifics(env, id);
  if (!current.ok) return { ok: false, error: 'could not read the listing\'s current specifics, so nothing was changed: ' + current.error };

  const merged = mergeItemSpecifics(current.specifics, ours);
  const beforeByName = new Map(current.specifics.map((s) => [s.name.toLowerCase(), s.values.join(', ')]));
  const changes = merged.specifics.map((s) => {
    const was = beforeByName.get(s.name.toLowerCase());
    const now = s.values.join(', ');
    return { name: s.name, was: was ?? null, now, state: was == null ? 'added' : (was === now ? 'unchanged' : 'changed'), from: s.note };
  });

  const res = await reviseItemSpecifics(env, { itemId: id, specifics: merged.specifics, verifyOnly: dryRun });
  return {
    ok: res.ok, dryRun, listing_id: id,
    error: res.error, staleValue: res.staleValue,
    before: current.specifics.length, after: merged.specifics.length, dropped: merged.dropped,
    changes,
    note: dryRun
      ? 'Checked with eBay, nothing saved. VerifyOnly validates the whole payload without persisting.'
      : null,
  };
}

// linkMirrorListings — attach confirmed mirror rows to stock. Links to a named row when the caller
// supplies one, otherwise reads the card identity out of the listing title and creates a stock row
// from the listing itself. Exported (rather than living inline in the route) because this writes
// inventory: the version that lived in the route shipped a bug — SQLite reads a double-quoted empty
// string as an IDENTIFIER, so every create threw and the UI reported a partial success.
// Never invents an identity: a listing whose title cannot be read is skipped with a reason (GR4).
export function linkMirrorListings(db, links, sets = []) {
  const get = db.prepare('SELECT * FROM ebay_seller_listings WHERE listing_id = ?');
  const out = { linked: 0, created: 0, skipped: [] };
  for (const l of links || []) {
    const row = get.get(String((l && l.listing_id) || ''));
    if (!row) { out.skipped.push({ listing_id: l && l.listing_id, why: 'not in the mirror' }); continue; }
    try {
    let itemId = l.itemId != null ? +l.itemId : null;
    // The custom label is the physical card's identity, so a stock row already carrying it IS this
    // listing's row — even when that row predates identity_key and has none. Checking the parsed
    // identity first instead threw UNIQUE on inventory_items.sku and aborted the whole batch.
    if (!itemId && row.sku) {
      const byLabel = db.prepare('SELECT id, identity_key FROM inventory_items WHERE sku = ? LIMIT 1').get(row.sku);
      if (byLabel) {
        itemId = byLabel.id;
        if (!byLabel.identity_key) {
          const guess = String(l.identity_key || parseCardTitle(row.title || '', { setNames: sets }).identityGuess || '').trim();
          if (guess) db.prepare('UPDATE inventory_items SET identity_key = ?, updated_at = datetime(\'now\') WHERE id = ?').run(guess, itemId);
        }
      }
    }
    if (!itemId) {
      const parsed = parseCardTitle(row.title || '', { setNames: sets });
      const identity = String(l.identity_key || parsed.identityGuess || '').trim();
      if (!identity) { out.skipped.push({ listing_id: row.listing_id, why: 'no card identity' }); continue; }
      const existing = db.prepare("SELECT id FROM inventory_items WHERE identity_key = ? AND COALESCE(sku,'') = ? LIMIT 1")
        .get(identity, row.sku || '');
      if (existing) itemId = existing.id;
      else {
        // The listing IS the evidence: it is on eBay, so the card is (or was) real stock.
        const set = sets.find((s) => s.id === (parsed.setId || '')) || null;
        const r = db.prepare(`INSERT INTO inventory_items
            (game, identity_key, name, set_name, number, variant, language, condition, quantity, status,
             channel_status, ebay_listing_id, sku, grading_company, grade, created_at, updated_at)
            VALUES ('pokemon',?,?,?,?,?,'EN',?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
          .run(identity, parsed.name || row.title || 'Card', set ? set.name : (parsed.setName || null),
            parsed.number || null, parsed.finish || null,
            parsed.graded ? null : (parsed.condition ? 'Ungraded, ' + parsed.condition : null),
            Math.max(1, row.quantity || 1), row.state === 'sold' ? 'sold' : 'in_stock',
            row.state === 'active' ? 'active' : 'ended', row.listing_id,
            row.sku || ('EBAY-' + row.listing_id), parsed.grading_company || null, parsed.grade != null ? parsed.grade : null);
        itemId = Number(r.lastInsertRowid);
        out.created++;
      }
    }
    db.prepare('UPDATE ebay_seller_listings SET item_id = ? WHERE listing_id = ?').run(itemId, row.listing_id);
    out.linked++;
    } catch (e) {
      // One bad row must not abort the batch — the owner ticked 80 listings, not one.
      out.skipped.push({ listing_id: row.listing_id, why: String((e && e.message) || e) });
    }
  }
  return out;
}

// importSellerListings — mirror EVERY listing on the account into ebay_seller_listings, including the
// ones made by hand in Seller Hub. Those are invisible to the Sell Inventory API (eBay KB 5210), so
// reconcileListings can never see them and the catalog only ever knew about listings this tool made.
//
// Read-only against eBay. Keyed on the eBay ItemID rather than the SKU, because a Trading listing's
// Custom label is optional and eBay permits duplicates of it. Where a label DOES match a stock row we
// link it, which is the cheap half of "connect these to actual cards" — resolving a card identity from
// a title is a separate job and deliberately not attempted here.
export async function importSellerListings(env, db, { marketplaceId = 'EBAY_AU' } = {}) {
  const startedAt = new Date().toISOString();
  const r = await getSellerListings(env);
  if (!r.ok) return { ok: false, error: r.error, ...(_import.last_run = { at: startedAt, ok: false, error: r.error }) };

  const sets = enSetList();
  const up = db.prepare(`INSERT INTO ebay_seller_listings
      (listing_id, sku, title, price_cents, currency, quantity, available_qty, sold_qty, listing_type, state, listing_url, created_via, item_id, identity_key, image_url, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(listing_id) DO UPDATE SET
      sku = excluded.sku, title = excluded.title, price_cents = excluded.price_cents,
      currency = excluded.currency, quantity = excluded.quantity, available_qty = excluded.available_qty,
      sold_qty = excluded.sold_qty, listing_type = COALESCE(excluded.listing_type, listing_type),
      state = excluded.state, listing_url = COALESCE(excluded.listing_url, listing_url),
      created_via = excluded.created_via, item_id = COALESCE(excluded.item_id, item_id),
      identity_key = COALESCE(excluded.identity_key, identity_key),
      -- COALESCE, not a plain overwrite: a scan that omits PictureDetails is silence, not "no picture",
      -- and letting it write NULL would throw away a thumbnail we had already paid a GetItem for.
      image_url = COALESCE(excluded.image_url, image_url),
      last_seen_at = datetime('now')`);
  const findItem = db.prepare('SELECT id FROM inventory_items WHERE sku = ? LIMIT 1');
  const isOurs = db.prepare('SELECT 1 FROM ebay_listings WHERE listing_id = ? LIMIT 1');

  let imported = 0, linked = 0, manual = 0;
  for (const row of r.listings) {
    const item = row.sku ? findItem.get(row.sku) : null;
    const ours = isOurs.get(row.listing_id) ? 'tool' : 'manual';
    if (ours === 'manual') manual++;
    if (item) linked++;
    // Best-effort card identity from the title, so the uploader can warn about a duplicate BEFORE
    // eBay refuses it with [25002]. Null when the title cannot be read — never a guess.
    const identity = sets.length ? (parseCardTitle(row.title || '', { setNames: sets }).identityGuess || null) : null;
    up.run(row.listing_id, row.sku, row.title, row.price_cents, row.currency || 'AUD', row.quantity,
      row.available_qty, row.sold_qty || 0, row.listing_type || null, row.state, row.listing_url,
      ours, item ? item.id : null, identity, row.image_url || null);
    imported++;
  }
  // Anything we held as active that this scan did not see at all has ended. Compared by ID, never by
  // timestamp: datetime('now') writes "YYYY-MM-DD HH:MM:SS" and the space sorts BEFORE the "T" in a
  // JS ISO string, so a last_seen_at < startedAt test marks every row we just wrote as ended.
  // Skipped entirely on a truncated scan, where "not seen" only means "not reached".
  let endedRes = { changes: 0 };
  if (!r.truncated) {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _seen_listings (listing_id TEXT PRIMARY KEY)');
    db.exec('DELETE FROM _seen_listings');
    const seen = db.prepare('INSERT OR IGNORE INTO _seen_listings (listing_id) VALUES (?)');
    for (const row of r.listings) seen.run(row.listing_id);
    endedRes = db.prepare(`UPDATE ebay_seller_listings SET state = 'ended'
                           WHERE state = 'active' AND listing_id NOT IN (SELECT listing_id FROM _seen_listings)`).run();
  }

  const state = { at: startedAt, ok: true, imported, manual, linked, ended: endedRes.changes || 0,
    pages: r.pages, truncated: r.truncated, marketplaceId };
  _import.last_run = state;
  return state;
}
let _import = { last_run: null };
export function getImportState() { return _import; }

// resolveMirrorImages — fill in the listing thumbnails the import did not carry, one GetItem each,
// capped per call and fetched in parallel so the page fills in over a couple of loads instead of
// firing a Trading call for every listing in the shop at once. Same shape as resolveImages in
// lib/postsale.mjs, and the same retry rule: only a THROWN failure (no reply at all) is left
// unstamped to come back around. A reply we understood is an answer even when the answer is "no
// picture" or "that item is gone" — stamping those is what stops an old ended listing costing a
// call on every single load, forever. Mutates the rows in place; returns { fetched, pending } so the
// caller can say how many are still to come rather than leaving blanks unexplained.
//
// ACTIVE listings only, and that is where the whole cost sits. GetMyeBaySelling carries
// PictureDetails on the ActiveList but not in SoldList, where the item is nested inside
// OrderTransaction and arrives trimmed — measured on the live shop, every one of 142 active
// listings came back with a picture and none of the 207 sold ones did. So the gap this would spend
// Trading calls on is almost entirely listings that are already over, and a picture is worth a call
// on a card you might still sell, not on one you have sold. Sold rows are not left blank forever
// either: a listing imported while it was active keeps its picture through the sale.
export async function resolveMirrorImages(env, db, rows, max = 24) {
  const need = (rows || []).filter((r) => r && r.listing_id && r.state === 'active' && !r.image_url && !r.image_checked_at);
  const batch = need.slice(0, Math.max(0, max));
  if (!batch.length) return { fetched: 0, pending: 0 };
  const stamp = db.prepare(`UPDATE ebay_seller_listings SET image_url = ?, image_checked_at = datetime('now') WHERE listing_id = ?`);
  let fetched = 0;
  await Promise.all(batch.map(async (r) => {
    try {
      const got = await getItem(env, r.listing_id);
      const url = (got.ok && got.imageUrl) ? got.imageUrl : null;
      stamp.run(url, r.listing_id);
      r.image_url = url;
      r.image_checked_at = new Date().toISOString();
      if (url) fetched++;
    } catch { /* no reply — leave image_checked_at null so the next load tries again */ }
  }));
  return { fetched, pending: Math.max(0, need.length - batch.length) };
}

// reconcileListings — check each of OUR mirrored offers against eBay's live state (the "inventory
// based on eBay" read path). Updates the mirror (listing_status / sold_qty / available_qty); when a
// listing has ENDED or gone OUT_OF_STOCK on eBay, marks the mirror and the inventory item's
// channel_status. Only touches listings we created (offer_id set) — never mass-mutates. Never throws.
export async function reconcileListings(env, db, { marketplaceId = 'EBAY_AU', limit = 200 } = {}) {
  const rows = db.prepare(`SELECT * FROM ebay_listings WHERE offer_id IS NOT NULL AND (listing_status IS NULL OR listing_status NOT IN ('ENDED','EBAY_ENDED')) LIMIT ?`).all(limit);
  let checked = 0, updated = 0, ended = 0, errors = 0;
  for (const row of rows) {
    const o = await getOffer(env, row.offer_id);
    checked++;
    if (!o.ok) { errors++; continue; }
    const st = o.listingStatus || row.listing_status;
    const isEnded = st === 'ENDED' || st === 'EBAY_ENDED';
    db.prepare(`UPDATE ebay_listings SET listing_status = ?, sold_qty = COALESCE(?, sold_qty), available_qty = COALESCE(?, available_qty), listing_id = COALESCE(?, listing_id), last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(st || null, o.soldQuantity, o.availableQuantity, o.listingId, row.id);
    updated++;
    if (isEnded && row.item_id) {
      db.prepare(`UPDATE inventory_items SET channel_status = 'ended', updated_at = datetime('now') WHERE id = ? AND channel_status = 'active'`).run(row.item_id);
      ended++;
    }
  }
  const state = { at: new Date().toISOString(), checked, updated, ended, errors };
  _reconcile.last_run = state;
  return state;
}
let _reconcile = { last_run: null, next_run_at: null };
export function getReconcileState() {
  return { ..._reconcile, running: !!globalThis.__listingsReconcileTimer };
}

// --- reconcile scheduler (stop-then-start singleton, HMR-safe — mirrors lib/postsale.mjs) ---
// Without this the mirror only ever moves forward: publishing sets channel_status 'active' and
// NOTHING clears it, so a listing the owner ended on eBay still reads "listed" in the catalog and
// the uploader forever. That is not a display bug, it is the source of truth going stale — the job
// existed and was tested from day one, but only ever ran from a manual DIAG-token trigger.
const RECONCILE_MIN = 30;
let _rEnv = {}, _rDb = null;
export function startReconcileJob(env, db) {
  stopReconcileJob();
  if (env && typeof env === 'object') _rEnv = env;
  if (db) _rDb = db;
  const ms = RECONCILE_MIN * 60_000;
  const tick = () => {
    _reconcile.next_run_at = new Date(Date.now() + ms).toISOString();
    if (!oauthStatus(_rEnv).connected) return;                 // not connected yet — nothing to check
    // The relist watch rides the same tick: it is a listings-domain job on a listings-domain table,
    // and this timer already has the connection gate and the tracker.db handle it needs. Usually a
    // no-op — nothing is watching unless an order was cancelled. Sequenced rather than parallel so two
    // jobs never write ebay_seller_listings at once — but it runs whether or not the reconcile
    // succeeded, because a cancelled card waiting to be relisted has nothing to do with that call.
    return reconcileListings(_rEnv, _rDb)
      .catch((e) => console.error('[listings/reconcile]', e?.message || e))
      .then(() => sweepRelistWatch(_rEnv, _rDb))
      .catch((e) => console.error('[listings/relist-watch]', e?.message || e));
  };
  const boot = setTimeout(tick, 90_000); if (boot.unref) boot.unref();
  const timer = setInterval(tick, ms); if (timer.unref) timer.unref();
  globalThis.__listingsReconcileBoot = boot;
  globalThis.__listingsReconcileTimer = timer;
  _reconcile.next_run_at = new Date(Date.now() + ms).toISOString();
  console.log(`[listings] reconcile every ${RECONCILE_MIN}m (ended/sold listings flow back into stock)`);
}
export function stopReconcileJob() {
  if (globalThis.__listingsReconcileBoot) { clearTimeout(globalThis.__listingsReconcileBoot); globalThis.__listingsReconcileBoot = null; }
  if (globalThis.__listingsReconcileTimer) { clearInterval(globalThis.__listingsReconcileTimer); globalThis.__listingsReconcileTimer = null; }
  _reconcile.next_run_at = null;
}

export function makeListingsRouter({ env, db, base }) {
  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const cfg = loadConfig();
      let m;   // reused by the /:id/* route matchers below

      // GET /config — non-secret listing defaults (policy IDs are account config, not secrets).
      if (p === '/config' && method === 'GET') {
        // lastImport rides along because the duplicate check is only as fresh as the last mirror
        // import: a hand-made Seller Hub listing is invisible to the Inventory API, so a stale
        // mirror means eBay's [25002] arrives at publish time instead of at Stage. Callers that
        // already fetch /config get to warn about that without a second request.
        return send(res, 200, { config: cfg, connected: oauthStatus(env).connected, lastImport: getImportState().last_run || null });
      }

      // GET /account/status — read-only readiness: opted-in? Pro level? cached policy IDs? location?
      if (p === '/account/status' && method === 'GET') {
        if (!guardConnected(env, res)) return;
        const st = await accountStatus(env, cfg);
        return send(res, 200, st);
      }

      // POST /account/bootstrap — opt into business policies + find/create the 3 policies + location,
      // then persist the resolved IDs into config. Idempotent (safe to re-run).
      if (p === '/account/bootstrap' && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const report = await bootstrapAccount(env, cfg);
        const next = persistBootstrap(cfg, report);
        return send(res, report.errors && report.errors.length ? 207 : 200, { report, config: next });
      }

      // GET /account/policies — the seller's REAL business policies, all three kinds, each with a
      // plain-English summary of its terms and a flag for the one we're pinned to. Read-only.
      // This is what turns "TCG 30-day returns AU" into "30-day returns · buyer pays return post".
      if (p === '/account/policies' && method === 'GET') {
        if (!guardConnected(env, res)) return;
        const KINDS = [['payment_policy', 'payment', 'paymentPolicyId'], ['return_policy', 'return', 'returnPolicyId'], ['fulfillment_policy', 'fulfillment', 'fulfillmentPolicyId']];
        const got = await Promise.all(KINDS.map(([kind]) => listPolicies(env, kind, cfg.marketplaceId)));
        const out = { ok: true, marketplaceId: cfg.marketplaceId, kinds: {}, warnings: [] };
        const bands = (cfg.shipping || {}).bands || [];
        KINDS.forEach(([kind, key, idKey], i) => {
          const r = got[i];
          const ful = kind === 'fulfillment_policy';
          // A postage policy is selected by BAND now, so there is no single selectedId for it — the
          // settings picker matches each band by the amount the policy really charges instead.
          const selectedId = ful ? '' : String((cfg.policies || {})[idKey] || '');
          const rows = r.rows.map((row) => ({
            id: String(row[idKey]), name: row.name || '(unnamed)', summary: describePolicy(kind, row),
            // costCents lets the picker put a ✓ on the policy whose price matches the band, so the
            // owner matches money to money instead of guessing between near-identical names.
            // `services` is the full domestic list — what a buyer really gets to choose from, and
            // what the description's postage table is built out of.
            costCents: ful ? fulfillmentTerms(row).costCents : undefined,
            services: ful ? fulfillmentTerms(row).services : undefined,
            // Whether a combined-postage rule is attached, and the raw fields it was read from. The
            // raw values ride along because "is combining on?" was invisible for so long that a
            // boolean alone is not worth trusting — being able to see WHY it said yes or no is.
            combined: ful ? fulfillmentTerms(row).combined : undefined,
            discountProfileId: ful ? fulfillmentTerms(row).discountProfileId : undefined,
            promotionOffered: ful ? fulfillmentTerms(row).promotionOffered : undefined,
            selected: !ful && String(row[idKey]) === selectedId,
          }));
          const missing = !!selectedId && r.ok && !rows.some((x) => x.selected);
          out.kinds[key] = { kind, idKey, rows, selectedId, missing, error: r.error };
          if (ful) out.kinds[key].bands = bands.map((b) => ({ id: b.id, label: b.label || b.id, costCents: b.costCents, policyId: b.policyId || null }));
          if (r.error) out.ok = false;
          if (missing) out.warnings.push(`the chosen ${key} policy (${selectedId}) is no longer on the eBay account — pick another`);
        });
        // Do the pinned postage policies actually charge what their bands claim? Three ids pasted in
        // the wrong order is otherwise invisible until a buyer is charged the wrong amount.
        const fulR = got[2];
        if (fulR.ok) {
          out.bandCheck = verifyBandPolicies(bands, fulR.rows, fulR.idKey);
          out.warnings.push(...out.bandCheck.errors, ...out.bandCheck.warnings);
          out.notes = out.bandCheck.notes || [];
          if (!out.bandCheck.ok) out.ok = false;
        }
        return send(res, out.ok ? 200 : 207, out);
      }

      // POST /import — mirror every listing on the eBay account, hand-made ones included. Read-only
      // against eBay; safe to re-run. This is the only way the tool learns about listings it did not
      // create, because the Sell Inventory API cannot see them.
      if (p === '/import' && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const out = await importSellerListings(env, db, { marketplaceId: cfg.marketplaceId });
        return send(res, out.ok ? 200 : 502, out);
      }

      // GET /mirror?state=&via=&q=&limit=&images= — what eBay says is on the account, after an import.
      if (p === '/mirror' && method === 'GET') {
        const where = ['1 = 1'], args = [];
        const st = url.searchParams.get('state'), via = url.searchParams.get('via'), qs = url.searchParams.get('q');
        if (st) { where.push('state = ?'); args.push(st); }
        if (via) { where.push('created_via = ?'); args.push(via); }
        if (qs) { where.push('(title LIKE ? OR sku LIKE ? OR listing_id LIKE ?)'); const s = '%' + qs + '%'; args.push(s, s, s); }
        const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '500', 10)));
        const rows = db.prepare(`SELECT * FROM ebay_seller_listings WHERE ${where.join(' AND ')}
                                 ORDER BY (state='active') DESC, last_seen_at DESC LIMIT ?`).all(...args, limit);
        const counts = db.prepare(`SELECT state, created_via, COUNT(*) n FROM ebay_seller_listings GROUP BY state, created_via`).all();
        const unlinked = db.prepare(`SELECT COUNT(*) n FROM ebay_seller_listings WHERE item_id IS NULL AND state='active'`).get().n;
        // images=1 also backfills the thumbnails the import did not carry. Opt-in because it costs a
        // Trading call per unknown listing: the listings page wants the pictures, the settings probe
        // only wants a count and should stay instant. Never fatal — a row simply keeps no picture.
        let images = null;
        if (url.searchParams.get('images') === '1' && oauthStatus(env).connected) {
          try { images = await resolveMirrorImages(env, db, rows); } catch { /* pictures are optional */ }
        }
        return send(res, 200, { listings: rows, counts, unlinkedActive: unlinked, images, lastImport: getImportState().last_run });
      }

      // POST /mirror/:listingId/revise { priceCents?, availableQty?, force? } — change a HAND-MADE
      // listing's price and/or available quantity through the Trading API. Preflights and verifies
      // against eBay; see reviseTradingListing for why the mirror is never the basis for the write.
      if ((m = p.match(/^\/mirror\/([^/]+)\/revise$/)) && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const b = await readJson(req);
        const out = await reviseTradingListing(env, db, {
          listingId: decodeURIComponent(m[1]),
          priceCents: b.priceCents != null ? Math.round(+b.priceCents) : null,
          availableQty: b.availableQty != null ? Math.floor(+b.availableQty) : null,
          force: !!b.force,
        });
        return send(res, out.ok ? 200 : (out.refused ? 409 : 502), out);
      }

      // POST /mirror/:listingId/specifics { apply? } — push the tool's item specifics onto a
      // hand-made listing. Dry run by DEFAULT: eBay replaces the whole set, so the owner sees the
      // exact merge (and eBay's verdict on it, via VerifyOnly) before anything persists.
      if ((m = p.match(/^\/mirror\/([^/]+)\/specifics$/)) && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const b = await readJson(req);
        const out = await pushListingSpecifics(env, db, { listingId: decodeURIComponent(m[1]), dryRun: !b.apply });
        return send(res, out.ok ? 200 : (out.refused ? 409 : 502), out);
      }

      // GET /mirror/resolve — PROPOSE a card for each mirrored listing that isn't linked yet, by
      // reading the title. Read-only, no writes: a mis-parse would attach a listing to the wrong
      // card, so nothing is applied without the owner confirming it (Golden Rule 4).
      if (p === '/mirror/resolve' && method === 'GET') {
        const sets = enSetList();
        if (!sets.length) return send(res, 200, { ok: false, reason: 'no_set_list', proposals: [],
          note: 'The EN set list has not been cached yet — open any set picker once, then try again.' });
        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));
        const rows = db.prepare(`SELECT * FROM ebay_seller_listings WHERE item_id IS NULL AND state IN ('active','sold','unsold')
                                 ORDER BY (state='active') DESC LIMIT ?`).all(limit);
        const bySku = db.prepare('SELECT id, sku, name FROM inventory_items WHERE sku = ? LIMIT 1');
        const proposals = rows.map((r) => {
          const parsed = parseCardTitle(r.title || '', { setNames: sets });
          // A custom label that already matches a stock row is worth more than any title guess.
          const byLabel = r.sku ? bySku.get(r.sku) : null;
          return {
            listing_id: r.listing_id, sku: r.sku, title: r.title, state: r.state,
            price_cents: r.price_cents, quantity: r.quantity, listing_url: r.listing_url,
            parsed, existingItemId: byLabel ? byLabel.id : null,
            confidence: byLabel ? 'high' : parsed.confidence,
          };
        });
        const n = (c) => proposals.filter((x) => x.confidence === c).length;
        return send(res, 200, { ok: true, proposals, counts: { high: n('high'), medium: n('medium'), low: n('low'), none: n('none') },
          note: 'Proposals only. Nothing is written until you apply them.' });
      }

      // POST /mirror/link { links:[{listing_id, identity_key?, itemId?}] } — apply the confirmed
      // matches. Links to an existing stock row when one is named, otherwise creates one FROM the
      // listing so the catalog can finally show it against the right set.
      if (p === '/mirror/link' && method === 'POST') {
        const b = await readJson(req);
        const links = Array.isArray(b.links) ? b.links : [];
        if (!links.length) return send(res, 400, { error: 'links[] required' });
        return send(res, 200, { ok: true, ...linkMirrorListings(db, links, enSetList()) });
      }

      // POST /labels/seed-from-ebay — read every custom label on the seller's eBay listings and move
      // the AAA-001 counter past the highest one. The labels predate this tool and live only on eBay,
      // so this is what makes the series continue instead of restarting on top of a shelf.
      // Scans sold and unsold too: labels are never reused, so the highest may belong to a card that
      // already sold. eBay's history stops at ~90 days, which is reported rather than glossed over.
      if (p === '/labels/seed-from-ebay' && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const r = await getSellerSkus(env);
        if (!r.ok) return send(res, 502, { error: 'could not read your eBay listings: ' + r.error, scanned: r.skus.length });
        const seq = maxLabelSeq(r.skus);
        const before = stockLabelState(db);
        if (!seq) {
          return send(res, 200, {
            ok: false, reason: 'no_labels_found', scanned: r.skus.length, pages: r.pages, truncated: r.truncated,
            ...before,
            note: r.skus.length
              ? 'None of your eBay custom labels look like the AAA-001 series, so the counter was left alone. Seed it by hand if you know the last one.'
              : 'No custom labels came back from eBay at all. Seed the counter by hand.',
          });
        }
        const after = seedStockLabels(db, seq);
        return send(res, 200, {
          ok: true, ...after, highestOnEbay: labelFor(seq), scanned: r.skus.length, pages: r.pages,
          truncated: r.truncated, movedFrom: before.current,
          rewindRefused: before.seq != null && seq < before.seq,
          note: 'eBay only keeps ~90 days of sold history, so a higher label on an older sold listing cannot be seen. Seed by hand if you know of one.',
        });
      }

      // GET /store/categories — the seller's own storefront departments, flattened to full paths for
      // the uploader's picker. Only LEAF categories can hold items (eBay files a parent-category
      // listing into "Other" instead), so `leaf` is carried through and the UI gates on it.
      // Cached in-process: the tree changes when the owner edits their store, not per listing.
      if (p === '/store/categories' && method === 'GET') {
        if (!guardConnected(env, res)) return;
        const fresh = url.searchParams.get('refresh') === '1';
        if (!fresh && _storeCats && Date.now() - _storeCats.at < STORE_CATS_TTL_MS) {
          return send(res, 200, { ..._storeCats.body, cached: true });
        }
        const r = await getStoreCategories(env);
        if (!r.ok) return send(res, 502, { error: 'could not read the store categories: ' + (r.errors && r.errors[0] ? r.errors[0].longMessage || r.errors[0].shortMessage : 'HTTP ' + r.httpStatus), categories: [] });
        const body = { ok: true, storeName: r.storeName || null, categories: r.categories, max: STORE_CATEGORY_MAX };
        _storeCats = { at: Date.now(), body };
        return send(res, 200, { ...body, cached: false });
      }

      // GET /account/privileges — raw selling limits (owner curiosity / drift check).
      if (p === '/account/privileges' && method === 'GET') {
        if (!guardConnected(env, res)) return;
        return send(res, 200, await getPrivileges(env));
      }

      // POST /price { itemId } | { row:{…} } — suggest a list price from eBay AU singles comps
      // (own listings excluded), with confidence + buyer-protection fee context. Live pricing only.
      if (p === '/price' && method === 'POST') {
        // comps use the client-credentials app token (not user consent), so no connect gate here.
        const b = await readJson(req);
        if (b.itemId == null && !b.row) return send(res, 400, { error: 'itemId or row required' });
        const out = await priceItem(env, db, base, b);
        return send(res, out.error ? 404 : 200, out);
      }

      // POST /preview { itemId, price_cents?, bestOffer?, photoPaths?, ...richAspects } — dry-run:
      // build + validate + resolve descriptors + upload images + get listing fees. No publish.
      if (p === '/preview' && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const b = await readJson(req);
        if (b.itemId == null) return send(res, 400, { error: 'itemId required' });
        const out = await runPublish(env, db, cfg, saveConfig, {
          itemId: b.itemId, overrides: pickOverrides(b), bestOfferSpec: b.bestOffer, photoPaths: b.photoPaths || [], dryRun: true,
        });
        return send(res, out.ok ? 200 : 422, out);
      }

      // POST /publish { itemId, price_cents?, bestOffer?, photoPaths?, ...richAspects } — create/revise
      // the offer and publish it live; writes ebay_listing_id/offer_id + the mirror + an audit row.
      if (p === '/publish' && method === 'POST') {
        if (!guardConnected(env, res)) return;
        if (!accountReadyGuard(cfg, res)) return;
        const b = await readJson(req);
        if (b.itemId == null) return send(res, 400, { error: 'itemId required' });
        const out = await runPublish(env, db, cfg, saveConfig, {
          itemId: b.itemId, overrides: pickOverrides(b), bestOfferSpec: b.bestOffer, photoPaths: b.photoPaths || [], dryRun: false,
          // A listing DECISION, like bestOffer — not a card fact, so it rides on the request rather
          // than in OVERRIDE_FIELDS. Absent means "use the config default".
          compose: b.compose == null ? null : !!b.compose,
        });
        return send(res, out.ok ? 200 : 422, out);
      }

      // GET /batch/preflight?item_ids=1,2,3[&released_ids=2] — build + validate every row LOCALLY.
      // Zero eBay calls, so the client can gate the publish button on it for free. Deliberately not
      // a dry-run publish: runPublish(dryRun:true) still PUTs a real inventory item, creates a real
      // offer and uploads to EPS, and there is no deleteOffer in this repo to clean up after it.
      if (p === '/batch/preflight' && method === 'GET') {
        // `+'' === 0` and Number.isFinite(0) is true, so an empty or comma-only parameter would
        // otherwise become a request for item id 0. Row ids are AUTOINCREMENT from 1, so a valid id
        // is always positive — anything else is a malformed request, not a lookup for nothing.
        const ids = parseIdList(url.searchParams.get('item_ids'));
        if (!ids.length) return send(res, 400, { error: 'item_ids required (comma-separated)' });
        if (ids.length > BATCH_MAX) return send(res, 400, { error: 'too many items (' + ids.length + '); the cap is ' + BATCH_MAX, code: 'batch_too_large' });
        const released = parseIdList(url.searchParams.get('released_ids'));
        return send(res, 200, batchPreflight(db, cfg, { itemIds: ids, releasedIds: released }));
      }

      // POST /batch/preflight/canary { item_ids[], overrides_by_id?, bestOffer? } — a REAL dry run
      // over at most four representative rows, so eBay's own verdict on the payload arrives before
      // a hundred cards go out. Costs real offers on the account (see pickCanaries), which is why
      // it is a separate, explicit endpoint rather than part of the free pre-flight.
      if (p === '/batch/preflight/canary' && method === 'POST') {
        if (!guardConnected(env, res)) return;
        if (!accountReadyGuard(cfg, res)) return;
        const b = await readJson(req);
        const ids = parseIdList(Array.isArray(b.item_ids) ? b.item_ids : []);
        if (!ids.length) return send(res, 400, { error: 'item_ids (non-empty array) required' });
        const rows = batchRows(db, ids, b.overrides_by_id || {});
        const picked = pickCanaries(rows, Math.min(4, Math.max(1, +b.max || 4)));
        const out = [];
        for (const r of picked) {
          try {
            const one = await runPublish(env, db, cfg, saveConfig, { itemId: r.id, overrides: r.overrides, bestOfferSpec: b.bestOffer, dryRun: true });
            out.push({ item_id: r.id, sku: r.item.sku, name: r.item.name, ok: !!one.ok, error: one.error || null,
              title: one.title || null, aspects: one.aspects || null, fees: one.fees || null,
              storeCategoryNames: one.storeCategoryNames || [], imageCount: (one.imageUrls || []).length,
              warnings: (one.validation && one.validation.warnings) || [] });
          } catch (e) { out.push({ item_id: r.id, sku: r.item.sku, name: r.item.name, ok: false, error: String(e?.message || e) }); }
        }
        return send(res, 200, { sampled: out.length, of: rows.length, rows: out, ok: out.every((x) => x.ok) });
      }

      // POST /batch { item_ids[], overrides_by_id?, bestOffer?, released_ids[] } → NDJSON.
      // Publishes a whole staged batch, one row at a time, streaming {start} {row}… {summary}.
      //
      // The job-level guards run ONCE, here, rather than per row: they fail identically for all N,
      // so a disconnected account should cost one sentence, not a hundred copies of it.
      if (p === '/batch' && method === 'POST') {
        if (!guardConnected(env, res)) return;
        if (!accountReadyGuard(cfg, res)) return;
        const b = await readJson(req);
        const ids = parseIdList(Array.isArray(b.item_ids) ? b.item_ids : []);
        if (!ids.length) return send(res, 400, { error: 'item_ids (non-empty array) required' });
        if (ids.length > BATCH_MAX) return send(res, 400, { error: 'too many items (' + ids.length + '); the cap is ' + BATCH_MAX, code: 'batch_too_large' });
        // Resume is derived, not stored: anything already live is dropped before the run starts.
        const pending = b.resume === false ? ids : pendingBatchIds(db, ids);
        if (!pending.length) return send(res, 200, { ok: true, nothing_to_do: true, already_live: ids.length, message: 'every row in this batch is already live on eBay' });

        const started = startBatchJob(env, db, cfg, saveConfig, {
          itemIds: pending, overridesById: b.overrides_by_id || {}, bestOfferSpec: b.bestOffer,
          releasedIds: parseIdList(b.released_ids || []),
          compose: b.compose == null ? null : !!b.compose,
        });
        // A second concurrent run would interleave two sets of eBay writes for no benefit. Hand back
        // the running job's id so the caller attaches to it instead.
        if (!started.ok) return send(res, 409, started);

        // Past this point the status line is gone, so every later failure is a {row}/{summary}
        // record rather than an HTTP error (GR7 — the NDJSON contract lib/bulk.mjs already uses).
        // This response is only a VIEW: dropping it does not stop the run.
        const write = ndjsonStart(res);
        write({ job: { id: started.id, resumed_from: ids.length - pending.length } });
        let closed = false; res.on('close', () => { closed = true; });
        await followBatchJob(write, 0, () => closed);
        return res.end();
      }

      // GET /batch/state — is anything running right now? The Runner asks on load so a reopened tab
      // re-attaches to a run in progress instead of looking like nothing is happening.
      if (p === '/batch/state' && method === 'GET') return send(res, 200, getBatchJobState());

      // GET /batch/:id/stream?from=<seq> — attach (or re-attach) to a run. Replays the ring buffer
      // from `from`, then follows live, so a reconnect loses nothing.
      if ((m = p.match(/^\/batch\/([A-Za-z0-9_-]+)\/stream$/)) && method === 'GET') {
        const st = getBatchJobState();
        if (st.id !== m[1]) return send(res, 404, { error: 'no such batch run', code: 'unknown_job', current: st.id });
        const write = ndjsonStart(res);
        let closed = false; res.on('close', () => { closed = true; });
        await followBatchJob(write, +(url.searchParams.get('from') || 0), () => closed);
        return res.end();
      }

      // POST /batch/:id/cancel — stops AFTER the current card. See runBatchPublish for why there is
      // no mid-card cancel.
      if ((m = p.match(/^\/batch\/([A-Za-z0-9_-]+)\/cancel$/)) && method === 'POST') {
        const out = cancelBatchJob(m[1]);
        return send(res, out.ok ? 200 : 409, out);
      }

      // GET /batch/:id — counters only, for a poller that does not want a stream.
      if ((m = p.match(/^\/batch\/([A-Za-z0-9_-]+)$/)) && method === 'GET') {
        const st = getBatchJobState();
        if (st.id !== m[1]) return send(res, 404, { error: 'no such batch run', code: 'unknown_job', current: st.id });
        return send(res, 200, st);
      }

      // POST /photos { itemId, kind, dataUrl, compose? } — upload one owner photo (base64 data URL)
      // to eBay EPS and cache it as a listing_image; publish then uses these instead of the stock
      // CDN art. Branding happens HERE, not at publish: by publish time the photo is already a
      // finished EPS url with no bytes left to work on.
      if (p === '/photos' && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const b = await readJson(req);
        if (b.itemId == null || !b.dataUrl) return send(res, 400, { error: 'itemId and dataUrl required' });
        const mm = String(b.dataUrl).match(/^data:([^;]+);base64,([\s\S]+)$/);
        if (!mm) return send(res, 400, { error: 'dataUrl must be a base64 data: URL' });
        const raw = Buffer.from(mm[2], 'base64');
        const ext = mm[1].includes('png') ? 'png' : mm[1].includes('webp') ? 'webp' : 'jpg';
        const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(+b.itemId);
        if (!item) return send(res, 404, { error: 'no such stock item: ' + b.itemId });

        // Keep the original whatever happens — it is the only copy that is not on the owner's phone.
        const localPath = storePhotoOriginal(raw, ext);
        const out = await composePhotoBytes(item, raw, ext, mm[1], b.compose);
        const up = await createImageFromFile(env, { buffer: out.buffer, filename: 'photo.' + out.ext, contentType: out.contentType });
        if (!up.ok) return send(res, 502, { error: 'photo upload failed: ' + up.error });
        const kind = ['front', 'back', 'blemish', 'slab'].includes(b.kind) ? b.kind : 'front';
        const so = (db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM listing_images WHERE item_id = ?').get(+b.itemId) || {}).n || 0;
        db.prepare('INSERT INTO listing_images (item_id, kind, local_path, eps_url, expires_at, sort_order, compose_hash, compose_version) VALUES (?,?,?,?,?,?,?,?)')
          .run(+b.itemId, kind, localPath, up.eps_url, up.expires_at || null, so, out.composeHash, out.composeVersion);
        return send(res, 200, { ok: true, eps_url: up.eps_url, kind, composed: !!out.composeHash, compose_version: out.composeVersion, warning: out.warning || null });
      }

      // POST /:itemId/photos/recompose — re-brand this item's photos from their retained originals
      // at the CURRENT asset version, re-upload, and replace the rows. This is what makes an
      // ASSET_VERSION bump reachable for owner photos.
      if ((m = p.match(/^\/(\d+)\/photos\/recompose$/)) && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const itemId = +m[1];
        const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
        if (!item) return send(res, 404, { error: 'no such stock item: ' + itemId });
        const b = await readJson(req).catch(() => ({}));
        const rows = db.prepare(`SELECT * FROM listing_images WHERE item_id = ? AND kind IN ('front','back','blemish','slab') ORDER BY sort_order, id`).all(itemId);
        if (!rows.length) return send(res, 404, { error: 'this item has no owner photos' });

        const done = [];
        const warnings = [];
        for (const row of rows) {
          // A photo uploaded before originals were retained has nothing to rebuild from. Say so per
          // photo and leave the row alone rather than dropping a live listing's image.
          if (!row.local_path || !fs.existsSync(row.local_path)) {
            warnings.push(`photo #${row.id} (${row.kind}) has no retained original — re-upload it to brand it`);
            continue;
          }
          const buf = fs.readFileSync(row.local_path);
          const ext = (row.local_path.split('.').pop() || 'jpg').toLowerCase();
          const out = await composePhotoBytes(item, buf, ext, null, b.compose);
          const up = await createImageFromFile(env, { buffer: out.buffer, filename: 'photo.' + out.ext, contentType: out.contentType });
          if (!up.ok) { warnings.push(`photo #${row.id}: ${up.error}`); continue; }
          if (out.warning) warnings.push(`photo #${row.id}: ${out.warning}`);
          db.prepare('UPDATE listing_images SET eps_url = ?, expires_at = ?, compose_hash = ?, compose_version = ?, ts = datetime(\'now\') WHERE id = ?')
            .run(up.eps_url, up.expires_at || null, out.composeHash, out.composeVersion, row.id);
          done.push({ id: row.id, kind: row.kind, eps_url: up.eps_url, composed: !!out.composeHash, compose_version: out.composeVersion });
        }
        // The live listing still points at the OLD EPS urls until it is republished — eBay copies the
        // image into the offer, it does not follow our table.
        return send(res, 200, { ok: true, recomposed: done.length, photos: done, warnings, note: done.length ? 'republish the listing to push the new images to eBay' : null });
      }
      // DELETE /:itemId/photos — clear an item's uploaded photos (revert to stock art).
      if ((m = p.match(/^\/(\d+)\/photos$/)) && method === 'DELETE') {
        db.prepare("DELETE FROM listing_images WHERE item_id = ? AND kind IN ('front','back','blemish','slab')").run(+m[1]);
        return send(res, 200, { ok: true });
      }

      // POST /:itemId/revise-price { price_cents } — republish the offer at a new price (idempotent).
      if ((m = p.match(/^\/(\d+)\/revise-price$/)) && method === 'POST') {
        if (!guardConnected(env, res)) return;
        if (!accountReadyGuard(cfg, res)) return;
        const b = await readJson(req);
        if (!(b.price_cents > 0)) return send(res, 400, { error: 'price_cents (>0) required' });
        const out = await runPublish(env, db, cfg, saveConfig, { itemId: +m[1], overrides: { price_cents: b.price_cents }, bestOfferSpec: b.bestOffer, dryRun: false });
        return send(res, out.ok ? 200 : 422, out);
      }

      // POST /:itemId/withdraw — end the eBay listing (offer goes unpublished; stays relistable).
      if ((m = p.match(/^\/(\d+)\/withdraw$/)) && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(+m[1]);
        if (!item) return send(res, 404, { error: 'item not found' });
        const row = db.prepare('SELECT offer_id FROM ebay_listings WHERE sku = ? AND marketplace = ?').get(item.sku, cfg.marketplaceId);
        const offerId = item.ebay_offer_id || (row && row.offer_id);
        if (!offerId) return send(res, 409, { error: 'no offer to withdraw for this item' });
        const w = await withdrawOffer(env, offerId);
        if (w.ok) {
          db.prepare(`UPDATE inventory_items SET channel_status='ended', status=CASE WHEN status='sold' THEN status ELSE 'in_stock' END, updated_at=datetime('now') WHERE id=?`).run(+m[1]);
          db.prepare(`UPDATE ebay_listings SET listing_status='ENDED', last_synced_at=datetime('now'), updated_at=datetime('now') WHERE sku=? AND marketplace=?`).run(item.sku, cfg.marketplaceId);
          db.prepare(`INSERT INTO listing_pushes (item_id, sku, action, offer_id, status) VALUES (?,?,?,?,?)`).run(+m[1], item.sku, 'withdraw', offerId, 'ok');
        }
        return send(res, w.ok ? 200 : 422, w.ok ? { ok: true, offerId } : { ok: false, error: w.error });
      }

      // GET /reconcile-state — last reconcile summary (open; no eBay call). Carries the relist watch
      // alongside it: they run on the same tick, and "eBay never relisted these" is the one state in
      // that job a human has to act on.
      if (p === '/reconcile-state' && method === 'GET') {
        return send(res, 200, { ...getReconcileState(), relist_watch: getRelistWatchState(db) });
      }
      // POST /reconcile — check our mirrored listings against eBay's live state (DIAG-gated; reads eBay,
      // writes only our local mirror + channel_status). Marks ended/out-of-stock drift.
      if (p === '/reconcile' && method === 'POST') {
        const d = diagOk(env, req, url);
        if (!d.ok) return send(res, d.code, { error: d.error });
        if (!guardConnected(env, res)) return;
        return send(res, 200, await reconcileListings(env, db, { marketplaceId: cfg.marketplaceId }));
      }

      // POST /relist-watch/sweep — check now whether eBay has relisted the cards from a cancelled
      // order, instead of waiting out the backoff. Same DIAG gate as every other manual trigger; the
      // scheduled pass rides the reconcile tick.
      if (p === '/relist-watch/sweep' && method === 'POST') {
        const d = diagOk(env, req, url);
        if (!d.ok) return send(res, d.code, { error: d.error });
        if (!guardConnected(env, res)) return;
        return send(res, 200, { triggered: 'relist-watch', result: await sweepRelistWatch(env, db) });
      }

      // POST /:itemId/recheck — ask eBay what this ONE listing is actually doing, now. The scheduled
      // reconcile covers everything every 30 minutes; this is the "I just ended that on eBay and the
      // app still says listed" button. One offer read, so no diag gate.
      if ((m = p.match(/^\/(\d+)\/recheck$/)) && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const item = db.prepare('SELECT id, sku, ebay_offer_id, ebay_listing_id, channel_status FROM inventory_items WHERE id = ?').get(+m[1]);
        if (!item) return send(res, 404, { error: 'item not found' });
        if (!item.ebay_offer_id) {
          return send(res, 200, { ok: true, checked: false, reason: 'not_ours',
            note: 'No offer id, so this listing was not created here — the Sell Inventory API cannot see it. Check it in Seller Hub.' });
        }
        const o = await getOffer(env, item.ebay_offer_id);
        if (!o.ok) return send(res, 502, { error: 'eBay: ' + o.error });
        const ended = o.listingStatus === 'ENDED' || o.listingStatus === 'EBAY_ENDED';
        db.prepare(`UPDATE ebay_listings SET listing_status = ?, sold_qty = COALESCE(?, sold_qty), available_qty = COALESCE(?, available_qty),
                    last_synced_at = datetime('now'), updated_at = datetime('now') WHERE offer_id = ?`)
          .run(o.listingStatus || null, o.soldQuantity, o.availableQuantity, item.ebay_offer_id);
        if (ended) db.prepare(`UPDATE inventory_items SET channel_status = 'ended', updated_at = datetime('now') WHERE id = ? AND channel_status = 'active'`).run(item.id);
        return send(res, 200, { ok: true, checked: true, listingStatus: o.listingStatus || null, ended,
          soldQuantity: o.soldQuantity, availableQuantity: o.availableQuantity,
          channel_status: ended ? 'ended' : item.channel_status });
      }

      // GET /:itemId — the item's listing state (mirror row + recent pushes).
      if ((m = p.match(/^\/(\d+)$/)) && method === 'GET') {
        const item = db.prepare('SELECT id, sku, name, status, channel_status, ebay_listing_id, ebay_offer_id FROM inventory_items WHERE id = ?').get(+m[1]);
        if (!item) return send(res, 404, { error: 'item not found' });
        const mirror = db.prepare('SELECT * FROM ebay_listings WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(+m[1]);
        // request/response are written on every attempt and were never readable — they hold the exact
        // body we PUT and eBay's exact reply, which is the whole point of keeping them.
        const pushes = db.prepare('SELECT action, status, error, listing_id, request, response, ts FROM listing_pushes WHERE item_id = ? ORDER BY id DESC LIMIT 10').all(+m[1]);
        return send(res, 200, { item, mirror: mirror || null, pushes });
      }

      return send(res, 404, { error: 'unknown listings route', path: p, method });
    } catch (e) {
      console.error('[api/listings] error:', e?.message || e);
      return send(res, 500, { error: 'listings error', detail: String(e?.message || e) });
    }
  };
}

export function listingsPlugin(env) {
  return {
    name: 'listings',
    configureServer(server) {
      ensureConfigSeeded();
      const db = openDb();   // shared tracker.db (holds ebay_listings / listing_pushes / listing_images)
      const port = server.config?.server?.port || 5273;
      const base = `http://127.0.0.1:${port}`;   // self-fetch the sibling /api/ebay proxy for comps
      server.middlewares.use('/api/listings', makeListingsRouter({ env, db, base }));
      startReconcileJob(env, db);   // keeps 'listed' honest; see startReconcileJob for why it matters
      console.log('[listings] API /api/listings · config ' + CONFIG_PATH);
    },
  };
}
