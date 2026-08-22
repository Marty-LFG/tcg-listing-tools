// test/integration/pregrade.integration.test.mjs — the /api/pregrade persistence routes, mounted
// self-contained on a bare node http server against a TEMP tracker DB.
//
// Deliberately NOT bootServer(): vite.config.js does not register pregradePlugin yet (the
// orchestrator wires that), so the real dev server has no /api/pregrade to hit. The router is
// mounted here exactly the way connect mounts it (prefix stripped before dispatch), and the REAL
// inventory router rides along on the same DB so the grading_submissions.pregrade_id link is
// proven through the actual submissions POST — not a hand-rolled INSERT.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpDir } from '../helpers/tmp.mjs';

// lib/db.mjs reads TCG_TRACKER_DB at module scope, so the override must land before the dynamic
// imports below — the same ordering trick boot-server.mjs documents.
const dataDir = tmpDir('tcg-pregrade-');
process.env.TCG_TRACKER_DB = path.join(dataDir, 'tracker.db');

const { makePregradeRouter } = await import('../../lib/pregrade.mjs');
const { storePath } = await import('../../lib/pregrade-store.mjs');
const { inventoryPlugin } = await import('../../lib/inventory.mjs');
const { openDb } = await import('../../lib/db.mjs');

let server, base, db;
const writtenShas = [];   // [sha, ext] pairs — the store dir is the real one, so clean up after

before(async () => {
  db = openDb();
  const routes = { '/api/pregrade': makePregradeRouter({ env: {}, db }) };
  // The inventory plugin only opens the (already-redirected) DB and mounts its router — no
  // timers, no network — so a fake connect surface is all configureServer needs.
  inventoryPlugin({}).configureServer({
    middlewares: { use: (prefix, h) => { routes[prefix] = h; } },
    config: { server: { port: 0 } },
  });
  server = http.createServer((req, res) => {
    const hit = Object.keys(routes).find((k) => req.url === k || req.url.startsWith(k + '/') || req.url.startsWith(k + '?'));
    if (!hit) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); return res.end('{}'); }
    req.url = req.url.slice(hit.length) || '/';   // connect strips the mount prefix; so do we
    return routes[hit](req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const [sha, ext] of writtenShas) { try { fs.unlinkSync(storePath(sha, ext)); } catch { /* already gone */ } }
});

const req = (method) => async (p, body) => {
  const r = await fetch(base + p, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* bytes/plain */ }
  return { status: r.status, json, text, headers: r.headers };
};
const get = req('GET'), post = req('POST'), patch = req('PATCH'), del = req('DELETE');

// A representative grader payload — the JSON blobs use the page's own shapes (predictAll
// perCompany / gradeEconomics per company) so the list's best_* derivation is tested for real.
const payload = {
  game: 'pokemon', identity_key: 'sv4-25', name: 'Iron Valiant ex', set_name: 'Paradox Rift',
  number: '025', rarity: 'Double Rare', finish: 'Holo', language: 'EN',
  centering: { front: { lr: '55/45', tb: '52/48', worst: 55 } },
  pillars: { corners: { front: 9 }, edges: { front: 9 }, surface: { front: 8.5 } },
  granular: null,
  defects: [{ pillar: 'surface', side: 'front', severity: 'minor' }],
  ai_meta: { provider: 'anthropic', confidence: 0.7 },
  predictions: { perCompany: { PSA: { grade: 9, gradeLabel: 'Mint 9' }, TAG: { grade: 8.5, gradeLabel: 'NM-Mint+ 8.5' } } },
  economics: { PSA: { ok: true, profitVsRaw: 12.5 }, TAG: { ok: true, profitVsRaw: 3.1 } },
  config_as_of: '2026-06',
};

let reportId;

describe('report CRUD', () => {
  it('POST / creates and hands back an id', async () => {
    const r = await post('/api/pregrade/', payload);
    assert.equal(r.status, 201, r.text);
    assert.equal(typeof r.json.id, 'number');
    reportId = r.json.id;
  });
  it('POST / without a name is a 400, not a bare row', async () => {
    const r = await post('/api/pregrade/', { game: 'pokemon' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /name/);
  });
  it('GET /:id returns the report with its JSON columns PARSED, and no images yet', async () => {
    const r = await get('/api/pregrade/' + reportId);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.report.name, 'Iron Valiant ex');
    assert.equal(r.json.report.status, 'saved');                       // column default applied
    assert.deepEqual(r.json.report.predictions, payload.predictions);  // object out, not a string
    assert.deepEqual(r.json.report.defects, payload.defects);
    assert.equal(r.json.report.config_as_of, '2026-06');
    assert.deepEqual(r.json.images, []);
  });
  it('GET / lists it with total + derived best_* (a PREDICTION, never a slab grade)', async () => {
    const r = await get('/api/pregrade/?limit=10&offset=0');
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.json.total, 'number');
    const row = r.json.reports.find((x) => x.id === reportId);
    assert.ok(row, 'created report missing from the list');
    assert.equal(row.best_company, 'PSA');       // highest profitVsRaw in economics
    assert.equal(row.best_grade, 9);
    assert.equal(row.submission_id, null);
    assert.equal(row.actual_grade, null);
    assert.equal(row.thumb_url, null);           // no shots posted yet
    for (const k of ['name', 'set_name', 'number', 'finish', 'created_at', 'status']) assert.ok(k in row, `list row missing ${k}`);
  });
  it('GET /?q= filters by name/set/number and total follows the filter', async () => {
    const hitByName = await get('/api/pregrade/?q=' + encodeURIComponent('iron valiant'));
    assert.ok(hitByName.json.reports.some((x) => x.id === reportId), 'not found by name');
    const hitByNumber = await get('/api/pregrade/?q=025');
    assert.ok(hitByNumber.json.reports.some((x) => x.id === reportId), 'not found by number');
    const miss = await get('/api/pregrade/?q=zzz-no-such-card');
    assert.equal(miss.json.total, 0);
    assert.deepEqual(miss.json.reports, []);
  });
  it('PATCH /:id partial-updates and re-parses on read; a missing id is a 404', async () => {
    const r = await patch('/api/pregrade/' + reportId, { status: 'submitted', rarity: 'DR' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.updated, true);
    const got = (await get('/api/pregrade/' + reportId)).json.report;
    assert.equal(got.status, 'submitted');
    assert.equal(got.rarity, 'DR');
    assert.deepEqual(got.predictions, payload.predictions, 'untouched columns survive a partial PATCH');
    assert.equal((await patch('/api/pregrade/999999', { status: 'x' })).status, 404);
  });
});

const shot1 = crypto.randomBytes(4096);   // content is opaque to the server — no image decode
const shot2 = crypto.randomBytes(4096);
let sha1, sha2;

describe('images: post, serve, upsert', () => {
  it('POST /:id/images stores content-addressed bytes and returns the file URL', async () => {
    const r = await post(`/api/pregrade/${reportId}/images`, {
      shotId: 'scan-front', dataB64: shot1.toString('base64'), mediaType: 'image/png', w: 1200, h: 1680, dpi: 600, kind: 'scan',
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    sha1 = crypto.createHash('sha256').update(shot1).digest('hex');
    assert.equal(r.json.sha256, sha1, 'server hash matches the posted bytes');
    assert.equal(r.json.ext, 'png');
    assert.equal(r.json.url, `/api/pregrade/file/${sha1}.png`);
    writtenShas.push([sha1, 'png']);
  });
  it('a missing report is a 404, and bytes are NOT stored for it', async () => {
    const r = await post('/api/pregrade/999999/images', { shotId: 'scan-front', dataB64: shot2.toString('base64'), mediaType: 'image/png' });
    assert.equal(r.status, 404);
  });
  it('GET the URL serves the bytes back byte-identical, immutable, correct type', async () => {
    const r = await fetch(base + `/api/pregrade/file/${sha1}.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.match(r.headers.get('cache-control') || '', /immutable/);
    assert.equal(r.headers.get('content-disposition'), null);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.ok(Buffer.compare(bytes, shot1) === 0, 'served bytes differ from the posted shot');
  });
  it('a trailing name segment sets Content-Disposition; a bogus one is dropped, never echoed', async () => {
    const named = await fetch(base + `/api/pregrade/file/${sha1}.png/scan-front.png`);
    assert.equal(named.status, 200);
    assert.equal(named.headers.get('content-disposition'), 'inline; filename="scan-front.png"');
    const evil = await fetch(base + `/api/pregrade/file/${sha1}.png/` + encodeURIComponent('a"; x\r\nX-Evil: 1'));
    assert.equal(evil.status, 200, 'a bad name must not stop the bytes serving');
    assert.equal(evil.headers.get('content-disposition'), null);
    assert.equal(evil.headers.get('x-evil'), null);
  });
  it('an off-pattern file path never serves store bytes', async () => {
    for (const p of ['/api/pregrade/file/..%2f..%2f.env', `/api/pregrade/file/${'A'.repeat(64)}.png`, `/api/pregrade/file/${sha1}.mjs`]) {
      const r = await fetch(base + p);
      assert.ok(!/^image\//.test(r.headers.get('content-type') || ''), `${p} served image bytes`);
      await r.arrayBuffer();
    }
  });
  it('re-posting the same shot_id REPLACES the row (upsert), not accretes', async () => {
    const r = await post(`/api/pregrade/${reportId}/images`, {
      shotId: 'scan-front', dataB64: shot2.toString('base64'), mediaType: 'image/jpeg', w: 900, h: 1260, kind: 'scan',
    });
    assert.equal(r.status, 200, r.text);
    sha2 = crypto.createHash('sha256').update(shot2).digest('hex');
    assert.equal(r.json.sha256, sha2);
    assert.equal(r.json.ext, 'jpg');
    writtenShas.push([sha2, 'jpg']);
    const { images } = (await get('/api/pregrade/' + reportId)).json;
    assert.equal(images.length, 1, 'upsert must not add a second row for the slot');
    assert.equal(images[0].shot_id, 'scan-front');
    assert.equal(images[0].url, `/api/pregrade/file/${sha2}.jpg`);
    assert.equal(images[0].w, 900);
    assert.equal(images[0].dpi, null);
  });
  it('the list thumbnail follows the front scan', async () => {
    const row = (await get('/api/pregrade/')).json.reports.find((x) => x.id === reportId);
    assert.equal(row.thumb_url, `/api/pregrade/file/${sha2}.jpg`);
  });
});

describe('the submissions link (grading_submissions.pregrade_id)', () => {
  let subId, linkedReportId;
  it('the REAL inventory submissions POST accepts pregrade_id (SUB_COLS + migration column)', async () => {
    linkedReportId = (await post('/api/pregrade/', { ...payload, name: 'Linked Card' })).json.id;
    const r = await post('/api/inventory/submissions', {
      game: 'pokemon', name: 'Linked Card', grading_company: 'PSA', pregrade_id: linkedReportId,
    });
    assert.equal(r.status, 201, r.text);
    subId = r.json.id;
    assert.equal(db.prepare('SELECT pregrade_id FROM grading_submissions WHERE id = ?').get(subId).pregrade_id, linkedReportId);
  });
  it('once the slab returns, the list shows prediction AND actual side by side — never merged', async () => {
    const up = await patch('/api/inventory/submissions/' + subId, { result_grade: 8, status: 'graded' });
    assert.equal(up.status, 200, up.text);
    const row = (await get('/api/pregrade/')).json.reports.find((x) => x.id === linkedReportId);
    assert.equal(row.submission_id, subId);
    assert.equal(row.actual_grade, 8);
    assert.equal(row.best_grade, 9, 'the predicted grade stays the prediction (Golden Rule 4)');
  });
  it('deleting the report clears the link but never the submission (ON DELETE SET NULL)', async () => {
    const r = await del('/api/pregrade/' + linkedReportId);
    assert.equal(r.status, 200, r.text);
    const sub = db.prepare('SELECT id, pregrade_id, result_grade FROM grading_submissions WHERE id = ?').get(subId);
    assert.ok(sub, 'submission must survive the report delete');
    assert.equal(sub.pregrade_id, null);
    assert.equal(sub.result_grade, 8, 'the slab result is untouched');
  });
});

describe('DELETE reference-counts shared bytes', () => {
  let a, b;
  const shared = crypto.randomBytes(2048);
  const sharedSha = crypto.createHash('sha256').update(shared).digest('hex');
  it('two reports can share one content-addressed file', async () => {
    a = (await post('/api/pregrade/', { name: 'Share A' })).json.id;
    b = (await post('/api/pregrade/', { name: 'Share B' })).json.id;
    for (const id of [a, b]) {
      const r = await post(`/api/pregrade/${id}/images`, { shotId: 'scan-front', dataB64: shared.toString('base64'), mediaType: 'image/png' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.sha256, sharedSha);
    }
    writtenShas.push([sharedSha, 'png']);
  });
  it('deleting one report keeps the bytes the other still references', async () => {
    const r = await del('/api/pregrade/' + a);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.deleted, true);
    assert.equal((await get('/api/pregrade/' + a)).status, 404, 'report row gone');
    assert.equal((await fetch(base + `/api/pregrade/file/${sharedSha}.png`)).status, 200, 'shared bytes must survive');
  });
  it('deleting the LAST referencing report removes the bytes from disk', async () => {
    const r = await del('/api/pregrade/' + b);
    assert.equal(r.status, 200, r.text);
    assert.equal(fs.existsSync(storePath(sharedSha, 'png')), false, 'orphaned bytes must be unlinked');
    assert.equal((await fetch(base + `/api/pregrade/file/${sharedSha}.png`)).status, 404);
  });
  it('a delete of a missing report is a 404, not a throw', async () => {
    assert.equal((await del('/api/pregrade/999999')).status, 404);
  });
});
