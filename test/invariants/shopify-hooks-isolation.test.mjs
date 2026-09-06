// test/invariants/shopify-hooks-isolation.test.mjs — the Shopify receiver is the second part of this
// suite reachable from the internet, and it is safe for the same structural reasons as the eBay one:
//
//   1. it binds to LOOPBACK, so the tunnel is the only way in;
//   2. it is its OWN http server, not a route on the dev server, so a misconfigured tunnel reaches
//      three paths rather than /api/inventory and everything else;
//   3. it verifies BEFORE it records, so an unsigned request leaves no trace and costs nothing.
//
// Each is the kind of thing a refactor undoes without meaning to — dropping the host argument from
// .listen() silently binds every interface, and "why is this a separate server?" is a reasonable
// question to ask right before making it worse. The settings validate() guards the config; this
// guards the code, which validate() cannot see.
//
// This is the gate S7 in docs/SHOPIFY_CHANNEL_PLAN.md asks for.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../helpers/extract-inline.mjs';
import {
  DEFAULT_CONFIG, validateShopifyHooksConfig, KNOWN_TOPICS, BUSINESS_TOPICS, COMPLIANCE_TOPICS,
} from '../../lib/shopify-hooks.mjs';

const src = read('lib/shopify-hooks.mjs');

describe('the receiver binds to loopback and nothing else', () => {
  it('defaults to loopback', () => {
    assert.equal(DEFAULT_CONFIG.listen_host, '127.0.0.1');
    assert.equal(DEFAULT_CONFIG.allow_lan_bind, false, 'a LAN bind must never be the default');
  });

  it('always passes a host to .listen()', () => {
    // srv.listen(port) with no host binds every interface. The host argument is the whole defence.
    const listens = [...src.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1]);
    assert.ok(listens.length >= 1, 'expected the receiver to call .listen()');
    for (const args of listens) {
      assert.match(args, /listen_host/, `.listen(${args.trim()}) must pass cfg.listen_host`);
    }
  });

  it('refuses a wildcard bind even when a LAN bind is opted into', () => {
    const cfg = { ...DEFAULT_CONFIG, enabled: true, expect_shop_domain: 'x.myshopify.com' };
    assert.match(validateShopifyHooksConfig({ ...cfg, listen_host: '0.0.0.0', allow_lan_bind: true }), /every interface/);
  });

  it('never lets the listener share the dev server or the eBay listener port', () => {
    const cfg = { ...DEFAULT_CONFIG, enabled: true, expect_shop_domain: 'x.myshopify.com' };
    assert.ok(validateShopifyHooksConfig({ ...cfg, listen_port: 5273 }));
    assert.ok(validateShopifyHooksConfig({ ...cfg, listen_port: 5274 }));
    assert.equal(DEFAULT_CONFIG.listen_port, 5275, 'S7 reserves 5275 for this');
  });
});

describe('the receiver is NOT a route on the dev server', () => {
  it('never mounts anything as vite middleware', () => {
    // The moment this becomes a vite route, the tunnel can reach every /api/* endpoint in the app.
    const mounts = [...src.matchAll(/middlewares\.use\(/g)];
    assert.equal(mounts.length, 0,
      'the Shopify paths must never be vite routes — a separate server is what keeps the tunnel away from /api/*');
  });

  it('creates its own http server', () => {
    assert.match(src, /http\.createServer\(/, 'the receiver must own its server');
  });

  it('refuses to serve a path under /api', () => {
    const cfg = { ...DEFAULT_CONFIG, enabled: true, expect_shop_domain: 'x.myshopify.com' };
    for (const k of ['webhook_path', 'compliance_path', 'proxy_path']) {
      assert.match(validateShopifyHooksConfig({ ...cfg, [k]: '/api/anything' }), /under \/api/, k);
    }
  });
});

describe('verification comes before anything is recorded', () => {
  it('calls verifyWebhookHmac before any consumer record()', () => {
    // Order matters: recording first would let an unsigned POST fill the ledger with junk, and the
    // 503-on-failure contract would then retry that junk for 48 hours.
    const verifyAt = src.indexOf('verifyWebhookHmac(secret');
    const recordAt = src.indexOf('await c.record(event)');
    assert.ok(verifyAt > 0, 'expected an HMAC verification');
    assert.ok(recordAt > 0, 'expected a consumer record call');
    assert.ok(verifyAt < recordAt, 'the HMAC check must come first');
  });

  it('checks the shop domain, not just the signature', () => {
    // The same app on any other store signs with the same secret.
    assert.match(src, /shopDomainProblem\(/, 'a valid signature is not proof it is our shop');
  });

  it('reads the raw body itself rather than using the shared body helper', () => {
    // lib/req-body.mjs discards the raw buffer, and the signature is over the exact bytes.
    assert.match(src, /function readRawBody\(/);
    assert.doesNotMatch(src, /from '\.\/req-body\.mjs'/, 'req-body discards the bytes the signature covers');
  });

  it('caps the body it will read', () => {
    assert.match(src, /MAX_BODY_BYTES/, 'an uncapped read is a memory exhaustion vector on a public endpoint');
  });
});

describe('the two signature schemes never share code', () => {
  it('imports the webhook verifier and the proxy verifier from separate modules', () => {
    // base64-over-raw-body and hex-over-sorted-params are different constructions. A shared "verify"
    // helper that accepted either would be the mistake that leaves an endpoint open.
    assert.match(src, /from '\.\/shopify-hooks-verify\.mjs'/);
    assert.match(src, /from '\.\/keepers-proxy-verify\.mjs'/);
  });
});

describe('the topic vocabulary is coherent', () => {
  it('has no topic in both the business and compliance sets', () => {
    for (const c of COMPLIANCE_TOPICS) {
      assert.equal(BUSINESS_TOPICS.includes(c), false, `${c} must be compliance-only`);
    }
  });

  it('carries all three mandatory compliance topics', () => {
    for (const t of ['customers/data_request', 'customers/redact', 'shop/redact']) {
      assert.ok(COMPLIANCE_TOPICS.includes(t), `${t} is required of every Shopify app`);
      assert.ok(KNOWN_TOPICS.includes(t));
    }
  });
});
