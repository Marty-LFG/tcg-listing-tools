// test/unit/comps-singles.test.mjs — the server singles comps VALUE engine (lib/comps-singles.mjs).
// Stubs the /api/ebay self-fetch to exercise: sold-first → asking fallback, own-seller exclusion,
// the precision filter, cluster + recommendation, and graceful failure. (Pure logic is in check-comps.)
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { singlesEbayValue } from '../../lib/comps-singles.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubBrowse(items) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/marketplace_insights/')) return { status: 403, ok: false, json: async () => ({ errors: [{ errorId: 1 }] }) };   // sold not granted
    if (u.includes('/browse/v1/item_summary/search')) return { status: 200, ok: true, json: async () => ({ itemSummaries: items }) };
    return { status: 404, ok: false, json: async () => ({}) };
  };
}
const ask = (title, price, ship, extra = {}) => ({ title, price: { value: String(price) }, shippingOptions: [{ shippingCost: { value: String(ship) } }], itemLocation: { country: 'AU' }, conditionId: '4000', ...extra });

describe('singlesEbayValue', () => {
  it('recommends undercutting the cheapest in-cluster and excludes our own seller', async () => {
    const items = [
      ask('Charizard 4/102 Base Set Holo NM', 18.0, 1.0),
      ask('Charizard 4/102 Base Set Holo', 18.5, 1.0),
      ask('Charizard 4/102 Base Set', 19.0, 0.5),
      ask('Charizard 4/102 Base Set Holo LP', 19.5, 0.5),
      ask('Charizard 4/102 Base Set Holo NM', 20.0, 0.0),
      ask('Charizard 4/102 Base Set Holo — CHEAP undercut', 5.0, 0.0, { seller: { username: 'omg.its.alcatrazz' } }),   // ours — must be dropped
      ask('Charizard 4/102 custom proxy', 3.0, 0.0),                    // junk — must be dropped
      ask('Pikachu 58/102 Base Set', 2.0, 0.0),                         // wrong card — must be dropped
    ];
    stubBrowse(items);
    const r = await singlesEbayValue({ base: 'http://x', query: 'Pokemon Charizard 4/102', numberMatch: '4/102', lang: 'en', finish: 'foil', excludeSeller: 'omg.its.alcatrazz', minComps: 3 });
    assert.equal(r.matched, true, r.reason);
    assert.equal(r.mode, 'asking');
    // our $5 listing excluded → cheapest delivered in cluster is ~19, not ~5
    assert.ok(r.cheapest >= 18, 'own-seller lowball excluded, cheapest=' + r.cheapest);
    assert.ok(r.recommended >= 18 && r.recommended < r.cheapest + 0.01, 'recommended undercuts cheapest in-cluster: ' + r.recommended);
    assert.ok(['low', 'medium', 'high'].includes(r.confidence));
  });

  it('too few comps → matched:false', async () => {
    stubBrowse([ask('Charizard 4/102 Base Set Holo', 18.0, 1.0)]);
    const r = await singlesEbayValue({ base: 'http://x', query: 'q', numberMatch: '4/102', lang: 'en', minComps: 4 });
    assert.equal(r.matched, false);
    assert.equal(r.reason, 'too_few_comps');
  });

  it('no query → matched:false (never throws)', async () => {
    const r = await singlesEbayValue({ base: 'http://x', query: '' });
    assert.equal(r.matched, false);
    assert.equal(r.reason, 'no_query');
  });
});
