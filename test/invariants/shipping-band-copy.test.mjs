// test/invariants/shipping-band-copy.test.mjs — the band table exists in three places that must agree:
// DEFAULT_BANDS in lib/shipping-bands.mjs (the mirror source the copy harnesses run against), the
// tracked example config (what a fresh install gets seeded with), and the inline copies in the eight
// builders (covered by builder-wording.test.mjs).
//
// The failure this catches is quiet and expensive: the code default says $1.70 while the config the
// server actually loaded says $8.26, so a description quotes one number and eBay charges the buyer the
// other. That is a "not as described" claim on every listing in the band.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';
import {
  DEFAULT_BANDS, DEFAULT_MIN_BAND_FOR_SLAB, POSTAGE_COPY, validateBands, postagePhrase, money,
} from '../../lib/shipping-bands.mjs';

const example = JSON.parse(read('data/ebay-listing.config.example.json'));

describe('DEFAULT_BANDS vs the tracked example config', () => {
  it('the band tables are identical', () => {
    assert.deepEqual(example.shipping.bands, DEFAULT_BANDS);
  });
  it('the slab floor is identical', () => {
    assert.equal(example.shipping.minBandForSlab, DEFAULT_MIN_BAND_FOR_SLAB);
  });
});

describe('DEFAULT_BANDS is a legal table', () => {
  it('passes its own validator', () => {
    assert.equal(validateBands(DEFAULT_BANDS), null);
  });
  it('every band names a wording template that exists', () => {
    for (const b of DEFAULT_BANDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(POSTAGE_COPY, b.copy), `${b.id} → ${b.copy}`);
    }
  });
  it('the description can never quote a number the config does not hold', () => {
    for (const b of DEFAULT_BANDS) {
      assert.ok(postagePhrase(b).includes(money(b.costCents)), `${b.id} does not quote ${money(b.costCents)}`);
    }
  });
  it('every band charges the buyer — nothing is free any more', () => {
    for (const b of DEFAULT_BANDS) assert.ok(b.costCents > 0, `${b.id} charges ${b.costCents}c`);
  });
  it('graded slabs never travel on the untracked band', () => {
    assert.ok(DEFAULT_MIN_BAND_FOR_SLAB >= 1);
    assert.match(postagePhrase(DEFAULT_BANDS[DEFAULT_MIN_BAND_FOR_SLAB]), /tracked/i);
  });
});
