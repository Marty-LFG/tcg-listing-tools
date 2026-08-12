// lib/stock-games.mjs — what differs between games in the two STOCK tools.
//
// stock-uploader.html lists one card; stock-runner.html lists a pile. Both were written against
// pokemontcg.io and had the game welded in at ~25 sites each: the sets URL, the set-cards URL, which
// field holds the collector number, how a printing matrix is read, which facts get persisted, which
// query finds the comps. Everything BELOW those decisions was already game-generic — the publish
// path (lib/channels/ebay-map.mjs → ebay-inventory-api.mjs) has handled `game === 'mtg'` since the
// MTG builder landed, and inventory_items.game has been NOT NULL from the start.
//
// So this is the third per-game adapter table in the repo, beside MAPPERS in lib/normalize.mjs
// (price extraction) and ENUMERATORS in lib/enumerate.mjs (set → rows). Adding SWU or Lorcana is one
// entry, not a second copy of a 130 KB page.
//
// Browser-safe ESM: no node imports, no DOM, no fetch — same contract as lib/runner-core.mjs, so the
// pages load it with <script type="module"> and test/unit/stock-games.test.mjs imports it directly.
// One source, so a rule cannot drift between the uploader, the runner and the tests.
import {
  formatCardNumber, langCode, variantToken,
  mtgColourName, mtgTreatmentOf, mtgPromoNote, mtgLanguageName,
} from './listing-copy.mjs';
import {
  printingsFor, mtgPrintingsFor, finishFromRarity,
  PRINTING_TOKENS, MTG_PRINTING_TOKENS,
} from './runner-core.mjs';

// ---------------------------------------------------------------------------
// The comps query — the one place a game's eBay search is spelled out
// ---------------------------------------------------------------------------

// Mirrors each builder's own findEbay(). This used to prepend the literal 'Pokemon' to EVERY game,
// so a Magic search read "Pokemon Smaug the Magnificent 249 The Hobbit (HOB)" — a query that matches
// nothing, which reads as "no comps" rather than as a bug.
//
// MTG deliberately drops the NUMBER (mtg-listing-builder.html findEbay documents why: Magic titles
// rarely carry a collector number and different printings reuse the name, so matching on it
// over-filters the cluster to nothing) and the "(CODE)" decoration with it. Finish still splits the
// cluster — foil and nonfoil differ a lot — but that is passed separately as finishHint.
//
// Lives here rather than in lib/listings.mjs because the browser needs the same string for its
// eBay ↗ links, and a second copy in a page is a mirror to police (GR9). lib/listings.mjs re-exports
// it. NOT to be confused with the same-named function in lib/repricer-scan.mjs — different
// signature, different job (it works from a parsed listing title, not an inventory row).
export function compsQueryFor(game, it, number) {
  const setName = String(it.set_name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (game === 'mtg') return [it.name, setName].filter(Boolean).join(' ');
  if (game === 'lorcana') return ['Disney Lorcana', it.name, number, setName].filter(Boolean).join(' ');
  if (game === 'riftbound') return ['Riftbound', it.name, number, setName].filter(Boolean).join(' ');
  if (game === 'swu') return ['Star Wars Unlimited', it.name, number, setName].filter(Boolean).join(' ');
  if (game === 'onepiece') return ['One Piece', it.name, number, setName].filter(Boolean).join(' ');
  return ['Pokemon', it.name, number, it.set_name].filter(Boolean).join(' ');
}

// The number the comps FILTER should insist on, which is not always the number in the query.
//
// singlesFilter (lib/comps-singles.mjs) hard-rejects any listing whose title does not contain
// numberMatch. For Magic that filter is the wrong instrument for the same reason the query drops the
// number: the titles do not carry it, so demanding it threw away the entire cluster and every Magic
// row came back with no price at all. The MTG builder has always passed numberMatch:null; this is
// the server and the runner catching up to it.
export function compsNumberMatch(game, number) {
  return game === 'mtg' ? null : number;
}

// ---------------------------------------------------------------------------
// Shared row shape
// ---------------------------------------------------------------------------

// The columns every game fills the same way. Per-game extras are merged on top by invRowFrom.
// `ui` is what the operator chose on the page: { finish, variant, edition, condition,
// storeCategories }. Deliberately NOT the graded fields — the uploader adds those itself, because
// the runner cannot list a slab at all (a graded refusal in runner-core blocks it).
function baseRow(game, nc, ui) {
  ui = ui || {};
  const row = {
    game,
    name: nc.name,
    set_name: nc.setName,
    number: nc.number,
    rarity: nc.rarity || '',
    // The row's own language wins when the caller carries one (a restored queue rebuilds the
    // normalized card, but the row already knew), otherwise the print's.
    language: ui.language || nc.language || 'EN',
    finish: ui.finish || '',
    image_url: nc.image || '',
    identity_key: nc.identityKey || '',
    illustrator: nc.illustrator || null,
    card_type: nc.cardType || null,
    // 'finish' is NOT an inventory_items column, so it is dropped on save; 'variant' is the column
    // that persists the printing, and it is part of UNIQUE(game, identity_key, variant).
    variant: ui.variant || variantToken(ui.edition || '', ui.finish || ''),
    store_categories: (ui.storeCategories || []).slice(),
    // Everything the lookup found, persisted with the item. A later republish carrying no overrides
    // (revise-price, a repricer apply) would otherwise strip the item specifics back off:
    // createOrReplaceInventoryItem is a full replace, not a patch.
    card_facts: JSON.stringify(nc.facts || {}),
  };
  if (ui.edition) row.edition = ui.edition;
  if (ui.condition) row.condition = ui.condition;
  return row;
}

// ---------------------------------------------------------------------------
// Pokémon — pokemontcg.io
// ---------------------------------------------------------------------------

function pkmStage(c) {
  const s = ((c && c.subtypes) || []).join(', ');
  return /stage\s*2/i.test(s) ? 'Stage 2' : /stage\s*1/i.test(s) ? 'Stage 1' : /basic/i.test(s) ? 'Basic' : null;
}

const pokemon = {
  id: 'pokemon',
  label: 'Pokémon',
  tag: 'Pokémon TCG',
  sourceName: 'pokemontcg.io',
  code: 'PKM',                       // the SKU namespace, mirroring GAMECODE in lib/inventory.mjs
  // THE EXACT LITERAL both pages already use, and it must stay that way. Templating it to
  // 'tcg_uploader_sets:pokemon' would orphan every browser's cached set list, and that cache is the
  // only thing standing between a flaky pokemontcg.io and an empty picker (GR7) — a regression no
  // test would catch, because it only shows up on a machine that had the old key.
  setsCacheKey: 'tcg_uploader_pkm_sets',
  setsUrl: () => '/api/pkm/sets?pageSize=500',
  setCardsUrl: (setId, refresh) => '/api/pkm/set/' + encodeURIComponent(setId) + '/cards' + (refresh ? '?refresh=1' : ''),
  cardUrl: (setId, num) => '/api/pkm/cards/' + encodeURIComponent(setId + '-' + num),
  setsFrom: (json) => ((json && json.data) || []).map((s) => ({
    value: s.id, label: s.name, code: (s.ptcgoCode || s.id || '').toUpperCase(),
    icon: (s.images && s.images.symbol) || '', releaseDate: s.releaseDate || '',
  })).sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate))),

  rawNumber: (c) => c.number,
  // GR10: the PRINTED collector number, era/promo/subset aware. formatCardNumber here is the
  // lib/listing-copy.mjs one, which scripts/check-listing-copy.mjs pins byte-identical to
  // extras.js TCG.formatCardNumber — so importing it costs nothing and drops a global.
  cardNumber: (c) => formatCardNumber(c.number, c.set || {}, { source: 'ptcg', rarity: c.rarity }),
  identityKey: (c) => c.id || '',
  // The grid/tick-list thumbnail: the smallest art the source offers, because a set list renders
  // hundreds of them at once. The full-size art for the listing comes off normalizeCard().image.
  thumbUrl: (c) => (c.images && (c.images.small || c.images.large)) || '',
  printingsFor,
  finishFallback: (c) => finishFromRarity(c && c.rarity),
  printingTokens: PRINTING_TOKENS,
  // The uploader's Finish dropdown, in the page's existing order and with its existing spellings.
  // 'Non-holo' is not interchangeable with 'Normal': variantToken, ebayFinish and finishClass all
  // key their negation branch on it, and the whole point of those branches is that "Non-holo"
  // contains "holo".
  finishOptions: ['Holo', 'Reverse Holo', 'Non-holo', 'Foil'],
  // Null: Pokémon has no finish on the record, so the uploader keeps deriving it from the rarity —
  // a guess, and flagged as one. Everything with real finish data returns it here instead.
  defaultFinish: () => null,
  // The runner's rarity filter. Three-way for Pokémon, as it has always been.
  rarityOptions: [
    { value: 'common', label: 'Common' },
    { value: 'uncommon', label: 'Uncommon' },
    { value: 'rare_plus', label: 'Rare and above' },
  ],
  rarityClass: (r) => {
    const s = String(r || '').toLowerCase();
    if (/uncommon/.test(s)) return 'uncommon';      // tested first: 'common' is a substring of it
    if (/common/.test(s)) return 'common';
    return 'rare_plus';
  },

  normalizeCard(c, setMeta) {
    const set = c.set || {};
    const meta = setMeta || {};
    return {
      identityKey: pokemon.identityKey(c),
      name: c.name || '',
      setName: set.name || meta.label || '',
      setCode: set.ptcgoCode || meta.code || '',
      number: pokemon.cardNumber(c),
      rawNumber: c.number,
      rarity: c.rarity || '',
      image: (c.images && (c.images.large || c.images.small)) || '',
      illustrator: c.artist || '',
      language: 'EN',
      cardType: c.supertype || '',
      facts: {
        hp: c.hp, pokedex: c.nationalPokedexNumbers, regulation_mark: c.regulationMark,
        evolves_from: c.evolvesFrom, set_series: set.series || '', set_code: set.ptcgoCode || '',
        set_release_date: set.releaseDate || '', printed_total: set.printedTotal || null,
        types: c.types, subtypes: c.subtypes, supertype: c.supertype,
      },
      stage: pkmStage(c),
      raw: c,
    };
  },

  invRowFrom(nc, ui) {
    const row = baseRow('pokemon', nc, ui);
    row.stage = nc.stage;
    return row;
  },

  // The per-row aspect overrides the server merges over the stored inventory row. character and
  // speciality are deliberately absent: the server derives them (ebayCharacters from the dex
  // numbers, ebaySpeciality from the subtypes) and sending null would just look like data.
  overridesFrom(nc) {
    const f = nc.facts || {};
    return {
      card_type: nc.cardType || null, stage: nc.stage, illustrator: nc.illustrator || null,
      supertype: f.supertype, subtypes: f.subtypes, types: f.types, hp: f.hp,
      pokedex_numbers: f.pokedex, regulation_mark: f.regulation_mark,
      set_code: f.set_code, set_series: f.set_series,
      set_release_date: f.set_release_date, printed_total: f.printed_total,
      evolves_from: f.evolves_from,
    };
  },
};

// ---------------------------------------------------------------------------
// Magic: The Gathering — Scryfall
// ---------------------------------------------------------------------------

// A surge-foil print is a SEPARATE TCGplayer product from its plain sibling, several times the
// price, and Scryfall marks it only in promo_types — `finishes` just says ["foil"]. VERBATIM port of
// mtg-listing-builder.html doLookup()'s finish ladder (MIRROR RULE, GR9).
export function mtgFinishOf(c) {
  const fins = (c && c.finishes) || [];
  if ((c && c.promo_types || []).includes('surgefoil')) return 'Surge Foil';
  if (!fins.length || fins.includes('nonfoil')) return 'Nonfoil';
  return fins.includes('foil') ? 'Foil' : 'Etched Foil';
}

const mtg = {
  id: 'mtg',
  label: 'Magic: The Gathering',
  tag: 'Magic: The Gathering',
  sourceName: 'Scryfall',
  code: 'MTG',
  setsCacheKey: 'tcg_uploader_mtg_sets',
  setsUrl: () => '/api/mtg/sets',
  setCardsUrl: (setId, refresh) => '/api/mtg/set/' + encodeURIComponent(setId) + '/cards' + (refresh ? '?refresh=1' : ''),
  cardUrl: (setId, num) => '/api/mtg/cards/' + encodeURIComponent(setId) + '/' + encodeURIComponent(num),
  // Scryfall answers /sets verbatim. Digital-only sets are dropped: they are not physical stock, and
  // leaving them in the picker means a set you can select and can never post.
  setsFrom: (json) => ((json && json.data) || []).filter((s) => !s.digital).map((s) => ({
    value: s.code, label: s.name, code: String(s.code || '').toUpperCase(),
    icon: s.icon_svg_uri || '', releaseDate: s.released_at || '',
  })).sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate))),

  rawNumber: (c) => c.collector_number,
  // Magic prints '249', so '249' it is — no padding, no era rules, no /total. Mirrors the
  // non-Pokémon short-circuit in printedCardNumber (lib/listings.mjs). Run through the Pokémon
  // formatter, HOB #1 comes out '001', a number that is not on the card and not what a buyer
  // searches (GR10).
  cardNumber: (c) => String(c.collector_number == null ? '' : c.collector_number),
  // set-collector_number, which is what resolveMtgCard parses back. NOT the Scryfall uuid: an
  // identity_key it cannot split breaks every re-resolve on the export path.
  identityKey: (c) => (String(c.set || '') + '-' + String(c.collector_number == null ? '' : c.collector_number)).toLowerCase(),
  thumbUrl: (c) => (c.image_uris && (c.image_uris.small || c.image_uris.normal)) || '',
  printingsFor: mtgPrintingsFor,
  // NOT finishFromRarity: Magic's rarity carries no finish signal, and that regex matches a bare
  // "rare", so every Rare and Mythic would be stamped Holofoil. Scryfall always populates
  // `finishes`, so this is only reachable on a malformed record — and then a plain card is the
  // under-promising answer.
  finishFallback: () => ({ finish: 'Nonfoil', variant: 'Base', fromRarity: false }),
  printingTokens: MTG_PRINTING_TOKENS,
  finishOptions: ['Nonfoil', 'Foil', 'Etched Foil', 'Surge Foil'],
  defaultFinish: (c) => mtgFinishOf(c),
  // FOUR-way, not the three Pokémon uses. "Rare and above" is a useful filter on a Pokémon set and
  // a useless one on a Magic set: HOC is 61% mythic (see the note in data/bulk-pricing.config.json),
  // so collapsing rare and mythic together would leave the filter selecting most of the box.
  //
  // Deliberately NOT shared with rarityFilterClass in lib/enumerate.mjs. That one is a three-way
  // contract with POST /api/bulk/enumerate's `filters.rarities`, and widening it would change the
  // bulk tool's API. Two similar-looking functions, different jobs — do not tidy them together.
  rarityOptions: [
    { value: 'common', label: 'Common' },
    { value: 'uncommon', label: 'Uncommon' },
    { value: 'rare', label: 'Rare' },
    { value: 'mythic', label: 'Mythic' },
  ],
  rarityClass: (r) => {
    const s = String(r || '').toLowerCase();
    if (/mythic/.test(s)) return 'mythic';
    if (/uncommon/.test(s)) return 'uncommon';
    if (/common/.test(s)) return 'common';
    return 'rare';                                   // rare, special, bonus
  },

  normalizeCard(c, setMeta) {
    const meta = setMeta || {};
    const code = String(c.set || meta.value || '').toUpperCase();
    const name = c.set_name || meta.label || '';
    return {
      identityKey: mtg.identityKey(c.set ? c : { ...c, set: meta.value }),
      name: c.name || '',
      // The "(CODE)" suffix is load-bearing, not decoration: titleParts' mtg branch reads the code
      // out of these parens for the abbreviated title, and both stripSetCodeSuffix (the eBay Set
      // aspect) and compsQueryFor strip it back off. Same string the builder puts in f_set.
      setName: name ? name + ' (' + code + ')' : code,
      setCode: code,
      number: mtg.cardNumber(c),
      rawNumber: c.collector_number,
      rarity: capitalise(c.rarity || ''),
      // large first, matching the Pokémon adapter and imageFrom('mtg') in lib/normalize.mjs. This
      // is the LISTING image — runPublish downloads it and re-hosts it on eBay EPS — so the biggest
      // art the trim kept is the right one. thumbUrl is the small one, for the grid.
      image: (c.image_uris && (c.image_uris.large || c.image_uris.normal)) || '',
      illustrator: c.artist || '',
      // langCode(mtgLanguageName(...)) rather than c.lang.toUpperCase(), so a Dwarvish print reaches
      // inventory as DW exactly as the builder's addInv() stores it. The stored code is what the
      // title, the eBay Language aspect and the comps language filter all read.
      language: langCode(mtgLanguageName(c.lang || 'en')),
      cardType: c.type_line || '',
      // These names are not free: lib/channels/ebay-map.mjs buildRowIn reads item.colour /
      // item.card_type / item.treatment / item.promo_note when resolveMtgCard comes back empty
      // (a cold Scryfall cache after a restart), and card_facts is what is merged onto the item.
      // Rename one of them and the fallback silently loses an aspect.
      facts: {
        colour: mtgColourName(c.colors || []),
        card_type: c.type_line || '',
        treatment: mtgTreatmentOf(c),
        promo_note: mtgPromoNote(c),
        illustrator: c.artist || '',
        set_code: code,
        set_release_date: c.released_at || '',
        // Read by mtgFeatures for the Full Art / Promo members of the Features aspect.
        full_art: !!c.full_art,
        promo: !!c.promo,
      },
      raw: c,
    };
  },

  invRowFrom(nc, ui) {
    return baseRow('mtg', nc, ui);
  },

  overridesFrom(nc) {
    const f = nc.facts || {};
    return {
      card_type: f.card_type || null, illustrator: nc.illustrator || null,
      colour: f.colour || null, treatment: f.treatment || null, promo_note: f.promo_note || null,
      set_code: f.set_code, set_release_date: f.set_release_date,
      full_art: f.full_art, promo: f.promo,
    };
  },
};

function capitalise(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const STOCK_GAME_ADAPTERS = { pokemon, mtg };
// Display order in the two pickers. A subset of GAMES in lib/normalize.mjs on purpose: a game only
// belongs here once its eBay aspects have been checked against the live Taxonomy, which so far is
// true of Pokémon and Magic alone.
export const STOCK_GAME_IDS = ['pokemon', 'mtg'];

// Pokémon is the floor, not a guess: it is what every row created before the switcher existed is,
// and what a stale localStorage value or a hand-typed ?game= should fall back to.
export function adapterFor(game) {
  return STOCK_GAME_ADAPTERS[String(game || '').toLowerCase()] || STOCK_GAME_ADAPTERS.pokemon;
}
export function isStockGame(game) {
  return Object.prototype.hasOwnProperty.call(STOCK_GAME_ADAPTERS, String(game || '').toLowerCase());
}
