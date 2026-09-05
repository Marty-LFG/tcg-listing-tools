// test/invariants/stock-ledger-single-writer.test.mjs — one door for stock quantity.
//
// THE DRIFT THIS PREVENTS. Before the ledger, inventory_items.quantity and sealed_items.quantity were
// written from a dozen places — a receive, a sale, a reversal, a hand edit, a bulk re-import, an eBay
// read-back — and every one of them was a destructive UPDATE. The number was always current and never
// explicable, and the two roll-ups over it disagreed with each other for two years without anyone
// noticing, because nothing could be checked against anything.
//
// The rule is now structural rather than remembered: only lib/stock-ledger.mjs writes those two columns.
// Everything else calls applyMovement or setQuantity, which record WHY alongside the number.
//
// Deliberately NOT a check on sealed_placements.quantity. That is the per-shelf split, and lib/sealed.mjs
// owns it the way this module owns the item total — recomputeItemStock is the seam between them, and it
// is already routed.
//
// Paired with a POSITIVE check, because an absence-only test passes just as happily on a codebase that
// stopped tracking stock altogether.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, stripComments } from '../helpers/extract-inline.mjs';

const OWNER = path.join('lib', 'stock-ledger.mjs');

// An UPDATE that assigns the quantity column on one of the two stock tables. The tables are named on
// the same statement, which is what keeps sealed_placements and every other `quantity` out of it.
// TWO BLIND SPOTS THE FIRST VERSION HAD, both found in review, one of them hiding a live violation.
//
//   `[^`'"]*` could not cross a quote, so `SET status = 'sold', quantity = 0` escaped the rule
//   entirely - reordering two columns silently defeated it. `[\s\S]*?` is non-greedy, so it still
//   cannot run past the end of one statement.
//
//   A dynamically built column list - `SET ${cols.join(', ')}` - names no columns in the source at
//   all, so no regex over SQL literals can see it. The sealed PATCH was exactly that shape and was
//   writing quantity directly while this test passed. Those are caught structurally instead, below.
const WRITES = [
  /UPDATE\s+inventory_items\s+SET[\s\S]*?\bquantity\s*=/i,
  /UPDATE\s+sealed_items\s+SET[\s\S]*?\bquantity\s*=/i,
];
const DYNAMIC = [
  /UPDATE\s+inventory_items\s+SET\s+\$\{/i,
  /UPDATE\s+sealed_items\s+SET\s+\$\{/i,
];

function sqlLiterals(src) {
  const out = [];
  for (const re of [/`([^`]*)`/g, /'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g]) {
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out;
}

function serverSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(path.join(dir, e.name)); continue; }
      if (e.name.endsWith('.mjs')) out.push(path.join(dir, e.name));
    }
  };
  walk('lib');
  walk('scripts');
  return out.sort();
}

describe('only lib/stock-ledger.mjs writes stock quantity', () => {
  for (const file of serverSources()) {
    if (file === OWNER) continue;
    it(file + ' goes through the ledger', () => {
      const src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const offenders = sqlLiterals(src)
        .filter((sql) => WRITES.some((re) => re.test(sql)))
        .map((sql) => sql.replace(/\s+/g, ' ').trim().slice(0, 140));
      assert.deepEqual(offenders, [],
        `${file} writes a stock quantity directly. Call applyMovement or setQuantity from `
        + 'lib/stock-ledger.mjs instead, so the change carries a reason.');
    });
  }

  // A whitelist UPDATE cannot be read for a column name, so the guard is the deletion that keeps
  // quantity out of the whitelist in the first place. This is precisely what the sealed PATCH lacked.
  for (const file of serverSources()) {
    if (file === OWNER) continue;
    const src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    if (!sqlLiterals(src).some((sql) => DYNAMIC.some((re) => re.test(sql)))) continue;
    it(file + ' keeps quantity out of its dynamic column list', () => {
      assert.match(src, /delete\s+\w+\.quantity/,
        `${file} builds an UPDATE from a column list, so no regex can tell whether quantity is in it. `
        + 'Delete it from that object and route the change through setQuantity.');
    });
  }

  it('the ledger module itself still writes them — an absence-only rule proves nothing', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, OWNER), 'utf8'));
    const writes = sqlLiterals(src).filter((sql) => /UPDATE\s+\$\{table\}\s+SET\s+quantity\s*=/i.test(sql));
    assert.ok(writes.length, 'lib/stock-ledger.mjs no longer maintains the cache it owns');
  });

  it('the callers that move stock actually import it', () => {
    // The seams that matter: receiving, the sale path, and the eBay read-back. A file that stopped
    // importing the ledger would pass the absence check above by writing nothing at all.
    for (const f of ['lib/inventory.mjs', 'lib/sealed.mjs', 'lib/postsale.mjs', 'lib/listings.mjs']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.match(src, /from '\.\/stock-ledger\.mjs'/, `${f} no longer reaches for the ledger`);
    }
  });
});
