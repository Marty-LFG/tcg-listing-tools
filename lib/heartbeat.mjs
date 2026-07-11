// lib/heartbeat.mjs — a low-cadence liveness canary for the in-process loops.
//
// The collector + refresh loops fire on a 24h cadence, so if a timer ever silently died
// mid-process nothing would fire for ~24h — the exact slow-to-surface property that hid the
// collector stall for 3+ days (see the tracker.mjs close-race fix). This ticks every
// HEARTBEAT_MIN minutes, checks each loop's LIVE timer handle, and emits a WARN line the
// moment an expected-running loop is found stopped — visible in /api/status/logs?level=warn
// and in jobs.heartbeat on /api/status.
//
// Stays quiet while healthy (one info line on first beat / on recovery, then silent) so it
// doesn't flood the 500-line ring buffer; warns loudly and repeatedly while a loop is down.
// State + timer live on globalThis so they survive Vite's in-process re-import (mirrors the
// collector/refresh singletons); the timer is stop-then-start so each restart re-arms cleanly.
import { getCollectorState } from './collector.mjs';
import { getRefreshState } from './refresh.mjs';

const DEFAULT_MIN = 15;

export function getHeartbeat() { return globalThis.__tcgHeartbeat || null; }

// Pure health eval. A config-DISABLED refresh loop is a legitimate quiet state, NOT a
// death (the owner can set refresh.enabled:false via /api/settings), so it must not raise
// the alarm — otherwise the canary cries wolf every tick and masks a REAL collector stall.
// The collector always arms, so a stopped collector is always a genuine problem.
export function evalHealth({ collector, refresh, refreshEnabled }) {
  const refreshDown = refreshEnabled && !refresh;
  const ok = collector && !refreshDown;
  const detail = `collector=${collector ? 'up' : 'STOPPED'} refresh=${!refreshEnabled ? 'disabled' : (refresh ? 'up' : 'STOPPED')}`;
  return { ok, detail };
}

// Runs one liveness check, records it, and logs. Exported for tests + on-demand use.
export function beat() {
  const collector = getCollectorState().running;
  const rs = getRefreshState();
  const refreshEnabled = rs.enabled !== false;
  const { ok, detail } = evalHealth({ collector, refresh: rs.running, refreshEnabled });
  const prev = globalThis.__tcgHeartbeat;
  globalThis.__tcgHeartbeat = { at: new Date().toISOString(), collector, refresh: rs.running, refresh_enabled: refreshEnabled, ok };
  if (!ok) console.warn('[heartbeat] loop DOWN — ' + detail);
  else if (!prev || !prev.ok) console.log('[heartbeat] loops healthy — ' + detail);
  return globalThis.__tcgHeartbeat;
}

export function startHeartbeat({ intervalMin = DEFAULT_MIN } = {}) {
  stopHeartbeat();
  const ms = Math.max(1, intervalMin) * 60_000;
  console.log(`[heartbeat] liveness canary every ${intervalMin}m`);
  beat();   // beat once immediately so jobs.heartbeat is populated within a second of (re)start,
            // not only after the first interval — makes the canary observable without a 15m wait.
  const timer = setInterval(beat, ms);
  if (timer.unref) timer.unref();
  globalThis.__tcgHeartbeatTimer = timer;
  return timer;
}

export function stopHeartbeat() {
  if (globalThis.__tcgHeartbeatTimer) { clearInterval(globalThis.__tcgHeartbeatTimer); globalThis.__tcgHeartbeatTimer = null; }
}
