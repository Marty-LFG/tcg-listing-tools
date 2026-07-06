// test/invariants/inline-syntax.test.mjs — AGENTS.md §8, automated: every inline
// <script> in every root HTML page must parse. Classic blocks are checked as .js,
// type="module" blocks as .mjs (node --check picks the goal from the extension).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, read, inlineScripts } from '../helpers/extract-inline.mjs';
import { tmpDir } from '../helpers/tmp.mjs';

const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const dir = tmpDir('tcg-syntax-');

describe('inline <script> syntax (node --check)', () => {
  assert.ok(pages.length >= 10, `expected the tool pages at repo root, found ${pages.length}`);
  for (const page of pages) {
    it(page, () => {
      const blocks = inlineScripts(read(page));
      for (const [i, b] of blocks.entries()) {
        const file = path.join(dir, `${page.replace(/\W+/g, '_')}_${i}.${b.type === 'module' ? 'mjs' : 'js'}`);
        fs.writeFileSync(file, b.body);
        const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(r.status, 0, `${page} inline script #${i} (${b.type}):\n${r.stderr.slice(0, 1500)}`);
      }
    });
  }
});

// The root-level classic shared scripts get the same treatment.
describe('shared classic scripts', () => {
  for (const f of ['extras.js', 'grade-rules.js']) {
    it(f, () => {
      const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr.slice(0, 1500));
    });
  }
});
