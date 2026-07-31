// lib/ebay-links.mjs — eBay AU URLs built server-side, for Telegram cards and anything else that
// needs a link outside the browser.
//
// The search parameters mirror the client-side ebaySearchUrl() in stock-runner.html and
// stock-uploader.html EXACTLY, so a "Sold" link tapped from a Telegram card lands on the same
// results as the one clicked in the listing tools. If you change the shape here, change it there
// too — they are deliberately identical and there is no shared module the inline page scripts can
// import from.
//
//   _sop=15  price + postage, lowest first  (what you want when checking what to charge)
//   _sop=13  ended most recently first      (what you want when checking what actually sold)
//   LH_BIN   Buy It Now only — auctions are noise when pricing a single
//   LH_Sold + LH_Complete  completed sales only

const BASE = 'https://www.ebay.com.au';

export function itemUrl(itemId) {
  const id = String(itemId == null ? '' : itemId).trim();
  return id ? BASE + '/itm/' + encodeURIComponent(id) : null;
}

export function searchUrl(query, { sold = false } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return null;
  const p = new URLSearchParams({ _nkw: q, LH_BIN: '1', _sop: sold ? '13' : '15' });
  if (sold) { p.set('LH_Sold', '1'); p.set('LH_Complete', '1'); }
  return BASE + '/sch/i.html?' + p.toString();
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
