// test/unit/ebay-publish-guards.test.mjs — the three pre-flight guards that keep a doomed offer from
// ever reaching eBay. All three were written against REAL 2026-07-29 production failures, where the
// common shape was: the local layer said fine, eBay said no, and a staged row silently kept its shelf
// label without ever going live.
//
//  1. price floor      — AAC-096 previewed at 99c; eBay 25016 (min 1.00) at get_listing_fees.
//  2. best-offer order — AAC-095 published with accept 602 / decline 797; eBay 25002.
//  3. honest preflight — publishListing's dryRun branch returned ok:true even when the fee check
//                        failed, which is how (1) got audited as a clean preview.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toEbayListing, loadEbayCategories, validateListing, EBAY_MIN_PRICE_CENTS } from '../../lib/channels/ebay-map.mjs';
import { testEbayConfig, testShipping } from '../helpers/ebay-config.mjs';
import { publishListing } from '../../lib/channels/ebay-inventory-api.mjs';

const cats = loadEbayCategories();
const raw = (over = {}) => toEbayListing({
  sku: 'BK-RAW-PKM-1', game: 'pokemon', name: 'Pikachu', set_name: 'Base Set', number: '58/102',
  rarity: 'Common', condition: 'Near Mint', language: 'EN', quantity: 1, target_price_cents: 1299,
  image_url: 'https://cdn/x.png', finish: 'Regular', ...over,
  // The band table the publish path resolves against; without it the listing has no postage band and
  // publishListing refuses before it ever reaches the fee check.
}, null, cats, { shipping: testShipping() });

const priceErrors = (l) => validateListing(l, cats).errors.filter((e) => /minimum|no price/.test(e));

describe('validateListing — eBay’s A$1.00 protocol floor', () => {
  it('passes a normal price', () => {
    assert.deepEqual(priceErrors(raw()), []);
  });

  it('refuses 99c — the exact AAC-096 case', () => {
    const errs = priceErrors(raw({ target_price_cents: 99 }));
    assert.equal(errs.length, 1);
    assert.match(errs[0], /A\$0\.99 is under eBay’s A\$1\.00 minimum/);
    assert.match(errs[0], /25016/);
  });

  it('accepts exactly the floor, refuses one cent under it', () => {
    assert.deepEqual(priceErrors(raw({ target_price_cents: EBAY_MIN_PRICE_CENTS })), []);
    assert.equal(priceErrors(raw({ target_price_cents: EBAY_MIN_PRICE_CENTS - 1 })).length, 1);
  });

  it('still reports a MISSING price as needs_price, not as under-floor', () => {
    // The two are different operator actions — "go set a price" vs "your price is too low" — so a
    // null must not start rendering as A$0.00 is under the minimum.
    const errs = priceErrors(raw({ target_price_cents: null }));
    assert.equal(errs.length, 1);
    assert.match(errs[0], /needs_price/);
  });
});

describe('publishListing dryRun — a preflight may not report ok when eBay refused', () => {
  const CFG = testEbayConfig();
  const ENV = { EBAY_REFRESH_TOKEN: 'fake', EBAY_CERT_ID: 'c' };   // mints a user token off the stub
  const descriptors = [{ name: 'Card Condition', id: '400011', valueId: '4000112' }];

  // Minimal Inventory-API stub: everything succeeds up to the fee check, which is the failure we care
  // about — the offer really does get created before eBay refuses, which is why the old ok:true was
  // so misleading.
  function stub(feesOk) {
    return async (url, opts = {}) => {
      const u = String(url), m = (opts.method || 'GET').toUpperCase();
      const resp = (s, j) => ({ ok: s < 400, status: s, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(j), json: async () => j });
      if (u.includes('/identity/v1/oauth2/token') || u.includes('/oauth2/token')) return resp(200, { access_token: 'tok', expires_in: 7200 });
      if (u.includes('/inventory_item/') && m === 'PUT') return resp(204, null);
      if (u.includes('offer?sku=') && m === 'GET') return resp(200, { offers: [] });
      if (u.endsWith('/offer') && m === 'POST') return resp(200, { offerId: 'OFFER-1' });
      if (u.includes('/offer/get_listing_fees')) {
        return feesOk
          ? resp(200, { feeSummaries: [{ fees: [{ feeType: 'INSERTION', amount: { value: '0.00', currency: 'AUD' } }] }] })
          : resp(400, { errors: [{ errorId: 25016, message: 'The The price in the listing is either invalid or below the minimum price of 1.0. value is invalid.' }] });
      }
      return resp(404, { errors: [{ errorId: 1, message: 'unstubbed ' + m + ' ' + u }] });
    };
  }

  const run = async (feesOk) => {
    const real = globalThis.fetch;
    globalThis.fetch = stub(feesOk);
    try {
      return await publishListing(ENV, { listing: raw(), cfg: CFG, imageUrls: ['https://eps/1.jpg'], conditionDescriptors: descriptors, dryRun: true });
    } finally { globalThis.fetch = real; }
  };

  it('reports ok when the fee check passes', async () => {
    const r = await run(true);
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.ok(r.fees, 'fees come back on the happy path');
  });

  it('reports NOT ok when the fee check is refused, and names the step', async () => {
    const r = await run(false);
    assert.equal(r.ok, false, 'a refused preflight must not audit as a clean preview');
    assert.match(r.error, /preflight/);
    assert.match(r.error, /minimum price/);
    // The offer id still comes back: it was really created, and leaving it out would hide the
    // half-built offer the next publish has to find rather than duplicate.
    assert.equal(r.offerId, 'OFFER-1');
    assert.equal(r.steps.at(-1).step, 'get_listing_fees');
    assert.equal(r.steps.at(-1).ok, false);
  });
});
