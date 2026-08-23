// test/unit/scan-centering.test.mjs — the flatbed-scan centering analyzer (lib/scan-centering.mjs).
//
// Every fixture is generated WITH sharp at runtime — no binary fixtures in git. That works here
// because nothing about a scan needs metadata that sharp's own encoder cannot write (unlike the
// EXIF-orientation fixture the compositor tests keep on disk). PNG throughout: JPEG ringing would
// smear the very 1px transitions whose positions these tests pin.
//
// The one promise tested WITHOUT sharp: analyzeCardImage never rejects. Every call goes through
// callAnalyze(), which fails the test on a throw — Golden Rule 7 is the contract, not a hope.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCardImage, analyzeScanSheet, segmentSheet } from '../../lib/scan-centering.mjs';
import { sharpOrNull } from '../helpers/image-diff.mjs';

const sharp = await sharpOrNull();

async function callAnalyze(input, opts) {
  try { return await analyzeCardImage(input, opts); }
  catch (e) { assert.fail(`analyzeCardImage rejected — it must never throw: ${e?.stack || e}`); }
}

const within = (actual, want, tol, label) =>
  assert.ok(Math.abs(actual - want) <= tol, `${label}: got ${actual}, want ${want}±${tol}`);

const grey = (v) => ({ r: v, g: v, b: v });

// A synthetic platen scan: solid background, optional card, optional inset art rect. Positions are
// exact integers and PNG is lossless, so the truth for every edge is known to the pixel.
async function scan({ w, h, bg = 0, card = null }) {
  const layers = [];
  if (card) {
    const base = await sharp({ create: { width: card.w, height: card.h, channels: 3, background: grey(card.tone) } }).png().toBuffer();
    layers.push({ input: base, left: card.left, top: card.top });
    if (card.art) {
      const aw = card.w - card.art.l - card.art.r;
      const ah = card.h - card.art.t - card.art.b;
      const art = await sharp({ create: { width: aw, height: ah, channels: 3, background: grey(card.art.tone) } }).png().toBuffer();
      layers.push({ input: art, left: card.left + card.art.l, top: card.top + card.art.t });
    }
  }
  let img = sharp({ create: { width: w, height: h, channels: 3, background: grey(bg) } });
  if (layers.length) img = img.composite(layers);
  return img.png().toBuffer();
}

// mm → px at a stated dpi. Every physical-size fixture is built through this, so the "truth" a test
// asserts is the same arithmetic the analyzer inverts — the only thing under test is whether the
// analyzer finds the right rect and names the right class, not whether 25.4 is 25.4.
const mmpx = (mm, dpi) => Math.round(mm / 25.4 * dpi);

// A card of a stated PHYSICAL size, centred on a black platen at a stated dpi. Plain white, no art:
// a sleeve is transparent, so what a real sleeved scan hands the analyzer is exactly this — one
// rectangle 3mm too wide, with nothing inside it to say which object it is.
async function sizedScan({ wmm, hmm, dpi, frameW, frameH, tone = 255, bg = 0 }) {
  const w = mmpx(wmm, dpi), h = mmpx(hmm, dpi);
  return scan({
    w: frameW, h: frameH, bg,
    card: { left: Math.round((frameW - w) / 2), top: Math.round((frameH - h) / 2), w, h, tone },
  });
}

// A platen with cards on it, positioned in millimetres. `border` gives a card a printed white
// border around darker art — the white-lid case, where the border itself reads as background.
async function platen({ dpi, wmm = 210, hmm = 297, bg = 0, cards = [] }) {
  const layers = [];
  for (const c of cards) {
    const w = mmpx(c.wmm, dpi), h = mmpx(c.hmm, dpi);
    layers.push({
      input: await sharp({ create: { width: w, height: h, channels: 3, background: grey(c.tone ?? 255) } }).png().toBuffer(),
      left: mmpx(c.xmm, dpi), top: mmpx(c.ymm, dpi),
    });
    if (c.border) {
      const b = mmpx(c.border, dpi);
      layers.push({
        input: await sharp({ create: { width: w - 2 * b, height: h - 2 * b, channels: 3, background: grey(c.artTone ?? 110) } }).png().toBuffer(),
        left: mmpx(c.xmm, dpi) + b, top: mmpx(c.ymm, dpi) + b,
      });
    }
  }
  let img = sharp({ create: { width: mmpx(wmm, dpi), height: mmpx(hmm, dpi), channels: 3, background: grey(bg) } });
  if (layers.length) img = img.composite(layers);
  return img.png().toBuffer();
}

// A 2×3 grid of ordinary cards, laid out the way a hand lays them out.
const gridCards = (rows, cols) => {
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    out.push({ xmm: 15 + c * 90, ymm: 10 + r * 95, wmm: 63, hmm: 88, border: 4 });
  }
  return out;
};

async function callSheet(input, opts) {
  try { return await analyzeScanSheet(input, opts); }
  catch (e) { assert.fail(`analyzeScanSheet rejected — it must never throw: ${e?.stack || e}`); }
}

describe('analyzeCardImage never rejects (with or without sharp)', () => {
  it('resolves {ok:false} on garbage bytes', async () => {
    const res = await callAnalyze(Buffer.from('definitely not an image'));
    assert.equal(res.ok, false);
    assert.ok(['sharp_unavailable', 'analyze_failed'].includes(res.error), res.error);
    assert.equal(typeof res.message, 'string');
  });

  it('resolves {ok:false} even on a non-buffer input', async () => {
    for (const input of [null, undefined, 42, 'a string', Buffer.alloc(0)]) {
      const res = await callAnalyze(input);
      assert.equal(res.ok, false, `input ${String(input)} must not analyze`);
      assert.equal(typeof res.message, 'string');
    }
  });

  it('a bad dpi is treated as no dpi, not as a divisor', async () => {
    // dpi arrives from an HTTP body, so 0 / -1 / 'abc' / Infinity are all reachable. Any of them
    // reaching the mm conversion would produce Infinity or NaN millimetres and a confident class
    // built on it — the one failure mode this whole feature exists to prevent.
    for (const dpi of [0, -300, 'abc', NaN, Infinity, null, {}]) {
      const res = await callAnalyze(Buffer.from('not an image'), { dpi });
      assert.equal(res.ok, false);
    }
  });

  it('analyzeScanSheet never rejects either', async () => {
    for (const input of [null, undefined, Buffer.from('nope'), Buffer.alloc(0)]) {
      const res = await callSheet(input, { dpi: 600 });
      assert.equal(res.ok, false, `input ${String(input)} must not segment`);
      assert.equal(typeof res.message, 'string');
      assert.ok(['sharp_unavailable', 'no_card', 'analyze_failed'].includes(res.error), res.error);
    }
  });
});

describe('analyzeCardImage', { skip: sharp ? false : 'sharp unavailable' }, () => {
  it('white-bordered card on black: outer to the pixel, inner border widths to truth', async () => {
    // Card 1000x1397 (aspect 0.7158) at (100,100); art inset l=40 t=30 r=24 b=34 — asymmetric on
    // purpose, so a detector that assumes symmetric centering cannot pass by accident.
    const buf = await scan({
      w: 1200, h: 1600, bg: 0,
      card: { left: 100, top: 100, w: 1000, h: 1397, tone: 255, art: { l: 40, t: 30, r: 24, b: 34, tone: 120 } },
    });
    const res = await callAnalyze(buf);
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    const { outer, inner, confidence, cardPx, note } = res.analysis;

    within(outer.l, 100, 2, 'outer.l');
    within(outer.t, 100, 2, 'outer.t');
    within(outer.r, 1100, 2, 'outer.r');
    within(outer.b, 1497, 2, 'outer.b');
    within(cardPx.w, 1000, 4, 'cardPx.w');
    within(cardPx.h, 1397, 4, 'cardPx.h');

    assert.ok(inner, 'a bordered card must yield an inner frame');
    const tol = (bw) => Math.max(3, bw * 0.12);
    within(inner.l - outer.l, 40, tol(40), 'left border width');
    within(inner.t - outer.t, 30, tol(30), 'top border width');
    within(outer.r - inner.r, 24, tol(24), 'right border width');
    within(outer.b - inner.b, 34, tol(34), 'bottom border width');

    assert.ok(confidence.outer > 0.6, `outer confidence ${confidence.outer}`);
    assert.ok(confidence.inner, 'per-edge inner confidence expected');
    for (const e of ['l', 't', 'r', 'b']) {
      assert.ok(confidence.inner[e] > 0.4 && confidence.inner[e] <= 1, `inner confidence .${e} = ${confidence.inner[e]}`);
    }
    assert.equal(typeof note, 'string');
    assert.ok(note.length, 'note must say what was found');
  });

  it('borderless full-art card: inner is null, never a guessed rect', async () => {
    const buf = await scan({
      w: 1200, h: 1600, bg: 0,
      card: { left: 60, top: 80, w: 1000, h: 1397, tone: 128 },
    });
    const res = await callAnalyze(buf);
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    within(res.analysis.outer.l, 60, 2, 'outer.l');
    within(res.analysis.outer.t, 80, 2, 'outer.t');
    assert.equal(res.analysis.inner, null);
    assert.equal(res.analysis.confidence.inner, null);
    assert.match(res.analysis.note, /inner/i, 'the note must explain the missing inner frame');
  });

  it('blank all-black image: no_card', async () => {
    const buf = await scan({ w: 800, h: 1100, bg: 0 });
    const res = await callAnalyze(buf);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'no_card');
    assert.equal(typeof res.message, 'string');
  });

  it('card pushed almost against the frame edge is still found', async () => {
    // 3px and 5px of background is all the ring sampler and the refinement window get to work with.
    const buf = await scan({
      w: 1000, h: 1400, bg: 0,
      card: { left: 3, top: 5, w: 780, h: 1090, tone: 255, art: { l: 31, t: 24, r: 19, b: 27, tone: 100 } },
    });
    const res = await callAnalyze(buf);
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    const { outer, inner } = res.analysis;
    within(outer.l, 3, 2, 'outer.l');
    within(outer.t, 5, 2, 'outer.t');
    within(outer.r, 783, 2, 'outer.r');
    within(outer.b, 1095, 2, 'outer.b');
    assert.ok(inner, 'the inner frame should still resolve near the frame edge');
    within(inner.l - outer.l, 31, Math.max(3, 31 * 0.12), 'left border width');
    within(outer.b - inner.b, 27, Math.max(3, 27 * 0.12), 'bottom border width');
  });

  it('a bright region that is not card-shaped: no_card, not a shrug', async () => {
    const buf = await scan({
      w: 1200, h: 1600, bg: 0,
      card: { left: 150, top: 300, w: 800, h: 800, tone: 255 }, // square — no card is
    });
    const res = await callAnalyze(buf);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'no_card');
    assert.match(res.message, /aspect|card-shaped/i);
  });

  it('garbage bytes with sharp present: analyze_failed, with the decoder message', async () => {
    const res = await callAnalyze(Buffer.from('not an image at all'));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'analyze_failed');
    assert.equal(typeof res.message, 'string');
  });
});

describe('skew measurement', { skip: sharp ? false : 'sharp unavailable' }, () => {
  // sharp .rotate(deg > 0) is visual clockwise — the same convention skewDeg reports, so a scan
  // rotated by +1.2° must measure skewDeg ≈ +1.2 and the caller straightens with rotate(-1.2).
  const tilted = async (deg) => {
    const flat = await scan({
      w: 1400, h: 1800, bg: 0,
      card: { left: 200, top: 200, w: 1000, h: 1397, tone: 255, art: { l: 40, t: 30, r: 24, b: 34, tone: 120 } },
    });
    if (!deg) return flat;
    return sharp(flat).rotate(deg, { background: grey(0) }).png().toBuffer();
  };

  it('a square card measures ~0°', async () => {
    const res = await callAnalyze(await tilted(0));
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.notEqual(res.analysis.skewDeg, null, 'skew must be measurable on clean edges');
    within(res.analysis.skewDeg, 0, 0.05, 'skewDeg (square)');
  });

  it('a card tilted +1.2° measures +1.2° (CW-positive convention)', async () => {
    const res = await callAnalyze(await tilted(1.2));
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.notEqual(res.analysis.skewDeg, null);
    within(res.analysis.skewDeg, 1.2, 0.15, 'skewDeg (+1.2)');
    assert.ok(res.analysis.skewConf > 0.4, `skewConf ${res.analysis.skewConf}`);
    assert.match(res.analysis.note, /skew/i);
  });

  it('a card tilted −0.6° measures the sign correctly', async () => {
    const res = await callAnalyze(await tilted(-0.6));
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.notEqual(res.analysis.skewDeg, null);
    within(res.analysis.skewDeg, -0.6, 0.15, 'skewDeg (−0.6)');
  });

  it('bgLevel reports the backing tone (rotation fill for the corrector)', async () => {
    const res = await callAnalyze(await tilted(0));
    assert.equal(res.ok, true);
    assert.ok(res.analysis.bgLevel <= 20, `black backing must report a dark bgLevel, got ${res.analysis.bgLevel}`);
  });
});

// The aspect gate cannot see the difference these tests are about: a sleeve is 0.7174 and a card is
// 0.7159, so every fixture below passes the gate and only the dpi tells them apart.
describe('physical size — the check the aspect gate cannot do', { skip: sharp ? false : 'sharp unavailable' }, () => {
  const FRAME = { frameW: 1000, frameH: 1300 };

  it('a 63×88mm card at 300dpi measures as a card, confidently', async () => {
    const res = await callAnalyze(await sizedScan({ wmm: 63, hmm: 88, dpi: 300, ...FRAME }), { dpi: 300 });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    const p = res.analysis.physical;
    assert.ok(p, 'physical must be reported when dpi is known');
    within(p.wmm, 63, 0.5, 'wmm');
    within(p.hmm, 88, 0.5, 'hmm');
    assert.equal(p.match, 'card');
    assert.equal(p.confident, true);
    // an honest card keeps its confidence — the cap is for sleeves only
    assert.ok(res.analysis.confidence.outer > 0.6, `outer confidence ${res.analysis.confidence.outer}`);
  });

  it('a 66×92mm penny sleeve is NOT measured as the card inside it', async () => {
    const res = await callAnalyze(await sizedScan({ wmm: 66, hmm: 92, dpi: 300, ...FRAME }), { dpi: 300 });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    const p = res.analysis.physical;
    assert.equal(p.match, 'sleeved');
    within(p.wmm, 66, 0.5, 'wmm');
    within(p.hmm, 92, 0.5, 'hmm');
    // The cap is the whole point: this rect is real, sharp-edged and around the WRONG object. On a
    // black backing every other signal says 0.9+, so nothing but the size check can pull it down.
    assert.ok(res.analysis.confidence.outer <= 0.35,
      `sleeved outer confidence must be capped hard, got ${res.analysis.confidence.outer}`);
    assert.match(res.analysis.note, /sleeve/i, 'the note must name the sleeve');
    // and it must not pretend to have found the card edge inside the sleeve
    assert.match(res.analysis.note, /not inferred|de-sleeve/i);
  });

  it('the live sleeved-SAR measurement (65.6×89.7mm) lands on sleeved, but not confidently', async () => {
    // The real reading from the first live card (§4 of the plan doc). It is inside NEITHER class's
    // box — 3.1mm from a card, 2.3mm from a sleeve — so this pins the two halves of the contract at
    // once: nearest-neighbour still calls it a sleeve, and `confident` admits the margin was thin.
    const res = await callAnalyze(await sizedScan({ wmm: 65.6, hmm: 89.7, dpi: 600, frameW: 2000, frameH: 2600 }), { dpi: 600 });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.analysis.physical.match, 'sleeved');
    assert.equal(res.analysis.physical.confident, false);
    assert.ok(res.analysis.confidence.outer <= 0.35);
  });

  it('a 59×86mm Japanese card is called mini, not a mis-measured standard', async () => {
    const res = await callAnalyze(await sizedScan({ wmm: 59, hmm: 86, dpi: 300, ...FRAME }), { dpi: 300 });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.analysis.physical.match, 'mini');
    assert.equal(res.analysis.physical.confident, true);
    assert.ok(res.analysis.confidence.outer > 0.6, 'a mini card is a real card — no cap');
  });

  it('a 127×178mm jumbo is called jumbo', async () => {
    const res = await callAnalyze(await sizedScan({ wmm: 127, hmm: 178, dpi: 300, frameW: 1800, frameH: 2400 }), { dpi: 300 });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.analysis.physical.match, 'jumbo');
    assert.equal(res.analysis.physical.confident, true);
  });

  it('card-shaped but no known size → unknown, never the nearest class by force', async () => {
    // 100×140mm: aspect 0.714, waved through the gate, and nothing like any card. `nearest` still
    // reports what it was closest to, because "unknown" without a distance is not diagnosable.
    const res = await callAnalyze(await sizedScan({ wmm: 100, hmm: 140, dpi: 300, frameW: 1500, frameH: 2000 }), { dpi: 300 });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    const p = res.analysis.physical;
    assert.equal(p.match, 'unknown');
    assert.equal(p.confident, false);
    assert.equal(p.expect, null);
    assert.ok(p.deltaMm > 2.5, `unknown must be further than the tolerance, got ${p.deltaMm}mm`);
    assert.equal(typeof p.nearest, 'string');
  });

  it('a card laid sideways classifies the same — orientation is normalised', async () => {
    const res = await callAnalyze(await sizedScan({ wmm: 88, hmm: 63, dpi: 300, frameW: 1300, frameH: 1000 }), { dpi: 300 });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.analysis.physical.match, 'card');
    // reported as measured, though: the caller decides whether to rotate
    within(res.analysis.physical.wmm, 88, 0.5, 'wmm (sideways)');
    within(res.analysis.physical.hmm, 63, 0.5, 'hmm (sideways)');
  });

  it('no dpi → physical is null and the note says why, rather than assuming a scale', async () => {
    const res = await callAnalyze(await sizedScan({ wmm: 66, hmm: 92, dpi: 300, ...FRAME }));
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.analysis.physical, null);
    assert.match(res.analysis.note, /no dpi/i);
    // …and with no size evidence the sleeve cap must NOT fire — that would be inventing a finding
    assert.ok(res.analysis.confidence.outer > 0.35, 'without dpi there is nothing to cap on');
  });

  it('the wrong dpi is caught as a wrong size, not swallowed', async () => {
    // A 63×88mm card scanned at 300 but analyzed as 600 measures 31×44mm. Nothing is that size, so
    // the answer is "unknown" — exactly the alarm a mismatched dpi should raise.
    const res = await callAnalyze(await sizedScan({ wmm: 63, hmm: 88, dpi: 300, ...FRAME }), { dpi: 600 });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.analysis.physical.match, 'unknown');
  });

  it('the one dpi error size CANNOT catch: half the true dpi reads as a jumbo', async () => {
    // 127×178 is within 1mm of twice 63×88, so a standard card measured at half its real dpi is
    // pixel-for-pixel a jumbo. No measurement resolves that — only the dpi does. The class is
    // reported as jumbo because that is genuinely the nearest, and the note carries the warning
    // rather than the classifier pretending to a certainty it has not got.
    const res = await callAnalyze(await sizedScan({ wmm: 63, hmm: 88, dpi: 600, frameW: 2000, frameH: 2600 }), { dpi: 300 });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.analysis.physical.match, 'jumbo');
    assert.match(res.analysis.note, /twice a standard card/i, 'the collision must be stated, not hidden');
  });

  it('the sleeve bias crosses a grading band — arithmetic, so it cannot be argued away later', () => {
    // Not a test of this module so much as of the reason it exists. Adding the same constant to both
    // borders of an axis is a mediant: it drags any ratio toward 50/50, and it can only ever flatter
    // the card. Worked on a real card: ~3mm of printed border a side (6mm budget), a genuine 57/43
    // split, inside a penny sleeve that overhangs 1.5mm a side (66mm sleeve, 63mm card).
    const split = (l, r) => Math.max(l, r) / (l + r) * 100;
    const budget = 6, s = 1.5;
    const wide = budget * 0.57, narrow = budget - wide;
    const bare = split(narrow, wide);
    const throughSleeve = split(narrow + s, wide + s);
    within(bare, 57, 0.01, 'the card as it really is');
    assert.ok(throughSleeve < bare, 'the sleeve error only ever flatters the card');
    // 55 is the band the config uses for a 10-capable centering call: the bare card misses it and
    // the same card measured through its sleeve clears it. That is a badge earned by plastic.
    assert.ok(bare > 55, `a 57/43 card is not 10-capable, got ${bare.toFixed(1)}`);
    assert.ok(throughSleeve < 55, `measured through the sleeve it reads 10-capable, got ${throughSleeve.toFixed(1)}`);
  });
});

describe('analyzeScanSheet — many cards on one platen', { skip: sharp ? false : 'sharp unavailable' }, () => {
  const DPI = 150;   // A4 at 150dpi is 1240×1754 — big enough to be a real segmentation problem,
                     // small enough that six of them analyze inside a test run

  it('a 2×3 grid comes back as six cards, left-to-right then top-to-bottom', async () => {
    const buf = await platen({ dpi: DPI, cards: gridCards(3, 2) });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.cards.length, 6);
    assert.deepEqual(res.cards.map((c) => c.index), [0, 1, 2, 3, 4, 5]);
    for (let i = 1; i < res.cards.length; i++) {
      const a = res.cards[i - 1].rect, b = res.cards[i].rect;
      const sameRow = Math.abs(a.t - b.t) < (b.b - b.t) * 0.5;
      assert.ok(sameRow ? b.l > a.l : b.t > a.t,
        `card ${i} out of reading order: ${JSON.stringify(a)} then ${JSON.stringify(b)}`);
    }
    assert.deepEqual(res.grid, { cols: 2, rows: 3, phantom: 0 });
  });

  it('each card is analyzed in its own right — every cell classifies as a 63×88 card', async () => {
    const buf = await platen({ dpi: DPI, cards: gridCards(3, 2) });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, true);
    for (const c of res.cards) {
      assert.equal(c.analysis.physical.match, 'card', `card ${c.index}: ${c.analysis.physical.wmm}×${c.analysis.physical.hmm}mm`);
      // coordinates are in the CELL, not the sheet — the contract callers crop against
      assert.ok(c.analysis.outer.l < c.rect.r - c.rect.l, 'analysis must be in cell coordinates');
      assert.ok(c.analysis.outer.r <= c.rect.r - c.rect.l + 2, 'analysis must not run past the cell');
    }
  });

  it('a single row of three is handled as well as a grid', async () => {
    const buf = await platen({ dpi: DPI, cards: [
      { xmm: 8, ymm: 100, wmm: 63, hmm: 88, border: 4 },
      { xmm: 76, ymm: 100, wmm: 63, hmm: 88, border: 4 },
      { xmm: 143, ymm: 100, wmm: 63, hmm: 88, border: 4 },
    ] });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.cards.length, 3);
    assert.deepEqual(res.grid.cols, 3);
    assert.deepEqual(res.grid.rows, 1);
  });

  it('a column of three sideways cards is handled too', async () => {
    const buf = await platen({ dpi: DPI, cards: [
      { xmm: 20, ymm: 20, wmm: 88, hmm: 63, border: 4 },
      { xmm: 20, ymm: 100, wmm: 88, hmm: 63, border: 4 },
      { xmm: 20, ymm: 180, wmm: 88, hmm: 63, border: 4 },
    ] });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.cards.length, 3);
    for (const c of res.cards) assert.equal(c.analysis.physical.match, 'card');
  });

  it('a gap in the grid does not invent a card there', async () => {
    // Cells are the cross product of row and column bands, so a 2×3 layout missing one card
    // proposes six cells for five cards. The empty one has to be thrown out on fill, before
    // anything pays to extract it.
    const cards = gridCards(3, 2).filter((_, i) => i !== 3);
    const buf = await platen({ dpi: DPI, cards });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.cards.length, 5);
    assert.equal(res.grid.phantom, 1);
    assert.match(res.note, /empty cell/i);
  });

  it('the aspect gate becomes a per-cell validator: a non-card next to a card drops one cell, not the sheet', async () => {
    const buf = await platen({ dpi: DPI, cards: [
      { xmm: 15, ymm: 60, wmm: 63, hmm: 88, border: 4 },
      { xmm: 110, ymm: 60, wmm: 70, hmm: 70, tone: 200 },   // square — no card is
    ] });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, true, 'one bad neighbour must not fail the whole sheet');
    assert.equal(res.cards.length, 1);
    assert.equal(res.cards[0].analysis.physical.match, 'card');
    assert.match(res.note, /rejected/i);
    assert.match(res.note, /aspect|card-shaped/i, 'the note must say WHY the cell was rejected');
  });

  it('two cards 2mm apart still separate', async () => {
    // Hand placement, not a jig. The gap is smaller than a printed border, which is why bands are
    // reassembled by minimum card size rather than by gap width.
    const buf = await platen({ dpi: DPI, cards: [
      { xmm: 40, ymm: 60, wmm: 63, hmm: 88, border: 4 },
      { xmm: 105, ymm: 60, wmm: 63, hmm: 88, border: 4 },
    ] });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.cards.length, 2);
  });

  it('white-bordered cards on a white lid are not sawn into strips', async () => {
    // The border reads as background here, so each card's profile is border|art|border — three
    // bands where there is one card. Any band too small to BE a card is an internal dip.
    const buf = await platen({ dpi: DPI, bg: 255, cards: [
      { xmm: 15, ymm: 60, wmm: 63, hmm: 88, tone: 255, border: 4 },
      { xmm: 110, ymm: 60, wmm: 63, hmm: 88, tone: 255, border: 4 },
    ] });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.cards.length, 2, 'two cards, not four border strips and two art panels');
  });

  it('one card on a full platen still comes back — the 9%-of-frame case', async () => {
    // A 63×88 card fills under 9% of A4, below the single-card path's minimum area ratio. Falling
    // straight back to the whole-frame analyzer here would answer no_card for a perfectly good
    // scan, so a lone cell is analyzed as a cell first.
    const buf = await platen({ dpi: DPI, cards: [{ xmm: 40, ymm: 60, wmm: 63, hmm: 88, border: 4 }] });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.cards.length, 1);
    assert.equal(res.cards[0].analysis.physical.match, 'card');
  });

  it('an empty platen is no_card, with the backing level in the message', async () => {
    const buf = await platen({ dpi: DPI, cards: [] });
    const res = await callSheet(buf, { dpi: DPI });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'no_card');
    assert.match(res.message, /background|blank|empty/i);
  });

  it('segmentation works without dpi, using the sheet\'s own proportions', async () => {
    const buf = await platen({ dpi: DPI, cards: gridCards(3, 2) });
    const res = await callSheet(buf);
    assert.equal(res.ok, true, res.ok ? '' : `${res.error}: ${res.message}`);
    assert.equal(res.cards.length, 6);
    for (const c of res.cards) assert.equal(c.analysis.physical, null, 'no dpi, no size claim');
    assert.match(res.note, /no dpi/i);
  });

  it('segmentSheet reports geometry only, with rects inside the image', async () => {
    // The route uses this half on its own: cut each cell once, rather than once to segment and
    // again to crop. Rects must therefore be usable as an extract() window without further care.
    const buf = await platen({ dpi: DPI, cards: gridCards(3, 2) });
    const seg = await segmentSheet(buf, { dpi: DPI });
    assert.equal(seg.ok, true, seg.ok ? '' : `${seg.error}: ${seg.message}`);
    assert.equal(seg.cells.length, 6);
    const { width, height } = await sharp(buf).metadata();
    for (const c of seg.cells) {
      assert.ok(c.rect.l >= 0 && c.rect.t >= 0, 'rect starts inside the image');
      assert.ok(c.rect.r <= width && c.rect.b <= height, 'rect ends inside the image');
      assert.ok(c.rect.r > c.rect.l && c.rect.b > c.rect.t, 'rect is non-empty');
      assert.ok(c.fill >= 0.35, `cell ${c.index} fill ${c.fill}`);
      assert.equal(typeof c.row, 'number');
      assert.equal(typeof c.col, 'number');
    }
    // and each cell carries background around the card, or the per-cell analyzer has nothing to
    // measure the card against
    assert.ok(seg.cells[0].rect.r - seg.cells[0].rect.l > mmpx(63, DPI), 'cell must be wider than the card in it');
  });
});
