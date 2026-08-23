// pokemontcg.io paging — a source-level guard, because the failure is invisible in the output.
//
// `orderBy=number` on that API is a STRING sort (lib/runner-core.mjs numRank exists precisely
// because of it), so it buys no useful order — and it BREAKS PAGING. Measured 2026-08-23 on
// me2pt5 (Ascended Heroes, 295 cards): with orderBy, page 2 came back as 45 rows already served on
// page 1, giving a fetch that was exactly totalCount long, passed the completeness check on its row
// count, and was written to a cache that never expires. Result: 250 unique cards, 45 duplicates,
// nothing above #250, and every card past 250 unlistable while the set looked complete everywhere.
//
// Without orderBy the same two requests return #1-250 and #251-295, cleanly and in numeric order.
// This test is static rather than live because the symptom only appears on sets over 250 cards and
// only against a live upstream — by the time a test could see it, it is already cached forever.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('nothing asks pokemontcg.io to order a paged fetch', () => {
  const PAGED = ['lib/pkm-cards-cache.mjs', 'lib/catalog.mjs', 'lib/enumerate.mjs'];

  for (const f of PAGED) {
    it(`${f} does not send orderBy`, () => {
      let src;
      try { src = read(f); } catch { return; }               // the file may not exist in a trimmed tree
      const hits = src.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /orderBy/.test(line) && !/^\s*(\/\/|\*)/.test(line));
      assert.deepEqual(hits.map((h) => `${f}:${h.n}`), [],
        'orderBy=number makes page 2 re-serve page 1 rows on a set over 250 cards');
    });
  }

  it('the paged fetch still asks for the maximum page size', () => {
    // Dropping orderBy must not quietly become "drop the paging too" — a single unpaged request
    // truncates every set over 250 with no error at all.
    const src = read('lib/pkm-cards-cache.mjs');
    assert.match(src, /const PAGE_SIZE = 250;/);
    assert.match(src, /&page=' \+ page/, 'the page number has to reach the URL');
  });
});
