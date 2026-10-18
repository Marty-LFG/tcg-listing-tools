// lib/events.mjs — a show or market, from the take-list to everything back online.
//
// The owner's flow (2026-10-18):
//   1. log the event and scan the stock going to it;
//   2. take that stock OFFLINE everywhere — hidden on eBay at quantity 0 (the listing, its item number and
//      its watchers kept, thanks to the account's out-of-stock option), sold out on Shopify;
//   3. sell at the table, recording as you go if there is time (sell.html — assume there will not be);
//   4. close out: scan back what came home (anything else on the list SOLD), enter the takings, and enter
//      what was bought or traded in, in full detail;
//   5. put everything back online — the returned stock to exactly what each listing offered before, and
//      the new stock to the channel picked for it (Shopify unless said otherwise).
//
// WHAT MAKES IT SAFE TO RUN AGAINST LIVE LISTINGS
//   · Units AWAY (taken − returned − sold on an offline/closing event) are subtracted from what any
//     channel may offer (lib/channel-presence.mjs awayUnits), so every existing path agrees: the sync
//     worker, the drift report, and the publish refusal `away_at_event` that stops a publish putting a
//     card on a table back on sale.
//   · Every channel write goes through the sync_jobs outbox (lib/channel-sync.mjs), so a dev-server
//     restart halfway through taking forty cards offline loses nothing.
//   · The hide NEVER ends a listing. eBay's out-of-stock option is read first and the hide is refused if
//     it is off; the first eBay listing is hidden alone as a CANARY, and if eBay's read-back says it ended
//     instead, every other eBay hide stays paused and the page says why.
//   · "Back online" may raise a channel only to what THAT listing offered before the hide (captured once,
//     by the job that read it — event_targets.pre_qty), and never above what is held.
//
// Money is AUD cents (GR3). The takings split is `apportion` (lib/purchasing-money.mjs): largest remainder,
// exact to the cent.
import {
  migrateChannelSync, enqueueChannelSync, ebayPresence, shopifyPresence, awayUnits, awayPoolUnits, targetKey,
} from './channel-presence.mjs';
import { drainJobs, shelf, syncArmed, SYNC_OFF_MESSAGE } from './channel-sync.mjs';
import { recordInPersonSale, resolveLine } from './in-person-sales.mjs';
import { apportion } from './purchasing-money.mjs';
import { assertNotReserved, reservedUnits, onHandUnits } from './runs-reserve.mjs';
import { recordVerification } from './verification.mjs';

const clean = (s) => String(s == null ? '' : s).trim();
const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v)));
// A money field from the page: blank is "not given", anything else must be a whole number of cents >= 0.
// NaN reaching a sale row refused every line of a close-out and still moved the event on (review 2026-10-18).
const badCents = (v) => !(v == null || v === '') && !(Number.isFinite(Number(v)) && Number(v) >= 0);
const TABLE = (kind) => (kind === 'sealed' ? 'sealed_items' : 'inventory_items');
const err = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

// ONE STEP AT A TIME PER SHOW. Take offline, close out and back online each read the event's status and
// then await network writes; two of them at once (a second tab, a retried POST) both passed the status
// check and ran two canaries. Process-wide, on globalThis, because a Vite re-evaluation of this module
// must share the set rather than open a second one beside it.
function eventLocks() { return globalThis.__eventStepLocks || (globalThis.__eventStepLocks = new Set()); }
async function withEventLock(eventId, fn) {
  const L = eventLocks();
  const k = +eventId;
  if (L.has(k)) return err('busy', 'this show is already being updated (another tab, or a request still running) — wait for it to finish, then reload');
  L.add(k);
  try { return await fn(); } finally { L.delete(k); }
}

// What counts as a canary's PROOF: a quantity write eBay accepted and read back. A no-op (already at 0),
// a listing that had already ended, or one that is gone proves nothing about what a write does — and
// after a canary eBay ENDED, the retry's first job reads exactly that ended listing.
const PROOF = new Set(['hidden', 'reduced']);
// Each eBay write path is its own canary: a hand-made listing (ReviseInventoryStatus) proving its path
// says nothing about bulkUpdatePriceQuantity, which a tool listing or a sealed pool goes through.
const EBAY_PATHS = ['trading', 'inventory', 'pool'];

// --- reads -----------------------------------------------------------------------------------------

export function getEvent(db, id) {
  migrateChannelSync(db);
  return db.prepare('SELECT * FROM events WHERE id = ?').get(+id) || null;
}

export function listEvents(db, { status = null, limit = 50 } = {}) {
  migrateChannelSync(db);
  const rows = status
    ? db.prepare('SELECT * FROM events WHERE status = ? ORDER BY id DESC LIMIT ?').all(String(status), limit)
    : db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((e) => ({ ...e, counts: counts(db, e.id) }));
}

function counts(db, eventId) {
  const r = db.prepare(`SELECT COUNT(*) AS lines, COALESCE(SUM(qty_taken),0) AS taken, COALESCE(SUM(qty_returned),0) AS returned,
                               COALESCE(SUM(qty_sold_table),0) AS sold_table, COALESCE(SUM(qty_sold_close),0) AS sold_close
                          FROM event_items WHERE event_id = ?`).get(+eventId);
  return { ...r, missing: r.taken - r.returned - r.sold_table - r.sold_close };
}

function itemView(db, ei) {
  const row = db.prepare(`SELECT * FROM ${TABLE(ei.kind)} WHERE id = ?`).get(ei.item_id) || {};
  const missing = ei.qty_taken - ei.qty_returned - ei.qty_sold_table - ei.qty_sold_close;
  return {
    ...ei, missing,
    name: row.name || null, set_name: row.set_name || null, number: row.number || null,
    condition: row.condition || null, grading_company: row.grading_company || null, grade: row.grade ?? null,
    image_url: row.image_url || null, status: row.status || null, quantity: row.quantity ?? null,
    ask_cents: row.target_price_cents ?? null, pool_sku: row.pool_sku || null,
    presence: { ebay: ebayPresence(db, ei.kind, { itemId: ei.item_id }), shopify: shopifyPresence(db, ei.kind, { itemId: ei.item_id }) },
  };
}

/** The whole event, as the page renders it. */
export function eventDetail(db, id) {
  const e = getEvent(db, id);
  if (!e) return null;
  const items = db.prepare('SELECT * FROM event_items WHERE event_id = ? ORDER BY id').all(e.id).map((ei) => itemView(db, ei));
  const targets = db.prepare('SELECT * FROM event_targets WHERE event_id = ? ORDER BY id').all(e.id)
    .map((t) => ({ ...t, target: safeJson(t.target) }));
  const acquisitions = db.prepare('SELECT * FROM event_acquisitions WHERE event_id = ? ORDER BY id').all(e.id).map((a) => {
    const row = db.prepare(`SELECT name, set_name, number, condition, grading_company, grade, target_price_cents, image_url, sku FROM ${TABLE(a.kind)} WHERE id = ?`).get(a.item_id) || {};
    return { ...a, ...row, sku: a.sku || row.sku || null };
  });
  const sales = db.prepare('SELECT id, kind, item_id, sku, name, qty, unit_price_cents, created_at FROM in_person_sales WHERE event_id = ? ORDER BY id').all(e.id);
  let report = null;
  try { report = e.offline_report ? JSON.parse(e.offline_report) : null; } catch { /* old shape */ }
  return { event: { ...e, offline_report: report }, counts: counts(db, e.id), items, targets, acquisitions, sales };
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// --- 1. plan ---------------------------------------------------------------------------------------

export function createEvent(db, { name, venue = null, starts_on = null, ends_on = null, notes = null } = {}) {
  migrateChannelSync(db);
  if (!clean(name)) return err('bad_request', 'give the event a name');
  const r = db.prepare('INSERT INTO events (name, venue, starts_on, ends_on, notes) VALUES (?,?,?,?,?)')
    .run(clean(name), clean(venue) || null, clean(starts_on) || null, clean(ends_on) || null, clean(notes) || null);
  return { ok: true, event: getEvent(db, Number(r.lastInsertRowid)) };
}

/** Units of a row free to take: held, minus Run reservations (sealed), minus what is away at another show. */
function freeToTake(db, kind, row) {
  const held = onHandUnits(db, kind, row.id);
  const reserved = kind === 'sealed' ? reservedUnits(db, 'sealed', row.id) : 0;
  return Math.max(0, held - reserved - awayUnits(db, kind, row.id));
}

/**
 * Scan a label onto the take-list. On an OFFLINE event (something forgotten while packing) the result
 * says `needs_offline`, and the route runs takeOffline again — so the card goes through the same canary
 * rules as everything else: on a path this show has already proved it is hidden at once, on a path it
 * has not (or after a canary failed) it waits behind a fresh canary instead of being sent blind.
 */
export function addToTakeList(db, eventId, line = {}) {
  const e = getEvent(db, eventId);
  if (!e) return err('not_found', 'no such event');
  if (!['planning', 'offline'].includes(e.status)) return err('wrong_status', `the take-list is closed — this event is ${e.status}`);
  const r = resolveLine(db, line);
  if (!r.ok) return err(r.code, r.error);
  const { kind, row } = r;
  if (row.status === 'sold') return err('already_sold', `${row.sku || 'this item'} is already sold`);
  if (kind === 'inventory') {
    const held = assertNotReserved(db, 'inventory', row.id);
    if (held) return err(held.code, held.error);
  }
  const other = db.prepare(`SELECT e.name FROM event_items ei JOIN events e ON e.id = ei.event_id
                             WHERE ei.kind = ? AND ei.item_id = ? AND ei.event_id <> ? AND e.status IN ('planning','offline','closing')`)
    .get(kind, row.id, e.id);
  if (other) return err('on_another_event', `${row.sku || 'this item'} is already on the take-list for ${other.name}`);
  const existing = db.prepare('SELECT * FROM event_items WHERE event_id = ? AND kind = ? AND item_id = ?').get(e.id, kind, row.id);
  const want = Math.max(1, Math.floor(Number(line.qty ?? line.quantity ?? 1) || 1));
  const total = (existing ? existing.qty_taken : 0) + want;
  // On an offline event the row's own units are already counted away, so they are added back before
  // checking what is free.
  const free = freeToTake(db, kind, row) + (existing && e.status === 'offline' ? existing.qty_taken : 0);
  if (kind === 'inventory' && existing && (row.quantity ?? 1) <= 1) return err('already_listed', `${row.sku} is already on this take-list`);
  if (total > free) return err('not_enough', `${row.sku || 'this item'} has ${free} free to take, not ${total}`);
  let eiId;
  if (existing) {
    db.prepare('UPDATE event_items SET qty_taken = ? WHERE id = ?').run(total, existing.id);
    eiId = existing.id;
  } else {
    eiId = Number(db.prepare('INSERT INTO event_items (event_id, kind, item_id, sku, qty_taken) VALUES (?,?,?,?,?)')
      .run(e.id, kind, row.id, row.sku || null, want).lastInsertRowid);
  }
  return { ok: true, item: itemView(db, db.prepare('SELECT * FROM event_items WHERE id = ?').get(eiId)), needs_offline: e.status === 'offline' };
}

export function removeFromTakeList(db, eventId, eventItemId) {
  const e = getEvent(db, eventId);
  if (!e) return err('not_found', 'no such event');
  if (e.status !== 'planning') return err('wrong_status', 'once stock is offline it comes off the list by being scanned back at close-out');
  const n = db.prepare('DELETE FROM event_items WHERE id = ? AND event_id = ?').run(+eventItemId, e.id).changes;
  return n ? { ok: true } : err('not_found', 'not on this take-list');
}

// --- 2. take offline -------------------------------------------------------------------------------

/**
 * takeOffline — hide every take-list item on every channel. Safe to call again: it queues only what this
 * show has not hidden yet, and runs a fresh canary on any eBay path still unproved.
 *
 * `confirmed` is required to go again after a canary eBay ENDED: the retry's canary is another real
 * listing, so it is sent only once the owner says the out-of-stock option has been looked at.
 *
 * ctx = { db, env, deps } — the sync worker's context (deps carries getOutOfStockControl, the channels).
 */
export function takeOffline(ctx, eventId, opts = {}) {
  return withEventLock(eventId, () => takeOfflineLocked(ctx, eventId, opts));
}

async function takeOfflineLocked(ctx, eventId, { budgetMs = 60_000, confirmed = false } = {}) {
  const { db, env, deps } = ctx;
  const e = getEvent(db, eventId);
  if (!e) return err('not_found', 'no such event');
  // Disarmed, nothing can be hidden — and flipping the show to offline anyway would tell the owner the
  // stock is off the internet while every listing is still live.
  if (!syncArmed(env)) return err('sync_off', 'nothing was taken offline: ' + SYNC_OFF_MESSAGE);
  if (!['planning', 'offline'].includes(e.status)) return err('wrong_status', `this event is ${e.status}`);
  const items = db.prepare('SELECT * FROM event_items WHERE event_id = ?').all(e.id);
  if (!items.length) return err('empty', 'the take-list is empty — scan what is going first');

  // Re-check every line against what is on the shelf NOW (a card may have sold since it was scanned).
  if (e.status === 'planning') {
    const short = [];
    for (const ei of items) {
      const row = db.prepare(`SELECT * FROM ${TABLE(ei.kind)} WHERE id = ?`).get(ei.item_id);
      if (!row || row.status === 'sold') { short.push({ sku: ei.sku, why: 'sold since it was scanned' }); continue; }
      if (freeToTake(db, ei.kind, row) < ei.qty_taken) short.push({ sku: ei.sku, why: `only ${freeToTake(db, ei.kind, row)} free` });
    }
    if (short.length) return err('take_list_stale', `${short.length} line(s) on the take-list no longer have the stock — fix or remove them first`, { lines: short });
  }

  // Preflight: which channels are involved, and can they be hidden at all?
  const hasEbay = items.some((ei) => ebayPresence(db, ei.kind, { itemId: ei.item_id }).length);
  const hasShop = items.some((ei) => shopifyPresence(db, ei.kind, { itemId: ei.item_id }).length);
  const preflight = { ebay: hasEbay, shopify: hasShop, out_of_stock_option: null };
  if (hasEbay) {
    if (!deps.ebayConnected(env)) return err('ebay_not_connected', 'some of this stock is live on eBay, and eBay is not connected on this box — nothing was taken offline');
    const oos = await deps.getOutOfStockControl(env);
    preflight.out_of_stock_option = oos.enabled;
    if (!oos.ok || oos.enabled !== true) {
      return err('out_of_stock_option_off',
        oos.ok
          ? "eBay's out-of-stock option is OFF on this account, so a listing taken to 0 would END instead of hiding. Switch it on in Seller Hub (Account → Site preferences → Selling preferences → 'Use the out-of-stock option') and try again — nothing was taken offline."
          : `could not read eBay's out-of-stock setting (${oos.error}) — nothing was taken offline`,
        { preflight });
    }
  }
  if (hasShop && !deps.shopifyConfigured(env)) {
    return err('shopify_not_configured', 'some of this stock is on the live Shopify store, which is not configured on this box — nothing was taken offline');
  }
  let prior = null;
  try { prior = e.offline_report ? JSON.parse(e.offline_report) : null; } catch { /* old shape */ }
  if (prior && prior.canary_ended && !confirmed) {
    return err('confirm_retry',
      'last time eBay ENDED the listing it was asked to hide. Going again sends another real listing as the check — '
      + "look at the out-of-stock option in Seller Hub first, then confirm.", { report: prior });
  }

  // From here the stock is AWAY: the status flip is what makes every other path subtract it.
  if (e.status === 'planning') {
    db.prepare(`UPDATE events SET status = 'offline', offline_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(e.id);
  }

  // Queue only what this show has not already dealt with: a listing hidden (or found ended, or sold) on an
  // earlier run is not sent again. eBay jobs start PAUSED — only a canary releases them; Shopify goes now.
  const done = new Set(db.prepare("SELECT target_key FROM event_targets WHERE event_id = ? AND state IN ('hidden','ended','sold')").all(e.id).map((r) => r.target_key));
  const ebayJobs = [], shopJobs = [];
  for (const ei of items) {
    const base = { kind: ei.kind, itemId: ei.item_id, mode: 'away', reason: 'taken to ' + e.name, ref: ei.sku || null, extra: { event_id: e.id } };
    const ebayT = ebayPresence(db, ei.kind, { itemId: ei.item_id }).map((t) => ({ ...t, channel: 'ebay' }))
      .filter((t) => !done.has('ebay:' + targetKey(t)));
    const shopT = shopifyPresence(db, ei.kind, { itemId: ei.item_id })
      .map((t) => ({ api: 'shopify', sku: t.sku, store: 'live', state: t.state, channel: 'shopify' }))
      .filter((t) => !done.has('shopify:' + targetKey(t)));
    if (ebayT.length) {
      for (const j of enqueueChannelSync(db, { ...base, targets: ebayT, initialState: 'paused', channels: ['ebay'] }).jobs) {
        if (!ebayJobs.some((x) => x.id === j.id)) ebayJobs.push(j);
      }
    }
    if (shopT.length) {
      for (const j of enqueueChannelSync(db, { ...base, targets: shopT, channels: ['shopify'] }).jobs) {
        if (!shopJobs.some((x) => x.id === j.id)) shopJobs.push(j);
      }
    }
  }
  const proven = new Set((prior && Array.isArray(prior.proven)) ? prior.proven : []);
  const report = { preflight, at: new Date().toISOString(), canary: null, canaries: [], ebay: [], shopify: [], proven: [] };
  const release = (id) => db.prepare(`UPDATE sync_jobs SET state = 'queued', run_after = datetime('now') WHERE id = ? AND state = 'paused'`).run(id);
  const pending = ebayJobs.filter((j) => j.state === 'paused' || j.state === 'queued');

  // THE CANARIES, one per eBay write path, each alone. A path's first job must come back as a write eBay
  // accepted and read back (PROOF); a job that proves nothing (already at 0, already ended) hands the
  // canary to the next one. Any failure stops everything still paused, on every path.
  let failed = null;
  for (const api of EBAY_PATHS) {
    if (failed) break;
    const group = pending.filter((j) => (j.target && j.target.api) === api);
    if (!group.length) continue;
    let i = 0;
    if (!proven.has(api)) {
      while (i < group.length) {
        const j = group[i++];
        release(j.id);
        const [c] = await drainJobs(ctx, [j.id], { budgetMs });
        report.canaries.push({ api, ...c });
        if (!report.canary) report.canary = { api, ...c };
        if (!c || !c.ok) { failed = { api, ...(c || {}) }; break; }
        if (PROOF.has(c.action)) { proven.add(api); break; }
      }
      if (failed || !proven.has(api)) continue;
    }
    // Proven: the rest of this path. Released together, drained one by one; if eBay ends any of them, the
    // worker itself pauses every other hide of this show (lib/channel-sync.mjs runJob), wherever it runs.
    const rest = group.slice(i).map((j) => j.id);
    for (const id of rest) release(id);
    if (rest.length) report.ebay.push(...await drainJobs(ctx, rest, { budgetMs }));
  }
  if (!pending.length) report.canary = { ok: true, skipped: done.size ? 'already hidden' : 'nothing on eBay' };
  if (failed) {
    report.canary_failed = true;
    report.canary = failed;
    report.canary_ended = !!failed.ended;
  }
  const stopped = report.ebay.find((r) => r && r.ended);
  if (stopped) { report.stopped = stopped; report.canary_ended = true; }
  report.held_back = db.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE state = 'paused' AND channel = 'ebay'
                                   AND json_extract(payload, '$.mode') = 'away' AND json_extract(payload, '$.event_id') = ?`).get(e.id).n;
  report.proven = [...proven];
  report.shopify = shopJobs.length ? await drainJobs(ctx, shopJobs.map((j) => j.id), { budgetMs }) : [];
  db.prepare(`UPDATE events SET offline_report = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(report), e.id);
  return { ok: !failed && !stopped, report, event: eventDetail(db, e.id) };
}

// --- 4. close out ----------------------------------------------------------------------------------

/** Scan one label coming home. Sealed rows (or any multi-unit row) take a quantity. */
export function scanBack(db, eventId, line = {}) {
  const e = getEvent(db, eventId);
  if (!e) return err('not_found', 'no such event');
  if (e.status !== 'offline') return err('wrong_status', e.status === 'planning' ? 'nothing has left yet — this event is still being planned' : 'the close-out is already recorded');
  const r = resolveLine(db, line, { eventId: e.id });
  if (!r.ok) return err(r.code, r.error);
  const ei = db.prepare('SELECT * FROM event_items WHERE event_id = ? AND kind = ? AND item_id = ?').get(e.id, r.kind, r.row.id);
  if (!ei) return err('not_on_list', `${r.row.sku || 'this item'} was not on this show's take-list — it never left the shelf as far as the tool knows`);
  const room = ei.qty_taken - ei.qty_returned - ei.qty_sold_table - ei.qty_sold_close;
  const n = Math.max(1, Math.floor(Number(line.qty ?? 1) || 1));
  if (room <= 0) return err('all_accounted', `${ei.sku}: every unit taken is already scanned back or sold`);
  const take = Math.min(n, room);
  db.prepare('UPDATE event_items SET qty_returned = qty_returned + ? WHERE id = ?').run(take, ei.id);
  return { ok: true, scanned: take, capped: take < n, item: itemView(db, db.prepare('SELECT * FROM event_items WHERE id = ?').get(ei.id)) };
}

/** Correct a scan: set how many of a line came back. */
export function setReturned(db, eventId, eventItemId, qty) {
  const e = getEvent(db, eventId);
  if (!e) return err('not_found', 'no such event');
  if (e.status !== 'offline') return err('wrong_status', 'the close-out is already recorded');
  const ei = db.prepare('SELECT * FROM event_items WHERE id = ? AND event_id = ?').get(+eventItemId, e.id);
  if (!ei) return err('not_found', 'not on this take-list');
  const max = ei.qty_taken - ei.qty_sold_table - ei.qty_sold_close;
  const q = Math.max(0, Math.min(max, Math.floor(Number(qty) || 0)));
  db.prepare('UPDATE event_items SET qty_returned = ? WHERE id = ?').run(q, ei.id);
  return { ok: true, item: itemView(db, db.prepare('SELECT * FROM event_items WHERE id = ?').get(ei.id)) };
}

/**
 * allocateTakings — split what is left of the takings across the sold units nobody priced, by asking price.
 *
 * Pure. `units` is [{ key, askCents }] — one entry per UNIT. Known prices are already subtracted
 * (`knownCents`). A unit with no asking price is weighted at the average of the ones that have one, so a
 * single unpriced oddity is not handed nothing (or everything). If the takings do not cover the known
 * prices, nothing is invented: every unpriced unit stays null and `short` says so.
 */
export function allocateTakings({ takingsCents, knownCents = 0, units = [] }) {
  if (takingsCents == null) return { allocated: units.map(() => null), remainder: null, short: false };
  const remainder = takingsCents - knownCents;
  // Short when the takings do not cover what is already known — whether or not anything is left to
  // price — and when they cover it EXACTLY but cards still need a price: a zero share is not a price,
  // it is takings that were not all entered (one box filled in, the others left blank).
  if (remainder < 0 || (remainder === 0 && units.length)) return { allocated: units.map(() => null), remainder, short: true };
  if (!units.length) return { allocated: [], remainder, short: false };
  const asks = units.map((u) => (u.askCents > 0 ? u.askCents : null));
  const known = asks.filter((a) => a != null);
  const avg = known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : 1;
  const weights = asks.map((a) => (a == null ? avg : a));
  return { allocated: apportion(remainder, weights), remainder, short: false };
}

/** How many units of a row an in-person sale could still record: held, minus what a Run has promised. */
function recordableUnits(db, kind, itemId) {
  const row = db.prepare(`SELECT quantity, status FROM ${TABLE(kind)} WHERE id = ?`).get(+itemId);
  if (!row || row.status === 'sold') return 0;
  return Math.max(0, (Number(row.quantity) || 0) - (kind === 'sealed' ? reservedUnits(db, 'sealed', itemId) : 0));
}

function checkMoney({ takings = {}, prices = {} } = {}) {
  for (const k of ['cash', 'card', 'trade']) if (badCents(takings[k])) return err('bad_request', `takings ${k} must be an amount in cents, zero or more`);
  for (const [k, v] of Object.entries(prices || {})) if (badCents(v)) return err('bad_request', `the price for line ${k} must be an amount in cents, zero or more`);
  return null;
}

/** What a close-out WOULD record, given takings and entered prices. Writes nothing. */
export function closeOutPreview(db, eventId, { takings = {}, prices = {} } = {}) {
  const e = getEvent(db, eventId);
  if (!e) return err('not_found', 'no such event');
  const bad = checkMoney({ takings, prices });
  if (bad) return bad;
  const items = db.prepare('SELECT * FROM event_items WHERE event_id = ? ORDER BY id').all(e.id).map((ei) => itemView(db, ei));
  const takingsCents = ['cash', 'card', 'trade'].reduce((s, k) => (takings[k] == null || takings[k] === '' ? s : (s ?? 0) + cents(takings[k])), null);

  // Sold at the table, already recorded: priced ones are known money; unpriced ones share the remainder.
  const tableSales = db.prepare('SELECT id, kind, item_id, qty, unit_price_cents FROM in_person_sales WHERE event_id = ?').all(e.id);
  let known = 0;
  const units = [];
  for (const s of tableSales) {
    if (s.unit_price_cents != null) { known += s.unit_price_cents * s.qty; continue; }
    const ask = (db.prepare(`SELECT target_price_cents FROM ${TABLE(s.kind)} WHERE id = ?`).get(s.item_id) || {}).target_price_cents;
    for (let i = 0; i < s.qty; i++) units.push({ key: `sale:${s.id}`, askCents: ask || null });
  }
  // Missing at close-out: a price entered here is known money; otherwise it shares.
  const lines = [];
  for (const it of items) {
    if (it.missing <= 0) continue;
    const p = prices[it.id] ?? prices[String(it.id)];
    const priced = p != null && p !== '' ? cents(p) : null;
    // Units the shelf can no longer give up: the row sold (or shrank) somewhere else while it was away.
    // Each is a card sold twice — at the table and online — and is shown before anything is recorded.
    const conflict = Math.max(0, it.missing - recordableUnits(db, it.kind, it.item_id));
    lines.push({ event_item_id: it.id, sku: it.sku, name: it.name, kind: it.kind, item_id: it.item_id, units: it.missing, entered_cents: priced, ask_cents: it.ask_cents, conflict_units: conflict });
    if (priced != null) known += priced * it.missing;
    else for (let i = 0; i < it.missing; i++) units.push({ key: `line:${it.id}`, askCents: it.ask_cents || null });
  }
  const alloc = allocateTakings({ takingsCents, knownCents: known, units });
  const byKey = new Map();
  units.forEach((u, i) => { if (!byKey.has(u.key)) byKey.set(u.key, []); byKey.get(u.key).push(alloc.allocated[i]); });
  for (const l of lines) l.unit_cents = l.entered_cents != null ? Array(l.units).fill(l.entered_cents) : (byKey.get(`line:${l.event_item_id}`) || Array(l.units).fill(null));
  const tableFill = tableSales.filter((s) => s.unit_price_cents == null).map((s) => ({ sale_id: s.id, qty: s.qty, unit_cents: byKey.get(`sale:${s.id}`) || [] }));
  return {
    ok: true, takings_cents: takingsCents, known_cents: known, remainder_cents: alloc.remainder, short: alloc.short,
    unpriced_units: alloc.allocated.filter((x) => x == null).length,
    returned_units: items.reduce((s, i) => s + i.qty_returned, 0),
    sold_units: lines.reduce((s, l) => s + l.units, 0) + tableSales.reduce((s, x) => s + x.qty, 0),
    conflict_units: lines.reduce((s, l) => s + l.conflict_units, 0),
    lines, table_fill: tableFill,
  };
}

/**
 * closeOut — record it. Every unit that did not come back is SOLD (an in-person sale, tagged to the show,
 * through the same decrement an eBay order uses — so its hidden listings end, exactly like any sold card),
 * unpriced table sales get their share of the takings, and the event moves to 'closing'.
 */
export function closeOut(ctx, eventId, opts = {}) {
  return withEventLock(eventId, () => closeOutLocked(ctx, eventId, opts));
}

async function closeOutLocked(ctx, eventId, { takings = {}, prices = {}, actor = null } = {}) {
  const { db } = ctx;
  const e = getEvent(db, eventId);
  if (!e) return err('not_found', 'no such event');
  if (e.status !== 'offline') return err('wrong_status', `this event is ${e.status}`);
  const plan = closeOutPreview(db, eventId, { takings, prices });
  if (!plan.ok) return plan;
  const recorded = [], conflicts = [], jobIds = [];
  for (const l of plan.lines) {
    // Units of one line can differ by a cent after the split; record each price as its own sale row so the
    // recorded money sums to the takings exactly.
    const groups = new Map();
    for (const c of l.unit_cents) groups.set(c, (groups.get(c) || 0) + 1);
    for (const [unit, qty] of groups) {
      // As many as the shelf can still give up. The rest left the shelf TWICE — sold at the table and,
      // while the show was on, somewhere else (a hide that failed, a Run reserved during the show) — and
      // no sale row can be written for a unit the stock no longer holds. They are counted off the
      // take-list all the same, because they did not come home, and named loudly: an online buyer may be
      // waiting for a card that is gone. Left blocking instead, the event could never close, and "Back
      // online" would have put the remaining count on sale again.
      const can = Math.min(qty, recordableUnits(db, l.kind, l.item_id));
      if (can > 0) {
        const r = recordInPersonSale(db, { kind: l.kind, id: l.item_id, qty: can, unit_price_cents: unit },
          { eventId: e.id, phase: 'close', actor, note: 'did not come back from ' + e.name });
        if (r.ok) { recorded.push({ sku: l.sku, qty: can, unit_price_cents: unit, sale_id: r.sale_id }); jobIds.push(...r.jobs.map((j) => j.id)); }
        else conflicts.push({ event_item_id: l.event_item_id, sku: l.sku, name: l.name, qty: can, unit_price_cents: unit, code: r.code, error: r.error });
      }
      if (qty > can) conflicts.push({ event_item_id: l.event_item_id, sku: l.sku, name: l.name, qty: qty - can, unit_price_cents: unit, code: 'sold_twice',
        error: `${l.sku || 'this item'}: ${qty - can} unit(s) did not come back, but the shelf no longer holds them — it sold somewhere else while it was away` });
    }
  }
  // Conflicted units are counted off the take-list (they are not coming home), never as a sale.
  for (const c of conflicts) {
    db.prepare('UPDATE event_items SET qty_sold_close = qty_sold_close + ? WHERE id = ?').run(c.qty, c.event_item_id);
  }
  if (conflicts.length) {
    const msg = `Close-out of ${e.name}: ${conflicts.map((c) => `${c.qty} × ${c.sku}`).join(', ')} did not come back but had already left the shelf `
      + 'another way (sold online during the show?). Check for an online buyer waiting on a card that is gone.';
    console.error('[events] ' + msg);
    try { if (ctx.deps && ctx.deps.alert) await ctx.deps.alert(ctx.env, '⚠️ <b>Sold twice at a show</b>\n' + msg.replace(/[<>&]/g, '')); } catch { /* logged above */ }
  }
  // Table sales recorded without a price take their share, on the sale row and on the stock row.
  for (const t of plan.table_fill) {
    const vals = t.unit_cents.filter((x) => x != null);
    if (!vals.length) continue;
    const unit = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);   // ≤1c drift only on a qty>1 table row
    db.prepare('UPDATE in_person_sales SET unit_price_cents = ? WHERE id = ? AND unit_price_cents IS NULL').run(unit, t.sale_id);
    const s = db.prepare('SELECT kind, item_id FROM in_person_sales WHERE id = ?').get(t.sale_id);
    if (s) db.prepare(`UPDATE ${TABLE(s.kind)} SET sale_price_cents = COALESCE(sale_price_cents, ?), updated_at = datetime('now') WHERE id = ?`).run(unit, s.item_id);
  }
  db.prepare(`UPDATE events SET status = 'closing', closed_out_at = datetime('now'), updated_at = datetime('now'),
                takings_cash_cents = ?, takings_card_cents = ?, takings_trade_cents = ?, close_report = ? WHERE id = ?`)
    .run(cents(takings.cash), cents(takings.card), cents(takings.trade),
      JSON.stringify({ at: new Date().toISOString(), recorded, conflicts }), e.id);
  // The sold cards' hidden listings end now rather than on the next tick.
  const channels = jobIds.length ? await drainJobs(ctx, [...new Set(jobIds)], { budgetMs: 60_000 }) : [];
  return { ok: true, plan, recorded, conflicts, channels, event: eventDetail(db, e.id) };
}

/**
 * addAcquisition — tie a stock row bought or traded in at the show to the event, with what it cost, and
 * file the hand check: the card was in the operator's hand when they entered it (AGENTS.md §23).
 */
export function addAcquisition(db, eventId, { kind = 'inventory', item_id, qty = 1, how = 'bought', cost_cents = null, channel = 'shopify', actor = null } = {}) {
  const e = getEvent(db, eventId);
  if (!e) return err('not_found', 'no such event');
  if (!['offline', 'closing'].includes(e.status)) return err('wrong_status', `new stock is entered after the show starts — this event is ${e.status}`);
  const k = kind === 'sealed' ? 'sealed' : 'inventory';
  const row = db.prepare(`SELECT id, sku, quantity FROM ${TABLE(k)} WHERE id = ?`).get(+item_id);
  if (!row) return err('not_found', `no ${k} row ${item_id}`);
  if (!['bought', 'traded'].includes(how)) return err('bad_request', 'how must be bought or traded');
  if (badCents(cost_cents)) return err('bad_request', 'cost must be an amount in cents, zero or more');
  const ch = ['shopify', 'ebay', 'none'].includes(channel) ? channel : 'shopify';
  // One acquisition per stock row per show: a double tap, a retried request or a second tab must not
  // book the cost twice or file a second hand check.
  const existing = db.prepare('SELECT * FROM event_acquisitions WHERE event_id = ? AND kind = ? AND item_id = ?').get(e.id, k, row.id);
  if (existing) return { ok: true, already: true, acquisition: existing };
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO event_acquisitions (event_id, kind, item_id, sku, qty, how, cost_cents, channel, publish_state)
                          VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(e.id, k, row.id, row.sku || null, Math.max(1, Math.floor(Number(qty) || 1)), how, cents(cost_cents), ch, ch === 'none' ? 'skipped' : null);
    recordVerification(db, {
      kind: k, itemId: row.id, outcome: 'verified', units: Number(row.quantity) || 1, actor: clean(actor) || 'show intake',
      note: `entered in hand at ${e.name}`,
    });
    db.exec('COMMIT');
    return { ok: true, acquisition: db.prepare('SELECT * FROM event_acquisitions WHERE id = ?').get(Number(r.lastInsertRowid)) };
  } catch (x) {
    try { db.exec('ROLLBACK'); } catch { /* unwound */ }
    return err('failed', String(x?.message || x));
  }
}

export function markAcquisitionPublished(db, eventId, acqId, { ok, error = null, channel = null } = {}) {
  const a = db.prepare('SELECT * FROM event_acquisitions WHERE id = ? AND event_id = ?').get(+acqId, +eventId);
  if (!a) return err('not_found', 'no such acquisition');
  db.prepare('UPDATE event_acquisitions SET publish_state = ?, publish_error = ?, channel = COALESCE(?, channel) WHERE id = ?')
    .run(ok ? 'published' : 'failed', ok ? null : String(error || 'failed'), channel, a.id);
  return { ok: true };
}

// --- 5. back online --------------------------------------------------------------------------------

/**
 * backOnline — close the event (nothing is away any more) and restore every listing it hid, each to
 * min(what it offered before, what is held now). A listing that ended meanwhile is reported, never
 * recreated. New stock is published by the page through the publish routes, so every one of their
 * refusals applies; this only restores.
 */
export function backOnline(ctx, eventId, opts = {}) {
  return withEventLock(eventId, () => backOnlineLocked(ctx, eventId, opts));
}

async function backOnlineLocked(ctx, eventId, { budgetMs = 60_000 } = {}) {
  const { db } = ctx;
  const e = getEvent(db, eventId);
  if (!e) return err('not_found', 'no such event');
  if (!syncArmed(ctx.env)) return err('sync_off', 'nothing was put back online: ' + SYNC_OFF_MESSAGE);
  if (!['closing', 'closed'].includes(e.status)) {
    return err('wrong_status', e.status === 'offline' ? 'record the close-out first — what came back and what sold' : `this event is ${e.status}`);
  }
  // Closing the event is what stops its units counting as away. Every unit taken has to be accounted for
  // first — came back, or sold — or a unit nobody recorded would go back on sale online.
  const c = counts(db, e.id);
  if (c.missing > 0) return err('still_missing', `${c.missing} unit(s) taken to ${e.name} are neither scanned back nor recorded as sold`);
  if (e.status === 'closing') {
    db.prepare(`UPDATE events SET status = 'closed', restored_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(e.id);
  }
  let closeReport = null;
  try { closeReport = e.close_report ? JSON.parse(e.close_report) : null; } catch { /* none */ }
  const soldTwice = new Set(((closeReport && closeReport.conflicts) || []).map((x) => x.event_item_id));
  const twiceItems = new Set(db.prepare('SELECT kind, item_id, id FROM event_items WHERE event_id = ?').all(e.id)
    .filter((ei) => soldTwice.has(ei.id)).map((ei) => `${ei.kind}:${ei.item_id}`));
  const targets = db.prepare("SELECT * FROM event_targets WHERE event_id = ? AND state IN ('hidden','restoring')").all(e.id);
  const jobIds = [];
  const skipped = [];
  for (const t of targets) {
    const target = safeJson(t.target) || {};
    const itemId = t.item_id ?? (t.pool_sku ? (db.prepare('SELECT id FROM sealed_items WHERE pool_sku = ? ORDER BY id LIMIT 1').get(t.pool_sku) || {}).id : null);
    if (itemId == null) continue;
    // A card that sold twice at this show: the stock row cannot be trusted until a person has looked at it
    // (a Run reservation made during the show, say, leaves it holding a card that is gone), so it is not
    // put back on sale anywhere.
    if (twiceItems.has(`${t.kind}:${itemId}`)) {
      db.prepare("UPDATE event_targets SET state = 'attention', note = ? WHERE id = ?")
        .run('sold twice at this show — check the stock row before relisting', t.id);
      skipped.push({ target_key: t.target_key, why: 'sold_twice' });
      continue;
    }
    // Sold while it was away: nothing to put back, and nothing for anyone to relist.
    if (shelf(db, { kind: t.kind, item_id: itemId, pool_sku: t.pool_sku, target }).held <= 0) {
      db.prepare("UPDATE event_targets SET state = 'sold', note = 'sold while it was away' WHERE id = ?").run(t.id);
      skipped.push({ target_key: t.target_key, why: 'sold' });
      continue;
    }
    const q = enqueueChannelSync(db, {
      kind: t.kind, itemId, mode: 'restore', reason: 'back from ' + e.name,
      targets: [{ ...target, channel: t.channel }],
      extra: { event_id: e.id, pre_qty: t.pre_qty ?? 0 },
    });
    jobIds.push(...q.jobs.map((j) => j.id));
    db.prepare("UPDATE event_targets SET state = 'restoring' WHERE id = ?").run(t.id);
  }
  const results = jobIds.length ? await drainJobs(ctx, [...new Set(jobIds)], { budgetMs }) : [];
  return { ok: true, results, skipped, event: eventDetail(db, e.id) };
}

/** The open event a table sale should default to: the most recent offline one. */
export function openEvents(db) {
  migrateChannelSync(db);
  return db.prepare("SELECT id, name, venue, status, starts_on FROM events WHERE status IN ('planning','offline','closing') ORDER BY id DESC").all();
}

export { awayUnits, awayPoolUnits };
