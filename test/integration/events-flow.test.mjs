// test/integration/events-flow.test.mjs — a show, end to end: take-list → offline → table sales →
// scan back → close-out with takings → new stock → back online. Temp DBs, and an eBay + Shopify that
// REMEMBER what they were told (so "hidden then restored" is checked against the channel's own state,
// not against what the code believes it sent).
//
// The claims that matter, because each one is a live listing:
//   · taking stock offline HIDES — eBay quantity 0, never an end — and leaves the stock rows untouched
//   · the first eBay listing is a CANARY: if eBay ends it instead of hiding it, nothing else on eBay moves
//   · the out-of-stock option is read first, and "off" refuses the whole take-offline with nothing written
//   · while away, every publish path refuses (away_at_event)
//   · a card sold at the table ends its hidden listing like any sale; a card scanned back does not
//   · the close-out records the missing units as sold, and the takings split sums to the cent
//   · back online restores each listing to min(what it had before, what is held now) — never more
//   · new stock is verified on intake and tied to the show with its cost
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { migrateChannelSync } from '../../lib/channel-presence.mjs';
import { defaultDeps } from '../../lib/channel-sync.mjs';
import {
  createEvent, addToTakeList, takeOffline, scanBack, closeOutPreview, closeOut, addAcquisition, backOnline,
  eventDetail, allocateTakings,
} from '../../lib/events.mjs';
import { recordInPersonSale } from '../../lib/in-person-sales.mjs';
import { runPublish, batchPreflight } from '../../lib/listings.mjs';
import { runShopifyPublish, shopifyBatchPreflight } from '../../lib/shopify.mjs';
import { testEbayConfig } from '../helpers/ebay-config.mjs';
import { installEbayStub, shopifyStub, resp, EBAY_ENV, SHOPIFY_ENV, LOC, ARMED } from '../helpers/channel-stubs.mjs';

const ENV = { ...EBAY_ENV, ...SHOPIFY_ENV, ...ARMED };
const DIR = tmpDir('tcg-events-');
let db, ebay, shop, world, alerts;

// eBay, as a little world: hand-made listings by ItemID, Inventory-API offers by offerId.
function makeWorld({ oos = true, endOnZero = false } = {}) {
  return { oos, endOnZero, trading: {}, offers: {}, offerStatus: {}, tradingStatus: {} };
}
function getItem(id) {
  const st = world.tradingStatus[id] || 'Active';
  const q = world.trading[id] ?? 0;
  return `<GetItemResponse><Ack>Success</Ack><Item><ItemID>${id}</ItemID><ListingType>FixedPriceItem</ListingType><Quantity>${q}</Quantity>`
    + `<SellingStatus><CurrentPrice currencyID="AUD">20.00</CurrentPrice><QuantitySold>0</QuantitySold><ListingStatus>${st}</ListingStatus></SellingStatus></Item></GetItemResponse>`;
}
function install() {
  ebay = installEbayStub({
    trading: {
      GetUserPreferences: () => `<GetUserPreferencesResponse><Ack>Success</Ack><OutOfStockControlPreference>${world.oos}</OutOfStockControlPreference></GetUserPreferencesResponse>`,
      GetItem: (b) => getItem((b.match(/<ItemID>([^<]+)<\/ItemID>/) || [])[1]),
      ReviseInventoryStatus: (b) => {
        const id = (b.match(/<ItemID>([^<]+)<\/ItemID>/) || [])[1];
        const q = Number((b.match(/<Quantity>(\d+)<\/Quantity>/) || [])[1]);
        world.trading[id] = q;
        if (q === 0 && world.endOnZero) world.tradingStatus[id] = 'Completed';
        return '<ReviseInventoryStatusResponse><Ack>Success</Ack></ReviseInventoryStatusResponse>';
      },
      EndFixedPriceItem: (b) => {
        const id = (b.match(/<ItemID>([^<]+)<\/ItemID>/) || [])[1];
        world.tradingStatus[id] = 'Completed';
        return '<EndFixedPriceItemResponse><Ack>Success</Ack><EndTime>2026-10-19T00:00:00Z</EndTime></EndFixedPriceItemResponse>';
      },
    },
    rest: (m, u, body) => {
      if (m === 'POST' && u.endsWith('/bulk_update_price_quantity')) {
        const req0 = body.requests[0];
        const off = req0.offers[0];
        world.offers[off.offerId] = off.availableQuantity;
        world.offerStatus[off.offerId] = off.availableQuantity === 0 ? (world.endOnZero ? 'ENDED' : 'OUT_OF_STOCK') : 'ACTIVE';
        return resp(200, { responses: [{ statusCode: 200, sku: req0.sku, offerId: off.offerId }] });
      }
      const g = u.match(/\/offer\/([^/?]+)$/);
      if (m === 'GET' && g) return resp(200, { offerId: g[1], availableQuantity: world.offers[g[1]] ?? 0, listing: { listingStatus: world.offerStatus[g[1]] || 'ACTIVE', soldQuantity: 0 } });
      const w = u.match(/\/offer\/([^/]+)\/withdraw$/);
      if (m === 'POST' && w) { world.offerStatus[w[1]] = 'ENDED'; return resp(200, {}); }
      return undefined;
    },
  });
}
const ctx = () => ({ db, env: ENV, deps: { ...defaultDeps(), fetchImpl: shop.fn, alert: async (_e, t) => { alerts.push(t); } } });

function card(sku, { qty = 1, ask = 2000, status = 'listed' } = {}) {
  const id = Number(db.prepare(`INSERT INTO inventory_items (sku, game, identity_key, name, set_name, number, rarity, variant, language, condition, quantity, target_price_cents, image_url, status, created_at, updated_at)
    VALUES (?, 'pokemon','base1-58','Pikachu','Base Set','58/102','Common','Regular','EN','Near Mint', ?, ?, 'https://images.pokemontcg.io/base1/58.png', ?, datetime('now'), datetime('now'))`).run(sku, qty, ask, status).lastInsertRowid);
  db.prepare("INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason) VALUES ('inventory', ?, ?, ?, ?, 'opening')").run(id, sku, qty, qty);
  return id;
}
const handMade = (id, listingId, q = 1) => {
  db.prepare(`INSERT INTO ebay_seller_listings (listing_id, sku, title, quantity, available_qty, listing_type, state, created_via, item_id)
              VALUES (?, ?, 'Card', ?, ?, 'FixedPriceItem', 'active', 'manual', ?)`).run(listingId, 'X' + listingId, q, q, id);
  world.trading[listingId] = q;
};
const toolListed = (id, sku, offer, q = 1) => {
  db.prepare("UPDATE inventory_items SET ebay_offer_id = ?, ebay_listing_id = ?, channel_status = 'active' WHERE id = ?").run(offer, '22' + id, id);
  db.prepare("INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, available_qty, listing_status) VALUES (?, 'EBAY_AU', ?, ?, ?, ?, 'ACTIVE')").run(sku, offer, '22' + id, id, q);
  world.offers[offer] = q;
};
const onShopify = (id, sku, q = 1) => db.prepare(`INSERT INTO shopify_listings (sku, store, kind, item_id, product_gid, inventory_gid, location_gid, state, available_qty)
  VALUES (?, 'live', 'inventory', ?, 'gid://shopify/Product/1', ?, ?, 'live', ?)`).run(sku, id, 'gid://shopify/InventoryItem/' + id, LOC, q);
function pool(poolSku, units, offer) {
  db.prepare(`INSERT INTO sealed_pools (pool_sku, game, product_type, name, price_cents, ebay_offer_id, ebay_listing_id, channel_status) VALUES (?, 'pokemon', 'booster_box', 'Booster Box', 16500, ?, '2299', 'active')`).run(poolSku, offer);
  const id = Number(db.prepare(`INSERT INTO sealed_items (sku, game, name, product_type, quantity, status, pool_sku, target_price_cents, created_at, updated_at)
    VALUES (?, 'pokemon', 'Booster Box', 'booster_box', ?, 'listed', ?, 16500, datetime('now'), datetime('now'))`).run(poolSku + '-1', units, poolSku).lastInsertRowid);
  db.prepare("INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?, 'Shelf', ?)").run(id, units);
  db.prepare("INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason) VALUES ('sealed', ?, ?, ?, ?, 'opening')").run(id, poolSku + '-1', units, units);
  world.offers[offer] = units;
  return id;
}

before(() => { db = openDbAt(path.join(DIR, 'tracker.db')); migrateChannelSync(db); });
after(() => { try { db.close(); } catch {} });
beforeEach(() => {
  alerts = [];
  db.exec(`DELETE FROM inventory_items; DELETE FROM ebay_seller_listings; DELETE FROM ebay_listings; DELETE FROM shopify_listings; DELETE FROM stock_movements;
           DELETE FROM sync_jobs; DELETE FROM in_person_sales; DELETE FROM events; DELETE FROM event_items; DELETE FROM event_targets; DELETE FROM event_acquisitions;
           DELETE FROM sealed_items; DELETE FROM sealed_placements; DELETE FROM sealed_pools; DELETE FROM listing_pushes; DELETE FROM sealed_listing_pushes;
           DELETE FROM stock_verifications;`);
});

describe('a show, end to end', () => {
  it('takes stock offline, sells, closes out, and brings everything back to exactly what it was', async () => {
    world = makeWorld();
    install();
    const A = card('AAC-400');                 // hand-made eBay + live Shopify — sells at the table
    handMade(A, '9400'); onShopify(A, 'AAC-400');
    const B = card('AAC-401');                 // tool eBay listing — comes home
    toolListed(B, 'AAC-401', 'OF-401');
    const C = card('AAC-402', { ask: 1000, status: 'in_stock' });   // not online — sells, unpriced
    const P = pool('POOL-E', 3, 'OF-P');       // 3 boxes on eBay; 2 go to the show, 1 sells
    shop = shopifyStub({ levels: { ['gid://shopify/InventoryItem/' + A]: 1 } });
    try {
      const ev = createEvent(db, { name: 'Bendigo Card Show', venue: 'Bendigo' }).event;
      for (const line of [{ sku: 'AAC-400' }, { sku: 'AAC-401' }, { sku: 'AAC-402' }, { sku: 'POOL-E-1', qty: 2 }]) {
        const r = addToTakeList(db, ev.id, line);
        assert.equal(r.ok, true, JSON.stringify(r));
      }

      // --- take offline ---
      const off = await takeOffline(ctx(), ev.id);
      assert.equal(off.ok, true, JSON.stringify(off.report || off));
      assert.equal(off.report.preflight.out_of_stock_option, true);
      assert.equal(world.trading['9400'], 0, 'the hand-made listing is HIDDEN at 0');
      assert.equal(world.tradingStatus['9400'] || 'Active', 'Active', '…and still alive');
      assert.equal(world.offers['OF-401'], 0);
      assert.equal(world.offerStatus['OF-401'], 'OUT_OF_STOCK', 'the tool listing is hidden, not ended');
      assert.equal(world.offers['OF-P'], 1, 'two boxes away out of three: eBay offers the one left at home');
      assert.equal(shop.state.levels['gid://shopify/InventoryItem/' + A], 0, 'sold out on Shopify');
      assert.ok(!ebay.calls.some((c) => c.call === 'EndFixedPriceItem' || /withdraw$/.test(c.url || '')), 'NOTHING was ended to take it offline');
      const rows = db.prepare('SELECT quantity, status FROM inventory_items WHERE id IN (?, ?)').all(A, B);
      assert.deepEqual(rows.map((r) => ({ ...r })), [{ quantity: 1, status: 'listed' }, { quantity: 1, status: 'listed' }], 'stock rows untouched');
      assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE reason <> 'opening'").get().n, 0, 'no stock movement for a hide');
      const pre = Object.fromEntries(db.prepare('SELECT target_key, pre_qty, state FROM event_targets').all().map((t) => [t.target_key, [t.pre_qty, t.state]]));
      assert.deepEqual(pre, {
        'ebay:trading:9400': [1, 'hidden'], 'ebay:offer:OF-401': [1, 'hidden'], 'ebay:pool:POOL-E': [3, 'hidden'],
        ['shopify:shopify:AAC-400']: [1, 'hidden'],
      });

      // --- while away, nothing re-lists it ---
      const cfg = testEbayConfig({ genericImage: { enabled: false } });
      const pub = await runPublish(ENV, db, cfg, () => {}, { itemId: B }).catch((e) => ({ threw: e.message }));
      assert.equal(pub.code, 'away_at_event');
      const shopCfg = { defaultStore: 'live', stores: { live: { locationGid: LOC, publicationGid: 'gid://shopify/Publication/2' } }, publish: { enabled: true, status: 'ACTIVE' }, collections: {} };
      const sp = await runShopifyPublish({ env: ENV, db, base: 'http://127.0.0.1:1', cfg: shopCfg, item: db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(A), store: 'live', fetchImpl: shop.fn });
      assert.equal(sp.code, 'away_at_event');
      // Both batch preflights say so too, so neither promises a row its run will turn away.
      const ebayPre = batchPreflight(db, cfg, { itemIds: [B] });
      assert.ok(ebayPre.rows[0].refusals.some((r) => r.code === 'away_at_event'), JSON.stringify(ebayPre.rows[0]));
      const shopPre = shopifyBatchPreflight(db, shopCfg, { itemIds: [A], store: 'live' });
      assert.equal(shopPre.rows[0].ok, false);
      assert.equal(shopPre.rows[0].code, 'away_at_event');

      // --- at the table: A sells with a price, C sells without one ---
      const sa = recordInPersonSale(db, { sku: 'AAC-400', unit_price_cents: 2000 }, {});
      assert.equal(sa.ok, true, JSON.stringify(sa));
      assert.equal(sa.event_id, ev.id, 'a card on the take-list is counted against its show automatically');
      const { drainJobs } = await import('../../lib/channel-sync.mjs');
      await drainJobs(ctx(), sa.jobs.map((j) => j.id));
      assert.equal(world.tradingStatus['9400'], 'Completed', 'sold at the table: its hidden listing ENDS, like any sale');
      const sc = recordInPersonSale(db, { sku: 'AAC-402' }, { eventId: ev.id });
      assert.equal(sc.ok, true);

      // --- home: B comes back, one box comes back ---
      assert.equal(scanBack(db, ev.id, { sku: 'AAC-401' }).ok, true);
      assert.equal(scanBack(db, ev.id, { sku: 'POOL-E-1', qty: 1 }).ok, true);
      assert.equal(scanBack(db, ev.id, { sku: 'AAC-400' }).code, 'all_accounted', 'a card sold at the table cannot also come home');

      // --- close out: A$50 takings; A known at 20.00; C and the missing box share the other 30.00 by ask ---
      const pv = closeOutPreview(db, ev.id, { takings: { cash: 5000 } });
      assert.equal(pv.known_cents, 2000);
      assert.equal(pv.remainder_cents, 3000);
      const boxLine = pv.lines.find((l) => l.kind === 'sealed');
      assert.equal(boxLine.units, 1);
      const cFill = pv.table_fill[0].unit_cents[0];
      assert.equal(boxLine.unit_cents[0] + cFill, 3000, 'the split sums to the cent');
      assert.ok(boxLine.unit_cents[0] > cFill * 10, 'weighted by asking price (165.00 vs 10.00)');

      const co = await closeOut(ctx(), ev.id, { takings: { cash: 5000 } });
      assert.equal(co.ok, true, JSON.stringify(co));
      assert.equal(co.recorded.length, 1);
      assert.equal(db.prepare('SELECT quantity FROM sealed_items WHERE id = ?').get(P).quantity, 2, 'one box sold at the show');
      assert.equal(db.prepare("SELECT unit_price_cents FROM in_person_sales WHERE sku = 'AAC-402'").get().unit_price_cents, cFill);
      assert.equal(db.prepare('SELECT status FROM inventory_items WHERE id = ?').get(B).status, 'listed', 'B came home: not sold');
      assert.equal(eventDetail(db, ev.id).event.status, 'closing');

      // --- new stock bought at the show ---
      const D = card('AAC-450', { status: 'in_stock' });
      const acq = addAcquisition(db, ev.id, { kind: 'inventory', item_id: D, how: 'traded', cost_cents: 1500, channel: 'shopify' });
      assert.equal(acq.ok, true, JSON.stringify(acq));
      assert.ok(db.prepare('SELECT verified_at FROM inventory_items WHERE id = ?').get(D).verified_at, 'entered in hand = verified');

      // --- back online ---
      const bo = await backOnline(ctx(), ev.id);
      assert.equal(bo.ok, true);
      assert.equal(world.offers['OF-401'], 1, 'B restored to the 1 it had');
      assert.equal(world.offerStatus['OF-401'], 'ACTIVE');
      assert.equal(world.offers['OF-P'], 2, 'the pool back to min(3 before, 2 held now) — never the 3');
      const t = Object.fromEntries(db.prepare('SELECT target_key, state FROM event_targets').all().map((r) => [r.target_key, r.state]));
      assert.equal(t['ebay:offer:OF-401'], 'restored');
      assert.equal(t['ebay:pool:POOL-E'], 'restored');
      assert.equal(t['ebay:trading:9400'], 'sold', 'A sold, so its listing ended — recorded as sold, not flagged for a relist');
      assert.equal(t['shopify:shopify:AAC-400'], 'sold');
      assert.equal(shop.state.levels['gid://shopify/InventoryItem/' + A], 0, 'A sold: Shopify stays at 0');
      assert.equal(eventDetail(db, ev.id).event.status, 'closed');
      assert.ok(!ebay.calls.some((c) => c.call === 'ReviseInventoryStatus' && /<ItemID>9400<\/ItemID><Quantity>1/.test(c.body)), 'a sold card is never put back');
    } finally { ebay.restore(); }
  });
});

describe('taking offline refuses rather than ending listings', () => {
  it("refuses outright when eBay's out-of-stock option is off — nothing written, still planning", async () => {
    world = makeWorld({ oos: false });
    install();
    const A = card('AAC-500');
    handMade(A, '9500');
    shop = shopifyStub({});
    try {
      const ev = createEvent(db, { name: 'Market' }).event;
      addToTakeList(db, ev.id, { sku: 'AAC-500' });
      const r = await takeOffline(ctx(), ev.id);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'out_of_stock_option_off');
      assert.deepEqual(ebay.calls.map((c) => c.call), ['GetUserPreferences'], 'only the setting was read');
      assert.equal(world.trading['9500'], 1);
      assert.equal(eventDetail(db, ev.id).event.status, 'planning');
    } finally { ebay.restore(); }
  });

  it('a canary that eBay ENDS instead of hiding stops every other eBay hide', async () => {
    world = makeWorld({ endOnZero: true });
    install();
    const ids = ['AAC-510', 'AAC-511', 'AAC-512'].map((sku, i) => { const id = card(sku); toolListed(id, sku, 'OF-51' + i); return id; });
    const S = card('AAC-513'); onShopify(S, 'AAC-513');
    shop = shopifyStub({ levels: { ['gid://shopify/InventoryItem/' + S]: 1 } });
    try {
      const ev = createEvent(db, { name: 'Market' }).event;
      for (const sku of ['AAC-510', 'AAC-511', 'AAC-512', 'AAC-513']) addToTakeList(db, ev.id, { sku });
      const r = await takeOffline(ctx(), ev.id);
      assert.equal(r.ok, false);
      assert.equal(r.report.canary_failed, true);
      assert.match(r.report.canary.error, /ENDED/);
      const writes = ebay.calls.filter((c) => c.url && c.url.endsWith('/bulk_update_price_quantity'));
      assert.equal(writes.length, 1, 'only the canary was sent');
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_jobs WHERE state = 'paused'").get().n, 2, 'the other two wait, paused');
      assert.equal(shop.state.levels['gid://shopify/InventoryItem/' + S], 0, 'Shopify still came down');
      void ids;
    } finally { ebay.restore(); }
  });

  it('the take-list refuses what cannot go', () => {
    world = makeWorld();
    const sold = card('AAC-520', { status: 'sold', qty: 0 });
    const free = card('AAC-521');
    const ev = createEvent(db, { name: 'Market' }).event;
    const other = createEvent(db, { name: 'Other show' }).event;
    void sold;
    assert.equal(addToTakeList(db, ev.id, { sku: 'AAC-520' }).code, 'already_sold');
    assert.equal(addToTakeList(db, ev.id, { sku: 'AAC-521' }).ok, true);
    assert.equal(addToTakeList(db, ev.id, { sku: 'AAC-521' }).code, 'already_listed');
    assert.equal(addToTakeList(db, other.id, { sku: 'AAC-521' }).code, 'on_another_event');
    db.prepare("INSERT INTO run_reservations (kind, item_id, qty, state) VALUES ('inventory', ?, 1, 'active')").run(card('AAC-522'));
    assert.equal(addToTakeList(db, ev.id, { sku: 'AAC-522' }).code, 'reserved_for_run');
    void free;
  });
});

describe('allocateTakings', () => {
  it('splits by asking price, exactly, and invents nothing when the takings are short', () => {
    const a = allocateTakings({ takingsCents: 1000, knownCents: 0, units: [{ askCents: 100 }, { askCents: 300 }, { askCents: null }] });
    assert.equal(a.allocated.reduce((s, x) => s + x, 0), 1000);
    assert.ok(a.allocated[1] > a.allocated[0]);
    const short = allocateTakings({ takingsCents: 500, knownCents: 900, units: [{ askCents: 100 }] });
    assert.equal(short.short, true);
    assert.deepEqual(short.allocated, [null]);
    assert.deepEqual(allocateTakings({ takingsCents: null, units: [{ askCents: 1 }] }).allocated, [null]);
  });
});
