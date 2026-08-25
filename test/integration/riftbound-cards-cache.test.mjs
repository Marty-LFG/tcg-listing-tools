// test/integration/riftbound-cards-cache.test.mjs — the three /api/riftbound catalogue routes.
//
// Unlike its four siblings there is no upstream here and nothing to cache: data/riftbound.json IS
// the source. So what is worth testing is not fetch behaviour, it is the three things this module
// actually decides:
//
//   1. The ENVELOPE. stock-runner.html parses one shape whatever the game, and only the URL differs.
//   2. The PRICE JOIN. The batch runner's disagreement detector is Riftbound's only independent
//      second opinion, and it lives on the keyless TCGplayer index rather than on the card record.
//   3. WHAT DEGRADES INTO WHAT. A missing catalog is a 503 that has to be said out loud; a missing
//      price index is not — the cards still go out, priced null (GR7).
//
// Plus the ordering regression: the prices plugin mounts at the bare '/api/riftbound' prefix and
// never calls next(), so this suite mounts BOTH and proves they coexist.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The real data/riftbound.json and data/riftbound-prices.json are gitignored, so both loaders are
// pointed at fixtures. lib/riftbound-data.mjs reads the env var per CALL for exactly this reason —
// an ESM import is hoisted above every statement, so a module-level constant could not be moved.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-rb-cards-'));
const CATALOG_PATH = path.join(TMP, 'riftbound.json');
const PRICES_PATH = path.join(TMP, 'riftbound-prices.json');

const CATALOG = {
  ogn: {
    name: 'Origins', code: 'OGN', total: 298,
    cards: [
      { k: '27', num: '027/298', name: 'Darius, Trifarian', rarity: 'Rare', type: 'Unit', domain: 'Fury', e: '3', p: '1', m: '4', img: 'https://riot/27.png', a: 'Envar Studio' },
      { k: '27a', num: '027a/298', name: 'Darius, Trifarian (Alternate Art)', rarity: 'Rare', type: 'Unit', domain: 'Fury', e: '3', p: '1', m: '4', img: 'https://riot/27a.png', a: 'Envar Studio' },
      { k: '299*', num: '299*/298', name: 'Daughter of the Void (Signature)', rarity: 'Rare', type: 'Legend', domain: 'Fury;Mind', e: '', p: '', m: '', img: 'https://riot/299s.png', a: 'Kudos Productions' },
    ],
  },
  ven: {
    name: 'Vendetta', code: 'VEN', total: 166,
    cards: [
      { k: 'sp1', num: 'SP1/006', name: "Kai'Sa, Survivor", rarity: 'Showcase', type: 'Unit', domain: 'Mind', e: '4', p: '1', m: '3', img: 'https://riot/sp1.png', a: 'Six More Vodka' },
    ],
  },
};
// Keyed exactly the way lib/riftbound-prices.mjs writes them: uppercase set code, normNum'd number.
// 'OGN-27a' is priced and 'OGN-299*' is not, which is the pair the null case needs.
const PRICES = {
  generatedAt: '2026-08-25T00:00:00.000Z',
  cards: {
    'OGN-27': { market: 0.24, low: 0.11, currency: 'USD', name: 'Darius, Trifarian', set: 'Origins', number: '027/298' },
    'OGN-27a': { market: 6.79, low: 4.2, currency: 'USD', name: 'Darius, Trifarian', set: 'Origins', number: '027a/298' },
  },
};

fs.writeFileSync(CATALOG_PATH, JSON.stringify(CATALOG));
fs.writeFileSync(PRICES_PATH, JSON.stringify(PRICES));
process.env.RIFTBOUND_DATA_PATH = CATALOG_PATH;
process.env.RIFTBOUND_PRICES_PATH = PRICES_PATH;

const { riftboundCardsPlugin } = await import('../../lib/riftbound-cards.mjs');
const { riftboundPricesPlugin } = await import('../../lib/riftbound-prices.mjs');

// Both plugins into ONE middleware chain, in the order vite.config.js registers them, so the
// swallowing bug this arrangement exists to avoid would show up here as a wrong body.
const CHAIN = [];
for (const p of [riftboundCardsPlugin(), riftboundPricesPlugin()]) {
  p.configureServer({ middlewares: { use: (at, h) => CHAIN.push({ at, h }) } });
}
function call(url) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { chunks.push(b); resolve({ status: this.statusCode, json: JSON.parse(chunks.join('') || 'null') }); },
    };
    // connect strips the mount prefix before handing the request on, and matches on a '/' boundary.
    let i = 0;
    const next = () => {
      while (i < CHAIN.length) {
        const { at, h } = CHAIN[i++];
        if (url === at || url.startsWith(at + '/') || url.startsWith(at + '?')) {
          return h({ method: 'GET', url: url.slice(at.length) || '/' }, res, next);
        }
      }
      resolve({ status: 'unrouted', json: null });
    };
    next();
  });
}

after(() => { delete process.env.RIFTBOUND_DATA_PATH; delete process.env.RIFTBOUND_PRICES_PATH; });

describe('GET /api/riftbound/sets', () => {
  it('answers the roster in the picker shape, with the bake mtime as cachedAt', async () => {
    const r = await call('/api/riftbound/sets');
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 2);
    assert.deepEqual(r.json.sets.map((s) => s.code), ['OGN', 'VEN']);
    assert.deepEqual(r.json.sets[0], { id: 'ogn', name: 'Origins', code: 'OGN', total: 298 });
    assert.ok(Date.parse(r.json.cachedAt) > 0, 'cachedAt is when the bake was last written');
  });
});

describe('GET /api/riftbound/set/:setId/cards — the envelope the runner parses', () => {
  it('carries the same fields every other game answers with', async () => {
    const r = await call('/api/riftbound/set/ogn/cards');
    assert.equal(r.status, 200);
    assert.equal(r.json.setId, 'ogn');
    assert.equal(r.json.count, 3);
    assert.equal(r.json.cards.length, 3);
    // stale and partial are constant false: the bake is atomic, so what is on disk is a complete
    // catalog or no catalog. There is no half-answered upstream to represent.
    assert.equal(r.json.stale, false);
    assert.equal(r.json.partial, false);
    assert.equal(r.json.source, 'bake');
  });
  it('stamps the identity halves the adapter cannot derive on its own', async () => {
    const { cards } = (await call('/api/riftbound/set/ogn/cards')).json;
    const alt = cards.find((c) => c.k === '27a');
    // 'OGN-27a' — the normNum key, lowercase and zero-stripped, NOT the printed '027a/298'. It is
    // what the price index, ENUMERATORS.riftbound and the watchlist are all keyed on.
    assert.equal(alt.setCode, 'OGN');
    assert.equal(alt.number, '027a/298');
    assert.equal(alt.variant, 'Alternate Art', 'the treatment comes off the baked name suffix');
    assert.equal(alt.finish, 'Foil');
    assert.equal(alt.rarity, 'Showcase');
    assert.equal(alt.illustrator, 'Envar Studio');
  });
  it('joins the keyless TCGplayer price onto every card it has one for', async () => {
    const { cards } = (await call('/api/riftbound/set/ogn/cards')).json;
    const byK = Object.fromEntries(cards.map((c) => [c.k, c]));
    assert.equal(byK['27'].marketUsd, 0.24);
    assert.equal(byK['27'].marketCurrency, 'USD');
    assert.equal(byK['27a'].marketUsd, 6.79);
    // Unpriced is a REAL answer, not a gap to paper over: a brand-new alt-art with no sales yet
    // genuinely has no market price, and the row then carries the `unverified` flag (GR4).
    assert.equal(byK['299*'].marketUsd, null);
    assert.equal(byK['299*'].marketCurrency, null);
  });
  it('resolves the SP promo block, whose key is neither numeric nor lettered-suffix', async () => {
    const { cards } = (await call('/api/riftbound/set/ven/cards')).json;
    assert.equal(cards.length, 1);
    assert.equal(cards[0].k, 'sp1');
    assert.equal(cards[0].number, 'SP1/006');
  });
  it('refuses a set id that could never be one, and 404s one that simply is not there', async () => {
    assert.equal((await call('/api/riftbound/set/..%2Fetc/cards')).status, 400);
    const miss = await call('/api/riftbound/set/zzz/cards');
    assert.equal(miss.status, 404);
    assert.equal(miss.json.code, 'no_set');
  });
});

describe('GET /api/riftbound/cards/:setId/:num — the single uploader lookup', () => {
  it('resolves every printed shape the catch line accepts', async () => {
    for (const [num, name] of [['27', 'Darius, Trifarian'], ['027', 'Darius, Trifarian'],
      ['27a', 'Darius, Trifarian'], ['299*', 'Daughter of the Void']]) {
      const r = await call('/api/riftbound/cards/ogn/' + encodeURIComponent(num));
      assert.equal(r.status, 200, num);
      assert.equal(r.json.name, name, num);
    }
    const sp = await call('/api/riftbound/cards/ven/SP1');
    assert.equal(sp.json.k, 'sp1');
    assert.equal(sp.json.setCode, 'VEN');
  });
  it('carries the price join and the identity halves, same as the set route', async () => {
    const r = await call('/api/riftbound/cards/ogn/27a');
    assert.equal(r.json.k, '27a');
    assert.equal(r.json.setCode, 'OGN');
    assert.equal(r.json.marketUsd, 6.79);
  });
  // stock-uploader.html tests `!c || c.object === 'error' || !c.name`, so an error body carrying a
  // name would be read as a card and listed.
  it('404s with NO `name` in the body', async () => {
    const r = await call('/api/riftbound/cards/ogn/9999');
    assert.equal(r.status, 404);
    assert.equal(r.json.name, undefined);
    assert.equal(r.json.object, 'error');
  });
});

describe('the ordering regression — both plugins on one prefix', () => {
  // riftboundPricesPlugin mounts at the bare '/api/riftbound' and always ends the response. If the
  // cards plugin were registered after it, every route above would come back as the prices plugin's
  // 404 { usage: … } — and nothing would throw.
  it('the prices route still answers with the cards plugin mounted in front of it', async () => {
    const r = await call('/api/riftbound/prices/OGN-27a');
    assert.equal(r.status, 200);
    assert.equal(r.json.market, 6.79);
    assert.equal(r.json.source, 'tcgplayer');
  });
  it('and an unpriced card still 404s as no_price, not as a missing route', async () => {
    const r = await call('/api/riftbound/prices/OGN-299*');
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'no_price');
  });
});

describe('degradation — what a missing file costs, and what it must not', () => {
  it('a missing PRICE index still serves the catalogue, priced null', async () => {
    const saved = process.env.RIFTBOUND_PRICES_PATH;
    process.env.RIFTBOUND_PRICES_PATH = path.join(TMP, 'no-such-prices.json');
    try {
      const r = await call('/api/riftbound/set/ogn/cards');
      assert.equal(r.status, 200, 'losing the second opinion must never cost you the catalogue');
      assert.equal(r.json.count, 3);
      assert.ok(r.json.cards.every((c) => c.marketUsd === null));
    } finally { process.env.RIFTBOUND_PRICES_PATH = saved; }
  });
  it('a missing CATALOG is a 503 that says how to fix it, never an empty set list', async () => {
    const saved = process.env.RIFTBOUND_DATA_PATH;
    process.env.RIFTBOUND_DATA_PATH = path.join(TMP, 'no-such-catalog.json');
    try {
      for (const url of ['/api/riftbound/sets', '/api/riftbound/set/ogn/cards', '/api/riftbound/cards/ogn/27']) {
        const r = await call(url);
        assert.equal(r.status, 503, url);
        assert.equal(r.json.code, 'catalog_missing', url);
        assert.match(r.json.hint, /build-riftbound-data/);
      }
    } finally { process.env.RIFTBOUND_DATA_PATH = saved; }
  });
});
