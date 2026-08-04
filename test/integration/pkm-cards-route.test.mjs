// test/integration/pkm-cards-route.test.mjs — /api/pkm/set/:id/cards, driven end to end.
//
// The unit suite covers the decisions; this drives the actual middleware with a stubbed
// pokemontcg.io, because the parts worth proving are the ones that only exist when the pieces are
// wired together: that a cold set is PAGED (a set over 250 cards is several requests), that what
// comes back is written to disk, that the second caller pays nothing, that two callers racing a cold
// set cause ONE upstream fetch, and that ?refresh=1 with a dead upstream keeps the good copy.
//
// It matters more than usual here because this cache never expires. Anything it learns wrongly, it
// keeps.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// A throwaway cache folder, set before the module is imported. Stubbed cards must never reach the
// real one: it does not expire, so anything written there stays written.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-cards-route-'));
process.env.PKM_CARDS_CACHE_DIR = DIR;
const { pkmCardsPlugin, readSetCache } = await import('../../lib/pkm-cards-cache.mjs');
const IDS = ['zzzroute1', 'zzzroute2', 'zzzroute3', 'zzzroute4', 'zzzroute5'];
const realFetch = globalThis.fetch;

// The middlewares, pulled out of the plugin the same way Vite would install them — keyed by mount
// path, because the plugin registers two: the set list and the single-card stand-in.
const MW = {};
pkmCardsPlugin({ POKEMONTCG_API_KEY: 'test-key' }).configureServer({ middlewares: { use: (p, h) => { MW[p] = h; } } });

// A request through a mounted middleware: connect strips the mount path, so the url is what is left.
function through(mount, url) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) { chunks.push(body); resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(chunks.join('') || 'null') }); },
    };
    MW[mount]({ method: 'GET', url }, res, () => resolve({ status: 'next', headers: {}, json: null }));
  });
}
const call = (url) => through('/api/pkm/set', url);
const callCard = (url) => through('/api/pkm/cards', url);

const card = (setId, n) => ({
  id: setId + '-' + n, name: 'Card ' + n, number: String(n), rarity: 'Common', hp: 60,
  images: { small: 's.png', large: 'l.png' },
  set: { id: setId, name: 'Test Set', series: 'SV', ptcgoCode: 'ZZZ', releaseDate: '2023/08/11', printedTotal: 197 },
  tcgplayer: { prices: { holofoil: { low: 1, mid: 2, high: 9, market: 3, directLow: 4 } } },
  attacks: [{ name: 'Splash', text: 'bulk' }],
});

// A stub upstream that serves `total` cards, 250 to a page, and counts the requests it took.
function stubUpstream(setId, total, { fail = false, keyed = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    keyed.push((opts && opts.headers && opts.headers['X-Api-Key']) || null);
    if (fail) return { ok: false, status: 500, text: async () => 'upstream is unwell' };
    const page = Number(new URL(String(url)).searchParams.get('page') || 1);
    const start = (page - 1) * 250;
    const data = [];
    for (let i = start; i < Math.min(start + 250, total); i++) data.push(card(setId, i + 1));
    return { ok: true, status: 200, text: async () => JSON.stringify({ data, totalCount: total }) };
  };
  return calls;
}

const clean = () => { for (const id of IDS) { try { fs.unlinkSync(path.join(DIR, id + '.json')); } catch {} } };
before(clean);
after(() => { globalThis.fetch = realFetch; try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
beforeEach(clean);

describe('GET /api/pkm/set/:id/cards', () => {
  it('cold: pages the whole set, stores it, and serves it trimmed', async () => {
    const calls = stubUpstream('zzzroute1', 279);                 // Paldea Evolved's size: two pages
    const r = await call('/zzzroute1/cards');
    assert.equal(r.status, 200);
    assert.equal(r.json.source, 'upstream');
    assert.equal(r.json.count, 279, 'one request would have silently lost the last 29');
    assert.equal(calls.length, 2, 'paged');
    assert.equal(r.headers['x-tcg-cache'], 'upstream');
    assert.equal('attacks' in r.json.cards[0], false, 'trimmed on the way out');
    const onDisk = readSetCache('zzzroute1');
    assert.equal(onDisk.count, 279);
    assert.ok(onDisk.cards[0].attacks, 'raw on the way in');
  });

  it('warm: the second caller costs nothing upstream', async () => {
    stubUpstream('zzzroute2', 10);
    await call('/zzzroute2/cards');
    const calls = stubUpstream('zzzroute2', 10);                  // fresh counter
    const r = await call('/zzzroute2/cards');
    assert.equal(calls.length, 0, 'this is the whole point');
    assert.equal(r.json.count, 10);
    assert.ok(['disk', 'memory'].includes(r.headers['x-tcg-cache']));
  });

  it('two tabs opening the same cold set fetch it once', async () => {
    const calls = stubUpstream('zzzroute3', 10);
    const [a, b] = await Promise.all([call('/zzzroute3/cards'), call('/zzzroute3/cards')]);
    assert.equal(calls.length, 1, 'one fetch, both answered');
    assert.equal(a.json.count, 10);
    assert.equal(b.json.count, 10);
  });

  it('?refresh=1 goes upstream again and rewrites the copy', async () => {
    stubUpstream('zzzroute4', 10);
    await call('/zzzroute4/cards');
    const calls = stubUpstream('zzzroute4', 12);                  // the set gained two cards
    const r = await call('/zzzroute4/cards?refresh=1');
    assert.ok(calls.length >= 1, 'refresh must actually go and look');
    assert.equal(r.json.count, 12);
    assert.equal(readSetCache('zzzroute4').count, 12);
  });

  it('?refresh=1 with a dead upstream keeps the good copy and says it is stale', async () => {
    stubUpstream('zzzroute5', 10);
    await call('/zzzroute5/cards');
    stubUpstream('zzzroute5', 0, { fail: true });
    const r = await call('/zzzroute5/cards?refresh=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.stale, true);
    assert.equal(r.json.count, 10, 'a failed refresh must never cost you the set');
    assert.equal(readSetCache('zzzroute5').count, 10);
  });

  it('cold with a dead upstream is a 502 that says which side broke', async () => {
    stubUpstream('zzzroute1', 0, { fail: true });
    const r = await call('/zzzroute1/cards');
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'upstream_unreachable');
  });

  it('sends the API key when there is one', async () => {
    const keyed = [];
    stubUpstream('zzzroute2', 10, { keyed });
    await call('/zzzroute2/cards');
    assert.deepEqual(keyed, ['test-key'], 'keyless works, but the key raises the rate limit');
  });

  // The two tests above depend on this: they reuse a set id that an earlier test left warm in
  // memory, and only pass because deleting the file drops the copy of it. That is the behaviour an
  // operator expects — clear the folder, get fresh data, no restart — so it is worth stating.
  it('deleting a cache file forces that set to be fetched again, without a restart', async () => {
    stubUpstream('zzzroute3', 10);
    await call('/zzzroute3/cards');
    assert.equal((await call('/zzzroute3/cards')).headers['x-tcg-cache'], 'memory', 'warm to begin with');
    fs.unlinkSync(path.join(DIR, 'zzzroute3.json'));
    const calls = stubUpstream('zzzroute3', 11);
    const r = await call('/zzzroute3/cards');
    assert.equal(calls.length, 1, 'the file is gone, so the memory copy must not answer for it');
    assert.equal(r.json.count, 11);
  });

  it('a set id that could escape the cache directory is refused', async () => {
    const r = await call('/..%2F..%2Fetc/cards');
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'bad_set_id');
  });

  it('anything that is not this exact route falls through to the proxy', async () => {
    for (const url of ['/zzzroute1/cards/extra', '/zzzroute1', '/']) {
      assert.equal((await call(url)).status, 'next', url + ' should not be claimed');
    }
  });
});

// Every single-card lookup in the suite goes through /api/pkm/cards/:id first (extras.js
// pkmLookupCard, shared by the builder, the uploader and the grader). Listing thirty cards out of
// one set was thirty round trips to pokemontcg.io for cards already in a file on this machine.
describe('GET /api/pkm/cards/:id — answered from the set we already hold', () => {
  it('serves a card out of the cached set, shaped like pokemontcg.io', async () => {
    stubUpstream('zzzroute1', 10);
    await call('/zzzroute1/cards');                       // the set is now on disk
    const calls = stubUpstream('zzzroute1', 10);          // fresh counter
    const r = await callCard('/zzzroute1-7');
    assert.equal(calls.length, 0, 'no upstream call for a card we already have');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-tcg-cache'], 'disk');
    assert.equal(r.json.data.id, 'zzzroute1-7', 'the callers read j.data');
    assert.ok(r.json.data.attacks, 'RAW, because this stands in for the upstream response');
  });

  it('falls through to the proxy for a set we do not hold', async () => {
    assert.equal((await callCard('/zzznothing-1')).status, 'next');
  });

  // The ↻ button in the Pokémon builder, the uploader and the grader. A card cannot be refreshed on
  // its own — the set is the unit stored — so the whole set is re-fetched behind the card.
  it('?refresh=1 re-fetches the set behind the card and says so', async () => {
    stubUpstream('zzzroute4', 5);
    await call('/zzzroute4/cards');
    const calls = stubUpstream('zzzroute4', 7);            // the set gained two
    const r = await callCard('/zzzroute4-7?refresh=1');
    assert.ok(calls.length >= 1, 'the button actually went and looked');
    assert.equal(r.status, 200);
    assert.equal(r.json.data.id, 'zzzroute4-7', 'a card the stored copy did not have');
    assert.equal(r.headers['x-tcg-cache'], 'upstream', 'and it reports where the answer came from');
  });

  it('a refresh that fails says stale rather than pretending it worked', async () => {
    stubUpstream('zzzroute5', 4);
    await call('/zzzroute5/cards');
    stubUpstream('zzzroute5', 0, { fail: true });
    const r = await callCard('/zzzroute5-2?refresh=1');
    assert.equal(r.status, 200, 'the old copy still answers');
    assert.equal(r.headers['x-tcg-cache'], 'stale', 'the one outcome the person pressing it must see');
  });

  it('falls through for a card that is not in the set we hold', async () => {
    stubUpstream('zzzroute2', 5);
    await call('/zzzroute2/cards');
    assert.equal((await callCard('/zzzroute2-999')).status, 'next', 'never invent a 404 of our own');
  });

  it('leaves search queries and anything deeper to the proxy', async () => {
    for (const url of ['/', '/zzzroute1-1/extra']) {
      assert.equal((await callCard(url)).status, 'next', url);
    }
  });

  it('a card id that could escape the cache directory falls through', async () => {
    assert.equal((await callCard('/..%2F..%2Fetc-1')).status, 'next');
  });
});
