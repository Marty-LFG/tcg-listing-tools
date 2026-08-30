// test/invariants/runs-reservation-guards.test.mjs — the run reservation guard is spread over seven
// call sites in six files, and a guard spread over six files rots the moment someone adds a seventh.
//
// THE FAILURE THIS PREVENTS: a Keeper's Run binds a specific physical slab to a specific bundle
// number, and the published Merkle commitment names that exact object. If any surface in this app can
// still list, publish, reprice, mark sold or delete that row, the manifest becomes a lie that
// cryptography cannot detect — the hash is honest about a record that no longer matches the shelf.
// Reservation is therefore checked at every path that could dispose of stock, and this test is what
// says so out loud rather than in a comment nobody reads.
//
// Two shapes of guard, because two of the modules are deliberately PURE (no database handle, so they
// cannot ask the ledger anything). Those take a flag their caller resolves — the mergeCardFacts
// pattern — so for them the assertion is that the refusal code appears, not that the module is
// imported. Both shapes are listed explicitly, so downgrading one to the other is an edit to this file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';

const OWNER = 'runs-reserve.mjs';
const CODE = 'reserved_for_run';

// file → why it can dispose of stock, and which shape of guard it carries.
const GUARDS = [
  ['lib/shopify.mjs', 'import', 'publishes a card to the Shopify storefront'],
  ['lib/listings.mjs', 'import', 'publishes a card to eBay, singly and in batches'],
  ['lib/sealed-listing.mjs', 'import', 'sells sealed pools — SHRINKS the quantity rather than refusing'],
  ['lib/inventory.mjs', 'import', 'patches, marks sold and deletes stock rows'],
  ['lib/sealed.mjs', 'import', 'deletes sealed rows, singly and by the batch'],
  ['lib/postsale.mjs', 'import', 'decrements on a real sale — BREAKS the reservation rather than blocking it'],
  ['lib/repricer-scan.mjs', 'import', 'resolves the reservation the pure decider is handed'],
  ['lib/channels/shopify-map.mjs', 'code', 'pure mapper; validateProduct refuses on a flag the caller sets'],
  ['lib/repricer-decide.mjs', 'code', 'pure decider; eligibleForReprice refuses on a flag the caller sets'],
];

const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('every stock-disposing surface consults the reservation ledger', () => {
  for (const [file, shape, why] of GUARDS) {
    it(`${file} (${why})`, () => {
      const s = src(file);
      if (shape === 'import') {
        const specifiers = [`from './${OWNER}'`, `from '../${OWNER}'`];
        assert.ok(specifiers.some((spec) => s.includes(spec)),
          `${file} must import lib/${OWNER} — it ${why}`);
      } else {
        assert.ok(s.includes(CODE), `${file} must refuse with '${CODE}' — it ${why}`);
      }
    });
  }
});

// The sharper half. lib/db.mjs creates run_reservations; lib/runs-reserve.mjs is the only module
// allowed to read it. A second hand-written `state IN (...)` is not a style problem — it is exactly
// how `consumed` came to be subtracted from sealed on-hand twice, once by the ledger sum and once
// again by the decrement that had already happened.
describe('only the reserve module knows what the reservation states mean', () => {
  const OWNERS = new Set([path.join('lib', 'db.mjs'), path.join('lib', OWNER)]);

  function libFiles(dir = path.join(ROOT, 'lib'), acc = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) libFiles(full, acc);
      else if (e.name.endsWith('.mjs')) acc.push(path.relative(ROOT, full));
    }
    return acc;
  }

  const files = libFiles();

  // Comments are stripped first. A file SAYING "go through runs-reserve.mjs rather than touching
  // run_reservations" is the outcome this test wants, and failing it for saying so would teach the
  // next person to delete the explanation rather than the query.
  const code = (f) => src(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

  it('finds the modules to check', () => assert.ok(files.length > 20));

  for (const f of files) {
    if (OWNERS.has(f)) continue;
    it(`${f} does not query run_reservations itself`, () => {
      assert.ok(!code(f).includes('run_reservations'),
        `${f} reads run_reservations directly — go through lib/${OWNER} so the state sets stay single-source`);
    });
    it(`${f} does not restate a reservation state`, () => {
      assert.ok(!code(f).includes("'committed'"),
        `${f} names a reservation state literally — lib/${OWNER} owns that vocabulary`);
    });
  }
});

// THE HOLE THIS CLOSES, and it was open for a day. The suite above is FILE-granular: it asks whether
// lib/inventory.mjs mentions the reserve module. It did — for three routes — while a FOURTH,
// `DELETE /batches/:id?items=1`, ran `DELETE FROM inventory_items WHERE batch_id = ? AND status =
// 'in_stock'` with no check at all. A reservation never changes an item's status (it is orthogonal to
// lifecycle, by design), so reserved rows sat squarely inside that WHERE clause and were deleted
// outright, leaving the reservation dangling with no foreign key to catch it. Every test passed.
//
// So the rule is now per-STATEMENT: every statement that disposes of stock must have a guard between
// it and the top of the route that reaches it.
// THE HOLE THIS CLOSES, and it was open for a day. The suite above is FILE-granular: it asks whether
// lib/inventory.mjs mentions the reserve module. It did — for three routes — while a FOURTH,
// `DELETE /batches/:id?items=1`, ran `DELETE FROM inventory_items WHERE batch_id = ? AND status =
// 'in_stock'` with no check at all. A reservation never changes an item's status (it is orthogonal to
// lifecycle, by design), so reserved rows sat squarely inside that WHERE clause and were deleted
// outright, leaving the reservation dangling with no foreign key to catch it. Every test passed.
//
// So the rule is now per-STATEMENT: every statement that disposes of stock must have a guard between
// it and the top of the route that reaches it.

// Deleting a row, or taking it out of stock. Anchored to DELETE FROM and UPDATE ... SET status so a
// SELECT that merely COUNTS sold rows is not mistaken for disposal.
const DESTRUCTIVE = /DELETE FROM (inventory_items|sealed_items)\b|UPDATE (inventory_items|sealed_items) SET status = 'sold'/;
const GUARD = /reservationBlock\(|blockIfHeld\(|assertNotReserved\(/;
// Where a route begins in these routers: an exact path match, or a regex match into `m`.
const ROUTE_START = /^\s*if \(\(m = p\.match\(|^\s*if \(p === '/;

// Returns one string per disposing statement that has no guard above it inside its own route.
function unguardedDisposals(source) {
  const lines = source.split(/\r?\n/);
  let routeAt = -1;
  const out = [];
  let seen = 0;
  lines.forEach((line, i) => {
    if (ROUTE_START.test(line)) routeAt = i;
    if (!DESTRUCTIVE.test(line)) return;
    seen++;
    if (routeAt < 0) { out.push(`${i + 1}: outside any route — ${line.trim()}`); return; }
    if (!GUARD.test(lines.slice(routeAt, i).join('\n'))) {
      out.push(`${i + 1}: ${line.trim()} (route opens at line ${routeAt + 1})`);
    }
  });
  return { seen, unguarded: out };
}

describe('every route that disposes of stock consults the ledger, not merely every file', () => {
  for (const file of ['lib/inventory.mjs', 'lib/sealed.mjs']) {
    it(`${file} guards every disposing statement at the route that reaches it`, () => {
      const { seen, unguarded } = unguardedDisposals(src(file));
      assert.ok(seen > 0, `found no disposing statements in ${file} — the pattern drifted, not the code`);
      assert.deepEqual(unguarded, [],
        `${file} disposes of stock without consulting lib/${OWNER} first:\n  ` + unguarded.join('\n  '));
    });
  }

  // A detector that cannot fail is a comment with a green tick next to it. These two cases are the
  // real defect and its fix, reduced to their shapes, so the scan above is known to have teeth.
  it('DOES flag the shape of the defect it was written for', () => {
    const bad = [
      "      if ((m = p.match(/^\\/batches\\/(\\d+)$/)) && method === 'DELETE') {",
      '        const id = +m[1];',
      "        db.prepare(`DELETE FROM inventory_items WHERE batch_id = ? AND status = 'in_stock'`).run(id);",
      '      }',
    ].join('\n');
    const { seen, unguarded } = unguardedDisposals(bad);
    assert.equal(seen, 1);
    assert.equal(unguarded.length, 1, 'the scan missed an unguarded batch delete');
  });

  it('and does NOT flag the same route once a guard is added', () => {
    const good = [
      "      if ((m = p.match(/^\\/batches\\/(\\d+)$/)) && method === 'DELETE') {",
      '        const id = +m[1];',
      "        const hit = reservationBlock(db, row.id, q, 'delete batch items');",
      '        if (hit) return send(res, 409, hit);',
      "        db.prepare(`DELETE FROM inventory_items WHERE batch_id = ? AND status = 'in_stock'`).run(id);",
      '      }',
    ].join('\n');
    assert.deepEqual(unguardedDisposals(good).unguarded, []);
  });

  // The guard has to be inside the SAME route, not merely somewhere earlier in the file — that is
  // precisely the mistake the file-granular version made.
  it('does not accept a guard that belongs to a DIFFERENT route', () => {
    const sneaky = [
      "      if ((m = p.match(/^\\/items\\/(\\d+)$/)) && method === 'DELETE') {",
      "        const blocked = reservationBlock(db, +m[1], q, 'delete item');",
      '        if (blocked) return send(res, 409, blocked);',
      '      }',
      "      if ((m = p.match(/^\\/batches\\/(\\d+)$/)) && method === 'DELETE') {",
      "        db.prepare(`DELETE FROM inventory_items WHERE batch_id = ? AND status = 'in_stock'`).run(+m[1]);",
      '      }',
    ].join('\n');
    assert.equal(unguardedDisposals(sneaky).unguarded.length, 1,
      'a guard in the route above must not cover the route below it');
  });
});
describe('the sale path breaks the reservation rather than blocking the sale', () => {
  // The function's own text, from its declaration to the start of the next top-level one. Sliced on
  // the NEXT `export ` rather than a closing brace, because a brace-counting scan over a file with
  // template literals full of SQL is a parser nobody should be writing in a test.
  const post = src('lib/postsale.mjs');
  const from = post.indexOf('export function applyStockDecrements');
  const next = post.indexOf('export ', from + 10);
  const body = post.slice(from, next > 0 ? next : undefined);

  it('is found, so the slice below is not silently empty', () => {
    assert.ok(from > 0 && body.length > 400, 'applyStockDecrements moved or was renamed');
  });

  it('calls breakOversoldReservations', () => {
    assert.match(body, /breakOversoldReservations\(/,
      'the decrement is exempt from refusing ONLY because it reports the breakage instead — '
      + 'without the hook it is just an unguarded disposal path');
  });

  it('and does NOT refuse the sale', () => {
    assert.ok(!/blockIfHeld\(|reservationBlock\(|assertNotReserved\(/.test(body),
      'a real sale must never be blocked by a reservation — that leaves the shop believing it owns '
      + 'a card someone has already paid for');
  });
});
