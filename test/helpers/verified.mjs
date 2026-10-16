// test/helpers/verified.mjs — mark a fixture stock row as checked against the physical item.
//
// WHY EVERY PUBLISH FIXTURE NEEDS THIS NOW. lib/verification.mjs's gate refuses a Shopify publish for a
// row nobody has physically checked (the owner's 2026-10-16 ruling; bk-shopify invariant 7). "Ready to
// publish" therefore includes "verified", the same way it already includes having a price, a condition
// and a non-provisional SKU — so a harness that seeds a publishable card seeds a verified one.
//
// None of the suites that call this is ABOUT verification: they test mapping, shelf labels, media
// reuse, concurrency and the identity rebuild. The gate itself is tested in
// test/invariants/publish-requires-verification.test.mjs and test/unit/verification.test.mjs, which
// deliberately seed rows WITHOUT this so the refusal is exercised rather than assumed. Keep it that
// way: a fixture helper that every test reached for would make the gate untestable.
import { recordVerification } from '../../lib/verification.mjs';

/**
 * One row, checked and matching.
 *
 * `units` defaults to WHAT THE ROW HOLDS, which is what a passing fixture means: somebody counted and
 * the count agreed. recordVerification requires a count above one unit and downgrades a disagreement to
 * a discrepancy, so a sealed pool of six would otherwise either throw or seed itself unpublishable —
 * both of which happened on the first draft of this helper, which is why the default is spelled out.
 *
 * The BEGIN is here because lib/verification.mjs asks the caller for it; by hand, because node:sqlite
 * has no .transaction() (the idiom lib/arbitrage.mjs documents).
 */
export function markVerified(db, kind, itemId, { actor = 'test harness', note = null, units = null } = {}) {
  const table = kind === 'sealed' ? 'sealed_items' : 'inventory_items';
  const row = db.prepare(`SELECT quantity FROM ${table} WHERE id = ?`).get(Number(itemId));
  const counted = units == null ? (row ? Number(row.quantity) || 0 : 0) : Number(units);
  db.exec('BEGIN');
  try {
    const out = recordVerification(db, {
      kind, itemId: Number(itemId), outcome: 'verified', units: counted, actor, note,
    });
    db.exec('COMMIT');
    return out;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Every in-stock row in both tables. For a harness that seeds rows in more places than it can patch. */
export function markAllVerified(db, { actor = 'test harness' } = {}) {
  let n = 0;
  for (const [kind, table] of [['inventory', 'inventory_items'], ['sealed', 'sealed_items']]) {
    for (const r of db.prepare(`SELECT id FROM ${table} WHERE verified_at IS NULL`).all()) {
      markVerified(db, kind, r.id, { actor });
      n += 1;
    }
  }
  return n;
}
