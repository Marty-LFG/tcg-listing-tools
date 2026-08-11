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
  for (const game of ['pokemon', 'lorcana', 'riftbound', 'mtg']) {
    it(game, () => assertInlineOnly(buildDescription(game, F), game));
    it(game + ' (slab)', () => assertInlineOnly(buildDescription(game, F, { slab: true }), game));
  }
});

// The art/pitch pair sits side-by-side above ~545px and stacks below it, with no
// media query — eBay strips those (GR8). Two display:inline-block siblings share a
// line while both fit and wrap when min-width can't be honoured. Both properties
// below are load-bearing and neither is obvious from reading the markup:
//
//   • no whitespace between </div><div — a text node between inline-blocks renders
//     as a space and pushes the pair over the line, so they never sit together;
//   • width:calc(100% - <art>px) — an inline-block sizes against its CONTAINER, not
//     the space left on the line. Omit it and the copy claims 100% and always wraps.
describe('description art/pitch pair (no media queries available — GR8)', () => {
  const F_ART = { ...F, img: 'https://example.test/art.png' };
  // Only the frames that HAVE the pair. lorcana and riftbound take their own early-return branches
  // in buildDescription and never reach it, so asserting on them would fail on a rule they do not
  // implement. mtg gained the pair with its own frame and must hold the same two properties.
  for (const game of ['pokemon', 'mtg']) {
    it(`${game}: keeps the two inline-blocks adjacent with no text node between them`, () => {
      const html = buildDescription(game, F_ART);
      const blocks = (html.match(/display:inline-block/g) || []).length;
      assert.equal(blocks, 2, 'expected exactly the art + pitch pair');
      assert.match(html, /<\/div><div style="display:inline-block/,
        'whitespace between the inline-blocks would push the pair apart');
    });

    it(`${game}: sizes the copy against the container, leaving room for the art`, () => {
      const html = buildDescription(game, F_ART);
      assert.match(html, /width:calc\(100% - \d+px\)/,
        'inline-block sizes against its container — without calc() the copy always wraps');
      assert.match(html, /min-width:\d+px/, 'min-width is what triggers the stack');
    });

    it(`${game}: drops the split entirely when there is no art`, () => {
      const html = buildDescription(game, { ...F_ART, img: '' });
      assert.ok(!/display:inline-block/.test(html),
        'no art means the pitch should run full width, not sit in half a split');
    });
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
