// test/unit/runs-jobs.test.mjs — the anchor upgrade sweep.
//
// WHY THIS JOB IS LOAD-BEARING. §5.7.5 makes the upgrade mandatory: a calendar returns an INCOMPLETE
// attestation, and verifying one needs the calendar to still exist and still hold its aggregation data,
// so it is not a durable anchor. `upgradeAnchor` is the only thing that moves an anchor from `submitted`
// to `confirmed`, and §5.7.7's sale gate refuses while any header anchor is unconfirmed.
//
// So without this sweep NO RUN CAN EVER OPEN FOR SALE — and the failure is silent, because the gate goes
// on reporting "the header timestamp is still pending", which reads like a slow calendar rather than a
// missing job. `anchor.upgrade_interval_min` sat in the config, editable from settings.html, with no
// consumer at all.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { submitAnchor, saleGate } from '../../lib/runs-anchor.mjs';
import { runAnchorSweep, startRunsJobs, stopRunsJobs, getRunsJobsState } from '../../lib/runs-jobs.mjs';

const db = openDbAt(tmpFile('runs-jobs.db'));
after(() => stopRunsJobs());

const DIGEST = 'ab'.repeat(32);
let n = 0;
function mkRun({ digest = DIGEST } = {}) {
  const k = ++n;
  const pid = `DEV-J${k}`;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, locked_at, run_root, header_digest)
              VALUES (?,?,?, 'dev', 3, 'locked_published', '2026-08-30T00:00:00.000Z', ?, ?)`)
    .run(pid, k, `Edition ${k}`, 'cd'.repeat(32), digest);
  return db.prepare('SELECT * FROM runs WHERE public_id = ?').get(pid);
}

describe('the sweep upgrades what is pending', () => {
  it('promotes a submitted anchor and reports it', async () => {
    const run = mkRun();
    await submitAnchor(db, { runId: run.id, digest: run.header_digest, mode: 'stub' });
    const out = await runAnchorSweep({}, db);
    assert.equal(out.checked, 1);
    assert.equal(out.confirmed, 1);
    assert.equal(db.prepare("SELECT state FROM run_anchors WHERE run_id = ?").get(run.id).state, 'confirmed');
  });

  it('AND THAT IS WHAT OPENS THE SALE GATE — the whole reason the job exists', async () => {
    const run = mkRun({ digest: 'ef'.repeat(32) });
    await submitAnchor(db, { runId: run.id, digest: run.header_digest, mode: 'stub' });

    const before = saleGate(db, run.id);
    assert.equal(before.open, false);
    assert.ok(before.reasons.some((r) => /still pending/.test(r)),
      'the gate must refuse on a merely submitted timestamp');

    await runAnchorSweep({}, db);

    const after = saleGate(db, run.id);
    assert.deepEqual(after.reasons, []);
    assert.equal(after.open, true);
  });

  it('counts a still-pending calendar as pending, not as a failure', async () => {
    // The normal state for the first hours. upgradeAnchor already returns it as data rather than
    // throwing, and a sweep that logged it as an error would train an operator to ignore the log.
    const run = mkRun({ digest: '11'.repeat(32) });
    await submitAnchor(db, {
      runId: run.id, digest: run.header_digest, mode: 'opentimestamps',
      submit: async () => new Uint8Array([1]),
    });
    // No injectable upgrade at the sweep level, so this exercises the real client against a calendar
    // that is not there: every request fails, which is the pending path.
    const out = await runAnchorSweep({}, db);
    assert.equal(out.checked, 1);
    assert.equal(out.confirmed, 0);
    assert.equal(out.pending, 1);
    assert.equal(out.failed, 0, 'an unreachable calendar is pending, not failed');
  });

  it('leaves a failed submission alone rather than retrying it as an upgrade', async () => {
    const run = mkRun({ digest: '22'.repeat(32) });
    await submitAnchor(db, {
      runId: run.id, digest: run.header_digest, mode: 'opentimestamps',
      submit: () => { throw new Error('calendars down'); },
    }).catch(() => {});
    await runAnchorSweep({}, db);
    // The sweep selects `state = 'submitted'`; a failed row needs re-SUBMITTING, which is a different
    // action with a different meaning. Asserted on THIS run's row rather than on the sweep's total,
    // because the shared fixture database still holds pending anchors from the tests above.
    const row = db.prepare('SELECT state FROM run_anchors WHERE run_id = ?').get(run.id);
    assert.equal(row.state, 'failed', 'the sweep must not touch a failed submission');
  });

  it('and reports an anchor that has been pending too long', async () => {
    const run = mkRun({ digest: '33'.repeat(32) });
    await submitAnchor(db, {
      runId: run.id, digest: run.header_digest, mode: 'opentimestamps',
      submit: async () => new Uint8Array([1]), now: '2026-08-01T00:00:00.000Z',
    });
    const out = await runAnchorSweep({}, db, { now: '2026-08-30T00:00:00.000Z' });
    assert.ok(out.stale >= 1, 'a month-old submission must be surfaced');
  });

  it('survives having no database handle rather than throwing on boot', async () => {
    assert.equal((await runAnchorSweep({}, null)).skipped, 'no database handle');
  });
});

describe('the scheduler is a stop-then-start singleton', () => {
  it('arms exactly one timer, and arming twice replaces rather than duplicates', () => {
    // Vite restarts this process in place, so an early-return would leave the OLD timer running against
    // a stale database handle. Same reasoning as startPostsaleJobs and startDataRefresh.
    startRunsJobs({}, db);
    const first = globalThis.__runsAnchorTimer;
    assert.ok(first, 'no timer armed');
    startRunsJobs({}, db);
    assert.ok(globalThis.__runsAnchorTimer);
    assert.notEqual(globalThis.__runsAnchorTimer, first, 'the old timer was not replaced');
  });

  it('reports itself to /api/status while running, and stops cleanly', () => {
    startRunsJobs({}, db);
    const on = getRunsJobsState();
    assert.equal(on.anchor_sweep.running, true);
    assert.ok(on.anchor_sweep.next_run_at, 'an armed job must say when it next fires');
    assert.ok(on.anchor_sweep.interval_min > 0);

    stopRunsJobs();
    const off = getRunsJobsState();
    assert.equal(off.anchor_sweep.running, false);
    assert.equal(off.anchor_sweep.next_run_at, null);
    assert.equal(globalThis.__runsAnchorTimer, null);
  });

  it('and does not hold the process open', () => {
    // unref'd, like every other timer in the repo — a job must never be the reason a CLI will not exit.
    startRunsJobs({}, db);
    assert.equal(typeof globalThis.__runsAnchorTimer.hasRef === 'function'
      ? globalThis.__runsAnchorTimer.hasRef() : false, false, 'the interval is still ref\'d');
    stopRunsJobs();
  });
});
