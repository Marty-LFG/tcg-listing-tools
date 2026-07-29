// scripts/build-placeholder-rails.mjs — generate stand-in rail art so the compositor is testable
// before the real artwork exists.
//
// These are PLACEHOLDERS. Replace rails/<variant>/{left,right}.png with the designed art whenever
// it is ready; nothing in the pipeline needs to change, and swapping the files re-composes every
// listing automatically (the rail bytes are hashed into the content key).
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
        // One mark per rail, at opposite ends: the left rail carries it high and the right low, so
        // the pair frames the card diagonally instead of stacking four marks down the same edge.
        const top = side === 'left' ? 150 : HEIGHT - 150 - markMeta.height;
        layers.push({ input: mark, left: Math.round((spec.width - markMeta.width) / 2), top });
      }
      let img = sharp(Buffer.from(railSvg(side, spec)));
      if (layers.length) img = img.composite(layers);
      await img.png({ compressionLevel: 9 }).toFile(file);
      written.push(`${path.relative(ROOT, file)}  ${spec.width}x${HEIGHT}${mark ? '  + mark ' + markMeta.width + 'x' + markMeta.height : ''}`);
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
