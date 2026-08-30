// test/unit/set-code.test.mjs — resolving a printed set code from whatever a stock row calls its set.
//
// The rule this file exists to hold: EVERY match must be a re-spelling of the name the row already
// carries, never a nearest neighbour. A wrong set code is worse than a blank one, because D-016/D-027
// key the automated per-set collections on bkc.set_code — so a wrong code files the card into the wrong
// collection, where it looks deliberate. A blank one is an obvious gap someone will fix.
//
// These assertions run against the REAL cached set list, which is the point: a resolver tested only
// against fixtures would prove nothing about the names actually in stock. The four that cannot resolve
// are asserted as unresolved deliberately — that is the correct answer, not a gap in the test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSetCode, nameCandidates } from '../../lib/set-code.mjs';

const code = (set_name, language = 'EN') => resolveSetCode({ game: 'pokemon', set_name, language }).code;

describe('set code resolution', () => {
  it('resolves a clean English set name', () => {
    assert.equal(code('Lost Origin'), 'LOR');
    assert.equal(code('Paldea Evolved'), 'PAL');
    assert.equal(code('Steam Siege'), 'STS');
  });

  it('resolves a name with a colon, without needing the tail', () => {
    assert.equal(code('Hidden Fates: Shiny Vault'), 'HIF');
    assert.equal(code('Crown Zenith: Galarian Gallery'), 'CRZ');
  });

  // The scraped eBay titles. These are the reason the module exists.
  it('drops a leading "POKEMON"', () => {
    assert.equal(code('POKEMON LOST ORIGIN'), 'LOR');
  });

  it('drops a leading SERIES name, taken from the cache rather than hardcoded', () => {
    assert.equal(code('POKEMON SWORD & SHIELD BRILLIANT STARS'), 'BRS');
  });

  it('drops a language word and reads a code-dash-name title', () => {
    assert.equal(code('POKEMON JAPANESE SV4M-FUTURE FLASH', 'JA'), 'SV4M');
  });

  // A non-English row must be answered from its OWN index. Snow Hazard exists in both lists, and
  // handing back the English code for a Japanese card is exactly the wrong-collection failure.
  it('answers a Japanese row from the Japanese index', () => {
    assert.equal(code('Snow Hazard', 'JA'), 'SV2P');
  });

  it('leaves an already-set code alone rather than re-deriving it', () => {
    const r = resolveSetCode({ game: 'pokemon', set_name: 'Lost Origin', set_code: 'XYZ' });
    assert.equal(r.code, 'XYZ');
    assert.equal(r.via, 'already set');
  });

  // --- the refusals, which matter more than the matches -----------------------------------------
  it('REFUSES to guess when the name is not a set it knows', () => {
    // "POKEMON ROCKET" is the Team Rocket set. A fuzzy matcher would find it; this must not, because
    // the same fuzziness would confidently mis-file a dozen other rows.
    assert.equal(code('POKEMON ROCKET'), null);
    assert.equal(code('Generations: Radiant Collection'), null);
    assert.equal(code('a set that does not exist'), null);
  });

  it('refuses a non-Pokémon game rather than searching the Pokémon list', () => {
    assert.equal(resolveSetCode({ game: 'mtg', set_name: 'Lost Origin' }).code, null);
  });

  it('returns nothing for an empty or missing set name, without throwing', () => {
    assert.equal(code(''), null);
    assert.equal(code(null), null);
    assert.equal(resolveSetCode({}).code, null);
  });

  // The report is the product for anything unresolved — an operator who is only told "no" has to redo
  // the search by hand, which is how a backfill turns into a guessing exercise.
  it('shows every spelling it tried, so a human can see WHY it missed', () => {
    const r = resolveSetCode({ game: 'pokemon', set_name: 'POKEMON SWORD & SHIELD SOME MADE UP SET' });
    assert.equal(r.code, null);
    assert.ok(r.candidates.length > 1, 'a single candidate means the variants never ran');
    assert.ok(r.candidates.some((c) => /^SOME MADE UP SET$/i.test(c)), 'the series-stripped spelling must be among them');
  });

  it('names the spelling that matched, so a lucky match can be spotted', () => {
    const r = resolveSetCode({ game: 'pokemon', set_name: 'POKEMON SWORD & SHIELD BRILLIANT STARS' });
    assert.equal(r.code, 'BRS');
    assert.equal(r.via, 'BRILLIANT STARS');
  });

  it('never offers duplicate candidates', () => {
    const c = nameCandidates('Lost Origin');
    assert.equal(c.length, new Set(c).size);
  });
});
