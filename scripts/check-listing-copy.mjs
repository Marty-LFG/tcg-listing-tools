// scripts/check-listing-copy.mjs — parity harness for lib/listing-copy.mjs (AGENTS.md §8).
//
// The single-card builders keep inline copies of the title/description logic
// (classic <script>s can't import ESM); lib/listing-copy.mjs is the shared port
// used by the bulk tool. This harness EXTRACTS the builders' real functions from
// the HTML (brace-counted, vm-evaluated with stubs) and asserts the shared port
// produces BYTE-IDENTICAL output. If this fails, one side changed without the
// other — fix the mirror (Golden Rules 6/9), don't silence the harness.
//
// Run: node --disable-warning=ExperimentalWarning scripts/check-listing-copy.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as LC from '../lib/listing-copy.mjs';
import * as SB from '../lib/shipping-bands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Every description now quotes the postage for the band its price lands in, so a fixture has to carry
// one. Cycling by index means all three bands get exercised across each game's fixture set rather than
// only the cheapest — a builder that hardcoded $1.70 into its band-2 branch fails here.
const BANDS = SB.DEFAULT_BANDS;
const bandFor = (i) => BANDS[i % BANDS.length];

let failures = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log('  ok  ' + label); return; }
  failures++;
  console.error('FAIL  ' + label);
  console.error('  expected: ' + JSON.stringify(expected));
  console.error('  actual:   ' + JSON.stringify(actual));
}
function assert(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); return; }
  failures++;
  console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
}

// Extract `marker...{body}` from source by brace-counting from the first '{' after marker.
function extractFn(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marker not found: ' + marker);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced braces after: ' + marker);
}

// ---------------------------------------------------------------------------
// 1. extras.js fitTitle / condCode / langCode  ⇄  listing-copy exports
// ---------------------------------------------------------------------------
console.log('\n[extras.js parity]');
{
  const src = read('extras.js');
  const ctx = { TCG: {} };
  vm.createContext(ctx);
  for (const name of ['condCode', 'langCode', 'fitTitle', 'formatCardNumber', 'cardNumberKey']) {
    vm.runInContext(extractFn(src, 'TCG.' + name + '=function') + ';', ctx);
  }
  const condVec = ['Ungraded, Near Mint', 'Near Mint', 'PSA 10', 'bgs 9.5', 'Lightly Played', 'MP', 'heavily played', 'Damaged', 'Excellent', 'Mint', '', 'Something Odd'];
  for (const s of condVec) check('condCode(' + JSON.stringify(s) + ')', LC.condCode(s), ctx.TCG.condCode(s));
  const langVec = ['English', 'Japanese', 'german', '', 'EN', 'Klingon'];
  for (const s of langVec) check('langCode(' + JSON.stringify(s) + ')', LC.langCode(s), ctx.TCG.langCode(s));
  const partsVec = [
    [{ text: 'Pikachu', prio: 100 }, { text: '58/102', prio: 85 }],
    [{ text: 'Pokemon', prio: 45 }, { text: 'A very long card name that will absolutely not fit within the limit at all', prio: 100 }, { text: '123/456', prio: 85 }, { text: 'Extremely Long Set Name Edition Deluxe', prio: 70 }, { text: 'Special Illustration Rare', abbr: 'SIR', prio: 78 }, { text: 'Reverse Holo', abbr: 'RH', prio: 55 }, { text: 'EN', prio: 30 }, { text: 'M/NM', prio: 62 }],
    [{ text: '', prio: 90 }, { text: 'OnlyName', prio: 100 }, { text: null, prio: 50 }],
  ];
  for (let i = 0; i < partsVec.length; i++) {
    check('fitTitle(vec ' + i + ')', LC.fitTitle(partsVec[i], 80), ctx.TCG.fitTitle(partsVec[i], 80));
    check('fitTitle(vec ' + i + ', 40)', LC.fitTitle(partsVec[i], 40), ctx.TCG.fitTitle(partsVec[i], 40));
  }
  // Golden Rule 10 — the card-exact collector number. Every set shape below was verified
  // against a hi-res scan of the real card (see docs/DATA_SOURCES.md).
  const SV = { series: 'Scarlet & Violet', releaseDate: '2025/07/18' };
  const SWSH = { series: 'Sword & Shield', releaseDate: '2020/02/07' };
  const numVec = [
    ['12', { ...SV, name: 'White Flare', printedTotal: 86, total: 173 }, {}],                                        // 012/086
    ['106', { ...SV, name: 'White Flare', printedTotal: 86, total: 173 }, {}],                                       // 106/086 (secret rare)
    ['4', { ...SWSH, name: 'Sword & Shield', printedTotal: 202, total: 216 }, {}],                                   // 004/202
    ['1', { series: 'Sword & Shield', releaseDate: '2021/10/08', name: 'Celebrations', printedTotal: 25, total: 25 }, {}],
    ['4', { series: 'Sun & Moon', releaseDate: '2017/02/03', name: 'Sun & Moon', printedTotal: 149, total: 163 }, {}],   // 4/149 (pre-SWSH)
    ['58', { series: 'Base', releaseDate: '1999/01/09', name: 'Base', printedTotal: 102, total: 102 }, {}],          // 58/102
    ['1', { series: 'Scarlet & Violet', releaseDate: '2023/01/01', name: 'Scarlet & Violet Black Star Promos', printedTotal: 215, total: 196 }, {}],   // 001
    ['SWSH039', { series: 'Sword & Shield', releaseDate: '2019/11/15', name: 'SWSH Black Star Promos', printedTotal: 307, total: 304 }, {}],
    ['1', { series: 'Base', releaseDate: '1999/07/01', name: 'Wizards Black Star Promos', printedTotal: 53, total: 53 }, {}],
    ['TG01', { series: 'Sword & Shield', releaseDate: '2022/02/25', name: 'Brilliant Stars Trainer Gallery', printedTotal: 30, total: 30 }, {}],
    ['SV001', { series: 'Sword & Shield', releaseDate: '2021/02/19', name: 'Shining Fates Shiny Vault', printedTotal: 122, total: 122 }, {}],
    ['001', { name: 'スカーレットex', printedTotal: 78, total: 108 }, { source: 'tcgdex' }],                            // 001/078
    ['106', { name: 'ホワイトフレア', printedTotal: 86, total: 174 }, { source: 'tcgdex' }],                            // 106/086
    ['039a', { ...SWSH, name: 'Astral Radiance', printedTotal: 298, total: 300 }, {}],                               // GR5 verbatim
    ['H1', { series: 'E-Card', releaseDate: '2002/09/15', name: 'Expedition Base Set', printedTotal: 165, total: 165 }, {}],
    ['25', { name: 'No Total Set' }, {}],
    ['001', { mep: true, series: 'Scarlet & Violet', releaseDate: '2025/09/26', name: 'Mega Evolution Promo', printedTotal: 88, total: 79 }, {}],
    ['', { ...SV, name: 'White Flare', printedTotal: 86 }, {}],
  ];
  for (const [n, s, o] of numVec) {
    check('formatCardNumber(' + JSON.stringify(n) + ', ' + (s.name || '?') + ')', LC.formatCardNumber(n, s, o), ctx.TCG.formatCardNumber(n, s, o));
  }
  const keyVec = ['106/86', '106/086', '012/086', 'TG01/TG30', '001', '4/102', '', 'SV001/SV122'];
  for (const s of keyVec) check('cardNumberKey(' + JSON.stringify(s) + ')', LC.cardNumberKey(s), ctx.TCG.cardNumberKey(s));
}

// ---------------------------------------------------------------------------
// Builder extraction helper — evaluates the named inline functions with stubs.
// ---------------------------------------------------------------------------
function builderContext(file, markers, fixture, extraCtx) {
  const src = read(file);
  const ctx = Object.assign({
    window: { TCG: { fitTitle: LC.fitTitle, condCode: LC.condCode, langCode: LC.langCode } },
    TCG: { fitTitle: LC.fitTitle, condCode: LC.condCode, langCode: LC.langCode },
    val: (id) => (fixture['f_' + id.replace(/^f_/, '')] != null ? fixture[id] ?? fixture['f_' + id.replace(/^f_/, '')] : (fixture[id] != null ? fixture[id] : '')),
  }, extraCtx || {});
  ctx.val = (id) => (fixture[id] != null ? fixture[id] : '');
  // readPostageBand() reads the page's <select>; with no DOM it falls back to the first band, which is
  // all readFields() needs here (the fixtures pass an explicit postageBand into buildHTML).
  ctx.document = { getElementById: () => null };
  // The band TABLE is injected rather than extracted — extractFn brace-counts, and the table is an
  // array of objects, so it would stop at the first band. The builders' own inline tables are pinned
  // against these same literals by test/invariants/builder-wording.test.mjs; what THIS harness proves
  // is that the builder's own bandMoney/postagePhrase turn a band into the same sentence the shared
  // module does.
  ctx.POSTAGE_BANDS = SB.DEFAULT_BANDS;
  ctx.POSTAGE_MIN_BAND_FOR_SLAB = SB.DEFAULT_MIN_BAND_FOR_SLAB;
  // A `var`, not a function, so extractFn cannot reach it. Injecting from the module also makes the
  // note itself a mirrored value: a builder that reworded it renders a different table footer and
  // the byte comparison below catches it.
  ctx.POSTAGE_OPTIONS_NOTE = SB.POSTAGE_OPTIONS_NOTE;
  vm.createContext(ctx);
  // The postage-band mirror is in every builder and buildHTML() reaches the buyer-facing sentence
  // through it, so it is always loaded rather than being named at each call site.
  const POSTAGE = ['function bandMoney(', 'function postagePhrase(', 'function bandById(', 'function readPostageBand(',
    'function postageOptions(', 'function optionsTable(', 'function postageText('];
  for (const m of [...POSTAGE, ...markers]) vm.runInContext(extractFn(src, m) + ';', ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// 2. Pokémon genTitle/genPitch/buildHTML  ⇄  buildTitle/pokemonPitch/buildDescription
// ---------------------------------------------------------------------------
console.log('\n[pokemon builder parity]');
{
  const fixtures = [
    { f_name: 'Charizard', f_num: '4/102', f_set: 'Base Set', f_rarity: 'Holo Rare', f_finish: 'Holo', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_poke: 'Charizard', f_stage: 'Stage 2', f_type: 'Fire' },
    // English with the pokemontcg.io SEO extras (illustrator / HP / set symbol / release year / image).
    { f_name: 'Magikarp', f_num: '203/193', f_set: 'Paldea Evolved', f_rarity: 'Illustration Rare', f_finish: 'Holo', f_lang: 'English', f_cond: 'Near Mint', f_poke: 'Magikarp', f_stage: 'Basic', f_type: 'Water', f_setSymbol: 'PAL', f_illustrator: 'Saya Tsuruta', f_hp: '30', f_regMark: 'G', f_releaseYear: '2023', f_img: 'https://images.pokemontcg.io/sv2/203_hires.png' },
    { f_name: 'Pikachu with an Exceptionally Long Descriptive Name Variant', f_num: '058/165', f_set: 'Scarlet & Violet 151 Expansion', f_rarity: 'Special Illustration Rare', f_finish: 'Reverse Holo', f_lang: 'Japanese', f_cond: 'Lightly Played', f_poke: 'Pikachu', f_stage: 'Basic', f_type: 'Lightning' },
    // Japanese card with the full native-metadata overlay (native name + romaji / kanji set / set symbol / English set / image).
    { f_name: 'Bastiodon', f_num: '91/98', f_set: 'Abyss Eye', f_rarity: 'Illustration Rare', f_finish: 'Non-holo', f_lang: 'Japanese', f_cond: 'Ungraded, Near Mint', f_poke: 'Bastiodon', f_stage: 'Stage 2', f_type: 'Metal', f_nativeName: 'トリデプス', f_romaji: 'Torideps', f_nativeSet: 'アビスアイ', f_enSet: 'Pitch Black', f_setSymbol: 'M5', f_illustrator: 'PLANETA Mochizuki', f_hp: '150', f_regMark: 'M', f_releaseYear: '2026', f_img: 'https://storage.googleapis.com/images.pricecharting.com/abc/1600.jpg' },
    // Graded free-text condition — buildHTML/buildDescription infer a slab and swap to the slab-specific
    // condition/postage wording (no explicit opts.slab passed, exactly like the single builder).
    { f_name: 'Charizard', f_num: '4/102', f_set: 'Base Set', f_rarity: 'Holo Rare', f_finish: 'Holo', f_lang: 'English', f_cond: 'PSA 10', f_poke: 'Charizard', f_stage: 'Stage 2', f_type: 'Fire', f_img: 'https://images.pokemontcg.io/base1/4_hires.png' },
    // Graded slab with cert number + subgrades — both surface as detail rows when present.
    { f_name: 'Charizard', f_num: '4/102', f_set: 'Base Set', f_rarity: 'Holo Rare', f_finish: 'Holo', f_lang: 'English', f_cond: 'BGS 9.5', f_poke: 'Charizard', f_stage: 'Stage 2', f_type: 'Fire', f_cert: '0012345678', f_subgrades: 'Centering 9.5 · Corners 9 · Edges 9.5 · Surface 10' },
    // Black Star Promo — the PROMO star in the masthead's logo slot renders CSS-inverted (no
    // promoStarStyle field = the inverted default), and the boxed SVP mark sits beside the number.
    // Older promo eras pass no setSymbolUrl and show the number alone — same template branch.
    { f_name: 'Pikachu with Grey Felt Hat', f_num: '085', f_set: 'Scarlet & Violet Black Star Promos', f_rarity: 'Promo', f_finish: 'Holo', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_poke: 'Pikachu', f_stage: 'Basic', f_type: 'Lightning', f_img: 'https://images.pokemontcg.io/svp/85_hires.png',
      f_setLogoUrl: 'https://images.pokemontcg.io/svp/symbol.png', f_setSymbolUrl: 'https://archives.bulbagarden.net/media/upload/d/d8/SetSymbolSVP_Black_Star_Promos.png' },
  ];
  for (const [fi, fx] of fixtures.entries()) {
    const ctx = builderContext('pokemon-listing-builder.html', ['var PKM_RAB=', 'function rarShortOf(', 'function rarDisplay(', 'function genTitle()', 'function genPitch(', 'function buildHTML(', 'function esc('], fx);
    const f = { name: fx.f_name, num: fx.f_num, set: fx.f_set, rarity: fx.f_rarity, finish: fx.f_finish, lang: fx.f_lang, cond: fx.f_cond, poke: fx.f_poke, stage: fx.f_stage, type: fx.f_type,
      nativeName: fx.f_nativeName, romaji: fx.f_romaji, nativeSet: fx.f_nativeSet, enSet: fx.f_enSet, setSymbol: fx.f_setSymbol, illustrator: fx.f_illustrator, hp: fx.f_hp, regMark: fx.f_regMark, releaseYear: fx.f_releaseYear, img: fx.f_img,
      cert: fx.f_cert, subgrades: fx.f_subgrades, setLogoUrl: fx.f_setLogoUrl, setSymbolUrl: fx.f_setSymbolUrl };
    check('genTitle ' + fx.f_name.slice(0, 20), LC.buildTitle('pokemon', f), vm.runInContext('genTitle()', ctx));
    const pitch = vm.runInContext('genPitch(' + JSON.stringify(f) + ')', ctx);
    check('genPitch ' + fx.f_name.slice(0, 20), LC.pokemonPitch(f), pitch);
    const ff = Object.assign({}, f, { pitch, postageBand: bandFor(fi) });
    check('buildHTML ' + fx.f_name.slice(0, 20), LC.buildDescription('pokemon', ff), vm.runInContext('buildHTML(' + JSON.stringify(ff) + ')', ctx));
  }
}

// ---------------------------------------------------------------------------
// 3. Lorcana genTitle/genPitch/buildHTML  ⇄  buildTitle/lorcanaPitch/buildDescription
// ---------------------------------------------------------------------------
console.log('\n[lorcana builder parity]');
{
  const fixtures = [
    { f_name: 'Elsa - Spirit of Winter', f_num: '207/204', f_set: 'The First Chapter (TFC)', f_rarity: 'Enchanted', f_variant: 'Foil', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_type: 'Character', f_ink: 'Amethyst', f_class: 'Storyborn, Hero, Queen, Sorcerer', f_cost: '8', f_strength: '4', f_willpower: '6', f_lore: '3' },
    { f_name: 'Mickey Mouse - Brave Little Tailor', f_num: '12/204', f_set: 'Rise of the Floodborn (ROF)', f_rarity: 'Common', f_variant: 'Standard', f_lang: 'English', f_cond: 'Near Mint', f_type: 'Character', f_ink: 'Ruby', f_class: 'Dreamborn, Hero', f_cost: '2', f_strength: '2', f_willpower: '3', f_lore: '1' },
  ];
  for (const [fi, fx] of fixtures.entries()) {
    const setName = fx.f_set.replace(/\s*\([^)]*\)\s*$/, '');
    const ctx = builderContext('lorcana-listing-builder.html', ['function rarAbbr(', 'function genTitle()', 'function genPitch(', 'function buildHTML(', 'function esc('], fx,
      { SETS: { 1: setName }, curSet: '1' });
    const f = { name: fx.f_name, num: fx.f_num, set: fx.f_set, rarity: fx.f_rarity, variant: fx.f_variant, lang: fx.f_lang, cond: fx.f_cond, type: fx.f_type, ink: fx.f_ink, cls: fx.f_class, cost: fx.f_cost, strength: fx.f_strength, willpower: fx.f_willpower, lore: fx.f_lore };
    check('genTitle ' + fx.f_name.slice(0, 20), LC.buildTitle('lorcana', f), vm.runInContext('genTitle()', ctx));
    const pitch = vm.runInContext('genPitch(' + JSON.stringify(f) + ',' + JSON.stringify(fx.f_rarity) + ')', ctx);
    check('genPitch ' + fx.f_name.slice(0, 20), LC.lorcanaPitch(f, fx.f_rarity, setName), pitch);
    const ff = Object.assign({}, f, { pitch, postageBand: bandFor(fi) });
    check('buildHTML ' + fx.f_name.slice(0, 20), LC.buildDescription('lorcana', ff), vm.runInContext('buildHTML(' + JSON.stringify(ff) + ')', ctx));
  }
}

// ---------------------------------------------------------------------------
// 3b. Riftbound genTitle/genPitch/buildHTML  ⇄  buildTitle/riftboundPitch/buildDescription
// (genTitle reads readFields()→curSetName(); stub curSetName, extract mapRarity for genPitch.)
// ---------------------------------------------------------------------------
console.log('\n[riftbound builder parity]');
{
  const fixtures = [
    { f_name: 'Yasuo, Windchaser', f_num: '162a/298', f_set: 'Origins (OGN)', f_rarity: 'Showcase', f_variant: 'Alternate Art', f_finish: 'Foil', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_type: 'Unit', f_domain: 'Fury', f_tags: 'Yasuo', f_e: '4', f_p: '3', f_m: '5' },
    { f_name: 'Calm Rune', f_num: 'R02a', f_set: 'Unleashed (UNL)', f_rarity: 'Showcase', f_variant: 'Alternate Art', f_finish: 'Foil', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_type: 'Rune', f_domain: 'Calm', f_tags: '', f_e: '', f_p: '', f_m: '' },
    { f_name: 'Against the Odds', f_num: '001/221', f_set: 'Spiritforged (SFD)', f_rarity: 'Common', f_variant: '', f_finish: 'Non-foil', f_lang: 'English', f_cond: 'Near Mint', f_type: 'Spell', f_domain: 'Fury', f_tags: '', f_e: '', f_p: '', f_m: '' },
    { f_name: 'Draven, Glory Seeker', f_num: '075/298', f_set: 'Origins (OGN)', f_rarity: 'Epic', f_variant: '', f_finish: 'Foil', f_lang: 'English', f_cond: 'Near Mint', f_type: 'Unit', f_domain: 'Fury;Chaos', f_tags: 'Draven', f_e: '5', f_p: '4', f_m: '6' },
    { f_name: 'Daughter of the Void', f_num: '299*/298', f_set: 'Origins (OGN)', f_rarity: 'Showcase', f_variant: 'Signature', f_finish: 'Foil', f_lang: 'Japanese', f_cond: 'Lightly Played', f_type: 'Unit', f_domain: 'Chaos', f_tags: '', f_e: '6', f_p: '5', f_m: '7' },
    // Over the printed total (167 of 166) — Overnumbered, and a Showcase foil despite Riot calling it a rare.
    { f_name: 'Vi, Destructive', f_num: '167/166', f_set: 'Vendetta (VEN)', f_rarity: 'Showcase', f_variant: 'Overnumbered', f_finish: 'Foil', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_type: 'Unit', f_domain: 'Fury', f_tags: '', f_e: '2', f_p: '1', f_m: '3' },
    // Vendetta's special showcase promo: Showcase rarity, NO variant — the SP number is the marker.
    { f_name: "Kai'Sa, Survivor", f_num: 'SP1/006', f_set: 'Vendetta (VEN)', f_rarity: 'Showcase', f_variant: '', f_finish: 'Foil', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_type: 'Unit', f_domain: 'Mind', f_tags: '', f_e: '4', f_p: '1', f_m: '3' },
    // Long enough to force fitTitle to shed parts — "(Signature)" must NOT be one of them (GR5):
    // it is the difference between a US$2,739 card and a US$296 one.
    { f_name: 'Poppy, Keeper of the Hammer', f_num: '237*/219', f_set: 'Unleashed (UNL)', f_rarity: 'Showcase', f_variant: 'Signature', f_finish: 'Foil', f_lang: 'Japanese', f_cond: 'Lightly Played', f_type: 'Legend', f_domain: 'Body', f_tags: 'Poppy', f_e: '3', f_p: '2', f_m: '4' },
    // The one hardcoded treatment (TREATMENT_OVERRIDE): over the set total, but Ultimate, not Overnumbered.
    { f_name: 'Baron Nashor', f_num: '238/219', f_set: 'Unleashed (UNL)', f_rarity: 'Showcase', f_variant: 'Ultimate', f_finish: 'Foil', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_type: 'Unit', f_domain: 'Chaos', f_tags: '', f_e: '10', f_p: '3', f_m: '12' },
  ];
  for (const [fi, fx] of fixtures.entries()) {
    const setName = fx.f_set.replace(/\s*\([^)]*\)\s*$/, '');
    const ctx = builderContext('riftbound-listing-builder.html',
      ['function mapRarity(', 'function readFields()', 'function genTitle()', 'function genPitch(', 'function buildHTML(', 'function esc('], fx,
      { curSetName: () => setName });
    // The variant is what distinguishes the treatments once mapRarity has flattened them all to
    // 'Showcase' — mirrors buildRowFields()'s `riftboundPitch(f, f.variant || f.rarity)`.
    const rawRarity = fx.f_variant || fx.f_rarity;
    const f = { name: fx.f_name, num: fx.f_num, set: fx.f_set, setName, rarity: fx.f_rarity, variant: fx.f_variant, finish: fx.f_finish, lang: fx.f_lang, cond: fx.f_cond, type: fx.f_type, domain: fx.f_domain, tags: fx.f_tags, e: fx.f_e, p: fx.f_p, m: fx.f_m };
    const title = vm.runInContext('genTitle()', ctx);
    check('genTitle ' + fx.f_name.slice(0, 18), LC.buildTitle('riftbound', f), title);
    // GR5: a shed title must never drop the treatment. fitTitle used to bin "(Signature)" first.
    if (['Signature', 'Overnumbered', 'Ultimate'].includes(fx.f_variant)) {
      check('title keeps ' + fx.f_variant, '(' + fx.f_variant + ')', (title.match(/\((?:Signature|Overnumbered|Ultimate)\)/) || [''])[0]);
    }
    const pitch = vm.runInContext('genPitch(' + JSON.stringify(f) + ',' + JSON.stringify(rawRarity) + ')', ctx);
    check('genPitch ' + fx.f_name.slice(0, 18), LC.riftboundPitch(f, rawRarity), pitch);
    const ff = Object.assign({}, f, { pitch, postageBand: bandFor(fi) });
    check('buildHTML ' + fx.f_name.slice(0, 18), LC.buildDescription('riftbound', ff), vm.runInContext('buildHTML(' + JSON.stringify(ff) + ')', ctx));
  }
}

// ---------------------------------------------------------------------------
// 3c. MTG genTitle/genPitch/buildHTML  ⇄  buildTitle/mtgPitch/buildDescription
// ---------------------------------------------------------------------------
console.log('\n[mtg builder parity]');
{
  const HOB = 'The Hobbit (HOB)';
  const fixtures = [
    // Plain rare, non-foil. "Nonfoil" contains "foil": the title must claim NO finish.
    { f_name: 'Troop of Ponies', f_num: '84', f_set: HOB, f_rarity: 'Rare', f_colour: 'Green', f_type: 'Creature — Horse', f_treat: 'Normal', f_finish: 'Nonfoil', f_lang: 'English', f_cond: 'Ungraded, Near Mint' },
    // Mythic Borderless Foil, with the server-enriched shape (symbol + art + illustrator + year).
    { f_name: 'The One Ring', f_num: '84', f_set: 'The Hobbit Eternal (HOC)', f_rarity: 'Mythic', f_colour: 'Colourless', f_type: 'Legendary Artifact', f_treat: 'Borderless', f_finish: 'Foil', f_lang: 'English', f_cond: 'Near Mint', f_illustrator: 'Veli Nyström', f_releaseYear: '2026', f_img: 'https://cards.scryfall.io/normal/front/a/b/c.jpg', f_setSymbolUrl: 'https://svgs.scryfall.io/sets/hoc.svg' },
    // GR5 REGRESSION GUARDS — HOB #239 and #275 are the same card as the US$38 #15 base printing.
    // `inverted` used to read as "Normal", making all three indistinguishable in the title.
    { f_name: 'Gleaming Splendor', f_num: '239', f_set: HOB, f_rarity: 'Mythic', f_colour: 'White', f_type: 'Enchantment', f_treat: 'Borderless', f_finish: 'Foil', f_lang: 'English', f_cond: 'Ungraded, Near Mint' },
    { f_name: 'Gleaming Splendor', f_num: '275', f_set: HOB, f_rarity: 'Mythic', f_colour: 'White', f_type: 'Enchantment', f_treat: 'Borderless', f_finish: 'Surge Foil', f_lang: 'English', f_cond: 'Ungraded, Near Mint' },
    // The headliner: same name, same frame, same rarity as #229 — the token is the only difference.
    { f_name: 'Smaug the Magnificent', f_num: '249', f_set: HOB, f_rarity: 'Mythic', f_colour: 'Red', f_type: 'Legendary Creature — Dragon', f_treat: 'Normal', f_finish: 'Foil', f_promo: 'Headliner', f_lang: 'English', f_cond: 'Ungraded, Near Mint' },
    // Long enough to force fitTitle to shed parts.
    { f_name: 'Thorin Oakenshield, Rightful Heir Under the Mountain', f_num: '202', f_set: 'The Hobbit Eternal (HOC)', f_rarity: 'Mythic', f_colour: 'Multicolour', f_type: 'Legendary Creature — Dwarf Noble', f_treat: 'Borderless', f_finish: 'Surge Foil', f_promo: 'Box Topper', f_lang: 'English', f_cond: 'Lightly Played' },
    // The Dwarvish chase (HOC #96 Mox Amber, US$642 foil) — proves langCode reaches DW.
    { f_name: 'Mox Amber', f_num: '96', f_set: 'The Hobbit Eternal (HOC)', f_rarity: 'Mythic', f_colour: 'Colourless', f_type: 'Legendary Artifact', f_treat: 'Borderless', f_finish: 'Nonfoil', f_lang: 'Dwarvish', f_cond: 'Near Mint' },
    // Etched foil, and a graded slab (the builder infers it from the condition string, as does the lib).
    { f_name: 'Arcane Signet', f_num: '95', f_set: 'The Hobbit Eternal (HOC)', f_rarity: 'Mythic', f_colour: 'Colourless', f_type: 'Artifact', f_treat: 'Borderless', f_finish: 'Etched Foil', f_lang: 'English', f_cond: 'Ungraded, Near Mint' },
    { f_name: 'Smaug the Magnificent', f_num: '229', f_set: HOB, f_rarity: 'Mythic', f_colour: 'Red', f_type: 'Legendary Creature — Dragon', f_treat: 'Normal', f_finish: 'Foil', f_lang: 'English', f_cond: 'PSA 10' },
  ];
  for (const [fi, fx] of fixtures.entries()) {
    const ctx = builderContext('mtg-listing-builder.html',
      ['const COLOURS=', 'function colourName(', 'function treatmentOf(', 'function promoNoteOf(', 'function genTitle()', 'function genPitch(', 'function buildHTML(', 'function esc('], fx);
    const f = { name: fx.f_name, num: fx.f_num, set: fx.f_set, rarity: fx.f_rarity, colour: fx.f_colour, type: fx.f_type,
      treat: fx.f_treat, finish: fx.f_finish, promo: fx.f_promo, lang: fx.f_lang, cond: fx.f_cond,
      illustrator: fx.f_illustrator, releaseYear: fx.f_releaseYear, img: fx.f_img, setSymbolUrl: fx.f_setSymbolUrl };
    const title = vm.runInContext('genTitle()', ctx);
    check('genTitle ' + fx.f_name.slice(0, 20) + ' #' + fx.f_num, LC.buildTitle('mtg', f), title);
    const pitch = vm.runInContext('genPitch(' + JSON.stringify(f) + ')', ctx);
    check('genPitch ' + fx.f_name.slice(0, 20) + ' #' + fx.f_num, LC.mtgPitch(f), pitch);
    const ff = Object.assign({}, f, { pitch, postageBand: bandFor(fi) });
    check('buildHTML ' + fx.f_name.slice(0, 20) + ' #' + fx.f_num, LC.buildDescription('mtg', ff), vm.runInContext('buildHTML(' + JSON.stringify(ff) + ')', ctx));
  }
  // GR5: a non-foil card must not claim a finish, and Surge Foil must not collapse to Foil.
  const g = (fx) => LC.buildTitle('mtg', { name: 'Gleaming Splendor', num: '275', set: 'The Hobbit (HOB)', rarity: 'Mythic', treat: 'Borderless', lang: 'English', cond: 'Near Mint', ...fx });
  assert('mtg title: Nonfoil claims no finish', !/Foil/.test(g({ finish: 'Nonfoil' })), g({ finish: 'Nonfoil' }));
  assert('mtg title: Surge Foil stays Surge', /Surge/.test(g({ finish: 'Surge Foil' })), g({ finish: 'Surge Foil' }));
  assert('mtg title: Etched stays Etched', /Etched/.test(g({ finish: 'Etched Foil' })), g({ finish: 'Etched Foil' }));
  assert('mtg title: Dwarvish carries DW', / DW /.test(g({ finish: 'Nonfoil', lang: 'Dwarvish' }) + ' '), g({ finish: 'Nonfoil', lang: 'Dwarvish' }));
  // The vocabulary itself, against the shapes Scryfall actually returns for HOB/HOC.
  check('mtgTreatmentOf inverted+black border → Borderless', LC.mtgTreatmentOf({ border_color: 'black', frame_effects: ['enchantment', 'inverted'] }), 'Borderless');
  check('mtgTreatmentOf borderless+inverted → Borderless', LC.mtgTreatmentOf({ border_color: 'borderless', frame_effects: ['inverted'] }), 'Borderless');
  check('mtgTreatmentOf plain enchantment → Normal', LC.mtgTreatmentOf({ border_color: 'black', frame_effects: ['enchantment'] }), 'Normal');
  check('mtgTreatmentOf legendary only → Normal', LC.mtgTreatmentOf({ border_color: 'black', frame_effects: ['legendary'] }), 'Normal');
  check('mtgTreatmentOf extendedart', LC.mtgTreatmentOf({ border_color: 'black', frame_effects: ['extendedart'] }), 'Extended Art');
  check('mtgColourName mono', LC.mtgColourName(['R']), 'Red');
  check('mtgColourName multi', LC.mtgColourName(['R', 'G']), 'Multicolour');
  check('mtgColourName none (AU spelling)', LC.mtgColourName([]), 'Colourless');
  // universesbeyond is on EVERY HOB/HOC print — a brand marker, never a promo note.
  check('mtgPromoNote universesbeyond only', LC.mtgPromoNote({ promo_types: ['universesbeyond'] }), '');
  check('mtgPromoNote headliner', LC.mtgPromoNote({ promo_types: ['headliner', 'universesbeyond'] }), 'Headliner');
  check('mtgPromoNote boxtopper', LC.mtgPromoNote({ promo_types: ['universesbeyond', 'boxtopper'] }), 'Box Topper');
  check('mtgLanguageName dw', LC.mtgLanguageName('dw'), 'Dwarvish');
  check('langCode(Dwarvish) → DW', LC.langCode('Dwarvish'), 'DW');
  // A graded MTG row must still reach the slab wording — it did before this branch existed, via the
  // shared frame, and an mtg branch that forgot it would silently regress to penny-sleeve copy.
  // Priced at A$20 on purpose: by price that is the cheapest band, and a graded card must still be
  // lifted off it. An untracked $1.70 letter for a slab is the exact thing minBandForSlab exists to stop.
  const slabbed = LC.rowToFields({ game: 'mtg', name: 'Smaug the Magnificent', number: '249', set_name: 'The Hobbit (HOB)', rarity: 'Mythic', finish: 'Foil', language: 'EN', graded: true, grading_company: 'PSA', grade: 10, grade_label: 'PSA 10 GEM MT', price_cents: 2000 });
  const slabHtml = LC.buildDescription('mtg', slabbed, { slab: true });
  assert('graded mtg reaches SLAB protection wording', slabHtml.includes(LC.SLAB_PROTECTION) && !slabHtml.includes(LC.CARD_PROTECTION));
  const slabBand = SB.DEFAULT_BANDS[SB.DEFAULT_MIN_BAND_FOR_SLAB];
  assert('a cheap graded slab is lifted to the tracked band', slabbed.postageBand && slabbed.postageBand.id === slabBand.id, slabbed.postageBand && slabbed.postageBand.id);
  assert('graded mtg quotes the tracked amount, not the letter one',
    slabHtml.includes(SB.money(slabBand.costCents)) && !slabHtml.includes(SB.money(BANDS[0].costCents)));
  assert('graded mtg title carries the grade', LC.buildTitle('mtg', slabbed).includes('PSA 10 GEM MINT'), LC.buildTitle('mtg', slabbed));
  // rowToFields must stop handing MTG the Pokémon pitch.
  const mrow = LC.rowToFields({ game: 'mtg', name: 'Smaug the Magnificent', number: '249', set_name: 'The Hobbit (HOB)', rarity: 'Mythic', finish: 'Foil', language: 'EN', colour: 'Red', type: 'Legendary Creature — Dragon', treat: 'Normal' });
  assert('rowToFields mtg pitch is not the Pokémon one', !/Pok[eé]mon/.test(mrow.pitch), mrow.pitch);
  assert('rowToFields mtg description is not the Pokémon frame', !/Pok[eé]mon/.test(LC.buildDescription('mtg', mrow)));
  check('rowToFields mtg DW → Dwarvish for the Language row', LC.rowToFields({ game: 'mtg', name: 'Mox Amber', number: '96', set_name: 'HOC', language: 'DW' }).lang, 'Dwarvish');
}

// ---------------------------------------------------------------------------
// 3e. SWU + One Piece buildHTML ⇄ buildDescription.
// These two had NO parity harness, which is how buildDescription('swu', …) came to render the POKÉMON
// frame without anyone noticing: every Star Wars card the bulk/channel path listed carried Pokémon
// branding. Both are raw-only tools (no slab path), and both read their set name straight off f.set.
// ---------------------------------------------------------------------------
console.log('\n[swu builder parity]');
{
  const fixtures = [
    { f_name: 'Darth Vader - Dark Lord of the Sith', f_num: '10/252', f_set: 'Spark of Rebellion (SOR)', f_rarity: 'Legendary', f_variant: 'Standard', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_type: 'Leader', f_aspect: 'Aggression', f_arena: 'Ground', f_traits: 'Force · Sith', f_cost: '7', f_power: '5', f_hp: '8' },
    { f_name: 'Vanquish', f_num: '104/252', f_set: 'Shadows of the Galaxy (SHD)', f_rarity: 'Common', f_variant: 'Hyperspace Foil', f_lang: 'English', f_cond: 'Lightly Played', f_type: 'Event', f_aspect: 'Command', f_arena: '', f_traits: '', f_cost: '5', f_power: '', f_hp: '' },
    { f_name: 'Rey - More Than a Scavenger', f_num: '1/262', f_set: 'Jump to Lightspeed (JTL)', f_rarity: 'Special', f_variant: 'Showcase', f_lang: 'Japanese', f_cond: 'Near Mint', f_type: 'Unit', f_aspect: 'Heroism', f_arena: 'Ground', f_traits: 'Force', f_cost: '3', f_power: '2', f_hp: '4' },
  ];
  for (const [fi, fx] of fixtures.entries()) {
    const setName = fx.f_set.replace(/\s*\([^)]*\)\s*$/, '');
    const ctx = builderContext('swu-listing-builder.html',
      ['function genTitle()', 'function genPitch(', 'function buildHTML(', 'function esc('], fx,
      { SETS: { 1: setName }, curSet: '1' });
    const f = { name: fx.f_name, num: fx.f_num, set: fx.f_set, rarity: fx.f_rarity, variant: fx.f_variant, lang: fx.f_lang, cond: fx.f_cond, type: fx.f_type, aspect: fx.f_aspect, arena: fx.f_arena, traits: fx.f_traits, cost: fx.f_cost, power: fx.f_power, hp: fx.f_hp };
    check('genTitle ' + fx.f_name.slice(0, 20), LC.buildTitle('swu', f), vm.runInContext('genTitle()', ctx));
    const pitch = vm.runInContext('genPitch(' + JSON.stringify(f) + ',' + JSON.stringify(fx.f_rarity) + ')', ctx);
    check('genPitch ' + fx.f_name.slice(0, 20), LC.swuPitch(f, fx.f_rarity, setName), pitch);
    const ff = Object.assign({}, f, { pitch, postageBand: bandFor(fi) });
    check('buildHTML ' + fx.f_name.slice(0, 20), LC.buildDescription('swu', ff), vm.runInContext('buildHTML(' + JSON.stringify(ff) + ')', ctx));
  }
}

console.log('\n[onepiece builder parity]');
{
  const fixtures = [
    { f_name: 'Monkey D. Luffy', f_num: 'OP01-003', f_set: 'Romance Dawn (OP-01)', f_rarity: 'L', f_variant: '', f_lang: 'English', f_cond: 'Ungraded, Near Mint', f_type: 'Leader', f_color: 'Red', f_attr: 'Strike', f_traits: 'Supernovas · Straw Hat Crew', f_cost: '', f_power: '5000', f_counter: '', f_life: '5' },
    { f_name: 'Trafalgar Law', f_num: 'OP01-047', f_set: 'Romance Dawn (OP-01)', f_rarity: 'SR', f_variant: 'Parallel', f_lang: 'Japanese', f_cond: 'Near Mint', f_type: 'Character', f_color: 'Green', f_attr: 'Slash', f_traits: 'Heart Pirates', f_cost: '5', f_power: '6000', f_counter: '1000', f_life: '' },
    { f_name: 'Gum-Gum Red Roc', f_num: 'OP02-015', f_set: 'Paramount War (OP-02)', f_rarity: 'C', f_variant: '', f_lang: 'English', f_cond: 'Lightly Played', f_type: 'Event', f_color: 'Red', f_attr: '', f_traits: '', f_cost: '4', f_power: '', f_counter: '', f_life: '' },
  ];
  for (const [fi, fx] of fixtures.entries()) {
    const ctx = builderContext('onepiece-listing-builder.html',
      ['function isChaseVariant(', 'function genTitle()', 'function genPitch(', 'function buildHTML(', 'function esc('], fx);
    const f = { name: fx.f_name, num: fx.f_num, set: fx.f_set, rarity: fx.f_rarity, variant: fx.f_variant, lang: fx.f_lang, cond: fx.f_cond, type: fx.f_type, color: fx.f_color, attr: fx.f_attr, traits: fx.f_traits, cost: fx.f_cost, power: fx.f_power, counter: fx.f_counter, life: fx.f_life };
    check('genTitle ' + fx.f_name.slice(0, 20), LC.buildTitle('onepiece', f), vm.runInContext('genTitle()', ctx));
    const pitch = vm.runInContext('genPitch(' + JSON.stringify(f) + ')', ctx);
    check('genPitch ' + fx.f_name.slice(0, 20), LC.onepiecePitch(f), pitch);
    const ff = Object.assign({}, f, { pitch, postageBand: bandFor(fi) });
    check('buildHTML ' + fx.f_name.slice(0, 20), LC.buildDescription('onepiece', ff), vm.runInContext('buildHTML(' + JSON.stringify(ff) + ')', ctx));
  }
  // The regression that started this: neither game may fall through to the Pokémon frame again.
  for (const game of ['swu', 'onepiece']) {
    const html = LC.buildDescription(game, { name: 'X', num: '1', set: 'S', rarity: 'C', lang: 'English', cond: 'Near Mint', pitch: 'p', postageBand: BANDS[0] });
    assert(`${game} does not render the Pokémon frame`, !/Pok[eé]mon/i.test(html));
  }

  // GR5 guards — the same shape as the mtg ones above. These pin the DIFFERENTIATORS, so a future
  // edit that deletes either titleParts branch (dropping both games back to the generic fallback,
  // which is where they were) fails here by name rather than quietly shipping a weaker title.
  const swuT = (over) => LC.buildTitle('swu', { name: 'Rey', num: '1/262', set: 'Jump to Lightspeed (JTL)', rarity: 'Special', lang: 'English', cond: 'Near Mint', ...over });
  assert('swu title carries the game token', /SWU|Star Wars Unlimited/.test(swuT({})), swuT({}));
  assert('swu title keeps a Showcase variant', /SHOWCASE/.test(swuT({ variant: 'Showcase' })), swuT({ variant: 'Showcase' }));
  assert('swu title drops a Standard variant', !/STANDARD/i.test(swuT({ variant: 'Standard' })), swuT({ variant: 'Standard' }));
  assert('swu title drops a common rarity', !/COMMON/i.test(swuT({ rarity: 'Common' })), swuT({ rarity: 'Common' }));

  const opT = (over) => LC.buildTitle('onepiece', { name: 'Trafalgar Law', num: 'OP01-047', set: 'Romance Dawn (OP-01)', rarity: 'SR', lang: 'English', cond: 'Near Mint', ...over });
  assert('onepiece title carries the game token', /One Piece/.test(opT({})), opT({}));
  // A parallel is worth many times its base print, so this token is the whole differentiator (GR5).
  assert('onepiece title keeps a Parallel variant', /PARALLEL/.test(opT({ variant: 'Parallel' })), opT({ variant: 'Parallel' }));
  assert('onepiece title ignores a non-chase variant', !/BASE/i.test(opT({ variant: 'Base' })), opT({ variant: 'Base' }));
  assert('onepiece title drops a common rarity', !/\bC\b/.test(opT({ rarity: 'C' }).replace('OP01-047', '')), opT({ rarity: 'C' }));
  // Under 80-char pressure the variant must OUTLIVE the rarity token, never the other way round —
  // a parallel is worth many times its base print, and "SR" is shared by hundreds of cards. This name
  // is sized so exactly one of the two can fit, which is what makes it a test of the ORDER.
  const longOp = LC.buildTitle('onepiece', { name: 'Trafalgar Law - Surgeon of Death Captain', num: 'OP01-047', set: 'Romance Dawn (OP-01)', rarity: 'SR', variant: 'Parallel', lang: 'Japanese', cond: 'Lightly Played' });
  assert('onepiece: a shed title keeps PARALLEL', /PARALLEL/.test(longOp), longOp);
  assert('onepiece: ...and sheds the rarity token to do it', !/\bSR\b/.test(longOp), longOp);
}

// ---------------------------------------------------------------------------
// 3d. Postage bands across every game frame — the description must quote the band it is ON, and no
// other. This is the assertion that catches a frame which hardcoded $1.70 into its band-2 branch:
// the sentence would still read perfectly while charging the buyer the wrong money.
// ---------------------------------------------------------------------------
console.log('\n[postage band coverage]');
{
  const base = { name: 'Charizard', num: '4/102', set: 'Base Set', rarity: 'Holo Rare', finish: 'Holo', variant: 'Standard', lang: 'English', cond: 'Near Mint', type: 'Character', pitch: 'A card.' };
  for (const game of ['pokemon', 'lorcana', 'riftbound', 'mtg', 'swu', 'onepiece']) {
    for (const b of BANDS) {
      const html = LC.buildDescription(game, { ...base, postageBand: b });
      assert(`${game} band ${b.id} quotes ${SB.money(b.costCents)}`, html.includes(SB.money(b.costCents)));
      // Every money figure in the description has to belong to THIS band — its own cost in the
      // sentence, or one of its own policy's services in the options table. A band now legitimately
      // shows several, so "only one figure" is no longer the rule; "no figure from anywhere else"
      // still is, and that is what catches a frame hardcoding $1.70 into the band-2 branch.
      const mine = new Set([SB.money(b.costCents), ...(b.services || []).map((s) => SB.money(s.costCents))]);
      const foreign = [...new Set((html.match(/\$\d[\d,]*\.\d{2}/g) || []))].filter((v) => !mine.has(v));
      assert(`${game} band ${b.id} shows only its OWN policy's amounts`, foreign.length === 0, foreign.join(', '));
    }
    // An unpriced preview quotes no money at all rather than defaulting to the cheapest band.
    const unknown = LC.buildDescription(game, { ...base, postageBand: null });
    assert(`${game} with no band quotes no amount`, !/\$\d/.test(unknown) && unknown.includes(SB.POSTAGE_UNKNOWN));
  }
  // Both product types carry the same band sentence; only the protection sentence differs.
  for (const b of BANDS) {
    const raw = LC.buildDescription('pokemon', { ...base, postageBand: b });
    const slab = LC.buildDescription('pokemon', { ...base, cond: 'PSA 10', postageBand: b });
    assert(`band ${b.id}: raw and slab share the postage sentence`, raw.includes(SB.postagePhrase(b)) && slab.includes(SB.postagePhrase(b)));
    assert(`band ${b.id}: only the protection sentence differs`, raw.includes(LC.CARD_PROTECTION) && slab.includes(LC.SLAB_PROTECTION));
  }
}

// ---------------------------------------------------------------------------
// 4. Bulk-only additions — edition + graded tokens, and the GR8 inline-style guard.
// ---------------------------------------------------------------------------
console.log('\n[bulk additions]');
{
  const f = { name: 'Charizard', num: '4/102', set: 'Base Set', rarity: 'Holo Rare', finish: 'Holo', lang: 'English', cond: 'Near Mint', edition: '1st Edition' };
  const t = LC.buildTitle('pokemon', f);
  assert('1st Edition reaches the title', t.includes('1st Edition'), t);
  const g = { name: 'Charizard', num: '4/102', set: 'Base Set', rarity: 'Holo Rare', finish: 'Holo', lang: 'English', graded: true, grading_company: 'PSA', grade: 10, grade_label: 'PSA 10.0 GEM - MT' };
  const gt = LC.buildTitle('pokemon', g);
  assert('graded token in title (PSA 10 GEM MINT)', gt.includes('PSA 10 GEM MINT'), gt);
  check('gradeTitleToken BGS black label', LC.gradeTitleToken('BGS', 10, 'BGS 10.0 Black Label'), 'BGS 10 BLACK LABEL');
  check('gradeTitleToken TAG pristine', LC.gradeTitleToken('TAG', 10, 'TAG 10.0 Pristine'), 'TAG 10 PRISTINE');
  // Graded inventory row → description surfaces cert number + formatted subgrades (inventory JSON shape).
  const gg = LC.rowToFields({ game: 'pokemon', name: 'Charizard', number: '4/102', set_name: 'Base Set', rarity: 'Holo Rare', finish: 'Holofoil', language: 'EN', graded: true, grading_company: 'BGS', grade: 9.5, grade_label: 'BGS 9.5', cert_number: '0012345678', subgrades: '{"centering":9.5,"corners":9,"edges":9.5,"surface":10}' });
  const gd = LC.buildDescription('pokemon', gg, { slab: true });
  assert('graded desc: cert number row', gd.includes('Cert number') && gd.includes('0012345678'));
  assert('graded desc: formatted subgrades row', gd.includes('Subgrades') && gd.includes('Centering 9.5') && gd.includes('Surface 10'));
  check('formatSubgrades passthrough (display string)', LC.formatSubgrades('Centering 9.5 · Corners 9'), 'Centering 9.5 · Corners 9');
  check('formatSubgrades empty', LC.formatSubgrades(null), '');
  check('variantToken 1stEd holo', LC.variantToken('1st Edition', 'Holofoil'), '1st Edition Holo');
  check('variantToken unlimited', LC.variantToken('Unlimited', 'Holofoil'), 'Holo');
  check('variantToken reverse', LC.variantToken(null, 'Reverse Holofoil'), 'Reverse Holo');
  check('variantToken plain', LC.variantToken(null, 'Normal'), 'Base');
  // "Non-holo" contains "holo"; "Nonfoil" contains "foil". This token IS the `variant` column in
  // UNIQUE(game, identity_key, variant), so a mislabelled base card collides with the real foil
  // printing of the same card and the two stop being distinguishable (GR5). Both spellings are
  // live: the uploader dropdown offers "Non-holo", Scryfall's own finishes value is "nonfoil".
  for (const [f, want] of [['Non-holo', 'Base'], ['Non-Holo', 'Base'], ['non holo', 'Base'],
    ['Nonfoil', 'Base'], ['Non-foil', 'Base'], ['Non foil', 'Base']]) {
    check('variantToken negation ' + JSON.stringify(f), LC.variantToken(null, f), want);
  }
  check('variantToken 1stEd non-holo', LC.variantToken('1st Edition', 'Non-holo'), '1st Edition');
  // GR5 in the TITLE: doLookup auto-selects "Non-holo" for any non-holo rarity, so an unguarded
  // ladder shipped an eBay title claiming Holo on a plain card (INAD risk).
  const nh = { name: 'Bastiodon', num: '91/98', set: 'Abyss Eye', rarity: 'Illustration Rare', lang: 'English', cond: 'Near Mint' };
  assert('pokemon title: Non-holo claims no finish', !/Holo/.test(LC.buildTitle('pokemon', { ...nh, finish: 'Non-holo' })), LC.buildTitle('pokemon', { ...nh, finish: 'Non-holo' }));
  assert('pokemon title: Holo still says Holo', /\bHolo\b/.test(LC.buildTitle('pokemon', { ...nh, finish: 'Holo' })));
  assert('pokemon title: Reverse Holo unchanged', /Reverse Holo/.test(LC.buildTitle('pokemon', { ...nh, finish: 'Reverse Holo' })));

  // GR8: descriptions are inline-style only — no <style>/<script>/event handlers/class=.
  const guard = /<(style|script)\b|\son\w+=|\sclass=/i;
  for (const game of ['pokemon', 'lorcana', 'riftbound', 'mtg']) {
    const ff = LC.rowToFields({ game, name: 'X', number: '1/1', set_name: 'S', rarity: 'Common', finish: 'Normal', language: 'EN' });
    assert('GR8 inline-only (' + game + ')', !guard.test(LC.buildDescription(game, ff)));
    assert('GR8 inline-only slab (' + game + ')', !guard.test(LC.buildDescription(game, ff, { slab: true })));
  }
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PARITY CHECKS PASSED');
process.exit(failures ? 1 : 0);
