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
//
// Two mechanisms defend that boundary, both below:
//   THE FREEZE — once a submission points at a report, the prediction columns stop being writable
//   (PATCH answers 409), because a report reopened weeks later re-pulls today's prices and re-runs
//   the AI, and saving over the top turns a before-the-fact prediction into an after-the-fact one.
//   CALIBRATION — GET /calibration, the only consumer that reads predicted and actual together,
//   and the reason any of this is stored at all.
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
// Written by the server only. Kept OUT of JSON_COLS on purpose: an audit trail a client can PATCH
// is not an audit trail. Parsed on the way out, never bound on the way in.
const AUDIT_JSON_COLS = ['unlock_log'];

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

// ============================ THE FREEZE (linked reports) ============================
//
// The columns that ARE the prediction. Once a report is linked to a grading submission these stop
// being editable, because the report's entire job from that moment is to still say, weeks later,
// what we predicted BEFORE the slab came back. Reopening a report in the grader re-pulls today's
// comps and can re-run the AI pass; the save that follows would overwrite the prediction with a
// number formed with more information than the prediction had. Nothing in the row would look
// wrong afterwards — that is exactly why it needs a lock rather than a convention.
const FROZEN_COLS = new Set(['predictions', 'economics', 'centering', 'pillars', 'granular', 'ai_meta', 'config_as_of']);
// Deliberately NOT frozen, and each for a reason: identity fields (a misspelled card name must
// stay fixable — it is a label, not evidence), `status` (the pipeline PATCHes it to 'sent'
// immediately AFTER creating the link, so freezing it would break the very flow that locks the
// report), and `defects` (annotation the report re-renders; no predicted grade is derived from
// it — the grades come from centering + pillars).

const sqlNow = (db) => db.prepare(`SELECT datetime('now') AS t`).get().t;

// The link IS the lock: one grading_submissions row pointing at this report is enough.
const linkOf = (db, id) => db.prepare(
  `SELECT id, created_at FROM grading_submissions WHERE pregrade_id = ? ORDER BY id ASC LIMIT 1`).get(id) || null;

// Read-only lock state. `locked_at` prefers the stored stamp and otherwise derives from the
// earliest link, so a report reads as locked from the instant the submission exists — even before
// any write has stamped it (the submission POST lives in lib/inventory.mjs, which does not know
// this table). A link that was later deleted does NOT thaw the report: the prediction was already
// committed to a real grading run, and the honest record of that is the stamp, not the FK.
function lockStateOf(db, id, row) {
  const link = linkOf(db, id);
  const stamped = row && row.locked_at ? String(row.locked_at) : null;
  return {
    locked: !!(stamped || link),
    locked_at: stamped || (link ? link.created_at || null : null),
    submission_id: link ? link.id : null,
    stamped: !!stamped,
  };
}

// ============================ CALIBRATION (predicted vs actual) ============================
//
// The reason the persistence layer exists. Everything below is deliberately conservative, because
// this tool will honestly sit at n=3 for months and a confident-looking number over three cards
// is worse than no number at all (Golden Rule 4 applies to our own accuracy claims, not just to
// grades).
//
// The two thresholds, and the reasoning, stated because a reader will otherwise assume they came
// from somewhere principled:
//  - n < 3  -> 'none'. Counts only. A "median error" over two cards is one of the two cards
//    wearing a statistic's clothes.
//  - 3 <= n < 8 -> 'weak'. Median error and MAE only. Both survive a single outlier; a MEAN does
//    not, and the mean is precisely the bias figure someone would act on.
//  - n >= 8 -> 'usable'. Mean error with a 95% interval, and per-pillar bias.
// Why 8 and not 5 or 30: pre-grade deltas land on a 0.5 grid with a spread of roughly half a
// grade, so the standard error of the mean at n=8 is about 0.18 — small enough to tell a
// half-grade bias from noise, which is the smallest bias worth changing behaviour over. It is a
// judgement call sized to the decision, NOT a power calculation, and it is one constant to move
// if the owner disagrees. Below it the mean would move more than the effect it claims to measure.
const MIN_STAT_N = 3;
const MIN_BIAS_N = 8;
// Grades come off a 0.5 grid; the epsilon only guards float subtraction, never widens a band.
const EPS = 1e-9;
const PILLARS = ['centering', 'corners', 'edges', 'surface'];

const r2 = (x) => Math.round(x * 100) / 100;
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const asJson = (v) => (typeof v === 'string' ? jsonOut(v) : (v == null ? null : v));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function sd(a) {                                  // sample SD (n-1): we are estimating, not describing
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}
// Two-sided 95% t multipliers. A normal 1.96 at n=8 understates the interval by ~20%, and
// understating uncertainty is the one direction this route must never err in.
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179,
  2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060,
  2.056, 2.052, 2.048, 2.045, 2.042];
const t95 = (df) => (df >= 1 && df <= T95.length ? T95[df - 1] : 1.96);

// Pull the prediction made FOR THE COMPANY THAT ACTUALLY GRADED THE CARD. Not the "best" company
// the list card shows: comparing a PSA slab against our BGS prediction would measure nothing.
// Shapes are the grader page's own (GR.predictAll -> {perCompany:{CO:{grade, pillars, subgrades}}});
// an unfamiliar or malformed blob yields null and the row is counted as unusable, never guessed at.
function predForCompany(predictionsRaw, company) {
  const pred = asJson(predictionsRaw);
  if (!pred || typeof pred !== 'object' || Array.isArray(pred)) return null;
  const per = pred.perCompany && typeof pred.perCompany === 'object' && !Array.isArray(pred.perCompany)
    ? pred.perCompany : pred;
  let entry = per[company];
  if (entry === undefined) {
    const k = Object.keys(per).find((x) => x.toUpperCase() === company);
    entry = k ? per[k] : undefined;
  }
  if (entry == null) return null;
  if (typeof entry === 'number') return Number.isFinite(entry) ? { grade: entry, subgrades: null, pillars: null } : null;
  if (typeof entry !== 'object') return null;
  const grade = numOrNull(entry.grade);
  if (grade == null) return null;
  return { grade, subgrades: pillarMap(entry.subgrades), pillars: pillarMap(entry.pillars) };
}
// {centering,corners,edges,surface} of finite numbers, or null if not one of those.
function pillarMap(v) {
  const o = asJson(v);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  let any = false;
  for (const k of PILLARS) { const n = numOrNull(o[k]); out[k] = n; if (n != null) any = true; }
  return any ? out : null;
}

// A report PATCHed through the escape hatch after it was locked is suspect: the prediction on file
// may no longer be the one the submission was made against. frozen_dirty_at is set ONLY when an
// unlock actually rewrote a frozen column, so an ordinary status/notes edit never trips this.
const isSuspect = (row) => !!(row && row.frozen_dirty_at);

const confidenceFor = (n) => (n >= MIN_BIAS_N ? 'usable' : n >= MIN_STAT_N ? 'weak' : 'none');

// Per-pillar bias needs the actual SUBGRADES the slab printed (BGS/PCG/TAG). PSA prints one
// number, and a per-pillar bias derived from an overall grade is invented data — null instead.
function pillarBias(pts) {
  const values = {}, counts = {};
  let anyComputed = false;
  for (const k of PILLARS) {
    const deltas = [];
    for (const p of pts) {
      // Prefer the predicted subgrades over the raw pillars: for a company that prints subgrades
      // that is the number being compared like-for-like with what came back on the slab.
      const predSide = (p.predictedSubgrades && p.predictedSubgrades[k] != null) ? p.predictedSubgrades[k]
        : (p.predictedPillars ? p.predictedPillars[k] : null);
      const actualSide = p.actualSubgrades ? p.actualSubgrades[k] : null;
      if (predSide == null || actualSide == null) continue;
      deltas.push(predSide - actualSide);
    }
    counts[k] = deltas.length;
    if (deltas.length >= MIN_BIAS_N) { values[k] = r2(median(deltas)); anyComputed = true; }
    else values[k] = null;
  }
  return { values: anyComputed ? values : null, counts };
}

function metricsFor(pts, label) {
  const n = pts.length;
  const d = pts.map((p) => p.delta);
  const out = {
    n,
    meanError: null,          // withheld below MIN_BIAS_N — see the threshold note above
    medianError: null,
    mae: null,
    meanErrorCi95: null,
    within0_5: d.filter((x) => Math.abs(x) <= 0.5 + EPS).length,
    within1: d.filter((x) => Math.abs(x) <= 1 + EPS).length,
    overPredicted: d.filter((x) => x > EPS).length,
    underPredicted: d.filter((x) => x < -EPS).length,
    exact: d.filter((x) => Math.abs(x) <= EPS).length,
    // Counts, not percentages: "67% within half a grade" over three cards reads as a measurement
    // and is really just "2 of 3". The client can divide if it wants to, with n in plain sight.
    biasPerPillar: null,
    biasPerPillarN: null,
    biasBasis: 'median(predicted - actual)',
    confidence: confidenceFor(n),
    note: '',
  };
  const who = label ? label + ': ' : '';
  // The paired-subgrade counts are reported at ANY n, including zero: "you have 1 of the 8 pairs
  // this needs" is the useful answer, and it is the one that keeps the threshold from looking
  // like a bug. Only the FIGURES wait for the threshold.
  const pb = pillarBias(pts);
  out.biasPerPillarN = pb.counts;
  if (n === 0) { out.note = who + 'no graded results linked yet.'; return out; }
  if (n >= MIN_STAT_N) { out.medianError = r2(median(d)); out.mae = r2(mean(d.map(Math.abs))); }
  if (n >= MIN_BIAS_N) {
    const m = mean(d), s = sd(d);
    out.meanError = r2(m);
    const half = t95(n - 1) * s / Math.sqrt(n);
    out.meanErrorCi95 = [r2(m - half), r2(m + half)];
    out.biasPerPillar = pb.values;
    const sign = m > 0 ? 'over' : m < 0 ? 'under' : 'neither over nor under';
    out.note = `${who}${n} graded results. Predicting ${sign} by ${r2(Math.abs(m))} of a grade on average `
      + `(95% interval ${out.meanErrorCi95[0]} to ${out.meanErrorCi95[1]}); median ${out.medianError}, MAE ${out.mae}. `
      + 'The interval assumes the cards are independent samples, which one collection graded by one company is not entirely.';
  } else if (n >= MIN_STAT_N) {
    out.note = `${who}${n} graded results — median error ${out.medianError} and MAE ${out.mae} only. `
      + `A mean (the bias figure) is withheld below n=${MIN_BIAS_N}, where one outlier moves it further than the bias would.`;
  } else {
    out.note = `${who}${n} graded result${n === 1 ? '' : 's'} — counts only. `
      + `No error statistic is reported below n=${MIN_STAT_N}; there is nothing here a single card would not dominate.`;
  }
  if (n >= MIN_BIAS_N && !out.biasPerPillar) {
    out.note += ' Per-pillar bias is null: no linked slab came back with subgrades (only BGS/PCG/TAG print them).';
  }
  return out;
}

// rows: the joined report+submission rows (see CALIBRATION_SQL). Pure and DB-free so the maths is
// unit-testable without a database; the route is the only thing that knows SQL.
export function buildCalibration(rows, opts = {}) {
  const recentLimit = Math.max(1, Math.min(200, opts.recentLimit || 20));
  const points = [], recent = [];
  const excluded = { suspectEdits: 0, noPredictionForCompany: 0, unusableResult: 0 };
  // Every linked result the query returned, usable or not: "nothing has come back from the
  // grader yet" and "everything that came back was unusable" are different things to tell someone.
  let seen = 0;
  for (const raw of Array.isArray(rows) ? rows : []) {
    seen++;
    const company = String(raw.company || '').trim().toUpperCase();
    const actual = numOrNull(raw.result_grade);
    if (!company || actual == null) { excluded.unusableResult++; continue; }
    const pred = predForCompany(raw.predictions, company);
    if (!pred) { excluded.noPredictionForCompany++; continue; }
    const suspect = isSuspect(raw);
    const entry = {
      reportId: raw.id ?? null, name: raw.name ?? null, company,
      predicted: pred.grade, actual, delta: r2(pred.grade - actual),   // + = we predicted HIGH
      gradedAt: raw.graded_at ?? null, submissionId: raw.submission_id ?? null, suspect,
    };
    recent.push(entry);
    // Suspect rows are shown but never counted: they appear in `recent` flagged, so the owner can
    // see the card, and stay out of every statistic, because we no longer know what was predicted.
    if (suspect) { excluded.suspectEdits++; continue; }
    points.push({
      ...entry,
      predictedSubgrades: pred.subgrades, predictedPillars: pred.pillars,
      actualSubgrades: pillarMap(raw.result_subgrades),
    });
  }
  recent.sort((a, b) => String(b.gradedAt || '').localeCompare(String(a.gradedAt || '')) || (b.submissionId || 0) - (a.submissionId || 0));

  const byCompany = {};
  for (const co of [...new Set(points.map((p) => p.company))].sort()) {
    byCompany[co] = metricsFor(points.filter((p) => p.company === co), co);
  }
  const overall = metricsFor(points, null);
  let note = overall.note;
  if (!points.length) {
    note = seen
      ? `No usable comparison: all ${seen} linked result${seen === 1 ? ' was' : 's were'} excluded (see \`excluded\`).`
      : 'No linked submission has come back with a grade yet, so there is nothing to calibrate against. This is an empty sample, not a score of zero.';
  }
  if (excluded.suspectEdits) {
    note += ` ${excluded.suspectEdits} report${excluded.suspectEdits === 1 ? ' was' : 's were'} excluded: `
      + 'a frozen column was rewritten through the unlock hatch after the submission was linked, so the stored prediction is no longer provably the one submitted against.';
  }
  if (excluded.noPredictionForCompany) {
    note += ` ${excluded.noPredictionForCompany} excluded for carrying no prediction for the company that graded them.`;
  }
  return {
    ok: true,
    n: points.length,                       // usable comparisons only; excluded rows are itemised
    byCompany,
    overall,
    recent: recent.slice(0, recentLimit),
    confidence: overall.confidence,
    note,
    excluded,
    thresholds: { stats: MIN_STAT_N, bias: MIN_BIAS_N, deltaSign: 'predicted minus actual; positive means we predicted HIGH' },
    generated_at: opts.now || null,
  };
}

// One row per report: the LATEST linked submission that actually carries a grade. A report
// resubmitted after a crossover keeps its newest result, and a submission still out at the grader
// (result_grade NULL) contributes nothing rather than a zero.
const CALIBRATION_SQL = `
  SELECT r.id, r.name, r.set_name, r.number, r.predictions, r.locked_at, r.frozen_dirty_at,
         s.id AS submission_id, s.grading_company AS company, s.result_grade, s.result_subgrades,
         COALESCE(s.updated_at, s.created_at) AS graded_at
    FROM grading_submissions s
    JOIN pregrade_reports r ON r.id = s.pregrade_id
   WHERE s.result_grade IS NOT NULL
     AND s.id = (SELECT MAX(s2.id) FROM grading_submissions s2
                  WHERE s2.pregrade_id = s.pregrade_id AND s2.result_grade IS NOT NULL)
   ORDER BY graded_at DESC, s.id DESC`;

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

      // GET /calibration — how good the predictions actually are, per company and overall.
      //
      // Registered before the list route for readability only; it cannot collide with /:id, which
      // matches digits. Everything honest about this endpoint is in buildCalibration above: n is
      // stated everywhere, statistics appear only once the sample can carry them, and per-pillar
      // bias exists only when real subgrades came back.
      if (p === '/calibration' && method === 'GET') {
        try {
          const rows = db.prepare(CALIBRATION_SQL).all();
          const limit = +url.searchParams.get('recent') || 20;
          return send(res, 200, buildCalibration(rows, { recentLimit: limit, now: sqlNow(db) }));
        } catch (e) {
          console.error('[api/pregrade] calibration:', e?.message || e);
          // n:null, never 0. "The query failed" and "no slab has come back yet" are different
          // facts, and a dashboard that renders a broken read as a confident zero is the same lie
          // as the saved-list "Nothing saved yet" bug this tool has already been bitten by.
          return send(res, 500, {
            ok: false, error: 'calibration_failed', detail: String(e?.message || e),
            n: null, byCompany: {}, recent: [], confidence: 'none',
            note: 'Calibration could not be computed. This is a failure to measure, not a measurement of zero.',
          });
        }
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
                 r.predictions, r.economics, r.locked_at, r.frozen_dirty_at,
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
            // A card in the list is either still editable or frozen behind a live submission. The
            // stamp can lag the link (nothing writes it at link time — see lockStateOf), so the
            // link itself decides `locked`, not the column.
            locked: !!(r.locked_at || r.submission_id),
            locked_at: r.locked_at ?? null,
            prediction_edited: !!r.frozen_dirty_at,
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
        for (const k of AUDIT_JSON_COLS) report[k] = jsonOut(row[k]);
        const images = db.prepare('SELECT shot_id, sha256, ext, width, height, dpi, kind FROM pregrade_images WHERE report_id = ? ORDER BY id').all(+m[1])
          .map((i) => ({ shot_id: i.shot_id, url: storeUrl(i.sha256, i.ext), w: i.width, h: i.height, dpi: i.dpi, kind: i.kind, ext: i.ext }));
        // Read-only: a GET must not stamp the lock. The client needs to know BEFORE it offers a
        // Save button that this report's prediction is frozen, and which columns that covers, so
        // the freeze is not first discovered as a 409 after the operator redid the work.
        const lock = lockStateOf(db, +m[1], row);
        report.locked = lock.locked;
        report.locked_at = lock.locked_at;
        return send(res, 200, { report, images, lock: { ...lock, frozen: [...FROZEN_COLS] } });
      }

      // PATCH /:id — partial update of the POST fields, subject to THE FREEZE.
      //
      // A report linked to a grading submission has its prediction columns locked: the submission
      // is out at the grader and this row is the only before-the-fact record of what we thought.
      // Identity, status and notes-style edits stay open; the prediction does not. The escape
      // hatch is {unlock:true} in the body — deliberate, one request wide, and recorded.
      if ((m = p.match(/^\/(\d+)$/)) && method === 'PATCH') {
        const id = +m[1];
        const row = db.prepare('SELECT id, locked_at, unlock_log FROM pregrade_reports WHERE id = ?').get(id);
        if (!row) return send(res, 404, { ok: false, error: 'report not found' });
        const b = await readJson(req, MAX_REPORT_BODY);
        if (b.__bodyError) return send(res, 400, { ok: false, error: b.__bodyError });
        const unlock = b.unlock === true;   // strictly true: a stray "false"/0/"yes" must not unlock
        const obj = pickReport(b);
        const cols = Object.keys(obj);
        if (!cols.length && !unlock) return send(res, 400, { ok: false, error: 'nothing to update' });

        const lock = lockStateOf(db, id, row);
        const refused = cols.filter((c) => FROZEN_COLS.has(c));
        if (lock.locked && !unlock && refused.length) {
          // The WHOLE request is refused, including the columns that were allowed. A partial apply
          // would report success for a save the operator believes wrote their new prediction.
          return send(res, 409, {
            ok: false, error: 'locked',
            report_id: id, locked_at: lock.locked_at, submission_id: lock.submission_id,
            refused,
            allowed: cols.filter((c) => !FROZEN_COLS.has(c)),
            frozen: [...FROZEN_COLS],
            message: `report ${id} is linked to grading submission ${lock.submission_id ?? '(since deleted)'}; `
              + 'its prediction is frozen so the returning slab has an honest before-the-fact number to be measured against. '
              + 'Nothing was changed.',
            hint: 'PATCH {"unlock": true, "unlock_reason": "..."} in the same request to override. The override is recorded and the report is excluded from calibration.',
          });
        }

        const sets = cols.map((c) => c + ' = ?'), vals = cols.map((c) => obj[c]);
        let unlocked = false;
        if (unlock && lock.locked) {
          const prior = jsonOut(row.unlock_log);
          const log = Array.isArray(prior) ? prior : [];   // a corrupted log is appended to, never lost
          log.push({
            at: sqlNow(db), was_locked_at: lock.locked_at, submission_id: lock.submission_id,
            columns: refused,                                    // which frozen columns this override rewrote
            reason: b.unlock_reason == null ? null : String(b.unlock_reason).slice(0, 500),
          });
          sets.push('locked_at = NULL', 'unlock_log = ?');
          vals.push(JSON.stringify(log));
          // Only an override that actually rewrote a frozen column taints the prediction. Unlocking
          // to fix a card name leaves the prediction provably intact, and calibration keeps the row.
          if (refused.length) sets.push(`frozen_dirty_at = datetime('now')`);
          unlocked = true;
        } else if (lock.locked && !lock.stamped) {
          // Materialise the stamp the first time a write sees the link. Nothing writes locked_at at
          // link time — the submissions POST lives in lib/inventory.mjs and knows nothing about this
          // table — so it is dated from the SUBMISSION's created_at, not from now: the freeze began
          // when the card was sent, whatever hour this route got round to writing it down.
          sets.push('locked_at = ?');
          vals.push(lock.locked_at || sqlNow(db));
        }
        sets.push(`updated_at = datetime('now')`);
        db.prepare(`UPDATE pregrade_reports SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
        // Re-read rather than infer: after an unlock the row is unlocked, but a live link re-freezes
        // it on the very next request (the hatch covers one PATCH, never a standing exemption).
        const after = lockStateOf(db, id, db.prepare('SELECT locked_at FROM pregrade_reports WHERE id = ?').get(id));
        return send(res, 200, {
          updated: true, unlocked,
          locked: after.locked, locked_at: after.locked_at,
          ...(unlocked ? { was_locked_at: lock.locked_at, unlocked_columns: refused, refreezes: after.locked } : {}),
        });
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
