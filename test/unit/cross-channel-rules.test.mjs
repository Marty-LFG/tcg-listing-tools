// test/unit/cross-channel-rules.test.mjs — the small rules the cross-channel build rests on, each one
// a place a quiet mistake would put a sold card back on sale.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { openDbAt } from '../../lib/db.mjs';
import { saleChannelOf, assertNotLiveOnShopify, assertNotLiveOnEbay, migrateChannelSync, ebayPresence } from '../../lib/channel-presence.mjs';
import { setAvailableQty } from '../../lib/channels/shopify-product-api.mjs';
import { shopifyStub, SHOPIFY_ENV, LOC } from '../helpers/channel-stubs.mjs';

describe('saleChannelOf — which channel already took its own unit', () => {
  it('reads the namespaced order id', () => {
    assert.equal(saleChannelOf({ ref_kind: 'order', ref_id: 'shopify:5001' }), 'shopify');
    assert.equal(saleChannelOf({ ref_kind: 'order', ref_id: '12-34567-89012' }), 'ebay');
  });
  it('names no channel for anything that is not an order — every channel is told', () => {
    assert.equal(saleChannelOf({ ref_kind: 'in_person', ref_id: 'ips-1' }), null);
    assert.equal(saleChannelOf({ ref_kind: 'order', ref_id: null }), null, 'a Runs pack consume carries no order id');
    assert.equal(saleChannelOf({ ref_kind: 'item', ref_id: '9' }), null);
  });
});

describe('setAvailableQty — never raises without allowRaise', () => {
  const inv = 'gid://shopify/InventoryItem/1';
  const set = (levels, quantity, extra = {}) => {
    const s = shopifyStub({ levels });
    return setAvailableQty({ ...SHOPIFY_ENV, SHOPIFY_DEV_SHOP: 'x' }, { inventoryItemGid: inv, locationGid: LOC, quantity, fetchImpl: s.fn, ...extra })
      .then((r) => ({ r, s }));
  };

  it('HOLDS a raise: reads, writes nothing, says what it wanted', async () => {
    const { r, s } = await set({ [inv]: 0 }, 1);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'held');
    assert.deepEqual({ from: r.from, to: r.to, wanted: r.wanted, available: r.available }, { from: 0, to: 0, wanted: 1, available: 0 });
    assert.deepEqual(s.ops(), ['readLevel']);
  });
  it('raises with allowRaise', async () => {
    const { r, s } = await set({ [inv]: 0 }, 2, { allowRaise: true });
    assert.equal(r.action, 'set');
    assert.equal(s.state.levels[inv], 2);
  });
  it('always lowers', async () => {
    const { r, s } = await set({ [inv]: 3 }, 1);
    assert.equal(r.action, 'set');
    assert.equal(s.state.levels[inv], 1);
  });
  it('an unstocked location activates at ZERO without the flag, and at the quantity with it', async () => {
    const a = await set({}, 1);
    assert.equal(a.r.action, 'activate');
    assert.equal(a.r.held, true);
    assert.equal(a.s.state.levels[inv], 0);
    const b = await set({}, 1, { allowRaise: true });
    assert.equal(b.s.state.levels[inv], 1);
  });
  it('a stale compare re-reads, and a sale that landed in between turns the write into a hold', async () => {
    // Shopify reads 3, we want 2; between our read and our write a sale takes it to 1. The re-read sees
    // 1 < 2 and holds rather than writing 2 back over the sale.
    const s = shopifyStub({ levels: { [inv]: 3 } });
    let reads = 0;
    const fn = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      if (body && body.query.includes('inventoryItem(id:') && ++reads === 2) s.state.levels[inv] = 1;
      if (body && body.query.includes('inventorySetQuantities') && reads === 1) s.state.levels[inv] = 99;   // force the first CAS stale
      return s.fn(url, init);
    };
    const r = await setAvailableQty({ ...SHOPIFY_ENV, SHOPIFY_DEV_SHOP: 'x' }, { inventoryItemGid: inv, locationGid: LOC, quantity: 2, fetchImpl: fn });
    assert.equal(r.action, 'held', JSON.stringify(r));
    assert.equal(s.state.levels[inv], 1);
  });
});

describe('the one-channel refusals', () => {
  const DIR = tmpDir('tcg-ccrules-');
  let db, id;
  before(() => {
    db = openDbAt(path.join(DIR, 'tracker.db'));
    migrateChannelSync(db);
    id = Number(db.prepare("INSERT INTO inventory_items (sku, game, name, quantity, status) VALUES ('AAX-1','pokemon','Card',1,'listed')").run().lastInsertRowid);
  });
  after(() => { try { db.close(); } catch {} });

  it('only a LIVE store row counts — a dev rehearsal is not a second channel', () => {
    db.prepare("INSERT INTO shopify_listings (sku, store, kind, item_id, state, available_qty) VALUES ('AAX-1','dev','inventory',?, 'live', 1)").run(id);
    assert.equal(assertNotLiveOnShopify(db, { itemId: id }), null);
    db.prepare("INSERT INTO shopify_listings (sku, store, kind, item_id, state, available_qty) VALUES ('AAX-1','live','inventory',?, 'live', 1)").run(id);
    assert.equal(assertNotLiveOnShopify(db, { itemId: id }).code, 'live_on_shopify');
  });

  it('the dual-list flag is ignored for a one-of-one and honoured above one', () => {
    assert.equal(assertNotLiveOnShopify(db, { itemId: id, quantity: 1, allowDualList: true }).code, 'live_on_shopify');
    assert.equal(assertNotLiveOnShopify(db, { itemId: id, quantity: 2, allowDualList: true }), null);
    assert.match(assertNotLiveOnShopify(db, { itemId: id, quantity: 2 }).error, /allowDualList/);
  });

  it('a tool listing still counts as live after the sale decrement wrote channel_status=ended', () => {
    // lib/postsale.mjs writes channel_status='ended' on sell-out assuming eBay ended it — wrong for a
    // Shopify sale. The ebay_listings mirror is the second witness.
    db.prepare("UPDATE inventory_items SET ebay_offer_id = 'OF-X', channel_status = 'ended' WHERE id = ?").run(id);
    assert.equal(ebayPresence(db, 'inventory', { itemId: id }).length, 0, 'no mirror row yet: nothing says it is live');
    db.prepare("INSERT INTO ebay_listings (sku, marketplace, offer_id, item_id, listing_status) VALUES ('AAX-1','EBAY_AU','OF-X',?, 'ACTIVE')").run(id);
    assert.equal(ebayPresence(db, 'inventory', { itemId: id })[0].api, 'inventory');
    assert.equal(assertNotLiveOnEbay(db, { itemId: id }).code, 'live_on_ebay');
  });
});
