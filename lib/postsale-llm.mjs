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

// --- calendar helpers (pure, dependency-free, timezone-aware) ---
// There is no date library in this repo, by choice, so the three primitives every timing decision
// needs live here and nowhere else: read the local calendar, step a day, find the next working day.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Local wall clock in an IANA zone, in one formatToParts pass. `minutes` is the since-midnight
// figure a cut-off compares against.
export function localParts(from = new Date(), tz = 'Australia/Sydney') {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(from);
  const g = (t) => p.find((x) => x.type === t).value;
  // Some ICU builds render midnight as hour 24 under hour12:false. Left alone, a 00:30 order would
  // read as 24:30 and fall after every sane cut-off — the exact 1am case this all exists for.
  const hour = (+g('hour')) % 24;
  const minute = +g('minute');
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour, minute, minutes: hour * 60 + minute };
}

const addDay = (iso) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

// The first working day at or AFTER `iso`. The one place weekend + holiday skipping lives, so
// nextBusinessDay and dispatchDay cannot end up disagreeing about what a working day is.
function scanBusiness(iso, holidaySet) {
  const dt = new Date(iso + 'T00:00:00Z');
  for (let i = 0; i < 21; i++) {
    const dow = dt.getUTCDay();
    const d = dt.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(d)) return { date: d, weekday: WEEKDAYS[dow] };
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return null;
}

// Strictly the next calendar day AFTER `from` that is a weekday and not a listed holiday, computed in
// the given IANA timezone. Returns { date:'YYYY-MM-DD', weekday:'Monday' } (or null if none in range).
// Never returns today. dispatchDay() below is the one that can.
export function nextBusinessDay(from = new Date(), { tz = 'Australia/Sydney', holidays = [] } = {}) {
  return scanBusiness(addDay(localParts(from, tz).date), new Set(holidays || []));
}

// The day the parcel actually goes out, which unlike nextBusinessDay CAN be today. Returns
// { date, weekday, sameDay }. Same-day needs both: `now` falls on a working day, and the local
// clock has not passed `cutoff`. Otherwise it rolls forward and gives what nextBusinessDay gives.
//
// The basis is `now`, not the order's paid_time, and that is deliberate. "When does this get
// packed" is a question about the clock on the wall as the message is written, not about when the
// payment landed. It is also what keeps a redraft honest: regenerating a three-day-old draft
// recomputes against today instead of resurrecting a promise that has already expired.
export function dispatchDay(now = new Date(), { tz = 'Australia/Sydney', holidays = [], cutoff = '12:00' } = {}) {
  const holidaySet = new Set(holidays || []);
  const at = localParts(now, tz);
  const roll = () => { const r = scanBusiness(addDay(at.date), holidaySet); return r && { ...r, sameDay: false }; };
  // A real 24h time, not just two numbers with a colon: "25:00" would otherwise read as 1500
  // minutes past midnight, which is after nothing, and every order all night would be same-day.
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(cutoff == null ? '' : cutoff).trim());
  // An unparseable cut-off fails CLOSED. A typo in the settings box degrades to the old behaviour
  // rather than promising same-day dispatch at every hour of the night.
  if (!m) return roll();
  if (at.minutes > (+m[1]) * 60 + (+m[2])) return roll();
  const today = scanBusiness(at.date, holidaySet);
  if (!today || today.date !== at.date) return roll();          // a weekend or a listed holiday
  return { ...today, sameDay: true };
}

// --- where the buyer's own calendar is ---
// "later today" and "tomorrow" are only true inside one calendar. Someone in Perth reading a
// message sent at 1am Sydney is still on yesterday's date, so a relative word names the wrong day
// for them. Knowing their zone is what lets shipTiming() fall back to wording true everywhere.
const AU_ZONE = {
  wa: 'Australia/Perth', nt: 'Australia/Darwin', sa: 'Australia/Adelaide',
  qld: 'Australia/Brisbane', nsw: 'Australia/Sydney', act: 'Australia/Sydney',
  vic: 'Australia/Melbourne', tas: 'Australia/Hobart',
};
const AU_STATE_NAME = {
  westernaustralia: 'wa', northernterritory: 'nt', southaustralia: 'sa', queensland: 'qld',
  newsouthwales: 'nsw', australiancapitalterritory: 'act', jervisbayterritory: 'act',
  victoria: 'vic', tasmania: 'tas',
};
// Second rung, because eBay's state field is free text and a junk value turns up far more often
// than a junk postcode. Broken Hill (2880) runs ACST under a NSW postcode and Lord Howe is +10:30;
// both read as Sydney and are half an hour out for part of the night, which on a whole-day promise
// changes nothing.
function zoneFromPostcode(pc) {
  const n = String(pc == null ? '' : pc).trim();
  if (!/^\d{4}$/.test(n)) return null;
  if (n.startsWith('08') || n.startsWith('09')) return AU_ZONE.nt;
  if (n.startsWith('02')) return AU_ZONE.act;
  return ({ 6: AU_ZONE.wa, 5: AU_ZONE.sa, 7: AU_ZONE.tas, 3: AU_ZONE.vic, 8: AU_ZONE.vic,
    4: AU_ZONE.qld, 9: AU_ZONE.qld, 1: AU_ZONE.nsw, 2: AU_ZONE.nsw })[n[0]] || null;
}

// The buyer's IANA zone, or null when we cannot be sure. null is always safe: it downgrades the
// wording to something true in every timezone. A WRONG zone is not safe, which is why the country
// gate is load-bearing rather than defensive — "WA" is Western Australia AND Washington State, and
// reading a Seattle order as Perth is the precise mistake this function exists to prevent.
export function buyerZone(order = {}) {
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z]/g, '');
  if (!(norm(order.ship_country) === 'au' || norm(order.ship_country_name) === 'australia')) return null;
  const st = norm(order.ship_state);
  return AU_ZONE[st] || AU_ZONE[AU_STATE_NAME[st]] || zoneFromPostcode(order.ship_postal) || null;
}

// A blank config string means "not set", not "render nothing". The settings form renders the config
// FILE, so a field added in a later release shows as an empty box until it is backfilled, and a user
// can clear one by hand too. `??` would accept "" and mail the buyer an empty message.
const orDefault = (v, dflt) => (v == null || String(v).trim() === '' ? dflt : String(v));

export const DEFAULT_SHIP_TIMING_TEXT = 'packed and sent {{when}}';

// The ONLY way the dispatch promise gets rendered. Every caller goes through here, including the
// no-timing path, because a lane that skips the substitution mails the buyer a literal
// "packed and sent {{when}}". shipBy really can be null — scanBusiness gives up after 21 days, so
// a Christmas shutdown listed day-by-day in `holidays` reaches it.
const fillWhen = (cfg, when) => orDefault(cfg.ship_timing_text, DEFAULT_SHIP_TIMING_TEXT).replace(/\{\{\s*when\s*\}\}/g, when);

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
export function systemPrompt(cfg = {}, timing = null) {
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
    '- Tell them it will be ' + (timing ? timing.sentence : fillWhen(cfg, 'the next business day')) + '.',
    // The ban is not belt-and-braces. "next business day" is overwhelmingly the model's prior for a
    // card-store thank-you, so given "later today" it will helpfully normalise it away — and the
    // phrase has already been worked out against the cut-off AND the buyer's own timezone, so any
    // substitution the model makes is wrong by construction.
    ...(timing ? [
      '  Use "' + timing.phrase + '" for the timing, in exactly those words. Do NOT swap it for',
      '  "tomorrow", a weekday, "the next business day", or a time of day, and do not add a second',
      '  mention of when it goes. Say it once, in those words.',
    ] : ['  If a specific next-business-day weekday is provided, you may mention it naturally.']),
    // NAMES THE MECHANISM THAT EXISTS. This used to invite an offer, which stopped being true the day
    // Best Offer went off store-wide: the button it pointed at is gone, so the line was sending buyers
    // to look for something they would not find. What replaced it is asking for a total, which the
    // shop answers with one invoice carrying one lot of postage.
    cfg.invite_offers === false ? '' : '- A light, no-pressure line that if there is anything else they are after they can add it to their cart and ask for a total, and the shop will send one invoice with a single lot of postage.',
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
  // The parcel is sealed. Nothing can be added to it, so any hint of "want to add anything?" is an
  // offer we cannot honour and reads as careless to someone who has already paid.
  lines.push(
    '- This order is already packed and ' + (delivered ? 'delivered' : 'posted') + '. NOTHING can be added to it now, so never',
    '  mention bundles, combining items, adding to the order, or saving on postage by buying more.',
    '  Do not ask whether they want anything else in this parcel.');
  if (delivered) {
    lines.push(
      '- Say their order should have arrived.',
      '- Name the card or cards if they are given, briefly.',
      '- Hope they love it. Keep the whole message warm and POSITIVE.',
      '- One light, low-pressure line that a rating on eBay helps a small store. Do not beg, do not offer',
      '  anything in exchange, and do not ask for a specific number of stars.',
      // Asking "is anything wrong?" right before asking for a rating invites someone to go looking for
      // a fault they had not thought about. A buyer with a real problem already knows how to reach us.
      '- Do NOT invite them to check the cards over or to tell us if something is wrong. Never mention',
      '  damage, faults, mistakes, problems, issues, refunds, returns or anything going wrong, and do',
      '  not hedge the message with "if you are happy with it" or similar. Assume it arrived well.');
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
  // Repeat business is still the point; it just has to be about NEXT time. Both follow-ups carry it,
  // and it is the same nudge in both so the store sounds consistent rather than opportunistic.
  if (cfg.invite_offers !== false) {
    lines.push(
      '- Finish with one short, no-pressure line inviting them to ask for a total NEXT time there is',
      '  something they are after. Keep it clearly about a future order, never about this one.');
  }
  if (cfg.brand_voice) lines.push('', 'Store voice note from the owner: ' + cfg.brand_voice);
  // style_notes is deliberately NOT passed here. It is written for the thank-you ("give the ship
  // timing, invite bundle deals"), and both of those are wrong once the parcel has gone. brand_voice
  // is tone, so it travels; style_notes is content for a different message.
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
    // The buyer chose one service and we posted it on a better one, and the model has to be told so
    // in words. Handed "Postage service: Regular letter" beside "There IS a tracking number" it wrote
    // exactly what those two facts say together, which is a plain letter that somehow has tracking.
    // eBay gives no name for what was actually bought (only the tracking details), so the instruction
    // is to describe it, not to name it.
    if (postage.tracked_evidence) {
      lines.push('That is what they PAID for at checkout. We have since upgraded it and it has gone '
        + 'TRACKED. Say it went tracked. Do not call it a plain, standard or regular letter, and do '
        + 'not name the upgraded service — we do not know what it is called.');
    }
    if (postage.tracking) lines.push('There IS a tracking number, and it is appended after your message. Do not write it yourself.');
    // Gated on the SERVICE, not on the absence of a number. A tracked order whose label has not been
    // bought yet also has no tracking number, and telling that buyer their card "went as a plain
    // letter" is both wrong and the opposite of what they paid $8.26 for.
    else if (postage.tracked) lines.push('This one is going tracked, but the tracking number is not available yet — do not promise one in this message.');
    else lines.push('There is no tracking number for this one (it went as a plain letter).');
    if (postage.note) lines.push('Note about the service: ' + postage.note + '.');
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
export function buildContext({ order, items, buyer, priorCards = [], shipBy, timing = null } = {}) {
  const its = (items || []).map((it) => `${it.title || it.sku || it.ebay_item_id || 'a card'}${it.quantity > 1 ? ` (x${it.quantity})` : ''}`);
  const repeat = !!(buyer && buyer.order_count > 1) || (priorCards && priorCards.length > 0);
  const lines = [];
  lines.push('Buyer username: ' + (order?.buyerUsername || order?.buyer_username || buyer?.ebay_username || 'the buyer'));
  lines.push(repeat
    ? `This is a repeat buyer (${(buyer && buyer.order_count) || 'a returning'} orders with the store so far).`
    : 'This is a first-time buyer.');
  lines.push('They just bought: ' + (its.length ? its.join(', ') : 'a card') + '.');
  // Never both. Handed "later today" AND "Tuesday", the model writes "later today, on Tuesday".
  if (timing && timing.phrase) lines.push('When it goes out, in the exact words to use: ' + timing.phrase + '.');
  else if (shipBy && shipBy.weekday) lines.push('Next business day for posting: ' + shipBy.weekday + '.');
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
  return addDay(localParts(from, tz).date) === shipBy.date ? 'tomorrow' : 'on ' + shipBy.weekday;
}

// The one computed timing object. Every lane that mentions when the parcel goes reads THIS: the
// system prompt, the facts turn, and the {{ship_by}} slot in the template fallback. Each of the
// three used to phrase it for itself, which is three chances to tell one buyer three different
// things about one parcel inside one message.
//
// The ambiguity rule is the whole point of the thing. "later today" and "tomorrow" are only true
// inside one calendar. Someone in Perth reading a note sent at 1am Sydney is still on yesterday's
// date, so those words name the wrong day for them. When their date is not our date, or we cannot
// work out what their date is, the wording drops to something true in every timezone.
export function shipTiming({ shipBy, order = {}, cfg = {}, now = new Date() } = {}) {
  if (!shipBy || !shipBy.date) return null;
  const tz = cfg.timezone || 'Australia/Sydney';
  const storeDate = localParts(now, tz).date;
  const buyerTz = buyerZone(order);
  const sameCalendar = !!buyerTz && localParts(now, buyerTz).date === storeDate;
  // Naming the weekday is right in every zone and stays right when a holiday pushes dispatch out a
  // day. "the next business day" reads more naturally at 11pm but is wrong on exactly that roll.
  const safe = cfg.different_day_wording === 'next business day' ? 'the next business day' : 'on ' + shipBy.weekday;
  let phrase;
  if (!sameCalendar) phrase = safe;
  else if (shipBy.sameDay) phrase = orDefault(cfg.same_day_text, 'later today');
  else phrase = addDay(storeDate) === shipBy.date ? 'tomorrow' : 'on ' + shipBy.weekday;
  return { date: shipBy.date, weekday: shipBy.weekday, sameDay: !!shipBy.sameDay, phrase, sentence: fillWhen(cfg, phrase), buyerTz };
}

export const DEFAULT_FALLBACK_SUBJECT = 'Thanks for your order!';
export const DEFAULT_FALLBACK_CARD_LINE = 'Glad you grabbed that {{card}}. ';
export const DEFAULT_FALLBACK_BODY = [
  'Hey{{name}}, thanks so much for your purchase!',
  '',
  // One source line per rendered line: a wrapped string here becomes a hard newline mid-sentence
  // in the buyer's message.
  "{{card}}We'll get this packed up and posted {{ship_by}}, and if there's anything else you're after just pop it in your cart and ask us for a total. Happy to do one lot of postage on a few.",
  '',
  'Thanks again!',
  '{{signature}}',
].join('\n');

// Fill the configured template. {{name}} and {{card}} collapse to nothing when we aren't sure, which
// is why the default body reads correctly either way ("Hey James, thanks" / "Hey, thanks").
export function fallbackDraft({ order, items = [], cfg = {}, shipBy, timing = null, now = new Date() } = {}) {
  const name = friendlyFirstName(order?.ship_name);
  // Only name a card on a single-line, single-quantity order: "that Dragonite" is plainly wrong when
  // they bought three things, and picking one of them to mention is worse than mentioning none.
  const one = items.length === 1 && (!items[0].quantity || items[0].quantity === 1);
  const hook = one ? cardHook(items[0].title) : '';
  const cardLine = hook
    ? orDefault(cfg.fallback_card_line, DEFAULT_FALLBACK_CARD_LINE).replace(/\{\{\s*card\s*\}\}/g, hook)
    : '';
  // Same object, same words as the prompt lane got. That equality is the point: the two lanes used
  // to phrase this independently, so a buyer could be told two different things in one message.
  const ship = (timing && timing.phrase)
    || shipByPhrase(shipBy, now, cfg.timezone || 'Australia/Sydney')
    || 'the next business day';
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
// Not "Did your cards arrive okay?": a question phrased that way is answered by looking for a reason
// to say no, and it is the first thing the buyer reads.
export const DEFAULT_DELIVERED_SUBJECT = 'Hope you love your cards';

export function fallbackFollowUp({ order, items = [], postage = {}, cfg = {}, kind = 'dispatch' } = {}) {
  const name = friendlyFirstName(order?.ship_name);
  const hey = 'Hey' + (name ? ' ' + name : '') + ',';
  const one = items.length === 1 && (!items[0].quantity || items[0].quantity === 1);
  const hook = one ? cardHook(items[0].title) : '';
  const sig = (cfg.signature || '-BK').trim();
  const what = hook ? 'your ' + hook : 'your order';
  // Nothing can go in the parcel now, so this invites a FUTURE order rather than an addition to this
  // one. Anything about bundles or combined postage would be an offer we cannot honour. One shared
  // line, so the dispatch and delivered notes cannot drift into saying it two different ways.
  const offer = cfg.invite_offers === false ? []
    : ['', "Next time there's something you're after, pop it in your cart and ask us for a total."];
  let body;
  if (kind === 'delivered') {
    // Deliberately says nothing about anything being wrong. Inviting an inspection right before asking
    // for a rating hands someone a reason to go looking for a fault they were not thinking about.
    body = [
      hey,
      '',
      what.charAt(0).toUpperCase() + what.slice(1) + ' should have landed. Hope you love it.',
      '',
      'A quick rating on eBay really helps a small store like ours.',
      ...offer,
      '',
      'Thanks again,',
      sig,
    ].join('\n');
  } else {
    // An upgraded order does NOT get told the service it was bought under. The buyer picked a plain
    // letter, we sent it tracked, and "It's going Regular letter" printed above a tracking number is
    // the sentence that started all this. We cannot name what it went as (eBay does not say), so say
    // the true and useful part.
    const svc = postage.tracked_evidence ? ' We\'ve sent it tracked.'
      : postage.label ? ' It\'s going ' + postage.label + '.' : '';
    const trk = postage.tracking
      ? '\nThe tracking number is at the bottom of this message, and eBay shows it on your order page too.'
      : '';
    body = [
      hey,
      '',
      'Just letting you know ' + what + ' went in the post today.' + svc + trk,
      ...offer,
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
export async function draftMessage({ order, items, buyer, priorCards = [], cfg = {}, env = {}, shipBy, timing = null, kind = 'purchase', postage = {} } = {}) {
  try {
    const provider = pickProvider(env);
    if (!provider) return { ok: false, error: 'no_key', message: 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.' };
    const followUp = kind === 'dispatch' || kind === 'delivered';
    const sys = followUp ? followUpSystemPrompt(cfg, kind) : systemPrompt(cfg, timing);
    const user = followUp ? buildFollowUpContext({ order, items, postage, kind })
      : buildContext({ order, items, buyer, priorCards, shipBy, timing });
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
