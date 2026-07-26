// test/unit/ebay-seller-skus.test.mjs — reading every custom label off the seller's eBay listings,
// which is how the AAA-001 counter continues an existing shelf instead of restarting on top of it
// (AGENTS.md §16b). Offline: global fetch is stubbed.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildGetMyeBaySellingInner, getSellerSkus } from '../../lib/ebay-trading.mjs';
import { maxLabelSeq, labelFor } from '../../lib/sku-labels.mjs';

const ENV = { EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y', EBAY_REFRESH_TOKEN: 'fake' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stub(pages) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/identity/v1/oauth2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) };
    }
    const page = parseInt(/<PageNumber>(\d+)<\/PageNumber>/.exec(String(opts.body))[1], 10);
    calls.push(page);
    return { ok: true, status: 200, text: async () => pages[page - 1] };
  };
  return calls;
}
const listXml = (skus, totalPages) => `<GetMyeBaySellingResponse><Ack>Success</Ack>
  <ActiveList><PaginationResult><TotalNumberOfPages>${totalPages}</TotalNumberOfPages></PaginationResult>
    <ItemArray>${skus.map((s) => `<Item><ItemID>1</ItemID><SKU>${s}</SKU></Item>`).join('')}</ItemArray>
  </ActiveList></GetMyeBaySellingResponse>`;

describe('buildGetMyeBaySellingInner', () => {
  it('asks for sold and unsold as well as active', () => {
    // Labels are never reused, so the highest one may sit on a card that has already sold. Seeding
    // from the active list alone would re-issue it.
    const x = buildGetMyeBaySellingInner();
    for (const l of ['ActiveList', 'SoldList', 'UnsoldList']) assert.match(x, new RegExp('<' + l + '><Include>true</Include>'));
  });
  it('clamps the page size to eBay\'s 200 and never asks for page 0', () => {
    assert.match(buildGetMyeBaySellingInner({ perPage: 5000 }), /<EntriesPerPage>200<\/EntriesPerPage>/);
    assert.match(buildGetMyeBaySellingInner({ page: 0 }), /<PageNumber>1<\/PageNumber>/);
  });
});

describe('getSellerSkus', () => {
  it('collects labels across pages and stops at the last one', async () => {
    const calls = stub([listXml(['AAC-081', 'AAC-082'], 2), listXml(['AAC-084', 'BK-PKM-000010'], 2)]);
    const r = await getSellerSkus(ENV);
    assert.equal(r.ok, true);
    assert.deepEqual(calls, [1, 2], 'exactly two pages, no needless third call');
    assert.deepEqual(r.skus.sort(), ['AAC-081', 'AAC-082', 'AAC-084', 'BK-PKM-000010']);
    assert.equal(r.truncated, false);
  });

  it('feeds the seed: the highest label wins and our own BK-* labels are ignored', async () => {
    stub([listXml(['BK-PKM-000010', 'AAC-084', 'AAB-012'], 1)]);
    const r = await getSellerSkus(ENV);
    assert.equal(labelFor(maxLabelSeq(r.skus)), 'AAC-084');
  });

  it('de-duplicates the same label appearing in two lists', async () => {
    stub([listXml(['AAC-084', 'AAC-084'], 1)]);
    assert.deepEqual((await getSellerSkus(ENV)).skus, ['AAC-084']);
  });

  it('reports truncation instead of silently capping', async () => {
    const many = Array.from({ length: 4 }, () => listXml(['AAA-001'], 99));
    stub(many);
    const r = await getSellerSkus(ENV, { maxPages: 3 });
    assert.equal(r.truncated, true, 'the caller must be able to say the scan was partial');
    assert.equal(r.calls, 3);
  });

  it('surfaces an eBay failure with whatever it has, rather than throwing', async () => {
    globalThis.fetch = async (url) => String(url).includes('/oauth2/token')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) }
      : { ok: true, status: 200, text: async () => '<GetMyeBaySellingResponse><Ack>Failure</Ack><Errors><ShortMessage>Auth</ShortMessage><LongMessage>Token expired</LongMessage></Errors></GetMyeBaySellingResponse>' };
    const r = await getSellerSkus(ENV);
    assert.equal(r.ok, false);
    assert.match(r.error, /Token expired/);
  });
});
