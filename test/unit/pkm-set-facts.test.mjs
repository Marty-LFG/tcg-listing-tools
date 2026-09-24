// test/unit/pkm-set-facts.test.mjs — the per-set printing facts no upstream carries
// (lib/listing-copy.mjs pkmSetFacts), and every place that reads them.
//
// 30th Celebration (2026-09-16) is where these came from. pokemontcg.io had the set on release day
// but no TCGplayer prices for it a week later, and three things were wrong until then:
//   - every card in the set is holofoil, commons included, but a card with no price keys fell to
//     the rarity guess — 71 of the 161 main-set cards were titled and floored as non-holo (GR5);
//   - the three YOSHIROTTEN Mews print R/RGB, G/RGB and B/RGB, and came out R/128 (GR10);
//   - the Classic Collection reprints keep their ORIGINAL number (Charizard 4/102 under a 30
//     stamp, checked against a photo of the card), and came out 004/030, a number on no card.
// Every printed number below is TCGplayer's own for the product.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The enumerator reads lib/pkm-cards-cache.mjs; point it at a throwaway folder BEFORE importing, or
// the stubbed set below would be written into the real cache (scripts/check-enumerate.mjs does the same).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-setfacts-'));
process.env.PKM_CARDS_CACHE_DIR = TMP;

const {
  formatCardNumber, cardNumberKey, pkmSetFacts, pkmIdForPrinted, pkmSharedCount, pkmRarityFor,
} = await import('../../lib/listing-copy.mjs');
const { adapterFor, uniqueSetCodes } = await import('../../lib/stock-games.mjs');
const { parseCatch, numKeys } = await import('../../lib/runner-core.mjs');
const { ENUMERATORS } = await import('../../lib/enumerate.mjs');

const pk = adapterFor('pokemon');
const ME = { series: 'Mega Evolution', releaseDate: '2026/09/16' };
const ME55 = { ...ME, id: 'me55', name: '30th Celebration', ptcgoCode: '30C', printedTotal: 128, total: 161 };
const ME55C = { ...ME, id: 'me55c', name: '30th Celebration: Classic Collection', ptcgoCode: '30C', total: 30 };
const card = (id, number, name, rarity, set, prices) => ({
  id, number, name, rarity, set, images: { small: 's', large: 'l' }, ...(prices ? { tcgplayer: { prices } } : {}),
});

describe('the table itself', () => {
  it('every card row is internally consistent', () => {
    for (const key of pkmSetFacts('*')) {
      const f = pkmSetFacts(key);
      if (!f.cards) continue;
      const ids = new Set();
      for (const [raw, printed, id] of f.cards) {
        // The raw upstream number IS the printed numerator — the table only ever adds a denominator.
        assert.equal(cardNumberKey(printed.split('/')[0]), cardNumberKey(raw), key + ' ' + id);
        assert.ok(id.startsWith(key + '-'), key + ': ' + id + ' is not a card of this set');
        assert.ok(!ids.has(id), key + ': ' + id + ' twice');
        ids.add(id);
      }
    }
  });
  it('holds exactly the sets it was checked for', () => {
    assert.deepEqual(pkmSetFacts('*').sort(), ['cel25', 'cel25c', 'ja:M6A', 'ko:M6A', 'me55', 'me55c']);
    assert.equal(pkmSetFacts('sv1'), null);
    assert.equal(pkmSetFacts(''), null);
  });
  it('the Classic Collection and Celebrations tables are complete (30 and 25 cards)', () => {
    assert.equal(pkmSetFacts('me55c').cards.length, 30);
    assert.equal(pkmSetFacts('cel25c').cards.length, 25);
  });
});

describe('formatCardNumber — printed numbers the era rule cannot rebuild (GR10)', () => {
  it('an ordinary 30th Celebration card still runs the era rule (001/128, 158/128)', () => {
    assert.equal(formatCardNumber('1', ME55, { id: 'me55-1' }), '001/128');
    assert.equal(formatCardNumber('158', ME55, { id: 'me55-158' }), '158/128');
  });
  it('the RGB Mews print R/RGB, G/RGB, B/RGB — not R/128', () => {
    assert.equal(formatCardNumber('R', ME55, { id: 'me55-R' }), 'R/RGB');
    assert.equal(formatCardNumber('G', ME55, {}), 'G/RGB');
    assert.equal(formatCardNumber('B', ME55), 'B/RGB');
  });
  it('a Classic Collection reprint keeps its original number (4/102, not 004/030)', () => {
    assert.equal(formatCardNumber('4', ME55C, { id: 'me55c-4' }), '4/102');
    assert.equal(formatCardNumber('4', ME55C, {}), '4/102');
    assert.equal(formatCardNumber('50', ME55C, { id: 'me55c-50' }), '050/185');   // a Sword & Shield original stays padded
  });
  it('the card id picks between the three #106s', () => {
    assert.equal(formatCardNumber('106', ME55C, { id: 'me55c-106' }), '106/105');
    assert.equal(formatCardNumber('106', ME55C, { id: 'me55c-106p' }), '106/106');
    assert.equal(formatCardNumber('106', ME55C, { id: 'me55c-106m' }), '106/160');
  });
  it('a shared number with no id gets NO denominator rather than another card\'s', () => {
    assert.equal(formatCardNumber('106', ME55C, {}), '106');
    assert.equal(formatCardNumber('15', { id: 'cel25c', name: 'Celebrations: Classic Collection', printedTotal: 25, total: 25 }), '15');
  });
  it('a reprint subset never takes its own total, even for a card the table lacks', () => {
    assert.equal(formatCardNumber('999', ME55C, {}), '999');
  });
  it('the set is read off the id when the caller has no set object (a stored inventory row)', () => {
    assert.equal(formatCardNumber('106', {}, { id: 'me55c-106p' }), '106/106');
    assert.equal(formatCardNumber('4', { name: 'whatever' }, { id: 'cel25c-4_A' }), '4/102');
  });
  it('fixes Celebrations: Classic Collection too (4/102, not 004/025)', () => {
    const CEL25C = { id: 'cel25c', series: 'Sword & Shield', releaseDate: '2021/10/08', name: 'Celebrations: Classic Collection', printedTotal: 25, total: 25 };
    assert.equal(formatCardNumber('4', CEL25C, { id: 'cel25c-4_A' }), '4/102');
    assert.equal(formatCardNumber('15', CEL25C, { id: 'cel25c-15_A2' }), '15/82');
  });
  it('never touches the intl lanes or any other set', () => {
    // tcgdex lane: its own rule (numerator verbatim, denominator padded), never the table's 4/102
    assert.equal(formatCardNumber('4', { ...ME55C, printedTotal: 30 }, { source: 'tcgdex' }), '4/30');
    assert.equal(formatCardNumber('12', { series: 'Scarlet & Violet', releaseDate: '2025/07/18', id: 'sv10pt5', name: 'White Flare', printedTotal: 86, total: 173 }, { id: 'sv10pt5-12' }), '012/086');
  });
});

describe('pkmIdForPrinted / pkmSharedCount — typing the number that is on the card', () => {
  it('the denominator names the card where the set reuses numbers', () => {
    assert.equal(pkmIdForPrinted('me55c', '106/106'), 'me55c-106p');
    assert.equal(pkmIdForPrinted('me55c', '106/105'), 'me55c-106');
    assert.equal(pkmIdForPrinted('me55c', '106/160'), 'me55c-106m');
    assert.equal(pkmIdForPrinted('cel25c', '15/132'), 'cel25c-15_A3');
  });
  it('a bare number names a card only when one card carries it', () => {
    assert.equal(pkmIdForPrinted('me55c', '106'), '');
    assert.equal(pkmIdForPrinted('cel25c', '4'), 'cel25c-4_A');   // an id nothing typed could reach before
    assert.equal(pkmIdForPrinted('me55', 'R/RGB'), 'me55-R');
  });
  it('is padding-insensitive and silent outside the table', () => {
    assert.equal(pkmIdForPrinted('me55c', '50/185'), 'me55c-50');
    assert.equal(pkmIdForPrinted('me55', '1'), '');
    assert.equal(pkmIdForPrinted('sv1', '1'), '');
  });
  it('counts the cards on a shared number', () => {
    assert.equal(pkmSharedCount('me55c', '106'), 3);
    assert.equal(pkmSharedCount('me55c', '106/106'), 3);   // the numerator is what is shared
    assert.equal(pkmSharedCount('cel25c', '15'), 4);
    assert.equal(pkmSharedCount('me55c', '4'), 1);
    assert.equal(pkmSharedCount('sv1', '4'), 0);
  });
});

describe('pkmRarityFor — upstream corrections', () => {
  it('the RGB Mews are Holo Rare, not the Common pokemontcg.io says', () => {
    assert.equal(pkmRarityFor(card('me55-R', 'R', 'Mew', 'Common', ME55)), 'Holo Rare');
  });
  it('leaves everything else as upstream has it', () => {
    assert.equal(pkmRarityFor(card('me55-1', '1', 'Exeggcute', 'Common', ME55)), 'Common');
    assert.equal(pkmRarityFor({ id: 'x', rarity: 'Rare' }), 'Rare');
    assert.equal(pkmRarityFor(null), '');
  });
});

describe('stock adapter — holo-only sets (GR5)', () => {
  it('a 30th Celebration common with no price keys yet is Holofoil, not a rarity guess', () => {
    const c = card('me55-1', '1', 'Exeggcute', 'Common', ME55);
    const p = pk.printingsFor(c);
    assert.equal(p.length, 1);
    assert.equal(p[0].finish, 'Holofoil');
    assert.equal(p[0].variant, 'Holo');
    assert.equal(p[0].marketUsd, null);
    assert.equal(pk.holoOnly(c), true);
  });
  it('real price keys win the moment they arrive', () => {
    const c = card('me55-1', '1', 'Exeggcute', 'Common', ME55, { holofoil: { market: 0.4 } });
    assert.deepEqual(pk.printingsFor(c).map((x) => [x.key, x.marketUsd]), [['holofoil', 0.4]]);
  });
  it('an ordinary set is untouched — a priceless common still falls through to the old fallback', () => {
    const c = card('sv1-1', '1', 'Pineco', 'Common', { id: 'sv1', name: 'Scarlet & Violet' });
    assert.deepEqual(pk.printingsFor(c), []);
    assert.equal(pk.holoOnly(c), false);
    assert.equal(pk.finishFallback(c).finish, 'Normal');
  });
  it('the Japanese M6a is holo-only too (every card is kira, C and U included)', () => {
    const set = { code: 'M6A', cardCount: 103, serie: 'ポケモンカードゲーム MEGA', releaseDate: '2026-09-16', name_en: '30th Celebration' };
    const c = pk.intlCard({ lang: 'JP', set, localId: '1', name: 'Exeggcute', source: 'pricecharting' });
    assert.equal(pk.printingsFor(c)[0].finish, 'Holofoil');
    assert.equal(pk.cardNumber(c), '001/103');
    const classic = pk.intlCard({ lang: 'JP', set, localId: '137', name: 'Charizard', source: 'pricecharting' });
    assert.equal(pk.cardNumber(classic), '137/103');   // numbered inside the set there, unlike English
  });
  it('normalizeCard carries the printed number and the corrected rarity', () => {
    const palkia = pk.normalizeCard(card('me55c-106p', '106', 'Palkia LV.X', 'Rare Holo LV.X', ME55C), {});
    assert.equal(palkia.number, '106/106');
    const mew = pk.normalizeCard(card('me55-R', 'R', 'Mew', 'Common', ME55), {});
    assert.equal(mew.number, 'R/RGB');
    assert.equal(mew.rarity, 'Holo Rare');
    assert.equal(mew.setCode, '30C');   // the row keeps the PRINTED code, whatever the picker calls it
  });
});

describe('uniqueSetCodes — a subset is reachable by typing', () => {
  const list = () => pk.setsFrom({ data: [
    { id: 'me55', name: '30th Celebration', ptcgoCode: '30C', releaseDate: '2026/09/16' },
    { id: 'me55c', name: '30th Celebration: Classic Collection', ptcgoCode: '30C', releaseDate: '2026/09/16' },
    { id: 'swsh9tg', name: 'Brilliant Stars Trainer Gallery', ptcgoCode: 'BRS', releaseDate: '2022/02/25' },
    { id: 'swsh9', name: 'Brilliant Stars', ptcgoCode: 'BRS', releaseDate: '2022/02/25' },
    { id: 'sv1', name: 'Scarlet & Violet', ptcgoCode: 'SVI', releaseDate: '2023/03/31' },
  ] });
  const code = (v) => list().find((s) => s.value === v).code;
  it('the parent keeps the printed code, whichever order upstream lists them in', () => {
    assert.equal(code('me55'), '30C');
    assert.equal(code('swsh9'), 'BRS');
  });
  it('the subset answers to its own set id', () => {
    assert.equal(code('me55c'), 'ME55C');
    assert.equal(code('swsh9tg'), 'SWSH9TG');
  });
  it('a code nobody shares is left alone, and no two sets end up sharing one', () => {
    assert.equal(code('sv1'), 'SVI');
    const codes = list().map((s) => s.code);
    assert.equal(new Set(codes).size, codes.length);
  });
  it('is exported for reuse and a no-op on an empty list', () => {
    assert.deepEqual(uniqueSetCodes([]), []);
  });
});

describe('the catch line — a lettered number', () => {
  it('R/RGB is a card number; a bare r is still reverse holo', () => {
    assert.equal(parseCatch('R/RGB').num, 'R/RGB');
    assert.equal(parseCatch('R/RGB').printing, null);
    assert.equal(parseCatch('r').printing, 'reverseHolofoil');
    assert.equal(parseCatch('r').num, null);
    assert.deepEqual(numKeys('R/RGB'), ['R']);   // the number pokemontcg.io stores
  });
  it('the subset\'s own code switches set; the printed code still picks the parent', () => {
    const setCodes = new Set(['30C', 'ME55C']);
    assert.equal(parseCatch('me55c', { setCodes }).setCode, 'ME55C');
    assert.equal(parseCatch('30c 4', { setCodes }).setCode, '30C');
  });
});

describe('ENUMERATORS.pokemon — a priceless holo-only set enumerates as Holo', () => {
  it('commons come out holofoil, and the RGB Mew with its printed number and rarity', async () => {
    const realFetch = globalThis.fetch;
    const page = { totalCount: 3, data: [
      card('me55-1', '1', 'Exeggcute', 'Common', ME55),
      card('me55-R', 'R', 'Mew', 'Common', ME55),
      card('me55-30', '30', 'Pikachu', 'Pikachu Rare', ME55),
    ] };
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(page) });
    const rows = [];
    try {
      for await (const out of ENUMERATORS.pokemon({ base: 'http://stub', env: {}, setId: 'me55', filters: {} })) if (out.row) rows.push(out.row);
    } finally { globalThis.fetch = realFetch; }
    const by = Object.fromEntries(rows.map((r) => [r.identity_key, r]));
    assert.equal(rows.length, 3);
    assert.equal(by['me55-1'].printing_key, 'holofoil');
    assert.equal(by['me55-1'].variant, 'Holo');
    assert.equal(by['me55-R'].number, 'R/RGB');
    assert.equal(by['me55-R'].rarity, 'Holo Rare');
    assert.equal(by['me55-30'].number, '030/128');
  });
});
