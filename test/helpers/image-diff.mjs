// test/helpers/image-diff.mjs — raw-pixel comparison for the compositor's golden tests.
//
// Hand-rolled rather than pulling in pixelmatch: its one real advantage is anti-alias detection,
// which is irrelevant when both sides come out of the same renderer, and adding a second dependency
// to check the first dependency's output is a poor trade in a repo that had none until sharp.
//
// Tolerance is not optional here. libvips resamples deterministically for a GIVEN build but not
// necessarily across builds, so the dev box and the server can differ by a channel step or two on
// the same input. Comparisons are on decoded RGBA with a threshold, never on encoded bytes.
import { Buffer } from 'node:buffer';

let _sharp;
export async function sharpOrNull() {
  if (_sharp !== undefined) return _sharp;
  try { _sharp = (await import('sharp')).default; } catch { _sharp = null; }
  return _sharp;
}

// Decode to raw RGB(A) at an optional reduced size. Goldens compare small: a 400x400 downscale
// catches every layout regression that matters while keeping the committed fixtures tiny.
export async function toRaw(input, { width = null } = {}) {
  const sharp = await sharpOrNull();
  if (!sharp) throw new Error('sharp unavailable');
  let img = sharp(input, { failOn: 'none' }).removeAlpha();
  if (width) img = img.resize(width, width, { fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Fraction of pixels where any channel differs by more than `threshold` (0–255).
 * Returns { ratio, maxDelta, differing, total } — never throws on a size mismatch, it reports it.
 */
export async function diffRatio(a, b, { threshold = 8, width = 400 } = {}) {
  const [ra, rb] = await Promise.all([toRaw(a, { width }), toRaw(b, { width })]);
  if (ra.width !== rb.width || ra.height !== rb.height) {
    return { ratio: 1, maxDelta: 255, differing: -1, total: -1, sizeMismatch: `${ra.width}x${ra.height} vs ${rb.width}x${rb.height}` };
  }
  const total = ra.width * ra.height;
  let differing = 0, maxDelta = 0;
  for (let p = 0; p < total; p++) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(ra.data[p * ra.channels + c] - rb.data[p * rb.channels + c]);
      if (d > worst) worst = d;
    }
    if (worst > maxDelta) maxDelta = worst;
    if (worst > threshold) differing++;
  }
  return { ratio: differing / total, maxDelta, differing, total };
}

/**
 * Max per-channel delta over a rectangular window of `image`, against `expected` raw RGB laid out
 * at `expected.width`. Used to assert the rails survive compositing untouched.
 */
export async function regionDelta(image, expected, { left, top, width, height }) {
  const img = await toRaw(image);
  let max = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = ((top + y) * img.width + (left + x)) * img.channels;
      const ei = (y * expected.width + x) * expected.channels;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(img.data[si + c] - expected.data[ei + c]);
        if (d > max) max = d;
      }
    }
  }
  return max;
}

// Solid-colour test images, generated rather than committed. Only the EXIF fixture has to be a real
// file on disk — orientation metadata cannot be synthesised through sharp's own encoder.
export async function solid(width, height, colour = { r: 200, g: 40, b: 60 }, format = 'jpeg') {
  const sharp = await sharpOrNull();
  const img = sharp({ create: { width, height, channels: 3, background: colour } });
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 95 }).toBuffer();
}

// A stand-in for real card art: a gradient that reaches all four edges.
//
// The gradient is the point. A fixture with a uniform border is trimmed away by the compositor's
// detector — correctly, but it makes the fixture a different size from the one the test asked for,
// which quietly breaks every geometry and aspect assertion built on it. Real catalog art bleeds to
// its own edges, and so does this.
export async function fakeCard(width, height) {
  const sharp = await sharpOrNull();
  // 3x3 of distinct colours, smoothly upscaled: no two edges share a flat value, so trim() finds
  // no uniform border to remove and correctly reports "nothing to crop".
  const seed = Buffer.from([
    30, 80, 170, 210, 60, 90, 40, 150, 120,
    240, 200, 60, 20, 30, 40, 180, 90, 200,
    60, 170, 210, 250, 250, 250, 90, 40, 30,
  ]);
  return sharp(seed, { raw: { width: 3, height: 3, channels: 3 } })
    .resize(width, height, { fit: 'fill', kernel: 'cubic' })
    .jpeg({ quality: 95 }).toBuffer();
}

// A card sitting on a flat background — the owner-photo shape, where trim() has real work to do.
export async function cardOnBackground(cardW, cardH, { left = 250, top = 320, width = 900, height = 1200, background = { r: 236, g: 236, b: 238 } } = {}) {
  const sharp = await sharpOrNull();
  const card = await fakeCard(cardW, cardH);
  return sharp({ create: { width, height, channels: 3, background } })
    .composite([{ input: card, left, top }])
    .jpeg({ quality: 95 }).toBuffer();
}
