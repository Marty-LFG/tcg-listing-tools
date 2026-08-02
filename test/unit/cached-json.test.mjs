// test/unit/cached-json.test.mjs — TCG.cachedJSON, the ETag-keyed cache for the baked catalogs.
//
// data/riftbound.json is ~300 KB and the builder used to re-fetch AND re-parse it on every page
// load, with the set pills blocked behind the round-trip. This helper hands the last copy back
// synchronously and only re-parses when the ETag says a bake actually changed the file.
//
// extras.js is a classic script (no exports), so load it into a vm with a minimal browser shim —
// the same approach test/invariants and scripts/check-listing-copy.mjs use for the builders.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read } from '../helpers/extract-inline.mjs';

function makeStorage(throwOnWrite) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (throwOnWrite) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } map.set(k, String(v)); },
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}
const res = (status, body, etag) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (h) => (h.toLowerCase() === 'etag' ? etag || null : null) },
  json: async () => body,
});

// Boot extras.js in a vm and hand back { TCG, calls, setResponse, storage }.
function boot({ throwOnWrite = false } = {}) {
  const calls = [];
  let next = res(200, { hello: 'world' }, 'W/"1"');
  let parses = 0;
  const storage = makeStorage(throwOnWrite);
  const sandbox = {
    window: {}, document: { getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }), head: { appendChild() {} } },
    localStorage: storage,
    fetch: async (url, opts) => { calls.push({ url, opts }); const r = next; return { ...r, json: async () => { parses++; return r.json(); } }; },
    setTimeout, clearTimeout, console, Date, Math, JSON,
  };
  sandbox.window.localStorage = storage;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('extras.js'), ctx);
  return {
    TCG: sandbox.window.TCG, calls, storage,
    parses: () => parses,
    setResponse: (r) => { next = r; },
  };
}

describe('TCG.cachedJSON', () => {
  let env;
  beforeEach(() => { env = boot(); });

  it('cold cache: nothing to return synchronously, fetches without a conditional header', async () => {
    const got = env.TCG.cachedJSON('/data/x.json', 'k');
    assert.equal(got.cached, null);
    assert.deepEqual(await got.fresh, { hello: 'world' });
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0].opts.headers, undefined, 'no ETag yet, so no If-None-Match');
    assert.equal(env.calls[0].opts.cache, 'no-store', "the browser's own cache must not answer this");
  });

  it('warm cache: returns the parsed data SYNCHRONOUSLY, before any network', async () => {
    await env.TCG.cachedJSON('/data/x.json', 'k').fresh;
    const got = env.TCG.cachedJSON('/data/x.json', 'k');
    assert.deepEqual(got.cached, { hello: 'world' }, 'available with zero awaits — this is what unblocks paint');
    await got.fresh;
  });

  it('304: no re-parse, no re-write, no callback — the file did not change', async () => {
    await env.TCG.cachedJSON('/data/x.json', 'k').fresh;
    const parsesAfterFirst = env.parses();
    env.setResponse(res(304, null, 'W/"1"'));
    let fired = 0;
    const got = env.TCG.cachedJSON('/data/x.json', 'k', () => { fired++; });
    assert.deepEqual(got.cached, { hello: 'world' });
    assert.equal(await got.fresh, null);
    assert.equal(env.calls[1].opts.headers['If-None-Match'], 'W/"1"', 'must send the stored ETag');
    assert.equal(env.parses(), parsesAfterFirst, 'a 304 must not cost a 300 KB JSON.parse');
    assert.equal(fired, 0, 'nothing changed, so nothing to rebuild');
  });

  it('200 with a new ETag: swaps the data, re-stores it, and fires the callback', async () => {
    await env.TCG.cachedJSON('/data/x.json', 'k').fresh;
    env.setResponse(res(200, { hello: 'rebaked' }, 'W/"2"'));
    let seen = null;
    const got = env.TCG.cachedJSON('/data/x.json', 'k', (d) => { seen = d; });
    assert.deepEqual(got.cached, { hello: 'world' }, 'paints the old copy first');
    assert.deepEqual(await got.fresh, { hello: 'rebaked' });
    assert.deepEqual(seen, { hello: 'rebaked' }, 'a re-bake must reach the UI, never serve stale forever');
    assert.equal(JSON.parse(env.storage.getItem('k')).etag, 'W/"2"');
  });

  it('a failed fetch rejects but leaves the cached copy usable', async () => {
    await env.TCG.cachedJSON('/data/x.json', 'k').fresh;
    env.setResponse(res(500, null, null));
    const got = env.TCG.cachedJSON('/data/x.json', 'k');
    assert.deepEqual(got.cached, { hello: 'world' });
    await assert.rejects(got.fresh, /http 500/);
    assert.ok(env.storage.getItem('k'), 'the good copy survives a bad response');
  });

  it('a full localStorage degrades to fetch-every-time, never to a broken page (GR7)', async () => {
    const e = boot({ throwOnWrite: true });
    const got = e.TCG.cachedJSON('/data/x.json', 'k');
    assert.equal(got.cached, null);
    assert.deepEqual(await got.fresh, { hello: 'world' }, 'the data still arrives');
    assert.equal(e.TCG.cachedJSON('/data/x.json', 'k').cached, null, 'just never cached');
  });

  it('corrupt cached JSON is ignored rather than thrown', async () => {
    env.storage.setItem('k', '{not json');
    const got = env.TCG.cachedJSON('/data/x.json', 'k');
    assert.equal(got.cached, null);
    assert.deepEqual(await got.fresh, { hello: 'world' });
  });
});
