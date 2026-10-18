// lib/channel-sync.mjs — the worker that takes a sold card off every other channel.
//
// lib/channel-presence.mjs decides WHAT to do and queues it in sync_jobs; this file does it. Every job
// is "bring this one listing down to what the shelf still holds", and the three rules below are why it
// can run unattended against live listings.
//
//   1. IT NEVER RAISES. A channel at or below the shelf count is left exactly where it is. A cancelled
//      sale coming back to the shelf does not put a card back on sale anywhere — relisting is a person's
//      decision, made through the publish tools, which carry their own refusals.
//   2. THE NUMBER IS READ WHEN THE JOB RUNS, from the stock row and from the channel, never from the
//      queue. A job that waited out three more sales still writes the right number, and running it twice
//      is a no-op the second time.
//   3. NOTHING FAILS QUIETLY. A failed write backs off and retries; after the last attempt the job is
//      'dead', logged at error level and sent to Telegram, because a card that is still live on eBay
//      after it sold at a show is exactly the incident this exists to prevent. A channel that is not
//      connected leaves the job QUEUED as blocked rather than spending its attempts.
//
// Shelf count = on-hand units, 0 for a sold row (lib/runs-reserve.mjs onHandUnits). Deliberately not
// net of Run reservations for singles: reviseTradingListing writes eBay's read-back into the stock row
// as a 'correction', so a target net of a reservation would be written back as the shelf count and
// lose the reserved units. A reserved single cannot be live anyway — lockRun refuses while one is.
// Sealed pools use poolUnits, which is what the pool publish itself sends.
import {
  migrateChannelSync, getSyncMeta, setSyncMeta, scanMovements, enqueueChannelSync,
  ebayPresence, shopifyPresence, JOB_EBAY, JOB_SHOPIFY, awayUnits, awayPoolUnits, recordEventTarget, MODES,
} from './channel-presence.mjs';
import { onHandUnits } from './runs-reserve.mjs';
import { poolUnits, publishSealedPool } from './sealed-listing.mjs';
import { withdrawOffer, getOffer } from './channels/ebay-inventory-api.mjs';
import { getListingState, endFixedPriceItem, tradingCall, buildReviseInventoryStatusInner, getOutOfStockControl } from './ebay-trading.mjs';
import { ebayRest } from './ebay-rest.mjs';
import { reviseTradingListing, runPublish, loadConfig as loadListingConfig, saveConfig as saveListingConfig } from './listings.mjs';
import { setAvailableQty } from './channels/shopify-product-api.mjs';
import { resolveShop } from './channels/shopify-admin.mjs';
import { oauthStatus } from './ebay-oauth.mjs';
import { sendMessage, telegramEnabled, telegramChatConfigured, escapeHtml } from './telegram.mjs';

export const MAX_ATTEMPTS = 6;
export const LEASE_MIN = 5;
const BACKOFF_MIN = [1, 2, 4, 8, 16, 32];
const JOB_KINDS = [JOB_EBAY, JOB_SHOPIFY];
const JOB_KINDS_SQL = JOB_KINDS.map((k) => `'${k}'`).join(',');

// --- dependencies ----------------------------------------------------------------------------------
//
// The dependency-by-argument seam this repo uses for offline tests. The defaults are the real calls;
// a test stubs globalThis.fetch (eBay) or passes fetchImpl (Shopify) and keeps these, so what is under
// test is the real write path rather than a mock of it.
export function defaultDeps() {
  return {
    withdrawOffer, getOffer, getListingState, endFixedPriceItem, reviseTradingListing, runPublish,
    publishSealedPool, setAvailableQty, loadListingConfig, saveListingConfig, tradingCall, setOfferQuantity, getOutOfStockControl,
    ebayConnected: (env) => { try { return !!oauthStatus(env).connected; } catch { return false; } },
    shopifyConfigured: (env) => {
      try { resolveShop(env, 'live'); } catch { return false; }
      return !!(String(env.SHOPIFY_CLIENT_ID || '').trim() && String(env.SHOPIFY_CLIENT_SECRET || '').trim());
    },
    alert: defaultAlert,
    fetchImpl: undefined,
  };
}

async function defaultAlert(env, text) {
  try {
    if (!telegramEnabled(env) || !telegramChatConfigured(env)) return { skipped: 'no_telegram' };
    return await sendMessage(env, { chatId: env.TELEGRAM_CHAT_ID, text });
  } catch (e) { console.warn('[channel-sync] alert failed —', e?.message || e); return { ok: false }; }
}

// --- the shelf count -------------------------------------------------------------------------------

/**
 * What the channel may offer, computed NOW: what is held, minus what is away at a show.
 * `held` is also what tells a hide from an end — a channel brought to 0 while units are still held is
 * HIDDEN (they are at a show and coming back); at 0 with nothing held, the stock SOLD and the listing ends.
 */
export function shelf(db, payload) {
  const t = payload.target || {};
  if (payload.kind === 'sealed' && (t.api === 'pool' || t.api === 'shopify')) {
    const held = payload.pool_sku ? poolUnits(db, payload.pool_sku) : 0;
    const away = payload.pool_sku ? awayPoolUnits(db, payload.pool_sku) : 0;
    return { held, away, target: Math.max(0, held - away) };
  }
  const kind = payload.kind === 'sealed' ? 'sealed' : 'inventory';
  const held = onHandUnits(db, kind, payload.item_id);
  const away = awayUnits(db, kind, payload.item_id);
  return { held, away, target: Math.max(0, held - away) };
}
export const shelfTarget = (db, payload) => shelf(db, payload).target;

const describe = (payload) => {
  const t = payload.target || {};
  const row = payload.kind === 'sealed' ? (payload.pool_sku || `sealed #${payload.item_id}`) : `item #${payload.item_id}`;
  if (t.api === 'inventory') return `${row} — eBay offer ${t.offer_id}`;
  if (t.api === 'trading') return `${row} — eBay listing ${t.listing_id}`;
  if (t.api === 'pool') return `${t.pool_sku} — eBay pool offer ${t.offer_id}`;
  return `${t.sku} — Shopify (live)`;
};

// --- eBay ------------------------------------------------------------------------------------------

function auditPush(db, { itemId, sku, action, offerId = null, listingId = null, status = 'ok', error = null, response = null }) {
  try {
    db.prepare(`INSERT INTO listing_pushes (item_id, sku, action, offer_id, listing_id, status, error, response)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(itemId ?? null, sku ?? null, action, offerId, listingId, status, error, response ? JSON.stringify(response) : null);
  } catch (e) { console.warn('[channel-sync] audit write failed —', e?.message || e); }
}

/**
 * endTradingListing — end a HAND-MADE listing because the stock is gone. Preflight, write, verify.
 *
 * The twin of reviseTradingListing (lib/listings.mjs) for the one quantity that call refuses: zero.
 * Refuses a listing the tool published (those end through withdrawOffer, and eBay blocks Trading calls
 * on Inventory-model listings), an auction, and a multi-variation listing (ending it would end every
 * variation, not the one card). eBay is read before AND after: the mirror is only as fresh as the last
 * import, and "ended" is only true once eBay says so.
 */
export async function endTradingListing(env, db, { listingId, deps = defaultDeps() } = {}) {
  const id = String(listingId || '').trim();
  const refuse = (error, code) => ({ ok: false, refused: true, error, code });
  if (!id) return refuse('no listing id', 'no_listing');
  const row = db.prepare('SELECT * FROM ebay_seller_listings WHERE listing_id = ?').get(id);
  if (row && row.created_via === 'tool') return refuse('this listing was published by the tool — it ends through the Inventory API', 'wrong_api');

  const live = await deps.getListingState(env, id);
  if (!live.ok) return { ok: false, error: 'could not read the listing from eBay: ' + live.error };
  if (live.listing_status && live.listing_status !== 'Active') {
    markTradingEnded(db, id, live);
    return { ok: true, action: 'already_ended', listing_status: live.listing_status };
  }
  if (live.listing_type && live.listing_type !== 'FixedPriceItem') {
    return refuse(`this is a ${live.listing_type} listing, not fixed price — end it by hand in Seller Hub`, 'not_fixed_price');
  }
  if (live.has_variations) {
    return refuse('this listing has variations, and ending it would end all of them — fix it by hand in Seller Hub', 'has_variations');
  }

  const res = await deps.endFixedPriceItem(env, { itemId: id, reason: 'NotAvailable' });
  if (!res.ok) {
    const e = (res.errors && res.errors[0]) || {};
    // 1047 "Auction has been closed" — it ended between our read and our write (it sold, most likely).
    if (String(e.code || e.errorCode || '') === '1047' || /closed|already ended/i.test(e.longMessage || e.shortMessage || '')) {
      markTradingEnded(db, id, { listing_status: 'Completed' });
      return { ok: true, action: 'already_ended' };
    }
    return { ok: false, error: 'eBay refused to end the listing: ' + (e.longMessage || e.shortMessage || 'HTTP ' + res.httpStatus), errors: res.errors };
  }
  const after = await deps.getListingState(env, id);
  const ended = after.ok ? after.listing_status !== 'Active' : true;
  if (!ended) return { ok: false, error: 'eBay accepted the end but the listing still reads Active — check it in Seller Hub' };
  markTradingEnded(db, id, after.ok ? after : { listing_status: 'Completed' });
  return { ok: true, action: 'ended', endTime: res.endTime || null, verified: after.ok };
}

function markTradingEnded(db, listingId, live) {
  db.prepare(`UPDATE ebay_seller_listings SET state = 'ended', available_qty = 0, last_seen_at = datetime('now')
              WHERE listing_id = ? AND state = 'active'`).run(listingId);
  // The stock row's channel flag follows, wherever it is linked from. Never its status: whether the card
  // is sold or back on the shelf is the stock ledger's business, not the listing's.
  const linked = db.prepare('SELECT item_id FROM ebay_seller_listings WHERE listing_id = ?').get(listingId);
  if (linked && linked.item_id) {
    db.prepare(`UPDATE inventory_items SET channel_status = 'ended', updated_at = datetime('now')
                WHERE id = ? AND channel_status = 'active' AND (ebay_offer_id IS NULL OR ebay_listing_id = ?)`).run(linked.item_id, listingId);
  }
  db.prepare(`UPDATE inventory_items SET channel_status = 'ended', updated_at = datetime('now')
              WHERE ebay_listing_id = ? AND channel_status = 'active' AND ebay_offer_id IS NULL`).run(listingId);
  db.prepare(`UPDATE sealed_items SET channel_status = 'ended', updated_at = datetime('now')
              WHERE ebay_listing_id = ? AND channel_status = 'active'`).run(listingId);
  void live;
}

// --- quantity-only writes (the show flow: hide at 0, restore after) -------------------------------
//
// Neither existing eBay write fits a show. reviseTradingListing writes eBay's read-back INTO THE STOCK ROW
// as a 'correction' — right when eBay is the truth, wrong when the channel is deliberately lower than the
// shelf because units are at a show: it would file the away units as lost. runPublish re-sends the shelf
// count and refuses a quantity of 0 outright. So both writes below change ONE number on eBay, verify it
// from eBay, update the mirror, and never touch the stock ledger.

/**
 * setOfferQuantity — an Inventory-API listing (a single the tool published, or a sealed pool) to exactly
 * `quantity`, through bulkUpdatePriceQuantity (inventory item + offer in one call, nothing else sent).
 * ⚠ First use on this account (docs/SHOPIFY_CHANNEL_PLAN.md S0-1): the show flow runs one listing alone
 * as a canary and stops if the read-back disagrees.
 */
export async function setOfferQuantity(env, { sku, offerId, quantity }) {
  const q = Math.max(0, Math.floor(Number(quantity) || 0));
  const r = await ebayRest(env, 'POST', '/sell/inventory/v1/bulk_update_price_quantity', {
    body: { requests: [{ sku: String(sku), shipToLocationAvailability: { quantity: q }, offers: [{ offerId: String(offerId), availableQuantity: q }] }] },
  });
  const resp = (r.json && Array.isArray(r.json.responses)) ? r.json.responses : [];
  const bad = resp.filter((x) => Number(x.statusCode) >= 400 || (x.errors && x.errors.length));
  if (!r.ok || bad.length) {
    const e = (bad[0] && bad[0].errors && bad[0].errors[0]) || (r.json && r.json.errors && r.json.errors[0]) || {};
    return { ok: false, error: e.message || e.longMessage || ('HTTP ' + r.httpStatus) };
  }
  return { ok: true };
}

async function offerQuantityVerified(ctx, { sku, offerId, quantity }) {
  const { env, deps } = ctx;
  const w = await deps.setOfferQuantity(env, { sku, offerId, quantity });
  if (!w.ok) return { ok: false, error: 'eBay refused the quantity: ' + w.error };
  const o = await deps.getOffer(env, offerId);
  if (!o.ok) return { ok: false, error: 'eBay took the write but the read-back failed: ' + o.error, unverified: true };
  const st = String(o.listingStatus || '').toUpperCase();
  if (st === 'ENDED' || st === 'EBAY_ENDED') {
    // The one outcome the owner chose against: hiding must never END a listing. If eBay ended it, the
    // out-of-stock option is not doing what we read it as doing, and nothing more may be sent.
    return { ok: false, permanent: true, ended: true, error: `eBay ENDED the listing instead of hiding it (status ${st}) — check the out-of-stock option in Seller Hub before anything else is taken offline` };
  }
  if (o.availableQuantity != null && Number(o.availableQuantity) !== quantity) {
    return { ok: false, error: `eBay reads ${o.availableQuantity} available after setting ${quantity}` };
  }
  return { ok: true, status: st || null };
}

/**
 * setTradingQuantity — a HAND-MADE listing to exactly `quantity` (0 allowed: the out-of-stock option keeps
 * the listing alive and hidden). Preflight, write, verify; the mirror follows; the stock row does NOT.
 */
export async function setTradingQuantity(env, db, { listingId, quantity, deps }) {
  const id = String(listingId);
  const q = Math.max(0, Math.floor(Number(quantity) || 0));
  const row = db.prepare('SELECT created_via FROM ebay_seller_listings WHERE listing_id = ?').get(id);
  if (row && row.created_via === 'tool') return { ok: false, permanent: true, error: 'this listing was published by the tool — it goes through the Inventory API' };
  const live = await deps.getListingState(env, id);
  if (!live.ok) return { ok: false, error: 'could not read the listing from eBay: ' + live.error };
  if (live.listing_status && live.listing_status !== 'Active') return { ok: true, action: 'already_ended', listing_status: live.listing_status, from: 0 };
  if (live.listing_type && live.listing_type !== 'FixedPriceItem') return { ok: false, permanent: true, error: `a ${live.listing_type} listing cannot be hidden or restored by quantity — do it by hand in Seller Hub` };
  if (live.has_variations) return { ok: false, permanent: true, error: 'a multi-variation listing cannot be hidden by quantity — do it by hand in Seller Hub' };
  const from = live.available_qty;
  if (from === q) return { ok: true, action: 'noop', from, to: q };
  const res = await deps.tradingCall(env, 'ReviseInventoryStatus', buildReviseInventoryStatusInner({ itemId: id, availableQty: q }));
  if (!res.ok) {
    const e = (res.errors && res.errors[0]) || {};
    return { ok: false, permanent: q === 0, error: 'eBay refused quantity ' + q + ': ' + (e.longMessage || e.shortMessage || 'HTTP ' + res.httpStatus) };
  }
  const after = await deps.getListingState(env, id);
  if (!after.ok) return { ok: false, error: 'eBay took the write but the read-back failed: ' + after.error, unverified: true, from };
  if (after.listing_status && after.listing_status !== 'Active') {
    markTradingEnded(db, id, after);
    return { ok: false, permanent: true, ended: true, error: `eBay ENDED listing ${id} instead of hiding it — check the out-of-stock option in Seller Hub`, from };
  }
  if (after.available_qty !== q) return { ok: false, error: `eBay reads ${after.available_qty} available after setting ${q}`, from };
  // state too: eBay just said Active. A seller-listings import run while the listing sat hidden at 0 may
  // have filed it as ended, and a mirror left saying so would hide a live listing from every later sale.
  db.prepare(`UPDATE ebay_seller_listings SET available_qty = ?, quantity = ?, sold_qty = ?, state = 'active', last_seen_at = datetime('now') WHERE listing_id = ?`)
    .run(after.available_qty, after.quantity_total, after.sold_qty, id);
  return { ok: true, action: q < (from ?? 0) ? 'lowered' : 'raised', from, to: q };
}

// --- eBay ------------------------------------------------------------------------------------------

/**
 * Was this card's live eBay listing published with branded rails? Read off what the last successful
 * publish actually SENT (listing_pushes.request.imageUrls) against the image store, where a composed
 * frame carries a compose_hash. Not listing_images by item: a composed frame is shared by every copy of
 * a card, so only the first copy to upload it owns the row. true / false, or null when there is no
 * record to go on (the publish then falls back to its config default, as it always has).
 */
export function publishedComposed(db, itemId) {
  let row;
  try {
    row = db.prepare(`SELECT request FROM listing_pushes WHERE item_id = ? AND status = 'ok' AND action IN ('create','revise')
                       ORDER BY id DESC LIMIT 1`).get(+itemId);
  } catch { return null; }
  if (!row) return null;
  let urls = [];
  try { urls = ((JSON.parse(row.request || '{}') || {}).imageUrls || []).filter((u) => typeof u === 'string' && u); } catch { return null; }
  if (!urls.length) return null;
  const hit = db.prepare(`SELECT 1 FROM listing_images WHERE compose_hash IS NOT NULL AND eps_url IN (${urls.map(() => '?').join(',')}) LIMIT 1`).get(...urls);
  return !!hit;
}

async function runEbayJob(ctx, payload) {
  const { db, env, deps } = ctx;
  const t = payload.target || {};
  const mode = payload.mode || 'sale';
  const s = shelf(db, payload);
  // Restore puts back what the show took down — never more than was there before, never more than held.
  const want = mode === 'restore' ? Math.min(payload.pre_qty ?? 0, s.target) : s.target;
  const showMath = mode !== 'sale' || s.away > 0;   // channel deliberately below the shelf: quantity-only writes
  // Sold while it was away (at the table, or anywhere else): there is nothing to put back, and the
  // listing the sale ended is not "something to relist" — saying so would send the owner to relist a
  // card they no longer have.
  if (mode === 'restore' && s.held <= 0) return { ok: true, action: 'sold', note: 'sold while it was away — nothing to put back' };
  const gone = (note) => ({ ok: true, action: 'gone', note, ...(mode === 'restore' ? { attention: true } : {}) });

  if (t.api === 'inventory' || t.api === 'pool') {
    const isPool = t.api === 'pool';
    if (isPool) {
      const pool = db.prepare('SELECT pool_sku, ebay_offer_id FROM sealed_pools WHERE pool_sku = ?').get(String(t.pool_sku));
      if (!pool || String(pool.ebay_offer_id || '') !== String(t.offer_id)) return gone('the pool no longer carries this offer');
    } else {
      const item = db.prepare('SELECT id, ebay_offer_id FROM inventory_items WHERE id = ?').get(+payload.item_id);
      if (!item || String(item.ebay_offer_id || '') !== String(t.offer_id)) return gone('the stock row no longer carries this offer — nothing to change');
    }
    const o = await deps.getOffer(env, t.offer_id);
    if (!o.ok) return { ok: false, error: 'could not read the offer: ' + o.error };
    const status = String(o.listingStatus || '').toUpperCase();
    const from = o.availableQuantity != null ? Number(o.availableQuantity) : null;
    if (['ENDED', 'EBAY_ENDED', 'UNPUBLISHED'].includes(status)) {
      // The mirrors follow what eBay just said, so presence stops reporting a listing that is over (and
      // the one-channel refusal stops blocking a Shopify publish because of it).
      db.prepare(`UPDATE ebay_listings SET listing_status = ?, available_qty = 0, last_synced_at = datetime('now'), updated_at = datetime('now') WHERE offer_id = ?`).run(status, String(t.offer_id));
      if (isPool) {
        db.prepare(`UPDATE sealed_pools SET channel_status = 'ended', updated_at = datetime('now') WHERE pool_sku = ? AND channel_status = 'active'`).run(t.pool_sku);
      } else {
        db.prepare(`UPDATE inventory_items SET channel_status = 'ended', updated_at = datetime('now') WHERE id = ? AND channel_status = 'active'`).run(+payload.item_id);
      }
      if (mode === 'restore') return { ok: true, action: 'ended_meanwhile', attention: true, note: 'the listing ended while the stock was away — relist it from the uploader' };
      return { ok: true, action: 'already_ended', listing_status: status, from: 0 };
    }
    const sku = isPool ? t.pool_sku : (t.sku || (db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(+payload.item_id) || {}).sku);

    if (mode === 'restore') {
      if (from != null && from >= want) return { ok: true, action: 'noop', from, to: from };
      const v = await offerQuantityVerified(ctx, { sku, offerId: t.offer_id, quantity: want });
      if (!v.ok) return { ...v, from };
      db.prepare(`UPDATE ebay_listings SET listing_status = 'ACTIVE', available_qty = ?, last_synced_at = datetime('now'), updated_at = datetime('now') WHERE offer_id = ?`).run(want, String(t.offer_id));
      return { ok: true, action: 'restored', from, to: want };
    }

    if (want <= 0 && s.held <= 0) {
      // Nothing left on the shelf: it SOLD. End it, exactly as before the show flow existed.
      const w = await deps.withdrawOffer(env, t.offer_id);
      if (!w.ok) return { ok: false, error: 'eBay refused the withdraw: ' + w.error };
      if (isPool) {
        db.prepare(`UPDATE sealed_pools SET channel_status = 'ended', updated_at = datetime('now') WHERE pool_sku = ?`).run(t.pool_sku);
        db.prepare(`UPDATE sealed_items SET channel_status = 'ended', updated_at = datetime('now') WHERE pool_sku = ? AND channel_status = 'active'`).run(t.pool_sku);
        try {
          db.prepare(`INSERT INTO sealed_listing_pushes (pool_sku, action, status, offer_id, quantity, response) VALUES (?, 'withdraw', 'ok', ?, 0, ?)`)
            .run(t.pool_sku, String(t.offer_id), JSON.stringify({ reason: 'cross-channel sale' }));
        } catch { /* an audit failure must never undo a withdraw that happened (GR7) */ }
      } else {
        // The same write-back the /withdraw route does, so the two paths cannot disagree about what an
        // ended listing looks like locally.
        db.prepare(`UPDATE inventory_items SET channel_status='ended', status=CASE WHEN status='sold' THEN status ELSE 'in_stock' END, updated_at=datetime('now') WHERE id=?`).run(+payload.item_id);
        auditPush(db, { itemId: +payload.item_id, sku, action: 'withdraw', offerId: String(t.offer_id), response: { reason: 'cross-channel sale', shelf: 0 } });
      }
      db.prepare(`UPDATE ebay_listings SET listing_status='ENDED', available_qty = 0, last_synced_at=datetime('now'), updated_at=datetime('now') WHERE offer_id = ?`).run(String(t.offer_id));
      return { ok: true, action: 'withdrawn', from, to: 0 };
    }
    if (from != null && from <= want) return { ok: true, action: 'noop', from, to: from, shelf: s.target };
    if (showMath) {
      // Units are at a show (or this IS the show's hide): one number changes, nothing else. At 0 the
      // listing is HIDDEN — the out-of-stock option keeps it, its item number and its watchers.
      const v = await offerQuantityVerified(ctx, { sku, offerId: t.offer_id, quantity: want });
      if (!v.ok) return { ...v, from };
      db.prepare(`UPDATE ebay_listings SET listing_status = ?, available_qty = ?, last_synced_at = datetime('now'), updated_at = datetime('now') WHERE offer_id = ?`)
        .run(want === 0 ? 'OUT_OF_STOCK' : 'ACTIVE', want, String(t.offer_id));
      return { ok: true, action: want === 0 ? 'hidden' : 'reduced', from, to: want };
    }
    // Fewer left than eBay offers, after a plain sale: re-publish through the proven revise path at eBay's
    // CURRENT price, so the only thing that changes is the quantity.
    const cfg = deps.loadListingConfig();
    if (isPool) {
      const r = await deps.publishSealedPool(env, db, cfg, { poolSku: t.pool_sku, saveCfg: deps.saveListingConfig, channelGuard: false });
      if (!r.ok) return { ok: false, error: 'eBay pool revise failed: ' + (r.error || 'unknown') };
      return { ok: true, action: 'reduced', from, to: r.units ?? want };
    }
    const price = o.price_value != null && Number.isFinite(+o.price_value) ? Math.round(+o.price_value * 100) : null;
    const r = await deps.runPublish(env, db, cfg, deps.saveListingConfig, {
      itemId: +payload.item_id, overrides: price ? { price_cents: price } : {}, dryRun: false, channelGuard: false,
      // The listing keeps the pictures it has. Left to the config default (off), a branded Runner listing
      // was revised onto plain catalog art by its first sale.
      compose: publishedComposed(db, +payload.item_id),
    });
    if (!r.ok) return { ok: false, error: 'eBay revise failed: ' + (r.error || 'unknown') };
    return { ok: true, action: 'reduced', from, to: want };
  }

  if (t.api === 'trading') {
    if (mode === 'restore') {
      // Read first so a restore can never LOWER a listing someone has since raised by hand.
      const live = await deps.getListingState(env, t.listing_id);
      if (!live.ok) return { ok: false, error: 'could not read the listing from eBay: ' + live.error };
      if (live.listing_status && live.listing_status !== 'Active') return { ok: true, action: 'ended_meanwhile', attention: true, note: 'the listing ended while the stock was away — relist it by hand' };
      if (live.available_qty != null && live.available_qty >= want) return { ok: true, action: 'noop', from: live.available_qty, to: live.available_qty };
      const r = await setTradingQuantity(env, db, { listingId: t.listing_id, quantity: want, deps });
      return r.ok ? { ...r, action: 'restored' } : r;
    }
    if (want <= 0 && s.held <= 0) {
      const r = await endTradingListing(env, db, { listingId: t.listing_id, deps });
      if (r.refused) return { ok: false, permanent: true, error: r.error, code: r.code };
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, action: r.action, to: 0 };
    }
    if (showMath) {
      const live = await deps.getListingState(env, t.listing_id);
      if (!live.ok) return { ok: false, error: 'could not read the listing from eBay: ' + live.error };
      if (live.listing_status && live.listing_status !== 'Active') {
        markTradingEnded(db, t.listing_id, live);
        return { ok: true, action: 'already_ended', listing_status: live.listing_status, from: 0 };
      }
      if (live.available_qty != null && live.available_qty <= want) return { ok: true, action: 'noop', from: live.available_qty, to: live.available_qty };
      const r = await setTradingQuantity(env, db, { listingId: t.listing_id, quantity: want, deps });
      if (!r.ok) return { ...r, from: r.from ?? live.available_qty };
      return { ...r, action: want === 0 ? 'hidden' : 'reduced' };
    }
    const live = await deps.getListingState(env, t.listing_id);
    if (!live.ok) return { ok: false, error: 'could not read the listing from eBay: ' + live.error };
    if (live.listing_status && live.listing_status !== 'Active') {
      markTradingEnded(db, t.listing_id, live);
      return { ok: true, action: 'already_ended', listing_status: live.listing_status };
    }
    if (live.available_qty != null && live.available_qty <= want) {
      return { ok: true, action: 'noop', from: live.available_qty, to: live.available_qty, shelf: want };
    }
    const r = await deps.reviseTradingListing(env, db, { listingId: t.listing_id, availableQty: want });
    if (r.refused) return { ok: false, permanent: true, error: r.error, code: r.code };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, action: 'reduced', from: live.available_qty, to: want, verified: !!r.verified };
  }

  return { ok: false, permanent: true, error: 'unknown eBay target ' + JSON.stringify(t) };
}

// --- Shopify ---------------------------------------------------------------------------------------

async function runShopifyJob(ctx, payload) {
  const { db, env, deps } = ctx;
  const t = payload.target || {};
  const mode = payload.mode || 'sale';
  const row = db.prepare(`SELECT sku, kind, item_id, inventory_gid, location_gid, available_qty, state
                            FROM shopify_listings WHERE store = 'live' AND sku = ?`).get(String(t.sku || ''));
  if (!row || !row.inventory_gid || !row.location_gid) {
    return { ok: true, action: 'gone', note: 'no stocked live Shopify product for this SKU', ...(mode === 'restore' ? { attention: true } : {}) };
  }
  const s = shelf(db, payload);
  if (mode === 'restore' && s.held <= 0) return { ok: true, action: 'sold', note: 'sold while it was away — nothing to put back' };
  const want = mode === 'restore' ? Math.min(payload.pre_qty ?? 0, s.target) : s.target;
  const r = await deps.setAvailableQty(env, {
    inventoryItemGid: row.inventory_gid, locationGid: row.location_gid, quantity: want, store: 'live',
    fetchImpl: deps.fetchImpl, reason: 'correction',
    // A restore is the ONE path allowed to raise, and only to what this show took down (min'd above).
    allowRaise: mode === 'restore',
    referenceDocumentUri: `gid://tcg-listing-tools/${mode}/${encodeURIComponent(row.sku)}`,
  });
  if (!r.ok) return { ok: false, error: 'Shopify refused the quantity: ' + (r.error || r.action || 'unknown'), from: r.from ?? undefined };
  const now = r.available != null ? r.available : null;
  if (now != null) {
    db.prepare(`UPDATE shopify_listings SET available_qty = ?, last_synced_at = datetime('now'), updated_at = datetime('now')
                WHERE store = 'live' AND sku = ?`).run(now, row.sku);
  }
  // 'held' here means Shopify was ALREADY below the target — it sold there too, or someone zeroed it —
  // and the never-raise rule left it alone. That is the right outcome, so it reports as a no-op.
  let action = r.action;
  // 'hidden' only for stock that is still held (away at a show); a sold card brought to 0 is 'reduced'.
  if (r.action === 'set') action = mode === 'restore' ? 'restored' : (want === 0 && s.held > 0 ? 'hidden' : 'reduced');
  else if (r.action === 'held') action = 'noop';
  return { ok: true, action, from: r.from, to: now, shelf: s.target };
}

// --- the job loop ----------------------------------------------------------------------------------

function parsePayload(job) { try { return job.payload ? JSON.parse(job.payload) : {}; } catch { return {}; } }

// The three dedupe keys that name ONE listing: a sale, a show's hide and a show's restore. They are
// separate keys so the queue never merges two different instructions, which also means two of them
// could otherwise run at once against the same listing — an inline drain beside the timer's tick — and
// the later write would land over the earlier one. claim() refuses while a sibling holds the listing.
function siblingKeys(dedupeKey) {
  const base = String(dedupeKey || '').replace(/^(away|restore):/, '');
  return base ? [base, 'away:' + base, 'restore:' + base] : null;
}

function claim(db, id) {
  const cur = db.prepare('SELECT dedupe_key FROM sync_jobs WHERE id = ?').get(+id);
  const keys = cur ? siblingKeys(cur.dedupe_key) : null;
  return db.prepare(`UPDATE sync_jobs SET state = 'running', claimed_at = datetime('now'),
                       lease_expires = datetime('now', '+${LEASE_MIN} minutes'), attempts = attempts + 1
                     WHERE id = ? AND kind IN (${JOB_KINDS_SQL})
                       AND (state IN ('queued','failed') OR (state = 'running' AND lease_expires < datetime('now')))
                       ${keys ? `AND NOT EXISTS (SELECT 1 FROM sync_jobs o WHERE o.id <> sync_jobs.id AND o.state = 'running'
                                                   AND o.lease_expires >= datetime('now') AND o.dedupe_key IN (?,?,?))` : ''}`)
    .run(+id, ...(keys || [])).changes > 0;
}

function finish(db, job, payload, result, state, { delayMin = 0, error = null } = {}) {
  const body = JSON.stringify({ ...payload, again: false, result: { ...result, at: new Date().toISOString() } });
  if (state === 'done' || state === 'dead') {
    db.prepare(`UPDATE sync_jobs SET state = ?, payload = ?, last_error = ?, dedupe_key = NULL, lease_expires = NULL,
                  done_at = datetime('now') WHERE id = ?`).run(state, body, error, job.id);
  } else {
    db.prepare(`UPDATE sync_jobs SET state = ?, payload = ?, last_error = ?, lease_expires = NULL,
                  run_after = datetime('now', ?), attempts = attempts - ? WHERE id = ?`)
      .run(state, body, error, `+${Math.max(0, delayMin)} minutes`, state === 'queued' ? 1 : 0, job.id);
  }
}

/**
 * runJob — claim one job, run it, record what happened. Never throws.
 *
 * Returns the outcome the in-person route shows the operator: { id, channel, target, ok, action,
 * state, error } — `state` is 'done', 'failed' (retrying), 'dead' (gave up, alerted) or 'blocked'.
 */
export async function runJob(ctx, jobId) {
  const { db } = ctx;
  // THE KILL SWITCH STOPS EVERY SEND, not just the timer: the in-person route and the webhook dispatch
  // drain jobs too. Nothing is claimed, so the job stays queued and runs once the switch is back on.
  if (syncDisabled(ctx.env)) {
    const cur = db.prepare('SELECT id, channel, payload FROM sync_jobs WHERE id = ?').get(+jobId);
    const p = cur ? parsePayload(cur) : {};
    return { id: +jobId, channel: cur?.channel || null, target: p.target || null, label: describe(p), ok: false,
      state: 'queued', pending: true, sync_off: true, error: SYNC_OFF_MESSAGE };
  }
  if (!claim(db, jobId)) {
    const cur = db.prepare('SELECT id, channel, state, payload, last_error FROM sync_jobs WHERE id = ?').get(+jobId);
    const p = cur ? parsePayload(cur) : {};
    // Still waiting (another update to the same listing holds it, or it is paused behind a show's
    // canary): pending, not a failure — the worker runs it next.
    const waiting = cur && ['queued', 'failed', 'paused', 'running'].includes(cur.state);
    return { id: +jobId, channel: cur?.channel || null, target: p.target || null, label: describe(p), ok: cur?.state === 'done', state: cur?.state || 'missing',
      action: p.result?.action || null, error: cur?.last_error || null, skipped: 'not_claimable',
      ...(waiting ? { pending: true, note: cur.state === 'paused' ? 'held back until the show\'s first eBay listing is confirmed hidden' : 'another update to this listing is running — this one runs next' } : {}) };
  }
  const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(+jobId);
  const payload = parsePayload(job);
  const label = describe(payload);
  const out = { id: job.id, channel: job.channel, target: payload.target || null, label };

  // Not connected is not a failure of the job, and must not burn an attempt — it is the box's state.
  const connected = job.channel === 'ebay' ? ctx.deps.ebayConnected(ctx.env) : ctx.deps.shopifyConfigured(ctx.env);
  if (!connected) {
    const why = job.channel === 'ebay' ? 'blocked: eBay is not connected on this box' : 'blocked: the live Shopify store is not configured on this box';
    finish(db, job, payload, { ok: false, action: 'blocked' }, 'queued', { delayMin: 5, error: why });
    return { ...out, ok: false, state: 'blocked', action: 'blocked', error: why };
  }

  let result;
  try {
    result = job.channel === 'ebay' ? await runEbayJob(ctx, payload) : await runShopifyJob(ctx, payload);
  } catch (e) {
    result = { ok: false, error: String(e?.message || e) };
  }

  noteForEvent(db, payload, result);
  // A sale that landed WHILE this ran flagged the stored row (`again`, lib/channel-presence.mjs upsertJob)
  // and added its reason. Both are read BEFORE finish() writes this run's payload back — finish resets
  // `again`, so reading after it would lose the sale, and with it the follow-up that brings the channel
  // down to the newer count.
  const latest = parsePayload(db.prepare('SELECT payload FROM sync_jobs WHERE id = ?').get(job.id) || {});
  const again = !!(payload.again || latest.again);
  if (latest.reasons) payload.reasons = [...new Set([...(payload.reasons || []), ...latest.reasons])].slice(-10);
  // Its read may predate that sale, so go round once more — in sale mode, the safe default whatever this
  // job was. Queued after finish() so it cannot merge into this job's own dedupe key while it is running.
  const followUp = () => {
    if (again) enqueueChannelSync(db, { kind: payload.kind, itemId: payload.item_id, reason: 'another change landed mid-sync' });
  };
  if (result.ended && payload.mode === 'away' && payload.event_id != null) {
    // eBay ENDED a listing it was asked to hide. Whatever is wrong is account-wide (the out-of-stock
    // option, most likely), so every other hide for this show is held back here, wherever it was going
    // to run — the canary, an inline drain or the timer.
    const held = db.prepare(`UPDATE sync_jobs SET state = 'paused' WHERE id <> ? AND channel = 'ebay' AND state IN ('queued','failed')
                               AND json_extract(payload, '$.mode') = 'away' AND json_extract(payload, '$.event_id') = ?`).run(job.id, +payload.event_id).changes;
    if (held) console.error(`[channel-sync] eBay ended ${label} instead of hiding it — ${held} other hide(s) for this show held back`);
  }
  if (result.ok) {
    finish(db, job, payload, result, 'done');
    followUp();
    // The last unit of a deliberately dual-listed item is a one-of-one on two channels again. That is
    // the owner's call to make, so it is said out loud rather than decided here.
    const warnings = [];
    if (result.to === 1 || result.shelf === 1) {
      const both = ebayPresence(db, payload.kind, { itemId: payload.item_id, poolSku: payload.pool_sku }).length
        && shopifyPresence(db, payload.kind, { itemId: payload.item_id, poolSku: payload.pool_sku }).some((r) => r.state === 'live');
      if (both) {
        const w = `${label}: one unit left and it is live on BOTH eBay and Shopify — take it off one of them`;
        warnings.push(w);
        console.warn('[channel-sync] ' + w);
      }
    }
    return { ...out, ok: true, state: 'done', action: result.action, from: result.from ?? null, to: result.to ?? null, warnings };
  }

  const attempts = job.attempts;   // already incremented by claim
  const dead = result.permanent || attempts >= MAX_ATTEMPTS;
  if (dead) {
    finish(db, job, payload, result, 'dead', { error: result.error });
    followUp();
    const mode = payload.mode || 'sale';
    const msg = mode === 'restore'
      ? `COULD NOT put ${label} back online after ${attempts} attempt(s): ${result.error}. It stays off sale there until you fix it by hand.`
      : `COULD NOT bring ${label} down after ${attempts} attempt(s): ${result.error}. It may still be for sale there — fix it by hand.`;
    const head = mode === 'restore' ? 'Stock not back online after a show'
      : mode === 'away' ? 'Stock still live while it is away at a show' : 'Stock still live after a sale';
    console.error('[channel-sync] ' + msg);
    try { await ctx.deps.alert(ctx.env, '⚠️ <b>' + head + '</b>\n' + escapeHtml(msg)); } catch { /* logged above */ }
    return { ...out, ok: false, state: 'dead', error: result.error, code: result.code || null, ended: !!result.ended };
  }
  const delay = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
  finish(db, job, payload, result, 'failed', { delayMin: delay, error: result.error });
  console.warn(`[channel-sync] ${label}: ${result.error} — retrying in ${delay} min (attempt ${attempts}/${MAX_ATTEMPTS})`);
  return { ...out, ok: false, state: 'failed', error: result.error, retryInMin: delay, ended: !!result.ended };
}

// What a show's hide or restore did, kept on the event (event_targets). The hide's pre-show quantity is
// the ONLY number a restore may raise a channel back to, and it is captured once, by the job that read it.
function noteForEvent(db, payload, result) {
  if (!payload.event_id || !['away', 'restore'].includes(payload.mode)) return;
  const channel = payload.target && payload.target.api === 'shopify' ? 'shopify' : 'ebay';
  try {
    if (payload.mode === 'away') {
      recordEventTarget(db, {
        eventId: payload.event_id, channel, target: payload.target, kind: payload.kind, itemId: payload.item_id, poolSku: payload.pool_sku,
        // The read taken BEFORE the write, whatever came after it. A write that landed but could not be
        // read back is a failure here, and the retry then reads the 0 it wrote — so a pre-show figure
        // dropped on failure was lost for good, and "Back online" restored the listing to 0.
        preQty: result.from ?? null,
        state: !result.ok ? 'failed' : (['already_ended', 'withdrawn', 'ended', 'gone'].includes(result.action) ? 'ended' : 'hidden'),
        note: result.ok ? null : result.error,
      });
    } else {
      recordEventTarget(db, {
        eventId: payload.event_id, channel, target: payload.target, kind: payload.kind, itemId: payload.item_id, poolSku: payload.pool_sku,
        state: !result.ok ? (result.permanent ? 'attention' : 'restoring')
          : result.action === 'sold' ? 'sold' : (result.attention ? 'attention' : 'restored'),
        note: result.ok ? (result.note || null) : result.error,
      });
    }
  } catch (e) { console.warn('[channel-sync] could not record the show target —', e?.message || e); }
}

/** Jobs that are due now (or whose lease lapsed), oldest first within priority. */
export function dueJobs(db, limit = 25) {
  return db.prepare(`SELECT id FROM sync_jobs
                      WHERE kind IN (${JOB_KINDS_SQL})
                        AND ((state IN ('queued','failed') AND run_after <= datetime('now'))
                          OR (state = 'running' AND lease_expires < datetime('now')))
                      ORDER BY priority, run_after, id LIMIT ?`).all(Math.max(1, limit)).map((r) => r.id);
}

/** Run named jobs now, within a time budget — the in-person route's synchronous answer. */
export async function drainJobs(ctx, ids, { budgetMs = 20_000 } = {}) {
  const started = Date.now();
  const out = [];
  for (const id of ids) {
    if (Date.now() - started > budgetMs) {
      out.push({ id, state: 'queued', pending: true, note: 'still working — the background sync will finish it' });
      continue;
    }
    out.push(await runJob(ctx, id));
  }
  return out;
}

/**
 * One pass: queue whatever the ledger says left the shelf, then work the queue. Single-flight across
 * the whole process (globalThis, because a Vite re-evaluation of this module must not open a second
 * runner beside the first).
 */
export async function runChannelSyncTick(ctx, { limit = 25, trigger = 'schedule' } = {}) {
  // Off: no ledger scan and no sends. Nothing the ledger gains while this is off is queued — arming
  // later starts from that moment (the cursor is pinned at the first armed boot, lib/cross-channel.mjs).
  if (syncDisabled(ctx.env)) {
    return { at: new Date().toISOString(), trigger, disabled: true, note: SYNC_OFF_MESSAGE, scan: null, ran: 0, done: 0, failed: 0, dead: 0, blocked: 0, results: [] };
  }
  const LOCK = globalThis.__channelSyncLock || (globalThis.__channelSyncLock = { running: null });
  if (LOCK.running) return LOCK.running;
  const run = (async () => {
    const started = new Date().toISOString();
    migrateChannelSync(ctx.db);
    let scan = null;
    try { scan = scanMovements(ctx.db); } catch (e) { scan = { error: String(e?.message || e) }; }
    const results = [];
    for (const id of dueJobs(ctx.db, limit)) results.push(await runJob(ctx, id));
    const summary = {
      at: started, trigger, scan,
      ran: results.length,
      done: results.filter((r) => r.state === 'done').length,
      failed: results.filter((r) => r.state === 'failed').length,
      dead: results.filter((r) => r.state === 'dead').length,
      blocked: results.filter((r) => r.state === 'blocked').length,
    };
    try { setSyncMeta(ctx.db, 'last_tick', JSON.stringify(summary)); } catch { /* status only */ }
    return { ...summary, results };
  })();
  LOCK.running = run;
  try { return await run; } finally { LOCK.running = null; }
}

// --- visibility ------------------------------------------------------------------------------------

export function channelSyncState(db, env = {}) {
  migrateChannelSync(db);
  const counts = Object.fromEntries(db.prepare(`SELECT state, COUNT(*) n FROM sync_jobs WHERE kind IN (${JOB_KINDS_SQL}) GROUP BY state`)
    .all().map((r) => [r.state, r.n]));
  const view = (r) => {
    const p = parsePayload(r);
    return {
      id: r.id, channel: r.channel, sku: r.sku, state: r.state, attempts: r.attempts, last_error: r.last_error,
      run_after: r.run_after, done_at: r.done_at, created_at: r.created_at,
      kind: p.kind || null, item_id: p.item_id ?? null, pool_sku: p.pool_sku || null, target: p.target || null,
      reasons: p.reasons || [], result: p.result || null, label: describe(p),
    };
  };
  const open = db.prepare(`SELECT * FROM sync_jobs WHERE kind IN (${JOB_KINDS_SQL}) AND state IN ('queued','running','failed')
                            ORDER BY id DESC LIMIT 50`).all().map(view);
  const dead = db.prepare(`SELECT * FROM sync_jobs WHERE kind IN (${JOB_KINDS_SQL}) AND state = 'dead'
                            ORDER BY id DESC LIMIT 50`).all().map(view);
  const recent = db.prepare(`SELECT * FROM sync_jobs WHERE kind IN (${JOB_KINDS_SQL}) AND state = 'done'
                              ORDER BY done_at DESC, id DESC LIMIT 20`).all().map(view);
  let lastTick = null;
  try { lastTick = JSON.parse(getSyncMeta(db, 'last_tick') || 'null'); } catch { /* none yet */ }
  const armed = syncArmed(env);
  return {
    enabled: armed, armed,
    // Said in words, because "queued" reads like "about to happen" and while this is off it is not.
    note: armed ? null : 'Cross-channel sync is OFF: nothing is sent to eBay or Shopify, and Shopify orders are not read. '
      + 'Sales recorded here change local stock only; their channel updates wait in the queue until CROSS_CHANNEL_SYNC=on.',
    counts, open, dead, recent,
    cursor: Number(getSyncMeta(db, 'movement_cursor')) || null,
    last_tick: lastTick,
  };
}

/** Re-queue a failed or dead job now. A person pressing Retry is not the backoff schedule. */
export function retryJob(db, id) {
  const cur = db.prepare(`SELECT id, state, channel, payload FROM sync_jobs WHERE id = ? AND kind IN (${JOB_KINDS_SQL})`).get(+id);
  if (!cur) return { ok: false, error: 'no such sync job' };
  if (!['failed', 'dead'].includes(cur.state)) return { ok: false, error: `job is ${cur.state}, not failed` };
  const p = parsePayload(cur);
  // A dead job gave up its dedupe key; re-queueing goes through enqueue so it cannot duplicate a live one.
  // The SAME instruction is re-queued — its mode, its listing and its show — never a plain sale job: a
  // show's restore retried as a sale is a no-op that reads as done, and a hide retried as a sale leaves
  // the show's record saying 'failed', so "Back online" would skip the listing.
  if (cur.state === 'dead') {
    db.prepare("UPDATE sync_jobs SET last_error = COALESCE(last_error, '') || ' (retried by hand)' WHERE id = ?").run(cur.id);
    const extra = {};
    for (const k of ['event_id', 'pre_qty']) if (p[k] != null) extra[k] = p[k];
    const r = enqueueChannelSync(db, {
      kind: p.kind, itemId: p.item_id, mode: MODES.includes(p.mode) ? p.mode : 'sale', reason: 'retried by hand', extra,
      targets: p.target ? [{ ...p.target, channel: cur.channel }] : null,
    });
    return { ok: true, requeued: r.jobs.map((j) => j.id) };
  }
  db.prepare(`UPDATE sync_jobs SET state = 'queued', run_after = datetime('now') WHERE id = ?`).run(cur.id);
  return { ok: true, requeued: [cur.id] };
}

/**
 * driftReport — every channel that offers more than the shelf holds, from the mirrors. REPORT-ONLY.
 *
 * This is how drift that predates the sync worker is found (a card sold before this existed, a Shopify
 * draft still carrying its publish-time quantity — audit K2). It never fixes anything: applyDrift takes
 * the rows a person has looked at, by id, the same shape settleLabelBought uses.
 */
// Held minus away: a channel deliberately at 0 because the stock is at a show is not drift.
const offerable = (db, kind, id) => Math.max(0, onHandUnits(db, kind, id) - awayUnits(db, kind, id));

export function driftReport(db) {
  migrateChannelSync(db);
  const rows = [];
  for (const s of db.prepare(`SELECT sku, kind, item_id, state, available_qty FROM shopify_listings
                               WHERE store = 'live' AND state IN ('live','unpublished') AND inventory_gid IS NOT NULL`).all()) {
    if (s.kind === 'inventory' && s.item_id == null) continue;
    const shelf = s.kind === 'sealed' ? Math.max(0, poolUnits(db, s.sku) - awayPoolUnits(db, s.sku)) : offerable(db, 'inventory', s.item_id);
    if ((s.available_qty == null && shelf === 0) || (s.available_qty != null && s.available_qty > shelf)) {
      rows.push({ channel: 'shopify', kind: s.kind, item_id: s.item_id, pool_sku: s.kind === 'sealed' ? s.sku : null,
        sku: s.sku, state: s.state, channel_qty: s.available_qty, shelf });
    }
  }
  for (const e of db.prepare(`SELECT el.sku, el.item_id, el.available_qty, el.listing_id FROM ebay_listings el
                               JOIN inventory_items ii ON ii.id = el.item_id
                               -- The mirror's ACTIVE alone, not channel_status: the sale decrement writes
                               -- 'ended' on sell-out assuming eBay ended its own listing, which a Shopify or
                               -- in-person sale never did (the same reason ebayPresence reads both).
                               WHERE el.listing_status = 'ACTIVE'`).all()) {
    const shelf = offerable(db, 'inventory', e.item_id);
    if (e.available_qty == null ? shelf === 0 : e.available_qty > shelf) {
      rows.push({ channel: 'ebay', api: 'inventory', kind: 'inventory', item_id: e.item_id, sku: e.sku, listing_id: e.listing_id, channel_qty: e.available_qty, shelf });
    }
  }
  for (const e of db.prepare(`SELECT listing_id, sku, item_id, available_qty FROM ebay_seller_listings
                               WHERE state = 'active' AND item_id IS NOT NULL AND COALESCE(created_via,'manual') <> 'tool'`).all()) {
    const shelf = offerable(db, 'inventory', e.item_id);
    if (e.available_qty == null ? shelf === 0 : e.available_qty > shelf) {
      rows.push({ channel: 'ebay', api: 'trading', kind: 'inventory', item_id: e.item_id, sku: e.sku, listing_id: e.listing_id, channel_qty: e.available_qty, shelf });
    }
  }
  for (const p of db.prepare(`SELECT pool_sku, ebay_listing_id FROM sealed_pools WHERE channel_status = 'active' AND ebay_offer_id IS NOT NULL`).all()) {
    const shelf = Math.max(0, poolUnits(db, p.pool_sku) - awayPoolUnits(db, p.pool_sku));
    if (shelf === 0) rows.push({ channel: 'ebay', api: 'pool', kind: 'sealed', pool_sku: p.pool_sku, sku: p.pool_sku, listing_id: p.ebay_listing_id, channel_qty: null, shelf });
  }
  return { count: rows.length, rows };
}

/**
 * applyDrift — queue a sync for NAMED stock rows. `items` is [{kind, item_id} | {kind:'sealed', pool_sku}].
 * A pool is addressed through any one of its rows, which is what enqueueChannelSync resolves from.
 */
export function applyDrift(db, { items = [] } = {}) {
  const queued = [];
  const skipped = [];
  for (const it of items || []) {
    const kind = it.kind === 'sealed' ? 'sealed' : 'inventory';
    let itemId = it.item_id != null ? +it.item_id : null;
    if (kind === 'sealed' && itemId == null && it.pool_sku) {
      itemId = (db.prepare('SELECT id FROM sealed_items WHERE pool_sku = ? ORDER BY id LIMIT 1').get(String(it.pool_sku)) || {}).id ?? null;
    }
    if (itemId == null) { skipped.push({ ...it, why: 'no stock row to address' }); continue; }
    const r = enqueueChannelSync(db, { kind, itemId, reason: 'drift fixed by hand' });
    queued.push(...r.jobs.map((j) => j.id));
  }
  return { queued, skipped };
}

// --- the timer -------------------------------------------------------------------------------------

// THE SWITCH IS OPT-IN: CROSS_CHANNEL_SYNC=on|true|1|yes arms it, and ANYTHING ELSE — unset included —
// is off. It ships disarmed because arming it is the first time this code writes to the live eBay and
// Shopify accounts on its own, and that first time is a person's decision (the one-card test), not a
// side effect of a deploy. Read from the env the plugin was handed (Vite's loadEnv, which is where .env
// lands — it does NOT copy .env into process.env), falling back to process.env for a shell-set switch.
export function syncArmed(env = {}) {
  const v = (env && env.CROSS_CHANNEL_SYNC != null && env.CROSS_CHANNEL_SYNC !== '') ? env.CROSS_CHANNEL_SYNC : process.env.CROSS_CHANNEL_SYNC;
  return /^(on|true|1|yes)$/i.test(String(v || '').trim());
}
export const syncDisabled = (env = {}) => !syncArmed(env);
export const SYNC_OFF_MESSAGE = 'cross-channel sync is OFF on this box (set CROSS_CHANNEL_SYNC=on in .env and restart to arm it) — queued here, NOT sent to eBay or Shopify';

export function stopChannelSync() {
  for (const k of ['__channelSyncTimer', '__channelSyncBoot']) {
    if (globalThis[k]) { clearInterval(globalThis[k]); clearTimeout(globalThis[k]); globalThis[k] = null; }
  }
}

export function startChannelSync(ctxFactory, { everyMs = 60_000, bootDelayMs = 30_000 } = {}) {
  stopChannelSync();
  let env = {};
  try { env = (ctxFactory() || {}).env || {}; } catch { /* the tick will say */ }
  if (syncDisabled(env)) {
    console.log('[channel-sync] OFF — CROSS_CHANNEL_SYNC is not on, so nothing is sent to eBay or Shopify (set CROSS_CHANNEL_SYNC=on to arm)');
    return { started: false };
  }
  const tick = () => runChannelSyncTick(ctxFactory(), { trigger: 'schedule' })
    .then((s) => {
      if (s.dead || s.failed) console.warn(`[channel-sync] tick: ${s.done} done, ${s.failed} retrying, ${s.dead} gave up`);
    })
    .catch((e) => console.warn('[channel-sync] tick failed —', e?.message || e));
  const boot = setTimeout(tick, bootDelayMs); if (boot.unref) boot.unref();
  const timer = setInterval(tick, Math.max(10_000, everyMs)); if (timer.unref) timer.unref();
  globalThis.__channelSyncBoot = boot;
  globalThis.__channelSyncTimer = timer;
  return { started: true };
}
