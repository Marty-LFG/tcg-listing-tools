// lib/listing-copy.mjs — single shared source for eBay TITLES + DESCRIPTIONS used by
// the bulk listing tool (grid preview, channel mappers, harnesses).
//
// MIRROR RULE (Golden Rules 6 + 9, same convention as lib/normalize.mjs): the
// browser builders keep their own inline copies (extras.js TCG.fitTitle/condCode/
// langCode; each builder's genTitle()/buildHTML()) because they are classic
// <script>s that cannot import ESM. The functions below are VERBATIM ports —
// if you change one side, change the other. scripts/check-listing-copy.mjs
// enforces byte-identical parity; run it after touching either side.
//   - fitTitle / condCode / langCode / formatCardNumber  ⇄  extras.js
//   - pokemon titleParts/buildDescription ⇄ pokemon-listing-builder.html genTitle()/genPitch()/buildHTML()
//   - lorcana titleParts/buildDescription ⇄ lorcana-listing-builder.html genTitle()/genPitch()/buildHTML()
//   - lib/shipping-bands.mjs BANDS/postagePhrase ⇄ every builder's inline BANDS + postageText(),
//     and extras.js's comps analyser (it quotes the postage a buyer pays on top of the item price)
//
// Pure/dual-target: no DOM, no fetch, no DB — importable by Vite plugins, Node
// harnesses, and <script type="module"> pages (the bulk builder).

// ---------------------------------------------------------------------------
// Owner-verified wording (Golden Rule 6) — for CARD (raw single) listings.
// Do not reword. The LEGO/Funko builders have their own wording; not mirrored here.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Description type stacks. SYSTEM FONTS ONLY, and that is not a preference: eBay strips <style>
// and <link>, so a webfont cannot be loaded and naming one only produces a silent fallback.
// MIRRORED verbatim in pokemon-listing-builder.html buildHTML().
// ---------------------------------------------------------------------------
import { bandForListing, postagePhrase, postageOptions, POSTAGE_OPTIONS_NOTE, shippingOf } from './shipping-bands.mjs';

export const SERIF_BODY = "Georgia,'Iowan Old Style','Times New Roman',serif";
export const SANS_UI = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const MONO_DATA = "ui-monospace,'Cascadia Mono',Menlo,Consolas,'Courier New',monospace";

export const CARD_CONDITION_SUFFIX = '. Pulled straight to sleeve and stored in a toploader.';
export const CARD_FOOTER = 'From a smoke-free home. Fast dispatch. Thanks for looking.';
export const DEFAULT_CARD_CONDITION = 'Ungraded, Near Mint';   // safest default — under-promises (INAD safety)

// PROTECTION is per product type; POSTAGE is per price band and lives in lib/shipping-bands.mjs. They
// used to be one sentence ending "...with FREE postage within Australia", which stopped being true the
// day the store moved to three buyer-paid bands. Splitting them means 3 bands x 2 product types costs
// five literals rather than six, and the band phrase is byte-identical across raw and slab — which is
// what keeps the builders' mirror test cheap now that the sentence is a function.
export const CARD_PROTECTION = 'Ships in a penny sleeve and toploader inside a rigid mailer.';

// GRADED-slab wording — the card penny-sleeve/toploader lines are physically wrong
// for an encapsulated slab. ⚠ OWNER-REVIEW: new wording, not yet owner-verified;
// kept minimal + under-promising until confirmed (tracked in docs/BULK_LISTING_DESIGN.md).
export const SLAB_CONDITION_SUFFIX = '. Professionally graded and encapsulated. See photos and item specifics for the cert details.';
export const SLAB_PROTECTION = 'Ships securely inside a rigid mailer.';

// ---------------------------------------------------------------------------
// Variant vocabulary — THE single source (Golden Rule 5). identity variant =
// edition + finish joined, so 1st Edition vs Unlimited printings never merge
// in inventory (uq_inv_bulk_identity keys on this string).
// ---------------------------------------------------------------------------

// Source printing key -> finish label. Pokémon keys are tcgplayer.prices keys;
// Lorcana keys are the Lorcast price fields; Magic keys are Scryfall `finishes[]` members, plus
// `surgefoil`, which runner-core synthesises because Scryfall only ever calls it "foil".
// One flat namespace across games, so a new key must not collide with an existing one — none of
// these four does (Lorcana's foil key is `usd_foil`, Pokémon's is `holofoil`).
export const PRINTING_TO_FINISH = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  reverseHolofoil: 'Reverse Holofoil',
  '1stEditionNormal': 'Normal',
  '1stEditionHolofoil': 'Holofoil',
  unlimited: 'Normal',
  unlimitedHolofoil: 'Holofoil',
  usd: 'Normal',
  usd_foil: 'Foil',
  nonfoil: 'Nonfoil',
  foil: 'Foil',
  etched: 'Etched Foil',
  surgefoil: 'Surge Foil',
};
// Printing keys that also imply an edition (vintage Pokémon).
export const PRINTING_TO_EDITION = {
  '1stEditionNormal': '1st Edition',
  '1stEditionHolofoil': '1st Edition',
  unlimited: 'Unlimited',
  unlimitedHolofoil: 'Unlimited',
};

// Canonical identity/display variant from (edition, finish).
// 'Base' = plain non-foil so an empty string never lands in the UNIQUE index.
// Order matters (mirrors finishClass in lib/pricing.mjs and ebayFinish in lib/channels/ebay-map.mjs):
// "Non-holo" contains "holo" and "Nonfoil" contains "foil", so the negations are tested FIRST or a
// plain card takes the Holo/Foil token. That token is not cosmetic — it IS the `variant` column in
// UNIQUE(game, identity_key, variant) (lib/db.mjs), so a mislabelled base card collides with the
// genuine foil printing of the same card and the two stop being distinguishable (GR5).
export function variantToken(edition, finish) {
  const f = (finish || '').trim();
  const base = /reverse/i.test(f) ? 'Reverse Holo'
    : /non[-\s]?(holo|foil)/i.test(f) ? 'Base'
    : /holo/i.test(f) ? 'Holo'
    // Lorcana's three foil-only chase rarities. Counted across all 22 Lorcast sets (see
    // docs/DATA_SOURCES.md): all 324 Enchanted/Epic/Iconic cards are foil-only — not one carries a
    // `usd` price — so they are never the plain printing of anything, and they are where the money
    // is: Buzz Lightyear 12/241 (Iconic) is US$3,632 against a US$1 base card. Collapsing any of
    // them onto 'Foil' would seat two different cards on one row of
    // UNIQUE(game, identity_key, variant) and make them indistinguishable (GR5).
    : /enchanted/i.test(f) ? 'Enchanted'
    : /iconic/i.test(f) ? 'Iconic'
    : /epic/i.test(f) ? 'Epic'
    // "Cold Foil" contains "foil", so it goes above the generic branch for the same reason
    // "Surge Foil" does. It is the one Lorcana finish NO keyless source labels per card — TCGplayer
    // sells Normal / Cold Foil / Holofoil but Lorcast exposes only usd and usd_foil — so it is only
    // ever reachable from the uploader's dropdown, never derived, and it has no printing key.
    : /cold\s*foil/i.test(f) ? 'Cold Foil'
    // "Surge Foil" contains "foil", so it goes above the generic branch. It earns its own identity
    // because it is a SEPARATE product, not a finish of the same one: HOC #25 Delighted Halfling
    // is US$29.93 and #65, the surge foil, is US$125 — distinct TCGplayer ids, 4x apart (GR5).
    : /surge/i.test(f) ? 'Surge Foil'
    // Etched foil is the same argument: Scryfall prices it separately (`usd_etched`) because
    // TCGplayer sells it as its own product, so collapsing it onto 'Foil' would put two different
    // cards on one row of UNIQUE(game, identity_key, variant) and make them indistinguishable.
    : /etched/i.test(f) ? 'Etched Foil'
    : /foil/i.test(f) ? 'Foil'
    : 'Base';
  const e = (edition || '').trim();
  if (!e || /unlimited/i.test(e)) {
    // Unlimited is the default printing — only 1st Edition marks the variant,
    // but keep explicit Unlimited when the source said so AND a 1st Ed exists
    // is unknowable here; 'Unlimited Holo' stays distinct from 'Holo' would
    // split identities, so Unlimited collapses to the base token.
    return base;
  }
  return base === 'Base' ? e : e + ' ' + base;   // '1st Edition' | '1st Edition Holo' …
}

// The finish string as the single-card builders' f_finish expects it (for titles).
export function finishTitleInput(finish) { return finish || ''; }

// ---------------------------------------------------------------------------
// fitTitle / condCode / langCode — VERBATIM ports of extras.js:682-719.
// ---------------------------------------------------------------------------
export function condCode(s) {
  s = (s || '').trim(); var l = s.toLowerCase();
  var g = l.match(/(psa|cgc|bgs|sgc)\s*([0-9]+(?:\.5)?)/);
  if (g) return g[1].toUpperCase() + ' ' + g[2];
  if (/near\s*mint|\bnm\b/.test(l)) return 'M/NM';
  if (/\bmint\b|^m$/.test(l)) return 'M';
  if (/lightly\s*played|\blp\b/.test(l)) return 'LP';
  if (/moderately\s*played|\bmp\b/.test(l)) return 'MP';
  if (/heavily\s*played|\bhp\b/.test(l)) return 'HP';
  if (/damaged|\bdmg\b|\bpoor\b/.test(l)) return 'DMG';
  if (/excellent|\bex\b/.test(l)) return 'EX';
  return (s.split(/[\s,]+/)[0] || '').toUpperCase();
}

export function langCode(s) {
  var l = (s || '').trim().toLowerCase().replace(/\s*\(.*$/, '');   // "Chinese (Simp.)" -> "chinese"
  var map = { english: 'EN', japanese: 'JP', chinese: 'ZH', korean: 'KO', german: 'DE', french: 'FR', italian: 'IT', spanish: 'ES', portuguese: 'PT', russian: 'RU' };
  if (map[l]) return map[l];
  if (!s) return 'EN';
  return s.length <= 3 ? s.toUpperCase() : s.slice(0, 2).toUpperCase();
}

export function fitTitle(parts, max) {
  max = max || 80;
  parts = (parts || []).filter(function (p) { return p && p.text != null && ('' + p.text).trim() !== ''; });
  function join(ps) { return ps.map(function (p) { return ('' + p.text).trim(); }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(); }
  var cur = parts.map(function (p) { return Object.assign({}, p); });
  if (join(cur).length <= max) return join(cur);
  cur = parts.map(function (p) { return Object.assign({}, p, { text: (p.abbr != null ? p.abbr : p.text) }); });
  if (join(cur).length <= max) return join(cur);
  cur = cur.filter(function (p) { return p.text != null && ('' + p.text).trim() !== ''; });
  while (join(cur).length > max && cur.length > 1) {
    var idx = -1, lo = Infinity;
    cur.forEach(function (p, i) { var pr = (p.prio == null ? 50 : p.prio); if (pr < lo) { lo = pr; idx = i; } });
    if (idx < 0) break; cur.splice(idx, 1);
  }
  var out = join(cur);
  if (out.length > max) out = out.slice(0, max).trim();
  return out;
}

// ---------------------------------------------------------------------------
// formatCardNumber — the Pokémon collector number EXACTLY as printed on the card
// (Golden Rule 10). VERBATIM port of extras.js TCG.formatCardNumber.
//
// pokemontcg.io strips the printed zero-padding from `number` (a card printed
// 004/165 arrives as "4"), so it is rebuilt from the set's ERA. Verified against
// hi-res card scans:
//   Sword & Shield (2020) onward → pad numerator AND denominator to 3 digits
//       012/086 · 106/086 · 004/202 · 001/025
//   Before Sword & Shield        → numerator stays at its natural width
//       58/102 · 4/149 · 4/146
//   Promos  → the printed number alone, NEVER a /total and never an invented
//       prefix: 001 (SVP) · SWSH039 · XY01 · 1 (Wizards)
//   Subsets → the denominator repeats the numerator's letter prefix:
//       TG01/TG30 · GG01/GG70 · SV001/SV122
// opts.source 'tcgdex' (JP/CN/KO) keeps the numerator verbatim because TCGdex
// already returns it card-correct ("001"), and only pads the denominator.
//
// ⚠ DISPLAY ONLY. Lookups, identity keys (`sv4-25`) and the pokemontcg.io
// `number:` query DSL must keep using the RAW upstream number — padding them
// returns zero results. Use cardNumberKey() for matching/dedupe.
// ---------------------------------------------------------------------------
export function formatCardNumber(number, set, opts) {
  set = set || {}; opts = opts || {};
  var raw = String(number == null ? '' : number).trim();
  if (!raw) return '';
  var denomRaw = (set.printedTotal != null ? set.printedTotal : set.total);
  var denom = (denomRaw == null || denomRaw === '') ? '' : String(denomRaw);
  var name = set.name || '';
  var isPromo = /promo/i.test(name) || set.mep === true || /^promo$/i.test(opts.rarity || '');
  var isSubset = /\b(gallery|vault)\b/i.test(name);
  function pad(s, w) { s = String(s); while (s.length < w) s = '0' + s; return s; }
  var yr = parseInt(String(set.releaseDate || '').slice(0, 4), 10);
  var modern = /sword\s*&\s*shield|scarlet\s*&\s*violet/i.test(set.series || '') || yr >= 2020;
  if (/^\d+$/.test(raw)) {
    var numStr;
    if (opts.source === 'tcgdex') numStr = raw;
    else if (modern) {
      var widthSrc = (set.total != null ? set.total : denomRaw);
      numStr = pad(raw, Math.max(3, (widthSrc == null ? '' : String(widthSrc)).length));
    } else numStr = raw;
    if (isPromo || !denom) return numStr;
    return numStr + '/' + pad(denom, Math.max(numStr.length, denom.length));
  }
  var m = raw.match(/^([A-Za-z]+)(\d+)$/);
  if (m) {
    if (isPromo) return raw;                                   // SWSH039 / XY01 print bare
    if (isSubset && denom) return raw + '/' + m[1] + pad(denom, m[2].length);
    return raw;                                                // unknown coded (e-Card H1): never a wrong denominator
  }
  if (isPromo) return raw;
  return denom ? raw + '/' + denom : raw;                      // '039a' alt-art suffix kept verbatim (GR5)
}

// Matching / dedupe key for a card number — collapses printed padding so a
// legacy "106/86" and a card-exact "106/086" resolve to the same card. NOT for
// display, and not a lookup number (see the DISPLAY ONLY note above).
export function cardNumberKey(s) {
  return String(s == null ? '' : s).trim().toLowerCase()
    .split('/')
    .map(function (p) { return p.replace(/^0+(?=[0-9a-z])/, ''); })
    .join('/');
}

// ---------------------------------------------------------------------------
// Graded title token — 'PSA 10 GEM MINT' / 'BGS 10 BLACK LABEL' / 'TAG 10 PRISTINE'.
// Normalises grader shorthand; strips a leading company/grade repeat from the label.
// ---------------------------------------------------------------------------
const GRADE_LABEL_NORMALISE = { 'GEM - MT': 'GEM MINT', 'GEM MT': 'GEM MINT', 'GEM-MT': 'GEM MINT', 'NM - MT': 'NM-MT', 'MINT+': 'MINT' };
export function gradeTitleToken(company, grade, label) {
  const co = (company || '').toUpperCase().trim();
  const g = grade == null ? '' : (Math.round(+grade * 10) / 10 + '').replace(/\.0$/, '');
  let lab = (label || '').toUpperCase().trim();
  lab = lab.replace(new RegExp('^' + co + '\\s*', 'i'), '').replace(/^\d+(?:\.\d+)?\s*/, '').trim();
  lab = GRADE_LABEL_NORMALISE[lab] || lab;
  if (lab === g || lab === co) lab = '';
  return [co, g, lab].filter(Boolean).join(' ').trim();
}

// ---------------------------------------------------------------------------
// Per-game title parts — VERBATIM logic of each builder's genTitle(), taking the
// builder's field object f = {name,num,set,rarity,finish|variant,lang,cond} and
// bulk-only extras {edition, graded, grading_company, grade, grade_label}.
// When the bulk extras are absent the output is byte-identical to the builder.
// ---------------------------------------------------------------------------

// pokemon-listing-builder.html PKM_RAB rarity abbreviations (title token + details-row display).
const PKM_RAB = { 'special illustration rare': 'SIR', 'illustration rare': 'IR', 'ultra rare': 'UR', 'hyper rare': 'HR', 'double rare': 'RR', 'secret rare': 'Secret', 'rare secret': 'Secret', 'amazing rare': 'AR', 'radiant rare': 'Radiant', 'rare rainbow': 'Rainbow', 'art rare': 'AR', 'special art rare': 'SAR' };
// MIRROR of pokemon-listing-builder.html rarDisplay(): "Illustration Rare (IR)" for the details row.
function rarDisplay(r) { if (!r) return ''; const rl = ('' + r).toLowerCase(), ab = PKM_RAB[rl]; return ab && ab.toLowerCase() !== rl ? r + ' (' + ab + ')' : r; }

// lorcana-listing-builder.html rarAbbr().
// ICON and EPIC are not decoration: Iconic and Epic are foil-only chase rarities that only exist
// from set 9 on, and an Iconic is a four-figure card (Buzz Lightyear 12/241, US$3,632). Without a
// token of their own they fell through to '' and the title said nothing at all about the rarity.
// The underscore in [\s_] catches Lorcast's raw "Super_rare": '_' is a word character, so \brare\b
// finds no boundary inside it and an un-prettified value used to lose its token entirely.
export function lorcanaRarAbbr(r) {
  var rl = (r || '').toLowerCase();
  if (/enchanted/.test(rl)) return 'ENH';
  if (/iconic/.test(rl)) return 'ICON';
  if (/epic/.test(rl)) return 'EPIC';
  if (/legendary/.test(rl)) return 'LEG';
  if (/super[\s_]*rare/.test(rl)) return 'SR';
  if (/\brare\b/.test(rl)) return 'RARE';
  return '';
}

// ---------------------------------------------------------------------------
// Lorcana vocabulary. Lives here rather than in lib/channels/ebay-map.mjs because
// lib/stock-games.mjs needs it too and that file is BROWSER-SAFE — ebay-map imports node:fs, so a
// page importing it would not load. ebay-map re-exports these, the same way it takes mtgColourName.
// ---------------------------------------------------------------------------

// ⚠ READ BOTH FIELDS. Lorcast populates `ink` (a string) on some cards and `inks` (an array) on
// others, and neither alone is complete: Jolly Roger has ink:null with inks:["Ruby"], Never Land has
// ink:"Amber" with inks:null. Counted across all 22 sets, reading either one alone loses 160 of
// 3,192 cards — silently, as a blank Ink row and a missing aspect.
export function lorcanaInks(card) {
  const arr = card && Array.isArray(card.inks) && card.inks.length ? card.inks
    : (card && card.ink ? [card.ink] : []);
  return arr.map((s) => String(s || '').trim()).filter(Boolean);
}
// One string, because the eBay aspect is SINGLE cardinality and the description row is one cell.
// 187 cards are dual-ink; the hyphen is how the community writes them ("Amber-Steel").
export function lorcanaInkAspect(inkOrCard) {
  const list = Array.isArray(inkOrCard) ? inkOrCard.map((s) => String(s || '').trim()).filter(Boolean)
    : typeof inkOrCard === 'string' ? String(inkOrCard).split(/\s*[-/,]\s*/).map((s) => s.trim()).filter(Boolean)
      : lorcanaInks(inkOrCard);
  return list.length ? list.join('-') : null;
}

// ---------------------------------------------------------------------------
// Magic vocabulary — VERBATIM ports of mtg-listing-builder.html (MIRROR RULE, GR9). Server-derived
// field values have to agree with builder-derived ones or the same card gets two different titles
// depending on which surface listed it. Note the AU spellings: 'Colourless', 'Multicolour'.
// ---------------------------------------------------------------------------
export const MTG_COLOURS = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
export function mtgColourName(arr) { if (!arr || !arr.length) return 'Colourless'; if (arr.length > 1) return 'Multicolour'; return MTG_COLOURS[arr[0]] || arr[0]; }

// Scryfall's `inverted` frame effect is what TCGplayer sells as "(Borderless)" — verified against
// their live listings (HOB #239 "Gleaming Splendor (Borderless)"). It is a FRAME axis, orthogonal
// to surgefoil, and every genuinely borderless HOB/HOC print also carries it, so the two rules
// agree. Matching TCGplayer's product name is also what lets the comps query find the cluster.
export function mtgTreatmentOf(c) {
  const fe = (c && c.frame_effects) || [];
  if ((c && c.border_color === 'borderless') || fe.includes('inverted')) return 'Borderless';
  if (fe.includes('showcase')) return 'Showcase';
  if (fe.includes('extendedart')) return 'Extended Art';
  if (c && c.full_art) return 'Full Art';
  return 'Normal';
}

// `universesbeyond` rides on EVERY print of a Universes Beyond set, so it is a brand marker, not a
// promo flag. Only the genuinely scarce print runs are surfaced.
export function mtgPromoNote(c) {
  const pt = (c && c.promo_types) || [];
  if (pt.includes('boxtopper')) return 'Box Topper';
  if (pt.includes('headliner')) return 'Headliner';
  return '';
}

// Scryfall language code → display name. Only `dw` (Dwarvish) is non-obvious, and it is not
// cosmetic: HOC #93-97 are the set's chase cards (up to US$642), so listing one as English is an
// INAD exposure. MIRROR: MTG_LANG in mtg-listing-builder.html.
export const MTG_LANG = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', ru: 'Russian', zhs: 'Chinese (Simp.)', zht: 'Chinese (Trad.)', he: 'Hebrew', la: 'Latin', grc: 'Ancient Greek', ar: 'Arabic', sa: 'Sanskrit', ph: 'Phyrexian', qya: 'Quenya', dw: 'Dwarvish' };
// The stock tables store a 2-letter language CODE. A buyer reading "Language | EN" in the detail
// table is being shown our column value, not a language. MIRROR: LANG_WORD in the builders.
export const LANG_WORD = { EN: 'English', JP: 'Japanese', CN: 'Chinese (Simp.)', TW: 'Chinese (Trad.)', KO: 'Korean', FR: 'French', DE: 'German', IT: 'Italian', ES: 'Spanish', PT: 'Portuguese', RU: 'Russian' };
export const languageWord = (code) => LANG_WORD[String(code || '').toUpperCase()] || code || '';

export const mtgLanguageName = (code) => MTG_LANG[String(code || '').toLowerCase()] || code || '';

export function titleParts(game, f) {
  f = f || {};
  const graded = !!(f.graded || f.grading_company);
  // Graded slabs: the grade token replaces the condition code and outranks nearly
  // everything (prio 90) so it survives 80-char pressure. Edition (1st Edition /
  // Unlimited on vintage) is a top-tier value signal (Golden Rule 5): prio 90.
  const condPart = graded
    ? { text: gradeTitleToken(f.grading_company, f.grade, f.grade_label), prio: 90 }
    : { text: condCode(f.cond), prio: 62 };
  const editionPart = { text: /1st/i.test(f.edition || '') ? '1st Edition' : '', prio: 90 };

  if (game === 'pokemon') {
    var name = f.name || '', num = f.num || '', setn = f.set || '', rar = f.rarity || '', fin = f.finish || '', lang = f.lang || '';
    var rl = (rar || '').toLowerCase(); var rarShort = PKM_RAB[rl] || rar;
    // "Non-holo" CONTAINS "holo" — negation first, or a plain card ships a title claiming Holo
    // (INAD risk). VERBATIM MIRROR of pokemon-listing-builder.html genTitle().
    var finTok = '', finAbbr = ''; if (!/non[-\s]?(holo|foil)/i.test(fin)) { if (/reverse/i.test(fin)) { finTok = 'Reverse Holo'; finAbbr = 'RH'; } else if (/holo/i.test(fin)) { finTok = 'Holo'; finAbbr = 'Holo'; } }
    return [
      { text: 'Pokemon', prio: 45 },
      { text: name, prio: 100 },
      { text: num, prio: 85 },
      editionPart,
      { text: setn, prio: 70 },
      { text: rar, abbr: rarShort, prio: 78 },
      { text: finTok, abbr: finAbbr, prio: 55 },
      { text: langCode(lang), prio: /^\s*english\s*$/i.test(lang) ? 30 : 66 },   // non-EN: keep JP/ZH/KO in title (INAD safety)
      condPart,
    ];
  }
  if (game === 'lorcana') {
    var lname = f.name || '', lnum = f.num || '', lset = f.set || '', lrar = f.rarity || '', variant = f.variant || '', llang = f.lang || '';
    var code = ((lset || '').match(/\(([^)]+)\)/) || [])[1] || '';
    var v = (variant || '').trim(); if (/standard|normal|base|none/i.test(v)) v = '';
    // On a chase print the finish and the rarity are the SAME WORD, so the title said it twice —
    // "ICONIC ICON", "ENCHANTED ENH" — burning ten characters of an 80-char budget on a repeat. Drop
    // the abbreviation when the finish already carries it; keep it when they genuinely differ (an
    // Enchanted listed as plain Foil still wants its ENH). Riftbound's branch does the same.
    var lrarTok = lorcanaRarAbbr(lrar);
    if (lrarTok && v && v.toUpperCase() === (lrar || '').trim().toUpperCase()) lrarTok = '';
    return [
      { text: lname, prio: 100 },
      { text: lnum, prio: 88 },
      { text: '- Disney Lorcana ' + (lset || ''), abbr: '- Lorcana' + (code ? ' (' + code + ')' : ''), prio: 72 },
      { text: langCode(llang), prio: 30 },
      { text: v ? v.toUpperCase() : '', prio: 80 },
      { text: lrarTok, prio: 58 },
      condPart,
    ];
  }
  if (game === 'riftbound') {
    // VERBATIM port of riftbound-listing-builder.html genTitle() (MIRROR RULE, GR6/9).
    var rname = f.name || '', rnum = f.num || '', rset = f.set || '', rrar = f.rarity || '', rvar = f.variant || '', rfin = f.finish || '', rlang = f.lang || '';
    var numHead = ((rnum || '').split('/')[0] || '');
    var isAlt = (rvar === 'Alternate Art') || /[a-z]$/i.test(numHead);
    var altParen = (rvar === 'Signature') ? '(Signature)' : (rvar === 'Ultimate') ? '(Ultimate)' : (rvar === 'Overnumbered') ? '(Overnumbered)' : (isAlt ? '(Alt Art)' : '');
    // Signature/Ultimate/Overnumbered is a 10-100x price differentiator (299*/298 US$2739 vs 299/298
    // US$296; UNL-238 Ultimate US$1635), so it outranks the rarity token and the condition code when
    // fitTitle has to shed parts (GR5) — an 85-char Signature title used to drop the word
    // "(Signature)" and keep "M/NM". (Alt Art) keeps its old priority: the trailing letter in the
    // collector number already carries it.
    var varPrio = (rvar === 'Signature' || rvar === 'Ultimate' || rvar === 'Overnumbered') ? 82 : 60;
    var rcode = ((rset || '').match(/\(([^)]+)\)/) || [])[1] || '';
    var rar = (rrar || '').trim();
    if (/common|uncommon|^rare$/i.test(rar)) rar = '';
    var rarTok = '';
    if (rar && rar.replace(/[()]/g, '').toLowerCase() !== altParen.replace(/[()]/g, '').toLowerCase()) rarTok = rar.toUpperCase();
    var foilTok = (!rarTok && rfin === 'Foil') ? 'FOIL' : '';
    return [
      { text: rname, prio: 100 },
      { text: altParen, prio: varPrio },
      { text: rnum, prio: 88 },
      { text: '- Riftbound ' + (rset || ''), abbr: '- Riftbound' + (rcode ? ' (' + rcode + ')' : ''), prio: 72 },
      { text: langCode(rlang), prio: 30 },
      { text: rarTok, prio: 80 },
      { text: foilTok, prio: 55 },
      condPart,
    ];
  }
  if (game === 'mtg') {
    // VERBATIM port of mtg-listing-builder.html genTitle() (MIRROR RULE, GR6/9). No editionPart —
    // Magic has no 1st Edition axis. condPart is the shared one, so a graded bulk row picks up
    // 'PSA 10 GEM MINT' while the builder (which passes no grading fields) stays byte-identical.
    var mname = f.name || '', mnum = f.num || '', mset = f.set || '', mrar = f.rarity || '',
      mtreat = f.treat || '', mfin = f.finish || '', mlang = f.lang || '', mpromo = f.promo || '';
    var mcode = ((mset || '').match(/\(([^)]+)\)/) || [])[1] || '';
    var tv = (mtreat || '').trim(); if (/normal/i.test(tv)) tv = '';
    // "Nonfoil" contains "foil" (Scryfall's own value, and the builder's default option) so the
    // negation is tested first. "Surge Foil" contains "foil" too and must beat the generic branch:
    // it is a different TCGplayer product at several times the price, so collapsing it loses the
    // whole differentiator (GR5).
    var foilTok = '', foilAbbr = '';
    if (!/non[-\s]?foil/i.test(mfin)) { if (/surge/i.test(mfin)) { foilTok = 'Surge Foil'; foilAbbr = 'Surge'; } else if (/etched/i.test(mfin)) { foilTok = 'Etched Foil'; foilAbbr = 'Etched'; } else if (/foil/i.test(mfin)) { foilTok = 'Foil'; foilAbbr = 'Foil'; } }
    var mrl = (mrar || '').toLowerCase(); var rarTok = (/common|uncommon/.test(mrl)) ? '' : mrar;
    return [
      { text: 'MTG', prio: 45 },
      { text: mname, prio: 100 },
      { text: tv, prio: 78 },
      { text: mset, abbr: (mcode || mset), prio: 70 },
      { text: mnum, prio: 80 },
      { text: rarTok, prio: 60 },
      { text: foilTok, abbr: foilAbbr, prio: 60 },
      { text: mpromo, prio: 64 },
      // A non-English printing is a different product, not a translation — and Magic's are the
      // chase cards (the five Dwarvish HOC prints run to US$642), so the code outranks the rarity
      // token rather than being shed first.
      { text: langCode(mlang), prio: /^\s*english\s*$/i.test(mlang) ? 30 : 66 },
      condPart,
    ];
  }
  if (game === 'swu') {
    // VERBATIM port of swu-listing-builder.html genTitle() (MIRROR RULE, GR6/9). Until this existed,
    // swu fell through to the generic fallback below — and swu IS in loadEbayCategories().games, so
    // every Star Wars card the bulk/channel path listed shipped a title with no game token, the full
    // set name eating the character budget, and no variant token at all. Hyperspace/Showcase/Prestige
    // are a different product at a different price, so dropping them is a GR5 failure.
    var sname = f.name || '', snum = f.num || '', sset = f.set || '', srar = f.rarity || '', svar = f.variant || '', slang = f.lang || '';
    var scode = ((sset || '').match(/\(([^)]+)\)/) || [])[1] || '';
    var sv = (svar || '').trim(); if (/normal|standard|base|none/i.test(sv)) sv = '';
    var srl = (srar || '').toLowerCase(); var srarTok = (/common|uncommon/.test(srl)) ? '' : srar;
    return [
      { text: sname, prio: 100 },
      { text: snum, prio: 88 },
      { text: '- Star Wars Unlimited ' + (sset || ''), abbr: '- SWU' + (scode ? ' (' + scode + ')' : ''), prio: 72 },
      { text: langCode(slang), prio: 30 },
      { text: sv ? sv.toUpperCase() : '', prio: 80 },
      { text: srarTok ? srarTok.toUpperCase() : '', prio: 58 },
      condPart,
    ];
  }
  if (game === 'onepiece') {
    // VERBATIM port of onepiece-listing-builder.html genTitle() (MIRROR RULE, GR6/9). The variant
    // token outranks the rarity token (82 vs 58) because a One Piece parallel is worth several times
    // its base print — shedding "PARALLEL" to keep "SR" would be the expensive way round (GR5).
    var oname = f.name || '', ocode = f.num || '', oset = f.set || '', orar = f.rarity || '', ovar = f.variant || '', olang = f.lang || '';
    var osetCode = ((oset || '').match(/\(([^)]+)\)/) || [])[1] || '';
    var ov = onepieceIsChaseVariant(ovar) ? ovar : '';
    var orl = (orar || '').toUpperCase();
    var orarTok = (orl === 'SR' || orl === 'SEC' || orl === 'L' || orl === 'SP') ? orl : '';
    return [
      { text: oname, prio: 100 },
      { text: ocode, prio: 86 },
      { text: '- One Piece Card Game ' + (oset || ''), abbr: '- One Piece' + (osetCode ? ' (' + osetCode + ')' : ''), prio: 70 },
      { text: ov ? ov.toUpperCase() : '', prio: 82 },
      { text: orarTok, prio: 58 },
      { text: langCode(olang), prio: 30 },
      condPart,
    ];
  }
  // Generic fallback (games without a dedicated parts model yet): name-first.
  return [
    { text: f.name || '', prio: 100 },
    { text: f.num || '', prio: 85 },
    editionPart,
    { text: f.set || '', prio: 70 },
    { text: f.rarity || '', prio: 60 },
    { text: (f.finish || f.variant || ''), prio: 55 },
    { text: langCode(f.lang), prio: 30 },
    condPart,
  ];
}

export function buildTitle(game, f, max) { return fitTitle(titleParts(game, f), max || 80); }

// ---------------------------------------------------------------------------
// Descriptions — VERBATIM ports of each builder's genPitch() + buildHTML()
// (inline styles ONLY, Golden Rule 8; owner-verified wording, Golden Rule 6).
// opts (bulk-only, absent => byte-identical to the builder):
//   { slab: true }  graded slab — swaps the condition/postage lines for the slab wording.
// ---------------------------------------------------------------------------
function esc(s) { return ('' + (s == null ? '' : s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Subgrades -> a compact "Centering 9.5 · Corners 9 · Edges 9.5 · Surface 10" line for the
// description. Accepts the inventory shape (a {centering,corners,edges,surface} object or its
// JSON string) and passes an already-display string through unchanged (the single builder types
// it free-form). Blank when there's nothing gradeable.
export function formatSubgrades(sg) {
  if (!sg) return '';
  let o = sg;
  if (typeof sg === 'string') {
    const t = sg.trim();
    if (!t) return '';
    if (t[0] !== '{') return t;                       // already a display string — verbatim
    try { o = JSON.parse(t); } catch { return t; }
  }
  if (!o || typeof o !== 'object') return String(o);
  const parts = [];
  if (o.centering != null) parts.push('Centering ' + o.centering);
  if (o.corners != null) parts.push('Corners ' + o.corners);
  if (o.edges != null) parts.push('Edges ' + o.edges);
  if (o.surface != null) parts.push('Surface ' + o.surface);
  return parts.join(' · ');
}

export function pokemonPitch(f) {
  const set = String(f.set || '').replace(/\s*\([^)]*\)\s*$/, '');
  const chase = /(illustration|special|hyper|secret|ultra|rainbow|gold|alt)/i.test(f.rarity);
  if (chase) return `${f.name}, a sought-after ${f.rarity} from the Pokémon TCG ${set} set. A standout chase card for collectors.`;
  return `${f.name} from the Pokémon TCG ${set} set${f.stage ? ', ' + f.stage : ''}.${f.rarity ? ' ' + f.rarity + ' rarity.' : ''}`;
}

export function lorcanaPitch(f, rawRarity, setName) {
  setName = String(setName || '').replace(/\s*\([^)]*\)\s*$/, '');
  const name = f.name, type = (f.type || 'card').toLowerCase();
  const ink = f.ink, v = f.variant;
  // Enchanted / Epic / Iconic are foil-only printings whose words contain neither "foil" nor
  // "holo", so a bare /foil/ test called the best cards in the game non-foil.
  const foil = /foil|enchanted|iconic|epic/i.test(v || '');
  const chaseRarity = ['Legendary', 'Super Rare', 'Enchanted', 'Epic', 'Iconic'].includes(rawRarity);
  // A dual-ink card is stored hyphenated ("Amber-Steel") because the eBay aspect is one value, but
  // "Amber-Steel-ink character" is not a sentence — 187 cards are dual, and dual-ink is the game's
  // own word for them.
  const inkPhrase = ink ? (/-/.test(ink) ? ink.replace(/-/g, '/') + ' dual-ink ' : ink + '-ink ') : '';
  // Three of the six inks start with a vowel (Amber, Amethyst, Emerald), so a hardcoded "a" wrote
  // "A Amber-ink standout" on roughly half the chase cards in the game.
  const an = /^[aeiou]/i.test(inkPhrase) ? 'n' : '';
  if (foil || chaseRarity) {
    // Use the finish's own word when it has one — "the enchanted Elsa", "the iconic Ariel" — rather
    // than flattening every chase print to the word "foil".
    const vWord = foil ? (/^foil$/i.test(v || '') ? 'foil ' : String(v || '').toLowerCase() + ' ') : '';
    return `The ${vWord}${name} ${type} from Disney Lorcana, ${setName}. A${an} ${inkPhrase}standout chase card prized by collectors and players alike.`;
  }
  return `${name}, a${an} ${inkPhrase}${type} from Disney Lorcana's ${setName} set. ${rawRarity || ''} rarity${foil ? ', foil finish' : ''}.`;
}

// riftbound-listing-builder.html mapRarity() — inlined (listing-copy stays browser-safe,
// so it cannot import the fs-backed lib/riftbound-data.mjs).
function rbMapRarity(r) { return ['Alternate Art', 'Overnumbered', 'Signature', 'Ultimate'].includes(r) ? 'Showcase' : (r || ''); }

// VERBATIM port of riftbound-listing-builder.html genPitch(f, rawRarity) (MIRROR RULE).
export function riftboundPitch(f, rawRarity) {
  const setName = f.setName, name = f.name, type = (f.type || 'card'), dom = f.domain;
  const fin = f.finish === 'Foil' ? 'foil ' : '';
  const _alt = rawRarity === 'Alternate Art' || /\(alternate art\)/i.test(name);
  if (_alt) return `The Showcase alternate-art ${name} from Riftbound's ${setName} set. The premium full-art treatment and a standout chase card for collectors.`;
  if (rawRarity === 'Signature') return `The Signature ${name} from Riftbound's ${setName} set. The rarest Showcase treatment in the set and a blue-chip chase card for collectors.`;
  if (rawRarity === 'Ultimate') return `The Ultimate ${name} from Riftbound's ${setName} set. The scarcest treatment the set has and its headline chase card for collectors.`;
  if (rawRarity === 'Overnumbered') return `The Overnumbered full-art ${name} from Riftbound's ${setName} set. A sought-after special-rarity chase card for collectors.`;
  if (rawRarity === 'Showcase') return `The Showcase ${name} from Riftbound's ${setName} set. A premium full-art printing and a standout chase card for collectors.`;
  if (rawRarity === 'Epic') return `The Epic ${fin}${name} from Riftbound's ${setName} set. A ${dom || ''}${dom ? '-domain ' : ''}${type.toLowerCase()} and a solid pickup for collectors and players.`;
  return `${name} from Riftbound's ${setName} set. A ${dom ? dom + '-domain ' : ''}${type.toLowerCase()}${fin ? ', ' + f.finish.toLowerCase() : ''}. ${rbMapRarity(rawRarity)} rarity.`;
}

// VERBATIM port of mtg-listing-builder.html genPitch() (MIRROR RULE, GR6/9). The chase test fires
// on every mythic and on any card carrying a treatment — which, since `inverted` now maps to
// Borderless, includes the 20 HOB prints that used to read as plain (#239 Gleaming Splendor is
// US$83 against the base printing's US$38).
export function mtgPitch(f) {
  const set = String(f.set || '').replace(/\s*\([^)]*\)\s*$/, '');
  const chase = /(mythic)/i.test(f.rarity) || (f.treat && f.treat !== 'Normal');
  if (chase) return `${f.name}, ${f.treat && f.treat !== 'Normal' ? f.treat + ' ' : ''}${f.rarity} from ${set}. A standout pickup for collectors and players.`;
  return `${f.name}, a ${f.colour || ''} ${f.type || 'card'} from ${set}. ${f.rarity || ''}${f.finish && f.finish !== 'Nonfoil' ? ', ' + f.finish.toLowerCase() : ''}.`;
}

// A graded slab if the condition names a grading company + numeric grade — "PSA 10", "BGS 9.5",
// gradeTitleToken() output ("TAG 10 PRISTINE"), etc. Drives the slab-vs-raw wording swap when the
// caller passes no explicit opts.slab (the single-card builders don't). MIRROR: the same regex is
// inlined in pokemon-listing-builder.html buildHTML() — keep both sides identical (GR6/9).
export function isSlabCondition(cond) {
  return /\b(psa|bgs|cgc|sgc|ace|tag)\b\s*\d/i.test(cond || '');
}

function condPostage(f, opts) {
  const slab = !!(opts && opts.slab);
  // The band rides on `f`, NOT on `opts`. scripts/check-listing-copy.mjs proves the browser mirrors by
  // running buildHTML(ff) against buildDescription(game, ff) in a vm, so only what is inside `ff`
  // reaches both sides — anything passed via opts could never be mirrored. rowToFields puts the
  // resolved band there from the row's price; the single-card builders put it there from their
  // <select>. A null band quotes no amount at all, so it cannot contradict a policy.
  return {
    cond: esc(f.cond) + esc(slab ? SLAB_CONDITION_SUFFIX : CARD_CONDITION_SUFFIX),
    postage: esc((slab ? SLAB_PROTECTION : CARD_PROTECTION) + ' ' + postagePhrase(f.postageBand)),
    // RAW rows, never markup: esc() escapes & < > and would mangle a tag. Each frame builds its own
    // table so the palette stays the frame's, exactly as its detail rows already do.
    options: postageOptions(f.postageBand),
  };
}

// The postage-options table. Two columns — service, price — because a third would not survive a phone
// and `additionalShippingCost` (the obvious candidate) is per-extra-unit of the SAME line item, which
// is meaningless on the quantity-1 listings this tool makes.
// `zebra` is the frame's own alternating-row token so the table reads as part of its frame.
function optionsTable(rows, zebra) {
  if (!rows || !rows.length) return '';
  let tr = '';
  rows.filter((r) => r[1] !== '' && r[1] != null).forEach((r, i) => { const bg = i % 2 === 0 ? `background:${zebra};` : '';
    tr += `<tr style="${bg}"><td style="padding:9px 12px;color:#6b6b7e;width:68%;">${esc(r[0])}</td><td style="padding:9px 12px;color:#1a1a22;font-weight:600;">${esc(r[1])}</td></tr>`; });
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:10px 0 0;"><tbody>${tr}</tbody></table>`
    + `<p style="margin:8px 0 0;font-size:13px;color:#6b6b7e;">${esc(POSTAGE_OPTIONS_NOTE)}</p>`;
}

// VERBATIM port of swu-listing-builder.html genPitch() (MIRROR RULE, GR6/9).
export function swuPitch(f, rawRarity, setName) {
  const name = f.name, type = (f.type || 'card');
  const asp = f.aspect, v = f.variant;
  const chaseVariant = ['Hyperspace', 'Hyperspace Foil', 'Showcase', 'Prestige'].includes(v);
  const chaseRarity = ['Legendary', 'Special'].includes(rawRarity);
  const vWord = chaseVariant ? v + ' ' : '';
  // Aggression is an SWU aspect, so the article has to agree with whatever actually follows it:
  // "An Aggression-aspect", "A Command-aspect". Same idiom lorcanaPitch uses for ink.
  const aspPhrase = asp ? asp + '-aspect ' : '';
  // "uni"/"eu" words start with a consonant SOUND: a unit, a European. Without the exception the
  // no-aspect branch reads "an unit". SWU's card types are Leader, Base, Unit, Event, Upgrade.
  const an = (w) => (/^[aeiou]/i.test(w) && !/^(uni|eu)/i.test(w) ? 'n' : '');
  if (chaseVariant || chaseRarity) {
    return `The ${vWord}${name} ${type} from Star Wars: Unlimited, ${setName}. A${an(aspPhrase || 'standout')} ${aspPhrase}standout chase card prized by collectors and players alike.`;
  }
  return `${name}, a${an(aspPhrase || type)} ${aspPhrase}${type.toLowerCase()} from Star Wars: Unlimited's ${setName} set. ${rawRarity || ''} rarity${v && v !== 'Standard' ? ', ' + v.toLowerCase() + ' variant' : ''}.`;
}

// VERBATIM port of onepiece-listing-builder.html isChaseVariant()/genPitch() (MIRROR RULE, GR6/9).
// Art variants are the whole ballgame in One Piece: a parallel can be many times the base print.
export function onepieceIsChaseVariant(v) { return /alt|parallel|manga|special|box topper|\bsp\b/i.test(v || ''); }
export function onepiecePitch(f) {
  const name = f.name, type = (f.type || 'card').toLowerCase(), setName = (f.set || '').replace(/\s*\([^)]*\)\s*$/, '');
  const chase = onepieceIsChaseVariant(f.variant) || /^(SR|SEC|L)$/i.test(f.rarity || '');
  const vWord = onepieceIsChaseVariant(f.variant) ? (f.variant + ' ') : '';
  if (chase) {
    return `The ${vWord}${name} ${type} from the One Piece Card Game, ${setName}. A ${f.color ? f.color + ' ' : ''}standout prized by collectors and players alike.`;
  }
  return `${name}, a ${f.color ? f.color + ' ' : ''}${type} from the One Piece Card Game's ${setName} set.${f.rarity ? ' ' + f.rarity + ' rarity.' : ''}`;
}

export function buildDescription(game, f, opts) {
  f = f || {};
  // Explicit opts.slab wins (the bulk/channel export passes it for graded rows). Otherwise INFER a
  // graded slab from the condition string — but only for the pokemon/generic frame, so the
  // lorcana/riftbound builders (raw-only single tools) keep their byte-identical mirrors.
  const slab = (opts && opts.slab != null) ? !!opts.slab
    : (game !== 'lorcana' && game !== 'riftbound' && isSlabCondition(f.cond));
  const cp = condPostage(f, { slab });
  if (game === 'lorcana') {
    const rows = [['Set', f.set], ['Card number', f.num],
      ['Rarity', f.rarity + (f.variant && f.variant !== 'Standard' && f.variant !== f.rarity ? ', ' + f.variant : '')],
      ['Card type', f.type]];
    if (f.ink) rows.push(['Ink', f.ink]);
    if (f.cls) rows.push(['Classifications', f.cls]);
    const stat = [f.cost, f.strength, f.willpower, f.lore];
    if (stat.some(x => x !== '' && x != null)) rows.push(['Cost / Strength / Willpower / Lore', stat.map(x => (x === '' || x == null) ? '–' : x).join(' / ')]);
    rows.push(['Finish', f.variant]); rows.push(['Language', f.lang]);
    if (opts && opts.extraRows) rows.push(...opts.extraRows);
    let tr = '';
    rows.filter((r) => r[1] !== '' && r[1] != null).forEach((r, i) => { const bg = i % 2 === 0 ? 'background:#f6f7f9;' : '';
      tr += `<tr style="${bg}"><td style="padding:9px 12px;color:#6b6b7e;width:38%;">${esc(r[0])}</td><td style="padding:9px 12px;color:#1a1a22;font-weight:600;">${esc(r[1])}</td></tr>`; });
    const vSpan = (f.variant && f.variant !== 'Standard') ? ` <span style="color:#b6bac4;font-weight:600;">(${esc(f.variant)})</span>` : '';
    return `<div style="max-width:760px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a22;line-height:1.55;font-size:15px;">
  <div style="background:#1a1326;border-radius:10px 10px 0 0;padding:22px 24px;border-bottom:3px solid #c9a24b;">
    <div style="color:#c9a24b;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:6px;">Disney Lorcana</div>
    <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.25;">${esc(f.name)}${vSpan}</div>
    <div style="color:#9a91ad;font-size:14px;margin-top:4px;">${esc(f.num)} &middot; ${esc(f.set)} &middot; ${esc(f.rarity)}</div>
  </div>
  <div style="padding:20px 24px 4px;"><p style="margin:0 0 16px;">${esc(f.pitch)}</p></div>
  <div style="padding:0 24px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1a1326;font-weight:700;border-bottom:2px solid #e8eaee;padding-bottom:6px;margin-bottom:4px;">Card details</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${tr}</tbody></table>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="background:#f6f7f9;border-left:4px solid #1a1326;border-radius:0 8px 8px 0;padding:14px 16px;">
      <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1a1326;font-weight:700;margin-bottom:4px;">Condition</div>
      <p style="margin:0;">${cp.cond}</p>
    </div>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1a1326;font-weight:700;border-bottom:2px solid #e8eaee;padding-bottom:6px;margin-bottom:10px;">Postage &amp; protection</div>
    <p style="margin:0;">${cp.postage}</p>
    ${optionsTable(cp.options, '#f6f7f9')}
  </div>
  <div style="padding:18px 24px 22px;"><p style="margin:0;color:#6b6b7e;font-size:13px;">${esc(CARD_FOOTER)}</p></div>
</div>`;
  }
  if (game === 'swu' || game === 'onepiece') {
    // VERBATIM ports of swu-/onepiece-listing-builder.html buildHTML() (MIRROR RULE, GR6/9). Until
    // these existed, buildDescription('swu', …) silently rendered the POKÉMON frame — so every Star
    // Wars card the bulk/channel path listed carried Pokémon branding, and nothing caught it because
    // neither game had a parity harness. Both are raw-only single tools, so there is no slab path.
    const op = game === 'onepiece';
    const chase = op && onepieceIsChaseVariant(f.variant);
    const rows = op
      ? [['Set', f.set], ['Card code', f.num], ['Rarity', f.rarity + (chase && f.variant !== f.rarity ? ', ' + f.variant : '')], ['Card type', f.type], ['Colour', f.color]]
      : [['Set', f.set], ['Card number', f.num], ['Rarity', f.rarity + (f.variant && f.variant !== 'Standard' && f.variant !== f.rarity ? ', ' + f.variant : '')], ['Card type', f.type], ['Aspect(s)', f.aspect]];
    if (op) {
      if (f.attr) rows.push(['Attribute', f.attr]);
      if (f.traits) rows.push(['Type(s)', f.traits]);
      const stats = [f.cost !== '' ? 'Cost ' + f.cost : '', f.power !== '' ? 'Power ' + f.power : '', f.counter !== '' ? 'Counter ' + f.counter : '', f.life !== '' ? 'Life ' + f.life : ''].filter(Boolean);
      if (stats.length) rows.push(['Stats', stats.join(' · ')]);
      rows.push(['Art / variant', f.variant]);
    } else {
      if (f.arena) rows.push(['Arena', f.arena]);
      if (f.traits) rows.push(['Traits', f.traits]);
      if (f.cost || f.power || f.hp) rows.push(['Cost / Power / HP', [f.cost, f.power, f.hp].filter(x => x !== '').join(' / ')]);
      rows.push(['Finish', f.variant]);
    }
    rows.push(['Language', f.lang]);
    if (opts && opts.extraRows) rows.push(...opts.extraRows);
    let tr = '';
    rows.filter((r) => r[1] !== '' && r[1] != null).forEach((r, i) => { const bg = i % 2 === 0 ? 'background:#f6f7f9;' : '';
      tr += `<tr style="${bg}"><td style="padding:9px 12px;color:#6b6b7e;width:38%;">${esc(r[0])}</td><td style="padding:9px 12px;color:#1a1a22;font-weight:600;">${esc(r[1])}</td></tr>`; });
    const accent = op ? '#e23b3b' : '#ffe81f';
    const brand = op ? 'One Piece Card Game' : 'Star Wars: Unlimited';
    const vSpan = op
      ? (chase ? ` <span style="color:#f0b6b6;font-weight:600;">(${esc(f.variant)})</span>` : '')
      : ((f.variant && f.variant !== 'Standard') ? ` <span style="color:#b6bac4;font-weight:600;">(${esc(f.variant)})</span>` : '');
    return `<div style="max-width:760px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a22;line-height:1.55;font-size:15px;">
  <div style="background:#0b0d12;border-radius:10px 10px 0 0;padding:22px 24px;border-bottom:3px solid ${accent};">
    <div style="color:${accent};font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:6px;">${brand}</div>
    <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.25;">${esc(f.name)}${vSpan}</div>
    <div style="color:#8a8f9c;font-size:14px;margin-top:4px;">${esc(f.num)} &middot; ${esc(f.set)} &middot; ${esc(f.rarity)}</div>
  </div>
  <div style="padding:20px 24px 4px;"><p style="margin:0 0 16px;">${esc(f.pitch)}</p></div>
  <div style="padding:0 24px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#0b0d12;font-weight:700;border-bottom:2px solid #e8eaee;padding-bottom:6px;margin-bottom:4px;">Card details</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${tr}</tbody></table>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="background:#f6f7f9;border-left:4px solid #1c1f26;border-radius:0 8px 8px 0;padding:14px 16px;">
      <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#0b0d12;font-weight:700;margin-bottom:4px;">Condition</div>
      <p style="margin:0;">${cp.cond}</p>
    </div>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#0b0d12;font-weight:700;border-bottom:2px solid #e8eaee;padding-bottom:6px;margin-bottom:10px;">Postage &amp; protection</div>
    <p style="margin:0;">${cp.postage}</p>
    ${optionsTable(cp.options, '#f6f7f9')}
  </div>
  <div style="padding:18px 24px 22px;"><p style="margin:0;color:#6b6b7e;font-size:13px;">${esc(CARD_FOOTER)}</p></div>
</div>`;
  }
  if (game === 'riftbound') {
    // VERBATIM port of riftbound-listing-builder.html buildHTML() (LoL palette; MIRROR RULE, GR6/8/9).
    const rows = [['Set', f.set], ['Card number', f.num], ['Rarity', f.rarity + (f.variant && f.variant !== f.rarity ? ', ' + f.variant : '')], ['Card type', f.type], ['Domain', f.domain]];
    if (f.tags) rows.push(['Tags', f.tags]);
    if ((f.e || f.p || f.m) && /unit/i.test(f.type || '')) rows.push(['Energy / Power / Might', [f.e, f.p, f.m].filter(x => x !== '').join(' / ')]);
    rows.push(['Finish', f.finish]); rows.push(['Language', f.lang]);
    let tr = ''; rows.filter((r) => r[1] !== '' && r[1] != null).forEach((r, i) => { const bg = i % 2 === 0 ? 'background:#f5f6fa;' : '';
      tr += `<tr style="${bg}"><td style="padding:9px 12px;color:#6b6b7e;width:38%;">${esc(r[0])}</td><td style="padding:9px 12px;color:#1a1a22;font-weight:600;">${esc(r[1])}</td></tr>`; });
    const vSpan = f.variant ? ` <span style="color:#aeb9d4;font-weight:600;">(${esc(f.variant)})</span>` : '';
    return `<div style="max-width:760px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a22;line-height:1.55;font-size:15px;">
  <div style="background:#091428;border-radius:10px 10px 0 0;padding:22px 24px;border-bottom:3px solid #c8aa6e;">
    <div style="color:#c8aa6e;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:6px;">Riftbound &middot; League of Legends TCG</div>
    <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.25;">${esc(f.name)}${vSpan}</div>
    <div style="color:#7e8db0;font-size:14px;margin-top:4px;">${esc(f.num)} &middot; ${esc(f.set)} &middot; ${esc(f.rarity)}</div>
  </div>
  <div style="padding:20px 24px 4px;"><p style="margin:0 0 16px;">${esc(f.pitch)}</p></div>
  <div style="padding:0 24px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#091428;font-weight:700;border-bottom:2px solid #e6e9f2;padding-bottom:6px;margin-bottom:4px;">Card details</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${tr}</tbody></table>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="background:#f5f6fa;border-left:4px solid #c8aa6e;border-radius:0 8px 8px 0;padding:14px 16px;">
      <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#091428;font-weight:700;margin-bottom:4px;">Condition</div>
      <p style="margin:0;">${cp.cond}</p>
    </div>
  </div>
  <div style="padding:18px 24px 4px;">
    <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#091428;font-weight:700;border-bottom:2px solid #e6e9f2;padding-bottom:6px;margin-bottom:10px;">Postage &amp; protection</div>
    <p style="margin:0;">${cp.postage}</p>
    ${optionsTable(cp.options, '#f5f6fa')}
  </div>
  <div style="padding:18px 24px 22px;"><p style="margin:0;color:#6b6b7e;font-size:13px;">${esc(CARD_FOOTER)}</p></div>
</div>`;
  }
  if (game === 'mtg') {
    // VERBATIM port of mtg-listing-builder.html buildHTML() (MIRROR RULE, GR6/9). Same structure as
    // the Pokémon frame — specimen list, art beside the pitch, slab-aware wording — in Magic's own
    // palette (#1a1510 / #c9923f), so the visual identity the builder already had is unchanged.
    const rows = [['Card Name', f.name]];
    rows.push(['Set', f.set]);
    rows.push(['Collector number', f.num]);
    rows.push(['Rarity', f.rarity]);
    if (f.colour) rows.push(['Colour', f.colour]);
    if (f.type) rows.push(['Card type', f.type]);
    // 'Normal' is the absence of a treatment, not a treatment — printing it reads like a claim.
    if (f.treat && f.treat !== 'Normal') rows.push(['Treatment', f.treat]);
    if (f.promo) rows.push(['Special print', f.promo]);
    if (f.illustrator) rows.push(['Illustrator', f.illustrator]);
    rows.push(['Finish', f.finish]); rows.push(['Language', f.lang]);
    if (f.releaseYear) rows.push(['Released', f.releaseYear]);
    if (f.cert) rows.push(['Cert number', f.cert]);
    if (f.subgrades) rows.push(['Subgrades', f.subgrades]);
    if (opts && opts.extraRows) rows.push(...opts.extraRows);
    let tr = ''; rows.forEach((r) => {
      tr += `<tr><td style="padding:11px 14px 11px 0;border-bottom:1px solid #ece7df;color:#7c6f5c;font-size:11px;letter-spacing:.13em;text-transform:uppercase;vertical-align:top;width:42%;">${esc(r[0])}</td><td style="padding:11px 0;border-bottom:1px solid #ece7df;color:#1f1a13;font-size:15px;font-weight:600;">${esc(r[1])}</td></tr>`;
    });

    // Magic has no set WORDMARK (Scryfall publishes only the symbol), so the masthead falls back to
    // the set name — the conditional is kept so a logo drops in the day one exists.
    const logoHtml = f.setLogoUrl
      ? `<img src="${esc(f.setLogoUrl)}" alt="${esc(f.set)} set logo" style="height:34px;width:auto;max-width:58%;vertical-align:middle;" />`
      : `<span style="color:#e8ddc9;font-size:17px;vertical-align:middle;line-height:34px;">${esc(f.set)}</span>`;
    // Scryfall's set icons are MONOCHROME BLACK SVGs with no fill attribute, and this masthead is
    // #1a1510 — black on near-black is an invisible symbol. The white chip is what makes it read.
    const symHtml = f.setSymbolUrl ? `<img src="${esc(f.setSymbolUrl)}" alt="" style="height:15px;width:auto;vertical-align:-3px;margin-right:7px;background:#ffffff;border-radius:4px;padding:2px;" />` : '';

    const artHtml = f.img
      ? `<div style="padding:26px 26px 0;font-size:0;">
    <div style="display:inline-block;vertical-align:middle;width:210px;max-width:100%;padding:0 22px 0 0;box-sizing:border-box;">
      <img src="${esc(f.img)}" alt="${esc(f.name)} ${esc(f.num)} ${esc(f.set)} Magic: The Gathering ${esc(f.lang)} card" style="width:100%;height:auto;display:block;border-radius:5px;" />
    </div><div style="display:inline-block;vertical-align:middle;width:calc(100% - 216px);min-width:280px;font-size:16px;box-sizing:border-box;">
      <div style="font-family:${SANS_UI};font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#7c6f5c;font-weight:700;margin:14px 0 9px;">${esc(f.rarity)}</div>
      <p style="margin:0;font-size:17px;line-height:1.6;color:#3d3529;">${esc(f.pitch)}</p>
    </div>
  </div>`
      : `<div style="padding:26px 26px 0;"><p style="margin:0;font-size:17px;line-height:1.65;color:#3d3529;">${esc(f.pitch)}</p></div>`;
    return `<div style="max-width:760px;margin:0 auto;font-family:${SERIF_BODY};color:#1f1a13;line-height:1.6;font-size:16px;background:#ffffff;">
  <div style="background:#1a1510;padding:26px 26px 22px;">
    <div style="font-family:${SANS_UI};color:#c9923f;font-size:10.5px;letter-spacing:.24em;text-transform:uppercase;font-weight:700;">Binders Keepers &middot; Magic: The Gathering</div>
    <div style="color:#ffffff;font-size:30px;font-weight:400;line-height:1.15;margin-top:12px;letter-spacing:-.01em;">${esc(f.name)}</div>
    <div style="margin-top:16px;padding-top:15px;border-top:1px solid rgba(201,146,63,.28);">
      ${logoHtml}
      <span style="float:right;color:#e8ddc9;font-family:${MONO_DATA};font-size:22px;font-variant-numeric:tabular-nums;line-height:34px;">${symHtml}${esc(f.num)}</span>
      <span style="display:block;clear:both;"></span>
    </div>
  </div>
  <div style="height:3px;background:#c9923f;"></div>
  ${artHtml}
  <div style="padding:24px 26px 0;">
    <div style="font-family:${SANS_UI};font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#7c6f5c;font-weight:700;padding-bottom:9px;border-bottom:2px solid #1a1510;">The card</div>
    <table style="width:100%;border-collapse:collapse;font-family:${SANS_UI};"><tbody>${tr}</tbody></table>
  </div>
  <div style="padding:24px 26px 0;">
    <div style="border:1px solid #e4dbc9;border-left:4px solid #1a1510;padding:16px 18px;background:#faf8f4;">
      <div style="font-family:${SANS_UI};font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#7c6f5c;font-weight:700;margin-bottom:7px;">Condition</div>
      <p style="margin:0;font-size:16px;">${cp.cond}</p>
    </div>
  </div>
  <div style="padding:22px 26px 0;">
    <div style="font-family:${SANS_UI};font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#7c6f5c;font-weight:700;margin-bottom:7px;">Postage &amp; protection</div>
    <p style="margin:0;font-size:16px;">${cp.postage}</p>
    ${optionsTable(cp.options, '#f6f7f9')}
  </div>
  <div style="padding:22px 26px 26px;margin-top:20px;border-top:1px solid #ece7df;">
    <p style="margin:0;color:#7c6f5c;font-size:14px;font-style:italic;">${esc(CARD_FOOTER)}</p>
  </div>
</div>`;
  }
  // pokemon + generic fallback share the Pokémon frame (navy/gold) — the generic
  // case only differs in the eyebrow text.
  const eyebrow = 'Binders Keepers &middot; ' + (game === 'pokemon' ? 'Pok&eacute;mon TCG' : esc(f.gameLabel || 'Trading Card'));
  // MIRROR of pokemon-listing-builder.html buildHTML() rows — conditional rows self-skip when empty.
  const nlab = (f.lang || '').replace(/\s*\(.*$/, '').trim() || 'Original';
  const rows = [['Card Name', f.name]];
  if (f.nativeName) rows.push([nlab + ' name', f.nativeName + (f.romaji ? ' ' + f.romaji : '')]);
  rows.push(['Set', f.set + (f.nativeSet ? ' (' + f.nativeSet + ')' : '')]);
  if (f.setSymbol) rows.push(['Set code', f.setSymbol]);
  rows.push(['Card number', f.num]);
  rows.push(['Rarity', rarDisplay(f.rarity)]);
  // Pokémon-only rows, conditional: a Trainer or Energy card has no species and no stage, and the API
  // path had no species at all until 2026-07, which is how the first live listing shipped a CARD
  // DETAILS table with three blank rows. MIRRORED in pokemon-listing-builder.html buildHTML (GR9).
  if (game === 'pokemon') { if (f.poke) rows.push(['Pokémon', f.poke]); if (f.stage) rows.push(['Stage', f.stage]); }
  if (f.type) rows.push(['Type', f.type]);
  if (f.hp) rows.push(['HP', f.hp]);
  if (f.illustrator) rows.push(['Illustrator', f.illustrator]);
  if (f.regMark) rows.push(['Regulation mark', f.regMark]);
  if (f.edition) rows.push(['Edition', f.edition]);
  rows.push(['Finish', f.finish]); rows.push(['Language', f.lang]);
  if (f.releaseYear) rows.push(['Released', f.releaseYear]);
  if (f.enSet) rows.push(['English set', f.enSet]);
  if (f.cert) rows.push(['Cert number', f.cert]);
  if (f.subgrades) rows.push(['Subgrades', f.subgrades]);
  if (opts && opts.extraRows) rows.push(...opts.extraRows);
  // A specimen list, not a zebra table: label above the rule, value under it, hairline between.
  let tr = ''; rows.forEach((r) => {
    tr += `<tr><td style="padding:11px 14px 11px 0;border-bottom:1px solid #ece7f0;color:#7a6f85;font-size:11px;letter-spacing:.13em;text-transform:uppercase;vertical-align:top;width:42%;">${esc(r[0])}</td><td style="padding:11px 0;border-bottom:1px solid #ece7f0;color:#1b1420;font-size:15px;font-weight:600;">${esc(r[1])}</td></tr>`;
  });

  // The masthead identifies with the set's own LOGO where we have one, falling back to its name.
  // Black Star Promo listings carry the PROMO star in that slot instead (composeMetaFor puts it
  // there — no promo era has a wordmark). The star's art is BLACK and this masthead is near-black,
  // so it ships CSS-inverted (white star, dark lettering) unless f.promoStarStyle says 'normal':
  // the publish path sets that field from the same settings toggle the rails obey, and a caller
  // without it gets the inverted default. If eBay's sanitizer ever drops the filter style, the
  // fallback is today's black-on-navy — dated, not broken. MIRROR: pokemon-listing-builder.html.
  const promoStar = /\/svp\/symbol\.png$/i.test(f.setLogoUrl || '');
  const logoHtml = f.setLogoUrl
    ? `<img src="${esc(f.setLogoUrl)}" alt="${promoStar ? 'Black Star Promo' : esc(f.set) + ' set logo'}" style="height:34px;width:auto;max-width:58%;vertical-align:middle;${promoStar && f.promoStarStyle !== 'normal' ? 'filter:invert(1);' : ''}" />`
    : `<span style="color:#efe8f6;font-size:17px;vertical-align:middle;line-height:34px;">${esc(f.set)}</span>`;
  const symHtml = f.setSymbolUrl ? `<img src="${esc(f.setSymbolUrl)}" alt="" style="height:17px;width:auto;vertical-align:-2px;margin-right:7px;" />` : '';

  // Card art beside the pitch, vertically centred — and STACKED on a phone.
  //
  // Two inline-blocks rather than table cells, because eBay strips <style> and there are no media
  // queries: a table row cannot stack, it only gets narrower, and at 360px that squeezed the copy to
  // ~23 characters a line. These share a line while both fit and the copy wraps onto its own line
  // once it cannot hold `min-width`, which is the stacking a media query would otherwise buy.
  // `width:calc(100% - 216px)` is deliberate — an inline-block sizes against its CONTAINER, not the
  // space left on the line, so without it the copy claims the full width and always wraps.
  const pitchHtml = esc(f.pitch);
  const artHtml = f.img
    ? `<div style="padding:26px 26px 0;font-size:0;">
    <div style="display:inline-block;vertical-align:middle;width:210px;max-width:100%;padding:0 22px 0 0;box-sizing:border-box;">
      <img src="${esc(f.img)}" alt="${esc(f.name)} ${esc(f.num)} ${esc(f.set)} Pok&eacute;mon TCG ${esc(f.lang)} card" style="width:100%;height:auto;display:block;border-radius:5px;" />
    </div><div style="display:inline-block;vertical-align:middle;width:calc(100% - 216px);min-width:280px;font-size:16px;box-sizing:border-box;">
      <div style="font-family:${SANS_UI};font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#7a6f85;font-weight:700;margin:14px 0 9px;">${esc(rarDisplay(f.rarity))}</div>
      <p style="margin:0;font-size:17px;line-height:1.6;color:#3a3244;">${pitchHtml}</p>
    </div>
  </div>`
    : `<div style="padding:26px 26px 0;"><p style="margin:0;font-size:17px;line-height:1.65;color:#3a3244;">${pitchHtml}</p></div>`;

  return `<div style="max-width:760px;margin:0 auto;font-family:${SERIF_BODY};color:#1b1420;line-height:1.6;font-size:16px;background:#ffffff;">
  <div style="background:#160f1d;padding:26px 26px 22px;">
    <div style="font-family:${SANS_UI};color:#d4b072;font-size:10.5px;letter-spacing:.24em;text-transform:uppercase;font-weight:700;">${eyebrow}</div>
    <div style="color:#ffffff;font-size:30px;font-weight:400;line-height:1.15;margin-top:12px;letter-spacing:-.01em;">${esc(f.name)}</div>
    <div style="margin-top:16px;padding-top:15px;border-top:1px solid rgba(212,176,114,.28);">
      ${logoHtml}
      <span style="float:right;color:#efe8f6;font-family:${MONO_DATA};font-size:22px;font-variant-numeric:tabular-nums;line-height:34px;">${symHtml}${esc(f.num)}</span>
      <span style="display:block;clear:both;"></span>
    </div>
  </div>
  <div style="height:3px;background:#d4b072;"></div>
  ${artHtml}
  <div style="padding:24px 26px 0;">
    <div style="font-family:${SANS_UI};font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#7a6f85;font-weight:700;padding-bottom:9px;border-bottom:2px solid #160f1d;">The card</div>
    <table style="width:100%;border-collapse:collapse;font-family:${SANS_UI};"><tbody>${tr}</tbody></table>
  </div>
  <div style="padding:24px 26px 0;">
    <div style="border:1px solid #e0d8e8;border-left:4px solid #160f1d;padding:16px 18px;background:#faf8fb;">
      <div style="font-family:${SANS_UI};font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#7a6f85;font-weight:700;margin-bottom:7px;">Condition</div>
      <p style="margin:0;font-size:16px;">${cp.cond}</p>
    </div>
  </div>
  <div style="padding:22px 26px 0;">
    <div style="font-family:${SANS_UI};font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#7a6f85;font-weight:700;margin-bottom:7px;">Postage &amp; protection</div>
    <p style="margin:0;font-size:16px;">${cp.postage}</p>
    ${optionsTable(cp.options, '#f6f7f9')}
  </div>
  <div style="padding:22px 26px 26px;margin-top:20px;border-top:1px solid #ece7f0;">
    <p style="margin:0;color:#7a6f85;font-size:14px;font-style:italic;">${esc(CARD_FOOTER)}</p>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// ImportRow/BulkRow -> the builder-shaped field object f_* that titleParts and
// buildDescription consume. One adapter so the grid, channel map and harnesses
// all shape rows identically.
// ---------------------------------------------------------------------------
// A row's postage band. `postage_band_id` is the owner's per-listing override and wins outright; an id
// naming no configured band falls through to the price rather than silently picking band 1.
function resolveRowBand(row, graded, opts) {
  const shipping = (opts && opts.shipping) || undefined;
  const override = String(row.postage_band_id || '').trim();
  if (override) {
    const { bands } = shippingOf(shipping);
    const hit = bands.find((b) => b.id === override);
    if (hit) return hit;
  }
  const priceCents = row.target_price_cents != null ? row.target_price_cents : row.price_cents;
  return bandForListing(priceCents, shipping, { slab: graded });
}

// opts.shipping is the shipping config sub-object ({ minBandForSlab, bands }); a bare bands array works
// too. Callers that have the live config pass it (toEbayListing); the bulk grid PREVIEW passes nothing
// and gets the code defaults, which test/invariants/shipping-band-copy.test.mjs pins equal to the
// tracked example config. Publish always resolves from the loaded config, never from the fallback.
export function rowToFields(row, opts) {
  row = row || {};
  const graded = !!(row.graded || row.grading_company);
  const f = {
    name: row.name || '',
    num: row.number || '',
    set: row.set_name || '',
    rarity: row.rarity || '',
    finish: row.finish || '',
    variant: row.finish || '',           // lorcana titles read f.variant
    lang: languageWord(row.language) || 'English',
    cond: graded ? gradeTitleToken(row.grading_company, row.grade, row.grade_label) : (row.condition || DEFAULT_CARD_CONDITION),
    edition: row.edition || '',
    graded,
    grading_company: row.grading_company || null,
    grade: row.grade != null ? row.grade : null,
    grade_label: row.grade_label || '',
    cert: graded ? (row.cert_number || '') : '',          // surfaced as a description detail row when present
    subgrades: graded ? formatSubgrades(row.subgrades) : '',
    poke: row.poke || '', stage: row.stage || '', type: row.type || '', pitch: '',
    // pokemontcg.io SEO extras. buildDescription already renders a conditional row for each of these
    // (mirrored in pokemon-listing-builder.html buildHTML); they were simply never populated on the
    // API path, so a listing built from a DB row came out with a half-empty table and no picture.
    hp: row.hp || '', illustrator: row.illustrator || '', regMark: row.regMark || '',
    setSymbol: row.setSymbol || '', releaseYear: row.releaseYear || '', img: row.img || '',
    // Non-English provenance, exactly the same story as the SEO extras above: buildDescription has
    // always rendered a conditional row for each (the "<Language> name", the native set beside the
    // English one, and the "English set" cross-reference), and the single-card builder has always
    // filled them — the API path never did, so a Japanese listing built from a DB row came out
    // looking like an English one that had lost its set name. Fed from card_facts via buildRowIn.
    nativeName: row.nativeName || row.native_name || '',
    romaji: row.romaji || '',
    nativeSet: row.nativeSet || row.native_set || '',
    enSet: row.enSet || row.en_set || '',
    // Set ART for the masthead — the logo (wordmark) and the symbol (mark). Distinct from
    // `setSymbol` above, which is the printed symbol's NAME and stays a text row in the table.
    // Absent is fine: the masthead falls back to the set name and drops the mark.
    setLogoUrl: row.setLogoUrl || '', setSymbolUrl: row.setSymbolUrl || '',
    // 'normal' | anything else = inverted. Only the promo star reads it; set by buildItemDescription
    // from the listing-image settings toggle, so the masthead and the rails cannot disagree.
    promoStarStyle: row.promoStarStyle || '',
    // The postage band this listing sits in, which decides the amount the description quotes AND the
    // fulfilment policy the offer carries. An explicit postage_band_id is the per-listing override;
    // otherwise it comes from the price, using the SAME precedence toEbayListing uses for price_cents
    // (target over current), so the description and the offer can never disagree about which band.
    postageBand: resolveRowBand(row, graded, opts),
  };
  if (row.game === 'riftbound') {
    // riftbound reads its own variant (identity: Alternate Art / Overnumbered / Signature, NOT
    // the finish) and card facts (type/domain/tags/stats) carried on the row from enumerate/
    // import, or re-resolved from the baked catalog at export time (lib/channels/ebay-map.mjs).
    f.variant = row.variant || '';
    f.type = row.rb_type || '';
    f.domain = row.rb_domain || '';
    f.tags = row.rb_tags || '';
    f.e = row.rb_e != null ? row.rb_e : '';
    f.p = row.rb_p != null ? row.rb_p : '';
    f.m = row.rb_m != null ? row.rb_m : '';
    f.setName = (row.set_name || '').replace(/\s*\([^)]*\)\s*$/, '');
    // The row stores the MAPPED rarity — 'Showcase' for alt-art, Overnumbered, Signature AND the
    // SP promos alike — so after the DB round-trip the variant is the only thing that still tells
    // them apart. Pass it through; fall back to the rarity for base prints, which have no variant.
    f.pitch = riftboundPitch(f, f.variant || f.rarity);
  } else if (row.game === 'mtg') {
    // Scryfall facts are not persisted on inventory_items (identity is), so they arrive either on
    // the row from the import or re-resolved at export time — same move riftbound makes above.
    f.colour = row.colour || '';
    f.type = row.type || row.card_type || '';
    f.treat = row.treat || row.treatment || '';
    f.promo = row.promo || '';
    // The stored language is a CODE ('DW') and the description row wants the word — but this row may
    // ALSO arrive with the name already resolved (buildRowIn calls ebayLanguageName on the way in).
    // So only convert what is actually a code; anything else is already the display form and must be
    // left alone, or 'Dwarvish' round-trips to 'dwarvish'.
    f.lang = MTG_LANG[String(row.language || '').toLowerCase()] || f.lang;
    f.pitch = mtgPitch(f);
  } else if (row.game === 'lorcana') {
    // Lorcast's facts are not persisted on inventory_items (identity is), so they arrive either on
    // the row from the import or re-resolved at export time by buildRowIn — the same move riftbound
    // and mtg make above. Without this the CARD DETAILS table came out with only the rows derivable
    // from the identity: no ink, no classifications, no stats.
    f.type = row.type || row.card_type || '';
    f.ink = row.ink || '';
    f.cls = row.cls || row.classifications || '';
    f.cost = row.cost != null ? row.cost : '';
    f.strength = row.strength != null ? row.strength : '';
    f.willpower = row.willpower != null ? row.willpower : '';
    f.lore = row.lore != null ? row.lore : '';
    f.pitch = lorcanaPitch(f, f.rarity, f.set);
  } else if (row.game === 'swu' || row.game === 'onepiece') {
    // Without these two branches both games fell to the `else` below and were given a POKÉMON pitch:
    // a Star Wars listing published from stock read "Darth Vader from the Pokémon TCG Spark of
    // Rebellion (SOR) set." The frames were fixed when buildDescription learned these games (see the
    // note at the swu/onepiece frame); rowToFields was missed, so the prose stayed wrong.
    //
    // Every fact is normalised to '' rather than left undefined, because the frames were written
    // against the BUILDERS' contract, where val() always returns a string. `f.cost !== ''` reads as
    // TRUE for undefined, which is how a One Piece table came to print "Cost undefined · Power
    // undefined · Counter undefined · Life undefined" on every listing published from stock.
    const s = (v) => (v == null ? '' : String(v));
    f.type = s(row.type || row.card_type);
    f.variant = s(row.variant);
    f.traits = s(row.traits);
    f.cost = s(row.cost);
    f.power = s(row.power);
    if (row.game === 'onepiece') {
      f.color = s(row.color || row.colour);
      f.attr = s(row.attr || row.attribute);
      f.counter = s(row.counter != null ? row.counter : row.counter_amount);
      f.life = s(row.life);
      f.pitch = onepiecePitch(f);
    } else {
      f.aspect = s(row.aspect);
      f.arena = s(row.arena);
      f.hp = s(row.hp);
      // swuPitch takes the set NAME separately, and the frame's own set cell keeps the code, so strip
      // the trailing "(SOR)" the way riftbound does rather than reading "Spark of Rebellion (SOR) set".
      f.pitch = swuPitch(f, f.rarity, f.set.replace(/\s*\([^)]*\)\s*$/, ''));
    }
  } else {
    f.pitch = pokemonPitch(f);
  }
  return f;
}

// Multi-variation "pick your single" helpers (EXPERIMENTAL on EBAY_AU — only
// Card Condition/Customised are variation-enabled aspects in 183454; gate on a
// real sample upload before relying on this shape).
export function variationTitle(game, setName, opts) {
  opts = opts || {};
  // mtg -> 'MTG' fell out of toUpperCase() by accident; name it so a rename cannot silently change it.
  const gameWord = game === 'pokemon' ? 'Pokemon' : game === 'lorcana' ? 'Disney Lorcana' : game === 'mtg' ? 'MTG' : game.toUpperCase();
  return fitTitle([
    { text: gameWord, prio: 100 },
    { text: setName, prio: 95 },
    { text: 'Singles', prio: 90 },
    { text: opts.scope || 'Commons & Uncommons', abbr: 'C/UC', prio: 60 },
    { text: '- Pick Your Card', abbr: '- Choose', prio: 80 },
    { text: opts.cond || 'M/NM', prio: 70 },
  ], 80);
}
export function variationAttrs(row) {
  // Single 'Card' axis: number + name + finish (custom specific — see note above).
  return { Card: [row.number, row.name, row.finish && row.finish !== 'Normal' ? row.finish : ''].filter(Boolean).join(' ') };
}
