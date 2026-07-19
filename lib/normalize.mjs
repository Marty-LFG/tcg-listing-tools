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

  onepiece(j, variant) {
    // OPTCG API returns an ARRAY of art variants. Base and alt art differ ENORMOUSLY in value (GR5:
    // OP01-001 base ~$6 vs parallel ~$568), so pick by the variant's art. An alt is tagged BOTH by a
    // trailing "(Alternate Art)"/"(Parallel)"/… in card_name AND a "_pN" in the image; newer sets
    // (OP-16+) append a random hash to the image (OP16-001_p1_ra2rQjc.jpg), so match "_pN" up to "_"/".".
    // market_price = TCGplayer market (USD). Mirror: onepiece-listing-builder.html opVariantLabel().
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : (j ? [j] : []));
    if (!arr.length) return null;
    const isAlt = (c) => /\((?:alternate|parallel|manga|special|box topper)/i.test(String(c.card_name || ''))
      || /_p\d+(?:[._])/i.test(String(c.card_image || c.card_image_id || ''));
    const wantAlt = /alt|parallel|manga|special|box|\baa\b|_p/i.test(variant || '');
    const c = arr.find((x) => isAlt(x) === wantAlt) || arr[0];
    if (!c || c.market_price == null) return null;
    return { market: +c.market_price, low: c.inventory_price != null ? +c.inventory_price : null, currency: 'USD', source: 'optcgapi' };
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
    case 'onepiece':
      // identity_key is the card code, e.g. "OP01-001" / "ST01-001" (OPTCG uses uppercase).
      return '/api/op/sets/card/' + encodeURIComponent(String(identityKey).toUpperCase()) + '/';
    default:
      return null;
  }
}

// Card-data games: each MUST have a live card mapper + lookup path + image extractor below (the price
// tracker + card builders depend on this — enforced by test/unit/normalize.test.mjs). Do NOT add a game
// here without wiring its data pipeline. (One Piece joined once optcgapi.com was wired in — /api/op.)
export const GAMES = ['riftbound', 'mtg', 'pokemon', 'swu', 'lorcana', 'onepiece'];

// Games we can hold in INVENTORY (graded + sealed stock). A SUPERSET of the card-data GAMES: a future
// stockable-only game (e.g. a sealed line with no card API) goes here, NOT in GAMES. Currently every
// stockable game also has a card pipeline, so this equals GAMES. The graded + sealed inventory validate
// against this list (sealed also adds 'other'); the tracker/builders use GAMES.
export const STOCK_GAMES = [...GAMES];

// Best-effort card-image URL from an upstream card payload, per game (mirror of the
// builders' image extraction). Returns a URL string or null — never throws.
export function imageFrom(game, cardJson) {
  const c = unwrap(cardJson);
  if (!c || typeof c !== 'object') return null;
  switch (game) {
    case 'pokemon':
      return (c.images && (c.images.large || c.images.small)) || null;
    case 'mtg':
      if (c.image_uris) return c.image_uris.large || c.image_uris.normal || c.image_uris.png || null;
      if (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris)
        return c.card_faces[0].image_uris.large || c.card_faces[0].image_uris.normal || null;
      return null;
    case 'lorcana': {
      const iu = c.image_uris;
      if (!iu) return null;
      if (iu.digital) return iu.digital.large || iu.digital.normal || iu.digital.small || null;
      return iu.large || iu.normal || null;
    }
    case 'swu':
      return c.FrontArt || c.frontArt || c.Image || null;
    case 'riftbound':
      if (Array.isArray(c.images) && c.images[0]) return c.images[0].large || c.images[0].url || c.images[0] || null;
      if (c.images && typeof c.images === 'object') return c.images.large || c.images.normal || null;
      return c.image || c.img || null;
    case 'onepiece': {
      const arr = Array.isArray(c) ? c : (Array.isArray(c.data) ? c.data : null);
      if (arr) return (arr[0] && arr[0].card_image) || null;
      return c.card_image || null;
    }
    default:
      return null;
  }
}
