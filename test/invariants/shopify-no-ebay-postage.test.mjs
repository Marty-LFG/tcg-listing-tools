// test/invariants/shopify-no-ebay-postage.test.mjs — the storefront must never quote eBay's postage.
//
// lib/listing-copy.mjs builds the eBay description by pairing the protection sentence with
// postagePhrase(f.postageBand) — a dollar amount that comes off the eBay fulfilment policy pinned to
// that price band. verifyBandPolicies exists because a description contradicting its policy is an
// INAD claim on every listing in the band.
//
// Shopify's shipping is DIFFERENT and settled (tracked-only, AU-only, free over $300 — bk-shopify
// D-007), and the THEME renders it from schema settings so there is one number for Marty to edit. A
// Shopify PDP quoting an eBay band amount is a false statement to a buyer and the fastest available
// route to a chargeback.
//
// Reusing lib/listing-copy.mjs is right and expected — the condition, protection and footer sentences
// are the same product facts on either channel, and importing them is what stops a second copy
// drifting. What must NOT cross is the shipping half. This guards the code, which no runtime test can
// see once the wrong function is imported: buildDescription would simply start returning a figure.
//
// Precedent: test/invariants/shipping-band-copy.test.mjs and service-labels.test.mjs guard the same
// class of mistake on the eBay side.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, stripComments } from '../helpers/extract-inline.mjs';

// Every Shopify-channel source, discovered rather than listed, so a file added later is covered
// without anyone remembering to add it here.
//
// COMMENTS ARE STRIPPED before matching. These modules are heavily commented about precisely the
// things being forbidden — shopify-map.mjs's header explains why it must never call buildDescription
// — and a test that could not tell a call from an explanation would punish the documentation it wants.
function shopifySources() {
  const out = [];
  const scan = (dir, match) => {
    let entries;
    try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
      if (!match.test(e.name)) continue;
      const rel = dir + '/' + e.name;
      out.push({ rel, src: stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')) });
    }
  };
  scan('lib/channels', /^shopify-/);
  scan('lib', /^shopify/);
  return out;
}

describe('the Shopify channel exists and is discoverable', () => {
  it('finds at least the mapper and the transport', () => {
    const names = shopifySources().map((f) => f.rel);
    assert.ok(names.includes('lib/channels/shopify-map.mjs'), names.join(', '));
    assert.ok(names.includes('lib/channels/shopify-admin.mjs'), names.join(', '));
  });
});

describe('no Shopify module carries eBay postage copy', () => {
  for (const { rel, src } of shopifySources()) {
    // The description builder's postage half. Importing postagePhrase or postageOptions into a Shopify
    // module is the single edit that would put a band amount on the storefront.
    it(`${rel} never imports the postage phrase builders`, () => {
      assert.doesNotMatch(src, /\bpostagePhrase\b/, 'postagePhrase renders the eBay band amount');
      assert.doesNotMatch(src, /\bpostageOptions\b/, 'postageOptions renders the eBay postage table');
      assert.doesNotMatch(src, /\bDEFAULT_BANDS\b/);
      assert.doesNotMatch(src, /\bresolveRowBand\b/);
      assert.doesNotMatch(src, /\bofferBandFor\b/);
    });

    // buildDescription() pairs the protection sentence with the band amount and cannot be told not to,
    // so a Shopify module calling it is quoting eBay postage whether it meant to or not. The product
    // sentences it shares (CARD_PROTECTION, CARD_FOOTER, the condition suffixes) are imported as
    // constants instead, which is what shopify-map.mjs does.
    it(`${rel} never calls the eBay description builder`, () => {
      assert.doesNotMatch(src, /\bbuildDescription\s*\(/);
      assert.doesNotMatch(src, /\bbuildItemDescription\s*\(/);
    });

    // The config's shipping block is the band table itself.
    it(`${rel} never reads the eBay shipping config`, () => {
      assert.doesNotMatch(src, /\bcfg\.shipping\b/);
      assert.doesNotMatch(src, /\bshipping\s*:\s*cfg\b/);
    });

    // And no literal figure, however it got there. A dollar amount in a Shopify product description is
    // wrong even when it happens to be right today, because nothing keeps it in step with the theme.
    it(`${rel} contains no literal dollar amount`, () => {
      const hits = [...src.matchAll(/(?:A?\$\s?\d+(?:\.\d{2})?)/g)].map((m) => m[0]);
      assert.deepEqual(hits, [], 'a hardcoded money figure: ' + hits.join(', '));
    });
  }
});

describe('stripComments — the guard that makes this guard work', () => {
  it('removes line and block comments but keeps the code', () => {
    assert.equal(stripComments('a; // buildDescription(\nb;').trim(), 'a; \nb;');
    assert.equal(stripComments('a; /* postagePhrase */ b;').replace(/\s+/g, ' ').trim(), 'a; b;');
  });
  it('keeps a // that lives inside a string or a regex', () => {
    assert.match(stripComments(`const u = 'https://x/y';`), /https:\/\/x\/y/);
    assert.match(stripComments(`s.replace(/^https?:\\/\\//, '')`), /replace/);
    // the tail of that line must survive — the escaped slashes are not a comment
    assert.match(stripComments(`s.replace(/^https?:\\/\\//, ''); keepMe();`), /keepMe/);
  });
  it('does not let a quote inside a regex swallow the rest of the file', () => {
    // The first draft's actual bug: /"/g opened a string state that never closed, so every comment
    // after it survived and this whole invariant passed for the wrong reason.
    const src = `const esc = (s) => s.replace(/"/g, '&quot;');\n// a comment\nkeepMe();`;
    const stripped = stripComments(src);
    assert.doesNotMatch(stripped, /a comment/);
    assert.match(stripped, /keepMe/);
  });
  it('handles a slash inside a regex character class', () => {
    const stripped = stripComments(`const re = /[^/]+/g;\n// gone\nkeepMe();`);
    assert.doesNotMatch(stripped, /gone/);
    assert.match(stripped, /keepMe/);
  });
  it('does not mistake division for a regex', () => {
    const stripped = stripComments(`const half = total / 2; // gone\nkeepMe();`);
    assert.doesNotMatch(stripped, /gone/);
    assert.match(stripped, /half = total \/ 2;/);
    assert.match(stripped, /keepMe/);
  });
  it('preserves newlines inside a block comment so line numbers still line up', () => {
    assert.equal(stripComments('a;\n/* one\ntwo */\nb;').split('\n').length, 4);
  });
});

describe('the shared product wording is imported, not re-typed', () => {
  it('shopify-map.mjs takes its sentences from lib/listing-copy.mjs', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'lib/channels/shopify-map.mjs'), 'utf8'));
    assert.match(src, /from\s+'\.\.\/listing-copy\.mjs'/, 'the wording must come from the one source');
    // The set the Shopify path actually uses. CARD_CONDITION_SUFFIX, SLAB_CONDITION_SUFFIX and
    // CARD_FOOTER are deliberately NOT here: "Thanks for looking" and "item specifics" are eBay idiom,
    // and the condition suffix duplicates the parcel sentence now that condition leads the identity
    // line (A7, 2026-08-23).
    for (const k of ['CARD_PROTECTION', 'SLAB_PROTECTION', 'SHOPIFY_CATALOGUE_ART', 'SHOPIFY_PROVENANCE']) {
      assert.match(src, new RegExp('\\b' + k + '\\b'), `${k} should be imported rather than restated`);
    }
    // If a frozen sentence ever appears as a LITERAL here, the mirror the import exists to avoid is
    // back — and the Shopify pair is newly at risk, having been written for this file's benefit.
    assert.doesNotMatch(src, /Pulled straight to sleeve/);
    assert.doesNotMatch(src, /penny sleeve and toploader/);
    assert.doesNotMatch(src, /From a smoke-free home/);
    assert.doesNotMatch(src, /we photograph the actual card/);
    assert.doesNotMatch(src, /not a warehouse/);
  });

  it('the eBay idiom cannot creep back into the Shopify path', () => {
    // Belt and braces over the unit test: this scans the SOURCE, so it holds even if somebody writes a
    // new builder that never runs under the existing description tests.
    for (const { rel, src } of shopifySources()) {
      assert.doesNotMatch(src, /Thanks for looking/i, `${rel} carries eBay's sign-off`);
      assert.doesNotMatch(src, /item specifics/i, `${rel} names an eBay UI element`);
    }
  });
});
