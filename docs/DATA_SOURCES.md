# Data sources

Per-game APIs, the fields each builder maps, and how auth/limits work. All calls
go through the Vite dev-server proxies (see `vite.config.js`); the builders never
hit these hosts directly (CORS / key injection). Base URLs below are the *real*
upstream — the builder uses the proxy prefix (e.g. `/api/pkm`).

> When extending a builder, confirm field names against a live response — schemas
> drift. The notes below were accurate at build time.

---

## Price-row model (the shared `renderExtras` contract)

Every builder feeds `TCG.renderExtras(el, {..., prices:[…]})` rows in **one shape** so provenance,
confidence and AUD-first display are consistent. All fields beyond `amount`/`currency` are optional
(a bare `{label, amount, currency}` still renders — backward-compatible):

```
{ amount, currency,                               // required
  source?:  'TCGplayer'|'Cardmarket'|'PriceCharting'|'Scryfall'|'swu-db'|'Scrydex',
  measure?: 'market'|'30d avg sold'|'from (low)'|'eBay-sold raw'|'PSA 10'|'Grade 9'|…,  // what it is
  group?:   'market'|'graded'|'asking',           // section; default 'market'
  note?:    'population 27,631' | '23 listings',
  conf?:    {level:'high'|'medium'|'low', text?}, // ONLY where a real signal exists (PriceCharting match)
  spread?:  {low?, high?},                         // same-currency dispersion (e.g. TCGplayer low–high)
  href? }                                          // (data.pcLink carries the PriceCharting verify URL)
```

`renderExtras` then renders, in order: a **Market consensus** (median of the AUD-converted
`group:'market'` rows) + a **cross-source divergence** flag (agree within X% / differ by X%), then
the **Market / Graded / Asking** sections. **AUD-first**: each row shows `A$` as the primary value
with the native currency as a muted secondary (provenance); FX-down falls back to native-primary.
Pass `data.priceNote` (string) for the no-price empty-state (e.g. Riftbound offline/riftscribe).
**Confidence is shown only where it is real** — PriceCharting match (`conf`), the eBay comps cluster
score, and the divergence flag; API market prices carry no fabricated volatility badge.

## Pokémon — pokemontcg.io v2  (proxy `/api/pkm`)

- Upstream: `https://api.pokemontcg.io/v2`
- Card: `GET /cards/{id}` where `id = "{set.id}-{number}"` (e.g. `sv4-25`).
- Sets: `GET /sets?pageSize=500` → `{ data: [...] }`.
- Responses are wrapped in `{ data: ... }`.
- **Auth:** works **keyless** (lower limit). Optional `X-Api-Key`
  (`POKEMONTCG_API_KEY`) → 20,000 req/day. Now under the Scrydex umbrella, but
  this legacy v2 endpoint still serves anonymous traffic.
- Card fields used: `name`, `supertype`, `subtypes[]`, `hp`, `types[]`, `number`,
  `rarity`, `set{ id, name, series, printedTotal, total }`, `images{ small,
  large }`, `tcgplayer.prices` (USD), `cardmarket.prices` (EUR).
- ⚠ `number` arrives **without the printed zero-padding** — a card printed
  `004/165` comes back as `"4"`, and `printedTotal` as `165`. Rebuild the printed
  form with `formatCardNumber()` (Golden Rule 10); see "Card-number formatting"
  below. `series` + `releaseDate` are what decide the padding era.
- Set fields used (picker): `id`, `name`, `series`, `releaseDate`, `ptcgoCode`
  (the **printed code** on cards, e.g. `PAR`), `images.symbol` (set symbol icon).
- Set picker resolves a typed token against `id`, `ptcgoCode`, **or** `name`
  (so `PAR`, `sv4`, and `Paradox Rift` all find Paradox Rift). Sets are cached in
  `localStorage` (`pkm_sets_v1`) and refreshed in the background.
- **Image fallback (dotgg):** the card image falls back to
  `https://static.dotgg.gg/pokemon/card/{c.id}.webp` (the dotgg code IS the
  pokemontcg.io id, e.g. `swsh10tg-TG01`, case-sensitive) — used as primary when
  pokemontcg.io returns no image, and as an `onerror` swap when its image breaks.
  **dotgg is EN-only** (keyed on the pokemontcg.io id) — never built for a JP/CN/KO id.

## Pokémon EN "Mega Evolution Promo" — baked roster (`data/pokemon-mep.json`, no proxy)

A **self-contained** EN set that neither of the EN lanes above can serve: pokemontcg.io has no
`mep` set (its promo catalog stops at `svp`, 2023) **and** it has no PriceCharting console (so the
early-EN overlay, which needs a `pcSlug` to enumerate cards, can't surface it either). It *is* in the
paid **Scrydex** `/pokemon/v1` API (ids `mep-<n>`), but our key is `402 SUBSCRIPTION_INACTIVE` — so
instead of migrating the whole EN lane to paid Scrydex we bake a small static roster:

- **Roster** (name + number + market price + **stage/type/hp**): fetched **live, server-side** from
  TCGplayer's public search API (`mp-search-api.tcgplayer.com/v1/search/request`, `setName:
  me-mega-evolution-promo`) — a Node fetch with browser headers passes where the browser can't (CORS);
  paginated (cap 50/page). `scripts/build-pokemon-mep.mjs` cleans the quirky product names (strips
  `- NNN`/`[Staff]`/parentheticals, tolerates typos like `Comos Holo`, `Patch Black Stamp`), groups
  variant rows under one padded card number, and emits `data/pokemon-mep.json` (`{ set, source,
  cards:[{number, name, rarity:'Promo', stage?, type?, hp?, variants:[{label, market}], img? }] }`).
  **79 base cards** (numbers 001–088). **No manual step** — the search API also carries stage/energy
  type/HP that the earlier browser scrape lacked. GR7: a fetch failure THROWS pre-write, so the refresh
  keeps the existing catalog (atomic temp+rename).
- **Automation (≤24h freshness):** wired into the in-process refresh as the `pokemon-mep` bake
  (`lib/refresh.mjs`), so a new promo or price move lands within `interval_hours` (default 6h). A NEW
  card triggers a Telegram alert (`alertMepCards`, mirrors the early-set alert). The file is
  **gitignored + server-owned** (like `pokemon-en-early.json`) so the daily rebuild never collides with
  a git pull; a fresh deploy cold-starts from the tracked `data/pokemon-mep-seed.json` (`ensureMepSeeded`),
  then the bake refreshes it live ~60s after boot.
- **Images (runtime, not baked):** `images.scrydex.com/pokemon/mep-<bareNumber>/{small,large}` — that
  CDN is **keyless** even though the API isn't (bare number, NOT zero-padded: `mep-66`, not `mep-066`).
  The bake **probes** each card's `small` image and records `img` only when a real image is present
  (the CDN returns a fixed 45,551-byte placeholder PNG at HTTP 200 for misses) — currently 71/79 have
  art; the newest 8 (081–088) fall back to the builder's editable image field. Display + download route
  through the `/api/img` disk cache like the JP/CN/KO path.
- **Builder wiring:** loaded client-side (`loadMep()`, `localStorage` `pkm_mep_v1`); the set shows in
  the EN picker (id `mep`, code `MEP`), hidden the moment pokemontcg.io lists it (`activeSets`
  graduation, same as early-EN). A typed number resolves against the roster in `doLookupMep` — English
  name/set/number + stage/type/HP + Scrydex image + TCGplayer price rows (base variant = `market`,
  `[Staff]`/PC-exclusive/etc = `asking`). **Listing-only:** no pokemontcg.io id, so `identity_key` stays blank and
  tracker/inventory are gated (like the JP/early-EN lanes). eBay AU comps work as usual off the filled
  fields. Delete the roster once the set graduates to pokemontcg.io.

## Pokémon JP / CN / KO — TCGdex  (proxy `/api/tcgdex`, keyless)

English uses pokemontcg.io (above). **Japanese, Simplified Chinese, Traditional Chinese, and
Korean** use **TCGdex** (`https://api.tcgdex.net/v2/{lang}`, lang ∈ `ja`, `zh-cn`, `zh-tw`, `ko`) —
keyless, and it uses the **printed set code as the set id** (JP `SV3`/`M5`, CN `CSV4C`), which is
exactly the symbol the user searches by. The language toggle in the builder scopes the whole picker
+ lookup to one language (bare codes like `SV10` collide across the EN and JP namespaces).

- **Baked set index:** `scripts/build-pokemon-intl-sets.mjs` → `data/pokemon-intl-sets.json`
  (`{ ja:[…], "zh-cn":[…], "zh-tw":[…], ko:[…] }`; per set `{code, tcgdexId, name_native, name_en?,
  serie, releaseDate, cardCount, enEquivalent?, seeded?}`). TCGdex's brief `/sets` list lacks
  serie/date, so the bake enriches per-set **incrementally** (reuses already-baked rows — first
  build ~400 fetches, daily refresh a handful) and merges a human-curated overlay
  `data/pokemon-intl-seed.json` (English names + nullable N:1 `enEquivalent` + injection of
  not-yet-ingested sets like `M5` Abyss Eye). Codes are UPPERCASE-normalised (TCGdex casing is
  inconsistent: `csm1a` vs `CSV4C`). The builder loads the file client-side
  (`fetch('/data/pokemon-intl-sets.json')`, cached under `localStorage` `pkm_intl_sets_v1`). Wired
  into the daily `lib/refresh.mjs` bake (`pokemon-intl`), which also picks up sets TCGdex ingests
  after a physical release.
- **Source selection is the SERVER's, and it is a CHAIN, not a choice.** `GET /api/catalog/cards`
  builds an ordered list of sources for the set (`cardSourceChain`, `lib/catalog.mjs`) and walks it
  until one returns cards: **EN** = pokemontcg.io → PriceCharting (a pre-release set graduates by
  itself the moment pokemontcg.io answers); **intl** = TCGdex → PriceCharting. A step that THROWS
  does not end the walk — a 404 for a set an upstream never ingested means "not here", not "this set
  is broken". Clients send `tcgdexId`/`pcSlug` as **capabilities**, never as a directive; a legacy
  `src=` parameter is accepted and ignored.

  This is load-bearing, and it was learned the hard way. Until 2026-08-23 the branches were mutually
  exclusive and `lib/stock-games.mjs` stamped `src=indexed` on every intl set that had a code — so
  the PriceCharting branch was unreachable from the stock tools. **M6 Storm Emeralda** (JP, released
  2026-07-31) was in the index with a working `pcSlug` and 113 cards on PriceCharting, and the Batch
  Runner answered *"Could not load this set: no cards returned"* for three weeks while catalog.html
  — which happened to send a different `src` — rendered the same set fine. `?refresh=1` is honoured
  here too (it silently was not, so the ↻ button could not clear a bad 24h cache).
- **A `name_en` is what attaches a console — and for many sets it is the ONLY thing that will.**
  `mergePcConsoles` matches a JP/KO console by slugifying `name_en`, so a set with no English name
  gets no `pcSlug`. That matters more than it sounds: TCGdex lists a large number of Japanese sets
  with a card count but ships an **empty `cards` array** for them, so with no console attached they
  resolve to nothing. The console meanwhile gets added separately as a code-less `pcOnly` stub, and
  the catalogue ends up holding the same physical set twice — `S4A` with the printed code and zero
  cards, `Shiny Star V` with 335 cards and no code. Reconciled 2026-08-23 for `ja` (121 sets joined
  through Bulbapedia's Japanese-name → English-name mapping, every console fetched and checked
  first); `ko` and `zh-cn` still carry it. Seed `pcSlug` explicitly whenever the console is absent
  from PriceCharting's directory index — over half of the ones found were.
- **A seeded set carries NO `tcgdexId`.** The seed-inject branch runs precisely because TCGdex's
  brief list lacks that code, so defaulting the id to the printed code (which it used to do)
  fabricates an id guaranteed to 404 and makes "has a tcgdexId" a lie. Pinning a real one in the
  seed still works. `test/invariants/pokemon-set-reachability.test.mjs` walks the real baked index
  and fails if any set is unreachable, or if a seeded set carries an unpinned id.
- **Set search:** the picker matches the UPPERCASE printed **code** OR `name_native` OR `name_en`
  OR `enEquivalent.name`, so `M5`, `アビスアイ`, `Abyss Eye`, and `Pitch Black` all resolve M5.
  **Code/symbol search is complete for every set** (id = printed code); **English-name search is
  complete for curated sets** and falls back to native-name search for the long tail.
- **Card + image = PriceCharting console (PRIMARY), TCGdex (fallback).** TCGdex is missing the
  newest JP sets (`M5` Abyss Eye) and almost all CN/KO **card** data, so card lookup + images now
  come from **PriceCharting** (which we already scrape, browser-headers bypass its Cloudflare block):
  - Every set maps to a PriceCharting **console** (`pokemon-{japanese|chinese|korean}-{slug}`). The
    bake fetches the console directory (`GET /category/pokemon-cards` → `listPokemonConsoles`) and
    attaches a **`pcSlug`** to each set: JP/KO consoles are slugged by ENGLISH set name
    (`pokemon-japanese-abyss-eye`), CN consoles by the printed CODE (`pokemon-chinese-csv4c`). Every
    unmatched console is also **added as its own set** so all PriceCharting-covered sets are lookupable
    (JP ~107, CN ~16; KO is sparse on PriceCharting — ~4).
  - Card lookup: `GET /api/pc/console?slug=<pcSlug>` → `enumerateConsole` returns the whole set as
    `[{number, name(ENGLISH), image, url}]` in one cached fetch; the builder matches the typed number
    → English card name + a **1600px image** (`storage.googleapis.com/images.pricecharting.com/<hash>/1600.jpg`;
    `/320.jpg` for display) + the graded/raw price ladder via `GET /api/pc/lookup?url=<card url>`.
  - The console directory is a **curated, incomplete, churning index** — not a catalogue. Measured
    2026-08-23: six JP consoles left it and four arrived in a single day, while the departed
    consoles' own pages still worked. So `listPokemonConsoles` THROWS rather than returning empty
    buckets when it cannot read the page (an empty directory is never a fact, and the bakes used to
    treat it as one and report success), rejects only a >40% *collapse* as a bad render, and the
    bake **always carries the previous index's `pcSlug`/`pcOnly` forward into any gap the merge
    left** (`restorePcFromPrior`). Without that, records rebuilt from the TCGdex brief list — which
    knows nothing about PriceCharting — silently drop the card source for ~117 JP sets.
  - **Fallback:** sets without a `pcSlug` (older JP, all `zh-tw`) use TCGdex
    `GET /api/tcgdex/{lang}/cards/{code}-{localId}` (zero-padded id; image base + `/high.webp`). A
    total miss degrades to manual entry (comps still work).
  - PriceCharting rows carry English name + number + image but **not rarity/stage/type** — those
    fields are left for the user. CN sets display the printed code as the set name (no English CN
    set-name source); JP/KO show the English set name.
  - **Caching (TTL'd, rate-limit resilient):** every cache has a time-to-live so changes are picked
    up automatically. PriceCharting scrape results persist to disk (`data/pc-cache/`) *and* memory:
    price ladders **12h** (PriceCharting updates ~daily), console card lists **12h**, the console
    directory **24h**. Past-TTL triggers a refresh *attempt* — but if PriceCharting is **blocking**,
    the **stale copy is served** rather than failing (the 1s-throttle + 5-min 403/429 breaker still
    gate live fetches). Card images cache to disk via the `/api/img` proxy (`data/img-cache/`, keyed
    by URL hash, **30d** TTL — images are near-immutable, and a changed image normally gets a new
    hash-URL picked up by the 12h console refresh); the builder routes JP/CN/KO display + download
    through it, so images serve from our own server after first fetch. Both cache dirs are git-ignored.
  - **Two safety guarantees:** (1) a cached entry is **only overwritten when a fresh fetch returns
    valid data** — a failed/empty/blocked refresh (or a non-`image/*` response) never clobbers the
    good copy; (2) whenever a **past-TTL cached (stale) copy is served** because the live source was
    unreachable, the builder shows it explicitly — an amber `⚠ CACHED (may be out of date)` status +
    a banner in the card panel (`renderExtras` `data.stale`), for both card data and prices. Fresh
    (within-TTL) data shows no banner.
- **English OUTPUT (never native script):** the listing (card name, set, title, description, pitch)
  is always English. Set = `name_en` / `enEquivalent.name` / printed code. Card name = English
  species + the Latin suffix printed on the card (`ex`/`V`/`VMAX`), resolved via
  `data/pokemon-dex-en.json` (`scripts/build-pokemon-dex.mjs`, PokéAPI GraphQL, standalone bake) —
  which maps **both** the card's `dexId` **and** the native species name (the high-value ex/full-art
  cards OMIT `dexId`, so `リザードンex` → `Charizard ex` via the native `ja`/`ko`/`zh-cn`/`zh-tw`
  species map). Trainers/Energy with no English source leave the name blank for manual entry.
  The DESCRIPTION additionally carries native metadata rows for search/provenance — `{Language} name`
  (native card name), `{Language} set` (native set name), and `English set` (the `enEquivalent`
  release) — threaded via `_intlMeta` into the mirrored `buildHTML`/`buildDescription` (rendered only
  when present, so English cards and the bulk tool are unaffected; parity harness stays byte-identical).
- **Language-aware eBay comps:** `findEbay` appends the language word (`Japanese`/`Chinese`/`Korean`;
  never `English`) + the native printed code to the query and passes `lang`; `TCG.classifyLang(title)`
  (extras.js) then keeps only rows whose title language matches (kana ⇒ JP-certain, hangul ⇒ KO,
  bare Han ⇒ JP; JP/CN/KO modes also keep bilingual English-titled listings, drop confirmed-other).
- **Pricing:** pokemontcg.io TCGplayer/Cardmarket prices are English-market and **wrong** for
  JP/CN/KO, so they are **suppressed** for non-EN; eBay AU comps are the primary signal. As a
  **native-market reference** (JP only), the panel always shows a PriceCharting "Pokemon Japanese"
  console link, and attempts an inline scrape via `/api/pc/lookup?…&lang=jp` (see below).
- **Scope:** listing-builder only. JP/CN/KO cards are **not** written to the tracker/inventory/bulk
  pipeline (which key on pokemontcg.io ids) — `identity_key` is left blank so those actions are gated.

## Pokémon KO + ZH-CN — the two lanes nothing else covers

Measured 2026-08-23. **TCGdex indexes the Korean and Simplified-Chinese sets but serves no cards for
either**: `/v2/{ko|zh-cn}/sets/<id>` answers 200 with `cardCount.official` populated and an EMPTY
`cards[]`, and `/v2/{lang}/cards/<id>-<n>` is a flat 404. PriceCharting's directory carries **5
Korean consoles for 100 Korean sets and 22 Chinese for 66**. So ~90 Korean and ~35 Chinese sets were
pickable in the stock tools with nothing behind them. Each lane gets one last chain step, always
LAST so a genuine Korean/Chinese console still wins.

### `ko` → the Japanese twin (`fetchTwinCards`, lib/catalog.mjs)

Korean releases are the Japanese line reprinted under the **same set code** — 98% of Korean codes
exist in `ja`. Verified rather than assumed, by diffing the three sets PriceCharting happens to carry
in both languages: **M5 matched 118/118** on number+name, S6A 101/105, SV8A 237/239. So names and
numbers transfer.

**Images do not, and are stripped at the source** (`stripTwinImages`). PriceCharting does not scan
Korean cards — its Korean consoles are largely imageless — so the only picture available is the
Japanese print, and a Korean listing carrying a Japanese scan shows the buyer a card they will not
receive. For the same reason the derived rows carry **no `native_name`**: reconstructing a Korean
name from the dex (`nativeInfo`) would be inventing text that is on no card, so `NO_NATIVE_SOURCES`
in lib/stock-games.mjs suppresses it. Korean can only ever be as good as Japanese — a Korean set
whose Japanese twin has no console still has none.

### `zh-cn` → 52poke (`lib/wiki52poke.mjs`)

Chinese sets are **not** the Japanese line — only 12% share a code, and the A/B/C sub-sets are
CN-exclusive — so the twin trick cannot work and a real source was needed. 52poke (神奇宝贝百科) is a
MediaWiki, so its card lists are machine-readable wikitext rather than rendered HTML:

```
{{卡牌列表/entryjp|001/125|{{C|妙蛙花V|SEF}}|草||RR|}}     Pokémon — {{C|name|jp-origin-set}}
{{卡牌列表/entryjp|119/125|{{TCG|夏科娅}}|支援者卡||U|}}    Trainer/Energy — {{TCG|name}}
```

Parse notes that cost time: the API **403s without a descriptive User-Agent**; the page title is
`<native name>（TCG）` with full-width parens (search is the fallback); and the NAME cell is itself a
template, so a regex splitting on `|` reads the pipes inside `{{C|妙蛙花V|SEF}}` as separators and
hands back the string `"C"` as every Pokémon's name — hence the brace-depth `splitCells`.

Names arrive Chinese and go out English through the existing `englishCardName` with the `zh-cn`
species map already in `data/pokemon-dex-en.json` (1025 entries) — **~76% of a set**. The rest are
Trainers and Energy, which have no species to resolve and keep their native name, exactly as the
Japanese lane already does. 52poke carries no per-card prices or images. Title resolution is live per
request, so a set 52poke has not documented yet **heals itself** once it does, with no code change.

Result: Korean gaps 92 → 20, Chinese 35 → 7. What remains is bounded and explained — the Korean
`CS*` block mirrors the Japanese TCGdex name collision, four Korean sets have a twin with no console
of its own, and the seven Chinese ones are the newest Mega-era sets 52poke has yet to write up.
`zh-tw` has no PriceCharting bucket at all and no equivalent wiki, so its 15 stay open.

## Japanese card-art repair (`data/pokemon-jp-art.json`, bake `pokemon-jp-art`)

PriceCharting sometimes carries a card's **illustration crop** instead of the card scan. Measured
2026-08-23: **M6 Storm Emeralda 12 of 113**, M5 Abyss Eye 3 of 118, S6A Eevee Heroes 3 of 101, M4
Ninja Spinner 0 of 120 — worst on the newest set, so they do appear to backfill, but the residue
persists for years. That crop goes to eBay as the product photo, which is the same defect class as
the One Piece SAMPLE watermark and gets the same answer: **the wrong product picture is worse than an
ugly one.** Serebii has a proper full-card scan at a derivable URL (`/card/<englishname>/<num>.jpg`,
number unpadded), and the swap happens through `catalogArtFor` — the one hook every surface already
goes through.

**The detection is a comparison, never a threshold**, and three separate real-world traps are why:

1. **Genuinely wide cards exist.** Storm Emeralda introduced *paired Stadium* cards (#71-#76), where
   two cards form one artwork. "Not portrait therefore broken" would flag them.
2. **Serebii's own scan is sometimes the JOINED PAIR** — #73 Legendary Summit measures 1736×1212,
   exactly two 868×1212 cards side by side, while PriceCharting has the correct *single* card there.
   Substituting would put a two-card photo on a one-card listing, worse than the crop being fixed.
   So a swap requires Serebii's image to itself be a single card.
3. **The swap is BY NUMBER**, so nothing but the card name stands between it and another card's
   picture if the two catalogues number a set differently. Per-card name matching over-rejects — the
   two translate Japanese Trainers differently ("Delicious Onigiri" / "Yummy Onigiri", "Adventuring
   Lantern" / "Adventure Lantern", "Fossil Excavation Site" / "Fossil Quarry"). So alignment is
   proven **set-wide** (M6 agrees on 104/113 names, M5 on 105/118) and only then is the number
   trusted. Below 85%, or under 10 shared cards, nothing in that set is swapped.

The aspect window (0.55–0.85) is measured, not guessed: PriceCharting pads some legitimate single
cards to 0.809 (M6 #72) and its wrong images start at 0.887 (M6 #105, against Serebii's 0.717).

The bake is **accretive and capped**: a verdict never changes once measured, so the store is keyed by
set+number and a measured card is never re-fetched — the first pass over ~21,800 Japanese cards is
long, every pass after it is just the newest set. Serebii's roster is read once per SET (its index
page carries number → name for the whole set), not once per card. Deferrals are logged.

## Pokémon set-coverage watchdog (`data/pokemon-coverage.json`, bake `pokemon-coverage`)

Everything else in this file can tell you a **file** is stale. Nothing could tell you a **set** was
missing — there was no expected-set list, no diff, and no check that a set in the index resolves to
anything. That is the gap M6 Storm Emeralda fell through: `catalogStatus()` reported the JP index as
fresh (it was — it was rebuilt every six hours, correctly, with M6 in it) while the set could not be
loaded. Freshness and correctness are different questions.

`checkPokemonCoverage` (`lib/catalog.mjs`) resolves sets through **the same `cardSourceChain` the
stock tools use** and records what came back, per set, to `data/pokemon-coverage.json`.

- **Ranked, capped, and honest about it.** Proving all ~700 sets every cycle would be a stampede
  against a keyless scraper we are a guest of. Ranks: `0` no lookup route at all (free — no request
  needed), `1` released in the last 120 days, `2` was a gap last run (did it heal?), `3` never
  checked, `4` proven good but longer ago than 14 days. Rank 0 never spends budget. The top 250 run;
  the rest are **deferred, returned, and logged** — a bounded run must never read as "all clear".
  Verdicts not revisited are carried forward, so the picture stays complete rather than shrinking to
  whatever ran last.
- **EN earns a check only when it is new, pre-release, or already failing.** EN's set list and EN's
  card data come from the same upstream, so re-proving Base Set discovers nothing and just
  rate-limits us out of the API we depend on.
- **"No cards" and "could not ask" are different facts** (`classifyCoverage`). A 4xx-that-answered or
  an empty HTTP 200 is a `gap`; a 5xx/429/dead socket is `unavailable` and never counts as a gap —
  and never overwrites a verdict already earned (GR7). This is not theoretical: the first live run,
  2026-08-23, drew **108 HTTP 500/502s from pokemontcg.io in one pass** (confirmed by probing the
  host directly, outside our code). Without the distinction the watchdog's debut would have been an
  alert declaring 108 sets unlistable.
- **Telegram fires on NEW gaps only.** The long tail of genuinely source-less old sets (the JP era
  promo pools, the `CS*` block) is real and lives in the Settings panel; re-pushing it every six
  hours would train the alert to be ignored, which is the same as not having one.
- Surfaced in **settings.html** ("Set coverage" — the one baked-data card that can be red while
  perfectly fresh) and in **catalog.html** (a `no cards` badge and a "No cards" filter chip).

## PriceCharting — graded/raw/pop (Pokémon)  (proxy `/api/pc`, keyless scrape)

Fills the one gap no other source covers: **graded** prices (Grade 9 / PSA 10 / BGS 10), an
eBay-sold-based **raw anchor**, and **PSA/CGC population** counts. There is **no free API**, so
`lib/pricecharting.mjs` parses the **public** pages server-side (the browser can't — CORS +
Cloudflare bot-block; a Node fetch with browser headers passes where the browser/WebFetch get 403).
Display-only — it does **not** change the tracked price, so `lib/normalize.mjs` is untouched.

- Endpoint (this tool): `GET /api/pc/lookup?name=&number=&set=&id=[&lang=jp]` → `{ matched, url,
  confidence, productName, consoleName, prices:{ungraded, grade9, psa10, bgs10}, pop:{ "<grade>":{psa,cgc,total} } }`.
  **`lang=jp`** biases the search to the **"Pokemon Japanese"** console, caps confidence at `medium`
  (JP coverage is sparse/fuzzier), and — since a JP set and its EN equivalent share collector numbers
  — **rejects any match whose console isn't Japanese** (never shows the English same-number card).
  A full `ladder:{ "<label>":cents }` map (e.g. `Grade 8`, `PSA 10`, `BGS 9.5`) is also returned —
  the inventory valuation (`/api/inventory/items/:id/refresh-value`) maps it to a slab's company+grade rung.
  **Prices are integer cents** (Golden Rule 3); the Pokémon builder divides by 100 for its USD rows.
  Any failure / no-match / block returns `{matched:false}` and never throws (Golden Rule 7).
- **Matching** (`pickBestMatch`, load-bearing): a PriceCharting product is accepted only when the
  product-name carries the **exact collector number** (`#<n>`) **and** the card name matches; the
  console-name is then resolved to the pokemontcg.io set name (fuzzy, `&`→`and`, strips
  `pokemon`/`set`). `high` confidence = set also resolved; `medium` = unique name+number match
  without a textual set match. The builder shows a **"Verify match on PriceCharting"** link because
  matching across the two taxonomies is fuzzy (correctness > cleverness).
- **Search quirk:** `/search-products?q=<name> <number>&type=prices` **302-redirects straight to the
  card page** on a strong single match (e.g. `charizard ex 199`), and only serves a `#games_table`
  results page when ambiguous (e.g. `pikachu 58`). The module handles both (and reuses the
  redirect-fetched HTML — no second request).
- **DOM contract** (verified 2026-06; re-confirm if parsing returns `matched:false` everywhere):
  - Card page `/game/<console>/<product>` — prices from `<div id="full-prices">`: rows
    `<tr><td>LABEL</td><td class="price js-price">$X</td></tr>` (labels `Ungraded`, `Grade 9`,
    `PSA 10`, `BGS 10`, …). Heading `Full Price Guide: <name> (<console>)` gives product/console name.
  - Pop page `/pop/item/<same-slug>` (derived from the card URL `/game/`→`/pop/item/`) —
    `<table id="population-table">` rows `grade-col / psa-col / cgc-col / total-col` (`-` = none).
  - Search `<table id="games_table">` rows `<tr id="product-<id>" data-product>` → title `<a>` href
    `/game/<console>/<product>`, product name, and `<td class="console">` set name.
- **Caching / politeness / throttle:** full result cached ~12h + the resolved slug per pokemontcg.io
  id (≤~2 fetches/card/day). A single **serialized gate** spaces *every* outbound request (≥1s +
  jitter) both within a lookup (search→card→pop) and across rapid/concurrent lookups; a **403/429
  trips a 5-min circuit breaker** so we never hammer a Cloudflare block. Being **interactive-only**
  (not in the collector) keeps volume human-paced — see the warning below before collector-izing it.
- **Do NOT add to the price collector without keeping the throttle.** Wired into the 24h collector
  (`lib/collector.mjs`), this would batch-scrape Cloudflare for every watched card — exactly the
  pattern bot-protection flags. The gate/breaker above make it *possible* later, but only at a low
  cadence; today it is display-only and deliberately not in `normalize.mjs`/the collector.
- **Auth:** none (keyless). `PRICECHARTING_ENABLED=false` disables it. If `PRICECHARTING_TOKEN` is
  set (paid Retailer tier), the module uses the official API (`/api/products`, `/api/product`)
  instead of scraping — same output shape (that branch is **unverified** until a token exists).
- **ToS:** `robots.txt` allows `/game` and `/search-products`. Fine for this **private, single-user**
  tool; redistribution / public hosting would need PriceCharting's written permission (→ buy the API).

## Cert lookup — multi-company graded-slab verify  (proxy `/api/cert`)

Backs the graded-card inventory add form (`inventory.html`). Given a slab's grading company +
cert number, tries to auto-fill the card identity + grade.

- `GET /api/cert?company=<CODE>&cert=<n>` → `{ matched, company, verifyUrl,
  identity:{name,set_name,number,year,variant,language}, grade, grade_label, grading_company,
  cert_number, image_url, raw }` on a hit; else `{ matched:false, company, verifyUrl, manual:true,
  reason }`. Routed by `lib/certlookup.mjs`; never throws (Golden Rule 7).
- `GET /api/cert/providers` → the `data/grading-companies.json` registry (drives the company
  dropdown + the mini-slab badge themes). **12 companies:** PSA, BGS, CGC, SGC, TAG, ARK (AU),
  TCG Grading (AU), CGA / Card Grading Australia (AU), PCG (Western Premier Card Grading, AU/US),
  PCGCN (Chinese PCG, `pcgcard.cn`), EMC (Encapsulated Memories Company), JBH (Joyful Box House,
  CN). Each carries `code/label/scale/step/subgrades/certFormat/certUrl/lookup/region/note` + a
  `theme{bg,fg,accent}`.
- **Auth / providers:** **PSA is the only company with a public cert API** (see below). Every
  other company has no public JSON API, so `/api/cert` returns `matched:false` + a `verifyUrl`
  deep-link to that company's official verify page (cert pre-filled where the URL format is known,
  e.g. TAG `tagd.co/{cert}`, PCGCN's QR page) and the form degrades to **manual entry**
  (Golden Rule 7). This registry is **broader** than the pre-grader's tolerance set in
  `data/grading.config.json` (PSA/BGS/CGC/SGC/TAG) — you can own a slab from any company, but only
  those with known tolerances get a predicted grade.

### PSA — cert API  (`lib/psa.mjs`)
- Upstream `https://api.psacard.com/publicapi`: `GET /cert/GetByCertNumber/{cert}` (card + grade)
  and `GET /cert/GetImagesByCertNumber/{cert}` (best-effort front slab image). **Auth:**
  `Authorization: Bearer <PSA_API_TOKEN>` (optional `.env` var; server-side only). Missing token /
  any failure → `{matched:false}` (degrades to manual). **Field mapping is UNVERIFIED against a
  live token** — confirm `PSACert.{Subject,Brand,CardNumber,Year,Variety,CardGrade,
  GradeDescription,Category}` once a token exists.

## Magic: The Gathering — Scryfall  (proxy `/api/mtg`)

- Upstream: `https://api.scryfall.com`
- Card: `GET /cards/{set}/{collector_number}` (e.g. `/cards/blb/1`).
- Sets: `GET /sets` → `{ data: [...] }` (filter `digital`, sort by `released_at`).
- **Auth:** none. Scryfall asks for a `User-Agent` + `Accept` header — the proxy
  adds them. Returns the card object directly (not wrapped); errors are
  `{ object: "error", ... }`.
- Card fields used: `name`, `set`, `set_name`, `collector_number`, `rarity`,
  `colors[]`, `type_line`, `finishes[]` (nonfoil/foil/etched), `frame_effects[]`
  + `border_color` + `full_art` (→ treatment: Showcase / Extended Art /
  Borderless / Full Art), `prices{ usd, usd_foil, usd_etched, eur }`,
  `image_uris{ large, normal, png }`, `card_faces[]` (double-faced → back image).
- **Image fallback (dotgg):** front image falls back to
  `https://static.dotgg.gg/magic/card/{c.set}-{c.collector_number}.webp` (e.g.
  `magic/card/neo-1`). Scryfall rarely misses, so this is cheap insurance. (SWU is
  NOT on dotgg, so the SWU builder has no such fallback.)

## Star Wars: Unlimited — swu-db  (proxy `/api/swu`)

- Card: `GET /cards/{set}/{number}` with the number **3-digit zero-padded**
  (e.g. `sor/010`).
- 7 released sets at build time: `sor, shd, twi, jtl, lof, sec, law`.
- **Auth:** none. swu-db returns `200` without CORS headers, hence the proxy.
- Fields used: `Name`, `Subtitle`, `Type`, `Aspects[]`, `Arenas[]`, `Traits[]`,
  `Cost`, `Power`, `HP`, `Rarity`, `VariantType`, `MarketPrice`/`LowPrice` (USD),
  `FrontArt`, `BackArt` + `DoubleSided` (leaders/back art).

## Disney Lorcana — Lorcast  (proxy `/api/lorcana`)

- Card: `GET /cards/{set}/{number}` by **set code + bare collector number** (NOT zero-padded —
  e.g. `1/207` → Elsa, Spirit of Winter). 404 on no match. Single bare card object (no `data` wrapper).
- Sets: `GET /sets` → `{ results: [{ id, code, name, released_at }] }`. `loadSets()` refreshes the
  set pills LIVE from this on page load (filtered to `released_at <= today`), so numbered sets AND
  promos (`P1`, `P2`, `P3`, `D23`, `DIS`, `C2`, `cp`) both appear automatically. The hard-coded `SETS`
  object (numbered `1`–`12` + the known promo codes) is only the offline/`/sets`-unreachable fallback.
- **Auth:** none (keyless). HTTPS only, ~10 req/s; **prices refresh once daily**.
- Fields used: `name`, `version`, `collector_number`, `rarity` (`Super_rare` → "Super Rare"),
  `ink`/`inks[]`, `type[]`, `classifications[]`, `cost`, `strength`, `willpower`, `lore`,
  `illustrators[]`, `layout`, `tcgplayer_id`,
  `image_uris.digital.{small,normal,large}` (**AVIF**), `prices.{usd, usd_foil}` (USD strings;
  `usd` is `null` for foil-only Enchanted/promo printings → builder auto-selects the Foil finish).
- **Graded ladder:** layered on via `pcEnrich` → `/api/pc/lookup` (the game-agnostic PriceCharting
  scraper) using `name + version`, `collector_number`, and the set name. eBay AUD comps as usual.

### The counted vocabulary (3,192 cards across all 22 sets, 2026-08-14)

Counted, not assumed — the same way Magic's finish ladder was written. Re-run the count before
changing any finish, rarity or aspect rule here.

**Rarity (9 values).** `Common` 943 · `Uncommon` 704 · `Rare` 630 · `Super_rare` 238 ·
`Enchanted` 224 · `Promo` 193 · `Legendary` 160 · `Epic` 90 · `Iconic` 10.

**`prices` shape × rarity — this is the finish axis.** Enchanted, Epic and Iconic are
**foil-only**: across all 324 of them, not one carries a `usd` price. Everything else is
overwhelmingly `usd` + `usd_foil` together, with a handful of one-sided stragglers.

| rarity | both | usd only | foil only | neither |
|---|---|---|---|---|
| Common | 927 | 13 | 3 | 0 |
| Uncommon | 692 | 10 | 2 | 0 |
| Rare | 625 | 2 | 3 | 0 |
| Super_rare | 235 | 1 | 2 | 0 |
| Legendary | 155 | 1 | 4 | 0 |
| **Enchanted** | **0** | **0** | **223** | 1 |
| **Epic** | **0** | **0** | **89** | 1 |
| **Iconic** | **0** | **0** | **10** | 0 |
| Promo | 6 | 12 | 109 | 66 |

`Promo` is the one genuinely mixed rarity and **must not** be treated as foil-only: 12 are non-foil
and 66 carry no price at all (those list with a manual price, GR7). The printing matrix is therefore
driven by the PRICE KEYS, with the special rarity naming the foil row — never by rarity alone.

**Collector numbers do not discriminate.** Epic occupies 205–225, Iconic 241–245, but Enchanted
spans 24–243 and overlaps the base run. Rarity is the only reliable signal.

**Ink — read BOTH fields.** `ink` (string) and `inks[]` (array) are inconsistently populated:
*Jolly Roger* has `ink:null, inks:["Ruby"]` while *Never Land* has `ink:"Amber", inks:null`. Reading
either alone loses 160 cards. `inks[] || [ink]` covers all 3,192. **187 cards are dual-ink**
(`Amethyst+Sapphire`), concentrated in the promo sets.

**Card type — 174 cards carry two.** Always `Action+Song`, so the aspect needs a priority the way
`MTG_TYPE_PRIORITY` does. Values: `Character` 2453 · `Action` 406 · `Item` 227 · `Song` 174 ·
`Location` 106.

**`name` never contains `" - "`** (0 of 3192). Lorcast keeps `name` (`Elsa`) and `version`
(`Spirit of Winter`) separate; the builder joins them. So the eBay **Character** aspect is `name`
verbatim — no splitting. 633 cards have no `version` (mostly Actions, Items and Songs).

**`illustrators[]` is always exactly one** entry. **`layout: 'landscape'`** is 106 cards and maps
1:1 onto type `Location` — same image URLs, just wider than tall.

**Cold foil is not in the data.** TCGplayer sells Normal / Cold Foil / Holofoil, but no keyless
source labels cold foil per card. It is an operator-chosen finish priced `null` (the surge-foil
precedent), never derived.

## Riftbound — three sources (default keyless)

The builder picks a `source` at runtime: **offline** (default) → **riftscribe** → **scrydex**.
Coverage of every released set is keyless; Scrydex is an optional trend-graph upgrade. An eBay AUD
comps overlay works under any source.

**There is no hardcoded set list.** Codes, display names, printed totals and release order all come
from Riot's own gallery roster and land in `data/riftbound.json`; the builder's pills (offline AND
riftscribe lanes), the bulk enumerator and the TCGplayer price join all read from there. A new set
therefore appears by itself on the next refresh, and `lib/refresh.mjs` Telegram-alerts when it does.

### 1. Offline baked — `data/riftbound.json` (default; no proxy, same-origin static)
- Built by `scripts/build-riftbound-data.mjs` from the **official LoL card gallery** (keyless):
  scrape `"buildId"` from `https://riftbound.leagueoflegends.com/en-us/card-gallery/`, then
  `GET /_next/data/{buildId}/en-us/card-gallery.json`. The buildId rotates per Riot deploy, so the
  script re-scrapes it each run. **Build-time only** — no runtime proxy.
- ~1164 cards across every released set, with images (Riot CDN `cmsassets.rgpub.io`) and
  energy/might/power stats (which Scrydex does NOT carry). No prices.
- The gallery also ships a **set roster** beside the cards — `[{id, name, collectorNumberMax}]` in
  release order, where `collectorNumberMax` is the printed set total. `findSets()` locates it
  structurally (it lives under `page.blades[N]` and N moves between deploys) and it drives the set
  ordering, the display names and the per-set `total`. If Riot ever drops it, the bake falls back to
  the per-card `/TOTAL` denominators and first-seen order rather than failing (GR7).
- **Image fallback (dotgg):** every Riftbound lookup (offline / riftscribe / Scrydex) falls back to
  `https://static.dotgg.gg/riftbound/cards/{SET}-{NNN}{suffix}.webp` via `rbDotgg()` — primary when the
  source has no image, `onerror` swap when its image breaks. (Runes go further — dotgg is the *primary*,
  since cmsassets only has the Origins printing; see Runes below.)
- Shape: `{ [setCodeLower]: { name, code, total, cards:[{ k, num, name, rarity, type, domain, e, p, m, img }] } }`.
  `k` mirrors `normNum` (leading zeros stripped, trailing letter/`*` kept; `SP1/006` → `sp1`).
  `num` is the printed number VERBATIM (GR5), uppercase for `SP`.
- The bake runs on the refresh timer (`lib/refresh.mjs`), so a manual re-run is only needed when you
  want a new set immediately: `node scripts/build-riftbound-data.mjs`.

#### Variant derivation (why the printed number, not the source's rarity)

The source rarity field is **unreliable for exactly the premium printings**. Riot's gallery calls
`UNL-220/219` "Pouty Poro" a *common* — TCGplayer sells it as a Showcase at US$175 — and
`VEN-167/166` "Vi, Destructive" a *rare* (Showcase, US$125). The printed number is reliable, and
TCGplayer's own product names confirm the mapping, so the bake derives the treatment and encodes it
in the card name the same way alt-art already was. The builder, `lib/riftbound-data.mjs` and every
bulk consumer read that one suffix, so all of them are correct with no duplicated rule.

| Printed number | Name suffix | Rarity | Finish | TCGplayer says |
|---|---|---|---|---|
| `299*` of 298 | `(Signature)` | Showcase | Foil | "…(Signature)", US$2,739 |
| `162a` of 298 | `(Alternate Art)` | Showcase | Foil | "…(Alternate Art)" |
| `167` of 166 | `(Overnumbered)` | Showcase | Foil | "…(Overnumbered)", US$125 |
| `SP1` of 006 | *(none)* | Showcase | Foil | untagged, rarity `Showcase` |

**Order matters:** every `*` card is *also* over the set total (12/12 in each of OGN/SFD/UNL), so `*`
is tested first — otherwise all 36 Signatures relabel as Overnumbered. No alt-art card is ever over
the total.

**`TREATMENT_OVERRIDE`** (in the same script) wins over all of it, for the one treatment no number
can imply: `UNL-238` Baron Nashor is `(Ultimate)`, ~US$1,635 and roughly 3x the set's Signatures,
where the derivation alone would call it Overnumbered. Riot's gallery gives it nothing to go on
(epic / unit / portrait, identical to its neighbours). The hardcode is fenced — keyed by identity,
no Signature sibling to collide with (UNL stars stop at `237*`), and
`test/data/riftbound-variants.test.mjs` re-checks every derived label AND every override entry
against TCGplayer's own product names on each run, so a stale or wrong row fails loudly instead of
quietly shipping. Only add to that map when the printed number genuinely cannot imply the treatment.

#### Special showcase promos (`SP##`)

Vendetta introduced a six-card showcase subset numbered `SP1/006`…`SP6/006`. They were invisible
before: the bake's publicCode regex rejected them and the price bake dropped them into
`dropped.special`. They now bake as ordinary cards keyed `sp1`…`sp6`, priced under `VEN-sp1` etc.
Two things to know:
- The `/006` is the size of the SP subset, **not** the set — the bake never takes it as a set total.
- The dotgg CDN keys them **uppercase** (`VEN-SP1.webp` is 200, `VEN-sp1.webp` 404s), so `rbDotgg()`
  uppercases an alpha prefix. `normNum` also strips SP zero-padding, so `SP1`/`sp1`/`SP01` are one
  identity key rather than three.

### 2. Riftscribe — `/api/rbs` → `riftscribe.gg/api` (keyless live)
- `GET /api/rbs/cards?limit=200&offset=N` (limit caps at 200; `X-Total-Count` header gives the total —
  the builder pages through and buckets by `set_id`; there is no `/sets` endpoint).
- Card: `{ id, name, set_id, collector_number, variant ('' | 'a' | 'star' | 't0n'), rarity, faction,
  type, stats{energy,might,power}, image, image_thumb{small,medium,large} }`. No prices. Single
  `faction` only — multi-domain cards may show one domain (the offline bake preserves both).
- Community-hosted, no SLA — offline is the default, so riftscribe being down never blocks the tool.

### 3. Scrydex — `/api/rb` → `api.scrydex.com/riftbound/v1` (OPTIONAL, key)
- Card: `GET /cards/{EXP-NUM}` (e.g. `OGN-296`); expansions: `GET /expansions`. **Auth:**
  `X-Api-Key` + `X-Team-ID` injected from `.env`.
- Card fields used: `id`, `name`, `number`, `printed_number`, `domain`, `type`, `rarity`,
  `images[]{small,medium,large}`, `expansion{name,code}`, `variants[]{ name (normal|foil),
  prices[]{ condition (NM…), market, currency, trends{ days_1,7,30,90 { price_change, percent_change } } } }`.
- The ONLY source with prices + the reconstructed price-trend graph. Now opt-in (connect in the UI).

### Pricing — eBay comps, delivered totals (`findRBComps`, via `/api/ebay`)
- Source-agnostic overlay, button-triggered (quota), rendered into `#ebayextras` (never touches the
  Scrydex trend graph in `#extras`).
- **Sold where possible:** tries `GET /buy/marketplace_insights/v1_beta/item_sales/search` first (true
  SOLD prices). That API needs the `buy.marketplace.insights` scope, which eBay grants only to approved
  apps — `vite.config.js` mints it on a **separate, isolated token** (`ebayInsightsToken`) so a denial
  can't break the basic Browse token. If denied (our keys return `invalid_scope`), the proxy returns a
  soft 403 and the client falls back to **ASKING** via `GET /buy/browse/v1/item_summary/search`, clearly
  labelled. If the app is later approved for Insights, sold lights up with no code change.
- **Query:** `Riftbound <base/champion name, subtitle stripped> <set NAME>` — NOT the collector number
  or set CODE (eBay titles rarely include `001`/`OGN`, which returned 0 hits).
- **Delivered totals:** each comp = item price + `shippingOptions[0].shippingCost.value`. Listings with
  calculated/unknown shipping are excluded from totals (and counted). Results split into 🇦🇺 Australia
  (`itemLocation.country === 'AU'`) vs 🌏 Worldwide, each showing cheapest + median delivered, plus the
  cheapest-delivered listing and an "undercut" target (list free-shipping under it to be cheapest). All
  AUD (EBAY_AU marketplace).

### Name handling (all sources)
- A card's `name` may include the subtitle (`"Kai'Sa - Survivor"`). Alt-art appends `"(Alternate Art)"`,
  Overnumbered `"(Overnumbered)"`, Signature `"(Signature)"`; the builder strips these for the clean
  name field and re-derives the variant + the `(Alt Art)`/`(Overnumbered)`/`(Signature)` title tag.
  Signature and Overnumbered carry a raised title priority so the fitter can never shed them.
- ⚠️ Riot writes `"Kai'Sa, Survivor"` (comma) where TCGplayer writes `"Kai'Sa - Survivor"` (dash), and
  `championTag()` splits on `" - "` — so the offline lane produces no champion tag. Known gap, left
  as-is because changing it would rewrite tags on every existing Riftbound row.

### The keyless price index — `data/riftbound-prices.json`
- Built by `scripts/build-riftbound-prices.mjs` from TCGplayer's public search API (the Scrydex price
  lane died at `402 SUBSCRIPTION_INACTIVE`). Keyed by tracker `identity_key` (`SETCODE-normNum`), so
  `OGN-27a` is Origins #27 Alternate Art. Served at `/api/riftbound/prices/:key`.
- The TCGplayer `setName` → set-code join is **derived from `data/riftbound.json`**, not hardcoded:
  the names match for every set but one, so only `TCGP_SET_ALIAS` (`"Origins: Proving Grounds"` →
  `"Proving Grounds"`) is written down and a new set prices itself on the next bake. Promo sets are
  denied explicitly (their numbering collides with the main sets). A `SEED_BY_NAME` fallback covers
  the window where the gitignored catalog has not been baked yet — without it the join would be
  empty, nothing would index, and the bake would throw away the only price lane the tracker has.
- A TCGplayer set name that matches nothing lands in `dropped.unknownSet` and is **named in the bake
  summary** (visible in `/api/status` → `jobs.refresh`). That bucket is what "TCGplayer listed the set
  before Riot's gallery did" looks like; so is the converse, reported as `no products for <CODE>`.

### Runes (`R##` reprints)
- The 12 runes are reprinted in every set with an `R##` collector number (from Spiritforged onward;
  Origins used regular numbers). The **card-data** sources (gallery + riftscribe) catalogue runes only
  once, under OGN (`OGN-007/298` … `OGN-214/298`), so typing e.g. `R01a` matches nothing in the per-set
  data — but the per-set **art** does exist on dotgg's CDN.
- `runeFill()` (builder) resolves it: `R01..R06` → domain (R01 Fury, R02 Calm, R03 Mind, R04 Body,
  R05 Chaos, R06 Order — confirmed vs the OGN domain order). It pulls **card data** (name/domain/type)
  from the canonical OGN rune, but the **image** from the correct per-set printing at
  `https://static.dotgg.gg/riftbound/cards/{SET}-R##[a].webp` (e.g. `UNL-R01a.webp`) — the same
  predictable `{SET}-{number}.webp` CDN that powers riftbound.gg. Falls back to the OGN rune image
  (`onerror`) for sets with no R-rune (OGN/OGS). Displays the current set + the typed `R##`. Works in
  all three source modes (Scrydex tries its own lookup first, then falls back to this).


## FX rates — Frankfurter  (proxy `/api/fx`)

- `GET /latest?from=USD&to=AUD,EUR,GBP,JPY` → `{ rates: { AUD, ... }, date }`.
- ECB data, no key. Cached in memory per session by `TCG.loadFx()`. Used to show
  `≈ A$` next to USD/EUR prices and to power the converter widget.

---

> ⚠️ The LEGO / Funko / eBay sections below were compiled with web search
> **offline**, so endpoints, field names, and category IDs are from prior
> knowledge, **not** freshly verified. Confirm each against the provider's live
> docs/response before trusting it. The builders are written defensively (every
> field optional; manual entry always works) precisely because of this.

## LEGO — Rebrickable + Brickset + BrickLink

The LEGO builder looks a set up by **set number** (normalised to the `-1` variant
form, e.g. `75192-1`, since bare numbers 404 on Rebrickable/BrickLink).

### Rebrickable — core lookup  (proxy `/api/lego/rebrickable`)
- Upstream: `https://rebrickable.com/api/v3/lego`. Auth: header
  `Authorization: key <REBRICKABLE_API_KEY>` (self-service free key). Injected by
  the proxy; never reaches the browser.
- Set: `GET /sets/{set_num}/` → `name`, `year`, `theme_id`, `num_parts`,
  `set_img_url`. Theme name: `GET /themes/{theme_id}/`. Minifig **count** is not a
  field — sum `quantity` over `GET /sets/{set_num}/minifigs/`.
- No pricing, no age range, no dimensions (those come from Brickset).
- Rate limit ~1 req/s; a lookup makes ~3 calls (set + theme + minifigs).

### Brickset — enrichment  (proxy `/api/lego/brickset`)
- Upstream: `https://brickset.com/api/v3.asmx`. **Auth is a query PARAM**
  (`apiKey`), so the proxy appends it in `rewrite()`; the client sends an empty
  `userHash=`. Free key (may need manual approval).
- `GET /getSets?userHash=&params={"setNumber":"75192-1"}` → `{ sets: [...] }`.
  Used fields (**VERIFY LIVE — names drift**): `theme`, `subtheme`, `pieces`,
  `year`, `LEGOCom.{US,UK,...}.retailPrice` (RRP), `ageRange`/`ageMin`,
  `image.imageURL`. RRP is shown as a price line (converted to AUD via `/api/fx`).

### BrickLink — secondary-market pricing  (proxy `/api/lego/bricklink`)
- Upstream: `https://api.bricklink.com/api/store/v1`. **Auth: OAuth 1.0a HMAC-SHA1
  per-request signing** (consumer key/secret + token/secret) — implemented as a
  signing **middleware**, not a header proxy. The server's outbound **IP must be
  registered** in the BrickLink API console or calls 4xx.
- Price guide: `GET /items/SET/{no}/price?guide_type=sold&new_or_used=N|U&currency_code=AUD`
  → `data.{avg_price,qty_avg_price,min_price,max_price,...}`. Called twice (N + U)
  for sealed-vs-used market value. If AUD isn't honoured, the response
  `currency_code` drives the `/api/fx` conversion.

## Funko Pop! — hybrid catalog (offline + live eBay) + eBay comps

There is **no reliable Funko API** (hobbyDB has none and is anti-scrape; the
community datasets are deprecated/frozen at 2021 — verified Jun 2026: the
`kennymkchan` data file's last *data* scrape was Jan 2021). The builder is
**manual-first**, and the name search is now **hybrid**: instant offline catalog
+ live eBay results for anything newer.

### Offline catalog — `data/funko_pop.json` (no proxy; same-origin static)
- Built by `scripts/build-funko-data.mjs` from MIT `kennymkchan/funko-pop-data`:
  filtered to **Pop! vinyl** lines (drops apparel/pins/plush/Pez and non-Pop
  products), ~11k records slimmed to `{ t:title, img, fr:franchise, ex:exclusive, ch:chase }`.
- Frozen at **Jan 2021** — the *instant, no-key* layer of the autocomplete.
  Re-running the build script does **not** add newer Pops (upstream is frozen);
  post-2021 coverage comes from the live eBay layer below. Images hotlink
  `images.hobbydb.com` (downloadable via `/api/img`); links can rot over time.

### Live name search — eBay Browse  (proxy `/api/ebay`)
- Same Browse endpoint as the comps below. As the user types (≥3 chars, debounced
  350 ms, results cached per query), the builder queries
  `item_summary/search?q=Funko Pop <typed>` and parses each `itemSummaries[]`
  title into a catalog-like record: a cleaned candidate **name**, the **Pop #**
  (`#NNN` regex), a known **franchise** (matched against a small allow-list), an
  optional `(parenthetical)` **variant**, and the listing **image**. See
  `parseLiveItem()` / `FUNKO_NOISE` / `FUNKO_FRANCHISES` in the builder.
- Live rows show an `eBay #NNN` badge; picking one pre-fills name/franchise/Pop
  number/image. It deliberately does **NOT** auto-set chase/exclusive (titles lie;
  Golden Rule + INAD risk). Degrades to **offline-only** if keys are missing (503)
  or the call fails — offline search always works.

### eBay Browse — live price comps + photo  (proxy `/api/ebay`)
- Upstream: `https://api.ebay.com`. **Auth: OAuth2 client-credentials** app token
  (minted+cached by the middleware from `EBAY_APP_ID`/`EBAY_CERT_ID`), plus
  `X-EBAY-C-MARKETPLACE-ID` (`EBAY_AU`). **Use PRODUCTION keys** — sandbox keys
  (`SBX-`) against this production endpoint fail the token mint with
  `invalid_client`; the middleware now surfaces that error verbatim (and to the
  browser) instead of a blind 502, and short-circuits with a clear message if it
  spots `SBX-` keys.
- `GET /buy/browse/v1/item_summary/search?q=<name + #>&filter=conditions:{NEW}`
  → `itemSummaries[].{price:{value,currency},image:{imageUrl}}`. The builder shows
  the **median asking price** (NOT sold) in AUD and a comp photo. (Add
  `&category_ids=<AU action-figure id>` once confirmed — **VERIFY LIVE**.)
- The Marketplace Insights API (`/buy/marketplace_insights/...`) gives true *sold*
  prices but is limited-release. It's now wired (the Riftbound builder tries it first
  via an isolated `buy.marketplace.insights`-scoped token, falling back to asking) — but
  our keys return `invalid_scope`, so sold stays unavailable until eBay approves the app.

## eBay item specifics — Taxonomy API  (proxy `/api/ebay`)
- `GET /commerce/taxonomy/v1/category_tree/{id}/get_item_aspects_for_category?category_id=<id>`
  (after `getCategorySuggestions`) returns the authoritative `aspectName` +
  `aspectConstraint.aspectRequired` per marketplace. Use it to confirm the
  hardcoded item-specifics names in each builder's `renderSpecifics()`.
- Category IDs (**VERIFY LIVE on EBAY_AU**): LEGO Complete Sets & Packs ≈ `19006`;
  Funko Pop! Vinyl Figures ≈ `149372` (likely wrong — resolve via the API).

---

## Price tracker — local cache (`/api/tracker`, `data/tracker.db`)

A local SQLite layer (`node:sqlite`) that snapshots card prices over time. Served by
`trackerPlugin` (`lib/tracker.mjs`); the collector (`lib/collector.mjs`) **self-fetches the
proxies above** on a schedule and persists results. Card-games only (Riftbound/MTG/Pokémon/SWU/Lorcana).

### Endpoints
- `GET /api/tracker/watchlist?game=&review=` — tracked cards + latest snapshot + sparkline.
- `POST /api/tracker/watchlist` — `{game, identity_key, name, variant?, note?, source?, price?:{market,low,currency}}`. UNIQUE on `(game, identity_key, variant)`; returns `{id, created}`.
- `PATCH /api/tracker/watchlist/:id` — `{active?, note?, review_status?}` (approve review-queue items).
- `DELETE /api/tracker/watchlist/:id?hard=1` — soft-deactivate (default) or hard-delete.
- `GET /api/tracker/history/:id?days=90` — `{series:[{daysAgo,price}], points:[...]}`.
- `GET /api/tracker/cache/:id` — the latest full raw upstream payload cached for the card (`card_cache`).
- `GET /api/tracker/signals?kind=&unacked=1&unnotified=1` — open signals joined to card.
- `POST /api/tracker/refresh {id?}` — run a collection pass now.
- `POST /api/tracker/signals/:id/ack` · `POST /api/tracker/notified {ids:[]}`.
- `GET /api/tracker/export?days=90` — the bundle the Claude analyst reads.
- `GET /api/tracker/config` — thresholds, cadence, `scrydex_enabled`.

### Identity keys (what the collector re-fetches by)
Riftbound `OGN-296` → `/api/rb/cards/OGN-296?include=prices`; MTG `neo-1` → `/api/mtg/cards/neo/1`;
Pokémon `sv4-25` → `/api/pkm/cards/sv4-25`; SWU `sor/010` → `/api/swu/cards/sor/010`;
Lorcana `1/207` → `/api/lorcana/cards/1/207`.

### Card-number formatting (mirrors `extras.js` ⇄ `lib/listing-copy.mjs` — keep in sync, Golden Rule 10)

pokemontcg.io returns `number` with the printed zero-padding **stripped** (`"4"` for a card
printed `004/165`) and `printedTotal` as a bare integer, so the printed string has to be
reconstructed. The rule is era-, promo- and subset-dependent. Every row below was read off a
hi-res scan of the real card — do not "simplify" this table without re-checking scans.

| Case | Example | API gives | Printed on card |
| --- | --- | --- | --- |
| Scarlet & Violet | White Flare #12 | `12` + `86` | `012/086` |
| …secret rare (number > printedTotal) | White Flare #106 | `106` + `86` | `106/086` |
| Sword & Shield (the 2020 cutover) | SWSH #4 | `4` + `202` | `004/202` |
| Small modern set | Celebrations #1 | `1` + `25` | `001/025` |
| Sun & Moon / XY and earlier | SM #4 · Base #58 | `4` + `149` | `4/149` · `58/102` |
| Promo (any era) | SVP · SWSH · Wizards | `1` / `SWSH039` / `1` | `001` · `SWSH039` · `1` — **no `/total`** |
| Subset ("set within a set") | Trainer Gallery · Shiny Vault | `TG01` + `30` | `TG01/TG30` · `SV001/SV122` |
| JP/CN/KO via TCGdex | SV1S #1 | `localId:"001"` + `78` | `001/078` |

- **Era test:** `series` contains `Sword & Shield`/`Scarlet & Violet`, **or** `releaseDate`
  year ≥ 2020 → pad both sides to (at least) 3. Otherwise the numerator keeps its natural width.
- **Promos** are detected by `/promo/i` on the set name (or the baked `mep` flag / a `Promo`
  rarity). pokemontcg.io still reports a `printedTotal` for them (215, 307) but it is a
  **catalog count, not on the card** — emitting it produced junk like `1/215`.
- **Subsets** are separate sets upstream with the *correct* subset `printedTotal` (30/70/122);
  the denominator repeats the numerator's letter prefix. An unrecognised lettered numbering
  (e-Card `H1`, whose parent total is 165 — not the `H32` on the card) emits the bare number
  rather than a wrong denominator.
- **TCGdex** (`opts.source:'tcgdex'`) already returns a card-correct `localId`, so only the
  denominator is padded.
- **Display only.** Identity keys (`sv4-25`), the `/cards/{setId}-{num}` fetches, the
  pokemontcg.io `number:` query DSL and the Scrydex image slug all need the RAW number —
  padding them returns nothing. `cardNumberKey()` is the padding-insensitive key for
  matching/dedupe, and `extras.js buildNumberRe()` ignores padding on **both** sides so eBay
  comps still match titles written either way.

### Per-game price mapping (mirrors `lib/normalize.mjs` — keep in sync, Golden Rule 9)
- **Riftbound** (`scrydex`): variant `foil`/`normal` → `prices` where `condition==='NM'` → `market`,
  `currency`, plus `trends.days_{1,7,30,90}.percent_change` stored as `pct_*`. 401/403 ⇒ `scrydex_unauthorized`.
- **MTG** (`scryfall`): `usd` / `usd_foil` / `usd_etched` by finish (else `eur`).
- **Pokémon** (`pokemontcg`): `tcgplayer.prices[bucket].market` (USD) → else `cardmarket.averageSellPrice` (EUR).
- **SWU** (`swudb`): `MarketPrice` + `LowPrice` (USD).
- **Lorcana** (`lorcast`): `prices.usd_foil` for foil variants else `prices.usd` (fallback to the
  other when one is `null`); USD strings coerced to number.

### `price_snapshots` row
`{ ts, market, low, currency, market_aud, fx_usd_aud, source, pct_1d, pct_7d, pct_30d, pct_90d, raw }`.
Native price + an AUD conversion (FX from `/api/fx`, the rate stored for audit). Signals
(`opportunity`/`downtrend`/`momentum`) use Scrydex trend deltas when the Riftbound response
carries them (Growth+ tier), else snapshot history — the same path the other games use
(tier-agnostic) — against thresholds in `data/tracker.config.json`.

### `card_cache` row
`{ game, identity_key, fetched_at, http_status, source, payload }` — PK `(game, identity_key)`,
upserted on **every successful fetch** (any source). `payload` is the full raw upstream JSON.
A durable local copy of whatever the API returned; also conserves credits (Scrydex bills per
request). The mapped price subset is still stored per-snapshot in `price_snapshots.raw`.

---

## Graded-card inventory — local DB  (`/api/inventory`, `data/tracker.db`)

The "Binders Keepers" inventory platform: graded-card stock, cost basis / P&L, live graded
valuation, and a grading-submission pipeline. Served by `inventoryPlugin` (`lib/inventory.mjs`),
which shares the tracker's `openDb()` handle and adds four tables to the **same** `data/tracker.db`
(`inventory_items`, `inventory_valuations`, `grading_submissions`, `sku_counter`; idempotent
create + an additive `image_url` migration). **Money is integer cents** (Golden Rule 3). SKUs are
generated `BK-<GAMECODE>-000001` (RB/MTG/PKM/SWU/LOR) from an atomic `sku_counter`.

### Endpoints
- `GET /api/inventory/items?game=&company=&grade=&status=&q=` — stock list (+ a value sparkline
  per item). `POST /items` — create (generates the SKU; optional `link_watchlist` keeps raw price
  fresh via the tracker; auto-resolves a card image).
- `GET/PATCH/DELETE /items/:id` — read / partial update (whitelisted cols) / hard delete.
- `POST /items/:id/refresh-value` — pull live **graded** value from PriceCharting (maps the
  returned `ladder` to the item's company+grade rung; USD). `?force=1` overrides a manual value.
- `POST /items/:id/value-manual` — set a value directly (`source:'manual'` = hard override; any
  other source lets a later refresh update it).
- `POST /items/:id/fetch-image` — resolve + cache the card image (see below).
- `GET /items/:id/valuations` — value history for the detail sparkline.
- `GET /summary` — portfolio counts + `totalCostCents`, `realizedPlCents`, `valueByCurrency`,
  `byGame`, `byCompany`.
- `GET /export` — full items + submissions bundle (accounting / Claude).
- `GET/POST /submissions`, `PATCH/DELETE /submissions/:id`, `POST /submissions/:id/promote` —
  grading pipeline; promote creates the stock item (idempotent) and computes `expected_return_at`
  from `data/grading.config.json` turnaround days.

### Card-image resolution (`resolveImage` in `lib/inventory.mjs`)
Best-effort, never throws. First the **identity route** via `normalize.mjs`
`lookupPath(game, identity_key)` → the game proxy → `imageFrom()` (Pokémon `images.large`, MTG
`image_uris`, Lorcana `image_uris.digital`, SWU `FrontArt`, Riftbound `images[]`). With no
identity_key it falls back to a **name (+ number) SEARCH** — Pokémon `/api/pkm/cards?q=`, MTG
`/api/mtg/cards/named?fuzzy=`, Lorcana `/api/lorcana/cards/search?q=` — and **backfills
`identity_key`** when the search resolves one. PSA cert lookups can also supply a slab image via
`/api/cert`. Cached in `inventory_items.image_url`; the list renders it inside the mini slab badge.

### Reserved channel fields
`inventory_items` carries `ebay_listing_id` / `shopify_product_id` / `channel_status` for a future
eBay/Shopify sync — reserved, not wired yet.

---

## Pricing notes / gotchas

- **eBay AU delivered-comps are shared** via `TCG.ebayComps()` in `extras.js` (see the
  Riftbound §). Every card builder (Pokémon / MTG / SWU / Riftbound) and Funko render the
  same delivered-total + undercut block into a `#ebayextras` container, differing only by
  the **search query** they pass (tuned per game against the live API):
  - Pokémon: `Pokemon {name} {number} {setName}` (the number helps here)
  - MTG: `{name} {setName}` (chase cards are specific enough; no forced "MTG")
  - SWU: `Star Wars Unlimited {name} {setName}` (the prefix filters generic SW merch; `SWU` was too narrow)
  - Funko: `Funko Pop {character} {pop#} {franchise}` + `filter=conditions:{NEW}` (boxed market)
  This shows *local* eBay AU prices alongside each API's reference prices (which are US/EU).
- **TCGplayer API** is closed to new developers (since late 2024) — not an option
  for new price sources.
- The Pokémon `tcgplayer.prices` object has multiple buckets
  (normal/holofoil/reverseHolofoil); the extras panel takes the first available
  market price as a sanity check, not gospel — verify chase cards against live
  comps.
- **Finish/printing is not reliably in any of these APIs** (which physical
  variant you hold). Those dropdowns stay manual.
- Prices come back in **USD/EUR**; everything user-facing is converted to **AUD**
  via `/api/fx`.

## eBay AU buyer-protection fee (landing-page calculator)

Marginal tiers on the **list price `L`**, plus a flat `A$0.30`:

| Portion of L | Rate |
|---|---|
| first $20 | 8% |
| $20–$500 | 6% |
| $500–$5000 | 4% |
| above $5000 | 0% (fee flat beyond this) |

Buyer total `T = L + fee(L)`. Inverse (back-out) used by the calculator:

| Target T | List L |
|---|---|
| ≤ 21.90 | `(T − 0.30) / 1.08` |
| ≤ 530.70 | `(T − 0.70) / 1.06` |
| ≤ 5210.70 | `(T − 10.70) / 1.04` |
| above | `T − 210.70` |

Because the buyer total moves in ~1.06¢ steps per 1¢ of list price, **not every
round target is reachable** — the calculator rounds to cents, searches the
neighbouring cents, and reports `Exact` or `Closest` accordingly. Verified
example: target `A$25.00` → list `A$22.92` → buyer pays `A$25.00` (Exact);
`A$31.00` is unreachable (closest buyer total `A$30.99`). eBay adjusts these
bands occasionally; if a real listing's total drifts from the prediction, update
the bands here and in `index.html`.
