// scripts/compose-listing-images.mjs — batch the listing image compositor over a file or a folder.
//
//   node scripts/compose-listing-images.mjs --in <file|dir> --out <dir> [options]
//
//     --in <path>        a single image, or a directory to sweep (required)
//     --out <dir>        where to write the composed JPEGs (required unless --dry-run)
//     --variant <name>   force the rail art (default | japanese | sealed)
//     --type <name>      productType profile: single | slab | sealed          [default: single]
//     --language <name>  metadata for the rail text, e.g. Japanese
//     --set <name>       metadata for the rail text, e.g. "Mega Symphonia"
//     --concurrency <n>  parallel composites                                  [default: 4]
//     --dry-run          report what would happen, write nothing
//     --force            re-render even when the output already exists
//
// This is the backfill tool: point it at a folder of scans, eyeball the results at thumbnail size,
// then wire the same module into the publish path. It never talks to eBay.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { composeListingImage, describeCompositor, ComposeUnavailable } from '../lib/listing-image.mjs';
import { loadConfig, VARIANTS } from '../lib/listing-image-config.mjs';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff']);

// Hand-rolled, matching the repo's other scripts — no arg-parsing dependency anywhere in here.
export function parseArgs(argv) {
  const out = { concurrency: 4, type: 'single', dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); return v; };
    switch (a) {
      case '--in': out.in = val(); break;
      case '--out': out.out = val(); break;
      case '--variant': out.variant = val(); break;
      case '--type': out.type = val(); break;
      case '--language': out.language = val(); break;
      case '--set': out.setName = val(); break;
      // Clamped, not trusted: a typo here is the difference between four composites in flight and
      // five thousand. Anything unparseable or non-positive falls back to the default rather than
      // being coerced into a surprising 1-wide run.
      case '--concurrency': { const n = parseInt(val(), 10); out.concurrency = Number.isFinite(n) && n > 0 ? Math.min(16, n) : 4; break; }
      case '--dry-run': out.dryRun = true; break;
      case '--force': out.force = true; break;
      case '--help': case '-h': out.help = true; break;
      default: throw new Error(`unknown flag ${a}`);
    }
  }
  if (!out.help) {
    if (!out.in) throw new Error('--in is required');
    if (!out.out && !out.dryRun) throw new Error('--out is required (or pass --dry-run)');
    if (out.variant && !VARIANTS.includes(out.variant)) throw new Error(`--variant must be one of: ${VARIANTS.join(', ')}`);
  }
  return out;
}

export function listInputs(inPath) {
  const st = fs.statSync(inPath);
  if (st.isFile()) return [inPath];
  return fs.readdirSync(inPath)
    .map((n) => path.join(inPath, n))
    .filter((p) => { try { return fs.statSync(p).isFile() && IMAGE_EXT.has(path.extname(p).toLowerCase()); } catch { return false; } })
    .sort();
}

// A worker pool rather than Promise.all over everything: libvips is already threaded internally, so
// firing 500 composites at once just thrashes memory. Four in flight saturates the CPU comfortably.
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Compose every image in `inPath` into `outDir`.
 * Returns { processed, skipped, failed, results[] } — the summary the CLI prints.
 */
export async function composeDir(opts, { log = () => {} } = {}) {
  const cfg = opts.cfg || loadConfig();
  const inputs = listInputs(opts.in);
  const meta = { productType: opts.type, language: opts.language, setName: opts.setName };
  const options = { cfg, ...(opts.variant ? { variant: opts.variant } : {}) };

  if (opts.out && !opts.dryRun) fs.mkdirSync(opts.out, { recursive: true });

  const results = await pool(inputs, opts.concurrency, async (file) => {
    const outFile = opts.out ? path.join(opts.out, path.parse(file).name + '.jpg') : null;
    // Skipping on the OUTPUT PATH, not the content hash: re-running over a folder should be cheap
    // and obvious. --force is the way to re-render after changing the layout or the rail art.
    if (outFile && !opts.force && fs.existsSync(outFile)) return { file, outFile, status: 'skipped', reason: 'output exists' };
    try {
      const r = await composeListingImage(file, meta, options);
      if (opts.dryRun) return { file, outFile, status: 'processed', dryRun: true, contentHash: r.contentHash, variant: r.variant, card: r.card };
      const tmp = outFile + '.tmp' + process.pid;
      fs.writeFileSync(tmp, r.buffer);
      fs.renameSync(tmp, outFile);
      return { file, outFile, status: 'processed', contentHash: r.contentHash, variant: r.variant, card: r.card, bytes: r.buffer.length };
    } catch (e) {
      // One unreadable file must never take the batch with it — the owner pointed at 500 scans, not one.
      return { file, outFile, status: 'failed', error: e instanceof ComposeUnavailable ? e.message : (e?.message || String(e)) };
    }
  });

  for (const r of results) log(r);
  return {
    processed: results.filter((r) => r.status === 'processed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
}

const USAGE = `
compose-listing-images — batch the listing image compositor

  node scripts/compose-listing-images.mjs --in <file|dir> --out <dir> [options]

    --in <path>        a single image, or a directory to sweep   (required)
    --out <dir>        where to write composed JPEGs             (required unless --dry-run)
    --variant <name>   force rail art: ${VARIANTS.join(' | ')}
    --type <name>      productType profile: single | slab | sealed   [default: single]
    --language <name>  rail text, e.g. Japanese
    --set <name>       rail text, e.g. "Mega Symphonia"
    --concurrency <n>  parallel composites                       [default: 4]
    --dry-run          report only, write nothing
    --force            re-render even if the output exists
`;

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error('error: ' + e.message + '\n' + USAGE); process.exit(2); }
  if (opts.help) { console.log(USAGE); process.exit(0); }

  // Say WHY up front if the compositor cannot run — "0 processed, 12 failed" with the same message
  // twelve times is a worse way to learn the font is missing.
  const ready = await describeCompositor(opts.cfg || loadConfig());
  if (!ready.sharp.available) { console.error('sharp is not installed: ' + ready.sharp.error); process.exit(1); }
  if (!ready.font.ok) console.warn('warning: rail text disabled — ' + ready.font.reason);

  const t0 = Date.now();
  const summary = await composeDir(opts, {
    log: (r) => {
      if (r.status === 'failed') console.error(`  FAIL  ${path.basename(r.file)}  ${r.error}`);
      else if (r.status === 'skipped') console.log(`  skip  ${path.basename(r.file)}  (${r.reason})`);
      else console.log(`  ok    ${path.basename(r.file)}  ${r.variant}  card ${r.card.width}x${r.card.height}${r.card.trimmed ? ' (trimmed)' : ''}  ${r.contentHash.slice(0, 12)}${r.dryRun ? '  [dry run]' : ''}`);
    },
  });
  console.log(`\n${summary.processed} processed · ${summary.skipped} skipped · ${summary.failed} failed  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (opts.dryRun) console.log('(dry run — nothing was written)');
  process.exit(summary.failed ? 1 : 0);
}
