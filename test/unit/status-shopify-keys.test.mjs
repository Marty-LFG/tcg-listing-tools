// test/unit/status-shopify-keys.test.mjs — the Shopify row on /api/status (lib/status.mjs keyPresence).
//
// This row exists to answer one question remotely: are the Shopify credentials actually live on the
// box that is running? Until it existed, "the keys are set" and "the keys reached the server" could
// not be told apart from outside, and the only way to check was to ask someone to open the .env.
//
// So the two properties that matter are: it reports PRESENCE and never a value (GR2), and `ready`
// really is the AND of the three things the client-credentials grant needs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyPresence } from '../../lib/status.mjs';
import { API_VERSION } from '../../lib/channels/shopify-admin.mjs';

// DELIBERATELY NOT CREDENTIAL-SHAPED, and the first draft of this file got it wrong twice over.
// A literal in Shopify's real app-shared-secret format (its `shpss…` prefix followed by 32 hex chars)
// got the WHOLE push rejected by GitHub push protection — correctly, since a scanner cannot tell a
// fixture from the real thing. A 32-hex value assigned to SHOPIFY_CLIENT_ID then tripped no-secrets
// (GR2), which flags a long opaque literal next to anything named *_ID or *_SECRET. Both checks were
// right. The test never needed realism — only a distinctive string it can search the payload for.
//
// Keep these SHORT as well as unrealistic: no-secrets matches 25+ opaque characters after an *_ID or
// *_SECRET assignment, so a plausible-looking `fake-client-id-do-not-use` would trip it again.
const FAKE_ID = 'fake-client-id';
const FAKE_SECRET = 'fake-client-secret';
const full = {
  SHOPIFY_CLIENT_ID: FAKE_ID,
  SHOPIFY_CLIENT_SECRET: FAKE_SECRET,
  SHOPIFY_SHOP: 'binderskeepers',
  SHOPIFY_DEV_SHOP: 'binders-keepers-dev',
};
const sh = (env) => keyPresence(env).shopify;

describe('the Shopify key row reports presence, never a value (GR2)', () => {
  it('reduces both credentials to booleans', () => {
    const s = sh(full);
    assert.equal(s.SHOPIFY_CLIENT_ID, true);
    assert.equal(s.SHOPIFY_CLIENT_SECRET, true);
    assert.equal(sh({}).SHOPIFY_CLIENT_ID, false);
    assert.equal(sh({}).SHOPIFY_CLIENT_SECRET, false);
  });

  it('never echoes the secret anywhere in the whole payload', () => {
    // The row is one part of a much larger object, and a leak would most likely arrive by someone
    // adding a sibling field later. Serialise the lot and look for the value itself.
    const whole = JSON.stringify(keyPresence(full));
    assert.ok(!whole.includes(FAKE_SECRET), 'the client secret reached the status payload');
    assert.ok(!whole.includes(FAKE_ID), 'the client id reached the status payload');
  });

  it('does echo the store subdomains, which are not secrets', () => {
    // They are in the storefront URL. And "connected" is meaningless without knowing WHICH store
    // answered — the same reasoning that already puts the eBay marketplace and the printer IP here.
    const s = sh(full);
    assert.equal(s.SHOPIFY_SHOP, 'binderskeepers');
    assert.equal(s.SHOPIFY_DEV_SHOP, 'binders-keepers-dev');
  });

  it('reports an unset shop as null rather than an empty string', () => {
    const s = sh({ SHOPIFY_SHOP: '   ' });
    assert.equal(s.SHOPIFY_SHOP, null, 'whitespace is not a configured store');
    assert.equal(s.SHOPIFY_DEV_SHOP, null);
  });
});

describe('`ready` is the AND the grant actually needs', () => {
  it('is true only with id + secret + at least one shop', () => {
    assert.equal(sh(full).ready, true);
  });

  it('is false when any one of the three is missing', () => {
    const drop = (k) => { const e = { ...full }; delete e[k]; return e; };
    assert.equal(sh(drop('SHOPIFY_CLIENT_ID')).ready, false);
    assert.equal(sh(drop('SHOPIFY_CLIENT_SECRET')).ready, false);
    // Both shops gone — a credential pair with nowhere to point fails before anything is sent.
    const noShops = { ...full }; delete noShops.SHOPIFY_SHOP; delete noShops.SHOPIFY_DEV_SHOP;
    assert.equal(sh(noShops).ready, false);
  });

  it('is true on the dev store alone, because dev is the default', () => {
    const devOnly = { ...full }; delete devOnly.SHOPIFY_SHOP;
    assert.equal(sh(devOnly).ready, true);
    assert.equal(sh(devOnly).default_store, 'dev');
  });

  it('is false on an empty env, without throwing', () => {
    assert.equal(sh({}).ready, false);
    assert.equal(keyPresence(undefined ?? {}).shopify.ready, false);
  });
});

describe('the API version comes from the transport, not a second copy', () => {
  it('matches the pinned version shopify-admin actually sends', () => {
    // Shopify falls forward silently when a version retires, so a dashboard showing a number the
    // transport is not using would be worse than showing nothing.
    assert.equal(sh(full).api_version, API_VERSION);
    assert.match(sh(full).api_version, /^\d{4}-\d{2}$/);
  });
});
