// test/unit/ebay-my-messages.test.mjs — the OTHER eBay message id, and the ten-id ceiling.
//
// GetMemberMessages and GetMyMessages both return a "MessageID" and they are NOT the same value. The
// only bridge is GetMyMessages.ExternalMessageID, which carries the member-message id. Marking a
// buyer question read means joining on that, and getting it backwards is eBay's KB-1315 "Invalid
// parent message" — an error that reads like a permissions problem and is not one.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGetMyMessagesInner, parseMyMessageHeaders, buildReviseMyMessagesInner,
  parseMemberMessages, MY_MESSAGES_ID_CAP,
} from '../../lib/ebay-trading.mjs';

// Shaped on eBay's own GetMyMessages ReturnHeaders sample: Folder nests, Read/Flagged are booleans,
// and ExternalMessageID is present on member messages and absent on eBay's own notices.
const HEADERS_XML = `<?xml version="1.0" encoding="utf-8"?>
<GetMyMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Messages>
    <Message>
      <Sender>buyer_bob</Sender>
      <MessageID>5150000123</MessageID>
      <ExternalMessageID>m_9988776655</ExternalMessageID>
      <Subject>Question about Charizard VMAX</Subject>
      <ItemID>123456789012</ItemID>
      <Read>false</Read>
      <Flagged>false</Flagged>
      <ReceiveDate>2026-08-28T22:10:00.000Z</ReceiveDate>
      <Folder><FolderID>0</FolderID></Folder>
    </Message>
    <Message>
      <Sender>eBay</Sender>
      <MessageID>5150000124</MessageID>
      <Subject>Your seller level</Subject>
      <Read>true</Read>
      <ReceiveDate>2026-08-28T20:00:00.000Z</ReceiveDate>
      <Folder><FolderID>0</FolderID></Folder>
    </Message>
  </Messages>
</GetMyMessagesResponse>`;

describe('parseMyMessageHeaders', () => {
  const rows = parseMyMessageHeaders(HEADERS_XML);

  it('reads one row per message, not one per MessageID element', () => {
    // <MessageID> must not be mistaken for <Message>; the tag regex requires a > or whitespace.
    assert.equal(rows.length, 2);
  });

  it('keeps the two ids apart', () => {
    assert.equal(rows[0].messageId, '5150000123', 'the My Messages id — what ReviseMyMessages wants');
    assert.equal(rows[0].externalMessageId, 'm_9988776655', 'the member-message id — what the alert arrives with');
    assert.notEqual(rows[0].messageId, rows[0].externalMessageId);
  });

  it('carries the read flag as a boolean and the folder from its nested element', () => {
    assert.equal(rows[0].read, false);
    assert.equal(rows[1].read, true);
    assert.equal(rows[0].folderId, '0');
  });

  it('leaves an eBay notice with no external id, so it can never join onto a member message', () => {
    assert.equal(rows[1].externalMessageId, null);
  });

  it('reports an absent flag as null rather than a confident false', () => {
    assert.equal(rows[1].flagged, null, "eBay did not say, and 'not flagged' would be a different claim");
  });

  it('never throws on rubbish', () => {
    assert.deepEqual(parseMyMessageHeaders(''), []);
    assert.deepEqual(parseMyMessageHeaders('<html>503</html>'), []);
  });
});

describe('the ten-id ceiling is enforced, not silently applied', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => 'id' + i);

  it('GetMyMessages throws rather than dropping the eleventh', () => {
    // A silent slice is the bad failure: the caller believes it asked about eleven messages, one comes
    // back unmapped, and the bug surfaces later as a button that does nothing.
    assert.throws(() => buildGetMyMessagesInner({ messageIds: eleven }), /at most 10/i);
    assert.doesNotThrow(() => buildGetMyMessagesInner({ messageIds: eleven.slice(0, MY_MESSAGES_ID_CAP) }));
  });

  it('ReviseMyMessages throws too, and refuses an empty list', () => {
    assert.throws(() => buildReviseMyMessagesInner({ messageIds: eleven, read: true }), /at most 10/i);
    assert.throws(() => buildReviseMyMessagesInner({ messageIds: [], read: true }), /at least one/i);
  });
});

describe('buildGetMyMessagesInner', () => {
  it('always sends a DetailLevel, because eBay errors without one', () => {
    assert.match(buildGetMyMessagesInner({}), /<DetailLevel>ReturnHeaders<\/DetailLevel>/);
  });

  it('passes the window through, which is what stops ReturnHeaders returning the whole mailbox', () => {
    const xml = buildGetMyMessagesInner({ startTime: '2026-08-01T00:00:00.000Z', endTime: '2026-08-02T00:00:00.000Z' });
    assert.match(xml, /<StartTime>2026-08-01T00:00:00\.000Z<\/StartTime>/);
    assert.match(xml, /<EndTime>2026-08-02T00:00:00\.000Z<\/EndTime>/);
    assert.doesNotMatch(xml, /<MessageIDs>/, 'no ids means "everything in the window", which is the intended call');
  });
});

describe('buildReviseMyMessagesInner', () => {
  it('sends only the state it was asked to change', () => {
    const read = buildReviseMyMessagesInner({ messageIds: ['1'], read: true });
    assert.match(read, /<Read>true<\/Read>/);
    assert.doesNotMatch(read, /<Flagged>/, 'eBay applies every field present to every id — do not send one we did not mean');
  });
});

describe('parseMemberMessages carries the type', () => {
  it('reads MessageType, so a row under MailMessageType=All is not stamped with the request', () => {
    const xml = `<GetMemberMessagesResponse><MemberMessageExchange>
      <Question><MessageID>m1</MessageID><SenderID>buyer_bob</SenderID><Subject>hi</Subject><Body>is it holo?</Body></Question>
      <MessageType>ContactTransactionPartner</MessageType>
      <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-08-28T22:10:00.000Z</CreationDate>
    </MemberMessageExchange></GetMemberMessagesResponse>`;
    const { messages } = parseMemberMessages(xml);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].messageType, 'ContactTransactionPartner');
    assert.equal(messages[0].status, 'Unanswered');
  });
});
