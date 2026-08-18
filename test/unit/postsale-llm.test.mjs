// test/unit/postsale-llm.test.mjs — pure helpers of the post-purchase message drafter.
// Offline: nextBusinessDay / guardrailScrub / buildContext / systemPrompt. The live LLM call
// (draftMessage) is exercised manually + degrades gracefully with no key (tested here too).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextBusinessDay, dispatchDay, buyerZone, guardrailScrub, buildContext, systemPrompt, draftMessage,
  friendlyFirstName, cardHook, shipByPhrase, shipTiming, fallbackDraft,
  followUpSystemPrompt, buildFollowUpContext, dispatchFacts, fallbackFollowUp,
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
  it('never returns today, whatever dispatchDay does', () => {
    assert.equal(at('2026-07-21T02:00:00Z').date, '2026-07-22');   // Tue 12:00 Sydney → Wed
  });
});

// Fixed instants used below. 2026-07-21 is a Tuesday.
//   TUE_01  Tue 01:00 Sydney = Mon 23:00 Perth   <- the owner's 1am case
//   TUE_10  Tue 10:00 Sydney = Tue 08:00 Perth   <- same calendar date everywhere in AU
//   TUE_15  Tue 15:00 Sydney                     <- past a noon cut-off
const TUE_01 = new Date('2026-07-20T15:00:00Z');
const TUE_10 = new Date('2026-07-21T00:00:00Z');
const TUE_15 = new Date('2026-07-21T05:00:00Z');
const SAT_10 = new Date('2026-07-25T00:00:00Z');

describe('dispatchDay', () => {
  const TZ = 'Australia/Sydney';
  const on = (now, extra) => dispatchDay(now, { tz: TZ, cutoff: '12:00', ...extra });

  it('before the cut-off on a working day → today', () => {
    assert.deepEqual(on(TUE_10), { date: '2026-07-21', weekday: 'Tuesday', sameDay: true });
  });
  it('after the cut-off → the next business day, exactly as nextBusinessDay would', () => {
    assert.deepEqual(on(TUE_15), { date: '2026-07-22', weekday: 'Wednesday', sameDay: false });
    const { sameDay, ...rest } = on(TUE_15);
    assert.deepEqual(rest, nextBusinessDay(TUE_15, { tz: TZ }));
  });
  // The cut-off is not what protects the Perth buyer — 1am is comfortably before any sane one, so
  // this order IS same-day eligible. shipTiming's timezone guard is what fixes the wording.
  it('1am counts as before the cut-off', () => {
    assert.equal(on(TUE_01).sameDay, true);
    assert.equal(on(TUE_01).date, '2026-07-21');
  });
  it('a weekend is never same-day', () => {
    assert.deepEqual(on(SAT_10), { date: '2026-07-27', weekday: 'Monday', sameDay: false });
  });
  it('a listed holiday is never same-day', () => {
    assert.deepEqual(on(TUE_10, { holidays: ['2026-07-21'] }), { date: '2026-07-22', weekday: 'Wednesday', sameDay: false });
  });
  it('rolls past a run of holidays without ever claiming today', () => {
    assert.deepEqual(on(TUE_10, { holidays: ['2026-07-21', '2026-07-22', '2026-07-23'] }),
      { date: '2026-07-24', weekday: 'Friday', sameDay: false });
  });
  // A typo in the settings box must not promise same-day dispatch at 11pm.
  it('an unparseable cut-off fails closed', () => {
    for (const cutoff of ['lunchtime', '', null, '25:00', '12.00']) {
      assert.equal(on(TUE_10, { cutoff }).sameDay, false, String(cutoff));
    }
  });
  it('reads the cut-off in the store timezone, not the server one', () => {
    // TUE_01 is Tue 01:00 Sydney but still Mon 15:00 in London — a Monday, and well past noon.
    assert.equal(dispatchDay(TUE_01, { tz: 'Europe/London', cutoff: '12:00' }).weekday, 'Tuesday');
    assert.equal(dispatchDay(TUE_01, { tz: 'Europe/London', cutoff: '12:00' }).sameDay, false);
  });
});

describe('buyerZone', () => {
  it('reads an AU state however eBay spells it', () => {
    for (const s of ['WA', 'wa', 'W.A.', ' Western Australia ', 'western australia']) {
      assert.equal(buyerZone({ ship_country: 'AU', ship_state: s }), 'Australia/Perth', s);
    }
    assert.equal(buyerZone({ ship_country: 'AU', ship_state: 'N.S.W.' }), 'Australia/Sydney');
    assert.equal(buyerZone({ ship_country: 'AU', ship_state: 'Qld.' }), 'Australia/Brisbane');
    assert.equal(buyerZone({ ship_country: 'AU', ship_state: 'Victoria' }), 'Australia/Melbourne');
  });
  it('accepts the country by name as well as by code', () => {
    assert.equal(buyerZone({ ship_country_name: 'Australia', ship_state: 'SA' }), 'Australia/Adelaide');
  });
  it('falls back to the postcode when the state string is junk', () => {
    assert.equal(buyerZone({ ship_country: 'AU', ship_state: '-', ship_postal: '6000' }), 'Australia/Perth');
    assert.equal(buyerZone({ ship_country: 'AU', ship_state: '', ship_postal: '0810' }), 'Australia/Darwin');
    assert.equal(buyerZone({ ship_country: 'AU', ship_state: null, ship_postal: '3000' }), 'Australia/Melbourne');
    assert.equal(buyerZone({ ship_country: 'AU', ship_state: 'xx', ship_postal: '2600' }), 'Australia/Sydney');
  });
  // "WA" is Western Australia AND Washington State. Without the country gate a Seattle buyer reads
  // as Perth, which is the exact wrong-timezone bug the whole guard exists to avoid.
  it('never reads a foreign state through the AU table', () => {
    assert.equal(buyerZone({ ship_country: 'US', ship_state: 'WA', ship_postal: '98101' }), null);
    assert.equal(buyerZone({ ship_country: 'GB', ship_state: 'Greater London' }), null);
    assert.equal(buyerZone({ ship_state: 'WA' }), null);      // no country at all → unknown
    assert.equal(buyerZone({}), null);
    assert.equal(buyerZone(), null);
  });
  it('gives up rather than guess on an AU address it cannot place', () => {
    assert.equal(buyerZone({ ship_country: 'AU', ship_state: 'somewhere', ship_postal: 'ABC' }), null);
  });
});

describe('shipTiming', () => {
  const CFG = { timezone: 'Australia/Sydney', ship_timing_text: 'packed and sent {{when}}', same_day_text: 'later today' };
  const AU = (st) => ({ ship_country: 'AU', ship_state: st });
  const TODAY_TUE = { date: '2026-07-21', weekday: 'Tuesday', sameDay: true };
  const WED = { date: '2026-07-22', weekday: 'Wednesday', sameDay: false };
  const MON = { date: '2026-07-27', weekday: 'Monday', sameDay: false };
  const t = (shipBy, order, now, cfg = CFG) => shipTiming({ shipBy, order, cfg, now });

  it('says "later today" to a buyer on our own calendar date', () => {
    const r = t(TODAY_TUE, AU('NSW'), TUE_10);
    assert.equal(r.phrase, 'later today');
    assert.equal(r.sentence, 'packed and sent later today');
    assert.equal(r.sameDay, true);
  });
  it('still says "tomorrow" and "on Monday" for a roll', () => {
    assert.equal(t(WED, AU('VIC'), TUE_10).phrase, 'tomorrow');
    assert.equal(t(MON, AU('QLD'), SAT_10).phrase, 'on Monday');
  });

  // The owner's case, in his words: someone in Perth buying at 1am Sydney is still on yesterday, so
  // "later today" names the wrong day for them.
  it('drops the relative word when the buyer is on a different calendar date', () => {
    const r = t(TODAY_TUE, AU('WA'), TUE_01);
    assert.equal(r.buyerTz, 'Australia/Perth');
    assert.equal(r.phrase, 'on Tuesday');
    assert.equal(r.sentence, 'packed and sent on Tuesday');
  });
  it('honours different_day_wording when the dates diverge', () => {
    const cfg = { ...CFG, different_day_wording: 'next business day' };
    assert.equal(t(TODAY_TUE, AU('WA'), TUE_01, cfg).phrase, 'the next business day');
    // …and leaves a same-calendar buyer alone: the setting is only for the ambiguous case.
    assert.equal(t(TODAY_TUE, AU('NSW'), TUE_01, cfg).phrase, 'later today');
  });
  it('the same 1am order from Sydney still gets "later today"', () => {
    assert.equal(t(TODAY_TUE, AU('NSW'), TUE_01).phrase, 'later today');
  });
  it('a daytime WA order is on our date, so it keeps the relative word', () => {
    assert.equal(t(TODAY_TUE, AU('WA'), TUE_10).phrase, 'later today');
  });
  it('an international buyer is never told a relative day', () => {
    const r = t(TODAY_TUE, { ship_country: 'US', ship_state: 'CA' }, TUE_10);
    assert.equal(r.buyerTz, null);
    assert.equal(r.phrase, 'on Tuesday');
  });
  it('an address we cannot place is treated as ambiguous, not as local', () => {
    assert.equal(t(TODAY_TUE, {}, TUE_10).phrase, 'on Tuesday');
  });

  it('uses a template with no {{when}} verbatim, so an un-migrated config still works', () => {
    const cfg = { ...CFG, ship_timing_text: 'packed and sent the next business day' };
    assert.equal(t(TODAY_TUE, AU('NSW'), TUE_10, cfg).sentence, 'packed and sent the next business day');
  });
  it('lets the owner reword the same-day phrase', () => {
    assert.equal(t(TODAY_TUE, AU('NSW'), TUE_10, { ...CFG, same_day_text: 'this arvo' }).phrase, 'this arvo');
    // A field cleared to blank in the settings form falls back rather than emptying the sentence.
    assert.equal(t(TODAY_TUE, AU('NSW'), TUE_10, { ...CFG, same_day_text: '  ' }).phrase, 'later today');
  });
  it('returns null when there is no ship day to talk about', () => {
    assert.equal(shipTiming({ shipBy: null, order: AU('NSW'), cfg: CFG }), null);
  });
  it('every phrase it can produce passes the eBay contact guardrail', () => {
    for (const st of ['NSW', 'WA', 'QLD', null]) {
      for (const sb of [TODAY_TUE, WED, MON]) {
        for (const now of [TUE_01, TUE_10, TUE_15]) {
          const r = t(sb, AU(st), now);
          assert.ok(guardrailScrub('We will get this ' + r.sentence + '. Cheers, BK').clean, r.sentence);
        }
      }
    }
  });
});

// The reason shipTiming exists at all. The prompt lane and the template lane used to phrase the
// dispatch promise independently, so the same buyer could be told two different things depending on
// which lane happened to win. One object now feeds both, and this is what holds that.
describe('the AI lane and the template lane cannot disagree about the parcel', () => {
  const CFG = {
    timezone: 'Australia/Sydney', ship_timing_text: 'packed and sent {{when}}',
    same_day_text: 'later today', signature: '-BK',
  };
  const cases = [
    ['a local buyer before the cut-off', { ship_country: 'AU', ship_state: 'NSW' }, TUE_10, { date: '2026-07-21', weekday: 'Tuesday', sameDay: true }, 'later today'],
    ['a Perth buyer at 1am our time', { ship_country: 'AU', ship_state: 'WA' }, TUE_01, { date: '2026-07-21', weekday: 'Tuesday', sameDay: true }, 'on Tuesday'],
    ['a next-day roll', { ship_country: 'AU', ship_state: 'VIC' }, TUE_15, { date: '2026-07-22', weekday: 'Wednesday', sameDay: false }, 'tomorrow'],
  ];
  for (const [label, order, now, shipBy, expected] of cases) {
    it(label + ' → both lanes say "' + expected + '"', () => {
      const timing = shipTiming({ shipBy, order, cfg: CFG, now });
      assert.equal(timing.phrase, expected);
      assert.ok(systemPrompt(CFG, timing).includes('packed and sent ' + expected));
      assert.ok(buildContext({ order, items: [], timing }).includes('exact words to use: ' + expected));
      assert.ok(fallbackDraft({ order, items: [], cfg: CFG, shipBy, timing, now }).body.includes('posted ' + expected));
    });
  }
  it('the prompt tells the model not to reword it', () => {
    const timing = shipTiming({ shipBy: { date: '2026-07-21', weekday: 'Tuesday', sameDay: true }, order: { ship_country: 'AU', ship_state: 'NSW' }, cfg: CFG, now: TUE_10 });
    const s = systemPrompt(CFG, timing);
    assert.match(s, /in exactly those words/);
    assert.doesNotMatch(s, /you may mention it naturally/);
  });
  // Found in end-to-end verification: once ship_timing_text carries {{when}}, any lane that skips
  // shipTiming feeds the model the raw placeholder. draftAndRoute therefore always computes timing,
  // same-day on or off, and this is what holds that contract at the boundary.
  it('never leaks a raw {{when}} placeholder into the prompt', () => {
    for (const shipBy of [{ date: '2026-07-21', weekday: 'Tuesday', sameDay: true }, { date: '2026-07-22', weekday: 'Wednesday' }]) {
      for (const order of [{ ship_country: 'AU', ship_state: 'NSW' }, { ship_country: 'AU', ship_state: 'WA' }, {}]) {
        for (const now of [TUE_01, TUE_10, TUE_15]) {
          const timing = shipTiming({ shipBy, order, cfg: CFG, now });
          assert.doesNotMatch(systemPrompt(CFG, timing), /\{\{/);
          assert.doesNotMatch(fallbackDraft({ order, items: [], cfg: CFG, shipBy, timing, now }).body, /\{\{/);
        }
      }
    }
  });
  // scanBusiness gives up after 21 days, so a Christmas shutdown listed day-by-day in `holidays`
  // really does return null and leave every lane with no ship day at all. That path must still not
  // mail the buyer a literal "packed and sent {{when}}".
  it('survives a shutdown long enough that there is no ship day at all', () => {
    const holidays = Array.from({ length: 25 }, (_, i) => {
      const d = new Date('2026-07-21T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const shipBy = dispatchDay(TUE_10, { tz: 'Australia/Sydney', cutoff: '12:00', holidays });
    assert.equal(shipBy, null, 'no working day within range');
    assert.equal(shipTiming({ shipBy, order: { ship_country: 'AU', ship_state: 'NSW' }, cfg: CFG, now: TUE_10 }), null);
    assert.doesNotMatch(systemPrompt(CFG, null), /\{\{/);
    assert.match(systemPrompt(CFG, null), /packed and sent the next business day/);
    assert.doesNotMatch(fallbackDraft({ order: {}, items: [], cfg: CFG, shipBy, timing: null, now: TUE_10 }).body, /\{\{/);
  });
  it('with no timing at all, both lanes fall back to exactly the old behaviour', () => {
    const cfg = { ...CFG, ship_timing_text: 'packed and sent the next business day' };
    const shipBy = { date: '2026-07-22', weekday: 'Wednesday' };
    assert.match(systemPrompt(cfg), /packed and sent the next business day/);
    assert.match(systemPrompt(cfg), /you may mention it naturally/);
    assert.match(buildContext({ order: {}, items: [], shipBy }), /Next business day for posting: Wednesday/);
    assert.match(fallbackDraft({ order: {}, items: [], cfg, shipBy, now: TUE_10 }).body, /posted tomorrow/);
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

/* ---------- dispatch + delivered follow-ups ---------- */

describe('guardrailScrub — the allow list', () => {
  const TRK = '36LB1234567890';

  it('rejects a tracking number by default, because it looks exactly like a phone number', () => {
    // This is not a hypothetical: every Australia Post article ID is a long digit run, so without an
    // allow list a correct dispatch message would be rejected 100% of the time.
    assert.ok(guardrailScrub('Tracking: ' + TRK).violations.includes('phone number'));
  });

  it('accepts it when the caller says it put that number there deliberately', () => {
    assert.deepEqual(guardrailScrub('Tracking: ' + TRK, { allow: [TRK] }), { clean: true, violations: [] });
  });

  it('still rejects a real phone number sitting next to an allowed tracking number', () => {
    const r = guardrailScrub(`Tracking: ${TRK}\nCall 0400 123 456`, { allow: [TRK] });
    assert.ok(r.violations.includes('phone number'));
  });

  it('a url is only allowed when it is the exact one we stamped', () => {
    const url = 'https://auspost.com.au/mypost/track/details/' + TRK;
    assert.ok(guardrailScrub(url).violations.includes('web address / link'));
    assert.equal(guardrailScrub(url, { allow: [url] }).clean, true);
    assert.ok(guardrailScrub('also see mystore.com', { allow: [url] }).violations.includes('web address / link'));
  });

  it('measures length on the real body, not the masked copy', () => {
    const long = 'x'.repeat(1995) + TRK;
    assert.ok(guardrailScrub(long, { allow: [TRK] }).violations.includes('too long (> 2000 chars)'));
  });

  it('masking can never fuse two digit runs into a false positive', () => {
    assert.equal(guardrailScrub(`1234${TRK}5678`, { allow: [TRK] }).clean, true);
  });
});

describe('dispatchFacts', () => {
  const P = { tracking: '36LB1234567890', carrier: 'Australia Post', tracking_url: 'https://auspost.com.au/t/36LB1234567890' };

  it('stamps the number and carrier, and allows them past the guardrail', () => {
    const f = dispatchFacts(P, {});
    assert.match(f.text, /^Tracking: 36LB1234567890 \(Australia Post\)$/);
    assert.deepEqual(f.allow, ['36LB1234567890']);
    assert.equal(guardrailScrub('Hi there.\n\n' + f.text, { allow: f.allow }).clean, true);
  });

  it('leaves the link out by default — eBay bans web addresses in member messages', () => {
    assert.doesNotMatch(dispatchFacts(P, {}).text, /auspost/);
  });

  it('includes the link only when the owner switches it on', () => {
    const f = dispatchFacts(P, { dispatch_message: { include_link: true } });
    assert.match(f.text, /auspost\.com\.au/);
    assert.equal(guardrailScrub(f.text, { allow: f.allow }).clean, true);
  });

  it('an untracked letter gets no facts block at all', () => {
    assert.deepEqual(dispatchFacts({}, {}), { text: '', allow: [] });
  });
});

describe('followUpSystemPrompt', () => {
  it('carries the same hard voice rules as the thank-you', () => {
    for (const kind of ['dispatch', 'delivered']) {
      const s = followUpSystemPrompt({ signature: '-BK' }, kind);
      assert.match(s, /No em dashes/, kind);
      assert.match(s, /not X, but Y/, kind);
      assert.match(s, /No links/, kind);
      assert.match(s, /-BK/, kind);
      assert.match(s, /JSON object/, kind);
    }
  });
  it('forbids the model writing the tracking number itself', () => {
    assert.match(followUpSystemPrompt({}, 'dispatch'), /Do NOT write the number out yourself/);
  });
  it('does not promise a delivery date on our behalf', () => {
    assert.match(followUpSystemPrompt({}, 'dispatch'), /Do not promise a delivery date/);
  });
  it('the delivered note asks for a rating without begging or bribing', () => {
    const s = followUpSystemPrompt({}, 'delivered');
    assert.match(s, /rating on eBay helps a small store/);
    assert.match(s, /Do not beg, do not offer/);
  });

  it('the delivered note is told to stay positive and not go fishing for faults', () => {
    const s = followUpSystemPrompt({}, 'delivered');
    assert.match(s, /Do NOT invite them to check the cards over/);
    assert.match(s, /Never mention\s+damage, faults, mistakes, problems, issues, refunds, returns/);
    assert.match(s, /Assume it arrived well/);
    assert.doesNotMatch(s, /if anything is not right/i);
  });

  // The parcel is sealed. Anything about bundles or combining items is an offer we cannot honour, and
  // it reads as careless to someone who has already paid.
  it('forbids bundles and adding to the order, on both follow-ups', () => {
    for (const kind of ['dispatch', 'delivered']) {
      const s = followUpSystemPrompt({}, kind);
      assert.match(s, /NOTHING can be added to it now/, kind);
      assert.match(s, /never\s+mention bundles, combining items, adding to the order/, kind);
    }
  });

  it('invites a FUTURE offer on both follow-ups, because repeat business is the point', () => {
    for (const kind of ['dispatch', 'delivered']) {
      const s = followUpSystemPrompt({}, kind);
      assert.match(s, /inviting them to ask for a total NEXT time/, kind);
      assert.match(s, /clearly about a future order, never about this one/, kind);
      assert.doesNotMatch(followUpSystemPrompt({ invite_offers: false }, kind), /ask for a total NEXT time/, kind);
    }
  });

  it('does not leak style_notes into a follow-up, but does carry brand_voice', () => {
    // style_notes is content guidance for the THANK-YOU ("give the ship timing, invite bundle deals").
    // Both are wrong once the parcel has gone; the shipped config really does say exactly that.
    const cfg = { brand_voice: 'warm aussie store owner', style_notes: 'invite bundle deals or offers, give the ship timing' };
    for (const kind of ['dispatch', 'delivered']) {
      const s = followUpSystemPrompt(cfg, kind);
      assert.doesNotMatch(s, /invite bundle deals/, kind);
      assert.doesNotMatch(s, /give the ship timing/, kind);
      assert.match(s, /warm aussie store owner/, kind);
    }
    // …and the thank-you, where it belongs, still gets it.
    assert.match(systemPrompt(cfg), /invite bundle deals/);
  });
});

describe('buildFollowUpContext', () => {
  const order = { buyer_username: 'archaon', ship_name: 'Sam Lee' };
  const items = [{ title: 'Flygon ex 222/191', quantity: 1 }];
  it('tells the model the number is appended rather than handing it over', () => {
    const c = buildFollowUpContext({ order, items, postage: { label: 'Express Post', tracking: '36LB1' }, kind: 'dispatch' });
    assert.match(c, /Postage service: Express Post\./);
    assert.match(c, /appended after your message/);
    assert.doesNotMatch(c, /36LB1/);
  });
  it('says plainly when there is no tracking, so nothing is invented', () => {
    assert.match(buildFollowUpContext({ order, items, postage: {}, kind: 'dispatch' }), /no tracking number/);
  });
  it('the delivered context states the parcel arrived', () => {
    assert.match(buildFollowUpContext({ order, items, kind: 'delivered' }), /has been delivered/);
  });
});

describe('fallbackFollowUp', () => {
  const order = { ship_name: 'Sam Lee', buyer_username: 'archaon' };
  const items = [{ title: 'Pokemon Flygon ex 222/191 SV', quantity: 1 }];

  it('dispatch: names them, names the card, names the service, and points at the number', () => {
    const d = fallbackFollowUp({ order, items, postage: { label: 'Express Post', tracking: '36LB1' }, cfg: { signature: '-BK' } });
    assert.equal(d.ok, true);
    assert.match(d.body, /Hey Sam,/);
    assert.match(d.body, /Flygon/);
    assert.match(d.body, /It's going Express Post\./);
    assert.match(d.body, /tracking number is at the bottom/);
    assert.match(d.body, /-BK$/);
  });

  it('dispatch: says nothing about tracking when there is none', () => {
    const d = fallbackFollowUp({ order, items, postage: {}, cfg: {} });
    assert.doesNotMatch(d.body, /tracking/i);
  });

  it('both follow-ups invite a future offer, and never a bundle on a parcel already sealed', () => {
    for (const [kind, postage] of [['dispatch', { label: 'Express Post', tracking: '36LB1' }], ['delivered', {}]]) {
      const d = fallbackFollowUp({ order, items, postage, kind, cfg: {} });
      assert.match(d.body, /Next time there's something you're after, pop it in your cart and ask us for a total/, kind);
      assert.doesNotMatch(d.body, /bundle|combin|add(ing)? to (your|this) order|anything else you'?re after/i, kind);
      // …and it reads as its own thought, not tacked onto the line above it.
      assert.match(d.body, /\n\nNext time there's/, kind);
    }
  });

  it('the two follow-ups word the nudge identically, so the store sounds like one store', () => {
    const line = (kind) => fallbackFollowUp({ order, items, kind, cfg: {} }).body.split('\n').find((l) => l.startsWith('Next time'));
    assert.equal(line('dispatch'), line('delivered'));
  });

  it('the offer line follows invite_offers on both', () => {
    for (const kind of ['dispatch', 'delivered']) {
      assert.doesNotMatch(fallbackFollowUp({ order, items, postage: {}, kind, cfg: { invite_offers: false } }).body, /send an offer/, kind);
    }
  });

  it('delivered: the rating nudge comes before the offer, and stays a separate thought', () => {
    const d = fallbackFollowUp({ order, items, kind: 'delivered', cfg: {} });
    assert.ok(d.body.indexOf('rating on eBay') < d.body.indexOf('Next time'), 'this order first, next order after');
    assert.match(d.body, /helps a small store like ours\.\n\nNext time/);
  });

  it('delivered: lands warm and nudges once, gently', () => {
    const d = fallbackFollowUp({ order, items, kind: 'delivered', cfg: {} });
    assert.match(d.body, /should have landed/);
    assert.match(d.body, /Hope you love it/);
    assert.match(d.body, /rating on eBay/);
  });

  // Asking "is anything wrong?" immediately before asking for a rating hands someone a reason to go
  // looking for a fault they were not thinking about. A buyer with a real problem already knows how
  // to reach us, so the message stays positive and assumes it arrived well.
  it('delivered: never puts the idea of a problem in the buyer\'s head', () => {
    const d = fallbackFollowUp({ order, items, kind: 'delivered', cfg: {} }).body;
    for (const re of [/not right/i, /anything wrong/i, /damage/i, /fault/i, /issue/i, /problem/i,
      /refund/i, /return/i, /sort it out/i, /if you'?re happy/i, /good shape/i]) {
      assert.doesNotMatch(d, re, `delivered copy must not say ${re}`);
    }
  });

  it('every fallback obeys the store voice: no em dashes, no antithesis, no filler', () => {
    for (const kind of ['dispatch', 'delivered']) {
      for (const postage of [{}, { label: 'Express Post', tracking: '36LB1234567890' }]) {
        const d = fallbackFollowUp({ order, items, postage, kind, cfg: {} });
        assert.doesNotMatch(d.body, /—/, kind);
        assert.doesNotMatch(d.body, /\bnot .*, but\b/i, kind);
        assert.doesNotMatch(d.body, /thrilled|rest assured|we pride ourselves|valued customer|seamless|curated/i, kind);
        assert.ok((d.body.match(/!/g) || []).length <= 1, kind);
        assert.equal(guardrailScrub(d.body).clean, true, kind + ' body must pass the guardrail on its own');
      }
    }
  });

  it('degrades to no name and no card when it cannot be sure of either', () => {
    const d = fallbackFollowUp({ order: { ship_name: 'Cardz Pty Ltd' }, items: [{ title: 'a', quantity: 2 }, { title: 'b' }], postage: {}, cfg: {} });
    assert.match(d.body, /^Hey,/);
    assert.match(d.body, /your order went in the post/);
  });
});
