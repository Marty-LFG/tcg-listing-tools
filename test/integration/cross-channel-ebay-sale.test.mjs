// test/integration/cross-channel-ebay-sale.test.mjs — an eBay sale takes the card off Shopify, through
// the unmodified eBay decrement and the sync worker's ledger scan; history is never replayed onto live
// listings; and pre-existing drift is REPORTED, then fixed only for rows named by hand.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { applyStockDecrements } from '../../lib/postsale.mjs';
import { migrateChannelSync, scanMovements, enqueueChannelSync } from '../../lib/channel-presence.mjs';
import { defaultDeps, runChannelSyncTick, driftReport, applyDrift, drainJobs } from '../../lib/channel-sync.mjs';
import { installEbayStub, shopifyStub, EBAY_ENV, SHOPIFY_ENV, LOC, ARMED } from '../helpers/channel-stubs.mjs';

const ENV = { ...EBAY_ENV, ...SHOPIFY_ENV, ...ARMED };
const DIR = tmpDir('tcg-ebaysale-');
let tdb, pdb, shop, ebay;
const ctx = () => ({ db: tdb, env: ENV, deps: { ...defaultDeps(), fetchImpl: shop.fn, alert: async () => {} } });

function seed(sku, { shopifyState = 'unpublished', available = 1, qty = 1 } = {}) {
  const id = Number(tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, ebay_listing_id, created_at, updated_at)
                                 VALUES (?, 'pokemon', 'Card', ?, 'listed', ?, datetime('now'), datetime('now'))`).run(sku, qty, 'E' + sku).lastInsertRowid);
  tdb.prepare("INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason) VALUES ('inventory', ?, ?, ?, ?, 'opening')").run(id, sku, qty, qty);
  tdb.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty)
               VALUES (?, 'live', 'inventory', ?, 'gid://shopify/Product/1', ?, ?, ?, ?)`).run(sku, id, 'gid://shopify/InventoryItem/' + id, LOC, shopifyState, available);
  return id;
}
function ebayOrder(orderId, sku, qty = 1) {
  const b = Number(pdb.prepare("INSERT OR IGNORE INTO buyers (ebay_username) VALUES ('buyer-x')").run().lastInsertRowid)
    || pdb.prepare("SELECT id FROM buyers WHERE ebay_username = 'buyer-x'").get().id;
  pdb.prepare("INSERT INTO orders (order_id, buyer_id, order_status, paid_time) VALUES (?, ?, 'Completed', '2026-10-18T00:00:00Z')").run(orderId, b);
  pdb.prepare('INSERT INTO order_line_items (order_id, ebay_item_id, sku, quantity, unit_price_cents) VALUES (?, ?, ?, ?, 999)').run(orderId, 'E' + sku, sku, qty);
}

before(() => {
  tdb = openDbAt(path.join(DIR, 'tracker.db'));
  pdb = openPostsaleDbAt(path.join(DIR, 'postsale.db'));
  migrateChannelSync(tdb);
});
after(() => { try { tdb.close(); pdb.close(); } catch {} });
beforeEach(() => {
  tdb.exec('DELETE FROM inventory_items; DELETE FROM shopify_listings; DELETE FROM stock_movements; DELETE FROM sync_jobs; DELETE FROM channel_sync_meta;');
  pdb.exec('DELETE FROM order_line_items; DELETE FROM orders; DELETE FROM buyers;');
  ebay = installEbayStub({});
});

describe('an eBay sale → Shopify', () => {
  it('brings a Shopify DRAFT\'s quantity to 0 so a later "set active" cannot sell it (K2), and leaves eBay alone', async () => {
    const id = seed('AAC-200');
    scanMovements(tdb);
    ebayOrder('12-3456-7890', 'AAC-200');
    const r = applyStockDecrements(pdb, tdb);
    assert.equal(r.applied, 1);
    shop = shopifyStub({ levels: { ['gid://shopify/InventoryItem/' + id]: 1 } });
    try {
      const tick = await runChannelSyncTick(ctx());
      assert.equal(tick.done, 1, JSON.stringify(tick.results));
      assert.equal(shop.state.levels['gid://shopify/InventoryItem/' + id], 0);
      assert.equal(ebay.calls.length, 0, 'eBay already ended its own listing; it is not told about its own sale');
      assert.equal(tdb.prepare("SELECT available_qty FROM shopify_listings WHERE store = 'live' AND sku = 'AAC-200'").get().available_qty, 0);
    } finally { ebay.restore(); }
  });

  it('a partial eBay sale lowers Shopify to the remainder, never to zero', async () => {
    const id = seed('AAC-201', { shopifyState: 'live', available: 3, qty: 3 });
    scanMovements(tdb);
    ebayOrder('12-3456-7891', 'AAC-201', 1);
    applyStockDecrements(pdb, tdb);
    shop = shopifyStub({ levels: { ['gid://shopify/InventoryItem/' + id]: 3 } });
    try {
      await runChannelSyncTick(ctx());
      assert.equal(shop.state.levels['gid://shopify/InventoryItem/' + id], 2);
    } finally { ebay.restore(); }
  });

  it('never RAISES: Shopify already below the shelf count is left exactly where it is', async () => {
    const id = seed('AAC-202', { shopifyState: 'live', available: 3, qty: 3 });
    scanMovements(tdb);
    ebayOrder('12-3456-7892', 'AAC-202', 1);
    applyStockDecrements(pdb, tdb);
    shop = shopifyStub({ levels: { ['gid://shopify/InventoryItem/' + id]: 0 } });   // it sold out there too
    try {
      const tick = await runChannelSyncTick(ctx());
      assert.equal(tick.done, 1);
      assert.deepEqual(shop.ops(), ['readLevel'], 'read, saw 0 against a shelf of 2, wrote nothing');
      assert.equal(shop.state.levels['gid://shopify/InventoryItem/' + id], 0);
    } finally { ebay.restore(); }
  });
});

describe('history and drift', () => {
  it('the first-boot cursor does NOT replay a sale recorded before it existed', async () => {
    seed('AAC-210');
    ebayOrder('12-3456-7893', 'AAC-210');
    applyStockDecrements(pdb, tdb);     // a sale BEFORE the worker ever ran
    const init = scanMovements(tdb);
    assert.equal(init.initialised, true);
    shop = shopifyStub({});
    try {
      const tick = await runChannelSyncTick(ctx());
      assert.equal(tick.ran, 0, 'history is never pushed onto live listings by a deploy');
      assert.equal(shop.calls.length, 0);
    } finally { ebay.restore(); }
  });

  it('reports that pre-existing drift, and fixes only the rows named', async () => {
    const a = seed('AAC-211');
    const b = seed('AAC-212');
    tdb.prepare("UPDATE inventory_items SET status = 'sold', quantity = 0 WHERE id IN (?, ?)").run(a, b);
    scanMovements(tdb);
    const rep = driftReport(tdb);
    assert.deepEqual(rep.rows.filter((r) => r.channel === 'shopify').map((r) => r.sku).sort(), ['AAC-211', 'AAC-212']);

    shop = shopifyStub({ levels: { ['gid://shopify/InventoryItem/' + a]: 1, ['gid://shopify/InventoryItem/' + b]: 1 } });
    try {
      const q = applyDrift(tdb, { items: [{ kind: 'inventory', item_id: a }] });
      assert.equal(q.queued.length, 1);
      const out = await drainJobs(ctx(), q.queued);
      assert.equal(out[0].ok, true);
      assert.equal(shop.state.levels['gid://shopify/InventoryItem/' + a], 0);
      assert.equal(shop.state.levels['gid://shopify/InventoryItem/' + b], 1, 'the row nobody named is left for a person to look at');
    } finally { ebay.restore(); }
  });

  it('collapses repeat enqueues for one listing into one waiting job', () => {
    const id = seed('AAC-213', { shopifyState: 'live' });
    const one = enqueueChannelSync(tdb, { kind: 'inventory', itemId: id, reason: 'first' });
    const two = enqueueChannelSync(tdb, { kind: 'inventory', itemId: id, reason: 'second' });
    assert.equal(one.jobs[0].id, two.jobs[0].id);
    assert.equal(tdb.prepare("SELECT COUNT(*) n FROM sync_jobs WHERE state = 'queued'").get().n, 1);
    const p = JSON.parse(tdb.prepare('SELECT payload FROM sync_jobs').get().payload);
    assert.deepEqual(p.reasons, ['first', 'second']);
    ebay.restore();
  });

  it('CROSS_CHANNEL_SYNC=off sends NOTHING, from any path — the job waits, queued', async () => {
    const id = seed('AAC-215', { shopifyState: 'live' });
    const q = enqueueChannelSync(tdb, { kind: 'inventory', itemId: id, reason: 'test' });
    shop = shopifyStub({ levels: { ['gid://shopify/InventoryItem/' + id]: 1 } });
    try {
      // Switched off the way the owner would: in the env the plugin is handed (.env).
      const out = await drainJobs({ ...ctx(), env: { ...ENV, CROSS_CHANNEL_SYNC: 'off' } }, q.jobs.map((j) => j.id));
      assert.equal(out[0].pending, true);
      assert.equal(out[0].sync_off, true);
      assert.match(out[0].error, /sync is OFF/);
      assert.equal(shop.calls.length, 0);
      assert.equal(tdb.prepare('SELECT state FROM sync_jobs WHERE id = ?').get(q.jobs[0].id).state, 'queued');
    } finally { ebay.restore(); }
  });

  it('a channel that is not configured leaves the job QUEUED as blocked, without spending an attempt', async () => {
    const id = seed('AAC-214', { shopifyState: 'live' });
    const q = enqueueChannelSync(tdb, { kind: 'inventory', itemId: id, reason: 'test' });
    shop = shopifyStub({});
    try {
      const out = await drainJobs({ db: tdb, env: { ...EBAY_ENV, ...ARMED }, deps: { ...defaultDeps(), fetchImpl: shop.fn } }, q.jobs.map((j) => j.id));
      assert.equal(out[0].state, 'blocked');
      const job = tdb.prepare('SELECT state, attempts FROM sync_jobs WHERE id = ?').get(q.jobs[0].id);
      assert.deepEqual({ ...job }, { state: 'queued', attempts: 0 });
      assert.equal(shop.calls.length, 0);
    } finally { ebay.restore(); }
  });
});
