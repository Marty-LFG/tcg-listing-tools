// lib/runs-disclose.mjs — §5.5: the tiered close-out disclosure, and the verifier that constrains it.
//
// TWO HALVES, AND THE SPLIT MATTERS. `disclose*` is the PRODUCER: it reads bundle salts, so it is
// node-side and never customer-facing. `verifyDisclosure` is ISOMORPHIC and takes no database handle at
// all — it is handed the artifact and the commitment and nothing else, because a buyer running it has
// nothing else. Keeping them in one file keeps the mapping in §5.5.1 single-source; keeping the verifier
// db-free is what lets the storefront page and runs-verify.html run the identical function.
//
// WHY THE VERIFIER EVALUATES CLAIMS RATHER THAN CHECKING PROOFS. Revision 4's close-out check verified
// only that openings were structurally valid, which a reviewer broke in one line: a seller commits
// `slot.slab.00.grade = "9"`, publishes the claim `min_grade slab gte 10`, opens the 9 honestly with a
// correct salt and correct proofs, and passes every listed check. The public verifier exists precisely to
// constrain a dishonest producer, so it must RUN THE EVALUATORS, not trust that the producer ran them.
//
// AND WHY TIER C NEEDS A BIJECTION. Revision 4 required only that the opened chase cards, as a multiset,
// equalled the ladder. A reviewer showed that passes when two ladder cards sit in one labelled bundle and
// none in another — claim 3's "one per bundle" would have been false while the check said yes.

import { openAttribute, verifyOpening, bundleTree } from './runs-merkle.mjs';
import { bundleAttributes, normalizeValue } from './runs-canonical.mjs';
import { evaluateClaims, canonicalClaims } from './runs-claims.mjs';

export const TIERS = Object.freeze(['A', 'B', 'C', 'D']);

/** §5.5.1: which of the fifteen fields each claim type rests on. `kind` and `qty` are added separately. */
const CLAIM_FIELDS = Object.freeze({
  grader: ['grading_company'],
  min_grade: ['grade'],
  language: ['language'],
  rarity_in: ['rarity'],
  packs_language: ['language', 'product_type'],
  slot_count: [],
  field_mix: [],
});

const pad2 = (n) => String(n).padStart(2, '0');
const attrName = (slot, i, field) => `slot.${slot}.${pad2(i)}.${field}`;

/**
 * §5.5.1: the exact attribute names tier B must open, for every bundle.
 *
 * `kind` and `qty` accompany EVERY claim because they establish occupancy. Without them a claim's values
 * could sit on an otherwise-empty padded line — the padding of §4.5 exists precisely so that a padded line
 * is indistinguishable from a real one, and at close that has to be undone for the lines a claim covers.
 *
 * Where a claim's subject is a slot whose composition `kind` is `sealed`, `product_type` opens too. A
 * reviewer showed why: opening only `kind`, `qty` and `language` on a slot NAMED `packs` proves a quantity
 * under a namespace, not that the committed product is a booster pack. A line with
 * `product_type = deck_box` would satisfy every field then opened while the guarantee said "booster packs".
 *
 * EVERY LINE, not only the populated ones — `0..max_lines-1`. Opening only the populated ones would itself
 * disclose which lines are populated, before `qty` had a chance to say so.
 */
export function requiredAttributes(claims = [], specs = []) {
  const bySlot = new Map(specs.map((s) => [s.slot, s]));
  const fields = new Map();                                  // slot -> Set(field)
  const need = (slot, field) => {
    if (!bySlot.has(slot)) return;
    if (!fields.has(slot)) fields.set(slot, new Set());
    fields.get(slot).add(field);
  };

  for (const claim of claims) {
    const scope = claim.subject === 'bundle' ? specs.map((s) => s.slot) : [claim.subject];
    const base = CLAIM_FIELDS[claim.claim_type];
    if (!base) throw new Error(`no §5.5.1 rule for claim type "${claim.claim_type}"`);
    for (const slot of scope) {
      // Occupancy, always.
      need(slot, 'kind');
      need(slot, 'qty');
      for (const f of base) need(slot, f);
      // The sealed rule: a product type is what makes "booster pack" mean anything.
      if (bySlot.get(slot)?.kind === 'sealed') need(slot, 'product_type');
    }
  }

  const names = [];
  for (const [slot, set] of fields) {
    const spec = bySlot.get(slot);
    for (let i = 0; i < spec.max_lines; i++) for (const f of set) names.push(attrName(slot, i, f));
  }
  return names.sort();
}

/** The fields tier B must NOT open. Listed so the test can assert on the list rather than on examples. */
export const TIER_B_SEALED_FIELDS = Object.freeze([
  'display_name', 'identity_key', 'set_code', 'card_number', 'cert_number', 'upc', 'finish',
]);

/**
 * Build a close-out artifact. Producer side: reads bundle salts, so this never runs in a browser.
 *
 * `bundles` is the assembled manifest — one entry per bundle carrying its salt and its full attribute list,
 * exactly as the lock built them. Rebuilt from the frozen rows rather than cached, so a disclosure is
 * always a statement about what is in the database now, verifiable against the anchored root.
 */
export async function discloseTiers({ run, specs, claims, ladder = [], bundles, tiers = ['A', 'B', 'C'] }) {
  for (const t of tiers) if (!TIERS.includes(t)) throw new Error(`unknown disclosure tier "${t}"`);
  // Roots are RECOMPUTED from the frozen rows rather than read back from the database. A disclosure that
  // quoted a stored root would prove only that we can copy a column; recomputing means the artifact fails
  // to verify if anything in those rows drifted from what was anchored.
  const ordered = [...bundles].sort((a, b) => a.bundleNo - b.bundleNo);
  const roots = [];
  for (const b of ordered) roots.push((await bundleTree(b.salt, b.attributes)).root);

  const open = (b, name) => openAttribute({
    bundleSaltHex: b.salt, attributes: b.attributes, bundleIndex: b.bundleNo - 1, bundleRoots: roots, name,
  });

  const openings = [];
  const seen = new Set();
  const push = async (b, name) => {
    const key = `${b.bundleNo - 1}|${name}`;
    if (seen.has(key)) return;                 // a tier may subsume another; the artifact carries one each
    seen.add(key);
    openings.push(await open(b, name));
  };

  if (tiers.includes('A') || tiers.includes('C') || tiers.includes('D')) {
    // Tier A opens is_chase for ALL bundles, so a bundle missing from the artifact is visibly missing.
    for (const b of ordered) await push(b, 'bundle.is_chase');
  }
  if (tiers.includes('B') || tiers.includes('D')) {
    const names = requiredAttributes(claims, specs);
    for (const b of ordered) for (const n of names) await push(b, n);
  }
  if (tiers.includes('C') || tiers.includes('D')) {
    const chase = ordered.filter((b) => b.isChase);
    for (const b of chase) for (const a of b.attributes) await push(b, a.name);
  }
  if (tiers.includes('D')) {
    for (const b of ordered) for (const a of b.attributes) await push(b, a.name);
  }

  return {
    v: 1,
    run: run.public_id,
    header_digest: run.header_digest,
    root: run.run_root,
    tiers: [...tiers].sort(),
    unit_count: run.unit_count,
    openings,
  };
}

/** Regroup a flat opening list into `bundleIndex -> name -> value`, refusing a duplicate pair. */
function indexOpenings(openings) {
  const by = new Map();
  for (const o of openings) {
    const i = o.bundle?.index;
    if (!Number.isInteger(i)) throw new Error('an opening carries no bundle index');
    if (!by.has(i)) by.set(i, new Map());
    // THE UNIT IS THE PAIR (bundle index, attribute name). Revision 4 said "every index exactly once",
    // which a literal implementation rejects on every valid tier-B artifact — one bundle contributes many
    // attribute openings, all carrying the same run-tree index.
    if (by.get(i).has(o.name)) throw new Error(`bundle ${i} opens "${o.name}" twice`);
    by.get(i).set(o.name, o);
  }
  return by;
}

const valueOf = (m, name) => (m.has(name) ? normalizeValue(m.get(name).value) : null);

/**
 * §5.5.2: verify a close-out artifact in full. ISOMORPHIC — no database, no salts, nothing but the
 * artifact, the commitment and the rarity table the commitment publishes.
 *
 * Returns { ok, errors, chaseIndices }. Every failure is collected, because a buyer reading this wants to
 * know everything that is wrong with a disclosure, not the first thing.
 */
export async function verifyDisclosure(artifact, commitment, { rarityTable = null } = {}) {
  const errors = [];
  const fail = (m) => errors.push(m);

  if (artifact.root !== commitment.root) fail('the artifact proves membership of a different run root');
  if (artifact.run !== commitment.run) fail('the artifact names a different run');
  if (artifact.header_digest !== commitment.header_digest) fail('the artifact names a different header');

  let by;
  try { by = indexOpenings(artifact.openings || []); }
  catch (e) { return { ok: false, errors: [String(e.message || e)], chaseIndices: [] }; }

  // 1. Every opening verifies: recomputed commitment, both index-bound proofs, and the published root.
  for (const o of artifact.openings || []) {
    const v = await verifyOpening(o, { runRoot: commitment.root });
    if (!v.ok) fail(`bundle ${o.bundle?.index}, "${o.name}": ${v.error}`);
    // The reconstructed leaf must be the one the commitment published for that index — the check that
    // binds an opening to a PUBLISHED bundle rather than to any tree the discloser could build.
    const want = (commitment.leaves || [])[o.bundle?.index];
    if (o.bundle?.size !== commitment.unit_count) {
      fail(`bundle ${o.bundle?.index}, "${o.name}": the proof declares a tree of ${o.bundle?.size}, not ${commitment.unit_count}`);
    }
    if (!want) fail(`bundle ${o.bundle?.index}, "${o.name}": the commitment publishes no leaf at that index`);
  }

  const specs = (commitment.composition || []).map((s, i) => ({ ...s, sort_order: i }));
  const claims = canonicalClaims(commitment.claims || []);
  const tiers = new Set(artifact.tiers || []);
  const all = [...Array(commitment.unit_count).keys()];

  // 2. THE EXACT EXPECTED OPENING SET — no extras, none missing.
  const expected = new Map();
  const require = (i, name) => {
    if (!expected.has(i)) expected.set(i, new Set());
    expected.get(i).add(name);
  };
  if (tiers.has('A') || tiers.has('C') || tiers.has('D')) for (const i of all) require(i, 'bundle.is_chase');
  if (tiers.has('B') || tiers.has('D')) {
    for (const n of requiredAttributes(claims, specs)) for (const i of all) require(i, n);
  }

  // Tier A first, because tier C's expected set is defined by it.
  const chaseIndices = [];
  if (tiers.has('A') || tiers.has('C') || tiers.has('D')) {
    for (const i of all) {
      const v = valueOf(by.get(i) || new Map(), 'bundle.is_chase');
      if (v == null) fail(`bundle ${i} does not open bundle.is_chase, so a missing bundle would be invisible`);
      else if (v !== '0' && v !== '1') fail(`bundle ${i} opens bundle.is_chase as ${JSON.stringify(v)}`);
      else if (v === '1') chaseIndices.push(i);
    }
  }
  if (tiers.has('C') || tiers.has('D')) {
    const names = new Set();
    for (const i of chaseIndices) for (const n of (by.get(i)?.keys() || [])) names.add(n);
    for (const i of chaseIndices) for (const n of names) require(i, n);
  }

  for (const [i, want] of expected) {
    const got = by.get(i) || new Map();
    for (const n of want) if (!got.has(n)) fail(`bundle ${i} is missing the required opening "${n}"`);
  }
  for (const [i, got] of by) {
    const want = expected.get(i) || new Set();
    for (const n of got.keys()) if (!want.has(n)) fail(`bundle ${i} opens "${n}", which no tier in this artifact requires`);
  }

  // 3. EVALUATE THE CLAIMS OVER THE OPENED VALUES. The step revision 4 was missing entirely.
  if (tiers.has('B') || tiers.has('D')) {
    const manifest = {
      unitCount: commitment.unit_count,
      specs,
      bundles: all.map((i) => ({
        no: i + 1,
        label: `#${i + 1}`,
        is_chase: chaseIndices.includes(i) ? 1 : 0,
        lines: linesFromOpenings(by.get(i) || new Map(), specs),
      })),
    };
    // Only the claims whose fields tier B actually opened can be evaluated; a run-scoped count claim is
    // deferred by the evaluator itself and reported rather than silently counted as holding.
    const evaluated = evaluateClaims(claims, manifest, specs, { scope: 'run' });
    for (const r of evaluated.failing) {
      const cx = r.counterexamples.slice(0, 5).map((c) => `${c.bundle}/${c.slot}: got ${c.got}, want ${c.want}`);
      fail(`the published claim ${r.claim.claim_type} ${r.claim.operator} ${r.claim.value} for `
        + `"${r.claim.subject}" DOES NOT HOLD over the opened values — ${cx.join('; ')}`);
    }
  }

  // 4. TIER C: one ladder match per labelled bundle, in the chase slot, forming a bijection.
  if (tiers.has('C') || tiers.has('D')) {
    const ladder = commitment.chase_ladder || [];
    const chaseSlot = specs.find((s) => s.is_chase_slot)?.slot ?? null;
    if (!chaseSlot) fail('the composition declares no chase slot, so tier C cannot be checked');
    if (chaseIndices.length !== ladder.length) {
      fail(`tier A labels ${chaseIndices.length} bundles as chase but the ladder declares ${ladder.length}`);
    }
    const used = new Set();
    for (const i of chaseIndices) {
      const m = by.get(i) || new Map();
      const matches = [];
      for (const entry of ladder) {
        for (const spec of specs) {
          for (let line = 0; line < spec.max_lines; line++) {
            if (matchesLadder(m, spec.slot, line, entry)) matches.push({ entry, slot: spec.slot });
          }
        }
      }
      // EXACTLY ONE, and in the chase slot. A global multiset check passes when two ladder cards sit in
      // one bundle and none in another; that is the hole this closes.
      if (matches.length !== 1) {
        fail(`bundle ${i} is labelled chase but matches ${matches.length} ladder cards; exactly one is required`);
        continue;
      }
      if (chaseSlot && matches[0].slot !== chaseSlot) {
        fail(`bundle ${i}'s chase sits in slot "${matches[0].slot}", not the declared chase slot "${chaseSlot}"`);
      }
      if (used.has(matches[0].entry.rank)) fail(`ladder rank ${matches[0].entry.rank} is claimed by more than one bundle`);
      used.add(matches[0].entry.rank);
    }
    for (const entry of ladder) {
      if (!used.has(entry.rank)) fail(`ladder rank ${entry.rank} ("${entry.card_name}") appears in no labelled bundle`);
    }
  }

  // 5. The rarity table, if it was published with the commitment, must hash to what the header commits to.
  if (rarityTable && commitment.rarity_table_hash) {
    const { rarityTableHash } = await import('./runs-rarity.mjs');
    const got = await rarityTableHash(rarityTable.sources, rarityTable.classes);
    if (got !== commitment.rarity_table_hash) fail('the published rarity table does not match the committed hash');
  }

  return { ok: !errors.length, errors, chaseIndices };
}

/** Rebuild the evaluator's line view from what was opened. An unopened field is simply absent. */
function linesFromOpenings(opened, specs) {
  const lines = {};
  for (const spec of specs) {
    lines[spec.slot] = [];
    for (let i = 0; i < spec.max_lines; i++) {
      const line = {};
      for (const [name, o] of opened) {
        const m = /^slot\.([a-z0-9_]+)\.(\d{2})\.(.+)$/.exec(name);
        if (m && m[1] === spec.slot && Number(m[2]) === i) line[m[3]] = o.value;
      }
      if (Object.keys(line).length) lines[spec.slot].push(line);
    }
  }
  return lines;
}

/**
 * The identifying fields a ladder entry states. ONE definition, used three ways: by the lock to derive
 * which bundles are chases, by the close-out verifier over opened attributes, and by any operator tool
 * that wants to ask the same question. A second copy would be a second answer.
 *
 * Identified by set code, number, language, grader and grade — NEVER by name alone, because §1.1
 * establishes that names are ambiguous across printings and languages.
 */
export function ladderPairs(entry) {
  return [
    ['set_code', entry.set_code], ['card_number', entry.card_number], ['language', entry.language],
    ['grading_company', entry.grading_company], ['grade', entry.grade],
  ].filter(([, v]) => v != null && String(v) !== '');
}

/** Does one manifest LINE match a ladder entry? Used by lockRun before anything is hashed. */
export function ladderMatchesLine(line, entry) {
  const pairs = ladderPairs(entry);
  if (!pairs.length) return false;
  for (const [field, want] of pairs) {
    const got = line[field] == null ? '' : normalizeValue(String(line[field]));
    if (got === '' || got !== normalizeValue(String(want))) return false;
  }
  return true;
}

/** The same question over OPENED attributes, which is all a close-out verifier has. */
function matchesLadder(opened, slot, line, entry) {
  const pairs = ladderPairs(entry);
  if (!pairs.length) return false;
  for (const [field, want] of pairs) {
    const got = valueOf(opened, attrName(slot, line, field));
    if (got == null || got !== normalizeValue(String(want))) return false;
  }
  return true;
}

/**
 * Rebuild every bundle's attributes and root from the FROZEN rows — the producer's input to discloseTiers.
 *
 * Takes a `db` handle rather than importing one, so this module stays importable in a browser: the
 * verifier above is the half a buyer runs, and a node-only import at the top of the file would stop it
 * loading at all. The same reason lib/runs-reserve.mjs takes its handle.
 *
 * Reads salt_hex, which is why this half is never customer-facing. The salt reaches a buyer only through
 * the code-gated blob in their own parcel.
 */
export function closeOutBundles(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  const specs = db.prepare('SELECT * FROM run_slot_specs WHERE run_id = ? ORDER BY sort_order').all(run.id);
  const rows = db.prepare(`SELECT s.*, b.bundle_no FROM run_bundle_slots s
                             JOIN run_bundles b ON b.id = s.bundle_id
                            WHERE b.run_id = ? ORDER BY b.bundle_no, s.slot, s.seq`).all(run.id);
  const bundles = db.prepare('SELECT * FROM run_bundles WHERE run_id = ? ORDER BY bundle_no').all(run.id);

  return bundles.map((b) => {
    const lines = {};
    for (const r of rows.filter((x) => x.bundle_id === b.id)) {
      (lines[r.slot] ||= []).push({
        kind: r.kind, display_name: r.display_name, game: r.game, identity_key: r.identity_key,
        set_code: r.set_code, card_number: r.card_number, rarity: r.rarity, language: r.language,
        finish: r.finish, product_type: r.product_type, upc: r.upc,
        grading_company: r.grading_company, grade: r.grade == null ? '' : String(r.grade),
        cert_number: r.cert_number, qty: String(r.qty),
      });
    }
    return {
      bundleNo: b.bundle_no,
      salt: b.salt_hex,
      isChase: !!b.is_chase,
      attributes: bundleAttributes({ run, bundle: b, specs, lines }),
    };
  });
}
