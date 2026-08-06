// test/integration/ebay-notify.integration.test.mjs — the real loopback listener, on a real socket.
//
// This is the half that cannot be unit-tested: binding, routing, the raw-body read, the status codes
// eBay reacts to, and the dedupe landing in an actual database.
//
// The port is claimed from the OS rather than hardcoded. 5274 is the production default, and a
// developer running the suite while the dev server is up would otherwise fail on EADDRINUSE — which
// is exactly the collision the config's per-instance listen_port exists to avoid.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-notify-'));
process.env.TCG_CONFIG_DIR = DIR;
process.env.TCG_POSTSALE_DB = path.join(DIR, 'postsale.db');
// The pipeline is off, which is the interesting case: events must still be received and recorded.
fs.writeFileSync(path.join(DIR, 'postsale.config.json'), JSON.stringify({ enabled: false }, null, 2));

const TOKEN = 'verif-token-'.padEnd(48, 'z');            // inside eBay's 32-80 / [A-Za-z0-9_-] rule
const PUBLIC = 'https://hooks.example.test/ebay/notifications';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const notify = await import('../../lib/ebay-notify.mjs');
const { openPostsaleDb } = await import('../../lib/postsale-db.mjs');
const verify = await import('../../lib/ebay-notify-verify.mjs');

// Seed our own key under the kid the signatures name, so the listener verifies for real without ever
// calling eBay. Everything downstream of verification is then genuinely exercised.
const seedKey = () => verify.__seedKey('test-kid', PEM);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

let PORT, BASE;
const sign = (buf) => crypto.sign('sha1', buf, { key: privateKey, dsaEncoding: 'der' }).toString('base64');
const sigHeader = (buf) => Buffer.from(JSON.stringify({ alg: 'ecdsa', kid: 'test-kid', signature: sign(buf), digest: 'SHA1' })).toString('base64');

const envelope = (id, topic = 'ORDER_CONFIRMATION', orderId = '12-34567-89012') => ({
  metadata: { topic, schemaVersion: '1.0', deprecated: false },
  notification: {
    notificationId: id, eventDate: '2026-08-06T01:00:00.000Z', publishDate: '2026-08-06T01:00:01.000Z',
    publishAttemptCount: 1,
    data: { user: { userId: 'u1', username: 'seller' }, order: { orderId, orderLineItems: [{ orderLineItemId: orderId + '-1', listingId: '999', quantity: 1 }] } },
  },
});

async function post(body, header) {
  const raw = Buffer.from(JSON.stringify(body));
  return fetch(BASE + '/ebay/notifications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(header === null ? {} : { 'x-ebay-signature': header ?? sigHeader(raw) }) },
    body: raw,
  });
}

before(async () => {
  PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  fs.writeFileSync(path.join(DIR, 'ebay-notify.config.json'), JSON.stringify({
    enabled: true, listen_host: '127.0.0.1', listen_port: PORT,
    path: '/ebay/notifications', account_deletion_path: '/ebay/account-deletion',
    public_endpoint: PUBLIC, topics: ['ORDER_CONFIRMATION'], retain_days: 30, alerts: false,
  }, null, 2));
  verify.__resetKeyCache();
  seedKey();
  notify.startNotifyListener({ EBAY_NOTIFY_VERIFICATION_TOKEN: TOKEN, EBAY_NOTIFY_DELETION_TOKEN: TOKEN });
  await new Promise((r) => setTimeout(r, 250));
});

after(() => {
  notify.stopNotifyListener();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

describe('the challenge handshake', () => {
  it('answers with sha256(code + token + endpoint), as JSON', async () => {
    const code = 'chal-abc-123';
    const r = await fetch(BASE + '/ebay/notifications?challenge_code=' + code);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const j = await r.json();
    const expected = crypto.createHash('sha256').update(code).update(TOKEN).update(PUBLIC).digest('hex');
    assert.equal(j.challengeResponse, expected);
  });

  it('hashes the PUBLIC endpoint, not the loopback address it is really bound to', async () => {
    const code = 'c2';
    const j = await fetch(BASE + '/ebay/notifications?challenge_code=' + code).then((r) => r.json());
    const wrong = crypto.createHash('sha256').update(code).update(TOKEN).update(BASE + '/ebay/notifications').digest('hex');
    assert.notEqual(j.challengeResponse, wrong, 'hashing the bind address would fail eBay validation');
  });

  it('serves the account-deletion path too, with its own endpoint', async () => {
    const code = 'c3';
    const r = await fetch(BASE + '/ebay/account-deletion?challenge_code=' + code);
    assert.equal(r.status, 200);
    const j = await r.json();
    const expected = crypto.createHash('sha256').update(code).update(TOKEN)
      .update('https://hooks.example.test/ebay/account-deletion').digest('hex');
    assert.equal(j.challengeResponse, expected);
  });

  it('400s a GET with no challenge code', async () => {
    assert.equal((await fetch(BASE + '/ebay/notifications')).status, 400);
  });
});

describe('routing — nothing but the two registered paths exists', () => {
  for (const p of ['/', '/api/status', '/api/tracker/watchlist', '/ebay', '/ebay/notifications/x', '/../api/status']) {
    it('404s ' + p, async () => {
      const r = await fetch(BASE + p);
      assert.equal(r.status, 404);
      assert.equal((await r.text()), '', 'a 404 must not hint that anything is here');
    });
  }
  it('405s a method it does not serve', async () => {
    assert.equal((await fetch(BASE + '/ebay/notifications', { method: 'PUT' })).status, 405);
  });
});

describe('POST — verification gates everything', () => {
  it('412s an unsigned notification', async () => {
    assert.equal((await post(envelope('unsigned-1'), null)).status, 412);
  });

  it('412s a signature over different bytes', async () => {
    const other = Buffer.from(JSON.stringify(envelope('other')));
    assert.equal((await post(envelope('tampered-1'), sigHeader(other))).status, 412);
  });

  it('412s a garbage signature header', async () => {
    assert.equal((await post(envelope('garbage-1'), 'not-base64!!')).status, 412);
  });

  it('stores nothing at all for any of those', () => {
    const db = openPostsaleDb();
    const n = db.prepare("SELECT COUNT(*) c FROM notify_events WHERE notification_id LIKE '%-1'").get().c;
    assert.equal(n, 0, 'an unverified POST must never reach the database');
  });
});

describe('POST — a verified notification', () => {
  before(() => { verify.__resetKeyCache(); seedKey(); });

  it('acks 204 with an empty body and records the event', async () => {
    const r = await postVerified(envelope('note-a'));
    assert.equal(r.status, 204);
    assert.equal(await r.text(), '');
    const db = openPostsaleDb();
    const row = db.prepare('SELECT * FROM notify_events WHERE notification_id=?').get('note-a');
    assert.ok(row, 'the event should be stored');
    assert.equal(row.topic, 'ORDER_CONFIRMATION');
    assert.equal(row.ref_id, '12-34567-89012', 'the order id is kept so the row is recognisable');
    assert.equal(row.publish_attempt_count, 1);
  });

  it('records it as skipped, because the pipeline is switched off', () => {
    const db = openPostsaleDb();
    const row = db.prepare('SELECT status, action FROM notify_events WHERE notification_id=?').get('note-a');
    assert.equal(row.status, 'skipped');
    assert.equal(row.action, 'postsale_disabled');
  });

  it('the SAME notification three times leaves exactly one row', async () => {
    // eBay's documented maximum is three attempts, and the safety poll re-reads the same ground.
    // This is the property the whole trigger-not-source design rests on.
    for (let i = 0; i < 3; i++) assert.equal((await postVerified(envelope('note-dupe'))).status, 204);
    const db = openPostsaleDb();
    const n = db.prepare('SELECT COUNT(*) c FROM notify_events WHERE notification_id=?').get('note-dupe').c;
    assert.equal(n, 1, 'a redelivery must be a no-op, not a second event');
  });

  it('records an unasked-for topic rather than dropping it', async () => {
    assert.equal((await postVerified(envelope('note-fb', 'FEEDBACK_RECEIVED'))).status, 204);
    const db = openPostsaleDb();
    const row = db.prepare('SELECT status, action FROM notify_events WHERE notification_id=?').get('note-fb');
    assert.equal(row.action, 'record_only');
  });

  it('400s a body that is not JSON', async () => {
    const raw = Buffer.from('not json at all');
    const r = await fetch(BASE + '/ebay/notifications', {
      method: 'POST', headers: { 'x-ebay-signature': sigHeader(raw) }, body: raw,
    });
    assert.equal(r.status, 400);
  });
});

describe('lifecycle', () => {
  it('stops cleanly and the port stops answering', async () => {
    notify.stopNotifyListener();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(notify.getNotifyState().listening, false);
    await assert.rejects(fetch(BASE + '/ebay/notifications?challenge_code=x'), 'the socket should be closed');
  });

  it('a disabled config binds nothing', async () => {
    fs.writeFileSync(path.join(DIR, 'ebay-notify.config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(DIR, 'ebay-notify.config.json'), 'utf8')), enabled: false }, null, 2));
    notify.startNotifyListener({ EBAY_NOTIFY_VERIFICATION_TOKEN: TOKEN });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(notify.getNotifyState().listening, false);
  });

  it('refuses to arm on a malformed verification token instead of failing the handshake later', async () => {
    fs.writeFileSync(path.join(DIR, 'ebay-notify.config.json'), JSON.stringify({
      enabled: true, listen_host: '127.0.0.1', listen_port: PORT, path: '/ebay/notifications',
      account_deletion_path: '/ebay/account-deletion', public_endpoint: PUBLIC, topics: ['ORDER_CONFIRMATION'],
    }, null, 2));
    notify.startNotifyListener({ EBAY_NOTIFY_VERIFICATION_TOKEN: 'too-short' });
    await new Promise((r) => setTimeout(r, 120));
    const st = notify.getNotifyState();
    assert.equal(st.listening, false);
    assert.match(st.bind_error || '', /VERIFICATION_TOKEN/);
  });
});

// A correctly signed POST against the seeded key.
async function postVerified(body) {
  const raw = Buffer.from(JSON.stringify(body));
  return fetch(BASE + '/ebay/notifications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ebay-signature': sigHeader(raw) },
    body: raw,
  });
}
