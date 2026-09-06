// test/unit/keepers-checkin.test.mjs — the QR check-in.
//
// The interesting decisions here are all about REFUSING, and about what a refusal says. This is the
// one surface a customer touches directly, standing at a table, on a phone, having just scanned a
// code — so a wrong answer is not a log line, it is a conversation.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { activeShow, nextShow, checkIn, makeCheckinHandler } from '../../lib/keepers-checkin.mjs';
import { openKeepersDbAt, upsertCustomer, ledgerTotals, getCustomer } from '../../lib/keepers-db.mjs';

const GID = 'gid://shopify/Customer/8675309';
const RULES = { checkin_xp: 50 };

const SHOWS = [
  { slug: 'newcastle-2026-11', name: 'Newcastle Card Show', starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-15T07:00:00Z' },
  { slug: 'sydney-2026-12', name: 'Sydney Expo', starts_at: '2026-12-05T22:00:00Z', ends_at: '2026-12-06T07:00:00Z' },
];
const DURING = Date.parse('2026-11-15T02:00:00Z');   // mid-show
const BEFORE = Date.parse('2026-11-01T00:00:00Z');
const AFTER = Date.parse('2026-12-20T00:00:00Z');

let db;
beforeEach(() => { db = openKeepersDbAt(':memory:'); });

describe('activeShow — the clock is what identifies the show', () => {
  it('finds the show that is on right now', () => {
    assert.equal(activeShow(SHOWS, DURING).slug, 'newcastle-2026-11');
  });

  it('returns NULL outside every window — never the most recent show', () => {
    // Falling back to "the last show" would turn one printed QR into a permanent 50 XP button, and a
    // code photographed at a show would work from the couch the following week.
    assert.equal(activeShow(SHOWS, BEFORE), null);
    assert.equal(activeShow(SHOWS, AFTER), null);
    assert.equal(activeShow(SHOWS, Date.parse('2026-11-20T00:00:00Z')), null, 'between shows');
  });

  it('includes both ends of the window', () => {
    assert.ok(activeShow(SHOWS, Date.parse('2026-11-14T22:00:00Z')));
    assert.ok(activeShow(SHOWS, Date.parse('2026-11-15T07:00:00Z')));
    assert.equal(activeShow(SHOWS, Date.parse('2026-11-15T07:00:01Z')), null);
  });

  it('tolerates an offset instead of Z, which someone writing Sydney times will use', () => {
    // 2026-11-15T09:00+11:00 is 2026-11-14T22:00Z — the same instant, written the way a human would.
    const offset = [{ slug: 's', name: 'S', starts_at: '2026-11-15T09:00:00+11:00', ends_at: '2026-11-15T18:00:00+11:00' }];
    assert.equal(activeShow(offset, DURING).slug, 's');
  });

  it('treats an unparseable date as unusable, never as always-on', () => {
    // A typo must not open a permanent 50 XP button.
    const bad = [{ slug: 'oops', name: 'Oops', starts_at: 'next friday', ends_at: 'whenever' }];
    assert.equal(activeShow(bad, DURING), null);
  });

  it('survives a malformed or empty show list', () => {
    assert.equal(activeShow([], DURING), null);
    assert.equal(activeShow(undefined, DURING), null);
    assert.equal(activeShow([{ name: 'no slug' }, null, {}], DURING), null);
  });

  it('is deterministic when two windows overlap — a config mistake, not a scenario', () => {
    const overlap = [...SHOWS, { slug: 'other', name: 'Other', starts_at: '2026-11-15T00:00:00Z', ends_at: '2026-11-15T06:00:00Z' }];
    assert.equal(activeShow(overlap, DURING).slug, 'other', 'the most recently started wins');
  });
});

describe('nextShow — so a refusal can say when to come back', () => {
  it('names the next one', () => {
    assert.equal(nextShow(SHOWS, BEFORE).slug, 'newcastle-2026-11');
    assert.equal(nextShow(SHOWS, DURING).slug, 'sydney-2026-12');
  });

  it('is null once they are all past', () => {
    assert.equal(nextShow(SHOWS, AFTER), null);
  });
});

describe('checkIn', () => {
  const show = SHOWS[0];

  it('awards the XP and creates the customer', () => {
    const r = checkIn(db, { customerGid: GID, show, rules: RULES, nowMs: DURING });
    assert.equal(r.ok, true);
    assert.equal(r.already, false);
    assert.equal(r.xp, 50);
    assert.deepEqual(ledgerTotals(db, GID), { xp: 50, points: 0, events: 1 });
    assert.ok(getCustomer(db, GID));
  });

  it('is idempotent per customer per show — a second tap is not an error', () => {
    checkIn(db, { customerGid: GID, show, rules: RULES, nowMs: DURING });
    const again = checkIn(db, { customerGid: GID, show, rules: RULES, nowMs: DURING + 5000 });
    assert.equal(again.ok, true, 'still a success — they did nothing wrong');
    assert.equal(again.already, true);
    assert.deepEqual(ledgerTotals(db, GID), { xp: 50, points: 0, events: 1 }, 'awarded once');
  });

  it('lets the same customer check in at a DIFFERENT show', () => {
    checkIn(db, { customerGid: GID, show, rules: RULES, nowMs: DURING });
    checkIn(db, { customerGid: GID, show: SHOWS[1], rules: RULES, nowMs: Date.parse('2026-12-06T00:00:00Z') });
    assert.equal(ledgerTotals(db, GID).xp, 100);
  });

  it('refuses with no customer, no show, or a zero award', () => {
    assert.equal(checkIn(db, { customerGid: null, show, rules: RULES }).reason, 'not_signed_in');
    assert.equal(checkIn(db, { customerGid: GID, show: null, rules: RULES }).reason, 'no_active_show');
    // A misconfigured award must not produce a cheerful "you earned 0 XP".
    assert.equal(checkIn(db, { customerGid: GID, show, rules: { checkin_xp: 0 } }).reason, 'checkin_disabled');
    assert.equal(checkIn(db, { customerGid: GID, show, rules: {} }).reason, 'checkin_disabled');
    assert.equal(ledgerTotals(db, GID).events, 0, 'no refusal writes anything');
  });
});

describe('the handler', () => {
  const handler = (over = {}) => makeCheckinHandler(async () => ({ rules: RULES, shows: SHOWS, ...over }));
  const url = (p) => new URL(`http://x${p}`);

  it('awards on a POST to /checkin during a show', async () => {
    // Freeze the clock by pointing the show window at now, rather than mocking Date.
    const now = Date.now();
    const live = [{ slug: 'now-show', name: 'Right Now', starts_at: new Date(now - 3600000).toISOString(), ends_at: new Date(now + 3600000).toISOString() }];
    const h = makeCheckinHandler(async () => ({ rules: RULES, shows: live }));
    const res = await h({}, { customerGid: GID, url: url('/apps/keepers/checkin'), method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.xp, 50);
    assert.match(res.body.message, /G'day/);
  });

  it('says the SAME thing on a second tap', async () => {
    const now = Date.now();
    const live = [{ slug: 'now-show', name: 'Right Now', starts_at: new Date(now - 3600000).toISOString(), ends_at: new Date(now + 3600000).toISOString() }];
    const h = makeCheckinHandler(async () => ({ rules: RULES, shows: live }));
    const a = await h({}, { customerGid: GID, url: url('/apps/keepers/checkin'), method: 'POST' });
    const b = await h({}, { customerGid: GID, url: url('/apps/keepers/checkin'), method: 'POST' });
    // "You already checked in" reads as a telling-off for something that is not their fault.
    assert.equal(b.body.message, a.body.message);
    assert.equal(b.body.already, true);
  });

  it('refuses outside a show, and names the next one', async () => {
    const h = handler();
    const res = await h({}, { customerGid: GID, url: url('/apps/keepers/checkin'), method: 'POST' });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, 'no_active_show');
    // The message has to be useful standing at a table, not just correct.
    assert.match(res.body.message, /catch us at/i);
    assert.ok(res.body.next, 'a refusal should say when to come back');
  });

  it('a GET never awards anything', async () => {
    const now = Date.now();
    const live = [{ slug: 'now-show', name: 'Right Now', starts_at: new Date(now - 3600000).toISOString(), ends_at: new Date(now + 3600000).toISOString() }];
    const h = makeCheckinHandler(async () => ({ rules: RULES, shows: live }));
    const res = await h({}, { customerGid: GID, url: url('/apps/keepers'), method: 'GET' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.ready, true);
    assert.equal(res.body.xp, 50, 'it says what is on offer');
    assert.equal(res.body.already, undefined, 'but awards nothing');
  });

  it('degrades politely when the config cannot be read', async () => {
    const h = makeCheckinHandler(async () => { throw new Error('shopify down'); });
    const res = await h({}, { customerGid: GID, url: url('/apps/keepers/checkin'), method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal(res.body.reason, 'config_unavailable');
    assert.doesNotMatch(JSON.stringify(res.body), /shopify down/, 'internal detail must not reach the customer');
  });
});
