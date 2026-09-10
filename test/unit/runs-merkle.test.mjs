// test/unit/runs-merkle.test.mjs — the two Merkle trees and their proofs (lib/runs-merkle.mjs).
//
// EVERY HASH BELOW IS PUBLISHED IN docs/RUNS_PLAN.md §4.10.1 AND ANCHORED INTO BITCOIN ONCE A RUN LOCKS.
// A failure here is not a regression on a branch — it means a commitment already timestamped can no
// longer be verified by the page a customer is looking at. If one of these ever fails, the encoding
// changed; the answer is never to update the expected value.
//
// The fixture is the specification's EX1: three bundles, one slot, twenty attributes, small enough that
// a person can check it by hand against the document.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  attrSalt, commit, node, leafOf, merkleRoot, merkleProof, verifyProof, expectedShape,
  bundleTree, runTree, openAttribute, verifyOpening,
} from '../../lib/runs-merkle.mjs';

const SALTS = [
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
];

// One slot with max_lines 1: five run/bundle attributes plus the fifteen §4.4 line fields = twenty.
function ex1Bundle(no, over) {
  const line = {
    kind: 'inventory', display_name: '', game: 'pokemon', identity_key: '', set_code: 'EXS',
    card_number: '', rarity: '', language: 'JA', finish: '', product_type: '', upc: '',
    grading_company: 'PSA', grade: '10', cert_number: '', qty: '1', ...over.line,
  };
  const attrs = [
    { name: 'run.public_id', value: 'EX1' },
    { name: 'run.edition', value: '1' },
    { name: 'bundle.no', value: String(no).padStart(3, '0') },
    { name: 'bundle.label', value: `EX1-${String(no).padStart(3, '0')}` },
    { name: 'bundle.is_chase', value: over.is_chase },
  ];
  for (const [f, v] of Object.entries(line)) attrs.push({ name: `slot.slab.00.${f}`, value: v });
  return attrs;
}

const EX1 = [
  ex1Bundle(1, { is_chase: '0', line: { display_name: 'Sample Card Alpha', identity_key: 'ex1-001', card_number: '101', cert_number: '00000001', finish: 'holo', rarity: 'Art Rare' } }),
  ex1Bundle(2, { is_chase: '1', line: { display_name: 'Sample Card Beta', identity_key: 'ex1-002', card_number: '202', cert_number: '00000002', finish: 'holo', rarity: 'Special Art Rare' } }),
  ex1Bundle(3, { is_chase: '0', line: { display_name: 'Sample Card Gamma', identity_key: 'ex1-003', card_number: '303', cert_number: '00000003', finish: '', rarity: 'Art Rare' } }),
];

const ROOTS = [
  'ed018f5c1791fe1590a93a8e663708f3942fb4b7c25de331f0113ab111ef2d78',
  'fae0269d14ce14ff7ad1b1c156fe9948083369dd467e1e747c0808aa4c3da9c0',
  'f276439e7ae9698426f09197d4fad28cec1fbff297595578255d8add36800e04',
];
const LEAVES = [
  'cb3640bd3758ca3a31ad0d44ddae6f65b196aaf41e23e2704bb876e0ec9ff522',
  '3156a3eb3bb166c9344ef5aea8faa16d3b682533480c25a7df69722fbedb00a4',
  'd3e3f456b547c6a0ec351be6d91733b15523373b43f635b5045276e52f25b56a',
];
const RUN_ROOT = '4da578566753734fc1841e9719ea652f44fbc261366e5926c8a92b4eeaea04fd';
const PAIR_12 = '9d10f39067ed1e44805d3c25c270605ba46896ff5930a9eb33cda49bf76fd021';

const trees = await Promise.all(EX1.map((attrs, i) => bundleTree(SALTS[i], attrs)));
const run = await runTree(trees.map((t) => t.root));

describe('EX1 reproduces, attribute by attribute', () => {
  it('emits exactly twenty attributes', () => {
    for (const t of trees) assert.equal(t.attributes.length, 20);
  });

  it('sorts them byte-wise by name, which is what the root commits to', () => {
    const names = trees[0].attributes.map((a) => a.name);
    assert.deepEqual(names.slice(0, 6), [
      'bundle.is_chase', 'bundle.label', 'bundle.no', 'run.edition', 'run.public_id', 'slot.slab.00.card_number',
    ]);
    assert.deepEqual(names, [...names].sort());
  });

  it('derives the published attribute salts', async () => {
    assert.equal(await attrSalt(SALTS[0], 'bundle.is_chase'),
      '13eb1ad54e74b08f0ae91d555518619fe0f81cda291652ae57e116000a3ec01c');
    assert.equal(await attrSalt(SALTS[0], 'slot.slab.00.upc'),
      'ee9203bf7ee9daea2382796ff5dd83cb917f7b07763e8a6e03aca835be798fae');
  });

  it('and the published commitments, including an EMPTY value', () => {
    const by = new Map(trees[0].attributes.map((a) => [a.name, a.commit]));
    assert.equal(by.get('bundle.is_chase'), '0cce6dead2f4bc63a8dc20c4d56b8e3d216609311f2ed8990f1da6233ed0020c');
    assert.equal(by.get('bundle.label'), 'ed6bfcd15d3f710b7cec92ea4ae340566939d1eb39d82a5052d792a146f309c2');
    assert.equal(by.get('slot.slab.00.grade'), '2af00e58d970cfeeef8267fd0775eb3420bdf393dbee33514d2434b9f8633220');
    // The padding case. An absent field is present under its name with an empty value — never omitted,
    // because omission would change the attribute set and therefore the tree.
    assert.equal(by.get('slot.slab.00.upc'), '3b15368aa18a22eb30608ce926f2a170a2f95c47b1fd1da1c5afd9178311d785');
    assert.equal(by.get('slot.slab.00.product_type'), 'a79a151beeb2939d327b4abb233c1d180654d2e39ae68ecad97deb317fd7a472');
  });

  it('to the published bundle roots and leaves', () => {
    trees.forEach((t, i) => assert.equal(t.root, ROOTS[i], `bundle ${i + 1}`));
    run.leaves.forEach((l, i) => assert.equal(l, LEAVES[i], `leaf ${i + 1}`));
  });

  it('and the published run root', () => {
    assert.equal(run.root, RUN_ROOT);
  });
});

describe('proofs, exactly as published', () => {
  it('bundle 2 — index 1 of 3, two steps', async () => {
    assert.deepEqual(await merkleProof(run.leaves, 1), [
      { hash: LEAVES[0], side: 'L' },
      { hash: LEAVES[2], side: 'R' },
    ]);
  });

  it('bundle 3 — the promoted odd node, ONE step, because a promoted level contributes nothing', async () => {
    assert.deepEqual(await merkleProof(run.leaves, 2), [{ hash: PAIR_12, side: 'L' }]);
  });

  it('opening bundle.is_chase on bundle 1 — index 0 of 20, five steps', async () => {
    const p = await merkleProof(trees[0].attributes.map((a) => a.commit), 0);
    assert.deepEqual(p, [
      { hash: 'ed6bfcd15d3f710b7cec92ea4ae340566939d1eb39d82a5052d792a146f309c2', side: 'R' },
      { hash: '8a176566d931017c24ff7fa03c62897be22c97c22e8dc85ce6748dab2ea1c6f6', side: 'R' },
      { hash: 'f3ac6b1690a196241caa0787fd2689932a9fed73b004141f20c41cfa20d07832', side: 'R' },
      { hash: '556e4255d33d10446a46e470b17124ba4c9e82f4d388763e50d7e19026b9fe61', side: 'R' },
      { hash: '0378f424ae353b52dd15f7a9fdba6707917b138e4006146ebffc36d5842b0c44', side: 'R' },
    ]);
  });

  it('every bundle verifies against the run root', async () => {
    for (let i = 0; i < 3; i++) {
      const p = await merkleProof(run.leaves, i);
      const v = await verifyProof({ leaf: LEAVES[i], proof: p, root: RUN_ROOT, index: i, size: 3 });
      assert.equal(v.ok, true, `${i}: ${v.error}`);
    }
  });
});

describe('the tree edge cases §4.8 states', () => {
  it('n = 0 is INVALID — an empty tree has no root to invent', async () => {
    await assert.rejects(() => merkleRoot([]), /invalid|nothing to commit/);
  });

  it('n = 1: the root IS the sole input, unhashed, and the proof is empty', async () => {
    const only = '00'.repeat(32);
    assert.equal(await merkleRoot([only]), only);
    assert.deepEqual(await merkleProof([only], 0), []);
  });

  it('n = 2 reproduces the published root', async () => {
    assert.equal(await merkleRoot(['00'.repeat(32), '11'.repeat(32)]),
      'a7b6a88afe611b23a8bb9836e3cd13ba706cb05d6de647d92bf05bb0aace72ee');
    assert.deepEqual(await merkleProof(['00'.repeat(32), '11'.repeat(32)], 0),
      [{ hash: '11'.repeat(32), side: 'R' }]);
  });

  it('DUPLICATE leaves are refused at both levels', async () => {
    // Two identical leaves make one index indistinguishable from another, which is precisely what an
    // index-bound proof exists to prevent.
    await assert.rejects(() => merkleRoot([LEAVES[0], LEAVES[0]]), /duplicate/);
  });
});

// THE ATTACK TESTS. "We did not use Bitcoin's rule" is only worth writing down if something checks it.
describe('the attacks the shape defends against', () => {
  it('duplicate-last gives a DIFFERENT root over the same three leaves — CVE-2012-2459', async () => {
    // Bitcoin duplicates the final hash on an odd level, which lets two different leaf sets produce one
    // root. The specification publishes both values so the difference is checkable rather than asserted.
    let cur = [...run.leaves];
    while (cur.length > 1) {
      const next = [];
      for (let i = 0; i < cur.length; i += 2) next.push(await node(cur[i], cur[i + 1] ?? cur[i]));
      cur = next;
    }
    assert.equal(cur[0], '776f7bdf154fe3caee91170b9752082a33fa1114c290761875082127767fa2bf');
    assert.notEqual(cur[0], RUN_ROOT);
  });

  it('a 64-byte "leaf" that is two concatenated node hashes cannot pass as a leaf', async () => {
    // Without the one-byte domain prefixes this is the classic second preimage: an internal node read as
    // a leaf. leafOf takes 32 bytes and refuses 64 outright.
    // bytes() throws SYNCHRONOUSLY, before any promise exists, which is the right shape for a malformed
    // input: the caller finds out at the call rather than at an await it might not have written.
    assert.throws(() => leafOf(LEAVES[0] + LEAVES[1]), /32 bytes/);
    // And the prefixes really do separate the domains: the same bytes hash differently as a leaf, as an
    // attribute commitment and as an internal node.
    const asLeaf = await leafOf(LEAVES[0]);
    const asNode = await node(LEAVES[0], LEAVES[0]);
    assert.notEqual(asLeaf, asNode);
  });
});

// A PROOF WITHOUT ITS INDEX IS NOT A PROOF. Revision 3 specified only the hash walk, which let one valid
// opening be replayed under several different labels — a bundle presenting another's proof as its own.
describe('proofs are bound to an index and a size', () => {
  it('refuses a proof whose step COUNT is wrong for its position', async () => {
    const p = await merkleProof(run.leaves, 1);
    const v = await verifyProof({ leaf: LEAVES[1], proof: p.slice(0, 1), root: RUN_ROOT, index: 1, size: 3 });
    assert.equal(v.ok, false);
    assert.match(v.error, /has 2 step\(s\); this one has 1/);
  });

  it('refuses a proof whose L/R PATTERN is wrong, before hashing anything', async () => {
    const p = await merkleProof(run.leaves, 1);
    const flipped = p.map((s) => ({ ...s, side: s.side === 'L' ? 'R' : 'L' }));
    const v = await verifyProof({ leaf: LEAVES[1], proof: flipped, root: RUN_ROOT, index: 1, size: 3 });
    assert.equal(v.ok, false);
    assert.match(v.error, /should come from the/);
  });

  it('REFUSES bundle 3 replaying bundle 2 under its own index — the replay revision 3 allowed', async () => {
    const p2 = await merkleProof(run.leaves, 1);
    const v = await verifyProof({ leaf: LEAVES[1], proof: p2, root: RUN_ROOT, index: 2, size: 3 });
    assert.equal(v.ok, false, 'a valid proof presented under the wrong index must not verify');
  });

  it('refuses an index outside the tree', async () => {
    const p = await merkleProof(run.leaves, 0);
    for (const [index, size] of [[3, 3], [-1, 3], [0, 0]]) {
      const v = await verifyProof({ leaf: LEAVES[0], proof: p, root: RUN_ROOT, index, size });
      assert.equal(v.ok, false, `${index} of ${size}`);
    }
  });

  it('refuses a tampered sibling hash', async () => {
    const p = await merkleProof(run.leaves, 1);
    p[0] = { ...p[0], hash: 'ff'.repeat(32) };
    const v = await verifyProof({ leaf: LEAVES[1], proof: p, root: RUN_ROOT, index: 1, size: 3 });
    assert.equal(v.ok, false);
    assert.match(v.error, /does not reach the published root/);
  });

  it('and the expected shape is derivable from position alone, with no hashes', () => {
    assert.deepEqual(expectedShape(1, 3), ['L', 'R']);
    assert.deepEqual(expectedShape(2, 3), ['L']);
    assert.deepEqual(expectedShape(0, 1), []);
    assert.equal(expectedShape(0, 25).length, 5, 'the longest run-tree proof for 25 bundles is 5 steps');
  });
});

describe('selective disclosure', () => {
  it('opens one attribute and verifies it to the run root', async () => {
    const o = await openAttribute({
      bundleSaltHex: SALTS[0], attributes: EX1[0], bundleIndex: 0,
      bundleRoots: trees.map((t) => t.root), name: 'bundle.is_chase',
    });
    assert.equal(o.value, '0');
    assert.equal(o.salt, '13eb1ad54e74b08f0ae91d555518619fe0f81cda291652ae57e116000a3ec01c');
    const v = await verifyOpening(o, { runRoot: RUN_ROOT });
    assert.equal(v.ok, true, v.error);
  });

  it('A FABRICATED VALUE HAS NO VALID PROOF — a dishonest partial disclosure is impossible', async () => {
    const o = await openAttribute({
      bundleSaltHex: SALTS[0], attributes: EX1[0], bundleIndex: 0,
      bundleRoots: trees.map((t) => t.root), name: 'bundle.is_chase',
    });
    // Bundle 1 was not a chase. Claim it was.
    const v = await verifyOpening({ ...o, value: '1' }, { runRoot: RUN_ROOT });
    assert.equal(v.ok, false);
    assert.match(v.error, /attribute proof failed/);
  });

  it('and a swapped SALT fails too, so the opening cannot be re-keyed', async () => {
    const o = await openAttribute({
      bundleSaltHex: SALTS[0], attributes: EX1[0], bundleIndex: 0,
      bundleRoots: trees.map((t) => t.root), name: 'bundle.is_chase',
    });
    const v = await verifyOpening({ ...o, salt: await attrSalt(SALTS[1], 'bundle.is_chase') }, { runRoot: RUN_ROOT });
    assert.equal(v.ok, false);
  });

  it('refuses an opening that proves membership of a DIFFERENT run', async () => {
    const o = await openAttribute({
      bundleSaltHex: SALTS[0], attributes: EX1[0], bundleIndex: 0,
      bundleRoots: trees.map((t) => t.root), name: 'bundle.is_chase',
    });
    const v = await verifyOpening(o, { runRoot: 'ab'.repeat(32) });
    assert.equal(v.ok, false);
    assert.match(v.error, /different run root/);
  });

  // §4.6's whole point: publishing one attribute's salt must reveal nothing about the others. That is why
  // it is HMAC rather than SHA256(bundleSalt ‖ name).
  it('one opened salt tells you nothing about the next', async () => {
    const a = await attrSalt(SALTS[0], 'bundle.is_chase');
    const b = await attrSalt(SALTS[0], 'slot.slab.00.cert_number');
    assert.notEqual(a, b);
    // And the same attribute under two bundle salts is unrelated, so a holder cannot identify a sibling.
    assert.notEqual(a, await attrSalt(SALTS[1], 'bundle.is_chase'));
  });

  it('refuses a bundle carrying the same attribute name twice', async () => {
    await assert.rejects(() => bundleTree(SALTS[0], [...EX1[0], { name: 'bundle.no', value: '999' }]),
      /same attribute name twice/);
  });
});
