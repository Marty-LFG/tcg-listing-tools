// test/unit/runner-batch-results.test.mjs — the receipt shown when a batch publish finishes.
//
// Everything in it is already in the grid; the point is that at the end of a run you have exactly
// two questions — what went live (with a link, and the shelf label that goes on the sleeve), and
// what did not (with the reason) — and answering them by reading down sixty rows is not answering
// them. The clear button is the other half: it must never be the loud one while there is unfinished
// work in the queue, and it must say how much it is about to throw away.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, extractFn } from '../helpers/extract-inline.mjs';

const html = read('stock-runner.html');

// batchResults reads QUEUE and paints through modal()/$(); binding them as parameters is how the
// extracted copy gets the same free variables the page gives it.
function render(rows, s = {}, queue = rows) {
  let painted = '';
  const wired = [];
  const $ = () => ({ addEventListener: (_, fn) => wired.push(fn) });
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (a) => (a == null || !isFinite(a)) ? '—' : 'A$' + (Math.round(a * 100) / 100).toFixed(2);
  const TCG = { formatCardNumber: (n) => String(n || '') };
  const fn = new Function('QUEUE', 'modal', '$', 'esc', 'money', 'TCG', 'closeModal', 'clearQueue',
    'return (' + extractFn(html, 'function batchResults') + ')')(
    queue, (h) => { painted = h; }, $, esc, money, TCG, () => {}, () => {});
  fn(rows, s);
  return { html: painted, wired };
}

const live = (over = {}) => Object.assign(
  { card: { name: 'Palafin', number: '200/197' }, sku: 'AAD-024', qty: 1, askAud: 10.98, published: true, listingUrl: 'https://www.ebay.com.au/itm/1' }, over);
const heldRow = (over = {}) => Object.assign(
  { card: { name: 'Salandit', number: '139/197' }, sku: null, qty: 3, askAud: 2.48, failed: 'eBay refused: [25002] duplicate listing' }, over);

describe('batchResults — the receipt', () => {
  it('links every listing, and shows the label that goes on the sleeve', () => {
    const { html: out } = render([live(), live({ sku: 'AAD-025', card: { name: 'Pidgeot ex', number: '225/197' }, listingUrl: 'https://www.ebay.com.au/itm/2' })]);
    assert.match(out, /Listed on eBay<\/span><span class="mono">2 of 2/);
    assert.match(out, /href="https:\/\/www\.ebay\.com\.au\/itm\/1"/);
    assert.match(out, /href="https:\/\/www\.ebay\.com\.au\/itm\/2"/);
    assert.match(out, /AAD-024/);
    assert.match(out, /AAD-025/);
  });

  it('totals what actually went live, quantity included', () => {
    const { html: out } = render([live({ qty: 2 }), heldRow()]);
    assert.match(out, /Value listed<\/span><span class="mono">A\$21\.96/, 'the held row is not money you made');
  });

  it('a held row gets its reason, not a link', () => {
    const { html: out } = render([heldRow()]);
    assert.match(out, /Salandit/);
    assert.match(out, /\[25002\] duplicate listing/);
    assert.ok(!/view ↗/.test(out), 'nothing to view — it did not list');
  });

  it('separates rows the server left alone because they were already live', () => {
    const { html: out } = render([live({ listingUrl: null, note: 'already live on eBay' })]);
    assert.match(out, /already live/);
    assert.match(out, /Already live, left alone/);
  });

  it('with nothing left unfinished, clearing is the loud button', () => {
    const { html: out } = render([live(), live()]);
    assert.match(out, /class="btn primary" id="mClear"/, 'clearing is simply what you do next');
    assert.match(out, /id="mClose">Close</);
    assert.ok(!/have not listed/.test(out), 'no warning to give');
  });

  it('with work still in the queue, the quiet button wins and the loud one owns up', () => {
    const rows = [live(), heldRow()];
    const { html: out } = render(rows, {}, rows);
    assert.match(out, /class="btn primary" id="mClose"/, 'Close takes the emphasis');
    assert.match(out, /class="btn" id="mClear"/);
    assert.match(out, /<b>1<\/b> row has not listed/);
    assert.match(out, /a re-run never double-lists/);
  });

  it('counts the WHOLE queue on the clear button, not just this run', () => {
    const rows = [live()];
    const queue = [...rows, heldRow(), heldRow()];         // two rows added while the batch went out
    const { html: out } = render(rows, {}, queue);
    assert.match(out, /Close and clear 3 rows/);
  });

  it('says stopped rather than finished when the run was halted', () => {
    const { html: out } = render([live()], { cancelled: true });
    assert.match(out, /Batch stopped/);
  });

  it('wires both buttons', () => {
    const { wired } = render([live()]);
    assert.equal(wired.length, 2);
  });

  it('an empty run paints nothing at all', () => {
    const { html: out } = render([]);
    assert.equal(out, '', 'no rows, no receipt');
  });
});
