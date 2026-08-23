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

// ============================ THE FREEZE ============================
// The data-integrity half. A report whose card has been submitted is the only before-the-fact
// record of what we predicted; reopening it in the grader weeks later re-pulls today's comps and
// re-runs the AI, and the save that follows would quietly replace the prediction with one made
// WITH knowledge of the result. These tests are written against the REAL inventory submissions
// POST, so the lock is proven against the link the app actually creates.

// A saved report + a real grading submission pointing at it. Returns both ids.
async function linkAndSubmit({ name, company = 'PSA', predictions } = {}) {
  const reportId = (await post('/api/pregrade/', { ...payload, name, ...(predictions ? { predictions } : {}) })).json.id;
  const sub = await post('/api/inventory/submissions', { game: 'pokemon', name, grading_company: company, pregrade_id: reportId });
  assert.equal(sub.status, 201, sub.text);
  return { reportId, subId: sub.json.id };
}
describe('a linked report freezes its prediction', () => {
  let ids;
  before(async () => { ids = await linkAndSubmit({ name: 'Frozen Card' }); });

  it('an unlinked report is freely editable — the lock is the LINK, not the table', async () => {
    const loose = (await post('/api/pregrade/', { ...payload, name: 'Unlinked Card' })).json.id;
    const r = await patch('/api/pregrade/' + loose, { predictions: { perCompany: { PSA: { grade: 7 } } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.locked, false);
    assert.equal((await get('/api/pregrade/' + loose)).json.report.predictions.perCompany.PSA.grade, 7);
  });

  it('GET /:id announces the freeze BEFORE the client offers to save', async () => {
    const r = await get('/api/pregrade/' + ids.reportId);
    assert.equal(r.json.report.locked, true);
    assert.equal(r.json.lock.submission_id, ids.subId);
    assert.ok(r.json.lock.frozen.includes('predictions'), 'the client must be told WHICH columns');
    assert.ok(r.json.lock.locked_at, 'locked_at derives from the link even before anything stamps it');
  });

  it('PATCHing a frozen column is a 409 that names what it refused, and changes NOTHING', async () => {
    const before = (await get('/api/pregrade/' + ids.reportId)).json.report;
    const r = await patch('/api/pregrade/' + ids.reportId, {
      predictions: { perCompany: { PSA: { grade: 10 } } },
      economics: { PSA: { ok: true, profitVsRaw: 999 } },
    });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'locked');
    assert.deepEqual(r.json.refused.sort(), ['economics', 'predictions']);
    assert.equal(r.json.submission_id, ids.subId);
    assert.match(r.json.hint, /unlock/);
    const after = (await get('/api/pregrade/' + ids.reportId)).json.report;
    assert.deepEqual(after.predictions, before.predictions, 'the prediction on file must be untouched');
    assert.deepEqual(after.economics, before.economics);
  });

  it('every frozen column is actually refused, one at a time', async () => {
    for (const col of ['predictions', 'economics', 'centering', 'pillars', 'granular', 'ai_meta', 'config_as_of']) {
      const r = await patch('/api/pregrade/' + ids.reportId, { [col]: { rewritten: true } });
      assert.equal(r.status, 409, `${col} was NOT frozen`);
      assert.deepEqual(r.json.refused, [col]);
    }
  });

  it('notes / status / identity edits still go through, and stamp the lock date from the LINK', async () => {
    const r = await patch('/api/pregrade/' + ids.reportId, { status: 'sent', name: 'Frozen Card (fixed spelling)' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.updated, true);
    assert.equal(r.json.locked, true);
    const sub = db.prepare('SELECT created_at FROM grading_submissions WHERE id = ?').get(ids.subId);
    assert.equal(r.json.locked_at, sub.created_at, 'the freeze began when the card was sent, not when we noticed');
    const got = (await get('/api/pregrade/' + ids.reportId)).json.report;
    assert.equal(got.status, 'sent');
    assert.equal(got.name, 'Frozen Card (fixed spelling)');
    assert.equal(got.locked_at, sub.created_at);
  });

  it('a mixed body is refused WHOLE — no half-applied save', async () => {
    const r = await patch('/api/pregrade/' + ids.reportId, { status: 'draft', predictions: { perCompany: { PSA: { grade: 2 } } } });
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(r.json.allowed, ['status'], 'it must say what it would otherwise have allowed');
    assert.equal((await get('/api/pregrade/' + ids.reportId)).json.report.status, 'sent', 'the allowed half must not sneak through');
  });

  it('only a literal true unlocks — no truthy strings, no 1, no "yes"', async () => {
    for (const v of ['true', 1, 'yes', {}]) {
      const r = await patch('/api/pregrade/' + ids.reportId, { unlock: v, predictions: { perCompany: { PSA: { grade: 3 } } } });
      assert.equal(r.status, 409, `unlock:${JSON.stringify(v)} must not open the hatch`);
    }
  });

  it('a link written straight into the DB locks the report just the same', async () => {
    // Belt and braces for the pre-migration case: a report linked before locked_at existed has a
    // NULL stamp, so the lock cannot depend on the column being filled in.
    const orphan = (await post('/api/pregrade/', { ...payload, name: 'Legacy Link' })).json.id;
    db.prepare(`INSERT INTO grading_submissions (game, name, grading_company, pregrade_id) VALUES ('pokemon','Legacy Link','PSA',?)`).run(orphan);
    assert.equal(db.prepare('SELECT locked_at FROM pregrade_reports WHERE id = ?').get(orphan).locked_at, null);
    const r = await patch('/api/pregrade/' + orphan, { centering: { front: {} } });
    assert.equal(r.status, 409, r.text);
  });
});

describe('the unlock hatch: deliberate, recorded, and one request wide', () => {
  let ids;
  before(async () => { ids = await linkAndSubmit({ name: 'Corrected Card' }); });

  it('{unlock:true} applies the correction and writes an audit entry', async () => {
    const r = await patch('/api/pregrade/' + ids.reportId, {
      unlock: true, unlock_reason: 'centering was measured against the sleeve',
      predictions: { perCompany: { PSA: { grade: 8 } } },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.unlocked, true);
    assert.deepEqual(r.json.unlocked_columns, ['predictions']);
    const rep = (await get('/api/pregrade/' + ids.reportId)).json.report;
    assert.equal(rep.predictions.perCompany.PSA.grade, 8, 'the owner must be able to fix a genuine mistake');
    assert.equal(rep.unlock_log.length, 1);
    assert.equal(rep.unlock_log[0].reason, 'centering was measured against the sleeve');
    assert.deepEqual(rep.unlock_log[0].columns, ['predictions']);
    assert.equal(rep.unlock_log[0].submission_id, ids.subId);
    assert.ok(rep.unlock_log[0].was_locked_at, 'the audit records the freeze it broke');
    assert.ok(rep.frozen_dirty_at, 'and the row confesses that a frozen column was rewritten');
  });

  it('the very next PATCH is refused again — an unlock is never a standing exemption', async () => {
    const r = await patch('/api/pregrade/' + ids.reportId, { predictions: { perCompany: { PSA: { grade: 5 } } } });
    assert.equal(r.status, 409, r.text);
    assert.equal((await get('/api/pregrade/' + ids.reportId)).json.report.predictions.perCompany.PSA.grade, 8);
  });

  it('a second unlock appends rather than overwrites the record', async () => {
    const r = await patch('/api/pregrade/' + ids.reportId, { unlock: true, pillars: { corners: { front: 8 } } });
    assert.equal(r.status, 200, r.text);
    const rep = (await get('/api/pregrade/' + ids.reportId)).json.report;
    assert.equal(rep.unlock_log.length, 2, 'the audit trail is append-only');
    assert.equal(rep.unlock_log[1].reason, null);
    assert.deepEqual(rep.unlock_log[1].columns, ['pillars']);
  });

  it('unlocking to fix an identity typo does NOT taint the prediction', async () => {
    const clean = await linkAndSubmit({ name: 'Typo Card' });
    const r = await patch('/api/pregrade/' + clean.reportId, { unlock: true, name: 'Typo Card (fixed)' });
    assert.equal(r.status, 200, r.text);
    assert.equal(db.prepare('SELECT frozen_dirty_at FROM pregrade_reports WHERE id = ?').get(clean.reportId).frozen_dirty_at, null);
  });

  it('the audit column is server-only: a client cannot PATCH its own unlock_log', async () => {
    const loose = (await post('/api/pregrade/', { ...payload, name: 'Audit Forgery' })).json.id;
    const r = await patch('/api/pregrade/' + loose, { unlock_log: [{ at: 'never happened' }] });
    assert.equal(r.status, 400, 'unlock_log is not a writable column, so that body updates nothing');
    assert.equal(db.prepare('SELECT unlock_log FROM pregrade_reports WHERE id = ?').get(loose).unlock_log, null);
  });
});

// ============================ CALIBRATION ============================
describe('GET /calibration', () => {
  it('answers ok:true with n:0 while every submission is still out at the grader', async () => {
    // This DB already holds reports AND links by now — what it has no trace of is a RESULT. A
    // submission with no result_grade must contribute nothing, not a zero.
    const r = await get('/api/pregrade/calibration');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.n, 0);
    assert.deepEqual(r.json.byCompany, {});
    assert.deepEqual(r.json.recent, []);
    assert.equal(r.json.confidence, 'none');
    assert.match(r.json.note, /nothing to calibrate against/);
  });

  let psa;
  it('n=1: the card shows up, and not one statistic does', async () => {
    psa = await linkAndSubmit({ name: 'First Result', company: 'PSA' });
    await patch('/api/inventory/submissions/' + psa.subId, { result_grade: 8, status: 'graded' });
    const c = (await get('/api/pregrade/calibration')).json;
    assert.equal(c.n, 1);
    assert.equal(c.confidence, 'none');
    assert.equal(c.byCompany.PSA.n, 1);
    assert.equal(c.byCompany.PSA.meanError, null);
    assert.equal(c.byCompany.PSA.medianError, null);
    assert.equal(c.byCompany.PSA.overPredicted, 1);      // predicted PSA 9, slab said 8
    assert.equal(c.recent[0].reportId, psa.reportId);
    assert.deepEqual(
      { p: c.recent[0].predicted, a: c.recent[0].actual, d: c.recent[0].delta },
      { p: 9, a: 8, d: 1 });
    assert.ok(c.recent[0].gradedAt, 'the dashboard needs a date per row');
  });

  it('mixed companies split apart, and a company is never measured against another’s prediction', async () => {
    const bgs = await linkAndSubmit({
      name: 'BGS Result', company: 'BGS',
      predictions: { perCompany: { PSA: { grade: 10 }, BGS: { grade: 9, subgrades: { centering: 9, corners: 9, edges: 9, surface: 9 } } } },
    });
    await patch('/api/inventory/submissions/' + bgs.subId, {
      result_grade: 9.5, status: 'graded', result_subgrades: JSON.stringify({ centering: 9, corners: 9.5, edges: 9.5, surface: 9.5 }),
    });
    const c = (await get('/api/pregrade/calibration')).json;
    assert.equal(c.n, 2);
    assert.deepEqual(Object.keys(c.byCompany).sort(), ['BGS', 'PSA']);
    assert.equal(c.byCompany.BGS.n, 1);
    assert.equal(c.byCompany.BGS.underPredicted, 1, 'BGS 9 predicted vs 9.5 actual — not the PSA 10 in the same blob');
    assert.equal(c.byCompany.BGS.biasPerPillar, null, 'one BGS slab is not a per-pillar bias');
    assert.deepEqual(c.byCompany.BGS.biasPerPillarN, { centering: 1, corners: 1, edges: 1, surface: 1 });
    assert.equal(c.overall.n, 2);
    assert.equal(c.overall.confidence, 'none');
  });

  it('a report rewritten through the unlock hatch is flagged and excluded from the maths', async () => {
    const dirty = await linkAndSubmit({ name: 'Rewritten After Linking' });
    await patch('/api/pregrade/' + dirty.reportId, { unlock: true, predictions: { perCompany: { PSA: { grade: 10 } } } });
    await patch('/api/inventory/submissions/' + dirty.subId, { result_grade: 4, status: 'graded' });
    const c = (await get('/api/pregrade/calibration')).json;
    assert.equal(c.n, 2, 'the rewritten prediction must not enter the sample');
    assert.equal(c.excluded.suspectEdits, 1);
    const flagged = c.recent.find((x) => x.reportId === dirty.reportId);
    assert.ok(flagged, 'but it must stay visible');
    assert.equal(flagged.suspect, true);
    assert.match(c.note, /unlock hatch/);
  });

  it('crossing the threshold turns the statistics on, and states its own uncertainty', async () => {
    for (let i = 0; i < 7; i++) {
      const s = await linkAndSubmit({ name: `Bulk PSA ${i}` });     // payload predicts PSA 9
      await patch('/api/inventory/submissions/' + s.subId, { result_grade: 8.5, status: 'graded' });
    }
    const c = (await get('/api/pregrade/calibration')).json;
    assert.equal(c.byCompany.PSA.n, 8);
    assert.equal(c.byCompany.PSA.confidence, 'usable');
    assert.ok(c.byCompany.PSA.meanError > 0, 'we predict high: 9 against 8.5s and one 8');
    assert.equal(c.byCompany.PSA.meanErrorCi95.length, 2);
    assert.match(c.byCompany.PSA.note, /95% interval/);
    assert.equal(c.byCompany.BGS.n, 1, 'BGS is untouched by PSA volume');
    assert.equal(c.byCompany.BGS.meanError, null);
    assert.equal(c.thresholds.stats, 3);
    assert.equal(c.thresholds.bias, 8);
  });

  it('a resubmitted card counts once, at its newest result', async () => {
    const again = await post('/api/inventory/submissions', {
      game: 'pokemon', name: 'First Result', grading_company: 'PSA', pregrade_id: psa.reportId,
    });
    await patch('/api/inventory/submissions/' + again.json.id, { result_grade: 9, status: 'graded' });
    const c = (await get('/api/pregrade/calibration')).json;
    assert.equal(c.recent.filter((x) => x.reportId === psa.reportId).length, 1, 'one row per report, not one per submission');
    assert.equal(c.recent.find((x) => x.reportId === psa.reportId).actual, 9, 'the crossover result is the live one');
  });

  it('junk query parameters degrade instead of throwing (GR7)', async () => {
    for (const qs of ['?recent=abc', '?recent=-5', '?recent=99999', '?recent=']) {
      const r = await get('/api/pregrade/calibration' + qs);
      assert.equal(r.status, 200, qs);
      assert.equal(r.json.ok, true);
      assert.ok(r.json.recent.length <= 200);
    }
  });
});
