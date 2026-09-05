// test/integration/runs-lifecycle.test.mjs — a run from lock to disclosed, through the real API.
//
// The loop the whole module exists to run: lock, anchor, publish, sell, pack, ship, close, disclose. Every
// step through HTTP on a booted server, so a route that exists in lib/ but is unreachable, ungated, or
// wired to the wrong function fails here rather than in a rehearsal.
//
// Artifact publishing is not exercised — that needs Shopify, which boot-server deliberately blanks. What
// IS exercised is everything that gates on it, so the refusals are real.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';
import { openDbAt } from '../../lib/db.mjs';

let srv;
after(async () => { await srv?.close(); });

const req = async (method, p, body, headers = {}) => {
  const r = await fetch(srv.base + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

const TOKEN = 'lifecycle-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const SLOTS = [
  { slot: 'slab', label: 'graded card', kind: 'inventory', qty_per_bundle: 1, singleton: true, requires_cert: true, is_chase_slot: true },
];

let runId = null;
let codes = [];

before(async () => {
  srv = await bootServer({ env: { DIAG_TOKEN: TOKEN } });
  const r = await req('POST', '/api/runs', {
    public_id: 'DEV-LC', mode: 'dev', edition: 42, name: 'Lifecycle', unit_count: 2, slots: SLOTS,
    close_by: '2027-03-31T23:59:59.000Z', sales_close_at: '2020-01-01T00:00:00.000Z',
  });
  assert.ok([200, 201].includes(r.status), `create failed: ${r.status} ${r.text.slice(0, 300)}`);
  runId = 'DEV-LC';

  // Two fabricated slabs, held and assigned. Dev runs never use real stock — their artifacts are
  // publicly fetchable from the CDN.
  for (let i = 1; i <= 2; i++) {
    const item = await req('POST', '/api/inventory/items', {
      game: 'pokemon', name: `Lifecycle Card ${i}`, number: String(400 + i), rarity: 'Art Rare',
      language: 'JA', quantity: 1, status: 'in_stock', grading_company: 'PSA', grade: 10,
      cert_number: `LC0000${i}`, set_name: 'Sample Set',
    });
    assert.ok([200, 201].includes(item.status), `stock create failed: ${item.text.slice(0, 200)}`);
    const itemId = item.json.item?.id ?? item.json.id;
    const hold = await req('POST', `/api/runs/${runId}/hold`, { kind: 'inventory', item_id: itemId });
    assert.equal(hold.status, 201, hold.text.slice(0, 200));
    const bundles = (await req('GET', `/api/runs/${runId}`)).json.bundles;
    const asg = await req('POST', `/api/runs/reservations/${hold.json.id}/assign`, {
      bundle_id: bundles[i - 1].id, slot: 'slab',
    });
    assert.equal(asg.status, 200, asg.text.slice(0, 200));
  }
  // A roll LARGER than the run, per the module's own refusal: a buyer who knows the roll would
  // otherwise know the whole set in play. Ten physical seals for two bundles.
  // 16 LOWERCASE HEX characters, which is what the module refuses anything else for. Digits are hex;
  // 'lcseal001' is not, which the first attempt at this fixture discovered.
  const roll = Array.from({ length: 10 }, (_, i) => `beef${String(i + 1).padStart(12, '0')}`);
  const seals = await req('POST', `/api/runs/${runId}/seals`, { roll });
  assert.equal(seals.status, 200, seals.text.slice(0, 200));

  // The claims. A language claim is MANDATORY here and the lock says so: the run holds JA stock, and
  // §11 refuses to let Japanese contents be omitted by choosing not to mention them.
  const claims = await req('PUT', `/api/runs/${runId}/claims`, {
    claims: [
      { claim_type: 'slot_count', subject: 'bundle', operator: 'eq', value: 'slab:1' },
      { claim_type: 'language', subject: 'bundle', operator: 'eq', value: 'JA' },
      { claim_type: 'grader', subject: 'slab', operator: 'eq', value: 'PSA' },
      { claim_type: 'min_grade', subject: 'slab', operator: 'gte', value: '10' },
    ],
  });
  assert.equal(claims.status, 200, claims.text.slice(0, 300));
}, { timeout: 120_000 });

describe('lock and anchor', () => {
  it('locks, and hands back a code per bundle', async () => {
    const r = await req('POST', `/api/runs/${runId}/lock?codes=1`, { actor: 'lifecycle' }, auth);
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.match(r.json.header_digest, /^[0-9a-f]{64}$/);
    codes = r.json.bundles.map((b) => b.code);
    assert.equal(codes.length, 2);
    for (const c of codes) assert.equal(c.length, 26);
  });

  it('and sales are SHUT until the timestamp confirms', async () => {
    const g = (await req('GET', `/api/runs/${runId}/anchors`)).json.gate;
    assert.equal(g.open, false);
    assert.ok(g.reasons.length);
  });

  it('a sale is refused while the gate is shut', async () => {
    const r = await req('POST', `/api/runs/${runId}/ledger`, { kind: 'sale_in_person', bundle_no: 1 }, auth);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'sale_gate');
  });

  it('the timestamp submits and upgrades', async () => {
    assert.equal((await req('POST', `/api/runs/${runId}/anchor`, {})).status, 201);
    const up = await req('POST', `/api/runs/${runId}/anchor/upgrade`, {});
    assert.equal(up.status, 200, up.text.slice(0, 200));
    assert.ok(up.json.anchors.some((a) => a.state === 'confirmed'));
  });

  it('but the gate STILL refuses until the artifacts are published', async () => {
    // A confirmed timestamp is not sufficient on its own. §5.7.7 requires the header, commitment and
    // blob file to be published TOO — an anchored digest nobody can fetch proves nothing to a buyer.
    const g = (await req('GET', `/api/runs/${runId}/anchors`)).json.gate;
    assert.equal(g.open, false);
    assert.ok(g.reasons.some((r) => /not published/.test(r)), JSON.stringify(g.reasons));
  });

  it('and once they are, it opens', () => {
    // PUBLISHING ITSELF IS OUT OF SCOPE HERE: it uploads to Shopify Files, and boot-server deliberately
    // blanks those credentials so no test can reach a real store. That path is covered end to end in
    // test/unit/runs-artifacts.test.mjs against an injected store, and was driven against the real dev
    // store by hand. What this file exercises is everything DOWNSTREAM of it, so the effect of a
    // successful publish is applied directly and the rest of the lifecycle runs for real.
    const db = openDbAt(process.env.TCG_TRACKER_DB);
    db.prepare("UPDATE runs SET status = 'locked_published' WHERE public_id = ?").run(runId);
  });

  it('the gate is open', async () => {
    const g = (await req('GET', `/api/runs/${runId}/anchors`)).json.gate;
    assert.equal(g.open, true, JSON.stringify(g.reasons));
  });
});

describe('the ledger records every number', () => {
  it('an in-person sale takes a number out of the available set', async () => {
    const r = await req('POST', `/api/runs/${runId}/ledger`, {
      kind: 'sale_in_person', bundle_no: 1, detail: 'event-melbourne', mirror: false,
    }, auth);
    assert.equal(r.status, 201, r.text.slice(0, 300));
    assert.deepEqual(r.json.available, [2]);
    assert.match(r.json.entry.token, /^[0-9a-f]{32}$/);
  });

  it('and the published chain verifies', async () => {
    const l = await req('GET', `/api/runs/${runId}/ledger`);
    assert.equal(l.status, 200);
    assert.equal(l.json.verified, true, JSON.stringify(l.json.errors));
    assert.equal(l.json.entries.length, 1);
  });

  it('a second sale of the same number is refused BY NAME', async () => {
    const r = await req('POST', `/api/runs/${runId}/ledger`, { kind: 'sale_in_person', bundle_no: 1, mirror: false }, auth);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'already_sold');
    assert.match(r.json.error, /001/);
  });

  it('and the close is blocked while a number is unaccounted for', async () => {
    const c = await req('GET', `/api/runs/${runId}/close-check`);
    assert.equal(c.json.can_close, false);
    assert.deepEqual(c.json.unsold, [2]);
    assert.ok(c.json.reasons.some((r) => /002/.test(r)));
  });

  it('opened_live accounts for the number nobody bought', async () => {
    // Unsold-policy v2. Without this disposition one unsellable bundle deadlocks the run permanently:
    // §5.6.6 will not close, and the policy forbids withdrawal and self-purchase.
    const r = await req('POST', `/api/runs/${runId}/ledger`, {
      kind: 'opened_live', bundle_no: 2, detail: 'stream-2026-10-01', mirror: false,
    }, auth);
    assert.equal(r.status, 201, r.text.slice(0, 300));
    assert.deepEqual(r.json.available, []);
  });
});

describe('pack, ship, close', () => {
  it('packing consumes the reservations — the caller consumeReservation never had', async () => {
    const r = await req('POST', `/api/runs/${runId}/pack`, { bundle_no: 1, actor: 'lifecycle' }, auth);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.json.packed_at);
    // A dev run is a logged no-op inside consumeReservation, so a rehearsal never touches real stock.
    assert.ok(r.json.consumed.every((c) => c.skipped === 'dev_run' || c.consumed === false));
  });

  it('and the pack is gated', async () => {
    const r = await req('POST', `/api/runs/${runId}/pack`, { bundle_no: 2 });
    assert.ok([401, 403, 503].includes(r.status), `answered ${r.status}`);
  });

  it('dispatch records that the parcel has left, and is idempotent', async () => {
    // run_bundles.shipped_at had THREE READERS AND NO WRITER: graceState takes MAX(shipped_at) to start
    // the delivery grace clock that gates disclosure, the bundle SELECT surfaces it, and appendCancel
    // refuses to cancel a sale after dispatch. With nothing writing it, the grace clock silently started
    // from the run's closed_at instead - so the wait began at the wrong moment - and a sale could be
    // cancelled after the parcel was already gone.
    const r = await req('POST', `/api/runs/${runId}/dispatch`, { bundle_no: 1, actor: 'lifecycle' }, auth);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.json.shipped_at);
    assert.equal(r.json.already, false);

    // A second click is a slip, not an error, and the FIRST timestamp is the true one.
    const again = await req('POST', `/api/runs/${runId}/dispatch`, { bundle_no: 1, actor: 'lifecycle' }, auth);
    assert.equal(again.status, 200);
    assert.equal(again.json.already, true);
    assert.equal(again.json.shipped_at, r.json.shipped_at, 'a second dispatch moved the timestamp');
  });

  it('and refuses to dispatch a bundle nobody packed', async () => {
    // Dispatch is a claim about the physical world made AFTER packing froze the parcel's contents.
    // Recording it for a bundle that was never packed records something that did not happen.
    // Bundle 2 is the one whose pack attempt was refused for want of a token just above, so it is
    // genuinely unpacked rather than merely untouched.
    const r = await req('POST', `/api/runs/${runId}/dispatch`, { bundle_no: 2, actor: 'lifecycle' }, auth);
    assert.equal(r.status, 409, r.text.slice(0, 300));
    assert.equal(r.json.code, 'not_packed');
  });

  it('and the dispatch is gated like every other write', async () => {
    const r = await req('POST', `/api/runs/${runId}/dispatch`, { bundle_no: 1 });
    assert.ok([401, 403, 503].includes(r.status), `answered ${r.status}`);
  });

  it('closes once every number is accounted for', async () => {
    const c = await req('GET', `/api/runs/${runId}/close-check`);
    assert.equal(c.json.can_close, true, JSON.stringify(c.json.reasons));
    const r = await req('POST', `/api/runs/${runId}/close`, { actor: 'lifecycle' }, auth);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.json.closed_at);
    assert.equal((await req('GET', `/api/runs/${runId}`)).json.run.status, 'closed');
  });

  it('and contents are published only now, never before', async () => {
    const r = await req('GET', `/api/runs/${runId}/contents`);
    assert.equal(r.status, 200);
    assert.ok(r.json.contents.length >= 2);
    assert.ok(r.json.contents.some((c) => c.cert_number === 'LC00001'));
  });
});

describe('disclosure waits out the delivery grace period', () => {
  it('refuses inside it, because shipped is not delivered', async () => {
    // §5.5: publishing assignments while parcels are in transit identifies who is receiving a valuable
    // one. The run closed seconds ago, so the whole 21 days are outstanding.
    const r = await req('POST', `/api/runs/${runId}/disclose`, {}, auth);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'grace_period');
    assert.equal(r.json.days, 21);
    assert.ok(r.json.ends_at);
  });

  it('and a forced dry run builds an artifact that verifies against its own commitment', async () => {
    // The load-bearing step of §5.5.2: a producer can open a committed grade 9 honestly against a claim
    // of gte 10 and pass every structural check, so the artifact is checked before it is published.
    const r = await req('POST', `/api/runs/${runId}/disclose`, { force: true, dry_run: true }, auth);
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.equal(r.json.verified, true);
    assert.ok(r.json.openings > 0);
    assert.deepEqual(r.json.tiers, ['A', 'B', 'C']);
  });

  it('and the disclosure is not published until it is', async () => {
    assert.equal((await req('GET', `/api/runs/${runId}/disclosure`)).status, 409);
  });
});
