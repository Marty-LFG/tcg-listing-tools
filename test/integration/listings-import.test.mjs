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
const { importSellerListings, linkMirrorListings, resolveMirrorImages } = await import('../../lib/listings.mjs');

const ENV = { EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y', EBAY_REFRESH_TOKEN: 'fake' };
const realFetch = globalThis.fetch;
let db, live = [];

const activeItem = (l) => `<Item><ItemID>${l.id}</ItemID>${l.sku ? `<SKU>${l.sku}</SKU>` : ''}<Title>t ${l.id}</Title>`
  + (l.img ? `<PictureDetails><GalleryURL>${l.img}</GalleryURL></PictureDetails>` : '')
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
const imageOf = (id) => db.prepare('SELECT image_url FROM ebay_seller_listings WHERE listing_id = ?').get(id).image_url;

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

  it('mirrors the listing picture, and a scan that carries none never wipes one', async () => {
    live = [{ id: '1001', sku: 'AAC-084', state: 'active', img: 'https://i.ebayimg.com/1001.jpg' }];
    stub();
    await importSellerListings(ENV, db);
    assert.equal(imageOf('1001'), 'https://i.ebayimg.com/1001.jpg');

    // GetMyeBaySelling does not carry PictureDetails on every item. Silence is not "no picture", and
    // overwriting on it would throw away a thumbnail already paid for with a GetItem.
    live = [{ id: '1001', sku: 'AAC-084', state: 'active' }];
    stub();
    await importSellerListings(ENV, db);
    assert.equal(imageOf('1001'), 'https://i.ebayimg.com/1001.jpg');
  });

  it('backfills the missing pictures with GetItem — active listings only, and asks once', async () => {
    // The state of play: 1001 already has its picture from the import, 1002 has ended and 1003 has
    // sold. Only the two new active ones are worth a Trading call.
    db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,title,state,created_via) VALUES ('1004','no picture yet','active','manual')`).run();
    db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,title,state,created_via) VALUES ('1005','eBay will not say','active','manual')`).run();
    const seen = [];
    globalThis.fetch = async (u, opts = {}) => {
      if (String(u).includes('/oauth2/token')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) };
      const id = (/<ItemID>(\d+)<\/ItemID>/.exec(String(opts.body)) || [])[1];
      seen.push(id);
      return { ok: true, status: 200, text: async () => id === '1005'
        // A listing eBay will not talk about: an ANSWER, and one we must not keep re-asking.
        ? '<GetItemResponse><Ack>Failure</Ack><Errors><LongMessage>Item not available</LongMessage></Errors></GetItemResponse>'
        : `<GetItemResponse><Ack>Success</Ack><Item><PictureDetails><GalleryURL>https://i.ebayimg.com/${id}.jpg</GalleryURL></PictureDetails></Item></GetItemResponse>` };
    };
    const rows = db.prepare('SELECT * FROM ebay_seller_listings ORDER BY listing_id').all();
    const r = await resolveMirrorImages(ENV, db, rows);
    assert.equal(r.pending, 0);
    // 1001 already had one; 1002 (ended) and 1003 (sold) are over and never cost a call.
    assert.deepEqual(seen.sort(), ['1004', '1005']);
    assert.equal(imageOf('1004'), 'https://i.ebayimg.com/1004.jpg');
    assert.equal(imageOf('1005'), null);
    assert.equal(imageOf('1003'), null, 'a sold listing keeps whatever it had — it is not fetched');
    assert.ok(rows.find((x) => x.listing_id === '1004').image_url, 'the rows are updated in place too');

    const again = await resolveMirrorImages(ENV, db, db.prepare('SELECT * FROM ebay_seller_listings').all());
    assert.equal(again.fetched, 0);
    assert.deepEqual(seen.sort(), ['1004', '1005'], 'a listing eBay has answered about is never re-asked');
  });

  it('reports what it did not get to rather than silently capping', async () => {
    db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,title,state,created_via) VALUES ('4001','a','active','manual')`).run();
    db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,title,state,created_via) VALUES ('4002','b','active','manual')`).run();
    globalThis.fetch = async (u) => String(u).includes('/oauth2/token')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) }
      : { ok: true, status: 200, text: async () => '<GetItemResponse><Ack>Success</Ack><Item><PictureDetails><GalleryURL>https://i.ebayimg.com/x.jpg</GalleryURL></PictureDetails></Item></GetItemResponse>' };
    const rows = db.prepare("SELECT * FROM ebay_seller_listings WHERE listing_id IN ('4001','4002')").all();
    const r = await resolveMirrorImages(ENV, db, rows, 1);
    assert.equal(r.fetched, 1);
    assert.equal(r.pending, 1, 'the one it did not reach is reported, not dropped');
  });

  it('links a mirrored listing to a card read out of its title, and refuses the unreadable ones', async () => {
    // The route version of this shipped a bug — SQLite reads a double-quoted empty string as an
    // IDENTIFIER, so every create threw while the UI still reported success. Hence a test.
    const SETS = [{ id: 'sv9', name: 'Journey Together' }, { id: 'swsh11', name: 'Lost Origin' }];
    db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,sku,title,quantity,state,created_via)
                VALUES ('2001','AAC-084','Pokemon Wailord 162/159 Journey Together Illustration Rare Holo EN M/NM',1,'active','manual')`).run();
    db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,sku,title,quantity,state,created_via)
                VALUES ('2002','AAC-090','Pokemon Radiant Gardevoir 069/196 Lost Origin Radiant Rare Holo EN M/NM',1,'active','manual')`).run();
    db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,sku,title,quantity,state,created_via)
                VALUES ('2003','AAC-091','Bulk lot of 100 assorted cards',1,'active','manual')`).run();

    const r = linkMirrorListings(db, [{ listing_id: '2001' }, { listing_id: '2002' }, { listing_id: '2003' }, { listing_id: 'nope' }], SETS);
    assert.equal(r.linked, 2);
    assert.equal(r.created, 1, 'only 2002 is new — 2001 carries a label that already exists in stock');

    // 2001's label matched a stock row that predates identity_key, so it links to THAT row rather
    // than minting a duplicate, and the identity is backfilled onto it.
    const wailord = db.prepare("SELECT * FROM inventory_items WHERE sku = 'AAC-084'").get();
    assert.equal(db.prepare("SELECT COUNT(*) c FROM inventory_items WHERE sku = 'AAC-084'").get().c, 1, 'no duplicate row');
    assert.equal(wailord.identity_key, 'sv9-162', 'identity backfilled from the title');
    assert.equal(db.prepare("SELECT item_id FROM ebay_seller_listings WHERE listing_id='2001'").get().item_id, wailord.id);
    assert.equal(r.skipped.length, 2);
    assert.ok(r.skipped.some((s) => s.listing_id === '2003' && /identity/.test(s.why)), 'an unreadable title is refused, not guessed');
    assert.ok(r.skipped.some((s) => s.listing_id === 'nope' && /mirror/.test(s.why)));

    const made = db.prepare("SELECT * FROM inventory_items WHERE identity_key = 'swsh11-69'").get();
    assert.equal(made.name, 'Radiant Gardevoir');
    assert.equal(made.set_name, 'Lost Origin');
    assert.equal(made.number, '069/196');
    assert.equal(made.sku, 'AAC-090', 'the eBay custom label becomes the stock label');
    assert.equal(made.channel_status, 'active');
    assert.equal(made.ebay_listing_id, '2002');
    assert.equal(db.prepare("SELECT item_id FROM ebay_seller_listings WHERE listing_id='2002'").get().item_id, made.id);
  });

  it('a listing with no custom label still gets a usable stock label', () => {
    db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,sku,title,quantity,state,created_via)
                VALUES ('2004',NULL,'Pokemon Wailord 162/159 Journey Together Holo EN M/NM',1,'active','manual')`).run();
    linkMirrorListings(db, [{ listing_id: '2004' }], [{ id: 'sv9', name: 'Journey Together' }]);
    const made = db.prepare("SELECT sku FROM inventory_items WHERE ebay_listing_id = '2004'").get();
    assert.equal(made.sku, 'EBAY-2004', 'sku is NOT NULL, so it falls back to the eBay item id');
  });

  it('linking the same listing twice does not create a second stock row', () => {
    const before = db.prepare('SELECT COUNT(*) c FROM inventory_items').get().c;
    linkMirrorListings(db, [{ listing_id: '2002' }], [{ id: 'swsh11', name: 'Lost Origin' }]);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM inventory_items').get().c, before);
  });

  it('never issues a label that is on an eBay listing but not in stock', async () => {
    // Most of this seller's labels live ONLY on hand-made listings. A stock-only check happily
    // re-issued one that was on a live listing — which is how AAC-088 came up as "next" while a
    // hand-made listing already carried it.
    const { nextStockLabel, seedStockLabels, labelTaken } = await import('../../lib/inventory.mjs');
    db.prepare(`INSERT OR REPLACE INTO ebay_seller_listings (listing_id,sku,title,state,created_via)
                VALUES ('3001','AAC-088','Pokemon Fan Rotom 250/217 Ascended Heroes',' active','manual')`).run();
    assert.equal(labelTaken(db, 'AAC-088'), true, 'a label on an eBay listing is taken');
    assert.equal(labelTaken(db, 'AAC-999'), false);
    seedStockLabels(db, 285);                       // last issued AAC-087, so AAC-088 is next in line
    const issued = nextStockLabel(db);
    assert.notEqual(issued, 'AAC-088', 'must skip the label that is on a live eBay listing');
    assert.equal(labelTaken(db, issued), false, 'and whatever it does issue must be free: ' + issued);
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
