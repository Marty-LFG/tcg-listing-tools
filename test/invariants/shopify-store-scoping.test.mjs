// test/invariants/shopify-store-scoping.test.mjs — one install, two Shopify stores, no leakage.
//
// THE DEFECT THIS PREVENTS. `shopify_listings` was keyed on `sku` alone and `shopify_files` on
// `content_hash` alone, on the stated assumption that "a second Shopify store would be a different
// install, not a different row". That stopped being true the day storeFor() started reading `?store=`
// per request and guardLiveStore was written so ONE install could reach both. With one row per SKU:
//
//   · recordShopifyListing UPSERTs, so a live publish overwrote the dev rehearsal's product GID — and
//     when the live attempt FAILED, the COALESCE-preserve logic kept the dev GID alive instead.
//   · the already-live skip made the live cutover run pass over every card dev had published.
//   · rebuildIdentity wrote dev product GIDs into a live store's bk_card_identity, so the PDP's
//     condition selector linked every tile to a 404.
//   · the published-handle collision check REFUSED live work because of a dev product.
//   · sweep-shopify-dev's DELETE erased the LIVE mirror row for the SKU it swept from dev.
//   · shopify_files handed a live publish a dev MediaImage gid, which productSet refuses outright
//     with INVALID_INPUT — and the self-heal then "recovered" from it on every card, forever.
//
// The rule is now structural rather than remembered: any statement that READS OR WRITES rows in either
// table names `store`. DDL is exempt (it defines the column rather than filtering on it), and three
// statements are exempt with a stated reason — see EXEMPT.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/extract-inline.mjs';

const TABLES = /\b(shopify_listings|shopify_files)\b/;
const DML = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
// CREATE/DROP/ALTER define the table; they do not filter it. `_new` is the rebuild's scratch table.
const DDL = /\b(CREATE\s+(TABLE|INDEX|UNIQUE)|DROP\s+TABLE|ALTER\s+TABLE|PRAGMA)\b/i;

// Deliberate exemptions. Each is keyed on a distinctive fragment of the statement itself, so a rewrite
// that changes the statement loses its exemption and has to re-argue for it here.
const EXEMPT = [
  {
    // A shelf label is PHYSICAL — a number written on the card in the box. One card has one label
    // whichever store it is published to, so a dev rehearsal that claimed AAC-085 and failed must hand
    // that same number to the live run rather than burning a second one. Scoping this by store would
    // allocate a label per store and leave the box disagreeing with the ledger.
    why: 'the shelf-label reclaim is store-blind because the label is physical',
    match: /state IN \('pending', 'failed'\)/,
  },
  {
    // A file_gid is gid://shopify/MediaImage/<n> and exists on exactly one store, so matching on it
    // already selects a single store's row. Adding a store predicate would be noise, not safety.
    why: 'file_gid is itself store-unique, so it cannot match across stores',
    match: /DELETE FROM shopify_files WHERE file_gid/,
  },
  {
    // labelTaken() asks "has this shelf label been handed out", and the answer must not depend on which
    // store is asking: the label is written on the card, and issuing AAC-085 twice because the first
    // one was only ever published to dev would put two physical cards under one number. Deliberately
    // store-blind, and lib/inventory.mjs says so at the function.
    why: 'labelTaken is store-blind because a shelf label is physical',
    match: /SELECT 1 FROM shopify_listings WHERE sku = \?/,
  },
];

// The rebuild's own INSERT ... SELECT carries the literal 'dev' rather than a bound predicate; it is
// covered by naming `store` in the column list, so no exemption is needed for it.

function sqlLiterals(src) {
  // Template, single- and double-quoted literals. SQL in this repo lives in all three.
  const out = [];
  for (const re of [/`([^`]*)`/g, /'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g]) {
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out;
}

function sources() {
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(path.join(dir, e.name), rel); continue; }
      if (e.name.endsWith('.mjs')) files.push(path.join(dir, e.name));
    }
  };
  walk('lib');
  walk('scripts');
  return files.sort();
}

describe('every shopify_listings / shopify_files statement names its store', () => {
  for (const file of sources()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!TABLES.test(src)) continue;
    it(file, () => {
      const offenders = sqlLiterals(src)
        .filter((s) => TABLES.test(s) && DML.test(s) && !DDL.test(s))
        .filter((s) => !/\bstore\b/.test(s))
        .filter((s) => !EXEMPT.some((e) => e.match.test(s)))
        .map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 140));
      assert.deepEqual(offenders, [],
        `${file}: these statements touch a per-store table without naming store.\n` +
        'Add the predicate, or add an entry to EXEMPT in this file with the reason.');
    });
  }

  it('the exemptions are still reachable', () => {
    // An exemption nobody matches is a rule that has quietly stopped applying — and the next reader
    // would take it as evidence the store-blind case is still live code.
    const all = sources().map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const lits = sqlLiterals(all);
    for (const e of EXEMPT) {
      assert.ok(lits.some((s) => e.match.test(s)), `stale exemption — nothing matches "${e.why}"`);
    }
  });
});
