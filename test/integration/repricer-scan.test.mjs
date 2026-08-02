// test/integration/repricer-scan.test.mjs — one read-only scan pass, end to end against a stubbed
// eBay.
//
// The judgement itself is unit-tested in test/unit/repricer-decide.test.mjs. What is proven HERE is
// the wiring: that live eBay fields (postage, Best Offer, variations, promotions) actually reach the
// decision, that every outcome lands in price_checks including the refusals, and — the one that
// matters most — that a "read-only" pass never sends a write.
//
// Env must be set before the modules load: lib/db.mjs and lib/repricer-db.mjs both resolve their
// paths at module scope. Hence the dynamic imports.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TDB = path.join(os.tmpdir(), 'tcg-scan-t-' + process.pid + '.db');
const RDB = path.join(os.tmpdir(), 'tcg-scan-r-' + process.pid + '.db');
const PDB = path.join(os.tmpdir(), 'tcg-scan-p-' + process.pid + '.db');
process.env.TCG_TRACKER_DB = TDB;
process.env.TCG_REPRICER_DB = RDB;
process.env.TCG_POSTSALE_DB = PDB;
const { openDb } = await import('../../lib/db.mjs');
const { openRepricerDb } = await import('../../lib/repricer-db.mjs');
const { openPostsaleDb } = await import('../../lib/postsale-db.mjs');
const { scanListings, inferGame, compsQueryFor, guardrailsFrom } = await import('../../lib/repricer-scan.mjs');

const ENV = { EBAY_APP_ID: 'PRD-x', EBAY_CERT_ID: 'PRD-y', EBAY_REFRESH_TOKEN: 'fake' };
const CFG = { exclude_seller_username: 'omg.its.alcatrazz', guardrails: { min_comparable: 8, min_uplift_pct: 10, min_uplift_aud: 1.0, required_confidence: 'medium', max_increase_pct_per_run: 40, never_decrease: true } };
const realFetch = globalThis.fetch;
let tdb, rdb, pdb, sent = [];

// eBay's GetItem view. The four repricer-relevant blocks are optional so each can be exercised.
function itemXml({ id = '9001', price = '10.00', qty = 3, sold = 0, type = 'FixedPriceItem', status = 'Active',
  title = 'Pokemon Wailord ex 016/084 Pitch Black Double Rare Holo EN M/NM',
  postage = '0.00', shippingType = 'Flat', bestOffer = false, autoAccept = null, minOffer = null,
  promo = false, variations = false } = {}) {
  return `<GetItemResponse><Ack>Success</Ack><Item><ItemID>${id}</ItemID><Title>${title}</Title>
    <ListingType>${type}</ListingType><Quantity>${qty}</Quantity>
    <SellingStatus><CurrentPrice currencyID="AUD">${price}</CurrentPrice><QuantitySold>${sold}</QuantitySold><ListingStatus>${status}</ListingStatus></SellingStatus>
    <ShippingDetails><ShippingType>${shippingType}</ShippingType>${postage == null ? '' : `<ShippingServiceOptions><ShippingService>AU_Regular</ShippingService><ShippingServiceCost currencyID="AUD">${postage}</ShippingServiceCost></ShippingServiceOptions>`}</ShippingDetails>
    <ListingDetails><StartTime>2026-01-01T00:00:00.000Z</StartTime>${autoAccept == null ? '' : `<BestOfferAutoAcceptPrice currencyID="AUD">${autoAccept}</BestOfferAutoAcceptPrice>`}${minOffer == null ? '' : `<MinimumBestOfferPrice currencyID="AUD">${minOffer}</MinimumBestOfferPrice>`}</ListingDetails>
    ${bestOffer ? '<BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>' : ''}
    ${promo ? '<DiscountPriceInfo><PricingTreatment>STP</PricingTreatment></DiscountPriceInfo>' : ''}
    ${variations ? '<Variations><Variation><SKU>a</SKU></Variation></Variations>' : ''}
  </Item></GetItemResponse>`;
}
// A Browse comps page: n listings at `price` delivered, all carrying the collector number so they
// survive the precision filter.
const browseJson = (n, price) => JSON.stringify({
  itemSummaries: Array.from({ length: n }, (_, i) => ({
    itemId: 'v1|' + i, title: 'Pokemon Wailord ex 016/084 Pitch Black Holo',
    price: { value: String(price), currency: 'AUD' },
    shippingOptions: [{ shippingCost: { value: '0.00', currency: 'AUD' } }],
    seller: { username: 'someone-else' }, buyingOptions: ['FIXED_PRICE'],
    condition: 'Used',
  })),
});

function stub({ item = itemXml(), comps = browseJson(20, 12.0), insightsOk = false } = {}) {
  sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/oauth2/token')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) };
    // The comps engine reads these with r.json(), not r.text() — supply both so the duck-type is
    // honest rather than accidentally shaped to whichever one the code happens to call today.
    const body = (s) => ({ ok: true, status: 200, text: async () => s, json: async () => JSON.parse(s) });
    // sold comps: eBay denies this app the scope, so the real system always falls back to asking.
    if (u.includes('marketplace_insights')) {
      sent.push({ call: 'insights' });
      return insightsOk ? body('{"itemSales":[]}')
        : { ok: false, status: 403, text: async () => '{"errors":[{"message":"invalid_scope"}]}', json: async () => ({ errors: [{ message: 'invalid_scope' }] }) };
    }
    if (u.includes('item_summary/search')) { sent.push({ call: 'browse' }); return body(comps); }
    const call = (opts.headers && opts.headers['X-EBAY-API-CALL-NAME']) || '';
    sent.push({ call, body: String(opts.body || '') });
    if (call === 'GetItem') return { ok: true, status: 200, text: async () => (typeof item === 'function' ? item(sent.length) : item) };
    return { ok: true, status: 200, text: async () => '<Response><Ack>Success</Ack></Response>' };
  };
}
const seed = (over = {}) => {
  tdb.prepare(`INSERT OR REPLACE INTO ebay_seller_listings
    (listing_id, sku, title, price_cents, currency, quantity, available_qty, sold_qty, listing_type, state, created_via)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    over.listing_id || '9001', 'AAC-001',
    over.title || 'Pokemon Wailord ex 016/084 Pitch Black Double Rare Holo EN M/NM',
    over.price_cents ?? 1000, 'AUD', 3, over.available_qty ?? 3, 0,
    over.listing_type || 'FixedPriceItem', over.state || 'active', over.created_via || 'manual');
};
const scan = (opts = {}) => scanListings({ env: ENV, rdb, tdb, cfg: CFG, base: 'http://127.0.0.1:0', gapMs: 0, importFirst: false, ...opts });
const checks = () => rdb.prepare('SELECT * FROM price_checks ORDER BY id').all();

before(() => {
  for (const f of [TDB, RDB, PDB]) { try { fs.unlinkSync(f); } catch {} }
  tdb = openDb(); rdb = openRepricerDb(); pdb = openPostsaleDb();
});
// Corroboration defaults to `require`: a raise built purely from ASKING prices is refused unless
// something that actually transacted seconds it. Most tests here are about other things, so they get
// a past sale of listing 9001 at A$12.00 — enough to support the A$11.98 target. The tests that ARE
// about corroboration clear this first.
const seedOwnSale = (cents = 1200, itemId = '9001') => {
  pdb.prepare(`INSERT OR REPLACE INTO buyers (id, ebay_username) VALUES (1, 'buyer1')`).run();
  pdb.prepare(`INSERT OR REPLACE INTO orders (order_id, buyer_id, paid_time, total_cents) VALUES ('o1', 1, '2026-07-01 00:00:00', ?)`).run(cents);
  pdb.prepare(`INSERT INTO order_line_items (order_id, ebay_item_id, title, quantity, unit_price_cents)
               VALUES ('o1', ?, 'Wailord', 1, ?)`).run(itemId, cents);
};
afterEach(() => {
  globalThis.fetch = realFetch;
  rdb.exec('DELETE FROM price_checks');
  tdb.exec('DELETE FROM ebay_seller_listings');
  pdb.exec('DELETE FROM order_line_items'); pdb.exec('DELETE FROM orders');
});
after(() => { for (const f of [TDB, RDB, PDB]) for (const x of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + x); } catch {} } });

describe('scanListings — the pass is read-only', () => {
  it('NEVER sends a write, whatever it decides', async () => {
    stub();
    seed();
    await scan();
    const writes = sent.filter((s) => /Revise|AddItem|EndItem/i.test(s.call || ''));
    assert.deepEqual(writes, [], 'a scan that can write is not a scan');
  });

  it('reads live state then comps, in that order, once each', async () => {
    stub();
    seed();
    const r = await scan();
    assert.equal(r.ok, true);
    const calls = sent.map((s) => s.call).filter((c) => c === 'GetItem' || c === 'browse');
    assert.deepEqual(calls, ['GetItem', 'browse'], 'live truth before market, one of each');
  });

  it('records a raise with the numbers it would propose', async () => {
    stub();
    seed(); seedOwnSale();
    await scan();
    const [c] = checks();
    assert.equal(c.verdict, 'raise');
    assert.equal(c.our_price_cents, 1000);
    assert.equal(c.our_postage_cents, 0);
    // The comps engine already applies the store's price endings (recommended = cheapest in cluster
    // minus a cent, snapped), so A$12.00 of comps arrives as A$11.98 delivered.
    assert.equal(c.target_delivered_cents, 1198, 'what comps said, in delivered terms');
    assert.equal(c.target_cents, 1198, 'free postage, so the list target equals the delivered one');
    assert.equal(c.mode, 'asking');
    assert.ok(c.query.startsWith('Pokemon Wailord ex'), 'query is game-aware: ' + c.query);
    assert.equal(c.scan_id, (await Promise.resolve(c.scan_id)));
  });
});

describe('scanListings — live eBay fields reach the decision', () => {
  const cases = [
    ['best_offer_auto_accept', { bestOffer: true, autoAccept: '8.00' }],
    ['discount_pricing_active', { promo: true }],
    ['multi_variation', { variations: true }],
    ['postage_unknown', { shippingType: 'Calculated', postage: null }],
    // The defect this fixture exists to pin: a FLAT-postage listing whose GetItem carried no
    // ShippingServiceOptions at all. That used to parse as A$0.00 — free postage — because
    // Number('') is 0, which is precisely the assumption that prices every listing above the
    // cluster. Unknown must stay unknown.
    ['postage_unknown', { shippingType: 'Flat', postage: null }],
    ['not_active', { status: 'Completed' }],
  ];
  for (const [code, over] of cases) {
    it('skips ' + code + ' (' + JSON.stringify(over) + ') — a field only GetItem exposes', async () => {
      stub({ item: itemXml(over) });
      seed();
      await scan();
      const [c] = checks();
      assert.equal(c.verdict, 'skip');
      assert.equal(c.code, code);
      assert.equal(sent.filter((s) => s.call === 'browse').length, 0, 'a refused listing must not spend a comps call');
    });
  }

  // Best Offer on its own is NOT a refusal — it was found on 7 of the first 10 real listings, and
  // without a threshold every offer still reaches a human, so a raise can only improve the anchor.
  it('prices a Best Offer listing that has no auto-accept threshold', async () => {
    stub({ item: itemXml({ bestOffer: true }) });
    seed(); seedOwnSale();
    await scan();
    const [c] = checks();
    assert.equal(c.verdict, 'raise', 'plain Best Offer must not be refused');
    assert.equal(sent.filter((s) => s.call === 'browse').length, 1, 'and it should have cost a comps call');
  });

  // Auto-DECLINE is the harmless half: it stays where it is after a raise, which only means offers
  // between the old floor and the new price reach a human instead of bouncing.
  it('prices a Best Offer listing that has only an auto-decline minimum', async () => {
    stub({ item: itemXml({ bestOffer: true, minOffer: '5.00' }) });
    seed(); seedOwnSale();
    await scan();
    assert.equal(checks()[0].verdict, 'raise');
  });

  it('subtracts our postage from the delivered comps figure', async () => {
    stub({ item: itemXml({ postage: '4.50' }) });
    seed();
    await scan();
    const [c] = checks();
    assert.equal(c.our_postage_cents, 450);
    assert.equal(c.target_delivered_cents, 1198);
    assert.equal(c.target_cents, 748, 'A$11.98 delivered minus A$4.50 postage is a A$7.48 list price');
    assert.equal(c.verdict, 'hold', 'that is below our A$10.00, so it must not be raised');
    assert.equal(c.code, 'above_market');
  });
});

describe('scanListings — refusals that cost nothing', () => {
  it('skips an unparseable title before any API call', async () => {
    stub();
    seed({ title: 'Mystery bundle of assorted holos' });   // no number of any shape
    await scan();
    const [c] = checks();
    assert.equal(c.verdict, 'skip');
    assert.equal(c.code, 'title_unparseable');
    assert.equal(sent.length, 0, 'no token, no GetItem, no comps — the whole point of an offline gate');
  });

  it('skips a game it cannot identify rather than guessing Pokemon', async () => {
    stub();
    seed({ title: 'Some Random Card 123/456 Unknown Expansion' });
    await scan();
    const [c] = checks();
    assert.equal(c.code, 'unknown_game');
    assert.equal(sent.length, 0);
  });

  it('records a thin comp set as a decline, not a skip', async () => {
    stub({ comps: browseJson(3, 30.0) });
    seed();
    await scan();
    const [c] = checks();
    assert.equal(c.verdict, 'decline');
    assert.ok(['no_comps', 'too_few_comps', 'not_reliable', 'confidence_below_required'].includes(c.code), 'got ' + c.code);
  });
});

describe('scanListings — behaviour under stress', () => {
  it('one failing listing never ends the pass (GR7)', async () => {
    let n = 0;
    stub({ item: () => { n++; return n === 1 ? '<GetItemResponse><Ack>Failure</Ack><Errors><LongMessage>boom</LongMessage></Errors></GetItemResponse>' : itemXml(); } });
    seed({ listing_id: '9001' });
    seed({ listing_id: '9002' });
    const r = await scan();
    assert.equal(r.ok, true);
    assert.equal(checks().length, 2, 'both listings recorded despite the first failing');
    assert.ok(checks().some((c) => c.code === 'listing_read_failed'));
  });

  it('refuses to run two passes at once', async () => {
    stub();
    seed();
    const [a, b] = await Promise.all([scan(), scan()]);
    const skipped = [a, b].filter((r) => r.skipped === 'already_running');
    assert.equal(skipped.length, 1, 'exactly one pass must be turned away');
  });

  it('honours a limit', async () => {
    stub();
    for (const id of ['9001', '9002', '9003']) seed({ listing_id: id });
    await scan({ limit: 2 });
    assert.equal(checks().length, 2);
  });

  it('counts verdicts and reason codes for the summary', async () => {
    stub();
    seed({ listing_id: '9001' });
    seed({ listing_id: '9002', title: 'Mystery bundle of assorted holos' });
    const r = await scan();
    assert.equal(r.checked, 2);
    assert.equal(r.skip, 1);
    assert.equal(r.codes.title_unparseable, 1);
  });
});

describe('scan helpers', () => {
  it('infers the game from the title', () => {
    assert.equal(inferGame('Pokemon Wailord ex 016/084'), 'Pokemon');
    assert.equal(inferGame("Kha'Zix, Evolving Hunter 119/219 - Riftbound Unleashed"), 'Riftbound');
    assert.equal(inferGame('Milo Thatch - Getting His Hands Dirty 230 - Disney Lorcana'), 'Lorcana');
    assert.equal(inferGame('Some Random Card 1/2'), null, 'unknown must be null, never a default');
  });
  it('builds a game-aware query', () => {
    assert.equal(compsQueryFor('Riftbound', { name: "Kha'Zix", number: '119/219' }), "Riftbound Kha'Zix 119/219");
  });
  it('omits absent guardrails rather than passing undefined over the defaults', () => {
    assert.deepEqual(guardrailsFrom({}), {});
    assert.equal(guardrailsFrom({ guardrails: { min_uplift_aud: 1.5 } }).minUpliftCents, 150);
  });
});

// --- corroboration, end to end ------------------------------------------------------------------
// Every comp the engine can reach is an ASKING price, and asking prices of unsold stock sit above the
// clearing price. This is the gate that stopped a A$44.98 proposal on a card whose last real sale was
// A$25.00 — proven here through the real database lookup rather than an injected value.
describe('scanListings — a raise must be seconded by something that transacted', () => {
  it('declines when nothing has ever sold', async () => {
    stub();
    seed();                       // deliberately no seedOwnSale()
    await scan();
    const [c] = checks();
    assert.equal(c.verdict, 'decline');
    assert.equal(c.code, 'no_corroboration');
    assert.equal(c.target_cents, 1198, 'the price it wanted is still recorded, so the refusal is auditable');
  });

  it('raises once a real sale of that listing exists', async () => {
    stub();
    seed(); seedOwnSale(1200);
    await scan();
    assert.equal(checks()[0].verdict, 'raise');
  });

  it('declines when the only sale is far below the target', async () => {
    // The Sett shape: market asking well above what the card actually trades at.
    stub();
    seed(); seedOwnSale(500);
    await scan();
    const [c] = checks();
    assert.equal(c.verdict, 'decline');
    assert.equal(c.code, 'not_corroborated');
  });

  it('reads the sale by eBay item id, not by title', async () => {
    // order_line_items carries the item id, so no identity resolution is needed — and a sale of a
    // DIFFERENT listing must not vouch for this one.
    stub();
    seed(); seedOwnSale(1200, '9999');
    await scan();
    assert.equal(checks()[0].code, 'no_corroboration');
  });

  it('advisory lets an unsupported raise through, and still blocks a contradicted one', async () => {
    const advisory = { ...CFG, guardrails: { ...CFG.guardrails, corroboration: 'advisory' } };
    stub(); seed();
    await scan({ cfg: advisory });
    assert.equal(checks()[0].verdict, 'raise', 'absence of evidence is not evidence of absence');
    rdb.exec('DELETE FROM price_checks');
    stub(); seedOwnSale(500);
    await scan({ cfg: advisory });
    assert.equal(checks()[0].code, 'not_corroborated', 'a source that exists and disagrees still blocks');
  });
});
