// test/unit/runs-policy.test.mjs — the committed unsold policy and the disposition that unblocks close.
//
// WHY v2 HAD TO LAND BEFORE ANY RUN LOCKED. The policy text is inside headerDigest, so it is anchored
// into Bitcoin when a run locks and can never be re-issued for that run.
//
// v1 promised three things — every bundle is sold, none is withdrawn, none is bought by us — and left no
// exit. §5.6.6 refuses to close a run until every bundle number appears in the published ledger, and the
// policy forbade both obvious ways to clear a straggler. One bundle nobody wanted would have deadlocked
// the run permanently: never closing, and therefore never publishing the close-out that proves the chase
// count and the guarantee. The cryptography would have been perfect and the run could never have told
// anyone.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDbAt } from '../../lib/db.mjs';
import { tmpFile } from '../helpers/tmp.mjs';
import {
  UNSOLD_POLICY, UNSOLD_POLICY_VERSION, DISPOSITIONS, LEDGER_KINDS, accountsForBundle,
} from '../../lib/runs-policy.mjs';

const db = openDbAt(tmpFile('runs-policy.db'));

describe('the committed text', () => {
  it('keeps all three v1 guarantees', () => {
    assert.match(UNSOLD_POLICY, /one price shared by every remaining number/);
    assert.match(UNSOLD_POLICY, /No bundle is withdrawn from sale/);
    assert.match(UNSOLD_POLICY, /purchased by the seller or an affiliate/);
  });

  it('and adds the one disposition that lets a run close', () => {
    assert.match(UNSOLD_POLICY, /opened on a public stream and recorded as opened/);
    assert.match(UNSOLD_POLICY, /every number in the run is accounted for/);
  });

  it('carries no ratio, odds or probability language', () => {
    // Guardrail 2, and it applies to every customer-facing string, not only the guarantee sentence.
    assert.ok(!/%|\bodds\b|\bchance\b|\bprobability\b|\b1 in\b/i.test(UNSOLD_POLICY), UNSOLD_POLICY);
  });

  it('and no monetary amount', () => {
    assert.ok(!/(?:\$|\bAUD?\b|\bUSD\b)\s*\d/.test(UNSOLD_POLICY), UNSOLD_POLICY);
  });

  it('is versioned, so a later change is visible in the code that applies it', () => {
    assert.equal(UNSOLD_POLICY_VERSION, 'unsold-v2');
  });
});

describe('the disposition vocabulary', () => {
  it('opened_live accounts for a bundle, alongside the two sale kinds', () => {
    assert.deepEqual([...DISPOSITIONS], ['sale_online', 'sale_in_person', 'opened_live']);
    for (const k of DISPOSITIONS) assert.equal(accountsForBundle(k), true, k);
  });

  it('and a cancel, reprice, pause or resume accounts for nothing', () => {
    for (const k of ['cancel', 'reprice', 'pause', 'resume']) assert.equal(accountsForBundle(k), false, k);
  });

  it('the module vocabulary and the database CHECK are the same list', () => {
    // Two copies of a vocabulary is one too many. The CHECK is the enforcement; this asserts the module
    // agrees with it, so a kind added to one and forgotten in the other fails here rather than at 2am.
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='run_ledger'").get().sql);
    const inCheck = /kind IN \(([^)]*)\)/.exec(ddl)[1].split(',').map((x) => x.trim().replace(/'/g, ''));
    assert.deepEqual([...LEDGER_KINDS].sort(), inCheck.sort());
  });
});

describe('the database accepts the new disposition and constrains it', () => {
  const runId = (() => {
    db.prepare(`INSERT INTO runs (public_id, edition, name, mode, unit_count, status)
                VALUES ('POL1', 1, 'Policy', 'live', 3, 'draft')`).run();
    return db.prepare("SELECT id FROM runs WHERE public_id = 'POL1'").get().id;
  })();
  const ins = (kind, bundleNo, seq = 0, qty = 0) =>
    db.prepare(`INSERT INTO run_ledger (run_id, seq, kind, occurred_at, bundle_no, qty, prev_hash, entry_hash)
                VALUES (?,?,?,'2026-09-01T00:00:00.000Z',?,?,'00',?)`)
      .run(runId, seq, kind, bundleNo, qty, `${kind}-${bundleNo}-${seq}-${Math.random()}`);

  it('takes an opened_live entry naming a bundle', () => {
    assert.doesNotThrow(() => ins('opened_live', 7));
  });

  it('refuses a disposition that names no bundle, because it would account for nothing', () => {
    // The availability set derived from the chain would silently disagree with the storefront, and that
    // disagreement looks exactly like the lie the ledger exists to rule out.
    assert.throws(() => ins('opened_live', null), /CHECK constraint failed/);
    assert.throws(() => ins('sale_online', null, 1, 1), /CHECK constraint failed/);
  });

  it('and opened_live does NOT consume a sale ordinal or move a unit', () => {
    // Deliberate: `seq` means "sale ordinal" in the specification's published vector chain, and a new
    // kind that consumed one would have made those vectors unreproducible.
    assert.throws(() => ins('opened_live', 8, 1, 0), /CHECK constraint failed/);
    assert.throws(() => ins('opened_live', 9, 0, 1), /CHECK constraint failed/);
  });
});

describe('a run created through the API cannot end up with no policy', () => {
  it('the create path defaults it rather than leaving it blank', () => {
    // A blank policy is not a smaller promise, it is a run that cannot lock at all — validateForLock
    // refuses with "the run has no unsold policy, and it is inside the anchored digest".
    const src = readFileSync(new URL('../../lib/runs.mjs', import.meta.url), 'utf8');
    assert.match(src, /String\(b\.unsold_policy \|\| ''\)\.trim\(\) \|\| UNSOLD_POLICY/);
  });
});
