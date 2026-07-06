// test/invariants/no-secrets.test.mjs — Golden Rule 2: real keys live only in .env
// (gitignored). Scans every git-TRACKED text file for key-shaped values. Placeholders
// (.env.example) are allowed by shape: real keys are long token strings, placeholders
// are short/descriptive.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../helpers/extract-inline.mjs';

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .filter((f) => /\.(mjs|js|json|html|md|css|cmd|ps1|service|yaml|yml|example)$/i.test(f))
  // vendored bulk data can't contain our keys and is large
  .filter((f) => !f.startsWith('data/funko_pop') && !f.startsWith('data/riftbound') && !f.startsWith('data/pokemon-'));

const SUSPECTS = [
  // KEY/TOKEN/SECRET assigned a long opaque literal (real keys are 20+ chars, no spaces)
  { name: 'assigned credential', re: /(?:API_KEY|_TOKEN|_SECRET|_ID|APP_ID|CERT_ID)\s*[=:]\s*['"]?[A-Za-z0-9+/][A-Za-z0-9+/_.~-]{24,}['"]?/g },
  // Telegram bot token shape
  { name: 'telegram token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  // Scrydex/eBay style long hex blobs next to an auth-ish word
  { name: 'bearer literal', re: /Bearer\s+[A-Za-z0-9+/_.~-]{30,}/g },
];

// Legitimate long tokens that match the shapes above but aren't secrets.
const ALLOW = [
  /\bintegrity\s*[=:]/i,           // SRI hashes
  /PLACEHOLDER|[=:]\s*['"]?your[-_]|xxxx|<[^>]+>|\.\.\./i,   // .env.example 'your_*' convention
  /oauth\/api_scope/,              // eBay scope URLs
  /sha(256|384|512)-/i,
];

describe('no hardcoded secrets in tracked files (GR2)', () => {
  it(`scans ${tracked.length} tracked text files`, () => {
    assert.ok(tracked.length > 30, 'git ls-files returned suspiciously few files');
    const hits = [];
    for (const rel of tracked) {
      let text;
      try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
      for (const s of SUSPECTS) {
        for (const m of text.matchAll(s.re)) {
          const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
          if (ALLOW.some((a) => a.test(line))) continue;
          hits.push(`${rel}: [${s.name}] ${line.trim().slice(0, 120)}`);
        }
      }
    }
    assert.deepEqual(hits, [], 'possible hardcoded secrets:\n' + hits.join('\n'));
  });

  it('.env is not tracked', () => {
    assert.ok(!tracked.includes('.env'), '.env must never be committed');
  });
});
