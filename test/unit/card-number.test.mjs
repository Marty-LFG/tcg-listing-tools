// test/unit/card-number.test.mjs — Golden Rule 10: formatCardNumber() must reproduce the
// collector number EXACTLY as printed on the card.
//
// Every expectation below was read off a hi-res scan of the real card, not inferred:
// pokemontcg.io strips the printed zero-padding (a card printed 004/165 arrives as "4"), so
// the padding is rebuilt from the set's era. The Sword & Shield (2020) cutover is the load-
// bearing fact — Base Set really is "58/102" and White Flare really is "012/086".
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { formatCardNumber, cardNumberKey } from '../../lib/listing-copy.mjs';
import { read, extractFn } from '../helpers/extract-inline.mjs';

const SV = { series: 'Scarlet & Violet', releaseDate: '2025/07/18' };
const SWSH = { series: 'Sword & Shield', releaseDate: '2020/02/07' };

describe('formatCardNumber — EN main sets, era-based padding', () => {
  it('Scarlet & Violet pads both sides to 3 (White Flare 012/086)', () => {
    assert.equal(formatCardNumber('12', { ...SV, name: 'White Flare', printedTotal: 86, total: 173 }), '012/086');
  });
  it('secret rare above the printed total keeps the printed denominator (106/086)', () => {
    assert.equal(formatCardNumber('106', { ...SV, name: 'White Flare', printedTotal: 86, total: 173 }), '106/086');
  });
  it('Sword & Shield (the 2020 cutover) pads (004/202)', () => {
    assert.equal(formatCardNumber('4', { ...SWSH, name: 'Sword & Shield', printedTotal: 202, total: 216 }), '004/202');
  });
  it('a small modern set still pads to 3 (Celebrations 001/025)', () => {
    assert.equal(formatCardNumber('1', { series: 'Sword & Shield', releaseDate: '2021/10/08', name: 'Celebrations', printedTotal: 25, total: 25 }), '001/025');
  });
  it('pre-Sword & Shield leaves the numerator natural (Sun & Moon 4/149, XY 4/146)', () => {
    assert.equal(formatCardNumber('4', { series: 'Sun & Moon', releaseDate: '2017/02/03', name: 'Sun & Moon', printedTotal: 149, total: 163 }), '4/149');
    assert.equal(formatCardNumber('4', { series: 'XY', releaseDate: '2014/02/05', name: 'XY', printedTotal: 146, total: 146 }), '4/146');
  });
  it('vintage is untouched (Base Set 58/102) — the regression this rule must never cause', () => {
    assert.equal(formatCardNumber('58', { series: 'Base', releaseDate: '1999/01/09', name: 'Base', printedTotal: 102, total: 102 }), '58/102');
  });
  it('era falls back to releaseDate when the series is unknown', () => {
    assert.equal(formatCardNumber('7', { releaseDate: '2024/05/24', name: 'Twilight Masquerade', printedTotal: 167, total: 226 }), '007/167');
    assert.equal(formatCardNumber('7', { releaseDate: '2016/02/03', name: 'Generations', printedTotal: 83, total: 117 }), '7/83');
  });
});

describe('formatCardNumber — promos print no denominator (owner rule: strict card-literal)', () => {
  it('SV promo pads to 3 but drops the catalog total (001, not 1/215)', () => {
    assert.equal(formatCardNumber('1', { series: 'Scarlet & Violet', releaseDate: '2023/01/01', name: 'Scarlet & Violet Black Star Promos', printedTotal: 215, total: 196 }), '001');
  });
  it('SWSH promo keeps its baked-in prefix verbatim (SWSH039, not SWSH039/307)', () => {
    assert.equal(formatCardNumber('SWSH039', { series: 'Sword & Shield', releaseDate: '2019/11/15', name: 'SWSH Black Star Promos', printedTotal: 307, total: 304 }), 'SWSH039');
  });
  it('XY promo verbatim; vintage Wizards promo stays unpadded', () => {
    assert.equal(formatCardNumber('XY01', { series: 'XY', releaseDate: '2013/10/12', name: 'XY Black Star Promos', printedTotal: 211, total: 216 }), 'XY01');
    assert.equal(formatCardNumber('1', { series: 'Base', releaseDate: '1999/07/01', name: 'Wizards Black Star Promos', printedTotal: 53, total: 53 }), '1');
  });
  it('the baked Mega Evolution Promo set is detected via the mep flag', () => {
    assert.equal(formatCardNumber('001', { mep: true, series: 'Scarlet & Violet', releaseDate: '2025/09/26', name: 'Mega Evolution Promo', printedTotal: 88, total: 79 }), '001');
  });
  it('a Promo rarity also suppresses the denominator', () => {
    assert.equal(formatCardNumber('25', { ...SV, name: 'Some Set', printedTotal: 100, total: 100 }, { rarity: 'Promo' }), '025');
  });
});

describe('formatCardNumber — subsets repeat the numerator prefix on the denominator', () => {
  it('Trainer Gallery TG01/TG30', () => {
    assert.equal(formatCardNumber('TG01', { series: 'Sword & Shield', releaseDate: '2022/02/25', name: 'Brilliant Stars Trainer Gallery', printedTotal: 30, total: 30 }), 'TG01/TG30');
  });
  it('Galarian Gallery GG01/GG70', () => {
    assert.equal(formatCardNumber('GG01', { series: 'Sword & Shield', releaseDate: '2023/01/20', name: 'Crown Zenith Galarian Gallery', printedTotal: 70, total: 70 }), 'GG01/GG70');
  });
  it('Shiny Vault SV001/SV122 (3-wide numerator widens the denominator too)', () => {
    assert.equal(formatCardNumber('SV001', { series: 'Sword & Shield', releaseDate: '2021/02/19', name: 'Shining Fates Shiny Vault', printedTotal: 122, total: 122 }), 'SV001/SV122');
  });
  it('an unrecognised lettered numbering emits a bare number, never a wrong denominator', () => {
    // e-Card "H" holos print H1/H32, but pokemontcg.io stores the PARENT total (165).
    assert.equal(formatCardNumber('H1', { series: 'E-Card', releaseDate: '2002/09/15', name: 'Expedition Base Set', printedTotal: 165, total: 165 }), 'H1');
  });
});

describe('formatCardNumber — JP/CN/KO (TCGdex) and edge cases', () => {
  it("source 'tcgdex' trusts the already card-correct numerator and pads only the denominator", () => {
    assert.equal(formatCardNumber('001', { name: 'スカーレットex', printedTotal: 78, total: 108 }, { source: 'tcgdex' }), '001/078');
    assert.equal(formatCardNumber('106', { name: 'ホワイトフレア', printedTotal: 86, total: 174 }, { source: 'tcgdex' }), '106/086');
  });
  it("the '039a' alt-art suffix stays verbatim (GR5)", () => {
    assert.equal(formatCardNumber('039a', { ...SWSH, name: 'Astral Radiance', printedTotal: 298, total: 300 }), '039a/298');
  });
  it('a missing total never emits a dangling slash', () => {
    assert.equal(formatCardNumber('25', { name: 'Unknown Set' }), '25');
    assert.equal(formatCardNumber('25', { ...SV, name: 'Unknown Set', printedTotal: '' }), '025');
  });
  it('empty/null input is empty, never "undefined"', () => {
    assert.equal(formatCardNumber('', { ...SV, name: 'X', printedTotal: 86 }), '');
    assert.equal(formatCardNumber(null, { ...SV, name: 'X', printedTotal: 86 }), '');
  });
  it('falls back to set.total when printedTotal is absent', () => {
    assert.equal(formatCardNumber('5', { ...SV, name: 'X', total: 100 }), '005/100');
  });
});

describe('cardNumberKey — padding-insensitive matching (dedupe safety)', () => {
  it('collapses the legacy and card-exact forms of the same card', () => {
    assert.equal(cardNumberKey('106/86'), cardNumberKey('106/086'));
    assert.equal(cardNumberKey('12/86'), cardNumberKey('012/086'));
  });
  it('keeps genuinely different cards apart', () => {
    assert.notEqual(cardNumberKey('106/086'), cardNumberKey('107/086'));
    assert.notEqual(cardNumberKey('12/86'), cardNumberKey('12/186'));
  });
  it('is stable on lettered and bare numbers', () => {
    assert.equal(cardNumberKey('TG01/TG30'), 'tg01/tg30');
    assert.equal(cardNumberKey('001'), '1');
    assert.equal(cardNumberKey(''), '');
  });
});

// The comps matcher lives in extras.js as a private function; extract it the same way the
// parity harness does. This is a REGRESSION GUARD: formatCardNumber now emits the padded
// card-exact form, and buildNumberRe used to zero-tolerate only the denominator — so
// "012/086" silently stopped matching eBay titles written "12/86" and comps returned nothing.
describe('buildNumberRe — comps must survive the padded number (regression)', () => {
  const ctx = vm.createContext({});
  vm.runInContext(extractFn(read('extras.js'), 'function buildNumberRe') + '; this.buildNumberRe = buildNumberRe;', ctx);
  const re = (n) => ctx.buildNumberRe(n);

  it('a padded number matches an unpadded eBay title (the bug)', () => {
    assert.ok(re('012/086').test('Pokemon Pignite 12/86 White Flare Common NM'));
    assert.ok(re('004/102').test('Charizard 4/102 Base Set Holo'));
  });
  it('and still matches the padded form', () => {
    assert.ok(re('012/086').test('Pokemon Pignite 012/086 White Flare'));
  });
  it('an unpadded number still matches a padded title (pre-existing behaviour)', () => {
    assert.ok(re('12/86').test('Pokemon Pignite 012/086 White Flare'));
  });
  it('does not match a different card', () => {
    assert.ok(!re('012/086').test('Pokemon Pignite 112/086 White Flare'));
    assert.ok(!re('012/086').test('Pokemon Oshawott 13/86 White Flare'));
  });
});
