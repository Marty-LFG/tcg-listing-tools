// lib/pokemon-intl.mjs — the language vocabulary for non-English Pokémon.
//
// English Pokémon comes from pokemontcg.io. Japanese, both Chinese scripts and Korean do not exist
// there at all, so they come from TCGdex (card record + native names) and PriceCharting (English
// names + full-res images + a price ladder), indexed by the baked data/pokemon-intl-sets.json.
//
// pokemon-listing-builder.html has done this for one card at a time for a long time. The stock
// tools now do it too, so the rules move here rather than being copied a third time. Everything
// below is PURE: no node imports, no DOM, no fetch, no globals — the same contract as
// lib/runner-core.mjs and lib/stock-games.mjs, so the pages load it with <script type="module">,
// the server imports it, and test/unit/pokemon-intl.test.mjs imports it directly.
//
// MIRROR RULE (Golden Rule 9): pokemon-listing-builder.html is a classic <script> and cannot
// import, so it keeps its own inline copies of LANGS / speciesKey / nativeInfo / englishCardName /
// intlNumCandidates / setEnglishName / setLookupId. scripts/check-listing-copy.mjs pins the two
// sides together. Edit one, edit the other, then run `node scripts/check-listing-copy.mjs`.

import { variantToken, PRINTING_TO_FINISH, PRINTING_TO_EDITION } from './listing-copy.mjs';

// ---------------------------------------------------------------------------
// The language table
// ---------------------------------------------------------------------------

// [code, label, dataLang, ebayKeyword] — VERBATIM MIRROR of pokemon-listing-builder.html LANGS.
//
// `dataLang` is the CATALOGUE lane, not the language: 'en' means pokemontcg.io, which is also
// where every European print lives, because those share English set identity and numbering. Only
// ja / zh-cn / zh-tw / ko have a catalogue of their own (the baked TCGdex index).
//
// `ebayKeyword` is what a seller puts in an eBay title. English is deliberately EMPTY: English
// listings are unmarked, so searching for the word "English" finds the handful of listings that
// say it rather than the market.
export const LANGS = [
  ['EN', 'English', 'en', ''],
  ['JP', 'Japanese', 'ja', 'Japanese'],
  ['CN', 'Chinese (Simp.)', 'zh-cn', 'Chinese'],
  ['TW', 'Chinese (Trad.)', 'zh-tw', 'Chinese'],
  ['KO', 'Korean', 'ko', 'Korean'],
  ['FR', 'French', 'en', 'French'],
  ['DE', 'German', 'en', 'German'],
  ['IT', 'Italian', 'en', 'Italian'],
  ['ES', 'Spanish', 'en', 'Spanish'],
  ['PT', 'Portuguese', 'en', 'Portuguese'],
];

// What the STOCK tools offer. A deliberate subset of LANGS: these are the five lanes that have a
// catalogue behind them, and a language the picker cannot populate is a dead menu entry. The
// builder keeps all ten because it needs no catalogue to relabel a card the owner typed by hand.
export const STOCK_LANG_CODES = ['EN', 'JP', 'CN', 'TW', 'KO'];

// The TCGdex lanes — i.e. everything that is NOT served by pokemontcg.io.
export const INTL_DATA_LANGS = ['ja', 'zh-cn', 'zh-tw', 'ko'];

// VERBATIM MIRROR of the builder's langRow(). Accepts a label ('Japanese'), a code ('JP') or a
// loose human spelling, and never returns undefined — an unrecognised value is English, which is
// the safe default because it is the only one that changes no behaviour.
export function langRow(name) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return LANGS[0];
  return LANGS.find((l) => l[1].toLowerCase() === n)
    || LANGS.find((l) => l[0].toLowerCase() === n)
    || (/(trad|繁)/i.test(name) ? LANGS[3] : (/(chin|中文|简|simp)/i.test(name) ? LANGS[2] : null))
    || LANGS[0];
}

export const codeFromLang = (name) => langRow(name)[0];
export const labelFromLang = (name) => langRow(name)[1];
export const dataLangOf = (name) => langRow(name)[2];
export const isIntlLang = (name) => dataLangOf(name) !== 'en';
export const langEbayKeyword = (name) => langRow(name)[3];

// The stock pages' <select> rows.
export const stockLangs = () =>
  STOCK_LANG_CODES.map((c) => LANGS.find((l) => l[0] === c))
    .filter(Boolean)
    .map(([code, label, dataLang, ebayKeyword]) => ({ code, label, dataLang, ebayKeyword }));

// VERBATIM MIRROR of the builder's setPlaceholder().
export function setPlaceholder(dataLang) {
  switch (dataLang) {
    case 'ja': return 'Japanese set code or name, e.g. M5 or Abyss Eye';
    case 'zh-cn': case 'zh-tw': return 'Chinese set code or name, e.g. CSV4C';
    case 'ko': return 'Korean set code or name, e.g. SV3';
    default: return 'set name or printed code, e.g. PAR or Paradox Rift';
  }
}

// ---------------------------------------------------------------------------
// Identity — why intl keys carry their lane
// ---------------------------------------------------------------------------

// TCGdex uses the PRINTED SET CODE as its set id, and those codes are NOT unique across languages
// or against pokemontcg.io. Counted against the live English set list: 44 intl codes are also
// pokemontcg.io set ids (SV3, SV6-SV10, SM6-SM12, XY2-XY10, NEO1-NEO4), and 106 of 285 distinct
// intl codes are shared by two or more intl languages — Korean and Traditional-Chinese sets ARE
// Japanese sets translated, so they reuse the code. Un-namespaced, a Japanese SV3-102, a Korean
// SV3-102 and English sv3-102 (Obsidian Flames) are one key, and /api/inventory/match selects on
// identity_key with no game and no language filter, so the lanes genuinely meet.
//
// The COLON is load-bearing, not decoration. lib/set-cache.mjs SET_ID_RE is
// /^[a-z0-9][a-z0-9.-]{0,40}$/i — no colon — so cachedCardById('ja:m5-102') splits at the last '-',
// fails isSetId and returns null, and readCache/writeCache refuse the string outright. Serving an
// intl card out of an English cache file is therefore structurally impossible rather than merely
// unlikely.
export function intlIdentityKey(dataLang, setCode, localId) {
  const l = String(dataLang || '').trim().toLowerCase();
  const s = String(setCode || '').trim().toLowerCase();
  const n = String(localId == null ? '' : localId).trim().toLowerCase();
  if (!l || l === 'en' || !s || !n) return '';
  return `${l}:${s}-${n}`;
}

// Read the lane back off a key. Returns null for an English key, so callers can branch without
// knowing the format. `identity_key` is opaque everywhere else in the app on purpose.
export function intlKeyLang(identityKey) {
  const m = String(identityKey || '').match(/^([a-z-]+):/);
  return m && m[1] !== 'en' ? m[1] : null;
}

// TCGdex localIds are zero-padded ("001", "025"); a user types "1" / "25". Try the 3-digit form
// first (the convention), then the bare number, then 2-pad — and pass non-numeric promo ids
// (TG01, SV-P) straight through.
//
// The `/total` is dropped first because the two callers disagree about what they hold: the builder
// passes what the operator typed ("25"), while an inventory row stores the PRINTED number
// ("102/081"). Stripping is a no-op on the first and essential on the second — lib/inventory.mjs
// carried its own copy that did this, and this is that copy folded in rather than a third rule.
// VERBATIM MIRROR of pokemon-listing-builder.html intlNumCandidates().
// A pad is only ever added when it LENGTHENS the number. `('0'+i).slice(-2)` reads as "2-pad" but
// on a 3-digit number it truncates: card 102 produced the candidate '02', so a printed 102 that
// missed on both real forms fell through to card 2 and returned it as a confident match — which,
// on the path this feeds (lib/inventory.mjs resolveIntlImage), pins another card's artwork to the
// listing. Same reasoning for the 3-pad and a 4-digit number.
export function intlNumCandidates(num) {
  const n = String(num == null ? '' : num).split('/')[0].trim();
  const out = [];
  if (/^\d+$/.test(n)) {
    const s = String(parseInt(n, 10));
    if (s.length < 3) out.push(s.padStart(3, '0'));
    out.push(s);
    if (s.length < 2) out.push(s.padStart(2, '0'));
  } else if (n) {
    out.push(n, n.toUpperCase());
  }
  return out.filter((v, ix, a) => v && a.indexOf(v) === ix);
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

// The id used for the card lookup + image path (EN: pokemontcg.io id; intl: TCGdex printed code).
export const setLookupId = (s) => (s ? (s.tcgdexId !== undefined ? s.tcgdexId : s.id) : '');

// The English SET name for the listing output — never the native (Japanese/Chinese/Korean) name.
// The rail font cannot draw CJK and an AU buyer cannot search it.
export const setEnglishName = (s) => (s ? (s.name_en || (s.enEquivalent && s.enEquivalent.name) || s.code || '') : '');

// TRUE when the "English name" above is really just the printed code, because the bake has no
// romanised name for this set. That is not a bug and must not be papered over — inventing a
// romanisation is GR4 — but the operator should be TOLD, because the eBay title will read
// "SV8A" where an English listing would read "Surging Sparks". Counted in the current bake:
// no name_en for 152/269 ja, 64/65 zh-cn, 98/98 zh-tw, 95/101 ko. The fix is to seed the set
// through catalog.html, which writes data/pokemon-intl-seed.json.
export function setNameIsCodeOnly(s) {
  if (!s) return false;
  if (s.name_en || (s.enEquivalent && s.enEquivalent.name)) return false;
  return !!s.code;
}

// One baked intl set record -> the row shape TCG.setCombobox consumes, matching what
// STOCK_GAME_ADAPTERS.pokemon.setsFrom() returns for English.
//
// `suspect` marks a set the bake flagged with nameSuspect: TCGdex sometimes returns ONE set's
// identity for a whole block of distinct codes (all fifteen JP CS* ids come back as
// トリプレットビート). The set is still pickable — the CODE is right even when the name is not —
// but the picker says so rather than showing a name that belongs to a different set.
export function intlSetsFrom(bake, dataLang) {
  const list = (bake && bake[dataLang]) || [];
  return list.map((s) => ({
    value: s.code || s.pcSlug || '',
    label: setEnglishName(s) || s.name_native || s.code || '?',
    code: String(s.code || '').toUpperCase(),
    icon: s.symbol || '',
    releaseDate: s.releaseDate || '',
    nameNative: s.name_native || '',
    suspect: !!s.nameSuspect,
    codeOnlyName: setNameIsCodeOnly(s),
    raw: s,
  })).sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate)));
}

// The five ways a set can be named, so M5 / アビスアイ / Abyss Eye / Pitch Black all resolve M5.
// MIRROR of the builder's resolveSet() intl branch.
export function resolveIntlSet(list, typed) {
  const t = String(typed || '').trim().toLowerCase();
  if (!t || !list || !list.length) return null;
  const disp = t.replace(/\s*\([^)]*\)\s*$/, '');
  const tu = t.toUpperCase();
  const eqName = (s) => (s.enEquivalent && (s.enEquivalent.name || '').toLowerCase()) || '';
  return list.find((s) => String(s.code || '').toUpperCase() === tu
      || String(s.tcgdexId || '').toUpperCase() === tu
      || String(s.name_native || '').toLowerCase() === disp
      || String(s.name_en || '').toLowerCase() === disp
      || eqName(s) === disp)
    || list.find((s) => String(s.name_native || '').toLowerCase().includes(disp)
      || String(s.name_en || '').toLowerCase().includes(disp)
      || eqName(s).includes(disp)
      || String(s.code || '').toLowerCase().includes(t))
    || null;
}

// ---------------------------------------------------------------------------
// Names — the OUTPUT IS ENGLISH rule
// ---------------------------------------------------------------------------

// Strip the card affixes so a name resolves to its species: "Mega Charizard ex" -> "charizard".
// VERBATIM MIRROR of the builder's speciesKey().
export function speciesKey(name) {
  let s = String(name == null ? '' : name).trim();
  s = s.replace(/^(mega|m)\s+/i, '');
  s = s.replace(/\s+(ex|gx|v|vmax|vstar|v-?union|break|prime|star|lv\.?x)\b.*$/i, '');
  return s.trim().toLowerCase();
}

// Invert dex[dataLang] (native -> English) into English -> native. Cached per (dex, lang) pair so
// a batch does not rebuild a 1,025-entry map per card.
const _inverseCache = new WeakMap();
function inverseDex(dex, dataLang) {
  if (!dex || typeof dex !== 'object') return {};
  let perLang = _inverseCache.get(dex);
  if (!perLang) { perLang = {}; _inverseCache.set(dex, perLang); }
  if (perLang[dataLang]) return perLang[dataLang];
  const src = dex[dataLang] || {};
  const out = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (!v) continue;
    const lv = String(v).toLowerCase();
    if (!out[lv]) out[lv] = k;                 // first wins, like the builder's en2ja()
  }
  perLang[dataLang] = out;
  return out;
}

// English species name -> { native, romaji } for the description's provenance row. Works even for
// sets TCGdex lacks: the PriceCharting path gives an English name, and the native script comes back
// out of the baked dex.
//
// GENERALISED from the builder's nativeInfo(), which reads dex.ja unconditionally — correct there
// only because pcEnrichIntl is JP-only, and wrong the moment a Korean card asks: it would answer
// with Japanese kana. `romaji` stays Japanese-only because that is what it is; a Korean card gets
// its hangul and no romanisation rather than a wrong one (GR4).
export function nativeInfo(dex, dataLang, enName) {
  const lang = String(dataLang || '').toLowerCase();
  if (!lang || lang === 'en') return { native: '', romaji: '' };
  const inv = inverseDex(dex, lang);
  const rm = (dex && dex.romaji) || {};
  const exact = String(enName == null ? '' : enName).trim().toLowerCase();
  const key = speciesKey(enName);
  return {
    native: inv[exact] || inv[key] || '',
    romaji: lang === 'ja' ? (rm[exact] || rm[key] || '') : '',
  };
}

// Build the ENGLISH card name from a TCGdex card: English species + the Latin suffix already
// printed on the card (ex / V / VMAX). Two resolution paths — dexId (most cards), then native
// species lookup (the high-value ex/full-art cards omit dexId). Empty only for Trainers/Energy with
// no English source, which the operator then types.
//
// MIRROR of the builder's englishCardName(), with `dex` and `dataLang` passed in rather than read
// off a module global and a DOM field.
export function englishCardName(card, dex, dataLang) {
  const m = dex || {};
  const byDex = m.dex || {};
  const native = (card && card.name) || '';
  const ascii = native.replace(/[^\x00-\x7F]+/g, ' ').replace(/[^A-Za-z0-9'’.:\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // 1) dexId -> English
  let species = ((card && card.dexId) || []).map((n) => byDex[n]).filter(Boolean).join(' & ');
  // 2) native species name -> English
  if (!species) {
    const lm = m[dataLang] || {};
    const base = native.replace(/[A-Za-z0-9'’.:\-\s]+$/, '');       // strip the trailing Latin suffix
    const parts = base.split(/[&＆]/).map((p) => p.trim()).filter(Boolean);
    const en = parts.map((p) => lm[p]).filter(Boolean);
    if (en.length && en.length === parts.length) species = en.join(' & ');   // all parts must resolve
  }
  if (species) return (species + (ascii ? ' ' + ascii : '')).trim();
  return ascii;                                  // Trainer/Energy or unmapped — may be empty
}

// The native-market reference link. PriceCharting files non-English cards under a per-language
// console, and its search does better with Latin text than with CJK — so the CJK is stripped rather
// than sent, the card affixes (ex / V / VMAX) are kept because they are printed in Latin on the
// card itself, and the language word is appended the way a PriceCharting console is named.
// GENERALISED from the builder's pcJapaneseSearchUrl, which hardcodes 'japanese'.
// MIRROR: pokemon-listing-builder.html pcJapaneseSearchUrl().
export function pcSearchUrl(name, number, setName, lang) {
  const word = { ja: 'japanese', 'zh-cn': 'chinese', 'zh-tw': 'chinese', ko: 'korean' }[dataLangOf(lang)] || '';
  let latin = String(name || '').replace(/[぀-ヿ一-鿿가-힯]/g, '').replace(/[^\w\s-]/g, ' ').trim();
  if (latin.length < 3) latin = '';
  const numHead = String(number == null ? '' : number).split('/')[0];
  const q = [latin, numHead, setName, word, 'pokemon'].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return 'https://www.pricecharting.com/search-products?type=prices&q=' + encodeURIComponent(q);
}

// ---------------------------------------------------------------------------
// Printings — from DATA (Golden Rule 5)
// ---------------------------------------------------------------------------

// TCGdex's card record carries a real printing matrix:
//   variants: { firstEdition, holo, normal, reverse, wPromo }
// which is DATA, not a rarity regex — so an intl card gets the same GR5 treatment an English one
// does, and the catch line's n|r|h tokens keep working because the keys emitted here ARE the
// pokemontcg.io keys PRINTING_TO_FINISH / printingOrder / pickPrinting already understand.
//
// Returns the { key, finish, edition, variant, marketUsd } shape printingsFor() returns, so no
// caller has to branch.
//
// marketUsd is ALWAYS null. TCGdex quotes Cardmarket in EUR, and this field is consumed as USD
// (lib/runner-core.mjs, the MKT column, the disagreement detector) — putting a euro figure in it
// would be wrong by the FX rate and silently so, which is exactly what Golden Rule 3 forbids. An
// intl row gets its second opinion from PriceCharting or from nothing at all, and says which.
export function intlPrintingsFor(card) {
  const v = card && card.variants;
  if (!v || typeof v !== 'object') return [];
  const first = !!v.firstEdition;
  const out = [];
  // Ordered Normal -> Reverse -> Holo to match printingOrder(), so pickPrinting()'s heuristic
  // branch lands on the same printing it would for an English card.
  if (v.normal) out.push(first ? '1stEditionNormal' : 'normal');
  if (v.reverse) out.push('reverseHolofoil');
  if (v.holo) out.push(first ? '1stEditionHolofoil' : 'holofoil');
  // Finish and edition come off the SHARED maps rather than being re-derived here. A local ladder
  // is how a chase card ends up tokenised as the plain printing: the first version of this tested
  // /Holofoil$/ against the key, which is lowercase `holofoil`, so every holo read as Normal and
  // would have collided with the base card on (identity_key, variant) — GR5, one regex deep.
  return out.map((key) => {
    const finish = PRINTING_TO_FINISH[key];
    const edition = PRINTING_TO_EDITION[key] || '';
    return { key, finish, edition, variant: variantToken(edition, finish), marketUsd: null };
  });
}

// What to show when there is no card record to read variants off — the runner's per-set index is
// TCGdex's SET endpoint, which serves briefs ({id, image, localId, name}) and no variants at all.
//
// 'Non-holo' is the UNDER-PROMISING answer, the same call the Magic and Lorcana adapters make and
// the same one printingsFor's own no-price branch makes: a card listed as plain that turns out to
// be holo disappoints nobody, and the operator is holding the card and can correct it with the
// Finish dropdown or an n|r|h token. It is deliberately NOT flagged `fromRarity`, because it is a
// declared default rather than a guess read out of a rarity string — the distinction the
// `from rarity` chip exists to draw.
export function intlFinishFallback() {
  return { finish: 'Non-holo', variant: 'Base', fromRarity: false };
}

// The printing matrix speaks the SOURCE vocabulary (Normal / Holofoil / Reverse Holofoil, which are
// tcgplayer.prices' finish names); the uploader's Finish dropdown speaks the SELLER vocabulary
// (Non-holo / Holo / Reverse Holo, the words that go in a title). They overlap enough to look
// interchangeable and are not: 'Normal' is in neither list on the dropdown side, so matching on it
// found no option, left the select on whatever the PREVIOUS card had, and a Common shipped as Holo
// — wrong finish in the title, wrong side of UNIQUE(game, identity_key, variant), and a foil
// finishHint into the comps search (GR5). Translate through the variant token, which both sides
// already agree on, and fall back to the under-promising option rather than to whatever is there.
const OPTION_BY_VARIANT = { Base: 'Non-holo', Holo: 'Holo', 'Reverse Holo': 'Reverse Holo' };
export function intlFinishOption(printing) {
  return (printing && OPTION_BY_VARIANT[printing.variant]) || intlFinishFallback().finish;
}
