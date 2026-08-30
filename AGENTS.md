# AGENTS.md

Entry point for AI coding agents (Claude Code and similar) working on this repo.
Humans wanting plain run instructions: see `README.md`. Dense API reference:
see `docs/DATA_SOURCES.md`. Visual design system: see `DESIGN.md`.

---

## 1. What this is

A small suite of **eBay listing tools for trading-card singles**, built for an
Australian (eBay AU) seller. It is a **Vite project of standalone HTML pages** —
vanilla JS, no framework, no front-end build step. Everything runs on the Vite
**dev server**, which also acts as the API proxy layer.

Pieces:

- **`index.html`** — landing page. Hosts a self-contained **eBay AU pricing
  calculator** (backs out a list price so the buyer's fee-inclusive total hits a
  target) and links to every builder + tool (inventory, grader, tracker, shipping).
- **Five card builders** — `pokemon-`, `mtg-`, `swu-`, `lorcana-`, `riftbound-listing-builder.html`.
  Each: pick a set + card number → fetch live card data through a proxy → fill
  editable fields → generate an eBay HTML description + an 80-char-optimised eBay
  title → copy. Plus a shared "extras" panel: card images (with download),
  prices (with live AUD conversion), and a price-trend graph (Riftbound only).
- **Two collectibles builders** — `lego-listing-builder.html` (set-number lookup
  via Rebrickable + Brickset + BrickLink new/used pricing) and
  `funko-listing-builder.html` (hybrid offline-catalog + live-eBay autocomplete +
  manual flags + eBay AU price comps). Same shape as the card builders, but with a
  collectibles condition/postage model and a copy-paste **item-specifics** block.
- **`extras.js`** — shared `TCG.*` module used by all seven builders (incl. `TCG.setCombobox`, the icon dropdown).
- **`logos/`** — bundled game logos for the home tiles (pokemon/mtg/funko/lego SVG, swu/lorcana PNG, riftbound = LoL wordmark). Shown on a white chip so dark + light logos both read.
- **`vite.config.js`** — the dev-server proxies + image-streaming, BrickLink
  OAuth1-signing, and eBay OAuth2 token-minting middlewares.
- **`data/funko_pop.json`** — vendored, filtered Funko catalog (built by
  `scripts/build-funko-data.mjs`; frozen at 2021 — an assist, not truth).
- **Price tracker** — `tracker.html` (dashboard) + `lib/` (SQLite store, collector,
  signal engine, Vite plugin) + `/api/tracker/*`. Caches per-card prices to
  `data/tracker.db`, builds historical trends, and flags buy/downtrend/momentum
  signals. A daily headless Claude run (`.claude/skills/price-analyst`) researches
  the market, curates the watchlist, and fires desktop alerts. See §12.

---

## 2. Golden rules (read before changing anything)

These are invariants the owner relies on. Breaking them silently breaks the tool.

1. **The proxies are dev-server-only.** `/api/pkm|mtg|swu|rb|fx` and the
   `/api/img` middleware live in `vite.config.js` and exist **only under
   `vite dev`**. `vite build` emits static files with **no proxy**, so every
   lookup breaks (CORS returns) and the Scrydex/pokemontcg keys have nowhere to
   be injected. **Do not move to a production static build without first writing
   a backend that re-implements the proxies.** Run with `pnpm dev`.

2. **Secrets stay server-side.** Real API keys live only in `.env` (gitignored).
   `.env.example` holds placeholders. Keys are injected as request headers inside
   `vite.config.js` and **never** reach the browser. Never hardcode a key into
   any committed file, HTML, or JS.

3. **Money is integer cents — stored native, shown in AUD.** Compare/round money as
   `Math.round(x*100)`; never compare raw floats (the pricing calculator + FX depend on it).
   **Store** each amount as integer cents in the currency it was *sourced* in and record that
   currency alongside it (`value_currency`/`suggested_currency` etc.) — PriceCharting/UPCItemDB →
   `USD`, eBay AU + user-entered cost → `AUD`. **Never pre-convert at storage** (FX drifts; the stored
   number must stay a faithful record of the source). **Display is AUD-first:** the market is AU/NZ
   (§11), so every price a user sees must be converted to AUD at *render* time via `TCG.toAUD`
   (cached ECB rates through `/api/fx`), showing **A$ as the primary figure** and the native amount as
   a secondary annotation (e.g. `A$194.20 · USD 126.25`). If FX is unavailable, show the native amount
   flagged as approximate — never a silently wrong AUD number, and never a bare non-AUD price as if it
   were the headline. User money entry uses the AUD/USD toggle (`applyCur`/`dcAud`) and converts to the
   chosen storage currency. This holds across every tool (tracker, graded + sealed inventory, catalog,
   bulk, repricer); the graded/sealed inventory summaries return per-currency subtotals that the client
   folds to AUD. `test/invariants/` guards the cents rule; the AUD-at-display rule is a review checkpoint.

4. **Live pricing beats estimated pricing — always.** Surface API/live market
   numbers. Do not add features that present a model-guessed price as
   authoritative. (Owner's hard rule; model price estimates have been off by
   10x+ in practice.)

5. **Preserve variant accuracy.** Alt-art vs base printings differ enormously in
   value and must stay distinguishable — the `a` collector-number suffix
   (`039a`), Scryfall `frame_effects`/`border_color`, SWU `VariantType`, Scrydex
   variant/rarity. Don't collapse them into one "version".
   **Magic's vocabulary**, checked against TCGplayer's live product names: Scryfall
   `inverted` is what they sell as **"(Borderless)"** (HOB #15 US$37.84 vs #239
   `enchantment,inverted` US$83.15) — a FRAME axis, so it folds into the existing
   borderless branch; `surgefoil` is a separate **finish** and a separate TCGplayer
   product ("(Borderless) (Surge Foil)", HOC #25 US$29.93 vs #65 US$125), so it gets
   its own title token and its own identity variant; `boxtopper`/`headliner` are
   print runs. `universesbeyond` is **not** any of these — it rides on all 479
   HOB+HOC prints, so it marks the brand.
   ⚠ **Ordering:** "Nonfoil" contains "foil" and "Non-holo" contains "holo", and
   "Surge Foil" contains "foil". Every finish ladder tests the negations first and
   surge before the generic foil branch, or a base card is titled, tiered, identified
   and priced as a foil. The ladders are `finishClass` (pricing), `variantToken`
   (which IS the `variant` column in `UNIQUE(game, identity_key, variant)`),
   `itemFinish` (bulk), `parseVariance` (collectr), `ebayFinish`, `MAPPERS.mtg`
   (normalize), and each builder's `genTitle`.

6. **Condition / protection / footer blocks are per-product-type; POSTAGE is per
   price band.** For the **six card builders** (pokemon, mtg, lorcana, riftbound,
   swu, onepiece — the list lives in `test/helpers/extract-inline.mjs`
   `CARD_BUILDERS`) the wording is identical and owner-verified — edit one, edit
   all six: condition = `"{cond}. Pulled straight to sleeve and stored in a
   toploader."` (default `Ungraded, Near Mint`); protection = `"Ships in a penny
   sleeve and toploader inside a rigid mailer."`; footer = `"From a smoke-free
   home. Fast dispatch. Thanks for looking."`
   The postage sentence itself is **not a constant**: it is
   `postagePhrase(band)` from `lib/shipping-bands.mjs`, one template per price
   band, with the amount supplied by config. Protection and postage used to be
   one sentence ending "…with FREE postage within Australia", which stopped being
   true the day the store moved to three buyer-paid bands.
   **THE RULE THAT REPLACES "do not reword": the amount and service a description
   quotes MUST equal the `shippingCost` and service on the eBay policy pinned to
   that band.** A description contradicting the policy is an INAD claim on every
   listing in the band, so `verifyBandPolicies` checks it against eBay live and
   `publishListing` refuses rather than publishing a guess.
   The **LEGO and Funko builders keep their own condition/PROTECTION wording**
   (`condText()` / `postageText()` in each file) because the card wording is
   physically wrong for boxed goods — a LEGO set or Funko box does not ship in a
   penny sleeve. **Do not "unify" those back to the card constants.** They DO
   share the band phrases and the footer, which are suite-wide. (The old carve-out
   line "bulky LEGO can't honestly offer free postage" is obsolete: nothing is
   free now.) Condition wording is driven by explicit seller fields and defaults
   to the *safest* option (LEGO `Used – Complete`, Funko `Near-Mint` box) so an
   un-edited listing under-promises — never over-promises (INAD risk).
   Enforced by `test/invariants/builder-wording.test.mjs`, which runs each
   builder's own `postagePhrase()` and compares the rendered sentence against the
   module's (`pnpm test`).

7. **Every builder must survive its API being down.** Fields are editable; a
   failed lookup shows a warning, never a crash. Keep manual entry working.

8. **eBay descriptions use inline styles only** — no `<style>`, `<script>`, or
   active content (eBay strips them). `buildHTML()` already follows this.

9. **`lib/normalize.mjs` mirrors each builder's price extraction.** The price
   collector can't import the builders' DOM-coupled inline mappers, so it keeps a
   server-side copy. If you change how a builder reads a price (Scrydex variant
   pick, Scryfall `usd*`, pokemontcg bucket, SWU `MarketPrice`/`LowPrice`), update
   `lib/normalize.mjs` to match — they must stay in sync (like Golden Rule 6's
   "edit all five card builders together").

10. **Every Pokémon card number is rendered by the shared formatter.** The number
    printed on a card is era-, promo- and subset-dependent: Scarlet & Violet / Sword &
    Shield pad to three digits (`012/086`, and `106/086` for a secret rare), everything
    before Sword & Shield does not (`58/102`, `4/149`), promos carry no `/total` at all
    (`001`, `SWSH039`, `XY01`), and subsets repeat their prefix (`TG01/TG30`,
    `GG01/GG70`, `SV001/SV122`). pokemontcg.io **strips** the printed zero-padding (a
    card printed `004/165` arrives as `"4"`), so it has to be rebuilt — never
    concatenate `number + '/' + printedTotal`. Use `TCG.formatCardNumber` (`extras.js`)
    or its verbatim twin in `lib/listing-copy.mjs`. It is **display-only**: lookups,
    identity keys (`sv4-25`) and the pokemontcg.io `number:` query DSL keep the RAW
    upstream number — padding those returns zero results — and `cardNumberKey()` is the
    padding-insensitive key for matching/dedupe across the old and new forms. Buyers
    search eBay for the exact printed string, so a number that isn't on the card is a
    lost sale. Enforced by `test/invariants/card-number.test.mjs` plus the
    `formatCardNumber` vectors in `scripts/check-listing-copy.mjs` (`pnpm test`).
    **This rule is Pokémon-only, and `printedCardNumber` early-returns for every other
    game.** No other source supplies its inputs: Scryfall exposes no printed total —
    `set.card_count` counts *printings* (HOB is 321, with alt treatments numbered past
    250) — so there is no denominator to render and inventing one is GR4. Magic prints
    `249`, so `249` is what ships. Run through the Pokémon formatter, HOB #1 came out
    `001`, a number that is not on the card.

---

## 3. Run / dev loop

```bash
pnpm install
cp .env.example .env        # all keys optional — Riftbound works keyless; Scrydex adds pricing
pnpm dev                    # serves http://localhost:5273 (host:true → also on the LAN)
```

- **Test suite** (`node:test`, zero deps): `pnpm test` (unit + invariants + data audits,
  offline, <1s) · `pnpm test:integration` (boots the real dev server on a random port
  against temp DBs) · `pnpm verify` = both. **Run `pnpm verify` before considering any
  change done** (see §8). Live upstream smoke: `$env:TEST_LIVE='1'; pnpm test:integration`.
- The dev server binds to `0.0.0.0:5273` for LAN access; see `README.md` for the
  systemd unit (`tcg-tools.service`), `scripts/WINDOWS_SERVICE.md`, and firewall notes.
- An in-chat / sandboxed preview **cannot reach `localhost`**, so proxied lookups
  only work when the dev server is actually running on a reachable host.

---

## 4. Repo map

| Path | Purpose |
|---|---|
| `index.html` | Landing page + eBay AU pricing calculator (self-contained JS at the bottom). |
| `pokemon-listing-builder.html` | Pokémon builder. Has the most-developed set picker (cached custom combobox with set symbols + printed-code search) and the large EN/JP language tile. |
| `mtg-listing-builder.html` | Magic builder (Scryfall). |
| `swu-listing-builder.html` | Star Wars: Unlimited builder (swu-db). |
| `lorcana-listing-builder.html` | Disney Lorcana builder (Lorcast). Set-pills + number lookup (SWU pattern); one Lorcast call returns image + gameplay + `prices.{usd,usd_foil}`. Image + price panel and the PriceCharting graded ladder (`pcEnrich`, reuses `/api/pc`) render into `#extras`; eBay AUD comps overlay into `#ebayextras`. |
| `riftbound-listing-builder.html` | Riftbound builder. Three interchangeable sources (`source` ∈ `offline`/`riftscribe`/`scrydex`): **offline** = baked `data/riftbound.json` (default, every released set, keyless, images + stats); **riftscribe** = `/api/rbs` live keyless (currently 4 sets — no Vendetta); **scrydex** = `/api/rb` (needs an ACTIVE paid key) for the price-trend graph only. **No hardcoded set list anywhere**: the pills, their labels and their order all derive from the baked catalog (`rbsName`/`setRank`), including the Riftscribe lane, so a new set needs no edit. The catalog loads through `TCG.cachedJSON` — the last copy paints synchronously and a 304 costs no re-parse. **Market price is keyless on every lane** — `rbPriceEnrich()` overlays `/api/riftbound/prices` (TCGplayer) after each lookup and feeds `_trk.price`; it builds the index key with `normNum()` itself because the scrydex lane's own `_trk` key uses the number as typed. Runes price on OGN only (the reprints aren't in the index), and `runeFill()` resolves an Origins rune to its PRINTED number for the field, identity and image alike — `R01a` and `7a` both yield `OGN-7a`; `R##` survives only on the reprint sets that actually print it. eBay AUD comps overlay (`findRBComps`, renders into `#ebayextras`) works under any source. |
| `lego-listing-builder.html` | LEGO set builder. Set-number lookup → Rebrickable (core) + Brickset (RRP/age) + BrickLink (new/used market price). LEGO condition/postage model + item-specifics block. |
| `funko-listing-builder.html` | Funko Pop builder. **Hybrid** autocomplete — instant offline catalog + live eBay Browse search (post-2021 coverage; parses name/franchise/Pop#/image from listing titles) — + manual number/exclusive/flags; eBay Browse price comps. Funko condition/postage model + item-specifics block. |
| `data/funko_pop.json` | Vendored, filtered Funko catalog (~11k Pop vinyls). Built by `scripts/build-funko-data.mjs` from the MIT `kennymkchan/funko-pop-data` dump. Frozen at 2021. Fetched same-origin (no proxy). |
| `scripts/build-funko-data.mjs` | Rebuilds `data/funko_pop.json` from upstream (filter to Pop! vinyl, derive franchise/exclusive/chase). |
| `data/riftbound.json` | Baked Riftbound catalog (~1164 cards, every released set), built by `scripts/build-riftbound-data.mjs` from the **official LoL card gallery** (keyless). Keyed by lowercase set code **in Riot's release order**; per-set `{name,code,total,cards}` where `total` is the printed set total; per-card `{k,num,name,rarity,type,domain,e,p,m,img}`. Fetched same-origin (gzipped by the `dataGzip` middleware, ETag-cached client-side via `TCG.cachedJSON`). Default Riftbound source. |
| `lib/riftbound-cards.mjs` | Serves the baked catalog to the two stock tools at `/api/riftbound/sets`, `/set/:id/cards` (with the keyless price join) and `/cards/:set/:num`. No upstream, no cache — the bake IS the source. **Must be registered before `riftboundPricesPlugin()`** (§17). |
| `scripts/build-riftbound-data.mjs` | Rebuilds `data/riftbound.json`: scrapes the gallery Next.js `buildId`, fetches `card-gallery.json`, slims + groups by set. **Self-updating** — set codes, names, printed totals and release order come from the gallery's own `sets.items` roster, so a NEW SET needs no code change here or in the builder (`lib/refresh.mjs` Telegram-alerts via the returned `newSets`). Derives the variant treatment from the printed number and freezes it into the card name (see §6). |
| `extras.js` | Shared `TCG.*` module. **Images** (`renderExtras`): each image is `{label, display:[fast/small urls — raced, quickest shown], download:bestQualityUrl, fallback}`; the download button is ALWAYS best quality (back-compat `{url,fallback}` still works). **`TCG.activity(label)`** → `{update,done,fail}` renders a bottom-left toast stack with a live elapsed timer so every network op is visible. **`TCG.ebayComps({query,container,status,filter?})`** — shared eBay AU delivered-comps engine (sold-first via Marketplace Insights → asking fallback; delivered totals = item + shipping; AU vs Worldwide; undercut; auto-drives an activity toast). Plus prices/graph panel, FX, title-fitting, `condCode`/`langCode`, `legoCondToken`/`funkoCondToken`, `renderItemSpecifics`. Loaded via `<script src="/extras.js">`. |
| `listing-image-lab.html` | Tuning harness for the branded listing image (§19). Drop a photo, drag rail-width / padding / canvas / text sliders, check it at thumbnail size, copy or save the config. Sliders are request-scoped — saving is a separate button through `/api/settings`. |
| `lib/listing-image.mjs` | The compositor: `composeListingImage(input, meta, options)` → a 1600×1600 branded JPEG. Also `composeAvailable`, `describeCompositor`, `hashFor`, and the `cardDetector` seam (default `trimDetector`). Knows nothing about eBay. |
| `lib/listing-image-config.mjs` | `ASSET_VERSION`, `DEFAULT_LAYOUT`, per-`productType` profiles, the variant registry + rules, `resolveLayout`/`railText`/`composeHash`/`composeVersion`, and load/save for `data/listing-image.config.json`. |
| `lib/listing-image-assets.mjs` | Rail PNG loading (normalised to the target width ONCE, memoised), `railsDigest`, the lazy `sharp` import, and `fontProbe()` — see §19 for why the probe is not optional. |
| `lib/listing-image-lab.mjs` | `listingImageLabPlugin` → `/api/listing-image/{config,preview,resolve,reload-assets}`. Registered in the `vite.config.js` plugins array (GR1). |
| `lib/img-cache.mjs` | The content-addressed image cache (`data/img-cache/`), extracted from the `/api/img` middleware so the compositor shares it — it must download bytes before it can compute its cache key. |
| `lib/plugin-registry.mjs` | `withRegistry()` + `pluginHealth()` — which plugins this PROCESS registered, and whether the sources on disk are newer than it. Powers the `plugins.stale` block in `/api/status` (§20). |
| `rails/<variant>/{left,right}.png` | Vertical rail art per variant (`default`, `japanese`, `sealed`), for the eBay square and the OG card. Any authoring scale works; see `scripts/build-placeholder-rails.mjs` for the full contract. **NOT placeholders** — the generator composites the real store mark and the plum is keyed off it (`bc8410d`); all twelve files are byte-identical to its output, verified 2026-08-23. The script's name is the only thing still saying "placeholder". |
| `rails/<variant>/{top,bottom}.png` | Horizontal band art, for the Shopify 63:88 and square tiles. Gradient + accent hairline only — the mark is composited at render time, because one file serves both a 1512-wide and a 1600-wide tile and a baked mark would stretch differently in each. Hashed by `bandsDigest`, **separate from `railsDigest`**, so changing a band re-keys no eBay image. |
| `fonts/Genty-Sans-Regular.ttf` | The bundled rail font. Its family name is **`Genty Sans`** and that string must match exactly (§19). |
| `scripts/compose-listing-images.mjs` | Batch/backfill CLI: `--in <file\|dir> --out <dir> [--variant --type --language --set --concurrency --dry-run --force]`. Exports `composeDir()`/`pool()` for the suite. |
| `scripts/build-placeholder-rails.mjs` | Regenerates the stand-in rail art. Documents the contract real artwork has to meet. Never overwrites existing files without `--force`. |
| `vite.config.js` | Dev-server config: `/api/*` proxies + `/api/img` streaming, BrickLink OAuth1-signing, and eBay OAuth2 token-minting middlewares + LAN host settings. |
| `.env.example` | Placeholder env vars. Copy to `.env`. |
| `package.json` | Vite ^6; scripts `dev` / `build` / `preview`. (Use `dev`; see Golden Rule 1.) |
| `tcg-tools.service` | Sample systemd unit for always-on LAN hosting (Linux). |
| `scripts/run-dev.mjs` | Launcher for Vite dev server (Windows service / manual). |
| `scripts/start-tcg-tools.cmd` | Double-click / Task Scheduler entry point for Windows. |
| `scripts/WINDOWS_SERVICE.md` | pnpm setup + NSSM / firewall instructions for Windows LAN hosting + the daily Claude analysis task. |
| `tracker.html` | Price-tracker dashboard: opportunities / downtrends / momentum / review-queue / all-tracked, with sparklines (reuses `TCG.lineGraph`). Linked from `index.html`. |
| `lib/db.mjs` | `node:sqlite` store — opens `data/tracker.db`, PRAGMAs + idempotent DDL (`watchlist` / `price_snapshots` / `signals` / `card_cache`, plus the inventory tables `inventory_items` / `inventory_valuations` / `grading_submissions` / `sku_counter`, §13; the purchasing tables `purchase_orders` / `purchase_lines` / `purchase_line_placements` / `purchase_payments` / `purchase_receipts`, §22) + additive `migrateX` passes run every boot. All DB access funnels here. |
| `lib/normalize.mjs` | Server-side mirror of each builder's price extraction + FX math + per-game lookup paths (see Golden Rule 9). `lookupPath`/`pricePath` return **null** for a namespaced non-English Pokémon key — pokemontcg.io has no such card and TCGdex publishes no prices (§17). |
| `lib/pokemon-intl.mjs` | The non-English Pokémon vocabulary (§17): the `LANGS` table, the lane-namespaced `intlIdentityKey`, the five-way set matcher, `englishCardName`/`nativeInfo`, `intlPrintingsFor` (off TCGdex `variants`), `pcSearchUrl`. Pure browser-safe ESM — both stock pages import it, the server publishes through it, and `pokemon-listing-builder.html` mirrors it inline under `scripts/check-listing-copy.mjs`. |
| `lib/pricecharting.mjs` | Keyless PriceCharting scraper (Pokémon graded/raw/pop). Parses the public card + population pages server-side; matches by exact collector number + name + fuzzy set. Powers `/api/pc` (display-only; not wired into the tracker/collector). |
| `shipping-label.html` | Shipping Label Maker. Pastes an eBay address → cleaned, auto-fit address label as a jsPDF (50×30 / 100×50 mm); batch → multi-page PDF. Can also **print direct** to the AUSPRINT PRO: rasterises the label to a 1-bpp bitmap (reusing the jsPDF layout) and POSTs to `/api/print` (Print button + Auto-print toggle). Download path is unchanged. |
| `pdf-print.html` | PDF Label Printer. Drops any PDF → pdf.js rasterises each page to the same 1-bpp bitmap and POSTs to `/api/print` (no backend change). Size modes: Use PDF size (native) / Fit 50×30 / 100×50 / **100×150**. One-click **🇦🇺 Australia Post 100 × 150** preset (fit 100×150, 180° flip, no dither, threshold 150) for the prepaid AP shipping label eBay hands you. **Darkness** + **Speed** steppers mirror the vendor app and post `{speed,density}` (env-seeded). |
| `lib/labelprint.mjs` | Builds TSPL (or ZPL) from a 1-bpp label bitmap and streams it to the thermal printer's raw 9100 socket — the server side of `/api/print`. Pure `node:net`, no deps. Client sends `1`=ink; TSPL wants `0`=black, so it inverts (overridable via `LABEL_PRINTER_INVERT`). TSPL emits `SPEED` (from `LABEL_PRINTER_SPEED`, default 2) then `DENSITY`; both are per-request overridable (`buildTSPL` reads `cfg.speed`/`cfg.density`). ZPL emits no SPEED. |
| `scripts/labeltest.mjs` | Standalone raw-9100 test/calibration harness for the AUSPRINT PRO: `--lang tspl\|zpl\|bitmap\|self` sends a minimal label so you can confirm the dialect and tune size/position/darkness. |
| `lib/collector.mjs` | In-process scheduler + `runPass` (self-fetches the proxies) + `computeSignals` (thresholds). |
| `lib/tracker.mjs` | Vite plugin: owns the DB, exposes `/api/tracker/*`, starts the collector. Registered in `vite.config.js` `plugins`. |
| `inventory.html` | **Graded-card inventory dashboard** ("Binders Keepers"). Stock list (filters + value sparklines), P/L summary tiles, add/edit modal (with PSA cert auto-fill), and the grading-submission pipeline (create → promote to stock). Reuses `TCG.lineGraph`/`ebayComps`/`toAUD`. Linked from `index.html`. See §13. |
| `lib/inventory.mjs` | Vite plugin: owns the inventory tables (in the same `data/tracker.db`), exposes `/api/inventory/*` (items CRUD, valuation refresh, submissions + promote, `/summary`). Mirrors `lib/tracker.mjs`. Registered in `vite.config.js` `plugins`. |
| `lib/purchasing.mjs` | Vite plugin: owns the purchasing tables and `/api/purchasing/*` — orders, lines, payments, settlement, the restock picker, and the receive transaction. Writes stock **only** through `receiveSealed` (`lib/sealed.mjs`) and `receiveInventory` (`lib/inventory.mjs`); never touches `sealed_placements` or `sku_counter` directly. Registered in `vite.config.js` `plugins`. See §22. |
| `lib/purchasing-money.mjs` | Pure money maths for §22: `apportion` (largest-remainder, exact to the cent), `splitEvenly`, `allocateCharges`, `perUnitFeesCents`, `blendUnitCents`, `effectiveFx`, `toAudCents`, `paidCents`, `paymentStatus`. No DOM, no fetch, no DB — the `lib/fees.mjs` shape. |
| `lib/certlookup.mjs` | Multi-company cert-lookup registry powering `/api/cert`. Dispatches to a per-company provider (PSA only today) else returns `{matched:false, verifyUrl}` (official cert page) for manual entry. Reads `data/grading-companies.json`. The single extension point for adding new company lookups. |
| `lib/psa.mjs` | PSA public cert-verification provider (`lookupCert`) used by `lib/certlookup.mjs`. Needs `PSA_API_TOKEN`; `{matched:false}` on missing token/any failure. Field mapping UNVERIFIED against a live token. |
| `data/grading-companies.json` | Inventory-facing grading-company registry (12: PSA/BGS/CGC/SGC/TAG majors, plus ARK, TCG Grading, Card Grading Australia, PCG (Western Premier Card Grading), PCGCN (unrelated Chinese PCG, pcgcard.cn), EMC (Encapsulated Memories Company), JBH (Joyful Box House)): label, scale, cert format, official `certUrl` (nullable when no public page), `lookup` flag, region. Add a company here by appending a row — dropdowns are data-driven. **Broader** than the pre-grader's tolerance set in `grading.config.json` (which stays PSA/BGS/CGC/SGC/TAG — don't add companies there without real tolerances, Golden Rule 4). Shared by server (`certlookup.mjs`) + client (`inventory.html`). |
| `card-grader.html` | **Pre-grading tool** ("is this raw card worth a grading fee?"). Guided 12-shot capture wizard (flatbed scan / microscope / camera / upload), centering pad with draggable guides, AI condition pass, per-company grade prediction, TAG-style annotated report (defect pins + per-corner grid) + PDF, saved reports, and the "To pipeline" handoff into §13's submissions. See §21. |
| `grade-rules.js` | Pure, transparent grade-prediction engine (`window.GradeRules`), loaded like `extras.js`. Every tolerance/weight comes from `data/grading.config.json` — data, never hardcoded logic. `sideFromCorners`/`sideFromEdges` aggregate the v2 granular cells (min + mean; all-null → null). Config-table-driven unit tests in `test/unit/grade-rules.test.mjs`. A documented approximation, never the companies' real math (GR4). |
| `grade-report-pdf.js` | The printable grading report (`GradeReportPDF.build(data)` -> jsPDF doc). Print design, not the screen theme: ink on paper, times/helvetica/courier standing in for Fraunces/Plex/Plex-Mono, vector centering diagrams drawn to the measured mm. Never throws; sections drop out when their data is missing. |
| `lib/grader.mjs` | `/api/grade` AI vision condition pass (Anthropic/OpenAI dual provider). Schema v2: up to 12 labeled shots, per-corner + per-edge findings per side, defects pinned `{imageRef,x,y}`; `normalize()` still accepts the v1 flat shape (flat aggregates = MIN of the granular cells). See §21. |
| `lib/scan.mjs` | `scanPlugin` → `/api/scan`: flatbed scanning for the pre-grader (WIA via `scripts/wia-scan.ps1`) — capability probe, busy lock, auto-centering + confidence-gated crop. See §21. |
| `lib/scan-centering.mjs` | sharp-based centering analyzer (lazy `getSharp`): outer card edge via ring-median background + run-gated row/col profiling + a 63:88 aspect sanity check; inner frame via the strongest sustained gradient 2–12% inward over the central 60% of each edge; per-edge confidence; full-art → `inner:null`; never throws. |
| `scripts/wia-scan.ps1` | The WIA COM scan helper (`powershell.exe` 5.1, `-NonInteractive`). Contract: exactly ONE JSON line on stdout; BMP transfer → `ImageProcess` Convert → PNG; **resolution set before extent** (the driver's max extent scales with the DPI already set); SaveFile target pre-deleted; never `WIA.CommonDialog`. |
| `lib/pregrade.mjs` | `pregradePlugin` → `/api/pregrade`: saved pre-grade reports — CRUD + per-shot image upload + immutable content-addressed file serving. See §21. |
| `lib/pregrade-store.mjs` | The pregrade store: `pregrade_reports` / `pregrade_images` (`UNIQUE(report_id,shot_id)`, cascade) + the content-addressed byte store `data/pregrade-images/` (sha-named, refcounted delete). |
| `data/grading.config.json` | The pre-grader's editable company data: tolerances, weights, grade steps, fees + turnaround. **PSA/BGS/CGC/PCG/TAG only** (SGC → PCG 2026-08-22, owner call — the store grades locally; SGC stays in the registry) — narrower than `data/grading-companies.json` on purpose; don't add a company here without real tolerances (GR4). PCG's centering bands are PUBLISHED, the one non-approximation. PSA/BGS/CGC/TAG fees `asOf` 2026-06-24 (refresh deferred); PCG fees 2026-08-22, AUD-converted. |
| `data/pregrade-images/` | Content-addressed capture bytes for saved reports (gitignored). **NOT regenerable** — the photos exist nowhere else; backup coverage is an open decision (§21). |
| `data/tracker.db` | SQLite price history (gitignored, WAL). Created on first server boot. |
| `data/tracker.config.json` | Tracker cadence + signal thresholds (editable). |
| `lib/telegram.mjs` | Dependency-free Telegram Bot client (global `fetch` only): `sendMessage`+inline buttons, `editMessageText`, `answerCallbackQuery`, and a singleton HMR-guarded **long-poll loop** (NAT-friendly — no webhook). Powers the repricer's alerts + one-tap Approve/Skip. Token is `.env`-only, never reaches the browser. See §15. |
| `lib/repricer-db.mjs` | The store-repricer's SQLite store — a **separate** `data/repricer.db` (not `tracker.db`): `listings` / `price_checks` / `reprice_proposals` / `seen_chats` / `meta`. Same `node:sqlite`/WAL approach as `lib/db.mjs`. |
| `lib/repricer.mjs` | Vite plugin: owns `data/repricer.db`, exposes `/api/repricer/*`, runs the Telegram poller, and (Phase 2+) hosts the eBay user-token OAuth consent flow. Registered in `vite.config.js` `plugins`. See §15. |
| `lib/ebay-oauth.mjs` | eBay **user-token** OAuth (Authorization Code grant): consent URL, code→refresh-token exchange, headless refresh, and an encrypted-at-rest refresh-token store (`data/ebay-oauth.json`). Distinct from the client-credentials **app** token in `vite.config.js` (which stays for Browse/Insights). |
| `lib/ebay-trading.mjs` | Low-level Trading (XML) API caller: signs requests with the OAuth user token via `X-EBAY-API-IAF-TOKEN` (site 15 / AU), plus `getUser`/`geteBayOfficialTime` smoke calls. The `GetMyeBaySelling`/`ReviseInventoryStatus`/`ReviseFixedPriceItem` builders land here in Phases 3–4. |
| `data/repricer.db` | Store-repricer SQLite (gitignored, WAL). Created on first server boot. |
| `data/repricer.config.json` | Repricer guardrails + cadence (up-only thresholds, min comps/confidence, TTL). Tracked (like `tracker.config.json`). |
| `data/ebay-oauth.json` | Encrypted eBay refresh token + metadata (gitignored). Written after the one-time consent. |
| `orders.html` | **Fulfilment** dashboard: the to-pack queue with one-tap packing slip / combined slip / address label / pick sheet, plus Mark picked and Mark shipped. Tabs are `To pack` / `Upgrades` / `All`; the pack queue is ordered by eBay's **dispatch deadline** (`HandleByTime`), not by paid date. Each row carries its postage tier as a chip, a tinted left rail and a draining deadline bar, and an upgraded order swaps its primary action to **Buy label on eBay ↗** (Seller Hub deep link) while the thermal address label demotes — see §4 postage below. |
| `purchasing.html` | **Purchase orders / incoming stock** — the INBOUND mirror of `orders.html`. Register (`Outstanding` / `Preorders` / `To reconcile` / `Received` / `Cancelled` / `All`) with a status-coloured rail and a payment pill; an order drawer with a receipt-style totals ledger, the payments block and the settled-AUD entry; a filtered picker over held stock for restock lines; and the **receiving bench** — count, reason codes, per-line splittable storage spots, then a preview of exactly which SKUs get `+N` before anything moves. House gold. See §22. |
| `postsale.html` | Post-Sale Messenger: the buyer-message queue (draft / approve / send / reply handoff) with an edit modal. |
| `lib/postsale.mjs` | Vite plugin: owns `data/postsale.db` and `/api/postsale/*`, runs the order poll, reply poll and pack digest, reconciles orders to stock, and drafts/routes buyer messages. `ingestOrder` adopts a new order; **`refreshOrder` keeps one current** — that is the path every eBay-side dispatch comes back through, whether a Seller Hub postage label was bought (eBay writes the tracking number onto the order and marks it shipped by itself) or the seller simply bulk-ticked "mark as dispatched". `attachPostage` decorates every read with the postage view the dashboard and both print docs consume. `dispatchOrder` is the single hand-dispatch path shared by the API route and the digest button. Registered in `vite.config.js` `plugins`. |
| — the daily digest's bulk buttons | The morning digest's two messages carry **Mark all N picked** (local, one tap) and **Mark all N shipped** (a CompleteSale per order, so it asks first). Membership is **frozen in `pack_digests` + `pack_digest_orders` before either message is sent**, and the buttons carry that digest's id — nothing is re-derived at tap time, so a tap can only ever touch the orders its own message named. Two digests the same day (the DIAG trigger allows it) each keep their own list. Bulk dispatch holds an atomic claim on `pack_digests.dispatch_started_at` against a double tap and releases it in a `finally`; a failed eBay write leaves that order unshipped so it returns in the next digest. Callback prefixes `psp:` / `psdq:` / `psdy:` / `psdn:` + digest id; they must not collide with the approve/skip `psa:` / `pss:` + message id. |
| — **the pack queue is ours, not eBay's** | **eBay flips an order to `shipped` the instant a postage label is BOUGHT, normally while the cards are still on the shelf** — taking that at face value deleted the order from the pack queue, the pick sheet and the digest before anyone had touched it. So `refreshOrder` stamps `orders.label_bought_at` and the order keeps its place. The rule is now simply **if eBay flipped it and we did not, a label was bought** (`!prev.dispatch_source && !prev.picked_at && !prev.label_bought_at`) — it used to also require a tracking number or a tracked tier, but **an eBay-bought Australia Post Regular Letter label is untracked**, so that test settled straight to `posted` exactly the orders it was meant to hold, and five vanished off the fulfilment page before it was noticed. A bulk **"mark as dispatched"** is now held too; that costs one tap of "Packed & posted", which is the recoverable side of the trade. `picked_at` is never stamped by the poll (a background job may not assert that a human packed something; `dispatchOrder`, driven by a button, may). Every queue read goes through the single `IN_QUEUE_SQL` / `NEEDS_PACKING_SQL` / `LABEL_BOUGHT_SQL` predicates in `lib/postsale.mjs` rather than `shipped_status`. `attachFulfilment` derives the state the UI labels: `to_pack` → `label_bought` → `to_post` → `posted`. `dispatchOrder` short-circuits the eBay call for anything eBay already has shipped (which is also the double-tap guard) and just records that the parcel has gone. `settleLabelBought` + `POST /api/postsale/diag/settle-label-bought[?apply=1] {ids:[…]}` clears NAMED orders out of the queue — it takes ids because nothing can pick them automatically any more. |
| `lib/postsale-db.mjs` | `data/postsale.db` schema (`buyers` / `orders` / `order_line_items` / `postsale_messages` / `member_messages` / `fee_transactions` / `cases` / `meta`) + idempotent migrations. `postsale_messages` is unique on **(order_id, kind)** — `purchase` / `dispatch` / `delivered` — via the one migration that rebuilds a table, preserving ids because Telegram approval callbacks are keyed on them. |
| `lib/postsale-llm.mjs` | Drafts the buyer messages (dual provider, never throws). `systemPrompt` for the thank-you, `followUpSystemPrompt` for dispatch/delivered, one shared `voiceRules` block so the store voice can't drift between them. `guardrailScrub(body,{allow})` is the hard server-side check for eBay's off-platform-contact policy; `dispatchFacts` stamps the tracking number on **after** the model, so it can never be mistyped, and hands the guardrail the literals to allow. |
| `lib/postage.mjs` | The only postage vocabulary in the app: `classifyPostage` (standard / paid / tracked / express), `deliveryWindow`, the URL templates, and the `GeteBayDetails` service-name catalog cached to `data/ebay-shipping-services.json`. Pure above the catalog section, so the whole rule set is table-tested offline. |
| `label-render.js` | Shared `window.LR` print layer: thermal address label (canvas → 1-bpp → `/api/print`), `packingSlipHTML` (adaptive single-A4, greyscale, branded, combined-order aware) and `pickSheetHTML` (box-grouped pull list). Postage rule: **only exceptions get ink** — tiers are told apart by border weight, never a filled background, because browsers print with "Background graphics" off by default and a reversed block would come out invisible. |
| `data/postsale.config.json` | Post-sale + fulfilment config (gitignored, seeded from `.example`, backfilled on boot including one level into `postage`). Editable in `settings.html`. |
| `.claude/skills/price-analyst/SKILL.md` | Skill for the daily headless analysis (read export → research → flag → auto-add → digest → notify). |
| `scripts/notify.ps1` | Windows desktop toast (WinRT, `msg.exe` fallback) for signal alerts. |
| `scripts/run-claude-analysis.cmd` | Task Scheduler entry point for the daily `claude --print` analysis. |
| `settings.html` | **Settings & Status** page: API-key presence + per-source health (explicit "Test now" probes — never automatic, Scrydex bills per call), baked-data freshness, DB/subsystem state, and edit forms for the four operational configs (tracker/repricer/bulk-pricing/refresh). Linked from `index.html`. |
| `lib/status.mjs` | Vite plugin behind `settings.html`: `/api/status` (aggregate, key presence as BOOLEANS only — never values; incl. `jobs.refresh`/`jobs.collector` last-run + next-run records) + `/api/status/probe/:source` (allowlisted, 15-min cached) + **DIAG_TOKEN-gated** remote diagnostics `GET /api/status/logs` (scrubbed console ring buffer, `lib/logbuffer.mjs`; `?tail=`/`?level=`/`?tag=`, and the reply's `tags` index names every subsystem in the buffer with a count — eviction is fair-share by tag, so a chatty source cannot push a quiet one out) / `POST /api/status/refresh` / `POST /api/status/collect` (unset token ⇒ 503) + `/api/settings` (GET all / PUT the four editable configs with per-file validation, atomic write, and collector/refresh timer restarts). |
| `test/` | The test suite (`node:test`, §8): `unit/` per-lib tests, `invariants/` golden-rule guards + wrapped §14 harnesses, `data/` catalog/config audits, `integration/` real-server API tests (temp DBs), `helpers/` shared extraction/boot utilities. |
| `README.md` | Human run + hosting instructions. |
| `docs/DATA_SOURCES.md` | Per-game API endpoints, response schemas, key handling, rate limits. |
| `vault.css` | Shared **"Vault Ledger"** design layer (§7 / `DESIGN.md`). Linked after each builder/grader/shipping page's inline `<style>` to re-theme the neutral CSS vars + Fraunces/IBM Plex fonts + atmospheric background; each page keeps its own `--gold` accent. |
| `DESIGN.md` | The suite-wide "Vault Ledger" design system: palette, typography, `vault.css` layering, the per-company slab badge, the Collectr-style card-in-slab preview. Read before restyling shared UI. |

---

## 5. Architecture & data flow

**Proxies** (`vite.config.js`) — each strips its `/api/x` prefix and forwards:

| Route | Target | Auth / notes |
|---|---|---|
| `/api/pkm` | `api.pokemontcg.io/v2` | Optional `X-Api-Key` from `POKEMONTCG_API_KEY` (keyless works, lower limit). |
| `/api/mtg` | `api.scryfall.com` | Adds `User-Agent` + `Accept`. No key. |
| `/api/swu` | swu-db API | No key. |
| `/api/lorcana` | `api.lorcast.com/v0` | Keyless Disney Lorcana API. One call returns image + gameplay + `prices.{usd,usd_foil}` (USD, daily). No key. `GET /sets` (cached, `lib/lorcana-sets-cache.mjs`), `GET /set/:id/cards` (whole set in one request, untrimmed) and `GET /cards/:set/:num` are served from disk by plugins; anything else falls through to Lorcast. |
| `/api/rb`  | `api.scrydex.com/riftbound/v1` | Injects `X-Api-Key` + `X-Team-ID` from `.env`. **Optional, and currently `402 SUBSCRIPTION_INACTIVE`** — the subscription lapsed, so this serves nothing. Still the `lookupPath()` target for the card RECORD (name/images). Prices moved to `/api/riftbound/prices`. |
| `/api/rbs` | `riftscribe.gg/api` | Keyless community Riftbound card API (live alternative to Scrydex). No key. |
| `/api/riftbound/prices/:key` | (middleware, `lib/riftbound-prices.mjs`) | **Keyless Riftbound market prices** from the baked `data/riftbound-prices.json` (TCGplayer public search API). The collector's `pricePath()` target — replaced Scrydex after its 402. NOT named `/api/rbp`: the `/api/rb` proxy prefix-matches and would swallow it. 200 priced · 404 no price yet · 503 index never baked. |
| `/api/fx`  | `api.frankfurter.app` | FX rates for AUD conversion. No key. |
| `/api/img` | (middleware) | Streams any remote image same-origin so the browser can blob-download it. |
| `/api/lego/rebrickable` | `rebrickable.com/api/v3/lego` | Injects `Authorization: key <REBRICKABLE_API_KEY>`. LEGO set/minifig lookup. |
| `/api/lego/brickset` | `brickset.com/api/v3.asmx` | Appends `apiKey` (a **query param**) in `rewrite()`; client sends `userHash=`. RRP/age/dims. |
| `/api/lego/bricklink` | (middleware) | **OAuth1 HMAC-SHA1 signing** per request (4 BrickLink creds). New/used price guide. Needs the server IP registered in the BrickLink console. |
| `/api/ebay` | (middleware) | Mints+caches an **OAuth2 client-credentials** app token; injects `Bearer` + `X-EBAY-C-MARKETPLACE-ID`. Funko Browse pricing + live name search + Taxonomy item-specifics. **Production keys only** (`SBX-` sandbox keys fail the token mint with `invalid_client`; the middleware surfaces the real error instead of a blind 502). |
| `/api/pc` | (middleware) | **Keyless** PriceCharting scrape (Pokémon graded/raw/pop) via `lib/pricecharting.mjs`. `GET /api/pc/lookup?name=&number=&set=&id=`. Display-only; always returns `{matched:false}` on failure (Golden Rule 7). Optional `PRICECHARTING_TOKEN` switches it to the official API. |
| `/api/grade` | (middleware) | **POST-only** AI vision condition pass for `card-grader.html` (`lib/grader.mjs`, Anthropic/OpenAI). Returns `ok:false` (never 500) so the tool degrades to centering-only. |
| `/api/scan` | `scanPlugin` (`lib/scan.mjs`) | Flatbed scanning for `card-grader.html`. `GET /` = capability probe (live WIA enumeration cached 60s, `SCANNER_ENABLED=false` kill switch, `analyzeAvailable`) — a box with no scanner answers `enabled:false`, never an error (GR7). `POST /` `{side,dpi,analyze?}` runs one scan (module-level 409 busy lock, 90s timeout, temp cleanup in `finally`, auto-centering + confidence-gated crop). `POST /analyze` = centering analysis on an image the client already holds (uploads). See §21. |
| `/api/pregrade` | `pregradePlugin` (`lib/pregrade.mjs`) | Saved pre-grade reports. `POST /` create · `POST /:id/images` (ONE image per request, 28MB cap) · `GET /` list (LEFT-JOINs the linked submission's `submission_id` + `actual_grade`) · `GET/PATCH /:id` · `DELETE /:id` (refcounted byte unlink) · `GET /file/<sha>.<ext>` (immutable content-addressed image bytes). See §21. |
| `/api/cert` | (middleware) | **Multi-company** graded-slab cert lookup (`lib/certlookup.mjs`) for the inventory add form. `GET /api/cert?company=PSA&cert=…` → `{matched, identity, grade, company, verifyUrl, …}`; `GET /api/cert/providers` → the company registry. PSA auto-fills (`PSA_API_TOKEN`); every other company has no public API ⇒ `{matched:false, verifyUrl}` (official page, or null) + manual entry (Golden Rule 7). |
| `/api/inventory` | (plugin) | Graded-card **inventory** API (`lib/inventory.mjs`): `GET/POST /items`, `GET/PATCH/DELETE /items/:id`, `POST /items/:id/refresh-value` (PriceCharting graded value), `POST /items/:id/value-manual`, `POST /items/:id/fetch-image` (resolve+cache card image), `GET /items/:id/valuations`, `GET/POST /submissions`, `PATCH/DELETE /submissions/:id`, `POST /submissions/:id/promote`, `GET /summary`, `GET /export`. See §13. |
| `/api/purchasing` | (plugin) | **Purchase orders** (`lib/purchasing.mjs`): `GET/POST /orders`, `GET/PATCH/DELETE /orders/:id`, `POST /orders/:id/lines`, `PATCH/DELETE /lines/:id`, `POST /lines/:id/count`, `GET/POST /orders/:id/payments`, `DELETE /payments/:id`, `POST /orders/:id/settle`, `POST /orders/:id/receive[?dry=1]`, `GET /orders/:id/receipt`, `POST /orders/:id/close`, `GET /stock` (restock picker), `GET /submissions` (open grading submissions), `GET /suppliers`, `GET /statuses`, `GET /discrepancy-codes`, `GET /summary`. See §22. |
| `/api/print` | (middleware) | Streams a browser-rasterised label bitmap to the **AUSPRINT PRO** (Rongta/TSPL) over raw TCP **9100** (`lib/labelprint.mjs`). `POST {jobs, speed?, density?}` — top-level `speed`/`density` (one per batch) are clamped and merged over config before `buildJob`. `GET` returns `{enabled,dpi,ip,page,offXmm,offYmm,speed,density}` so `shipping-label.html` / `pdf-print.html` can enable Print, pick rasterise DPI, and seed the Darkness/Speed steppers. **`offXmm`/`offYmm` are the ADDRESS-label calibration only** — `shipping-label.html` and `orders.html` both resolve it the same way (localStorage `ship_offx`/`ship_offy` wins, else this GET) and apply it to the printed raster only, never the preview or the PNG fallback; their 5mm margin absorbs the shift. `pdf-print.html` deliberately ignores it and keeps its own nudge (localStorage `pdfprint_offx`/`offy`, default 0) because dropped PDFs are often full-bleed, and its Fit modes shrink the page to reserve room so a nudge can never clip ink. Config = `.env` `LABEL_PRINTER_*`; unset ⇒ disabled, tool stays download-only (Golden Rule 7). No new deps (pure `node:net`). |
| `/api/repricer` | `repricerPlugin` (`lib/repricer.mjs`) | Store repricer + Telegram. `/config`, `/me`, `/chatid`, `/proposals`, `POST /test-alert`; `/oauth`, `/oauth/start`, `POST /oauth/exchange`, `/oauth/status`, `POST /oauth/test` (eBay user-token consent). Owns `data/repricer.db` + the Telegram long-poll loop. See §15. |
| `/api/listings` | `listingsPlugin` (`lib/listings.mjs`) | **eBay stock uploader** (Sell Inventory API). `GET /config`; `GET /account/status`, `POST /account/bootstrap` (opt-in business policies + create AU payment/return/fulfilment policies + merchant location), `GET /account/privileges`; `POST /preview` (dry-run: build+validate+resolve descriptors+upload EPS images+listing fees), `POST /publish` (create→offer→publish, idempotent on SKU, writes back `ebay_listing_id`/`ebay_offer_id`/`channel_status` + the `ebay_listings` mirror + a `listing_pushes` audit row), `POST /price` (eBay AU singles comps → suggested list price, own listings excluded), `POST /photos` + `DELETE /:id/photos` (owner photos → eBay EPS, base64), `POST /:id/revise-price`, `POST /:id/withdraw`, `GET /:id`, `GET /reconcile-state`, `POST /reconcile` (DIAG-gated — check our mirrored listings vs eBay, mark ended/out-of-stock drift). UI: `stock-uploader.html`. Config `data/ebay-listing.config.json` (server-owned). See §17. |
| `/api/status` | `statusPlugin` (`lib/status.mjs`) | System dashboard for `settings.html`. `GET /` = version + key PRESENCE (booleans only, GR2) + source health (passive: `card_cache` recency, `watchlist.last_error`; plus cached probes) + baked-data freshness + DB/subsystem stats. `POST /probe/:source` = one explicit cheapest-call probe through the existing proxy, cached 15 min — **never auto-probed** (Scrydex bills per request). |
| `/api/settings` | `statusPlugin` (`lib/status.mjs`) | `GET /` lists all `data/*.config.json` (+editability); `GET/PUT /:name` for `tracker`/`repricer`/`bulk-pricing`/`refresh` only — schema-validated (e.g. repricer `never_decrease` must stay true), atomic tmp+rename write, tracker/refresh writes restart their timers live. `.env` is never readable/writable here. |

**`extras.js` public surface** (`window.TCG`):

| Function | Does |
|---|---|
| `renderExtras(el, {name, images, prices, history, priceNote, pcLink})` | Image + price panel. `prices[]` rows carry optional `source`/`measure`/`group`(market/graded/asking)/`note`/`conf`/`spread` — renders a **Market consensus** + **cross-source divergence** flag, grouped sections, **AUD-first** (A$ primary, native secondary). Bare `{label,amount,currency}` still works. See `docs/DATA_SOURCES.md` → "Price-row model". |
| `loadFx()` / `toAUD(amount, cur)` | Fetch (cached) ECB rates via `/api/fx`; convert to AUD. |
| `condCode(s)` | **Card** condition string → eBay title code (`Ungraded, Near Mint` → `M/NM`, graded → `PSA 10`, etc.). Card-only — do **not** reuse for LEGO/Funko. |
| `langCode(s)` | Language → 2-letter code (`English` → `EN`). |
| `legoCondToken(s)` | LEGO condition enum → title token (`New Sealed`/`New`/`Used Complete`/`Used Incomplete`). |
| `funkoCondToken({grade,oob,boxcond,protector})` | Funko condition → title token (grade if graded, else box grade, else `Loose`; `w/ Protector`). |
| `renderItemSpecifics(el, pairs)` | Renders an eBay item-specifics name/value list + a Copy button (tab-separated). Used by LEGO/Funko. |
| `fitTitle(parts, max=80)` | Assemble an eBay title from prioritised parts; full → abbreviated → drop-lowest-priority until ≤ max chars. |
| `formatCardNumber(number, set, opts)` | **Pokémon collector number exactly as printed on the card** (Golden Rule 10) — era padding, promos without a `/total`, subset prefixes. `opts.source:'tcgdex'` for JP/CN/KO (numerator already card-correct); `opts.rarity` helps promo detection. Display-only. |
| `cardNumberKey(s)` | Padding-insensitive key for matching/dedupe (`106/86` ⇄ `106/086`). Not for display, not a lookup number. |
| `fetchJson(url, {tries, base, timeoutMs, onRetry})` | Fetch with backoff retry on network errors + 5xx/429 + a per-attempt abort timeout (default 8s), never on 404. Wraps pokemontcg.io, whose intermittent 500s **and 45s+ hangs** otherwise surface as a false "card not found" that only a refresh clears. |
| `histFromTrends(market, trends)` | Reconstruct a rough price series from Scrydex trend deltas (Riftbound graph). |
| `clear(el)` | Empty an extras panel. |
| `setCombobox({input, menu, items, onPick, display})` | Filterable dropdown with a per-row **icon** (reusable version of the Pokémon set picker — native `<select>`/`<datalist>` can't show images). `items` is an array or `()=>array` of `{value,label,code?,icon?}`. Self-themes + injects its own CSS. Used by MTG (Scryfall `icon_svg_uri`). |

**Per-lookup lifecycle in a builder:**

1. Init IIFE wires events, calls `loadSets()` and `render()`.
2. `doLookup()` resolves the set + number and `fetch`es through the proxy.
3. Response is mapped into the editable `f_*` inputs.
4. `render()` rebuilds the preview (`buildHTML`) and syncs the title (`syncTitle` → `genTitle` → `TCG.fitTitle`).
5. `TCG.renderExtras(...)` shows images / prices / (Riftbound) graph.

---

## 6. How a builder is structured (the `f_*` pattern)

Each builder's inline `<script>` follows the same shape. Learn it once:

- `base` — proxy base (e.g. `'/api/pkm'`), persisted in `localStorage`.
- Helpers: `val(id)`, `set(id,v)`, `esc(s)`.
- `readFields()` → `{name, num, set, rarity, ...}` from the `f_*` inputs.
- `buildHTML(f)` → the eBay description (inline styles only).
- `render()` → writes the preview `<iframe>` `srcdoc`, then `syncTitle()`.
- `doLookup()` → fetch + map API fields → `f_*` → `render()` + `renderExtras()` + `regenTitle()`.
- `loadSets()` → populate the set picker.
- `genTitle()` → build a `parts` array, return `TCG.fitTitle(parts, 80)`.
- Title helpers (shared, defined per file): `regenTitle()`, `syncTitle()`, `updateTitleCount()`, `copyTitle()`.

**Title `parts` model** (drives `fitTitle`): each part is
`{text, abbr?, prio}`. `fitTitle` first joins all `text`; if > max it swaps in
`abbr` where present; if still > max it drops the lowest-`prio` parts until it
fits. Higher `prio` = kept longer. Separators like `"- "` are baked into a
part's text so dropping a part never leaves a dangling dash. Reference format
(Riftbound, matches the owner's real listings):
`Kai'Sa - Survivor (Alt Art) 039a/298 - Riftbound Origins (OGN) EN SHOWCASE M/NM`.
Signature/Overnumbered carry `prio: 82` (above the rarity token and the condition
code) because they are a 10–100x price differentiator on an otherwise identical
card — `299*/298` is US$2,739 where `299/298` is US$296 — and an over-length
title used to shed the word `(Signature)` while keeping `M/NM`:
`Daughter of the Void (Signature) 299*/298 - Riftbound (OGN) JP SHOWCASE LP`.

---

## 7. Common tasks (recipes)

- **Add/relabel a field in a builder:** add the `<input>`/`<select>` with an
  `f_<name>` id; read it in `readFields()`; place it in `buildHTML()`; if it
  belongs in the title, add a part in `genTitle()`.
- **Change a title format:** edit that builder's `genTitle()` parts (text/abbr/
  prio). Don't touch `TCG.fitTitle` unless changing the global fit algorithm.
- **Tweak the eBay fee bands** (calculator): `feeAU()` / `listForTarget()` in
  `index.html`. Keep the forward (`feeAU`) and inverse (`listForTarget`) in sync,
  and keep cent-rounding. Validate with a few targets (see §8).
- **Port a Pokémon feature to other builders** (the cached symbol combobox, the
  EN/JP language tile): both currently live only in `pokemon-listing-builder.html`.
  Lift the combobox helpers (`loadSets`/`resolveSet`/`renderSetMenu`/`pickSet`,
  the `#setMenu`/`#langBtn` CSS, the init wiring) and adapt field ids.
- **Add a new game/builder:** clone the closest builder; add a `/api/<x>` proxy
  in `vite.config.js`; add a tile in `index.html`; implement `doLookup` mapping +
  `genTitle` for that game's schema (document it in `docs/DATA_SOURCES.md`).
- **Add a non-card product type (like LEGO/Funko):** clone the closest builder,
  but additionally (a) give it its own `condText()`/`postageText()` — do **not**
  reuse the card penny-sleeve/free-post wording (Golden Rule 6); (b) default the
  condition field to the *safest* option so un-edited listings under-promise;
  (c) add a `renderSpecifics()` that feeds `TCG.renderItemSpecifics` the eBay
  item-specifics pairs (confirm aspect names via the eBay Taxonomy API); (d) if
  the data source's auth isn't a static header (OAuth1/OAuth2), add a signing or
  token-minting **middleware** in `vite.config.js`, not a plain `proxy:` entry
  (see `bricklinkProxy`/`ebayProxy`).
- **Theme any new shared UI** with the existing CSS vars: `--gold`, `--line`,
  `--muted`, `--text`, `--field`, `--panel2`, `--panel`, `--ink`. Each page defines
  these (SWU aliases `--gold` to its yellow). The suite-wide **"Vault Ledger" look**
  lives in **`vault.css`** — linked after each page's inline `<style>`, it re-themes
  those neutral vars to one dark palette + Fraunces/IBM&nbsp;Plex fonts + an atmospheric
  background, while each page keeps its own `--gold` accent (games/tools stay
  identifiable). `index.html`, `tracker.html` and `inventory.html` carry the full
  styling inline; the builders / grader / shipping pages inherit it via the `vault.css`
  `<link>` (+ the two Google-Fonts links) before `</head>`. Never restyle inside the
  eBay preview iframe — it's a separate inline-styled doc (Golden Rule 8). See
  **`DESIGN.md`** for the full design system (tokens, typography, components, the
  per-company slab badge).

---

## 8. Validation

**`pnpm verify` must pass before any change is considered done** (the BJB rule, adapted).
It runs the two suites:

- **`pnpm test`** — offline, <1s. `test/unit/` (pure lib modules), `test/invariants/`
  (the six §14 `scripts/check-*.mjs` harnesses wrapped as tests, GR6 five-builder wording
  parity, GR8 no-`<style>/<script>` in eBay HTML, GR2 no-hardcoded-secrets scan, GR10
  no hand-rolled `number + '/' + printedTotal` on any Pokémon surface, and an
  automated inline-`<script>` `node --check` sweep of every page), `test/data/` (shape
  audits for the baked catalogs + schema pins for every `data/*.config.json` — e.g.
  repricer `never_decrease:true` is asserted, BJB config-audit style).
- **`pnpm test:integration`** — boots the REAL dev server (vite.config.js, all plugins)
  in-process on an ephemeral port with the SQLite stores redirected via `TCG_TRACKER_DB` /
  `TCG_REPRICER_DB` (never touches `data/*.db`) and the owner-editable configs redirected
  to a temp copy via `TCG_CONFIG_DIR` (never touches `data/*.config.json`, so a settings
  PUT can be exercised for real without dirtying the tree — `lib/config-paths.mjs` is the
  single resolver every config reader goes through). Exercises `/api/*`, including the
  `/api/status` no-secret-leak guard and `/api/settings` write validation.
- **Opt-in live smoke**: `$env:TEST_LIVE='1'; pnpm test:integration` probes each upstream
  once through the proxies (keyless sources must answer; keyed sources may be
  `auth_failed`/`billing` — that's a status, not a failure, GR7).

Conventions: tests are `test/**/*.test.mjs` on `node:test` (Node 24 built-in, no deps);
each file runs in its own process, so temp DBs / env overrides never leak. Shared helpers
live in `test/helpers/` — `extract-inline.mjs` (brace-count + vm extraction of inline
builder functions), `boot-server.mjs`, `tmp.mjs`. New lib modules get a unit file; new
golden rules get an invariant test; new config files get a schema pin in
`test/data/configs.test.mjs`.

Quick one-off syntax check (what the inline-syntax test automates):
`node --check extras.js` / `node --check vite.config.js`.

---

## 9. Secrets

`.env` (gitignored) holds:

```
SCRYDEX_API_KEY=...      # optional — Riftbound live pricing + trend (coverage is keyless)
SCRYDEX_TEAM_ID=...      # optional — pairs with SCRYDEX_API_KEY
POKEMONTCG_API_KEY=...   # optional; raises pokemontcg.io limit to 20k/day
REBRICKABLE_API_KEY=...  # LEGO lookup (self-service free key)
BRICKSET_API_KEY=...     # LEGO RRP/age/dims (free key, may need approval)
BRICKLINK_CONSUMER_KEY=...  BRICKLINK_CONSUMER_SECRET=...   # LEGO new/used pricing
BRICKLINK_TOKEN=...         BRICKLINK_TOKEN_SECRET=...       # (OAuth1; register server IP)
EBAY_APP_ID=...  EBAY_CERT_ID=...  EBAY_MARKETPLACE=EBAY_AU  # Funko pricing + item-specifics
EBAY_RUNAME=...          # repricer only — RuName for the user-token consent (localhost is rejected)
TELEGRAM_BOT_TOKEN=...   # repricer alerts + approvals (from @BotFather)
TELEGRAM_CHAT_ID=...     # target channel/group (-100... form; find via GET /api/repricer/chatid)
```

The **repricer's eBay writes need a `user` token, not the app token above.** `EBAY_APP_ID`/`EBAY_CERT_ID`
are reused (same keyset) but a one-time browser consent mints a refresh token (stored encrypted in
`data/ebay-oauth.json` — the single shared eBay user-token store, also seedable from a pasted
`EBAY_REFRESH_TOKEN`; bulk's Phase-2 Sell-API reuses the same token). See §15. `TELEGRAM_*` and
`EBAY_RUNAME` are all independent — unset just disables that piece (Golden Rule 7).
Each key is independent — a missing one just disables that source; every builder
still works for manual entry. BrickLink also requires the dev server's outbound
**IP to be registered** in the BrickLink API console, or calls 4xx.

Injected as headers in `vite.config.js`. Browser never sees them. If a tool
returns 401/403, the key is missing or wrong in `.env` — not a code bug. For
**eBay** specifically, the keys must be from a **Production** keyset (App ID =
Client ID, Cert ID = Client Secret); sandbox keys (`SBX-`) fail the OAuth token
mint with `invalid_client` and surface as a 502 with that detail. Never commit
`.env`; never echo a real key into `.env.example` or source.

---

## 10. Known limitations & roadmap

- **Every Pokémon lane now has a card source; what remains is bounded.**
  Reconciled 2026-08-23. TCGdex lists many intl sets with a card count but ships
  an **empty `cards` array**, so a set could sit in the catalogue with the
  printed code and nothing behind it while a code-less twin held the cards.
  **`ja`**: 121 sets joined to a verified PriceCharting console via Bulbapedia's
  Japanese-name → English-name mapping (an exact string join, never a
  transliteration), every console fetched and checked first. **`ko`**: derives
  from the Japanese twin — same set code, rosters verified identical (M5 matched
  118/118) — with images stripped, because PriceCharting does not scan Korean
  cards and a Japanese scan on a Korean listing shows the buyer the wrong card.
  **`zh-cn`**: a new keyless source, 52poke's MediaWiki (`lib/wiki52poke.mjs`).
  Coverage gaps 167 → 66 (ja 59→24, ko 92→20, zh-cn 35→7).
  **Deliberately left unbound:** the fifteen `CS*` codes TCGdex hands one set's
  identity to (their 101-card count contradicts the real Triplet Beat's 73, which
  is how `SV1A` was identified as genuine), the Korean mirror of that same block,
  four Korean sets whose Japanese twin has no console either, and the sets with
  no console under any candidate (`ADV1`, `PMCG5`, `SVK`, `SV-P`, `M-P`, the
  starter decks). Fuzzy-matching those on name, date or card count would
  eventually bind the wrong set, and a mislabelled set is worse than a missing
  one (GR4). The seven Chinese stragglers are the newest Mega-era sets 52poke has
  not written up; that lookup is live, so they heal themselves when it does.
  **`zh-tw` (15) has no source at all** — no PriceCharting bucket, no wiki
  equivalent. The live list is always in `data/pokemon-coverage.json` and the
  Settings coverage card.
- **Production hosting** needs a backend (proxies are dev-only — Golden Rule 1).
- **Riftbound price graph** no longer has Scrydex *trend deltas* to reconstruct
  from — that subscription lapsed (402) and prices now come from the keyless
  TCGplayer bake, which carries no trend percentages. The graph falls back to
  deltas computed from local `price_snapshots`, so it fills in as history
  accrues (one point per collector pass) rather than being available instantly.
- **The Riftbound builder's `scrydex` source** is dead while the subscription is
  inactive, but it no longer matters for price: `rbPriceEnrich()` overlays the
  keyless TCGplayer market price on **every** lane (offline / riftscribe /
  scrydex / rune), so the default offline source now shows a price and feeds
  `_trk.price`. Scrydex's only remaining exclusive is the trend graph.
- **The Riftscribe lane lags a set behind.** riftscribe.gg carries OGN/OGS/SFD/UNL
  (~950 cards) and has no Vendetta yet, so that source shows four pills where the
  default offline one shows five. Nothing to do but wait — the pills, their names
  and their order already derive from the baked catalog, so Vendetta appears there
  by itself the moment riftscribe ingests it.
- **`UNL-238` Baron Nashor is the one variant label that is hardcoded**, in
  `TREATMENT_OVERRIDE` (`scripts/build-riftbound-data.mjs`). TCGplayer calls it
  "(Ultimate)" at ~US$1,635 — 3x the set's Signatures — and Riot's gallery gives
  it nothing to derive from (epic / unit / portrait, identical to its
  neighbours), so the number alone would call it Overnumbered. The hardcode is
  fenced: keyed by identity, no Signature sibling to collide with (UNL stars stop
  at `237*`), and `test/data/riftbound-variants.test.mjs` asserts every override
  entry still matches TCGplayer's own product name on each run, so a stale one
  fails loudly. Add to that map only when the printed number genuinely cannot
  imply the treatment.
- **Rune reprints have no price.** The index carries the 12 runes only under
  their Origins printed numbers; the per-set `R##` reprints are separate
  TCGplayer products it skips. The builder prices a rune only on OGN and says so
  otherwise, rather than showing Origins' figure for different art.
- ~~A watched rune can't be re-priced by the collector.~~ **Fixed.** `R##` is the
  numbering on the *reprint* sets only — Origins prints its runes `007a/298` etc
  (the bake carries all 12; no other set carries any). `runeFill()` resolves the
  card's real number once and uses it for the field, the `identity_key`, the
  dotgg URL and the price, so typing `R01a` and `7a` on Origins now produce one
  identical card (`OGN-7a`, matching the stored watchlist rows and the price
  index) and the buyer-facing "Card number" row stops saying `R01a` for a card
  that reads `007a/298`. A reprint keeps `SFD-R01a` — there it IS the printed
  number. No migration was needed: no `R##` key had ever been persisted.
- **Language tile + cached symbol combobox** exist only in the Pokémon builder so
  far; the others use a simpler picker and plain language field.
- **Finish/printing can't be inferred** from the APIs (Holo vs Reverse Holo;
  Foil vs Nonfoil vs Etched) — these stay manual dropdowns; don't auto-overwrite.
- **pokemontcg.io is a legacy endpoint** now under Scrydex; if it's ever
  deprecated, repoint `/api/pkm` (to a pokemontcg key tier or Scrydex).
- **Set caching is per-browser** (`localStorage`); each LAN client builds its own
  on first use and refreshes in the background.
- **Pricing calculator** computes the buyer-facing total only (buyer-protection
  fee), not the seller's net after eBay selling fees.

---

## 11. Domain context (just enough to make good calls)

Market is **AU/NZ**; prices shown/sold in **AUD**; postage model is **free
postage within Australia**. eBay AU's **buyer protection fee** is what the
landing-page calculator backs out. Cards are sold as raw (graded handled too).
The five card games with a **live card-data pipeline** (builder + tracker + price mapper) are
Pokémon, Magic: The Gathering, Star Wars: Unlimited, Riftbound, and Disney Lorcana — the
`GAMES` list in `lib/normalize.mjs`. **Two game lists, don't conflate them:** `GAMES` is card-data
games (every entry MUST have a mapper + lookup path + image extractor — enforced by
`test/unit/normalize.test.mjs`); **`STOCK_GAMES`** (= `GAMES` + `onepiece`) is the games you can
hold in **inventory** — the graded (`lib/inventory.mjs`) + sealed (`lib/sealed.mjs`, which also adds
`'other'`) tools validate against it. One Piece is stockable (recorded manually / sealed-barcode-priced
via PriceCharting) but has **no card API**, so it stays out of `GAMES` — adding it there would break the
tracker + card builders. A new stockable-only game goes in `STOCK_GAMES`, not `GAMES`. The tool also lists **LEGO sets** and **Funko Pop!
vinyl** — boxed collectibles whose condition (sealed/used-complete, box grade)
and postage (bulky/calculated, not free penny-sleeve) differ from cards, which is
why those builders carry their own condition/postage wording and item specifics. Accuracy of set / number / variant / condition in titles and item
specifics directly affects whether a sale sticks (eBay "not as described"
disputes), so correctness there outranks cleverness.

---

## 12. Price tracker (caching + trends + Claude analysis)

A prototype layer that persists prices so the owner can spot opportunities. Scope:
the five **card games** only (LEGO/Funko deferred — fuzzier identity, no clean
price API).

**One process owns it: the Vite service.** `trackerPlugin(env)` (in `lib/tracker.mjs`,
registered in `vite.config.js` `plugins`) opens `data/tracker.db`, serves
`/api/tracker/*`, and starts an in-process collector (`setInterval`, default 24h,
singleton/HMR-guarded). To honour Golden Rule 1, the collector **self-fetches its own
proxy** (`http://127.0.0.1:5273/api/rb|mtg|pkm|swu|lorcana|fx`) — reusing all existing auth
with zero proxy duplication. It maps responses via `lib/normalize.mjs` (Golden Rule 9),
stores native + AUD prices, and computes signals. Every successful fetch also upserts the
**full raw upstream payload** into `card_cache` (one row per card, latest wins) — a durable
local copy of whatever a source returned, which also conserves credits (Scrydex bills per
request). Read it via `GET /api/tracker/cache/:id`.

**Single writer.** Only the Vite process writes the DB (collector + API). The daily
Claude run is a **separate process that touches data only over HTTP** — never the
`.db` file — which keeps the single-writer model and avoids lock contention. WAL +
`busy_timeout` cover UI-read / collector-write overlap.

**Signals** (`computeSignals`, thresholds in `data/tracker.config.json`): Riftbound uses
Scrydex `percent_change` deltas when the response carries them (Growth+ tier); otherwise —
and for every other game — it computes % vs the snapshot nearest 7d/30d ago (tier-agnostic,
so it works on Scrydex Starter / keyless sources, just needs a few days of history first).
Watched-card drops →
`opportunity`; held-card (`source:'user'`) drops → `downtrend`; rises → `momentum`.

**Adding cards:** each builder's "Track price" button (after a successful lookup) posts
the resolved identity + current price via `TCG.addToTracker`. Claude auto-adds
discovered cards as `source:'claude', review_status:'pending'` for the dashboard's
review queue.

**`/api/tracker/*`:** `GET/POST/PATCH/DELETE /watchlist`, `GET /history/:id`,
`GET /signals`, `POST /refresh`, `POST /signals/:id/ack`, `POST /notified`,
`GET /cache/:id` (raw payload), `GET /export` (the Claude bundle), `GET /config`.

**Key formats** (what the collector re-fetches by): Riftbound `OGN-296`, MTG `neo-1`,
Pokémon `sv4-25`, SWU `sor/010`. Riftbound prices are **keyless** now — the collector uses
`pricePath()` (→ `/api/riftbound/prices`), not `lookupPath()`, because Scrydex went 402
`SUBSCRIPTION_INACTIVE` and was the game's only price source. A missing bake sets
`last_error='rb_index_missing'`; the `scrydex_unauthorized`/`scrydex_inactive` codes remain for a
reactivated subscription. ⚠ The whole watchlist is Riftbound, so if that one lane breaks,
`price_snapshots` stops accruing for **every** game — that is how it sat empty until 2026-07-30.

**`node:sqlite`** (built-in, Node 24) keeps deps vite-only; the launcher passes
`--disable-warning=ExperimentalWarning`. Fallback is `better-sqlite3` — change only the
import in `lib/db.mjs`.

---

## 13. Graded-card inventory (Binders Keepers)

Phase 1 of turning the suite into an inventory platform (eventual source of truth for
eBay/Shopify). Scope now: **graded-card stock**, cost basis / P&L, live graded valuation,
and a grading-submission pipeline. Slab photos + channel push are deferred (reserved columns
`ebay_listing_id`/`shopify_product_id`/`channel_status` in the schema).

**Same DB, new tables.** `lib/db.mjs` DDL gains `inventory_items`, `inventory_valuations`,
`grading_submissions`, `sku_counter` (idempotent `CREATE TABLE IF NOT EXISTS`, so existing
`tracker.db` users just get the tables on next boot — no migration). Money is INTEGER CENTS
(Golden Rule 3). An item can FK a `watchlist` row (`watchlist_id`) so the collector keeps its
raw market price fresh; **graded** value is separate (see below). `inventoryPlugin(env)` in
`lib/inventory.mjs` shares the same `openDb()` handle as the tracker and serves `/api/inventory/*`.

**Valuation.** `POST /api/inventory/items/:id/refresh-value` calls `lib/pricecharting.mjs`
`lookup()` and maps its `ladder{label→cents}` to the item's `grading_company`+`grade`
(`PSA 10` → `Grade 9` → raw anchor). Stored as USD cents + a row in `inventory_valuations`
(history → the value sparkline). A user override (`value_manual=1` via `/value-manual`) is not
overwritten by a refresh unless `?force=1`. eBay graded sold comps (`TCG.ebayComps` with the
graded filter, browser-side) can be saved as a `source:'ebay'` valuation. P/L math is done
client-side with `TCG.toAUD` (native currency stored, FX applied at display — app convention);
`/summary` returns per-currency value subtotals + AUD cost/realized totals.

**Card image.** On create + `POST /items/:id/fetch-image`, the server resolves a card image
best-effort (`resolveImage` in `lib/inventory.mjs`): by `identity_key` via `lib/normalize.mjs`
`imageFrom()`/`lookupPath()`, else a name/number **search** (pokemontcg / scryfall / lorcast)
that **backfills `identity_key`**; PSA cert lookups also return a slab image. Cached in
`inventory_items.image_url`; never blocks a write. The list renders the image inside the mini
**slab badge** (per-company theme from `data/grading-companies.json`; see `DESIGN.md`).
Subgrades are stored as JSON.

**Entry paths.** (a) manual add/edit modal on `inventory.html`; (b) "Add to inventory" button in
all five card builders (shared `TCG.addToInventory`, reuses each builder's `_trk` + `f_set`/`f_num`);
(c) `card-grader.html` "To pipeline" button — the pre-grader predicts a grade on a RAW card, so it
creates a **submission** (recommended company/tier + predicted value as declared value), NOT a graded
item (Golden Rule 4); (d) multi-company cert lookup (`/api/cert`) — PSA auto-fills (`PSA_API_TOKEN`); every other company has no public API so the form surfaces a `verifyUrl` deep-link (where one exists) + manual entry. Company registry is `data/grading-companies.json` (broader than the pre-grader's tolerance set — recording an owned slab needs no tolerances).

**Pipeline.** `grading_submissions` tracks cards sent off (company, tier, cost, `expected_return_at`
from `data/grading.config.json` `fees[].turnaroundDays` — a calendar-day estimate). `POST
/submissions/:id/promote` creates the graded `inventory_items` row carrying identity + grade + cert,
folds `grading_cost_cents` into `acq_fees_cents`, and is idempotent (re-promote returns the same item).

---

## 14. Bulk listing tool (Binders Keepers: Bulk)

Two workflows, one pipeline (full design in `docs/BULK_LISTING_DESIGN.md`, build order in
`docs/BULK_LISTING_EXECUTION_PLAN.md`); the page is `bulk-listing-builder.html`, the API is
`bulkPlugin(env)` → `/api/bulk/*` in `lib/bulk.mjs`:

- **A — Enumerate a set** (`POST /api/bulk/enumerate`, Pokémon + Lorcana): every card expands
  into one row per *(card × printing)* from its price-key set (`tcgplayer.prices` keys /
  `usd`|`usd_foil`). `ENUMERATORS[game]` in `lib/enumerate.mjs` is an adapter table like
  normalize's MAPPERS — a new game is one entry.
- **B — Import a Collectr portfolio CSV** (`POST /api/bulk/import/collectr`, raw CSV body):
  `lib/collectr.mjs` (pure parser: Variance→edition+finish, Grade→company/grade/label, verbatim
  numbers, `Misty (18)` cleanup) + `lib/collectr-resolve.mjs` (best-effort enrich: fuzzy
  set→identity with a **card-name overlap guard**, stock image, live price for raw rows,
  PriceCharting graded ladder for slabs). Real fixtures: `data/samples/collectr-*.csv`.

Both stream **NDJSON** (`{row}`… then `{summary}`) into the ONE grid (source switch, batch
picker, include-checkbox per row, `mkt|tier|PC|ovr|needs price` chips). Pipeline:
`POST /api/bulk/price` (hybrid: override > live market ≥ threshold > tier floor from
`data/bulk-pricing.config.json`; graded: Collectr > PriceCharting > `needs_price` — NEVER
fabricated, Golden Rule 4; `Math.round(x*100)` happens ONCE in `lib/pricing.mjs`, GR3) →
`POST /api/inventory/batches` (`bulk_batches` header + `inventory_items` rows; raw rows upsert
via the partial-unique `uq_inv_bulk_identity` [raw-only — graded slabs are always distinct
physical items]; listed/sold rows are never touched; absent fields never null stored data) →
`POST /api/bulk/export/csv` (File Exchange CSV, `CustomLabel`=SKU idempotency; validation
errors HARD-block the whole export; artifact + `channel_exports` audit row).

**Live eBay AU taxonomy (resolved 2026-07-02; pinned in `data/ebay-categories.json` [gitignored
cache] + baked as defaults in `lib/channels/ebay-map.mjs`):** all card games → category
**183454** "CCG Individual Cards"; the only required aspect is **Game**; conditionId 4000 raw /
2750 graded; the Professional Grader enum covers PSA/BGS/CGC/SGC/TAG/ARK/CGA/…; only
`Card Condition` + `Customised` are variation-enabled, so **multi-variation "pick your card" is
EXPERIMENTAL** — per-card is the primary shape. 1st Edition maps to the `Features` aspect + a
high-prio title token.

**Tier floors** live in `data/bulk-pricing.config.json` under `tiers[game][rarityClass][finishClass]`,
live-read per request. `tiers.mtg` exists; note that `rarityClass` has no `mythic`, so Scryfall's bare
`'mythic'` falls to `default` — which is why the `mtg` block's `default` row sits *above* its `rare`
row. It **is** the mythic tier, and HOC is 61% mythic. A floor under A$1.00 cannot be listed solo on
eBay AU (error 25016). `finishClass` tests the negations before holo/foil (GR5) — before that fix a
`Non-holo` Pokémon common was floored at the A$1.99 Holo tier instead of A$0.49.

**Mirror rules (extends Golden Rules 6/9/10):** `lib/listing-copy.mjs` holds verbatim ports of
`extras.js` `fitTitle`/`condCode`/`langCode`/`formatCardNumber`/`cardNumberKey` and each builder's `genTitle`/`genPitch`/`buildHTML`
(classic scripts can't import ESM), plus the single printing→finish→variant vocabulary and the
GR6 wording constants (slab wording ⚠ pending owner sign-off). `lib/fees.mjs` is the one home
for the AU fee bands (`index.html` imports it as a `<script type="module">`). **If you touch
either side of any mirror, run `node scripts/check-listing-copy.mjs`** — byte-identical parity
is the gate.

The pairs, each with a fixture block in that harness:

| lib/listing-copy.mjs | builder |
|---|---|
| `pokemon` `titleParts`/`pokemonPitch`/`buildDescription` | `pokemon-listing-builder.html` |
| `lorcana` … / `lorcanaPitch` | `lorcana-listing-builder.html` |
| `riftbound` … / `riftboundPitch` | `riftbound-listing-builder.html` |
| `mtg` … / `mtgPitch`, `MTG_COLOURS`/`mtgColourName`/`mtgTreatmentOf`/`mtgPromoNote`/`MTG_LANG` | `mtg-listing-builder.html` |
| `swu` … / `swuPitch` | `swu-listing-builder.html` |
| `onepiece` … / `onepiecePitch`, `onepieceIsChaseVariant` | `onepiece-listing-builder.html` |
| `lib/shipping-bands.mjs` `DEFAULT_BANDS`/`postagePhrase`/`money` | **all eight** builders' inline `POSTAGE_BANDS`/`postagePhrase()`, and `extras.js`'s comps analyser |

**Validation (§8 style):** `scripts/check-{listing-copy,pricing,collectr,collectr-graded,collectr-ebay,enumerate,comps}.mjs`
— run them all after touching bulk code. They are wrapped by
`test/invariants/check-harnesses.test.mjs`, so `pnpm test` (and therefore `pnpm verify`)
enforces them — they can no longer be forgotten. Before uploading any REAL batch: eBay Seller Hub →
Reports → Upload with a **3-row sample first** (the File Exchange multi-variation idiom is
unverified on this account; Phase 2 Sell-API is gated on `sell.inventory` production approval).
---

## 15. Store repricer + Telegram (up-only auto-pricing)

A subsystem that scans **our own** eBay listings on a schedule, compares each to competitor comps,
tracks the gap over time, alerts the team on **Telegram**, and can **raise** a price — never lower.
Separate DB (`data/repricer.db`) + plugin (`repricerPlugin`), currently independent of the shared
`tracker.db` used by §12/§13/§14. **Convention note:** the rest of the suite funnels through one
`openDb()` (§12) — revisit at Phase 3 whether to fold the repricer's listings table into `lib/db.mjs`
and populate the inventory system's reserved `ebay_listing_id`/`channel_status` columns (§13) instead
of a parallel store.

**Hard invariant: the system NEVER decreases a price.** Decreases are human-only. Every increase is
gated behind a **Telegram Approve tap** (owner's choice) — no autonomous writes. Enforced in code at
the proposal layer *and* re-checked immediately before any eBay write.

**Banded postage (trap 4).** Comps are DELIVERED prices and our price is a LIST price, so the
conversion subtracts our postage — but postage is now a function of OUR price (three bands), which
makes that circular. Two consequences, both load-bearing:

- **Never iterate to a fixed point.** For a delivered anchor in `[5169, 5824]` or `[15825, 16518]`
  cents there is *no* self-consistent price, and re-resolving oscillates between two bands forever
  (at D=5500: 5330 → band 2 → 4674 → band 1 → 5330 → …). `delivered(P)` is monotonically increasing,
  so `listPriceForDelivered` answers it with one descending scan instead. That monotonicity is
  guaranteed by `validateBands`' **strictly-increasing cost** rule — which also makes `bandForCost`
  one-to-one, so a live listing's postage identifies the band it is on. Do not relax it.
- **A raise stops at its band ceiling.** Crossing a band would change postage, policy and description
  together, and `Revise*` can send none of them (§16). The clamp is *complete*, not a mitigation:
  up-only keeps the price above `fromCents` (inside the band) and the ceiling keeps it below the top,
  so an accepted proposal cannot leave its band in either direction. **That argument depends on
  `never_decrease`**, which `test/data/configs.test.mjs` pins as a hard invariant.

Banded logic applies only to listings this tool published *and* whose live postage still matches a
configured band cost. A hand-made listing on a flat parcel policy keeps the simple subtraction; a
tool-published one that matches no band is skipped as `postage_off_band` rather than clamped wrongly.

**Why the Trading API (not the Sell Inventory API).** Our listings are created **manually in Seller
Hub**. The modern Sell Inventory API is *blind* to manual listings unless each is migrated via
`bulkMigrateListing` — a one-way conversion that then **disables** Trading revises. So we use the
legacy **Trading API** by `ItemID`: `GetMyeBaySelling` (read own listings), `ReviseInventoryStatus`
(least-invasive price bump, 4/call), `ReviseFixedPriceItem` (Best-Offer floor thresholds). eBay has
no first-party up-repricer; the up-only logic is ours.

**Two eBay tokens, don't confuse them.** The existing `/api/ebay` proxy uses a client-credentials
**app** token (Browse/Insights/Taxonomy — public data). The repricer's reads/writes need a **user**
token via the OAuth **Authorization Code grant** (`lib/ebay-oauth.mjs`): a one-time browser consent as
the seller mints an ~18-month refresh token (encrypted at rest in **`data/ebay-oauth.json`** — the
shared eBay user-token slot that the bulk tool's Phase-2 Sell-API also reserves (§14 / `.env.example`);
key derived from `EBAY_CERT_ID`; also seedable from a pasted `EBAY_REFRESH_TOKEN`); 2-hour access
tokens are refreshed headlessly. `EBAY_RUNAME` is required (a localhost redirect is rejected by eBay).
Trading calls carry it in `X-EBAY-API-IAF-TOKEN` (site 15). `lib/ebay-oauth.mjs` is intended as the
**single** eBay user-token acquirer for the repo — bulk's Phase-2 Sell-API should import it, not build a
second `ebaySellProxy`.

**`lib/comps.mjs` (server-side eBay AU comps).** Exists now, built for the **sealed nightly valuation**
(§16): it self-fetches the `/api/ebay` proxy (Browse asking / Marketplace-Insights sold → delivered AUD)
and ports `TCG.analyzeComps`' cluster-median math (GR9 — keep the clustering in sync), but its FILTER is
sealed-tuned (keep the right product type; drop empties/singles/wrong-bundles) — the mirror-opposite of
the singles `JUNK_RE`. The repricer (Phase 3+) can reuse the same clustering helpers.

**Comps + decision (repricer, Phase 3+).** Reuses `TCG.analyzeComps` (extras.js) / `lib/comps.mjs`. Reuse `lib/fees.mjs` for AU
fee math rather than re-implementing it. Target = **cheapest *in-cluster* − $0.01** (the densest price
cluster, so a lowball outlier can't drag it down); **our own listings are excluded** from the comp set.
A raise is only proposed when `nComparable ≥ 8 AND confidence = high AND uplift ≥ threshold`
(thresholds in `data/repricer.config.json`). Sold comps (Marketplace Insights) sharpen this once granted.

**Telegram (`lib/telegram.mjs`).** Dependency-free (global `fetch`). Sends HTML-formatted cards with
inline **Approve/Skip** buttons; receives taps via a **long-poll `getUpdates` loop** (NAT-friendly, no
webhook/public URL — singleton + HMR-guarded like `startCollector`). Offset cursor persisted in
`repricer.db` `meta`. Setup: `@BotFather` token → `.env`; add bot to the channel (admin) → `GET
/api/repricer/chatid` surfaces the `-100...` id.

**Rate-limit pacing.** Browse (comps) is the binding constraint (5,000/day default) — cache comps per
card+condition and dedupe across duplicate listings; file the free eBay *Application Growth Check*
before scaling. Trading is comfortable (5,000/day). Global ~500ms throttle; batch revises 4/call.

**Build phases.** 1 = Telegram loop + dry-run `test-alert` (**done**). 2 = user-token OAuth middleware
(`lib/ebay-oauth.mjs` + `lib/ebay-trading.mjs` + `/api/repricer/oauth/*`). 3 = `GetMyeBaySelling`
collector + comps compare → alert-only. 4 = wire `ReviseInventoryStatus` to the Approve tap. 5 =
Best-Offer floors + a `tracker.html`-style dashboard. A dry-run `test` proposal (`kind:'test'`) never
writes to eBay — it's how the full alert→approve→edit loop is validated before real repricing.
---

## 16. Sealed-inventory valuation (eBay AU-first, nightly)

The sealed tool (`sealed.html` / `lib/sealed.mjs`, `/api/sealed/*`) values held stock and refreshes it
**automatically every night** (`startSealedValueRefresh`, in-process interval, HMR-guarded, boot-delayed;
`SEALED_VALUE_REFRESH_ENABLED`/`_HOURS`). `resolveSealedValue()` is **eBay AU comps PRIMARY**
(`lib/comps.mjs` → delivered-AUD cluster median for the item's product type — the seller's actual market),
**PriceCharting (USD) FALLBACK** when eBay is thin/unreliable (`reliable` = not low-confidence and cluster
not >4× wide). Every valuation is written to `sealed_valuations` **with its source** (`ebay`/`pricecharting`/
`manual`) and the item card shows it (green "eBay AU" / blue "PriceCharting" + age). Key fixes baked in:
the PriceCharting fallback **re-resolves by the item's current name** (a stale/wrong stored `pc_url` no
longer makes a booster box read a booster PACK's price), and UPCItemDB titles are **de-mojibaked**
(`PokÃ©mon`→`Pokémon`). Manual values (`value_manual=1`) are never auto-overwritten. State is surfaced at
`GET /api/sealed/refresh-state` and in `/api/status` `jobs.sealed_value`.

---

## 16b. Stock labels — the `AAA-001` series (eBay "Custom label")

The owner's **physical** filing system, and the SKU eBay shows as *Custom label*. It predates this
tool: the ~163 hand-made Seller Hub listings already carry these, and `AAC-084` was the highest when
the tool learned about them. `lib/sku-labels.mjs` owns the scheme, `lib/inventory.mjs` owns the
counter.

**The format.** Three letters, a dash, a number **001–099**:

```
AAA-001 … AAA-099 → AAB-001 … AAB-099 → AAC-001 … AAC-099 → … → ZZZ-099
```

**Ninety-nine per block, not 999** — the block rolls at `099` and the letters advance like an
odometer (`AAZ` → `ABA`). That is 1,739,925 labels, so the ceiling is theoretical.

**Numbers are never reused.** Sell the card and the label retires with it; allocation is a monotonic
counter, never "find the first free slot". A recycled label would point at a card that is no longer
in that slot, which is worse than a gap in the series. `seedStockLabels()` therefore takes
`MAX(existing, new)` — the counter can be pushed forward but never rewound, and `nextStockLabel()`
additionally skips any label already present in `inventory_items.sku`.

**Seeding is required before first use.** The counter starts absent, not at zero, and while it is
absent `nextSku()` falls back to the old `BK-<GAME>-######` form. That is deliberate: an unseeded
counter would issue `AAA-001`, which is already on a shelf. Seed it with
`POST /api/inventory/labels/seed {"label":"AAC-084"}` (the last one SPENT), `{"startAt":"AAC-085"}`
(the next one to ISSUE — what the batch runner sends) or `{"seq":282}`; read the current position
with `GET /api/inventory/labels`, optionally `?from=<label>` for a read-only preview of a run
starting elsewhere. Every one of them moves the series FORWARD only, and says `rewindRefused` /
`fromRefused` when asked to go back. Because the pre-existing labels live only on eBay and not in our
DB, the true maximum has to come from the owner or from a read of their live listings.

**What uses it:** singles, i.e. `nextSku()` — the uploader's `POST /api/inventory/items` and the
grading-submission flow. **Bulk lots** (`nextBulkSku`, `BK-RAW-…`) and **sealed**
(`lib/sealed.mjs`'s own `nextSku`, `BK-SLD-…`) keep their own namespaces, because a 50-card lot or a
booster box is one object rather than a slot on the singles shelf. The two formats coexist: `sku` is
`UNIQUE NOT NULL` and nothing renames an existing row, since a live eBay listing is bound to its SKU
for life.

**Stock identity** (`stockKey()` in `lib/inventory.mjs`) is `game | identity_key | finish | language
| condition-or-grade`. Condition and finish are part of the identity on purpose — a Lightly Played
copy is separate stock from a Near Mint one and gets its own label and its own listing. The
uploader's `GET /api/inventory/match` uses this to offer "+1 to this" instead of a second competing
listing, and adding stock re-runs comps, because a card whose price was set months ago is worth
re-checking. Note that only a listing **we** published (one with an `ebay_offer_id`) can have its
quantity revised through the Inventory API — a hand-made Seller Hub listing is invisible to it, so
the UI says so rather than failing silently.

## 16c. The two kinds of eBay listing (and why the tool needs both mirrors)

There are two populations on the account and they do not talk to each other:

| | made by this tool | made by hand in Seller Hub |
|---|---|---|
| model | Sell Inventory API (SKU-centric) | Trading (ItemID-centric) |
| mirror table | `ebay_listings` (has `offer_id`) | `ebay_seller_listings` (keyed on ItemID) |
| kept fresh by | `reconcileListings`, every 30 min | `importSellerListings`, on demand |
| quantity/price revisable by the tool | yes, `publishListing` | yes, Trading `ReviseInventoryStatus` |

The Sell Inventory API **cannot see a Trading listing at all** ([KB 5210](https://developer.ebay.com/support/kb-article?KBid=5210)) — `getOffer`/`getOffers` return nothing for one — so `reconcileListings` is structurally blind to the hand-made listings and always will be. `POST /api/listings/import` is the other half: it pages `GetMyeBaySelling` (active + sold + unsold) and mirrors **every** listing into `ebay_seller_listings`, read-only, safe to re-run, with a button in Settings.

Keyed on the eBay **ItemID**, not the SKU, because a Trading listing's Custom label is optional and eBay allows the same one on several listings unless `InventoryTrackingMethod=SKU` is set. Where a Custom label does match an `inventory_items.sku`, the row is linked (`item_id`); resolving a card identity out of a listing *title* is a separate job and is deliberately not attempted.

**Listing pictures come from two places, and a missing one is never assumed away.** `listings.html` shows each listing's first eBay picture (`image_url`). The import takes it for free wherever `GetMyeBaySelling` carries `PictureDetails` — but it does not carry one on every item, so the upsert uses `COALESCE(excluded.image_url, image_url)`: a scan that says nothing must never overwrite a picture already known. What is left is backfilled by `resolveMirrorImages()` — one `GetItem` per unknown listing, capped per request, **active listings only**, and opt-in via `GET /mirror?images=1` so the settings probe stays instant. Active-only because that is where the entire cost sits: on the live shop all 142 active listings came back from the import with a picture and none of the 207 sold ones did (`SoldList` nests the item inside `OrderTransaction` and trims it), so a blanket backfill would spend its calls almost entirely on listings that are already over. Sold rows are not blank forever — one imported while it was active keeps its picture through the sale. `image_checked_at` is stamped on **any** reply we understood, including "no picture" and eBay refusing to discuss an old ended listing; only a thrown call is left to retry, which is what stops a dead listing costing a Trading call on every page load. Whatever the cap did not reach is returned as `images.pending` and said out loud on the page.

**The ended sweep compares IDs, never timestamps.** A listing we held as `active` that this scan did not see has ended. The first version tested `last_seen_at < startedAt`, which marked the entire shop as ended on the first import: SQLite's `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` and the space sorts before the `T` in a JS ISO string, so every row it had just written looked older than the scan. A truncated scan skips the sweep entirely, because "not seen" then only means "not reached".

**Matching a mirrored listing to a card** (`listing-match.html` → `GET /mirror/resolve`, `POST /mirror/link`). A mirrored listing knows its title, not its card, so `lib/listing-title-parse.mjs` reads one back out. It is the inverse of `titleParts()`/`fitTitle()` and deliberately **not** a positional grammar, because `fitTitle` is lossy: past 80 characters it abbreviates (rarity → `IR`, finish → `RH`) and then drops whole tokens cheapest-first, so "Pokemon", the language and even the condition may be gone. What survives is priority — name (100), number (85), set (70) — so each is hunted independently: the number as a distinctive `\d+/\d+`, the set by matching against the **known set list** longest-name-first (not by position), the name as whatever sits between. The round-trip through `buildTitle` is the test that matters.

Resolution proposes, it never applies. `high` means the eBay Custom label already matches an `inventory_items.sku` — the label itself telling us, so it needs no title reading at all. `medium` means the set and number were read out of the title. Anything less is left alone: a mis-parse would attach a listing to the wrong card, which is worse than no link (GR4). On apply, `linkMirrorListings()` prefers an existing row **by custom label** before anything else (the label IS the physical card's identity, and those rows often predate `identity_key`, which gets backfilled), then by identity, and only then creates a row from the listing. Each link is individually try/caught so one bad row cannot abort a batch of eighty.

**Revising a hand-made listing** (`reviseTradingListing`, `POST /mirror/:listingId/revise`). Trading `ReviseInventoryStatus` is the only route — the Inventory API cannot see these at all. **The quantity you send is the quantity to leave AVAILABLE; eBay re-adds `QuantitySold` itself** (change log 0695, worked example in [KB 1525](https://developer.ebay.com/support/kb-article?KBid=1525)). Sending a total oversells by exactly the sold count, silently. This is also why `ebay_seller_listings.quantity` is eBay's **total** and `available_qty` is the buyable figure — only the latter is ever echoed back.

Shape is **preflight → write → verify**: read the live state with `GetItem`, refuse or write, then re-read and store eBay's numbers rather than assuming the request took effect. The mirror is never the basis for a write — it is only as fresh as the last import, and a sale in between would make the quantity wrong.

Refusals, all before anything is sent: a listing `created_via='tool'` (Inventory-model, eBay blocks Trading revises on those — routing, not just safety), an auction (`ListingType` must be `FixedPriceItem`; auctions come back as `Chinese`), a listing that is not `Active`, quantity `0` (eBay rejects it — *ending* a listing is `EndFixedPriceItem`, which mints a new ItemID on relist, deliberately not wired here), and a price more than `PRICE_SANITY_MULTIPLE` (5×) away from the current one without `force`. Child order in the XML is the documented sequence `ItemID, Quantity, SKU, StartPrice`. Warning `21917091` ("revision is redundant") is a no-op success.

**Pushing item specifics onto a hand-made listing** (`pushListingSpecifics`, `POST /mirror/:listingId/specifics`). **`ItemSpecifics` is a COMPLETE REPLACE** — *"all newly input Item Specifics will replace all existing Item Specific values, regardless of if the values changed"* ([ReviseFixedPriceItem](https://developer.ebay.com/devzone/xml/docs/reference/ebay/ReviseFixedPriceItem.html)) — and there is **no documented way to delete a single pair**. So the only safe shape is read → merge → send the union. Sending only our names would silently delete everything the seller typed by hand.

Two rules follow, both enforced in code: a **failed read ABORTS** (an empty read must never be mistaken for "nothing to preserve"), and **catalog-sourced pairs** (`Source=Product`) are carried through untouched. `Source` is GetItem-output-only and is stripped before writing. `GetItem` needs `IncludeItemSpecifics=true`, and an absent node genuinely means "none".

Uses **`ReviseItem`, not `ReviseFixedPriceItem`**: only ReviseItem carries `VerifyOnly`, a real dry run that validates the whole payload without persisting — so the owner sees the exact merge *and eBay's verdict on it* before anything changes. `VerifyOnly` is a sibling of `Item`, not a child. Error **5028** (a legacy value that no longer validates against the category's current aspects) fails the *entire* call because the container is all-or-nothing, so it is surfaced by name rather than as a bare failure.

Deliberately **not** sent: `PictureDetails` (also a complete replace — a partial send deletes photos and reshuffles the gallery thumbnail), `ShippingDetails` (same trap), and the **description**, which eBay blocks on a fixed-price listing that has any quantity sold or a pending Best Offer (error 10029).

That `ShippingDetails` omission is **why the repricer cannot move a listing between postage bands.** Postage is banded by price now (§15), so a raise that crosses a band boundary would have to change the buyer's postage, the fulfilment policy *and* the amount quoted in the description — and this write path can send none of the three. So the repricer clamps a raise at the top of the band the listing is already in and flags it on the proposal for a human to move by hand. An Inventory-API listing *could* be moved (one `updateOffer` rebuilds the whole offer), but a hand-made Trading-only listing never can. Best Offer thresholds live in `ListingDetails`, not `BestOfferDetails`, if that is ever added.

Sold and unsold history reaches back about 90 days, so the mirror is complete for active listings and partial for history. Migrating the hand-made listings into the Inventory model (`bulkMigrateListing`) would collapse this into one population, but it is **one-way** — Trading `Revise*` is permanently blocked afterwards — so it is a deliberate decision, not a default.

## 17. eBay stock uploader (Sell Inventory API) — Pokémon, Magic, Lorcana and Riftbound

Brings the listing builders and the eBay inventory together: pick a card + qty → verify price +
Best-Offer → one button → the card is **created live on eBay**, and local stock stays in sync as it
sells. The tool creates listings via the **Sell Inventory API** (`createOrReplaceInventoryItem →
createOffer → publishOffer`), chosen because it is **SKU-centric** — the `BK-…` SKU is the one join
key across local stock ↔ eBay (↔ a future Shopify sink beside `lib/channels/ebay-map.mjs`). The
account already holds `sell.inventory` + `sell.account` (no re-consent) and is on eBay **Pro Basic**
(AU API access). `lib/ebay-oauth.mjs` `getUserAccessToken` is the single user-token acquirer.

**Pieces (all in `data/tracker.db` via `openDb()`):**
- `lib/ebay-rest.mjs` — the ONE authenticated JSON transport for the REST Sell APIs (user token,
  throttle + retry, uniform `{httpStatus, ok, json, errors}`). The REST twin of `tradingCall`.
- `lib/ebay-account.mjs` + `POST /api/listings/account/bootstrap` — one-time: opt into business
  policies (`SELLING_POLICY_MANAGEMENT`; up to 24h), find/create the AU payment (`immediatePay`, no
  offline methods) + return (30/60-day) + fulfilment (free AU post, ≤3-day handling) policies, and
  the merchant inventory location. IDs cached in `data/ebay-listing.config.json` (server-owned,
  settings-editable; the "Run eBay listing setup" card in `settings.html`).
- `lib/channels/ebay-map.mjs` — the single mapping layer (unchanged role). **Grading is NOT an
  aspect** on category 183454 (verified live): it now emits `conditionDescriptors` (semantic
  `{name,value}`) — Professional Grader / Grade / Certification Number for graded, Card Condition for
  raw — and only `Game` stays required. Aspect name ≤40 / value ≤50. Grade/grader value IDs are
  resolved to eBay's **numeric** ids by `lib/ebay-taxonomy.mjs` (live Metadata `getItemConditionPolicies`
  via the app token, cached, baked fallback) — an unresolved grade id **blocks** publish, never a
  guess (GR4).
- `lib/ebay-media.mjs` — images are **downloaded and re-uploaded to eBay EPS** (Media API
  `createImageFromFile`, binary, outbound-only) so a listing never depends on the CDN. Optional owner
  photos for played cards take the same path; a config-toggleable generic "follow us" image is
  appended last. `UploadSiteHostedPictures` is dead 2026-09-30 — do not use it.
- `lib/channels/ebay-inventory-api.mjs` — the sink: pure payload builders (`buildInventoryItemPayload`
  / `buildOfferPayload`; FIXED_PRICE + GTC, no AU tax container, cents→price at the edge, best-offer
  terms) + the idempotent `publishListing` orchestrator (find-or-create the offer on SKU → revise
  vs create).
- `lib/listings.mjs` — the plugin: `runPublish` ties it together (item → validate → resolve
  descriptors → EPS images → publish/dry-run → write-back) and the `/preview` `/publish`
  `/revise-price` `/withdraw` `GET /:id` routes.

**New tables** (`lib/db.mjs`): `ebay_listings` (local mirror, one row per SKU+marketplace),
`listing_pushes` (per-attempt audit/state), `listing_images` (EPS urls + expiry; `item_id NULL` =
the shared generic image). `inventory_items.ebay_offer_id`/`ebay_listing_id`/`channel_status` are
lit up on publish — which makes the postsale reconcile `item_id` rung (`buildInventoryLookup`) work.

**Degrades gracefully:** not-connected → 409 `not_connected`; not-bootstrapped → 409 `not_ready`;
eBay down → the existing File-Exchange CSV path (`lib/channels/ebay-csv.mjs`) still works. Harness
`node scripts/check-collectr-ebay.mjs` guards the mapping; `node scripts/check-comps.mjs` guards the
singles-comps mirror (GR9, JUNK_RE byte-identical to extras.js); the pure builders + `runPublish` +
`applyStockDecrements` + `reconcileListings` are unit- and integration-tested offline (stubbed eBay).

**Sale sync (the read direction, DONE):** `applyStockDecrements(pdb, tdb)` runs on every postsale
order poll — each matched paid line (SKU or `ebay_item_id` → `ebay_listing_id`) decrements local
stock idempotently (`order_line_items.stock_applied_at`): a qty-1 slab flips to sold+ended, a bulk lot
loses N, sealed goes through placements. `reconcileListings` (manual `POST /reconcile`) checks our
mirrored offers vs eBay and marks ended/out-of-stock drift.

**Test safety:** `openDb()`/`openPostsaleDb()` are process singletons that ignore their path arg after
the first call — tests MUST use `openDbAt(path)` / `openPostsaleDbAt(path)` (fresh, non-cached) so they
never write to the real `data/tracker.db` / `data/postsale.db`.

**The UI:** `stock-uploader.html` (linked from `index.html`) is the one-button flow — game + set/card
picker (reuses `TCG.setCombobox`, sets cached in localStorage against upstream flakiness) → live
eBay-AU price panel (`/price`) → Best-Offer verify → optional photos → **List on eBay** (saves to
inventory → uploads photos → `/publish`). Degrades: not-connected / not-set-up show a banner instead
of publishing. Lookup + live price verified end-to-end for both games; the publish leg needs the
connected account (ALCSERVER) + a completed bootstrap.

**This page stays a CLASSIC script.** Its buttons use inline `onclick=` handlers, which need global
scope, so it cannot `import`. The module shim at the bottom hands over `lib/ebay-links.mjs` and
`lib/stock-games.mjs` and then calls `boot()` — the boot is down there, not a self-invoking IIFE up
top, because a module runs after the document is parsed and every URL boot touches comes out of the
adapter. `test/invariants/ebay-links-single-source.test.mjs` pins the arrangement.

### Four games, one page (`lib/stock-games.mjs`)

Both stock tools read a per-game adapter table — the third in the repo, beside `MAPPERS`
(`lib/normalize.mjs`, price extraction) and `ENUMERATORS` (`lib/enumerate.mjs`, set → rows). Adding
SWU or Lorcana is one entry, not a second copy of a 130 KB page. Browser-safe ESM, same contract as
`lib/runner-core.mjs`, so the pages load it and `test/unit/stock-games.test.mjs` imports it directly.

Each adapter owns the catalogue URLs (`setsUrl`/`setCardsUrl`/`cardUrl`), the set-list mapping, the
printed number, the identity key, the thumbnail, the printing matrix, the finish options, the catch
tokens, the rarity classes, `normalizeCard` → `invRowFrom` (the inventory row incl. `card_facts`) and
`overridesFrom`. `compsQueryFor`/`compsNumberMatch` live here too, and `lib/listings.mjs` imports
them back — one source, so the pages' ↗ links cannot drift from the search the price came from.

`STOCK_GAME_IDS` is deliberately a SUBSET of `GAMES`: a game only belongs here once its eBay aspects
have been checked against the live Taxonomy, which so far is Pokémon, Magic, Lorcana and Riftbound.

### Riftbound (`lib/riftbound-cards.mjs`, added 2026-08-25)

Joined on its own live probe (`--game "Riftbound"`), which confirmed the `Game` member and then
settled a long list of **absences** — the aspect code and `test/unit/ebay-aspects-riftbound.test.mjs`
are written around them, and each one is a decision someone could later "fix" by reaching for
another game's word. Only `Spell` has a Card Type member (Unit/Gear/Legend/Battlefield/Rune do not,
and `Gear` is **not** sent as Magic's `Equipment`); Epic and Showcase have no Rarity member and the
enum's `Legendary` is not Riftbound's Epic; none of the six domains is an Attribute/Colour member, so
they go verbatim with only `Colorless` → `Colourless` (a spelling, not a translation) and the FIRST
domain winning on the 175 dual-domain cards; `Riot Games` is not a Manufacturer member; Overnumbered,
Signature and Ultimate have no Features member and are forfeited there because the title already
carries them at priority 82. **Year Manufactured stays unset** — Riot's set roster is
`{id, name, collectorNumberMax}` and carries no release date at all (probed live), so there is
nothing to derive.

**No upstream, so the routes SERVE the bake.** `/api/riftbound/sets`, `/api/riftbound/set/:id/cards`
and `/api/riftbound/cards/:set/:num` read `data/riftbound.json` through `iterateRiftboundSet` /
`resolveRiftboundCard` — the same iterator `ENUMERATORS.riftbound` uses, which is what keeps the
runner and the bulk tool incapable of drifting. The set route **joins the keyless TCGplayer price
index** onto every card: the batch runner's disagreement detector is Riftbound's only independent
second opinion, and without a market figure every row would come back `unverified`. A missing price
index still serves the catalogue (priced `null`); a missing catalogue is a `503 catalog_missing`.
⚠ `riftboundCardsPlugin()` must be registered **before** `riftboundPricesPlugin()` in
`vite.config.js` — the prices plugin mounts at the bare `/api/riftbound` prefix and never calls
`next()`, so anything after it is unreachable, silently. `test/invariants/riftbound-route-order.test.mjs`
pins the order and proves the reason.

⚠ **`variant` holds the TREATMENT, not a printing.** For every other game it is `Holo` / `Etched
Foil`; for Riftbound it is `Alternate Art` / `Overnumbered` / `Signature` / `Ultimate`, which
`titleParts` renders at priority 82 because it is a 10-100× price differentiator. `baseRow` computes
`variantToken(edition, finish)` and `stock-uploader.html` passes its own inline finish→variant ladder
as `ui.variant`, so the adapter's `invRowFrom` **overrides** both. Left alone, every Epic and Showcase
card stores `variant:'Foil'`, which deletes `(Signature)` from the title and forks the `stockKey` away
from the row the bulk enumerator writes for the same physical card. For the same reason
`ebayFinish` reads `rowIn.finish` rather than falling back to the variant, and `card_facts` persists
the finish — `finish` is not an `inventory_items` column and `itemToListing` back-fills it from
`variant`.

Two smaller ones: **every Riftbound set code is a catch-line token** (OGN/OGS/SFD/UNL/VEN are none of
them number-shaped, the exact opposite of Lorcana's numbered sets), and the **printing token table is
empty** because the bake is single-printing per card — the runner's grammar strip drops the chip
rather than advertising a control with one answer. The **Character** aspect comes from
`riftboundCharacter` (`lib/listing-copy.mjs`), which splits Riot's `"<Champion>, <Epithet>"` name and
is gated on `type === 'Unit'`: counted over the bake, 296 of the 297 comma names are Units and the one
that is not (`Heisho, Shell of the World`, a Battlefield) has a PLACE before the comma. It is a NEW
export rather than a change to `championTag`, which splits on `" - "` and is under the GR9 mirror.
The bake also now keeps the **artist** as `a` (100% coverage, 101 studios), which lights up the
Illustrator aspect.

### Pokémon in five languages (`lib/pokemon-intl.mjs`)

Both stock tools carry a **language** beside the game — `EN / JP / CN / TW / KO` — and it is a
property of the BATCH, not the row: one pile, one language. Only Pokémon has more than one lane, so
the control hides itself for every other game. **This is not a second game.** `game` stays
`'pokemon'` (a different value silently drops every Pokémon aspect), and every language argument on
the adapter **defaults to `'en'`**, which is what keeps the English path byte-identical — the GOLDEN
row in `test/unit/stock-games.test.mjs` is the guard.

**The identity key is namespaced with its TCGdex lane** — `ja:m5-102`, `zh-tw:sv8a-102`. Not a
convention: TCGdex uses the printed set code as its set id, **44 of those are also pokemontcg.io set
ids** (`SV3`, `SM6`–`SM12`, `XY2`–`XY10`, `NEO1`–`NEO4`) and **106 of 285 are shared across two or
more intl languages**, because Korean and Traditional-Chinese sets ARE Japanese sets translated. Un-
namespaced, a Japanese `SV3-102`, a Korean `SV3-102` and English `sv3-102` are one key — and
`/api/inventory/match` selects on `identity_key` with **no game and no language filter**. The COLON
is load-bearing: `SET_ID_RE` (`lib/set-cache.mjs`) disallows it, so a namespaced key can never
become a cache filename and can never be served out of the English card cache. Pinned by
`test/invariants/pokemon-intl-namespacing.test.mjs`, which proves the collision rather than
asserting the rule.

**Two sources, merged — neither is sufficient.** PriceCharting console is PRIMARY where the set has
a `pcSlug` (English card names, real full-res JPEG art, and the only coverage of sets TCGdex has not
ingested); TCGdex is the fallback AND the enrichment on top of a PriceCharting hit, because
PriceCharting carries no rarity, stage, type, illustrator, HP or `dexId` and the eBay aspects need
all of them. Skip the enrich and a JP listing ships visibly thinner than the English one beside it.

- **`normalizeIntlCard` / `intlCard` / `intlCardFromIndex`** — a non-English card is adapted at the
  BOUNDARY into a synthetic card carrying its own `__lang` and `__set`, so `rawNumber` /
  `cardNumber` / `identityKey` / `thumbUrl` / `printingsFor` / `finishFallback` / `normalizeCard` /
  `displayName` all take a bare card and no language. That matters because the mixed-pile paths call
  them through `adapterFor(row.game)`, which cannot know one.
- **GR10 is per source.** TCGdex's `localId` is already card-correct (`004`), so only the
  denominator pads; PriceCharting reports a bare `4` and needs the era rule on the numerator too.
  Either way the denominator is the JAPANESE set's count — a JP secret rare prints **102/081**, and
  102/084 (the English total) is on no card in either language.
- **Printings come from TCGdex `variants`** (`{firstEdition, holo, normal, reverse}`) — real DATA, so
  an intl card gets the same GR5 treatment an English one does, and the emitted keys ARE the
  pokemontcg.io keys, so `printingOrder` / `pickPrinting` / the catch line's `n|r|h` keep working.
  `finishFromRarity` must **never** run for intl: its regex answers a bare `Rare` with Holo and intl
  rarity is frequently absent entirely. The runner's per-set index is TCGdex's **briefs** endpoint
  (no variants, no rarity), so it lands on a declared `Non-holo` default that is deliberately NOT
  flagged `fromRarity` — it is not one.
- **Names go out in ENGLISH.** `displayName` is the one rule: PriceCharting's name as-is, otherwise
  `englishCardName` through `data/pokemon-dex-en.json` (dexId first, then the native-species map),
  keeping the Latin suffix printed on the card (リザードンex → `Charizard ex`). The grid and the
  ghost strip show it too, so what you scan cannot differ from what publishes. The set name is
  `setEnglishName`, which for many sets is really the printed code — `setNameIsCodeOnly` flags that
  so the operator is told, because inventing a romanisation is GR4.
- **`compsQueryFor` gains the language word and the native set code** (`… Abyss Eye M5 Japanese`),
  mirroring the builder's `findEbay`. Without it a JP card searched the English market and the
  language FILTER — which keeps bilingual English titles — happily kept the English results: a
  confident price for a card you do not own, arriving through a missing search term.
- **No second opinion exists for a non-English printing.** TCGplayer and Cardmarket do not price
  them, and TCGdex quotes Cardmarket in EUR where the MKT column is consumed as USD (GR3). So the
  disagreement detector cannot fire, `flagsFor` raises `unverified` as it should, the MKT cell
  carries a `no JP market` chip rather than an ambiguous blank, and the batch sanity strip counts
  *"N with no second opinion"*. PriceCharting coverage, counted: **ja 116/269 · zh-cn 20/65 ·
  ko 6/101 · zh-tw 0/98**.
- **Storage keys.** `setsCacheKey` stays the untouched literal `tcg_uploader_pkm_sets` (see above);
  `setsCacheKeyFor(lang)` suffixes the intl lanes, which have no history to orphan. The runner's
  index key became **`tcg_runner_idx3:<game>:<lang>:<setId>`** for the same reason it once gained the
  game, and `dropLegacyIndexes()` sweeps `idx1` and `idx2`. The QUEUE key stays unscoped — `rowKey()`
  already includes language — but rows persist their `lang` and `restoreQueue` filters on it, or a
  row restored in the wrong lane resolves to nothing and is dropped silently.
- **`lib/pokemon-intl.mjs` is mirrored** into `pokemon-listing-builder.html`, which is a classic
  `<script>` and cannot import. `scripts/check-listing-copy.mjs` pins the pair (`LANGS`, `langRow`,
  `speciesKey`, `nativeInfo`, `englishCardName`, `intlNumCandidates`, `setEnglishName`,
  `setLookupId`, `setPlaceholder`, `intlIdentityKey`). Edit one, edit the other.
- The builder's `addInv` gate is **lifted** now the keys are safe; `addTrack` stays gated because
  `pricePath` returns `null` for a namespaced key, so a watchlist row could never collect a price.

That gate is not ceremony. Lorcana's run (2026-08-14) found that the `Game` aspect had been sending
`Disney Lorcana` since the game landed, where the enum member is `Disney Lorcana TCG` — and because
`Game` is FREE_TEXT, the near-miss never failed a publish, it just silently earned no facet on the
one aspect eBay marks required. Riftbound was in the same state (`Riftbound: League of Legends TCG`).
Run `node scripts/check-ebay-aspects.mjs --game "<name>"` before adding a game, and again if a game
starts looking under-faceted.

Six things that are load-bearing rather than cosmetic:

- **The Pokémon sets-cache key is the literal `tcg_uploader_pkm_sets`.** Templating it would orphan
  every browser's cached set list, and that cache is the only thing between a flaky pokemontcg.io and
  an empty picker (GR7) — a regression no test can catch, because it only shows on a machine that had
  the old key.
- **The MTG `set_name` carries `(CODE)`** (`The Hobbit (HOB)`). `titleParts`' mtg branch reads the
  code out of those parens for the abbreviated title; `stripSetCodeSuffix` and `compsQueryFor` both
  strip it back off.
- **MTG `card_facts` key names are fixed by `buildRowIn`.** It falls back to `item.colour` /
  `card_type` / `treatment` / `promo_note` / `full_art` / `promo` when `resolveMtgCard` comes back
  empty (a cold Scryfall cache after a restart). Rename one and the fallback silently drops an aspect.
  The same is true of Lorcana's `character` / `ink` / `classifications` / `cost` / `strength` /
  `willpower` / `lore` against `resolveLorcanaCard`.
- **An aspect derived on the export path must be read off `rowIn`, not off `item`.** `buildRowIn`
  is where re-resolution puts its answers; a `put()` that reads `item` only works for a row that
  still has its facts attached, so it passes every test that hands the facts in as overrides and
  then vanishes on the DB round trip. Lorcana lost `Character` and the ink aspect exactly this way.
- **Lorcana's numbered set codes are NOT catch-line tokens.** Its sets are called `1`…`13`, which
  are also ordinary collector numbers, so `setsFrom` blanks `code` on them — otherwise typing `13`
  for card 13 parses as a set switch and silently adds nothing. The promo codes (`P1`, `D23`, `cp`,
  `C2`, `DIS`, `PD1`, `Coconut`) cannot be read as a number and keep theirs.
- **Enchanted / Epic / Iconic are foil-only and contain neither "foil" nor "holo".** Every finish
  ladder in the Lorcana path has to name them or the best cards in the game read as plain printings:
  `variantToken` (identity), `finishClass` (tier floor), `ebayFinish` (the aspect),
  `lorcanaPrintingsFor` (the matrix) and `MAPPERS.lorcana` (the price).

**Roadmap:** Phases 0–4 BUILT + tested (Phase 2 `/price` + the Phase-3 lookup/price flow live-verified
against eBay AU). **Remaining:** an auto-scheduler for `reconcileListings`; the first real publish smoke
on ALCSERVER (run the Settings bootstrap first); later: incoming-offer response, more games, sealed,
Shopify (a `shopify` sink beside `ebay-map.mjs`, same SKU key).

---

## 18. Batch Runner (`stock-runner.html`) — many listings in one sitting

§17's uploader is one card at a time. The Runner is the batch surface over the **same** endpoints:
the two things that actually cost time are **finding/entering the card** and **verifying the price**,
so it removes the network from the typing loop and turns price checking into one column scan.

**The one structural move.** Picking a set costs ONE request — `/api/pkm/set/:id/cards` or
`/api/mtg/set/:id/cards`, whichever the game's adapter names. The server does the paging and answers
from its own disk copy (`lib/pkm-cards-cache.mjs`, `lib/mtg-cards-cache.mjs`), **in the same
envelope**, so the page parses one shape and only the URL differs. The trimmed index stays resident
in a `Map(setId → {byNum, byName, cards})`; several sets stay resident at once, so a mixed shoebox
costs one prefetch per set and 0 ms after that. **That index is both entry modes**: the pile mode
looks a number up in it, the set-list mode renders it as a tick list. There is no second data path,
which is why the box break costs no extra fetch. A trimmed copy is cached per set in `localStorage`
under `tcg_runner_idx2:<game>:<setId>` — game-scoped because set ids and set codes collide across
games, and an unscoped key would serve Magic cards out of a Pokémon set's copy.

**One language per pile.** The Runner carries the same `EN/JP/CN/TW/KO` control the uploader does
(§17). Switching it re-scopes the catalogue exactly as switching game does, and for the same reason —
set codes collide across languages — but the QUEUE survives, because `rowKey()` already includes
language, so flicking to Japanese to check one card does not destroy a half-typed English pile.
Rows in another language are reported and left in place on restore rather than silently dropped.

**Both games in one pile.** The switcher changes the catalogue, not the queue: every row carries its
own `game`, `rowKey()` leads with it, `flushDupes` asks that row's shelf, and the grid renders each
row through its own adapter. So a Magic row keeps `417 / Etched Foil` while a Pokémon row beside it
keeps `025/182 / Normal`. The saved queue is `tcg_runner_queue2:<game>` (a v1 queue predates the
switcher and restores as Pokémon).

**The catch line.** `125` + Enter is the whole common case; everything else is optional and
order-free: printing, `x3` quantity, `@12.50` price, `nm|lp|mp|hp` condition, `*name` search,
and a bare set code to switch sets mid-pile. The printing letters are per game — `r|h|n` for Pokémon,
`n|f|h` for Magic, which has no reverse holo. **`hp` is parsed before the printing tokens** or
"heavily played" silently becomes "holofoil". There is deliberately no token for etched or surge
foil: across every cached set, Scryfall's only `finishes` combinations are `nonfoil+foil`, `nonfoil`,
`foil` and `etched` — an etched or surge print is a SEPARATE COLLECTOR NUMBER, so it is typed as its
own number and a token for it could only ever match nothing. Resolution happens BEFORE Enter (a ghost
strip), so a mistype is caught rather than corrected.

**One label per LISTING, quantity N on it.** A repeat of the same card bumps quantity instead of
making a second row — the only behaviour that avoids eBay `[25002]`, and the reason 5 copies take one
`AAD-001` rather than five labels. Identity is `rowKey()`, mirroring `stockKey()` (`lib/inventory.mjs:85`):
condition and printing are part of it, so an LP copy is separate stock from an NM one.

**Printings come from DATA, never a rarity regex (GR5).** Pokémon's matrix is read off the card's
`tcgplayer.prices` keys through `PRINTING_TO_FINISH`/`PRINTING_TO_EDITION`/`variantToken`
(`lib/listing-copy.mjs`) — the same source `ENUMERATORS.pokemon` uses. The uploader's rarity regex
matches a plain `Rare` and returns Holo; a wrong finish feeds `finishHint()` into the comps search
and returns a **confident price for a card you do not own**. It survives only as the fallback for a
card with no price object at all, and such a row is chipped `from rarity`.

**Magic's matrix is `mtgPrintingsFor` (`lib/runner-core.mjs`) — `card.finishes[]`, not the price
keys**, because Scryfall's `prices` object always carries all three fields (mostly null) and `usd`
already means "Normal" for Lorcana in the shared `PRINTING_TO_FINISH` namespace. Three things it
gets right that the obvious version does not:

- **`finishFromRarity` must never run for Magic.** Its regex matches a bare `rare`, so every Rare and
  Mythic would come back Holofoil — the exact failure above. The adapter's fallback is a plain
  `Nonfoil`, and it is effectively unreachable because Scryfall always populates `finishes`.
- **"Nonfoil" contains "foil".** `printingOrder` tests the negation FIRST, or every unfoiled Magic
  card ranks as a foil and a typed `n` finds nothing. `variantToken` has always done this; `etched`
  gained its own branch beside `surge` for the same GR5 reason — `usd_etched` is a distinct
  TCGplayer product, and `variant` is part of `UNIQUE(game, identity_key, variant)`.
- **Surge foil is priced at `null`, on purpose.** Scryfall marks surge only in `promo_types` and
  reports the PLAIN foil figure in `usd_foil` (HOC #53 says US$50; the real spread is #25 US$29.93 vs
  #65 US$125). The disagreement detector below is the Runner's only independent second opinion, so
  feeding it a number wrong by 4× turns a real check into noise. The MKT cell chips
  `surge — no market` rather than going blank, or the empty cell reads as missing data (GR4).

**The comps number filter has to agree with the comps query.** `compsQueryFor('mtg', …)` drops the
collector number (Magic titles rarely carry one), so `compsNumberMatch` returns `null` for it —
`singlesFilter` hard-rejects any title the number regex misses, and passing one anyway threw the
whole cluster away and left every Magic row reading "no confident comps".

**Triage.** Comps run behind the typing in a 3-wide client pool against the EXISTING
`POST /api/listings/price`, which already accepts an inline `{row:{…}}` with no connect gate
(`lib/listings.mjs:840`, `priceItem` at `:301`). Bands live in **`lib/runner-core.mjs`**
(`deriveState`/`flagsFor`) — pure, browser-safe, imported by the page AND by
`test/unit/runner-core.test.mjs`, so a rule cannot drift between the grid and the tests:
`READY · PRICING · EYES · CHECK · HELD · CHECKED · STAGED · LIVE · FAILED`. Nothing publishes but
`READY` and `CHECKED`.

- **EYES** — no confident comps. The ask cell stays **EMPTY**; an empty cell is the only presentation
  that cannot be mistaken for an answer (GR4).
- **CHECK** — over **A$150**, or over **4× the batch median**, under A$1.20, a title at 80 chars, a
  duplicate, a hand-typed price with no comps, or the disagreement detector. Released **per row**.
- **HELD** — sub-NM. Batch uses catalog art and eBay bans stock photos on used items, so a played
  card cannot be ticked at all; `o` hands it to `/stock-uploader.html?set=&num=&cond=&finish=`.

**The disagreement detector is the load-bearing one.** eBay AU >2.5× or <0.4× the TCGplayer market
(both figures already on the row, so it is free) is the only independent second opinion available,
and it catches the one failure an intra-batch median rule structurally cannot: **a comps query that
hooked the wrong card**. Verified live 2026-07-27: a US$0.30 Shuckle came back at **A$18.08 off 165
ASKING listings**, reported by the engine as `confidence: medium, reliable: true`. Marketplace
Insights (real SOLD prices) soft-403s often, and the fallback to asking prices is a quiet quality
drop, so the footer says **"N of M priced from asking listings, not sold prices"** out loud, and a
row with asking-only comps AND no market figure — nothing corroborating it at all — is flagged
`unverified`.

**Branded rails are ON by default here, and only here.** eBay crops every gallery thumbnail square,
so a portrait card letterboxes and hands eBay two columns of dead space — once is a judgement call,
sixty times is not, which is why the single uploader stays off and the batch defaults on. The
checkbox sends an EXPLICIT flag on every publish (`composeFlag()`), so this is a page default rather
than a fight with `listing-image.config.json` `enabled` (which remains the default for callers that
send nothing). The operator's own answer is remembered in `tcg_runner_compose` and beats the default.

**"Start labels at" — where this run's shelf numbers begin.** The single uploader has the same field
for one card; here it names the FIRST of the run and the rest follow. Two halves, deliberately:
`GET /api/inventory/labels?peek=N&from=<label>` is a READ-ONLY preview that answers while you type
(`upcomingStockLabels(db, want, fromSeq)`), and `POST /api/inventory/labels/seed {startAt}` is the
one mutation, applied once at the publish confirm. They are separate because the series moves
forward and **never back**, so a number typed and then reconsidered must not have cost a label.
`startAt` is the operator's intent — "this run begins at AAF-020" — and the −1 against the counter
happens server-side so no caller has to know how the counter relates to the label it issues.
A backwards ask is **refused loudly** at both ends (`fromRefused` on the preview, `rewindRefused` on
the seed): it blocks the publish button and aborts the run, because falling forward silently would
have the operator writing one number on the sleeve while eBay carried another.

**Stage uses `POST /api/inventory/items` with `batch_id` NULL, NOT `/batches`.** Pinned by
`test/integration/runner-stage.test.mjs`, because it is easy to "tidy" into the wrong one:
`/batches` hands out `BK-RAW-*` via `nextBulkSku` instead of a shelf label, **drops `card_facts` and
`store_categories`** (both in `ITEM_INSERT_COLS` but absent from its `pick({…})` literal at
`lib/inventory.mjs:866`), which would strip the item specifics off every batch listing, and SKIPS a
matched row that is not `in_stock` (`:861`), so re-listing a card you once sold would silently do
nothing. Staging is a separately confirmed step naming the exact permanent label range — labels are
monotonic and never reused (`lib/sku-labels.mjs`).

### Phase 2 — the batch route, and the rules a reload cannot bypass (BUILT)

**`POST /api/listings/batch { item_ids[], overrides_by_id?, bestOffer?, released_ids[] }` → NDJSON**
(`runBatchPublish`). A loop, not a second pipeline: every row goes through `runPublish` **unchanged**,
in the per-row try/catch shape `runSealedRefresh` / `linkMirrorListings` / `importSellerListings`
already use. Streams `{start}` → `{row}`… → `{summary}`. **No inter-row sleep** — `lib/ebay-rest.mjs:22`
already serialises every Sell-API call app-wide at 120 ms + jitter and honours `Retry-After`, so a
second gate would only double the wall-clock. `guardConnected` / `accountReadyGuard` run **once**
before the loop, not per row: they fail identically for all N, so a disconnected account costs one
sentence rather than a hundred copies of it. `ndjsonStart` moved out of `lib/bulk.mjs` (where it was
module-private) into **`lib/ndjson.mjs`**, so listings does not depend backwards on bulk.

**The refusals, in `lib/runner-core.mjs` `refuseRow()` — the same module and the same constants the
grid flags on**, so client and server can never drift to different numbers. Nothing equivalent
existed before: `validateListing` only errors at `price_cents <= 0`, and `PRICE_SANITY_MULTIPLE`
lives in `reviseTradingListing` (the hand-made Trading path) and never runs on `runPublish`.

| Refusal | Releasable? |
|---|---|
| `no_price` | no |
| `over_ceiling` — above **A$150** | yes, per row via `released_ids[]` |
| `over_median` — above **4×** the batch's own median, computed server-side from the prices actually about to be sent | yes |
| `under_floor` — below A$1.20 | yes |
| `sub_nm_no_photos` | **no** — eBay bans stock catalog images on used items, and `runPublish:231` downloads catalog art whenever `listing_images` is empty *regardless of condition*. A policy breach is not a judgement call. |
| `graded_no_photos` | **no** — a slab under the card's catalog scan hides the label and cert number the buyer is paying for. |

Release is **per row**, never per batch. A refused row still writes a `listing_pushes` audit row with
`status='skipped'` (a value `db.mjs:526` already documents) — a batch that silently declined half its
rows is not reconstructable later from an empty table. Each run also writes one `channel_exports` row
with `channel='ebay-inventory-api'`, which the table was pre-declared for and had never seen.

**Abort on the first descriptor failure.** An unresolved condition descriptor is *environmental*
(eBay Metadata unreachable), so it will fail identically for every remaining card at a round trip
each. The batch stops, the rest come back `skipped`, and `summary.aborted` says why.

**`GET /api/listings/batch/preflight?item_ids=…&released_ids=…`** — `itemToListing` + `validateListing`
+ the refusals, **zero eBay calls**, so the client gates the publish button on the server's own
verdict for free. Deliberately not a dry-run publish: `runPublish(dryRun:true)` still PUTs a real
inventory item, creates a real offer and uploads to EPS, and there is **no `deleteOffer` anywhere in
`lib/channels/`** to clean up after it. Id parsing goes through `parseIdList` — `+'' === 0` and
`Number.isFinite(0)` is true, so a naive finite check turns `?item_ids=` into a lookup for item 0.

The publish modal prints the **resolved** store department names (from the server's
`resolveStoreCategoryNames`, not the paths the page ticked) and the Best-Offer auto-accept in
**dollars at both ends of the batch** — `resolveBestOffer` works from percentages, and one wrong
number auto-accepts every lowball in the run at once.

### Phase 3 — verification depth (BUILT)

**The batch sanity strip.** One line above the grid, all of it aggregate truth that is invisible row
by row: total ask, median, dearest-with-name, *"N of M at the mechanical undercut"*, *"N priced from
asking listings, not sold prices"*, *"N with no confident comps"*, and *"N disagree with TCGplayer by
more than 2.5×"* (clickable, filters to exactly those). The undercut figure is a **real invariant**,
not decoration: `recommendedFromCluster` always lands at `cheapestInCluster − 1c`, so any row not
sitting there was moved by hand or by an override.

**Verify mode** (`V`, or the button). Hides every row that needs no decision — `READY`, `CHECKED`,
`LIVE`, `STAGED` — so the count *shrinks as you work*. Leaving approved rows on screen would mean
the worklist never moved and the mode bought nothing. An open drawer always stays visible.

**The drawer** (click a row). `tr[data-why]`, the `listings.html` inline-edit idiom: the
server-echoed comps query with both ↗ links, quick-price chips (`cheapest −1c` / `fair` / `+10%` /
`TCGplayer`), a per-row condition override, a per-row store department (`pickOverrides` already
honours `store_categories`, so no server change), and the `+N to that one instead` action when the
row is a duplicate. **Best Offer stays batch-wide** — `runBatchPublish` takes one spec — which is
why the publish modal prints it in resolved dollars.

⚠ **A row is TWO `<tr>`s** — the row (`data-uid`) and its reason/drawer row (`data-why`). Resolving a
delegated event with `closest('tr[data-uid]')` alone silently drops every click and change inside
the drawer. `rowFromEvent()` matches both; the row-body-opens-drawer branch is scoped to
`tr[data-uid]` only, or clicking the drawer's own whitespace slams it shut mid-edit.

**The micro price-scale** (`scaleGeometry`, `lib/runner-core.mjs`). The obvious version is broken and
worth naming: `clusterValue` returns `cheapestInCluster` and `clusterLo` as literally the same
expression (`cluster[0]`, `lib/comps.mjs`), so a cheapest→hi rail with a lo→hi band draws one
identical picture on every unedited row. What actually varies, and is therefore drawn: the domain
spans the cluster **and** the ask (a hand-typed price outside the band stays on screen instead of
clipping), the band is the cluster, the tick is `fair` — the cluster **median**, which genuinely
moves — and the rail goes amber past the same `hi/lo ≥ 4` ratio `comps-singles` calls unreliable. An
unedited caret hard left is correct: it means "we mechanically undercut".

**`POST /api/inventory/match/batch { keys: [...] }`** — the same duplicate answer, for many cards in
two SQL statements instead of N round trips. Semantics unchanged (full `stockKey`, warning not
block). POST rather than the planned `GET ?keys=`: a hundred keys is several KB and does not belong
in a URL. Matches on `identity_key` only — the Runner always has one, and a name fallback would cost
a statement per distinct name, which is the round trip this endpoint exists to remove.

**`POST /api/listings/batch/preflight/canary`** — a REAL dry run over at most four rows chosen by
`pickCanaries`: the first, the dearest, then one per distinct finish × language × condition (where
the payload actually varies). Not all rows, because a dry run still PUTs an inventory item, creates
a real offer and uploads to EPS, and **there is no `deleteOffer` anywhere in `lib/channels/`** — each
canary leaves an unpublished offer nothing here can remove. The UI says so.

**Stale-mirror warning.** `GET /config` now carries `lastImport`. Over ~24h old (or never), a bar
offers a one-click `POST /import` and re-runs the duplicate check on every queued row afterwards —
a stale mirror is exactly how a hand-made Seller Hub listing slips past the check and turns into
eBay `[25002]` at publish time, after a shelf label has been spent.

**`cachedEps` fix** (`lib/ebay-media.mjs`). It keyed on `(item_id, source_url)`, so a batch holding
two copies of one card — or an NM and an LP, which are two stock rows by design — pushed identical
bytes to eBay twice. Catalog art is now shared on `source_url` alone (nothing reads those rows back
per item: `runPublish` only selects `kind IN ('front','back','blemish','slab')`). **Owner photos stay
item-scoped**, or one card's photo would land on another card's listing.

### Phase 4 — the detached job (BUILT)

A hundred-card run takes minutes, and holding it inside one HTTP request meant a closed tab, a
dropped connection or a Vite restart (which this repo's own notes say to expect mid-session) stopped
it. **The run now lives on `globalThis.__listingsBatchJob`** — HMR-safe, the same reason
`startReconcileJob` keeps its timers there — and every request is only a **view** onto it.

- **`startBatchJob`** takes a **re-entrancy lock** (the `_svRunning` shape from `sealed.mjs`). A
  second start is refused with `409 job_running` **and the running id**, so the caller attaches
  instead of interleaving two sets of eBay writes.
- **`jobEmit`** is the single place that records an event and updates the counters, so
  `runBatchPublish` needs no knowledge of the wrapper. Every event carries a monotonic `seq` into a
  **ring buffer** (`RING_MAX = 2000` — the 500-row cap × ~1 event each, so replay never truncates a
  real run).
- **`POST /batch`** starts the job and then streams it, opening with a `{job:{id, resumed_from}}`
  record. Dropping that response does not stop the run.
- **`GET /batch/:id/stream?from=<seq>`** replays the ring buffer past `from`, then follows live —
  a reconnect loses nothing, and several viewers can watch at once.
  **`GET /batch/state`** (checked *before* `/batch/:id`, or it gets swallowed by the id pattern) is
  how a reopened tab discovers a run in progress. **`GET /batch/:id`** is counters-only.
- **`POST /batch/:id/cancel`** sets a flag checked **between rows**, labelled *"stopping after the
  current card"*. That is the only safe point: there is no way to un-send `publishOffer`, and
  stopping between `createOffer` and `publishOffer` would strand an offer nothing here can delete.
- **Resume is DERIVED, never stored** (`pendingBatchIds`): pending = `ebay_listing_id IS NULL OR
  channel_status <> 'active'`. A saved pointer goes stale the moment the 30-minute reconcile job
  marks a listing ended — that row genuinely needs publishing again. Correctness does not depend on
  the skip either way: `publishListing` is idempotent on SKU, so a re-run is a no-op revise at worst.
- **`pruneListingPushes`** runs when a batch finishes (`cfg.auditRetentionDays`, default 90).
  `listing_pushes` stores the exact request *and* eBay's exact reply on every attempt — which is what
  makes a bad day diagnosable, and what makes it grow without bound now batches are the normal path.
- Registered as `jobs.listing_batch` in `/api/status` beside `listing_reconcile` and `sealed_value`.

**The UI says so plainly.** The publish modal states the run continues if you close the page; a red
**Stop** appears while it runs; losing the stream shows *"the run itself is still going"* with a
**Re-attach** button; and `beforeunload` deliberately no longer guards on a run being active — only
on unstaged queue rows, because closing the tab now costs the view, not the work.

**Validation:** `test/integration/listings-batch-job.test.mjs` — outlives its request, one-run-at-a-time,
replay from a seq, two concurrent viewers, a viewer leaving mid-run, cancel leaving finished cards
listed and the DB agreeing with the counters, derived resume (incl. the ENDED case a stored cursor
gets wrong), and retention.

**Validation:** `test/unit/runner-core.mjs` (rules + refusals, incl. a client/server same-numbers
check) · `test/unit/runner-ndjson.test.mjs` (the page's real `consumeNdjson`, pulled out with
`extract-inline`, against split/byte-wise/malformed chunks) · `test/integration/listings-batch.test.mjs`
(partial failure, refusals, release semantics, abort, audit rows, preflight) ·
`test/integration/runner-stage.test.mjs` (the stage contract + the routes). All wrapped by `pnpm verify`.

---

## 19. Branded listing images (the compositor)

eBay crops every gallery thumbnail to a **square**. A portrait card scan letterboxes inside it, so we
hand eBay two columns of dead space and let eBay decide what fills them. `lib/listing-image.mjs`
fills them ourselves: the card centred on a 1600×1600 canvas with a fixed 300px branded rail either
side and a 48px white mat between card and rail.

### The dead-axis rule (and the Shopify frames)

There are now **four output frames**, and one rule generates all of them: **rails fill the frame's
dead axis.**

| frame | target id | dead axis | furniture |
|---|---|---|---|
| eBay 1600×1600 | `ebay-square` | left/right | vertical rails, 300px — **unchanged** |
| Shopify 1512×2112 (63:88) | `shopify-card` | *none* — so we make one | horizontal bands, top and bottom |
| Shopify 1600×1600 sealed | `shopify-square` | top/bottom | horizontal bands |
| Social / OG 1200×630 | `og-card` | left/right | vertical rails, art reused, mark on the LEFT only |

The social card is the **og:image / twitter:card** — what appears when a product URL is pasted into
Discord, Slack, iMessage, Facebook or X. Nothing consumes it yet; it is for when the storefront's
product pages exist and get shared. Its RIGHT rail is rebuilt from the sampled ground column rather
than used as authored, because the rail art bakes the store mark into the top of *both* sides: that
reads as one masthead across a 1600px square and as a duplication mistake at 1200×630. Only the
inner hairline is lifted from the real art, so the pair still mirrors, and the set badge takes the
right rail exactly as it does on eBay.

Shopify's grid is built on **63:88 — the card's own ratio** (1512 = 63×24, 2112 = 88×24, exact), so
a trimmed scan would fill it edge to edge with nothing left over. The dead space there is *created*,
horizontally, for two reasons: side rails would eat a portrait card's width (the eBay square only
gets away with it because the card is already width-constrained), and horizontal type needs no
rotation, so a band carries a full set name and printed number at readable size where a 300px
vertical rail manages two clipped lines.

**The ground is branded, not neutral.** The storefront has a light and a dark mode, and a neutral
mat would be wrong in one of them — the original spec used that to argue for no furniture at all. A
branded plum surround is not a mat: it is dark in both modes deliberately, the way a card's own
border is. That also makes every frame opaque, so nothing in this subsystem needs an alpha channel,
a PNG branch or a format switch, and **nothing is ever cropped** — a landscape card (SWU Leaders and
Bases, MTG Battles, Lorcana Locations, Riftbound Battlefields) just contains, with no special case.

**What the bands carry.** Top band: the **card name**, centred, and **never truncated** — it steps
down through four sizes, then wraps to two lines, and only a single unbreakable token wider than the
band can still be cut. A clipped name ("ROSA'S ENCOURAGE…") tells a buyer less than the art already
does. Bottom band: **the eBay square unrolled** — the set **WORDMARK** at the left end (foot of the left
rail on eBay), the set **SYMBOL** at the right (foot of the right rail there), and the set name over
the printed number centred between them. Those two are different kinds of thing and are NOT
interchangeable: a wordmark is the set's name as type, a symbol is the little mark printed on the
card. Mirroring the symbol to both ends threw the wordmark away entirely, which is what made the
band carry less than the square beside it. Either may be absent — early Pokémon sets printed no
symbol, Scryfall publishes no Magic wordmark (so it falls back to the game logo, exactly as the rail
does) — and the centred block reserves the wider of the two on BOTH sides, so a missing one never
shifts the text off-axis. The number line carries whatever qualifies it: the language marker, or a
slab's grade and cert.

**The printed number is never rebuilt here.** It arrives from `composeMetaFor`, which runs
`printedCardNumber` (Golden Rule 10, which rebuilds the padding pokemontcg.io strips — Base Set's
`4/102`, Jungle's `11/64`) and `gameCardNumber` (Lorcana's `42/204`, SWU's `010/252`). A second
formatter would be a second chance to get it wrong.

**The store mark is a CHANNEL decision, not a style one** (`shopify.brandMark`, or `mark` per call).
On our own storefront it is redundant — the page is already ours, and every tile in a collection grid
wearing it is noise. Off-site it is the only thing saying whose stock it is: a bare scan in a Google
Images result or somebody's hotlink could be anyone's. One picture cannot serve both, so `'none'`
(the default) and `'share'` are two different images, distinguished in the content hash. Toggle it
per render on `rail-previews.html`.

**Every frame has a mat.** `CARD_MAT_FRACTION` (0.032 of the frame's short edge — 48px on the tile,
the same mat the eBay square uses) keeps the card off the band's hairline. Without it the card edge
sits hard against the chrome, which reads as a printing error rather than a frame.

**Rounded corners apply on plum, and that argument is stronger than on eBay's white.** A catalog
scan's own white corners are invisible against a white canvas and show as four white nicks against
the gradient, so the mask runs on the banded frames *and* the social card.

**Condition never reaches any of these images.** An NM and an LP of one card are two stock rows with
*identical source bytes*; condition on the image would split every such pair into two separately
composed, separately stored images across the whole store. Alt text and the product title carry it
instead. Slabs are the one exception, and legitimately so — a slab is one of one, so there is no
pair to split, and its band carries grader, grade and cert.

⚠ **`railsDigest` and `bandsDigest` must stay separate.** `railsDigest(variant)` hashes
`left.png` + `right.png` and is an **input to the eBay content hash**. The band art lives in the same
`rails/<variant>/` directories; folding `top.png`/`bottom.png` into that digest would re-key every
branded image already hosted on a live eBay listing and force a full store re-upload.
`test/unit/listing-image-hash-pin.test.mjs` pins both, separately, and pins that `railsPresent()`
still means left+right so a missing band can never stop an eBay listing composing.

**The target segment is append-only.** `targetFingerprint()` returns `''` for `ebay-square` and
nothing else, and `composeHash` writes the segment only when it is non-empty — so every key minted
before targets existed is byte-identical. That one function is the entire reason this change cost
nothing, and it is pinned directly against a matrix varying every `shopify.*` setting.

⚠ **The EXIF whole-frame check on the eBay path is FROZEN, and looks like a bug.** It compares the
detected region against the **pre-rotate** dimensions, so for EXIF orientations 5–8 it never matches
and the card takes a whole-frame `extract()` it does not need. That extract is **not** a pixel no-op:
measured on `test/fixtures/listing-image/exif-orient-6.jpg`, dropping it changes 0.58% of pixels with
a max channel delta of 97 (control on an unrotated source: delta 0). Hashes are unaffected either
way, so nothing hosted moves — but a cold render would differ. `lib/listing-image-source.mjs` exposes
both comparisons; eBay keeps `legacyFull`, the new frames use `frameFull`. Retire it at the D-023
reset, with the Baloo 2 font change, when everything re-composes anyway.

**Band type is capped at 1200 dpi, not the rails' 420.** The rail cap exists to stop a two-word set
name rendering absurdly large down a 1600px rail. Band type is already bounded by the band's own
thickness, so the same cap silently *binds*: a 120dpi reference render of one line is ~14px tall, so
a 55px target needs ~470dpi and a 67px target ~574dpi — both clamped to 420, both coming out the same
size, which made the bottom band's shared width budget compute from a width the type never had.

The bottom band's two labels **share one budget and scale together**, and only then does the left
give way. Sizing them independently let them collide; clipping whichever was measured second threw
away the cert, which is the slab's SKU.

⚠ **Catalog art resolves through `catalogArtFor()` and nowhere else** (`lib/onepiece-clean-art.mjs`).
Bandai's keyless One Piece mirrors are SAMPLE-watermarked, and the swap to the clean TCGplayer scan
used to be applied by hand at each call site. A surface that forgets it publishes a watermarked image
as the product photo, silently — on Shopify that is position 1 on every One Piece product.
`test/invariants/catalog-art-single-caller.test.mjs` pins the single caller.

**Sealed:** `sealed_items.product_type` holds the granular taxonomy (`booster_box`,
`elite_trainer_box`, `tin`, …) and is **never** the literal `'sealed'`, so the old `=== 'sealed'`
test could not be true for a row in either table — the `sealed` profile and rail art were unreachable
from every DB-driven path. `composeMetaFor` now derives it from `PRODUCT_TYPES`, and takes an
explicit `{ productType }` override for callers that already know (the table you read from *is* the
product type). Provably a no-op for eBay: `inventory_items` has no such column. There is still **no
sealed publish route** on either channel.

Frames, alt text, filenames and the manifest: `lib/listing-image-targets.mjs`,
`lib/listing-image-bands.mjs`, `lib/listing-image-names.mjs`, `lib/listing-image-store.mjs`.
Routes: `GET /api/listing-image/targets`, `POST /api/listing-image/build`,
`GET /api/listing-image/file/<sha256>.<ext>[/<name>]` — all dispatched *inside* the existing
`/api/listing-image` middleware, because connect matches by registration order, not longest prefix.
**`rail-previews.html` is the proof surface**: pick any game, switch frames, see the alt text, the
filename and the review flag.

```
composeListingImage(input, meta, options?)
  -> { buffer, width, height, contentHash, composeVersion, variant, layout, textLines, card }
```

`input` is a path or a Buffer · `meta` is `{ productType, language, setName, cardNumber, rarity }` ·
`options` takes `{ variant, canvasSize, quality, cfg, cacheDir, detector }` plus any whitelisted
layout key. `stock-uploader.html` shows a live preview of the real composite for the card in hand —
it posts the row it is about to save to `/api/listing-image/preview`, which derives the rail metadata
through the **same `composeMetaFor`** the publish path uses, so it is not an approximation. The
source follows the publish rule too: staged owner photos replace the catalog art. Tune the constants
in **`/listing-image-lab.html`**; batch it with

**Both previews render on WHITE and click to zoom, deliberately.** eBay has no dark mode, and the
rails are near-black: on this suite's dark panels you cannot see where the composite ends and the
page begins, which is the one thing a preview of this feature has to show. The in-page sizes are
eBay's real desktop ones (460px stage, 225px search-results thumb — measured against a live listing,
not guessed), and clicking opens the full 1600px on white, because the card column is well short of
the ~700px eBay gives an item page's main image.
`node scripts/compose-listing-images.mjs`.

**Ships OFF.** `data/listing-image.config.json` (`enabled: false`) is the master switch, `applyTo`
splits catalog art from owner photos, and each publish carries a per-listing `compose` flag from the
checkbox in `stock-uploader.html` / `stock-runner.html`. Precedence: **per-row → batch-level →
config**. Absent always means *defer*, never *yes*.

### Fixed rails, flexible card

The rails are always exactly `railWidth`, so the art is pixel-exact and never stretches; the card is
fitted into whatever is left (`fit: 'inside'`). Rails sized to the leftover space would rescale per
photo and the store would stop looking like one set.

The column is `canvas − 2×railWidth − 2×cardPaddingX` — **904px** at the defaults. `cardPaddingX`
(48) is the white mat between card and rail: without it a standard single is width-constrained by
the column and its edge sits hard against near-black chrome, which reads as a printing error rather
than a frame. `validateLayout` enforces the whole thing closes, so a wide rail plus a wide mat fails
loudly instead of emitting a squashed card. The card is centred on the **canvas**, never measured off
the rail edge — derive it from the rail and it shifts by `cardPaddingX` the moment the mat is
non-zero.

`PROFILES` overrides the geometry per `productType` — `sealed` narrows the rails to 220 and the mat
to 24, because a landscape ETB photo otherwise floats tiny in the middle of the canvas.

### The rail art

`scripts/build-placeholder-rails.mjs` composites **`logos/BK_Logo_alpha.png`** — the real store mark,
which must keep its alpha channel or it composites as a box — onto a dark-plum gradient pulled from
the mark's own backing disc, so rails and logo read as one thing. The mark sits at the **top of both
rails**, reading as one masthead across the image. The inner edge carries a per-variant hairline:
gold on `default`, magenta on `japanese`, blue on `sealed`.

The **foot of the right rail is left clear in the art on purpose** — the compositor draws the set
badge there at compose time.

### What the rails say

- **Down the right rail:** two lines on every listing — the **card name**, then the **set name** with
  a language marker appended for anything non-English (`PARASECT` / `LOST ORIGIN`, and
  `IRON DEFENDER` / `ABYSS EYE (JP)`). English carries no marker; it is the store default and the
  bulk of stock.

  `railText` returns **one line per element, never a joined string** — the type is sized to the
  longest line, so two short lines render visibly bigger down a 300px rail than one long one.
  `text.railInset` is 0.12 rather than 0.22 because the cross-axis budget is shared by all lines: a
  two-line rail gets half each and shrinks at a wide inset, while a single line is bound by the
  along-run `fill` and so is unaffected.

  The set line is **optional** and the marker is appended **after** clipping, so a long name reads
  `ABYSS EY… (JP)` and never `ABYSS EYE (J…` — losing the marker would lose the one thing it is
  there to say. A non-English card whose set name is missing or undrawable keeps its language on
  that line instead (`PIKACHU` / `JAPANESE`), because "which printing is this" is exactly what a JP
  buyer is checking.
- **At the foot of the right rail:** the set symbol above the card's **printed** number — the two
  things a collector checks after the name, and the pair a thumbnail otherwise makes unreadable.
- **At the foot of the left rail:** the set **logo** (the wordmark), mirroring the badge opposite it.
  It gets its own W×H box rather than the symbol's square, because logos are wide and squeezing one
  into a square box is worse than letting it keep its aspect.

### A non-English card is a different product, not a translation

`composeMetaFor` resolves a non-English row against the **baked TCGdex index**
(`data/pokemon-intl-sets.json`) via `findIntlSet(lang, {code, name})`, and only falls back to the
English list. It has to: the JP counterpart of *Pitch Black* is **アビスアイ / Abyss Eye**, it holds
**81** cards rather than 84, and a JP secret rare therefore prints **102/081** — a number that does
not exist in the English set. The English set's identity on a Japanese card's rail is wrong in
exactly the way that costs a sale, because it is the first thing a JP collector checks.

The rail carries the **romanised** name (`name_en`) — what an AU buyer searches, and what the Latin
rail font can actually draw. `findIntlSet` matches on the set code, the romanised name, the native
name **and** the English equivalent, because a stock row may have been saved under any of them. Its
normaliser is `\p{L}\p{N}`-based on purpose: an ASCII-only class collapses アビスアイ to the empty
string, at which point every Japanese set matches every other one.

**Never fall back to `name_native`, and never assume a string is drawable.** 146 of 277 JP sets have
no romanised name in the bake, and their native names are Japanese script the bundled Latin font
cannot draw. Pango does **not** fail on a missing glyph — it silently substitutes a SYSTEM font, so
Japanese renders perfectly on the Windows dev box and as blank boxes on a Linux server with no CJK
font installed, with nothing in the pipeline reporting it. The same class of silent substitution as
the `fontProbe` case, one level down.

So `composeMetaFor` falls back to the owner's own stored `set_name`, and `railText` drops any line
failing `isRailDrawable` (Latin script, digits and ordinary punctuation — `Pokémon Card 151` passes,
`スタートデッキ100` does not). A JP card with no romanised name still gets `JAPANESE` plus its symbol
and number; it just does not get a set name we cannot render.

### Where set symbols and logos come from

| | symbol | logo |
|---|---|---|
| **English** | pokemontcg.io cache (`images.symbol`), then the Bulbapedia bake | pokemontcg.io cache (`images.logo`), then the bake |
| **Japanese / other** | the **Bulbapedia bake** (`data/pokemon-set-symbols.json`) | the bake — 109 JP logos indexed |
| **Magic** | `lib/mtg-sets-cache.mjs` `findMtgSet().icon_svg_uri` — an **SVG**, off the resolved record | **none exists.** Scryfall publishes no set wordmark, so the masthead falls back to the set name |

⚠ **Set identity is resolved PER GAME.** `findSet`/`findSetSymbol`/`findSetLogo`/`findIntlSet` all index
the *Pokémon* set universe and none of them is game-scoped — they match a bare code or name. Codes
collide across games: Magic's `LTR` is Pokémon's Legendary Treasures (`bw11`), and un-guarded it
stamped a Pokémon symbol, a Pokémon logo **and** a fabricated `246/113` onto a Magic card.
`composeMetaFor` gates on `item.game` before any of them, and a game with no branch gets no set art
rather than someone else's. Never construct an icon URL from a code either — `svgs.scryfall.io`
answering 200 for a code we invented is the `images.scrydex.com` placeholder trap over again.

⚠ **A monochrome SVG icon rasterises BLACK.** Scryfall's icons are `<path>` elements with **no fill
attribute**, so librsvg draws them pure black (26190 of 26190 opaque pixels on `hob.svg`) — and the
rails run `#2e1640` → `#150a1d`. `.tint()` **cannot** fix this: tint multiplies, and black times
anything is black. `recolourGlyph` keeps the glyph's **alpha** (which carries the shape and its
antialiasing) and replaces the colour channels with `badge.color`. It is gated on the SOURCE FORMAT,
not the game, so PNG sources are untouched and no `ASSET_VERSION` bump is needed — but the fill IS
folded into the returned digest, because a recolour is a pixel change the source digest cannot see.
No density handling is needed: Scryfall icons are viewBox-only at 400–800px natural and downscale
into the 126px badge box.

`scripts/build-pokemon-set-symbols.mjs` indexes both Bulbapedia expansion lists and is registered as
the **`pokemon-set-symbols`** refresh bake. It resolves URLs only — a few batched API calls, no image
downloads; the images are fetched lazily through `lib/img-cache.mjs`, so the second listing from a
set is a local read.

**Symbols and logos use different filename conventions, and the logo one varies by era**, which is
why `findSetLogo` takes several candidates and the index is keyed under all of them:

| file | indexed under |
|---|---|
| `SetSymbolAbyss_Eye.png` | name `Abyss Eye` |
| `Jungle_Logo.png` | name `Jungle` |
| `SM1_Logo.png` | code `SM1` |
| `SV3a_Raging_Surf_Logo.png` | code `SV3a` **and** name `Raging Surf` |
| `M5_Logo_JP.png` | code `M5` — note the **language suffix** |

That `_JP`/`_EN` suffix is not a detail. Matching only `_Logo.png` caught 13 of 135 English logos and
missed the entire MEGA series — the era the compositor is actually used on.

**The index is LANGUAGE-SCOPED (`format: 2`).** A flat index let the Japanese page claim
`bw1`/`xy4`/`sm7` and shadow the English file of the same set code — 45 of them — so an English card
could be handed a Japanese logo. `findSetSymbol(lang, ...candidates)` /
`findSetLogo(lang, ...candidates)`. An index of any other `format` is refused outright rather than
misread; the refresh bake rebuilds it.

**Symbols and logos resolve by DIFFERENT language rules, because they are different kinds of thing:**

- A **symbol** is the little language-neutral mark printed on the card. Every localisation of a set
  carries the same one — Bulbapedia's "expansions in other languages" page is built exactly that way,
  one symbol per row with the set's name in each language beside it.
- A **logo** is the wordmark: the set's name as type, in that language. A Korean card wearing the
  Japanese logo is the wrong product, the same failure as the shadowing above.

| card language | symbol | logo |
|---|---|---|
| English | `en` | `en` |
| Japanese | `ja` | `ja` |
| Korean, Traditional Chinese | **`ja`** — translated JP releases | none |
| Simplified Chinese | none | none |
| anything else / unknown | none | none |

Korean and Traditional Chinese sets *are* Japanese sets translated: 78/101 KO and 46/98 ZH-TW codes
in the intl bake are Japanese set ids (`SV6`, `SV9A`, `CS1.5`…), so a code lookup in the `ja` bucket
finds the right set. Simplified Chinese is its own product line (`CSV9C`, `CBB5C` — only 8/65
Japanese-shaped) and resolves nothing. An unknown language resolves nothing rather than defaulting to
English: defaulting is what handed a Korean card the English logo in the first place.

**`normName` (build) and `normSetKey` (lib) must stay byte-identical** — the index is written with
one and read with the other, so any divergence is a lookup that silently finds nothing. Both do
NFD → drop Latin combining marks (U+0300–U+036F) → **NFC** → strip non-letters. The recompose is
load-bearing: NFD leaves ガ as カ + U+3099, and U+3099 is a nonspacing mark that the `\p{L}\p{N}`
filter then eats, folding メガブレイブ into メカフレイフ and colliding distinct Japanese sets. A test
pins the two functions against each other.

`lookup()` tries three things in order, and **an exact match always wins**:

1. **Exact**, against every identity the caller passes.
2. **`SET_NAME_ALIASES`** — TCGdex and Bulbapedia romanise differently, so our `Glory of Team Rocket`
   is the wiki's `Glory of the Rocket Gang`, `Heat Wave Arena` is `Hot Wind Arena`, `Mask of Change`
   is `Transformation Mask`. Deliberately a short checked list, never fuzzy matching: a near-miss
   that resolves to the WRONG set puts the wrong symbol on a listing, which is worse than none.
3. **`baseSetCode()`** — JP sets often ship in pairs sharing one logo file. `SV4K`/`SV4M` (Ancient
   Roar / Future Flash) both live under `SV4_Logo_JP.png`, as do `M1L`/`M1S`, `SV11B`/`SV11W`,
   `SV5M`/`SV5K` and `SV2D`/`SV2P`. A code that is already a base returns `''`, so it cannot resolve
   to itself and mask a genuine miss.

**Coverage** (audit with the snippet in `test/unit/pokemon-set-symbols.test.mjs`): English is
**174/174** on both. Japanese 2023+ is **84%** on both once the upstream-suspect block below is
excluded; what remains is starter decks and promo products (`MC`, `M-P`, `SVLN`, `SVLS`, `SVK`,
`SVG`) that have no wiki symbol because they are products, not expansions.

### TCGdex name collisions (`nameSuspect`)

TCGdex sometimes returns ONE set's identity for a whole block of distinct codes: as of 2026-07 all
fifteen JP `CS*` ids come back as トリプレットビート with the same 101-card count and the same
release date, and the same collision appears in `zh-tw` and `ko`. Baked verbatim that reads as
fifteen real sets — in the catalog, and on a listing image's rail.

`build-pokemon-intl-sets.mjs` flags any block of **4+ distinct codes sharing one upstream native
name** as `nameSuspect`, warns during the bake, and counts them in the summary. It does **not**
invent replacements (Golden Rule 4). `composeMetaFor` prefers the owner's own stored `set_name` for
those rows, so a suspect upstream name never reaches a rail. The real fix is a seed entry per set in
`data/pokemon-intl-seed.json` once the true names are known, or upstream correcting it.

Two things it took a while to establish, so they are worth not rediscovering:

- **Bulbapedia's files live on the Bulbagarden *Archives* wiki.** `prop=imageinfo` against Bulbapedia
  itself reports every one of them `missing`, which makes the whole approach look like a dead end.
- **There is no CDN with Japanese set symbols.** TCGdex serves only the old shared `univ` ones
  (neo/xy/bw — every modern JP set 404s), and `images.scrydex.com` has no JP ids at all. It does not
  404 for them either: it answers **200 with a generic 186KB placeholder** for any unknown id,
  including an empty one. A constructed URL therefore yields a valid PNG of nothing, silently.
  `loadSetArt` hashes what it fetches and drops anything matching `CDN_PLACEHOLDER_SHA`, so this can
  never reach a rail.

A host without the bake degrades to a number-only badge, so run it once on a fresh checkout:

```bash
node scripts/build-pokemon-set-symbols.mjs
```

**The number goes through `printedCardNumber()` (Golden Rule 10), which guards a real trap.**
`formatCardNumber` takes the RAW upstream number; the uploader already stores a formatted one. Feed
`"069/086"` back through it and it falls past both numeric branches into the trailing
`raw + '/' + denom`, yielding `"069/086/086"`. So anything already carrying a slash is treated as
printed and passed through untouched, while a bare `"6"` from a bulk import is still rebuilt from the
set's era (`006/084` for a modern set, `58/102` for a pre-Sword-&-Shield one).

### The four silent failures

Everything that can go wrong here goes wrong **without an error**, which is why the readiness
plumbing exists (`describeCompositor()`, surfaced in `/api/status` and on the lab page).

1. **The font.** sharp's `text.fontfile` adds the file to the font set but `font` still selects the
   face through fontconfig. With `font: 'sans'` the fontfile is **ignored**, and a family name that
   does not match the TTF's internal name renders the system default with no error at all —
   `'Genty-Sans'` substitutes where `'Genty Sans'` does not (measured). `fontProbe()` renders the
   same string twice, once with the configured font and once with the bare fallback, and compares
   pixels: identical means the font did not load. Deliberately not a hardcoded pixel pin — libvips
   rasterises identically for a given build but not necessarily across builds, so a pin would fail on
   the server for a font that is working fine. A failed probe drops the text layer and keeps the
   rails; it never fails the image.
2. **Missing rail art.** A variant registered in `VARIANTS` with no directory under `rails/` throws
   only when someone lists a card of that language. `test/invariants/listing-image-assets.test.mjs`
   catches it at `pnpm test` instead.
3. **No `sharp`.** It is the repo's only runtime dependency and it is a native binary, so it is
   imported **lazily**: a host without it still boots the dev server and still runs `pnpm test`, and
   every call site falls through to the un-composed image with a warning. GR7, applied to a
   dependency. `pnpm-workspace.yaml` needs it in `onlyBuiltDependencies` (**not** the older
   `allowBuilds:` map — pnpm 10 does not read that one).
4. **No SVG support.** Scryfall serves Magic's set icons as SVG, and a sharp built *without* librsvg
   throws on one — `loadSetArt` catches it, returns `null`, and the badge quietly comes out
   number-only with nothing logged anywhere. `svgProbe()` rasterises a 2px SVG once and reports it
   through `describeCompositor()`, so the cause shows up in `/api/status` rather than on a composed
   image weeks later.

### The content hash IS the cache key

`sha256(sourceBytes ‖ layout ‖ ASSET_VERSION ‖ variant ‖ renderedTextLines ‖ railArtDigest ‖ badge)`,
hashing **inputs, never output bytes** — libvips is deterministic per build but not across builds, so
hashing output would give one card two different keys on the dev box and the server. `badge` is the
drawn card number plus a digest of the set symbol: two cards from one set share art but not a number,
and once the number is on the rail, leaving it out of the key is the same collision the rail text had
to fix.

**`layoutFingerprint` sorts keys at every level by hand — do not "simplify" it back to
`JSON.stringify(o, Object.keys(o).sort())`.** That replacer-array form looks like a key ordering but
is a RECURSIVE property allowlist: applied to a nested object it keeps only properties whose names
also appear in the array. With only top-level names listed, the whole `text` and `badge` blocks
serialised to `{}` — so restyling the rail text or moving the set badge changed nothing in the hash,
and every cached composite and hosted eBay image would have kept the old art with nothing to explain
why. `test/unit/listing-image-config.test.mjs` pins the nested blocks against exactly this.

The **rendered text is part of the key**, and this is load-bearing. `lib/ebay-media.mjs` deliberately
dedupes catalog art on `source_url` **alone**, so one card's art uploads once for the whole store.
Compositing breaks that premise: a Japanese and an English printing share art but not rails. So with
compositing on, `cachedEps()` keys on `compose_hash` instead, which *keeps* the dedupe win (two copies
of one card still upload once) while making a cross-card collision impossible.

Two consequences worth knowing:

- **Condition must never reach the rail.** An NM and an LP of one card are two stock rows with
  identical bytes; putting condition on the rail would split every pair into two eBay uploads.
  `railText()` is language + set name only, and a test pins that.
- The `source_url` / `local_path` branches carry `AND compose_hash IS NULL`. Without it, an item
  published *with* rails and then switched off would match its own branded row and keep them — the
  toggle would silently do nothing. Every pre-compositing row has a NULL hash, so this changes
  nothing about the old behaviour.

`compose_version` (`v1/japanese/f08bad85`) is stored alongside as the **audit** token: it answers
"which live listings are still on the old art?", which a hash alone cannot.

Bumping `ASSET_VERSION` invalidates every cached composite and every `listing_images` row keyed on the
old value — that is the point, and it is why the constant lives in **code** and not in the
settings-editable JSON. Swapping the rail PNGs invalidates too (their digest is in the hash), so
dropping in new art re-composes even if nobody remembered to bump the version.

### Owner photos are branded at UPLOAD, not at publish

`POST /api/listings/photos` pushes straight to eBay EPS, so by publish time there are no bytes left
to work on. Branding therefore happens in that route — and the route now **retains the original** at
`data/photo-originals/<sha256>.<ext>` in `listing_images.local_path`. It used to discard the decoded
data URL; with rails baked in and no original, an `ASSET_VERSION` bump could never reach an owner
photo and the only recovery would be re-shooting the card. `POST /api/listings/:id/photos/recompose`
rebuilds from those originals. **These are the only non-regenerable bytes under `data/`** and
`data/backup.config.json` does not cover directories.

`runPublish` warns (never blocks — GR7) when a photo's `compose_version` is behind the current one.

### Branded rails do NOT satisfy the stock-photo refusals

`sub_nm_no_photos` and `graded_no_photos` in `lib/runner-core.mjs` stay hard blocks regardless of
whether compositing is on. Framing catalog art in store chrome changes how the thumbnail looks and
nothing about what it *is*: a stock image on a used item, which is an eBay policy breach. There is a
comment at the refusal site saying so, because it is exactly the "tidy-up" someone will attempt.

### The item description frame (same set art, different surface)

The set logo and symbol resolved for the rails also dress the **description**. `composeMetaFor`
hands `runPublish` a `setLogoUrl` + `setSymbolUrl`, which reach `buildItemDescription` in
`lib/channels/ebay-map.mjs` and then `buildDescription` in `lib/listing-copy.mjs` — so a card gets
its set's real logo in the masthead and its symbol beside the card number, from the same
language-scoped index the rails use (§19 above). No art resolves ⇒ the set *name* renders instead.
`artUrl` beats `imageUrl` for the in-description picture: the description wants the clean catalog
scan, not the branded 1600×1600 hero, and falls back to the hero only when owner photos replaced it.

**The layout has two non-obvious load-bearing details, because GR8 leaves no media queries.** eBay
strips `<style>`, so the art/pitch pair goes side-by-side or stacks using two `display:inline-block`
siblings, which share a line while both fit and wrap when `min-width` cannot be honoured:

- **No whitespace between `</div><div`.** A text node between inline-blocks renders as a space,
  pushes the pair over the line, and they never sit together. A formatter reflowing that file breaks
  the layout silently.
- **`width:calc(100% - 216px)` on the copy.** An inline-block sizes against its **container**, not
  the space left on the line — omit the width and the copy claims 100% and always wraps.

Measured in the browser: stacked and full-width to ~480px, side-by-side and vertically centred from
~545px up, no horizontal overflow at any width. Pinned by
`test/invariants/ebay-html.test.mjs` (the pair's adjacency, the `calc()`, and the no-art path
dropping the split entirely). Per GR9 `pokemon-listing-builder.html buildHTML()` mirrors this
byte-for-byte — `node scripts/check-listing-copy.mjs` is the gate.

⚠ That file's **static** GR8 scan greps the builder source for `<style`/`<script` literals, so even a
*comment* mentioning those tags in `buildHTML()` fails the test. Say "STYLE and LINK elements" in
prose rather than weakening the check.

### eBay's image policy

eBay prohibits added borders, artwork and promotional text on listing photos. Enforcement in TCG
categories is effectively nil and competitors run heavily branded rails, but the account was up for
Top Rated Seller review on **20 August 2026**. So the `default` variant carries the **logo mark and
the card's own metadata only** — no "check our store", no contact details, no promotional copy. That
reads as identification rather than advertising. Keep anything more aggressive as a separate variant
to opt into deliberately.

### Validation

`test/unit/listing-image-config.test.mjs` (variant precedence, geometry invariant
`rails*2 + cardBox === canvas`, the hash sensitivity matrix) · `test/unit/listing-image.test.mjs`
(EXIF orientation, aspect edge cases, trim guards, rails-survive-compositing, determinism, the
degrade-without-a-font path) · `test/unit/listing-image-cli.test.mjs` ·
`test/unit/listings-compose-context.test.mjs` (the on/off precedence and the meta shape) ·
`test/invariants/listing-image-assets.test.mjs` (art present + the font probe genuinely fails on a
wrong family) · `test/integration/listings-compose.test.mjs` (**the cache-key contract, including a
flag-off no-op proof**) · `test/integration/listings-photos-compose.test.mjs` (original retention +
recompose) · `test/integration/listing-image-lab.test.mjs` (the lab routes + `/api/settings` refusing
broken geometry). All wrapped by `pnpm verify`.

**Goldens are text-free and tolerance-based on purpose.** libvips output is not guaranteed identical
across builds, so pixel comparison uses `test/helpers/image-diff.mjs` (hand-rolled on raw RGBA — no
`pixelmatch`) with a threshold. Note the rail invariant only holds **pre-encode**: after JPEG the max
channel error at the rails' hard gold edge is ~31, so the assertion is on the *fraction* of differing
pixels, which a moved or rescaled rail fails loudly and JPEG ringing does not.

### Still open

The **cross-host determinism check has not been run**: ALCSERVER exposes only the app port, no shell.
Once `sharp` is installed there, run the CLI on the same source file on both hosts and compare the
printed `contentHash` — it hashes inputs, so it should match by construction; a mismatch means the
layout or the font differs, not that libvips does.

---

## 20. Is this dev server running the code on disk?

`GET /api/status` → `plugins`:

```json
"plugins": {
  "registered": ["bricklink-proxy", "bulk", ..., "listing-image-lab", "status", "tracker"],
  "registered_at": "2026-07-28T22:58:24.352Z",
  "stale": false,
  "stale_files": [],
  "newest_source": "lib/plugin-registry.mjs",
  "newest_source_mtime": "2026-07-28T22:58:24.287Z"
}
```

**`stale: true` means restart the dev server.** One `curl`, no page load:

```bash
curl -s http://192.168.4.200:5273/api/status | jq '.plugins | {stale, stale_files, registered_at}'
```

### Why this exists, and why the obvious checks don't work

ALCSERVER once reported the current git commit *and* served the new `/api/settings` entry, while
`/api/listing-image/*` fell through to Vite's page fallback and returned HTML with a 200. The
process had `lib/status.mjs` loaded but had never run the new plugin's `configureServer`, which only
fires at startup. The uploader page just said "could not read the compositor settings".

The trap: **a stale process has stale everything in memory** — its config object, its module graph,
even the git commit if that was memoised at boot. Comparing two in-memory values can never catch it.
`versionInfo()` is no help either: it shells out to `git rev-parse` and so reports the tree, not the
running code.

So `pluginHealth()` compares two things that genuinely differ:

- **when** this process registered its plugins (memory, frozen at startup), against
- the newest mtime of the server sources **on disk** (`vite.config.js` + `lib/**/*.mjs`, read fresh
  on every call).

A source newer than the registration means the process predates the code. That is precisely what a
`git pull` without a restart looks like. `MTIME_SLACK_MS` (2s) absorbs the startup race — the server
stats files it loaded moments earlier — and filesystems with coarse mtime resolution.

`registered` is the other half of the diagnosis: it lists the plugins that actually claimed routes in
*this* server, so a missing name points straight at the subsystem whose endpoints are 404ing or
returning HTML.

### Coverage is enforced

`vite.config.js` wraps its array once — `plugins: withRegistry([...])` — so a plugin added later is
covered without anyone remembering to. `test/invariants/plugin-registry.test.mjs` asserts the wrapper
is present, that there is exactly ONE `plugins:` array, and that every entry inside it is imported or
declared. Without that, a plugin appended outside the wrapper would register nothing and the check
would go quietly blind — the same class of silent failure it was built to catch.

Plugins with no `configureServer` pass through untouched: they own no routes, so their presence says
nothing about staleness.

**Testing note:** do not bump the mtime of an existing `lib/*.mjs` to simulate staleness. Every one
that `vite.config.js` imports is a watched config dependency, so Vite restarts the whole dev server
and any in-flight test dies on a closed socket. Write a throwaway file nothing imports — invisible to
Vite's watcher, still visible to the registry's walk. `test/integration/listing-image-lab.test.mjs`
does exactly that.

---

## 21. Pre-grader (`card-grader.html`) — predict the grade before paying for one

The question the tool answers is "is this raw card worth a grading fee?". Capture the card
(flatbed scan, microscope, camera or plain upload), measure centering **geometrically**, run an AI
condition pass over corners/edges/surface, and get a per-company predicted grade (`grade-rules.js`
driven by `data/grading.config.json` — PSA/BGS/CGC/PCG/TAG), a TAG-style annotated report
(numbered severity-colored defect pins on the images, a per-corner grid, a /1000 breakdown
labeled a **house approximation** — explicitly not TAG's DIG), and a PDF. Pokémon-first; other
games work through the manual identity fields. A prediction is an ESTIMATE and is treated as one
everywhere (GR4): "To pipeline" creates a grading **submission** (§13), never a graded item.

**The 12-shot wizard.** Twelve labeled slots in four groups — `scan-front`/`scan-back`,
`mic-corner-{front,back}-{tl,tr,bl,br}`, `surface-front`/`surface-back` — with current-step
highlight, skip, and auto-advance; drag-drop coexists. Corner shots are framed to include the
**two adjacent half-edges**, so edges need no shots of their own. Scan buttons appear only when
`GET /api/scan` says so (capability-gated, with a dpi picker); the camera choice is remembered
**per shot kind** (`localStorage` `grader_cam_by_kind`) because the Tomlov microscope enumerates
as an ordinary UVC videoinput — pick it once for corners and the webcam stays on surface shots.
Resolution is split: originals keep ≤2500px (camera) or native (scans); the copies sent to the AI
are re-downscaled to 1568.

**`/api/scan` and the WIA script contract.** `scripts/wia-scan.ps1` is the only thing that talks
to the scanner: `powershell.exe` 5.1 WIA COM (pwsh 7 untested — the pin is deliberate), emitting
**exactly one JSON line on stdout** — the route parses nothing else. Transfer is BMP →
`ImageProcess` Convert → PNG (direct-to-PNG transfer is not reliable across drivers), SaveFile's
target is pre-deleted, and it never opens `WIA.CommonDialog`. **Resolution is set before extent**:
the driver's extent `SubTypeMax` scales with the DPI already set, so setting extent first clamps
against the wrong maximum. The route holds a module-level lock (second scan → 409
`scanner_busy`), times out at 90s, and cleans its temp file in a `finally`. Verified live on an
Epson Perfection V39 II: 160×220mm @ 600dpi → 3780×5197 in ~23s; 110×140mm @ 300dpi ~9s /
600dpi ~15.7s; driver max 1200dpi.

**Auto-centering + the confidence-gated crop.** The scan region defaults to **160×220mm** because
nobody places a card at the platen's exact corner — the first real card sat ~35mm off it and a
110×140 window cut it off. `lib/scan-centering.mjs` finds the outer edge (ring-median background
+ run-gated row/col profiling + a 63:88 aspect sanity check) and the inner frame (strongest
sustained gradient 2–12% inward over the central 60% of each edge), reports per-edge confidence,
and yields `inner:null` on a full-art card rather than inventing a frame. When
`confidence.outer ≥ 0.5` the route crops to the card + 12% margin and re-encodes **JPEG q92**: a
live 600dpi holo scan was an 11.5MB PNG vs ~1.8MB JPEG, and a 1200dpi PNG as base64 would blow
the 28MB save-path cap. Analysis coordinates are shifted into the crop, so the client's guides
land on the borders unchanged. On the client the seeded guides carry an **"auto — confirm"**
badge; any drag downgrades it to manual, honestly.

**AI schema v2 (v1 still accepted).** `lib/grader.mjs` sends up to 12 `{id,mediaType,dataB64}`
images plus `context.shots [{id,label}]` so the model knows which crop is which corner, and gets
back per-corner `{tl,tr,bl,br}` + per-edge `{top,right,bottom,left}` per side; every defect
carries `{imageRef,x,y}` fractions — that is what the annotated pins render from. `normalize()`
is dual-shape: a v1 flat response is still valid, and flat aggregates are derived as the **MIN**
of the granular cells (the worst cell caps the side — mirroring `GR.sideFromCorners`/
`sideFromEdges`), so v1 clients keep working. Token caps: Anthropic `max_tokens` 6000, OpenAI
`max_completion_tokens` 2048. The engine itself also lost two dead branches (behavior-preservation
swept 24,975 outputs, 0 diffs) and gained its first unit tests.

**Persistence: a prediction never masquerades as a grade.** `pregrade_reports` holds the full
report; `pregrade_images` (`UNIQUE(report_id,shot_id)`, cascade) points at content-addressed
bytes in `data/pregrade-images/`, served immutable at `GET /api/pregrade/file/<sha>.<ext>`.
Images upload ONE per request (28MB cap); `DELETE` refcounts before unlinking, so two reports
sharing a sha don't lose the file when one dies. **The report stores the PREDICTION; the actual
grade lives only on `grading_submissions.result_grade`. The saved list LEFT-JOINs the linked
submission to show "predicted PSA 9 · actual 9" — nothing ever copies the actual back onto the
report** (GR4: the prediction stays an honest before-the-fact record). The link is
`grading_submissions.pregrade_id` (additive migration, in `SUB_COLS`); "To pipeline" saves the
report FIRST, sends `pregrade_id`, then PATCHes the report to `sent`. Deep link `?report=<id>`.
Two open tails: `data/pregrade-images/` is gitignored and **not regenerable** (backup coverage
undecided), and a superseded shot's bytes linger until the last referencing report is deleted
(documented; a sweep script only if it ever matters).

**Dev-server-only, like everything else (GR1).** `scanPlugin` and `pregradePlugin` are Vite
plugins in `vite.config.js`. ALCSERVER has no scanner, so its capability probe answers
`enabled:false` and the scan buttons hide — that is the designed behavior, not a fault.

**Sleeves, white lids, and the matte-black backing.** Scanning a sleeved card against the white
lid, the analyzer locks onto the **sleeve** edge (a live measurement came back 65.6×89.7mm — a
sleeve, not a 63×88 card) and caps outer confidence at 0.5 **by design**: a white border cannot
be told from a white lid. The fix is setup, not code — a matte-black backing behind the sleeve
makes the card edge out-contrast the sleeve. Sleeved cards are fine to scan.

**Open QA** (as of 2026-08-22, evening):

- [x] ~~Tomlov microscope corner shots live-tested~~ DONE — owner ran the full wizard in a real
      browser (the in-app Browser pane blocks getUserMedia; localhost in a normal browser works).
      Corner shots resolve individual print rosettes with both half-edges in frame.
- [ ] Black-backing vs white-lid comparison shot (white-lid path verified working, with the
      caveats above).
- [x] ~~Full 12-shot AI pass with all corner shots attached~~ DONE — every granular cell filled,
      confidence 67%→76% with full coverage, one coordinate-pinned defect on the back scan.
- [x] ~~1200dpi timing measurement~~ DONE — 79–83s for 160×220mm (7559×10394px). 1200 is now the
      DEFAULT (owner's call) and the WIA driver's ceiling (hardware claims 4800 optical, driver
      exposes SubTypeMax 1200; Epson Scan 2's higher modes have no CLI). Scan timeout 240s; the
      no-crop fallback re-encodes full-frame JPEG q92 (96MB PNG base64 → 4.6MB measured). Scans
      auto-rotate to portrait when the card is found sideways (180° stays a manual ⟳ per shot);
      pads show mm border readouts and open a full-screen editor (⛶) with precision skew
      rotation (±5° in 0.05° steps, baked into the shot's bytes on Done so the AI pass, pins,
      PDF and persistence all see the straightened card).
- [ ] ALCSERVER post-deploy check: scan buttons must hide (no scanner there), NSSM service
      restart after pull, then `/api/status` `plugins.stale` (§20).


---

## 22. Purchase orders / incoming stock (`purchasing.html`)

`orders.html` is the OUTBOUND fulfilment queue. This is the inbound side: stock **bought but not yet
held** — where it came from, what it cost, what is still owed, and the check-in that turns a carton
into inventory. `purchasing.html` / `lib/purchasing.mjs` / `lib/purchasing-money.mjs`,
`/api/purchasing/*`, five tables in `data/tracker.db`.

**Nothing in these tables is stock.** They record an intent to buy. Stock exists only once a receive
COMMITS, at which point the units are written through the two seams below and the line is stamped
with what it produced.

### Why the same DB

The receive writes `purchase_lines` AND `sealed_items` / `sealed_placements` / `inventory_items` in
**one transaction**, and SQLite cannot span two database files. `lib/postsale-db.mjs` is the
precedent for a subsystem owning its own store; purchasing must not follow it. Same DB is a
correctness requirement here, not a preference.

### The two seams — and the invariant they protect

`sealed_items.quantity` is a cached SUM of `sealed_placements` and `sealed_items.location` its
primary spot. Any writer that skips the sealed module's own placement helpers corrupts that mirror
**silently** — the item still reads fine, it just stops agreeing with the shelf. So purchasing never
writes raw INSERTs into stock:

- `receiveSealed(db, {...})` — `lib/sealed.mjs`. Creates or merges, routing every unit through
  `addStock` / `setPlacements` so the mirror is re-derived.
- `receiveInventory(db, {...})` — `lib/inventory.mjs`. The twin for singles and slabs. There is no
  placements table there, so **one line lands in one spot**; splitting is a sealed-only capability
  and the gate refuses it elsewhere rather than dropping spots.

Both take **AUD cents**. See the money section below for why that is not a GR3 violation.

### The lifecycle

`draft → preorder | ordered | cancelled`, `preorder → ordered`, `ordered → in_transit | arrived`,
`in_transit → arrived`, `arrived → (receive) → received → closed`, and `cancelled → draft`
(cancelling is sometimes a mistake). Enforced server-side by `TRANSITIONS`, and served at
`GET /statuses` so the page's dropdown can disable what the server would refuse.

**Neither `received` nor `closed` appears in any transition list.** `received` is a claim that stock
exists and only a committed receive can make that true — the same discipline as
`grading_submissions` reaching `graded` only through promote. `closed` runs its own checks (a receipt
exists; nothing is still owed unless `force_close_unpaid` says so) and stamps `closed_at`. A PATCH
asking for either gets a 409 naming the endpoint that owns it (`receive_via_endpoint` /
`close_via_endpoint`). Leaving `closed` in the table was not cosmetic: `fillOrderForm` builds the
page's dropdown *from* this table, so it was the only move the UI offered on a received order, and
taking it skipped every check.

**An order can only be CREATED in `draft`, `preorder` or `ordered`** (`CREATE_STATUSES`). Creating
one directly in `arrived` skips the whole history and is immediately receivable; `closed` would
assert a receipt that does not exist.

**A preorder needs a `release_date`**, because a preorder is an order whose product does not exist
yet. It is its own tab and stays out of `Outstanding`, so a six-month-out preorder never clutters
"where is my stuff".

### Receiving

`POST /orders/:id/receive?dry=1` builds the plan and writes **nothing**; the same call without `dry`
rebuilds it from the same rows and applies it, so what the owner approved is what happens.

`reconcileGate` blocks the WHOLE order on: an uncounted line, a count differing from the order with
no reason code, a split that does not sum to the count, a split on a line that cannot split, or a
lot that has not said how many items came out. Every unready line is reported at once.

**Idempotency is `purchase_receipts.UNIQUE(order_id)`**, and the receipt INSERT is the transaction's
first statement — a double tap, a retried fetch or a second tab throws on the constraint and rolls
back before one unit has moved. A repeat request returns `{already:true}` with the original result.

**A dead restock link is a warning, not a blocker** (GR7). The ladder is: the row exists, its
`link_sku` still matches **and it is still HELD** → merge; otherwise, if exactly ONE held row matches
the snapshot → merge and flag `link_repaired`; otherwise create and flag `link_broken`.

**"Held" is `HELD_STATUSES` = `in_stock` OR `listed`, and the pair matters in both directions.**
Excluding `sold` is the point: a card can sell while its restock is on the water, and merging six
boxes onto a sold row hides them from every in-stock view while `summarizeSealed` goes on counting
them as sold. But `listed` is emphatically still held — restocking something currently on eBay is
the *ordinary* case, the picker offers a `listed` filter for it, and `lib/sealed.mjs`'s own valuation
query uses the same pair. A guard that accepted only `in_stock` split the pile across two SKUs, left
the live listing's quantity untouched and never blended the cost basis. Both the direct path and
`identityMatches` use `HELD_STATUSES`, because a repair path narrower than the direct one sends a
listed product down the create branch the moment its link breaks. Deliberately conservative:
guessing which of two similar rows a delivery belongs to is worse than creating one the owner can
merge by hand. Either way the goods get put away, because they are physically on the floor.

### Money

- Amounts are stored in **the currency the order was placed in** and never pre-converted (GR3).
  `purchase_orders.currency` is the sibling for the order and every line; payments carry their own
  plus `fx_to_order`, because a USD invoice settled off an AUD card is the normal case here.
- **The one place a conversion is written is the stock row at receiving, and that is deliberate.**
  `sealed_items.cost_cents` has NO currency column, and `sealed.html`'s `dcAud` already converts in
  the browser before it POSTs — the field is literally labelled "stored in AUD". Every existing
  reader (`summarizeSealed`, `summarizeInventory`, `/locations/contents`, the repricer floor, the
  deal engine) assumes AUD, so receiving must match or it silently mixes currencies. The native
  truth is preserved forever on the purchase line, and `sealed_items.po_line_id` /
  `inventory_items.po_line_id` is the pointer back to it plus the rate used. This is also standard
  cost-basis accounting: you paid what you paid on the day.
- **FX has one accessor**, `effectiveFx`: the settled rate once the bank figure is known, the live
  estimate until then. An unsettled foreign order is labelled `EST FX` on screen (GR4). A foreign
  order with **no** rate refuses to receive (`fx_required`) rather than inventing one.
- **Charges allocate BY VALUE.** These cartons hold six booster boxes and four hundred raw singles;
  by quantity the singles would carry nearly all the freight and a 20c common would claim to have
  cost 60c. `?basis=qty` exists for the heavy-and-cheap case, and which ran is on the receipt.
- **`apportion` is largest-remainder and sums to its input exactly**, for every input including a
  negative pot (a discount can legitimately exceed the freight). Asserted over 500 random cases in
  `test/unit/purchasing-money.test.mjs`. The same primitive splits a bulk lot, which is the owner's
  stated rule: a lump over N items must sum back to the lump, to the cent.
- **Per-unit fees round UP.** One `acq_fees_cents` column cannot say "3 at 34c, 2 at 33c", so the
  error is bounded by (qty − 1) cents and points at *over*stating cost, which understates profit —
  the safe direction for a price floor. The exact figure stays on `purchase_lines.alloc_fees_cents`
  and the preview shows the residue rather than hiding it.
- **A restock blends to a weighted average**, separately on `cost_cents` and `acq_fees_cents`, so
  `cost_cents × quantity` stays a true statement about the pile — which is exactly what both
  summarizers assume. A null is not a zero: an unknown old cost adopts the new figure rather than
  being halved by an unknown one.

### Line shapes

- **`unit`** — N identical units into one stock row (or merged into an existing one).
- **`lot`** — a lump price whose contents are sorted later. On receipt the lump plus its freight
  share splits evenly across `lot_units`, producing **one or two** `inventory_items` rows (two when
  it does not divide) sharing a `po_line_id`. **Anything reading a lot must group on `po_line_id`,
  not `received_item_id`, which names only the first row.** They take the `BK-RAW-*` namespace, not
  a shelf label: §16b is explicit that a lot is one object rather than a slot on the singles shelf,
  and the shelf counter never rewinds.
- **`grading`** — you already own the cards and are buying a service. Creates no stock; the fee
  lands on `grading_submissions.grading_cost_cents`, which promote already folds into
  `acq_fees_cents` (§13). No new plumbing. The submissions are named in
  `purchase_lines.submission_ids` (a JSON array, read by `parseSubmissionIds`) and the gate refuses a
  grading line that names none — with nothing to write the fee to, the money would land on nothing
  and say so nowhere. **Do not put these in `identity_key`**: that column is a PRODUCT identity
  everywhere else and is copied verbatim out of `link_snapshot`, so a real key parsed to `NaN` and
  the fee silently vanished. That is exactly how this column came to exist.
  `unit_cost_cents` is the fee for ONE card, so `submission_ids.length` must equal `qty_received` and
  each submission is credited the per-card fee **once** — the gate enforces that ratio, because
  crediting the full figure to every id books a multiple of what was paid into permanent cost bases.
  `GET /api/purchasing/submissions` serves the open submissions for the line editor's picker; a line
  kind the page cannot complete is a line kind that blocks the whole delivery.

### Storage location

Chosen at **receiving**, which is the point of the feature. Named spots win; otherwise the order's
`default_location`; otherwise unassigned. A sealed unit line can split across several spots
(`purchase_line_placements`, the same shape `sealed_placements` takes). New spots are created inline
against `POST /api/sealed/locations` — **locations have one owner** (§16) and are not re-served here.

### What this deliberately does NOT do

Stated so nobody "helpfully" adds them later — these are the owner's calls:

- **No partial-receipt / backorder engine.** An order arrives once. A shortfall is a reason code on
  a line, not a second open receipt; goods that genuinely turn up later are a new order.
- **No suppliers table and no supplier admin page.** The name is free text and `GET /suppliers` is
  DISTINCT over past orders UNION the `source_vendor` already on stock — so the first purchase order
  offers names typed into `sealed.html` for months.
- **No CSV import, no paste-parse, no barcode scan.** Every line is typed, or picked off held stock.
- **No restatement of an already-received order** when settlement lands late. The receive screen
  warns on an unsettled foreign order so the owner can settle first. Known limitation.

### Sharp edges

- **`po_line_id`, `link_item_id` and `received_item_id` carry no FK**, for the reason
  `migrateSealedListing` spells out: `sealed_items.id` and `inventory_items.id` are independent
  sequences, so an FK would pass against the wrong table. The `*_kind` discriminators are what make
  the pairs mean anything, and `link_sku` is the extra guard against a restored-from-backup id
  collision.
- **`nextSku` in `lib/inventory.mjs` routes through the monotonic `nextStockLabel`** (§16b). Label
  allocation happens inside the receive transaction, so a rollback un-burns them — but nothing may
  allocate during a *preview*, which is why the preview writes nothing at all.
- **A future "keeper's runs / mystery bundle" is not blocked.** `line_kind` is validated against a
  const array, so adding one is an entry plus a receive branch; a bundle's cost basis is the `lot`
  split already built. `lib/channels/shopify-map.mjs` already maps `bundle: 'Mystery Bundle'`.

