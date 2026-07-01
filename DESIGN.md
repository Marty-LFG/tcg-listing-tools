# Vault Ledger — Design System

The **Vault Ledger** is the shared visual language for the `tcg-listing-tools` suite: the
seven eBay listing builders, the card pre-grader, the shipping-label maker, the price
tracker, and the **Binders Keepers** graded-card inventory platform. This file is the source
of truth for how the suite looks and how to extend it. Linked from `AGENTS.md`.

---

## 1. Intent

A **refined dark collector's vault** — the feel of a well-made ledger kept in a safe.
Deliberately **refined, not maximalist**: near-black layered surfaces, hairline borders, one
warm metallic accent per tool, a serif display face over a clean sans body, and **every number
set in monospace** like entries in a register.

Two goals sit above everything else:

1. **Coherence across the suite** — every page reads as one product (palette, type, depth,
   components).
2. **Per-tool identity is preserved** — each tool keeps a single distinct accent (`--gold`) so
   it's recognisable at a glance. The shared layer re-themes everything *except* that accent.

---

## 2. Design tokens

All colour, depth, and type live in CSS custom properties on `:root`. The **flagship inline
pages** (`index.html`, `tracker.html`, `inventory.html`) declare the full set locally;
`vault.css` re-declares the shared/neutral subset so the linked pages inherit the same palette.
Money is stored/computed in **integer cents** in the data layer (Golden Rule 3) — these tokens
govern presentation only.

### Surfaces
| Token | Value | Role |
|---|---|---|
| `--bg` | `#0a0b0f` | Page base (inline pages) |
| `--bg2` | `#0d0f15` | Lower stop of panel gradients |
| `--ink` | `#0b0d12` | Input / field / well background |
| `--panel` | `#14171f` | Card / panel upper surface |
| `--panel2` | `#1b1f2a` | Raised panel surface |
| `--field` | `#0b0d12` | Form-field background (alias of ink) |

### Lines
| Token | Value | Role |
|---|---|---|
| `--line` | `rgba(255,255,255,.075)` *(vault.css `.08`)* | Hairline borders, dividers |
| `--line2` | `rgba(255,255,255,.13)` *(vault.css `.14`)* | Stronger borders, input outlines, hover |

### Text
| Token | Value | Role |
|---|---|---|
| `--text` | `#e9edf6` | Primary text |
| `--muted` | `#8b93a6` | Secondary / labels |
| `--faint` | `#5b6373` | Tertiary / placeholders |

### Accent — one per tool
| Token | Value | Role |
|---|---|---|
| `--gold` | `#d4b072` *(inventory / tracker / hub / tools)* | The single accent — **each page overrides this** |
| `--gold-soft` | `rgba(212,176,114,.14)` | Focus-ring glow, accent tints |

Per-page `--gold` overrides in the wild: grader `#d9a4ff` (purple), shipping `#5ab0ff` (blue),
SWU/LEGO `#ffe81f`, Pokémon `#f0c04a`, MTG `#d59a4a`, Funko `#3fdccb`, Riftbound `#d4b072`. On
the hub the per-game eyebrow colours live in `index.html` (`.pkm .eyebrow` etc.); the inventory
"in-stock" green eyebrow is `#5fd39c`.

### Semantic
| Token | Value | Role |
|---|---|---|
| `--green` | `#43d6a0` | Positive P/L, in-stock, "go" |
| `--red` | `#f0666e` | Negative P/L, danger, errors |
| `--amber` | `#f0c04a` | Warnings, overdue, pending |
| `--blue` | `#6ab0ff` | Listed, info, "blue" actions |
| `--purple` | `#d9a4ff` | Grade badge (inventory) |

### Depth
| Token | Value | Role |
|---|---|---|
| `--shadow` | `0 12px 34px -14px rgba(0,0,0,.72)` | Standard soft panel shadow |

---

## 3. Typography

Three families, each with a strict job. Fallbacks are declared inline so pages stay legible
before (or without) the web fonts.

| Var | Stack | Used for |
|---|---|---|
| `--serif` | `'Fraunces',Georgia,'Times New Roman',serif` | Display — `h1`, group/section headings, monogram, modal titles |
| `--sans` | `'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif` | Body & UI — everything not a heading or a number |
| `--mono` | `'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace` | **All numbers** — SKUs, cert numbers, prices, grades, P/L deltas, counts, status lines, `.tag` labels, `code`/`kbd` |

**Rule: numbers are always mono.** Any figure a user reads as data — a price, a grade, a SKU
(`BK-<GAMECODE>-000001`), a cert number, a delta, a count pill — is IBM Plex Mono for tabular
alignment and register-like legibility. Prose and labels are IBM Plex Sans; headings and brand
marks are Fraunces (a variable optical-size serif, loaded at weights 500/600/700).

**Font loading** — every page carries the same tags in `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
```

`display=swap` paints fallback text immediately, so a fully **offline LAN** still works — it
just falls back to system serif/sans/mono. The fonts are the suite's only external runtime
dependency beyond the data APIs.

---

## 4. Architecture — how it's applied

Two delivery modes, one look:

- **Flagship inline pages** — `index.html`, `tracker.html`, `inventory.html` carry the full
  token block + component CSS **inline** in their own `<style>`. They are the richest surfaces
  (masthead, tiles, slab badges, modal) and own their styling end-to-end.
- **Shared layer (`vault.css`)** — the nine builder / grader / shipping pages keep their
  original bespoke inline `<style>` and **link `vault.css` + the font tags right before
  `</head>`**, i.e. *after* their inline styles. Because `vault.css` comes later in the cascade,
  its `:root` re-declares the shared **neutral** vars (`--ink`/`--panel`/`--panel2`/`--line`/
  `--field`/`--muted`/`--text`) → the whole page re-themes to the vault palette, adopts the
  fonts + atmospheric background, and picks up refined `.card`/input/`.btn`/`.tag`/scrollbar
  styles.

**The deliberate rule:** `vault.css` re-themes neutrals + typography + background, but each page
**keeps its own `--gold` accent** (`vault.css` never sets `--gold`). So the SWU builder stays
yellow, the grader stays purple, shipping stays blue — tools remain identifiable, exactly like
the hub tiles. This is the whole trick: **unified shell, per-tool accent.**

`vault.css` intentionally does **not** touch layout, JS, or the eBay listing-preview
`<iframe srcdoc>` (that's a separate inline-styled document — Golden Rule 8). Adding a page to
the system = add the three `<link>` tags before `</head>`; nothing else.

---

## 5. Background & depth

Depth comes from layering, not decoration:

- **Atmospheric background** — two soft radial glows (gold top-left, blue top-right) over a
  vertical near-black gradient, `background-attachment:fixed`. On the three inline pages a faint
  **ledger-grid texture** is added via `body::before` (a 46 px CSS grid masked to a top-centre
  radial so it fades out).
- **Panels** — a subtle `linear-gradient(180deg,var(--panel),var(--bg2))`, a hairline
  `--line` border, and `--shadow`. Never flat fills.
- **Hairlines over boxes** — separation is carried by 1px translucent borders and spacing, not
  heavy strokes.

---

## 6. Components

- **Masthead + monogram** — a 48 px rounded, gold-bordered tile holding a Fraunces glyph
  (`BK` on hub/inventory, the tool emoji on tracker), a Fraunces `h1` (with an italic muted
  qualifier), and a mono sub-line separated by `·` dots.
- **Summary tiles** (`inventory.html`) — gradient panel, a gold top-rule (`::before`), tiny
  tracked-uppercase label, a big **mono** metric, hover lift, staggered `rise` entrance.
- **List / item cards** — gradient panel + hairline + shadow, hover lift, `rise` animation, and
  a **status-coloured left accent rail** via `.card::before` + `:has(.pill.in_stock|listed|sold|
  overdue)`. The tracker's cards use a neutral gold rail.
- **Pills & badges** — status **pills** (`.pill.in_stock` etc.) are tinted, tracked-uppercase,
  and always carry text (not colour alone). P/L **badges** are mono with a tinted up/down
  background.
- **Slab badge** (`slabBadge()` in `inventory.html`) — a Collectr-style mini graded slab per
  card. It reads the company's `theme{bg,fg,accent}` from `data/grading-companies.json` and
  renders an SVG "case" with a coloured label band (company code + grade) over a card window.
  When the item has an `image_url` it renders the **real card image inside the slab** (HTML
  variant) instead of the placeholder. Used in the stock list and as a live preview beside the
  Add/Edit company + grade fields.
- **Modal** — blurred backdrop, gradient panel, 20 px radius, Fraunces title, a sectioned grid
  of labelled fields, a bordered action footer, and `rise` entrance.
- **Buttons** — `.btn` base plus `.go` (green), `.ghost` (muted), `.danger` (red), `.blue`
  (info); subtle hover lift + tint. **Inputs/selects/textareas** — `--ink` background, rounded,
  with a **gold focus ring** (`border-color:var(--gold)` + `0 0 0 3px var(--gold-soft)`).

---

## 7. Motion

- `@keyframes rise` (fade + 9px translateY) on tiles, cards, signals, and modals; `@keyframes
  fade` on overlays.
- Summary tiles stagger via `nth-child` `animation-delay` (~.06/.12/.18s).
- Hover transitions are ~.16–.2s ease; buttons/cards lift 1–2px.
- **`@media (prefers-reduced-motion:reduce)` disables all animation/transition** on every page.

---

## 8. Accessibility

- Reduced-motion honoured suite-wide (above).
- **Colour is never the only signal** — status pills carry text; P/L badges show the signed
  number, not just red/green.
- Numbers are monospace for tabular alignment.
- Visualisation-style widgets include a visually-hidden `<h2 class="sr-only">` summary.
- Gold focus rings give a clear, high-contrast keyboard-focus state on all fields.

---

## 9. How to style a new page/tool

**A builder-style page** (inherits the shared layer):

```html
<!-- right before </head>, AFTER the page's own inline <style> -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/vault.css">
```

Keep the page's own `:root{--gold: <its accent>}` (and any bespoke classes). Reference the
shared vars for surfaces/lines/text; put every number in `var(--mono)`.

**A flagship surface** (owns its styling): copy the full `:root` token block from
`inventory.html`, use the component patterns above (masthead, tiles, cards with status rails,
modal), and keep `--gold` as the tool's accent. Do **not** also link `vault.css` — the tokens
are already inline.

---

## 10. Where it lives

| File | Role |
|---|---|
| `vault.css` | Shared design layer linked into the 9 builder/tool pages. Neutral-var re-theme + fonts + background + primitive restyles. |
| `index.html` / `tracker.html` / `inventory.html` | Flagship pages — full tokens + components inline. |
| `data/grading-companies.json` | Per-company `theme{bg,fg,accent}` that drives the slab badge. |
| `inventory.html` → `slabBadge()` | The mini-slab SVG/HTML renderer. |
| `AGENTS.md` §7 | Short pointer to this system for agents. |
