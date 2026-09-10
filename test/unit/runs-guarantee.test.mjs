// test/unit/runs-guarantee.test.mjs — the generator that turns claims into the committed sentence.
//
// EVERY STRING THIS FILE ASSERTS IS A HASH INPUT. The guarantee goes inside headerDigest, which is
// anchored into Bitcoin, so a word changed here is not a failing test on a branch — it is a run nobody
// can verify. The wording choices below are choices: docs/RUNS_PLAN.md §11.2 references an integer table,
// a language display table and a noun source without supplying any of them, and its stated skeleton
// matches neither of its own worked examples. Each decision is pinned here because nothing else forces it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateGuarantee, inWords } from '../../lib/runs-guarantee.mjs';
import { BUNDLE } from '../../lib/runs-claims.mjs';

// Labels are CUSTOMER-FACING COPY here, not internal names: the label is the noun the sentence uses, so
// it is written as the singular noun phrase the sentence should contain.
const SPECS = [
  { slot: 'slab', label: 'graded card', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, singleton: 1, requires_cert: 1, is_chase_slot: 1, sort_order: 0 },
  { slot: 'packs', label: 'sealed pack', kind: 'sealed', qty_per_bundle: 3, max_lines: 3, singleton: 0, requires_cert: 0, is_chase_slot: 0, sort_order: 1 },
  { slot: 'art', label: 'art card', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, singleton: 0, requires_cert: 0, is_chase_slot: 0, sort_order: 2 },
];

const C = {
  grader: { claim_type: 'grader', subject: 'slab', operator: 'eq', value: 'PSA' },
  language: { claim_type: 'language', subject: BUNDLE, operator: 'eq', value: 'JA' },
  min_grade: { claim_type: 'min_grade', subject: 'slab', operator: 'gte', value: '10' },
  slot_count: { claim_type: 'slot_count', subject: BUNDLE, operator: 'eq', value: 'art:1,packs:3,slab:1' },
  field_mix: { claim_type: 'field_mix', subject: 'art', operator: 'eq', value: 'rarity=ART_RARE:15,SPECIAL_ART_RARE:10' },
  rarity_in: { claim_type: 'rarity_in', subject: 'slab', operator: 'in', value: 'ART_RARE,MEGA_ATTACK_RARE,SPECIAL_ART_RARE' },
};
const gen = (claims, unitCount = 25, specs = SPECS) => generateGuarantee({ specs, claims, unitCount });

describe('Edition 1', () => {
  const E1 = [C.grader, C.language, C.min_grade, C.field_mix, C.slot_count];

  it('generates the sentence', () => {
    assert.equal(gen(E1),
      'Every bundle contains one PSA 10 Japanese graded card, three Japanese sealed packs '
      + 'and one Japanese art card. Across the twenty-five bundles, fifteen art cards are Art Rare '
      + 'and ten are Special Art Rare.');
  });

  it('and its aggregate sentence matches the published one exactly', () => {
    // The second half is reproducible verbatim; the first is not, and the reason is recorded below.
    assert.ok(gen(E1).endsWith(
      'Across the twenty-five bundles, fifteen art cards are Art Rare and ten are Special Art Rare.'));
  });

  // WHERE WE DIVERGE FROM THE PUBLISHED SENTENCE, AND WHY. §11.2 prints "one PSA 10 graded Japanese card"
  // — the language word slotted INSIDE the label, between "graded" and "card", and inside "sealed booster
  // packs" between "sealed" and "booster". No mechanical rule produces both placements: it requires
  // knowing where each label's head noun begins. So the language word goes immediately before the label,
  // which is derivable, reads correctly, and says exactly the same thing.
  it('places the language word before the label rather than inside it', () => {
    const s = gen(E1);
    assert.match(s, /one PSA 10 Japanese graded card/);
    assert.doesNotMatch(s, /graded Japanese card/, 'that placement is not mechanically derivable');
  });
});

describe('the per-bundle clause', () => {
  it('renders slots in COMPOSITION order, not the claim value order', () => {
    // slot_count's value is byte-sorted art, packs, slab. The sentence reads slab, packs, art — the order
    // the bundle is physically laid out in, which is what the published sentence does.
    const s = gen([C.grader, C.min_grade, C.slot_count]);
    assert.ok(s.indexOf('graded card') < s.indexOf('sealed pack'));
    assert.ok(s.indexOf('sealed pack') < s.indexOf('art card'));
  });

  it('pluralises the label by count, and only by count', () => {
    const s = gen([C.slot_count]);
    assert.match(s, /one graded card/);
    assert.match(s, /three sealed packs/);
    assert.match(s, /one art card/);
  });

  it('joins with commas and a final "and", no Oxford comma', () => {
    assert.match(gen([C.slot_count]), /graded card, three sealed packs and one art card\./);
  });

  it('a bundle-scoped language claim reaches EVERY slot', () => {
    const s = gen([C.language, C.slot_count]);
    assert.equal(s.match(/Japanese/g).length, 3);
  });

  it('a slot-scoped one reaches only its slot', () => {
    const s = gen([{ ...C.language, subject: 'packs' }, C.slot_count]);
    assert.equal(s.match(/Japanese/g).length, 1);
    assert.match(s, /three Japanese sealed packs/);
  });

  it('renders a rarity_in claim as a plain list, with no invented characterisation', () => {
    // EX2 prints "of an illustrated chase rarity (…)". That phrase is derivable from no table and
    // characterises a class set that §11.1 does not define — precisely the unproved assertion §11.2
    // forbids a label from introducing. It is not emitted.
    const s = gen([C.grader, C.min_grade, C.rarity_in, C.slot_count]);
    assert.match(s, /one PSA 10 graded card of \(Art Rare, Mega Attack Rare or Special Art Rare\)/);
    // PARENTHESISED, and not for looks. Unbracketed the list runs into the clause after it —
    // "…card of Art Rare, Mega Attack Rare or Special Art Rare, three sealed packs and one art card"
    // reads as a single four-item list and a customer cannot parse it.
    assert.doesNotMatch(s, /rarity_in/);
    assert.doesNotMatch(s, /illustrated chase rarity/);
  });

  it('omits every clause it has no claim for', () => {
    assert.equal(gen([C.slot_count]),
      'Every bundle contains one graded card, three sealed packs and one art card.');
  });

  it('refuses to render without a slot_count claim', () => {
    // Falling back to the composition's own qty_per_bundle would put a number in the sentence that no
    // claim covers, and therefore nothing evaluates at close.
    assert.throws(() => gen([C.grader, C.language]), /needs a slot_count claim/);
  });
});

describe('the aggregate sentence', () => {
  it('is its own sentence, because mixing it into "every bundle contains" would be false', () => {
    const s = gen([C.slot_count, C.field_mix]);
    assert.equal(s.split('. ').length, 2);
    assert.match(s, /^Every bundle contains .*\. Across the twenty-five bundles, /);
  });

  it('carries the noun on the first member only', () => {
    assert.match(gen([C.slot_count, C.field_mix]),
      /fifteen art cards are Art Rare and ten are Special Art Rare\./);
  });

  it('generalises past rarity, rendering a non-rarity value literally', () => {
    const packsMix = { claim_type: 'field_mix', subject: 'packs', operator: 'eq', value: 'set_code=M3:25,M4:25,M5:25' };
    assert.match(gen([C.slot_count, packsMix]),
      /Across the twenty-five bundles, twenty-five sealed packs are M3, twenty-five are M4 and twenty-five are M5\./);
  });

  it('says "bundle" for a run of one', () => {
    const one = { claim_type: 'field_mix', subject: 'art', operator: 'eq', value: 'rarity=ART_RARE:1' };
    assert.match(gen([C.slot_count, one], 1), /Across the one bundle, one art card is|Across the one bundle, one art card are/);
  });

  it('renders one sentence per field_mix claim', () => {
    const packsMix = { claim_type: 'field_mix', subject: 'packs', operator: 'eq', value: 'set_code=M3:75' };
    const s = gen([C.slot_count, C.field_mix, packsMix]);
    assert.equal((s.match(/Across the twenty-five bundles/g) || []).length, 2);
  });
});

describe('the integer table §11.2 references and never supplies', () => {
  // THE RANGE IS NOT THE RUN SIZE. A field_mix count is populated LINES across every bundle, so at the
  // §3/§4.3 ceilings it reaches unit_count x max_lines = 999 x 99 = 98,901. A table stopping at 999
  // would throw on a run nothing else objects to.
  it('covers 0 to 999999, not merely the 999-bundle limit', () => {
    assert.equal(inWords(0), 'zero');
    assert.equal(inWords(1), 'one');
    assert.equal(inWords(15), 'fifteen');
    assert.equal(inWords(20), 'twenty');
    assert.equal(inWords(999), 'nine hundred and ninety-nine');
    assert.equal(inWords(98901), 'ninety-eight thousand nine hundred and one');
    assert.equal(inWords(999999), 'nine hundred and ninety-nine thousand nine hundred and ninety-nine');
  });

  // The `and` fork is the likeliest place two implementers diverge, so every branch is pinned.
  it('puts "and" after the hundreds but not after the thousands', () => {
    assert.equal(inWords(100), 'one hundred');
    assert.equal(inWords(101), 'one hundred and one');
    assert.equal(inWords(1000), 'one thousand');
    assert.equal(inWords(1001), 'one thousand and one');
    assert.equal(inWords(1100), 'one thousand one hundred');
    assert.equal(inWords(2997), 'two thousand nine hundred and ninety-seven');
  });

  it('hyphenates the compound tens — the form the published sentence uses', () => {
    assert.equal(inWords(25), 'twenty-five');
    assert.equal(inWords(42), 'forty-two');
    assert.equal(inWords(100), 'one hundred');
    assert.equal(inWords(105), 'one hundred and five');
  });

  it('refuses anything outside the range rather than emitting a numeral', () => {
    for (const n of [-1, 1000000, 1.5, NaN, '25', null]) {
      assert.throws(() => inWords(n), RangeError, String(n));
    }
  });
});

describe('what the generator refuses', () => {
  it('a minimum grade with no grader — "one 10 graded card" is not a sentence', () => {
    assert.throws(() => gen([C.slot_count, C.min_grade]), /minimum grade with no grader/);
  });

  it('a label that already reads as a plural, which the plural rule would double', () => {
    const specs = SPECS.map((x) => (x.slot === 'packs' ? { ...x, label: 'sealed packs' } : x));
    assert.throws(() => gen([C.slot_count], 25, specs), /already reads as a plural/);
  });

  // The label is emitted VERBATIM, so it is the one field an owner controls that reaches an anchored
  // sentence directly. A template-only scan cannot see this attack.
  it('a label carrying a ratio, which would put one into copy through the back door', () => {
    for (const label of ['one in five bonus card', 'chance card', 'percent off card']) {
      const specs = SPECS.map((x) => (x.slot === 'art' ? { ...x, label } : x));
      assert.throws(() => gen([C.slot_count], 25, specs), /ratio or a qualifier/, label);
    }
  });

  // A stray space is NORMALISED away rather than refused. §4.2 trims header strings and a label is one,
  // so the committed label is already trimmed and the assembled sentence cannot double a separator.
  it('normalises a stray space in a label rather than refusing it', () => {
    for (const label of [' art card', 'art card ', ' art card ']) {
      const specs = SPECS.map((x) => (x.slot === 'art' ? { ...x, label } : x));
      assert.match(gen([C.slot_count], 25, specs), /and one art card\.$/, JSON.stringify(label));
    }
  });

  // claimsCanonical and compositionCanonical are DIFFERENT fields of headerDigest, so a run could
  // otherwise anchor a composition of three packs while anchoring a promise of two, with neither
  // wrong on its own.
  it('a slot_count that disagrees with the composition it is describing', () => {
    const specs = SPECS.map((x) => (x.slot === 'packs' ? { ...x, qty_per_bundle: 4 } : x));
    assert.throws(() => gen([C.slot_count], 25, specs), /while the composition declares 4/);
  });

  it('a label that could smuggle an assertion into an anchored sentence', () => {
    for (const label of ['graded card (guaranteed hit!)', 'card 10', 'card,pack', '', 'x'.repeat(33)]) {
      const specs = SPECS.map((s) => (s.slot === 'slab' ? { ...s, label } : s));
      assert.throws(() => gen([C.slot_count], 25, specs), /a label is the noun/, JSON.stringify(label));
    }
  });

  it('a claim set that does not validate', () => {
    assert.throws(() => gen([C.slot_count, { claim_type: 'vibes', subject: 'slab', operator: 'eq', value: 'good' }]),
      /do not validate/);
  });

  it('a language with no display word, rather than committing a sentence with a hole in it', () => {
    assert.throws(() => gen([{ ...C.language, value: 'XX' }, C.slot_count]), /do not validate/);
  });

  it('an empty composition', () => {
    assert.throws(() => generateGuarantee({ specs: [], claims: [], unitCount: 25 }),
      /nothing to guarantee/);
  });
});

// GUARDRAIL 2, asserted over OUTPUT rather than over source. A source scan for "%" or "/" is unusable in
// JavaScript — both appear in every regex — and scanning for the word "ratio" flags the rarity table's own
// "illustRATIOn Rare". So the check is behavioural: generate across a spread of shapes and look at what
// could actually reach a customer.
describe('counts, never ratios', () => {
  const SHAPES = [
    [[C.grader, C.language, C.min_grade, C.field_mix, C.slot_count], 25],
    [[C.grader, C.min_grade, C.rarity_in, C.slot_count], 3],
    [[C.slot_count], 1],
    [[C.slot_count, { claim_type: 'field_mix', subject: 'packs', operator: 'eq', value: 'set_code=M3:1,M4:2' }], 999],
  ];

  it('emits no percentage, no fraction and no "N in M" form', () => {
    for (const [claims, n] of SHAPES) {
      const s = gen(claims, n);
      assert.doesNotMatch(s, /%/, s);
      assert.doesNotMatch(s, /\d\s*\/\s*\d/, s);
      assert.doesNotMatch(s, /\b(odds|chance|probability|percent|per cent)\b/i, s);
      assert.doesNotMatch(s, /\bone in\b|\b\d+ in \d+\b/i, s);
    }
  });

  it('renders every COUNT as a word — the only standalone numeral is a committed grade', () => {
    // Digits DO legitimately reach copy, in two ways that are not counts. A grade is a §4.3 decimal
    // whose exact form is hashed, so rendering 'PSA 10' as 'PSA ten' would commit a different string
    // from the one the claim carries. And a field value rendered literally can contain one, as a set
    // code like M3 does — which is why this looks for STANDALONE numerals: the 3 in M3 has no word
    // boundary before it, and it is part of an identifier rather than a quantity.
    for (const [claims, n] of SHAPES) {
      const out = gen(claims, n);
      const grades = claims.filter((c) => c.claim_type === 'min_grade').map((c) => String(c.value));
      const numerals = out.match(/\b\d[\d.]*\b/g) || [];
      for (const numeral of numerals) {
        assert.ok(grades.includes(numeral),
          `"${numeral}" is a numeral in copy and is not a committed grade: ${out}`);
      }
    }
  });

  it('so a run with no grade claim puts no numeral in front of a customer at all', () => {
    const out = gen([C.slot_count, C.field_mix], 25);
    assert.deepEqual(out.match(/\b\d[\d.]*\b/g), null, out);
  });
  it('and says twenty-five rather than 25 even when the run is that size', () => {
    const s = gen([C.slot_count, C.field_mix], 25);
    assert.match(s, /twenty-five/);
    assert.doesNotMatch(s, /\b25\b/);
  });
});
