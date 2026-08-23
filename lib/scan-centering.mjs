// lib/scan-centering.mjs — auto-centering analyzer for flatbed card scans.
//
// analyzeCardImage(buf, {dpi}) locates the card's cut edge (outer) and its printed
// border→artwork boundary (inner) in a platen scan, reported in PIXELS of the supplied image.
// The numbers feed a centering report, so the contract is honesty over coverage:
//   · every rect comes with the evidence that produced it (per-edge confidence);
//   · a full-art card gets inner:null, never a guessed frame;
//   · anything unreadable gets {ok:false,...}, never a throw (Golden Rule 7).
//
// The scene this is tuned for: one card flat on the platen, roughly axis-aligned. The operator
// guide says matte-black backing behind the card — that is what makes the cut edge a step function
// in the intensity profile. A white-lid scan of a white-bordered card has no such step; that comes
// back no_card or capped-confidence, which is the truthful answer, not a failure to be clever.
// Skew under ~3.5° is tolerated AND measured: each edge is traced at several stations and a line
// least-squares-fitted through them; the median across edges becomes analysis.skewDeg (positive =
// card rotated visually clockwise — rotate the image by -skewDeg to straighten). This module still
// never rotates anything itself: correction is the caller's move, measurement is ours.
//
// dpi is optional but it is the difference between a measurement and a ratio. Every gate above is
// SCALE-FREE, and that is a blind spot with a name: a penny sleeve is 66×92mm (aspect 0.7174) and a
// card is 63×88mm (0.7159) — 0.2% apart, deep inside the ±10% the aspect gate allows. A sleeved
// card therefore passes as a card and the analyzer locks the SLEEVE's edge. Both borders on an axis
// then inflate by the same ~1.5mm, and adding a constant to both sides of a ratio drags it toward
// 50/50: a genuine 62/38 card measures ~55/45 and collects a "10-capable" badge it has not earned.
// The error only ever flatters the card, which is the expensive direction. Given dpi the rect has a
// size in millimetres, and 66 is not 63 — see physicalSize().
//
// analyzeScanSheet(buf, {dpi}) is the same pipeline run 4–6 times: the A4 platen holds a handful of
// cards, and to a single-card analyzer that is ONE bounding box spanning all of them, which fails
// the aspect gate as a flat no_card. Segmentation splits the row/column profiles at sustained
// background gaps first, so the aspect gate becomes a per-cell validator instead of a global reject.

// sharp is lazy-imported with the same idiom as lib/listing-image-assets.mjs: a host without the
// native binary must still boot and run the suite, so the import failure becomes a reported
// sharp_unavailable instead of a broken module graph. Deliberately a private copy — this analyzer
// stands alone, with no dependency on the compositor.
let _sharp;
let _sharpError = null;
async function getSharp() {
  if (_sharp !== undefined) return _sharp;
  try { _sharp = (await import('sharp')).default; }
  catch (e) { _sharpError = e?.message || String(e); _sharp = null; }
  return _sharp;
}

const CARD_ASPECT = 63 / 88;    // physical card, portrait — 0.7159
const ASPECT_TOL = 0.10;        // ±10%, either orientation, before a region counts as a card
const MIN_AREA_RATIO = 0.15;    // the card must fill at least this much of the frame
const WORK_WIDTH = 800;         // the coarse pass runs here; edges are re-found at full res after
const FG_DELTA = 20;            // grey levels off the background median that count as "card"
const RUN = 4;                  // consecutive qualifying rows/cols to accept a coarse edge
const INNER_WIN = [0.02, 0.12]; // border search window, as a fraction of the card's 63mm side
const CENTRAL = [0.2, 0.8];     // the stretch of each edge that gets profiled — corners are
                                // rounded and die-cut noise lives there, so they never vote
const MIN_INNER_STEP = 6;       // grey levels: below this a border→art gradient is just noise
const MIN_INNER_SNR = 2.5;      // and below this it does not stand out from its own profile
const MIN_OUTER_STEP = 12;      // below this, full-res refinement did not actually see the edge
const SKEW_STATIONS = 16;       // trace points per edge for the skew fit
const SKEW_BAND = 5;            // scanlines averaged per trace point (denoise without smear)
const SKEW_MAX_DEG = 3.5;       // beyond this the operator repositions the card, we don't measure
const SKEW_MAX_RMS = 6;         // px: a straight cut edge fits better than this; worse = not an edge

const MM_PER_IN = 25.4;
// The four things that turn up on a card scanner, short side × long side in millimetres. Ordered
// for the note only — classification is nearest-neighbour, not first-match.
const SIZE_CLASSES = Object.freeze([
  { match: 'card', wmm: 63, hmm: 88, what: 'a bare 63×88mm card' },
  { match: 'sleeved', wmm: 66, hmm: 92, what: 'a 66×92mm penny sleeve' },
  { match: 'mini', wmm: 59, hmm: 86, what: 'a 59×86mm Japanese/mini card' },
  { match: 'jumbo', wmm: 127, hmm: 178, what: 'a 127×178mm jumbo card' },
]);
// 2.5mm of slack per class. The tightest pair is card↔mini, 4.47mm apart in (short,long) space, so
// the tolerance cannot exceed half that without the two classes overlapping — the real constraint
// on this number is geometry, not taste.
const SIZE_TOL_MM = 2.5;
// …and a nearest-class call is only CONFIDENT when the runner-up is this much further away. Inside
// that band the honest answer is "closest is X, but I would not bet the grade on it".
const SIZE_MARGIN_MM = 1.2;
// A sleeve match caps outer confidence here. Deliberately below the 0.5 the scan route treats as
// "trust these guides": the rect is real, it is just a rectangle around the WRONG object, and no
// amount of edge sharpness fixes that. Finding the card edge inside the sleeve is a different
// detector (two nested near-parallel edges, one of them low-contrast plastic) and is not attempted
// here — a wrong card edge would be indistinguishable from a right one downstream.
const SLEEVED_CONF_CAP = 0.35;

// ---- multi-card sheet segmentation -----------------------------------------------------------
const SHEET_WORK_WIDTH = 1000;  // wider than WORK_WIDTH: a 63mm card on a 210mm platen is ~1/3 the
                                // width of one card in a single-card scan, and the gaps between
                                // cards are what we are trying to see
const SHEET_OCC = 0.03;         // a row/column counts as occupied when this fraction of its
                                // perpendicular extent is foreground. NOT the max×0.5 gate
                                // coarseRect uses: with two cards in one row and one in the next,
                                // half-the-peak sits exactly on the sparser row and flickers
const SHEET_MIN_CARD_MM = 55;   // no card side is shorter than this (the smallest we know is 59mm)
const SHEET_PAD_MM = 4;         // background kept around each cell — the per-cell analyzer reads its
                                // background level off a ring at the cell's own border, so a cell
                                // cropped flush to the card has nothing to compare the card against
const SHEET_FILL = 0.35;        // a candidate cell must actually contain something. Cells come from
                                // the CROSS PRODUCT of row and column bands, so a 2×3 layout with
                                // one empty slot proposes six cells for five cards
const SHEET_MAX_CELLS = 24;     // a platen holds 4–6; past this the profiles are noise, not cards

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const r2 = (x) => Math.round(x * 100) / 100;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

// dpi is optional everywhere and arrives from HTTP bodies, so anything not a positive finite number
// means "unknown", never 0 and never NaN leaking into a division.
function dpiOf(opts) {
  const d = opts && opts.dpi != null ? Number(opts.dpi) : NaN;
  return Number.isFinite(d) && d > 0 ? d : null;
}

function median(values) {
  const s = Array.from(values).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Raw single-channel greyscale pixels, flattened against white first so a transparent PNG scan
// measures the same as its opaque re-save. No .rotate(): coordinates must index the stored pixels
// the caller handed us, EXIF or not — and platen scans do not carry orientation tags anyway.
async function rawGrey(sharp, buf, resizeTo = null) {
  let img = sharp(buf, { failOn: 'none' }).flatten({ background: '#ffffff' }).greyscale();
  if (resizeTo) img = img.resize(resizeTo.width, resizeTo.height, { fit: 'fill' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height, ch: info.channels };
}
const px = (g, x, y) => g.data[(y * g.W + x) * g.ch];

const meanOf = (arr, a, b) => {
  let s = 0, n = 0;
  for (let i = Math.max(0, a); i <= Math.min(arr.length - 1, b); i++) { s += arr[i]; n++; }
  return n ? s / n : 0;
};

// The one profile analyzer both passes share: 3-tap smooth, adjacent differences, strongest
// transition. The smoothing is what "sustained" means mechanically — a single bright scanline
// survives as two opposing spikes at a third of their height, while a real step keeps its full
// magnitude spread over a small plateau whose MIDDLE is the true boundary (so ties resolve to the
// middle index, which is also what makes a clean synthetic edge land exact instead of ±1).
// `step` is the level difference a few pixels either side of the boundary — the honest strength
// measure, immune to a spike that produces a big gradient with no lasting level change.
function transition(profile) {
  const n = profile.length;
  if (n < 3) return null;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    s[i] = (profile[Math.max(0, i - 1)] + profile[i] + profile[Math.min(n - 1, i + 1)]) / 3;
  }
  const g = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) g[i] = s[i + 1] - s[i];
  let peak = 0, at = 0;
  for (let i = 0; i < g.length; i++) if (Math.abs(g[i]) > peak) { peak = Math.abs(g[i]); at = i; }
  if (!(peak > 0)) return { index: 0, peak: 0, step: 0, noise: 0, second: 0 };
  let lo = at, hi = at;
  const near = (i) => Math.abs(g[i]) >= peak * 0.999 && Math.sign(g[i]) === Math.sign(g[at]);
  while (lo - 1 >= 0 && near(lo - 1)) lo--;
  while (hi + 1 < g.length && near(hi + 1)) hi++;
  const index = (lo + hi) >> 1;
  const step = Math.abs(meanOf(s, index + 1, index + 4) - meanOf(s, index - 3, index));
  const rest = [];
  let second = 0;
  for (let i = 0; i < g.length; i++) {
    if (Math.abs(i - index) <= 3) continue;
    const a = Math.abs(g[i]);
    rest.push(a);
    if (a > second) second = a;
  }
  return { index, peak, step, noise: rest.length ? median(rest) : 0, second };
}

// The central CENTRAL stretch of a [a,b) span, clamped to the image.
function centralBand([a, b], limit) {
  const len = b - a;
  const c0 = Math.max(0, a + Math.round(len * CENTRAL[0]));
  const c1 = Math.min(limit, a + Math.round(len * CENTRAL[1]));
  return [c0, c1];
}

// First/last run of RUN consecutive rows/cols over the threshold. The run requirement is the
// noise gate: a dust fleck moves one column's count, not four in a row. Returns [start, end)
// or null. Scanning for the FIRST and LAST run (rather than one contiguous block) is deliberate:
// a card whose dark artwork vanishes into a black backing leaves only its bright border columns
// qualifying, and the card's true extent is still first-run → last-run.
function runSpan(count, threshold) {
  const n = count.length;
  const runAt = (i) => {
    for (let k = 0; k < RUN; k++) if (count[i + k] < threshold) return false;
    return true;
  };
  let first = -1;
  for (let i = 0; i + RUN <= n; i++) if (runAt(i)) { first = i; break; }
  if (first < 0) return null;
  let last = -1;
  for (let i = n - RUN; i >= first; i--) if (runAt(i)) { last = i + RUN; break; }
  return last > first ? [first, last] : null;
}

// Background level from a 2px frame ring (median, because a card pushed against the frame edge puts
// a few of its own pixels in the ring and a mean would drift), then per-row/column counts of pixels
// that differ from it. Split out of coarseRect because the sheet segmenter needs exactly these
// profiles and a different rule for reading them — one measurement, two interpretations.
function bgAndCounts(g) {
  const { W, H } = g;
  const ring = [];
  for (let y = 0; y < H; y++) {
    if (y < 2 || y >= H - 2) { for (let x = 0; x < W; x++) ring.push(px(g, x, y)); }
    else ring.push(px(g, 0, y), px(g, 1, y), px(g, W - 2, y), px(g, W - 1, y));
  }
  const B = median(ring);
  const colCount = new Int32Array(W), rowCount = new Int32Array(H);
  let fg = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.abs(px(g, x, y) - B) > FG_DELTA) { colCount[x]++; rowCount[y]++; fg++; }
    }
  }
  return { B, colCount, rowCount, fg };
}

// Coarse pass at working scale: one bounding box over everything that is not background.
function coarseRect(g) {
  const { W, H } = g;
  const { B, colCount, rowCount, fg } = bgAndCounts(g);
  if (fg < 0.02 * W * H) {
    return { ok: false, message: `nothing in the frame stands out from the background (level ${Math.round(B)}) — blank scan, or a card that matches the lid; matte-black backing is the reliable setup` };
  }
  let maxCol = 0, maxRow = 0;
  for (let x = 0; x < W; x++) if (colCount[x] > maxCol) maxCol = colCount[x];
  for (let y = 0; y < H; y++) if (rowCount[y] > maxRow) maxRow = rowCount[y];
  const xs = runSpan(colCount, Math.max(3, maxCol * 0.5));
  const ys = runSpan(rowCount, Math.max(3, maxRow * 0.5));
  if (!xs || !ys) return { ok: false, message: 'no sustained background→card transition on both axes' };
  return { ok: true, B, l: xs[0], r: xs[1], t: ys[0], b: ys[1] };
}

// Re-find one outer edge at full resolution, in a ±hw window around the coarse estimate, profiling
// only the central stretch of the perpendicular extent. Null means the window held no real step —
// the caller keeps the coarse estimate (a card flush against the frame edge has no window to see).
function refineOuterEdge(g, est, edge, hw) {
  const vertical = edge === 'l' || edge === 'r'; // a vertical edge → profile marches across columns
  const pos0 = est[edge];
  const lo = Math.max(0, pos0 - hw);
  const hi = Math.min(vertical ? g.W : g.H, pos0 + hw + 1);
  if (hi - lo < 3) return null;
  const [b0, b1] = centralBand(vertical ? [est.t, est.b] : [est.l, est.r], vertical ? g.H : g.W);
  if (b1 - b0 < 2) return null;
  const m = new Float64Array(hi - lo);
  for (let i = lo; i < hi; i++) {
    let sum = 0;
    for (let j = b0; j < b1; j++) sum += vertical ? px(g, i, j) : px(g, j, i);
    m[i - lo] = sum / (b1 - b0);
  }
  const tr = transition(m);
  if (!tr || tr.step < MIN_OUTER_STEP) return null;
  return { pos: lo + tr.index + 1, step: tr.step };
}

// Mean-intensity profile marching INWARD from one card edge, depth win0..win1, over the central
// stretch of that edge only. Index i sits at depth win0+i from the cut edge, so a transition
// between i and i+1 puts the border width at win0+i+1 — the same mapping for all four edges.
function innerProfile(g, outer, edge, win0, win1) {
  const n = win1 - win0;
  const horizontalEdge = edge === 't' || edge === 'b'; // profile marches over rows
  const [c0, c1] = horizontalEdge ? centralBand([outer.l, outer.r], g.W) : centralBand([outer.t, outer.b], g.H);
  if (c1 - c0 < 2 || n < 3) return null;
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = win0 + i;
    let line;
    if (edge === 't') line = outer.t + d;
    else if (edge === 'b') line = outer.b - 1 - d;
    else if (edge === 'l') line = outer.l + d;
    else line = outer.r - 1 - d;
    line = Math.max(0, Math.min((horizontalEdge ? g.H : g.W) - 1, line));
    let sum = 0;
    for (let j = c0; j < c1; j++) sum += horizontalEdge ? px(g, j, line) : px(g, line, j);
    m[i] = sum / (c1 - c0);
  }
  return m;
}

// The inner (printed border → artwork) frame. Border widths scale with the card's PHYSICAL width
// — the 63mm side, i.e. the shorter dimension whichever way the card was laid — hence min(w,h).
// Full-art cards have no inner frame at all: when 2+ edges show no credible step, the honest
// answer is null, never a rect assembled from noise.
function innerFrame(g, outer) {
  const cw = Math.min(outer.r - outer.l, outer.b - outer.t);
  const win0 = Math.max(1, Math.round(cw * INNER_WIN[0]));
  const win1 = Math.round(cw * INNER_WIN[1]);
  if (win1 - win0 < 5) return { rect: null, conf: null, weak: ['l', 't', 'r', 'b'] };
  const found = {}, weak = [];
  for (const edge of ['l', 't', 'r', 'b']) {
    const m = innerProfile(g, outer, edge, win0, win1);
    const tr = m ? transition(m) : null;
    if (!tr) { weak.push(edge); continue; }
    const snr = tr.step / Math.max(tr.noise * 3, 0.75);
    const isWeak = tr.step < MIN_INNER_STEP || snr < MIN_INNER_SNR;
    const ambig = tr.peak > 0 ? Math.min(1, tr.second / tr.peak) : 1;
    let conf = clamp01(Math.min(1, tr.step / 40) * Math.min(1, snr / 8) * (1 - 0.6 * ambig));
    if (isWeak) { conf = Math.min(conf, 0.25); weak.push(edge); }
    found[edge] = { bw: win0 + tr.index + 1, conf };
  }
  if (weak.length >= 2 || ['l', 't', 'r', 'b'].some((e) => !found[e])) {
    return { rect: null, conf: null, weak };
  }
  const rect = {
    l: outer.l + found.l.bw, t: outer.t + found.t.bw,
    r: outer.r - found.r.bw, b: outer.b - found.b.bw,
  };
  if (!(rect.r > rect.l && rect.b > rect.t)) return { rect: null, conf: null, weak: ['l', 't', 'r', 'b'] };
  return {
    rect,
    conf: { l: r2(found.l.conf), t: r2(found.t.conf), r: r2(found.r.conf), b: r2(found.b.conf) },
    weak,
  };
}

// Trace one outer edge at SKEW_STATIONS points along its central stretch and least-squares fit
// v = a + b·u through them (u along the edge, v = edge position). The trace window is sized for
// the drift a SKEW_MAX_DEG tilt produces over the span — narrower would clip the very tilt we
// are measuring. Sign convention (y-down screen coords, visual clockwise positive): a vertical
// edge under CW rotation has dx/dy = −sinθ, a horizontal edge dy/dx = +sinθ.
function traceEdgeAngle(g, outer, edge) {
  const vertical = edge === 'l' || edge === 'r';
  const [c0, c1] = centralBand(vertical ? [outer.t, outer.b] : [outer.l, outer.r], vertical ? g.H : g.W);
  const span = c1 - c0;
  if (span < 40) return null;
  const pos0 = outer[edge];
  const drift = Math.tan(SKEW_MAX_DEG * Math.PI / 180) * span / 2;
  const hw = Math.max(14, Math.round(drift + 10));
  const lo = Math.max(0, pos0 - hw), hi = Math.min(vertical ? g.W : g.H, pos0 + hw + 1);
  if (hi - lo < 8) return null;
  const pts = [];
  for (let s = 0; s < SKEW_STATIONS; s++) {
    const c = Math.round(c0 + (s + 0.5) * span / SKEW_STATIONS);
    const b0 = Math.max(0, c - (SKEW_BAND >> 1));
    const b1 = Math.min(vertical ? g.H : g.W, b0 + SKEW_BAND);
    if (b1 - b0 < 2) continue;
    const m = new Float64Array(hi - lo);
    for (let i = lo; i < hi; i++) {
      let sum = 0;
      for (let j = b0; j < b1; j++) sum += vertical ? px(g, i, j) : px(g, j, i);
      m[i - lo] = sum / (b1 - b0);
    }
    const tr = transition(m);
    if (!tr || tr.step < MIN_OUTER_STEP) continue;
    pts.push({ u: c, v: lo + tr.index + 1 });
  }
  if (pts.length < Math.max(6, SKEW_STATIONS / 2)) return null;
  let su = 0, sv = 0, suu = 0, suv = 0;
  const n = pts.length;
  for (const p of pts) { su += p.u; sv += p.v; suu += p.u * p.u; suv += p.u * p.v; }
  const denom = n * suu - su * su;
  if (!(denom > 0)) return null;
  const b = (n * suv - su * sv) / denom;
  const a = (sv - b * su) / n;
  let rss = 0;
  for (const p of pts) { const e = p.v - (a + b * p.u); rss += e * e; }
  const rms = Math.sqrt(rss / n);
  if (rms > SKEW_MAX_RMS) return null;
  const deg = (vertical ? -1 : 1) * Math.atan(b) * 180 / Math.PI;
  if (Math.abs(deg) > SKEW_MAX_DEG + 0.5) return null;
  return { deg, span, rms, n };
}

// Median across the edges that produced a credible line — median, not mean, because on a white
// lid one side can trace the SLEEVE while the others trace the card, and one liar must not tilt
// the answer. Agreement across edges is the confidence.
function estimateSkew(g, outer) {
  const est = [];
  for (const edge of ['l', 't', 'r', 'b']) {
    const t = traceEdgeAngle(g, outer, edge);
    if (t) est.push(t);
  }
  if (est.length < 2) return null;
  const degs = est.map((e) => e.deg).sort((a, b) => a - b);
  const spread = degs[degs.length - 1] - degs[0];
  let deg;
  if (spread > 0.4) {
    const m = degs.length >> 1;
    deg = degs.length % 2 ? degs[m] : (degs[m - 1] + degs[m]) / 2;
  } else {
    let ws = 0, wd = 0;
    for (const e of est) { const w = e.span / Math.max(1, e.rms); ws += w; wd += w * e.deg; }
    deg = wd / ws;
  }
  return {
    deg: Math.round(deg * 1000) / 1000,
    conf: r2(clamp01((est.length / 4) * (1 - Math.min(1, spread / 1.5)))),
    edges: est.length,
    spread: Math.round(spread * 1000) / 1000,
  };
}

// Nearest known card size to the detected rect, in millimetres. Orientation is normalised (short
// side vs long side) because a card laid sideways is still a card; the reported wmm/hmm stay as
// measured so the caller can see which way round it was scanned.
//
// Euclidean nearest-neighbour rather than a per-class box test: the classes are only 4.5mm apart at
// the tightest, so a box test would have to be narrow enough to reject the real world. The live
// sleeved SAR measured 65.6×89.7mm — 3.1mm from a card, 2.3mm from a sleeve, inside NEITHER box but
// unambiguously nearer the sleeve. Nearest-neighbour gets that right and `confident:false` says the
// margin was thin, which is the whole truth rather than half of it.
function physicalSize(cardPx, dpi) {
  if (!dpi) return null;
  const wmm = cardPx.w / dpi * MM_PER_IN;
  const hmm = cardPx.h / dpi * MM_PER_IN;
  const shortMm = Math.min(wmm, hmm), longMm = Math.max(wmm, hmm);
  let best = null, second = Infinity;
  for (const c of SIZE_CLASSES) {
    const d = Math.hypot(shortMm - c.wmm, longMm - c.hmm);
    if (!best || d < best.d) { if (best) second = best.d; best = { ...c, d }; }
    else if (d < second) second = d;
  }
  const near = best.d <= SIZE_TOL_MM;
  return {
    wmm: r2(wmm),
    hmm: r2(hmm),
    match: near ? best.match : 'unknown',
    confident: near && (second - best.d) >= SIZE_MARGIN_MM,
    deltaMm: r2(best.d),
    nearest: best.match,          // what it was closest to even when that was not close enough
    expect: near ? { wmm: best.wmm, hmm: best.hmm } : null,
    what: near ? best.what : null,
  };
}

// The sentence that has to survive being read by someone about to pay a grading fee.
function physicalNote(p, dpi) {
  const at = `${p.wmm.toFixed(1)}×${p.hmm.toFixed(1)}mm at ${Math.round(dpi)}dpi`;
  if (p.match === 'sleeved') {
    return `physical size ${at} — that is a PENNY SLEEVE (66×92), not the 63×88 card inside it. `
      + 'The edge locked here is the sleeve\'s, so both borders on each axis are inflated by the same '
      + `~1.5mm and the centering split reads closer to 50/50 than the card really is. Outer confidence `
      + `capped at ${SLEEVED_CONF_CAP} — rescan de-sleeved, or place the guides by hand. The card edge `
      + 'inside the sleeve is NOT inferred here: guessing it would be indistinguishable downstream from '
      + 'measuring it';
  }
  if (p.match === 'unknown') {
    return `physical size ${at} — matches no size we know within ${SIZE_TOL_MM}mm `
      + `(63×88 card, 66×92 sleeved, 59×86 Japanese, 127×178 jumbo; nearest was ${p.nearest} by `
      + `${p.deltaMm}mm). Either the dpi is wrong or the locked edge is not a card's`;
  }
  const hedge = p.confident ? '' : ` (only ${p.deltaMm}mm from it, and the runner-up is close — treat the class as a hint)`;
  if (p.match === 'card') return `physical size ${at} — ${p.what}${hedge}`;
  if (p.match === 'mini') return `physical size ${at} — ${p.what}${hedge}; the centering percentages hold, but the mm readouts are against a smaller card than the 63×88 default`;
  // 127×178 is within 1mm of exactly twice 63×88, and no measurement can tell a jumbo from a
  // standard card scanned at double the dpi we were told — the pixels are identical. Say so here
  // rather than let a confident "jumbo" stand in for a dpi that was never checked.
  if (p.match === 'jumbo') return `physical size ${at} — ${p.what}${hedge}; note a jumbo is within 1mm of TWICE a standard card, so an ordinary card measured at half its real dpi lands here too — confirm the dpi before believing it`;
  return `physical size ${at} — ${p.what}${hedge}`;
}

async function analyze(sharp, buf, dpi) {
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const fullW = meta.width | 0, fullH = meta.height | 0;
  if (!fullW || !fullH) return { ok: false, error: 'analyze_failed', message: 'could not read the image dimensions' };
  if (fullW < 40 || fullH < 40) {
    return { ok: false, error: 'no_card', message: `image is ${fullW}x${fullH}px — too small to hold a measurable card` };
  }

  // Coarse pass at ~WORK_WIDTH for speed; the blank-scan reject happens here without ever paying
  // for a full-resolution decode.
  const scale = Math.min(1, WORK_WIDTH / fullW);
  const work = await rawGrey(sharp, buf, scale < 1
    ? { width: Math.max(1, Math.round(fullW * scale)), height: Math.max(1, Math.round(fullH * scale)) }
    : null);
  const coarse = coarseRect(work);
  if (!coarse.ok) return { ok: false, error: 'no_card', message: coarse.message };

  const est = {
    l: Math.max(0, Math.min(fullW, Math.round(coarse.l / scale))),
    t: Math.max(0, Math.min(fullH, Math.round(coarse.t / scale))),
    r: Math.max(0, Math.min(fullW, Math.round(coarse.r / scale))),
    b: Math.max(0, Math.min(fullH, Math.round(coarse.b / scale))),
  };
  const estW = est.r - est.l, estH = est.b - est.t;
  if (estW < 4 || estH < 4) return { ok: false, error: 'no_card', message: 'the detected region collapsed to a sliver' };
  const portrait = Math.min(estW, estH) / Math.max(estW, estH);
  const aspectFit = Math.abs(portrait / CARD_ASPECT - 1);
  if (aspectFit > ASPECT_TOL) {
    return { ok: false, error: 'no_card', message: `found a ${estW}x${estH}px region but its aspect ${portrait.toFixed(3)} is not card-shaped (63:88 ±10%, either orientation)` };
  }
  if ((estW * estH) / (fullW * fullH) < MIN_AREA_RATIO) {
    return { ok: false, error: 'no_card', message: `found a card-shaped region but it fills under ${Math.round(MIN_AREA_RATIO * 100)}% of the frame — scan closer, or this is not the card` };
  }

  // Full-res greyscale, fetched ONCE — every refinement strip and inner profile reads this buffer,
  // where six separate sharp extract() calls would decode the source six times over.
  const full = scale < 1 ? await rawGrey(sharp, buf) : work;

  const hw = Math.max(6, Math.round(4 / scale));
  const outer = { ...est };
  const steps = [];
  let refined = 0;
  for (const edge of ['l', 't', 'r', 'b']) {
    const r = refineOuterEdge(full, est, edge, hw);
    if (r) { outer[edge] = r.pos; steps.push(r.step); refined++; }
  }
  if (!(outer.r - outer.l > 0 && outer.b - outer.t > 0)) Object.assign(outer, est); // refinement can never invert a sane rect, but degrade if it did

  const cardPx = { w: outer.r - outer.l, h: outer.b - outer.t };
  const fit = Math.abs(Math.min(cardPx.w, cardPx.h) / Math.max(cardPx.w, cardPx.h) / CARD_ASPECT - 1);
  const aspectScore = clamp01(1 - fit / ASPECT_TOL);
  const stepScore = steps.length ? clamp01(Math.min(...steps) / 50) : 0.3;
  let outerConf = clamp01(0.6 * stepScore + 0.4 * aspectScore);
  // A light background cannot vouch for a white card border — the edge we found might be the
  // artwork's, one border-width inside the truth. Cap rather than reject: the operator note says
  // why, and a dark-bordered card on a white lid is still perfectly usable.
  const lightBg = coarse.B > 200;
  if (lightBg) outerConf = Math.min(outerConf, 0.5);

  // The size check is the ONLY thing here that can tell a card from the sleeve around it, because
  // every other signal in this file is a ratio and a sleeve has a card's ratio. It runs last so it
  // measures the refined rect, and it caps rather than rejects: the scan is fine, the crop is fine,
  // only the centering numbers are measuring the wrong rectangle.
  const physical = physicalSize(cardPx, dpi);
  if (physical && physical.match === 'sleeved') outerConf = Math.min(outerConf, SLEEVED_CONF_CAP);

  const inner = innerFrame(full, outer);
  const skew = estimateSkew(full, outer);

  const tone = coarse.B < 80 ? 'dark' : coarse.B > 180 ? 'light' : 'mid-grey';
  const parts = [`card ${cardPx.w}x${cardPx.h}px on a ${tone} background (level ${Math.round(coarse.B)})`];
  if (refined < 4) parts.push(`outer edge sharp on ${refined}/4 sides (the rest kept the coarse estimate — card flush with the frame edge, or a soft edge)`);
  if (inner.rect) {
    parts.push(inner.weak.length
      ? `inner frame found (weak on ${inner.weak.join(', ')})`
      : 'inner frame found on all 4 edges');
  } else {
    parts.push(`no credible inner frame on ${Math.max(inner.weak.length, 2)} of 4 edges — full-art/borderless card, centering only measurable against the cut edge`);
  }
  if (lightBg) parts.push('light background: a white border cannot be told from a white lid, confidence capped');
  parts.push(physical
    ? physicalNote(physical, dpi)
    : 'physical size unchecked (no dpi supplied) — aspect alone cannot tell a 63×88 card from the 66×92 sleeve around it, and a sleeve measured as the card biases centering toward 50/50');
  parts.push(skew
    ? `skew ${skew.deg >= 0 ? '+' : ''}${skew.deg.toFixed(2)}° measured from ${skew.edges} edges (spread ${skew.spread.toFixed(2)}°) — not corrected here, the caller rotates`
    : 'skew unmeasurable (edges too short or too noisy to fit a line)');

  return {
    ok: true,
    analysis: {
      outer,
      inner: inner.rect,
      confidence: { outer: r2(outerConf), inner: inner.conf },
      cardPx,
      physical,                            // null when no dpi was supplied — never a guess at scale
      skewDeg: skew ? skew.deg : null,     // visual-clockwise positive; rotate by -skewDeg to straighten
      skewConf: skew ? skew.conf : null,
      bgLevel: Math.round(coarse.B),       // rotation fill colour for whoever does the correcting
      note: parts.join('; '),
    },
  };
}

/**
 * Analyze one flatbed card scan for centering.
 * @param {Buffer|Uint8Array} buf PNG or JPEG bytes.
 * @param {{dpi?:number}} [opts] Scan resolution. Optional because uploads do not have one; supply
 *   it whenever it is known (the scan route always is) — it is the only signal that separates a
 *   card from the sleeve around it, and without it `analysis.physical` is null rather than assumed.
 * @returns {Promise<
 *   { ok:true, analysis:{ outer:{l,t,r,b}, inner:{l,t,r,b}|null,
 *     confidence:{ outer:number, inner:{l,t,r,b}|null }, cardPx:{w,h},
 *     physical:{ wmm:number, hmm:number, match:'card'|'sleeved'|'mini'|'jumbo'|'unknown',
 *                confident:boolean, deltaMm:number, nearest:string,
 *                expect:{wmm,hmm}|null, what:string|null }|null,
 *     skewDeg:number|null, skewConf:number|null, bgLevel:number, note:string } }
 *   | { ok:false, error:'sharp_unavailable'|'no_card'|'analyze_failed', message:string }>}
 * All coordinates are pixels in the supplied image; l/t/r/b are the rect's edges (r and b
 * exclusive, so r-l is the width). NEVER throws and never rejects.
 */
export async function analyzeCardImage(buf, opts = {}) {
  const sharp = await getSharp();
  if (!sharp) return { ok: false, error: 'sharp_unavailable', message: _sharpError || 'sharp failed to load' };
  try {
    return await analyze(sharp, buf, dpiOf(opts));
  } catch (e) {
    return { ok: false, error: 'analyze_failed', message: e?.message || String(e) };
  }
}

// ================================================================================================
// Multi-card sheets
// ================================================================================================

// Runs of "occupied" along one axis. Occupancy is an absolute fraction of the perpendicular extent,
// not a fraction of the peak: on a sheet the peak is set by the busiest row, so a row holding one
// card where another holds two sits at exactly half the peak — right on coarseRect's threshold,
// where a pixel of noise decides whether that card exists.
function occupiedBands(count, perp, minRun) {
  const thr = Math.max(4, Math.round(perp * SHEET_OCC));
  const bands = [];
  let start = -1;
  for (let i = 0; i < count.length; i++) {
    if (count[i] >= thr) { if (start < 0) start = i; continue; }
    if (start >= 0 && i - start >= minRun) bands.push({ a: start, b: i });
    start = -1;
  }
  if (start >= 0 && count.length - start >= minRun) bands.push({ a: start, b: count.length });
  return bands;
}

// A printed white border against a white lid reads as background, so ONE card can arrive as three
// bands — border, artwork, border — and splitting there would saw a card into strips. A band too
// small to be a card side is therefore evidence of an internal dip, not of a card boundary: fold it
// into the neighbour across the smaller gap and re-check. This is the step that lets the occupancy
// threshold stay aggressive; without it the threshold would have to be tuned per backing colour.
function mergeUndersized(bands, minLen) {
  const out = bands.map((b) => ({ ...b }));
  while (out.length > 1) {
    let idx = -1, len = Infinity;
    for (let i = 0; i < out.length; i++) {
      const l = out[i].b - out[i].a;
      if (l < minLen && l < len) { len = l; idx = i; }
    }
    if (idx < 0) break;
    const gapPrev = idx > 0 ? out[idx].a - out[idx - 1].b : Infinity;
    const gapNext = idx < out.length - 1 ? out[idx + 1].a - out[idx].b : Infinity;
    const into = gapPrev <= gapNext ? idx - 1 : idx + 1;
    out[Math.min(idx, into)] = { a: Math.min(out[idx].a, out[into].a), b: Math.max(out[idx].b, out[into].b) };
    out.splice(Math.max(idx, into), 1);
  }
  return out.filter((b) => b.b - b.a >= minLen);
}

// Grow a band into the background beside it: half of an interior gap (so two neighbours split it
// and neither steals the other's edge), and up to the full pad at the outside. The pad is not
// cosmetic — the per-cell analyzer reads its background level from a ring at the cell border, so a
// cell cropped flush to the card measures the card as its own background and finds nothing.
function padBands(bands, limit, pad) {
  return bands.map((b, i) => {
    const before = b.a - (i > 0 ? bands[i - 1].b : 0);
    const after = (i < bands.length - 1 ? bands[i + 1].a : limit) - b.b;
    const lo = b.a - Math.min(pad, Math.max(0, i > 0 ? Math.floor(before / 2) : before));
    const hi = b.b + Math.min(pad, Math.max(0, i < bands.length - 1 ? Math.floor(after / 2) : after));
    return { a: Math.max(0, lo), b: Math.min(limit, hi) };
  });
}

async function segment(sharp, buf, dpi) {
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const fullW = meta.width | 0, fullH = meta.height | 0;
  if (!fullW || !fullH) return { ok: false, error: 'analyze_failed', message: 'could not read the image dimensions' };
  if (fullW < 80 || fullH < 80) {
    return { ok: false, error: 'no_card', message: `image is ${fullW}x${fullH}px — too small to hold a sheet of cards` };
  }

  const scale = Math.min(1, SHEET_WORK_WIDTH / fullW);
  const g = await rawGrey(sharp, buf, scale < 1
    ? { width: Math.max(1, Math.round(fullW * scale)), height: Math.max(1, Math.round(fullH * scale)) }
    : null);
  const { B, colCount, rowCount, fg } = bgAndCounts(g);
  if (fg < 0.01 * g.W * g.H) {
    return { ok: false, error: 'no_card', message: `nothing in the frame stands out from the background (level ${Math.round(B)}) — empty platen, or cards that match the lid; matte-black backing is the reliable setup` };
  }

  // Minimum band length: with dpi it is a physical fact (55mm, under the smallest card we know).
  // Without dpi the only scale available is the sheet's own content, so half the widest band stands
  // in for it — right for a sheet of same-size cards, which is what a platen holds.
  const pxPerMm = dpi ? (dpi / MM_PER_IN) * scale : null;
  const longest = (bands) => bands.reduce((m, b) => Math.max(m, b.b - b.a), 0);
  const minLenFor = (bands) => (pxPerMm
    ? Math.max(8, Math.round(SHEET_MIN_CARD_MM * pxPerMm))
    : Math.max(8, Math.round(0.5 * longest(bands))));

  const rawCols = occupiedBands(colCount, g.H, RUN);
  const rawRows = occupiedBands(rowCount, g.W, RUN);
  const cols = mergeUndersized(rawCols, minLenFor(rawCols));
  const rows = mergeUndersized(rawRows, minLenFor(rawRows));
  if (!cols.length || !rows.length) {
    return { ok: false, error: 'no_card', message: 'no card-sized band survived on both axes — one card, overlapping cards, or noise' };
  }
  if (cols.length * rows.length > SHEET_MAX_CELLS) {
    return { ok: false, error: 'no_card', message: `${cols.length}×${rows.length} bands is more than a platen holds — the profiles are reading noise, not cards` };
  }

  const pad = pxPerMm ? Math.max(2, Math.round(SHEET_PAD_MM * pxPerMm)) : Math.max(2, Math.round(0.015 * g.W));
  const padCols = padBands(cols, g.W, pad);
  const padRows = padBands(rows, g.H, pad);

  // Cells are the cross product, so an L-shaped or gappy layout proposes cells that hold nothing.
  // Fill ratio over the ORIGINAL (unpadded) band intersection throws those out before anyone pays
  // for a full-resolution extract.
  const cells = [];
  let phantom = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    for (let ci = 0; ci < cols.length; ci++) {
      const c = cols[ci], r = rows[ri];
      let hits = 0;
      for (let y = r.a; y < r.b; y++) {
        for (let x = c.a; x < c.b; x++) if (Math.abs(px(g, x, y) - B) > FG_DELTA) hits++;
      }
      const area = Math.max(1, (c.b - c.a) * (r.b - r.a));
      if (hits / area < SHEET_FILL) { phantom++; continue; }
      const pc = padCols[ci], pr = padRows[ri];
      cells.push({
        index: cells.length,
        row: ri,
        col: ci,
        fill: r2(hits / area),
        rect: {
          l: clampInt(pc.a / scale, 0, fullW),
          t: clampInt(pr.a / scale, 0, fullH),
          r: clampInt(pc.b / scale, 0, fullW),
          b: clampInt(pr.b / scale, 0, fullH),
        },
      });
    }
  }
  // Cross-product order is already row-major, and rows/cols came out of a left-to-right scan of the
  // profiles, so left-to-right then top-to-bottom is the order the loop produced. Sorted anyway:
  // the ordering is part of the contract and should not depend on a loop's nesting surviving edits.
  cells.sort((x, y) => (x.row - y.row) || (x.col - y.col));
  cells.forEach((c, i) => { c.index = i; });

  if (!cells.length) {
    return { ok: false, error: 'no_card', message: `found ${cols.length}×${rows.length} bands but none of the ${cols.length * rows.length} cells was more than ${Math.round(SHEET_FILL * 100)}% filled` };
  }
  return {
    ok: true,
    cells,
    grid: { cols: cols.length, rows: rows.length, phantom },
    bgLevel: Math.round(B),
    note: `${cells.length} candidate cell${cells.length === 1 ? '' : 's'} in a ${cols.length}×${rows.length} band grid on a background of level ${Math.round(B)}`
      + (phantom ? `; ${phantom} empty cell${phantom === 1 ? '' : 's'} in the grid ignored` : '')
      + (pxPerMm ? '' : '; no dpi — band sizing fell back to the sheet\'s own proportions'),
  };
}

/**
 * Split a full-platen scan into candidate card cells. Geometry only — no per-card analysis, so a
 * caller that needs the bytes anyway (the scan route, which crops each card out) can extract each
 * cell once instead of once for segmentation and again for the crop.
 * @param {Buffer|Uint8Array} buf PNG or JPEG bytes of the whole platen.
 * @param {{dpi?:number}} [opts]
 * @returns {Promise<{ ok:true, cells:Array<{index,row,col,fill,rect:{l,t,r,b}}>,
 *   grid:{cols,rows,phantom}, bgLevel:number, note:string }
 *   | { ok:false, error:'sharp_unavailable'|'no_card'|'analyze_failed', message:string }>}
 * Rects are pixels in the supplied image and already include a margin of background. NEVER throws.
 */
export async function segmentSheet(buf, opts = {}) {
  const sharp = await getSharp();
  if (!sharp) return { ok: false, error: 'sharp_unavailable', message: _sharpError || 'sharp failed to load' };
  try {
    return await segment(sharp, buf, dpiOf(opts));
  } catch (e) {
    return { ok: false, error: 'analyze_failed', message: e?.message || String(e) };
  }
}

/**
 * Cut one cell out of a sheet as PNG bytes, ready for analyzeCardImage. PNG because the analyzer
 * pins 1px transitions and JPEG ringing smears exactly those.
 * @returns {Promise<Buffer|null>} null when sharp is missing or the rect is unusable — the caller
 *   drops that cell rather than analyzing something that is not there.
 */
export async function extractCell(buf, rect) {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    const l = clampInt(rect.l, 0, meta.width), t = clampInt(rect.t, 0, meta.height);
    const r = clampInt(rect.r, 0, meta.width), b = clampInt(rect.b, 0, meta.height);
    if (r - l < 40 || b - t < 40) return null;
    return await sharp(buf, { failOn: 'none' }).extract({ left: l, top: t, width: r - l, height: b - t }).png().toBuffer();
  } catch { return null; }
}

/**
 * Analyze a full-platen scan holding several cards.
 *
 * Segment first, then run the ordinary single-card pipeline inside each cell. That inversion is the
 * whole point: as a global gate, the 63:88 aspect check rejects a sheet outright (four cards in one
 * bounding box are not card-shaped) and the operator gets a bare `no_card` for a perfectly good
 * scan. As a per-cell check it does the job it was written for — deciding, one region at a time,
 * whether this is a card. Cells that fail are dropped and counted in the note.
 *
 * @param {Buffer|Uint8Array} buf PNG or JPEG bytes of the whole platen.
 * @param {{dpi?:number}} [opts]
 * @returns {Promise<{ ok:true, cards:Array<{index,rect:{l,t,r,b},analysis}>, grid, note:string }
 *   | { ok:false, error:'sharp_unavailable'|'no_card'|'analyze_failed', message:string }>}
 * Cards come back left-to-right, top-to-bottom. Each `analysis` is in the coordinates of ITS OWN
 * cell, not of the sheet — `rect` is the mapping back (add rect.l/rect.t). Callers crop to the cell
 * and hand the client that crop, so cell coordinates are the ones that stay valid; sheet
 * coordinates would need shifting again by every consumer. NEVER throws.
 */
export async function analyzeScanSheet(buf, opts = {}) {
  const dpi = dpiOf(opts);
  const seg = await segmentSheet(buf, opts);

  // One cell is not a sheet. Analyze the cell anyway rather than the whole platen: a single card on
  // A4 fills ~9% of the frame and the single-card path's own MIN_AREA_RATIO would reject it. If the
  // cell fails too, the untouched whole-image path gets the last word — that is the "nothing
  // regresses" fallback, and it is second because it is the one that cannot see a small card.
  if (!seg.ok || seg.cells.length < 2) {
    if (seg.ok && seg.cells.length === 1) {
      const cellBuf = await extractCell(buf, seg.cells[0].rect);
      if (cellBuf) {
        const a = await analyzeCardImage(cellBuf, { dpi });
        if (a.ok) {
          return {
            ok: true,
            cards: [{ index: 0, rect: seg.cells[0].rect, analysis: a.analysis }],
            grid: seg.grid,
            note: `one card on the sheet — ${seg.note}`,
          };
        }
      }
    }
    const whole = await analyzeCardImage(buf, { dpi });
    if (!whole.ok) return whole;
    // rect is always "the region the analysis coordinates are relative to", and on this path that
    // is the whole frame — anything narrower would silently invite a caller to shift twice.
    let frame = { l: 0, t: 0, r: whole.analysis.outer.r, b: whole.analysis.outer.b };
    try {
      const sharp = await getSharp();
      const meta = await sharp(buf, { failOn: 'none' }).metadata();
      frame = { l: 0, t: 0, r: meta.width | 0, b: meta.height | 0 };
    } catch { /* the outer rect is a safe understatement of the frame */ }
    return {
      ok: true,
      cards: [{ index: 0, rect: frame, analysis: whole.analysis }],
      grid: seg.ok ? seg.grid : { cols: 1, rows: 1, phantom: 0 },
      note: 'segmentation found fewer than two cells — fell back to the single-card path over the whole frame',
    };
  }

  const cards = [];
  const rejected = [];
  for (const cell of seg.cells) {
    const cellBuf = await extractCell(buf, cell.rect);
    if (!cellBuf) { rejected.push(`cell ${cell.row + 1},${cell.col + 1}: could not be extracted`); continue; }
    const a = await analyzeCardImage(cellBuf, { dpi });
    if (!a.ok) { rejected.push(`cell ${cell.row + 1},${cell.col + 1}: ${a.message}`); continue; }
    cards.push({ index: cards.length, rect: cell.rect, analysis: a.analysis });
  }
  if (!cards.length) {
    return {
      ok: false,
      error: 'no_card',
      message: `segmented ${seg.cells.length} cells but none held a card — ${rejected[0] || 'every cell failed'}`,
    };
  }
  return {
    ok: true,
    cards,
    grid: seg.grid,
    note: `${cards.length} card${cards.length === 1 ? '' : 's'} from ${seg.note}`
      + (rejected.length ? `; ${rejected.length} cell${rejected.length === 1 ? '' : 's'} rejected by the per-cell card check (${rejected[0]})` : ''),
  };
}
