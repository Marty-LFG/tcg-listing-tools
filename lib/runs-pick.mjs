// lib/runs-pick.mjs — the physical pick check. See docs/RUNS_PLAN.md, "Photo verification at pick time".
//
// WHERE THIS SITS IN THE PHYSICAL SEQUENCE, and why that placement is the whole value:
//
//   1. build the manifest        2. PICK AND VERIFY  ← here, nothing sealed, run still draft
//   3. pre-assign seal serials   4. lock             5. wait for the Bitcoin confirmation
//   6. print inserts             7. pack and seal    8. publish
//
// A wrong card found at step 2 is a manifest edit. The same error found after step 4 needs an amendment,
// a new published root and a new anchor. That is the entire argument for checking before the lock rather
// than after, and it is why this module refuses to run on a run that is no longer a draft.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// TWO RULES, AND THEY ARE NOT NEGOTIABLE
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   THE MODEL ADVISES, IT NEVER DECIDES. Nothing in this file writes to a manifest, a reservation or a
//   bundle. It returns findings for a human to resolve. Vision models misread digits — and a certification
//   number is eight of them — so a false pass here would be worse than no check at all: it would replace
//   a person's attention with a machine's confidence about the one field the buyer will later verify.
//
//   THE MODEL READS, THE CODE COMPARES. The prompt asks only what is visible in the photograph. Every
//   judgement about whether that MATCHES is made below, in ordinary code, against the manifest — because
//   a model asked "does this match?" will agree, and a model asked "what do you see?" cannot.
//
// WHAT EARNS ITS KEEP is the certification number: printed on the slab label, and the exact field the
// buyer checks at verification. Card name and grade are worth reading too. Packs are weaker — three packs
// of the right set is confirmable, WHICH physical pack is not — so a pack line is reported as seen rather
// than matched, and never as a failure.
//
// PHOTOS ARE INTERNAL-ONLY AND NEVER PUBLISHED. A picture of a laid-out bundle is a complete pre-sale
// disclosure of that bundle. They live beside the salts in sensitivity terms (§8.3, backups).
import { normalizeValue } from './runs-canonical.mjs';

// ASCII case folding and the removal of anything that is not alphanumeric, for COMPARISON ONLY. A cert
// read off a photograph may arrive as "7859-5158" or with a stray space; the stored value is what gets
// committed, and this only decides whether two strings name the same thing.
function loose(s) {
  let out = '';
  for (const ch of normalizeValue(s == null ? '' : String(s))) {
    const c = ch.codePointAt(0);
    if (c >= 0x30 && c <= 0x39) out += ch;
    else if (c >= 0x41 && c <= 0x5a) out += String.fromCharCode(c + 32);
    else if (c >= 0x61 && c <= 0x7a) out += ch;
  }
  return out;
}

export const SYSTEM_PROMPT = [
  'You are reading a photograph of trading-card products laid out for packing.',
  '',
  'Report ONLY what you can actually read in the image. Do not infer, do not complete a partially visible',
  'number from context, and do not guess. If a field is unreadable, say so — an omission is useful and a',
  'guess is dangerous, because a human is using this to decide whether to open a sealed parcel.',
  '',
  'You are NOT being asked whether anything matches anything. You do not know what was expected.',
  '',
  'Return JSON only:',
  '{"slabs":[{"cert":"<digits exactly as printed, or null>","name":"<card name, or null>",',
  '           "grader":"<PSA/BGS/CGC/etc, or null>","grade":"<as printed, or null>",',
  '           "legible":true|false}],',
  ' "sealed":[{"name":"<product name as printed, or null>","set":"<set name or code, or null>","count":<how many you see>}],',
  ' "other":[{"what":"<anything else visible in the frame>"}],',
  ' "notes":"<anything that would matter to a person checking this parcel>"}',
].join('\n');

export const userPrompt = (bundleLabel, slotNames) => [
  `This is the contents laid out for parcel ${bundleLabel}.`,
  `It should contain items for these slots: ${slotNames.join(', ')}.`,
  'Read every certification number you can see, digit by digit, and every product name.',
  'Do not say whether anything is correct. Only report what is visible.',
].join(' ');

/**
 * Compare what the model read against what the manifest says.
 *
 * PURE — no database, no network, no writes. `expected` is the bundle's manifest lines; `seen` is the
 * model's JSON. Returns findings, and findings only.
 *
 * Severity is deliberately coarse. `mismatch` means two values disagree and a human must look;
 * `missing` means the manifest expects something the photo does not show; `unreadable` means the model
 * could not tell, which is NOT a pass and NOT a failure. Nothing here returns "verified" — the strongest
 * thing it says is that it found nothing to raise.
 */
export function crossCheck({ expected = [], seen = {} } = {}) {
  const findings = [];
  const slabs = Array.isArray(seen.slabs) ? seen.slabs : [];
  const sealed = Array.isArray(seen.sealed) ? seen.sealed : [];

  const wantCerts = expected.filter((l) => loose(l.cert_number));
  const sawByCert = new Map(slabs.filter((s) => loose(s.cert)).map((s) => [loose(s.cert), s]));

  for (const line of wantCerts) {
    const key = loose(line.cert_number);
    const got = sawByCert.get(key);
    if (!got) {
      // The cert is the field the buyer will verify, so its absence from the photo is the finding that
      // matters most — and it is a finding, not a verdict.
      findings.push({
        severity: 'missing', field: 'cert_number', slot: line.slot,
        expected: line.cert_number, seen: null,
        detail: slabs.length
          ? `the photo shows ${slabs.length} slab(s) and none of them reads as this certification number`
          : 'no slab was legible in the photo',
      });
      continue;
    }
    sawByCert.delete(key);
    // The cert matched, so this IS the right slab — which makes any other disagreement on it worth
    // raising rather than explaining away.
    if (loose(got.grade) && loose(line.grade) && loose(got.grade) !== loose(line.grade)) {
      findings.push({ severity: 'mismatch', field: 'grade', slot: line.slot, expected: String(line.grade), seen: String(got.grade),
        detail: 'the slab with this certification number reads as a different grade' });
    }
    if (loose(got.grader) && loose(line.grading_company) && loose(got.grader) !== loose(line.grading_company)) {
      findings.push({ severity: 'mismatch', field: 'grading_company', slot: line.slot, expected: line.grading_company, seen: got.grader,
        detail: 'the slab with this certification number reads as a different grader' });
    }
    if (loose(got.name) && loose(line.display_name) && !loose(got.name).includes(loose(line.display_name).slice(0, 8))) {
      // A NAME mismatch on a matching cert is reported softly: card names are printed in several forms,
      // abbreviated on labels, and a substring check is the most an honest comparison can claim.
      findings.push({ severity: 'review', field: 'display_name', slot: line.slot, expected: line.display_name, seen: got.name,
        detail: 'the certification number matches but the name read differently — often a labelling difference, worth a look' });
    }
    if (got.legible === false) {
      findings.push({ severity: 'unreadable', field: 'cert_number', slot: line.slot, expected: line.cert_number, seen: got.cert,
        detail: 'the model reported this slab as not clearly legible, so the match is not evidence' });
    }
  }

  // A slab in the frame that the manifest does not expect. Could be the next bundle's, could be a card in
  // the wrong parcel — either way a person needs to look, and the machine cannot tell which.
  for (const [key, got] of sawByCert) {
    findings.push({ severity: 'unexpected', field: 'cert_number', slot: null, expected: null, seen: got.cert,
      detail: `a slab reading ${key} is in the photo and is not in this bundle's manifest` });
  }

  const unreadable = slabs.filter((s) => !loose(s.cert));
  if (unreadable.length) {
    findings.push({ severity: 'unreadable', field: 'cert_number', slot: null, expected: null, seen: null,
      detail: `${unreadable.length} slab(s) in the photo had no readable certification number` });
  }

  // PACKS ARE REPORTED, NOT MATCHED. Three packs of the right set is confirmable from a photo; which
  // physical pack is not. Counting them is the most this check can honestly do, so a count disagreement
  // is a `review` rather than a `mismatch`, and nothing about a pack is ever a failure.
  const wantSealedUnits = expected.filter((l) => l.kind === 'sealed')
    .reduce((n, l) => n + (Number(l.qty) || 0), 0);
  const sawSealedUnits = sealed.reduce((n, s) => n + (Number(s.count) || 0), 0);
  if (wantSealedUnits && sawSealedUnits && sawSealedUnits !== wantSealedUnits) {
    findings.push({ severity: 'review', field: 'sealed_count', slot: null,
      expected: String(wantSealedUnits), seen: String(sawSealedUnits),
      detail: 'the number of sealed items in the photo differs from the manifest; which physical pack is which cannot be read from a picture' });
  }

  return {
    findings,
    // NOT "verified". The strongest claim this module makes is that it found nothing to raise, which is a
    // different statement and is worded that way everywhere it surfaces.
    clean: findings.length === 0,
    notes: String(seen.notes || '').slice(0, 600),
  };
}

/**
 * Run the check for one bundle.
 *
 * `ask` is injected so the test suite never makes a billed model call, and so a caller can substitute a
 * different provider without this module knowing. It defaults to the shared vision seam.
 *
 * READ-ONLY BY CONSTRUCTION: it takes the expected lines rather than a database handle, so there is
 * nothing here that COULD write a manifest even by mistake.
 */
export async function checkPick({ bundleLabel, slots = [], expected = [], images = [], env = {}, ask } = {}) {
  const call = ask || (async (args) => (await import('./grader.mjs')).askVision(args));
  const res = await call({
    images,
    system: SYSTEM_PROMPT,
    user: userPrompt(bundleLabel, slots),
    env,
  });
  if (!res || !res.ok) {
    // A dead provider degrades the check; it must never look like a pass. GR7.
    return { ok: false, error: res?.error || 'provider', message: res?.message || 'the vision check could not run',
      advisory: true, clean: false, findings: [] };
  }
  const out = crossCheck({ expected, seen: res.json || {} });
  return {
    ok: true, provider: res.provider, model: res.model,
    // Carried on every response so no caller can treat this as an authority by forgetting to check.
    advisory: true,
    ...out,
  };
}
