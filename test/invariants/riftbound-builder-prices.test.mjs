// test/invariants/riftbound-builder-prices.test.mjs — the Riftbound builder must get its market
// price from the KEYLESS lane, on every source.
//
// History: Scrydex was the only source with prices, its subscription lapsed (402), and all three
// builder lanes then rendered "No live price source — switch to the Scrydex source", advice that
// could not possibly work. Prices now come from /api/riftbound/prices on offline / riftscribe /
// scrydex alike. These assertions pin the two things that were easy to get wrong.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, extractFn } from '../helpers/extract-inline.mjs';

const src = read('riftbound-listing-builder.html');

describe('every lookup lane overlays the keyless price', () => {
  it('the shared helper exists and calls the keyless endpoint', () => {
    assert.match(src, /function rbPriceEnrich\(/);
    assert.match(src, /\/api\/riftbound\/prices\//);
  });
  it('all FOUR lanes call it — offline, riftscribe, scrydex and the rune path', () => {
    // 3 lanes + the rune path, which returns early from two of them and so needs its own call.
    const calls = src.match(/rbPriceEnrich\(document\.getElementById\(["']extras["']\)/g) || [];
    assert.ok(calls.length >= 4, 'expected >=4 rbPriceEnrich call sites, found ' + calls.length);
  });
  it('no priceNote still tells the user to switch to Scrydex for a price', () => {
    // The dead advice lived in three separate priceNote strings. Check the NOTES, not the whole
    // file — the helper's own comment quotes the old wording to explain why it went.
    const notes = [...src.matchAll(/priceNote\s*[:=]\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    assert.ok(notes.length >= 3, 'expected to find the priceNote strings, found ' + notes.length);
    const offenders = notes.filter((n) => /switch to the Scrydex/i.test(n));
    assert.deepEqual(offenders, [], 'a lane still points at Scrydex for pricing — that subscription is inactive');
  });
});

describe('rbPriceEnrich — the identity-key trap', () => {
  const fn = extractFn(src, 'function rbPriceEnrich');
  it('normalises the number itself instead of trusting a passed-in key', () => {
    // The scrydex lane's own _trk key is `ogn-027a` (number AS TYPED) while the price index is
    // keyed by normNum (`OGN-27a`). Accepting a pre-built key would silently miss on that lane.
    assert.match(fn, /normNum\(/, 'must build the key with normNum()');
    assert.match(fn, /toUpperCase\(\)/, 'must upper-case the set code');
  });
  it('distinguishes "no price yet" (404) from "index never baked" (503)', () => {
    assert.match(fn, /503/);
    assert.match(fn, /not baked/i);
  });
  it('feeds the resolved price to the tracker, not just the display', () => {
    assert.match(fn, /_trk\.price\s*=/);
  });
  it('is failure-tolerant — a dead price lane must never block listing (GR7)', () => {
    assert.match(fn, /\.catch\(/);
    assert.match(fn, /try\{/);
  });
});

describe('rune reprints do not borrow the Origins price', () => {
  it('prices a rune only when the set is OGN', () => {
    // Runes are reprinted per set with DIFFERENT art; the index carries only the Origins printing.
    // Showing Origins' figure for an SFD reprint is the same class of error the image handling
    // directly above it goes out of its way to avoid.
    const rune = extractFn(src, 'function runeFill');
    assert.match(rune, /code===['"]OGN['"]/, 'rune pricing must be gated on the Origins set');
    assert.match(rune, /rune reprint/i, 'a reprint must say why it has no price');
  });
});
