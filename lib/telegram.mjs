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

// Pin the one message that must not scroll away.
//
// A cancellation is the post-sale event where the cost of missing it is a parcel already in the post,
// so it gets the only affordance Telegram has that survives a busy chat. Serialised like every other
// send — a pin that jumped the ~1 msg/s queue would be the thing that gets rate limited.
//
// Pinning in a group or channel needs can_pin_messages. Without it Telegram answers ok:false, and THE
// CALLER MUST NOT CARE: the alert is the point and the pin is the garnish (Golden Rule 7).
export function pinChatMessage(env, { chatId, messageId, silent = false } = {}) {
  const chat = chatId || (env.TELEGRAM_CHAT_ID || '').trim();
  if (!(env.TELEGRAM_BOT_TOKEN || '').trim()) return Promise.resolve({ ok: false, disabled: true, description: 'TELEGRAM_BOT_TOKEN not set' });
  if (!chat || !messageId) return Promise.resolve({ ok: false, description: 'chatId + messageId required' });
  return serialize(() => tgCall(env, 'pinChatMessage', { chat_id: chat, message_id: messageId, disable_notification: !!silent }));
}
// messageId is REQUIRED here even though Telegram treats it as optional: omitting it unpins whatever
// happens to be pinned, which may well be somebody else's message.
export function unpinChatMessage(env, { chatId, messageId } = {}) {
  const chat = chatId || (env.TELEGRAM_CHAT_ID || '').trim();
  if (!(env.TELEGRAM_BOT_TOKEN || '').trim()) return Promise.resolve({ ok: false, disabled: true, description: 'TELEGRAM_BOT_TOKEN not set' });
  if (!chat || !messageId) return Promise.resolve({ ok: false, description: 'chatId + messageId required' });
  return serialize(() => tgCall(env, 'unpinChatMessage', { chat_id: chat, message_id: messageId }));
}

export function editMessageText(env, { chatId, messageId, text, buttons, parseMode = 'HTML', clearButtons = false } = {}) {
  if (!chatId || !messageId) return Promise.resolve({ ok: false, description: 'chatId + messageId required' });
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode };
  const kb = toInlineKeyboard(buttons);
  if (kb) body.reply_markup = kb;
  else if (clearButtons) body.reply_markup = { inline_keyboard: [] }; // explicitly remove the Approve/Skip buttons
  return serialize(() => tgCall(env, 'editMessageText', body));
}

// A photo card: the picture carries the identity of the thing being decided on, so the reader
// recognises the card before reading a word. Telegram caps a caption at 1024 characters (a plain
// message gets 4096), which is why sendCard below falls back to text rather than truncating.
export function sendPhoto(env, { chatId, photo, caption, buttons, parseMode = 'HTML', silent = false } = {}) {
  const chat = chatId || (env.TELEGRAM_CHAT_ID || '').trim();
  if (!(env.TELEGRAM_BOT_TOKEN || '').trim()) return Promise.resolve({ ok: false, disabled: true, description: 'TELEGRAM_BOT_TOKEN not set' });
  if (!chat) return Promise.resolve({ ok: false, description: 'no chat_id (set TELEGRAM_CHAT_ID or pass chatId)' });
  const body = { chat_id: chat, photo, caption, parse_mode: parseMode, disable_notification: !!silent };
  const kb = toInlineKeyboard(buttons); if (kb) body.reply_markup = kb;
  return serialize(() => tgCall(env, 'sendPhoto', body));
}

export const CAPTION_LIMIT = 1024;

// Send a decision card as a photo when there is an image AND the text fits in a caption; otherwise
// as plain text. Losing the picture is a far smaller cost than losing the end of the message, so a
// long body always wins over the image. Returns the tgCall result plus `photo`, which the caller
// must remember: editing a photo message needs editMessageCaption, not editMessageText.
export async function sendCard(env, { chatId, photo, text, buttons, parseMode = 'HTML', silent = false } = {}) {
  const usePhoto = !!photo && String(text || '').length <= CAPTION_LIMIT;
  const r = usePhoto
    ? await sendPhoto(env, { chatId, photo, caption: text, buttons, parseMode, silent })
    : await sendMessage(env, { chatId, text, buttons, parseMode, silent });
  // A bad/unreachable image URL fails the whole send — fall back to text so the decision still lands.
  if (!r.ok && usePhoto) {
    const retry = await sendMessage(env, { chatId, text, buttons, parseMode, silent });
    return { ...retry, photo: false, photo_failed: r.description || 'sendPhoto failed' };
  }
  return { ...r, photo: usePhoto };
}

// Edit a card without the caller having to track how it was sent. A photo message rejects
// editMessageText and a text message rejects editMessageCaption, so try the one the message
// probably is and fall back. Both calls are cheap; guessing wrong costs one extra round trip.
export async function editCard(env, { chatId, messageId, text, buttons, parseMode = 'HTML', clearButtons = false, photo = null } = {}) {
  if (!chatId || !messageId) return { ok: false, description: 'chatId + messageId required' };
  const body = { chat_id: chatId, message_id: messageId, parse_mode: parseMode };
  const kb = toInlineKeyboard(buttons);
  if (kb) body.reply_markup = kb;
  else if (clearButtons) body.reply_markup = { inline_keyboard: [] };
  const asCaption = () => serialize(() => tgCall(env, 'editMessageCaption', { ...body, caption: text }));
  const asText = () => serialize(() => tgCall(env, 'editMessageText', { ...body, text }));
  const first = photo === false ? asText : asCaption;
  const second = photo === false ? asCaption : asText;
  const r = await first();
  return r.ok ? r : second();
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

// --- who may action the bot's buttons ---
// Callback data itself can't be forged (it only ever comes from a button this bot sent), but ANY
// member of the chat can tap one — and the chat is a place you add people. These gate that per tool.
//
// Matching is on the NUMERIC Telegram user id, never @username: usernames are changed freely by
// their owner and Telegram re-releases an abandoned one to somebody else, so a username allowlist
// can silently start pointing at a stranger. Numeric ids are permanent.
//
// An EMPTY list denies everyone. A safeguard that defaults to open isn't a safeguard — an install
// that hasn't been configured yet is exactly the one that shouldn't be handing out approvals.
// Accepts either an array or a comma/space-separated string, since the settings form stores text.
export function parseUserIds(list) {
  const arr = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[,\s]+/);
  return arr.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}
export function isAllowedUser(allowed, from) {
  const id = from && from.id != null ? String(from.id) : '';
  return !!id && parseUserIds(allowed).includes(id);
}
// Human label for audit trails and card stamps. Username when there is one (it's what a person
// recognises), otherwise a first name, otherwise the raw id.
export function describeUser(from) {
  if (!from) return 'someone';
  return from.username ? '@' + from.username : (from.first_name || ('id ' + from.id));
}
// The one place the "you can't do that" reply is worded. It leaks the tapper's own id back to them
// on purpose: with deny-by-default the owner is locked out on first deploy, and this is how they
// learn the number to paste into settings without needing a shell or a lookup tool.
export function denyCallbackText(from, where) {
  return 'Not authorised to action ' + where + '.\n\nYour Telegram id is '
    + (from && from.id != null ? from.id : 'unknown')
    + '\nAdd it in Settings → ' + where + ' → Telegram approvers to allow it.';
}

// Update-handler registry: ONE long-poll loop fans each update out to every registered handler, so
// multiple plugins (the repricer's Approve/Skip AND the post-sale Approve/Skip) can share the single
// bot/poller instead of two getUpdates loops 409'ing each other. Each handler claims only its own
// callback-data prefix and ignores the rest. Stored on globalThis so it survives an HMR re-eval.
const _handlers = (globalThis.__tgHandlers ||= new Map());
export function registerUpdateHandler(name, fn) { if (typeof fn === 'function') _handlers.set(name, fn); }
export function unregisterUpdateHandler(name) { _handlers.delete(name); }

// Long-poll loop. Singleton + HMR guard (mirrors startCollector in lib/collector.mjs) so a dev
// reload never stacks two pollers fighting over the same updates (which would 409 each other).
// getOffset/setOffset persist the confirmation cursor (offset = last update_id + 1) so a restart
// doesn't reprocess taps. A passed onUpdate is registered as one handler for back-compat; new
// callers should registerUpdateHandler(name, fn) directly and call this to ensure the loop runs.
const DEFAULT_ALLOWED = ['message', 'channel_post', 'callback_query', 'my_chat_member'];
export function startTelegramPoller(env, { onUpdate, getOffset, setOffset, log = () => {} } = {}) {
  if (onUpdate) registerUpdateHandler('_default', onUpdate);   // back-compat (repricer's onUpdate)
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
        for (const [name, fn] of _handlers) {
          try { await fn(u); } catch (e) { log('handler ' + name + ' error: ' + (e?.message || e)); }
        }
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
