// test/unit/ebay-notify-settings.test.mjs — the settings gate on the one listener that is reachable
// from the internet.
//
// Every rule here is protecting the same premise: this listener is safe BECAUSE it is bound to
// loopback and serves two paths, so a Cloudflare tunnel pointed at it cannot reach anything else the
// suite exposes. Each of these is a single typo in a JSON file, saved from a web form, and several of
// them would fail in ways nobody would notice — a LAN bind looks perfectly healthy, and a mismatched
// public endpoint fails eBay's validation with no diagnostic on either side.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS } from '../../lib/status.mjs';
import { KNOWN_TOPICS } from '../../lib/ebay-notify.mjs';

const validate = SETTINGS['ebay-notify'].validate;
const BASE = {
  enabled: false, alerts: true,
  listen_host: '127.0.0.1', listen_port: 5274,
  path: '/ebay/notifications', account_deletion_path: '/ebay/account-deletion',
  public_endpoint: '', destination_name: 'tcg-tools-prod',
  alert_email: 'seller@example.com',
  topics: ['ORDER_CONFIRMATION'], retain_days: 30,
};
const LIVE = { ...BASE, enabled: true, public_endpoint: 'https://hooks.example/ebay/notifications' };
const reject = (cfg, re, why) => {
  const r = validate(cfg);
  assert.ok(r, why + ' — expected a rejection, got null');
  assert.match(r, re, why);
};

describe('ebay-notify settings — the registry entry exists at all', () => {
  it('is registered and editable', () => {
    assert.ok(SETTINGS['ebay-notify'], 'without a registry entry the config cannot be saved from the UI');
    assert.equal(SETTINGS['ebay-notify'].file, 'ebay-notify.config.json');
    assert.equal(SETTINGS['ebay-notify'].editable, true);
    assert.equal(typeof SETTINGS['ebay-notify'].apply, 'function');
  });
  it('accepts the shipped defaults, disabled and enabled', () => {
    assert.equal(validate(BASE), null);
    assert.equal(validate(LIVE), null);
  });
  it('rejects a non-object', () => {
    for (const junk of [null, undefined, 'x', 42, []]) assert.ok(validate(junk));
  });
});

describe('isolation — the listener must stay on loopback, on its own port', () => {
  it('refuses a LAN bind', () => {
    // The dangerous one: 0.0.0.0 binds fine, reports healthy, and quietly puts an unauthenticated
    // POST endpoint on the network.
    reject({ ...BASE, listen_host: '0.0.0.0' }, /never bind this to the LAN/, 'LAN bind');
    reject({ ...BASE, listen_host: '192.168.4.200' }, /never bind this to the LAN/, 'explicit LAN ip');
    reject({ ...BASE, listen_host: '' }, /never bind this to the LAN/, 'empty host');
  });
  it('allows both loopback spellings', () => {
    assert.equal(validate({ ...BASE, listen_host: '127.0.0.1' }), null);
    assert.equal(validate({ ...BASE, listen_host: '::1' }), null);
  });
  it('refuses the Vite port — that would hand the tunnel the whole dev server', () => {
    reject({ ...BASE, listen_port: 5273 }, /NOT be the Vite port/, 'vite port');
  });
  it('refuses a port outside the unprivileged range', () => {
    for (const p of [80, 443, 1023, 70000, 5274.5, '5274']) {
      reject({ ...BASE, listen_port: p }, /integer 1024–65535/, 'port ' + p);
    }
  });
});

describe('paths — the tunnel maps these literally', () => {
  it('refuses anything under /api', () => {
    reject({ ...BASE, path: '/api/hook' }, /must not start with \/api/, 'api path');
    reject({ ...BASE, account_deletion_path: '/api' }, /must not start with \/api/, 'bare /api');
  });
  it('refuses traversal and relative paths', () => {
    reject({ ...BASE, path: '/ebay/../api/status' }, /no "\.\."/, 'traversal');
    reject({ ...BASE, path: 'ebay/notifications' }, /absolute path/, 'relative');
  });
  it('refuses the two paths being the same', () => {
    reject({ ...BASE, account_deletion_path: '/ebay/notifications' }, /must differ/, 'collision');
  });
});

describe('public_endpoint — hashed verbatim into the challenge', () => {
  it('is only demanded once enabled, so the config can be filled in over two saves', () => {
    assert.equal(validate({ ...BASE, public_endpoint: '' }), null);
    reject({ ...BASE, enabled: true, public_endpoint: '' }, /full https URL/, 'enabled with no endpoint');
  });
  it('must be https', () => {
    reject({ ...LIVE, public_endpoint: 'http://hooks.example/ebay/notifications' }, /must be https/, 'http');
  });
  it('must not carry a trailing slash', () => {
    // A slash changes the hash, so eBay computes a different answer and simply refuses the endpoint.
    reject({ ...LIVE, public_endpoint: 'https://hooks.example/ebay/notifications/' }, /trailing slash/, 'slash');
  });
  it('its path must match the path we actually serve', () => {
    reject({ ...LIVE, public_endpoint: 'https://hooks.example/wrong' }, /must equal path/, 'mismatch');
    reject({ ...LIVE, public_endpoint: 'https://hooks.example' }, /must equal path/, 'no path at all');
  });
});

describe('topics — the allowlist is derived, so it cannot go stale', () => {
  it('accepts every topic the module knows how to handle', () => {
    assert.equal(validate({ ...BASE, topics: [...KNOWN_TOPICS] }), null);
  });
  it('names the valid set when rejecting an unknown one', () => {
    const r = validate({ ...BASE, topics: ['ORDER_CONFIRMATION', 'NOT_A_TOPIC'] });
    assert.match(r, /unknown topic 'NOT_A_TOPIC'/);
    assert.match(r, /ORDER_CONFIRMATION/, 'the message should list what IS valid');
  });
  it('refuses an empty or non-array topics list', () => {
    reject({ ...BASE, topics: [] }, /non-empty array/, 'empty');
    reject({ ...BASE, topics: 'ORDER_CONFIRMATION' }, /non-empty array/, 'string');
  });
});

describe('the remaining scalars', () => {
  it('booleans must be booleans, not truthy strings', () => {
    for (const k of ['enabled', 'alerts']) {
      reject({ ...BASE, [k]: 'true' }, new RegExp(k + ' must be boolean'), k);
    }
  });
  it('retain_days is bounded', () => {
    for (const d of [0, -1, 366, 1.5]) reject({ ...BASE, retain_days: d }, /1–365/, 'retain ' + d);
    assert.equal(validate({ ...BASE, retain_days: 1 }), null);
    assert.equal(validate({ ...BASE, retain_days: 365 }), null);
  });
  it('destination_name must be a sane non-empty string', () => {
    reject({ ...BASE, destination_name: '' }, /non-empty string/, 'empty');
    reject({ ...BASE, destination_name: 'x'.repeat(101) }, /≤100 chars/, 'too long');
  });
});

// eBay refuses its subscription endpoints entirely until an app-level config exists, and reports it
// as 195003 from getSubscriptions — which reads like a subscription fault rather than a missing
// prerequisite. A live dry run hit exactly that, so the gate moved here where it is obvious.
describe('alert_email — a prerequisite, not a nicety', () => {
  it('is demanded once enabled', () => {
    reject({ ...LIVE, alert_email: '' }, /195003/, 'empty while enabled');
    reject({ ...LIVE, alert_email: 'not-an-address' }, /valid address/, 'malformed');
    reject({ ...LIVE, alert_email: 'missing@tld' }, /valid address/, 'no TLD');
  });
  it('is not demanded while disabled, so the config can be filled in over two saves', () => {
    assert.equal(validate({ ...BASE, enabled: false, alert_email: '' }), null);
  });
  it('accepts an ordinary address', () => {
    assert.equal(validate({ ...LIVE, alert_email: 'seller+ebay@example.co.uk' }), null);
  });
  it('rejects a non-string outright', () => {
    reject({ ...BASE, alert_email: 42 }, /must be a string/, 'number');
  });
});
