// lib/listing-image-source.mjs — the front half of the compositor, shared by every output frame.
//
//   read -> EXIF-rotate -> flatten -> detect the card -> guard the detection
//
// ONE prep for every target. The eBay square and the Shopify frames must agree about where the card
// is in the photo, or the same listing shows two different crops on two channels — and the trim is
// the one step in the pipeline that can be wrong in a way nobody notices until a customer does.
//
// Detection always runs on the FLATTENED image. Trimming a transparent PNG against its alpha gives
// a different box than trimming it against white (Scryfall's rounded corners would move it), so
// flattening first is what makes the region reproducible rather than source-format-dependent.
//
// The detector is INJECTED rather than imported, so this module has no dependency on the compositor
// that uses it (and no import cycle with it).

// The image's size AFTER auto-orientation, which is not what metadata() reports.
//
// Two traps here, both measured:
//   1. metadata() on a source with EXIF orientation 5-8 reports the STORED width/height, i.e. the
//      sideways ones. sharp >= 0.33 exposes the corrected pair as `autoOrient`; the manual swap is
//      the fallback for a sharp this repo has not pinned.
//   2. metadata() on a PIPELINE does not reflect queued operations either — `sharp(f).rotate()`
//      still answers with the pre-rotate dimensions, so `base.clone().metadata()` is NOT a way to
//      get this and reading it that way produces an extract() that throws `bad extract area`.
export function orientedSize(m) {
  const ao = m && m.autoOrient;
  if (ao && ao.width > 0 && ao.height > 0) return { width: ao.width, height: ao.height };
  const swap = m && m.orientation >= 5 && m.orientation <= 8;
  return { width: swap ? m.height : m.width, height: swap ? m.width : m.height };
}

/**
 * @returns { base, srcMeta, frame, region, legacyFull, frameFull, tooSmall }
 *   base       the EXIF-rotated, flattened pipeline — clone() it, never consume it
 *   srcMeta    metadata of the RAW bytes (pre-rotate), kept because the frozen check below needs it
 *   frame      the true post-rotate dimensions
 *   region     what the detector found, ungurarded — callers take it through regionFor()
 */
export async function prepareSource(sharp, sourceBytes, { layout, meta = {}, detector } = {}) {
  const base = sharp(sourceBytes, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' });
  const srcMeta = await sharp(sourceBytes, { failOn: 'none' }).metadata();
  const frame = orientedSize(srcMeta);

  let region = null;
  try { region = detector ? await detector.detect(base.clone(), meta, layout) : null; } catch { region = null; }

  let legacyFull = false, frameFull = false, tooSmall = false;
  if (region) {
    // FROZEN — do not "fix" this to compare against `frame`. It compares the detected region
    // against the PRE-rotate dimensions, so for EXIF orientations 5-8 it can never match and the
    // card takes a whole-frame extract() it does not need. That extract is NOT free: measured on
    // test/fixtures/listing-image/exif-orient-6.jpg, dropping it changes 17378 of 2973696 bytes
    // (0.58%) with a max channel delta of 97. A whole-frame extract IS a no-op when .rotate()
    // rotated nothing (measured delta 0, control in the same test), but not once it has rotated.
    //
    // The region is not part of the content hash, so every image already hosted on a live eBay
    // listing is unaffected either way — but a COLD render of a sideways owner photo would come out
    // different, and "the eBay square is byte-identical" has to mean it. Retire this at the D-023
    // eBay reset, alongside the Baloo 2 font change, when every image re-composes anyway.
    legacyFull = region.left === 0 && region.top === 0 && region.width === srcMeta.width && region.height === srcMeta.height;
    // The honest one. New frames use this, and `trimmed` is reported from it.
    frameFull = region.left === 0 && region.top === 0 && region.width === frame.width && region.height === frame.height;
    // Unaffected by the axis swap: this is w*h, and multiplication commutes.
    const srcArea = (srcMeta.width || 0) * (srcMeta.height || 0);
    tooSmall = !srcArea || (region.width * region.height) / srcArea < layout.trimMinAreaRatio;
  }
  return { base, srcMeta, frame, region, legacyFull, frameFull, tooSmall };
}

// The region a given target should extract, or null for "use the whole frame".
// The two callers differ in ONE boolean, deliberately — see the frozen comment above.
export function regionFor(prep, { legacy = false } = {}) {
  if (!prep.region || prep.tooSmall) return null;
  return (legacy ? prep.legacyFull : prep.frameFull) ? null : prep.region;
}
