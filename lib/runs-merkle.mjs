// lib/runs-merkle.mjs — the two Merkle trees, their proofs, and selective disclosure.
// See docs/RUNS_PLAN.md §4.6-§4.9.
//
// ISOMORPHIC. Served to the browser and imported by the public verification page, because a buyer has to
// be able to recompute their own bundle's hash without trusting anything we run. WebCrypto only; nothing
// from node:.
//
// EVERYTHING HERE IS ANCHORED. A change to any function below does not fail a test — it silently makes
// every commitment already timestamped into Bitcoin unverifiable, on a page a customer is looking at,
// months later. The vectors in test/unit/runs-merkle.test.mjs are the specification's own and are the
// only thing standing between a tidy-up and a run nobody can check.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// THE TREE SHAPE IS OURS, AND IT IS NEITHER OF THE TWO YOU WOULD GUESS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   NOT BITCOIN'S. Bitcoin duplicates the last hash on an odd level, which admits CVE-2012-2459: two
//   different leaf sets produce the same root. We PROMOTE the odd node unchanged, and a test asserts the
//   two rules give different roots over the same three leaves — because "we did not do that" is only
//   worth saying if something checks.
//
//   NOT RFC 6962'S. That splits at the largest power of two below n, giving a different tree again. We
//   borrow its domain-separation prefixes and specify our own shape.
//
// THE ONE-BYTE PREFIXES ARE THE SECOND-PREIMAGE DEFENCE. Without them a 64-byte "leaf" that is really two
// concatenated node hashes verifies as a leaf, and a tree can be presented as having contents it does not
// have. 0x02 additionally stops an attribute commitment being read as an internal node.
import { ns, normalizeValue, toHex, fromHex } from './runs-canonical.mjs';

const utf8 = new TextEncoder();

// One hex parser for the whole canon, not a copy per module. lib/normalize.mjs is the standing lesson:
// a hand-maintained mirror drifts, and here a drift means the verifier and the producer disagree about
// what a digest is.
const bytes = (hex) => fromHex(hex, 32);

async function sha256(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { buf.set(p, at); at += p.length; }
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}

// --- salts --------------------------------------------------------------------------------------------

/**
 * §4.6: attrSalt(name) = HMAC-SHA256(key = bundleSalt, message = "BKR1/attr/" + name), lowercase hex.
 *
 * HMAC RATHER THAN SHA256(salt ‖ name), and the difference is the whole of §4.9. HMAC is a pseudorandom
 * function, so publishing ONE attribute's salt reveals neither the bundle salt nor any other attribute's
 * salt — which is what makes it safe to open `bundle.is_chase` at close while every cert stays sealed.
 * A plain concatenation would leak through length-extension and through the shared prefix.
 */
export async function attrSalt(bundleSaltHex, name) {
  const key = await crypto.subtle.importKey('raw', bytes(bundleSaltHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8.encode('BKR1/attr/' + name))));
}

// --- commitments --------------------------------------------------------------------------------------

/** §4.7: commit(name, value) = SHA-256( 0x02 || UTF8( ns(name) || ns(attrSaltHex) || ns(value) ) ) */
export async function commit(name, value, saltHex) {
  const body = utf8.encode(ns(name) + ns(saltHex) + ns(normalizeValue(value)));
  return sha256(new Uint8Array([0x02]), body);
}

/** §4.7: node(l, r) = SHA-256( 0x01 || l || r ) over RAW 32-byte inputs, not their hex text. */
export const node = (l, r) => sha256(new Uint8Array([0x01]), bytes(l), bytes(r));

/** §4.7: leaf(bundle) = SHA-256( 0x00 || bundleRoot ) */
export const leafOf = (bundleRootHex) => sha256(new Uint8Array([0x00]), bytes(bundleRootHex));

/** §4.7: codeLeaf(i) = SHA-256( 0x04 || blobKey(i) ) — the KEY, never the raw code. */
export const codeLeaf = (blobKeyHex) => sha256(new Uint8Array([0x04]), bytes(blobKeyHex));

// --- the tree -------------------------------------------------------------------------------------------

/**
 * Build every level, bottom up, pairing left to right and PROMOTING an odd last node unchanged.
 *
 * Returned as levels rather than just a root because a proof needs them, and recomputing the tree per
 * proof over a 25-bundle run is work nobody needs to repeat.
 */
async function levels(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    // §4.8: n = 0 is INVALID. An empty tree has no root, and returning some conventional value for one
    // is how a run with no bundles would acquire a commitment.
    throw new Error('a Merkle tree over zero leaves is invalid; there is nothing to commit to');
  }
  if (new Set(inputs).size !== inputs.length) {
    // §4.8: duplicate leaves are invalid at BOTH levels. Two identical leaves make one index
    // indistinguishable from another, which is exactly what an index-bound proof exists to prevent.
    throw new Error('duplicate leaves: a tree with two identical inputs cannot bind a proof to one index');
  }
  for (const h of inputs) bytes(h);

  const out = [inputs.slice()];
  let cur = inputs.slice();
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      // The promote. NOT a duplicate of cur[i] — that is Bitcoin's rule and CVE-2012-2459 with it.
      next.push(i + 1 < cur.length ? await node(cur[i], cur[i + 1]) : cur[i]);
    }
    out.push(next);
    cur = next;
  }
  return out;
}

/** The root. §4.8: for n = 1 the root IS the sole input, unhashed. */
export async function merkleRoot(inputs) {
  const ls = await levels(inputs);
  return ls[ls.length - 1][0];
}

/**
 * §4.9: the proof for one index, bottom-up. `side` names which side the SIBLING is on.
 *
 * A PROMOTED NODE CONTRIBUTES NO STEP at that level, which is what makes the walk hand-checkable and why
 * proof lengths vary by index rather than being uniformly ceil(log2 n).
 */
export async function merkleProof(inputs, index) {
  const ls = await levels(inputs);
  if (!Number.isInteger(index) || index < 0 || index >= inputs.length) {
    throw new RangeError(`index ${index} is outside a tree of ${inputs.length}`);
  }
  const steps = [];
  let i = index;
  for (let l = 0; l < ls.length - 1; l++) {
    const level = ls[l];
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < level.length) steps.push({ hash: level[sib], side: i % 2 === 0 ? 'R' : 'L' });
    i = Math.floor(i / 2);
  }
  return steps;
}

/**
 * Walk a proof. §4.9: h = leaf; for each step, h = side === 'L' ? node(step.hash, h) : node(h, step.hash).
 *
 * THE INDEX AND SIZE ARE PART OF THE PROOF, and this is not pedantry. Revision 3 specified only the hash
 * walk, which let ONE valid opening be replayed under several different labels — a bundle could present
 * another bundle's proof as its own. So the shape is checked too: the step count and the exact L/R pattern
 * must be the ones §4.8's construction produces for that (index, size), or the proof is refused before a
 * single hash is computed.
 */
export async function verifyProof({ leaf, proof = [], root, index, size } = {}) {
  if (!Number.isInteger(index) || !Number.isInteger(size) || size < 1 || index < 0 || index >= size) {
    return { ok: false, error: `a proof must carry an index inside its tree; got ${index} of ${size}` };
  }
  const want = expectedShape(index, size);
  if (proof.length !== want.length) {
    return { ok: false, error: `a proof for index ${index} of ${size} has ${want.length} step(s); this one has ${proof.length}` };
  }
  for (let i = 0; i < want.length; i++) {
    if (proof[i].side !== want[i]) {
      return { ok: false, error: `step ${i} should come from the ${want[i] === 'L' ? 'left' : 'right'} for index ${index} of ${size}` };
    }
  }
  let h;
  try {
    h = leaf;
    bytes(h); bytes(root);
    for (const step of proof) h = step.side === 'L' ? await node(step.hash, h) : await node(h, step.hash);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  return h === root ? { ok: true } : { ok: false, error: 'the proof does not reach the published root' };
}

/**
 * The L/R pattern §4.8's construction produces for one position — derived from the shape alone, with no
 * hashes involved, so a verifier can check a proof's shape before trusting any of its contents.
 */
export function expectedShape(index, size) {
  const sides = [];
  let i = index, n = size;
  while (n > 1) {
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < n) sides.push(i % 2 === 0 ? 'R' : 'L');
    i = Math.floor(i / 2);
    n = Math.ceil(n / 2);
  }
  return sides;
}

// --- the two levels, assembled ---------------------------------------------------------------------------

/**
 * One bundle's attribute tree.
 *
 * `attributes` is [{ name, value }] and MUST be the complete set — §4.5's padding exists so every bundle
 * emits an identical name set, and a verifier rejects a bundle with a missing, extra or duplicated
 * attribute. Sorted here byte-wise by name, because the order is what the root commits to.
 */
export async function bundleTree(bundleSaltHex, attributes) {
  const sorted = [...attributes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = sorted.map((a) => a.name);
  if (new Set(names).size !== names.length) {
    throw new Error('a bundle cannot carry the same attribute name twice; sort stability would otherwise change the root');
  }
  const commits = [];
  for (const a of sorted) {
    const salt = await attrSalt(bundleSaltHex, a.name);
    commits.push({ name: a.name, value: normalizeValue(a.value), salt, commit: await commit(a.name, a.value, salt) });
  }
  return { attributes: commits, root: await merkleRoot(commits.map((c) => c.commit)) };
}

/** The run tree over leaf(bundleRoot) in ascending bundle-number order. */
export async function runTree(bundleRootsInOrder) {
  const leaves = [];
  for (const r of bundleRootsInOrder) leaves.push(await leafOf(r));
  return { leaves, root: await merkleRoot(leaves) };
}

/**
 * Open one attribute of one bundle: §4.9's selective disclosure.
 *
 * Publishes the name, the value, that attribute's derived salt, and BOTH proofs — commit to bundleRoot,
 * and leaf to runRoot — each carrying its index and size. A fabricated value has no valid proof, so a
 * dishonest partial disclosure is impossible; only a SELECTIVE one, which §5.5 constrains separately.
 */
export async function openAttribute({ bundleSaltHex, attributes, bundleIndex, bundleRoots, name }) {
  const tree = await bundleTree(bundleSaltHex, attributes);
  const at = tree.attributes.findIndex((a) => a.name === name);
  if (at < 0) throw new Error(`this bundle has no attribute named "${name}"`);
  const run = await runTree(bundleRoots);
  return {
    name,
    value: tree.attributes[at].value,
    salt: tree.attributes[at].salt,
    attribute: {
      proof: await merkleProof(tree.attributes.map((a) => a.commit), at),
      index: at, size: tree.attributes.length, root: tree.root,
    },
    bundle: {
      proof: await merkleProof(run.leaves, bundleIndex),
      index: bundleIndex, size: run.leaves.length, root: run.root,
    },
  };
}

/**
 * Check an opening end to end, against the published roots.
 *
 * Recomputes the commitment from the disclosed name, value and salt — so a value that was swapped after
 * the fact fails at the first step — then walks both proofs. Both are index-bound.
 */
export async function verifyOpening(opening, { runRoot } = {}) {
  const c = await commit(opening.name, opening.value, opening.salt);
  const a = await verifyProof({ leaf: c, proof: opening.attribute.proof, root: opening.attribute.root,
    index: opening.attribute.index, size: opening.attribute.size });
  if (!a.ok) return { ok: false, error: `the attribute proof failed: ${a.error}` };

  const l = await leafOf(opening.attribute.root);
  const b = await verifyProof({ leaf: l, proof: opening.bundle.proof, root: opening.bundle.root,
    index: opening.bundle.index, size: opening.bundle.size });
  if (!b.ok) return { ok: false, error: `the bundle proof failed: ${b.error}` };

  // The run root the OPENING claims must be the one actually published, or an opening could be verified
  // against a tree of the discloser's choosing.
  if (runRoot && opening.bundle.root !== runRoot) {
    return { ok: false, error: 'the opening proves membership of a different run root than the published one' };
  }
  return { ok: true };
}
