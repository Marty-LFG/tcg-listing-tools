// The two last-resort card sources for the lanes nothing else covers.
//
// Measured 2026-08-23: TCGdex indexes the Korean and Simplified-Chinese sets but serves ZERO cards
// for either (empty cards[], per-card endpoint 404s), and PriceCharting's directory carries 5 Korean
// consoles for 100 Korean sets and 22 Chinese for 66. So ~90 Korean and ~35 Chinese sets were
// pickable in the stock tools with no card data behind them at all.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cardSourceChain, stripTwinImages, twinSlugFor, cnNameFor } from '../../lib/catalog.mjs';
import { splitCells, cellName, parseCardList } from '../../lib/wiki52poke.mjs';

const sources = (c) => c.map((s) => s.source);

describe('the Korean lane falls back to the Japanese twin, LAST', () => {
  it('puts a real Korean console ahead of the twin', () => {
    // Korean releases mirror the Japanese line card-for-card, but a genuine Korean console has real
    // Korean scans and the twin has none — so the twin must never win a set that has its own.
    assert.deepEqual(
      sources(cardSourceChain('ko', { tcgdexId: 'S6a', pcSlug: 'pokemon-korean-eevee-heroes', twinSlug: 'pokemon-japanese-eevee-heroes' })),
      ['tcgdex', 'pricecharting', 'japanese-twin']);
  });

  it('uses the twin when nothing else covers the set', () => {
    assert.deepEqual(sources(cardSourceChain('ko', { tcgdexId: 'S4A', twinSlug: 'pokemon-japanese-shiny-star-v' })),
      ['tcgdex', 'japanese-twin']);
  });

  it('offers no twin step at all when the set has no Japanese counterpart', () => {
    assert.deepEqual(sources(cardSourceChain('ko', { tcgdexId: 'BW4' })), ['tcgdex']);
  });

  it('NEVER strays onto another lane', () => {
    // A twinSlug on ja or en would mean a set quietly serving another language's cards.
    assert.deepEqual(sources(cardSourceChain('ja', { tcgdexId: 'M5', twinSlug: 'x', cnName: 'y' })), ['tcgdex']);
    assert.deepEqual(sources(cardSourceChain('en', { twinSlug: 'x', cnName: 'y' })), ['pokemontcg']);
    assert.deepEqual(sources(cardSourceChain('zh-tw', { tcgdexId: 'SV8A', twinSlug: 'x' })), ['tcgdex']);
  });

  it('strips every image off a derived card', () => {
    // THE point of the whole derivation. PriceCharting does not scan Korean cards, so the only
    // picture available is the Japanese print — and a Korean listing carrying a Japanese scan shows
    // the buyer a card they will not receive. Numbers and names transfer; pictures do not.
    const out = stripTwinImages([
      { numRaw: '1', name: 'Rowlet', img: '/api/img?u=jp.jpg', imgLarge: 'https://jp/1600.jpg', priceVal: 1.2, source: 'pricecharting' },
    ]);
    assert.equal(out[0].img, '');
    assert.equal(out[0].imgLarge, '');
    assert.equal(out[0].source, 'japanese-twin', 'and it says where it came from');
    assert.equal(out[0].name, 'Rowlet', 'name and number still transfer');
    assert.equal(out[0].numRaw, '1');
  });

  it('handles an empty or missing list without throwing', () => {
    assert.deepEqual(stripTwinImages([]), []);
    assert.deepEqual(stripTwinImages(undefined), []);
  });
});

describe('the Simplified-Chinese lane falls back to 52poke, LAST', () => {
  it('sits behind TCGdex and PriceCharting', () => {
    assert.deepEqual(sources(cardSourceChain('zh-cn', { tcgdexId: 'CSV4C', pcSlug: 'pokemon-chinese-csv4c', cnName: '古代咆哮' })),
      ['tcgdex', 'pricecharting', '52poke']);
  });

  it('is the only source for a set with neither', () => {
    assert.deepEqual(sources(cardSourceChain('zh-cn', { tcgdexId: 'CS3AC', cnName: '洪荒演武 茂' })), ['tcgdex', '52poke']);
  });

  it('is never offered to Korean — Chinese sets are not the Japanese line', () => {
    // Only 12% of Chinese codes exist in ja, so the twin trick cannot work there and 52poke is
    // keyed on a Chinese name no other lane has.
    assert.deepEqual(sources(cardSourceChain('ko', { tcgdexId: 'S4A', cnName: '洪荒演武 茂' })), ['tcgdex']);
  });
});

describe('resolving the two extra chain inputs from the baked index', () => {
  const idx = {
    ja: [{ code: 'S4A', pcSlug: 'pokemon-japanese-shiny-star-v' }, { code: 'BW4', pcSlug: '' }],
    'zh-cn': [{ code: 'CS3AC', name_native: '洪荒演武 茂' }],
  };
  it('finds a Korean set\'s twin by its PRINTED CODE', () => {
    assert.equal(twinSlugFor('ko', 'S4A', idx), 'pokemon-japanese-shiny-star-v');
    assert.equal(twinSlugFor('ko', 's4a', idx), 'pokemon-japanese-shiny-star-v', 'case-insensitively');
    assert.equal(twinSlugFor('ko', 'BW4', idx), '', 'a twin with no console of its own is no help');
    assert.equal(twinSlugFor('ko', 'NOPE', idx), '');
  });
  it('refuses to resolve a twin for any lane but Korean', () => {
    for (const l of ['ja', 'en', 'zh-cn', 'zh-tw']) assert.equal(twinSlugFor(l, 'S4A', idx), '', l);
  });
  it('finds a Chinese set\'s native name, and only for zh-cn', () => {
    assert.equal(cnNameFor('zh-cn', 'CS3AC', idx), '洪荒演武 茂');
    assert.equal(cnNameFor('ja', 'CS3AC', idx), '');
    assert.equal(cnNameFor('zh-cn', 'NOPE', idx), '');
  });
});

describe('52poke wikitext parsing', () => {
  // Real rows from 洪荒演武 茂（TCG）.
  const WIKI = [
    '{{卡牌列表/header|白2|金|火红|rarity=yes|symbol=yes|num=no|image=SetSymbolCS3aC.png}}',
    '{{卡牌列表/entryjp|001/125|{{C|妙蛙花V|SEF}}|草||RR|}}',
    '{{卡牌列表/entryjp|002/125|{{C|妙蛙花VMAX|SEF}}|草||RRR|}}',
    '{{卡牌列表/entryjp|119/125|{{TCG|夏科娅}}|支援者卡||U|}}',
    '{{卡牌列表/entryjp|125/125|{{TCG|一击能量}}|能量卡|斗|U|}}',
    "{{卡牌列表/entryjp|131/125|{{C|时拉比V|S6K}}|草||SR|}}",
    '{{卡牌列表/footer}}',
  ].join('\n');

  it('splits on top-level pipes only — the name cell is itself a template', () => {
    // A plain regex reads the pipes INSIDE {{C|妙蛙花V|SEF}} as cell separators and hands back the
    // string "C" as every Pokémon's name. That was the first cut of this parser.
    assert.deepEqual(splitCells('{{卡牌列表/entryjp|001/125|{{C|妙蛙花V|SEF}}|草||RR|}}'),
      ['001/125', '{{C|妙蛙花V|SEF}}', '草', '', 'RR', '']);
  });

  it('reads a name out of either template shape', () => {
    assert.equal(cellName('{{C|妙蛙花V|SEF}}'), '妙蛙花V', 'Pokémon carry their Japanese origin set');
    assert.equal(cellName('{{TCG|夏科娅}}'), '夏科娅');
    assert.equal(cellName('{{TCG|页面标题|印刷名}}'), '印刷名', 'the DISPLAY half wins over the page title');
    assert.equal(cellName('裸名'), '裸名');
  });

  it('parses a card list with numbers, rarities and secrets', () => {
    const cards = parseCardList(WIKI);
    assert.equal(cards.length, 5);
    assert.deepEqual(cards[0], { numRaw: '1', name: '妙蛙花V', rarity: 'RR', type: '草' });
    assert.equal(cards[2].name, '夏科娅');
    assert.equal(cards[2].rarity, 'U');
    assert.equal(cards[4].numRaw, '131', 'a secret numbered past the printed total still counts');
    assert.equal(cards[4].rarity, 'SR');
  });

  it('strips the leading zeros the wiki prints, matching every other source', () => {
    assert.deepEqual(parseCardList('{{卡牌列表/entryjp|007/125|{{C|时拉比V|S6K}}|草||RR|}}')[0].numRaw, '7');
  });

  it('ignores the header, the footer and anything that is not a row', () => {
    assert.deepEqual(parseCardList('{{卡牌列表/header|x}}\nplain text\n{{卡牌列表/footer}}'), []);
    assert.deepEqual(parseCardList(''), []);
    assert.deepEqual(parseCardList(null), []);
  });

  it('de-duplicates a card the page lists twice across sub-tables', () => {
    const dup = '{{卡牌列表/entryjp|001/125|{{C|妙蛙花V|SEF}}|草||RR|}}\n{{卡牌列表/entryjp|001/125|{{C|妙蛙花V|SEF}}|草||RR|}}';
    assert.equal(parseCardList(dup).length, 1);
  });
});
