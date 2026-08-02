// test/invariants/riftbound-riftscribe.test.mjs — the live keyless lane's number matching, and the
// rule that keeps it from disagreeing with the offline lane about the same physical card.
//
// riftscribe.gg has not ingested Vendetta yet (OGN/OGS/SFD/UNL only), so this lane cannot be tested
// against real Vendetta data — which is exactly why it needs pinning. Two things broke when it was
// simulated with a Vendetta payload:
//   · the lookup parsed the typed number with its own /^0*(\d+)([a-z*]?)$/ regex, which rejected
//     SP1/006 outright ("Could not parse") — and left the PREVIOUS card's fields on screen.
//   · it re-derived the treatment from the collector number, so UNL-238 Baron Nashor read
//     "Overnumbered" here and "Ultimate" on the offline lane. Same card, two answers, US$1,635.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read, extractFn } from '../helpers/extract-inline.mjs';
import { normNum } from '../../lib/riftbound-data.mjs';

const html = read('riftbound-listing-builder.html');
const ctx = vm.createContext({});
vm.runInContext(extractFn(html, 'function normNum(') + ';', ctx);
vm.runInContext(extractFn(html, 'function rbsCardKey(') + ';', ctx);
const rbsCardKey = vm.runInContext('rbsCardKey', ctx);

// The shapes riftscribe publishes: variant is '' | 'a'..'z' | 'star' | 't0n'.
const card = (collector_number, variant = '') => ({ collector_number, variant });

describe('rbsCardKey — riftscribe card -> the shared normNum key', () => {
  it('a base print', () => assert.equal(rbsCardKey(card(27)), '27'));
  it('an alt-art carries its letter', () => assert.equal(rbsCardKey(card(27, 'a')), '27a'));
  it("a 'star' is the * suffix, i.e. a Signature", () => assert.equal(rbsCardKey(card(299, 'star')), '299*'));
  it('an over-total number is still just its number', () => assert.equal(rbsCardKey(card(167)), '167'));
  it('a token variant does not become a suffix', () => assert.equal(rbsCardKey(card(4, 't0n')), '4'));

  // riftscribe has no Vendetta yet, so nobody knows which shape it will use for SP1/006. Normalising
  // both sides means the lane works whatever they pick, instead of us guessing one and being wrong.
  it('resolves an SP promo whichever shape riftscribe publishes', () => {
    for (const cn of ['SP1', 'sp1', 'SP01', 'sp01']) {
      assert.equal(rbsCardKey(card(cn)), 'sp1', String(cn));
    }
  });

  it('agrees with the key the typed number produces — the whole point of sharing normNum', () => {
    const pairs = [[card(27), '027/298'], [card(27, 'a'), '27A'], [card(299, 'star'), '299*'],
      [card('SP1'), 'SP1/006'], [card('SP1'), 'sp01'], [card(167), '167/166']];
    for (const [c, typed] of pairs) {
      assert.equal(rbsCardKey(c), normNum(typed), `${JSON.stringify(c)} vs typed ${typed}`);
    }
  });
});

describe('the riftscribe lane defers to the bake on treatment', () => {
  const fn = extractFn(html, 'function mapRiftscribeCard(');

  it('looks the card up in the baked catalog by the same key', () => {
    assert.match(fn, /RB_DATA\[setCode\.toLowerCase\(\)\]/, 'must consult the baked catalog');
    assert.match(fn, /find\(\s*x\s*=>\s*x\.k\s*===\s*rbsCardKey\(c\)\s*\)/, 'must join on rbsCardKey');
  });
  it('prefers the baked treatment AND the baked rarity over deriving them again', () => {
    // The bake encodes the treatment in the name (incl. the one hardcoded Ultimate) and forces
    // Showcase on the SP promos, which have no name suffix to read.
    assert.match(fn, /Alternate Art\|Overnumbered\|Signature\|Ultimate/, 'must read all four treatments');
    assert.match(fn, /_bakedTreat\s*\?\s*_bakedTreat\[1\]\s*:\s*\(_baked\.rarity/, 'baked rarity must win when there is no suffix');
  });
  it('still derives from the number when the bake has no such card (riftscribe ahead of Riot)', () => {
    for (const branch of [/else if\(isStar\)/, /else if\(isAlt\)/, /else if\(isOver\)/]) {
      assert.match(fn, branch, 'the derivation fallback must survive');
    }
  });
  it('never re-introduces a bespoke number parser in the lookup', () => {
    const lookup = extractFn(html, 'function riftscribeLookup(');
    assert.ok(!/\^0\*\(\\d\+\)\(\[a-z\*\]\?\)\$/.test(lookup), 'the old regex rejected SP numbering');
    assert.match(lookup, /normNum\(raw\)/, 'the typed number must go through normNum');
  });
});
