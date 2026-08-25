// test/invariants/riftbound-route-order.test.mjs — the plugin order that makes /api/riftbound/sets
// reachable at all.
//
// Three things collide on this one prefix, and the arrangement between them is invisible in every
// file that depends on it:
//
//   1. vite.config.js declares an '/api/rb' PROXY to api.scrydex.com. Vite matches proxy contexts
//      by startsWith in declaration order, so '/api/rbound/…' would be swallowed by it — which is
//      why the catalogue routes are '/api/riftbound/…' and not '/api/rb…' (lib/riftbound-prices.mjs
//      records the same trap for its own route).
//   2. lib/riftbound-prices.mjs mounts at the BARE '/api/riftbound' prefix and ALWAYS ends the
//      response. It never calls next(). So whatever is registered after it can never be reached.
//   3. lib/riftbound-cards.mjs therefore has to come FIRST in the plugins array.
//
// Get this wrong and nothing throws: /api/riftbound/sets simply answers
// 404 { usage: 'GET /api/riftbound/prices/:identityKey' }, the set picker comes up empty, and the
// batch runner reports "source down" for a catalogue that is sitting on disk. This file asserts the
// order AND proves the reason for it, so a future reader does not have to take the order on faith.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('the /api/riftbound plugin order', () => {
  const vite = read('vite.config.js');

  it('registers both plugins inside withRegistry, so /api/status can see them', () => {
    assert.match(vite, /riftboundCardsPlugin\(\)/);
    assert.match(vite, /riftboundPricesPlugin\(\)/);
    assert.match(vite, /import \{ riftboundCardsPlugin \} from '\.\/lib\/riftbound-cards\.mjs'/);
  });

  it('puts the CARDS plugin before the PRICES plugin', () => {
    const cards = vite.indexOf('riftboundCardsPlugin()');
    const prices = vite.indexOf('riftboundPricesPlugin()');
    assert.ok(cards > 0 && prices > 0, 'both plugins must be in the array');
    assert.ok(cards < prices,
      'riftboundCardsPlugin must be registered first — riftboundPricesPlugin terminates every '
      + '/api/riftbound request and would swallow the catalogue routes');
  });

  // The half that makes the order load-bearing rather than stylistic. If the prices middleware ever
  // learns to call next(), this assertion is the thing that says the order can be relaxed.
  it('and the prices middleware genuinely never calls next()', () => {
    const prices = read('lib/riftbound-prices.mjs');
    const body = prices.slice(prices.indexOf('export function riftboundPricesPlugin'));
    assert.ok(!/\bnext\s*\(/.test(body),
      'riftboundPricesPlugin now calls next() — if that is deliberate, the ordering rule above and '
      + 'the comment in lib/riftbound-cards.mjs both need revisiting');
  });

  it('and the catalogue routes never share a prefix with the Scrydex proxy', () => {
    const cards = read('lib/riftbound-cards.mjs');
    // Every mount must be '/api/riftbound/…'. '/api/rb' + anything is the swallowed shape.
    const mounts = [...cards.matchAll(/middlewares\.use\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(mounts.length >= 3, 'expected the sets, set-cards and single-card mounts');
    for (const m of mounts) {
      assert.ok(m.startsWith('/api/riftbound/'), m + ' is not under /api/riftbound/');
    }
  });
});
