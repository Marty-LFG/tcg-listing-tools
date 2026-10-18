// test/integration/riftbound-promos.test.mjs — the Riftbound PROMO lane, end to end.
//
// Riot's gallery carries no promos, and the promos hold some of the most valuable singles in the
// game. The trap they set: a promo prints a MAIN-SET number. The US$4,400 Metal Prize Wall Teemo is
// 263/298, the same number as the Origins card, the plain Teemo promo (US$58) and the Metal Best Of —
// so anything that looks a promo up by number can only ever find the wrong card. Here, promos are
// their own sets (data/riftbound-promos.json, merged server-side), keyed by TCGplayer product id,
// and a shared number is a CHOICE the page is handed, never a guess.
//
// Same in-process harness as riftbound-cards-cache.test.mjs: both plugins on one chain, fixtures in
// a temp dir, the real (gitignored) data never touched. Every fixture row is real 2026-09-24 data.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';

const TMP = tmpDir('tcg-rb-promos-');
const CATALOG_PATH = path.join(TMP, 'riftbound.json');
const PROMOS_PATH = path.join(TMP, 'riftbound-promos.json');   // the default: beside the catalog
const PRICES_PATH = path.join(TMP, 'riftbound-prices.json');

const CATALOG = {
  ogn: {
    name: 'Origins', code: 'OGN', total: 298,
    cards: [
      { k: '7', num: '007/298', name: 'Fury Rune', rarity: 'Common', type: 'Rune', domain: 'Fury', e: '', p: '', m: '', img: 'https://riot/fury.png', a: 'Envar Studio', ch: '' },
      { k: '263', num: '263/298', name: 'Swift Scout', rarity: 'Rare', type: 'Legend', domain: 'Mind;Chaos', e: '', p: '', m: '', img: 'https://riot/263.png', a: 'Kudos', ch: 'Teemo' },
    ],
  },
  sfd: { name: 'Spiritforged', code: 'SFD', total: 221, cards: [] },
};
const promo = (o) => ({ rarity: 'Promo', e: '0', p: '0', m: '0', img: '', a: '', ch: '', f: 'Foil', ...o });
const PROMOS = {
  opp: {
    name: 'Riftbound Organized Play Promotional Cards', code: 'OPP', total: 0, promo: true,
    cards: [
      promo({ k: 'p662886', pid: '662886', num: '263/298', name: 'Teemo, Swift Scout', type: 'Legend', domain: 'Mind;Chaos' }),
      promo({ k: 'p669259', pid: '669259', num: '263/298', name: 'Teemo, Swift Scout (Metal) (Best Of)', type: 'Legend', domain: 'Mind;Chaos', f: '', img: 'https://tcgplayer-cdn.tcgplayer.com/product/669259_in_1000x1000.jpg' }),
      promo({ k: 'p689174', pid: '689174', num: '263/298', name: 'Teemo, Swift Scout (Metal) (Prize Wall)', type: 'Legend', domain: 'Mind;Chaos', f: 'Non-foil' }),
      promo({ k: 'p697499', pid: '697499', num: 'R01c', name: 'Fury Rune', type: 'Rune', domain: 'Fury', f: 'Non-foil' }),
      promo({ k: 'p713484', pid: '713484', num: '109/166', name: 'Illaoi, Prophet of the Great Kraken (Champion)', type: 'Unit', domain: 'Chaos', e: '6', p: '', m: '4' }),
    ],
  },
  jdg: {
    name: 'Riftbound Judge Promotional Cards', code: 'JDG', total: 0, promo: true,
    cards: [promo({ k: 'p668439', pid: '668439', num: '111/298', name: 'Heimerdinger, Inventor', type: 'Unit', domain: 'Mind', e: '3', p: '1', m: '3' })],
  },
  // A promo file entry under a RIOT key must never shadow the real set.
  ogn: { name: 'Not Origins', code: 'OGN', total: 0, promo: true, cards: [promo({ k: 'p1', num: '001/298', name: 'Impostor', type: 'Unit' })] },
};
const PRICES = {
  generatedAt: '2026-09-24T00:00:00.000Z',
  cards: {
    'OPP-p662886': { market: 57.91, currency: 'USD', name: 'Teemo, Swift Scout', number: '263/298' },
    'OPP-p689174': { market: 4400, currency: 'USD', name: 'Teemo, Swift Scout (Metal) (Prize Wall)', number: '263/298' },
    'JDG-p668439': { market: 434.41, currency: 'USD', name: 'Heimerdinger, Inventor', number: '111/298' },
    'OGN-263': { market: 1.1, currency: 'USD', name: 'Teemo - Swift Scout', number: '263/298' },
  },
};
fs.writeFileSync(CATALOG_PATH, JSON.stringify(CATALOG));
fs.writeFileSync(PROMOS_PATH, JSON.stringify(PROMOS));
fs.writeFileSync(PRICES_PATH, JSON.stringify(PRICES));
process.env.RIFTBOUND_DATA_PATH = CATALOG_PATH;
process.env.RIFTBOUND_PRICES_PATH = PRICES_PATH;

const { riftboundCardsPlugin } = await import('../../lib/riftbound-cards.mjs');
const { riftboundPricesPlugin } = await import('../../lib/riftbound-prices.mjs');
const RB = await import('../../lib/riftbound-data.mjs');
const { adapterFor } = await import('../../lib/stock-games.mjs');
const LC = await import('../../lib/listing-copy.mjs');
const { enrichRow } = await import('../../lib/collectr-resolve.mjs');

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

describe('the merged catalog', () => {
  it('lists the promo sets beside Riot\'s, flagged, and a Riot set is never shadowed', async () => {
    const r = await call('/api/riftbound/sets');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.sets.map((s) => s.code), ['OPP', 'JDG', 'OGN', 'SFD']);
    assert.equal(r.json.sets.find((s) => s.code === 'OPP').promo, true);
    const ogn = r.json.sets.find((s) => s.code === 'OGN');
    assert.equal(ogn.name, 'Origins');
    assert.equal('promo' in ogn, false, 'a Riot set keeps exactly its old shape');
  });
  it('no Riot catalog is no catalog, whatever the promo file holds', () => {
    assert.deepEqual(RB.loadRiftboundData(path.join(TMP, 'absent', 'riftbound.json')), {});
  });
  it('a promo rune never replaces the Origins rune a reprint number resolves to', () => {
    const rune = RB.resolveRiftboundCard('SFD', 'R01');
    assert.equal(rune.name, 'Fury Rune');
    assert.equal(rune.image_fallback, 'https://riot/fury.png', 'the Origins card, not the OPP promo');
    assert.equal(RB.resolveRiftboundCard('OPP', 'R01c').number, 'R01c', 'and the promo rune is its own card');
  });
});

describe('GET /api/riftbound/set/opp/cards — a promo set in the runner envelope', () => {
  it('keys every card by product id and prices it under that key', async () => {
    const r = await call('/api/riftbound/set/opp/cards');
    assert.equal(r.status, 200);
    const byK = Object.fromEntries(r.json.cards.map((c) => [c.k, c]));
    assert.equal(byK.p689174.setCode, 'OPP');
    assert.equal(byK.p689174.number, '263/298');
    assert.equal(byK.p689174.name, 'Teemo, Swift Scout (Metal) (Prize Wall)', 'the tags are the price, and they stay in the name');
    assert.equal(byK.p689174.marketUsd, 4400);
    assert.equal(byK.p662886.marketUsd, 57.91, 'the plain promo is a different card at a different price');
    assert.equal(byK.p669259.marketUsd, null, 'no market is a real answer, not the Origins price');
  });
  it('uses the promo\'s own image or none — never the Riot art for the same number', async () => {
    const { cards } = (await call('/api/riftbound/set/opp/cards')).json;
    assert.equal(cards.find((c) => c.k === 'p669259').image, 'https://tcgplayer-cdn.tcgplayer.com/product/669259_in_1000x1000.jpg');
    assert.equal(cards.find((c) => c.k === 'p689174').image, '');
  });
  it('reads rarity and finish as the promo has them', async () => {
    const { cards } = (await call('/api/riftbound/set/opp/cards')).json;
    const metal = cards.find((c) => c.k === 'p689174');
    assert.equal(metal.rarity, 'Promo');
    assert.equal(metal.finish, 'Non-foil');
    assert.equal(cards.find((c) => c.k === 'p669259').finish, 'Non-foil', 'no agreed finish: the under-promising answer');
    assert.equal(cards.find((c) => c.k === 'p662886').finish, 'Foil');
  });
});

describe('GET /api/riftbound/cards/:set/:num — a shared promo number is a choice', () => {
  it('263 in OPP is three cards: 409, the three of them, and still no top-level name', async () => {
    const r = await call('/api/riftbound/cards/opp/263');
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'ambiguous');
    assert.equal(r.json.name, undefined);
    assert.deepEqual(r.json.candidates.map((c) => c.k).sort(), ['p662886', 'p669259', 'p689174']);
    assert.equal(r.json.candidates.find((c) => c.k === 'p689174').marketUsd, 4400);
  });
  it('the full printed number does not narrow it either — they all print 263/298', async () => {
    assert.equal((await call('/api/riftbound/cards/opp/' + encodeURIComponent('263/298'))).status, 409);
  });
  it('the product key names exactly one', async () => {
    const r = await call('/api/riftbound/cards/opp/p689174');
    assert.equal(r.status, 200);
    assert.equal(r.json.k, 'p689174');
    assert.equal(r.json.name, 'Teemo, Swift Scout (Metal) (Prize Wall)');
  });
  it('a number only one promo carries resolves straight to it, keyed by product id', async () => {
    const r = await call('/api/riftbound/cards/jdg/111');
    assert.equal(r.status, 200);
    assert.equal(r.json.k, 'p668439');
    assert.equal(r.json.marketUsd, 434.41);
  });
  it('a denominator must match in full: 109/166 is Illaoi, 109/298 is nothing here', async () => {
    assert.equal((await call('/api/riftbound/cards/opp/' + encodeURIComponent('109/166'))).json.k, 'p713484');
    assert.equal((await call('/api/riftbound/cards/opp/' + encodeURIComponent('109/298'))).status, 404);
  });
  it('the Origins card is untouched by all of it', async () => {
    const r = await call('/api/riftbound/cards/ogn/263');
    assert.equal(r.status, 200);
    assert.equal(r.json.k, '263');
    assert.equal(r.json.marketUsd, 1.1);
  });
});

describe('downstream — the stock adapter, the title, the Collectr import', () => {
  const rb = adapterFor('riftbound');
  const sets = rb.setsFrom({ sets: RB.loadRiftboundSets() });
  const rowFor = (set, k) => {
    const c = { ...RB.resolveRiftboundCard(set, k), setCode: set };
    return rb.invRowFrom(rb.normalizeCard(c, sets.find((s) => s.code === set)), { condition: 'Ungraded, Near Mint' });
  };
  it('the identity key is the promo key, in the stock tools as in the price index', () => {
    assert.equal(rowFor('OPP', 'p689174').identity_key, 'OPP-p689174');
  });
  it('the eBay title carries the tags and the number', () => {
    const t = LC.buildTitle('riftbound', LC.rowToFields(rowFor('OPP', 'p689174')));
    assert.match(t, /^Teemo, Swift Scout \(Metal\) \(Prize Wall\) 263\/298/);
    assert.match(t, /PROMO/);
    assert.ok(t.length <= 80);
  });
  it('the comps search says "promo" and drops the promo set name no seller writes', async () => {
    const { compsQueryFor } = await import('../../lib/stock-games.mjs');
    assert.equal(compsQueryFor('riftbound', { name: 'Heimerdinger, Inventor', set_name: 'Riftbound Judge Promotional Cards (JDG)' }, '111/298'),
      'Riftbound Heimerdinger, Inventor 111/298 promo');
    assert.equal(compsQueryFor('riftbound', { name: 'Teemo, Swift Scout (Metal) (Prize Wall)', set_name: 'Riftbound Organized Play Promotional Cards (OPP)' }, '263/298'),
      'Riftbound Teemo, Swift Scout Metal Prize Wall 263/298 promo');
    assert.equal(compsQueryFor('riftbound', { name: 'Lillia, Bashful Bloom', set_name: 'Secret Garden (SGN)' }, '001/003'),
      'Riftbound Lillia, Bashful Bloom 001/003');
    assert.equal(compsQueryFor('riftbound', { name: 'Darius, Trifarian', set_name: 'Origins (OGN)' }, '027/298'),
      'Riftbound Darius, Trifarian 027/298 Origins', 'a main-set query is exactly what it was');
  });
  it('the promo sets sit after Riot\'s in the picker', () => {
    assert.deepEqual(sets.map((s) => s.code), ['SFD', 'OGN', 'JDG', 'OPP']);
  });
  it('a Collectr row lands on the promo key, not on "JDG-111", which nothing else would recognise', async () => {
    const { row } = await enrichRow('', {
      game: 'riftbound', language: 'EN', name: 'Heimerdinger, Inventor', number: '111/298',
      set_name: 'Riftbound Judge Promotional Cards', lookup_num: '111',
    }, { setIndex: RB.loadRiftboundSets() });
    assert.equal(row.identity_key, 'JDG-p668439');
  });
});
