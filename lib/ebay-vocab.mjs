// lib/ebay-vocab.mjs — the eBay category-183454 vocabulary, in ONE place.
//
// eBay's card aspects are used from both ends of this suite and they have to agree:
// lib/channels/ebay-map.mjs SPELLS them when publishing a listing, and lib/ebay-query.mjs SPELLS
// THEM AGAIN when searching for comps. If those two ever drift we publish a card as
// Graded/PSA/8 and then go looking for it as something else — and neither side errors, because a
// wrong aspect value is not rejected by eBay. It is silently ignored (see below). So this is a
// single implementation rather than a mirror with a parity test (GR9).
//
// WHY A WRONG VALUE IS INVISIBLE, on both paths:
//   publishing — `Game` is the ONE required aspect on 183454 and it is FREE_TEXT, so a near-miss
//                does not fail the publish, it just earns no facet. Two of the game strings below
//                shipped wrong for months for exactly that reason.
//   searching  — an aspect_filter value that is not an exact case-sensitive member is dropped, and
//                the search returns the UNFILTERED set. Measured: `Card Condition:{Near mint or
//                better}` (lowercase m) returned 86 — the total with no filter at all — which is
//                indistinguishable from a filter that matched everything.
// Both failure modes are silent, which is the whole argument for one table.
//
// Browser-safe: no node: imports, no fs. lib/channels/ebay-map.mjs reads a JSON override on top of
// these defaults; that override still wins there, and this module holds only the baked defaults.

// The CCG family on eBay AU. 183454 is where singles live; the siblings matter because they are
// what a category filter STRUCTURALLY excludes — a lot, a sealed pack and a deck are not "a single
// that mentions the word lot", they are different categories. Measured: adding category_ids=183454
// took a Charizard search 93 -> 86 while removing every lot/sealed/deck result.
export const CATEGORY = {
  ccgParent: '2536',
  ccgSingles: '183454',       // CCG Individual Cards  <- singles comps live here
  ccgLots: '183455',
  ccgSealedPacks: '183456',
  ccgSealedDecks: '183457',
  ccgPlayerDecks: '183458',
  ccgSets: '183459',
};

// Top-level item condition. eBay relabels these two inside the card categories: 2750 shows as
// "Graded" and 4000 as "Ungraded". Measured on one card: 42 ungraded / 43 graded out of 86, a
// clean split that lib/comps-singles.mjs isGraded() currently has to guess with a title regex.
export const COND_ID = { raw: 4000, graded: 2750 };

// The `Card Condition` aspect. EXACTLY four values on 183454 and the case is load-bearing.
// Ordered best-to-worst so a caller can say "this grade or better" by slicing.
export const CARD_CONDITION = [
  'Near Mint or Better',
  'Lightly Played (Excellent)',
  'Moderately Played (Very Good)',
  'Heavily Played (Poor)',
];

// `Professional Grader`, keyed by the company code we store on an inventory row. Values verified
// against the live aspect distribution for AU Pokémon singles (2026-08-24) — the count beside each
// is that day's AU listing count, which is the honest picture of this market and is NOT the US one:
// CGA (2252), TCG (1072) and ARK (856) all outrank BGS (966 combined w/ variants), and all three
// are absent from the US-centric grader lists that circulate.
export const PROFESSIONAL_GRADER = {
  PSA: 'Professional Sports Authenticator (PSA)',        // 28883
  CGC: 'Certified Guaranty Company (CGC)',               //  9094
  CGA: 'Card Grading Australia (CGA)',                   //  2252  AU
  TCG: 'Trading Card Grading (TCG)',                     //  1072  AU
  BGS: 'Beckett Grading Services (BGS)',                 //   966
  ARK: 'ARK Grading (ARK)',                              //   856  AU
  TAG: 'Technical Authentication & Grading (TAG)',       //   546
  PCG: 'Premier Card Grading (PCG)',                     //   329  AU
  SGC: 'Sportscard Guaranty Corporation (SGC)',          //    57
};

// game key -> the `Game` aspect string. Every one checked against the live 167-member enum on
// 2026-08-14; the two marked FIXED were near-misses that had been shipping since their game landed.
// eBay has NO member for Star Wars: Unlimited (its Star Wars entries are all older games), so that
// one is verbatim and earns no facet — the honest answer until eBay adds a member.
export const GAME_ASPECT = {
  pokemon: 'Pokémon TCG',
  lorcana: 'Disney Lorcana TCG',                  // FIXED: was 'Disney Lorcana'
  mtg: 'Magic: The Gathering',
  swu: 'Star Wars: Unlimited',
  riftbound: 'Riftbound: League of Legends TCG',  // FIXED: was 'Riftbound'
};

// The `games` block lib/channels/ebay-map.mjs spreads into its DEFAULTS. Built from GAME_ASPECT so
// the two can't disagree; every card game we list sits in the same singles category.
export const GAMES = Object.fromEntries(
  Object.entries(GAME_ASPECT).map(([k, gameAspect]) => [k, { categoryId: CATEGORY.ccgSingles, gameAspect }]),
);

// ---------------------------------------------------------------------------
// How much an aspect can be TRUSTED as a filter
// ---------------------------------------------------------------------------
// An aspect filter is only as good as the share of sellers who filled the field in. Filter on a
// sparse one and you do not narrow the market, you delete most of it — the listings that simply
// left the field blank vanish along with the genuine misses. So each aspect carries its measured
// fill rate and this decides whether it may gate a search.
//
// Measured 2026-08-24 over 1,569,936 AU Pokémon singles in 183454, as
// (sum(values) - Not specified) / sum(values).
//
// `basis:'graded'` is the important subtlety. Grade and Professional Grader read as ~2.4% filled
// against ALL listings, which looks like a reason never to touch them — but they only APPLY to
// graded listings, and within that population they are 99.4% and 94.2%. Conditioning on the
// sub-population is the difference between "useless" and "the best signal available", and the raw
// number is the misleading one.
export const ASPECT_FILL = {
  Graded: { fill: 99.8, basis: 'all' },
  Game: { fill: 98.8, basis: 'all' },
  'Card Condition': { fill: 97.8, basis: 'all' },
  Grade: { fill: 99.4, basis: 'graded' },
  'Professional Grader': { fill: 94.2, basis: 'graded' },
  'Card Name': { fill: 79.9, basis: 'all' },
  Rarity: { fill: 77.2, basis: 'all' },
  Language: { fill: 70.0, basis: 'all' },
  Set: { fill: 52.3, basis: 'all' },
  Autographed: { fill: 50.3, basis: 'all' },
  Finish: { fill: 45.8, basis: 'all' },
  Speciality: { fill: 17.2, basis: 'all' },
};

// Above TRUST_FILL an aspect is a reliable gate; below it, filtering costs more real listings than
// it removes wrong ones, and the title regexes in lib/comps-singles.mjs stay the better instrument.
// 85 sits in the natural gap in the measured data (97.8 -> 79.9) rather than being a round number
// picked in advance.
export const TRUST_FILL = 85;

// May this aspect gate a search? `graded` says whether the card in hand is a slab, because that is
// what decides which population the fill rate was measured against.
export function aspectIsTrusted(name, { graded = false } = {}) {
  const a = ASPECT_FILL[name];
  if (!a) return false;
  if (a.basis === 'graded' && !graded) return false;   // undefined for a raw card, not merely sparse
  return a.fill >= TRUST_FILL;
}

// The aspects worth gating on for a given card, best-filled first. This is the whole "structured
// mode" recipe in one call: everything else falls through to the title filters.
export function trustedAspects({ graded = false } = {}) {
  return Object.keys(ASPECT_FILL)
    .filter((n) => aspectIsTrusted(n, { graded }))
    .sort((a, b) => ASPECT_FILL[b].fill - ASPECT_FILL[a].fill);
}
