// lib/channel-presence.mjs — where a stock row is for sale right now, the two refusals that keep a
// one-of-one on ONE channel, and the durable queue that brings every other channel down after a sale.
//
// THE RULE (audit K1 + V10, 2026-10-18): a sale on any channel — eBay, Shopify, a show table — takes the
// card off the others, and anything this cannot reach is reported, never silent. Most of the catalogue is
// one-of-one, so a card sold on one channel and still live on another is a second buyer for an object
// that no longer exists.
//
// A LEAF MODULE ON PURPOSE. lib/listings.mjs, lib/shopify.mjs, lib/sealed-shopify.mjs,
// lib/sealed-listing.mjs, lib/inventory.mjs and lib/sealed.mjs all import the refusals or the enqueue
// from here, and the worker that does the network writes (lib/channel-sync.mjs) imports most of those.
// Putting the two halves in one file would close a cycle through every publish path; this file imports
// nothing but the database it is handed.
//
// EVERY shopify_listings STATEMENT NAMES store = 'live', which test/invariants/shopify-store-scoping
// requires. Only the live store sells real stock: a dev rehearsal's mirror row is not a place a buyer
// can take a card from, and lowering it would spend a call on a store nobody shops at.

// --- schema ----------------------------------------------------------------------------------------
//
// sync_jobs (the outbox) and channel_intent already exist in lib/db.mjs — designed for exactly this in
// docs/SHOPIFY_CHANNEL_PLAN.md S9 and never used until now. The tables below are new, and are created
// here so the module that owns them says what they are. migrateChannelSync is idempotent and runs on the
// handle it is given, the first time any function in this family touches it (and at plugin boot).
const MIGRATED = new WeakSet();

function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function migrateChannelSync(db) {
  if (!db || MIGRATED.has(db)) return;
  db.exec(`
    -- Small key/value state for the sync worker: the stock_movements cursor, last-run summaries.
    CREATE TABLE IF NOT EXISTS channel_sync_meta (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- One row per in-person sale LINE: a card or box sold across a table. The stock movement is the
    -- truth about the units; this is the truth about the SALE (price, event, who), which the movement
    -- has no columns for. effect is decrementInventoryItem's own snapshot, kept so an undo is possible
    -- later without guessing what the row looked like before.
    CREATE TABLE IF NOT EXISTS in_person_sales (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      kind             TEXT NOT NULL CHECK (kind IN ('inventory','sealed')),
      item_id          INTEGER NOT NULL,          -- tracker id within its kind; no FK, see stock_movements
      sku              TEXT,
      name             TEXT,
      qty              INTEGER NOT NULL CHECK (qty > 0),
      unit_price_cents INTEGER,                   -- AUD, per unit; NULL = not entered (GR3)
      currency         TEXT NOT NULL DEFAULT 'AUD',
      event            TEXT,                      -- the show or market, free text
      note             TEXT,
      actor            TEXT,
      location         TEXT,                      -- the shelf the units came off (sealed)
      sold_out         INTEGER NOT NULL DEFAULT 0,
      effect           TEXT,                      -- JSON snapshot from the decrement
      batch_ref        TEXT,                      -- groups the lines of one end-of-day batch
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ips_item ON in_person_sales(kind, item_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ips_at ON in_person_sales(created_at)');

  // --- shows and markets (lib/events.mjs) ---
  //
  // An EVENT is stock going to a table: listed, taken offline everywhere, sold or brought home, and put
  // back online with whatever was bought there. Its status is the whole state machine:
  //   planning  — the take-list is being built; nothing has left any channel
  //   offline   — the stock is hidden on eBay and Shopify and is "away"
  //   closing   — the close-out is recorded: what came back, what sold, the takings
  //   closed    — returned and new stock has been put back online (per-item restore states say how)
  // Units AWAY (taken − returned − sold) on an offline or closing event are subtracted from what every
  // channel may offer, which is how the sync worker, the publish refusals and the drift report all agree
  // about stock that is sitting on a table somewhere.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL,
      venue               TEXT,
      starts_on           TEXT,
      ends_on             TEXT,
      status              TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','offline','closing','closed')),
      takings_cash_cents  INTEGER,             -- AUD (GR3), entered at close-out
      takings_card_cents  INTEGER,
      takings_trade_cents INTEGER,             -- trade credit given against our stock
      notes               TEXT,
      offline_at          TEXT,
      closed_out_at       TEXT,
      restored_at         TEXT,
      offline_report      TEXT,                -- JSON: preflight + canary outcome of the take-offline
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS event_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL CHECK (kind IN ('inventory','sealed')),
      item_id         INTEGER NOT NULL,          -- no FK, the stock_movements convention
      sku             TEXT,
      qty_taken       INTEGER NOT NULL CHECK (qty_taken > 0),
      qty_returned    INTEGER NOT NULL DEFAULT 0,
      qty_sold_table  INTEGER NOT NULL DEFAULT 0,   -- recorded at the table during the show
      qty_sold_close  INTEGER NOT NULL DEFAULT 0,   -- didn't come back, recorded at close-out
      sale_price_cents INTEGER,                     -- per unit, entered at close-out (AUD)
      added_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (event_id, kind, item_id)
    );
    -- One row per LISTING a show took offline (a pool is one listing for several stock rows, so this is
    -- per target, not per item). pre_qty is what that listing offered before the hide, written ONCE by
    -- the job that read it; "back online" restores to min(pre_qty, what is held then) and never higher.
    CREATE TABLE IF NOT EXISTS event_targets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      target_key  TEXT NOT NULL,                  -- channel + listing, e.g. 'ebay:trading:9001'
      channel     TEXT NOT NULL CHECK (channel IN ('ebay','shopify')),
      target      TEXT NOT NULL,                  -- JSON: the job target as queued
      kind        TEXT NOT NULL,
      item_id     INTEGER,
      pool_sku    TEXT,
      pre_qty     INTEGER,
      state       TEXT,                           -- hidden | failed | ended | restoring | restored | attention
      note        TEXT,
      hidden_at   TEXT,
      restored_at TEXT,
      UNIQUE (event_id, target_key)
    );
    CREATE TABLE IF NOT EXISTS event_acquisitions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL CHECK (kind IN ('inventory','sealed')),
      item_id       INTEGER NOT NULL,
      sku           TEXT,
      qty           INTEGER NOT NULL DEFAULT 1,
      how           TEXT NOT NULL DEFAULT 'bought' CHECK (how IN ('bought','traded')),
      cost_cents    INTEGER,                      -- AUD, for the whole line (what was paid or traded away)
      channel       TEXT NOT NULL DEFAULT 'shopify' CHECK (channel IN ('shopify','ebay','none')),
      publish_state TEXT,                         -- null | 'published' | 'failed' | 'skipped'
      publish_error TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_event_items_item ON event_items(kind, item_id)');
  addColumnIfMissing(db, 'in_person_sales', 'event_id', 'INTEGER');
  // JSON: what the close-out recorded, and which cards sold twice (back online leaves those alone).
  addColumnIfMissing(db, 'events', 'close_report', 'TEXT');
  // The phone's idempotency key, one per sale (or per line of an end-of-day paste). A retried request or
  // a paste sent twice carries the same key, and the second write is refused by this index rather than
  // decrementing a multi-unit row or a sealed pool a second time.
  addColumnIfMissing(db, 'in_person_sales', 'client_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_ips_client_key ON in_person_sales(client_key) WHERE client_key IS NOT NULL');
  MIGRATED.add(db);
}

// --- units away at a show --------------------------------------------------------------------------

const AWAY_SQL = `COALESCE(SUM(ei.qty_taken - ei.qty_returned - ei.qty_sold_table - ei.qty_sold_close), 0)`;
const OPEN_EVENT = `e.status IN ('offline','closing')`;

/** Units of this stock row sitting at a show right now (offline or closing events). Never negative. */
export function awayUnits(db, kind, itemId) {
  migrateChannelSync(db);
  const r = db.prepare(`SELECT ${AWAY_SQL} AS n FROM event_items ei JOIN events e ON e.id = ei.event_id
                         WHERE ${OPEN_EVENT} AND ei.kind = ? AND ei.item_id = ?`).get(kind, +itemId);
  return Math.max(0, Number(r && r.n) || 0);
}

/** The same for a sealed pool: the sum over its rows. */
export function awayPoolUnits(db, poolSku) {
  migrateChannelSync(db);
  const r = db.prepare(`SELECT ${AWAY_SQL} AS n FROM event_items ei JOIN events e ON e.id = ei.event_id
                         JOIN sealed_items si ON si.id = ei.item_id
                         WHERE ${OPEN_EVENT} AND ei.kind = 'sealed' AND si.pool_sku = ?`).get(String(poolSku));
  return Math.max(0, Number(r && r.n) || 0);
}

/**
 * Record what a show's job did to one listing. pre_qty is set only the FIRST time (COALESCE), so a second
 * hide of an already-hidden listing — a pool hidden for two of its rows — cannot overwrite the real
 * pre-show number with the 0 it now reads.
 */
export function recordEventTarget(db, { eventId, channel, target, kind, itemId = null, poolSku = null, preQty = null, state, note = null }) {
  migrateChannelSync(db);
  const key = `${channel}:${targetKey(target || {})}`;
  db.prepare(`INSERT INTO event_targets (event_id, target_key, channel, target, kind, item_id, pool_sku, pre_qty, state, note,
                hidden_at, restored_at)
              VALUES (?,?,?,?,?,?,?,?,?,?, CASE WHEN ? = 'hidden' THEN datetime('now') END, CASE WHEN ? = 'restored' THEN datetime('now') END)
              ON CONFLICT(event_id, target_key) DO UPDATE SET
                pre_qty = COALESCE(event_targets.pre_qty, excluded.pre_qty),
                state = excluded.state, note = excluded.note,
                hidden_at = COALESCE(event_targets.hidden_at, excluded.hidden_at),
                restored_at = COALESCE(excluded.restored_at, event_targets.restored_at)`)
    .run(+eventId, key, channel, JSON.stringify(target || {}), kind, itemId == null ? null : +itemId, poolSku, preQty == null ? null : +preQty,
      state || null, note, state || null, state || null);
  return key;
}

/**
 * The open event this row is on, if any. `salesOnly` narrows it to the show a table sale can still belong
 * to: an OFFLINE one. Once a show's close-out is recorded (closing) everything that did not come back is
 * already counted as sold there, so a later sale is a sale at home, never a second one at the show.
 */
export function openEventItemFor(db, kind, itemId, { salesOnly = false } = {}) {
  migrateChannelSync(db);
  return db.prepare(`SELECT ei.*, e.name AS event_name, e.status AS event_status FROM event_items ei
                       JOIN events e ON e.id = ei.event_id
                      WHERE ${salesOnly ? "e.status = 'offline'" : OPEN_EVENT} AND ei.kind = ? AND ei.item_id = ?
                      ORDER BY e.id DESC LIMIT 1`).get(kind, +itemId) || null;
}

/**
 * The publish refusal while stock is at a show. A publish writes the shelf count onto the channel, and
 * with units away that number is wrong in the direction that matters: it would put a card that is
 * sitting on a table back on sale online. Refused by name, before anything is built or sent.
 */
export function assertNotAway(db, { kind = 'inventory', itemId = null, poolSku = null } = {}) {
  const n = kind === 'sealed' && poolSku ? awayPoolUnits(db, poolSku) : awayUnits(db, kind, itemId);
  if (!n) return null;
  const ev = kind === 'sealed' && poolSku
    ? db.prepare(`SELECT e.name FROM event_items ei JOIN events e ON e.id = ei.event_id JOIN sealed_items si ON si.id = ei.item_id
                   WHERE ${OPEN_EVENT} AND ei.kind = 'sealed' AND si.pool_sku = ? ORDER BY e.id DESC LIMIT 1`).get(String(poolSku))
    : openEventItemFor(db, kind, itemId);
  const name = ev ? (ev.event_name || ev.name) : 'a show';
  return {
    code: 'away_at_event', units_away: n,
    error: `${n} unit(s) of this are away at ${name} — it comes back online from that event's "Back online" step, not from a publish`,
  };
}

export function getSyncMeta(db, key) {
  migrateChannelSync(db);
  const r = db.prepare('SELECT value FROM channel_sync_meta WHERE key = ?').get(String(key));
  return r ? r.value : null;
}
export function setSyncMeta(db, key, value) {
  migrateChannelSync(db);
  db.prepare(`INSERT INTO channel_sync_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(String(key), value == null ? null : String(value));
}

// --- presence --------------------------------------------------------------------------------------

/** The pool a sealed row belongs to, or null. A pool is the listing unit on both channels. */
export function poolSkuOf(db, sealedItemId) {
  const r = db.prepare('SELECT pool_sku FROM sealed_items WHERE id = ?').get(+sealedItemId);
  return r && r.pool_sku ? String(r.pool_sku) : null;
}

/**
 * Shopify mirror rows offering this stock on the LIVE store.
 *
 * Drafts ('unpublished') are included: a draft is not buyable today, but it carries a quantity, and a
 * bulk "set active" in Shopify admin would sell a card we no longer have (audit K2). Bringing a draft's
 * quantity down with the sale is what stops the 206 eBay-listed drafts becoming 206 oversells at the
 * switch. `live` alone is what the refusals below ask about.
 */
export function shopifyPresence(db, kind, { itemId = null, poolSku = null } = {}) {
  if (kind === 'sealed') {
    const pool = poolSku || (itemId != null ? poolSkuOf(db, itemId) : null);
    if (!pool) return [];
    return db.prepare(`SELECT sku, store, kind, state, product_gid, inventory_gid, location_gid, available_qty, handle
                         FROM shopify_listings
                        WHERE store = 'live' AND kind = 'sealed' AND sku = ?
                          AND state IN ('live','unpublished')`).all(pool);
  }
  return db.prepare(`SELECT sku, store, kind, state, product_gid, inventory_gid, location_gid, available_qty, handle
                       FROM shopify_listings
                      WHERE store = 'live' AND kind = 'inventory' AND item_id = ?
                        AND state IN ('live','unpublished')`).all(+itemId);
}

/**
 * eBay listings offering this stock. Three shapes, because there are three ways onto eBay:
 *   api 'inventory' — a single the tool published (Sell Inventory API, has an offer id)
 *   api 'trading'   — a hand-made Seller Hub listing linked to this row (Trading API, ItemID only)
 *   api 'pool'      — a sealed pool the tool published (one offer for the whole pool)
 * The Sell Inventory API cannot see a Trading listing at all (AGENTS.md §16c), which is why the shapes
 * cannot be collapsed: each one has its own write path.
 */
export function ebayPresence(db, kind, { itemId = null, poolSku = null } = {}) {
  const out = [];
  if (kind === 'sealed') {
    const pool = poolSku || (itemId != null ? poolSkuOf(db, itemId) : null);
    if (pool) {
      const p = db.prepare(`SELECT pool_sku, ebay_offer_id, ebay_listing_id FROM sealed_pools
                             WHERE pool_sku = ? AND channel_status = 'active' AND ebay_offer_id IS NOT NULL`).get(pool);
      if (p) out.push({ api: 'pool', pool_sku: p.pool_sku, offer_id: String(p.ebay_offer_id), listing_id: p.ebay_listing_id || null });
    }
    if (itemId != null) {
      // A hand-made sealed listing. ebay_seller_listings.item_id references inventory_items only, so the
      // link for a box is its own ebay_listing_id, and the listing must be one the tool did NOT make (a
      // tool listing would be the pool's offer, already covered above).
      for (const r of db.prepare(`SELECT esl.listing_id, esl.available_qty, esl.sku
                                    FROM ebay_seller_listings esl
                                    JOIN sealed_items si ON si.ebay_listing_id = esl.listing_id
                                   WHERE si.id = ? AND esl.state = 'active'
                                     AND COALESCE(esl.created_via, 'manual') <> 'tool'`).all(+itemId)) {
        out.push({ api: 'trading', listing_id: String(r.listing_id), available_qty: r.available_qty, sku: r.sku || null });
      }
    }
    return out;
  }
  // NOT channel_status alone. The sale decrement (lib/postsale.mjs) writes channel_status = 'ended' the
  // moment a row sells out, on the assumption that eBay ended its own listing — true for an eBay sale,
  // false for a Shopify or in-person one. Trusting it here would make a card that sold on Shopify read
  // as off eBay while it is still for sale there. The ebay_listings mirror is only moved by an eBay
  // read (reconcile, recheck) or our own withdraw, so it is the honest second witness; the job re-reads
  // the offer before it writes anything, so a stale ACTIVE costs one read and nothing more.
  const inv = db.prepare(`SELECT ii.sku, ii.ebay_offer_id, ii.ebay_listing_id FROM inventory_items ii
                           WHERE ii.id = ? AND ii.ebay_offer_id IS NOT NULL
                             AND (ii.channel_status = 'active'
                                  OR EXISTS (SELECT 1 FROM ebay_listings el
                                              WHERE el.offer_id = ii.ebay_offer_id AND el.listing_status = 'ACTIVE'))`).get(+itemId);
  if (inv) out.push({ api: 'inventory', offer_id: String(inv.ebay_offer_id), listing_id: inv.ebay_listing_id || null, sku: inv.sku });
  for (const r of db.prepare(`SELECT listing_id, available_qty, sku FROM ebay_seller_listings
                               WHERE item_id = ? AND state = 'active' AND COALESCE(created_via, 'manual') <> 'tool'`).all(+itemId)) {
    out.push({ api: 'trading', listing_id: String(r.listing_id), available_qty: r.available_qty, sku: r.sku || null });
  }
  return out;
}

/** Both channels at once, for the lookup and the page chips. */
export function channelPresence(db, kind, ref = {}) {
  return { ebay: ebayPresence(db, kind, ref), shopify: shopifyPresence(db, kind, ref) };
}

// --- the refusals ----------------------------------------------------------------------------------
//
// ONE CHANNEL AT A TIME, unless the owner says otherwise for a multi-quantity item. The override is a
// per-call body flag (`allowDualList`) and nothing else: never a config key or an env var, either of
// which can be left switched on and forgotten — the same rule allowUnverified follows (AGENTS.md §23).
// It is IGNORED for a quantity of one, because there is no version of a one-of-one on two channels that
// is not a double sale waiting to happen.

function dualListRefusal({ code, here, there, quantity, allowDualList, sku, detail }) {
  const q = Math.max(0, Math.floor(Number(quantity) || 0));
  if (allowDualList && q > 1) return null;
  const what = sku ? `${sku} ` : '';
  const error = q <= 1
    ? `${what}is live on ${there}, and it is a one-of-one: a card can only be for sale on one channel at a time. `
      + `Take it off ${there} first, then list it on ${here}.`
    : `${what}is live on ${there}. Listing its ${q} units on ${here} as well means two channels selling the same `
      + 'stock — pass allowDualList: true for this call if that is deliberate.';
  return { code, error, quantity: q, dual_list_allowed: false, [there === 'Shopify' ? 'shopify' : 'ebay']: detail };
}

/**
 * Before an eBay publish: is this card live on the LIVE Shopify store?
 *
 * 'live' only — a DRAFT is on no sales channel (lib/shopify.mjs records it 'unpublished'), which is how
 * the eBay-listed estate already sits on live without being purchasable twice. A live product whose
 * mirror says 0 available is sold out there, so it does not count either: zeroing it on Shopify is the
 * documented way to move a card from Shopify to eBay.
 */
export function assertNotLiveOnShopify(db, { kind = 'inventory', itemId = null, poolSku = null, quantity = 1, allowDualList = false, sku = null } = {}) {
  const live = shopifyPresence(db, kind, { itemId, poolSku })
    .filter((r) => r.state === 'live' && !(r.available_qty === 0));
  if (!live.length) return null;
  return dualListRefusal({
    code: 'live_on_shopify', here: 'eBay', there: 'Shopify', quantity, allowDualList,
    sku: sku || live[0].sku, detail: { sku: live[0].sku, handle: live[0].handle || null, available_qty: live[0].available_qty },
  });
}

/** Before a Shopify ACTIVE publish on the live store: is this stock live on eBay? */
export function assertNotLiveOnEbay(db, { kind = 'inventory', itemId = null, poolSku = null, quantity = 1, allowDualList = false, sku = null } = {}) {
  const live = ebayPresence(db, kind, { itemId, poolSku });
  if (!live.length) return null;
  return dualListRefusal({
    code: 'live_on_ebay', here: 'Shopify', there: 'eBay', quantity, allowDualList, sku,
    detail: { api: live[0].api, listing_id: live[0].listing_id || null, offer_id: live[0].offer_id || null },
  });
}

// --- the queue -------------------------------------------------------------------------------------
//
// THE OUTBOX, NOT AN INLINE CALL. vite.config.js imports every lib/*.mjs, so saving any of them restarts
// the dev server — an in-memory "end AAC-097 on eBay" retry dies mid-flight on an unrelated edit, and on
// a one-of-one that is an oversell caused by a stray save (lib/db.mjs says the same at sync_jobs).
//
// A JOB NAMES A TARGET, NOT A NUMBER. The quantity to leave on the channel is computed when the job RUNS,
// from the stock row as it is then, so a job that sat through three more sales still does the right
// thing and running it twice changes nothing.
//
// dedupe_key collapses redundant enqueues while a job is waiting, and is cleared when it finishes so the
// next sale can queue a fresh one. A job that is RUNNING when another sale lands is flagged `again` and
// re-queued by the worker as it finishes, because its run-time read may predate that sale.

export const JOB_EBAY = 'ebay.setqty';
export const JOB_SHOPIFY = 'shopify.setqty';

// THREE MODES, one per reason a channel's number has to change:
//   sale    — stock left the shelf; bring every other channel down to what is left (never raise)
//   away    — stock is going to a show; hide it (quantity 0 while units are still on hand — NEVER end)
//   restore — the show is over; put back what the 'away' job took down, and no more
// Each mode has its own dedupe key, so a sale landing while a show's hide is still queued does not merge
// two different instructions into one job.
export const MODES = Object.freeze(['sale', 'away', 'restore']);

export function targetKey(t) {
  if (t.api === 'inventory') return `offer:${t.offer_id}`;
  if (t.api === 'pool') return `pool:${t.pool_sku}`;
  if (t.api === 'trading') return `trading:${t.listing_id}`;
  return `shopify:${t.sku}`;
}

function upsertJob(db, { kind, channel, sku, payload, dedupeKey, priority = 0, initialState = 'queued' }) {
  const cur = db.prepare('SELECT id, state, payload FROM sync_jobs WHERE dedupe_key = ?').get(dedupeKey);
  if (!cur) {
    const r = db.prepare(`INSERT INTO sync_jobs (kind, channel, sku, payload, dedupe_key, priority, run_after, state)
                          VALUES (?,?,?,?,?,?, datetime('now'), ?)`)
      .run(kind, channel, String(sku || ''), JSON.stringify(payload), dedupeKey, priority, initialState);
    return { id: Number(r.lastInsertRowid), state: initialState, created: true };
  }
  let prev = {};
  try { prev = cur.payload ? JSON.parse(cur.payload) : {}; } catch { prev = {}; }
  const reasons = [...new Set([...(prev.reasons || []), ...(payload.reasons || [])])].slice(-10);
  if (cur.state === 'running') {
    db.prepare('UPDATE sync_jobs SET payload = ? WHERE id = ?').run(JSON.stringify({ ...prev, reasons, again: true }), cur.id);
    return { id: cur.id, state: 'running', again: true };
  }
  // queued, paused or failed (waiting out a backoff): a fresh reason is a reason to try NOW, not after the
  // backoff. attempts are kept, so a target that keeps failing still reaches 'dead' and still raises the
  // alarm. A paused job stays paused — only its owner (a show's canary) releases it.
  const state = cur.state === 'paused' ? 'paused' : 'queued';
  db.prepare(`UPDATE sync_jobs SET payload = ?, state = ?, run_after = datetime('now'), priority = MIN(priority, ?)
              WHERE id = ?`).run(JSON.stringify({ ...prev, ...payload, reasons }), state, priority, cur.id);
  return { id: cur.id, state, merged: true };
}

/**
 * Queue a job for every channel offering this stock, except `skip` (the channel a sale happened on,
 * which has already taken its own unit).
 *
 * `mode` is sale | away | restore (see MODES). `targets` overrides presence — a restore names the
 * listings its show hid, which presence may no longer report once they are hidden. `initialState`
 * 'paused' holds jobs until a caller releases them (the show's canary). `extra` rides on the payload.
 *
 * Returns { jobs: [{id, channel, target}] } — empty when nothing is listed anywhere, which is the common
 * case for a card sold at a show that was never online.
 */
export function enqueueChannelSync(db, {
  kind = 'inventory', itemId, skip = null, reason = 'stock changed', ref = null,
  mode = 'sale', targets = null, initialState = 'queued', extra = {}, channels = null,
} = {}) {
  migrateChannelSync(db);
  if (!MODES.includes(mode)) throw new Error('channel-sync: unknown mode ' + mode);
  const id = +itemId;
  const poolSku = kind === 'sealed' ? poolSkuOf(db, id) : null;
  const sku = (db.prepare(`SELECT sku FROM ${kind === 'sealed' ? 'sealed_items' : 'inventory_items'} WHERE id = ?`).get(id) || {}).sku || null;
  const jobs = [];
  const base = { ...extra, mode, kind, item_id: id, pool_sku: poolSku, reasons: [ref ? `${reason} (${ref})` : reason] };
  const prefix = mode === 'sale' ? '' : mode + ':';
  const want = (ch) => skip !== ch && (!channels || channels.includes(ch));

  const ebayTargets = targets ? targets.filter((t) => t.channel === 'ebay') : ebayPresence(db, kind, { itemId: id, poolSku });
  const shopTargets = targets
    ? targets.filter((t) => t.channel === 'shopify')
    : shopifyPresence(db, kind, { itemId: id, poolSku }).map((t) => ({ api: 'shopify', sku: t.sku, store: 'live', state: t.state }));

  if (want('ebay')) {
    for (const t0 of ebayTargets) {
      const { channel: _c, ...t } = t0;
      const r = upsertJob(db, {
        kind: JOB_EBAY, channel: 'ebay', sku: t.sku || t.pool_sku || sku, initialState,
        payload: { ...base, target: t }, dedupeKey: `${prefix}ebay:${targetKey(t)}`,
      });
      jobs.push({ ...r, channel: 'ebay', target: t });
    }
  }
  if (want('shopify')) {
    for (const t0 of shopTargets) {
      const { channel: _c, ...t } = t0;
      const target = { api: 'shopify', sku: t.sku, store: 'live', state: t.state || null };
      const r = upsertJob(db, {
        kind: JOB_SHOPIFY, channel: 'shopify', sku: t.sku, initialState,
        payload: { ...base, target }, dedupeKey: `${prefix}shopify:${targetKey(target)}`,
      });
      jobs.push({ ...r, channel: 'shopify', target });
    }
  }
  return { jobs, skipped: skip };
}

// --- the ledger scan -------------------------------------------------------------------------------
//
// THE ONE TRIGGER THAT NEEDS NO CALLER TO REMEMBER IT. Every path that takes units off the shelf writes
// a negative stock_movements row — an eBay order (applyStockDecrements, unchanged), a Shopify order
// through the same function, a Runs pack, a stocktake, a loss, a hand edit of the quantity. Scanning the
// ledger for those catches all of them, including ones written after this file, without a single edit
// to lib/postsale.mjs's carefully ordered decrement.
//
// THE CURSOR STARTS AT THE CURRENT END on first run. History is never replayed: a sale recorded weeks
// before this existed already happened, and a listing still up for it is DRIFT — reported by the drift
// view and fixed deliberately by name, never by a deploy quietly ending live listings.

export const MOVEMENT_CURSOR = 'movement_cursor';

/** Which channel a movement's sale happened on, so that channel is not told about its own sale. */
export function saleChannelOf(m) {
  if (!m || m.ref_kind !== 'order' || !m.ref_id) return null;
  return String(m.ref_id).startsWith('shopify:') ? 'shopify' : 'ebay';
}

// Units still held behind the LISTING this row is on: its pool's for a pooled box, its own otherwise.
// Inline SQL rather than poolUnits/onHandUnits, which live in modules that import this one.
function unitsLeft(db, kind, itemId) {
  if (kind === 'sealed') {
    const pool = poolSkuOf(db, itemId);
    if (pool) {
      return Number(db.prepare(`SELECT COALESCE(SUM(sp.quantity), 0) AS n FROM sealed_items si JOIN sealed_placements sp ON sp.item_id = si.id
                                 WHERE si.pool_sku = ? AND si.status IN ('in_stock','listed')`).get(pool).n) || 0;
    }
  }
  const row = db.prepare(`SELECT quantity, status FROM ${kind === 'sealed' ? 'sealed_items' : 'inventory_items'} WHERE id = ?`).get(+itemId);
  return !row || row.status === 'sold' ? 0 : Number(row.quantity) || 0;
}

/**
 * Move the ledger cursor to the current end WITHOUT queueing anything. The first ARMED boot does this, so
 * nothing the ledger gained before the sync was switched on is ever replayed onto a live channel.
 */
export function pinMovementCursor(db) {
  migrateChannelSync(db);
  const top = (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM stock_movements').get() || {}).n || 0;
  setSyncMeta(db, MOVEMENT_CURSOR, top);
  return top;
}

export function scanMovements(db, { limit = 500 } = {}) {
  migrateChannelSync(db);
  const raw = getSyncMeta(db, MOVEMENT_CURSOR);
  if (raw == null) {
    const top = (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM stock_movements').get() || {}).n || 0;
    setSyncMeta(db, MOVEMENT_CURSOR, top);
    return { initialised: true, cursor: top, scanned: 0, enqueued: 0 };
  }
  const cursor = Number(raw) || 0;
  const rows = db.prepare(`SELECT id, kind, item_id, delta, reason, ref_kind, ref_id FROM stock_movements
                            WHERE id > ? ORDER BY id LIMIT ?`).all(cursor, Math.max(1, limit));
  let enqueued = 0;
  let last = cursor;
  for (const m of rows) {
    last = m.id;
    if (!(m.delta < 0)) continue;
    // An in-person sale queues its own jobs IN THE SAME TRANSACTION as its movement and drains them
    // while the phone waits for the answer; queueing them again here would only re-read channels that
    // were just brought down.
    if (m.ref_kind === 'in_person') continue;
    // The channel the sale happened on is skipped only when the stock SOLD OUT: that channel has ended
    // its own listing. With units left it is not skipped, because its count can be wrong too — eBay
    // sells one while a Shopify sale is still being ingested, and an absolute write from either side can
    // land over the other's decrement. Healing that costs one read; leaving it is an oversell.
    const r = enqueueChannelSync(db, {
      kind: m.kind, itemId: m.item_id, skip: unitsLeft(db, m.kind, m.item_id) > 0 ? null : saleChannelOf(m),
      reason: m.reason, ref: `movement #${m.id}`,
    });
    enqueued += r.jobs.length;
  }
  if (last !== cursor) setSyncMeta(db, MOVEMENT_CURSOR, last);
  return { initialised: false, cursor: last, scanned: rows.length, enqueued, more: rows.length >= limit };
}
