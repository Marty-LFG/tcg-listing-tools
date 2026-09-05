// scripts/export-verifier.mjs — copy the isomorphic verifier into the storefront theme.
//
// WHY A COPY AND NOT A SHARED IMPORT. The verification page lives in a different repository and is served
// by Shopify, so it cannot import from this one at runtime. The modules therefore have to be COPIED — and
// a copy is precisely the thing Golden Rule 9 warns about, because lib/normalize.mjs taught this codebase
// that a hand-maintained mirror drifts.
//
// A DRIFTED VERIFIER FAILS AN HONEST BUNDLE. That is worse than not verifying at all: the buyer of a
// perfectly good parcel is told their card was swapped. So the copy is mechanical, and the SOURCE hash of
// every module is recorded on both sides. test/invariants/runs-verifier-export.test.mjs re-hashes the
// sources and fails the moment one changes without this script being re-run.
//
// THE ONLY EDIT IS THE IMPORT SPECIFIER, and it is a RELATIVE one. Shopify's assets/ directory is flat
// and every file is served from the same CDN directory, so './bk-runs-canonical.js' resolves. A bare
// specifier would be tidier and is not available: it would need an import map, which lives in
// snippets/scripts.liquid — an upstream file that is NOT on the theme's closed permitted-edit list.
//
// The bk- prefix is not decoration either. The theme audits upstream drift with
// `git diff --name-only ... | grep -v '/bk-'`, so an asset named anything else appears in that output
// forever as an apparently-touched upstream file.
//
// The module bodies are otherwise byte-identical to source, which is what makes the hash check meaningful.
//
// Run:
//   node --disable-warning=ExperimentalWarning scripts/export-verifier.mjs
//   node --disable-warning=ExperimentalWarning scripts/export-verifier.mjs --check   (verify, write nothing)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME = process.env.BK_THEME_DIR || path.resolve(ROOT, '..', 'bk-theme');
const CHECK = process.argv.includes('--check');

/**
 * The modules the verification page needs, in dependency order.
 *
 * Every one is ISOMORPHIC — WebCrypto only, no node: import anywhere in the set. That is asserted rather
 * than assumed below, because a node: import added later would break the storefront page and nothing else
 * would notice until a buyer scanned an insert.
 */
export const VERIFIER_MODULES = [
  'runs-canonical.mjs',
  'runs-language.mjs',
  'runs-rarity.mjs',
  'runs-merkle.mjs',
  'runs-claims.mjs',
  'runs-header.mjs',
  'runs-public.mjs',
  'runs-codes.mjs',
  'runs-blob.mjs',
];

export const assetNameFor = (mod) => `bk-${mod.replace(/\.mjs$/, '.js')}`;
export const specifierFor = (mod) => `./${assetNameFor(mod)}`;

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Rewrite `from './runs-x.mjs'` to the asset beside it on the CDN. The only edit this script makes. */
export function rewriteImports(source) {
  return source.replace(/from '\.\/(runs-[a-z-]+)\.mjs'/g, (_, name) => `from './bk-${name}.js'`);
}

export function buildExport() {
  const out = { modules: [], canon: 'BKR1', generated_by: 'scripts/export-verifier.mjs' };
  for (const mod of VERIFIER_MODULES) {
    const src = readFileSync(path.join(ROOT, 'lib', mod), 'utf8');
    if (/from 'node:/.test(src)) {
      throw new Error(`lib/${mod} imports a node builtin; it cannot run in a browser and must not be exported`);
    }
    const body = rewriteImports(src);
    // Every runs-* import must have been rewritten, or the asset would 404 at runtime in a way that only
    // shows up when a buyer opens the page.
    const missed = body.match(/from '\.\/[^']*\.mjs'/g);
    if (missed) throw new Error(`lib/${mod} has imports this script cannot rewrite: ${missed.join(', ')}`);
    out.modules.push({
      module: mod,
      asset: assetNameFor(mod),
      specifier: specifierFor(mod),
      source_sha256: sha256(src),
      bytes: Buffer.byteLength(body, 'utf8'),
      body,
    });
  }
  return out;
}

/** The manifest both repositories keep. Bodies are stripped — only the hashes travel. */
export const manifestOf = (built) => ({
  canon: built.canon,
  generated_by: built.generated_by,
  modules: built.modules.map(({ module, asset, specifier, source_sha256 }) =>
    ({ module, asset, specifier, source_sha256 })),
});

function main() {
  const built = buildExport();
  const manifest = manifestOf(built);
  const manifestPath = path.join(ROOT, 'data', 'verifier-manifest.json');
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  if (CHECK) {
    if (!existsSync(manifestPath)) { console.error('no manifest yet — run without --check'); process.exitCode = 1; return; }
    // EOL-normalised, not byte-compared. core.autocrlf is true in this repo and there is no
    // .gitattributes, so a fresh clone checks this file out with CRLF while JSON.stringify always emits
    // LF. A byte comparison would fail on a clean checkout and pass on the machine that wrote it, which
    // is the worst possible shape for a drift check.
    const have = readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n');
    const same = have === json;
    console.log(same ? 'manifest matches the sources' : 'MANIFEST IS STALE — re-run without --check');
    if (!same) process.exitCode = 1;
    return;
  }

  writeFileSync(manifestPath, json);
  console.log(`wrote ${path.relative(ROOT, manifestPath)}`);

  const assets = path.join(THEME, 'assets');
  if (!existsSync(assets)) {
    console.log(`theme not found at ${THEME} — manifest written, assets skipped`);
    return;
  }
  mkdirSync(assets, { recursive: true });
  for (const m of built.modules) {
    writeFileSync(path.join(assets, m.asset), m.body);
    console.log(`  ${m.asset.padEnd(28)} ${m.bytes} bytes  ${m.source_sha256.slice(0, 16)}…`);
  }
  writeFileSync(path.join(assets, 'bk-verifier-manifest.json'), json);
  console.log(`  bk-verifier-manifest.json    ${built.modules.length} modules`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('export-verifier.mjs')) main();
