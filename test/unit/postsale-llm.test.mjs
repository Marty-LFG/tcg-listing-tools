// test/unit/postsale-llm.test.mjs — pure helpers of the post-purchase message drafter.
// Offline: nextBusinessDay / guardrailScrub / buildContext / systemPrompt. The live LLM call
// (draftMessage) is exercised manually + degrades gracefully with no key (tested here too).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextBusinessDay, guardrailScrub, buildContext, systemPrompt, draftMessage,
  friendlyFirstName, cardHook, shipByPhrase, fallbackDraft,
} from '../../lib/postsale-llm.mjs';

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

// --- fallback template draft ---
// The whole contract here is "personalise only when certain", so most of these assert the BAIL:
// a wrong name or a card they didn't buy is far worse than a slightly generic note.
describe('friendlyFirstName', () => {
  it('takes the first name off the shipping name', () => {
    assert.equal(friendlyFirstName('James Martin'), 'James');
  });
  it('title-cases shouty and all-lowercase entries, leaves real mixed case alone', () => {
    assert.equal(friendlyFirstName('jose anthony cardoso'), 'Jose');
    assert.equal(friendlyFirstName('JAMES MARTIN'), 'James');
    assert.equal(friendlyFirstName("Ronan O'Brien"), 'Ronan');
    assert.equal(friendlyFirstName('Ewan McDonald'), 'Ewan');
  });
  it('bails on a business name', () => {
    assert.equal(friendlyFirstName('James Martin Trading'), '');
    assert.equal(friendlyFirstName('Alpha Cards Pty Ltd'), '');
    assert.equal(friendlyFirstName('Southside Collectibles'), '');
  });
  it('bails on initials, handles, digits and junk', () => {
    assert.equal(friendlyFirstName('J Martin'), '');
    assert.equal(friendlyFirstName('J. Martin'), '');
    assert.equal(friendlyFirstName('horse_divorce'), '');
    assert.equal(friendlyFirstName('vanurb-12'), '');
    assert.equal(friendlyFirstName(''), '');
    assert.equal(friendlyFirstName(null), '');
  });
});

describe('cardHook', () => {
  it('keeps the card name and drops number, set, rarity and condition', () => {
    assert.equal(cardHook('Pokemon Sprigatito ex 251/217 Ascended Heroes Ultra Rare Holo EN M/NM'), 'Sprigatito ex');
    assert.equal(cardHook('Pokemon Mega Zeraora ex 027/084 Pitch Black Double Rare Holo EN M/NM'), 'Mega Zeraora ex');
    assert.equal(cardHook('Pokemon Primarina 85 Abyss Eye Holo JP M/NM'), 'Primarina');
    assert.equal(cardHook("Pokemon Misty's Spirit 108 Abyss Eye Super Rare Holo JP M/NM"), "Misty's Spirit");
  });
  it('bails on a title without the expected shape', () => {
    assert.equal(cardHook('Mystery bundle, 10 assorted holos, see photos'), '');
    assert.equal(cardHook('Pokemon'), '');
    assert.equal(cardHook(''), '');
  });
});

describe('shipByPhrase', () => {
  const from = new Date('2026-07-30T06:00:00Z');   // Thu 16:00 Sydney
  it('says "tomorrow" only when it really is the next calendar day', () => {
    assert.equal(shipByPhrase({ date: '2026-07-31', weekday: 'Friday' }, from), 'tomorrow');
  });
  it('names the weekday when it is not', () => {
    assert.equal(shipByPhrase({ date: '2026-08-03', weekday: 'Monday' }, from), 'on Monday');
  });
  it('empty when there is no next business day', () => {
    assert.equal(shipByPhrase(null, from), '');
  });
});

describe('fallbackDraft', () => {
  const shipBy = { date: '2026-07-31', weekday: 'Friday' };
  const now = new Date('2026-07-30T06:00:00Z');
  const one = [{ title: 'Pokemon Sprigatito ex 251/217 Ascended Heroes Ultra Rare Holo EN M/NM', quantity: 1 }];

  it('uses the name and the card when both are certain', () => {
    const d = fallbackDraft({ order: { ship_name: 'James Martin' }, items: one, shipBy, now });
    assert.equal(d.model, 'template');
    assert.deepEqual(d.personalised, { name: true, card: true });
    assert.match(d.body, /^Hey James, thanks/);
    assert.match(d.body, /Glad you grabbed that Sprigatito ex\./);
    assert.match(d.body, /posted tomorrow/);
  });
  it('still reads correctly with neither', () => {
    const d = fallbackDraft({ order: { ship_name: 'Alpha Cards Pty Ltd' }, items: [], shipBy, now });
    assert.deepEqual(d.personalised, { name: false, card: false });
    assert.match(d.body, /^Hey, thanks so much for your purchase!/);
    assert.doesNotMatch(d.body, /Glad you grabbed/);
    assert.doesNotMatch(d.body, /\{\{/);            // no unfilled placeholders leak to the buyer
  });
  it('never names a card on a multi-item or multi-quantity order', () => {
    const two = [...one, { title: 'Pokemon Yamper 099/094 Phantasmal Flames Illustration Rare Holo EN M/NM', quantity: 1 }];
    assert.equal(fallbackDraft({ order: {}, items: two, shipBy, now }).personalised.card, false);
    assert.equal(fallbackDraft({ order: {}, items: [{ ...one[0], quantity: 2 }], shipBy, now }).personalised.card, false);
  });
  it('passes the eBay contact guardrail in every combination', () => {
    for (const order of [{ ship_name: 'James Martin' }, { ship_name: 'Alpha Cards Pty Ltd' }, {}]) {
      for (const items of [one, [], [{ title: 'odd listing', quantity: 1 }]]) {
        assert.ok(guardrailScrub(fallbackDraft({ order, items, shipBy, now }).body).clean);
      }
    }
  });
  it('honours a custom template from config', () => {
    const d = fallbackDraft({
      order: { ship_name: 'James Martin' }, items: one, shipBy, now,
      cfg: { fallback_body: 'Yo{{name}}. {{card}}Posted {{ship_by}}. {{signature}}', fallback_card_line: 'Nice pickup on the {{card}}. ', signature: '-XX' },
    });
    assert.equal(d.body, 'Yo James. Nice pickup on the Sprigatito ex. Posted tomorrow. -XX');
  });
});

// A blank config string is "not set", not "send nothing". The settings form renders the config file,
// so a field added by a release is empty until backfilled — and a user can clear a box by hand.
describe('fallbackDraft — blank config falls back to the defaults', () => {
  const shipBy = { date: '2026-07-31', weekday: 'Friday' };
  const now = new Date('2026-07-30T06:00:00Z');
  const one = [{ title: 'Pokemon Sprigatito ex 251/217 Ascended Heroes Ultra Rare Holo EN M/NM', quantity: 1 }];

  it('an empty body never yields an empty message', () => {
    for (const blank of ['', '   ', '\n', null, undefined]) {
      const d = fallbackDraft({ order: { ship_name: 'James Martin' }, items: one, shipBy, now, cfg: { fallback_body: blank } });
      assert.equal(d.ok, true);
      assert.match(d.body, /^Hey James, thanks/, 'blank body must fall back to the default template');
    }
  });
  it('blank subject and card line fall back too', () => {
    const d = fallbackDraft({ order: { ship_name: 'James Martin' }, items: one, shipBy, now, cfg: { fallback_subject: '', fallback_card_line: '  ' } });
    assert.equal(d.subject, 'Thanks for your order!');
    assert.match(d.body, /Glad you grabbed that Sprigatito ex\./);
  });
  it('refuses rather than returning an empty body when the template holds only unfilled slots', () => {
    const d = fallbackDraft({ order: {}, items: [], shipBy, now, cfg: { fallback_body: '{{name}}{{card}}' } });
    assert.equal(d.ok, false);
    assert.equal(d.error, 'template_empty');
  });
});
