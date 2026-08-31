// lib/pkm-tcgdex.mjs — English Pokémon cards from TCGdex, the backup for when pokemontcg.io is down.
//
// WHY THIS EXISTS. On 2026-08-31 pokemontcg.io answered 500/502 for hours. The SETS list degraded
// gracefully — lib/pkm-sets-cache.mjs served its cached copy and said so on the picker — but a
// SINGLE CARD lookup had nowhere to go: /api/pkm/cards/:id answered from the set cache or fell
// straight through to the bare proxy in vite.config.js. `rsv10pt5-162` was asked for fifteen times
// in four minutes and failed every time, and both stock tools were unusable for any set nobody had
// already opened. An outage at the source is not our bug; having no second source is.
//
// TCGdex is keyless, is already the JP/CN/KO source in this repo (lib/catalog.mjs), and was up
// throughout that outage. It sits LAST in the English chain and never pre-empts pokemontcg.io, so a
// set graduates straight back to the authoritative source the moment it answers again.
//
// THE ID RULE, which everything else here serves. Records come back shaped like pokemontcg.io's,
// because that is what every caller parses (`normalizeCard`, lib/stock-games.mjs:317) — and for an
// English card `identityKey` IS `card.id` (lib/stock-games.mjs:281). So the id is rebuilt around OUR
// set id: TCGdex's `sv03.5-178` must reach the suite as `sv3pt5-178`, or the same physical card
// acquires two identities and its stock silently splits in half.
//
// It carries TCGplayer prices too (checked live 2026-08-31, refreshed daily), under kebab-case keys
// this maps back to the camelCase vocabulary PRINTING_TO_FINISH reads. A card TCGdex has no price
// for comes back with `tcgplayer: null` rather than a zero, so the callers that treat a missing
// market figure as "no second opinion" keep working (GR5: printings come from data, never a guess).
import { fetchJsonRetry } from './set-cache.mjs';
import { findSet, normSetKey } from './pkm-sets-cache.mjs';

const LABEL = 'pkm-tcgdex';
const BASE = 'https://api.tcgdex.net/v2/en';
const SETS_TTL_MS = 6 * 60 * 60 * 1000;         // the set LIST changes a few times a year

let _sets = null, _setsAt = 0, _setsInflight = null;

// The English set list, fetched once and held in memory. Not written to disk: it is ~218 small rows,
// it is only ever needed while the primary source is down, and a stale copy on disk is one more
// thing to invalidate.
async function tcgdexSets() {
  if (_sets && Date.now() - _setsAt < SETS_TTL_MS) return _sets;
  if (_setsInflight) return _setsInflight;
  _setsInflight = (async () => {
    const j = await fetchJsonRetry(BASE + '/sets', { attempts: 2, label: LABEL });
    if (Array.isArray(j) && j.length) { _sets = j; _setsAt = Date.now(); }
    return _sets;
  })().finally(() => { _setsInflight = null; });
  return _setsInflight;
}

// pokemontcg.io set id → TCGdex set id. The two vocabularies disagree (`sv3pt5` vs `sv03.5`), and
// there is no rule that derives one from the other, so this is a JOIN on the set's NAME plus its
// official card count — the two facts both sources agree on.
//
// A name that matches more than one TCGdex set and cannot be told apart by count returns null. That
// is deliberate: a wrong set id would answer confidently with the WRONG CARD, which is far worse
// than answering "I don't have it" (GR5). Same for a set our own cache has never heard of.
export async function tcgdexSetIdFor(pkmSetId) {
  const mine = findSet({ id: pkmSetId });
  if (!mine || !mine.name) return null;
  const list = await tcgdexSets();
  if (!list) return null;
  const want = normSetKey(mine.name);
  const named = list.filter((s) => normSetKey(s.name) === want);
  if (!named.length) return null;
  if (named.length === 1) return named[0].id;
  const printed = mine.printedTotal != null ? Number(mine.printedTotal) : null;
  const exact = printed == null ? [] : named.filter((s) => Number((s.cardCount || {}).official) === printed);
  return exact.length === 1 ? exact[0].id : null;
}

// ---- shaping ---------------------------------------------------------------------------------

// TCGdex reports rarity in sentence case ("Illustration rare") where pokemontcg.io uses title case
// ("Illustration Rare"). The difference is not cosmetic: the rarity is copied verbatim into the
// eBay `Rarity` aspect, and a near-miss earns no facet at all.
const titleCase = (s) => String(s || '').trim().replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1));

// pokemontcg.io's supertype vocabulary. TCGdex writes the unaccented "Pokemon", and `Card Type` is
// an eBay aspect, so the accent has to come back.
const SUPERTYPE = { Pokemon: 'Pokémon', Trainer: 'Trainer', Energy: 'Energy' };

// TCGdex's `stage` + `suffix` rebuilt into pokemontcg.io's `subtypes[]`, which is the only thing
// pkmStage() (lib/stock-games.mjs:137) reads.
function subtypesOf(c) {
  const out = [];
  const stage = String(c.stage || '');
  if (/^stage\s*2$/i.test(stage)) out.push('Stage 2');
  else if (/^stage\s*1$/i.test(stage)) out.push('Stage 1');
  else if (/^basic$/i.test(stage)) out.push('Basic');
  else if (stage) out.push(stage);
  if (c.suffix) out.push(String(c.suffix));
  return out.length ? out : undefined;
}

// TCGdex's kebab-case printing keys → the camelCase vocabulary PRINTING_TO_FINISH indexes by
// (lib/listing-copy.mjs:102). An unrecognised key is DROPPED, not transliterated: an unknown
// printing that slipped through as a real one would put a finish on a listing the card does not
// have, which is the exact failure GR5 exists to prevent.
const PRINTING_KEY = {
  normal: 'normal',
  holofoil: 'holofoil',
  'reverse-holofoil': 'reverseHolofoil',
  '1st-edition': '1stEditionNormal',
  '1st-edition-normal': '1stEditionNormal',
  '1st-edition-holofoil': '1stEditionHolofoil',
  unlimited: 'unlimited',
  'unlimited-holofoil': 'unlimitedHolofoil',
};

// TCGdex: {lowPrice, midPrice, highPrice, marketPrice, directLowPrice}
// pokemontcg.io: {low, mid, high, market, directLow}
function priceBlock(p) {
  if (!p || typeof p !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out = { low: n(p.lowPrice), mid: n(p.midPrice), high: n(p.highPrice), market: n(p.marketPrice), directLow: n(p.directLowPrice) };
  return Object.values(out).some((v) => v != null) ? out : null;
}

function tcgplayerOf(c) {
  const tp = (c.pricing && c.pricing.tcgplayer) || null;
  if (!tp) return null;
  const prices = {};
  for (const [k, v] of Object.entries(tp)) {
    const key = PRINTING_KEY[k];
    if (!key) continue;                       // 'unit' / 'updated', and anything new we don't know
    const block = priceBlock(v);
    if (block) prices[key] = block;
  }
  return Object.keys(prices).length ? { url: null, updatedAt: tp.updated || null, prices } : null;
}

// One TCGdex record, shaped like pokemontcg.io's. `pkmSetId` is OURS and wins over TCGdex's — see
// THE ID RULE above. The set block prefers our own cached record so the printed-number denominator
// GR10's formatCardNumber computes is identical to the one the primary source would have produced.
export function toPtcgCard(c, pkmSetId) {
  if (!c || !c.localId) return null;
  const mine = findSet({ id: pkmSetId }) || null;
  const theirs = c.set || {};
  const count = theirs.cardCount || {};
  const set = {
    id: pkmSetId,
    name: (mine && mine.name) || theirs.name || '',
    series: (mine && mine.series) || (theirs.serie && theirs.serie.name) || '',
    ptcgoCode: (mine && mine.ptcgoCode) || theirs.abbreviation || '',
    printedTotal: mine && mine.printedTotal != null ? mine.printedTotal : (count.official != null ? count.official : null),
    total: mine && mine.total != null ? mine.total : (count.total != null ? count.total : null),
    releaseDate: (mine && mine.releaseDate) || theirs.releaseDate || '',
  };
  // THE ID RULE, the numeric half. pokemontcg.io writes the first card of 151 as `sv3pt5-1`,
  // number "1"; TCGdex writes the same card as `sv03.5-001`, localId "001". Carrying the padding
  // through would mint `sv3pt5-001` — a SECOND identity for a card that already has one, so the
  // same Bulbasaur would hold stock under two keys depending on which source happened to answer.
  // Purely-numeric ids are unpadded to match; anything alphanumeric (SWSH284, TG12, XY-P) is
  // already the shape both sources use and is passed through untouched.
  const num = /^\d+$/.test(String(c.localId)) ? String(Number(c.localId)) : String(c.localId);
  return {
    id: pkmSetId + '-' + num,
    name: c.name || '',
    number: num,
    rarity: titleCase(c.rarity),
    supertype: SUPERTYPE[c.category] || c.category || '',
    subtypes: subtypesOf(c),
    hp: c.hp != null ? String(c.hp) : undefined,
    types: Array.isArray(c.types) && c.types.length ? c.types : undefined,
    evolvesFrom: c.evolveFrom || undefined,
    regulationMark: c.regulationMark || undefined,
    nationalPokedexNumbers: Array.isArray(c.dexId) && c.dexId.length ? c.dexId : undefined,
    artist: c.illustrator || '',
    // webp for the thumbnail, PNG for the LISTING image — eBay does not document webp among the
    // formats it accepts, and these bytes are what runPublish pushes to EPS (the same reasoning as
    // fetchTcgdexCards in lib/catalog.mjs).
    images: c.image ? { small: c.image + '/low.webp', large: c.image + '/high.png' } : undefined,
    set,
    tcgplayer: tcgplayerOf(c),
    // Stamped so a caller can say where the answer came from, and so nothing mistakes a backup
    // record for the authoritative one when it decides whether to refresh.
    __source: 'tcgdex',
  };
}

// A WHOLE English set, shaped like a pokemontcg.io page of cards. This is the one the Batch Runner
// needs: its pile mode and its set-list mode both read a single per-set index (/api/pkm/set/:id/
// cards), never a card at a time, so a set the primary source cannot serve leaves the Runner unable
// to start at all — which is what happened on 2026-08-31.
//
// TWO passes, because TCGdex's set endpoint returns only briefs (id, localId, name, image). An
// index built from briefs alone would carry no rarity, no printings and no prices — the eBay Rarity
// aspect would be blank, finishFromRarity could not derive a finish, and the runner's price
// cross-check would have nothing to check against. So the briefs are the roster, and each card is
// then read in full. It costs one request per card, ONCE, on a source that is only ever reached
// because the primary one is down — and the result lands on disk like any other set.
const CARD_CONCURRENCY = 8;

export async function fetchTcgdexSetCards(pkmSetId) {
  const tset = await tcgdexSetIdFor(pkmSetId);
  if (!tset) return null;
  const set = await fetchJsonRetry(BASE + '/sets/' + encodeURIComponent(tset), { attempts: 2, label: LABEL });
  const briefs = (set && Array.isArray(set.cards)) ? set.cards.filter((c) => c && c.localId) : [];
  if (!briefs.length) return null;
  const out = new Array(briefs.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < briefs.length; i = next++) {
      const j = await fetchJsonRetry(BASE + '/cards/' + encodeURIComponent(tset + '-' + briefs[i].localId), { attempts: 2, label: LABEL });
      // A card that will not load falls back to its brief. A roster with a hole in it is worse than
      // a roster with one thin row: the hole is what makes a number "not in this set".
      out[i] = (j && j.localId) ? toPtcgCard(j, pkmSetId) : toPtcgCard({ ...briefs[i], set }, pkmSetId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CARD_CONCURRENCY, briefs.length) }, worker));
  const cards = out.filter(Boolean);
  if (!cards.length) return null;
  console.warn('[' + LABEL + ']', pkmSetId, '— built', cards.length, 'cards from TCGdex (' + tset + '); pokemontcg.io is unavailable');
  // totalCount is what isCompleteSet() checks the roster against, so it must be the count we
  // actually assembled — claiming the official figure would mark a short roster complete.
  return { cards, totalCount: cards.length };
}

// One English card, by OUR id (`sv3pt5-178`). Returns null for anything it cannot answer with
// confidence — a set it cannot join, a card TCGdex does not hold, or TCGdex being down as well.
export async function fetchTcgdexCardById(cardId) {
  const id = String(cardId || '').trim();
  const dash = id.lastIndexOf('-');
  if (dash < 1) return null;
  const setId = id.slice(0, dash);
  const num = id.slice(dash + 1);
  if (!num) return null;
  const tset = await tcgdexSetIdFor(setId);
  if (!tset) return null;
  for (const cand of localIdCandidates(num)) {
    const j = await fetchJsonRetry(BASE + '/cards/' + encodeURIComponent(tset + '-' + cand), { attempts: 1, label: LABEL });
    if (j && j.localId) return toPtcgCard(j, setId);
  }
  return null;
}

// The two sources pad collector numbers differently: pokemontcg.io's id for the first card of 151
// is `sv3pt5-1`, TCGdex's localId for the same card is `001`. Asking for the number as typed 404s
// on every card below 100 in a three-digit set — measured, and it would have made the backup source
// useless for exactly the commons a bulk pile is mostly made of.
//
// Ordered most-likely-first and de-duplicated, so a three-digit number still costs one request.
// Non-numeric numbers (SWSH284, TG12, XY-P) are passed through untouched: padding them would be a
// guess, and they are already the shape both sources use.
export function localIdCandidates(num) {
  const raw = String(num == null ? '' : num).trim();
  if (!raw) return [];
  if (!/^\d+$/.test(raw)) return [raw];
  const out = [raw, raw.padStart(3, '0'), raw.padStart(2, '0'), raw.replace(/^0+(?=\d)/, '')];
  return [...new Set(out)];
}
