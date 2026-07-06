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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

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
  for (const name of ['condCode', 'langCode', 'fitTitle']) {
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
  vm.createContext(ctx);
  for (const m of markers) vm.runInContext(extractFn(src, m) + ';', ctx);
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
  ];
  for (const fx of fixtures) {
    const ctx = builderContext('pokemon-listing-builder.html', ['var PKM_RAB=', 'function rarShortOf(', 'function rarDisplay(', 'function genTitle()', 'function genPitch(', 'function buildHTML(', 'function esc('], fx);
    const f = { name: fx.f_name, num: fx.f_num, set: fx.f_set, rarity: fx.f_rarity, finish: fx.f_finish, lang: fx.f_lang, cond: fx.f_cond, poke: fx.f_poke, stage: fx.f_stage, type: fx.f_type,
      nativeName: fx.f_nativeName, romaji: fx.f_romaji, nativeSet: fx.f_nativeSet, enSet: fx.f_enSet, setSymbol: fx.f_setSymbol, illustrator: fx.f_illustrator, hp: fx.f_hp, regMark: fx.f_regMark, releaseYear: fx.f_releaseYear, img: fx.f_img };
    check('genTitle ' + fx.f_name.slice(0, 20), LC.buildTitle('pokemon', f), vm.runInContext('genTitle()', ctx));
    const pitch = vm.runInContext('genPitch(' + JSON.stringify(f) + ')', ctx);
    check('genPitch ' + fx.f_name.slice(0, 20), LC.pokemonPitch(f), pitch);
    const ff = Object.assign({}, f, { pitch });
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
  for (const fx of fixtures) {
    const setName = fx.f_set.replace(/\s*\([^)]*\)\s*$/, '');
    const ctx = builderContext('lorcana-listing-builder.html', ['function rarAbbr(', 'function genTitle()', 'function genPitch(', 'function buildHTML(', 'function esc('], fx,
      { SETS: { 1: setName }, curSet: '1' });
    const f = { name: fx.f_name, num: fx.f_num, set: fx.f_set, rarity: fx.f_rarity, variant: fx.f_variant, lang: fx.f_lang, cond: fx.f_cond, type: fx.f_type, ink: fx.f_ink, cls: fx.f_class, cost: fx.f_cost, strength: fx.f_strength, willpower: fx.f_willpower, lore: fx.f_lore };
    check('genTitle ' + fx.f_name.slice(0, 20), LC.buildTitle('lorcana', f), vm.runInContext('genTitle()', ctx));
    const pitch = vm.runInContext('genPitch(' + JSON.stringify(f) + ',' + JSON.stringify(fx.f_rarity) + ')', ctx);
    check('genPitch ' + fx.f_name.slice(0, 20), LC.lorcanaPitch(f, fx.f_rarity, setName), pitch);
    const ff = Object.assign({}, f, { pitch });
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
    { f_name: 'Daughter of the Void', f_num: '299*/298', f_set: 'Origins (OGN)', f_rarity: 'Overnumbered', f_variant: 'Overnumbered', f_finish: 'Foil', f_lang: 'Japanese', f_cond: 'Lightly Played', f_type: 'Unit', f_domain: 'Chaos', f_tags: '', f_e: '6', f_p: '5', f_m: '7' },
  ];
  for (const fx of fixtures) {
    const setName = fx.f_set.replace(/\s*\([^)]*\)\s*$/, '');
    const ctx = builderContext('riftbound-listing-builder.html',
      ['function mapRarity(', 'function readFields()', 'function genTitle()', 'function genPitch(', 'function buildHTML(', 'function esc('], fx,
      { curSetName: () => setName });
    const rawRarity = fx.f_variant === 'Alternate Art' ? 'Alternate Art' : fx.f_variant === 'Overnumbered' ? 'Overnumbered' : fx.f_rarity;
    const f = { name: fx.f_name, num: fx.f_num, set: fx.f_set, setName, rarity: fx.f_rarity, variant: fx.f_variant, finish: fx.f_finish, lang: fx.f_lang, cond: fx.f_cond, type: fx.f_type, domain: fx.f_domain, tags: fx.f_tags, e: fx.f_e, p: fx.f_p, m: fx.f_m };
    check('genTitle ' + fx.f_name.slice(0, 18), LC.buildTitle('riftbound', f), vm.runInContext('genTitle()', ctx));
    const pitch = vm.runInContext('genPitch(' + JSON.stringify(f) + ',' + JSON.stringify(rawRarity) + ')', ctx);
    check('genPitch ' + fx.f_name.slice(0, 18), LC.riftboundPitch(f, rawRarity), pitch);
    const ff = Object.assign({}, f, { pitch });
    check('buildHTML ' + fx.f_name.slice(0, 18), LC.buildDescription('riftbound', ff), vm.runInContext('buildHTML(' + JSON.stringify(ff) + ')', ctx));
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
  check('variantToken 1stEd holo', LC.variantToken('1st Edition', 'Holofoil'), '1st Edition Holo');
  check('variantToken unlimited', LC.variantToken('Unlimited', 'Holofoil'), 'Holo');
  check('variantToken reverse', LC.variantToken(null, 'Reverse Holofoil'), 'Reverse Holo');
  check('variantToken plain', LC.variantToken(null, 'Normal'), 'Base');

  // GR8: descriptions are inline-style only — no <style>/<script>/event handlers/class=.
  const guard = /<(style|script)\b|\son\w+=|\sclass=/i;
  for (const game of ['pokemon', 'lorcana', 'riftbound']) {
    const ff = LC.rowToFields({ game, name: 'X', number: '1/1', set_name: 'S', rarity: 'Common', finish: 'Normal', language: 'EN' });
    assert('GR8 inline-only (' + game + ')', !guard.test(LC.buildDescription(game, ff)));
    assert('GR8 inline-only slab (' + game + ')', !guard.test(LC.buildDescription(game, ff, { slab: true })));
  }
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PARITY CHECKS PASSED');
process.exit(failures ? 1 : 0);
