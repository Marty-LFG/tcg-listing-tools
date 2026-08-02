// test/invariants/riftbound-mirror.test.mjs — GR9 parity for the Riftbound RESOLUTION helpers.
//
// scripts/check-listing-copy.mjs already pins genTitle/genPitch/buildHTML against lib/listing-copy
// .mjs. Nothing pinned the other half of the mirror: normNum / mapRarity / variantOf / finishOf /
// rbDotgg / parseRune are duplicated between riftbound-listing-builder.html and
// lib/riftbound-data.mjs, and until this file existed you could edit one side and ship.
//
// That divergence is not cosmetic. normNum builds the tracker identity_key and the price-index key,
// so the builder and the bulk pipeline disagreeing about one card number means two rows for one
// physical card and a split price history.
//
// Same technique as check-listing-copy: pull the functions out of the HTML with vm, then compare
// OUTPUTS (not source text) over a shared vector table.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read, extractFn } from '../helpers/extract-inline.mjs';
import * as LIB from '../../lib/riftbound-data.mjs';

const html = read('riftbound-listing-builder.html');
const ctx = vm.createContext({});
for (const marker of ['function normNum(', 'function mapRarity(', 'function variantOf(',
  'function finishOf(', 'function domainDisp(', 'function championTag(',
  'function rbDotgg(', 'const RUNE_ORDER=', 'function parseRune(']) {
  vm.runInContext(extractFn(html, marker) + ';', ctx);
}
const PAGE = vm.runInContext(
  '({normNum,mapRarity,variantOf,finishOf,domainDisp,championTag,rbDotgg,RUNE_ORDER,parseRune})', ctx);

// Compare STRUCTURALLY, not by reference: objects the vm builds carry that realm's Object.prototype,
// so deepStrictEqual rejects an otherwise identical parseRune result on prototype identity alone.
const shape = (v) => JSON.stringify(v === undefined ? null : v);
const eq = (fn, args, label) => assert.equal(shape(PAGE[fn](...args)), shape(LIB[fn](...args)),
  `${fn}(${args.map((a) => JSON.stringify(a)).join(', ')}) diverged — ${label}`);

describe('normNum parity (builder ⇄ lib/riftbound-data.mjs)', () => {
  const VECTORS = [
    ['027/298', 'base print, zero-padded'],
    ['027a/298', 'alternate art'],
    ['299*/298', 'signature'],
    ['SP1/006', 'special showcase, as printed'],
    ['sp1', 'special showcase, typed lowercase'],
    ['SP01', 'special showcase, zero-padded by a marketplace'],
    ['R01a', 'rune reprint — passes through untouched'],
    ['162a', 'no denominator'],
    ['0', 'zero'],
    ['', 'empty'],
    [null, 'null'],
    ['nonsense', 'unparseable'],
  ];
  for (const [input, label] of VECTORS) {
    it(`${JSON.stringify(input)} — ${label}`, () => eq('normNum', [input], label));
  }
  it('one physical SP card yields exactly ONE identity key', () => {
    const keys = new Set(['SP1/006', 'sp1', 'SP01', 'Sp1'].map((s) => LIB.normNum(s)));
    assert.deepEqual([...keys], ['sp1']);
  });
});

describe('rarity/variant/finish parity', () => {
  const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Showcase',
    'Alternate Art', 'Overnumbered', 'Signature', '', null, 'Unknown'];
  for (const r of RARITIES) {
    it(`${JSON.stringify(r)}`, () => {
      eq('mapRarity', [r], 'rarity display');
      eq('variantOf', [r], 'variant token');
      eq('finishOf', [r], 'finish');
    });
  }
  it('every Showcase treatment is foil — an Overnumbered chase card is not a plain non-foil', () => {
    for (const r of ['Alternate Art', 'Overnumbered', 'Signature', 'Showcase', 'Epic']) {
      assert.equal(LIB.finishOf(r), 'Foil', r);
    }
    for (const r of ['Common', 'Uncommon', 'Rare', '']) assert.equal(LIB.finishOf(r), 'Non-foil', r);
  });
  it('Signature and Overnumbered stay DISTINCT variants (US$2739 vs US$296 on the same card)', () => {
    assert.equal(LIB.variantOf('Signature'), 'Signature');
    assert.equal(LIB.variantOf('Overnumbered'), 'Overnumbered');
  });
});

describe('rbDotgg parity', () => {
  const VECTORS = [
    ['OGN', '066a/298', 'alt art, padded'],
    ['OGN', '299*/298', 'signature'],
    ['VEN', 'SP1/006', 'special showcase'],
    ['VEN', 'sp1', 'special showcase typed lowercase'],
    ['SFD', 'R01a', 'rune reprint'],
    ['ven', '1', 'lowercase set code'],
    ['VEN', '', 'no number'],
  ];
  for (const [set, num, label] of VECTORS) {
    it(`${set} ${JSON.stringify(num)} — ${label}`, () => eq('rbDotgg', [set, num], label));
  }
  it('uppercases an alpha PREFIX — the CDN 404s on VEN-sp1.webp', () => {
    assert.equal(LIB.rbDotgg('VEN', 'sp1'), 'https://static.dotgg.gg/riftbound/cards/VEN-SP1.webp');
    assert.equal(LIB.rbDotgg('VEN', 'SP1/006'), 'https://static.dotgg.gg/riftbound/cards/VEN-SP1.webp');
  });
  it('still pads a plain number to 3 digits and lowercases its suffix', () => {
    assert.equal(LIB.rbDotgg('OGN', '7A'), 'https://static.dotgg.gg/riftbound/cards/OGN-007a.webp');
  });
});

describe('rune parity', () => {
  it('RUNE_ORDER is identical on both sides', () => assert.equal(shape(PAGE.RUNE_ORDER), shape(LIB.RUNE_ORDER)));
  for (const raw of ['R01', 'R01a', 'r6', 'R06', 'R07', 'R00', '', 'SP1']) {
    it(`parseRune(${JSON.stringify(raw)})`, () => eq('parseRune', [raw], 'rune parse'));
  }
});

describe('misc helper parity', () => {
  for (const d of ['Fury', 'Fury;Calm', '', null]) {
    it(`domainDisp(${JSON.stringify(d)})`, () => eq('domainDisp', [d], 'domain display'));
  }
  for (const n of ['Darius - Trifarian', 'Baccai Sandspinner', '', null]) {
    it(`championTag(${JSON.stringify(n)})`, () => eq('championTag', [n], 'champion tag'));
  }
});
