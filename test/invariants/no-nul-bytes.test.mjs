// test/invariants/no-nul-bytes.test.mjs — no source file may contain a NUL byte.
// A stray '\0' (easy to introduce when a space between quotes is mistyped) makes git treat the file as
// binary AND makes vite's parse5 HTML parser reject the whole page ("unexpected-null-character") — yet
// `node --check` tolerates it inside a string literal, so the inline-syntax sweep does NOT catch it.
// This guard does, across every hand-edited source file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';

const EXTS = new Set(['.html', '.mjs', '.js', '.json', '.css', '.md']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', 'logos', 'coverage']);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue;   // skip .git etc., allow .claude
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); }
    else if (EXTS.has(extname(e.name))) yield p;
  }
}

describe('no NUL bytes in source', () => {
  it('every hand-edited source file is NUL-free', () => {
    const bad = [];
    for (const f of walk(ROOT)) { if (readFileSync(f).includes(0)) bad.push(f.slice(ROOT.length + 1)); }
    assert.deepEqual(bad, [], 'files with a stray NUL byte (breaks vite parse5 + git):\n' + bad.join('\n'));
  });
});
