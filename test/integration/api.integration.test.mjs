// test/integration/api.integration.test.mjs — boots the real dev server (all plugins)
// against temp DBs and exercises the local API surface. GET-only on purpose: tracker
// watchlist writes fire a self-fetching collector pass (live network), which the
// default-adjacent integration run must not do.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';

let srv;
before(async () => { srv = await bootServer(); }, { timeout: 60_000 });
after(async () => { await srv?.close(); });

const get = async (p) => {
  const r = await fetch(srv.base + p);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
};
const post = async (p, body) => {
  const r = await fetch(srv.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
};
const patch = async (p, body) => {
  const r = await fetch(srv.base + p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
};

describe('server boots with isolated stores', () => {
  it('created the temp DBs, not the real ones', () => {
    assert.ok(srv.dbFileExists(srv.trackerDb), 'temp tracker.db missing');
    assert.ok(srv.dbFileExists(srv.repricerDb), 'temp repricer.db missing');
  });
  it('tracker watchlist starts empty (proof we are not on the real DB)', async () => {
    const { status, json } = await get('/api/tracker/watchlist');
    assert.equal(status, 200);
    assert.deepEqual(json.cards, []);
  });
});

describe('existing API surface', () => {
  it('GET /api/tracker/config → thresholds + cadence + scrydex flag', async () => {
    const { status, json } = await get('/api/tracker/config');
    assert.equal(status, 200);
    assert.ok(json.thresholds && typeof json.cadence_hours === 'number');
    assert.equal(typeof json.scrydex_enabled, 'boolean');
  });
  it('GET /api/inventory/summary → per-currency totals shape', async () => {
    const { status, json } = await get('/api/inventory/summary');
    assert.equal(status, 200);
    assert.ok(json && typeof json === 'object');
  });
  it('GET /api/cert/providers → the company registry', async () => {
    const { status, json } = await get('/api/cert/providers');
    assert.equal(status, 200);
    const companies = json.companies || json;
    assert.ok(Array.isArray(companies) && companies.length >= 10);
  });
  it('GET /api/print → printer config, never a crash when unconfigured (GR7)', async () => {
    const { status, json } = await get('/api/print');
    assert.equal(status, 200);
    assert.equal(typeof json.enabled, 'boolean');
  });
  it('GET /api/repricer/config → guardrails', async () => {
    const { status, json } = await get('/api/repricer/config');
    assert.equal(status, 200);
    assert.ok(json.guardrails || json.config || json.cadence_hours || typeof json === 'object');
  });
  it('GET /api/repricer/oauth/status → user-token state', async () => {
    const { status, json } = await get('/api/repricer/oauth/status');
    assert.equal(status, 200);
    assert.ok(json && typeof json === 'object');
  });
});

describe('/api/status', () => {
  it('aggregate status: version, keys, sources, data, dbs, subsystems', async () => {
    const { status, json } = await get('/api/status');
    assert.equal(status, 200);
    for (const k of ['version', 'keys', 'sources', 'data', 'dbs', 'subsystems']) assert.ok(json[k], `missing ${k}`);
    assert.ok(json.version.node.startsWith('v'));
    assert.equal(typeof json.keys.riftbound.SCRYDEX_API_KEY, 'boolean');
    assert.ok(json.data.riftbound.count >= 900, 'riftbound catalog count');
    assert.equal(json.dbs.tracker.watchlist, 0, 'temp DB → empty watchlist');
    assert.equal(typeof json.subsystems.printer.enabled, 'boolean');
  });
  it('NEVER leaks an env value in the response body (GR2)', async () => {
    const { text } = await get('/api/status');
    // any real .env value long enough to be a secret must not appear serialized
    for (const [k, v] of Object.entries(process.env)) {
      if (!/(KEY|TOKEN|SECRET|CERT_ID|APP_ID)/.test(k)) continue;
      if (!v || v.length < 8) continue;
      assert.ok(!text.includes(v), `response contains value of ${k}`);
    }
  });
  it('unknown probe source → 404 with the allowlist', async () => {
    const r = await fetch(srv.base + '/api/status/probe/nope', { method: 'POST' });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.ok(Array.isArray(j.sources));
  });
});

describe('/api/settings', () => {
  it('GET lists all config files with editability flags', async () => {
    const { status, json } = await get('/api/settings');
    assert.equal(status, 200);
    assert.equal(json.files.tracker.editable, true);
    assert.equal(json.files.grading.editable, false);
    assert.ok(json.files['bulk-pricing'].content.tiers, 'bulk tiers content present');
  });
  it('PUT round-trip: valid tracker config is saved and applied, then restored', async () => {
    // NOTE: settings live in the real data/*.config.json (only DBs are temp-redirected),
    // so the original is restored in a finally block no matter what fails in between.
    const put = (body) => fetch(srv.base + '/api/settings/tracker', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const orig = (await get('/api/settings/tracker')).json.content;
    const edited = JSON.parse(JSON.stringify(orig));
    edited.cadence_hours = orig.cadence_hours === 23 ? 24 : 23;
    try {
      const r = await put(edited);
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.saved, true);
      assert.match(j.applied, /collector restarted/);
      assert.equal((await get('/api/settings/tracker')).json.content.cadence_hours, edited.cadence_hours);
    } finally {
      const restore = await put(orig);
      assert.equal(restore.status, 200);
      assert.equal((await get('/api/settings/tracker')).json.content.cadence_hours, orig.cadence_hours);
    }
  });
  it('PUT invalid config → 400, file untouched', async () => {
    const before = (await get('/api/settings/tracker')).json.content;
    const r = await fetch(srv.base + '/api/settings/tracker', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...before, cadence_hours: 0 }),
    });
    assert.equal(r.status, 400);
    assert.deepEqual((await get('/api/settings/tracker')).json.content, before);
  });
  it('PUT never_decrease=false → 400 (repricer hard invariant)', async () => {
    const before = (await get('/api/settings/repricer')).json.content;
    const evil = JSON.parse(JSON.stringify(before));
    evil.guardrails.never_decrease = false;
    const r = await fetch(srv.base + '/api/settings/repricer', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(evil),
    });
    assert.equal(r.status, 400);
    assert.equal((await get('/api/settings/repricer')).json.content.guardrails.never_decrease, true);
  });
  it('PUT a read-only file → 403', async () => {
    const r = await fetch(srv.base + '/api/settings/grading', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 403);
  });
});

describe('inventory / sealed write bug-fixes (#3/#6/#7/#8/#9)', () => {
  it('#6 accepts JSON booleans for INTEGER-bool columns instead of 500ing', async () => {
    // image_url is supplied so the create skips the (network) image resolve — offline + deterministic.
    const r = await post('/api/inventory/items', { game: 'pokemon', name: 'Bool Test', image_url: 'x', image_manual: true, value_manual: true });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.sku, 'created with a SKU');
  });

  it('#7 value-manual on a missing id → 404 (not a 500)', async () => {
    const r = await post('/api/inventory/items/999999/value-manual', { value_cents: 500 });
    assert.equal(r.status, 404);
  });

  it('#8 a failed insert rolls back the SKU counter — no gap', async () => {
    const a = await post('/api/inventory/items', { game: 'mtg', name: 'Seq A', image_url: 'x' });
    assert.equal(a.status, 201, a.text);
    // object-valued `notes` is unbindable in node:sqlite → insertRow throws → ROLLBACK → 500.
    const bad = await post('/api/inventory/items', { game: 'mtg', name: 'Seq Bad', image_url: 'x', notes: { unbindable: true } });
    assert.equal(bad.status, 500, 'the bad insert fails');
    const c = await post('/api/inventory/items', { game: 'mtg', name: 'Seq C', image_url: 'x' });
    assert.equal(c.status, 201, c.text);
    const na = +a.json.sku.split('-').pop(), nc = +c.json.sku.split('-').pop();
    assert.equal(nc, na + 1, `SKUs must be consecutive (no gap): got ${a.json.sku} then ${c.json.sku}`);
  });

  it('#9 sealed invalid/cross-game product_type is normalised to "other"', async () => {
    const r = await post('/api/sealed/items', { game: 'pokemon', name: 'PTBugTest', product_type: 'not_a_real_type' });
    assert.equal(r.status, 201, r.text);
    const got = await get('/api/sealed/items?q=PTBugTest');
    assert.equal(got.json.items[0].product_type, 'other');
  });

  it('sealed multi-location placements sum into the item quantity + surface locations', async () => {
    const r = await post('/api/sealed/items', {
      game: 'pokemon', name: 'MultiLocBox', product_type: 'booster_box',
      placements: [{ location: 'Storage 1', quantity: 3 }, { location: 'Storage 2', quantity: 2 }],
    });
    assert.equal(r.status, 201, r.text);
    const got = await get('/api/sealed/items?q=MultiLocBox');
    const it = got.json.items[0];
    assert.equal(it.quantity, 5, 'quantity mirrors SUM(placements)');
    assert.equal(it.placements.length, 2);
    assert.equal(it.placements.reduce((s, p) => s + p.quantity, 0), 5);
    // both spots become reselectable in the location combobox
    const locs = (await get('/api/sealed/locations')).json.locations;
    assert.ok(locs.includes('Storage 1') && locs.includes('Storage 2'), locs.join(','));
  });

  it('sealed PATCH placements re-mirrors quantity (and merges same-location rows)', async () => {
    const c = await post('/api/sealed/items', { game: 'pokemon', name: 'RelocBox', product_type: 'booster_box', placements: [{ location: 'A', quantity: 1 }] });
    assert.equal(c.status, 201, c.text);
    const id = c.json.id;
    const up = await patch('/api/sealed/items/' + id, { placements: [{ location: 'A', quantity: 2 }, { location: 'a', quantity: 2 }, { location: 'B', quantity: 1 }] });
    assert.equal(up.status, 200, up.text);
    const it = (await get('/api/sealed/items?q=RelocBox')).json.items[0];
    assert.equal(it.quantity, 5, 'A(2)+a(2)+B(1) => 5');
    assert.equal(it.placements.length, 2, 'case-insensitive A/a merged into one row');
  });

  it('sealed GET /items?location= filters by ANY placement spot (not just the primary)', async () => {
    const c = await post('/api/sealed/items', { game: 'pokemon', name: 'FilterLocBox', product_type: 'booster_box',
      placements: [{ location: 'Vault North', quantity: 1 }, { location: 'Vault South', quantity: 4 }] });
    assert.equal(c.status, 201, c.text);
    const byPrimary = await get('/api/sealed/items?location=' + encodeURIComponent('Vault North'));
    const bySecondary = await get('/api/sealed/items?location=' + encodeURIComponent('vault south'));   // case-insensitive, non-primary
    const byNone = await get('/api/sealed/items?location=' + encodeURIComponent('Nowhere Land'));
    assert.ok(byPrimary.json.items.some((x) => x.name === 'FilterLocBox'), 'found by primary spot');
    assert.ok(bySecondary.json.items.some((x) => x.name === 'FilterLocBox'), 'found by secondary spot (case-insensitive)');
    assert.ok(!byNone.json.items.some((x) => x.name === 'FilterLocBox'), 'not returned for an unrelated location');
  });

  it('sealed GET /search fuzzy-matches the permanent barcode cache by name, typo, or partial UPC', async () => {
    await post('/api/sealed/barcodes', { upc: '820650999001', game: 'pokemon',
      name: 'Prismatic Evolutions Elite Trainer Box', set_name: 'Pokemon Prismatic Evolutions', product_type: 'elite_trainer_box' });
    const byName = await get('/api/sealed/search?q=' + encodeURIComponent('prismatic evolutions'));
    const byTypo = await get('/api/sealed/search?q=' + encodeURIComponent('prizmatic evolutons'));   // deliberate typos
    const byUpc = await get('/api/sealed/search?q=999001');                                          // trailing UPC digits
    const miss = await get('/api/sealed/search?q=' + encodeURIComponent('lego millennium falcon'));
    assert.ok(byName.json.results.some((r) => r.upc === '820650999001'), 'found by name');
    assert.ok(byTypo.json.results.some((r) => r.upc === '820650999001'), 'found despite typos (fuzzy)');
    assert.ok(byUpc.json.results.some((r) => r.upc === '820650999001'), 'found by partial UPC');
    assert.ok(!miss.json.results.some((r) => r.upc === '820650999001'), 'unrelated query does not match');
  });

  it('sealed accepts every stockable game (incl. One Piece) plus a generic "other"', async () => {
    for (const game of ['swu', 'lorcana', 'onepiece', 'other']) {
      const r = await post('/api/sealed/items', { game, name: 'AllGames ' + game, product_type: 'booster_box' });
      assert.equal(r.status, 201, `${game}: ${r.text}`);
      assert.ok(r.json.sku, `${game} got a SKU`);
    }
    const op = await get('/api/sealed/items?game=onepiece');
    assert.ok(op.json.items.some((x) => x.name === 'AllGames onepiece'), 'One Piece item is filterable by game');
    const bad = await post('/api/sealed/items', { game: 'notagame', name: 'Nope' });
    assert.equal(bad.status, 400, 'an unknown game is still rejected');
  });

  it('sealed /locations is natural-sorted (Crate 1,2,10 — not 1,10,2)', async () => {
    for (const n of ['10', '2', '1']) {
      await post('/api/sealed/items', { game: 'pokemon', name: 'NatSortBox ' + n, product_type: 'other', placements: [{ location: 'ZZSort Crate ' + n, quantity: 1 }] });
    }
    const locs = (await get('/api/sealed/locations')).json.locations.filter((l) => l.startsWith('ZZSort Crate'));
    assert.deepEqual(locs, ['ZZSort Crate 1', 'ZZSort Crate 2', 'ZZSort Crate 10']);
  });

  it('sealed /summary counts VALUE as unit value × quantity', async () => {
    const before = (await get('/api/sealed/summary')).json.valueByCurrency.AUD || 0;
    const r = await post('/api/sealed/items', { game: 'pokemon', name: 'QtyValBox', product_type: 'booster_box',
      value_cents: 10000, value_currency: 'AUD', value_manual: true, placements: [{ location: 'X', quantity: 3 }] });
    assert.equal(r.status, 201, r.text);
    const after = (await get('/api/sealed/summary')).json.valueByCurrency.AUD || 0;
    assert.equal(after - before, 30000, 'A$100 × 3 units = A$300 added to the portfolio value');
  });

  it('sealed value refresh: scheduler state + guards (no network in these paths)', async () => {
    const st = await get('/api/sealed/refresh-state');
    assert.equal(st.status, 200);
    assert.equal(typeof st.json.enabled, 'boolean');
    assert.equal(typeof st.json.interval_hours, 'number');
    assert.equal(typeof st.json.running, 'boolean');
    // a manual-valued item short-circuits before any eBay/PriceCharting fetch
    const c = await post('/api/sealed/items', { game: 'pokemon', name: 'ManualValBox', product_type: 'booster_box', value_cents: 12345, value_currency: 'AUD', value_manual: true });
    assert.equal(c.status, 201, c.text);
    const rv = await post('/api/sealed/items/' + c.json.id + '/refresh-value', {});
    assert.equal(rv.status, 200);
    assert.equal(rv.json.updated, false);
    assert.equal(rv.json.reason, 'manual_override');
    const miss = await post('/api/sealed/items/99999999/refresh-value', {});
    assert.equal(miss.status, 404);
  });

  it('graded inventory accepts One Piece (stockable game) with an OP SKU', async () => {
    const r = await post('/api/inventory/items', { game: 'onepiece', name: 'Monkey D. Luffy OP01-120', grading_company: 'PSA', grade: 10, image_url: 'x' });
    assert.equal(r.status, 201, r.text);
    assert.match(r.json.sku, /-OP-/, 'One Piece graded SKU carries the OP game code');
    const bad = await post('/api/inventory/items', { game: 'notagame', name: 'Nope', image_url: 'x' });
    assert.equal(bad.status, 400, 'an unknown game is still rejected by graded inventory');
  });

  it('sealed locations: create → cards → upload photo → rename propagates → delete', async () => {
    // a location record + a piece of stock that uses it
    const loc = await post('/api/sealed/locations', { name: 'Vault Alpha', notes: 'top shelf, left' });
    assert.equal(loc.status, 201, loc.text);
    await post('/api/sealed/items', { game: 'pokemon', name: 'LocStockBox', product_type: 'booster_box', placements: [{ location: 'Vault Alpha', quantity: 4 }] });
    // the card carries notes + usage counts
    let cards = (await get('/api/sealed/locations/cards')).json.locations;
    let card = cards.find((c) => c.name === 'Vault Alpha');
    assert.ok(card && card.has_record && card.notes === 'top shelf, left', 'record + notes present');
    assert.equal(card.unit_count, 4, 'usage counted from placements');
    // upload a 1x1 png as a data URL
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const up = await post('/api/sealed/locations/' + loc.json.id + '/photos', { data: png, thumb: png, mime: 'image/png' });
    assert.equal(up.status, 201, up.text);
    const photos = (await get('/api/sealed/locations/' + loc.json.id + '/photos')).json.photos;
    assert.equal(photos.length, 1, 'photo stored + listed');
    // rename propagates to the placement's location string
    const rn = await patch('/api/sealed/locations/' + loc.json.id, { name: 'Vault Omega' });
    assert.equal(rn.status, 200, rn.text);
    const moved = (await get('/api/sealed/items?location=' + encodeURIComponent('Vault Omega'))).json.items;
    assert.ok(moved.some((x) => x.name === 'LocStockBox'), 'stock followed the rename');
    // delete the record removes its photos (cascade) but leaves the stock's location string
    const del = await fetch(srv.base + '/api/sealed/locations/' + loc.json.id, { method: 'DELETE' });
    assert.equal(del.status, 200);
    cards = (await get('/api/sealed/locations/cards')).json.locations;
    card = cards.find((c) => c.name === 'Vault Omega');
    assert.ok(card && !card.has_record && card.unit_count === 4, 'spot still listed from usage, minus its record');
  });

  it('sealed location photos: captions persist + drag-reorder is saved', async () => {
    const loc = await post('/api/sealed/locations', { name: 'Photo Order Test' });
    const id = loc.json.id;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const ids = [];
    for (const cap of ['first', 'second', 'third']) {
      const up = await post('/api/sealed/locations/' + id + '/photos', { data: png, thumb: png, caption: cap });
      assert.equal(up.status, 201, up.text);
      ids.push(up.json.id);
    }
    await patch('/api/sealed/locations/photos/' + ids[0], { caption: 'renamed first' });   // edit a caption
    const rev = [...ids].reverse();
    const ro = await post('/api/sealed/locations/' + id + '/photos/reorder', { order: rev });   // drag-reorder
    assert.equal(ro.status, 200, ro.text);
    const photos = (await get('/api/sealed/locations/' + id + '/photos')).json.photos;
    assert.deepEqual(photos.map((p) => p.id), rev, 'photos return in the reordered sequence');
    assert.equal(photos.find((p) => p.id === ids[0]).caption, 'renamed first', 'edited caption persisted');
    const emptyOrder = await post('/api/sealed/locations/' + id + '/photos/reorder', { order: [] });
    assert.equal(emptyOrder.status, 400, 'empty order is rejected');
  });

  it('sealed PATCH refuses to silently destroy stock (empty placements / bare-scalar collapse) → 400', async () => {
    const c = await post('/api/sealed/items', { game: 'pokemon', name: 'GuardBox', product_type: 'booster_box',
      placements: [{ location: 'Box A', quantity: 10 }, { location: 'Box B', quantity: 20 }] });
    assert.equal(c.status, 201, c.text);
    const id = c.json.id;
    const empty = await patch('/api/sealed/items/' + id, { placements: [] });                 // would wipe to 1 unit
    assert.equal(empty.status, 400, empty.text);
    const scalar = await patch('/api/sealed/items/' + id, { location: 'Box Z' });              // would collapse the split
    assert.equal(scalar.status, 400, scalar.text);
    const it = (await get('/api/sealed/items?q=GuardBox')).json.items[0];
    assert.equal(it.quantity, 30, 'stock is untouched after both rejected PATCHes');
    assert.equal(it.placements.length, 2, 'both locations survive');
  });

  it('#3 raw re-import across batches recounts the SOURCE batch, not just the target', async () => {
    const card = { game: 'pokemon', identity_key: 'bugtest-3', name: 'Recount Card', variant: 'Base', quantity: 1 };
    const a = await post('/api/inventory/batches', { batch: { game: 'pokemon', set_name: 'Recount A' }, rows: [card] });
    assert.equal(a.status, 201, a.text);
    const b = await post('/api/inventory/batches', { batch: { game: 'pokemon', set_name: 'Recount B' }, rows: [card] });
    assert.equal(b.status, 201, b.text);
    const batches = (await get('/api/inventory/batches')).json.batches;
    const A = batches.find((x) => x.id === a.json.batch_id);
    const B = batches.find((x) => x.id === b.json.batch_id);
    assert.equal(A.item_count, 0, 'source batch A no longer counts the moved card');
    assert.equal(B.item_count, 1, 'target batch B counts it');
  });
});

describe('/api/bulk (GET-safe, offline)', () => {
  it('GET /config → pricing + pinned eBay categories', async () => {
    const { status, json } = await get('/api/bulk/config');
    assert.equal(status, 200);
    assert.ok(json.pricing && typeof json.pricing === 'object');
    assert.ok(json.ebay && typeof json.ebay === 'object');
  });
  it('GET /sets?game=notagame → 400 before any network', async () => {
    const { status, json } = await get('/api/bulk/sets?game=notagame');
    assert.equal(status, 400);
    assert.match(json.error, /game must be one of/);
  });
  it('GET /export/preview with no items → 404', async () => {
    const { status, json } = await get('/api/bulk/export/preview');
    assert.equal(status, 404);
    assert.match(json.error, /no items/);
  });
  it('unknown route → 404', async () => {
    assert.equal((await get('/api/bulk/nope')).status, 404);
  });
});

describe('/api/catalog (GET-safe, offline)', () => {
  it('GET /seed → editable seed overlay', async () => {
    const { status, json } = await get('/api/catalog/seed');
    assert.equal(status, 200);
    assert.equal(typeof json.seed, 'object');
    assert.equal(json.path, 'data/pokemon-intl-seed.json');
  });
  it('GET /cards with no params → 400', async () => {
    const { status, json } = await get('/api/catalog/cards');
    assert.equal(status, 400);
    assert.match(json.error, /lang and set required/);
  });
  it('unknown route → 404', async () => {
    assert.equal((await get('/api/catalog/nope')).status, 404);
  });
});

describe('/api/sealed (GET-safe, offline)', () => {
  it('GET /product-types → enum + per-game subsets', async () => {
    const { status, json } = await get('/api/sealed/product-types');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.types) && json.types.includes('booster_box'));
    assert.ok(json.by_game.pokemon.includes('elite_trainer_box'));
  });
  it('GET /summary → quantity-aware totals shape', async () => {
    const { status, json } = await get('/api/sealed/summary');
    assert.equal(status, 200);
    assert.equal(typeof json.counts.total, 'number');
    assert.equal(typeof json.units, 'number');
    assert.equal(typeof json.totalCostCents, 'number');
    for (const k of ['valueByCurrency', 'byGame', 'byType']) assert.ok(json[k] && typeof json[k] === 'object', k);
  });
  it('GET /locations → array', async () => {
    const { status, json } = await get('/api/sealed/locations');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.locations));
  });
  it('GET /export → items + batches bundle', async () => {
    const { status, json } = await get('/api/sealed/export');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.items) && Array.isArray(json.batches) && json.generated_at);
  });
  it('unknown route → 404', async () => {
    assert.equal((await get('/api/sealed/nope')).status, 404);
  });
});

describe('static pages served', () => {
  for (const page of ['/', '/tracker.html', '/inventory.html', '/shipping-label.html', '/sealed.html', '/locations.html', '/onepiece-listing-builder.html']) {
    it(`GET ${page}`, async () => {
      const { status, text } = await get(page);
      assert.equal(status, 200);
      assert.match(text, /<html|<!doctype/i);
    });
  }
});
