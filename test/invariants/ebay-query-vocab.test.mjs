// test/invariants/ebay-query-vocab.test.mjs — the search vocabulary cannot fall behind the rest
// of the suite.
//
// lib/ebay-query.mjs must stay node-free so the browser can import it, which means its grader and
// grade-scale tables are LITERALS rather than reads of data/grading-companies.json. That is the
// right trade, but it leaves a gap: add a company to the registry and the query builder stays
// blind to it, silently, forever. These tests close that gap structurally instead of by memory.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRADERS, GRADE_STEP, PACKS, isUnsafeExclusion } from '../../lib/ebay-query.mjs';
import { PROFESSIONAL_GRADER, CARD_CONDITION, GAME_ASPECT, ASPECT_FILL, TRUST_FILL, aspectIsTrusted } from '../../lib/ebay-vocab.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'grading-companies.json'), 'utf8'));
const CODES = registry.companies.map((c) => c.code);

describe('the grader vocabulary tracks data/grading-companies.json', () => {
  it('every registered company has a grade scale, so its ladder generates correctly', () => {
    const missing = CODES.filter((c) => !GRADE_STEP[c]);
    assert.deepEqual(missing, [], 'add these to GRADE_STEP in lib/ebay-query.mjs — without a step, '
      + 'gradeExclusionLadder falls back to 0.5 and a whole-number company gets phantom half grades');
  });

  it('every registered company is either excludable or explains why not', () => {
    for (const code of CODES) {
      const g = GRADERS[code];
      if (!g) continue;   // unknown to the search vocabulary is fine; unexplained is not
      if (g.safe === false) assert.ok(g.why, code + ' is marked unsafe with no reason recorded');
    }
  });

  // A slab we can LIST but cannot SEARCH for is a one-way door: the listing carries the grader
  // aspect and the comps query has no idea the company exists.
  it('every grader we can publish with is known to the search vocabulary', () => {
    const unknown = Object.keys(PROFESSIONAL_GRADER).filter((c) => !GRADERS[c]);
    assert.deepEqual(unknown, [], 'these appear in lib/ebay-vocab.mjs PROFESSIONAL_GRADER but not in GRADERS');
  });
});

describe('the exclusion packs stay safe', () => {
  it('no pack contains a term that would delete the card being priced', () => {
    for (const [key, pack] of Object.entries(PACKS)) {
      for (const term of pack.terms) {
        const why = isUnsafeExclusion(term);
        assert.equal(why, null, `PACKS.${key} ships -${term}, which is unsafe: ${why}`);
      }
    }
  });

  it('every pack has a human label, because each is a checkbox someone has to understand', () => {
    for (const [key, pack] of Object.entries(PACKS)) {
      assert.ok(pack.label && pack.label.length > 2, key + ' has no label');
      assert.ok(Array.isArray(pack.terms) && pack.terms.length, key + ' is empty');
    }
  });
});

describe('aspect trust is driven by measured fill, not by preference', () => {
  // The rule the whole structured mode rests on: gate on an aspect only where sellers actually
  // fill the field in. Filter on a sparse one and the listings that merely left it blank vanish
  // along with the genuine misses.
  it('only well-filled aspects are trusted', () => {
    for (const [name, a] of Object.entries(ASPECT_FILL)) {
      const trusted = aspectIsTrusted(name, { graded: true });
      assert.equal(trusted, a.fill >= TRUST_FILL, name + ' trust disagrees with its measured fill');
    }
  });

  it('Finish and Speciality are never trusted — under half of listings fill them in', () => {
    for (const n of ['Finish', 'Speciality']) {
      assert.equal(aspectIsTrusted(n, { graded: true }), false, n + ' is too sparse to gate a search');
      assert.ok(ASPECT_FILL[n].fill < 50);
    }
  });

  // Grade and Professional Grader read as ~2.4% filled against ALL listings, which looks like a
  // reason to never touch them — but they only apply to slabs, and within that population they are
  // 99.4% and 94.2%. Conditioning on the sub-population is the difference between "useless" and
  // "the best signal available", so the basis must be recorded, not just the number.
  it('graded-only aspects are trusted for a slab and undefined for a raw card', () => {
    for (const n of ['Grade', 'Professional Grader']) {
      assert.equal(ASPECT_FILL[n].basis, 'graded', n + ' must record which population it was measured against');
      assert.equal(aspectIsTrusted(n, { graded: true }), true, n);
      assert.equal(aspectIsTrusted(n, { graded: false }), false, n + ' is not merely sparse on a raw card, it is undefined');
    }
  });

  it('an unknown aspect is never trusted', () => {
    assert.equal(aspectIsTrusted('Nonsense'), false);
  });
});

describe('exact-case aspect values', () => {
  // eBay does not reject a wrongly-cased aspect value — it drops the filter and returns the
  // UNFILTERED set, which reads exactly like a filter that matched everything. Nothing downstream
  // can detect that, so the strings are pinned here.
  it('the four card conditions, character for character', () => {
    assert.deepEqual(CARD_CONDITION, [
      'Near Mint or Better',
      'Lightly Played (Excellent)',
      'Moderately Played (Very Good)',
      'Heavily Played (Poor)',
    ]);
  });

  it('grader values carry their parenthesised code, as the live enum does', () => {
    assert.equal(PROFESSIONAL_GRADER.PSA, 'Professional Sports Authenticator (PSA)');
    assert.equal(PROFESSIONAL_GRADER.CGA, 'Card Grading Australia (CGA)');
    for (const [code, value] of Object.entries(PROFESSIONAL_GRADER)) {
      assert.ok(value.includes('(' + (code === 'TAG' ? 'TAG' : code) + ')'), code + ' -> ' + value);
    }
  });

  // `Game` is the ONE required aspect on 183454 and it is FREE_TEXT, so a near-miss earns no facet
  // and never errors. Two of these shipped wrong for months.
  it('game aspects match the live enum members', () => {
    assert.equal(GAME_ASPECT.pokemon, 'Pokémon TCG', 'accented e');
    assert.equal(GAME_ASPECT.lorcana, 'Disney Lorcana TCG');
    assert.equal(GAME_ASPECT.riftbound, 'Riftbound: League of Legends TCG');
    assert.equal(GAME_ASPECT.mtg, 'Magic: The Gathering');
  });
});

describe('lib/ebay-query.mjs and lib/ebay-vocab.mjs stay browser-importable', () => {
  for (const f of ['lib/ebay-query.mjs', 'lib/ebay-vocab.mjs']) {
    it(f + ' has no node-only imports', () => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!/from 'node:/.test(src), 'a node: import would break every page that imports this');
      assert.ok(!/require\(/.test(src));
    });
  }
});
