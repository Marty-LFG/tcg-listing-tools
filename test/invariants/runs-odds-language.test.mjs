// test/invariants/runs-odds-language.test.mjs — counts, never ratios. See docs/RUNS_PLAN.md §2.2
// guardrail 2.
//
// THIS IS A LEGAL CONSTRAINT WEARING A STYLE GUIDE'S CLOTHES. "Five of twenty-five bundles contain a
// chase" is a statement of fact about a fixed edition. "One in five" is the language of a gamble, and in
// Australia that distinction reaches consumer law and gambling-advertising rules rather than taste.
// Deriving the ratio internally is fine; it must never reach copy.
//
// TWO CHECKS, because neither alone is enough:
//
//   THE VOCABULARY, scanned in source — the words that would signal a ratio even without a number.
//   THE OUTPUT, generated across a spread of claim sets — which is where a ratio would actually appear,
//   and which lives in test/unit/runs-guarantee.test.mjs beside the generator it exercises.
//
// A source scan for `%` or `/` is NOT possible in JavaScript: both appear in every regular expression and
// in every line comment. That is why the output check exists and why this file scans words instead.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';

// Word-anchored, and the anchoring is load-bearing rather than tidy — see the self-check below.
const RATIO_WORDS = /\b(odds|chance|chances|probability|probabilities|percent|percentage|per cent|likelihood)\b/i;
// The shape a ratio takes even when it avoids the vocabulary.
const RATIO_FORMS = [
  [/\bone in \w+\b/i, '"one in five"'],
  [/\b\d+\s*in\s*\d+\b/, '"1 in 5"'],
  [/\b\d+\s*:\s*\d+\s*(odds|chance)/i, '"1:5 odds"'],
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// COMMENTS AND REGEX LITERALS ARE STRIPPED FIRST, and both exclusions were forced by real failures of
// this very test:
//
//   COMMENTS. The first run flagged three of its own explanations — lib/runs-guarantee.mjs documents
//   that "one in five" is unreachable, lib/runs-reserve.mjs contains the ordinary English "one in the",
//   and the name of this file, runs-ODDS-language, matches a word boundary. A file explaining what it
//   must never say is the outcome this test wants.
//
//   REGEX LITERALS. lib/runs-guarantee.mjs enforces this same rule as a LOCK GATE, and to detect the
//   word "odds" its pattern has to contain it. A word inside a detector is not copy — it is the thing
//   stopping the copy. Flagging it would mean deleting the guard to satisfy the test that exists to
//   check the guard.
function code(f) {
  return read(f)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
    // A regex literal, conservatively: opens on a slash that is not preceded by an identifier or a
    // closing bracket (which would make it division), and does not span a line.
    .replace(/(^|[=(,:[!&|?{};+\s])\/(?![*/])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[gimsuy]*/g, '$1');
}
// Every module in the runs set that could put words in front of a customer, plus the pages. The list is
// explicit rather than a glob so that adding a runs module is a deliberate act that includes deciding
// whether it emits copy.
function runsSurfaces() {
  const libs = fs.readdirSync(path.join(ROOT, 'lib'))
    .filter((f) => f.startsWith('runs-') && f.endsWith('.mjs'))
    .map((f) => `lib/${f}`);
  const pages = fs.readdirSync(ROOT).filter((f) => f.startsWith('runs') && f.endsWith('.html'));
  return [...libs, 'lib/runs.mjs', ...pages].filter((f) => fs.existsSync(path.join(ROOT, f)));
}

describe('no ratio vocabulary anywhere in the runs modules', () => {
  const files = runsSurfaces();

  it('finds the surfaces to scan', () => {
    assert.ok(files.length >= 5, `only found ${files.join(', ')} — the pattern drifted, not the code`);
    assert.ok(files.includes('lib/runs-guarantee.mjs'), 'the generator itself must be scanned');
    assert.ok(files.includes('runs-intake.html'), 'the pages must be scanned too');
  });

  for (const file of files) {
    it(`${file} uses none of the ratio words`, () => {
      const hits = code(file).split(/\r?\n/)
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => RATIO_WORDS.test(line))
        .map(([n, line]) => `${n}: ${line.trim()}`);
      assert.deepEqual(hits, [], `${file} names a ratio:\n  ${hits.join('\n  ')}`);
    });

    it(`${file} contains no ratio form`, () => {
      const text = code(file);
      for (const [re, label] of RATIO_FORMS) {
        const m = re.exec(text);
        assert.equal(m, null, `${file} contains ${label}: ${m && m[0]}`);
      }
    });
  }
});
// THE SELF-CHECK, and it is not decoration. The obvious way to write the scan above is a plain substring
// search, and a plain search for "ratio" flags the rarity table's own alias — "illustRATIOn Rare" — which
// is a real and required entry. Someone would then "fix" it by renaming the entry, breaking the rarity
// mapping to satisfy a check that was wrong. Anchoring is what makes the scan usable, so it is pinned.
describe('the scan is word-anchored, deliberately', () => {
  it('an unanchored search WOULD flag a legitimate rarity alias', () => {
    const rarity = read('lib/runs-rarity.mjs');
    assert.match(rarity, /illustration rare/i, 'the alias this test is about must still exist');
    assert.ok(/ratio/i.test(rarity), 'an unanchored search hits "illustRATIOn" — which is why it is not used');
  });

  it('and the anchored one does not', () => {
    assert.doesNotMatch(read('lib/runs-rarity.mjs'), RATIO_WORDS);
  });

  // AND THE STRIPPING MUST NOT NEUTER IT. Excluding comments and regex literals is two holes punched in
  // the scan, so this proves a ratio word in an actual STRING still gets caught even on a line that also
  // carries a regex — which is exactly what lib/runs-guarantee.mjs looks like.
  it('still catches a ratio word in a string literal beside a regex', () => {
    const sample = [
      'const DETECT = /\\b(odds|chance)\\b/i;   // a detector, not copy',
      "const COPY = 'your odds are one in five';",
    ].join('\n');
    const stripped = sample
      .split(/\r?\n/).map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
      .replace(/(^|[=(,:[!&|?{};+\s])\/(?![*/])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[gimsuy]*/g, '$1');
    assert.doesNotMatch(stripped, /DETECT = .*odds/, 'the detector regex should have been stripped');
    assert.match(stripped, RATIO_WORDS, 'but the string literal must still be caught');
  });

  it('while still catching the words it exists for', () => {
    for (const bad of ['a 1 in 5 chance', 'the odds are', 'ten percent', 'probability of a hit']) {
      assert.ok(RATIO_WORDS.test(bad) || RATIO_FORMS.some(([re]) => re.test(bad)), bad);
    }
  });
});
