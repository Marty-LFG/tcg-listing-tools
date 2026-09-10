// lib/runs-artifacts.mjs — publishing the run's artifacts to Shopify Files.
//
// This supplies the `publisher` and `anchorer` that lockRunPhase2 has taken as injections since R2-3 and
// that nothing has ever provided. Until now phase 2 could not run at all, so no run could reach
// `locked_published`, so §5.7.7's sale gate could never open.
//
// WHY A CDN AND NOT OUR OWN SERVER. §5.3.2: verification must not depend on us being reachable. This app
// is LAN-only, and a buyer scanning an insert at 11pm on a public holiday must not get a connection
// refused. The commitment and the blob file are static bytes that reveal nothing, so they belong
// somewhere that stays up when we do not.
//
// MEASURED, NOT ASSUMED. Before this module was written, both questions it rests on were put to the dev
// store directly: Shopify Files accepts `application/json` and `application/octet-stream` as generic
// files, serves them back byte-identical under those content types, and returns
// `access-control-allow-origin: *` both with and without an Origin header — so the independently hosted
// verifier of §8.2 can fetch the blob cross-origin. Had CORS been absent, the whole artifact-hosting
// decision would have had to change, and finding that out after building against it would have been the
// expensive way.
//
// THE COMMITMENT PUBLISHES WITH AN EMPTY `anchors` ARRAY. §5.2 lists the field and says the commitment is
// published exactly once and never republished; §5.7.6 says the receipt IS revised as it upgrades from
// pending to confirmed. Both cannot hold of one file, because the anchor's state flips. So the receipt
// lives in its own artifact — the one thing §5.7.6 permits to be revised — and the commitment stays
// frozen. The privacy reason for never republishing the commitment survives intact: anchors carry nothing
// per-bundle, so there is nothing in the revisable file to diff.

import { shopifyGraphQL, firstErrorText } from './channels/shopify-admin.mjs';
import { postToStagedTarget } from './channels/shopify-media.mjs';
import { commitment, verifyCommitment } from './runs-public.mjs';
import { blobHash } from './runs-blob.mjs';
import { toHex } from './runs-canonical.mjs';
import { submitAnchor, anchorsFor } from './runs-anchor.mjs';
import { rarityTable as defaultRarityTable } from './runs-rarity.mjs';
import { audit } from './runs-reserve.mjs';

export const ARTIFACT_MIME = Object.freeze({
  commitment: 'application/json',
  blob: 'application/octet-stream',
  anchor: 'application/json',
  disclosure: 'application/json',
  ledger: 'application/json',
});
const EXT = Object.freeze({ commitment: 'json', blob: 'bin', anchor: 'json', disclosure: 'json', ledger: 'json' });

export const READY_TIMEOUT_MS = 60_000;
const POLL_STEPS_MS = [500, 900, 1500, 2500, 4000, 6000, 8000, 12_000, 15_000];

const STAGE = `mutation Stage($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  } }`;
const CREATE = `mutation Create($files: [FileCreateInput!]!) {
  fileCreate(files: $files) { files { id fileStatus } userErrors { field message code } } }`;
// GenericFile, not MediaImage — a JSON document has no `image` and carries the `url` this module needs.
const STATUS = `query S($ids: [ID!]!) { nodes(ids: $ids) {
  ... on GenericFile { id fileStatus url fileErrors { code details message } } } }`;

const sha256Hex = async (bytes) =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

/**
 * The published name.
 *
 * STABLE, AND NEVER REUSED. Shopify appends `_1` on a name collision, so a second upload under one name
 * would silently land at a different URL than the one already published. The content-hash cache below is
 * what guarantees the same bytes are never uploaded twice; this is what guarantees different bytes never
 * share a name.
 */
export function artifactFilename(run, kind, { seq = 1 } = {}) {
  const base = `bkr1-${String(run.public_id).toLowerCase()}-${kind}`;
  return `${seq > 1 ? `${base}-${seq}` : base}.${EXT[kind] || 'bin'}`;
}

/** What we already have on the store for these exact bytes, if anything. */
export function cachedArtifact(db, sha) {
  return db.prepare("SELECT * FROM shopify_files WHERE content_hash = ? AND status = 'ready'").get(sha);
}

/**
 * Stage, POST, register, wait for READY, and return the URL.
 *
 * ADOPTS BEFORE UPLOADING. A previous attempt may have got a real file id out of fileCreate and then
 * failed on the readback, and Shopify Files has no bulk delete — so a retry that re-uploads leaves
 * litter nobody can clear. Keyed on the content hash, so identical bytes always resolve to one file.
 */
export async function uploadArtifact(env, db, {
  bytes, filename, mimeType, store = 'dev', fetchImpl, timeoutMs = READY_TIMEOUT_MS, graphql = null,
} = {}) {
  const sha = await sha256Hex(bytes);
  const hit = cachedArtifact(db, sha);
  if (hit?.file_gid && hit.url) return { ok: true, fileGid: hit.file_gid, url: hit.url, sha256: sha, adopted: true };

  // Injectable for tests, defaulting to the real client. ES module bindings cannot be reassigned, so
  // a seam has to be a parameter - the same shape assertStoreIdentity in runs-arm.mjs uses.
  const call = graphql || shopifyGraphQL;
  const gql = (q, v, estimate) => call(env, q, v, { store, estimate, fetchImpl });

  db.prepare(`INSERT INTO shopify_files (content_hash, status, filename, bytes, mime_type)
              VALUES (?, 'staged', ?, ?, ?)
              ON CONFLICT(content_hash) DO UPDATE SET status='staged', filename=excluded.filename,
                bytes=excluded.bytes, mime_type=excluded.mime_type`)
    .run(sha, filename, bytes.length, mimeType);

  const staged = await gql(STAGE, {
    input: [{ filename, mimeType, resource: 'FILE', httpMethod: 'POST', fileSize: String(bytes.length) }],
  }, 10);
  if (!staged.ok) return fail(db, sha, `stagedUploadsCreate: ${firstErrorText(staged) || `HTTP ${staged.httpStatus}`}`, sha);
  const ue = staged.data?.stagedUploadsCreate?.userErrors || [];
  if (ue.length) return fail(db, sha, `stagedUploadsCreate: ${ue.map((e) => e.message).join('; ')}`, sha);
  const target = staged.data.stagedUploadsCreate.stagedTargets?.[0];
  if (!target?.resourceUrl) return fail(db, sha, 'stagedUploadsCreate returned no target', sha);

  const put = await postToStagedTarget(target, bytes, { filename, mimeType, fetchImpl });
  if (!put.ok) return fail(db, sha, put.error || 'staged upload failed', sha);

  const created = await gql(CREATE, {
    files: [{ originalSource: target.resourceUrl, contentType: 'FILE', alt: `bkr1 ${filename}` }],
  }, 10);
  if (!created.ok) return fail(db, sha, `fileCreate: ${firstErrorText(created) || `HTTP ${created.httpStatus}`}`, sha);
  const cerr = created.data?.fileCreate?.userErrors || [];
  if (cerr.length) return fail(db, sha, `fileCreate: ${cerr.map((e) => e.message).join('; ')}`, sha);
  const fileGid = created.data.fileCreate.files?.[0]?.id;
  if (!fileGid) return fail(db, sha, 'fileCreate returned no file id', sha);
  // Recorded the instant it exists: past this point the file is on the store whatever happens next, and
  // a retry that did not know about it would create a second one.
  db.prepare("UPDATE shopify_files SET file_gid = ?, status = 'staged' WHERE content_hash = ?").run(fileGid, sha);

  const started = Date.now();
  for (const wait of POLL_STEPS_MS) {
    if (Date.now() - started > timeoutMs) break;
    await new Promise((r) => setTimeout(r, wait));
    const st = await gql(STATUS, { ids: [fileGid] }, 5);
    const node = st.data?.nodes?.[0];
    if (node?.fileErrors?.length) {
      return fail(db, sha, `file processing: ${node.fileErrors.map((e) => e.message).join('; ')}`, sha, fileGid);
    }
    if (node?.fileStatus === 'READY' && node.url) {
      db.prepare("UPDATE shopify_files SET status='ready', url=?, ready_at=datetime('now') WHERE content_hash=?")
        .run(node.url, sha);
      return { ok: true, fileGid, url: node.url, sha256: sha, adopted: false };
    }
  }
  return fail(db, sha, 'file never became READY', sha, fileGid);
}

function fail(db, sha, error, _sha, fileGid = null) {
  try {
    db.prepare("UPDATE shopify_files SET status='failed', error=?, file_gid=COALESCE(?, file_gid) WHERE content_hash=?")
      .run(String(error).slice(0, 500), fileGid, sha);
  } catch { /* the cache row is a convenience, never the reason a publish fails */ }
  return { ok: false, error, sha256: sha, fileGid };
}

/**
 * Fetch what was actually published and prove it is what we sent.
 *
 * THE POINT IS THE BYTES THAT CAME BACK, not the ones we believe we sent. lockRunPhase2 compares the
 * returned hash to the committed `blob_hash` and throws on a mismatch; handing it the upload's own hash
 * would make that check tautological.
 *
 * CORS is checked here too rather than trusted, because §5.3.2 requires an independently hosted verifier
 * to fetch the blob cross-origin, and a header that quietly stops being sent would break every third-party
 * verifier while ours kept working.
 */
export async function verifyReadback(url, { expectSha256 = null, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(url, { headers: { origin: 'https://example.invalid' } });
  if (!res.ok) return { ok: false, error: `readback HTTP ${res.status}` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha = await sha256Hex(bytes);
  const cors = res.headers.get('access-control-allow-origin');
  const out = { ok: true, sha256: sha, byteLength: bytes.length, cors, contentType: res.headers.get('content-type') };
  if (expectSha256 && sha !== expectSha256) {
    return { ...out, ok: false, error: `the published copy hashes to ${sha}, not ${expectSha256}` };
  }
  if (!cors) return { ...out, ok: false, error: 'the published copy carries no access-control-allow-origin' };
  return out;
}

export function recordArtifact(db, { runId, kind, seq = 1, sha256, byteLength, mimeType, body = null, fileGid, url, store, readback = true }) {
  db.prepare(`INSERT INTO run_artifacts (run_id, kind, seq, sha256, byte_length, mime_type, body, file_gid, url, store, readback_at)
              VALUES (?,?,?,?,?,?,?,?,?,?, ${readback ? "datetime('now')" : 'NULL'})
              ON CONFLICT(run_id, kind, seq) DO UPDATE SET
                sha256=excluded.sha256, byte_length=excluded.byte_length, mime_type=excluded.mime_type,
                body=excluded.body, file_gid=excluded.file_gid, url=excluded.url, store=excluded.store,
                readback_at=excluded.readback_at`)
    .run(runId, kind, seq, sha256, byteLength, mimeType, body, fileGid, url, store);
  return db.prepare('SELECT * FROM run_artifacts WHERE run_id = ? AND kind = ? AND seq = ?').get(runId, kind, seq);
}

export const artifactsFor = (db, runId, { kind = null } = {}) => (kind
  ? db.prepare('SELECT * FROM run_artifacts WHERE run_id = ? AND kind = ? ORDER BY seq').all(runId, kind)
  : db.prepare('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY kind, seq').all(runId));

/**
 * The `publisher` lockRunPhase2 calls. A factory, so phase 2 needs no change.
 *
 * Order matters: the blob goes up FIRST. The commitment publishes `blob_hash`, so a commitment readable
 * before the file it names would give a verifier a hash pointing at nothing.
 */
export function makeArtifactPublisher({
  env, store = 'dev', fetchImpl, rarityTable = null, timeoutMs, graphql = null,
} = {}) {
  return async ({ db, run, blob }) => {
    const steps = [];
    if (!blob) throw new Error(`run ${run.public_id} has no blob bytes to publish`);

    const localBlobHash = await blobHash(blob);
    if (localBlobHash !== run.blob_hash) {
      // Before any network call: if what we hold does not match what was committed, publishing it would
      // put the wrong bytes at a URL the anchored digest vouches for.
      throw new Error(`the stored blob hashes to ${localBlobHash}, not the committed ${run.blob_hash}`);
    }

    const up = async (kind, bytes) => {
      const filename = artifactFilename(run, kind);
      const r = await uploadArtifact(env, db, {
        bytes, filename, mimeType: ARTIFACT_MIME[kind], store, fetchImpl, timeoutMs, graphql,
      });
      steps.push({ step: kind, ok: r.ok, adopted: !!r.adopted, url: r.url || null, error: r.error || null });
      if (!r.ok) throw new Error(`publishing the ${kind}: ${r.error}`);
      return r;
    };

    const blobUp = await up('blob', blob);

    const table = rarityTable || await defaultRarityTable();
    // anchors: [] — see the module header. The receipt is its own revisable artifact.
    const doc = commitment(db, run.id, { rarityTable: table, anchors: [] });
    await verifyCommitment(doc);
    const commitBytes = new TextEncoder().encode(JSON.stringify(doc, null, 2));
    const commitUp = await up('commitment', commitBytes);

    const blobBack = await verifyReadback(blobUp.url, { expectSha256: run.blob_hash, fetchImpl });
    steps.push({ step: 'blob_readback', ok: blobBack.ok, cors: blobBack.cors, error: blobBack.error || null });
    if (!blobBack.ok) throw new Error(`the published blob did not read back: ${blobBack.error}`);

    const commitBack = await verifyReadback(commitUp.url, { expectSha256: commitUp.sha256, fetchImpl });
    steps.push({ step: 'commitment_readback', ok: commitBack.ok, cors: commitBack.cors, error: commitBack.error || null });
    if (!commitBack.ok) throw new Error(`the published commitment did not read back: ${commitBack.error}`);

    recordArtifact(db, {
      runId: run.id, kind: 'blob', sha256: run.blob_hash, byteLength: blob.length,
      mimeType: ARTIFACT_MIME.blob, body: null, fileGid: blobUp.fileGid, url: blobUp.url, store,
    });
    recordArtifact(db, {
      runId: run.id, kind: 'commitment', sha256: commitUp.sha256, byteLength: commitBytes.length,
      mimeType: ARTIFACT_MIME.commitment, body: commitBytes, fileGid: commitUp.fileGid, url: commitUp.url, store,
    });

    return {
      // The hash of the bytes READ BACK from the CDN, which is what phase 2's check is for.
      blobHash: blobBack.sha256,
      commitmentHash: commitBack.sha256,
      urls: { blob: blobUp.url, commitment: commitUp.url },
      cors: { blob: blobBack.cors, commitment: commitBack.cors },
      steps,
    };
  };
}

/** The `anchorer` lockRunPhase2 calls. Submits the header digest; the sweep upgrades it later. */
export function makeAnchorer({ mode = 'stub', actor = null } = {}) {
  return async ({ db, run, digest }) =>
    submitAnchor(db, { runId: run.id, digest, scope: 'header', mode, actor });
}

/**
 * §5.7.6: publish the anchor receipt, and revise it when it upgrades.
 *
 * THE ONLY ARTIFACT THAT MAY EVER BE REVISED, which is why it is a separate file from the commitment.
 * Storing the receipt only in our database would make verification contingent on our infrastructure
 * surviving, which is the thing §5.3.2 exists to avoid.
 */
export async function publishAnchorReceipt(env, db, {
  runId, store = 'dev', fetchImpl, actor = null, graphql = null,
} = {}) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(+runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  const anchors = anchorsFor(db, run.id, { scope: 'header' });
  if (!anchors.length) return { skipped: 'nothing submitted yet' };

  const doc = {
    v: 2,
    run: run.public_id,
    header_digest: run.header_digest,
    // The receipt bytes themselves are offered for download beside this; §5.7.4 is emphatic that we do
    // not parse them, so this document says what state they are in and nothing about what they contain.
    anchors,
    note: 'A pending timestamp is not yet independently checkable. Verify at https://opentimestamps.org/',
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc, null, 2));
  const prior = artifactsFor(db, run.id, { kind: 'anchor' });
  const seq = prior.length ? Math.max(...prior.map((a) => a.seq)) + 1 : 1;

  const r = await uploadArtifact(env, db, {
    bytes, filename: artifactFilename(run, 'anchor', { seq }),
    mimeType: ARTIFACT_MIME.anchor, store, fetchImpl, graphql,
  });
  if (!r.ok) throw new Error(`publishing the anchor receipt: ${r.error}`);
  const back = await verifyReadback(r.url, { expectSha256: r.sha256, fetchImpl });
  if (!back.ok) throw new Error(`the published receipt did not read back: ${back.error}`);

  for (const p of prior) {
    db.prepare("UPDATE run_artifacts SET superseded_at = datetime('now') WHERE id = ? AND superseded_at IS NULL").run(p.id);
  }
  const row = recordArtifact(db, {
    runId: run.id, kind: 'anchor', seq, sha256: r.sha256, byteLength: bytes.length,
    mimeType: ARTIFACT_MIME.anchor, body: bytes, fileGid: r.fileGid, url: r.url, store,
  });
  audit(db, { runId: run.id, entity: 'run_artifacts', entityId: row.id, action: 'anchor_published', actor,
    after: { seq, url: r.url, states: anchors.map((a) => a.state) } });
  return { ok: true, seq, url: r.url, superseded: prior.length };
}
