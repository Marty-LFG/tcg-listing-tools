// test/invariants/postsale-cursor-guard.test.mjs — orders_cursor must never advance past a window
// the poll did not finish reading.
//
// The bug this guards, which was live on a real store: pollOrders breaks out of its page loop on
// `max_per_run` (default 10) and then fell straight through to an UNCONDITIONAL
//     setMeta(db, 'orders_cursor', modTimeTo)
// so an 11th paid order inside one 10-minute window was never ingested AND the cursor moved past its
// ModTime. Nothing recovers it: the by-id sweep is refresh-only (sweepOpenOrders never calls
// ingestOrder), so an order that was never adopted is invisible to it. No sale alert, no thank-you,
// no stock decrement — silently lost, not late. The same applies to running out of MAX_PAGES with
// eBay still reporting hasMore.
//
// A behavioural test would have to drive pollOrders, which calls refreshServiceCatalog and
// GeteBayOfficialTime and would reach the network. The real regression risk here is a refactor
// restoring the unconditional write, and a source-shape assertion catches that for free — the same
// reasoning as test/invariants/postsale-send-persists-edit.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';

const src = read('lib/postsale.mjs');

// The body of pollOrders, from its signature to the start of the next top-level declaration.
function pollOrdersBody() {
  const start = src.indexOf('export async function pollOrders(');
  assert.notEqual(start, -1, 'expected an exported pollOrders in lib/postsale.mjs');
  const end = src.indexOf('\nfunction finishPoll(', start);
  assert.notEqual(end, -1, 'expected finishPoll to follow pollOrders');
  return src.slice(start, end);
}

describe('pollOrders — a truncated window holds the cursor', () => {
  it('tracks that the sweep was cut short', () => {
    const body = pollOrdersBody();
    assert.match(body, /\btruncated\b/,
      'pollOrders must track whether the window was fully drained before moving the cursor');
  });

  it('never writes orders_cursor unconditionally', () => {
    const body = pollOrdersBody();
    // Every orders_cursor write in the poll must sit under a truncation check. Find them all and
    // require the nearest preceding line to be a guard rather than the end of the page loop.
    const writes = [...body.matchAll(/setMeta\(\s*db\s*,\s*'orders_cursor'/g)];
    assert.ok(writes.length >= 1, 'pollOrders should still advance the cursor on a clean sweep');
    for (const w of writes) {
      const before = body.slice(Math.max(0, w.index - 220), w.index);
      assert.match(before, /if\s*\(\s*!?\s*truncated/,
        'each orders_cursor write must be guarded by the truncation flag — an unconditional write '
        + 'loses every order past max_per_run');
    }
  });

  it('sets the flag on both caps, not just max_per_run', () => {
    const body = pollOrdersBody();
    assert.match(body, /max_per_run[\s\S]{0,60}truncated\s*=\s*true/,
      'hitting max_per_run must mark the window un-drained');
    assert.match(body, /morePages[\s\S]{0,80}truncated\s*=\s*true/,
      'running out of MAX_PAGES with eBay still holding pages must also mark it un-drained');
  });

  it('says so out loud, so a repeating truncation is diagnosable', () => {
    const body = pollOrdersBody();
    assert.match(body, /console\.warn[\s\S]{0,240}not drained/,
      'a held cursor must be logged — otherwise a store quietly ingesting max_per_run per poll '
      + 'forever looks healthy');
  });
});

describe('sweepOpenOrders — still refresh-only, which is why the guard above matters', () => {
  it('does not ingest, so it cannot rescue a skipped order', () => {
    const start = src.indexOf('export async function sweepOpenOrders(');
    assert.notEqual(start, -1, 'expected an exported sweepOpenOrders');
    const body = src.slice(start, src.indexOf('\n// One order-poll at a time', start));
    assert.doesNotMatch(body, /\bingestOrder\s*\(/,
      'if the sweep ever learns to ingest, revisit the cursor guard rationale above');
  });
});
