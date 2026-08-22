# Card pre-grading — design and execution plan

Status: **BUILT 2026-08-22** — all phases landed on `main` the same day the plan was approved.
Five commits, oldest first: `f94baa2` (engine fixes + first tests), `3693526` (AI schema v2),
`268a549` (flatbed scan route + auto-centering), `05e6107` (persistence), `6ad66bf` (guided
wizard client). `pnpm verify` green: ~3,000 unit/invariant/data tests + 511 integration.

Scope: predict a grade from photos, flatbed scans and microscope shots **before** paying a
grading company, produce a TAG-style annotated report, save it, and link it to the real
submission so the prediction eventually meets its actual grade. Pokémon first (D3); other
games enter through the manual fields.

Companion docs: `AGENTS.md` (GR4 honesty, GR7 degradation), memory notes `pregrading-tool.md`
and `pregrading-research-facts.md` (tolerances, costs, test-card authenticity, 2026).

---

## 0. The one-paragraph version

An alpha grader already existed — one commit, no plan doc, and it worked: sliders in,
prediction out, optional AI pass. What it could not do was **remember** anything, **capture**
anything repeatably, or ever find out whether it was right. A prediction lived in a browser
tab and died with it; images arrived as an anonymous heap from a camera or drag-drop; the AI
was asked one flat question per pillar and answered with numbers nobody could pin to a corner.
This build closed all three gaps in dependency order: make the engine testable (it had never
had a unit test), make the AI answer **per corner and per edge with defect coordinates**, give
the app a **flatbed lane** (WIA, the only protocol the repo will speak — see the verified
negatives) with auto-centering and an auto-crop that turns an 11.5 MB holo PNG into a 2.3 MB
JPEG, **persist** reports with content-addressed image bytes, and wrap the capture side in a
guided 12-shot wizard so the same twelve labeled images arrive for every card. The loop is
closed by one nullable column: `grading_submissions.pregrade_id`, which lets the saved-reports
list print *predicted PSA 9 · actual 9* — and the first live card did exactly that.

---

## 1. What already existed (and was good)

The alpha shipped as **one commit, `6deb376`, 2026-06-25** — "grading tool (alpha) and sticker
update". No plan doc, no tests, and it genuinely worked. Everything below was kept.

| Thing | Where | Verdict |
|---|---|---|
| The grading engine: pillar sliders → per-company predicted grade | `grade-rules.js` (classic-script IIFE exporting `GR`, shared by page and server) | Reuse. Gained its first tests this build; two dead branches removed |
| The AI pass: images + context → structured condition estimate | `lib/grader.mjs` `analyzeCard()`, Anthropic + OpenAI providers | Reuse. Schema upgraded to v2, v1 clients still accepted |
| Company config: fees, grade scales, tolerances, `asOf` | `data/grading.config.json` | Reuse as-is. `asOf` 2026-06-24 — refresh deferred, see §12 |
| The page: sliders, camera capture, drag-drop, centering pad | `card-grader.html` | Reuse and extend. The wizard wraps the existing capture paths rather than replacing them |
| The grading pipeline it should have talked to | `grading_submissions` in `lib/db.mjs`, `SUB_COLS` in `lib/inventory.mjs` | Existed the whole time; the alpha never touched it. One column closes the loop |

What the alpha could **not** do, stated plainly because it drove every decision in §2:

- **One-shot and memory-only.** No save, no reopen, no history. Refresh the tab and the
  prediction is gone.
- **No capture discipline.** Images were whatever the operator dragged in, unlabeled. The AI
  could not be asked "what does the back bottom-left corner look like" because nothing knew
  which image showed it.
- **Flat answers.** Schema v1 returned one number per pillar per side. A card with three
  mint corners and one crushed one averaged into a lie.
- **Predictions never met reality.** The whole point of pre-grading is calibration, and there
  was no link to `grading_submissions.result_grade` at all.
- **No scanner.** The Epson V39 II sat next to the dev box unused; captures came from a
  phone camera at whatever angle the operator held it.

---

## 2. Decisions taken

Four owner decisions, taken up front, and each one shaped the build.

| # | Decision | Rationale |
|---|---|---|
| D1 | **A guided 12-shot capture wizard**: `scan-front`, `scan-back`, `mic-corner-front-{tl,tr,bl,br}`, `mic-corner-back-{tl,tr,bl,br}`, `surface-front`, `surface-back` | Labeled slots are what make schema v2 possible: the AI can only answer per-corner if it knows which image *is* that corner. Corners are framed to include the two adjacent **half-edges**, so the four corner shots per side also cover all four edges and no separate edge shots exist. 12 slots, not 20 |
| D2 | **Full persistence** — reports, images, reopen, history | Anything less repeats the alpha's core failure. Calibration (predicted vs actual) requires the prediction to survive until the submission comes back, which is weeks |
| D3 | **Pokémon-first; other games via the manual fields** | Matches every other tool in the repo. The engine and schema are game-agnostic; only the identity pickers are Pokémon-shaped, and a free-text name works today for anything else |
| D4 | **A TAG-style annotated report** — defect pins on the images, a per-corner grid, a /1000 house breakdown that is explicitly **not** TAG's DIG | The pins and the grid are what make a report *readable*: "corner damage, back, bottom-left, here" beats "corners 7.5". The /1000 number is our own arithmetic and the UI labels it a house approximation, because claiming TAG's algorithm would violate GR4 |

---

## 3. The scanner lane — WIA, and only WIA

`scripts/wia-scan.ps1` + `lib/scan.mjs` (`scanConfig`, `makeScanRouter`, `scanPlugin`).

The script is Windows PowerShell 5.1 driving the WIA COM automation layer
(`WIA.DeviceManager` / `WIA.ImageProcess`), spawned as `powershell.exe -NonInteractive` with a
90 s timeout, and its entire contract with Node is **one JSON line on stdout**. Everything
else it prints is noise the router ignores.

The routes:

- `GET /api/scan` — capability. Live WIA device enumeration, cached 60 s, plus
  `analyzeAvailable` (is sharp importable) and a `SCANNER_ENABLED=false` kill switch in `.env`
  so a box with a scanner attached can still refuse to be a scan server. On a machine with no
  scanner (ALCSERVER) the capability is empty and the client hides its scan buttons — no
  config, no per-host branching.
- `POST /api/scan` — `{side, dpi, analyze}`. Runs the script, converts, optionally analyzes
  and crops (§5), returns base64. A module-level busy lock returns **409** while a scan is in
  flight, and temp files are cleaned in `finally`.
- `POST /api/scan/analyze` — the centering analyzer (§4) for **uploaded** images, so the
  auto-detect button works on drag-dropped photos with no scanner anywhere.

WIA quirks, measured against the live Epson Perfection V39 II rather than read in a forum:

| Quirk | Consequence in the script |
|---|---|
| Native transfer format is BMP; asking the device for PNG is not portable | Transfer BMP, then `WIA.ImageProcess` Convert → PNG. Never trust the device to encode |
| The extent properties' `SubTypeMax` **scales with the currently-set DPI** | Set resolution FIRST, then clamp extents against the *re-read* max. Reverse the order and the clamp is against the wrong ceiling |
| `SaveFile` refuses to overwrite | Pre-delete the target path every time |
| `WIA.CommonDialog` exists and is tempting | Never. It is UI; under `-NonInteractive` it is a hang, not a dialog |
| Driver ceiling | 1200 dpi max on the V39 II. 600 dpi at 160×220 mm → 3780×5197 px in ~23 s |

> **Trap:** connect matches mounts by **prefix in registration order** — the same
> `startsWith` trap as the proxy table in `vite.config.js`. Registering `/api/scan` and
> `/api/scan/analyze` as two mounts means `/api/scan` swallows `analyze` unless someone
> remembered to register the longer one first. `makeScanRouter` is therefore **one** mount
> dispatching sub-paths internally: one registration, zero ordering to remember.

> **Trap:** the scan busy lock is per-process state, and it must be. A flatbed is a physical
> exclusive resource; two concurrent `POST /api/scan` calls would interleave COM property sets
> on one device. The second caller gets 409, not a queue — a scan takes up to ~23 s and a
> silent queue looks like a hang. The lock is released in `finally`, including on the 90 s
> timeout path, so a wedged script never bricks the route.

---

## 4. Auto-centering — `lib/scan-centering.mjs`

`analyzeCardImage(buf)`, sharp-based, and it **never throws** — a failed analysis returns
nulls with zero confidence, per GR7, because the scan itself is still perfectly good.

- **Outer edge**: background colour by ring-median of the image border, then row/column
  profiling with run-gating (a sustained run of non-background, not a single noisy pixel),
  sanity-checked against the 63:88 card aspect (`coarseRect` → `refineOuterEdge`).
- **Inner frame** (the printed border, which is what centering is measured against): the
  strongest **sustained** gradient in a window 2–12% inward from the outer edge, measured
  over the central 60% of each edge so art that bleeds to a corner does not vote
  (`innerProfile` → `innerFrame`).
- **Per-edge confidence**, reported honestly. A full-art card has no inner frame; the
  analyzer returns `inner: null` rather than hallucinating one.

**Sleeve findings, from the first real card** (a sleeved Japanese SAR, 117/081, M5, on the
scanner's white lid): the analyzer found it in ~400 ms — but the rectangle it locked measured
**65.6 × 89.7 mm**. That is the *sleeve*, not the 63×88 card. On a white lid the white card
border and the lid are the same colour, so the strongest edge is the sleeve's, and the
analyzer **caps outer confidence at 0.5 by design** in that regime — a white border cannot be
told from a white lid, and pretending otherwise is GR4 territory. The recommended setup is a
**matte-black backing sheet behind the sleeve**: the card edge then out-contrasts the sleeve
and confidence recovers. Sleeved cards are fine; nothing requires de-sleeving.

---

## 5. The crop, and why it leaves as a JPEG

The scan region default is **160×220 mm** (`SCANNER_REGION_W_MM` / `SCANNER_REGION_H_MM`),
deliberately forgiving. The original plan said 110×140 mm — snug around a card — and the very
first live card disproved it: placed by hand, it sat **~35 mm off the corner**, and the snug
window cut it off. Nobody places a card against the flatbed datum corner by feel, so the
region assumes they will not, and the analyzer finds the card wherever it is.

That decision creates the size problem the crop then solves. 160×220 mm at 600 dpi is
3780×5197 px, and a live holographic card came back as an **11.5 MB PNG** — holo foil is
noise to DEFLATE. At 1200 dpi the PNG would blow through the **28 MB request cap** on the
save path all by itself, before base64's +33%. So the scan route crops server-side:

- when `confidence.outer ≥ 0.5`, extract the detected card **+ 12% margin** and re-encode
  **JPEG quality 92** — the same holo scan became **~1.8 MB**, and the first live UI crop was
  1922×2491 at 2.35 MB base64;
- shift `outer`/`inner` analysis coordinates into the crop's frame so the client's centering
  guides land where the card actually is;
- below 0.5 confidence, return the full region untouched — a wrong crop is worse than a big
  image.

> **Trap:** sharp is imported **lazily** (the `getSharp` idiom shared with the compositor) so
> the server boots on a box where the native binding is missing — capability just reports
> `analyzeAvailable: false`. And sharp **does not read BMP**: the PowerShell script must hand
> over PNG (§3's Convert step). Skip the convert and the analyzer fails on every scan while
> the scan route itself looks healthy.

> **Trap:** the 28 MB body cap on the save path is real and a raw flatbed PNG can exceed it
> on its own. The crop is not cosmetic; it is what makes 600–1200 dpi scans *storable*. If a
> future change bypasses the crop (a "keep original" toggle, say), it must confront the cap,
> not discover it in production as a failed save.

---

## 6. The AI pass, schema v2 — `lib/grader.mjs`

Schema v2 exists because D1 exists: once every image has a label, the model can be asked the
granular question.

- **Request**: `images` as `[{id, mediaType, dataB64}]`, hard cap 12; `context.shots` as
  `[{id, label}]` tying each image id to its wizard slot in prose the model can use.
- **Response**: per-side **per-corner** `{tl,tr,bl,br}` and **per-edge**
  `{top,right,bottom,left}` cells; defects carry `{imageRef, x, y}` with x/y as **fractions**
  of the referenced image, which is what makes the report's pins (§9) possible.
- **`normalize()` is dual-shape**: a v1 flat response (one number per pillar per side) is
  still accepted, and when a v2 response arrives the flat aggregates are derived as the
  **MIN** of the granular cells — the worst corner grades the side, matching
  `GR.sideFromCorners` (§8). v1 clients keep working against the upgraded server, unchanged.
- Token budgets, set from live failures rather than guessed: Anthropic `max_tokens` 6000,
  OpenAI `max_completion_tokens` 2048. The granular schema is much wordier than v1; the old
  budget truncated mid-JSON.

Live verification: the first real card ran a full v2 pass on `openai` `gpt-5.6-terra` in
8.3 s and returned granular corners + edges with 67% confidence.

---

## 7. Persistence — `lib/pregrade.mjs`, `lib/pregrade-store.mjs`, `lib/db.mjs`

Two tables plus a byte store, additive migration in the house pattern
(`migratePregrade(db)`, `addColumnIfMissing`):

- `pregrade_reports` — identity fields, the slider state, the AI result, the prediction, the
  guides. `pregrade_images` — one row per shot, `UNIQUE(report_id, shot_id)` so re-shooting a
  slot replaces rather than accumulates, `ON DELETE CASCADE`.
- Image **bytes** are content-addressed in `data/pregrade-images/` (`storePath` / `storePut` /
  `storeLookup` / `storeUrl` in `lib/pregrade-store.mjs`), keyed by sha256. Gitignored and
  **not regenerable** — these are photographs of physical cards, not derivable artifacts.
  Backup coverage is an open decision (§12).
- The pipeline link: `grading_submissions.pregrade_id`
  (`INTEGER REFERENCES pregrade_reports(id) ON DELETE SET NULL`), and `pregrade_id` added to
  `SUB_COLS` in `lib/inventory.mjs` so the real submissions POST/PATCH accepts it.

Routes (`makePregradeRouter`): `POST /api/pregrade` create · `POST /:id/images` — **one image
per request**, because 12 shots in one body is how you meet the 28 MB cap · `GET /` list,
LEFT-JOINing the newest linked submission's `submission_id` and `actual_grade` so the list can
print predicted-vs-actual without a second query · `GET /:id` · `PATCH /:id` · `DELETE /:id`
with a **refcounted** byte unlink (two reports sharing a sha keep the file until the last
reference dies) · `GET /api/pregrade/file/<sha>.<ext>` serving bytes immutable-cacheable,
because a content address never changes meaning.

> **Trap:** the prediction is **never copied into the actual**. `pregrade_reports` holds what
> we guessed; `grading_submissions.result_grade` holds what PSA said; the join displays them
> side by side and nothing anywhere writes one into the other. The moment a prediction can
> become a `result_grade` the calibration data is poisoned and GR4 is violated — the comment
> in `lib/pregrade.mjs` says so at the join site, on purpose.

---

## 8. The engine — `grade-rules.js`

The alpha engine, made honest and made testable, in that order:

- **Two dead branches removed** — condition paths no input could reach. Behavior
  preservation was proved by brute force, not by review: a sweep of **24,975** generated
  inputs through the before and after engines, **0 output diffs**. Only then were the
  branches deleted.
- **`GR.sideFromCorners(c)` / `GR.sideFromEdges(e)`** — the granular aggregators the v2
  schema needed, in the engine rather than the page so server and client share one
  definition. Each returns `{value, mean, count}` where `value` is the **min** (the worst
  corner grades the side — grading companies grade the worst defect, not the average) and
  `mean` is display-only. All-null input returns `null`, never 0 — an unshot corner is
  unknown, not perfect (GR7).
- **The engine's first unit tests**, `test/unit/grade-rules.test.mjs`, table-driven from
  `data/grading.config.json` so a config edit that moves a boundary breaks a test instead of
  silently moving predictions.

---

## 9. The client — `card-grader.html`

The wizard and the report, wrapped around the alpha page rather than replacing it.

**Capture.** Twelve labeled slots in four groups (scans, front corners, back corners,
surfaces) with a current-step highlight, skip, and auto-advance on capture; drag-drop
coexists — the wizard is a guide, not a gate. Scan buttons are capability-gated off
`GET /api/scan` with a dpi picker; on a box with no scanner they simply do not render. The
camera picker remembers a device **per shot kind** in `localStorage` (`grader_cam_by_kind`) —
the Tomlov microscope enumerates as a plain UVC `videoinput`, so corner shots auto-select it
while scan-adjacent shots keep the webcam, with zero special-casing of the device.

**Resolution split.** Stored originals keep up to 2500 px (camera) or native resolution
(scans); the copies sent to the AI are re-downscaled to 1568 px. The report keeps evidence at
full quality; the model gets what it can actually use.

**Centering.** `makePad.setGuides` / `exportGuides` operate in image pixels, with
`pendingGuides` applied on image load so server-detected guides survive the async decode. A
scan with analysis seeds the pad automatically — the first live card seeded 53/47 · 52/48 —
and shows an **"auto — confirm"** badge; any manual drag downgrades the badge to "manual",
honestly. An **Auto-detect** button runs `POST /api/scan/analyze` for uploaded images.

**The report (D4).** Per-corner/per-edge readouts under the sliders; a corner-grid diagram
per side, suppressed when a side has no granular data rather than rendered full of blanks;
defect pins percent-positioned on the annotated images, numbered and severity-coloured, from
the v2 `{imageRef, x, y}` fractions; the /1000 breakdown labeled a **house approximation**
on the page itself.

**Persistence UI.** Save/reopen with a `?report=<id>` deep link; a saved-reports list with
the predicted-vs-actual column; **To pipeline** saves the report first, creates the
submission with `pregrade_id`, and PATCHes the report's status to `sent`. PDF v2 composites
the annotated front/back pages offscreen (JPEG q0.85, ≤1600 px) with a text fallback when an
image will not decode.

> **Trap:** `getUserMedia` requires a **secure context**, so camera capture dies on plain
> `http://` from another machine — which is exactly how ALCSERVER is reached. Server-side
> scanning has no such constraint: `POST /api/scan` is just an HTTP call. The two capture
> lanes therefore fail independently, and neither may assume the other works. The capability
> gate (§3) is what keeps the scan buttons honest; the camera path degrades on its own.

### Verified negatives, recorded so nobody re-investigates

- **No TWAIN, no eSCL, no NAPS2 anywhere in the repo** — checked by grep, not assumed. WIA is
  the only scanner protocol, on purpose.
- **NAPS2 is not installed on the dev box**, so "shell out to NAPS2" was never the cheap
  option it looks like.
- **Epson Scan 2 has no usable CLI.** The vendor app cannot be driven headless.
- **pwsh 7 is untested for WIA COM.** The script pins `powershell.exe` (5.1) and should keep
  doing so until someone proves the COM interop under 7 — nothing is gained by finding out in
  production.

---

## 10. Execution phases — all landed 2026-08-22

Every gate below names the evidence that actually closed it, because "done" claims in a plan
written after the fact are worthless without them.

| Phase / commit | Task | Gate — what proved it |
|---|---|---|
| **1** `f94baa2` | ~~Remove the two dead engine branches~~ **DONE 2026-08-22** | Behavior-preservation sweep: 24,975 generated inputs, before vs after, **0 diffs** |
| **1** `f94baa2` | ~~`GR.sideFromCorners` / `GR.sideFromEdges` (min + mean, all-null → null)~~ **DONE 2026-08-22** | `test/unit/grade-rules.test.mjs` — the engine's first unit tests, table-driven from `grading.config.json` |
| **2** `3693526` | ~~Schema v2: labeled images, per-corner/per-edge cells, defect coordinates, dual-shape `normalize()`, token budgets~~ **DONE 2026-08-22** | Live v2 pass on the real card: `gpt-5.6-terra`, 8.3 s, granular corners+edges returned, 67% confidence; v1 flat shape still normalizes under test |
| **3** `268a549` | ~~`scripts/wia-scan.ps1` + `/api/scan` routes (capability, scan, analyze, busy lock, kill switch)~~ **DONE 2026-08-22** | Epson V39 II live: enumerate + scan under `powershell.exe` 5.1 `-NonInteractive`; timings measured (600 dpi 160×220 mm ~23 s; 110×140 mm 300 dpi ~9 s, 600 dpi ~15.7 s) |
| **3** `268a549` | ~~`lib/scan-centering.mjs` analyzer~~ **DONE 2026-08-22** | Real sleeved JP SAR found in ~400 ms; sleeve-lock and white-lid 0.5 confidence cap observed and documented (§4) |
| **3** `268a549` | ~~Auto-crop + JPEG re-encode + coordinate shift~~ **DONE 2026-08-22** | Live crop 1922×2491, JPEG 2.35 MB b64 (vs 11.5 MB holo PNG); guides seeded 53/47 · 52/48 in the client |
| **4** `05e6107` | ~~Tables, byte store, routes, refcounted delete, `pregrade_id` link~~ **DONE 2026-08-22** | Report #1 saved with byte-stable image round-trip; reopen via `?report=1` identical; delete cleaned bytes; `test/integration/pregrade.integration.test.mjs` covers the link through the **real** inventory router |
| **5** `6ad66bf` | ~~12-shot wizard, per-kind camera memory, resolution split, guides UX, annotated report, saved list, To-pipeline, PDF v2~~ **DONE 2026-08-22** | The full live loop in §11, ending at "predicted PSA 9 · actual 9" in the saved list; PDF generated without error |
| — | ~~`pnpm verify` green across the build~~ **DONE 2026-08-22** | ~3,000 unit/invariant/data tests + 511 integration |

---

## 11. Verification — the live end-to-end run

Recorded as run on the dev box, 2026-08-22, with a real sleeved Japanese SAR (117/081 SAR,
M5) on the Epson Perfection V39 II:

1. **Scan** → the 160×220 mm region at 600 dpi; analyzer found the card in ~400 ms; crop came
   back 1922×2491 as a 2.35 MB base64 JPEG.
2. **Guides** seeded automatically at 53/47 · 52/48 with the **auto — confirm** badge.
3. **AI v2 pass** live: `openai` `gpt-5.6-terra`, 8.3 s, granular corners and edges returned,
   confidence 67%.
4. **Save** → report #1; image bytes round-tripped byte-stable through the content store.
5. **Reopen** via `?report=1` → identical state.
6. **To pipeline** → created a `grading_submissions` row with `pregrade_id=1`.
7. **Result arrives** (simulated by the real PATCH): `result_grade` 9.
8. **Saved list** shows *predicted PSA 9 · actual 9*.
9. **Delete** → the refcounted unlink cleaned the bytes.
10. **PDF** generated without error.

Plus the scanner timings and sleeve findings in §3–§4, and `pnpm verify` green.

---

## 12. Open QA + still to settle

**Same-day addendum (evening).** Owner feedback against a competitor app (Centering50) landed
four more changes, all live-verified: (1) **orientation** — scans auto-rotate to portrait when
the analyzer finds a landscape card (90° is geometry; 180° is not detectable from geometry, so
every filled slot also has a ⟳ rotate button); (2) **mm border readouts** (T/B/L/R in real
millimetres, derived from the scan's dpi) on the pads and in the report, matching the
competitor's presentation; (3) a **full-screen centering editor** (⛶ on each pad) — the card at
viewport size while the guides are confirmed, guides round-trip back to the inline pad on
Done/Esc; (4) **1200 dpi default** (see the struck QA item below); (5) **precision skew
rotation in the full-screen editor** — a ±5° slider in 0.05° steps (buttons and ←/→ keys,
Shift for coarser), live-previewed under the guides and **baked into the shot on Done** (every
consumer — AI pass, pins, PDF, persistence — reads the shot's bytes, so a preview-only
rotation would lie to all of them; rotation is about the image centre so dimensions and
placed guides survive exactly). This answers the competitor's two-handles-per-edge tilted
guides with a different mechanism: straighten the image once instead of tilting four lines.
And (6) **the straightening measures itself**: the analyzer traces each outer edge at 16
stations, least-squares fits a line per edge, and reports the median angle as
`analysis.skewDeg` (visual-CW positive; rotate by −skewDeg to straighten). The scan route
auto-deskews when 0.05° ≤ |skew| ≤ 3.5° and confidence ≥ 0.3, re-analyzes, then crops — so
scans arrive with truly vertical sides, zero clicks. The full-screen editor's ⌖ Auto button
runs the same measurement for uploads/reopened shots and sets the slider for the human to
bake. Proven on the real sleeved SAR scan: +1.401° measured (2 edges agreeing within 0.05°),
corrected to a 0.094° residual, skew confidence rising 0.48 → 0.85 once straight. Median
across edges, not mean, because on a white lid one side can trace the sleeve while the others
trace the card — one liar must not tilt the answer.

Unchecked items — none blocks use, all should be closed deliberately:

- [x] ~~**Tomlov microscope corner shots, live.**~~ **DONE 2026-08-22** — owner ran the full
  wizard in a real browser (the in-app Browser pane hard-blocks `getUserMedia`; that is a pane
  limitation, not a page bug). Corner shots came back tack-sharp at print-rosette level with
  both half-edges in frame, exactly as the no-dedicated-edge-shots design assumed.
- [ ] **The black-backing comparison shot.** White-lid behaviour is verified working with the
  documented caveats (§4); the matte-black-backing setup is recommended from the mechanism,
  not yet from a side-by-side scan.
- [x] ~~**A full 12-shot AI pass** with all eight corner shots populated.~~ **DONE 2026-08-22** —
  report #2: all 12 images restored from the store, one call, ~9s; every granular cell filled
  (no nulls), confidence rose 67% → 76% with full coverage, and one coordinate-pinned defect
  (minor wear, back top edge, `imageRef: scan-back`) rendered as a pin on the annotated report.
- [x] ~~**1200 dpi timing.**~~ **DONE 2026-08-22** — 79–83 s for the 160×220 mm region,
  7559×10394 px. 1200 dpi is now the **default** (owner's call: max quality, storage is not a
  constraint — an S3/cloud dump is the fallback if the store ever grows). The scan timeout went
  90 s → 240 s accordingly, and the no-crop fallback re-encodes the full frame as JPEG q92
  (measured: 96 MB of PNG base64 → 4.6 MB). Note the ceiling is the WIA driver's, not ours:
  the V39 II claims 4800 dpi optical but exposes `SubTypeMax` 1200, and Epson Scan 2's higher
  modes have no CLI.
- [ ] **ALCSERVER post-deploy check.** After the pull: NSSM service restart, then
  `/api/status` for `plugins.stale`, and confirm the scan buttons **hide** (no scanner there —
  the capability gate should do this with zero config; watch it actually happen).

Open decisions:

1. **Backup coverage for `data/pregrade-images/`.** The bytes are gitignored and **not
   regenerable** — they are photographs of cards that may since have been sleeved, slabbed or
   sold. Every other `data/` artifact in the repo can be re-baked; this one cannot. Decide
   what backs it up before it is big enough to hurt.
2. **`data/grading.config.json` fees and tolerances are `asOf` 2026-06-24.** A refresh is a
   research task, deliberately deferred out of this build; predictions are unaffected, cost
   figures drift.
3. **Superseded shot bytes linger** until the last referencing report is deleted — re-shooting
   a wizard slot replaces the row but the old sha stays in the store while any report points
   at it. Documented and harmless at current volume; a sweep script is the answer if it ever
   matters.
4. ~~**Skew-fit guides (two handles per edge).**~~ **Resolved differently, same day** — the
   full-screen editor gained precision rotation (±5°, 0.05° steps, baked into the shot on
   Done), so a skewed scan is straightened once instead of measured with four tilted lines.
   Tilted guides stay off the table unless straightening proves insufficient in practice.
5. **Cloud storage (S3) for the image store.** Owner is happy to organise a bucket when the
   local store gets heavy — at 1200 dpi a full 12-shot report runs ~15–25 MB. Local disk is
   fine today; revisit at the first multi-GB month.
