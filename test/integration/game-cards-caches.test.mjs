// test/integration/game-cards-caches.test.mjs — the SWU, MTG and One Piece set caches.
//
// Three more builders that went to their upstream on every card looked up. Each now reads a stored
// set, so the first card in a set pays for the set and the rest are free. The mechanics are shared
// (lib/set-cache.mjs, covered by the Pokémon and Lorcana suites); what is worth testing here is the
// part that is NOT shared — each API's own shape, and the way each one is asked for a single card.
//
// The One Piece block is the one that matters most. A card's base print and its parallel share a
// card_set_id and differ by 100× in price, so the per-card endpoint returning BOTH, in order, is a
// correctness property (GR5), not a nicety.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIRS = {};
for (const [envVar, tag] of [['SWU_CARDS_CACHE_DIR', 'swu'], ['MTG_CARDS_CACHE_DIR', 'mtg'], ['ONEPIECE_CARDS_CACHE_DIR', 'op']]) {
  DIRS[tag] = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-' + tag + '-cache-'));
  process.env[envVar] = DIRS[tag];
}
const swu = await import('../../lib/swu-cards-cache.mjs');
const mtg = await import('../../lib/mtg-cards-cache.mjs');
const op = await import('../../lib/onepiece-cards-cache.mjs');

const realFetch = globalThis.fetch;
const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const dead = { ok: false, status: 500, text: async () => 'nope' };

// One middleware harness for all three: each mounts a single route and answers or calls next().
function mount(plugin, at) {
  const MW = {};
  plugin.configureServer({ middlewares: { use: (p, h) => { MW[p] = h; } } });
  return (url, headers = {}) => new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { chunks.push(b); resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(chunks.join('') || 'null') }); },
    };
    MW[at]({ method: 'GET', url, headers }, res, () => resolve({ status: 'next', headers: {}, json: null }));
  });
}
const callSwu = mount(swu.swuCardsPlugin(), '/api/swu/cards');
const callMtg = mount(mtg.mtgCardsPlugin(), '/api/mtg/cards');
// The same plugin mounts a second route: the whole set, which is what the batch runner loads.
const callMtgSet = mount(mtg.mtgCardsPlugin(), '/api/mtg/set');
const callOp = mount(op.onepieceCardsPlugin(), '/api/op/sets/card');
// What the price tracker's collector sends.
const callSwuFresh = (url) => callSwu(url, { 'x-tcg-cache-bypass': '1' });

after(() => {
  globalThis.fetch = realFetch;
  for (const d of Object.values(DIRS)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// ---------------------------------------------------------------------------
describe('SWU-DB', () => {
  const SET = 'sor';
  const card = (n) => ({ Set: 'SOR', Number: String(n).padStart(3, '0'), Name: 'Card ' + n, Type: 'Unit', Rarity: 'C' });
  const stub = (total, { fail = false, short = false } = {}) => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (fail) return dead;
      const cards = Array.from({ length: short ? Math.max(1, total - 2) : total }, (_, i) => card(i + 1));
      return json({ total_cards: total, data: cards });
    };
    return calls;
  };
  beforeEach(() => { try { fs.unlinkSync(path.join(DIRS.swu, SET + '.json')); } catch {} });

  it('stores the set once and answers cards from it', async () => {
    const calls = stub(5);
    const a = await callSwu('/' + SET + '/3');
    assert.equal(a.status, 200);
    assert.equal(a.json.Name, 'Card 3');
    const b = await callSwu('/' + SET + '/4');
    assert.equal(b.json.Name, 'Card 4');
    assert.equal(calls.length, 1, 'the first card paid for the set');
  });

  it('matches a typed number against a padded one', async () => {
    stub(5);
    assert.equal((await callSwu('/' + SET + '/3')).json.Number, '003', "typing 3 finds '003'");
    assert.equal((await callSwu('/' + SET + '/003')).json.Number, '003');
  });

  it('refuses to store a set short of total_cards', () => {
    assert.equal(swu.isCompleteSet([1, 2], 946), false, 'half a set, kept forever, is the bad outcome');
    assert.equal(swu.isCompleteSet([1, 2], 2), true);
    assert.equal(swu.isCompleteSet([], 0), false);
  });

  it('a truncated fetch never lands on disk', async () => {
    stub(5, { short: true });
    await callSwu('/' + SET + '/1');
    assert.equal(swu.readSetCache(SET), null, 'nothing stored, so the next call tries again');
  });

  it('falls through when SWU-DB is down and nothing is stored', async () => {
    stub(0, { fail: true });
    assert.equal((await callSwu('/' + SET + '/1')).status, 'next');
  });

  it('leaves the whole-set path to the proxy', async () => {
    assert.equal((await callSwu('/' + SET)).status, 'next');
  });

  // The card list is immutable; the prices inside it are not, and the builder shows them. So a copy
  // is always served immediately, however old — and if it predates the window, a refresh runs behind
  // the answer so the NEXT lookup carries a current market figure.
  it('a day-old copy still answers instantly, and refreshes itself behind the answer', async () => {
    stub(3);
    await callSwu('/' + SET + '/1');
    const old = swu.readSetCache(SET);
    swu.writeSetCache(SET, new Date(Date.now() - 3 * 86400000).toISOString(), old.cards);   // age it
    const calls = stub(3);
    const r = await callSwu('/' + SET + '/2');
    assert.equal(r.status, 200, 'the answer never waits on the refresh');
    assert.equal(r.json.Name, 'Card 2');
    await new Promise((res) => setTimeout(res, 50));                    // let the background work run
    assert.equal(calls.length, 1, 'and the copy was refreshed for next time');
    assert.ok(Date.now() - Date.parse(swu.readSetCache(SET).at) < 60000, 'the stored copy is current again');
  });

  it('a fresh copy is left alone', async () => {
    stub(3);
    await callSwu('/' + SET + '/1');
    const calls = stub(3);
    await callSwu('/' + SET + '/2');
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(calls.length, 0, 'no background traffic for a copy taken minutes ago');
  });

  // The ↻ beside Look up in every builder. A card cannot be refreshed on its own — the set is the
  // unit this stores — so the button re-fetches the set behind the card and answers from that.
  it('?refresh=1 re-fetches the set and answers from the new copy', async () => {
    stub(3);
    await callSwu('/' + SET + '/1');
    const calls = stub(5);                                   // the set gained two cards
    const r = await callSwu('/' + SET + '/5?refresh=1');
    assert.equal(calls.length, 1, 'the button actually went and looked');
    assert.equal(r.status, 200);
    assert.equal(r.json.Name, 'Card 5', 'a card that did not exist in the stored copy');
    assert.equal(swu.readSetCache(SET).count, 5, 'and the new copy replaced the old one');
  });

  it('a normal lookup after a refresh is served from the new copy, not refetched', async () => {
    stub(3);
    await callSwu('/' + SET + '/1?refresh=1');
    const calls = stub(3);
    assert.equal((await callSwu('/' + SET + '/2')).headers['x-tcg-cache'], 'disk');
    assert.equal(calls.length, 0);
  });

  // The price tracker records history. A snapshot taken from a stored copy would repeat the last
  // one until the copy changed, so the collector sends the bypass header and every cache steps
  // aside — see lib/set-cache.mjs BYPASS_HEADER and lib/collector.mjs.
  it('steps aside for the price tracker, even with the set on disk', async () => {
    stub(3);
    await callSwu('/' + SET + '/1');
    assert.equal((await callSwu('/' + SET + '/2')).headers['x-tcg-cache'], 'disk', 'cached for everyone else');
    assert.equal((await callSwuFresh('/' + SET + '/2')).status, 'next', 'but the tracker goes to the source');
  });
});

// ---------------------------------------------------------------------------
describe('Scryfall', () => {
  const SET = 'otj';
  const card = (n) => ({ object: 'card', id: 'id' + n, name: 'Card ' + n, collector_number: String(n), set: SET });
  // Scryfall pages with has_more + next_page rather than a page number.
  const stub = (total, pageSize = 175, { fail = false } = {}) => {
    const calls = [];
    globalThis.fetch = async (url) => {
      const u = String(url); calls.push(u);
      if (fail) return dead;
      const from = Number(new URL(u).searchParams.get('page') || 1);
      const start = (from - 1) * pageSize;
      const data = [];
      for (let i = start; i < Math.min(start + pageSize, total); i++) data.push(card(i + 1));
      const has_more = start + pageSize < total;
      return json({ total_cards: total, has_more, next_page: has_more ? 'https://api.scryfall.com/cards/search?page=' + (from + 1) : null, data });
    };
    return calls;
  };
  beforeEach(() => { try { fs.unlinkSync(path.join(DIRS.mtg, SET + '.json')); } catch {} });

  it('follows next_page until the set is whole', async () => {
    const calls = stub(374);                       // a real Outlaws of Thunder Junction count
    const r = await callMtg('/' + SET + '/300');
    assert.equal(r.status, 200);
    assert.equal(r.json.collector_number, '300', 'a card only the third page could have provided');
    assert.equal(calls.length, 3, '175 + 175 + 24');
    assert.equal(mtg.readSetCache(SET).count, 374);
  });

  it('the next card in the set costs nothing', async () => {
    stub(200);
    await callMtg('/' + SET + '/1');
    const calls = stub(200);
    assert.equal((await callMtg('/' + SET + '/2')).json.collector_number, '2');
    assert.equal(calls.length, 0);
  });

  it('asks for printings, not one card per name', async () => {
    const calls = stub(3);
    await callMtg('/' + SET + '/1');
    assert.match(calls[0], /unique=prints/, 'collapsing printings would lose the number being asked for');
    assert.match(calls[0], /set%3Aotj/);
  });

  it('falls through for a number the set does not have', async () => {
    stub(3);
    await callMtg('/' + SET + '/1');
    assert.equal((await callMtg('/' + SET + '/999')).status, 'next');
  });

  it('leaves /cards/search and other Scryfall paths to the proxy', async () => {
    for (const url of ['/search', '/', '/otj/1/extra']) assert.equal((await callMtg(url)).status, 'next', url);
  });
});

// ---------------------------------------------------------------------------
// GET /api/mtg/set/:setId/cards — the batch runner's one structural move, for Magic. It answers in
// the SAME envelope lib/pkm-cards-cache.mjs uses, because stock-runner.html reads both through one
// code path and only the URL differs between the games.
describe('Scryfall — the whole set (the batch runner index)', () => {
  const SET = 'hob';
  const file = path.join(DIRS.mtg, SET + '.json');
  // A real-ish printing: two finishes, a frame effect, and the fat fields the trim must drop.
  const print = (n) => ({
    id: 'uuid-' + n, oracle_id: 'o-' + n, name: 'Card ' + n, collector_number: String(n),
    rarity: n === 1 ? 'mythic' : 'common', artist: 'Someone', lang: 'en', released_at: '2023-06-23',
    type_line: 'Creature — Dragon', colors: ['R'], finishes: ['nonfoil', 'foil'], promo_types: [],
    promo: false, frame_effects: [], border_color: 'black', full_art: false,
    set: SET, set_name: 'The Hobbit',
    image_uris: { small: 's' + n, normal: 'n' + n, large: 'l' + n, png: 'p' + n, art_crop: 'a' + n },
    prices: { usd: '1.00', usd_foil: '5.00', usd_etched: null, eur: '0.90', tix: '0.02' },
    // The bulk a raw Scryfall card carries and nothing here reads.
    oracle_text: 'x'.repeat(400), legalities: { standard: 'legal', modern: 'legal' },
    rulings_uri: 'https://…', prints_search_uri: 'https://…', related_uris: { gatherer: 'https://…' },
  });
  const stub = (total, { fail = false, short = false } = {}) => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (fail) return dead;
      const pageSize = 175;
      const from = Number((String(url).match(/[?&]page=(\d+)/) || [])[1] || 1);
      const start = (from - 1) * pageSize;
      const count = short ? Math.max(1, total - 2) : total;
      const data = Array.from({ length: Math.max(0, Math.min(pageSize, count - start)) }, (_, i) => print(start + i + 1));
      const has_more = start + pageSize < count;
      return json({ total_cards: total, has_more, next_page: has_more ? 'https://api.scryfall.com/cards/search?page=' + (from + 1) : null, data });
    };
    return calls;
  };
  beforeEach(() => { try { fs.unlinkSync(file); } catch {} });

  it('fetches the set once and answers from disk, then from memory', async () => {
    const calls = stub(200);
    const cold = await callMtgSet('/' + SET + '/cards');
    assert.equal(cold.status, 200);
    assert.equal(cold.json.count, 200);
    assert.equal(cold.json.setId, SET);
    assert.equal(cold.headers['x-tcg-cache'], 'upstream');
    assert.equal(calls.length, 2, '175 + 25');

    const calls2 = stub(200);
    const warm = await callMtgSet('/' + SET + '/cards');
    assert.equal(warm.json.count, 200);
    assert.equal(warm.headers['x-tcg-cache'], 'memory');
    assert.equal(calls2.length, 0, 'a released set does not change, so nothing goes upstream');
  });

  it('answers in the same envelope the Pokémon route does', async () => {
    stub(3);
    const r = await callMtgSet('/' + SET + '/cards');
    for (const k of ['setId', 'count', 'cachedAt', 'source', 'cards']) {
      assert.ok(k in r.json, 'the envelope is missing ' + k + ' — the runner parses one shape');
    }
    assert.ok(Array.isArray(r.json.cards));
  });

  it('trims the card to what the pickers read, and drops the rest', async () => {
    stub(1);
    const c = (await callMtgSet('/' + SET + '/cards')).json.cards[0];
    // Kept: identity, the printing matrix, the treatment axis, the money.
    for (const k of ['name', 'collector_number', 'rarity', 'lang', 'artist', 'released_at', 'type_line',
      'colors', 'finishes', 'promo_types', 'promo', 'frame_effects', 'border_color', 'full_art',
      'set', 'set_name', 'image_uris', 'prices']) {
      assert.ok(k in c, 'trimCard dropped ' + k + ', which the adapter reads');
    }
    // Dropped: a raw printing is 4-8 KB, and a 531-card set has to fit a shared ~5 MB localStorage
    // quota alongside the set list.
    for (const k of ['oracle_text', 'legalities', 'rulings_uri', 'prints_search_uri', 'related_uris', 'oracle_id']) {
      assert.ok(!(k in c), 'trimCard kept ' + k + ', which nothing reads');
    }
    assert.deepEqual(c.prices, { usd: '1.00', usd_foil: '5.00', usd_etched: null }, 'eur/tix are not AU comps');
    assert.deepEqual(Object.keys(c.image_uris).sort(), ['large', 'normal', 'small']);
  });

  // NEO has 41 prints with no top-level image_uris. Without the face fallback that is 8% of the set
  // rendering thumbnail-less and reaching publish with no picture.
  it('takes a double-faced card\'s art off the front face', () => {
    const dfc = mtg.trimCard({
      name: 'Two Sides', collector_number: '5', set: SET,
      card_faces: [{ colors: ['U'], image_uris: { small: 'fs', normal: 'fn', large: 'fl' } }, { image_uris: { normal: 'bn' } }],
    });
    assert.equal(dfc.image_uris.normal, 'fn');
    assert.deepEqual(dfc.colors, ['U'], 'the colours are on the face too');
  });

  it('?refresh=1 goes back upstream and rewrites the copy', async () => {
    stub(3);
    await callMtgSet('/' + SET + '/cards');
    const calls = stub(4);
    const r = await callMtgSet('/' + SET + '/cards?refresh=1');
    assert.ok(calls.length >= 1, 'the button has to actually reach Scryfall');
    assert.equal(r.json.count, 4);
    assert.equal(mtg.readSetCache(SET).count, 4);
  });

  it('serves the stored copy when Scryfall is down, and says so', async () => {
    stub(3);
    await callMtgSet('/' + SET + '/cards');
    stub(0, { fail: true });
    const r = await callMtgSet('/' + SET + '/cards?refresh=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 3);
    assert.equal(r.json.stale, true);
    assert.equal(r.headers['x-tcg-cache'], 'stale');
  });

  it('502s rather than pretending, when it is cold AND Scryfall is down', async () => {
    stub(0, { fail: true });
    const r = await callMtgSet('/' + SET + '/cards');
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'upstream_unreachable');
    assert.equal(r.headers['x-tcg-cache'], 'none');
  });

  // A partial set written into a cache that never expires is missing its high numbers for good.
  it('serves a short walk but refuses to store it', async () => {
    stub(10, { short: true });
    const r = await callMtgSet('/' + SET + '/cards');
    assert.equal(r.json.partial, true);
    assert.equal(r.json.count, 8);
    assert.equal(mtg.hasSetCache(SET), false, 'a half-walked set must never reach disk');
  });

  it('rejects a set id that would escape the cache directory', async () => {
    const r = await callMtgSet('/..%2F..%2Fetc/cards');
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'bad_set_id');
  });

  // connect only enters a mount when the next character is '/' or '.', so /api/mtg/sets never
  // reaches the /api/mtg/set mount — and mtgSetsPlugin is registered ahead of it besides. This pins
  // the second line of defence: anything that is not /:setId/cards falls through untouched.
  it('leaves every other path to the next middleware', async () => {
    for (const url of ['/sets', '/' + SET, '/' + SET + '/cards/extra', '/']) {
      assert.equal((await callMtgSet(url)).status, 'next', url);
    }
  });
});

// ---------------------------------------------------------------------------
describe('optcgapi (One Piece)', () => {
  const SET = 'OP-01';
  // The base print and its parallel: same card_set_id, different image, 100× the price.
  const base = { card_set_id: 'OP01-001', card_name: 'Roronoa Zoro (001)', set_id: SET, rarity: 'L', card_image: 'OP01-001.jpg', market_price: 5.73 };
  const parallel = { ...base, card_image: 'OP01-001_p1.jpg', market_price: 568.01 };
  const other = { card_set_id: 'OP01-002', card_name: 'Trafalgar Law', set_id: SET, rarity: 'L', card_image: 'OP01-002.jpg', market_price: 2 };
  const stub = ({ fail = false, empty = false } = {}) => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (fail) return dead;
      return json(empty ? [] : [base, parallel, other]);
    };
    return calls;
  };
  beforeEach(() => { try { fs.unlinkSync(path.join(DIRS.op, SET.toLowerCase() + '.json')); } catch {} });

  it('derives the set id from a card code', () => {
    assert.equal(op.setIdFromCode('OP01-001'), 'OP-01');
    assert.equal(op.setIdFromCode('ST01-002'), 'ST-01');
    assert.equal(op.setIdFromCode('PRB01-005'), 'PRB-01');
    assert.equal(op.setIdFromCode('nonsense'), null, 'unresolvable → the proxy has its own go');
  });

  it('returns BOTH art variants, in order — the base and the parallel', async () => {
    const calls = stub();
    const r = await callOp('/OP01-001/');
    assert.equal(r.status, 200);
    assert.equal(Array.isArray(r.json), true, 'the builder maps this array into its variant dropdown');
    assert.equal(r.json.length, 2);
    assert.deepEqual(r.json.map((c) => c.card_image), ['OP01-001.jpg', 'OP01-001_p1.jpg'], 'order decides which print is default');
    assert.deepEqual(r.json.map((c) => c.market_price), [5.73, 568.01], 'and the parallel is worth 100× the base');
    assert.equal(calls.length, 1);
  });

  it('the next card in the set costs nothing upstream', async () => {
    stub();
    await callOp('/OP01-001/');
    const calls = stub();
    const r = await callOp('/OP01-002/');
    assert.equal(r.json[0].card_name, 'Trafalgar Law');
    assert.equal(calls.length, 0);
  });

  it('works with or without the trailing slash the builder sends', async () => {
    stub();
    assert.equal((await callOp('/OP01-001')).json.length, 2);
  });

  it('an empty answer is never stored as an empty set', async () => {
    stub({ empty: true });
    assert.equal((await callOp('/OP01-001/')).status, 'next');
    assert.equal(op.readSetCache(SET), null, 'storing it would blank the set forever');
  });

  it('asks a set it cannot resolve only once per process', async () => {
    stub({ fail: true });
    await callOp('/ZZ09-001/');                    // this one goes and fails (with its retries)
    const calls = stub({ fail: true });            // fresh counter
    await callOp('/ZZ09-002/');
    assert.equal(calls.length, 0, 'an unusual set costs one failed lookup, not one per card');
  });

  it('falls through for a code the set does not contain', async () => {
    stub();
    await callOp('/OP01-001/');
    assert.equal((await callOp('/OP01-999/')).status, 'next');
  });
});
