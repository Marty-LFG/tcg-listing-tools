// test/unit/telegram.test.mjs — Telegram client formatting + degradation (lib/telegram.mjs).
// No network: every call short-circuits before fetch when TELEGRAM_BOT_TOKEN is unset (GR7).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, telegramEnabled, telegramChatConfigured, sendMessage, editMessageText,
  isAllowedUser, parseUserIds, denyCallbackText, sendCard, CAPTION_LIMIT,
  pinChatMessage, unpinChatMessage,
} from '../../lib/telegram.mjs';

describe('escapeHtml', () => {
  it('escapes exactly &, <, > (HTML parse mode)', () => {
    assert.equal(escapeHtml('<b>A & B</b>'), '&lt;b&gt;A &amp; B&lt;/b&gt;');
  });
  it("leaves card-name characters alone (apostrophes, slashes, dashes)", () => {
    assert.equal(escapeHtml("Kai'Sa - Survivor 039a/298"), "Kai'Sa - Survivor 039a/298");
  });
  it('null/undefined → empty string', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('config gates', () => {
  it('enabled/chat flags read the env', () => {
    assert.equal(telegramEnabled({}), false);
    assert.equal(telegramEnabled({ TELEGRAM_BOT_TOKEN: ' t ' }), true);
    assert.equal(telegramChatConfigured({}), false);
    assert.equal(telegramChatConfigured({ TELEGRAM_CHAT_ID: '-100123' }), true);
  });
});

describe('degradation without a token (no network)', () => {
  it('sendMessage → { ok:false, disabled:true }', async () => {
    const r = await sendMessage({}, { text: 'hi' });
    assert.equal(r.ok, false);
    assert.equal(r.disabled, true);
  });
  it('sendMessage with token but no chat id → descriptive failure', async () => {
    const r = await sendMessage({ TELEGRAM_BOT_TOKEN: 't' }, { text: 'hi' });
    assert.equal(r.ok, false);
    assert.match(r.description, /chat_id/);
  });
  it('editMessageText requires chatId + messageId', async () => {
    const r = await editMessageText({ TELEGRAM_BOT_TOKEN: 't' }, { text: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.description, /chatId \+ messageId/);
  });
  it('pin/unpin degrade like everything else', async () => {
    assert.deepEqual(await pinChatMessage({}, { chatId: '-100', messageId: 5 }),
      { ok: false, disabled: true, description: 'TELEGRAM_BOT_TOKEN not set' });
    assert.deepEqual(await unpinChatMessage({}, { chatId: '-100', messageId: 5 }),
      { ok: false, disabled: true, description: 'TELEGRAM_BOT_TOKEN not set' });
  });
  it('unpin REQUIRES a message id, even though Telegram treats it as optional', async () => {
    // Omitting it unpins whatever happens to be pinned in the chat, which may be somebody else's.
    const r = await unpinChatMessage({ TELEGRAM_BOT_TOKEN: 't' }, { chatId: '-100' });
    assert.equal(r.ok, false);
    assert.match(r.description, /chatId \+ messageId/);
  });
});

// --- button authorisation ---
// The gate is deny-by-default and matches on numeric id only. These mostly assert the DENIALS: the
// failure mode is someone in the chat approving a real eBay message or a price change.
describe('isAllowedUser / parseUserIds', () => {
  it('allows an id that is on the list', () => {
    assert.equal(isAllowedUser([2044569020], { id: 2044569020, username: 'alcatrazzalz' }), true);
    assert.equal(isAllowedUser(['2044569020'], { id: 2044569020 }), true);
  });
  it('denies everyone when the list is empty, missing or junk', () => {
    for (const list of [[], '', null, undefined, '   ', ',,', ['@alcatrazzalz'], ['not-a-number']]) {
      assert.equal(isAllowedUser(list, { id: 2044569020, username: 'alcatrazzalz' }), false,
        'empty/invalid allowlist must deny, got allow for ' + JSON.stringify(list));
    }
  });
  it('denies an id that is not on the list', () => {
    assert.equal(isAllowedUser([111, 222], { id: 333 }), false);
  });
  it('never authorises on @username, only the numeric id', () => {
    // A username is user-changeable and Telegram reassigns abandoned ones, so it is not an identity.
    assert.equal(isAllowedUser(['alcatrazzalz'], { id: 999, username: 'alcatrazzalz' }), false);
    assert.equal(isAllowedUser([999], { id: 999, username: 'somebody_else' }), true);
  });
  it('denies an update with no from/id at all', () => {
    assert.equal(isAllowedUser([111], undefined), false);
    assert.equal(isAllowedUser([111], {}), false);
    assert.equal(isAllowedUser([111], { username: 'x' }), false);
  });
  it('parses a comma or space separated string, as the settings form stores it', () => {
    assert.deepEqual(parseUserIds('111, 222 333'), ['111', '222', '333']);
    assert.deepEqual(parseUserIds('111, @nope, 222'), ['111', '222']);  // drops non-numeric entries
    assert.deepEqual(parseUserIds([111, ' 222 ']), ['111', '222']);
  });
  it('does not match a substring or a numeric near-miss', () => {
    assert.equal(isAllowedUser(['20445690201'], { id: 2044569020 }), false);
    assert.equal(isAllowedUser(['204456902'], { id: 2044569020 }), false);
  });
});

describe('denyCallbackText', () => {
  it('tells the tapper their own id so a locked-out owner can unlock themselves', () => {
    const t = denyCallbackText({ id: 2044569020, username: 'alcatrazzalz' }, 'Post-sale');
    assert.match(t, /2044569020/);
    assert.match(t, /Post-sale/);
  });
  it('degrades when the id is missing', () => {
    assert.match(denyCallbackText(undefined, 'Repricer'), /unknown/);
  });
});

// --- sendCard: photo vs text ---
// Telegram caps a caption at 1024 chars but a message at 4096. A post-sale card carries the whole
// buyer message, so it routinely exceeds the caption limit — losing the picture is fine, losing the
// end of the message is not.
describe('sendCard chooses photo or text', () => {
  const ENV = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '-100' };
  const realFetch = globalThis.fetch;
  let calls = [];
  const stub = (ok = true) => {
    calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ method: String(url).split('/').pop(), body: JSON.parse(opts.body || '{}') });
      return { ok: true, status: 200, text: async () => JSON.stringify(ok ? { ok: true, result: { message_id: 1 } } : { ok: false, description: 'bad photo' }) };
    };
  };
  afterEach(() => { globalThis.fetch = realFetch; });

  it('sends a photo when there is an image and the text fits a caption', async () => {
    stub();
    const r = await sendCard(ENV, { chatId: '-100', photo: 'https://img/x.jpg', text: 'short' });
    assert.equal(calls[0].method, 'sendPhoto');
    assert.equal(calls[0].body.caption, 'short');
    assert.equal(r.photo, true);
  });

  it('falls back to text when the body is longer than a caption can hold', async () => {
    stub();
    const long = 'x'.repeat(CAPTION_LIMIT + 1);
    const r = await sendCard(ENV, { chatId: '-100', photo: 'https://img/x.jpg', text: long });
    assert.equal(calls[0].method, 'sendMessage');
    assert.equal(calls[0].body.text.length, CAPTION_LIMIT + 1, 'the message must not be truncated');
    assert.equal(r.photo, false);
  });

  it('sends text when there is no image', async () => {
    stub();
    await sendCard(ENV, { chatId: '-100', text: 'no picture' });
    assert.equal(calls[0].method, 'sendMessage');
  });

  it('retries as text when the image itself is rejected, so the decision still lands', async () => {
    stub(false);
    const r = await sendCard(ENV, { chatId: '-100', photo: 'https://img/broken.jpg', text: 'short' });
    assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendMessage']);
    assert.equal(r.photo, false);
    assert.match(r.photo_failed, /bad photo/);
  });
});
