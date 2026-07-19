// test/unit/normalize.test.mjs — the server-side price-extraction mirror (lib/normalize.mjs).
// These are behavioural pins for the mirror side of Golden Rule 9: if a mapper changes
// shape, this fails alongside the builder-parity harness.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapPrice, lookupPath, imageFrom, toAUD, GAMES, STOCK_GAMES } from '../../lib/normalize.mjs';

describe('toAUD', () => {
  const rates = { USD: 1, AUD: 1.5, EUR: 0.9 };
  it('converts USD via the AUD rate', () => assert.equal(toAUD(10, 'USD', rates), 15));
  it('converts non-USD through USD first', () => {
    assert.ok(Math.abs(toAUD(9, 'EUR', rates) - 15) < 1e-9); // 9/0.9*1.5
  });
  it('null amount or missing rates → null', () => {
    assert.equal(toAUD(null, 'USD', rates), null);
    assert.equal(toAUD(10, 'USD', null), null);
  });
  it('zero maps to null (current behaviour — falsy guard)', () => {
    assert.equal(toAUD(0, 'USD', rates), null);
  });
});

describe('mapPrice: riftbound (scrydex)', () => {
  const card = {
    data: {
      variants: [
        { name: 'normal', prices: [{ condition: 'NM', market: 5.5, currency: 'USD', trends: { days_7: { percent_change: 12 } } }] },
        { name: 'foil', prices: [{ condition: 'NM', market: 20, currency: 'USD' }] },
      ],
    },
  };
  it('picks the normal variant NM price and flattens trends', () => {
    const p = mapPrice('riftbound', card, 'Normal');
    assert.equal(p.market, 5.5);
    assert.equal(p.source, 'scrydex');
    assert.equal(p.pct_7d, 12);
    assert.equal(p.pct_30d, null);
  });
  it('Foil variant routes to the foil prices', () => {
    assert.equal(mapPrice('riftbound', card, 'Foil').market, 20);
  });
  it('no variants → null', () => assert.equal(mapPrice('riftbound', { data: {} }), null));
});

describe('mapPrice: mtg (scryfall)', () => {
  it('finish preference: etched > foil > nonfoil buckets', () => {
    const j = { prices: { usd: '1.5', usd_foil: '3', usd_etched: '7' } };
    assert.equal(mapPrice('mtg', j, '').market, 1.5);
    assert.equal(mapPrice('mtg', j, 'Foil').market, 3);
    assert.equal(mapPrice('mtg', j, 'Etched Foil').market, 7);
  });
  it('EUR fallback when no USD price', () => {
    const p = mapPrice('mtg', { prices: { eur: '2' } });
    assert.equal(p.currency, 'EUR');
    assert.equal(p.market, 2);
  });
  it('no prices → null', () => assert.equal(mapPrice('mtg', { prices: {} }), null));
});

describe('mapPrice: pokemon (pokemontcg)', () => {
  it('reads the tcgplayer bucket, market before mid', () => {
    const p = mapPrice('pokemon', { tcgplayer: { prices: { normal: { market: 2, low: 1 } } } }, 'Normal');
    assert.deepEqual([p.market, p.low, p.currency], [2, 1, 'USD']);
  });
  it('holo variant prefers the holofoil bucket', () => {
    const j = { tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 9 } } } };
    assert.equal(mapPrice('pokemon', j, 'Holofoil').market, 9);
  });
  it('cardmarket EUR fallback', () => {
    const p = mapPrice('pokemon', { cardmarket: { prices: { averageSellPrice: 1.2, lowPrice: 0.5 } } });
    assert.deepEqual([p.market, p.currency], [1.2, 'EUR']);
  });
});

describe('mapPrice: swu (swudb)', () => {
  it('MarketPrice primary, LowPrice carried', () => {
    assert.deepEqual(mapPrice('swu', { MarketPrice: '3.5', LowPrice: '2' }), { market: 3.5, low: 2, currency: 'USD', source: 'swudb' });
  });
  it('LowPrice-only degrades to market:null (GR7)', () => {
    const p = mapPrice('swu', { LowPrice: '2' });
    assert.equal(p.market, null);
    assert.equal(p.low, 2);
  });
  it('nothing → null', () => assert.equal(mapPrice('swu', {}), null));
});

describe('mapPrice: lorcana (lorcast)', () => {
  const j = { prices: { usd: '1.0', usd_foil: '2.0' } };
  it('foil variant → usd_foil', () => assert.equal(mapPrice('lorcana', j, 'Foil').market, 2));
  it('base variant → usd', () => assert.equal(mapPrice('lorcana', j, '').market, 1));
  it('enchanted (foil-only): base variant falls through to usd_foil', () => {
    assert.equal(mapPrice('lorcana', { prices: { usd: null, usd_foil: '5' } }, '').market, 5);
  });
});

describe('lookupPath (collector re-fetch keys)', () => {
  it('per-game proxy paths', () => {
    assert.equal(lookupPath('riftbound', 'OGN-296'), '/api/rb/cards/OGN-296?include=prices');
    assert.equal(lookupPath('mtg', 'neo-1'), '/api/mtg/cards/neo/1');
    assert.equal(lookupPath('pokemon', 'sv4-25'), '/api/pkm/cards/sv4-25');
    assert.equal(lookupPath('swu', 'sor/010'), '/api/swu/cards/sor/010');
    assert.equal(lookupPath('lorcana', '1/205'), '/api/lorcana/cards/1/205');
  });
  it('unknown game → null', () => assert.equal(lookupPath('funko', 'x'), null));
});

describe('mapPrice: onepiece (optcgapi)', () => {
  const arr = [
    { card_image: 'https://optcgapi.com/media/static/Card_Images/OP01-001.jpg', market_price: 6.07, inventory_price: 3.28 },
    { card_image: 'https://optcgapi.com/media/static/Card_Images/OP01-001_p1.jpg', market_price: 568.01 },
  ];
  it('base art by default; alt/parallel art routes to the _p variant (GR5 — huge price gap)', () => {
    assert.equal(mapPrice('onepiece', arr).market, 6.07);
    assert.equal(mapPrice('onepiece', arr, 'Base').market, 6.07);
    assert.equal(mapPrice('onepiece', arr, 'Alt Art').market, 568.01);
    assert.equal(mapPrice('onepiece', arr, 'Parallel').market, 568.01);
  });
  it('single-variant array works; missing price / empty → null (GR4)', () => {
    assert.equal(mapPrice('onepiece', [{ card_image: 'ST01-001.jpg', market_price: 2.5 }]).market, 2.5);
    assert.equal(mapPrice('onepiece', [{ card_image: 'x.jpg' }]), null);
    assert.equal(mapPrice('onepiece', []), null);
    assert.equal(mapPrice('onepiece', null), null);
  });
  it('newer sets (OP-16+): hashed image + "(Alternate Art)" card_name still routes correctly', () => {
    // OP16-001: base image has a random hash; alt image is "..._p1_<hash>.jpg" (breaks a naive "_pN.").
    const op16 = [
      { card_name: 'Portgas.D.Ace (001)', card_image: 'OP16-001_xBcGSbE.jpg', market_price: 0.17 },
      { card_name: 'Portgas.D.Ace (001) (Alternate Art)', card_image: 'OP16-001_p1_ra2rQjc.jpg', market_price: 53.2 },
    ];
    assert.equal(mapPrice('onepiece', op16).market, 0.17, 'base by default');
    assert.equal(mapPrice('onepiece', op16, 'Alternate Art').market, 53.2, 'alt via card_name / hashed _pN');
  });
});

describe('GAMES coverage', () => {
  const SAMPLES = {
    riftbound: { variants: [{ name: 'normal', prices: [{ condition: 'NM', market: 1 }] }] },
    mtg: { prices: { usd: '1' } },
    pokemon: { tcgplayer: { prices: { normal: { market: 1 } } } },
    swu: { MarketPrice: '1' },
    lorcana: { prices: { usd: '1' } },
    onepiece: [{ card_set_id: 'OP01-001', card_image: 'OP01-001.jpg', market_price: 1 }],
  };
  it('every tracked game has a working mapper and lookup path', () => {
    for (const g of GAMES) {
      assert.ok(mapPrice(g, SAMPLES[g]), `mapper for ${g}`);
      assert.ok(lookupPath(g, 'a-1'), `lookupPath for ${g}`);
    }
  });
});

describe('STOCK_GAMES (inventory-stockable games)', () => {
  it('is a superset of the card-data GAMES (every card game is stockable)', () => {
    for (const g of GAMES) assert.ok(STOCK_GAMES.includes(g), `${g} is stockable`);
  });
  it('includes One Piece', () => {
    assert.ok(STOCK_GAMES.includes('onepiece'), 'One Piece is stockable');
    assert.ok(GAMES.includes('onepiece'), 'One Piece is now a full card-data game (optcgapi wired in)');
  });
});

describe('imageFrom', () => {
  it('per-game image extraction', () => {
    assert.equal(imageFrom('pokemon', { images: { large: 'L', small: 'S' } }), 'L');
    assert.equal(imageFrom('mtg', { image_uris: { normal: 'N' } }), 'N');
    assert.equal(imageFrom('mtg', { card_faces: [{ image_uris: { large: 'F' } }] }), 'F');
    assert.equal(imageFrom('lorcana', { image_uris: { digital: { large: 'D' } } }), 'D');
    assert.equal(imageFrom('swu', { FrontArt: 'A' }), 'A');
    assert.equal(imageFrom('riftbound', { images: [{ large: 'R' }] }), 'R');
    assert.equal(imageFrom('onepiece', [{ card_image: 'OP.jpg' }]), 'OP.jpg');
    assert.equal(imageFrom('riftbound', { img: 'I' }), 'I');
  });
  it('never throws on junk', () => {
    assert.equal(imageFrom('pokemon', null), null);
    assert.equal(imageFrom('mtg', 'string'), null);
    assert.equal(imageFrom('nope', {}), null);
  });
});
