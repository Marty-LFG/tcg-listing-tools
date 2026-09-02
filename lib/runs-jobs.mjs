// lib/runs-jobs.mjs — the Keeper's Runs background jobs.
//
// ONE JOB TODAY, AND IT IS LOAD-BEARING: the anchor upgrade sweep.
//
// §5.7.5 makes the upgrade mandatory. A timestamping calendar returns an INCOMPLETE attestation, which is
// self-contained only after upgrading — verifying an un-upgraded one needs the calendar to still exist
// and still hold its aggregation data, so it is not a durable anchor. `upgradeAnchor` is therefore the
// only thing that moves an anchor from `submitted` to `confirmed`, and §5.7.7's sale gate refuses while
// any header anchor is unconfirmed.
//
// Which means: WITHOUT THIS TIMER NO RUN CAN EVER OPEN FOR SALE. `anchor.upgrade_interval_min` has been
// in data/runs.config.json since the module shipped, editable from settings.html, with no consumer
// anywhere — so the gate would have gone on reporting "the header timestamp is still pending" forever,
// which reads exactly like a slow calendar rather than like a missing job.
//
// The shape is the house pattern — stop-then-start singleton on globalThis, unref'd boot timeout plus a
// recurring interval, and a getState() for /api/status. Mirrors startPostsaleJobs and startDataRefresh,
// including remembering env/db at module scope so a settings-driven restart can re-arm without them in
// scope. See the note above startPostsaleJobs on why it is stop-then-start rather than early-return:
// Vite restarts this process in place, and an early-return would leave the OLD timer running against a
// stale database handle.

import { loadRunsConfig, ensureRunsConfigSeeded } from './runs-config.mjs';
import { upgradeAnchor, staleAnchors, UPGRADE_ALERT_HOURS } from './runs-anchor.mjs';

let _env = {};
let _db = null;
const _sweep = { last_run: null, next_run_at: null, last_result: null };

/** Surfaced at /api/status jobs, so an armed job that never fires is visible rather than assumed. */
export function getRunsJobsState() {
  let interval = null;
  try { interval = loadRunsConfig().anchor.upgrade_interval_min; } catch { /* config unreadable */ }
  return {
    anchor_sweep: {
      running: !!globalThis.__runsAnchorTimer,
      interval_min: interval,
      next_run_at: _sweep.next_run_at,
      last_run: _sweep.last_run,
      last_result: _sweep.last_result,
    },
  };
}

/**
 * Upgrade every submitted attestation, and surface the ones that have been pending too long.
 *
 * A "still pending" answer is the NORMAL state for the first hours and is not an error — `upgradeAnchor`
 * already returns it as data rather than throwing. What is not normal is one still pending past
 * §5.7.5's alert window, and that gets reported rather than swallowed: an anchor that never confirms is
 * a run that can never sell, and the operator has to hear about it from somewhere other than a gate
 * message that looks like patience.
 */
export async function runAnchorSweep(env = _env, db = _db, { now = null, trigger = 'schedule' } = {}) {
  if (!db) return { skipped: 'no database handle' };
  const started = now || new Date().toISOString();
  const out = { trigger, checked: 0, confirmed: 0, pending: 0, failed: 0, stale: 0, errors: [] };

  let rows = [];
  try {
    rows = db.prepare(`SELECT a.id, a.run_id, a.scope, r.public_id
                         FROM run_anchors a JOIN runs r ON r.id = a.run_id
                        WHERE a.state = 'submitted' ORDER BY a.submitted_at`).all();
  } catch (e) {
    out.errors.push(String(e?.message || e));
    return finish(out, started);
  }

  for (const row of rows) {
    out.checked++;
    try {
      const r = await upgradeAnchor(db, row.id);
      // `confirmed: false` is the pending case and carries a reason; a row that upgraded comes back with
      // state 'confirmed' instead.
      if (r?.state === 'confirmed' || r?.alreadyConfirmed) out.confirmed++;
      else out.pending++;
    } catch (e) {
      out.failed++;
      out.errors.push(`${row.public_id} ${row.scope}: ${String(e?.message || e)}`);
    }
  }

  try {
    const stale = staleAnchors(db, { hours: UPGRADE_ALERT_HOURS, now: started });
    out.stale = stale.length;
    for (const s of stale) {
      // §5.7.5: one still un-upgraded after a defined interval raises an alert. Loud, because the run it
      // belongs to cannot open for sale until it lands.
      console.warn(`[runs/anchor] ${s.public_id} ${s.scope} digest has been pending since ${s.submitted_at} `
        + `(over ${UPGRADE_ALERT_HOURS}h) — that run cannot open for sale until it confirms`);
    }
  } catch (e) {
    out.errors.push(`stale check: ${String(e?.message || e)}`);
  }

  if (out.confirmed) console.log(`[runs/anchor] ${out.confirmed} anchor(s) confirmed`);
  return finish(out, started);
}

function finish(out, started) {
  _sweep.last_run = started;
  _sweep.last_result = out;
  return out;
}

/** Run it now, from a route or the console, without waiting for the interval. */
export const runAnchorSweepNow = (env, db) => runAnchorSweep(env || _env, db || _db, { trigger: 'manual' });

export function startRunsJobs(env, db) {
  stopRunsJobs();
  if (env && typeof env === 'object') _env = env;
  if (db) _db = db;
  ensureRunsConfigSeeded();
  const cfg = loadRunsConfig();

  // The validator already pins this to 5..1440; the floor is restated because a config edited by hand
  // around the validator should slow the job down, not spin it.
  const ms = Math.max(5, cfg.anchor.upgrade_interval_min || 60) * 60_000;
  const tick = () => {
    _sweep.next_run_at = new Date(Date.now() + ms).toISOString();
    return runAnchorSweep(_env, _db, { trigger: 'schedule' })
      .catch((e) => console.error('[runs/anchor]', e?.message || e));
  };
  // 90 seconds, deliberately after postsale's 45s order poll and 75s reply poll, so three subsystems do
  // not all wake into the same tick on a cold boot.
  const boot = setTimeout(tick, 90_000); if (boot.unref) boot.unref();
  const timer = setInterval(tick, ms); if (timer.unref) timer.unref();
  globalThis.__runsAnchorBoot = boot;
  globalThis.__runsAnchorTimer = timer;
  _sweep.next_run_at = new Date(Date.now() + ms).toISOString();

  console.log(`[runs/anchor] upgrade sweep every ${cfg.anchor.upgrade_interval_min}m · mode ${cfg.anchor.mode}`);
}

export function stopRunsJobs() {
  if (globalThis.__runsAnchorBoot) { clearTimeout(globalThis.__runsAnchorBoot); globalThis.__runsAnchorBoot = null; }
  if (globalThis.__runsAnchorTimer) { clearInterval(globalThis.__runsAnchorTimer); globalThis.__runsAnchorTimer = null; }
  _sweep.next_run_at = null;
}
