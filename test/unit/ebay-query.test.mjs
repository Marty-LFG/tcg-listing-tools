// test/unit/ebay-query.test.mjs — the search plan (lib/ebay-query.mjs).
//
// The assertions that matter here are the ones protecting against SILENT failure. Three of the four
// ways this module can go wrong produce no error at all:
//   - a wrongly-cased aspect value is ignored by eBay and returns the unfiltered set
//   - an unsafe exclusion (-EX, -HP) deletes the card you are pricing
//   - a query that excludes a slab's own grader while requiring it returns nothing
// None of those throw, so only a test catches them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEbayQuery, isUnsafeExclusion, gradeGroups, gradeExclusionLadder,
  GRADERS, PACKS, MODES, cardConditionValue,
} from '../../lib/ebay-query.mjs';
import { CARD_CONDITION, PROFESSIONAL_GRADER, GAME_ASPECT } from '../../lib/ebay-vocab.mjs';

const CHARIZARD = {
  game: 'pokemon', name: 'Charizard ex', number: '199/165',
  setName: 'Scarlet & Violet 151', lang: 'en', condition: 'Near Mint',
};

describe('modes and the include-core budget', () => {
  // The measurement this whole module is built around: keeping the game word and set name in a
  // query that also carries an exclusion took a real card from 38 results to 6, because any
  // exclusion flips eBay to literal matching. A mode that excludes MUST cap the core.
  it('recall keeps every field and emits no exclusions — byte-identical to what we send today', () => {
    const p = buildEbayQuery(CHARIZARD, { mode: 'recall' });
    assert.equal(p.nkw, 'Pokemon Charizard ex 199/165 Scarlet & Violet 151');
    assert.deepEqual(p.excludes, []);
    assert.equal(p.browse.aspect_filter, null);
    assert.deepEqual(p.core.dropped, []);
  });

  it('every mode that excludes also caps the core, and says what it dropped', () => {
    for (const mode of Object.keys(MODES)) {
      const p = buildEbayQuery(CHARIZARD, { mode });
      if (!MODES[mode].excludes) continue;
      assert.ok(p.core.fields.length <= MODES[mode].coreFields, mode + ' blew its core budget');
      assert.ok(p.core.dropped.length > 0, mode + ' capped the core but reported no drops');
      assert.match(p.warnings.join(' '), /literal matching/, mode + ' dropped fields without explaining why');
    }
  });

  it('the game word and set name are the first fields given up — they are the expensive ones', () => {
    const dropped = buildEbayQuery(CHARIZARD, { mode: 'structured' }).core.dropped.map((d) => d.field);
    assert.ok(dropped.includes('gameWord'), 'the game word alone took a measured query 85 -> 38');
    assert.ok(dropped.includes('setName'), 'the set name took it 38 -> 6');
  });

  it('name and number survive every mode — they are the card identity', () => {
    for (const mode of Object.keys(MODES)) {
      const p = buildEbayQuery(CHARIZARD, { mode });
      assert.match(p.nkw, /Charizard ex/, mode);
      assert.match(p.nkw, /199\/165/, mode);
    }
  });

  // A structured search replaces the game WORD with the Game ASPECT, which is 98.8% filled and
  // costs no literal token — strictly better than the word that halved the result set.
  it('structured mode swaps the game word for the Game aspect', () => {
    const p = buildEbayQuery(CHARIZARD, { mode: 'structured' });
    assert.doesNotMatch(p.nkw, /Pokemon/);
    assert.deepEqual(p.aspects.Game, [GAME_ASPECT.pokemon]);
    assert.ok(p.core.dropped.some((d) => d.field === 'gameWord' && d.replacedBy === 'Game aspect'));
  });
});

describe('the query and the downstream filter cannot disagree', () => {
  // singlesFilter hard-rejects any title its number regex misses. A mode that drops the number from
  // the core but still demands it downstream asks for a cluster it then throws away wholesale —
  // that is exactly the bug compsNumberMatch was written to fix for Magic.
  it('numberMatch is null whenever the number is not in the query', () => {
    for (const mode of Object.keys(MODES)) {
      const p = buildEbayQuery(CHARIZARD, { mode });
      const inQuery = p.nkw.includes('199/165');
      assert.equal(!!p.filterHints.numberMatch, inQuery, mode + ': query and filter disagree about the number');
    }
  });

  it('Magic drops the number on both halves at once', () => {
    const p = buildEbayQuery({ game: 'mtg', name: 'Smaug the Magnificent', number: '249', setName: 'The Hobbit' }, { mode: 'recall' });
    assert.doesNotMatch(p.nkw, /249/, 'Magic titles rarely carry a collector number');
    assert.equal(p.filterHints.numberMatch, null);
  });
});

describe('unsafe exclusions', () => {
  // -EX and -HP are the two terms most likely to be copied in from a US grader list, and both
  // delete the card being priced.
  it('names the collision for the terms that would delete the card', () => {
    assert.match(isUnsafeExclusion('EX'), /Charizard ex/i);
    assert.match(isUnsafeExclusion('hp'), /hit points/i);
    assert.match(isUnsafeExclusion('-HP'), /Holon Phantoms/i, 'a leading minus must still be recognised');
    assert.match(isUnsafeExclusion('CCG'), /category names/i);
    assert.match(isUnsafeExclusion('TAG'), /Tag All Stars/i);
    assert.match(isUnsafeExclusion('PCA'), /Planechase/i);
    assert.equal(isUnsafeExclusion('PSA'), null, 'PSA is safe to exclude on a raw search');
  });

  it('no unsafe term ever reaches a generated query', () => {
    for (const mode of Object.keys(MODES)) {
      const p = buildEbayQuery(CHARIZARD, { mode, packs: Object.fromEntries(Object.keys(PACKS).map((k) => [k, true])) });
      for (const bad of ['EX', 'HP', 'CCG', 'TAG', 'PCA', 'DCI', 'PGA', 'VGT', 'GX', 'Holo']) {
        assert.doesNotMatch(p.nkw, new RegExp('-' + bad + '\\b', 'i'),
          `${mode} emitted -${bad}: ${isUnsafeExclusion(bad)}`);
      }
    }
  });

  it('no pack ships an unsafe term', () => {
    for (const [key, pack] of Object.entries(PACKS)) {
      for (const term of pack.terms) {
        assert.equal(isUnsafeExclusion(term), null, `pack "${key}" contains -${term}`);
      }
    }
  });

  it('every unsafe grader records WHY, so the UI can explain a disabled checkbox', () => {
    for (const [code, g] of Object.entries(GRADERS)) {
      if (g.safe === false) assert.ok(g.why && g.why.length > 10, code + ' is unsafe with no reason given');
    }
  });

  it('the language pack never fires on a non-English card', () => {
    const p = buildEbayQuery({ ...CHARIZARD, lang: 'ja' }, { mode: 'precision', packs: { languages: true } });
    assert.doesNotMatch(p.nkw, /-Japanese/, 'excluding the language you are searching for returns nothing');
  });
});

describe('graded cards', () => {
  // Requiring "(PSA,PSA8)" while also excluding -PSA asks for a PSA slab and forbids the word PSA
  // in one query. It returns zero, and it returns zero silently.
  it("never excludes the slab's own grading company", () => {
    const p = buildEbayQuery({ ...CHARIZARD, graded: true, company: 'PSA', grade: 8 }, { mode: 'precision' });
    assert.doesNotMatch(p.nkw, /-PSA\b/, 'self-cancelling: the query requires PSA and forbids it');
    assert.match(p.nkw, /-BGS\b/, 'rival graders should still be excluded');
    assert.doesNotMatch(p.nkw, /-Graded\b/, 'the card IS graded — that is the target, not the noise');
  });

  it('keeps the long-form alias of its own grader too', () => {
    const p = buildEbayQuery({ ...CHARIZARD, graded: true, company: 'BGS', grade: 9.5 }, { mode: 'precision' });
    assert.doesNotMatch(p.nkw, /-Beckett/, 'a BGS slab is a Beckett slab');
    assert.match(p.nkw, /-PSA\b/);
  });

  it('gradeGroups matches "PSA 8" written either way, without matching PSA 10', () => {
    assert.deepEqual(gradeGroups('PSA', 8), ['(PSA,PSA8)', '(PSA8,8)']);
  });

  it('the grade ladder steps by the company scale', () => {
    assert.deepEqual(gradeExclusionLadder('PSA', 3), ['-(PSA 2)', '-(PSA 1)'], 'PSA is whole-number');
    assert.deepEqual(gradeExclusionLadder('BGS', 2.5), ['-(BGS 2)', '-(BGS 1.5)', '-(BGS 1)'], 'BGS is half-step');
    assert.deepEqual(gradeExclusionLadder('PSA', null), []);
  });

  // The measured payoff: `Grade:{8}` replaces the twenty -(PSA 7.5) -(PSA 7)... terms outright,
  // and Grade is 99.4% filled WITHIN graded listings (2.4% against all listings is the misleading
  // figure — the aspect only applies to slabs).
  it('structured mode uses the Grade aspect instead of a keyword ladder', () => {
    const p = buildEbayQuery({ ...CHARIZARD, graded: true, company: 'PSA', grade: 8 }, { mode: 'structured' });
    assert.deepEqual(p.aspects.Grade, ['8']);
    assert.deepEqual(p.aspects['Professional Grader'], [PROFESSIONAL_GRADER.PSA]);
    assert.deepEqual(p.aspects.Graded, ['Yes']);
    assert.doesNotMatch(p.nkw, /-\(PSA/, 'the ladder is redundant once Grade binds');
    assert.ok(p.nkwLength < 40, 'structured says in ~20 chars what precision needs ~340 for');
  });

  it('a raw card asks for Graded:{No} and the ungraded condition id', () => {
    const p = buildEbayQuery(CHARIZARD, { mode: 'structured' });
    assert.deepEqual(p.aspects.Graded, ['No']);
    assert.match(p.browse.filter, /conditionIds:\{4000\}/);
    assert.deepEqual(p.filterHints.condIds, ['4000']);
  });
});

describe('aspect values are exact-case', () => {
  // A wrongly-cased value is not an error. eBay drops the filter and returns everything, which is
  // indistinguishable from a filter that matched everything. Measured: `Card Condition:{Near mint
  // or better}` (lowercase m) returned the unfiltered total.
  it('card conditions map onto the four real values, character for character', () => {
    assert.equal(cardConditionValue('Near Mint'), 'Near Mint or Better');
    assert.equal(cardConditionValue('nm'), 'Near Mint or Better');
    assert.equal(cardConditionValue('Lightly Played'), 'Lightly Played (Excellent)');
    assert.equal(cardConditionValue('MP'), 'Moderately Played (Very Good)');
    assert.equal(cardConditionValue('Heavily Played'), 'Heavily Played (Poor)');
    assert.equal(cardConditionValue('DMG'), 'Heavily Played (Poor)');
    assert.equal(cardConditionValue(''), null);
    assert.equal(cardConditionValue('banana'), null);
    for (const v of Object.values(CARD_CONDITION)) {
      assert.equal(cardConditionValue(v), v, 'a real value must round-trip to itself');
    }
  });

  it('the emitted aspect_filter carries the exact strings, not lowercased ones', () => {
    const p = buildEbayQuery(CHARIZARD, { mode: 'structured' });
    assert.ok(p.browse.aspect_filter.includes('Card Condition:{Near Mint or Better}'), p.browse.aspect_filter);
    assert.ok(p.browse.aspect_filter.startsWith('categoryId:183454,'), 'aspect_filter must name its category');
  });
});

describe('always-on guarantees', () => {
  it('every plan restricts to Australian sellers', () => {
    // Comparing AU prices against a worldwide pool is not a comparison — an overseas listing
    // arrives with international freight baked into its delivered price.
    for (const mode of Object.keys(MODES)) {
      assert.match(buildEbayQuery(CHARIZARD, { mode }).browse.filter, /itemLocationCountry:AU/, mode);
    }
  });

  it('survives an empty identity rather than throwing (GR7)', () => {
    const p = buildEbayQuery({}, { mode: 'structured' });
    assert.equal(typeof p.nkw, 'string');
    assert.ok(Array.isArray(p.warnings));
  });
});
