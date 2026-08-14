// test/integration/deferred-label.test.mjs — the shelf label is spent only on a CONFIRMED listing.
//
// THE BUG THIS LOCKS DOWN (2026-07-29): staging allocated a label up front, the label counter is
// monotonic and is never rewound, so every staged row that then failed to list burned its number for
// good. 6 of 27 labels were gone that way — AAC-088/089/090/091/093/096, each a card that previewed
// and was never published. Staging now takes a provisional STG-* sku and earns a real label at
// publish, committed only once eBay says yes.
//
// The invariant under test is narrow and worth stating plainly: after ANY unsuccessful publish, the
// sku_counter must sit exactly where it did before the attempt.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { runPublish } from '../../lib/listings.mjs';
import { isProvisionalSku, nextProvisionalSku, peekStockLabel, upcomingStockLabels, commitStockLabel, seedStockLabels, stockLabelState } from '../../lib/inventory.mjs';
import { testEbayConfig } from '../helpers/ebay-config.mjs';

const ENV = { EBAY_REFRESH_TOKEN: 'fake', EBAY_CERT_ID: 'c' };
const CFG = testEbayConfig({ genericImage: { enabled: false } });

let db, tmpDir, itemId;
const realFetch = globalThis.fetch;
let published, deleted, publishFails;

function resp(status, json, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => (json == null ? '' : JSON.stringify(json)), arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer };
}
function installStub() {
  let offerSeq = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const m = opts.method || 'GET';
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    if (u.includes('images.pokemontcg.io')) return resp(200, null, { 'content-type': 'image/png' });
    if (u.includes('/media/v1_beta/image/create_image_from_file')) return resp(201, {}, { location: 'https://apim.ebay.com/commerce/media/v1_beta/image/IMG1' });
    if (u.includes('/media/v1_beta/image/IMG1')) return resp(200, { imageUrl: 'https://i.ebayimg.com/IMG1.jpg', expirationDate: '2099-01-01T00:00:00Z' });
    if (u.includes('/inventory_item/') && m === 'DELETE') { deleted.push(decodeURIComponent(u.split('/inventory_item/')[1])); return resp(204, null); }
    if (u.includes('/inventory_item/') && m === 'PUT') return resp(204, null);
    if (u.match(/\/offer\?sku=/) && m === 'GET') { const sku = decodeURIComponent(u.split('sku=')[1]); const oid = published.get(sku); return resp(200, { offers: oid ? [{ offerId: oid, marketplaceId: 'EBAY_AU' }] : [] }); }
    if (u.endsWith('/offer') && m === 'POST') { const body = JSON.parse(opts.body); const oid = 'OFFER-' + (++offerSeq); published.set(body.sku, oid); return resp(200, { offerId: oid }); }
    if (u.match(/\/offer\/[^/]+$/) && m === 'PUT') return resp(200, {});
    if (u.match(/\/offer\/[^/]+\/publish$/) && m === 'POST') {
      // The failure we actually lived: eBay refuses at PUBLISH, after the item + offer already exist.
      if (publishFails) return resp(400, { errors: [{ errorId: 25002, message: 'A user error has occurred.' }] });
      return resp(200, { listingId: '2255' + offerSeq });
    }
    if (u.includes('/offer/get_listing_fees')) return resp(200, { feeSummaries: [{ fees: [{ feeType: 'INSERTION', amount: { value: '0.00', currency: 'AUD' } }] }] });
    return resp(404, { errors: [{ errorId: 1, message: 'unstubbed ' + m + ' ' + u }] });
  };
}

const counterSeq = () => (db.prepare("SELECT seq FROM sku_counter WHERE namespace = 'LABEL'").get() || {}).seq ?? null;
const skuOf = (id) => db.prepare('SELECT sku FROM inventory_items WHERE id = ?').get(id).sku;

// The eBay-side cleanup is deliberately fire-and-forget in runPublish (a listed card must never fail
// on tidy-up), and it mints a token before the DELETE, so it lands several turns after runPublish
// resolves. Poll for it rather than guessing a tick count — and let it settle before the next test,
// otherwise a straggler DELETE lands in the following test's array.
async function waitFor(pred, ms = 2000) {
  for (let waited = 0; waited < ms; waited += 10) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-deferlabel-'));
  db = openDbAt(path.join(tmpDir, 'tracker.db'));
});
after(() => { globalThis.fetch = realFetch; try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(() => {
  published = new Map(); deleted = []; publishFails = false;
  installStub();
  db.exec("DELETE FROM inventory_items; DELETE FROM ebay_listings; DELETE FROM listing_pushes; DELETE FROM listing_images; DELETE FROM sku_counter;");
  // Series seeded at AAC-096, so the next free label is AAC-097 — the real state on the day the bug
  // was found. Blocks are 99 wide, so AAC (block 2) starts at 199: seq = 2*99 + 96 = 294.
  seedStockLabels(db, 294);
  const r = db.prepare(`INSERT INTO inventory_items (sku, game, name, set_name, number, variant, language, condition, quantity, target_price_cents, image_url, status)
                        VALUES ('STG-000001','pokemon','Pikachu','Base Set','58/102','Regular','EN','Near Mint',1,1299,'https://images.pokemontcg.io/base1/58.png','in_stock')`).run();
  itemId = r.lastInsertRowid;
});

describe('provisional sku + peek/commit primitives', () => {
  it('recognises a provisional sku and never a shelf label', () => {
    assert.equal(isProvisionalSku('STG-000001'), true);
    assert.equal(isProvisionalSku('stg-000042'), true, 'case-insensitive');
    for (const real of ['AAC-097', 'AAA-001', 'BK-RAW-PKM-000001', '', null]) {
      assert.equal(isProvisionalSku(real), false, real + ' is not provisional');
    }
  });

  it('hands out provisional skus from their own namespace, leaving the label series alone', () => {
    const before = counterSeq();
    assert.equal(nextProvisionalSku(db), 'STG-000001');
    assert.equal(nextProvisionalSku(db), 'STG-000002');
    assert.equal(counterSeq(), before, 'the shelf series did not move');
  });

  it('peek is read-only and repeatable — the same label until something commits', () => {
    const before = counterSeq();
    assert.deepEqual(peekStockLabel(db), { label: 'AAC-097', seq: 295 });
    assert.deepEqual(peekStockLabel(db), { label: 'AAC-097', seq: 295 }, 'peeking twice does not advance');
    assert.equal(counterSeq(), before);
  });

  it('peek skips a label already taken by a stock row', () => {
    db.prepare(`INSERT INTO inventory_items (sku, game, name, status) VALUES ('AAC-097','pokemon','Held','in_stock')`).run();
    assert.equal(peekStockLabel(db).label, 'AAC-098', 'never reuse a number that is on a shelf');
  });

  it('commit binds the label to the row and moves the series forward exactly once', () => {
    const { label, seq } = peekStockLabel(db);
    commitStockLabel(db, itemId, label, seq);
    assert.equal(skuOf(itemId), 'AAC-097');
    assert.equal(counterSeq(), 295);
    assert.equal(peekStockLabel(db).label, 'AAC-098', 'the next row gets the next number');
  });

  it('returns null when the series was never seeded, rather than starting at AAA-001', () => {
    db.exec("DELETE FROM sku_counter");
    assert.equal(peekStockLabel(db), null);
  });
});

// The batch runner shows every queued row the number it is heading for, so it needs the whole run in
// one read. Counting up from `next` client-side is what this exists to prevent: the series skips
// labels that are already spoken for, so next+1 is not the next row's label.
describe('upcomingStockLabels — a peek for a whole batch', () => {
  it('hands out a DIFFERENT label per row, in order', () => {
    assert.deepEqual(upcomingStockLabels(db, 4), ['AAC-097', 'AAC-098', 'AAC-099', 'AAD-001']);
  });

  it('is read-only — the counter has not moved', () => {
    const before = counterSeq();
    upcomingStockLabels(db, 10);
    assert.equal(counterSeq(), before);
  });

  it('skips numbers already taken, so the run is not simply next+1, next+2', () => {
    db.prepare(`INSERT INTO inventory_items (sku, game, name, status) VALUES ('AAC-098','pokemon','On a shelf','in_stock')`).run();
    db.prepare(`INSERT INTO inventory_items (sku, game, name, status) VALUES ('AAD-001','pokemon','Also held','in_stock')`).run();
    assert.deepEqual(upcomingStockLabels(db, 3), ['AAC-097', 'AAC-099', 'AAD-002']);
  });

  it('agrees with peekStockLabel about the first one, whatever is in the way', () => {
    db.prepare(`INSERT INTO inventory_items (sku, game, name, status) VALUES ('AAC-097','pokemon','Held','in_stock')`).run();
    assert.equal(upcomingStockLabels(db, 5)[0], peekStockLabel(db).label);
  });

  it('an unseeded series yields nothing rather than starting at AAA-001', () => {
    db.exec("DELETE FROM sku_counter");
    assert.deepEqual(upcomingStockLabels(db, 5), []);
  });

  it('clamps a silly ask instead of walking the whole series', () => {
    assert.equal(upcomingStockLabels(db, 100000).length, 500);
    assert.equal(upcomingStockLabels(db, 0).length, 1);
    assert.equal(upcomingStockLabels(db, -3).length, 1);
  });
});

describe('runPublish — the label is spent only on a confirmed listing', () => {
  it('a successful publish swaps the provisional sku for a real label', async () => {
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.sku, 'AAC-097', 'the result carries the label, not the placeholder');
    assert.equal(skuOf(itemId), 'AAC-097');
    assert.equal(counterSeq(), 295, 'series advanced by exactly one');
    // eBay must have been called under the REAL label — the Custom label is bound for life.
    assert.ok(published.has('AAC-097'), 'the offer was created under the shelf label');
    assert.ok(!published.has('STG-000001'), 'never under the placeholder');
    // The mirror is keyed by the label, which is what postsale + reconcile match on.
    assert.equal(db.prepare('SELECT sku FROM ebay_listings WHERE item_id = ?').get(itemId).sku, 'AAC-097');
  });

  it('a FAILED publish leaves the series exactly where it was — the whole point', async () => {
    publishFails = true;
    const before = counterSeq();
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(out.ok, false);
    assert.equal(counterSeq(), before, 'no label burned on a failed publish');
    assert.equal(skuOf(itemId), 'STG-000001', 'the row keeps its placeholder and can be retried');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ebay_listings WHERE item_id = ?').get(itemId).n, 0);
  });

  it('a retry after a failure gets the SAME label that the failure did not consume', async () => {
    publishFails = true;
    assert.equal((await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false })).ok, false);
    publishFails = false;
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(out.ok, true, out.error);
    assert.equal(skuOf(itemId), 'AAC-097', 'no gap opened by the failed attempt');
    assert.equal(counterSeq(), 295);
  });

  it('a local validation refusal never even peeks — nothing reaches eBay', async () => {
    db.prepare('UPDATE inventory_items SET target_price_cents = 99 WHERE id = ?').run(itemId);
    const before = counterSeq();
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(out.ok, false);
    assert.match(out.error, /under eBay’s A\$1\.00 minimum/);
    assert.equal(counterSeq(), before);
    assert.equal(skuOf(itemId), 'STG-000001');
    assert.equal(published.size, 0, 'the price guard fired before any eBay call');
  });

  it('a dry run keeps the placeholder and spends nothing — the canary must stay free', async () => {
    const before = counterSeq();
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: true });
    assert.equal(out.ok, true, out.error);
    assert.equal(counterSeq(), before, 'a canary that consumed a label would be the original bug');
    assert.equal(skuOf(itemId), 'STG-000001');
    assert.ok(published.has('STG-000001'), 'the preview offer rides the placeholder');
  });

  it('publishing after a canary tidies up the placeholder record left on eBay', async () => {
    await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: true });
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(out.ok, true, out.error);
    assert.equal(skuOf(itemId), 'AAC-097');
    // eBay keys inventory by SKU, so the canary's STG-* record is a separate item and would sit in
    // the account forever. Deleting it is best-effort, but it must actually be attempted.
    assert.ok(await waitFor(() => deleted.includes('STG-000001')), 'the placeholder inventory item was dropped');
  });

  it('a row that already owns a real label is untouched by any of this', async () => {
    db.prepare("UPDATE inventory_items SET sku = 'AAB-050' WHERE id = ?").run(itemId);
    const before = counterSeq();
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(out.ok, true, out.error);
    assert.equal(skuOf(itemId), 'AAB-050', 'no re-labelling of an already-labelled row');
    assert.equal(counterSeq(), before, 'and no allocation');
    // Give a cleanup the same window it would have had, then assert none was ever issued.
    await waitFor(() => deleted.length > 0, 100);
    assert.equal(deleted.length, 0, 'nothing to clean up');
  });

  it('refuses to list a staged row when the series is unseeded, rather than burning the Custom label', async () => {
    db.exec("DELETE FROM sku_counter");
    const out = await runPublish(ENV, db, CFG, () => {}, { itemId, dryRun: false });
    assert.equal(out.ok, false);
    assert.match(out.error, /not seeded/);
    assert.equal(published.size, 0, 'refused before eBay — a listing under STG-* is unfixable');
  });
});
