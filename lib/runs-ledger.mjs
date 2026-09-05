// lib/runs-ledger.mjs — §5.6.2: the committed sale ledger, and the availability it proves.
//
// WHAT THIS IS FOR. Buyer-choice introduces one steering vector the cryptography does not touch: LYING
// ABOUT AVAILABILITY. A buyer asks for 7, we want to keep 7, we say it is taken. The ledger closes that at
// no cost — every sale records the number chosen, so the available set at any moment is derivable by
// anyone from the anchored chain. A buyer told "7 is gone" can check that 7 really was sold to an earlier
// ordinal, and one shown a restricted set can compare it against what the chain says remained.
//
// ISOMORPHIC ABOVE THE LINE. Everything down to verifyChain is pure and takes arrays, so a buyer's page
// can rebuild and check the chain itself; the db-taking half sits below and never imports a database.
// Same split as lib/runs-disclose.mjs, for the same reason.
//
// `seq` MEANS SALE ORDINAL. It is 1-based over sale entries ONLY and is 0 for everything else,
// cancellations included — revision 4's vector used 3 on a cancel while its own prose said 0, and both
// reviewers caught it. Sale entries are never removed, so a number resold after a cancellation takes the
// next ordinal rather than reusing the old one.
//
// `ref` IS A RANDOM TOKEN, NOT A HASHED ORDER NUMBER. Revision 3 used SHA-256(order id) and called it
// privacy-preserving; storefront order numbers are short and sequential, so the preimage space is a few
// thousand values and anyone recovers ordinal to order number instantly.

import { ns, normalizeValue, sha256Prefixed, toHex } from './runs-canonical.mjs';
import { LEDGER_KINDS, DISPOSITIONS, accountsForBundle } from './runs-policy.mjs';
import { saleGate } from './runs-anchor.mjs';
import { audit } from './runs-reserve.mjs';

export { LEDGER_KINDS, DISPOSITIONS, accountsForBundle };
export const SALE_KINDS = Object.freeze(['sale_online', 'sale_in_person']);
export const ZERO_HASH = '0'.repeat(64);

/**
 * §5.6.5 detail grammar, AND A PLACE THE SPECIFICATION CONTRADICTS ITSELF.
 *
 * The prose says "keys and values are restricted to [A-Za-z0-9_.,=-]" — which excludes the space. Two of
 * its own six published vectors then use `run-wide price change` and `buyer requested refund`. The
 * vectors are what a conforming implementation has to reproduce, so they win, and the restriction is read
 * as governing the STRUCTURED form it actually describes: a semicolon-separated list of key=value pairs.
 *
 * So: a detail containing `;` or `=` is structured and every segment must match the strict class — which
 * keeps `present=001,003` machine-parsable, the one place the format is load-bearing. Anything else is a
 * free-text reason and may carry spaces. Netstring framing means no character can break the encoding
 * either way; what is refused is a monetary amount, and that is refused everywhere.
 */
export const DETAIL_STRICT_RE = /^[A-Za-z0-9_.,=-]+$/;
const isControl = (ch) => ch.codePointAt(0) < 0x20;

export function validDetail(detail) {
  const d = String(detail || '');
  // No control characters: a newline or a tab would survive netstring framing and then break every
  // human-readable rendering of the chain.
  if ([...d].some(isControl)) return false;
  if (!/[;=]/.test(d)) return true;
  return d.split(';').every((seg) => seg === '' || DETAIL_STRICT_RE.test(seg));
}
// A reprice records only THAT a run-wide change happened. §5.6.2 forbids it carrying a price, and the
// refusal belongs at write time: a detail saying "raised to $129" is a defect that must not reach the
// database, let alone survive to be anchored and then throw on read.
const MONEY_TEXT = /(?:\$|\bAUD?\b|\bUSD\b)\s*\d|\d+(?:\.\d{2})/;

const pad3 = (n) => String(n).padStart(3, '0');
const isSale = (kind) => SALE_KINDS.includes(kind);

/** §4.3: an RFC 3339 instant, UTC, millisecond precision. Refused rather than silently reformatted. */
export function instant(v) {
  const s = String(v == null ? '' : v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return s;
  const d = new Date(s || Date.now());
  if (Number.isNaN(d.getTime())) throw new TypeError(`"${v}" is not an instant`);
  return d.toISOString();
}

/** §5.6.2: a random 128-bit receipt token, lowercase hex, issued to one buyer. */
export function mintReceiptToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Every field as the canonical string the hash takes. Empty means absent, and encodes as ns("") = 0:,. */
export function normalizeEntry(e = {}) {
  const kind = String(e.kind || '');
  if (!LEDGER_KINDS.includes(kind)) throw new TypeError(`"${kind}" is not a ledger kind`);

  const seq = Number(e.seq ?? 0);
  if (!Number.isInteger(seq) || seq < 0) throw new TypeError('seq is a non-negative integer');
  if (isSale(kind) !== (seq > 0)) {
    throw new TypeError(`${kind} carries seq ${seq}; a sale consumes an ordinal and nothing else does`);
  }

  const qty = Number(e.qty ?? 0);
  if (isSale(kind) !== (qty > 0)) throw new TypeError(`${kind} carries qty ${qty}`);

  const bundleNo = e.bundleNo == null || e.bundleNo === '' ? '' : pad3(Number(e.bundleNo));
  if (accountsForBundle(kind) && !bundleNo) throw new TypeError(`${kind} must name a bundle`);
  if (bundleNo && !/^\d{3}$/.test(bundleNo)) throw new TypeError(`"${e.bundleNo}" is not a bundle number`);

  const ref = normalizeValue(e.ref == null ? '' : String(e.ref));
  if (ref && !/^[0-9a-f]{32}$/.test(ref)) throw new TypeError('a receipt token is 32 lowercase hex characters');

  const detail = normalizeValue(e.detail == null ? '' : String(e.detail));
  if (!validDetail(detail)) throw new TypeError(`detail "${detail}" is outside the §5.6.5 grammar`);
  if (MONEY_TEXT.test(detail)) throw new TypeError('a ledger detail may not carry a monetary amount');

  return { seq: String(seq), kind, ref, occurredAt: instant(e.occurredAt), bundleNo, qty: String(qty), detail };
}

/** The exact ns() concatenation. Exported so a failing vector can be diffed as a string, not a hash. */
export function ledgerCanonical(publicId, prevHash, e) {
  const n = normalizeEntry(e);
  return ns(String(publicId)) + ns(String(prevHash)) + ns(n.seq) + ns(n.kind)
    + ns(n.ref) + ns(n.occurredAt) + ns(n.bundleNo) + ns(n.qty) + ns(n.detail);
}

/** §5.6.2: ledgerHash(i) = SHA-256(0x05 || UTF8(canonical)). */
export const ledgerHash = (publicId, prevHash, e) => sha256Prefixed(0x05, ledgerCanonical(publicId, prevHash, e));

/** Fold a list of entries into a chain. THIS IS THE VECTOR REPRODUCER. */
export async function chainOf(publicId, entries = []) {
  const out = [];
  let prev = ZERO_HASH;
  for (const e of entries) {
    const hash = await ledgerHash(publicId, prev, e);
    out.push({ ...e, prev_hash: prev, entry_hash: hash });
    prev = hash;
  }
  return out;
}

/** Recompute the chain from its published entries and say where it first diverges. */
export async function verifyChain(publicId, entries = [], { unitCount = null } = {}) {
  const errors = [];
  let prev = ZERO_HASH;
  let sales = 0;
  for (const [i, e] of entries.entries()) {
    if (String(e.prev_hash) !== prev) errors.push(`entry ${i} (${e.kind}) follows ${e.prev_hash}, not ${prev}`);
    let hash = null;
    try { hash = await ledgerHash(publicId, prev, e); }
    catch (err) { errors.push(`entry ${i} (${e.kind}): ${String(err.message || err)}`); break; }
    if (hash !== String(e.entry_hash)) errors.push(`entry ${i} (${e.kind}) hashes to ${hash}, not ${e.entry_hash}`);
    if (isSale(e.kind)) {
      sales++;
      // Strictly increasing over sales, no gaps. A sale is never removed, so a resale after a
      // cancellation takes the NEXT ordinal rather than reusing the released one.
      if (Number(e.seq) !== sales) errors.push(`entry ${i} is sale ${sales} but carries seq ${e.seq}`);
    }
    prev = hash;
  }

  // The hashes above prove the chain was not edited. They say nothing about whether what it records is
  // POSSIBLE - one parcel sold twice hashes perfectly well. Given the run's size, check that too, so a
  // verifier gets one answer rather than a valid chain describing an impossible run.
  if (unitCount != null) {
    for (const p of availabilityFrom(unitCount, entries).problems) errors.push(p);
  }
  return { ok: !errors.length, errors, head: prev, sales };
}

/**
 * §5.6.3: the available set, derivable by anyone from the entries alone.
 *
 * This is the whole point of publishing the chain. It is a pure function of the entries so a buyer runs
 * exactly what we run.
 */
export function availabilityFrom(unitCount, entries = []) {
  const sold = new Map();          // bundleNo -> the entry that took it
  const byToken = new Map();
  const cancelled = new Set();
  let paused = false;
  let present = null;

  // THE CHAIN IS EVIDENCE, SO IT HAS TO BE CHECKED RATHER THAN BELIEVED.
  //
  // §5.6 makes "anyone can derive what was available at any moment from the published chain" a property
  // of the product - it is what makes "7 is gone" checkable instead of asserted. This walk used to trust
  // whatever it was handed, and an independent audit showed the three ways that turns a broken chain
  // into a plausible answer instead of a refusal:
  //
  //   * a bundle number outside the run was accounted for happily, so `sold` could name 009 in a
  //     four-bundle edition and `available` still read [1,2,3,4];
  //   * a second sale of a number already sold OVERWROTE the first, because sold.set() overwrites - so
  //     a chain claiming to sell one parcel twice produced exactly the availability of selling it once,
  //     and the artifact could not distinguish them;
  //   * a cancel released a number REGARDLESS of who was holding it, so cancelling the first of two
  //     sales of bundle 002 put it back on sale while the second buyer's uncancelled entry still stood.
  //
  // Our own writes cannot do any of this - appendSale refuses a number already accounted for - so this
  // is about what an INDEPENDENT verifier accepts from a chain somebody else produced. Problems are
  // collected rather than thrown: this is a pure function that a verifier calls to find out whether a
  // chain holds, and a verifier that crashes has not told anybody anything.
  const problems = [];
  const seenTokens = new Set();

  for (const [i, e] of entries.entries()) {
    if (accountsForBundle(e.kind)) {
      const no = Number(e.bundleNo ?? e.bundle_no);
      if (!Number.isInteger(no) || no < 1 || no > unitCount) {
        problems.push(`entry ${i} (${e.kind}) accounts for bundle ${e.bundleNo ?? e.bundle_no}, `
          + `which is not one of the ${unitCount} in this run`);
        continue;
      }
      // A number can be accounted for ONCE. Overwriting hid the second claim entirely.
      if (sold.has(no)) {
        problems.push(`entry ${i} (${e.kind}) accounts for bundle ${pad3(no)}, which entry `
          + `${entries.indexOf(sold.get(no))} already accounted for`);
        continue;
      }
      if (e.ref) {
        if (seenTokens.has(e.ref)) problems.push(`entry ${i} reuses receipt token ${e.ref}`);
        seenTokens.add(e.ref);
        byToken.set(e.ref, e);
      }
      sold.set(no, e);
    } else if (e.kind === 'cancel') {
      const token = e.ref;
      const orig = byToken.get(token);
      if (!orig) {
        problems.push(`entry ${i} cancels receipt token ${token || '(none)'}, which nothing sold`);
        continue;
      }
      if (cancelled.has(token)) {
        problems.push(`entry ${i} cancels receipt token ${token} a second time`);
        continue;
      }
      const no = Number(orig.bundleNo ?? orig.bundle_no);
      // ONLY THE CURRENT HOLDER MAY BE CANCELLED. Releasing a number held by somebody else is how a
      // cancelled order used to hand a live buyer's parcel back to the shop.
      //
      // A BACKSTOP, AND SAID PLAINLY SO NOBODY MISTAKES IT FOR THE FIX. While the two rules above hold,
      // this cannot fire: a second claim on a number is refused before it can take the slot, and a
      // token cannot be reused or cancelled twice, so whoever `byToken` names is whoever `sold` holds.
      // It stays because probe C - a cancel handing a live buyer's parcel back to the shop - is the
      // worst of the three, and an edit to either rule above should not be able to bring it back
      // silently. There is deliberately no test asserting it fires, because no chain can reach it.
      if (sold.get(no) !== orig) {
        problems.push(`entry ${i} cancels receipt token ${token} for bundle ${pad3(no)}, `
          + 'but that number is accounted for by a different entry');
        continue;
      }
      cancelled.add(token);
      sold.delete(no);
    } else if (e.kind === 'pause') {
      paused = true;
      const m = /present=([0-9,]*)/.exec(String(e.detail || ''));
      present = m ? m[1].split(',').filter(Boolean).map(Number) : null;
    } else if (e.kind === 'resume') {
      paused = false;
      present = null;
    }
  }

  const available = [];
  for (let i = 1; i <= unitCount; i++) if (!sold.has(i)) available.push(i);
  // `available` is only meaningful when `problems` is empty. A caller acting on it - stocking a
  // storefront, closing a run - must check.
  return { available, sold, byToken, cancelled, paused, present, problems };
}

// --- the database half ---------------------------------------------------------------------------------

export const ledgerEntries = (db, runId) =>
  db.prepare(`SELECT id, seq, kind, ref, occurred_at, bundle_no, qty, detail, prev_hash, entry_hash
                FROM run_ledger WHERE run_id = ? ORDER BY id`).all(+runId);

/** The chain as the pure half wants it — camelCase, and the shape a published artifact carries. */
export const asEntries = (rows) => rows.map((r) => ({
  seq: r.seq, kind: r.kind, ref: r.ref || '', occurredAt: r.occurred_at,
  bundleNo: r.bundle_no == null ? '' : pad3(r.bundle_no), qty: r.qty, detail: r.detail || '',
  prev_hash: r.prev_hash, entry_hash: r.entry_hash,
}));

export function ledgerHead(db, runId) {
  const rows = ledgerEntries(db, runId);
  const sales = rows.filter((r) => isSale(r.kind)).length;
  return { count: rows.length, sales, prevHash: rows.length ? rows[rows.length - 1].entry_hash : ZERO_HASH };
}

export function availability(db, runId) {
  const run = db.prepare('SELECT unit_count FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  return availabilityFrom(run.unit_count, asEntries(ledgerEntries(db, runId)));
}

/**
 * Append one entry.
 *
 * COMPUTE OUTSIDE, RE-CHECK INSIDE. The hash is async (WebCrypto), and awaiting inside an open write
 * transaction would hold SQLite's lock across it — the same problem lockRunPhase1 documents and solves
 * the same way. The head is re-read inside the transaction and the append refuses if the chain moved,
 * so a concurrent write cannot fork it. UNIQUE(run_id, entry_hash) is the third layer.
 */
export async function appendEntry(db, runId, {
  kind, bundleNo = null, ref = null, occurredAt = null, detail = '',
  order = null, actor = null, gate = true,
} = {}) {
  const run = db.prepare('SELECT id, public_id, unit_count, status FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);

  const head = ledgerHead(db, run.id);
  const avail = availability(db, run.id);
  const sale = isSale(kind);
  const token = sale ? (ref || mintReceiptToken()) : (ref || '');

  if (accountsForBundle(kind)) {
    const no = Number(bundleNo);
    if (!(no >= 1 && no <= run.unit_count)) throw new Error(`bundle ${bundleNo} is not in this run`);
    if (!avail.available.includes(no)) {
      // A real incident when it comes from the orders poll: it means the storefront let a second unit
      // through. Named rather than counted.
      const err = new Error(`bundle ${pad3(no)} is already accounted for and cannot be sold again`);
      err.code = 'already_sold';
      throw err;
    }
  }
  if (kind === 'cancel') {
    const orig = avail.byToken.get(String(ref || ''));
    if (!orig) throw new Error('a cancellation must name the receipt token of the entry it cancels');
    if (avail.cancelled.has(String(ref))) throw new Error('that entry is already cancelled');
    // §5.6.2: a cancellation is only valid BEFORE dispatch. A post-dispatch return is never a release.
    const b = db.prepare('SELECT shipped_at FROM run_bundles WHERE run_id = ? AND bundle_no = ?')
      .get(run.id, Number(orig.bundleNo ?? orig.bundle_no));
    if (b?.shipped_at) throw new Error('that bundle has shipped; a return after dispatch is not a release');
    bundleNo = Number(orig.bundleNo ?? orig.bundle_no);
  }
  if (sale && gate) {
    const g = saleGate(db, run.id);
    if (!g.open) {
      const err = new Error(`run ${run.public_id} may not sell yet: ${g.reasons.join('; ')}`);
      err.code = 'sale_gate';
      throw err;
    }
  }

  const entry = {
    seq: sale ? head.sales + 1 : 0,
    kind,
    ref: token,
    occurredAt: instant(occurredAt),
    bundleNo: bundleNo == null ? '' : pad3(Number(bundleNo)),
    qty: sale ? 1 : 0,
    detail: String(detail || ''),
  };
  const hash = await ledgerHash(run.public_id, head.prevHash, entry);

  db.exec('BEGIN');
  try {
    const now = ledgerHead(db, run.id);
    if (now.prevHash !== head.prevHash) {
      const err = new Error('the ledger moved while this entry was being hashed; nothing was written');
      err.code = 'ledger_moved';
      throw err;
    }
    db.prepare(`INSERT INTO run_ledger (run_id, seq, kind, ref, occurred_at, bundle_no, qty, detail, prev_hash, entry_hash)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(run.id, entry.seq, entry.kind, entry.ref || null, entry.occurredAt,
        entry.bundleNo === '' ? null : Number(entry.bundleNo), entry.qty, entry.detail || null,
        head.prevHash, hash);
    const id = db.prepare('SELECT last_insert_rowid() id').get().id;

    if (order) {
      // The private binding, in the SAME transaction. §5.6.2 makes `ref` a random token specifically so a
      // storefront order number is never recoverable from the published chain — putting the order id on
      // the ledger row would undo that in one column, so it lives in its own table.
      db.prepare(`INSERT INTO run_ledger_orders (entry_id, channel, store, order_ref, order_name, line_ref, buyer_ref)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(id, order.channel, order.store || null, order.orderRef, order.orderName || null,
          order.lineRef, order.buyerRef || null);
    }
    audit(db, { runId: run.id, entity: 'run_ledger', entityId: id, action: 'ledger_append', actor,
      after: { kind, bundle_no: entry.bundleNo || null, seq: entry.seq } });
    db.exec('COMMIT');
    return { id, ...entry, prev_hash: head.prevHash, entry_hash: hash, token };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const appendSale = (db, runId, { bundleNo, channel = 'sale_online', occurredAt, detail, order, actor, gate }) =>
  appendEntry(db, runId, { kind: channel, bundleNo, occurredAt, detail, order, actor, gate });

export const appendCancel = (db, runId, { token, reason = '', occurredAt, actor }) =>
  appendEntry(db, runId, { kind: 'cancel', ref: token, detail: reason, occurredAt, actor });

export const appendReprice = (db, runId, { note = 'run-wide price change', occurredAt, actor }) =>
  appendEntry(db, runId, { kind: 'reprice', detail: note, occurredAt, actor });

export const appendOpenedLive = (db, runId, { bundleNo, detail = '', occurredAt, actor }) =>
  appendEntry(db, runId, { kind: 'opened_live', bundleNo, detail, occurredAt, actor });

/**
 * §5.6.4 rule 1: ALL unsold bundles travel, and the set present is committed in the pause entry.
 *
 * The set is DERIVED here, never taken from the caller. A seller bringing only a subset regains the
 * selection control buyer-choice exists to remove, and a committed set makes a shortfall checkable.
 */
export async function appendPause(db, runId, { eventId, occurredAt, actor } = {}) {
  const id = String(eventId || '').trim();
  // The strict class here, not the loose one: this identifier becomes a segment of a structured
  // detail alongside present=, so a space in it would make the whole entry unparsable.
  if (!id || !DETAIL_STRICT_RE.test(id)) throw new Error('an event identifier is required, in the §5.6.5 grammar');
  const { available } = availability(db, runId);
  const detail = `${id};present=${available.map(pad3).join(',')}`;
  return appendEntry(db, runId, { kind: 'pause', detail, occurredAt, actor });
}

export const appendResume = (db, runId, { eventId, occurredAt, actor } = {}) =>
  appendEntry(db, runId, { kind: 'resume', detail: String(eventId || ''), occurredAt, actor });

/** The private binding. Never reaches a public payload. */
export const orderBinding = (db, entryId) =>
  db.prepare('SELECT * FROM run_ledger_orders WHERE entry_id = ?').get(+entryId);

/** The published ledger: the chain and nothing that could identify a buyer or an order. */
export function publicLedger(db, runId) {
  const run = db.prepare('SELECT public_id, unit_count FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  const entries = asEntries(ledgerEntries(db, runId));
  const a = availabilityFrom(run.unit_count, entries);
  return {
    v: 1,
    run: run.public_id,
    unit_count: run.unit_count,
    entries,
    head: entries.length ? entries[entries.length - 1].entry_hash : ZERO_HASH,
    available: a.available,
    paused: a.paused,
  };
}
