// lib/shopify.mjs — the Shopify channel plugin: /api/shopify/*.
//
// The sibling of lib/listings.mjs, and shaped like it on purpose. What is genuinely different is the
// blast radius: this plugin joins a 30-plugin array in ONE dev-server process, and that process is
// every eBay tool in the building. eBay is the business until the storefront launches, so a boot-time
// throw here does not degrade a feature — it takes the shop's tooling offline. configureServer is
// therefore wrapped whole, and a plugin that cannot start still MOUNTS, answering 503 with the reason
// rather than vanishing and leaving /api/shopify/* falling through to Vite's static handler as HTML.
//
// THE THREE SWITCHES, and why there are three:
//   credentials     absent  -> 409 not_connected   (nothing can work; .env problem)
//   pinned gids     absent  -> 409 not_ready       (config problem, and the harness prints the values)
//   publish.enabled false   -> 409 publish_disabled (deliberate; the operator has not armed it yet)
// They are separate because they are separate problems with separate fixes, and collapsing them into
// one "not configured" is how someone spends an hour editing the wrong file. /preview ignores all
// three — it is local, calls nothing, and is exactly what you want when the answer to "why won't this
// publish" is "look at what it would send".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { conditionKey } from './inventory.mjs';
import { reserveShelfLabel, commitShelfLabel } from './shelf-label.mjs';
import { toShopifyProduct, validateProduct, identityHandleFor } from './channels/shopify-map.mjs';
import { ensureShopifyMedia } from './channels/shopify-media.mjs';
import { publishProduct, buildProductSetInput } from './channels/shopify-product-api.mjs';
import { shopifyGraphQL, resolveShop, firstErrorText, ShopifyNotConfigured, API_VERSION } from './channels/shopify-admin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so tests never touch the operator's real, server-owned config. The integration test
// previously wrote its own fixture — publish ARMED, fake pins — straight over data/shopify.config.json
// and restored it only in after(), so a crashed or interrupted run left the live box armed against a
// store that does not exist.
// A FUNCTION, not a const: ESM hoists imports, so a test cannot set the env var before a module-level
// const would have read it. Resolved per call instead, which also costs nothing here.
const configPath = () => process.env.TCG_SHOPIFY_CONFIG || path.join(ROOT, 'data', 'shopify.config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'data', 'shopify.config.example.json');

// --- config ---------------------------------------------------------------------------------------

export function ensureConfigSeeded() {
  try {
    if (!fs.existsSync(configPath()) && fs.existsSync(CONFIG_EXAMPLE_PATH)) {
      fs.copyFileSync(CONFIG_EXAMPLE_PATH, configPath());
      console.log('[shopify] seeded data/shopify.config.json from example');
    }
  } catch (e) { console.warn('[shopify] config seed failed —', e?.message || e); }
}

let _warnedConfig = false;
export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch (e) {
    // A MALFORMED config silently replaced by the example is the worst kind of quiet: the operator's
    // pins are ignored, the example's are used, and everything looks configured. Say so once — per
    // request would flood the log, since loadConfig runs on every call (GR7).
    if (!_warnedConfig && fs.existsSync(configPath())) {
      _warnedConfig = true;
      console.warn('[shopify] data/shopify.config.json could not be parsed, falling back to the example —', e?.message || e);
    }
  }
  try { return JSON.parse(fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf8')); }
  catch { return {}; }
}

// _comment keys are documentation for whoever opens the file; they are not configuration and have no
// business in an API response or in anything that diffs config.
function stripComments(v) {
  if (Array.isArray(v)) return v.map(stripComments);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, stripComments(x)]));
  }
  return v;
}

/**
 * The pinned ids for a store. Returned as data rather than thrown, because "which of these two is
 * missing" is the whole answer an operator needs and an exception would flatten it.
 */
export function pinsFor(cfg, store) {
  const s = (cfg.stores || {})[store] || {};
  const locationGid = String(s.locationGid || '').trim() || null;
  const publicationGid = String(s.publicationGid || '').trim() || null;
  return { locationGid, publicationGid, missing: [!locationGid && 'locationGid', !publicationGid && 'publicationGid'].filter(Boolean) };
}

const storeFor = (cfg, url) => String(url?.searchParams?.get('store') || cfg.defaultStore || 'dev');

// --- http plumbing (same shapes as lib/listings.mjs) ------------------------------------------------

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 20e6) b = b.slice(0, 20e6); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function guardCredentials(env, store, res) {
  try { resolveShop(env, store); return true; }
  catch (e) {
    send(res, 409, {
      error: e instanceof ShopifyNotConfigured ? e.message : String(e?.message || e),
      code: 'not_connected',
    });
    return false;
  }
}
function guardPins(cfg, store, res) {
  const pins = pinsFor(cfg, store);
  if (pins.missing.length) {
    send(res, 409, {
      error: `store '${store}' has no ${pins.missing.join(' and no ')} pinned — run scripts/check-shopify.mjs, which prints both with a "pin this" marker, and paste them into data/shopify.config.json`,
      code: 'not_ready', store, missing: pins.missing,
    });
    return null;
  }
  return pins;
}
function guardPublishEnabled(cfg, res) {
  if ((cfg.publish || {}).enabled) return true;
  send(res, 409, {
    error: 'publishing to Shopify is switched off — set publish.enabled true in data/shopify.config.json once a supervised dev-store publish has been eyeballed',
    code: 'publish_disabled',
  });
  return false;
}

// --- the identity list ------------------------------------------------------------------------------

// Best first, because that is the order a buyer expects to be offered and the PDP renders the list in
// array order. '' is UNKNOWN, not NM (conditionKey is explicit about that), so it sorts last rather
// than silently leading the tiles.
const CONDITION_ORDER = ['NM', 'LP', 'MP', 'HP', 'OTHER', ''];
const conditionRank = (c) => {
  const i = CONDITION_ORDER.indexOf(conditionKey(c));
  return i < 0 ? CONDITION_ORDER.length : i;
};

const IDENTITY_UPSERT = `
mutation BkIdentityListings($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
  metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
    metaobject { id handle }
    userErrors { field message code }
  }
}`;

/**
 * rebuildIdentity — recompute one card identity's `listings` from tracker.db and write it whole.
 *
 * ⚠ RECOMPUTE, NEVER APPEND. Publishing NM and LP concurrently, with each reading the list and adding
 * itself, is a lost update: one condition silently disappears from the PDP with no error anywhere.
 * Deriving the whole list from the database instead makes this idempotent, self-healing (it repairs a
 * list that drifted for any reason, including a publish that failed halfway), and coalescing — ten
 * sibling publishes collapse to one correct write.
 *
 * `listings` is list.product_reference, and metaobject field values are STRINGS, so the wire format is
 * a JSON-encoded array of product GIDs. Sending a bare array would be rejected; sending a
 * comma-joined string would be accepted and then read as one malformed reference.
 */
export async function rebuildIdentity(env, db, { identityHandle, store = 'dev', fetchImpl } = {}) {
  if (!identityHandle) return { ok: false, error: 'no identity handle' };

  // Only LIVE products belong on the selector. A pending or failed row has no product to point at, and
  // an ended one is a condition we no longer sell — listing it would render a tile leading nowhere.
  const rows = db.prepare(`
    SELECT sl.sku, sl.product_gid, i.condition
      FROM shopify_listings sl
      LEFT JOIN inventory_items i ON i.id = sl.item_id
     WHERE sl.identity_handle = ? AND sl.product_gid IS NOT NULL AND sl.state = 'live'
  `).all(identityHandle);

  const ordered = rows
    .slice()
    .sort((a, b) => conditionRank(a.condition) - conditionRank(b.condition) || String(a.sku).localeCompare(String(b.sku)))
    .map((r) => r.product_gid);

  const res = await shopifyGraphQL(env, IDENTITY_UPSERT, {
    handle: { type: 'bk_card_identity', handle: identityHandle },
    metaobject: { fields: [{ key: 'listings', value: JSON.stringify(ordered) }] },
  }, { store, fetchImpl, estimate: 10 });

  return { ok: res.ok, count: ordered.length, listings: ordered, error: res.ok ? null : firstErrorText(res), res };
}

// --- the mirror ------------------------------------------------------------------------------------

// T17: the audit copy must never carry a staged-upload signature or policy. Those are short-lived
// credentials for a GCS bucket, and Golden Rule 2 does not stop applying because the value came back
// from Shopify rather than out of .env.
// ⚠ `key` IS DELIBERATELY NOT IN THIS LIST, and that is the correction rather than the oversight.
// Shopify's staged-upload parameters arrive as {name, value} pairs — the secret travels in `name`, not
// as a property called `key` — while EVERY metafield in a ProductSetInput is literally
// { namespace, key, value, type }. Matching the property name `key` therefore scrubbed all fourteen bkc
// metafield keys, including custom.id (the upsert key), turning the audit column into noise, while
// redacting no secret at all. A scrubber that damages the evidence and protects nothing is worse than
// none, because it reads as though the payload was checked.
//
// The staged parameters do not reach this function today — `raw` is the ProductSetInput, and staging
// happens in shopify-media.mjs — so these patterns are defence in depth against a future caller that
// stores a staged-upload response, matched on both the property name and the {name, value} shape.
const SECRET_NAMES = /^(signature|policy|x-goog-signature|x-goog-credential|x-goog-algorithm|x-goog-date|googleaccessid)$/i;
export function scrubForAudit(v) {
  if (Array.isArray(v)) return v.map(scrubForAudit);
  if (v && typeof v === 'object') {
    // The {name, value} pair form, which is how a staged target actually carries its policy.
    if (typeof v.name === 'string' && 'value' in v && SECRET_NAMES.test(v.name)) return { ...v, value: '[scrubbed]' };
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_NAMES.test(k) ? '[scrubbed]' : scrubForAudit(x)]));
  }
  return v;
}

export function recordShopifyListing(db, row) {
  db.prepare(`
    INSERT INTO shopify_listings
      (sku, kind, item_id, product_gid, variant_gid, inventory_gid, location_gid, identity_gid,
       identity_handle, handle, state, published_at, price_cents, available_qty, last_synced_at, error, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?)
    ON CONFLICT(sku) DO UPDATE SET
      kind = excluded.kind, item_id = excluded.item_id,
      -- COALESCE on every id, because a FAILED attempt carries none of them and must not erase what a
      -- previous SUCCESSFUL publish recorded. A republish that fails does not un-create the product:
      -- nulling product_gid here would lose our only handle on a product that is still live and still
      -- selling, and — because identity.rebuild selects on product_gid IS NOT NULL AND state='live' —
      -- would delete a genuinely for-sale condition from the PDP's selector on the next rebuild.
      product_gid = COALESCE(excluded.product_gid, shopify_listings.product_gid),
      variant_gid = COALESCE(excluded.variant_gid, shopify_listings.variant_gid),
      inventory_gid = COALESCE(excluded.inventory_gid, shopify_listings.inventory_gid),
      location_gid = COALESCE(excluded.location_gid, shopify_listings.location_gid),
      identity_gid = COALESCE(excluded.identity_gid, shopify_listings.identity_gid),
      identity_handle = COALESCE(excluded.identity_handle, shopify_listings.identity_handle),
      handle = COALESCE(excluded.handle, shopify_listings.handle),
      -- A row that was LIVE stays live when a later attempt fails, because the product IS still live —
      -- a failed republish publishes nothing and unpublishes nothing. The error column carries what
      -- went wrong. Demoting to 'failed' here would be the ledger lying in the more dangerous
      -- direction: it would read as "not for sale" about a card a customer can still buy.
      -- 'pending' is in this list too, not just 'failed': the claim row written at the START of a
      -- republish would otherwise demote a live row itself, and the failure that followed would then
      -- find nothing left to protect. Neither a claim nor a failure unpublishes anything.
      state = CASE WHEN shopify_listings.state = 'live' AND excluded.state IN ('failed', 'pending')
                   THEN 'live' ELSE excluded.state END,
      published_at = COALESCE(excluded.published_at, shopify_listings.published_at),
      price_cents = COALESCE(excluded.price_cents, shopify_listings.price_cents),
      available_qty = COALESCE(excluded.available_qty, shopify_listings.available_qty),
      last_synced_at = excluded.last_synced_at, error = excluded.error,
      raw = COALESCE(excluded.raw, shopify_listings.raw),
      updated_at = datetime('now')
  `).run(
    row.sku, row.kind || 'inventory', row.item_id ?? null, row.product_gid ?? null, row.variant_gid ?? null,
    row.inventory_gid ?? null, row.location_gid ?? null, row.identity_gid ?? null, row.identity_handle ?? null,
    row.handle ?? null, row.state || 'pending',
    // published_at is set ONLY by a publishablePublish that actually succeeded. It is the field that
    // answers "is this really for sale", and a row that lies about it makes the whole ledger unusable.
    row.state === 'live' ? (row.published_at || new Date().toISOString()) : (row.published_at ?? null),
    row.price_cents ?? null, row.available_qty ?? null, row.error ?? null,
    row.raw ? JSON.stringify(scrubForAudit(row.raw)).slice(0, 20000) : null,
  );
}

// --- the publish ------------------------------------------------------------------------------------

/**
 * Compose the Shopify frames by self-fetching the image lab's own /build route.
 *
 * Deliberately HTTP rather than a direct call: the compositor's render+manifest logic lives inside that
 * route handler and is not factored out, and lib/listing-image-lab.mjs is on the eBay publish path.
 * Refactoring it to share a function is the right eventual move and the wrong move to make in the same
 * change that first writes to Shopify — eBay is the business until the storefront opens. lib/listings.mjs
 * already self-fetches a sibling API for comps, so the shape is precedented rather than novel.
 */
async function composeFrames({ base, item, sku, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const productType = (item.graded || item.grading_company) ? 'slab' : 'single';
  const body = {
    stockRow: item, sku,
    targets: [productType === 'slab' ? 'shopify-card' : 'shopify-card', 'og-card'],
    viewFor: { 'og-card': 'og' },
  };
  let r;
  try { r = await doFetch(`${base}/api/listing-image/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { return { ok: false, error: 'compose: ' + (e?.message || e) }; }
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!r.ok || !json?.manifest) {
    return { ok: false, error: 'compose: ' + (json?.error || `HTTP ${r.status}`), warnings: json?.warnings || [] };
  }
  return { ok: true, manifest: json.manifest, warnings: json.warnings || [] };
}

/**
 * runShopifyPublish — item id in, live product out.
 *
 * The order below is not arbitrary. The shelf label is RESERVED before anything and COMMITTED only
 * after Shopify confirms, because the label becomes the variant SKU — the string the theme keys on and
 * every order line carries — and once an order exists against it, it can never be renamed. Six labels
 * were burned once by previews that never published; a reservation that a dry run does not spend is the
 * fix, and it now has to hold across two channels rather than one.
 */
export async function runShopifyPublish({ env, db, base, cfg, item, store = 'dev', dryRun = false, fetchImpl } = {}) {
  const steps = [];
  const warnings = [];
  if (!item) return { ok: false, error: 'no such item', steps };

  const pins = pinsFor(cfg, store);
  if (pins.missing.length) return { ok: false, error: `not pinned: ${pins.missing.join(', ')}`, code: 'not_ready', steps };

  // 1 — the SKU. Reserved, not spent: a dry run must leave the sequence exactly where it found it.
  // ALWAYS PEEK, even on a dry run — and note that this passes dryRun:false deliberately.
  //
  // reserveShelfLabel only PEEKS; peekStockLabel is a pure SELECT walk and commitStockLabel is the only
  // thing that moves the counter. So peeking here costs nothing and buys the thing a dry run is for: a
  // payload showing AAC-097, the sku that would really be sent, rather than the STG-* placeholder that
  // never would. The variant sku and the customId are the two most consequential fields in the whole
  // input, and a preview that shows the wrong value for both is worse than no preview.
  //
  // `held` is the WRAPPER { ok, sku, reservation, error }; the inner `.reservation` is the peeked label
  // and is what commitShelfLabel takes. It is null when nothing needs spending — a row that already
  // carries a real label — and commitShelfLabel treats null as a no-op, so that case needs no branch.
  // Nothing below commits on a dry run, so the counter still cannot move.
  let held = reserveShelfLabel(db, item, { dryRun: false, channel: 'shopify' });
  if (!held.ok && dryRun) {
    // An unseeded label series must not stop someone LOOKING at the payload — that is exactly when
    // they are trying to work out what is wrong (GR7: degrade visibly, never guess).
    warnings.push(held.error || 'no shelf label could be peeked');
    held = { ok: true, sku: item.sku, reservation: null };
  }
  if (!held.ok || !held.sku) return { ok: false, error: held.error || 'could not reserve a shelf label', steps };
  const row = mergeCardFacts({ ...item, sku: held.sku });
  steps.push({ step: 'shelf_label', ok: true, sku: held.sku, willSpend: !!held.reservation });

  // CLAIM THE LABEL NOW, before anything can take time. Peeking is read-only, so between the peek and
  // the commit there are three awaits (compose, media, the publish sequence) during which the label
  // reads free to anyone else — and labelTaken now consults this table, so writing the row IS the
  // claim. Without it, two overlapping publishes peek the same number and the second one's productSet
  // silently overwrites the first one's product, because the label is the upsert key.
  //
  // 'pending' rather than 'live': nothing has been sent yet, and a row that overstates itself is worse
  // than no row. Every later write updates this same row by sku.
  if (!dryRun) recordShopifyListing(db, { sku: held.sku, kind: 'inventory', item_id: item.id, state: 'pending' });

  // 2 — VALIDATE BEFORE UPLOADING ANYTHING. publishProduct validates too, but it does so after this
  // function has already staged and registered files, and a Shopify file is permanent with no bulk
  // delete. A row the v1 scope gate refuses — a sealed product, a non-Pokémon game, a card with no
  // identity — would otherwise leave two orphans on the store for every attempt. Cheap check, first.
  const product = toShopifyProduct(row, { collections: collectionGidsFor(cfg, row), status: publishStatus(cfg) });
  const pre = validateProduct(product, row);
  steps.push({ step: 'validate', ok: !pre.errors.length, error: pre.errors.join('; ') || null, warnings: pre.warnings });
  if (pre.errors.length) return { ok: false, error: 'validation: ' + pre.errors.join('; '), steps, warnings };

  // 3 — the frames. A publish with no images is not a product anyone would buy, but losing a LATER
  // frame is survivable and the media layer already draws that line (position 1 is an error, the rest
  // are warnings), so its verdict is taken as-is rather than second-guessed here.
  let fileGids = [], ogFileGid = null;
  if (!dryRun) {
    const composed = await composeFrames({ base, item: row, sku: held.sku, fetchImpl });
    steps.push({ step: 'compose', ok: composed.ok, error: composed.error || null });
    if (composed.warnings?.length) warnings.push(...composed.warnings);
    if (!composed.ok) return { ok: false, error: composed.error, steps, warnings };

    const media = await ensureShopifyMedia(env, db, { imageSet: composed.manifest, store, fetchImpl });
    steps.push({ step: 'media', ok: media.ok, error: media.errors.join('; ') || null, uploaded: media.uploaded, reused: media.reused, adopted: media.adopted });
    if (media.warnings.length) warnings.push(...media.warnings);
    if (!media.ok) return { ok: false, error: 'media: ' + media.errors.join('; '), steps, warnings };
    ({ fileGids, ogFileGid } = media);
  }

  // 4 — the sequence. `product` was mapped above so it could be validated before any upload.
  const result = await publishProduct(env, {
    product, fileGids, ogFileGid,
    locationGid: pins.locationGid, publicationGid: pins.publicationGid,
    store, fetchImpl, dryRun, item: row,
  });
  steps.push(...(result.steps || []));
  if (result.warnings?.length) warnings.push(...result.warnings);

  if (dryRun) return { ...result, sku: held.sku, steps, warnings, dryRun: true };

  // 4 — the ledger. A FAILED publish is recorded too: a row that quietly vanishes on failure is a row
  // nobody retries, and the error belongs where someone will look for it.
  recordShopifyListing(db, {
    sku: held.sku, kind: 'inventory', item_id: item.id,
    product_gid: result.productGid ?? null, variant_gid: result.variantGid ?? null,
    inventory_gid: result.inventoryItemGid ?? null, location_gid: pins.locationGid,
    identity_gid: result.identityGid ?? null, identity_handle: product.identityHandle,
    handle: result.handle ?? product.handle,
    state: result.ok ? 'live' : 'failed',
    price_cents: product.price_cents, available_qty: result.ok ? result.quantity : null,
    error: result.ok ? null : result.error, raw: result.input || null,
  });
  steps.push({ step: 'mirror', ok: true });

  if (!result.ok) return { ...result, sku: held.sku, steps, warnings };

  // 5 — the label is spent only now, on a real confirmed publish on a real channel.
  const spent = commitShelfLabel(db, item, held.reservation, { channel: 'shopify' });
  steps.push({ step: 'shelf_label_commit', ok: !spent.error, sku: held.sku, committed: spent.committed, error: spent.error || null });
  if (spent.error) warnings.push(`the product is LIVE as ${held.sku} but the stock row still holds ${spent.provisional} — commit the label by hand (${spent.error})`);

  // 6 — the condition selector. Recomputed AFTER the mirror row exists, because it reads the mirror:
  // rebuilding first would produce a list that is correct about everything except the card just
  // published. A failure here degrades the PDP's grouping, not the listing, so it warns.
  const rebuilt = await rebuildIdentity(env, db, { identityHandle: product.identityHandle, store, fetchImpl });
  steps.push({ step: 'identity_rebuild', ok: rebuilt.ok, error: rebuilt.error || null, count: rebuilt.count });
  if (!rebuilt.ok) warnings.push(`the card identity list was not rebuilt (${rebuilt.error}) — the PDP condition selector may be missing a condition until it is re-run`);

  return { ...result, sku: held.sku, identityHandle: product.identityHandle, steps, warnings };
}

/**
 * inventory_items has no set_code column — the printed set code lives inside the card_facts JSON blob,
 * along with the rest of the non-English provenance the intl normaliser writes. lib/listings.mjs:288
 * merges it before mapping for exactly this reason; handing the raw row to toShopifyProduct instead
 * loses it, which costs the bkc.set_code metafield (and with it the automated per-set collections that
 * D-016/D-027 key on it) and mis-picks the rail art for a Japanese card.
 *
 * The blob loses to explicit columns, never the other way round: a value someone typed into the row
 * beats one that was derived at scan time.
 */
export function mergeCardFacts(item) {
  if (!item?.card_facts) return item;
  try {
    const facts = JSON.parse(item.card_facts);
    const out = { ...facts, ...item };
    for (const [k, v] of Object.entries(facts)) {
      if (out[k] == null || out[k] === '') out[k] = v;
    }
    return out;
  } catch { return item; }   // a malformed blob is not a reason to refuse a card (GR7)
}

// The documented first-run safety valve. Anything other than DRAFT means ACTIVE — an unrecognised
// value must not silently produce an unbuyable store.
function publishStatus(cfg) {
  return String((cfg.publish || {}).status || '').toUpperCase() === 'DRAFT' ? 'DRAFT' : 'ACTIVE';
}

function collectionGidsFor(cfg, item) {
  const c = cfg.collections || {};
  return {
    byGame: c.byGame || {},
    bySet: c.bySet || {},
    japaneseImports: String(c.japaneseImports || '').trim() || null,
  };
}

// --- the router -------------------------------------------------------------------------------------

export function makeShopifyRouter({ env, db, base, fetchImpl } = {}) {
  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const cfg = loadConfig();
      const store = storeFor(cfg, url);
      let m;

      // GET /config — what is pinned, what is armed, and which store we would write to. No secrets:
      // the shop DOMAIN is printed (it is on every storefront URL), the credentials are not.
      if (p === '/config' && method === 'GET') {
        let shop = null;
        try { shop = resolveShop(env, store); } catch { /* absent credentials are reported as connected:false */ }
        const pins = pinsFor(cfg, store);
        return send(res, 200, {
          config: stripComments(cfg), store, shop, connected: !!shop, apiVersion: API_VERSION,
          pins: { locationGid: pins.locationGid, publicationGid: pins.publicationGid, missing: pins.missing },
          publishEnabled: !!(cfg.publish || {}).enabled,
          syncEnabled: !!(cfg.sync || {}).enabled,
        });
      }

      // GET /status — VERIFY the pins rather than trust them. A location that stopped shipping
      // inventory, or a publication that was deleted, both read as a perfectly healthy config file and
      // are only discovered at publish time otherwise. Modelled on verifyBandPolicies.
      if (p === '/status' && method === 'GET') {
        if (!guardCredentials(env, store, res)) return;
        const pins = pinsFor(cfg, store);
        const q = await shopifyGraphQL(env, `
          query BkVerify($loc: ID!, $pub: ID!) {
            location: node(id: $loc) { ... on Location { id name isActive fulfillsOnlineOrders shipsInventory } }
            publication: node(id: $pub) { ... on Publication { id name } }
          }`, { loc: pins.locationGid || 'gid://shopify/Location/0', pub: pins.publicationGid || 'gid://shopify/Publication/0' },
        { store, fetchImpl, estimate: 10 });

        const loc = q.ok ? q.data?.location : null;
        const pub = q.ok ? q.data?.publication : null;
        const locationOk = !!(loc && loc.isActive && loc.fulfillsOnlineOrders && loc.shipsInventory);
        const problems = [
          ...pins.missing.map((k) => `${k} is not pinned`),
          !q.ok && `could not read the store: ${firstErrorText(q) || 'HTTP ' + q.httpStatus}`,
          q.ok && !loc && 'the pinned location does not exist on this store',
          loc && !locationOk && `the pinned location "${loc.name}" cannot hold sellable stock (active=${loc.isActive} online=${loc.fulfillsOnlineOrders} ships=${loc.shipsInventory})`,
          q.ok && !pub && 'the pinned publication does not exist on this store',
        ].filter(Boolean);

        return send(res, 200, {
          store, ready: problems.length === 0, problems,
          location: loc || null, publication: pub || null,
          publishEnabled: !!(cfg.publish || {}).enabled,
        });
      }

      // POST /preview — LOCAL ONLY. There is no Shopify dry run: productSet on a real identifier
      // creates a real product, and getListingFees has no analogue here. So this maps, validates and
      // returns the exact payload, and calls nothing. It deliberately runs without credentials or pins,
      // because "show me what you would send" is most useful precisely when something is misconfigured.
      if (p === '/preview' && method === 'POST') {
        const b = await readJson(req);
        const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(+b.itemId);
        if (!item) return send(res, 404, { error: 'no such stock item: ' + b.itemId });
        // dryRun:false to PEEK the real label — read-only, nothing is spent unless commitShelfLabel
        // runs, and it never does on this route. See the note in runShopifyPublish.
        const peek = reserveShelfLabel(db, item, { dryRun: false, channel: 'shopify' });
        const row = mergeCardFacts({ ...item, sku: peek.sku || item.sku });
        const product = toShopifyProduct(row, { collections: collectionGidsFor(cfg, row) });
        const v = validateProduct(product, row);
        const pins = pinsFor(cfg, store);
        return send(res, 200, {
          sku: row.sku, ok: !v.errors.length, errors: v.errors, warnings: v.warnings,
          identityHandle: product.identityHandle, handle: product.handle, title: product.title,
          identifier: { customId: product.customId },
          // No files, and that is not an oversight: staging media IS a write, and a preview that
          // uploaded four frames to prove what it would upload would be a publish in all but name.
          // The `files` key is therefore absent here and present on a real publish.
          input: buildProductSetInput(product, { fileGids: [], ogFileGid: null }),
          identity: product.identity,
          wouldPublishTo: { store, locationGid: pins.locationGid, publicationGid: pins.publicationGid },
        });
      }

      // POST /publish { itemId, dryRun? } — the real thing.
      if (p === '/publish' && method === 'POST') {
        const b = await readJson(req);
        const dryRun = !!b.dryRun;
        if (!guardCredentials(env, store, res)) return;
        if (!guardPins(cfg, store, res)) return;
        if (!dryRun && !guardPublishEnabled(cfg, res)) return;
        const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(+b.itemId);
        if (!item) return send(res, 404, { error: 'no such stock item: ' + b.itemId });
        const out = await runShopifyPublish({ env, db, base, cfg, item, store, dryRun, fetchImpl });
        return send(res, out.ok ? 200 : 502, out);
      }

      // POST /identity/rebuild { handle | itemId } — recompute one identity's condition list.
      // Exposed on its own because it is the repair for a PDP whose tiles went wrong, and because it is
      // safe to run at any time: it derives everything from tracker.db and writes the list whole.
      if (p === '/identity/rebuild' && method === 'POST') {
        const b = await readJson(req);
        if (!guardCredentials(env, store, res)) return;
        let handle = String(b.handle || '').trim();
        if (!handle && b.itemId != null) {
          const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(+b.itemId);
          if (!item) return send(res, 404, { error: 'no such stock item: ' + b.itemId });
          // The RECORDED handle wins over a re-derived one. db.mjs documents why the column exists:
          // re-deriving from inventory_items columns that may have been edited since the publish would
          // rebuild the wrong identity and leave the real one still holding this product. Falling back
          // to derivation is right only when the card has never been published.
          const mirrorRow = db.prepare('SELECT identity_handle FROM shopify_listings WHERE item_id = ? AND identity_handle IS NOT NULL ORDER BY updated_at DESC LIMIT 1').get(item.id);
          handle = mirrorRow?.identity_handle || identityHandleFor(mergeCardFacts(item));
        }
        if (!handle) return send(res, 400, { error: 'pass a handle or an itemId' });
        const out = await rebuildIdentity(env, db, { identityHandle: handle, store, fetchImpl });
        return send(res, out.ok ? 200 : 502, { handle, ...out, res: undefined });
      }

      // GET /listing/:sku — the mirror row, for "what does Shopify think this is".
      if ((m = p.match(/^\/listing\/([A-Za-z0-9_-]+)$/)) && method === 'GET') {
        const mirror = db.prepare('SELECT * FROM shopify_listings WHERE sku = ?').get(m[1]);
        if (!mirror) return send(res, 404, { error: 'no Shopify listing recorded for ' + m[1] });
        return send(res, 200, { mirror });
      }

      return send(res, 404, { error: 'unknown route', code: 'unknown_route', path: p });
    } catch (e) {
      console.error('[api/shopify] error:', e?.message || e);
      return send(res, 500, { error: 'shopify error', detail: String(e?.message || e) });
    }
  };
}

// --- the plugin --------------------------------------------------------------------------------------

export function shopifyPlugin(env) {
  return {
    name: 'shopify',
    configureServer(server) {
      // The whole body, because everything in it can fail on a machine that has never run this before —
      // a missing data/ directory, an unreadable config, a migration mid-flight — and none of those are
      // worth taking the eBay tooling down for. A plugin that cannot start still answers, with why.
      try {
        ensureConfigSeeded();
        const db = openDb();
        const port = server.config?.server?.port || 5273;
        const base = `http://127.0.0.1:${port}`;
        server.middlewares.use('/api/shopify', makeShopifyRouter({ env, db, base }));
        const cfg = loadConfig();
        const store = cfg.defaultStore || 'dev';
        const pins = pinsFor(cfg, store);
        console.log(`[shopify] API /api/shopify · store ${store} · ${pins.missing.length ? 'NOT pinned (' + pins.missing.join(', ') + ')' : 'pinned'} · publish ${(cfg.publish || {}).enabled ? 'ARMED' : 'off'}`);
      } catch (e) {
        console.error('[shopify] plugin failed to start —', e?.message || e);
        server.middlewares.use('/api/shopify', (req, res) => send(res, 503, {
          error: 'the Shopify plugin failed to start', code: 'plugin_failed', detail: String(e?.message || e),
        }));
      }
    },
  };
}
