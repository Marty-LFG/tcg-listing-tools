// test/unit/postsale-message-dedupe.test.mjs — the reply poll must survive being re-run.
//
// Two defects made that untrue, and both only bite once something other than the 15-minute timer can
// start a run (the DIAG route already can; a push notification would make it routine):
//
//  1. pollMemberMessages ends by stamping messages_cursor and had NO in-flight guard, so two
//     overlapping runs let the slower one push the cursor past a window the faster one never read.
//     runOrderPoll exists to stop exactly this for orders_cursor; runMemberMessagePoll is its twin.
//
//  2. When eBay omits MessageID, the row was keyed 'mm-<cursorISO>-<n>' — derived from the RUN, not
//     the MESSAGE. The same message read from two different cursors produced two different keys and
//     walked straight past ON CONFLICT(message_id) as a duplicate row. Re-reads of one window are
//     normal (the cursor overlaps by design), so the key has to be a function of the message alone.
//
// TCG_CONFIG_DIR / TCG_POSTSALE_DB must be set BEFORE lib/postsale.mjs loads (both resolve at module
// scope), hence the dynamic import — same pattern as test/unit/postsale-sync.test.mjs. enabled:false
// means pollMemberMessages short-circuits at its first check, so the concurrency contract is asserted
// without ever reaching the network.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.tmpdir(), 'tcg-postsale-msgdedupe-' + process.pid);
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'postsale.config.json'), JSON.stringify({ enabled: false }, null, 2));
process.env.TCG_CONFIG_DIR = DIR;
process.env.TCG_POSTSALE_DB = path.join(DIR, 'postsale.db');
const { runMemberMessagePoll, pollMemberMessages, synthMessageId } = await import('../../lib/postsale.mjs');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const MSG = {
  senderId: 'buyer_bob',
  creationTime: '2026-08-05T04:30:00.000Z',
  itemId: '123456789012',
  body: 'Hi, is this the holo version?',
};

describe('synthMessageId — a message keys on itself, never on the run that read it', () => {
  it('gives the same id no matter when or how often it is read', () => {
    assert.equal(synthMessageId(MSG), synthMessageId({ ...MSG }),
      'the same message must produce the same key — this is what makes ON CONFLICT dedupe work');
  });

  it('does not depend on the cursor the run started from', () => {
    // The regression: the old key spliced the cursor in, so a re-poll from an earlier cursor
    // re-inserted the identical message under a brand new id.
    const a = synthMessageId(MSG);
    const b = synthMessageId(MSG);
    assert.equal(a, b);
    assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T/, 'a timestamp in the key means it varies per run');
  });

  it('separates genuinely different messages', () => {
    const id = synthMessageId(MSG);
    assert.notEqual(id, synthMessageId({ ...MSG, senderId: 'buyer_jane' }), 'different sender');
    assert.notEqual(id, synthMessageId({ ...MSG, creationTime: '2026-08-05T04:31:00.000Z' }), 'different time');
    assert.notEqual(id, synthMessageId({ ...MSG, itemId: '999999999999' }), 'different item');
    assert.notEqual(id, synthMessageId({ ...MSG, body: 'Do you ship to WA?' }), 'different body');
  });

  it('survives a message with nothing in it rather than throwing', () => {
    assert.match(synthMessageId({}), /^mm-[0-9a-f]+$/, 'a blank message still needs a usable key');
  });
});

describe('runMemberMessagePoll — one reply poll in flight', () => {
  it('hands a second caller the run already going instead of starting another', async () => {
    const a = runMemberMessagePoll({}, null, { trigger: 'manual' });
    const b = runMemberMessagePoll({}, null, { trigger: 'schedule' });
    assert.equal(a, b, 'the scheduled tick should have joined the manual run, not raced it');
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(ra, rb, 'both callers see the same result');
  });

  it('releases the slot once the run settles, so the next trigger really polls again', async () => {
    const first = runMemberMessagePoll({}, null, { trigger: 'manual' });
    await first;
    const second = runMemberMessagePoll({}, null, { trigger: 'manual' });
    assert.notEqual(second, first, 'a later call must start a fresh run, not replay the finished one');
    await second;
  });

  it('is disabled-safe: a poll with sync switched off never reaches eBay', async () => {
    const r = await pollMemberMessages({}, null, { trigger: 'manual' });
    assert.equal(r.skipped, 'disabled');
  });
});
