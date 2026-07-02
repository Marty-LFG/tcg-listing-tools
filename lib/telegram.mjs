// lib/telegram.mjs — minimal, dependency-free Telegram Bot client (node global fetch only).
//
// Powers the repricer's team alerts + one-tap approve/skip flow. No library: everything is
// plain fetch against https://api.telegram.org/bot<token>/<method>. Secrets stay server-side —
// the bot token lives only in .env (Golden Rule 2) and never reaches the browser; the browser
// triggers a send via /api/repricer/*, it never talks to Telegram directly.
//
// NAT-friendly by design: we RECEIVE button taps via long-polling getUpdates (no public HTTPS
// endpoint / webhook needed — the dev server sits behind the LAN NAT). A webhook, if one were
// ever set on the bot, makes getUpdates fail with 409, so the poller clears it once on start.
//
// Everything degrades gracefully (Golden Rule 7): with no TELEGRAM_BOT_TOKEN every call returns
// { ok:false, disabled:true } and the poller simply doesn't start — the rest of the tool is fine.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function telegramEnabled(env) { return !!(env.TELEGRAM_BOT_TOKEN || '').trim(); }
export function telegramChatConfigured(env) { return !!(env.TELEGRAM_CHAT_ID || '').trim(); }

// Escape the 3 characters that matter for parse_mode=HTML. We use HTML (not MarkdownV2) for all
// programmatic messages — MarkdownV2 requires escaping ~15 characters (_ * [ ] ( ) ~ ` > # + - = | { } . !),
// which is a footgun when card names carry apostrophes, slashes, dashes. HTML needs only these three.
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Core call. Handles 429 (honours parameters.retry_after) and aborts a stuck request after timeoutMs.
async function tgCall(env, method, body, { timeoutMs = 20000 } = {}) {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return { ok: false, disabled: true, description: 'TELEGRAM_BOT_TOKEN not set in .env' };
  const url = `https://api.telegram.org/bot${token}/${method}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    let r, text = '';
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ctl.signal,
      });
      text = await r.text();
    } catch (e) {
      return { ok: false, description: (e?.name === 'AbortError' ? 'timeout' : 'network') + ': ' + (e?.message || e) };
    } finally { clearTimeout(to); }

    let j; try { j = JSON.parse(text); } catch { j = { ok: false, description: text.slice(0, 300) }; }
    // 429: back off for the server-instructed window, then retry.
    if (r.status === 429) {
      const wait = (j.parameters && j.parameters.retry_after) || 1;
      await sleep((wait + 0.5) * 1000);
      continue;
    }
    return j; // { ok:true, result } or { ok:false, error_code, description }
  }
  return { ok: false, description: 'rate limited (429) after retries' };
}

// Serialise outbound messages with a ~1s gap — Telegram allows ~1 msg/s sustained to a single
// chat (and ~20/min to a group); this keeps us comfortably under that without a real queue lib.
let _chain = Promise.resolve();
function serialize(task) {
  const run = _chain.then(() => task());
  _chain = run.then(() => sleep(1100), () => sleep(1100));
  return run;
}

// buttons: array of rows; each row is an array of { text, data } (callback) or { text, url } (link).
function toInlineKeyboard(buttons) {
  if (!buttons || !buttons.length) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))),
  };
}

export function sendMessage(env, { chatId, text, buttons, parseMode = 'HTML', silent = false, threadId } = {}) {
  const chat = chatId || (env.TELEGRAM_CHAT_ID || '').trim();
  if (!(env.TELEGRAM_BOT_TOKEN || '').trim()) return Promise.resolve({ ok: false, disabled: true, description: 'TELEGRAM_BOT_TOKEN not set' });
  if (!chat) return Promise.resolve({ ok: false, description: 'no chat_id (set TELEGRAM_CHAT_ID or pass chatId)' });
  const body = { chat_id: chat, text, parse_mode: parseMode, disable_notification: !!silent };
  const kb = toInlineKeyboard(buttons); if (kb) body.reply_markup = kb;
  if (threadId) body.message_thread_id = threadId; // forum/topic groups
  return serialize(() => tgCall(env, 'sendMessage', body));
}

export function editMessageText(env, { chatId, messageId, text, buttons, parseMode = 'HTML', clearButtons = false } = {}) {
  if (!chatId || !messageId) return Promise.resolve({ ok: false, description: 'chatId + messageId required' });
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode };
  const kb = toInlineKeyboard(buttons);
  if (kb) body.reply_markup = kb;
  else if (clearButtons) body.reply_markup = { inline_keyboard: [] }; // explicitly remove the Approve/Skip buttons
  return serialize(() => tgCall(env, 'editMessageText', body));
}

// Answer a button tap: stops the client's loading spinner and optionally shows a toast/alert.
// Not serialised — it should fire promptly so the tapping user gets instant feedback.
export function answerCallbackQuery(env, { id, text, showAlert = false } = {}) {
  return tgCall(env, 'answerCallbackQuery', { callback_query_id: id, text: text || undefined, show_alert: !!showAlert });
}

export function getMe(env) { return tgCall(env, 'getMe', {}); }
export function deleteWebhook(env) { return tgCall(env, 'deleteWebhook', {}); }

export function getUpdates(env, { offset, timeout = 30, allowedUpdates } = {}) {
  const body = { timeout };
  if (offset != null) body.offset = offset;
  if (allowedUpdates) body.allowed_updates = allowedUpdates;
  // fetch itself must outlive the long-poll: give it the poll window + slack before aborting.
  return tgCall(env, 'getUpdates', body, { timeoutMs: (timeout + 15) * 1000 });
}

// Long-poll loop. Singleton + HMR guard (mirrors startCollector in lib/collector.mjs) so a dev
// reload never stacks two pollers fighting over the same updates (which would 409 each other).
// getOffset/setOffset persist the confirmation cursor (offset = last update_id + 1) so a restart
// doesn't reprocess taps. onUpdate receives each raw update; the caller dispatches by type.
const DEFAULT_ALLOWED = ['message', 'channel_post', 'callback_query', 'my_chat_member'];
export function startTelegramPoller(env, { onUpdate, getOffset, setOffset, log = () => {} } = {}) {
  if (globalThis.__repricerTgPoller) return globalThis.__repricerTgPoller;
  if (!telegramEnabled(env)) { log('poller not started — TELEGRAM_BOT_TOKEN not set'); return null; }
  const state = { running: true };
  globalThis.__repricerTgPoller = state;
  (async () => {
    try { await deleteWebhook(env); } catch {} // ensure getUpdates isn't 409'd by a stray webhook
    log('long-poll poller started');
    while (state.running) {
      let offset;
      try { offset = getOffset ? getOffset() : undefined; } catch { offset = undefined; }
      let res;
      try { res = await getUpdates(env, { offset, timeout: 30, allowedUpdates: DEFAULT_ALLOWED }); }
      catch { await sleep(3000); continue; }
      if (!res || res.ok === false) { await sleep(3000); continue; } // 409 / transient — back off
      for (const u of res.result || []) {
        try { if (setOffset) setOffset(u.update_id + 1); } catch {}
        try { if (onUpdate) await onUpdate(u); }
        catch (e) { log('update handler error: ' + (e?.message || e)); }
      }
    }
    log('long-poll poller stopped');
  })();
  return state;
}

export function stopTelegramPoller() {
  const s = globalThis.__repricerTgPoller;
  if (s) { s.running = false; globalThis.__repricerTgPoller = null; }
  // The in-flight getUpdates (≤30s long-poll) will return and the loop then exits.
}
