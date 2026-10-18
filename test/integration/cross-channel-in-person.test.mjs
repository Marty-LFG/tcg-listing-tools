// test/integration/cross-channel-in-person.test.mjs — a card sold across a table comes off eBay and
// Shopify (audit V10), through the real /api/channels routes, a temp tracker DB, and stubbed channels.
//
// What is pinned here is the order of events and what each channel is asked to do:
//   · the sale is in the stock ledger BEFORE any channel is touched, and stays there when one fails
//   · a hand-made eBay listing with nothing left is ENDED (GetItem → EndFixedPriceItem → GetItem)
//   · a hand-made listing with units left is REVISED to the remainder, never above it
//   · a tool listing with nothing left is WITHDRAWN through the Inventory API
//   · Shopify is lowered by compare-and-swap, never raised
//   · a Shopify failure is reported to the phone and retried, not swallowed
//   · reserved, already-sold and over-quantity lines are refused with nothing written
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { makeChannelsRouter } from '../../lib/cross-channel.mjs';
import { defaultDeps, runChannelSyncTick } from '../../lib/channel-sync.mjs';
import { migrateChannelSync } from '../../lib/channel-presence.mjs';
import { installEbayStub, shopifyStub, getItemXml, resp, EBAY_ENV, SHOPIFY_ENV, LOC, ARMED } from '../helpers/channel-stubs.mjs';

const ENV = { ...EBAY_ENV, ...SHOPIFY_ENV, ...ARMED };
// The test's own HTTP client. Captured before any stub replaces globalThis.fetch, which plays eBay.
const httpFetch = globalThis.fetch;
const DIR = tmpDir('tcg-inperson-');
let db, server, base, ebay, shop, alerts;

function deps() {
  return { ...defaultDeps(), fetchImpl: shop.fn, alert: async (_env, text) => { alerts.push(text); return { ok: true }; } };
}

async function post(p, body) {
  const r = await httpFetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}

function seedCard({ sku, qty = 1, status = 'listed', name = 'Charizard ex' } = {}) {
  const r = db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, target_price_cents, created_at, updated_at)
                        VALUES (?, 'pokemon', ?, ?, ?, 2500, datetime('now'), datetime('now'))`).run(sku, name, qty, status);
  const id = Number(r.lastInsertRowid);
  // The opening balance, so the ledger and the cache agree before the sale (the shape every real
  // create path files — see lib/stock-ledger.mjs).
  db.prepare(`INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason) VALUES ('inventory', ?, ?, ?, ?, 'opening')`).run(id, sku, qty, qty);
  return id;
}
function handMade(itemId, { listingId, available = 1, sku }) {
  db.prepare(`INSERT INTO ebay_seller_listings (listing_id, sku, title, price_cents, quantity, available_qty, sold_qty, listing_type, state, created_via, item_id)
              VALUES (?,?,?,?,?,?,0,'FixedPriceItem','active','manual',?)`).run(listingId, sku, 'Card', 2500, available, available, itemId);
}
function onShopify(itemId, { sku, available = 1, state = 'live', inv }) {
  db.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty)
              VALUES (?, 'live', 'inventory', ?, 'gid://shopify/Product/1', ?, ?, ?, ?)`).run(sku, itemId, inv, LOC, state, available);
}

before(async () => {
  db = openDbAt(path.join(DIR, 'tracker.db'));
  migrateChannelSync(db);
  server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/channels/, '') || '/';
    makeChannelsRouter({ env: ENV, db, deps: deps() })(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/channels`;
});
after(() => { try { server.close(); } catch {} try { db.close(); } catch {} });
beforeEach(() => {
  alerts = [];
  db.exec(`DELETE FROM inventory_items; DELETE FROM ebay_seller_listings; DELETE FROM shopify_listings; DELETE FROM stock_movements;
           DELETE FROM sync_jobs; DELETE FROM in_person_sales; DELETE FROM ebay_listings; DELETE FROM listing_pushes;
           DELETE FROM sealed_items; DELETE FROM sealed_placements; DELETE FROM sealed_pools; DELETE FROM run_reservations;`);
});

describe('sold in person — one card at the table', () => {
  it('records the sale, ENDS the hand-made eBay listing, and zeroes Shopify by compare-and-swap', async () => {
    const id = seedCard({ sku: 'AAC-084' });
    handMade(id, { listingId: '9001', sku: 'AAC-084' });
    onShopify(id, { sku: 'AAC-084', inv: 'gid://shopify/InventoryItem/84' });
    ebay = installEbayStub({
      trading: {
        GetItem: (_b, n) => getItemXml({ itemId: '9001', status: n === 1 ? 'Active' : 'Completed', quantity: 1 }),
        EndFixedPriceItem: '<EndFixedPriceItemResponse><Ack>Success</Ack><EndTime>2026-10-18T02:00:00Z</EndTime></EndFixedPriceItemResponse>',
      },
    });
    shop = shopifyStub({ levels: { 'gid://shopify/InventoryItem/84': 1 } });
    try {
      const r = await post('/in-person', { lines: [{ sku: 'aac-084', qty: 1, unit_price_cents: 2200 }], event: 'Bendigo show' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.sale.sold_out, true);

      // The stock side: sold, through the ledger, as an in-person sale.
      const row = db.prepare('SELECT status, quantity, sale_price_cents, channel_status FROM inventory_items WHERE id = ?').get(id);
      assert.equal(row.status, 'sold');
      assert.equal(row.quantity, 0);
      assert.equal(row.sale_price_cents, 2200);
      const mv = db.prepare("SELECT delta, reason, ref_kind, ref_id FROM stock_movements WHERE item_id = ? AND reason = 'sale'").get(id);
      assert.deepEqual({ ...mv }, { delta: -1, reason: 'sale', ref_kind: 'in_person', ref_id: 'ips-' + r.body.sale.sale_id });
      const sale = db.prepare('SELECT qty, unit_price_cents, event, sold_out FROM in_person_sales').get();
      assert.deepEqual({ ...sale }, { qty: 1, unit_price_cents: 2200, event: 'Bendigo show', sold_out: 1 });

      // eBay: read, end, read back. Nothing else.
      assert.deepEqual(ebay.calls.map((c) => c.call), ['GetItem', 'EndFixedPriceItem', 'GetItem']);
      assert.match(ebay.calls[1].body, /<ItemID>9001<\/ItemID><EndingReason>NotAvailable<\/EndingReason>/);
      assert.equal(db.prepare("SELECT state FROM ebay_seller_listings WHERE listing_id = '9001'").get().state, 'ended');

      // Shopify: read the level, compare-and-swap it to zero.
      assert.deepEqual(shop.ops(), ['readLevel', 'setQty']);
      const q = shop.calls[1].variables.input.quantities[0];
      assert.equal(q.quantity, 0);
      assert.equal(q.changeFromQuantity, 1, 'without the compare a concurrent Shopify sale would be overwritten');
      assert.equal(db.prepare("SELECT available_qty FROM shopify_listings WHERE store = 'live' AND sku = 'AAC-084'").get().available_qty, 0);

      // And the phone is told, channel by channel.
      const byChannel = Object.fromEntries(r.body.channels.map((c) => [c.channel, c]));
      assert.equal(byChannel.ebay.ok, true); assert.equal(byChannel.ebay.action, 'ended');
      assert.equal(byChannel.shopify.ok, true); assert.equal(byChannel.shopify.action, 'reduced');
      assert.deepEqual(r.body.unreached, []);
    } finally { ebay.restore(); }
  });

  it('a card with units left REVISES the hand-made listing to the remainder, and lowers Shopify to match', async () => {
    const id = seedCard({ sku: 'AAD-010', qty: 3, name: 'Pikachu' });
    handMade(id, { listingId: '9010', sku: 'AAD-010', available: 3 });
    onShopify(id, { sku: 'AAD-010', available: 3, inv: 'gid://shopify/InventoryItem/10' });
    ebay = installEbayStub({
      trading: {
        GetItem: (_b, n) => getItemXml({ itemId: '9010', quantity: n <= 2 ? 3 : 2 }),
        ReviseInventoryStatus: '<ReviseInventoryStatusResponse><Ack>Success</Ack></ReviseInventoryStatusResponse>',
      },
    });
    shop = shopifyStub({ levels: { 'gid://shopify/InventoryItem/10': 3 } });
    try {
      const r = await post('/in-person', { lines: [{ sku: 'AAD-010', qty: 1 }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(db.prepare('SELECT quantity, status FROM inventory_items WHERE id = ?').get(id).quantity, 2);
      const revise = ebay.calls.find((c) => c.call === 'ReviseInventoryStatus');
      assert.ok(revise, 'the listing must be revised, not ended — two are still on the shelf');
      assert.match(revise.body, /<Quantity>2<\/Quantity>/, 'the quantity to leave AVAILABLE, never a total');
      assert.ok(!ebay.calls.some((c) => c.call === 'EndFixedPriceItem'));
      assert.equal(shop.calls.find((c) => c.op === 'setQty').variables.input.quantities[0].quantity, 2);
    } finally { ebay.restore(); }
  });

  it('a TOOL listing with nothing left is withdrawn through the Inventory API', async () => {
    const id = seedCard({ sku: 'AAE-001', name: 'Mew' });
    db.prepare("UPDATE inventory_items SET ebay_offer_id = 'OF-1', ebay_listing_id = '2255001', channel_status = 'active' WHERE id = ?").run(id);
    db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, available_qty, listing_status) VALUES ('AAE-001','EBAY_AU','OF-1','2255001',?,1,'ACTIVE')`).run(id);
    ebay = installEbayStub({
      rest: (m, u) => {
        if (m === 'GET' && /\/offer\/OF-1$/.test(u)) return resp(200, { offerId: 'OF-1', availableQuantity: 1, status: 'PUBLISHED', listing: { listingId: '2255001', listingStatus: 'ACTIVE', soldQuantity: 0 } });
        if (m === 'POST' && /\/offer\/OF-1\/withdraw$/.test(u)) return resp(200, { listingId: '2255001' });
        return undefined;
      },
    });
    shop = shopifyStub({});
    try {
      const r = await post('/in-person', { lines: [{ sku: 'AAE-001' }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(ebay.calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/api\.ebay\.com/, '')}`),
        ['GET /sell/inventory/v1/offer/OF-1', 'POST /sell/inventory/v1/offer/OF-1/withdraw']);
      const row = db.prepare('SELECT status, channel_status FROM inventory_items WHERE id = ?').get(id);
      assert.deepEqual({ ...row }, { status: 'sold', channel_status: 'ended' });
      assert.equal(db.prepare("SELECT listing_status FROM ebay_listings WHERE offer_id = 'OF-1'").get().listing_status, 'ENDED');
      assert.equal(db.prepare("SELECT action FROM listing_pushes WHERE item_id = ? ORDER BY id DESC").get(id).action, 'withdraw');
      assert.equal(shop.calls.length, 0, 'not on Shopify, so Shopify is never asked');
    } finally { ebay.restore(); }
  });

  it('a Shopify failure is REPORTED and retried — the sale stays recorded', async () => {
    const id = seedCard({ sku: 'AAF-005' });
    onShopify(id, { sku: 'AAF-005', inv: 'gid://shopify/InventoryItem/5' });
    ebay = installEbayStub({});
    shop = shopifyStub({ levels: { 'gid://shopify/InventoryItem/5': 1 }, fail: true });
    try {
      const r = await post('/in-person', { lines: [{ sku: 'AAF-005' }] });
      assert.equal(r.status, 201, 'the sale is a fact; a slow channel does not un-make it');
      assert.equal(db.prepare('SELECT status FROM inventory_items WHERE id = ?').get(id).status, 'sold');
      assert.equal(r.body.unreached.length, 1);
      const bad = r.body.unreached[0];
      assert.equal(bad.channel, 'shopify');
      assert.equal(bad.state, 'failed');
      assert.ok(bad.retryInMin >= 1, 'the phone is told it will be retried');
      const job = db.prepare("SELECT state, attempts, last_error FROM sync_jobs WHERE channel = 'shopify'").get();
      assert.equal(job.state, 'failed');
      assert.match(job.last_error, /Shopify/);

      // The store comes back; the next pass (with the backoff elapsed) finishes the job.
      shop.state.fail = false;
      db.exec("UPDATE sync_jobs SET run_after = datetime('now', '-1 minute')");
      const tick = await runChannelSyncTick({ db, env: ENV, deps: deps() });
      assert.equal(tick.done, 1, JSON.stringify(tick.results));
      assert.equal(shop.state.levels['gid://shopify/InventoryItem/5'], 0);
      assert.equal(db.prepare("SELECT state FROM sync_jobs WHERE channel = 'shopify'").get().state, 'done');
    } finally { ebay.restore(); }
  });

  it('gives up LOUDLY: after the last attempt the job is dead and an alert goes out', async () => {
    const id = seedCard({ sku: 'AAF-006' });
    onShopify(id, { sku: 'AAF-006', inv: 'gid://shopify/InventoryItem/6' });
    ebay = installEbayStub({});
    shop = shopifyStub({ levels: { 'gid://shopify/InventoryItem/6': 1 }, fail: true });
    try {
      await post('/in-person', { lines: [{ sku: 'AAF-006' }] });
      for (let i = 0; i < 8; i++) {
        db.exec("UPDATE sync_jobs SET run_after = datetime('now', '-1 minute') WHERE state = 'failed'");
        await runChannelSyncTick({ db, env: ENV, deps: deps() });
      }
      assert.equal(db.prepare("SELECT state FROM sync_jobs WHERE channel = 'shopify'").get().state, 'dead');
      assert.ok(alerts.some((a) => /Stock still live after a sale/.test(a) && /AAF-006/.test(a)), alerts.join('\n'));
    } finally { ebay.restore(); }
  });

  it('a card not listed anywhere is just recorded — no channel is called', async () => {
    seedCard({ sku: 'AAG-001', status: 'in_stock' });
    ebay = installEbayStub({});
    shop = shopifyStub({});
    try {
      const r = await post('/in-person', { lines: [{ sku: 'AAG-001' }] });
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.channels, []);
      assert.equal(ebay.calls.length + shop.calls.length, 0);
    } finally { ebay.restore(); }
  });
});

describe('sold in person — refusals write nothing', () => {
  beforeEach(() => { ebay = installEbayStub({}); shop = shopifyStub({}); });

  it('refuses a card already recorded as sold', async () => {
    seedCard({ sku: 'AAH-001', status: 'sold', qty: 0 });
    const r = await post('/in-person', { lines: [{ sku: 'AAH-001' }] });
    ebay.restore();
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'already_sold');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM in_person_sales').get().n, 0);
  });

  it('refuses more than the shelf holds', async () => {
    seedCard({ sku: 'AAH-002', qty: 2 });
    const r = await post('/in-person', { lines: [{ sku: 'AAH-002', qty: 3 }] });
    ebay.restore();
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'not_enough');
    assert.equal(db.prepare("SELECT quantity FROM inventory_items WHERE sku = 'AAH-002'").get().quantity, 2);
  });

  it("refuses a card reserved for a Keeper's Run", async () => {
    const id = seedCard({ sku: 'AAH-003' });
    db.prepare("INSERT INTO run_reservations (kind, item_id, qty, state) VALUES ('inventory', ?, 1, 'active')").run(id);
    const r = await post('/in-person', { lines: [{ sku: 'AAH-003' }] });
    ebay.restore();
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'reserved_for_run');
    assert.equal(db.prepare('SELECT status FROM inventory_items WHERE id = ?').get(id).status, 'listed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n, 0);
  });

  it('names an unknown label instead of guessing', async () => {
    const r = await post('/in-person', { lines: [{ sku: 'ZZZ-999' }] });
    ebay.restore();
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'not_found');
  });
});

describe('sold in person — end of day batch', () => {
  it('records every line first, then each card\'s channels, streamed; sealed draws from the named shelf', async () => {
    const card = seedCard({ sku: 'AAJ-001', status: 'in_stock' });
    const box = Number(db.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status, created_at, updated_at)
                                   VALUES ('BK-SLD-000042','pokemon','Surging Sparks Booster Box','booster_box',3,'in_stock',datetime('now'),datetime('now'))`).run().lastInsertRowid);
    db.prepare("INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?, 'Back room', 2), (?, 'Show box', 1)").run(box, box);
    db.prepare("INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason) VALUES ('sealed', ?, 'BK-SLD-000042', 3, 3, 'opening')").run(box);
    ebay = installEbayStub({});
    shop = shopifyStub({});
    try {
      const r = await post('/in-person', {
        stream: true, event: 'Market day',
        lines: [{ sku: 'AAJ-001', unit_price_cents: 500 }, { sku: 'BK-SLD-000042', qty: 1, unit_price_cents: 16500, location: 'Show box' }, { sku: 'NOPE-1' }],
      });
      assert.equal(r.status, 200);
      const msgs = r.text.trim().split('\n').map((l) => JSON.parse(l));
      const kinds = msgs.map((m) => Object.keys(m)[0]);
      assert.deepEqual(kinds.slice(0, 4), ['start', 'recorded', 'recorded', 'recorded'], 'every sale is written down before any channel is touched');
      assert.equal(kinds.at(-1), 'summary');
      const sum = msgs.at(-1).summary;
      assert.equal(sum.recorded, 2);
      assert.equal(sum.refused, 1);
      assert.equal(db.prepare('SELECT status FROM inventory_items WHERE id = ?').get(card).status, 'sold');
      const places = Object.fromEntries(db.prepare('SELECT location, quantity FROM sealed_placements WHERE item_id = ?').all(box).map((p) => [p.location, p.quantity]));
      assert.deepEqual(places, { 'Back room': 2 }, 'the box came off the show-table shelf, not the biggest pile');
      assert.equal(db.prepare('SELECT quantity FROM sealed_items WHERE id = ?').get(box).quantity, 2);
      const batch = db.prepare('SELECT DISTINCT batch_ref FROM in_person_sales').all();
      assert.equal(batch.length, 1, 'the two lines of one batch share a reference');
    } finally { ebay.restore(); }
  });

  it('preview resolves and checks every line and writes nothing', async () => {
    seedCard({ sku: 'AAK-001' });
    seedCard({ sku: 'AAK-002', status: 'sold', qty: 0 });
    const r = await post('/in-person/preview', { lines: [{ sku: 'AAK-001' }, { sku: 'AAK-002' }, { sku: 'AAK-404' }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rows.map((x) => x.ok), [true, false, false]);
    assert.equal(r.body.rows[1].code, 'already_sold');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM in_person_sales').get().n, 0);
    assert.equal(db.prepare("SELECT status FROM inventory_items WHERE sku = 'AAK-001'").get().status, 'listed');
  });
});
