// test/integration/listings-revise.test.mjs — changing price/quantity on a HAND-MADE eBay listing
// through Trading ReviseInventoryStatus. The only route to those listings, and the most dangerous
// call in the app, so most of these tests are about what it REFUSES to send.
//
// The quantity rule that everything hangs on: <Quantity> is the quantity to leave AVAILABLE; eBay
// re-adds QuantitySold itself. Sending a total oversells by exactly the sold count, silently.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DB_PATH = path.join(os.tmpdir(), 'tcg-revise-test-' + process.pid + '.db');
process.env.TCG_TRACKER_DB = DB_PATH;
const { openDb } = await import('../../lib/db.mjs');
const { reviseTradingListing, PRICE_SANITY_MULTIPLE } = await import('../../lib/listings.mjs');
const { buildReviseInventoryStatusInner } = await import('../../lib/ebay-trading.mjs');

const ENV = { EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y', EBAY_REFRESH_TOKEN: 'fake' };
const realFetch = globalThis.fetch;
let db, sent = [];

// eBay's GetItem view of a listing. Quantity is the TOTAL (available + sold), as eBay reports it.
function liveItem({ total = 3, sold = 2, price = '32.48', type = 'FixedPriceItem', status = 'Active' } = {}) {
  return `<GetItemResponse><Ack>Success</Ack><Item><ItemID>9001</ItemID><Title>Wailord</Title><SKU>AAC-084</SKU>
    <ListingType>${type}</ListingType><Quantity>${total}</Quantity>
    <SellingStatus><CurrentPrice currencyID="AUD">${price}</CurrentPrice><QuantitySold>${sold}</QuantitySold>
    <ListingStatus>${status}</ListingStatus></SellingStatus></Item></GetItemResponse>`;
}
function stub({ item = liveItem(), reviseAck = 'Success', reviseBody = '' } = {}) {
  sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/oauth2/token')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) };
    const call = /X-EBAY-API-CALL-NAME/i.test(JSON.stringify(opts.headers || {})) ? (opts.headers['X-EBAY-API-CALL-NAME'] || '') : '';
    sent.push({ call, body: String(opts.body || '') });
    if (call === 'GetItem') return { ok: true, status: 200, text: async () => (typeof item === 'function' ? item(sent.length) : item) };
    return { ok: true, status: 200, text: async () => `<ReviseInventoryStatusResponse><Ack>${reviseAck}</Ack>${reviseBody}</ReviseInventoryStatusResponse>` };
  };
}
const revised = () => sent.find((s) => s.call === 'ReviseInventoryStatus');

before(() => {
  try { fs.unlinkSync(DB_PATH); } catch {}
  db = openDb();
  const ins = db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings
    (listing_id, sku, title, price_cents, quantity, available_qty, sold_qty, listing_type, state, created_via, item_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const it = db.prepare(`INSERT INTO inventory_items (game,name,sku,quantity,status,created_at,updated_at)
                         VALUES ('pokemon','Wailord','AAC-084',1,'in_stock',datetime('now'),datetime('now'))`).run();
  ins.run('9001', 'AAC-084', 'Wailord', 3248, 3, 1, 2, 'FixedPriceItem', 'active', 'manual', Number(it.lastInsertRowid));
  ins.run('9002', 'BK-PKM-1', 'Ours', 498, 1, 1, 0, 'FixedPriceItem', 'active', 'tool', null);
});
afterEach(() => { globalThis.fetch = realFetch; });
after(() => { try { fs.unlinkSync(DB_PATH); } catch {} });

describe('buildReviseInventoryStatusInner', () => {
  it('sends the documented child order, and only the fields given', () => {
    const x = buildReviseInventoryStatusInner({ itemId: '9001', priceCents: 3248, availableQty: 2 });
    assert.match(x, /<InventoryStatus><ItemID>9001<\/ItemID><Quantity>2<\/Quantity><StartPrice>32\.48<\/StartPrice><\/InventoryStatus>/);
    assert.doesNotMatch(buildReviseInventoryStatusInner({ itemId: '9001', priceCents: 100 }), /<Quantity>/);
    assert.doesNotMatch(buildReviseInventoryStatusInner({ itemId: '9001', availableQty: 4 }), /<StartPrice>/);
  });
});

describe('reviseTradingListing — what it sends', () => {
  it('sends the AVAILABLE quantity, never the total', async () => {
    // Live: total 3, sold 2 → 1 available. Asking for 4 available must send 4, not 6.
    stub({ item: liveItem({ total: 3, sold: 2 }) });
    const r = await reviseTradingListing(ENV, db, { listingId: '9001', availableQty: 4 });
    assert.equal(r.ok, true);
    assert.match(revised().body, /<Quantity>4<\/Quantity>/, 'eBay re-adds the sold count itself');
    assert.doesNotMatch(revised().body, /<Quantity>6<\/Quantity>/);
  });

  it('preflights and verifies against eBay, not against our mirror', async () => {
    stub();
    await reviseTradingListing(ENV, db, { listingId: '9001', priceCents: 3000 });
    const calls = sent.map((s) => s.call);
    assert.deepEqual(calls, ['GetItem', 'ReviseInventoryStatus', 'GetItem'], 'read, write, read back');
  });

  it('writes eBay\'s numbers back to the mirror and the linked stock row', async () => {
    stub({ item: liveItem({ total: 7, sold: 2, price: '30.00' }) });
    const r = await reviseTradingListing(ENV, db, { listingId: '9001', availableQty: 5 });
    assert.equal(r.after.available_qty, 5);
    const row = db.prepare("SELECT * FROM ebay_seller_listings WHERE listing_id='9001'").get();
    assert.equal(row.available_qty, 5);
    assert.equal(row.quantity, 7, 'the mirror keeps eBay\'s total too');
    assert.equal(db.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(row.item_id).quantity, 5, 'the shelf count follows');
  });
});

describe('reviseTradingListing — what it refuses', () => {
  const refuses = async (args, re) => {
    const r = await reviseTradingListing(ENV, db, args);
    assert.equal(r.ok, false, 'should have refused');
    assert.match(r.error, re);
    assert.equal(revised(), undefined, 'nothing may be sent to eBay on a refusal');
    return r;
  };

  it('refuses a listing the TOOL published — wrong API entirely', async () => {
    stub();
    const r = await refuses({ listingId: '9002', priceCents: 500 }, /Inventory API, not Trading/);
    assert.equal(r.code, 'wrong_api');
    assert.equal(sent.length, 0, 'refused before even reading eBay');
  });

  it('refuses an auction', async () => {
    stub({ item: liveItem({ type: 'Chinese' }) });
    await refuses({ listingId: '9001', priceCents: 3000 }, /fixed-price/);
  });

  it('refuses a listing that is no longer active', async () => {
    stub({ item: liveItem({ status: 'Completed' }) });
    await refuses({ listingId: '9001', priceCents: 3000 }, /Completed/);
  });

  it('refuses quantity 0 rather than pretending it ends the listing', async () => {
    stub();
    const r = await refuses({ listingId: '9001', availableQty: 0 }, /will not accept a quantity of 0/);
    assert.equal(r.code, 'qty_zero');
  });

  it('refuses a fat-fingered price, and takes it with force', async () => {
    stub({ item: liveItem({ price: '2500.00' }) });
    const r = await refuses({ listingId: '9001', priceCents: 2500 }, new RegExp(PRICE_SANITY_MULTIPLE + '×'));
    assert.equal(r.code, 'price_sanity');
    stub({ item: liveItem({ price: '2500.00' }) });
    assert.equal((await reviseTradingListing(ENV, db, { listingId: '9001', priceCents: 2500, force: true })).ok, true);
  });

  it('refuses an unknown listing and an empty change', async () => {
    stub();
    await refuses({ listingId: 'nope', priceCents: 100 }, /not in the mirror/);
    stub();
    await refuses({ listingId: '9001' }, /nothing to change/);
  });

  it('surfaces an eBay rejection instead of claiming success', async () => {
    stub({ reviseAck: 'Failure', reviseBody: '<Errors><LongMessage>Quantity must be greater than 0</LongMessage><SeverityCode>Error</SeverityCode></Errors>' });
    const r = await reviseTradingListing(ENV, db, { listingId: '9001', availableQty: 2 });
    assert.equal(r.ok, false);
    assert.match(r.error, /Quantity must be greater than 0/);
  });
});
