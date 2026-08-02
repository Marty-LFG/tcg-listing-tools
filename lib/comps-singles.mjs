// lib/comps-singles.mjs — server-side eBay AU market value for SINGLE cards. The headless twin of
// extras.js `TCG.analyzeComps` (the browser engine), so the stock uploader can price a card without a
// DOM. Golden Rule 9: this is a MIRROR of the browser singles logic — JUNK_RE, buildNumberRe,
// classifyLang, isGraded and the "recommended = cheapest in-cluster − $0.01" rule are ported verbatim;
// `scripts/check-comps.mjs` asserts JUNK_RE parity against extras.js and vector-tests the rest. The
// clustering + eBay row parsers are reused from lib/comps.mjs (one implementation, not a third copy).
//
// Self-fetches the `/api/ebay` proxy (app token + EBAY_AU ⇒ AUD). Sold (Marketplace Insights) first,
// then Browse (asking). Our own listings are excluded. NEVER throws (GR7) ⇒ { matched:false } on any
// failure. Money is AUD dollars here; the caller rounds to INTEGER CENTS (GR3).
import { clusterValue, rowFromAsk, rowFromSold, askFilter } from './comps.mjs';

// Accessories / sealed / lots that pollute a singles search — VERBATIM port of extras.js JUNK_RE
// (the mirror-opposite of lib/comps.mjs' sealed filter). Keep byte-identical (checked by the harness).
export const JUNK_RE = /keyring|key\s*ring|\bcase\b|display|\bsleeve\b|toploader|top\s*loader|protector|\bproxy\b|custom|orica|\bmetal\b|jumbo|oversized|playmat|\bdecal\b|\bsticker\b|\bbundle\b|\blot\b|\bbooster\b|\bpack\b|\bbox\b|\bcoin\b|\bpin\b|\bsigned\b|\baltered\b|art\s*card|art\s*series|\bsealed\b|starter\s*deck|\bplayset\b|pick\s*your|choose\s*your|complete\s*your|set\s*of\b|\bsingles\b|\bbulk\b/i;

// Flexible collector-number title matcher (zero-padding tolerant on both sides). Port of extras.js.
export function buildNumberRe(num) {
  const s = String(num || '').trim(); if (!s) return null;
  const m = s.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
  if (m) return new RegExp('\\b0*' + String(+m[1]) + '\\s*\\/\\s*0*' + String(+m[2]) + '\\b');
  const n = s.match(/\d{1,4}/); return n ? new RegExp('\\b0*' + String(+n[0]) + '\\b') : null;
}

// Classify a listing title's language. Port of extras.js TCG.classifyLang → 'ko'|'jp'|'cn'|'eu'|'en'.
export function classifyLang(title) {
  const t = title || '';
  if (/[가-힯]/.test(t) || /\b(korean|kor)\b/i.test(t)) return 'ko';
  if (/[぀-ヿ]/.test(t) || /\b(japanese|jpn?|nihongo)\b/i.test(t)) return 'jp';
  if (/中文|简体|繁體|宝可梦|寶可夢/.test(t) || /\b(chinese|s[-\s]?chinese|simplified|traditional)\b/i.test(t)) return 'cn';
  if (/\b(french|fran[çc]ais|deutsch|german|italiano|italian|espa(?:ñ|n)ol|spanish|portugu[eê]s|portuguese|russian)\b/i.test(t)) return 'eu';
  if (/[一-鿿]/.test(t)) return 'jp';
  return 'en';
}

// Graded detection (conditionId first, keyword fallback). Port of extras.js isGraded.
export function isGraded(r) {
  const id = String(r.condId || r.condId === 0 ? r.condId : '');
  if (id === '2750') return true;
  if (id === '4000' || id === '3000' || id === '1000') return false;
  return /\b(psa|bgs|cgc|sgc|ace|tag)\b\s*\d|graded|gem\s*mint/i.test((r.cond || '') + ' ' + (r.title || ''));
}

// The singles precision filter — port of the analyzeComps precision branch. Narrows to listings that
// are plausibly THIS exact card (number, not junk, right language, matching finish).
export function singlesFilter(rows, { numberMatch, lang, finish } = {}) {
  const numRe = buildNumberRe(numberMatch);
  const wantLang = ({ ja: 'jp', 'zh-cn': 'cn', 'zh-tw': 'cn', ko: 'ko', en: 'en' })[lang] || lang || 'en';
  const wantFinish = (finish === 'foil' || finish === 'nonfoil') ? finish : null;
  return rows.filter((r) => {
    const t = r.title || '';
    if (numRe && !numRe.test(t)) return false;
    if (JUNK_RE.test(t)) return false;
    const cl = classifyLang(t);
    if (wantLang === 'en') { if (cl !== 'en') return false; }
    else if (cl !== wantLang && cl !== 'en') return false;
    if (wantFinish) {
      const nonfoil = /\bnon[\s-]?foil\b|\bnonfoil\b|\bnon[\s-]?holo\b/i.test(t);
      const isFoil = !nonfoil && /\bcold\s*foil\b|\brainbow\s*foil\b|\bfoil\b|\breverse\s*holo\b|\bholo(?:foil|graphic)?\b/i.test(t);
      if (wantFinish === 'foil' && nonfoil) return false;
      if (wantFinish === 'nonfoil' && isFoil) return false;
    }
    return true;
  });
}

// The owner's price endings. Two per dollar, so the worst case a snap can cost is 49c and the
// typical case is 1c — .99 lands on .98, .49 lands on .48. Kept byte-identical to the ASK_ENDINGS
// literal in extras.js (GR9, asserted by scripts/check-comps.mjs) so the browser engine and this one
// can never drift into suggesting different numbers for the same card.
export const ASK_ENDINGS = [0.48, 0.98];

// Snap an amount to a psychological ending. DOWN is the only safe direction for a price whose whole
// job is to undercut the cheapest in-cluster listing: rounding up would put us above the competitor
// we are trying to beat, which is worse than the few cents the snap gives away. `nearest` exists for
// the quick-pick figures that are targets rather than undercuts (fair value, +10%, TCGplayer).
export function snapToEnding(aud, mode = 'down') {
  if (aud == null || !isFinite(aud) || !(aud > 0)) return aud;
  const c = Math.round(aud * 100);
  const whole = Math.floor(c / 100);
  // Candidates from the dollar below, this dollar and the one above — enough to bracket c from both
  // sides whatever the endings are. Ascending, because both loops ascend.
  const cands = [];
  for (const w of [whole - 1, whole, whole + 1]) for (const e of ASK_ENDINGS) cands.push(w * 100 + Math.round(e * 100));
  const under = cands.filter((x) => x > 0 && x <= c);
  const below = under.length ? under[under.length - 1] : null;
  const above = cands.find((x) => x >= c);
  if (mode !== 'nearest') return (below != null ? below : cands.find((x) => x > 0)) / 100;
  if (below == null) return above / 100;
  return (c - below <= above - c ? below : above) / 100;
}

// Undercut ONE competitor's delivered price by a cent, snapped DOWN to a price ending, floored at
// $0.50. Pulled out of recommendedFromCluster so the repricer's "beat the Nth cheapest listing"
// anchor rounds identically to the cluster anchor — two ways of choosing WHICH competitor to beat,
// one way of beating them.
export function undercut(aud) {
  if (aud == null || !isFinite(aud) || !(aud > 0)) return null;
  return Math.max(0.5, snapToEnding(Math.round((aud - 0.01) * 100) / 100, 'down'));
}

// recommended list price = undercut the cheapest IN-cluster listing. Verbatim port of extras.js
// analyzeComps line 518.
export function recommendedFromCluster(cluster) {
  return undercut(cluster.cheapestInCluster);
}

// singlesEbayValue({ base, query, numberMatch, lang, finish, excludeSeller, graded, minComps })
// → { matched, recommended, fair, cheapest, clusterRange, comparable, sampleSize, mode, confidence,
//     reliable, currency:'AUD', query } | { matched:false, reason }. Never throws.
export async function singlesEbayValue(opts = {}) {
  const { base, query, numberMatch, lang, finish, excludeSeller, graded = false, minComps = 4, timeoutMs = 12000 } = opts;
  const q = String(query || '').trim();
  if (!q) return { matched: false, reason: 'no_query' };
  const origin = String(base || '').replace(/\/$/, '');
  const enc = encodeURIComponent(q);
  const get = async (path) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try { const r = await fetch(origin + path, { signal: ac.signal }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, json }; }
    catch (e) { return { status: 0, error: String((e && e.message) || e) }; }
    finally { clearTimeout(t); }
  };

  let rows = null, mode = 'asking';
  const sold = await get('/api/ebay/buy/marketplace_insights/v1_beta/item_sales/search?limit=100&q=' + enc + '&filter=' + encodeURIComponent(askFilter('buyingOptions:{FIXED_PRICE}')));
  if (sold.status === 200 && sold.json && Array.isArray(sold.json.itemSales)) { rows = sold.json.itemSales.map(rowFromSold).filter(Boolean); mode = 'sold'; }
  if (!rows || !rows.length) {
    const ask = await get('/api/ebay/buy/browse/v1/item_summary/search?limit=200&q=' + enc + '&filter=' + encodeURIComponent(askFilter('buyingOptions:{FIXED_PRICE}')));
    if (ask.status === 503) return { matched: false, reason: 'ebay_unconfigured' };
    if (ask.status !== 200 || !ask.json) return { matched: false, reason: 'ebay_http_' + ask.status };
    rows = (ask.json.itemSummaries || []).map(rowFromAsk).filter(Boolean); mode = 'asking';
  }
  if (!rows.length) return { matched: false, reason: 'no_listings', query: q };

  // Exclude our own listings so we never price a card off ourselves.
  if (excludeSeller) { const ex = String(excludeSeller).toLowerCase(); rows = rows.filter((r) => (r.seller || '').toLowerCase() !== ex); }

  // Precision filter to THIS card, then progressive relaxation (raw fixed-price → +auctions → +graded)
  // exactly like the browser engine, so a thin card still yields a cluster rather than nothing.
  const matched = singlesFilter(rows, { numberMatch, lang, finish }).map((r) => ({ ...r, graded: isGraded(r) }));
  const withShip = (list) => list.filter((r) => r.ship != null);
  let basis = withShip(matched.filter((r) => !r.graded && !r.auction));
  if (basis.length < 5) basis = withShip(matched.filter((r) => !r.graded));
  if (basis.length < 5) basis = withShip(matched);
  // For a graded card, price off the graded cluster instead.
  if (graded) { const g = withShip(matched.filter((r) => r.graded)); if (g.length) basis = g; }

  const delivered = basis.map((r) => r.price + r.ship);
  const cluster = clusterValue(delivered);
  if (!cluster || cluster.n < minComps) return { matched: false, reason: 'too_few_comps', comparable: cluster ? cluster.n : 0, mode, query: q, sampleSize: rows.length };

  let score = 0;
  if (cluster.n >= 15) score += 2; else if (cluster.n >= 6) score += 1;
  if (cluster.clusterFrac >= 0.5) score += 2; else if (cluster.clusterFrac >= 0.33) score += 1;
  if (mode === 'sold') score += 2;
  const confidence = score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low';
  const reliable = confidence !== 'low' && cluster.clusterHi <= 4 * cluster.clusterLo;
  const r2 = (x) => Math.round(x * 100) / 100;

  return {
    matched: true, reliable, currency: 'AUD', source: 'ebay', mode,
    recommended: recommendedFromCluster(cluster),
    fair: r2(cluster.fair), cheapest: r2(cluster.cheapestInCluster),
    clusterRange: [r2(cluster.clusterLo), r2(cluster.clusterHi)],
    // The cheapest few DELIVERED prices, ascending. `cheapest` above is the cheapest in the modal
    // CLUSTER, which on a card with a cheap tail sits well above the actual front of the queue —
    // measured: Forest of Vitality's cluster started at A$18.50 while five real listings sat between
    // A$12.00 and A$14.50. A repricer whose goal is "stay on page one" has to see that tail, so it
    // gets the raw low end rather than a summary of the middle. Capped at 10: enough for any sane
    // anchor, small enough to carry around and store.
    lowest: delivered.slice().sort((a, b) => a - b).slice(0, 10).map(r2),
    // …and the same tail with the coupon flag attached, because a couponed row's price is an upper
    // bound rather than a price (see rowFromAsk). `lowest` stays a plain number array so nothing that
    // already reads it has to change.
    lowestRows: basis.map((r) => ({ delivered: r2(r.price + r.ship), coupon: !!r.coupon }))
      .sort((a, b) => a.delivered - b.delivered).slice(0, 10),
    comparable: cluster.n, sampleSize: rows.length, confidence, query: q,
  };
}
