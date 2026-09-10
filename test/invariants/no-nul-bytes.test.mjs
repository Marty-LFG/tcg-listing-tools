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
// `vendor` holds third-party MINIFIED bundles, which legitimately carry control bytes (0x01, 0x03)
// and are not hand-edited; `worktrees` is a checkout of this same tree under .claude, so scanning it
// double-reports every finding against a copy nobody edits.
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', 'logos', 'coverage', 'vendor', 'worktrees']);

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
// WIDENED after a BACKSPACE (0x08) slipped past this file. A tool rewriting source through a
  // non-raw string literal turns a regex \b into the control character it also means, and the result
  // is invisible in every editor and every diff: the regex silently stops matching, so an invariant
  // built on it passes while checking nothing. The NUL rule above would not have caught it.
  //
  // Tab, newline and carriage return are the only control characters source legitimately contains.
  it('and free of every other control character', () => {
    const ALLOWED = new Set([0x09, 0x0a, 0x0d]);
    const bad = [];
    for (const f of walk(ROOT)) {
      const buf = readFileSync(f);
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c < 0x20 && !ALLOWED.has(c)) {
          bad.push(f.slice(ROOT.length + 1) + ' byte ' + i + ' = 0x' + c.toString(16).padStart(2, '0'));
          break;
        }
      }
    }
    assert.deepEqual(bad, [], 'files with a stray control character:\n' + bad.join('\n'));
  });
});
