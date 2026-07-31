// test/unit/loops.test.mjs — the collector/refresh timer lifecycle must SURVIVE a
// Vite in-process restart (configureServer runs start*() again). Regression lock for the
// close-race bug where a second start() no-op'd and the old close handler tore the timer
// down, leaving the loops dead for days. start*() is now stop-then-start: a restart always
// leaves exactly one live timer. These use unref'd timers with 30s/60s/24h delays that never
// fire within the test (afterEach stops them), so no network / no real pass runs.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startCollector, stopCollector, getCollectorState } from '../../lib/collector.mjs';
import { startDataRefresh, stopDataRefresh, getRefreshState } from '../../lib/refresh.mjs';
import { startRepricerScan, stopRepricerScan, getRepricerScanState } from '../../lib/repricer-scan.mjs';

const opts = { db: {}, base: 'http://127.0.0.1:0', cadenceHours: 24 };   // db unused until the 30s boot tick (cancelled)

describe('collector timer survives restarts', () => {
  afterEach(() => stopCollector());
  it('starts running', () => {
    startCollector(opts);
    assert.equal(getCollectorState().running, true);
  });
  it('a SECOND start (simulated Vite restart) stays running — not a dead no-op', () => {
    startCollector(opts);
    startCollector(opts);   // was: early-return + close-race => dead. Now: clean replace.
    assert.equal(getCollectorState().running, true);
  });
  it('stop clears both the interval and the boot timeout', () => {
    startCollector(opts);
    stopCollector();
    assert.equal(getCollectorState().running, false);
    assert.equal(globalThis.__tcgCollectorTimer ?? null, null);
    assert.equal(globalThis.__tcgCollectorBoot ?? null, null);
  });
});

describe('refresh timer survives restarts', () => {
  afterEach(() => stopDataRefresh());
  it('start → restart → still running; stop → not running', () => {
    startDataRefresh();
    assert.equal(getRefreshState().running, true);
    startDataRefresh();     // restart
    assert.equal(getRefreshState().running, true);
    stopDataRefresh();
    assert.equal(getRefreshState().running, false);
    assert.equal(globalThis.__tcgRefreshBoot ?? null, null);
  });
});

// The repricer scan is the heaviest loop (one GetItem + one Browse per listing), so a stacked timer
// would double a real API bill rather than merely waste cycles.
describe('repricer scan timer survives restarts', () => {
  const on = { env: {}, rdb: {}, tdb: {}, base: 'http://127.0.0.1:0', loadCfg: () => ({ scan_enabled: true, cadence_hours: 24 }) };
  afterEach(() => stopRepricerScan());

  it('start → restart → still running; stop → not running', () => {
    startRepricerScan(on);
    assert.equal(getRepricerScanState().running, true);
    startRepricerScan(on);   // simulated Vite in-process restart
    assert.equal(getRepricerScanState().running, true);
    stopRepricerScan();
    assert.equal(getRepricerScanState().running, false);
    assert.equal(globalThis.__repricerScanTimer ?? null, null);
    assert.equal(globalThis.__repricerScanBoot ?? null, null);
  });

  it('does not arm when scanning is switched off', () => {
    startRepricerScan({ ...on, loadCfg: () => ({ scan_enabled: false }) });
    const st = getRepricerScanState();
    assert.equal(st.running, false);
    assert.equal(st.enabled, false, 'disabled is a legitimate quiet state, not a dead loop');
  });

  it('re-arming with scanning switched off STOPS the old timer', () => {
    // The path a settings save takes: apply() calls stop-then-start, and the new start must not
    // leave the previous timer running on the old cadence.
    startRepricerScan(on);
    assert.equal(getRepricerScanState().running, true);
    startRepricerScan({ ...on, loadCfg: () => ({ scan_enabled: false }) });
    assert.equal(getRepricerScanState().running, false);
  });
});
