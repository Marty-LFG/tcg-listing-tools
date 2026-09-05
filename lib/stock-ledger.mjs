// lib/stock-ledger.mjs — the append-only side of stock, and the one door quantity changes through.
//
// WHAT WAS MISSING. Every change to inventory_items.quantity or sealed_items.quantity was a destructive
// UPDATE. The number was always current and never explicable: "why does this say 3" and "where did that
// card go" had no answer beyond restoring one of fourteen daily backups and diffing. inventory_valuations
// and sealed_valuations look like history and are not — they record VALUE, never a quantity, a delta or
// a reason.
//
// THE MODEL. stock_movements is the truth; quantity on the stock row is a maintained CACHE of
// SUM(delta). That is not a new idea in this repo — sealed_items.quantity has exactly that relationship
// with sealed_placements already, and lib/sealed.mjs's four helpers own that invariant the way this
// module owns this one. Two caches over one fact is deliberate: SUM over a growing ledger on every list
// query is the wrong shape for a page that renders hundreds of rows, and the reconcile below is what
// keeps the cache honest rather than trusted.
//
// THIS MODULE DOES NOT MANAGE TRANSACTIONS. Same contract receiveInventory and receiveSealed state:
// "the caller supplies the transaction". A movement and the cache write it implies must land together,
// so a caller that is not already inside a BEGIN has to open one — and the callers that matter
// (commitReceive, the batch routes) already are.
//
// ⚠ THE ONE PLACE THAT IS NOT INSIDE A TRANSACTION is lib/postsale.mjs. Its three BEGINs are all on
// postsale.db, and its stock writes against tracker.db are deliberately bare so that the cross-DB
// decrement-then-stamp order holds — a crash between them must UNDER-list rather than oversell. A
// tracker-side BEGIN around the movement and the cache does not disturb that: it spans one database and
// completes entirely before the postsale stamp is written.
import { openDb } from './db.mjs';

export const KINDS = Object.freeze(['inventory', 'sealed']);
export const TABLE_FOR = Object.freeze({ inventory: 'inventory_items', sealed: 'sealed_items' });

// The vocabulary, and the whole point of having one. A quantity that changed for a reason nobody can
// name is the state this module exists to end, so `reason` is a CHECK constraint in the schema and this
// is its readable half. 'manual' and 'correction' are the escape hatches and are deliberately last:
// reaching for one should feel like reaching for one.
export const REASONS = Object.freeze({
  opening: 'balance carried in when the ledger was introduced',
  receive: 'received against a purchase order',
  sale: 'sold',
  cancel: 'a sale was cancelled and the units came back',
  return: 'a customer returned it',
  writeoff: 'written off',
  damage: 'damaged',
  loss: 'lost or unaccounted for',
  stocktake: 'a physical count disagreed with the system',
  transfer: 'moved between locations',
  convert: 'converted into other stock',
  manual: 'changed by hand',
  correction: 'a correction to an earlier movement',
});

const tableFor = (kind) => {
  const t = TABLE_FOR[kind];
  if (!t) throw new Error(`stock-ledger: unknown kind '${kind}' (want ${KINDS.join('|')})`);
  return t;
};

/**
 * The quantity the ledger says a row holds. This is the AUTHORITY; the column is the cache of it.
 */
export function ledgerQty(db, kind, itemId) {
  const r = db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM stock_movements WHERE kind = ? AND item_id = ?')
    .get(kind, +itemId);
  return Number(r && r.n) || 0;
}

/**
 * applyMovement — record what happened, then bring the cache to match.
 *
 * `delta` is SIGNED and is the whole input: +3 received, -1 sold. There is deliberately no "set the
 * quantity to N" form, because that is the operation this module exists to replace — a number with no
 * story. A caller that genuinely knows only the target uses setQuantity() below, which derives the
 * delta and makes the caller name a reason for it.
 *
 * Returns the movement id and the new quantity. Throws rather than guessing on an unknown kind, an
 * unknown reason or a missing row: a movement filed against nothing is worse than a refused write.
 */
export function applyMovement(db, {
  kind, itemId, delta, reason, refKind = null, refId = null, location = null, note = null, sku = null,
} = {}) {
  const table = tableFor(kind);
  if (!Number.isInteger(delta)) throw new Error(`stock-ledger: delta must be a whole number, got ${delta}`);
  if (!REASONS[reason]) throw new Error(`stock-ledger: unknown reason '${reason}' (want ${Object.keys(REASONS).join('|')})`);

  const row = db.prepare(`SELECT id, sku, quantity FROM ${table} WHERE id = ?`).get(+itemId);
  if (!row) throw new Error(`stock-ledger: no ${kind} row ${itemId} to move stock on`);

  // CATCH UP FIRST, IF THE CACHE IS AHEAD.
  //
  // A row whose quantity was written by a path that does not go through this module — one not routed
  // yet, or a restore from a backup taken mid-migration — has a cache the ledger cannot account for.
  // Applying a delta to a ledger that never saw those units drives it negative: sell the only copy of a
  // row the ledger has no movements for and it lands at -1.
  //
  // So the difference is filed as its own movement before the real one. Deliberately visible rather
  // than silently absorbed: it is stamped 'correction' with a note saying the cache was ahead, so the
  // ledger says "something changed this from outside" at the point it was noticed, and grepping for
  // those rows is how the remaining unrouted paths get found.
  const known = ledgerQty(db, kind, row.id);
  const cached = Number(row.quantity) || 0;
  if (known !== cached) {
    db.prepare(`INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason, note)
                VALUES (?,?,?,?,?,'correction',?)`)
      .run(kind, row.id, row.sku || null, cached - known, cached,
        `the stock row read ${cached} while the ledger had ${known} — carried in when the next movement landed`);
  }
  const after = cached + delta;

  db.prepare(`INSERT INTO stock_movements (kind, item_id, sku, delta, qty_after, reason, ref_kind, ref_id, location, note)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(kind, row.id, sku || row.sku || null, delta, after, reason, refKind, refId == null ? null : String(refId), location, note);

  db.prepare(`UPDATE ${table} SET quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(after, row.id);
  return { ok: true, itemId: row.id, delta, quantity: after };
}

/**
 * setQuantity — for the callers that know the target rather than the change.
 *
 * A hand edit types "4", not "+1". This turns that into a movement so it is still explicable, and
 * returns null when nothing actually changed rather than filing a zero-delta row: a ledger full of
 * no-ops is a ledger nobody reads.
 */
export function setQuantity(db, { kind, itemId, quantity, reason = 'manual', ...rest } = {}) {
  const table = tableFor(kind);
  const row = db.prepare(`SELECT quantity FROM ${table} WHERE id = ?`).get(+itemId);
  if (!row) throw new Error(`stock-ledger: no ${kind} row ${itemId} to set stock on`);
  const target = Math.max(0, Math.round(Number(quantity) || 0));
  // Measured against the CACHE, which is what applyMovement reconciles to. Measuring against the
  // ledger instead would double-count on a row the catch-up is about to correct.
  const delta = target - (Number(row.quantity) || 0);
  if (delta === 0) return null;
  return applyMovement(db, { kind, itemId, delta, reason, ...rest });
}

/**
 * The movements for one row, newest first — "how did this get to 3", answered.
 */
export function movementsFor(db, kind, itemId, limit = 200) {
  return db.prepare(`SELECT * FROM stock_movements WHERE kind = ? AND item_id = ?
                      ORDER BY id DESC LIMIT ?`).all(kind, +itemId, Math.max(1, Math.min(1000, limit)));
}

/**
 * reconcile — every row where the cache and the ledger disagree.
 *
 * This is what makes the cache safe to read. Any write path that still changes quantity WITHOUT going
 * through this module shows up here as drift, named, rather than as a number that is quietly wrong —
 * so routing the remaining paths is measurable instead of a matter of belief.
 *
 * Report-only by design. Fixing drift automatically would destroy the evidence of which path caused it,
 * which is the one thing worth having.
 */
export function reconcile(db = openDb(), { kind = null } = {}) {
  const kinds = kind ? [kind] : KINDS;
  const out = [];
  for (const k of kinds) {
    const table = tableFor(k);
    const rows = db.prepare(`
      SELECT t.id, t.sku, COALESCE(t.quantity, 0) AS cached,
             COALESCE((SELECT SUM(delta) FROM stock_movements m WHERE m.kind = ? AND m.item_id = t.id), 0) AS ledger
        FROM ${table} t`).all(k);
    for (const r of rows) {
      if (Number(r.cached) !== Number(r.ledger)) {
        out.push({ kind: k, item_id: r.id, sku: r.sku, cached: Number(r.cached), ledger: Number(r.ledger), drift: Number(r.cached) - Number(r.ledger) });
      }
    }
  }
  return out;
}
