// lib/normalize.mjs — server-side copy of each builder's price extraction.
//
// The browser builders map their API responses to a price inline (DOM-coupled
// <script> blocks the collector can't import), so this is a deliberate mirror.
// MIRROR RULE: if you change a builder's price extraction, change it here too.
//   - Riftbound: riftbound-listing-builder.html  mapScrydexCard()/priceFrom()
//   - MTG:       mtg-listing-builder.html         doLookup() _pr builder
//   - Pokémon:   pokemon-listing-builder.html     doLookup() _tp loop
//   - SWU:       swu-listing-builder.html         doLookup() MarketPrice/LowPrice

// FX conversion — same math as extras.js conv(). `rates` is {USD:1, AUD, EUR, ...}.
export function toAUD(amount, from, rates) {
  if (amount == null || !rates) return null;
  const f = from || 'USD';
  const usd = f === 'USD' ? amount : amount / (rates[f] || 1);
  return usd * (rates.AUD || 0) || null;
}

// Some upstreams wrap the card in { data: ... }; unwrap a single object.
function unwrap(j) {
  if (j && typeof j === 'object' && !Array.isArray(j) && j.data && !Array.isArray(j.data)) return j.data;
  return j;
}

// Maps Scrydex `trends` → flat percent-change deltas we store on the snapshot.
function rbTrends(t) {
  const pick = (d) => (t && t['days_' + d] && t['days_' + d].percent_change != null ? +t['days_' + d].percent_change : null);
  return { pct_1d: pick(1), pct_7d: pick(7), pct_30d: pick(30), pct_90d: pick(90) };
}

// Each mapper: (cardJson, variant) -> { market, low, currency, source, pct_* } | null
const MAPPERS = {
  riftbound(j, variant) {
    const c = unwrap(j);
    if (!c || !c.variants) return null;
    const want = (variant === 'Foil') ? 'foil' : 'normal';
    const v = c.variants.find((x) => x.name === want) || c.variants[0];
    if (!v || !v.prices || !v.prices.length) return null;
    const p = v.prices.find((x) => x.condition === 'NM') || v.prices[0];
    if (!p || p.market == null) return null;
    return { market: +p.market, low: null, currency: p.currency || 'USD', source: 'scrydex', ...rbTrends(p.trends) };
  },

  mtg(j, variant) {
    const c = unwrap(j);
    const pr = (c && c.prices) || {};
    const fin = (variant || '').toLowerCase();
    let market = null, currency = 'USD';
    if (fin.includes('etched')) market = pr.usd_etched || pr.usd_foil || pr.usd;
    else if (fin.includes('foil')) market = pr.usd_foil || pr.usd;
    else market = pr.usd || pr.usd_foil || pr.usd_etched;
    if (market == null && pr.eur != null) { market = pr.eur; currency = 'EUR'; }
    if (market == null) return null;
    return { market: +market, low: null, currency, source: 'scryfall' };
  },

  pokemon(j, variant) {
    const c = unwrap(j);
    const tp = (c && c.tcgplayer && c.tcgplayer.prices) || null;
    if (tp) {
      // Prefer the bucket matching the tracked finish, else the first priced bucket.
      const keys = Object.keys(tp);
      const fin = (variant || '').toLowerCase();
      const pref = fin.includes('holo') && !fin.includes('non') && !fin.includes('reverse')
        ? ['holofoil', 'reverseHolofoil'] : ['normal'];
      const order = [...pref.filter((k) => keys.includes(k)), ...keys];
      for (const k of order) {
        const b = tp[k];
        if (b && (b.market != null || b.mid != null)) {
          return { market: +(b.market != null ? b.market : b.mid), low: b.low != null ? +b.low : null, currency: 'USD', source: 'pokemontcg' };
        }
      }
    }
    const cm = c && c.cardmarket && c.cardmarket.prices;
    if (cm && cm.averageSellPrice != null) {
      return { market: +cm.averageSellPrice, low: cm.lowPrice != null ? +cm.lowPrice : null, currency: 'EUR', source: 'pokemontcg' };
    }
    return null;
  },

  swu(j) {
    const c = unwrap(j);
    if (!c || c.MarketPrice == null) {
      if (c && c.LowPrice != null) return { market: null, low: +c.LowPrice, currency: 'USD', source: 'swudb' };
      return null;
    }
    return { market: +c.MarketPrice, low: c.LowPrice != null ? +c.LowPrice : null, currency: 'USD', source: 'swudb' };
  },

  lorcana(j, variant) {
    const c = unwrap(j);
    const p = (c && c.prices) || null;
    if (!p) return null;
    // Lorcast prices: { usd, usd_foil } (USD strings, daily). Enchanted/promos are foil-only
    // (usd null); foil variants prefer usd_foil. Mirror: lorcana-listing-builder.html priceFromCard().
    const foil = /foil/i.test(variant || '');
    const market = foil ? (p.usd_foil ?? p.usd) : (p.usd ?? p.usd_foil);
    if (market == null) return null;
    return { market: +market, low: null, currency: 'USD', source: 'lorcast' };
  },
};

export function mapPrice(game, cardJson, variant) {
  const fn = MAPPERS[game];
  return fn ? fn(cardJson, variant) : null;
}

// Game-specific identity_key -> proxy path the collector self-fetches.
export function lookupPath(game, identityKey) {
  switch (game) {
    case 'riftbound':
      return '/api/rb/cards/' + encodeURIComponent(identityKey) + '?include=prices';
    case 'mtg': {
      const i = identityKey.indexOf('-');
      const set = i < 0 ? identityKey : identityKey.slice(0, i);
      const num = i < 0 ? '' : identityKey.slice(i + 1);
      return '/api/mtg/cards/' + encodeURIComponent(set) + '/' + encodeURIComponent(num);
    }
    case 'pokemon':
      return '/api/pkm/cards/' + encodeURIComponent(identityKey);
    case 'swu': {
      const [set, num] = identityKey.split('/');
      return '/api/swu/cards/' + encodeURIComponent(set || '') + '/' + encodeURIComponent(num || '');
    }
    case 'lorcana': {
      const [set, num] = identityKey.split('/');
      return '/api/lorcana/cards/' + encodeURIComponent(set || '') + '/' + encodeURIComponent(num || '');
    }
    default:
      return null;
  }
}

export const GAMES = ['riftbound', 'mtg', 'pokemon', 'swu', 'lorcana'];
