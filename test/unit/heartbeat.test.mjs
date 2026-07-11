// test/unit/heartbeat.test.mjs — the liveness canary (lib/heartbeat.mjs). It must report
// ok:false the instant an expected-running loop is stopped (the sub-24h detection that the
// 24h loop cadence otherwise hides). Uses the real loop start/stop with a stub db; the
// collector's 30s boot tick never fires because afterEach stops (and clears) it.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHeartbeat, stopHeartbeat, beat, getHeartbeat, evalHealth } from '../../lib/heartbeat.mjs';
import { startCollector, stopCollector } from '../../lib/collector.mjs';
import { startDataRefresh, stopDataRefresh } from '../../lib/refresh.mjs';

afterEach(() => { stopHeartbeat(); stopCollector(); stopDataRefresh(); });

describe('evalHealth — a config-disabled refresh must not cry wolf', () => {
  it('both loops up → ok', () => assert.equal(evalHealth({ collector: true, refresh: true, refreshEnabled: true }).ok, true));
  it('collector stopped → NOT ok (collector always expected)', () => assert.equal(evalHealth({ collector: false, refresh: true, refreshEnabled: true }).ok, false));
  it('refresh stopped while ENABLED → NOT ok', () => assert.equal(evalHealth({ collector: true, refresh: false, refreshEnabled: true }).ok, false));
  it('refresh stopped but DISABLED → ok, reported as "disabled" not "STOPPED"', () => {
    const h = evalHealth({ collector: true, refresh: false, refreshEnabled: false });
    assert.equal(h.ok, true);
    assert.match(h.detail, /refresh=disabled/);
    assert.doesNotMatch(h.detail, /STOPPED/);
  });
});

describe('heartbeat liveness canary', () => {
  it('reports ok:false when a loop is stopped (the alarm path)', () => {
    stopCollector(); stopDataRefresh();
    const hb = beat();
    assert.equal(hb.ok, false);
    assert.equal(hb.collector, false);
    assert.equal(hb.refresh, false);
    assert.match(hb.at, /^\d{4}-\d\d-\d\dT/);
  });
  it('reports ok:true when both loops are running', () => {
    startCollector({ db: {}, base: 'http://127.0.0.1:0', cadenceHours: 24 });
    startDataRefresh();
    const hb = beat();
    assert.equal(hb.collector, true);
    assert.equal(hb.refresh, true);
    assert.equal(hb.ok, true);
    assert.deepEqual(getHeartbeat(), hb);   // getHeartbeat returns the last beat
  });
  it('startHeartbeat arms a timer; stopHeartbeat clears it', () => {
    startHeartbeat({ intervalMin: 15 });
    assert.ok(globalThis.__tcgHeartbeatTimer);
    stopHeartbeat();
    assert.equal(globalThis.__tcgHeartbeatTimer ?? null, null);
  });
});
