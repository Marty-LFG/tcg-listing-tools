// lib/runs-public.mjs — §5.2: the ONLY module allowed to build a customer-facing payload.
//
// THREE LAYERS OF DEFENCE AGAINST A PRICE REACHING A BUYER, strongest first, because guardrail (a) is not
// a style rule — a mystery bundle that quotes a value per bundle is making a representation about what is
// inside it, and the whole product depends on never doing that.
//
//   1. THE VIEWS. This module names only v_run_public_run, v_run_public_bundle and v_run_public_slot. A
//      SELECT * from them cannot return a price because no price column is in them. A filter can be
//      forgotten; a column that does not exist cannot be. An invariant test asserts this file never names
//      a base table.
//   2. assertNoMoney, below, which THROWS rather than strips. A silently stripped field is a bug nobody
//      sees; a thrown one is a bug someone fixes.
//   3. A value-level test that seeds a known cost and asserts the number itself never appears in a
//      serialised payload — because the realistic leak is a value typed into a free-text note, which no
//      key-name check would catch.
//
// AND THE SECOND RULE, WHICH IS NOT ABOUT MONEY. Contents are never published before a run closes. The
// commitment carries hashes and counts; it names no card. Two guards enforce it: the contents reader
// refuses unless the run is closed, and the commitment builder never reads the slot view at all.

import { ns } from './runs-canonical.mjs';
import { headerDigest } from './runs-header.mjs';
import { claimsCanonical } from './runs-claims.mjs';

/** The artifact schema version. OUTSIDE headerDigest, and therefore untrusted — see §5.1. */
export const ARTIFACT_VERSION = 2;

// Statuses in which a run's CONTENTS may be published. Everything before this is pre-sale or in flight,
// and §5.5 additionally requires a delivery grace period past the final dispatch before close-out.
const DISCLOSABLE = new Set(['closed', 'disclosed']);

// Matched on whole key SEGMENTS, not as a substring, and the reason is concrete: a substring test for
// "comp" flags `composition`, which is one of the commitment's own required fields, and a payload that
// throws on its own valid shape is a check nobody can keep.
//
// Bare `value` and `amount` are deliberately ABSENT. `run_claims.value` is a claim's value — "PSA",
// "art:1,packs:3,slab:1" — and is published by design. Every money column in this schema is named
// `*_cents` (unit_price_cents, cost_cents, value_cents, target_cents), so `cents` catches all of them
// including `value_cents`, without flagging the field that legitimately carries a claim.
const MONEY_SEGMENTS = new Set([
  'cents', 'price', 'prices', 'cost', 'costs', 'comp', 'comps', 'paid',
  'profit', 'margin', 'rrp', 'aud', 'usd', 'money',
]);
// camelCase and snake_case both reduce to the same segment list, so `unitPriceCents` is caught too.
const segmentsOf = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/);

// A bare currency amount in free text: $129, 129.00 AUD, AU$ 129. Deliberately loose — a false positive
// here costs a developer one minute, and a false negative puts a number on a customer's page.
const MONEY_TEXT = /(?:\$|\bAUD?\b|\bUSD\b)\s*\d|\d+(?:\.\d{2})\s*(?:AUD?|USD|dollars?)\b/i;

/**
 * Deep-walk a payload and THROW on anything that looks like money.
 *
 * Throws rather than strips, and reports the path, because the point is that the offending field should
 * never have been assembled — silently removing it would leave the bug in place for the next payload.
 */
export function assertNoMoney(obj, path = '$') {
  if (obj == null) return obj;
  if (typeof obj === 'string') {
    if (MONEY_TEXT.test(obj)) {
      throw new Error(`${path} carries what reads as a monetary amount: ${JSON.stringify(obj.slice(0, 80))}`);
    }
    return obj;
  }
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoMoney(v, `${path}[${i}]`));
    return obj;
  }
  for (const [k, v] of Object.entries(obj)) {
    const hit = segmentsOf(k).find((seg) => MONEY_SEGMENTS.has(seg));
    if (hit) throw new Error(`${path}.${k} is a money-shaped key ("${hit}") and must not reach a public payload`);
    assertNoMoney(v, `${path}.${k}`);
  }
  return obj;
}

const runView = (db, key) => {
  const k = String(key);
  return /^\d+$/.test(k)
    ? db.prepare('SELECT * FROM v_run_public_run WHERE id = ?').get(+k)
    : db.prepare('SELECT * FROM v_run_public_run WHERE public_id = ?').get(k);
};

/**
 * The header fields, in the shape lib/runs-header.mjs takes.
 *
 * Composition, ladder and claims come from their own tables rather than the views: they are PUBLIC by
 * design — the ladder in particular must be public before any sale, or `is_chase` would be a claim about
 * a term we could reinterpret afterwards — and none of them carries a money column.
 */
export function headerFields(db, key) {
  const run = runView(db, key);
  if (!run) throw new Error(`no such run: ${key}`);
  if (!run.header_digest) throw new Error(`run ${run.public_id} is not locked; it has no header`);
  const specs = db.prepare(`SELECT slot, label, kind, qty_per_bundle, max_lines, singleton, requires_cert,
                                   is_chase_slot, sort_order
                              FROM run_slot_specs WHERE run_id = ? ORDER BY sort_order`).all(run.id);
  const ladder = db.prepare(`SELECT rank, card_name, set_code, card_number, language, grading_company, grade
                               FROM run_chase_tiers WHERE run_id = ? ORDER BY rank`).all(run.id);
  const claims = db.prepare(`SELECT claim_type, subject, operator, value
                               FROM run_claims WHERE run_id = ? AND published = 1`).all(run.id);
  return {
    run,
    specs,
    ladder,
    claims,
    header: {
      public_id: run.public_id,
      edition: run.edition,
      unit_count: run.unit_count,
      canon: run.canon_version,
      runRoot: run.run_root,
      codesCommit: run.codes_commit,
      blobHash: run.blob_hash,
      specs,
      chaseLadder: ladder,
      claimsCanonical: claimsCanonical(claims),
      guaranteeText: run.guarantee_text,
      rarityTableVersion: run.rarity_table_version,
      rarityTableHash: run.rarity_table_hash,
      closeByDate: run.close_by,
      salesCloseAt: run.sales_close_at,
      unsoldPolicy: run.unsold_policy,
    },
  };
}

/**
 * §5.2 the commitment — published ONCE, at lock, before a single bundle is sold.
 *
 * PUBLISHED EXACTLY ONCE IS A SECURITY PROPERTY, not tidiness. Were it reissued as bundles shipped — even
 * only to flip a boolean — an observer archiving successive versions could diff them and identify which
 * bundle changed, and shipping order correlates with sale order. That is why no per-bundle state appears
 * here at all, and why an amendment publishes a separate new artifact rather than rewriting this one.
 *
 * Merkle proofs are not published because every proof derives from `leaves` and `code_leaves`, which are.
 */
export function commitment(db, key, { rarityTable = null, anchors = [] } = {}) {
  const { run, specs, ladder, claims, header } = headerFields(db, key);
  const bundles = db.prepare(`SELECT bundle_no, leaf_hash, code_leaf FROM v_run_public_bundle
                                WHERE run_id = ? ORDER BY bundle_no`)
    .all(run.id);
  if (bundles.length !== run.unit_count) {
    throw new Error(`run ${run.public_id} has ${bundles.length} bundles but declares ${run.unit_count}`);
  }
  const missing = bundles.find((b) => !b.leaf_hash);
  if (missing) throw new Error(`bundle ${missing.bundle_no} has no leaf hash; the run is not fully locked`);

  const out = {
    v: ARTIFACT_VERSION,
    run: run.public_id,
    edition: run.edition,
    unit_count: run.unit_count,
    canon: run.canon_version,
    header_digest: run.header_digest,
    root: run.run_root,
    codes_commit: run.codes_commit,
    code_leaves: bundles.map((b) => b.code_leaf),
    blob_hash: run.blob_hash,
    blob_length: run.blob_length,
    leaves: bundles.map((b) => b.leaf_hash),
    composition: specs.map((s) => ({
      slot: s.slot, label: s.label, kind: s.kind, qty_per_bundle: s.qty_per_bundle,
      max_lines: s.max_lines, singleton: !!s.singleton, requires_cert: !!s.requires_cert,
      is_chase_slot: !!s.is_chase_slot,
    })),
    chase_ladder: ladder,
    claims,
    guarantee: run.guarantee_text,
    rarity_table_version: run.rarity_table_version,
    rarity_table_hash: run.rarity_table_hash,
    ...(rarityTable ? { rarity_table: rarityTable } : {}),
    close_by: run.close_by,
    sales_close_at: run.sales_close_at,
    unsold_policy: run.unsold_policy,
    // OUTSIDE the digest, because a digest cannot contain the thing that anchors it. A verifier must
    // treat this as untrusted and check each receipt independently.
    anchors,
  };
  return assertNoMoney(out);
}

/**
 * Recompute headerDigest from a commitment and compare it to the one the commitment carries.
 *
 * §6 makes this the verifier's first act, and it is what makes every other field in the artifact
 * trustworthy: the ladder, the guarantee sentence, the composition and the unsold policy are only as good
 * as the digest that covers them.
 */
export async function verifyCommitment(c) {
  if (c.v !== ARTIFACT_VERSION) throw new Error(`artifact version ${c.v} is not implemented`);
  const recomputed = await headerDigest({
    public_id: c.run,
    edition: c.edition,
    unit_count: c.unit_count,
    canon: c.canon,
    runRoot: c.root,
    codesCommit: c.codes_commit,
    blobHash: c.blob_hash,
    specs: (c.composition || []).map((s, i) => ({ ...s, sort_order: i })),
    chaseLadder: c.chase_ladder || [],
    claimsCanonical: claimsCanonical(c.claims || []),
    guaranteeText: c.guarantee,
    rarityTableVersion: c.rarity_table_version,
    rarityTableHash: c.rarity_table_hash,
    closeByDate: c.close_by,
    salesCloseAt: c.sales_close_at,
    unsoldPolicy: c.unsold_policy,
  });
  if (recomputed !== c.header_digest) {
    throw new Error(`the commitment's fields hash to ${recomputed}, not the header_digest it carries`);
  }
  if ((c.leaves || []).length !== c.unit_count) throw new Error('the commitment publishes the wrong number of leaves');
  if ((c.code_leaves || []).length !== c.unit_count) throw new Error('the commitment publishes the wrong number of code leaves');
  return recomputed;
}

/**
 * The contents of a closed run, from the slot view.
 *
 * GATED ON STATUS, which is the second guard rather than the only one: the commitment builder above never
 * reads this view at all, so contents cannot reach a pre-close artifact even if this check were wrong.
 */
export function publicContents(db, key) {
  const run = runView(db, key);
  if (!run) throw new Error(`no such run: ${key}`);
  if (!DISCLOSABLE.has(run.status)) {
    const err = new Error(`run ${run.public_id} is ${run.status}; contents are not published before a run closes`);
    err.code = 'not_closed';
    throw err;
  }
  const rows = db.prepare(`SELECT s.* FROM v_run_public_slot s
                             JOIN v_run_public_bundle b ON b.id = s.bundle_id
                            WHERE b.run_id = ? ORDER BY b.bundle_no, s.slot, s.seq`).all(run.id);
  return assertNoMoney(rows.map((r) => ({ ...r })));
}

/** The bundle list a page renders: numbers, labels and leaves. No state, no serial, no code, no salt. */
export function publicBundles(db, key) {
  const run = runView(db, key);
  if (!run) throw new Error(`no such run: ${key}`);
  return db.prepare('SELECT bundle_no, label, leaf_hash FROM v_run_public_bundle WHERE run_id = ? ORDER BY bundle_no')
    .all(run.id);
}

/** A stable digest of a published artifact, so a mirror can be compared byte-for-byte. */
export const artifactCanonical = (obj) => ns(JSON.stringify(obj));
