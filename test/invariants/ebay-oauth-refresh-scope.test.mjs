// test/invariants/ebay-oauth-refresh-scope.test.mjs — refreshing the user token must ask for the
// scopes the seller GRANTED, never for CONSENT_SCOPES.
//
// The failure this guards is the worst kind: silent, delayed, and triggered by a one-line edit that
// looks completely safe.
//
// OAuth (RFC 6749 §6) requires a refresh request's scope to be a SUBSET of the original grant. The
// refresh used to send CONSENT_SCOPES, so the moment anyone added a capability to that constant —
// which the file's own comment invites, "requested up front so adding a capability later doesn't
// force a re-consent" — every refresh started coming back `invalid_scope`. The user token is what the
// repricer, listings publish/revise, order polling and member messages all run on, so that is not a
// degraded feature, it is the whole store offline. And it does not fail at deploy: the in-memory
// access token is good for ~2h, so it fails later, on a timer, with nothing in the diff to point at.
//
// CONSENT_SCOPES is now allowed exactly three jobs: define the ask, build the consent URL, and record
// what was asked for. It must not reach the refresh call.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';

const src = read('lib/ebay-oauth.mjs');

function bodyOf(signature, endMarker) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `expected ${signature} in lib/ebay-oauth.mjs`);
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected ${endMarker} to follow ${signature}`);
  return src.slice(start, end);
}

describe('refreshAccessToken — asks for the granted scopes, not the wished-for ones', () => {
  it('does not mention CONSENT_SCOPES at all', () => {
    const body = bodyOf('async function refreshAccessToken(', '\n// In-memory access-token cache');
    assert.doesNotMatch(body, /CONSENT_SCOPES/,
      'the refresh must not send CONSENT_SCOPES — a superset of the grant returns invalid_scope and '
      + 'kills the user token for the whole app');
  });

  it('takes the granted scopes as a parameter', () => {
    assert.match(src, /async function refreshAccessToken\(\s*env\s*,\s*refreshToken\s*,\s*grantedScopes/,
      'the granted set must be passed in, so the caller decides and this function cannot guess');
  });

  it('omits scope entirely rather than guessing when the grant is unknown', () => {
    const body = bodyOf('async function refreshAccessToken(', '\n// In-memory access-token cache');
    assert.match(body, /if\s*\(\s*grantedScopes\s*\)\s*body\.set\(\s*'scope'/,
      'with no recorded grant (a pasted EBAY_REFRESH_TOKEN) the request must leave scope off — the '
      + 'spec then returns the original grant, which is the only safe answer');
  });
});

describe('getUserAccessToken — sources the grant from the store that holds the token', () => {
  it('reads scopes off the token store', () => {
    const body = bodyOf('export async function getUserAccessToken(', '\n// Which of the scopes');
    assert.match(body, /store\.scopes/,
      'the granted set comes from the store written at consent time');
    assert.match(body, /refreshAccessToken\(\s*env\s*,\s*rt\s*,/,
      'and is threaded into the refresh call');
  });

  it('only trusts stored scopes for the stored token', () => {
    const body = bodyOf('export async function getUserAccessToken(', '\n// Which of the scopes');
    assert.match(body, /fromStore\s*&&/,
      'a pasted EBAY_REFRESH_TOKEN must not be refreshed using scopes recorded for a different token');
  });
});

describe('CONSENT_SCOPES keeps its remaining jobs', () => {
  it('still drives the consent URL', () => {
    const body = bodyOf('export function buildConsentUrl(', '\n// --- code -> tokens ---');
    assert.match(body, /CONSENT_SCOPES/, 'the consent URL is what the constant is for');
  });

  it('still records what was asked for, so drift is detectable later', () => {
    const body = bodyOf('export function saveConsent(', '\nasync function refreshAccessToken(');
    assert.match(body, /scopes:\s*CONSENT_SCOPES\.join/,
      'saveConsent must record the ask — missingScopes() diffs against it');
  });
});
