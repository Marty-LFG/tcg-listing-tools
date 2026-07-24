# Bulk eBay Listing Tool — Design & Phased Plan ("Binders Keepers: Bulk")

**Repo:** `C:\_dev\tcg-listing-tools` · **Market:** eBay AU · **Money:** integer cents throughout
**Status:** **Phase 0 + Phase 1 BUILT (2026-07-02)** — both workflows (set enumeration + Collectr CSV import) work end-to-end through pricing → inventory persistence → eBay File Exchange CSV, verified live against the running dev server + the real Collectr exports (`data/samples/`). Harness suite: `scripts/check-{listing-copy,pricing,collectr,collectr-graded,collectr-ebay,enumerate}.mjs` — all green. Phase 2 (Sell Inventory API) remains gated on `sell.inventory` production approval.

**Live findings that amended this design during the build (2026-07-02):**
- **eBay AU taxonomy resolved live** (tree 15 v125): ALL card games land in category **183454 "CCG Individual Cards"**; the ONLY required aspect is **Game**; `Card Condition` values are a 4-value enum; the Professional Grader enum covers PSA/BGS/CGC/SGC/TAG/ARK/CGA/…. Pinned in `data/ebay-categories.json` (gitignored live cache) + baked as defaults in `lib/channels/ebay-map.mjs`.
- **Multi-variation constraint confirmed:** only `Card Condition`/`Customised` are variation-enabled in 183454 — card-per-variation listings are NOT aspect-supported on EBAY_AU. **Per-card is the primary shape**; the variation CSV (custom `Card` specific) ships EXPERIMENTAL behind the sample-upload gate.
- **Mirror-with-parity-harness instead of runtime delegation:** the builders' classic `<script>`s can't import ESM, so `lib/listing-copy.mjs` + `lib/fees.mjs` are **verbatim ports** (the repo's existing GR9 convention) enforced by `scripts/check-listing-copy.mjs` byte-identical parity — not live delegation from `extras.js`. `index.html`'s calculator DOES import `lib/fees.mjs` directly (it became a `<script type="module">`). MIRROR comments mark all browser-side copies.
- **Wrong-set guard:** the fuzzy set-matcher verifies the fetched card's NAME overlaps the row's name before accepting an identity (a bad fuzzy match otherwise attaches the wrong price/image); set-name-in-query matches prefer the LONGEST contained name ("Sun & Moon Base Set" → "Sun & Moon", not "Base") and a trailing "… Base Set" alias is tried.
- **Slab wording (⚠ owner-review):** graded listings swap the card condition/postage lines for slab-appropriate wording (`SLAB_CONDITION_SUFFIX`/`SLAB_POSTAGE` in `lib/listing-copy.mjs`) — new copy, pending owner verification per GR6.

Original design (produced from a 6-dimension design pass + adversarial critique against the 9 Golden Rules and real eBay AU constraints) follows.

---

## 1. What we're building

A new **bulk listing pass** that turns a whole card *set* into eBay listings in one workflow:

1. Operator picks **game + set** → the server **enumerates** every card and expands it into one row per *(card × printing)* using each card's price-key set (Pokémon `tcgplayer.prices` keys `normal`/`reverseHolofoil`/`holofoil`; Lorcana `usd`/`usd_foil`).
2. Rows land in an **editable grid** with per-row include / price / quantity; a **hybrid pricing engine** fills prices — live market when it clears a threshold, else a conservative per-rarity/variant tier floor; a per-card override always wins.
3. The batch **persists to the existing Binders Keepers inventory DB** as raw `inventory_items` (quantity singles), tracked `in_stock → listed → sold`.
4. Export runs through **one channel-mapping layer** with two sinks: **Phase 1 CSV** (eBay Seller Hub Reports / File Exchange — works today, no user OAuth) and **Phase 2 Sell Inventory API**. Both support **one-listing-per-card** and **one multi-variation "pick your single" listing per set**.

This honours the four owner decisions — (A) both eBay channels, phased; (B) both listing shapes; (C) hybrid pricing; (D) persist to the inventory DB — and reuses the suite's machinery instead of inventing parallel systems.

### 1.1 How it fits the existing project

It's **Phase 2 of "Binders Keepers,"** not a new silo. `inventory_items` already models raw singles (`grading_company` NULL, `lib/db.mjs:129-130`), carries `quantity` (`:138`), and *reserves* `ebay_listing_id` / `shopify_product_id` / `channel_status` (`:171-173`) — the schema comment literally says it "will become the source of truth for eBay/Shopify." This tool lights those columns up.

Native to the suite's conventions: a standalone vanilla-JS page (`bulk-listing-builder.html`) cloning the `f_*`/`buildHTML`/`genTitle` shape of the single-card builders; new logic in Vite plugins that self-fetch the proxies exactly like `lib/collector.mjs:5-6`; the same `data/tracker.db` + `openDb()` handle (`lib/db.mjs:207`); eBay OAuth via a middleware mirroring `ebayProxy`/`ebayToken` (`vite.config.js:94-200`).

---

## 2. Single-owner decisions (resolving the design-seam conflicts)

The six dimensions independently invented overlapping machinery. Each concern gets **exactly one owner**:

| Concern | Single owner | Rejected duplicates |
|---|---|---|
| **Batch schema & persistence** (blocker) | `lib/db.mjs` DDL + `lib/inventory.mjs` — `bulk_batches` table + `inventory_items.batch_id INTEGER` FK + `channel_exports` audit table | ✗ batch id in a `notes` string; ✗ `batch_id` re-added by the channel layer; ✗ a second `channel_exports` |
| **Enumerate contract & transport** (blocker) | `lib/bulk.mjs` streams **NDJSON** (`application/x-ndjson`) with **one canonical `BulkRow` shape** | ✗ buffered `POST {rows,meta}`; ✗ divergent field names `market_usd` vs `marketUsd` |
| **Title + description generation** (major) | `lib/listing-copy.mjs` — one dual-target pure module; `extras.js` delegates, both builders + channel layer + UI **import** it | ✗ `fitTitle`/`buildDescription` mirror in `ebay-map.mjs`; ✗ `genTitle` cloned into the bulk page |
| **CSV serializer** (major) | `lib/channels/ebay-csv.mjs` (server-side); the UI **POSTs** to `/api/bulk/export/csv` | ✗ client-side `rowsToCsv()` Blob builder |
| **eBay fee math** (minor) | `lib/fees.mjs` — one ESM with named-constant bands; `index.html` and `lib/pricing.mjs` both import it | ✗ verbatim copy in `pricing.mjs`; ✗ separate `TCG.fee` copy in `extras.js` |

**Router ownership** (registered in `vite.config.js` plugins, after `inventoryPlugin(env)`):
- `bulkPlugin(env)` → **`/api/bulk/*`** — the single bulk surface: `sets`, `enumerate` (NDJSON), `price`, `export/csv`, `export/preview`, and (Phase 2) `channel/*` + `auth/*`.
- Batch/item CRUD stays on the **existing** `/api/inventory/*` (`lib/inventory.mjs`), extended with `/batches` routes. Pricing lives under `/api/bulk/price` (not a third `/api/inventory/bulk/price` router).

---

## 3. Architecture & data flow

```
 bulk-listing-builder.html  (browser, vanilla JS + extras.js + imports lib/listing-copy.mjs)
        │
        │ 1. GET  /api/bulk/sets?game=            → set picker (TCG.setCombobox)
        │ 2. POST /api/bulk/enumerate  (NDJSON stream, one BulkRow per line)
        │ 3. POST /api/bulk/price      (hybrid resolve; server holds FX + extraction)
        │ 4. POST /api/inventory/batches           (persist rows as inventory_items)
        │ 5. POST /api/bulk/export/csv             (download eBay CSV)  ── Phase 1
        │ 6. POST /api/bulk/channel/ebay/publish   (Sell Inventory API) ── Phase 2
        ▼
  ┌─────────────────────────── Vite dev server (single writer) ───────────────────────────┐
  │ bulkPlugin  → lib/bulk.mjs                                                              │
  │   ├─ lib/enumerate.mjs   self-fetch /api/pkm,/api/lorcana (jfetch 429 backoff)          │
  │   │                      → derive (card×printing) matrix → BulkRow[]  → upsert card_cache│
  │   ├─ lib/pricing.mjs     resolvePrice(): override > market(≥thr, →AUD) > tier floor      │
  │   │                      ← lib/normalize.mjs mapPrice()/toAUD  ← lib/fees.mjs           │
  │   ├─ lib/channels/ebay-map.mjs   BulkRow → canonical eBay listing (title/aspects/desc)  │
  │   │                      ← lib/listing-copy.mjs (buildTitle/buildDescription)           │
  │   │                      ← /api/ebay Taxonomy (category+aspect resolution, cached)      │
  │   ├─ lib/channels/ebay-csv.mjs   canonical → File Exchange CSV (single + variation)     │
  │   └─ lib/channels/ebay-inventory-api.mjs  canonical → inventoryItem/offer/group (P2)    │
  │ inventoryPlugin → lib/inventory.mjs  (+ /batches routes)  → openDb() → data/tracker.db  │
  │ ebaySellProxy(env)  authorization-code OAuth (Phase 2), refresh token server-side       │
  └─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Golden Rules 1/2:** all proxying + key/token injection stay in Vite plugins/middlewares that self-fetch `127.0.0.1:5273` (the collector's proven pattern). Server-side enumeration also avoids fanning hundreds of authenticated `pokemontcg.io` calls out of every LAN browser.

---

## 4. Data model (owner: `lib/db.mjs` + `lib/inventory.mjs`)

All additions are idempotent (`CREATE TABLE IF NOT EXISTS`, matching `lib/db.mjs:18-202`) plus **guarded `ALTER TABLE`** via a new `addColumnIfMissing()` (SQLite `ADD COLUMN` has no `IF NOT EXISTS` in `node:sqlite`; a `PRAGMA table_info` check makes it idempotent + metadata-only). Existing graded/manual rows (`batch_id IS NULL`) are untouched.

- **`bulk_batches`** — per-run header: game/set, `listing_shape` (Decision B), the **hybrid pricing config snapshot + FX rate** (Decision C, auditable per GR4), status, denormalised roll-up counts.
- **Additive columns on `inventory_items`:** `batch_id` FK (the *one* batch link), `rarity` (needed by tier lookup + titles), `ebay_offer_id` (Phase 2), `title_override` / `desc_override` (persist manual edits; un-edited copy is regenerated deterministically at export, never cached stale). The reserved `ebay_listing_id` / `channel_status` are reused as-is.
- **Idempotent re-enumeration:** a **partial unique index** `uq_inv_bulk_identity ON (game, identity_key, variant) WHERE batch_id IS NOT NULL` — mirrors `watchlist UNIQUE(game,identity_key,variant)` (`:32`) and *excludes* graded slabs (which may legitimately repeat a card). Persistence does `INSERT … ON CONFLICT DO UPDATE`, so a re-run updates qty/price instead of duplicating with fresh SKUs. **Must ship before the UI Save path is wired.**
- **`channel_exports`** — audit of every CSV generated / API push (mirrors the `inventory_valuations` history pattern).
- **SKU:** bulk raw singles get `BK-RAW-<GAME>-######` via `nextBulkSku()`, reusing the existing `sku_counter` table + atomic `ON CONFLICT` idiom (`lib/inventory.mjs:57-63`) so they never collide with graded `BK-PKM-` SKUs.
- **`value_source`** comment gains `'bulk_tier' | 'market' | 'override'` — free-text column, no migration.

### 4.1 DDL additions

```sql
-- Per-set bulk run header: listing shape (Decision B), hybrid pricing config
-- snapshot + FX rate (Decision C, auditable per Golden Rule 4), roll-up counts.
CREATE TABLE IF NOT EXISTS bulk_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,                          -- riftbound|mtg|pokemon|swu|lorcana
  set_code TEXT,
  set_name TEXT,
  listing_shape TEXT NOT NULL DEFAULT 'per_card',   -- 'per_card' | 'multi_variation'
  language TEXT NOT NULL DEFAULT 'EN',
  pricing_config TEXT,                         -- JSON snapshot of tiers/thresholds used this run
  fx_usd_aud REAL,                             -- FX rate captured at pricing time
  status TEXT NOT NULL DEFAULT 'draft',        -- 'draft'|'priced'|'saved'|'exported'|'archived'
  export_shape TEXT,
  exported_at TEXT,
  item_count   INTEGER NOT NULL DEFAULT 0,     -- distinct rows
  unit_count   INTEGER NOT NULL DEFAULT 0,     -- sum(quantity)
  listed_count INTEGER NOT NULL DEFAULT 0,
  sold_count   INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batch_game   ON bulk_batches(game);
CREATE INDEX IF NOT EXISTS idx_batch_status ON bulk_batches(status);

-- Audit log of every CSV generated / API push (mirrors inventory_valuations history).
CREATE TABLE IF NOT EXISTS channel_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,                        -- 'ebay-csv' | 'ebay-inventory-api'
  shape TEXT NOT NULL,                          -- 'per_card' | 'multi_variation'
  marketplace TEXT NOT NULL DEFAULT 'EBAY_AU',
  batch_id INTEGER REFERENCES bulk_batches(id) ON DELETE SET NULL,
  item_ids TEXT NOT NULL,                       -- JSON array of inventory_items.id
  artifact_path TEXT,                           -- CSV file path (data/exports/…), or null for API
  result TEXT,                                  -- JSON jobResults for API pushes
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Additive columns on inventory_items (guarded ALTER via addColumnIfMissing() in openDb()):
--   batch_id       INTEGER REFERENCES bulk_batches(id) ON DELETE SET NULL
--   rarity         TEXT
--   ebay_offer_id  TEXT          -- Phase 2 offer id (revise/end)
--   title_override TEXT          -- persisted manual title edit
--   desc_override  TEXT          -- persisted manual desc edit
CREATE INDEX IF NOT EXISTS idx_inv_batch ON inventory_items(batch_id);

-- Idempotent re-enumeration: one row per (card × printing) for BULK items only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_bulk_identity
  ON inventory_items(game, identity_key, variant) WHERE batch_id IS NOT NULL;
```

---

## 5. Canonical `BulkRow` (one contract; grid, pricing, persistence, channel map all key off it)

```js
// one row per (card × printing)
{
  game, identity_key,          // 'sv4-25' | '1/207' — matches watchlist/inventory identity scheme
  name, set_id, set_name,
  number,                      // '039a/298' — the 'a' suffix / printing key kept VERBATIM (GR5)
  rarity,
  variant,                     // canonical finish token: 'Base'|'Reverse Holo'|'Holo'|'Foil'|'Enchanted'
  printing_key,                // source key: 'normal'|'reverseHolofoil'|'holofoil' | 'usd'|'usd_foil'
  language,                    // 'EN' default; per-row override
  image,                       // public CDN url (best-quality), for grid thumb + eBay PicURL
  market_usd,                  // float or null (NO cents yet — see GR3 boundary)
  market_source,               // 'pokemontcg' | 'lorcast'
  market_aud,                  // float or null (server converts via /api/fx once per enumerate)
  raw_price                    // the source price bucket, for audit
}
```

**GR3 boundary:** `market_usd`/`market_aud` stay **floats** through enumerate → pricing. `Math.round(x*100)` to integer cents happens **exactly once**, inside `lib/pricing.mjs`. CSV/API serializers format `(cents/100).toFixed(2)` **only at the output edge**.

**GR5 variant vocabulary — single source:** the `printing_key → variant` map lives in one place in `lib/listing-copy.mjs`, imported by `enumerate.mjs` and the builders. A harness asserts a card enumerated twice yields byte-identical `(identity_key, variant)` tuples so the `UNIQUE` dedupe never silently splits/merges rows.

---

## 6. Set enumeration & variant matrix (`lib/enumerate.mjs`, driven by `lib/bulk.mjs`)

A pure module with a per-game **`ENUMERATORS[game]`** adapter table beside `normalize.mjs`'s `MAPPERS`/`lookupPath` — adding MTG/SWU/Riftbound later = one table entry.

- **Pokémon:** page `GET /api/pkm/cards?q=set.id:{id}&pageSize=250&page=N`; expand `Object.keys(tcgplayer.prices)` into rows via the builder's `_finMap`; number via `formatCardNumber()` (Golden Rule 10 — era/promo/subset aware, **not** a raw `num + '/' + printedTotal`).
- **Lorcana:** `GET /api/lorcana/sets/{id}` if it returns the card array with prices, else fall back to iterating `collector_number 1..set.total` against `/cards/{set}/{num}` (`lorcana:420`). Enchanted = foil-only → `variant='Enchanted'`.
- **Reuse:** `jfetch` 429→`sleep(1500)` retry + 400ms politeness gap (`lib/collector.mjs:11,101`); `card_cache` upsert (`collector.mjs:33-41`) to conserve the keyed pokemontcg budget.
- **`card_cache` freshness (GR4):** read cached rows only within a 24h TTL (matching collector cadence); older → re-fetch; `?fresh=1` forces live. Shared with the collector (single-writer → no lock race), documented as shared.
- **GR7:** read-only; streams **partial rows + a trailing `warnings[]`** on any failure — never a 500. Grid renders what arrived + offers "Add row manually."

---

## 7. Hybrid pricing engine (`lib/pricing.mjs` + `data/bulk-pricing.config.json`)

Pure resolver behind `/api/bulk/price`. **Strict precedence (Decision C):**

1. **per-card override** (a human number) → always wins.
2. **live market** — `market_aud` (via `normalize.mapPrice` + `normalize.toAUD`) **if `≥ threshold`** for that game/rarity/variant → `value_source='market'`.
3. **flat tier floor** — `TIERS[rarity][variant]` from config → `value_source='bulk_tier'`, retaining `market_cents` for audit.

**GR4 as machine-checkable data:** every resolved price carries `value_source ∈ {override, market, bulk_tier}`, persisted per row and shown in the grid (a `tier` vs `mkt` tag, market chip always visible). Tiers ship **conservative** (e.g. common/uncommon floor A$0.50, holo/foil A$2.00) so an un-edited batch under-prices rather than presenting a guess as authoritative. For multi-variation listings, per-variation `value_source` is written to each `inventory_items` row and surfaced in the pre-flight report.

**Fee math (owner: `lib/fees.mjs`):** `feeAU`/`totalFromList`/`listForTarget`/`pcSolve` lifted verbatim from `index.html:186-189` with named-constant bands; `index.html` and `pricing.mjs` both import it (kills the three-copies risk; honours AGENTS.md §7's forward/inverse-in-sync warning). **FX:** `/api/bulk/price` fetches FX once server-side; the server value is authoritative on write.

---

## 8. Titles & descriptions (owner: `lib/listing-copy.mjs`)

One **dual-target pure module** (no DOM, no `window`, no fetch) is the single source for titles + descriptions *and* for `fitTitle`/`condCode`/`langCode`. Structurally eliminates the GR9 mirror-drift and GR6 triple-copy risks.

- **Migration:** the bodies of `TCG.fitTitle`/`condCode`/`langCode` (currently `window.TCG` closures at `extras.js:682-719`) move into `listing-copy.mjs` as exports; `extras.js` re-points `TCG.*` to thin delegations. Gated by a **parity harness** asserting single-card `genTitle` output is byte-identical before/after.
- **Exports:** `titleParts`, `buildTitle`, `variationTitle`, `variationAttrs`, `buildDescription`, `buildVariationDescription`, plus the verbatim **GR6** constants.
- **Titles** feed per-game `parts` into `fitTitle` (no new 80-char logic). **GR5:** distinct finish token per printing + verbatim `a`-suffix, so `fitTitle` never collapses two printings.
- **Descriptions** reuse the exact `buildHTML` structure — inline styles only (**GR8**) — with the three **verbatim** owner-verified constants (condition/postage/footer). A `compact:true` variant trims for lean bulk CSV cells. Both builders refactor `genTitle`/`buildHTML` to delegate, proving parity.
- **Default condition** seeds `Ungraded, Near Mint` → `M/NM` so un-edited rows under-promise (INAD safety, GR6).

---

## 9. eBay channel adapters (one mapping layer, two sinks)

`lib/channels/ebay-map.mjs` is the **one** mapper: `toEbayListing(row, batch, fxRates) → canonical listing object`. It imports `buildTitle`/`buildDescription` from `listing-copy.mjs` (no own mirror) and `toAUD` from `normalize.mjs`. CSV and API differ **only** in the final serializer.

- **Category & aspects — a pre-build spike, not a lazy runtime cache:** resolve category IDs + required aspect names via `getCategorySuggestions` + `get_item_aspects_for_category` on the existing `/api/ebay` proxy for Pokémon + Lorcana on `EBAY_AU`, then **pin** into `data/ebay-categories.json` with owner confirmation. The repo only has LEGO/Funko placeholders flagged VERIFY-LIVE — **there is no card category yet.** `validate()` **hard-fails** (not warns) on a missing required aspect so a broken batch can never export.
- **Condition IDs:** the repo's `4000` (raw) / `2750` (graded) are Browse *filter* values (`pokemon:182-188`), not confirmed for listing creation — resolve live via the category's condition enum before first upload.
- **Images (GR1 trap):** use public game-CDN art URLs directly. **`/api/img` is forbidden in listings** (localhost middleware, unreachable by eBay's fetchers). Owner scans → eBay EPS in Phase 2; Phase 1 stock art only, with a `validate()` warning on missing image.

### 9.1 Phase 1 — CSV (`lib/channels/ebay-csv.mjs`)
eBay Seller Hub Reports / File Exchange, AU fixed-price, dependency-free writer + UTF-8 BOM (so `Pokémon`/`é` read correctly). `CustomLabel=<sku>` is the idempotency key (re-upload **revises**, not duplicates). Two shapes off `listing_shape`:
- **Per-card:** one `Add` row per SKU (`Format=FixedPrice`, `Duration=GTC`, `StartPrice`, `Quantity`, `ConditionID`, `Category`, `PicURL`, `C:<Aspect>` columns, `Description` HTML).
- **Multi-variation:** parent + `Relationship=Variation` child rows grouped by `variantKey`. **250-cap enforced on VARIATIONS (card×finish), not cards** — reverse-holo doubles the count, so a 150-card base+RH set = 300 variations → auto-split into `Part 1/2`. One-listing-per-card is the guaranteed fallback.

The File Exchange multi-variation idiom is finicky and account-specific → **validated against a hand-built 3-card sample upload on the owner's real account before wiring** (a gate).

### 9.2 Phase 2 — Sell Inventory API (`lib/channels/ebay-inventory-api.mjs`)
Drop-in second sink behind the same interface. New `ebaySellProxy(env)` middleware mirrors `ebayProxy`/`ebayToken` but **authorization-code**:
- `/api/bulk/auth/login` → 302 to eBay consent (`sell.inventory`); `/api/bulk/auth/callback` → stores the **refresh token server-side** (never the browser — **GR2**); access token cached in-memory like `ebayTok`.
- Maps canonical → `bulkCreateOrReplaceInventoryItem` (upsert-by-SKU) → `bulkCreateOffer` → `bulkPublishOffer`; `inventoryItemGroup` for variations. Writes back `ebay_listing_id`/`ebay_offer_id`/`channel_status='active'`/`status='listed'`.
- **Refresh-token lifecycle:** persist expiry; detect `refresh_token_expired` distinctly → soft `401 {error:'ebay_consent_required', auth_url}` → UI shows **"Reconnect eBay."** Phase 1 CSV keeps working regardless.

**Reality flag:** `sell.inventory` needs a **Production keyset approved for that scope** — a multi-week external eBay review (the repo's `buy.marketplace.insights` scope is **still denied**, `vite.config.js:133-153`). Phase 1 must be sufficient for months; Phase 2 is **not** a quick follow-on.

---

## 10. Bulk builder UI (`bulk-listing-builder.html`)

Standalone vanilla-JS page cloning the builder shape (same CSS vars, loads `/extras.js`, **imports `lib/listing-copy.mjs`** rather than cloning `genTitle`). A segmented control switches **Build** ↔ **Batches**.

- **Build:** `Game` select (Pokémon + Lorcana enabled in Phase 1, others disabled); set picker via `TCG.setCombobox`; **Enumerate** consumes the **NDJSON stream**, repainting incrementally with a `TCG.activity` progress toast ("142/305 priced…"). Row = *(card × printing)*, `key = identity_key + '|' + variant`.
- **Columns:** include ☑ · thumb · name · number · rarity · **finish** select (one row per printing, never collapsed — GR5) · market A$ chip (read-only) · price A$ (editable) · qty · title preview (live) · status dot.
- **Performance (200–400 rows):** server-side + streamed enumeration; virtualized grid (~40 visible rows windowed); debounced (~150ms) footer/title regen; memoized FX.
- **Shape toggle** (Decision B): changes only export grouping + which title generator runs — the grid + DB rows are identical (one `inventory_items` per variation), so switching is non-destructive.
- **Footer:** live N-listings / total value / **est. eBay fees** (via `lib/fees.mjs`). Footnote: these are **buyer-protection fees only, not seller net** — insertion fees / store allocation / GST-on-fees not modeled (AGENTS.md §10).
- **Batch pre-flight gate:** before Save/Export, a batch-level readiness report — "12 rows no market (→ tier), 3 over-title-length, 1 missing required aspect" — with required-aspect + over-length as **hard blocks** for export.
- **Save / Export / Push:** Save → `POST /api/inventory/batches`; Export CSV → `POST /api/bulk/export/csv`; Push → Phase 2, disabled with a tooltip until sell-scope OAuth exists.
- **Batches view** reuses `GET /api/inventory/batches` + the unchanged `GET /api/inventory/summary` (`lib/inventory.mjs:228` auto-aggregates all items, so bulk items appear with no code change); status `in_stock→listed→sold` via PATCH; "Open in grid" rehydrates for re-save/re-export.
- **`index.html` tile:** "Bulk Listing Builder" in the second `.col`.

---

## 11. Golden Rules compliance

| Rule | How honoured |
|---|---|
| **1** dev-only proxies | New fetching in Vite plugins self-fetching `127.0.0.1:5273`; `/api/img` explicitly forbidden in listings |
| **2** secrets server-side | eBay refresh token in `data/ebay-oauth.json` (**newly gitignored**) or `EBAY_REFRESH_TOKEN`; never reaches browser |
| **3** integer cents | Floats through enumerate/pricing; `Math.round(x*100)` **once** in `pricing.mjs`; CSV formats at the edge only |
| **4** live > guessed | `value_source ∈ {override,market,bulk_tier}` persisted + shown; conservative tier floors; market chip visible |
| **5** variant accuracy | one row per printing from price-keys; `a`-suffix + distinct finish token verbatim; mandatory Finish axis; partial unique index; single-source variant vocabulary |
| **6** owner wording | three constants verbatim in one module, imported everywhere; default `Ungraded, Near Mint` |
| **7** survive API down | enumerate streams partial rows + warnings (no 500); manual add-row; tier fallback; per-row save continues |
| **8** inline styles only | `buildDescription` emits only `style=`; regex guard harness |
| **9** normalize mirror | title/finish logic single-sourced in `listing-copy.mjs` (import-shared); enumerate price read calls the same `normalize.mapPrice` |

---

## 12. Validation (AGENTS.md §8 — no test runner)

No jest/vitest; validation is `node --check` + tiny standalone Node harnesses under `scripts/` that import the **pure ESM** modules and assert with plain `throw`/`console`:
- `scripts/check-listing-copy.mjs` — **parity harness**: single-card `genTitle` vs `buildTitle` byte-identical (gates the `extras.js` refactor); inline-style guard on `buildDescription`.
- `scripts/check-enumerate.mjs` — a card enumerated twice yields identical `(identity_key,variant)` tuples; a mocked 429/empty page degrades to partial rows + warnings.
- `scripts/check-pricing.mjs` — precedence (override>market>tier), threshold boundary, `feeAU`/`listForTarget` round-trip.
- `node --check` on `extras.js`, `vite.config.js`, and each extracted builder `<script>`.

---

## 13. API surface

| Route | Method | Purpose |
|---|---|---|
| `/api/bulk/sets?game=` | GET | Set list for `TCG.setCombobox` (reuses proven `/sets` calls) |
| `/api/bulk/enumerate` | POST | Read-only set enumeration; streams `application/x-ndjson` (one `BulkRow`/line + trailing `warnings[]`); no DB write (GR7) |
| `/api/bulk/price` | POST | Hybrid pricing; fetches FX once; returns `[{price_cents,value_source,market_cents}]` |
| `/api/bulk/export/preview?item_ids=&shape=` | GET | Dry-run: canonical objects + `validate()` results for the pre-flight gate; no side effects |
| `/api/bulk/export/csv` | POST | Phase 1 primary path; server serializer streams `text/csv`; records a `channel_exports` row |
| `/api/bulk/channel/ebay/publish` | POST | Phase 2; Sell Inventory API create/offer/publish; write-back; 501 until enabled |
| `/api/bulk/auth/login` \| `/callback` \| `/status` | GET | Phase 2; authorization-code consent + connection status |
| `/api/inventory/batches` | POST/GET | Persist a bulk run (upsert via `uq_inv_bulk_identity`, `nextBulkSku`, `link_watchlist`, per-row try/catch) / list |
| `/api/inventory/batches/:id` | GET/PATCH | One batch + items (rehydrate grid) / update header |
| `/api/inventory/batches/:id/mark` | POST | Bulk lifecycle transition (`in_stock→listed→sold`), then `recountBatch()` |
| `/api/inventory/summary` | GET | **Reused unchanged** — auto-aggregates all items, so bulk singles appear in P&L |

---

## 14. File manifest

**New**
- `lib/enumerate.mjs` — `ENUMERATORS[game]` adapter table + paginating driver; emits `BulkRow[]`
- `lib/bulk.mjs` — `bulkPlugin(env)` mounting `/api/bulk/*`; `card_cache` 24h-TTL read
- `lib/pricing.mjs` — hybrid resolver; `Math.round(x*100)` once; `value_source` tagging
- `data/bulk-pricing.config.json` — owner-editable tier floors + thresholds (conservative AU defaults)
- `lib/fees.mjs` — single home for the eBay AU fee bands
- `lib/listing-copy.mjs` — single source for titles/descriptions + `fitTitle`/`condCode`/`langCode` + GR6 constants + variant map
- `lib/channels/ebay-map.mjs` — the one mapping layer (Taxonomy resolution, 250-cap grouping, hard-fail validate)
- `lib/channels/ebay-csv.mjs` — Phase 1 CSV serializer (per-card + multi-variation)
- `lib/channels/ebay-inventory-api.mjs` — Phase 2 API sink
- `data/ebay-categories.json` — pinned EBAY_AU category IDs + required aspects (VERIFY LIVE)
- `data/ebay-oauth.json` — Phase 2, **gitignored** refresh-token store
- `bulk-listing-builder.html` — the bulk builder page
- `scripts/check-listing-copy.mjs`, `scripts/check-enumerate.mjs`, `scripts/check-pricing.mjs` — Node harnesses

**Changed**
- `.gitignore` — **do first:** add `data/ebay-oauth.json`, `data/ebay-*.json`, `data/exports/`
- `lib/db.mjs` — bulk DDL + `addColumnIfMissing()` + partial unique index
- `lib/inventory.mjs` — `nextBulkSku()`/`recountBatch()` + `/batches` routes + extended col whitelists
- `vite.config.js` — register `bulkPlugin(env)` (+ `ebaySellProxy(env)` in Phase 2)
- `extras.js` — delegate `fitTitle`/`condCode`/`langCode` + add `TCG.fee`
- `pokemon-listing-builder.html`, `lorcana-listing-builder.html` — `genTitle`/`buildHTML` delegate to `listing-copy.mjs`
- `index.html` — tile + re-point calculator's fee math to `lib/fees.mjs`
- `AGENTS.md`, `docs/DATA_SOURCES.md` — document the new mirrors, the enumerate NDJSON contract, pinned categories

---

## 15. Phased plan

### Phase 0 — Foundations (freeze before anything builds on them)
Eliminate the four blockers + cross-cutting conflicts by landing single-owner contracts first.
- `.gitignore` fix (secrets) — **first task.**
- `lib/db.mjs`: `bulk_batches` + `channel_exports` + `addColumnIfMissing()` + `inventory_items` columns + `idx_inv_batch` + `uq_inv_bulk_identity`.
- Freeze the canonical `BulkRow` shape + NDJSON transport (document in AGENTS.md).
- `lib/fees.mjs` (verbatim lift; `index.html` re-points).
- `lib/listing-copy.mjs` (move `fitTitle`/`condCode`/`langCode`; add title/desc + GR6 constants + variant map).
- `scripts/check-listing-copy.mjs` parity harness; refactor both builders to delegate and prove parity.

**Exit:** `node --check` passes; parity harness green; schema applies cleanly on an existing `data/tracker.db` with no data loss; `git status` shows no secret/artifact path is trackable.

### Phase 1 — CSV MVP (shippable, no user OAuth)
Enumerate a Pokémon/Lorcana set → editable grid → hybrid price → persist to inventory → export an eBay File Exchange CSV (both shapes). **Usable immediately and for months without Phase 2.**
- `lib/enumerate.mjs`, `lib/bulk.mjs` (`bulkPlugin`), `lib/pricing.mjs` + config, `/batches` routes.
- `lib/channels/ebay-map.mjs` + `lib/channels/ebay-csv.mjs`; `data/ebay-categories.json` from a **live Taxonomy spike** (owner-confirmed).
- `bulk-listing-builder.html` (virtualized grid, NDJSON stream, mkt|tier tags, shape toggle, pre-flight gate, footer, Save/Export/Push-disabled, Batches view); `index.html` tile.
- `check-enumerate.mjs` + `check-pricing.mjs`; **hand-built 3-card multi-variation CSV validated by a real upload on the owner's eBay account.**

**Exit:** a 200–400 card set enumerates, prices, and persists as one batch of raw in-stock items; re-enumerating updates (doesn't duplicate); per-card **and** multi-variation CSVs both import successfully on the owner's live eBay AU account; a source outage yields warnings + manual-add, never a crash; `GET /api/inventory/summary` shows the bulk items.

### Phase 2 — Sell Inventory API channel (gated on eBay approval)
Add the API as a drop-in second sink behind the same mapping layer, with write-back.
- `ebaySellProxy(env)` (authorization-code OAuth, refresh token server-side, expiry detection → soft 401 + Reconnect).
- `lib/channels/ebay-inventory-api.mjs` (`bulk*` endpoints, `inventoryItemGroup`, per-SKU partial-failure, write-back).
- `channel_exports` for API pushes; UI Reconnect + enable Push; eBay EPS owner-photo path.

**Exit:** with an approved production sell keyset, a batch publishes as live EBAY_AU listings (both shapes) with IDs written back and status→listed; a partial failure leaves failed SKUs re-runnable; a revoked/expired token surfaces Reconnect and never breaks the CSV path.

### Phase 3 — Polish & other games
- `ENUMERATORS` entries for MTG / SWU / Riftbound (one table entry each).
- Seller-net fee modeling (insertion + store allocation + GST-on-fees + GTC auto-renew).
- sold→SKU/variation reconciliation (Phase 2 webhook) to auto-flip status to sold.
- Job/queue + cancellation for very large enumerations; keyless pokemontcg.io rate-budget coordination with the collector.

---

## 16. Open decisions (need owner input before/along the build)

1. **pokemontcg.io search endpoint** — confirm `GET /cards?q=set.id:{id}` returns `page/pageSize/totalCount` like the documented list calls, max `pageSize=250`. (Driver degrades to partial rows + warning if it drifts.)
2. **Lorcast set enumeration** — does `GET /sets/{id}` return the full card array *with* prices, or must the adapter iterate `1..set.total`? Pick the cheaper live path.
3. **eBay AU card-singles CATEGORY ID(s)** for Pokémon + Lorcana, and exact required ASPECT names — resolve live + owner-confirm before first upload. No card category exists in-repo yet.
4. **Listing CONDITION ID** for raw singles — confirm the category's condition enum (repo's `4000`/`2750` are Browse filters, not confirmed for listing creation).
5. **Business vs Private account + Business Policies** — named shipping/payment/return policies, or inline shipping columns encoding the FREE-AU-postage model? Drives the CSV serializer + Phase 2 `offer.listingPolicies`.
6. **File Exchange flavour** — Seller Hub Reports vs classic File Exchange (column headers differ); validate the parent/child idiom with a real 3-card upload before wiring.
7. **Sell Inventory API approval** — is the app already approved for a Production `sell.inventory` keyset, or must that review be requested? (Insights scope is still denied — plan Phase 2 timing accordingly.)
8. **Tier floors/thresholds** — confirm the owner's real numbers (common floor A$0.50 or lower? holo/foil A$2.00?). Ships conservative so an un-edited batch under-prices (GR4).
9. **Rounding rule** — `.49` for market vs `.99` for tier floors, or one rule for visual consistency in a variation dropdown?
10. **Owner scans vs stock CDN art** — is public game-CDN art acceptable for bulk singles in Phase 1? (Owner photos need eBay EPS in Phase 2; `/api/img` can't be used.)
11. **Pokémon JP scope** — JP stays a manual per-row language override in Phase 1 (pokemontcg.io is EN-centric); confirm out of the enumerate matrix for now.
12. **Seller-net fees** — is seller-net modeling needed in Phase 1, or deferred to Phase 3? (The footer models only the buyer-protection fee.)

---

## 17. Top risks

1. **BLOCKER — secrets in un-gitignored files.** `.gitignore` currently lists only `.env`, `.env.local`, `node_modules`, `dist`, `data/tracker.db*`, `reports/`. → Phase 0 first task: add `data/ebay-oauth.json`, `data/ebay-*.json`, `data/exports/`; make `EBAY_REFRESH_TOKEN` in `.env` the primary secret path.
2. **Batch-persistence collision** (three incompatible models) → single owner (`lib/db.mjs` + `lib/inventory.mjs`); schema frozen in Phase 0.
3. **Idempotency** (`nextBulkSku` mints fresh SKUs) → `uq_inv_bulk_identity` + `ON CONFLICT DO UPDATE` lands in Phase 0; harness asserts a re-run updates.
4. **Unverified eBay category/aspect/condition** → hard pre-build spike, pinned + owner-confirmed; `validate()` hard-fails on missing required aspect.
5. **Enumerate transport** (two incompatible specs) → freeze NDJSON + one `BulkRow` shape in Phase 0.
6. **Title/description triplication + `extras.js` refactor risk** → single `listing-copy.mjs`; gate the refactor with the parity harness.
7. **Phase 2 external gate** (sell-scope approval + refresh-token lifecycle) → Phase 1 CSV fully self-sufficient; design expiry/Reconnect explicitly.
8. **250-variation cap + reverse-holo doubling** → cap on variations, auto-split, per-card fallback; validate multi-variation CSV with a real upload.
9. **`card_cache` staleness** feeding pricing → 24h TTL read + `?fresh=1`.
10. **Fees footer understates seller net** → label as buyer-protection-only; defer seller-net to Phase 3; keep `lib/fees.mjs` the single home.
