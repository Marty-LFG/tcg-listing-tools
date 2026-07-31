// test/unit/ebay-links.test.mjs — server-side eBay AU URLs (lib/ebay-links.mjs).
//
// The search parameters are asserted literally on purpose. They must stay identical to the
// client-side ebaySearchUrl() in stock-runner.html / stock-uploader.html, so a "Sold" link tapped
// from a Telegram card lands on the same results as one clicked in the listing tools. There is no
// shared module the inline page scripts can import, so this test is the only thing holding them
// together — if it fails after a deliberate change, change the two pages too.
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
