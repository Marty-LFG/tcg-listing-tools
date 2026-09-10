// lib/runs-codes.mjs - §5.3 verification codes, blob keys and the codes commitment.
//
// ISOMORPHIC. Served to the browser over HTTP and imported by Node, WebCrypto only, because the buyer's
// page derives its own blob key from the code on the insert. A verifier that drifts from the producer
// fails an honest bundle, which is worse than not verifying at all.
//
// A CODE IS A BEARER SECRET. Whoever reads it can decrypt that bundle's record and learn its contents
// before the run closes, which is why it is printed INSIDE the parcel and never on the outside, and why
// no un-iterated function of it is exposed anywhere - see codeLeaves below.

import { ns, toHex, fromHex } from './runs-canonical.mjs';
import { codeLeaf, merkleRoot } from './runs-merkle.mjs';

const utf8 = new TextEncoder();

// Crockford's 32 symbols. I, L, O and U are ABSENT by construction: the first three are read back as 1,
// 1 and 0 by anyone typing off a printed insert, and U is excluded so a random code cannot spell an
// unfortunate word.
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** §5.3: 26 symbols of Crockford base32, so 130 bits. */
export const CODE_LENGTH = 26;

/** §5.3: PBKDF2 iterations. Fixed by the canon version - changing it invalidates every published run. */
export const KDF_ITERATIONS = 600000;

/**
 * Mint one verification code from a cryptographic random source.
 *
 * 256 is an exact multiple of 32, so masking a uniform byte to five bits is itself uniform and no
 * rejection sampling is needed. Written as a mask rather than a modulo so that stays visibly true.
 */
export function mintCode() {
  const raw = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(raw);
  let out = '';
  for (const b of raw) out += ALPHABET[b & 31];
  return out;
}

/** Six groups of four then a pair, the form printed on the insert: K7M4-QX92-3RTB-9F5W-2HJD-X8N6-PV */
export function formatCode(code) {
  const c = canonicalCode(code);
  return [c.slice(0, 4), c.slice(4, 8), c.slice(8, 12), c.slice(12, 16),
    c.slice(16, 20), c.slice(20, 24), c.slice(24)].join('-');
}

// ASCII-ONLY UPPERCASING, AND THIS IS NOT PEDANTRY. String.prototype.toUpperCase is Unicode-aware, so it
// maps U+0131 DOTLESS I to 'I' and U+017F LONG S to 'S' - it would MAP the very confusables §5.3 says
// must be REJECTED. A code containing one would canonicalise to something valid and open a bundle its
// holder was never given. Only a-z is folded here; every other character survives unchanged and is then
// refused by the alphabet check.
const asciiUpper = (s) => s.replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32));

/**
 * §5.3 canonicalisation. EVERY formula in the specification takes this, never the printed form.
 *
 * Removes exactly ASCII hyphen and ASCII space - no other separator. A non-breaking hyphen or an
 * ideographic space is not silently accepted, because a code that canonicalises two ways is a code that
 * opens a bundle two ways.
 */
export function canonicalCode(raw) {
  if (typeof raw !== 'string') throw new TypeError('a verification code must be a string');
  const stripped = raw.replace(/[- ]/g, '');
  const upper = asciiUpper(stripped);
  // Crockford aliases, applied AFTER uppercasing so a lower-case l is handled too.
  const aliased = upper.replace(/[IL]/g, '1').replace(/O/g, '0');
  if (aliased.length !== CODE_LENGTH) {
    throw new TypeError(`a verification code is ${CODE_LENGTH} symbols; got ${aliased.length}`);
  }
  for (const ch of aliased) {
    if (!ALPHABET.includes(ch)) throw new TypeError(`"${ch}" is not a Crockford base32 symbol`);
  }
  return aliased;
}

/**
 * §5.3 blobKey = PBKDF2-HMAC-SHA-256(canonicalCode, "BKR1/key/" + public_id, 600000, 32 bytes).
 *
 * The salt is per-RUN rather than per-bundle, which is deliberate and has a stated cost: an attacker
 * grinding one run attacks all its codes at once, so the expected time to a first hit is N/(K+1) of the
 * single-target figure. §7 states that multi-target factor rather than claiming it away. A per-bundle
 * salt would have to be published, and publishing a per-bundle value the buyer does not already hold
 * means publishing something that maps to their bundle.
 */
export async function blobKey(code, publicId) {
  const material = await crypto.subtle.importKey(
    'raw', utf8.encode(canonicalCode(code)), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: utf8.encode(`BKR1/key/${publicId}`),
    iterations: KDF_ITERATIONS,
    hash: 'SHA-256',
  }, material, 256);
  return toHex(new Uint8Array(bits));
}

/**
 * §5.3.1: the code commitment, over KDF OUTPUTS rather than raw codes.
 *
 * Revision 3 had codeLeaf = SHA-256(0x04 || ns(code)) - one un-iterated hash of the very secret the 600k
 * PBKDF2 iterations exist to protect. Both external reviewers found it independently. The leaves are
 * PUBLISHED, since §6's membership check needs them to come from somewhere, so that would have handed
 * an attacker one fast verifier per bundle; and even delivered privately, every buyer's proof carries a
 * neighbour's raw leaf. Measured: 37.8 microseconds for the raw-code leaf against 64 milliseconds for
 * this one, and against dedicated hardware the gap is the full 600,000x.
 */
export async function codeLeaves(codes, publicId) {
  const seen = new Set();
  const leaves = [];
  for (const code of codes) {
    const canonical = canonicalCode(code);
    // Two identical codes yield ONE key, which would break the claim in §5.3.3 that a cross-entry nonce
    // collision is harmless. Refused rather than deduplicated.
    if (seen.has(canonical)) throw new Error('two bundles were minted the same verification code');
    seen.add(canonical);
    leaves.push(await codeLeaf(await blobKey(canonical, publicId)));
  }
  return leaves;
}

/** §5.3: codesCommit = merkleRoot(codeLeaf(0) .. codeLeaf(n-1)) in BUNDLE-NUMBER order. */
export const codesCommit = (leaves) => merkleRoot(leaves);

export { codeLeaf, fromHex, ns };
