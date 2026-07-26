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
import { accountStatus, bootstrapAccount, getPrivileges, listPolicies, describePolicy } from './ebay-account.mjs';
import { toEbayListing, validateListing, loadEbayCategories, buildItemDescription } from './channels/ebay-map.mjs';
import { resolveConditionDescriptorIds } from './ebay-taxonomy.mjs';
import { buildOfferImageUrls, ensureGenericImage, createImageFromFile } from './ebay-media.mjs';
import { publishListing, withdrawOffer, listingUrl, getOffer, resolveStoreCategoryNames } from './channels/ebay-inventory-api.mjs';
import { getStoreCategories, getSellerSkus, getSellerListings } from './ebay-trading.mjs';
import { stockLabelState, seedStockLabels } from './inventory.mjs';
import { maxLabelSeq, labelFor } from './sku-labels.mjs';
import { singlesEbayValue } from './comps-singles.mjs';
import { feeAU, totalFromList } from './fees.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'ebay-listing.config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'data', 'ebay-listing.config.example.json');

const DEFAULT_CONFIG = {
  marketplaceId: 'EBAY_AU', categoryTreeId: '15', listingDuration: 'GTC', handlingDays: 1,
  outOfStockControl: true,
  location: { merchantLocationKey: 'tcg-au-1', name: 'TCG AU', country: 'AU', postalCode: '', city: '', stateOrProvince: '' },
  policyNames: { payment: 'TCG Managed Payments AU', return: 'TCG 30-day returns AU', fulfillment: 'TCG Free AU Post' },
  // This store does not accept returns (its hand-made listings say "No returns accepted"), so a policy
  // the tool has to CREATE must say that too. A policy PICKED in Settings always wins over this.
  returns: { accepted: false, days: 30, shippingCostPayer: 'BUYER' },
  // AU_AusPostStandardLetter = "Australia Post Domestic Regular Letter Untracked" (verified live
  // 2026-07-26 against Sell Metadata get_shipping_services, 87 AU services). The old
  // AU_StandardDelivery is "Standard Parcel Delivery" — parcel post for a single card in a sleeve.
  shipping: { serviceCode: 'AU_AusPostStandardLetter', freeDomestic: true },
  policies: { paymentPolicyId: '', returnPolicyId: '', fulfillmentPolicyId: '' },
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
export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      ...DEFAULT_CONFIG, ...raw,
      location: { ...DEFAULT_CONFIG.location, ...(raw.location || {}) },
      policyNames: { ...DEFAULT_CONFIG.policyNames, ...(raw.policyNames || {}) },
      returns: { ...DEFAULT_CONFIG.returns, ...(raw.returns || {}) },
      shipping: { ...DEFAULT_CONFIG.shipping, ...(raw.shipping || {}) },
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
  const next = { ...cfg, policies: { ...cfg.policies }, location: { ...cfg.location } };
  if (report.policies) {
    if (report.policies.paymentPolicyId) next.policies.paymentPolicyId = report.policies.paymentPolicyId;
    if (report.policies.returnPolicyId) next.policies.returnPolicyId = report.policies.returnPolicyId;
    if (report.policies.fulfillmentPolicyId) next.policies.fulfillmentPolicyId = report.policies.fulfillmentPolicyId;
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
  if (!p.paymentPolicyId || !p.returnPolicyId || !p.fulfillmentPolicyId || !loc.merchantLocationKey) {
    send(res, 409, { error: 'eBay listing not set up — run “Run eBay listing setup” in Settings first (business policies + merchant location)', code: 'not_ready' });
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
  'printed_total', 'evolves_from', 'release_year'];
function pickOverrides(b) {
  const o = {};
  if (b.price_cents != null) o.price_cents = b.price_cents;
  for (const k of OVERRIDE_FIELDS) if (b[k] != null) o[k] = b[k];
  if (Array.isArray(b.photo_urls)) o.photo_urls = b.photo_urls;
  // A listing DECISION, not a card fact, so it is not in OVERRIDE_FIELDS. Only an ARRAY counts: an
  // ABSENT field must leave the persisted pick alone, which is what makes /revise-price and a future
  // repricer apply re-send the same storeCategoryNames instead of letting eBay drop them.
  if (Array.isArray(b.store_categories)) o.store_categories = b.store_categories;
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
  const listing = toEbayListing(merged, null, loadEbayCategories());
  return { listing, item, merged };
}

// The full publish/preview pipeline for one item: resolve descriptor IDs → EPS images → publish (or
// dry-run) → write back. Returns a rich result object. saveCfg persists the generic-image EPS cache.
export async function runPublish(env, db, cfg, saveCfg, { itemId, overrides = {}, bestOfferSpec, photoPaths = [], dryRun = false }) {
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
  const photoRows = db.prepare(`SELECT eps_url FROM listing_images WHERE item_id = ? AND kind IN ('front','back','blemish','slab') AND eps_url IS NOT NULL ORDER BY sort_order, id`).all(item.id);
  const photoEps = photoRows.map((r) => r.eps_url).filter(Boolean);
  let img;
  if (photoEps.length) {
    const generic = await ensureGenericImage(env, cfg, saveCfg, db);
    img = { imageUrls: [...photoEps, ...(generic ? [generic] : [])], warnings: [], hero: photoEps[0] };
  } else {
    const sources = (listing.imageUrls || []).map((u) => ({ url: u, kind: 'card' })).concat((photoPaths || []).map((path) => ({ path, kind: 'front' })));
    img = await buildOfferImageUrls(env, { db, itemId: item.id, sources, cfg, saveCfg });
  }
  if (!img.imageUrls.length) return { ok: false, error: 'no listable image (all uploads failed): ' + (img.warnings.join('; ') || 'none'), validation: v };

  // The description embeds the hero image, so it can only be finalised AFTER the EPS upload —
  // toEbayListing necessarily runs before a byte is hosted. eBay-hosted beats the source CDN (EPS
  // lives as long as the listing), and an owner photo wins over the stock scan on a played card.
  if (img.hero) listing.descriptionHtml = buildItemDescription(merged, { imageUrl: img.hero });

  const bestOffer = resolveBestOffer(listing.price_cents, bestOfferSpec, cfg);
  const existingOfferId = item.ebay_offer_id || (db.prepare('SELECT offer_id FROM ebay_listings WHERE sku = ? AND marketplace = ?').get(item.sku, cfg.marketplaceId) || {}).offer_id || null;

  const res = await publishListing(env, { listing, cfg, imageUrls: img.imageUrls, conditionDescriptors: cd.descriptors, bestOffer, existingOfferId, dryRun });

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
}

// Read the seller username to exclude from comps (so we never price a card off our own listing).
function ownSeller() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'repricer.config.json'), 'utf8')).exclude_seller_username || null; }
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
// Suggest a price for one item (or inline row) from eBay AU singles comps. Returns the full analysis.
async function priceItem(env, db, base, input) {
  const it = input.itemId != null ? db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(+input.itemId) : input.row;
  if (!it) return { error: 'item not found' };
  const number = it.number != null ? String(it.number) : '';
  const parts = ['Pokemon', it.name, number, it.set_name].filter(Boolean);
  const query = (input.query || parts.join(' ')).trim();
  const graded = !!(it.graded || it.grading_company);
  const comps = await singlesEbayValue({
    base, query, numberMatch: number, lang: LANG_DATA[String(it.language || 'EN').toUpperCase()] || 'en',
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

  const up = db.prepare(`INSERT INTO ebay_seller_listings
      (listing_id, sku, title, price_cents, currency, quantity, sold_qty, state, listing_url, created_via, item_id, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(listing_id) DO UPDATE SET
      sku = excluded.sku, title = excluded.title, price_cents = excluded.price_cents,
      currency = excluded.currency, quantity = excluded.quantity, sold_qty = excluded.sold_qty,
      state = excluded.state, listing_url = COALESCE(excluded.listing_url, listing_url),
      created_via = excluded.created_via, item_id = COALESCE(excluded.item_id, item_id),
      last_seen_at = datetime('now')`);
  const findItem = db.prepare('SELECT id FROM inventory_items WHERE sku = ? LIMIT 1');
  const isOurs = db.prepare('SELECT 1 FROM ebay_listings WHERE listing_id = ? LIMIT 1');

  let imported = 0, linked = 0, manual = 0;
  for (const row of r.listings) {
    const item = row.sku ? findItem.get(row.sku) : null;
    const ours = isOurs.get(row.listing_id) ? 'tool' : 'manual';
    if (ours === 'manual') manual++;
    if (item) linked++;
    up.run(row.listing_id, row.sku, row.title, row.price_cents, row.currency || 'AUD', row.quantity,
      row.sold_qty || 0, row.state, row.listing_url, ours, item ? item.id : null);
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
    return reconcileListings(_rEnv, _rDb).catch((e) => console.error('[listings/reconcile]', e?.message || e));
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
        return send(res, 200, { config: cfg, connected: oauthStatus(env).connected });
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
        KINDS.forEach(([kind, key, idKey], i) => {
          const r = got[i], selectedId = String((cfg.policies || {})[idKey] || '');
          const rows = r.rows.map((row) => ({ id: String(row[idKey]), name: row.name || '(unnamed)', summary: describePolicy(kind, row), selected: String(row[idKey]) === selectedId }));
          const missing = !!selectedId && r.ok && !rows.some((x) => x.selected);
          out.kinds[key] = { kind, idKey, rows, selectedId, missing, error: r.error };
          if (r.error) out.ok = false;
          if (missing) out.warnings.push(`the chosen ${key} policy (${selectedId}) is no longer on the eBay account — pick another`);
        });
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

      // GET /mirror?state=&via=&q=&limit= — what eBay says is on the account, after an import.
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
        return send(res, 200, { listings: rows, counts, unlinkedActive: unlinked, lastImport: getImportState().last_run });
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
        });
        return send(res, out.ok ? 200 : 422, out);
      }

      // POST /photos { itemId, kind, dataUrl } — upload one owner photo (base64 data URL) to eBay EPS
      // and cache it as a listing_image; publish then uses these instead of the stock CDN art.
      if (p === '/photos' && method === 'POST') {
        if (!guardConnected(env, res)) return;
        const b = await readJson(req);
        if (b.itemId == null || !b.dataUrl) return send(res, 400, { error: 'itemId and dataUrl required' });
        const mm = String(b.dataUrl).match(/^data:([^;]+);base64,([\s\S]+)$/);
        if (!mm) return send(res, 400, { error: 'dataUrl must be a base64 data: URL' });
        const buffer = Buffer.from(mm[2], 'base64');
        const ext = mm[1].includes('png') ? 'png' : mm[1].includes('webp') ? 'webp' : 'jpg';
        const up = await createImageFromFile(env, { buffer, filename: 'photo.' + ext, contentType: mm[1] });
        if (!up.ok) return send(res, 502, { error: 'photo upload failed: ' + up.error });
        const kind = ['front', 'back', 'blemish', 'slab'].includes(b.kind) ? b.kind : 'front';
        const so = (db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM listing_images WHERE item_id = ?').get(+b.itemId) || {}).n || 0;
        db.prepare('INSERT INTO listing_images (item_id, kind, eps_url, expires_at, sort_order) VALUES (?,?,?,?,?)').run(+b.itemId, kind, up.eps_url, up.expires_at || null, so);
        return send(res, 200, { ok: true, eps_url: up.eps_url, kind });
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

      // GET /reconcile-state — last reconcile summary (open; no eBay call).
      if (p === '/reconcile-state' && method === 'GET') {
        return send(res, 200, getReconcileState());
      }
      // POST /reconcile — check our mirrored listings against eBay's live state (DIAG-gated; reads eBay,
      // writes only our local mirror + channel_status). Marks ended/out-of-stock drift.
      if (p === '/reconcile' && method === 'POST') {
        const d = diagOk(env, req, url);
        if (!d.ok) return send(res, d.code, { error: d.error });
        if (!guardConnected(env, res)) return;
        return send(res, 200, await reconcileListings(env, db, { marketplaceId: cfg.marketplaceId }));
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
