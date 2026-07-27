// test/integration/listings-batch-job.test.mjs — the Phase-4 detached batch job.
//
// Phase 2 proved the publishing loop; this file is about the thing detaching adds: a run that
// outlives the request that started it. What matters here —
//   · only ONE run at a time, or two sets of eBay writes interleave for no benefit
//   · a viewer can drop and re-attach without losing events (ring-buffer replay)
//   · cancel stops BETWEEN cards, never mid-publish (there is no un-send for publishOffer)
//   · resume is derived from the DB, so an interrupted run picks up by pressing Publish again
//   · listing_pushes does not grow without bound now that batches are the normal path
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbAt } from '../../lib/db.mjs';
import { startBatchJob, followBatchJob, cancelBatchJob, getBatchJobState, pendingBatchIds, pruneListingPushes } from '../../lib/listings.mjs';

const ENV = { EBAY_REFRESH_TOKEN: 'fake', EBAY_CERT_ID: 'c' };
const CFG = {
  marketplaceId: 'EBAY_AU', categoryTreeId: '15', listingDuration: 'GTC',
  location: { merchantLocationKey: 'tcg-au-1' },
  policies: { paymentPolicyId: 'PAY', returnPolicyId: 'RET', fulfillmentPolicyId: 'FUL' },
  bestOffer: { enabled: false }, genericImage: { enabled: false },
};
const saveCfg = () => {};

let db, tmpDir, published, slowMs;
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resp(status, json, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => (json == null ? '' : JSON.stringify(json)),
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]).buffer,
  };
}
function installStub() {
  let offerSeq = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const m = opts.method || 'GET';
    if (u.includes('/identity/v1/oauth2/token')) return resp(200, { access_token: 't', expires_in: 7200 });
    if (u.includes('images.pokemontcg.io')) return resp(200, null, { 'content-type': 'image/png' });
    if (u.includes('create_image_from_file')) return resp(201, {}, { location: 'https://apim.ebay.com/commerce/media/v1_beta/image/IMG1' });
    if (u.includes('/media/v1_beta/image/IMG1')) return resp(200, { imageUrl: 'https://i.ebayimg.com/IMG1.jpg', expirationDate: '2099-01-01T00:00:00Z' });
    if (u.includes('get_item_condition_policies')) return resp(404, {});
    if (u.includes('/inventory_item/') && m === 'PUT') { if (slowMs) await sleep(slowMs); return resp(204, null); }
    if (u.match(/\/offer\?sku=/) && m === 'GET') { const sku = decodeURIComponent(u.split('sku=')[1]); const oid = published.get(sku); return resp(200, { offers: oid ? [{ offerId: oid, marketplaceId: 'EBAY_AU' }] : [] }); }
    if (u.endsWith('/offer') && m === 'POST') { const body = JSON.parse(opts.body); const oid = 'OFFER-' + (++offerSeq); published.set(body.sku, oid); return resp(200, { offerId: oid }); }
    if (u.match(/\/offer\/[^/]+$/) && m === 'PUT') return resp(200, {});
    if (u.match(/\/offer\/[^/]+\/publish$/) && m === 'POST') return resp(200, { listingId: '77' + offerSeq });
    return resp(404, { errors: [{ errorId: 1, message: 'unstubbed ' + m + ' ' + u }] });
  };
}
function addItem({ sku, name, price = 1000, listingId = null, channelStatus = null }) {
  const r = db.prepare(`INSERT INTO inventory_items
    (sku, game, identity_key, name, set_name, number, variant, language, condition, quantity,
     target_price_cents, image_url, status, ebay_listing_id, channel_status)
    VALUES (?,'pokemon',?,?,'Base Set','58/102','Base','EN','Near Mint',1,?,'https://images.pokemontcg.io/base1/58.png','in_stock',?,?)`)
    .run(sku, 'base1-' + sku, name, price, listingId, channelStatus);
  return Number(r.lastInsertRowid);
}
// Drain a job to completion through the same follower the routes use.
async function drain(fromSeq = 0) {
  const events = [];
  await followBatchJob((e) => events.push(e), fromSeq, () => false);
  return events;
}
async function settle() { for (let i = 0; i < 200 && getBatchJobState().running; i++) await sleep(25); }

before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-jobtest-')); db = openDbAt(path.join(tmpDir, 'tracker.db')); });
after(async () => { await settle(); globalThis.fetch = realFetch; try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
beforeEach(async () => {
  await settle();                     // never start a test while the singleton is still busy
  published = new Map(); slowMs = 0;
  installStub();
  db.exec('DELETE FROM inventory_items; DELETE FROM ebay_listings; DELETE FROM listing_pushes; DELETE FROM listing_images; DELETE FROM channel_exports;');
});

// ---------------------------------------------------------------------------
describe('the job outlives the request that started it', () => {
  it('start returns immediately with an id, and the work carries on', async () => {
    const ids = [addItem({ sku: 'JOB-001', name: 'A' }), addItem({ sku: 'JOB-002', name: 'B' })];
    const started = startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    assert.equal(started.ok, true);
    assert.ok(started.id, 'a run must be addressable');
    assert.equal(getBatchJobState().running, true, 'it is running before anyone attaches');
    const events = await drain();
    assert.ok(events.some((e) => e.summary), 'the run finished on its own');
    await settle();
    assert.equal(getBatchJobState().listed, 2);
  });

  it('counters track the run without a viewer present', async () => {
    const ids = [addItem({ sku: 'JOB-010', name: 'A' })];
    startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    await settle();                     // deliberately never attach
    const st = getBatchJobState();
    assert.equal(st.running, false);
    assert.equal(st.listed, 1);
    assert.ok(st.started_at && st.finished_at);
  });
});

describe('one run at a time', () => {
  it('a second start is refused and hands back the running id to attach to', async () => {
    slowMs = 60;
    const ids = [addItem({ sku: 'JOB-020', name: 'A' }), addItem({ sku: 'JOB-021', name: 'B' })];
    const first = startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    const second = startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'job_running');
    assert.equal(second.id, first.id, 'the caller is told which run to attach to');
    await settle();
  });

  it('a new run is allowed once the previous one finished', async () => {
    const a = startBatchJob(ENV, db, CFG, saveCfg, { itemIds: [addItem({ sku: 'JOB-030', name: 'A' })] });
    await settle();
    const b = startBatchJob(ENV, db, CFG, saveCfg, { itemIds: [addItem({ sku: 'JOB-031', name: 'B' })] });
    assert.equal(b.ok, true);
    assert.notEqual(b.id, a.id);
    await settle();
  });
});

describe('attach and replay', () => {
  it('a late viewer still sees every event from the start', async () => {
    const ids = [addItem({ sku: 'JOB-040', name: 'A' }), addItem({ sku: 'JOB-041', name: 'B' })];
    startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    await settle();                                  // attach only AFTER it has finished
    const events = await drain(0);
    assert.ok(events.some((e) => e.start), 'the ring buffer replays the start record');
    assert.equal(events.filter((e) => e.row).length, 2);
    assert.ok(events.some((e) => e.summary));
  });

  it('?from=<seq> replays only what the viewer has not seen', async () => {
    const ids = [addItem({ sku: 'JOB-050', name: 'A' }), addItem({ sku: 'JOB-051', name: 'B' })];
    startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    await settle();
    const all = await drain(0);
    const mid = all[1].seq;
    const rest = await drain(mid);
    assert.ok(rest.length < all.length);
    assert.ok(rest.every((e) => e.seq > mid), 'nothing already seen is re-sent');
    assert.deepEqual(rest.map((e) => e.seq), all.filter((e) => e.seq > mid).map((e) => e.seq), 'and nothing is missed either');
  });

  it('every event carries a monotonic seq, which is what makes replay exact', async () => {
    startBatchJob(ENV, db, CFG, saveCfg, { itemIds: [addItem({ sku: 'JOB-060', name: 'A' })] });
    const events = await drain();
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
  });

  it('two viewers can watch the same run', async () => {
    slowMs = 40;
    const ids = [addItem({ sku: 'JOB-070', name: 'A' }), addItem({ sku: 'JOB-071', name: 'B' })];
    startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    const [one, two] = await Promise.all([drain(0), drain(0)]);
    assert.deepEqual(one.map((e) => e.seq), two.map((e) => e.seq));
  });

  it('a viewer that goes away does not stop the run', async () => {
    slowMs = 40;
    const ids = [addItem({ sku: 'JOB-080', name: 'A' }), addItem({ sku: 'JOB-081', name: 'B' }), addItem({ sku: 'JOB-082', name: 'C' })];
    startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    let closed = false;
    const seen = [];
    const view = followBatchJob((e) => seen.push(e), 0, () => closed);
    setTimeout(() => { closed = true; }, 50);        // the "tab" closes mid-run
    await view;
    await settle();
    assert.equal(getBatchJobState().listed, 3, 'all three published even though nobody was watching');
  });
});

describe('cancel stops between cards, never mid-publish', () => {
  it('cancelling part-way leaves the finished cards listed and the rest skipped', async () => {
    slowMs = 60;
    const ids = [1, 2, 3, 4, 5].map((n) => addItem({ sku: 'JOB-09' + n, name: 'C' + n }));
    const started = startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    await sleep(120);
    const c = cancelBatchJob(started.id);
    assert.equal(c.ok, true);
    assert.match(c.message, /after the current card/i);
    await settle();
    const st = getBatchJobState();
    assert.equal(st.cancelled, true);
    assert.ok(st.listed >= 1, 'whatever was already sent stayed sent');
    assert.ok(st.listed < 5, 'and the rest did not go out');
    assert.equal(st.listed + st.skipped + st.failed + st.refused, 5, 'every row is accounted for');
  });

  it('a listing that was already published is never un-published by a cancel', async () => {
    slowMs = 60;
    const ids = [1, 2, 3].map((n) => addItem({ sku: 'JOB-10' + n, name: 'D' + n }));
    const started = startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    await sleep(130);
    cancelBatchJob(started.id);
    await settle();
    const live = db.prepare("SELECT COUNT(*) n FROM inventory_items WHERE channel_status = 'active'").get().n;
    assert.equal(live, getBatchJobState().listed, 'the DB and the counters agree about what went live');
    assert.ok(live >= 1);
  });

  it('cancelling nothing, or the wrong id, is a clean refusal', async () => {
    assert.equal(cancelBatchJob('nope').ok, false);
    assert.equal(cancelBatchJob('nope').code, 'not_running');
  });
});

describe('resume is derived from the DB, never stored', () => {
  it('rows already live are dropped from a re-run', async () => {
    const live = addItem({ sku: 'JOB-110', name: 'Live', listingId: '999', channelStatus: 'active' });
    const fresh = addItem({ sku: 'JOB-111', name: 'Fresh' });
    assert.deepEqual(pendingBatchIds(db, [live, fresh]), [fresh]);
  });

  it('a row that failed last time is still pending', async () => {
    const failed = addItem({ sku: 'JOB-120', name: 'Failed' });   // no listing id
    assert.deepEqual(pendingBatchIds(db, [failed]), [failed]);
  });

  it('an ENDED listing is pending again — which a stored cursor would have got wrong', async () => {
    // This is the case a saved pointer breaks on: the 30-minute reconcile job marks a listing ended
    // and the row genuinely needs publishing again.
    const ended = addItem({ sku: 'JOB-130', name: 'Ended', listingId: '111', channelStatus: 'ended' });
    assert.deepEqual(pendingBatchIds(db, [ended]), [ended]);
  });

  it('a deleted row simply disappears rather than failing the run', async () => {
    assert.deepEqual(pendingBatchIds(db, [999999]), []);
  });

  it('re-running a finished batch publishes nothing new', async () => {
    const ids = [addItem({ sku: 'JOB-140', name: 'A' }), addItem({ sku: 'JOB-141', name: 'B' })];
    startBatchJob(ENV, db, CFG, saveCfg, { itemIds: ids });
    await settle();
    assert.equal(getBatchJobState().listed, 2);
    assert.deepEqual(pendingBatchIds(db, ids), [], 'nothing left to do the second time round');
  });
});

describe('listing_pushes retention', () => {
  it('keeps recent audit rows and drops ancient ones', async () => {
    const id = addItem({ sku: 'JOB-150', name: 'Old' });
    db.prepare(`INSERT INTO listing_pushes (item_id, sku, action, status, ts) VALUES (?,?,'publish','ok', datetime('now','-200 days'))`).run(id, 'JOB-150');
    db.prepare(`INSERT INTO listing_pushes (item_id, sku, action, status, ts) VALUES (?,?,'publish','ok', datetime('now','-2 days'))`).run(id, 'JOB-150');
    const removed = pruneListingPushes(db, 90);
    assert.equal(removed, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM listing_pushes').get().n, 1, 'the recent one survives');
  });

  it('a run prunes as it finishes, so the table cannot grow without bound', async () => {
    const id = addItem({ sku: 'JOB-160', name: 'A' });
    db.prepare(`INSERT INTO listing_pushes (item_id, sku, action, status, ts) VALUES (?,?,'publish','ok', datetime('now','-400 days'))`).run(id, 'JOB-160');
    startBatchJob(ENV, db, CFG, saveCfg, { itemIds: [id] });
    await settle();
    const ancient = db.prepare(`SELECT COUNT(*) n FROM listing_pushes WHERE ts < datetime('now','-90 days')`).get().n;
    assert.equal(ancient, 0);
  });
});
