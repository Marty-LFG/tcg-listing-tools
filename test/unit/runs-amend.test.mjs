// test/unit/runs-amend.test.mjs — the amendment ledger and the seal-serial roster (lib/runs-amend.mjs).
//
// THE PROPERTY THIS FILE PINS IS "APPENDS AND NEVER MUTATES". A locked manifest is anchored; correcting a
// record in place is precisely the move the design exists to make impossible, so a fix has to become a
// NEW header succeeding the old one, with the chain readable by anyone holding the published artifacts.
// A broken link must be visible without trusting the party that wrote it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import {
  amendments, currentHeader, appendAmendment, verifyChain, assignSealSerials, sealSerialStatus,
} from '../../lib/runs-amend.mjs';

const db = openDbAt(tmpFile('runs-amend.db'));

const hex = (n) => crypto.randomBytes(n).toString('hex');
let runN = 0;

// A run that has been locked, as far as this module can tell: it carries a header digest and a status
// past draft. lockRun (R2-3) is what really puts it there.
function mkRun({ status = 'locked_published', units = 3, header = hex(32) } = {}) {
  const k = ++runN;
  const pid = `DEV-A${k}`;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, header_digest, run_root, locked_at)
              VALUES (?,?,?,'dev',?,?,?,?,?)`)
    .run(pid, k, `Amend ${k}`, units, status,
      status === 'draft' ? null : header, status === 'draft' ? null : hex(32),
      status === 'draft' ? null : new Date().toISOString());
  const run = db.prepare('SELECT * FROM runs WHERE public_id = ?').get(pid);
  for (let n = 1; n <= units; n++) {
    db.prepare('INSERT INTO run_bundles (run_id, bundle_no, label) VALUES (?,?,?)').run(run.id, n, `${pid}-${String(n).padStart(3, '0')}`);
  }
  return run;
}

describe('an amendment appends, and never mutates', () => {
  it('records the header it succeeds and the one it creates', () => {
    const run = mkRun();
    const next = hex(32);
    const a = appendAmendment(db, run, { reason: 'slab damaged in transit', newHeader: next, affectedBundles: [2] });
    assert.equal(a.seq, 1);
    assert.equal(a.prior_header, run.header_digest);
    assert.equal(a.new_header, next);
    assert.equal(amendments(db, run.id).length, 1);
  });

  it('chains: the second amendment succeeds the FIRST amendment, not the original header', () => {
    const run = mkRun();
    const h1 = hex(32), h2 = hex(32);
    appendAmendment(db, run, { reason: 'one', newHeader: h1, affectedBundles: [1] });
    const second = appendAmendment(db, run, { reason: 'two', newHeader: h2, affectedBundles: [3] });
    assert.equal(second.seq, 2);
    assert.equal(second.prior_header, h1, 'the chain moves forward, it does not fork from the original');
    assert.equal(currentHeader(db, run), h2);
  });

  it('leaves every earlier row byte-identical — that is what append-only MEANS', () => {
    const run = mkRun();
    appendAmendment(db, run, { reason: 'first', newHeader: hex(32), affectedBundles: [1] });
    const before = JSON.stringify(amendments(db, run.id));
    appendAmendment(db, run, { reason: 'second', newHeader: hex(32), affectedBundles: [2] });
    const after = amendments(db, run.id);
    assert.equal(JSON.stringify(after.slice(0, 1)), before, 'appending changed an existing row');
    assert.equal(after.length, 2);
  });

  it('stores affected bundles as the header encodes them — ascending, zero-padded, comma-joined', () => {
    const run = mkRun({ units: 25 });
    const a = appendAmendment(db, run, { reason: 'three cards swapped', newHeader: hex(32), affectedBundles: [13, 2, 7, 2] });
    // Sorted, padded and de-duplicated here so the stored value and the hashed value cannot differ —
    // the same reasoning claimsCanonical follows.
    assert.equal(a.affected_bundles, '002,007,013');
  });
});

describe('what an amendment refuses', () => {
  it('a draft run — edit the manifest instead', () => {
    const run = mkRun({ status: 'draft' });
    assert.throws(() => appendAmendment(db, run, { reason: 'x', newHeader: hex(32), affectedBundles: [1] }),
      /still a draft/);
  });

  it('no reason — an unexplained change to an anchored manifest is what this ledger exists to prevent', () => {
    const run = mkRun();
    assert.throws(() => appendAmendment(db, run, { reason: '   ', newHeader: hex(32), affectedBundles: [1] }),
      /must say why/);
  });

  it('a header that is not a digest, or is the one it claims to replace', () => {
    const run = mkRun();
    assert.throws(() => appendAmendment(db, run, { reason: 'x', newHeader: 'nope', affectedBundles: [1] }), /64 lowercase hex/);
    assert.throws(() => appendAmendment(db, run, { reason: 'x', newHeader: run.header_digest.toUpperCase(), affectedBundles: [1] }),
      /nothing was actually amended/, 'case-folded, so the same digest in capitals is still the same digest');
  });

  it('naming no bundles — "none" is not an amendment', () => {
    const run = mkRun();
    assert.throws(() => appendAmendment(db, run, { reason: 'x', newHeader: hex(32), affectedBundles: [] }), /must name the bundles/);
  });

  it('a bundle the run does not have', () => {
    const run = mkRun({ units: 3 });
    assert.throws(() => appendAmendment(db, run, { reason: 'x', newHeader: hex(32), affectedBundles: [4] }), /is not in DEV-/);
  });
});

describe('the chain is checkable without trusting whoever wrote it', () => {
  it('verifies a good chain', () => {
    const run = mkRun();
    const h1 = hex(32), h2 = hex(32);
    appendAmendment(db, run, { reason: 'one', newHeader: h1, affectedBundles: [1] });
    appendAmendment(db, run, { reason: 'two', newHeader: h2, affectedBundles: [2] });
    const v = verifyChain(db, run);
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    assert.equal(v.head, h2);
    assert.equal(v.links, 2);
  });

  it('and CATCHES a link that was tampered with in the database', () => {
    const run = mkRun();
    appendAmendment(db, run, { reason: 'one', newHeader: hex(32), affectedBundles: [1] });
    appendAmendment(db, run, { reason: 'two', newHeader: hex(32), affectedBundles: [2] });
    // Reach past the module and rewrite a link, which is the whole scenario the chain defends against.
    db.prepare('UPDATE run_amendments SET prior_header = ? WHERE run_id = ? AND seq = 2').run(hex(32), run.id);
    const v = verifyChain(db, run);
    assert.equal(v.ok, false);
    assert.match(v.problems[0], /claims to succeed/);
  });

  it('an unamended run is a chain of length zero, headed by its own digest', () => {
    const run = mkRun();
    const v = verifyChain(db, run);
    assert.equal(v.ok, true);
    assert.equal(v.links, 0);
    assert.equal(v.head, run.header_digest);
  });
});

// The serial is a COMMITTED attribute — inside the bundle's leaf and so inside runRoot — which is why it
// has to exist before lock even though the parcel is sealed after. What must be unpredictable is the
// MAPPING, not the serial: a sequentially numbered commercial roll is fine if the assignment is random.
describe('seal serials, pre-assigned before lock', () => {
  const roll = (n, seed = 0) => Array.from({ length: n }, (_, i) => (seed * 1000 + i + 1).toString(16).padStart(16, '0'));

  it('assigns one to every bundle', () => {
    const run = mkRun({ status: 'draft', units: 3 });
    const r = assignSealSerials(db, run, roll(10, 1));
    assert.equal(r.assigned, 3);
    assert.equal(r.spare, 7);
    const s = sealSerialStatus(db, run);
    assert.deepEqual(s, { bundles: 3, missing: 0, ready: true });
  });

  it('REFUSES a roll no larger than the run', () => {
    const run = mkRun({ status: 'draft', units: 3 });
    // Same size means a buyer who knows the roll knows the whole set in play — how many parcels exist,
    // and which serials are not theirs.
    assert.throws(() => assignSealSerials(db, run, roll(3, 2)), /must be LARGER than the run/);
  });

  it('refuses a malformed or duplicated serial', () => {
    const run = mkRun({ status: 'draft', units: 2 });
    assert.throws(() => assignSealSerials(db, run, ['has a space', ...roll(5, 3)]), /letters, digits/);
    const dupes = roll(5, 4);
    assert.throws(() => assignSealSerials(db, run, [...dupes, dupes[0]]), /duplicate serial/);
  });

  // --- the seals we actually bought ---------------------------------------------------------------
  //
  // The first physical batch is BK- plus five alphanumerics on holographic tamper-evident stock. The
  // pattern here used to be /^[0-9a-f]{16}$/ - the shape of a serial you MINT rather than one you buy -
  // and it rejected all twelve, which made the whole batch unusable. It surfaced during a rehearsal
  // where the obvious reading was that the test data was wrong rather than the rule.
  const BATCH = ['BK-7WMHC', 'BK-VYNVY', 'BK-ATDMR', 'BK-HH793', 'BK-VNRHP', 'BK-XGVPD',
    'BK-GEUF6', 'BK-PVJMV', 'BK-9NM3T', 'BK-ENKWR', 'BK-34U4A', 'BK-EKXTX'];

  it('accepts the real batch, and stores each serial EXACTLY as it is printed', () => {
    // The serial is a committed attribute, inside the leaf and therefore inside runRoot - and it is the
    // one committed value a buyer can read off the OUTSIDE of their parcel. Folding its case would
    // commit "bk-7wmhc" against a sticker that says "BK-7WMHC", and leave somebody checking one against
    // the other wondering which was wrong.
    const run = mkRun({ status: 'draft', units: 4 });
    const r = assignSealSerials(db, run, BATCH);
    assert.equal(r.assigned, 4);
    assert.equal(r.roll_size, 12);

    const stored = db.prepare('SELECT seal_serial FROM run_bundles WHERE run_id = ? ORDER BY bundle_no')
      .all(run.id).map((x) => x.seal_serial);
    for (const s of stored) {
      assert.ok(BATCH.includes(s), `${s} is not one of the printed serials, character for character`);
    }
    assert.equal(new Set(stored).size, 4, 'two bundles got the same sticker');
  });

  it('and treats one sticker typed twice in different cases as one sticker', () => {
    // SQLite's default collation is BINARY, so the UNIQUE index on seal_serial would accept both
    // spellings happily. This check is the only thing between a transcription slip and two parcels
    // claiming the same seal.
    const run = mkRun({ status: 'draft', units: 2 });
    assert.throws(
      () => assignSealSerials(db, run, ['BK-AAAAA', 'bk-aaaaa', 'BK-BBBBB', 'BK-CCCCC']),
      /duplicate serial/,
    );
  });

  it('and refuses a serial already used on another run whatever case it is typed in', () => {
    const a = mkRun({ status: 'draft', units: 2 });
    assignSealSerials(db, a, ['BK-QQQQQ', 'BK-RRRRR', 'BK-SSSSS']);

    // READ BACK WHICH ONE ACTUALLY LANDED. The roll is deliberately larger than the run and the mapping
    // is random, so one of the three is spare - and asserting against a fixed serial made this test fail
    // one run in three, whenever the spare happened to be the one being asserted. A flaky test on a
    // uniqueness guard is worse than none: it teaches you to re-run until it passes.
    const landed = db.prepare('SELECT seal_serial FROM run_bundles WHERE run_id = ?').all(a.id)[0].seal_serial;
    assert.ok(landed, 'nothing was assigned');

    const b = mkRun({ status: 'draft', units: 2 });
    assert.throws(
      () => assignSealSerials(db, b, [landed.toLowerCase(), 'BK-TTTTT', 'BK-UUUUU']),
      /already assigned/,
      `${landed} typed in lower case was accepted on a second run`,
    );
  });

  it('and still takes a minted 16-hex serial, so nothing already assigned is stranded', () => {
    const run = mkRun({ status: 'draft', units: 2 });
    assert.equal(assignSealSerials(db, run, roll(5, 77)).assigned, 2);
  });

  it('but not the shapes that are a typo rather than a seal', () => {
    const run = mkRun({ status: 'draft', units: 2 });
    // A bare prefix, a stray dash, an inner space, and something far too long for a label. Each is a
    // mistake somebody could make transcribing a sheet, and each has to fail loudly rather than be
    // committed into a hash nobody can change afterwards.
    for (const wrong of ['BK-', '-BK-1', 'BK--1', 'BK 7WMHC', 'X', `BK-${'X'.repeat(40)}`]) {
      assert.throws(
        () => assignSealSerials(db, run, [wrong, 'BK-ZZZZZ', 'BK-YYYYY', 'BK-XXXXX']),
        /letters, digits/,
        `${JSON.stringify(wrong)} was accepted`,
      );
    }
  });

  it('refuses a serial already on another run — two parcels cannot carry the same one', () => {
    const a = mkRun({ status: 'draft', units: 2 });
    const shared = roll(6, 5);
    assignSealSerials(db, a, shared);
    const b = mkRun({ status: 'draft', units: 2 });
    assert.throws(() => assignSealSerials(db, b, shared), /already assigned/);
  });

  it('refuses to reassign once the run is past draft — the serials are committed', () => {
    const run = mkRun({ status: 'locked_published', units: 2 });
    assert.throws(() => assignSealSerials(db, run, roll(6, 6)), /serials are committed/);
  });

  it('the mapping is RANDOM, not the order of the roll', () => {
    // The randomness is the security property: a contiguous mapping would let anyone who saw one parcel
    // derive the rest. Run it repeatedly and require the assignment to vary.
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      const run = mkRun({ status: 'draft', units: 4 });
      assignSealSerials(db, run, roll(40, 100 + i));
      const got = db.prepare('SELECT seal_serial FROM run_bundles WHERE run_id = ? ORDER BY bundle_no').all(run.id)
        .map((r) => r.seal_serial);
      // Which of the roll's positions landed on bundle 1 — a contiguous assignment would always be 0.
      seen.add(Number.parseInt(got[0], 16) % 40);
    }
    assert.ok(seen.size > 3, `bundle 1 only ever drew ${seen.size} distinct position(s) from the roll`);
  });

  it('does not write the mapping into the audit note', () => {
    const run = mkRun({ status: 'draft', units: 2 });
    assignSealSerials(db, run, roll(8, 200));
    const row = db.prepare("SELECT note, after_json FROM run_audit WHERE run_id = ? AND action = 'seal_serials'").get(run.id);
    assert.ok(row, 'the assignment must be recorded');
    const serials = db.prepare('SELECT seal_serial FROM run_bundles WHERE run_id = ?').all(run.id).map((r) => r.seal_serial);
    // The audit surface is read more widely than the manifest route is, and the mapping is as sensitive
    // as the manifest itself.
    for (const s of serials) {
      assert.ok(!String(row.note).includes(s), 'a serial reached the audit note');
      assert.ok(!String(row.after_json).includes(s), 'a serial reached the audit payload');
    }
  });
});
