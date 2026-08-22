// lib/pregrade.mjs — persistence for card-grader.html pre-grade reports: /api/pregrade.
//
// A Vite dev-server plugin, per Golden Rule 1 — there is no production backend, so every server
// route in this repo is a plugin registered in vite.config.js.
//
// The Golden Rule 4 boundary this API sits on: a report stores PREDICTIONS — per-company predicted
// grades plus the submit-vs-sell economics behind them. The ACTUAL grade lives only on
// grading_submissions.result_grade; the list below surfaces both side by side through
// grading_submissions.pregrade_id, and nothing here copies one into the other.
//
// Shot BYTES live content-addressed in data/pregrade-images/ (lib/pregrade-store.mjs); the DB
// holds only per-shot metadata + the sha that finds them (pregrade_images, lib/db.mjs).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { openDb } from './db.mjs';
import { readJsonBody } from './req-body.mjs';
import {
  STORE_DIR, storePut, storeLookup, storePath, storeUrl, isStoreExt, isDownloadName, CONTENT_TYPE,
} from './pregrade-store.mjs';

// Scans arrive as base64 inside a JSON envelope, so the body limit has to allow for the ~4/3
// inflation plus the envelope: 28MB covers a ~20MB shot. readJsonBody takes the limit as an
// argument and does NOT default it — pass `undefined` and there is no limit at all (the trap
// lib/listing-image-lab.mjs documents).
const MAX_IMAGE_BODY = 28 * 1024 * 1024;
// Report bodies are measurement + prediction JSON, never image bytes.
const MAX_REPORT_BODY = 2 * 1024 * 1024;

// --- tiny http helpers (same shape as lib/listings.mjs / lib/repricer.mjs) ---
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}
// readJsonBody rejects (too large / invalid JSON); a route must turn that into a 400, never a
// crash (Golden Rule 7) — so the error rides back on a sentinel key the routes check first.
async function readJson(req, limit) {
  try { return await readJsonBody(req, limit); }
  catch (e) { return { __bodyError: String(e?.message || e) }; }
}

// The POST/PATCH column surface. Split because the two halves are handled differently: scalars
// bind as TEXT, the JSON blobs are stringified on the way in and tolerantly parsed on the way out.
const SCALAR_COLS = ['game', 'identity_key', 'name', 'set_name', 'number', 'rarity', 'finish', 'language', 'status'];
const JSON_COLS = ['centering', 'pillars', 'granular', 'defects', 'ai_meta', 'predictions', 'economics', 'config_as_of'];

const jsonIn = (v) => (v == null ? null : JSON.stringify(v));
// A malformed blob degrades to null rather than failing the whole read (Golden Rule 7).
const jsonOut = (v) => { if (v == null) return null; try { return JSON.parse(v); } catch { return null; } };

// Body → bindable row object, only for keys the request actually carried (PATCH stays partial).
// Scalars are coerced to strings: node:sqlite refuses booleans outright (the bug inventory #6
// guards against), and every scalar column here is TEXT anyway.
function pickReport(b) {
  const obj = {};
  for (const k of SCALAR_COLS) if (b[k] !== undefined) obj[k] = b[k] == null ? null : String(b[k]);
  for (const k of JSON_COLS) if (b[k] !== undefined) obj[k] = jsonIn(b[k]);
  return obj;
}

// best_company / best_grade for the list cards, derived server-side so the page does not parse N
// prediction blobs to render a table. The shapes are the grader page's own (predictions =
// GradeRules.predictAll — perCompany map of {grade,...}; economics = per-company gradeEconomics
// rows, best home by profitVsRaw). All best-effort: a malformed or unfamiliar blob yields nulls,
// never an error — these are PREDICTED grades either way, never slab grades (Golden Rule 4).
function bestOf(predictionsRaw, economicsRaw) {
  const pred = jsonOut(predictionsRaw), econ = jsonOut(economicsRaw);
  const per = pred && typeof pred === 'object' && !Array.isArray(pred)
    ? (pred.perCompany && typeof pred.perCompany === 'object' ? pred.perCompany : pred)
    : null;
  let company = null;
  if (econ && typeof econ === 'object' && !Array.isArray(econ)) {
    if (typeof econ.bestCo === 'string') company = econ.bestCo;
    else {
      let bestProfit = -Infinity;
      for (const [c, e] of Object.entries(econ)) {
        if (e && typeof e === 'object' && e.ok && typeof e.profitVsRaw === 'number' && e.profitVsRaw > bestProfit) {
          bestProfit = e.profitVsRaw; company = c;
        }
      }
    }
  }
  if (!company && per) company = Object.keys(per)[0] || null;
  const entry = company && per ? per[company] : null;
  const grade = typeof entry === 'number' ? entry
    : (entry && typeof entry === 'object' && typeof entry.grade === 'number') ? entry.grade : null;
  return { best_company: company || null, best_grade: grade };
}

// The card the list thumbnail shows: the front scan when one exists, else any shot at all.
const THUMB_SQL = `SELECT sha256, ext FROM pregrade_images WHERE report_id = ?
  ORDER BY CASE WHEN shot_id = 'scan-front' THEN 0 WHEN shot_id LIKE '%front%' THEN 1 ELSE 2 END, id
  LIMIT 1`;

export function makePregradeRouter({ env, db }) {
  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      let m;   // reused by the /:id route matchers below

      // GET /file/<sha256>.<ext>[/<download-name>] — the content-addressed store.
      //
      // Dispatched HERE rather than registered as its own middleware: connect matches by
      // REGISTRATION ORDER, not longest prefix, so a second use('/api/pregrade/file') would be
      // shadowed by this handler entirely. Same trap lib/listing-image-lab.mjs and vite.config.js
      // (/api/rbs before /api/rb) both document.
      const fileMatch = /^\/file\/([0-9a-f]{64})\.([a-z0-9]+)(?:\/([^/]+))?$/.exec(p);
      if (fileMatch && method === 'GET') {
        const [, hash, ext, rawName] = fileMatch;
        if (!isStoreExt(ext)) return send(res, 404, { ok: false, error: 'not found' });
        const hit = storeLookup(hash, [ext]);
        if (!hit) return send(res, 404, { ok: false, error: 'not found' });
        let body;
        try { body = fs.readFileSync(hit.file); } catch { return send(res, 404, { ok: false, error: 'not found' }); }
        res.statusCode = 200;
        res.setHeader('content-type', CONTENT_TYPE[hit.ext] || 'application/octet-stream');
        res.setHeader('content-length', String(body.length));
        // Content-addressed, so this is free AND correct: the bytes at this URL cannot change.
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        // The name is re-serialised from a validated value, never echoed — an unchecked one is
        // a header-injection hole, and it plays no part in finding the bytes.
        let name = '';
        try { name = decodeURIComponent(rawName || ''); } catch { name = ''; }
        if (isDownloadName(name)) res.setHeader('content-disposition', `inline; filename="${name}"`);
        return res.end(body);
      }

      // POST / — save a report. Only `name` is required: a report on an unidentified card is
      // still a report (Golden Rule 7 — the grader works without a successful lookup).
      if (p === '/' && method === 'POST') {
        const b = await readJson(req, MAX_REPORT_BODY);
        if (b.__bodyError) return send(res, 400, { ok: false, error: b.__bodyError });
        if (!b.name || !String(b.name).trim()) return send(res, 400, { ok: false, error: 'name is required' });
        const obj = pickReport(b);
        const cols = Object.keys(obj);
        const info = db.prepare(`INSERT INTO pregrade_reports (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...cols.map((c) => obj[c]));
        return send(res, 201, { id: Number(info.lastInsertRowid) });
      }

      // POST /:id/images {shotId, dataB64, mediaType, w, h, dpi?, kind} — attach/replace a shot.
      // Upsert on UNIQUE(report_id, shot_id): re-shooting a slot re-points the row at the new
      // bytes. The superseded bytes stay on disk (content-addressed, so harmless and cheap);
      // only a report DELETE reference-counts them away.
      if ((m = p.match(/^\/(\d+)\/images$/)) && method === 'POST') {
        const id = +m[1];
        const b = await readJson(req, MAX_IMAGE_BODY);
        if (b.__bodyError) return send(res, 400, { ok: false, error: b.__bodyError });
        if (!db.prepare('SELECT id FROM pregrade_reports WHERE id = ?').get(id)) return send(res, 404, { ok: false, error: 'report not found' });
        if (!b.shotId || !b.dataB64) return send(res, 400, { ok: false, error: 'shotId and dataB64 are required' });
        const mt = String(b.mediaType || '');
        const ext = /png/i.test(mt) ? 'png' : /jpe?g/i.test(mt) ? 'jpg' : null;
        if (!ext) return send(res, 400, { ok: false, error: 'mediaType must be image/png or image/jpeg' });
        const bytes = Buffer.from(String(b.dataB64), 'base64');
        if (!bytes.length) return send(res, 400, { ok: false, error: 'dataB64 decoded to nothing' });
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        storePut(sha, ext, bytes);
        db.prepare(`INSERT INTO pregrade_images (report_id, shot_id, sha256, ext, width, height, dpi, kind)
                    VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(report_id, shot_id) DO UPDATE SET
                      sha256 = excluded.sha256, ext = excluded.ext, width = excluded.width,
                      height = excluded.height, dpi = excluded.dpi, kind = excluded.kind`)
          .run(id, String(b.shotId), sha, ext,
            b.w != null ? +b.w : null, b.h != null ? +b.h : null,
            b.dpi != null ? +b.dpi : null, b.kind != null ? String(b.kind) : null);
        return send(res, 200, { ok: true, sha256: sha, ext, url: '/api/pregrade/file/' + sha + '.' + ext });
      }

      // GET /?limit=&offset=&q= — the report list for the dashboard cards.
      if (p === '/' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        const limit = Math.max(1, Math.min(500, +url.searchParams.get('limit') || 50));
        const offset = Math.max(0, +url.searchParams.get('offset') || 0);
        const where = q ? 'WHERE (r.name LIKE ? OR r.set_name LIKE ? OR r.number LIKE ?)' : '';
        const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
        const total = db.prepare(`SELECT COUNT(*) AS n FROM pregrade_reports r ${where}`).get(...args).n;
        // Scalar subqueries rather than a LEFT JOIN: two submissions pointing at one report would
        // duplicate its list row under a join. Latest submission wins — that is the live one.
        const rows = db.prepare(`
          SELECT r.id, r.name, r.set_name, r.number, r.finish, r.created_at, r.status,
                 r.predictions, r.economics,
                 (SELECT s.id FROM grading_submissions s WHERE s.pregrade_id = r.id ORDER BY s.id DESC LIMIT 1) AS submission_id,
                 (SELECT s.result_grade FROM grading_submissions s WHERE s.pregrade_id = r.id ORDER BY s.id DESC LIMIT 1) AS actual_grade
            FROM pregrade_reports r ${where}
           ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
        const thumbStmt = db.prepare(THUMB_SQL);
        const reports = rows.map((r) => {
          const t = thumbStmt.get(r.id);
          return {
            id: r.id, name: r.name, set_name: r.set_name, number: r.number, finish: r.finish,
            created_at: r.created_at, status: r.status,
            ...bestOf(r.predictions, r.economics),
            thumb_url: t ? storeUrl(t.sha256, t.ext) : null,
            submission_id: r.submission_id ?? null,
            actual_grade: r.actual_grade ?? null,
          };
        });
        return send(res, 200, { reports, total });
      }

      // GET /:id — the full report (JSON columns parsed) + its shots.
      if ((m = p.match(/^\/(\d+)$/)) && method === 'GET') {
        const row = db.prepare('SELECT * FROM pregrade_reports WHERE id = ?').get(+m[1]);
        if (!row) return send(res, 404, { ok: false, error: 'report not found' });
        const report = { ...row };
        for (const k of JSON_COLS) report[k] = jsonOut(row[k]);
        const images = db.prepare('SELECT shot_id, sha256, ext, width, height, dpi, kind FROM pregrade_images WHERE report_id = ? ORDER BY id').all(+m[1])
          .map((i) => ({ shot_id: i.shot_id, url: storeUrl(i.sha256, i.ext), w: i.width, h: i.height, dpi: i.dpi, kind: i.kind, ext: i.ext }));
        return send(res, 200, { report, images });
      }

      // PATCH /:id — partial update of the POST fields.
      if ((m = p.match(/^\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        if (!db.prepare('SELECT id FROM pregrade_reports WHERE id = ?').get(id)) return send(res, 404, { ok: false, error: 'report not found' });
        const b = await readJson(req, MAX_REPORT_BODY);
        if (b.__bodyError) return send(res, 400, { ok: false, error: b.__bodyError });
        const obj = pickReport(b);
        const cols = Object.keys(obj);
        if (!cols.length) return send(res, 400, { ok: false, error: 'nothing to update' });
        const sets = cols.map((c) => c + ' = ?').concat([`updated_at = datetime('now')`]);
        db.prepare(`UPDATE pregrade_reports SET ${sets.join(', ')} WHERE id = ?`).run(...cols.map((c) => obj[c]), id);
        return send(res, 200, { updated: true });
      }

      // DELETE /:id — remove the report + its image rows (FK cascade), then the bytes — but ONLY
      // bytes no other report still references: shots are content-addressed, so two reports of the
      // same card legitimately share a file, and deleting one must not blind the other.
      if ((m = p.match(/^\/(\d+)$/)) && method === 'DELETE') {
        const id = +m[1];
        if (!db.prepare('SELECT id FROM pregrade_reports WHERE id = ?').get(id)) return send(res, 404, { ok: false, error: 'report not found' });
        const shots = db.prepare('SELECT DISTINCT sha256, ext FROM pregrade_images WHERE report_id = ?').all(id);
        db.prepare('DELETE FROM pregrade_reports WHERE id = ?').run(id);
        for (const s of shots) {
          const still = db.prepare('SELECT COUNT(*) AS n FROM pregrade_images WHERE sha256 = ?').get(s.sha256).n;
          if (still) continue;
          try { fs.unlinkSync(storePath(s.sha256, s.ext)); } catch { /* already gone — fine */ }
        }
        return send(res, 200, { deleted: true });
      }

      return send(res, 404, { ok: false, error: 'unknown pregrade route', path: p, method });
    } catch (e) {
      console.error('[api/pregrade] error:', e?.message || e);
      return send(res, 500, { ok: false, error: 'pregrade error', detail: String(e?.message || e) });
    }
  };
}

export function pregradePlugin(env) {
  return {
    name: 'pregrade',
    configureServer(server) {
      const db = openDb();   // shared tracker.db — reports sit beside grading_submissions for the join
      server.middlewares.use('/api/pregrade', makePregradeRouter({ env, db }));
      console.log('[pregrade] API /api/pregrade · images ' + STORE_DIR);
    },
  };
}
