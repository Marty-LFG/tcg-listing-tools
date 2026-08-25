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
  mtgColourName, mtgTreatmentOf, mtgPromoNote, mtgLanguageName, lorcanaInkAspect, riftboundCharacter,
} from './listing-copy.mjs';
import {
  printingsFor, mtgPrintingsFor, lorcanaPrintingsFor, lorcanaSpecialFinish, finishFromRarity,
  riftboundPrintingsFor,
  PRINTING_TOKENS, MTG_PRINTING_TOKENS, LORCANA_PRINTING_TOKENS, RIFTBOUND_PRINTING_TOKENS,
} from './runner-core.mjs';
import {
  stockLangs, dataLangOf, codeFromLang, langEbayKeyword, intlIdentityKey, intlNumCandidates,
  setLookupId, setEnglishName, englishCardName, nativeInfo, intlPrintingsFor, intlFinishFallback,
} from './pokemon-intl.mjs';

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
//
// NON-ENGLISH POKÉMON adds two tokens, mirroring pokemon-listing-builder.html findEbay(). Both are
// recall, and the query is the only lever on recall the comps engine has: the language FILTER
// downstream (singlesFilter, lib/comps-singles.mjs) keeps a Japanese title and an English one,
// because a JP listing is often titled bilingually. So without the word in the QUERY, a JP card
// searched the English market, the filter kept the English results, and the row came back with a
// confident price for a card the seller does not own — the same failure GR4 exists for, arriving
// through a missing search term. The native printed code (M5 / sv8a) rides along because JP and CN
// sellers routinely put it in the title where an English seller writes the set name.
export function compsQueryFor(game, it, number) {
  const setName = String(it.set_name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (game === 'mtg') return [it.name, setName].filter(Boolean).join(' ');
  if (game === 'lorcana') return ['Disney Lorcana', it.name, number, setName].filter(Boolean).join(' ');
  if (game === 'riftbound') return ['Riftbound', it.name, number, setName].filter(Boolean).join(' ');
  if (game === 'swu') return ['Star Wars Unlimited', it.name, number, setName].filter(Boolean).join(' ');
  if (game === 'onepiece') return ['One Piece', it.name, number, setName].filter(Boolean).join(' ');
  // '' for English, so an English row's query is byte-identical to what it has always been.
  const kw = langEbayKeyword(it.language);
  let code = kw ? String(it.set_code || '').trim() : '';
  // Many intl sets have no romanised name in the bake, so setEnglishName falls back to the printed
  // code and set_name IS set_code — repeating it costs a token and buys nothing.
  if (code && code.toLowerCase() === String(it.set_name || '').trim().toLowerCase()) code = '';
  return ['Pokemon', it.name, number, it.set_name, code, kw].filter(Boolean).join(' ');
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
  // NON-ENGLISH ONLY, and not an inventory_items column — ITEM_INSERT_COLS drops it on save, and
  // card_facts is what actually persists it. It rides on the row for the INLINE comps path: POST
  // /api/listings/price accepts a `{row:{…}}` that never touched the DB, so compsQueryFor would
  // otherwise have no way to read the native printed code (M5 / sv8a) that JP and CN sellers put in
  // their titles. On the DB path itemToListing merges card_facts first and it arrives that way.
  //
  // Gated rather than unconditional so the English and Magic rows stay byte-identical to what the
  // pages built before any of this existed — the property test/unit/stock-games.test.mjs's GOLDEN
  // block is for, and the one an English-lane regression would show up in first. English gains
  // nothing from it anyway: compsQueryFor only reads set_code when there is a language keyword.
  if (nc.setCode && row.language && row.language !== 'EN') row.set_code = nc.setCode;
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

const EN_NAME_SOURCES = new Set(['pricecharting', 'pricecharting-early', 'japanese-twin', '52poke']);
// Sources that carry no native text of their own and must not have one reconstructed for them.
const NO_NATIVE_SOURCES = new Set(['japanese-twin']);

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
  // What the two pages show as the placeholder and in the catch-line grammar. On the adapter rather
  // than in the pages because it was the LAST hardcoded game literal in either of them
  // (`GAME === 'mtg' ? '249' : '125'`), and a two-way ternary does not survive a third game.
  // `setCode` must be a code the catch line will actually accept — for Lorcana that rules out the
  // numbered sets, which contribute no token (see setsFrom below).
  catchExample: { num: '125', setCode: 'obf', setHint: 'set name or code, e.g. PAR or Paradox Rift', numHint: 'e.g. 25  or  199/165' },

  // The five lanes the stock tools offer. Pokémon is the only game with more than one, so both
  // pages gate their language control on the adapter carrying this at all.
  langs: stockLangs(),

  // EVERY language argument below defaults to 'en', and the English branch is byte-identical to
  // what it was before the intl lanes landed. That is deliberate: the English path is the one in
  // daily use, and it should be impossible for a Japanese bug to reach it.
  setsUrl: (lang = 'en') => (dataLangOf(lang) === 'en' ? '/api/pkm/sets?pageSize=500' : null),
  // The intl set list is not an API — it is the baked TCGdex index, same file the builder reads.
  // Hence setsUrl() returning null above: "there is no endpoint, read the bake".
  intlSetsUrl: () => '/data/pokemon-intl-sets.json',
  setCardsUrl: (setId, refresh, lang = 'en', setMeta) => {
    if (dataLangOf(lang) === 'en') return '/api/pkm/set/' + encodeURIComponent(setId) + '/cards' + (refresh ? '?refresh=1' : '');
    // /api/catalog/cards already picks the source (TCGdex vs PriceCharting), normalises the rows and
    // caches them to disk for 24h with a last-good fallback — so the runner keeps its one-request
    // -per-set property on the intl lanes too, and GR7 is handled server-side.
    const m = setMeta || {};
    const qs = new URLSearchParams({ lang: dataLangOf(lang), set: String(m.code || setId || '') });
    // tcgdexId and pcSlug are CAPABILITIES, not a choice of source — "this set can be looked up
    // these ways", and the server picks the order (lib/catalog.mjs cardSourceChain). This used to
    // send `src=indexed` for any set with a code at all, which pinned every intl set to TCGdex and
    // made the PriceCharting branch unreachable: a set TCGdex hadn't ingested (M6 Storm Emeralda)
    // 404'd and reported "no cards returned" while its PC console sat there fully populated.
    // Only claim the TCGdex capability when the bake actually recorded a TCGdex id.
    if (m.pcSlug) qs.set('pcSlug', m.pcSlug);
    if (m.tcgdexId) qs.set('tcgdexId', String(m.tcgdexId));
    if (refresh) qs.set('refresh', '1');
    return '/api/catalog/cards?' + qs.toString();
  },
  cardUrl: (setId, num, lang = 'en') => (dataLangOf(lang) === 'en'
    ? '/api/pkm/cards/' + encodeURIComponent(setId + '-' + num)
    : '/api/tcgdex/' + encodeURIComponent(dataLangOf(lang)) + '/cards/' + encodeURIComponent(setId + '-' + num)),
  // The zero-padding ladder a TCGdex id needs ("25" -> 025, 25). The uploader walks these.
  cardUrlCandidates: (setMeta, num, lang = 'en') => {
    if (dataLangOf(lang) === 'en') return [];
    const code = setLookupId(setMeta);
    return code ? intlNumCandidates(num).map((n) => pokemon.cardUrl(code, n, lang)) : [];
  },
  // PriceCharting is the PRIMARY intl card source where the set has a console: English card names,
  // full-res art, and coverage of sets TCGdex has not ingested. Null when there is none.
  pcConsoleUrl: (setMeta) => (setMeta && setMeta.pcSlug ? '/api/pc/console?slug=' + encodeURIComponent(setMeta.pcSlug) : null),
  setsFrom: (json) => ((json && json.data) || []).map((s) => ({
    value: s.id, label: s.name, code: (s.ptcgoCode || s.id || '').toUpperCase(),
    icon: (s.images && s.images.symbol) || '', releaseDate: s.releaseDate || '',
  })).sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate))),

  // AGENTS.md §17: `setsCacheKey` stays the LITERAL. Templating it would orphan every browser's
  // cached English set list, and that cache is the only thing between a flaky pokemontcg.io and an
  // empty picker (GR7) — a regression no test can catch, because it only shows on a machine that
  // had the old key. The intl lanes get their own suffixed keys, which have no history to orphan.
  setsCacheKeyFor: (lang = 'en') => (dataLangOf(lang) === 'en' ? 'tcg_uploader_pkm_sets' : 'tcg_uploader_pkm_sets:' + dataLangOf(lang)),

  // ---- the non-English CARD SHAPE ---------------------------------------------------------------
  //
  // Both stock pages call rawNumber / cardNumber / identityKey / thumbUrl / printingsFor /
  // finishFallback / normalizeCard with a bare card object and no language — and on the mixed-pile
  // paths they call them through adapterFor(row.game), which cannot know one either. Rather than
  // adding a lang argument to seven methods (and to every call site, and to the row so it could be
  // read back), a non-English card is ADAPTED AT THE BOUNDARY into a synthetic card that carries
  // its own language and set. Every method below branches on __intl and nothing else changes.
  //
  // `source` distinguishes the two upstreams behind an intl card, and it matters twice: TCGdex
  // gives a native name and an already-padded localId, PriceCharting gives an English name and a
  // bare number.
  intlCard: ({ lang, set, localId, name, rarity, image, source, full, nameNative } = {}) => ({
    __intl: true, __lang: lang, __set: set || {},
    localId: String(localId == null ? '' : localId), name: name || '', rarity: rarity || '',
    // The name as PRINTED, when the source hands one over. 52poke does (its lists are Chinese and
    // the English name is resolved from it); PriceCharting and the Japanese twin do not.
    nameNative: nameNative || '',
    image: image || '', source: source || 'tcgdex',
    // The full TCGdex record when there is one (the uploader fetches it per card). Absent on the
    // runner's per-set index, which is TCGdex's briefs endpoint — hence no variants and no facts.
    full: full || null,
  }),
  // One /api/catalog/cards row -> the synthetic card. That endpoint already normalises TCGdex and
  // PriceCharting into one envelope, so this is only about labelling which one answered.
  intlCardFromIndex: (row, set, lang) => pokemon.intlCard({
    lang, set, localId: (row && row.numRaw) || '', name: (row && row.name) || '',
    rarity: (row && row.rarity) || '', image: (row && (row.imgLarge || row.img)) || '',
    source: (row && row.source) || 'tcgdex', nameNative: (row && row.nameNative) || '',
  }),

  // Sources whose card names arrive ALREADY ENGLISH, so the dex resolver must not touch them:
  // PriceCharting scrapes English names, the Japanese twin comes through PriceCharting, and the
  // 52poke lane resolves Chinese to English before it ever leaves lib/catalog.mjs. Running an
  // English name back through englishCardName is how "Type: Null" once rendered as タイプ：ヌル.
  // (Declared above the adapter so both displayName and normalizeIntlCard see it.)
  // The name to SHOW and to search on. For a non-English card that is NOT the name on the card:
  // TCGdex hands back リザードンex and the listing will read "Charizard ex". One rule, used by
  // normalizeIntlCard and by both pages' grids, so what you scan cannot differ from what publishes.
  displayName: (c, dex) => {
    if (!c) return '';
    if (!c.__intl) return c.name || '';
    if (EN_NAME_SOURCES.has(c.source)) return String(c.name || '').trim();
    const full = c.full && c.full.name ? c.full : c;
    // Falls back to the native name: a blank cell is worse than a name in the wrong script, and a
    // Trainer with no English source is exactly the card the operator has to type in by hand.
    return englishCardName(full, dex, dataLangOf(c.__lang)) || c.name || '';
  },

  rawNumber: (c) => (c && c.__intl ? c.localId : c.number),
  // GR10: the PRINTED collector number, era/promo/subset aware. formatCardNumber here is the
  // lib/listing-copy.mjs one, which scripts/check-listing-copy.mjs pins byte-identical to
  // extras.js TCG.formatCardNumber — so importing it costs nothing and drops a global.
  //
  // For an intl card the DENOMINATOR is the non-English set's own count — a JP secret rare prints
  // 102/081 where the English counterpart holds 84 — and the source decides the numerator rule:
  // TCGdex's localId is already card-correct so only the denominator pads, PriceCharting reports a
  // bare '4' that still needs the era rule or it prints 4/081 for a card that reads 004/081.
  cardNumber: (c) => (c && c.__intl
    ? formatCardNumber(c.localId, {
      name: setEnglishName(c.__set), printedTotal: c.__set.cardCount, total: c.__set.cardCount,
      series: c.__set.serie || '', releaseDate: c.__set.releaseDate || '',
    }, { source: c.source === 'tcgdex' ? 'tcgdex' : 'ptcg', rarity: c.rarity })
    : formatCardNumber(c.number, c.set || {}, { source: 'ptcg', rarity: c.rarity })),
  identityKey: (c) => (c && c.__intl
    ? intlIdentityKey(dataLangOf(c.__lang), setLookupId(c.__set), c.localId)
    : (c.id || '')),
  // The grid/tick-list thumbnail: the smallest art the source offers, because a set list renders
  // hundreds of them at once. The full-size art for the listing comes off normalizeCard().image.
  thumbUrl: (c) => (c && c.__intl ? c.image : (c.images && (c.images.small || c.images.large)) || ''),
  // An intl card's printing matrix is TCGdex's `variants` — real DATA, so an intl card gets the same
  // GR5 treatment an English one does. The runner's per-set index has none (briefs endpoint), so it
  // comes back empty there and finishFallback answers instead.
  printingsFor: (c) => (c && c.__intl ? intlPrintingsFor(c.full) : printingsFor(c)),
  // finishFromRarity must NOT run for an intl card. Its regex answers a bare 'Rare' with Holo, and
  // intl rarity is frequently absent entirely (PriceCharting carries none) — so it would stamp a
  // guess on a card whose finish nothing has actually looked at. A declared default instead, and
  // deliberately not flagged `fromRarity`, because it is not one.
  finishFallback: (c) => (c && c.__intl ? intlFinishFallback() : finishFromRarity(c && c.rarity)),
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

  normalizeCard(c, setMeta, dex) {
    // One entry point, whichever catalogue answered — so neither page, and none of the
    // adapterFor(row.game) call sites on the mixed-pile paths, has to know which lane a card is on.
    if (c && c.__intl) return pokemon.normalizeIntlCard({ card: c, setMeta: c.__set, lang: c.__lang, dex });
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
      // A LITERAL, not a default: pokemontcg.io holds English cards and nothing else, so a row
      // built from it IS English. Japanese, Chinese and Korean come from a different source and a
      // different function — normalizeIntlCard below.
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

  // ---- the non-English lane -------------------------------------------------------------------
  //
  // Two sources, merged, because neither is sufficient on its own — the same arrangement
  // pokemon-listing-builder.html doLookupIntl() has always used:
  //
  //   PriceCharting  English card name + full-res art, and the only coverage of sets TCGdex has
  //                  not ingested yet. Carries NO rarity, stage, type, illustrator, HP or dexId.
  //   TCGdex         all of those, plus the `variants` printing matrix, plus the native name.
  //
  // So a PriceCharting hit is still enriched from TCGdex. Dropping that step is what would make a
  // Japanese listing visibly thinner than the English one beside it: no Rarity, no Character, no
  // Card Type on the eBay facets.
  //
  // Takes the synthetic intl card built by intlCard() / intlCardFromIndex(). `full` is the TCGdex
  // record when one was fetched (the uploader does, per card); without it this is still a usable
  // row — the operator types the missing fields, exactly as the builder degrades (GR7).
  normalizeIntlCard({ card, setMeta, lang, dex } = {}) {
    const c = card || {};
    const full = c.full || {};
    const set = setMeta || c.__set || {};
    const dl = dataLangOf(lang || c.__lang);
    const isEnName = EN_NAME_SOURCES.has(c.source);
    const enSet = setEnglishName(set);
    // PriceCharting's name is ALREADY English; TCGdex's is native script and has to be resolved
    // through the dex. Native script must never reach the card name — it is what the eBay title is
    // built from, and a Japanese title is unsearchable on eBay AU.
    const enName = pokemon.displayName(c, dex);
    const rawNumber = String(c.localId || '').trim();
    const total = (full.set && full.set.cardCount && (full.set.cardCount.official || full.set.cardCount.total)) || set.cardCount || '';
    const number = pokemon.cardNumber(c);
    const ni = nativeInfo(dex, dl, enName);
    return {
      identityKey: pokemon.identityKey(c),
      name: enName,
      // The ENGLISH set name, which for many intl sets is really the printed code — see
      // setNameIsCodeOnly. The native name rides in facts and lands in the description instead.
      setName: enSet,
      setCode: String(set.code || ''),
      number,
      rawNumber,
      rarity: c.rarity || full.rarity || '',
      image: c.image || '',
      illustrator: full.illustrator || '',
      language: codeFromLang(lang || c.__lang),
      cardType: full.category || '',
      facts: {
        hp: full.hp,
        // The eBay Character aspect derives from this (ebayCharacters, lib/channels/ebay-map.mjs).
        // TCGdex calls it dexId; the English adapter's source calls it nationalPokedexNumbers.
        pokedex: full.dexId,
        regulation_mark: full.regulationMark,
        set_series: set.serie || '',
        set_code: String(set.code || ''),
        set_release_date: set.releaseDate || '',
        printed_total: total || null,
        types: full.types,
        supertype: full.category || '',
        // The provenance block the builder puts in its description. Persisted here so a republish
        // carrying no overrides cannot strip it back off (createOrReplaceInventoryItem is a full
        // replace, not a patch). The native name is the TCGdex one when we have it; otherwise it is
        // reconstructed from the dex, which is how a PriceCharting-only card still gets one.
        // `ni.native` RECONSTRUCTS a native name from the dex, which is right for a PriceCharting
        // Japanese card (the card really is Japanese) and wrong for a derived one: the Japanese
        // twin serves a Korean set from Japanese cards, so reconstructing a Korean name would be
        // inventing text that is on no card. Blank is the honest answer there.
        native_name: full.name || c.nameNative || (!isEnName ? c.name : '')
          || (NO_NATIVE_SOURCES.has(c.source) ? '' : ni.native) || '',
        romaji: ni.romaji || '',
        native_set: set.name_native || '',
        en_set: (set.enEquivalent && set.enEquivalent.name) || '',
      },
      stage: full.stage || null,
      // The printing matrix, from TCGdex's variants when there is a full record. Empty on the
      // PriceCharting-only and set-index paths, where the caller falls back to intlFinishFallback().
      printings: pokemon.printingsFor(c),
      raw: full.name ? full : c,
    };
  },

  // The rarity filter is the one thing that needs the LANGUAGE rather than a card, because it is
  // built before any card is in hand. For intl there is nothing to filter ON: /api/catalog/cards
  // returns rarity:'' for both its sources, and pokemon.rarityClass('') falls through to
  // 'rare_plus' — so
  // "Common" would select nothing and "Rare and above" would select everything. An empty list
  // leaves only "all rarities", i.e. the control disappears rather than lying (GR4).
  rarityOptionsFor: (lang = 'en') => (dataLangOf(lang) === 'en' ? pokemon.rarityOptions : []),

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
      // Non-English provenance. Undefined on an English row, and pickOverrides drops undefined, so
      // the English payload is unchanged. These are what put "Japanese name | リザードンex Lizardon"
      // and "English set | Pitch Black" in the description — buildDescription has always rendered
      // them, nothing on the stock path had ever filled them in.
      native_name: f.native_name, romaji: f.romaji, native_set: f.native_set, en_set: f.en_set,
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
  catchExample: { num: '249', setCode: 'neo', setHint: 'set name or code, e.g. NEO or Kamigawa', numHint: 'e.g. 249' },
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
// Disney Lorcana — Lorcast
// ---------------------------------------------------------------------------

// "Super_rare" -> "Super Rare"; title-cases each word. MIRROR of prettyRarity in
// lorcana-listing-builder.html and lib/enumerate.mjs — three copies of four characters of regex is
// not worth an import cycle, but they must agree, and ebay-aspects-lorcana pins the result.
function prettyRarity(r) { return String(r || '').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()); }

const lorcana = {
  id: 'lorcana',
  label: 'Disney Lorcana',
  tag: 'Disney Lorcana',
  sourceName: 'Lorcast',
  code: 'LOR',                        // the SKU namespace, mirroring GAMECODE in lib/inventory.mjs
  // A NEW key — neither stock page has ever cached a Lorcana set list, so unlike the Pokémon one
  // there is no browser out there holding an old shape under it.
  setsCacheKey: 'tcg_uploader_lorcana_sets',
  // The switch example is a PROMO code on purpose: the numbered sets contribute no catch-line token
  // (see setsFrom), so showing `13` here would document a switch that does not work.
  catchExample: { num: '241', setCode: 'D23', setHint: 'set name or code, e.g. D23 or Azurite Sea', numHint: 'e.g. 241' },
  setsUrl: () => '/api/lorcana/sets',
  setCardsUrl: (setId, refresh) => '/api/lorcana/set/' + encodeURIComponent(setId) + '/cards' + (refresh ? '?refresh=1' : ''),
  cardUrl: (setId, num) => '/api/lorcana/cards/' + encodeURIComponent(setId) + '/' + encodeURIComponent(num),

  // Lorcast wraps in `results`, not Scryfall's `data`.
  //
  // ⚠ `code` IS THE CATCH-LINE TOKEN, and it is deliberately BLANK for the numbered sets.
  // stock-runner.html builds its set-switch vocabulary from these (setCodes(), which filters
  // Boolean), and Lorcana's numbered sets are called '1'…'13' — which are also perfectly ordinary
  // collector numbers. Left in, typing `13` for card 13 would parse as a SET SWITCH and silently
  // add no card at all, on the single most common thing an operator types. The promo codes (P1,
  // D23, cp, C2, DIS, PD1, Coconut) cannot be confused with a number, so they keep theirs and
  // mid-pile switching still works where it is unambiguous. Numbered sets are picked from the
  // dropdown, which lists every set by name in release order.
  setsFrom: (json) => ((json && (json.results || json.data)) || []).filter((s) => s && s.code)
    // An UNRELEASED set is not stock. Same reasoning as the mtg adapter dropping `digital` sets:
    // leaving it in means a set you can select and can never post. A set in PRERELEASE stays —
    // those cards are physically in hand — so this only drops sets whose prerelease is also in the
    // future. lorcana-listing-builder.html loadSets() filters on released_at alone; it is a preview
    // tool, this one creates live listings, so it is the stricter of the two that matters here.
    .filter((s) => {
      const today = new Date().toISOString().slice(0, 10);
      const rel = String(s.released_at || '').slice(0, 10);
      const pre = String(s.prereleased_at || '').slice(0, 10);
      if (!rel && !pre) return true;                 // no dates at all: do not silently hide it
      return (rel && rel <= today) || (pre && pre <= today);
    })
    .map((s) => ({
    value: String(s.code),
    label: s.name || String(s.code),
    code: /^\d+$/.test(String(s.code)) ? '' : String(s.code).toUpperCase(),
    icon: '',                          // Lorcast publishes no set symbol — see lib/lorcana-sets-cache.mjs
    releaseDate: s.released_at || '',
  })).sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate))),

  rawNumber: (c) => c.collector_number,
  // Lorcana prints '241', so '241' it is. Through the Pokémon formatter it would come out '241/242'
  // — a denominator Lorcana cards do not carry (GR10). Mirrors printedCardNumber's non-Pokémon
  // short-circuit in lib/listings.mjs.
  cardNumber: (c) => String(c.collector_number == null ? '' : c.collector_number),
  // "<setCode>/<number>", which is what resolveLorcanaCard parses back and what
  // ENUMERATORS.lorcana and lib/collectr-resolve.mjs already write. NOT Lorcast's crd_… uuid: an
  // identity_key the export path cannot split breaks every re-resolve.
  identityKey: (c) => String((c.set && c.set.code) || '') + '/' + String(c.collector_number == null ? '' : c.collector_number),
  thumbUrl: (c) => (c.image_uris && c.image_uris.digital && (c.image_uris.digital.small || c.image_uris.digital.normal)) || '',
  printingsFor: lorcanaPrintingsFor,
  // NOT finishFromRarity: that regex matches a bare "rare", so every Lorcana Rare and Super Rare
  // would be stamped Holofoil, feed finishHint('foil') into the comps search and return a confident
  // price for a card you do not own — the exact failure documented at runner-core.mjs:149. Lorcast
  // always carries a `prices` object, so this is only reachable on a malformed record, and then a
  // plain card is the under-promising answer.
  finishFallback: () => ({ finish: 'Normal', variant: 'Base', fromRarity: false }),
  printingTokens: LORCANA_PRINTING_TOKENS,
  // Cold Foil is in this list and in NO derivation anywhere: TCGplayer sells Normal / Cold Foil /
  // Holofoil but no keyless source labels cold foil per card, so it is operator-chosen only (GR4).
  finishOptions: ['Normal', 'Foil', 'Cold Foil', 'Enchanted', 'Epic', 'Iconic'],
  defaultFinish: (c) => lorcanaSpecialFinish(c && c.rarity)
    || ((c && c.prices && c.prices.usd == null && c.prices.usd_foil != null) ? 'Foil' : 'Normal'),
  // FOUR-way, and grouped by what the cards are WORTH rather than by where they sit in the rarity
  // ladder — counted medians (docs/DATA_SOURCES.md) put Rare and Super Rare together at US$0.56 and
  // US$0.97 foil, while Legendary US$4.46, Epic US$4.74, Promo US$8.64, Enchanted US$109 and
  // Iconic US$1,789 are the pile actually worth listing one at a time.
  //
  // Deliberately NOT shared with rarityFilterClass in lib/enumerate.mjs, which is a three-way
  // contract with POST /api/bulk/enumerate's `filters.rarities`. Two similar-looking functions,
  // different jobs — do not tidy them together.
  rarityOptions: [
    { value: 'common', label: 'Common' },
    { value: 'uncommon', label: 'Uncommon' },
    { value: 'rare', label: 'Rare and Super Rare' },
    { value: 'chase', label: 'Chase and promo' },
  ],
  rarityClass: (r) => {
    const s = String(r || '').toLowerCase();
    if (/uncommon/.test(s)) return 'uncommon';         // tested first: 'common' is a substring of it
    if (/common/.test(s)) return 'common';
    // Before the bare /rare/ test, because "Super Rare" contains "rare" and Legendary/Epic/
    // Enchanted/Iconic/Promo carry no rarity word at all.
    if (/enchanted|iconic|epic|legendary|promo/.test(s)) return 'chase';
    return 'rare';                                     // Rare, Super Rare, and anything unrecognised
  },

  normalizeCard(c, setMeta) {
    const meta = setMeta || {};
    const set = c.set || {};
    const code = String(set.code || meta.value || '');
    const types = Array.isArray(c.type) ? c.type : [];
    const classifications = Array.isArray(c.classifications) ? c.classifications : [];
    return {
      identityKey: lorcana.identityKey(set.code ? c : { ...c, set: { ...set, code } }),
      // The builder's own name shape: Lorcast keeps these apart and every surface joins them.
      name: (c.name || '') + (c.version ? ' - ' + c.version : ''),
      // NO "(CODE)" decoration, unlike Magic. Lorcana's titleParts branch reads the code out of the
      // set name's parens only when the builder put one there, and the eBay Set aspect wants the
      // bare name — so adding one here would put "(13)" on the facet for nothing.
      setName: set.name || meta.label || '',
      setCode: code,
      number: lorcana.cardNumber(c),
      rawNumber: c.collector_number,
      rarity: prettyRarity(c.rarity),
      // large first, matching the Pokémon and Magic adapters and imageFrom('lorcana'). This is the
      // LISTING image — runPublish downloads it and re-hosts it on eBay EPS. AVIF, which sharp
      // decodes through libheif and eBay accepts.
      image: (c.image_uris && c.image_uris.digital && (c.image_uris.digital.large || c.image_uris.digital.normal)) || '',
      illustrator: (Array.isArray(c.illustrators) ? c.illustrators[0] : '') || '',
      language: 'EN',
      cardType: types.join('/'),
      // These names are not free: lib/channels/ebay-map.mjs buildRowIn reads item.character /
      // item.ink / item.classifications / item.cost… when resolveLorcanaCard comes back empty (a
      // cold Lorcast cache after a restart), and card_facts is what is merged onto the item.
      // Rename one of them and the fallback silently loses an aspect or a description row.
      facts: {
        // The bare character name, which is the eBay Character aspect. Free, because Lorcast keeps
        // `name` and `version` in separate fields — counted, `name` never contains " - ".
        character: c.name || '',
        ink: lorcanaInkAspect(c) || '',
        lorcana_types: types,
        card_type: types.join('/'),
        classifications: classifications.join(' · '),
        cost: c.cost != null ? c.cost : '',
        strength: c.strength != null ? c.strength : '',
        willpower: c.willpower != null ? c.willpower : '',
        lore: c.lore != null ? c.lore : '',
        illustrator: (Array.isArray(c.illustrators) ? c.illustrators[0] : '') || '',
        set_code: code,
        set_release_date: c.released_at || set.released_at || '',
        tcgplayer_id: c.tcgplayer_id != null ? c.tcgplayer_id : null,
      },
      raw: c,
    };
  },

  invRowFrom(nc, ui) {
    return baseRow('lorcana', nc, ui);
  },

  overridesFrom(nc) {
    const f = nc.facts || {};
    return {
      character: f.character || null, ink: f.ink || null,
      card_type: f.card_type || null, lorcana_types: f.lorcana_types || null,
      classifications: f.classifications || null, illustrator: nc.illustrator || null,
      cost: f.cost, strength: f.strength, willpower: f.willpower, lore: f.lore,
      set_code: f.set_code, set_release_date: f.set_release_date,
    };
  },
};

// ---------------------------------------------------------------------------
// Riftbound — the baked Riot card gallery (data/riftbound.json, via /api/riftbound/*)
// ---------------------------------------------------------------------------

const riftbound = {
  id: 'riftbound',
  label: 'Riftbound',
  tag: 'Riftbound: League of Legends TCG',
  sourceName: 'the baked Riot card gallery',
  code: 'RB',                         // the SKU namespace, mirroring GAMECODE in lib/inventory.mjs
  // A NEW key — neither stock page has ever cached a Riftbound set list, so unlike the Pokémon one
  // there is no browser out there holding an old shape under it.
  setsCacheKey: 'tcg_uploader_riftbound_sets',
  // The switch example is a real set code, unlike Lorcana's — see setsFrom for why every Riftbound
  // code can be a catch-line token and none of Lorcana's numbered ones can.
  catchExample: {
    num: '27', setCode: 'OGN',
    setHint: 'set name or code, e.g. OGN or Origins',
    numHint: 'e.g. 27 · 27a (alt art) · 299* (signature) · SP1',
  },
  setsUrl: () => '/api/riftbound/sets',
  setCardsUrl: (setId, refresh) => '/api/riftbound/set/' + encodeURIComponent(setId) + '/cards' + (refresh ? '?refresh=1' : ''),
  cardUrl: (setId, num) => '/api/riftbound/cards/' + encodeURIComponent(setId) + '/' + encodeURIComponent(num),

  // EVERY set keeps its `code`, which is the exact opposite of the Lorcana branch above and worth
  // saying why: Riftbound's codes are OGN / OGS / SFD / UNL / VEN, none of them number-shaped, and
  // no printed number in the catalog is letters-only (the shapes are ###/###, ###a/###, ###*/### and
  // SP#/###). So there is nothing a set code could be confused with, and mid-pile switching works
  // for all five. Lorcana's sets are called '1'…'13', which ARE ordinary collector numbers, and that
  // is the only reason its numbered sets contribute no token.
  //
  // ORDER: the bake preserves Riot's own release order, and the gallery roster carries NO release
  // date — probed live 2026-08-25, its entries are {id, name, collectorNumberMax} and nothing else.
  // So the list is reversed into newest-first to match the other three adapters, rather than sorted
  // on a field that would be '' for every set and collapse back into insertion order anyway.
  setsFrom: (json) => ((json && json.sets) || []).map((s) => ({
    value: String(s.id),
    label: s.name || String(s.code || s.id),
    code: String(s.code || s.id).toUpperCase(),
    icon: '',                          // Riot publishes no set symbol; the rail shows the boxed code
    releaseDate: '',
    total: s.total || 0,
  })).reverse(),

  rawNumber: (c) => c.number,
  // Riftbound prints '027a/298' — denominator and all — so that is what ships (GR10). Through the
  // Pokémon formatter it would be mangled; printedCardNumber early-returns for every other game.
  cardNumber: (c) => String(c.number == null ? '' : c.number),
  // 'OGN-27a'. The `k` half is the normNum key the server computed, NOT the printed number: it is
  // what ENUMERATORS.riftbound writes, what data/riftbound-prices.json is keyed on, and what the
  // price tracker re-fetches by. Deriving it from the printed number here would build a key that
  // nothing else in the repo has ever seen.
  identityKey: (c) => String(c.setCode || '').toUpperCase() + '-' + String(c.k == null ? '' : c.k),
  thumbUrl: (c) => c.image || c.image_fallback || '',
  printingsFor: riftboundPrintingsFor,
  // NOT finishFromRarity — its regex matches a bare "rare" and the catalog holds 335 Rares. See the
  // long note on riftboundPrintingsFor. Unreachable while every baked card carries a finish, and
  // Non-foil is the under-promising answer if one ever does not.
  finishFallback: () => ({ finish: 'Non-foil', variant: 'Base', fromRarity: false }),
  printingTokens: RIFTBOUND_PRINTING_TOKENS,
  // Two, because finishOf can only ever produce two. A third option no data supports would be a
  // control that lies (GR4) — Lorcana's 'Cold Foil' earns its place because TCGplayer genuinely
  // sells one; Riftbound has no equivalent.
  finishOptions: ['Non-foil', 'Foil'],
  defaultFinish: (c) => (c && c.finish) || 'Non-foil',
  // FIVE-way, one per baked rarity, where Lorcana and Magic group theirs. No grouping judgement is
  // needed because each rarity word is already its own price tier — joining data/riftbound.json
  // against data/riftbound-prices.json (1173 cards, counted 2026-08-25) gives medians of US$0.08
  // Common, US$0.12 Uncommon, US$0.24 Rare, US$1.81 Epic, and Showcase spanning US$3.55 (alt art)
  // to US$629 (Signature). Showcase is the pile actually worth listing one at a time.
  //
  // Deliberately NOT shared with rarityFilterClass in lib/enumerate.mjs, which is a three-way
  // contract with POST /api/bulk/enumerate's `filters.rarities`. Two similar-looking functions,
  // different jobs — do not tidy them together.
  rarityOptions: [
    { value: 'common', label: 'Common' },
    { value: 'uncommon', label: 'Uncommon' },
    { value: 'rare', label: 'Rare' },
    { value: 'epic', label: 'Epic' },
    { value: 'showcase', label: 'Showcase and premium' },
  ],
  rarityClass: (r) => {
    const s = String(r || '').toLowerCase();
    if (/uncommon/.test(s)) return 'uncommon';         // tested first: 'common' is a substring of it
    if (/common/.test(s)) return 'common';
    // Before the bare /rare/ fall-through. Neither word contains 'rare', but being explicit is what
    // stops a future rarity like 'Showcase Rare' landing in the wrong bucket.
    if (/showcase/.test(s)) return 'showcase';
    if (/epic/.test(s)) return 'epic';
    return 'rare';                                     // Rare, and anything unrecognised
  },

  normalizeCard(c, setMeta) {
    const meta = setMeta || {};
    const code = String(c.setCode || meta.code || '').toUpperCase();
    const type = c.type || '';
    return {
      identityKey: riftbound.identityKey({ ...c, setCode: code }),
      // Already suffix-cleaned by cardToCanonical — '(Alternate Art)' and friends were moved off the
      // name and into `variant`, which is where the title reads them from.
      name: c.name || '',
      // ⚠ THE "(CODE)" SUFFIX IS LOAD-BEARING, three times over, exactly as Magic's is. titleParts
      // reads the code out of these parens for the abbreviated title; composeMetaFor's splitSetIdent
      // → findRiftboundSetMeta uses them for the rail's boxed code badge; and compsQueryFor strips
      // them back off. It is also byte-identical to what ENUMERATORS.riftbound writes, which is what
      // lets a runner row and a bulk row for the same card agree on identity.
      setName: (meta.label || meta.name || '') + ' (' + code + ')',
      setCode: code,
      number: riftbound.cardNumber(c),
      rawNumber: c.number,
      // The MAPPED rarity — 'Showcase' for all four premium treatments alike. What tells them apart
      // afterwards is `variant`, which is why rowToFields passes `f.variant || f.rarity` to the pitch.
      rarity: c.rarity || '',
      // NOT a printing token. See invRowFrom below, and riftboundPrintingsFor in lib/runner-core.mjs.
      variant: c.variant || '',
      finish: c.finish || 'Non-foil',
      // dotgg first with Riot's CMS behind it, matching cardToCanonical and imageFrom('riftbound').
      // This is the LISTING image — runPublish downloads it and re-hosts it on eBay EPS.
      image: c.image || c.image_fallback || '',
      illustrator: c.illustrator || '',
      // A LITERAL. The bake is English and Riot publishes no other lane through this gallery, so
      // there is no language axis to carry and the language control stays hidden (no `langs` key).
      language: 'EN',
      cardType: type,
      // ⚠ These names are not free. lib/listing-copy.mjs rowToFields reads row.rb_type / rb_domain /
      // rb_tags / rb_e / rb_p / rb_m to build the CARD DETAILS table, and card_facts is what gets
      // merged back onto the item on the export path. Rename one and the table silently loses a row.
      facts: {
        rb_type: type,
        rb_domain: c.domain || '',
        rb_tags: c.tags || '',
        rb_e: c.e || '',
        rb_p: c.p || '',
        rb_m: c.m || '',
        // The eBay Character aspect. championTag in lib/riftbound-data.mjs cannot supply it — it
        // splits on ' - ', a separator the gallery bake never writes — so this is the comma-form,
        // Unit-gated derivation. See riftboundCharacter in lib/listing-copy.mjs.
        character: riftboundCharacter(c.name, type),
        illustrator: c.illustrator || '',
        // ⚠ THIS is why a foil survives the database. 'finish' is not an inventory_items column, and
        // itemToListing back-fills a missing finish FROM `variant` — which for Riftbound is the
        // treatment, so a foil Showcase would round-trip as finish:'Alternate Art' and ebayFinish
        // would return null on the most valuable cards in the game. card_facts is merged first, so
        // persisting it here beats that fallback.
        finish: c.finish || 'Non-foil',
        variant: c.variant || '',
        rarity: c.rarity || '',
        set_code: code,
      },
      raw: c,
    };
  },

  invRowFrom(nc, ui) {
    const row = baseRow('riftbound', nc, ui);
    // An OVERRIDE, not a default, and the single most load-bearing line in this adapter. baseRow
    // computes variantToken(edition, finish), and stock-uploader.html hands in its own inline
    // finish→variant ladder as ui.variant — neither of which knows that Riftbound's `variant` column
    // holds the printing TREATMENT rather than a finish. Left alone, every Epic and Showcase card
    // would store variant:'Foil', which deletes '(Signature)' from the title (priority 82 in
    // titleParts, above the rarity token, because it is a 10-100x price differentiator) and yields a
    // different stockKey from the bulk-enumerated row for the same physical card, so the duplicate
    // check misses it.
    //
    // Nothing is lost: single-printing means there is never a foil and a non-foil of one
    // identity_key to keep apart on UNIQUE(game, identity_key, variant).
    row.variant = nc.variant || 'Base';
    return row;
  },

  overridesFrom(nc) {
    const f = nc.facts || {};
    return {
      card_type: f.rb_type || null,
      character: f.character || null,
      illustrator: nc.illustrator || null,
      rb_type: f.rb_type || null, rb_domain: f.rb_domain || null, rb_tags: f.rb_tags || null,
      rb_e: f.rb_e, rb_p: f.rb_p, rb_m: f.rb_m,
      set_code: f.set_code || null,
    };
  },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const STOCK_GAME_ADAPTERS = { pokemon, mtg, lorcana, riftbound };
// Display order in the two pickers. A subset of GAMES in lib/normalize.mjs on purpose: a game only
// belongs here once its eBay aspects have been checked against the live Taxonomy. Lorcana's run was
// 2026-08-14 (scripts/check-ebay-aspects.mjs --game "Disney Lorcana") and it earned its place the
// hard way — the probe is what found that the required Game aspect had never matched its enum.
//
// Riftbound's run was 2026-08-25 (--game "Riftbound"). What it found, and what the aspect code in
// lib/channels/ebay-map.mjs is written against: 'Riftbound: League of Legends TCG' IS a member of
// the 167-value Game enum (the fix already recorded in lib/ebay-vocab.mjs had landed); 'Spell' is
// the only Riftbound card type with a member; Epic and Showcase have no Rarity member and go
// verbatim; the six domains have no Attribute/Colour member and go verbatim; 'Riot Games' is not a
// Manufacturer member and goes verbatim; and the gallery roster carries no release date, so Year
// Manufactured stays unset rather than guessed.
export const STOCK_GAME_IDS = ['pokemon', 'mtg', 'lorcana', 'riftbound'];

// Pokémon is the floor, not a guess: it is what every row created before the switcher existed is,
// and what a stale localStorage value or a hand-typed ?game= should fall back to.
export function adapterFor(game) {
  return STOCK_GAME_ADAPTERS[String(game || '').toLowerCase()] || STOCK_GAME_ADAPTERS.pokemon;
}
export function isStockGame(game) {
  return Object.prototype.hasOwnProperty.call(STOCK_GAME_ADAPTERS, String(game || '').toLowerCase());
}
