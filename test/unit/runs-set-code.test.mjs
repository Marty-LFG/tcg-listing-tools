// test/unit/runs-set-code.test.mjs — inventory_items.set_code, and the chase-ladder gap it closes.
//
// THE GAP. §5.1 identifies a chase ladder card by set code, number, language, grader and grade — never by
// name alone, because §1.1 establishes names are ambiguous across printings and languages. But
// inventory_items carried set_NAME and no set_CODE, so every graded line committed `set_code = ''` and a
// ladder entry stating a code could never match a slab, however right the card was. Sealed rows had a
// real column all along, which is why a booster could carry one and a slab could not.
//
// The code did exist — inside card_facts JSON. That is not good enough for a hashed field: card_facts is
// documented as "rewritten wholesale from a card lookup", so a routine re-lookup could silently change a
// value already committed to a bundle's Merkle tree. Promoted to a column, and stamped in both places by
// one function so the two cannot drift.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { holdForRun, assignToSlot, boundLines } from '../../lib/runs-reserve.mjs';
import { deriveChases } from '../../lib/runs-lock.mjs';

const db = openDbAt(tmpFile('runs-set-code.db'));

describe('the column exists and is indexed', () => {
  it('inventory_items carries set_code', () => {
    const cols = db.prepare('PRAGMA table_info(inventory_items)').all().map((c) => c.name);
    assert.ok(cols.includes('set_code'), 'inventory_items has no set_code column');
  });

  it('and it is indexed, because the ladder match and the identity mapper both filter on it', () => {
    const idx = db.prepare('PRAGMA index_list(inventory_items)').all().map((i) => i.name);
    assert.ok(idx.includes('idx_inv_set_code'), idx.join(', '));
  });

  it('sealed_items still has its own, so the two sides are symmetric', () => {
    const cols = db.prepare('PRAGMA table_info(sealed_items)').all().map((c) => c.name);
    assert.ok(cols.includes('set_code'));
  });
});

let n = 0;
function mkRun() {
  const k = ++n;
  const pid = `SC${k}`;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status)
              VALUES (?,?,?, 'live', 2, 'draft')`).run(pid, k, `Edition ${k}`);
  const runId = db.prepare('SELECT id FROM runs WHERE public_id = ?').get(pid).id;
  const spec = db.prepare(`INSERT INTO run_slot_specs
    (run_id, slot, label, kind, qty_per_bundle, max_lines, singleton, requires_cert, is_chase_slot, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  spec.run(runId, 'slab', 'Graded slab', 'inventory', 1, 1, 1, 1, 1, 0);
  for (let i = 1; i <= 2; i++) {
    db.prepare('INSERT INTO run_bundles (run_id, bundle_no, label, seal_serial) VALUES (?,?,?,?)')
      .run(runId, i, `${pid}-00${i}`, `seal-${pid}-${i}`);
  }
  return { runId, pid, bundles: db.prepare('SELECT * FROM run_bundles WHERE run_id = ? ORDER BY bundle_no').all(runId) };
}

const mkSlab = (over = {}) => {
  const k = ++n;
  db.prepare(`INSERT INTO inventory_items
    (sku, game, name, number, rarity, language, quantity, status, grading_company, grade, cert_number, set_name, set_code)
    VALUES (?,?,?,?,?,?,1,'in_stock','PSA',10,?,?,?)`)
    .run(`SC-${k}`, 'pokemon', over.name ?? `Card ${k}`, over.number ?? '101', 'Art Rare', 'JA',
      String(80000000 + k), over.set_name ?? 'Sample Set', over.set_code ?? null);
  return db.prepare('SELECT id FROM inventory_items WHERE sku = ?').get(`SC-${k}`).id;
};

describe('boundLines carries a graded set code, which it never could before', () => {
  it('reads it off the inventory row', () => {
    const { runId, bundles } = mkRun();
    const item = mkSlab({ set_code: 'SV3PT5' });
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    assignToSlot(db, { reservationId: h.id, bundleId: bundles[0].id, slot: 'slab' });
    const line = boundLines(db, runId).find((l) => l.slot === 'slab');
    assert.equal(line.set_code, 'SV3PT5');
  });

  it('and leaves it null when the row never resolved one, rather than inventing a value', () => {
    // A wrong set code is worse than a blank one — it files the card into the wrong automated per-set
    // collection, which reads as deliberate. lib/set-code.mjs makes the same point at length.
    const { runId, bundles } = mkRun();
    const item = mkSlab({ set_code: null });
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    assignToSlot(db, { reservationId: h.id, bundleId: bundles[0].id, slot: 'slab' });
    assert.equal(boundLines(db, runId).find((l) => l.slot === 'slab').set_code, null);
  });
});

describe('THE GAP IS CLOSED: a ladder entry naming a set code now matches a slab', () => {
  const SPECS = [{ slot: 'slab', kind: 'inventory', max_lines: 1, is_chase_slot: 1, sort_order: 0 }];
  const line = (over = {}) => ({
    kind: 'inventory', display_name: 'Chase Card', game: 'pokemon', identity_key: '', set_code: 'SV3PT5',
    card_number: '201', rarity: 'Art Rare', language: 'JA', finish: '', product_type: '', upc: '',
    grading_company: 'PSA', grade: '10', cert_number: '1', qty: '1', ...over,
  });
  const world = (lines) => {
    const bundles = lines.map((_, i) => ({ id: i + 1, bundle_no: i + 1, label: `B-${i + 1}` }));
    return {
      bundles,
      byBundle: new Map(bundles.map((b, i) => [b.id, { bundle: b, lines: { slab: [{ row: {}, line: lines[i] }] } }])),
    };
  };
  const entry = (over = {}) => ({
    rank: 1, card_name: 'Chase Card', set_code: 'SV3PT5', card_number: '201', language: 'JA',
    grading_company: 'PSA', grade: '10', ...over,
  });

  it('matches when the set code agrees', () => {
    const { bundles, byBundle } = world([line(), line({ card_number: '999', set_code: 'OTHER' })]);
    const p = deriveChases(bundles, [entry()], SPECS, byBundle);
    assert.deepEqual([...p.keys()], [1]);
  });

  it('and REFUSES when the codes differ — the discrimination that was impossible before', () => {
    // Two cards, same number, same language, same grader, same grade, different SETS. Before the column
    // both committed set_code = '' and the ladder could not tell them apart; a ladder entry would have
    // matched BOTH and the bijection check would have refused the run for the wrong reason.
    const { bundles, byBundle } = world([line({ set_code: 'OTHER' }), line({ set_code: 'THIRD' })]);
    assert.throws(() => deriveChases(bundles, [entry()], SPECS, byBundle), /is in no bundle of this run/);
  });

  it('and the refusal names the fields it tried, so a blank set code is diagnosable', () => {
    const { bundles, byBundle } = world([line({ set_code: '' })]);
    assert.throws(() => deriveChases(bundles, [entry()], SPECS, byBundle), /set_code=SV3PT5/);
  });

  it('a ladder entry that states no set code still matches on the remaining fields', () => {
    // The pre-column behaviour stays available: leaving set_code off an entry identifies the card by
    // number, language, grader and grade, which is what an unresolved row needs.
    const { bundles, byBundle } = world([line({ set_code: '' })]);
    const p = deriveChases(bundles, [entry({ set_code: null })], SPECS, byBundle);
    assert.deepEqual([...p.keys()], [1]);
  });
});
