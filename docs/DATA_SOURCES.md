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

### Pricing — eBay AUD comps (`findRBComps`, via `/api/ebay`)
- Source-agnostic overlay: `GET /api/ebay/buy/browse/v1/item_summary/search?q=<Riftbound name num CODE>`
  → median + low **asking** price (NOT sold), AUD, rendered into `#ebayextras` so it never clobbers a
  Scrydex trend graph. Button-triggered to protect the eBay quota.

### Name handling (all sources)
- A card's `name` may include the subtitle (`"Kai'Sa - Survivor"`). Alt-art appends `"(Alternate Art)"`,
  Overnumbered `"(Overnumbered)"`; the builder strips these for the clean name field and re-derives the
  variant + the `(Alt Art)`/`(Overnumbered)` title tag.


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
- Stretch: the Marketplace Insights API (`/buy/marketplace_insights/...`) gives
  true *sold* prices but is limited-release; don't depend on approval.

## eBay item specifics — Taxonomy API  (proxy `/api/ebay`)
- `GET /commerce/taxonomy/v1/category_tree/{id}/get_item_aspects_for_category?category_id=<id>`
  (after `getCategorySuggestions`) returns the authoritative `aspectName` +
  `aspectConstraint.aspectRequired` per marketplace. Use it to confirm the
  hardcoded item-specifics names in each builder's `renderSpecifics()`.
- Category IDs (**VERIFY LIVE on EBAY_AU**): LEGO Complete Sets & Packs ≈ `19006`;
  Funko Pop! Vinyl Figures ≈ `149372` (likely wrong — resolve via the API).

---

## Pricing notes / gotchas

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
