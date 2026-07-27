// test/unit/runner-ndjson.test.mjs — the Runner's NDJSON reader, extracted from the page.
//
// stock-runner.html is a standalone page whose module script cannot be imported, so this uses the
// repo's established extract-inline idiom (test/helpers/extract-inline.mjs) to pull the REAL
// consumeNdjson out of the HTML and exercise it. Testing a hand-copied twin would only prove the
// twin works.
//
// The failure this guards is specific and silent: a batch publish streams one JSON object per line
// over a chunked response, and the chunk boundaries fall wherever the network puts them. A reader
// that assumes each chunk is a whole line drops rows — the batch looks like it published fewer
// cards than it did, which is the worst possible way to be wrong about eBay listings.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, extractFn } from '../helpers/extract-inline.mjs';

const html = read('stock-runner.html');
const src = extractFn(html, 'async function consumeNdjson');
const consumeNdjson = new Function('return (' + src + ')')();

// A minimal stand-in for a streaming fetch Response body.
function streamOf(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return { body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }) }) } };
}
async function collect(chunks) {
  const out = [];
  await consumeNdjson(streamOf(chunks), (o) => out.push(o));
  return out;
}

const START = '{"start":{"total":2,"median_cents":1000}}';
const ROW1 = '{"row":{"item_id":1,"status":"live","sku":"AAA-001","url":"https://ebay/1"}}';
const ROW2 = '{"row":{"item_id":2,"status":"refused","refusals":[{"code":"over_ceiling","message":"too dear"}]}}';
const SUM = '{"summary":{"total":2,"listed":1,"refused":1,"failed":0,"skipped":0}}';

describe('consumeNdjson — one object per line, whatever the chunking', () => {
  it('reads a clean stream where every chunk is one whole line', async () => {
    const out = await collect([START + '\n', ROW1 + '\n', ROW2 + '\n', SUM + '\n']);
    assert.equal(out.length, 4);
    assert.equal(out[0].start.total, 2);
    assert.equal(out[1].row.item_id, 1);
    assert.equal(out[2].row.status, 'refused');
    assert.equal(out[3].summary.listed, 1);
  });

  it('reassembles an object split ACROSS chunks — the real network case', async () => {
    const joined = [START, ROW1, ROW2, SUM].join('\n') + '\n';
    const mid = Math.floor(joined.length / 2);
    const out = await collect([joined.slice(0, mid), joined.slice(mid)]);
    assert.equal(out.length, 4);
    assert.equal(out[1].row.sku, 'AAA-001');
    assert.equal(out[2].row.refusals[0].code, 'over_ceiling');
  });

  it('survives byte-at-a-time delivery', async () => {
    const joined = [START, ROW1, SUM].join('\n') + '\n';
    const out = await collect([...joined]);
    assert.deepEqual(out.map((o) => Object.keys(o)[0]), ['start', 'row', 'summary']);
  });

  it('handles several lines arriving in ONE chunk', async () => {
    const out = await collect([[START, ROW1, ROW2, SUM].join('\n') + '\n']);
    assert.equal(out.length, 4);
  });

  it('ignores blank lines rather than emitting undefined rows', async () => {
    const out = await collect([START + '\n\n\n' + ROW1 + '\n']);
    assert.equal(out.length, 2);
  });

  it('skips a malformed line instead of aborting the whole run', async () => {
    // A truncated or corrupted line must cost that one row, never the rest of the batch (GR7).
    const out = await collect([START + '\n', '{not json\n', ROW1 + '\n', SUM + '\n']);
    assert.equal(out.length, 3);
    assert.equal(out[1].row.item_id, 1);
    assert.ok(out[2].summary);
  });

  it('an empty stream yields nothing and does not hang', async () => {
    assert.deepEqual(await collect([]), []);
  });

  it('a stream cut off mid-object drops only the incomplete tail', async () => {
    // The server died halfway. Everything already emitted still counts — those listings are live.
    const out = await collect([START + '\n' + ROW1 + '\n' + '{"row":{"item_id":3,"stat']);
    assert.equal(out.length, 2);
    assert.equal(out[1].row.item_id, 1);
  });

  it('a trailing line with no newline is NOT emitted', async () => {
    // Documents the actual behaviour so nobody assumes otherwise: ndjsonStart always terminates
    // each record with \n, so a newline-less tail means a truncated stream, not a final record.
    const out = await collect([START + '\n' + ROW1]);
    assert.equal(out.length, 1);
    assert.ok(out[0].start);
  });
});
