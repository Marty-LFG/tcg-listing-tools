// test/unit/telegram-cards.test.mjs — the wording of the bot's messages (lib/telegram-cards.mjs).
// Pure builders, so no token and no network. The digest is the one that matters: it is read while
// standing at a shelf, and the old one-line-per-order format turned a ten-card order into a
// paragraph you had to re-read to pull from.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shortTitle, renderPackDigest, renderSaleAlert } from '../../lib/telegram-cards.mjs';

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

describe('renderPackDigest', () => {
  const order = (buyer, items, extra = {}) => ({
    order_id: 'O-' + buyer, buyer_username: buyer, ship_city: 'Tapping', ship_state: 'WA',
    picked_at: null, items: items.map((t) => ({ title: t, quantity: 1 })), ...extra,
  });

  it('gives each card its own line, grouped under its order', () => {
    const t = renderPackDigest([order('amy', ['Pokemon Delibird 152/132 Mega Evolution Holo EN M/NM', 'Pokemon Naveen 112/088 Perfect Order Ultra Rare Holo EN M/NM'])]);
    assert.match(t, /\n {2}Delibird 152\/132 Mega Evolution\n/);
    assert.match(t, /\n {2}Naveen 112\/088 Perfect Order/);
    assert.match(t, /@amy/);
  });
  it('counts orders and cards, not just orders', () => {
    const t = renderPackDigest([order('amy', ['a 1/1 Set Holo EN M/NM', 'b 2/2 Set Holo EN M/NM']), order('bob', ['c 3/3 Set Holo EN M/NM'])]);
    assert.match(t, /2 orders · 3 cards/);
  });
  it('flags an already-picked order and counts it', () => {
    const t = renderPackDigest([order('amy', ['a 1/1 Set Holo EN M/NM'], { picked_at: '2026-07-31' })]);
    assert.match(t, /1 already packed/);
    assert.match(t, /✅ <b>@amy/);
  });
  it('shows quantity only when there is more than one', () => {
    const o = order('amy', ['a 1/1 Set Holo EN M/NM']);
    o.items[0].quantity = 3;
    assert.match(renderPackDigest([o]), /×3/);
    assert.doesNotMatch(renderPackDigest([order('bob', ['b 2/2 Set Holo EN M/NM'])]), /×1/);
  });
  it('stays under the Telegram limit and says what it dropped', () => {
    const many = Array.from({ length: 200 }, (_, i) => order('buyer' + i, ['Pokemon Card ' + i + '/999 Some Long Set Name Illustration Rare Holo EN M/NM']));
    const t = renderPackDigest(many);
    assert.ok(t.length <= 4096, 'must fit a Telegram message, got ' + t.length);
    assert.match(t, /…and \d+ more orders/);
  });
  it('handles an empty list without throwing', () => {
    assert.match(renderPackDigest([]), /0 orders/);
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
