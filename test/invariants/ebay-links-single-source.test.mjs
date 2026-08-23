// test/invariants/ebay-links-single-source.test.mjs — one implementation of the eBay comps URLs.
//
// THE DRIFT THIS PREVENTS (2026-08-03): the same URL was built in three places — lib/ebay-links.mjs
// for the Telegram cards, and a hand-copied ebaySearchUrl() inside stock-runner.html and
// stock-uploader.html — kept in step by a comment asking whoever changed one to change the others.
// They drifted the day one of them learned something the others did not: the runner's links gained
// the Australian-sellers filter and the other two kept opening a worldwide search, so the "Sold"
// price on a phone was a different number from the one in the grid.
//
// The rule is now structural rather than remembered: only lib/ebay-links.mjs may name these
// parameters. Pages import it (module scripts) or are handed it (the uploader's module shim).
//
// Paired with a POSITIVE check that each surface really reaches for the module — an absence-only
// test passes just as happily on a page that dropped its comps links altogether.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { read, ROOT } from '../helpers/extract-inline.mjs';

// The parameters that make an eBay search an eBay COMPS search. _nkw alone is not enough to go on:
// a page may legitimately deep-link a plain search one day.
const SEARCH_PARAMS = /LH_BIN|LH_Sold|LH_Complete|LH_PrefLoc|sch\/i\.html/;
// And the item URL. Hand-building this one is how a listing on another marketplace gets an AU host
// glued to it, which 404s — itemUrl() takes the marketplace precisely so nobody has to remember.
const ITEM_URL = /ebay\.com(\.au)?\/itm\/|['"`]\/itm\//;
const OWNER = path.join('lib', 'ebay-links.mjs');

// Every .html page in the suite, plus extras.js — anywhere a browser-side copy could take root.
function browserSurfaces() {
  return fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.html') || f === 'extras.js')
    .sort();
}

describe('only lib/ebay-links.mjs builds an eBay URL', () => {
  for (const file of browserSurfaces()) {
    it(file + ' does not build its own', () => {
      const src = read(file);
      const offenders = src.split('\n')
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => (SEARCH_PARAMS.test(l) || ITEM_URL.test(l)) && !/^\s*(\/\/|\*|<!--)/.test(l));
      assert.deepEqual(offenders.map(([n, l]) => n + ': ' + l.trim()), [],
        'import searchUrl/itemUrl from /lib/ebay-links.mjs instead of building the URL here');
    });
  }

  it('the server-side callers import it too', () => {
    const CALLERS = {
      'lib/repricer.mjs': /from '\.\/ebay-links\.mjs'/,
      'lib/postsale.mjs': /from '\.\/ebay-links\.mjs'/,
      'lib/inventory.mjs': /from '\.\/ebay-links\.mjs'/,
      'lib/channels/ebay-inventory-api.mjs': /from '\.\.\/ebay-links\.mjs'/,
    };
    for (const [f, re] of Object.entries(CALLERS)) {
      const src = read(f);
      assert.match(src, re, f + ' should import the shared builder');
      const offenders = src.split('\n').filter((l) => (SEARCH_PARAMS.test(l) || ITEM_URL.test(l)) && !/^\s*(\/\/|\*)/.test(l));
      assert.deepEqual(offenders.map((l) => l.trim()), [], f + ' builds an eBay URL of its own');
    }
  });
});

describe('the surfaces that show comps links still reach for it', () => {
  // Positive half. Each of these shows an Active/BIN + Sold pair; if one stops importing the module,
  // either the links are gone or something local is building them again.
  const IMPORTERS = {
    'stock-runner.html': /import \{[^}]*searchUrl[^}]*\} from '\/lib\/ebay-links\.mjs'/,
    'stock-uploader.html': /import \{[^}]*searchUrl[^}]*\} from '\/lib\/ebay-links\.mjs'/,
    'bulk-listing-builder.html': /import \{[^}]*searchUrl[^}]*\} from '\/lib\/ebay-links\.mjs'/,
  };
  for (const [file, re] of Object.entries(IMPORTERS)) {
    it(file, () => assert.match(read(file), re));
  }

  it('the uploader hands it to its classic script rather than converting the page', () => {
    const src = read('stock-uploader.html');
    assert.match(src, /TCG\.ebaySearchUrl\s*=/, 'module shim missing');
    assert.match(src, /TCG\.ebaySearchUrl/, 'the classic script should call through TCG');
    assert.ok(/onclick=/.test(src), 'the shim exists BECAUSE inline handlers need global scope');
  });

  // The item-URL surfaces. catalog.html is a module and imports directly; inventory.html and the
  // uploader are classic and are handed TCG.ebayItemUrl by a shim of their own.
  it('catalog.html imports itemUrl', () => {
    assert.match(read('catalog.html'), /import \{[^}]*itemUrl[^}]*\} from '\/lib\/ebay-links\.mjs'/);
  });
  for (const file of ['inventory.html', 'stock-uploader.html']) {
    it(file + ' is handed itemUrl by its shim', () => {
      const src = read(file);
      assert.match(src, /TCG\.ebayItemUrl\s*=\s*\(id\)\s*=>\s*itemUrl\(id\)/, 'shim missing');
      assert.match(src, /TCG\.ebayItemUrl\(/, 'nothing calls it — did the link get dropped?');
    });
  }

  it('lib/ebay-links.mjs stays free of node-only imports, so the browser can load it', () => {
    const src = read(OWNER);
    assert.ok(!/from 'node:/.test(src), 'a node: import would break every page that imports this');
    assert.ok(!/require\(/.test(src));
  });
});
