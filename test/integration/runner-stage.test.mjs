// test/integration/runner-stage.test.mjs — the contract stock-runner.html's Stage step depends on.
//
// The Runner stages each queued row with POST /api/inventory/items (batch_id NULL), NOT
// POST /api/inventory/batches. That choice is load-bearing and easy to "tidy" into the wrong one
// later, so the reasons are pinned here as tests:
//
//   1. /items allocates a real shelf label; /batches hands out BK-RAW-* via nextBulkSku.
//   2. /items persists card_facts + store_categories; /batches drops both, which would strip the
//      item specifics off every batch listing.
//   3. /batches SKIPS a matched row that is already listed or sold, so re-listing a card you have
//      sold before would silently do nothing.
//
// Boots the real server against temp DBs (bootServer), so the owner's data/tracker.db and its
// monotonic label counter are never touched.
//
// ⚠ THE 409 BELOW IS A GUARANTEE, NOT AN OBSERVATION. This file POSTs the real /api/listings/batch
// route and asserts it refuses. That is safe ONLY because bootServer blanks the eBay credentials via
// OFFLINE_ENV (test/helpers/boot-server.mjs), which forces oauthStatus() to report disconnected on
// every machine — including the one that trades.
//
// It was not always. On 2026-08-23 this test listed "Batch Guard 210/197" on the LIVE eBay store at
// A$28.33, visible to buyers, because the assertion was written on a developer box with no consent and
// the helper blanked every credential except eBay's. The redirected databases made it worse rather than
// better: the staged row died with the temp DB, so nothing local ever recorded the listing.
//
// If you are here to remove that blanking, or to "fix" this test by giving it real credentials so the
// batch path can be exercised end to end: do not. Exercise it against a stub. A test that can reach a
// real marketplace has customers.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';

let srv;
before(async () => { srv = await bootServer(); }, { timeout: 60_000 });
after(async () => { await srv?.close(); });

const post = async (p, body) => {
  const r = await fetch(srv.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
};
const get = async (p) => {
  const r = await fetch(srv.base + p);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
};

// Exactly what stock-runner.html invRow() builds for one queued row.
function runnerRow(over = {}) {
  return Object.assign({
    game: 'pokemon', name: 'Charizard ex', set_name: 'Obsidian Flames', rarity: 'Double Rare',
    number: '125/197', language: 'EN', finish: 'Holofoil', variant: 'Holo',
    image_url: 'https://images.pokemontcg.io/sv3/125_hires.png', identity_key: 'sv3-125',
    illustrator: 'PLANETA Mochizuki', card_type: 'Pokémon', stage: 'Stage 2',
    condition: 'Ungraded, Near Mint',
    store_categories: ['Trading Card Games/Pokemon'],
    card_facts: JSON.stringify({
      hp: '330', pokedex: [6], regulation_mark: 'G', evolves_from: 'Charmeleon',
      set_series: 'Scarlet & Violet', set_code: 'OBF', set_release_date: '2023/08/11',
      printed_total: 197, types: ['Darkness'], subtypes: ['Stage 2', 'ex'], supertype: 'Pokémon',
    }),
    quantity: 1, target_price_cents: 2833,
  }, over);
}

describe('Runner stage — POST /api/inventory/items', () => {
  it('accepts the row shape the Runner builds and returns an id + sku', async () => {
    const r = await post('/api/inventory/items', runnerRow());
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.id > 0);
    assert.ok(r.json.sku, 'a stock label must come back — the grid shows it as bound for life');
  });

  it('persists card_facts, so batch listings carry the same item specifics as hand-made ones', async () => {
    const created = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-126', number: '126/197', name: 'Pidgeot ex' }));
    assert.equal(created.status, 201, created.text);
    const { json } = await get('/api/inventory/items?q=Pidgeot');
    const row = (json.items || []).find((x) => x.id === created.json.id);
    assert.ok(row, 'created row not found');
    // Without this, itemToListing() would rebuild a thinner listing and the aspects (HP, Character
    // from the dex numbers, regulation mark, set series) would silently vanish from the listing.
    assert.ok(row.card_facts, 'card_facts must persist');
    const facts = JSON.parse(row.card_facts);
    assert.equal(facts.hp, '330');
    assert.deepEqual(facts.pokedex, [6]);
    assert.equal(facts.set_code, 'OBF');
  });

  it('persists store_categories, or every batch listing lands in the store’s “Other” department', async () => {
    const created = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-127', number: '127/197', name: 'Tyranitar' }));
    const { json } = await get('/api/inventory/items?q=Tyranitar');
    const row = (json.items || []).find((x) => x.id === created.json.id);
    assert.ok(row.store_categories, 'store_categories must persist');
    assert.deepEqual(JSON.parse(row.store_categories), ['Trading Card Games/Pokemon']);
  });

  it('keeps quantity — several copies are ONE listing under ONE label', async () => {
    const created = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-128', number: '128/197', name: 'Charmander', quantity: 5 }));
    const { json } = await get('/api/inventory/items?q=Charmander');
    const row = (json.items || []).find((x) => x.id === created.json.id);
    assert.equal(row.quantity, 5);
    assert.equal(row.sku, created.json.sku, 'one label for the whole quantity, not five');
  });

  it('an owner-chosen label that is already taken is refused, never silently reassigned', async () => {
    const a = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-129', number: '129/197', name: 'Dupe A' }));
    assert.equal(a.status, 201);
    const b = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-130', number: '130/197', name: 'Dupe B', sku: a.json.sku }));
    assert.equal(b.status, 409, 'a taken label must 409');
    assert.equal(b.json.code, 'sku_taken');
  });

  it('a sub-NM row is storable — the Runner holds it back in the UI, the DB does not care', async () => {
    const r = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-131', number: '131/197', name: 'Played One', condition: 'Ungraded, Lightly Played' }));
    assert.equal(r.status, 201, r.text);
  });
});

describe('Phase 2 routes — /api/listings/batch', () => {
  it('preflight needs NO eBay connection — it is local-only, which is what makes it free', async () => {
    const a = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-200', number: '200/197', name: 'Preflight One' }));
    const b = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-201', number: '201/197', name: 'Preflight Two', target_price_cents: 90000 }));
    const r = await get('/api/listings/batch/preflight?item_ids=' + a.json.id + ',' + b.json.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 2);
    assert.ok(r.json.rows[0].title, 'preflight builds the real title');
    // The dear one trips the ceiling; eBay is force-disconnected here (OFFLINE_ENV), and it still worked.
    assert.ok(r.json.rows[1].refusals.some((x) => x.code === 'over_ceiling'));
  });

  it('preflight rejects a missing item_ids rather than silently doing nothing', async () => {
    const r = await get('/api/listings/batch/preflight');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /item_ids/);
  });

  // The row this stages is the one that escaped. Left exactly as it was, deliberately: the fixture was
  // never the problem, and renaming it would remove the only landmark tying this file to the incident.
  it('the publish route refuses up front when eBay is not connected — once, not N times', async () => {
    const a = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-210', number: '210/197', name: 'Batch Guard' }));
    const r = await post('/api/listings/batch', { item_ids: [a.json.id] });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'not_connected');
  });

  it('an empty batch is a 400, not an empty NDJSON stream', async () => {
    const r = await post('/api/listings/batch', { item_ids: [] });
    // 409 (not connected) is checked first on this box; either way it must never 200 with no work.
    assert.ok(r.status === 400 || r.status === 409, 'got ' + r.status);
  });
});

describe('Phase 4 routes — the detached job', () => {
  it('GET /batch/state answers when nothing is running, so a reopened tab can tell', async () => {
    const r = await get('/api/listings/batch/state');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.running, false);
    assert.equal(r.json.id, null);
  });

  it('polling or streaming an unknown run is a 404, not an empty stream that hangs', async () => {
    const poll = await get('/api/listings/batch/nosuchrun');
    assert.equal(poll.status, 404);
    assert.equal(poll.json.code, 'unknown_job');
  });

  it('cancelling when nothing is running is a clean refusal', async () => {
    const r = await post('/api/listings/batch/nosuchrun/cancel', {});
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'not_running');
  });

  it('/batch/state is not swallowed by the /batch/:id route', async () => {
    // '/batch/state' matches the :id pattern too, so ordering matters — a regression here would
    // turn the discovery endpoint into a 404 and stop tabs re-attaching.
    const r = await get('/api/listings/batch/state');
    assert.equal(r.status, 200);
    assert.ok('running' in r.json);
  });
});

describe('Phase 3 — POST /api/inventory/match/batch', () => {
  it('answers many cards at once, with the SAME semantics as the per-row check', async () => {
    const a = await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-300', number: '300/197', name: 'Match One' }));
    assert.equal(a.status, 201, a.text);
    const keys = [
      { game: 'pokemon', identity_key: 'sv3-300', variant: 'Holo', language: 'EN', condition: 'Ungraded, Near Mint' },
      { game: 'pokemon', identity_key: 'sv3-999', variant: 'Holo', language: 'EN', condition: 'Ungraded, Near Mint' },
    ];
    const r = await post('/api/inventory/match/batch', { keys });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 2);
    assert.equal(r.json.results[0].exact.length, 1, 'the held card matches');
    assert.equal(r.json.results[0].exact[0].sku, a.json.sku);
    assert.equal(r.json.results[1].exact.length, 0, 'a card we do not hold matches nothing');
  });

  it('condition is part of identity — an LP copy is not the NM one', async () => {
    await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-310', number: '310/197', name: 'Cond Split' }));
    const nm = await post('/api/inventory/match/batch', { keys: [{ game: 'pokemon', identity_key: 'sv3-310', variant: 'Holo', language: 'EN', condition: 'Ungraded, Near Mint' }] });
    const lp = await post('/api/inventory/match/batch', { keys: [{ game: 'pokemon', identity_key: 'sv3-310', variant: 'Holo', language: 'EN', condition: 'Ungraded, Lightly Played' }] });
    assert.equal(nm.json.results[0].exact.length, 1);
    assert.equal(lp.json.results[0].exact.length, 0, 'different condition = different stock');
    assert.equal(lp.json.results[0].near.length, 1, '...but it is a NEAR match worth showing');
  });

  it('printing is part of identity too (GR5)', async () => {
    await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-320', number: '320/197', name: 'Variant Split' }));
    const rev = await post('/api/inventory/match/batch', { keys: [{ game: 'pokemon', identity_key: 'sv3-320', variant: 'Reverse Holo', language: 'EN', condition: 'Ungraded, Near Mint' }] });
    assert.equal(rev.json.results[0].exact.length, 0);
    assert.equal(rev.json.results[0].near.length, 1);
  });

  it('a key with no identity_key comes back empty rather than wrong', async () => {
    const r = await post('/api/inventory/match/batch', { keys: [{ game: 'pokemon', name: 'Nameless' }] });
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].exact.length, 0);
    assert.match(r.json.results[0].reason, /identity_key/);
  });

  it('results line up with the keys that were sent, in order', async () => {
    await post('/api/inventory/items', runnerRow({ identity_key: 'sv3-330', number: '330/197', name: 'Order A' }));
    const keys = [
      { game: 'pokemon', identity_key: 'sv3-nope', variant: 'Holo', language: 'EN', condition: 'Ungraded, Near Mint' },
      { game: 'pokemon', identity_key: 'sv3-330', variant: 'Holo', language: 'EN', condition: 'Ungraded, Near Mint' },
    ];
    const r = await post('/api/inventory/match/batch', { keys });
    assert.equal(r.json.results[0].exact.length, 0);
    assert.equal(r.json.results[1].exact.length, 1);
    assert.equal(r.json.results[1].identity_key, 'sv3-330');
  });

  it('rejects an empty or oversized key list', async () => {
    assert.equal((await post('/api/inventory/match/batch', { keys: [] })).status, 400);
    const many = Array.from({ length: 1001 }, () => ({ identity_key: 'x' }));
    assert.equal((await post('/api/inventory/match/batch', { keys: many })).status, 400);
  });
});

describe('why the Runner does NOT stage through POST /api/inventory/batches', () => {
  it('/batches drops card_facts and store_categories — the reason /items is used instead', async () => {
    const r = await post('/api/inventory/batches', {
      batch: { game: 'pokemon', source: 'enumerate', set_name: 'Obsidian Flames' },
      rows: [{
        game: 'pokemon', name: 'Batch Path', identity_key: 'sv3-900', number: '900/197', variant: 'Holo',
        set_name: 'Obsidian Flames', quantity: 1,
        card_facts: JSON.stringify({ hp: '330' }), store_categories: ['Trading Card Games/Pokemon'],
      }],
    });
    assert.equal(r.status, 201, r.text);
    const { json } = await get('/api/inventory/items?q=Batch Path');
    const row = (json.items || [])[0];
    assert.ok(row, 'batch row not created');
    // If either of these ever becomes non-null, /batches has learned to carry them and the Runner
    // could switch to it for a single round-trip stage. Until then, /items is the only correct path.
    assert.equal(row.card_facts, null, '/batches still drops card_facts');
    assert.equal(row.store_categories, null, '/batches still drops store_categories');
  });

  it('/batches issues a BK-RAW-* bulk sku, not a shelf label', async () => {
    const { json } = await get('/api/inventory/items?q=Batch Path');
    const row = (json.items || [])[0];
    assert.match(row.sku, /^BK-RAW-/, '/batches uses nextBulkSku');
  });
});
