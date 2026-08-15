// test/unit/pokemon-intl.test.mjs — the non-English Pokémon vocabulary (lib/pokemon-intl.mjs).
//
// Everything here is pure, so these are plain value assertions. The BYTE parity against
// pokemon-listing-builder.html's inline copies is a separate concern and lives in
// scripts/check-listing-copy.mjs (wrapped by test/invariants/check-harnesses.test.mjs); what this
// file pins is the behaviour itself, including the cases the builder never exercises because it
// only ever asks about Japanese.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGS, STOCK_LANG_CODES, INTL_DATA_LANGS, langRow, codeFromLang, dataLangOf, isIntlLang,
  langEbayKeyword, stockLangs, setPlaceholder, intlIdentityKey, intlKeyLang, intlNumCandidates,
  setLookupId, setEnglishName, setNameIsCodeOnly, intlSetsFrom, resolveIntlSet,
  speciesKey, nativeInfo, englishCardName, intlPrintingsFor, intlFinishFallback,
  intlFinishOption, pcSearchUrl,
} from '../../lib/pokemon-intl.mjs';

// A stand-in for data/pokemon-dex-en.json, real enough to exercise both name-resolution paths.
const DEX = {
  dex: { 6: 'Charizard', 43: 'Oddish', 411: 'Bastiodon' },
  ja: { 'リザードン': 'Charizard', 'ナゾノクサ': 'Oddish', 'トリデプス': 'Bastiodon' },
  ko: { '리자몽': 'Charizard' },
  'zh-cn': { '喷火龙': 'Charizard' },
  romaji: { charizard: 'Lizardon', oddish: 'Nazonokusa', bastiodon: 'Torideps' },
};

describe('the language table', () => {
  it('resolves by label, by code, and by loose human spelling', () => {
    assert.equal(codeFromLang('Japanese'), 'JP');
    assert.equal(codeFromLang('JP'), 'JP');
    assert.equal(codeFromLang('繁體'), 'TW');
    assert.equal(codeFromLang('简体'), 'CN');
  });

  // An unrecognised language must not become a NEW language. English is the only answer that
  // changes no downstream behaviour: it is what every existing row already stores.
  it('falls back to English rather than inventing a lane', () => {
    assert.equal(codeFromLang('Klingon'), 'EN');
    assert.equal(codeFromLang(''), 'EN');
    assert.equal(codeFromLang(null), 'EN');
    assert.equal(dataLangOf('Klingon'), 'en');
  });

  // The European prints share English set identity and numbering, so they ride the pokemontcg.io
  // catalogue. Only their eBay keyword and the stored code differ.
  it('routes the European languages to the English catalogue but keeps their keyword', () => {
    for (const l of ['French', 'German', 'Italian', 'Spanish', 'Portuguese']) {
      assert.equal(dataLangOf(l), 'en', l);
      assert.equal(isIntlLang(l), false, l);
      assert.equal(langEbayKeyword(l), l, l);
    }
  });

  // English listings are UNMARKED on eBay: searching for the word "English" finds the few listings
  // that happen to say it, not the market. An empty keyword is the whole point.
  it('gives English no eBay keyword', () => {
    assert.equal(langEbayKeyword('English'), '');
    assert.equal(langEbayKeyword('Japanese'), 'Japanese');
    assert.equal(langEbayKeyword('Chinese (Trad.)'), 'Chinese');
  });

  it('offers the stock tools only lanes that have a catalogue behind them', () => {
    assert.deepEqual(stockLangs().map((l) => l.code), STOCK_LANG_CODES);
    assert.deepEqual(stockLangs().map((l) => l.dataLang), ['en', 'ja', 'zh-cn', 'zh-tw', 'ko']);
    for (const l of stockLangs()) assert.ok(LANGS.some((r) => r[0] === l.code), l.code);
    // Every intl lane the module names must be reachable from a stock language, or the picker
    // offers a language nothing can populate.
    for (const dl of INTL_DATA_LANGS) assert.ok(stockLangs().some((l) => l.dataLang === dl), dl);
  });

  it('gives each intl lane its own set-input hint', () => {
    assert.match(setPlaceholder('ja'), /Japanese/);
    assert.match(setPlaceholder('ko'), /Korean/);
    assert.match(setPlaceholder('zh-tw'), /Chinese/);
    assert.match(setPlaceholder('en'), /PAR|Paradox/);
  });
});

describe('intlIdentityKey', () => {
  it('carries the lane, lowercased', () => {
    assert.equal(intlIdentityKey('ja', 'M5', '102'), 'ja:m5-102');
    assert.equal(intlIdentityKey('zh-tw', 'SV8A', '102'), 'zh-tw:sv8a-102');
    assert.equal(intlIdentityKey('ko', 'SV6', '045'), 'ko:sv6-045');
  });

  // The whole point: the same printed code in two languages is two different cards, and both are
  // different again from the English set that shares the code.
  it('separates the same printed number across lanes', () => {
    const keys = INTL_DATA_LANGS.map((dl) => intlIdentityKey(dl, 'SV3', '102'));
    assert.equal(new Set(keys).size, keys.length, keys.join(' '));
    assert.ok(!keys.includes('sv3-102'), 'must never collide with the pokemontcg.io shape');
  });

  it('returns empty for English or for missing parts, so a caller cannot mint a junk key', () => {
    assert.equal(intlIdentityKey('en', 'sv3', '25'), '');
    assert.equal(intlIdentityKey('ja', '', '102'), '');
    assert.equal(intlIdentityKey('ja', 'M5', ''), '');
    assert.equal(intlIdentityKey('', 'M5', '102'), '');
  });

  it('round-trips its lane and reads English keys as no lane', () => {
    assert.equal(intlKeyLang('ja:m5-102'), 'ja');
    assert.equal(intlKeyLang('zh-tw:sv8a-102'), 'zh-tw');
    assert.equal(intlKeyLang('sv3-25'), null);
    assert.equal(intlKeyLang('swsh12pt5gg-gg01'), null);
    assert.equal(intlKeyLang(''), null);
    assert.equal(intlKeyLang(null), null);
  });
});

describe('intlNumCandidates', () => {
  it('tries the zero-padded form first — that is TCGdex’s convention', () => {
    assert.deepEqual(intlNumCandidates('1'), ['001', '1', '01']);
    assert.deepEqual(intlNumCandidates('25'), ['025', '25']);
    assert.deepEqual(intlNumCandidates('102'), ['102']);
  });

  // An inventory row stores the PRINTED number; the builder passes what was typed. Both have to
  // work, which is why the denominator is dropped before anything else.
  it('drops the /total so a printed number works as well as a typed one', () => {
    assert.deepEqual(intlNumCandidates('102/081'), ['102']);
    assert.deepEqual(intlNumCandidates('4/102'), ['004', '4', '04']);
  });

  it('passes non-numeric promo ids straight through', () => {
    assert.deepEqual(intlNumCandidates('TG01'), ['TG01']);
    assert.deepEqual(intlNumCandidates('SV-P'), ['SV-P']);
  });

  it('is empty for nothing', () => {
    assert.deepEqual(intlNumCandidates(''), []);
    assert.deepEqual(intlNumCandidates(null), []);
    assert.deepEqual(intlNumCandidates(undefined), []);
  });
});

describe('set names — the OUTPUT IS ENGLISH rule', () => {
  const M5 = { code: 'M5', tcgdexId: 'M5', name_native: 'アビスアイ', name_en: 'Abyss Eye', enEquivalent: { name: 'Pitch Black' } };
  const TW = { code: 'SV8A', tcgdexId: 'SV8A', name_native: '超電ブレイカー' };
  const CN = { code: 'CSV4C', tcgdexId: 'CSV4C', enEquivalent: { name: 'Paradox Rift' } };

  it('prefers the romanised name, then the English equivalent, then the code', () => {
    assert.equal(setEnglishName(M5), 'Abyss Eye');
    assert.equal(setEnglishName(CN), 'Paradox Rift');
    assert.equal(setEnglishName(TW), 'SV8A');
    assert.equal(setEnglishName(null), '');
  });

  // Inventing a romanisation would be a guess presented as fact (GR4), so the code IS the answer —
  // but the operator has to be told, because the eBay title will read "SV8A".
  it('flags the sets whose English name is really just the printed code', () => {
    assert.equal(setNameIsCodeOnly(TW), true);
    assert.equal(setNameIsCodeOnly(M5), false);
    assert.equal(setNameIsCodeOnly(CN), false);
  });

  it('looks a set up by its TCGdex id for intl and its pokemontcg.io id for English', () => {
    assert.equal(setLookupId(M5), 'M5');
    assert.equal(setLookupId({ id: 'sv3', name: 'Obsidian Flames' }), 'sv3');
  });

  it('resolves a set by any of the five names it goes under', () => {
    const list = [M5, TW, CN];
    for (const typed of ['M5', 'm5', 'アビスアイ', 'Abyss Eye', 'Pitch Black']) {
      assert.equal(resolveIntlSet(list, typed), M5, typed);
    }
    assert.equal(resolveIntlSet(list, 'CSV4C'), CN);
    assert.equal(resolveIntlSet(list, 'nothing at all'), null);
    assert.equal(resolveIntlSet([], 'M5'), null);
  });

  it('builds picker rows newest-first and marks the ones with a suspect name', () => {
    const rows = intlSetsFrom({
      ja: [
        { code: 'CS1', name_native: 'トリプレットビート', releaseDate: '2023-01-01', nameSuspect: true },
        { ...M5, releaseDate: '2026-05-22' },
      ],
    }, 'ja');
    assert.equal(rows[0].code, 'M5', 'newest first');
    assert.equal(rows[0].label, 'Abyss Eye');
    assert.equal(rows[1].suspect, true);
    assert.equal(rows[1].codeOnlyName, true);
    assert.deepEqual(intlSetsFrom({}, 'ja'), []);
  });
});

describe('card names — the OUTPUT IS ENGLISH rule', () => {
  it('resolves the species from dexId and keeps the printed Latin suffix', () => {
    assert.equal(englishCardName({ name: 'リザードンex', dexId: [6] }, DEX, 'ja'), 'Charizard ex');
    assert.equal(englishCardName({ name: 'ナゾノクサ', dexId: [43] }, DEX, 'ja'), 'Oddish');
  });

  // The high-value ex / full-art prints are exactly the ones that omit dexId, so the fallback is
  // not an edge case — it is the money.
  it('falls back to the native species map when dexId is absent', () => {
    assert.equal(englishCardName({ name: 'リザードンex' }, DEX, 'ja'), 'Charizard ex');
    assert.equal(englishCardName({ name: '리자몽' }, DEX, 'ko'), 'Charizard');
    assert.equal(englishCardName({ name: '喷火龙' }, DEX, 'zh-cn'), 'Charizard');
  });

  // A half-translated name is worse than none: the operator can see the field is empty and type it,
  // but cannot see that "Charizard &" lost its other half.
  it('resolves a multi-species name only when EVERY part resolves', () => {
    const dex = { ...DEX, ja: { ...DEX.ja, 'カビゴン': 'Snorlax' } };
    assert.equal(englishCardName({ name: 'リザードン&カビゴンGX' }, dex, 'ja'), 'Charizard & Snorlax GX');
    assert.equal(englishCardName({ name: 'リザードン&ミュウツーGX' }, dex, 'ja'), 'GX');
  });

  it('returns the Latin remnant (often empty) for a Trainer with no English source', () => {
    assert.equal(englishCardName({ name: 'ボスの指令' }, DEX, 'ja'), '');
    assert.equal(englishCardName({ name: 'Iron Leaves ex', dexId: [] }, DEX, 'ja'), 'Iron Leaves ex');
    assert.equal(englishCardName({ name: '' }, DEX, 'ja'), '');
    assert.equal(englishCardName(null, DEX, 'ja'), '');
  });

  it('strips card affixes to find the species', () => {
    assert.equal(speciesKey('Mega Charizard ex'), 'charizard');
    assert.equal(speciesKey('Pikachu VMAX'), 'pikachu');
    assert.equal(speciesKey('M Gardevoir EX'), 'gardevoir');
    assert.equal(speciesKey(''), '');
  });
});

describe('nativeInfo', () => {
  it('gives the native script and, for Japanese only, the romaji', () => {
    assert.deepEqual(nativeInfo(DEX, 'ja', 'Charizard'), { native: 'リザードン', romaji: 'Lizardon' });
    assert.deepEqual(nativeInfo(DEX, 'ja', 'Charizard ex'), { native: 'リザードン', romaji: 'Lizardon' });
  });

  // The builder's inline copy reads DEX_EN.ja unconditionally — correct there only because it is
  // called on the JP lane alone. Generalised here, a Korean card must get hangul, and no romaji at
  // all rather than a Japanese romanisation of a Korean name (GR4).
  it('does not answer a Korean card with Japanese script', () => {
    assert.deepEqual(nativeInfo(DEX, 'ko', 'Charizard'), { native: '리자몽', romaji: '' });
    assert.deepEqual(nativeInfo(DEX, 'zh-cn', 'Charizard'), { native: '喷火龙', romaji: '' });
  });

  it('is blank for English, an unmapped name, or a missing dex', () => {
    assert.deepEqual(nativeInfo(DEX, 'en', 'Charizard'), { native: '', romaji: '' });
    assert.deepEqual(nativeInfo(DEX, 'ja', 'Boss’s Orders'), { native: '', romaji: '' });
    assert.deepEqual(nativeInfo(null, 'ja', 'Charizard'), { native: '', romaji: '' });
  });
});

describe('printings come from DATA (GR5)', () => {
  // TCGdex's card record carries a real variants object, so an intl card gets the same treatment an
  // English one does — and the keys emitted here ARE the pokemontcg.io keys, so printingOrder,
  // pickPrinting and the catch line's n|r|h tokens all keep working unchanged.
  it('reads the variants object, in printing order', () => {
    const both = intlPrintingsFor({ variants: { normal: true, holo: true, reverse: false, firstEdition: false } });
    assert.deepEqual(both.map((p) => p.key), ['normal', 'holofoil']);
    assert.deepEqual(both.map((p) => p.variant), ['Base', 'Holo']);
  });

  it('reads a holo-only chase print as Holo, not as the plain card', () => {
    const holo = intlPrintingsFor({ variants: { normal: false, holo: true, reverse: false, firstEdition: false } });
    assert.deepEqual(holo.map((p) => p.key), ['holofoil']);
    assert.equal(holo[0].variant, 'Holo');
  });

  it('keeps reverse holo distinct', () => {
    const rev = intlPrintingsFor({ variants: { normal: true, reverse: true, holo: false, firstEdition: false } });
    assert.deepEqual(rev.map((p) => p.variant), ['Base', 'Reverse Holo']);
  });

  it('folds first edition into the variant token, so the two printings never merge', () => {
    const fe = intlPrintingsFor({ variants: { normal: true, holo: true, reverse: false, firstEdition: true } });
    assert.deepEqual(fe.map((p) => p.key), ['1stEditionNormal', '1stEditionHolofoil']);
    for (const p of fe) assert.match(p.variant, /1st Edition/);
  });

  // TCGdex quotes Cardmarket in EUR and this field is consumed as USD everywhere it is read.
  // A euro figure here would be wrong by the FX rate and silently so (GR3).
  it('never reports a market price', () => {
    for (const p of intlPrintingsFor({ variants: { normal: true, holo: true } })) assert.equal(p.marketUsd, null);
  });

  it('is empty when there is no variants object to read', () => {
    assert.deepEqual(intlPrintingsFor({}), []);
    assert.deepEqual(intlPrintingsFor(null), []);
    assert.deepEqual(intlPrintingsFor({ variants: null }), []);
  });

  // The runner's per-set index is TCGdex's SET endpoint, which serves briefs and no variants at
  // all. 'Non-holo' under-promises, and it is NOT flagged fromRarity because it is a declared
  // default rather than a guess read out of a rarity string — the distinction the grid's
  // `from rarity` chip exists to draw.
  it('falls back to the under-promising printing, unflagged', () => {
    assert.deepEqual(intlFinishFallback(), { finish: 'Non-holo', variant: 'Base', fromRarity: false });
  });

  // The printing matrix speaks the SOURCE vocabulary and the Finish dropdown speaks the SELLER
  // vocabulary. They look interchangeable and are not — 'Normal' is not an option on the dropdown,
  // so matching on it found nothing, left the select on the PREVIOUS card's value, and a Common
  // Cacnea was about to be listed as Holo.
  it('translates a printing into the words the Finish dropdown actually offers', () => {
    const opts = ['Holo', 'Reverse Holo', 'Non-holo', 'Foil'];   // pokemon.finishOptions
    for (const v of [{ variants: { normal: true } }, { variants: { holo: true } }, { variants: { reverse: true, normal: true } }]) {
      for (const p of intlPrintingsFor(v)) {
        assert.ok(opts.includes(intlFinishOption(p)), `${p.variant} -> ${intlFinishOption(p)}`);
      }
    }
    assert.equal(intlFinishOption(intlPrintingsFor({ variants: { normal: true } })[0]), 'Non-holo');
    assert.equal(intlFinishOption(intlPrintingsFor({ variants: { holo: true } })[0]), 'Holo');
    assert.equal(intlFinishOption(intlPrintingsFor({ variants: { reverse: true } })[0]), 'Reverse Holo');
  });

  it('under-promises rather than guessing when there is no printing at all', () => {
    assert.equal(intlFinishOption(null), 'Non-holo');
    assert.equal(intlFinishOption(undefined), 'Non-holo');
    assert.equal(intlFinishOption({ variant: 'Something Else' }), 'Non-holo');
  });
});

describe('pcSearchUrl', () => {
  it('strips CJK, keeps the Latin affix, and names the right console language', () => {
    const u = pcSearchUrl('Charizard ex', '125/108', 'Ruler of the Black Flame', 'JP');
    assert.match(decodeURIComponent(u), /Charizard ex 125 Ruler of the Black Flame japanese pokemon/);
    assert.match(decodeURIComponent(pcSearchUrl('Cacnea', '001/078', 'SV1S', 'TW')), /chinese pokemon/);
    assert.match(decodeURIComponent(pcSearchUrl('Cacnea', '1', 'SV3', 'KO')), /korean pokemon/);
  });

  it('drops a name that is entirely CJK rather than sending script PriceCharting cannot match', () => {
    assert.equal(/%E3%83%AA/.test(pcSearchUrl('リザードン', '125', 'SV3', 'JP')), false);
  });
});
