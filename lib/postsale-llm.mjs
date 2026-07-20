// lib/postsale-llm.mjs — drafts the personalized post-purchase message to an eBay buyer.
//
// Mirrors lib/grader.mjs: dual provider (Anthropic OR OpenAI, whichever key is set), all network is
// server-side, and a failure ALWAYS returns { ok:false, error } and NEVER throws (Golden Rule 7) — a
// missing key or a provider blip must not stall the order-poll loop, it just leaves the draft pending.
//
// The message goes to a REAL customer through eBay's messaging, so two layers of safety live here:
//   1) the system prompt bans off-eBay contact info + the usual "AI-written" tells (per the owner);
//   2) guardrailScrub() is a hard server-side check the caller runs before any send.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

// --- next business day (pure, dependency-free, timezone-aware) ---
// Strictly the next calendar day AFTER `from` that is a weekday and not a listed holiday, computed in
// the given IANA timezone. Returns { date:'YYYY-MM-DD', weekday:'Monday' } (or null if none in range).
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function nextBusinessDay(from = new Date(), { tz = 'Australia/Sydney', holidays = [] } = {}) {
  const holidaySet = new Set(holidays || []);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(from);
  const get = (t) => +parts.find((p) => p.type === t).value;
  const dt = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  for (let i = 0; i < 21; i++) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay();
    const iso = dt.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(iso)) return { date: iso, weekday: WEEKDAYS[dow] };
  }
  return null;
}

// --- system prompt (the store's voice + the hard rules) ---
export function systemPrompt(cfg = {}) {
  const sig = (cfg.signature || '-BK').trim();
  const lines = [
    'You write a short thank-you message from a small Australian trading card store to a buyer who just',
    'bought from the store on eBay. Write as the person who runs the store (they sign off as "' + sig + '").',
    'The message is delivered inside eBay, so keep it self-contained.',
    '',
    'Goal: make the buyer feel genuinely appreciated, tell them when the order will be posted, and keep',
    'the door open for more business without any pressure.',
    '',
    'Voice: kind, warm, casual, human. Write like a real person typing a quick note to someone they are',
    'happy to hear from. Short sentences. Contractions are good.',
    '',
    'Hard rules, do NOT break these:',
    '- No em dashes anywhere. Use commas or full stops instead.',
    '- Never use the "not X, but Y" or "it is not X, it is Y" sentence shape.',
    '- No marketing or filler words: thrilled, delighted, rest assured, we pride ourselves, valued',
    '  customer, elevate, curated, seamless, treasure trove, hassle-free. Skip hype.',
    '- At most one exclamation mark in the whole message. At most one emoji, and only if it feels natural.',
    '- Plain text only. No links, no web addresses, no email addresses, no phone numbers, and no way to',
    '  contact the store off eBay. This is an eBay policy, breaking it gets the message blocked.',
    '- Keep the whole body under 900 characters.',
    '',
    'What to cover, in a natural order:',
    '- A genuine thank you.',
    '- Name the exact card or cards they bought (use the titles given, you can shorten them a little).',
    '- Tell them it will be ' + (cfg.ship_timing_text || 'packed and sent the next business day') + '.',
    '  If a specific next-business-day weekday is provided, you may mention it naturally.',
    cfg.invite_offers === false ? '' : '- A light, no-pressure line that they are welcome to ask about bundle deals or send an offer if there is anything else they are after.',
    '- For a repeat buyer, warmly say it is good to see them again, and if a past card is given, give it a natural mention.',
    '- Sign off with "' + sig + '".',
  ];
  if (cfg.brand_voice) lines.push('', 'Store voice note from the owner: ' + cfg.brand_voice);
  if (cfg.style_notes) lines.push('Style note from the owner: ' + cfg.style_notes);
  lines.push('',
    'Reply with ONLY a JSON object, no prose and no code fences, matching exactly:',
    '{"subject":"<short friendly subject>","body":"<the message>"}');
  return lines.filter((l) => l !== '').join('\n');
}

// --- the facts turn (pure; testable) ---
export function buildContext({ order, items, buyer, priorCards = [], shipBy } = {}) {
  const its = (items || []).map((it) => `${it.title || it.sku || it.ebay_item_id || 'a card'}${it.quantity > 1 ? ` (x${it.quantity})` : ''}`);
  const repeat = !!(buyer && buyer.order_count > 1) || (priorCards && priorCards.length > 0);
  const lines = [];
  lines.push('Buyer username: ' + (order?.buyerUsername || order?.buyer_username || buyer?.ebay_username || 'the buyer'));
  lines.push(repeat
    ? `This is a repeat buyer (${(buyer && buyer.order_count) || 'a returning'} orders with the store so far).`
    : 'This is a first-time buyer.');
  lines.push('They just bought: ' + (its.length ? its.join(', ') : 'a card') + '.');
  if (shipBy && shipBy.weekday) lines.push('Next business day for posting: ' + shipBy.weekday + '.');
  if (repeat && priorCards && priorCards.length) lines.push('A card they bought from the store before: ' + priorCards.slice(0, 3).join(', ') + '.');
  return lines.join('\n');
}

// --- hard server-side guardrail (belt and suspenders over the prompt) ---
// Flags anything that would violate eBay's off-platform-contact policy. On a violation the caller
// rejects the draft and re-generates, so a human always sees a clean message before it can send.
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const RE_URL = /(?:https?:\/\/|www\.)\S+/i;
const RE_BAREDOMAIN = /\b[\w-]+\.(?:com|net|org|au|io|co|shop|store|gg|xyz)\b/i;
export function guardrailScrub(body) {
  const text = String(body || '');
  const violations = [];
  if (RE_EMAIL.test(text)) violations.push('email address');
  if (RE_URL.test(text) || RE_BAREDOMAIN.test(text)) violations.push('web address / link');
  // phone: a run of digits/spacing that totals >= 8 digits (postcodes, card numbers, prices are shorter).
  for (const run of text.match(/[\d][\d\s().+-]{6,}[\d]/g) || []) {
    if ((run.replace(/\D/g, '').length) >= 8) { violations.push('phone number'); break; }
  }
  if (text.length > 2000) violations.push('too long (> 2000 chars)');
  return { clean: violations.length === 0, violations };
}

// --- provider plumbing (mirrors lib/grader.mjs) ---
function pickProvider(env) {
  const pref = String(env.POSTSALE_PROVIDER || env.GRADER_PROVIDER || 'auto').toLowerCase();
  const hasA = !!(env.ANTHROPIC_API_KEY || '').trim();
  const hasO = !!(env.OPENAI_API_KEY || '').trim();
  if (pref === 'anthropic') return hasA ? 'anthropic' : null;
  if (pref === 'openai') return hasO ? 'openai' : null;
  if (hasA) return 'anthropic';
  if (hasO) return 'openai';
  return null;
}
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
async function callAnthropic(system, user, env) {
  const model = (env.POSTSALE_MODEL || '').trim() || DEFAULT_ANTHROPIC_MODEL;
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': (env.ANTHROPIC_API_KEY || '').trim(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 800, system, messages: [{ role: 'user', content: user }] }),
  });
  const text = await r.text();
  if (!r.ok) { let d = text.slice(0, 300); try { const e = JSON.parse(text); d = (e.error && (e.error.message || e.error.type)) || d; } catch {} throw new Error('Anthropic HTTP ' + r.status + ': ' + d); }
  const j = JSON.parse(text);
  return { model, text: (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
}
async function callOpenAI(system, user, env) {
  const model = (env.POSTSALE_MODEL || '').trim() || DEFAULT_OPENAI_MODEL;
  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (env.OPENAI_API_KEY || '').trim(), 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 800, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const text = await r.text();
  if (!r.ok) { let d = text.slice(0, 300); try { const e = JSON.parse(text); d = (e.error && e.error.message) || d; } catch {} throw new Error('OpenAI HTTP ' + r.status + ': ' + d); }
  const j = JSON.parse(text);
  return { model, text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '' };
}

// draftMessage({ order, items, buyer, priorCards, cfg, env }) -> { ok, subject, body, model, provider } | { ok:false, error, message }
export async function draftMessage({ order, items, buyer, priorCards = [], cfg = {}, env = {}, shipBy } = {}) {
  try {
    const provider = pickProvider(env);
    if (!provider) return { ok: false, error: 'no_key', message: 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.' };
    const sys = systemPrompt(cfg);
    const user = buildContext({ order, items, buyer, priorCards, shipBy });
    const res = provider === 'anthropic' ? await callAnthropic(sys, user, env) : await callOpenAI(sys, user, env);
    const parsed = extractJson(res.text);
    if (!parsed || !parsed.body) return { ok: false, error: 'parse', message: 'Model did not return a usable {subject,body}.', raw: (res.text || '').slice(0, 300) };
    return { ok: true, provider, model: res.model, subject: String(parsed.subject || 'Thanks for your order!').slice(0, 120), body: String(parsed.body).trim() };
  } catch (e) {
    return { ok: false, error: 'provider', message: String((e && e.message) || e) };
  }
}
