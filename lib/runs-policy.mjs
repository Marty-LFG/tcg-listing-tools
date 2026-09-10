// lib/runs-policy.mjs — the committed unsold policy, and the dispositions that let a run actually close.
//
// THIS TEXT IS INSIDE headerDigest. It is anchored into Bitcoin when a run locks and can never be
// re-issued for that run, which is why it lives here as a versioned constant rather than as something an
// operator types per run: two runs making the same promise in slightly different words would anchor two
// different digests for one policy, and a buyer comparing them could not tell whether the difference was
// meaningful.
//
// WHY v2 EXISTS, AND WHY IT HAD TO LAND BEFORE ANY RUN LOCKED.
//
// v1 said every bundle is sold, no bundle is withdrawn, and none is bought by the seller. Each of those
// is a real guarantee and all three stay. But together they left a run with no exit: §5.6.6 refuses to
// close until every bundle number appears in the published ledger, and the policy forbade both of the
// obvious ways to clear a straggler. A single bundle nobody wanted would have deadlocked the run
// permanently — never closing, and therefore never publishing the close-out disclosure that proves the
// chase count and the guarantee. The cryptography would have been perfect and the run would never have
// been able to tell anyone.
//
// v2 adds the one disposition that resolves it without weakening anything: a bundle still unsold at the
// close date is OPENED ON A PUBLIC STREAM and recorded as opened. It is not withdrawn, not discounted
// away from the shared price, and not bought by us. Every number is still accounted for, so Tier A still
// proves the chase count across the whole run, and the ledger still lets anyone derive what was
// available at any moment.

/** Bumped whenever the text changes. The text itself is what is hashed; this is for the code. */
export const UNSOLD_POLICY_VERSION = 'unsold-v2';

/**
 * The canonical promise. Plain sentences on purpose — a buyer reads this on the commitment, and it is
 * the paragraph a complaint would be measured against.
 */
export const UNSOLD_POLICY = 'Every bundle in a run is sold at one price shared by every remaining '
  + 'number. No bundle is withdrawn from sale, priced differently from any other, or purchased by the '
  + 'seller or an affiliate. Any bundle still unsold at the close date is opened on a public stream and '
  + 'recorded as opened, so every number in the run is accounted for.';

/**
 * The ledger kinds that account for a bundle number leaving the available set.
 *
 * `opened_live` is the v2 addition. It is deliberately a LEDGER entry rather than a column on the bundle:
 * §5.6.3 makes the ledger the availability proof, so a number that left the available set without an
 * entry would make the published chain disagree with the storefront, and the disagreement would look
 * exactly like the lie the ledger exists to rule out.
 */
export const DISPOSITIONS = Object.freeze(['sale_online', 'sale_in_person', 'opened_live']);

/** Every kind the ledger accepts. Mirrors the CHECK constraint in lib/db.mjs, and a test pins the pair. */
export const LEDGER_KINDS = Object.freeze([
  'sale_online', 'sale_in_person', 'opened_live', 'cancel', 'reprice', 'pause', 'resume',
]);

/** Does this kind account for a bundle number? Used by the close check and by availability. */
export const accountsForBundle = (kind) => DISPOSITIONS.includes(kind);
