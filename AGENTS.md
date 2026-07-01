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

3. **Money is integer cents.** Compare/round money as `Math.round(x*100)`. The
   pricing calculator and FX conversion depend on this; never compare raw floats.

4. **Live pricing beats estimated pricing — always.** Surface API/live market
   numbers. Do not add features that present a model-guessed price as
   authoritative. (Owner's hard rule; model price estimates have been off by
   10x+ in practice.)

5. **Preserve variant accuracy.** Alt-art vs base printings differ enormously in
   value and must stay distinguishable — the `a` collector-number suffix
   (`039a`), Scryfall `frame_effects`/`border_color`, SWU `VariantType`, Scrydex
   variant/rarity. Don't collapse them into one "version".

6. **Condition / postage / footer blocks are per-product-type.** For the **five
   card builders** they are identical, owner-verified wording — if you edit one
   card builder, edit all five: condition = `"{cond}. Pulled straight to sleeve
   and stored in a toploader."` (default `Ungraded, Near Mint`); postage =
   `"Ships in a penny sleeve and toploader inside a rigid mailer, with FREE
   postage within Australia."`; footer = `"From a smoke-free home. Fast dispatch.
   Thanks for looking."`
   The **LEGO and Funko builders have their own condition/postage wording**
   (`condText()` / `postageText()` in each file) because the card wording is
   physically wrong for boxed goods — a LEGO set or Funko box does not ship in a
   penny sleeve, and bulky LEGO can't honestly offer free postage. **Do not
   "unify" these back to the card constant.** The footer line stays shared across
   all product types. Condition wording is driven by explicit seller fields and
   defaults to the *safest* option (LEGO `Used – Complete`, Funko `Near-Mint`
   box) so an un-edited listing under-promises — never over-promises (INAD risk).

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

---

## 3. Run / dev loop

```bash
pnpm install
cp .env.example .env        # all keys optional — Riftbound works keyless; Scrydex adds pricing
pnpm dev                    # serves http://localhost:5273 (host:true → also on the LAN)
```

- There is **no test runner**. Validate JS edits with `node --check` on the
  extracted inline script (see §8).
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
| `riftbound-listing-builder.html` | Riftbound builder. Three interchangeable sources (`source` ∈ `offline`/`riftscribe`/`scrydex`): **offline** = baked `data/riftbound.json` (default, all 4 sets, keyless, images + stats); **riftscribe** = `/api/rbs` live keyless; **scrydex** = `/api/rb` (optional key) for market price + the price-trend graph. eBay AUD comps overlay (`findRBComps`, renders into `#ebayextras`) works under any source. |
| `lego-listing-builder.html` | LEGO set builder. Set-number lookup → Rebrickable (core) + Brickset (RRP/age) + BrickLink (new/used market price). LEGO condition/postage model + item-specifics block. |
| `funko-listing-builder.html` | Funko Pop builder. **Hybrid** autocomplete — instant offline catalog + live eBay Browse search (post-2021 coverage; parses name/franchise/Pop#/image from listing titles) — + manual number/exclusive/flags; eBay Browse price comps. Funko condition/postage model + item-specifics block. |
| `data/funko_pop.json` | Vendored, filtered Funko catalog (~11k Pop vinyls). Built by `scripts/build-funko-data.mjs` from the MIT `kennymkchan/funko-pop-data` dump. Frozen at 2021. Fetched same-origin (no proxy). |
| `scripts/build-funko-data.mjs` | Rebuilds `data/funko_pop.json` from upstream (filter to Pop! vinyl, derive franchise/exclusive/chase). |
| `data/riftbound.json` | Baked Riftbound catalog (~943 cards, all 4 sets), built by `scripts/build-riftbound-data.mjs` from the **official LoL card gallery** (keyless). Keyed by lowercase set code; per-card `{k,num,name,rarity,type,domain,e,p,m,img}`. Fetched same-origin. Default Riftbound source. |
| `scripts/build-riftbound-data.mjs` | Rebuilds `data/riftbound.json`: scrapes the gallery Next.js `buildId`, fetches `card-gallery.json`, slims + groups by set. Re-run when a new set drops. |
| `extras.js` | Shared `TCG.*` module. **Images** (`renderExtras`): each image is `{label, display:[fast/small urls — raced, quickest shown], download:bestQualityUrl, fallback}`; the download button is ALWAYS best quality (back-compat `{url,fallback}` still works). **`TCG.activity(label)`** → `{update,done,fail}` renders a bottom-left toast stack with a live elapsed timer so every network op is visible. **`TCG.ebayComps({query,container,status,filter?})`** — shared eBay AU delivered-comps engine (sold-first via Marketplace Insights → asking fallback; delivered totals = item + shipping; AU vs Worldwide; undercut; auto-drives an activity toast). Plus prices/graph panel, FX, title-fitting, `condCode`/`langCode`, `legoCondToken`/`funkoCondToken`, `renderItemSpecifics`. Loaded via `<script src="/extras.js">`. |
| `vite.config.js` | Dev-server config: `/api/*` proxies + `/api/img` streaming, BrickLink OAuth1-signing, and eBay OAuth2 token-minting middlewares + LAN host settings. |
| `.env.example` | Placeholder env vars. Copy to `.env`. |
| `package.json` | Vite ^6; scripts `dev` / `build` / `preview`. (Use `dev`; see Golden Rule 1.) |
| `tcg-tools.service` | Sample systemd unit for always-on LAN hosting (Linux). |
| `scripts/run-dev.mjs` | Launcher for Vite dev server (Windows service / manual). |
| `scripts/start-tcg-tools.cmd` | Double-click / Task Scheduler entry point for Windows. |
| `scripts/WINDOWS_SERVICE.md` | pnpm setup + NSSM / firewall instructions for Windows LAN hosting + the daily Claude analysis task. |
| `tracker.html` | Price-tracker dashboard: opportunities / downtrends / momentum / review-queue / all-tracked, with sparklines (reuses `TCG.lineGraph`). Linked from `index.html`. |
| `lib/db.mjs` | `node:sqlite` store — opens `data/tracker.db`, PRAGMAs + idempotent DDL (`watchlist` / `price_snapshots` / `signals` / `card_cache`, plus the inventory tables `inventory_items` / `inventory_valuations` / `grading_submissions` / `sku_counter`, §13) + an additive `image_url` migration. All DB access funnels here. |
| `lib/normalize.mjs` | Server-side mirror of each builder's price extraction + FX math + per-game lookup paths (see Golden Rule 9). |
| `lib/pricecharting.mjs` | Keyless PriceCharting scraper (Pokémon graded/raw/pop). Parses the public card + population pages server-side; matches by exact collector number + name + fuzzy set. Powers `/api/pc` (display-only; not wired into the tracker/collector). |
| `shipping-label.html` | Shipping Label Maker. Pastes an eBay address → cleaned, auto-fit address label as a jsPDF (50×30 / 100×50 mm); batch → multi-page PDF. Can also **print direct** to the AUSPRINT PRO: rasterises the label to a 1-bpp bitmap (reusing the jsPDF layout) and POSTs to `/api/print` (Print button + Auto-print toggle). Download path is unchanged. |
| `lib/labelprint.mjs` | Builds TSPL (or ZPL) from a 1-bpp label bitmap and streams it to the thermal printer's raw 9100 socket — the server side of `/api/print`. Pure `node:net`, no deps. Client sends `1`=ink; TSPL wants `0`=black, so it inverts (overridable via `LABEL_PRINTER_INVERT`). |
| `scripts/labeltest.mjs` | Standalone raw-9100 test/calibration harness for the AUSPRINT PRO: `--lang tspl\|zpl\|bitmap\|self` sends a minimal label so you can confirm the dialect and tune size/position/darkness. |
| `lib/collector.mjs` | In-process scheduler + `runPass` (self-fetches the proxies) + `computeSignals` (thresholds). |
| `lib/tracker.mjs` | Vite plugin: owns the DB, exposes `/api/tracker/*`, starts the collector. Registered in `vite.config.js` `plugins`. |
| `inventory.html` | **Graded-card inventory dashboard** ("Binders Keepers"). Stock list (filters + value sparklines), P/L summary tiles, add/edit modal (with PSA cert auto-fill), and the grading-submission pipeline (create → promote to stock). Reuses `TCG.lineGraph`/`ebayComps`/`toAUD`. Linked from `index.html`. See §13. |
| `lib/inventory.mjs` | Vite plugin: owns the inventory tables (in the same `data/tracker.db`), exposes `/api/inventory/*` (items CRUD, valuation refresh, submissions + promote, `/summary`). Mirrors `lib/tracker.mjs`. Registered in `vite.config.js` `plugins`. |
| `lib/certlookup.mjs` | Multi-company cert-lookup registry powering `/api/cert`. Dispatches to a per-company provider (PSA only today) else returns `{matched:false, verifyUrl}` (official cert page) for manual entry. Reads `data/grading-companies.json`. The single extension point for adding new company lookups. |
| `lib/psa.mjs` | PSA public cert-verification provider (`lookupCert`) used by `lib/certlookup.mjs`. Needs `PSA_API_TOKEN`; `{matched:false}` on missing token/any failure. Field mapping UNVERIFIED against a live token. |
| `data/grading-companies.json` | Inventory-facing grading-company registry (12: PSA/BGS/CGC/SGC/TAG majors, plus ARK, TCG Grading, Card Grading Australia, PCG (Western Premier Card Grading), PCGCN (unrelated Chinese PCG, pcgcard.cn), EMC (Encapsulated Memories Company), JBH (Joyful Box House)): label, scale, cert format, official `certUrl` (nullable when no public page), `lookup` flag, region. Add a company here by appending a row — dropdowns are data-driven. **Broader** than the pre-grader's tolerance set in `grading.config.json` (which stays PSA/BGS/CGC/SGC/TAG — don't add companies there without real tolerances, Golden Rule 4). Shared by server (`certlookup.mjs`) + client (`inventory.html`). |
| `data/tracker.db` | SQLite price history (gitignored, WAL). Created on first server boot. |
| `data/tracker.config.json` | Tracker cadence + signal thresholds (editable). |
| `.claude/skills/price-analyst/SKILL.md` | Skill for the daily headless analysis (read export → research → flag → auto-add → digest → notify). |
| `scripts/notify.ps1` | Windows desktop toast (WinRT, `msg.exe` fallback) for signal alerts. |
| `scripts/run-claude-analysis.cmd` | Task Scheduler entry point for the daily `claude --print` analysis. |
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
| `/api/lorcana` | `api.lorcast.com/v0` | Keyless Disney Lorcana API. One call returns image + gameplay + `prices.{usd,usd_foil}` (USD, daily). No key. |
| `/api/rb`  | `api.scrydex.com/riftbound/v1` | Injects `X-Api-Key` + `X-Team-ID` from `.env`. **Optional** — only for live Riftbound pricing + trend; coverage comes from baked data / riftscribe. |
| `/api/rbs` | `riftscribe.gg/api` | Keyless community Riftbound card API (live alternative to Scrydex). No key. |
| `/api/fx`  | `api.frankfurter.app` | FX rates for AUD conversion. No key. |
| `/api/img` | (middleware) | Streams any remote image same-origin so the browser can blob-download it. |
| `/api/lego/rebrickable` | `rebrickable.com/api/v3/lego` | Injects `Authorization: key <REBRICKABLE_API_KEY>`. LEGO set/minifig lookup. |
| `/api/lego/brickset` | `brickset.com/api/v3.asmx` | Appends `apiKey` (a **query param**) in `rewrite()`; client sends `userHash=`. RRP/age/dims. |
| `/api/lego/bricklink` | (middleware) | **OAuth1 HMAC-SHA1 signing** per request (4 BrickLink creds). New/used price guide. Needs the server IP registered in the BrickLink console. |
| `/api/ebay` | (middleware) | Mints+caches an **OAuth2 client-credentials** app token; injects `Bearer` + `X-EBAY-C-MARKETPLACE-ID`. Funko Browse pricing + live name search + Taxonomy item-specifics. **Production keys only** (`SBX-` sandbox keys fail the token mint with `invalid_client`; the middleware surfaces the real error instead of a blind 502). |
| `/api/pc` | (middleware) | **Keyless** PriceCharting scrape (Pokémon graded/raw/pop) via `lib/pricecharting.mjs`. `GET /api/pc/lookup?name=&number=&set=&id=`. Display-only; always returns `{matched:false}` on failure (Golden Rule 7). Optional `PRICECHARTING_TOKEN` switches it to the official API. |
| `/api/grade` | (middleware) | **POST-only** AI vision condition pass for `card-grader.html` (`lib/grader.mjs`, Anthropic/OpenAI). Returns `ok:false` (never 500) so the tool degrades to centering-only. |
| `/api/cert` | (middleware) | **Multi-company** graded-slab cert lookup (`lib/certlookup.mjs`) for the inventory add form. `GET /api/cert?company=PSA&cert=…` → `{matched, identity, grade, company, verifyUrl, …}`; `GET /api/cert/providers` → the company registry. PSA auto-fills (`PSA_API_TOKEN`); every other company has no public API ⇒ `{matched:false, verifyUrl}` (official page, or null) + manual entry (Golden Rule 7). |
| `/api/inventory` | (plugin) | Graded-card **inventory** API (`lib/inventory.mjs`): `GET/POST /items`, `GET/PATCH/DELETE /items/:id`, `POST /items/:id/refresh-value` (PriceCharting graded value), `POST /items/:id/value-manual`, `POST /items/:id/fetch-image` (resolve+cache card image), `GET /items/:id/valuations`, `GET/POST /submissions`, `PATCH/DELETE /submissions/:id`, `POST /submissions/:id/promote`, `GET /summary`, `GET /export`. See §13. |
| `/api/print` | (middleware) | **POST-only**: streams a browser-rasterised label bitmap to the **AUSPRINT PRO** (Rongta/TSPL) over raw TCP **9100** (`lib/labelprint.mjs`). `GET` returns `{enabled,dpi,ip,page}` so `shipping-label.html` knows whether to enable its Print button + at what DPI to rasterise. Config = `.env` `LABEL_PRINTER_*`; unset ⇒ disabled, tool stays download-only (Golden Rule 7). No new deps (pure `node:net`). |

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

No automated tests. After editing a builder's JS, syntax-check the inline script:

```bash
python3 -c "import re;s=open('pokemon-listing-builder.html').read();\
m=re.search(r'<script>(?!<)(.*)</script>',s,re.S);open('/tmp/c.js','w').write(m.group(1))"
node --check /tmp/c.js && echo OK
```

`node --check extras.js` and `node --check vite.config.js` validate those
directly. For pure-logic changes (fee math, title fitting, set resolution),
extract the function into a tiny Node harness with mocked DOM globals and assert
expected outputs — that's how the title generator and pricing calculator were
verified.

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
```
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

- **Production hosting** needs a backend (proxies are dev-only — Golden Rule 1).
- **Riftbound price graph** is reconstructed from Scrydex *trend deltas*, not a
  true daily series. Scrydex exposes a price-history endpoint that could be wired
  to `/api/rb` for real history.
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
The five card games supported are Pokémon, Magic: The Gathering, Star Wars:
Unlimited, Riftbound, and Disney Lorcana. The tool also lists **LEGO sets** and **Funko Pop!
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
Pokémon `sv4-25`, SWU `sor/010`. Riftbound prices need valid Scrydex creds — a 401/403
sets `last_error='scrydex_unauthorized'` and the card tracks without a price.

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
