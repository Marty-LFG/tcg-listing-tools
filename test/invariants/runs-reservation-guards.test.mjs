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
