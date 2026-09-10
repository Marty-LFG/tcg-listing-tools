// test/unit/runs-deal.test.mjs — dealing held stock across a run's bundles (lib/runs-deal.mjs).
//
// THE CENTRAL TEST HERE IS THE BRUTE-FORCE CROSS-CHECK. `distinctFeasible` is a three-line arithmetic
// condition standing in for "can these products be dealt with no repeat inside any bundle", which is a
// degree-constrained bipartite question. A condition that is merely NECESSARY would refuse stock that
// deals fine; one that is merely SUFFICIENT would accept stock that strands a product halfway through a
// run of twenty-five bundles the owner has already bought. So it is checked against exhaustive search
// over every small instance, both directions, and the greedy algorithm is checked against the condition.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shuffleInPlace, distinctFeasible, dealDistinct, shuffleFeasible, dealShuffle, deal, feasible, STRATEGIES,
} from '../../lib/runs-deal.mjs';

const products = (qtys) => qtys.map((qty, i) => ({ id: i + 1, qty, name: `P${i + 1}` }));

// Exhaustive search: can `bundles` hands of `quota` DISTINCT products be dealt so every unit is used?
// Deliberately naive — it is the oracle, so it must be obviously correct rather than fast.
function bruteForceDistinct(qtys, bundles, quota) {
  const n = qtys.length;
  const combos = [];
  (function pick(start, chosen) {
    if (chosen.length === quota) { combos.push([...chosen]); return; }
    for (let i = start; i < n; i++) { chosen.push(i); pick(i + 1, chosen); chosen.pop(); }
  }(0, []));

  const seen = new Set();
  return (function search(left, b) {
    if (b === bundles) return left.every((x) => x === 0);
    const key = b + ':' + left.join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    for (const combo of combos) {
      if (combo.some((i) => left[i] === 0)) continue;
      const next = [...left];
      for (const i of combo) next[i] -= 1;
      if (search(next, b + 1)) return true;
    }
    return false;
  }([...qtys], 0));
}

describe('distinctFeasible agrees with exhaustive search, in both directions', () => {
  // Every instance with 1-4 products holding 1-4 units each, 1-4 bundles, quota 1-3. Small enough to
  // brute-force completely, wide enough to contain every shape of failure.
  function* instances() {
    for (let n = 1; n <= 4; n++) {
      const counts = [];
      (function build(k, acc) {
        if (k === n) { counts.push([...acc]); return; }
        for (let q = 1; q <= 4; q++) { acc.push(q); build(k + 1, acc); acc.pop(); }
      }(0, []));
      for (const qtys of counts) {
        for (let bundles = 1; bundles <= 4; bundles++) {
          for (let quota = 1; quota <= 3; quota++) yield { qtys, bundles, quota };
        }
      }
    }
  }

  it('never disagrees, over the whole space', () => {
    let checked = 0, feasibleCount = 0;
    const mismatches = [];
    for (const { qtys, bundles, quota } of instances()) {
      checked++;
      const said = distinctFeasible(qtys, bundles, quota).ok;
      const truth = bruteForceDistinct(qtys, bundles, quota);
      if (said) feasibleCount++;
      if (said !== truth) mismatches.push({ qtys, bundles, quota, said, truth });
    }
    assert.ok(checked > 1000, `only ${checked} instances — the generator shrank`);
    assert.ok(feasibleCount > 0, 'no instance was feasible, so the check proved nothing');
    assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} of ${checked} disagreed with brute force`);
  });

  it('and the greedy deal succeeds on every instance the condition allows', () => {
    let dealt = 0;
    for (const { qtys, bundles, quota } of instances()) {
      if (!distinctFeasible(qtys, bundles, quota).ok) continue;
      const hands = dealDistinct(products(qtys), bundles, quota);
      dealt++;
      assert.equal(hands.length, bundles);
      for (const hand of hands) {
        assert.equal(hand.length, quota);
        assert.equal(new Set(hand.map((p) => p.id)).size, quota, 'a product repeated inside a bundle');
      }
      // Every unit used exactly once.
      const used = {};
      for (const hand of hands) for (const p of hand) used[p.id] = (used[p.id] || 0) + 1;
      qtys.forEach((q, i) => assert.equal(used[i + 1] || 0, q, `product ${i + 1} was dealt the wrong number of times`));
    }
    assert.ok(dealt > 50, `only ${dealt} feasible instances were dealt`);
  });
});

describe('the worked cases from the plan, at 25 bundles and 3 packs', () => {
  const B = 25, Q = 3;

  it('15 each of 5 sets deals fine, with bundles getting varying trios', () => {
    assert.equal(distinctFeasible([15, 15, 15, 15, 15], B, Q).ok, true);
    const hands = dealDistinct(products([15, 15, 15, 15, 15]), B, Q);
    assert.equal(hands.length, 25);
    const shapes = new Set(hands.map((h) => h.map((p) => p.id).sort().join('-')));
    assert.ok(shapes.size > 1, 'every bundle got the same trio, which is not a deal');
  });

  it('unequal quantities are not a problem', () => {
    assert.equal(distinctFeasible([25, 25, 10, 10, 5], B, Q).ok, true);
  });

  it('25 each of 3 sets deals, and every bundle is identical — "one of each", emerging naturally', () => {
    const hands = dealDistinct(products([25, 25, 25]), B, Q);
    const shapes = new Set(hands.map((h) => h.map((p) => p.id).sort().join('-')));
    assert.equal(shapes.size, 1, 'with exactly three products and a quota of three there is only one hand');
  });

  it('REFUSES 26 units of one set — it cannot fit in 25 bundles without a repeat', () => {
    const r = distinctFeasible([26, 25, 12, 6, 6], B, Q);
    assert.equal(r.ok, false);
    assert.match(r.reason, /26 units but there are only 25 bundles/);
  });

  it('REFUSES fewer distinct products than the quota', () => {
    const r = distinctFeasible([40, 35], B, Q);
    assert.equal(r.ok, false);
    // Both conditions fail here; the message names the one a human can act on.
    assert.match(r.reason, /distinct product|does not fill/);
  });

  it('REFUSES stock that does not fill the run exactly, and says which way', () => {
    assert.match(distinctFeasible([15, 15, 15, 15, 14], B, Q).reason, /74 unit\(s\) held, 75 needed/);
    assert.match(distinctFeasible([15, 15, 15, 15, 16], B, Q).reason, /76 unit\(s\) held, 75 needed/);
  });

  it('names the reason rather than dealing partially', () => {
    assert.throws(() => dealDistinct(products([26, 25, 12, 6, 6]), B, Q), /cannot be dealt one-per-bundle/);
  });
});

describe('shuffle', () => {
  it('allows a repeat inside a bundle, which is what makes it a different product to buy', () => {
    // 75 packs from ONE set: impossible under distinct, fine under shuffle.
    assert.equal(distinctFeasible([75], 25, 3).ok, false);
    assert.equal(shuffleFeasible([75], 25, 3).ok, true);
    const hands = dealShuffle(products([75]), 25, 3);
    assert.equal(hands.length, 25);
    assert.ok(hands.every((h) => h.length === 3));
  });

  it('still fills every bundle exactly — a constrained deal, not a free shuffle', () => {
    const hands = dealShuffle(products([30, 30, 15]), 25, 3);
    assert.ok(hands.every((h) => h.length === 3));
    const used = {};
    for (const h of hands) for (const p of h) used[p.id] = (used[p.id] || 0) + 1;
    assert.deepEqual(used, { 1: 30, 2: 30, 3: 15 });
  });

  it('refuses stock that does not fill the run', () => {
    assert.equal(shuffleFeasible([74], 25, 3).ok, false);
    assert.throws(() => dealShuffle(products([74]), 25, 3), /does not fill the run/);
  });

  it('actually varies between deals', () => {
    const order = () => dealShuffle(products([25, 25, 25]), 25, 3).map((h) => h.map((p) => p.id).join('')).join('|');
    const seen = new Set(Array.from({ length: 8 }, order));
    assert.ok(seen.size > 1, 'eight deals produced one arrangement — the shuffle is not shuffling');
  });
});

describe('the entry points', () => {
  it('pinned deals nothing, because those items are placed by hand', () => {
    const r = deal('pinned', products([1]), 25, 1);
    assert.deepEqual(r.deals, []);
    assert.equal(r.pinned, true);
    assert.equal(feasible('pinned', [1], 25, 1).ok, true, 'pinned is always possible — there is nothing to fail');
  });

  it('refuses an unknown strategy rather than picking one', () => {
    assert.throws(() => deal('random', products([75]), 25, 3), /unknown assignment strategy/);
    assert.equal(feasible('random', [75], 25, 3).ok, false);
    assert.deepEqual(STRATEGIES, ['shuffle', 'distinct', 'pinned']);
  });

  it('feasible() answers without dealing', () => {
    assert.equal(feasible('distinct', [15, 15, 15, 15, 15], 25, 3).ok, true);
    assert.equal(feasible('distinct', [26, 25, 12, 6, 6], 25, 3).ok, false);
  });
});

describe('the shuffle itself', () => {
  it('keeps every element', () => {
    const a = Array.from({ length: 50 }, (_, i) => i);
    assert.deepEqual([...shuffleInPlace([...a])].sort((x, y) => x - y), a);
  });

  it('is not the identity', () => {
    const a = Array.from({ length: 50 }, (_, i) => i);
    assert.notDeepEqual(shuffleInPlace([...a]), a);
  });

  it('reaches every position — a biased shuffle would leave some element pinned', () => {
    // Element 0's landing position over many runs. A modulo-biased or partial shuffle shows up as gaps.
    const seen = new Set();
    for (let i = 0; i < 400; i++) seen.add(shuffleInPlace([0, 1, 2, 3, 4]).indexOf(0));
    assert.equal(seen.size, 5, 'element 0 never reached some position');
  });
});
