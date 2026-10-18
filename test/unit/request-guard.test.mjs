// test/unit/request-guard.test.mjs — the pure decisions behind lib/request-guard.mjs, without a server.
// The live behaviour (a real Vite boot) is test/invariants/request-guard.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  normHost, hostnameOf, configuredHosts, machineAddresses, isHostAllowed,
  sameOrigin, crossSiteWriteReason, requestGuard,
} from '../../lib/request-guard.mjs';

describe('hostnameOf', () => {
  it('takes the name off a Host header, port or not', () => {
    assert.equal(hostnameOf('192.168.4.200:5273'), '192.168.4.200');
    assert.equal(hostnameOf('ALCSERVER'), 'alcserver');
    assert.equal(hostnameOf('[::1]:5273'), '::1');
    assert.equal(hostnameOf('alcserver.:5273'), 'alcserver', 'a trailing-dot FQDN is the same name');
  });

  it('refuses what a browser could not have sent', () => {
    for (const h of [undefined, '', '::1', 'a:b:c', 'x:port', '[::1', '[nope]:1', 'x:123456']) {
      assert.equal(hostnameOf(h), null, JSON.stringify(h));
    }
  });
});

describe('configuredHosts', () => {
  it('is this machine\'s name plus the .env list, normalised', () => {
    const got = configuredHosts({ TCG_ALLOWED_HOSTS: 'AlcServer.Tail1.ts.net:5273, .home.arpa  100.64.0.9' });
    assert.equal(got[0], normHost(os.hostname()));
    assert.ok(got.includes('alcserver.tail1.ts.net'), 'a pasted port is dropped');
    assert.ok(got.includes('.home.arpa'), 'a leading-dot suffix stays a suffix');
    assert.ok(got.includes('100.64.0.9'));
  });

  it('never lets a wildcard switch the guard off', () => {
    assert.deepEqual(configuredHosts({ TCG_ALLOWED_HOSTS: '*, ., ' }), [normHost(os.hostname())]);
  });
});

describe('isHostAllowed', () => {
  const ctx = { names: ['alcserver', '.tail1.ts.net', '100.64.0.9'], addresses: new Set(['192.168.4.200', 'fd00::1']) };

  it('allows loopback, this machine\'s addresses and the configured names', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', 'app.localhost', '192.168.4.200', 'fd00::1',
      'alcserver', 'tail1.ts.net', 'alcserver.tail1.ts.net', '100.64.0.9']) {
      assert.equal(isHostAllowed(h, ctx), true, h);
    }
  });

  it('refuses everything else, including look-alikes', () => {
    for (const h of [null, 'evil.example', 'localhost.evil.example', 'alcserver.evil.example',
      'eviltail1.ts.net', '192.168.4.201', '10.0.0.1', '127.0.0.1.evil.example']) {
      assert.equal(isHostAllowed(h, ctx), false, String(h));
    }
  });
});

describe('machineAddresses', () => {
  it('flattens and normalises every interface address', () => {
    const set = machineAddresses({
      lo: [{ address: '127.0.0.1' }, { address: '::1' }],
      eth: [{ address: '192.168.4.200' }, { address: 'FE80::1%12' }],
      empty: null,
    });
    assert.deepEqual([...set].sort(), ['127.0.0.1', '192.168.4.200', '::1', 'fe80::1'].sort());
  });
});

describe('sameOrigin', () => {
  it('matches only the exact scheme-less host:port the request was sent to', () => {
    assert.equal(sameOrigin('http://192.168.4.200:5273', '192.168.4.200:5273'), true);
    assert.equal(sameOrigin('http://LOCALHOST:5273', 'localhost:5273'), true);
    assert.equal(sameOrigin('http://192.168.4.200:8080', '192.168.4.200:5273'), false, 'another port is another origin');
    assert.equal(sameOrigin('http://localhost:5273', '127.0.0.1:5273'), false, 'another name is another origin');
    assert.equal(sameOrigin('null', '127.0.0.1:5273'), false);
    assert.equal(sameOrigin('file:///C:/x.html', '127.0.0.1:5273'), false);
  });
});

describe('crossSiteWriteReason', () => {
  const req = (method, headers) => ({ method, headers: { host: '192.168.4.200:5273', ...headers } });

  it('lets reads through whatever their Origin', () => {
    assert.equal(crossSiteWriteReason(req('GET', { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })), null);
    assert.equal(crossSiteWriteReason(req('HEAD', { origin: 'http://evil.example' })), null);
  });

  it('lets a write from our own page, or from no browser at all, through', () => {
    assert.equal(crossSiteWriteReason(req('POST', { origin: 'http://192.168.4.200:5273', 'sec-fetch-site': 'same-origin' })), null);
    assert.equal(crossSiteWriteReason(req('POST', {})), null, 'curl / node fetch send no Origin');
    assert.equal(crossSiteWriteReason(req('DELETE', { 'sec-fetch-site': 'none' })), null);
  });

  it('refuses every cross-site write shape', () => {
    for (const [m, h] of [
      ['POST', { origin: 'http://evil.example' }],
      ['POST', { origin: 'null' }],
      ['POST', { 'sec-fetch-site': 'cross-site' }],
      ['PUT', { origin: 'http://192.168.4.200:8080', 'sec-fetch-site': 'same-site' }],
      ['OPTIONS', { origin: 'http://evil.example' }],
      ['patch', { origin: 'http://evil.example' }],
    ]) {
      assert.ok(crossSiteWriteReason(req(m, h)), `${m} ${JSON.stringify(h)}`);
    }
  });
});

describe('requestGuard', () => {
  function run(plugin, reqIn) {
    let mw;
    plugin.configureServer({ middlewares: { use: (fn) => { mw = fn; } } });
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    let nexted = false;
    mw({ url: '/api/x', method: 'GET', ...reqIn, headers: { ...reqIn.headers } }, res, () => { nexted = true; });
    return { res, nexted };
  }

  it('is a pre plugin that installs one middleware directly', () => {
    const p = requestGuard({});
    assert.equal(p.name, 'request-guard');
    assert.equal(p.enforce, 'pre');
    const calls = [];
    const ret = p.configureServer({ middlewares: { use: (fn) => calls.push(fn) } });
    assert.equal(calls.length, 1);
    assert.equal(ret, undefined, 'a returned hook would run AFTER Vite\'s internals, which is the bug');
  });

  it('passes an allowed request on and refuses the rest with a 403 that says why', () => {
    const p = requestGuard({ TCG_ALLOWED_HOSTS: 'alc.example' });
    assert.equal(run(p, { headers: { host: 'localhost:5273' } }).nexted, true);
    assert.equal(run(p, { headers: { host: 'alc.example' } }).nexted, true);

    const bad = run(p, { headers: { host: 'evil.example' } });
    assert.equal(bad.nexted, false);
    assert.equal(bad.res.statusCode, 403);
    assert.equal(JSON.parse(bad.res.body).code, 'forbidden_host');
    assert.match(JSON.parse(bad.res.body).error, /TCG_ALLOWED_HOSTS/, 'the refusal names the fix');

    const xs = run(p, { method: 'POST', headers: { host: 'localhost:5273', origin: 'http://evil.example' } });
    assert.equal(xs.nexted, false);
    assert.equal(JSON.parse(xs.res.body).code, 'cross_site_write');
  });
});
