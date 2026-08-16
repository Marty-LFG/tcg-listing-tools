// scripts/build-placeholder-rails.mjs — generate stand-in rail art so the compositor is testable
// before the real artwork exists.
//
// These are PLACEHOLDERS. Replace rails/<variant>/{left,right}.png with the designed art whenever
// it is ready; nothing in the pipeline needs to change, and swapping the files re-composes every
// listing automatically (the rail bytes are hashed into the content key).
//
// TWO FAMILIES OF ART, and they are deliberately separate files:
//   · left.png / right.png   — the VERTICAL rails, for eBay's square and the OG card
//   · top.png / bottom.png   — the HORIZONTAL bands, for the Shopify 63:88 tile
//
// ⚠ THEIR DIGESTS MUST NOT BE MERGED. railsDigest() hashes left+right and is an INPUT to the eBay
// content hash, so folding the bands into it would re-key every branded image already hosted on a
// live eBay listing and force a full store re-upload. lib/listing-image-assets.mjs keeps
// bandsDigest() separate for exactly that reason, and a test pins it.
//
// THE CONTRACT the real art has to meet:
//   · One PNG per side per variant, at rails/<variant>/left.png and rails/<variant>/right.png.
//   · Any authoring scale works — the compositor normalises to the profile's rail width ONCE at
//     load and memoises it, so the art never resamples per image. Author at 2× (600×3200) for a
//     300px rail, or native 300×1600. The `sealed` profile uses a 220px rail, so its art wants a
//     440×3200 (2×) or 220×1600 aspect or it will squash horizontally.
//   · Full-bleed vertically — the rail runs the whole 1600px canvas edge to edge.
//   · Leave the middle third of the RIGHT rail clear: that is where the metadata line
//     ("JAPANESE · MEGA SYMPHONIA") is drawn at composite time. Configurable via text.rail.
//   · No promotional copy. eBay's image policy bans advertising on listing photos; a logo mark and
//     the card's own metadata read as identification, "check our store" does not. See AGENTS.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Dark plum, pulled from the store mark's own backing disc so the rails and the logo read as one
// thing rather than a logo dropped onto a neutral panel.
const TOP = '#2e1640';
const MID = '#150a1d';

// The real store mark. A transparent PNG, so it composites straight onto the rail — which is why
// the mark file must keep its alpha channel: flattened onto white it would show a box.
export const LOGO = path.join(ROOT, 'logos', 'BK_Logo_alpha.png');

const VARIANTS = {
  default: { width: 600, accent: '#d4b072' },
  japanese: { width: 600, accent: '#e0669a' },
  sealed: { width: 440, accent: '#7ea8c9' },
};
const HEIGHT = 3200;
const LOGO_FRACTION = 0.78;   // of the rail width — leaves a margin either side at every scale

// The horizontal bands, authored on the same 3200 long axis as the rails so the two families scale
// alike. 3200 x 400 is 2x of a 1600 x 200 band.
//
// The bands carry the GRADIENT AND THE HAIRLINE ONLY — no store mark. The vertical rails can bake
// theirs in because their authoring aspect matches the frame they land in; a band serves both the
// 1512-wide card tile and the 1600-wide sealed tile, so a baked mark would stretch by a different
// amount in each. The mark and the card's facts are composited at render time instead, the same
// way the set badge is drawn onto the foot of the right rail rather than painted into it.
const BAND_LENGTH = 3200;
const BAND_THICKNESS = 400;

// side: the rail's own side of the canvas. The INNER edge (the one facing the card) carries the
// hairline, so the two rails mirror rather than repeat.
function railSvg(side, { width, accent }) {
  const innerX = side === 'left' ? width - 10 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${TOP}"/>
      <stop offset="0.5" stop-color="${MID}"/>
      <stop offset="1" stop-color="${TOP}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${HEIGHT}" fill="url(#g)"/>
  <rect x="${innerX}" y="0" width="10" height="${HEIGHT}" fill="${accent}"/>
</svg>`;
}

// side: 'top' | 'bottom'. The hairline goes on the CARD-FACING edge — the bottom of the top band,
// the top of the bottom one — so the pair mirrors around the card exactly as left/right do.
function bandSvg(side, { accent }) {
  const hair = 20;                                   // 10px at 1x, matching the rails' hairline
  const innerY = side === 'top' ? BAND_THICKNESS - hair : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAND_LENGTH}" height="${BAND_THICKNESS}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${TOP}"/>
      <stop offset="0.5" stop-color="${MID}"/>
      <stop offset="1" stop-color="${TOP}"/>
    </linearGradient>
  </defs>
  <rect width="${BAND_LENGTH}" height="${BAND_THICKNESS}" fill="url(#g)"/>
  <rect x="0" y="${innerY}" width="${BAND_LENGTH}" height="${hair}" fill="${accent}"/>
</svg>`;
}

export async function buildPlaceholderRails({ outDir = path.join(ROOT, 'rails'), force = false, logo = LOGO } = {}) {
  const { default: sharp } = await import('sharp');
  const written = [];
  const skipped = [];
  const haveLogo = fs.existsSync(logo);
  if (!haveLogo) console.warn(`warning: ${path.relative(ROOT, logo)} not found — rails will be plain panels`);

  for (const [variant, spec] of Object.entries(VARIANTS)) {
    const dir = path.join(outDir, variant);
    fs.mkdirSync(dir, { recursive: true });

    // Rendered once per variant: the mark is the same on both rails, only its position mirrors.
    const markW = Math.round(spec.width * LOGO_FRACTION);
    const mark = haveLogo
      ? await sharp(logo).resize(markW, markW, { fit: 'inside', withoutEnlargement: false }).png().toBuffer()
      : null;
    const markMeta = mark ? await sharp(mark).metadata() : null;

    for (const side of ['left', 'right']) {
      const file = path.join(dir, side + '.png');
      // Never clobber real artwork that has been dropped in. --force is the deliberate override.
      if (fs.existsSync(file) && !force) { skipped.push(path.relative(ROOT, file)); continue; }
      const layers = [];
      if (mark) {
        // The mark sits at the TOP of BOTH rails, so the pair reads as one masthead across the
        // image. The foot of the right rail is left clear on purpose: the compositor draws the set
        // symbol and the card's printed number there at compose time.
        layers.push({ input: mark, left: Math.round((spec.width - markMeta.width) / 2), top: 150 });
      }
      let img = sharp(Buffer.from(railSvg(side, spec)));
      if (layers.length) img = img.composite(layers);
      await img.png({ compressionLevel: 9 }).toFile(file);
      written.push(`${path.relative(ROOT, file)}  ${spec.width}x${HEIGHT}${mark ? '  + mark ' + markMeta.width + 'x' + markMeta.height : ''}`);
    }

    // The horizontal bands. Gradient and hairline only — see the note by BAND_LENGTH.
    for (const side of ['top', 'bottom']) {
      const file = path.join(dir, side + '.png');
      if (fs.existsSync(file) && !force) { skipped.push(path.relative(ROOT, file)); continue; }
      await sharp(Buffer.from(bandSvg(side, spec))).png({ compressionLevel: 9 }).toFile(file);
      written.push(`${path.relative(ROOT, file)}  ${BAND_LENGTH}x${BAND_THICKNESS}`);
    }
  }
  return { written, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const force = process.argv.includes('--force');
  const { written, skipped } = await buildPlaceholderRails({ force });
  for (const w of written) console.log('wrote   ' + w);
  for (const s of skipped) console.log('kept    ' + s + '  (already exists — pass --force to overwrite)');
  if (!written.length) console.log('\nnothing written; all rail art already present.');
}
