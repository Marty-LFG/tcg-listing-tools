// test/unit/runs-lock.test.mjs — §10.4 lock, phases 1 and 2.
//
// Built against a real database with real stock rows, real reservations and the real guards, because the
// thing being tested is an orchestration: what it refuses, in what order it writes, and what it leaves
// behind when it declines. A mocked database would pass while the transaction was wrong.
//
// The run below is EX2's composition — a singleton graded slab requiring a cert, three sealed packs across
// up to three lines, and a singleton art card — because that is the shape whose padded attribute set is
// already vector-verified elsewhere.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { holdForRun, assignToSlot, splitToSlots, breakReservation } from '../../lib/runs-reserve.mjs';
import {
  collectManifest, validateForLock, manifestFingerprint, deriveChases, lockRunPhase1, lockRunPhase2,
} from '../../lib/runs-lock.mjs';
import { openBlobFile, parseBlobFile } from '../../lib/runs-blob.mjs';
import { blobKey } from '../../lib/runs-codes.mjs';
import { verifyProof, merkleProof } from '../../lib/runs-merkle.mjs';

const db = openDbAt(tmpFile('runs-lock.db'));

const POLICY = 'Every bundle in a run is sold at one price shared by every remaining number.';
let seq = 0;

function mkSlab(over = {}) {
  const k = ++seq;
  db.prepare(`INSERT INTO inventory_items
    (sku, game, name, number, rarity, language, variant, quantity, status, grading_company, grade, cert_number, set_name)
    VALUES (?,?,?,?,?,?,?,1,'in_stock',?,?,?,?)`)
    .run(`SLB-${k}`, 'pokemon', over.name ?? `Card ${k}`, over.number ?? String(100 + k),
      over.rarity ?? 'Art Rare', over.language ?? 'JA', 'holo',
      over.grading_company ?? 'PSA', over.grade ?? 10, over.cert_number ?? String(90000000 + k),
      'Sample Set');
  return db.prepare('SELECT id FROM inventory_items WHERE sku = ?').get(`SLB-${k}`).id;
}
function mkArt(over = {}) {
  const k = ++seq;
  db.prepare(`INSERT INTO inventory_items (sku, game, name, number, rarity, language, quantity, status, set_name)
              VALUES (?,?,?,?,?,?,1,'in_stock',?)`)
    .run(`ART-${k}`, 'pokemon', over.name ?? `Art ${k}`, String(200 + k), over.rarity ?? 'Art Rare',
      over.language ?? 'JA', 'Sample Set');
  return db.prepare('SELECT id FROM inventory_items WHERE sku = ?').get(`ART-${k}`).id;
}
function mkPacks(qty = 9) {
  const k = ++seq;
  db.prepare(`INSERT INTO sealed_items (sku, game, product_type, name, quantity, status, language, set_code, upc, set_name)
              VALUES (?,?,?,?,?,'in_stock',?,?,?,?)`)
    .run(`PKS-${k}`, 'pokemon', 'booster_pack', `Pack ${k}`, qty, 'JA', `SP${k}`, `00000000000${k}`, 'Sample Set');
  return db.prepare('SELECT id FROM sealed_items WHERE sku = ?').get(`PKS-${k}`).id;
}

let runN = 0;
/** A complete, lockable three-bundle run. Every test starts from one and then breaks exactly one thing. */
function mkRun({ units = 3, claims = 'full', ladder = 1, headerFields = true } = {}) {
  const k = ++runN;
  const pid = `E${k}`;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, close_by, sales_close_at, unsold_policy)
              VALUES (?,?,?, 'live', ?, 'draft', ?, ?, ?)`)
    .run(pid, k, `Edition ${k}`, units,
      headerFields ? '2027-03-31T23:59:59.000Z' : null,
      headerFields ? '2027-01-31T23:59:59.000Z' : null,
      headerFields ? POLICY : null);
  const runId = db.prepare('SELECT id FROM runs WHERE public_id = ?').get(pid).id;

  const spec = db.prepare(`INSERT INTO run_slot_specs
    (run_id, slot, label, kind, qty_per_bundle, max_lines, singleton, requires_cert, is_chase_slot, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  spec.run(runId, 'slab', 'Graded slab', 'inventory', 1, 1, 1, 1, 1, 0);
  spec.run(runId, 'packs', 'Sealed pack', 'sealed', 3, 3, 0, 0, 0, 1);
  spec.run(runId, 'art', 'Art card', 'inventory', 1, 1, 1, 0, 0, 2);

  for (let i = 1; i <= units; i++) {
    db.prepare('INSERT INTO run_bundles (run_id, bundle_no, label, seal_serial) VALUES (?,?,?,?)')
      .run(runId, i, `${pid}-${String(i).padStart(3, '0')}`, `serial-${pid}-${i}-${Math.random().toString(16).slice(2, 10)}`);
  }
  const bundles = db.prepare('SELECT * FROM run_bundles WHERE run_id = ? ORDER BY bundle_no').all(runId);

  // THE LADDER NAMES CARDS THAT ARE ACTUALLY IN THE RUN, because is_chase is derived from the manifest.
  //
  // set_code is left NULL deliberately: inventory_items has set_NAME but no set_CODE, so a graded card's
  // line always commits an empty set_code and a ladder entry stating one could never match. See the note
  // in lib/runs-lock.mjs — this is a data-model gap, not a matcher bug.
  const chaseNumbers = [];
  for (let r = 1; r <= ladder; r++) chaseNumbers.push(String(600 + r));

  if (claims !== 'none') {
    const c = db.prepare('INSERT INTO run_claims (run_id, claim_type, subject, operator, value) VALUES (?,?,?,?,?)');
    c.run(runId, 'slot_count', 'bundle', 'eq', 'art:1,packs:3,slab:1');
    c.run(runId, 'language', 'bundle', 'eq', 'JA');
    if (claims === 'full') {
      c.run(runId, 'grader', 'slab', 'eq', 'PSA');
      c.run(runId, 'min_grade', 'slab', 'gte', '10');
    }
  }

  // The manifest: one slab and one art card per bundle, and nine packs of one product split three ways.
  const packs = mkPacks(units * 3);
  const poolHold = holdForRun(db, { kind: 'sealed', itemId: packs, runId, qty: units * 3 });
  splitToSlots(db, poolHold.id, bundles.map((b) => ({ bundleId: b.id, slot: 'packs', qty: 3 })));
  bundles.forEach((b, i) => {
    // Bundles 1..ladder hold the ladder cards, so the derived chase set is deterministic.
    for (const [slot, itemId] of [['slab', mkSlab(i < ladder ? { number: chaseNumbers[i] } : {})], ['art', mkArt()]]) {
      const h = holdForRun(db, { kind: 'inventory', itemId, runId });
      assignToSlot(db, { reservationId: h.id, bundleId: b.id, slot });
    }
  });
  chaseNumbers.forEach((num, i) => {
    db.prepare(`INSERT INTO run_chase_tiers (run_id, rank, card_name, set_code, card_number, language, grading_company, grade)
                VALUES (?,?,?,NULL,?,?,?,?)`).run(runId, i + 1, `Chase ${i + 1}`, num, 'JA', 'PSA', '10');
  });
  return { runId, pid, bundles, packs };
}

describe('a complete run locks', () => {
  const { runId } = mkRun();
  let locked;

  it('phase 1 produces every committed value', async () => {
    locked = await lockRunPhase1(db, runId, { actor: 'test' });
    assert.match(locked.runRoot, /^[0-9a-f]{64}$/);
    assert.match(locked.headerDigest, /^[0-9a-f]{64}$/);
    assert.match(locked.codesCommit, /^[0-9a-f]{64}$/);
    assert.equal(locked.leaves.length, 3);
    assert.equal(locked.blobLength, 16 + 3 * (4096 + 28));
  });

  it('and moves the run to locked_pending_publish, nothing public yet', () => {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    assert.equal(run.status, 'locked_pending_publish');
    assert.equal(run.run_root, locked.runRoot);
    assert.equal(run.header_digest, locked.headerDigest);
    assert.ok(run.locked_at);
    assert.ok(run.guarantee_text.length > 20);
  });

  it('freezes the descriptors onto run_bundle_slots, which nothing wrote before now', () => {
    // Before lock the manifest is reservations joined live to stock. The frozen copy is what gets hashed,
    // because the stock row may be edited later and the manifest must keep saying what it said.
    const rows = db.prepare(`SELECT s.* FROM run_bundle_slots s JOIN run_bundles b ON b.id = s.bundle_id
                             WHERE b.run_id = ? ORDER BY b.bundle_no, s.slot, s.seq`).all(runId);
    assert.equal(rows.length, 9, 'three bundles x (slab + one pack line + art)');
    for (const r of rows) assert.ok(r.frozen_at, 'every frozen row carries its stamp');
    const slab = rows.find((r) => r.slot === 'slab');
    assert.equal(slab.slot_singleton, 1);
    assert.equal(slab.slot_requires_cert, 1);
    assert.ok(slab.cert_number);
  });

  it('mints a distinct salt and a distinct code per bundle', () => {
    const rows = db.prepare('SELECT salt_hex, verify_code, leaf_hash FROM run_bundles WHERE run_id = ?').all(runId);
    assert.equal(new Set(rows.map((r) => r.salt_hex)).size, 3);
    assert.equal(new Set(rows.map((r) => r.verify_code)).size, 3);
    for (const r of rows) {
      assert.match(r.salt_hex, /^[0-9a-f]{64}$/);
      assert.equal(r.verify_code.length, 26);
      assert.match(r.leaf_hash, /^[0-9a-f]{64}$/);
    }
  });

  it('commits every reservation still holding stock', () => {
    // The one `released` row is the sealed POOL hold: splitToSlots consumes it and replaces it with one
    // bound row per bundle, because a hold of nine boosters has to become three units in each of three
    // parcels and one row cannot be in three places. Nothing live is left uncommitted.
    // Mapped to strings rather than compared as rows: node:sqlite returns null-prototype objects, so a
    // deepStrictEqual against object literals fails on the prototype while every value matches.
    const states = db.prepare('SELECT state, COUNT(*) n FROM run_reservations WHERE run_id = ? GROUP BY state ORDER BY state')
      .all(runId).map((r) => `${r.state}:${r.n}`);
    assert.deepEqual(states, ['committed:9', 'released:1']);
    const live = db.prepare(`SELECT COUNT(*) n FROM run_reservations
                             WHERE run_id = ? AND bundle_id IS NOT NULL AND state <> 'committed'`).get(runId);
    assert.equal(live.n, 0);
  });

  it('and the blob file it built opens with a key derived from a printed code', async () => {
    // The end-to-end property: what the buyer does, using only the code from their insert.
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    const b2 = db.prepare('SELECT * FROM run_bundles WHERE run_id = ? AND bundle_no = 2').get(runId);
    const key = await blobKey(b2.verify_code, run.public_id);
    const opened = await openBlobFile(locked.blobFile, {
      blobKeyHex: key, publicId: run.public_id, unitCount: 3,
    });
    assert.equal(opened.index, 1, 'entry position is bundle_no - 1');
    const text = new TextDecoder().decode(opened.body);
    assert.ok(text.includes(b2.salt_hex), 'the record carries its own bundle salt');
    assert.ok(text.includes('BKR1-BLOB'));
  });

  it('and every entry is the same size, so structure leaks nothing', () => {
    const parsed = parseBlobFile(locked.blobFile, { unitCount: 3 });
    assert.equal(new Set(parsed.entries.map((e) => e.sealed.length)).size, 1);
  });

  it('so a bundle leaf proves membership of the anchored run root', async () => {
    const proof = await merkleProof(locked.leaves, 1);
    assert.ok(await verifyProof({
      leaf: locked.leaves[1], proof, root: locked.runRoot, index: 1, size: 3,
    }));
  });
});

describe('lock refuses, and names every reason at once', () => {
  const refuse = async (runId) => {
    const err = await lockRunPhase1(db, runId).then(() => null, (e) => e);
    assert.ok(err, 'expected a refusal');
    assert.equal(err.code, 'lock_refused');
    return err.problems.map((p) => p.code);
  };

  it('a bundle missing its seal serial — a committed attribute assigned before lock', async () => {
    const { runId, bundles } = mkRun();
    db.prepare('UPDATE run_bundles SET seal_serial = NULL WHERE id = ?').run(bundles[1].id);
    assert.ok((await refuse(runId)).includes('no_seal_serial'));
  });

  it('two bundles sharing a seal serial — refused by the DATABASE, before lock ever sees it', () => {
    // seal_serial is UNIQUE in the schema, so the duplicate never reaches validateForLock. The validator
    // keeps its own check anyway: it is the one that survives a hand-edited table, and the serial is a
    // committed attribute, so two bundles sharing one would commit the same claim twice.
    const { bundles } = mkRun();
    const first = db.prepare('SELECT seal_serial FROM run_bundles WHERE id = ?').get(bundles[0].id).seal_serial;
    assert.throws(
      () => db.prepare('UPDATE run_bundles SET seal_serial = ? WHERE id = ?').run(first, bundles[2].id),
      /UNIQUE constraint failed: run_bundles.seal_serial/);
  });

  it('a missing header field, because it is inside the anchored digest', async () => {
    const { runId } = mkRun({ headerFields: false });
    const codes = await refuse(runId);
    assert.equal(codes.filter((c) => c === 'missing_header_field').length, 3);
  });

  it('a bundle that does not match the composition', async () => {
    const { runId, bundles } = mkRun();
    const res = db.prepare(`SELECT id FROM run_reservations WHERE bundle_id = ? AND slot = 'packs'`).get(bundles[0].id);
    db.prepare('UPDATE run_reservations SET qty = 2 WHERE id = ?').run(res.id);
    assert.ok((await refuse(runId)).includes('composition_mismatch'));
  });

  it('a slot requiring a cert whose card has none', async () => {
    const { runId, bundles } = mkRun();
    const res = db.prepare(`SELECT item_id FROM run_reservations WHERE bundle_id = ? AND slot = 'slab'`).get(bundles[0].id);
    db.prepare("UPDATE inventory_items SET cert_number = '' WHERE id = ?").run(res.item_id);
    const codes = await refuse(runId);
    assert.ok(codes.includes('missing_cert'));
  });

  it('stock held for the run but never placed in a bundle — never silently released', async () => {
    // Quietly dropping a hold the owner placed deliberately is the wrong failure. It is named instead.
    const { runId } = mkRun();
    holdForRun(db, { kind: 'inventory', itemId: mkSlab(), runId });
    assert.ok((await refuse(runId)).includes('unassigned_hold'));
  });

  it('a reservation broken by a real sale elsewhere', async () => {
    const { runId, bundles } = mkRun();
    const res = db.prepare(`SELECT id FROM run_reservations WHERE bundle_id = ? AND slot = 'slab'`).get(bundles[0].id);
    breakReservation(db, res.id, 'sold on eBay');
    const codes = await refuse(runId);
    assert.ok(codes.includes('broken_reservation'));
  });

  it('an item still live on another channel', async () => {
    const { runId, bundles } = mkRun();
    const res = db.prepare(`SELECT id FROM run_reservations WHERE bundle_id = ? AND slot = 'art'`).get(bundles[0].id);
    db.prepare("UPDATE run_reservations SET channel_hold = 'ebay_live' WHERE id = ?").run(res.id);
    assert.ok((await refuse(runId)).includes('channel_hold'));
  });

  it('A CARD THAT BREAKS THE PUBLISHED GUARANTEE, naming the bundle and the cert', async () => {
    // The PSA 8 case. This is the refusal the whole claims engine exists for: the sentence promises PSA 10
    // and one bundle does not have one, so the run cannot lock and the operator is told exactly which.
    const { runId, bundles } = mkRun();
    const res = db.prepare(`SELECT item_id FROM run_reservations WHERE bundle_id = ? AND slot = 'slab'`).get(bundles[2].id);
    db.prepare('UPDATE inventory_items SET grade = 8 WHERE id = ?').run(res.item_id);
    const err = await lockRunPhase1(db, runId).then(() => null, (e) => e);
    const fail = err.problems.find((p) => p.code === 'claim_fails');
    assert.ok(fail, 'the min_grade claim must refuse');
    assert.match(fail.message, /min_grade/);
    const cx = fail.detail.counterexamples[0];
    assert.equal(cx.got, '8');
    assert.equal(cx.want, 'at least 10');
    assert.ok(cx.bundle, 'the counterexample names the bundle');
    assert.ok(cx.cert, 'and the certification number');
  });

  it('non-English stock with no language claim, so it cannot be omitted by not mentioning it', async () => {
    const { runId } = mkRun({ claims: 'none' });
    const codes = await refuse(runId);
    assert.ok(codes.includes('language_unclaimed'));
  });

  it('a chase ladder naming a card no bundle holds', async () => {
    // Caught at LOCK rather than at close: a run that cannot produce a valid tier C disclosure must never
    // be anchored, because by close every parcel has already shipped.
    const { runId } = mkRun({ units: 3, ladder: 1 });
    db.prepare("UPDATE run_chase_tiers SET card_number = '99999' WHERE run_id = ?").run(runId);
    assert.ok((await refuse(runId)).includes('chase_placement'));
  });

  it('and a run that is not a draft', async () => {
    const { runId } = mkRun();
    await lockRunPhase1(db, runId);
    assert.ok((await refuse(runId)).includes('not_draft'));
  });

  it('writing nothing at all when it refuses', async () => {
    const { runId, bundles } = mkRun();
    db.prepare('UPDATE run_bundles SET seal_serial = NULL WHERE id = ?').run(bundles[0].id);
    await lockRunPhase1(db, runId).catch(() => {});
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    assert.equal(run.status, 'draft');
    assert.equal(run.run_root, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM run_bundle_slots s JOIN run_bundles b ON b.id = s.bundle_id WHERE b.run_id = ?').get(runId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM run_bundles WHERE run_id = ? AND salt_hex IS NOT NULL').get(runId).n, 0);
  });
});

describe('the compute window is closed by a fingerprint', () => {
  it('aborts and writes nothing if the manifest changed while the keys were being derived', async () => {
    // Deriving twenty-five blob keys takes over a second, and the API stays up. Repointing a slot at a
    // different card is the edit an id-only check would miss, so the fingerprint carries the descriptors.
    const { runId, bundles } = mkRun();
    const swap = mkSlab({ name: 'Swapped In' });
    let edited = false;
    const err = await lockRunPhase1(db, runId, {
      // nonceFor runs while the blob file is being built — after the fingerprint is taken and before the
      // transaction opens, which is precisely the window a concurrent API edit would land in.
      nonceFor: () => {
        if (!edited) {
          edited = true;
          const res = db.prepare(`SELECT id FROM run_reservations WHERE bundle_id = ? AND slot = 'slab'`).get(bundles[0].id);
          db.prepare('UPDATE run_reservations SET item_id = ? WHERE id = ?').run(swap, res.id);
        }
        return new Uint8Array(12);
      },
    }).then(() => null, (e) => e);
    assert.equal(err?.code, 'manifest_changed');
    const run = db.prepare('SELECT status, run_root FROM runs WHERE id = ?').get(runId);
    assert.equal(run.status, 'draft');
    assert.equal(run.run_root, null);
  });

  it('and the fingerprint moves when a descriptor changes but no row is added or removed', () => {
    const { runId, bundles } = mkRun();
    const before = manifestFingerprint(collectManifest(db, runId));
    const res = db.prepare(`SELECT item_id FROM run_reservations WHERE bundle_id = ? AND slot = 'art'`).get(bundles[1].id);
    db.prepare("UPDATE inventory_items SET name = 'Renamed' WHERE id = ?").run(res.item_id);
    assert.notEqual(manifestFingerprint(collectManifest(db, runId)), before);
  });
});

describe('§10.4 chase placement is DERIVED, not drawn', () => {
  // §10.4 step 2 says "randomise chase bundle numbers", and that instruction is a leftover from a design
  // in which chase cards were dealt at lock. They are not: the physical pick-and-verify pass happens
  // BEFORE the lock, so every card is already in a specific numbered bundle by the time this runs.
  // Labelling a bundle at random would label one that need not hold a ladder card at all — a run that
  // locks cleanly, sells out, ships, and then fails its own tier C disclosure at close.
  const SPECS = [
    { slot: 'slab', kind: 'inventory', max_lines: 1, is_chase_slot: 1, sort_order: 0 },
    { slot: 'art', kind: 'inventory', max_lines: 1, is_chase_slot: 0, sort_order: 1 },
  ];
  const line = (over = {}) => ({
    kind: 'inventory', display_name: 'x', game: 'pokemon', identity_key: '', set_code: 'EXS',
    card_number: '101', rarity: 'Art Rare', language: 'JA', finish: '', product_type: '', upc: '',
    grading_company: 'PSA', grade: '10', cert_number: '1', qty: '1', ...over,
  });
  const entry = (rank, number) => ({
    rank, card_name: `Chase ${rank}`, set_code: 'EXS', card_number: number, language: 'JA',
    grading_company: 'PSA', grade: '10',
  });
  // byBundle in the shape collectManifest produces: id -> { bundle, lines: { slot: [{ row, line }] } }.
  const world = (perBundle) => {
    const bundles = perBundle.map((_, i) => ({ id: i + 1, bundle_no: i + 1, label: `B-${i + 1}` }));
    const byBundle = new Map(bundles.map((b, i) => [b.id, { bundle: b, lines: perBundle[i] }]));
    return { bundles, byBundle };
  };
  const slab = (number) => ({ slab: [{ row: {}, line: line({ card_number: number }) }] });

  it('labels exactly the bundles that hold a ladder card', () => {
    const { bundles, byBundle } = world([slab('501'), slab('101'), slab('502')]);
    const p = deriveChases(bundles, [entry(1, '501'), entry(2, '502')], SPECS, byBundle);
    assert.deepEqual([...p.keys()].sort(), [1, 3]);
    assert.equal(p.get(1).rank, 1);
    assert.equal(p.get(3).rank, 2);
  });

  it('REFUSES two ladder cards in one bundle — claim 3 promises one per bundle', () => {
    const both = { slab: [{ row: {}, line: line({ card_number: '501' }) }],
      art: [{ row: {}, line: line({ card_number: '502' }) }] };
    const { bundles, byBundle } = world([both, slab('101'), slab('102')]);
    assert.throws(() => deriveChases(bundles, [entry(1, '501'), entry(2, '502')], SPECS, byBundle),
      /holds 2 chase ladder cards/);
  });

  it('refuses a chase sitting outside the declared chase slot', () => {
    const wrong = { slab: [{ row: {}, line: line({ card_number: '101' }) }],
      art: [{ row: {}, line: line({ card_number: '501' }) }] };
    const { bundles, byBundle } = world([wrong, slab('102')]);
    assert.throws(() => deriveChases(bundles, [entry(1, '501')], SPECS, byBundle),
      /not the declared chase slot/);
  });

  it('refuses a ladder card that is in no bundle at all', () => {
    const { bundles, byBundle } = world([slab('101'), slab('102')]);
    assert.throws(() => deriveChases(bundles, [entry(1, '999')], SPECS, byBundle),
      /is in no bundle of this run/);
  });

  it('refuses one ladder rank claimed by two bundles', () => {
    const { bundles, byBundle } = world([slab('501'), slab('501')]);
    assert.throws(() => deriveChases(bundles, [entry(1, '501')], SPECS, byBundle),
      /appears in both bundle/);
  });

  it('and refuses a ladder with nowhere for a chase to go', () => {
    const flat = SPECS.map((x) => ({ ...x, is_chase_slot: 0 }));
    const { bundles, byBundle } = world([slab('501')]);
    assert.throws(() => deriveChases(bundles, [entry(1, '501')], flat, byBundle), /no slot for a chase/);
  });

  it('uses no Math.random anywhere in the module', () => {
    // Comments stripped, so the module explaining WHY placement is not a draw does not trip its own scan.
    const src = readFileSync(new URL('../../lib/runs-lock.mjs', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/Math\.random/.test(src));
  });
});

describe('§10.4 phase 2 is idempotent', () => {
  it('publishes, anchors and transitions once', async () => {
    const { runId } = mkRun();
    const locked = await lockRunPhase1(db, runId);
    let publishes = 0;
    let anchors = 0;
    const out = await lockRunPhase2(db, runId, {
      publisher: ({ run }) => { publishes++; return { blobHash: run.blob_hash }; },
      anchorer: () => { anchors++; return { mode: 'stub' }; },
    });
    assert.equal(out.status, 'locked_published');
    assert.equal(publishes, 1);
    assert.equal(anchors, 1);

    // A second call is a no-op rather than a second publish: the commitment is published exactly ONCE,
    // because republishing it would let an observer diff versions and see which bundle changed.
    const again = await lockRunPhase2(db, runId, {
      publisher: () => { publishes++; return {}; },
      anchorer: () => { anchors++; return {}; },
    });
    assert.equal(again.alreadyDone, true);
    assert.equal(publishes, 1);
    assert.equal(anchors, 1);
    assert.ok(locked.headerDigest);
  });

  it('refuses to transition when what was published does not hash to what was committed', async () => {
    const { runId } = mkRun();
    await lockRunPhase1(db, runId);
    await assert.rejects(() => lockRunPhase2(db, runId, {
      publisher: () => ({ blobHash: 'ff'.repeat(32) }),
      anchorer: () => ({}),
    }), /not the committed/);
    assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId).status, 'locked_pending_publish');
  });

  it('and refuses to run before phase 1', async () => {
    const { runId } = mkRun();
    await assert.rejects(() => lockRunPhase2(db, runId, { publisher: () => ({}), anchorer: () => ({}) }),
      /phase 2 follows phase 1/);
  });
});

describe('validateForLock is readable on its own', () => {
  it('returns a list rather than throwing on the first problem', () => {
    const { runId, bundles } = mkRun({ headerFields: false });
    db.prepare('UPDATE run_bundles SET seal_serial = NULL WHERE id = ?').run(bundles[0].id);
    const problems = validateForLock(collectManifest(db, runId));
    assert.ok(problems.length >= 4);
    for (const p of problems) {
      assert.ok(p.code, 'every problem carries a machine-readable code');
      assert.ok(p.message, 'and a sentence an operator can act on');
    }
  });
});

import { readFileSync } from 'node:fs';
