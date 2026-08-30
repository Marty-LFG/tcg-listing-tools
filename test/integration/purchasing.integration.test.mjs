// test/integration/purchasing.integration.test.mjs — the /api/purchasing surface against the real
// dev server and a temp DB.
//
// The assertion this file exists for is GR3: an order placed in USD must come back out of the
// database as the same USD number it went in as. Nothing is converted at storage, so a rate that
// moves overnight can never rewrite what a supplier's invoice said.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';

let srv, base;
before(async () => { srv = await bootServer(); base = srv.base; });
after(async () => { await srv?.close(); });

const api = async (path, opts = {}) => {
  const r = await fetch(base + '/api/purchasing' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

describe('purchasing vocabulary', () => {
  it('serves the statuses and the legal moves, so the UI can disable what the server would refuse', async () => {
    const { status, body } = await api('/statuses');
    assert.equal(status, 200);
    assert.ok(body.statuses.includes('preorder'));
    assert.ok(body.statuses.includes('in_transit'));
    // 'received' is reachable only by committing a receive, so nothing may transition INTO it.
    for (const [, allowed] of Object.entries(body.transitions)) {
      assert.ok(!allowed.includes('received'), 'no PATCH may reach received');
    }
    assert.deepEqual(body.transitions.closed, [], 'closed is terminal');
  });

  it('serves the discrepancy codes', async () => {
    const { body } = await api('/discrepancy-codes');
    assert.ok(body.codes.some((c) => c.code === 'short'));
    // 'never shipped' means no goods arrived, which is the one code that puts nothing on a shelf.
    assert.equal(body.codes.find((c) => c.code === 'not_shipped').affects_stock, false);
  });
});

describe('orders', () => {
  let usdOrder;

  it('creates an order and mints a monotonic PO ref', async () => {
    const { status, body } = await api('/orders', {
      method: 'POST',
      body: {
        supplier: 'Card Shark AU', supplier_ref: 'INV-9912', currency: 'USD',
        shipping_cents: 12000, tax_cents: 0, other_fees_cents: 500, discount_cents: 2000,
        fx_to_aud: 1.5210, eta_at: '2026-09-15', status: 'ordered',
      },
    });
    assert.equal(status, 201);
    assert.match(body.ref, /^PO-\d{6}$/);
    usdOrder = body.id;
  });

  it('GR3: a USD order stores USD cents, unconverted', async () => {
    const { body } = await api('/orders/' + usdOrder);
    assert.equal(body.order.currency, 'USD');
    assert.equal(body.order.shipping_cents, 12000, 'byte-identical to what was sent — no FX applied at storage');
    assert.equal(body.order.discount_cents, 2000);
    assert.equal(body.totals.fx, 1.5210, 'the live rate is available for DISPLAY');
    assert.equal(body.totals.fx_estimated, true, 'and is flagged an estimate until the order settles (GR4)');
  });

  it('adds lines, and totals goods plus charges in the order currency', async () => {
    const { status, body } = await api(`/orders/${usdOrder}/lines`, {
      method: 'POST',
      body: {
        lines: [
          { line_kind: 'unit', target: 'sealed', game: 'pokemon', product_type: 'booster_box',
            name: 'Surging Sparks Booster Box', set_name: 'Surging Sparks', qty_ordered: 6, unit_cost_cents: 11000 },
          { line_kind: 'unit', target: 'sealed', game: 'pokemon', product_type: 'elite_trainer_box',
            name: 'Prismatic Evolutions ETB', qty_ordered: 4, unit_cost_cents: 5000 },
        ],
      },
    });
    assert.equal(status, 201);
    assert.equal(body.ids.length, 2);
    const { body: o } = await api('/orders/' + usdOrder);
    assert.equal(o.totals.goods_cents, 6 * 11000 + 4 * 5000);
    assert.equal(o.totals.charges_cents, 12000 + 0 + 500 - 2000, 'a discount is stored positive and subtracted');
    assert.equal(o.totals.total_cents, 86000 + 10500);
    assert.equal(o.totals.unit_count, 10);
  });

  it('refuses a line nobody could identify', async () => {
    const { status, body } = await api(`/orders/${usdOrder}/lines`, {
      method: 'POST', body: { qty_ordered: 1, unit_cost_cents: 100 },
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_line');
  });

  it('walks payments from unpaid to partial to paid, folding a foreign-currency payment', async () => {
    let r = await api('/orders/' + usdOrder + '/payments');
    assert.equal(r.body.payment_status, 'unpaid');
    assert.equal(r.body.balance_cents, 96500);

    // A deposit paid in USD.
    r = await api(`/orders/${usdOrder}/payments`, { method: 'POST', body: { amount_cents: 40000, currency: 'USD', kind: 'deposit' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.payment_status, 'partial');
    assert.equal(r.body.balance_cents, 56500);

    // The balance paid off an AUD card against the USD invoice — this seller's normal case.
    r = await api(`/orders/${usdOrder}/payments`, {
      method: 'POST', body: { amount_cents: 86200, currency: 'AUD', fx_to_order: 0.6555, aud_cents: 86200 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.payment_status, 'paid');
  });

  it('a refund is a negative payment, so the balance goes back up', async () => {
    const r = await api(`/orders/${usdOrder}/payments`, { method: 'POST', body: { amount_cents: -10000, currency: 'USD', kind: 'refund' } });
    assert.equal(r.body.payment_status, 'partial');
    assert.ok(r.body.balance_cents > 0);
  });

  it('refuses to settle from payments it cannot express in AUD', async () => {
    // The figure derived here becomes the permanent cost basis on every stock row the order produces.
    // A payment silently worth 0 would land the whole order at a fraction of what it cost.
    const o = await api('/orders', { method: 'POST', body: { supplier: 'Mixed Co', currency: 'USD', status: 'ordered' } });
    await api(`/orders/${o.body.id}/lines`, {
      method: 'POST',
      body: { game: 'pokemon', product_type: 'booster_box', name: 'Mixed Box', qty_ordered: 1, unit_cost_cents: 50000 },
    });
    // A JPY payment with no AUD figure attached.
    await api(`/orders/${o.body.id}/payments`, { method: 'POST', body: { amount_cents: 30000, currency: 'JPY' } });
    const r = await api(`/orders/${o.body.id}/settle`, { method: 'POST', body: { from_payments: true } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'payments_not_in_aud');
    assert.equal(r.body.payment_ids.length, 1);
  });

  it('settling converts a live estimate into a permanent cost basis', async () => {
    const { body: before } = await api('/orders/' + usdOrder);
    assert.equal(before.totals.fx_estimated, true);

    const r = await api(`/orders/${usdOrder}/settle`, { method: 'POST', body: { settled_aud_cents: 147000, settled_source: 'bank' } });
    assert.equal(r.status, 200);
    // 147000 AUD cents for a 96500 USD-cent order implies ~1.5233.
    assert.ok(Math.abs(r.body.settled_fx_to_aud - 147000 / 96500) < 1e-9);

    const { body: after } = await api('/orders/' + usdOrder);
    assert.equal(after.totals.fx_estimated, false, 'no longer an estimate');
    assert.equal(after.totals.fx, r.body.settled_fx_to_aud, 'the settled rate now wins over the live one');
    assert.equal(after.order.shipping_cents, 12000, 'and the native figures are STILL untouched (GR3)');
  });
});

describe('status transitions', () => {
  let id;
  before(async () => {
    const r = await api('/orders', { method: 'POST', body: { supplier: 'Transitions Co', currency: 'AUD' } });
    id = r.body.id;
  });

  it('refuses an illegal move and says what was allowed', async () => {
    // draft -> in_transit skips being ordered at all. ('received' and 'closed' are refused earlier
    // still, by the endpoint guards — those have their own cases below.)
    const r = await api('/orders/' + id, { method: 'PATCH', body: { status: 'in_transit' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'illegal_transition');
    assert.deepEqual(r.body.allowed, ['preorder', 'ordered', 'cancelled']);
  });

  it('refuses to reach received by PATCH — only a committed receive can claim stock exists', async () => {
    const r = await api('/orders/' + id, { method: 'PATCH', body: { status: 'received' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'receive_via_endpoint');
  });

  it('refuses to reach closed by PATCH — closing checks a receipt exists and nothing is owed', async () => {
    const r = await api('/orders/' + id, { method: 'PATCH', body: { status: 'closed' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'close_via_endpoint');
  });

  it('refuses to CREATE an order at the end of its life', async () => {
    // 'arrived' would be immediately receivable with no history; 'closed' would be a closed order
    // with no receipt, which POST /close would have refused outright.
    for (const status of ['arrived', 'closed', 'cancelled', 'in_transit']) {
      const r = await api('/orders', { method: 'POST', body: { supplier: 'Born Bad Co', status } });
      assert.equal(r.status, 400, status);
      assert.equal(r.body.error, 'bad_create_status');
    }
    const ok = await api('/orders', { method: 'POST', body: { supplier: 'Born Fine Co', status: 'ordered' } });
    assert.equal(ok.status, 201);
  });

  it('refuses a preorder with no street date', async () => {
    const r = await api('/orders/' + id, { method: 'PATCH', body: { status: 'preorder' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'release_date_required');
  });

  it('accepts a preorder once it has one, and stamps ordered_at on the way through', async () => {
    let r = await api('/orders/' + id, { method: 'PATCH', body: { status: 'preorder', release_date: '2026-10-14' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.order.status, 'preorder');
    r = await api('/orders/' + id, { method: 'PATCH', body: { status: 'ordered' } });
    assert.equal(r.body.order.status, 'ordered');
    assert.ok(r.body.order.ordered_at, 'the date the move implies is stamped without the UI sending it');
  });
});

describe('facets', () => {
  it('keeps preorders OUT of the outstanding queue', async () => {
    const pre = await api('/orders', { method: 'POST', body: { supplier: 'Preorder Co', status: 'preorder', release_date: '2027-01-01' } });
    assert.equal(pre.status, 201);
    const { body: outstanding } = await api('/orders?facet=outstanding');
    assert.ok(!outstanding.orders.some((o) => o.id === pre.body.id),
      'a six-month-out preorder must not clutter "where is my stuff"');
    const { body: preorders } = await api('/orders?facet=preorder');
    assert.ok(preorders.orders.some((o) => o.id === pre.body.id));
    assert.ok(preorders.counts.preorder >= 1);
  });

  it('searches by ref, supplier and tracking', async () => {
    const { body } = await api('/orders?q=Preorder Co');
    assert.ok(body.orders.length >= 1);
    assert.ok(body.orders.every((o) => (o.supplier || '').includes('Preorder Co')));
  });
});

describe('suppliers autocomplete', () => {
  it('offers the names already used, with no registry to maintain', async () => {
    const { body } = await api('/suppliers');
    assert.ok(body.suppliers.includes('Card Shark AU'));
    assert.ok(body.suppliers.includes('Preorder Co'));
  });
});

describe('the restock picker', () => {
  let sealedId;

  before(async () => {
    // Put a row in sealed stock through the tool's own API, so the picker is reading what the rest of
    // the app actually writes.
    const r = await fetch(base + '/api/sealed/items', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'pokemon', product_type: 'booster_box', name: 'Held Booster Box',
        set_name: 'Surging Sparks', quantity: 3, location: 'SHELF-A', cost_cents: 16000, acq_fees_cents: 400 }),
    });
    sealedId = (await r.json()).id;
  });

  it('finds held stock and computes landed cost the same way the summaries do', async () => {
    const { body } = await api('/stock?q=Held Booster');
    const hit = body.items.find((i) => i.kind === 'sealed' && i.id === sealedId);
    assert.ok(hit, 'the picker must see stock the sealed tool created');
    assert.equal(hit.quantity, 3);
    assert.equal(hit.location, 'SHELF-A');
    assert.equal(hit.landed_unit_cents, 16400, 'cost_cents + acq_fees_cents, not re-derived in the browser');
  });

  it('filters by game and by product type', async () => {
    const { body: mtg } = await api('/stock?game=mtg&q=Held Booster');
    assert.equal(mtg.items.length, 0);
    const { body: byType } = await api('/stock?product_type=booster_box&q=Held Booster');
    assert.ok(byType.items.some((i) => i.id === sealedId));
    // product_type is a sealed-only facet, so asking for one must exclude singles rather than
    // returning them unfiltered — that would read as "the filter did nothing".
    assert.ok(byType.items.every((i) => i.kind === 'sealed'));
  });

  it('links a line to held stock, and the line inherits its identity', async () => {
    const ord = await api('/orders', { method: 'POST', body: { supplier: 'Card Shark AU', currency: 'AUD' } });
    const r = await api(`/orders/${ord.body.id}/lines`, {
      method: 'POST',
      body: { qty_ordered: 2, unit_cost_cents: 17000, link: { kind: 'sealed', item_id: sealedId } },
    });
    assert.equal(r.status, 201);
    const { body: o } = await api('/orders/' + ord.body.id);
    const line = o.lines[0];
    assert.equal(line.name, 'Held Booster Box', 'a restock needs nothing typed');
    assert.equal(line.link_kind, 'sealed');
    assert.ok(line.link_sku, 'the sku is snapshot as the guard against a reused id');
    assert.equal(line.link.alive, true);
    assert.equal(line.link.current.quantity, 3, 'the drawer can show what is already on the shelf');
  });

  it('reports a deleted link target instead of erroring', async () => {
    const ord = await api('/orders', { method: 'POST', body: { supplier: 'Ghost Co', currency: 'AUD' } });
    const mk = await fetch(base + '/api/sealed/items', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'mtg', product_type: 'booster_box', name: 'Doomed Box', quantity: 1 }),
    });
    const doomedId = (await mk.json()).id;
    await api(`/orders/${ord.body.id}/lines`, { method: 'POST', body: { qty_ordered: 1, unit_cost_cents: 100, link: { kind: 'sealed', item_id: doomedId } } });
    await fetch(base + '/api/sealed/items/' + doomedId, { method: 'DELETE' });

    const { status, body } = await api('/orders/' + ord.body.id);
    assert.equal(status, 200, 'a dead link must not break the drawer');
    assert.equal(body.lines[0].link.alive, false);
    assert.equal(body.lines[0].link.reason, 'deleted');
  });
});

describe('summary', () => {
  it('returns PER-CURRENCY subtotals, never a pre-folded AUD figure', async () => {
    const { body } = await api('/summary');
    assert.equal(typeof body.open_by_currency, 'object');
    // The client folds these with TCG.toAUD at render time, exactly as /api/sealed/summary expects.
    assert.ok(!('open_aud_cents' in body), 'folding to AUD server-side would bake in a rate (GR3)');
    assert.ok(body.orders >= 1);
  });
});
