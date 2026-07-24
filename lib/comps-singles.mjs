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
import { clusterValue, rowFromAsk, rowFromSold } from './comps.mjs';

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

// recommended list price = undercut the cheapest IN-cluster listing by 1c, floored at $0.50.
// Verbatim port of extras.js analyzeComps line 518.
export function recommendedFromCluster(cluster) {
  return Math.max(0.5, Math.round((cluster.cheapestInCluster - 0.01) * 100) / 100);
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
  const sold = await get('/api/ebay/buy/marketplace_insights/v1_beta/item_sales/search?limit=100&q=' + enc + '&filter=' + encodeURIComponent('buyingOptions:{FIXED_PRICE}'));
  if (sold.status === 200 && sold.json && Array.isArray(sold.json.itemSales)) { rows = sold.json.itemSales.map(rowFromSold).filter(Boolean); mode = 'sold'; }
  if (!rows || !rows.length) {
    const ask = await get('/api/ebay/buy/browse/v1/item_summary/search?limit=200&q=' + enc + '&filter=' + encodeURIComponent('buyingOptions:{FIXED_PRICE}'));
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
    comparable: cluster.n, sampleSize: rows.length, confidence, query: q,
  };
}
