// test/integration/runs-api.test.mjs — the Keeper's Runs API on the REAL dev server: create a run,
// declare its composition, claim stock, bind it to a numbered bundle, and confirm the answer sheet is
// gated while the shape of the run is not.
//
// Boots the whole of vite.config.js against temp databases, so this also proves the plugin is actually
// registered — a route that exists in lib/ but never reaches withRegistry is a file nobody can call,
// and every other signal (imports resolve, unit tests pass) reads green while it is missing.
//
// The stock is created through the real inventory API rather than by INSERT, because the reservation
// guards this run exercises are the ones that fire on real rows.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';

let srv;
before(async () => { srv = await bootServer(); }, { timeout: 60_000 });
after(async () => { await srv?.close(); });

const req = async (method, p, body, headers = {}) => {
  const r = await fetch(srv.base + p, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
};
const get = (p, h) => req('GET', p, null, h);
const post = (p, b, h) => req('POST', p, b || {}, h);

// Edition 1's shape, as DATA. Nothing about slab/packs/art is hardcoded in the schema, the hash format
// or the API — this object is the whole of it, which is the property that makes a differently-shaped
// Edition 2 a configuration change rather than a migration.
const E1_SLOTS = [
  { slot: 'slab', label: 'Graded slab', kind: 'inventory', qty_per_bundle: 1, singleton: true, requires_cert: true, is_chase_slot: true },
  { slot: 'packs', label: 'Sealed boosters', kind: 'sealed', qty_per_bundle: 3, max_lines: 3 },
  { slot: 'art', label: 'Art card', kind: 'inventory', qty_per_bundle: 1, singleton: true },
];

let slabItem, artItem;

describe('creating a run', () => {
  it('refuses a dev run whose identifier does not say so', async () => {
    const r = await post('/api/runs', { public_id: 'E9', mode: 'dev', edition: 9, name: 'Nope', unit_count: 3, slots: E1_SLOTS });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /must start with DEV-/);
  });

  it('refuses a composition with no chase slot — a chase REPLACES the base, so it needs somewhere to land', async () => {
    const slots = E1_SLOTS.map((s) => ({ ...s, is_chase_slot: false }));
    const r = await post('/api/runs', { public_id: 'DEV-E9', mode: 'dev', edition: 9, name: 'Nope', unit_count: 3, slots });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /exactly one slot must be is_chase_slot; 0 were/);
  });

  it('refuses a slot name that could not become an attribute name', async () => {
    const slots = [{ ...E1_SLOTS[0], slot: 'Graded Slab' }, E1_SLOTS[1], E1_SLOTS[2]];
    const r = await post('/api/runs', { public_id: 'DEV-E9', mode: 'dev', edition: 9, name: 'Nope', unit_count: 3, slots });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /attribute names inside the hash/);
  });

  it('creates the run, its composition and every bundle in one go', async () => {
    const r = await post('/api/runs', {
      public_id: 'DEV-E1', mode: 'dev', edition: 1, name: 'Rehearsal Edition One', unit_count: 3, slots: E1_SLOTS,
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.bundles, 3);
    assert.equal(r.json.slots.length, 3);
    // sort_order is the canonical serialisation order and is NEVER reordered after lock, so it is
    // taken from declaration order rather than from anything the database chose.
    assert.deepEqual(r.json.slots.map((s) => s.slot), ['slab', 'packs', 'art']);

  });

  it('numbers and labels the bundles from the run identifier', async () => {
    const r = await get('/api/runs/DEV-E1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.bundles.map((b) => b.label), ['DEV-E1-001', 'DEV-E1-002', 'DEV-E1-003']);
    assert.ok(r.json.fill.every((b) => b.complete === false), 'a fresh run is entirely unbuilt');
    assert.deepEqual(r.json.fill[0].slots.slab, { want: 1, have: 0, complete: false });
    assert.deepEqual(r.json.fill[0].slots.packs, { want: 3, have: 0, complete: false });
  });

  it('never serves a bundle secret, even on an internal route', async () => {
    const r = await get('/api/runs/DEV-E1');
    // salt_hex and verify_code are bearer secrets and seal_serial addresses a parcel. The column list
    // is the control: a field that is never selected cannot be forgotten by a filter.
    for (const key of ['salt_hex', 'verify_code', 'seal_serial']) {
      assert.ok(!(key in r.json.bundles[0]), `${key} must not be selected`);
    }
    assert.ok(!('unit_price_cents' in r.json.run), 'the schema has one money column and this API never selects it');
  });
});

describe('claiming and binding stock', () => {
  before(async () => {
    const slab = await post('/api/inventory/items', {
      game: 'pokemon', name: 'Sample Slab Alpha', quantity: 1, status: 'in_stock',
      grading_company: 'PSA', grade: 10, cert_number: 'TESTCERT01',
    });
    const art = await post('/api/inventory/items', {
      game: 'pokemon', name: 'Sample Art Card', quantity: 1, status: 'in_stock',
    });
    slabItem = slab.json.id; artItem = art.json.id;
    assert.ok(slabItem && artItem, 'fixture stock was not created: ' + slab.text + ' | ' + art.text);
  });

  it('offers only stock the SPEC can take — the slab slot wants a cert, the art slot does not', async () => {
    const slab = await get('/api/runs/DEV-E1/candidates?slot=slab');
    assert.equal(slab.status, 200);
    const ids = slab.json.candidates.map((c) => c.id);
    assert.ok(ids.includes(slabItem), 'the certified slab is a candidate for the slab slot');
    assert.ok(!ids.includes(artItem), 'the uncertified art card is not — requires_cert is a spec flag, not a slot name');

    const art = await get('/api/runs/DEV-E1/candidates?slot=art');
    assert.ok(art.json.candidates.map((c) => c.id).includes(artItem));
  });

  it('names the slots it does have when asked for one it does not', async () => {
    const r = await get('/api/runs/DEV-E1/candidates?slot=booster_box');
    assert.equal(r.status, 404);
    assert.deepEqual(r.json.slots, ['slab', 'packs', 'art']);
  });

  let reservationId;
  it('holds stock for the run before any bundle is chosen', async () => {
    const r = await post('/api/runs/DEV-E1/hold', { kind: 'inventory', item_id: slabItem });
    assert.equal(r.status, 201);
    reservationId = r.json.id;

    const pool = await get('/api/runs/DEV-E1/pool');
    assert.equal(pool.json.pool.length, 1);
    assert.equal(pool.json.pool[0].cert_number, 'TESTCERT01');
  });

  // Proven through the INVENTORY API rather than a listing publish. The eBay and Shopify paths refuse
  // for want of credentials in this environment (boot-server blanks every one of them, deliberately)
  // long before they reach the reservation, so asserting on them would pass for the wrong reason.
  // Marking a card sold needs no network and is the same guard on the same ledger.
  it('a pool hold already blocks the item everywhere else, before it has a bundle', async () => {
    const sold = await req('PATCH', `/api/inventory/items/${slabItem}`, { status: 'sold' });
    assert.equal(sold.status, 409);
    assert.equal(sold.json.code, 'reserved_for_run');
    assert.match(sold.json.error, /reserved for run DEV-E1/);

    const gone = await req('DELETE', `/api/inventory/items/${slabItem}`);
    assert.equal(gone.status, 409, 'nor can it be deleted out from under the run');
  });

  it('an unrelated edit to a reserved row is still fine — only the destructive shapes are guarded', async () => {
    const r = await req('PATCH', `/api/inventory/items/${slabItem}`, { notes: 'typo fixed' });
    assert.equal(r.status, 200);
  });

  it('?force=1 is the way past, and it leaves a record', async () => {
    const r = await req('PATCH', `/api/inventory/items/${slabItem}?force=1`, { status: 'sold' });
    assert.equal(r.status, 200);
    const back = await req('PATCH', `/api/inventory/items/${slabItem}`, { status: 'in_stock' });
    assert.equal(back.status, 200, 'putting it back is not a destructive shape');
  });

  it('refuses to hold the same physical object twice', async () => {
    const r = await post('/api/runs/DEV-E1/hold', { kind: 'inventory', item_id: slabItem });
    assert.equal(r.status, 409);
  });

  it('promotes the hold onto a numbered bundle — an UPDATE, never a second row', async () => {
    const r = await post(`/api/runs/reservations/${reservationId}/assign`, { bundle_no: 2, slot: 'slab' });
    assert.equal(r.status, 200);
    assert.equal(r.json.bundle, 'DEV-E1-002');

    const run = await get('/api/runs/DEV-E1');
    assert.deepEqual(run.json.fill[1].slots.slab, { want: 1, have: 1, complete: true });
    assert.deepEqual(run.json.fill[0].slots.slab, { want: 1, have: 0, complete: false });
    const pool = await get('/api/runs/DEV-E1/pool');
    assert.equal(pool.json.pool.length, 0, 'it left the pool rather than being duplicated into a slot');
  });

  it('refuses a slot whose kind does not match the stock', async () => {
    const hold = await post('/api/runs/DEV-E1/hold', { kind: 'inventory', item_id: artItem });
    const r = await post(`/api/runs/reservations/${hold.json.id}/assign`, { bundle_no: 1, slot: 'packs' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /takes sealed stock/);
  });

  it('releasing puts the item back on sale', async () => {
    const hold = await post('/api/runs/DEV-E1/hold', { kind: 'inventory', item_id: slabItem });
    assert.equal(hold.status, 409, 'still held from the assignment above');
    const held = await get('/api/runs/DEV-E1/candidates?slot=slab');
    const row = held.json.candidates.find((c) => c.id === slabItem);
    assert.equal(row.available, 0);
    assert.equal(row.reserved_by.bundle, 'DEV-E1-002');

    const r = await post(`/api/runs/reservations/${row.reserved_by.reservation_id}/release`, { reason: 'test' });
    assert.equal(r.status, 200);
    const after = await get('/api/runs/DEV-E1/candidates?slot=slab');
    assert.equal(after.json.candidates.find((c) => c.id === slabItem).available, 1);
    const sold = await req('PATCH', `/api/inventory/items/${slabItem}`, { status: 'sold' });
    assert.equal(sold.status, 200, 'a released item is disposable again');
    await req('PATCH', `/api/inventory/items/${slabItem}`, { status: 'in_stock' });
  });
});

// THE BULK ROUTES, driven for real. The single-item guards were proven above; these are the ones an
// audit found unguarded AFTER the seven-call-site work was reported complete. A batch delete cascades
// over every in_stock row, and a reservation never changes an item's status — reservation is
// orthogonal to lifecycle by design — so reserved rows sat squarely inside that WHERE clause.
describe('a batch cannot take reserved stock with it', () => {
  let batchId, batchItem;

  before(async () => {
    const made = await post('/api/inventory/batches', {
      batch: { game: 'pokemon', source: 'manual', set_name: 'Test Batch' }, rows: [],
    });
    batchId = made.json?.batch_id ?? made.json?.id;
    assert.ok(batchId, 'no batch: ' + made.text);
    const item = await post('/api/inventory/items', {
      game: 'pokemon', name: 'Batched Slab', quantity: 1, status: 'in_stock',
      grading_company: 'PSA', grade: 10, cert_number: 'TESTCERT-BATCH', batch_id: batchId,
    });
    batchItem = item.json?.id;
    assert.ok(batchItem, 'no batched item: ' + item.text);
    const held = await post('/api/runs/hold', { kind: 'inventory', item_id: batchItem });
    assert.equal(held.status, 201, held.text);
  });

  it('refuses to delete the batch WITH its items, and names what it is protecting', async () => {
    const r = await req('DELETE', `/api/inventory/batches/${batchId}?items=1`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'reserved_for_run');
    assert.equal(r.json.blocked.length, 1);
    assert.equal(r.json.blocked[0].item_id, batchItem);

    const still = await get(`/api/inventory/items/${batchItem}`);
    assert.equal(still.status, 200, 'the row must survive a refused delete');
  });

  it('still lets the batch itself go — only ?items=1 is destructive', async () => {
    const r = await req('DELETE', `/api/inventory/batches/${batchId}`);
    assert.equal(r.status, 200);
    assert.equal((await get(`/api/inventory/items/${batchItem}`)).status, 200,
      'a bare batch delete unlinks rather than deletes — that was always true and must stay true');
  });
});

// The sealed twin. Sealed is normally the ONE case where a run hold shrinks the sellable quantity
// instead of blocking — but there is no smaller version of deleting the row the run draws from.
describe('sealed stock a run is drawing from cannot be deleted', () => {
  let sealedItem;

  before(async () => {
    const made = await post('/api/sealed/items', {
      game: 'pokemon', product_type: 'booster_pack', name: 'Test Boosters',
      quantity: 40, status: 'in_stock',
    });
    sealedItem = made.json?.id;
    assert.ok(sealedItem, 'no sealed item: ' + made.text);
    const held = await post('/api/runs/hold', { kind: 'sealed', item_id: sealedItem, qty: 12 });
    assert.equal(held.status, 201, held.text);
  });

  it('refuses the delete and says how many units are spoken for', async () => {
    const r = await req('DELETE', `/api/sealed/items/${sealedItem}`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'reserved_for_run');
    assert.equal(r.json.units_held, 12);
  });

  it('but LISTING the pool is still fine — it sells what the run did not take', async () => {
    // The asymmetry that makes sealed different, asserted rather than described: a shared pool stays
    // sellable, just for fewer units.
    const r = await get('/api/runs/DEV-E1/candidates?slot=packs');
    const row = r.json.candidates.find((c) => c.id === sealedItem);
    assert.equal(row.on_hand, 40);
    assert.equal(row.reserved_units, 12);
    assert.equal(row.available, 28);
  });

  it('?force=1 gets past it, because the physical world occasionally wins', async () => {
    const r = await req('DELETE', `/api/sealed/items/${sealedItem}?force=1`);
    assert.equal(r.status, 200);
  });
});
describe('the manifest is the one gated route', () => {
  it('refuses without a bearer token', async () => {
    const r = await get('/api/runs/DEV-E1/manifest');
    // 503 when DIAG_TOKEN is unset in this environment, 401 when it is set but nothing was supplied.
    // Either way the pre-sale answer sheet did not come back, which is the whole assertion.
    assert.ok([401, 503].includes(r.status), 'manifest answered ' + r.status);
    assert.equal(r.json.code, 'manifest_gated');
    assert.ok(!r.text.includes('TESTCERT01'), 'a refusal must not carry the contents it refused');
  });

  it('an invalid token is refused too', async () => {
    const r = await get('/api/runs/DEV-E1/manifest?token=not-the-token');
    assert.ok([401, 403, 503].includes(r.status));
  });

  it('but the run SHAPE stays open — counts leak nothing about which bundle holds what', async () => {
    const r = await get('/api/runs/DEV-E1');
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('TESTCERT01'));
  });
});

describe('the module reports itself', () => {
  it('/api/runs/config ships disarmed', async () => {
    const r = await get('/api/runs/config');
    assert.equal(r.status, 200);
    assert.equal(r.json.publish.enabled, false);
    assert.equal(r.json.public.no_prices, true);
    assert.equal(r.json.public.publish_contents_before_close, false);
  });

  it('/api/status lists the plugin and what dev runs are sitting on', async () => {
    const r = await get('/api/status');
    assert.equal(r.status, 200);
    assert.ok(JSON.stringify(r.json.plugins).includes('runs'), 'the runs plugin is not registered in vite.config.js');
    const s = r.json.subsystems.runs;
    assert.ok(s && !s.error, 'runs subsystem: ' + JSON.stringify(s));
    assert.equal(s.publish_enabled, false);
    assert.equal(s.by_status.draft, 1);
    // The number this block exists for. A dev rehearsal holds REAL stock and blocks real listings, so
    // silently locked inventory is the failure mode of rehearsing against the live database.
    assert.equal(typeof s.dev_hold_units, 'number');
    assert.ok(s.dev_holds.every((h) => h.run.startsWith('DEV-')));
  });

  it('/api/runs/holdings agrees with it', async () => {
    const r = await get('/api/runs/holdings');
    const st = await get('/api/status');
    assert.equal(r.json.units, st.json.subsystems.runs.dev_hold_units);
  });
});

// The intake page imports the rarity vocabulary over HTTP rather than keeping a copy, so whether it
// works at all depends on the dev server serving that module to a browser. A broken specifier here is
// invisible to every other test in the suite — the page's inline script parses fine, the unit tests
// pass, and the only symptom is a blank grid on the operator's screen.
describe('the intake page and the module it imports', () => {
  it('serves the page, and the dev server hands its module to the browser', async () => {
    const page = await get('/runs-intake.html');
    assert.equal(page.status, 200);
    // Vite extracts an inline module into its own request, so the import is NOT in the served HTML.
    // Following the proxy is the only way to assert on what a browser actually executes; asserting
    // on the HTML would have quietly checked nothing.
    const proxy = /src="([^"]*html-proxy[^"]*)"/.exec(page.text);
    assert.ok(proxy, 'the page has no module script — its whole grid is that script');
    const js = await get(proxy[1]);
    assert.equal(js.status, 200);
    assert.match(js.text, /from '\/lib\/runs-rarity\.mjs'/,
      'the page must import the vocabulary rather than keeping its own copy');
  });

  it('serves the rarity module, with its dependency rewritten to something a browser can fetch', async () => {
    const r = await get('/lib/runs-rarity.mjs');
    assert.equal(r.status, 200);
    assert.match(r.text, /rarityClass/);
    // The source says './runs-canonical.mjs'; what reaches the browser must be an absolute path, or
    // the import 404s at load and the page renders an empty grid with no error the operator can see.
    assert.match(r.text, /from "\/lib\/runs-canonical\.mjs"/);
    assert.equal((await get('/lib/runs-canonical.mjs')).status, 200);
  });

  it('neither module imports a node builtin, which would break the moment a browser loaded it', async () => {
    for (const f of ['/lib/runs-rarity.mjs', '/lib/runs-canonical.mjs']) {
      const t = (await get(f)).text;
      assert.ok(!/from ['"]node:/.test(t), f + ' imports a node builtin');
      assert.ok(!/require\(['"]node:/.test(t), f + ' requires a node builtin');
    }
  });

  it('/api/runs/vocab serves the closed lists the page renders', async () => {
    const r = await get('/api/runs/vocab');
    assert.equal(r.status, 200);
    assert.ok(r.json.games.includes('pokemon'));
    assert.ok(r.json.sealed_types_by_game.pokemon.includes('booster_pack'));
    // The published hash, pinned here too: a table edit moves every future header digest, and this
    // is the copy an operator's browser would be shown.
    assert.equal(r.json.rarity.version, 'rarity-v1');
    assert.equal(r.json.rarity.hash, 'ca971d5d15666d83cfeb4b451dc3bd99d6639e7eeee70c23002c39a7d28d83e0');
  });

  it('/api/runs/rarity answers a probe, and says null rather than nothing for an unmapped string', async () => {
    assert.equal((await get('/api/runs/rarity?q=Special%20Illustration%20Rare')).json.class, 'SPECIAL_ART_RARE');
    const miss = await get('/api/runs/rarity?q=Double%20Rare');
    assert.equal(miss.status, 200);
    assert.ok('class' in miss.json, 'the key must be present — absent would read as "not asked"');
    assert.equal(miss.json.class, null);
  });
});

// The settings surface is the arming switch, so its refusals are load-bearing rather than cosmetic:
// this is the one place a human can change what the module is allowed to do, and two of the values in
// the file are promises made to buyers rather than preferences.
describe('the settings gate', () => {
  it('lists runs as an editable setting', async () => {
    const r = await get('/api/settings');
    assert.ok(r.json.files.runs, 'runs is not in the settings registry');
    assert.equal(r.json.files.runs.editable, true);
  });

  it('refuses a save that would let a price reach a customer', async () => {
    const cur = (await get('/api/settings/runs')).json.content;
    const r = await req('PUT', '/api/settings/runs', { ...cur, public: { ...cur.public, no_prices: false } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /no_prices/);
  });

  it('refuses a save that would publish contents before a run closes', async () => {
    const cur = (await get('/api/settings/runs')).json.content;
    const r = await req('PUT', '/api/settings/runs', { ...cur, public: { ...cur.public, publish_contents_before_close: true } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /publish_contents_before_close/);
  });

  it('refuses arming the live store against a stub anchor', async () => {
    const cur = (await get('/api/settings/runs')).json.content;
    const r = await req('PUT', '/api/settings/runs', {
      ...cur, publish: { enabled: true, store: 'live' }, anchor: { ...cur.anchor, mode: 'stub' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /stub anchor/);
  });

  it('takes a legitimate change and the module reads it back without a restart', async () => {
    const cur = (await get('/api/settings/runs')).json.content;
    const r = await req('PUT', '/api/settings/runs', { ...cur, anchor: { ...cur.anchor, upgrade_interval_min: 30 } });
    assert.equal(r.status, 200);
    // loadRunsConfig() is called per request precisely so an arming change needs no restart.
    assert.equal((await get('/api/runs/config')).json.anchor.upgrade_interval_min, 30);
    await req('PUT', '/api/settings/runs', cur);
  });
});

describe('abandoning a rehearsal', () => {
  it('releases everything and marks the run dead', async () => {
    const r = await post('/api/runs/DEV-E1/abandon', { reason: 'end of test' });
    assert.equal(r.status, 200);
    const run = await get('/api/runs/DEV-E1');
    assert.equal(run.json.run.status, 'abandoned');
    const sold = await req('PATCH', `/api/inventory/items/${artItem}`, { status: 'sold' });
    assert.equal(sold.status, 200, 'abandon must free the stock, not just mark the run dead');
  });
});
