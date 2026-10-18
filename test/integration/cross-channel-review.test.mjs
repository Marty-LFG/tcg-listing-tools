// The defects the 2026-10-18 review of cross-channel sales and the show flow found, one test each, so
// none of them can come back. Every one was reproduced against the code before it was fixed.
//
// eBay and Shopify are a fake WORLD passed in as deps (the seam lib/channel-sync.mjs defaultDeps exists
// for): it remembers every quantity and status it was told, and can be made to misbehave — END a listing
// at quantity 0, fail a read-back once — which is what most of these defects need.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { migrateChannelSync, enqueueChannelSync, scanMovements, awayUnits } from '../../lib/channel-presence.mjs';
import { defaultDeps, runJob, runChannelSyncTick, retryJob, syncDisabled, syncArmed, publishedComposed } from '../../lib/channel-sync.mjs';
import { publishSealedPool } from '../../lib/sealed-listing.mjs';
import { testEbayConfig } from '../helpers/ebay-config.mjs';
import {
  createEvent, addToTakeList, takeOffline, scanBack, closeOut, closeOutPreview, backOnline, addAcquisition,
  allocateTakings, getEvent, eventDetail,
} from '../../lib/events.mjs';
import { recordInPersonSale, previewInPerson } from '../../lib/in-person-sales.mjs';
import { decrementInventoryItem } from '../../lib/postsale.mjs';

const DIR = tmpDir('xc-review');
let db;

before(() => { db = openDbAt(path.join(DIR, 'tracker.db')); migrateChannelSync(db); });
after(() => { try { db.close(); } catch { /* closed */ } });
beforeEach(() => {
  db.exec(`DELETE FROM inventory_items; DELETE FROM ebay_seller_listings; DELETE FROM ebay_listings; DELETE FROM shopify_listings;
           DELETE FROM stock_movements; DELETE FROM sync_jobs; DELETE FROM in_person_sales; DELETE FROM event_targets;
           DELETE FROM event_items; DELETE FROM event_acquisitions; DELETE FROM events; DELETE FROM sealed_placements;
           DELETE FROM sealed_items; DELETE FROM sealed_pools; DELETE FROM run_reservations; DELETE FROM stock_verifications;`);
  // The ledger cursor at the current end, as the plugin pins it at boot.
  db.exec("DELETE FROM channel_sync_meta WHERE key = 'movement_cursor'");
  scanMovements(db);
});

// --- the world -------------------------------------------------------------------------------------

function makeWorld({ endOnZero = false, oos = true } = {}) {
  const w = { offers: {}, trading: {}, shop: {}, writes: [], alerts: [], endOnZero, oos };
  w.deps = {
    ...defaultDeps(),
    ebayConnected: () => true,
    shopifyConfigured: () => true,
    alert: async (_env, m) => { w.alerts.push(m); },
    getOutOfStockControl: async () => ({ ok: true, enabled: w.oos }),
    getOffer: async (_env, id) => {
      const o = w.offers[id];
      if (!o) return { ok: false, error: 'HTTP 404' };
      if (o.failReads > 0) { o.failReads--; return { ok: false, error: 'HTTP 500' }; }
      return { ok: true, listingStatus: o.status, availableQuantity: o.qty, price_value: '10.00' };
    },
    setOfferQuantity: async (_env, { offerId, quantity }) => {
      w.writes.push(['offer', offerId, quantity]);
      const o = w.offers[offerId];
      o.qty = quantity;
      o.status = quantity === 0 ? (w.endOnZero ? 'ENDED' : 'OUT_OF_STOCK') : 'ACTIVE';
      if (o.failReadsAfterWrite) { o.failReads = o.failReadsAfterWrite; o.failReadsAfterWrite = 0; }
      return { ok: true };
    },
    withdrawOffer: async (_env, id) => { w.writes.push(['withdraw', id]); w.offers[id].status = 'ENDED'; return { ok: true }; },
    getListingState: async (_env, id) => {
      const t = w.trading[id];
      return { ok: true, listing_status: t.status, listing_type: 'FixedPriceItem', available_qty: t.qty, quantity_total: t.qty, sold_qty: 0, has_variations: false };
    },
    tradingCall: async (_env, call, inner) => {
      if (call !== 'ReviseInventoryStatus') return { ok: false, errors: [{ shortMessage: 'unexpected ' + call }] };
      const id = inner.match(/<ItemID>([^<]+)/)[1];
      const q = +inner.match(/<Quantity>(\d+)/)[1];
      w.writes.push(['ris', id, q]);
      w.trading[id].qty = q;
      if (q === 0 && w.endOnZero) w.trading[id].status = 'Completed';
      return { ok: true };
    },
    endFixedPriceItem: async (_env, { itemId }) => { w.writes.push(['end', itemId]); w.trading[itemId].status = 'Completed'; return { ok: true }; },
    setAvailableQty: async (_env, a) => {
      const from = w.shop[a.inventoryItemGid] ?? 0;
      if (a.onWrite) a.onWrite();
      if (a.quantity === from) return { ok: true, action: 'noop', from, to: from, available: from };
      if (a.quantity > from && !a.allowRaise) return { ok: true, action: 'held', held: true, from, to: from, wanted: a.quantity, available: from };
      w.writes.push(['shopify', a.inventoryItemGid, a.quantity]);
      w.shop[a.inventoryItemGid] = a.quantity;
      return { ok: true, action: 'set', from, to: a.quantity, available: a.quantity };
    },
    // The plain-sale reduce path re-publishes at eBay's price; here it just sets the offer to the shelf.
    runPublish: async (_env, d, _cfg, _save, { itemId, compose }) => {
      const it = d.prepare('SELECT quantity, ebay_offer_id FROM inventory_items WHERE id = ?').get(itemId);
      w.writes.push(['publish', it.ebay_offer_id, it.quantity]);
      w.publishCompose = compose;
      w.offers[it.ebay_offer_id].qty = it.quantity;
      return { ok: true };
    },
    loadListingConfig: () => ({}),
    saveListingConfig: () => {},
  };
  w.ctx = () => ({ db, env: { CROSS_CHANNEL_SYNC: 'on' }, deps: w.deps });
  return w;
}

function card(sku, { qty = 1, ask = 2000 } = {}) {
  const id = Number(db.prepare(`INSERT INTO inventory_items (sku, game, name, set_name, number, condition, quantity, target_price_cents, status, created_at, updated_at)
                                VALUES (?, 'pokemon', 'Pikachu', 'Base Set', '58/102', 'Near Mint', ?, ?, 'listed', datetime('now'), datetime('now'))`)
    .run(sku, qty, ask).lastInsertRowid);
  db.prepare("INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason) VALUES ('inventory', ?, ?, ?, ?, 'opening')").run(id, sku, qty, qty);
  return id;
}
function toolListed(w, id, offer, qty = 1) {
  db.prepare("UPDATE inventory_items SET ebay_offer_id = ?, ebay_listing_id = ?, channel_status = 'active' WHERE id = ?").run(offer, 'L-' + offer, id);
  const sku = db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(id).sku;
  db.prepare("INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, available_qty, listing_status) VALUES (?, 'EBAY_AU', ?, ?, ?, ?, 'ACTIVE')")
    .run(sku, offer, 'L-' + offer, id, qty);
  w.offers[offer] = { qty, status: 'ACTIVE' };
}
function handMade(w, id, listingId, qty = 1) {
  const sku = db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(id).sku;
  db.prepare(`INSERT INTO ebay_seller_listings (listing_id, sku, title, quantity, available_qty, listing_type, state, created_via, item_id)
              VALUES (?, ?, 'card', ?, ?, 'FixedPriceItem', 'active', 'manual', ?)`).run(listingId, sku, qty, qty, id);
  w.trading[listingId] = { qty, status: 'Active' };
}
function shopListed(w, id, qty = 1) {
  const sku = db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(id).sku;
  const gid = 'gid://shopify/InventoryItem/' + id;
  db.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty)
              VALUES (?, 'live', 'inventory', ?, 'gid://shopify/Product/' || ?, ?, 'gid://shopify/Location/1', 'live', ?)`).run(sku, id, id, gid, qty);
  w.shop[gid] = qty;
  return gid;
}
function sealedRow(sku, units, pool = null) {
  const id = Number(db.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status, pool_sku, target_price_cents, created_at, updated_at)
                                VALUES (?, 'pokemon', 'Booster Box', 'booster_box', ?, 'in_stock', ?, 16500, datetime('now'), datetime('now'))`)
    .run(sku, units, pool).lastInsertRowid);
  db.prepare("INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?, 'Shelf', ?)").run(id, units);
  db.prepare("INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason) VALUES ('sealed', ?, ?, ?, ?, 'opening')").run(id, sku, units, units);
  return id;
}
const jobState = (id) => db.prepare('SELECT state FROM sync_jobs WHERE id = ?').get(id).state;
const targets = (eventId) => Object.fromEntries(db.prepare('SELECT target_key, state, pre_qty FROM event_targets WHERE event_id = ?').all(eventId)
  .map((t) => [t.target_key, { state: t.state, pre: t.pre_qty }]));

// --- the sync worker -------------------------------------------------------------------------------

describe('the sync worker', () => {
  it('a sale landing while a job runs is not lost: the follow-up brings the channel to the newer count', async () => {
    const w = makeWorld();
    const A = card('AAC-901', { qty: 3 });
    const gid = shopListed(w, A, 3);
    const q = enqueueChannelSync(db, { kind: 'inventory', itemId: A, reason: 'sale 1' });
    db.prepare('UPDATE inventory_items SET quantity = 2 WHERE id = ?').run(A);
    // The second sale lands in the middle of the first job's write.
    const real = w.deps.setAvailableQty;
    let once = true;
    w.deps.setAvailableQty = (env, a) => real(env, { ...a, onWrite: () => {
      if (!once) return; once = false;
      db.prepare('UPDATE inventory_items SET quantity = 1 WHERE id = ?').run(A);
      enqueueChannelSync(db, { kind: 'inventory', itemId: A, reason: 'sale 2' });
    } });
    const r = await runJob(w.ctx(), q.jobs[0].id);
    assert.equal(r.state, 'done');
    assert.equal(w.shop[gid], 2, 'the first job wrote the count it read');
    const follow = db.prepare("SELECT id FROM sync_jobs WHERE state = 'queued'").all();
    assert.equal(follow.length, 1, 'the sale that landed mid-run queued a follow-up');
    await runJob(w.ctx(), follow[0].id);
    assert.equal(w.shop[gid], 1, 'the follow-up brought Shopify to what is held now');
  });

  it("two instructions for one listing never run at once: a restore waits while that listing's sale job is running", async () => {
    const w = makeWorld();
    const A = card('AAC-902');
    toolListed(w, A, 'OF-902');
    const sale = enqueueChannelSync(db, { kind: 'inventory', itemId: A, reason: 'sale' }).jobs[0];
    const restore = enqueueChannelSync(db, { kind: 'inventory', itemId: A, mode: 'restore', reason: 'back', extra: { pre_qty: 1 } }).jobs[0];
    db.prepare("UPDATE sync_jobs SET state = 'running', lease_expires = datetime('now', '+5 minutes') WHERE id = ?").run(sale.id);
    const r = await runJob(w.ctx(), restore.id);
    assert.equal(r.skipped, 'not_claimable');
    assert.equal(r.pending, true);
    assert.equal(jobState(restore.id), 'queued', 'left for the worker, not run over the top of the sale');
  });

  it('the channel a sale happened on is not skipped while units are left — its count is healed', async () => {
    const w = makeWorld();
    const A = card('AAC-903', { qty: 3 });
    toolListed(w, A, 'OF-903', 3);
    const gid = shopListed(w, A, 3);
    w.offers['OF-903'].qty = 2;                         // eBay sells one; the order is not polled yet
    w.shop[gid] = 2;
    decrementInventoryItem(db, A, 1, 1000, 'shopify:1001');  // a Shopify sale is ingested first
    await runChannelSyncTick(w.ctx());
    decrementInventoryItem(db, A, 1, 1000, '12-34567-89012');  // then the eBay order
    await runChannelSyncTick(w.ctx());
    assert.equal(db.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(A).quantity, 1);
    assert.equal(w.offers['OF-903'].qty, 1, 'eBay brought down to the one left, not left offering two');
    assert.equal(w.shop[gid], 1);
  });

  it('a hide that eBay took but could not read back keeps the pre-show quantity, and the restore puts it back', async () => {
    const w = makeWorld();
    const A = card('AAC-904');
    toolListed(w, A, 'OF-904');
    const e = createEvent(db, { name: 'Show' }).event;
    db.prepare("UPDATE events SET status = 'offline' WHERE id = ?").run(e.id);
    db.prepare("INSERT INTO event_items (event_id, kind, item_id, sku, qty_taken) VALUES (?, 'inventory', ?, 'AAC-904', 1)").run(e.id, A);
    w.offers['OF-904'].failReadsAfterWrite = 1;
    const job = enqueueChannelSync(db, { kind: 'inventory', itemId: A, mode: 'away', extra: { event_id: e.id } }).jobs[0];
    const first = await runJob(w.ctx(), job.id);
    assert.equal(first.ok, false, 'the read-back failed');
    db.prepare("UPDATE sync_jobs SET run_after = datetime('now') WHERE id = ?").run(job.id);
    const second = await runJob(w.ctx(), job.id);
    assert.equal(second.action, 'noop', 'the retry reads the 0 the first attempt wrote');
    assert.equal(targets(e.id)['ebay:offer:OF-904'].pre, 1, 'the pre-show figure is the read taken before the write');
    db.prepare("UPDATE event_items SET qty_returned = 1").run();
    db.prepare("UPDATE events SET status = 'closing' WHERE id = ?").run(e.id);
    await backOnline(w.ctx(), e.id);
    assert.equal(w.offers['OF-904'].qty, 1, 'back to what it offered before the show');
  });

  it('Retry on a dead hide re-queues the same instruction — mode, listing and show — not a sale', async () => {
    const w = makeWorld();
    const A = card('AAC-905');
    toolListed(w, A, 'OF-905');
    const e = createEvent(db, { name: 'Show' }).event;
    db.prepare("UPDATE events SET status = 'offline' WHERE id = ?").run(e.id);
    db.prepare("INSERT INTO event_items (event_id, kind, item_id, sku, qty_taken) VALUES (?, 'inventory', ?, 'AAC-905', 1)").run(e.id, A);
    const job = enqueueChannelSync(db, { kind: 'inventory', itemId: A, mode: 'away', extra: { event_id: e.id } }).jobs[0];
    db.prepare("UPDATE sync_jobs SET state = 'dead', dedupe_key = NULL WHERE id = ?").run(job.id);
    const r = retryJob(db, job.id);
    assert.equal(r.ok, true);
    const p = JSON.parse(db.prepare('SELECT payload FROM sync_jobs WHERE id = ?').get(r.requeued[0]).payload);
    assert.equal(p.mode, 'away');
    assert.equal(p.event_id, e.id);
    assert.equal(p.target.offer_id, 'OF-905');
    await runJob(w.ctx(), r.requeued[0]);
    assert.equal(targets(e.id)['ebay:offer:OF-905'].state, 'hidden', "the show's record follows, so Back online restores it");
  });

  it('the switch is OPT-IN, read from the env the plugin is handed (.env): unset or anything else is off', () => {
    const was = process.env.CROSS_CHANNEL_SYNC;
    delete process.env.CROSS_CHANNEL_SYNC;
    try {
      assert.equal(syncDisabled({}), true, 'unset is OFF — a deploy arms nothing');
      assert.equal(syncDisabled({ CROSS_CHANNEL_SYNC: 'off' }), true);
      assert.equal(syncDisabled({ CROSS_CHANNEL_SYNC: 'maybe' }), true);
      for (const v of ['on', 'ON', 'true', '1', 'yes']) assert.equal(syncDisabled({ CROSS_CHANNEL_SYNC: v }), false, v);
      assert.equal(syncArmed({ CROSS_CHANNEL_SYNC: 'on' }), true);
    } finally { if (was != null) process.env.CROSS_CHANNEL_SYNC = was; }
  });

  it('DISARMED: a sale records locally and queues its jobs, and nothing at all is written to eBay or Shopify', async () => {
    const was = process.env.CROSS_CHANNEL_SYNC;
    delete process.env.CROSS_CHANNEL_SYNC;
    try {
      const w = makeWorld();
      const A = card('AAC-906');
      toolListed(w, A, 'OF-906');
      const gid = shopListed(w, A, 1);
      const off = { db, env: {}, deps: w.deps };
      const sale = recordInPersonSale(db, { sku: 'AAC-906', unit_price_cents: 1500 }, {});
      assert.equal(sale.ok, true);
      assert.equal(sale.jobs.length, 2, 'both channels queued');
      assert.equal(db.prepare("SELECT status FROM inventory_items WHERE id = ?").get(A).status, 'sold', 'local stock moved');
      const results = await Promise.all(sale.jobs.map((j) => runJob(off, j.id)));
      assert.ok(results.every((r) => r.pending && r.sync_off), JSON.stringify(results));
      assert.ok(sale.jobs.every((j) => jobState(j.id) === 'queued'), 'queued, not done');
      const tick = await runChannelSyncTick(off);
      assert.equal(tick.disabled, true);
      assert.deepEqual(w.writes, [], 'not one write to either channel');
      assert.equal(w.offers['OF-906'].status, 'ACTIVE');
      assert.equal(w.shop[gid], 1);
      // A show cannot be taken offline (or brought back) while off — it would read as hidden while live.
      const e = createEvent(db, { name: 'Show' }).event;
      const B = card('AAC-907'); toolListed(w, B, 'OF-907'); addToTakeList(db, e.id, { sku: 'AAC-907' });
      const t = await takeOffline(off, e.id);
      assert.equal(t.code, 'sync_off');
      assert.equal(getEvent(db, e.id).status, 'planning');
    } finally { if (was != null) process.env.CROSS_CHANNEL_SYNC = was; }
  });
});

// --- taking a show offline --------------------------------------------------------------------------

describe('taking a show offline', () => {
  it('each eBay write path has its own canary: a hand-made canary does not let every tool listing through', async () => {
    const w = makeWorld();
    const e = createEvent(db, { name: 'Show' }).event;
    const H = card('AAC-910'); handMade(w, H, '9910'); addToTakeList(db, e.id, { sku: 'AAC-910' });
    for (let i = 1; i <= 4; i++) {
      const id = card('AAC-91' + i); toolListed(w, id, 'OF-91' + i); addToTakeList(db, e.id, { sku: 'AAC-91' + i });
    }
    // Hand-made listings hide fine; the tool path (bulkUpdatePriceQuantity) ENDS at 0.
    const realSet = w.deps.setOfferQuantity;
    w.deps.setOfferQuantity = async (env, a) => { const r = await realSet(env, a); if (a.quantity === 0) w.offers[a.offerId].status = 'ENDED'; return r; };
    const r = await takeOffline(w.ctx(), e.id);
    assert.equal(r.ok, false);
    assert.equal(r.report.canary_failed, true);
    assert.equal(r.report.canary.api, 'inventory');
    assert.equal(w.trading['9910'].qty, 0, 'the hand-made listing was hidden');
    const ended = Object.values(w.offers).filter((o) => o.status === 'ENDED').length;
    assert.equal(ended, 1, 'only the tool path canary ended — the other three were held back');
    assert.equal(r.report.held_back, 3);
  });

  it('after a canary eBay ENDED, going again needs a confirm, and an already-ended listing is no proof', async () => {
    const w = makeWorld({ endOnZero: true });
    const e = createEvent(db, { name: 'Show' }).event;
    for (let i = 1; i <= 3; i++) { const id = card('AAC-92' + i); toolListed(w, id, 'OF-92' + i); addToTakeList(db, e.id, { sku: 'AAC-92' + i }); }
    const first = await takeOffline(w.ctx(), e.id);
    assert.equal(first.report.canary_ended, true);
    const again = await takeOffline(w.ctx(), e.id);
    assert.equal(again.code, 'confirm_retry', 'not sent without the owner saying the setting was looked at');
    const writesBefore = w.writes.length;
    const confirmed = await takeOffline(w.ctx(), e.id, { confirmed: true });
    assert.equal(confirmed.ok, false, 'eBay still ends: the next canary fails too');
    const ended = Object.values(w.offers).filter((o) => o.status === 'ENDED').length;
    assert.equal(ended, 2, 'the ended canary read back as ended was NOT taken as proof — exactly one more listing was sent');
    assert.equal(w.writes.length - writesBefore, 1);
  });

  it('two take-offline calls at once: the second is refused, not a second canary', async () => {
    const w = makeWorld();
    const e = createEvent(db, { name: 'Show' }).event;
    for (let i = 1; i <= 2; i++) { const id = card('AAC-93' + i); toolListed(w, id, 'OF-93' + i); addToTakeList(db, e.id, { sku: 'AAC-93' + i }); }
    const [a, b] = await Promise.all([takeOffline(w.ctx(), e.id), takeOffline(w.ctx(), e.id)]);
    assert.equal(a.ok, true);
    assert.equal(b.code, 'busy');
  });

  it('a card added after a failed canary is held back, never hidden blind', async () => {
    const w = makeWorld({ endOnZero: true });
    const e = createEvent(db, { name: 'Show' }).event;
    for (let i = 1; i <= 2; i++) { const id = card('AAC-94' + i); toolListed(w, id, 'OF-94' + i); addToTakeList(db, e.id, { sku: 'AAC-94' + i }); }
    await takeOffline(w.ctx(), e.id);
    const late = card('AAC-949'); toolListed(w, late, 'OF-949');
    const r = addToTakeList(db, e.id, { sku: 'AAC-949' });
    assert.equal(r.needs_offline, true);
    const off = await takeOffline(w.ctx(), e.id);   // what the /items route does next
    assert.equal(off.code, 'confirm_retry');
    assert.equal(w.offers['OF-949'].status, 'ACTIVE', 'untouched until the owner confirms');
  });

  it('a card added to an offline show on a proved path is hidden straight away', async () => {
    const w = makeWorld();
    const e = createEvent(db, { name: 'Show' }).event;
    const A = card('AAC-951'); toolListed(w, A, 'OF-951'); addToTakeList(db, e.id, { sku: 'AAC-951' });
    assert.equal((await takeOffline(w.ctx(), e.id)).ok, true);
    const late = card('AAC-952'); toolListed(w, late, 'OF-952');
    assert.equal(addToTakeList(db, e.id, { sku: 'AAC-952' }).needs_offline, true);
    const off = await takeOffline(w.ctx(), e.id);
    assert.equal(off.ok, true);
    assert.equal(w.offers['OF-952'].qty, 0);
    assert.equal(w.offers['OF-952'].status, 'OUT_OF_STOCK');
    assert.equal(w.writes.filter((x) => x[1] === 'OF-951').length, 1, 'the card already hidden was not sent again');
  });
});

// --- close-out and back online ----------------------------------------------------------------------

describe('close-out and back online', () => {
  it('a card that sold twice (a Run reserved it during the show) is named, the show closes, and it is NOT put back on sale', async () => {
    const w = makeWorld();
    const A = card('AAC-960'); toolListed(w, A, 'OF-960');
    const e = createEvent(db, { name: 'Show' }).event;
    addToTakeList(db, e.id, { sku: 'AAC-960' });
    await takeOffline(w.ctx(), e.id);
    db.prepare("INSERT INTO run_reservations (kind, item_id, qty, state) VALUES ('inventory', ?, 1, 'active')").run(A);
    const co = await closeOut(w.ctx(), e.id, { takings: { cash: 2000 } });
    assert.equal(co.ok, true);
    assert.equal(co.conflicts.length, 1);
    assert.ok(w.alerts.some((m) => /Sold twice/.test(m)), 'the owner is told');
    assert.equal(eventDetail(db, e.id).counts.missing, 0, 'counted off the take-list, so the show can close');
    db.exec('DELETE FROM run_reservations');
    const bo = await backOnline(w.ctx(), e.id);
    assert.equal(bo.ok, true);
    assert.equal(w.offers['OF-960'].qty, 0, 'not raised back');
    assert.equal(targets(e.id)['ebay:offer:OF-960'].state, 'attention');
  });

  it('a price that is not a number refuses the close-out before anything is recorded', async () => {
    const w = makeWorld();
    const A = card('AAC-961');
    const e = createEvent(db, { name: 'Show' }).event;
    addToTakeList(db, e.id, { sku: 'AAC-961' });
    await takeOffline(w.ctx(), e.id);
    const ei = db.prepare('SELECT id FROM event_items WHERE item_id = ?').get(A).id;
    const co = await closeOut(w.ctx(), e.id, { takings: { cash: 5000 }, prices: { [ei]: 'abc' } });
    assert.equal(co.code, 'bad_request');
    assert.equal(getEvent(db, e.id).status, 'offline');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM in_person_sales').get().n, 0);
  });

  it('back online refuses while units are neither back nor sold', async () => {
    const w = makeWorld();
    card('AAC-962');
    const e = createEvent(db, { name: 'Show' }).event;
    addToTakeList(db, e.id, { sku: 'AAC-962' });
    await takeOffline(w.ctx(), e.id);
    db.prepare("UPDATE events SET status = 'closing' WHERE id = ?").run(e.id);   // as an old close-out could leave it
    const bo = await backOnline(w.ctx(), e.id);
    assert.equal(bo.code, 'still_missing');
    assert.equal(getEvent(db, e.id).status, 'closing');
  });

  it('a sale tagged to a show must be one that is OFFLINE', async () => {
    const w = makeWorld();
    const S = sealedRow('BK-SLD-970', 6);
    const e = createEvent(db, { name: 'Show' }).event;
    addToTakeList(db, e.id, { sku: 'BK-SLD-970', qty: 3 });
    const planning = recordInPersonSale(db, { sku: 'BK-SLD-970', qty: 1 }, { eventId: e.id });
    assert.equal(planning.code, 'wrong_event', 'a planning show has nothing out yet');
    await takeOffline(w.ctx(), e.id);
    scanBack(db, e.id, { sku: 'BK-SLD-970', qty: 2 });
    await closeOut(w.ctx(), e.id, {});
    const held = db.prepare('SELECT quantity FROM sealed_items WHERE id = ?').get(S).quantity;
    const late = recordInPersonSale(db, { sku: 'BK-SLD-970', qty: 1 }, { eventId: e.id });
    assert.equal(late.code, 'wrong_event', 'the close-out already counted it');
    assert.equal(db.prepare('SELECT quantity FROM sealed_items WHERE id = ?').get(S).quantity, held, 'nothing decremented twice');
  });

  it('a pool label sold at the table comes off the box the show took, not the home row', async () => {
    const w = makeWorld();
    db.prepare("INSERT INTO sealed_pools (pool_sku, product_type, name) VALUES ('POOL-971', 'booster_box', 'Booster Box')").run();
    const home = sealedRow('BK-SLD-971A', 2, 'POOL-971');
    const away = sealedRow('BK-SLD-971B', 1, 'POOL-971');
    const e = createEvent(db, { name: 'Show' }).event;
    addToTakeList(db, e.id, { sku: 'BK-SLD-971B' });
    await takeOffline(w.ctx(), e.id);
    const s = recordInPersonSale(db, { sku: 'POOL-971', qty: 1 }, {});
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.item.id, away, 'the show box');
    assert.equal(db.prepare('SELECT quantity FROM sealed_items WHERE id = ?').get(home).quantity, 2);
    assert.equal(awayUnits(db, 'sealed', away), 0, 'counted against the show, so close-out will not record it again');
  });

  it('a quantity of 0 is refused, never read as one', () => {
    card('AAC-972', { qty: 2 });
    const r = recordInPersonSale(db, { sku: 'AAC-972', qty: 0 }, {});
    assert.equal(r.code, 'bad_qty');
    assert.equal(previewInPerson(db, [{ sku: 'AAC-972', qty: 0 }])[0].code, 'bad_qty');
    assert.equal(db.prepare("SELECT quantity FROM inventory_items WHERE sku = 'AAC-972'").get().quantity, 2);
  });

  it('a double-tapped acquisition books the cost once', async () => {
    const A = card('AAC-973');
    const e = createEvent(db, { name: 'Show' }).event;
    db.prepare("UPDATE events SET status = 'offline' WHERE id = ?").run(e.id);
    const a = addAcquisition(db, e.id, { item_id: A, cost_cents: 500 });
    const b = addAcquisition(db, e.id, { item_id: A, cost_cents: 500 });
    assert.equal(a.ok, true);
    assert.equal(b.already, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM event_acquisitions').get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_verifications WHERE outcome = 'verified'").get().n, 1);
  });

  it('the preview names a card that sold twice before anything is recorded', async () => {
    const w = makeWorld();
    const A = card('AAC-974', { qty: 2 });
    const e = createEvent(db, { name: 'Show' }).event;
    addToTakeList(db, e.id, { sku: 'AAC-974', qty: 2 });
    await takeOffline(w.ctx(), e.id);
    decrementInventoryItem(db, A, 1, 1000, '12-1-1');   // one sold online while both were at the show
    const p = closeOutPreview(db, e.id, {});
    assert.equal(p.conflict_units, 1);
  });
});

describe('allocateTakings', () => {
  it('a zero remainder with cards still unpriced is short, not a zero price', () => {
    const z = allocateTakings({ takingsCents: 0, knownCents: 0, units: [{ askCents: 500 }, { askCents: 100 }] });
    assert.deepEqual(z.allocated, [null, null]);
    assert.equal(z.short, true);
  });
  it('takings below the known prices are short even when every card is priced', () => {
    assert.equal(allocateTakings({ takingsCents: 1000, knownCents: 3000, units: [] }).short, true);
    assert.equal(allocateTakings({ takingsCents: 3000, knownCents: 3000, units: [] }).short, false);
  });
});

describe('the should-fixes', () => {
  it('the same sale sent twice (one idempotency key) is written once', () => {
    const S = sealedRow('BK-SLD-980', 4);
    const a = recordInPersonSale(db, { sku: 'BK-SLD-980', qty: 1, client_key: 'k-980' }, {});
    const b = recordInPersonSale(db, { sku: 'BK-SLD-980', qty: 1, client_key: 'k-980' }, {});
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.already, true);
    assert.equal(b.sale_id, a.sale_id);
    assert.deepEqual(b.jobs, []);
    assert.equal(db.prepare('SELECT quantity FROM sealed_items WHERE id = ?').get(S).quantity, 3, 'one box off, not two');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM in_person_sales').get().n, 1);
    const c = recordInPersonSale(db, { sku: 'BK-SLD-980', qty: 1, client_key: 'k-981' }, {});
    assert.equal(c.already, undefined, 'a different key is a different sale');
    assert.equal(db.prepare('SELECT quantity FROM sealed_items WHERE id = ?').get(S).quantity, 2);
  });

  it("a sale-driven revise keeps the listing's branded pictures", async () => {
    const w = makeWorld();
    const A = card('AAC-981', { qty: 3 });
    toolListed(w, A, 'OF-981', 3);
    assert.equal(publishedComposed(db, A), null, 'no publish on record: defer to the config default');
    db.prepare("INSERT INTO listing_images (item_id, kind, source_url, eps_url, compose_hash) VALUES (?, 'card', 'https://img/x.png', 'https://i.ebayimg.com/branded.jpg', 'abc123')").run(A);
    db.prepare("INSERT INTO listing_pushes (item_id, sku, action, status, request) VALUES (?, 'AAC-981', 'create', 'ok', ?)")
      .run(A, JSON.stringify({ imageUrls: ['https://i.ebayimg.com/branded.jpg'] }));
    assert.equal(publishedComposed(db, A), true);
    decrementInventoryItem(db, A, 1, 1000, 'shopify:7001');   // sold on Shopify: eBay comes down to 2
    await runChannelSyncTick(w.ctx());
    assert.equal(w.offers['OF-981'].qty, 2);
    assert.equal(w.publishCompose, true, 'revised WITH rails, as it was published');
    db.prepare("INSERT INTO listing_pushes (item_id, sku, action, status, request) VALUES (?, 'AAC-981', 'revise', 'ok', ?)")
      .run(A, JSON.stringify({ imageUrls: ['https://i.ebayimg.com/plain.jpg'] }));
    assert.equal(publishedComposed(db, A), false, 'the latest successful publish decides');
  });

  it('a pool already on eBay is revised even though the mirror reads it live on Shopify (a pre-fix draft); a new one is refused', async () => {
    db.prepare("INSERT INTO sealed_pools (pool_sku, product_type, name, ebay_offer_id, ebay_listing_id, channel_status) VALUES ('POOL-982', 'booster_box', 'Booster Box', 'OF-982', 'L-982', 'active')").run();
    sealedRow('BK-SLD-982', 1, 'POOL-982');
    db.prepare("INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty) VALUES ('POOL-982', 'live', 'sealed', NULL, 'gid://shopify/Product/982', 'gid://shopify/InventoryItem/982', 'gid://shopify/Location/1', 'live', 1)").run();
    const cfg = testEbayConfig({ genericImage: { enabled: false } });
    const rev = await publishSealedPool({}, db, cfg, { poolSku: 'POOL-982', dryRun: true, imageUrls: ['https://img/box.jpg'] });
    assert.notEqual(rev.code, 'live_on_shopify', JSON.stringify(rev));

    db.prepare("INSERT INTO sealed_pools (pool_sku, product_type, name) VALUES ('POOL-983', 'booster_box', 'Booster Box')").run();
    sealedRow('BK-SLD-983', 1, 'POOL-983');
    db.prepare("INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty) VALUES ('POOL-983', 'live', 'sealed', NULL, 'gid://shopify/Product/983', 'gid://shopify/InventoryItem/983', 'gid://shopify/Location/1', 'live', 1)").run();
    const fresh = await publishSealedPool({}, db, cfg, { poolSku: 'POOL-983', dryRun: true, imageUrls: ['https://img/box.jpg'] });
    assert.equal(fresh.code, 'live_on_shopify', 'putting a pool ON eBay while it is live on Shopify is still refused');
  });
});
