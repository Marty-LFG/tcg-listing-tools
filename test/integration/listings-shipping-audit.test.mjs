// test/integration/listings-shipping-audit.test.mjs — the READ-ONLY shipping check (2026-10-18).
//
// 230 live tool listings carried no fulfillmentPolicyId on their offer: postage set per listing in
// Seller Hub, policy detached. auditListingShipping asks eBay what each one actually offers at checkout
// (GetItem) and classifies it against its band. Pinned: the parser reads every DOMESTIC row and the
// attached policy, the four verdicts land where they should, and the whole thing never writes.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { auditListingShipping } from '../../lib/listings.mjs';
import { parseItemShipping } from '../../lib/ebay-trading.mjs';
import { testEbayConfig, TEST_BAND_POLICY } from '../helpers/ebay-config.mjs';

const ENV = { EBAY_REFRESH_TOKEN: 'fake' };
const realFetch = globalThis.fetch;
let db, tmpDir;
let items = {}, offers = {}, writes = [];
function resp(status, body, json = true) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (json ? JSON.stringify(body || {}) : body) };
}
const opt = (code, cost, prio) => `<ShippingServiceOptions><ShippingService>${code}</ShippingService>`
  + `<ShippingServiceCost currencyID="AUD">${(cost / 100).toFixed(2)}</ShippingServiceCost><ShippingServicePriority>${prio}</ShippingServicePriority></ShippingServiceOptions>`;
function getItemXml({ price = 9.98, services = [], profile = null, intl = true } = {}) {
  return `<?xml version="1.0"?><GetItemResponse><Ack>Success</Ack><Item>`
    + `<SellingStatus><CurrentPrice currencyID="AUD">${price}</CurrentPrice><ListingStatus>Active</ListingStatus></SellingStatus>`
    + `<ShippingDetails><ShippingType>Flat</ShippingType>${services.map(([c, k], i) => opt(c, k, i + 1)).join('')}`
    + (intl ? `<InternationalShippingServiceOption><ShippingService>AU_StandardInternational</ShippingService><ShippingServiceCost currencyID="AUD">20.00</ShippingServiceCost></InternationalShippingServiceOption>` : '')
    + `</ShippingDetails>`
    + (profile ? `<SellerProfiles><SellerShippingProfile><ShippingProfileID>${profile}</ShippingProfileID><ShippingProfileName>Band</ShippingProfileName></SellerShippingProfile></SellerProfiles>` : '')
    + `</Item></GetItemResponse>`;
}

// The live-shaped letter band: A$5.85 tracked, with the parcel option the policy also offers.
function liveCfg() {
  const cfg = testEbayConfig();
  cfg.shipping.bands[0] = { ...cfg.shipping.bands[0], costCents: 585, copy: 'tracked',
    services: [{ code: 'AU_AusPostStandardLetterWithTracking', label: 'Tracked letter', costCents: 585 }, { code: 'AU_Regular', label: 'Tracked parcel', costCents: 826 }] };
  return cfg;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-shipaudit-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    if (u.includes('/ws/api.dll')) {
      const call = (init.headers && (init.headers['X-EBAY-API-CALL-NAME'] || init.headers['x-ebay-api-call-name'])) || '';
      if (call !== 'GetItem') { writes.push('trading:' + call); return resp(500, 'refused', false); }
      const id = (String(init.body).match(/<ItemID>([^<]+)<\/ItemID>/) || [])[1];
      return items[id] ? resp(200, items[id], false) : resp(200, '<GetItemResponse><Ack>Failure</Ack><Errors><ShortMessage>gone</ShortMessage></Errors></GetItemResponse>', false);
    }
    const m = u.match(/\/offer\/([^/?]+)$/);
    if (m && method === 'GET') return offers[m[1]] ? resp(200, offers[m[1]]) : resp(404, { errors: [{ errorId: 25713 }] });
    writes.push(method + ' ' + u);
    return resp(404, {});
  };
});
after(() => { globalThis.fetch = realFetch; try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

function seed(n, { sku, listingId }) {
  const id = db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, channel_status, ebay_offer_id, ebay_listing_id)
                         VALUES (?, 'pokemon', 'Card', 1, 'listed', 'active', ?, ?)`).run(sku, 'OFF-' + n, listingId).lastInsertRowid;
  db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, listing_status) VALUES (?, 'EBAY_AU', ?, ?, ?, 'ACTIVE')`)
    .run(sku, 'OFF-' + n, listingId, id);
}
beforeEach(() => {
  writes = []; items = {}; offers = {};
  db.exec('DELETE FROM ebay_listings; DELETE FROM inventory_items;');
  const pol = (p) => ({ listingPolicies: p ? { fulfillmentPolicyId: p } : { paymentPolicyId: 'PAY' } });
  seed(1, { sku: 'A-LINKED', listingId: '101' }); offers['OFF-1'] = pol(TEST_BAND_POLICY.letter);
  items['101'] = getItemXml({ services: [['AU_AusPostStandardLetterWithTracking', 585], ['AU_Regular', 826]], profile: TEST_BAND_POLICY.letter });
  seed(2, { sku: 'B-SAME', listingId: '102' }); offers['OFF-2'] = pol(null);
  items['102'] = getItemXml({ services: [['AU_AusPostStandardLetterWithTracking', 585], ['AU_Regular', 826]] });
  seed(3, { sku: 'C-AMOUNT', listingId: '103' }); offers['OFF-3'] = pol(null);
  items['103'] = getItemXml({ services: [['AU_AusPostStandardLetterWithTracking', 585]] });
  seed(4, { sku: 'D-DIFFERS', listingId: '104' }); offers['OFF-4'] = pol(null);
  items['104'] = getItemXml({ services: [['AU_Regular', 826]] });
});

describe('parseItemShipping', () => {
  it('reads every domestic row in priority order, leaves international out, and names the policy', () => {
    const s = parseItemShipping(getItemXml({ services: [['AU_AusPostStandardLetterWithTracking', 585], ['AU_Express', 945]], profile: '269598843012' }));
    assert.deepEqual(s.services.map((x) => [x.code, x.cost_cents]), [['AU_AusPostStandardLetterWithTracking', 585], ['AU_Express', 945]]);
    assert.equal(s.profile_id, '269598843012');
    assert.equal(s.price_cents, 998);
    assert.equal(s.listing_status, 'Active');
  });
  it('an absent cost is unknown, never free', () => {
    const s = parseItemShipping('<Item><ShippingDetails><ShippingServiceOptions><ShippingService>AU_Regular</ShippingService></ShippingServiceOptions></ShippingDetails></Item>');
    assert.equal(s.services[0].cost_cents, null);
  });
});

describe('auditListingShipping', () => {
  it('classifies each listing against its band and writes nothing', async () => {
    const r = await auditListingShipping(ENV, db, liveCfg(), {});
    const v = Object.fromEntries(r.rows.map((x) => [x.sku, x.verdict]));
    assert.deepEqual(v, { 'A-LINKED': 'policy_linked', 'B-SAME': 'matches_band', 'C-AMOUNT': 'amount_matches', 'D-DIFFERS': 'differs' });
    assert.deepEqual(writes, [], 'a read-only check');
    const b = r.rows.find((x) => x.sku === 'B-SAME');
    assert.deepEqual(b.services.map((s) => s.label), ['Tracked letter', 'Tracked parcel'], 'labels in the house names');
    assert.equal(b.offer_policy, null);
    assert.ok(Object.keys(r.summary).some((k) => k.startsWith('differs')), 'the summary groups by what is offered');
  });
  it('reports a listing eBay cannot answer for instead of guessing', async () => {
    delete items['104'];
    const r = await auditListingShipping(ENV, db, liveCfg(), { itemIds: [db.prepare(`SELECT item_id FROM ebay_listings WHERE sku='D-DIFFERS'`).get().item_id] });
    assert.equal(r.rows[0].verdict, 'unreadable');
  });
});
