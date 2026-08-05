// test/unit/postsale-sync.test.mjs — the order poll is now reachable on demand (the ↻ on
// orders.html POSTs /api/postsale/sync), so a manual run and the scheduled tick can genuinely
// overlap for the first time. Both finish by writing orders_cursor, so two concurrent polls would
// let the slower one push the cursor past a window the faster one never read — those orders then
// fall outside every future window and are lost, not merely late. runOrderPoll is the guard: one
// poll in flight, and a caller arriving mid-run joins it rather than starting a second.
//
// TCG_CONFIG_DIR / TCG_POSTSALE_DB must be set BEFORE lib/postsale.mjs loads (both resolve at
// module scope), hence the dynamic import — same pattern as test/unit/repricer-config.test.mjs.
// The config is written with enabled:false on purpose: pollOrders then short-circuits at its first
// check, so this suite asserts the concurrency contract without ever reaching the network, whatever
// the developer's real postsale.config.json happens to say.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.tmpdir(), 'tcg-postsale-sync-' + process.pid);
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'postsale.config.json'), JSON.stringify({ enabled: false }, null, 2));
process.env.TCG_CONFIG_DIR = DIR;
process.env.TCG_POSTSALE_DB = path.join(DIR, 'postsale.db');
const { runOrderPoll, pollOrders } = await import('../../lib/postsale.mjs');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe('runOrderPoll — one order poll in flight', () => {
  it('hands a second caller the run already going instead of starting another', async () => {
    const a = runOrderPoll({}, null, { trigger: 'manual' });
    const b = runOrderPoll({}, null, { trigger: 'schedule' });
    assert.equal(a, b, 'the scheduled tick should have joined the manual run, not raced it');
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(ra, rb, 'both callers see the same result');
  });

  it('releases the slot once the run settles, so the next click really polls again', async () => {
    const first = runOrderPoll({}, null, { trigger: 'manual' });
    await first;
    const second = runOrderPoll({}, null, { trigger: 'manual' });
    assert.notEqual(second, first, 'a later call must start a fresh run, not replay the finished one');
    await second;
  });

  it('is disabled-safe: a poll with sync switched off never reaches eBay', async () => {
    const r = await pollOrders({}, null, { trigger: 'manual' });
    assert.equal(r.skipped, 'disabled');
  });
});
