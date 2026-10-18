// test/integration/postsale-send-guards.test.mjs — the dashboard routes around a buyer message, against
// the real dev server: a stale message cannot be sent, a sent one cannot be skipped, edited or redrafted
// back into a draft, a send in flight cannot be doubled, and the backlog clear-out is DIAG-gated and
// dry-run by default (audit 2026-10, P1 + P5).
//
// Offline by construction: bootServer blanks every eBay and Telegram credential, and the config below
// keeps dry_run ON, so an Approve that gets through records the approval and calls nothing. The send
// path's own eBay seam is covered with a stub in test/unit/postsale-expiry.test.mjs.
//
// lib/postsale-db.mjs resolves its DB path at module load, so the postsale modules are imported only
// after bootServer has pointed TCG_POSTSALE_DB at a temp file.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootServer } from '../helpers/boot-server.mjs';

const TOKEN = 'test-diag-token-psguards';
let srv, db, ps, cfg;

const HOUR = 3_600_000;
const sqlAt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
let seq = 0;
const mkOrder = (id) => ({
  orderId: id, buyerUsername: 'guard_' + id.toLowerCase(), orderStatus: 'Completed', checkoutStatus: 'Complete',
  paidStatus: 'NoPaymentFailure', createdTime: '2026-10-10T01:00:00.000Z', paidTime: '2026-10-10T01:05:00.000Z',
  shippedTime: null, currency: 'AUD', totalCents: 1200, subtotalCents: 1000, shippingCents: 200,
  shipService: 'AU_Regular', paid: true,
  ship: { name: 'Test Buyer', street1: '1 Test St', street2: null, city: 'Sydney', state: 'NSW', postal: '2000', country: 'AU', countryName: 'Australia', phone: null },
  items: [{ orderLineItemId: id + '-1', transactionId: 'tx-' + id, itemId: '8800' + id.replace(/\D/g, ''), sku: 'AAA-002', title: 'Guard Card', quantity: 1, unitPriceCents: 1000 }],
});
// One order, its thank-you in the state asked for. created_at is aged against the real clock, which is
// what the server compares it with.
function seed({ status = 'awaiting_approval', ageH = 1, shipped = false } = {}) {
  const id = 'G-' + (++seq);
  ps.ingestOrder(db, mkOrder(id), cfg);
  if (shipped) db.prepare("UPDATE orders SET shipped_status='shipped' WHERE order_id=?").run(id);
  const at = sqlAt(Date.now() - ageH * HOUR);
  db.prepare(`UPDATE postsale_messages SET status=?, subject='Thanks!', body='Cheers, packed and sent tomorrow. -BK',
              created_at=?, updated_at=? WHERE order_id=?`).run(status, at, at, id);
  return db.prepare('SELECT * FROM postsale_messages WHERE order_id=?').get(id);
}
const row = (id) => db.prepare('SELECT * FROM postsale_messages WHERE id=?').get(id);

const req = async (method, p, body, headers = {}) => {
  const r = await fetch(srv.base + p, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const post = (p, body, headers) => req('POST', p, body, headers);
const auth = { authorization: 'Bearer ' + TOKEN };

before(async () => {
  srv = await bootServer({ env: { DIAG_TOKEN: TOKEN } });
  // Written, not inherited: the copied config is whatever this machine has, and these tests need
  // dry_run ON (no eBay call can happen even in principle) and approve mode.
  fs.writeFileSync(srv.configFile('postsale.config.json'), JSON.stringify({
    enabled: false, mode: 'approve', dry_run: true, messaging: true, holidays: [],
    quiet_hours: { enabled: false, start: '21:00', end: '08:00' },
  }, null, 2) + '\n');
  ps = await import('../../lib/postsale.mjs');
  const psdb = await import('../../lib/postsale-db.mjs');
  db = psdb.openPostsaleDb();
  cfg = ps.loadConfig();
}, { timeout: 60_000 });
after(async () => { await srv?.close(); });

describe('POST /messages/:id/approve — re-checks the order before anything is sent', () => {
  it('refuses a thank-you on an order that has already shipped, and retires it', async () => {
    const m = seed({ shipped: true });
    const r = await post(`/api/postsale/messages/${m.id}/approve`);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'expired');
    assert.equal(r.json.error, 'not sent: order already shipped', 'the dashboard prints `error`, so it carries the reason');
    assert.equal(row(m.id).status, 'expired');
    assert.equal(row(m.id).sent_at, null);
  });

  it('refuses a draft older than the thank-you window', async () => {
    const m = seed({ ageH: 30 });
    const r = await post(`/api/postsale/messages/${m.id}/approve`);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /older than 1 day/);
    assert.equal(row(m.id).status, 'expired');
  });

  it('refuses when the buyer has written to us since paying', async () => {
    const m = seed();
    db.prepare(`INSERT INTO member_messages (message_id, sender_id, body, creation_time) VALUES (?, ?, 'hey, can you combine?', '2026-10-12T00:00:00.000Z')`)
      .run('mm-guard-' + m.id, 'guard_' + m.order_id.toLowerCase());
    const r = await post(`/api/postsale/messages/${m.id}/approve`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'buyer_in_contact');
    assert.equal(row(m.id).status, 'skipped');
  });

  it('refuses a message another tap is sending right now', async () => {
    const m = seed({ status: 'sending' });
    const r = await post(`/api/postsale/messages/${m.id}/approve`);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already being sent/);
    assert.equal(row(m.id).status, 'sending', 'the refusal must not disturb the send in flight');
  });

  it('still sends (dry-run) a fresh, welcome thank-you', async () => {
    const m = seed();
    const r = await post(`/api/postsale/messages/${m.id}/approve`);
    assert.equal(r.status, 200, r.text);
    assert.equal(row(m.id).status, 'sent');
    // A second Approve on the same message is now a refusal, not a second send.
    const again = await post(`/api/postsale/messages/${m.id}/approve`);
    assert.equal(again.status, 409);
    assert.equal(row(m.id).status, 'sent');
  });
});

describe('POST /messages/:id/skip — only something still undecided', () => {
  it('refuses a sent message and leaves the record of the send intact', async () => {
    const m = seed({ status: 'sent' });
    db.prepare("UPDATE postsale_messages SET sent_at=? WHERE id=?").run(new Date().toISOString(), m.id);
    const r = await post(`/api/postsale/messages/${m.id}/skip`);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /cannot skip a message that is sent/);
    assert.equal(row(m.id).status, 'sent');
    assert.ok(row(m.id).sent_at);
  });

  it('refuses a message mid-send and one already expired', async () => {
    const sending = seed({ status: 'sending' });
    assert.equal((await post(`/api/postsale/messages/${sending.id}/skip`)).status, 409);
    assert.equal(row(sending.id).status, 'sending');
    const expired = seed({ status: 'expired' });
    assert.equal((await post(`/api/postsale/messages/${expired.id}/skip`)).status, 409);
    assert.equal(row(expired.id).status, 'expired', 'skipping would erase why it was retired');
  });

  it('still skips a draft waiting for approval', async () => {
    const m = seed();
    const r = await post(`/api/postsale/messages/${m.id}/skip`);
    assert.equal(r.status, 200);
    assert.equal(row(m.id).status, 'skipped');
  });
});

describe('a sent message cannot be turned back into a draft', () => {
  it('edit refuses it (an edit re-arms Approve)', async () => {
    const m = seed({ status: 'sent' });
    const r = await post(`/api/postsale/messages/${m.id}/edit`, { subject: 'Hi', body: 'Thanks again! -BK' });
    assert.equal(r.status, 409);
    assert.equal(row(m.id).status, 'sent');
    assert.equal(row(m.id).body, 'Cheers, packed and sent tomorrow. -BK');
  });

  it('regenerate refuses it (a redraft ends in a send in auto mode)', async () => {
    const m = seed({ status: 'sent' });
    const r = await post(`/api/postsale/messages/${m.id}/regenerate`);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'already_sent');
    assert.equal(row(m.id).status, 'sent');
  });
});

describe('POST /diag/expire-messages — clear a stale backlog by hand', () => {
  let stale, fresh;
  before(() => {
    // Everything undecided so far is retired first, so the counts below are this block's alone.
    db.prepare("UPDATE postsale_messages SET status='skipped' WHERE status IN ('pending','drafted','awaiting_approval','failed')").run();
    stale = [seed({ shipped: true }), seed({ ageH: 75 * 24 })];
    fresh = seed();
  });

  it('is DIAG_TOKEN-gated: no token, nothing runs', async () => {
    const r = await post('/api/postsale/diag/expire-messages?apply=1');
    assert.equal(r.status, 401);
    for (const m of stale) assert.equal(row(m.id).status, 'awaiting_approval');
  });

  it('is a dry run by default, and names every message it would retire', async () => {
    const r = await post('/api/postsale/diag/expire-messages', null, auth);
    assert.equal(r.status, 200, r.text);
    const res = r.json.result;
    assert.equal(res.dry_run, true);
    assert.deepEqual(res.expired.map((e) => e.id).sort((a, b) => a - b), stale.map((m) => m.id).sort((a, b) => a - b));
    const old = res.expired.find((e) => e.id === stale[1].id);
    assert.ok(old.age_days >= 74, 'the age is reported so the owner can sanity-check the list');
    for (const m of stale) assert.equal(row(m.id).status, 'awaiting_approval', 'a dry run wrote');
  });

  it('all=1 widens the dry run to every undecided message', async () => {
    const r = await post('/api/postsale/diag/expire-messages?all=1', null, auth);
    const f = r.json.result.expired.find((e) => e.id === fresh.id);
    assert.equal(f.reason, 'retired by hand');
    assert.equal(row(fresh.id).status, 'awaiting_approval');
  });

  it('apply=1 retires them, and only them', async () => {
    const r = await post('/api/postsale/diag/expire-messages?apply=1', null, auth);
    assert.equal(r.json.result.dry_run, false);
    assert.equal(r.json.result.expired.length, 2);
    for (const m of stale) {
      assert.equal(row(m.id).status, 'expired');
      assert.equal(row(m.id).decided_by, 'diag');
    }
    assert.equal(row(fresh.id).status, 'awaiting_approval');
  });
});

describe('message_expiry config — backfilled, and validated on save', () => {
  it('a config file from before message_expiry gets the defaults written in', async () => {
    const file = srv.configFile('postsale.config.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(before.message_expiry, undefined);
    ps.ensureConfigSeeded();
    const afterSeed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(afterSeed.message_expiry, { purchase_hours: 24, dispatch_hours: 72, delivered_hours: 120 });
  });

  it('PUT /api/settings/postsale refuses a threshold that would read as "no limit"', async () => {
    const content = (await req('GET', '/api/settings/postsale')).json.content;
    for (const bad of [{ purchase_hours: '24' }, { dispatch_hours: -1 }, { delivered_hours: 1.5 }, 'soon']) {
      const r = await req('PUT', '/api/settings/postsale', { ...content, message_expiry: typeof bad === 'string' ? bad : { ...content.message_expiry, ...bad } });
      assert.equal(r.status, 400, JSON.stringify(bad) + ' was accepted');
      assert.match(r.json.error, /message_expiry/);
    }
  });
});
