// test/unit/ebay-map.test.mjs — inventory→eBay aspect mapping helpers (lib/channels/ebay-map.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ebayLanguageName } from '../../lib/channels/ebay-map.mjs';

describe('ebayLanguageName (stored code → eBay Language enum name)', () => {
  it('maps the 2-letter codes the DB actually stores to full names', () => {
    assert.equal(ebayLanguageName('EN'), 'English');   // 100% of rows store 'EN' — was emitting raw "EN"
    assert.equal(ebayLanguageName('JP'), 'Japanese');
    assert.equal(ebayLanguageName('ZH'), 'Chinese');
    assert.equal(ebayLanguageName('KO'), 'Korean');
    assert.equal(ebayLanguageName('en'), 'English');   // case-insensitive
  });
  it('passes an already-full name through unchanged', () => {
    assert.equal(ebayLanguageName('English'), 'English');
  });
  it('unknown code → verbatim (better than dropping); empty/null → English default', () => {
    assert.equal(ebayLanguageName('XX'), 'XX');
    assert.equal(ebayLanguageName(''), 'English');
    assert.equal(ebayLanguageName(null), 'English');
    assert.equal(ebayLanguageName(undefined), 'English');
  });
});
