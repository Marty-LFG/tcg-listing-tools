// lib/listing-title-parse.mjs — read a card back OUT of an eBay listing title.
//
// The inverse of lib/listing-copy.mjs titleParts()/fitTitle(), used to attach the seller's hand-made
// listings to real cards (AGENTS.md §16c step 2). It is deliberately NOT a positional grammar,
// because fitTitle is lossy: over 80 characters it first abbreviates (rarity → "IR", finish →
// "RH") and then DROPS whole tokens cheapest-first, so "Pokemon", the language and even the
// condition can be missing. What survives is what carries priority — the name (100), the number
// (85) and the set (70) — so those are what this hunts for, each independently:
//
//   number  a distinctive \d+/\d+ (or a promo code like SWSH123), found anywhere
//   set     matched against the KNOWN set list rather than by position, longest name first
//   name    whatever sits between the leading game word and the number
//
// Every field is optional and reported as found-or-not. Nothing is guessed: a title this cannot
// read comes back with a null identity and a reason, for a human to look at (Golden Rule 4).

const CONDITION_CODES = {
  'M/NM': 'Near Mint', NM: 'Near Mint', 'LP': 'Lightly Played', 'MP': 'Moderately Played',
  'HP': 'Heavily Played', 'DMG': 'Damaged',
};
const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'ARK', 'CGA', 'PCG', 'TCG'];

// Strip the punctuation and casing differences between "Champion's Path" and "Champions Path".
// Apostrophes are DELETED, not spaced: turning them into a space gives "champion s path", which no
// real title contains. Everything else collapses to a single space.
export const normSet = (s) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// A '#' before a number usually means the collector number, but not always: the same character
// introduces the things a listing says about the SALE rather than the card. Anything ending in one of
// these words disqualifies the hash that follows it.
const HASH_NOT_A_CARD = /\b(?:lot|cert|certificate|order|invoice|item|serial|qty|batch|ref|psa|bgs|cgc|sgc|tag|ark|cga|pcg)\W{0,3}$/i;

// "162/159" → { printed:'162/159', numerator:'162' }. Also handles a promo/alphanumeric code
// ("SWSH123", "XY-P 001") and a hash-prefixed number ("#160"), neither of which has a denominator.
export function findNumber(title) {
  const t = String(title || '');
  const slash = /\b(\d{1,4})\s*\/\s*(\d{1,4}[A-Za-z]?)\b/.exec(t);
  if (slash) return { printed: slash[1] + '/' + slash[2], numerator: slash[1], denominator: slash[2] };
  const promo = /\b([A-Z]{2,5}\d{2,4})\b/.exec(t);
  if (promo) return { printed: promo[1], numerator: promo[1].replace(/^[A-Z]+/, ''), denominator: null, promo: true };
  // "#160" — how Magic and Star Wars Unlimited titles write the collector number. Tried LAST, so no
  // title that already parses can change shape; it only reaches titles that returned null before.
  //
  //   · the hash is stripped, because buildNumberRe and the comps query both want bare digits
  //   · (?!\d) refuses anything longer than 4 digits, so a PSA cert "#12345678" cannot be read as
  //     "1234" — a graded card's real number ("PSA 10 Charizard #4") is untouched, because the
  //     blocklist looks at the word immediately before the hash, not anywhere in the title
  //   · a trailing letter is fine ("#107MTG" is a real title of yours, with no space)
  const hash = /#\s?(\d{1,4})(?!\d)/g;
  let m;
  while ((m = hash.exec(t))) {
    if (HASH_NOT_A_CARD.test(t.slice(0, m.index))) continue;
    // `raw` keeps the hash so findName cuts the title at the '#' rather than leaving a dangling one
    // on the end of the card name. `printed` stays bare — that is what the comps filter consumes.
    return { printed: m[1], numerator: m[1], denominator: null, hash: true, raw: m[0] };
  }
  return null;
}

// Longest-first so "Sword & Shield - Lost Origin" beats a bare "Lost Origin", and both beat "Origin".
export function findSet(title, setNames) {
  const hay = ' ' + normSet(title) + ' ';
  let best = null;
  for (const s of setNames || []) {
    const n = normSet(s.name != null ? s.name : s);
    if (!n || n.length < 3) continue;
    if (!hay.includes(' ' + n + ' ')) continue;
    if (!best || n.length > normSet(best.name != null ? best.name : best).length) best = s;
  }
  return best;
}

export function findGrade(title) {
  const t = String(title || '');
  for (const g of GRADERS) {
    const m = new RegExp('\\b' + g + '\\s*(10|\\d(?:\\.5)?)\\b').exec(t);
    if (m) return { grading_company: g, grade: parseFloat(m[1]) };
  }
  return null;
}

export function findFinish(title) {
  const t = String(title || '');
  if (/\breverse\s+holo\b|\bRH\b/i.test(t)) return 'Reverse Holo';
  if (/\bholo(foil)?\b/i.test(t)) return 'Holo';
  if (/\bfoil\b/i.test(t)) return 'Foil';
  return null;
}

export function findCondition(title) {
  const t = String(title || '');
  for (const [code, label] of Object.entries(CONDITION_CODES)) {
    if (new RegExp('(^|\\s)' + code.replace('/', '\\/') + '\\s*$', 'i').test(t)) return label;
  }
  return null;
}

// The card name: between the leading game word and the number token. Falls back to the leading run
// of words when there is no number at all.
export function findName(title, number) {
  let t = String(title || '').trim().replace(/^pok[eé]mon\s+|^pokemon\s+/i, '');
  if (number) {
    // `raw` is set only where the printed form differs from what is actually in the title (the '#'
    // of a hash number); everything else cuts on `printed` exactly as before.
    const i = t.indexOf(number.raw || number.printed);
    if (i > 0) t = t.slice(0, i);
  }
  return t.replace(/\s+/g, ' ').trim() || null;
}

// parseCardTitle(title, { setNames }) → everything readable, plus what it could not read.
// setNames: [{ id, name }] (or bare strings) — pass the real set list; without it `set` stays null
// and confidence can never be better than 'low'.
export function parseCardTitle(title, { setNames } = {}) {
  const raw = String(title || '').trim();
  const number = findNumber(raw);
  const set = findSet(raw, setNames);
  const grade = findGrade(raw);
  const out = {
    title: raw,
    name: findName(raw, number),
    number: number ? number.printed : null,
    numerator: number ? number.numerator : null,
    setName: set ? (set.name != null ? set.name : set) : null,
    setId: set && set.id ? set.id : null,
    rarity: null,
    finish: findFinish(raw),
    condition: grade ? null : findCondition(raw),
    graded: !!grade,
    grading_company: grade ? grade.grading_company : null,
    grade: grade ? grade.grade : null,
    missing: [],
  };
  if (!out.name) out.missing.push('name');
  if (!out.number) out.missing.push('number');
  if (!out.setId) out.missing.push('set');
  // A card identity needs a set AND a number. Everything else is colour.
  out.identityGuess = out.setId && out.numerator ? out.setId + '-' + out.numerator.replace(/^0+(?=\d)/, '') : null;
  out.confidence = out.identityGuess ? (out.name ? 'medium' : 'low') : 'none';
  return out;
}
