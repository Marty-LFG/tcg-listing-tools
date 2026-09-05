// test/unit/runs-disclose.test.mjs — §5.5, the tiered close-out and the verifier that constrains it.
//
// The two headline tests are the attacks the final review round found, both of which passed revision 4's
// checks and both of which must now fail:
//
//   1. A committed grade of 9 under a published `min_grade slab gte 10` claim, opened HONESTLY with a
//      correct salt and correct proofs. Every structural check passes; the claim is false.
//   2. Two ladder cards in one labelled bundle and none in another. A global multiset check passes; claim
//      3's "one per bundle" is false.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { holdForRun, assignToSlot, splitToSlots } from '../../lib/runs-reserve.mjs';
import { lockRunPhase1 } from '../../lib/runs-lock.mjs';
import {
  requiredAttributes, discloseTiers, verifyDisclosure, closeOutBundles, TIER_B_SEALED_FIELDS,
  SEAL_ATTRIBUTE,
} from '../../lib/runs-disclose.mjs';
import { commitment, verifyCommitment, assertNoMoney, publicContents } from '../../lib/runs-public.mjs';

const db = openDbAt(tmpFile('runs-disclose.db'));

const POLICY = 'Every bundle in a run is sold at one price shared by every remaining number.';
const SPECS = [
  { slot: 'slab', label: 'Graded slab', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, singleton: 1, requires_cert: 1, is_chase_slot: 1, sort_order: 0 },
  { slot: 'packs', label: 'Sealed pack', kind: 'sealed', qty_per_bundle: 3, max_lines: 3, singleton: 0, requires_cert: 0, is_chase_slot: 0, sort_order: 1 },
];
let seq = 0;

const mkSlab = (over = {}) => {
  const k = ++seq;
  db.prepare(`INSERT INTO inventory_items
    (sku, game, name, number, rarity, language, variant, quantity, status, grading_company, grade, cert_number, set_name)
    VALUES (?,?,?,?,?,?,?,1,'in_stock',?,?,?,?)`)
    .run(`D-SLB-${k}`, 'pokemon', over.name ?? `Card ${k}`, over.number ?? String(100 + k),
      over.rarity ?? 'Art Rare', 'JA', 'holo', 'PSA', over.grade ?? 10,
      over.cert_number ?? String(70000000 + k), 'Sample Set');
  return db.prepare('SELECT id FROM inventory_items WHERE sku = ?').get(`D-SLB-${k}`).id;
};
const mkPacks = (qty) => {
  const k = ++seq;
  db.prepare(`INSERT INTO sealed_items (sku, game, product_type, name, quantity, status, language, set_code, upc, set_name)
              VALUES (?,?,?,?,?,'in_stock','JA',?,?,?)`)
    .run(`D-PKS-${k}`, 'pokemon', 'booster_pack', `Pack ${k}`, qty, `SP${k}`, `0000000000${k}`, 'Sample Set');
  return db.prepare('SELECT id FROM sealed_items WHERE sku = ?').get(`D-PKS-${k}`).id;
};

let runN = 0;
/** A lockable two-slot run. `slabs` lets a test choose each bundle's card. */
function mkRun({ units = 3, ladder = 1, slabs = null } = {}) {
  const k = ++runN;
  const pid = `D${k}`;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, close_by, sales_close_at, unsold_policy)
              VALUES (?,?,?,'live',?,'draft',?,?,?)`)
    .run(pid, k, `Edition ${k}`, units, '2027-03-31T23:59:59.000Z', '2027-01-31T23:59:59.000Z', POLICY);
  const runId = db.prepare('SELECT id FROM runs WHERE public_id = ?').get(pid).id;

  const spec = db.prepare(`INSERT INTO run_slot_specs
    (run_id, slot, label, kind, qty_per_bundle, max_lines, singleton, requires_cert, is_chase_slot, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const s of SPECS) {
    spec.run(runId, s.slot, s.label, s.kind, s.qty_per_bundle, s.max_lines, s.singleton, s.requires_cert, s.is_chase_slot, s.sort_order);
  }
  for (let i = 1; i <= units; i++) {
    db.prepare('INSERT INTO run_bundles (run_id, bundle_no, label, seal_serial) VALUES (?,?,?,?)')
      .run(runId, i, `${pid}-${String(i).padStart(3, '0')}`, `seal-${pid}-${i}`);
  }
  const bundles = db.prepare('SELECT * FROM run_bundles WHERE run_id = ? ORDER BY bundle_no').all(runId);

  // THE LADDER DESCRIBES CARDS THAT ARE ACTUALLY IN THE RUN. `is_chase` is derived from the manifest,
  // not drawn — a ladder naming a card no bundle holds is a run that cannot produce a valid tier C
  // disclosure, and lockRun refuses it rather than discovering that after every parcel has shipped.
  const chaseNumbers = [];
  for (let r = 1; r <= ladder; r++) chaseNumbers.push(String(600 + r));
  const c = db.prepare('INSERT INTO run_claims (run_id, claim_type, subject, operator, value) VALUES (?,?,?,?,?)');
  c.run(runId, 'slot_count', 'bundle', 'eq', 'packs:3,slab:1');
  c.run(runId, 'language', 'bundle', 'eq', 'JA');
  c.run(runId, 'grader', 'slab', 'eq', 'PSA');
  c.run(runId, 'min_grade', 'slab', 'gte', '10');

  const packs = mkPacks(units * 3);
  const pool = holdForRun(db, { kind: 'sealed', itemId: packs, runId, qty: units * 3 });
  splitToSlots(db, pool.id, bundles.map((b) => ({ bundleId: b.id, slot: 'packs', qty: 3 })));
  bundles.forEach((b, i) => {
    // Bundles 1..ladder hold the ladder cards, so the derived chase set is deterministic in tests.
    const item = slabs ? slabs[i]() : mkSlab(i < ladder ? { number: chaseNumbers[i] } : {});
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    assignToSlot(db, { reservationId: h.id, bundleId: b.id, slot: 'slab' });
  });
  chaseNumbers.forEach((num, i) => {
    db.prepare(`INSERT INTO run_chase_tiers (run_id, rank, card_name, set_code, card_number, language, grading_company, grade)
                VALUES (?,?,?,?,?,?,?,?)`).run(runId, i + 1, `Chase ${i + 1}`, null, num, 'JA', 'PSA', '10');
  });
  return { runId, pid, bundles };
}

async function lockAndClose(opts = {}) {
  const { runId, pid } = mkRun(opts);
  const locked = await lockRunPhase1(db, runId);
  db.prepare("UPDATE runs SET status = 'closed' WHERE id = ?").run(runId);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  const specs = db.prepare('SELECT * FROM run_slot_specs WHERE run_id = ? ORDER BY sort_order').all(runId);
  const claims = db.prepare('SELECT * FROM run_claims WHERE run_id = ? AND published = 1').all(runId);
  const c = commitment(db, runId);
  return { runId, pid, run, specs, claims, locked, commitment: c };
}

describe('§5.5.1 the claim-to-attribute rule', () => {
  const claims = [
    { claim_type: 'min_grade', subject: 'slab', operator: 'gte', value: '10' },
    { claim_type: 'language', subject: 'bundle', operator: 'eq', value: 'JA' },
    { claim_type: 'slot_count', subject: 'bundle', operator: 'eq', value: 'packs:3,slab:1' },
  ];
  const names = requiredAttributes(claims, SPECS);

  it('opens kind and qty for every claim, because they establish OCCUPANCY', () => {
    // Without them a claim's values could sit on an otherwise-empty padded line — §4.5's padding exists
    // precisely so a padded line is indistinguishable, and at close that has to be undone where a claim
    // reaches.
    for (const slot of ['slab', 'packs']) {
      assert.ok(names.includes(`slot.${slot}.00.kind`), `${slot} kind`);
      assert.ok(names.includes(`slot.${slot}.00.qty`), `${slot} qty`);
    }
  });

  it('opens EVERY line index of a multi-line slot, not only the populated ones', () => {
    // Opening only the populated lines would itself disclose which are populated, before qty said so.
    for (const i of ['00', '01', '02']) assert.ok(names.includes(`slot.packs.${i}.qty`), i);
    assert.ok(!names.includes('slot.packs.03.qty'), 'and stops at max_lines');
  });

  it('opens product_type on a SEALED slot, so "booster pack" means something', () => {
    // Opening only kind, qty and language under a slot NAMED "packs" proves a quantity under a namespace.
    // A line with product_type = deck_box would satisfy every field then opened.
    assert.ok(names.includes('slot.packs.00.product_type'));
  });

  it('and never opens the identifying fields tier B keeps sealed', () => {
    for (const f of TIER_B_SEALED_FIELDS) {
      assert.ok(!names.some((n) => n.endsWith(`.${f}`)), `${f} must stay sealed at tier B`);
    }
  });

  it('scopes a slot-subject claim to that slot alone', () => {
    const only = requiredAttributes([{ claim_type: 'grader', subject: 'slab', operator: 'eq', value: 'PSA' }], SPECS);
    assert.ok(only.includes('slot.slab.00.grading_company'));
    assert.ok(!only.some((n) => n.startsWith('slot.packs.')));
  });

  it('and refuses a claim type it has no rule for', () => {
    assert.throws(() => requiredAttributes([{ claim_type: 'invented', subject: 'bundle' }], SPECS), /no §5.5.1 rule/);
  });
});

describe('an honest A+B+C disclosure verifies', () => {
  it('end to end, against the commitment alone', async () => {
    const ctx = await lockAndClose();
    const artifact = await discloseTiers({
      run: ctx.run, specs: ctx.specs, claims: ctx.claims, ladder: [],
      bundles: closeOutBundles(db, ctx.runId),
    });
    const v = await verifyDisclosure(artifact, ctx.commitment);
    assert.deepEqual(v.errors, []);
    assert.ok(v.ok);
    assert.equal(v.chaseIndices.length, 1, 'the ladder declares one chase');
  });

  it('and the commitment recomputes its own header digest', async () => {
    const ctx = await lockAndClose();
    assert.equal(await verifyCommitment(ctx.commitment), ctx.run.header_digest);
  });

  it('with no card identity anywhere in the tier A+B artifact', async () => {
    const ctx = await lockAndClose();
    const artifact = await discloseTiers({
      run: ctx.run, specs: ctx.specs, claims: ctx.claims,
      bundles: closeOutBundles(db, ctx.runId), tiers: ['A', 'B'],
    });
    const body = JSON.stringify(artifact);
    // Asserted on the LITERAL seeded values, not on key names — the realistic leak is a value carried
    // somewhere no key-name check would look.
    const rows = db.prepare(`SELECT s.display_name, s.cert_number, s.set_code FROM run_bundle_slots s
                               JOIN run_bundles b ON b.id = s.bundle_id WHERE b.run_id = ?`).all(ctx.runId);
    for (const r of rows) {
      if (r.display_name) assert.ok(!body.includes(r.display_name), `display_name ${r.display_name} leaked`);
      if (r.cert_number) assert.ok(!body.includes(r.cert_number), `cert ${r.cert_number} leaked`);
      if (r.set_code) assert.ok(!body.includes(r.set_code), `set_code ${r.set_code} leaked`);
    }
  });
});

describe('THE ATTACKS THE FINAL REVIEW FOUND', () => {
  it('refuses a committed grade 9 opened honestly under a gte 10 claim', async () => {
    // Revision 4 checked only that openings were structurally valid. A seller could commit grade 9,
    // publish `min_grade slab gte 10`, open the 9 with a correct salt and correct proofs, and pass every
    // listed check. The verifier must RUN THE EVALUATORS, not trust that the producer did.
    const ctx = await lockAndClose({ slabs: [() => mkSlab({ grade: 9 }), () => mkSlab(), () => mkSlab()] })
      .then((x) => x, (e) => e);
    // The lock itself refuses first, which is the outer defence — so the attack has to be staged past it.
    assert.ok(ctx instanceof Error, 'lock refuses a grade 9 under a gte 10 claim');
    assert.equal(ctx.code, 'lock_refused');

    // Now stage it the only way a dishonest producer could: lock clean, then edit the frozen row and
    // disclose. Every proof is recomputed and correct; the CLAIM is what fails.
    const good = await lockAndClose();
    db.prepare(`UPDATE run_bundle_slots SET grade = 9
                 WHERE slot = 'slab' AND bundle_id = (SELECT id FROM run_bundles WHERE run_id = ? AND bundle_no = 2)`)
      .run(good.runId);
    const artifact = await discloseTiers({
      run: good.run, specs: good.specs, claims: good.claims,
      bundles: closeOutBundles(db, good.runId), tiers: ['A', 'B'],
    });
    const v = await verifyDisclosure(artifact, good.commitment);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /min_grade/.test(e) && /DOES NOT HOLD/.test(e)),
      `expected a claim failure, got: ${v.errors.join(' | ')}`);
  });

  it('refuses two ladder cards in one labelled bundle and none in another', async () => {
    // A global multiset check passes here, which is exactly the hole: claim 3 says ONE PER BUNDLE. The
    // check is exercised at the verifier by handing it a commitment whose second ladder entry describes
    // the SAME card as the first, so one bundle matches two entries and another matches none.
    const ctx = await lockAndClose({ units: 3, ladder: 2 });
    const ladder = db.prepare('SELECT * FROM run_chase_tiers WHERE run_id = ? ORDER BY rank').all(ctx.runId);
    const artifact = await discloseTiers({
      run: ctx.run, specs: ctx.specs, claims: ctx.claims,
      bundles: closeOutBundles(db, ctx.runId), tiers: ['A', 'C'],
    });
    const forged = { ...ctx.commitment, chase_ladder: [ladder[0], { ...ladder[1], card_number: ladder[0].card_number }] };
    const v = await verifyDisclosure(artifact, forged);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /matches 2 ladder cards|exactly one is required|appears in no labelled bundle/.test(e)),
      `expected a bijection failure, got: ${v.errors.join(' | ')}`);
  });

  it('and lockRun refuses the same shape BEFORE anything is hashed', async () => {
    // The outer defence: the bijection is asserted at lock, so a run that could not produce a valid tier C
    // disclosure never gets anchored in the first place.
    const { runId, bundles } = mkRun({ units: 3, ladder: 2 });
    const first = db.prepare(`SELECT i.id FROM run_reservations r JOIN inventory_items i ON i.id = r.item_id
                               WHERE r.bundle_id = ? AND r.slot = 'slab'`).get(bundles[1].id);
    // Point bundle 2's slab at bundle 1's card number, so bundle 1 matches both ladder entries.
    const b1 = db.prepare(`SELECT i.number FROM run_reservations r JOIN inventory_items i ON i.id = r.item_id
                            WHERE r.bundle_id = ? AND r.slot = 'slab'`).get(bundles[0].id);
    db.prepare('UPDATE inventory_items SET number = ? WHERE id = ?').run(b1.number, first.id);
    const err = await lockRunPhase1(db, runId).then(() => null, (e) => e);
    assert.equal(err?.code, 'lock_refused');
    assert.ok(err.problems.some((p) => p.code === 'chase_placement'),
      `expected a chase placement refusal, got: ${JSON.stringify(err.problems.map((p) => p.code))}`);
  });
});
describe('the verifier refuses a malformed artifact', () => {
  let ctx;
  let artifact;
  it('builds a clean one first', async () => {
    ctx = await lockAndClose();
    artifact = await discloseTiers({
      run: ctx.run, specs: ctx.specs, claims: ctx.claims,
      bundles: closeOutBundles(db, ctx.runId), tiers: ['A', 'B'],
    });
    assert.ok((await verifyDisclosure(artifact, ctx.commitment)).ok);
  });

  it('a missing required opening', async () => {
    const short = { ...artifact, openings: artifact.openings.filter((o) => o.name !== 'slot.slab.00.grade') };
    const v = await verifyDisclosure(short, ctx.commitment);
    assert.ok(v.errors.some((e) => /missing the required opening/.test(e)));
  });

  it('an extra opening no tier requires', async () => {
    // Not merely untidy: an extra opening is an unrequested disclosure, and the artifact is supposed to be
    // exactly what the tier says it is.
    const extra = artifact.openings.find((o) => o.name === 'slot.slab.00.grade');
    const v = await verifyDisclosure(
      { ...artifact, openings: [...artifact.openings, { ...extra, name: 'slot.slab.00.cert_number' }] },
      ctx.commitment);
    assert.ok(v.errors.some((e) => /which no tier in this artifact requires/.test(e)));
  });

  it('the same pair opened twice', async () => {
    const dup = { ...artifact, openings: [...artifact.openings, artifact.openings[0]] };
    const v = await verifyDisclosure(dup, ctx.commitment);
    assert.ok(v.errors.some((e) => /twice/.test(e)));
  });

  it('a fabricated value, which has no valid proof', async () => {
    // Swapped to a value the bundle does not hold — 9 where the committed grade is 10. The recomputed
    // attribute commitment no longer matches, so the proof fails before the claim is ever evaluated.
    const tampered = artifact.openings.map((o) => (o.name === 'slot.slab.00.grade' ? { ...o, value: '9' } : o));
    const v = await verifyDisclosure({ ...artifact, openings: tampered }, ctx.commitment);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /attribute proof failed/.test(e)),
      `expected a proof failure, got: ${v.errors.join(' | ')}`);
  });
  it('an artifact naming a different run root', async () => {
    const v = await verifyDisclosure(artifact, { ...ctx.commitment, root: 'ff'.repeat(32) });
    assert.ok(v.errors.some((e) => /different run root/.test(e)));
  });

  it('and a bundle that does not open is_chase, so a missing bundle is visibly missing', async () => {
    const gone = { ...artifact, openings: artifact.openings.filter((o) => !(o.bundle.index === 2 && o.name === 'bundle.is_chase')) };
    const v = await verifyDisclosure(gone, ctx.commitment);
    assert.ok(v.errors.some((e) => /does not open bundle.is_chase/.test(e)));
  });
});

describe('§5.2 the commitment publishes no contents and no money', () => {
  it('names no card, no salt, no code and no serial', async () => {
    const ctx = await lockAndClose();
    const body = JSON.stringify(ctx.commitment);
    const rows = db.prepare(`SELECT s.display_name, s.cert_number FROM run_bundle_slots s
                               JOIN run_bundles b ON b.id = s.bundle_id WHERE b.run_id = ?`).all(ctx.runId);
    // Only non-null values: includes(null) stringifies to "null", which any JSON with a null field
    // contains, and a test that passes for the wrong reason is worse than no test.
    for (const r of rows) {
      if (r.display_name) assert.ok(!body.includes(r.display_name), `display_name ${r.display_name} leaked`);
      if (r.cert_number) assert.ok(!body.includes(r.cert_number), `cert ${r.cert_number} leaked`);
    }
    const secrets = db.prepare('SELECT salt_hex, verify_code, seal_serial FROM run_bundles WHERE run_id = ?').all(ctx.runId);
    for (const x of secrets) {
      assert.ok(x.salt_hex && x.verify_code && x.seal_serial, 'the fixture actually has secrets to leak');
      assert.ok(!body.includes(x.salt_hex), 'a salt reached the commitment');
      assert.ok(!body.includes(x.verify_code), 'a verification code reached the commitment');
      assert.ok(!body.includes(x.seal_serial), 'a seal serial reached the commitment');
    }
  });

  it('carries no per-bundle state, because republishing would leak ship order', async () => {
    // Were the commitment reissued as bundles shipped — even only to flip a boolean — an observer
    // archiving successive versions could diff them and name the bundle that changed.
    const ctx = await lockAndClose();
    const body = JSON.stringify(ctx.commitment);
    for (const word of ['shipped', 'sold_at', 'packed', 'status']) {
      assert.ok(!body.includes(word), `${word} is per-bundle state and must not be published`);
    }
  });

  it('and assertNoMoney throws on a money key, a money value and a nested one', () => {
    assert.throws(() => assertNoMoney({ cost_cents: 57400 }), /money-shaped key/);
    assert.throws(() => assertNoMoney({ note: 'paid $129 for it' }), /monetary amount/);
    assert.throws(() => assertNoMoney({ a: [{ b: { unit_price_cents: 1 } }] }), /money-shaped key/);
    assert.doesNotThrow(() => assertNoMoney({ bundle_no: 7, leaf: 'ab'.repeat(32) }));
  });
});

describe('contents are never published before a run closes', () => {
  it('refuses the contents view while the run is still locked', async () => {
    const { runId } = mkRun();
    await lockRunPhase1(db, runId);
    assert.throws(() => publicContents(db, runId), /not published before a run closes/);
  });

  it('and allows it once closed', async () => {
    const ctx = await lockAndClose();
    const rows = publicContents(db, ctx.runId);
    assert.ok(rows.length > 0);
  });
});

describe('a public tier never carries a seal serial', () => {
  it('tier C opens every OTHER attribute of a chase bundle', async () => {
    const ctx = await lockAndClose();
    // §4.4: the serial is opened only at tier D, "publishing chase bundles' serials would let anyone who
    // photographed a parcel correlate it to a chase for no benefit". The tier-C branch iterated the
    // bundle's attributes unfiltered, so a routine A+B+C close-out published the serial of exactly the
    // bundle where that correlation is worth something - and the serial is printed on the OUTSIDE of the
    // parcel, where every courier in the chain can photograph it.
    //
    // Found on a real published artifact by an independent audit, not by this suite.
    const artifact = await discloseTiers({
      run: ctx.run, claims: ctx.claims, specs: ctx.specs, ladder: [],
      bundles: closeOutBundles(db, ctx.runId), tiers: ['A', 'B', 'C'],
    });
    const serials = artifact.openings.filter((o) => o.name === SEAL_ATTRIBUTE);
    assert.equal(serials.length, 0, `tier C published ${serials.length} seal serial(s)`);
    // and it is genuinely opening chase attributes, so the absence above is a filter and not an empty tier
    assert.ok(artifact.openings.some((o) => o.name.startsWith('slot.')),
      'tier C opened nothing at all, so the assertion above proves nothing');
  });

  it('and tier D does, because by then every bundle is public anyway', async () => {
    const ctx = await lockAndClose();
    const artifact = await discloseTiers({
      run: ctx.run, claims: ctx.claims, specs: ctx.specs, ladder: [],
      bundles: closeOutBundles(db, ctx.runId), tiers: ['A', 'B', 'C', 'D'],
    });
    assert.ok(artifact.openings.some((o) => o.name === SEAL_ATTRIBUTE),
      'tier D withheld the serial, so the filter is scoped too widely');
  });
});
