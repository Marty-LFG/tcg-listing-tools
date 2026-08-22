// lib/shelf-label.mjs — allocating the owner's physical shelf label (AAA-001 …) at publish time,
// for ANY channel.
//
// WHY THIS MOVED OUT OF runPublish
//
// The rule it enforces has not changed: a staged row carries a provisional STG-* sku, and its real
// shelf label is peeked on the way to a live listing and committed only once the channel has accepted
// it. That exists because the counter is monotonic and is never rewound, so allocating at stage time
// burns a number for every row that then fails to list — 6 of 27 on 2026-07-29 (AAC-088/089/090/091/
// 093/096), each a card that previewed and was never published. Peek/commit rather than
// allocate/rollback, because a rewind can hand out a number that is already on a shelf.
//
// What HAS changed is that eBay is no longer the only channel, and Shopify publishes FIRST — possibly
// a week before eBay, possibly instead of it. Leaving the commit inside the eBay publish would mean:
//
//   · the Shopify variant SKU is `STG-000123` — the string the theme keys on, the string every order
//     line carries, and the string applyStockDecrements matches a sale against;
//   · the eventual eBay publish would have to RENAME it, orphaning every order already placed under
//     the provisional; and
//   · a card set to never list on eBay would sit under a placeholder for ever.
//
// So the commit belongs to "the first real publish on any channel", which is what this module is. The
// original justification survives intact — the labels were burned by PREVIEWS, not by publishes, and a
// real publish on either channel means the card is genuinely on the shelf and genuinely for sale,
// which is exactly when a label should be spent.
//
// The two halves stay separate because the channel call sits between them: reserve, publish, commit.
import { isProvisionalSku, peekStockLabel, commitStockLabel } from './inventory.mjs';

export { isProvisionalSku };

/**
 * reserveShelfLabel(db, item, opts) — decide what SKU this publish should use.
 *
 * Returns { ok, sku, reservation, error }:
 *   · sku          what to publish under. The caller sets it on the outbound listing/product.
 *   · reservation  { label, seq } to hand to commitShelfLabel afterwards, or null when there is
 *                  nothing to commit (a dry run, or a row that already holds a real label).
 *   · ok:false     the series is unseeded, so there is no label to give. A REFUSAL, not a fallback:
 *                  publishing under the provisional would bind it to the listing for life, which is
 *                  the very bug this replaces (GR7 — degrade visibly, never guess).
 *
 * Idempotent by construction: a row whose sku is already a real shelf label reserves nothing and
 * commits nothing, so a republish, a revise or a second channel all pass straight through.
 *
 * A DRY RUN never reserves. A canary that consumed a shelf number would reintroduce the original bug,
 * and the cost — a provisional record left behind on the channel — is the caller's to tidy up.
 */
export function reserveShelfLabel(db, item, { dryRun = false, channel = 'ebay' } = {}) {
  const sku = item && item.sku;
  if (dryRun || !isProvisionalSku(sku)) return { ok: true, sku, reservation: null };

  const peeked = peekStockLabel(db);
  if (!peeked) {
    return {
      ok: false,
      sku,
      reservation: null,
      error: `the stock label series is not seeded, so there is no shelf label to give ${sku}`
        + ` — seed it under Settings → labels before publishing staged rows to ${channel}`,
    };
  }
  return { ok: true, sku: peeked.label, reservation: peeked };
}

/**
 * commitShelfLabel(db, item, reservation, opts) — bind a peeked label now the channel has accepted it.
 *
 * MUTATES item.sku on success, because everything downstream of a publish — the audit row, the
 * write-back, the channel mirror — keys off it, and a row that just listed as AAC-097 must not be
 * recorded against the placeholder it used to carry.
 *
 * Never throws. On failure the listing is LIVE under the label while the stock row still says STG-*,
 * which is worth a loud line: the audit row is then the only record of which label the channel bound.
 * Both channels get identical handling because both call this.
 *
 * Returns { committed, label, provisional, error }. `provisional` is the sku that was displaced — the
 * caller needs it for channel-side cleanup, and it is only meaningful when committed is true.
 */
export function commitShelfLabel(db, item, reservation, { channel = 'ebay' } = {}) {
  if (!reservation) return { committed: false, label: null, provisional: null, error: null };
  const provisional = item.sku;
  try {
    commitStockLabel(db, item.id, reservation.label, reservation.seq);
    item.sku = reservation.label;
    return { committed: true, label: reservation.label, provisional, error: null };
  } catch (e) {
    const error = e?.message || String(e);
    console.warn(`[shelf-label] commit FAILED for ${provisional} — the ${channel} listing is live as `
      + `${reservation.label} but the stock row still holds the placeholder:`, error);
    return { committed: false, label: reservation.label, provisional, error };
  }
}
