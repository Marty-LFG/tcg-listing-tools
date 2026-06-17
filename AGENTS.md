# AGENTS.md

Entry point for AI coding agents (Claude Code and similar) working on this repo.
Humans wanting plain run instructions: see `README.md`. Dense API reference:
see `docs/DATA_SOURCES.md`.

---

## 1. What this is

A small suite of **eBay listing tools for trading-card singles**, built for an
Australian (eBay AU) seller. It is a **Vite project of standalone HTML pages** —
vanilla JS, no framework, no front-end build step. Everything runs on the Vite
**dev server**, which also acts as the API proxy layer.

Pieces:

- **`index.html`** — landing page. Hosts a self-contained **eBay AU pricing
  calculator** (backs out a list price so the buyer's fee-inclusive total hits a
  target) and links to the four builders.
- **Four listing builders** — `pokemon-`, `mtg-`, `swu-`, `riftbound-listing-builder.html`.
  Each: pick a set + card number → fetch live card data through a proxy → fill
  editable fields → generate an eBay HTML description + an 80-char-optimised eBay
  title → copy. Plus a shared "extras" panel: card images (with download),
  prices (with live AUD conversion), and a price-trend graph (Riftbound only).
- **`extras.js`** — shared `TCG.*` module used by all four builders.
- **`vite.config.js`** — the dev-server proxies + an image-streaming middleware.

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

6. **The condition / postage / footer blocks are identical across all four
   builders** (owner-verified wording). If you edit one, edit all four. Current
   text: condition = `"{cond}. Pulled straight to sleeve and stored in a
   toploader."` (default `Ungraded, Near Mint`); postage = `"Ships in a penny
   sleeve and toploader inside a rigid mailer, with FREE postage within
   Australia."`; footer = `"From a smoke-free home. Fast dispatch. Thanks for
   looking."`

7. **Every builder must survive its API being down.** Fields are editable; a
   failed lookup shows a warning, never a crash. Keep manual entry working.

8. **eBay descriptions use inline styles only** — no `<style>`, `<script>`, or
   active content (eBay strips them). `buildHTML()` already follows this.

---

## 3. Run / dev loop

```bash
pnpm install
cp .env.example .env        # add Scrydex keys for Riftbound; pokemontcg key optional
pnpm dev                    # serves http://localhost:5173 (host:true → also on the LAN)
```

- There is **no test runner**. Validate JS edits with `node --check` on the
  extracted inline script (see §8).
- The dev server binds to `0.0.0.0:5173` for LAN access; see `README.md` for the
  systemd unit (`tcg-tools.service`) and firewall notes.
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
| `riftbound-listing-builder.html` | Riftbound builder. Largest file — embeds offline card data for the first 3 sets, plus live Scrydex for all sets. Only builder with a price-trend graph. |
| `extras.js` | Shared `TCG.*` module: images/prices/graph panel, FX, title-fitting, condition/lang codes. Loaded by each builder via `<script src="/extras.js">`. |
| `vite.config.js` | Dev-server config: `/api/*` proxies + `/api/img` streaming middleware + LAN host settings. |
| `.env.example` | Placeholder env vars. Copy to `.env`. |
| `package.json` | Vite ^6; scripts `dev` / `build` / `preview`. (Use `dev`; see Golden Rule 1.) |
| `tcg-tools.service` | Sample systemd unit for always-on LAN hosting. |
| `README.md` | Human run + hosting instructions. |
| `docs/DATA_SOURCES.md` | Per-game API endpoints, response schemas, key handling, rate limits. |

---

## 5. Architecture & data flow

**Proxies** (`vite.config.js`) — each strips its `/api/x` prefix and forwards:

| Route | Target | Auth / notes |
|---|---|---|
| `/api/pkm` | `api.pokemontcg.io/v2` | Optional `X-Api-Key` from `POKEMONTCG_API_KEY` (keyless works, lower limit). |
| `/api/mtg` | `api.scryfall.com` | Adds `User-Agent` + `Accept`. No key. |
| `/api/swu` | swu-db API | No key. |
| `/api/rb`  | `api.scrydex.com/riftbound/v1` | Injects `X-Api-Key` + `X-Team-ID` from `.env`. Required. |
| `/api/fx`  | `api.frankfurter.app` | FX rates for AUD conversion. No key. |
| `/api/img` | (middleware) | Streams any remote image same-origin so the browser can blob-download it. |

**`extras.js` public surface** (`window.TCG`):

| Function | Does |
|---|---|
| `renderExtras(el, {name, images, prices, history})` | Renders the image/price/graph panel into `el`. |
| `loadFx()` / `toAUD(amount, cur)` | Fetch (cached) ECB rates via `/api/fx`; convert to AUD. |
| `condCode(s)` | Condition string → eBay title code (`Ungraded, Near Mint` → `M/NM`, graded → `PSA 10`, etc.). |
| `langCode(s)` | Language → 2-letter code (`English` → `EN`). |
| `fitTitle(parts, max=80)` | Assemble an eBay title from prioritised parts; full → abbreviated → drop-lowest-priority until ≤ max chars. |
| `histFromTrends(market, trends)` | Reconstruct a rough price series from Scrydex trend deltas (Riftbound graph). |
| `clear(el)` | Empty an extras panel. |

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
- **Theme any new shared UI** with the existing CSS vars: `--gold`, `--line`,
  `--muted`, `--text`, `--field`, `--panel2`, `--panel`, `--ink`. All four
  builders define these (SWU aliases `--gold` to its yellow).

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
SCRYDEX_API_KEY=...      # required for Riftbound
SCRYDEX_TEAM_ID=...      # required for Riftbound
POKEMONTCG_API_KEY=...   # optional; raises pokemontcg.io limit to 20k/day
```

Injected as headers in `vite.config.js`. Browser never sees them. If a tool
returns 401/403, the key is missing or wrong in `.env` — not a code bug. Never
commit `.env`; never echo a real key into `.env.example` or source.

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
The four games supported are Pokémon, Magic: The Gathering, Star Wars: Unlimited,
and Riftbound. Accuracy of set / number / variant / condition in titles and item
specifics directly affects whether a sale sticks (eBay "not as described"
disputes), so correctness there outranks cleverness.
