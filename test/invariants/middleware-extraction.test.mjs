// test/invariants/middleware-extraction.test.mjs — guards that the BrickLink OAuth1 signing and the
// eBay app-token minting stay EXTRACTED in lib/ (unit-testable) and don't drift back inline into
// vite.config.js, which must remain middleware wiring only (GR1: proxies are dev-server-only).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';

describe('middleware business logic stays in lib/ (not vite.config.js)', () => {
  const vite = read('vite.config.js');
  it('no inline OAuth1 signing — moved to lib/bricklink.mjs', () => {
    assert.ok(!/oauth_signature_method/.test(vite), 'oauth_signature_method must live in lib/bricklink.mjs');
  });
  it('no inline OAuth2 token minting — moved to lib/ebay-token.mjs', () => {
    assert.ok(!/grant_type=client_credentials/.test(vite), 'token minting must live in lib/ebay-token.mjs');
  });
  it('the *Proxy middleware wiring STAYS in vite.config.js (GR1)', () => {
    for (const fn of ['bricklinkProxy', 'ebayProxy', 'graderProxy', 'printProxy']) {
      assert.ok(new RegExp('function ' + fn + '\\(').test(vite), fn + ' must remain in vite.config.js');
    }
  });
  it('vite.config.js still IMPORTS each extracted helper from its lib/ module', () => {
    assert.match(vite, /import\s*\{\s*bricklinkAuthHeader\s*\}\s*from\s*'\.\/lib\/bricklink\.mjs'/);
    assert.match(vite, /import\s*\{\s*ebayToken,\s*ebayInsightsToken\s*\}\s*from\s*'\.\/lib\/ebay-token\.mjs'/);
    assert.match(vite, /import\s*\{\s*readJsonBody\s*\}\s*from\s*'\.\/lib\/req-body\.mjs'/);
  });
  it('the proxies still CALL the extracted helpers (an absence-of-string check alone would pass on a dead import)', () => {
    assert.match(vite, /bricklinkAuthHeader\(/);
    assert.match(vite, /ebayToken\(/);
    assert.match(vite, /ebayInsightsToken\(/);
    assert.match(vite, /readJsonBody\(/);
  });
});
