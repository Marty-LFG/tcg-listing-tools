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
