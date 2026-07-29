// test/unit/pkm-resolve-number.test.mjs — the typed-number → pokemontcg.io-number mapping.
//
// pokemontcg.io stores the collector number with each set's OWN alpha prefix and padding, so the
// number a seller reads off the card is NOT the number in the id. `swshp-284` 404s; the card is
// `swshp-SWSH284`. This is what made "No card found. Check the number." the answer for every
// promo, Trainer/Galarian Gallery and Shiny Vault card in the uploader, builder and grader.
//
// Every roster below is REAL upstream data (api.pokemontcg.io, 2026-07-29), not invented — the
// two anomalies are the whole reason this is a roster lookup and not a prefix/padding table:
//   bwp contradicts ITSELF     BW01 BW02 BW03 BW004 BW005 BW06 … BW101
//   the Shiny Vaults disagree  sma = SV1 … SV94   vs   swsh45sv = SV001 … SV122
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read, extractFn } from '../helpers/extract-inline.mjs';

// pkmResolveNumber leans on bareNum(); indexRoster() builds the index it consumes. Pull all three
// out of extras.js so the test exercises the shipped source, not a copy.
const src = read('extras.js');
const sandbox = { TCG: {} };   // the extracted assignment needs a TCG object in scope
vm.createContext(sandbox);
vm.runInContext(
  extractFn(src, 'function bareNum') + ';' +
  extractFn(src, 'function indexRoster') + ';' +
  extractFn(src, 'TCG.pkmResolveNumber=function') + ';' +
  'this.resolve = function (cards, typed) { return TCG.pkmResolveNumber(indexRoster(cards), typed); };',
  sandbox,
);
const resolve = sandbox.resolve;

const roster = (...nums) => nums.map((n) => ({ numRaw: n }));

// Real shapes, trimmed to the boundaries that matter.
const SWSHP = roster('SWSH001', 'SWSH039', 'SWSH100', 'SWSH284', 'SWSH307');
const BWP = roster('BW01', 'BW02', 'BW03', 'BW004', 'BW005', 'BW06', 'BW14', 'BW99', 'BW100', 'BW101');
const SMA = roster('SV1', 'SV2', 'SV10', 'SV94');                 // Hidden Fates — NOT padded
const SWSH45SV = roster('SV001', 'SV002', 'SV010', 'SV122');      // Shining Fates — padded to 3
const SWSH10TG = roster('TG01', 'TG02', 'TG30');
const GG = roster('GG01', 'GG70');
const SVP = roster('1', '2', '100', '207');                        // stored bare upstream

describe('pkmResolveNumber — prefixed sets (the reported bug)', () => {
  it('SWSH Black Star Promos: 284 → SWSH284 (Galarian Moltres, the reported card)', () => {
    assert.equal(resolve(SWSHP, '284'), 'SWSH284');
  });
  it('resolves across the set’s full range, padding width and all', () => {
    assert.equal(resolve(SWSHP, '1'), 'SWSH001');
    assert.equal(resolve(SWSHP, '39'), 'SWSH039');
    assert.equal(resolve(SWSHP, '100'), 'SWSH100');
    assert.equal(resolve(SWSHP, '307'), 'SWSH307');
  });
  it('Trainer Gallery and Galarian Gallery resolve the same way', () => {
    assert.equal(resolve(SWSH10TG, '1'), 'TG01');
    assert.equal(resolve(SWSH10TG, '30'), 'TG30');
    assert.equal(resolve(GG, '1'), 'GG01');
    assert.equal(resolve(GG, '70'), 'GG70');
  });
});

describe('pkmResolveNumber — the two anomalies that rule out a padding formula', () => {
  it('bwp: 4 → BW004 while 14 → BW14, in the SAME set', () => {
    assert.equal(resolve(BWP, '4'), 'BW004');    // upstream really does pad these two
    assert.equal(resolve(BWP, '5'), 'BW005');
    assert.equal(resolve(BWP, '14'), 'BW14');    // …and not its neighbours
    assert.equal(resolve(BWP, '3'), 'BW03');
  });
  it('bwp: numbers past 99 keep their natural width', () => {
    assert.equal(resolve(BWP, '100'), 'BW100');
    assert.equal(resolve(BWP, '101'), 'BW101');
  });
  it('the two Shiny Vaults disagree on padding — same prefix, different sets', () => {
    assert.equal(resolve(SMA, '1'), 'SV1');
    assert.equal(resolve(SWSH45SV, '1'), 'SV001');
    assert.equal(resolve(SMA, '10'), 'SV10');
    assert.equal(resolve(SWSH45SV, '10'), 'SV010');
  });
});

describe('pkmResolveNumber — input the seller actually types', () => {
  it('the full printed form passes straight through', () => {
    assert.equal(resolve(SWSHP, 'SWSH284'), 'SWSH284');
    assert.equal(resolve(SWSH10TG, 'TG01'), 'TG01');
  });
  it('is case-insensitive on the prefix', () => {
    assert.equal(resolve(SWSHP, 'swsh284'), 'SWSH284');
  });
  it('strips a printed denominator (284/307 → SWSH284)', () => {
    assert.equal(resolve(SWSHP, '284/307'), 'SWSH284');
    assert.equal(resolve(SWSH10TG, 'TG01/TG30'), 'TG01');
  });
  it('strips whitespace (SWSH 284)', () => {
    assert.equal(resolve(SWSHP, 'SWSH 284'), 'SWSH284');
  });
  it('the REVERSE case: a padded 001 finds the bare upstream 1', () => {
    assert.equal(resolve(SVP, '001'), '1');       // svp/basep/np store "1" — printed "001" used to 404
    assert.equal(resolve(SVP, '1'), '1');
    assert.equal(resolve(SVP, '207'), '207');
  });
});

describe('pkmResolveNumber — misses and collisions', () => {
  it('a number the set does not have returns null (a real miss, not a silent wrong card)', () => {
    assert.equal(resolve(SWSHP, '999'), null);
    assert.equal(resolve(SWSH10TG, '31'), null);
  });
  it('empty / junk input returns null', () => {
    assert.equal(resolve(SWSHP, ''), null);
    assert.equal(resolve(SWSHP, '   '), null);
    assert.equal(resolve(SWSHP, 'abc'), null);
  });
  it('an alt-art suffix (GR5) does not steal the plain print', () => {
    const alt = roster('39', '39a');
    assert.equal(resolve(alt, '39'), '39');       // exact match wins outright
    assert.equal(resolve(alt, '39a'), '39a');
  });
  it('a suffixed-only number still resolves from its digits', () => {
    assert.equal(resolve(roster('39a'), '39'), '39a');
  });
});
