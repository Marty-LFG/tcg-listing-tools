// test/unit/runs-artifacts.test.mjs — publishing the commitment and the blob file.
//
// No network: every Shopify call is injected. What the dev store was actually asked, once, before this
// module was written, is recorded in its header — Files accepts application/json and
// application/octet-stream, serves them byte-identical, and returns access-control-allow-origin: *.
// Those were measurements, not assumptions, and this file does not re-litigate them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import { holdForRun, assignToSlot } from '../../lib/runs-reserve.mjs';
import { lockRunPhase1, lockRunPhase2 } from '../../lib/runs-lock.mjs';
import {
  artifactFilename, uploadArtifact, verifyReadback, makeArtifactPublisher, makeAnchorer,
  artifactsFor, publishAnchorReceipt, ARTIFACT_MIME,
} from '../../lib/runs-artifacts.mjs';
import { UNSOLD_POLICY } from '../../lib/runs-policy.mjs';

const db = openDbAt(tmpFile('runs-artifacts.db'));
const enc = new TextEncoder();

// --- a fake Shopify that behaves like the real one -----------------------------------------------------

function fakeStore({ failAt = null } = {}) {
  const files = new Map();          // url -> bytes
  const calls = { stage: 0, upload: 0, create: 0, status: 0 };
  let n = 0;
  const pending = new Map();        // resourceUrl -> bytes

  const graphql = async (env, query, vars) => {
    if (query.includes('stagedUploadsCreate')) {
      calls.stage++;
      if (failAt === 'stage') return { ok: false, httpStatus: 500 };
      const resourceUrl = `res://${++n}`;
      return { ok: true, data: { stagedUploadsCreate: { stagedTargets: [{ url: 'https://upload.invalid', resourceUrl, parameters: [] }], userErrors: [] } } };
    }
    if (query.includes('fileCreate')) {
      calls.create++;
      if (failAt === 'create') return { ok: true, data: { fileCreate: { files: [], userErrors: [{ message: 'nope' }] } } };
      const gid = `gid://shopify/GenericFile/${n}`;
      const url = `https://cdn.invalid/files/${n}.bin?v=1`;
      files.set(url, pending.get(vars.files[0].originalSource));
      files.set(gid, url);
      return { ok: true, data: { fileCreate: { files: [{ id: gid, fileStatus: 'UPLOADED' }], userErrors: [] } } };
    }
    if (query.includes('GenericFile')) {
      calls.status++;
      const gid = vars.ids[0];
      return { ok: true, data: { nodes: [{ id: gid, fileStatus: 'READY', url: files.get(gid), fileErrors: [] }] } };
    }
    return { ok: false, httpStatus: 400 };
  };

  // One fetchImpl serving both roles: the staged POST, and the CDN readback.
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      calls.upload++;
      if (failAt === 'upload') return { ok: false, status: 502, text: async () => 'boom' };
      // The staged POST body is FormData; the fake records the bytes against the resourceUrl.
      const blob = opts.body.get('file');
      pending.set(`res://${n}`, new Uint8Array(await blob.arrayBuffer()));
      return { ok: true, status: 200 };
    }
    const bytes = files.get(String(url).split('#')[0]);
    if (!bytes) return { ok: false, status: 404, headers: new Headers() };
    return {
      ok: true, status: 200,
      headers: new Headers({ 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { graphql, fetchImpl, files, calls };
}

describe('artifact filenames', () => {
  const run = { public_id: 'DEV-E1' };
  it('are stable, lowercase and typed by kind', () => {
    assert.equal(artifactFilename(run, 'commitment'), 'bkr1-dev-e1-commitment.json');
    assert.equal(artifactFilename(run, 'blob'), 'bkr1-dev-e1-blob.bin');
  });

  it('and a revision gets its own name rather than reusing one', () => {
    // Shopify appends _1 on a name collision, so a second upload under one name would silently land at a
    // different URL than the one already published.
    assert.equal(artifactFilename(run, 'anchor', { seq: 2 }), 'bkr1-dev-e1-anchor-2.json');
    assert.notEqual(artifactFilename(run, 'anchor', { seq: 2 }), artifactFilename(run, 'anchor'));
  });

  it('every kind has a declared mime type', () => {
    for (const k of ['commitment', 'blob', 'anchor', 'disclosure', 'ledger']) {
      assert.ok(ARTIFACT_MIME[k], k);
    }
  });
});

describe('verifyReadback checks the bytes that came BACK', () => {
  const bytes = enc.encode('hello');
  const sha = 'aaaa';
  const serve = (body, headers = { 'access-control-allow-origin': '*' }) => async () => ({
    ok: true, status: 200, headers: new Headers(headers),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });

  it('passes when the published copy matches', async () => {
    const real = await verifyReadback('https://x.invalid/a', { fetchImpl: serve(bytes) });
    assert.equal(real.ok, true);
    const again = await verifyReadback('https://x.invalid/a', { expectSha256: real.sha256, fetchImpl: serve(bytes) });
    assert.equal(again.ok, true);
  });

  it('FAILS when the published copy differs, which is the whole point', async () => {
    // lockRunPhase2 compares the returned hash to the committed blob_hash. Handing it the hash of what we
    // believe we uploaded would make that check tautological.
    const r = await verifyReadback('https://x.invalid/a', { expectSha256: sha, fetchImpl: serve(bytes) });
    assert.equal(r.ok, false);
    assert.match(r.error, /hashes to .*, not aaaa/);
  });

  it('and fails when CORS is missing, because a third-party verifier could not read it', async () => {
    // §5.3.2 requires an independently hosted verifier to fetch the blob cross-origin. A header that
    // quietly stopped being sent would break every third-party verifier while ours kept working.
    const r = await verifyReadback('https://x.invalid/a', { fetchImpl: serve(bytes, {}) });
    assert.equal(r.ok, false);
    assert.match(r.error, /no access-control-allow-origin/);
  });

  it('and reports a dead URL rather than assuming', async () => {
    const r = await verifyReadback('https://x.invalid/gone', {
      fetchImpl: async () => ({ ok: false, status: 404, headers: new Headers() }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /404/);
  });
});

// --- a real locked run, published through an injected store -------------------------------------------

const SPECS = [
  { slot: 'slab', label: 'graded card', kind: 'inventory', qty_per_bundle: 1, max_lines: 1, singleton: 1, requires_cert: 1, is_chase_slot: 1, sort_order: 0 },
];
let n = 0;
async function lockedRun() {
  const k = ++n;
  const pid = `DEV-AR${k}`;
  db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status, close_by, sales_close_at, unsold_policy)
              VALUES (?,?,?, 'dev', 2, 'draft', '2027-03-31T23:59:59.000Z', '2027-01-31T23:59:59.000Z', ?)`)
    .run(pid, k, `Artifacts ${k}`, UNSOLD_POLICY);
  const runId = db.prepare('SELECT id FROM runs WHERE public_id = ?').get(pid).id;
  const spec = db.prepare(`INSERT INTO run_slot_specs
    (run_id, slot, label, kind, qty_per_bundle, max_lines, singleton, requires_cert, is_chase_slot, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const s of SPECS) spec.run(runId, s.slot, s.label, s.kind, s.qty_per_bundle, s.max_lines, s.singleton, s.requires_cert, s.is_chase_slot, s.sort_order);
  for (let i = 1; i <= 2; i++) {
    db.prepare('INSERT INTO run_bundles (run_id, bundle_no, label, seal_serial) VALUES (?,?,?,?)')
      .run(runId, i, `${pid}-00${i}`, `seal-${pid}-${i}`);
  }
  const c = db.prepare('INSERT INTO run_claims (run_id, claim_type, subject, operator, value) VALUES (?,?,?,?,?)');
  c.run(runId, 'slot_count', 'bundle', 'eq', 'slab:1');
  c.run(runId, 'language', 'bundle', 'eq', 'JA');
  const bundles = db.prepare('SELECT * FROM run_bundles WHERE run_id = ? ORDER BY bundle_no').all(runId);
  bundles.forEach((b, i) => {
    db.prepare(`INSERT INTO inventory_items (sku, game, name, number, rarity, language, quantity, status, grading_company, grade, cert_number, set_name)
                VALUES (?,?,?,?,?,?,1,'in_stock','PSA',10,?,?)`)
      .run(`AR-${k}-${i}`, 'pokemon', `Card ${i}`, String(300 + i), 'Art Rare', 'JA', `AC${k}${i}`, 'Sample Set');
    const item = db.prepare('SELECT id FROM inventory_items WHERE sku = ?').get(`AR-${k}-${i}`).id;
    const h = holdForRun(db, { kind: 'inventory', itemId: item, runId });
    assignToSlot(db, { reservationId: h.id, bundleId: b.id, slot: 'slab' });
  });
  const locked = await lockRunPhase1(db, runId);
  return { runId, pid, locked, run: db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) };
}

describe('phase 2 publishes, reads back, and transitions', () => {
  it('runs end to end and moves the run to locked_published', async () => {
    const { runId, run, locked } = await lockedRun();
    const store = fakeStore();
    const publisher = makeArtifactPublisher({
      env: {}, store: 'dev', fetchImpl: store.fetchImpl, graphql: store.graphql,
    });
    const out = await lockRunPhase2(db, runId, { publisher, anchorer: makeAnchorer({ mode: 'stub' }) });

    assert.equal(out.status, 'locked_published');
    // THE READ-BACK hash, not the uploaded one. Handing phase 2 the hash of what we believe we sent
    // would make its own check tautological.
    assert.equal(out.published.blobHash, run.blob_hash);
    assert.ok(out.published.urls.blob && out.published.urls.commitment);
    assert.equal(out.published.cors.blob, '*');
    assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId).status, 'locked_published');
    assert.ok(locked.headerDigest);
  });

  it('publishes the blob BEFORE the commitment that names it', async () => {
    // The commitment carries blob_hash. A commitment readable before the file it names would hand a
    // verifier a hash pointing at nothing.
    const { runId } = await lockedRun();
    const store = fakeStore();
    const order = [];
    const publisher = makeArtifactPublisher({
      env: {}, store: 'dev', fetchImpl: store.fetchImpl,
      graphql: async (env, q, v, o) => {
        if (q.includes('fileCreate')) order.push(v.files[0].alt);
        return store.graphql(env, q, v, o);
      },
    });
    await lockRunPhase2(db, runId, { publisher, anchorer: makeAnchorer({ mode: 'stub' }) });
    assert.match(order[0], /blob/, 'blob must go up first, got ' + order.join(' then '));
    assert.match(order[1], /commitment/);
  });

  it('is idempotent — a second publish is a no-op, not a second upload', async () => {
    // §5.2: the commitment is published exactly ONCE. Reissuing it would let an observer diff versions
    // and identify which bundle changed, and shipping order correlates with sale order.
    const { runId } = await lockedRun();
    const store = fakeStore();
    const publisher = makeArtifactPublisher({ env: {}, store: 'dev', fetchImpl: store.fetchImpl, graphql: store.graphql });
    await lockRunPhase2(db, runId, { publisher, anchorer: makeAnchorer({ mode: 'stub' }) });
    const after = store.calls.create;
    const again = await lockRunPhase2(db, runId, { publisher, anchorer: makeAnchorer({ mode: 'stub' }) });
    assert.equal(again.alreadyDone, true);
    assert.equal(store.calls.create, after, 'a second publish uploaded something');
  });

  it('adopts an existing file rather than littering the store on a retry', async () => {
    // Shopify Files has no bulk delete, so a retry that re-uploads leaves rubbish nobody can clear.
    const store = fakeStore();
    const opts = {
      bytes: enc.encode('same bytes every time'), filename: 'x.json', mimeType: 'application/json',
      store: 'dev', fetchImpl: store.fetchImpl, graphql: store.graphql,
    };
    const first = await uploadArtifact({}, db, opts);
    assert.equal(first.ok, true);
    assert.equal(first.adopted, false);
    const second = await uploadArtifact({}, db, opts);
    assert.equal(second.adopted, true, 'the same bytes were uploaded twice');
    assert.equal(second.url, first.url);
    assert.equal(store.calls.create, 1);
  });

  it('refuses before any network call when the stored blob does not match the commitment', async () => {
    const { runId } = await lockedRun();
    const store = fakeStore();
    db.prepare('UPDATE run_blobs SET bytes = ? WHERE run_id = ?').run(enc.encode('tampered'), runId);
    const publisher = makeArtifactPublisher({ env: {}, store: 'dev', fetchImpl: store.fetchImpl, graphql: store.graphql });
    await assert.rejects(
      () => lockRunPhase2(db, runId, { publisher, anchorer: makeAnchorer({ mode: 'stub' }) }),
      /hashes to/);
    assert.equal(store.calls.stage, 0, 'it reached the network before checking');
    assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId).status, 'locked_pending_publish');
  });
});

describe('§5.7.6 the anchor receipt is the one revisable artifact', () => {
  it('publishes separately, and each revision supersedes its predecessor', async () => {
    const { runId } = await lockedRun();
    const store = fakeStore();
    const publisher = makeArtifactPublisher({ env: {}, store: 'dev', fetchImpl: store.fetchImpl, graphql: store.graphql });
    await lockRunPhase2(db, runId, { publisher, anchorer: makeAnchorer({ mode: 'stub' }) });

    const one = await publishAnchorReceipt({}, db, { runId, store: 'dev', fetchImpl: store.fetchImpl, graphql: store.graphql });
    assert.equal(one.seq, 1);
    const two = await publishAnchorReceipt({}, db, { runId, store: 'dev', fetchImpl: store.fetchImpl, graphql: store.graphql });
    assert.equal(two.seq, 2);
    assert.equal(two.superseded, 1);

    const commit = artifactsFor(db, runId, { kind: 'commitment' })[0];
    assert.equal(commit.superseded_at, null, 'the commitment must never be superseded');
  });

  it('and the published commitment carries an EMPTY anchors array', async () => {
    // §5.2 says published once and never republished; §5.7.6 says the receipt IS revised. Both cannot
    // hold of one file, because the anchor's state flips from pending to confirmed. So the receipt lives
    // in its own artifact and the commitment stays frozen.
    const { runId } = await lockedRun();
    const store = fakeStore();
    const publisher = makeArtifactPublisher({ env: {}, store: 'dev', fetchImpl: store.fetchImpl, graphql: store.graphql });
    await lockRunPhase2(db, runId, { publisher, anchorer: makeAnchorer({ mode: 'stub' }) });
    const row = artifactsFor(db, runId, { kind: 'commitment' })[0];
    const doc = JSON.parse(new TextDecoder().decode(row.body));
    assert.deepEqual(doc.anchors, []);
    assert.ok(doc.blob_hash && doc.root && doc.header_digest);
  });

  it('and the database refuses to supersede anything except an anchor', () => {
    // §5.7.6 as a constraint rather than a comment.
    const row = db.prepare("SELECT id FROM run_artifacts WHERE kind = 'commitment' LIMIT 1").get();
    assert.throws(() => db.prepare("UPDATE run_artifacts SET superseded_at = datetime('now') WHERE id = ?").run(row.id),
      /CHECK constraint failed/);
  });
});
