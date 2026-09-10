// test/unit/runs-schema.test.mjs — Keeper's Runs schema (migrateRuns in lib/db.mjs).
//
// The point of this file is narrow and worth stating: it proves THE DATABASE REFUSES, not that some
// code path remembers to check. Every invariant in docs/RUNS_PLAN.md §9.2 is a constraint or a partial
// unique index, and a test that only exercised the happy path would pass just as well against a schema
// with none of them. So each case below attempts the illegal write and asserts it throws.
//
// openDbAt (not openDb) because the singleton would hand back the real data/tracker.db regardless of the
// path passed — the seam test/helpers exists for.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';

const db = openDbAt(tmpFile('runs-schema.db'));

const TABLES = ['runs', 'run_slot_specs', 'run_bundles', 'run_reservations', 'run_bundle_slots',
  'run_chase_tiers', 'run_earmarks', 'run_amendments', 'run_claims', 'run_anchors', 'run_ledger',
  'run_audit'];
const VIEWS = ['v_run_public_slot', 'v_run_public_bundle', 'v_run_public_run'];

// Money must exist on exactly one column in the whole schema; the public views are what make that
// structural rather than a filter someone can forget.
//
// SEGMENT-ANCHORED deliberately. The spec's first draft of this pattern was unanchored, which matched
// `grading_company` (via "comp") and a bare `value` — both legitimate non-money fields — so a sanitiser
// built from it would have thrown on a perfectly valid public payload. Money in this codebase is always
// a `*_cents` column, so anchoring loses nothing.
const MONEY = /(^|_)(cents|price|cost|paid|amount|aud|usd|profit|margin|rrp)($|_)/i;

const throws = (fn) => assert.throws(fn, (e) => e instanceof Error);

let runSeq = 0;
function mkRun(over = {}) {
  const n = ++runSeq;
  const row = { public_id: `E${n}`, edition: n, name: `Edition ${n}`, mode: 'live',
    unit_count: 3, status: 'draft', ...over };
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status)
              VALUES (?,?,?,?,?,?)`)
    .run(row.public_id, row.edition, row.name, row.mode, row.unit_count, row.status);
  return db.prepare('SELECT id FROM runs WHERE public_id = ?').get(row.public_id).id;
}
function mkBundle(runId, no, over = {}) {
  db.prepare(`INSERT INTO run_bundles (run_id, bundle_no, label, salt_hex, verify_code, seal_serial)
              VALUES (?,?,?,?,?,?)`)
    .run(runId, no, over.label ?? `R${runId}-${String(no).padStart(3, '0')}`,
      over.salt_hex ?? null, over.verify_code ?? null, over.seal_serial ?? null);
  return db.prepare('SELECT id FROM run_bundles WHERE run_id = ? AND bundle_no = ?').get(runId, no).id;
}
function mkRes(over = {}) {
  const r = { run_id: null, bundle_id: null, kind: 'inventory', item_id: 1, slot: null, qty: 1,
    state: 'active', ...over };
  db.prepare(`INSERT INTO run_reservations (run_id, bundle_id, kind, item_id, slot, qty, state)
              VALUES (?,?,?,?,?,?,?)`)
    .run(r.run_id, r.bundle_id, r.kind, r.item_id, r.slot, r.qty, r.state);
  return db.prepare('SELECT last_insert_rowid() id').get().id;
}
function mkSlot(bundleId, over = {}) {
  const s = { slot: 'slab', seq: 0, kind: 'inventory', item_id: 1, qty: 1,
    slot_singleton: 1, slot_requires_cert: 0, cert_number: null, ...over };
  const resId = s.reservation_id ?? mkRes({ item_id: 900000 + Math.floor(Math.random() * 1e6) });
  db.prepare(`INSERT INTO run_bundle_slots
      (bundle_id, slot, seq, reservation_id, kind, item_id, qty, slot_singleton, slot_requires_cert, cert_number)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(bundleId, s.slot, s.seq, resId, s.kind, s.item_id, s.qty,
      s.slot_singleton, s.slot_requires_cert, s.cert_number);
}

describe('migrateRuns — shape', () => {
  it('creates every table and view', () => {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
      .all().map((r) => r.name);
    for (const t of [...TABLES, ...VIEWS]) assert.ok(names.includes(t), `missing ${t}`);
  });

  it('leaves the existing tracker tables alone', () => {
    for (const t of ['inventory_items', 'sealed_items', 'shopify_listings']) {
      assert.ok(db.prepare(`SELECT count(*) n FROM ${t}`).get().n >= 0, `${t} unusable`);
    }
  });

  it('puts money on exactly one column in the whole runs schema', () => {
    const found = [];
    for (const t of TABLES) {
      for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) {
        if (MONEY.test(c.name)) found.push(`${t}.${c.name}`);
      }
    }
    // target_cents is internal-only and never reaches a public DTO; unit_price_cents is the run price.
    assert.deepEqual(found.sort(), ['run_chase_tiers.target_cents', 'runs.unit_price_cents']);
  });

  it('keeps every money column and every possession token out of the public views', () => {
    for (const v of VIEWS) {
      for (const c of db.prepare(`PRAGMA table_info(${v})`).all()) {
        assert.ok(!MONEY.test(c.name), `${v} exposes ${c.name}`);
        assert.ok(!['salt_hex', 'verify_code', 'seal_serial'].includes(c.name),
          `${v} exposes ${c.name}`);
      }
    }
  });
});

describe('migrateRuns — the database refuses', () => {
  it('INVARIANT 1: a singleton slot cannot hold two lines in one bundle', () => {
    const b = mkBundle(mkRun(), 1);
    mkSlot(b, { seq: 0, slot_singleton: 1 });
    throws(() => mkSlot(b, { seq: 1, slot_singleton: 1 }));
    // ...but a non-singleton slot legitimately can.
    const b2 = mkBundle(mkRun(), 1);
    mkSlot(b2, { slot: 'packs', seq: 0, slot_singleton: 0, kind: 'sealed' });
    mkSlot(b2, { slot: 'packs', seq: 1, slot_singleton: 0, kind: 'sealed' });
  });

  it('INVARIANT 2: one live reservation per inventory row, across all runs', () => {
    mkRes({ item_id: 4242, state: 'active' });
    throws(() => mkRes({ item_id: 4242, state: 'active' }));
    throws(() => mkRes({ item_id: 4242, state: 'committed' }));
    // a released one does not block a fresh hold
    mkRes({ item_id: 4343, state: 'released' });
    mkRes({ item_id: 4343, state: 'active' });
    // sealed is deliberately exempt: one row backs many bundles
    mkRes({ kind: 'sealed', item_id: 5150, qty: 3 });
    mkRes({ kind: 'sealed', item_id: 5150, qty: 2 });
  });

  it('INVARIANT 3: a cert appears in at most one bundle, ever', () => {
    const b1 = mkBundle(mkRun(), 1);
    const b2 = mkBundle(mkRun(), 1);
    mkSlot(b1, { slot_requires_cert: 1, cert_number: '11112222' });
    throws(() => mkSlot(b2, { slot_requires_cert: 1, cert_number: '11112222' }));
  });

  it('INVARIANT 4: a slot requiring a cert must carry one', () => {
    const b = mkBundle(mkRun(), 1);
    throws(() => mkSlot(b, { slot_requires_cert: 1, cert_number: null }));
    throws(() => mkSlot(b, { slot_requires_cert: 1, cert_number: '' }));
  });

  it('INVARIANT 4: a run past draft must carry its commitment', () => {
    const id = mkRun();
    throws(() => db.prepare(`UPDATE runs SET status='locked_published' WHERE id=?`).run(id));
    db.prepare(`UPDATE runs SET status='locked_published', run_root='aa', header_digest='bb',
                locked_at=datetime('now') WHERE id=?`).run(id);
    assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(id).status, 'locked_published');
  });

  it('ties mode to the DEV- identifier prefix in both directions', () => {
    throws(() => mkRun({ mode: 'dev', public_id: 'E999' }));
    throws(() => mkRun({ mode: 'live', public_id: 'DEV-E999' }));
    mkRun({ mode: 'dev', public_id: 'DEV-E1000' });
  });

  it('holds stock for runs in general, then promotes without a second row', () => {
    const id = mkRes({ run_id: null, item_id: 7777 });          // held for runs, no run yet
    const runId = mkRun();
    const b = mkBundle(runId, 1);
    db.prepare('UPDATE run_reservations SET run_id=? WHERE id=?').run(runId, id);   // held for this run
    db.prepare('UPDATE run_reservations SET bundle_id=?, slot=? WHERE id=?').run(b, 'slab', id);
    assert.equal(db.prepare(`SELECT count(*) n FROM run_reservations WHERE item_id=7777`).get().n, 1);
  });

  it('refuses a half-assigned reservation, and one pool hold per run per item', () => {
    const runId = mkRun();
    const b = mkBundle(runId, 1);
    throws(() => mkRes({ run_id: runId, bundle_id: b, slot: null, item_id: 8888 }));
    throws(() => mkRes({ run_id: runId, bundle_id: null, slot: 'slab', item_id: 8888 }));
    mkRes({ run_id: runId, kind: 'sealed', item_id: 8889 });
    throws(() => mkRes({ run_id: runId, kind: 'sealed', item_id: 8889 }));
  });

  it('refuses a slot whose reservation does not exist, and refuses to orphan one', () => {
    const b = mkBundle(mkRun(), 1);
    throws(() => db.prepare(`INSERT INTO run_bundle_slots
        (bundle_id, slot, seq, reservation_id, kind, item_id, qty) VALUES (?,?,?,?,?,?,?)`)
      .run(b, 'slab', 0, 99999999, 'inventory', 1, 1));
    const resId = mkRes({ item_id: 9191 });
    mkSlot(b, { reservation_id: resId, item_id: 9191 });
    throws(() => db.prepare('DELETE FROM run_reservations WHERE id=?').run(resId));
  });

  it('keeps the ledger honest about what a sale is', () => {
    const runId = mkRun();
    const ins = (o) => db.prepare(`INSERT INTO run_ledger
        (run_id, seq, kind, occurred_at, bundle_no, qty, prev_hash, entry_hash)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(runId, o.seq, o.kind, '2026-09-01T10:00:00.000Z', o.bundle_no ?? null, o.qty,
        '0'.repeat(64), o.entry_hash);
    ins({ seq: 1, kind: 'sale_online', bundle_no: 2, qty: 1, entry_hash: 'a1' });
    ins({ seq: 0, kind: 'pause', qty: 0, entry_hash: 'a2' });
    ins({ seq: 0, kind: 'cancel', bundle_no: 2, qty: 0, entry_hash: 'a3' });   // cancels carry seq 0
    throws(() => ins({ seq: 0, kind: 'sale_online', bundle_no: 3, qty: 1, entry_hash: 'a4' }));
    throws(() => ins({ seq: 2, kind: 'pause', qty: 0, entry_hash: 'a5' }));
    throws(() => ins({ seq: 1, kind: 'sale_online', bundle_no: 3, qty: 0, entry_hash: 'a6' }));
    throws(() => ins({ seq: 1, kind: 'refund', bundle_no: 3, qty: 1, entry_hash: 'a7' }));
  });

  it('refuses a duplicate salt, code or seal serial', () => {
    const runId = mkRun();
    mkBundle(runId, 1, { salt_hex: 'ss', verify_code: 'CC', seal_serial: 'LL' });
    const other = mkRun();
    throws(() => mkBundle(other, 1, { salt_hex: 'ss' }));
    throws(() => mkBundle(other, 2, { verify_code: 'CC' }));
    throws(() => mkBundle(other, 3, { seal_serial: 'LL' }));
    // ...but several bundles may legitimately have none assigned yet.
    mkBundle(other, 4);
    mkBundle(other, 5);
  });

  it('refuses a duplicate claim subject, since it would make the header digest unstable', () => {
    const runId = mkRun();
    const ins = (t, s) => db.prepare(`INSERT INTO run_claims (run_id, claim_type, subject, operator, value)
                                      VALUES (?,?,?,'eq','x')`).run(runId, t, s);
    ins('grader', 'slab');
    throws(() => ins('grader', 'slab'));
    ins('grader', 'art');
  });

  it('requires a field on a field_mix claim and nothing else', () => {
    const runId = mkRun();
    throws(() => db.prepare(`INSERT INTO run_claims (run_id, claim_type, subject, operator, value)
                             VALUES (?,'field_mix','art','eq','ART_RARE:15')`).run(runId));
    db.prepare(`INSERT INTO run_claims (run_id, claim_type, subject, operator, field, value)
                VALUES (?,'field_mix','art','eq','rarity','ART_RARE:15')`).run(runId);
  });

  it('refuses a singleton slot spec that asks for more than one unit', () => {
    const runId = mkRun();
    const ins = (o) => db.prepare(`INSERT INTO run_slot_specs
        (run_id, slot, label, kind, qty_per_bundle, max_lines, singleton, requires_cert, is_chase_slot, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(runId, o.slot, o.label, o.kind, o.qty, o.max, o.single, 0, 0, o.sort);
    throws(() => ins({ slot: 'slab', label: 'Slab', kind: 'inventory', qty: 3, max: 1, single: 1, sort: 0 }));
    ins({ slot: 'slab', label: 'Slab', kind: 'inventory', qty: 1, max: 1, single: 1, sort: 0 });
    throws(() => ins({ slot: 'slab', label: 'Dup', kind: 'inventory', qty: 1, max: 1, single: 0, sort: 1 }));
    throws(() => ins({ slot: 'art', label: 'Art', kind: 'inventory', qty: 1, max: 1, single: 1, sort: 0 }));
    ins({ slot: 'packs', label: 'Packs', kind: 'sealed', qty: 3, max: 3, single: 0, sort: 1 });
  });
});
