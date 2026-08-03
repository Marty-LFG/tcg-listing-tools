// test/unit/ebay-links.test.mjs — THE eBay AU URLs (lib/ebay-links.mjs).
//
// Every comps link in the suite is built here now — Telegram cards, the batch runner's grid, the
// single uploader — so these assertions cover all of them at once. They are literal on purpose: a
// "Sold" link tapped on a phone must land on the same results as one clicked in the grid, and the
// parameters are the whole of that promise. test/invariants/ebay-links-single-source.test.mjs is
// the other half — it stops a page quietly growing its own copy again.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { itemUrl, searchUrl, compsQuery } from '../../lib/ebay-links.mjs';

describe('itemUrl', () => {
  it('builds the AU item URL', () => {
    assert.equal(itemUrl('168537104622'), 'https://www.ebay.com.au/itm/168537104622');
  });
  it('is null without an id, rather than a link to nowhere', () => {
    for (const v of ['', '  ', null, undefined]) assert.equal(itemUrl(v), null);
  });
  // A listing is served by the marketplace it was listed to. Everything this suite creates is AU, so
  // that is the default — but a listing read back from the eBay API can name another, and .com.au
  // will not serve it. lib/channels/ebay-inventory-api.mjs passes the API's own marketplace through.
  it('follows the marketplace when one is given', () => {
    assert.equal(itemUrl('168537104622', { marketplace: 'EBAY_AU' }), 'https://www.ebay.com.au/itm/168537104622');
    assert.equal(itemUrl('168537104622', { marketplace: 'EBAY_US' }), 'https://www.ebay.com/itm/168537104622');
    assert.equal(itemUrl('168537104622', { marketplace: 'EBAY_GB' }), 'https://www.ebay.com/itm/168537104622',
      'an unknown marketplace falls back to .com, which redirects, rather than to the wrong country');
  });
});

describe('searchUrl', () => {
  it('active: Buy It Now, cheapest incl. postage first', () => {
    const u = new URL(searchUrl('Wailord ex 016/084'));
    assert.equal(u.pathname, '/sch/i.html');
    assert.equal(u.searchParams.get('_nkw'), 'Wailord ex 016/084');
    assert.equal(u.searchParams.get('LH_BIN'), '1');
    assert.equal(u.searchParams.get('_sop'), '15');
    assert.equal(u.searchParams.get('LH_Sold'), null, 'active search must not filter to sold');
  });
  it('sold: completed sales, most recently ended first', () => {
    const u = new URL(searchUrl('Wailord ex', { sold: true }));
    assert.equal(u.searchParams.get('_sop'), '13');
    assert.equal(u.searchParams.get('LH_Sold'), '1');
    assert.equal(u.searchParams.get('LH_Complete'), '1');
    assert.equal(u.searchParams.get('LH_BIN'), '1');
  });
  // A US seller's sold price is not a comparable for a card being sold here — different postage,
  // different currency, different market. Both searches filter to Australian sellers, because
  // comparing AU sold prices against worldwide asking prices is not a comparison at all.
  it('BOTH searches filter to items located in Australia', () => {
    for (const opts of [{}, { sold: true }]) {
      const u = new URL(searchUrl('Wailord ex', opts));
      assert.equal(u.searchParams.get('LH_PrefLoc'), '1', JSON.stringify(opts));
      assert.equal(u.searchParams.get('rt'), 'nc', 'stop eBay rewriting the query on arrival');
    }
  });
  it('the whole sold URL, exactly as it opens', () => {
    assert.equal(searchUrl('Pokemon Palafin 200/197 Obsidian Flames', { sold: true }),
      'https://www.ebay.com.au/sch/i.html?_nkw=Pokemon+Palafin+200%2F197+Obsidian+Flames'
      + '&LH_BIN=1&_sop=13&LH_Sold=1&LH_Complete=1&rt=nc&LH_PrefLoc=1');
  });
  it('is null on an empty query', () => {
    for (const v of ['', '   ', null, undefined]) assert.equal(searchUrl(v), null);
  });
});

describe('compsQuery', () => {
  it('strips the condition/language tail no buyer repeats in their own listing', () => {
    assert.equal(compsQuery('Pokemon Wailord ex 016/084 Pitch Black Double Rare Holo EN M/NM'),
      'Pokemon Wailord ex 016/084 Pitch Black Double Rare Holo');
    assert.equal(compsQuery('Pokemon Primarina 85 Abyss Eye Holo JP M/NM'),
      'Pokemon Primarina 85 Abyss Eye Holo');
  });
  it('leaves a title with no condition tail alone', () => {
    assert.equal(compsQuery('Kha’Zix, Evolving Hunter 119/219'), 'Kha’Zix, Evolving Hunter 119/219');
  });
  it('collapses whitespace and survives empty input', () => {
    assert.equal(compsQuery('  a   b  '), 'a b');
    assert.equal(compsQuery(null), '');
  });
});
