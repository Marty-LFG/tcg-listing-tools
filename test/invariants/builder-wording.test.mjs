// test/invariants/builder-wording.test.mjs — Golden Rule 6: the five card builders'
// condition/postage/footer wording is owner-verified and must stay BYTE-IDENTICAL
// across all five. LEGO/Funko intentionally carry their own wording (boxed goods
// don't ship in penny sleeves) — only the footer is shared suite-wide.
// The canonical strings come from lib/listing-copy.mjs (no copies in this test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, CARD_BUILDERS, COLLECTIBLE_BUILDERS } from '../helpers/extract-inline.mjs';
import { CARD_CONDITION_SUFFIX, CARD_POSTAGE, CARD_FOOTER, DEFAULT_CARD_CONDITION } from '../../lib/listing-copy.mjs';

describe('card builders (GR6: identical owner-verified wording)', () => {
  for (const file of CARD_BUILDERS) {
    it(file, () => {
      const src = read(file);
      assert.ok(src.includes(CARD_POSTAGE), 'postage line missing/reworded');
      assert.ok(src.includes(CARD_FOOTER), 'footer line missing/reworded');
      assert.ok(src.includes(CARD_CONDITION_SUFFIX), 'condition suffix missing/reworded');
      assert.ok(src.includes(DEFAULT_CARD_CONDITION), 'safe default condition missing');
    });
  }
});

describe('collectibles builders (GR6: own wording, never the card constants)', () => {
  for (const file of COLLECTIBLE_BUILDERS) {
    it(`${file} keeps its own condition/postage model`, () => {
      const src = read(file);
      assert.ok(!src.includes(CARD_POSTAGE), 'card penny-sleeve postage leaked into a boxed-goods builder');
      assert.ok(!src.includes(CARD_CONDITION_SUFFIX), 'card condition suffix leaked into a boxed-goods builder');
      assert.ok(src.includes(CARD_FOOTER), 'the footer IS shared suite-wide');
      assert.ok(/function (condText|postageText)/.test(src), 'own condText()/postageText() expected');
    });
  }
});
