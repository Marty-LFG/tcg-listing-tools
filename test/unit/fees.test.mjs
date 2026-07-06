// test/unit/fees.test.mjs — eBay AU buyer-protection fee math (lib/fees.mjs, GR3).
// The forward (feeAU) and inverse (listForTarget) must stay in sync; band boundaries
// are exact by construction, so they get exact assertions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { feeAU, totalFromList, listForTarget, pcSolve } from '../../lib/fees.mjs';

const close = (a, b, eps = 0.005) => Math.abs(a - b) < eps;

describe('feeAU (forward)', () => {
  it('zero / negative list price → no fee', () => {
    assert.equal(feeAU(0), 0);
    assert.equal(feeAU(-5), 0);
  });
  it('band 1: flat 30c + 8% to $20', () => {
    assert.ok(close(feeAU(10), 1.10));
    assert.ok(close(feeAU(20), 1.90));
  });
  it('band 2: +6% $20–$500', () => {
    assert.ok(close(feeAU(100), 6.70));
    assert.ok(close(feeAU(500), 30.70));
  });
  it('band 3: +4% $500–$5000, capped', () => {
    assert.ok(close(feeAU(1000), 50.70));
    assert.ok(close(feeAU(5000), 210.70));
    assert.ok(close(feeAU(6000), 210.70)); // no fee above the $5000 cap
  });
});

describe('totalFromList', () => {
  it('adds fee and cent-rounds (GR3)', () => {
    assert.equal(totalFromList(10), 11.10);
    assert.equal(totalFromList(0.01), 0.31); // 0.01 + 0.30 + 0.0008 → 0.31
  });
});

describe('listForTarget (inverse)', () => {
  it('band boundaries invert exactly', () => {
    assert.ok(close(listForTarget(21.90), 20));
    assert.ok(close(listForTarget(530.70), 500));
    assert.ok(close(listForTarget(5210.70), 5000));
  });
  it('round-trips through totalFromList across all bands', () => {
    for (const T of [1, 5, 15, 21.90, 50, 300, 530.70, 1000, 5210.70, 6000]) {
      const L = listForTarget(T);
      assert.ok(close(totalFromList(L), T, 0.011), `T=${T} → L=${L} → ${totalFromList(L)}`);
    }
  });
});

describe('pcSolve (cent search)', () => {
  it('finds an exact cent solution when one exists', () => {
    const s = pcSolve(11.10);
    assert.equal(s.L, 10);
    assert.equal(s.diff, 0);
  });
  it('returns the closest reachable total otherwise', () => {
    const s = pcSolve(50);
    assert.ok(Math.abs(s.diff) <= 1); // within 1 cent
    assert.equal(totalFromList(s.L), s.tot);
  });
  it('rejects non-positive targets', () => {
    assert.equal(pcSolve(0), null);
    assert.equal(pcSolve(-1), null);
  });
});
