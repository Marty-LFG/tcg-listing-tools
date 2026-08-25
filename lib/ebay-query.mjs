// lib/ebay-query.mjs — how a card becomes an eBay search.
//
// One identity in, a complete SEARCH PLAN out: the keyword string, the structured filters, the
// Browse request, the human-clickable URL, and the hints the downstream title filter needs so the
// two halves cannot disagree. Browser-safe (no node:), because ebay-testbed.html builds the same
// plan the server does.
//
// ---------------------------------------------------------------------------
// THE MEASUREMENT THIS MODULE EXISTS FOR  (live Browse API, AU, 2026-08-24)
// ---------------------------------------------------------------------------
// Card Ladder searches eBay with a short include-core and ~50 exclusion terms. Copying that shape
// naively would have quietly broken our comps, because of one non-obvious rule:
//
//   ANY exclusion term flips the WHOLE query from stemmed matching to literal matching.
//
// A nonsense exclusion that can match nothing still collapses the result set:
//     pokemon boosters            159,722
//     pokemon boosters -qxzvwj        623
//
// And under literal matching the expensive tokens are the ones WE add automatically:
//     Charizard 199 -zzqx                                       93
//     Charizard ex 199/165 -zzqx                                75
//     Pokemon Charizard ex 199/165 -zzqx                        38   <- the game word alone halves it
//     Pokemon Charizard ex 199/165 Scarlet & Violet 151 -zzqx     6   <- the set name costs the rest
//
// Sellers write "Charizard ex 199/165 SV151 NM" without ever typing "Pokemon". So exclusions cannot
// be bolted onto our existing long query — Card Ladder's core is short BECAUSE their exclusions
// force literal matching. That is why a mode here owns a `coreFields` budget: choosing to exclude
// is choosing a different query shape, not adding a suffix.
//
// ---------------------------------------------------------------------------
// AND WHY MOST OF THEIR LIST IS NOT WORTH COPYING
// ---------------------------------------------------------------------------
// Everything they simulate with keywords, eBay exposes structurally on category 183454, where it is
// exact instead of inferred:
//     -Graded -PSA -Beckett -BGS ... (50 terms)   ->  Graded:{No}          (99.8% filled)
//     (PSA8,8) -(PSA 7.5) -(PSA 7) ... (20 terms) ->  Grade:{8}            (99.4% within graded)
//     -Lot -Sealed -Box -Bundle                   ->  category_ids=183454  (lots/sealed are siblings)
// `Grade:{8}` returned 2 results where twenty exclusion terms were needed to approximate it.
//
// Their list is also actively wrong for a Pokémon search (see GRADERS below: -EX kills Charizard
// ex, -HP is a three-way collision) and omits every grader that matters in Australia — CGA, TCG and
// ARK each out-list BGS here. So this module adopts their SHAPE (vocabulary as togglable packs,
// generated grade ladders) and very little of their CONTENT.
//
// The exclusion modes are therefore built to be MEASURED, not because they are expected to win:
// singlesEbayValue refuses below minComps and its relaxation ladder wants 5 rows a rung, so a
// query returning 6 totals cannot feed it, while a loose one returning 200 and filtering to 12 can.
// Rank modes by cluster size and price delta, never by how few results they return.
import { CATEGORY, COND_ID, CARD_CONDITION, PROFESSIONAL_GRADER, GAME_ASPECT, aspectIsTrusted } from './ebay-vocab.mjs';

// ---------------------------------------------------------------------------
// Grading companies, as data
// ---------------------------------------------------------------------------
// `safe` is the whole point of this table. An exclusion term is only safe if it CANNOT mean
// something else in a card title, and several of the abbreviations that circulate in US grader
// lists are landmines in a Pokémon search. Every `why` below is the collision, recorded so the UI
// can explain a greyed-out checkbox instead of just disabling it.
//
// `au` marks the graders that actually appear in this market, measured from the live AU aspect
// distribution rather than assumed: CGA 2252, TCG 1072, ARK 856 — all ahead of BGS at 966.
export const GRADERS = {
  PSA: { safe: true, au: true, why: null },
  BGS: { safe: true, au: true, why: null },
  CGC: { safe: true, au: true, why: null },
  SGC: { safe: true, au: true, why: null },
  CGA: { safe: true, au: true, why: null },
  ARK: { safe: true, au: true, why: null },
  PCG: { safe: true, au: true, why: null },
  ACG: { safe: true, au: true, why: null },
  ICG: { safe: true, au: true, why: null },
  ACE: { safe: true, au: true, why: null },
  BVG: { safe: true, au: false, why: null },
  BCCG: { safe: true, au: false, why: null },
  HGA: { safe: true, au: false, why: null },
  GMA: { safe: true, au: false, why: null },
  KSA: { safe: true, au: false, why: null },
  AGS: { safe: true, au: false, why: null },
  ISA: { safe: true, au: false, why: null },
  MNT: { safe: true, au: false, why: null },
  ARS: { safe: true, au: false, why: null },
  Beckett: { safe: true, au: true, why: null },

  // --- NOT safe to exclude. Each of these removes real listings for the card you are pricing. ---
  TAG: { safe: false, au: true, why: 'Tag All Stars is a real JP set, TAG TEAM GX is a card mechanic, and "new with tags" is eBay boilerplate — and TAG is a grader you may want to keep' },
  TCG: { safe: false, au: true, why: 'TCG Grading is a real AU grader (1072 AU listings) but "TCG" appears in a huge share of all card titles' },
  CCG: { safe: false, au: false, why: "eBay's own category names are 'CCG Individual Cards', 'CCG Sealed Packs' — this fights the taxonomy" },
  PCA: { safe: false, au: false, why: 'Planechase Anthology (MTG set code); also a plausible mistyping of PSA' },
  DCI: { safe: false, au: false, why: 'the DCI watermark is printed on every MTG judge promo' },
  PGA: { safe: false, au: false, why: 'Professional Golfers Association — golf cards' },
  VGT: { safe: false, au: false, why: 'the common transposition of VTG = "vintage", one of the most-used words in collectibles titles' },
  CEX: { safe: false, au: false, why: 'CeX is a live UK/AU second-hand chain that sells Pokémon and slabs' },
  BSG: { safe: false, au: false, why: 'Battlestar Galactica card sets; also a common typo of BGS' },
  PG: { safe: false, au: false, why: 'two letters — collides with far too much to be worth the recall' },

  // --- Unverified. Present in circulating lists; no company found. Never default-on. ---
  BGN: { safe: false, au: false, verified: false, why: 'no such company found — almost certainly a corruption of BGS' },
  PBI: { safe: false, au: false, verified: false, why: 'no company found' },
  CGI: { safe: false, au: false, verified: false, why: 'not a card grader; likely an OCR slip for CGC' },
  DCS: { safe: false, au: false, verified: false, why: 'one directory entry, no site' },
  RCR: { safe: false, au: false, verified: false, why: 'Beckett Raw Card Review is a SERVICE, not a slab brand' },
};

// Grade scales, for generating a below-this-grade exclusion ladder. Kept as a literal because this
// module must stay node-free; test/invariants/ebay-query-vocab.test.mjs asserts every company in
// data/grading-companies.json is known here, so adding one to the registry cannot leave the query
// blind to it.
export const GRADE_STEP = { PSA: 1, BGS: 0.5, CGC: 0.5, SGC: 0.5, TAG: 0.5, ARK: 0.5, TCG: 0.5, CGA: 0.5, PCG: 0.5, PCGCN: 0.5, EMC: 0.5, JBH: 0.5 };

// ---------------------------------------------------------------------------
// Terms that must never be excluded
// ---------------------------------------------------------------------------
// These are not judgement calls, they are collisions with the card being priced. `-EX` and `-HP`
// are the two that would do the most damage and are both present in the lists that circulate.
export const UNSAFE_TERMS = {
  ex: 'Charizard ex, every Pokémon-EX, the whole EX-series of set names, and Expedition Base Set whose code IS "EX"',
  hp: 'a three-way collision: hit points (printed on every card, ~93% of HP tokens in modern titles), Heavily Played (~80% in vintage), and EX Holon Phantoms whose set code is HP',
  gx: 'a card mechanic printed on thousands of cards',
  v: 'the Pokémon V mechanic',
  vmax: 'the Pokémon VMAX mechanic',
  sv: 'Scarlet & Violet, Supreme Victors, and Shiny Vault all abbreviate to SV',
  ar: 'Arceus the set vs Art Rare the rarity — very common in modern titles',
  holo: 'the finish you are usually trying to MATCH, not remove',
  rare: 'a rarity printed in most titles',
  mint: 'the condition you usually want',
  promo: 'a legitimate print run, not noise',
  full: '"Full Art" is a real treatment',
  st: 'collides with "1st Edition"',
  first: 'collides with "1st Edition"',
};
export function isUnsafeExclusion(term) {
  const t = String(term == null ? '' : term).trim().toLowerCase().replace(/^-/, '');
  if (UNSAFE_TERMS[t]) return UNSAFE_TERMS[t];
  const g = GRADERS[t.toUpperCase()];
  return g && g.safe === false ? g.why : null;
}

// ---------------------------------------------------------------------------
// Exclusion packs
// ---------------------------------------------------------------------------
// Only spelled-out phrases and unambiguous abbreviations. The two-letter condition codes (LP/MP/HP)
// are deliberately absent: HP is unsafe outright, and the others buy little once `Card Condition`
// (97.8% filled) can gate the same thing exactly.
export const PACKS = {
  graders: { label: 'Rival graders', terms: Object.keys(GRADERS).filter((g) => GRADERS[g].safe) },
  gradedWords: { label: 'Graded wording', terms: ['Graded', 'Slab', 'Slabbed', 'Gem', 'Pristine'] },
  authenticity: { label: 'Autographs', terms: ['Auto', 'Autograph', 'Autographed', 'Signed', 'Signature', 'JSA', 'BAS', 'COA'] },
  lots: { label: 'Lots & sealed', terms: ['Lot', 'Lots', 'Bundle', 'Sealed', 'Unopened', 'Box', 'Boxes', 'Pick', 'Choose', 'Complete'] },
  fakes: { label: 'Fakes & proxies', terms: ['Reprint', 'Reproduction', 'Repro', 'Replica', 'Proxy', 'Counterfeit', 'Orica', 'Custom'] },
  languages: { label: 'Other languages', terms: ['Japanese', 'Japan', 'JPN', 'Chinese', 'Korean', 'German', 'French', 'Italian', 'Spanish', 'Portuguese', 'Thai', 'Indonesian'] },
  damage: { label: 'Damage', terms: ['Damaged', 'DMG', 'Creased', 'Bent'] },
};

// The packs a structured search does NOT need, because a filter already does the job exactly.
// Kept in the table so the testbed can demonstrate the redundancy rather than assert it.
export const REDUNDANT_IN_STRUCTURED = {
  graders: 'Graded:{No} — 99.8% filled',
  gradedWords: 'Graded:{No} — 99.8% filled',
  lots: 'category_ids=183454 — lots and sealed are sibling categories',
  damage: 'Card Condition — 97.8% filled',
  languages: 'Language aspect, but only 70% filled — the regex fallback is still the better instrument',
};

// ---------------------------------------------------------------------------
// Grade groups + ladders (the one Card Ladder trick worth porting verbatim)
// ---------------------------------------------------------------------------
// `(PSA,PSA8) (PSA8,8)` decodes as (PSA OR PSA8) AND (PSA8 OR 8) — it matches "PSA 8" written
// either as two tokens or one, without matching a bare "PSA 10". Genuinely neat, and the only
// keyword construction here that beats an aspect when the aspect is missing.
export function gradeGroups(company, grade) {
  const c = String(company || '').trim().toUpperCase();
  const g = String(grade == null ? '' : grade).trim();
  if (!c || !g) return [];
  return [`(${c},${c}${g})`, `(${c}${g},${g})`];
}

// Every grade BELOW this one, as exclusions, stepping by the company's own scale. Generated rather
// than listed so a half-step company gets half steps. Superseded by Grade:{n} whenever that aspect
// is available — this is the fallback, not the primary.
export function gradeExclusionLadder(company, grade, { min = 1 } = {}) {
  const c = String(company || '').trim().toUpperCase();
  const g = parseFloat(grade);
  if (!c || !isFinite(g)) return [];
  const step = GRADE_STEP[c] || 0.5;
  const out = [];
  for (let v = Math.round((g - step) * 10) / 10; v >= min; v = Math.round((v - step) * 10) / 10) {
    out.push(`-(${c} ${v})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
// `coreFields` is a budget on IDENTITY FIELDS, not words: "Charizard ex" is one field. A mode that
// permits exclusions must cap the core, because that is the trade the measurement above describes.
export const MODES = {
  recall: { label: 'Recall (current)', coreFields: Infinity, excludes: false, structured: false },
  structured: { label: 'Structured', coreFields: 2, excludes: false, structured: true },
  hybrid: { label: 'Hybrid', coreFields: 2, excludes: 'safe', structured: true },
  precision: { label: 'Precision (Card Ladder)', coreFields: 2, excludes: 'safe', structured: false },
};

// Which identity field is given up first when a mode caps the core. Highest priority survives.
// The order is the measurement: the game word cost 85 -> 38 and the set name 38 -> 6, so they go
// first; name and number are the card's identity and go last. The language word outranks the set
// because a JP card searched without it returns the English market (and the Language aspect is only
// 70% filled, so nothing downstream can recover that).
const FIELD_PRIORITY = { name: 100, number: 90, langWord: 70, setCode: 60, setName: 40, gameWord: 30, setYear: 20 };

const LANG_WORD = { ja: 'Japanese', jp: 'Japanese', 'zh-cn': 'Chinese', 'zh-tw': 'Chinese', cn: 'Chinese', ko: 'Korean', en: '' };

// ---------------------------------------------------------------------------
// buildEbayQuery
// ---------------------------------------------------------------------------
// identity: { game, name, number, setName, setCode, setYear, lang, finish, condition,
//             graded, company, grade }
// Returns a PLAN, never a bare string — the caller needs to show what was dropped and why.
export function buildEbayQuery(identity = {}, opts = {}) {
  const mode = MODES[opts.mode] ? opts.mode : 'recall';
  const M = MODES[mode];
  const warnings = [];
  const game = String(identity.game || 'pokemon').toLowerCase();
  const lang = String(identity.lang || 'en').toLowerCase();
  const graded = !!(identity.graded || identity.company);

  // --- the include core -----------------------------------------------------
  const setName = String(identity.setName || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const fields = {
    gameWord: game === 'pokemon' ? 'Pokemon' : (GAME_ASPECT[game] || '').replace(/[:,].*$/, '').trim(),
    name: String(identity.name || '').trim(),
    number: String(identity.number || '').trim(),
    setName,
    setCode: String(identity.setCode || '').trim(),
    setYear: identity.setYear ? String(identity.setYear).trim() : '',
    langWord: LANG_WORD[lang] || '',
  };
  // A set code that merely repeats the set name costs a literal token and buys nothing.
  if (fields.setCode && fields.setCode.toLowerCase() === fields.setName.toLowerCase()) fields.setCode = '';
  // Magic titles rarely carry a collector number and different printings reuse the name, so
  // demanding it over-filters the cluster to nothing. Long-standing, and the reason
  // compsNumberMatch exists — restated here so the query and the filter agree in one place.
  const numberUsable = game !== 'mtg' && !!fields.number;
  if (!numberUsable) fields.number = '';

  const present = Object.keys(fields).filter((k) => fields[k]);
  const dropped = [];
  let keep = present;
  if (present.length > M.coreFields) {
    const ranked = present.slice().sort((a, b) => (FIELD_PRIORITY[b] || 0) - (FIELD_PRIORITY[a] || 0));
    keep = ranked.slice(0, M.coreFields);
    for (const k of ranked.slice(M.coreFields)) dropped.push({ field: k, value: fields[k] });
  }
  // In a structured search the game word is replaced by the Game aspect, which is 98.8% filled and
  // does not cost a literal token — strictly better than the word that halved the result set. The
  // budget may already have dropped it above; either way the honest report is "replaced", not
  // "lost", because the search does still constrain the game.
  if (M.structured) {
    if (keep.includes('gameWord')) {
      keep = keep.filter((k) => k !== 'gameWord');
      dropped.push({ field: 'gameWord', value: fields.gameWord, replacedBy: 'Game aspect' });
    } else {
      const already = dropped.find((d) => d.field === 'gameWord');
      if (already) already.replacedBy = 'Game aspect';
    }
  }
  const coreOrder = ['gameWord', 'name', 'number', 'setName', 'setCode', 'setYear', 'langWord'];
  const core = coreOrder.filter((k) => keep.includes(k)).map((k) => fields[k]);

  if (dropped.length && M.excludes) {
    warnings.push(`Exclusions force literal matching, so the core is capped at ${M.coreFields} fields — dropped ${dropped.map((d) => d.field).join(', ')}. Measured: keeping them took a real card 38 → 6 results.`);
  }

  // --- exclusions -----------------------------------------------------------
  const excludes = [];
  if (M.excludes) {
    const packs = opts.packs || { graders: true, gradedWords: true, authenticity: true, fakes: true };
    // A slab's own grader is the one thing its search must KEEP. Excluding every grading company
    // while also requiring "(PSA,PSA8)" is self-cancelling — it asks for a PSA slab and forbids the
    // word PSA in the same query, and returns nothing. So for a graded card the rival-grader pack
    // means "every grader EXCEPT this one", and the graded-wording pack is skipped outright.
    const ownCompany = graded && identity.company ? String(identity.company).trim().toUpperCase() : null;
    const OWN_ALIASES = { BGS: ['BECKETT'], BVG: ['BECKETT'], BCCG: ['BECKETT'] };
    const ownWords = ownCompany ? new Set([ownCompany, ...(OWN_ALIASES[ownCompany] || [])]) : new Set();
    for (const [key, on] of Object.entries(packs)) {
      if (!on || !PACKS[key]) continue;
      if (key === 'languages' && lang !== 'en') continue;   // never exclude the language you want
      if (key === 'gradedWords' && graded) continue;        // it IS graded — that is the target
      for (const term of PACKS[key].terms) {
        if (key === 'graders' && ownWords.has(term.toUpperCase())) continue;
        const why = isUnsafeExclusion(term);
        if (why && !opts.allowUnsafe) { warnings.push(`skipped -${term}: ${why}`); continue; }
        excludes.push({ term, pack: key, unsafe: !!why });
      }
    }
    // A graded card also fences off the grades below it, when no Grade aspect is doing that job.
    if (graded && identity.company && identity.grade != null && !M.structured) {
      for (const t of gradeExclusionLadder(identity.company, identity.grade)) excludes.push({ term: t.slice(1), pack: 'gradeBelow', raw: t });
    }
  }

  // --- the keyword string ---------------------------------------------------
  const groups = (M.excludes && graded && identity.company && identity.grade != null && !M.structured)
    ? gradeGroups(identity.company, identity.grade) : [];
  const nkw = [...core, ...groups, ...excludes.map((e) => e.raw || ('-' + e.term))].join(' ').replace(/\s+/g, ' ').trim();

  // --- structured filters ---------------------------------------------------
  const aspects = {};
  let categoryIds = null;
  const filterParts = ['itemLocationCountry:AU'];
  if (M.structured) {
    categoryIds = String(opts.category || CATEGORY.ccgSingles);
    if (aspectIsTrusted('Game') && GAME_ASPECT[game]) aspects.Game = [GAME_ASPECT[game]];
    aspects.Graded = [graded ? 'Yes' : 'No'];
    if (graded) {
      if (identity.company && PROFESSIONAL_GRADER[String(identity.company).toUpperCase()] && aspectIsTrusted('Professional Grader', { graded })) {
        aspects['Professional Grader'] = [PROFESSIONAL_GRADER[String(identity.company).toUpperCase()]];
      }
      if (identity.grade != null && aspectIsTrusted('Grade', { graded })) aspects.Grade = [String(identity.grade)];
    } else if (identity.condition && aspectIsTrusted('Card Condition')) {
      const cc = cardConditionValue(identity.condition);
      if (cc) aspects['Card Condition'] = [cc];
    }
    filterParts.push(`conditionIds:{${graded ? COND_ID.graded : COND_ID.raw}}`);
  }
  if (opts.fixedPriceOnly !== false) filterParts.unshift('buyingOptions:{FIXED_PRICE}');

  const aspectFilter = Object.keys(aspects).length
    ? `categoryId:${categoryIds},` + Object.entries(aspects).map(([k, v]) => `${k}:{${v.join('|')}}`).join(',')
    : null;

  return {
    mode,
    // `values` is the text each kept field contributed. The core is a joined string by the time a
    // caller sees it, and the testbed's ablation needs to remove one field's WORDS from that string
    // rather than rebuild the query without the field — rebuilding frees a slot in the core budget
    // and lets a dropped field back in, which silently measures a swap as a removal.
    core: { fields: keep, text: core.join(' '), values: Object.fromEntries(keep.map((k) => [k, fields[k]])), dropped },
    excludes,
    nkw,
    nkwLength: nkw.length,
    browse: { q: nkw, category_ids: categoryIds, filter: filterParts.join(','), aspect_filter: aspectFilter },
    aspects,
    warnings,
    // The other half of the contract. singlesFilter hard-rejects any title its number regex misses,
    // so a mode that dropped the number from the core MUST also stop demanding it downstream —
    // emitting both halves from one function is what stops them disagreeing.
    filterHints: {
      numberMatch: keep.includes('number') ? fields.number : null,
      lang,
      finish: identity.finish || null,
      graded,
      company: identity.company || null,
      grade: identity.grade != null ? identity.grade : null,
      condIds: M.structured ? [String(graded ? COND_ID.graded : COND_ID.raw)] : null,
    },
  };
}

// A condition string from anywhere in this suite -> the exact-case eBay aspect value. Deliberately
// tolerant on input (we already have four internal condition vocabularies) and exact on output.
export function cardConditionValue(condition) {
  const t = String(condition == null ? '' : condition).trim().toLowerCase();
  if (!t) return null;
  if (/near\s*mint|^m\/?nm$|^nm/.test(t) || /^mint$|^m$/.test(t)) return CARD_CONDITION[0];
  if (/lightly\s*played|excellent|^lp$/.test(t)) return CARD_CONDITION[1];
  if (/moderately\s*played|very\s*good|^mp$/.test(t)) return CARD_CONDITION[2];
  if (/heavily\s*played|^hp$|poor|damaged|^dmg$/.test(t)) return CARD_CONDITION[3];
  return null;
}
