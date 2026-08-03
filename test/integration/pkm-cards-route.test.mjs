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
import path from 'node:path';
import { pkmCardsPlugin, readSetCache } from '../../lib/pkm-cards-cache.mjs';

const DIR = path.resolve('data', 'pkm-cards');
const IDS = ['zzzroute1', 'zzzroute2', 'zzzroute3', 'zzzroute4', 'zzzroute5'];
const realFetch = globalThis.fetch;

// The middleware, pulled out of the plugin the same way Vite would install it.
function handlerOf() {
  let fn = null;
  pkmCardsPlugin({ POKEMONTCG_API_KEY: 'test-key' }).configureServer({ middlewares: { use: (_p, h) => { fn = h; } } });
  return fn;
}
const handler = handlerOf();

// A request through the mounted middleware: connect strips the mount path, so url is /:id/cards.
function call(url) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) { chunks.push(body); resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(chunks.join('') || 'null') }); },
    };
    handler({ method: 'GET', url }, res, () => resolve({ status: 'next', headers: {}, json: null }));
  });
}

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
after(() => { globalThis.fetch = realFetch; clean(); });
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
