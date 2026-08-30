// test/unit/runs-attributes.test.mjs — §4.4 line assignment and §4.5 padding, against the EX2 vector.
//
// EX2 IS THE FIXTURE THE REVIEWS ASKED FOR. Three rounds flagged that the realistic shape had never been
// vectored — multiple slots, max_lines > 1, populated AND padded lines, and line sorting — and revision
// 4's attempt could not be reproduced at all: it omitted every identity_key, the pack `game`, and the
// three composition labels, and used max_lines 2 where §3 declared 3. One reviewer recovered the SHAPE
// of the omission by byte arithmetic alone, deltas of 21/28/21 being exactly seven bytes per populated
// line. This fixture states every value, and these roots are the published ones.
//
// The pack lines are the point. Bundle 1 holds three packs of ONE product — one line with qty 3, never
// three lines — while bundle 2 holds two products and bundle 3 one. Three different internal structures
// that must emit an IDENTICAL attribute name set, or their trees differ in shape and the proof length
// published at close would leak each bundle's composition.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bundleAttributes, expectedAttributeNames, assignLines, gradeToken, intToken, bundleNoToken } from '../../lib/runs-canonical.mjs';
import { bundleTree, runTree } from '../../lib/runs-merkle.mjs';
const SALTS = [
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
];
const SPECS = [
  { slot: 'slab', label: 'Graded slab', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, sort_order: 0 },
  { slot: 'packs', label: 'Sealed packs', kind: 'sealed', qty_per_bundle: 3, max_lines: 3, sort_order: 1 },
  { slot: 'art', label: 'Art card', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, sort_order: 2 },
];

const slab = (name, ik, num, rarity, cert) => ({
  kind: 'inventory', display_name: name, game: 'pokemon', identity_key: ik, set_code: 'EXS',
  card_number: num, rarity, language: 'JA', finish: 'holo', product_type: '', upc: '',
  grading_company: 'PSA', grade: '10', cert_number: cert, qty: '1',
});
const art = (name, ik, num, rarity) => ({
  kind: 'inventory', display_name: name, game: 'pokemon', identity_key: ik, set_code: 'EXS',
  card_number: num, rarity, language: 'JA', finish: '', product_type: '', upc: '',
  grading_company: '', grade: '', cert_number: '', qty: '1',
});
const pack = (which, qty) => ({
  kind: 'sealed',
  display_name: which === 'A' ? 'Sample Pack Set A' : 'Sample Pack Set B',
  game: 'pokemon', identity_key: '', set_code: which === 'A' ? 'SPA' : 'SPB',
  card_number: '', rarity: '', language: 'JA', finish: '', product_type: 'booster_pack',
  upc: which === 'A' ? '0000000000001' : '0000000000002',
  grading_company: '', grade: '', cert_number: '', qty: String(qty),
});

const RUN = { public_id: 'EX2', edition: 1 };
const BUNDLES = [
  { bundle: { bundle_no: 1, label: 'EX2-001', is_chase: 0, seal_serial: '5b3f9a2c74e18d60' },
    lines: { slab: [slab('Sample Card Alpha', 'ex2-001', '101', 'Art Rare', '00000001')],
             packs: [pack('A', 3)],
             art: [art('Sample Art One', 'ex2-a01', '201', 'Art Rare')] } },
  { bundle: { bundle_no: 2, label: 'EX2-002', is_chase: 1, seal_serial: 'a04c17e9b5230fd8' },
    // Deliberately supplied B FIRST, so the §4.4 sort has to put A before B rather than the caller.
    lines: { slab: [slab('Sample Card Beta', 'ex2-002', '202', 'Special Art Rare', '00000002')],
             packs: [pack('B', 1), pack('A', 2)],
             art: [art('Sample Art Two', 'ex2-a02', '202', 'Special Art Rare')] } },
  { bundle: { bundle_no: 3, label: 'EX2-003', is_chase: 0, seal_serial: 'c72e58b1039af64d' },
    lines: { slab: [slab('Sample Card Gamma', 'ex2-003', '303', 'Mega Attack Rare', '00000003')],
             packs: [pack('B', 3)],
             art: [art('Sample Art Three', 'ex2-a03', '203', 'Art Rare')] } },
];

const WANT_ROOTS = [
  'bd61cbf4bb9d1b9e67442cb963e320500381c3f4ef1e271215aafdf1495e1e6d',
  '058964282ee22d7b07bff676e1157bb1fe164095a20708df98b9f84f38848c40',
  '245a743612998bc13674eaac9629fbe827c158db23b61bd6e79b6784b54238b2',
];
const WANT_LEAVES = [
  'c84e770288da8ca953e339b66abbf6d43aa8c258565a9444d37ce0d14bf8cffc',
  '4b273f0c49964d21620a7930debfb1a4d750b6e8f43c58ea1d2abec41242ad76',
  '0372bdf5f5fd1cd0483b6c1b154a6b753d30b0e858ba6b946c144bec766bc7f8',
];
const WANT_RUN_ROOT = '221c209209bc900c52555cba31fbe5da1581c7ab5ce6f244ee735413aaf70587';

const attrs = BUNDLES.map((b) => bundleAttributes({ run: RUN, bundle: b.bundle, specs: SPECS, lines: b.lines }));
const trees = await Promise.all(attrs.map((a, i) => bundleTree(SALTS[i], a)));
const run = await runTree(trees.map((t) => t.root));

describe('EX2 reproduces — the realistic shape', () => {
  it('emits eighty-one attributes per bundle', () => {
    for (const a of attrs) assert.equal(a.length, 81);
  });

  it('with an IDENTICAL name set across all three, despite three different pack structures', () => {
    // This is what padding is for. Without it the bundles would have different attribute counts,
    // differently-shaped trees, and therefore different proof lengths — and proof length is published
    // whenever an attribute is opened, so an observer would read each bundle's structure off a
    // disclosure designed to reveal one field.
    const sets = attrs.map((a) => a.map((x) => x.name).join('|'));
    assert.equal(new Set(sets).size, 1);
  });

  it('and that set is exactly the one a verifier derives from the composition', () => {
    assert.deepEqual(attrs[0].map((a) => a.name), expectedAttributeNames({ specs: SPECS }));
  });

  it('reproduces the published bundle roots', () => {
    trees.forEach((t, i) => assert.equal(t.root, WANT_ROOTS[i], `bundle ${i + 1}`));
  });

  it('the published leaves', () => {
    run.leaves.forEach((l, i) => assert.equal(l, WANT_LEAVES[i], `leaf ${i + 1}`));
  });

  it('and the published run root', () => {
    assert.equal(run.root, WANT_RUN_ROOT);
  });
});

describe('line assignment and padding', () => {
  const at = (i) => new Map(attrs[i].map((a) => [a.name, a.value]));

  it('SORTS populated lines byte-wise, not in the order the caller happened to pass them', () => {
    // Bundle 2's packs are handed in as B then A. §4.4 sorts them, so the encoding is reachable from
    // any input ordering — otherwise two producers with the same stock anchor different digests.
    const b2 = at(1);
    assert.equal(b2.get('slot.packs.00.set_code'), 'SPA');
    assert.equal(b2.get('slot.packs.01.set_code'), 'SPB');
  });

  it('puts padding AFTER every populated line, with all fifteen fields empty', () => {
    const b1 = at(0);
    assert.equal(b1.get('slot.packs.00.qty'), '3', 'three packs of one product are ONE line with qty 3');
    for (const f of ['kind', 'qty', 'display_name', 'set_code', 'upc', 'product_type']) {
      assert.equal(b1.get(`slot.packs.01.${f}`), '', `line 01 ${f}`);
      assert.equal(b1.get(`slot.packs.02.${f}`), '', `line 02 ${f}`);
    }
  });

  it('emits NO attribute recording how many lines are populated', () => {
    // A count would be a single value encoding the very structure the padding exists to hide.
    for (const a of attrs[0]) assert.ok(!/count|lines|populated/.test(a.name), a.name);
  });

  it('refuses more populated lines than max_lines', () => {
    const four = Array.from({ length: 4 }, (_, i) => pack(i % 2 ? 'A' : 'B', i + 1));
    assert.throws(() => assignLines(four, 3), /max_lines is 3/);
  });

  it('zero-pads the line index to two digits, which is why max_lines stops at 99', () => {
    const names = attrs[0].map((a) => a.name).filter((n) => n.startsWith('slot.packs.'));
    assert.ok(names.some((n) => n.startsWith('slot.packs.00.')));
    assert.ok(names.some((n) => n.startsWith('slot.packs.02.')));
    // 02 must sort before 10, which a bare integer would not.
    assert.ok('slot.packs.02.kind' < 'slot.packs.10.kind');
  });
});

// EX1 publishes twenty attributes with NO seal_serial; EX2 publishes eighty-one WITH one. Both roots
// reproduce only if the attribute is conditional, so the fixtures are the authority and §4.4's
// unconditional name set is loose prose. Pinned, because it is the kind of thing a later reader would
// "fix" into always-present and silently invalidate every anchored run.
describe('bundle.seal_serial is emitted only when the bundle has one', () => {
  it('is present in EX2', () => {
    assert.ok(attrs[0].some((a) => a.name === 'bundle.seal_serial'));
    assert.equal(attrs[0].find((a) => a.name === 'bundle.seal_serial').value, '5b3f9a2c74e18d60');
  });

  it('and absent when the bundle carries none', () => {
    const a = bundleAttributes({
      run: RUN, specs: SPECS, lines: BUNDLES[0].lines,
      bundle: { ...BUNDLES[0].bundle, seal_serial: null },
    });
    assert.equal(a.length, 80);
    assert.ok(!a.some((x) => x.name === 'bundle.seal_serial'));
  });
});

describe('the §4.3 grammars', () => {
  it('grade: 10 and 9.5 pass; 10.0 and 09 are refused', () => {
    assert.equal(gradeToken('10'), '10');
    assert.equal(gradeToken('9.5'), '9.5');
    assert.equal(gradeToken(''), '', 'a padded line emits every field empty, grade included');
    for (const bad of ['10.0', '09', '.5', '0.', '11', '9.50', '-1']) {
      assert.throws(() => gradeToken(bad), TypeError, bad);
    }
  });

  it('qty: positive integers, no leading zeros', () => {
    assert.equal(intToken('3'), '3');
    assert.equal(intToken(''), '');
    for (const bad of ['03', '0', '-1', '1.5']) assert.throws(() => intToken(bad), TypeError, bad);
  });

  it('bundle number: zero-padded to exactly three digits, and 1000 needs a new canon version', () => {
    assert.equal(bundleNoToken(1), '001');
    assert.equal(bundleNoToken(25), '025');
    assert.equal(bundleNoToken(999), '999');
    for (const bad of [0, 1000, -1, 1.5]) assert.throws(() => bundleNoToken(bad), RangeError, String(bad));
  });
});
