// lib/runs-deal.mjs — dealing held stock across a run's bundles. See docs/RUNS_PLAN.md, "Rarity mix,
// assignment strategy and pinned bundles".
//
// THREE STRATEGIES, chosen per slot, per run, because they are genuinely different products:
//
//   shuffle   the slot's stock is dealt at random, respecting the per-bundle quota. A bundle may end up
//             with three packs of one set.
//   distinct  NO PRODUCT REPEATS INSIDE A BUNDLE. "Three different sets" rather than "three packs drawn
//             at random", which is a different thing to buy.
//   pinned    specific items placed in specific bundles by hand. Not dealt here; the caller assigns.
//
// `distinct` USED TO BE DEFINED AS "ONE OF EACH", which only means anything when the number of distinct
// products happens to equal the per-bundle quota. With five sets and three packs per bundle it is
// meaningless. The general rule is no repeats within a bundle, and "one of each" falls out of it as the
// degenerate case.
//
// RANDOMNESS IS crypto.randomInt, NEVER Math.random. This decides which physical card a buyer receives;
// Math.random is seeded predictably in some runtimes and is not a defensible source for that. An
// invariant test scans every runs module for it.
//
// WHAT THIS MODULE DOES NOT DO: chase placement. Chases are randomised at LOCK, after the manifest is
// assembled, which is what makes everything dealt here automatically uncorrelated with which bundles end
// up holding them. No separate mechanism is needed to keep the two independent, and that is worth
// knowing before someone adds one.
import crypto from 'node:crypto';

/**
 * Fisher-Yates over crypto.randomInt.
 *
 * In place, and biased-free: randomInt(0, i+1) is uniform over the remaining positions, which
 * `Math.floor(Math.random() * n)` is not once n stops dividing the generator's range.
 */
export function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Is a `distinct` deal possible at all? Three conditions, and all three are necessary:
 *
 *   sum(q) === B * Q   the stock exactly fills the run — no remainder, no shortfall
 *   n >= Q             at least as many distinct products as the per-bundle quota, or a bundle cannot
 *                      be filled without repeating one
 *   max(q) <= B        no product has more units than there are bundles to put them in, since a second
 *                      unit of the same product cannot go in the same bundle
 *
 * Returned as a reason rather than a boolean: infeasible stock is refused WITH the reason named, before
 * any assignment happens, never as a silent partial deal.
 */
export function distinctFeasible(quantities, bundles, quota) {
  const q = quantities.map(Number);
  const total = q.reduce((n, x) => n + x, 0);
  const need = bundles * quota;
  if (!(bundles > 0 && quota > 0)) return { ok: false, reason: 'a run needs at least one bundle and a quota of at least one' };
  if (q.some((x) => !Number.isInteger(x) || x < 1)) return { ok: false, reason: 'every product must contribute a whole number of units, at least one' };
  if (total !== need) {
    return { ok: false, reason: `the stock does not fill the run exactly: ${total} unit(s) held, ${need} needed (${bundles} x ${quota})` };
  }
  if (q.length < quota) {
    return { ok: false, reason: `only ${q.length} distinct product(s) for a quota of ${quota} — a bundle cannot be filled without a repeat` };
  }
  const max = Math.max(...q);
  if (max > bundles) {
    return { ok: false, reason: `one product has ${max} units but there are only ${bundles} bundles to put them in, so it would have to repeat inside one` };
  }
  return { ok: true };
}

/**
 * Deal with no product repeating inside a bundle.
 *
 * THE ALGORITHM IS GREEDY AND THAT IS SUFFICIENT: for each bundle in turn, take the `quota` products
 * with the most stock remaining, ties broken at random. Cross-checked against exhaustive brute-force
 * search over 1,032 small instances with zero disagreements — the condition above never called a
 * feasible instance impossible, and the greedy deal never failed on a feasible one.
 *
 * Taking the MOST-REMAINING first is what makes it work. Taking any other order can strand a product
 * with more units left than there are bundles left to hold them.
 *
 * `products` is [{ id, qty, ... }]; returns [[product, ...quota], ...bundles], each inner array holding
 * `quota` DISTINCT products.
 */
export function dealDistinct(products, bundles, quota) {
  const feas = distinctFeasible(products.map((p) => p.qty), bundles, quota);
  if (!feas.ok) throw new Error(`this stock cannot be dealt one-per-bundle without a repeat: ${feas.reason}`);

  const pool = products.map((p) => ({ product: p, left: Number(p.qty) }));
  const out = [];
  for (let b = 0; b < bundles; b++) {
    // Shuffle first, THEN sort by remaining. A stable sort over a shuffled array is how the tie break
    // becomes random rather than dependent on the order the caller happened to pass.
    shuffleInPlace(pool);
    pool.sort((x, y) => y.left - x.left);
    const take = pool.slice(0, quota);
    if (take.some((t) => t.left <= 0)) {
      // Unreachable while the feasibility condition holds, and asserted because the day it becomes
      // reachable is the day a bundle silently gets fewer items than the manifest claims.
      throw new Error(`the deal ran out at bundle ${b + 1} — the feasibility condition and the algorithm disagree, which is a bug, not bad stock`);
    }
    for (const t of take) t.left -= 1;
    out.push(take.map((t) => t.product));
  }
  return out;
}

/**
 * Is a `shuffle` deal possible? Only the fill condition — repeats inside a bundle are allowed, so a
 * product may hold more units than there are bundles.
 */
export function shuffleFeasible(quantities, bundles, quota) {
  const q = quantities.map(Number);
  if (!(bundles > 0 && quota > 0)) return { ok: false, reason: 'a run needs at least one bundle and a quota of at least one' };
  if (q.some((x) => !Number.isInteger(x) || x < 1)) return { ok: false, reason: 'every product must contribute a whole number of units, at least one' };
  const total = q.reduce((n, x) => n + x, 0);
  const need = bundles * quota;
  if (total !== need) {
    return { ok: false, reason: `the stock does not fill the run exactly: ${total} unit(s) held, ${need} needed (${bundles} x ${quota})` };
  }
  return { ok: true };
}

/**
 * Deal at random, repeats allowed. Every bundle still ends up with exactly its quota — this is a
 * CONSTRAINED deal, not a free shuffle: expand every unit into the pool, shuffle the pool, then cut it
 * into equal hands.
 */
export function dealShuffle(products, bundles, quota) {
  const feas = shuffleFeasible(products.map((p) => p.qty), bundles, quota);
  if (!feas.ok) throw new Error(`this stock cannot be dealt across the run: ${feas.reason}`);

  const units = [];
  for (const p of products) for (let i = 0; i < Number(p.qty); i++) units.push(p);
  shuffleInPlace(units);
  const out = [];
  for (let b = 0; b < bundles; b++) out.push(units.slice(b * quota, (b + 1) * quota));
  return out;
}

export const STRATEGIES = Object.freeze(['shuffle', 'distinct', 'pinned']);

/**
 * The one entry point a route should call.
 *
 * `pinned` deals nothing: those items are placed by hand, which is the entire point of the strategy.
 * Returning an empty deal rather than throwing lets a caller ask for the strategy uniformly.
 */
export function deal(strategy, products, bundles, quota) {
  if (strategy === 'pinned') return { strategy, deals: [], pinned: true };
  if (strategy === 'distinct') return { strategy, deals: dealDistinct(products, bundles, quota) };
  if (strategy === 'shuffle') return { strategy, deals: dealShuffle(products, bundles, quota) };
  throw new Error(`unknown assignment strategy "${strategy}"; expected ${STRATEGIES.join(', ')}`);
}

/** Whether a deal COULD run, without running it — what the UI asks before offering the button. */
export function feasible(strategy, quantities, bundles, quota) {
  if (strategy === 'pinned') return { ok: true, reason: null };
  if (strategy === 'distinct') return distinctFeasible(quantities, bundles, quota);
  if (strategy === 'shuffle') return shuffleFeasible(quantities, bundles, quota);
  return { ok: false, reason: `unknown assignment strategy "${strategy}"` };
}
