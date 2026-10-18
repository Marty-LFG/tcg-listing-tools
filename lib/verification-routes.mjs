// lib/verification-routes.mjs — the HTTP surface over lib/verification.mjs.
//
// Split out for the reason lib/stock-ledger.mjs has no routes of its own: the ledger module is pure
// apart from the handle it is given, so it stays importable by a test with no server in sight. This
// file is the wiring, and it holds no rules — every refusal, every default and every downgrade lives in
// lib/verification.mjs so there is one place to read them.
//
// MOUNTED AT /api/verification, NOT under /api/inventory, because the record covers both stock kinds.
// Putting the sealed counts behind an /api/inventory path would be the first of the two-of-everything
// mistakes the KINDS/TABLE_FOR convention exists to avoid.
import { openDb, DB_PATH } from './db.mjs';
import {
  KINDS, SHAPES, OUTCOMES, REPORTABLE, PASSING,
  recordVerification, verificationState, verificationsFor, counts, queue, reconcile, flags,
} from './verification.mjs';

// ---- small http helpers (same shape as lib/inventory.mjs) ------------------
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) b = b.slice(0, 1e6); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const wantKind = (v) => (KINDS.includes(String(v)) ? String(v) : null);

function makeRouter({ db }) {
  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const q = url.searchParams;

      // GET /vocab — the outcome list and what each one means, so the UI never hardcodes a copy of it.
      // A second vocabulary in a page is how 'unavailable' quietly becomes 'missing'.
      if (p === '/vocab' && method === 'GET') {
        return send(res, 200, { outcomes: OUTCOMES, reportable: REPORTABLE, passing: PASSING, shapes: SHAPES, kinds: KINDS });
      }

      // GET /counts — how much of the pass is left, by shape. The whole point of the surface: a pass
      // that cannot report its own progress is a pass nobody finishes.
      if (p === '/counts' && method === 'GET') {
        return send(res, 200, counts(db, { includeSold: q.get('sold') === '1' }));
      }

      // GET /queue?shape=&limit= — the next rows to work through, in shelf order. This is the half that
      // makes a pass RESUMABLE: stop for the night, come back, ask again, carry on where it left off.
      if (p === '/queue' && method === 'GET') {
        return send(res, 200, { rows: queue(db, { shape: q.get('shape'), limit: +q.get('limit') || 100 }) });
      }

      // GET /flags?kind= — the rows a list view cannot render from verified_at alone. Small by
      // construction: only rows whose last look found something, or whose counted units have moved.
      if (p === '/flags' && method === 'GET') {
        return send(res, 200, { flags: flags(db, { kind: wantKind(q.get('kind')) }) });
      }

      // GET /item?kind=&id= — one row's state plus its whole history, newest first.
      if (p === '/item' && method === 'GET') {
        const kind = wantKind(q.get('kind'));
        if (!kind) return send(res, 400, { error: `kind must be one of ${KINDS.join('|')}` });
        const id = +q.get('id');
        if (!Number.isFinite(id) || id <= 0) return send(res, 400, { error: 'id required' });
        return send(res, 200, { kind, item_id: id, state: verificationState(db, kind, id), history: verificationsFor(db, kind, id) });
      }

      // GET /reconcile — every row where verified_at and the ledger disagree. Report-only, deliberately:
      // see the note on reconcile() for why squaring the number would destroy the evidence.
      if (p === '/reconcile' && method === 'GET') {
        const drift = reconcile(db, { kind: wantKind(q.get('kind')) });
        return send(res, 200, { drift, count: drift.length });
      }

      // POST /record { kind, item_id, outcome, units?, actor, note?, photo?, location? }
      //
      // THE TRANSACTION IS OPENED HERE, because lib/verification.mjs states it does not manage them:
      // the record and the cache write it implies must land together or neither. Same contract
      // lib/stock-ledger.mjs's callers honour.
      if (p === '/record' && method === 'POST') {
        const b = await readJson(req);
        const kind = wantKind(b.kind);
        if (!kind) return send(res, 400, { error: `kind must be one of ${KINDS.join('|')}` });
        const id = +b.item_id;
        if (!Number.isFinite(id) || id <= 0) return send(res, 400, { error: 'item_id required' });
        // BEGIN/COMMIT by hand: node:sqlite has no .transaction(), the idiom lib/arbitrage.mjs
        // documents one module over.
        db.exec('BEGIN');
        try {
          const out = recordVerification(db, {
            kind, itemId: id, outcome: b.outcome,
            units: b.units == null || b.units === '' ? null : +b.units,
            actor: b.actor, note: b.note || null, photo: b.photo || null, location: b.location || null,
          });
          db.exec('COMMIT');
          return send(res, 200, out);
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch { /* nothing open: the throw was the first statement */ }
          // 400, not 500: every throw in recordVerification is a refused input — an unknown outcome, an
          // uncounted multi-unit row, a missing actor — and each message says what to send instead.
          return send(res, 400, { error: String(e?.message || e) });
        }
      }

      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'no such verification route: ' + p }));
    } catch (e) {
      return send(res, 500, { error: String(e?.message || e) });
    }
  };
}

export function verificationPlugin() {
  return {
    name: 'verification',
    configureServer(server) {
      const db = openDb();
      server.middlewares.use('/api/verification', makeRouter({ db }));
      console.log('[verification] DB ' + DB_PATH + ' · API /api/verification');
    },
  };
}
