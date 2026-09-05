// test/invariants/runs-public-dto.test.mjs — guardrail (a): no monetary value ever reaches a buyer.
//
// Three checks, and they are deliberately of three different KINDS, because each catches what the others
// cannot:
//
//   SOURCE  lib/runs-public.mjs may not name a base table. The views are the strongest layer — a SELECT *
//           from them cannot return a price because no price column is in them — and that layer only holds
//           while the module actually goes through them.
//   SHAPE   the views themselves must carry no money column and none of the three possession tokens.
//   VALUE   a seeded cost of 57400 must not appear ANYWHERE in a serialised payload, matched on the number
//           rather than on a key name. This is the one that catches a price typed into a free-text note,
//           which is the realistic leak: inventory_items.notes is free text and the owner types in it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { commitment, publicBundles, assertNoMoney } from '../../lib/runs-public.mjs';

const SRC = readFileSync(new URL('../../lib/runs-public.mjs', import.meta.url), 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// The tables lib/runs-public.mjs is allowed to read directly. They are PUBLIC by design and carry no money
// column: the composition, the chase ladder and the claims are all published in the commitment, and the
// ladder in particular must be public before any sale or `is_chase` would be a term we could reinterpret.
const ALLOWED = new Set(['run_slot_specs', 'run_chase_tiers', 'run_claims']);
const BASE_TABLES = [
  'runs', 'run_bundles', 'run_bundle_slots', 'run_reservations', 'run_earmarks',
  'run_amendments', 'run_anchors', 'run_ledger', 'run_audit', 'inventory_items', 'sealed_items',
];

describe('the public module goes through the views', () => {
  it('names no base table that carries money or secrets', () => {
    for (const t of BASE_TABLES) {
      if (ALLOWED.has(t)) continue;
      assert.ok(!new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`, 'i').test(code),
        `lib/runs-public.mjs reads ${t} directly — go through the views, which cannot return a price`);
    }
  });

  it('and never names the three possession tokens', () => {
    // salt_hex and verify_code decrypt a bundle's record; seal_serial addresses a parcel. None of the
    // three is in any view, so this is belt and braces — and belt and braces is right for the columns
    // whose disclosure ends the product.
    for (const col of ['salt_hex', 'verify_code', 'seal_serial']) {
      assert.ok(!code.includes(col), `lib/runs-public.mjs names ${col}`);
    }
  });

  it('and writes nothing at all', () => {
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP']) {
      assert.ok(!new RegExp(`\\b${verb}\\b`, 'i').test(code), `lib/runs-public.mjs contains ${verb}`);
    }
  });
});

const db = openDbAt(tmpFile('runs-public-dto.db'));

describe('the views carry no money and no tokens', () => {
  const columnsOf = (view) => db.prepare(`PRAGMA table_info(${view})`).all().map((c) => c.name);

  for (const view of ['v_run_public_run', 'v_run_public_bundle', 'v_run_public_slot']) {
    it(`${view} has no money column`, () => {
      const cols = columnsOf(view);
      assert.ok(cols.length, `${view} does not exist`);
      // Whole SEGMENTS, not substrings. The substring reading bit twice while this was being written:
      // "comp" is inside `composition`, which is one of the commitment's own required fields, and inside
      // `grading_company`, which is a column every graded card needs.
      const MONEY = new Set(['cents', 'price', 'prices', 'cost', 'costs', 'comp', 'comps', 'paid',
        'profit', 'margin', 'rrp', 'aud', 'usd', 'money']);
      for (const c of cols) {
        const hit = c.toLowerCase().split(/[^a-z0-9]+/).find((seg) => MONEY.has(seg));
        assert.ok(!hit, `${view}.${c} reads as money ("${hit}")`);
      }
    });
  }

  it('v_run_public_bundle exposes no salt, code, serial or per-bundle state', () => {
    // State is excluded for a less obvious reason than the secrets are: ANY mutable public field forces
    // republication, and diffing two published versions names the bundle that changed — and ship order
    // correlates with sale order.
    const cols = columnsOf('v_run_public_bundle');
    for (const c of ['salt_hex', 'verify_code', 'seal_serial', 'status', 'sold_at', 'shipped_at', 'packed_at']) {
      assert.ok(!cols.includes(c), `v_run_public_bundle exposes ${c}`);
    }
  });

  it('and v_run_public_run does not expose the schema\'s one money column', () => {
    assert.ok(!columnsOf('v_run_public_run').includes('unit_price_cents'));
  });
});

describe('a seeded price never reaches a payload, matched on the NUMBER', () => {
  // 57400 cents and 89900 cents. Asserted as digits, not as key names, because the leak that actually
  // happens is a value carried somewhere no key-name check would look.
  const COST = 57400;
  const VALUE = 89900;

  const runId = (() => {
    db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, unit_price_cents,
                  close_by, sales_close_at, unsold_policy, locked_at, run_root, codes_commit, blob_hash,
                  blob_length, header_digest, guarantee_text, rarity_table_version, rarity_table_hash)
                VALUES ('P1',1,'Priced','live',2,'locked_published',12900,
                  '2027-03-31T23:59:59.000Z','2027-01-31T23:59:59.000Z','One price for every number.',
                  '2026-08-30T00:00:00.000Z', ?, ?, ?, 8268, ?, 'Every bundle contains one graded card.',
                  'rarity-v1', ?)`)
      .run('aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32), 'ee'.repeat(32));
    const id = db.prepare("SELECT id FROM runs WHERE public_id = 'P1'").get().id;
    db.prepare(`INSERT INTO run_slot_specs (run_id, slot, label, kind, qty_per_bundle, max_lines,
                  singleton, requires_cert, is_chase_slot, sort_order)
                VALUES (?, 'slab', 'Graded slab', 'inventory', 1, 1, 1, 1, 1, 0)`).run(id);
    db.prepare(`INSERT INTO run_claims (run_id, claim_type, subject, operator, value)
                VALUES (?, 'slot_count', 'bundle', 'eq', 'slab:1')`).run(id);
    for (let i = 1; i <= 2; i++) {
      db.prepare(`INSERT INTO run_bundles (run_id, bundle_no, label, salt_hex, verify_code, seal_serial,
                    leaf_hash, code_leaf)
                  VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, i, `P1-00${i}`, String(i).repeat(64), `CODE${String(i).repeat(22)}`,
          `serial-${i}`, `0${i}`.repeat(32), `f${i}`.repeat(32));
    }
    // A cost typed into free text, plus the real cached-comp columns.
    db.prepare(`INSERT INTO inventory_items (sku, game, name, quantity, status, cost_cents, value_cents, notes)
                VALUES ('P1-ITEM','pokemon','Priced Card',1,'in_stock',?,?,?)`)
      .run(COST, VALUE, `paid ${COST / 100} for this one`);
    return id;
  })();

  const bodies = () => [
    JSON.stringify(commitment(db, runId)),
    JSON.stringify(publicBundles(db, runId)),
  ];

  for (const needle of [String(COST), String(VALUE), '574', '899', '574.00', '129.00', '12900']) {
    it(`no payload contains ${JSON.stringify(needle)}`, () => {
      for (const body of bodies()) assert.ok(!body.includes(needle), `${needle} appears in ${body.slice(0, 120)}`);
    });
  }

  it('and no payload contains a salt, a code or a seal serial', () => {
    const secrets = db.prepare('SELECT salt_hex, verify_code, seal_serial FROM run_bundles WHERE run_id = ?').all(runId);
    for (const body of bodies()) {
      for (const s of secrets) {
        assert.ok(!body.includes(s.salt_hex));
        assert.ok(!body.includes(s.verify_code));
        assert.ok(!body.includes(s.seal_serial));
      }
    }
  });

  it('while assertNoMoney still refuses a money key it is handed directly', () => {
    assert.throws(() => assertNoMoney({ unit_price_cents: 12900 }), /money-shaped key/);
    assert.throws(() => assertNoMoney({ unitPriceCents: 12900 }), /money-shaped key/);
    assert.throws(() => assertNoMoney({ notes: 'paid $574 for this one' }), /monetary amount/);
  });
});
