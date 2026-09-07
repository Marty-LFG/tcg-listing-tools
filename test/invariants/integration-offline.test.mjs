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
    // The Keepers routes that reach a real Shopify store. `mint` is the sharpest of them: it creates
    // a percentage discount code, which is a spendable money-equivalent object, and lib/keepers-redeem
    // .mjs takes `store` as a plain parameter with no mode gate of its own — so nothing below the
    // route stops a mint landing on binderskeepers.cards. `revoke` deactivates one. `sweep` and
    // `pass` page real orders and write customer metafields. `gate-audit` only reads, but it makes
    // the live store do work on an ungated GET.
    '/api/keepers/redemptions',
    '/api/keepers/sweep',
    '/api/keepers/pass',
    '/api/keepers/economy/refresh',
  ];

  // A deliberate allow-list rather than a ban: runner-stage genuinely needs to prove the guard fires,
  // and proving a refusal is the safest thing such a test can do — ONCE the refusal is guaranteed
  // rather than incidental. Adding a file here should be a decision someone makes on purpose.
  // Each entry names the guarantee it depends on AND the token that proves that guarantee is still in
  // the file. Two mechanisms are in play and they are not interchangeable — OFFLINE_ENV blanks the
  // credentials a route would need, while a stubbed fetchImpl means no request leaves the process at
  // all. Recording which one applies is the point: the check below used to assume OFFLINE_ENV for
  // everything, which would have quietly passed a file that had stopped relying on anything.
  const ACKNOWLEDGED = {
    'runner-stage.test.mjs': {
      why: 'asserts /api/listings/batch REFUSES with 409 not_connected; safe only because OFFLINE_ENV guarantees the disconnection',
      relies: 'OFFLINE_ENV',
    },
    'keepers-admin.test.mjs': {
      why: 'POSTs all four MUTATING Keepers prefixes (redemptions create/mint/revoke, sweep, pass, economy/refresh) and asserts each 403s; it sends no Authorization header and no ?token=, and OFFLINE_ENV blanks DIAG_TOKEN so diagOk is shut from the server side too',
      relies: 'OFFLINE_ENV',
    },
    // These two were invisible to BOTH earlier detectors — they build their routes from a shared
    // `const API = '/api/shopify'`, so neither the post()-adjacent match nor a whole-path substring
    // test ever saw them, and they had been driving two MUTATING routes unacknowledged since they
    // were written. Reviewed on discovery. They are safe for a STRONGER reason than any other entry
    // here: they do not merely lack credentials, they never make a network call at all — both mount
    // makeShopifyRouter({ db, fetchImpl }) with a stubbed fetch, their own temp database, and a `base`
    // of http://127.0.0.1:1. shopify-publish's own header explains why it avoids bootServer: that
    // would run all 30 plugins against the real tracker.db.
    'shopify-publish.test.mjs': {
      why: 'drives /api/shopify/publish and /identity/rebuild through makeShopifyRouter with a stubbed fetchImpl and its own temp DB — no real request can leave the process, which is stronger than absent credentials',
      relies: 'fetchImpl',
    },
    'shopify-batch.test.mjs': {
      why: 'same harness, including the ?store=live paths: stubbed fetchImpl, own temp DB, own config path — the store parameter selects a code path, not a destination',
      relies: 'fetchImpl',
    },
  };

  // SPLIT, because a whole-path substring test is not enough either.
  //
  // The first detector required the path to be a string literal inside post(...). keepers-admin
  // .test.mjs drives its routes through a loop, so the four /api/keepers entries added alongside it
  // matched ZERO files on the day they were written — including the file they were written for.
  //
  // The obvious repair, a substring test for the whole route, is ALSO defeated, and by the commonest
  // idiom in this very directory: shopify-publish.test.mjs and shopify-batch.test.mjs both open with
  // `const API = '/api/shopify'` and then build `API + '/publish'`. The string '/api/shopify/publish'
  // never appears in either file, so both drove a MUTATING route unflagged and unacknowledged.
  //
  // So a route is considered driven when the file mentions the whole path, OR mentions its service
  // prefix and its tail separately. That catches the shared-constant split without matching a bare
  // '/publish' in a file that has nothing to do with the service.
  const mentions = (src, route) => {
    if (src.includes(route)) return true;
    const m = /^(\/api\/[a-z-]+)(\/.+)$/.exec(route);
    return Boolean(m) && src.includes(m[1]) && src.includes(m[2]);
  };

  it('every test that drives one is in the acknowledged list, with a reason', () => {
    // It costs false positives — a file that only NAMES a route in a comment trips it — and that is
    // the right trade: clearing one is a single line here, which is the deliberate review this guard
    // exists to force.
    const offenders = [];
    for (const f of integrationFiles()) {
      const src = fs.readFileSync(path.join(INTEGRATION_DIR, f), 'utf8');
      if (MUTATING.some((r) => mentions(src, r)) && !ACKNOWLEDGED[f]) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
      `these integration tests drive a channel-mutating route without being acknowledged: ${offenders.join(', ')}`);
  });

  it('the detector is not defeated by the shared-constant idiom this directory uses', () => {
    // Pinned, because this is the exact evasion that let two files through. If a future simplification
    // reduces `mentions` back to a plain substring test, this fails.
    const split = "const API = '/api/shopify';\nawait post(API + '/publish', {});";
    assert.equal(mentions(split, '/api/shopify/publish'), true,
      'a route assembled from a shared prefix constant must still be detected');
    assert.equal(mentions("post('/api/shopify/publish', {})", '/api/shopify/publish'), true,
      'and the plain literal must still be detected');
    assert.equal(mentions("await post('/publish', {})", '/api/shopify/publish'), false,
      'but a bare tail with no service prefix must NOT trip it');
  });

  it('every acknowledged test still says out loud what it is relying on', () => {
    // The comment is the handover. Someone reading runner-stage.test.mjs must not conclude, as its
    // original author reasonably did, that "this box has no eBay consent" is a property of the world.
    // Every entry above carries the same obligation, so this iterates rather than naming one file.
    for (const f of Object.keys(ACKNOWLEDGED)) {
      const { relies } = ACKNOWLEDGED[f];
      assert.ok(read('test/integration/' + f).includes(relies),
        `${f} is acknowledged on the grounds that it relies on ${relies}, and that no longer appears in the file — `
        + 'either it stopped relying on it, or the acknowledgement was never true');
    }
  });
});
