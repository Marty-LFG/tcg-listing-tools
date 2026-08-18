// lib/deals.mjs — is this buyer asking for a deal, and what kind?
//
// Why this exists: the store turned Best Offer off and moved to three buyer-paid postage bands, so a
// buyer who wants a keener price, or one lot of postage on five cards, has no button to press. All
// they can do is ask — in a message, or by pressing "Request total" in the cart — and until now
// neither reached anybody. pollMemberMessages already stores every AskSellerQuestion, but its only
// consumer is maybeHandleReply, which fires solely for a KNOWN buyer with a PRIOR sent message. A
// pre-sale question from a stranger is written to the table and nothing happens: no alert, no card,
// no queue. That is the hole this closes.
//
// PURE: no fs, no fetch, no DOM, no DB. Importable by Vite plugins, Node harnesses and tests alike,
// which is what lets the classifier be exercised over a corpus without a database behind it.
//
// HIGH RECALL ON PURPOSE. Every hit is a proposal for a human, never an action — nothing here sends,
// prices or commits anything. A false positive costs a glance at a card that says "probably not a deal
// ask"; a false negative is a buyer who asked for a bundle and was ignored, which is a lost sale and a
// rude shop. So the rules lean towards firing, and the tests pin the specific phrases that must NOT.

// ---------------------------------------------------------------------------
// The false friends, and why each is worth a rule rather than a hope
// ---------------------------------------------------------------------------
// Three words carry almost all the risk, because each is ordinary English in this shop's inbox:
//
//   "total"  — "what's the total weight", "is this the total print run", "the total number printed".
//              Card buyers ask about print runs constantly. A bare /total/ would fire on all of them.
//   "offer"  — "do you offer tracking?", "do you offer returns?". With Best Offer switched off, this
//              is now the ONLY sense of the word a buyer is likely to mean.
//   "best"   — "what's the best way to ship this?", "best sleeve for this card?".
//
// So none of the three is ever matched alone: each needs a neighbour that makes the money sense the
// only reading. That is the whole design of the rule list below.

const rule = (name, re) => ({ name, re });

// A buyer asking to pay LESS for the cards themselves.
const DISCOUNT_RULES = [
  rule('best_price', /\bbest\s+(?:price|offer|deal)\b/i),
  rule('best_you_can_do', /\bbest\s+(?:you|u)\s+(?:can|could)\s+do\b/i),
  rule('discount', /\bdiscount(?:s|ed|ing)?\b/i),
  rule('deal', /\b(?:a|any|the|some)\s+deals?\b|\bdeals?\s+(?:on|for)\b|\bdo\s+a\s+deal\b/i),
  rule('bundle', /\bbundl(?:e|es|ed|ing)\b/i),
  rule('how_much_for_lot', /\bhow\s+much\s+for\s+(?:the\s+)?(?:lot|both|all|these|them)\b/i),
  rule('would_you_take', /\bwould\s+(?:you|u)\s+(?:take|accept|consider|do)\b/i),
  rule('take_amount', /\b(?:take|accept)\s*\$?\s*\d+(?:\.\d{2})?\b/i),
  rule('cheaper', /\bcheap(?:er|est)\b/i),
  rule('knock_off', /\bknock\s+(?:.{0,12}\s)?off\b|\btake\s+.{0,12}\s?off\s+the\s+price\b/i),
  rule('price_drop', /\b(?:lower|drop|reduce|budge\s+on)\s+(?:the\s+)?price\b/i),
  // "better price" is how most of these actually arrive, and it is unambiguous — nobody asks for a
  // better price about anything but money. "best way to ship" cannot reach it: different adjective.
  rule('better_price', /\b(?:better|keener|sharper)\s+(?:price|deal)\b|\bprice\s+drop\b/i),
  // "offer" only in its money sense: something is SENT, MADE, ACCEPTED or PUT IN. Never bare, so
  // "do you offer tracking" cannot reach it.
  rule('offer_verb', /\b(?:send|make|making|accept|accepting|put\s+in|open\s+to)\s+(?:me\s+)?(?:an?\s+)?offers?\b|\boffers?\s+(?:accepted|considered)\b/i),
];

// A buyer asking to pay one lot of POSTAGE instead of several. Distinct from a discount because the
// answer is different: combining postage costs the shop nothing it has not already priced in, whereas
// a discount comes off the cards.
const POSTAGE_RULES = [
  rule('combine_postage', /\bcombin\w*\s+(?:the\s+)?(?:post|postage|shipping|ship|freight|delivery)\w*\b/i),
  rule('postage_combined', /\b(?:post|postage|shipping|delivery)\s+combin\w*\b/i),
  rule('one_postage', /\b(?:one|single|1)\s+(?:lot\s+of\s+)?(?:post|postage|shipping)\b/i),
  rule('ship_together', /\b(?:ship|post|send)\s+(?:them|these|it|the\s+\w+)?\s*(?:all\s+)?together\b|\bin\s+(?:the\s+)?(?:one|same)\s+(?:parcel|satchel|envelope|package)\b/i),
  // A short gap is allowed before the "for", because the natural phrasing puts a verb in it — "what
  // would postage BE for all 4 cards". Bounded to one clause (no . ? !) so it cannot reach across two
  // unrelated sentences and invent a match out of two halves that were never together.
  rule('postage_on_multiple', /\b(?:post|postage|shipping)\b[^.?!]{0,14}?\b(?:on|for)\s+(?:both|all|multiple|several|the\s+lot|\d+\s*(?:cards?|items?))\b/i),
  // "total" only where it is being REQUESTED or SENT — never bare, so print-run questions cannot reach
  // it. This is also the exact phrase eBay's own cart button uses ("Request total from seller"), which
  // is what a buyer copies into a message when the button is not offered.
  rule('request_total', /\b(?:request|send|sent|sending|get|give|work\s+out|calculate)\w*\s+(?:me\s+)?(?:an?\s+|the\s+|a\s+)?(?:combined\s+|total\s+)?(?:total|invoice)\b/i),
  rule('total_for_lot', /\btotal\s+(?:for|on)\s+(?:the\s+)?(?:lot|both|all|these|them|\d+)\b/i),
  rule('invoice', /\binvoice\b/i),
];

/**
 * classifyDealAsk(subject, body) → { ask, kind, matched }
 *
 *   ask     — boolean, did anything fire
 *   kind    — 'discount' | 'combined_postage' | 'both' | null
 *   matched — the rule NAMES that fired, so a card can say WHY it was flagged and a false positive is
 *             debuggable without re-running the regexes by hand
 *
 * Subject and body are read as one blob. eBay puts a lot of the intent in the subject line ("Bundle
 * deal?") and sometimes leaves the body near-empty, so scoring them apart would only lose signal.
 */
export function classifyDealAsk(subject, body) {
  const text = normaliseForMatch(subject, body);
  if (!text) return { ask: false, kind: null, matched: [] };
  const discount = DISCOUNT_RULES.filter((r) => r.re.test(text)).map((r) => r.name);
  const postage = POSTAGE_RULES.filter((r) => r.re.test(text)).map((r) => r.name);
  const kind = discount.length && postage.length ? 'both'
    : discount.length ? 'discount'
      : postage.length ? 'combined_postage'
        : null;
  return { ask: !!kind, kind, matched: [...discount, ...postage] };
}

/**
 * One lowercase blob from a subject and a body, with the parts that would cause false matches removed.
 *
 * QUOTED HISTORY IS STRIPPED. eBay threads quote the previous message inline, so our own dispatch note
 * — which the post-sale copy has always used to invite bundle deals — would come back quoted in every
 * single reply and match `bundle` forever. Classifying our own words as the buyer's ask would turn
 * every thank-you into a deal request. Lines beginning with `>` and everything after eBay's own
 * separators go.
 */
export function normaliseForMatch(subject, body) {
  const raw = [subject || '', body || ''].join('\n');
  const cut = raw
    .split(/\n-{2,}\s*original message\s*-{2,}|\n_{5,}|\bon .{0,40}wrote:/i)[0]
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
  return cut.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Exported for the test harness, so a corpus test can report which rule is over-firing rather than
// only that something did.
export const DEAL_RULE_NAMES = [...DISCOUNT_RULES, ...POSTAGE_RULES].map((r) => r.name);
