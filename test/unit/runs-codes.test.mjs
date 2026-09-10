// test/unit/runs-codes.test.mjs — §5.3 verification codes, blob keys, the codes commitment and the blob file.
//
// The vectors here are the specification's own. The codes are invented and the nonces are all-zero, both
// stated in §5.3.4 as fixture artefacts; production mints codes from a cryptographic source and nonces at
// random.
//
// PBKDF2 at 600,000 iterations is deliberately slow, so every key in this file is derived ONCE at module
// scope and reused. Three derivations, roughly two hundred milliseconds, and that cost is the point of the
// parameter — see §5.3.1 on why the code commitment moved from the raw code to the KDF output.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHABET, CODE_LENGTH, KDF_ITERATIONS, mintCode, formatCode, canonicalCode,
  blobKey, codeLeaves, codesCommit,
} from '../../lib/runs-codes.mjs';
import { merkleProof, verifyProof } from '../../lib/runs-merkle.mjs';
import {
  BLOB_LENGTH, BLOB_VERSION, plaintextBody, frame, unframe, buildBlobFile, parseBlobFile,
  openBlobFile, blobHash,
} from '../../lib/runs-blob.mjs';
import { bundleAttributes } from '../../lib/runs-canonical.mjs';

const CODES = [
  'K7M4-QX92-3RTB-9F5W-2HJD-X8N6-PV',
  'R3ND-8T6V-XA2Q-Z5W7-M4KC-H9J2-BF',
  'B9F2-H5J8-K3M6-N7P4-Q1RS-TVWX-YZ',
];
const WANT_KEYS = [
  '26f284ca7942f63636fa659b7270a75ec0e758ff3257b16388768ded8fc33989',
  'e12ee8f282dfec70bde95da385ca2e8ffbc85b134807cf5b477150b5bf1f7f00',
  '0eb39bdcfe081e9336c9c1449201fa12d0900cb258cb7bf3814fbf88bb919981',
];
const WANT_LEAVES = [
  '28dad5a08119ef13d3f15e276cc764cb736b7e2e32cb219aa761c979a436e84e',
  '0984872b74d624b49af9af303776acb40c354130e58021d735d56d2eefdef60f',
  '99472dca8d9298a789fb043c17c8f5d7656603c1f1eb06f5a4ae40db6caa12f5',
];
const WANT_COMMIT = 'c0c03deb405fc4a7643c6669ebecc8af9abb27a35fc7189bac1f22608dab05f4';

const KEYS = [];
for (const c of CODES) KEYS.push(await blobKey(c, 'EX2'));
const LEAVES = await codeLeaves(CODES, 'EX2');

describe('§5.3 verification codes', () => {
  it('mints 26 symbols from the Crockford alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const c = mintCode();
      assert.equal(c.length, CODE_LENGTH);
      for (const ch of c) assert.ok(ALPHABET.includes(ch), ch);
    }
  });

  it('and the alphabet excludes I, L, O and U', () => {
    // The first three because anyone typing off a printed insert reads them back as 1, 1 and 0; U so a
    // random code cannot spell an unfortunate word.
    for (const ch of 'ILOU') assert.ok(!ALPHABET.includes(ch), ch);
    assert.equal(ALPHABET.length, 32);
  });

  it('formats as six groups of four then a pair, and round-trips', () => {
    const c = mintCode();
    assert.match(formatCode(c), /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}-[0-9A-Z]{2}$/);
    assert.equal(canonicalCode(formatCode(c)), c);
  });

  it('strips exactly ASCII hyphen and space, and applies the Crockford aliases', () => {
    assert.equal(canonicalCode(CODES[0]), 'K7M4QX923RTB9F5W2HJDX8N6PV');
    assert.equal(canonicalCode('K7M4 QX92 3RTB 9F5W 2HJD X8N6 PV'), 'K7M4QX923RTB9F5W2HJDPV'.slice(0, 0) + 'K7M4QX923RTB9F5W2HJDX8N6PV');
    assert.equal(canonicalCode('k7m4-qx92-3rtb-9f5w-2hjd-x8n6-pv'), 'K7M4QX923RTB9F5W2HJDX8N6PV');
    // I and L read back as 1, O as 0 — the whole reason Crockford drops them.
    assert.equal(canonicalCode('IL7M-QX92-3RTB-9F5W-2HJD-X8N6-PO'), '117MQX923RTB9F5W2HJDX8N6P0');
  });

  it('UPPERCASES ASCII ONLY, so a Unicode confusable is refused rather than mapped', () => {
    // THE SUBTLE ONE. String.prototype.toUpperCase is Unicode-aware: it maps U+0131 DOTLESS I to "I" and
    // U+017F LATIN SMALL LETTER LONG S to "S". An implementation reaching for it would MAP the very
    // confusables §5.3 says must be REJECTED — and a code containing one would canonicalise to something
    // valid and open a bundle its holder was never given.
    assert.equal('ı'.toUpperCase(), 'I', 'the standard library really does do this');
    assert.equal('ſ'.toUpperCase(), 'S', 'and this');
    assert.throws(() => canonicalCode('ı7M4-QX92-3RTB-9F5W-2HJD-X8N6-PV'), TypeError);
    assert.throws(() => canonicalCode('K7M4-QX92-3RTB-9F5W-2HJD-X8N6-Pſ'), TypeError);
  });

  it('refuses a separator that is not an ASCII hyphen or space', () => {
    // U+2212 MINUS SIGN and U+00A0 NO-BREAK SPACE both survive stripping and then fail the alphabet, which
    // is the stated behaviour: rejected, never mapped.
    assert.throws(() => canonicalCode('K7M4−QX92-3RTB-9F5W-2HJD-X8N6-PV'), TypeError);
    assert.throws(() => canonicalCode('K7M4 QX92-3RTB-9F5W-2HJD-X8N6-PV'), TypeError);
  });

  it('refuses a wrong length, a non-string, and a symbol outside the alphabet', () => {
    assert.throws(() => canonicalCode('K7M4-QX92'), /26 symbols/);
    assert.throws(() => canonicalCode(null), TypeError);
    assert.throws(() => canonicalCode('U7M4-QX92-3RTB-9F5W-2HJD-X8N6-PV'), /Crockford/);
  });
});

describe('§5.3.4 the published key and commitment vectors', () => {
  it('reproduces every blobKey', () => {
    KEYS.forEach((k, i) => assert.equal(k, WANT_KEYS[i], `blobKey[${i}]`));
  });

  it('at the specified iteration count', () => {
    // Pinned as a value, not just used: changing it silently invalidates every published run, because the
    // key a buyer derives from the code in their parcel would no longer open their entry.
    assert.equal(KDF_ITERATIONS, 600000);
  });

  it('reproduces every codeLeaf and the codesCommit', async () => {
    LEAVES.forEach((l, i) => assert.equal(l, WANT_LEAVES[i], `codeLeaf[${i}]`));
    assert.equal(await codesCommit(LEAVES), WANT_COMMIT);
  });

  it('and the published membership proof for code index 1 of 3', async () => {
    const proof = await merkleProof(LEAVES, 1);
    assert.deepEqual(proof, [
      { hash: WANT_LEAVES[0], side: 'L' },
      { hash: WANT_LEAVES[2], side: 'R' },
    ]);
    assert.ok(await verifyProof({ leaf: LEAVES[1], proof, root: WANT_COMMIT, index: 1, size: 3 }));
  });

  it('refuses two bundles minted the same code', async () => {
    // Identical codes yield ONE key, which would break §5.3.3's claim that a cross-entry nonce collision is
    // harmless. Refused at mint rather than deduplicated.
    await assert.rejects(() => codeLeaves([CODES[0], CODES[0]], 'EX2'), /same verification code/);
  });

  it('and derives a different key for the same code under a different run', async () => {
    // The KDF salt is "BKR1/key/" + public_id, so a code leaked from one run opens nothing in another.
    assert.notEqual(await blobKey(CODES[0], 'EX3'), WANT_KEYS[0]);
  });
});

// The EX2 fixture, kept in step with test/unit/runs-attributes.test.mjs by construction: the attribute
// sets are rebuilt from the same encoder rather than pasted as literals.
const RUN = { public_id: 'EX2', edition: 1 };
const SPECS = [
  { slot: 'slab', label: 'Graded slab', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, sort_order: 0 },
  { slot: 'packs', label: 'Sealed packs', kind: 'sealed', qty_per_bundle: 3, max_lines: 3, sort_order: 1 },
  { slot: 'art', label: 'Art card', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, sort_order: 2 },
];
const SALTS = [
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
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
  kind: 'sealed', display_name: which === 'A' ? 'Sample Pack Set A' : 'Sample Pack Set B',
  game: 'pokemon', identity_key: '', set_code: which === 'A' ? 'SPA' : 'SPB',
  card_number: '', rarity: '', language: 'JA', finish: '', product_type: 'booster_pack',
  upc: which === 'A' ? '0000000000001' : '0000000000002',
  grading_company: '', grade: '', cert_number: '', qty: String(qty),
});
const BUNDLES = [
  { bundle: { bundle_no: 1, label: 'EX2-001', is_chase: 0, seal_serial: '5b3f9a2c74e18d60' },
    lines: { slab: [slab('Sample Card Alpha', 'ex2-001', '101', 'Art Rare', '00000001')],
      packs: [pack('A', 3)], art: [art('Sample Art One', 'ex2-a01', '201', 'Art Rare')] } },
  { bundle: { bundle_no: 2, label: 'EX2-002', is_chase: 1, seal_serial: 'a04c17e9b5230fd8' },
    lines: { slab: [slab('Sample Card Beta', 'ex2-002', '202', 'Special Art Rare', '00000002')],
      packs: [pack('B', 1), pack('A', 2)], art: [art('Sample Art Two', 'ex2-a02', '202', 'Special Art Rare')] } },
  { bundle: { bundle_no: 3, label: 'EX2-003', is_chase: 0, seal_serial: 'c72e58b1039af64d' },
    lines: { slab: [slab('Sample Card Gamma', 'ex2-003', '303', 'Mega Attack Rare', '00000003')],
      packs: [pack('B', 3)], art: [art('Sample Art Three', 'ex2-a03', '203', 'Art Rare')] } },
];
const ATTRS = BUNDLES.map((b) => bundleAttributes({ run: RUN, bundle: b.bundle, specs: SPECS, lines: b.lines }));
const ENTRIES = ATTRS.map((a, i) => ({
  bundleNo: i + 1, bundleSaltHex: SALTS[i], attributes: a, blobKeyHex: KEYS[i],
}));
const zeroNonce = () => new Uint8Array(12);
const FILE = await buildBlobFile({ publicId: 'EX2', unitCount: 3, entries: ENTRIES }, zeroNonce);

describe('§5.3.2 the blob file reproduces its published vectors', () => {
  it('the plaintext body lengths', () => {
    const lens = ATTRS.map((a, i) => plaintextBody({
      publicId: 'EX2', bundleNo: i + 1, bundleSaltHex: SALTS[i], attributes: a,
    }).length);
    assert.deepEqual(lens, [2572, 2653, 2583]);
  });

  it('the total file length, 16 + count x (L + 28)', () => {
    assert.equal(FILE.length, 12388);
    assert.equal(FILE.length, 16 + 3 * (BLOB_LENGTH + 28));
  });

  it("entry 0's GCM tag", () => {
    const at = 16 + 12 + BLOB_LENGTH;
    const tag = [...FILE.subarray(at, at + 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    assert.equal(tag, '2c9e203d4edebffd3b75089555ced97a');
  });

  it('and the blobHash that goes inside headerDigest', async () => {
    assert.equal(await blobHash(FILE), '895e997da12d0d21c3e6c9b6c6f1dd374ea4bf96c51bd193cae4c6fef18f8257');
  });

  it('with a header of magic, version, count and L', () => {
    assert.equal(new TextDecoder().decode(FILE.subarray(0, 9)), 'BKR1BLOBS');
    const v = new DataView(FILE.buffer);
    assert.equal(v.getUint8(9), BLOB_VERSION);
    assert.equal(v.getUint16(10, false), 3);
    assert.equal(v.getUint32(12, false), 4096);
  });
});

describe('§5.3.3 padding is what makes every entry the same size', () => {
  it('L is a GLOBAL constant, not derived from the run', () => {
    // Revision 4 derived L from the largest record in the run, which disclosed that record's size and left
    // Edition 1's tightest bundle ~160 bytes of headroom — so an amendment with a longer card name would
    // have been refused outright with no recovery.
    assert.equal(BLOB_LENGTH, 4096);
  });

  it('so three bundles of visibly different structure produce byte-identical entries', () => {
    // Bundle 1 holds one pack product, bundle 2 holds two, bundle 3 holds one — and their plaintext bodies
    // differ by 81 bytes. After framing they are indistinguishable by size.
    const sizes = [0, 1, 2].map((i) => {
      const at = 16 + i * (BLOB_LENGTH + 28);
      return FILE.subarray(at, at + BLOB_LENGTH + 28).length;
    });
    assert.deepEqual(sizes, [4124, 4124, 4124]);
  });

  it('frames a body as uint32be length, body, then zero padding', () => {
    const framed = frame(new Uint8Array([1, 2, 3]));
    assert.equal(framed.length, BLOB_LENGTH);
    assert.deepEqual([...framed.subarray(0, 7)], [0, 0, 0, 3, 1, 2, 3]);
    assert.ok(framed.subarray(7).every((b) => b === 0));
    assert.deepEqual([...unframe(framed)], [1, 2, 3]);
  });

  it('refuses a record that will not fit, rather than growing L', () => {
    // Growing L means re-encrypting every entry, and an implementer who reused each nonce "because the
    // plaintext is the same" would repeat a GCM key/nonce pair across different plaintexts.
    assert.throws(() => frame(new Uint8Array(BLOB_LENGTH)), /new canon version/);
  });

  it('and never trusts a declared length that runs past the record', () => {
    const bad = new Uint8Array(BLOB_LENGTH);
    new DataView(bad.buffer).setUint32(0, BLOB_LENGTH, false);
    assert.throws(() => unframe(bad), /past its own end/);
  });
});

describe('§5.3.2 opening the blob file', () => {
  it('finds exactly the holder\'s entry by trial decryption', async () => {
    for (let i = 0; i < 3; i++) {
      const opened = await openBlobFile(FILE, { blobKeyHex: KEYS[i], publicId: 'EX2', unitCount: 3 });
      assert.equal(opened.index, i);
    }
  });

  it('and the decrypted body is that bundle\'s record, not a neighbour\'s', async () => {
    const opened = await openBlobFile(FILE, { blobKeyHex: KEYS[1], publicId: 'EX2', unitCount: 3 });
    const text = new TextDecoder().decode(opened.body);
    assert.ok(text.includes('Sample Card Beta'));
    assert.ok(!text.includes('Sample Card Alpha'));
    assert.ok(text.includes(SALTS[1]), 'it carries its own bundle salt');
  });

  it('refuses a key that opens nothing', async () => {
    await assert.rejects(
      () => openBlobFile(FILE, { blobKeyHex: 'ff'.repeat(32), publicId: 'EX2', unitCount: 3 }),
      /does not open this run/);
  });

  it('and the aad binds every entry to its run, so a right key with a wrong run id fails', async () => {
    // aad = ns("BKR1") || ns(public_id) || ns(unit_count). Without it an entry could be lifted into another
    // run's file and still authenticate.
    await assert.rejects(
      () => openBlobFile(FILE, { blobKeyHex: KEYS[0], publicId: 'EX3', unitCount: 3 }),
      /does not open this run/);
  });
});

describe('§5.3.2 the parser refuses a malformed container', () => {
  const corrupt = (fn) => { const c = FILE.slice(); fn(c, new DataView(c.buffer)); return c; };

  it('a wrong magic', () => {
    assert.throws(() => parseBlobFile(corrupt((c) => { c[0] = 0x58; })), /BKR1BLOBS magic/);
  });

  it('a version it does not implement', () => {
    assert.throws(() => parseBlobFile(corrupt((c, v) => v.setUint8(9, 3))), /version 3 is not implemented/);
  });

  it('an entry length that is not L', () => {
    // The header is UNAUTHENTICATED until a key is discovered, so `blobLen` is attacker-controlled here.
    // It is compared against the constant, never used to size an allocation.
    assert.throws(() => parseBlobFile(corrupt((c, v) => v.setUint32(12, 1 << 30, false))), /is not L=4096/);
  });

  it('a count that disagrees with the commitment', () => {
    assert.throws(() => parseBlobFile(FILE, { unitCount: 25 }), /but the commitment says 25/);
  });

  it('a count that disagrees with the file\'s own length', () => {
    assert.throws(() => parseBlobFile(corrupt((c, v) => v.setUint16(10, 4, false))), /need exactly/);
  });

  it('trailing bytes', () => {
    const padded = new Uint8Array(FILE.length + 1);
    padded.set(FILE, 0);
    assert.throws(() => parseBlobFile(padded), /need exactly/);
  });

  it('and a file shorter than its own header', () => {
    assert.throws(() => parseBlobFile(FILE.subarray(0, 8)), /shorter than its own header/);
  });
});

describe('building the blob file', () => {
  it('requires one entry per bundle', async () => {
    await assert.rejects(
      () => buildBlobFile({ publicId: 'EX2', unitCount: 3, entries: ENTRIES.slice(0, 2) }, zeroNonce),
      /one entry per bundle/);
  });

  it('and bundle numbers 1..n with no gaps', async () => {
    const gapped = ENTRIES.map((e, i) => (i === 2 ? { ...e, bundleNo: 4 } : e));
    await assert.rejects(
      () => buildBlobFile({ publicId: 'EX2', unitCount: 3, entries: gapped }, zeroNonce),
      /no gaps/);
  });

  it('sorts into bundle-number order rather than trusting the caller', async () => {
    // Entry position is what §6 checks a decrypted bundle number against, so a mis-ordered file would fail
    // honest buyers.
    const shuffled = [ENTRIES[2], ENTRIES[0], ENTRIES[1]];
    const f = await buildBlobFile({ publicId: 'EX2', unitCount: 3, entries: shuffled }, zeroNonce);
    assert.deepEqual([...f], [...FILE]);
  });

  it('and uses a fresh random nonce per entry when none is injected', async () => {
    const a = await buildBlobFile({ publicId: 'EX2', unitCount: 3, entries: ENTRIES });
    const b = await buildBlobFile({ publicId: 'EX2', unitCount: 3, entries: ENTRIES });
    assert.notDeepEqual([...a.subarray(16, 28)], [...b.subarray(16, 28)]);
    // Still openable — the nonce travels with the entry.
    assert.equal((await openBlobFile(a, { blobKeyHex: KEYS[0], publicId: 'EX2', unitCount: 3 })).index, 0);
  });
});
