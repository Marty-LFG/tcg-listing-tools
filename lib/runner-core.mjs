// lib/runner-core.mjs — the pure logic behind stock-runner.html (the batch listing Runner).
//
// Browser-safe ESM: no node imports, no DOM. The page loads it with
// `<script type="module">` (same pattern as bulk-listing-builder.html importing
// /lib/listing-copy.mjs), and test/unit/runner-core.test.mjs imports it directly. One source,
// so a rule can never drift between "what the grid shows" and "what the tests assert".
//
// Everything here is a pure function of its arguments. The network, the DOM and the DB stay
// in the page and in lib/listings.mjs.
import { PRINTING_TO_FINISH, PRINTING_TO_EDITION, variantToken } from './listing-copy.mjs';

// ---------------------------------------------------------------------------
// Guard rails (owner-set). The client uses these to FLAG; Phase 2 re-checks the same
// numbers at the route so a stale tab cannot bypass them.
// ---------------------------------------------------------------------------
export const PRICE_CEILING_AUD = 150;    // per-row hard flag
export const MEDIAN_MULT = 4;            // ...and anything this far above the batch's own median
export const MIN_ASK_AUD = 1.20;         // below this, listing costs more than it makes
export const DISAGREE_HI = 2.5;          // eBay AU vs TCGplayer market: wrong-card detector
export const DISAGREE_LO = 0.4;
export const TITLE_MAX = 80;

// ---------------------------------------------------------------------------
// Card numbers
// ---------------------------------------------------------------------------

// Every key a typed number could reasonably mean, so `4`, `004` and `004/165` all find the
// same card, and `tg1` finds `TG01`. GR10: this is a LOOKUP key only — the raw upstream
// number is what gets stored and what TCG.formatCardNumber renders for display.
export function numKeys(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase().split('/')[0];
  if (!s) return [];
  const out = new Set([s]);
  out.add(s.replace(/^0+(?=[0-9])/, ''));            // 004     -> 4
  out.add(s.replace(/^([A-Z]+)0+(?=[0-9])/, '$1'));  // SWSH039 -> SWSH39, TG01 -> TG1
  return [...out].filter(Boolean);
}

// Printing sort order within one card number: Normal, then Reverse Holo, then Holo.
//
// The negation is tested FIRST for the reason it always is in this repo: Scryfall's plain finish is
// literally the string "Nonfoil", which CONTAINS "foil", so without this line every unfoiled Magic
// card sorts as a foil — and `n` on the catch line, which asks printingOrder for a 0, would pick the
// foil printing instead. A no-op for Pokémon and Lorcana, whose finishes are Normal / Holofoil /
// Reverse Holofoil / Foil / Enchanted.
export function printingOrder(key) {
  const finish = PRINTING_TO_FINISH[key] || '';
  if (/reverse/i.test(finish)) return 1;
  if (/non[-\s]?(holo|foil)/i.test(finish)) return 0;
  if (/holo|foil/i.test(finish)) return 2;
  return 0;
}

// pokemontcg.io's `orderBy=number` is a STRING sort, so 10 lands between 1 and 2 and the grid
// order stops matching the physical pile order. Rank on (alpha prefix, numeric run, suffix,
// printing) instead — which also keeps TG01 with the TG block and 199a next to 199.
export function numRank(rawNumber, printingKey) {
  const s = String(rawNumber == null ? '' : rawNumber).trim().toUpperCase().split('/')[0];
  const m = s.match(/^([^0-9]*)([0-9]*)(.*)$/) || ['', '', '', ''];
  return { prefix: m[1] || '', n: m[2] ? parseInt(m[2], 10) : -1, suffix: m[3] || '', p: printingOrder(printingKey) };
}

export function cmpRank(a, b) {
  if (a.prefix !== b.prefix) return a.prefix < b.prefix ? -1 : 1;
  if (a.n !== b.n) return a.n - b.n;
  if (a.suffix !== b.suffix) return a.suffix < b.suffix ? -1 : 1;
  return a.p - b.p;
}

// ---------------------------------------------------------------------------
// Printings — DATA, not a guess (Golden Rule 5)
// ---------------------------------------------------------------------------

function toNum(v) { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) && n > 0 ? n : null; }

// The printing matrix straight off the card's tcgplayer.prices keys — the same source
// ENUMERATORS.pokemon reads (lib/enumerate.mjs). One key means zero ambiguity; two or more
// means the card genuinely exists in several printings and the owner picks.
//
// This exists because deriving finish from the RARITY string is wrong in a way that costs
// money: /holo|rare|.../ matches a plain "Rare" and returns Holo, the wrong finish feeds
// finishHint() into the comps search, and you get a CONFIDENT price for a card you do not own.
export function printingsFor(card) {
  const prices = card && card.tcgplayer && card.tcgplayer.prices;
  if (!prices || typeof prices !== 'object') return [];
  const out = [];
  for (const key of Object.keys(prices)) {
    const finish = PRINTING_TO_FINISH[key];
    if (!finish) continue;                       // unknown key: ignore rather than invent a finish
    const edition = PRINTING_TO_EDITION[key] || '';
    const p = prices[key] || {};
    out.push({
      key, finish, edition,
      variant: variantToken(edition, finish),
      marketUsd: toNum(p.market) ?? toNum(p.mid) ?? toNum(p.low),
    });
  }
  out.sort((a, b) => printingOrder(a.key) - printingOrder(b.key));
  return out;
}

// The same matrix for Magic, off Scryfall instead of TCGplayer. Returns the identical
// { key, finish, edition, variant, marketUsd } shape, so the runner's row code never branches.
//
// Two things are particular to Scryfall:
//
//   · `finishes` is the printing axis — a subset of nonfoil / foil / etched — and the price for each
//     lives in a differently-named field (usd / usd_foil / usd_etched).
//   · SURGE FOIL IS NOT IN `finishes`. Scryfall marks it only in promo_types and lists the printing
//     as plain "foil". It is a separate TCGplayer product several times the price of its sibling
//     (HOC #25 Delighted Halfling US$29.93 vs #65 the surge foil US$125), so it gets its own key and
//     its own variant token rather than being sold as the ordinary foil.
//
// marketUsd is deliberately NULL for surge foil. Scryfall reports the PLAIN foil figure in
// usd_foil for a surge print, so quoting it would hand the disagreement detector a number that is
// wrong by a factor of four — it would clear rows that deserve a look and flag ones that do not. No
// figure at all is the honest answer, and the row then carries the `unverified` flag if nothing else
// corroborates its price (GR4).
export function mtgPrintingsFor(card) {
  const fins = card && Array.isArray(card.finishes) ? card.finishes : [];
  if (!fins.length) return [];
  const pr = (card && card.prices) || {};
  const surge = !!(card && Array.isArray(card.promo_types) && card.promo_types.includes('surgefoil'));
  const out = [];
  for (const f of fins) {
    const key = f === 'foil' && surge ? 'surgefoil' : f;
    const finish = PRINTING_TO_FINISH[key];
    if (!finish) continue;                       // an unknown finish: ignore rather than invent one
    const surgeKey = key === 'surgefoil';
    out.push({
      key, finish, edition: '',
      variant: variantToken('', finish),
      marketUsd: surgeKey ? null
        : toNum(f === 'nonfoil' ? pr.usd : f === 'etched' ? pr.usd_etched : pr.usd_foil),
      // What the grid chips, so an empty MKT cell on a surge row reads as a decision rather than a
      // gap. The raw figure is still here for anyone who wants to eyeball it — it is just not
      // allowed to become mktAud and therefore cannot reach the disagreement detector.
      ...(surgeKey ? { marketUnreliable: true, marketUsdRaw: toNum(pr.usd_foil) } : {}),
    });
  }
  out.sort((a, b) => printingOrder(a.key) - printingOrder(b.key));
  return out;
}

// The fallback for a card with no tcgplayer price object at all (promos, brand-new sets).
// VERBATIM behaviour of stock-uploader.html:282 so the two tools agree — but a row built this
// way is chipped `from rarity` in the grid, because it IS a guess.
//
// POKÉMON ONLY. The regex matches a bare "rare", so on Magic every Rare and Mythic would come back
// Holofoil, feed finishHint('foil') into the comps search and return a confident price for a card
// you do not own — the exact failure the paragraph above exists to prevent. lib/stock-games.mjs
// gives Magic a plain Nonfoil fallback instead, because Magic's rarity carries no finish signal.
export function finishFromRarity(rarity) {
  const r = String(rarity || '');
  if (/reverse/i.test(r)) return { finish: 'Reverse Holofoil', variant: 'Reverse Holo', fromRarity: true };
  if (/holo|rare|ex|gx|v\b|vmax|full art|illustration/i.test(r)) return { finish: 'Holofoil', variant: 'Holo', fromRarity: true };
  return { finish: 'Normal', variant: 'Base', fromRarity: true };
}

// Pick the printing a typed token asks for, else the cheapest-risk default (first in
// printing order = Normal when it exists).
//
// The exact key is tried first because Magic has THREE printings that all sort as 2 (foil, etched,
// surge) — the order heuristic alone would hand back whichever of them sorted first and quietly
// ignore what was typed. Pokémon is unaffected: its tokens ARE its keys, so the exact match hits and
// the heuristic below stays the fallback for vintage cards keyed 1stEditionNormal / unlimited.
export function pickPrinting(printings, token) {
  if (!printings || !printings.length) return null;
  if (token) {
    const exact = printings.find((p) => p.key === token);
    if (exact) return exact;
    const want = token === 'reverseHolofoil' ? 1 : token === 'holofoil' ? 2 : 0;
    const hit = printings.find((p) => printingOrder(p.key) === want);
    if (hit) return hit;
  }
  return printings[0];
}

// ---------------------------------------------------------------------------
// The catch line
// ---------------------------------------------------------------------------

export const COND_TOKENS = { nm: 'Near Mint', lp: 'Lightly Played', mp: 'Moderately Played', hp: 'Heavily Played', dmg: 'Damaged' };
export const PRINTING_TOKENS = { n: 'normal', r: 'reverseHolofoil', h: 'holofoil' };
// Magic's printing axis is a different set of words: there is no reverse holo, and the two words
// that matter are nonfoil and foil. `h` is kept as an alias for plain foil so the muscle memory
// carries over — safe, because COND_TOKENS is matched first and therefore `hp` is still Heavily
// Played, never "holo, played".
//
// There is deliberately NO token for etched or surge foil. Counted across the four cached sets,
// Scryfall's only `finishes` combinations are nonfoil+foil, nonfoil, foil and etched — an etched or
// surge print is a SEPARATE COLLECTOR NUMBER, never a second finish of the number beside it (NEO's
// 12 etched prints and HOC #53 surge all carry their own numbers). So they are typed as their own
// number, and a token for them could only ever match nothing.
export const MTG_PRINTING_TOKENS = { n: 'nonfoil', f: 'foil', h: 'foil' };

// Parse one line of the catch box. Everything except the number is optional, and order does
// not matter, so the hands-on-cards case is just `125<Enter>`.
//
//   125            the card number (25, 25/197, 199a, SWSH039, TG01)
//   r | h | n      printing: reverse holo | holo | normal
//   x3             quantity — 3 copies on ONE listing under ONE shelf label
//   @12.50         ask price in AUD, overriding comps
//   nm|lp|mp|hp    condition (sub-NM is held back from the batch)
//   *charizard     search by name instead of number
//   obf            a bare set code switches the active set mid-pile (mixed shoebox)
//
// `hp` is tested BEFORE `h`, or "heavily played" silently becomes "holofoil".
//
// opts.printingTokens lets a game bring its own printing vocabulary (Magic has no reverse holo and
// two extra foils). It defaults to the Pokémon set, so the Pokémon catch line is unchanged.
export function parseCatch(line, opts) {
  const setCodes = (opts && opts.setCodes) || new Set();
  const printingTokens = (opts && opts.printingTokens) || PRINTING_TOKENS;
  const out = { num: null, printing: null, qty: null, askAud: null, cond: null, nameQuery: null, setCode: null, unknown: [] };
  const toks = String(line == null ? '' : line).trim().split(/\s+/).filter(Boolean);
  for (const t of toks) {
    const lower = t.toLowerCase();
    if (t.startsWith('*')) { const q = t.slice(1); if (q) out.nameQuery = q; else out.unknown.push(t); continue; }
    if (t.startsWith('@')) { const v = parseFloat(t.slice(1)); if (isFinite(v) && v >= 0) out.askAud = v; else out.unknown.push(t); continue; }
    if (/^x[0-9]+$/i.test(t)) { const q = parseInt(t.slice(1), 10); if (q > 0) out.qty = q; else out.unknown.push(t); continue; }
    if (Object.prototype.hasOwnProperty.call(COND_TOKENS, lower)) { out.cond = COND_TOKENS[lower]; continue; }
    if (Object.prototype.hasOwnProperty.call(printingTokens, lower)) { out.printing = printingTokens[lower]; continue; }
    if (setCodes.has(t.toUpperCase())) { out.setCode = t.toUpperCase(); continue; }
    if (/^[0-9]/.test(t) || /^[A-Za-z]+[0-9]/.test(t)) { out.num = t; continue; }   // 25, 25/197, SWSH039, TG01
    out.unknown.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

export function isNearMint(cond) {
  const s = String(cond == null || cond === '' ? 'Near Mint' : cond);
  return /near\s*mint/i.test(s) || /^\s*nm\s*$/i.test(s);
}

export function medianOf(values) {
  const v = (values || []).filter((x) => typeof x === 'number' && isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

// Why a row needs a human. Each flag carries its own sentence — a red dot with no words is
// not something you can act on, and DESIGN.md forbids colour carrying meaning alone.
//
// Deliberately NOT flags (they are chips in the grid instead): a card having more than one
// printing, which is true of most cards and would flag the whole batch; and a finish derived
// from rarity, which on a brand-new set would flag every row. The disagreement detector is
// what actually catches a wrong printing, and it costs nothing.
export function flagsFor(row, medianAud, cfg) {
  const c = Object.assign({
    ceiling: PRICE_CEILING_AUD, medianMult: MEDIAN_MULT, minAsk: MIN_ASK_AUD,
    disagreeHi: DISAGREE_HI, disagreeLo: DISAGREE_LO,
  }, cfg || {});
  const out = [];
  const ask = row && row.askAud;
  const has = typeof ask === 'number' && isFinite(ask);
  if (has) {
    if (ask > c.ceiling) out.push({ k: 'ceiling', why: 'A$' + ask.toFixed(2) + ' is over the A$' + c.ceiling + ' per-card ceiling' });
    if (medianAud > 0 && ask > medianAud * c.medianMult) out.push({ k: 'median', why: 'A$' + ask.toFixed(2) + ' is more than ' + c.medianMult + '× this batch’s median of A$' + medianAud.toFixed(2) });
    if (ask < c.minAsk) out.push({ k: 'tiny', why: 'A$' + ask.toFixed(2) + ' is under the A$' + c.minAsk.toFixed(2) + ' floor' });
    const mkt = row.mktAud;
    if (typeof mkt === 'number' && isFinite(mkt) && mkt > 0) {
      const r = ask / mkt;
      if (r > c.disagreeHi) out.push({ k: 'disagree', why: 'eBay AU is ' + r.toFixed(1) + '× the TCGplayer market — check this is the right printing' });
      else if (r < c.disagreeLo) out.push({ k: 'disagree', why: 'eBay AU is only ' + r.toFixed(2) + '× the TCGplayer market — check this is the right printing' });
    }
  }
  if (row && row.noComps && has) out.push({ k: 'noComps', why: 'priced by hand — there were no confident eBay AU comps' });
  // Both independent signals missing at once. eBay Marketplace Insights (real SOLD prices) soft-403s,
  // and the engine then falls back to ASKING prices — which it still reports as confidence 'medium',
  // 'reliable: true'. Observed live: a US$0.30 Shuckle priced at A$18.08 off 165 asking listings.
  // The TCGplayer cross-check normally catches that, so this only fires when there is no market
  // figure either and nothing at all has corroborated the number (GR4).
  if (row && row.askOnly && has && !(typeof row.mktAud === 'number' && row.mktAud > 0)) {
    out.push({ k: 'unverified', why: 'priced from asking listings only, with no TCGplayer market figure to check it against — nothing has corroborated this number' });
  }
  if (row && row.title && String(row.title).length >= TITLE_MAX) out.push({ k: 'title', why: 'the title is at the ' + TITLE_MAX + '-character limit, so a token may have been dropped' });
  if (row && row.dupe && row.dupe.hit) out.push({ k: 'dupe', why: row.dupe.why || 'you already hold this card at this condition' });
  return out;
}

// The single source of a row's band. Order matters: a published row is LIVE whatever else is
// true of it, and a sub-NM row is HELD before anything asks about price (GR: stock catalog art
// on a played card would be a stock photo on a used item, which eBay bans).
export function deriveState(row, medianAud, cfg) {
  if (!row) return 'EYES';
  if (row.listingUrl || row.published) return 'LIVE';
  if (row.failed) return 'FAILED';
  if (row.staged) return 'STAGED';
  if (!isNearMint(row.cond)) return 'HELD';
  if (row.pricing) return 'PRICING';
  const ask = row.askAud;
  if (!(typeof ask === 'number' && isFinite(ask) && ask > 0)) return 'EYES';
  return flagsFor(row, medianAud, cfg).length ? (row.released ? 'CHECKED' : 'CHECK') : 'READY';
}

// Only a row a human has either not needed to look at, or has explicitly approved, is publishable.
export function isPublishable(state) { return state === 'READY' || state === 'CHECKED'; }

// ---------------------------------------------------------------------------
// The micro price-scale (Phase 3)
// ---------------------------------------------------------------------------

// comps-singles calls a cluster unreliable once hi > 4× lo; the rail borrows that threshold so a
// thin, scattered comp set LOOKS thin.
export const SPREAD_WIDE = 4;

const clampPct = (v) => Math.max(0, Math.min(100, v));

// Geometry for the little rail in the eBay column. Returns percentages, or null when there is no
// cluster to draw.
//
// The obvious version of this is broken and worth naming: `clusterValue` returns
// `cheapestInCluster` and `clusterLo` as literally the SAME expression (`cluster[0]`, lib/comps.mjs),
// and `recommendedFromCluster` is `cheapestInCluster - 0.01` — so a rail spanning cheapest→hi with a
// band at lo→hi is one shape, and every unedited ask lands in the identical spot. Forty rows would
// render forty identical pictures.
//
// What varies, and is therefore what gets drawn: the DOMAIN spans the cluster *and* the ask (so a
// hand-typed price outside the band is visible rather than clipped), the band is the cluster, and
// the tick is `fair` — the cluster MEDIAN, which genuinely moves within the band and shows skew.
// An unedited caret sitting hard left is correct and worth seeing: it means "we mechanically
// undercut". The eye is scanning for a caret that has MOVED, a tick far from it, or a wide rail.
export function scaleGeometry({ askAud, clusterLo, clusterHi, fair }) {
  const lo = toNum(clusterLo), hi = toNum(clusterHi);
  if (lo == null || hi == null || hi < lo) return null;
  const ask = toNum(askAud);
  const dLo = ask == null ? lo : Math.min(lo, ask);
  const dHi = ask == null ? hi : Math.max(hi, ask);
  const span = dHi - dLo;
  const pct = (v) => (span > 0 ? ((v - dLo) / span) * 100 : 0);
  const bandLeft = span > 0 ? pct(lo) : 0;
  const bandWidth = span > 0 ? Math.max(pct(hi) - pct(lo), 1) : 100;
  return {
    bandLeftPct: clampPct(bandLeft),
    bandWidthPct: Math.min(bandWidth, 100 - clampPct(bandLeft)) || 1,
    tickPct: fair != null && isFinite(fair) ? clampPct(pct(fair)) : null,
    caretPct: ask == null ? null : clampPct(pct(ask)),
    inBand: ask == null ? null : (ask >= lo && ask <= hi),
    wide: lo > 0 ? hi / lo >= SPREAD_WIDE : false,
  };
}

// An unedited ask is exactly `cheapestInCluster - 1c` by construction, so ANY row not sitting there
// was moved — by hand, or by an override. That makes "N of M at the mechanical undercut" a real
// integrity check on the batch rather than a decoration.
export function atMechanicalUndercut(askAud, recommended) {
  const a = toNum(askAud), r = toNum(recommended);
  if (a == null || r == null) return false;
  return Math.abs(a - r) < 0.005;
}

// ---------------------------------------------------------------------------
// Server-side refusals (Phase 2)
// ---------------------------------------------------------------------------

// The same rules flagsFor() applies in the grid, re-stated in CENTS for POST /api/listings/batch.
// They live here, beside the client rules and on the same constants, so the two can never drift to
// different numbers — which is the whole point of enforcing them twice.
//
// Everything above is advisory: the client can flag, un-flag and re-render as it likes. This is the
// layer a stale tab, a reload, or any future caller of the same route cannot talk its way past.
// Nothing equivalent exists elsewhere: validateListing only errors when price_cents <= 0, and
// PRICE_SANITY_MULTIPLE lives in reviseTradingListing (the hand-made Trading path) and never runs
// on runPublish.
//
// row: { priceCents, condition, graded, hasOwnerPhotos, released }
// Returns [] when the row may publish; otherwise one entry per reason, each with a `releasable`
// flag saying whether an explicit per-row approval can override it.
export function refuseRow(row, medianCents, cfg) {
  const c = Object.assign({
    ceilingCents: Math.round(PRICE_CEILING_AUD * 100), medianMult: MEDIAN_MULT, minCents: Math.round(MIN_ASK_AUD * 100),
  }, cfg || {});
  const out = [];
  const price = row && row.priceCents;
  const has = typeof price === 'number' && isFinite(price);

  if (!has || price <= 0) {
    out.push({ code: 'no_price', releasable: false, message: 'no price — a listing with no price is never publishable' });
    return out;                       // every other price rule is meaningless without one
  }
  // NOT releasable. A played card listed with catalog art is an eBay policy breach (stock photos on
  // used items), not a judgement call, so no amount of approving gets past it — add real photos.
  //
  // BRANDED RAILS DO NOT SATISFY THIS. The listing-image compositor frames catalog art in store
  // chrome, which changes how the thumbnail looks and nothing about what it IS: still a stock image
  // on a used item. Whether compositing is on has no bearing on either refusal below, and wiring it
  // in here would trade a presentation win for a policy breach.
  if (row.graded) {
    // A slab sold under the card's catalog scan hides the one thing the buyer is paying extra for:
    // the actual slab, its label and its cert number. Same handling as sub-NM — photos or nothing.
    if (!row.hasOwnerPhotos) out.push({ code: 'graded_no_photos', releasable: false, message: 'this is a graded slab with no owner photos — a buyer cannot verify the label or the cert number from a catalog scan, so list it from the single uploader with real slab photos' });
  } else if (!isNearMint(row.condition) && !row.hasOwnerPhotos) {
    out.push({ code: 'sub_nm_no_photos', releasable: false, message: 'condition is ' + String(row.condition || '(unset)') + ' and there are no owner photos — eBay bans stock catalog images on used items, so this needs real front/back photos first' });
  }
  // Releasable: these are judgement calls, and the owner approves them one row at a time.
  if (price > c.ceilingCents) {
    out.push({ code: 'over_ceiling', releasable: true, message: 'A$' + (price / 100).toFixed(2) + ' is over the A$' + (c.ceilingCents / 100).toFixed(2) + ' per-card ceiling — approve this row explicitly to list it' });
  }
  if (medianCents > 0 && price > medianCents * c.medianMult) {
    out.push({ code: 'over_median', releasable: true, message: 'A$' + (price / 100).toFixed(2) + ' is more than ' + c.medianMult + '× this batch’s median of A$' + (medianCents / 100).toFixed(2) + ' — approve this row explicitly to list it' });
  }
  if (price < c.minCents) {
    out.push({ code: 'under_floor', releasable: true, message: 'A$' + (price / 100).toFixed(2) + ' is under the A$' + (c.minCents / 100).toFixed(2) + ' floor — approve this row explicitly to list it' });
  }
  return out;
}

// What actually blocks a row, given the set of ids the owner explicitly approved.
export function blockingRefusals(refusals, released) {
  return (refusals || []).filter((r) => !(r.releasable && released));
}

// The identity two rows must share to be the same physical stock — and therefore ONE listing
// with quantity N under ONE shelf label. Mirrors stockKey() in lib/inventory.mjs:85 (condition
// and printing are part of identity on purpose: an LP copy is not NM stock).
export function rowKey(row) {
  return [
    // Load-bearing since Magic reached the runner: makeRow stamps the active game on every row, and
    // this mirrors stockKey() in lib/inventory.mjs, which reads row.game. A hardcoded segment here
    // would merge two games' rows under one key — Pokémon's sv4-25 and Magic's hob-25 are different
    // cards. The || is the floor for a row built before the switcher existed.
    row.game || 'pokemon',
    row.identityKey || (row.setId + '-' + row.rawNumber),
    row.variant || 'Base',
    row.language || 'EN',
    isNearMint(row.cond) ? 'NM' : String(row.cond || '').toUpperCase(),
  ].join('|');
}
