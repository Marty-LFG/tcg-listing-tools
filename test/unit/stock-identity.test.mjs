// test/unit/stock-identity.test.mjs — "do we already hold this card?" (AGENTS.md §16b).
// Three writers describe the same card differently, so identity is compared on normalised tokens.
// Condition and finish are PART of the identity: a Lightly Played copy is separate stock from a Near
// Mint one, gets its own label and its own listing, and merging them would misprice both.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conditionKey, variantKey, stockKey } from '../../lib/inventory.mjs';

const base = { game: 'pokemon', identity_key: 'swsh11-69', variant: 'Holo', language: 'EN', condition: 'Near Mint' };

describe('conditionKey — one token across three writers', () => {
  it('agrees no matter which part of the app wrote the row', () => {
    // uploader | bulk/builder | eBay's own enum — all the same physical condition.
    assert.equal(conditionKey('Ungraded, Near Mint'), 'NM');
    assert.equal(conditionKey('Near Mint'), 'NM');
    assert.equal(conditionKey('Near Mint or Better'), 'NM');
  });
  it('keeps the played grades apart', () => {
    assert.equal(conditionKey('Lightly Played (Excellent)'), 'LP');
    assert.equal(conditionKey('Moderately Played (Very Good)'), 'MP');
    assert.equal(conditionKey('Heavily Played (Poor)'), 'HP');
  });
  it('unknown is its own thing and never silently equals Near Mint', () => {
    assert.equal(conditionKey(''), '');
    assert.equal(conditionKey(null), '');
    assert.equal(conditionKey('who knows'), 'OTHER');
    assert.notEqual(conditionKey(''), conditionKey('Near Mint'));
  });
});

describe('variantKey — the Non-holo trap', () => {
  it('does not read "Non-holo" as holo', () => {
    // "Non-holo" contains "holo": testing /holo/ first stored (and listed) plain cards as Holo.
    assert.equal(variantKey('Non-holo'), 'BASE');
    assert.equal(variantKey('non foil'), 'BASE');
    assert.equal(variantKey('Holo'), 'HOLO');
  });
  it('reverse is its own finish, not a holo', () => {
    assert.equal(variantKey('Reverse Holo'), 'REVERSE');
    assert.notEqual(variantKey('Reverse Holo'), variantKey('Holo'));
  });
  it('treats the empty/base spellings as one', () => {
    for (const v of ['', 'Base', 'Normal', 'Regular']) assert.equal(variantKey(v), 'BASE');
  });
});

describe('stockKey — same physical thing, or not', () => {
  it('matches the same card written by two different parts of the app', () => {
    assert.equal(stockKey({ ...base, condition: 'Ungraded, Near Mint' }), stockKey({ ...base, condition: 'Near Mint' }));
  });
  it('separates by condition — a played copy is its own stock line', () => {
    assert.notEqual(stockKey(base), stockKey({ ...base, condition: 'Lightly Played' }));
  });
  it('separates by finish', () => {
    assert.notEqual(stockKey(base), stockKey({ ...base, variant: 'Reverse Holo' }));
    assert.notEqual(stockKey(base), stockKey({ ...base, variant: 'Non-holo' }));
  });
  it('separates by language', () => {
    assert.notEqual(stockKey(base), stockKey({ ...base, language: 'JP' }));
  });
  it('a graded slab is never the same stock as a raw copy, and grades differ from each other', () => {
    const psa10 = { ...base, graded: 1, grading_company: 'PSA', grade: 10 };
    const psa9 = { ...psa10, grade: 9 };
    assert.notEqual(stockKey(psa10), stockKey(base));
    assert.notEqual(stockKey(psa10), stockKey(psa9));
    assert.notEqual(stockKey(psa10), stockKey({ ...psa10, grading_company: 'BGS' }));
  });
  it('a graded row ignores the raw condition text it may still carry', () => {
    const a = { ...base, graded: 1, grading_company: 'PSA', grade: 10, condition: 'Near Mint' };
    const b = { ...base, graded: 1, grading_company: 'PSA', grade: 10, condition: 'Lightly Played' };
    assert.equal(stockKey(a), stockKey(b));
  });
});
