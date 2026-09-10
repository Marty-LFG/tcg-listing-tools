// test/invariants/runs-verifier-export.test.mjs — the storefront verifier must not drift from this one.
//
// THE FAILURE THIS PREVENTS IS THE WORST ONE IN THE MODULE. The verification page lives in a different
// repository served by Shopify, so it cannot import from here at runtime and the modules have to be
// COPIED. A copy is exactly what Golden Rule 9 warns about — lib/normalize.mjs is the standing lesson
// that a hand-maintained mirror drifts.
//
// And the direction of the damage matters. A drifted verifier does not let a bad bundle through; it FAILS
// AN HONEST ONE. The buyer of a perfectly good parcel is told their card was swapped, on a page whose
// whole purpose is to be believed. That is worse than not verifying at all.
//
// So the source hash of every exported module is recorded on both sides, and this re-hashes the sources.
// Change a module without re-running scripts/export-verifier.mjs and this fails immediately, naming the
// module — rather than a buyer finding out months later.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERIFIER_MODULES, buildExport, manifestOf, rewriteImports, assetNameFor, specifierFor } from '../../scripts/export-verifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = path.join(ROOT, 'data', 'verifier-manifest.json');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('the exported verifier is current', () => {
  it('a manifest exists', () => {
    assert.ok(existsSync(MANIFEST), 'run scripts/export-verifier.mjs');
  });

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

  it('covers every module the page needs, in dependency order', () => {
    assert.deepEqual(manifest.modules.map((m) => m.module), [...VERIFIER_MODULES]);
  });

  for (const entry of JSON.parse(readFileSync(MANIFEST, 'utf8')).modules) {
    it(`${entry.module} has not changed since it was exported`, () => {
      // THE CHECK. If this fails, the storefront is running a different verifier than this repository
      // believes — re-run scripts/export-verifier.mjs and commit both sides.
      const src = readFileSync(path.join(ROOT, 'lib', entry.module), 'utf8');
      assert.equal(sha256(src), entry.source_sha256,
        `lib/${entry.module} changed but the verifier export was not re-run`);
    });
  }

  it('and the manifest as a whole matches a fresh build', () => {
    // EOL-NORMALISED ON READ, and that is not laziness. core.autocrlf is true in this repo and there
    // is no .gitattributes, so a fresh clone checks the manifest out with CRLF while JSON.stringify
    // always emits LF. A byte comparison would therefore fail on a clean checkout and pass on the
    // machine that wrote the file - the worst possible shape for a drift check. The content is what
    // must match; the line endings are git's business.
    const fresh = `${JSON.stringify(manifestOf(buildExport()), null, 2)}\n`;
    const have = readFileSync(MANIFEST, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(have, fresh, 're-run scripts/export-verifier.mjs');
  });
});

describe('every exported module can actually run in a browser', () => {
  for (const mod of VERIFIER_MODULES) {
    it(`${mod} imports no node builtin`, () => {
      // A node: import added later would break the storefront page and nothing else would notice until a
      // buyer scanned an insert. The export script refuses too; this says so where it is readable.
      const src = readFileSync(path.join(ROOT, 'lib', mod), 'utf8');
      assert.ok(!/from 'node:/.test(src), `lib/${mod} imports a node builtin`);
    });
  }

  it('and the isomorphic set is closed — nothing imports outside it', () => {
    // A module importing one that is NOT exported would 404 on the storefront at runtime.
    const exported = new Set(VERIFIER_MODULES);
    for (const mod of VERIFIER_MODULES) {
      const src = readFileSync(path.join(ROOT, 'lib', mod), 'utf8');
      for (const m of src.matchAll(/from '\.\/([a-z0-9-]+\.mjs)'/g)) {
        assert.ok(exported.has(m[1]), `lib/${mod} imports ${m[1]}, which is not exported to the theme`);
      }
    }
  });
});

describe('the rewrite is the only edit', () => {
  it('points a runs-* import at the asset sitting beside it on the CDN', () => {
    // A BARE specifier would be tidier and is not available: it needs an import map, which lives in the
    // theme's snippets/scripts.liquid — an upstream file NOT on that repository's closed permitted-edit
    // list. Relative works because assets/ is flat, so every module is served from one directory.
    assert.equal(rewriteImports("import { ns } from './runs-canonical.mjs';"),
      "import { ns } from './bk-runs-canonical.js';");
  });

  it('and changes nothing else', () => {
    const built = buildExport();
    for (const m of built.modules) {
      const src = readFileSync(path.join(ROOT, 'lib', m.module), 'utf8');
      // Identical once the import lines are normalised away on both sides. That equivalence is what makes
      // hashing the SOURCE a meaningful check on the exported ASSET.
      const strip = (s) => s.replace(/from '\.\/(runs-[a-z-]+\.mjs|bk-runs-[a-z-]+\.js)'/g, 'IMPORT');
      assert.equal(strip(m.body), strip(src), `${m.module} was altered beyond its imports`);
    }
  });

  it('names assets and specifiers predictably', () => {
    // The bk- prefix is load-bearing in the theme: its upstream-drift audit is
    // `git diff --name-only ... | grep -v '/bk-'`, so anything else appears in that output forever as an
    // apparently-touched upstream file.
    assert.equal(assetNameFor('runs-merkle.mjs'), 'bk-runs-merkle.js');
    assert.equal(specifierFor('runs-merkle.mjs'), './bk-runs-merkle.js');
  });
});
