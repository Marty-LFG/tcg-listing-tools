// test/unit/pricecharting.test.mjs — pure parsers of the keyless PriceCharting scraper
// (lib/pricecharting.mjs). Synthetic HTML snippets mirror the real page structure; the
// live-canary for structure drift is the status page's PC probe, not these tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyCents, parseFullPrices, parseCardPage, pickBestMatch, parseSealedProduct, parseSealedConsole, parseConsole, walkConsolePages } from '../../lib/pricecharting.mjs';

describe('parseMoneyCents', () => {
  it('dollar strings → integer cents (GR3)', () => {
    assert.equal(parseMoneyCents('$2,771.48'), 277148);
    assert.equal(parseMoneyCents('$0.00'), 0);
    assert.equal(parseMoneyCents('12.5'), 1250);
  });
  it('dash / empty / junk → null', () => {
    assert.equal(parseMoneyCents('-'), null);
    assert.equal(parseMoneyCents(''), null);
    assert.equal(parseMoneyCents(null), null);
    assert.equal(parseMoneyCents('N/A'), null);
  });
});

const PAGE = `
<h1>Full Price Guide: Charizard #4 (Pokemon Base Set)</h1>
<div id="full-prices"><table>
<tr><td>Ungraded</td><td class="price js-price">$383.84</td></tr>
<tr><td>Grade 9</td><td class="price js-price">$2,771.48</td></tr>
<tr><td>PSA 10</td><td class="price js-price">$30,100.00</td></tr>
<tr><td>BGS 10</td><td class="price js-price">-</td></tr>
</table></div>`;

describe('parseFullPrices / parseCardPage', () => {
  it('builds the label→cents ladder', () => {
    const fp = parseFullPrices(PAGE);
    assert.equal(fp['Ungraded'], 38384);
    assert.equal(fp['Grade 9'], 277148);
    assert.equal(fp['PSA 10'], 3010000);
    assert.equal(fp['BGS 10'], null); // unpriced rung stays null, never fabricated (GR4)
  });
  it('parseCardPage surfaces the owner rungs + product/console names', () => {
    const c = parseCardPage(PAGE);
    assert.equal(c.productName, 'Charizard #4');
    assert.equal(c.consoleName, 'Pokemon Base Set');
    assert.deepEqual(c.prices, { ungraded: 38384, grade9: 277148, psa10: 3010000, bgs10: null });
  });
  it('missing table → empty, never a throw (GR7)', () => {
    assert.deepEqual(parseFullPrices('<html></html>'), {});
    assert.deepEqual(parseFullPrices(null), {});
  });
});

describe('pickBestMatch', () => {
  const results = [
    { productName: 'Charizard #4', consoleName: 'Pokemon Base Set' },
    { productName: 'Charizard #4', consoleName: 'Pokemon Base Set 2' },
    { productName: 'Dark Charizard #4', consoleName: 'Pokemon Team Rocket' },
  ];
  it('AMBIGUOUS same-number reprint (Base Set vs Base Set 2) → null, never a wrong-set guess (GR4)', () => {
    // setMatch is loose by design, so 'Base Set' resolves BOTH consoles → no UNIQUE set-match.
    // Returning withSet[0] here would surface the wrong reprint's price at high confidence (the
    // Base Set vs Base Set 2 Charizard #4 prices differ hugely), so it must refuse to guess.
    assert.equal(pickBestMatch(results, { name: 'Charizard', number: '4', setName: 'Base Set' }), null);
  });
  it('UNIQUE set match → high confidence', () => {
    const one = [
      { productName: 'Charizard #4', consoleName: 'Pokemon Base Set' },
      { productName: 'Dark Charizard #4', consoleName: 'Pokemon Team Rocket' },
    ];
    const m = pickBestMatch(one, { name: 'Charizard', number: '4', setName: 'Base Set' });
    assert.equal(m.match, one[0]);
    assert.equal(m.confidence, 'high');
  });
  it('set filter selects the right console when names overlap', () => {
    // 'Charizard' name-matches 'Dark Charizard' too (loose by design); the set uniquely resolves it.
    const m = pickBestMatch(results, { name: 'Dark Charizard', number: '4', setName: 'Team Rocket' });
    assert.equal(m.match, results[2]);
    assert.equal(m.confidence, 'high');
  });
  it('single name+number candidate, no set match → medium (uniqueness ≈ confidence)', () => {
    const one = [{ productName: 'Pikachu #58', consoleName: 'Pokemon Jungle' }];
    const m = pickBestMatch(one, { name: 'Pikachu', number: '58', setName: 'Some Unknown Set' });
    assert.equal(m.match, one[0]);
    assert.equal(m.confidence, 'medium');
  });
  it('multiple candidates, none resolving the set → null (refuses to guess)', () => {
    assert.equal(pickBestMatch(results, { name: 'Charizard', number: '4', setName: 'Vivid Voltage' }), null);
  });
  it('wrong number → null (never a cross-card match)', () => {
    assert.equal(pickBestMatch(results, { name: 'Charizard', number: '999', setName: 'Base Set' }), null);
  });
});

// ---- sealed products (booster boxes / ETBs / bundles …) --------------------
const SEALED_PAGE = `
<h1>Full Price Guide: Scarlet &amp; Violet 151 Booster Box (Pokemon Scarlet &amp; Violet 151)</h1>
<div id="full-prices"><table>
<tr><td>New</td><td class="price js-price">$399.00</td></tr>
<tr><td>Loose</td><td class="price js-price">$350.00</td></tr>
<tr><td>Box only</td><td class="price js-price">-</td></tr>
</table></div>`;

describe('parseSealedProduct', () => {
  it('reads the sealed (New) + loose rungs and product/console names', () => {
    const p = parseSealedProduct(SEALED_PAGE);
    assert.equal(p.productName, 'Scarlet & Violet 151 Booster Box');
    assert.equal(p.consoleName, 'Pokemon Scarlet & Violet 151');
    assert.equal(p.prices.sealed, 39900);   // 'New'
    assert.equal(p.prices.loose, 35000);
    assert.equal(p.prices.cib, null);       // no CIB/Complete rung on the page — not fabricated (GR4)
  });
  it('missing table → empty prices, never a throw (GR7)', () => {
    const p = parseSealedProduct('<html></html>');
    assert.deepEqual(p.prices, { sealed: null, loose: null, cib: null });
  });
});

// A console page lists both singles (with "#<n>") and sealed products (no "#"). The card path
// (parseConsole) drops the sealed rows; parseSealedConsole KEEPS them and drops the singles.
const CONSOLE = `
<table id="games_table">
<tr id="product-111" data-product><td class="title"><a href="https://www.pricecharting.com/game/pokemon-151/charizard-ex-199">Charizard ex #199</a></td></tr>
<tr id="product-222" data-product><td class="title"><a href="https://www.pricecharting.com/game/pokemon-151/booster-box">Scarlet & Violet 151 Booster Box</a></td></tr>
<tr id="product-333" data-product><td class="title"><a href="https://www.pricecharting.com/game/pokemon-151/etb">151 Elite Trainer Box</a></td></tr>
</table>`;

describe('parseSealedConsole', () => {
  it('keeps the #-less sealed rows and drops the numbered singles', () => {
    const rows = parseSealedConsole(CONSOLE);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'Scarlet & Violet 151 Booster Box');
    assert.ok(rows[0].url.includes('/game/'));
    assert.equal(rows[1].name, '151 Elite Trainer Box');
  });
  it('no table → empty array, never a throw (GR7)', () => {
    assert.deepEqual(parseSealedConsole('<html></html>'), []);
    assert.deepEqual(parseSealedConsole(null), []);
  });
});

// PriceCharting console pages server-render only the first ~150 product rows and hide the rest behind
// a ?cursor=<row-offset> param. walkConsolePages walks that pagination; a single fetch used to drop
// every card past the first page (M2A Mega Dream ex, 487 rows, showed only ~#1-56 — the overnumbered
// secret rares like Team Rocket's Mimikyu #205 vanished). Fake pages let the REAL parseConsole read them.
describe('walkConsolePages (cursor pagination — no dropped cards past page 1)', () => {
  const rowHtml = (n) => `<tr id="product-${1000 + n}" data-product><td class="title"><a href="https://www.pricecharting.com/game/set/card-${n}">Card #${n}</a></td></tr>`;
  const pageHtml = (nums) => `<table id="games_table">\n${nums.map(rowHtml).join('\n')}\n</table>`;
  // A fake console of `total` rows numbered 1..total, served `pageSize` rows per cursor (a row offset).
  const fakeConsole = (total, pageSize) => {
    let calls = 0;
    const fetchHtml = async (cursor) => {
      calls++;
      const nums = [];
      for (let i = cursor; i < Math.min(cursor + pageSize, total); i++) nums.push(i + 1);
      return pageHtml(nums);
    };
    return { fetchHtml, calls: () => calls };
  };
  const numbers = (cards) => cards.map((c) => Number(c.number));

  it('collects EVERY page for a big set (M2A = 487 rows > 150) — the tail #205 SAR is present', async () => {
    const { fetchHtml, calls } = fakeConsole(487, 150);
    const cards = await walkConsolePages(fetchHtml, parseConsole);
    assert.equal(cards.length, 487, 'no cards dropped past the first 150-row page');
    const nums = numbers(cards);
    assert.ok(nums.includes(1), 'head card present');
    assert.ok(nums.includes(205), "the overnumbered Team Rocket's Mimikyu #205 is present (the bug)");
    assert.ok(nums.includes(487), 'the final tail card is present');
    assert.equal(calls(), 4, '150+150+150+37 → four fetches, last page short');
  });

  it('stops on a short final page', async () => {
    const { fetchHtml, calls } = fakeConsole(180, 150);
    const cards = await walkConsolePages(fetchHtml, parseConsole);
    assert.equal(cards.length, 180);
    assert.equal(calls(), 2, '150 then a short 30-row page');
  });

  it('a set that fits under one page collects all rows (one trailing empty fetch confirms the end)', async () => {
    const { fetchHtml, calls } = fakeConsole(118, 150);      // M5-sized — under the cap, never truncated
    const cards = await walkConsolePages(fetchHtml, parseConsole);
    assert.equal(cards.length, 118);
    assert.equal(calls(), 2, 'page-0 looks full-height (118==firstPageRows) so an empty page-1 confirms the end');
  });

  it('a non-advancing cursor (server ignores ?cursor) stops WITHOUT duplicating rows', async () => {
    let calls = 0;
    const fetchHtml = async () => { calls++; return pageHtml(Array.from({ length: 150 }, (_, i) => i + 1)); };
    const cards = await walkConsolePages(fetchHtml, parseConsole);
    assert.equal(cards.length, 150, 'the repeated page is detected by its first-row id and not re-added');
    assert.equal(calls, 2, 'one probe past the first page, then break');
  });

  it('respects the page cap (no runaway loop)', async () => {
    const { fetchHtml, calls } = fakeConsole(10000, 150);
    const cards = await walkConsolePages(fetchHtml, parseConsole, 3);
    assert.equal(calls(), 3);
    assert.equal(cards.length, 450);
  });

  it('empty first page → one fetch, empty result, never a throw (GR7)', async () => {
    let calls = 0;
    const cards = await walkConsolePages(async () => { calls++; return '<html></html>'; }, parseConsole);
    assert.equal(cards.length, 0);
    assert.equal(calls, 1);
  });
});
