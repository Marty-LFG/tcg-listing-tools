// test/unit/postsale-llm.test.mjs — pure helpers of the post-purchase message drafter.
// Offline: nextBusinessDay / guardrailScrub / buildContext / systemPrompt. The live LLM call
// (draftMessage) is exercised manually + degrades gracefully with no key (tested here too).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextBusinessDay, guardrailScrub, buildContext, systemPrompt, draftMessage } from '../../lib/postsale-llm.mjs';

describe('nextBusinessDay', () => {
  const at = (iso) => nextBusinessDay(new Date(iso), { tz: 'Australia/Sydney' });
  it('a weekday → the following weekday', () => {
    assert.equal(at('2026-07-21T02:00:00Z').weekday, 'Wednesday'); // Tue (AEST) → Wed
  });
  it('Friday / Saturday / Sunday → Monday', () => {
    assert.equal(at('2026-07-24T02:00:00Z').weekday, 'Monday'); // Fri → Mon
    assert.equal(at('2026-07-25T02:00:00Z').weekday, 'Monday'); // Sat → Mon
    assert.equal(at('2026-07-26T02:00:00Z').weekday, 'Monday'); // Sun → Mon
  });
  it('skips a configured holiday', () => {
    // Fri 2026-07-24 → next is Mon 2026-07-27; if that Monday is a holiday, roll to Tue.
    const r = nextBusinessDay(new Date('2026-07-24T02:00:00Z'), { tz: 'Australia/Sydney', holidays: ['2026-07-27'] });
    assert.equal(r.weekday, 'Tuesday');
    assert.equal(r.date, '2026-07-28');
  });
  it('respects timezone at the day boundary', () => {
    // 2026-07-24T15:00Z is Sat 01:00 in Sydney (UTC+10) → next business day Monday.
    assert.equal(nextBusinessDay(new Date('2026-07-24T15:00:00Z'), { tz: 'Australia/Sydney' }).weekday, 'Monday');
  });
});

describe('guardrailScrub', () => {
  it('passes a clean plain-text message', () => {
    assert.deepEqual(guardrailScrub('Thanks so much, it will go out Monday. Cheers, BK'), { clean: true, violations: [] });
  });
  it('flags an email address', () => {
    assert.ok(guardrailScrub('email me at bk@store.com').violations.includes('email address'));
  });
  it('flags a link or bare domain', () => {
    assert.ok(guardrailScrub('see www.mystore.com').violations.includes('web address / link'));
    assert.ok(guardrailScrub('check mystore.store for more').violations.includes('web address / link'));
  });
  it('flags a phone number but not a card number or price', () => {
    assert.ok(guardrailScrub('call 0400 123 456').violations.includes('phone number'));
    assert.equal(guardrailScrub('Flygon ex 222/191, that will be A$45.50').clean, true);
  });
});

describe('buildContext', () => {
  it('marks a first-time buyer and lists the cards', () => {
    const t = buildContext({ order: { buyerUsername: 'amycatwiz' }, items: [{ title: 'Flygon ex 222/191', quantity: 1 }, { title: 'Gardevoir ex', quantity: 2 }], buyer: { order_count: 1 } });
    assert.match(t, /first-time buyer/);
    assert.match(t, /Flygon ex 222\/191/);
    assert.match(t, /Gardevoir ex \(x2\)/);
  });
  it('marks a repeat buyer and references a past card', () => {
    const t = buildContext({ order: { buyerUsername: 'amycatwiz' }, items: [{ title: 'Pikachu', quantity: 1 }], buyer: { order_count: 3 }, priorCards: ['Charizard ex'], shipBy: { weekday: 'Monday' } });
    assert.match(t, /repeat buyer/);
    assert.match(t, /Charizard ex/);
    assert.match(t, /Next business day for posting: Monday/);
  });
});

describe('systemPrompt', () => {
  it('encodes the hard voice rules + the signature', () => {
    const s = systemPrompt({ signature: '-BK', ship_timing_text: 'packed and sent the next business day' });
    assert.match(s, /No em dashes/);
    assert.match(s, /not X, but Y/);
    assert.match(s, /No links/);
    assert.match(s, /-BK/);
    assert.match(s, /JSON object/);
  });
});

describe('draftMessage degradation', () => {
  it('returns { ok:false, error:no_key } with no provider key (never throws)', async () => {
    const r = await draftMessage({ order: { buyerUsername: 'x' }, items: [], cfg: {}, env: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no_key');
  });
});
