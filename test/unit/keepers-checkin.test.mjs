// test/unit/keepers-checkin.test.mjs — the QR check-in.
//
// The interesting decisions here are all about REFUSING, and about what a refusal says. This is the
// one surface a customer touches directly, standing at a table, on a phone, having just scanned a
// code — so a wrong answer is not a log line, it is a conversation.
import { describe, it, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';

// TCG_KEEPERS_DB MUST be set before lib/keepers-db.mjs is evaluated — KEEPERS_DB_PATH is a
// module-scope const that captures it once — hence the dynamic imports below rather than static ones.
// Static imports are hoisted and would run before this line.
//
// This file's own handle is `:memory:`, which reads as sufficient and is not. makeCheckinHandler's
// claiming path does its own `openKeepersDb()` on the SINGLETON, so every POST test here has been
// writing check-in events into the real data/keepers.db. That is not hypothetical: the live file held
// exactly one event — a 50 XP check-in from customer 8675309 at show `now-show`, which is this file's
// fixture slug and appears nowhere else in the repo.
// tmpDir, not a bare mkdtempSync: unique either way, but the helper also registers a process-exit
// cleanup. Written without it earlier today and it had already left 29 directories behind.
const DIR = tmpDir('tcg-keepers-checkin-');
process.env.TCG_KEEPERS_DB = path.join(DIR, 'keepers.db');

const { activeShow, nextShow, checkIn, makeCheckinHandler } = await import('../../lib/keepers-checkin.mjs');
const { openKeepersDbAt, closeKeepersDb, upsertCustomer, ledgerTotals, getCustomer } = await import('../../lib/keepers-db.mjs');

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
// openKeepersDbAt hands back a fresh handle the test is the only owner of — a new one per case, so
// each is closed where it was opened rather than tracked to the end.
afterEach(() => { try { db?.close(); } catch { /* a teardown must not throw */ } db = null; });

// The `:memory:` handle above is NOT the one that leaks. Every POST test goes through
// makeCheckinHandler's claiming path, which does its own openKeepersDb() on the SINGLETON — a real
// file at TCG_KEEPERS_DB, inside DIR. Left open, that handle is what makes tmpDir's exit cleanup
// fail EPERM on Windows and strand the directory (with its WAL sidecars) forever.
after(() => { try { closeKeepersDb(); } catch { /* a teardown must not throw */ } });

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
  // RELATIVE shows, not the fixed SHOWS above. makeCheckinHandler is the one entry point in this
  // module with no injectable clock — it reads Date.now() itself — and the fixed fixture put two
  // deadlines on this block: on 2026-11-14 newcastle-2026-11 becomes ACTIVE, so the refusal test
  // stops refusing and its POST takes the claiming path instead; after 2026-12-06 nextShow returns
  // null and the "names the next one" assertion fails forever. The first of those is the dangerous
  // one, because the claiming path writes to the ledger.
  //
  // SHOWS itself stays fixed on purpose: every test using it passes nowMs explicitly, so those are
  // correct whatever the date, and fixed dates read better in an assertion about a specific window.
  const DAY = 86_400_000;
  const HOURS9 = 9 * 3_600_000;
  const relShows = () => {
    const now = Date.now();
    return [
      { slug: 'last-one', name: 'Last Month', starts_at: new Date(now - 30 * DAY).toISOString(), ends_at: new Date(now - 30 * DAY + HOURS9).toISOString() },
      { slug: 'next-one', name: 'Next Month', starts_at: new Date(now + 30 * DAY).toISOString(), ends_at: new Date(now + 30 * DAY + HOURS9).toISOString() },
    ];
  };
  const handler = (over = {}) => makeCheckinHandler(async () => ({ rules: RULES, shows: relShows(), ...over }));
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
