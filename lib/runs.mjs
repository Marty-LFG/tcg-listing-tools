// lib/runs.mjs — the Keeper's Runs internal API: /api/runs.
//
// A Vite dev-server plugin, per Golden Rule 1 — there is no production backend, so every server route
// in this repo is a plugin registered in vite.config.js.
//
// WHAT A RUN IS. A numbered, fixed-size edition of physically identical mystery bundles, sold at one
// price. Before anything sells, the exact contents of every bundle are hashed into a Merkle tree whose
// root is timestamped into Bitcoin; a buyer can later check that their own parcel matches what was
// committed. The whole product rests on that commitment being made BEFORE the first sale, which is why
// this module's job is to bind specific physical objects to specific bundle numbers and then refuse to
// let anything else touch them. See docs/RUNS_PLAN.md.
//
// THE BOUNDARY IN THIS FILE. Two kinds of route live here and they are deliberately not interleaved:
//
//   OPEN     the run's shape, its counts, what stock is free to assign, and the reservation writes.
//            None of it says which card is in which bundle.
//   GATED    /:id/manifest, which does. It is the pre-sale answer sheet — anyone holding it knows
//            which numbered bundle has the chase before a single one is sold. Everything else in this
//            app on the private network is commercial data; this one is the product, so it sits behind
//            the same DIAG_TOKEN check as the diagnostics routes. Salt and verification-code routes
//            will join it when lockRun mints them (R2-3).
//
// The gate is an OPERATIONAL control, not an auditable boundary — §8.11 of the plan says so plainly.
// It says nothing about transport, insiders, host compromise or backups. It stops a guest on the shop
// wifi reading the answer sheet; it does not make this data safe.
//
// NO LOCK, NO PUBLISH, NO ANCHOR HERE YET. Those are R2. This is the foundation: create a run, declare
// its composition, materialise its bundles, hold stock, assign it. Every write goes through
// lib/runs-reserve.mjs rather than touching run_reservations directly, so the state vocabulary stays
// single-source (test/invariants/runs-reservation-guards.test.mjs enforces that).
import { openDb } from './db.mjs';
import { diagTokenCheck } from './status.mjs';
import { ensureRunsConfigSeeded, loadRunsConfig } from './runs-config.mjs';
import { rarityTable, rarityClass } from './runs-rarity.mjs';
import { languageTable } from './runs-language.mjs';
import { CLAIM_TYPES, validateClaims, evaluateClaims, canonicalClaims, claimsCanonical } from './runs-claims.mjs';
import { generateGuarantee } from './runs-guarantee.mjs';
import { deal as dealStock, feasible as dealFeasible, STRATEGIES } from './runs-deal.mjs';
import { amendments, currentHeader, appendAmendment, verifyChain, assignSealSerials, sealSerialStatus } from './runs-amend.mjs';
import { checkPick } from './runs-pick.mjs';
import { STOCK_GAMES } from './normalize.mjs';
import { TYPES_BY_GAME, PRODUCT_TYPES } from './sealed.mjs';
import {
  liveReservation, reservedUnits, onHandUnits, availableUnits, channelHoldFor,
  holdForRun, assignToSlot, releaseReservation, abandonRun, devRunHoldings, audit,
  reservationRun, boundUnits, poolHolds, boundLines, splitToSlots,
} from './runs-reserve.mjs';

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
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

// The bearer token, read the same two ways lib/status.mjs reads it so an operator who already has curl
// working against the diagnostics routes does not have to learn a second convention.
function bearer(req, url) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || '');
  return (m && m[1]) || url.searchParams.get('token') || '';
}

const pad3 = (n) => String(n).padStart(3, '0');

// Slot names become ATTRIBUTE NAMES inside the hash (`slot.<slot>.<i>.<field>`), so the grammar is
// tight on purpose: ASCII, lowercase, and nothing that could collide with the dotted attribute path.
const SLOT_RE = /^[a-z0-9_]{1,32}$/;
// Run identifiers end up inside headerDigest and on printed inserts. Same reasoning.
const PUBLIC_ID_RE = /^[A-Z0-9-]{1,24}$/;

// --- reads -----------------------------------------------------------------------------------------

// unit_price_cents is the schema's only money column and it is deliberately absent from this list.
// Nothing this API serves needs it, and a column that is never selected cannot be leaked by a caller
// that forgets to filter — the same reasoning the public views are built on.
const RUN_COLS = `id, public_id, edition, name, mode, unit_count, status, currency, locked_at,
                  run_root, header_digest, canon_version, guarantee_text, close_by, sales_close_at,
                  shopify_sku, notes, created_at, updated_at`;

function runByIdOrPublicId(db, key) {
  const k = String(key);
  return /^\d+$/.test(k)
    ? db.prepare(`SELECT ${RUN_COLS} FROM runs WHERE id = ?`).get(+k)
    : db.prepare(`SELECT ${RUN_COLS} FROM runs WHERE public_id = ?`).get(k);
}

const ladderRows = (db, runId) =>
  db.prepare(`SELECT id, rank, card_name, set_code, card_number, language, grading_company, grade
                FROM run_chase_tiers WHERE run_id = ? ORDER BY rank`).all(runId);

const specsFor = (db, runId) =>
  db.prepare('SELECT * FROM run_slot_specs WHERE run_id = ? ORDER BY sort_order').all(runId);

// Bundle rows WITHOUT their secrets. salt_hex and verify_code are bearer secrets and seal_serial
// addresses a parcel, so none of the three is selected here even though this route is internal.
const bundlesFor = (db, runId) =>
  db.prepare(`SELECT id, bundle_no, label, is_chase, pinned, status, leaf_hash,
                     insert_printed_at, packed_at, sold_at, shipped_at
                FROM run_bundles WHERE run_id = ? ORDER BY bundle_no`).all(runId);

// How full is the manifest? One entry per bundle with what is bound against what the spec wants, which
// is the work queue the grid renders. Counts only — no card identities — so this stays open.
function fillFor(db, runId) {
  const specs = specsFor(db, runId);
  const by = new Map(boundUnits(db, runId).map((b) => [`${b.bundle_id}/${b.slot}`, b.qty]));
  return bundlesFor(db, runId).map((b) => {
    const slots = {};
    for (const s of specs) {
      const have = by.get(`${b.id}/${s.slot}`) || 0;
      slots[s.slot] = { want: s.qty_per_bundle, have, complete: have === s.qty_per_bundle };
    }
    return {
      bundle_id: b.id, bundle_no: b.bundle_no, label: b.label, pinned: !!b.pinned, slots,
      complete: specs.every((s) => (by.get(`${b.id}/${s.slot}`) || 0) === s.qty_per_bundle),
    };
  });
}

// --- claims ------------------------------------------------------------------------------------------
//
// run_claims carries a `field` column AND the composed `value`. That is deliberate denormalisation, the
// same trade shopify_listings.identity_handle makes: `value` is the canonical claim value every other
// claim type uses, so nothing downstream needs a special case for field_mix, while `field` stays
// queryable for the UI. ONE writer composes them, and a read asserts they still agree — the pattern this
// repo uses wherever a copy could drift.
const MIX_SEP = '=';

function claimRows(db, runId) {
  const rows = db.prepare(`SELECT id, claim_type, subject, operator, field, value, published, sort_order
                             FROM run_claims WHERE run_id = ? ORDER BY sort_order, id`).all(+runId);
  for (const r of rows) {
    if (r.claim_type !== 'field_mix') continue;
    const at = String(r.value).indexOf(MIX_SEP);
    const inValue = at < 0 ? null : String(r.value).slice(0, at);
    if (inValue !== r.field) {
      throw new Error(`claim ${r.id} has field "${r.field}" in its column and "${inValue}" inside its value; `
        + 'the two are written together and must never disagree, because only one of them is hashed');
    }
  }
  return rows;
}

const publishedClaims = (db, runId) => claimRows(db, runId).filter((c) => c.published);

// The manifest the evaluators read, built from the DRAFT bindings. Before lock nothing is frozen, so
// every field comes live off the stock row — which is the point: the guarantee panel has to refuse a
// non-conforming card while there is still time to swap it.
//
// The SAME shape is produced at close from opened attribute values, which is why the evaluators take a
// manifest rather than a database handle.
function draftManifest(db, run) {
  const specs = specsFor(db, run.id);
  const byBundle = new Map();
  for (const b of bundlesFor(db, run.id)) byBundle.set(b.id, { no: b.bundle_no, label: b.label, lines: {} });
  for (const spec of specs) for (const b of byBundle.values()) b.lines[spec.slot] = [];
  for (const line of boundLines(db, run.id)) {
    const b = byBundle.get(line.bundle_id);
    if (!b || !b.lines[line.slot]) continue;
    b.lines[line.slot].push({
      kind: line.kind, display_name: line.display_name || '', game: line.game || '',
      identity_key: line.identity_key || '', set_code: line.set_code || '',
      card_number: line.card_number || '', rarity: line.rarity || '',
      language: line.language || '', finish: line.finish || '',
      product_type: line.product_type || '', upc: line.upc || '',
      grading_company: line.grading_company || '', grade: line.grade == null ? '' : String(line.grade),
      cert_number: line.cert_number || '', qty: String(line.qty),
    });
  }
  return { specs, bundles: [...byBundle.values()].sort((a, b) => a.no - b.no) };
}

// --- the router ------------------------------------------------------------------------------------

export function makeRunsRouter({ env, db }) {
  return async (req, res, next) => {
    try {
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type,authorization');
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const q = url.searchParams;
      let m;

      // ---- fleet-wide reads. Literal paths FIRST, so none of them is ever read as a run id. ----

      // GET /config — what this module is armed to do. Comment keys are already stripped.
      if (p === '/config' && method === 'GET') return send(res, 200, loadRunsConfig());

      // GET /rarity — the committed rarity vocabulary, and optionally what a source string maps to.
      // Open, because this table is published with every run's commitment before anything sells: it
      // has to be public for a buyer to check that the guarantee means what they think it means.
      if (p === '/rarity' && method === 'GET') {
        const table = await rarityTable();
        const probe = q.get('q');
        if (probe == null) return send(res, 200, table);
        // A deliberate null rather than an omitted key. An unmapped rarity satisfies no claim and fails
        // the lock closed, so the caller must be able to tell "not in the table" from "not asked".
        return send(res, 200, { ...table, query: probe, class: rarityClass(probe) });
      }

      // GET /vocab — the closed lists the intake page has to render: which games stock can be, which
      // sealed product types belong to each, and the rarity table. Served rather than restated in the
      // page, because a browser copy of any of these is a copy that drifts — sealed.html already keeps
      // its own TYPES_BY_GAME and that is the mistake not to repeat here.
      if (p === '/vocab' && method === 'GET') {
        return send(res, 200, {
          games: STOCK_GAMES,
          sealed_types: PRODUCT_TYPES,
          sealed_types_by_game: TYPES_BY_GAME,
          rarity: await rarityTable(),
          language: languageTable(),
        });
      }

      // POST /hold { kind, item_id, qty } — hold stock for RUNS IN GENERAL, before any run exists.
      //
      // The flag applied at intake, and the top of a three-step promotion: held for runs, then held for
      // THIS run, then bound to THIS slot. Every step is an UPDATE of the same row rather than a new
      // one, which is what keeps the one-live-reservation index meaningful throughout. It blocks
      // publishing and selling exactly as a slot binding does — there is no weaker kind of hold.
      if (p === '/hold' && method === 'POST') {
        const b = await readJson(req);
        if (b.item_id == null) return send(res, 400, { error: 'item_id required' });
        return send(res, 201, holdForRun(db, {
          kind: b.kind, itemId: +b.item_id, runId: null,
          qty: b.qty == null ? 1 : Math.round(+b.qty), actor: b.actor || null,
        }));
      }

      // GET /holdings — stock that DEV rehearsal runs are sitting on. A dev run's reservations are
      // real and block real listings (a guard with an escape hatch is not a guard), so the only thing
      // that makes rehearsing against live stock safe is being able to see what it has taken.
      if (p === '/holdings' && method === 'GET') {
        const rows = devRunHoldings(db);
        return send(res, 200, { holdings: rows, units: rows.reduce((n, r) => n + (r.units || 0), 0) });
      }

      // GET / — every run, newest first, with its fill progress summarised.
      if (p === '/' && method === 'GET') {
        const runs = db.prepare(`SELECT ${RUN_COLS} FROM runs ORDER BY id DESC`).all();
        return send(res, 200, {
          runs: runs.map((r) => {
            const fill = fillFor(db, r.id);
            return { ...r, bundles: fill.length, complete: fill.filter((b) => b.complete).length };
          }),
        });
      }

      // POST / — create a run, its composition and its bundles, in one transaction.
      //
      // unit_count and the slot specs are fixed here and immutable after lock, because both are inside
      // the hash. Changing either is a different run, not an edit.
      if (p === '/' && method === 'POST') {
        const b = await readJson(req);
        const publicId = String(b.public_id || '').trim();
        const mode = b.mode === 'live' ? 'live' : 'dev';        // dev unless someone says otherwise
        const unitCount = Math.round(+b.unit_count);
        if (!PUBLIC_ID_RE.test(publicId)) return send(res, 400, { error: 'public_id must be 1–24 characters of A–Z, 0–9 and -' });
        // The database enforces this too — a CHECK ties mode to the prefix, so the two can never drift
        // in stored data. Saying it here as well turns a constraint failure into a sentence.
        if (mode === 'dev' && !publicId.startsWith('DEV-')) return send(res, 400, { error: "a dev run's public_id must start with DEV-" });
        if (mode === 'live' && publicId.startsWith('DEV-')) return send(res, 400, { error: "a live run's public_id must not start with DEV-" });
        if (!(unitCount >= 1 && unitCount <= 999)) return send(res, 400, { error: 'unit_count must be 1–999' });
        if (!String(b.name || '').trim()) return send(res, 400, { error: 'name is required' });

        const slots = Array.isArray(b.slots) ? b.slots : [];
        if (!slots.length) return send(res, 400, { error: 'slots (non-empty array) required — a run declares its own composition' });
        const seen = new Set();
        for (const s of slots) {
          const name = String(s.slot || '');
          if (!SLOT_RE.test(name)) return send(res, 400, { error: `slot "${name}" must be 1–32 characters of a–z, 0–9 and _ — slot names become attribute names inside the hash` });
          if (seen.has(name)) return send(res, 400, { error: `slot "${name}" declared twice` });
          seen.add(name);
          if (!String(s.label || '').trim()) return send(res, 400, { error: `slot "${name}" needs a label` });
          if (s.kind !== 'inventory' && s.kind !== 'sealed') return send(res, 400, { error: `slot "${name}": kind must be inventory or sealed` });
          const qty = Math.round(+s.qty_per_bundle);
          if (!(qty >= 1)) return send(res, 400, { error: `slot "${name}": qty_per_bundle must be at least 1` });
          if (s.singleton && qty !== 1) return send(res, 400, { error: `slot "${name}": a singleton slot is one physical object, so qty_per_bundle must be 1` });
          const maxLines = s.max_lines == null ? qty : Math.round(+s.max_lines);
          if (!(maxLines >= qty && maxLines <= 99)) return send(res, 400, { error: `slot "${name}": max_lines must be between qty_per_bundle and 99` });
        }
        // A chase REPLACES the base item rather than adding to it — that is what keeps every parcel the
        // same weight and thickness, so a bundle cannot be identified by feel at a show table. Exactly
        // one slot is where that replacement happens.
        const chase = slots.filter((s) => s.is_chase_slot).length;
        if (chase !== 1) return send(res, 400, { error: `exactly one slot must be is_chase_slot; ${chase} were` });

        db.exec('BEGIN');
        try {
          db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, unit_price_cents,
                                        currency, close_by, sales_close_at, unsold_policy, notes)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(publicId, Math.round(+b.edition) || 1, String(b.name).trim(), mode, unitCount,
              b.unit_price_cents == null ? null : Math.round(+b.unit_price_cents),
              String(b.currency || 'AUD'), b.close_by || null, b.sales_close_at || null,
              b.unsold_policy || null, b.notes || null);
          const runId = db.prepare('SELECT last_insert_rowid() id').get().id;

          const insSpec = db.prepare(`INSERT INTO run_slot_specs
            (run_id, slot, label, kind, qty_per_bundle, max_lines, singleton, requires_cert, is_chase_slot, sort_order)
            VALUES (?,?,?,?,?,?,?,?,?,?)`);
          slots.forEach((s, i) => {
            const qty = Math.round(+s.qty_per_bundle);
            insSpec.run(runId, String(s.slot), String(s.label).trim(), s.kind, qty,
              s.max_lines == null ? qty : Math.round(+s.max_lines),
              s.singleton ? 1 : 0, s.requires_cert ? 1 : 0, s.is_chase_slot ? 1 : 0, i);
          });

          const insBundle = db.prepare('INSERT INTO run_bundles (run_id, bundle_no, label) VALUES (?,?,?)');
          for (let n = 1; n <= unitCount; n++) insBundle.run(runId, n, `${publicId}-${pad3(n)}`);

          audit(db, {
            runId, entity: 'runs', entityId: runId, action: 'create', actor: b.actor || null,
            after: { public_id: publicId, mode, unit_count: unitCount, slots: slots.map((s) => s.slot) },
          });
          db.exec('COMMIT');
          return send(res, 201, { run: runByIdOrPublicId(db, runId), slots: specsFor(db, runId), bundles: unitCount });
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      }

      // ---- reservation writes. Also before /:id, so 'reservations' is never read as a run id. ----

      // POST /:id/pick/:no { images } — cross-check a photographed bundle against its manifest.
      //
      // GATED, and for the usual reason: the response names the certs this bundle should contain, which
      // is the pre-sale answer sheet. The bench operator enters the token once.
      //
      // ADVISORY, ALWAYS. Nothing here writes: the model reads what is in the photograph, the code
      // compares, and a human decides. A vision model misreads digits and a cert is eight of them, so a
      // false pass would be worse than no check at all.
      //
      // DRAFT ONLY. Finding a wrong card here is a manifest edit; finding it after lock is an amendment,
      // a new root and a new anchor. Checking before the lock is the entire point of this step.
      if ((m = p.match(/^\/([A-Za-z0-9-]+)\/pick\/(\d+)$/)) && method === 'POST') {
        const target = runByIdOrPublicId(db, m[1]);
        if (!target) return send(res, 404, { error: 'no such run: ' + m[1] });
        const auth = diagTokenCheck(env, bearer(req, url));
        if (!auth.ok) return send(res, auth.code, { error: auth.error, code: 'manifest_gated' });
        if (target.status !== 'draft') {
          return send(res, 409, { code: 'not_draft', error: `run ${target.public_id} is ${target.status}; a picked bundle is checked while the manifest can still be edited` });
        }
        const bundle = db.prepare('SELECT id, label FROM run_bundles WHERE run_id = ? AND bundle_no = ?').get(target.id, +m[2]);
        if (!bundle) return send(res, 404, { error: `no bundle ${m[2]} in ${target.public_id}` });
        const b = await readJson(req);
        const expected = boundLines(db, target.id).filter((l) => l.bundle_id === bundle.id);
        if (!expected.length) return send(res, 409, { code: 'nothing_bound', error: `${bundle.label} has nothing assigned to it yet` });
        const out = await checkPick({
          bundleLabel: bundle.label,
          slots: specsFor(db, target.id).map((x) => x.slot),
          expected, images: Array.isArray(b.images) ? b.images : [], env,
        });
        // Recorded as an OBSERVATION. The photo itself is never stored here and never published: a
        // picture of a laid-out bundle is a complete pre-sale disclosure of it.
        audit(db, { runId: target.id, bundleId: bundle.id, entity: 'run_bundles', entityId: bundle.id,
          action: 'pick_checked', actor: b.actor || null,
          note: out.ok ? (out.clean ? 'nothing raised' : `${out.findings.length} finding(s) for a human`) : `check did not run: ${out.message}` });
        return send(res, 200, { bundle: bundle.label, ...out });
      }

      // PATCH /:id/bundles/:no { pinned } — the god bundle.
      //
      // Three path segments, so it lives HERE rather than with the per-run routes: that matcher handles
      // /:id and /:id/thing only, and a route it cannot reach is a route nobody can call.
      //
      // A pinned bundle is EXCLUDED from lock-time chase randomisation and keeps exactly what was assigned
      // to it, which is what lets one bundle hold the best option in every slot at once. Correlation
      // becomes publicly derivable at close whichever strategy is used, so this is a build-time decision
      // rather than a claim — committing it would create a rule we could break.
      if ((m = p.match(/^\/([A-Za-z0-9-]+)\/bundles\/(\d+)$/)) && method === 'PATCH') {
        const target = runByIdOrPublicId(db, m[1]);
        if (!target) return send(res, 404, { error: 'no such run: ' + m[1] });
        if (target.status !== 'draft') return send(res, 409, { error: `run ${target.public_id} is ${target.status}`, code: 'not_draft' });
        const b = await readJson(req);
        const row = db.prepare('SELECT id FROM run_bundles WHERE run_id = ? AND bundle_no = ?').get(target.id, +m[2]);
        if (!row) return send(res, 404, { error: `no bundle ${m[2]} in ${target.public_id}` });
        db.prepare(`UPDATE run_bundles SET pinned = ?, updated_at = datetime('now') WHERE id = ?`).run(b.pinned ? 1 : 0, row.id);
        audit(db, { runId: target.id, bundleId: row.id, entity: 'run_bundles', entityId: row.id,
          action: b.pinned ? 'pin' : 'unpin', actor: b.actor || null });
        return send(res, 200, { run: target.public_id, bundle_no: +m[2], pinned: !!b.pinned });
      }

      // POST /reservations/:id/assign { bundle_no | bundle_id, slot } — promote a pool hold onto a slot.
      if ((m = p.match(/^\/reservations\/(\d+)\/assign$/)) && method === 'POST') {
        const b = await readJson(req);
        const rid = +m[1];
        let bundleId = b.bundle_id == null ? null : +b.bundle_id;
        if (bundleId == null) {
          // bundle_no is what a human reads off the grid; bundle_id is what the UI already has. Accept
          // either — but resolving a bundle_no needs the run, which comes off the reservation.
          const held = reservationRun(db, rid);
          if (!held) return send(res, 404, { error: 'no such reservation: ' + rid });
          if (held.run_id == null) return send(res, 400, { error: 'bundle_id required — this reservation is not held for a specific run yet' });
          const row = db.prepare('SELECT id FROM run_bundles WHERE run_id = ? AND bundle_no = ?').get(held.run_id, Math.round(+b.bundle_no));
          if (!row) return send(res, 404, { error: `no bundle ${b.bundle_no} in that run` });
          bundleId = row.id;
        }
        return send(res, 200, assignToSlot(db, { reservationId: rid, bundleId, slot: String(b.slot || ''), actor: b.actor || null }));
      }

      // POST /reservations/:id/release — free the stock. Only while the run is still a draft: after
      // lock a reservation is committed, and only an amendment moves it.
      if ((m = p.match(/^\/reservations\/(\d+)\/release$/)) && method === 'POST') {
        const b = await readJson(req);
        return send(res, 200, releaseReservation(db, +m[1], b.reason || null, b.actor || null));
      }

      // ---- per-run routes ----

      const runM = p.match(/^\/([A-Za-z0-9-]+)(\/[a-z-]+)?$/);
      const run = runM ? runByIdOrPublicId(db, runM[1]) : null;
      if (runM && !run) return send(res, 404, { error: 'no such run: ' + runM[1] });
      const tail = runM ? (runM[2] || '') : null;

      // GET /:id — the run, its composition and its fill state. NOT its contents.
      if (run && tail === '' && method === 'GET') {
        return send(res, 200, { run, slots: specsFor(db, run.id), bundles: bundlesFor(db, run.id), fill: fillFor(db, run.id) });
      }

      // GET /:id/manifest — GATED. Which card is in which numbered bundle: the pre-sale answer sheet.
      if (run && tail === '/manifest' && method === 'GET') {
        const auth = diagTokenCheck(env, bearer(req, url));
        if (!auth.ok) return send(res, auth.code, { error: auth.error, code: 'manifest_gated' });
        const lines = boundLines(db, run.id);
        return send(res, 200, { run, slots: specsFor(db, run.id), lines, frozen: !!run.locked_at });
      }

      // GET /:id/pool — held for this run, no slot yet. The pool panel: claim stock first, arrange it
      // second, which is how a manifest actually gets built.
      if (run && tail === '/pool' && method === 'GET') {
        const pool = poolHolds(db, run.id);
        return send(res, 200, { pool });
      }

      // GET /:id/candidates?slot=&q=&limit= — stock this slot could take. Filtered by the SPEC's rules
      // rather than by the slot's name, which is what makes a differently-shaped edition a config
      // change: a slot is singleton or it is not, it requires a cert or it does not, and its candidates
      // come from whichever stock table its kind names.
      if (run && tail === '/candidates' && method === 'GET') {
        const slot = String(q.get('slot') || '');
        const spec = db.prepare('SELECT * FROM run_slot_specs WHERE run_id = ? AND slot = ?').get(run.id, slot);
        if (!spec) {
          return send(res, 404, { error: `run ${run.public_id} declares no slot named '${slot}'`, slots: specsFor(db, run.id).map((s) => s.slot) });
        }
        const limit = Math.min(500, Math.max(1, Math.round(+q.get('limit') || 200)));
        const term = String(q.get('q') || '').trim();
        const like = term ? [`%${term}%`, `%${term}%`, `%${term}%`] : [];

        const rows = spec.kind === 'inventory'
          ? db.prepare(`SELECT id, sku, name AS display_name, game, identity_key, set_name,
                               number AS card_number, rarity, variant AS finish, language,
                               grading_company, grade, cert_number, quantity, status
                          FROM inventory_items
                         WHERE status IN ('in_stock','listed')
                           ${spec.singleton ? 'AND quantity = 1' : 'AND quantity >= 1'}
                           ${spec.requires_cert ? "AND cert_number IS NOT NULL AND cert_number <> ''" : ''}
                           ${term ? 'AND (name LIKE ? OR cert_number LIKE ? OR sku LIKE ?)' : ''}
                         ORDER BY id DESC LIMIT ?`).all(...like, limit)
          : db.prepare(`SELECT id, sku, name AS display_name, game, set_code, set_name, language,
                               product_type, upc, quantity, status
                          FROM sealed_items
                         WHERE status IN ('in_stock','listed')
                           ${term ? 'AND (name LIKE ? OR sku LIKE ? OR upc LIKE ?)' : ''}
                         ORDER BY id DESC LIMIT ?`).all(...like, limit);

        // Availability is answered per row rather than filtered in SQL, because the sealed answer is a
        // COUNT — one sealed row legitimately supplies both a run and the shop — while the inventory
        // answer is a yes or a no. Same list, two different meanings of "free", and the operator needs
        // to see the taken ones anyway to know who took them.
        const candidates = rows.map((r) => {
          const held = spec.kind === 'inventory' ? liveReservation(db, 'inventory', r.id) : null;
          return {
            ...r,
            available: spec.kind === 'inventory' ? (held ? 0 : 1) : availableUnits(db, 'sealed', r.id),
            reserved_units: spec.kind === 'sealed' ? reservedUnits(db, 'sealed', r.id) : (held ? 1 : 0),
            on_hand: onHandUnits(db, spec.kind, r.id),
            reserved_by: held
              ? { reservation_id: held.id, run: held.run_public_id || null, bundle: held.bundle_label || null }
              : null,
            // Live on a channel right now. Not a refusal — lockRun is what refuses — but the operator
            // needs to know a withdrawal is coming before building a manifest around it.
            channel_hold: channelHoldFor(db, spec.kind, r.id),
          };
        });
        return send(res, 200, { slot: spec, candidates });
      }

      // GET /:id/claims — the structured claim set. Open: a claim is published with the commitment.
      if (run && tail === '/claims' && method === 'GET') {
        const claims = claimRows(db, run.id);
        return send(res, 200, {
          claims,
          vocabulary: CLAIM_TYPES,
          canonical: claimsCanonical(claims.filter((c) => c.published)),
          validation: validateClaims(claims.filter((c) => c.published), specsFor(db, run.id)),
        });
      }

      // PUT /:id/claims { claims: [...] } — replace the set. Whole-set replacement rather than per-claim
      // edits, because (claim_type, subject) uniqueness and the language/packs_language rule are
      // properties of the SET; validating one claim at a time cannot see them.
      if (run && tail === '/claims' && method === 'PUT') {
        if (run.status !== 'draft') return send(res, 409, { error: `run ${run.public_id} is ${run.status}; its claims are committed`, code: 'not_draft' });
        const b = await readJson(req);
        const incoming = (Array.isArray(b.claims) ? b.claims : []).map((c, i) => {
          const type = String(c.claim_type || '');
          const field = c.field == null ? null : String(c.field);
          // ONE PLACE composes the two representations.
          const value = type === 'field_mix' && field && !String(c.value).includes(MIX_SEP)
            ? `${field}${MIX_SEP}${c.value}` : String(c.value ?? '');
          return { claim_type: type, subject: String(c.subject || ''), operator: String(c.operator || ''),
            field: type === 'field_mix' ? (field || String(value).split(MIX_SEP)[0]) : null,
            value, published: c.published === false ? 0 : 1, sort_order: i };
        });
        const specs = specsFor(db, run.id);
        const v = validateClaims(incoming.filter((c) => c.published), specs);
        if (!v.ok) return send(res, 400, { error: v.errors.join('; '), errors: v.errors, code: 'bad_claims' });

        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM run_claims WHERE run_id = ?').run(run.id);
          const ins = db.prepare(`INSERT INTO run_claims (run_id, claim_type, subject, operator, field, value, published, sort_order)
                                  VALUES (?,?,?,?,?,?,?,?)`);
          for (const c of incoming) ins.run(run.id, c.claim_type, c.subject, c.operator, c.field, c.value, c.published, c.sort_order);
          audit(db, { runId: run.id, entity: 'run_claims', action: 'replace', actor: b.actor || null,
            after: { claims: incoming.map((c) => `${c.claim_type} ${c.subject} ${c.operator} ${c.value}`) } });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return send(res, 200, { claims: claimRows(db, run.id) });
      }

      // GET /:id/guarantee — THE PANEL THIS PAGE EXISTS FOR. Evaluates every published claim over the
      // draft manifest and renders the sentence they generate.
      //
      // SPLIT BY SENSITIVITY rather than gated whole. The sentence and which claims hold are things the
      // run publishes anyway; the COUNTEREXAMPLES name a bundle and a cert, which is the pre-sale answer
      // sheet. So the counts come back ungated and the offending cards need the token.
      if (run && tail === '/guarantee' && method === 'GET') {
        const specs = specsFor(db, run.id);
        const claims = publishedClaims(db, run.id);
        const manifest = draftManifest(db, run);
        const evaluated = evaluateClaims(claims, manifest, specs);

        let sentence = null, sentenceError = null;
        try { sentence = generateGuarantee({ specs, claims: canonicalClaims(claims), unitCount: run.unit_count }); }
        catch (e) { sentenceError = String(e?.message || e); }

        const detailed = diagTokenCheck(env, bearer(req, url)).ok;
        return send(res, 200, {
          holds: evaluated.holds,
          sentence,
          sentence_error: sentenceError,
          detail: detailed,
          results: evaluated.results.map((r) => ({
            claim: r.claim, holds: r.holds, deferred: !!r.deferred, error: r.error || null,
            counterexample_count: r.counterexamples.length,
            counterexamples: detailed ? r.counterexamples.slice(0, 50) : undefined,
          })),
        });
      }

      // GET /:id/ladder — the chase ladder. Published in the commitment BEFORE any sale, which is what
      // makes `is_chase` a claim about a pre-committed definition rather than one we could reinterpret.
      if (run && tail === '/ladder' && method === 'GET') {
        return send(res, 200, { ladder: ladderRows(db, run.id) });
      }

      // PUT /:id/ladder { ladder: [...] } — replace it. Ranks are renumbered from 1 on write, because
      // §5.1 requires them unique and contiguous and a gap would be a hash the verifier cannot rebuild.
      if (run && tail === '/ladder' && method === 'PUT') {
        if (run.status !== 'draft') return send(res, 409, { error: `run ${run.public_id} is ${run.status}; its ladder is committed`, code: 'not_draft' });
        const b = await readJson(req);
        const rows = Array.isArray(b.ladder) ? b.ladder : [];
        for (const r of rows) if (!String(r.card_name || '').trim()) return send(res, 400, { error: 'every ladder entry needs a card name' });
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM run_chase_tiers WHERE run_id = ?').run(run.id);
          const ins = db.prepare(`INSERT INTO run_chase_tiers (run_id, rank, card_name, set_code, card_number, language, grading_company, grade)
                                  VALUES (?,?,?,?,?,?,?,?)`);
          rows.forEach((r, i) => ins.run(run.id, i + 1, String(r.card_name).trim(), r.set_code || null,
            r.card_number || null, r.language || null, r.grading_company || null,
            r.grade == null || r.grade === '' ? null : String(r.grade)));
          audit(db, { runId: run.id, entity: 'run_chase_tiers', action: 'replace', actor: b.actor || null,
            after: { ranks: rows.length } });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return send(res, 200, { ladder: ladderRows(db, run.id) });
      }

      // POST /:id/deal { slot, strategy } — deal this slot's pool across every bundle.
      //
      // The strategies are genuinely different products, not implementation detail: `distinct` promises
      // three different sets, `shuffle` promises three packs drawn at random. Infeasible stock is refused
      // WITH the reason, before anything is assigned — never a silent partial deal.
      if (run && tail === '/deal' && method === 'POST') {
        if (run.status !== 'draft') return send(res, 409, { error: `run ${run.public_id} is ${run.status}; the manifest is no longer editable`, code: 'not_draft' });
        const b = await readJson(req);
        const slot = String(b.slot || '');
        const strategy = String(b.strategy || 'shuffle');
        const spec = db.prepare('SELECT * FROM run_slot_specs WHERE run_id = ? AND slot = ?').get(run.id, slot);
        if (!spec) return send(res, 404, { error: `run ${run.public_id} declares no slot named '${slot}'` });
        if (!STRATEGIES.includes(strategy)) return send(res, 400, { error: `unknown strategy "${strategy}"`, strategies: STRATEGIES });

        // WHICH HOLDS FEED THIS SLOT. A pool hold has no slot — the schema forbids it, because
        // `bundle_id` and `slot` are set or null together, which is what keeps the three reservation
        // states clean. So a run with two inventory slots (a slab and an art card) has one undivided
        // pool of inventory holds, and the deal cannot guess which are which.
        //
        // The operator says. `reservation_ids` is how the pool panel sends a selection; without it the
        // deal takes every hold of the right kind, which is correct and unambiguous only when the run
        // declares ONE slot of that kind. Otherwise it refuses and names the slots that collide, rather
        // than dealing art cards into the slab slot because both are 'inventory'.
        const wanted = Array.isArray(b.reservation_ids) ? b.reservation_ids.map(Number) : null;
        const sameKind = specsFor(db, run.id).filter((x) => x.kind === spec.kind);
        if (!wanted && sameKind.length > 1) {
          return send(res, 409, {
            code: 'ambiguous_pool',
            error: `this run has ${sameKind.length} ${spec.kind} slots (${sameKind.map((x) => x.slot).join(', ')}), `
              + 'so a pool hold could belong to any of them — send reservation_ids to say which feed this slot',
            slots: sameKind.map((x) => x.slot),
          });
        }
        const pool = poolHolds(db, run.id)
          .filter((h) => h.kind === spec.kind)
          .filter((h) => !wanted || wanted.includes(h.reservation_id));
        if (wanted) {
          const missing = wanted.filter((id) => !pool.some((h) => h.reservation_id === id));
          if (missing.length) {
            return send(res, 404, { error: `reservation(s) ${missing.join(', ')} are not an unassigned ${spec.kind} hold on this run`, code: 'not_in_pool' });
          }
        }
        const bundles = bundlesFor(db, run.id);
        const quota = spec.qty_per_bundle;
        const check = dealFeasible(strategy, pool.map((h) => h.qty), bundles.length, quota);
        if (!check.ok) return send(res, 409, { error: check.reason, code: 'not_dealable', held: pool.length, units: pool.reduce((n, h) => n + h.qty, 0), needed: bundles.length * quota });
        if (strategy === 'pinned') return send(res, 200, { dealt: 0, pinned: true, message: 'pinned slots are assigned by hand' });

        const hands = dealStock(strategy, pool.map((h) => ({ id: h.reservation_id, qty: h.qty, kind: h.kind })), bundles.length, quota).deals;

        // The deal names RESERVATIONS, and turning that into bindings differs by kind. An inventory hold
        // is one object and is promoted in place; a sealed hold is split into one bound row per bundle.
        const perReservation = new Map();
        hands.forEach((hand, i) => {
          for (const unit of hand) {
            if (!perReservation.has(unit.id)) perReservation.set(unit.id, []);
            perReservation.get(unit.id).push(bundles[i].id);
          }
        });

        let assigned = 0;
        for (const [reservationId, bundleIds] of perReservation) {
          if (spec.kind === 'inventory') {
            assignToSlot(db, { reservationId, bundleId: bundleIds[0], slot, actor: b.actor || null });
            assigned++;
          } else {
            const byBundle = new Map();
            for (const id of bundleIds) byBundle.set(id, (byBundle.get(id) || 0) + 1);
            splitToSlots(db, reservationId, [...byBundle].map(([bundleId, qty]) => ({ bundleId, slot, qty })), { actor: b.actor || null });
            assigned += byBundle.size;
          }
        }
        return send(res, 200, { dealt: assigned, strategy, slot, bundles: bundles.length, fill: fillFor(db, run.id) });
      }

      // GET /:id/amendments — the chain, and whether it holds.
      //
      // Open. An amendment is PUBLISHED: a buyer verifying a bundle has to be able to see that its
      // contents changed after lock, and §10.5 goes further — an amended bundle may not render a plain
      // success state. Hiding the chain would defeat the mechanism.
      if (run && tail === '/amendments' && method === 'GET') {
        return send(res, 200, {
          amendments: amendments(db, run.id),
          head: currentHeader(db, run),
          chain: verifyChain(db, run),
        });
      }

      // POST /:id/amendments — append one. Never an update: the row it succeeds stays byte-identical.
      //
      // The new header is supplied rather than computed, because computing it means rebuilding the tree
      // and re-encrypting the affected blob entries under fresh nonces — R2-3's work. This route is the
      // ledger those will write through, built first so the append-only property is settled.
      if (run && tail === '/amendments' && method === 'POST') {
        const b = await readJson(req);
        return send(res, 201, appendAmendment(db, run, {
          reason: b.reason, newHeader: b.new_header,
          affectedBundles: Array.isArray(b.affected_bundles) ? b.affected_bundles : [],
          actor: b.actor || null, before: b.before ?? null, after: b.after ?? null,
        }));
      }

      // GET /:id/audit — every recorded action on this run, newest first.
      //
      // Deliberately WITHOUT before_json/after_json unless the caller holds the token. Those payloads
      // carry item ids and reservation states, which is manifest-shaped; the action, the actor and the
      // note are the operational record and are what an operator actually reads.
      if (run && tail === '/audit' && method === 'GET') {
        const detailed = diagTokenCheck(env, bearer(req, url)).ok;
        const limit = Math.min(500, Math.max(1, Math.round(+q.get('limit') || 200)));
        const rows = db.prepare(`SELECT a.id, a.entity, a.entity_id, a.action, a.actor, a.note, a.ts,
                                        a.before_json, a.after_json, b.label AS bundle
                                   FROM run_audit a
                              LEFT JOIN run_bundles b ON b.id = a.bundle_id
                                  WHERE a.run_id = ? ORDER BY a.id DESC LIMIT ?`).all(run.id, limit);
        return send(res, 200, {
          detail: detailed,
          audit: rows.map((r) => (detailed ? r : { ...r, before_json: undefined, after_json: undefined })),
        });
      }

      // GET /:id/seals — are the serials in place? The lock asks this.
      if (run && tail === '/seals' && method === 'GET') {
        return send(res, 200, sealSerialStatus(db, run));
      }

      // POST /:id/seals { roll: [...] } — pre-assign physical seals to bundle numbers, at random.
      //
      // BEFORE LOCK, because the serial is a committed attribute: it is inside the bundle's leaf and so
      // inside runRoot. That is the circular dependency the physical sequence resolves — the parcel is
      // sealed at step 7, but the serial has to be known at step 4.
      if (run && tail === '/seals' && method === 'POST') {
        const b = await readJson(req);
        return send(res, 200, assignSealSerials(db, run, Array.isArray(b.roll) ? b.roll : [], { actor: b.actor || null }));
      }

      // POST /:id/hold { kind, item_id, qty } — claim stock for this run, no slot yet.
      if (run && tail === '/hold' && method === 'POST') {
        const b = await readJson(req);
        if (b.item_id == null) return send(res, 400, { error: 'item_id required' });
        return send(res, 201, holdForRun(db, {
          kind: b.kind, itemId: +b.item_id, runId: run.id,
          qty: b.qty == null ? 1 : Math.round(+b.qty), actor: b.actor || null,
        }));
      }

      // POST /:id/abandon — release everything and mark the run dead. DEV ONLY, refused in
      // runs-reserve for a live run: there is no unpicking a published manifest, and an escape hatch
      // that exists where it could do harm is not a rehearsal aid.
      if (run && tail === '/abandon' && method === 'POST') {
        const b = await readJson(req);
        return send(res, 200, abandonRun(db, run.id, { actor: b.actor || null, reason: b.reason || null }));
      }

      return next();
    } catch (e) {
      // The reserve module throws sentences meant for a human — "only 2 of sealed item 41 are free",
      // "split it into single rows before holding it for a run". Those sentences are the whole value of
      // the refusal, so they are passed through rather than collapsed into 'internal error'. 409,
      // because every one of them is a conflict with the current state rather than a malformed request.
      const msg = String(e?.message || e);
      // A constraint failure here is not a bug, it is the last line of defence doing its job — the
      // partial unique indexes are what make "one live reservation per physical object" true even if
      // every check above them were wrong. So it reports as a conflict rather than a 500, and the
      // index name is kept: it says exactly which invariant was hit.
      const conflict = /constraint failed|reserved|already|only \d+|split it|no such|declares no slot|takes (sealed|inventory) stock|must be|cannot|only for dev|is (draft|locked|selling|shipped|closed|disclosed|abandoned)/i.test(msg);
      if (!conflict) console.warn('[runs]', msg);
      return send(res, conflict ? 409 : 500, { error: msg });
    }
  };
}

export function runsPlugin(env) {
  return {
    name: 'runs',
    configureServer(server) {
      ensureRunsConfigSeeded();
      const db = openDb();       // shared tracker.db — the reservation index must sit beside the stock
      server.middlewares.use('/api/runs', makeRunsRouter({ env, db }));
      const cfg = loadRunsConfig();
      const units = devRunHoldings(db).reduce((n, r) => n + (r.units || 0), 0);
      console.log('[runs] API /api/runs · publish '
        + (cfg.publish.enabled ? 'ARMED -> ' + cfg.publish.store : 'disarmed')
        + ' · anchor ' + cfg.anchor.mode
        + (units ? ' · dev runs holding ' + units + ' unit(s)' : ''));
    },
  };
}
