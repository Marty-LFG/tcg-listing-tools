// lib/channels/shopify-media.mjs — getting composed frames onto Shopify's CDN and back as file ids.
//
// The eBay twin is lib/ebay-media.mjs and the job is the same shape: take the ordered manifest the
// compositor produced, make sure every frame exists on the channel, and hand the publisher back the
// references it needs. Everything that differs, differs for a reason worth stating.
//
// A SHOPIFY FILE IS PERMANENT; AN EPS URL IS NOT. lib/ebay-media.mjs carries expires_at and re-uploads
// on a timer because eBay's hosted urls die. A Shopify file, once READY, is forever. So this module
// caches aggressively and never revalidates — and shopify_files therefore has no expiry column, which
// is precisely why it is a separate table from listing_images rather than a channel column on it.
//
// THE CACHE KEY IS THE COMPOSITOR'S CONTENT HASH, not a product id or a SKU. That hash already means
// "these exact bytes, this art, this rail text, this frame", so two products that legitimately share an
// image upload once. Condition siblings are the case that matters: an NM and an LP of one card have
// byte-identical source art (condition deliberately never reaches the pixels — the title and alt text
// carry it), so four sibling products reference ONE file instead of minting four.
//
// AND WITHOUT THE CACHE THE PIPELINE LITTERS SILENTLY. productSet's `files` is a REPLACE list, so every
// republish sends the whole set; re-staging the same bytes each pass mints a new file every time and
// nothing collects them. Shopify Files has no bulk delete.
//
// UPLOAD IS THREE CALLS, and the middle one is not GraphQL:
//   1. stagedUploadsCreate  → a signed target + the exact form fields it demands
//   2. POST the bytes to that target (Google Cloud Storage), PARAMETERS FIRST AND THE FILE PART LAST
//   3. fileCreate           → registers the upload as a MediaImage, then it processes asynchronously
// Step 2's ordering is not a style choice: GCS rejects a body whose file part precedes its policy
// fields, and bk-shopify hit exactly that — PowerShell's form encoder stamps Content-Type onto the
// string parts and GCS answers "Malformed multipart body". A browser form post does not, which is why
// hand-building the body is the reliable path in both languages.
//
// PROCESSING IS ASYNCHRONOUS. fileCreate returns UPLOADED or PROCESSING; attaching a file to a product
// before it reaches READY is how you get a product with a broken image and no error anywhere. So this
// polls, with a cap, and reports a timeout as a timeout rather than pretending it succeeded (GR7).
import fs from 'node:fs';
import { shopifyGraphQL, firstErrorText } from './shopify-admin.mjs';
import { storeLookup, CONTENT_TYPE } from '../listing-image-store.mjs';

// Shopify's own limits, and one of ours.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;   // 20 MB, per the Files docs
export const READY_TIMEOUT_MS = 60_000;
const POLL_STEPS_MS = [400, 800, 1500, 2500, 4000, 6000, 8000, 10_000, 12_000, 15_000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the cache ----------------------------------------------------------------------------------

export function cachedFile(db, contentHash) {
  if (!db || !contentHash) return null;
  const row = db.prepare('SELECT * FROM shopify_files WHERE content_hash = ?').get(contentHash);
  // Only a READY row with an id is reusable. A 'staged' or 'failed' row is a record of an attempt, and
  // handing its half-made state to productSet would attach nothing while looking like it attached.
  return row && row.status === 'ready' && row.file_gid ? row : null;
}

/**
 * pendingFile — a row that already carries a REAL Shopify file id we never got to confirm READY.
 *
 * fileCreate is the point of no return: once it returns an id, that file exists on the store
 * permanently, whether or not our poll was still waiting when we gave up. Recording the id on those
 * paths is what lets the next attempt ADOPT the file rather than stage the same bytes again and mint a
 * second one — and Shopify Files has no bulk delete, so a duplicate per retry is a pile someone cleans
 * by hand.
 */
export function pendingFile(db, contentHash) {
  if (!db || !contentHash) return null;
  const row = db.prepare('SELECT * FROM shopify_files WHERE content_hash = ?').get(contentHash);
  return row && row.file_gid && row.status !== 'ready' ? row : null;
}

function rememberStaged(db, frame, resourceUrl) {
  if (!db) return;
  db.prepare(`INSERT INTO shopify_files (content_hash, resource_url, status, view, filename, width, height, bytes, compose_version)
              VALUES (?,?,'staged',?,?,?,?,?,?)
              ON CONFLICT(content_hash) DO UPDATE SET resource_url = excluded.resource_url, status = 'staged', error = NULL`)
    .run(frame.contentHash, resourceUrl, frame.view || null, frame.filename || null,
      frame.width || null, frame.height || null, frame.bytes || null, frame.composeVersion || null);
}
function rememberReady(db, contentHash, fileGid) {
  if (!db) return;
  db.prepare(`UPDATE shopify_files SET file_gid = ?, status = 'ready', ready_at = datetime('now'), error = NULL
              WHERE content_hash = ?`).run(fileGid, contentHash);
}
// A TIMEOUT IS NOT A FAILURE — it is an unfinished wait, and the file it was waiting on is almost
// always READY moments later. Keeping that as its own state is what lets the retry re-poll instead of
// re-upload. The gid is the whole point of the row.
function rememberProcessing(db, contentHash, fileGid, error) {
  if (!db) return;
  db.prepare(`INSERT INTO shopify_files (content_hash, file_gid, status, error) VALUES (?,?,'processing',?)
              ON CONFLICT(content_hash) DO UPDATE SET file_gid = excluded.file_gid, status = 'processing', error = excluded.error`)
    .run(contentHash, fileGid, String(error || '').slice(0, 500));
}
// fileGid is optional because the earlier exits — staging, the POST, fileCreate itself — genuinely have
// no file to name. When there IS one it is recorded even on a failure, so the orphan is accounted for
// rather than invisible, and COALESCE means a later gidless failure never erases an id we already knew.
function rememberFailed(db, contentHash, error, fileGid = null) {
  if (!db) return;
  db.prepare(`INSERT INTO shopify_files (content_hash, file_gid, status, error) VALUES (?,?,'failed',?)
              ON CONFLICT(content_hash) DO UPDATE SET file_gid = COALESCE(excluded.file_gid, shopify_files.file_gid),
                                                     status = 'failed', error = excluded.error`)
    .run(contentHash, fileGid, String(error || '').slice(0, 500));
}

// --- the three calls ----------------------------------------------------------------------------

const STAGED_UPLOADS = `
mutation Stage($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const FILE_CREATE = `
mutation Create($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { id fileStatus alt ... on MediaImage { image { width height } } }
    userErrors { field message code }
  }
}`;

const FILE_STATUS = `
query Status($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on MediaImage { id fileStatus fileErrors { code details message } }
  }
}`;

/**
 * postToStagedTarget — step 2. Deliberately NOT using FormData's own field ordering by accident: the
 * signed parameters are appended first, in the order Shopify returned them, and the file part last.
 * GCS validates the policy fields as it streams, so a file part that arrives first is rejected before
 * the policy is ever read.
 *
 * fetchImpl is injectable so the whole path is testable without a network.
 */
export async function postToStagedTarget(target, bytes, { filename, mimeType, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const form = new FormData();
  for (const p of target.parameters || []) form.append(p.name, p.value);
  form.append('file', new Blob([bytes], { type: mimeType }), filename);
  const r = await doFetch(target.url, { method: 'POST', body: form });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, error: `staged upload ${r.status}: ${body.slice(0, 400)}` };
  }
  return { ok: true };
}

async function waitForReady(env, ids, { store, fetchImpl, timeoutMs = READY_TIMEOUT_MS } = {}) {
  const pending = new Set(ids);
  const ready = new Map();
  const started = Date.now();
  for (let i = 0; pending.size; i++) {
    if (Date.now() - started > timeoutMs) break;
    await sleep(POLL_STEPS_MS[Math.min(i, POLL_STEPS_MS.length - 1)]);
    const res = await shopifyGraphQL(env, FILE_STATUS, { ids: [...pending] }, { store, estimate: 10, fetchImpl });
    if (!res.ok) continue;                        // a transient read must not condemn the file
    for (const n of res.data?.nodes || []) {
      if (!n || !n.id) continue;
      if (n.fileStatus === 'READY') { ready.set(n.id, n); pending.delete(n.id); }
      else if (n.fileStatus === 'FAILED') {
        ready.set(n.id, { ...n, failed: (n.fileErrors || []).map((e) => e.message).join('; ') || 'FAILED' });
        pending.delete(n.id);
      }
    }
  }
  return { ready, timedOut: [...pending] };
}

// --- the pipeline -------------------------------------------------------------------------------

/**
 * ensureShopifyMedia(env, db, { imageSet, store, fetchImpl }) — make every frame in the set exist on
 * Shopify, and return what a publish needs.
 *
 * Returns { ok, fileGids, ogFileGid, uploaded, reused, adopted, warnings, errors }:
 *   fileGids   ordered bare file GIDs, position 1 first — the gallery order IS array order, and
 *              buildImageSet already guarantees the real card is position 1 (it throws otherwise).
 *              Named to match publishProduct's parameter exactly, so the two are wired as
 *              `{ fileGids, ogFileGid }` with no adapter and nothing to mis-shape between them.
 *   ogFileGid  the social card's file id for the bkc.og_image metafield, or null. NEVER in `fileGids`:
 *              it is not a product image and must not appear in the gallery strip.
 *   adopted    frames resolved by re-polling a file a previous attempt had already created, rather
 *              than by uploading. A non-zero count here means an earlier run timed out mid-processing
 *              and this one picked it up instead of minting a duplicate.
 *
 * Never throws. A frame that cannot be uploaded is reported and omitted, because a product with three
 * of its four images is a better outcome than no product — EXCEPT position 1, which is the actual card
 * and whose loss is reported as an error rather than a warning.
 */
export async function ensureShopifyMedia(env, db, { imageSet, store = 'dev', fetchImpl, timeoutMs } = {}) {
  const out = { ok: true, fileGids: [], ogFileGid: null, uploaded: 0, reused: 0, adopted: 0, warnings: [], errors: [] };
  if (!imageSet) { out.ok = false; out.errors.push('no image set'); return out; }

  // The social card rides along through the same upload path and is separated at the end. One pass,
  // one poll, and the og card cannot be forgotten by a caller that only iterates `images`.
  const frames = [...(imageSet.images || []), ...(imageSet.social ? [{ ...imageSet.social, position: null }] : [])];
  if (!frames.length) { out.warnings.push('the image set is empty — the product would publish with no media'); return out; }

  const needed = [];
  const resolved = new Map();                      // contentHash -> file gid

  for (const frame of frames) {
    const hit = cachedFile(db, frame.contentHash);
    if (hit) { resolved.set(frame.contentHash, hit.file_gid); out.reused++; continue; }
    if (resolved.has(frame.contentHash) || needed.some((n) => n.contentHash === frame.contentHash)) continue;
    needed.push(frame);
  }

  for (const frame of needed) {
    const r = await uploadFrame(env, db, frame, { store, fetchImpl, timeoutMs });
    if (r.ok) { resolved.set(frame.contentHash, r.fileGid); out.uploaded++; if (r.adopted) out.adopted = (out.adopted || 0) + 1; }
    else {
      // uploadFrame records its OWN state whenever it got far enough to have a file id, and that state
      // is deliberately finer than this one: 'processing' means "come back and re-poll", 'failed' means
      // "this will not get better". Overwriting either with a blanket failure here would throw away the
      // resume — so only rows it could not classify are marked from out here.
      if (!r.fileGid) rememberFailed(db, frame.contentHash, r.error);
      const where = frame.position === 1 ? 'errors' : 'warnings';
      out[where].push(`${frame.filename || frame.view}: ${r.error}`);
      if (where === 'errors') out.ok = false;
    }
  }

  // BARE GIDS, IN POSITION ORDER, under the exact name publishProduct takes.
  //
  // This used to emit { originalSource: gid, alt, contentType } — the FileSetInput shape — and that was
  // wrong twice over. originalSource takes a URL and MINTS A NEW FILE; `id` is the field that
  // references one that already exists, so the old shape would have re-uploaded every frame on every
  // republish, which is the precise litter this module's cache exists to prevent. It also could not
  // physically connect: buildProductSetInput maps `fileGids.map((id) => ({ id }))`, so an array of
  // objects would have produced { id: { originalSource: ... } } and attached nothing.
  //
  // The name matches publishProduct's parameter deliberately, so the two sides are wired by
  // `{ fileGids, ogFileGid }` with no adapter in between and nothing to get subtly wrong. alt does not
  // travel: it is set at fileCreate time so it belongs to the file itself and stays right when several
  // sibling products reference the same one.
  for (const frame of imageSet.images || []) {
    const gid = resolved.get(frame.contentHash);
    if (!gid) continue;
    out.fileGids.push(gid);
  }
  if (imageSet.social) out.ogFileGid = resolved.get(imageSet.social.contentHash) || null;

  if (!out.fileGids.length && out.ok) {
    out.ok = false;
    out.errors.push('no image survived upload — position 1 must be the actual card');
  }
  return out;
}

async function uploadFrame(env, db, frame, { store, fetchImpl, timeoutMs } = {}) {
  // 0a — ADOPT before uploading. A previous attempt may have got a real file id out of fileCreate and
  // then run out of patience waiting for it to process. That file is on the store either way, so the
  // cheap, correct move is to ask how it is doing rather than make another one. This is the difference
  // between a retry that resumes and a retry that litters.
  const pending = pendingFile(db, frame.contentHash);
  if (pending) {
    const { ready } = await waitForReady(env, [pending.file_gid], { store, fetchImpl, timeoutMs });
    const node = ready.get(pending.file_gid);
    if (node && !node.failed) {
      rememberReady(db, frame.contentHash, pending.file_gid);
      return { ok: true, fileGid: pending.file_gid, adopted: true };
    }
    // Genuinely FAILED, or still not finished. Fall through and upload — but the id stays on the row,
    // so the file is at least nameable when someone comes to clear it out.
    if (node?.failed) rememberFailed(db, frame.contentHash, 'Shopify failed to process the image: ' + node.failed, pending.file_gid);
  }

  // 0b — the bytes. The compositor already wrote them to the content-addressed store, so the hash IS
  // the lookup. A miss here means the store was pruned between compose and publish.
  const found = storeLookup(frame.contentHash);
  if (!found) return { ok: false, error: `no bytes in the image store for ${frame.contentHash}` };
  let bytes;
  try { bytes = fs.readFileSync(found.file); } catch (e) { return { ok: false, error: 'read failed: ' + (e?.message || e) }; }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: `${bytes.length} bytes is over Shopify's ${MAX_IMAGE_BYTES}-byte image limit` };
  }
  const mimeType = CONTENT_TYPE[found.ext] || 'image/jpeg';
  const filename = frame.filename || `${frame.contentHash}.${found.ext}`;

  // 1 — ask for a signed target. fileSize is a STRING in this input, which is easy to get wrong.
  const staged = await shopifyGraphQL(env, STAGED_UPLOADS, {
    input: [{ filename, mimeType, resource: 'IMAGE', httpMethod: 'POST', fileSize: String(bytes.length) }],
  }, { store, estimate: 10, fetchImpl });
  if (!staged.ok) return { ok: false, error: 'stagedUploadsCreate: ' + (firstErrorText(staged) || `HTTP ${staged.httpStatus}`) };
  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) return { ok: false, error: 'stagedUploadsCreate returned no target' };

  // 2 — the bytes themselves, straight to GCS. Not GraphQL, not through the throttle.
  const put = await postToStagedTarget(target, bytes, { filename, mimeType, fetchImpl });
  if (!put.ok) return { ok: false, error: put.error };
  rememberStaged(db, frame, target.resourceUrl);

  // 3 — register it. alt is set HERE rather than at attach time so it travels with the file and is
  // right even when the same file is referenced by several sibling products.
  const created = await shopifyGraphQL(env, FILE_CREATE, {
    files: [{ originalSource: target.resourceUrl, contentType: 'IMAGE', alt: frame.alt || '' }],
  }, { store, estimate: 15, fetchImpl });
  if (!created.ok) return { ok: false, error: 'fileCreate: ' + (firstErrorText(created) || `HTTP ${created.httpStatus}`) };
  const file = created.data?.fileCreate?.files?.[0];
  if (!file?.id) return { ok: false, error: 'fileCreate returned no file id' };

  // 4 — READY, or say why not. Attaching a PROCESSING file yields a product with a broken image and
  // no error anywhere, which is the failure this wait exists to prevent.
  //
  // ⚠ BOTH EXITS BELOW RECORD file.id BEFORE RETURNING. fileCreate is the point of no return: the file
  // now exists on the store permanently, and a plain `return { ok: false }` would drop the only handle
  // we will ever have on it — so the next attempt would upload the same bytes again and the store
  // would accumulate one unreachable duplicate per retry, in a Files area with no bulk delete.
  if (file.fileStatus !== 'READY') {
    const { ready, timedOut } = await waitForReady(env, [file.id], { store, fetchImpl, timeoutMs });
    const node = ready.get(file.id);
    if (timedOut.length) {
      const error = `still processing after ${(timeoutMs || READY_TIMEOUT_MS) / 1000}s`;
      rememberProcessing(db, frame.contentHash, file.id, error);
      return { ok: false, error, fileGid: file.id };
    }
    if (node?.failed) {
      const error = 'Shopify failed to process the image: ' + node.failed;
      rememberFailed(db, frame.contentHash, error, file.id);
      return { ok: false, error, fileGid: file.id };
    }
  }

  rememberReady(db, frame.contentHash, file.id);
  return { ok: true, fileGid: file.id };
}
