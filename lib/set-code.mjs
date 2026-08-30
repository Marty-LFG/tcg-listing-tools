// lib/set-code.mjs — resolve a printed set code from whatever a stock row happens to name its set.
//
// WHY THIS EXISTS. `bkc.set_code` is a REQUIRED field on the bk_card_identity metaobject, so a row
// without one gets no identity, and a card with no identity can never appear in the PDP condition
// selector — which is the whole of bk-shopify D-026. It is not a column: it lives inside
// inventory_items.card_facts and reaches the mapper through mergeCardFacts.
//
// Only ONE code path ever wrote it (lib/stock-games.mjs, the stock runner/uploader). The three
// inventory-router insert paths — manual add, bulk raw import, and the sub-item path — never did, so
// every row they create is invisible to the condition selector. Found 2026-08-25 when Radiant Gardevoir
// published with no identity and 23 more rows turned out to share the defect.
//
// WHAT THIS IS NOT. It is not a guesser. Every step below is a RE-SPELLING of the name the row already
// carries — dropping a "Pokemon" prefix, a language word, or a series name that the cache itself lists
// as a series. It never picks a "closest match", because a wrong set code is worse than a blank one: it
// silently files the card into the wrong automated per-set collection (D-016/D-027 key those on
// bkc.set_code), and a card in the wrong collection looks deliberate.
import { findSet, findIntlSet, intlLangKey, readCache, SET_NAME_ALIASES } from './pkm-sets-cache.mjs';

// The series names the cache itself knows about, longest first so "Sword & Shield" is stripped before a
// shorter prefix could match part of it. Derived, never hardcoded — a new series appears here the day
// the cached set list carries it.
let _series = null, _seriesFrom = null;
function knownSeries() {
  const cache = readCache();
  const list = cache?.body?.data;
  if (!Array.isArray(list)) return [];
  if (_series && _seriesFrom === cache.at) return _series;
  _series = [...new Set(list.map((s) => String(s.series || '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  _seriesFrom = cache.at;
  return _series;
}

const strip = (name, prefix) => {
  const n = String(name || '').trim();
  const p = String(prefix || '').trim();
  if (!p) return n;
  // Compare loosely (& vs and, punctuation, case) but cut on the ORIGINAL string so the remainder keeps
  // its real spelling for the next lookup.
  const loose = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const lp = loose(p);
  if (!lp) return n;
  let acc = '';
  for (let i = 0; i < n.length; i++) {
    acc += n[i];
    if (loose(acc) === lp) return n.slice(i + 1).trim().replace(/^[-:·—]\s*/, '');
  }
  return n;
};

/**
 * Every spelling of this set name worth trying, in order of confidence. Exported so the backfill can
 * SHOW its working — a report that says only "unresolved" makes the operator redo the search by hand.
 */
export function nameCandidates(rawName) {
  const n = String(rawName || '').trim();
  if (!n) return [];
  const out = [n];
  const push = (v) => { const t = String(v || '').trim(); if (t && !out.includes(t)) out.push(t); };

  const noPkm = n.replace(/^\s*pok[eé]mon\s+/i, '').trim();
  push(noPkm);
  // Language words appear in scraped eBay titles ("POKEMON JAPANESE SV4M-FUTURE FLASH"). Dropping them
  // is safe: the language is carried separately on the row and decides which index we search.
  const noLang = noPkm.replace(/^(japanese|simplified chinese|traditional chinese|chinese|korean|english)\s+/i, '').trim();
  push(noLang);
  for (const s of knownSeries()) { const cut = strip(noLang, s); if (cut !== noLang) push(cut); }
  // "Hidden Fates: Shiny Vault" is a real cached name, so the FULL string is tried first (above) and
  // this only helps where the prefix is a parent set rather than part of the name.
  if (noLang.includes(':')) push(noLang.split(':').pop());
  // "SV4M-FUTURE FLASH" — the code and the name joined by a dash. Both halves are worth a look.
  if (noLang.includes('-')) { push(noLang.split('-').pop()); push(noLang.split('-')[0]); }
  const alias = SET_NAME_ALIASES && SET_NAME_ALIASES[noLang];
  if (alias) push(alias);
  return out;
}

/**
 * resolveSetCode(row) -> { code, via, candidates } | { code: null, candidates }
 *
 * `via` is the spelling that matched, and it is not decoration: it is what lets a human confirm the
 * match was sane rather than lucky, which matters most for the scraped names this exists to handle.
 *
 * Never throws. A row that cannot be resolved returns code:null and is the CALLER's problem to report —
 * silently leaving it blank is exactly the failure this module was written for (GR7).
 */
export function resolveSetCode({ game, set_name, set_code, language } = {}) {
  const already = String(set_code || '').trim();
  if (already) return { code: already, via: 'already set', candidates: [] };
  if (String(game || '').toLowerCase() !== 'pokemon') return { code: null, via: null, candidates: [] };

  const candidates = nameCandidates(set_name);
  if (!candidates.length) return { code: null, via: null, candidates: [] };

  const lang = intlLangKey(language);
  for (const v of candidates) {
    // A non-English row is searched in its OWN index first. The English list carries a "Snow Hazard"
    // too, and answering with the English code for a Japanese card is precisely the wrong-collection
    // failure this module refuses to commit.
    const hit = lang ? (findIntlSet(lang, { name: v }) || findIntlSet(lang, { code: v }))
      : (findSet({ name: v }) || findSet({ code: v }));
    if (hit) {
      const code = String(hit.ptcgoCode || hit.code || hit.id || '').trim().toUpperCase();
      if (code) return { code, via: v, candidates };
    }
  }
  return { code: null, via: null, candidates };
}

/**
 * The shape the insert paths want: the card_facts blob a row should carry, with set_code filled in if
 * it can be. Returns the ORIGINAL blob untouched when nothing could be resolved, so a caller can always
 * write the result without checking.
 */
export function withSetCode(cardFacts, row) {
  let facts = {};
  try { facts = typeof cardFacts === 'string' ? JSON.parse(cardFacts || '{}') : (cardFacts || {}); }
  catch { facts = {}; }                                   // a malformed blob is not a reason to refuse a row
  if (String(facts.set_code || '').trim()) return facts;
  const { code } = resolveSetCode({ ...row, set_code: facts.set_code });
  if (code) facts.set_code = code;
  return facts;
}
