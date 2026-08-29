// test/unit/deals-classify.test.mjs — classifyDealAsk over the things buyers actually write.
//
// The classifier is high-recall by design (every hit is a proposal for a human, never an action), so
// the interesting half of this file is the NEGATIVE corpus: the ordinary questions a card shop gets
// every day that must not be mistaken for a deal ask. Three words carry the whole risk — "total",
// "offer" and "best" — because each is unremarkable English in this inbox.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDealAsk, normaliseForMatch, DEAL_RULE_NAMES, stripQuotedHistory } from '../../lib/deals.mjs';

const kindOf = (s, b) => classifyDealAsk(s, b).kind;
const asks = (s, b) => classifyDealAsk(s, b).ask;

describe('classifyDealAsk — a buyer asking to pay less for the cards', () => {
  const DISCOUNT = [
    ['Best price?', ''],
    ['', 'hey mate whats the best you can do on this one?'],
    ['', 'Any discount if I grab a few?'],
    ['Bundle deal', 'keen on a bundle if you can sort me out'],
    ['', 'would you take $40 for it?'],
    ['', 'Would you accept 55'],
    ['', 'is there any chance you could do a deal on these two'],
    ['', 'can you go any cheaper on this'],
    ['', 'any chance you could knock a few bucks off'],
    ['', 'would you consider lowering the price at all?'],
    ['', 'happy to send an offer if you take them'],
    ['', 'how much for the lot?'],
  ];
  for (const [s, b] of DISCOUNT) {
    it(`fires on: ${(s || b).slice(0, 52)}`, () => {
      const r = classifyDealAsk(s, b);
      assert.ok(r.ask, 'should be flagged');
      assert.ok(r.kind === 'discount' || r.kind === 'both', `kind was ${r.kind}`);
      assert.ok(r.matched.length, 'should name the rule that fired');
    });
  }
});

describe('classifyDealAsk — a buyer asking to pay one lot of postage', () => {
  const POSTAGE = [
    ['', 'can you combine postage on these?'],
    ['', 'Is shipping combined if I buy 3'],
    ['', 'happy to buy both if they can go in the one satchel'],
    ['', 'could you send me a total for the lot'],
    ['', 'can you send an invoice please'],
    ['', 'requesting a combined total'],
    ['', 'what would postage be for all 4 cards'],
    ['', 'can you post them together'],
  ];
  for (const [s, b] of POSTAGE) {
    it(`fires on: ${(s || b).slice(0, 52)}`, () => {
      const r = classifyDealAsk(s, b);
      assert.ok(r.ask, 'should be flagged');
      assert.ok(r.kind === 'combined_postage' || r.kind === 'both', `kind was ${r.kind}`);
    });
  }
});

describe('classifyDealAsk — THE NEGATIVES, which are the ones that matter', () => {
  // Every one of these is a real shape of question this shop gets, and every one contains a word the
  // classifier cares about. If any starts firing, the deal queue fills with noise and stops being read.
  const NOT_A_DEAL = [
    ["what's the total weight of the parcel?", ''],
    ['', 'is this the total print run for the set?'],
    ['', 'do you know the total number printed of this alt art?'],
    ['', 'do you offer tracking on letters?'],
    ['', 'Do you offer returns if it arrives damaged'],
    ['', "what's the best way to ship this so it doesn't bend?"],
    ['', 'best sleeve to use for a card this thick?'],
    ['', 'is this the first edition print?'],
    ['', 'hi, is this card still available?'],
    ['', 'what condition is the back of the card in?'],
    ['', 'has this been graded before?'],
    ['', 'can you post to New Zealand?'],
    ['', 'how long does postage usually take to WA?'],
    ['', 'is the holo pattern the cosmos one?'],
    ['', 'thanks, received it today, card is perfect'],
  ];
  for (const [s, b] of NOT_A_DEAL) {
    it(`stays quiet on: ${(s || b).slice(0, 52)}`, () => {
      const r = classifyDealAsk(s, b);
      assert.equal(r.ask, false, `fired on "${s || b}" via ${r.matched.join(', ')}`);
      assert.equal(r.kind, null);
    });
  }
});

describe('classifyDealAsk — mechanics', () => {
  it('reads subject and body as one blob, because eBay puts the intent in either', () => {
    assert.equal(asks('Bundle deal?', ''), true, 'subject alone');
    assert.equal(asks('', 'any chance of a bundle'), true, 'body alone');
    assert.equal(asks('', ''), false);
    assert.equal(asks(null, undefined), false);
  });

  it('reports BOTH when a buyer asks for a discount and combined postage in one message', () => {
    const r = classifyDealAsk('', 'if I take all three can you do a better price and combine postage?');
    assert.equal(r.kind, 'both');
    assert.ok(r.matched.length >= 2);
  });

  it('names real rules, so a false positive can be traced without rerunning the regexes', () => {
    const r = classifyDealAsk('', 'any discount on these?');
    assert.ok(r.matched.every((m) => DEAL_RULE_NAMES.includes(m)), r.matched.join(','));
  });

  it('IGNORES OUR OWN QUOTED WORDS — the one that would have fired on every thank-you', () => {
    // The post-sale thank-you has always invited bundle deals, and eBay threads quote the previous
    // message inline. Without stripping quoted history, every single reply to our own note would
    // classify as a deal ask because it contains our sentence, not the buyer's.
    const quoted = [
      'Cheers, got it thanks!',
      '',
      '> Hey Sam, thanks so much for your purchase!',
      '> We love doing bundle deals, so if there\'s anything else you\'re after just let us know.',
    ].join('\n');
    const r = classifyDealAsk('Re: Thanks for your order!', quoted);
    assert.equal(r.ask, false, `fired via ${r.matched.join(', ')}`);
  });

  it('drops everything after an eBay quote separator', () => {
    const threaded = 'no worries thanks\n\n--- Original Message ---\ncan you do a bundle discount?';
    assert.equal(classifyDealAsk('', threaded).ask, false);
    assert.ok(!normaliseForMatch('', threaded).includes('bundle'));
  });

  it('still fires when the buyer writes above a quote, which is the normal reply shape', () => {
    const r = classifyDealAsk('', 'actually could you do a deal on both?\n\n> earlier message here');
    assert.equal(r.ask, true);
  });

  it('is case and punctuation tolerant', () => {
    assert.equal(asks('', 'BEST PRICE???'), true);
    assert.equal(asks('', 'Any   Discount?'), true);
  });
});

describe('stripQuotedHistory — the buyer’s words, not ours quoted back', () => {
  it('cuts the quoted history eBay staples under a reply', () => {
    const body = 'Yeah go on then.\n> Thanks for your order! Ask us for a bundle price any time.\n> -BK';
    assert.equal(stripQuotedHistory(body), 'Yeah go on then.');
  });

  it('cuts at the separators too', () => {
    assert.equal(stripQuotedHistory('ok\n--- Original Message ---\nour old note'), 'ok');
    assert.equal(stripQuotedHistory('ok\n_______\nour old note'), 'ok');
    assert.equal(stripQuotedHistory('ok\nOn Tuesday BindersKeepers wrote:\nour old note'), 'ok\n');
  });

  it('keeps the shape of what they actually wrote', () => {
    // Unlike normaliseForMatch this is for DISPLAY, so it must not lowercase or collapse the text.
    assert.equal(stripQuotedHistory('Is This The Alt Art?\nCheers'), 'Is This The Alt Art?\nCheers');
  });

  it('never throws', () => {
    assert.equal(stripQuotedHistory(null), '');
    assert.equal(stripQuotedHistory(undefined), '');
  });

  it('is the same strip the classifier uses, so a card and a match can never disagree', () => {
    const body = 'best price?\n> ask us for a bundle';
    assert.equal(normaliseForMatch('', body), stripQuotedHistory(body).replace(/\s+/g, ' ').trim().toLowerCase());
  });
});
