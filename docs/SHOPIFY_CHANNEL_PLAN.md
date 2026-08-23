# Shopify channel + cross-channel sync — design and execution plan

Status: **approved 2026-08-22.** Written against the eBay estate as it stands today.
Scope: **Pokémon raw singles only** on Shopify, plus sale-driven delisting between Shopify and eBay AU.
Graded slabs follow, then sealed.

Companion docs: `docs/SEALED_LISTING_PLAN.md` (house style, and the STG/label precedent) ·
`AGENTS.md` §16b (stock labels), §16c (the two listing kinds), §17 (the stock uploader), §19 (the
compositor) · `../bk-shopify/docs/INVENTORY-SYNC.md` (acceptance gates, the A–F suite) ·
`../bk-shopify/docs/EBAY-RESET.md` (D-023) · `../bk-shopify/docs/DECISIONS.md` (D-012, D-026, D-027).

---

## 0. The one-paragraph version

The eBay side of this is 90% built and the Shopify side is 0% built, which makes it tempting to spend
the plan on Shopify. That is the wrong emphasis. **The tool has no path that removes a listing from a
channel when the item sells on the other one.** `decrementInventoryItem` writes
`channel_status = 'ended'` on the local row and stops; the only end path in the repo is a manual
`POST /api/listings/:itemId/withdraw` button, and `EndFixedPriceItem` appears exactly once, in a comment
saying it is deliberately not wired up. Every acceptance gate in `INVENTORY-SYNC.md` bottoms out on that
missing half. So the plan is: build the Shopify publish path first (Phase 1, eBay untouched), let the
D-023 reset re-catalog the estate through it, then build the sync against a clean single-stack estate
(Phase 3). The Shopify sink itself is ordinary work that `lib/channels/ebay-*.mjs` already shows how to do.

---

## 1. What already exists (and is good)

| Thing | Where | Verdict |
|---|---|---|
| The canonical listing object: `buildRowIn` → `toEbayListing` → `validateListing` | `lib/channels/ebay-map.mjs` | **The seam.** `shopify-map.mjs` consumes `buildRowIn` output and never re-derives |
| Authenticated REST transport: serialized throttle, 3 retries, `Retry-After`, never throws | `lib/ebay-rest.mjs` | **Copy the shape verbatim** for `shopify-admin.mjs` |
| `publishListing()` — idempotent on SKU, refuses before it writes | `lib/channels/ebay-inventory-api.mjs` | The template for `publishProduct()` |
| `applyStockDecrements(pdb,tdb)` — SKU rung then ItemID rung, decrement-**then**-stamp | `lib/postsale.mjs:410` | **Reuse with zero changes.** See §3.2 — the highest-leverage reuse in the plan |
| `reverseStockForOrder()` — restock returns to `in_stock`/`ended`, never `listed`/`active` | `lib/postsale.mjs:512` | Already correct for a cancellation on any channel |
| `peekStockLabel` / `commitStockLabel` / `nextProvisionalSku` | `lib/inventory.mjs:158-215` | Right mechanism, wrong **call site** once Shopify publishes first. §3.1 |
| `stockKey(row)` — `game\|identity\|variant\|lang\|R:cond` | `lib/inventory.mjs:88` | Drop the last segment and it **is** a `bk_card_identity` |
| Four compositor frames incl. `shopify-card` 1512×2112 and `og-card`; `buildImageSet()` returns the ordered PDP manifest | `lib/listing-image-*.mjs`, `POST /api/listing-image/build` | Built and correct. Master switch `enabled:false`; the `shopify` block is in `.example` only |
| `ebay_listings` mirror, `UNIQUE(sku, marketplace)`, `listing_status` incl. `OUT_OF_STOCK` | `lib/db.mjs:463` | Keep as eBay's own answer. `shopify_listings` is its sibling, not its replacement |
| `listing_pushes` per-attempt audit with the exact outbound body | `lib/db.mjs:521` | Copy the shape. Scrub differently — T17 |
| Loopback-only notification server + its isolation invariant | `lib/ebay-notify.mjs`, `test/invariants/ebay-notify-isolation.test.mjs` | The security model to **clone**, not the server to extend. §2.5 |
| `verifyBandPolicies` — proves a pinned config id against live truth | `lib/ebay-account.mjs` | The pattern for `verifyLocation()` |
| `withRegistry([...])` plugin array + its invariant | `vite.config.js`, `test/invariants/plugin-registry.test.mjs` | Adding `shopifyPlugin(env)` is one line inside the wrapper |

**The finding that shapes the plan:** `bulkUpdatePriceQuantity` — the one Sell-stack call that touches
price and quantity without a complete replace — **does not exist anywhere in the repo** (zero hits across
`lib/` and `scripts/`). And the Trading path is a dead end for this feature: `reviseTradingListing`
refuses `created_via === 'tool'` (`wrong_api`, `lib/listings.mjs:1162`) *and* refuses qty 0
(`qty_zero`, `:1174`). Both refusals are correct. The Sell stack has to grow the primitive.

---

## 2. Decisions (Marty, 2026-08-22)

1. **The local tool orchestrates; Shopify is the published truth.** `tracker.db` stays the authoring and
   reconciliation ledger — the only node that talks to both channels and the only one that knows physical
   stock, cost basis and shelf location. Shopify is the customer-facing published truth, never hand-edited.
2. **Marketplace Connect is dropped**, superseding bk-shopify D-004.
3. **Order of work: publish path → D-023 eBay reset → sync live.** EBAY-RESET.md's R1 step 1 is literally
   "Builder → Shopify Publish integration working", so the publish path must exist before the re-catalog.
4. **Delist means end** — `withdrawOffer`. Consequence accepted: a relist mints a new ItemID, so a
   cancel/restock is a republish. `lib/relist-watch.mjs` already adopts the new ItemID.
5. **eBay propagation is delayed 7 days by default**, per-item override (auto-now / manual / never).
6. **eBay price = Shopify base × a flat percentage, rounded UP to .48 / .98**, floored so direct ≤ eBay.
7. **v1 scope: Pokémon raw singles only.**

**LODESTONE does not exist in this repo.** It is aspirational naming in the bk-shopify docs for what we
implement as `lib/pricing.mjs`, `lib/comps-singles.mjs`, `lib/pricecharting.mjs` and the repricer.
`inventory_items.target_price_cents` is the authored ask and **is** the Shopify base price.

---

## 3. Three structural calls

### 3.1 The shelf label commits at the first real publish on **any** channel

Today `runPublish` peeks a label and commits only after eBay confirms, because six labels
(AAC-088/089/090/091/093/096) were burned on 2026-07-29 by previews that never published.

With Shopify publishing first and eBay possibly seven days later or never, keeping the commit at the eBay
publish is catastrophic: the Shopify variant SKU would be `STG-000123` — the string the theme keys on,
that every order line carries, and that `applyStockDecrements` matches — and the eventual eBay publish
would have to *rename* it, orphaning every order already placed under the provisional.

Extract `ensureShelfLabel(db, item, { channel, dryRun })` into `lib/shelf-label.mjs`. A real publish on
either channel commits; a dry run on either commits nothing; `commitStockLabel` becomes an idempotent
no-op when the row already holds a real label. The original justification survives intact — the labels
were burned by *previews*, not publishes, and a real Shopify publish means the card is genuinely for sale.

⚠ **There is no Shopify dry-run.** `productSet` on a real identifier creates a real product and
`getListingFees` has no analogue. The Shopify preview lane is **purely local**: build the input, run
`validateProduct`, return the payload, call nothing.

### 3.2 Shopify orders land in the **existing** `orders` / `order_line_items`

`docs/SEALED_LISTING_PLAN.md` D7 chose parallel tables, and that was right *there* for a reason that does
not apply here: an FK hazard (`sealed_items.id` silently passing an `inventory_items` FK check). No such
hazard exists for orders.

What does exist is `applyStockDecrements` — the most carefully-ordered function in the repo, with a
deliberate decrement-then-stamp sequence (`lib/postsale.mjs:401-406`) *so a crash under-lists rather than
oversells*, cross-DB idempotency on `stock_applied_at`, and a join-as-guard comment explaining a bug that
has already happened once. Writing a second one from memory in a different file is the worst trade available.

**Verified 2026-08-22:** `order_line_items` has **no unique index at all** and no eBay-specific
uniqueness assumption; `orders.order_id` is a plain `TEXT PRIMARY KEY`; `ingestOrder` builds an
order-shaped object and inserts it. So the tables can be shared, and the requirements are only:

- `addColumnIfMissing(orders, 'channel', "TEXT NOT NULL DEFAULT 'ebay'")`, same on `order_line_items`
- **namespace `orders.order_id`** for Shopify (`shopify:<id>`) — the PK is shared
- **namespace `buyers.ebay_username`** (`NOT NULL UNIQUE`) — `shopify:<customerId>`, or
  `shopify:guest:<orderId>` when buyer PII is redacted, since `orders.buyer_id` is `NOT NULL`

Then `applyStockDecrements` needs **zero changes**: its SKU rung matches (because §3.1 made the Shopify
variant SKU the shelf label) and its `ebay_item_id` rung simply never fires for Shopify rows.

### 3.3 "Published to Shopify" means published to the Online Store publication

`productSet` returning a product id is **not** a successful publish. Without `publishablePublish` the
product exists, is invisible to buyers, and looks live in our ledger — worse than a clean failure, because
the 7-day exclusive window then protects nothing: the item is for sale on **zero** channels while the tool
believes it is for sale on one and is deliberately withholding the other.

`publishProduct()` treats a failed or skipped publish as a failed publish, writes
`shopify_listings.state = 'unpublished'`, and does not enqueue the delayed eBay job. Which is why the
`read_publications` / `write_publications` scopes are a **Gate A blocker**, not a late detail.

---

## 4. Schema

Additive only, `addColumnIfMissing` / `CREATE TABLE IF NOT EXISTS`, in a new `migrateShopify(db)` beside
the existing migrate functions. Rehearse on a **copy of the real `data/tracker.db`** before it runs on
ALCSERVER (the P0-2 precedent from `docs/BULK_LISTING_EXECUTION_PLAN.md`).

**Intent and observation are separate tables.** One merged table would mix *intent* (mode, window, price)
written by the operator with *observation* (ids, state, last-synced) written by the reconciler on a timer.
They race, and the classic outcome is a reconcile pass quietly resetting a `mode:'never'` an operator set
thirty seconds earlier. Shopify also needs seven identifiers per sibling — product, variant, inventory
item, location, handle, publication state, identity metaobject — which no set of generic columns holds
without JSON-in-a-column and a decoder ring at every debug session.

- **`ebay_listings`** — unchanged, eBay-shaped, eBay's own answer.
- **`shopify_listings`** — new, Shopify-shaped, `UNIQUE(sku)`. Written only by the Shopify write-back and
  the Shopify reconciler.
- **`channel_intent(sku, channel)`** — new, small, operator- and tool-owned: `mode`, `publish_after`,
  `price_cents` (null = derive from base), `price_manual`, `desired_qty`, `hold_reason`.
- **`sync_jobs`** — the outbox. `dedupe_key TEXT UNIQUE`, `priority INTEGER` (sync/delist 0, publish 10),
  `run_after`, `claimed_at`, `lease_expires`, `attempts`, `state`, `last_error`.
- **`idx_inv_ebay_listing`** — missing today, which is why `buildInventoryLookup` loads both stock tables
  into memory on every poll.

On the reserved columns: `shopify_product_id` has **zero writers** today, so use it as the denormalised
"is this on Shopify" flag for cheap list queries. **`channel_status` is poisoned** — the eBay path writes
a bare literal `'active'` into it, so it means "eBay status" and always has. Fence it with an invariant
test that no Shopify module writes it.

### Why the outbox is mandatory here

For one seller doing a handful of sales a day a durable job table is normally over-engineering. Here it is
not, for a reason local to this repo: **`vite.config.js` imports every `lib/*.mjs`, which makes them
watched config dependencies, so the dev server restarts whenever one is saved.** An in-memory retry
holding "delist AAC-097 from eBay" dies mid-flight every time you edit an unrelated file. That is an
oversell on a qty-1 card caused by a stray save, and no in-memory design survives it.

Idempotency lives in the **handlers**, by construction — SKU on `createOrReplaceInventoryItem`,
`identifier` on `productSet`, `changeFromQuantity` on `inventorySetQuantities`, `@idempotent` on
`inventoryActivate`, `stock_applied_at` on the line item. `dedupe_key` then does what it should: collapse
redundant *enqueues*. Claim-with-lease, not claim-and-hold — a job claimed by a process that died must
come back.

**`publish_after` is both a column and a job, deliberately.** The column on `channel_intent` is truth; the
job is the trigger, and the worker **re-reads the column before acting**. Same rule `lib/ebay-notify.mjs`
already states: *a notification is a TRIGGER, never a source of data.*

---

## 5. The Shopify publish sequence

Verified against shopify.dev on 2026-08-22 and against `../bk-shopify/scripts/seed-dev-catalog.ps1`, the
only code that has done this against real stores. **API version pinned `2026-07`** (stable until
2027-07-16). Shopify *falls forward silently* on a retired version, so assert the response's
`X-Shopify-API-Version` matches the pin at startup rather than discovering it as a mystery.

1. **`stagedUploadsCreate`** → upload each frame (**every returned parameter first, in order, file part
   last**; images `PUT`) → `fileCreate` → poll `fileStatus` to `READY`. Images from
   `POST /api/listing-image/build`, which already returns the ordered manifest with positions,
   filenames and alt text.
2. **`productSet(identifier, input, synchronous: true)`.** ⚠ **List fields are REPLACE, not merge** —
   omitted variants, tags, metafields and files are *deleted*. Every call carries complete desired state
   built from `tracker.db`, never a patch. Key on **`customId`** (a `type: "id"` metafield holding the
   SKU — automatically unique) rather than `handle`, which is merchant-editable and would turn a later
   upsert into a duplicate create.
3. **Inventory, separately.** `ProductSetInventoryInput` has **no `changeFromQuantity`** — it is an
   unguarded absolute set, so `productSet` is for creation only. Ongoing quantity goes through
   `inventoryActivate` (new location) or `inventorySetQuantities` (existing). Both now **require** the
   `@idempotent` directive and an explicit `changeFromQuantity`, even `null`. ⚠ `compareQuantity` /
   `ignoreCompareQuantity` were removed in 2026-04; the mutation page's prose still describes them and is
   stale — the input-object schema pages are correct. Sync **`available`**, never `on_hand`: a Shopify
   order in flight sits in `committed`, which the Admin API cannot touch.
4. **`publishablePublish`** to the Online Store publication. §3.3.
5. **`metaobjectUpsert`** on `bk_card_identity` + **`metafieldsSet`** writing `bkc.card` back.

The location must satisfy `isActive && fulfillsOnlineOrders && shipsInventory`, resolved **once** at
bootstrap and pinned in `data/shopify.config.json` with a `verifyLocation()` re-check modelled on
`verifyBandPolicies`. Never `locations[0]` — a dev store's first location has `shipsInventory:false`, and
stock placed there reads as in-stock through the API while the storefront says "Unavailable".

### Identity

```
identity handle = slug(game | identity_key | finish | language)      // stockKey() minus the condition
sibling handle  = `${identityHandle}-${conditionAbbrev}`
```

⚠ **`metaobject.listings` is a read-modify-write race.** Publishing NM and LP concurrently means both
read the list, both append, one wins, and a condition silently vanishes from the PDP. So
**`identity.rebuild` is its own job type**, `dedupe_key = 'identity:' + handle`, and it **recomputes the
whole list from `tracker.db`** rather than appending or removing — idempotent, self-healing, and
coalescing. This is the one place `dedupe_key UNIQUE` genuinely earns its keep.

---

## 6. Per-channel pricing

`inventory_items.target_price_cents` stays the authored ask and is the Shopify base.
`channel_intent.price_cents` holds a derived or overridden per-channel figure; `null` means derive.

```
ebay_cents = max(base_cents, roundUpTo4898(base_cents × uplift))
```

⚠ **.48/.98 is deliberately not the ending `roundAU()` produces.** `lib/pricing.mjs` rounds *up* to
.49/.99 and is used by the bulk tier floors, so the two endings coexist — an eBay ask at `.98` beside a
tier-floored base at `.99`. Write a separate `roundUpTo4898()` beside `roundAU()` rather than changing it
(changing it would silently reprice every bulk tier floor) and pin both with a unit test. The rounding
**must always go up**: rounding to nearest could push a small uplift below the base and break the
direct ≤ eBay floor before `max()` ever sees it.

⚠ **Uplift → band → build, once, in that order.** The eBay description quotes the postage amount in prose,
resolved from the price band, and `verifyBandPolicies` exists because a description contradicting its
policy is an INAD claim on every listing in the band. Per-channel pricing is the first mechanism in this
codebase that can move a price *after* the description was built. Never uplift after `offerBandFor`, and
make a band-crossing a **refusal** until a human has looked at it.

⚠ **The repricer must write `channel_intent(sku,'ebay').price_cents`, never `target_price_cents`** —
otherwise base × uplift → raise → treated as new base → × uplift again, compounding forever. It is
`scan_enabled:false` today, so this would land months from now with no memory of this document. Comment it
at `lib/repricer-decide.mjs` and assert it in the repricer tests.

⚠ **The Shopify PDP must not carry eBay's postage sentence.** Shopify's shipping is settled and different
(tracked-only, AU-only, free over $300 — bk-shopify D-007) and the theme renders it from schema settings.
`buildItemDescription` gains an explicit `channel` and the Shopify description omits shipping copy
entirely. `lib/listing-copy.mjs` is ESM, so `shopify-map.mjs` imports it directly and pays no mirror tax.

---

## 7. Store categories

- **eBay** already works — `store.defaultCategory` + `store.categoryByGame` in
  `data/ebay-listing.config.json`, per-item override in `inventory_items.store_categories` (max 2),
  live-checked by `checkStoreCategories`. ⚠ **Both fields are empty today**, so every listing files under
  the store's "Other" department. A trickle is a nuisance; a propagation wave is a store-wide cleanup job.
  Fill from `GET /api/listings/store/categories` before Gate B.
- **Shopify** is collections: same resolver shape, new map in `data/shopify.config.json`, resolved to GIDs
  at publish. Per-set collections should be **automated collections keyed on `bkc.set_code`** so they need
  no maintenance as stock grows — what bk-shopify D-016/D-027 already assume.
- Also assign the **Shopify standard taxonomy category** (Gaming Cards `ae-2-2-3-2` for singles). The two
  layers do not substitute, and the agentic channels read taxonomy.

---

## 8. Keeping eBay running

eBay is the business until Shopify launches. Nothing in Phase 1 changes eBay behaviour.

1. **Everything ships dark** — `sync.enabled:false` until the A–F suite passes.
2. **Only S4 touches live eBay code**, and it is a pure refactor gated by
   `test/integration/deferred-label.test.mjs`.
3. **`shopifyPlugin(env)` must never throw at registration.** It joins a 28-plugin array in one process; a
   boot-time throw takes down the dev server, which is every eBay tool at once. Degrade to 409
   `not_connected` / `not_ready` exactly as `listingsPlugin` does.
4. **Do not touch `CONSENT_SCOPES` in `lib/ebay-oauth.mjs`.** That module records an incident where adding
   one scope invalidated the live token and took the store offline two hours later. This build needs no new
   eBay scope — `sell.inventory` already covers `bulkUpdatePriceQuantity`.
5. **Do not bump `ASSET_VERSION` or change rail art** — it orphans every eBay-hosted image and forces a
   full store re-upload. The Genty Sans → Baloo 2 move stays deferred to the D-023 reset.
6. **Turning on the Shopify frames does not change eBay images.** Verified: `composeAvailable()` does not
   read the master switch, and the eBay path's compose flag resolves per-row → batch → config with *absent
   meaning defer, never yes*. Add the `shopify` block, leave the top-level `enabled` at `false`, and
   confirm with one eBay publish preview that `composeHash` comes back null.
7. **Back up before migrating.** `lib/backup.mjs` already does `VACUUM INTO`.
8. **Dev store only** until cutover.

---

## 9. The traps

| # | Trap | Consequence |
|---|---|---|
| T1 | `updateOffer` / `createOrReplaceInventoryItem` are **complete replaces** | A "just set the quantity" push strips title, description, policies, store categories and images. Never the sync path |
| T2 | `productSet` list fields replace wholesale | Omitted variants, tags, metafields and files are *deleted* |
| T3 | Not using `changeFromQuantity` | It is the **only** defence in the simultaneous-purchase race. `CHANGE_FROM_QUANTITY_STALE` → re-read, re-decide, retry with a *fresh* idempotency key |
| T4 | GraphQL HTTP 200 carrying `userErrors` | Product ids recorded for products never written the way you think. eBay never does this; Shopify does it constantly |
| T5 | Uplift applied after band selection | The description quotes a postage figure checkout doesn't charge |
| T6 | Repricer writing `target_price_cents` | Uplift compounds forever, months after anyone remembers why |
| T7 | Shelf-label burn on a Shopify preview | The 2026-07-29 bug through a new door |
| T8 | Renaming a SKU after a Shopify order exists | The variant SKU is the join for every order line already placed. Freeze at first publish; warn, never rename |
| T9 | `metaobject.listings` read-modify-write race | A condition silently vanishes from the PDP |
| T10 | `publishablePublish` skipped but recorded as success | For sale on **zero** channels while the ledger says one |
| T11 | Reordering decrement-then-stamp | A crash then oversells instead of under-listing |
| T12 | In-memory job state | The dev server restarts on every `lib/*.mjs` save |
| T13 | `INVENTORY_LEVELS_UPDATE` / `PRODUCTS_UPDATE` echo our own writes | Shopify→eBay→Shopify oscillation. Suppress with `referenceDocumentUri` plus a short "recently written by me" cache |
| T14 | Webhook handler exceeding 5 seconds | Shopify's timeout is 5s and 8 consecutive failures **delete the subscription**. Shop-specific subscriptions are the only kind a custom app can have, and they are auto-deleted on failure — so a job must re-create missing ones |
| T15 | Parsing HMAC after body parsing | Verification needs the **raw** bytes. Support both secrets for an hour after any rotation |
| T16 | `parseFloat` on a `MoneyV2` amount | GR3 violation and one-cent reconcile drift. One `moneyToCents`, enforced by invariant |
| T17 | Staged-upload signed parameters landing in `listing_pushes` | It stores the exact outbound body; Shopify's staged-upload response carries a signature and policy. Scrub before writing |
| T18 | `openDb()` is a process singleton | Tests must use `openDbAt(path)` |
| T19 | `read_orders` sees only 60 days | A reconciler walking orders manufactures phantom drift on anything older |
| T20 | Changing image bytes after publish | eBay: content hash is the cache key → full re-upload. Shopify: new CDN URL → stale `bkc.og_image` and stale OG scrapes |
| T21 | Assuming buyer PII is present | Basic may redact, and redaction is an **HTTP 200 with nulls plus an `errors` array**. Check `errors` even on a 200 |
| T22 | Overloading `channel_status` | It already means eBay. Two channels writing it means the UI disagrees with both correct mirrors |

---

## 10. Gates

### Gate A — before the first real Shopify publish

| # | Prerequisite | Owner |
|---|---|---|
| A1 | Add `read_publications`, `write_publications`, `write_files` to the custom app; new version, release, reinstall. Scopes cannot be changed via the API — enumerate all of them now: `write_products`, `write_inventory`, `read_locations`, `read_orders`, `read_publications`, `write_publications`, `write_files`, `write_metaobjects`. Keep the old token until the new one is proven | Marty |
| A2 | Shopify credentials into this repo's `.env`: `SHOPIFY_SHOP`, `SHOPIFY_DEV_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` (same custom app as bk-shopify) | Marty |
| A3 | Metafield + metaobject definitions applied, plus one new `type: "id"` definition backing the `customId` upsert key | script |
| A4 | Pinned location resolved and verified on all three flags | code |
| A5 | `productType` vocabulary frozen — the theme keys the 63:88 aspect off `Single` and `Graded Slab` | code |
| A6 | Compositor `shopify` block added, rail art finalised. Free now, expensive after the first publish (T20) | Marty |
| A7 | Shopify description wording signed off — GR6 freezes it on arrival | Marty |
| A8 | Is the Shopify base GST-inclusive on the same terms as the eBay ask? | Marty |

### Gate B — before delayed-eBay propagation is switched on

| # | Prerequisite |
|---|---|
| B1 | The D-023 reset has run; the estate is single-stack |
| B2 | `store.defaultCategory` / `store.categoryByGame` filled in |
| B3 | Latency budget decided — enable `ebay-notify` (currently `enabled:false`, tunnel and tokens unset) or tighten the poll. `reconcileListings` at 30 min cannot reach the 60s gate alone |
| B4 | Uplift percentage signed off, every band ceiling checked for a crossing |
| B5 | Delayed jobs re-read stock at run time and cancel if the item sold |
| B6 | `sync-reconcile` has run report-only for a week with zero unexplained drift |

---

## 11. Tasks

`pnpm verify` green at every boundary. Size: S ≤ half-day, M 1–2 days, L multi-day.

### Phase 1 — the Shopify publish path (eBay untouched, dev store only)

| ID | Task | Files | Gate | Dep | Size |
|---|---|---|---|---|---|
| **S0-1** | Does `bulkUpdatePriceQuantity` behave on an AU offer-based listing? One sacrificial A$1 listing, one call | — | Recorded result. **The highest-value 20 minutes in the plan** | A2 | S |
| **S0-2** | ~~`productSet` list-replace semantics~~ | `scripts/check-shopify.mjs` | **CONFIRMED 2026-08-23 on the dev store.** 3 metafields + 3 tags in; after a second call carrying 1 of each, `beta`/`gamma`/`probe-tag-two`/`probe-tag-three` were **gone**. T2 holds — every publish must send complete state built from the DB | A1,A2 | S |
| **S0-3** | ~~`changeFromQuantity` really is CAS~~ | `scripts/check-shopify.mjs` | **CONFIRMED 2026-08-23.** A stale value is refused with **`CHANGE_FROM_QUANTITY_STALE`** — the named code, not merely some refusal. The simultaneous-purchase race has a real defence and S10/S11 can be built on it | A2 | S |
| **S0-4** | ~~`order_line_items` uniqueness~~ | — | **DONE 2026-08-22** — no unique index; tables can be shared. §3.2 | — | — |
| **S0-5** | ~~Protected customer data~~ | `scripts/check-shopify.mjs` | **ANSWERED 2026-08-23 — bk-shopify D-022 IS WRONG.** Dev-store order #1001 returned `customer.firstName` and `customer.email` **PRESENT** with no `errors[]`. shopify.dev was right: a Dev-Dashboard custom app has Level 2 "always available". See §13 | A2 | S |
| **S1** | ~~`lib/channels/shopify-admin.mjs`~~ **DONE 2026-08-22, live-verified 2026-08-23** — token mint+cache, cost-bucket throttle, retry, `moneyToCents`, `userErrors`→`ok:false` | `lib/channels/shopify-admin.mjs` | `test/unit/shopify-admin.test.mjs`, 22 tests, **plus a real connection to `binders-keepers-dev` via `scripts/check-shopify.mjs`** | A2 | M |
| **S2** | ~~`migrateShopify(db)`~~ **DONE 2026-08-22** — `shopify_listings`, `channel_intent`, `sync_jobs`, `channel` columns, `idx_inv_ebay_listing`, backfill | `lib/db.mjs`, `lib/postsale-db.mjs` | `test/unit/shopify-schema.test.mjs`, 13 tests. Rehearsed on a copy of the real DB: clean, idempotent across three opens, no data loss. **Backfill volume unverified — this box's tracker.db holds no inventory or eBay rows; confirm on ALCSERVER** | — | M |
| **S3** | ~~`lib/channels/shopify-map.mjs`~~ **DONE 2026-08-22** — `toShopifyProduct` + `validateProduct` off `buildRowIn`; identity handles; full `bkc.*`; `tracked:true` + `DENY`; own description | `lib/channels/shopify-map.mjs`, `lib/listing-copy.mjs` (+`pkmRarityAbbrev`) | `test/unit/shopify-map.test.mjs` (39) + `test/invariants/shopify-no-ebay-postage.test.mjs` (16). Mirror-parity harness still green | S2 | L |
| **S4** | ~~Extract the shelf-label peek/commit → `lib/shelf-label.mjs`~~ **DONE 2026-08-22** — `reserveShelfLabel` / `commitShelfLabel`, channel-neutral | `lib/shelf-label.mjs`, `lib/listings.mjs` (−25/+19) | `deferred-label.test.mjs` green **unchanged**, 27/27; new `test/unit/shelf-label.test.mjs` (9) covers both channels, the dry run, the double commit and the failed commit | — | M |
| **S5** | Images — compositor `shopify` block, `buildImageSet()` → `stagedUploadsCreate` → `fileCreate` → poll READY, `bkc.og_image` | `lib/shopify-media.mjs` | A dev product carries the ordered manifest, position 1 is the real card, the OG card scrapes. **Before S6 deliberately** | S1,A6 | M |
| **S6** | `lib/channels/shopify-product-api.mjs` + `lib/shopify.mjs` plugin — the five-step sequence, `identity.rebuild` | new, `vite.config.js` | 20 real Pokémon singles live on **dev**; the PDP condition selector renders every sibling in canonical order; `check-product-status.ps1` clean; `test/integration/shopify-publish.test.mjs` exists | S3,S4,S5 | L |

**Milestone M1 — Shopify publish works.** A card goes builder → Shopify with correct variant data, images,
metafields, identity and collection, published and visible on the dev storefront. eBay is untouched and
`pnpm verify` is green. **The D-023 reset can now start.**

### Interlude — the D-023 eBay reset

R1 re-catalogs the physical estate into Shopify through the path M1 just delivered, R2 ends everything on
eBay and relists fresh from Shopify truth, R3 watches. Plan in `../bk-shopify/docs/EBAY-RESET.md`. Two
things this build owes it: the publish path must be **batch-capable** (the existing Batch Runner and its
SSE job already provide the shape), and R1's dual-live window is the last period in which manual quantity
reconciliation is allowed. Coming out of R2 the estate is single-stack Inventory-API — which is what makes
Phase 3's delist lane one code path instead of two.

### Phase 3 — cross-channel sync (post-reset)

| ID | Task | Files | Gate | Dep | Size |
|---|---|---|---|---|---|
| **S7** | `lib/shopify-webhook.mjs` — own loopback server on `:5275`, own tunnel route, HMAC over the raw body, `orders/create` + `orders/cancelled` as *triggers*, order poll as backup, subscription-reconciliation job | new | An integration test shows a Shopify order decrementing stock through **`applyStockDecrements` unmodified**; a redacted-PII payload stores without error; new `test/invariants/shopify-webhook-isolation.test.mjs` | M1,S2 | L |
| **S8** | `bulkUpdatePriceQuantity` + `setEbayAvailableQty()` routing: offer-based → bulk call; legacy → **refuse with a code**, never fall through to `updateOffer`; qty 0 → `withdrawOffer` | `lib/channels/ebay-inventory-api.mjs`, `lib/listings.mjs` | Unit tests cover all three branches incl. the refusal; A–F tests B and C pass on a production sacrificial listing with recorded timings | S0-1,B1 | M |
| **S9** | `lib/sync-queue.mjs` + `lib/sync-worker.mjs` — priority lanes, backoff, lease sweep, dead-letter panel on `listings.html` | new | A killed worker's job is recovered by the lease sweep; a double-delivered order produces one decrement; drill F passes | S7,S8 | L |
| **S10** | `onSale` → `delistElsewhere`, both directions, behind `sync.enabled:false` | `lib/sync-worker.mjs`, `lib/postsale.mjs` | The A–F suite measured on production sacrificial stock with **p95 recorded**; test D clean over 24–48h | S9 | M |
| **S11** | Delayed propagation + per-channel pricing — `publish_after`/`mode`, `roundUpTo4898`, uplift-before-band, the band-crossing refusal, the run-time stock re-read | `lib/sync-worker.mjs`, `lib/pricing.mjs`, `data/shopify.config.json` | An item appears on eBay exactly 7 days later at the uplifted price under the correct band with a correct postage figure; an item sold inside the window never reaches eBay; `mode:'never'` enqueues nothing | S10,B4 | L |
| **S12** | `lib/sync-reconcile.mjs` — **report-only**, on the existing 30-minute cadence | new | A full week report-only with zero unexplained drift, then fix mode enabled | S10 | M |

**Milestone M2 — no oversells.** A week with zero oversells and zero manual sync interventions, which is
also roadmap Phase 5's exit criterion.

---

## 12. Verification

The acceptance gate is the A–F suite in `../bk-shopify/docs/INVENTORY-SYNC.md`, run on **sacrificial
production listings** (Shopify sandbox AU checkout is community-reported unreliable), timestamped at every
hop.

| Test | What | Gate |
|---|---|---|
| A | eBay → Shopify decrement, ≥5 runs across times of day | p95 checkout→zero **< 60 s** |
| B | Shopify → eBay delist | offer withdrawn, gone from search |
| C | cancel → restock → republish | republished and the new ItemID adopted by `relist_watch` |
| D | relist-bug probe, 24–48 h watch | **zero** unexpected reappearances |
| E | near-simultaneous purchase on both channels | exactly one succeeds; `changeFromQuantity` is what makes this true |
| F | failure drills: kill the webhook mid-purchase; double-deliver an order; inject drift | poll zeroes within one interval; duplicate is a no-op; reconcile reports it |

Local gates: `pnpm verify`, and `../bk-shopify/scripts/check-product-status.ps1` clean on every published
product. `../bk-shopify/scripts/place-test-order.ps1` creates a real paid order with no payment gateway
and cancels with restock — the Shopify half of B, C and E.

---

## 13. S0 results (first live run, 2026-08-23)

Run with `node --disable-warning=ExperimentalWarning scripts/check-shopify.mjs` on ALCSERVER, against
**`binders-keepers-dev`** (plan "Basic App Development"). Three of the four questions are now answered,
and one of the answers overturns a decision in the other repo.

**`productSet` replaces — confirmed.** Three metafields and three tags in; a second call carrying one of
each left exactly one of each. T2 stands: every publish sends complete state rebuilt from `tracker.db`,
never a patch. This is now measured rather than read off a doc page.

**`changeFromQuantity` is a real compare-and-swap — confirmed, and this is the important one.** The
stale write came back refused with the *named* code `CHANGE_FROM_QUANTITY_STALE`, which is what makes it
evidence: an unrelated refusal would have proved nothing. This is the only defence in the
simultaneous-purchase race on a qty-1 card, so S10 and S11 rest on it.

**Buyer PII is READABLE — bk-shopify D-022 is wrong.** Order #1001 returned `customer.firstName` and
`customer.email` as PRESENT with an empty top-level `errors[]`. shopify.dev's "custom apps: always
available at Level 2" is correct and help.shopify.com's plan-gated reading does not apply to a
Dev-Dashboard custom app. Consequences, all in the other repo:
- the Phase 4 ledger does **not** have to run de-identified;
- "order PII for the ledger/shipping tooling" disappears from D-022's list of Grow-plan upgrade triggers;
- `INVENTORY-SYNC.md`'s webhook PII test keeps its value as a *webhook*-payload check, since a webhook
  body is not the same surface as a GraphQL query and should still be confirmed at S7.
  (`shippingAddress.address1` came back null on #1001 — that is `place-test-order.ps1` completing a draft
  order with no default address on the test customer, not redaction. `customer.email` being present is
  what settles it.)

**Still open: S0-1**, the `bulkUpdatePriceQuantity` probe. It needs a sacrificial live **eBay** listing,
not Shopify, so it is not in this harness. It remains the highest-value 20 minutes in the plan and it
gates S8.

A false FAIL worth recording, because it is the mirror of the failure mode the harness was built to
avoid: the first run reported `read_publications` MISSING. It was granted — as `write_publications`,
which implies it. The probe was string-matching a scope list instead of testing the capability. It now
does both: implied reads are honoured, and it actually queries `publications` and names the Online Store
publication, which is the thing S6 genuinely needs.

---

## 14. Still to settle

1. The uplift **percentage** (shape is decided: flat %, rounded up to .48/.98). Due before S11.
2. The **high-value one-channel threshold** — due immediately after the latency test.
3. **GST treatment** — Gate A8.
4. **Shopify description wording** — Gate A7.
5. **S0-1** — `bulkUpdatePriceQuantity` against a sacrificial eBay listing. Gates S8.
