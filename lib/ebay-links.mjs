// lib/ebay-links.mjs — THE eBay AU URLs. Every comps link in the suite comes from here: the Telegram
// cards (repricer, post-sale), the batch runner's grid, and the single uploader. A "Sold" link tapped
// on a phone has to land on the same results as the one clicked in the grid, and the only way to be
// sure of that is to have one implementation. It used to be three, hand-kept in step by a comment,
// and they drifted the moment one of them learned something the others did not.
//
// The browser pages get it the same way the server does. Module pages import it directly; the single
// uploader's script is classic (inline onclick= handlers need globals), so a small module shim in
// that page hands it over as TCG.ebaySearchUrl. Nothing here touches node, so it runs in both.
//
//   _sop=15      price + postage, lowest first  (what you want when checking what to charge)
//   _sop=13      ended most recently first      (what you want when checking what actually sold)
//   LH_BIN       Buy It Now only — auctions are noise when pricing a single
//   LH_Sold + LH_Complete   completed sales only
//   LH_PrefLoc=1 items LOCATED IN AUSTRALIA
//   rt=nc        stop eBay quietly rewriting the query on arrival
//
// The location filter is the one worth arguing for. Without it the page fills with US and Japanese
// sellers, whose prices say nothing about what a card fetches here — postage and the exchange rate
// put them in a different market. It goes on BOTH searches: the sold prices you compare against and
// the asking prices you undercut have to come from the same pool of sellers, or it is not a
// comparison. This matches how the comps engine itself prices (lib/comps.mjs, AU sellers).

const BASE = 'https://www.ebay.com.au';

// A listing is served by the marketplace it was listed TO. Everything this suite creates goes to
// EBAY_AU, so that is the default and the only host worth naming — but a listing read back from the
// eBay API can carry another marketplace, and .com.au will not serve it. That is the whole reason
// this takes an argument: lib/channels/ebay-inventory-api.mjs hands one through from the API.
const HOSTS = { EBAY_AU: BASE };
export function itemUrl(itemId, { marketplace = 'EBAY_AU' } = {}) {
  const id = String(itemId == null ? '' : itemId).trim();
  if (!id) return null;
  return (HOSTS[marketplace] || 'https://www.ebay.com') + '/itm/' + encodeURIComponent(id);
}

// Sort orders eBay AU actually offers. Read off the live sort dropdown rather than copied from a
// blog: several secondary sources have 13 and 7 the wrong way round. 13 (ended recently) only
// appears on a sold/completed search, which is why the default below keys off `sold`.
export const SOP = { best: 12, endingSoonest: 1, newlyListed: 10, priceLow: 15, priceHigh: 16, distance: 7, endedRecently: 13 };
const SOP_OK = new Set(Object.values(SOP).map(String));
// LH_PrefLoc: 1 Australia only · 2 worldwide · 98 eBay's default · 99 local pickup. 3 is "North
// America" on the US site and is NOT valid here — it returns a page with no result count at all,
// so it is folded to AU rather than passed through to fail silently.
const PREFLOC_OK = new Set(['1', '2', '98', '99']);
// eBay stops serving results past 4,000 deep whatever the headline count says: _ipg=240&_pgn=16 is
// the last page that returns anything, _pgn=17 returns none. Exported so a caller can say WHY a
// page is empty instead of showing a blank grid.
export const REACHABLE_CAP = 4000;
export const MAX_IPG = 240;

// Aspect params are DOUBLE url-encoded on the search page, and a wrongly-encoded one is not an
// error — eBay silently ignores it and returns the UNFILTERED set, which reads exactly like a
// filter that matched everything. encodeURIComponent leaves ( and ) alone, but eBay wants them
// encoded too ("...%2528PSA%2529"), so they are escaped by hand here. One implementation, because
// getting this subtly wrong is invisible.
const encAspect = (s) => encodeURIComponent(String(s == null ? '' : s)).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// The eBay AU search URL. Every default reproduces the original two-option builder byte-for-byte —
// test/unit/ebay-links.test.mjs pins the whole sold URL as a literal, so if that assertion still
// passes untouched, no existing caller can have moved. New params are appended only when they are
// non-default, which is what keeps the original ordering intact.
export function searchUrl(query, {
  sold = false,
  bin = true, auction = false,
  sort = null,                 // null => the historical sold?13:15
  prefLoc = 1,                 // 1 = Australian sellers (see the header)
  category = null,             // emits _sacat AND _dcat together, always
  aspects = null,              // { 'Professional Grader': ['...(PSA)'], Grade: ['8'] }
  priceMin = null, priceMax = null,
  perPage = null, page = null,
} = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return null;
  const sop = SOP_OK.has(String(sort)) ? String(sort) : (sold ? '13' : '15');
  const p = new URLSearchParams({ _nkw: q });
  if (bin) p.set('LH_BIN', '1');
  if (auction) p.set('LH_Auction', '1');
  p.set('_sop', sop);
  if (sold) { p.set('LH_Sold', '1'); p.set('LH_Complete', '1'); }
  p.set('rt', 'nc');
  p.set('LH_PrefLoc', PREFLOC_OK.has(String(prefLoc)) ? String(prefLoc) : '1');
  // _sacat alone does not bind an aspect filter — eBay wants the category named twice, once as the
  // search category and once as the "discovered" one. Emitting only _sacat is how an aspect ends up
  // silently ignored, so the pair is inseparable here.
  if (category != null && String(category).trim()) {
    p.set('_sacat', String(category).trim());
    p.set('_dcat', String(category).trim());
  }
  if (priceMin != null && isFinite(priceMin)) p.set('_udlo', String(priceMin));
  if (priceMax != null && isFinite(priceMax)) p.set('_udhi', String(priceMax));
  // Clamp rather than refuse (GR7): an out-of-range page is a caller bug, but a null URL turns it
  // into a dead link on a page that was only trying to show the next 240 rows.
  const ipg = perPage != null && isFinite(perPage) ? Math.max(1, Math.min(MAX_IPG, Math.floor(perPage))) : null;
  if (ipg) p.set('_ipg', String(ipg));
  if (page != null && isFinite(page)) {
    const maxPage = Math.max(1, Math.floor(REACHABLE_CAP / (ipg || 60)));
    p.set('_pgn', String(Math.max(1, Math.min(maxPage, Math.floor(page)))));
  }
  let out = BASE + '/sch/i.html?' + p.toString();
  // Appended raw, after toString(), because URLSearchParams would encode the already-encoded name
  // a third time. Value arrays are repeated keys, which is how eBay reads a multi-select facet.
  if (aspects) {
    for (const [name, vals] of Object.entries(aspects)) {
      for (const v of (Array.isArray(vals) ? vals : [vals])) {
        if (v == null || v === '') continue;
        out += '&' + encAspect(encAspect(name)) + '=' + encAspect(encAspect(v));
      }
    }
  }
  return out;
}

// The same search as a Browse API path, relative to our own /api/ebay proxy. It lives here for the
// reason searchUrl does: one identity, two transports, and nowhere else allowed to spell either.
// Note the API takes the AU restriction as filter=itemLocationCountry:AU (see lib/comps.mjs
// AU_ONLY) rather than LH_PrefLoc — same intent, different vocabulary.
export function browseSearchUrl(query, { limit = 200, categoryIds = null, filter = null, aspectFilter = null, fieldgroups = null, offset = null } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return null;
  const p = new URLSearchParams({ limit: String(limit), q });
  if (categoryIds) p.set('category_ids', String(categoryIds));
  if (filter) p.set('filter', String(filter));
  if (aspectFilter) p.set('aspect_filter', String(aspectFilter));
  if (fieldgroups) p.set('fieldgroups', String(fieldgroups));
  if (offset != null && isFinite(offset)) p.set('offset', String(Math.max(0, Math.floor(offset))));
  return '/api/ebay/buy/browse/v1/item_summary/search?' + p.toString();
}

// eBay's own search does better with the card's identity than with our full listing title, which
// carries condition/language noise ("EN M/NM") that no buyer's listing repeats. Trim the tail so a
// comps link actually returns comparable listings.
const TAIL_NOISE = /\s+(?:EN|JP|CN|KO)?\s*(?:M\/NM|NM\/M|NM|LP|MP|HP|DMG|PSA\s*\d+|BGS\s*\d+|CGC\s*\d+)\s*$/i;
export function compsQuery(title) {
  let t = String(title == null ? '' : title).trim().replace(/\s+/g, ' ');
  for (let i = 0; i < 3 && TAIL_NOISE.test(t); i++) t = t.replace(TAIL_NOISE, '').trim();
  return t;
}
