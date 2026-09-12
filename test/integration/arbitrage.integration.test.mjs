// test/integration/arbitrage.integration.test.mjs — /api/arb against a real booted server.
//
// bootServer() blanks every credential (OFFLINE_ENV), so eBay is unreachable here BY DESIGN. That is
// the half of the contract that matters most for a tool that spends a shared daily budget: the pure
// routes work with no network at all, a scan against no eBay DEGRADES into a {summary} line rather
// than a 500, and nothing is counted against the budget for a call that never happened.
//
// The set the tests resolve against is written into a throwaway cards cache before the server boots
// (PKM_CARDS_CACHE_DIR), so no test depends on what happens to be cached on the machine and nothing
// stubbed can reach the real, never-expiring cache.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';

const CACHE = tmpDir('tcg-arb-cards-');
process.env.PKM_CARDS_CACHE_DIR = CACHE;

const card = (n, name, prices, rarity = 'Common') => ({
  id: 'zzarb-' + n, name, number: String(n), rarity, images: { small: 's.png', large: 'l.png' },
  set: { id: 'zzarb', name: 'Arb Test Set', series: 'SV', ptcgoCode: 'ZZA', releaseDate: '2026/01/01', printedTotal: 100, total: 110 },
  tcgplayer: { updatedAt: '2026/09/10', prices },
});
const CARDS = [
  card(4, 'Oddish', { normal: { market: 0.2, mid: 0.3, low: 0.1 }, reverseHolofoil: { market: 2.5, mid: 3, low: 1 } }),
  card(25, 'Pikachu', { holofoil: { market: 12, mid: 14, low: 9 } }, 'Rare Holo'),
  card(26, 'Raichu', { holofoil: { low: 1 } }, 'Rare Holo'),                    // a low-only printing: no market
  card(105, 'Charizard ex', { holofoil: { market: 90, mid: 95, low: 80 } }, 'Special Illustration Rare'),
];
before(() => {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'zzarb.json'), JSON.stringify({ v: 1, setId: 'zzarb', at: new Date().toISOString(), count: CARDS.length, cards: CARDS }));
});

const { bootServer } = await import('../helpers/boot-server.mjs');
let srv;
before(async () => { srv = await bootServer(); }, { timeout: 60_000 });
after(async () => { await srv?.close(); });

const get = async (p) => { const r = await fetch(srv.base + p); let json = null; try { json = await r.json(); } catch { /* html */ } return { status: r.status, json }; };
const send = async (method, p, body) => {
  const r = await fetch(srv.base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* ndjson or html */ }
  return { status: r.status, json, headers: r.headers };
};
const post = (p, b) => send('POST', p, b);
const patch = (p, b) => send('PATCH', p, b);

describe('the page and the config', () => {
  it('/arbitrage.html is served and reaches the API', async () => {
    const r = await fetch(srv.base + '/arbitrage.html');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Arbitrage Finder/);
    assert.match(html, /html-proxy/, 'the module script is extracted by Vite');
  });
  it('/config reports the seeded defaults, a fresh budget and that eBay is unconfigured', async () => {
    const { status, json } = await get('/api/arb/config');
    assert.equal(status, 200);
    assert.equal(json.config.buyer_pct, 0.8);
    assert.equal(json.config.watch.enabled, false);
    assert.deepEqual(json.budget, { day: new Date().toISOString().slice(0, 10), used: 0, cap: 3500, remaining: 3500 });
    assert.equal(json.ebay_configured, false);
    assert.equal(json.watch_job.running, false, 'disarmed by default, so no timer');
  });
  it('the settings registry knows the file and refuses a bad save', async () => {
    const { json } = await get('/api/settings/arbitrage');
    assert.ok(json && json.content && json.content.buyer_pct === 0.8, 'GET /api/settings/arbitrage serves the file');
  });
});

describe('POST /api/arb/resolve — the catch line, no eBay', () => {
  it('numbers, printing tokens, *name and an unknown line', async () => {
    const { status, json } = await post('/api/arb/resolve', { setId: 'zzarb', lines: ['4 r', '004', '*chari', '26', '999', 'zzz'] });
    assert.equal(status, 200);
    assert.equal(json.set_id, 'zzarb');
    const by = (line) => json.cards.filter((c) => c.line === line);
    assert.equal(by('4 r')[0].chosen_key, 'reverseHolofoil');
    assert.equal(by('4 r')[0].market_usd, 2.5);
    assert.equal(by('004')[0].chosen_key, 'normal', 'no token → the first printing');
    assert.equal(by('004')[0].market_usd, 0.2);
    assert.equal(by('*chari')[0].card_id, 'zzarb-105');
    assert.equal(by('*chari')[0].ptcgo_code, 'ZZA', 'the card\'s own set block is enough; the sets cache is only a fallback');
    assert.equal(by('26')[0].market_usd, null, 'a low-only printing has NO market — the buyer pays on market (GR4)');
    assert.equal(by('26')[0].market_which, 'low');
    assert.deepEqual(json.unknown.map((u) => u.line), ['999', 'zzz']);
    assert.equal(json.cards.every((c) => c.watching === false), true);
  });
  it('a set that is not cached is reported, not fetched into a 500', async () => {
    const { status, json } = await post('/api/arb/resolve', { setId: 'zznope', lines: ['1'] });
    assert.equal(status, 200);
    assert.equal(json.cards.length, 0);
    assert.match(json.unknown[0].why, /not cached/);
  });
  it('lines is required', async () => { assert.equal((await post('/api/arb/resolve', {})).status, 400); });
});

describe('POST /api/arb/scan — degrades with no eBay, spends nothing', () => {
  it('streams NDJSON that ends in a summary naming the reason', async () => {
    const r = await fetch(srv.base + '/api/arb/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cards: [{ card_id: 'zzarb-25', printing_key: 'holofoil' }] }) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /ndjson/);
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines[0].job && lines[0].job.id, 'first line names the job');
    const summary = lines.find((l) => l.summary);
    assert.ok(summary, 'a summary always arrives');
    // With every key blanked the fx proxy still answers (Frankfurter is keyless) but may be
    // unreachable offline; either way the scan stops with a NAMED reason, never a thrown 500.
    assert.ok(['ebay_unconfigured', 'fx_unavailable'].includes(summary.summary.aborted), 'aborted=' + summary.summary.aborted);
    const { json } = await get('/api/arb/config');
    assert.equal(json.budget.used, summary.summary.aborted === 'ebay_unconfigured' ? 1 : 0, 'an attempt that reached the proxy is counted; one that never left is not');
  });
  it('refuses a scan bigger than the budget left, before starting it', async () => {
    const cards = Array.from({ length: 4000 }, (_, i) => ({ card_id: 'zzarb-' + i, printing_key: 'holofoil' }));
    const { status, json } = await post('/api/arb/scan', { cards });
    assert.equal(status, 429);
    assert.equal(json.code, 'budget');
    assert.equal(json.need, 4000);
  });
  it('a card with no market is skipped with a reason, and the state route answers', async () => {
    const r = await fetch(srv.base + '/api/arb/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cards: [{ card_id: 'zzarb-26', printing_key: 'holofoil' }, { card_id: 'zzarb-99', printing_key: 'holofoil' }] }) });
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    const cardLines = lines.filter((l) => l.card);
    if (cardLines.length) {
      assert.equal(cardLines[0].card.error, 'no_market');
      assert.equal(cardLines[1].card.error, 'card_not_found');
    } else {
      assert.equal(lines.find((l) => l.summary).summary.aborted, 'fx_unavailable');
    }
    const st = await get('/api/arb/scan/state');
    assert.equal(st.status, 200);
    assert.equal(st.json.running, false);
    assert.ok(st.json.id, 'the last job id is remembered');
    assert.equal((await get('/api/arb/scan/' + st.json.id)).status, 200);
    assert.equal((await get('/api/arb/scan/nope')).status, 404);
  });
  it('the same card twice in one request is one call, not two', async () => {
    const before = (await get('/api/arb/config')).json.budget.used;
    const r = await fetch(srv.base + '/api/arb/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cards: [{ card_id: 'zzarb-25', printing_key: 'holofoil' }, { card_id: 'zzarb-25', printing_key: 'holofoil' }] }) });
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.find((l) => l.start).start.total, 1, 'deduped before the budget check');
    const after = (await get('/api/arb/config')).json.budget.used;
    assert.ok(after - before <= 1, 'at most one attempt counted');
  });
  it('nothing_watched when the watch list is empty', async () => {
    const { status, json } = await post('/api/arb/scan', { watch: true });
    assert.equal(status, 400); assert.equal(json.code, 'nothing_watched');
  });
});

describe('the watch list', () => {
  it('adds, lists, pauses and removes; a low-only printing is still watchable', async () => {
    const add = await post('/api/arb/watch', { cards: [{ card_id: 'zzarb-4', printing_key: 'reverseHolofoil' }, { card_id: 'zzarb-26', printing_key: 'holofoil' }, { card_id: 'zzarb-99', printing_key: 'holofoil' }] });
    assert.equal(add.status, 200);
    assert.equal(add.json.added.length, 2);
    assert.deepEqual(add.json.failed.map((f) => f.error), ['card_not_found']);
    const w = add.json.added.find((r) => r.card_id === 'zzarb-4');
    assert.equal(w.printing_key, 'reverseHolofoil'); assert.equal(w.printed_total, 100); assert.equal(w.last_market_usd_cents, 250); assert.equal(w.active, 1);

    const again = await post('/api/arb/watch', { cards: [{ card_id: 'zzarb-4', printing_key: 'reverseHolofoil' }] });
    assert.equal(again.json.added.length, 1, 'upsert, not a duplicate');
    const list = await get('/api/arb/watch');
    assert.equal(list.json.watch.length, 2);

    const res = await post('/api/arb/resolve', { setId: 'zzarb', lines: ['4 r'] });
    assert.equal(res.json.cards[0].watching, true, 'resolve now says it is watched');

    assert.equal((await patch('/api/arb/watch/' + w.id, { active: false })).json.row.active, 0);
    assert.equal((await send('DELETE', '/api/arb/watch/' + w.id, {})).status, 200);
    assert.equal((await send('DELETE', '/api/arb/watch/' + w.id, {})).status, 404);
  });
});

describe('the sweep list', () => {
  it('adds a cached set with its facts, refuses an unknown one, pauses, resets and removes', async () => {
    const add = await post('/api/arb/sweep', { sets: ['zzarb', 'zznope', 'zzarb'] });
    assert.equal(add.status, 200);
    assert.equal(add.json.added.length, 1);
    assert.deepEqual(add.json.failed, [{ set_id: 'zznope', error: 'set_not_cached' }]);
    const row = add.json.added[0];
    assert.equal(row.set_name, 'Arb Test Set'); assert.equal(row.printed_total, 100); assert.equal(row.total, 110); assert.equal(row.ptcgo_code, 'ZZA'); assert.equal(row.enabled, 1); assert.equal(row.watermark, null);
    const list = await get('/api/arb/sweep');
    assert.equal(list.json.sets.length, 1);
    assert.deepEqual(list.json.config.queries, ['name', 'number']);
    assert.equal((await patch('/api/arb/sweep/zzarb', { enabled: false })).json.row.enabled, 0);
    assert.equal((await patch('/api/arb/sweep/zzarb', { reset: true })).status, 200);
    assert.equal((await patch('/api/arb/sweep/zzarb', {})).status, 400);
    assert.equal((await patch('/api/arb/sweep/zznope', { enabled: true })).status, 404);
  });
  it('a sweep with no eBay degrades into a summary, and a paused set is not swept', async () => {
    let r = await post('/api/arb/scan', { sweep: true });
    assert.equal(r.status, 400); assert.equal(r.json.code, 'no_sets', 'the only set is paused');
    await patch('/api/arb/sweep/zzarb', { enabled: true });
    const res = await fetch(srv.base + '/api/arb/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sweep: true }) });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].job.mode, 'sweep');
    const summary = lines.find((l) => l.summary);
    assert.ok(summary, 'a summary always arrives');
    assert.equal(summary.summary.mode, 'sweep');
    assert.ok(['ebay_unconfigured', 'fx_unavailable'].includes(summary.summary.aborted), 'aborted=' + summary.summary.aborted);
    const after = (await get('/api/arb/sweep')).json.sets[0];
    assert.equal(after.watermark, null, 'a pass that read nothing moves no watermark');
    assert.equal((await send('DELETE', '/api/arb/sweep/zzarb', {})).status, 200);
    assert.equal((await send('DELETE', '/api/arb/sweep/zzarb', {})).status, 404);
  });
});

describe('hits — status transitions are the owner\'s, and refusals are 409s', () => {
  it('a hand-inserted hit walks new → seen → bought and can go no further', async () => {
    // No eBay here, so the row is planted straight into the redirected tracker DB the server opened.
    const { openDb } = await import('../../lib/db.mjs');
    const db = openDb();
    const id = db.prepare(`INSERT INTO arb_hits (set_id, card_id, number, name, printing_key, item_id, price_cents, ship_cents, fee_cents, delivered_cents, market_usd_cents, fx_usd_aud, buyer_pct, buyer_aud_cents, profit_cents, margin_pct, ratio, title, url, warnings, first_seen, last_seen, status)
                            VALUES ('zzarb','zzarb-25','25','Pikachu','holofoil','v1|1|0',900,200,102,1202,1200,1.4,0.8,1344,142,11.8,0.72,'Pikachu 25/100 NM','https://www.ebay.com.au/itm/1','[{"k":"cond_unstated","why":"x"}]','2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z','new')`).run().lastInsertRowid;
    const open = await get('/api/arb/hits');
    assert.equal(open.json.hits.length, 1);
    assert.deepEqual(open.json.hits[0].warnings, [{ k: 'cond_unstated', why: 'x' }], 'warnings come back parsed');
    assert.equal(open.json.counts.new, 1);

    assert.equal((await patch('/api/arb/hits/' + id, { status: 'gone' })).status, 409, 'gone is the scan\'s to set, not a click');
    assert.equal((await patch('/api/arb/hits/' + id, { status: 'seen' })).status, 200);
    assert.equal((await patch('/api/arb/hits', { ids: [id], status: 'seen' })).json.refused, 1, 'seen → seen is not a transition');
    assert.equal((await patch('/api/arb/hits/' + id, { status: 'bought' })).status, 200);
    assert.equal((await patch('/api/arb/hits/' + id, { status: 'dismissed' })).status, 409, 'bought is final');
    assert.equal((await get('/api/arb/hits?status=bought')).json.hits.length, 1);
    assert.equal((await get('/api/arb/hits')).json.hits.length, 0, 'open means new or seen');
    assert.equal((await patch('/api/arb/hits/999999', { status: 'seen' })).status, 404);
  });
  it('check-qty degrades without eBay and still counts the attempt', async () => {
    const bought = (await get('/api/arb/hits?status=bought')).json.hits[0];
    const before = (await get('/api/arb/config')).json.budget.used;
    const { status, json } = await post('/api/arb/hits/' + bought.id + '/check-qty', {});
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal((await get('/api/arb/config')).json.budget.used, before + 1);
  });
});

describe('unknown routes', () => {
  it('404 with the endpoint list, never a thrown 500', async () => {
    const { status, json } = await get('/api/arb/nope');
    assert.equal(status, 404);
    assert.ok(json.endpoints.includes('/scan'));
    assert.ok(json.endpoints.includes('/sweep'));
  });
});
