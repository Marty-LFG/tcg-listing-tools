// test/invariants/ebay-html.test.mjs — Golden Rule 8: eBay descriptions are inline-
// styles only; eBay strips <style>/<script>/active content, so any of those in the
// output silently breaks the listing's look.
//
// Two layers: (1) run the shared lib/listing-copy.mjs buildDescription (byte-identical
// to the builders per check-listing-copy) and scan its OUTPUT; (2) statically scan each
// builder's buildHTML() SOURCE for style/script tag literals.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, extractFn, CARD_BUILDERS, COLLECTIBLE_BUILDERS } from '../helpers/extract-inline.mjs';
import { buildDescription } from '../../lib/listing-copy.mjs';

const F = {
  name: "Kai'Sa - Survivor", num: '039a/298', set: 'Origins', rarity: 'Epic', type: 'Unit',
  variant: 'Foil', lang: 'English', cond: 'Ungraded, Near Mint', pitch: 'A chase alt-art.',
  ink: 'Ruby', cls: 'Storyborn', cost: '3', strength: '2', willpower: '4', lore: '1',
};

function assertInlineOnly(html, label) {
  assert.ok(!/<style[\s>]/i.test(html), `${label}: <style> in output`);
  assert.ok(!/<script[\s>]/i.test(html), `${label}: <script> in output`);
  assert.ok(!/\son\w+\s*=/i.test(html), `${label}: inline event handler in output`);
  assert.ok(/style="/.test(html), `${label}: expected inline styles`);
}

describe('buildDescription output (shared port — GR8)', () => {
  for (const game of ['pokemon', 'lorcana', 'riftbound']) {
    it(game, () => assertInlineOnly(buildDescription(game, F), game));
  }
});

describe('builder buildHTML() source (static scan)', () => {
  for (const file of [...CARD_BUILDERS, ...COLLECTIBLE_BUILDERS]) {
    it(file, () => {
      const src = extractFn(read(file), 'function buildHTML');
      assert.ok(!/<style[\s>]/i.test(src), 'builds a <style> tag');
      assert.ok(!/<script[\s>]/i.test(src), 'builds a <script> tag');
    });
  }
});
