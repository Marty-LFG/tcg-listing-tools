# Data sources

Per-game APIs, the fields each builder maps, and how auth/limits work. All calls
go through the Vite dev-server proxies (see `vite.config.js`); the builders never
hit these hosts directly (CORS / key injection). Base URLs below are the *real*
upstream — the builder uses the proxy prefix (e.g. `/api/pkm`).

> When extending a builder, confirm field names against a live response — schemas
> drift. The notes below were accurate at build time.

---

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
- Set fields used (picker): `id`, `name`, `series`, `releaseDate`, `ptcgoCode`
  (the **printed code** on cards, e.g. `PAR`), `images.symbol` (set symbol icon).
- Set picker resolves a typed token against `id`, `ptcgoCode`, **or** `name`
  (so `PAR`, `sv4`, and `Paradox Rift` all find Paradox Rift). Sets are cached in
  `localStorage` (`pkm_sets_v1`) and refreshed in the background.
- **Image fallback (dotgg):** the card image falls back to
  `https://static.dotgg.gg/pokemon/card/{c.id}.webp` (the dotgg code IS the
  pokemontcg.io id, e.g. `swsh10tg-TG01`, case-sensitive) — used as primary when
  pokemontcg.io returns no image, and as an `onerror` swap when its image breaks.

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

## Riftbound — three sources (default keyless)

The builder picks a `source` at runtime: **offline** (default) → **riftscribe** → **scrydex**.
Coverage of all four sets (OGN Origins, OGS Proving Grounds, SFD Spiritforged, UNL Unleashed)
is keyless; Scrydex is an optional pricing upgrade. An eBay AUD comps overlay works under any source.

### 1. Offline baked — `data/riftbound.json` (default; no proxy, same-origin static)
- Built by `scripts/build-riftbound-data.mjs` from the **official LoL card gallery** (keyless):
  scrape `"buildId"` from `https://riftbound.leagueoflegends.com/en-us/card-gallery/`, then
  `GET /_next/data/{buildId}/en-us/card-gallery.json`. The buildId rotates per Riot deploy, so the
  script re-scrapes it each run. **Build-time only** — no runtime proxy.
- ~943 cards across all 4 sets, with images (Riot CDN `cmsassets.rgpub.io`) and energy/might/power
  stats (which Scrydex does NOT carry). No prices.
- **Image fallback (dotgg):** every Riftbound lookup (offline / riftscribe / Scrydex) falls back to
  `https://static.dotgg.gg/riftbound/cards/{SET}-{NNN}{suffix}.webp` via `rbDotgg()` — primary when the
  source has no image, `onerror` swap when its image breaks. (Runes go further — dotgg is the *primary*,
  since cmsassets only has the Origins printing; see Runes below.)
- Shape: `{ [setCodeLower]: { name, code, cards:[{ k, num, name, rarity, type, domain, e, p, m, img }] } }`.
  `k` mirrors the builder's `normNum` (leading zeros stripped, trailing letter/`*` kept). Alt-art
  cards carry a `(Alternate Art)` name suffix, Overnumbered a `(Overnumbered)` one — the builder
  strips these to derive the variant + a Foil finish (same path as Scrydex names).
- Re-run `node scripts/build-riftbound-data.mjs` when a new set releases.

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
  Overnumbered `"(Overnumbered)"`; the builder strips these for the clean name field and re-derives the
  variant + the `(Alt Art)`/`(Overnumbered)` title tag.

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
proxies above** on a schedule and persists results. Card-games only (Riftbound/MTG/Pokémon/SWU).

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
Pokémon `sv4-25` → `/api/pkm/cards/sv4-25`; SWU `sor/010` → `/api/swu/cards/sor/010`.

### Per-game price mapping (mirrors `lib/normalize.mjs` — keep in sync, Golden Rule 9)
- **Riftbound** (`scrydex`): variant `foil`/`normal` → `prices` where `condition==='NM'` → `market`,
  `currency`, plus `trends.days_{1,7,30,90}.percent_change` stored as `pct_*`. 401/403 ⇒ `scrydex_unauthorized`.
- **MTG** (`scryfall`): `usd` / `usd_foil` / `usd_etched` by finish (else `eur`).
- **Pokémon** (`pokemontcg`): `tcgplayer.prices[bucket].market` (USD) → else `cardmarket.averageSellPrice` (EUR).
- **SWU** (`swudb`): `MarketPrice` + `LowPrice` (USD).

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
