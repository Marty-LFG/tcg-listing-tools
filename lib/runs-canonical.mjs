// lib/runs-canonical.mjs — BKR1 canonical encoding. See docs/RUNS_PLAN.md §4.
//
// ISOMORPHIC ON PURPOSE. This file is served to the browser over HTTP and imported by the public
// verification page, because a buyer has to be able to recompute their own bundle's hash without
// trusting anything we run. That is why it uses WebCrypto (present in Node 24 and every browser) and
// imports nothing from node:.
//
// WHY NOT JSON. JSON object key order is insertion order — stable today, silently reordered by a
// future refactor, and a reordering changes every published hash. Every value is length-prefixed
// instead, so nothing a card name contains can break the framing.
//
// THE HASHES THIS FILE FEEDS ARE ANCHORED INTO BITCOIN AND CAN NEVER BE RE-ISSUED. A change to
// normalizeValue or ns is not a refactor: it silently invalidates every commitment already published.
// The vectors in test/unit/runs-canonical.test.mjs are taken from the reviewed specification and are
// the only thing standing between a tidy-up and a run nobody can verify.
//
// SCOPE. Attributes, line assignment, padding and the numeric grammars are R2-1 and land on top of
// these two primitives. They are here first because the rarity table (lib/runs-rarity.mjs) commits to
// a canonical form, and duplicating either primitive to get there is precisely the drift the rest of
// this module set is built to prevent.

// The six code points §4.2 trims, and no others.
//
// NOT String.prototype.trim, and this is measured rather than pedantic: JavaScript's trim also strips
// U+3000 IDEOGRAPHIC SPACE, U+FEFF and U+00A0, and Python's str.strip strips a different set again.
// Delegating to a runtime would make two conforming implementations disagree about a published hash —
// the specification pins a vector whose leading U+3000 must SURVIVE, and trim() gets it wrong.
const TRIM = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

const isTrim = (s, i) => TRIM.has(s.charCodeAt(i));

/**
 * §4.2 value normalisation: NFC, then the six-code-point trim, then a well-formedness check.
 *
 * Input is STRINGS ONLY. null and undefined become the empty string; a boolean, number, array or
 * object is rejected rather than stringified by language default, because "1" and "true" and "[object
 * Object]" are three different runtimes' opinions and only one of them can be in the hash.
 */
export function normalizeValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') {
    throw new TypeError(`BKR1 values are strings; got ${Array.isArray(v) ? 'array' : typeof v}. `
      + 'Convert through the grammars in §4.3 rather than letting the language decide.');
  }
  const nfc = v.normalize('NFC');
  let a = 0, b = nfc.length;
  while (a < b && isTrim(nfc, a)) a++;
  while (b > a && isTrim(nfc, b - 1)) b--;
  const out = nfc.slice(a, b);

  // A lone surrogate or a NUL is INVALID, never repaired. Browsers silently substitute U+FFFD when
  // encoding a lone surrogate to UTF-8 while strict server encoders throw, so a producer that
  // "helpfully" fixed one would hash something the verifier cannot reproduce.
  for (let i = 0; i < out.length; i++) {
    const c = out.charCodeAt(i);
    if (c === 0) throw new TypeError('BKR1 values may not contain U+0000');
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = out.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) throw new TypeError('BKR1 values may not contain an unpaired surrogate');
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError('BKR1 values may not contain an unpaired surrogate');
    }
  }
  return out;
}

const utf8 = new TextEncoder();

/** Byte length of a string's UTF-8 encoding — the number that prefixes it. */
export const byteLength = (s) => utf8.encode(s).length;

/**
 * §4.1: ns(s) = decimal(byteLength(s)) + ":" + s + ","
 *
 * The length is in BYTES, not code units: ns("Iono: 7,3") is "9:Iono: 7,3," and ns("") is "0:,".
 * Callers pass already-normalised strings — this function does not normalise, so that a caller
 * cannot accidentally normalise twice and a verifier can check the two steps separately.
 */
export const ns = (s) => `${byteLength(s)}:${s},`;

/** Normalise and encode in one step, for the common case. */
export const nsValue = (v) => ns(normalizeValue(v));

/** Lowercase hex. §4.2: hex is lowercase everywhere it is encoded or compared. */
export function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * SHA-256 over an optional single-byte domain prefix and a UTF-8 string.
 *
 * The prefix is the second-preimage defence and is never optional where the specification gives one:
 * without it a 64-byte "leaf" that is really two concatenated node hashes verifies as a leaf, and a
 * tree can be presented as having different contents. 0x06 is the rarity table's.
 */
export async function sha256Prefixed(prefix, text) {
  const body = utf8.encode(text);
  const buf = prefix == null ? body : (() => {
    const b = new Uint8Array(body.length + 1);
    b[0] = prefix;
    b.set(body, 1);
    return b;
  })();
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}

/** Byte-wise ordering over UTF-8, which is what §4.2 specifies — never localeCompare. */
export function byteCompare(a, b) {
  const x = utf8.encode(a), y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
