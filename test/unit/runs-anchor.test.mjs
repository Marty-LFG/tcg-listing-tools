// test/unit/runs-anchor.test.mjs — §5.7 anchoring and the sale gate.
//
// The gate is the point of this module. Revision 2 opened sales on a SUBMITTED attestation, which proves
// nothing to an outsider — a calendar attestation is not independently checkable while it is in flight.
// Revisions 3 and 4 patched that with a transparency log, at the cost of a permanent public signing
// identity, an entry schema, key rotation, a monitor and consistency-proof checking. Revision 5 waits for
// the Bitcoin confirmation instead, and these tests are what hold that line.
//
// No network anywhere: the submit and upgrade clients are injected, and the `stub` mode never reaches for
// one at all.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import {
  submitAnchor, upgradeAnchor, anchorsFor, publicAnchor, saleGate, staleAnchors,
  stubReceipt, submitToCalendars, upgradeWithCalendars, CALENDARS, MODES, UPGRADE_ALERT_HOURS,
} from '../../lib/runs-anchor.mjs';

const db = openDbAt(tmpFile('runs-anchor.db'));
const DIGEST = '829a795eaca64d6ccf56b6898e0e51f495f450a70b34e9577c04ccaa685d2231';

let n = 0;
function mkRun({ mode = 'live', status = 'locked_published', digest = DIGEST } = {}) {
  const k = ++n;
  const pid = (mode === 'dev' ? 'DEV-A' : 'A') + k;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, locked_at, run_root,
                header_digest, close_by, sales_close_at, unsold_policy)
              VALUES (?,?,?,?,3,?, '2026-08-30T00:00:00.000Z', ?, ?, '2027-03-31T23:59:59.000Z',
                      '2027-01-31T23:59:59.000Z', 'One price for every number.')`)
    .run(pid, k, `Edition ${k}`, mode, status, 'ab'.repeat(32), digest);
  return db.prepare('SELECT id FROM runs WHERE public_id = ?').get(pid).id;
}

describe('submitting a digest', () => {
  it('stores the receipt bytes verbatim and records it as submitted, not confirmed', async () => {
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, { runId, digest: DIGEST, mode: 'stub' });
    assert.equal(a.state, 'submitted');
    assert.equal(a.scope, 'header');
    assert.ok(a.receipt.length > 0);
    assert.equal(a.upgraded_at, null);
  });

  it('is idempotent — one digest, one anchor per method', async () => {
    const runId = mkRun({ mode: 'dev' });
    const first = await submitAnchor(db, { runId, digest: DIGEST, mode: 'stub' });
    const again = await submitAnchor(db, { runId, digest: DIGEST, mode: 'stub' });
    assert.equal(again.alreadySubmitted, true);
    assert.equal(again.id, first.id);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM run_anchors WHERE run_id = ?').get(runId).c, 1);
  });

  it('REFUSES a stub anchor on a live run, because a stub proves nothing', async () => {
    const runId = mkRun({ mode: 'live' });
    await assert.rejects(() => submitAnchor(db, { runId, digest: DIGEST, mode: 'stub' }),
      /a stub anchor proves nothing/);
  });

  it('refuses a digest that is not 32 bytes of lowercase hex', async () => {
    const runId = mkRun({ mode: 'dev' });
    await assert.rejects(() => submitAnchor(db, { runId, digest: DIGEST.toUpperCase(), mode: 'stub' }), TypeError);
    await assert.rejects(() => submitAnchor(db, { runId, digest: 'abc', mode: 'stub' }), TypeError);
  });

  it('records a failed submission rather than losing it, and says so', async () => {
    const runId = mkRun({ mode: 'dev' });
    await assert.rejects(() => submitAnchor(db, {
      runId, digest: DIGEST, mode: 'opentimestamps', submit: () => { throw new Error('calendars down'); },
    }), /calendars down/);
    const row = db.prepare('SELECT * FROM run_anchors WHERE run_id = ?').get(runId);
    assert.equal(row.state, 'failed');
    assert.match(row.last_error, /calendars down/);
  });

  it('and a failed submission may be retried', async () => {
    const runId = mkRun({ mode: 'dev' });
    await submitAnchor(db, { runId, digest: DIGEST, mode: 'opentimestamps', submit: () => { throw new Error('down'); } })
      .catch(() => {});
    const ok = await submitAnchor(db, {
      runId, digest: DIGEST, mode: 'opentimestamps', submit: async () => new Uint8Array([1, 2, 3]),
    });
    assert.equal(ok.state, 'submitted');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM run_anchors WHERE run_id = ?').get(runId).c, 1);
  });
});

describe('§5.7.5 the upgrade is mandatory', () => {
  it('a submitted anchor is NOT confirmed', async () => {
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, { runId, digest: DIGEST, mode: 'stub' });
    assert.equal(publicAnchor(a).label, 'pending');
    assert.notEqual(a.state, 'confirmed');
  });

  it('a still-pending upgrade leaves it submitted and is not an error', async () => {
    // The normal state for the first hours. The page says `pending` honestly rather than calling it
    // anchored, which is the distinction §5.7.6 turns on.
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, {
      runId, digest: DIGEST, mode: 'opentimestamps', submit: async () => new Uint8Array([9]),
    });
    const r = await upgradeAnchor(db, a.id, { upgrade: async () => ({ confirmed: false, reason: 'not yet aggregated' }) });
    assert.equal(r.confirmed, false);
    assert.equal(db.prepare('SELECT state FROM run_anchors WHERE id = ?').get(a.id).state, 'submitted');
  });

  it('an upgraded one REPLACES the incomplete bytes and becomes confirmed', async () => {
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, {
      runId, digest: DIGEST, mode: 'opentimestamps', submit: async () => new Uint8Array([1]),
    });
    const up = await upgradeAnchor(db, a.id, {
      upgrade: async () => ({ confirmed: true, receipt: new Uint8Array([7, 7, 7]), blockHeight: 912345 }),
    });
    assert.equal(up.state, 'confirmed');
    assert.deepEqual([...up.receipt], [7, 7, 7], 'the upgraded bytes replace the incomplete ones');
    assert.ok(up.upgraded_at);
    assert.equal(publicAnchor(up).label, 'confirmed in Bitcoin block 912345');
  });

  it('and upgrading twice is a no-op', async () => {
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, { runId, digest: DIGEST, mode: 'stub' });
    await upgradeAnchor(db, a.id);
    let calls = 0;
    const again = await upgradeAnchor(db, a.id, { upgrade: async () => { calls++; return { confirmed: true }; } });
    assert.equal(again.alreadyConfirmed, true);
    assert.equal(calls, 0);
  });

  it('and an anchor pending past the alert window is surfaced', async () => {
    const runId = mkRun({ mode: 'dev' });
    await submitAnchor(db, {
      runId, digest: DIGEST, mode: 'opentimestamps', submit: async () => new Uint8Array([1]),
      now: '2026-08-01T00:00:00.000Z',
    });
    const stale = staleAnchors(db, { now: '2026-08-30T00:00:00.000Z' });
    assert.ok(stale.some((s) => s.run_id === runId));
    assert.equal(UPGRADE_ALERT_HOURS, 36);
  });
});

describe('§5.7.7 THE SALE GATE', () => {
  it('refuses a draft run', () => {
    const runId = mkRun({ mode: 'dev', status: 'draft' });
    const g = saleGate(db, runId);
    assert.equal(g.open, false);
    assert.ok(g.reasons.some((r) => /the run is draft/.test(r)));
  });

  it('refuses a locked run whose artifacts are not published', () => {
    const runId = mkRun({ mode: 'dev', status: 'locked_pending_publish' });
    const g = saleGate(db, runId);
    assert.equal(g.open, false);
    assert.ok(g.reasons.some((r) => /not published/.test(r)));
  });

  it('refuses when the digest has never been submitted', () => {
    const runId = mkRun({ mode: 'dev' });
    const g = saleGate(db, runId);
    assert.ok(g.reasons.some((r) => /has not been submitted/.test(r)));
  });

  it('REFUSES ON A MERELY SUBMITTED TIMESTAMP — the whole point of the gate', async () => {
    // Revision 2 opened sales here. A pending calendar attestation proves nothing to an outsider, so a
    // buyer would have no way to check that the commitment predates their purchase.
    const runId = mkRun({ mode: 'dev' });
    await submitAnchor(db, {
      runId, digest: DIGEST, mode: 'opentimestamps', submit: async () => new Uint8Array([1]),
    });
    const g = saleGate(db, runId);
    assert.equal(g.open, false);
    assert.ok(g.reasons.some((r) => /still pending; sales open when it confirms/.test(r)),
      `got: ${g.reasons.join(' | ')}`);
  });

  it('opens once the timestamp CONFIRMS in a block', async () => {
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, {
      runId, digest: DIGEST, mode: 'opentimestamps', submit: async () => new Uint8Array([1]),
    });
    await upgradeAnchor(db, a.id, { upgrade: async () => ({ confirmed: true, blockHeight: 900001 }) });
    const g = saleGate(db, runId);
    assert.deepEqual(g.reasons, []);
    assert.equal(g.open, true);
    assert.equal(g.confirmed_block, 900001);
  });

  it('but a LIVE run is never opened by a stub, however confirmed it says it is', async () => {
    // The stub cannot be submitted for a live run at all; this covers the case where a run was rehearsed
    // as dev and its mode edited afterwards, which the schema forbids but a hand-edited database does not.
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, { runId, digest: DIGEST, mode: 'stub' });
    await upgradeAnchor(db, a.id);
    db.prepare("UPDATE runs SET mode = 'live', public_id = replace(public_id, 'DEV-', '') WHERE id = ?").run(runId);
    const g = saleGate(db, runId);
    assert.equal(g.open, false);
    assert.ok(g.reasons.some((r) => /only by a stub, which proves nothing/.test(r)));
  });

  it('and refuses when the published artifacts did not read back', async () => {
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, { runId, digest: DIGEST, mode: 'stub' });
    await upgradeAnchor(db, a.id);
    const g = saleGate(db, runId, { published: { ok: false, reason: 'the blob file 404s' } });
    assert.equal(g.open, false);
    assert.ok(g.reasons.includes('the blob file 404s'));
  });

  it('and a confirmed anchor for a DIFFERENT digest does not open the gate', async () => {
    // The anchor has to be for THIS header. An earlier run's confirmed timestamp says nothing about this
    // commitment, and matching on run alone would let an amendment sell on its predecessor's anchor.
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, { runId, digest: 'cd'.repeat(32), mode: 'stub' });
    await upgradeAnchor(db, a.id);
    const g = saleGate(db, runId);
    assert.equal(g.open, false);
    assert.ok(g.reasons.some((r) => /has not been submitted/.test(r)));
  });
});

describe('what a buyer is shown', () => {
  it('never says "anchored" for something in flight', async () => {
    const runId = mkRun({ mode: 'dev' });
    const a = await submitAnchor(db, {
      runId, digest: DIGEST, mode: 'opentimestamps', submit: async () => new Uint8Array([1]),
    });
    const shown = publicAnchor(db.prepare('SELECT * FROM run_anchors WHERE id = ?').get(a.id));
    assert.equal(shown.label, 'pending');
    assert.ok(!/anchored/i.test(JSON.stringify(shown)));
  });

  it('offers the receipt as bytes and names an INDEPENDENT verifier', () => {
    // §5.7.4: we never parse a receipt, because a hand-rolled parser bug would produce a false claim about
    // anchoring — worse than not anchoring. A sceptic checks it without trusting our page.
    const runId = mkRun({ mode: 'dev' });
    const rows = anchorsFor(db, runId);
    assert.deepEqual(rows, []);
    const shown = publicAnchor({ method: 'opentimestamps', scope: 'header', digest_hex: DIGEST,
      state: 'confirmed', receipt: new Uint8Array(400), block_height: 900002 });
    assert.equal(shown.receipt_bytes, 400);
    assert.match(shown.verifier, /^https:\/\/opentimestamps\.org/);
  });

  it('and exposes no receipt CONTENT, only its size', () => {
    const shown = publicAnchor({ method: 'stub', scope: 'header', digest_hex: DIGEST, state: 'submitted',
      receipt: stubReceipt(DIGEST) });
    assert.equal(typeof shown.receipt_bytes, 'number');
    assert.ok(!('receipt' in shown));
  });
});

describe('the calendar clients', () => {
  it('POST the digest as 32 RAW BYTES, not hex text', async () => {
    // §5.1 is explicit that what is anchored is the digest itself. Posting the hex string would anchor a
    // 64-byte ASCII value, and every receipt would attest to the wrong thing.
    let sent = null;
    await submitToCalendars(DIGEST, ['https://cal.example'], {
      fetchImpl: async (url, opts) => {
        sent = opts.body;
        return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
      },
    });
    assert.ok(sent instanceof Uint8Array);
    assert.equal(sent.length, 32);
    assert.equal(sent[0], 0x82);
  });

  it('succeed if ANY calendar accepts, so one being down is not an outage', async () => {
    const tried = [];
    const bytes = await submitToCalendars(DIGEST, ['https://a.example', 'https://b.example'], {
      fetchImpl: async (url) => {
        tried.push(url);
        if (url.startsWith('https://a')) throw new Error('down');
        return { ok: true, arrayBuffer: async () => new Uint8Array([5]).buffer };
      },
    });
    assert.deepEqual([...bytes], [5]);
    assert.equal(tried.length, 2);
  });

  it('and report every calendar in the error when all refuse', async () => {
    await assert.rejects(() => submitToCalendars(DIGEST, ['https://a.example', 'https://b.example'], {
      fetchImpl: async () => { throw new Error('nope'); },
    }), /every calendar refused.*a\.example.*b\.example/s);
  });

  it('treat a 404 from the upgrade endpoint as pending, not as failure', async () => {
    const r = await upgradeWithCalendars({ digest_hex: DIGEST }, {
      calendars: ['https://a.example'],
      fetchImpl: async () => ({ status: 404, ok: false }),
    });
    assert.equal(r.confirmed, false);
    assert.match(r.reason, /not yet aggregated/);
  });

  it('and submit to more than one calendar by default', () => {
    assert.ok(CALENDARS.length >= 2, 'one calendar is one dependency');
    assert.deepEqual([...MODES], ['stub', 'opentimestamps']);
  });
});
