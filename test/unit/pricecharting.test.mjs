// test/unit/pricecharting.test.mjs — pure parsers of the keyless PriceCharting scraper
// (lib/pricecharting.mjs). Synthetic HTML snippets mirror the real page structure; the
// live-canary for structure drift is the status page's PC probe, not these tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyCents, parseFullPrices, parseCardPage, pickBestMatch } from '../../lib/pricecharting.mjs';

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
  it('number + name + set match → high confidence', () => {
    const m = pickBestMatch(results, { name: 'Charizard', number: '4', setName: 'Base Set' });
    assert.equal(m.match, results[0]);
    assert.equal(m.confidence, 'high');
  });
  it('set filter selects the right console when names overlap', () => {
    // 'Charizard' name-matches 'Dark Charizard' too (loose by design); the set resolves it.
    const m = pickBestMatch(results, { name: 'Dark Charizard', number: '4', setName: 'Team Rocket' });
    assert.equal(m.match, results[2]);
    assert.equal(m.confidence, 'high');
  });
  it('multiple candidates, none resolving the set → null (refuses to guess)', () => {
    assert.equal(pickBestMatch(results, { name: 'Charizard', number: '4', setName: 'Vivid Voltage' }), null);
  });
  it('wrong number → null (never a cross-card match)', () => {
    assert.equal(pickBestMatch(results, { name: 'Charizard', number: '999', setName: 'Base Set' }), null);
  });
});
