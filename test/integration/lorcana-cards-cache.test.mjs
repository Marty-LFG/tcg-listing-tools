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
const { lorcanaCardsPlugin, getSetCards, readSetCache, findCardInSet, isCompleteSet, decideCardsResponse, resolveLorcanaCard } =
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
function callSet(url) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { chunks.push(b); resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(chunks.join('') || 'null') }); },
    };
    MW['/api/lorcana/set']({ method: 'GET', url }, res, () => resolve({ status: 'next', headers: {}, json: null }));
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

describe('GET /api/lorcana/set/:id/cards — the batch runner`s whole set in one request', () => {
  it('answers the whole set, in the same envelope the Pokémon and Magic routes use', async () => {
    const calls = stubUpstream(5);
    const a = await callSet('/' + SET + '/cards');
    assert.equal(a.status, 200);
    assert.equal(a.json.setId, SET);
    assert.equal(a.json.count, 5);
    assert.equal(a.json.cards.length, 5);
    assert.equal(calls.length, 1, 'ONE request for the whole set — that is the point of the route');
  });

  it('serves cards UNTRIMMED, because the runner reads fields across the whole object', async () => {
    stubUpstream(2);
    const a = await callSet('/' + SET + '/cards');
    // normalizeCard needs ink/inks, classifications, illustrators and layout, none of which a
    // Pokémon-style trim would have kept.
    assert.equal(a.json.cards[0].version, 'Brave');
    assert.deepEqual(a.json.cards[0].prices, { usd: '3.50', usd_foil: '9.00' });
  });

  it('the second load skips the disk entirely', async () => {
    stubUpstream(3);
    await callSet('/' + SET + '/cards');
    const calls = stubUpstream(3);
    const b = await callSet('/' + SET + '/cards');
    assert.equal(b.headers['x-tcg-cache'], 'memory');
    assert.equal(calls.length, 0);
  });

  it('a set id that could become a filename is refused, not looked up', async () => {
    const bad = await callSet('/..%2Fetc/cards');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'bad_set_id');
  });

  it('promo codes are set ids too — cp, D23, PD1 all reach the route', async () => {
    for (const code of ['cp', 'D23', 'PD1', 'Coconut']) {
      stubUpstream(2);
      const r = await callSet('/' + code + '/cards');
      assert.equal(r.status, 200, code);
      assert.equal(r.json.setId, code);
      try { fs.unlinkSync(path.join(DIR, code.toLowerCase() + '.json')); } catch {}
    }
  });

  it('502s when Lorcast is down and nothing is stored, rather than an empty set', async () => {
    stubUpstream(0, { fail: true });
    const r = await callSet('/' + SET + '/cards');
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'upstream_unreachable');
  });

  it('leaves anything that is not a set-cards request to the proxy', async () => {
    for (const url of ['/', '/6', '/6/cards/extra']) assert.equal((await callSet(url)).status, 'next', url);
  });
});

describe('resolveLorcanaCard — the eBay export path re-resolves its facts', () => {
  it('finds a card by "<set>/<number>", the identity key the enumerator already writes', async () => {
    stubUpstream(5);
    await getSetCards(SET);
    const c = resolveLorcanaCard(SET + '/3');
    assert.equal(c.collector_number, '3');
    assert.equal(c.name, 'Character 3');
  });

  it('is case-insensitive on the number, the way findCardInSet is', async () => {
    stubUpstream(3);
    await getSetCards(SET);
    assert.ok(resolveLorcanaCard(SET + '/1'));
  });

  it('a cold cache, a junk key or a missing card is null, never a throw (GR7)', () => {
    clean();
    assert.equal(resolveLorcanaCard(SET + '/3'), null, 'cold cache');
    assert.equal(resolveLorcanaCard('no-slash'), null);
    assert.equal(resolveLorcanaCard('/3'), null, 'empty set id');
    assert.equal(resolveLorcanaCard(SET + '/'), null, 'empty number');
    assert.equal(resolveLorcanaCard(''), null);
    assert.equal(resolveLorcanaCard(null), null);
    assert.equal(resolveLorcanaCard('../etc/3'), null, 'a traversal is not a set id');
  });

  it('picks up a refreshed set rather than serving the index it built first', async () => {
    stubUpstream(2);
    await getSetCards(SET);
    assert.equal(resolveLorcanaCard(SET + '/5'), null, 'not in the 2-card set');
    stubUpstream(6);
    await getSetCards(SET, { refresh: true });
    assert.ok(resolveLorcanaCard(SET + '/5'), 'the memo is keyed on the cache file mtime');
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

  it('a foil-only chase card enumerates as ONE row named by its rarity', async () => {
    // The whole point of Phase 1. Before it, an Epic or an Iconic came out as an ordinary 'Foil'
    // and collided with the plain foil printing on UNIQUE(game, identity_key, variant) — a US$3,632
    // card and a US$1 one made indistinguishable (GR5).
    globalThis.fetch = async () => ({
      ok: true, status: 200, text: async () => JSON.stringify([
        { ...card(241), rarity: 'Iconic', prices: { usd: null, usd_foil: '1344.77' } },
        { ...card(216), rarity: 'Epic', prices: { usd: null, usd_foil: '8.47' } },
        { ...card(1), rarity: 'Common', prices: { usd: '0.06', usd_foil: '0.18' } },
      ]),
    });
    const { rows } = await drain();
    const byNum = Object.fromEntries(rows.map((r) => [r.number + ':' + r.finish, r]));
    assert.equal(rows.filter((r) => r.number === '241').length, 1, 'no plain printing to sell');
    assert.equal(byNum['241:Iconic'].variant, 'Iconic');
    assert.equal(byNum['241:Iconic'].market_usd, 1344.77);
    assert.equal(byNum['216:Epic'].variant, 'Epic');
    // An ordinary card still yields both printings, Normal first.
    assert.equal(rows.filter((r) => r.number === '1').length, 2);
    assert.equal(byNum['1:Normal'].variant, 'Base');
    assert.equal(byNum['1:Foil'].variant, 'Foil');
  });

  it('a promo with no price at all is still a listable row (GR7)', async () => {
    // 66 of the 193 promos are in exactly this state. Promo is NOT foil-only — twelve are non-foil
    // — so it must not be treated as a chase rarity.
    globalThis.fetch = async () => ({
      ok: true, status: 200, text: async () => JSON.stringify([{ ...card(7), rarity: 'Promo', prices: {} }]),
    });
    const { rows } = await drain();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].finish, 'Normal', 'the under-promising answer, not a guessed foil');
    assert.equal(rows[0].market_usd, null);
    assert.equal(rows[0].rarity, 'Promo');
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
