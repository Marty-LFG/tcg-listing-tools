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
// SCOPE NOTE (historical). Attributes, line assignment, padding and the grammars were R2-1 and now sit
// at the bottom of this file. The two primitives came first because the rarity table commits to
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

// §4.4: every line contributes the SAME fifteen fields, always all fifteen, empty where inapplicable.
// The ORDER is load-bearing — lines sort by the byte-wise comparison of their fields concatenated in
// exactly this sequence — so this array is a published constant, not a convenience.
export const FIELDS = Object.freeze([
  'kind', 'display_name', 'game', 'identity_key', 'set_code', 'card_number', 'rarity',
  'language', 'finish', 'product_type', 'upc', 'grading_company', 'grade', 'cert_number', 'qty',
]);

/**
 * §4.4, normatively: a line is POPULATED iff its `qty` is non-empty. A populated line must also carry a
 * non-empty `kind`; a PADDED line must have all fifteen fields empty. Anything else is invalid.
 *
 * Returned as a verdict rather than a boolean because "invalid" is a third answer and collapsing it into
 * "padded" is how a malformed line would slip through a verifier as merely absent.
 */
export function classifyLine(line = {}) {
  const v = (f) => normalizeValue(line[f] == null ? '' : String(line[f]));
  const empty = FIELDS.filter((f) => v(f) === '');
  if (empty.length === FIELDS.length) return { state: 'padded' };
  if (v('qty') === '') {
    return { state: 'invalid', why: 'a line with any field set must have a qty — that is what makes it populated' };
  }
  if (v('kind') === '') return { state: 'invalid', why: 'a populated line must name its kind' };
  return { state: 'populated' };
}

/** Convenience for the common case. An INVALID line is not populated — callers must check separately. */
export const isPopulated = (line) => classifyLine(line).state === 'populated';

/** Byte-wise ordering over UTF-8, which is what §4.2 specifies — never localeCompare. */
export function byteCompare(a, b) {
  const x = utf8.encode(a), y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

// --- §4.3 grammars ---------------------------------------------------------------------------------
//
// A GRAMMAR, NOT A CAST. Every one of these exists because two producers formatting the same value
// differently would anchor different digests for identical contents. `10.0` and `10` are the same
// grade and a different hash.

const GRADE_RE = /^(0|[1-9][0-9]?)(\.[0-9]*[1-9])?$/;
const POSINT_RE = /^[1-9][0-9]*$/;

/** §4.3 grade: no trailing fractional zeros, no leading zeros, 0-10. Returns the canonical string. */
export function gradeToken(v) {
  const s = normalizeValue(v == null ? '' : String(v));
  if (s === '') return '';
  if (!GRADE_RE.test(s) || Number(s) > 10) {
    throw new TypeError(`"${s}" is not a §4.3 grade: decimal, 0-10, no leading zeros and no trailing `
      + 'fractional zeros (10, 9.5 — never 10.0 or 09)');
  }
  return s;
}

/** §4.3 positive integer: no leading zeros, no sign. Empty stays empty, for a padded line. */
export function intToken(v) {
  const s = normalizeValue(v == null ? '' : String(v));
  if (s === '') return '';
  if (!POSINT_RE.test(s)) throw new TypeError(`"${s}" is not a positive integer with no leading zeros`);
  return s;
}

/** §4.3 bundle number: zero-padded to exactly three digits, 1-999. */
export function bundleNoToken(n) {
  // NOT Math.round. A fractional bundle number is a caller bug, and rounding it would silently commit a
  // DIFFERENT bundle than the one the row names.
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 999) {
    throw new RangeError(`bundle numbers are 1-999; got ${n}. Above 999 requires a new canon version`);
  }
  return String(v).padStart(3, '0');
}

// --- §4.4 line assignment and §4.5 padding ------------------------------------------------------

/** One line's fifteen fields, normalised and put through their grammars, in §4.4's field order. */
export function normalizeLine(line = {}) {
  const out = {};
  for (const f of FIELDS) out[f] = normalizeValue(line[f] == null ? '' : String(line[f]));
  // Only these two have a grammar. Applied AFTER classification, per §4.3: a padded line emits every
  // field empty, including the numeric ones, and an empty qty cannot satisfy "positive integer".
  if (out.qty !== '') out.qty = intToken(out.qty);
  if (out.grade !== '') out.grade = gradeToken(out.grade);
  return out;
}

/** The byte-wise sort key §4.4 specifies: ns(field1) through ns(field15), concatenated. */
export const lineSortKey = (line) => FIELDS.map((f) => ns(line[f])).join('');

const EMPTY_LINE = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f, ''])));

/**
 * Assign a slot's lines to indices 00..max_lines-1.
 *
 * §4.4: one line per distinct stock row, `qty` being the units drawn from it — so three packs from a
 * single product are ONE line with qty 3, never three lines. Populated lines sort by the byte-wise
 * comparison of their encoded fields and ALWAYS precede padding.
 *
 * §4.5: every bundle emits attributes for ALL max_lines of every slot, unused ones with all fifteen
 * fields empty. There is deliberately no attribute recording how many are populated — a count would be a
 * single value encoding the very structure the padding exists to hide. Without it, bundles that
 * legitimately differ in structure would have different attribute counts, differently-shaped trees and
 * therefore different PROOF LENGTHS, and proof length is published whenever an attribute is opened.
 */
export function assignLines(lines = [], maxLines) {
  const norm = lines.map(normalizeLine);
  for (const l of norm) {
    const c = classifyLine(l);
    if (c.state === 'invalid') throw new TypeError(`a line of this slot is invalid: ${c.why}`);
  }
  const populated = norm.filter((l) => classifyLine(l).state === 'populated');
  if (populated.length > maxLines) {
    throw new RangeError(`this slot has ${populated.length} populated line(s) but max_lines is ${maxLines}; `
      + 'max_lines is fixed at run creation because it is inside the hash');
  }
  populated.sort((a, b) => byteCompare(lineSortKey(a), lineSortKey(b)));
  const out = populated.slice();
  while (out.length < maxLines) out.push({ ...EMPTY_LINE });
  return out;
}

/**
 * A bundle's complete attribute set, ready for lib/runs-merkle.mjs.
 *
 * `bundle.seal_serial` is emitted only when the bundle HAS one. That is what the specification's own two
 * fixtures do — EX1 publishes twenty attributes with no serial, EX2 publishes eighty-one with one — even
 * though §4.4's name set lists it unconditionally. Both published vectors reproduce this way and neither
 * reproduces the other way, so the fixtures are the authority here and the prose is loose.
 */
export function bundleAttributes({ run, bundle, specs = [], lines = {} } = {}) {
  const attrs = [
    { name: 'run.public_id', value: normalizeValue(String(run.public_id)) },
    { name: 'run.edition', value: intToken(run.edition) },
    { name: 'bundle.no', value: bundleNoToken(bundle.bundle_no ?? bundle.no) },
    { name: 'bundle.label', value: normalizeValue(String(bundle.label)) },
    { name: 'bundle.is_chase', value: bundle.is_chase ? '1' : '0' },
  ];
  const serial = normalizeValue(bundle.seal_serial == null ? '' : String(bundle.seal_serial));
  if (serial) attrs.push({ name: 'bundle.seal_serial', value: serial });

  for (const spec of [...specs].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
    const assigned = assignLines(lines[spec.slot] || [], spec.max_lines);
    assigned.forEach((line, i) => {
      const ii = String(i).padStart(2, '0');
      // Zero-padded to two digits so slot.packs.02 sorts before slot.packs.10, which is why max_lines
      // cannot exceed 99.
      for (const f of FIELDS) attrs.push({ name: `slot.${spec.slot}.${ii}.${f}`, value: line[f] });
    });
  }

  const names = attrs.map((a) => a.name);
  if (new Set(names).size !== names.length) {
    throw new Error('a bundle emitted the same attribute name twice; sort stability would change the root');
  }
  return attrs.sort((a, b) => byteCompare(a.name, b.name));
}

/**
 * The exact attribute NAME set a bundle of this composition must have.
 *
 * §4.5: because the composition is committed in the header, a verifier derives this and rejects any
 * bundle with a missing, extra or duplicated attribute. That check is what the padding silently depended
 * on — without it, a producer could simply omit a line and shorten the tree.
 */
export function expectedAttributeNames({ specs = [], withSealSerial = true } = {}) {
  const names = ['run.public_id', 'run.edition', 'bundle.no', 'bundle.label', 'bundle.is_chase'];
  if (withSealSerial) names.push('bundle.seal_serial');
  for (const spec of specs) {
    for (let i = 0; i < spec.max_lines; i++) {
      const ii = String(i).padStart(2, '0');
      for (const f of FIELDS) names.push(`slot.${spec.slot}.${ii}.${f}`);
    }
  }
  return names.sort(byteCompare);
}
