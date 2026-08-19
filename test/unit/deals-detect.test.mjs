// test/unit/deals-detect.test.mjs — a buyer message becoming a deal_requests row.
//
// The classifier itself is covered in deals-classify.test.mjs. What is here is the wiring: the config
// gate, the dedupe that stops one ask becoming two Send buttons, and the fact that a stranger with no
// buyer row still gets queued — which is the hole this closes, since maybeHandleReply only ever fires
// for a KNOWN buyer with a PRIOR sent message.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPostsaleDbAt } from '../../lib/postsale-db.mjs';
import { recordDealFromMessage, synthMessageId } from '../../lib/postsale.mjs';

const ON = { deals: { enabled: true, detect_from_messages: true, expire_hours: 72 } };

let tmpdir, n = 0;
before(() => { tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-dealdet-')); });
after(() => { try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {} });
const freshDb = () => openPostsaleDbAt(path.join(tmpdir, `d${++n}.db`));

const msg = (over = {}) => ({
  messageId: 'M-1', senderId: 'buyer_bob', itemId: '2255001',
  subject: 'Bundle deal?', body: 'any chance of a discount if I take both?',
  creationTime: '2026-08-10T01:00:00.000Z', ...over,
});
const deals = (db) => db.prepare('SELECT * FROM deal_requests ORDER BY id').all();

describe('recordDealFromMessage', () => {
  it('queues a deal ask, recording the kind and which rules fired', () => {
    const db = freshDb();
    assert.ok(recordDealFromMessage(db, msg(), ON) > 0, 'returns the new row id');
    const [d] = deals(db);
    assert.equal(d.source, 'message');
    assert.equal(d.message_id, 'M-1');
    assert.equal(d.ebay_username, 'buyer_bob');
    assert.equal(d.status, 'pending');
    assert.equal(d.detected_kind, 'discount');
    assert.ok(JSON.parse(d.matched_terms).length, 'should record why it fired');
    assert.ok(d.expires_at, 'a quote nobody acts on should stop being offered');
  });

  it('queues a STRANGER — the case nothing else in the pipeline reaches', () => {
    // maybeHandleReply returns false with no buyers row and no prior sent message, so before this a
    // pre-sale question from somebody who has never bought was stored and silently ignored.
    const db = freshDb();
    assert.ok(recordDealFromMessage(db, msg({ senderId: 'never_bought_here' }), ON) > 0);
    const [d] = deals(db);
    assert.equal(d.buyer_id, null, 'no buyer row, and that must not stop the queue');
    assert.equal(d.ebay_username, 'never_bought_here');
  });

  it('links a known buyer when there is one', () => {
    const db = freshDb();
    const id = db.prepare('INSERT INTO buyers (ebay_username) VALUES (?)').run('buyer_bob').lastInsertRowid;
    recordDealFromMessage(db, msg(), ON);
    assert.equal(deals(db)[0].buyer_id, Number(id));
  });

  it('ignores an ordinary question', () => {
    const db = freshDb();
    assert.equal(recordDealFromMessage(db, msg({ subject: '', body: 'is this card still available?' }), ON), 0);
    assert.equal(deals(db).length, 0);
  });

  it('DEDUPES a re-read message — the poll window overlaps by design', () => {
    // The cursor overlaps deliberately and a nudge can start a run mid-window, so the same message is
    // seen again routinely. A second row would mean a second card and a second Send button for one ask.
    const db = freshDb();
    assert.ok(recordDealFromMessage(db, msg(), ON) > 0, 'returns the new row id');
    assert.equal(recordDealFromMessage(db, msg(), ON), 0, 'second read must change nothing');
    assert.equal(deals(db).length, 1);
  });

  it('lets the SAME buyer ask again once the first quote is closed', () => {
    const db = freshDb();
    recordDealFromMessage(db, msg(), ON);
    db.prepare("UPDATE deal_requests SET status='sent' WHERE message_id='M-1'").run();
    assert.ok(recordDealFromMessage(db, msg({ messageId: 'M-2' }), ON) > 0);
    assert.equal(deals(db).length, 2);
  });

  it('falls back to a synthetic id for a message eBay sent with no MessageID', () => {
    const db = freshDb();
    const m = msg({ messageId: null });
    assert.ok(recordDealFromMessage(db, m, ON) > 0);
    assert.equal(deals(db)[0].message_id, synthMessageId(m));
  });

  it('SHIPS OFF — nothing is queued until the capability is switched on', () => {
    const db = freshDb();
    assert.equal(recordDealFromMessage(db, msg(), {}), 0, 'no deals config at all');
    assert.equal(recordDealFromMessage(db, msg(), { deals: { enabled: false } }), 0);
    assert.equal(recordDealFromMessage(db, msg(), { deals: { enabled: true, detect_from_messages: false } }), 0,
      'message detection has its own switch, so the push lane can run without it');
    assert.equal(deals(db).length, 0);
  });

  it('does not choke on an empty or malformed message', () => {
    const db = freshDb();
    assert.equal(recordDealFromMessage(db, { messageId: 'E-1' }, ON), 0);
    assert.equal(recordDealFromMessage(db, { messageId: 'E-2', subject: null, body: null }, ON), 0);
  });
});
