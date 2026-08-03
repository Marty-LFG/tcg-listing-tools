// test/unit/runner-labels.test.mjs — the Batch Runner's label column.
//
// stock-runner.html is a standalone page whose module script cannot be imported, so this uses the
// repo's extract-inline idiom to pull the REAL function out of the HTML and exercise it.
//
// THE BUG THIS LOCKS DOWN (2026-08-03): every unlisted row printed the SAME next label. On a shelf
// system where the label IS the card's address, four rows reading AAD-024 says "these four cards
// share a slot". One label per LISTING is the rule — copies of one card ride a single number as a
// quantity — so each ROW must preview its own.
//
// The page's comps links used to be tested here too. They are lib/ebay-links.mjs's job now (one
// implementation for the pages and the Telegram cards), so they are covered by
// test/unit/ebay-links.test.mjs and test/invariants/ebay-links-single-source.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, extractFn } from '../helpers/extract-inline.mjs';
import { deriveState, isPublishable } from '../../lib/runner-core.mjs';

const html = read('stock-runner.html');

// labelPreview reads QUEUE / labelSeeded / labelUpcoming / curMedian / rowInBatch from the page's
// module scope; binding them as parameters is how the extracted copy gets the same free variables.
// rowInBatch is the page's own (test/unit/runner-tick.test.mjs owns its behaviour), so the two stay
// in step — the label run and the publish run have to be the same set of rows or the preview lies.
const rowInBatch = new Function('isPublishable', 'stateOf', 'return (' + extractFn(html, 'function rowInBatch') + ')')(
  isPublishable, (r) => deriveState(r, 10));
function makePreview({ queue, upcoming, seeded = true, median = 10 }) {
  const src = extractFn(html, 'function labelPreview');
  return new Function('QUEUE', 'labelUpcoming', 'labelSeeded', 'curMedian', 'deriveState', 'rowInBatch',
    'return (' + src + ')')(queue, upcoming, seeded, () => median, deriveState, rowInBatch);
}
// A row the runner would call READY: near mint, priced, nothing to flag at this median.
let seq = 0;
const row = (over = {}) => Object.assign({ uid: ++seq, cond: 'Near Mint', askAud: 10, inc: true }, over);
const RUN = ['AAD-024', 'AAD-025', 'AAD-026', 'AAD-027'];

describe('labelPreview — one number per row, never the same one twice', () => {
  it('gives each queued row its own label, in queue order', () => {
    const queue = [row(), row(), row()];
    const preview = makePreview({ queue, upcoming: RUN });
    assert.deepEqual(queue.map(preview), ['AAD-024', 'AAD-025', 'AAD-026']);
  });

  it('a row holding several copies still takes exactly one', () => {
    const queue = [row({ qty: 3 }), row({ qty: 1 })];
    const preview = makePreview({ queue, upcoming: RUN });
    assert.deepEqual(queue.map(preview), ['AAD-024', 'AAD-025'], 'quantity rides the label, it does not spend more');
  });

  it('follows the series as the server gives it, gaps and block rollovers included', () => {
    const queue = [row(), row(), row()];
    // AAD-025 is on a hand-made listing, so the server skipped it; AAC-099 rolls into AAD-001.
    const preview = makePreview({ queue, upcoming: ['AAC-099', 'AAD-001', 'AAD-002'] });
    assert.deepEqual(queue.map(preview), ['AAC-099', 'AAD-001', 'AAD-002']);
  });

  it('skips rows that are not going out, so the ones that are keep consecutive numbers', () => {
    const untickd = row({ inc: false });
    const held = row({ cond: 'Lightly Played' });          // HELD — cannot list on catalog art
    const queue = [row(), untickd, held, row()];
    const preview = makePreview({ queue, upcoming: RUN });
    assert.equal(preview(queue[0]), 'AAD-024');
    assert.equal(preview(untickd), null, 'not in the batch — no number is lined up for it');
    assert.equal(preview(held), null);
    assert.equal(preview(queue[3]), 'AAD-025', 'the next row that IS going out takes the next number');
  });

  it('counts a staged row — it is already committed to the run', () => {
    const staged = row({ staged: true, sku: 'STG-000001' });
    const queue = [staged, row()];
    const preview = makePreview({ queue, upcoming: RUN });
    assert.equal(preview(staged), 'AAD-024', 'a provisional STG-* sku is not a shelf label');
    assert.equal(preview(queue[1]), 'AAD-025');
  });

  it('drops a staged row the operator has unticked, and gives its number to the next one', () => {
    const pulled = row({ staged: true, inc: false, sku: 'STG-000001' });
    const queue = [pulled, row()];
    const preview = makePreview({ queue, upcoming: RUN });
    assert.equal(preview(pulled), null);
    assert.equal(preview(queue[1]), 'AAD-024');
  });

  it('ignores rows that already listed — their labels are spent and bound', () => {
    const live = row({ published: true, sku: 'AAD-023', listingUrl: 'https://ebay/1' });
    const queue = [live, row()];
    const preview = makePreview({ queue, upcoming: RUN });
    assert.equal(preview(live), null);
    assert.equal(preview(queue[1]), 'AAD-024', 'a listed row does not push the queue along');
  });

  it('says so rather than guessing when the batch outruns the fetched labels', () => {
    const queue = [row(), row(), row()];
    const preview = makePreview({ queue, upcoming: ['AAD-024'] });
    assert.equal(preview(queue[0]), 'AAD-024');
    assert.equal(preview(queue[1]), '…', 'GR7: degrade visibly, never invent a number');
    assert.equal(preview(queue[2]), '…');
  });

  it('previews nothing at all when the series is unseeded', () => {
    const queue = [row(), row()];
    const preview = makePreview({ queue, upcoming: [], seeded: false });
    assert.deepEqual(queue.map(preview), [null, null]);
  });
});

describe('the grid links through the shared builder', () => {
  // Not a URL test — that is lib/ebay-links.mjs's. This only pins that the grid still calls it for
  // BOTH halves, active and sold, since a row with one of them is half a comparison.
  it('both the row pair and the drawer chips call searchUrl', () => {
    const active = (html.match(/searchUrl\(q\)/g) || []).length;
    const sold = (html.match(/searchUrl\(q, \{ sold: true \}\)/g) || []).length;
    assert.equal(active, 2, 'row pair + drawer chip');
    assert.equal(sold, 2, 'row pair + drawer chip');
  });
});
