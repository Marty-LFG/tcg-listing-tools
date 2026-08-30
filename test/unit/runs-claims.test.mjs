// test/unit/runs-claims.test.mjs — the closed claim vocabulary and its evaluators (lib/runs-claims.mjs).
//
// TWO THINGS THIS FILE EXISTS TO PIN, both of them defects that really happened:
//
//   THE EVALUATORS MUST ACTUALLY RUN. Revision 5 of the specification was driven by a verifier that never
//   evaluated its own claims — a committed grade of 9 passed a `min_grade gte 10` guarantee, because
//   nothing compared them. So every evaluator below is exercised in BOTH directions.
//
//   SILENCE MUST FAIL CLOSED. An unknown claim_type, operator or subject is refused, never skipped. A
//   claims engine that ignores what it does not recognise reads an unrecognised claim as "no claim" and
//   locks clean, which is exactly how a guarantee comes to promise something nothing checked.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_TYPES, BUNDLE, parseGrade, validateClaim, validateClaims,
  canonicalValue, canonicalClaims, claimsCanonical, evaluateClaim, evaluateClaims,
} from '../../lib/runs-claims.mjs';

// Edition 1's shape, as data. Nothing about slab/packs/art is hardcoded in the module.
const SPECS = [
  { slot: 'slab', label: 'Graded slab', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, singleton: 1, requires_cert: 1, is_chase_slot: 1 },
  { slot: 'packs', label: 'Sealed packs', kind: 'sealed', qty_per_bundle: 3, max_lines: 3, singleton: 0, requires_cert: 0, is_chase_slot: 0 },
  { slot: 'art', label: 'Art card', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, singleton: 0, requires_cert: 0, is_chase_slot: 0 },
];

// A padded line: all fifteen fields empty (§4.4). Written out rather than generated, because "all
// fifteen" is the rule and a helper that missed one would still look right.
const PAD = {
  kind: '', display_name: '', game: '', identity_key: '', set_code: '', card_number: '', rarity: '',
  language: '', finish: '', product_type: '', upc: '', grading_company: '', grade: '', cert_number: '', qty: '',
};
const slab = (over = {}) => ({
  ...PAD, kind: 'inventory', display_name: 'Sample Slab', game: 'pokemon', language: 'JA',
  rarity: 'Art Rare', grading_company: 'PSA', grade: '10', cert_number: '00000001', qty: '1', ...over,
});
const packs = (over = {}) => ({
  ...PAD, kind: 'sealed', display_name: 'Sample Boosters', game: 'pokemon', language: 'JA',
  set_code: 'M3', product_type: 'booster_pack', qty: '3', ...over,
});
const art = (over = {}) => ({
  ...PAD, kind: 'inventory', display_name: 'Sample Art Card', game: 'pokemon', language: 'JA',
  rarity: 'Art Rare', qty: '1', ...over,
});

const bundle = (no, over = {}) => ({
  no, label: `E1-${String(no).padStart(3, '0')}`,
  lines: { slab: [slab()], packs: [packs()], art: [art()], ...over },
});
const manifest = (bundles) => ({ specs: SPECS, bundles });
const run = (n = 3, shape = () => ({})) =>
  manifest(Array.from({ length: n }, (_, i) => bundle(i + 1, shape(i + 1))));

const CLAIM = {
  grader: { claim_type: 'grader', subject: 'slab', operator: 'eq', value: 'PSA' },
  language: { claim_type: 'language', subject: BUNDLE, operator: 'eq', value: 'JA' },
  min_grade: { claim_type: 'min_grade', subject: 'slab', operator: 'gte', value: '10' },
  rarity_in: { claim_type: 'rarity_in', subject: 'slab', operator: 'in', value: 'ART_RARE,SPECIAL_ART_RARE' },
  slot_count: { claim_type: 'slot_count', subject: BUNDLE, operator: 'eq', value: 'art:1,packs:3,slab:1' },
};

// --- the published vector ------------------------------------------------------------------------------

describe('claimsCanonical reproduces the specification vector', () => {
  // §5.1's EX2 fixture, deliberately supplied in the WRONG order with its set members scrambled — the
  // canonical form has to be reachable from any input ordering, or two producers who typed the same
  // claims differently would anchor different digests.
  const EX2 = [
    { claim_type: 'slot_count', subject: BUNDLE, operator: 'eq', value: 'slab:1,packs:3,art:1' },
    { claim_type: 'rarity_in', subject: 'slab', operator: 'in', value: 'SPECIAL_ART_RARE,ART_RARE,MEGA_ATTACK_RARE' },
    { claim_type: 'grader', subject: 'slab', operator: 'eq', value: 'PSA' },
    { claim_type: 'min_grade', subject: 'slab', operator: 'gte', value: '10' },
    { claim_type: 'language', subject: BUNDLE, operator: 'eq', value: 'JA' },
  ];
  const PUBLISHED = '6:grader,4:slab,2:eq,3:PSA,8:language,6:bundle,2:eq,2:JA,'
    + '9:min_grade,4:slab,3:gte,2:10,'
    + '9:rarity_in,4:slab,2:in,42:ART_RARE,MEGA_ATTACK_RARE,SPECIAL_ART_RARE,'
    + '10:slot_count,6:bundle,2:eq,20:art:1,packs:3,slab:1,';

  it('byte for byte', () => {
    assert.equal(claimsCanonical(EX2), PUBLISHED);
  });

  it('sorts claims by (claim_type, subject), byte-wise', () => {
    assert.deepEqual(canonicalClaims(EX2).map((c) => c.claim_type),
      ['grader', 'language', 'min_grade', 'rarity_in', 'slot_count']);
  });

  it('sorts set members byte-wise inside the value, with no spaces', () => {
    assert.equal(canonicalValue(EX2[1]), 'ART_RARE,MEGA_ATTACK_RARE,SPECIAL_ART_RARE');
    assert.equal(canonicalValue(EX2[0]), 'art:1,packs:3,slab:1');
    // The field_mix case, which no published vector covers: the field survives, the members sort.
    assert.equal(
      canonicalValue({ claim_type: 'field_mix', subject: 'art', operator: 'eq', value: 'rarity=SPECIAL_ART_RARE:10,ART_RARE:15' }),
      'rarity=ART_RARE:15,SPECIAL_ART_RARE:10');
  });
});

// --- the vocabulary is closed --------------------------------------------------------------------------

describe('an unrecognised claim is REFUSED, never skipped', () => {
  it('refuses an unknown claim_type and says what it does know', () => {
    const r = validateClaim({ claim_type: 'vibes', subject: 'slab', operator: 'eq', value: 'good' }, SPECS);
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown claim_type "vibes"/);
    assert.ok(r.known.includes('grader'));
  });

  it('refuses the wrong operator for a known type — there is one operator per type', () => {
    for (const [type, def] of Object.entries(CLAIM_TYPES)) {
      const wrong = def.operator === 'eq' ? 'gte' : 'eq';
      const subject = def.subject === 'bundle' ? BUNDLE : 'slab';
      const r = validateClaim({ claim_type: type, subject, operator: wrong, value: '1' }, SPECS);
      assert.equal(r.ok, false, `${type} accepted ${wrong}`);
      assert.match(r.error, /takes the operator/);
    }
  });

  it('refuses a subject the run does not declare, rather than passing over an empty set', () => {
    const r = validateClaim({ claim_type: 'grader', subject: 'booster_box', operator: 'eq', value: 'PSA' }, SPECS);
    assert.equal(r.ok, false);
    assert.match(r.error, /not one of slab, packs, art/);
  });

  it('refuses a bundle-only claim aimed at a slot, and vice versa', () => {
    assert.equal(validateClaim({ ...CLAIM.slot_count, subject: 'slab' }, SPECS).ok, false);
    assert.equal(validateClaim({ ...CLAIM.grader, subject: BUNDLE }, SPECS).ok, false);
    // `language` is the one type that legitimately takes either.
    assert.equal(validateClaim({ ...CLAIM.language, subject: BUNDLE }, SPECS).ok, true);
    assert.equal(validateClaim({ ...CLAIM.language, subject: 'packs' }, SPECS).ok, true);
  });

  it('refuses two claims sharing (claim_type, subject) — §5.1 requires that pair unique', () => {
    const r = validateClaims([CLAIM.grader, { ...CLAIM.grader, value: 'BGS' }], SPECS);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /unique/);
  });

  it('and an INVALID claim evaluates to holds:false, never to a satisfied one', () => {
    const r = evaluateClaim({ claim_type: 'vibes', subject: 'slab', operator: 'eq', value: 'good' }, run(), SPECS);
    assert.equal(r.holds, false);
    assert.match(r.error, /unknown claim_type/);
  });
});

// --- the value grammars --------------------------------------------------------------------------------

describe('grade follows the §4.3 grammar, not parseFloat', () => {
  it('accepts the forms the specification allows', () => {
    for (const g of ['0', '1', '9', '9.5', '10', '8.5']) assert.equal(parseGrade(g), Number(g), g);
  });

  it('REFUSES 10.0, 09 and .5 — two producers who disagree here anchor different digests', () => {
    for (const g of ['10.0', '09', '.5', '0.', '1e1', '-0', '11', '10.5', '', 'PSA 10', '9.50']) {
      assert.equal(parseGrade(g), null, `${JSON.stringify(g)} should be refused`);
    }
  });

  it('min_grade refuses a value its own grammar rejects', () => {
    assert.equal(validateClaim({ ...CLAIM.min_grade, value: '10.0' }, SPECS).ok, false);
    assert.equal(validateClaim({ ...CLAIM.min_grade, value: '10' }, SPECS).ok, true);
  });
});

describe('the other value grammars', () => {
  it('rarity_in takes CLASS names, and refuses a class with no display name', () => {
    assert.equal(validateClaim({ ...CLAIM.rarity_in, value: 'art rare' }, SPECS).ok, false, 'source strings are not classes');
    const r = validateClaim({ ...CLAIM.rarity_in, value: 'ART_RARE,INVENTED_RARE' }, SPECS);
    assert.equal(r.ok, false);
    assert.match(r.error, /no display name for INVENTED_RARE/);
  });

  it('slot_count must cover EVERY declared slot', () => {
    const r = validateClaim({ ...CLAIM.slot_count, value: 'slab:1,packs:3' }, SPECS);
    assert.equal(r.ok, false);
    assert.match(r.error, /missing art/);
  });

  it('slot_count refuses a leading zero, a zero and an undeclared slot', () => {
    for (const v of ['art:1,packs:03,slab:1', 'art:0,packs:3,slab:1', 'art:1,packs:3,slab:1,box:1']) {
      assert.equal(validateClaim({ ...CLAIM.slot_count, value: v }, SPECS).ok, false, v);
    }
  });

  it('field_mix names one of the fifteen line fields', () => {
    const ok = validateClaim({ claim_type: 'field_mix', subject: 'art', operator: 'eq', value: 'rarity=ART_RARE:2,SPECIAL_ART_RARE:1' }, SPECS);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.parsed, { field: 'rarity', mix: { ART_RARE: 2, SPECIAL_ART_RARE: 1 } });
    assert.equal(validateClaim({ claim_type: 'field_mix', subject: 'art', operator: 'eq', value: 'vibe=GOOD:2' }, SPECS).ok, false);
  });

  it('field_mix refuses a value it could not encode unambiguously', () => {
    // The separators are ',' ':' and '='. A value containing one is refused rather than mis-parsed —
    // this encoding goes into headerDigest, so a silent mis-parse is a wrong anchored hash.
    for (const bad of ['set_code=M3,4:2', 'set_code=A=B:2', 'set_code=A:B:2']) {
      const r = validateClaim({ claim_type: 'field_mix', subject: 'packs', operator: 'eq', value: bad }, SPECS);
      assert.equal(r.ok, false, bad);
    }
  });
});

// --- every evaluator, both directions --------------------------------------------------------------------

describe('grader', () => {
  it('holds when every populated line carries the company', () => {
    assert.equal(evaluateClaim(CLAIM.grader, run(3), SPECS).holds, true);
  });

  it('fails and names the bundle and the cert', () => {
    const m = run(3, (n) => (n === 2 ? { slab: [slab({ grading_company: 'BGS', cert_number: '00000002' })] } : {}));
    const r = evaluateClaim(CLAIM.grader, m, SPECS);
    assert.equal(r.holds, false);
    assert.equal(r.counterexamples.length, 1);
    assert.equal(r.counterexamples[0].bundle, 'E1-002');
    assert.equal(r.counterexamples[0].cert, '00000002');
    assert.equal(r.counterexamples[0].got, 'BGS');
  });
});

// THE PSA 8. The case the whole claims engine exists for: twenty-four PSA 10s and one PSA 8, where the
// guarantee says PSA 10 and nothing in the old code compared the two.
describe('min_grade — the PSA 8 case', () => {
  it('holds at exactly the boundary', () => {
    assert.equal(evaluateClaim(CLAIM.min_grade, run(3), SPECS).holds, true);
  });

  it('FAILS on a PSA 8 in a run of PSA 10s, and names it', () => {
    const m = run(25, (n) => (n === 13 ? { slab: [slab({ grade: '8', cert_number: '78595158' })] } : {}));
    const r = evaluateClaim(CLAIM.min_grade, m, SPECS);
    assert.equal(r.holds, false);
    assert.equal(r.counterexamples.length, 1);
    assert.equal(r.counterexamples[0].bundle, 'E1-013');
    assert.equal(r.counterexamples[0].cert, '78595158');
    assert.equal(r.counterexamples[0].got, '8');
    assert.match(r.counterexamples[0].want, /at least 10/);
  });

  it('FAILS on a committed grade of 9 under a gte 10 claim — the defect that drove revision 5', () => {
    const m = run(1, () => ({ slab: [slab({ grade: '9' })] }));
    assert.equal(evaluateClaim(CLAIM.min_grade, m, SPECS).holds, false);
  });

  it('distinguishes an unparseable grade from a low one', () => {
    const m = run(1, () => ({ slab: [slab({ grade: '10.0' })] }));
    const r = evaluateClaim(CLAIM.min_grade, m, SPECS);
    assert.equal(r.holds, false);
    assert.match(r.counterexamples[0].got, /unparseable/);
  });
});

describe('language', () => {
  it('bundle-scoped reaches every slot', () => {
    assert.equal(evaluateClaim(CLAIM.language, run(3), SPECS).holds, true);
    const m = run(3, (n) => (n === 1 ? { art: [art({ language: 'EN' })] } : {}));
    const r = evaluateClaim(CLAIM.language, m, SPECS);
    assert.equal(r.holds, false);
    assert.equal(r.counterexamples[0].slot, 'art');
  });

  it('slot-scoped does not', () => {
    const m = run(3, (n) => (n === 1 ? { art: [art({ language: 'EN' })] } : {}));
    assert.equal(evaluateClaim({ ...CLAIM.language, subject: 'slab' }, m, SPECS).holds, true);
  });

  it('packs_language is the same rule scoped to its slot', () => {
    const claim = { claim_type: 'packs_language', subject: 'packs', operator: 'eq', value: 'JA' };
    assert.equal(evaluateClaim(claim, run(3), SPECS).holds, true);
    const m = run(3, (n) => (n === 2 ? { packs: [packs({ language: 'EN' })] } : {}));
    assert.equal(evaluateClaim(claim, m, SPECS).holds, false);
  });
});

// THE MEGA ATTACK RARE. Two of Edition 1's five chases are Mega Attack Rares, not Art Rares, so the
// sentence "every bundle contains a Japanese Art Rare" is false for those bundles — the same class of
// failure as the PSA 8, a different card. It must be caught here, at the claim, not in copy review.
describe('rarity_in — the Mega Attack Rare case', () => {
  it('holds when every rarity maps into the claimed set', () => {
    assert.equal(evaluateClaim(CLAIM.rarity_in, run(3), SPECS).holds, true);
  });

  it('maps a cross-language alias to the same class rather than failing on the string', () => {
    const m = run(3, (n) => (n === 2 ? { slab: [slab({ rarity: 'Illustration Rare' })] } : {}));
    assert.equal(evaluateClaim(CLAIM.rarity_in, m, SPECS).holds, true, 'Illustration Rare IS Art Rare');
  });

  it('FAILS on a Mega Attack Rare under a claim of Art Rare or Special Art Rare', () => {
    const m = run(25, (n) => (n === 7 ? { slab: [slab({ rarity: 'Mega Attack Rare', cert_number: '11112222' })] } : {}));
    const r = evaluateClaim(CLAIM.rarity_in, m, SPECS);
    assert.equal(r.holds, false);
    assert.equal(r.counterexamples[0].bundle, 'E1-007');
    assert.equal(r.counterexamples[0].got, 'MEGA_ATTACK_RARE');
  });

  it('holds once the claim is broadened to include it — the owner decision, made explicit', () => {
    const m = run(25, (n) => (n === 7 ? { slab: [slab({ rarity: 'Mega Attack Rare' })] } : {}));
    const broadened = { ...CLAIM.rarity_in, value: 'ART_RARE,MEGA_ATTACK_RARE,SPECIAL_ART_RARE' };
    assert.equal(evaluateClaim(broadened, m, SPECS).holds, true);
  });

  it('FAILS on a rarity with no committed class — an unmapped value satisfies nothing', () => {
    const m = run(3, (n) => (n === 1 ? { slab: [slab({ rarity: 'Double Rare' })] } : {}));
    const r = evaluateClaim(CLAIM.rarity_in, m, SPECS);
    assert.equal(r.holds, false);
    assert.match(r.counterexamples[0].got, /no committed class/);
  });
});

describe('slot_count', () => {
  it('holds against a conforming run', () => {
    assert.equal(evaluateClaim(CLAIM.slot_count, run(3), SPECS).holds, true);
  });

  it('SUMS qty rather than counting lines — three packs from one product are ONE line with qty 3', () => {
    const split = run(1, () => ({ packs: [packs({ qty: '2', set_code: 'M3' }), packs({ qty: '1', set_code: 'M4' })] }));
    assert.equal(evaluateClaim(CLAIM.slot_count, split, SPECS).holds, true, 'two lines summing to three still satisfies packs:3');

    const shortRun = run(1, () => ({ packs: [packs({ qty: '2' })] }));
    const r = evaluateClaim(CLAIM.slot_count, shortRun, SPECS);
    assert.equal(r.holds, false);
    assert.equal(r.counterexamples[0].got, '2');
    assert.equal(r.counterexamples[0].want, '3');
  });

  it('counts a padded line as absent', () => {
    const m = run(1, () => ({ art: [{ ...PAD }] }));
    const r = evaluateClaim(CLAIM.slot_count, m, SPECS);
    assert.equal(r.holds, false);
    assert.equal(r.counterexamples[0].slot, 'art');
    assert.equal(r.counterexamples[0].got, '0');
  });
});

// THE ONLY AGGREGATE. Every other claim is a per-bundle universal; this one counts across the run, which
// is what makes it materially stronger: "every art card is one of these rarities" versus "exactly fifteen
// are Art Rare and ten are Special Art Rare".
describe('field_mix — run-level, not per-bundle', () => {
  const mix = (v) => ({ claim_type: 'field_mix', subject: 'art', operator: 'eq', value: v });
  const artRun = (rarities) => manifest(rarities.map((r, i) => bundle(i + 1, { art: [art({ rarity: r })] })));

  it('holds when the counts match exactly', () => {
    const m = artRun(['Art Rare', 'Art Rare', 'Special Art Rare']);
    assert.equal(evaluateClaim(mix('rarity=ART_RARE:2,SPECIAL_ART_RARE:1'), m, SPECS).holds, true);
  });

  it('FAILS when a count is off by one, and says which way', () => {
    const m = artRun(['Art Rare', 'Art Rare', 'Art Rare']);
    const r = evaluateClaim(mix('rarity=ART_RARE:2,SPECIAL_ART_RARE:1'), m, SPECS);
    assert.equal(r.holds, false);
    assert.equal(r.counterexamples.length, 2, 'three Art Rares where two were claimed, and no Special Art Rare');
    assert.match(r.counterexamples.map((c) => c.got).join(' | '), /3 line\(s\) with rarity ART_RARE/);
  });

  // The exhaustiveness rule, and the one that makes the claim mean what a customer reads. "Fifteen are
  // Art Rare and ten are Special Art Rare" is FALSE of a run that also holds an Amazing Rare, even though
  // both stated counts are correct.
  it('FAILS on a value the run holds but the claim does not mention', () => {
    const m = artRun(['Art Rare', 'Special Art Rare', 'Amazing Rare']);
    const r = evaluateClaim(mix('rarity=ART_RARE:1,SPECIAL_ART_RARE:1'), m, SPECS);
    assert.equal(r.holds, false);
    assert.match(r.counterexamples.map((c) => c.want).join(' '), /not mentioned by the claim/);
  });

  it('generalises past rarity — the same question arises for a deliberate pack mix', () => {
    const m = manifest([
      bundle(1, { packs: [packs({ set_code: 'M3' })] }),
      bundle(2, { packs: [packs({ set_code: 'M4' })] }),
      bundle(3, { packs: [packs({ set_code: 'M4' })] }),
    ]);
    const claim = { claim_type: 'field_mix', subject: 'packs', operator: 'eq', value: 'set_code=M3:1,M4:2' };
    assert.equal(evaluateClaim(claim, m, SPECS).holds, true);
    assert.equal(evaluateClaim({ ...claim, value: 'set_code=M3:2,M4:1' }, m, SPECS).holds, false);
  });

  it('maps rarity through the committed table but compares every other field literally', () => {
    const m = artRun(['Illustration Rare', 'Art Rare']);
    assert.equal(evaluateClaim(mix('rarity=ART_RARE:2'), m, SPECS).holds, true, 'aliases fold into one class');
  });
});

// --- malformed lines ------------------------------------------------------------------------------------

describe('a malformed line is a counterexample, not an absence', () => {
  it('a line with fields but no qty fails every universal over it', () => {
    // §4.4: a line is populated IFF its qty is non-empty. A line with a card name and no qty is neither
    // populated nor padded — it is invalid, and silently treating it as padding is how a bad row sits
    // outside every claim and passes the guarantee.
    const m = run(1, () => ({ slab: [slab({ qty: '' })] }));
    const r = evaluateClaim(CLAIM.grader, m, SPECS);
    assert.equal(r.holds, false);
    assert.match(r.counterexamples[0].got, /malformed/);
  });

  it('a properly padded line is simply absent, and fails nothing', () => {
    const m = run(1, () => ({ packs: [packs(), { ...PAD }, { ...PAD }] }));
    assert.equal(evaluateClaim(CLAIM.grader, m, SPECS).holds, true);
    assert.equal(evaluateClaim(CLAIM.language, m, SPECS).holds, true);
  });
});

// --- the whole set --------------------------------------------------------------------------------------

describe('evaluateClaims', () => {
  const ALL = Object.values(CLAIM);

  it('holds for Edition 1 over a conforming run', () => {
    const r = evaluateClaims(ALL, run(25), SPECS);
    assert.equal(r.holds, true, JSON.stringify(r.failing));
    assert.equal(r.results.length, 5);
  });

  it('reports results in canonical order, so the renderer and the audit agree', () => {
    assert.deepEqual(evaluateClaims(ALL, run(3), SPECS).results.map((r) => r.claim.claim_type),
      ['grader', 'language', 'min_grade', 'rarity_in', 'slot_count']);
  });

  it('one bad card fails the set and names only the claims it actually breaks', () => {
    const m = run(25, (n) => (n === 13 ? { slab: [slab({ grade: '8', cert_number: '78595158' })] } : {}));
    const r = evaluateClaims(ALL, m, SPECS);
    assert.equal(r.holds, false);
    assert.deepEqual(r.failing.map((f) => f.claim.claim_type), ['min_grade']);
    assert.equal(r.failing[0].counterexamples[0].cert, '78595158');
  });
});

// --- the encoding choices the specification leaves open ------------------------------------------------
//
// An independent reading of the whole document turned up thirty-five places an implementer must decide,
// twenty-six of which change an anchored hash. These are the ones this module resolves. Each is pinned
// here BECAUSE it is a choice: the document does not force it, so nothing but a test stops it drifting.

describe('member sort key — whole member, not the value inside it', () => {
  it('the published vector cannot tell the two readings apart, which is why this test exists', () => {
    // art < packs < slab either way. The vector is silent, so it proves nothing about the rule.
    const byMember = ['slab:1', 'packs:3', 'art:1'].sort();
    assert.deepEqual(byMember, ['art:1', 'packs:3', 'slab:1']);
  });

  it('they diverge on a value that is a prefix of another, and we take the literal reading', () => {
    // ':' is 0x3A and '0' is 0x30, so sorting whole members puts M30 first; sorting by value alone
    // puts M3 first. §5.1 says "members sorted byte-wise", and a member is `M3:25`.
    const claim = { claim_type: 'field_mix', subject: 'packs', operator: 'eq', value: 'set_code=M3:25,M30:1' };
    assert.equal(canonicalValue(claim), 'set_code=M30:1,M3:25');
  });
});

describe('min_grade compares numerically, never as strings', () => {
  it('9.5 does NOT satisfy gte 10 — a string comparison would say it does', () => {
    assert.ok('9.5' >= '10', 'the trap: as strings, 9.5 sorts after 10');
    const m = run(1, () => ({ slab: [slab({ grade: '9.5' })] }));
    assert.equal(evaluateClaim(CLAIM.min_grade, m, SPECS).holds, false);
  });

  it('and 9.5 does satisfy gte 9', () => {
    const m = run(1, () => ({ slab: [slab({ grade: '9.5' })] }));
    assert.equal(evaluateClaim({ ...CLAIM.min_grade, value: '9' }, m, SPECS).holds, true);
  });
});

describe('the vocabulary matches exactly, byte for byte', () => {
  it('refuses a claim_type in the wrong case', () => {
    assert.equal(validateClaim({ ...CLAIM.grader, claim_type: 'GRADER' }, SPECS).ok, false);
    assert.equal(validateClaim({ ...CLAIM.grader, claim_type: 'Grader' }, SPECS).ok, false);
  });

  it('refuses an operator in the wrong case', () => {
    assert.equal(validateClaim({ ...CLAIM.grader, operator: 'EQ' }, SPECS).ok, false);
  });

  it('is not fooled by a prototype key posing as a claim_type', () => {
    for (const t of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      assert.equal(validateClaim({ claim_type: t, subject: 'slab', operator: 'eq', value: 'PSA' }, SPECS).ok, false, t);
    }
  });
});

describe('claim fields are normalised before they are hashed', () => {
  it('a trailing space in a value cannot change the digest', () => {
    const clean = claimsCanonical([CLAIM.grader]);
    const spaced = claimsCanonical([{ ...CLAIM.grader, value: '  PSA\t' }]);
    assert.equal(spaced, clean);
  });

  it('and a decomposed character composes first', () => {
    // The document never says claim fields are subject to §4.2, which leaves a producer free to hash
    // either form. Normalising here removes the choice.
    const composed = 'Caf' + String.fromCodePoint(0x00e9);
    const decomposed = 'Caf' + String.fromCodePoint(0x65, 0x0301);
    const mk = (v) => claimsCanonical([{ claim_type: 'field_mix', subject: 'art', operator: 'eq', value: `display_name=${v}:1` }]);
    assert.notEqual(composed, decomposed);
    assert.equal(mk(decomposed), mk(composed));
  });
});

describe('one promise, one digest', () => {
  it('refuses language and packs_language on the same subject', () => {
    const r = validateClaims([
      { claim_type: 'language', subject: 'packs', operator: 'eq', value: 'JA' },
      { claim_type: 'packs_language', subject: 'packs', operator: 'eq', value: 'JA' },
    ], SPECS);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /same promise/);
  });

  it('but allows them on different subjects, which are different promises', () => {
    const r = validateClaims([
      { claim_type: 'language', subject: BUNDLE, operator: 'eq', value: 'JA' },
      { claim_type: 'packs_language', subject: 'packs', operator: 'eq', value: 'JA' },
    ], SPECS);
    assert.equal(r.ok, true, r.errors.join(' '));
  });
});

// §6.1 requires every claim to evaluate true over the values a verifier has opened — but a buyer's page
// holds ONE bundle, and field_mix counts across the run. Read literally that makes an Edition 1 buyer's
// verification fail on a run where nothing is wrong. The caller declares what it can see instead.
describe('scope — a single-bundle verifier defers what it cannot see', () => {
  const MIX = { claim_type: 'field_mix', subject: 'art', operator: 'eq', value: 'rarity=ART_RARE:2,SPECIAL_ART_RARE:1' };
  const ALL = [...Object.values(CLAIM), MIX];

  it('run scope evaluates the aggregate', () => {
    const m = manifest([
      bundle(1, { art: [art({ rarity: 'Art Rare' })] }),
      bundle(2, { art: [art({ rarity: 'Art Rare' })] }),
      bundle(3, { art: [art({ rarity: 'Special Art Rare' })] }),
    ]);
    const r = evaluateClaims(ALL, m, SPECS);
    assert.equal(r.holds, true, JSON.stringify(r.failing));
    assert.equal(r.deferred.length, 0);
  });

  it('bundle scope DEFERS it rather than failing a buyer whose bundle is fine', () => {
    const one = manifest([bundle(1, { art: [art({ rarity: 'Art Rare' })] })]);
    const strict = evaluateClaims(ALL, one, SPECS);
    assert.equal(strict.holds, false, 'a run-scoped read of one bundle correctly fails the aggregate');

    const buyer = evaluateClaims(ALL, one, SPECS, { scope: 'bundle' });
    assert.equal(buyer.holds, true, 'the buyer has a conforming bundle and must see green');
    assert.deepEqual(buyer.deferred.map((d) => d.claim.claim_type), ['field_mix']);
    assert.match(buyer.deferred[0].why, /whole run/);
  });

  it('a deferred claim is neither held nor broken — it is reported', () => {
    const one = manifest([bundle(1)]);
    const buyer = evaluateClaims([MIX], one, SPECS, { scope: 'bundle' });
    assert.equal(buyer.results[0].holds, null, 'null, not false and not true');
    assert.equal(buyer.failing.length, 0);
  });

  it('but a per-bundle claim is still evaluated at bundle scope — deferral is not a bypass', () => {
    const bad = manifest([bundle(1, { slab: [slab({ grade: '8' })] })]);
    const buyer = evaluateClaims(ALL, bad, SPECS, { scope: 'bundle' });
    assert.equal(buyer.holds, false);
    assert.deepEqual(buyer.failing.map((f) => f.claim.claim_type), ['min_grade']);
  });

  it('an unknown scope throws rather than guessing', () => {
    assert.throws(() => evaluateClaims([], manifest([]), SPECS, { scope: 'everything' }), /unknown evaluation scope/);
  });
});
