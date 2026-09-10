// lib/runs-rarity.mjs — the committed rarity vocabulary. See docs/RUNS_PLAN.md §11.1.
//
// A run's guarantee can say "every slab is a Japanese Art Rare". Proving that at close means comparing
// a stored rarity against a claim, and the naive comparison — string equality against the source data
// — is wrong in three separate ways that all fail SILENTLY:
//
//   CROSS-LANGUAGE ALIASES. The same physical Japanese card arrives as "Art Rare" from one source and
//   "Illustration Rare" from another, depending which catalogue resolved it. One card, two strings, and
//   a claim written against either one is false for half the stock.
//
//   AN ABBREVIATION COLLISION. lib/listing-copy.mjs's PKM_RAB maps BOTH "art rare" and the unrelated
//   "amazing rare" to `AR`, because that map exists to write listing titles and the collision is
//   harmless there. Deriving a claim from an abbreviation would let an Amazing Rare satisfy an Art Rare
//   guarantee. Classes therefore derive from the FULL SOURCE STRING and never from an abbreviation, and
//   this table is deliberately its own thing rather than a re-use of that one.
//
//   UNMAPPED VALUES. Live stock already holds a `MEGA_ATTACK_RARE` row that PKM_RAB maps to nothing at
//   all. Here an unmapped source string has no class, satisfies no claim, and FAILS THE LOCK CLOSED —
//   the run is refused and the offending value named, rather than a bundle quietly counting as
//   conforming because a lookup returned undefined.
//
// The table is published with the run's commitment and its hash is inside headerDigest, so a buyer can
// see the exact mapping before anything sells. That is also this design's honest limit: we could map a
// junk source string to a valuable class, an automated verifier would accept it, and only a human
// reading the published table would notice. The table being public and committed before the first sale
// is the control — scrutiny, not cryptography. §8.19.
import { ns, normalizeValue, sha256Prefixed, byteCompare } from './runs-canonical.mjs';

// The label that appears in headerDigest beside the hash. A version pins nothing a verifier can check,
// which is why the hash travels with it — but the label is what a human quotes.
export const RARITY_TABLE_VERSION = 'rarity-v1';

// source string (already case-folded, see rarityClass) -> class.
//
// ORDER IS IRRELEVANT HERE and load-bearing in the canonical form, which sorts byte-wise. Written in
// the specification's order anyway so the two read the same.
export const RARITY_SOURCES = Object.freeze({
  'amazing rare': 'AMAZING_RARE',
  'art rare': 'ART_RARE',
  'illustration rare': 'ART_RARE',
  'mega attack rare': 'MEGA_ATTACK_RARE',
  'mega_attack_rare': 'MEGA_ATTACK_RARE',
  'special art rare': 'SPECIAL_ART_RARE',
  'special illustration rare': 'SPECIAL_ART_RARE',
});

// class -> display name. A separate column because the guarantee renderer needs a noun phrase and
// SPECIAL_ART_RARE is not one; an earlier revision had no such column, which is one of the reasons its
// generated-copy check could not be implemented.
export const RARITY_CLASSES = Object.freeze({
  AMAZING_RARE: 'Amazing Rare',
  ART_RARE: 'Art Rare',
  MEGA_ATTACK_RARE: 'Mega Attack Rare',
  SPECIAL_ART_RARE: 'Special Art Rare',
});

// ASCII case folding ONLY, after §4.2 normalisation. Not toLowerCase(), which is locale-sensitive in
// ways that bite exactly once: in a Turkish locale 'I' lowercases to a dotless ı, so "ILLUSTRATION
// RARE" would stop matching and a lock would fail on a machine rather than on a card.
function foldAscii(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c >= 0x41 && c <= 0x5a) ? String.fromCharCode(c + 32) : ch;
  }
  return out;
}

/**
 * The committed class for a source rarity string, or null when the table does not map it.
 *
 * NULL IS A REFUSAL, NOT A DEFAULT. Every caller must treat it as "this card cannot appear in a run
 * making a rarity claim" — never as "no rarity", which would let an unmapped value satisfy a claim by
 * being absent from the comparison.
 */
export function rarityClass(source) {
  const key = foldAscii(normalizeValue(source == null ? '' : String(source)));
  return Object.prototype.hasOwnProperty.call(RARITY_SOURCES, key) ? RARITY_SOURCES[key] : null;
}

/** The display noun for a class, or null. Used by the guarantee renderer, never by an evaluator. */
export const rarityDisplay = (cls) =>
  (cls && Object.prototype.hasOwnProperty.call(RARITY_CLASSES, cls) ? RARITY_CLASSES[cls] : null);

/**
 * §11.1's canonical serialisation of the whole table. Both halves are sorted byte-wise, and both carry
 * their count, so a verifier rebuilding this from the published JSON gets the same bytes or knows it
 * has a different table.
 */
export function rarityTableCanonical(sources = RARITY_SOURCES, classes = RARITY_CLASSES) {
  const src = Object.keys(sources).sort(byteCompare);
  const cls = Object.keys(classes).sort(byteCompare);
  let out = ns('SOURCES') + ns(String(src.length));
  for (const s of src) out += ns(s) + ns(sources[s]);
  out += ns('CLASSES') + ns(String(cls.length));
  for (const c of cls) out += ns(c) + ns(classes[c]);
  return out;
}

/** SHA-256 with the 0x06 domain prefix — the value that travels inside headerDigest. */
export const rarityTableHash = (sources, classes) =>
  sha256Prefixed(0x06, rarityTableCanonical(sources, classes));

/** The published shape: what goes in the commitment JSON and what /api/runs/rarity serves. */
export async function rarityTable() {
  return {
    version: RARITY_TABLE_VERSION,
    hash: await rarityTableHash(),
    sources: { ...RARITY_SOURCES },
    classes: { ...RARITY_CLASSES },
  };
}
