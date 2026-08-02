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
  // N[a]/M[b], where the numerator may carry an alt-art letter (030a/298) and the denominator may be a
  // set code instead of a total (Star Wars Unlimited writes 107/SOR). The numerator's letter is part of
  // the card's identity — the alt art and the base card are different cards at different prices — so it
  // is captured, not stripped.
  const slash = /\b(\d{1,4}[A-Za-z]?)\s*\/\s*(\d{1,4}[A-Za-z]?|[A-Za-z]{2,5})\b/.exec(t);
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

  // LAST RESORT: a bare number. Lorcana prints no denominator at all ("Dale - Ready for His Shot 22")
  // and so do most Japanese Pokémon promos ("Pokemon Dhelmise 88 Abyss Eye"), which between them were
  // 54 of the 154 live listings the repricer could not read — a third of the catalogue never priced.
  //
  // It is genuinely the weakest signal here, because a bare number can be almost anything in a title,
  // so it only runs when every better-formed pattern has failed and it refuses the shapes that are
  // reliably NOT collector numbers:
  //   · one digit — "5" would match a fifth of all titles
  //   · a year — "2026 Pokemon" is a print run, not a card
  //   · a quantity — "2x", "x2"
  //   · a parenthesised ordinal — Lorcana titles end "(12)" for the set, and that is not the card
  //   · anything after a grader or sale word, same blocklist the hash form uses
  const bare = /\b(\d{2,4})([a-z])?\b/g;
  let b;
  while ((b = bare.exec(t))) {
    const before = t.slice(0, b.index), after = t.slice(b.index + b[0].length);
    if (HASH_NOT_A_CARD.test(before)) continue;
    if (/\d{4}/.test(b[1]) && +b[1] >= 1900 && +b[1] <= 2099) continue;      // a year
    // Quantities, in all three places the x can sit: "25x" (captured as a suffix), "2 x 25", and
    // "cards x 25". A trailing x on a number is always a count and never a collector number, whereas
    // the x INSIDE a word is not — matching a bare trailing "x" is what swallowed every Pokémon "ex"
    // card, because "Mega Darkrai ex 99" and "Dustox 195" both read as quantities.
    if ((b[2] || '').toLowerCase() === 'x') continue;
    if (/(?:\b\d+\s*x|\bx)\s*$/i.test(before) || /^\s*x\s*\d/i.test(after)) continue;
    if (/\(\s*$/.test(before) && /^\s*\)/.test(after)) continue;             // "(12)" set ordinal
    const printed = b[1] + (b[2] || '');
    return { printed, numerator: b[1], denominator: null, bare: true, raw: b[0] };
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
