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

export function searchUrl(query, { sold = false } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return null;
  const p = new URLSearchParams({ _nkw: q, LH_BIN: '1', _sop: sold ? '13' : '15' });
  if (sold) { p.set('LH_Sold', '1'); p.set('LH_Complete', '1'); }
  p.set('rt', 'nc'); p.set('LH_PrefLoc', '1');
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
