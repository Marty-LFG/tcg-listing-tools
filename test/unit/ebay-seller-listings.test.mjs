// test/unit/ebay-seller-listings.test.mjs — mirroring EVERY listing on the account, hand-made ones
// included. Those are invisible to the Sell Inventory API (eBay KB 5210), so GetMyeBaySelling is the
// only way the tool learns they exist. Keyed on the eBay ItemID because a Trading listing's Custom
// label is optional and eBay allows duplicates of it.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseSellerListings, getSellerListings } from '../../lib/ebay-trading.mjs';

const ENV = { EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y', EBAY_REFRESH_TOKEN: 'fake' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const XML = `<GetMyeBaySellingResponse><Ack>Success</Ack>
 <ActiveList><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult><ItemArray>
   <Item><ItemID>158112049713</ItemID><SKU>AAC-084</SKU>
     <Title>Pokemon Wailord 162/159 Journey Together Illustration Rare Holo EN M/NM</Title>
     <Quantity>1</Quantity><ViewItemURL>https://www.ebay.com.au/itm/158112049713</ViewItemURL>
     <PictureDetails><GalleryURL>https://i.ebayimg.com/00/s/thumb.jpg?set_id=88&amp;x=1</GalleryURL>
       <PictureURL>https://i.ebayimg.com/00/s/full.jpg</PictureURL></PictureDetails>
     <SellingStatus><CurrentPrice currencyID="AUD">32.48</CurrentPrice><QuantitySold>0</QuantitySold></SellingStatus>
   </Item>
   <Item><ItemID>158119929614</ItemID><SKU>BK-PKM-000010</SKU><Title>Pokemon Radiant Gardevoir</Title>
     <Quantity>1</Quantity><StartPrice currencyID="AUD">4.98</StartPrice>
     <SellingStatus><QuantitySold>0</QuantitySold></SellingStatus></Item>
   <Item><ItemID>158000000001</ItemID><Title>No custom label on this one</Title><Quantity>3</Quantity>
     <PictureDetails><PictureURL>https://i.ebayimg.com/00/s/nogallery.jpg</PictureURL></PictureDetails>
     <SellingStatus><CurrentPrice currencyID="AUD">9.95</CurrentPrice><QuantitySold>1</QuantitySold></SellingStatus></Item>
 </ItemArray></ActiveList>
 <SoldList><ItemArray><OrderTransaction><Transaction>
   <Item><ItemID>158000000002</ItemID><SKU>AAB-050</SKU><Title>Sold thing</Title>
     <SellingStatus><CurrentPrice currencyID="AUD">12.00</CurrentPrice><QuantitySold>2</QuantitySold></SellingStatus></Item>
 </Transaction></OrderTransaction></ItemArray></SoldList>
</GetMyeBaySellingResponse>`;

describe('parseSellerListings', () => {
  const rows = parseSellerListings(XML);
  const by = Object.fromEntries(rows.map((r) => [r.listing_id, r]));

  it('reads a hand-made listing in full', () => {
    const w = by['158112049713'];
    assert.equal(w.sku, 'AAC-084', 'the Custom label');
    assert.match(w.title, /Wailord 162\/159/);
    assert.equal(w.price_cents, 3248, 'cents at the edge, per GR3');
    assert.equal(w.currency, 'AUD');
    assert.equal(w.quantity, 1);
    assert.equal(w.state, 'active');
    assert.equal(w.listing_url, 'https://www.ebay.com.au/itm/158112049713');
  });

  it('falls back to StartPrice when a listing has never been revised', () => {
    assert.equal(by['158119929614'].price_cents, 498);
  });

  it('keeps a listing with NO custom label — the ItemID is the key, not the SKU', () => {
    // A hand-made listing does not have to carry a label, and dropping those would silently
    // under-report what is on eBay.
    assert.equal(by['158000000001'].sku, null);
    assert.equal(by['158000000001'].quantity, 3);
    assert.equal(by['158000000001'].sold_qty, 1);
  });

  it('takes the listing picture, gallery thumbnail first, with its URL entity-decoded', () => {
    // An EPS URL carries a query string, so eBay escapes the & — undecoded it is a broken <img>.
    assert.equal(by['158112049713'].image_url, 'https://i.ebayimg.com/00/s/thumb.jpg?set_id=88&x=1');
    // No gallery thumb generated yet: the full-size picture is still the listing's first image.
    assert.equal(by['158000000001'].image_url, 'https://i.ebayimg.com/00/s/nogallery.jpg');
    // Not "this listing has no picture" — this SCAN didn't carry one. The mirror backfills those.
    assert.equal(by['158119929614'].image_url, null);
  });

  it('picks up sold listings from their nested Transaction container', () => {
    assert.equal(by['158000000002'].state, 'sold');
    assert.equal(by['158000000002'].sold_qty, 2);
  });

  it('de-duplicates a listing that appears in two lists, preferring active', () => {
    const dupe = XML.replace('</GetMyeBaySellingResponse>',
      '<UnsoldList><ItemArray><Item><ItemID>158112049713</ItemID><SKU>AAC-084</SKU><Title>x</Title></Item></ItemArray></UnsoldList></GetMyeBaySellingResponse>');
    const r = parseSellerListings(dupe).filter((x) => x.listing_id === '158112049713');
    assert.equal(r.length, 1);
    assert.equal(r[0].state, 'active', 'what matters downstream is whether it is still buyable');
  });

  it('returns nothing rather than throwing on an empty or junk body', () => {
    assert.deepEqual(parseSellerListings(''), []);
    assert.deepEqual(parseSellerListings('<GetMyeBaySellingResponse><Ack>Success</Ack></GetMyeBaySellingResponse>'), []);
  });
});

describe('getSellerListings', () => {
  it('pages and merges, and reports truncation instead of capping silently', async () => {
    const page = (id, total) => `<GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList>
      <PaginationResult><TotalNumberOfPages>${total}</TotalNumberOfPages></PaginationResult>
      <ItemArray><Item><ItemID>${id}</ItemID><SKU>AAC-0${id}</SKU><Title>t</Title><Quantity>1</Quantity></Item></ItemArray>
      </ActiveList></GetMyeBaySellingResponse>`;
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).includes('/oauth2/token')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) };
      const p = parseInt(/<PageNumber>(\d+)<\/PageNumber>/.exec(String(opts.body))[1], 10);
      return { ok: true, status: 200, text: async () => page(90 + p, 9) };
    };
    const r = await getSellerListings(ENV, { maxPages: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.listings.length, 2);
    assert.equal(r.truncated, true);
  });
});
