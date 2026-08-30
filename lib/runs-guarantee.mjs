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
import { normalizeValue, byteCompare } from './runs-canonical.mjs';
import { rarityDisplay } from './runs-rarity.mjs';
import { languageDisplay } from './runs-language.mjs';
import { CLAIM_TYPES, BUNDLE, canonicalClaims, validateClaims } from './runs-claims.mjs';

// --- the integer table §11.2 references and never gives -------------------------------------------------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * Whole numbers as words, 0 to 999,999.
 *
 * THE RANGE IS NOT THE RUN SIZE, and getting that wrong makes a legal run unlockable for a rendering
 * reason. The binding number is a field_mix count, which counts populated LINES across every bundle:
 * at the §3/§4.3 ceilings that is unit_count x max_lines = 999 x 99 = 98,901. A table that stopped at the
 * 999-bundle limit would throw on a run nothing else objects to.
 *
 * Hyphenated compounds ("twenty-five", the form the published sentence uses) and "and" after the
 * hundreds ("one hundred and one"). Both are AU/UK forms, both are choices the document never makes,
 * and both are anchored once written — so they are pinned by a table-driven test rather than a comment.
 * The `and` fork is the likeliest place two implementers would diverge.
 */
export function inWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999999) {
    throw new RangeError(`the guarantee renders whole numbers 0-999999 as words; got ${n}`);
  }
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    return n % 10 ? `${t}-${ONES[n % 10]}` : t;
  }
  if (n < 1000) {
    const h = `${ONES[Math.floor(n / 100)]} hundred`;
    return n % 100 ? `${h} and ${inWords(n % 100)}` : h;
  }
  const th = `${inWords(Math.floor(n / 1000))} thousand`;
  const r = n % 1000;
  if (!r) return th;
  // "and" only below a hundred: two thousand AND ninety-seven, but two thousand nine hundred.
  return r < 100 ? `${th} and ${inWords(r)}` : `${th} ${inWords(r)}`;
}
// --- assembling one slot's noun phrase -------------------------------------------------------------------

// Labels are customer-facing copy and are constrained so they cannot smuggle in punctuation, a number or
// a claim-shaped assertion. §11.2 sets the character class; these add three rules it does not:
//
//   NO LEADING OR TRAILING SPACE, which would double a separator in the assembled sentence.
//   NO TRAILING 's', because the plural rule appends one and "packs" would render "packss".
//   NO RATIO WORD, which closes an attack a template-only scan cannot see: the renderer emits the label
//   verbatim, so a label reading "one in five bonus card" would put a ratio into an anchored sentence
//   through the one field the owner controls. Guardrail 2 is a consumer-law rule, not a style note.
const LABEL_RE = /^[A-Za-z]([A-Za-z ]{0,30}[A-Za-z])?$/;
const LABEL_BANNED = /\b(in|of|per|odds|chance|probability|ratio|percent)\b/i;

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

// The one place a label is read, so every rule above is applied exactly once.
function labelOf(spec) {
  const label = normalizeValue(String(spec.label || ''));
  if (!LABEL_RE.test(label)) {
    throw new Error(`slot "${spec.slot}" has the label ${JSON.stringify(label)} — a label is the noun in an `
      + 'anchored sentence, so it must be 1-32 letters and spaces with no leading or trailing space, and no '
      + 'punctuation, digits or assertion');
  }
  if (label.endsWith('s')) {
    throw new Error(`slot "${spec.slot}" has the label ${JSON.stringify(label)}, which already reads as a plural — `
      + 'write it singular ("sealed pack"), because the sentence appends the s and would otherwise say "packss"');
  }
  if (LABEL_BANNED.test(label)) {
    throw new Error(`slot "${spec.slot}" has the label ${JSON.stringify(label)}, which reads as a ratio or a `
      + 'qualifier; the label is emitted verbatim into an anchored sentence, and guardrail 2 forbids that copy');
  }
  return label;
}

/**
 * One slot, one noun phrase:
 *
 *     <count word> [<grader> ][<grade> ][<language word> ]<label>[ of <rarity list>]
 *
 * Every token is either a committed value or a table lookup over one. Nothing is invented.
 */
function nounPhrase(spec, claims, count) {
  const label = labelOf(spec);

  const parts = [inWords(count)];

  const grader = claimFor(claims, 'grader', spec.slot);
  const minGrade = claimFor(claims, 'min_grade', spec.slot);
  // A grade with no grader renders "one 10 graded card", which is not English and would be anchored
  // that way. The pair is emitted together or not at all.
  if (minGrade && !grader) {
    throw new Error(`slot "${spec.slot}" claims a minimum grade with no grader claim — "one 10 graded card" `
      + 'is not a sentence, so the pair must be made together');
  }
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
    // byteCompare, not Array.sort(). Bare sort orders by UTF-16 code unit, which is identical for ASCII
    // class names today and silently different the first time one is not — and lib/runs-claims.mjs
    // already sorts the same set with byteCompare, so a bare sort here means the two files disagree
    // about the order of a list that is committed in one and rendered in the other.
    const words = String(rarity.value).split(',').sort(byteCompare).map((c) => {
      const d = rarityDisplay(c);
      if (!d) throw new Error(`the rarity table has no display name for ${c} — a run claiming it cannot lock`);
      return d;
    });
    // PARENTHESISED, and not for decoration. Unbracketed, the list runs into the clause after it: "…card
    // of Art Rare, Mega Attack Rare or Special Art Rare, three sealed packs and one art card" reads as one
    // four-item list and cannot be parsed by a customer. Brackets are also what the one published sentence
    // carrying a rarity tail uses.
    parts.push(`of (${joinWords(words, ' or ')})`);
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
  // The claim and the composition must agree. They are hashed separately — claimsCanonical and
  // compositionCanonical are different fields of headerDigest — so a run could otherwise commit a
  // composition of three packs while promising two, with both anchored and neither wrong on its own.
  for (const spec of ordered) {
    const want = spec.qty_per_bundle;
    if (want != null && byslot[spec.slot] !== Number(want)) {
      throw new Error(`the slot_count claim says ${byslot[spec.slot]} of "${spec.slot}" while the composition `
        + `declares ${want}; the sentence would promise something the manifest was not built to`);
    }
  }
  const clauses = ordered.map((spec) => {
    // Defensive: validateClaims already requires slot_count to cover every declared slot. If that ever
    // stops being true, throwing is right and rendering "zero graded card" into an anchored sentence
    // is not.
    const n = byslot[spec.slot];
    if (n == null) throw new Error(`the slot_count claim does not mention "${spec.slot}", so its clause has no quantity`);
    return nounPhrase(spec, claims, n);
  });
  const sentences = [`Every bundle contains ${joinWords(clauses)}.`];

  // THEN ONE SENTENCE PER AGGREGATE, in claimsCanonical order. Mixing a run-level count into "every
  // bundle contains…" would be false on its face, which is why field_mix gets its own sentence.
  for (const claim of canonicalClaims(claims)) {
    if (CLAIM_TYPES[claim.claim_type]?.scope !== 'run') continue;
    sentences.push(aggregateSentence(claim, ordered, unitCount));
  }
  return gate(sentences.join(' '));
}

function aggregateSentence(claim, ordered, unitCount) {
  const spec = ordered.find((s) => s.slot === claim.subject);
  if (!spec) throw new Error(`the ${claim.claim_type} claim names slot "${claim.subject}", which the composition does not declare`);
  const label = labelOf(spec);

  const raw = String(claim.value);
  const at = raw.indexOf('=');
  const field = raw.slice(0, at);
  const members = raw.slice(at + 1).split(',').sort(byteCompare).map((m) => {
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

  const bundles = unitCount === 1 ? 'bundle' : 'bundles';
  return `Across the ${inWords(unitCount)} ${bundles}, ${joinWords(phrases)}.`;
}

// THE LAST THING BEFORE IT IS ANCHORED.
//
// Guardrail 2 is checked here as a LOCK GATE rather than only in a test, because an anchored sentence
// gets one chance and a test only runs on the shapes someone thought of. The character class is the
// sharper half: '%' and '/' are unrepresentable by construction, so if one appears, a committed value
// reached copy through a path this file does not know about.
const SENTENCE_RE = /^[A-Za-z0-9 ,.()-]+$/;
const RATIO_RE = /\b(odds|chance|probability|percent|per cent|one in \w+)\b|\d+\s*(%|\/)\s*\d*/i;

function gate(sentence) {
  const out = normalizeValue(sentence);
  if (!SENTENCE_RE.test(out)) {
    throw new Error(`the generated guarantee contains a character the grammar cannot produce, so a committed `
      + `value reached copy unchecked: ${JSON.stringify(out)}`);
  }
  const hit = RATIO_RE.exec(out);
  if (hit) {
    throw new Error(`the generated guarantee reads as a ratio (${JSON.stringify(hit[0])}), which guardrail 2 `
      + `forbids in customer copy: ${JSON.stringify(out)}`);
  }
  return out;
}
