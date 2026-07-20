// test/integration/postsale.integration.test.mjs — boots the real dev server against temp DBs and
// exercises the post-sale (Phase 0) API. Orders are SEEDED via ingestOrder (no live GetOrders call);
// the parsing of a real GetOrders payload is covered by test/unit/postsale-orders.test.mjs.
//
// NOTE: lib/postsale-db.mjs resolves its DB path at module load, so it must NOT be statically
// imported here — bootServer() sets TCG_POSTSALE_DB first, then vite loads the module. We import
// the postsale modules dynamically inside before(), after the server (and its temp path) exist.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from '../helpers/boot-server.mjs';

let srv, db, ingestOrder, loadConfig, maybeHandleReply, cfg;

const mkOrder = (id, overrides = {}) => ({
  orderId: id, buyerUsername: 'testbuyer', orderStatus: 'Completed', checkoutStatus: 'Complete',
  paidStatus: 'NoPaymentFailure', createdTime: '2026-07-19T01:00:00.000Z', paidTime: '2026-07-19T01:05:00.000Z',
  shippedTime: null, currency: 'AUD', totalCents: 4550, subtotalCents: 4200, shippingCents: 350,
  shipService: 'AU_Regular', paid: true,
  ship: { name: 'Test Buyer', street1: '1 Test St', street2: null, city: 'Sydney', state: 'NSW', postal: '2000', country: 'AU', countryName: 'Australia', phone: null },
  items: [{ orderLineItemId: id + '-1', transactionId: 'tx-' + id, itemId: '999' + id, sku: 'BK-PKM-000042', title: 'Test Card', quantity: 1, unitPriceCents: 4200 }],
  ...overrides,
});

before(async () => {
  srv = await bootServer();
  const psdb = await import('../../lib/postsale-db.mjs');
  const ps = await import('../../lib/postsale.mjs');
  db = psdb.openPostsaleDb();
  ingestOrder = ps.ingestOrder;
  loadConfig = ps.loadConfig;
  maybeHandleReply = ps.maybeHandleReply;
  cfg = loadConfig();
}, { timeout: 60_000 });
after(async () => { await srv?.close(); });

const get = async (p) => {
  const r = await fetch(srv.base + p);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const post = async (p) => {
  const r = await fetch(srv.base + p, { method: 'POST' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const postJson = async (p, body) => {
  const r = await fetch(srv.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

describe('postsale — isolated store', () => {
  it('created the temp postsale.db, not the real one', () => {
    assert.ok(srv.dbFileExists(srv.postsaleDb), 'temp postsale.db missing');
    assert.match(srv.postsaleDb, /tcg-int-/);
  });
});

describe('postsale — order ingest + CRM', () => {
  it('ingests a paid order → creates a pending message, order, line item, and buyer', async () => {
    const r = ingestOrder(db, mkOrder('T-1'), cfg);
    assert.equal(r.created, true);
    assert.equal(r.repeat, false);

    const msgs = await get('/api/postsale/messages');
    assert.equal(msgs.status, 200);
    assert.equal(msgs.json.messages.length, 1);
    const m = msgs.json.messages[0];
    assert.equal(m.order_id, 'T-1');
    assert.equal(m.status, 'pending');
    assert.equal(m.is_repeat_buyer, 0);
    assert.equal(m.buyer_username, 'testbuyer');   // joined from orders
    assert.equal(m.total_cents, 4550);

    const orders = await get('/api/postsale/orders');
    assert.equal(orders.json.orders.length, 1);
    const o = orders.json.orders[0];
    assert.equal(o.items.length, 1);
    assert.equal(o.items[0].sku, 'BK-PKM-000042');
    assert.equal(o.shipped_status, 'unshipped');
    assert.equal(o.label_status, 'queued');        // labels enabled + address present + unshipped

    const buyers = await get('/api/postsale/buyers');
    assert.equal(buyers.json.buyers.length, 1);
    assert.equal(buyers.json.buyers[0].ebay_username, 'testbuyer');
    assert.equal(buyers.json.buyers[0].order_count, 1);
    assert.equal(buyers.json.buyers[0].total_spent_cents, 4550);
  });

  it('re-ingesting the same order is a no-op (idempotency on order_id)', async () => {
    const r = ingestOrder(db, mkOrder('T-1'), cfg);
    assert.equal(r.created, false);
    const msgs = await get('/api/postsale/messages');
    assert.equal(msgs.json.messages.length, 1, 'must not duplicate the message row');
  });

  it("a second order from the same buyer is flagged as a repeat + rolls up the CRM", async () => {
    const r = ingestOrder(db, mkOrder('T-2'), cfg);
    assert.equal(r.created, true);
    assert.equal(r.repeat, true);
    const msgs = await get('/api/postsale/messages?status=pending');
    const m2 = msgs.json.messages.find((x) => x.order_id === 'T-2');
    assert.equal(m2.is_repeat_buyer, 1);
    const buyer = (await get('/api/postsale/buyers/testbuyer')).json.buyer;
    assert.equal(buyer.order_count, 2);
    assert.equal(buyer.total_spent_cents, 9100);
  });

  it('POST /orders/:id/shipped clears an order off the to-pack list', async () => {
    const r = await post('/api/postsale/orders/T-1/shipped');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    const o = (await get('/api/postsale/orders')).json.orders.find((x) => x.order_id === 'T-1');
    assert.equal(o.shipped_status, 'shipped');
  });
});

describe('postsale — safety', () => {
  it('GET /config exposes state but never a secret', async () => {
    const { status, json, text } = await get('/api/postsale/config');
    assert.equal(status, 200);
    assert.equal(typeof json.config.enabled, 'boolean');
    assert.ok(json.state.order_poll, 'state.order_poll present');
    assert.doesNotMatch(text, /TELEGRAM_BOT_TOKEN|EBAY_CERT_ID|DIAG_TOKEN|refresh_token|ANTHROPIC_API_KEY/i);
  });

  it('the manual poll trigger is DIAG_TOKEN-gated (a tokenless request never runs it)', async () => {
    const r = await post('/api/postsale/poll/orders');
    // 503 when DIAG_TOKEN is unset, 401 when it is set but no token was supplied — either way, gated.
    assert.ok([401, 403, 503].includes(r.status), 'expected the trigger to be gated, got ' + r.status);
    assert.ok(r.json && r.json.error);
  });

  it('GET /api/status surfaces the postsale db + jobs', async () => {
    const { status, json } = await get('/api/status');
    assert.equal(status, 200);
    assert.ok(json.dbs.postsale, 'dbs.postsale present');
    assert.equal(json.dbs.postsale.orders, 2);
    assert.ok(json.jobs.postsale && json.jobs.postsale.order_poll, 'jobs.postsale present');
    assert.ok(json.jobs.postsale.reply_poll, 'jobs.postsale.reply_poll present');
  });
});

describe('postsale — messaging (Phase 1, dry-run)', () => {
  // These drive the approve/edit/skip/reply surface WITHOUT invoking the live LLM: we seed the draft
  // body directly, so no ANTHROPIC/OPENAI call happens even though a real key is present in .env.
  const seedDraft = (id) => {
    ingestOrder(db, mkOrder(id), cfg);
    const m = db.prepare('SELECT * FROM postsale_messages WHERE order_id=?').get(id);
    db.prepare("UPDATE postsale_messages SET status='awaiting_approval', subject='Thanks!', body='Cheers for grabbing the Test Card, it will go out Monday. -BK' WHERE id=?").run(m.id);
    return db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(m.id);
  };

  it('approve (dry-run) marks the message sent without any eBay call', async () => {
    const m = seedDraft('M-1');
    const r = await post('/api/postsale/messages/' + m.id + '/approve');
    assert.equal(r.status, 200);
    assert.equal(r.json.dry_run, true);
    const fresh = db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(m.id);
    assert.equal(fresh.status, 'sent');
    assert.match(fresh.error, /dry_run/);
    assert.ok(fresh.sent_at);
    assert.equal(fresh.decided_by, 'dashboard');
  });

  it('edit rejects a body that breaks eBay off-platform-contact policy', async () => {
    const m = seedDraft('M-2');
    const r = await postJson('/api/postsale/messages/' + m.id + '/edit', { subject: 'Hi', body: 'thanks! email me at me@store.com' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /content policy/i);
  });

  it('edit accepts a clean body and keeps it awaiting approval', async () => {
    const m = seedDraft('M-4');
    const r = await postJson('/api/postsale/messages/' + m.id + '/edit', { subject: 'Cheers', body: 'Thanks so much, it will be posted Monday. -BK' });
    assert.equal(r.status, 200);
    assert.equal(r.json.message.status, 'awaiting_approval');
    assert.match(r.json.message.body, /posted Monday/);
  });

  it('skip marks the message skipped', async () => {
    const m = seedDraft('M-3');
    const r = await post('/api/postsale/messages/' + m.id + '/skip');
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT status FROM postsale_messages WHERE id=?').get(m.id).status, 'skipped');
  });

  it('a buyer reply after our send flips the message to replied (human handoff)', async () => {
    const sent = db.prepare("SELECT * FROM postsale_messages WHERE order_id='M-1'").get();
    assert.equal(sent.status, 'sent');
    const later = new Date(new Date(sent.sent_at).getTime() + 60_000).toISOString();
    const handled = await maybeHandleReply({}, db, { senderId: 'testbuyer', creationTime: later, body: 'thanks heaps!' });
    assert.equal(handled, true);
    assert.equal(db.prepare('SELECT status FROM postsale_messages WHERE id=?').get(sent.id).status, 'replied');
  });

  it('does not treat a message that predates our send as a reply', async () => {
    const m = seedDraft('M-5');
    db.prepare("UPDATE postsale_messages SET status='sent', sent_at=? WHERE id=?").run(new Date().toISOString(), m.id);
    const before = new Date(Date.now() - 3600_000).toISOString();  // one hour before our send
    const handled = await maybeHandleReply({}, db, { senderId: 'testbuyer', creationTime: before, body: 'older message' });
    assert.equal(handled, false);
    assert.equal(db.prepare('SELECT status FROM postsale_messages WHERE id=?').get(m.id).status, 'sent'); // unchanged
  });
});
