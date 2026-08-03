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
