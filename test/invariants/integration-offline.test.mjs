// test/invariants/integration-offline.test.mjs — the test suite may not reach a real account.
//
// WHY THIS FILE EXISTS. On 2026-08-23 the integration suite listed a card on the LIVE eBay store. Not a
// draft, not a sandbox: "Pokemon Batch Guard 210/197 Obsidian Flames Double Rare Holo EN M/NM", A$28.33,
// visible to buyers, with a Charizard picture on it because only the fixture's name was overridden.
//
// The mechanism was not exotic. runner-stage.test.mjs stages that fixture and then POSTs the real
// /api/listings/batch route, asserting 409 not_connected — an assertion that holds only on a machine
// with no eBay consent. bootServer redirected the databases and blanked the Telegram and LLM keys, and
// its own comment reasoned about not making "a live, billed model call" — but eBay's credentials were
// never blanked. On the box that trades, the guard passed and the batch published for real. The
// databases being redirected made it WORSE, not better: the staged row died with the temp DB, so
// nothing local ever recorded the listing and no reconciler could find it.
//
// The defect was never the missing line. It was that the suite's safety depended on what a developer's
// machine happened to lack. These tests make that dependency explicit and enforce it, so the next
// credential added to .env cannot quietly reopen the hole.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OFFLINE_ENV } from '../helpers/boot-server.mjs';
import { ROOT } from '../helpers/extract-inline.mjs';
import { keysConfigured, decryptSecret } from '../../lib/ebay-oauth.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const INTEGRATION_DIR = path.join(ROOT, 'test', 'integration');
const integrationFiles = () => fs.readdirSync(INTEGRATION_DIR).filter((f) => f.endsWith('.test.mjs'));

describe('bootServer neutralises every credential that could reach a real account', () => {
  it('blanks the eBay keys — all three, because the stored token is the other half', () => {
    // EBAY_REFRESH_TOKEN alone is not enough. oauthStatus() is `storeConnected || envToken`, and
    // storeConnected comes from data/ebay-oauth.json, whose path is a module-level const that cannot be
    // redirected. What defeats it is the Cert ID: the stored refresh token is encrypted under a key
    // derived from it, so blanking it makes decryptSecret return null.
    for (const k of ['EBAY_APP_ID', 'EBAY_CERT_ID', 'EBAY_REFRESH_TOKEN']) {
      assert.ok(OFFLINE_ENV.includes(k), `${k} must be blanked or a consented box publishes from the suite`);
    }
  });

  it('a blanked Cert ID really does make a stored token undecryptable', () => {
    // The mechanism, not the intent: prove decryptSecret degrades to null rather than throwing or —
    // far worse — succeeding against a key derived from an empty string that happens to be stable.
    const blob = 'v1:' + Buffer.from('not-a-real-token-just-shaped-like-one').toString('base64');
    assert.equal(decryptSecret({ EBAY_CERT_ID: '' }, blob), null);
    assert.equal(keysConfigured({ EBAY_APP_ID: '', EBAY_CERT_ID: '' }), false);
  });

  it('blanks the Shopify keys, before any test needs them to be blank', () => {
    // shopifyPlugin is registered in vite.config.js, so bootServer boots it. The identical trap is one
    // route call away, and Shopify's version writes PRODUCTS to a store.
    for (const k of ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_SHOP', 'SHOPIFY_DEV_SHOP']) {
      assert.ok(OFFLINE_ENV.includes(k), `${k} must be blanked`);
    }
  });

  it('covers every credential-shaped name in .env.example', () => {
    // SELF-MAINTAINING, and that is the whole point. A hardcoded list is a list that goes stale the
    // next time someone adds a channel; deriving the requirement from .env.example means a new
    // credential fails this test the day it is added rather than the day it publishes something.
    const names = [...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    // Names that configure behaviour rather than grant access. Blanking these would change what the
    // suite tests without making it any safer.
    const notCredentials = /^(EBAY_MARKETPLACE|GRADER_PROVIDER|LABEL_PRINTER_|SCRYDEX_TEAM_ID|.*_BASE_URL$|.*_ENABLED$)/;
    const missing = names
      .filter((n) => /KEY|SECRET|TOKEN|CONSUMER|APP_ID|CERT|RUNAME|CHAT_ID|CLIENT_ID/.test(n))
      .filter((n) => !notCredentials.test(n))
      .filter((n) => !OFFLINE_ENV.includes(n));
    assert.deepEqual(missing, [], `these credentials reach a real account from an integration test: ${missing.join(', ')}`);
  });

  it('does the blanking with the exported list, not a private copy', () => {
    // A second, drifting copy inside bootServer would pass every test above and protect nothing.
    const src = read('test/helpers/boot-server.mjs');
    assert.match(src, /for \(const k of OFFLINE_ENV\) process\.env\[k\] = ''/,
      'bootServer must blank from OFFLINE_ENV, so this file and the helper cannot disagree');
  });
});

describe('no integration test may drive a channel-mutating route', () => {
  // The route prefixes that CREATE, REVISE or END something on a real account. A test may assert that
  // one REFUSES; what it must never do is depend on the refusal happening by accident.
  const MUTATING = [
    '/api/listings/batch',
    '/api/listings/publish',
    '/api/shopify/publish',
    '/api/shopify/identity/rebuild',
  ];

  it('every test that posts one is in the acknowledged list, with a reason', () => {
    // A deliberate allow-list rather than a ban: runner-stage genuinely needs to prove the guard fires,
    // and proving a refusal is the safest thing such a test can do — ONCE the refusal is guaranteed
    // rather than incidental. Adding a file here should be a decision someone makes on purpose.
    const ACKNOWLEDGED = {
      'runner-stage.test.mjs': 'asserts /api/listings/batch REFUSES with 409 not_connected; safe only because OFFLINE_ENV guarantees the disconnection',
    };
    const offenders = [];
    for (const f of integrationFiles()) {
      const src = fs.readFileSync(path.join(INTEGRATION_DIR, f), 'utf8');
      const posts = MUTATING.some((r) => new RegExp(`post\\(\\s*['"\`]${r.replace(/\//g, '\\/')}`).test(src));
      if (posts && !ACKNOWLEDGED[f]) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
      `these integration tests drive a channel-mutating route without being acknowledged: ${offenders.join(', ')}`);
  });

  it('the acknowledged test still says out loud what it is relying on', () => {
    // The comment is the handover. Someone reading runner-stage.test.mjs must not conclude, as its
    // original author reasonably did, that "this box has no eBay consent" is a property of the world.
    const src = read('test/integration/runner-stage.test.mjs');
    assert.match(src, /OFFLINE_ENV/,
      'runner-stage must name the guarantee it depends on, or the next reader will assume it is incidental again');
  });
});
