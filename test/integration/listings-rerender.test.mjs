// test/integration/listings-rerender.test.mjs — re-rendering a LIVE tool listing's description
// (rerenderDescriptions, POST /api/listings/rerender-descriptions), 2026-10-18.
//
// THE FAILURE THIS FIXES. A description is frozen at publish. When the letter band's policy moved from a
// A$1.70 untracked letter to A$5.85 tracked, every listing already up kept quoting the old services: an
// INAD claim on each (GR6). The fix rebuilds the description with today's builder and sends back ONLY
// that. The contract pinned here is the dangerous half: nothing but listingDescription may change on the
// offer, because updateOffer is a full replace and re-deriving the rest from the stock row would move
// price, quantity or policies on a live listing.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { rerenderDescriptions, postageSectionText, postageBlockRange, splicePostageBlock } from '../../lib/listings.mjs';
import { offerUpdateBody } from '../../lib/channels/ebay-inventory-api.mjs';
import { testEbayConfig, TEST_BAND_POLICY } from '../helpers/ebay-config.mjs';

// The letter band as it stands on the live account since September 2026: A$5.85 tracked, with the
// parcel and Express options the policy also offers.
function liveCfg() {
  const cfg = testEbayConfig();
  cfg.shipping.bands[0] = { ...cfg.shipping.bands[0], costCents: 585, copy: 'tracked', serviceCode: 'AU_AusPostStandardLetterWithTracking',
    services: [
      { code: 'AU_AusPostStandardLetterWithTracking', label: 'Tracked letter', costCents: 585, sortOrder: 1 },
      { code: 'AU_Regular', label: 'Tracked parcel', costCents: 826, sortOrder: 2 },
    ] };
  return cfg;
}

const ENV = { EBAY_REFRESH_TOKEN: 'fake' };
// The card-details marker stands for everything a publish carried that the stock row may no longer hold
// (the first live dry run lost an Illustrator line to a whole fresh render). It must come back untouched.
const KEEP = '<tr><td>Illustrator</td><td>Gemi</td></tr>';
const OLD_POSTAGE = '<table>' + KEEP + '</table><div>Postage &amp; protection</div><p>Ships in a penny sleeve and toploader inside a rigid mailer. '
  + 'Postage is $1.70 anywhere in Australia, sent by regular Australia Post letter. There\'s no tracking.</p>'
  + '<p>From a smoke-free home. Fast dispatch. Thanks for looking.</p>';
let db, tmpDir, itemId;
let offers = {};
let puts = [];
const realFetch = globalThis.fetch;
function resp(status, json) { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(json || {}) }; }

function liveOffer(over = {}) {
  return {
    offerId: 'OFF-1', sku: 'AAA-001', marketplaceId: 'EBAY_AU', format: 'FIXED_PRICE', status: 'PUBLISHED',
    availableQuantity: 1, categoryId: '183454', listingDuration: 'GTC', merchantLocationKey: 'tcg-au-1',
    listingDescription: OLD_POSTAGE,
    listingPolicies: { paymentPolicyId: 'PAY', returnPolicyId: 'RET', fulfillmentPolicyId: TEST_BAND_POLICY.letter, eBayPlusIfEligible: false },
    pricingSummary: { price: { value: '4.98', currency: 'AUD' } },
    storeCategoryNames: ['/Trading Card Games/Pokemon'],
    listing: { listingId: '111', listingStatus: 'ACTIVE', soldQuantity: 0 },
    ...over,
  };
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-rerender-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    const m = u.match(/\/offer\/([^/?]+)$/);
    if (m && (!init.method || init.method === 'GET')) return offers[m[1]] ? resp(200, offers[m[1]]) : resp(404, { errors: [{ errorId: 25713 }] });
    if (m && init.method === 'PUT') {
      const body = JSON.parse(init.body);
      puts.push({ id: m[1], body });
      offers[m[1]] = { ...offers[m[1]], listingDescription: body.listingDescription };
      return resp(204, {});
    }
    return resp(404, { errors: [{ errorId: 1, message: 'unstubbed ' + u }] });
  };
});
after(() => { globalThis.fetch = realFetch; try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(() => {
  puts = [];
  offers = { 'OFF-1': liveOffer() };
  db.exec('DELETE FROM listing_pushes; DELETE FROM ebay_listings; DELETE FROM inventory_items;');
  itemId = db.prepare(`INSERT INTO inventory_items (sku, game, name, set_name, number, condition, target_price_cents, quantity, status, channel_status, ebay_offer_id, ebay_listing_id)
    VALUES ('AAA-001','pokemon','Pikachu','Surging Sparks','057','Ungraded, Near Mint',498,1,'listed','active','OFF-1','111')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO ebay_listings (sku, marketplace, offer_id, listing_id, item_id, listing_status) VALUES ('AAA-001','EBAY_AU','OFF-1','111',?,'ACTIVE')`).run(itemId);
});

describe('rerenderDescriptions', () => {
  it('a dry run reports the before and after and writes nothing to eBay', async () => {
    const r = await rerenderDescriptions(ENV, db, liveCfg(), {});
    assert.equal(r.apply, false);
    assert.equal(r.considered, 1);
    assert.equal(r.changed, 1);
    assert.equal(puts.length, 0, 'a dry run never calls updateOffer');
    const row = r.rows[0];
    assert.equal(row.band, 'letter');
    assert.match(row.postage_before, /\$1\.70/);
    assert.match(row.postage_after, /Postage is \$5\.85/, 'the band the live price falls in, as it stands today');
    assert.match(row.postage_after, /Tracked parcel/, 'with the options the policy offers');
    assert.ok(!/\$1\.70/.test(row.postage_after), 'the retired untracked letter is gone');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM listing_pushes`).get().n, 0);
  });

  it('applied, it changes ONLY the description and sends every other field back as eBay held it', async () => {
    const before = JSON.parse(JSON.stringify(offers['OFF-1']));
    const r = await rerenderDescriptions(ENV, db, liveCfg(), { apply: true });
    assert.equal(r.applied, 1);
    assert.equal(puts.length, 1);
    const sent = puts[0].body;
    for (const k of ['offerId', 'status', 'listing']) assert.ok(!(k in sent), `${k} is read-only and must not be sent`);
    const expected = offerUpdateBody(before, { listingDescription: sent.listingDescription });
    assert.deepEqual(sent, expected, 'price, quantity, policies, store categories: exactly as read');
    assert.notEqual(sent.listingDescription, before.listingDescription);
    assert.equal(r.rows[0].verified, true, 'read back what eBay stored');
    const audit = db.prepare(`SELECT action, status FROM listing_pushes`).all().map((x) => ({ ...x }));
    assert.deepEqual(audit, [{ action: 'rerender', status: 'ok' }]);
  });

  it('is a no-op once the description is current', async () => {
    await rerenderDescriptions(ENV, db, liveCfg(), { apply: true });
    puts = [];
    const r = await rerenderDescriptions(ENV, db, liveCfg(), { apply: true });
    assert.equal(r.changed, 0);
    assert.equal(puts.length, 0);
  });

  it('skips a listing whose policy is not the one its live price\'s band pins', async () => {
    offers['OFF-1'] = liveOffer({ listingPolicies: { paymentPolicyId: 'PAY', returnPolicyId: 'RET', fulfillmentPolicyId: TEST_BAND_POLICY.tracked } });
    const r = await rerenderDescriptions(ENV, db, liveCfg(), { apply: true });
    assert.equal(r.rows[0].skipped, 'policy_mismatch');
    assert.equal(puts.length, 0);
  });

  it('takes the band from the LIVE price, not the stock row', async () => {
    offers['OFF-1'] = liveOffer({ pricingSummary: { price: { value: '60.00', currency: 'AUD' } },
      listingPolicies: { paymentPolicyId: 'PAY', returnPolicyId: 'RET', fulfillmentPolicyId: TEST_BAND_POLICY.tracked } });
    const r = await rerenderDescriptions(ENV, db, liveCfg(), {});
    assert.equal(r.rows[0].band, 'tracked');
    assert.equal(r.rows[0].price_cents, 6000);
  });

  it('leaves hidden or sold-out listings and hand-written descriptions alone', async () => {
    offers['OFF-1'] = liveOffer({ availableQuantity: 0 });
    assert.equal((await rerenderDescriptions(ENV, db, liveCfg(), { apply: true })).rows[0].skipped, 'nothing_available');
    offers['OFF-1'] = liveOffer();
    db.prepare(`UPDATE inventory_items SET desc_override = '<p>my own words</p>' WHERE id = ?`).run(itemId);
    assert.equal((await rerenderDescriptions(ENV, db, liveCfg(), { apply: true })).rows[0].skipped, 'custom_description');
    assert.equal(puts.length, 0);
  });
});

describe('the splice: only the postage block moves', () => {
  it('keeps every byte outside the block, including facts a fresh render would lose', async () => {
    const r = await rerenderDescriptions(ENV, db, liveCfg(), { apply: true });
    const sent = puts[0].body.listingDescription;
    assert.ok(sent.startsWith('<table>' + KEEP + '</table>'), 'the card details come back as they were');
    assert.ok(sent.endsWith('<p>From a smoke-free home. Fast dispatch. Thanks for looking.</p>'), 'so does the footer');
    assert.match(postageSectionText(sent), /Postage is \$5\.85/);
    assert.equal(r.applied, 1);
  });
  it('replaces an old options table and its note together', () => {
    const old = '<div>Postage &amp; protection</div>\n<p style="margin:0;">Postage is $1.70.</p>\n'
      + '<table><tbody><tr><td>Regular letter</td><td>$1.70</td></tr></tbody></table><p style="x">You pick the one you want at checkout.</p>\n'
      + '</div><p>footer</p>';
    const fresh = '<div>Postage &amp; protection</div><p>Postage is $5.85.</p><table><tbody><tr><td>Tracked letter</td><td>$5.85</td></tr></tbody></table><p>You pick the one you want at checkout.</p></div>';
    const out = splicePostageBlock(old, fresh);
    assert.ok(!out.includes('Regular letter') && !out.includes('$1.70'), out);
    assert.match(out, /Tracked letter/);
    assert.ok(out.endsWith('\n</div><p>footer</p>'));
    assert.equal((out.match(/You pick/g) || []).length, 1, 'one note, not two');
  });
  it('skips a description it cannot find the block in, rather than guessing', async () => {
    offers['OFF-1'] = liveOffer({ listingDescription: '<p>Free postage within Australia.</p>' });
    const r = await rerenderDescriptions(ENV, db, liveCfg(), { apply: true });
    assert.equal(r.rows[0].skipped, 'no_postage_block');
    assert.equal(puts.length, 0);
    assert.equal(postageBlockRange('<div>Postage &amp; protection</div><p>Thanks!</p>'), null, 'a paragraph that does not mention postage is not the block');
  });
});

describe('postageSectionText', () => {
  it('reads the postage block a buyer sees, up to the footer', () => {
    const t = postageSectionText(OLD_POSTAGE);
    assert.match(t, /^Postage & protection/);
    assert.match(t, /\$1\.70/);
    assert.ok(!/smoke-free/.test(t));
  });
  it('answers null when there is no postage text at all', () => {
    assert.equal(postageSectionText('<p>Pikachu</p>'), null);
  });
});
