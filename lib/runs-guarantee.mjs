// lib/runs-guarantee.mjs — the generator that turns a claim set into the sentence a customer reads.
// See docs/RUNS_PLAN.md §11.2.
//
// THIS SENTENCE IS COMMITTED INSIDE headerDigest. It is anchored into Bitcoin and can never be re-issued
// for a published run, so every word here is a byte in a hash that outlives the decision to write it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE DOES NOT SIMPLY IMPLEMENT §11.2's SKELETON
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// It cannot. §11.2 gives a "fixed skeleton" and two worked examples, and the three disagree:
//
//   THE BLOCKING CONTRADICTION. Both examples carry a byte-identical `language bundle eq JA` claim over a
//   composition with the same three slots. Edition 1 renders "…and one JAPANESE art card"; EX2 renders
//   "…and one art card". A bundle-scoped claim either reaches the art slot or it does not, so NO single
//   grammar produces both sentences. Four independent attempts confirmed it; the one that reproduces
//   Edition 1 exactly cannot reproduce EX2, and vice versa.
//
//   THE SKELETON MATCHES NEITHER. It ends "…where the <chase slot label> is <grader+min_grade token>
//   <language word> and of <rarity_in phrase>", and no published sentence contains that clause or ever
//   emits a chase slot label. Edition 1 has no rarity_in claim at all, so the clause could not render.
//
// EDITION 1 IS THE ONE TO FOLLOW. It is §11.2's own normative rendering example, it is the product being
// built, and it is self-consistent. EX2 is a synthetic three-bundle fixture whose sentence is an INPUT to
// the §5.1 header vector rather than generator output — the vector consumes the string, so following
// Edition 1 does not invalidate it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// THE THREE THINGS §11.2 REFERENCES BUT NEVER SUPPLIES, AND WHAT THIS FILE DOES INSTEAD
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   THE NOUN. Both published sentences say "card" where the composition label says "Graded slab", and
//   "booster packs" where it says "Sealed packs" — nouns derivable from nothing committed. `booster` is
//   the sharper case: no claim in the closed vocabulary can assert product_type, so it is an unproved
//   assertion inside an anchored sentence, which is exactly what §11.2 forbids of labels.
//
//   SO THE NOUN *IS* THE LABEL. It is the only per-slot string inside compositionCanonical, §11.2 already
//   says "slot labels render from compositionCanonical", and it is constrained to [A-Za-z ]{1,32}
//   precisely so it cannot inject one. The practical consequence is that a label is customer-facing copy:
//   write it as the singular noun phrase the sentence should contain — "graded card", not "Graded slab".
//
//   THE LITERALS "graded" AND "sealed" ARE NOT EMITTED. A generator that inserted them would be inventing
//   words for the same reason. They belong in the label, where the owner writes them deliberately.
//
//   "OF AN ILLUSTRATED CHASE RARITY" IS NOT EMITTED EITHER. It appears in EX2 and is derivable from no
//   table — a characterisation of a class set that §11.1 does not define and no claim proves.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// GUARDRAIL 2: COUNTS, NEVER RATIOS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Every number reaching copy comes from the integer-to-word table below or is a grade rendered verbatim
// under the §4.3 grammar. Nothing here divides, and there is no construction that takes two counts and
// relates them — "fifteen of twenty-five" is expressible, "one in five" is not reachable by any path.
// That is a consumer-law and gambling-optics constraint, not a stylistic one, and
// test/invariants/runs-odds-language.test.mjs asserts it over generated output rather than over source.
import { normalizeValue } from './runs-canonical.mjs';
import { rarityDisplay } from './runs-rarity.mjs';
import { languageDisplay } from './runs-language.mjs';
import { CLAIM_TYPES, BUNDLE, canonicalClaims, validateClaims } from './runs-claims.mjs';

// --- the integer table §11.2 references and never gives -------------------------------------------------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * Whole numbers 0–999 as words. The range is the run's own: §4.3 caps bundle numbers at 999 and a larger
 * run needs a new canon version, so nothing this renderer can be handed exceeds it.
 *
 * Hyphenated ("twenty-five", which is the form Edition 1's published sentence uses) and with "and" after
 * a hundred ("one hundred and five"). Both are choices — the document supplies no table — so they are
 * pinned by a test rather than left to whoever next edits this function.
 */
export function inWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999) {
    throw new RangeError(`the guarantee renders whole numbers 0-999 as words; got ${n}`);
  }
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    return n % 10 ? `${t}-${ONES[n % 10]}` : t;
  }
  const h = `${ONES[Math.floor(n / 100)]} hundred`;
  return n % 100 ? `${h} and ${inWords(n % 100)}` : h;
}

// --- assembling one slot's noun phrase -------------------------------------------------------------------

// Labels are customer-facing copy and are constrained so they cannot smuggle in punctuation, a number or
// a claim-shaped assertion. §11.2 sets the character class; the length keeps a sentence readable.
const LABEL_RE = /^[A-Za-z ]{1,32}$/;

// Naive plural, and deliberately so: an irregulars table would be a second vocabulary to keep, and the
// label is written by the owner who can simply choose a word that pluralises. "sealed booster pack" ->
// "sealed booster packs". A label whose plural is irregular is a copy problem, fixed by rewording it.
const plural = (s) => `${s}s`;

const claimFor = (claims, type, subject) =>
  claims.find((c) => c.claim_type === type && c.subject === subject) || null;

// The language claim in scope for a slot: one aimed at the slot itself, or a bundle-scoped one, which
// reaches EVERY slot. That is the reading Edition 1's sentence takes and EX2's does not.
const languageFor = (claims, slot) =>
  claimFor(claims, 'language', slot)
  || claimFor(claims, 'packs_language', slot)
  || claimFor(claims, 'language', BUNDLE);

/**
 * One slot, one noun phrase:
 *
 *     <count word> [<grader> ][<grade> ][<language word> ]<label>[ of <rarity list>]
 *
 * Every token is either a committed value or a table lookup over one. Nothing is invented.
 */
function nounPhrase(spec, claims, count) {
  const label = normalizeValue(String(spec.label || ''));
  if (!LABEL_RE.test(label)) {
    throw new Error(`slot "${spec.slot}" has the label ${JSON.stringify(label)}, which is not [A-Za-z ]{1,32} — `
      + 'a label is the noun in an anchored sentence, so it cannot carry punctuation, digits or an assertion');
  }

  const parts = [inWords(count)];

  const grader = claimFor(claims, 'grader', spec.slot);
  const minGrade = claimFor(claims, 'min_grade', spec.slot);
  if (grader) parts.push(String(grader.value));
  // The one place a numeral legitimately reaches copy. §11.2 says integers render as words, and both of
  // its own sentences then write "PSA 10" — because a grade is not a count, it is a §4.3 decimal whose
  // exact form is committed, and "nine point five" would be a different string from the one hashed.
  if (minGrade) parts.push(String(minGrade.value));

  const lang = languageFor(claims, spec.slot);
  if (lang) {
    const word = languageDisplay(String(lang.value));
    if (!word) {
      throw new Error(`no display word for the language "${lang.value}" — a run claiming it cannot lock, `
        + 'because the sentence it would commit has a hole in it');
    }
    parts.push(word);
  }

  parts.push(count === 1 ? label : plural(label));

  const rarity = claimFor(claims, 'rarity_in', spec.slot);
  if (rarity) {
    // Classes in canonical byte order, rendered through the committed display column. No characterisation
    // of the set as a whole: "of an illustrated chase rarity" is a claim nothing proves.
    const words = String(rarity.value).split(',').sort().map((c) => {
      const d = rarityDisplay(c);
      if (!d) throw new Error(`the rarity table has no display name for ${c} — a run claiming it cannot lock`);
      return d;
    });
    parts.push(`of ${joinWords(words, ' or ')}`);
  }

  return parts.join(' ');
}

// ", " between members and a conjunction before the last, with no Oxford comma — the form both published
// sentences use. A single member is itself; two are joined by the conjunction alone.
function joinWords(items, conjunction = ' and ') {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + conjunction + items[items.length - 1];
}

// --- the generator ---------------------------------------------------------------------------------------

/**
 * Generate the guarantee for a run.
 *
 *   specs      the composition, in ascending sort_order
 *   claims     the claim set — validated first, because a sentence generated from an invalid claim would
 *              be a promise nothing can check
 *   unitCount  how many bundles the run has; only ever rendered as a standalone word
 *
 * Returns the sentence. Throws rather than degrading: a guarantee that silently drops a clause is a
 * guarantee that promises less than the manifest was checked against, and it is about to be anchored.
 */
export function generateGuarantee({ specs = [], claims = [], unitCount = 0 } = {}) {
  const v = validateClaims(claims, specs);
  if (!v.ok) throw new Error(`cannot generate a guarantee from claims that do not validate: ${v.errors.join('; ')}`);

  const ordered = [...specs].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  if (!ordered.length) throw new Error('a run with no composition has nothing to guarantee');

  // slot_count is what states the per-bundle quantity. Falling back to the composition's own
  // qty_per_bundle would let the sentence assert a number no claim covers.
  const counts = claimFor(claims, 'slot_count', BUNDLE);
  if (!counts) throw new Error('a guarantee needs a slot_count claim — it is what supplies the quantity in every clause');
  const byslot = Object.fromEntries(String(counts.value).split(',').map((m) => {
    const at = m.indexOf(':');
    return [m.slice(0, at), Number(m.slice(at + 1))];
  }));

  // SENTENCE ONE: the per-bundle universal, one clause per slot in composition order.
  //
  // Composition order, NOT claimsCanonical order. §11.2 says fragments render in claimsCanonical order,
  // and Edition 1's own sentence then renders slab, packs, art — which is sort_order, while the claim
  // value is byte-sorted art, packs, slab. Composition order is the one that reads as the bundle is
  // physically laid out, and it is what the published sentence does.
  const clauses = ordered.map((spec) => nounPhrase(spec, claims, byslot[spec.slot] ?? 0));
  const sentences = [`Every bundle contains ${joinWords(clauses)}.`];

  // THEN ONE SENTENCE PER AGGREGATE, in claimsCanonical order. Mixing a run-level count into "every
  // bundle contains…" would be false on its face, which is why field_mix gets its own sentence.
  for (const claim of canonicalClaims(claims)) {
    if (CLAIM_TYPES[claim.claim_type]?.scope !== 'run') continue;
    sentences.push(aggregateSentence(claim, ordered, unitCount));
  }
  return sentences.join(' ');
}

function aggregateSentence(claim, ordered, unitCount) {
  const spec = ordered.find((s) => s.slot === claim.subject);
  if (!spec) throw new Error(`the ${claim.claim_type} claim names slot "${claim.subject}", which the composition does not declare`);
  const label = normalizeValue(String(spec.label || ''));

  const raw = String(claim.value);
  const at = raw.indexOf('=');
  const field = raw.slice(0, at);
  const members = raw.slice(at + 1).split(',').sort().map((m) => {
    const c = m.lastIndexOf(':');
    return { value: m.slice(0, c), count: Number(m.slice(c + 1)) };
  });

  const display = (value) => {
    if (field !== 'rarity') return value;
    const d = rarityDisplay(value);
    if (!d) throw new Error(`the rarity table has no display name for ${value} — a run claiming it cannot lock`);
    return d;
  };

  // The first member carries the noun; the rest are bare counts, which is how Edition 1's sentence reads
  // ("fifteen art cards are Art Rare and ten are Special Art Rare") and how English works.
  const phrases = members.map((m, i) => (i === 0
    ? `${inWords(m.count)} ${m.count === 1 ? label : plural(label)} are ${display(m.value)}`
    : `${inWords(m.count)} are ${display(m.value)}`));

  return `Across the ${inWords(unitCount)} bundles, ${joinWords(phrases)}.`;
}
