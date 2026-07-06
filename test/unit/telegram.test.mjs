// test/unit/telegram.test.mjs — Telegram client formatting + degradation (lib/telegram.mjs).
// No network: every call short-circuits before fetch when TELEGRAM_BOT_TOKEN is unset (GR7).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, telegramEnabled, telegramChatConfigured, sendMessage, editMessageText } from '../../lib/telegram.mjs';

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
