// lib/runs-anchor.mjs — §5.7: anchoring, and the sale gate that depends on it.
//
// WHAT AN ANCHOR IS FOR. It makes "this digest existed before time T" checkable by someone who does not
// trust us. That is the whole of it, and it is why the anchor is deliberately replaceable: the scheme's
// security rests on SHA-256 and the salts, not on the timestamping service, so swapping calendars touches
// the submission client, one display branch and nothing else.
//
// WE SUBMIT AND STORE RECEIPT BYTES VERBATIM AND NEVER PARSE THEM (§5.7.4). A hand-rolled .ots parser bug
// would produce a FALSE CLAIM ABOUT ANCHORING, which is worse than not anchoring at all — a buyer would be
// told their bundle was timestamped when it was not. The page links the official independent verifier and
// offers the receipt for download, so a sceptic checks the timestamp without trusting anything we wrote.
//
// THE UPGRADE IS MANDATORY (§5.7.5). A calendar returns an INCOMPLETE attestation which is self-contained
// only after upgrading; until then, verifying it needs the calendar to still exist and still hold its
// aggregation data. An un-upgraded receipt is not a durable anchor, so an anchor is never reported
// confirmed until it has been upgraded, and one still un-upgraded after a defined interval raises an alert.
//
// AND SALES WAIT FOR IT (§5.7.7). Revision 2 opened sales on a pending submission, which proves nothing to
// an outsider — a calendar attestation says nothing verifiable while it is in flight. Revisions 3 and 4
// patched that with a transparency log, at the cost of a permanent public signing identity, an entry
// schema, key rotation, a monitor and consistency-proof checking. Revision 5 simply WAITS. For a run
// launched to a schedule the few hours cost nothing, and they buy an anchor anyone can check with a
// Bitcoin node and no account, key or identity anywhere in the system.

import { audit } from './runs-reserve.mjs';

/** §5.7: the calendars a digest is submitted to. Several, because one calendar is one dependency. */
export const CALENDARS = Object.freeze([
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
]);

/** The independent verifier a sceptic uses instead of trusting our page. */
export const VERIFIER_URL = 'https://opentimestamps.org/';

/** §5.7.5: how long an un-upgraded receipt may sit before it is an incident rather than a wait. */
export const UPGRADE_ALERT_HOURS = 36;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `stub` fabricates a receipt and never touches the network. It exists for automated tests and local
 * iteration, and it is REFUSED for a live run and for any publish targeting the live store — an anchor
 * that proves nothing must never be able to gate a real sale.
 */
export const MODES = Object.freeze(['stub', 'opentimestamps']);

function assertMode(mode, run) {
  if (!MODES.includes(mode)) throw new Error(`unknown anchor mode "${mode}"`);
  if (mode === 'stub' && run?.mode === 'live') {
    throw new Error(`run ${run.public_id} is a live run; a stub anchor proves nothing and cannot be used`);
  }
}

/**
 * Submit a digest for timestamping and record it. Idempotent per (run, digest, scope, method).
 *
 * MAINNET, NEVER TESTNET, even for a dev run. Calendars aggregate thousands of digests into one
 * transaction, so anchoring costs nothing — no wallet, key or coins — and there is no public testnet
 * calendar infrastructure to rehearse against. Testnet's erratic block times, resets and deep reorgs would
 * rehearse behaviour production does not have. A dev run's digest on mainnet is 32 bytes inside an
 * aggregated transaction: it reveals nothing and costs nobody. The DEV- prefix is inside headerDigest, so
 * such a timestamp is self-labelling forever and can never be mistaken for a production commitment.
 */
export async function submitAnchor(db, {
  runId, digest, scope = 'header', mode = 'opentimestamps', actor = null, now = null,
  submit = null, calendars = CALENDARS,
} = {}) {
  if (!HEX64.test(String(digest || ''))) throw new TypeError('a digest is 32 bytes of lowercase hex');
  const run = db.prepare('SELECT id, public_id, mode FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  assertMode(mode, run);

  const existing = db.prepare(`SELECT * FROM run_anchors
                                WHERE run_id = ? AND digest_hex = ? AND scope = ? AND method = ?`)
    .get(run.id, digest, scope, mode);
  // Re-submitting the same digest would produce a second receipt for one commitment, and "anchored" is a
  // set of independent claims about ONE digest, not a pile of attempts.
  if (existing && existing.state !== 'failed') return { ...existing, alreadySubmitted: true };

  const stamp = now || new Date().toISOString();
  let receipt = null;
  let error = null;
  try {
    receipt = mode === 'stub'
      ? stubReceipt(digest, scope)
      : await (submit || submitToCalendars)(digest, calendars);
    if (!(receipt instanceof Uint8Array) || !receipt.length) throw new Error('the calendar returned no receipt bytes');
  } catch (e) {
    error = String(e?.message || e);
  }

  db.exec('BEGIN');
  try {
    if (existing) {
      db.prepare(`UPDATE run_anchors SET state = ?, submitted_at = ?, receipt = ?, last_error = ?
                   WHERE id = ?`).run(error ? 'failed' : 'submitted', stamp, receipt ?? null, error, existing.id);
    } else {
      db.prepare(`INSERT INTO run_anchors (run_id, digest_hex, scope, method, state, submitted_at, receipt, last_error)
                  VALUES (?,?,?,?,?,?,?,?)`)
        .run(run.id, digest, scope, mode, error ? 'failed' : 'submitted', stamp, receipt ?? null, error);
    }
    audit(db, { runId: run.id, entity: 'run_anchors', entityId: null, action: 'anchor_submit', actor,
      after: { digest, scope, method: mode, state: error ? 'failed' : 'submitted', error } });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  if (error) throw new Error(`could not submit ${scope} digest for timestamping: ${error}`);
  return db.prepare(`SELECT * FROM run_anchors WHERE run_id = ? AND digest_hex = ? AND scope = ? AND method = ?`)
    .get(run.id, digest, scope, mode);
}

/**
 * §5.7.5: upgrade a submitted attestation to one that stands alone, and only then call it confirmed.
 *
 * The upgraded bytes REPLACE the incomplete ones. Nothing here parses them; `blockHeight` and `txid` come
 * from the upgrade client, are stored for display, and are never the basis of a confirmation claim on
 * their own — the receipt is.
 */
export async function upgradeAnchor(db, anchorId, { upgrade = null, actor = null, now = null } = {}) {
  const a = db.prepare('SELECT * FROM run_anchors WHERE id = ?').get(+anchorId);
  if (!a) throw new Error(`no such anchor: ${anchorId}`);
  if (a.state === 'confirmed') return { ...a, alreadyConfirmed: true };
  if (a.state === 'failed') throw new Error(`anchor ${a.id} failed to submit; resubmit before upgrading`);

  const stamp = now || new Date().toISOString();
  const result = a.method === 'stub'
    ? { receipt: stubReceipt(a.digest_hex, a.scope, true), blockHeight: 900000, txid: null, confirmed: true }
    : await (upgrade || upgradeWithCalendars)(a);

  if (!result?.confirmed) {
    // Not an error. A pending attestation is the normal state for the first hours, and the page says
    // `pending` honestly rather than calling it anchored.
    db.prepare('UPDATE run_anchors SET last_error = ? WHERE id = ?').run(result?.reason ?? null, a.id);
    return { ...a, confirmed: false, reason: result?.reason ?? 'still pending in the calendar' };
  }

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE run_anchors SET state = 'confirmed', upgraded_at = ?, receipt = ?,
                  block_height = ?, txid = ?, last_error = NULL WHERE id = ?`)
      .run(stamp, result.receipt ?? a.receipt, result.blockHeight ?? null, result.txid ?? null, a.id);
    audit(db, { runId: a.run_id, entity: 'run_anchors', entityId: a.id, action: 'anchor_confirmed', actor,
      after: { digest: a.digest_hex, scope: a.scope, block_height: result.blockHeight ?? null } });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return db.prepare('SELECT * FROM run_anchors WHERE id = ?').get(a.id);
}

/** Every anchor for a run, in the shape the public page and the commitment's `anchors` field take. */
export function anchorsFor(db, runId, { scope = null } = {}) {
  const rows = scope
    ? db.prepare('SELECT * FROM run_anchors WHERE run_id = ? AND scope = ? ORDER BY id').all(+runId, scope)
    : db.prepare('SELECT * FROM run_anchors WHERE run_id = ? ORDER BY id').all(+runId);
  return rows.map(publicAnchor);
}

/**
 * One anchor as a buyer sees it.
 *
 * `pending` or `confirmed in block N`, HONESTLY, and never the word "anchored" for something in flight.
 * The receipt is offered as bytes to download rather than interpreted, and the independent verifier is
 * named so a sceptic can check the timestamp without trusting this page at all.
 */
export function publicAnchor(a) {
  return {
    method: a.method,
    scope: a.scope,
    digest: a.digest_hex,
    state: a.state,
    submitted_at: a.submitted_at,
    upgraded_at: a.upgraded_at,
    block_height: a.block_height,
    txid: a.txid,
    public_url: a.public_url,
    receipt_bytes: a.receipt ? a.receipt.length : 0,
    // A confirmed anchor is one that has been UPGRADED. §5.7.5: an un-upgraded receipt needs the calendar
    // to still exist and still hold its aggregation data, so it is not a durable anchor and is not
    // reported as one.
    verifier: VERIFIER_URL,
    label: a.state === 'confirmed'
      ? (a.block_height ? `confirmed in Bitcoin block ${a.block_height}` : 'confirmed')
      : a.state === 'failed' ? 'submission failed' : 'pending',
  };
}

/**
 * §5.7.7 THE SALE GATE. Every condition, evaluated together, with the reasons named.
 *
 * Returns { open, reasons } rather than a boolean, because "you cannot sell yet" is useless to an operator
 * without which of the four conditions is outstanding.
 */
export function saleGate(db, runId, { published = null } = {}) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  const reasons = [];

  if (run.status === 'draft' || run.status === 'abandoned') reasons.push(`the run is ${run.status}`);
  else if (run.status === 'locked_pending_publish') reasons.push('the header, commitment and blob file are not published yet');
  if (!run.header_digest) reasons.push('the run has no header digest');

  // The artifacts. Passed in rather than probed, because whether a file is really readable at its public
  // URL is a network question and this function must stay callable from a test and a route alike.
  if (published && published.ok === false) {
    reasons.push(published.reason || 'the published artifacts did not read back correctly');
  }

  const header = db.prepare(`SELECT * FROM run_anchors
                              WHERE run_id = ? AND scope = 'header' AND digest_hex = ?
                              ORDER BY id`).all(run.id, run.header_digest || '');
  const confirmed = header.find((a) => a.state === 'confirmed');
  if (!header.length) reasons.push('the header digest has not been submitted for timestamping');
  else if (!confirmed) {
    // The heart of §5.7.7. A submitted attestation proves nothing to an outsider, so sales wait for the
    // Bitcoin confirmation rather than opening on a promise.
    reasons.push('the header timestamp is still pending; sales open when it confirms in a Bitcoin block');
  }
  if (confirmed && confirmed.method === 'stub' && run.mode === 'live') {
    reasons.push('the header is anchored only by a stub, which proves nothing');
  }

  return {
    open: !reasons.length,
    reasons,
    confirmed_block: confirmed?.block_height ?? null,
    anchors: header.map(publicAnchor),
  };
}

/** §5.7.5: anchors that have been pending too long. An alert, not a failure — but it must be seen. */
export function staleAnchors(db, { hours = UPGRADE_ALERT_HOURS, now = null } = {}) {
  const cutoff = new Date((now ? new Date(now) : new Date()).getTime() - hours * 3600 * 1000).toISOString();
  return db.prepare(`SELECT a.*, r.public_id FROM run_anchors a JOIN runs r ON r.id = a.run_id
                      WHERE a.state = 'submitted' AND a.submitted_at < ? ORDER BY a.submitted_at`).all(cutoff);
}

// --- the two clients ------------------------------------------------------------------------------------

/**
 * A deterministic fake receipt. NOT an .ots file and deliberately not shaped like one — anything that
 * looked like a real receipt could be mistaken for one in a database dump or a bug report.
 */
export function stubReceipt(digest, scope = 'header', upgraded = false) {
  const text = `BKR1-STUB-ANCHOR\n${scope}\n${digest}\n${upgraded ? 'upgraded' : 'incomplete'}\n`;
  return new TextEncoder().encode(text);
}

/**
 * Submit 32 raw bytes to the calendars. RAW BYTES, not hex text and not a JSON document — §5.1 is explicit
 * that what is anchored is the digest itself.
 *
 * Succeeds if ANY calendar accepts, because the point of submitting to several is that one being down is
 * not an outage. The receipt of the first acceptance is what is stored.
 */
export async function submitToCalendars(digest, calendars = CALENDARS, { fetchImpl = fetch } = {}) {
  const body = Uint8Array.from(digest.match(/../g).map((h) => parseInt(h, 16)));
  const errors = [];
  for (const base of calendars) {
    try {
      const res = await fetchImpl(`${base}/digest`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', accept: 'application/octet-stream' },
        body,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) throw new Error('empty response');
      return bytes;
    } catch (e) {
      errors.push(`${base}: ${String(e?.message || e)}`);
    }
  }
  throw new Error(`every calendar refused: ${errors.join('; ')}`);
}

/**
 * Ask the calendars whether an attestation has made it into a block yet.
 *
 * Returns `{ confirmed: false, reason }` while pending, which is the normal state for hours and is not an
 * error. We do not parse the receipt to decide — the calendar's own upgrade endpoint answers, and its
 * bytes are stored verbatim.
 */
export async function upgradeWithCalendars(anchor, { fetchImpl = fetch, calendars = CALENDARS } = {}) {
  const errors = [];
  for (const base of calendars) {
    try {
      const res = await fetchImpl(`${base}/timestamp/${anchor.digest_hex}`, {
        headers: { accept: 'application/octet-stream' },
      });
      if (res.status === 404) { errors.push(`${base}: not yet aggregated`); continue; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) throw new Error('empty response');
      // The calendar returning an upgraded attestation IS the confirmation. Block height is display only,
      // and is left null rather than guessed — §5.7.4, we do not parse receipts.
      return { confirmed: true, receipt: bytes, blockHeight: null, txid: null };
    } catch (e) {
      errors.push(`${base}: ${String(e?.message || e)}`);
    }
  }
  return { confirmed: false, reason: errors.join('; ') || 'still pending in the calendar' };
}
