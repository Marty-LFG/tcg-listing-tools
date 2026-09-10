// lib/runs-blob.mjs — §5.3.2 and §5.3.3: the single encrypted blob file.
//
// ISOMORPHIC. The buyer's page parses and trial-decrypts this in the browser; the producer builds it in
// lock phase 1. WebCrypto only, one implementation, no mirror to drift.
//
// ONE FILE, AND NO FILENAME DERIVED FROM ANY CODE. Revision 1 named each blob
// SHA-256('BKR1/blob/' + code), which made the FILENAME a single-hash verifier for the very secret the
// 600,000 PBKDF2 iterations exist to protect — an attacker could test a candidate code with one SHA-256
// instead of the full KDF. It was the sharpest finding of the whole review programme. One file also removes
// per-blob CDN access logs, which would otherwise let an observer record that an address fetched a
// particular bundle's blob and combine that with the close-out disclosure, and upload-order metadata
// mapping opaque names back to bundle order.

import { ns, toHex, fromHex, bundleNoToken } from './runs-canonical.mjs';

const utf8 = new TextEncoder();
const MAGIC = utf8.encode('BKR1BLOBS');

/** §5.3.2 container version. */
export const BLOB_VERSION = 2;

/**
 * §5.3.3: the framed plaintext length, a GLOBAL CONSTANT for every run of this canon version.
 *
 * Revision 4 derived it per run from the largest record, which disclosed that record's size and left the
 * tightest Edition 1 bundle about 160 bytes of headroom — so an amendment swapping in a card with a longer
 * name would have been refused outright with no recovery. A fixed 4096 gives every bundle over a kilobyte
 * of slack and makes entry size identical ACROSS EDITIONS, so nothing is inferable by comparing runs.
 */
export const BLOB_LENGTH = 4096;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 16;                                  // 9 magic + 1 version + 2 count + 4 blobLen
const ENTRY_BYTES = BLOB_LENGTH + NONCE_BYTES + TAG_BYTES;

/** §5.3.3 plaintextBody. Attributes in sorted name order — the same order the bundle tree used. */
export function plaintextBody({ publicId, bundleNo, bundleSaltHex, attributes }) {
  let s = ns('BKR1-BLOB') + ns(String(publicId)) + ns(bundleNoToken(bundleNo))
    + ns(String(bundleSaltHex)) + ns(String(attributes.length));
  for (const attr of attributes) s += ns(attr.name) + ns(attr.value);
  return utf8.encode(s);
}

/** §5.3.3 framed = uint32be(byteLength(body)) || body || 0x00 padding, to exactly BLOB_LENGTH. */
export function frame(body) {
  if (body.length + 4 > BLOB_LENGTH) {
    // Refused rather than re-padded: growing L would mean re-encrypting every entry, and an implementer
    // who reused each nonce "because the plaintext is the same" would repeat a GCM key/nonce pair across
    // different plaintexts, leaking their XOR and the authentication key.
    throw new RangeError(`a bundle record of ${body.length} bytes exceeds L=${BLOB_LENGTH}; `
      + 'a longer composition needs a new canon version, not a longer L');
  }
  const out = new Uint8Array(BLOB_LENGTH);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/** The inverse, refusing a declared length that does not fit — the padding is never trusted. */
export function unframe(framed) {
  const n = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(0, false);
  if (n + 4 > framed.length) throw new RangeError('framed record declares a length past its own end');
  return framed.subarray(4, 4 + n);
}

/** §5.3.3 aad. Binds every entry to the run and its size, so an entry cannot be moved between runs. */
export const blobAad = (publicId, unitCount) =>
  utf8.encode(ns('BKR1') + ns(String(publicId)) + ns(String(unitCount)));

const importKey = (keyHex) => crypto.subtle.importKey(
  'raw', fromHex(keyHex, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/**
 * Build the complete blob file.
 *
 * `nonceFor` exists ONLY so the published test vectors, which use all-zero nonces, are reproducible. It
 * defaults to a cryptographic random source and production never passes it. §5.3.3 permits an all-zero
 * nonce in principle — each entry has its own key, so uniqueness under a key is what matters — but a
 * fixture is not a reason to ship a fixed nonce.
 */
export async function buildBlobFile({ publicId, unitCount, entries }, nonceFor = null) {
  if (entries.length !== unitCount) {
    throw new RangeError(`the blob file holds one entry per bundle: got ${entries.length} for ${unitCount}`);
  }
  if (unitCount < 1 || unitCount > 0xffff) throw new RangeError('unit_count must fit a uint16');
  const aad = blobAad(publicId, unitCount);
  const file = new Uint8Array(HEADER_BYTES + unitCount * ENTRY_BYTES);
  file.set(MAGIC, 0);
  const view = new DataView(file.buffer);
  view.setUint8(9, BLOB_VERSION);
  view.setUint16(10, unitCount, false);
  view.setUint32(12, BLOB_LENGTH, false);

  // ASCENDING BUNDLE-NUMBER ORDER, sorted here rather than trusted from the caller: entry position is what
  // §6 checks a decrypted bundle number against, so a mis-ordered file would fail honest buyers.
  const ordered = [...entries].sort((x, y) => x.bundleNo - y.bundleNo);
  ordered.forEach((e, i) => {
    if (e.bundleNo !== i + 1) {
      throw new RangeError(`bundle numbers must be 1..${unitCount} with no gaps; position ${i} holds ${e.bundleNo}`);
    }
  });

  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    const nonce = nonceFor ? nonceFor(i) : crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    if (nonce.length !== NONCE_BYTES) throw new RangeError('a GCM nonce is 12 bytes');
    const framed = frame(plaintextBody({ publicId, ...e }));
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: TAG_BYTES * 8 },
      await importKey(e.blobKeyHex), framed));
    const at = HEADER_BYTES + i * ENTRY_BYTES;
    file.set(nonce, at);
    file.set(sealed, at + NONCE_BYTES);       // WebCrypto returns ciphertext || tag, the container's layout
  }
  return file;
}

/**
 * §5.3.2 parse. Every MUST-check, before a single byte is allocated on the container's own say-so.
 *
 * The header is UNAUTHENTICATED until a key is discovered, so `count` and `blobLen` are attacker-controlled
 * input at this point. They are checked against the actual byte length rather than used to size anything.
 */
export function parseBlobFile(fileBytes, { unitCount } = {}) {
  const file = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
  if (file.length < HEADER_BYTES) throw new TypeError('blob file is shorter than its own header');
  for (let i = 0; i < MAGIC.length; i++) {
    if (file[i] !== MAGIC[i]) throw new TypeError('blob file does not start with the BKR1BLOBS magic');
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const version = view.getUint8(9);
  if (version !== BLOB_VERSION) throw new TypeError(`blob container version ${version} is not implemented`);
  const count = view.getUint16(10, false);
  const blobLen = view.getUint32(12, false);
  // L is a global constant of this canon version, so any other value is not this format. Stricter than
  // "L within a sane bound", and the stricter reading is the correct one: it cannot be talked into a large
  // allocation, because it is not a bound at all.
  if (blobLen !== BLOB_LENGTH) throw new TypeError(`blob entry length ${blobLen} is not L=${BLOB_LENGTH}`);
  if (count < 1) throw new TypeError('blob file declares no entries');
  if (unitCount != null && count !== unitCount) {
    throw new TypeError(`blob file holds ${count} entries but the commitment says ${unitCount} bundles`);
  }
  const want = HEADER_BYTES + count * ENTRY_BYTES;
  if (file.length !== want) {
    throw new TypeError(`blob file is ${file.length} bytes; ${count} entries of L=${blobLen} need exactly ${want}`);
  }
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = HEADER_BYTES + i * ENTRY_BYTES;
    entries.push({
      nonce: file.subarray(at, at + NONCE_BYTES),
      sealed: file.subarray(at + NONCE_BYTES, at + ENTRY_BYTES),                    // ciphertext || tag
    });
  }
  return { version, count, blobLen, entries };
}

/**
 * Trial-decrypt every entry with one derived key and return the single one that authenticates.
 *
 * EVERY ENTRY IS ATTEMPTED, ALWAYS, and the loop does not break on success. Returning early would make the
 * running time a function of the bundle's index, and a page that leaks the index by timing has given away
 * the one thing the blob file exists to hide. The cost is real — one AES-GCM open per bundle — and it is
 * microseconds against the ~600ms the key derivation already took.
 *
 * Exactly one entry must authenticate. Two would mean two bundles share a key, which §5.3 refuses at mint.
 */
export async function openBlobFile(fileBytes, { blobKeyHex, publicId, unitCount }) {
  const { count, entries } = parseBlobFile(fileBytes, { unitCount });
  const key = await importKey(blobKeyHex);
  const aad = blobAad(publicId, unitCount ?? count);
  let found = null;
  for (let i = 0; i < entries.length; i++) {
    let plain = null;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: entries[i].nonce, additionalData: aad, tagLength: TAG_BYTES * 8 },
        key, entries[i].sealed));
    } catch {
      plain = null;                                  // the expected outcome for every entry but one
    }
    if (plain) {
      if (found) throw new Error('two blob entries authenticated under one key; the run has duplicate codes');
      found = { index: i, body: unframe(plain) };
    }
  }
  if (!found) throw new Error('no blob entry authenticated under this key: the code does not open this run');
  return found;
}

/** SHA-256 of the complete file — the value §5.1 puts inside headerDigest. */
export async function blobHash(fileBytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', fileBytes)));
}
