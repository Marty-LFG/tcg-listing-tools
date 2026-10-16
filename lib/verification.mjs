// lib/verification.mjs — the append-only side of "somebody physically looked at this", and the one
// door the Shopify publish gate asks.
//
// WHAT WAS MISSING. Nothing. Not a column, not a flag, not a timestamp. inventory_items had no
// verified/checked/audited/in_hand field of any kind — `location` and `notes` were the nearest things
// to one — and sealed_items had exactly one, `in_hand`, added with DEFAULT 1, so all 147 live rows read
// 1 because nobody has ever said otherwise rather than because anybody looked. On 2026-10-16 the owner
// ruled that ALL stock must be verified by hand against the physical item before it goes live on the
// store: bk-shopify invariant 7 applied in full rather than as a spot check, because most of the
// catalogue is one-of-one, conditions are graded by eye against a single scale, and a listing has to
// state honestly whether it shows catalogue art or the item's own photograph (bk-shopify D-030). That
// ruling had nowhere to be recorded, which meant four things were all impossible at once: a pass could
// not be resumed when work stopped for the night, it could not be proven afterwards, the tool could not
// say how much was left, and the publish path could not refuse a row nobody had checked. A rule nothing
// enforces is a sentence, which is the lesson bk-shopify D-021 already paid for once.
//
// THE MODEL, and it is lib/stock-ledger.mjs's, deliberately. stock_verifications is the truth;
// verified_at on the stock row is a maintained CACHE of "what did the last person who physically
// handled this say". The same argument applies for the same reason: a correlated subquery over a
// growing ledger is the wrong shape for a page that renders hundreds of rows, and reconcile() below is
// what keeps the cache honest rather than trusted. A history also happens to be what this problem
// actually wants — stock is re-checked at every intake, and "found, but the grade on the row is wrong"
// is worth keeping forever, not collapsing into a boolean.
//
// THIS MODULE DOES NOT MANAGE TRANSACTIONS. Same contract lib/stock-ledger.mjs states: the caller
// supplies the BEGIN. A verification record and the cache write it implies must land together.
//
// THIS MODULE NEVER WRITES quantity. See THE UNIT COUNT below — that column has one writer and it is
// lib/stock-ledger.mjs.

// ---------------------------------------------------------------------------------------------------
// THE OUTCOMES, and why a pass/fail pair is not enough.
//
// "Found it, and the grade written on the row is wrong" and "could not find it at all" are not the same
// event. They have different remedies (a data edit versus a stock movement), different urgency, and
// only one of them is evidence of loss. A boolean flattens both into `false`, where they are
// indistinguishable from "not looked at yet" — and that third state is the one the owner most needs to
// see, because it is the only one that shrinks as the pass progresses.
//
// So six, of which five are things a person with the item in hand can report:
//
//   verified     — found, and everything the row claims matches the object in hand.
//   corrected    — found, the row was wrong, and the row has BEEN FIXED to match the object. A pass:
//                  the object is the authority, and the row now agrees with it. Kept separate from
//                  `verified` because "how much of the catalogue was wrong" is the number that says
//                  whether the old spot-check habit was good enough, and a pass that absorbs its own
//                  corrections can never answer it.
//   discrepancy  — found, but the row still disagrees with it and has NOT been fixed. Not a pass. The
//                  remedy is an edit, and the note says what to edit.
//   missing      — looked where the row says it is, and it is not there. Not a pass, and a different
//                  thing from a discrepancy: the remedy is a stock movement (lib/stock-ledger.mjs's
//                  'loss'), not an edit, and it is the only outcome that is evidence of shrinkage.
//   unavailable  — the object cannot be brought to hand to be checked: away at grading, consigned out,
//                  inside a case that is not here. Not a pass, and deliberately not a failure of the
//                  row either. Without it an operator has to file a false `missing` or — far worse,
//                  because it publishes — a false `verified`.
//
// And one that is NOT a physical check and is never offered to an operator:
//
//   override     — the gate let an unverified row publish because the owner deliberately asked it to.
//                  It is written HERE, in the same table, so that one SELECT over one item_id tells
//                  the whole story of one object including the times the rule was waived. It is not in
//                  PASSING, so it does not launder the row into verified: it authorises one publish and
//                  leaves the row reading exactly as unverified as it was.

export const OUTCOMES = Object.freeze({
  verified: 'found, and the row matches the object in hand',
  corrected: 'found, the row was wrong, and the row has been fixed to match',
  discrepancy: 'found, but the row still disagrees with the object',
  missing: 'looked, and it is not where the row says it is',
  unavailable: 'the object cannot be brought to hand to be checked',
  override: 'published unverified, deliberately, by the owner',
});

// The outcomes that satisfy the publish gate. `corrected` is here because the row now matches the
// object; `override` is deliberately NOT, and that is the whole point of it.
export const PASSING = Object.freeze(['verified', 'corrected']);

// The outcomes a person with the item in hand may report. `override` is the gate's to write.
export const REPORTABLE = Object.freeze(Object.keys(OUTCOMES).filter((o) => o !== 'override'));

// ---------------------------------------------------------------------------------------------------
// RE-VERIFICATION: the latest look wins, including when it is bad news.
//
// Stock is re-checked at every intake, so one row accumulates records, and the gate has to decide which
// one it answers to. Two candidate rules, and the difference between them is not academic:
//
//   HIGH-WATER MARK — "has this ever passed?". Rejected. A row verified in March and found wrong in
//   October would still publish, which is precisely the failure this feature exists to prevent. It also
//   makes the ledger's most valuable record — the one that found a problem — have no effect on anything,
//   so an operator who files a discrepancy has done nothing but write a note. The whole reason to
//   capture the discrepancy outcome is that it CHANGES something.
//
//   LATEST WINS — "what did the last person who looked say?". Chosen. A discrepancy, a missing or an
//   unavailable recorded after a pass INVALIDATES the row: verified_at goes back to NULL and the gate
//   refuses until somebody looks again. This is the safer and more annoying option, and the annoyance
//   is load-bearing — it is the only thing that makes a discrepancy worth filing rather than worth
//   skipping, because filing one is how the row gets fixed.
//
// The third option — a discrepancy "poisons" the row until an explicit resolve action clears it — was
// considered and is the same thing with more machinery. It needs a second vocabulary and a state
// machine, and the only way it differs in practice is that a row could be un-poisoned by someone who
// did not pick the item up. Under latest-wins the only way to clear a discrepancy is to go and look
// again, which is both the correct remedy and the cheaper one to describe. So: no resolve verb exists.
//
// ⚠ ORDERED BY (at, id), NOT BY at. `at` has one-second resolution and a bulk pass files many records
// inside one second, so `at` alone is not a total order and "the latest record" would be whichever row
// SQLite felt like returning. On a pass that ends with a discrepancy, that is the difference between a
// gate that refuses and a gate that does not.

// ---------------------------------------------------------------------------------------------------
// THE UNIT COUNT, and what happens when it disagrees with the row.
//
// A sealed row can hold many units: verifying a row of 6 booster boxes is not the event verifying one
// slab is. So a record carries `units` — what was actually counted — and `qty_cached`, what the stock
// row claimed at that moment. Storing both is what makes the record re-readable a year later; storing
// only the count would leave "6" with nothing to be 6 against.
//
// A count is REQUIRED where the row holds more than one unit, and defaulted to the cached quantity
// where it holds one or none. Requiring it on a slab would be ceremony: "how many of this one-of-one
// PSA 8 did you find" has one answer, and asking it 84 times is how a pass starts getting clicked
// through. Making it optional on a pool of six is how the one case this whole feature is meant to catch
// goes uncaught.
//
// WHEN THE COUNT DISAGREES, THE OUTCOME IS FORCED TO `discrepancy` AND NOTHING IS CORRECTED
// AUTOMATICALLY. Not because a mismatch is ambiguous — it is the clearest possible signal — but because
// quantity has exactly one writer. lib/stock-ledger.mjs owns it, SUM(stock_movements.delta) is its
// authority, and 'stocktake' ("a physical count disagreed with the system") is already a named reason
// there. A second module nudging that column would reintroduce the exact state the ledger was built to
// end: a quantity that changed for a reason nobody can name. Two caches over one fact is deliberate in
// this codebase; two WRITERS of one fact is not. So the verification refuses the row, names both
// numbers, and leaves the correction to be filed as a movement with a reason attached. The caller is
// told which movement to file.
//
// A LATER STOCK MOVEMENT DOES NOT INVALIDATE A VERIFICATION, deliberately. Six more boxes received into
// a verified pool makes the counted number stale, but `receive` is itself a physical handling of the
// arriving units, and the symmetric rule would be far worse: a sale is a -1 movement, so every pool
// that sold one unit would un-verify itself and the remainder could not be published. Instead a row
// whose counted units no longer match its quantity is reported by counts() as `recount_due` — visible,
// and not a refusal. The gate's question is "did somebody look at this object", not "is the number
// still current"; the number has its own ledger and its own reconcile.

import { KINDS, TABLE_FOR } from './stock-ledger.mjs';

export { KINDS, TABLE_FOR };

const tableFor = (kind) => {
  const t = TABLE_FOR[kind];
  if (!t) throw new Error(`verification: unknown kind '${kind}' (want ${KINDS.join('|')})`);
  return t;
};

// Shapes, as the owner counts them: a pass through 84 slabs is a different sitting from a pass through
// 147 sealed rows, and "how much is left" is useless as one number. `graded` is grading_company being
// present, which is what the inventory_items schema says a slab is.
export const SHAPES = Object.freeze(['graded', 'raw', 'sealed']);
export const shapeOf = (kind, row = {}) => (kind === 'sealed' ? 'sealed'
  : (row.grading_company ? 'graded' : 'raw'));

// --- the authority ---------------------------------------------------------------------------------

/**
 * The newest record for one row, or null. THE AUTHORITY; verified_at is the cache of it.
 *
 * (at, id) rather than at — see RE-VERIFICATION above. This is the single ordering definition in the
 * module and everything else goes through it.
 */
export function latestVerification(db, kind, itemId) {
  tableFor(kind);
  return db.prepare(`SELECT * FROM stock_verifications WHERE kind = ? AND item_id = ?
                      ORDER BY at DESC, id DESC LIMIT 1`).get(kind, +itemId) || null;
}

/**
 * Every record for one row, newest first — "who looked at this, and what did they find".
 */
export function verificationsFor(db, kind, itemId, limit = 200) {
  tableFor(kind);
  return db.prepare(`SELECT * FROM stock_verifications WHERE kind = ? AND item_id = ?
                      ORDER BY at DESC, id DESC LIMIT ?`).all(kind, +itemId, Math.max(1, Math.min(1000, limit)));
}

/**
 * The state the gate reads: { ok, outcome, at, units, qty_cached, actor, note, recountDue }.
 *
 * `ok` is the newest record's outcome being in PASSING — latest-wins, including when the latest is bad
 * news. `outcome: null` with `ok: false` means nobody has ever looked, which is a different sentence to
 * put in front of an operator than "the last look found a problem", so the gate distinguishes them.
 */
export function verificationState(db, kind, itemId) {
  const table = tableFor(kind);
  const row = db.prepare(`SELECT quantity FROM ${table} WHERE id = ?`).get(+itemId);
  return stateFrom(latestVerification(db, kind, itemId), row ? (Number(row.quantity) || 0) : null);
}

// The pure half, so a caller that already holds the row's quantity — counts() and queue() both scan
// the whole table and have it in hand — does not pay for a second SELECT per row to re-read it.
export function stateFrom(last, qty = null) {
  if (!last) return { ok: false, outcome: null, at: null, units: null, qty_cached: qty, actor: null, note: null, recountDue: false };
  const ok = PASSING.includes(last.outcome);
  return {
    ok,
    outcome: last.outcome,
    at: last.at,
    units: last.units == null ? null : Number(last.units),
    qty_cached: qty,
    actor: last.actor || null,
    note: last.note || null,
    // Stale count rather than stale check — reported, never refused. See THE UNIT COUNT above.
    recountDue: !!(ok && last.units != null && qty != null && Number(last.units) !== qty),
  };
}

// --- the maintained cache --------------------------------------------------------------------------

/**
 * Bring verified_at on the stock row to match the ledger. Idempotent, and the only writer of that
 * column — exactly as applyMovement is the only writer of quantity.
 *
 * Returns the value written (an ISO-ish timestamp, or null when the row does not currently pass).
 */
export function refreshVerifiedCache(db, kind, itemId) {
  const table = tableFor(kind);
  const st = verificationState(db, kind, itemId);
  const at = st.ok ? st.at : null;
  db.prepare(`UPDATE ${table} SET verified_at = ? WHERE id = ?`).run(at, +itemId);
  return at;
}

/**
 * recordVerification — file what the person holding the item found, then bring the cache to match.
 *
 * Throws rather than guessing on an unknown kind, an unknown outcome, a missing row or a missing actor:
 * a verification filed against nothing, or by nobody, is worse than a refused write — it is the thing
 * the sealed_items.in_hand DEFAULT 1 column already was.
 *
 * `units` is forced through the rules in THE UNIT COUNT above: required above one unit, defaulted at or
 * below one, and a mismatch DOWNGRADES the outcome to 'discrepancy' rather than correcting anything.
 * The downgrade is returned as `downgraded` so a caller can say so out loud instead of silently
 * recording something the operator did not choose.
 *
 * THE CALLER SUPPLIES THE TRANSACTION.
 */
export function recordVerification(db, {
  kind, itemId, outcome, units = null, actor = null, note = null, location = null, photo = null,
} = {}) {
  const table = tableFor(kind);
  if (!REPORTABLE.includes(outcome)) {
    throw new Error(`verification: unknown outcome '${outcome}' (want ${REPORTABLE.join('|')})`);
  }
  const who = String(actor || '').trim();
  if (!who) throw new Error('verification: every record names who looked — an unattributed check is the in_hand column again');
  if (photo != null && !['own', 'catalogue'].includes(String(photo))) {
    throw new Error(`verification: photo must be 'own' or 'catalogue' (D-030), not '${photo}'`);
  }

  const row = db.prepare(`SELECT id, sku, quantity, location FROM ${table} WHERE id = ?`).get(+itemId);
  if (!row) throw new Error(`verification: no ${kind} row ${itemId} to verify`);

  const qty = Number(row.quantity) || 0;
  let counted = units == null ? null : Math.max(0, Math.round(Number(units)));
  if (counted == null) {
    if (qty > 1) {
      throw new Error(`verification: ${kind} row ${itemId} holds ${qty} units — count them and pass units, `
        + 'because a row of many is exactly the case a verification is meant to catch');
    }
    counted = qty;   // one unit, or none: the count has one answer and asking for it is ceremony
  }

  let final = outcome;
  let downgraded = null;
  if (PASSING.includes(outcome) && counted !== qty) {
    final = 'discrepancy';
    downgraded = `counted ${counted} but the row says ${qty} — recorded as a discrepancy, and the row is `
      + 'NOT corrected here: file the difference as a stocktake movement through lib/stock-ledger.mjs, '
      + 'which is the only writer of quantity';
  }

  const info = db.prepare(`INSERT INTO stock_verifications
      (kind, item_id, sku, outcome, units, qty_cached, actor, photo, location, note)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(kind, row.id, row.sku || null, final, counted, qty, who, photo,
      location || row.location || null,
      downgraded ? [note, downgraded].filter(Boolean).join(' · ') : note);

  const at = refreshVerifiedCache(db, kind, row.id);
  return {
    ok: true, id: Number(info.lastInsertRowid), kind, item_id: row.id,
    outcome: final, requested: outcome, downgraded, units: counted, qty_cached: qty, verified_at: at,
  };
}

// --- the gate --------------------------------------------------------------------------------------

/**
 * assertVerified — the guard the publish paths call. Returns null when the row may publish, or a
 * refusal shaped like the rest of the codebase's 409 bodies ({ code, error }) when it may not.
 *
 * Shaped on assertNotReserved (lib/runs-reserve.mjs) on purpose: same return contract, same place in
 * the publish orchestrators, so there is one idiom for "a physical fact refuses this row" rather than
 * two.
 *
 * THE OVERRIDE IS DELIBERATE AND VISIBLE, never hidden, following the -SkipStoreCheck precedent in
 * bk-shopify's gates and blockIfHeld's `force` one module over: "quietly dropping a hold the owner
 * placed on purpose is the wrong failure, and so is having no override at all, because the physical
 * world does occasionally win." So `allowUnverified` PROCEEDS AND RECORDS WHY — an 'override' record,
 * append-only, naming who waived the rule and on what. It is not in PASSING, so the row still reads
 * unverified afterwards: one publish is authorised, the row is not laundered. An override on a row that
 * already passes writes nothing, because making a verified row look unverified is not an override of
 * anything.
 *
 * A DRY RUN RECORDS NOTHING. `dryRun` with `allowUnverified` passes the row without filing the override
 * row, for the reason runShopifyBatchPublish does not write channel_exports on a dry run: that table is
 * the record of what we sent to a channel, and a dry run sent nothing. A preflight that logged an
 * override every time an operator looked at the list would bury the real ones.
 *
 * THE LEDGER IS ASKED, NOT THE CACHE. verified_at exists for lists and counts over hundreds of rows;
 * a gate that trusted it could be defeated by the drift reconcile() exists to find. The authority is
 * cheap for one row and the asymmetry is the whole argument: a cache wrong in the permissive direction
 * publishes a card nobody has seen.
 */
export function assertVerified(db, kind, itemId, {
  allowUnverified = false, dryRun = false, actor = null, action = 'publish', note = null,
} = {}) {
  const st = verificationState(db, kind, itemId);
  if (st.ok) return null;

  if (allowUnverified) {
    if (dryRun) return null;
    db.prepare(`INSERT INTO stock_verifications
        (kind, item_id, sku, outcome, units, qty_cached, actor, note)
        SELECT ?, t.id, t.sku, 'override', NULL, t.quantity, ?, ?
          FROM ${tableFor(kind)} t WHERE t.id = ?`)
      .run(kind, String(actor || 'owner'),
        [`${action} while unverified`, st.outcome ? `last check: ${st.outcome}` : 'never checked', note]
          .filter(Boolean).join(' · '),
        +itemId);
    // Loud on purpose. An override that leaves no trace in the log is a hidden override with extra
    // steps, and the ledger row alone is only read by somebody who already suspects.
    console.warn(`[verification] OVERRIDE — ${kind} ${itemId} ${action}ed unverified by ${actor || 'owner'}`
      + ` (${st.outcome ? 'last check: ' + st.outcome : 'never checked'})`);
    return null;
  }

  return {
    code: 'unverified',
    kind,
    item_id: +itemId,
    outcome: st.outcome,
    last_checked_at: st.at,
    error: st.outcome
      ? `the last physical check of this row found "${st.outcome}"${st.note ? ' (' + st.note + ')' : ''} — `
        + 'check it against the item again before it goes on the storefront'
      : 'this row has never been checked against the physical item — verify it before it goes on the '
        + 'storefront, because every condition and grade on it is a claim nobody has read off the object',
  };
}

/**
 * The sealed twin. A sealed Shopify product is a POOL, and a pool is many sealed_items rows sharing a
 * pool_sku, so the question is not whether one row passes but whether every row supplying units does.
 * One unverified row in a pool of five is one unverified box in the parcel.
 *
 * Rows at zero units are deliberately skipped: they supply nothing, the pool's quantity does not count
 * them, and refusing on them would make a pool unpublishable because of a box that sold last month.
 */
export function unverifiedPoolRows(db, poolSku) {
  return db.prepare(`SELECT si.id, si.sku, si.quantity, si.verified_at
                       FROM sealed_items si
                      WHERE si.pool_sku = ? AND COALESCE(si.quantity, 0) > 0
                      ORDER BY si.id`).all(String(poolSku))
    .filter((r) => !stateFrom(latestVerification(db, 'sealed', r.id), Number(r.quantity) || 0).ok);
}

export function assertPoolVerified(db, poolSku, {
  allowUnverified = false, dryRun = false, actor = null, action = 'publish',
} = {}) {
  const bad = unverifiedPoolRows(db, poolSku);
  if (!bad.length) return null;
  if (allowUnverified) {
    for (const r of bad) {
      assertVerified(db, 'sealed', r.id, { allowUnverified: true, dryRun, actor, action, note: `pool ${poolSku}` });
    }
    return null;
  }
  return {
    code: 'unverified',
    kind: 'sealed',
    pool_sku: String(poolSku),
    item_ids: bad.map((r) => r.id),
    error: `${bad.length} of this pool's stock rows have not been checked against the physical product `
      + `(${bad.map((r) => r.sku).join(', ')}) — a pool publishes the units of every row behind it, so `
      + 'one unchecked row is one unchecked box in the parcel',
  };
}

// --- reconcile and counts --------------------------------------------------------------------------

/**
 * reconcile — every row where verified_at and the ledger disagree.
 *
 * This is what makes the cache safe to read. Report-only, for lib/stock-ledger.mjs's reason: fixing
 * drift automatically destroys the evidence of which path caused it, and that evidence is the one thing
 * worth having. A row showing up here means something wrote verified_at without going through this
 * module, and the fix is to route that path rather than to square the number.
 */
export function reconcile(db, { kind = null } = {}) {
  const out = [];
  for (const k of (kind ? [kind] : KINDS)) {
    const table = tableFor(k);
    // latestVerification + stateFrom rather than verificationState, deliberately: this asks about the
    // DATE, and verificationState would fetch each row's quantity as well, purely to answer a
    // recountDue nothing here reads. One query per row instead of two.
    for (const r of db.prepare(`SELECT id, sku, verified_at FROM ${table}`).all()) {
      const st = stateFrom(latestVerification(db, k, r.id));
      const ledger = st.ok ? st.at : null;
      if ((r.verified_at || null) !== ledger) {
        out.push({ kind: k, item_id: r.id, sku: r.sku, cached: r.verified_at || null, ledger, outcome: st.outcome });
      }
    }
  }
  return out;
}

/**
 * counts — how much of the pass is left, by shape, because none of this is usable if the owner cannot
 * see progress at the end of an evening.
 *
 * The shape tallies come from the CACHE — one scan per table, which is what makes this cheap enough to
 * run on every page load. Two of the eight numbers cannot: `failing` (the last look found something, so
 * an operator can go straight to the problems) and `recount_due` both need the newest RECORD, which is
 * one indexed lookup per row on idx_verif_item. At ~520 rows today, and ~1040 once the eBay estate
 * reset brings the other 253 raw singles in, that is the right trade — and if it ever stops being, the
 * answer is to denormalise the outcome beside verified_at, not to drop the numbers.
 *
 * `drift` is counted in the SAME pass rather than by calling reconcile(), which would walk both tables
 * a second time to re-read what this loop already holds. It is carried here at all so that a surface
 * which trusts the cache also says when the cache is not trustworthy. Note it is therefore scoped to
 * the same rows as the tallies — sold rows excluded — so it answers "can I trust these numbers" rather
 * than "is the column clean everywhere". reconcile() is the full sweep, and /api/verification/reconcile
 * is where to ask for it.
 *
 * SOLD ROWS ARE EXCLUDED. A pass is over what is on the shelf; a sold card cannot be verified and
 * cannot be published (validateProduct refuses 'sold' already), so counting it as outstanding would
 * make the number never reach zero.
 */
export function counts(db, { includeSold = false } = {}) {
  const soldSql = includeSold ? '' : " AND COALESCE(status, 'in_stock') <> 'sold'";
  let drift = 0;
  const byShape = {};
  for (const s of SHAPES) byShape[s] = { rows: 0, units: 0, verified: 0, verified_units: 0, outstanding: 0, outstanding_units: 0, failing: 0, recount_due: 0 };

  for (const [kind, table, cols] of [
    ['inventory', 'inventory_items', 'id, quantity, grading_company, verified_at'],
    ['sealed', 'sealed_items', 'id, quantity, verified_at'],
  ]) {
    for (const r of db.prepare(`SELECT ${cols} FROM ${table} WHERE 1=1${soldSql}`).all()) {
      const b = byShape[shapeOf(kind, r)];
      const u = Math.max(0, Number(r.quantity) || 0);
      b.rows += 1; b.units += u;
      if (r.verified_at) { b.verified += 1; b.verified_units += u; } else { b.outstanding += 1; b.outstanding_units += u; }
      const st = stateFrom(latestVerification(db, kind, r.id), u);
      if (!st.ok && st.outcome && st.outcome !== 'override') b.failing += 1;
      if (st.recountDue) b.recount_due += 1;
      if ((r.verified_at || null) !== (st.ok ? st.at : null)) drift += 1;
    }
  }

  const total = { rows: 0, units: 0, verified: 0, verified_units: 0, outstanding: 0, outstanding_units: 0, failing: 0, recount_due: 0 };
  for (const s of SHAPES) for (const k of Object.keys(total)) total[k] += byShape[s][k];
  return { shapes: byShape, total, drift };
}

/**
 * flags — the rows a list view needs to render something other than a plain tick or a plain blank:
 * the last look found a problem, or the row passed and its counted units have since moved.
 *
 * verified_at alone cannot answer this. It is NULL both for a row nobody has touched and for a row
 * whose last check found a discrepancy, and those two deserve different colours in front of an
 * operator — one is work not started, the other is work half done and waiting. Rather than
 * denormalising the outcome beside the date (a second cache to keep honest), the list fetches this map,
 * which is small by construction: it holds only the rows that are not in a clean state.
 *
 * NOT A GROUP BY. The latest record is ordered by (at, id) — see RE-VERIFICATION — and SQLite's
 * bare-column behaviour alongside MAX(at) cannot express the id tiebreak, which is the difference
 * between a pass and a discrepancy filed in the same second. So the whole kind is read in ascending
 * order and the last one seen per row wins, which is the same rule stated once. The ledger is roughly
 * one record per stock row, so this stays a scan of hundreds, not of a table that grows per sale.
 */
export function flags(db, { kind = null } = {}) {
  const out = {};
  for (const k of (kind ? [kind] : KINDS)) {
    const table = tableFor(k);
    const latest = new Map();
    for (const r of db.prepare('SELECT * FROM stock_verifications WHERE kind = ? ORDER BY at, id').all(k)) {
      latest.set(r.item_id, r);
    }
    if (!latest.size) { out[k] = {}; continue; }
    const qty = new Map(db.prepare(`SELECT id, quantity FROM ${table}`).all().map((r) => [r.id, Number(r.quantity) || 0]));
    const forKind = {};
    for (const [id, last] of latest) {
      const st = stateFrom(last, qty.has(id) ? qty.get(id) : null);
      if (st.ok && !st.recountDue) continue;              // clean: the list reads verified_at and is done
      forKind[id] = {
        outcome: st.outcome, at: st.at, actor: st.actor, note: st.note,
        units: st.units, quantity: qty.get(id) ?? null, recount_due: st.recountDue, ok: st.ok,
      };
    }
    out[k] = forKind;
  }
  return out;
}

/**
 * The next rows to work through, oldest-unchecked first — the resumable half of "a pass cannot be
 * resumed when work stops for the night". Location-ordered, because a pass is walked in shelf order
 * rather than in id order.
 */
export function queue(db, { shape = null, limit = 100 } = {}) {
  const want = shape && SHAPES.includes(shape) ? shape : null;
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = [];
  if (!want || want !== 'sealed') {
    for (const r of db.prepare(
      `SELECT id, sku, name, set_name, number, language, variant, grading_company, grade, cert_number,
              condition, quantity, location, status, verified_at
         FROM inventory_items
        WHERE verified_at IS NULL AND COALESCE(status,'in_stock') <> 'sold'
        ORDER BY location IS NULL, location, id LIMIT ?`).all(n)) {
      const shp = shapeOf('inventory', r);
      if (!want || want === shp) {
        rows.push({ ...r, kind: 'inventory', shape: shp, last: stateFrom(latestVerification(db, 'inventory', r.id), Number(r.quantity) || 0) });
      }
    }
  }
  if (!want || want === 'sealed') {
    for (const r of db.prepare(
      `SELECT id, sku, name, set_name, language, product_type, pool_sku, quantity, location, status, verified_at
         FROM sealed_items
        WHERE verified_at IS NULL AND COALESCE(status,'in_stock') <> 'sold'
        ORDER BY location IS NULL, location, id LIMIT ?`).all(n)) {
      rows.push({ ...r, kind: 'sealed', shape: 'sealed', last: stateFrom(latestVerification(db, 'sealed', r.id), Number(r.quantity) || 0) });
    }
  }
  return rows.slice(0, n);
}
