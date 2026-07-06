// test/invariants/check-harnesses.test.mjs — runs the six scripts/check-*.mjs harnesses
// (AGENTS.md §8/§14). They stay the single source of truth for mirror parity (Golden
// Rules 6/9): builders ⇄ lib/listing-copy.mjs ⇄ lib/normalize.mjs, pricing precedence,
// Collectr parsing, enumeration, eBay CSV goldens. This wrapper just makes them
// unforgettable. All six are offline (stubbed fetch / :memory: DBs / local fixtures).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';

const HARNESSES = [
  'check-pricing.mjs',
  'check-listing-copy.mjs',
  'check-collectr.mjs',
  'check-collectr-graded.mjs',
  'check-collectr-ebay.mjs',
  'check-enumerate.mjs',
];

describe('scripts/check-* harnesses', () => {
  for (const script of HARNESSES) {
    it(script, () => {
      const r = spawnSync(process.execPath,
        ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts', script)],
        { encoding: 'utf8', cwd: ROOT, timeout: 60_000 });
      const fails = (r.stdout + r.stderr).split('\n').filter((l) => l.startsWith('FAIL')).join('\n');
      assert.equal(r.status, 0, `${script} exited ${r.status}\n${fails || r.stderr.slice(0, 2000)}`);
    });
  }
});
