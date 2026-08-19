// test/unit/deals-card.test.mjs — the Telegram deal card.
//
// Two things are worth pinning here and neither is the wording. First, the callback PREFIX: an
// unregistered one does not error, it falls through the handler's early return and is dropped
// silently, so the button visibly does nothing — which is why the matcher is asserted against every
// prefix already in use rather than eyeballed. Second, what the card is allowed to SAY: no profit
// figure can appear on a screen the owner decides from.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderDealCard } from '../../lib/telegram-cards.mjs';

// The complete set of callback prefixes in the app: post-sale approve/skip, the hold ack, the four
// digest actions, and the repricer's two.
const TAKEN = ['psa:5', 'pss:5', 'psk:ORD-1', 'psp:3', 'psdq:3', 'psdy:3', 'psdn:3', 'ap:9', 'sk:9'];
const DEAL_RE = /^psi(y|n|):(\d+)$/;

const full = {
  buyerUsername: 'buyer_bob', kind: 'both', matched: ['bundle', 'combine_postage'], source: 'message',
  lines: [{ title: 'Pikachu 025/165 SV151 Near Mint', sku: 'BK-A', quantity: 1 },
    { title: 'Charizard ex 006/165 SV151 Near Mint', sku: 'BK-B', quantity: 2 }],
  subtotalText: 'A$530.00', discountText: 'A$50.00', postageText: 'A$15.20',
  bandLabel: 'Tracked + signature', boundBy: 'line', totalText: 'A$495.20',
  costText: 'A$310.00', costComplete: true, warnings: [],
};

describe('the deal callback prefix', () => {
  it('matches its own three and nothing else in the app', () => {
    assert.deepEqual('psi:12'.match(DEAL_RE).slice(1), ['', '12'], 'arm');
    assert.deepEqual('psiy:12'.match(DEAL_RE).slice(1), ['y', '12'], 'confirm');
    assert.deepEqual('psin:12'.match(DEAL_RE).slice(1), ['n', '12'], 'skip');
    for (const t of TAKEN) assert.equal(DEAL_RE.test(t), false, `${t} must not be claimed by the deal handler`);
  });

  it('will not match a non-numeric id', () => {
    // The id goes straight into a lookup, and the digest handler learned this the hard way: psk: had
    // to take (.+) because an ORDER id has dashes, which is exactly why the numeric ones are strict.
    assert.equal(DEAL_RE.test('psi:abc'), false);
    assert.equal(DEAL_RE.test('psi:'), false);
  });
});

describe('renderDealCard', () => {
  it('leads with the ask, in words, and says which rules fired', () => {
    const s = renderDealCard(full);
    assert.match(s, /DEAL REQUEST/);
    assert.match(s, /@buyer_bob/);
    assert.match(s, /a better price AND combined postage/);
    assert.match(s, /matched: bundle, combine_postage/, 'so a false positive is dismissable at a glance');
  });

  it('names each ask kind in plain words', () => {
    assert.match(renderDealCard({ ...full, kind: 'discount' }), /asking for a better price</);
    assert.match(renderDealCard({ ...full, kind: 'combined_postage' }), /asking for combined postage</);
    assert.match(renderDealCard({ ...full, kind: null }), /asking for a deal</);
  });

  it('explains WHY that postage band, not just which', () => {
    // A cart of cheap commons going signature reads as a bug until the reason is on the card.
    assert.match(renderDealCard({ ...full, boundBy: 'subtotal' }), /the order total/);
    assert.match(renderDealCard({ ...full, boundBy: 'slab' }), /never travels untracked/);
    assert.match(renderDealCard({ ...full, boundBy: 'line' }), /its dearest card/);
  });

  it('NEVER shows a profit figure', () => {
    // lib/fees.mjs models the AU buyer-protection fee only; there is no seller final-value-fee model
    // in this repo, so any "you still make" would be confidently wrong (GR4).
    const s = renderDealCard(full);
    assert.ok(!/profit|margin|you (still )?make|net\b/i.test(s), s);
    assert.match(s, /before eBay's buyer-protection fee/, 'and the total says what it excludes');
  });

  it('flags an incomplete cost basis rather than implying it knows', () => {
    assert.match(renderDealCard({ ...full, costComplete: false }), /some lines unknown/);
    assert.ok(!/some lines unknown/.test(renderDealCard(full)));
    assert.ok(!/cost basis/.test(renderDealCard({ ...full, costText: null })), 'unknown means silent, not zero');
  });

  it('offers no Send wording until a figure exists', () => {
    const priced = renderDealCard(full);
    const unpriced = renderDealCard({ ...full, totalText: null, discountText: null });
    assert.match(priced, /cannot be undone from here/);
    assert.match(unpriced, /No discount worked out yet/);
    assert.ok(!/cannot be undone/.test(unpriced));
  });

  it('says so plainly when a dry run means nothing will be sent', () => {
    assert.match(renderDealCard({ ...full, dryRun: true }), /Dry run is ON/);
  });

  it('carries every warning through', () => {
    const s = renderDealCard({ ...full, warnings: [{ message: 'that is 60% off the cards' }, { message: 'below cost' }] });
    assert.match(s, /60% off the cards/);
    assert.match(s, /below cost/);
  });

  it('shows quantity only when there is more than one', () => {
    const s = renderDealCard(full);
    assert.match(s, /×2/);
    assert.ok(!/×1/.test(s));
  });

  it('escapes what a buyer or a card title can put in it', () => {
    const s = renderDealCard({ ...full, buyerUsername: '<b>bob</b>', lines: [{ title: 'Fire & Ice <script>', quantity: 1 }] });
    assert.ok(!/<b>bob<\/b>/.test(s));
    assert.ok(!/<script>/.test(s));
    assert.match(s, /&amp;/);
  });

  it('stamps the outcome once decided, and drops the call to action', () => {
    const s = renderDealCard(full, { icon: '✅', status: 'Invoice sent', who: 'Marty' });
    assert.match(s, /✅ <b>Invoice sent<\/b>/);
    assert.match(s, /Marty/);
    assert.ok(!/cannot be undone/.test(s), 'a decided card is a record, not a prompt');
  });
});
