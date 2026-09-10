// test/unit/runs-guards.test.mjs — the reservation refusals themselves, at the surfaces that dispose
// of stock. The invariant test proves each file CONSULTS the ledger; this one proves what happens when
// the answer is yes.
//
// Two of the guarded modules are pure — no database handle, so they cannot ask the ledger anything.
// They take a flag their caller resolves, which is the same split lib/channels/shopify-map.mjs already
// uses for card facts. That split is only safe if the flag is actually honoured, so it is pinned here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { validateProduct } from '../../lib/channels/shopify-map.mjs';
import { eligibleForReprice } from '../../lib/repricer-decide.mjs';
import { poolUnits } from '../../lib/sealed-listing.mjs';
import { holdForRun } from '../../lib/runs-reserve.mjs';

describe('shopify-map validateProduct refuses a reserved single', () => {
  // Deliberately minimal: this suite asserts only that the reservation refusal lands, so the fixture
  // carries just enough for the validator to run. lib/channels/shopify-map's own tests own the rest.
  const product = { game: 'Pokemon', kind: 'inventory', title: 'Wailord ex 016/084', metafields: [] };

  it('surfaces the caller-supplied refusal as a hard error', () => {
    const msg = 'this item is reserved for bundle E1-007 and cannot be listed or sold while that holds';
    const { errors } = validateProduct(product, { reserved_for_run: msg });
    assert.ok(errors.includes(msg), 'the reservation refusal must reach errors verbatim, naming the bundle');
  });

  it('says nothing about reservations when the caller found none', () => {
    const { errors } = validateProduct(product, {});
    assert.ok(!errors.some((e) => /reserved/i.test(e)));
  });
});

describe('eligibleForReprice refuses a reserved listing before any comps call', () => {
  const listing = (over = {}) => ({
    listingId: '168537104622', title: 'Pokemon Wailord ex 016/084 Pitch Black Double Rare Holo EN M/NM',
    priceCents: 1000, postageCents: 0, currency: 'AUD', availableQty: 3,
    listingType: 'FixedPriceItem', state: 'active', createdVia: 'manual',
    bestOffer: false, discountPricing: false, isVariation: false, ...over,
  });
  const identity = { game: 'Pokemon', name: 'Wailord ex', number: '016/084', numberSafe: true };

  it('refuses with reserved_for_run', () => {
    const e = eligibleForReprice(listing({ reservedForRun: true }), identity);
    assert.equal(e.ok, false);
    assert.equal(e.code, 'reserved_for_run');
  });

  // The refusal has to land in the CHEAP half of the check, before the eBay GetItem call the scan
  // makes to learn postage. A listing this tool must not touch should cost nothing to skip.
  it('lands before postage is known, so the skip is free', () => {
    const e = eligibleForReprice(listing({ reservedForRun: true, postageCents: null }), identity);
    assert.equal(e.code, 'reserved_for_run', 'postage_unknown would mean a GetItem was spent first');
  });

  it('the same listing is eligible once the hold is gone', () => {
    assert.equal(eligibleForReprice(listing(), identity).ok, true);
  });
});

// Sealed is the ONE guard that subtracts rather than refuses: a single sealed row genuinely supplies
// both a run and the shop, so blocking outright would take a whole pool off sale to protect three
// boosters.
describe('poolUnits shrinks a sealed pool by what a run holds', () => {
  const db = openDbAt(tmpFile('runs-guards.db'));

  it('sells the remainder, and stops at zero rather than going negative', () => {
    db.prepare(`INSERT INTO sealed_items (sku, game, product_type, name, quantity, status, pool_sku)
                VALUES ('SLD-G1','pokemon','booster_pack','Pack',12,'in_stock','POOL-G')`).run();
    const item = db.prepare(`SELECT id FROM sealed_items WHERE sku = 'SLD-G1'`).get().id;
    db.prepare(`INSERT INTO sealed_placements (item_id, location, quantity) VALUES (?,'Shelf G',12)`).run(item);

    assert.equal(poolUnits(db, 'POOL-G'), 12);
    const h = holdForRun(db, { kind: 'sealed', itemId: item, qty: 9 });
    assert.equal(poolUnits(db, 'POOL-G'), 3, 'the shop keeps selling what the run did not take');

    db.prepare(`UPDATE run_reservations SET qty = 20 WHERE id = ?`).run(h.id);
    assert.equal(poolUnits(db, 'POOL-G'), 0, 'an over-hold reads as nothing sellable, never a negative quantity');
  });
});
