// test/unit/runs-header.test.mjs — §5.1, the header digest: the value actually anchored into Bitcoin.
//
// THE RESOLVED AMBIGUITY. §5.1 prints the fixture's guarantee text and unsold policy wrapped across three
// indented lines each, without the "one string, wrapped here for width" annotation the sub-encodings above
// them get. Nine readings were computed — each string joined by a single space, by a newline, or by a
// newline plus the printed indent — and EXACTLY ONE reproduces the published 829a795e… digest: both are
// single-line strings, single-space joined. Recorded here because it is an inference from the vector rather
// than something the document states, and a later reader must not silently pick differently.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { headerDigest, headerCanonical, compositionCanonical, chaseLadderCanonical } from '../../lib/runs-header.mjs';
import { claimsCanonical } from '../../lib/runs-claims.mjs';
import { rarityTableHash, RARITY_TABLE_VERSION } from '../../lib/runs-rarity.mjs';

const SPECS = [
  { slot: 'slab', label: 'Graded slab', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, singleton: 1, requires_cert: 1, is_chase_slot: 1, sort_order: 0 },
  { slot: 'packs', label: 'Sealed packs', kind: 'sealed', qty_per_bundle: 3, max_lines: 3, singleton: 0, requires_cert: 0, is_chase_slot: 0, sort_order: 1 },
  { slot: 'art', label: 'Art card', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, singleton: 1, requires_cert: 0, is_chase_slot: 0, sort_order: 2 },
];
const LADDER = [
  { rank: 1, card_name: 'Sample Card Beta', set_code: 'EXS', card_number: '202', language: 'JA', grading_company: 'PSA', grade: '10' },
];
const CLAIMS = [
  { claim_type: 'grader', subject: 'slab', operator: 'eq', value: 'PSA' },
  { claim_type: 'language', subject: 'bundle', operator: 'eq', value: 'JA' },
  { claim_type: 'min_grade', subject: 'slab', operator: 'gte', value: '10' },
  { claim_type: 'rarity_in', subject: 'slab', operator: 'in', value: 'ART_RARE,MEGA_ATTACK_RARE,SPECIAL_ART_RARE' },
  { claim_type: 'slot_count', subject: 'bundle', operator: 'eq', value: 'art:1,packs:3,slab:1' },
];

const GUARANTEE = 'Every bundle contains one PSA 10 graded Japanese card of an illustrated chase rarity '
  + '(Art Rare, Mega Attack Rare or Special Art Rare), three sealed Japanese booster packs and one art card.';
const UNSOLD_POLICY = 'Every bundle in a run is sold at one price shared by every remaining number. '
  + 'No bundle is withdrawn from sale, priced differently from any other, or purchased by the seller or '
  + 'an affiliate.';

const HEADER = {
  public_id: 'EX2', edition: 1, unit_count: 3, canon: 'BKR1',
  runRoot: '221c209209bc900c52555cba31fbe5da1581c7ab5ce6f244ee735413aaf70587',
  codesCommit: 'c0c03deb405fc4a7643c6669ebecc8af9abb27a35fc7189bac1f22608dab05f4',
  blobHash: '895e997da12d0d21c3e6c9b6c6f1dd374ea4bf96c51bd193cae4c6fef18f8257',
  specs: SPECS,
  chaseLadder: LADDER,
  claimsCanonical: claimsCanonical(CLAIMS),
  guaranteeText: GUARANTEE,
  rarityTableVersion: RARITY_TABLE_VERSION,
  rarityTableHash: await rarityTableHash(),
  closeByDate: '2027-03-31T23:59:59.000Z',
  salesCloseAt: '2027-01-31T23:59:59.000Z',
  unsoldPolicy: UNSOLD_POLICY,
};
const WANT = '829a795eaca64d6ccf56b6898e0e51f495f450a70b34e9577c04ccaa685d2231';

describe('§5.1 the published header vector', () => {
  it('reproduces compositionCanonical, 156 bytes as published', () => {
    const c = compositionCanonical(SPECS);
    assert.equal(c,
      '4:slab,11:Graded slab,9:inventory,1:1,1:1,1:1,1:1,1:1,'
      + '5:packs,12:Sealed packs,6:sealed,1:3,1:3,1:0,1:0,1:0,'
      + '3:art,8:Art card,9:inventory,1:1,1:1,1:1,1:0,1:0,');
    assert.equal(Buffer.byteLength(c, 'utf8'), 156);
  });

  it('reproduces chaseLadderCanonical', () => {
    assert.equal(chaseLadderCanonical(LADDER), '1:1,16:Sample Card Beta,3:EXS,3:202,2:JA,3:PSA,2:10,');
  });

  it('reproduces claimsCanonical', () => {
    assert.equal(claimsCanonical(CLAIMS),
      '6:grader,4:slab,2:eq,3:PSA,'
      + '8:language,6:bundle,2:eq,2:JA,'
      + '9:min_grade,4:slab,3:gte,2:10,'
      + '9:rarity_in,4:slab,2:in,42:ART_RARE,MEGA_ATTACK_RARE,SPECIAL_ART_RARE,'
      + '10:slot_count,6:bundle,2:eq,20:art:1,packs:3,slab:1,');
  });

  it('and the rarity table hash it commits to', async () => {
    assert.equal(await rarityTableHash(), 'ca971d5d15666d83cfeb4b451dc3bd99d6639e7eeee70c23002c39a7d28d83e0');
  });

  it('reproduces headerDigest', async () => {
    assert.equal(await headerDigest(HEADER), WANT);
  });

  it('and only the single-space reading of the wrapped strings does', async () => {
    // The one inference in this file. If a later reader "restores" the printed line breaks, this fails
    // rather than silently anchoring a different digest than the specification publishes.
    const NL = String.fromCharCode(10);
    const broken = GUARANTEE.replace(' (Art Rare', NL + '(Art Rare');
    assert.notEqual(await headerDigest({ ...HEADER, guaranteeText: broken }), WANT);
  });
});

describe('every committed field is actually bound', () => {
  // The whole reason the header exists. Revision 1 anchored runRoot alone, so the ladder, the guarantee,
  // the composition, the claims, the rarity table and the unsold policy could all be rewritten after sales
  // opened while every buyer's proof still verified. This sweep proves each one moves the digest.
  const mutations = {
    public_id: 'EX9',
    edition: 2,
    unit_count: 4,
    canon: 'BKR2',
    runRoot: 'ff'.repeat(32),
    codesCommit: 'ff'.repeat(32),
    blobHash: 'ff'.repeat(32),
    guaranteeText: GUARANTEE.replace('PSA 10', 'PSA 9'),
    rarityTableVersion: 'rarity-v2',
    rarityTableHash: 'ff'.repeat(32),
    closeByDate: '2028-03-31T23:59:59.000Z',
    salesCloseAt: '2028-01-31T23:59:59.000Z',
    unsoldPolicy: UNSOLD_POLICY.replace('is sold', 'may be withdrawn'),
  };

  for (const [field, value] of Object.entries(mutations)) {
    it(`changing ${field} changes the digest`, async () => {
      assert.notEqual(await headerDigest({ ...HEADER, [field]: value }), WANT);
    });
  }

  it('changing the composition changes the digest', async () => {
    const specs = SPECS.map((s) => (s.slot === 'packs' ? { ...s, qty_per_bundle: 4 } : s));
    assert.notEqual(await headerDigest({ ...HEADER, specs }), WANT);
  });

  it('changing the chase ladder changes the digest', async () => {
    const ladder = [{ ...LADDER[0], grade: '9' }];
    assert.notEqual(await headerDigest({ ...HEADER, chaseLadder: ladder }), WANT);
  });

  it('changing a claim changes the digest', async () => {
    const claims = CLAIMS.map((c) => (c.claim_type === 'min_grade' ? { ...c, value: '9' } : c));
    assert.notEqual(await headerDigest({ ...HEADER, claimsCanonical: claimsCanonical(claims) }), WANT);
  });
});

describe('the sub-encodings are order-independent in, order-fixed out', () => {
  it('sorts the composition by sort_order, not by the order it was handed', async () => {
    const shuffled = [SPECS[2], SPECS[0], SPECS[1]];
    assert.equal(compositionCanonical(shuffled), compositionCanonical(SPECS));
    assert.equal(await headerDigest({ ...HEADER, specs: shuffled }), WANT);
  });

  it('and refuses a composition that declares a slot twice', () => {
    assert.throws(() => compositionCanonical([...SPECS, { ...SPECS[0], sort_order: 3 }]), /twice/);
  });

  it('sorts the ladder by rank and requires ranks contiguous from 1', () => {
    const two = [
      { rank: 2, card_name: 'B', set_code: 'X', card_number: '2', language: 'JA', grading_company: 'PSA', grade: '10' },
      { rank: 1, card_name: 'A', set_code: 'X', card_number: '1', language: 'JA', grading_company: 'PSA', grade: '10' },
    ];
    assert.ok(chaseLadderCanonical(two).startsWith('1:1,1:A,'));
    assert.throws(() => chaseLadderCanonical([{ ...two[0] }]), /contiguous from 1/);
    assert.throws(() => chaseLadderCanonical([two[1], { ...two[0], rank: 3 }]), /contiguous from 1/);
  });

  it('and renders booleans as "0"/"1" whatever truthy shape the row carried', () => {
    // SQLite hands back 0/1 integers; a hand-built spec may carry true/false. Both must hash the same, or
    // the producer and an independent verifier reading the published JSON would disagree.
    const bools = SPECS.map((s) => ({ ...s, singleton: !!s.singleton, requires_cert: !!s.requires_cert, is_chase_slot: !!s.is_chase_slot }));
    assert.equal(compositionCanonical(bools), compositionCanonical(SPECS));
  });
});

describe('§10.5 amendment headers', () => {
  const AMENDED = {
    ...HEADER,
    runRoot: 'ab'.repeat(32),
    amendment: {
      predecessorHeaderDigest: WANT,
      seq: 1,
      reason: 'A slab was damaged in handling and replaced.',
      affectedBundleNumbers: [2],
      amendedAt: '2027-02-01T00:00:00.000Z',
    },
  };

  it('an ORIGINAL header omits all five amendment fields rather than emitting them empty', async () => {
    // ns('') is "0:," — five present-but-empty fields, not an absence. If an original emitted them, an
    // original and a zero-valued amendment would differ only by accident of the empty encoding, and a
    // reader could not tell which they were verifying.
    const original = headerCanonical(HEADER);
    const amended = headerCanonical(AMENDED);
    assert.ok(!original.endsWith('0:,0:,0:,0:,0:,'));
    assert.ok(amended.length > original.length);
    assert.notEqual(await headerDigest(AMENDED), WANT);
  });

  it('carries codesCommit unchanged, so codes cannot be reminted after the buyers are known', () => {
    assert.ok(headerCanonical(AMENDED).includes(HEADER.codesCommit));
  });

  it('commits its predecessor, so the chain cannot be rewritten from the middle', async () => {
    const forked = { ...AMENDED, amendment: { ...AMENDED.amendment, predecessorHeaderDigest: 'cd'.repeat(32) } };
    assert.notEqual(await headerDigest(forked), await headerDigest(AMENDED));
  });

  it('and commits which bundles it touched, zero-padded and ascending', async () => {
    // §10.5: a comma-joined ascending list of zero-padded numbers. Sorted here rather than trusted, so the
    // same amendment described two ways cannot produce two digests.
    const unsorted = { ...AMENDED, amendment: { ...AMENDED.amendment, affectedBundleNumbers: [3, 2] } };
    const sorted = { ...AMENDED, amendment: { ...AMENDED.amendment, affectedBundleNumbers: [2, 3] } };
    assert.equal(await headerDigest(unsorted), await headerDigest(sorted));
    assert.ok(headerCanonical(sorted).includes('7:002,003,'));
    assert.notEqual(await headerDigest(sorted), await headerDigest(AMENDED));
  });
});
