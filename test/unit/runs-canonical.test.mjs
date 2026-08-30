// test/unit/runs-canonical.test.mjs — the BKR1 encoding primitives (lib/runs-canonical.mjs).
//
// THESE ARE NOT ORDINARY UNIT TESTS. The hashes these two functions feed get timestamped into Bitcoin
// and can never be re-issued, so a well-meant tidy-up here does not break a test in CI — it silently
// makes every commitment already published unverifiable, on a page a customer is looking at, months
// later. The vectors below are lifted from the reviewed specification (docs/RUNS_PLAN.md §4.1, §4.10.3)
// and reproduce its exact published digests. If one fails, the encoding changed; the answer is never
// to update the expected value.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeValue, ns, nsValue, byteLength, toHex, sha256Prefixed, byteCompare,
} from '../../lib/runs-canonical.mjs';

describe('ns — length-prefixed framing', () => {
  it('reproduces the published vectors', () => {
    assert.equal(ns('Iono: 7,3'), '9:Iono: 7,3,');
    assert.equal(ns(''), '0:,');
  });

  it('counts BYTES, not code units — the difference is the whole point on a Japanese card name', () => {
    assert.equal(byteLength('リザードン'), 15);
    assert.equal(ns('リザードン'), '15:リザードン,');
    // An astral code point is two UTF-16 units and four UTF-8 bytes. Counting units would frame short.
    assert.equal(ns('\u{1F600}'), '4:\u{1F600},');
  });

  it('a value full of separators cannot break the framing — which is why JSON is not used', () => {
    assert.equal(ns('a,b:c'), '5:a,b:c,');
    assert.equal(ns('3:xyz,'), '6:3:xyz,,');
  });
});

describe('normalizeValue — §4.2, and deliberately NOT String.prototype.trim', () => {
  it('composes to NFC', () => {
    // Written as code points on both sides. Two forms of e-acute are indistinguishable in a diff,
    // and an editor that normalised this file on save would turn the test green without the
    // function under test doing anything at all.
    const decomposed = 'Caf' + String.fromCodePoint(0x65, 0x0301);   // e + COMBINING ACUTE
    const composed = 'Caf' + String.fromCodePoint(0x00e9);           // precomposed
    assert.notEqual(decomposed, composed, 'the fixture itself must differ, or this proves nothing');
    assert.equal(normalizeValue(decomposed), composed);
    assert.equal(normalizeValue(composed), composed);
  });

  it('strips exactly the six whitespace code points, and no others', () => {
    for (const c of ['\t', '\n', '\v', '\f', '\r', ' ']) {
      assert.equal(normalizeValue(c + 'x' + c), 'x', JSON.stringify(c) + ' should be trimmed');
    }
    // Everything JavaScript's trim() ALSO strips, which this rule does not. Written as code points
    // rather than literal characters, because a literal one is invisible in a diff and an editor
    // that helpfully normalised the file would turn this test green while the rule stayed broken.
    //
    // Asserted as 'still three code points long' rather than 'unchanged', because several of these
    // are legitimately REWRITTEN by NFC — U+2000 EN QUAD canonically decomposes to U+2002 — and
    // 'not trimmed' is a different claim from 'not normalised'.
    const NOT_TRIMMED = [
      0x0085, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
      0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ];
    for (const cp of NOT_TRIMMED) {
      const c = String.fromCodePoint(cp);
      const out = normalizeValue(c + 'x' + c);
      const at = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
      assert.equal([...out].length, 3, at + ' must SURVIVE the trim');
      assert.notEqual(out, 'x', at + ' was trimmed');
    }
  });

  it('null and undefined are the empty string; other types are refused, never stringified', () => {
    assert.equal(normalizeValue(null), '');
    assert.equal(normalizeValue(undefined), '');
    for (const v of [10, true, false, ['a'], { a: 1 }, 0]) {
      assert.throws(() => normalizeValue(v), /BKR1 values are strings/, JSON.stringify(v));
    }
  });

  it('refuses a lone surrogate or a NUL rather than repairing it', () => {
    assert.throws(() => normalizeValue('a\ud800b'), /unpaired surrogate/);
    assert.throws(() => normalizeValue('a\udc00b'), /unpaired surrogate/);
    assert.throws(() => normalizeValue('a' + String.fromCharCode(0) + 'b'), /U\+0000/);
    assert.equal(normalizeValue('a\u{1F600}b'), 'a\u{1F600}b', 'a well-formed pair is fine');
  });
});

// §4.10.3. Revision 3's vector for this was INERT — its ideographic space was interior, so no
// implementation touched it and a wrong one passed. This one diverges: the leading U+3000 must survive
// and the trailing TAB must go, and the specification publishes both digests so the wrong answer is
// identifiable rather than merely unequal.
describe('the normalisation vector that actually diverges', () => {
  const input = String.fromCodePoint(
    0x3000, 0x50, 0x6f, 0x6b, 0xe9, 0x6d, 0x6f, 0x6e, 0x20,
    0x43, 0x61, 0x66, 0x65, 0x0301, 0x09,
  );

  it('normalises to the published code point sequence', () => {
    assert.deepEqual(
      [...normalizeValue(input)].map((c) => c.codePointAt(0)),
      [0x3000, 0x50, 0x6f, 0x6b, 0xe9, 0x6d, 0x6f, 0x6e, 0x20, 0x43, 0x61, 0x66, 0xe9],
    );
  });

  it('encodes to the published netstring', () => {
    assert.equal(nsValue(input), '17:　Pokémon Café,');
  });

  it('digests to the published hash', async () => {
    assert.equal(await sha256Prefixed(null, nsValue(input)),
      'c5ff46436f52110a739af532856342fa623a30392114b32410717ad22bddd597');
  });

  it('and an implementation that delegated to trim() would produce the OTHER published hash', async () => {
    // Pinned so the failure mode is named rather than merely detected: this exact digest coming back
    // from the assertion above means someone reached for the runtime's whitespace set.
    const lazy = await sha256Prefixed(null, ns(input.normalize('NFC').trim()));
    assert.equal(lazy, '2567d62c63fb678b1546a7ccb5c2b89a7ffe85c62562f79331e3e5806e99ac80');
    assert.notEqual(lazy, await sha256Prefixed(null, nsValue(input)));
  });
});

describe('domain separation', () => {
  it('the same bytes under different prefixes give different digests', async () => {
    const [none, zero, one, six] = await Promise.all(
      [null, 0x00, 0x01, 0x06].map((p) => sha256Prefixed(p, 'x')),
    );
    assert.equal(new Set([none, zero, one, six]).size, 4);
  });

  it('digests are lowercase hex, 64 characters', async () => {
    assert.match(await sha256Prefixed(0x06, ''), /^[0-9a-f]{64}$/);
  });

  it('toHex pads a byte below 16 — an unpadded nibble would shift every later character', () => {
    assert.equal(toHex(new Uint8Array([0, 1, 15, 16, 255])), '00010f10ff');
  });
});

describe('byteCompare — UTF-8 byte order, never localeCompare', () => {
  it('orders by bytes, so a space sorts before an underscore', () => {
    // The exact pair the rarity table depends on: 'mega attack rare' must precede 'mega_attack_rare'.
    assert.ok(byteCompare('mega attack rare', 'mega_attack_rare') < 0);
  });

  it('puts uppercase ASCII before lowercase, which localeCompare does not', () => {
    assert.ok(byteCompare('Z', 'a') < 0);
    assert.ok('Z'.localeCompare('a') > 0, 'localeCompare disagrees — that is why it is not used');
  });

  it('a prefix sorts before the longer string', () => {
    assert.ok(byteCompare('art', 'art rare') < 0);
  });
});
