// test/invariants/refresh-buttons.test.mjs — every ↻ actually refreshes something.
//
// Card lists are stored once and kept (lib/set-cache.mjs), so each builder carries a ↻ beside Look
// up as the way to pull a set again — for a set that gained cards after release, or one whose prices
// have moved further than the daily background refresh has caught up with.
//
// THE MISTAKE THIS CATCHES, because it was made while adding them: the button and the plumbing are
// three separate edits — the markup, the `opts` parameter on doLookup, and passing the flag into the
// lookup itself. Two of the seven pages put their lookup options on the next line, so a bulk edit
// added the button and the parameter but not the flag. The button rendered, did a completely normal
// lookup, and looked like it worked.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';

// Every page with a card lookup that reads a cached set. Riftbound/Funko/LEGO are absent on purpose:
// their data is baked into the repo, so there is nothing to refresh.
const PAGES = [
  'pokemon-listing-builder.html',
  'mtg-listing-builder.html',
  'swu-listing-builder.html',
  'lorcana-listing-builder.html',
  'onepiece-listing-builder.html',
  'stock-uploader.html',
  'card-grader.html',
];

describe('the ↻ beside Look up', () => {
  for (const page of PAGES) {
    it(page + ' has the button, and it is wired all the way through', () => {
      const src = read(page);
      assert.match(src, /onclick="doLookup\(\{refresh:true\}\)"/, 'no refresh button');
      assert.match(src, /async function doLookup\(opts\)\{/, 'doLookup does not take options');
      assert.match(src, /opts=opts\|\|\{\}/, 'a plain doLookup() would throw on opts.refresh');
      // The flag has to reach the request. Either it rides in the shared Pokémon ladder's options,
      // or the page appends it to its own URL — one of the two, never neither.
      const reaches = /refresh:!!opts\.refresh/.test(src) || /opts\.refresh\s*\?\s*['"`]\?refresh=1/.test(src);
      assert.ok(reaches, 'the button never passes the flag to the lookup — it just looks up again');
    });
  }

  it('the shared Pokémon ladder forwards it to the server AND drops its own roster copies', () => {
    const src = read('extras.js');
    assert.match(src, /var bust=opts\.refresh\?'\?refresh=1':''/, 'the server is never told');
    assert.match(src, /TCG\.pkmRoster\(setId,\{refresh:!!opts\.refresh\}\)/, 'the roster is not refreshed with it');
    // Both copies, or the refresh silently reads the one that survived.
    assert.match(src, /delete PKM_ROSTER\[setId\]/, 'the in-tab roster survives a refresh');
    assert.match(src, /removeItem\(PKM_ROSTER_KEY\+':'\+setId\)/, 'the localStorage roster survives a refresh');
  });
});
