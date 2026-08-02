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
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
// Balanced tier: buyer-facing copy in a specific brand voice, but a tiny (<800 token) generation, so
// cost is negligible either way. gpt-5.6-sol for top capability, gpt-5.6-luna for the cheap high-volume
// tier — override per-install with POSTSALE_MODEL.
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';

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

// The voice + the hard rules, shared by every kind of message the store sends. One copy, because
// three drifting copies is how a "no em dashes" rule ends up applying to two messages out of three.
function voiceRules(sig) {
  return [
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
    '- Sign off with "' + sig + '".',
  ];
}
const JSON_TAIL = [
  '',
  'Reply with ONLY a JSON object, no prose and no code fences, matching exactly:',
  '{"subject":"<short friendly subject>","body":"<the message>"}',
];

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
    ...voiceRules(sig),
    '',
    'What to cover, in a natural order:',
    '- A genuine thank you.',
    '- Name the exact card or cards they bought (use the titles given, you can shorten them a little).',
    '- Tell them it will be ' + (cfg.ship_timing_text || 'packed and sent the next business day') + '.',
    '  If a specific next-business-day weekday is provided, you may mention it naturally.',
    cfg.invite_offers === false ? '' : '- A light, no-pressure line that they are welcome to ask about bundle deals or send an offer if there is anything else they are after.',
    '- For a repeat buyer, warmly say it is good to see them again, and if a past card is given, give it a natural mention.',
  ];
  if (cfg.brand_voice) lines.push('', 'Store voice note from the owner: ' + cfg.brand_voice);
  if (cfg.style_notes) lines.push('Style note from the owner: ' + cfg.style_notes);
  lines.push(...JSON_TAIL);
  return lines.filter((l) => l !== '').join('\n');
}

// --- dispatch / delivered prompts ---
// Same store, same voice, later in the story. Kept as one builder because the two differ only in what
// they are about; duplicating the voice rules for each would guarantee they drift.
export function followUpSystemPrompt(cfg = {}, kind = 'dispatch') {
  const sig = (cfg.signature || '-BK').trim();
  const delivered = kind === 'delivered';
  const lines = [
    delivered
      ? 'You write a short follow-up from a small Australian trading card store to a buyer whose order has'
      : 'You write a short note from a small Australian trading card store to a buyer telling them their order',
    delivered
      ? 'just been delivered. Write as the person who runs the store (they sign off as "' + sig + '").'
      : 'has been posted. Write as the person who runs the store (they sign off as "' + sig + '").',
    'The message is delivered inside eBay, so keep it self-contained. They have already had a thank-you',
    'note when they ordered, so do not repeat that at length.',
    '',
    delivered
      ? 'Goal: check the cards turned up in good shape, make it easy to speak up if anything is off, and'
      : 'Goal: let them know it is on its way and how it is travelling, so they are not left wondering.',
    delivered ? 'nudge gently for a rating.' : '',
    '',
    ...voiceRules(sig),
    '',
    'What to cover, in a natural order:',
  ];
  if (delivered) {
    lines.push(
      '- Say their order should have arrived.',
      '- Name the card or cards if they are given, briefly.',
      '- Hope it turned up in good shape, and ask them to just reply here if anything is not right.',
      '- One light, low-pressure line that a rating on eBay helps a small store. Do not beg, do not offer',
      '  anything in exchange, and do not ask for a specific number of stars.');
  } else {
    lines.push(
      '- Say it has gone in the post, and when.',
      '- Name the card or cards if they are given, briefly.',
      '- Mention the postage service if one is given (for example Express Post).',
      // The number is appended verbatim by the server precisely so a model can never mistype it. A
      // wrong tracking number is a support ticket and a worried customer.
      '- If a tracking number is mentioned in the facts, refer to it as being at the end of this message,',
      '  and say eBay also shows it on their order page. Do NOT write the number out yourself.',
      '- Do not promise a delivery date. Estimates are eBay\'s, not ours.');
  }
  if (cfg.brand_voice) lines.push('', 'Store voice note from the owner: ' + cfg.brand_voice);
  if (cfg.style_notes) lines.push('Style note from the owner: ' + cfg.style_notes);
  lines.push(...JSON_TAIL);
  return lines.filter((l) => l !== '').join('\n');
}

export function buildFollowUpContext({ order, items = [], postage = {}, kind = 'dispatch' } = {}) {
  const its = items.map((it) => `${it.title || it.sku || it.ebay_item_id || 'a card'}${it.quantity > 1 ? ` (x${it.quantity})` : ''}`);
  const lines = [];
  lines.push('Buyer username: ' + (order?.buyer_username || order?.buyerUsername || 'the buyer'));
  const name = friendlyFirstName(order?.ship_name);
  if (name) lines.push('Their first name: ' + name);
  lines.push('They bought: ' + (its.length ? its.join(', ') : 'a card') + '.');
  if (kind === 'delivered') {
    lines.push('The parcel has been delivered.');
  } else {
    if (postage.label) lines.push('Postage service: ' + postage.label + '.');
    if (postage.tracking) lines.push('There IS a tracking number, and it is appended after your message. Do not write it yourself.');
    else lines.push('There is no tracking number for this one (it went as a plain letter).');
  }
  return lines.join('\n');
}

/**
 * The factual block appended verbatim under a dispatch message.
 *
 * The model never writes the tracking number: a 12-14 character alphanumeric is exactly the sort of
 * thing that survives 99 generations and gets one character wrong on the hundredth, and a wrong
 * tracking number is a worried customer plus a support reply. So the prose is drafted and the facts
 * are stamped.
 *
 * Returns the text plus the literals guardrailScrub has to be told to allow: an Australia Post article
 * ID is a long digit run that the phone-number rule would otherwise reject every single time.
 */
export function dispatchFacts(postage = {}, pcfg = {}) {
  if (!postage.tracking) return { text: '', allow: [] };
  const allow = [postage.tracking];
  const lines = ['Tracking: ' + postage.tracking + (postage.carrier ? ' (' + postage.carrier + ')' : '')];
  // eBay's member-to-member contact policy bans web addresses. There is a long-standing carve-out for
  // links that help delivery, but enforcement tightened and a violating message is dropped silently,
  // so this stays off unless the owner turns it on and accepts that.
  if (pcfg.dispatch_message && pcfg.dispatch_message.include_link && postage.tracking_url) {
    lines.push(postage.tracking_url);
    allow.push(postage.tracking_url);
  }
  return { text: lines.join('\n'), allow };
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
//
// `allow` is the escape hatch for content WE put in the message deliberately. An Australia Post
// article ID is a 12-14 digit run, which the phone-number rule below flags every single time, so a
// perfectly correct dispatch message would be rejected 100% of the time without this. The caller
// passes the exact literals it stamped (see dispatchFacts) and only those are masked before the checks
// run; anything the model wrote is policed exactly as before. Default [] keeps old behaviour.
export function guardrailScrub(body, { allow = [] } = {}) {
  const original = String(body || '');
  let text = original;
  // Longest first. The tracking URL CONTAINS the tracking number, so masking the number first would
  // shred the URL literal and leave a bare "auspost.com.au" behind for the link rule to flag.
  const masks = allow.map((a) => String(a == null ? '' : a).trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  // A '#' rather than a space: the phone rule tolerates whitespace INSIDE a digit run, so masking with
  // a space would let the digits either side of a removed tracking number fuse into a false positive.
  // '#' appears in none of the patterns below, so it is a hard break for all of them.
  for (const s of masks) text = text.split(s).join(' # ');
  const violations = [];
  if (RE_EMAIL.test(text)) violations.push('email address');
  if (RE_URL.test(text) || RE_BAREDOMAIN.test(text)) violations.push('web address / link');
  // phone: a run of digits/spacing that totals >= 8 digits (postcodes, card numbers, prices are shorter).
  for (const run of text.match(/[\d][\d\s().+-]{6,}[\d]/g) || []) {
    if ((run.replace(/\D/g, '').length) >= 8) { violations.push('phone number'); break; }
  }
  // Length is eBay's limit on what actually gets sent, so it is measured on the real body, not the
  // masked copy.
  if (original.length > 2000) violations.push('too long (> 2000 chars)');
  return { clean: violations.length === 0, violations };
}

// --- fallback draft (no model involved) ---
// The model lane dies in ways a buyer should never notice: a missing key, a provider outage, an HTTP
// 400, unparseable JSON. Before this existed every one of those left the buyer with nothing at all
// (60 orders in a row, once). This builds a plain message from config so there is always something
// sitting in the queue to approve.
//
// The rule in every helper below is the same: personalise ONLY when certain, otherwise say the
// generic thing and move on. A message that reads a little generic costs nothing. One that calls
// someone by the wrong name, or thanks them for a card they didn't buy, costs a customer.

// Anything that smells like a business rather than a person. Checked against the WHOLE name, so
// "James Martin Trading" is rejected even though "James" on its own would have been fine.
const RE_COMPANY = /\b(pty|ltd|limited|inc|llc|co|company|store|shop|cards?|collectib\w*|trading|games?|gaming|hobb\w+|enterprises|holdings|group|supplies|distribution)\b/i;
// A plausible given name: one leading letter plus 1-19 more. Rejects bare initials ("J", "J.").
const RE_NAME_TOKEN = /^[\p{L}][\p{L}'’-]{1,19}$/u;

// First name off the SHIPPING name — never the eBay username, which is a handle ("horse_divorce",
// "j-c-martin") and reads as an insult when used as a name. Returns '' whenever anything is off.
export function friendlyFirstName(shipName) {
  const full = String(shipName || '').trim().replace(/\s+/g, ' ');
  if (!full || full.length > 60) return '';
  if (RE_COMPANY.test(full)) return '';
  if (/[\d@_/\\|]/.test(full)) return '';   // digits or handle punctuation: not a person's name
  const first = full.split(' ')[0];
  if (!RE_NAME_TOKEN.test(first)) return '';
  // Normalise shouty and all-lowercase entries ("JOSE" / "jose" -> "Jose") but leave a name that is
  // already mixed-case alone, so "McDonald" and "O'Brien" survive intact.
  const alreadyMixed = first !== first.toUpperCase() && first !== first.toLowerCase();
  return alreadyMixed ? first : first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// Leading game/brand word, dropped before looking for the card name.
const RE_GAME_PREFIX = /^(pok[eé]mon|one piece|magic:? the gathering|mtg|lorcana|star wars:? unlimited|swu|riftbound|yu-?gi-?oh)\s+/i;

// A casual, human-sized hook for the card. Store titles are shaped
//   "<game> <card name> <collector number> <set> <rarity> <lang> <condition>"
// so the name is simply everything before the first number token:
//   "Pokemon Mega Zeraora ex 027/084 Pitch Black Double Rare Holo EN M/NM" -> "Mega Zeraora ex"
// Reading the whole title back to the buyer is what feels robotic, so we keep just that head. A
// title that doesn't match the shape returns '' and the caller drops the card mention entirely.
export function cardHook(title) {
  const t = String(title || '').trim().replace(/\s+/g, ' ').replace(RE_GAME_PREFIX, '');
  // Require whitespace before the digit so a name containing one ("Porygon2") isn't cut in half.
  const m = t.match(/^(.*?)\s\d/);
  const hook = (m ? m[1] : '').trim();
  if (!hook || hook.length > 30 || hook.split(' ').length > 4) return '';
  if (/\d/.test(hook) || !/[\p{L}]/u.test(hook)) return '';
  // Punctuation means we're reading prose, not a card title — "Mystery bundle, 10 assorted holos"
  // would otherwise yield "Mystery bundle". Card names in these titles carry no commas or brackets,
  // so anything that does is a listing shaped differently than we assumed: say nothing instead.
  if (/[,;:()[\]]/.test(hook) || /[.\-–—]$/.test(hook)) return '';
  return hook;
}

// "tomorrow" only when the next business day really is the next calendar day, else "on Monday".
// Saying "tomorrow" on a Friday is the exact mistake the hand-copied message kept making.
export function shipByPhrase(shipBy, from = new Date(), tz = 'Australia/Sydney') {
  if (!shipBy || !shipBy.date) return '';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(from);
  const t = new Date(today + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10) === shipBy.date ? 'tomorrow' : 'on ' + shipBy.weekday;
}

export const DEFAULT_FALLBACK_SUBJECT = 'Thanks for your order!';
export const DEFAULT_FALLBACK_CARD_LINE = 'Glad you grabbed that {{card}}. ';
export const DEFAULT_FALLBACK_BODY = [
  'Hey{{name}}, thanks so much for your purchase!',
  '',
  // One source line per rendered line: a wrapped string here becomes a hard newline mid-sentence
  // in the buyer's message.
  "{{card}}We'll get this packed up and posted {{ship_by}}, and in the meantime we love doing bundle deals, so if there's anything else you're after just let us know (or send through an offer).",
  '',
  'Thanks again!',
  '{{signature}}',
].join('\n');

// Fill the configured template. {{name}} and {{card}} collapse to nothing when we aren't sure, which
// is why the default body reads correctly either way ("Hey James, thanks" / "Hey, thanks").
// A blank config string means "not set", not "render nothing". The settings form renders the config
// FILE, so a field added in a later release shows as an empty box until it is backfilled, and a user
// can clear one by hand too. `??` would accept "" and mail the buyer an empty message.
const orDefault = (v, dflt) => (v == null || String(v).trim() === '' ? dflt : String(v));

export function fallbackDraft({ order, items = [], cfg = {}, shipBy, now = new Date() } = {}) {
  const name = friendlyFirstName(order?.ship_name);
  // Only name a card on a single-line, single-quantity order: "that Dragonite" is plainly wrong when
  // they bought three things, and picking one of them to mention is worse than mentioning none.
  const one = items.length === 1 && (!items[0].quantity || items[0].quantity === 1);
  const hook = one ? cardHook(items[0].title) : '';
  const cardLine = hook
    ? orDefault(cfg.fallback_card_line, DEFAULT_FALLBACK_CARD_LINE).replace(/\{\{\s*card\s*\}\}/g, hook)
    : '';
  const ship = shipByPhrase(shipBy, now, cfg.timezone || 'Australia/Sydney') || 'the next business day';
  const body = orDefault(cfg.fallback_body, DEFAULT_FALLBACK_BODY)
    .replace(/\{\{\s*name\s*\}\}/g, name ? ' ' + name : '')
    .replace(/\{\{\s*card\s*\}\}/g, cardLine)
    .replace(/\{\{\s*ship_by\s*\}\}/g, ship)
    .replace(/\{\{\s*signature\s*\}\}/g, (cfg.signature || '-BK').trim())
    .replace(/[ \t]+$/gm, '')
    .trim();
  // Last line of defence: never hand back an empty message. guardrailScrub() would pass one happily
  // (nothing in it violates eBay policy), so the caller has no other way to catch it.
  if (!body) return { ok: false, error: 'template_empty', message: 'fallback template produced an empty body' };
  return {
    ok: true,
    provider: 'template',
    model: 'template',
    subject: orDefault(cfg.fallback_subject, DEFAULT_FALLBACK_SUBJECT).slice(0, 120),
    body,
    personalised: { name: !!name, card: !!hook },
  };
}

// --- fallback drafts for the two follow-ups ---
// Same job as fallbackDraft: the model lane dies in ways a buyer should never notice, and a dispatch
// note that never arrives is worse than a plain one that does. Voice rules apply here too, so: no em
// dashes, no filler, nothing that reads as written by a machine.
export const DEFAULT_DISPATCH_SUBJECT = "Your order's on its way";
export const DEFAULT_DELIVERED_SUBJECT = 'Did your cards arrive okay?';

export function fallbackFollowUp({ order, items = [], postage = {}, cfg = {}, kind = 'dispatch' } = {}) {
  const name = friendlyFirstName(order?.ship_name);
  const hey = 'Hey' + (name ? ' ' + name : '') + ',';
  const one = items.length === 1 && (!items[0].quantity || items[0].quantity === 1);
  const hook = one ? cardHook(items[0].title) : '';
  const sig = (cfg.signature || '-BK').trim();
  const what = hook ? 'your ' + hook : 'your order';
  let body;
  if (kind === 'delivered') {
    body = [
      hey,
      '',
      what.charAt(0).toUpperCase() + what.slice(1) + ' should have landed. Hope it turned up in good shape.',
      'If anything is not right, just reply here and we\'ll sort it out.',
      '',
      'If you\'re happy with it, a quick rating on eBay really helps a small store like ours.',
      '',
      'Thanks again,',
      sig,
    ].join('\n');
  } else {
    const svc = postage.label ? ' It\'s going ' + postage.label + '.' : '';
    const trk = postage.tracking
      ? '\nThe tracking number is at the bottom of this message, and eBay shows it on your order page too.'
      : '';
    body = [
      hey,
      '',
      'Just letting you know ' + what + ' went in the post today.' + svc + trk,
      '',
      'Thanks again, and enjoy the cards.',
      sig,
    ].join('\n');
  }
  return {
    ok: true, provider: 'template', model: 'template',
    subject: kind === 'delivered' ? DEFAULT_DELIVERED_SUBJECT : DEFAULT_DISPATCH_SUBJECT,
    body: body.replace(/[ \t]+$/gm, '').trim(),
  };
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
    // max_tokens caps thinking AND response text together, and Opus 5 thinks by default (unlike 4.8,
    // where omitting `thinking` meant none) — 800 would truncate mid-JSON. Effort 'low' suits a short
    // thank-you note; don't disable thinking outright, since that can leak <thinking> tags into the body.
    body: JSON.stringify({
      model, max_tokens: 3000, output_config: { effort: 'low' },
      system, messages: [{ role: 'user', content: user }],
    }),
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
    // max_completion_tokens, NOT max_tokens: the latter is deprecated on Chat Completions and is
    // rejected outright by the GPT-5.x/o-series reasoning models, which is every model worth using here.
    body: JSON.stringify({ model, max_completion_tokens: 800, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const text = await r.text();
  if (!r.ok) { let d = text.slice(0, 300); try { const e = JSON.parse(text); d = (e.error && e.error.message) || d; } catch {} throw new Error('OpenAI HTTP ' + r.status + ': ' + d); }
  const j = JSON.parse(text);
  return { model, text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '' };
}

// draftMessage({ order, items, buyer, priorCards, cfg, env }) -> { ok, subject, body, model, provider } | { ok:false, error, message }
export async function draftMessage({ order, items, buyer, priorCards = [], cfg = {}, env = {}, shipBy, kind = 'purchase', postage = {} } = {}) {
  try {
    const provider = pickProvider(env);
    if (!provider) return { ok: false, error: 'no_key', message: 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.' };
    const followUp = kind === 'dispatch' || kind === 'delivered';
    const sys = followUp ? followUpSystemPrompt(cfg, kind) : systemPrompt(cfg);
    const user = followUp ? buildFollowUpContext({ order, items, postage, kind })
      : buildContext({ order, items, buyer, priorCards, shipBy });
    const res = provider === 'anthropic' ? await callAnthropic(sys, user, env) : await callOpenAI(sys, user, env);
    const parsed = extractJson(res.text);
    if (!parsed || !parsed.body) return { ok: false, error: 'parse', message: 'Model did not return a usable {subject,body}.', raw: (res.text || '').slice(0, 300) };
    const dfltSubject = kind === 'dispatch' ? DEFAULT_DISPATCH_SUBJECT
      : kind === 'delivered' ? DEFAULT_DELIVERED_SUBJECT : 'Thanks for your order!';
    return { ok: true, provider, model: res.model, subject: String(parsed.subject || dfltSubject).slice(0, 120), body: String(parsed.body).trim() };
  } catch (e) {
    return { ok: false, error: 'provider', message: String((e && e.message) || e) };
  }
}
