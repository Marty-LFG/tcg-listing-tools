// lib/channels/ebay-map.mjs — the ONE mapping layer: inventory item (+batch) →
// canonical eBay listing object. CSV (Phase 1) and the Sell Inventory API (Phase 2)
// serialize THIS shape — they must never re-derive titles/aspects themselves.
//
// Titles + descriptions come from lib/listing-copy.mjs (Golden Rules 6/8/9 single
// source). Category/aspect/condition values were resolved LIVE against the eBay AU
// Taxonomy API on 2026-07-02 (tree 15 v125) and are pinned in data/ebay-categories.json
// (gitignored live cache) with the same values baked here as defaults — a fresh
// clone works without the cache file (Golden Rule 7).
//
// LIVE FINDING (multi-variation): in category 183454 only "Card Condition" and
// "Customised" are variation-enabled aspects, so a card-per-variation listing is
// NOT properly supported on EBAY_AU. Per-card is the primary shape; the variation
// CSV uses a custom 'Card' specific and stays EXPERIMENTAL until a real 3-row
// sample upload passes on the owner's account.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTitle, buildDescription, rowToFields, variationTitle, variationAttrs, mtgColourName, mtgTreatmentOf, mtgPromoNote } from '../listing-copy.mjs';
import { resolveRiftboundCard } from '../riftbound-data.mjs';
import { resolveMtgCard } from '../mtg-cards-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CATEGORIES_PATH = path.join(ROOT, 'data', 'ebay-categories.json');

// The DB stores language as a 2-letter code (EN/JP/…, see lib/normalize + lib/enumerate); eBay AU
// category 183454's Language aspect is a recommended enum of FULL names, so 'EN' won't match the
// buyer-facing "English" filter. Map code → name here (the inverse of extras.js langCode). An
// already-full value (or an unknown code) falls through verbatim rather than being dropped.
export const LANG_NAME = {
  EN: 'English', JP: 'Japanese', JA: 'Japanese', ZH: 'Chinese', CN: 'Chinese', KO: 'Korean',
  FR: 'French', DE: 'German', IT: 'Italian', ES: 'Spanish', PT: 'Portuguese', RU: 'Russian', TH: 'Thai', ID: 'Indonesian',
  // DISPLAY ONLY — Dwarvish is a real Scryfall print language (HOC #93-97, the set's chase cards at
  // up to US$642) but it is not an eBay Language member, so ebayLanguageAspect leaves the aspect
  // unset while the description row and the rail still read "Dwarvish".
  DW: 'Dwarvish',
};
export const ebayLanguageName = (lang) => LANG_NAME[String(lang || '').toUpperCase()] || lang || 'English';

// The Language ASPECT is a narrower thing than the display name. eBay silently DROPS an unmatched
// FREE_TEXT value but REJECTS an unmatched SELECTION_ONLY one — a failed publish — so anything that
// is not a known member is left UNSET rather than shipped on a guess (GR4). Full names already
// coming from the UI ('Japanese', 'French') are members and pass; a blank still means English.
const LANG_ASPECT_MEMBERS = new Set(['English', 'Japanese', 'Chinese', 'Korean', 'French', 'German', 'Italian', 'Spanish', 'Portuguese', 'Russian', 'Thai', 'Indonesian']);
export function ebayLanguageAspect(lang) {
  const name = ebayLanguageName(lang);
  return LANG_ASPECT_MEMBERS.has(name) ? name : null;
}

// eBay's own protocol floor for a fixed-price listing: 1.00 in the marketplace currency. This is not
// a business judgement like runner-core's MIN_ASK_AUD (which the owner can approve past, row by row)
// — eBay rejects it outright with 25016, at BOTH publish and the get_listing_fees preflight, so no
// amount of approving gets a 99c listing live. It belongs in validateListing, which runs before the
// first API call, rather than in refuseRow where everything is releasable by design.
export const EBAY_MIN_PRICE_CENTS = 100;

// ---------------------------------------------------------------------------
// Pokémon → eBay AU 183454 aspect derivation. Every enum below was read LIVE from
// getItemAspectsForCategory (tree 15, EBAY_AU, 2026-07-26). eBay silently DROPS a FREE_TEXT value that
// misses its enum (it lists, it just earns no buyer-facing facet) and REJECTS a SELECTION_ONLY one, so
// anything we cannot match exactly is passed verbatim or left unset — never guessed (Golden Rule 4).
// ---------------------------------------------------------------------------

// inventory_items.store_categories is a JSON array in a TEXT column; a publish override arrives as a
// real array; a hand-edited value may be a bare string. Tolerate all three. Deliberately does NOT
// split on commas — an eBay store department may legitimately be named "Singles, Graded".
export function storeCategoryList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (s.startsWith('[')) { try { const j = JSON.parse(s); return Array.isArray(j) ? storeCategoryList(j) : []; } catch { return []; } }
  return [s];
}

// pokemontcg.io `subtypes` arrives as an array from the API and as a joined string from the DB row.
export function pkmSubtypes(item) {
  const s = item && item.subtypes;
  if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

// "Finish" enum is EXACTLY: Foil | Holo | Regular | Reverse Holo. Our internal vocabulary
// ('Holofoil'/'Reverse Holofoil'/'Normal'/'Base') matches NONE of them, which is one reason the first
// live listing shipped with no Finish at all.
export function ebayFinish(finish) {
  const f = String(finish || '').trim();
  if (!f) return null;
  // Order matters: "Non-holo" contains "holo", so it has to be tested BEFORE the holo branch or a
  // plain card lists as Holo. The uploader's Finish dropdown offers exactly that value.
  if (/reverse/i.test(f)) return 'Reverse Holo';
  if (/^(normal|base|regular|standard)$/i.test(f) || /non[-\s]?(holo|foil)/i.test(f)) return 'Regular';
  if (/holo/i.test(f)) return 'Holo';
  if (/foil/i.test(f)) return 'Foil';
  return null;                                   // unknown → unset, never a near-miss
}

// pokemontcg.io `types[]` → "Attribute/MTG:Colour". NOTE the AU BRITISH spelling: the member is
// 'Colourless', not Pokémon's 'Colorless'. eBay's separate 'Dark' member is NOT the Pokémon type
// (that is 'Darkness'). SINGLE cardinality, so the first type wins on dual-type cards.
export const PKM_TYPE_ATTRIBUTE = {
  Colorless: 'Colourless', Darkness: 'Darkness', Dragon: 'Dragon', Fairy: 'Fairy', Fighting: 'Fighting',
  Fire: 'Fire', Grass: 'Grass', Lightning: 'Lightning', Metal: 'Metal', Psychic: 'Psychic', Water: 'Water',
};
export function ebayAttribute(types) {
  const t = Array.isArray(types) ? types : String(types || '').split(',').map((x) => x.trim());
  for (const x of t) if (PKM_TYPE_ATTRIBUTE[x]) return PKM_TYPE_ATTRIBUTE[x];
  return null;
}

// supertype (+subtypes) → "Card Type". Only these 11 members carry Game='Pokémon TCG'. Plain 'Energy'
// is NOT one, so sending the raw supertype means every energy card's Card Type is dropped by eBay.
export function ebayCardType(supertype, subs) {
  const st = String(supertype || '').trim();
  const has = (re) => (subs || []).some((s) => re.test(String(s)));
  if (/^pok[eé]mon$/i.test(st)) return 'Pokémon';
  if (/^energy$/i.test(st)) return has(/^basic$/i) ? 'Energy-Basic' : 'Energy-Special';
  if (/^trainer$/i.test(st)) {
    if (has(/^pok[eé]mon tool/i)) return 'Pokémon Tool';
    if (has(/^item$/i)) return 'Trainer-Item';
    if (has(/^supporter$/i)) return 'Trainer-Supporter';
    if (has(/^stadium$/i)) return 'Trainer-Stadium';
    if (has(/^technical machine$/i)) return 'Technical Machine';
    if (has(/^rocket's secret machine$/i)) return "Rocket's Secret Machine";
    return 'Trainer';
  }
  return null;
}

// "Stage" — under Card Type='Pokémon' eBay allows ONLY Basic | Stage 1 | Stage 2. The other six
// members (Rookie/Champion/Ultimate/In-Training/Mega/Hybrid) are Digimon and are constrained away.
export function ebayStage(subs) {
  for (const s of subs || []) {
    if (/^stage\s*2$/i.test(s)) return 'Stage 2';
    if (/^stage\s*1$/i.test(s)) return 'Stage 1';
    if (/^basic$/i.test(s)) return 'Basic';
  }
  return null;
}

// "Speciality" (legal only alongside Card Type='Pokémon'). VSTAR / Radiant / Tera / ACE SPEC / V-UNION
// have NO enum member — left unset rather than mapped to a near-miss (GR4).
export const PKM_SPECIALITY = {
  ex: 'EX', gx: 'GX', v: 'V', vmax: 'VMAX', break: 'BREAK', mega: 'MEGA', legend: 'LEGEND',
  'level-up': 'Level Up', 'level up': 'Level Up', restored: 'Restored', sp: 'SP',
  'tag team': 'TAG TEAM', prime: 'PRIME',
};
export function ebaySpeciality(subs) {
  for (const s of subs || []) { const hit = PKM_SPECIALITY[String(s).trim().toLowerCase()]; if (hit) return hit; }
  return null;
}

// "Manufacturer" — the members that matter: The Pokémon Company | Nintendo | Wizards of the Coast.
// 'TPCi' is NOT one (the hand-made listing used it and earned no facet). WotC published the ENGLISH
// game through Skyridge (2003-05); EX Ruby & Sapphire (2003-06 EN) is the first Nintendo/TPC set.
// ---------------------------------------------------------------------------
// Magic derivations. Scryfall models a card as a type LINE, a colour ARRAY and a frame/promo vocab;
// eBay wants one word per aspect. Everything below is pure and exported for the unit suite.
// ---------------------------------------------------------------------------

// The "Set" aspect wants the set's NAME. The builder stores "The Hobbit (HOB)" because the code is
// what disambiguates in a title; the aspect is a filter facet, and "(HOB)" would miss the enum.
export function stripSetCodeSuffix(s) {
  const raw = String(s == null ? '' : s).trim();
  const cut = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return cut || raw;                              // "(HOB)" alone stays as-is rather than becoming ''
}

// Types in eBay's rough order of what a buyer filters on. An "Artifact Creature" is a Creature to
// anyone shopping, so priority beats word order.
// The Card Type members that carry Game='Magic: The Gathering', read LIVE 2026-08-10 (30 of 74).
// eBay keeps the SUPERTYPE-BEARING forms as members of their own — 'Legendary Creature' is not a
// synonym for 'Creature', it is a separate facet — so the specific one is preferred when the card's
// own words are a member, and the priority reduction below is the fallback.
const MTG_CARD_TYPE_MEMBERS = new Map([
  'Artifact', 'Artifact Creature', 'Basic Land', 'Creature', 'Emblem', 'Enchantment',
  'Enchantment Creature', 'Equipment', 'Host Creature', 'Instant', 'Instant/Sorcery', 'Land',
  'Legendary Artifact', 'Legendary Creature', 'Legendary Enchantment Creature', 'Legendary Land',
  'Legendary Planeswalker', 'Planeswalker', 'Sorcery', 'Token Artifact', 'Token Artifact Creature',
  'Token Card', 'Token Creature', 'Tribal', 'Tribal Enchantment',
].map((v) => [v.toLowerCase(), v]));
const MTG_TYPE_PRIORITY = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Land', 'Kindred', 'Tribal', 'Conspiracy', 'Phenomenon', 'Plane', 'Scheme', 'Vanguard', 'Dungeon'];
const MTG_SUPERTYPE = /^(legendary|basic|snow|world|ongoing|elite|host|token)$/i;
export function mtgCardTypeAspect(typeLine) {
  // Front face only: a double-faced card's type line is "A // B" (39 of HOB's 321 prints), and the
  // buyer filters on the face they are looking at.
  let t = String(typeLine == null ? '' : typeLine).split('//')[0];
  // Scryfall separates types from SUBtypes with an em-dash: "Legendary Creature — Dragon".
  t = t.split('—')[0].split('–')[0].split(' - ')[0].trim().replace(/\s+/g, ' ');
  if (!t) return null;
  // The card's own words, if eBay has them. 'Legendary Creature — Dragon' → 'Legendary Creature'.
  const exact = MTG_CARD_TYPE_MEMBERS.get(t.toLowerCase());
  if (exact) return exact;
  // Otherwise drop the supertypes and pick by priority, not word order: 'Snow Creature' is not a
  // member, but an "Artifact Creature" is a Creature to anyone shopping.
  const words = t.split(' ').filter((w) => w && !MTG_SUPERTYPE.test(w));
  for (const want of MTG_TYPE_PRIORITY) {
    if (words.some((w) => w.toLowerCase() === want.toLowerCase())) return want;
  }
  return words[0] || null;                        // unknown → the card's own word, verbatim (GR4)
}

// Attribute/MTG:Colour, resolved LIVE 2026-08-10 (scripts/check-ebay-aspects.mjs): FREE_TEXT and
// SINGLE, so an unmatched value is silently dropped rather than rejected — the aspect is safe to
// send. ⚠ The member is 'Multicoloured', NOT the 'Multicolour' our display vocabulary uses. That
// short spelling is right for the description row and is mirrored in the builder; only the ASPECT
// takes the long one, which is why this is a MAP and not the same Set as the display words.
export const MTG_COLOUR_ASPECT_VERIFIED = true;
const MTG_COLOUR_ASPECT = new Map([
  ['white', 'White'], ['blue', 'Blue'], ['black', 'Black'], ['red', 'Red'], ['green', 'Green'],
  ['colourless', 'Colourless'], ['colorless', 'Colourless'],
  ['multicolour', 'Multicoloured'], ['multicolor', 'Multicoloured'], ['multicoloured', 'Multicoloured'],
]);
export function mtgColourAspect(colour) {
  if (!MTG_COLOUR_ASPECT_VERIFIED) return null;
  return MTG_COLOUR_ASPECT.get(String(colour == null ? '' : colour).trim().toLowerCase()) || null;
}

// "Features" (MULTI). Deliberately NOT driven by promo_types: `universesbeyond` is on all 321 HOB
// and all 158 HOC prints, so it marks the BRAND, not a promo. Scryfall's own `promo` flag is the
// conservative signal — in HOB exactly one print (#321, the bundle card) carries it, and the
// headliner #249 does not.
//
// Treatment and the special-print note ARE Features members — verified live 2026-08-10, the enum
// carries Borderless / Extended Art / Full Art / Showcase / Box Topper / Promo. That makes this a
// real buyer-facing facet on exactly the prints carrying the premium (HOB #239 US$83 against the
// base printing's US$38), so it is worth more than the row in the description table alone.
const MTG_FEATURE_MEMBERS = new Set(['Borderless', 'Extended Art', 'Full Art', 'Showcase', 'Box Topper']);
export function mtgFeatures(card, treat, promo) {
  const out = [];
  for (const v of [treat, promo]) {
    const s = String(v == null ? '' : v).trim();
    if (MTG_FEATURE_MEMBERS.has(s)) out.push(s);   // 'Normal'/'Headliner' are not members — dropped
  }
  if (card && card.full_art === true) out.push('Full Art');
  if (card && card.promo === true) out.push('Promo');
  return [...new Set(out)];
}

export function ebayManufacturer(game, language, releaseDate) {
  // Every Magic set has been published by Wizards of the Coast, and it is a live enum member.
  if (game === 'mtg') return 'Wizards of the Coast';
  if (game !== 'pokemon') return null;
  const lang = String(language || 'EN').toUpperCase();
  const d = String(releaseDate || '').replace(/-/g, '/');
  if ((lang === 'EN' || lang === 'ENGLISH') && d && d < '2003/06') return 'Wizards of the Coast';
  return 'The Pokémon Company';
}

// "Year Manufactured" is SELECTION_ONLY (int enum, live window 1990…2026) — an out-of-range value is
// REJECTED, not ignored. Clamped here rather than shipped. Do not remove this guard.
export function ebayYearManufactured(releaseDate) {
  const y = parseInt(String(releaseDate || '').slice(0, 4), 10);
  if (!(y >= 1990) || y > new Date().getFullYear()) return null;
  return String(y);
}

// "Set" is FREE_TEXT so an unmatched name still lists — but only an EXACT enum match earns the
// buyer-facing Set filter. 84 of pokemontcg.io's EN set names already match; these 11 differ only in
// eBay's series prefix or casing. The sets with no enum entry (151, Paradox Rift onward, Surging
// Sparks, Stellar Crown, Black Bolt, White Flare) fall through VERBATIM — never invent a prefix (GR4).
export const PKM_SET_EBAY = {
  'HeartGold & SoulSilver': 'Heartgold & Soulsilver',
  BREAKthrough: 'Breakthrough',
  BREAKpoint: 'Breakpoint',
  "Champion's Path": 'Champions Path',
  'Team Up': 'Sun & Moon - Team Up',
  'Battle Styles': 'Sword & Shield - Battle Styles',
  'Chilling Reign': 'Sword & Shield - Chilling Reign',
  'Lost Origin': 'Sword & Shield - Lost Origin',
  'Silver Tempest': 'Sword & Shield - Silver Tempest',
  'Paldea Evolved': 'Scarlet & Violet - Paldea Evolved',
  'Obsidian Flames': 'Scarlet & Violet - Obsidian Flames',
};
export const ebaySetName = (s) => PKM_SET_EBAY[String(s || '').trim()] || s;

// "Rarity" is FREE_TEXT with 57 members and ZERO Pokémon constraints — the list predates every modern
// Pokémon rarity (Illustration Rare / Special Illustration Rare / Radiant Rare / Hyper Rare are all
// absent). Those stay VERBATIM. Only these five differ purely in eBay's word order.
export const PKM_RARITY_EBAY = {
  'Rare Holo': 'Holo Rare', 'Rare Holo EX': 'Holo Rare ex', 'Rare Prime': 'Holo Rare Prime',
  'Rare Secret': 'Secret Rare', 'Rare Ultra': 'Ultra Rare',
};
export const ebayRarity = (r) => PKM_RARITY_EBAY[String(r || '').trim()] || r;

// "Features" (MULTI). Only what the card record PROVES (GR4) — Hyper/Rainbow/Shiny/Radiant rarities
// have no Features member and stay unset.
export function ebayFeatures(item) {
  const out = [];
  const ed = String(item.edition || ''), rar = String(item.rarity || ''), setName = String(item.set_name || '');
  if (/1st/i.test(ed)) out.push('1st Edition');
  else if (/unlimited/i.test(ed)) out.push('Unlimited');
  if (/^(special\s+)?illustration rare$/i.test(rar)) out.push('Full Art');
  if (/^promo$/i.test(rar) || /promo/i.test(setName)) out.push('Promo');
  if (/alternate art/i.test(String(item.variant || '')) || /\(alternate art\)/i.test(String(item.name || ''))) out.push('Alternative Art');
  // Riftbound's "Signature" is a PRINTING TREATMENT, not an autograph — deliberately NOT mapped to
  // eBay's Signed/Autographed members. Claiming a signature on a US$2,700 card that carries none is
  // a misrepresentation (GR4: never assert an aspect the data doesn't support). Leave it unset.
  return out;
}

// national-dex # → English species. The Character enum carries BASE SPECIES ('Gardevoir', 'Vulpix'),
// NOT the printed card name ('Radiant Gardevoir', 'Alolan Vulpix') — verified live 2026-07-26. The dex
// number is the only derivation that gets that right without string surgery on the card name, and it
// handles TAG TEAM duos for free (nationalPokedexNumbers is an array; Character is MULTI).
const DEX_PATH = path.join(ROOT, 'data', 'pokemon-dex-en.json');
let _dex = null;
function dexMap() {
  if (_dex) return _dex;
  try { const j = JSON.parse(fs.readFileSync(DEX_PATH, 'utf8')); _dex = j.dex || j || {}; } catch { _dex = {}; }
  return _dex;
}
export function ebayCharacters(item) {
  const nums = Array.isArray(item.pokedex_numbers) ? item.pokedex_numbers
    : Array.isArray(item.pokedex) ? item.pokedex
      : String(item.pokedex || '').split(',').map((x) => x.trim()).filter(Boolean);
  const d = dexMap(), out = [];
  for (const n of nums) { const name = d[String(parseInt(n, 10))]; if (name && !out.includes(name)) out.push(name); }
  return out;
}

// Baked defaults = the 2026-07-02 live resolution (mirror of data/ebay-categories.json).
const DEFAULTS = {
  marketplace: 'EBAY_AU',
  categoryTreeId: '15',
  games: {
    pokemon: { categoryId: '183454', gameAspect: 'Pokémon TCG' },
    lorcana: { categoryId: '183454', gameAspect: 'Disney Lorcana' },
    mtg: { categoryId: '183454', gameAspect: 'Magic: The Gathering' },
    swu: { categoryId: '183454', gameAspect: 'Star Wars: Unlimited' },
    riftbound: { categoryId: '183454', gameAspect: 'Riftbound' },
  },
  requiredAspects: ['Game'],
  conditionIds: { raw: 4000, graded: 2750 },
  cardConditionAspectValues: ['Near Mint or Better', 'Lightly Played (Excellent)', 'Moderately Played (Very Good)', 'Heavily Played (Poor)'],
  professionalGrader: {
    PSA: 'Professional Sports Authenticator (PSA)', BGS: 'Beckett Grading Services (BGS)',
    CGC: 'Certified Guaranty Company (CGC)', SGC: 'Sportscard Guaranty Corporation (SGC)',
    TAG: 'Technical Authentication & Grading (TAG)', ARK: 'ARK Grading (ARK)',
    CGA: 'Card Grading Australia (CGA)', PCG: 'Premier Card Grading (PCG)', TCG: 'Trading Card Grading (TCG)',
  },
};

export function loadEbayCategories() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8')) }; }
  catch { return DEFAULTS; }
}

// Collectr/tool condition string → the eBay AU "Card Condition" aspect enum.
export function cardConditionAspect(condition) {
  const c = (condition || '').toLowerCase();
  if (/damag|\bdmg\b|poor|heav/.test(c)) return 'Heavily Played (Poor)';
  if (/moderat|\bmp\b/.test(c)) return 'Moderately Played (Very Good)';
  if (/light|\blp\b|excellent/.test(c)) return 'Lightly Played (Excellent)';
  return 'Near Mint or Better';    // NM default — matches the under-promising default cond
}

// The row bundle the title/description templates read. Extracted from toEbayListing so the publish
// pipeline can re-render the description with an eBay-hosted image once EPS upload has happened
// (buildItemDescription below) — the description is otherwise frozen before a byte is uploaded.
export function buildRowIn(item, cats) {
  cats = cats || loadEbayCategories();
  const game = item.game;
  const pkm = game === 'pokemon';
  const graded = !!(item.graded || item.grading_company);
  const rowIn = {
    game, name: item.name, number: item.number, set_name: item.set_name, rarity: item.rarity,
    finish: item.finish || item.variant, variant: item.variant,
    language: ebayLanguageName(item.language),      // 'EN' → 'English' so the table reads right
    condition: item.condition,
    edition: item.edition, graded, grading_company: item.grading_company, grade: item.grade,
    grade_label: item.grade_label, cert_number: item.cert_number, subgrades: item.subgrades,
    // Card facts the CARD DETAILS table renders. buildDescription already has a conditional row for
    // every one of these; they were simply never populated for a DB-round-tripped row, which is why
    // the table came out half-empty and image-less on the first live listing.
    //
    // Species/stage/type are POKÉMON facts and are gated: ebayCharacters loads the national dex on
    // first call, and ebayStage matches a bare 'basic' — a supertype word another game's `subtypes`
    // can plausibly carry — so an ungated call both costs a file read per row and invents a Stage.
    poke: pkm ? ((ebayCharacters(item) || [])[0] || '') : '',
    stage: pkm ? (item.stage || ebayStage(pkmSubtypes(item)) || '') : '',
    type: item.energy_type || (pkm ? ebayAttribute(item.types) : '') || '',
    hp: pkm ? (item.hp || '') : '', illustrator: item.illustrator || item.artist || '',
    regMark: pkm ? (item.regulation_mark || '') : '', setSymbol: item.set_code || '',
    releaseYear: String(item.release_year || item.set_release_date || '').slice(0, 4),
    img: item.image_url || item.image || '',        // source CDN art; runPublish upgrades this to EPS
  };
  // Riftbound: type/domain/tags/stats aren't persisted (identity is) — re-resolve them from
  // the baked catalog so the description carries the full card details after the DB round-trip.
  if (game === 'riftbound') {
    const idk = item.identity_key || '';
    const dash = idk.indexOf('-');
    const card = dash > 0 ? resolveRiftboundCard(idk.slice(0, dash), idk.slice(dash + 1)) : null;
    if (card) { rowIn.rb_type = card.type; rowIn.rb_domain = card.domain; rowIn.rb_tags = card.tags; rowIn.rb_e = card.e; rowIn.rb_p = card.p; rowIn.rb_m = card.m; }
  }
  // Magic: same deal. Scryfall's colour/type/treatment/artist/release aren't persisted, so the
  // description table and every derived aspect would be empty after a DB round-trip. An explicit
  // value on the row always wins — card_facts stays the override channel.
  if (game === 'mtg') {
    const card = resolveMtgCard(item.identity_key || '');
    if (card) {
      const colours = card.colors || (card.card_faces && card.card_faces[0] && card.card_faces[0].colors) || [];
      rowIn.colour = item.colour || mtgColourName(colours);
      rowIn.type = item.card_type || card.type_line || '';
      rowIn.treat = item.treatment || mtgTreatmentOf(card);
      rowIn.promo = item.promo_note || mtgPromoNote(card);
      rowIn.illustrator = rowIn.illustrator || card.artist || '';
      rowIn.releaseYear = rowIn.releaseYear || String(card.released_at || '').slice(0, 4);
      rowIn.img = rowIn.img || ((card.image_uris && (card.image_uris.normal || card.image_uris.large)) || '');
      rowIn.mtgCard = card;                        // aspects below read full_art/promo off it
    } else {
      rowIn.colour = item.colour || '';
      rowIn.type = item.card_type || '';
      rowIn.treat = item.treatment || '';
      rowIn.promo = item.promo_note || '';
    }
  }
  return rowIn;
}

// Re-render just the description, with a chosen hero image. Used after the EPS upload so the embedded
// picture is the eBay-hosted one (it outlives the source CDN) and, for a played card, the owner's own
// photo rather than the stock scan.
export function buildItemDescription(item, { imageUrl, artUrl, setLogoUrl, setSymbolUrl, cats } = {}) {
  if (item.desc_override && item.desc_override.trim()) return item.desc_override.trim();
  const graded = !!(item.graded || item.grading_company);
  const f = rowToFields(buildRowIn(item, cats));
  // `artUrl` wins over the hero: the description shows the CARD beside the pitch at ~210px, where a
  // branded composite would render its rails about 12px wide and the card smaller than a thumbnail.
  // The composite is already doing its job in the gallery. `imageUrl` stays the fallback.
  if (artUrl || imageUrl) f.img = artUrl || imageUrl;
  if (setLogoUrl) f.setLogoUrl = setLogoUrl;
  if (setSymbolUrl) f.setSymbolUrl = setSymbolUrl;
  return buildDescription(item.game, f, graded ? { slab: true } : undefined);
}

// One inventory row (an inventory_items record or an in-grid ImportRow) → canonical listing.
export function toEbayListing(item, batch, cats) {
  cats = cats || loadEbayCategories();
  const game = item.game;
  const gcfg = (cats.games && cats.games[game]) || null;
  const graded = !!(item.graded || item.grading_company);
  const rowIn = buildRowIn(item, cats);
  const f = rowToFields(rowIn);
  const title = (item.title_override && item.title_override.trim()) || buildTitle(game, f);
  const descriptionHtml = (item.desc_override && item.desc_override.trim()) || buildDescription(game, f, graded ? { slab: true } : undefined);

  // ---- item specifics (aspects) — eBay AU category 183454. GRADING IS NOT AN ASPECT here (verified
  // live 2026-07-24): Graded/Professional Grader/Grade/Certification Number/Card Condition are
  // CONDITION DESCRIPTORS on the item condition, not aspects, so they live in conditionDescriptors
  // below. Only 'Game' is hard-required. Aspect name ≤40 / value ≤50 chars (Inventory API caps).
  const capName = (s) => { s = s == null ? '' : String(s); return s.length > 40 ? s.slice(0, 40) : s; };
  const capVal = (s) => { s = s == null ? '' : String(s); return s.length > 50 ? s.slice(0, 50) : s; };
  const aspects = {};
  // Character + Features are MULTI-cardinality on 183454 (verified live), so an ARRAY value is legal
  // here and buildInventoryItemPayload passes it through. Every other aspect below is SINGLE.
  const put = (name, val) => {
    if (Array.isArray(val)) {
      const vs = [...new Set(val.filter((v) => v != null && String(v).trim() !== '').map(capVal))];
      if (vs.length) aspects[capName(name)] = vs;
      return;
    }
    if (val != null && String(val).trim() !== '') aspects[capName(name)] = capVal(val);
  };

  const pkm = game === 'pokemon';
  const mtg = game === 'mtg';
  const subs = pkmSubtypes(item);
  // Magic release dates come off the resolved Scryfall record; Pokémon's from pokemontcg.io.
  const relDate = item.set_release_date || (mtg && rowIn.mtgCard ? rowIn.mtgCard.released_at : null) || null;

  if (gcfg) put('Game', gcfg.gameAspect);                         // the ONE required aspect (verified live)
  put('Card Name', item.name);
  // exact enum match earns the Set filter — and Magic's stored name carries the "(HOB)" the title
  // wants but the facet does not.
  put('Set', pkm ? ebaySetName(item.set_name) : mtg ? stripSetCodeSuffix(item.set_name) : item.set_name);
  put('Card Number', item.number != null ? String(item.number) : null);
  put('Rarity', pkm ? ebayRarity(item.rarity) : item.rarity);
  // Card Type / Character / Stage / Speciality / HP are POKÉMON aspects derived from `subtypes`.
  // Ungated, any game whose subtypes happen to contain 'basic'/'item'/'v' picks up a Pokémon facet
  // it has no business carrying — 'Basic' is a Magic SUPERTYPE, so Basic Lands were one import away.
  put('Card Type', pkm ? (ebayCardType(item.supertype || item.card_type, subs) || item.card_type)
    : mtg ? (item.card_type_aspect || mtgCardTypeAspect(rowIn.type)) : item.card_type);
  put('Character', item.character || (pkm ? ebayCharacters(item) : null));
  put('Attribute/MTG:Colour', pkm ? ebayAttribute(item.types) : mtg ? mtgColourAspect(rowIn.colour) : null);
  put('Stage', pkm ? (item.stage || ebayStage(subs)) : null);     // needs Card Type='Pokémon' to be valid
  put('Speciality', pkm ? (item.speciality || ebaySpeciality(subs)) : null);
  put('HP', pkm ? item.hp : null);
  put('Finish', ebayFinish(item.finish || item.variant));
  // MULTI — absorbs the old 1st-Edition line. Magic reads the RESOLVED treatment/promo off rowIn,
  // not the raw card, so a card_facts override reaches the facet too.
  put('Features', mtg ? mtgFeatures(rowIn.mtgCard, rowIn.treat, rowIn.promo) : ebayFeatures(item));
  put('Illustrator', item.illustrator || item.artist || rowIn.illustrator);
  put('Manufacturer', item.manufacturer || ebayManufacturer(game, item.language, relDate));
  put('Card Size', item.card_size || (pkm || mtg ? 'Standard' : null));
  put('Language', ebayLanguageAspect(item.language));             // stored code (EN) → eBay enum name (English)
  put('Year Manufactured', ebayYearManufactured(item.year_manufactured || relDate));
  put('Autographed', item.autographed || 'No');                   // SELECTION_ONLY: Yes | No
  put('Material', pkm || mtg ? 'Card Stock' : null);              // FREE_TEXT enum member; free facet
  if (item.year_manufactured) put('Year Manufactured', String(item.year_manufactured));

  // ---- condition + structured condition descriptors (the eBay-correct home for grading) ----
  // Semantic form: { name, value } where name is eBay's descriptor name. The numeric name/value IDs
  // (27501/27502/27503/40001 and their value IDs) are resolved at publish time from the live
  // Metadata getItemConditionPolicies (lib/ebay-taxonomy.mjs), with a baked fallback — never guessed
  // here (a wrong grade ID is a wrong listing, Golden Rule 4).
  const conditionDescriptors = [];
  let graderName = null, cardCondition = null, gradeStr = null;
  if (graded) {
    graderName = (cats.professionalGrader || {})[String(item.grading_company || '').toUpperCase()] || null;
    conditionDescriptors.push({ name: 'Professional Grader', value: String(item.grading_company || '').toUpperCase() });
    if (item.grade != null) { gradeStr = String(+item.grade).replace(/\.0$/, ''); conditionDescriptors.push({ name: 'Grade', value: gradeStr }); }
    if (item.cert_number) conditionDescriptors.push({ name: 'Certification Number', value: String(item.cert_number) });
  } else {
    cardCondition = cardConditionAspect(item.condition);
    conditionDescriptors.push({ name: 'Card Condition', value: cardCondition });
  }

  // ---- images: source URLs (CDN card art first, then any pass-through photo URLs). The media
  // pipeline (lib/ebay-media.mjs) downloads + re-hosts these on eBay EPS and appends the generic
  // trailing image before publish; here we just carry the sources. ----
  const primary = item.image_url || item.image || null;
  const imageUrls = [];
  if (primary) imageUrls.push(primary);
  if (Array.isArray(item.photo_urls)) for (const u of item.photo_urls) if (u && !imageUrls.includes(u)) imageUrls.push(u);

  return {
    sku: item.sku || null,
    game,
    title,
    categoryId: gcfg ? gcfg.categoryId : null,
    conditionId: graded ? (cats.conditionIds.graded || 2750) : (cats.conditionIds.raw || 4000),
    price_cents: item.target_price_cents != null ? item.target_price_cents : (item.price_cents != null ? item.price_cents : null),
    quantity: item.quantity != null ? item.quantity : 1,
    aspects,
    conditionDescriptors,
    graded,
    graderName,                       // Professional Grader enum display string (CSV + description)
    grade: gradeStr,
    cert: item.cert_number || null,
    cardCondition,
    imageUrl: primary,
    imageUrls,
    descriptionHtml,
    value_source: item.value_source || null,
    variantKey: [item.identity_key || item.name, item.variant].filter(Boolean).join('|'),
    // The owner's per-item storefront department pick. [] means "no per-item choice" and the
    // Inventory sink falls back to config — never to nothing.
    storeCategoryNames: storeCategoryList(item.store_categories),
  };
}

// validate(listing) — errors HARD-BLOCK publish/export (a broken row must never reach eBay);
// warnings surface in the pre-flight report but don't block.
export function validateListing(l, cats) {
  cats = cats || loadEbayCategories();
  const errors = [], warnings = [];
  if (!l.categoryId) errors.push('no eBay category for game "' + (l.game || '?') + '" — unsupported game');
  for (const req of cats.requiredAspects || []) {
    if (!l.aspects || !l.aspects[req]) errors.push('missing required aspect "' + req + '"');
  }
  // Structured trading-card condition descriptors are mandatory (both APIs enforce them).
  const dNames = new Set((l.conditionDescriptors || []).map((d) => d.name));
  if (l.graded) {
    if (!dNames.has('Professional Grader')) errors.push('graded card missing the Professional Grader condition descriptor');
    if (!dNames.has('Grade')) errors.push('graded card missing the Grade condition descriptor');
  } else if (!dNames.has('Card Condition')) {
    errors.push('ungraded card missing the Card Condition condition descriptor');
  }
  if (l.price_cents == null || !(l.price_cents > 0)) errors.push('no price (needs_price) — set a price or override before publish');
  else if (l.price_cents < EBAY_MIN_PRICE_CENTS) errors.push('A$' + (l.price_cents / 100).toFixed(2) + ' is under eBay’s A$' + (EBAY_MIN_PRICE_CENTS / 100).toFixed(2) + ' minimum for a fixed-price listing — eBay rejects it (25016), so raise the price before publish');
  if (!l.title || !l.title.trim()) errors.push('empty title');
  else if (l.title.length > 80) errors.push('title over 80 chars (' + l.title.length + ')');
  if (!(l.quantity > 0)) errors.push('quantity must be ≥ 1');
  if (!(l.imageUrls && l.imageUrls.length) && !l.imageUrl) warnings.push('no image — the Inventory API requires ≥1 image to publish; add card art or a photo');
  if (l.value_source === 'bulk_tier') warnings.push('tier-floor priced (no market data)');
  return { errors, warnings };
}

// Group listings into multi-variation parents (EXPERIMENTAL — see LIVE FINDING above).
// Cap enforced on VARIATIONS (card×finish rows), auto-splitting into Part 1/2… parents.
export function groupVariations(listings, { game, setName, cap = 250 } = {}) {
  const groups = [];
  for (let i = 0; i < listings.length; i += cap) groups.push(listings.slice(i, i + cap));
  return groups.map((rows, gi) => ({
    parentTitle: variationTitle(game, setName + (groups.length > 1 ? ' Part ' + (gi + 1) : ''), {}),
    variations: rows.map((l) => ({ ...l, attrs: variationAttrs({ number: l.aspects['Card Number'], name: l.aspects['Card Name'], finish: l.aspects['Finish'] }) })),
  }));
}
