// lib/runs-reserve.mjs — the reservation ledger for Keeper's Runs. See docs/RUNS_PLAN.md §9.3.
//
// THIS TABLE, NOT inventory_items.status, IS WHAT "SPENT" MEANS. Adding a fourth value to that status
// enum was considered and rejected: an audit of the call sites found it would be SILENTLY IGNORED in two
// places that publish items for sale (shopify-map's validateProduct only refuses 'sold'; listings.mjs
// overwrites status on publish) while working only by accident in two others. Reservation is orthogonal
// to lifecycle — an item can be reserved whether it is in stock or already listed — so it gets its own
// writer, exactly as channel_intent is orthogonal to ebay_listings.
//
// Pure and db-taking, no HTTP. Callers pass the handle so tests can use openDbAt's temp database and
// never touch real stock.
//
// A reservation is promoted through three states, each an UPDATE of ONE row so the partial unique index
// uq_run_res_inventory_active holds throughout:
//
//     run_id NULL, bundle_id NULL   held for runs in general, flagged at intake before a run exists
//     run_id set,  bundle_id NULL   a pool hold on this run, slot not yet decided
//     run_id set,  bundle_id set    bound to a specific slot of a specific bundle
//
// LIVE states are active | committed | consumed. `released` frees the item; `broken` records an item
// that sold out from under a run anyway and is NEVER deleted — it is the incident record, and lockRun
// refuses while one exists.

// TWO STATE SETS, and conflating them double-counts stock.
//
// BLOCKING — the item is spoken for and must not be listed or sold. Includes `consumed`, because a
// packed item is spoken for permanently.
const LIVE = ['active', 'committed', 'consumed'];
const LIVE_SQL = `('${LIVE.join("','")}')`;
// ENCUMBERING — spoken for AND still physically on the shelf, so on-hand still counts it. `consumed` is
// deliberately absent: consumeReservation has already decremented the stock table, so subtracting a
// consumed reservation from on-hand would remove the same units twice.
const HELD = ['active', 'committed'];
const HELD_SQL = `('${HELD.join("','")}')`;

const nowIso = () => new Date().toISOString();

// --- predicates -----------------------------------------------------------------------------------

// The one live reservation on an inventory row, or null. Sealed rows legitimately have several (one
// sealed product backs many bundles), so this returns the FIRST for sealed and is only authoritative
// for kind='inventory' — reservedUnits is the sealed question.
export function liveReservation(db, kind, itemId) {
  return db.prepare(`SELECT r.*, ru.public_id AS run_public_id, ru.status AS run_status, ru.mode AS run_mode,
                            b.bundle_no, b.label AS bundle_label
                       FROM run_reservations r
                       LEFT JOIN runs ru ON ru.id = r.run_id
                       LEFT JOIN run_bundles b ON b.id = r.bundle_id
                      WHERE r.kind = ? AND r.item_id = ? AND r.state IN ${LIVE_SQL}
                      ORDER BY r.id LIMIT 1`).get(kind, +itemId) || null;
}

// Units of an item currently spoken for. The sealed aggregate rule lives here because SQLite cannot
// express a SUM constraint without a trigger and this repo has none.
export function reservedUnits(db, kind, itemId) {
  return db.prepare(`SELECT COALESCE(SUM(qty),0) n FROM run_reservations
                      WHERE kind = ? AND item_id = ? AND state IN ${HELD_SQL}`).get(kind, +itemId).n;
}

// Units of a whole sealed POOL spoken for. A pool is many sealed_items rows sharing a pool_sku, and
// the listing side sells the pool rather than any one row, so it needs the aggregate. It lives HERE
// rather than in the caller so the state sets above stay the only definition of "spoken for" in the
// codebase — a second hand-written `state IN (...)` is precisely how `consumed` came to be subtracted
// twice in the first draft of poolUnits.
export function reservedPoolUnits(db, poolSku) {
  return db.prepare(`SELECT COALESCE(SUM(rr.qty),0) n
                       FROM run_reservations rr
                       JOIN sealed_items si ON si.id = rr.item_id
                      WHERE si.pool_sku = ? AND rr.kind = 'sealed'
                        AND rr.state IN ${HELD_SQL}`).get(String(poolSku)).n;
}

// On-hand units for an item, read from whichever stock table its kind names.
export function onHandUnits(db, kind, itemId) {
  const t = kind === 'sealed' ? 'sealed_items' : 'inventory_items';
  const row = db.prepare(`SELECT quantity, status FROM ${t} WHERE id = ?`).get(+itemId);
  if (!row) return 0;
  if (row.status === 'sold') return 0;
  return row.quantity ?? 0;
}

// What is left to reserve. Never negative: a negative here would mean the ledger and the stock table
// already disagree, and the caller wants "nothing available", not a number it might add to.
export function availableUnits(db, kind, itemId) {
  return Math.max(0, onHandUnits(db, kind, itemId) - reservedUnits(db, kind, itemId));
}

// The guard every publish/list/reprice/sell path calls. Returns null when the item is free, or a
// refusal shaped like the rest of the codebase's 409 bodies ({ code, error }) when it is not.
//
// For sealed this deliberately does NOT refuse on any reservation — one sealed row genuinely supplies
// both a run and the shop. The sealed answer is to SHRINK the sellable quantity (see availableUnits),
// which is what lib/sealed-listing.mjs does with poolUnits.
export function assertNotReserved(db, kind, itemId) {
  if (kind === 'sealed') return null;
  const r = liveReservation(db, kind, itemId);
  if (!r) return null;
  const where = r.bundle_label ? `bundle ${r.bundle_label}`
    : r.run_public_id ? `run ${r.run_public_id}` : 'a run';
  return {
    code: 'reserved_for_run',
    reservation_id: r.id,
    run: r.run_public_id || null,
    bundle: r.bundle_label || null,
    error: `this item is reserved for ${where} and cannot be listed or sold while that holds`,
  };
}

// Is the item live on a sales channel right now? Recorded on the reservation as channel_hold so lockRun
// can refuse while one remains — "withdraw it first" becomes impossible to forget rather than a note.
export function channelHoldFor(db, kind, itemId) {
  if (kind === 'inventory') {
    const inv = db.prepare(`SELECT channel_status, ebay_listing_id FROM inventory_items WHERE id = ?`).get(+itemId);
    if (inv && inv.ebay_listing_id && inv.channel_status === 'active') return 'ebay_live';
  }
  const sh = db.prepare(`SELECT state FROM shopify_listings WHERE kind = ? AND item_id = ?`).get(kind, +itemId);
  if (sh && sh.state === 'live') return 'shopify_live';
  return null;
}

// --- ledger reads for the manifest ------------------------------------------------------------------
//
// These live HERE rather than in the route that renders them for the same reason reservedPoolUnits
// does: every one of them turns on which states count, and a second hand-written `state IN (...)`
// somewhere else is how `consumed` came to be subtracted from stock twice.
// test/invariants/runs-reservation-guards.test.mjs is what keeps it that way.

// The run a reservation belongs to, or null when it is held for runs in general. Small, but it is a
// read of this table and so it belongs on this side of the boundary.
export function reservationRun(db, id) {
  const r = db.prepare('SELECT id, run_id, bundle_id, slot, state FROM run_reservations WHERE id = ?').get(+id);
  return r || null;
}

// What is bound to each (bundle, slot) of a run — the numbers the manifest grid renders as its work
// queue. LIVE rather than HELD: a consumed slot is still a filled slot, and a bundle already packed
// must not read as needing another card.
export function boundUnits(db, runId) {
  return db.prepare(`SELECT bundle_id, slot, COALESCE(SUM(qty),0) qty
                       FROM run_reservations
                      WHERE run_id = ? AND bundle_id IS NOT NULL AND state IN ${LIVE_SQL}
                      GROUP BY bundle_id, slot`).all(+runId);
}

// Stock claimed for a run but not yet placed in a bundle. HELD, not LIVE — a pool hold that has been
// consumed is a contradiction, and showing one as still claimable would be worse than not showing it.
export function poolHolds(db, runId) {
  return db.prepare(`SELECT r.id reservation_id, r.kind, r.item_id, r.qty, r.state, r.channel_hold,
                            COALESCE(i.name, s.name) AS display_name,
                            COALESCE(i.sku, s.sku)   AS sku, i.cert_number
                       FROM run_reservations r
                  LEFT JOIN inventory_items i ON r.kind = 'inventory' AND i.id = r.item_id
                  LEFT JOIN sealed_items    s ON r.kind = 'sealed'    AND s.id = r.item_id
                      WHERE r.run_id = ? AND r.bundle_id IS NULL AND r.state IN ${HELD_SQL}
                      ORDER BY r.id`).all(+runId);
}

// THE ANSWER SHEET: which physical object is in which numbered bundle. Read live from the stock
// tables, because before lock nothing is frozen — the frozen copy is written by lockRun and is what
// actually gets hashed.
//
// The two stock tables do not carry the same columns, and the differences are real rather than an
// oversight: only sealed rows have set_code, product_type and upc, and an inventory row's finish lives
// in `variant`. Mapped explicitly rather than COALESCEd blindly, because a silently-null field reads
// as "this card has no set" instead of "ask the other table".
export function boundLines(db, runId) {
  return db.prepare(`SELECT r.id reservation_id, r.bundle_id, r.slot, r.kind, r.item_id, r.qty,
                            r.state, r.channel_hold, b.bundle_no, b.label,
                            COALESCE(i.name, s.name)         AS display_name,
                            COALESCE(i.game, s.game)         AS game,
                            i.identity_key, s.set_code,
                            COALESCE(i.set_name, s.set_name) AS set_name,
                            i.number AS card_number, i.rarity,
                            COALESCE(i.language, s.language) AS language,
                            i.variant AS finish, s.product_type, s.upc,
                            i.grading_company, i.grade, i.cert_number
                       FROM run_reservations r
                       JOIN run_bundles b ON b.id = r.bundle_id
                  LEFT JOIN inventory_items i ON r.kind = 'inventory' AND i.id = r.item_id
                  LEFT JOIN sealed_items    s ON r.kind = 'sealed'    AND s.id = r.item_id
                      WHERE r.run_id = ? AND r.bundle_id IS NOT NULL AND r.state IN ${LIVE_SQL}
                      ORDER BY b.bundle_no, r.slot, r.id`).all(+runId);
}

// --- transactions ---------------------------------------------------------------------------------

function runRow(db, runId) {
  if (runId == null) return null;
  const r = db.prepare('SELECT id, public_id, mode, status FROM runs WHERE id = ?').get(+runId);
  if (!r) throw new Error(`no such run: ${runId}`);
  return r;
}

// Hold stock. runId null means "held for runs in general" — the flag applied at intake, before any run
// exists. Passing a runId makes it a pool hold on that run; a slot comes later via assignToSlot.
export function holdForRun(db, { kind, itemId, runId = null, qty = 1, actor = null } = {}) {
  if (kind !== 'inventory' && kind !== 'sealed') throw new Error(`bad kind: ${kind}`);
  if (kind === 'inventory' && qty !== 1) throw new Error('an inventory row is one physical object; qty must be 1');
  if (!(qty >= 1)) throw new Error('qty must be at least 1');
  const run = runRow(db, runId);
  if (run && !['draft', 'locked_pending_publish'].includes(run.status)) {
    throw new Error(`run ${run.public_id} is ${run.status}; stock can only be held while it is draft`);
  }

  const stockTable = kind === 'sealed' ? 'sealed_items' : 'inventory_items';
  const stock = db.prepare(`SELECT id, quantity, status FROM ${stockTable} WHERE id = ?`).get(+itemId);
  if (!stock) throw new Error(`no such ${kind} item: ${itemId}`);
  if (stock.status === 'sold') throw new Error(`${kind} item ${itemId} is already sold`);

  // A partial reservation against a multi-quantity inventory row means the database can no longer answer
  // "this exact physical object is in bundle 7", which is the entire verification claim. Split the row
  // first. Deliberately an error rather than a silent split: the operator should see it.
  if (kind === 'inventory' && (stock.quantity ?? 1) !== 1) {
    throw new Error(`inventory item ${itemId} has quantity ${stock.quantity}; split it into single rows before holding it for a run`);
  }

  db.exec('BEGIN');
  try {
    // The sealed aggregate rule. Re-read INSIDE the transaction: a check outside it would be a race.
    if (kind === 'sealed') {
      const avail = availableUnits(db, kind, itemId);
      if (qty > avail) throw new Error(`only ${avail} of sealed item ${itemId} are free; ${qty} requested`);
    }
    // The partial unique indexes would catch a repeat anyway, but they answer in SQLite's words
    // ("UNIQUE constraint failed: run_reservations.kind, run_reservations.item_id"), which tells an
    // operator nothing about WHICH run already has the card. Ask first, so the refusal can name it.
    //
    // Deliberately MIRRORS the indexes rather than being stricter than them. uq_run_res_inventory_active
    // is unconditional (one live reservation per physical object, across every run there will ever be);
    // uq_run_res_pool is per-run, and does not bind a hold with a NULL run_id because SQLite treats
    // NULLs as distinct in a unique index. So a sealed row can carry several "held for runs in general"
    // rows and reservedUnits sums them, which is correct — a pool can be claimed in more than one go.
    const already = kind === 'inventory'
      ? liveReservation(db, kind, itemId)
      : (runId == null ? null
        : db.prepare(`SELECT r.*, ru.public_id AS run_public_id FROM run_reservations r
                      LEFT JOIN runs ru ON ru.id = r.run_id
                      WHERE r.kind = ? AND r.item_id = ? AND r.run_id = ?
                        AND r.bundle_id IS NULL AND r.state IN ${HELD_SQL}`).get(kind, +itemId, +runId));
    if (already) {
      const where = already.bundle_label ? `bundle ${already.bundle_label}`
        : already.run_public_id ? `run ${already.run_public_id}` : 'runs in general';
      throw new Error(`${kind} item ${itemId} is already held for ${where} (reservation ${already.id})`);
    }
    const hold = channelHoldFor(db, kind, itemId);
    db.prepare(`INSERT INTO run_reservations (run_id, bundle_id, kind, item_id, slot, qty, state, channel_hold)
                VALUES (?, NULL, ?, ?, NULL, ?, 'active', ?)`)
      .run(runId == null ? null : +runId, kind, +itemId, qty, hold);
    const id = db.prepare('SELECT last_insert_rowid() id').get().id;
    audit(db, { runId, entity: 'run_reservations', entityId: id, action: 'hold', actor,
      after: { kind, item_id: +itemId, qty, channel_hold: hold } });
    db.exec('COMMIT');
    return { id, channel_hold: hold };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Promote a hold onto a specific slot of a specific bundle. An UPDATE, never a second row — that is
// what keeps uq_run_res_inventory_active meaningful through the whole lifecycle.
export function assignToSlot(db, { reservationId, bundleId, slot, actor = null } = {}) {
  const res = db.prepare('SELECT * FROM run_reservations WHERE id = ?').get(+reservationId);
  if (!res) throw new Error(`no such reservation: ${reservationId}`);
  if (res.state !== 'active') throw new Error(`reservation ${reservationId} is ${res.state}; only an active hold can be assigned`);
  const bundle = db.prepare('SELECT id, run_id, label FROM run_bundles WHERE id = ?').get(+bundleId);
  if (!bundle) throw new Error(`no such bundle: ${bundleId}`);
  const run = runRow(db, bundle.run_id);
  if (run.status !== 'draft') throw new Error(`run ${run.public_id} is ${run.status}; the manifest is no longer editable`);
  if (res.run_id != null && res.run_id !== bundle.run_id) {
    throw new Error(`reservation ${reservationId} is held for a different run`);
  }
  const spec = db.prepare('SELECT * FROM run_slot_specs WHERE run_id = ? AND slot = ?').get(bundle.run_id, slot);
  if (!spec) throw new Error(`run ${run.public_id} declares no slot named '${slot}'`);
  if (spec.kind !== res.kind) throw new Error(`slot '${slot}' takes ${spec.kind} stock, not ${res.kind}`);

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE run_reservations SET run_id = ?, bundle_id = ?, slot = ? WHERE id = ?`)
      .run(bundle.run_id, bundle.id, slot, res.id);
    audit(db, { runId: bundle.run_id, bundleId: bundle.id, entity: 'run_reservations', entityId: res.id,
      action: 'assign', actor, before: { bundle_id: res.bundle_id, slot: res.slot },
      after: { bundle_id: bundle.id, slot } });
    db.exec('COMMIT');
    return { id: res.id, bundle: bundle.label, slot };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Give an item back. Free while the run is draft; after lock a reservation is `committed` and only an
// amendment moves it, so this refuses rather than quietly unpicking a published manifest.
export function releaseReservation(db, id, reason = null, actor = null) {
  const res = db.prepare('SELECT * FROM run_reservations WHERE id = ?').get(+id);
  if (!res) throw new Error(`no such reservation: ${id}`);
  if (res.state === 'released') return { id: res.id, already: true };
  if (res.state !== 'active') {
    throw new Error(`reservation ${id} is ${res.state}; only an active hold can be released — a committed one needs an amendment`);
  }
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE run_reservations SET state = 'released', released_at = ? WHERE id = ?`).run(nowIso(), res.id);
    audit(db, { runId: res.run_id, bundleId: res.bundle_id, entity: 'run_reservations', entityId: res.id,
      action: 'release', actor, note: reason, before: { state: res.state } });
    db.exec('COMMIT');
    return { id: res.id, released: true };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Physically packed: draw the units down off real stock and record the effect blob.
//
// REFUSED FOR DEV RUNS. A rehearsal runs against the real database (see docs/RUNS_PLAN.md), so
// consuming would genuinely reduce inventory for a run that will never ship. Pack-time is a logged
// no-op instead; the decrement path itself is exercised by the test suite against a temp database,
// which is where it belongs.
//
// The sealed branch calls decrementSealedItem VERBATIM rather than writing a second placement-aware
// decrement. That function is the only one in the codebase that knows to draw down placements
// largest-first, delete an emptied row, re-mirror sealed_items.quantity and location, and — critically —
// record which LOCATION each unit came off, without which a reversal cannot be reconstructed at all.
//
// IMPORTED LAZILY, AND NOT AS A STYLE CHOICE. lib/postsale.mjs imports lib/listings.mjs (for its
// loadConfig), and R0-3 puts assertNotReserved from THIS module into listings.mjs. A static import here
// would therefore close the ring listings -> runs-reserve -> postsale -> listings, which ESM resolves by
// handing one of them a half-initialised module — a binding that is undefined exactly when the module
// body runs, and works fine until it doesn't. The dynamic import breaks the cycle at load time while
// still guaranteeing there is only ever one decrement implementation.
//
// `decrementers` is a test seam only: it lets a unit test assert the call without a real decrement.
export async function consumeReservation(db, id, { actor = null, decrementers = null } = {}) {
  const res = db.prepare('SELECT * FROM run_reservations WHERE id = ?').get(+id);
  if (!res) throw new Error(`no such reservation: ${id}`);
  if (res.state === 'consumed') return { id: res.id, already: true };
  if (res.state !== 'committed') {
    throw new Error(`reservation ${id} is ${res.state}; only a committed reservation is consumed at pack time`);
  }
  const run = runRow(db, res.run_id);
  if (run && run.mode === 'dev') {
    audit(db, { runId: res.run_id, bundleId: res.bundle_id, entity: 'run_reservations', entityId: res.id,
      action: 'consume', actor, note: 'dev run — stock deliberately NOT decremented' });
    return { id: res.id, skipped: 'dev_run', consumed: false };
  }

  const { decrementInventoryItem, decrementSealedItem } = decrementers || await import('./postsale.mjs');
  db.exec('BEGIN');
  try {
    const r = res.kind === 'sealed'
      ? decrementSealedItem(db, res.item_id, res.qty)
      : decrementInventoryItem(db, res.item_id, res.qty, null);
    if (!r.ok) throw new Error(`stock decrement failed for ${res.kind} ${res.item_id}: ${r.reason}`);
    db.prepare(`UPDATE run_reservations SET state = 'consumed', stock_effect = ? WHERE id = ?`)
      .run(r.effect ? JSON.stringify(r.effect) : null, res.id);
    audit(db, { runId: res.run_id, bundleId: res.bundle_id, entity: 'run_reservations', entityId: res.id,
      action: 'consume', actor, after: { newQty: r.newQty, sold: r.sold } });
    db.exec('COMMIT');
    return { id: res.id, consumed: true, newQty: r.newQty, sold: r.sold };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Mark a reservation broken: the item sold elsewhere anyway.
//
// applyStockDecrements is deliberately NOT guarded (docs/RUNS_PLAN.md §9.3) — if a reserved slab really
// sells on eBay the sale is real, and blocking the decrement would leave the shop believing it still
// owns something a customer has paid for. So the sale proceeds and this records the incident. The row is
// never deleted, and lockRun refuses while one exists.
export function breakReservation(db, id, note = null, actor = null) {
  const res = db.prepare('SELECT * FROM run_reservations WHERE id = ?').get(+id);
  if (!res) return null;
  if (!LIVE.includes(res.state)) return null;
  db.prepare(`UPDATE run_reservations SET state = 'broken' WHERE id = ?`).run(res.id);
  audit(db, { runId: res.run_id, bundleId: res.bundle_id, entity: 'run_reservations', entityId: res.id,
    action: 'reservation_broken', actor, note, before: { state: res.state } });
  return { id: res.id, broken: true };
}

// Abandon a whole run and give every item back, INCLUDING committed reservations.
//
// DEV RUNS ONLY. A rehearsal against real stock has to be recoverable or it would silently lock up
// inventory that is genuinely for sale; a live run has no such escape hatch, because releasing a
// committed reservation is exactly the "quietly unpick a published manifest" move the design forbids.
export function abandonRun(db, runId, { actor = null, reason = null } = {}) {
  const run = runRow(db, runId);
  if (run.mode !== 'dev') {
    throw new Error(`run ${run.public_id} is a live run; abandon exists only for dev rehearsals — a live run is amended, never unpicked`);
  }
  db.exec('BEGIN');
  try {
    const held = db.prepare(`SELECT id FROM run_reservations WHERE run_id = ? AND state IN ${LIVE_SQL}`).all(run.id);
    db.prepare(`UPDATE run_reservations SET state = 'released', released_at = ?
                 WHERE run_id = ? AND state IN ${LIVE_SQL}`).run(nowIso(), run.id);
    db.prepare(`UPDATE runs SET status = 'abandoned', updated_at = datetime('now') WHERE id = ?`).run(run.id);
    audit(db, { runId: run.id, entity: 'runs', entityId: run.id, action: 'abandon', actor, note: reason,
      after: { released: held.length } });
    db.exec('COMMIT');
    return { run: run.public_id, released: held.length };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// How much real stock a dev run is holding. Surfaced on /api/status because silently locked inventory is
// the specific failure mode of rehearsing against the live database.
export function devRunHoldings(db) {
  return db.prepare(`SELECT ru.public_id AS run, COUNT(*) AS reservations, COALESCE(SUM(r.qty),0) AS units
                       FROM run_reservations r JOIN runs ru ON ru.id = r.run_id
                      WHERE ru.mode = 'dev' AND r.state IN ${LIVE_SQL}
                      GROUP BY ru.public_id ORDER BY ru.public_id`).all();
}

// --- audit ----------------------------------------------------------------------------------------

export function audit(db, { runId = null, bundleId = null, entity, entityId = null, action,
  actor = null, before = null, after = null, note = null } = {}) {
  db.prepare(`INSERT INTO run_audit (run_id, bundle_id, entity, entity_id, action, actor,
                                     before_json, after_json, note)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(runId == null ? null : +runId, bundleId == null ? null : +bundleId, entity,
      entityId == null ? null : +entityId, action, actor,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, note);
}
