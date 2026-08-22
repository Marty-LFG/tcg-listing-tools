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
import { analyzeCardImage } from '../../lib/scan-centering.mjs';
import { sharpOrNull } from '../helpers/image-diff.mjs';

const sharp = await sharpOrNull();

async function callAnalyze(input) {
  try { return await analyzeCardImage(input); }
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
