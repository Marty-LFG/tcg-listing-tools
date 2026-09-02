// lib/runs-lock.mjs — §10.4: lock, which is two phases because it cannot be atomic.
//
// Phase 1 is one database transaction and ends at `locked_pending_publish`: the manifest is frozen, every
// cryptographic value is generated, and NOTHING is public. Phase 2 uploads and publishes, and is idempotent
// because everything it publishes was already built and hash-committed in phase 1.
//
// WHERE THE MANIFEST LIVES BEFORE AND AFTER. While a run is draft the answer sheet is `run_reservations`
// joined live to the stock tables (runs-reserve's boundLines), so an edit to a card's name or grade is
// simply picked up. AT LOCK those descriptors are COPIED onto run_bundle_slots and frozen, because the
// stock row may be edited later and the manifest must keep saying what it said when it was hashed. This
// function is the only writer of those frozen rows, which is why boundLines calls itself the live view.
//
// WHY THE CRYPTO HAPPENS BEFORE THE TRANSACTION OPENS. Deriving twenty-five blob keys is twenty-five runs
// of PBKDF2 at 600,000 iterations — well over a second — and every WebCrypto call is async. Awaiting that
// inside an open write transaction would hold SQLite's lock across the whole thing. So the manifest is read
// and validated, the material is computed, and only then does a short transaction re-check and write.
//
// That window is closed by a FINGERPRINT rather than by hope: everything the digest covers is hashed before
// the compute, re-read inside the transaction, and compared. A manifest edited while the keys were being
// derived aborts the lock instead of anchoring a root that describes bundles which have since changed.
// Anchoring is irreversible, so an aborted lock is cheap and a wrong one is permanent.

import { randomBytes } from 'node:crypto';
import {
  bundleAttributes, expectedAttributeNames, normalizeLine, lineSortKey, classifyLine,
  byteCompare, ns, toHex,
} from './runs-canonical.mjs';
import { bundleTree, runTree } from './runs-merkle.mjs';
import { mintCode, canonicalCode, blobKey, codeLeaves, codesCommit } from './runs-codes.mjs';
import { buildBlobFile, blobHash, BLOB_LENGTH } from './runs-blob.mjs';
import { headerDigest } from './runs-header.mjs';
import { claimsCanonical, evaluateClaims, validateClaims } from './runs-claims.mjs';
import { generateGuarantee } from './runs-guarantee.mjs';
import { rarityTableHash, RARITY_TABLE_VERSION } from './runs-rarity.mjs';
import { boundLines, lockBlockers, commitReservations, audit } from './runs-reserve.mjs';
import { ladderMatchesLine, ladderPairs } from './runs-disclose.mjs';

/**
 * The fifteen hashed §4.4 fields, read off a live or frozen row.
 *
 * `set_name` is carried on the row but is NOT one of the fifteen and is never hashed — it is display text
 * that varies by source for the same card, which is exactly why the fifteen are the fifteen.
 */
const lineFrom = (row) => ({
  kind: row.kind,
  display_name: row.display_name,
  game: row.game,
  identity_key: row.identity_key,
  set_code: row.set_code,
  card_number: row.card_number,
  rarity: row.rarity,
  language: row.language,
  finish: row.finish,
  product_type: row.product_type,
  upc: row.upc,
  grading_company: row.grading_company,
  grade: row.grade == null ? '' : String(row.grade),
  cert_number: row.cert_number,
  qty: String(row.qty),
});

/** §4.4 order: populated lines sort byte-wise on their encoded tuple, never by row id. */
function orderLines(rows) {
  return rows
    .map((row) => ({ row, line: lineFrom(row) }))
    .map((e) => ({ ...e, key: safeSortKey(e.line) }))
    .sort((a, b) => byteCompare(a.key, b.key));
}

// A line that will not normalise cannot produce a sort key. It is reported as a problem by validateForLock
// rather than throwing here, so the operator sees every bad row at once instead of one per attempt.
function safeSortKey(line) {
  try { return lineSortKey(normalizeLine(line)); } catch { return ''; }
}

/** Read the whole manifest. No writes, so it is safe to call outside a transaction and again inside one. */
export function collectManifest(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  const specs = db.prepare('SELECT * FROM run_slot_specs WHERE run_id = ? ORDER BY sort_order').all(run.id);
  const bundles = db.prepare('SELECT * FROM run_bundles WHERE run_id = ? ORDER BY bundle_no').all(run.id);
  const ladder = db.prepare('SELECT * FROM run_chase_tiers WHERE run_id = ? ORDER BY rank').all(run.id);
  const claims = db.prepare('SELECT * FROM run_claims WHERE run_id = ? AND published = 1').all(run.id);
  const blockers = lockBlockers(db, run.id);

  const byBundle = new Map(bundles.map((b) => [b.id, { bundle: b, lines: {} }]));
  for (const row of boundLines(db, run.id)) {
    const entry = byBundle.get(row.bundle_id);
    if (entry) (entry.lines[row.slot] ||= []).push(row);
  }
  for (const entry of byBundle.values()) {
    for (const slot of Object.keys(entry.lines)) entry.lines[slot] = orderLines(entry.lines[slot]);
  }
  return { run, specs, bundles, ladder, claims, blockers, byBundle };
}

/**
 * Everything the header digest will cover, as one string.
 *
 * Compared before and after the compute window. It deliberately includes the DESCRIPTORS rather than just
 * row ids: repointing a slot at a different card without changing the row count is exactly the edit this
 * has to catch, and it is the edit an id-only fingerprint would miss.
 */
export function manifestFingerprint(m) {
  let s = ns(String(m.run.public_id)) + ns(String(m.run.edition)) + ns(String(m.run.unit_count))
    + ns(String(m.run.status)) + ns(String(m.run.close_by ?? '')) + ns(String(m.run.sales_close_at ?? ''))
    + ns(String(m.run.unsold_policy ?? '')) + ns(String(m.run.canon_version));
  for (const spec of m.specs) {
    s += ns(spec.slot) + ns(spec.label) + ns(spec.kind) + ns(String(spec.qty_per_bundle))
      + ns(String(spec.max_lines)) + ns(String(spec.singleton)) + ns(String(spec.requires_cert))
      + ns(String(spec.is_chase_slot));
  }
  for (const b of m.bundles) {
    s += ns(String(b.bundle_no)) + ns(String(b.label)) + ns(String(b.seal_serial ?? '')) + ns(String(b.pinned));
    const entry = m.byBundle.get(b.id);
    for (const spec of m.specs) {
      for (const { row, line } of (entry.lines[spec.slot] || [])) {
        s += ns(spec.slot) + ns(String(row.reservation_id));
        for (const v of Object.values(line)) s += ns(v == null ? '' : String(v));
      }
    }
  }
  for (const c of m.ladder) {
    s += ns(String(c.rank)) + ns(String(c.card_name)) + ns(String(c.set_code ?? ''))
      + ns(String(c.card_number ?? '')) + ns(String(c.language ?? ''))
      + ns(String(c.grading_company ?? '')) + ns(String(c.grade ?? ''));
  }
  return s + ns(claimsCanonical(m.claims));
}

/**
 * Every reason a run may not lock, gathered rather than thrown one at a time.
 *
 * ALL PROBLEMS, NOT THE FIRST. An operator fixing a twenty-five bundle manifest one refusal per attempt
 * would spend an afternoon on it, and each attempt re-derives twenty-five keys. The claim failures already
 * carry counterexamples naming the bundle and the cert, so the whole list is actionable in one pass.
 */
export function validateForLock(m) {
  const problems = [];
  const fail = (code, message, detail = null) => problems.push({ code, message, ...(detail ? { detail } : {}) });
  const { run, specs, bundles, ladder, claims, byBundle } = m;

  if (run.status !== 'draft') fail('not_draft', `run ${run.public_id} is ${run.status}, not draft`);
  if (!specs.length) fail('no_composition', 'the run declares no slots');
  if (specs.filter((s) => s.is_chase_slot).length > 1) {
    fail('many_chase_slots', 'more than one slot is marked as the one a chase replaces into');
  }

  // Header fields. Each is inside headerDigest, so a missing one is not a detail to fill in afterwards.
  for (const [col, label] of [['close_by', 'close-by date'], ['sales_close_at', 'sales close'],
    ['unsold_policy', 'unsold policy']]) {
    if (!String(run[col] ?? '').trim()) {
      fail('missing_header_field', `the run has no ${label}, and it is inside the anchored digest`);
    }
  }

  if (bundles.length !== run.unit_count) {
    fail('wrong_bundle_count', `the run declares ${run.unit_count} bundles but holds ${bundles.length}`);
  }
  bundles.forEach((b, i) => {
    if (b.bundle_no !== i + 1) {
      fail('bundle_gap', `bundle numbers must run 1..${run.unit_count} with no gaps; position ${i} holds ${b.bundle_no}`);
    }
    // §5.3 pre-assigns seal serials BEFORE lock because the serial is a COMMITTED attribute — it is inside
    // the bundle's leaf, while the parcel is only physically sealed afterwards.
    if (!String(b.seal_serial ?? '').trim()) {
      fail('no_seal_serial', `bundle ${b.label} has no seal serial, and the serial is a committed attribute`);
    }
  });
  const serials = bundles.map((b) => String(b.seal_serial ?? '').trim()).filter(Boolean);
  if (new Set(serials).size !== serials.length) fail('duplicate_seal_serial', 'two bundles share a seal serial');

  // The per-run equality rule: every bundle holds the same components. Not expressible as an index, since
  // it is a SUM across rows compared against a value in another table.
  const declared = new Set(specs.map((s) => s.slot));
  for (const { bundle, lines } of byBundle.values()) {
    for (const spec of specs) {
      const rows = lines[spec.slot] || [];
      const qty = rows.reduce((n, r) => n + r.row.qty, 0);
      if (qty !== spec.qty_per_bundle) {
        fail('composition_mismatch', `bundle ${bundle.label} holds ${qty} of "${spec.slot}" but the composition says ${spec.qty_per_bundle}`);
      }
      if (rows.length > spec.max_lines) {
        fail('too_many_lines', `bundle ${bundle.label} uses ${rows.length} lines of "${spec.slot}" but max_lines is ${spec.max_lines}`);
      }
      for (const { line } of rows) {
        const c = classifyLine(line);
        if (c.state !== 'populated') {
          fail('malformed_line', `bundle ${bundle.label}, slot "${spec.slot}": ${c.why || 'the line is not populated'}`);
        }
        if (spec.requires_cert && !String(line.cert_number ?? '').trim()) {
          fail('missing_cert', `bundle ${bundle.label}, slot "${spec.slot}" carries no certification number`);
        }
      }
    }
    for (const slot of Object.keys(lines)) {
      if (!declared.has(slot)) {
        fail('undeclared_slot', `bundle ${bundle.label} holds slot "${slot}", which the composition does not declare`);
      }
    }
  }

  // Reservations. The state vocabulary lives in runs-reserve.mjs and is asked for by name, never
  // restated here - an invariant test enforces that, and it caught this file the first time round.
  for (const b of m.blockers) fail(b.code, b.message, b);

  // Ladder ranks are checked here so the refusal names the problem, rather than surfacing as a throw from
  // the header encoder a second and a half later.
  ladder.forEach((c, i) => {
    if (c.rank !== i + 1) {
      fail('ladder_ranks', `chase ladder ranks must be unique and contiguous from 1; position ${i} holds rank ${c.rank}`);
    }
  });

  const v = validateClaims(claims, specs);
  for (const message of v.errors) fail('invalid_claim', message);

  // §11 (d): Japanese contents cannot be omitted by choosing not to mention them. A run holding
  // non-English stock must carry a language claim, or the sentence would be true and misleading at once.
  const languages = new Set();
  for (const { lines } of byBundle.values()) {
    for (const rows of Object.values(lines)) for (const { line } of rows) {
      const l = String(line.language ?? '').trim().toUpperCase();
      if (l) languages.add(l);
    }
  }
  const nonEnglish = [...languages].filter((l) => !['EN', 'ENG', 'ENGLISH'].includes(l));
  if (nonEnglish.length && !claims.some((c) => c.claim_type === 'language')) {
    fail('language_unclaimed', `the run holds ${nonEnglish.join(', ')} stock but makes no language claim`);
  }

  return problems;
}

/**
 * Evaluate the published claims against the manifest as it will be committed.
 *
 * Separate from validateForLock because it needs the assembled attribute view rather than the raw rows, and
 * because its failures are the ones an operator most needs spelled out — this is where a PSA 8 in a run of
 * PSA 10s gets named, with its bundle and its cert.
 */
export function evaluateForLock(m, placement = null) {
  const manifest = {
    unitCount: m.run.unit_count,
    specs: m.specs,
    bundles: m.bundles.map((b) => {
      const entry = m.byBundle.get(b.id);
      return {
        no: b.bundle_no,
        label: b.label,
        // Chase placement is randomised at lock, so a run-scoped chase claim has to be evaluated against
        // the placement about to be committed rather than the draft's zeroes.
        is_chase: placement ? (placement.has(b.bundle_no) ? 1 : 0) : b.is_chase,
        lines: Object.fromEntries(m.specs.map((s) => [s.slot, (entry.lines[s.slot] || []).map((e) => e.line)])),
      };
    }),
  };
  return evaluateClaims(m.claims, manifest, m.specs);
}

/**
 * Which bundles are chases — DERIVED from the manifest, not drawn at random.
 *
 * §10.4 step 2 says "randomise chase bundle numbers", and that instruction is a leftover from a design in
 * which chase cards were dealt at lock. They are not: the physical sequence puts the pick-and-verify pass
 * BEFORE the lock, so by the time this runs each card is already in a specific numbered bundle. Randomly
 * labelling a bundle `is_chase` would therefore label a bundle that need not hold a ladder card at all —
 * a run that locks cleanly, sells out, ships, and then fails its own tier C disclosure at close, which is
 * the worst possible moment to find out.
 *
 * The randomisation that matters happens EARLIER, when stock is dealt to bundle numbers (the `shuffle`
 * strategy). By the time the manifest is assembled, chase placement is already uncorrelated with the
 * rarity spread and the pack mix, which is the independence §5.5.1 depends on.
 *
 * So this asserts, at lock, exactly the bijection the close-out verifier will check: each labelled bundle
 * holds exactly one ladder card, in the run's declared chase slot, and the labels and the ladder are in
 * one-to-one correspondence.
 */
export function deriveChases(bundles, ladder, specs, byBundle) {
  const chaseSlot = specs.find((s) => s.is_chase_slot)?.slot ?? null;
  if (ladder.length && !chaseSlot) {
    throw new Error('the run declares a chase ladder but no slot for a chase to replace into');
  }
  const placement = new Map();
  const claimed = new Map();                                    // ladder rank -> bundle_no
  for (const b of bundles) {
    const lines = byBundle.get(b.id)?.lines || {};
    const hits = [];
    for (const spec of specs) {
      for (const { line } of (lines[spec.slot] || [])) {
        for (const entry of ladder) if (ladderMatchesLine(line, entry)) hits.push({ entry, slot: spec.slot });
      }
    }
    if (!hits.length) continue;
    if (hits.length > 1) {
      throw new Error(`bundle ${b.label} holds ${hits.length} chase ladder cards; claim 3 promises one per bundle`);
    }
    if (hits[0].slot !== chaseSlot) {
      throw new Error(`bundle ${b.label}'s chase sits in slot "${hits[0].slot}", not the declared chase slot "${chaseSlot}"`);
    }
    if (claimed.has(hits[0].entry.rank)) {
      throw new Error(`chase ladder rank ${hits[0].entry.rank} appears in both bundle ${claimed.get(hits[0].entry.rank)} and ${b.label}`);
    }
    claimed.set(hits[0].entry.rank, b.label);
    placement.set(b.bundle_no, hits[0].entry);
  }
  for (const entry of ladder) {
    if (!claimed.has(entry.rank)) {
      // Name the fields that had to match, because the commonest cause is not a missing card at all.
      //
      // A graded card CAN now carry a set code — inventory_items.set_code exists and boundLines COALESCEs
      // it — but only where one was resolved or backfilled. A row whose set name never resolved still
      // commits set_code = '', and a ladder entry stating a code will not match it. So when a ladder
      // entry matches nothing, the commonest cause is a blank set code on the card rather than a missing
      // card, which is why the refusal lists the fields it actually tried.
      const stated = ladderPairs(entry).map(([f, v]) => `${f}=${v}`).join(', ');
      throw new Error(`chase ladder rank ${entry.rank} ("${entry.card_name}") is in no bundle of this run: `
        + `no line matches ${stated || '(the entry states no identifying field at all)'}`);
    }
  }
  return placement;
}

/**
 * Phase 1. Validates, computes every committed value, then writes in one short transaction.
 *
 * The injectable `codes`, `salts` and `nonceFor` exist so the specification's published vectors are
 * reproducible in a test. Production passes none of them and every value comes from a cryptographic source.
 */
export async function lockRunPhase1(db, runId, {
  actor = null, now = null, codes = null, salts = null, nonceFor = null,
} = {}) {
  const before = collectManifest(db, runId);
  const problems = validateForLock(before);
  const { run, specs, bundles, ladder, claims, byBundle } = before;

  // Placement first, because a run-scoped chase claim is evaluated against it — but only once the manifest
  // is structurally sound, since claims over a half-built run bury the problem that caused them.
  let placement = null;
  if (!problems.length) {
    try {
      placement = deriveChases(bundles, ladder, specs, byBundle);
      for (const r of evaluateForLock(before, placement).failing) {
        problems.push({
          code: 'claim_fails',
          message: `the published guarantee claims ${r.claim.claim_type} ${r.claim.operator} ${r.claim.value} `
            + `for "${r.claim.subject}", and the manifest does not`,
          detail: { claim: r.claim, counterexamples: r.counterexamples },
        });
      }
    } catch (e) {
      problems.push({ code: 'chase_placement', message: e.message });
    }
  }
  if (problems.length) {
    const err = new Error(`run ${before.run.public_id} cannot lock: ${problems.length} problem(s)`);
    err.code = 'lock_refused';
    err.problems = problems;
    throw err;
  }

  const fingerprint = manifestFingerprint(before);
  const stamp = now || new Date().toISOString();

  // --- everything hashed, computed outside the transaction ---------------------------------------------

  const prepared = [];
  for (const b of bundles) {
    const entry = byBundle.get(b.id);
    const tier = placement.get(b.bundle_no) ?? null;
    const salt = salts ? salts[b.bundle_no - 1] : toHex(randomBytes(32));
    const code = canonicalCode(codes ? codes[b.bundle_no - 1] : mintCode());
    const lines = Object.fromEntries(specs.map((s) => [s.slot, (entry.lines[s.slot] || []).map((e) => e.line)]));
    const attributes = bundleAttributes({
      run,
      bundle: { ...b, is_chase: placement.has(b.bundle_no) ? 1 : 0 },
      specs,
      lines,
    });
    // §4.5: a verifier derives the expected name set from the published composition and rejects a bundle
    // with a missing, extra or duplicated attribute. Checked on this side too, because the padding silently
    // depends on it — without the check a producer could omit a line and shorten the tree.
    const want = expectedAttributeNames({ specs, withSealSerial: !!String(b.seal_serial ?? '').trim() });
    if (want.join('|') !== attributes.map((a) => a.name).join('|')) {
      throw new Error(`bundle ${b.label} produced an attribute set the published composition does not describe`);
    }
    prepared.push({ bundle: b, entry, tier, salt, code, attributes });
  }

  // DISTINCT SALTS, asserted rather than assumed. Two bundles sharing a salt and holding the same card
  // would produce identical attribute commitments, and one buyer's opening would verify against the
  // other's bundle. randomBytes will not do this; a careless injected fixture would.
  if (new Set(prepared.map((p) => p.salt)).size !== prepared.length) {
    throw new Error('two bundles were minted the same salt');
  }

  const trees = [];
  for (const p of prepared) trees.push(await bundleTree(p.salt, p.attributes));
  const tree = await runTree(trees.map((t) => t.root));

  const leaves = await codeLeaves(prepared.map((p) => p.code), run.public_id);
  const commit = await codesCommit(leaves);
  const keys = [];
  for (const p of prepared) keys.push(await blobKey(p.code, run.public_id));

  const file = await buildBlobFile({
    publicId: run.public_id,
    unitCount: run.unit_count,
    entries: prepared.map((p, i) => ({
      bundleNo: p.bundle.bundle_no,
      bundleSaltHex: p.salt,
      attributes: p.attributes,
      blobKeyHex: keys[i],
    })),
  }, nonceFor);
  const fileHash = await blobHash(file);

  const guaranteeText = generateGuarantee({ specs, claims, unitCount: run.unit_count });
  const tableHash = await rarityTableHash();
  const digest = await headerDigest({
    public_id: run.public_id,
    edition: run.edition,
    unit_count: run.unit_count,
    canon: run.canon_version,
    runRoot: tree.root,
    codesCommit: commit,
    blobHash: fileHash,
    specs,
    chaseLadder: ladder,
    claimsCanonical: claimsCanonical(claims),
    guaranteeText,
    rarityTableVersion: RARITY_TABLE_VERSION,
    rarityTableHash: tableHash,
    closeByDate: run.close_by,
    salesCloseAt: run.sales_close_at,
    unsoldPolicy: run.unsold_policy,
  });

  // --- the write, with the compute window closed -------------------------------------------------------

  db.exec('BEGIN');
  try {
    if (manifestFingerprint(collectManifest(db, runId)) !== fingerprint) {
      // Not a retry loop. The operator changed something, and the right response is to say so rather than
      // silently re-derive against whatever it is now.
      const err = new Error(`run ${run.public_id} was edited while it was being locked; nothing was written`);
      err.code = 'manifest_changed';
      throw err;
    }

    const insertSlot = db.prepare(`INSERT INTO run_bundle_slots
      (bundle_id, slot, seq, reservation_id, kind, item_id, qty, slot_singleton, slot_requires_cert,
       display_name, game, identity_key, set_code, set_name, card_number, rarity, language, finish,
       product_type, upc, grading_company, grade, cert_number, frozen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const setBundle = db.prepare(`UPDATE run_bundles
      SET salt_hex = ?, verify_code = ?, leaf_hash = ?, code_leaf = ?, is_chase = ?, chase_tier_id = ?,
          updated_at = ? WHERE id = ?`);

    prepared.forEach((p, i) => {
      for (const spec of specs) {
        (p.entry.lines[spec.slot] || []).forEach(({ row, line }, seq) => {
          insertSlot.run(p.bundle.id, spec.slot, seq, row.reservation_id, row.kind, row.item_id, row.qty,
            spec.singleton ? 1 : 0, spec.requires_cert ? 1 : 0,
            line.display_name, line.game, line.identity_key, line.set_code, row.set_name ?? null,
            line.card_number, line.rarity, line.language, line.finish, line.product_type, line.upc,
            line.grading_company, row.grade ?? null, line.cert_number, stamp);
        });
      }
      setBundle.run(p.salt, p.code, tree.leaves[i], leaves[i], p.tier ? 1 : 0, p.tier ? p.tier.id : null,
        stamp, p.bundle.id);
    });

    // The bytes themselves, so phase 2 can republish EXACTLY these on a retry. Rebuilding them would
    // mint fresh nonces and produce ciphertext that no longer hashes to the committed blob_hash.
    db.prepare('INSERT OR REPLACE INTO run_blobs (run_id, bytes, sha256) VALUES (?,?,?)')
      .run(run.id, file, fileHash);

    db.prepare(`UPDATE runs SET status = 'locked_pending_publish', locked_at = ?, run_root = ?,
        codes_commit = ?, blob_hash = ?, blob_length = ?, header_digest = ?, guarantee_text = ?,
        rarity_table_version = ?, rarity_table_hash = ?, updated_at = ? WHERE id = ?`)
      .run(stamp, tree.root, commit, fileHash, file.length, digest, guaranteeText,
        RARITY_TABLE_VERSION, tableHash, stamp, run.id);

    commitReservations(db, run.id);

    audit(db, {
      runId: run.id,
      entity: 'runs',
      entityId: run.id,
      action: 'lock_phase1',
      actor,
      after: { header_digest: digest, run_root: tree.root, codes_commit: commit, blob_hash: fileHash },
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return {
    runRoot: tree.root,
    leaves: tree.leaves,
    codesCommit: commit,
    codeLeaves: leaves,
    blobHash: fileHash,
    blobLength: file.length,
    blobFile: file,
    headerDigest: digest,
    guaranteeText,
    rarityTableVersion: RARITY_TABLE_VERSION,
    rarityTableHash: tableHash,
    // Codes are returned so the caller can print the inserts. They are a BEARER SECRET: never log them,
    // never put them in an ungated API response, and never on a parcel exterior.
    bundles: prepared.map((p, i) => ({
      bundle_no: p.bundle.bundle_no,
      label: p.bundle.label,
      is_chase: p.tier ? 1 : 0,
      leaf: tree.leaves[i],
      code: p.code,
    })),
  };
}

/**
 * Phase 2 — idempotent, retryable, and NOT one database transaction, because it makes network calls.
 *
 * Everything it publishes was built and hash-committed in phase 1, which is what makes a retry safe:
 * revision 3 encrypted the blobs here, so a retry produced fresh nonces and therefore different ciphertext
 * than the `blobHash` already inside the anchored digest.
 *
 * The publisher and anchorer are injected. Their real implementations are R2-4 and R2-5; this function owns
 * the ordering and the state transition only, so neither of them can transition a run by itself.
 */
export async function lockRunPhase2(db, runId, { publisher, anchorer, actor = null, now = null } = {}) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  if (run.status === 'locked_published') return { status: run.status, alreadyDone: true };
  if (run.status !== 'locked_pending_publish') {
    throw new Error(`run ${run.public_id} is ${run.status}; phase 2 follows phase 1`);
  }
  if (!run.header_digest) throw new Error(`run ${run.public_id} has no header digest; phase 1 did not complete`);

  const stored = db.prepare('SELECT bytes, sha256 FROM run_blobs WHERE run_id = ?').get(run.id);
  if (!stored) throw new Error(`run ${run.public_id} has no stored blob file; phase 1 did not complete`);
  if (stored.sha256 !== run.blob_hash) {
    throw new Error(`the stored blob file hashes to ${stored.sha256}, not the committed ${run.blob_hash}`);
  }

  const stamp = now || new Date().toISOString();
  const published = await publisher({ db, run, blob: stored.bytes });
  // Verify what was actually published rather than trusting the upload's own success: the artifact a buyer
  // will read is the one that must match, not the one we believe we sent.
  if (published?.blobHash && published.blobHash !== run.blob_hash) {
    throw new Error(`the published blob file hashes to ${published.blobHash}, not the committed ${run.blob_hash}`);
  }
  const anchored = await anchorer({ db, run, digest: run.header_digest });

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE runs SET status = 'locked_published', updated_at = ?
                WHERE id = ? AND status = 'locked_pending_publish'`).run(stamp, run.id);
    audit(db, { runId: run.id, entity: 'runs', entityId: run.id, action: 'lock_phase2', actor,
      after: { published: published ?? null, anchored: anchored ?? null } });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { status: 'locked_published', published, anchored };
}

export { BLOB_LENGTH };
