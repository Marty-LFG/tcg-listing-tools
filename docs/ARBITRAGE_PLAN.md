# eBay AU → local-buyer arbitrage finder

Status: **BUILT 2026-09-12 — Phases 0, 1, 2 and 3(b), the newly-listed sweep.** Page `arbitrage.html`, API `/api/arb`, engine `lib/arb-core.mjs`, plugin `lib/arbitrage.mjs`, config `data/arbitrage.config.json` (seeded from the tracked example, healed on boot when a newer key is missing), settings group `arbitrage`, status job `arb_watch`. Phase 3(a) and 3(c) remain sketches.

> Review pass, same day: nine findings on the first cut, all fixed before the sweep was built — a prefixed number (TG01) matched any card with those digits; "Regular Holo" read as non-holo; "no whitening" read as whitening; "excellent" / "very good" rejected casual sellers; a row with no seller block skipped the feedback floor; the Telegram button carried a loopback URL; the set file was re-parsed per card; duplicate cards in one request spent duplicate calls; the resolved table's watching flag went stale when the printing changed.

## The rule

A local buyer pays **80% of the TCGplayer MARKET price (USD) for a Near Mint raw Pokémon card of the matched printing**, no questions asked. The tool searches eBay AU Buy-It-Now listings for cards the operator names, prices each listing **landed** — item + postage + the buyer-protection fee — and stores a **hit** wherever the buyer's price, converted at the day's Frankfurter rate, beats the landed cost by both floors (default **A$5 and 15% of outlay**).

It never buys, never lists, never touches inventory. Its side effects are its own four tables (`arb_watch`, `arb_hits`, `arb_scans`, `arb_budget`), one counter of eBay calls, and an optional Telegram card per new hit from a scheduled pass.

## Phase 0 — what was measured before any code (2026-09-12)

All against the live Browse proxy, ~130 calls in total.

1. **`conditionDescriptors` are NOT on item summaries.** 0 of 50 AU rows carried one. The title is the whole condition signal; the classifier accepts a descriptor anyway if eBay ever sends one.
2. **`conditionIds:{4000}` lets graded cards through.** A "PSA 10" came back as Ungraded/4000. The shared `isGraded` (lib/comps-singles.mjs) trusts that id and returns "raw" before reading the title, so the arbitrage filter has its own title-always check (`GRADED_RE`).
3. **Query wording.** On ten Obsidian Flames cards, `compsQueryFor`'s wording ("Pokemon <name> <number> <set name>") and the shorter "Pokemon <name> <number>" found the SAME strict-number rows (±3); the extras the short wording recalled were almost all a different card (Mega Charizard X ex 223/193 for a 223/197 search, 125/094 for 125/197). Default `query_mode: comps`; the others stay as settings.
4. **Number matching must be strict.** A bare number matched the wrong set 18 times in 39 rows on one card. Rule: `number/printedTotal` in the title, or the bare number **and** the set named (name, PTCGO code, or set id with/without zero pad). Bare alone is rejected.
5. **Paging.** `sort=newlyListed` works with the three filters; `offset=10000` still returns rows (the 4,000 cap in lib/ebay-links.mjs is the web search's). A broad "Pokemon Obsidian Flames" AU/BIN/raw query had 17,839 listings, and the newest 200 spanned about two days.
6. **Buyer-protection fee.** Two AU listing pages (a 13k-feedback business seller and a 7-feedback seller) showed **no fee line** on the page. The repo's own model (lib/fees.mjs) says buyers pay it on the owner's listings. The fee stays in the landed cost by default (`buyer_fee_mode: feeAU`), is stored as its own `fee_cents`, and is a settings switch. **Flip to `none` if a real checkout shows no fee.**
7. **Stamped promos share the number.** "Play! Prize Stamp" 125/197 at A$47 sat beside the plain card at A$10. `VARIANT_RE` drops stamp/prize-pack/prerelease/staff/misprint titles.
8. **Every row had a postage quote** with `EBAY_BUYER_POSTCODE` set. Rows without one are dropped and counted, never treated as free postage.

## What a scan does, per card × printing

`buildScanQuery` → one Browse call (`buyingOptions:{FIXED_PRICE},itemLocationCountry:AU,conditionIds:{4000}`, category 183454, no exclusion terms) → `rowFromBrowse` (keeps itemId, URL, image, seller feedback — the comps parsers throw these away) → `filterListing` in this order, each reason counted: auction, not AU, not AUD, our own listing, no postage quote, graded, junk (`JUNK_RE` + decks/tins/codes), stamped variant, number tier, language, stated condition below NM, printing contradiction, seller floors → `scoringMarket` → `hitMaths` → `qualifies` → `reconcileHits` → one transaction.

Rules worth knowing:

- **Unstated condition is accepted and chipped.** Most AU titles say nothing; the owner reads the photos. A stated LP/MP/HP/damaged rejects. "120 HP" is a stat, "125/197 HP" is a grade; "ex" is a card type, never Excellent. "Excellent" and "very good" are casual-seller language, accepted and chipped `says excellent`; "no whitening" / "no edge wear" assert the absence of a flaw and are stripped before the grade rules run.
- **Number matching:** `number/printedTotal` in the title, or the bare number with the set named. A letter-prefixed number (TG01, SWSH039) is matched literally with zero-pad tolerance and never by its bare digits.
- **An unmarked title on a multi-printing card is scored at the cheapest printing it could be** and chipped `printing?`. An uncommon's reverse holo is ten times its normal; scoring an unmarked listing at the reverse price would call every cheap normal a bargain. If any candidate printing lacks a market figure the row is unscorable and dropped.
- **Coupon rows are kept** (the price is an upper bound, so the profit is a lower bound).
- **Margin is return on outlay:** profit / (price + postage + fee).
- **"Too good" (< 0.25 × market) is flagged `check_printing`** and never alerted; it is almost always the wrong card. `stale_market` (figure older than 14 days) likewise.
- **Money is integer cents in its source currency** with the fx rate stored on every hit (GR3).
- **Hit status:** `new` → `seen` → `bought` | `dismissed`; the scan sets `gone` (with `not_listed` or `below_floor`), a gone row that reappears becomes `seen`, never `new` again, so an alert fires once per listing ever. `bought` and `dismissed` are final.

## The budget

The Browse app token is ~5,000 calls/day for the whole app. This tool counts its own calls per **UTC day** in `arb_budget` (attempts, not successes), refuses a scan up front when it would overrun `daily_call_budget` (default 3,500), and on a 429 marks the day spent so the scheduler stops trying. The proxy itself still has no shared counter — comps, the repricer and the testbed are uncounted here. A shared counter in `ebayProxy` is the follow-up if the other tools ever crowd this one out.

## Phase 1 — manual tool (built)

Set picker + catch box with the batch runner's grammar (`125`, `130 r`, `*charizard`, bare set code switches the set) → `POST /resolve` (no eBay call; shows market, which price field fed it, age, buyer price; a `low`-only printing cannot be scored, GR4) → `POST /scan` streaming NDJSON (`{job}` → `{start}` → `{card}`* → `{hit}`* → `{summary}`), attachable from any tab via `/scan/:id/stream?from=`, cancel stops after the current card → hits table ranked by profit with Buy / Bought / Dismiss / check-qty (one getItem call, only on request).

Gate met: `pnpm verify` green (6,720 + 922), the live case (`TEST_LIVE=1`) parses AU rows and counts exactly one call, and 46 real cards were scanned from the page and the API.

## Phase 2 — watch list + Telegram (built)

`arb_watch` rows, scanned by `startArbWatchJob` (house pattern: stop-then-start singleton, unref'd, boot pass +60 s, then `watch.interval_hours`). A pass is skipped when a manual scan is running, when nothing is watched, or when the day's remaining budget is short. After a pass, `renderArbHit` (lib/telegram-cards.mjs) sends one card per `new` hit never notified and not alert-blocked, capped per pass. Armed from settings.html (`watch.enabled`), re-armed on save, surfaced at `/api/status` under `jobs.arb_watch`. `POST /api/arb/watch/run` runs a pass by hand.

Gate met: a manual pass ran over two watched cards and reported `telegram_off` on this box (no bot token); arming through a settings PUT started the timer and disarming cleared it.

## What the first scans said

46 card × printing combinations across sv3, sv4, me2pt5 and rsv10pt5 (chase cards, US$3–60 market) produced **zero hits**. Closest misses ran from A$6 short (Yveltal) to A$78 short (Altaria ex): AU sellers price liquid cards well above 80% of TCGplayer market at a 1.39 USD→AUD rate, and the fee assumption is not what decides it (removing it moves each miss by A$1–4). The tool is behaving; the market for chase cards is simply not where the arbitrage is. The lever is Phase 3(b): catching a mispriced listing in the hours after it goes up, before the market does.

## Phase 3(b) — the newly-listed sweep (built)

The sets to sweep live in `arb_sweep_sets` (added from the page's set picker; pause / reset watermark / remove). A pass runs, per enabled set, one broad Browse query per configured wording, `sort=newlyListed`, 200 a page, paging until it reaches the set's **watermark** (the newest `itemCreationDate` the last pass read) or `sweep.max_pages_per_set`; a first pass reads `sweep.first_run_pages`. Every title goes through `matchTitleToCard` (lib/arb-core.mjs): a strict `number/printedTotal` (or a gallery form like TG01/TG30), the number looked up by `numKeys`, and the card's name token found in the folded title. Then exactly the filter and maths a named-card scan uses, with no wanted printing: an unmarked title on a multi-printing card scores at the cheapest printing it could be. Reconciliation runs only over the listings the pass saw (a sweep sees new listings, so it can never say an older hit is gone), and a listing an earlier scan already stored is updated under its existing printing so one listing never becomes two rows. Hits carry `source = 'sweep'`.

Measured on the first passes (2026-09-12):
- `Pokemon Obsidian Flames`, newest 200: 194 strict catalogue matches, spanning ~36 hours → one call a day.
- `Pokemon 197` (the bare printed total) adds the ~6% of titles that never name the set. Both wordings are the default (`sweep.queries`).
- **Printed totals collide** — Paradox Rift and Destined Rivals are both `/182` — so the bare-number query for one set returned the other's listings (128 name mismatches). Sets sharing a total now form a group: the first member runs the number query once and every title is matched against every set in the group. Three sets cost five calls; 749 of 779 new listings matched a catalogue card.
- A pass minutes after another reads one row per query and stops ("caught up").
- Still **zero hits**: every matched listing landed above the buyer price. The sweep is now the standing net; the first hit will come from a seller who priced a new listing at under ~65% of TCGplayer market, and the watch pass (every `watch.interval_hours`) is what catches it before the market does.

Armed with `sweep.enabled` in settings (runs inside the watch pass after the cards, then one round of Telegram alerts for both legs); **Sweep now** on the page runs it by hand either way. `/api/status` `jobs.arb_watch.sweep` shows the set count and whether it is armed.

## Phase 3 — still sketches

- **(a) Value-floor set sweep.** One call per card × printing with market ≥ a floor; an SV set is ~40–70 calls. Less useful now that (b) covers whole sets for two calls, but it re-prices EXISTING listings the sweep will never revisit.
- **(c) Price-move trigger.** The tracker's `signals` table (kind `opportunity`) already knows when a watched card's market dropped; enqueue a scan for it.

## Out of scope

Auctions and best-offer negotiation, automatic buying, non-English cards, other games (the schema carries `game` for later), seller-side fee modelling (irrelevant on the buy side), quantity on multi-quantity listings except through the explicit check-qty call.

## Files

`lib/arb-core.mjs` (pure engine, browser-safe; sweep matching at the bottom) · `lib/arbitrage.mjs` (plugin; `runScan`, `runSweep`, the job, the watch pass) · `lib/arb-config.mjs` (loader/validator/defaults/heal) · `lib/db.mjs` `migrateArbitrage` · `lib/stock-games.mjs` now owns `finishHint` (re-exported from lib/listings.mjs) · `lib/telegram-cards.mjs` `renderArbHit` · `lib/status.mjs` `SETTINGS.arbitrage` + `jobs.arb_watch` · `arbitrage.html` · `settings.html` group · `index.html` tile · `data/arbitrage.config.example.json` · tests: `test/unit/arb-core.test.mjs`, `test/unit/arbitrage-db.test.mjs`, `test/unit/telegram-cards-arb.test.mjs`, `test/data/configs.test.mjs`, `test/integration/arbitrage.integration.test.mjs`, the live case in `test/integration/live.integration.test.mjs`; fixture `test/fixtures/arbitrage/browse-sv3-125.json`.
