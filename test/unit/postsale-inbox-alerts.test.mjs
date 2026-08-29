// test/unit/postsale-inbox-alerts.test.mjs — every message reaches a person, exactly once.
//
// member_messages was write-only: the poll filled it in and the only two consumers were
// maybeHandleReply (needs a known buyer with a prior sent message) and the deal classifier (needs
// deals.enabled, which ships off). A pre-sale question from a stranger was stored and read by nobody.
//
// The rules pinned here are the ones that would be embarrassing rather than merely broken: two
// notifications for one message, an alert about a message we sent ourselves, a stamp written for a
// card that never arrived, and a nag sweep that moves the cursor and re-alerts the whole window.
//
// TCG_CONFIG_DIR / TCG_POSTSALE_DB must be set BEFORE lib/postsale.mjs loads (both resolve at module
// scope), hence the dynamic import — same pattern as postsale-message-dedupe.test.mjs.
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.tmpdir(), 'tcg-postsale-inbox-' + process.pid);
fs.mkdirSync(DIR, { recursive: true });
const CFG = path.join(DIR, 'postsale.config.json');
const writeCfg = (extra = {}) => fs.writeFileSync(CFG, JSON.stringify({
  enabled: true, messaging: false, alerts: true, dry_run: true,
  quiet_hours: { enabled: false, start: '21:00', end: '08:00' },
  deals: { enabled: false, detect_from_messages: true, expire_hours: 72 },
  inbox_alerts: { enabled: true, message_types: 'All', max_alerts_per_run: 10, preview_chars: 400,
    mark_read_button: false, nag_after_hours: 6, nag_max: 2, nag_window_hours: 168, inbox_url: '' },
  ...extra,
}, null, 2));
writeCfg();
process.env.TCG_CONFIG_DIR = DIR;
process.env.TCG_POSTSALE_DB = path.join(DIR, 'postsale.db');

const { pollMemberMessages, sweepOpenMessages, fireInboxAlert, inboxAlertsOn } =
  await import('../../lib/postsale.mjs');
const { openPostsaleDb, getMeta, setMeta } = await import('../../lib/postsale-db.mjs');

const db = openPostsaleDb();
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

// A token + chat id make the Telegram guards pass; the sender is injected, so nothing leaves the box.
const ENV = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '-1001234567890' };
const loadCfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));

const MSG = (over = {}) => ({
  messageId: 'm1', senderId: 'buyer_bob', itemId: '123456789012',
  subject: 'Is this the alt art?', body: 'Hi mate, is this the alt art version?',
  status: 'Unanswered', creationTime: '2026-08-28T22:10:00.000Z', messageType: 'AskSellerQuestion',
  ...over,
});
// One page of results, then empty — the poll loops until hasMore is false.
const fetchOnce = (messages) => {
  let n = 0;
  return async () => (n++ ? { ok: true, messages: [], hasMore: false } : { ok: true, messages, hasMore: false });
};
const recorder = () => {
  const sent = [];
  return { sent, send: async (_env, m) => { sent.push(m); return { ok: true, result: { message_id: 900 + sent.length } }; } };
};

beforeEach(() => {
  db.exec('DELETE FROM member_messages');
  setMeta(db, 'messages_cursor', '2026-08-28T00:00:00.000Z');
  setMeta(db, 'ebay_username', 'binderskeepers');       // pre-cached, so no GetUser round trip
  writeCfg();
});

describe('an ordinary message becomes exactly one card', () => {
  it('alerts, and stamps only after the send succeeded', async () => {
    const { sent, send } = recorder();
    const r = await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG()]), send });
    assert.equal(r.ok, true);
    assert.equal(r.alerts, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /eBay MESSAGE/);
    assert.match(sent[0].text, /@buyer_bob/);
    assert.match(sent[0].text, /alt art version/, 'the preview is the point — there is no per-message deep link');
    const row = db.prepare('SELECT * FROM member_messages WHERE message_id=?').get('m1');
    assert.ok(row.alert_sent_at, 'stamped');
    assert.equal(row.telegram_message_id, 901, 'the card is remembered so a later tap can edit it in place');
  });

  it('links to the inbox and to the item, since only one of those can be a deep link', async () => {
    const { sent, send } = recorder();
    await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG()]), send });
    const urls = sent[0].buttons.flat().map((b) => b.url).filter(Boolean);
    assert.ok(urls.some((u) => /ebay\.com\.au\/cnt\/ViewMessage/.test(u)), 'the inbox');
    assert.ok(urls.some((u) => /ebay\.com\.au\/itm\/123456789012/.test(u)), 'the item it is about');
  });

  it('does not stamp when Telegram refused, so the next pass tries again', async () => {
    const send = async () => ({ ok: false, description: 'Bad Request' });
    const r = await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG()]), send });
    assert.equal(r.alerts, 0);
    const row = db.prepare('SELECT alert_sent_at FROM member_messages WHERE message_id=?').get('m1');
    assert.equal(row.alert_sent_at, null, 'a stamp here would swallow the message for good');
  });

  it('never sends twice for one message, however often the window is re-read', async () => {
    const { sent, send } = recorder();
    await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG()]), send });
    setMeta(db, 'messages_cursor', '2026-08-28T00:00:00.000Z');   // the cursor overlaps by design
    await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG()]), send });
    assert.equal(sent.length, 1);
  });

  it('is off unless it is switched on, but the message is still stored', async () => {
    writeCfg({ inbox_alerts: { ...loadCfg().inbox_alerts, enabled: false } });
    const { sent, send } = recorder();
    const r = await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG()]), send });
    assert.equal(r.alerts, 0);
    assert.equal(sent.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM member_messages').get().c, 1);
  });
});

describe('a message we sent is not news', () => {
  it('drops it before it is stored or announced', async () => {
    const { sent, send } = recorder();
    // Only reachable under MailMessageType=All, where the post-sale messenger own output comes back
    // at us. Without this the bot alerts on its own thank-you notes.
    const r = await pollMemberMessages(ENV, db, {
      fetchMessages: fetchOnce([MSG({ senderId: 'BindersKeepers' })]), send,
    });
    assert.equal(r.mine, 1);
    assert.equal(r.alerts, 0);
    assert.equal(sent.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM member_messages').get().c, 0);
  });

  it('matches the username case-insensitively, the way eBay renders it', async () => {
    const { sent, send } = recorder();
    const r = await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG({ senderId: 'binderskeepers' })]), send });
    assert.equal(r.mine, 1);
    assert.equal(sent.length, 0);
  });
});

describe('one card per message, chosen by specificity', () => {
  it('stays quiet when the deal classifier already carded it', async () => {
    writeCfg({ deals: { enabled: true, detect_from_messages: true, expire_hours: 72 } });
    const { send } = recorder();
    const r = await pollMemberMessages(ENV, db, {
      fetchMessages: fetchOnce([MSG({ body: 'whats your best price on these two?' })]), send,
    });
    assert.equal(r.deals, 1, 'the deal card claimed it');
    assert.equal(r.alerts, 0, 'a second card for one message teaches you that two pings mean one event');
  });

  it('still cards an ordinary question while deal detection is on', async () => {
    writeCfg({ deals: { enabled: true, detect_from_messages: true, expire_hours: 72 } });
    const { send } = recorder();
    const r = await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG()]), send });
    assert.equal(r.deals, 0);
    assert.equal(r.alerts, 1);
  });
});

describe('the per-run cap counts the overflow rather than hiding it', () => {
  it('sends the cap, then one line saying how many are waiting', async () => {
    writeCfg({ inbox_alerts: { ...loadCfg().inbox_alerts, max_alerts_per_run: 2 } });
    const { sent, send } = recorder();
    const many = [1, 2, 3, 4, 5].map((i) => MSG({ messageId: 'm' + i }));
    const r = await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce(many), send });
    assert.equal(r.alerts, 2);
    assert.equal(r.suppressed, 3);
    assert.equal(sent.length, 3, 'two cards plus the overflow notice');
    assert.match(sent[2].text, /3 more messages/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM member_messages').get().c, 5, 'every message is still stored');
  });
});

describe('the nag', () => {
  const seedAlerted = () => {
    db.prepare(`INSERT INTO member_messages
      (message_id, message_type, sender_id, ebay_item_id, subject, body, status, creation_time, alert_sent_at, nag_count)
      VALUES ('m1','AskSellerQuestion','buyer_bob','123456789012','Is this the alt art?','well?','Unanswered',
              '2026-08-28T22:10:00.000Z', datetime('now','-9 hours'), 0)`).run();
  };

  it('nudges a message eBay still calls unanswered', async () => {
    seedAlerted();
    const { sent, send } = recorder();
    const r = await sweepOpenMessages(ENV, db, loadCfg(), { fetchMessages: fetchOnce([]), send });
    assert.equal(r.nagged, 1);
    assert.match(sent[0].text, /STILL UNANSWERED/);
    assert.equal(db.prepare('SELECT nag_count FROM member_messages WHERE message_id=?').get('m1').nag_count, 1);
  });

  it('stops once eBay says it was answered', async () => {
    seedAlerted();
    const { sent, send } = recorder();
    const r = await sweepOpenMessages(ENV, db, loadCfg(), {
      fetchMessages: fetchOnce([MSG({ status: 'Answered' })]), send,
    });
    assert.equal(r.nagged, 0);
    assert.equal(sent.length, 0);
  });

  it('stops when a human taps Handled', async () => {
    seedAlerted();
    db.prepare("UPDATE member_messages SET handled_at=datetime('now'), handled_by='marty' WHERE message_id='m1'").run();
    const { sent, send } = recorder();
    const r = await sweepOpenMessages(ENV, db, loadCfg(), { fetchMessages: fetchOnce([]), send });
    assert.equal(r.nagged, 0);
    assert.equal(sent.length, 0);
  });

  it('gives up after nag_max, rather than becoming an alarm you learn to ignore', async () => {
    seedAlerted();
    db.prepare("UPDATE member_messages SET nag_count=2 WHERE message_id='m1'").run();
    const { send } = recorder();
    const r = await sweepOpenMessages(ENV, db, loadCfg(), { fetchMessages: fetchOnce([]), send });
    assert.equal(r.open, 0);
  });

  it('defers through quiet hours instead of buzzing at 5am', async () => {
    seedAlerted();
    // A window covering the whole clock, so the result cannot depend on when the suite runs.
    writeCfg({ quiet_hours: { enabled: true, start: '00:00', end: '23:59' } });
    const { sent, send } = recorder();
    const r = await sweepOpenMessages(ENV, db, loadCfg(), { fetchMessages: fetchOnce([]), send });
    assert.equal(r.nagged, 0);
    assert.equal(r.deferred, 1, 'deferred, not dropped');
    assert.equal(sent.length, 0);
    assert.equal(db.prepare('SELECT nag_count FROM member_messages WHERE message_id=?').get('m1').nag_count, 0);
  });

  it('NEVER moves messages_cursor', async () => {
    // The whole hazard of the sweep: it deliberately re-reads a window the main poll has already been
    // through. Writing the cursor from here would either re-alert everything in between, or skip
    // whatever arrived meanwhile.
    seedAlerted();
    const before = getMeta(db, 'messages_cursor');
    const { send } = recorder();
    await sweepOpenMessages(ENV, db, loadCfg(), { fetchMessages: fetchOnce([MSG({ status: 'Unanswered' })]), send });
    assert.equal(getMeta(db, 'messages_cursor'), before);
  });
});

describe('inboxAlertsOn', () => {
  it('reads the switch and nothing else', () => {
    assert.equal(inboxAlertsOn({ inbox_alerts: { enabled: true } }), true);
    assert.equal(inboxAlertsOn({ inbox_alerts: { enabled: false } }), false);
    assert.equal(inboxAlertsOn({}), false);
    assert.equal(inboxAlertsOn(null), false);
  });
});

describe('fireInboxAlert on its own', () => {
  it('refuses a second card for a message already alerted', async () => {
    db.prepare(`INSERT INTO member_messages (message_id, sender_id, subject, body, status, creation_time, alert_sent_at)
                VALUES ('m1','buyer_bob','hi','hello','Unanswered','2026-08-28T22:10:00.000Z',datetime('now'))`).run();
    const { sent, send } = recorder();
    const r = await fireInboxAlert(ENV, db, 'm1', loadCfg(), { send });
    assert.equal(r.skipped, 'already_alerted');
    assert.equal(sent.length, 0);
  });

  it('says so plainly when there is no Telegram configured', async () => {
    db.prepare(`INSERT INTO member_messages (message_id, sender_id, subject, body, status, creation_time)
                VALUES ('m2','buyer_bob','hi','hello','Unanswered','2026-08-28T22:10:00.000Z')`).run();
    const r = await fireInboxAlert({}, db, 'm2', loadCfg(), { send: async () => ({ ok: true, result: {} }) });
    assert.equal(r.skipped, 'no_telegram');
  });
});

describe('inbox-only mode', () => {
  // The gate lives in TWO places and both are load-bearing: startPostsaleJobs returns early on
  // !enabled (so the timers never arm at all), and pollMemberMessages skips on the same flag. Turning
  // on inbox alerts must relax both — and must NOT quietly start ingesting orders, decrementing stock
  // and sending sale alerts, which is what arming the order poll here would do.
  const inboxOnly = () => writeCfg({ enabled: false, inbox_alerts: { ...loadCfg().inbox_alerts, enabled: true } });

  it('arms the message timer and nothing else', async () => {
    const { startPostsaleJobs, stopPostsaleJobs } = await import('../../lib/postsale.mjs');
    inboxOnly();
    try {
      startPostsaleJobs(ENV, db);
      assert.ok(globalThis.__postsaleMsgTimer, 'the message poll is the whole point');
      assert.ok(!globalThis.__postsaleOrderTimer, 'the order poll would ingest orders nobody asked it to');
      assert.ok(!globalThis.__postsalePackTimer, 'and the digest would start messaging about them');
    } finally { stopPostsaleJobs(); }
  });

  it('arms everything again once order sync is back on', async () => {
    const { startPostsaleJobs, stopPostsaleJobs } = await import('../../lib/postsale.mjs');
    writeCfg();
    try {
      startPostsaleJobs(ENV, db);
      assert.ok(globalThis.__postsaleOrderTimer);
      assert.ok(globalThis.__postsaleMsgTimer);
      assert.ok(globalThis.__postsalePackTimer);
    } finally { stopPostsaleJobs(); }
  });

  it('stays off entirely when both switches are off', async () => {
    const { startPostsaleJobs, stopPostsaleJobs } = await import('../../lib/postsale.mjs');
    writeCfg({ enabled: false, inbox_alerts: { ...loadCfg().inbox_alerts, enabled: false } });
    try {
      startPostsaleJobs(ENV, db);
      assert.ok(!globalThis.__postsaleMsgTimer);
      assert.ok(!globalThis.__postsaleOrderTimer);
    } finally { stopPostsaleJobs(); }
  });

  it('still polls and cards, without the reply handoff or the deal queue firing', async () => {
    inboxOnly();
    const { sent, send } = recorder();
    const r = await pollMemberMessages(ENV, db, {
      fetchMessages: fetchOnce([MSG({ body: 'whats your best price on these two?' })]), send,
    });
    assert.equal(r.ok, true);
    assert.equal(r.alerts, 1, 'the inbox alert is the one thing that should happen');
    assert.equal(r.replies, 0, 'no prior sent message exists, so the handoff cannot fire');
    assert.equal(r.deals, 0, 'deals.enabled is off, so the classifier writes nothing');
    assert.equal(sent.length, 1);
  });
});

describe('a message id too long for Telegram costs its buttons, not the card', () => {
  it('still alerts when callback_data would blow the 64-byte limit', async () => {
    // Telegram rejects the whole sendMessage over that limit, which would leave alert_sent_at
    // unstamped and re-fail every pass forever. The card matters more than the buttons.
    const huge = 'm'.repeat(120);
    const { sent, send } = recorder();
    const r = await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG({ messageId: huge })]), send });
    assert.equal(r.alerts, 1, 'the card still went');
    const data = sent[0].buttons.flat().map((b) => b.data).filter(Boolean);
    assert.equal(data.length, 0, 'and it carried no oversized callback');
    for (const b of sent[0].buttons.flat()) assert.ok(b.url || b.data, 'every button does something');
  });

  it('keeps the buttons for an ordinary id', async () => {
    const { sent, send } = recorder();
    await pollMemberMessages(ENV, db, { fetchMessages: fetchOnce([MSG()]), send });
    const data = sent[0].buttons.flat().map((b) => b.data).filter(Boolean);
    assert.deepEqual(data, ['pmd:m1'], 'Handled is offered; Mark read waits on the id sweep');
  });
});
