// test/unit/telegram-cards.test.mjs — the wording of the bot's messages (lib/telegram-cards.mjs).
// Pure builders, so no token and no network. The digest is the one that matters: it is read while
// standing at a shelf, and the old one-line-per-order format turned a ten-card order into a
// paragraph you had to re-read to pull from.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shortTitle, renderPullList, renderDispatchSummary, renderSaleAlert, renderHoldAlert } from '../../lib/telegram-cards.mjs';
import { buildPickSheet } from '../../lib/postsale.mjs';

describe('shortTitle', () => {
  it('keeps name, number and set; drops game, rarity, finish, language, condition', () => {
    assert.equal(shortTitle('Pokemon Delibird 152/132 Mega Evolution Illustration Rare Holo EN M/NM'),
      'Delibird 152/132 Mega Evolution');
    assert.equal(shortTitle('Pokemon Wailord ex 016/084 Pitch Black Double Rare Holo EN M/NM'),
      'Wailord ex 016/084 Pitch Black');
    assert.equal(shortTitle('Pokemon Froakie 86 Ninja Spinner Holo JP M/NM'),
      'Froakie 86 Ninja Spinner');
  });
  it('keeps the whole title when stripping would leave too little to identify the card', () => {
    // A long line you can act on beats a short one you can't.
    assert.equal(shortTitle('Pokemon Holo EN M/NM'), 'Pokemon Holo EN M/NM');
    assert.equal(shortTitle('EN M/NM'), 'EN M/NM');
  });
  it('survives empty and non-card input', () => {
    assert.equal(shortTitle(''), '');
    assert.equal(shortTitle(null), '');
    assert.equal(shortTitle('Mystery bundle'), 'Mystery bundle');
  });
});

// The pull list is walked at the shelf, so what it must get right is the ORDER: box by box, and
// within a box by SKU. It runs the real buildPickSheet() — the same function behind the printed pick
// sheet — so these assert the shared contract rather than a second implementation of it.
describe('renderPullList', () => {
  const row = (order_id, sku, title, location, quantity = 1) => ({ order_id, sku, title, location, quantity });
  const sheet = (rows) => buildPickSheet(rows, new Map());

  it('groups by box and walks each box in SKU order, not buyer order', () => {
    const ps = sheet([
      row('B', 'AAC-012', 'Pokemon Delibird 152/132 Mega Evolution Holo EN M/NM', 'Box AAC'),
      row('A', 'AAC-001', 'Pokemon Wailord ex 016/084 Pitch Black Holo EN M/NM', 'Box AAC'),
      row('A', 'BKP-003', 'Pokemon Froakie 86 Ninja Spinner Holo JP M/NM', 'Box BKP'),
    ]);
    const t = renderPullList(ps.groups, { orderCount: 2, itemCount: ps.rows.length, unitCount: ps.unit_count });
    assert.ok(t.indexOf('AAC-001') < t.indexOf('AAC-012'), 'SKUs must ascend within a box');
    assert.ok(t.indexOf('Box AAC') < t.indexOf('Box BKP'));
    assert.ok(t.indexOf('AAC-012') < t.indexOf('Box BKP'), 'a box must not be split across the list');
  });

  it('puts the unmatched bucket last, so the guesswork is at the end of the walk', () => {
    const ps = sheet([
      row('A', null, 'Pokemon Naveen 112/088 Perfect Order Holo EN M/NM', null),
      row('A', 'AAC-001', 'Pokemon Wailord ex 016/084 Pitch Black Holo EN M/NM', 'Box AAC'),
    ]);
    const t = renderPullList(ps.groups, {});
    assert.ok(t.indexOf('Box AAC') < t.indexOf('Unsorted'));
  });

  it('marks quantity above one — pulling two of something is the easy mistake', () => {
    const ps = sheet([row('A', 'AAC-001', 'Pokemon Wailord ex 016/084 Pitch Black Holo EN M/NM', 'Box AAC', 3)]);
    assert.match(renderPullList(ps.groups, {}), /×3/);
  });

  it('counts lines and cards separately when they differ', () => {
    const ps = sheet([row('A', 'AAC-001', 'a 1/1 Set Holo EN M/NM', 'Box AAC', 2)]);
    const t = renderPullList(ps.groups, { orderCount: 1, itemCount: ps.rows.length, unitCount: ps.unit_count });
    assert.match(t, /1 line · 2 cards/);
  });

  it('says so when there is nothing left to pull', () => {
    assert.match(renderPullList([], { orderCount: 3 }), /Nothing to pull/);
  });

  it('stays under the Telegram limit and names what it dropped', () => {
    const rows = Array.from({ length: 400 }, (_, i) =>
      row('O' + i, 'BOX' + String(i).padStart(3, '0') + '-001', 'Pokemon Card ' + i + '/999 Some Long Set Name Illustration Rare Holo EN M/NM', 'Box ' + i));
    const ps = sheet(rows);
    const t = renderPullList(ps.groups, { orderCount: 400, itemCount: ps.rows.length, unitCount: ps.unit_count });
    assert.ok(t.length <= 4096, 'must fit a Telegram message, got ' + t.length);
    assert.match(t, /…and \d+ more lines/);
  });
});

describe('renderDispatchSummary', () => {
  const order = (buyer, n, extra = {}) => ({
    buyer_username: buyer, ship_city: 'Tapping', ship_state: 'WA',
    picked_at: null, items: Array.from({ length: n }, () => ({ quantity: 1 })), ...extra,
  });
  it('one line per order with destination and card count', () => {
    const t = renderDispatchSummary([order('amy', 3), order('bob', 1)]);
    assert.match(t, /@amy<\/b> · Tapping, WA · 3 cards/);
    assert.match(t, /@bob<\/b> · Tapping, WA · 1 card/);
  });
  it('flags and counts orders already pulled', () => {
    const t = renderDispatchSummary([order('amy', 1, { picked_at: '2026-07-31' }), order('bob', 1)]);
    assert.match(t, /1 already pulled/);
    assert.match(t, /✅ <b>@amy/);
  });
  it('sums quantity, not line count', () => {
    assert.match(renderDispatchSummary([{ buyer_username: 'amy', items: [{ quantity: 4 }] }]), /4 cards/);
  });
});

describe('renderSaleAlert', () => {
  it('leads with money and destination, then the cards', () => {
    const t = renderSaleAlert({
      items: [{ title: 'Pokemon Wailord ex 016/084 Pitch Black Double Rare Holo EN M/NM', quantity: 2 }],
      totalText: 'A$45.50', where: 'Sydney, NSW 2000', buyerUsername: 'amy', repeat: true,
    });
    assert.match(t, /SOLD/);
    assert.match(t, /repeat buyer/);
    assert.match(t, /A\$45\.50/);
    assert.match(t, /Sydney, NSW 2000/);
    assert.match(t, /Wailord ex 016\/084 Pitch Black ×2/);
  });
  it('omits the repeat flag for a first-time buyer', () => {
    assert.doesNotMatch(renderSaleAlert({ items: [], totalText: 'A$5', buyerUsername: 'bob' }), /repeat/);
  });
});

describe('renderHoldAlert', () => {
  const items = [{ title: 'Pokemon Charizard 006/165 151 Holo EN M/NM', sku: 'AAC-012', quantity: 1, location: 'Box AAC' }];
  const base = { orderId: '10-14989-43407', salesRecordNumber: 812, buyerUsername: 'amy', totalText: 'A$510.00', items };

  it('a confirmed cancellation leads with the verdict and says DO NOT POST', () => {
    const t = renderHoldAlert({ ...base, kind: 'cancel', state: 'cancelled',
      initiator: 'Buyer', reason: 'Ordered by mistake', restock: { reversed: 1, skipped: [] }, watching: true });
    assert.match(t, /ORDER CANCELLED/);
    assert.match(t, /Do not post this/);
    assert.match(t, /Buyer cancelled it — Ordered by mistake/);
    // The SKU and the SHELF are the actual physical job: these cards have to go back somewhere.
    assert.match(t, /AAC-012/);
    assert.match(t, /Box AAC/);
    assert.match(t, /1 line put back on the shelf/);
    assert.match(t, /Watching for the new listing|watching for the new listing/i);
  });

  it('NEVER claims a restock it could not do', () => {
    // A line decremented before the effect log existed cannot be put back faithfully. Rounding that up
    // to "done" is how stock silently drifts and eventually oversells.
    const t = renderHoldAlert({ ...base, kind: 'cancel', state: 'cancelled',
      restock: { reversed: 0, skipped: [{ sku: 'AAC-012', why: 'no record of what the sale did' }] } });
    assert.doesNotMatch(t, /put back on the shelf/);
    assert.match(t, /could not be put back automatically/);
    assert.match(t, /AAC-012<\/code> — no record of what the sale did/);
  });

  it('a request is a HOLD, keeps the stock, and says who actually owns the decision', () => {
    const t = renderHoldAlert({ ...base, kind: 'cancel', state: 'requested', initiator: 'Buyer' });
    assert.match(t, /CANCELLATION REQUESTED/);
    assert.match(t, /Hold off packing/);
    assert.match(t, /has <b>not<\/b> been put back/);
    // Without this the "Got it" button reads as "approve", which is precisely what it is not — eBay
    // does not expose the Cancel ID over the API this app uses.
    assert.match(t, /Seller Hub job/);
    assert.doesNotMatch(t, /Do not post this/);
  });

  it('a failed payment is its own message, not a cancellation', () => {
    const t = renderHoldAlert({ ...base, kind: 'payment', state: 'failed' });
    assert.match(t, /PAYMENT FAILED/);
    assert.match(t, /payment failed after the order was marked paid/);
    assert.doesNotMatch(t, /Seller Hub job/);   // nothing to approve or reject here
  });

  it('stamps who cleared it once acknowledged', () => {
    const t = renderHoldAlert({ ...base, kind: 'cancel', state: 'cancelled' }, { icon: '✅', status: 'acknowledged', who: '@marty' });
    assert.match(t, /acknowledged/);
    assert.match(t, /@marty/);
  });

  it('escapes a hostile buyer name and card title', () => {
    const t = renderHoldAlert({ ...base, buyerUsername: '<script>', state: 'cancelled',
      items: [{ title: 'A & B <b>', sku: 'X', quantity: 1 }] });
    assert.doesNotMatch(t, /<script>/);
    assert.match(t, /&lt;script&gt;/);
    assert.match(t, /A &amp; B/);
  });
});
