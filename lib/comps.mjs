// lib/comps.mjs — server-side eBay AU market value for SEALED products.
//
// Mirrors the price-extraction + cluster analysis of extras.js `TCG.ebayComps`/`analyzeComps` (Golden
// Rule 9) but TUNED FOR SEALED, not singles. The singles path's JUNK_RE deliberately EXCLUDES
// box/pack/bundle/sealed; here we do the opposite — keep the right sealed PRODUCT TYPE and exclude the
// noise a human would filter out on eBay (empties, opened, single packs, the wrong bundle, proxies).
// It self-fetches the dev server's `/api/ebay` proxy (app OAuth token + EBAY_AU marketplace ⇒ prices
// already in AUD). Sold comps (Marketplace Insights) are tried first, then Browse (asking). Money is
// AUD dollars here; the caller rounds to INTEGER CENTS (GR3). NEVER throws (GR7): any failure ⇒
// { matched:false }. The clustering (mode bin → widen → median) is a faithful port of analyzeComps.

// ---- product-type keyword matching (sealed) --------------------------------
// For each sealed product_type: `want` = a phrase the title should carry (so a box comp is really a
// box), `deny` = phrases that mean a DIFFERENT sealed product (so a booster box isn't priced off a
// cheaper pack/bundle/ETB with a similar name — e.g. Mega Evolution "Enhanced Booster Box" vs the
// "Ascended Heroes Booster Bundle").
const TYPE_KEYWORDS = {
  booster_box: { want: [/booster box/], deny: [/booster pack/, /single pack/, /loose pack/, /\bpack lot\b/, /\bbundle\b/, /elite trainer|\betb\b/, /\btin\b/, /\bblister\b/, /premium collection/, /\bcase\b/, /starter/] },
  elite_trainer_box: { want: [/elite trainer box/, /\betb\b/], deny: [/booster box/, /booster bundle/, /booster pack/, /\btin\b/, /\bblister\b/, /\bcase\b/] },
  booster_bundle: { want: [/booster bundle/, /\bbundle\b/], deny: [/booster box/, /elite trainer|\betb\b/, /single pack/, /\btin\b/, /\bcase\b/] },
  booster_pack: { want: [/booster pack/, /sleeved booster/], deny: [/booster box/, /\bbundle\b/, /elite trainer|\betb\b/, /\bcase\b/, /\blot\b/, /\bx\s*\d{2,}\b/, /\d{2,}\s*pack/] },
  booster_case: { want: [/\bcase\b/], deny: [/booster pack/, /elite trainer|\betb\b/, /single/] },
  tin: { want: [/\btin\b/], deny: [/booster box/, /\bbundle\b/, /elite trainer/] },
  blister: { want: [/\bblister\b/, /sleeved booster/, /checklane/, /hanger/, /3[\s-]?pack/, /3pk/], deny: [/booster box/, /elite trainer/, /\bbundle\b/, /\bcase\b/] },
  collection: { want: [/collection/], deny: [/booster box/, /elite trainer/] },
  premium_collection: { want: [/premium collection/, /ultra premium/], deny: [/booster box/, /elite trainer/] },
  starter_deck: { want: [/starter/, /theme deck/, /two[\s-]?player|2[\s-]?player/], deny: [/booster box/, /booster pack/] },
  commander_deck: { want: [/commander/], deny: [/booster box/, /booster pack/] },
  prerelease_pack: { want: [/pre[\s-]?release/], deny: [/booster box/] },
  other: { want: [], deny: [] },
};

// Always-exclude for sealed comps regardless of type: opened/empty boxes, proxies, code-cards, graded
// slabs, digital. These are the listings that would drag a sealed value the wrong way.
const SEALED_DENY = /\bempty\b|\bopened\b|no cards|cards removed|\bproxy\b|\brepro\b|reprint|\bcustom\b|digital|online code|code ?card only|read description|damaged|\bgraded\b|\bpsa\b|\bcgc\b|\bbgs\b/i;

// ---- language gate ---------------------------------------------------------
// A sealed product's LANGUAGE is part of its identity (GR5), and the price gap between a Japanese
// booster box and its English twin is large. Nothing in this engine used to know that, so a JP box
// was valued off EN comps and vice versa — the same set name matched both.
//
// The gate is symmetric and deliberately conservative:
//   non-English   -> the title MUST carry that language's word (sellers always say it, because on a
//                    non-English box it is the whole selling point)
//   English       -> the title must NOT carry any OTHER language's word
//   unknown/blank -> no gate at all (GR7: a missing field must not become a refusal)
// Simplified and Traditional Chinese cannot be told apart reliably from a title — most sellers write
// only "Chinese" — so each requires a Chinese word and denies the other script's qualifier. That is
// the honest best available, and it errs toward keeping a comp rather than inventing precision.
const LANG_ANY = /\bjapan(?:ese)?\b|\bjpn?\b|\bchin(?:a|ese)\b|\bkorean?\b|\bkor\b/i;
const LANG_WANT = {
  JP: /\bjapan(?:ese)?\b|\bjpn?\b/i,
  CN: /\bchin(?:a|ese)\b/i,
  TW: /\bchin(?:a|ese)\b/i,
  KO: /\bkorean?\b|\bkor\b/i,
};
const LANG_DENY = { CN: /\btraditional\b/i, TW: /\bsimplified\b/i };
export function matchesSealedLanguage(title, language) {
  const code = String(language == null ? '' : language).trim().toUpperCase();
  if (!code) return true;                        // unknown -> no gate (GR7)
  const t = String(title || '');
  if (code === 'EN') return !LANG_ANY.test(t);   // an English box is the one that names no language
  const want = LANG_WANT[code];
  if (!want) return true;                        // a language we have no vocabulary for -> no gate
  if (!want.test(t)) return false;
  const deny = LANG_DENY[code];
  return !(deny && deny.test(t));
}

// Does an eBay listing title plausibly match THIS sealed product + type? Exported for the unit harness.
export function matchesSealedType(title, productType) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  if (SEALED_DENY.test(t)) return false;
  const spec = TYPE_KEYWORDS[productType] || TYPE_KEYWORDS.other;
  if (spec.deny.some((re) => re.test(t))) return false;
  if (spec.want.length && !spec.want.some((re) => re.test(t))) return false;
  return true;
}

// ---- cluster value (faithful port of analyzeComps' fair-value math) --------
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q, base = Math.floor(pos), rest = pos - base;
  return sortedAsc[base + 1] !== undefined ? sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]) : sortedAsc[base];
}
function median(arr) { return quantile(arr.slice().sort((a, b) => a - b), 0.5); }

// Comps have to describe the sellers an Australian buyer actually chooses between.
//
// eBay AU Browse returns GLOBAL listings, and every figure in this file is DELIVERED (list price plus
// postage), so an overseas listing arrives with its international freight baked in. Measured on one
// live card: 78 of 102 comps were overseas at an average A$19.41 postage, against A$1.18 for the 24
// Australian ones — and the modal cluster landed on A$18.33, which is a US$2.33 card plus A$16.00 to
// fly it here. The repricer read that as "the market" and proposed raising a A$3.98 listing that was
// already the third cheapest in the country. Pricing against that is pricing against freight.
//
// Location is the fix rather than a postage heuristic: "cheap card, expensive postage" and "expensive
// card, free postage" are indistinguishable by ratio alone, and the thing that actually makes a comp
// comparable is that the buyer could pick it instead of ours on the same terms.
export const AU_ONLY = 'itemLocationCountry:AU';
export const askFilter = (base) => [base, AU_ONLY].filter(Boolean).join(',');

// Given delivered prices, find the densest price CLUSTER and return its median as the fair value
// (the cheapest listing is a poor signal — one lowball among many real prices misreads the market).
// Returns { fair, cheapestInCluster, clusterLo, clusterHi, n, clusterFrac } or null (empty). Exported.
export function clusterValue(deliveredPrices) {
  const prices = (deliveredPrices || []).filter((p) => p > 0).sort((a, b) => a - b);
  const n = prices.length;
  if (!n) return null;
  if (n < 3) return { fair: median(prices), cheapestInCluster: prices[0], clusterLo: prices[0], clusterHi: prices[n - 1], n, clusterFrac: 1 };
  const lo = prices[0], hiClip = quantile(prices, 0.95) || prices[n - 1], hi = Math.max(hiClip, lo + 0.01);
  const bins = Math.max(5, Math.min(14, Math.round(Math.sqrt(n)) * 2));
  const w = (hi - lo) / bins || 1;
  const hist = []; for (let i = 0; i < bins; i++) hist.push({ lo: lo + i * w, count: 0, items: [] });
  prices.forEach((p) => { const idx = Math.min(bins - 1, Math.max(0, Math.floor((p - lo) / w))); hist[idx].count++; hist[idx].items.push(p); });
  const modeBin = hist.reduce((m, b) => (b.count > m.count ? b : m), hist[0]);
  const mi = hist.indexOf(modeBin);
  let cluster = modeBin.items.slice();
  [mi - 1, mi + 1].forEach((j) => { if (hist[j] && hist[j].count >= modeBin.count * 0.5) cluster = cluster.concat(hist[j].items); });
  cluster.sort((a, b) => a - b);
  return { fair: median(cluster), cheapestInCluster: cluster[0], clusterLo: cluster[0], clusterHi: cluster[cluster.length - 1], n, clusterFrac: cluster.length / n };
}

// ---- eBay row parsing (mirror of extras.js ebNormAsk/ebNormSold) — exported so the singles engine
// (lib/comps-singles.mjs) reuses the ONE parser (GR9), incl. the seller for own-listing exclusion. ---
export const shipOf = (opts) => { const so = (opts || [])[0]; return (so && so.shippingCost && so.shippingCost.value != null) ? parseFloat(so.shippingCost.value) : null; };
const isAuction = (it) => Array.isArray(it.buyingOptions) && it.buyingOptions.indexOf('AUCTION') >= 0;
export function rowFromAsk(it) {
  const price = it.price && parseFloat(it.price.value);
  if (!(price > 0)) return null;
  // `availableCoupons` says a seller coupon EXISTS but never what it is worth — eBay gives a boolean
  // here and shows the real figure only on the listing page. Measured on Sett - Brawler 164/298: a
  // listing the API prices at A$40.00 + A$5.40 reads "AU $30.00 with coupon" in the browser, i.e.
  // A$35.40 delivered, CHEAPER than ours while the engine ranked it dearest of the three. So the
  // price on a couponed row is an upper bound, not a price, and the anchor has to treat it that way.
  return { price, ship: shipOf(it.shippingOptions), loc: (it.itemLocation && it.itemLocation.country) || '?', title: it.title || '', cond: it.condition || '', condId: String(it.conditionId || ''), seller: (it.seller && it.seller.username) || null, auction: isAuction(it), sold: false, coupon: it.availableCoupons === true };
}
export function rowFromSold(s) {
  const lp = s.lastSoldPrice, price = lp && parseFloat(lp.value);
  if (!(price > 0)) return null;
  return { price, ship: shipOf(s.shippingOptions), loc: (s.itemLocation && s.itemLocation.country) || '?', title: s.title || '', cond: s.condition || '', condId: String(s.conditionId || ''), seller: (s.seller && s.seller.username) || null, auction: false, sold: true };
}
export { clusterValue as _clusterValue };

// ---- public: eBay AU value for a sealed product ----------------------------
// opts: { base, query, productType, language, excludeSeller, minComps=4, timeoutMs=12000 }.
// Self-fetches the /api/ebay proxy. Returns { matched, value, currency:'AUD', source:'ebay', mode,
//   sampleSize, comparable, cheapest, confidence, query, language } or { matched:false, reason }.
// Never throws.
export async function sealedEbayValue(opts) {
  const { base, query, productType, language = null, excludeSeller = null, minComps = 4, timeoutMs = 12000 } = opts || {};
  const q = String(query || '').trim();
  if (!q) return { matched: false, reason: 'no_query' };
  const origin = String(base || '').replace(/\/$/, '');
  const enc = encodeURIComponent(q);
  const get = async (path) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(origin + path, { signal: ac.signal });
      const status = r.status;
      let json = null; try { json = await r.json(); } catch { /* non-json */ }
      return { status, json };
    } catch (e) { return { status: 0, error: String((e && e.message) || e) }; }
    finally { clearTimeout(t); }
  };

  let rows = null, mode = 'asking';
  // 1) SOLD (Marketplace Insights) — best signal; 403 invalid_scope means it isn't granted → fall back.
  const sold = await get('/api/ebay/buy/marketplace_insights/v1_beta/item_sales/search?limit=100&q=' + enc + '&filter=' + encodeURIComponent(askFilter('buyingOptions:{FIXED_PRICE}')));
  if (sold.status === 200 && sold.json && Array.isArray(sold.json.itemSales)) {
    rows = sold.json.itemSales.map(rowFromSold).filter(Boolean); mode = 'sold';
  }
  // 2) ASKING (Browse) — always available with the app token.
  if (!rows || !rows.length) {
    const ask = await get('/api/ebay/buy/browse/v1/item_summary/search?limit=200&q=' + enc + '&filter=' + encodeURIComponent(askFilter('buyingOptions:{FIXED_PRICE}')));
    if (ask.status === 503) return { matched: false, reason: 'ebay_unconfigured' };
    if (ask.status !== 200 || !ask.json) return { matched: false, reason: 'ebay_http_' + ask.status };
    rows = (ask.json.itemSummaries || []).map(rowFromAsk).filter(Boolean); mode = 'asking';
  }
  // Our own live listing must never feed our own valuation (mirrors lib/comps-singles.mjs excludeSeller).
  // Without this a sealed listing we published becomes a comp for itself, and the nightly refresh walks
  // the price up against nothing but our own ask.
  if (excludeSeller) { const ex = String(excludeSeller).toLowerCase(); rows = rows.filter((r) => (r.seller || '').toLowerCase() !== ex); }
  if (!rows.length) return { matched: false, reason: 'no_listings', query: q };

  // Keep only listings that are THIS sealed product type AND language, fixed-price, delivered price known.
  const kept = rows.filter((r) => !r.auction && r.ship != null && matchesSealedType(r.title, productType) && matchesSealedLanguage(r.title, language));
  const delivered = kept.map((r) => r.price + r.ship);
  const cluster = clusterValue(delivered);
  if (!cluster || cluster.n < minComps) return { matched: false, reason: 'too_few_comps', comparable: cluster ? cluster.n : 0, mode, query: q };

  // Confidence: sample size + cluster tightness + sold-vs-asking.
  let score = 0;
  if (cluster.n >= 12) score += 2; else if (cluster.n >= 6) score += 1;
  if (cluster.clusterFrac >= 0.5) score += 2; else if (cluster.clusterFrac >= 0.33) score += 1;
  if (mode === 'sold') score += 2;
  const confidence = score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low';
  // `reliable` = trust this as the value (vs falling back to PriceCharting): not low-confidence AND the
  // cluster isn't absurdly wide (a >4x lo→hi spread means we caught a mixed bag — e.g. a "151" query
  // that conflated Premium and ULTRA Premium collections — so the median isn't a real market price).
  const reliable = confidence !== 'low' && cluster.clusterHi <= 4 * cluster.clusterLo;

  return {
    matched: true, reliable, value: Math.round(cluster.fair * 100) / 100, currency: 'AUD', source: 'ebay',
    mode, sampleSize: rows.length, comparable: cluster.n, cheapest: Math.round(cluster.cheapestInCluster * 100) / 100,
    clusterRange: [Math.round(cluster.clusterLo * 100) / 100, Math.round(cluster.clusterHi * 100) / 100],
    confidence, query: q, language: language || null,
  };
}
