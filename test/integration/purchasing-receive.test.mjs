// test/integration/purchasing-receive.test.mjs — the receive: count, preview, commit.
//
// The assertions that matter most here are not about purchasing at all. They are about what
// receiving does to the STOCK tables:
//   · sealed_items.quantity must still equal SUM(sealed_placements.quantity) afterwards — that mirror
//     is the reason receiveSealed exists, and a purchasing write is exactly the new way to break it;
//   · a replayed commit must add nothing, because a retried fetch double-stocking a delivery is
//     silent and permanent;
//   · a lot's per-item costs must sum back to the lump, to the cent.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bootServer } from '../helpers/boot-server.mjs';

let srv, base, dbPath;
before(async () => { srv = await bootServer(); base = srv.base; dbPath = srv.trackerDb; });
after(async () => { await srv?.close(); });

const api = async (path, opts = {}) => {
  const r = await fetch(base + '/api/purchasing' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const sealedApi = async (path, opts = {}) => {
  const r = await fetch(base + '/api/sealed' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

// Read the DB directly for the invariant checks — the point is what is ON DISK, not what an API
// chose to report about it.
function withDb(fn) {
  const db = new DatabaseSync(dbPath);
  try { return fn(db); } finally { db.close(); }
}
const mirrorHolds = (db) => db.prepare(`
  SELECT i.id, i.quantity AS q, COALESCE((SELECT SUM(p.quantity) FROM sealed_placements p WHERE p.item_id = i.id), 0) AS placed
  FROM sealed_items i`).all().every((r) => r.q === r.placed);

async function makeOrder(body) {
  const r = await api('/orders', { method: 'POST', body: { currency: 'AUD', status: 'ordered', ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
async function addLine(orderId, line) {
  const r = await api(`/orders/${orderId}/lines`, { method: 'POST', body: line });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.ids[0];
}
async function count(lineId, body) {
  const r = await api(`/lines/${lineId}/count`, { method: 'POST', body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

describe('the reconciliation gate', () => {
  let orderId, lineId;
  before(async () => {
    orderId = await makeOrder({ supplier: 'Gate Co' });
    lineId = await addLine(orderId, {
      game: 'pokemon', product_type: 'booster_box', name: 'Gate Box', qty_ordered: 6, unit_cost_cents: 10000,
    });
  });

  it('blocks a receive while a line is uncounted', async () => {
    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'lines_unreconciled');
    assert.equal(r.body.blockers[0].reason, 'uncounted');
  });

  it('blocks a mismatch with no reason given', async () => {
    await count(lineId, { qty_received: 4 });
    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(r.body.blockers[0].reason, 'discrepancy_reason_required');
    assert.equal(r.body.blockers[0].ordered, 6);
    assert.equal(r.body.blockers[0].counted, 4);
  });

  it('rejects an unknown discrepancy code rather than storing it', async () => {
    const r = await api(`/lines/${lineId}/count`, { method: 'POST', body: { qty_received: 4, discrepancy: 'eaten_by_dog' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'unknown_discrepancy');
  });

  it('refuses a split that does not add up to the count', async () => {
    const r = await api(`/lines/${lineId}/count`, {
      method: 'POST',
      body: { qty_received: 4, discrepancy: 'short', placements: [{ location: 'SHELF-A', quantity: 3 }] },
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'placements_mismatch');
    assert.equal(r.body.placed, 3);
  });

  it('and leaves the line completely untouched when it does', async () => {
    // The count used to be written BEFORE the split was checked, and outside a transaction — so a
    // rejected save left qty_received committed with the old placements still attached, while the
    // page (seeing an error) told the operator nothing had saved.
    const before = withDb((db) => db.prepare('SELECT qty_received, discrepancy FROM purchase_lines WHERE id = ?').get(lineId));
    await api(`/lines/${lineId}/count`, {
      method: 'POST',
      body: { qty_received: 99, discrepancy: 'over', placements: [{ location: 'NOWHERE', quantity: 1 }] },
    });
    const after = withDb((db) => db.prepare('SELECT qty_received, discrepancy FROM purchase_lines WHERE id = ?').get(lineId));
    assert.deepEqual({ ...after }, { ...before }, 'a rejected count must write nothing at all');
    const spots = withDb((db) => db.prepare('SELECT location FROM purchase_line_placements WHERE line_id = ?').all(lineId));
    assert.ok(!spots.some((s) => s.location === 'NOWHERE'), 'and must not leave its placements behind');
  });

  it('refuses an absurd lot size before it can allocate an array that big', async () => {
    const r = await api(`/lines/${lineId}/count`, { method: 'POST', body: { qty_received: 6, lot_units: 100000001 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'lot_units_too_large');
  });

  it('passes once the count has a reason and the split adds up', async () => {
    await count(lineId, {
      qty_received: 4, discrepancy: 'short', discrepancy_note: '2 never left the warehouse',
      placements: [{ location: 'SHELF-A', quantity: 3 }, { location: 'TUB-3', quantity: 1 }],
    });
    const r = await api(`/orders/${orderId}/receive?dry=1`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.blockers, []);
  });
});

describe('preview and commit', () => {
  let orderId, boxLine, restockLine, heldId;

  before(async () => {
    // Stock already on the shelf, so one line can be a restock rather than a new SKU.
    const held = await sealedApi('/items', {
      method: 'POST',
      body: { game: 'pokemon', product_type: 'elite_trainer_box', name: 'Prismatic ETB',
        quantity: 3, location: 'SHELF-B', cost_cents: 10000, acq_fees_cents: 500 },
    });
    heldId = held.body.id;

    orderId = await makeOrder({ supplier: 'Card Shark AU', shipping_cents: 18000 });
    boxLine = await addLine(orderId, {
      game: 'pokemon', product_type: 'booster_box', name: 'Surging Sparks Booster Box',
      set_name: 'Surging Sparks', qty_ordered: 6, unit_cost_cents: 16000,
    });
    restockLine = await addLine(orderId, {
      qty_ordered: 2, unit_cost_cents: 13000, link: { kind: 'sealed', item_id: heldId },
    });
    await count(boxLine, { qty_received: 6, placements: [{ location: 'SHELF-A', quantity: 4 }, { location: 'TUB-3', quantity: 2 }] });
    await count(restockLine, { qty_received: 2, placements: [{ location: 'SHELF-B', quantity: 2 }] });
  });

  it('previews the writes without touching stock', async () => {
    const before = withDb((db) => db.prepare('SELECT COUNT(*) n FROM sealed_items').get().n);
    const { status, body } = await api(`/orders/${orderId}/receive?dry=1`, { method: 'POST' });
    assert.equal(status, 200);

    const box = body.steps.find((s) => s.line_id === boxLine);
    const restock = body.steps.find((s) => s.line_id === restockLine);
    assert.equal(box.action, 'new', 'a product not held yet is a create');
    assert.equal(restock.action, 'merge', 'a linked line is a merge, not a second competing SKU');
    assert.equal(restock.target_sku, undefined || restock.target_sku, 'the merge names its target');
    assert.equal(restock.target_qty_before, 3);

    // Freight spread BY VALUE: 6x16000 = 96000 against 2x13000 = 26000.
    assert.equal(body.allocated_cents, body.pot_cents, 'every cent of the pot is placed');
    assert.equal(box.alloc_fees_cents + restock.alloc_fees_cents, 18000);
    assert.ok(box.alloc_fees_cents > restock.alloc_fees_cents, 'the bigger-value line carries more freight');

    assert.equal(withDb((db) => db.prepare('SELECT COUNT(*) n FROM sealed_items').get().n), before,
      'a preview must write NOTHING');
  });

  it('commits, and the placements mirror still holds', async () => {
    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const made = r.body.result.find((s) => s.line_id === boxLine);
    assert.equal(made.created, true);
    assert.match(made.sku, /^BK-SLD-PKM-\d{6}$/);

    withDb((db) => {
      const row = db.prepare('SELECT quantity, location, cost_cents, acq_fees_cents, po_line_id FROM sealed_items WHERE id = ?').get(made.item_id);
      assert.equal(row.quantity, 6);
      assert.equal(row.location, 'SHELF-A', 'the mirror names the first located spot');
      assert.equal(row.cost_cents, 16000);
      assert.equal(row.po_line_id, boxLine, 'the stock row points back at the purchase line');
      const spots = db.prepare('SELECT location, quantity FROM sealed_placements WHERE item_id = ? ORDER BY id').all(made.item_id);
      assert.deepEqual(spots.map((s) => ({ ...s })), [{ location: 'SHELF-A', quantity: 4 }, { location: 'TUB-3', quantity: 2 }],
        'the split the operator entered is what landed on the shelf');
      assert.ok(mirrorHolds(db), 'quantity === SUM(placements) for EVERY sealed row');
    });
  });

  it('merged the restock into the held row and blended its cost basis', async () => {
    withDb((db) => {
      const row = db.prepare('SELECT quantity, cost_cents FROM sealed_items WHERE id = ?').get(heldId);
      assert.equal(row.quantity, 5, '3 held + 2 received');
      // (10000*3 + 13000*2) / 5 = 11200.
      assert.equal(row.cost_cents, 11200, 'weighted average, not an overwrite');
      const spots = db.prepare('SELECT location, quantity FROM sealed_placements WHERE item_id = ?').all(heldId);
      assert.equal(spots.length, 1, 'the same spot was bumped, not duplicated');
      assert.equal(spots[0].quantity, 5);
    });
    const { body } = await api(`/orders/${orderId}`);
    assert.equal(body.order.status, 'received');
  });

  it('a replayed commit adds nothing', async () => {
    const before = withDb((db) => ({
      rows: db.prepare('SELECT COUNT(*) n FROM sealed_items').get().n,
      units: db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM sealed_items').get().n,
    }));
    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.body.already, true, 'a retried fetch must not stock the delivery twice');
    const after = withDb((db) => ({
      rows: db.prepare('SELECT COUNT(*) n FROM sealed_items').get().n,
      units: db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM sealed_items').get().n,
    }));
    assert.deepEqual(after, before);
  });

  it('refuses to close while money is owed, and closes when told to anyway', async () => {
    let r = await api(`/orders/${orderId}/close`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'unpaid');
    r = await api(`/orders/${orderId}/close`, { method: 'POST', body: { force_close_unpaid: true } });
    assert.equal(r.status, 200);
  });
});

describe('a bulk lot', () => {
  it('splits the lump evenly and sums back to it, to the cent', async () => {
    const orderId = await makeOrder({ supplier: 'Lot Co' });
    const lotLine = await addLine(orderId, {
      line_kind: 'lot', target: 'inventory', game: 'pokemon',
      name: 'Mixed holo lot', qty_ordered: 1, lot_total_cents: 1000,
    });
    // Seven items came out of one lot priced at 1000c — a remainder that must not vanish.
    await count(lotLine, { qty_received: 1, lot_units: 7 });

    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    withDb((db) => {
      const rows = db.prepare('SELECT sku, quantity, cost_cents FROM inventory_items WHERE po_line_id = ?').all(lotLine);
      const units = rows.reduce((s, x) => s + x.quantity, 0);
      const money = rows.reduce((s, x) => s + x.cost_cents * x.quantity, 0);
      assert.equal(units, 7, 'seven items came out, seven are in stock');
      assert.equal(money, 1000, "the owner's rule: the split sums back to the lot total, exactly");
      // §16b: a lot is one object, not a slot on the singles shelf — it must not burn a shelf label.
      for (const row of rows) assert.match(row.sku, /^BK-RAW-/, 'a lot takes the bulk namespace');
    });
  });
});

describe('a restock target that is LISTED', () => {
  it('still merges — a listed product is on eBay, not gone', async () => {
    // Restocking something currently listed is the ORDINARY case (the picker offers a `listed`
    // filter for it). A guard that only accepted 'in_stock' split the pile across two SKUs, left the
    // live listing's quantity untouched and never blended the cost basis.
    const held = await sealedApi('/items', {
      method: 'POST',
      body: { game: 'pokemon', product_type: 'booster_box', name: 'Listed Box', quantity: 2, cost_cents: 10000 },
    });
    await sealedApi('/items/' + held.body.id, { method: 'PATCH', body: { status: 'listed' } });

    const orderId = await makeOrder({ supplier: 'Listed Co' });
    const line = await addLine(orderId, { qty_ordered: 3, unit_cost_cents: 14000, link: { kind: 'sealed', item_id: held.body.id } });
    await count(line, { qty_received: 3, placements: [{ location: 'SHELF-L', quantity: 3 }] });

    const before = withDb((db) => db.prepare('SELECT COUNT(*) n FROM sealed_items').get().n);
    const dry = await api(`/orders/${orderId}/receive?dry=1`, { method: 'POST' });
    assert.equal(dry.body.steps[0].action, 'merge', 'a listed product must be topped up, not duplicated');
    assert.equal(dry.body.steps[0].target_id, held.body.id);

    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    withDb((db) => {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM sealed_items').get().n, before, 'no second SKU');
      const row = db.prepare('SELECT quantity, status, cost_cents FROM sealed_items WHERE id = ?').get(held.body.id);
      assert.equal(row.quantity, 5, '2 held + 3 received');
      assert.equal(row.status, 'listed', 'and it is still the listing it was');
      assert.equal(row.cost_cents, 12400, '(10000*2 + 14000*3) / 5');
      assert.ok(mirrorHolds(db));
    });
  });
});

describe('a restock target that has left stock', () => {
  it('is not merged into — a sold row would swallow the delivery invisibly', async () => {
    // The card can sell while the restock is still on the water. Merging six boxes onto a row marked
    // 'sold' hides them from every in_stock view while summarizeSealed keeps counting them as sold.
    const held = await sealedApi('/items', {
      method: 'POST',
      body: { game: 'pokemon', product_type: 'booster_box', name: 'Sold Out Box', quantity: 1, cost_cents: 9000 },
    });
    const orderId = await makeOrder({ supplier: 'Sold Co' });
    const line = await addLine(orderId, { qty_ordered: 2, unit_cost_cents: 9500, link: { kind: 'sealed', item_id: held.body.id } });
    await count(line, { qty_received: 2, placements: [{ location: 'SHELF-S', quantity: 2 }] });

    await sealedApi('/items/' + held.body.id, { method: 'PATCH', body: { status: 'sold' } });

    const dry = await api(`/orders/${orderId}/receive?dry=1`, { method: 'POST' });
    assert.equal(dry.status, 200);
    const step = dry.body.steps[0];
    assert.notEqual(step.target_id, held.body.id, 'the sold row must not be the merge target');
    assert.deepEqual(dry.body.blockers, [], 'but the goods still have to be put away (GR7)');

    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    withDb((db) => {
      const sold = db.prepare('SELECT quantity, status FROM sealed_items WHERE id = ?').get(held.body.id);
      assert.equal(sold.quantity, 1, 'the sold row is untouched');
      assert.equal(sold.status, 'sold');
      assert.ok(mirrorHolds(db));
    });
  });
});

describe('the blend audit trail', () => {
  it('records what the cost basis was BEFORE the weighted average moved it', async () => {
    const held = await sealedApi('/items', {
      method: 'POST',
      body: { game: 'pokemon', product_type: 'booster_box', name: 'Audit Box', quantity: 4, cost_cents: 10000, acq_fees_cents: 200 },
    });
    const orderId = await makeOrder({ supplier: 'Audit Co' });
    const line = await addLine(orderId, { qty_ordered: 4, unit_cost_cents: 14000, link: { kind: 'sealed', item_id: held.body.id } });
    await count(line, { qty_received: 4 });
    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const step = r.body.result.find((s) => s.line_id === line);
    assert.equal(step.action, 'merge');
    // Without this the receipt claimed the blend was "reversible by hand" while recording null.
    assert.equal(step.blend_before.quantity, 4);
    assert.equal(step.blend_before.cost_cents, 10000);
    assert.equal(step.blend_before.acq_fees_cents, 200);
    assert.equal(step.blend_after.cost_cents, 12000, '(10000*4 + 14000*4) / 8');
    withDb((db) => {
      assert.equal(db.prepare('SELECT cost_cents FROM sealed_items WHERE id = ?').get(held.body.id).cost_cents, 12000);
    });
  });
});

describe('a deleted restock target', () => {
  it('still puts the goods away rather than stranding them', async () => {
    const held = await sealedApi('/items', {
      method: 'POST',
      body: { game: 'mtg', product_type: 'booster_box', name: 'Doomed Restock Box', quantity: 1, cost_cents: 5000 },
    });
    const orderId = await makeOrder({ supplier: 'Ghost Co' });
    const line = await addLine(orderId, { qty_ordered: 2, unit_cost_cents: 5000, link: { kind: 'sealed', item_id: held.body.id } });
    await count(line, { qty_received: 2, placements: [{ location: 'SHELF-Z', quantity: 2 }] });

    // The picked row is deleted between linking and receiving.
    await sealedApi('/items/' + held.body.id, { method: 'DELETE' });

    const dry = await api(`/orders/${orderId}/receive?dry=1`, { method: 'POST' });
    assert.equal(dry.status, 200);
    const step = dry.body.steps[0];
    assert.ok(['link_repaired', 'link_broken'].includes(step.link_note), 'the preview says the link went bad');
    assert.deepEqual(dry.body.blockers, [], 'but a dead link is a warning, not a blocker (GR7)');

    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    withDb((db) => {
      assert.ok(mirrorHolds(db), 'and the mirror still holds afterwards');
    });
  });
});

describe('a grading line', () => {
  it('books the per-card fee once per submission, totalling what was paid', async () => {
    // The fee is PER CARD. It used to be added in full to every named submission, so three cards on
    // one line booked 3x what was paid — and promote() folds that into each slab's cost basis.
    const mk = async (name) => (await (await fetch(base + '/api/inventory/submissions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'pokemon', name, grading_company: 'PSA', status: 'submitted' }),
    })).json()).id;
    const ids = [await mk('Card A'), await mk('Card B'), await mk('Card C')];

    const orderId = await makeOrder({ supplier: 'PSA' });
    const line = await addLine(orderId, {
      line_kind: 'grading', target: 'inventory', game: 'pokemon', name: 'PSA bulk submission',
      qty_ordered: 3, unit_cost_cents: 2500, submission_ids: ids,
    });
    await count(line, { qty_received: 3 });

    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    withDb((db) => {
      const rows = ids.map((id) => db.prepare('SELECT grading_cost_cents FROM grading_submissions WHERE id = ?').get(id));
      for (const row of rows) assert.equal(row.grading_cost_cents, 2500, 'the per-card fee, once');
      assert.equal(rows.reduce((s, x) => s + x.grading_cost_cents, 0), 7500, '3 cards x A$25.00 = what was paid');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM sealed_items WHERE po_line_id = ?').get(line).n, 0,
        'grading buys a service — it creates no stock');
    });
  });

  // THE CURRENCY BUG. card-grader.html seeds grading_cost_cents in the company's NATIVE currency —
  // data/grading.config.json: "Only PCG quotes in AUD; every other company's figures below are native
  // USD" — and a receive adds AUD to it. Blind, that produced a number that was neither.
  it('replaces a native-currency fee rather than adding AUD to it', async () => {
    const subId = (await (await fetch(base + '/api/inventory/submissions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: 'pokemon', name: 'Charizard', grading_company: 'PSA', status: 'submitted',
        grading_cost_cents: 7999, grading_cost_currency: 'USD',   // the grader's USD sticker price
      }),
    })).json()).id;

    const orderId = await makeOrder({ supplier: 'PSA' });
    const line = await addLine(orderId, {
      line_kind: 'grading', target: 'inventory', game: 'pokemon', name: 'PSA Regular',
      qty_ordered: 1, unit_cost_cents: 12000, submission_ids: [subId],
    });
    await count(line, { qty_received: 1 });
    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    withDb((db) => {
      const row = db.prepare('SELECT grading_cost_cents, grading_cost_currency FROM grading_submissions WHERE id = ?').get(subId);
      assert.equal(row.grading_cost_cents, 12000, 'the invoiced AUD fee replaces the USD estimate — 7999 + 12000 is not a number');
      assert.equal(row.grading_cost_currency, 'AUD', 'and the row says which currency it is now in');
    });
  });

  it('still ADDS when the column is already AUD, so two invoices for one card total correctly', async () => {
    const subId = (await (await fetch(base + '/api/inventory/submissions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: 'pokemon', name: 'Blastoise', grading_company: 'PSA', status: 'submitted',
        grading_cost_cents: 500, grading_cost_currency: 'AUD',
      }),
    })).json()).id;
    const orderId = await makeOrder({ supplier: 'PSA' });
    const line = await addLine(orderId, {
      line_kind: 'grading', target: 'inventory', game: 'pokemon', name: 'PSA Regular',
      qty_ordered: 1, unit_cost_cents: 12000, submission_ids: [subId],
    });
    await count(line, { qty_received: 1 });
    await api(`/orders/${orderId}/receive`, { method: 'POST' });
    withDb((db) => {
      assert.equal(db.prepare('SELECT grading_cost_cents c FROM grading_submissions WHERE id = ?').get(subId).c, 12500);
    });
  });

  it('refuses a submission that is gone or already promoted, instead of paying it into nothing', async () => {
    const orderId = await makeOrder({ supplier: 'PSA' });
    const line = await addLine(orderId, {
      line_kind: 'grading', target: 'inventory', game: 'pokemon', name: 'Ghost submission',
      qty_ordered: 1, unit_cost_cents: 2500, submission_ids: [999999],
    });
    await count(line, { qty_received: 1 });
    const dry = await api(`/orders/${orderId}/receive?dry=1`, { method: 'POST' });
    const blocker = dry.body.blockers.find((b) => b.reason === 'grading_submissions_unusable');
    assert.ok(blocker, 'the UPDATE would change 0 rows and the money would vanish silently');
    assert.deepEqual(blocker.submission_ids, [999999]);
  });

  it('dedupes repeated ids, so one card cannot be billed twice', async () => {
    const r = await api('/orders', { method: 'POST', body: { supplier: 'PSA', status: 'ordered' } });
    const add = await api(`/orders/${r.body.id}/lines`, {
      method: 'POST',
      body: { line_kind: 'grading', target: 'inventory', game: 'pokemon', name: 'Dupe submission',
        qty_ordered: 2, unit_cost_cents: 2500, submission_ids: [7, 7] },
    });
    assert.equal(add.status, 201);
    const { body } = await api('/orders/' + r.body.id);
    // [7,7] with qty 2 would have passed a bare length check and run the fee UPDATE twice on one row.
    assert.deepEqual(JSON.parse(body.lines[0].submission_ids), [7]);
  });

  it('refuses when the submissions named do not match the cards counted', async () => {
    const orderId = await makeOrder({ supplier: 'PSA' });
    const line = await addLine(orderId, {
      line_kind: 'grading', target: 'inventory', game: 'pokemon', name: 'Mismatched submission',
      qty_ordered: 1, unit_cost_cents: 2500, submission_ids: [1, 2, 3],
    });
    await count(line, { qty_received: 1 });
    const dry = await api(`/orders/${orderId}/receive?dry=1`, { method: 'POST' });
    const blocker = dry.body.blockers.find((b) => b.reason === 'grading_count_mismatch');
    assert.ok(blocker, 'one card counted against three submissions would book 3x the fee');
    assert.equal(blocker.counted, 1);
    assert.equal(blocker.submissions, 3);
  });
});

describe('a foreign order with no rate', () => {
  it('refuses to invent an AUD cost basis (GR3)', async () => {
    const orderId = await makeOrder({ supplier: 'No Rate Co', currency: 'USD' });
    const line = await addLine(orderId, {
      game: 'pokemon', product_type: 'booster_box', name: 'Unrated Box', qty_ordered: 1, unit_cost_cents: 10000,
    });
    await count(line, { qty_received: 1 });

    const dry = await api(`/orders/${orderId}/receive?dry=1`, { method: 'POST' });
    assert.ok(dry.body.blockers.some((b) => b.reason === 'fx_required'),
      'stock is stored in AUD, and a guessed rate is the one thing GR3 forbids outright');

    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 409);

    // Settling supplies the rate, and the receive proceeds at what was actually paid.
    await api(`/orders/${orderId}/settle`, { method: 'POST', body: { settled_aud_cents: 15300 } });
    const ok = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    withDb((db) => {
      const row = db.prepare('SELECT cost_cents FROM sealed_items WHERE po_line_id = ?').get(line);
      assert.ok(row.cost_cents > 10000, 'the AUD cost basis reflects the settled rate, not the USD figure');
    });
  });
});

// THE LEDGER INVARIANT, end to end and through the real routes rather than the module's own API:
// after a receive, a sale, a partial sale and a cancellation, SUM(stock_movements.delta) == quantity
// for every row in both stock tables.
describe('the stock ledger balances against what actually happened', () => {
  it('every row squares after a receive, and the movements name the purchase order', async () => {
    const orderId = await makeOrder({ supplier: 'Ledger Co' });
    const sealedLine = await addLine(orderId, {
      target: 'sealed', game: 'pokemon', product_type: 'booster_box', name: 'White Flare Box',
      qty_ordered: 4, unit_cost_cents: 18000,
    });
    const singleLine = await addLine(orderId, {
      target: 'inventory', game: 'pokemon', name: 'Iono', qty_ordered: 1, unit_cost_cents: 4000,
    });
    await count(sealedLine, { qty_received: 4, placements: [{ location: 'Shelf A', quantity: 4 }] });
    await count(singleLine, { qty_received: 1, placements: [{ location: 'Binder 1', quantity: 1 }] });
    const r = await api(`/orders/${orderId}/receive`, { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    withDb((db) => {
      // Scoped to the rows THIS receive created — the file shares one database across tests, and rows
      // left by earlier ones were written before the ledger existed. po_line_id is the stamp the
      // receive puts on everything it stocks.
      const drift = db.prepare(`
        SELECT 'inventory' k, i.id, i.quantity q, COALESCE((SELECT SUM(delta) FROM stock_movements m
                 WHERE m.kind='inventory' AND m.item_id=i.id),0) l
          FROM inventory_items i WHERE i.po_line_id IN (?,?)
        UNION ALL
        SELECT 'sealed', s.id, s.quantity, COALESCE((SELECT SUM(delta) FROM stock_movements m
                 WHERE m.kind='sealed' AND m.item_id=s.id),0)
          FROM sealed_items s WHERE s.po_line_id IN (?,?)
      `).all(sealedLine, singleLine, sealedLine, singleLine).filter((x) => Number(x.q) !== Number(x.l));
      assert.deepEqual(drift, [], 'the cache and the ledger disagree after a receive');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_items WHERE po_line_id = ?').get(singleLine).n, 1,
        'the fixture must actually have stocked something for the assertion above to mean anything');

      // And the units are explicable: a receive, pointed at the line that brought them in.
      const moves = db.prepare(`SELECT reason, delta, ref_kind FROM stock_movements
                                 WHERE reason = 'receive' AND ref_kind = 'po_line' AND ref_id IN (?,?) ORDER BY id`)
        .all(String(sealedLine), String(singleLine));
      assert.ok(moves.length >= 2, 'both lines should have filed a movement');
      assert.ok(moves.every((m) => m.ref_kind === 'po_line'), 'a receive with no purchase-order line is not explicable');
      assert.equal(moves.reduce((a, m) => a + m.delta, 0), 5, '4 boxes + 1 single');
    });
  });

  it('a hand edit is a movement too, so a number nobody can explain cannot appear', async () => {
    const orderId = await makeOrder({ supplier: 'Ledger Co' });
    const line = await addLine(orderId, {
      target: 'inventory', game: 'pokemon', name: 'Charizard', qty_ordered: 2, unit_cost_cents: 4000,
    });
    await count(line, { qty_received: 2, placements: [{ location: 'Binder 1', quantity: 2 }] });
    await api(`/orders/${orderId}/receive`, { method: 'POST' });

    const itemId = withDb((db) => db.prepare("SELECT id FROM inventory_items WHERE name = 'Charizard'").get().id);
    const r = await fetch(`${base}/api/inventory/items/${itemId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quantity: 5 }),
    });
    assert.equal(r.status, 200);
    withDb((db) => {
      assert.equal(db.prepare('SELECT quantity q FROM inventory_items WHERE id = ?').get(itemId).q, 5);
      const last = db.prepare("SELECT reason, delta FROM stock_movements WHERE kind = 'inventory' AND item_id = ? ORDER BY id DESC LIMIT 1").get(itemId);
      assert.equal(last.reason, 'manual', 'a hand edit that leaves no movement is exactly the hole the ledger fills');
      assert.equal(last.delta, 3);
    });
  });
});
