// test/integration/cross-channel-shopify-sale.test.mjs — a Shopify sale takes the card off the shelf
// and off eBay (audit K1), end to end across a temp tracker DB, a temp postsale DB, a stubbed Shopify
// order read and a stubbed eBay.
//
// The load-bearing claims:
//   · the order lands in the EXISTING orders / order_line_items tables, namespaced, channel='shopify',
//     and filed shipped_status='external' so no eBay fulfilment path can see it
//   · the stock comes off through applyStockDecrements UNCHANGED (its own SKU rung matches the label)
//   · the ledger scan then takes the card off eBay — and does NOT tell Shopify about its own sale
//   · a cancellation puts the card back on the shelf and relists NOTHING anywhere
//   · a sealed POOL line is split across the pool's rows so the existing match works
//   · a line for a card already sold here raises a double-sale alert instead of a quiet stamp
//   · a dev-store delivery and a test order never move stock
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { migrateChannelSync, scanMovements } from '../../lib/channel-presence.mjs';
import { defaultDeps, runChannelSyncTick } from '../../lib/channel-sync.mjs';
import {
  recordStockDelivery, processStockEvents, pollShopifyOrders, mapShopifyOrder, ingestOrderNode, CURSOR_KEY, EPOCH_KEY,
  stockConsumerRecord,
} from '../../lib/shopify-stock-orders.mjs';
import { getMeta, setMeta } from '../../lib/postsale-db.mjs';
import { dispatchOrder, sweepOpenOrders } from '../../lib/postsale.mjs';
import { installEbayStub, shopifyStub, shopifyOrder, resp, EBAY_ENV, SHOPIFY_ENV, LOC, ARMED } from '../helpers/channel-stubs.mjs';

const ENV = { ...EBAY_ENV, ...SHOPIFY_ENV, ...ARMED };
const DIR = tmpDir('tcg-shopsale-');
let tdb, pdb, ebay, shop, alerts;

const syncCtx = () => ({ db: tdb, env: ENV, deps: { ...defaultDeps(), fetchImpl: shop.fn, alert: async (_e, t) => { alerts.push(t); } } });
const shopCtx = () => ({ pdb, tdb, fetchImpl: shop.fn, alert: (m) => alerts.push(m) });

function seedListedCard(sku, { offer = 'OF-' + sku, qty = 1 } = {}) {
  const id = Number(tdb.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, ebay_offer_id, ebay_listing_id, channel_status, created_at, updated_at)
                                 VALUES (?, 'pokemon', 'Card', ?, 'listed', ?, ?, 'active', datetime('now'), datetime('now'))`).run(sku, qty, offer, '22' + sku.replace(/\D/g, '')).lastInsertRowid);
  tdb.prepare(`INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason) VALUES ('inventory', ?, ?, ?, ?, 'opening')`).run(id, sku, qty, qty);
  tdb.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, available_qty, listing_status) VALUES (?, 'EBAY_AU', ?, ?, ?, ?, 'ACTIVE')`)
    .run(sku, offer, '22' + sku.replace(/\D/g, ''), id, qty);
  tdb.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty)
               VALUES (?, 'live', 'inventory', ?, 'gid://shopify/Product/9', ?, ?, 'live', ?)`).run(sku, id, 'gid://shopify/InventoryItem/' + id, LOC, qty);
  return id;
}

function ebayRest(withdrawn) {
  return (m, u) => {
    const g = u.match(/\/offer\/([^/?]+)$/);
    if (m === 'GET' && g) return resp(200, { offerId: g[1], availableQuantity: 1, listing: { listingStatus: 'ACTIVE', soldQuantity: 0 } });
    const w = u.match(/\/offer\/([^/]+)\/withdraw$/);
    if (m === 'POST' && w) { withdrawn.push(w[1]); return resp(200, {}); }
    return undefined;
  };
}

before(() => {
  tdb = openDbAt(path.join(DIR, 'tracker.db'));
  pdb = openPostsaleDbAt(path.join(DIR, 'postsale.db'));
  migrateChannelSync(tdb);
});
after(() => { try { tdb.close(); pdb.close(); } catch {} });
beforeEach(() => {
  alerts = [];
  tdb.exec(`DELETE FROM inventory_items; DELETE FROM shopify_listings; DELETE FROM ebay_listings; DELETE FROM stock_movements;
            DELETE FROM sync_jobs; DELETE FROM channel_sync_meta; DELETE FROM listing_pushes; DELETE FROM sealed_items;
            DELETE FROM sealed_placements; DELETE FROM sealed_pools; DELETE FROM relist_watch;`);
  pdb.exec('DELETE FROM order_line_items; DELETE FROM orders; DELETE FROM buyers; DELETE FROM shopify_order_events; DELETE FROM meta;');
  // Armed at the start of the month (the plugin sets this at the first armed boot), so the fixture orders,
  // processed 2026-10-18, are current. The epoch's own tests move it.
  setMeta(pdb, EPOCH_KEY, '2026-10-01T00:00:00.000Z');
});

describe('a Shopify sale → local stock → eBay', () => {
  it('ingests the order, decrements through applyStockDecrements, and withdraws the eBay offer', async () => {
    const id = seedListedCard('AAC-100');
    scanMovements(tdb);   // the boot-time cursor pin: everything before this is history
    const withdrawn = [];
    ebay = installEbayStub({ rest: ebayRest(withdrawn) });
    shop = shopifyStub({ orders: { 'gid://shopify/Order/5001': shopifyOrder({ id: 5001, lines: [{ sku: 'AAC-100', total: '24.98' }] }) } });
    try {
      // The receiver hands the delivery to the consumer, which stores it before the ack.
      const rec = recordStockDelivery(pdb, { webhookId: 'wh-1', topic: 'orders/paid', body: { admin_graphql_api_id: 'gid://shopify/Order/5001' } }, { shop: 'live' });
      assert.equal(rec.stored, true);
      // A redelivery of the same webhook stores nothing new.
      recordStockDelivery(pdb, { webhookId: 'wh-1', topic: 'orders/paid', body: { admin_graphql_api_id: 'gid://shopify/Order/5001' } }, { shop: 'live' });
      assert.equal(pdb.prepare('SELECT COUNT(*) n FROM shopify_order_events').get().n, 1);

      const proc = await processStockEvents(ENV, shopCtx());
      assert.equal(proc.processed, 1);
      assert.equal(proc.results[0].applied, 1, JSON.stringify(proc.results));

      // The order, as the postsale tables hold it.
      const o = pdb.prepare("SELECT * FROM orders WHERE order_id = 'shopify:5001'").get();
      assert.equal(o.channel, 'shopify');
      assert.equal(o.shipped_status, 'external', 'out of every eBay fulfilment queue');
      assert.equal(o.payment_state, 'ok');
      assert.equal(o.buyer_username, 'shopify:77');
      const li = pdb.prepare("SELECT * FROM order_line_items WHERE order_id = 'shopify:5001'").get();
      assert.equal(li.channel, 'shopify');
      assert.equal(li.unit_price_cents, 2498);
      assert.ok(li.stock_applied_at, 'applyStockDecrements stamped it');

      // The stock, through the ledger, referencing the namespaced order.
      const row = tdb.prepare('SELECT status, quantity FROM inventory_items WHERE id = ?').get(id);
      assert.deepEqual({ ...row }, { status: 'sold', quantity: 0 });
      const mv = tdb.prepare("SELECT ref_kind, ref_id FROM stock_movements WHERE item_id = ? AND reason = 'sale'").get(id);
      assert.deepEqual({ ...mv }, { ref_kind: 'order', ref_id: 'shopify:5001' });

      // eBay comes down; Shopify is NOT told about its own sale.
      const tick = await runChannelSyncTick(syncCtx());
      assert.equal(tick.done, 1, JSON.stringify(tick.results));
      assert.deepEqual(withdrawn, ['OF-AAC-100']);
      assert.equal(shop.calls.filter((c) => c.op !== 'order').length, 0, 'Shopify already took its own unit');
      assert.equal(tdb.prepare("SELECT listing_status FROM ebay_listings WHERE offer_id = 'OF-AAC-100'").get().listing_status, 'ENDED');
      assert.equal(tdb.prepare('SELECT channel_status FROM inventory_items WHERE id = ?').get(id).channel_status, 'ended');

      // And the order is no eBay order: dispatch refuses it by name.
      const d = await dispatchOrder(ENV, pdb, 'shopify:5001');
      assert.equal(d.code, 'not_an_ebay_order');
    } finally { ebay.restore(); }
  });

  it('a cancellation puts the card back on the shelf and relists nothing', async () => {
    const id = seedListedCard('AAC-101');
    scanMovements(tdb);
    const withdrawn = [];
    ebay = installEbayStub({ rest: ebayRest(withdrawn) });
    let cancelled = null;
    shop = shopifyStub({ orders: { 'gid://shopify/Order/5002': () => shopifyOrder({ id: 5002, cancelledAt: cancelled, lines: [{ sku: 'AAC-101' }] }) } });
    try {
      recordStockDelivery(pdb, { webhookId: 'wh-2', topic: 'orders/paid', body: { id: 5002 } }, { shop: 'live' });
      await processStockEvents(ENV, shopCtx());
      await runChannelSyncTick(syncCtx());
      assert.equal(tdb.prepare('SELECT status FROM inventory_items WHERE id = ?').get(id).status, 'sold');
      const callsBefore = ebay.calls.length;

      cancelled = '2026-10-18T03:00:00Z';
      recordStockDelivery(pdb, { webhookId: 'wh-3', topic: 'orders/cancelled', body: { id: 5002 } }, { shop: 'live' });
      const proc = await processStockEvents(ENV, shopCtx());
      assert.equal(proc.results[0].reversed, 1, JSON.stringify(proc.results));
      const row = tdb.prepare('SELECT status, quantity, channel_status FROM inventory_items WHERE id = ?').get(id);
      assert.deepEqual({ ...row }, { status: 'in_stock', quantity: 1, channel_status: 'ended' }, 'back on the shelf, NOT back on eBay');
      assert.equal(pdb.prepare("SELECT cancel_state FROM orders WHERE order_id = 'shopify:5002'").get().cancel_state, 'cancelled');

      // A cancel restock is a POSITIVE movement: the worker never raises a channel for it.
      const tick = await runChannelSyncTick(syncCtx());
      assert.equal(tick.ran, 0);
      assert.equal(ebay.calls.length, callsBefore, 'no eBay call at all after the cancel');
      assert.equal(shop.calls.filter((c) => c.op !== 'order').length, 0, 'and no Shopify raise');
    } finally { ebay.restore(); }
  });

  it('splits a sealed POOL line across the pool rows so the existing SKU match decrements them', async () => {
    tdb.prepare(`INSERT INTO sealed_pools (pool_sku, game, product_type, name) VALUES ('POOL-SSP-BB', 'pokemon', 'booster_box', 'Surging Sparks Booster Box')`).run();
    const ids = [];
    for (const sku of ['BK-SLD-1', 'BK-SLD-2']) {
      const id = Number(tdb.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status, pool_sku, created_at, updated_at)
                                     VALUES (?, 'pokemon', 'Surging Sparks Booster Box', 'booster_box', 1, 'in_stock', 'POOL-SSP-BB', datetime('now'), datetime('now'))`).run(sku).lastInsertRowid);
      tdb.prepare("INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?, 'Shelf A', 1)").run(id);
      tdb.prepare("INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason) VALUES ('sealed', ?, ?, 1, 1, 'opening')").run(id, sku);
      ids.push(id);
    }
    ebay = installEbayStub({});
    shop = shopifyStub({ orders: { 'gid://shopify/Order/5003': shopifyOrder({ id: 5003, lines: [{ sku: 'POOL-SSP-BB', qty: 2, total: '330.00' }] }) } });
    try {
      recordStockDelivery(pdb, { webhookId: 'wh-4', topic: 'orders/paid', body: { id: 5003 } }, { shop: 'live' });
      const proc = await processStockEvents(ENV, shopCtx());
      assert.equal(proc.results[0].applied, 2, JSON.stringify(proc.results));
      const lines = pdb.prepare("SELECT sku, quantity, unit_price_cents FROM order_line_items WHERE order_id = 'shopify:5003' ORDER BY id").all();
      assert.deepEqual(lines.map((l) => ({ ...l })), [
        { sku: 'BK-SLD-1', quantity: 1, unit_price_cents: 16500 },
        { sku: 'BK-SLD-2', quantity: 1, unit_price_cents: 16500 },
      ]);
      for (const id of ids) assert.equal(tdb.prepare('SELECT status FROM sealed_items WHERE id = ?').get(id).status, 'sold');
    } finally { ebay.restore(); }
  });

  it('a line for a card ALREADY sold here raises a double-sale alert', async () => {
    const id = seedListedCard('AAC-102');
    tdb.prepare("UPDATE inventory_items SET status = 'sold', quantity = 0 WHERE id = ?").run(id);
    ebay = installEbayStub({});
    shop = shopifyStub({ orders: { 'gid://shopify/Order/5004': shopifyOrder({ id: 5004, name: '#1004', lines: [{ sku: 'AAC-102' }] }) } });
    try {
      recordStockDelivery(pdb, { webhookId: 'wh-5', topic: 'orders/paid', body: { id: 5004 } }, { shop: 'live' });
      const proc = await processStockEvents(ENV, shopCtx());
      assert.equal(proc.results[0].double_sales, 1);
      assert.ok(alerts.some((a) => /DOUBLE SALE/.test(a) && /AAC-102/.test(a) && /#1004/.test(a)), alerts.join('\n'));
    } finally { ebay.restore(); }
  });

  it('never moves stock for a dev-store delivery, a test order, or an unpaid order', async () => {
    const id = seedListedCard('AAC-103');
    // The listener belongs to the dev store: the consumer stores nothing.
    const dev = recordStockDelivery(pdb, { webhookId: 'wh-6', topic: 'orders/paid', body: { id: 5005 } }, { shop: 'dev' });
    assert.equal(dev.stored, false);

    shop = shopifyStub({});
    const test = ingestOrderNode(shopCtx(), shopifyOrder({ id: 5006, test: true, lines: [{ sku: 'AAC-103' }] }));
    assert.match(test.skipped, /test order/);
    const pending = ingestOrderNode(shopCtx(), shopifyOrder({ id: 5007, financial: 'PENDING', lines: [{ sku: 'AAC-103' }] }));
    assert.equal(pending.ok, true);
    assert.equal(pending.stock.applied, 0, 'money not settled — the card stays on the shelf');
    assert.equal(tdb.prepare('SELECT status FROM inventory_items WHERE id = ?').get(id).status, 'listed');

    // When it settles, the next read applies it.
    const paid = ingestOrderNode(shopCtx(), shopifyOrder({ id: 5007, financial: 'PAID', lines: [{ sku: 'AAC-103' }] }));
    assert.equal(paid.stock.applied, 1);
    assert.equal(tdb.prepare('SELECT status FROM inventory_items WHERE id = ?').get(id).status, 'sold');
    assert.equal(pdb.prepare("SELECT COUNT(*) n FROM order_line_items WHERE order_id = 'shopify:5007'").get().n, 1, 'lines are written once, never re-added');
  });
});

describe('the backup poll', () => {
  it('ingests what the webhook missed and moves the cursor on a quiet, clean run', async () => {
    seedListedCard('AAC-110');
    shop = shopifyStub({ ordersPage: [shopifyOrder({ id: 5100, lines: [{ sku: 'AAC-110' }] })] });
    const now = Date.parse('2026-10-18T05:00:00Z');
    const r = await pollShopifyOrders(ENV, shopCtx(), { nowMs: now });
    assert.equal(r.ok, true);
    assert.equal(r.ingested, 1);
    assert.equal(pdb.prepare("SELECT channel FROM orders WHERE order_id = 'shopify:5100'").get().channel, 'shopify');
    assert.ok(getMeta(pdb, CURSOR_KEY) >= '2026-10-18T04:50:00', 'advanced to (run start − overlap) even though the newest order was older');

    // A second, empty run still moves forward — the K4 defect was a cursor that never did.
    const before = getMeta(pdb, CURSOR_KEY);
    shop = shopifyStub({ ordersPage: [] });
    await pollShopifyOrders(ENV, shopCtx(), { nowMs: now + 3600_000 });
    assert.ok(getMeta(pdb, CURSOR_KEY) > before);
  });

  it('the FIRST run starts from now — orders paid before the deploy are never replayed by themselves', async () => {
    shop = shopifyStub({ ordersPage: [] });
    const now = Date.parse('2026-10-18T05:00:00Z');
    await pollShopifyOrders(ENV, shopCtx(), { nowMs: now });
    assert.match(shop.calls[0].variables.q, /updated_at:>='2026-10-18T04:50:00\.000Z'/, shop.calls[0].variables.q);

    // A backfill is a deliberate act, and bounded by what read_orders can see.
    pdb.exec('DELETE FROM meta');
    shop = shopifyStub({ ordersPage: [] });
    await pollShopifyOrders(ENV, shopCtx(), { nowMs: now, since: '2026-10-01T00:00:00Z' });
    assert.match(shop.calls[0].variables.q, /updated_at:>='2026-09-30T23:50:00\.000Z'/);
    const tooFar = await pollShopifyOrders(ENV, shopCtx(), { nowMs: now, since: '2026-07-01T00:00:00Z' });
    assert.equal(tooFar.ok, false);
    assert.match(tooFar.error, /55 days/);
  });

  it('holds the cursor and says why when the read is refused', async () => {
    shop = { fn: async (url) => {
      if (String(url).includes('/admin/oauth/access_token')) return resp(200, { access_token: 't', expires_in: 86399 });
      return resp(200, { errors: [{ message: 'Access denied for orders field. Required access: `read_orders` access scope.' }] });
    } };
    const r = await pollShopifyOrders(ENV, shopCtx(), { nowMs: Date.parse('2026-10-18T05:00:00Z') });
    assert.equal(r.ok, false);
    assert.equal(r.held, true);
    assert.match(r.hint, /read_orders/);
    assert.equal(getMeta(pdb, CURSOR_KEY), null, 'a window we could not read is a window we have not read');
  });
});

describe('the epoch: an order processed before sync was armed is history', () => {
  it('the poll skips it, the webhook skips it, a backfill takes it, and an order already held stays current', async () => {
    seedListedCard('AAC-120');
    setMeta(pdb, EPOCH_KEY, '2026-10-18T03:00:00.000Z');   // armed after the fixture order was processed (01:00)
    // Paid before the deploy, REFUNDED (which counts as paid) after it: updated_at is recent, so the poll sees it.
    shop = shopifyStub({ ordersPage: [shopifyOrder({ id: 5200, financial: 'REFUNDED', updatedAt: '2026-10-18T04:59:00Z', lines: [{ sku: 'AAC-120' }] })] });
    const r = await pollShopifyOrders(ENV, shopCtx(), { nowMs: Date.parse('2026-10-18T05:00:00Z') });
    assert.equal(r.ok, true);
    assert.equal(r.ingested, 0, 'not adopted as a new sale');
    assert.equal(r.held, false, 'a skipped order is not a problem — the cursor moves on');
    assert.equal(pdb.prepare("SELECT COUNT(*) n FROM orders WHERE order_id = 'shopify:5200'").get().n, 0);
    assert.equal(tdb.prepare("SELECT status FROM inventory_items WHERE sku = 'AAC-120'").get().status, 'listed', 'the real card stays on the shelf');

    shop = shopifyStub({ orders: { 'gid://shopify/Order/5200': shopifyOrder({ id: 5200, financial: 'REFUNDED', lines: [{ sku: 'AAC-120' }] }) } });
    recordStockDelivery(pdb, { webhookId: 'wh-e1', topic: 'orders/paid', body: { id: 5200 } }, { shop: 'live' });
    const proc = await processStockEvents(ENV, shopCtx());
    assert.match(String(proc.results[0].skipped), /before_epoch/);
    assert.equal(tdb.prepare("SELECT status FROM inventory_items WHERE sku = 'AAC-120'").get().status, 'listed');

    // A deliberate backfill reaches behind the epoch.
    shop = shopifyStub({ ordersPage: [shopifyOrder({ id: 5200, financial: 'PAID', lines: [{ sku: 'AAC-120' }] })] });
    const back = await pollShopifyOrders(ENV, shopCtx(), { nowMs: Date.parse('2026-10-18T05:00:00Z'), since: '2026-10-17T00:00:00Z' });
    assert.equal(back.ingested, 1);
    assert.equal(tdb.prepare("SELECT status FROM inventory_items WHERE sku = 'AAC-120'").get().status, 'sold');

    // Once held, the order is kept current whatever its date: a cancellation must still restock.
    const again = ingestOrderNode(shopCtx(), shopifyOrder({ id: 5200, cancelledAt: '2026-10-18T06:00:00Z', lines: [{ sku: 'AAC-120' }] }));
    assert.equal(again.ok, true);
    assert.equal(again.becameCancelled, true);
  });

  it('a poll on a box with no epoch sets it, and adopts nothing from before it', async () => {
    pdb.exec('DELETE FROM meta');
    seedListedCard('AAC-121');
    shop = shopifyStub({ ordersPage: [shopifyOrder({ id: 5201, lines: [{ sku: 'AAC-121' }] })] });   // processed 01:00
    await pollShopifyOrders(ENV, shopCtx(), { nowMs: Date.parse('2026-10-18T05:00:00Z') });
    assert.equal(getMeta(pdb, EPOCH_KEY), '2026-10-18T05:00:00.000Z');
    assert.equal(pdb.prepare("SELECT COUNT(*) n FROM orders WHERE order_id = 'shopify:5201'").get().n, 0);
  });
});

describe('Shopify orders and the eBay order sweep', () => {
  it('the by-id sweep sends eBay order ids only — a pending or voided Shopify order never reaches GetOrders', async () => {
    const bid = Number(pdb.prepare("INSERT INTO buyers (ebay_username) VALUES ('ebay-bob')").run().lastInsertRowid);
    pdb.prepare(`INSERT INTO orders (order_id, buyer_id, buyer_username, created_time, paid_time, shipped_status, channel, payment_state, cancel_state)
                 VALUES ('12-34567-89012', ?, 'ebay-bob', datetime('now'), NULL, 'unshipped', 'ebay', 'pending', 'none')`).run(bid);
    ingestOrderNode(shopCtx(), shopifyOrder({ id: 5300, financial: 'PENDING', lines: [{ sku: 'AAC-130' }] }));
    ingestOrderNode(shopCtx(), shopifyOrder({ id: 5301, financial: 'VOIDED', lines: [{ sku: 'AAC-131' }] }));
    assert.equal(pdb.prepare("SELECT COUNT(*) n FROM orders WHERE channel = 'shopify'").get().n, 2);
    const asked = [];
    await sweepOpenOrders({}, pdb, { cfg: {}, fetchOrders: async (_env, { orderIds }) => { asked.push(...orderIds); return { ok: true, orders: [] }; } });
    assert.deepEqual(asked, ['12-34567-89012']);
  });
});

describe('the stock consumer while sync is off', () => {
  it('stores nothing, so a Shopify order moves no stock — exactly as before this existed', () => {
    const record = stockConsumerRecord({ pdbFn: () => pdb, armed: () => false });
    const out = record({ webhookId: 'wh-off', topic: 'orders/paid', body: { id: 5400 }, shopDomain: 'bk-live-test.myshopify.com' });
    assert.equal(out.stored, false);
    assert.match(out.reason, /sync is off/);
    assert.equal(pdb.prepare('SELECT COUNT(*) n FROM shopify_order_events').get().n, 0);
    assert.equal(stockConsumerRecord({ pdbFn: () => pdb })({ body: { id: 5401 } }).stored, false, 'unarmed is the default');
  });
});

describe('mapShopifyOrder', () => {
  it('namespaces the order and buyer, and only settled money is paid', () => {
    const m = mapShopifyOrder(shopifyOrder({ id: 9, customer: null, financial: 'AUTHORIZED', lines: [{ sku: 'X', qty: 3, total: '10.00' }] }));
    assert.equal(m.order_id, 'shopify:9');
    assert.equal(m.buyer, 'shopify:guest:9', 'a redacted or guest buyer still gets a row — orders.buyer_id is NOT NULL');
    assert.equal(m.paid, false);
    assert.equal(m.payment_state, 'pending');
    assert.equal(m.lines[0].unit_price_cents, 333, 'per unit, rounded once (GR3)');
    assert.equal(mapShopifyOrder(shopifyOrder({ financial: 'PARTIALLY_REFUNDED' })).paid, true, 'a refund does not un-sell the card');
    assert.equal(mapShopifyOrder(shopifyOrder({ financial: 'VOIDED' })).payment_state, 'failed');
  });
});
