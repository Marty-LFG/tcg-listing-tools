// lib/runs-claims.mjs — the closed claim vocabulary, its evaluators, and its canonical form.
// See docs/RUNS_PLAN.md §11.2.
//
// THE STRUCTURED CLAIMS ARE THE SECURITY BOUNDARY. THE ENGLISH SENTENCE IS A RENDERING OF THEM.
//
// That split is the whole design, and it is the fix for a defect that survived three revisions. An
// earlier draft required a verifier to REGENERATE the guarantee sentence and compare it byte for byte.
// Both external reviewers showed that could not be implemented — the renderer was prose rather than a
// grammar — and a mandatory check no two implementers can agree on is worse than no check at all. So:
//
//   THE PRODUCER generates the sentence FROM the claims, which is what stops copy asserting more than
//   the manifest supports. Compliance is enforced here, at lock, before anything is published.
//   THE SENTENCE IS COMMITTED inside headerDigest, so the words a customer reads cannot be swapped
//   afterwards.
//   THE VERIFIER EVALUATES THE CLAIMS, not the English. A false guarantee is caught by a claim failing
//   over opened values, which is a decidable test.
//
// THE VOCABULARY IS CLOSED, AND SILENCE FAILS CLOSED. An unknown claim_type, operator or subject is
// REFUSED, never ignored. That direction is the entire point: a claims engine that skips what it does
// not recognise reads an unrecognised claim as "no claim" and locks clean, which is precisely how a
// guarantee comes to promise something nothing checked.
//
// AND THE EVALUATORS MUST ACTUALLY RUN. Revision 5 was driven by a verifier that never evaluated its own
// claims: a committed grade of 9 passed a `min_grade gte 10` guarantee, because nothing compared them.
// Every evaluator here is exercised in BOTH directions by test/unit/runs-claims.test.mjs.
import { ns, normalizeValue, byteCompare, FIELDS, classifyLine } from './runs-canonical.mjs';
import { rarityClass, rarityDisplay } from './runs-rarity.mjs';
import { languageDisplay } from './runs-language.mjs';

// --- the closed vocabulary ---------------------------------------------------------------------------

// `bundle` is a reserved subject meaning "every line of every slot". Slot names are otherwise the only
// legal subjects, and they are checked against the run's own composition — a claim about a slot the run
// does not declare is refused rather than passing vacuously over an empty set.
export const BUNDLE = 'bundle';

// claim_type -> its ONE legal operator, which subjects it accepts, and whether it is a per-bundle
// universal or a run-level aggregate.
//
// One operator per type is deliberate. There is no `gt`, no `lte`, and above all no "or better": rarity
// ordering is contested, and a comparison no two parties evaluate identically is worse than no claim.
// A rarity rule therefore always enumerates its classes explicitly.
export const CLAIM_TYPES = Object.freeze({
  grader: { operator: 'eq', subject: 'slot', scope: 'bundle' },
  min_grade: { operator: 'gte', subject: 'slot', scope: 'bundle' },
  language: { operator: 'eq', subject: 'slot-or-bundle', scope: 'bundle' },
  rarity_in: { operator: 'in', subject: 'slot', scope: 'bundle' },
  packs_language: { operator: 'eq', subject: 'slot', scope: 'bundle' },
  slot_count: { operator: 'eq', subject: 'bundle', scope: 'bundle' },
  field_mix: { operator: 'eq', subject: 'slot', scope: 'run' },
});

// §4.3: decimal, digits and at most one '.', no sign, no exponent, no leading zeros except a bare 0, at
// least one digit either side of any '.', NO TRAILING FRACTIONAL ZEROS, range 0..10.
//
// The trailing-zero rule is why this is a grammar and not parseFloat. '10.0' is INVALID even though it
// is numerically ten: two producers that disagree about whether to write it produce two different hashes
// for the same grade, and the hash is anchored.
const GRADE_RE = /^(0|[1-9][0-9]?)(\.[0-9]*[1-9])?$/;
export function parseGrade(raw) {
  const s = normalizeValue(raw == null ? '' : String(raw));
  if (!GRADE_RE.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 10 ? n : null;
}

// §4.3: positive integer, no leading zeros, no sign.
const COUNT_RE = /^[1-9][0-9]*$/;
const parseCount = (raw) => (COUNT_RE.test(String(raw ?? '')) ? Number(raw) : null);

const SLOT_RE = /^[a-z0-9_]{1,32}$/;
const CLASS_RE = /^[A-Z][A-Z0-9_]*$/;
// Language codes reach the hash and the sentence, so they are constrained rather than free text.
const LANG_RE = /^[A-Z]{2,8}$/;
const GRADER_RE = /^[A-Z0-9]{2,8}$/;

// field_mix packs a FIELD NAME and a VALUE:count list into one `value`, because the claim tuple has no
// fourth slot to put the field in. The separator has to be a character that cannot appear in a field
// name, a rarity class, a set code or a count — ',' and ':' are both already taken by the list itself, so
// '=' it is, and any member containing one of the three is REFUSED rather than silently mis-parsed.
//
// NOT PINNED BY A PUBLISHED VECTOR. §5.1's test vector covers rarity_in and slot_count; no field_mix
// vector exists. This encoding is therefore a decision of ours, and it enters headerDigest — so it is
// stated here rather than left implicit, and changing it later invalidates any run already anchored.
const MIX_SEP = '=';
const RESERVED_IN_MEMBER = /[,:=]/;

// --- validation --------------------------------------------------------------------------------------

const err = (message, extra = {}) => ({ ok: false, error: message, ...extra });

/**
 * Refuse anything outside the vocabulary. `specs` is the run's composition (run_slot_specs rows); a claim
 * naming a slot the run does not declare is refused, because a universal over an empty set is trivially
 * true and would let a guarantee assert something about a slot that does not exist.
 */
export function validateClaim(claim, specs = []) {
  if (!claim || typeof claim !== 'object') return err('a claim must be an object');
  const { claim_type: type, subject, operator, value } = claim;

  const def = Object.prototype.hasOwnProperty.call(CLAIM_TYPES, type) ? CLAIM_TYPES[type] : null;
  if (!def) return err(`unknown claim_type "${type}" — the vocabulary is closed, and an unrecognised claim must fail rather than be skipped`, { known: Object.keys(CLAIM_TYPES) });
  if (operator !== def.operator) return err(`claim ${type} takes the operator "${def.operator}", not "${operator}"`);

  const slots = specs.map((s) => s.slot);
  const isSlot = typeof subject === 'string' && SLOT_RE.test(subject) && slots.includes(subject);
  if (def.subject === 'bundle' && subject !== BUNDLE) return err(`claim ${type} applies to the whole bundle, so its subject must be "${BUNDLE}"`);
  if (def.subject === 'slot' && !isSlot) {
    return err(`claim ${type} needs a slot this run declares as its subject; "${subject}" is not one of ${slots.join(', ') || '(none)'}`);
  }
  if (def.subject === 'slot-or-bundle' && subject !== BUNDLE && !isSlot) {
    return err(`claim ${type} takes "${BUNDLE}" or a declared slot; "${subject}" is neither`);
  }

  const v = normalizeValue(value == null ? '' : String(value));
  if (!v) return err(`claim ${type} has no value`);

  switch (type) {
    case 'grader':
      if (!GRADER_RE.test(v)) return err(`grader must be a grading company code such as PSA; got "${v}"`);
      return { ok: true, parsed: { company: v } };

    case 'min_grade': {
      const g = parseGrade(v);
      if (g == null) return err(`min_grade must satisfy the §4.3 grade grammar (10, 9.5 — never 10.0 or 09); got "${v}"`);
      return { ok: true, parsed: { grade: g } };
    }

    case 'language':
    case 'packs_language':
      if (!LANG_RE.test(v)) return err(`${type} must be a language code such as JA or EN; got "${v}"`);
      // A code with no display word cannot be rendered, and the guarantee is generated BEFORE it is
      // hashed — so a run claiming one would commit a sentence with a hole in it. Refused here for
      // the same reason §11.2 refuses a rarity class with no display name: at validation, where the
      // message can name the code, rather than at render time inside the lock transaction.
      if (!languageDisplay(v)) return err(`the language table has no display word for "${v}" — a run claiming it cannot lock`);
      return { ok: true, parsed: { language: v } };

    case 'rarity_in': {
      const classes = v.split(',');
      if (classes.some((c) => !CLASS_RE.test(c))) return err(`rarity_in takes rarity CLASS names, not source strings; got "${v}"`);
      if (new Set(classes).size !== classes.length) return err(`rarity_in lists a class twice: "${v}"`);
      const undisplayable = classes.filter((c) => !rarityDisplay(c));
      // A class with no display name cannot be rendered, and §11.2 says such a run fails to lock. Caught
      // here so the refusal names the class rather than surfacing as an empty word in a committed sentence.
      if (undisplayable.length) return err(`the rarity table has no display name for ${undisplayable.join(', ')} — a run claiming it cannot lock`);
      return { ok: true, parsed: { classes } };
    }

    case 'slot_count': {
      const parsed = {};
      for (const member of v.split(',')) {
        const at = member.indexOf(':');
        const slot = member.slice(0, at), qty = member.slice(at + 1);
        if (at < 0 || !SLOT_RE.test(slot)) return err(`slot_count members are "slot:qty"; "${member}" is not`);
        if (!slots.includes(slot)) return err(`slot_count names "${slot}", which this run does not declare`);
        if (parseCount(qty) == null) return err(`slot_count "${member}" needs a positive integer with no leading zeros`);
        if (parsed[slot] != null) return err(`slot_count names "${slot}" twice`);
        parsed[slot] = Number(qty);
      }
      // Every declared slot must appear. A missing one is the difference between "a bundle contains three
      // packs and an art card" and "a bundle contains three packs", and the second is a promise about a
      // bundle the customer will find something else inside.
      const missing = slots.filter((s) => parsed[s] == null);
      if (missing.length) return err(`slot_count must cover every declared slot; missing ${missing.join(', ')}`);
      return { ok: true, parsed: { counts: parsed } };
    }

    case 'field_mix': {
      const at = v.indexOf(MIX_SEP);
      if (at < 0) return err(`field_mix values are "field${MIX_SEP}VALUE:count,VALUE:count"; "${v}" names no field`);
      const field = v.slice(0, at);
      if (!FIELDS.includes(field)) return err(`field_mix names "${field}", which is not one of the fifteen line fields`);
      const mix = {};
      for (const member of v.slice(at + 1).split(',')) {
        const c = member.lastIndexOf(':');
        const val = member.slice(0, c), count = member.slice(c + 1);
        if (c < 0 || !val) return err(`field_mix members are "VALUE:count"; "${member}" is not`);
        if (RESERVED_IN_MEMBER.test(val)) return err(`field_mix cannot express the value "${val}" — it contains one of , : =`);
        if (parseCount(count) == null) return err(`field_mix "${member}" needs a positive integer count with no leading zeros`);
        if (mix[val] != null) return err(`field_mix names "${val}" twice`);
        if (field === 'rarity' && !rarityDisplay(val)) {
          return err(`field_mix on rarity takes CLASS names with a display entry; "${val}" has none`);
        }
        mix[val] = Number(count);
      }
      return { ok: true, parsed: { field, mix } };
    }

    default:
      // Unreachable while CLAIM_TYPES and this switch agree — and asserted, because the day they stop
      // agreeing is the day an unhandled claim type starts passing validation by falling through.
      return err(`claim_type "${type}" is declared but has no validator`);
  }
}

/** Validate a whole set, including the uniqueness rule §5.1 states for claimsCanonical. */
export function validateClaims(claims = [], specs = []) {
  const errors = [];
  const seen = new Set();
  const langSubjects = new Set();
  for (const c of claims) {
    const v = validateClaim(c, specs);
    if (!v.ok) { errors.push(v.error); continue; }

    // `language slab eq JA` and `packs_language slab eq JA` state the SAME promise and hash
    // differently, so one run could make one promise under two digests. The uniqueness rule below does
    // not catch it, because the pairs differ. Refused — and `language` is the one to keep, since it
    // takes either subject and packs_language has no rendering rule anywhere in the specification.
    if (c.claim_type === 'language' || c.claim_type === 'packs_language') {
      if (langSubjects.has(c.subject)) {
        errors.push(`language and packs_language both claim "${c.subject}" — they state the same promise `
          + 'and would anchor two different digests; keep the language claim');
      }
      langSubjects.add(c.subject);
    }

    const key = `${c.claim_type} ${c.subject}`;
    if (seen.has(key)) errors.push(`two claims share (claim_type, subject) = (${c.claim_type}, ${c.subject}); §5.1 requires that pair to be unique`);
    seen.add(key);
  }
  return { ok: !errors.length, errors };
}

// --- canonical form ----------------------------------------------------------------------------------

// §5.1. Sorted by (claim_type, subject), both byte-wise. A set-valued `value` is comma-joined with its
// members sorted byte-wise and no spaces — so the caller may write a claim in any order and still get the
// one encoding the header commits to.
//
// THE SORT KEY IS THE WHOLE MEMBER, not the value inside it. §5.1 says "members sorted byte-wise" and a
// member is `M3:25`, so this is the literal reading — but the two readings genuinely diverge and the
// published vector cannot tell them apart, because `art:1,packs:3,slab:1` sorts identically either way.
// They part company on a value that is a prefix of another: ':' is 0x3A and '0' is 0x30, so sorting whole
// members puts `M30:1` BEFORE `M3:25`, while sorting by value alone reverses them. Set codes of exactly
// that shape are the document's own second worked example, so the choice is pinned by a test.
export function canonicalValue(claim) {
  const type = claim.claim_type;
  const v = normalizeValue(claim.value == null ? '' : String(claim.value));
  if (type === 'rarity_in') return v.split(',').map((s) => s.trim()).sort(byteCompare).join(',');
  if (type === 'slot_count') return v.split(',').map((s) => s.trim()).sort(byteCompare).join(',');
  if (type === 'field_mix') {
    const at = v.indexOf(MIX_SEP);
    if (at < 0) return v;
    const members = v.slice(at + 1).split(',').map((s) => s.trim()).sort(byteCompare).join(',');
    return v.slice(0, at) + MIX_SEP + members;
  }
  return v;
}

/** The claim list in canonical order — the order fragments are rendered in, too. */
export function canonicalClaims(claims = []) {
  return [...claims].sort((a, b) =>
    byteCompare(String(a.claim_type), String(b.claim_type))
    || byteCompare(String(a.subject), String(b.subject)));
}

/**
 * §5.1: claimsCanonical, one of the sub-encodings inside headerDigest.
 *
 * Reproduces the specification's published EX2 vector exactly; test/unit/runs-claims.test.mjs pins it.
 */
export function claimsCanonical(claims = []) {
  // All four fields go through §4.2 normalisation. The document lists "attribute values" and "header
  // strings" as subject to it and never mentions claim fields, which leaves a producer free to hash a
  // trailing space — so they are normalised here rather than trusted. Validation already confines the
  // first three to an ASCII vocabulary, making this a no-op for a valid claim and a defence for an
  // invalid one that reached the encoder anyway.
  const f = (v) => ns(normalizeValue(v == null ? '' : String(v)));
  return canonicalClaims(claims)
    .map((c) => f(c.claim_type) + f(c.subject) + f(c.operator) + ns(canonicalValue(c)))
    .join('');
}

// --- evaluation ---------------------------------------------------------------------------------------
//
// The manifest a claim is evaluated over:
//
//   { specs:   [ { slot, label, kind, qty_per_bundle, max_lines, singleton, requires_cert, is_chase_slot } ],
//     bundles: [ { no, label, lines: { <slot>: [ { …the fifteen §4.4 fields… } ] } } ] }
//
// The SAME shape is produced two ways, which is the point: the producer builds it from the draft manifest
// at lock, and a verifier builds it from the values opened at close. One evaluator, two callers, no
// second implementation to disagree with the first.

const linesOf = (bundle, slot) => (bundle.lines && bundle.lines[slot]) || [];
const val = (line, field) => normalizeValue(line[field] == null ? '' : String(line[field]));

// Every populated line in scope, tagged with where it came from so a counterexample can name it. An
// INVALID line is surfaced as a counterexample in its own right rather than skipped — a malformed line
// silently sitting outside every universal is how a bad row passes a guarantee.
function scopedLines(manifest, subject) {
  const out = [];
  const bad = [];
  for (const b of manifest.bundles || []) {
    const slots = subject === BUNDLE ? (manifest.specs || []).map((s) => s.slot) : [subject];
    for (const slot of slots) {
      linesOf(b, slot).forEach((line, i) => {
        const c = classifyLine(line);
        if (c.state === 'populated') out.push({ bundle: b, slot, index: i, line });
        else if (c.state === 'invalid') bad.push({ bundle: b, slot, index: i, line, why: c.why });
      });
    }
  }
  return { lines: out, invalid: bad };
}

const cx = (hit, got, want) => ({
  bundle: hit.bundle.label || `#${hit.bundle.no}`,
  slot: hit.slot,
  line: hit.index,
  cert: val(hit.line, 'cert_number') || null,
  name: val(hit.line, 'display_name') || null,
  got,
  want,
});

/**
 * Evaluate one claim. Returns { holds, counterexamples } — never throws for a manifest that merely fails,
 * because the caller wants the list of offending bundles, not the first one.
 *
 * A claim that does not validate returns holds:false with the validation error, so a bad claim can never
 * be read as a satisfied one.
 */
export function evaluateClaim(claim, manifest = {}, specs = manifest.specs || []) {
  const v = validateClaim(claim, specs);
  if (!v.ok) return { holds: false, error: v.error, counterexamples: [] };

  const { subject } = claim;
  const { lines, invalid } = scopedLines(manifest, subject);
  const counterexamples = invalid.map((hit) => cx(hit, 'a malformed line', hit.why));

  switch (claim.claim_type) {
    case 'grader': {
      for (const hit of lines) {
        const got = val(hit.line, 'grading_company');
        if (got !== v.parsed.company) counterexamples.push(cx(hit, got || '(none)', v.parsed.company));
      }
      break;
    }

    case 'min_grade': {
      for (const hit of lines) {
        const raw = val(hit.line, 'grade');
        const g = parseGrade(raw);
        // Two separate failures, and they are worth distinguishing: a grade that does not PARSE is a
        // malformed manifest, while one that parses and is too low is a card in the wrong bundle.
        if (g == null) counterexamples.push(cx(hit, raw ? `"${raw}" (unparseable)` : '(no grade)', `at least ${claim.value}`));
        else if (g < v.parsed.grade) counterexamples.push(cx(hit, raw, `at least ${claim.value}`));
      }
      break;
    }

    case 'language':
    case 'packs_language': {
      for (const hit of lines) {
        const got = val(hit.line, 'language');
        if (got !== v.parsed.language) counterexamples.push(cx(hit, got || '(none)', v.parsed.language));
      }
      break;
    }

    case 'rarity_in': {
      const want = v.parsed.classes;
      for (const hit of lines) {
        const raw = val(hit.line, 'rarity');
        const cls = rarityClass(raw);
        // An UNMAPPED rarity is a failure, not an absence. It has no committed class, so it satisfies no
        // claim — this is the MEGA_ATTACK_RARE case that a guarantee of "Art Rare" would otherwise have
        // passed silently, because the old abbreviation map returned nothing for it.
        if (!cls) counterexamples.push(cx(hit, raw ? `"${raw}" (no committed class)` : '(no rarity)', want.join(' or ')));
        else if (!want.includes(cls)) counterexamples.push(cx(hit, cls, want.join(' or ')));
      }
      break;
    }

    case 'slot_count': {
      // Per bundle, per slot: the summed qty over populated lines equals the stated quantity. Summed
      // rather than counted, because three packs from one product are ONE line with qty 3 (§4.4).
      for (const b of manifest.bundles || []) {
        for (const [slot, want] of Object.entries(v.parsed.counts)) {
          let total = 0;
          for (const line of linesOf(b, slot)) {
            if (classifyLine(line).state !== 'populated') continue;
            const q = parseCount(val(line, 'qty'));
            if (q == null) { total = NaN; break; }
            total += q;
          }
          if (!(total === want)) {
            counterexamples.push({
              bundle: b.label || `#${b.no}`, slot, line: null, cert: null, name: null,
              got: Number.isNaN(total) ? 'a line with an unparseable qty' : String(total),
              want: String(want),
            });
          }
        }
      }
      break;
    }

    case 'field_mix': {
      // THE ONLY AGGREGATE. Every other claim is a per-bundle universal; this one counts across the whole
      // run, which is what makes it a materially stronger statement: "every art card is one of these
      // rarities" versus "exactly fifteen are Art Rare and ten are Special Art Rare".
      //
      // IT COUNTS LINES, NOT UNITS, exactly as §11.2 words it. That is worth knowing before writing a
      // claim about a slot whose stock is drawn several units at a time: §4.4 makes three packs from one
      // product ONE line with qty 3, while three packs from three products are three lines. So
      // `set_code M3:25` over a 25-bundle run means twenty-five LINES carry M3 — which equals twenty-five
      // boosters only because the `distinct` deal forbids a repeat inside a bundle. Claim a mix over a
      // slot dealt with repeats and the number means something else.
      const { field, mix } = v.parsed;

      // AND IT COUNTS LINES WHILE THE SENTENCE NAMES OBJECTS, which is only harmless when the two are
      // the same number. §4.4 makes three packs of one product ONE line with qty 3, so a claim of
      // `set_code M3:25` over a 25-bundle run with three packs each would anchor a sentence saying
      // twenty-five packs are M3 while the run holds seventy-five. A provably false anchored guarantee
      // is the one failure with no recovery, so the claim is refused on any slot whose lines are not
      // one unit each. Edition 1's `art` slot is singleton, which is why it is unaffected.
      const multi = lines.filter((hit) => parseCount(val(hit.line, 'qty')) !== 1);
      if (multi.length) {
        for (const hit of multi.slice(0, 5)) {
          counterexamples.push(cx(hit, `a line of ${val(hit.line, 'qty')} units`,
            'one unit per line — a mix counts lines, so it can only name objects where the two agree'));
        }
        return { holds: false, counterexamples };
      }

      const tally = {};
      const unmapped = [];
      for (const hit of lines) {
        const raw = val(hit.line, field);
        let key = raw;
        if (field === 'rarity') {
          key = rarityClass(raw);
          if (!key) { unmapped.push(cx(hit, raw ? `"${raw}" (no committed class)` : '(no rarity)', 'a committed rarity class')); continue; }
        }
        tally[key] = (tally[key] || 0) + 1;
      }
      counterexamples.push(...unmapped);
      for (const [value, want] of Object.entries(mix)) {
        const got = tally[value] || 0;
        if (got !== want) {
          counterexamples.push({ bundle: '(run)', slot: subject, line: null, cert: null, name: null,
            got: `${got} line(s) with ${field} ${value}`, want: `${want}` });
        }
      }
      // A value present in the run but absent from the claim is a failure too: the mix is exhaustive, or
      // it says nothing. "Fifteen are Art Rare and ten are Special Art Rare" is false of a run that also
      // holds an Amazing Rare, even though both stated counts are right.
      for (const [value, got] of Object.entries(tally)) {
        if (mix[value] == null) {
          counterexamples.push({ bundle: '(run)', slot: subject, line: null, cert: null, name: null,
            got: `${got} line(s) with ${field} ${value}`, want: 'not mentioned by the claim, so none' });
        }
      }
      break;
    }

    default:
      return { holds: false, error: `claim_type "${claim.claim_type}" has no evaluator`, counterexamples: [] };
  }

  return { holds: counterexamples.length === 0, counterexamples };
}

/**
 * Evaluate a whole claim set in canonical order.
 *
 * SCOPE MATTERS, and getting it wrong makes every buyer verification fail. `field_mix` is the one
 * RUN-LEVEL claim: it counts across every bundle. A buyer's verification page holds exactly one
 * bundle's opened attributes, so it cannot count fifteen Art Rares across a run it cannot see —
 * yet §6.1 requires every claim to evaluate true over the values a verifier has opened. Read literally
 * that makes an Edition 1 buyer's check fail on a run where nothing is wrong.
 *
 * So a caller declares what it can see. scope 'bundle' DEFERS run-level claims — reported, never
 * silently dropped, and never counted as satisfied — leaving them to the close-out verifier, which is
 * the only party holding the whole run. scope 'run' (the default, and what lockRun uses) evaluates
 * everything.
 *
 * A run locks only when every claim holds; §11 additionally refuses a claim set that lacks a `language`
 * claim while any line's language is non-default, which is guardrail 4 and lives with the lock rather
 * than here — this module answers "do these claims hold", not "are these the right claims".
 */
export function evaluateClaims(claims = [], manifest = {}, specs = manifest.specs || [], { scope = 'run' } = {}) {
  if (scope !== 'run' && scope !== 'bundle') throw new Error(`unknown evaluation scope "${scope}"`);
  const results = canonicalClaims(claims).map((claim) => {
    const def = Object.prototype.hasOwnProperty.call(CLAIM_TYPES, claim.claim_type) ? CLAIM_TYPES[claim.claim_type] : null;
    if (scope === 'bundle' && def && def.scope === 'run') {
      return {
        claim,
        holds: null,
        deferred: true,
        why: `${claim.claim_type} counts across the whole run, which a single-bundle verifier cannot see`,
        counterexamples: [],
      };
    }
    return { claim, deferred: false, ...evaluateClaim(claim, manifest, specs) };
  });
  const evaluated = results.filter((r) => !r.deferred);
  return {
    // Only over what was actually evaluated. A deferred claim is neither held nor broken, and folding
    // it into either answer would be a lie in one direction or the other.
    holds: evaluated.every((r) => r.holds),
    scope,
    results,
    failing: evaluated.filter((r) => !r.holds),
    deferred: results.filter((r) => r.deferred),
  };
}
