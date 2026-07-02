# Bulk Listing Tool — Execution Plan

Companion to [BULK_LISTING_DESIGN.md](BULK_LISTING_DESIGN.md). This is the *build order*: PR-sized tasks, their dependencies, the gate that proves each one done, and which open decisions block which task.

> **Status (updated 2026-07-02): Phase 0 + Phase 1 LANDED**, including the Collectr import workflow (P1-9…P1-14 from the unified plan). Both workflows verified live: Base Set enumerate → price (30 market / 34 tier) → save → idempotent re-save (0 dup) → CSV export; the real Collectr graded export → 31+/33 resolved, all 3 slabs PriceCharting-priced, `needs_price` hard-block wired. Live taxonomy spike done (category **183454**, required aspect **Game**, variation support limited → per-card primary). Remaining: the owner's 3-row **sample upload gate** on the real eBay account (P1-7 hard gate — do this before any real batch), owner review of the slab wording, Phase 2 (`sell.inventory` approval + Sell API sink), Phase 3 (MTG/SWU/Riftbound enumerators, seller-net fees, sold-reconciliation).

## How to read this

- **Task IDs** `P0-1`, `P1-3`, … group by phase. Each is meant to be one small, independently-reviewable change.
- **Gate** = the concrete check that closes the task (`node --check`, a `scripts/check-*.mjs` harness per AGENTS.md §8, or a named manual step). No task is "done" until its gate passes.
- **Dep** = tasks that must land first. **Decisions** = open decisions from the design doc §16 that must be resolved for this task.
- **Size** = rough effort: S (≤half-day), M (~1–2 days), L (multi-day).

## The one scheduling insight

**Start the eBay category/aspect spike (`P1-5`) on day one, in parallel with Phase 0.** It's consumed late (the CSV export step) but it's the only task with an *external, owner-in-the-loop* dependency and a real chance of surprise (no card category exists in-repo; production eBay keys must be present; a wrong ID rejects 300 listings). Everything else on the critical path is internal code you control. Treat `P1-5` as a long-pole to de-risk early, not a late step.

## Critical path

```
P0-1 gitignore ─┐
P0-2 schema ─────────────────► P1-4 /batches persistence ─┐
P0-4 listing-copy ─┬─► P1-1 enumerate ─► P1-2 bulk plugin ─┼─► P1-8 UI ─► M4 Phase 1 exit
                   └─► P1-6 ebay-map ─► P1-7 csv+upload gate ┘
P0-3 fees ─────────► P1-3 pricing ───────────────────────────┘

P1-5 eBay spike (START EARLY, runs parallel to all of Phase 0/1) ─► feeds P1-6
```

---

## Phase 0 — Foundations (no eBay decisions needed; do first)

| ID | Task | Files | Gate | Dep | Decisions | Size |
|---|---|---|---|---|---|---|
| **P0-1** | **Harden `.gitignore`** (BLOCKER, first commit) | `.gitignore` | `git status` shows `data/ebay-oauth.json`, `data/ebay-*.json`, `data/exports/` are untrackable; add `EBAY_REFRESH_TOKEN` placeholder to `.env.example` | — | — | S |
| **P0-2** | **Schema additions**: `bulk_batches` + `channel_exports` tables, `addColumnIfMissing()` guard + `inventory_items` columns (`batch_id`,`rarity`,`ebay_offer_id`,`title_override`,`desc_override`), `idx_inv_batch`, partial-unique `uq_inv_bulk_identity` | `lib/db.mjs` | A throwaway node script boots `openDb()` on a **copy of the real `data/tracker.db`**, prints `PRAGMA table_info(inventory_items)` showing new columns, and confirms existing rows intact (no data loss); re-running is a no-op | — | — | M |
| **P0-3** | **Extract `lib/fees.mjs`**: lift `feeAU`/`totalFromList`/`listForTarget`/`pcSolve` verbatim from `index.html:186-189` with named-constant bands; re-point `index.html` via `TCG.fee` | `lib/fees.mjs`, `index.html`, `extras.js` | `node --check`; `scripts/check-pricing.mjs` (stub) round-trips `feeAU`/`listForTarget` for a handful of targets and matches the **pre-refactor** outputs exactly | — | — | S |
| **P0-4** | **Extract `lib/listing-copy.mjs`**: move `fitTitle`/`condCode`/`langCode` bodies out of `extras.js:682-719` (leave delegation shims); add `titleParts`/`buildTitle`/`buildDescription`/`variationTitle`/`variationAttrs` + the verbatim GR6 constants + the single `printing_key→variant` map | `lib/listing-copy.mjs`, `extras.js` | `node --check extras.js`; module imports cleanly in Node | — | — | M |
| **P0-5** | **Refactor the two builders** so `genTitle`/`buildHTML` delegate to `listing-copy.mjs` | `pokemon-listing-builder.html`, `lorcana-listing-builder.html` | `scripts/check-listing-copy.mjs` **parity harness**: single-card `genTitle`/`buildHTML` output byte-identical before/after for Pokémon + Lorcana sample cards; `node --check` on both extracted `<script>`s; manual smoke (render one card each — title unchanged) | P0-4 | — | M |
| **P0-6** | **Freeze the contract**: document the canonical `BulkRow` shape + the `application/x-ndjson` enumerate transport in `AGENTS.md` (+ the new `lib/fees.mjs` / `lib/listing-copy.mjs` single-source mirrors under the GR6/GR9 notes) | `AGENTS.md` | Doc committed; field names reconciled (`market_usd`/`market_aud`) — this is what P1-1/P1-3/P1-4/P1-8 build against | — | — | S |

**Milestone M0 — Foundations frozen:** all harnesses green, schema applies clean on a real DB copy, no secret path trackable, the `BulkRow`/NDJSON contract is documented. Nothing in Phase 1 starts until M0.

---

## Phase 1 — CSV MVP (shippable, no user-OAuth)

### Backend

| ID | Task | Files | Gate | Dep | Decisions | Size |
|---|---|---|---|---|---|---|
| **P1-1** | **`lib/enumerate.mjs`**: `ENUMERATORS[game]` for Pokémon (`tcgplayer.prices` keys) + Lorcana (`usd`/`usd_foil`); paginating driver self-fetching `/api/pkm`,`/api/lorcana` with `jfetch` 429 backoff; emits `BulkRow[]` | `lib/enumerate.mjs`, `scripts/check-enumerate.mjs` | Harness: a card enumerated twice → byte-identical `(identity_key,variant)` tuples; a mocked 429/empty page → partial rows + `warnings[]` (GR7). Live smoke: enumerate one small real set of each game | P0-4, P0-6 | **D1** (pkm search endpoint), **D2** (Lorcast set path), D11 (JP scope) | L |
| **P1-2** | **`lib/bulk.mjs`** (`bulkPlugin`): mount `/api/bulk/sets` + `/api/bulk/enumerate` (NDJSON) + `card_cache` 24h-TTL read (`?fresh=1` bypass); register in `vite.config.js` plugins | `lib/bulk.mjs`, `vite.config.js` | Server boots with the plugin; `curl` the NDJSON stream for a set and see one `BulkRow`/line + trailing `warnings`; a second call within 24h serves from `card_cache` | P1-1 | — | M |
| **P1-3** | **`lib/pricing.mjs`** + `data/bulk-pricing.config.json` + `POST /api/bulk/price`: precedence override>market(≥threshold)>tier floor; `Math.round(x*100)` once; `value_source` tags; FX fetched once server-side | `lib/pricing.mjs`, `data/bulk-pricing.config.json`, `lib/bulk.mjs` | `scripts/check-pricing.mjs`: precedence + threshold boundary + cents-rounded-once; `feeAU`/`listForTarget` round-trip from `lib/fees.mjs` | P0-3, P0-6 | **D8** (tier floors), **D9** (rounding) | M |
| **P1-4** | **`/batches` routes** in `lib/inventory.mjs`: `POST` create-with-items (txn, `nextBulkSku` `BK-RAW`, `ON CONFLICT(uq_inv_bulk_identity) DO UPDATE`, `link_watchlist`, per-row try/catch), `GET` list, `GET :id`, `PATCH :id`, `POST :id/mark`; `recountBatch()` | `lib/inventory.mjs` | Curl/harness: create a batch from sample `BulkRow`s → rows appear as raw `inventory_items`; **re-running the same set updates qty/price, does not duplicate** (idempotency); `GET /api/inventory/summary` (unchanged) aggregates the bulk items | P0-2 | — | M |

### Channel / CSV (external-dependent — start P1-5 early)

| ID | Task | Files | Gate | Dep | Decisions | Size |
|---|---|---|---|---|---|---|
| **P1-5** | **eBay Taxonomy spike** (START DAY 1, parallel): resolve live EBAY_AU category IDs + required aspects + raw-single condition ID for Pokémon/Lorcana via the existing `/api/ebay` proxy; pin into `data/ebay-categories.json` | `data/ebay-categories.json`, `docs/DATA_SOURCES.md` | Owner **confirms** the pinned category IDs + required aspect names; needs the dev server running with **production** eBay keys in `.env` | — (needs `/api/ebay`) | **D3**, **D4**, **D5** | M |
| **P1-6** | **`lib/channels/ebay-map.mjs`**: `toEbayListing(row,batch,fx)` → canonical listing (imports `buildTitle`/`buildDescription`, no mirror); Taxonomy resolution; `groupVariations()` enforcing the **250-cap on variations (card×finish), auto-split Part 1/2**; `validate()` **hard-fails** on missing required aspect | `lib/channels/ebay-map.mjs` | Harness: a sample batch maps; a 150-card base+RH set (300 variations) auto-splits; a row missing a required aspect hard-fails; a missing image warns | P0-4, P1-5 | D10 (images) | M |
| **P1-7** | **`lib/channels/ebay-csv.mjs`** + `POST /api/bulk/export/csv` + `GET /api/bulk/export/preview`: File Exchange AU fixed-price writer (BOM, `CustomLabel=sku` idempotency), per-card **and** multi-variation shapes; records a `channel_exports` row | `lib/channels/ebay-csv.mjs`, `lib/bulk.mjs` | Generate both CSV shapes for a real batch; **HARD GATE — a hand-built 3-card sample (per-card + multi-variation) uploads successfully on the owner's live eBay AU account** | P1-6 | **D6** (File Exchange flavour) | M |

### UI

| ID | Task | Files | Gate | Dep | Decisions | Size |
|---|---|---|---|---|---|---|
| **P1-8** | **`bulk-listing-builder.html`**: game+set picker (`TCG.setCombobox`), NDJSON-stream grid (virtualized, `TCG.activity` progress), row=card×printing, bulk actions, shape toggle, `mkt`/`tier` tags, batch pre-flight readiness gate, value/fees footer, Save/Export/Push(disabled), Batches view; `index.html` tile | `bulk-listing-builder.html`, `index.html` | Manual E2E: enumerate a 200–400 card set → edit prices/qty → Save → Export CSV → re-open the batch and re-export; a source outage shows warnings + "Add row manually", never a crash | P1-2, P1-3, P1-4, P1-7 | D10 | L |

**Milestone M1 (internal):** enumerate + price + see the grid (P1-1/2/3 + a thin P1-8) — demoable with zero eBay dependency.
**Milestone M2:** persist + manage batches (P1-4).
**Milestone M3 (the shippable moment):** export a CSV that actually lists on eBay (P1-5/6/7).
**Milestone M4 — Phase 1 exit (matches design §15):** a 200–400 card set enumerates→prices→persists as one batch of raw in-stock items; re-running updates not duplicates; both CSV shapes import on the live account; source outage → warnings; summary shows the items.

---

## Phase 2 — Sell Inventory API channel (gated on eBay approval)

Do **not** start until **D7** is answered (is the app approved for a production `sell.inventory` keyset?). This is a multi-week external review — the repo's `buy.marketplace.insights` scope is still denied, so treat approval as a real gate.

| ID | Task | Gate | Size |
|---|---|---|---|
| **P2-1** | `ebaySellProxy(env)` authorization-code OAuth middleware + `/api/bulk/auth/{login,callback,status}`; refresh token stored server-side (`data/ebay-oauth.json` gitignored / `EBAY_REFRESH_TOKEN`); access token cached in-memory; **refresh-token-expiry detection → soft `401 {ebay_consent_required, auth_url}`** | OAuth round-trip completes; token persists server-side, never reaches the browser; a forced-expired refresh surfaces Reconnect | L |
| **P2-2** | `lib/channels/ebay-inventory-api.mjs`: canonical → `bulkCreateOrReplaceInventoryItem`/`bulkCreateOffer`/`bulkPublishOffer` (+`inventoryItemGroup` for variations); per-SKU partial-failure `jobResults`; write back `ebay_listing_id`/`ebay_offer_id`/`channel_status`/`status`; `channel_exports` row | A batch publishes as live EBAY_AU listings (both shapes) with IDs written back and `status→listed`; a partial failure leaves failed SKUs re-runnable | L |
| **P2-3** | UI: Reconnect-eBay state + enable the Push button; eBay EPS (`uploadSiteHostedPictures`) owner-photo path | Push works end-to-end from the grid; a revoked token surfaces Reconnect and never breaks the CSV path | M |

**Milestone M5:** API channel live; CSV remains the always-available fallback.

---

## Phase 3 — Polish & other games

| ID | Task | Size |
|---|---|---|
| **P3-1** | `ENUMERATORS` entries for MTG (Scryfall), SWU (swu-db), Riftbound (baked/riftscribe) — one table entry each | M |
| **P3-2** | Seller-net fee modeling (insertion fees + store zero-insertion allocation + GST-on-fees + GTC auto-renew) so the footer reflects true cost | M |
| **P3-3** | sold→SKU/variation reconciliation (Phase 2 webhook/notification) to auto-flip `inventory_items` status to `sold` | M |
| **P3-4** | Job/queue + cancellation for very large enumerations; keyless pokemontcg.io rate-budget coordination with the tracker collector | M |

---

## Decision checkpoints (design doc §16 → blocked tasks)

| Decision | Blocks | Needed by |
|---|---|---|
| **D1** pkm `/cards?q=set.id:` fields/pageSize | P1-1 | Start of Phase 1 (degrades gracefully if wrong) |
| **D2** Lorcast set-enumeration path | P1-1 | Start of Phase 1 |
| **D3** EBAY_AU card category IDs | P1-5 → P1-6, P1-7 | **Day 1 spike** |
| **D4** listing condition ID for raw singles | P1-5 → P1-7 | **Day 1 spike** |
| **D5** Business vs Private account + Business Policies | P1-5 → P1-7 (CSV policy columns), P2-2 | Before P1-7 |
| **D6** File Exchange flavour (Seller Hub Reports vs classic) | P1-7 | Before P1-7 |
| **D7** production `sell.inventory` scope approval | all of Phase 2 | Before Phase 2 (multi-week lead time — **request now**) |
| **D8** tier floors/thresholds | P1-3 (tunes; conservative defaults ship regardless) | Before M1 |
| **D9** rounding rule (.49/.99) | P1-3 | Before M1 |
| **D10** owner scans vs stock CDN art | P1-6, P1-8 (Phase 1 answer), P2-3 (EPS) | Before P1-6 |
| **D11** Pokémon JP scope | P1-1 | Start of Phase 1 |
| **D12** seller-net fee modeling now vs Phase 3 | P3-2 | Deferred (labeled buyer-protection-only in Phase 1) |

**Phase 0 needs none of these** — it can start immediately.

## Suggested first three commits

1. **`P0-1`** `.gitignore` hardening (blocker; trivial; unblocks everything else touching `data/`).
2. **`P0-2`** schema (the contract the persistence layer builds on; verify on a DB copy).
3. **`P0-4`+`P0-5`** the `listing-copy.mjs` extraction + parity harness (the highest-regression-risk refactor — get it proven byte-identical early, since both the shipping builders and the whole bulk pipeline depend on it).

…and in parallel, kick off **`P1-5`** (the eBay spike) and **request `sell.inventory` production approval (`D7`)** so the external clocks start now.
