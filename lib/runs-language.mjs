// lib/runs-language.mjs — the committed language vocabulary. See docs/RUNS_PLAN.md §11.2.
//
// WHY THIS EXISTS, and it is not hypothetical. Three spellings of "Japanese" are already in play in this
// codebase, and a claim written in one of them is false against stock recorded in another:
//
//   `JP`     what the PSA cert lookup returns (lib/psa.mjs detectLanguage) — so every slab the run
//            intake page resolves from a cert is recorded as JP
//   `ja`     what the card catalogue uses (lib/catalog.mjs LANGS), lowercase and BCP-47-shaped
//   `JA`     what the specification's own Edition 1 claim says: `language bundle eq JA`
//
// Evaluated literally, as §11.2 specifies, Edition 1's language claim would have failed on every single
// bundle — and on a pool built through the intake page it would have failed INCONSISTENTLY, since a
// cert that resolved gave JP while one typed by hand gave JA. The same run, two spellings, one claim.
//
// THE FIX IS TO NORMALISE BEFORE COMMITTING, not to map at evaluation time. That is the opposite of what
// the rarity table does (§11.1 commits the source string and maps through a published table), and the
// difference is forced by the header: headerDigest carries `rarityTableVersion` and `rarityTableHash`, so
// a rarity table is BOUND by the anchor. It has no field for a language table. A mapping applied at
// evaluation would therefore be a rule a verifier had to take on trust — so the canonical code goes into
// the committed `language` field instead, where the anchor covers it, and evaluation stays the literal
// comparison the specification describes.
//
// The display table below only ever reaches the guarantee sentence, which IS inside headerDigest. So it
// is committed too, just by a different route.
import { normalizeValue } from './runs-canonical.mjs';

export const LANGUAGE_TABLE_VERSION = 'lang-v1';

// Every spelling we have seen or expect, folded to lowercase, mapped to the canonical code.
//
// Deliberately NOT a general BCP-47 parser. A closed table of the forms that actually occur fails closed
// on anything else, which is the behaviour that matters: an unrecognised language must refuse the lock,
// not guess.
export const LANGUAGE_SOURCES = Object.freeze({
  ja: 'JA', jp: 'JA', jpn: 'JA', japanese: 'JA',
  en: 'EN', eng: 'EN', english: 'EN',
  ko: 'KO', kor: 'KO', korean: 'KO',
  // Simplified and Traditional are different printings with different markets and prices, so they get
  // different codes. A bare `zh` is REFUSED rather than assumed to be either — guessing would put the
  // wrong word in an anchored sentence.
  'zh-cn': 'ZH_HANS', zhcn: 'ZH_HANS', 'zh-hans': 'ZH_HANS', simplified: 'ZH_HANS',
  'zh-tw': 'ZH_HANT', zhtw: 'ZH_HANT', 'zh-hant': 'ZH_HANT', traditional: 'ZH_HANT',
  de: 'DE', german: 'DE',
  fr: 'FR', french: 'FR',
  es: 'ES', spanish: 'ES',
  it: 'IT', italian: 'IT',
});

// code -> the word that appears in the guarantee sentence. A code with no entry cannot be rendered, and
// a run claiming it fails to lock — the same rule §11.2 states for a rarity class with no display name.
export const LANGUAGE_DISPLAY = Object.freeze({
  JA: 'Japanese',
  EN: 'English',
  KO: 'Korean',
  ZH_HANS: 'Simplified Chinese',
  ZH_HANT: 'Traditional Chinese',
  DE: 'German',
  FR: 'French',
  ES: 'Spanish',
  IT: 'Italian',
});

// ASCII case folding only, for the reason lib/runs-rarity.mjs gives: in a Turkish locale toLowerCase maps
// 'I' to a dotless i, so "ITALIAN" would stop matching and a lock would fail on a machine rather than on
// a card.
function foldAscii(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c >= 0x41 && c <= 0x5a) ? String.fromCharCode(c + 32) : ch;
  }
  return out;
}

/**
 * The canonical code for a source spelling, or null when the table does not know it.
 *
 * NULL IS A REFUSAL. Callers must treat it as "this line cannot appear in a run making a language claim",
 * never as "no language" — an unmapped value that read as absent would sit outside the universal and pass.
 */
export function canonicalLanguage(source) {
  const key = foldAscii(normalizeValue(source == null ? '' : String(source)));
  return Object.prototype.hasOwnProperty.call(LANGUAGE_SOURCES, key) ? LANGUAGE_SOURCES[key] : null;
}

/** The word the guarantee uses, or null. */
export const languageDisplay = (code) =>
  (code && Object.prototype.hasOwnProperty.call(LANGUAGE_DISPLAY, code) ? LANGUAGE_DISPLAY[code] : null);

/** What gets published alongside the commitment, so a reader can check the words against the codes. */
export const languageTable = () => ({
  version: LANGUAGE_TABLE_VERSION,
  sources: { ...LANGUAGE_SOURCES },
  display: { ...LANGUAGE_DISPLAY },
});
