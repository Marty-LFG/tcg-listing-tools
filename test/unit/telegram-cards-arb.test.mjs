// test/unit/telegram-cards-arb.test.mjs — the arbitrage hit card (lib/telegram-cards.mjs renderArbHit).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderArbHit } from '../../lib/telegram-cards.mjs';

const HIT = {
  name: 'Umbreon', number: '130', printing_key: 'reverseHolofoil', set_id: 'sv3',
  title: 'Umbreon 130/197 Reverse Holo Obsidian Flames <script>x</script>',
  profit_cents: 812, margin_pct: 41.2, delivered_cents: 1970, price_cents: 1500, ship_cents: 300, fee_cents: 170,
  buyer_aud_cents: 2782, buyer_pct: 0.8, market_usd_cents: 2287, fx_usd_aud: 1.5205,
  seller: 'some_seller', seller_fb_pct: 99.6, seller_fb_score: 412, url: 'https://www.ebay.com.au/itm/1',
  warnings: [{ k: 'cond_unstated', why: 'the title states no condition — judge it from the photos' }],
};

describe('renderArbHit', () => {
  const { text, buttons } = renderArbHit(HIT, { dashboardUrl: 'http://alcserver/arbitrage.html' });
  it('leads with the profit and shows every figure that decided it', () => {
    assert.match(text, /A\$8\.12<\/b> profit \(41% on outlay\)/);
    assert.match(text, /Landed\s+<b>A\$19\.70<\/b>\s+<i>A\$15\.00 \+ A\$3\.00 post \+ A\$1\.70 fee<\/i>/);
    assert.match(text, /Buyer pays\s+<b>A\$27\.82<\/b>\s+<i>80% of US\$22\.87 market @ 1\.5205<\/i>/);
    assert.match(text, /Reverse Holo/);
  });
  it('escapes the seller\'s title and carries the warnings', () => {
    assert.doesNotMatch(text, /<script>/);
    assert.match(text, /&lt;script&gt;/);
    assert.match(text, /⚠️ the title states no condition/);
  });
  it('buttons open the listing and the dashboard', () => {
    assert.deepEqual(buttons, [[{ text: 'Open on eBay', url: 'https://www.ebay.com.au/itm/1' }], [{ text: 'All hits', url: 'http://alcserver/arbitrage.html' }]]);
  });
  it('a fee-less hit does not claim a fee', () => {
    assert.doesNotMatch(renderArbHit({ ...HIT, fee_cents: 0 }).text, /fee/);
  });
});
