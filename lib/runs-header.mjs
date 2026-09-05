// lib/runs-header.mjs — §5.1: the header digest, which is the value actually anchored into Bitcoin.
//
// ISOMORPHIC. §6 requires the buyer's page to recompute headerDigest from the published commitment and
// reject a mismatch, so producer and verifier run this same code.
//
// WHY A HEADER AND NOT THE RUN ROOT. Revision 1 anchored runRoot alone, which committed to the CONTENTS of
// every bundle and to nothing else. The chase ladder, the guarantee sentence, the composition, the claims,
// the rarity table and the unsold policy were all outside it — so every one of them could be rewritten
// after sales opened while every buyer's proof still verified. A buyer would check their bundle against a
// root that was honest about the cards and silent about what those cards had been promised to be.
//
// Two fields are OUTSIDE the digest and both are stated exceptions. `anchors` cannot be inside the digest
// they anchor. `v` is the artifact schema version, and a verifier must treat it as untrusted: the only
// permitted use is refusing a version it does not implement. It must never select parsing rules that change
// a hashed interpretation, or an attacker would pick the version that reads the bytes their way.

import { ns, nsValue, sha256Prefixed } from './runs-canonical.mjs';

/**
 * §5.1 compositionCanonical — the run's slot specs in ascending sort_order.
 *
 * This is what makes an independent verifier able to reject a bundle with a missing, extra or duplicated
 * attribute: the padding of §4.5 hides a bundle's structure, and without the composition committed here
 * nothing would stop a producer simply omitting a line and shortening the tree.
 */
export function compositionCanonical(specs = []) {
  const ordered = [...specs].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const seen = new Set();
  let out = '';
  for (const s of ordered) {
    if (seen.has(s.slot)) throw new Error(`the composition declares slot "${s.slot}" twice`);
    seen.add(s.slot);
    out += ns(String(s.slot)) + ns(String(s.label)) + ns(String(s.kind))
      + ns(String(s.qty_per_bundle)) + ns(String(s.max_lines))
      + ns(s.singleton ? '1' : '0') + ns(s.requires_cert ? '1' : '0') + ns(s.is_chase_slot ? '1' : '0');
  }
  return out;
}

/**
 * §5.1 chaseLadderCanonical — ranks unique and contiguous from 1.
 *
 * The ladder is what stops `is_chase` being self-defined. Revision 1 let us set the flag ourselves, so the
 * close-out proved a count of a term we could reinterpret afterwards. Committing the specific cards before
 * any sale means Tier C proves those exact cards landed where the flag says.
 *
 * Cards are identified by set code, number, language, grader and grade — never by name alone, because §1.1
 * establishes that names are ambiguous across printings and languages.
 */
export function chaseLadderCanonical(ladder = []) {
  const ordered = [...ladder].sort((a, b) => Number(a.rank) - Number(b.rank));
  let out = '';
  ordered.forEach((e, i) => {
    if (Number(e.rank) !== i + 1) {
      throw new Error(`chase ladder ranks must be unique and contiguous from 1; position ${i} holds rank ${e.rank}`);
    }
    // §4.2 GOVERNS THESE VALUES, and String() is not §4.2.
    //
    // This read ns(String(x)) for all seven fields, and String(null) is the four characters "null".
    // Five of the six identity columns on run_chase_tiers are nullable, so a ladder entry naming a card
    // with no set code committed 4:null, where the specification mandates 0:,. An independent verifier
    // written from §4 - which §4 opens by promising is possible "with no reference to source code", and
    // which §6.1 makes recomputing this digest its first obligation - therefore computed a DIFFERENT
    // header digest and REJECTED an honest run. That is the exact failure this whole module exists to
    // make impossible, pointed at ourselves.
    //
    // It also committed one fact two ways inside a single run: the same missing set code went into the
    // attribute tree as the empty string, through normalizeValue, and into the header as "null".
    //
    // Found by an independent audit that first reproduced the specification's own published EX2 vector
    // and only then pointed the same code at a real run.
    //
    // rank keeps String(): it is an integer position, not a §4.2 value, and §4.3's token grammars are
    // what turn numbers into strings here.
    out += ns(String(e.rank)) + nsValue(e.card_name) + nsValue(e.set_code)
      + nsValue(e.card_number) + nsValue(e.language)
      + nsValue(e.grading_company) + nsValue(e.grade);
  });
  return out;
}

/**
 * §5.1 headerDigest = SHA-256(0x03 || UTF8(seventeen ns() fields, plus five more for an amendment)).
 *
 * The amendment fields are appended after unsoldPolicy and an ORIGINAL HEADER OMITS ALL FIVE — it does not
 * emit them empty. That distinction is load-bearing: `ns('')` is `0:,` and would still be five fields of
 * input, so an original header and a zero-valued amendment would be different byte strings but only by
 * accident of the empty encoding, and a reader could not tell which they were verifying.
 *
 * `codesCommit` is carried UNCHANGED into every amended header, so codes minted before the run sold cannot
 * be replaced by fresh ones after the buyers are known.
 */
export function headerCanonical(h) {
  const amending = h.amendment != null;
  let s = ns('BKR1-HEADER') + ns(String(h.public_id)) + ns(String(h.edition))
    + ns(String(h.unit_count)) + ns(String(h.canon))
    + ns(String(h.runRoot)) + ns(String(h.codesCommit)) + ns(String(h.blobHash))
    + ns(compositionCanonical(h.specs)) + ns(chaseLadderCanonical(h.chaseLadder)) + ns(String(h.claimsCanonical))
    + ns(String(h.guaranteeText)) + ns(String(h.rarityTableVersion)) + ns(String(h.rarityTableHash))
    + ns(String(h.closeByDate)) + ns(String(h.salesCloseAt)) + ns(String(h.unsoldPolicy));
  if (amending) {
    const a = h.amendment;
    const affected = [...a.affectedBundleNumbers]
      .map((n) => String(n).padStart(3, '0'))
      .sort()
      .join(',');
    s += ns(String(a.predecessorHeaderDigest)) + ns(String(a.seq)) + ns(String(a.reason))
      + ns(affected) + ns(String(a.amendedAt));
  }
  return s;
}

/** What is anchored, as 32 RAW BYTES — not hex text, and not a JSON document. */
export const headerDigest = (h) => sha256Prefixed(0x03, headerCanonical(h));
