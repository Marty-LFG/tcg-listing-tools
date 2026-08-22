// lib/scan-centering.mjs — auto-centering analyzer for flatbed card scans.
//
// One exported call: analyzeCardImage(buf) locates the card's cut edge (outer) and its printed
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
// Skew under ~3° is tolerated but NOT corrected: profiles blur a little and confidence drops,
// which is the right signal — silently rotating would move the very edges this module reports.

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

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const r2 = (x) => Math.round(x * 100) / 100;

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

// Coarse pass at working scale: background level from a 2px frame ring (median, because a card
// pushed against the frame edge puts a few of its own pixels in the ring and a mean would drift),
// then per-row/column counts of pixels that differ from it.
function coarseRect(g) {
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

async function analyze(sharp, buf) {
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

  const inner = innerFrame(full, outer);

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
  parts.push('skew not corrected (assumes the card sits within ~3° of square)');

  return {
    ok: true,
    analysis: {
      outer,
      inner: inner.rect,
      confidence: { outer: r2(outerConf), inner: inner.conf },
      cardPx,
      note: parts.join('; '),
    },
  };
}

/**
 * Analyze one flatbed card scan for centering.
 * @param {Buffer|Uint8Array} buf PNG or JPEG bytes.
 * @returns {Promise<
 *   { ok:true, analysis:{ outer:{l,t,r,b}, inner:{l,t,r,b}|null,
 *     confidence:{ outer:number, inner:{l,t,r,b}|null }, cardPx:{w,h}, note:string } }
 *   | { ok:false, error:'sharp_unavailable'|'no_card'|'analyze_failed', message:string }>}
 * All coordinates are pixels in the supplied image; l/t/r/b are the rect's edges (r and b
 * exclusive, so r-l is the width). NEVER throws and never rejects.
 */
export async function analyzeCardImage(buf) {
  const sharp = await getSharp();
  if (!sharp) return { ok: false, error: 'sharp_unavailable', message: _sharpError || 'sharp failed to load' };
  try {
    return await analyze(sharp, buf);
  } catch (e) {
    return { ok: false, error: 'analyze_failed', message: e?.message || String(e) };
  }
}
