// test/unit/runner-tick.test.mjs — the Batch Runner's tick is the operator's intent, and stays it.
//
// THE BUG THIS LOCKS DOWN (2026-08-03): patchRow ran `r.inc = r.inc && isPublishable(st)` on every
// repaint. Both halves of the damage came from that one line:
//
//   1. A row is PRICING for the second or two its eBay comps take, and PRICING is not publishable —
//      so every row arrived in the grid silently UNTICKED and could never recover, because the flag
//      only ever moved one way. The operator had to press "Tick ready" after every add.
//   2. Staging puts a row in STAGED, also not publishable, so the same line untickd it — while
//      Publish asks for `staged && inc`. A fully staged batch had nothing left to publish.
//
// The fix is to stop writing the answer down: whether a row can go is derived where it is asked
// (rowTickable / rowInBatch), so a transient state costs nothing. This test pins both the derived
// rules and the source-level rule that patchRow must not touch r.inc.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, extractFn } from '../helpers/extract-inline.mjs';
import { deriveState, isPublishable } from '../../lib/runner-core.mjs';

const html = read('stock-runner.html');

// Both helpers read QUEUE-level state through stateOf(); binding it (plus isPublishable) as
// parameters is how the extracted copies get the same free variables the page gives them.
function bind(marker) {
  const src = extractFn(html, marker);
  const stateOf = (r) => deriveState(r, 10);
  return new Function('isPublishable', 'stateOf', 'return (' + src + ')')(isPublishable, stateOf);
}
const rowTickable = bind('function rowTickable');
const rowInBatch = bind('function rowInBatch');

const row = (over = {}) => Object.assign({ cond: 'Near Mint', askAud: 10, inc: true }, over);

describe('rowTickable — could this row go out?', () => {
  it('yes for a clean priced row', () => {
    assert.equal(rowTickable(row()), true);
  });

  it('YES while it is still being priced — "Tick ready" must not skip a row mid-flight', () => {
    assert.equal(rowTickable(row({ pricing: true })), true, 'PRICING is a moment, not a verdict');
  });

  it('yes once it is staged — it is waiting on Publish, not on a decision', () => {
    assert.equal(rowTickable(row({ staged: true, sku: 'STG-000001' })), true);
  });

  it('yes for a staged row whose publish failed, so a retry can pick it up', () => {
    assert.equal(rowTickable(row({ staged: true, failed: 'eBay said no' })), true);
  });

  it('no once it is live — the number is spent and the listing is up', () => {
    assert.equal(rowTickable(row({ published: true, listingUrl: 'https://ebay/1' })), false);
  });

  it('no for a row held back or waiting on eyes', () => {
    assert.equal(rowTickable(row({ cond: 'Lightly Played' })), false, 'HELD: catalog art on a used card');
    assert.equal(rowTickable(row({ askAud: null })), false, 'EYES: no price yet');
  });
});

describe('rowInBatch — is it going out on this run?', () => {
  it('needs both the tick and the readiness', () => {
    assert.equal(rowInBatch(row()), true);
    assert.equal(rowInBatch(row({ inc: false })), false, 'untickd is out, however clean');
    assert.equal(rowInBatch(row({ inc: true, cond: 'Heavily Played' })), false, 'ticked but held is out');
  });

  it('a staged row IS in the run — this is the one that broke Publish', () => {
    assert.equal(rowInBatch(row({ staged: true, sku: 'STG-000001' })), true);
  });

  it('a row still pricing is tickable but not yet in the run, and rejoins it untouched', () => {
    const r = row({ pricing: true });
    assert.equal(rowTickable(r), true, 'the box can hold a tick while the comps land');
    assert.equal(rowInBatch(r), false, 'but there is no ask yet, so nothing to stage');
    delete r.pricing;                                   // comps landed; nothing else changed
    assert.equal(rowInBatch(r), true, 'the tick was never overwritten, so the row simply joins');
  });
});

describe('the tick is never written back over (source rule)', () => {
  // The repaint paths. A tick that a repaint can clear is a tick the operator cannot rely on, and
  // it fails silently — the row just quietly stops being in the batch.
  for (const fn of ['function patchRow', 'function refreshNow', 'function labelPreview']) {
    it(fn.replace('function ', '') + ' does not assign r.inc', () => {
      const src = extractFn(html, fn);
      const lines = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l) && /\br\.inc\s*=[^=]/.test(l));
      assert.deepEqual(lines, [], 'derive inclusion (rowInBatch), never overwrite the operator');
    });
  }

  it('every writer is an explicit operator action', () => {
    // Ticking a box, the header tick-all, Tick ready / Untick all, and OK on a flagged row.
    const writers = html.split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l) && /\br\.inc\s*=[^=]/.test(l))
      .map((l) => l.trim());
    assert.equal(writers.length, 5, 'unexpected r.inc writer — read this file’s header before adding one');
    for (const w of writers) {
      assert.match(w, /addEventListener|e\.target|classList/, 'r.inc set outside an operator action: ' + w);
    }
  });
});
