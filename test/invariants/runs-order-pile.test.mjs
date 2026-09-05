// test/invariants/runs-order-pile.test.mjs — a run SKU must never reach the stock-decrement sweep.
//
// THE TWO-BITE PROBLEM. A Keeper's Run bundle's stock is drawn down at PACK time by consumeReservation,
// off run_reservations. If an order line for that bundle ALSO reached applyStockDecrements, the same
// physical objects would be decremented twice — once for the pack, once for the sale.
//
// AND THE SILENT PILE. applyStockDecrements does `if (!m) continue` on a line it cannot match: the row is
// never stamped, so it is re-selected on every sweep forever with no alert. A BK-RUN-* SKU matches no
// inventory_items or sealed_items row, so without the exclusion every run sale would join that pile —
// and the header comment on that function records the real-world symptom it already caused once:
// "matched:0 while the pending list grew".
//
// THE COUPLING THIS PINS. lib/postsale.mjs cannot import lib/runs-shopify.mjs — that would add a fourth
// edge to the listings -> runs-reserve -> postsale -> listings cycle that consumeReservation's dynamic
// import already exists to avoid. So the prefix is a LITERAL in the SQL, and a literal that has to agree
// with a constant somewhere else is exactly the thing that drifts. This is the test that notices.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUN_SKU_PREFIX, runVariantSku, isRunSku } from '../../lib/runs-shopify.mjs';

const POSTSALE = readFileSync(new URL('../../lib/postsale.mjs', import.meta.url), 'utf8');

describe('the sweep excludes run SKUs', () => {
  it('applyStockDecrements filters them out in SQL', () => {
    assert.match(POSTSALE, /li\.sku NOT LIKE 'BK-RUN-%'/,
      'the pending-line query no longer excludes run SKUs');
  });

  it('and the literal agrees with RUN_SKU_PREFIX', () => {
    // The whole reason this file exists. Change the prefix in one place and this fails rather than
    // quietly letting every run sale decrement stock a second time.
    const m = /li\.sku NOT LIKE '([A-Z-]+)%'/.exec(POSTSALE);
    assert.ok(m, 'could not find the exclusion literal');
    assert.equal(m[1], RUN_SKU_PREFIX,
      `postsale excludes "${m[1]}" but run SKUs start "${RUN_SKU_PREFIX}"`);
  });

  it('and a real variant SKU is caught by that pattern', () => {
    const sku = runVariantSku({ public_id: 'DEV-E1' }, 7);
    assert.ok(sku.startsWith(RUN_SKU_PREFIX));
    assert.ok(isRunSku(sku));
  });

  it('while an ordinary shelf SKU is not', () => {
    // The exclusion must be narrow. A pattern that also swallowed BK-PKM-000042 would stop the sweep
    // decrementing real singles, which is the failure this guard would otherwise cause.
    for (const sku of ['BK-PKM-000042', 'BK-RAW-PKM-000007', 'SLD-PKM-000003', 'STG-000123']) {
      assert.ok(!sku.startsWith(RUN_SKU_PREFIX), sku);
      assert.ok(!isRunSku(sku), sku);
    }
  });
});

describe('postsale stays out of the runs module', () => {
  it('imports nothing from lib/runs-shopify.mjs', () => {
    // listings -> runs-reserve -> postsale -> listings is already a cycle, which is why
    // consumeReservation reaches postsale through a DYNAMIC import. A static import here would close a
    // fourth edge and hand one module a half-initialised binding.
    assert.ok(!/from '\.\/runs-shopify\.mjs'/.test(POSTSALE));
    assert.ok(!/from '\.\/runs-ledger\.mjs'/.test(POSTSALE));
  });

  it('and still reaches runs-reserve only for the broken-reservation back-channel', () => {
    // That one IS allowed and is load-bearing: a reserved item genuinely selling elsewhere must break the
    // reservation rather than block the sale, or the shop would believe it still owns a card someone paid
    // for. It is wrapped in a try/catch so a runs failure can never take down the sweep.
    assert.match(POSTSALE, /breakOversoldReservations/);
  });
});
