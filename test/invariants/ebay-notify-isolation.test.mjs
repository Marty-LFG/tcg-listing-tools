// test/invariants/ebay-notify-isolation.test.mjs — the notification listener is the only part of this
// suite reachable from the internet, and it is safe for exactly two structural reasons:
//
//   1. it binds to LOOPBACK, so the tunnel is the only way in;
//   2. it is its OWN http server, not a route on the dev server, so a misconfigured tunnel reaches two
//      paths rather than /api/tracker, /api/inventory and everything else.
//
// Both are the kind of thing a refactor undoes without meaning to — dropping the host argument from
// .listen() silently binds every interface, and "why is this a separate server?" is a reasonable
// question to ask right before making it worse. The settings validate() guards the config; this guards
// the code, which validate() cannot see.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { read } from '../helpers/extract-inline.mjs';

const src = read('lib/ebay-notify.mjs');
const ROOT = path.resolve(process.cwd());

describe('the listener binds to loopback and nothing else', () => {
  it('never mentions a wildcard bind address', () => {
    assert.doesNotMatch(src, /0\.0\.0\.0/, 'a wildcard bind puts an unauthenticated POST endpoint on the LAN');
    assert.doesNotMatch(src, /host:\s*true/, 'host:true is vite-speak for the same thing');
  });

  it('always passes a host to .listen()', () => {
    // srv.listen(port) with no host binds every interface. The host argument is the whole defence.
    const listens = [...src.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1]);
    assert.ok(listens.length >= 1, 'expected the listener to call .listen()');
    for (const args of listens) {
      assert.match(args, /listen_host/, '.listen(' + args.trim() + ') must pass cfg.listen_host');
    }
  });

  it('takes the bind host from config rather than hardcoding one', () => {
    assert.match(src, /listen_host:\s*'127\.0\.0\.1'/, 'the default must be loopback');
  });
});

describe('the listener is NOT a route on the dev server', () => {
  it('only ever mounts /api/ebay-notify as middleware', () => {
    const mounts = [...src.matchAll(/middlewares\.use\(\s*'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(mounts, ['/api/ebay-notify'],
      'the notification path must never be a vite route — that is what keeps the tunnel away from /api/*');
  });

  it('creates its own http server', () => {
    assert.match(src, /http\.createServer\(/, 'the isolation depends on this being a separate server');
  });

  it('serves exactly the two configured paths and 404s the rest', () => {
    assert.match(src, /cfg\.account_deletion_path/, 'account deletion shares the listener');
    assert.match(src, /if\s*\(!which\)\s*return\s+endNoBody\(res,\s*404\)/,
      'anything that is not one of the two configured paths must be a bare 404');
  });
});

describe('the raw body reaches verification unparsed', () => {
  it('does not import the shared JSON body reader', () => {
    // lib/req-body.mjs discards the raw buffer, and the signature is over the exact bytes eBay sent.
    // Naming it in a comment is fine (and useful); importing it is the mistake.
    assert.doesNotMatch(src, /^\s*import[^\n]*req-body\.mjs/m, 'that helper drops the raw bytes the signature covers');
    assert.match(src, /function readRawBody\(/, 'the listener must read the body itself, as a Buffer');
  });
  it('verifies before it parses', () => {
    const verifyAt = src.indexOf('verifyNotification(');
    const parseAt = src.indexOf('JSON.parse(raw');
    assert.ok(verifyAt !== -1 && parseAt !== -1, 'expected both a verify and a parse');
    assert.ok(verifyAt < parseAt, 'an unverified body must never be parsed, let alone stored');
  });
  it('caps the body size', () => {
    assert.match(src, /MAX_BODY_BYTES/, 'an unbounded read on a public endpoint is a memory DoS');
  });
});

describe('the responses eBay reacts to', () => {
  it('rejects an unverified POST with 412, not a silent 204', () => {
    assert.match(src, /_state\.sig_failures\+\+[\s\S]{0,400}?endNoBody\(res,\s*412\)/,
      'a 2xx on a bad signature would tell eBay the delivery succeeded');
  });
  it('answers 503 when the store is unavailable, so eBay retries', () => {
    assert.match(src, /endNoBody\(res,\s*503\)/,
      'acking something we could not store loses it — eBay gives up after three attempts');
  });
  it('acks 204 and does the work afterwards', () => {
    assert.match(src, /endNoBody\(res,\s*204\)/, 'expected a 204 ack');
  });
});

describe('secrets stay out of the config file', () => {
  const examplePath = path.join(ROOT, 'data', 'ebay-notify.config.example.json');

  it('the tracked example exists — without it a fresh clone seeds nothing', () => {
    assert.ok(fs.existsSync(examplePath),
      'data/ebay-*.json is gitignored; the example needs its own negation or ensureConfigSeeded no-ops');
  });

  it('holds no token-shaped value', () => {
    const cfg = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    for (const [k, v] of Object.entries(cfg)) {
      assert.doesNotMatch(String(k), /token|secret|key/i, `config key ${k} looks like a secret`);
      if (typeof v === 'string') {
        assert.ok(!/^[A-Za-z0-9_-]{32,}$/.test(v), `${k} holds something token-shaped — /api/settings returns this file to the browser`);
      }
    }
  });

  it('reads both shared secrets from the environment', () => {
    assert.match(src, /EBAY_NOTIFY_VERIFICATION_TOKEN/);
    assert.match(src, /EBAY_NOTIFY_DELETION_TOKEN/);
  });

  it('the control route reports whether tokens exist, never what they are', () => {
    const idx = src.indexOf('tokens: {');
    assert.notEqual(idx, -1, 'expected the /config route to report token presence');
    const block = src.slice(idx, idx + 260);
    assert.match(block, /verificationTokenProblem\(.*?\)\s*===\s*null/,
      'token presence must be reported as a boolean predicate, never by returning the value');
    assert.doesNotMatch(block, /tokenFor\([^)]*\)\s*[,}]/,
      'a bare tokenFor(...) here would put the secret itself into the /config response');
  });
});
