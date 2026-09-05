// lib/runs-amend.mjs — the amendment ledger and the seal-serial roster. See docs/RUNS_PLAN.md §10.5.
//
// A LOCKED MANIFEST IS NEVER EDITED IN PLACE. If a slab is damaged after lock, or a card turns out to be
// something other than what was committed, the fix is not to correct the record — the record is anchored,
// and correcting it silently is exactly the move the whole design exists to make impossible. Instead an
// amendment RECOMPUTES the tree and publishes a NEW header with its own anchor, and the chain of headers
// is what a buyer sees.
//
// SO THIS TABLE IS APPEND-ONLY, and that is enforced here rather than remembered. Every write is an
// INSERT; nothing in this module updates or deletes a row. An amendment carries the header it succeeds
// (`prior_header`) and the one it creates (`new_header`), so the chain is verifiable by anyone holding
// the published artifacts — a broken link is visible without trusting us.
//
// WHY THE CHAIN MATTERS MORE THAN THE ROW. An earlier revision had the ledger and nothing forcing a
// customer to see it: a buyer verifying against the CURRENT root would get a green tick on a bundle whose
// contents changed after lock. §10.5's answer is that the verification page must surface any amendment
// touching the bundle being verified, and an amended bundle cannot render a plain success state. That is
// R2-6's job; this module's job is to make the chain exist and be unforgeable.
//
// NOT IMPLEMENTED HERE: recomputing the tree, re-encrypting the affected blob entries under a FRESH nonce
// (reusing one on changed plaintext under the same key leaks the XOR of both plaintexts and the GCM
// authentication key), and anchoring the new header. Those are R2-3 and R2-5. What is here is the ledger
// they will write through, built first so the append-only property is settled before anything uses it.
import crypto from 'node:crypto';
import { normalizeValue } from './runs-canonical.mjs';

const nowIso = () => new Date().toISOString();

/** Every amendment for a run, oldest first. The chain reads top to bottom. */
export function amendments(db, runId) {
  return db.prepare(`SELECT id, seq, reason, actor, affected_bundles, prior_header, new_header, amended_at
                       FROM run_amendments WHERE run_id = ? ORDER BY seq`).all(+runId);
}

/** The header a new amendment must succeed: the latest amendment's, or the run's own if there are none. */
export function currentHeader(db, run) {
  const last = db.prepare('SELECT new_header FROM run_amendments WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(run.id);
  return last ? last.new_header : run.header_digest;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Append one amendment.
 *
 * REFUSES, RATHER THAN REPAIRING, in every case below. An amendment is the mechanism for admitting that
 * something changed after it was anchored, so an amendment written loosely is worse than none — it would
 * be a record that looks like an audit trail and is not one.
 *
 * `affectedBundles` is stored as §10.5 encodes it for the header: a comma-joined ASCENDING list of
 * zero-padded three-digit numbers. Sorted and padded here so the stored value and the hashed value cannot
 * differ, which is the same reasoning claimsCanonical follows.
 */
export function appendAmendment(db, run, {
  reason, newHeader, affectedBundles = [], actor = null, before = null, after = null,
} = {}) {
  if (!run || !run.id) throw new Error('an amendment needs a run');
  if (run.status === 'draft') {
    throw new Error(`run ${run.public_id} is still a draft — edit the manifest directly; an amendment exists to change what has already been anchored`);
  }
  const why = normalizeValue(String(reason || ''));
  if (!why) throw new Error('an amendment must say why; an unexplained change to an anchored manifest is exactly what this ledger exists to prevent');

  const prior = currentHeader(db, run);
  if (!prior || !HEX64.test(String(prior))) {
    throw new Error(`run ${run.public_id} has no header to amend — it was never locked`);
  }
  const next = String(newHeader || '').toLowerCase();
  if (!HEX64.test(next)) throw new Error('an amendment must carry the new header digest it creates, as 64 lowercase hex characters');
  if (next === prior) throw new Error('the new header equals the one it replaces, so nothing was actually amended');

  const nums = [...new Set(affectedBundles.map((n) => Math.round(+n)))].sort((a, b) => a - b);
  if (!nums.length) throw new Error('an amendment must name the bundles it affects — "none" is not an amendment');
  for (const n of nums) {
    if (!(n >= 1 && n <= run.unit_count)) throw new Error(`bundle ${n} is not in ${run.public_id}, which has ${run.unit_count}`);
  }
  const affected = nums.map((n) => String(n).padStart(3, '0')).join(',');

  const last = db.prepare('SELECT MAX(seq) s FROM run_amendments WHERE run_id = ?').get(run.id).s;
  const seq = (last || 0) + 1;

  // ONE INSERT, and no UPDATE anywhere in this module. UNIQUE(run_id, seq) makes a concurrent second
  // amendment at the same sequence a constraint failure rather than a silent overwrite.
  db.prepare(`INSERT INTO run_amendments (run_id, seq, reason, actor, affected_bundles,
                                          before_json, after_json, prior_header, new_header, amended_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(run.id, seq, why, actor, affected,
      JSON.stringify(before ?? null), JSON.stringify(after ?? null), prior, next, nowIso());

  return { seq, prior_header: prior, new_header: next, affected_bundles: affected };
}

/**
 * Walk the chain and report whether it holds.
 *
 * A verifier does this with nothing but the published artifacts, which is the point: if a link is broken
 * — a header that succeeds something other than its predecessor, a gap in the sequence — it is visible
 * without trusting the party that wrote it.
 */
export function verifyChain(db, run) {
  const rows = amendments(db, run.id);
  const problems = [];
  let expect = run.header_digest;
  rows.forEach((a, i) => {
    if (a.seq !== i + 1) problems.push(`amendment ${a.seq} is out of sequence; expected ${i + 1}`);
    if (a.prior_header !== expect) {
      problems.push(`amendment ${a.seq} claims to succeed ${String(a.prior_header).slice(0, 12)}… but the chain is at ${String(expect).slice(0, 12)}…`);
    }
    expect = a.new_header;
  });
  return { ok: problems.length === 0, head: expect, links: rows.length, problems };
}

// --- seal serials -------------------------------------------------------------------------------------
//
// THE SEAL SERIAL IS A COMMITTED ATTRIBUTE. It is inside the bundle's leaf and therefore inside runRoot,
// so it must be known BEFORE lock — yet a parcel is only sealed after packing. That is the circular
// dependency the physical sequence resolves: serials are pre-assigned here, at step 3, and the lock at
// step 4 hashes them.
//
// WHAT MUST BE UNPREDICTABLE IS THE MAPPING, NOT THE SERIAL. A sequentially numbered commercial seal roll
// is fine provided the assignment of physical seals to bundle numbers is random — and provided the roll is
// LARGER than the run, so the set of serials in play is not derivable either by a buyer holding one
// parcel. Both are enforced below.
//
// The seal carries the serial on the OUTSIDE of the parcel, deliberately. The verification code never
// does: a code is a bearer secret, and on a parcel exterior it is exposed to every courier and anyone who
// photographs it in transit.

// THE SHAPE OF A REAL SEAL, not the shape of a generated one.
//
// This was /^[0-9a-f]{16}$/, which is what a serial looks like when you MINT it. We buy them: the first
// batch is BK-7WMHC, BK-VYNVY, BK-ATDMR - a brand prefix and five alphanumerics, printed on holographic
// tamper-evident stock. Every one of them was refused, so the whole batch was unusable, and the refusal
// only surfaced during a rehearsal where the obvious reading was that the TEST data was wrong.
//
// The old pattern was never the security property. The comment above says so: what has to be
// unpredictable is the MAPPING, and the roll has to exceed the run. Both are enforced below and neither
// cares what the serial looks like. So this checks the two things that are actually true of a serial
// printed on a sticker - it is ASCII the eye can transcribe, and it is short enough to be on a label -
// and nothing else.
//
// Hyphens inside, never at either end, so "BK-" alone or a trailing dash is caught as the typo it is.
const SERIAL_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const SERIAL_MIN = 3;
const SERIAL_MAX = 32;

/**
 * The comparison key for "is this the same seal".
 *
 * Case-insensitive, because the serial is STORED exactly as printed (see below) and a roll typed as
 * BK-7WMHC once and bk-7wmhc once is one sticker entered twice, not two stickers. SQLite's default
 * collation is BINARY, so the UNIQUE index on seal_serial would happily accept both spellings - this is
 * the only thing standing between a transcription slip and two parcels claiming one seal.
 */
const serialKey = (s) => String(s).toLowerCase();

/**
 * Assign seal serials to every bundle of a run, at random.
 *
 * `roll` is the serials physically available. It must be strictly larger than the run — if it were the
 * same size, a buyer who knows the roll knows the whole set in play, and with it how many parcels exist
 * and which serials are not theirs.
 */
export function assignSealSerials(db, run, roll = [], { actor = null } = {}) {
  if (run.status !== 'draft') {
    throw new Error(`run ${run.public_id} is ${run.status}; serials are committed and cannot be reassigned`);
  }
  // STORED EXACTLY AS PRINTED. The serial is a committed attribute - it is inside the bundle's leaf and
  // therefore inside runRoot - and it is the one committed value a buyer can read off the OUTSIDE of
  // their own parcel. Folding its case would commit "bk-7wmhc" against a sticker that says "BK-7WMHC"
  // and leave someone checking their parcel against the record wondering which of the two was wrong.
  // Trimmed, because that is a copy-paste artefact rather than a difference; nothing else is touched.
  const seen = new Map();
  for (const entry of roll) {
    const serial = String(entry ?? '').trim();
    if (!seen.has(serialKey(serial))) seen.set(serialKey(serial), serial);
  }
  const serials = [...seen.values()];

  const bad = serials.filter((s) => s.length < SERIAL_MIN || s.length > SERIAL_MAX || !SERIAL_RE.test(s));
  if (bad.length) {
    throw new Error(`${bad.length} serial(s) are not ${SERIAL_MIN}-${SERIAL_MAX} letters, digits and inner `
      + `hyphens, starting with "${bad[0]}"`);
  }
  if (serials.length !== roll.length) throw new Error('the roll contains a duplicate serial, so two parcels could carry the same one');
  if (serials.length <= run.unit_count) {
    throw new Error(`the roll has ${serials.length} serial(s) for ${run.unit_count} bundle(s); it must be LARGER than the run, or a buyer who knows the roll knows the whole set in play`);
  }

  const taken = new Set(db.prepare('SELECT seal_serial FROM run_bundles WHERE seal_serial IS NOT NULL')
    .all().map((r) => serialKey(r.seal_serial)));
  const clash = serials.filter((s) => taken.has(serialKey(s)));
  if (clash.length) throw new Error(`serial ${clash[0]} is already assigned to another bundle`);

  // Fisher-Yates over crypto.randomInt. The randomness IS the security property here: a contiguous or
  // predictable mapping would let anyone who saw one parcel derive the rest.
  const pool = [...serials];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const bundles = db.prepare('SELECT id, bundle_no FROM run_bundles WHERE run_id = ? ORDER BY bundle_no').all(run.id);
  db.exec('BEGIN');
  try {
    const upd = db.prepare(`UPDATE run_bundles SET seal_serial = ?, updated_at = datetime('now') WHERE id = ?`);
    bundles.forEach((b, i) => upd.run(pool[i], b.id));
    db.prepare(`INSERT INTO run_audit (run_id, entity, action, actor, after_json, note)
                VALUES (?, 'run_bundles', 'seal_serials', ?, ?, ?)`)
      .run(run.id, actor, JSON.stringify({ assigned: bundles.length, roll_size: serials.length }),
        // The MAPPING is deliberately not written to the audit note. It is as sensitive as the manifest,
        // and the audit surface is read more widely than the manifest route is.
        `${bundles.length} serial(s) assigned at random from a roll of ${serials.length}`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return { assigned: bundles.length, roll_size: serials.length, spare: serials.length - bundles.length };
}

/** Are all serials in place? The lock asks this; §10.4's step 3 is what satisfies it. */
export function sealSerialStatus(db, run) {
  const row = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN seal_serial IS NULL OR seal_serial = '' THEN 1 ELSE 0 END) missing
                            FROM run_bundles WHERE run_id = ?`).get(run.id);
  return { bundles: row.n, missing: row.missing || 0, ready: row.n > 0 && (row.missing || 0) === 0 };
}
