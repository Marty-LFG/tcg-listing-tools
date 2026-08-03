// test/integration/lorcana-cards-cache.test.mjs — Lorcana sets, fetched once and kept.
//
// The same treatment as the Pokémon cache, for the two places Lorcana went to Lorcast live: the bulk
// enumerator (whole list, every enumeration — and when that list came back empty it WALKED the
// collector numbers, one request each) and the builder's per-card lookup.
//
// Lorcast returns a set in one request, which changes one thing worth pinning: the first card looked
// up in a set pays for the whole set, and every card after it in that set is free.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// A throwaway cache folder, set before the module is imported: this cache never expires, so a test
// fixture written into the real one would still be there next month.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-lorcana-cache-'));
process.env.LORCANA_CARDS_CACHE_DIR = DIR;
const { lorcanaCardsPlugin, getSetCards, readSetCache, findCardInSet, isCompleteSet, decideCardsResponse } =
  await import('../../lib/lorcana-cards-cache.mjs');
const { ENUMERATORS } = await import('../../lib/enumerate.mjs');

const realFetch = globalThis.fetch;
const SET = '6';
const card = (n) => ({
  id: 'crd' + n, name: 'Character ' + n, version: 'Brave', collector_number: String(n),
  rarity: 'super_rare', set: { id: SET, name: 'Azurite Sea' },
  image_uris: { digital: { large: 'l.png' } },
  prices: { usd: '3.50', usd_foil: '9.00' },
});

// Lorcast's list endpoint, in both shapes it has been seen to return.
function stubUpstream(total, { fail = false, wrapped = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (fail) return { ok: false, status: 500, text: async () => 'nope' };
    const cards = Array.from({ length: total }, (_, i) => card(i + 1));
    return { ok: true, status: 200, text: async () => JSON.stringify(wrapped ? { results: cards } : cards) };
  };
  return calls;
}

const MW = {};
lorcanaCardsPlugin().configureServer({ middlewares: { use: (p, h) => { MW[p] = h; } } });
function callCard(url) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { chunks.push(b); resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(chunks.join('') || 'null') }); },
    };
    MW['/api/lorcana/cards']({ method: 'GET', url }, res, () => resolve({ status: 'next', headers: {}, json: null }));
  });
}

const clean = () => { try { fs.unlinkSync(path.join(DIR, SET + '.json')); } catch {} };
before(clean);
after(() => { globalThis.fetch = realFetch; try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
beforeEach(clean);

describe('the Lorcana set cache', () => {
  it('fetches a set once and stores it', async () => {
    const calls = stubUpstream(3);
    const got = await getSetCards(SET);
    assert.equal(got.cards.length, 3);
    assert.equal(calls.length, 1, 'one request — Lorcast serves a whole set in one');
    assert.equal(readSetCache(SET).count, 3);
  });

  it('reads the wrapped shape as well as the bare array', async () => {
    stubUpstream(2, { wrapped: true });
    assert.equal((await getSetCards(SET)).cards.length, 2);
  });

  it('the second caller costs nothing upstream', async () => {
    stubUpstream(3);
    await getSetCards(SET);
    const calls = stubUpstream(3);
    assert.equal((await getSetCards(SET)).cards.length, 3);
    assert.equal(calls.length, 0);
  });

  it('an empty list is no answer at all, not an empty set', () => {
    assert.equal(isCompleteSet([]), false, 'storing it would blank the set forever');
    const d = decideCardsResponse({ cards: [] }, { at: 'X', cards: [card(1)] }, 'NOW');
    assert.equal(d.store, false);
    assert.equal(d.stale, true, 'serve the copy we trust');
  });

  it('Lorcast down with a copy stored: serve the copy, keep the file', async () => {
    stubUpstream(3);
    await getSetCards(SET);
    stubUpstream(0, { fail: true });
    const got = await getSetCards(SET, { refresh: true });
    assert.equal(got.stale, true);
    assert.equal(got.cards.length, 3);
    assert.equal(readSetCache(SET).count, 3);
  });
});

describe('findCardInSet — Lorcast pads collector numbers inconsistently', () => {
  const cards = [card(7), card(70)];
  it('matches on the number, not the text', () => {
    assert.equal(findCardInSet(cards, '7').collector_number, '7');
    assert.equal(findCardInSet(cards, '007').collector_number, '7', 'a padded number is the same card');
    assert.equal(findCardInSet(cards, '70').collector_number, '70', 'and 70 is NOT 7');
  });
  it('misses cleanly', () => {
    assert.equal(findCardInSet(cards, '999'), null);
    assert.equal(findCardInSet(cards, ''), null);
    assert.equal(findCardInSet([], '7'), null);
  });
});

describe('GET /api/lorcana/cards/:set/:num', () => {
  it('answers from the set, fetching it once on the first card', async () => {
    const calls = stubUpstream(5);
    const a = await callCard('/' + SET + '/3');
    assert.equal(a.status, 200);
    assert.equal(a.json.collector_number, '3');
    assert.equal(a.json.name, 'Character 3', 'served as Lorcast returns it — the builder reads it whole');
    const b = await callCard('/' + SET + '/4');
    assert.equal(b.json.collector_number, '4');
    assert.equal(calls.length, 1, 'the first card paid for the set; the rest are free');
  });

  it('falls through for a card the set does not contain', async () => {
    stubUpstream(3);
    await getSetCards(SET);
    assert.equal((await callCard('/' + SET + '/999')).status, 'next', 'never invent a 404 of our own');
  });

  it('falls through when Lorcast is down and nothing is stored', async () => {
    stubUpstream(0, { fail: true });
    assert.equal((await callCard('/' + SET + '/1')).status, 'next', 'let the proxy have its own go');
  });

  it('leaves anything that is not a card lookup to the proxy', async () => {
    for (const url of ['/', '/6', '/6/1/extra']) assert.equal((await callCard(url)).status, 'next', url);
  });
});

describe('ENUMERATORS.lorcana — through the cache', () => {
  async function drain() {
    const rows = [], warnings = [];
    for await (const out of ENUMERATORS.lorcana({ base: 'http://stub', setId: SET, setName: 'Azurite Sea' })) {
      if (out.warning) warnings.push(out.warning); else rows.push(out.row);
    }
    return { rows, warnings };
  }

  it('enumerates from the cache, one row per printing', async () => {
    stubUpstream(2);
    const { rows, warnings } = await drain();
    assert.deepEqual(warnings, []);
    assert.equal(rows.length, 4, '2 cards × usd + usd_foil');
    assert.equal(rows[0].game, 'lorcana');
    assert.equal(rows[0].set_name, 'Azurite Sea');
  });

  it('the second enumeration costs nothing, and never falls back to walking the numbers', async () => {
    stubUpstream(2);
    await drain();
    const calls = stubUpstream(2);
    const { rows, warnings } = await drain();
    assert.equal(calls.length, 0);
    assert.equal(rows.length, 4);
    assert.ok(!warnings.some((w) => /iterating/.test(w)), 'the per-card walk is what this replaces');
  });
});
