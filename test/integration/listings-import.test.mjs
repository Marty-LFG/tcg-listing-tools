// test/integration/listings-import.test.mjs — importing the seller's whole eBay shop, hand-made
// listings included. Runs against a throwaway tracker DB with global fetch stubbed.
//
// The ended-sweep here is the dangerous part: get it wrong and one import marks every live listing in
// the shop as ended. The first version did exactly that, because it compared SQLite's
// "YYYY-MM-DD HH:MM:SS" against a JS ISO string and a space sorts before "T".
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DB_PATH = path.join(os.tmpdir(), 'tcg-import-test-' + process.pid + '.db');
process.env.TCG_TRACKER_DB = DB_PATH;

const { openDb } = await import('../../lib/db.mjs');
const { importSellerListings } = await import('../../lib/listings.mjs');

const ENV = { EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y', EBAY_REFRESH_TOKEN: 'fake' };
const realFetch = globalThis.fetch;
let db, live = [];

const activeItem = (l) => `<Item><ItemID>${l.id}</ItemID>${l.sku ? `<SKU>${l.sku}</SKU>` : ''}<Title>t ${l.id}</Title>`
  + `<Quantity>1</Quantity><SellingStatus><CurrentPrice currencyID="AUD">4.98</CurrentPrice><QuantitySold>0</QuantitySold></SellingStatus></Item>`;
const soldItem = (l) => `<OrderTransaction><Transaction><Item><ItemID>${l.id}</ItemID><SKU>${l.sku}</SKU><Title>s</Title>`
  + `<SellingStatus><QuantitySold>1</QuantitySold></SellingStatus></Item></Transaction></OrderTransaction>`;

function stub(pages = 1) {
  globalThis.fetch = async (u) => String(u).includes('/oauth2/token')
    ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) }
    : { ok: true, status: 200, text: async () => `<GetMyeBaySellingResponse><Ack>Success</Ack>
        <ActiveList><PaginationResult><TotalNumberOfPages>${pages}</TotalNumberOfPages></PaginationResult>
          <ItemArray>${live.filter((l) => l.state === 'active').map(activeItem).join('')}</ItemArray></ActiveList>
        <SoldList><ItemArray>${live.filter((l) => l.state === 'sold').map(soldItem).join('')}</ItemArray></SoldList>
        </GetMyeBaySellingResponse>` };
}

before(() => {
  try { fs.unlinkSync(DB_PATH); } catch {}
  db = openDb();
  db.prepare(`INSERT INTO inventory_items (game,name,set_name,number,sku,quantity,status,created_at,updated_at)
              VALUES ('pokemon','Wailord','Journey Together','162/159','AAC-084',1,'in_stock',datetime('now'),datetime('now'))`).run();
});
afterEach(() => { globalThis.fetch = realFetch; });
after(() => { try { fs.unlinkSync(DB_PATH); } catch {} });

const rowsNow = () => Object.fromEntries(db.prepare('SELECT listing_id, sku, state, created_via, item_id FROM ebay_seller_listings').all()
  .map((r) => [r.listing_id, r]));

describe('importSellerListings', () => {
  it('mirrors the shop and links a listing whose custom label matches stock', async () => {
    live = [{ id: '1001', sku: 'AAC-084', state: 'active' }, { id: '1002', sku: null, state: 'active' },
      { id: '1003', sku: 'AAB-050', state: 'sold' }];
    stub();
    const r = await importSellerListings(ENV, db);
    assert.equal(r.ok, true);
    assert.equal(r.imported, 3);
    assert.equal(r.manual, 3, 'none of these came from this tool');
    assert.equal(r.linked, 1, 'AAC-084 matches a stock row');
    assert.equal(r.ended, 0, 'a first import must never mark live listings as ended');

    const rows = rowsNow();
    assert.equal(rows['1001'].state, 'active');
    assert.ok(rows['1001'].item_id, 'linked to the stock row by custom label');
    assert.equal(rows['1002'].sku, null, 'a listing with no custom label is still mirrored');
    assert.equal(rows['1002'].state, 'active');
    assert.equal(rows['1003'].state, 'sold');
  });

  it('ends exactly the listing that dropped off eBay, and nothing else', async () => {
    live = live.filter((l) => l.id !== '1002');
    stub();
    const r = await importSellerListings(ENV, db);
    assert.equal(r.ended, 1);
    const rows = rowsNow();
    assert.equal(rows['1002'].state, 'ended');
    assert.equal(rows['1001'].state, 'active', 'the surviving listing must stay active');
  });

  it('is safely re-runnable — no duplicate rows', async () => {
    stub();
    await importSellerListings(ENV, db);
    await importSellerListings(ENV, db);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ebay_seller_listings').get().c, 3);
  });

  it('a truncated scan never ends anything, because "not seen" only means "not reached"', async () => {
    live = [{ id: '1001', sku: 'AAC-084', state: 'active' }];   // 1002/1003 absent from the response
    stub(99);                                                    // claims 99 pages, so the scan truncates
    const r = await importSellerListings(ENV, db);
    assert.equal(r.truncated, true);
    assert.equal(r.ended, 0, 'a partial scan must not mass-end the shop');
  });

  it('reports an eBay failure without touching the mirror', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM ebay_seller_listings').get().c;
    globalThis.fetch = async (u) => String(u).includes('/oauth2/token')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) }
      : { ok: true, status: 200, text: async () => '<GetMyeBaySellingResponse><Ack>Failure</Ack><Errors><LongMessage>Token expired</LongMessage></Errors></GetMyeBaySellingResponse>' };
    const r = await importSellerListings(ENV, db);
    assert.equal(r.ok, false);
    assert.match(r.error, /Token expired/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ebay_seller_listings').get().c, before);
  });
});
