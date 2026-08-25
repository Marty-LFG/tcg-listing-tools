// test/unit/ebay-links.test.mjs — THE eBay AU URLs (lib/ebay-links.mjs).
//
// Every comps link in the suite is built here now — Telegram cards, the batch runner's grid, the
// single uploader — so these assertions cover all of them at once. They are literal on purpose: a
// "Sold" link tapped on a phone must land on the same results as one clicked in the grid, and the
// parameters are the whole of that promise. test/invariants/ebay-links-single-source.test.mjs is
// the other half — it stops a page quietly growing its own copy again.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { itemUrl, searchUrl, compsQuery, browseSearchUrl, SOP, MAX_IPG, REACHABLE_CAP } from '../../lib/ebay-links.mjs';

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

// The wider options (added for ebay-testbed.html). The two literal assertions above are the
// regression proof for every pre-existing caller: if they still pass untouched, nothing moved.
describe('searchUrl — the composable options', () => {
  it('an out-of-range sort or location folds to the safe default rather than being passed through', () => {
    // LH_PrefLoc=3 is "North America" on the US site and simply does not resolve on AU — it comes
    // back with no result count at all, which reads as "no stock" rather than as a bad parameter.
    assert.equal(new URL(searchUrl('x', { prefLoc: 3 })).searchParams.get('LH_PrefLoc'), '1');
    assert.equal(new URL(searchUrl('x', { sort: 99 })).searchParams.get('_sop'), '15');
    assert.equal(new URL(searchUrl('x', { sort: SOP.newlyListed })).searchParams.get('_sop'), '10');
    assert.equal(new URL(searchUrl('x', { prefLoc: 2 })).searchParams.get('LH_PrefLoc'), '2');
  });

  it('never emits _sacat without _dcat — an aspect will not bind to a lone _sacat', () => {
    const u = new URL(searchUrl('x', { category: 183454 }));
    assert.equal(u.searchParams.get('_sacat'), '183454');
    assert.equal(u.searchParams.get('_dcat'), '183454', 'the pair is what makes aspect params bind');
  });

  // Measured live: eBay stops serving past 4,000 results deep. _ipg=240&_pgn=16 is the last page
  // that returns anything; _pgn=17 returns none. Clamp rather than refuse (GR7) — a null URL would
  // turn a paging bug into a dead link.
  it('clamps paging to what eBay will actually serve', () => {
    const u = new URL(searchUrl('x', { perPage: 9999, page: 999 }));
    assert.equal(u.searchParams.get('_ipg'), String(MAX_IPG));
    assert.equal(u.searchParams.get('_pgn'), String(Math.floor(REACHABLE_CAP / MAX_IPG)), '16 is the last page that serves; 17 returns nothing');
    assert.equal(new URL(searchUrl('x', { perPage: 60, page: 999 })).searchParams.get('_pgn'), '66');
  });

  // A wrongly-encoded aspect is NOT an error — eBay ignores it and returns the unfiltered set,
  // which is indistinguishable from a filter that matched everything. This literal was copied off a
  // working live search, so it is the only thing standing between us and a silent no-op filter.
  it('double-encodes aspect params exactly as the live search page does', () => {
    const u = searchUrl('Charizard ex 199', {
      category: 183454,
      aspects: { 'Professional Grader': ['Professional Sports Authenticator (PSA)'], Grade: ['8'] },
    });
    assert.ok(u.includes('Professional%2520Grader=Professional%2520Sports%2520Authenticator%2520%2528PSA%2529'),
      'parentheses must be escaped too — encodeURIComponent leaves them alone but eBay wants %2528/%2529\n' + u);
    assert.ok(u.includes('&Grade=8'));
  });

  it('repeats the key for a multi-select facet', () => {
    const u = searchUrl('x', { aspects: { Grade: ['8', '9'] } });
    assert.ok(u.includes('&Grade=8&Grade=9'));
  });

  it('auction and BIN are independent, and the default is still BIN-only', () => {
    assert.equal(new URL(searchUrl('x')).searchParams.get('LH_Auction'), null);
    const u = new URL(searchUrl('x', { bin: false, auction: true }));
    assert.equal(u.searchParams.get('LH_BIN'), null);
    assert.equal(u.searchParams.get('LH_Auction'), '1');
  });
});

describe('browseSearchUrl', () => {
  // The same identity as a Browse API call. Verified live: this exact path returns the same total
  // as the equivalent hand-built request (32 for PSA-graded Charizard ex 199 in AU).
  it('builds a proxy-relative Browse path', () => {
    const p = browseSearchUrl('Charizard ex 199', { limit: 1, categoryIds: 183454, filter: 'itemLocationCountry:AU' });
    assert.ok(p.startsWith('/api/ebay/buy/browse/v1/item_summary/search?'), p);
    const q = new URLSearchParams(p.split('?')[1]);
    assert.equal(q.get('q'), 'Charizard ex 199');
    assert.equal(q.get('category_ids'), '183454');
    assert.equal(q.get('filter'), 'itemLocationCountry:AU');
    assert.equal(q.get('limit'), '1');
  });
  it('is null on an empty query, like its sibling', () => {
    for (const v of ['', '   ', null, undefined]) assert.equal(browseSearchUrl(v), null);
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
