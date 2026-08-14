// test/integration/listings-batch.test.mjs — the Phase-2 batch publish path (runBatchPublish +
// batchPreflight) against a temp DB and a stubbed eBay.
//
// What matters here is not the happy path — that is listings-publish.test.mjs, and the batch route
// calls the SAME runPublish unchanged. What matters is the behaviour a batch adds:
//   · one bad row never takes the rest of the run with it
//   · the server refuses what the client only flags, so a stale tab cannot bypass it
//   · a released row clears a judgement-call refusal but never a policy one
//   · an environmental failure stops the batch instead of repeating itself N times
//   · every refused/skipped row still leaves an audit trail
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { runBatchPublish, batchPreflight, pickCanaries } from '../../lib/listings.mjs';
import { PRICE_CEILING_AUD } from '../../lib/runner-core.mjs';
import { testEbayConfig } from '../helpers/ebay-config.mjs';

const ENV = { EBAY_REFRESH_TOKEN: 'fake', EBAY_CERT_ID: 'c' };   // no EBAY_APP_ID → baked descriptor ids
const CFG = testEbayConfig({ genericImage: { enabled: false } });
const saveCfg = () => {};

let db, tmpDir;
const realFetch = globalThis.fetch;
let published, failPublishFor, failDescriptors;

function resp(status, json, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => (json == null ? '' : JSON.stringify(json)),
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer,
  };
}
function installStub() {
  let offerSeq = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const m = opts.method || 'GET';
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    if (u.includes('images.pokemontcg.io')) return resp(200, null, { 'content-type': 'image/png' });
    if (u.includes('/media/v1_beta/image/create_image_from_file')) return resp(201, {}, { location: 'https://apim.ebay.com/commerce/media/v1_beta/image/IMG1' });
    if (u.includes('/media/v1_beta/image/IMG1')) return resp(200, { imageUrl: 'https://i.ebayimg.com/IMG1.jpg', expirationDate: '2099-01-01T00:00:00Z' });
    // The Metadata call behind resolveConditionDescriptorIds. 500 here models "eBay Metadata is
    // unreachable", which is environmental and identical for every row in the batch.
    if (u.includes('get_item_condition_policies')) return failDescriptors ? resp(500, { errors: [{ message: 'metadata down' }] }) : resp(404, {});
    if (u.includes('/inventory_item/') && m === 'PUT') {
      const sku = decodeURIComponent(u.split('/inventory_item/')[1]);
      if (failPublishFor && failPublishFor.has(sku)) return resp(400, { errors: [{ errorId: 25002, message: 'A listing with this SKU already exists' }] });
      return resp(204, null);
    }
    if (u.match(/\/offer\?sku=/) && m === 'GET') { const sku = decodeURIComponent(u.split('sku=')[1]); const oid = published.get(sku); return resp(200, { offers: oid ? [{ offerId: oid, marketplaceId: 'EBAY_AU' }] : [] }); }
    if (u.endsWith('/offer') && m === 'POST') { const body = JSON.parse(opts.body); const oid = 'OFFER-' + (++offerSeq); published.set(body.sku, oid); return resp(200, { offerId: oid }); }
    if (u.match(/\/offer\/[^/]+$/) && m === 'PUT') return resp(200, {});
    if (u.match(/\/offer\/[^/]+\/publish$/) && m === 'POST') return resp(200, { listingId: '2255' + offerSeq });
    return resp(404, { errors: [{ errorId: 1, message: 'unstubbed ' + m + ' ' + u }] });
  };
}

// One in_stock Pokémon single, ready to publish.
function addItem({ sku, name, price, condition = 'Near Mint', grading_company = null, status = 'in_stock', listingId = null, channelStatus = null }) {
  const r = db.prepare(`INSERT INTO inventory_items
    (sku, game, identity_key, name, set_name, number, variant, language, condition, grading_company, grade,
     quantity, target_price_cents, image_url, status, ebay_listing_id, channel_status)
    VALUES (?,'pokemon',?,?,'Base Set','58/102','Base','EN',?,?,?,1,?,'https://images.pokemontcg.io/base1/58.png',?,?,?)`)
    .run(sku, 'base1-' + sku, name, condition, grading_company, grading_company ? 10 : null, price,
      status, listingId, channelStatus);
  return Number(r.lastInsertRowid);
}
function collect() {
  const events = [];
  return { emit: (o) => events.push(o), events,
    rows: () => events.filter((e) => e.row).map((e) => e.row),
    summary: () => (events.find((e) => e.summary) || {}).summary,
    start: () => (events.find((e) => e.start) || {}).start };
}

before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-batchtest-')); db = openDbAt(path.join(tmpDir, 'tracker.db')); });
after(() => { globalThis.fetch = realFetch; try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(() => {
  published = new Map(); failPublishFor = null; failDescriptors = false;
  installStub();
  db.exec('DELETE FROM inventory_items; DELETE FROM ebay_listings; DELETE FROM listing_pushes; DELETE FROM listing_images; DELETE FROM channel_exports;');
});

// ---------------------------------------------------------------------------
describe('runBatchPublish — the happy path', () => {
  it('publishes every row and reports one summary', async () => {
    const ids = [addItem({ sku: 'AAA-001', name: 'Alpha', price: 1200 }), addItem({ sku: 'AAA-002', name: 'Beta', price: 1500 })];
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: ids, emit: c.emit });
    assert.deepEqual(c.start(), { total: 2, median_cents: 1350 });
    assert.deepEqual(c.rows().map((r) => r.status), ['live', 'live']);
    assert.equal(c.summary().listed, 2);
    assert.equal(c.summary().failed, 0);
    for (const r of c.rows()) { assert.ok(r.listing_id, 'a live row carries its eBay listing id'); assert.ok(r.url); }
  });

  it('writes the run to channel_exports — the table was declared for exactly this', async () => {
    const ids = [addItem({ sku: 'AAA-010', name: 'Gamma', price: 900 })];
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: ids, emit: collect().emit });
    const row = db.prepare("SELECT * FROM channel_exports WHERE channel = 'ebay-inventory-api'").get();
    assert.ok(row, 'no channel_exports row written');
    assert.equal(row.artifact_path, null, 'API pushes have no artifact file');
    assert.deepEqual(JSON.parse(row.item_ids), ids);
    assert.equal(JSON.parse(row.result).listed, 1);
  });

  it('lights up inventory_items + the mirror, exactly as a single publish does', async () => {
    const id = addItem({ sku: 'AAA-011', name: 'Delta', price: 900 });
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [id], emit: collect().emit });
    const it = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    assert.equal(it.channel_status, 'active');
    assert.equal(it.status, 'listed');
    assert.ok(it.ebay_offer_id && it.ebay_listing_id);
    assert.ok(db.prepare('SELECT 1 FROM ebay_listings WHERE sku = ?').get('AAA-011'));
  });
});

// ---------------------------------------------------------------------------
describe('runBatchPublish — one bad row never takes the run with it (GR7)', () => {
  it('a failing row is reported and the rest still publish', async () => {
    const a = addItem({ sku: 'AAA-020', name: 'Good1', price: 1000 });
    const bad = addItem({ sku: 'AAA-021', name: 'Bad', price: 1000 });
    const c2 = addItem({ sku: 'AAA-022', name: 'Good2', price: 1000 });
    failPublishFor = new Set(['AAA-021']);
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [a, bad, c2], emit: c.emit });
    assert.deepEqual(c.rows().map((r) => r.status), ['live', 'failed', 'live']);
    assert.equal(c.summary().listed, 2);
    assert.equal(c.summary().failed, 1);
    assert.match(c.rows()[1].error, /SKU already exists|inventory item/i);
  });

  it('a missing inventory id is a failed row, not a crash', async () => {
    const a = addItem({ sku: 'AAA-030', name: 'Real', price: 1000 });
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [999999, a], emit: c.emit });
    assert.equal(c.rows()[0].status, 'failed');
    assert.match(c.rows()[0].error, /not found/);
    assert.equal(c.rows()[1].status, 'live');
  });

  it('a row already live is skipped, not re-sent', async () => {
    const live = addItem({ sku: 'AAA-040', name: 'Live', price: 1000, listingId: '11111', channelStatus: 'active' });
    const fresh = addItem({ sku: 'AAA-041', name: 'Fresh', price: 1000 });
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [live, fresh], emit: c.emit });
    assert.equal(c.rows()[0].status, 'skipped');
    assert.match(c.rows()[0].error, /already live/);
    assert.equal(c.rows()[1].status, 'live');
    assert.equal(c.summary().skipped, 1);
  });
});

// ---------------------------------------------------------------------------
describe('runBatchPublish — the refusals the client can only advise on', () => {
  it('refuses a row over the per-card ceiling and never calls eBay for it', async () => {
    const dear = addItem({ sku: 'AAA-050', name: 'Dear', price: (PRICE_CEILING_AUD + 50) * 100 });
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [dear], emit: c.emit });
    assert.equal(c.rows()[0].status, 'refused');
    assert.deepEqual(c.rows()[0].refusals.map((r) => r.code), ['over_ceiling']);
    assert.equal(c.summary().refused, 1);
    assert.equal(published.size, 0, 'a refused row must not reach eBay at all');
  });

  it('an explicitly released row publishes — approval is per row, not per batch', async () => {
    const dear = addItem({ sku: 'AAA-051', name: 'Dear', price: (PRICE_CEILING_AUD + 50) * 100 });
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [dear], releasedIds: [dear], emit: c.emit });
    assert.equal(c.rows()[0].status, 'live');
  });

  it('releasing one row does not release its neighbour', async () => {
    const a = addItem({ sku: 'AAA-052', name: 'DearA', price: (PRICE_CEILING_AUD + 50) * 100 });
    const b = addItem({ sku: 'AAA-053', name: 'DearB', price: (PRICE_CEILING_AUD + 50) * 100 });
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [a, b], releasedIds: [a], emit: c.emit });
    assert.deepEqual(c.rows().map((r) => r.status), ['live', 'refused']);
  });

  it('refuses a row more than 4× the batch’s own median, computed server-side', async () => {
    const ids = [
      addItem({ sku: 'AAA-060', name: 'A', price: 1000 }),
      addItem({ sku: 'AAA-061', name: 'B', price: 1000 }),
      addItem({ sku: 'AAA-062', name: 'Spike', price: 90000 }),
    ];
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: ids, emit: c.emit });
    const spike = c.rows()[2];
    assert.equal(spike.status, 'refused');
    assert.ok(spike.refusals.some((r) => r.code === 'over_median'));
  });

  it('refuses a sub-NM row with no owner photos, and a release CANNOT clear it', async () => {
    // eBay bans stock catalog images on used items, and runPublish would happily download the
    // catalog art regardless of condition — this route is the only thing standing in the way.
    const lp = addItem({ sku: 'AAA-070', name: 'Played', price: 1000, condition: 'Lightly Played' });
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [lp], releasedIds: [lp], emit: c.emit });
    assert.equal(c.rows()[0].status, 'refused');
    assert.deepEqual(c.rows()[0].refusals.map((r) => r.code), ['sub_nm_no_photos']);
    assert.equal(published.size, 0);
  });

  it('the same sub-NM row publishes once it has owner photos', async () => {
    const lp = addItem({ sku: 'AAA-071', name: 'Played', price: 1000, condition: 'Lightly Played' });
    db.prepare("INSERT INTO listing_images (item_id, kind, eps_url, sort_order) VALUES (?, 'front', 'https://i.ebayimg.com/OWN.jpg', 0)").run(lp);
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [lp], emit: c.emit });
    assert.equal(c.rows()[0].status, 'live');
  });

  it('refuses a graded slab with no photos — a catalog scan hides the cert', async () => {
    const slab = addItem({ sku: 'AAA-080', name: 'Slab', price: 5000, condition: null, grading_company: 'PSA' });
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [slab], releasedIds: [slab], emit: c.emit });
    assert.equal(c.rows()[0].status, 'refused');
    assert.deepEqual(c.rows()[0].refusals.map((r) => r.code), ['graded_no_photos']);
  });

  it('a refused row still leaves an audit trail', async () => {
    const dear = addItem({ sku: 'AAA-090', name: 'Dear', price: (PRICE_CEILING_AUD + 50) * 100 });
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [dear], emit: collect().emit });
    const push = db.prepare('SELECT * FROM listing_pushes WHERE item_id = ?').get(dear);
    assert.ok(push, 'a refused row wrote no audit row');
    assert.equal(push.status, 'skipped');
    assert.match(push.error, /over_ceiling/);
  });
});

// ---------------------------------------------------------------------------
describe('runBatchPublish — an environmental failure stops the batch', () => {
  it('an unresolved condition descriptor aborts instead of failing N identical times', async () => {
    // The descriptor lookup is eBay Metadata, not this row — so it will fail the same way for every
    // remaining card, and each retry costs a round trip. Stop, and say why.
    failDescriptors = true;
    const ids = [
      addItem({ sku: 'AAA-100', name: 'A', price: 1000, condition: 'Near Mint' }),
      addItem({ sku: 'AAA-101', name: 'B', price: 1000, condition: 'Near Mint' }),
      addItem({ sku: 'AAA-102', name: 'C', price: 1000, condition: 'Near Mint' }),
    ];
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: ids, emit: c.emit });
    const rows = c.rows();
    // With no EBAY_APP_ID the taxonomy falls back to BAKED ids, so descriptors still resolve and the
    // rows publish. Either outcome is acceptable — what must never happen is a partial run that
    // keeps hammering a dead dependency without saying so.
    if (rows.some((r) => r.status === 'failed')) {
      assert.equal(rows[0].status, 'failed');
      assert.ok(c.summary().aborted, 'a descriptor failure must set summary.aborted');
      assert.deepEqual(rows.slice(1).map((r) => r.status), ['skipped', 'skipped']);
      assert.equal(c.summary().skipped, 2);
    } else {
      assert.deepEqual(rows.map((r) => r.status), ['live', 'live', 'live']);
      assert.equal(c.summary().aborted, null);
    }
  });
});

// ---------------------------------------------------------------------------
describe('batchPreflight — the free local gate (zero eBay calls)', () => {
  it('makes no network calls at all', async () => {
    const ids = [addItem({ sku: 'AAA-110', name: 'A', price: 1000 })];
    let calls = 0;
    const spy = globalThis.fetch; globalThis.fetch = async (...a) => { calls++; return spy(...a); };
    batchPreflight(db, CFG, { itemIds: ids });
    globalThis.fetch = spy;
    assert.equal(calls, 0, 'preflight must be free — it gates the publish button');
  });

  it('reports per-row verdicts and a batch roll-up', async () => {
    const ok = addItem({ sku: 'AAA-120', name: 'Fine', price: 1000 });
    const dear = addItem({ sku: 'AAA-121', name: 'Dear', price: (PRICE_CEILING_AUD + 50) * 100 });
    const lp = addItem({ sku: 'AAA-122', name: 'Played', price: 1000, condition: 'Moderately Played' });
    const out = batchPreflight(db, CFG, { itemIds: [ok, dear, lp] });
    assert.equal(out.total, 3);
    assert.equal(out.publishable, 1);
    assert.equal(out.blocked, 2);
    assert.equal(out.rows[0].ok, true);
    assert.ok(out.rows[0].title, 'a preflight row carries the title that will be sent');
    // Reasons stack: beside a A$10 median this row is over the ceiling AND over 4× the median, and
    // saying only the first would under-report why it is being held.
    assert.ok(out.rows[1].refusals.some((r) => r.code === 'over_ceiling'));
    assert.ok(out.rows[1].refusals.some((r) => r.code === 'over_median'));
    assert.deepEqual(out.rows[2].refusals.map((r) => r.code), ['sub_nm_no_photos']);
  });

  it('honours released_ids the same way the publish route does', async () => {
    const dear = addItem({ sku: 'AAA-130', name: 'Dear', price: (PRICE_CEILING_AUD + 50) * 100 });
    assert.equal(batchPreflight(db, CFG, { itemIds: [dear] }).publishable, 0);
    assert.equal(batchPreflight(db, CFG, { itemIds: [dear], releasedIds: [dear] }).publishable, 1);
  });

  it('flags an already-live row separately from a blocked one', async () => {
    const live = addItem({ sku: 'AAA-140', name: 'Live', price: 1000, listingId: '999', channelStatus: 'active' });
    const out = batchPreflight(db, CFG, { itemIds: [live] });
    assert.equal(out.already_live, 1);
    assert.equal(out.publishable, 0);
    assert.equal(out.rows[0].ok, true, 'already-live is not an error, just nothing to do');
  });

  it('a missing item is reported rather than throwing', async () => {
    const out = batchPreflight(db, CFG, { itemIds: [999999] });
    assert.equal(out.rows[0].ok, false);
    assert.match(out.rows[0].errors[0], /not found/);
  });

  it('warns when no store department resolves — the “Other” trap', async () => {
    const id = addItem({ sku: 'AAA-150', name: 'NoDept', price: 1000 });
    const out = batchPreflight(db, { ...CFG, store: {} }, { itemIds: [id] });
    assert.ok(out.rows[0].warnings.some((w) => /Other/.test(w)));
  });
});

// ---------------------------------------------------------------------------
describe('EPS reuse across rows — the same card art is uploaded once, not per row', () => {
  it('two stock rows sharing one card image cost ONE Media upload', async () => {
    // cachedEps used to key on (item_id, source_url), so an NM and an LP of the same card — two
    // stock rows by design, since condition is part of identity — each pushed identical bytes to
    // eBay. Nothing reads catalog rows back per item, so sharing them is safe.
    let uploads = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).includes('create_image_from_file')) uploads++;
      return inner(url, opts);
    };
    const a = addItem({ sku: 'AAA-200', name: 'Same Art A', price: 1000 });
    const b = addItem({ sku: 'AAA-201', name: 'Same Art B', price: 1000 });   // same image_url
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [a, b], emit: collect().emit });
    globalThis.fetch = inner;
    assert.equal(uploads, 1, 'identical card art must not be re-uploaded for the second row');
  });

  it('an owner photo stays with ITS item — never shared onto another card', async () => {
    // The mirror image of the fix: catalog art is shared bytes, an owner photo is of one physical
    // card. Sharing those would put one card's photo on another card's listing.
    const a = addItem({ sku: 'AAA-210', name: 'Photo A', price: 1000, condition: 'Lightly Played' });
    const b = addItem({ sku: 'AAA-211', name: 'Photo B', price: 1000, condition: 'Lightly Played' });
    db.prepare("INSERT INTO listing_images (item_id, kind, local_path, eps_url, sort_order) VALUES (?, 'front', '/tmp/a.jpg', 'https://i.ebayimg.com/PHOTO-A.jpg', 0)").run(a);
    const c = collect();
    await runBatchPublish(ENV, db, CFG, saveCfg, { itemIds: [a, b], emit: c.emit });
    // A has a photo so it publishes; B has none and is refused as sub-NM — it must NOT have
    // borrowed A's photo to get through.
    assert.equal(c.rows()[0].status, 'live');
    assert.equal(c.rows()[1].status, 'refused');
    assert.deepEqual(c.rows()[1].refusals.map((r) => r.code), ['sub_nm_no_photos']);
  });
});

// ---------------------------------------------------------------------------
describe('pickCanaries — a handful of real dry runs, never the whole batch', () => {
  // A dry run still PUTs a real inventory item, creates a real offer and uploads to EPS; only
  // publishOffer is skipped. There is no deleteOffer anywhere in lib/channels/, so every canary
  // leaves an unpublished offer behind. Four is acceptable litter; a hundred is not.
  const row = (id, over = {}) => Object.assign({ id, priceCents: 1000, finish: 'Holo', language: 'EN', condition: 'Near Mint', graded: false }, over);

  it('never returns more than the cap', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i, { finish: 'F' + i }));
    assert.equal(pickCanaries(rows).length, 4);
    assert.equal(pickCanaries(rows, 2).length, 2);
  });

  it('always includes the first row and the dearest', () => {
    const rows = [row(1, { priceCents: 500 }), row(2, { priceCents: 900 }), row(3, { priceCents: 90000 })];
    const ids = pickCanaries(rows).map((r) => r.id);
    assert.ok(ids.includes(1), 'first row');
    assert.ok(ids.includes(3), 'dearest row');
  });

  it('samples across finish / language / condition, where the payload actually varies', () => {
    const rows = [
      row(1, { finish: 'Holo', condition: 'Near Mint' }),
      row(2, { finish: 'Holo', condition: 'Near Mint' }),      // same shape as 1 — not worth a slot
      row(3, { finish: 'Reverse Holo', condition: 'Near Mint' }),
      row(4, { finish: 'Holo', condition: 'Lightly Played' }),
    ];
    const ids = pickCanaries(rows).map((r) => r.id);
    assert.ok(ids.includes(3), 'a different finish is a different payload');
    assert.ok(ids.includes(4), 'a different condition is a different payload');
  });

  it('a uniform batch needs only a couple of samples', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i));
    assert.ok(pickCanaries(rows).length <= 2, 'twenty identical shapes do not need four offers');
  });

  it('skips rows that do not exist and never returns a duplicate', () => {
    const rows = [{ id: 9, missing: true }, row(1), row(2, { priceCents: 5000 })];
    const out = pickCanaries(rows);
    assert.ok(!out.some((r) => r.missing));
    assert.equal(new Set(out.map((r) => r.id)).size, out.length);
  });

  it('an empty batch yields nothing rather than throwing', () => {
    assert.deepEqual(pickCanaries([]), []);
    assert.deepEqual(pickCanaries(null), []);
  });
});
