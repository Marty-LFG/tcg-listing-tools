// test/unit/verification.test.mjs — the verification ledger, and the two rules that make it worth
// having rather than a boolean.
//
// THE INVARIANT: verified_at on a stock row is the `at` of the newest verification record, if that
// record passed, and NULL otherwise. The column is a cache of the ledger, exactly as
// inventory_items.quantity is a cache of stock_movements, and a cache that can disagree with its source
// without anyone noticing is the state lib/verification.mjs exists to end.
//
// Shaped on test/unit/stock-ledger.test.mjs on purpose: its own temp DB, a clean table per test, and an
// assertion over the WHOLE table rather than one row, because a record filed against the wrong id
// squares its own row and breaks another.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { applyMovement } from '../../lib/stock-ledger.mjs';
import {
  OUTCOMES, PASSING, REPORTABLE, SHAPES, shapeOf,
  recordVerification, latestVerification, verificationState, verificationsFor,
  refreshVerifiedCache, assertVerified, assertPoolVerified, unverifiedPoolRows,
  reconcile, counts, queue, flags,
} from '../../lib/verification.mjs';

let tmpDir, db;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-verif-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
});
after(() => { try { db.close(); } catch { /* already closed */ } fs.rmSync(tmpDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec('DELETE FROM stock_verifications; DELETE FROM stock_movements; DELETE FROM inventory_items; DELETE FROM sealed_items; DELETE FROM sealed_placements;');
});

let seq = 0;
const mkRaw = (qty = 1, extra = {}) => Number(db.prepare(
  `INSERT INTO inventory_items (sku, game, name, condition, quantity, location, status)
   VALUES (?,'pokemon','Pikachu','Near Mint',?,?,?)`)
  .run('AAC-' + String(++seq).padStart(3, '0'), qty, extra.location || 'Binder 1', extra.status || 'in_stock').lastInsertRowid);
const mkSlab = (qty = 1, extra = {}) => Number(db.prepare(
  `INSERT INTO inventory_items (sku, game, name, quantity, grading_company, grade, cert_number, status)
   VALUES (?,'pokemon','Charizard',?,'PSA',8,?,?)`)
  .run('AAC-' + String(++seq).padStart(3, '0'), qty, '8451' + seq, extra.status || 'in_stock').lastInsertRowid);
const mkSealed = (qty = 1, pool = 'BKS-POOL-1', extra = {}) => Number(db.prepare(
  `INSERT INTO sealed_items (sku, game, product_type, name, quantity, pool_sku, status)
   VALUES (?,'pokemon','booster_box','White Flare Booster Box',?,?,?)`)
  .run('BK-SLD-' + String(++seq).padStart(3, '0'), qty, pool, extra.status || 'in_stock').lastInsertRowid);

const cachedAt = (kind, id) => db.prepare(
  `SELECT verified_at FROM ${kind === 'sealed' ? 'sealed_items' : 'inventory_items'} WHERE id = ?`).get(id).verified_at;
const qtyOf = (kind, id) => db.prepare(
  `SELECT quantity FROM ${kind === 'sealed' ? 'sealed_items' : 'inventory_items'} WHERE id = ?`).get(id).quantity;
const rec = (kind, id, outcome, extra = {}) => recordVerification(db, { kind, itemId: id, outcome, actor: 'marty', ...extra });

// The invariant over the whole table, not one row.
function assertCacheHonest(msg) {
  assert.deepEqual(reconcile(db), [], msg || 'verified_at and the ledger disagree');
}

describe('the vocabulary', () => {
  it('passes on verified and corrected, and on nothing else', () => {
    assert.deepEqual([...PASSING], ['verified', 'corrected']);
  });

  it('offers five outcomes to a person with the item in hand, and never offers override', () => {
    assert.deepEqual(REPORTABLE, ['verified', 'corrected', 'discrepancy', 'missing', 'unavailable']);
    assert.ok(OUTCOMES.override, 'override still exists as an outcome, it is just not reportable');
  });

  it('refuses an outcome outside the vocabulary rather than filing a row nobody can read', () => {
    const id = mkRaw();
    assert.throws(() => rec('inventory', id, 'looked-ok'), /unknown outcome/);
    assert.throws(() => rec('inventory', id, 'override'), /unknown outcome/,
      'override is the gate\'s to write, never an operator\'s');
  });

  it('refuses an unattributed check, because that is the in_hand column again', () => {
    const id = mkRaw();
    assert.throws(() => recordVerification(db, { kind: 'inventory', itemId: id, outcome: 'verified' }), /names who looked/);
    assert.throws(() => recordVerification(db, { kind: 'inventory', itemId: id, outcome: 'verified', actor: '  ' }), /names who looked/);
  });

  it('refuses a record filed against a row that does not exist', () => {
    assert.throws(() => rec('inventory', 999999, 'verified'), /no inventory row/);
  });

  it('refuses an unknown kind, and a photo claim outside D-030\'s two', () => {
    const id = mkRaw();
    assert.throws(() => rec('card', id, 'verified'), /unknown kind/);
    assert.throws(() => rec('inventory', id, 'verified', { photo: 'stock' }), /photo must be/);
    assert.equal(rec('inventory', id, 'verified', { photo: 'own' }).ok, true);
  });

  it('sorts a row into its shape: a slab, a raw single, a sealed box', () => {
    assert.deepEqual([...SHAPES], ['graded', 'raw', 'sealed']);
    assert.equal(shapeOf('inventory', { grading_company: 'PSA' }), 'graded');
    assert.equal(shapeOf('inventory', { grading_company: null }), 'raw');
    assert.equal(shapeOf('sealed', {}), 'sealed');
  });
});

describe('the ledger is the authority and verified_at is its cache', () => {
  it('a pass writes both, and they agree', () => {
    const id = mkRaw();
    const r = rec('inventory', id, 'verified');
    assert.equal(r.outcome, 'verified');
    assert.ok(r.verified_at, 'the record returned no timestamp');
    assert.equal(cachedAt('inventory', id), r.verified_at, 'the cache was not brought forward');
    assert.equal(verificationState(db, 'inventory', id).ok, true);
    assertCacheHonest();
  });

  it('a row nobody has touched reads as never checked, which is NOT the same as a failed check', () => {
    const id = mkRaw();
    const st = verificationState(db, 'inventory', id);
    assert.equal(st.ok, false);
    assert.equal(st.outcome, null, 'never checked must be distinguishable from a check that found something');
    assert.equal(cachedAt('inventory', id), null);
  });

  it('covers both stock tables through one code path', () => {
    const inv = mkRaw();
    const sld = mkSealed(1);
    rec('inventory', inv, 'verified');
    rec('sealed', sld, 'verified');
    assert.ok(cachedAt('inventory', inv) && cachedAt('sealed', sld));
    assertCacheHonest();
  });

  it('keeps the whole history, newest first, rather than collapsing to a flag', () => {
    const id = mkRaw();
    rec('inventory', id, 'discrepancy', { note: 'grade reads 8, slab says 7' });
    rec('inventory', id, 'corrected', { note: 'row fixed to 7' });
    const h = verificationsFor(db, 'inventory', id);
    assert.equal(h.length, 2);
    assert.equal(h[0].outcome, 'corrected', 'newest first');
    assert.match(h[1].note, /grade reads 8/, 'the discrepancy that found it is still on the record');
  });

  it('records what the row claimed at the time, so a record re-reads a year later', () => {
    const id = mkSealed(4);
    rec('sealed', id, 'verified', { units: 4 });
    const last = latestVerification(db, 'sealed', id);
    assert.equal(last.units, 4);
    assert.equal(last.qty_cached, 4, 'a count with nothing to be a count against is not a record');
  });
});

// ---------------------------------------------------------------------------------------------------
// DESIGN ANSWER 1: re-verification is LATEST WINS, not a high-water mark.
describe('the latest look wins, including when it is bad news', () => {
  it('a discrepancy after a pass invalidates the row and the gate refuses again', () => {
    const id = mkRaw();
    rec('inventory', id, 'verified');
    assert.equal(assertVerified(db, 'inventory', id), null, 'it passed a moment ago');

    rec('inventory', id, 'discrepancy', { note: 'this is Lightly Played, not Near Mint' });
    assert.equal(cachedAt('inventory', id), null, 'a high-water mark would have left the date standing');
    const refusal = assertVerified(db, 'inventory', id);
    assert.equal(refusal.code, 'unverified');
    assert.match(refusal.error, /found "discrepancy"/);
    assert.match(refusal.error, /Lightly Played/, 'the refusal says what the last look found');
    assertCacheHonest();
  });

  it('and a later pass restores it, which is the only way to clear a discrepancy', () => {
    const id = mkRaw();
    rec('inventory', id, 'verified');
    rec('inventory', id, 'discrepancy');
    rec('inventory', id, 'corrected', { note: 'condition fixed on the row' });
    assert.ok(cachedAt('inventory', id));
    assert.equal(assertVerified(db, 'inventory', id), null);
    assertCacheHonest();
  });

  it('missing and unavailable also invalidate, and say different things', () => {
    for (const outcome of ['missing', 'unavailable']) {
      const id = mkRaw();
      rec('inventory', id, 'verified');
      rec('inventory', id, outcome);
      assert.equal(cachedAt('inventory', id), null, `${outcome} must invalidate`);
      assert.equal(verificationState(db, 'inventory', id).outcome, outcome,
        'the two must stay distinguishable: one is evidence of loss, the other is not');
    }
    assertCacheHonest();
  });

  it('breaks a same-second tie on id, because a bulk pass files many records inside one second', () => {
    const id = mkRaw();
    const at = '2026-10-16 11:00:00';
    // Written straight in, with one `at`, which is the shape a bulk pass produces. Ordering by `at`
    // alone leaves this undefined, and undefined here is the difference between a gate that refuses
    // and a gate that does not.
    const ins = db.prepare(`INSERT INTO stock_verifications (kind, item_id, outcome, units, qty_cached, actor, at)
                            VALUES ('inventory',?,?,1,1,'marty',?)`);
    ins.run(id, 'verified', at);
    ins.run(id, 'discrepancy', at);
    assert.equal(verificationState(db, 'inventory', id).outcome, 'discrepancy', 'the later id must win');
    assert.equal(refreshVerifiedCache(db, 'inventory', id), null);
    assert.equal(assertVerified(db, 'inventory', id).code, 'unverified');
  });
});

// ---------------------------------------------------------------------------------------------------
// DESIGN ANSWER 2: a verification counts units, and a disagreement refuses rather than corrects.
describe('the unit count, and what a disagreement does', () => {
  it('defaults the count on a row holding one unit, because asking is ceremony', () => {
    const id = mkSlab(1);
    const r = rec('inventory', id, 'verified');
    assert.equal(r.units, 1);
    assert.equal(r.downgraded, null);
  });

  it('REQUIRES a count on a row holding more than one, because that is the case this catches', () => {
    const id = mkSealed(6);
    assert.throws(() => rec('sealed', id, 'verified'), /holds 6 units/);
    assert.equal(cachedAt('sealed', id), null, 'a refused record must leave the cache alone');
  });

  it('a count that matches passes', () => {
    const id = mkSealed(6);
    const r = rec('sealed', id, 'verified', { units: 6 });
    assert.equal(r.outcome, 'verified');
    assert.ok(cachedAt('sealed', id));
  });

  it('a count that DISAGREES is recorded as a discrepancy, not as the pass that was asked for', () => {
    const id = mkSealed(6);
    const r = rec('sealed', id, 'verified', { units: 5 });
    assert.equal(r.requested, 'verified');
    assert.equal(r.outcome, 'discrepancy', 'five boxes on a shelf that claims six is the defect, not a pass');
    assert.ok(r.downgraded, 'the downgrade has to be returned, or the operator is told something false');
    assert.match(r.downgraded, /counted 5 but the row says 6/);
    assert.equal(cachedAt('sealed', id), null);
    assert.equal(assertVerified(db, 'sealed', id).code, 'unverified');
  });

  it('and NOTHING corrects the quantity, because lib/stock-ledger.mjs is its only writer', () => {
    const id = mkSealed(6);
    rec('sealed', id, 'verified', { units: 5 });
    assert.equal(qtyOf('sealed', id), 6, 'the verification moved quantity; a second writer of that column is the defect');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE kind = ?').get('sealed').n, 0,
      'and it must not file a movement either — a stocktake is the operator\'s call, with a reason attached');
    assert.match(rec('sealed', id, 'verified', { units: 5 }).downgraded, /stocktake movement/,
      'the operator is told which movement to file');
  });

  it('a count against a row that later moves is a RECOUNT, reported and never refused', () => {
    const id = mkSealed(6);
    rec('sealed', id, 'verified', { units: 6 });
    // Six more arrive against a purchase order. `receive` is itself a physical handling of the units,
    // so the check still stands; the COUNT is what went stale.
    db.exec('BEGIN');
    applyMovement(db, { kind: 'sealed', itemId: id, delta: 6, reason: 'receive' });
    db.exec('COMMIT');
    const st = verificationState(db, 'sealed', id);
    assert.equal(st.ok, true, 'a receive must not un-verify a pool');
    assert.equal(st.recountDue, true);
    assert.equal(assertVerified(db, 'sealed', id), null, 'a stale count is not a refusal');
    assert.equal(counts(db).shapes.sealed.recount_due, 1, 'but it is visible');
    assertCacheHonest();
  });

  it('a sale is the reason a movement must not invalidate: the remainder still publishes', () => {
    const id = mkSealed(3);
    rec('sealed', id, 'verified', { units: 3 });
    db.exec('BEGIN');
    applyMovement(db, { kind: 'sealed', itemId: id, delta: -1, reason: 'sale', refKind: 'order', refId: 'A-1' });
    db.exec('COMMIT');
    assert.equal(assertVerified(db, 'sealed', id), null, 'selling one box must not stop the other two publishing');
  });
});

describe('the gate, and its deliberate override', () => {
  it('refuses a row nobody has checked, and says why in a sentence an operator can act on', () => {
    const id = mkSlab();
    const r = assertVerified(db, 'inventory', id);
    assert.equal(r.code, 'unverified');
    assert.equal(r.item_id, id);
    assert.match(r.error, /never been checked against the physical item/);
    assert.match(r.error, /nobody has read off the object/);
  });

  it('the override PROCEEDS and records why, as an append-only row naming who waived it', () => {
    const id = mkSlab();
    assert.equal(assertVerified(db, 'inventory', id, { allowUnverified: true, actor: 'marty' }), null);
    const h = verificationsFor(db, 'inventory', id);
    assert.equal(h.length, 1);
    assert.equal(h[0].outcome, 'override');
    assert.equal(h[0].actor, 'marty');
    assert.match(h[0].note, /never checked/);
  });

  it('and the override does NOT launder the row into verified', () => {
    const id = mkSlab();
    assertVerified(db, 'inventory', id, { allowUnverified: true, actor: 'marty' });
    assert.equal(cachedAt('inventory', id), null, 'one publish was authorised, not the row');
    assert.equal(assertVerified(db, 'inventory', id).code, 'unverified', 'the next publish must refuse again');
    assert.equal(counts(db).shapes.graded.failing, 0, 'an override is not a failed check either');
    assertCacheHonest();
  });

  it('a dry run writes no override row, because a dry run publishes nothing', () => {
    const id = mkSlab();
    assert.equal(assertVerified(db, 'inventory', id, { allowUnverified: true, dryRun: true }), null);
    assert.equal(verificationsFor(db, 'inventory', id).length, 0,
      'a preflight that logged an override every time somebody looked would bury the real ones');
  });

  it('an override on a row that already passes writes nothing, because there is nothing to waive', () => {
    const id = mkSlab();
    rec('inventory', id, 'verified');
    const before = verificationsFor(db, 'inventory', id).length;
    assert.equal(assertVerified(db, 'inventory', id, { allowUnverified: true, actor: 'marty' }), null);
    assert.equal(verificationsFor(db, 'inventory', id).length, before,
      'an override must never be able to un-verify a verified row');
    assert.ok(cachedAt('inventory', id));
  });
});

describe('a sealed POOL is every row behind it', () => {
  it('refuses while one row of the pool is unchecked, and names the rows', () => {
    const a = mkSealed(2, 'BKS-POOL-A');
    const b = mkSealed(3, 'BKS-POOL-A');
    rec('sealed', a, 'verified', { units: 2 });
    const r = assertPoolVerified(db, 'BKS-POOL-A');
    assert.equal(r.code, 'unverified');
    assert.deepEqual(r.item_ids, [b]);
    assert.match(r.error, /one unchecked row is one unchecked box in the parcel/);
  });

  it('passes once every row holding units has been checked', () => {
    const a = mkSealed(2, 'BKS-POOL-B');
    const b = mkSealed(3, 'BKS-POOL-B');
    rec('sealed', a, 'verified', { units: 2 });
    rec('sealed', b, 'verified', { units: 3 });
    assert.equal(assertPoolVerified(db, 'BKS-POOL-B'), null);
  });

  it('skips a row at zero units, so a box that sold last month cannot block the pool', () => {
    const live = mkSealed(2, 'BKS-POOL-C');
    mkSealed(0, 'BKS-POOL-C');
    rec('sealed', live, 'verified', { units: 2 });
    assert.deepEqual(unverifiedPoolRows(db, 'BKS-POOL-C'), []);
    assert.equal(assertPoolVerified(db, 'BKS-POOL-C'), null);
  });

  it('the pool override files one row PER unchecked card, so the record names each one', () => {
    const a = mkSealed(2, 'BKS-POOL-D');
    const b = mkSealed(3, 'BKS-POOL-D');
    assert.equal(assertPoolVerified(db, 'BKS-POOL-D', { allowUnverified: true, actor: 'marty' }), null);
    assert.equal(verificationsFor(db, 'sealed', a)[0].outcome, 'override');
    assert.equal(verificationsFor(db, 'sealed', b)[0].outcome, 'override');
  });
});

describe('reconcile reports drift rather than repairing it', () => {
  it('names a row whose verified_at was written outside the ledger', () => {
    const id = mkRaw();
    db.prepare("UPDATE inventory_items SET verified_at = '2026-01-01 00:00:00' WHERE id = ?").run(id);
    const drift = reconcile(db);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].item_id, id);
    assert.equal(drift[0].cached, '2026-01-01 00:00:00');
    assert.equal(drift[0].ledger, null);
  });

  it('names a row whose date was cleared behind the ledger\'s back, in the other direction', () => {
    const id = mkRaw();
    rec('inventory', id, 'verified');
    db.prepare('UPDATE inventory_items SET verified_at = NULL WHERE id = ?').run(id);
    assert.equal(reconcile(db).length, 1);
    // And the gate is NOT fooled by it, which is the whole reason it asks the ledger.
    assert.equal(assertVerified(db, 'inventory', id), null,
      'the gate reads the ledger, so a cleared cache cannot refuse a row that genuinely passed');
    refreshVerifiedCache(db, 'inventory', id);
    assertCacheHonest('the cache squares once the ledger is asked again');
  });

  it('covers both stock tables, and scopes to one kind on request', () => {
    const inv = mkRaw(); const sld = mkSealed(1);
    db.prepare("UPDATE inventory_items SET verified_at = '2026-01-01' WHERE id = ?").run(inv);
    db.prepare("UPDATE sealed_items SET verified_at = '2026-01-01' WHERE id = ?").run(sld);
    assert.equal(reconcile(db).length, 2);
    assert.deepEqual(reconcile(db, { kind: 'sealed' }).map((r) => r.item_id), [sld]);
  });
});

describe('counts answer "how much is left", by shape', () => {
  it('splits slabs, raw singles and sealed, in rows and in units', () => {
    mkSlab(); mkSlab();
    mkRaw();
    mkSealed(6); mkSealed(2);
    const c = counts(db);
    assert.equal(c.shapes.graded.rows, 2);
    assert.equal(c.shapes.raw.rows, 1);
    assert.equal(c.shapes.sealed.rows, 2);
    assert.equal(c.shapes.sealed.units, 8, 'a sealed row of six is six objects to pick up');
    assert.equal(c.total.rows, 5);
    assert.equal(c.total.outstanding, 5, 'nothing starts verified, and that is deliberate');
    assert.equal(c.total.verified, 0);
  });

  it('moves a row from outstanding to verified as the pass progresses', () => {
    const a = mkSlab(); mkSlab();
    rec('inventory', a, 'verified');
    const c = counts(db);
    assert.equal(c.shapes.graded.verified, 1);
    assert.equal(c.shapes.graded.outstanding, 1);
    assert.equal(c.total.failing, 0);
  });

  it('counts a failed check separately, so an operator can go straight to the problems', () => {
    const a = mkRaw();
    rec('inventory', a, 'missing');
    const c = counts(db);
    assert.equal(c.shapes.raw.outstanding, 1);
    assert.equal(c.shapes.raw.failing, 1, 'work half done is not work not started');
  });

  it('excludes sold rows, or the number can never reach zero', () => {
    mkRaw(1, { status: 'sold' });
    mkRaw();
    assert.equal(counts(db).total.rows, 1);
    assert.equal(counts(db, { includeSold: true }).total.rows, 2);
  });

  it('carries the drift count, so a surface that trusts the cache says when it should not', () => {
    const id = mkRaw();
    db.prepare("UPDATE inventory_items SET verified_at = '2026-01-01' WHERE id = ?").run(id);
    assert.equal(counts(db).drift, 1);
  });
});

describe('the queue makes a pass resumable, and flags make a list readable', () => {
  it('lists unchecked rows in shelf order, and drops each one as it is checked', () => {
    const a = mkRaw(1, { location: 'Binder 2' });
    const b = mkRaw(1, { location: 'Binder 1' });
    assert.deepEqual(queue(db).map((r) => r.id), [b, a], 'a pass is walked in shelf order, not id order');
    rec('inventory', b, 'verified');
    assert.deepEqual(queue(db).map((r) => r.id), [a], 'stop for the night, come back, carry on');
  });

  it('filters to one shape, because 84 slabs is a different sitting from 147 sealed rows', () => {
    mkSlab(); const raw = mkRaw(); const sld = mkSealed(1);
    assert.deepEqual(queue(db, { shape: 'raw' }).map((r) => r.id), [raw]);
    assert.deepEqual(queue(db, { shape: 'sealed' }).map((r) => r.id), [sld]);
    assert.equal(queue(db, { shape: 'graded' }).length, 1);
  });

  it('excludes sold rows, which cannot be checked and cannot be published', () => {
    mkRaw(1, { status: 'sold' });
    assert.equal(queue(db).length, 0);
  });

  it('flags only the rows a list cannot draw from verified_at alone', () => {
    const clean = mkRaw(); const bad = mkRaw(); const never = mkRaw();
    rec('inventory', clean, 'verified');
    rec('inventory', bad, 'discrepancy', { note: 'wrong set' });
    const f = flags(db, { kind: 'inventory' }).inventory;
    assert.ok(!(clean in f), 'a clean pass needs no flag: the date says it');
    assert.ok(!(never in f), 'and neither does a row with no record: the absent date says it');
    assert.equal(f[bad].outcome, 'discrepancy');
    assert.equal(f[bad].note, 'wrong set');
    assert.equal(f[bad].ok, false);
  });

  it('flags a passing row whose count has moved, so "verified" does not hide a recount', () => {
    const id = mkSealed(4);
    rec('sealed', id, 'verified', { units: 4 });
    db.exec('BEGIN');
    applyMovement(db, { kind: 'sealed', itemId: id, delta: 2, reason: 'receive' });
    db.exec('COMMIT');
    const f = flags(db, { kind: 'sealed' }).sealed;
    assert.equal(f[id].recount_due, true);
    assert.equal(f[id].ok, true, 'it still passes; it just needs counting again');
    assert.equal(f[id].units, 4);
    assert.equal(f[id].quantity, 6);
  });
});
