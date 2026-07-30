// test/unit/telegram.test.mjs — Telegram client formatting + degradation (lib/telegram.mjs).
// No network: every call short-circuits before fetch when TELEGRAM_BOT_TOKEN is unset (GR7).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, telegramEnabled, telegramChatConfigured, sendMessage, editMessageText,
  isAllowedUser, parseUserIds, denyCallbackText,
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
